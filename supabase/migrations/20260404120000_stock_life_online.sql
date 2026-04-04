-- Stock Life — 온라인 멀티플레이용 스키마
-- 적용: supabase db push / SQL Editor

-- ----- users: 플레이어 상태 (auth.users 1:1) -----
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  cash bigint not null default 1000000 check (cash >= 0),
  hp integer not null default 100 check (hp >= 0 and hp <= 100),
  stress integer not null default 0 check (stress >= 0 and stress <= 100),
  sim_age integer not null default 25,
  trade_blocked_until_ms bigint not null default 0,
  initial_capital bigint not null default 1000000,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ----- portfolios -----
create table if not exists public.portfolios (
  user_id uuid not null references public.users (id) on delete cascade,
  symbol text not null,
  shares bigint not null default 0 check (shares >= 0),
  avg_cost bigint not null default 0 check (avg_cost >= 0),
  primary key (user_id, symbol),
  constraint portfolios_symbol_allowed check (
    symbol in ('JBD', 'SYW', 'MJS', 'BSL', 'SYG', 'JWF', 'YHL', 'SWB')
  )
);

-- ----- market_state: 단일 행 SSOT -----
create table if not exists public.market_state (
  id integer primary key check (id = 1),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.market_state replica identity full;

-- RLS
alter table public.users enable row level security;
alter table public.portfolios enable row level security;
alter table public.market_state enable row level security;

drop policy if exists "users_select_own" on public.users;
create policy "users_select_own" on public.users
  for select using (auth.uid() = id);

drop policy if exists "users_insert_own" on public.users;
create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id);

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users
  for update using (auth.uid() = id);

drop policy if exists "portfolios_all_own" on public.portfolios;
create policy "portfolios_all_own" on public.portfolios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "market_state_read_all" on public.market_state;
create policy "market_state_read_all" on public.market_state
  for select using (true);

-- 쓰기는 서비스 롤(Edge Function)만 — anon/authenticated 에게는 정책 없음 = 거부

-- Realtime (이미 등록돼 있으면 마이그레이션 재실행 시 수동으로 생략)
alter publication supabase_realtime add table public.market_state;

insert into public.market_state (id, state)
values (1, jsonb_build_object('initialized', false))
on conflict (id) do nothing;

-- ----- 가격 조회 헬퍼 -----
create or replace function public._price_from_market_state(sym text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select (e->>'price')::numeric
  from public.market_state ms,
       lateral jsonb_array_elements(ms.state->'stocks') as e
  where ms.id = 1 and e->>'id' = sym
  limit 1;
$$;

-- ----- 매수 -----
create or replace function public.execute_buy(p_symbol text, p_qty bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  px numeric;
  cost bigint;
  u public.users%rowtype;
  sh bigint;
  cb bigint;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', '로그인이 필요합니다.');
  end if;
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('ok', false, 'reason', '수량은 1 이상이어야 합니다.');
  end if;

  px := public._price_from_market_state(p_symbol);
  if px is null or px <= 0 then
    return jsonb_build_object('ok', false, 'reason', '시세를 찾을 수 없습니다.');
  end if;

  select * into u from public.users where id = uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', '플레이어 정보가 없습니다.');
  end if;

  if extract(epoch from now()) * 1000 < u.trade_blocked_until_ms then
    return jsonb_build_object('ok', false, 'reason', '매매가 일시 중지되었습니다.');
  end if;

  cost := round(px * p_qty::numeric);
  if cost > u.cash then
    return jsonb_build_object('ok', false, 'reason', '현금이 부족합니다.');
  end if;

  update public.users set cash = cash - cost, updated_at = now() where id = uid;

  select shares, coalesce(avg_cost, 0) into sh, cb
  from public.portfolios where user_id = uid and symbol = p_symbol;

  if not found then
    sh := 0;
    cb := 0;
  end if;

  sh := sh + p_qty;
  cb := cb + cost;

  insert into public.portfolios (user_id, symbol, shares, avg_cost)
  values (uid, p_symbol, sh, cb)
  on conflict (user_id, symbol) do update
    set shares = excluded.shares,
        avg_cost = excluded.avg_cost;

  return jsonb_build_object('ok', true, 'cash', (select cash from public.users where id = uid));
end;
$$;

create or replace function public.execute_sell(p_symbol text, p_qty bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  px numeric;
  gain bigint;
  u public.users%rowtype;
  sh bigint;
  cb bigint;
  new_cb bigint;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', '로그인이 필요합니다.');
  end if;
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('ok', false, 'reason', '수량은 1 이상이어야 합니다.');
  end if;

  px := public._price_from_market_state(p_symbol);
  if px is null or px <= 0 then
    return jsonb_build_object('ok', false, 'reason', '시세를 찾을 수 없습니다.');
  end if;

  select * into u from public.users where id = uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', '플레이어 정보가 없습니다.');
  end if;

  if extract(epoch from now()) * 1000 < u.trade_blocked_until_ms then
    return jsonb_build_object('ok', false, 'reason', '매매가 일시 중지되었습니다.');
  end if;

  select shares, coalesce(avg_cost, 0) into sh, cb
  from public.portfolios where user_id = uid and symbol = p_symbol for update;

  if not found or sh < p_qty then
    return jsonb_build_object('ok', false, 'reason', '보유 수량보다 많이 팔 수 없습니다.');
  end if;

  gain := round(px * p_qty::numeric);
  if sh = p_qty then
    new_cb := 0;
  else
    new_cb := round(cb * ((sh - p_qty)::numeric / sh::numeric));
  end if;

  update public.users set cash = cash + gain, updated_at = now() where id = uid;

  update public.portfolios
    set shares = sh - p_qty,
        avg_cost = new_cb
  where user_id = uid and symbol = p_symbol;

  return jsonb_build_object('ok', true, 'cash', (select cash from public.users where id = uid));
end;
$$;

create or replace function public.reset_my_progress()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  update public.users
    set cash = initial_capital,
        hp = 100,
        stress = 0,
        trade_blocked_until_ms = 0,
        updated_at = now()
    where id = uid;
  delete from public.portfolios where user_id = uid;
end;
$$;

create or replace function public.apply_hospital_penalty()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  paid bigint;
  cap constant bigint := 250000;
  u public.users%rowtype;
begin
  if uid is null then
    return jsonb_build_object('ok', false);
  end if;
  select * into u from public.users where id = uid for update;
  paid := least(cap, u.cash);
  update public.users
    set cash = greatest(0, cash - paid),
        hp = 45,
        stress = 55,
        trade_blocked_until_ms = (extract(epoch from now()) * 1000)::bigint + 30000,
        updated_at = now()
    where id = uid;
  return jsonb_build_object('ok', true, 'paid', paid);
end;
$$;

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.users to authenticated;
grant all on public.portfolios to authenticated;
grant select on public.market_state to anon, authenticated;
grant execute on function public.execute_buy(text, bigint) to authenticated;
grant execute on function public.execute_sell(text, bigint) to authenticated;
grant execute on function public.reset_my_progress() to authenticated;
grant execute on function public.apply_hospital_penalty() to authenticated;
