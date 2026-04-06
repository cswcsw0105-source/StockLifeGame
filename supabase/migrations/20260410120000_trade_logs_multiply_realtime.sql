-- 개미지옥: 실시간 매매 피드(trade_logs) + 랭킹용 users/portfolios Realtime
-- 클라이언트 script.js TBL_TRADE_LOGS 와 스키마 일치

CREATE TABLE IF NOT EXISTS public.trade_logs (
  id BIGSERIAL PRIMARY KEY,
  login_name TEXT NOT NULL REFERENCES public.users (login_name) ON DELETE CASCADE,
  display_name TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  symbol TEXT NOT NULL,
  qty BIGINT NOT NULL CHECK (qty > 0),
  price BIGINT NOT NULL,
  profit BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.trade_logs ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE INDEX IF NOT EXISTS trade_logs_created_at_idx ON public.trade_logs (created_at DESC);

ALTER TABLE public.trade_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trade_logs_all" ON public.trade_logs;
CREATE POLICY "trade_logs_all" ON public.trade_logs FOR ALL USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT ON public.trade_logs TO anon, authenticated;

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'trade_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trade_logs;
  END IF;
END
$pub$;

-- 랭킹: users·portfolios 변경 시 Realtime으로 갱신
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;
END
$pub$;

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'portfolios'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.portfolios;
  END IF;
END
$pub$;
