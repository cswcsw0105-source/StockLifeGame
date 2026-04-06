/**
 * 서버 권위 시장 시뮬레이션 (클라이언트 script.js와 동일 규칙)
 * 현실 1초 = 장내 1분, 10분봉 = 현실 10초
 */
export const GAME_MINUTES_PER_REAL_SEC = 1;
export const CANDLE_GAME_MINUTES = 10;
export const TICKS_PER_CANDLE = 10;
export const DIVIDEND_EVERY_CANDLES = 4;
export const MARKET_OPEN_MIN = 9 * 60;
/** 정규장 15:30까지 가격 틱 */
export const MARKET_REGULAR_CLOSE_MIN = 15 * 60 + 30;
/** 장 종료 16:30 (클라이언트 script.js 와 동일) */
export const MARKET_CLOSE_MIN = 16 * 60 + 30;
export const NEXT_TRADING_DAY_DELAY_MS = 2200;
export const MAX_CANDLES_PER_STOCK = 2000;
export const MAX_NEWS_FEED = 48;

/** 동전주 최저가 방어(원) — script.js 와 동일 */
export const MIN_STOCK_PRICE = 30;

/** 찌라시 비율 — script.js 와 동일(체이닝 페이로드는 찌라시면 스파이크 없음) */
const RUMOR_FRACTION = 0.3;
function rollIsRumor(): boolean {
  return Math.random() < RUMOR_FRACTION;
}

export const STOCK_SPECS = [
  { id: "JBD", name: "재빈디자인" },
  { id: "SYW", name: "승윤윙즈" },
  { id: "MJS", name: "민준스테이" },
  { id: "BSL", name: "범서랩" },
  { id: "SYG", name: "석영기어" },
  { id: "JWF", name: "진우펀드" },
  { id: "YHL", name: "요한룩" },
  { id: "SWB", name: "선웅비즈" },
  { id: "GDR", name: "고배당 리츠" },
  { id: "MIX", name: "시장종합 ETF" },
] as const;

export type StockRow = {
  id: string;
  name: string;
  price: number;
};

export type MarketState = {
  initialized: boolean;
  serverTick: number;
  gameDayIndex: number;
  gameMinutes: number;
  isMarketClosed: boolean;
  isPaused: boolean;
  headlineImpulse: number;
  nextCalendarEventId: number;
  scheduledEvents: Record<string, unknown>[];
  newsCountByStock: Record<string, number>;
  chainStepByStock: Record<string, number>;
  newsSpikeTicksLeft: Record<string, number>;
  newsSpikeDirection: Record<string, number>;
  dividendCandleCounter: number;
  sessionCandleCount: number;
  tickInCandle: number;
  candlePeriodStartMin: number;
  candleOhlcBuffer: Record<string, { o: number; h: number; l: number }>;
  stocks: StockRow[];
  candleHistory: Record<string, CandleRow[]>;
  sessionOpenPrice: Record<string, number>;
  prevTickPrice: Record<string, number>;
  newsFeed: { text: string; type: string; ts: number }[];
  nextOpenAtMs: number | null;
};

