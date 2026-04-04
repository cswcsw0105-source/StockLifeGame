-- 이름표 로그인 (auth 없이 login_name 으로 식별)
-- 기존 public.users(auth FK)와 별도 — 요청상 "이름"으로 조회·가입

create table if not exists public.name_players (
  login_name text primary key check (char_length(trim(login_name)) between 1 and 32),
  cash bigint not null default 1000000 check (cash >= 0),
  hp integer not null default 100 check (hp >= 0 and hp <= 100),
  stress integer not null default 0 check (stress >= 0 and stress <= 100),
  sim_age integer not null default 25,
  trade_blocked_until_ms bigint not null default 0,
  initial_capital bigint not null default 1000000,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.name_portfolios (
  login_name text not null references public.name_players (login_name) on delete cascade,
  symbol text not null,
  shares bigint not null default 0 check (shares >= 0),
  avg_cost bigint not null default 0 check (avg_cost >= 0),
  primary key (login_name, symbol),
  constraint name_portfolios_symbol_allowed check (
    symbol in ('JBD', 'SYW', 'MJS', 'BSL', 'SYG', 'JWF', 'YHL', 'SWB')
  )
);

create index if not exists name_players_updated_at_idx on public.name_players (updated_at desc);

alter table public.name_players enable row level security;
alter table public.name_portfolios enable row level security;

-- 데모: anon 이 이름만 알면 수정 가능 — 프로덕션에서는 Edge/RPC만 노출 권장
drop policy if exists "name_players_all" on public.name_players;
create policy "name_players_all" on public.name_players for all using (true) with check (true);

drop policy if exists "name_portfolios_all" on public.name_portfolios;
create policy "name_portfolios_all" on public.name_portfolios for all using (true) with check (true);

grant select, insert, update, delete on public.name_players to anon, authenticated;
grant select, insert, update, delete on public.name_portfolios to anon, authenticated;

create or replace function public.normalize_player_name(p_raw text)
returns text
language sql
immutable
as $$
  select left(trim(regexp_replace(coalesce(p_raw, ''), '[[:space:]]+', ' ', 'g')), 32);
$$;

-- ----- 이름 기준 매매·페널티·초기화 -----

create or replace function public.execute_buy_by_name(p_login_name text, p_symbol text, p_qty bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  nm text := public.normalize_player_name(p_login_name);
  px numeric;
  cost bigint;
  u public.name_players%rowtype;
  sh bigint;
  cb bigint;
begin
  if char_length(nm) < 1 then
    return jsonb_build_object('ok', false, 'reason', '이름이 올바르지 않습니다.');
  end if;
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('ok', false, 'reason', '수량은 1 이상이어야 합니다.');
  end if;

  px := public._price_from_market_state(p_symbol);
  if px is null or px <= 0 then
    return jsonb_build_object('ok', false, 'reason', '시세를 찾을 수 없습니다.');
  end if;

  select * into u from public.name_players where login_name = nm for update;
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

  update public.name_players set cash = cash - cost, updated_at = now() where login_name = nm;

  select shares, coalesce(avg_cost, 0) into sh, cb
  from public.name_portfolios where login_name = nm and symbol = p_symbol;

  if not found then
    sh := 0;
    cb := 0;
  end if;

  sh := sh + p_qty;
  cb := cb + cost;

  insert into public.name_portfolios (login_name, symbol, shares, avg_cost)
  values (nm, p_symbol, sh, cb)
  on conflict (login_name, symbol) do update
    set shares = excluded.shares,
        avg_cost = excluded.avg_cost;

  return jsonb_build_object('ok', true, 'cash', (select cash from public.name_players where login_name = nm));
end;
$$;

create or replace function public.execute_sell_by_name(p_login_name text, p_symbol text, p_qty bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  nm text := public.normalize_player_name(p_login_name);
  px numeric;
  gain bigint;
  u public.name_players%rowtype;
  sh bigint;
  cb bigint;
  new_cb bigint;
begin
  if char_length(nm) < 1 then
    return jsonb_build_object('ok', false, 'reason', '이름이 올바르지 않습니다.');
  end if;
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('ok', false, 'reason', '수량은 1 이상이어야 합니다.');
  end if;

  px := public._price_from_market_state(p_symbol);
  if px is null or px <= 0 then
    return jsonb_build_object('ok', false, 'reason', '시세를 찾을 수 없습니다.');
  end if;

  select * into u from public.name_players where login_name = nm for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', '플레이어 정보가 없습니다.');
  end if;

  if extract(epoch from now()) * 1000 < u.trade_blocked_until_ms then
    return jsonb_build_object('ok', false, 'reason', '매매가 일시 중지되었습니다.');
  end if;

  select shares, coalesce(avg_cost, 0) into sh, cb
  from public.name_portfolios where login_name = nm and symbol = p_symbol for update;

  if not found or sh < p_qty then
    return jsonb_build_object('ok', false, 'reason', '보유 수량보다 많이 팔 수 없습니다.');
  end if;

  gain := round(px * p_qty::numeric);
  if sh = p_qty then
    new_cb := 0;
  else
    new_cb := round(cb * ((sh - p_qty)::numeric / sh::numeric));
  end if;

  update public.name_players set cash = cash + gain, updated_at = now() where login_name = nm;

  update public.name_portfolios
    set shares = sh - p_qty,
        avg_cost = new_cb
  where login_name = nm and symbol = p_symbol;

  return jsonb_build_object('ok', true, 'cash', (select cash from public.name_players where login_name = nm));
end;
$$;

create or replace function public.reset_name_progress(p_login_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  nm text := public.normalize_player_name(p_login_name);
begin
  if char_length(nm) < 1 then
    raise exception 'invalid name';
  end if;
  update public.name_players
    set cash = initial_capital,
        hp = 100,
        stress = 0,
        trade_blocked_until_ms = 0,
        updated_at = now()
    where login_name = nm;
  delete from public.name_portfolios where login_name = nm;
end;
$$;

create or replace function public.apply_hospital_penalty_by_name(p_login_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  nm text := public.normalize_player_name(p_login_name);
  paid bigint;
  cap constant bigint := 250000;
  u public.name_players%rowtype;
begin
  if char_length(nm) < 1 then
    return jsonb_build_object('ok', false);
  end if;
  select * into u from public.name_players where login_name = nm for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  paid := least(cap, u.cash);
  update public.name_players
    set cash = greatest(0, cash - paid),
        hp = 45,
        stress = 55,
        trade_blocked_until_ms = (extract(epoch from now()) * 1000)::bigint + 30000,
        updated_at = now()
    where login_name = nm;
  return jsonb_build_object('ok', true, 'paid', paid);
end;
$$;

grant execute on function public.execute_buy_by_name(text, text, bigint) to anon, authenticated;
grant execute on function public.execute_sell_by_name(text, text, bigint) to anon, authenticated;
grant execute on function public.reset_name_progress(text) to anon, authenticated;
grant execute on function public.apply_hospital_penalty_by_name(text) to anon, authenticated;
