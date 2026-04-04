/**
 * Stock Life — ApexCharts 캔들+거래량, 1초=장내 1분, 10분봉(현실 10초), 뉴스 체이닝
 */

const MAX_NEWS_ITEMS = 48;
const NEXT_TRADING_DAY_DELAY_MS = 2200;
const INITIAL_CAPITAL = 1_000_000;
/** v4 세이브에 initialCapital 없을 때(구 1천만 원 시작) 손익 기준 */
const LEGACY_INITIAL_CAPITAL = 10_000_000;

/** 현실 1초 = 게임 내 1분 */
const GAME_MINUTES_PER_REAL_SEC = 1;
/** 한 봉 = 게임 시간 10분 = 현실 10초 (매초 시세 변동, 10초마다 봉 확정) */
const CANDLE_GAME_MINUTES = 10;
const TICKS_PER_CANDLE = 10;
const DIVIDEND_EVERY_CANDLES = 4;

const MARKET_OPEN_MIN = 9 * 60;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
/** 09:00~15:30 = 390게임분 = 현실 390초(6분30초), 10분봉 39개 */
const SESSION_GAME_MINUTES = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;
const CANDLES_PER_SESSION = SESSION_GAME_MINUTES / CANDLE_GAME_MINUTES;

const CANDLE_UP = "#ff4b4b";
const CANDLE_DOWN = "#3182f6";

const LS_KEY = "stockLifeGameSaveV4";
const SAVE_VERSION = 4;

/** 신규 게임 시 시초가: 10,000 ~ 50,000원 균등 랜덤(정수) */
function randomInitialPrice() {
  return Math.floor(10_000 + Math.random() * 40_001);
}

const STOCK_SPECS = [
  {
    id: "JBD",
    name: "재빈디자인",
    desc: "크리에이티브 디자인 스튜디오.",
    price: 10_000,
    volatility: "high",
    chartColor: "#ff6b6b",
  },
  {
    id: "SYW",
    name: "승윤윙즈",
    desc: "모빌리티 테크 기업.",
    price: 10_000,
    volatility: "high",
    chartColor: "#f472b6",
  },
  {
    id: "MJS",
    name: "민준스테이",
    desc: "케어 서비스 플랫폼.",
    price: 10_000,
    volatility: "medium",
    chartColor: "#38bdf8",
  },
  {
    id: "BSL",
    name: "범서랩",
    desc: "기능성 뷰티 브랜드.",
    price: 10_000,
    volatility: "medium",
    chartColor: "#fb7185",
  },
  {
    id: "SYG",
    name: "석영기어",
    desc: "정밀 시스템 제조사.",
    price: 10_000,
    volatility: "high",
    chartColor: "#a78bfa",
  },
  {
    id: "JWF",
    name: "진우펀드",
    desc: "자산 운용 및 투자사.",
    price: 10_000,
    volatility: "low",
    chartColor: "#34d399",
  },
  {
    id: "YHL",
    name: "요한룩",
    desc: "패션 큐레이션 플랫폼.",
    price: 10_000,
    volatility: "medium",
    chartColor: "#fbbf24",
  },
  {
    id: "SWB",
    name: "선웅비즈",
    desc: "종합 비즈니스 솔루션 플랫폼.",
    price: 10_000,
    volatility: "low",
    chartColor: "#22d3ee",
  },
];

/** 오프라인 배당: 약 4봉(40초)마다 인게임 1회 배당과 동등한 비율로 누적 */
const OFFLINE_DIVIDEND_SECONDS_PER_TICK = 40;
const OFFLINE_DIVIDEND_MAX_MS = 7 * 24 * 60 * 60 * 1000;

let saveDebounceId = null;

const game = {
  age: 25,
  cash: INITIAL_CAPITAL,
  holdings: {},
  costBasis: {},
  /** 손익 표시 기준(세션 시작 자본) */
  initialCapital: INITIAL_CAPITAL,
};

let gameDayIndex = 0;
let headlineImpulse = 0;
let sessionCandleCount = 0;
let dividendCandleCounter = 0;

let isPaused = false;
let isMarketClosed = false;

let newsTimeoutId = null;
let gameClockIntervalId = null;
let nextTradingDayTimeoutId = null;

let gameMinutes = MARKET_OPEN_MIN;
let nextCalendarEventId = 1;
let scheduledEvents = [];

const sessionOpenPrice = {};
const prevTickPrice = {};

/** 현재 10분봉 내 초 단위 진행(0~9). 10이 되면 봉 확정 */
let tickInCandle = 0;
/** 이번 봉의 시작 장내 시각(분) */
let candlePeriodStartMin = MARKET_OPEN_MIN;
/** 봉 진행 중 OHLC(종목별) */
let candleOhlcBuffer = {};

function emptyChainState() {
  const o = {};
  STOCK_SPECS.forEach((s) => {
    o[s.id] = 0;
  });
  return o;
}

/** 종목별 오늘 뉴스(체이닝) 건수 — 최대 3 */
let newsCountByStock = emptyChainState();
/** 체이닝 다음 스텝 인덱스 */
let chainStepByStock = emptyChainState();

const stocks = STOCK_SPECS.map((spec) => ({
  ...spec,
  volatilityMod: 1,
  priceBias: 0,
}));

/** 종목별 10분봉 시퀀스 (날짜 누적, 장 마감 후에도 유지) */
const candleHistory = Object.fromEntries(
  STOCK_SPECS.map((s) => [s.id, []])
);

/** 상세 화면 캔들/거래량 차트만 사용 */
const apexDetail = { candle: null, vol: null, stockId: null };

let selectedStockId = null;

// ----- LocalStorage 저장 / 복원 -----

function collectSavePayload() {
  return {
    v: SAVE_VERSION,
    lastSavedAt: Date.now(),
    priceSnapshot: Object.fromEntries(stocks.map((s) => [s.id, s.price])),
    sessionOpenPrice: { ...sessionOpenPrice },
    game: {
      age: game.age,
      cash: game.cash,
      holdings: { ...game.holdings },
      costBasis: { ...game.costBasis },
      initialCapital: game.initialCapital,
    },
    gameDayIndex,
    gameMinutes,
    isMarketClosed,
    isPaused,
    headlineImpulse,
    nextCalendarEventId,
    scheduledEvents: JSON.parse(JSON.stringify(scheduledEvents)),
    newsCountByStock: { ...newsCountByStock },
    chainStepByStock: { ...chainStepByStock },
    dividendCandleCounter,
    sessionCandleCount,
    stocks: stocks.map((s) => ({
      id: s.id,
      price: s.price,
      volatilityMod: s.volatilityMod,
      priceBias: s.priceBias,
    })),
    candleHistory: Object.fromEntries(
      STOCK_SPECS.map((s) => [s.id, [...candleHistory[s.id]]])
    ),
    tickInCandle,
    candlePeriodStartMin,
    candleOhlcBuffer: JSON.parse(JSON.stringify(candleOhlcBuffer)),
  };
}

function saveGameState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(collectSavePayload()));
  } catch (e) {
    console.warn("saveGameState failed", e);
  }
}

function scheduleSave() {
  if (saveDebounceId) clearTimeout(saveDebounceId);
  saveDebounceId = setTimeout(() => {
    saveDebounceId = null;
    saveGameState();
  }, 350);
}