export type CandleRow = {
  x: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

function emptyChain(): Record<string, number> {
  const o: Record<string, number> = {};
  STOCK_SPECS.forEach((s) => {
    o[s.id] = 0;
  });
  return o;
}

function randomInitialPrice(): number {
  return Math.floor(100 + Math.random() * 101);
}

function clampStockPrice(p: number): number {
  return Math.max(MIN_STOCK_PRICE, Math.floor(Number(p)));
}

function ensureNewsSpikeFields(st: MarketState): void {
  if (!st.newsSpikeTicksLeft || typeof st.newsSpikeTicksLeft !== "object") {
    st.newsSpikeTicksLeft = emptyChain();
  }
  if (!st.newsSpikeDirection || typeof st.newsSpikeDirection !== "object") {
    st.newsSpikeDirection = {};
    STOCK_SPECS.forEach((s) => {
      st.newsSpikeDirection[s.id] = 1;
    });
  }
  STOCK_SPECS.forEach((s) => {
    const t = st.newsSpikeTicksLeft[s.id];
    st.newsSpikeTicksLeft[s.id] = typeof t === "number" && Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
    st.newsSpikeDirection[s.id] = st.newsSpikeDirection[s.id] === -1 ? -1 : 1;
  });
}

function normalizeLoadedStocks(st: MarketState): void {
  const byId = new Map(st.stocks.map((r) => [r.id, r]));
  st.stocks = STOCK_SPECS.map((spec) => {
    const row = byId.get(spec.id);
    const raw = row?.price ?? randomInitialPrice();
    return { id: spec.id, name: spec.name, price: clampStockPrice(raw) };
  });
}

function resetNewsSpikeState(st: MarketState): void {
  st.newsSpikeTicksLeft = emptyChain();
  STOCK_SPECS.forEach((s) => {
    st.newsSpikeDirection[s.id] = 1;
  });
}

function formatMinuteOfDay(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatCandleXLabel(dayIndex: number, periodStartMin: number): string {
  return `D${dayIndex + 1}·${formatMinuteOfDay(periodStartMin)}`;
}

function getCalendarParts(dayIndex: number): { month: number; day: number } {
  const d = new Date(2000, 3, 1);
  d.setDate(d.getDate() + dayIndex);
  return { month: d.getMonth() + 1, day: d.getDate() };
}

function buildInitialCalendar(): Record<string, unknown>[] {
  return [
    { id: "cal-1", dayIndex: 1, title: "미 연준 의장 연설", sentiment: "bad", targets: ["SWB"], volBump: 1.52, shock: -0.014, fired: false },
    { id: "cal-2", dayIndex: 2, title: "뷰티·코스메틱 수출 지표(호조)", sentiment: "good", targets: ["BSL"], volBump: 1.58, shock: 0.021, fired: false },
    { id: "cal-3", dayIndex: 3, title: "소비자물가(CPI) 예비치", sentiment: "bad", targets: ["SWB", "MJS"], volBump: 1.55, shock: -0.012, fired: false },
    { id: "cal-4", dayIndex: 5, title: "케어 테크 업종 대형 계약 발표", sentiment: "good", targets: ["MJS"], volBump: 1.62, shock: 0.024, fired: false },
    { id: "cal-5", dayIndex: 7, title: "지수 리밸런싱 종료", sentiment: "good", targets: ["JWF"], volBump: 1.35, shock: 0.007, fired: false },
    { id: "cal-6", dayIndex: 10, title: "지정학 리스크 고조", sentiment: "bad", targets: ["SYG", "SWB"], volBump: 1.48, shock: -0.015, fired: false },
    { id: "cal-7", dayIndex: 14, title: "실적 시즌 시작(기대)", sentiment: "good", targets: ["JBD", "SYW"], volBump: 1.45, shock: 0.011, fired: false },
    { id: "cal-8", dayIndex: 18, title: "통화정책 회의 결과", sentiment: "bad", targets: ["YHL"], volBump: 1.5, shock: -0.01, fired: false },
  ];
}

const CHAIN_SCHEDULE: Record<string, number[]> = {
  JBD: [4, 25], SYW: [6, 27], MJS: [8, 29], BSL: [10, 31], SYG: [12, 33], JWF: [14, 35], YHL: [16, 37], SWB: [18, 22],
};

const NEWS_CHAINS: Record<string, { headline: string; impacts: Record<string, number>; bias: Record<string, number>; volFactor?: number }[]> = {
  JBD: [
    { headline: "[속보] 재빈디자인, 글로벌 브랜드 리뉴얼 프로젝트 수주 확대", impacts: { JBD: 0.008 }, bias: { JBD: 0.006 }, volFactor: 1.28 },
    { headline: "[분석] 대형 클라이언트 지출 축소 — 단기 수주 공백 우려", impacts: { JBD: -0.006 }, bias: { JBD: -0.005 }, volFactor: 1.22 },
  ],
  SYW: [
    { headline: "[속보] 승윤윙즈, 자율주행 시범 구간 확대·파트너십 체결", impacts: { SYW: 0.01 }, bias: { SYW: 0.007 }, volFactor: 1.32 },
    { headline: "[분석] 안전 인증 일정 지연 — 모빌리티 사업 밸류에이션 재점검", impacts: { SYW: -0.007 }, bias: { SYW: -0.006 }, volFactor: 1.26 },
  ],
  MJS: [
    { headline: "[속보] 민준스테이, 구독형 케어 서비스 MAU 전년比 두 자릿수 성장", impacts: { MJS: 0.012 }, bias: { MJS: 0.008 }, volFactor: 1.35 },
    { headline: "[속보] 경쟁사 무료 프로모션 확대 — 단기 이탈 우려", impacts: { MJS: -0.008 }, bias: { MJS: -0.005 }, volFactor: 1.28 },
  ],
  BSL: [
    { headline: "[특징주] 범서랩, 기능성 라인 해외 채널 매출 호조", impacts: { BSL: 0.009 }, bias: { BSL: 0.006 }, volFactor: 1.24 },
    { headline: "[속보] 원료·물류비 상승 — 마진 압박 전망", impacts: { BSL: -0.007 }, bias: { BSL: -0.005 }, volFactor: 1.3 },
  ],
  SYG: [
    { headline: "[속보] 석영기어, 정밀 모듈 대형 수주 및 생산 라인 증설", impacts: { SYG: 0.011 }, bias: { SYG: 0.008 }, volFactor: 1.34 },
    { headline: "[분석] 설비 투자 사이클 둔화 — 단기 목표가 하향", impacts: { SYG: -0.009 }, bias: { SYG: -0.007 }, volFactor: 1.3 },
  ],
  JWF: [
    { headline: "[운용] 진우펀드, 펀드 순매수 유입·운용 규모 확대", impacts: { JWF: 0.005 }, bias: { JWF: 0.006 }, volFactor: 1.15 },
    { headline: "[속보] 포트폴리오 일부 환매 증가 — 단기 수익률 변동성", impacts: { JWF: -0.005 }, bias: { JWF: -0.004 }, volFactor: 1.18 },
  ],
  YHL: [
    { headline: "[패션] 요한룩, 큐레이션 컬렉션 매출 전년比 성장", impacts: { YHL: 0.009 }, bias: { YHL: 0.006 }, volFactor: 1.28 },
    { headline: "[이슈] 소비 둔화 우려 — 패션 플랫폼 업종 동반 약세", impacts: { YHL: -0.008 }, bias: { YHL: -0.005 }, volFactor: 1.32 },
  ],
  SWB: [
    { headline: "[플랫폼] 선웅비즈, B2B 솔루션 신규 계약·처리량 기록 경신", impacts: { SWB: 0.006 }, bias: { SWB: 0.005 }, volFactor: 1.18 },
    { headline: "[속보] 요금·수수료 인하 논의 — 수익성 우려", impacts: { SWB: -0.006 }, bias: { SWB: -0.004 }, volFactor: 1.22 },
  ],
};

function getStock(st: MarketState, id: string): StockRow | undefined {
  return st.stocks.find((s) => s.id === id);
}

function scheduleNewsSpikeForStock(st: MarketState, stockId: string, directionSign: number): void {
  if (!getStock(st, stockId)) return;
  const ticks = 3 + Math.floor(Math.random() * 3);
  st.newsSpikeTicksLeft[stockId] = Math.max(st.newsSpikeTicksLeft[stockId] || 0, ticks);
  st.newsSpikeDirection[stockId] = directionSign >= 0 ? 1 : -1;
}

function scheduleNewsSpikeFromImpacts(st: MarketState, impacts: Record<string, number>): void {
  Object.entries(impacts).forEach(([id, raw]) => {
    const imp = Number(raw);
    if (!imp || !Number.isFinite(imp)) return;
    scheduleNewsSpikeForStock(st, id, imp > 0 ? 1 : -1);
  });
}

function syncEtfFromMarket(st: MarketState): void {
  const etf = getStock(st, "MIX");
  if (!etf) return;
  let sum = 0;
  let n = 0;
  st.stocks.forEach((s) => {
    if (s.id === "MIX") return;
    sum += s.price;
    n += 1;
  });
  if (n > 0) etf.price = clampStockPrice(Math.floor(sum / n));
}

function oneMicroPriceStep(st: MarketState): void {
  st.stocks.forEach((s) => {
    const id = s.id;
    if (id === "MIX") return;
    const spikeLeft = st.newsSpikeTicksLeft[id] ?? 0;
    let delta = 0;
    if (spikeLeft > 0) {
      st.newsSpikeTicksLeft[id] = spikeLeft - 1;
      const up = (st.newsSpikeDirection[id] ?? 1) >= 0;
      if (up) {
        delta = 20 + Math.floor(Math.random() * 31);
      } else {
        delta = -(20 + Math.floor(Math.random() * 21));
      }
    } else if (id === "GDR") {
      delta = -1 + Math.floor(Math.random() * 3);
    } else {
      delta = -2 + Math.floor(Math.random() * 5);
    }
    s.price = clampStockPrice(s.price + delta);
  });
  syncEtfFromMarket(st);
}

function pushNews(st: MarketState, text: string, type: string): void {
  st.newsFeed.unshift({ text, type, ts: Date.now() });
  while (st.newsFeed.length > MAX_NEWS_FEED) st.newsFeed.pop();
}

function pushCandleRow(
  st: MarketState,
  stockId: string,
  candleDayIndex: number,
  periodStartMin: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): void {
  const row: CandleRow = {
    x: formatCandleXLabel(candleDayIndex, periodStartMin),
    o: Math.floor(open),
    h: Math.floor(high),
    l: Math.floor(low),
    c: Math.floor(close),
    v: Math.round(volume),
  };
  if (!st.candleHistory[stockId]) st.candleHistory[stockId] = [];
  st.candleHistory[stockId].push(row);
  while (st.candleHistory[stockId].length > MAX_CANDLES_PER_STOCK) {
    st.candleHistory[stockId].shift();
  }
}

function beginCandlePeriodIfNeeded(st: MarketState): void {
  if (st.tickInCandle !== 0) return;
  st.candlePeriodStartMin = st.gameMinutes;
  st.stocks.forEach((s) => {
    st.candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
  });
}

function applyNewsPayload(st: MarketState, ev: { impacts?: Record<string, number> }): void {
  scheduleNewsSpikeFromImpacts(st, ev.impacts || {});
}

function tryFireChainNews(st: MarketState, completedCandleCount: number): void {
  Object.keys(NEWS_CHAINS).forEach((stockId) => {
    const sched = CHAIN_SCHEDULE[stockId];
    if (!sched) return;
    const step = st.chainStepByStock[stockId];
    if (step >= sched.length || st.newsCountByStock[stockId] >= 3) return;
    if (completedCandleCount !== sched[step]) return;
    const story = NEWS_CHAINS[stockId][step];
    const asRumor = rollIsRumor();
    pushNews(st, story.headline, "chain");
    if (!asRumor) applyNewsPayload(st, story);
    st.chainStepByStock[stockId] += 1;
    st.newsCountByStock[stockId] += 1;
  });
}

function sealCurrentCandleAndReset(st: MarketState): void {
  const periodStart = st.candlePeriodStartMin;
  st.stocks.forEach((s) => {
    const b = st.candleOhlcBuffer[s.id];
    const close = s.price;
    const o = b.o;
    const h = b.h;
    const l = b.l;
    const vol = Math.max(
      1,
      Math.round(
        ((h - l) / Math.max(o, 1)) * 2_800_000 + Math.abs(close - o) * 42 + Math.random() * 9000 + 14_000,
      ),
    );
    pushCandleRow(st, s.id, st.gameDayIndex, periodStart, o, h, l, close, vol);
  });
  st.sessionCandleCount += 1;
  st.dividendCandleCounter += 1;
  const completed = Math.floor((st.gameMinutes - MARKET_OPEN_MIN) / CANDLE_GAME_MINUTES);
  tryFireChainNews(st, completed);
  st.tickInCandle = 0;
}

function fireDueCalendarEvents(st: MarketState): void {
  st.scheduledEvents.forEach((ev) => {
    const e = ev as { fired?: boolean; dayIndex?: number; title?: string; targets?: string[]; shock?: number; volBump?: number; sentiment?: string };
    if (e.fired || e.dayIndex !== st.gameDayIndex) return;
    e.fired = true;
    pushNews(st, `[경제 일정] ${e.title ?? ""}`, "calendar");
    const impacts: Record<string, number> = {};
    (e.targets || []).forEach((id: string) => {
      impacts[id] = e.shock ?? 0;
    });
    scheduleNewsSpikeFromImpacts(st, impacts);
  });
}

function ensureCalendarHorizon(st: MarketState): void {
  const maxDay = st.scheduledEvents.reduce((m, e) => Math.max(m, (e as { dayIndex?: number }).dayIndex ?? 0), st.gameDayIndex);
  if (maxDay >= st.gameDayIndex + 21) return;
  let d = maxDay + 2;
  for (let k = 0; k < 6; k += 1) {
    const tpl = [
      { title: "미 연준 의사록 공개", sentiment: "bad", targets: ["SWB", "MJS"], volBump: 1.42, shock: -0.011 },
    ][0];
    st.scheduledEvents.push({
      id: `cal-gen-${st.nextCalendarEventId++}`,
      dayIndex: d,
      title: tpl.title,
      sentiment: tpl.sentiment,
      targets: [...tpl.targets],
      volBump: tpl.volBump,
      shock: tpl.shock,
      fired: false,
    });
    d += 3 + Math.floor(Math.random() * 3);
  }
}

function snapshotSessionOpen(st: MarketState): void {
  st.stocks.forEach((s) => {
    st.sessionOpenPrice[s.id] = s.price;
    st.prevTickPrice[s.id] = s.price;
  });
}

function resetDailyNewsState(st: MarketState): void {
  st.newsCountByStock = emptyChain();
  st.chainStepByStock = emptyChain();
}

export function createInitialMarketState(): MarketState {
  const st: MarketState = {
    initialized: true,
    serverTick: 0,
    gameDayIndex: 0,
    gameMinutes: MARKET_OPEN_MIN,
    isMarketClosed: false,
    isPaused: false,
    headlineImpulse: 0,
    nextCalendarEventId: 9,
    scheduledEvents: buildInitialCalendar(),
    newsCountByStock: emptyChain(),
    chainStepByStock: emptyChain(),
    newsSpikeTicksLeft: emptyChain(),
    newsSpikeDirection: Object.fromEntries(STOCK_SPECS.map((s) => [s.id, 1])),
    dividendCandleCounter: 0,
    sessionCandleCount: 0,
    tickInCandle: 0,
    candlePeriodStartMin: MARKET_OPEN_MIN,
    candleOhlcBuffer: {},
    stocks: STOCK_SPECS.map((spec) => ({
      id: spec.id,
      name: spec.name,
      price: randomInitialPrice(),
    })),
    candleHistory: Object.fromEntries(STOCK_SPECS.map((s) => [s.id, [] as CandleRow[]])),
    sessionOpenPrice: {},
    prevTickPrice: {},
    newsFeed: [],
    nextOpenAtMs: null,
  };
  for (let i = 0; i < 96; i += 1) oneMicroPriceStep(st);
  st.stocks.forEach((s) => {
    s.price = clampStockPrice(s.price);
  });
  snapshotSessionOpen(st);
  st.stocks.forEach((s) => {
    st.candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
  });
  const { month, day } = getCalendarParts(st.gameDayIndex);
  pushNews(st, `장 개장 — ${month}월 ${day}일 09:00 (서버 동기화)`, "news");
  return st;
}

function closeMarket(st: MarketState): void {
  if (st.isMarketClosed) return;
  if (st.tickInCandle > 0) {
    sealCurrentCandleAndReset(st);
  }
  st.isMarketClosed = true;
  st.gameMinutes = MARKET_CLOSE_MIN;
  pushNews(st, "장 마감 — 오늘의 거래가 종료되었습니다.", "close");
  st.nextOpenAtMs = Date.now() + NEXT_TRADING_DAY_DELAY_MS;
}

function finishOpenNextTradingDay(st: MarketState): void {
  for (let i = 0; i < 120; i += 1) oneMicroPriceStep(st);
  snapshotSessionOpen(st);
  const { month, day } = getCalendarParts(st.gameDayIndex);
  pushNews(st, `장 개장 — ${month}월 ${day}일 09:00 (10분봉, 현실 10초마다 확정)`, "news");
  onSessionSecondTick(st);
}

function openNextTradingDay(st: MarketState): void {
  st.gameDayIndex += 1;
  st.isMarketClosed = false;
  st.gameMinutes = MARKET_OPEN_MIN;
  st.tickInCandle = 0;
  st.candlePeriodStartMin = MARKET_OPEN_MIN;
  st.candleOhlcBuffer = {};
  st.headlineImpulse *= 0.4;
  resetDailyNewsState(st);
  st.dividendCandleCounter = 0;
  resetNewsSpikeState(st);
  ensureCalendarHorizon(st);
  fireDueCalendarEvents(st);
  finishOpenNextTradingDay(st);
}

export function onSessionSecondTick(st: MarketState): void {
  if (st.isPaused || st.isMarketClosed) return;
  if (st.gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket(st);
    return;
  }
  if (st.gameMinutes >= MARKET_REGULAR_CLOSE_MIN && st.gameMinutes < MARKET_CLOSE_MIN) {
    st.gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    if (st.gameMinutes >= MARKET_CLOSE_MIN) {
      closeMarket(st);
    }
    return;
  }
  beginCandlePeriodIfNeeded(st);
  oneMicroPriceStep(st);
  st.stocks.forEach((s) => {
    const b = st.candleOhlcBuffer[s.id];
    if (b) {
      b.h = Math.max(b.h, s.price);
      b.l = Math.min(b.l, s.price);
    }
  });
  st.gameMinutes += GAME_MINUTES_PER_REAL_SEC;
  st.tickInCandle += 1;
  if (st.tickInCandle >= TICKS_PER_CANDLE) {
    sealCurrentCandleAndReset(st);
  }
  if (st.gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket(st);
  }
}

export function advanceServerSecond(raw: Record<string, unknown> | null): MarketState {
  let st: MarketState;
  if (!raw || raw.initialized === false) {
    st = createInitialMarketState();
  } else {
    st = raw as unknown as MarketState;
    if (!Array.isArray(st.stocks)) st.stocks = [];
    normalizeLoadedStocks(st);
    ensureNewsSpikeFields(st);
  }
  st.serverTick = (st.serverTick || 0) + 1;

  if (st.isMarketClosed && st.nextOpenAtMs != null && Date.now() >= st.nextOpenAtMs) {
    st.nextOpenAtMs = null;
    openNextTradingDay(st);
    return st;
  }

  if (!st.isMarketClosed) {
    onSessionSecondTick(st);
  }
  return st;
}
