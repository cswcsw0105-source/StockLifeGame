-- 초기 예수금·기준 자본 1,000,000원 (앱 INITIAL_CAPITAL 과 동기)

alter table public.users
  alter column cash set default 1000000;

alter table public.users
  alter column initial_capital set default 1000000;