function flushSave() {
  if (saveDebounceId) {
    clearTimeout(saveDebounceId);
    saveDebounceId = null;
  }
  saveGameState();
}

/**
 * medium/low 배당: 인게임 4봉(현실 40초)마다 1회 `payDividends`와 동일 비율로 누적.
 * 오프라인 구간은 저장 시점 주가·보유수량 기준으로 tick 수만 곱함.
 */
function computeOfflineDividendAccrual(elapsedMs, priceSnapshot, holdings) {
  if (elapsedMs <= 0 || !priceSnapshot || !holdings) return 0;
  const capped = Math.min(elapsedMs, OFFLINE_DIVIDEND_MAX_MS);
  const sec = capped / 1000;
  const ticks = Math.floor(sec / OFFLINE_DIVIDEND_SECONDS_PER_TICK);
  if (ticks <= 0) return 0;

  let total = 0;
  stocks.forEach((s) => {
    if (s.volatility !== "medium" && s.volatility !== "low") return;
    const q = holdings[s.id] ?? 0;
    if (q <= 0) return;
    const p = priceSnapshot[s.id];
    if (!p || p <= 0) return;
    const rate = s.volatility === "medium" ? 0.00085 : 0.0005;
    total += q * p * rate * ticks;
  });
  return Math.round(total);
}

function applyLoadedState(data) {
  game.age = data.game.age;
  game.cash = data.game.cash;
  game.holdings = { ...data.game.holdings };
  game.costBasis = { ...data.game.costBasis };
  game.initialCapital =
    typeof data.game.initialCapital === "number"
      ? data.game.initialCapital
      : LEGACY_INITIAL_CAPITAL;

  gameDayIndex = data.gameDayIndex;
  gameMinutes = data.gameMinutes;
  isMarketClosed = !!data.isMarketClosed;
  isPaused = !!data.isPaused;
  headlineImpulse = data.headlineImpulse ?? 0;
  nextCalendarEventId = data.nextCalendarEventId ?? 1;
  scheduledEvents = data.scheduledEvents ?? [];
  newsCountByStock = { ...emptyChainState(), ...data.newsCountByStock };
  chainStepByStock = { ...emptyChainState(), ...data.chainStepByStock };
  dividendCandleCounter = data.dividendCandleCounter ?? 0;
  sessionCandleCount = data.sessionCandleCount ?? 0;

  (data.stocks || []).forEach((row) => {
    const s = getStockById(row.id);
    if (!s) return;
    s.price = Math.round(row.price);
    s.volatilityMod = row.volatilityMod ?? 1;
    s.priceBias = row.priceBias ?? 0;
  });

  STOCK_SPECS.forEach((spec) => {
    const id = spec.id;
    candleHistory[id] = data.candleHistory?.[id] ?? [];
  });

  Object.keys(sessionOpenPrice).forEach((k) => delete sessionOpenPrice[k]);
  Object.assign(sessionOpenPrice, data.sessionOpenPrice || {});
  stocks.forEach((s) => {
    prevTickPrice[s.id] = s.price;
  });

  tickInCandle = data.tickInCandle ?? 0;
  candlePeriodStartMin =
    tickInCandle > 0
      ? data.candlePeriodStartMin ??
        Math.max(
          MARKET_OPEN_MIN,
          gameMinutes - tickInCandle * GAME_MINUTES_PER_REAL_SEC
        )
      : gameMinutes;
  if (data.candleOhlcBuffer && typeof data.candleOhlcBuffer === "object") {
    candleOhlcBuffer = {};
    stocks.forEach((s) => {
      const b = data.candleOhlcBuffer[s.id];
      if (b && typeof b.o === "number") {
        candleOhlcBuffer[s.id] = {
          o: b.o,
          h: b.h,
          l: b.l,
        };
      } else {
        candleOhlcBuffer[s.id] = {
          o: s.price,
          h: s.price,
          l: s.price,
        };
      }
    });
  } else {
    candleOhlcBuffer = {};
    stocks.forEach((s) => {
      candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
    });
  }
}

function tryLoadGameState() {
  let raw;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || data.v !== SAVE_VERSION || !data.game) return false;
  if (
    Array.isArray(data.stocks) &&
    data.stocks.length !== STOCK_SPECS.length
  ) {
    return false;
  }
  if (typeof data.game.cash !== "number" || data.game.holdings == null) {
    return false;
  }

  const lastSavedAt = data.lastSavedAt || Date.now();
  const elapsed = Date.now() - lastSavedAt;
  const snap = data.priceSnapshot || {};
  const holdingsBefore = { ...data.game.holdings };

  try {
    applyLoadedState(data);
  } catch (e) {
    console.warn("applyLoadedState failed", e);
    return false;
  }

  const offlineDiv = computeOfflineDividendAccrual(elapsed, snap, holdingsBefore);
  if (offlineDiv > 0) {
    game.cash += offlineDiv;
    addNewsItem(
      `오프라인 배당 누적 입금 · ${formatWon(offlineDiv)} (${Math.floor(
        Math.min(elapsed, OFFLINE_DIVIDEND_MAX_MS) / 60000
      )}분 경과 반영, 상한 7일)`,
      "dividend"
    );
    setMessage(`오프라인 배당 ${formatWon(offlineDiv)} 입금`, "ok");
    renderAssetSummary();
  }

  return true;
}

/**
 * 뉴스 체이닝: 같은 날 시나리오 연결 (오전 악재 → 오후 반등 등)
 * impacts: 즉시 P×(1+r), bias: 이후 몇 봉 동안 방향성 추세
 */
