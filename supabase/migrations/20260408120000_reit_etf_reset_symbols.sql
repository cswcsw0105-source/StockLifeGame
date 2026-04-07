-- 고배당 리츠(GDR), 시장종합 ETF(MIX) 포트폴리오 허용 + reset_name_progress가 initial_capital=1300만 등으로 남아도 100만원으로 고정

ALTER TABLE public.portfolios DROP CONSTRAINT IF EXISTS portfolios_symbol_allowed;

ALTER TABLE public.portfolios
  ADD CONSTRAINT portfolios_symbol_allowed CHECK (
    symbol IN ('JBD', 'SYW', 'MJS', 'BSL', 'SYG', 'JWF', 'YHL', 'SWB', 'GDR', 'MIX')
  );

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
    WHEN 'GDR' THEN '고배당 리츠'
    WHEN 'MIX' THEN '시장종합 ETF'
    ELSE sym
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
