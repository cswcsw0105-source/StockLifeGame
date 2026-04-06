-- 거래 수수료 0.25% (매수 총액×1.0025, 매도 총액×0.9975)
-- 클라이언트 script.js TRADE_FEE_* 와 동일하게 유지할 것

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

  cost := ROUND(px * p_qty::NUMERIC * 1.0025);
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

  gain := ROUND(px * p_qty::NUMERIC * 0.9975);
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