const NEWS_CHAINS = {
  JBD: [
    {
      headline:
        "[속보] 재빈디자인, 글로벌 브랜드 리뉴얼 프로젝트 수주 확대",
      impacts: { JBD: 0.008 },
      bias: { JBD: 0.006 },
      volFactor: 1.28,
    },
    {
      headline:
        "[분석] 대형 클라이언트 지출 축소 — 단기 수주 공백 우려",
      impacts: { JBD: -0.006 },
      bias: { JBD: -0.005 },
      volFactor: 1.22,
    },
  ],
  SYW: [
    {
      headline:
        "[속보] 승윤윙즈, 자율주행 시범 구간 확대·파트너십 체결",
      impacts: { SYW: 0.01 },
      bias: { SYW: 0.007 },
      volFactor: 1.32,
    },
    {
      headline:
        "[분석] 안전 인증 일정 지연 — 모빌리티 사업 밸류에이션 재점검",
      impacts: { SYW: -0.007 },
      bias: { SYW: -0.006 },
      volFactor: 1.26,
    },
  ],
  MJS: [
    {
      headline:
        "[속보] 민준스테이, 구독형 케어 서비스 MAU 전년比 두 자릿수 성장",
      impacts: { MJS: 0.012 },
      bias: { MJS: 0.008 },
      volFactor: 1.35,
    },
    {
      headline:
        "[속보] 경쟁사 무료 프로모션 확대 — 단기 이탈 우려",
      impacts: { MJS: -0.008 },
      bias: { MJS: -0.005 },
      volFactor: 1.28,
    },
  ],
  BSL: [
    {
      headline:
        "[특징주] 범서랩, 기능성 라인 해외 채널 매출 호조",
      impacts: { BSL: 0.009 },
      bias: { BSL: 0.006 },
      volFactor: 1.24,
    },
    {
      headline:
        "[속보] 원료·물류비 상승 — 마진 압박 전망",
      impacts: { BSL: -0.007 },
      bias: { BSL: -0.005 },
      volFactor: 1.3,
    },
  ],
  SYG: [
    {
      headline:
        "[속보] 석영기어, 정밀 모듈 대형 수주 및 생산 라인 증설",
      impacts: { SYG: 0.011 },
      bias: { SYG: 0.008 },
      volFactor: 1.34,
    },
    {
      headline:
        "[분석] 설비 투자 사이클 둔화 — 단기 목표가 하향",
      impacts: { SYG: -0.009 },
      bias: { SYG: -0.007 },
      volFactor: 1.3,
    },
  ],
  JWF: [
    {
      headline:
        "[운용] 진우펀드, 펀드 순매수 유입·운용 규모 확대",
      impacts: { JWF: 0.005 },
      bias: { JWF: 0.006 },
      volFactor: 1.15,
    },
    {
      headline:
        "[속보] 포트폴리오 일부 환매 증가 — 단기 수익률 변동성",
      impacts: { JWF: -0.005 },
      bias: { JWF: -0.004 },
      volFactor: 1.18,
    },
  ],
  YHL: [
    {
      headline:
        "[패션] 요한룩, 큐레이션 컬렉션 매출 전년比 성장",
      impacts: { YHL: 0.009 },
      bias: { YHL: 0.006 },
      volFactor: 1.28,
    },
    {
      headline:
        "[이슈] 소비 둔화 우려 — 패션 플랫폼 업종 동반 약세",
      impacts: { YHL: -0.008 },
      bias: { YHL: -0.005 },
      volFactor: 1.32,
    },
  ],
  SWB: [
    {
      headline:
        "[플랫폼] 선웅비즈, B2B 솔루션 신규 계약·처리량 기록 경신",
      impacts: { SWB: 0.006 },
      bias: { SWB: 0.005 },
      volFactor: 1.18,
    },
    {
      headline:
        "[속보] 요금·수수료 인하 논의 — 수익성 우려",
      impacts: { SWB: -0.006 },
      bias: { SWB: -0.004 },
      volFactor: 1.22,
    },
  ],
};

/** 당일 완료 봉 수(1-based) — 체이닝 스텝 발화 (하루 최대 39봉) */
const CHAIN_SCHEDULE = {
  JBD: [4, 25],
  SYW: [6, 27],
  MJS: [8, 29],
  BSL: [10, 31],
  SYG: [12, 33],
  JWF: [14, 35],
  YHL: [16, 37],
  SWB: [18, 22],
};

const HORIZON_EVENT_TEMPLATES = [
  {
    title: "미 연준 의사록 공개",
    sentiment: "bad",
    targets: ["SWB", "MJS"],
    volBump: 1.42,
    shock: -0.011,
  },
  {
    title: "수출입 물가 지수",
    sentiment: "good",
    targets: ["SYG"],
    volBump: 1.38,
    shock: 0.009,
  },
  {
    title: "제조업 PMI(예비)",
    sentiment: "bad",
    targets: ["BSL"],
    volBump: 1.48,
    shock: -0.013,
  },
  {
    title: "유가 급등 — 인플레 우려",
    sentiment: "bad",
    targets: ["SWB"],
    volBump: 1.35,
    shock: -0.008,
  },
  {
    title: "헬스케어 규제 완화 기대",
    sentiment: "good",
    targets: ["MJS"],
    volBump: 1.52,
    shock: 0.016,
  },
];

function buildInitialCalendar() {
  return [
    {
      id: "cal-1",
      dayIndex: 1,
      title: "미 연준 의장 연설",
      sentiment: "bad",
      targets: ["SWB"],
      volBump: 1.52,
      shock: -0.014,
      fired: false,
    },
    {
      id: "cal-2",
      dayIndex: 2,
      title: "뷰티·코스메틱 수출 지표(호조)",
      sentiment: "good",
      targets: ["BSL"],
      volBump: 1.58,
      shock: 0.021,
      fired: false,
    },
    {
      id: "cal-3",
      dayIndex: 3,
      title: "소비자물가(CPI) 예비치",
      sentiment: "bad",
      targets: ["SWB", "MJS"],
      volBump: 1.55,
      shock: -0.012,
      fired: false,
    },
    {
      id: "cal-4",
      dayIndex: 5,
      title: "케어 테크 업종 대형 계약 발표",
      sentiment: "good",
      targets: ["MJS"],
      volBump: 1.62,
      shock: 0.024,
      fired: false,
    },
    {
      id: "cal-5",
      dayIndex: 7,
      title: "지수 리밸런싱 종료",
      sentiment: "good",
      targets: ["JWF"],
      volBump: 1.35,
      shock: 0.007,
      fired: false,
    },
    {
      id: "cal-6",
      dayIndex: 10,
      title: "지정학 리스크 고조",
      sentiment: "bad",
      targets: ["SYG", "SWB"],
      volBump: 1.48,
      shock: -0.015,
      fired: false,
    },
    {
      id: "cal-7",
      dayIndex: 14,
      title: "실적 시즌 시작(기대)",
      sentiment: "good",
      targets: ["JBD", "SYW"],
      volBump: 1.45,
      shock: 0.011,
      fired: false,
    },
    {
      id: "cal-8",
      dayIndex: 18,
      title: "통화정책 회의 결과",
      sentiment: "bad",
      targets: ["YHL"],
      volBump: 1.5,
      shock: -0.01,
      fired: false,
    },
  ];
}

function generateHorizonEvent(dayIndex) {
  const tpl =
    HORIZON_EVENT_TEMPLATES[
      Math.floor(Math.random() * HORIZON_EVENT_TEMPLATES.length)
    ];
  return {
    id: `cal-gen-${nextCalendarEventId++}`,
    dayIndex,
    title: tpl.title,
    sentiment: tpl.sentiment,
    targets: [...tpl.targets],
    volBump: tpl.volBump + (Math.random() * 0.08 - 0.04),
    shock: tpl.shock * (0.92 + Math.random() * 0.16),
    fired: false,
  };
}

