-- Stock Life: 전역 자산 초기화(100만원), 소셜 매매 알림 테이블, 매매 RPC에 풀매수/풀매도 이벤트 삽입
-- 적용 후 Supabase Dashboard → SQL 또는 supabase db push

-- (선택) 과거 실험 테이블 정리
DROP TABLE IF EXISTS public.trade_logs CASCADE;
DROP TABLE IF EXISTS public.assets CASCADE;

-- 기본 자산 100만원
ALTER TABLE public.users
  ALTER COLUMN cash SET DEFAULT 1000000;
ALTER TABLE public.users
  ALTER COLUMN initial_capital SET DEFAULT 1000000;

-- 기존 유저 전원 리셋 + 보유 삭제
DELETE FROM public.portfolios;
UPDATE public.users SET
  cash = 1000000,
  initial_capital = 1000000,
  profile = '{}'::jsonb,
  sim_age = 25,
  hp = 100,
  stress = 0,
  trade_blocked_until_ms = 0,
  updated_at = now();

-- 친구 실시간 알림용 (INSERT → Realtime)
CREATE TABLE IF NOT EXISTS public.social_trade_events (
  id BIGSERIAL PRIMARY KEY,
  login_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full_buy', 'full_sell')),
  symbol TEXT NOT NULL,
  stock_display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_trade_events_created_at_idx
  ON public.social_trade_events (created_at DESC);

ALTER TABLE public.social_trade_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "social_trade_events_select_all" ON public.social_trade_events;
CREATE POLICY "social_trade_events_select_all"
  ON public.social_trade_events FOR SELECT
  USING (true);

GRANT SELECT ON public.social_trade_events TO anon, authenticated;

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'social_trade_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.social_trade_events;
  END IF;
END
$pub$;

CREATE OR REPLACE FUNCTION public._stock_kr_name(sym TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE sym
    WHEN 'JBD' THEN '재빈디자인'
    WHEN 'SYW' THEN '승윤윙즈'
    WHEN 'MJS' THEN '민준스테이'
    WHEN 'BSL' THEN '범서랩'
    WHEN 'SYG' THEN '석영기어'
    WHEN 'JWF' THEN '진우펀드'
    WHEN 'YHL' THEN '요한룩'
    WHEN 'SWB' THEN '선웅비즈'
    ELSE sym
  END;
$$;

CREATE OR REPLACE FUNCTION public.execute_buy_by_name(
  p_login_name TEXT,
  p_symbol TEXT,
  p_qty BIGINT
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  nm TEXT := public.normalize_player_name(p_login_name);
  px NUMERIC;
  cost BIGINT;
  u public.users%ROWTYPE;
  sh BIGINT;
  cb BIGINT;
  cash_before BIGINT;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '이름이 올바르지 않습니다.');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '수량은 1 이상이어야 합니다.');
  END IF;

  px := public._price_from_market_state(p_symbol);
  IF px IS NULL OR px <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '시세를 찾을 수 없습니다.');
  END IF;

  SELECT * INTO u FROM public.users WHERE login_name = nm FOR UPDATE;
  IF NOT FOUND THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '플레이어 정보가 없습니다.');
  END IF;

  IF EXTRACT(EPOCH FROM NOW()) * 1000 < u.trade_blocked_until_ms THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '매매가 일시 중지되었습니다.');
  END IF;

  cash_before := u.cash;
  cost := ROUND(px * p_qty::NUMERIC);
  IF cost > u.cash THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '현금이 부족합니다.');
  END IF;

  UPDATE public.users SET cash = cash - cost, updated_at = NOW() WHERE login_name = nm;

  SELECT shares, COALESCE(avg_cost, 0) INTO sh, cb
  FROM public.portfolios WHERE login_name = nm AND symbol = p_symbol;

  IF NOT FOUND THEN
    sh := 0;
    cb := 0;
  END IF;

  sh := sh + p_qty;
  cb := cb + cost;

  INSERT INTO public.portfolios (login_name, symbol, shares, avg_cost)
  VALUES (nm, p_symbol, sh, cb)
  ON CONFLICT (login_name, symbol) DO UPDATE
    SET shares = EXCLUDED.shares,
        avg_cost = EXCLUDED.avg_cost;

  -- 풀매수: 이번 매수 금액이 매수 직전 가용 현금의 90% 이상
  IF cost >= (cash_before * 90) / 100 THEN
    INSERT INTO public.social_trade_events (login_name, kind, symbol, stock_display_name)
    VALUES (nm, 'full_buy', p_symbol, public._stock_kr_name(p_symbol));
  END IF;

  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'cash', (SELECT cash FROM public.users WHERE login_name = nm));
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_sell_by_name(
  p_login_name TEXT,
  p_symbol TEXT,
  p_qty BIGINT
)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  nm TEXT := public.normalize_player_name(p_login_name);
  px NUMERIC;
  gain BIGINT;
  u public.users%ROWTYPE;
  sh BIGINT;
  cb BIGINT;
  new_cb BIGINT;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '이름이 올바르지 않습니다.');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '수량은 1 이상이어야 합니다.');
  END IF;

  px := public._price_from_market_state(p_symbol);
  IF px IS NULL OR px <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '시세를 찾을 수 없습니다.');
  END IF;

  SELECT * INTO u FROM public.users WHERE login_name = nm FOR UPDATE;
  IF NOT FOUND THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '플레이어 정보가 없습니다.');
  END IF;

  IF EXTRACT(EPOCH FROM NOW()) * 1000 < u.trade_blocked_until_ms THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '매매가 일시 중지되었습니다.');
  END IF;

  SELECT shares, COALESCE(avg_cost, 0) INTO sh, cb
  FROM public.portfolios WHERE login_name = nm AND symbol = p_symbol FOR UPDATE;

  IF NOT FOUND OR sh < p_qty THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '보유 수량보다 많이 팔 수 없습니다.');
  END IF;

  gain := ROUND(px * p_qty::NUMERIC);
  IF sh = p_qty THEN
    new_cb := 0;
  ELSE
    new_cb := ROUND(cb * ((sh - p_qty)::NUMERIC / sh::NUMERIC));
  END IF;

  UPDATE public.users SET cash = cash + gain, updated_at = NOW() WHERE login_name = nm;

  UPDATE public.portfolios
    SET shares = sh - p_qty,
        avg_cost = new_cb
    WHERE login_name = nm AND symbol = p_symbol;

  IF sh = p_qty THEN
    INSERT INTO public.social_trade_events (login_name, kind, symbol, stock_display_name)
    VALUES (nm, 'full_sell', p_symbol, public._stock_kr_name(p_symbol));
  END IF;

  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'cash', (SELECT cash FROM public.users WHERE login_name = nm));
END;
$$;

-- 관리자용 재실행(토큰은 배포 전에 변경 권장)
CREATE OR REPLACE FUNCTION public.reset_world_if_token(p_token TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> 'STOCKLIFE_GLOBAL_RESET_2026_CHANGE_ME' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token');
  END IF;
  DELETE FROM public.portfolios;
  UPDATE public.users SET
    cash = 1000000,
    initial_capital = 1000000,
    profile = '{}'::jsonb,
    sim_age = 25,
    hp = 100,
    stress = 0,
    trade_blocked_until_ms = 0,
    updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_world_if_token(TEXT) TO anon, authenticated;
