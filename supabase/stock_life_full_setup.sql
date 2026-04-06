-- =============================================================================
-- Stock Life — Supabase SQL Editor에 통째로 붙여넣기용 전체 스크립트
-- 테이블: public.users, public.portfolios, public.market_state
-- 이름표 로그인(login_name PK) — 이메일 인증 없음
-- Realtime: market_state UPDATE 구독
-- =============================================================================
-- 주의 1) 새 프로젝트 또는 테스트 DB에 권장합니다.
-- 주의 2) 예전에 이름이 다른 테이블(name_players 등)만 쓰고 있었다면,
--        이 스크립트의 public.users / public.portfolios가 기존 public.users와
--        충돌할 수 있습니다. 충돌 시 아래 [선택] DROP 블록을 검토하세요.
-- =============================================================================

-- ----- [선택] 기존 Stock Life 테스트용 테이블 제거 (주석 해제 후 실행) -----
-- DROP TABLE IF EXISTS public.portfolios CASCADE;
-- DROP TABLE IF EXISTS public.name_portfolios CASCADE;
-- DROP TABLE IF EXISTS public.users CASCADE;
-- DROP TABLE IF EXISTS public.name_players CASCADE;

-- ----- 1) 테이블: users (플레이어 자산·상태) -----
CREATE TABLE IF NOT EXISTS public.users (
  login_name TEXT PRIMARY KEY CHECK (char_length(trim(login_name)) BETWEEN 1 AND 32),
  cash BIGINT NOT NULL DEFAULT 1000000 CHECK (cash >= 0),
  hp INTEGER NOT NULL DEFAULT 100 CHECK (hp >= 0 AND hp <= 100),
  stress INTEGER NOT NULL DEFAULT 0 CHECK (stress >= 0 AND stress <= 100),
  sim_age INTEGER NOT NULL DEFAULT 25,
  trade_blocked_until_ms BIGINT NOT NULL DEFAULT 0,
  initial_capital BIGINT NOT NULL DEFAULT 1000000,
  profile JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_updated_at_idx ON public.users (updated_at DESC);

-- ----- 2) 테이블: portfolios (종목별 보유·평단) -----
CREATE TABLE IF NOT EXISTS public.portfolios (
  login_name TEXT NOT NULL REFERENCES public.users (login_name) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  shares BIGINT NOT NULL DEFAULT 0 CHECK (shares >= 0),
  avg_cost BIGINT NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  PRIMARY KEY (login_name, symbol),
  CONSTRAINT portfolios_symbol_allowed CHECK (
    symbol IN ('JBD', 'SYW', 'MJS', 'BSL', 'SYG', 'JWF', 'YHL', 'SWB', 'GDR', 'MIX')
  )
);

-- ----- 3) 테이블: market_state (서버 권위 시장 스냅샷, 단일 행 id=1) -----
CREATE TABLE IF NOT EXISTS public.market_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.market_state REPLICA IDENTITY FULL;

-- ----- 4) RLS (데모: anon 이 이름만 알면 읽기/쓰기 — 프로덕션은 RPC만 노출 권장) -----
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_all" ON public.users;
CREATE POLICY "users_all" ON public.users FOR ALL USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "portfolios_all" ON public.portfolios;
CREATE POLICY "portfolios_all" ON public.portfolios FOR ALL USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "market_state_read_all" ON public.market_state;
CREATE POLICY "market_state_read_all" ON public.market_state FOR SELECT USING (TRUE);

-- 클라이언트 주도 틱: anon 이 market_state 1행을 UPDATE (updated_at 낙관적 잠금은 앱에서 처리)
DROP POLICY IF EXISTS "market_state_update_all" ON public.market_state;
CREATE POLICY "market_state_update_all" ON public.market_state FOR UPDATE USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "market_state_insert_all" ON public.market_state;
CREATE POLICY "market_state_insert_all" ON public.market_state FOR INSERT WITH CHECK (TRUE);

-- ----- 5) Realtime: market_state를 publication에 등록 -----
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'market_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.market_state;
  END IF;
END
$pub$;

-- seed (Edge Function 등이 덮어씀)
INSERT INTO public.market_state (id, state)
VALUES (1, JSONB_BUILD_OBJECT('initialized', FALSE))
ON CONFLICT (id) DO NOTHING;

-- ----- 6) 함수 -----
CREATE OR REPLACE FUNCTION public.normalize_player_name(p_raw TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT LEFT(
    TRIM(REGEXP_REPLACE(COALESCE(p_raw, ''), '[[:space:]]+', ' ', 'g')),
    32
  );
$$;

CREATE OR REPLACE FUNCTION public._price_from_market_state(sym TEXT)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (e->>'price')::NUMERIC
  FROM public.market_state ms,
       LATERAL JSONB_ARRAY_ELEMENTS(ms.state->'stocks') AS e
  WHERE ms.id = 1 AND e->>'id' = sym
  LIMIT 1;
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

  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'cash', (SELECT cash FROM public.users WHERE login_name = nm));
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_name_progress(p_login_name TEXT)
RETURNS VOID
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  nm TEXT := public.normalize_player_name(p_login_name);
BEGIN
  IF char_length(nm) < 1 THEN
    RAISE EXCEPTION 'invalid name';
  END IF;
  UPDATE public.users
    SET cash = 1000000,
        initial_capital = 1000000,
        profile = '{}'::jsonb,
        hp = 100,
        stress = 0,
        trade_blocked_until_ms = 0,
        sim_age = 25,
        updated_at = NOW()
    WHERE login_name = nm;
  DELETE FROM public.portfolios WHERE login_name = nm;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_hospital_penalty_by_name(p_login_name TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  nm TEXT := public.normalize_player_name(p_login_name);
  paid BIGINT;
  cap CONSTANT BIGINT := 250000;
  u public.users%ROWTYPE;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE);
  END IF;
  SELECT * INTO u FROM public.users WHERE login_name = nm FOR UPDATE;
  IF NOT FOUND THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE);
  END IF;
  paid := LEAST(cap, u.cash);
  UPDATE public.users
    SET cash = GREATEST(0, cash - paid),
        hp = 45,
        stress = 55,
        trade_blocked_until_ms = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + 30000,
        updated_at = NOW()
    WHERE login_name = nm;
  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'paid', paid);
END;
$$;

-- ----- 7) 권한 -----
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolios TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.market_state TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_player_name(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_buy_by_name(TEXT, TEXT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sell_by_name(TEXT, TEXT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_name_progress(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_hospital_penalty_by_name(TEXT) TO anon, authenticated;

-- =============================================================================
-- 적용 후 확인:
-- 1) Database → Replication → supabase_realtime 에 market_state 가 포함되는지
-- 2) 클라이언트에서 market_state id=1 UPDATE 구독
-- =============================================================================