function ensureCalendarHorizon() {
  const maxDay = scheduledEvents.reduce(
    (m, e) => Math.max(m, e.dayIndex),
    gameDayIndex
  );
  if (maxDay >= gameDayIndex + 21) return;
  let d = maxDay + 2;
  for (let k = 0; k < 6; k += 1) {
    scheduledEvents.push(generateHorizonEvent(d));
    d += 3 + Math.floor(Math.random() * 3);
  }
}

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function formatMinuteOfDay(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 누적 일차 + 장내 시각 (X축 라벨) */
function formatCandleXLabel(dayIndex, periodStartMin) {
  return `D${dayIndex + 1}·${formatMinuteOfDay(periodStartMin)}`;
}

function getCalendarParts(dayIndex) {
  const d = new Date(2000, 3, 1);
  d.setDate(d.getDate() + dayIndex);
  return { month: d.getMonth() + 1, day: d.getDate() };
}

function getYearChar(dayIndex) {
  return Math.floor(dayIndex / 365) + 1;
}

function formatDateTimeBracket() {
  const yc = getYearChar(gameDayIndex);
  const { month, day } = getCalendarParts(gameDayIndex);
  const t = formatMinuteOfDay(gameMinutes);
  return `[${yc}년차 ${month}월 ${day}일 ${t}]`;
}

function isTradingSession() {
  return (
    !isMarketClosed &&
    !isPaused &&
    gameMinutes >= MARKET_OPEN_MIN &&
    gameMinutes < MARKET_CLOSE_MIN
  );
}

function resetDailyNewsState() {
  newsCountByStock = emptyChainState();
  chainStepByStock = emptyChainState();
}

function initHoldings(options = {}) {
  const preserveBias = options.preserveBias === true;
  stocks.forEach((s) => {
    if (game.holdings[s.id] === undefined) game.holdings[s.id] = 0;
    if (game.costBasis[s.id] === undefined) game.costBasis[s.id] = 0;
    if (!preserveBias) s.priceBias = 0;
  });
}

function formatWon(n) {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

function getStockById(id) {
  return stocks.find((s) => s.id === id);
}

function portfolioValue() {
  let v = 0;
  stocks.forEach((s) => {
    const qty = game.holdings[s.id] ?? 0;
    v += qty * s.price;
  });
  return v;
}

function netWorth() {
  return game.cash + portfolioValue();
}

function totalStockCost() {
  let t = 0;
  stocks.forEach((s) => {
    const q = game.holdings[s.id] ?? 0;
    if (q <= 0) return;
    t += game.costBasis[s.id] ?? 0;
  });
  return t;
}

function stockEvalProfit() {
  let ev = 0;
  let cost = 0;
  stocks.forEach((s) => {
    const q = game.holdings[s.id] ?? 0;
    if (q <= 0) return;
    const cb = game.costBasis[s.id] ?? 0;
    cost += cb;
    ev += q * s.price;
  });
  return { eval: ev, cost, pl: ev - cost };
}

function buyStock(stockId, quantity) {
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, reason: "수량은 1 이상의 정수여야 합니다." };
  }
  const stock = getStockById(stockId);
  if (!stock) return { ok: false, reason: "존재하지 않는 종목입니다." };

  const cost = stock.price * q;
  if (cost > game.cash) {
    return { ok: false, reason: "현금이 부족합니다." };
  }

  game.cash -= Math.round(cost);
  game.holdings[stockId] = (game.holdings[stockId] ?? 0) + q;
  game.costBasis[stockId] = (game.costBasis[stockId] ?? 0) + Math.round(cost);
  return { ok: true };
}

function sellStock(stockId, quantity) {
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, reason: "수량은 1 이상의 정수여야 합니다." };
  }
  const stock = getStockById(stockId);
  if (!stock) return { ok: false, reason: "존재하지 않는 종목입니다." };

  const owned = game.holdings[stockId] ?? 0;
  if (q > owned) {
    return { ok: false, reason: "보유 수량보다 많이 팔 수 없습니다." };
  }

  const cb = game.costBasis[stockId] ?? 0;
  const ratio = owned > 0 ? (owned - q) / owned : 0;
  game.costBasis[stockId] = Math.round(cb * ratio);

  game.holdings[stockId] = owned - q;
  game.cash += Math.round(stock.price * q);
  return { ok: true };
}

function decayVolatilityMods() {
  stocks.forEach((s) => {
    const m = s.volatilityMod;
    s.volatilityMod = Math.max(1, 1 + (m - 1) * 0.966);
  });
}

function returnForStock(s, marketFactor, idio) {
  const vm = s.volatilityMod;
  const headlineBlend = 0.82 + 0.18 * Math.min(vm, 2.2);
  const noiseBlend = 0.72 + 0.28 * Math.min(vm, 2.2);
  const biasTerm = s.priceBias * 0.022;

  if (s.volatility === "high") {
    return (
      0.1 * marketFactor +
      2.15 * headlineImpulse * headlineBlend +
      0.0062 * idio * noiseBlend +
      biasTerm
    );
  }
  if (s.volatility === "medium") {
    return (
      0.48 * marketFactor +
      0.52 * headlineImpulse * headlineBlend +
      0.002 * idio * noiseBlend +
      biasTerm
    );
  }
  return (
    0.975 * marketFactor +
    0.055 * headlineImpulse * headlineBlend +
    0.00042 * idio * noiseBlend +
    biasTerm
  );
}

function oneMicroPriceStep() {
  const marketFactor = 0.00011 * gaussian() + 0.000032;
  if (Math.random() < 0.028) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    headlineImpulse += dir * (0.0035 + Math.random() * 0.016);
  }
  headlineImpulse *= 0.935;

  stocks.forEach((s) => {
    const idio = gaussian();
    const r = returnForStock(s, marketFactor, idio);
    s.price = Math.round(Math.max(1_000, s.price * (1 + r)));
  });
}

function payDividends() {
  let total = 0;
  stocks.forEach((s) => {
    if (s.volatility !== "medium" && s.volatility !== "low") return;
    const q = game.holdings[s.id] ?? 0;
    if (q <= 0) return;
    const rate = s.volatility === "medium" ? 0.00085 : 0.0005;
    total += q * s.price * rate;
  });
  if (total <= 0) return;

  game.cash += Math.round(total);
  addNewsItem(`배당금 입금 완료 · ${formatWon(total)}`, "dividend");
  renderAssetSummary();
}

const MAX_CANDLES_PER_STOCK = 2000;

function pushCandleRow(
  stockId,
  candleDayIndex,
  periodStartMin,
  open,
  high,
  low,
  close,
  volume
) {
  const row = {
    x: formatCandleXLabel(candleDayIndex, periodStartMin),
    o: Math.round(open),
    h: Math.round(high),
    l: Math.round(low),
    c: Math.round(close),
    v: Math.round(volume),
  };
  candleHistory[stockId].push(row);
  while (candleHistory[stockId].length > MAX_CANDLES_PER_STOCK) {
    candleHistory[stockId].shift();
  }
}

function beginCandlePeriodIfNeeded() {
  if (tickInCandle !== 0) return;
  candlePeriodStartMin = gameMinutes;
  stocks.forEach((s) => {
    candleOhlcBuffer[s.id] = {
      o: s.price,
      h: s.price,
      l: s.price,
    };
  });
}

/** 봉 확정: 게임 시간 10분(현실 10초)마다 또는 장 마감 시 미완성 봉 처리 */
function sealCurrentCandleAndReset() {
  decayVolatilityMods();
  const periodStart = candlePeriodStartMin;
  stocks.forEach((s) => {
    const { o, h, l } = candleOhlcBuffer[s.id];
    const close = s.price;
    const vol = Math.max(
      1,
      Math.round(
        ((h - l) / Math.max(o, 1)) * 2_800_000 +
          Math.abs(close - o) * 42 +
          Math.random() * 9000 +
          14000
      )
    );
    pushCandleRow(
      s.id,
      gameDayIndex,
      periodStart,
      o,
      h,
      l,
      close,
      vol
    );
    s.priceBias *= 0.88;
  });

  sessionCandleCount += 1;
  dividendCandleCounter += 1;
  if (dividendCandleCounter % DIVIDEND_EVERY_CANDLES === 0) {
    payDividends();
  }

  const completed = Math.floor(
    (gameMinutes - MARKET_OPEN_MIN) / CANDLE_GAME_MINUTES
  );
  tryFireChainNews(completed);
  tickInCandle = 0;
}

