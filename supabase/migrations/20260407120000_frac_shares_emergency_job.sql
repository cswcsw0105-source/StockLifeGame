-- 소수 주(NUMERIC), 한강 급전 알바 RPC (매매 RPC는 기존 social_trade·90% 풀매수 로직 유지)

ALTER TABLE public.portfolios
  ALTER COLUMN shares TYPE NUMERIC(24, 8)
  USING (shares::numeric);

CREATE OR REPLACE FUNCTION public.execute_buy_by_name(
  p_login_name TEXT,
  p_symbol TEXT,
  p_qty NUMERIC
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
  sh NUMERIC;
  cb BIGINT;
  cash_before BIGINT;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '이름이 올바르지 않습니다.');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '수량이 올바르지 않습니다.');
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
  IF cost < 1 OR cost > u.cash THEN
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
  p_qty NUMERIC
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
  sh NUMERIC;
  cb BIGINT;
  new_cb BIGINT;
  new_sh NUMERIC;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '이름이 올바르지 않습니다.');
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '수량이 올바르지 않습니다.');
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

  IF NOT FOUND OR sh + 0.000000001 < p_qty THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'reason', '보유 수량보다 많이 팔 수 없습니다.');
  END IF;

  gain := ROUND(px * p_qty::NUMERIC);
  new_sh := sh - p_qty;

  IF new_sh < 0.00000001 THEN
    new_cb := 0;
  ELSE
    new_cb := ROUND((cb::numeric * (new_sh::numeric / NULLIF(sh, 0)::numeric)))::BIGINT;
  END IF;

  UPDATE public.users SET cash = cash + gain, updated_at = NOW() WHERE login_name = nm;

  IF new_sh < 0.00000001 THEN
    DELETE FROM public.portfolios WHERE login_name = nm AND symbol = p_symbol;
    INSERT INTO public.social_trade_events (login_name, kind, symbol, stock_display_name)
    VALUES (nm, 'full_sell', p_symbol, public._stock_kr_name(p_symbol));
  ELSE
    UPDATE public.portfolios
      SET shares = new_sh,
          avg_cost = new_cb
      WHERE login_name = nm AND symbol = p_symbol;
  END IF;

  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'cash', (SELECT cash FROM public.users WHERE login_name = nm));
END;
$$;

CREATE OR REPLACE FUNCTION public.emergency_han_river_job(p_login_name TEXT)
RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  nm TEXT := public.normalize_player_name(p_login_name);
  bonus BIGINT := 500000;
  lock_ms BIGINT := 15 * 60 * 1000;
  new_until BIGINT;
  c BIGINT;
  tblock BIGINT;
BEGIN
  IF char_length(nm) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', '이름이 올바르지 않습니다.');
  END IF;

  new_until := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + lock_ms;

  UPDATE public.users
    SET cash = cash + bonus,
        trade_blocked_until_ms = GREATEST(COALESCE(trade_blocked_until_ms, 0), new_until),
        updated_at = NOW()
    WHERE login_name = nm;

  SELECT cash, trade_blocked_until_ms INTO c, tblock
  FROM public.users WHERE login_name = nm;

  IF c IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', '플레이어 정보가 없습니다.');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cash', c,
    'trade_blocked_until_ms', tblock,
    'bonus', bonus
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.emergency_han_river_job(TEXT) TO anon, authenticated;
