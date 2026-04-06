-- 빈 market_state 테이블에 클라이언트가 초기 시드(INSERT/upsert)할 수 있도록 INSERT 허용
-- (기존: SELECT + UPDATE 만 있어 행이 없을 때 시드 불가)

drop policy if exists "market_state_insert_all" on public.market_state;
create policy "market_state_insert_all" on public.market_state
  for insert
  with check (true);

grant insert, update on public.market_state to anon, authenticated;