function warmupPrices() {
  for (let i = 0; i < 96; i += 1) {
    oneMicroPriceStep();
  }
}

function snapshotPrices() {
  const o = {};
  stocks.forEach((s) => {
    o[s.id] = s.price;
  });
  return o;
}

function flashPriceNode(selector, dir) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.remove("flash-up", "flash-down");
  void el.offsetWidth;
  el.classList.add(dir === "up" ? "flash-up" : "flash-down");
  setTimeout(() => {
    el.classList.remove("flash-up", "flash-down");
  }, 700);
}

function finalizePriceUI(oldPrices) {
  refreshDetailChart();
  renderStockListMain();
  renderAssetSummary();
  stocks.forEach((s) => {
    const o = oldPrices[s.id];
    if (o !== undefined && o !== s.price) {
      const dir = s.price > o ? "up" : "down";
      flashPriceNode(`[data-watch-price="${s.id}"]`, dir);
      flashPriceNode(`[data-portfolio-price="${s.id}"]`, dir);
    }
    prevTickPrice[s.id] = s.price;
  });
}

function applyImpactFormula(impacts) {
  Object.entries(impacts).forEach(([id, impact]) => {
    const s = getStockById(id);
    if (!s) return;
    s.price = Math.round(Math.max(1_000, s.price * (1 + impact)));
  });
}

function applyBiasDeltas(biasMap) {
  if (!biasMap) return;
  Object.entries(biasMap).forEach(([id, b]) => {
    const s = getStockById(id);
    if (!s) return;
    s.priceBias += b;
    s.priceBias = Math.max(-0.12, Math.min(0.12, s.priceBias));
  });
}

function formatImpactLine(ev) {
  const parts = Object.entries(ev.impacts || {}).map(
    ([id, r]) => `${id} ${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`
  );
  const bparts = Object.entries(ev.bias || {}).map(
    ([id, r]) => `bias ${id} ${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%p`
  );
  return [...parts, ...bparts].join(" · ");
}

function applyNewsPayload(ev) {
  const oldPrices = snapshotPrices();
  applyImpactFormula(ev.impacts || {});
  applyBiasDeltas(ev.bias);
  if (ev.volFactor) {
    Object.keys(ev.impacts || {}).forEach((id) => {
      const s = getStockById(id);
      if (s) s.volatilityMod = Math.min(2.85, s.volatilityMod * ev.volFactor);
    });
  }
  finalizePriceUI(oldPrices);
}

function apexCommonChartOpts(height, chartType) {
  return {
    chart: {
      type: chartType,
      height,
      toolbar: { show: false },
      zoom: { enabled: false },
      animations: { enabled: false },
      background: "transparent",
      fontFamily:
        'Pretendard, "Apple SD Gothic Neo", -apple-system, sans-serif',
    },
    theme: { mode: "dark" },
    grid: {
      borderColor: "rgba(37, 42, 53, 0.9)",
      strokeDashArray: 3,
      padding: { left: 4, right: 8, top: 4, bottom: 0 },
    },
    dataLabels: { enabled: false },
    tooltip: {
      theme: "dark",
      x: { show: true },
    },
  };
}

function buildCandleSeriesData(stockId) {
  return candleHistory[stockId].map((r) => ({
    x: r.x,
    y: [r.o, r.h, r.l, r.c],
  }));
}

function buildVolumeSeriesData(stockId) {
  return candleHistory[stockId].map((r) => {
    const up = r.c >= r.o;
    return {
      x: r.x,
      y: r.v,
      fillColor: up ? CANDLE_UP : CANDLE_DOWN,
    };
  });
}

function destroyDetailCharts() {
  if (apexDetail.candle) {
    apexDetail.candle.destroy();
    apexDetail.candle = null;
  }
  if (apexDetail.vol) {
    apexDetail.vol.destroy();
    apexDetail.vol = null;
  }
  apexDetail.stockId = null;
}

function initDetailCharts(stockId) {
  if (typeof ApexCharts === "undefined") return;
  const s = getStockById(stockId);
  if (!s) return;

  const cEl = document.getElementById("apexCandleDetail");
  const vEl = document.getElementById("apexVolumeDetail");
  if (!cEl || !vEl) return;

  destroyDetailCharts();
  cEl.innerHTML = "";
  vEl.innerHTML = "";

  const candleBase = apexCommonChartOpts(210, "candlestick");
  const candleOpts = {
    ...candleBase,
    series: [
      {
        name: stockId,
        data: buildCandleSeriesData(stockId),
      },
    ],
    plotOptions: {
      candlestick: {
        colors: {
          upward: CANDLE_UP,
          downward: CANDLE_DOWN,
        },
      },
    },
    xaxis: {
      type: "category",
      labels: {
        rotate: -45,
        style: { colors: "#8b95a8", fontSize: "8px" },
        maxHeight: 80,
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tickAmount: 12,
    },
    yaxis: {
      labels: {
        style: { colors: "#8b95a8", fontSize: "10px" },
        formatter: (v) => Math.round(v).toLocaleString("ko-KR"),
      },
    },
  };

  const volBase = apexCommonChartOpts(88, "bar");
  const volOpts = {
    ...volBase,
    series: [
      {
        name: "거래량",
        data: buildVolumeSeriesData(stockId),
      },
    ],
    plotOptions: {
      bar: {
        columnWidth: "72%",
        borderRadius: 1,
      },
    },
    xaxis: {
      type: "category",
      labels: { show: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { show: false },
  };

  apexDetail.candle = new ApexCharts(cEl, candleOpts);
  apexDetail.vol = new ApexCharts(vEl, volOpts);
  apexDetail.stockId = stockId;
  apexDetail.candle.render();
  apexDetail.vol.render();
}

function refreshDetailChart() {
  if (!selectedStockId || !apexDetail.candle || !apexDetail.vol) return;
  const id = selectedStockId;
  apexDetail.candle.updateSeries(
    [{ name: id, data: buildCandleSeriesData(id) }],
    true
  );
  apexDetail.vol.updateSeries(
    [{ name: "거래량", data: buildVolumeSeriesData(id) }],
    true
  );
}

function addNewsItem(text, type = "news", subline = "") {
  const list = document.getElementById("newsFeed");
  if (!list) return;

  const li = document.createElement("li");
  li.className = `news-item news-${type}`;

  const time = new Date();
  const ts = time.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const timeEl = document.createElement("span");
  timeEl.className = "news-time";
  timeEl.textContent = ts;

  const textEl = document.createElement("span");
  textEl.className = "news-text";
  textEl.textContent = text;

  li.appendChild(timeEl);
  li.appendChild(textEl);

  if (subline) {
    const sub = document.createElement("span");
    sub.className = "news-impact-tag";
    sub.textContent = subline;
    li.appendChild(sub);
  }

  list.insertBefore(li, list.firstChild);

  while (list.children.length > MAX_NEWS_ITEMS) {
    list.removeChild(list.lastChild);
  }
}

function tryFireChainNews(completedCandleCount) {
  Object.keys(NEWS_CHAINS).forEach((stockId) => {
    const sched = CHAIN_SCHEDULE[stockId];
    if (!sched) return;
    const step = chainStepByStock[stockId];
    if (step >= sched.length || newsCountByStock[stockId] >= 3) return;
    if (completedCandleCount !== sched[step]) return;

    const story = NEWS_CHAINS[stockId][step];
    addNewsItem(
      story.headline,
      "chain",
      `반영: ${formatImpactLine(story)}`
    );
    applyNewsPayload(story);
    chainStepByStock[stockId] += 1;
    newsCountByStock[stockId] += 1;
  });
}

/** 보조 속보: 체이닝 템포 사이 여유 — 종목당 일일 상한은 체이닝이 담당 */
function scheduleAmbientNewsTimer() {
  clearTimeout(newsTimeoutId);
  const delay = 52000 + Math.random() * 38000;
  newsTimeoutId = setTimeout(() => {
    if (!isPaused && !isMarketClosed && isTradingSession()) {
      addNewsItem(
        "[시장] 프로그램·외인 수급 분석 — 변동성 장세, 분할 매매 유효",
        "ambient"
      );
    }
    if (!isMarketClosed) scheduleAmbientNewsTimer();
  }, delay);
}

function clearAmbientNewsTimer() {
  clearTimeout(newsTimeoutId);
  newsTimeoutId = null;
}

function clearGameClockTimer() {
  clearInterval(gameClockIntervalId);
  gameClockIntervalId = null;
}

function renderDateTimeLine() {
  const el = document.getElementById("gameDateTime");
  if (!el) return;
  el.textContent = formatDateTimeBracket();
}

function volatilityBadgeClass(vol) {
  if (vol === "high") return "mts-badge-high";
  if (vol === "medium") return "mts-badge-mid";
  return "mts-badge-low";
}

function volatilityLabel(vol) {
  if (vol === "high") return "고변동";
  if (vol === "medium") return "중변동";
  return "저변동";
}

function renderStockListMain() {
  const ul = document.getElementById("stockListMain");
  if (!ul) return;
  ul.innerHTML = "";

  stocks.forEach((s) => {
    const open = sessionOpenPrice[s.id] ?? s.price;
    const chg = s.price - open;
    const chgPct = open !== 0 ? (chg / open) * 100 : 0;
    const chgCls =
      chg > 0 ? "chg-up" : chg < 0 ? "chg-down" : "chg-flat";
    const sign = chg > 0 ? "+" : "";

    const li = document.createElement("li");
    li.className = "stock-list-row";
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    li.dataset.stockId = s.id;
    li.innerHTML = `
      <div class="stock-list-row-main">
        <div class="stock-list-name-block">
          <span class="stock-list-name">${escapeHtml(s.name)}</span>
          <span class="stock-list-ticker">${escapeHtml(s.id)}</span>
          <span class="mts-badge ${volatilityBadgeClass(s.volatility)}">${volatilityLabel(s.volatility)}</span>
        </div>
        <div class="stock-list-price-block">
          <span class="stock-list-price watch-price" data-watch-price="${escapeHtml(s.id)}">${formatWon(s.price)}</span>
          <span class="stock-list-pct ${chgCls}">${sign}${chgPct.toFixed(2)}%</span>
        </div>
      </div>
      <p class="stock-list-desc">${escapeHtml(s.desc)}</p>
    `;

    const openDetail = () => openStockDetail(s.id);

    li.addEventListener("click", openDetail);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail();
      }
    });

    ul.appendChild(li);
  });
}

function updateDetailPriceLine() {
  if (!selectedStockId) return;
  const s = getStockById(selectedStockId);
  const el = document.getElementById("detailCurrentPrice");
  if (el && s) el.textContent = formatWon(s.price);
}

function openStockDetail(stockId) {
  const s = getStockById(stockId);
  if (!s) return;

  selectedStockId = stockId;
  const list = document.getElementById("marketListView");
  const det = document.getElementById("stockDetailView");
  if (list) list.hidden = true;
  if (det) det.hidden = false;

  const nameEl = document.getElementById("detailStockName");
  const tickEl = document.getElementById("detailStockTicker");
  const descEl = document.getElementById("detailStockDesc");
  const badge = document.getElementById("detailVolBadge");
  if (nameEl) nameEl.textContent = s.name;
  if (tickEl) tickEl.textContent = s.id;
  if (descEl) descEl.textContent = s.desc || "";
  if (badge) {
    badge.className = `mts-badge ${volatilityBadgeClass(s.volatility)}`;
    badge.textContent = volatilityLabel(s.volatility);
  }
  updateDetailPriceLine();

  initDetailCharts(stockId);
}

function closeStockDetail() {
  selectedStockId = null;
  destroyDetailCharts();
  const list = document.getElementById("marketListView");
  const det = document.getElementById("stockDetailView");
  if (list) list.hidden = false;
  if (det) det.hidden = true;
}

function bindDetailTrade() {
  const back = document.getElementById("btnBackToList");
  if (back) back.addEventListener("click", closeStockDetail);

  const buyBtn = document.getElementById("detailBtnBuy");
  const sellBtn = document.getElementById("detailBtnSell");
  const qtyInput = document.getElementById("detailQtyInput");

  function doTrade(action) {
    const id = selectedStockId;
    if (!id || !qtyInput) return;
    const qty = qtyInput.value;
    const result =
      action === "buy" ? buyStock(id, qty) : sellStock(id, qty);
    if (result.ok) {
      setMessage(
        action === "buy"
          ? `${id} ${qty}주 매수 완료.`
          : `${id} ${qty}주 매도 완료.`,
        "ok"
      );
      renderAssetSummary();
      renderStocks();
      renderStockListMain();
      updateDetailPriceLine();
      scheduleSave();
    } else {
      setMessage(result.reason, "err");
    }
  }

  if (buyBtn) buyBtn.addEventListener("click", () => doTrade("buy"));
  if (sellBtn) sellBtn.addEventListener("click", () => doTrade("sell"));
}

function renderAssetSummary() {
  const nw = netWorth();
  const base = game.initialCapital ?? INITIAL_CAPITAL;
  const totalPl = nw - base;
  const totalPlPct = base !== 0 ? (totalPl / base) * 100 : 0;

  const profitEl = document.getElementById("summaryProfit");
  const pctEl = document.getElementById("summaryProfitPct");
  const nwEl = document.getElementById("summaryNetWorth");

  if (nwEl) nwEl.textContent = formatWon(nw);
  if (document.getElementById("summaryCash"))
    document.getElementById("summaryCash").textContent = formatWon(game.cash);
  if (document.getElementById("summaryStockEval"))
    document.getElementById("summaryStockEval").textContent =
      formatWon(portfolioValue());
  if (document.getElementById("summaryCost"))
    document.getElementById("summaryCost").textContent = formatWon(
      totalStockCost()
    );

  if (profitEl && pctEl) {
    profitEl.textContent = `${totalPl >= 0 ? "+" : ""}${formatWon(totalPl)}`;
    pctEl.textContent = `(${totalPlPct >= 0 ? "+" : ""}${totalPlPct.toFixed(
      2
    )}%)`;
    profitEl.className = `asset-sub ${
      totalPl > 0 ? "value-up" : totalPl < 0 ? "value-down" : "value-neutral"
    }`;
    pctEl.className = `asset-pct ${
      totalPl > 0 ? "value-up" : totalPl < 0 ? "value-down" : "value-neutral"
    }`;
  }

  const ageEl = document.getElementById("age");
  if (ageEl) ageEl.textContent = `${game.age}세`;
}

function renderCalendarUI() {
  const ul = document.getElementById("calendarWeekList");
  if (!ul) return;

  const upcoming = scheduledEvents
    .filter(
      (ev) =>
        !ev.fired &&
        ev.dayIndex >= gameDayIndex &&
        ev.dayIndex <= gameDayIndex + 7
    )
    .sort((a, b) => a.dayIndex - b.dayIndex);

  ul.innerHTML = "";

  if (upcoming.length === 0) {
    const li = document.createElement("li");
    li.className = "calendar-empty";
    li.textContent = "예정된 주요 일정이 없습니다.";
    ul.appendChild(li);
    return;
  }

  upcoming.forEach((ev) => {
    const gap = ev.dayIndex - gameDayIndex;
    let whenLabel = "오늘";
    if (gap === 1) whenLabel = "내일";
    else if (gap > 1) whenLabel = `${gap}일 후`;

    const { month, day } = getCalendarParts(ev.dayIndex);
    const li = document.createElement("li");
    li.className = `calendar-item sentiment-${ev.sentiment}`;

    const when = document.createElement("span");
    when.className = "calendar-when";
    when.textContent = `${whenLabel} · ${month}/${day}`;

    const title = document.createElement("div");
    title.className = "calendar-title";
    title.textContent = ev.title;

    const meta = document.createElement("div");
    meta.className = "calendar-meta";

    const badge = document.createElement("span");
    badge.className = `calendar-badge ${
      ev.sentiment === "good" ? "bull" : "bear"
    }`;
    badge.textContent = ev.sentiment === "good" ? "호재" : "악재";

    const tickers = document.createElement("span");
    tickers.className = "calendar-tickers";
    tickers.textContent = ev.targets.join(", ");

    meta.appendChild(badge);
    meta.appendChild(tickers);

    li.appendChild(when);
    li.appendChild(title);
    li.appendChild(meta);
    ul.appendChild(li);
  });
}

function applyCalendarEventPayload(ev) {
  const oldPrices = snapshotPrices();
  const impacts = {};
  ev.targets.forEach((id) => {
    impacts[id] = ev.shock;
  });
  applyImpactFormula(impacts);
  ev.targets.forEach((id) => {
    const s = getStockById(id);
    if (!s) return;
    s.volatilityMod = Math.min(2.85, s.volatilityMod * ev.volBump);
    const b = ev.sentiment === "good" ? 0.0055 : -0.0055;
    s.priceBias += b;
    s.priceBias = Math.max(-0.12, Math.min(0.12, s.priceBias));
  });
  finalizePriceUI(oldPrices);
}

function fireDueCalendarEvents() {
  scheduledEvents.forEach((ev) => {
    if (ev.fired || ev.dayIndex !== gameDayIndex) return;
    ev.fired = true;
    addNewsItem(`[경제 일정] ${ev.title}`, "calendar");
    setMessage(
      `경제 캘린더 · ${ev.title}`,
      ev.sentiment === "good" ? "ok" : "err"
    );
    applyCalendarEventPayload(ev);
  });
}

function onSessionSecondTick() {
  if (isPaused || isMarketClosed) return;

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket();
    return;
  }

  beginCandlePeriodIfNeeded();

  oneMicroPriceStep();
  stocks.forEach((s) => {
    const b = candleOhlcBuffer[s.id];
    if (b) {
      b.h = Math.max(b.h, s.price);
      b.l = Math.min(b.l, s.price);
    }
  });

  gameMinutes += GAME_MINUTES_PER_REAL_SEC;
  tickInCandle += 1;
  renderDateTimeLine();

  if (tickInCandle >= TICKS_PER_CANDLE) {
    sealCurrentCandleAndReset();
  }

  refreshDetailChart();
  renderStockListMain();
  updateDetailPriceLine();
  renderAssetSummary();

  stocks.forEach((s) => {
    const o = prevTickPrice[s.id];
    if (o !== undefined && o !== s.price) {
      const dir = s.price > o ? "up" : "down";
      flashPriceNode(`[data-watch-price="${s.id}"]`, dir);
      flashPriceNode(`[data-portfolio-price="${s.id}"]`, dir);
    }
    prevTickPrice[s.id] = s.price;
  });

  scheduleSave();

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket();
  }
}

function startGameClockTimer() {
  clearGameClockTimer();
  gameClockIntervalId = setInterval(onSessionSecondTick, 1000);
}

function scheduleNextTradingDay() {
  clearTimeout(nextTradingDayTimeoutId);
  nextTradingDayTimeoutId = setTimeout(() => {
    openNextTradingDay();
    nextTradingDayTimeoutId = null;
  }, NEXT_TRADING_DAY_DELAY_MS);
}

function snapshotSessionOpen() {
  stocks.forEach((s) => {
    sessionOpenPrice[s.id] = s.price;
    prevTickPrice[s.id] = s.price;
  });
}

function clearCandleHistory() {
  STOCK_SPECS.forEach((spec) => {
    candleHistory[spec.id] = [];
  });
  sessionCandleCount = 0;
  dividendCandleCounter = 0;
  tickInCandle = 0;
  candlePeriodStartMin = MARKET_OPEN_MIN;
  candleOhlcBuffer = {};
}

function openNextTradingDay() {
  gameDayIndex += 1;
  isMarketClosed = false;
  gameMinutes = MARKET_OPEN_MIN;
  tickInCandle = 0;
  candlePeriodStartMin = MARKET_OPEN_MIN;
  candleOhlcBuffer = {};
  headlineImpulse *= 0.4;

  resetDailyNewsState();
  dividendCandleCounter = 0;

  stocks.forEach((s) => {
    s.priceBias = 0;
  });

  ensureCalendarHorizon();
  fireDueCalendarEvents();

  for (let i = 0; i < 120; i += 1) {
    oneMicroPriceStep();
  }

  snapshotSessionOpen();

  refreshDetailChart();
  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();
  updateDetailPriceLine();
  renderAssetSummary();

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.querySelector(".mts-pause-label").textContent = "멈춤";
    pauseBtn.classList.remove("paused", "market-ended");
    pauseBtn.setAttribute("aria-pressed", "false");
    pauseBtn.setAttribute("aria-label", "시간 멈춤");
  }

  const { month, day } = getCalendarParts(gameDayIndex);
  addNewsItem(
    `장 개장 — ${month}월 ${day}일 09:00 (10분봉, 현실 10초마다 확정)`,
    "news"
  );

  onSessionSecondTick();
  startGameClockTimer();
  scheduleAmbientNewsTimer();

  scheduleSave();
}

function closeMarket() {
  if (isMarketClosed) return;

  if (tickInCandle > 0) {
    sealCurrentCandleAndReset();
  }

  isMarketClosed = true;
  gameMinutes = MARKET_CLOSE_MIN;
  renderDateTimeLine();

  clearGameClockTimer();
  clearAmbientNewsTimer();

  refreshDetailChart();
  renderStockListMain();
  updateDetailPriceLine();

  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close");
  setMessage("장 마감 — 다음 거래일 09:00에 개장합니다.", "ok");

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.querySelector(".mts-pause-label").textContent = "종료";
    pauseBtn.classList.add("market-ended");
  }

  flushSave();
  scheduleNextTradingDay();
}

function updatePauseButton() {
  const btn = document.getElementById("btnPause");
  if (!btn || isMarketClosed) return;
  const label = btn.querySelector(".mts-pause-label");
  if (isPaused) {
    if (label) label.textContent = "재개";
    btn.classList.add("paused");
    btn.setAttribute("aria-pressed", "true");
    btn.setAttribute("aria-label", "시간 재개");
  } else {
    if (label) label.textContent = "멈춤";
    btn.classList.remove("paused");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "시간 멈춤");
  }
}

function setPaused(paused) {
  if (isMarketClosed) return;
  isPaused = paused;
  if (isPaused) {
    clearGameClockTimer();
    clearAmbientNewsTimer();
  } else {
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }
  updatePauseButton();
  scheduleSave();
}

function setMessage(text, type = "") {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = text;
  el.className = "mts-toast" + (type ? ` ${type}` : "");
}

function renderStocks() {
  const tbody = document.getElementById("stockRows");
  if (!tbody) return;
  tbody.innerHTML = "";

  stocks.forEach((s) => {
    const tr = document.createElement("tr");
    const owned = game.holdings[s.id] ?? 0;
    const cb = game.costBasis[s.id] ?? 0;
    const avg = owned > 0 ? Math.round(cb / owned) : 0;
    const evalVal = owned * s.price;
    const pl = Math.round(evalVal - cb);
    const plCls = pl > 0 ? "chg-up" : pl < 0 ? "chg-down" : "chg-flat";

    tr.innerHTML = `
      <td>
        <span class="stock-name">${escapeHtml(s.name)}</span>
        <span class="stock-ticker">${escapeHtml(s.id)}</span>
      </td>
      <td><span data-portfolio-price="${escapeHtml(s.id)}" class="watch-price">${formatWon(s.price)}</span></td>
      <td>${owned > 0 ? formatWon(avg) : "—"}</td>
      <td>${owned.toLocaleString("ko-KR")}주</td>
      <td class="${plCls}">${owned > 0 ? `${pl >= 0 ? "+" : ""}${formatWon(pl)}` : "—"}</td>
      <td>
        <input type="number" class="qty-input" min="1" value="1" data-stock="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)} 수량" />
      </td>
      <td class="cell-actions">
        <button type="button" class="btn-mts buy" data-action="buy" data-stock="${escapeHtml(s.id)}">매수</button>
        <button type="button" class="btn-mts sell" data-action="sell" data-stock="${escapeHtml(s.id)}">매도</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-stock");
      const action = btn.getAttribute("data-action");
      const row = btn.closest("tr");
      const input = row.querySelector(".qty-input");
      const qty = input.value;

      let result;
      if (action === "buy") result = buyStock(id, qty);
      else result = sellStock(id, qty);

      if (result.ok) {
        setMessage(
          action === "buy"
            ? `${id} ${qty}주 매수 완료.`
            : `${id} ${qty}주 매도 완료.`,
          "ok"
        );
        renderAssetSummary();
        renderStocks();
        renderStockListMain();
        scheduleSave();
      } else {
        setMessage(result.reason, "err");
      }
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function initTabs() {
  const buttons = document.querySelectorAll(".tab-bar-btn");
  const panels = {
    market: document.getElementById("tab-market"),
    news: document.getElementById("tab-news"),
    portfolio: document.getElementById("tab-portfolio"),
  };

  function activate(tab) {
    if (tab !== "market") closeStockDetail();

    Object.entries(panels).forEach(([key, panel]) => {
      if (!panel) return;
      const isSel = key === tab;
      panel.classList.toggle("is-active", isSel);
      panel.hidden = !isSel;
    });
    buttons.forEach((b) => {
      const t = b.getAttribute("data-tab");
      const sel = t === tab;
      b.classList.toggle("is-active", sel);
      b.setAttribute("aria-selected", sel ? "true" : "false");
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activate(btn.getAttribute("data-tab"));
    });
  });
}

function tickStockPrices() {
  for (let i = 0; i < 220; i += 1) {
    oneMicroPriceStep();
  }
  refreshDetailChart();
  renderStockListMain();
  updateDetailPriceLine();
  renderAssetSummary();
}

function onNextTurn() {
  if (!isMarketClosed) {
    setMessage("다음 턴(1년)은 장 마감 후에만 진행할 수 있습니다.", "err");
    return;
  }
  game.age += 1;
  tickStockPrices();
  setMessage(`${game.age}세가 되었습니다. 시장 가격이 변동했습니다.`);
  renderAssetSummary();
  renderStocks();
  scheduleSave();
}

function onPauseClick() {
  setPaused(!isPaused);
}

function initNewGame() {
  gameDayIndex = 0;
  gameMinutes = MARKET_OPEN_MIN;
  isMarketClosed = false;
  isPaused = false;
  scheduledEvents = buildInitialCalendar();
  ensureCalendarHorizon();

  game.age = 25;
  game.cash = INITIAL_CAPITAL;
  game.holdings = {};
  game.costBasis = {};
  game.initialCapital = INITIAL_CAPITAL;

  stocks.forEach((s) => {
    s.price = randomInitialPrice();
    s.volatilityMod = 1;
    s.priceBias = 0;
  });

  headlineImpulse = 0;
  dividendCandleCounter = 0;
  sessionCandleCount = 0;

  initHoldings();
  resetDailyNewsState();
  clearCandleHistory();

  warmupPrices();
  snapshotSessionOpen();
}

function resumeLoadedGame() {
  ensureCalendarHorizon();
  initHoldings({ preserveBias: true });
}

function init() {
  const loaded = tryLoadGameState();

  if (!loaded) {
    initNewGame();
  } else {
    resumeLoadedGame();
  }

  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();

  if (!loaded) {
    addNewsItem(
      "시장 개장 · 현실 1초=장내 1분, 10분봉은 현실 10초마다 확정",
      "news"
    );
    onSessionSecondTick();
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  } else if (isMarketClosed) {
    scheduleNextTradingDay();
  } else if (isPaused) {
    clearGameClockTimer();
    clearAmbientNewsTimer();
  } else {
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }

  initTabs();

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", onPauseClick);
    if (isMarketClosed) {
      pauseBtn.disabled = true;
      pauseBtn.querySelector(".mts-pause-label").textContent = "종료";
      pauseBtn.classList.add("market-ended");
    } else {
      pauseBtn.disabled = false;
      pauseBtn.classList.remove("market-ended");
      updatePauseButton();
    }
  }

  renderAssetSummary();
  renderStocks();
  document.getElementById("btnNextTurn").addEventListener("click", onNextTurn);
  bindDetailTrade();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
  window.addEventListener("beforeunload", flushSave);

  if (!loaded) scheduleSave();
  else flushSave();
}

document.addEventListener("DOMContentLoaded", init);
