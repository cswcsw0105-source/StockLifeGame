/**
 * Stock Life — ApexCharts 캔들+거래량, 1초=장내 1분, 10분봉(현실 10초), 뉴스 체이닝
 * 다음 거래일 08:00~09:00 프리마켓(매매 불가) → 09:00 Net Impact 시초가 갭
 * 온라인: Supabase `market_state`(클라이언트 주도 10초 틱 + Realtime) + RPC 매매
 */
import { createClient } from "@supabase/supabase-js";

/**
 * Supabase `public` 스키마 테이블명 — `supabase/stock_life_full_setup.sql` 과 동일해야 함.
 * (구버전 name_players / name_portfolios 사용 금지)
 */
const TBL_USERS = "users";
const TBL_PORTFOLIOS = "portfolios";
const TBL_MARKET_STATE = "market_state";
const TBL_SOCIAL_TRADE = "social_trade_events";

/** 온보딩 튜토리얼 1회 완료 플래그 (브라우저 로컬) */
const LS_TUTORIAL_DONE_KEY = "stockLifeTutorialV1Done";

/** 튜토리얼 표시 중: 시계·로컬 생활 로직 정지, 시세 Realtime만 수신 */
let tutorialGateActive = false;

const MAX_NEWS_ITEMS = 48;
/** 찌라시 비율 — 화면에만 표시, 시세·페이로드(체이닝 impact 등) 반영 없음. 갭·프리마켓 카운트 로직은 변경하지 않음 */
const RUMOR_FRACTION = 0.3;
function rollIsRumor() {
  return Math.random() < RUMOR_FRACTION;
}

/** 찌라시(is_rumor) UI 위장용 — 저장·엔진 로직은 is_rumor 플래그만 사용 */
const RUMOR_DISPLAY_FAKE_TAGS = [
  "[속보]",
  "[단독]",
  "[특징주]",
  "[마감전]",
  "[긴급]",
  "[특종]",
];

function stableHashForNewsDisplay(it) {
  const key = `${it.ts || ""}|${it.gameDayIndex ?? ""}|${it.gameMinutes ?? ""}|${it.text || ""}|${it.stockId || ""}|${it.type || ""}`;
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 선행 `[태그]` 나열 제거 — 찌라시 위장 시 한 번만 일반 헤드라인 태그를 붙이기 위함 */
function stripLeadingBracketTags(s) {
  let t = String(s).trim();
  while (/^\[[^\]]+\]/.test(t)) {
    t = t.replace(/^\[[^\]]+\]\s*/, "").trimStart();
  }
  return t;
}

/**
 * 뉴스 목록·상세 표시문. `is_rumor`일 때만 텍스트를 가공하며, 원본 `it.text`는 바꾸지 않음.
 */
function newsTextForDisplay(it) {
  const raw = it?.text ?? "";
  if (!it || it.is_rumor !== true) {
    return raw;
  }
  let body = String(raw).replace(/찌라시/g, "");
  body = stripLeadingBracketTags(body);
  body = body.replace(/\s{2,}/g, " ").trim();
  const tag =
    RUMOR_DISPLAY_FAKE_TAGS[
      stableHashForNewsDisplay(it) % RUMOR_DISPLAY_FAKE_TAGS.length
    ];
  if (!body) return tag;
  return `${tag} ${body}`;
}
const NEXT_TRADING_DAY_DELAY_MS = 2200;
const INITIAL_CAPITAL = 1_000_000;
/** 게임 캘린더 매월 1일 자동 입금 */
const MONTHLY_SALARY = 1_000_000;
/** 이 금액 미만이면 급전 알바 버튼 활성(게임 규칙) */
const EMERGENCY_JOB_CASH_THRESHOLD = 1_000_000;
/** 한강 급전 알바 매매 잠금(밀리초) — DB `emergency_han_river_job` 과 동일 */
const EMERGENCY_LOCK_MS = 15 * 60 * 1000;
/** 매매 수량은 DB(bigint 등)와 맞추기 위해 항상 정수(주)만 사용 */

/** 동전주 메타 — 상장 폐지 방지 최저가(원) */
const MIN_STOCK_PRICE = 30;

/** 현실 1초 = 게임 내 1분 */
const GAME_MINUTES_PER_REAL_SEC = 1;
/** 한 봉 = 게임 시간 10분 = 현실 10초 (매초 시세 변동, 10초마다 봉 확정) */
const CANDLE_GAME_MINUTES = 10;
const TICKS_PER_CANDLE = 10;
const DIVIDEND_EVERY_CANDLES = 4;

const MARKET_OPEN_MIN = 9 * 60;
/** 정규장 종가(가격 틱·시장가 매매 종료) 15:30 */
const MARKET_REGULAR_CLOSE_MIN = 15 * 60 + 30;
/** 장 운영 종료(시간외 종료) 16:30 — 이후 다음날 프리마켓 */
const MARKET_CLOSE_MIN = 16 * 60 + 30;
/** 게임 캘린더 하루(분) — 캔들 X축 순서·기간 필터 (실시간 시계와 무관) */
const GAME_MINUTES_PER_DAY = 24 * 60;
/** 장 시작 전 대기(프리마켓) — 08:00~09:00, 시장가 불가 · 지정가 예약 가능 */
const PREMARKET_START_MIN = 8 * 60;
/** 08:00~08:50(게임분 480~529): 프리마켓 뉴스 폭격 구간 */
const PREMARKET_NEWS_END_MIN = 8 * 60 + 50;
/** 15:30~16:30 시간외 뉴스 스케줄(분) */
const AFTER_HOURS_NEWS_START_MIN = MARKET_REGULAR_CLOSE_MIN;
const AFTER_HOURS_NEWS_END_MIN = MARKET_CLOSE_MIN;
/** Net Impact 1당 전일 종가 대비 시초가 변동률(±) — 누적 뉴스로 갭 강화 */
const GAP_PCT_PER_NET_IMPACT = 0.14;
/** 09:00~15:30 정규장 = 390게임분, 10분봉 39개 */
const SESSION_GAME_MINUTES = MARKET_REGULAR_CLOSE_MIN - MARKET_OPEN_MIN;
const CANDLES_PER_SESSION = SESSION_GAME_MINUTES / CANDLE_GAME_MINUTES;

/** 온라인: 현실 10초마다 클라이언트가 리더 선출 후 DB 갱신(게임 내 10분봉 1개분과 동일) */
const ONLINE_CLIENT_TICK_MS = 10_000;
const ONLINE_STALE_AFTER_MS = 10_000;

const CANDLE_UP = "#ff4b4b";
const CANDLE_DOWN = "#3182f6";

/** 플레이어 프로필 — 캐릭터 설정 + 월급 기록(프로필 JSON 동기화) */
let playerProfile = {
  name: "",
  age: 20,
  birthday: "",
  setupComplete: false,
  /** `"2000-4"` 형태 — 해당 월 1일 월급 지급 여부 */
  lastSalaryMonthKey: "",
  /** 고배당 리츠 월별 배당(1일 1회) */
  lastReitDivMonthKey: "",
};

let gameClockEverStarted = false;
let phoneClockIntervalId = null;

let newsFeedRevealTimers = [];

/** 상세 매매: 주 단위 | 원화 금액(체결 수량은 시가로 환산) */
let detailTradeInputMode = "shares";
/** market | limit — 시장가는 정규장만, 지정가는 정규+시간외 */
let detailTradeOrderType = "market";
/** 상세 패널 미리보기: 마지막으로 누른 매수/매도 */
let lastDetailTradeAction = "buy";

/** 급전 알바 잠금 해제까지 1초 폴링 */
let tradeLockPollIntervalId = null;

/** 신규·초기화 시 시초가: 100 ~ 200원 균등 랜덤 정수(동전주) */
function randomInitialPrice() {
  return Math.floor(100 + Math.random() * 101);
}

function clampStockPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return MIN_STOCK_PRICE;
  return Math.max(MIN_STOCK_PRICE, Math.floor(n));
}

/** 구버전 market_state·손상 데이터로 NaN/누락 가격 복구 */
function repairInvalidStockPrices() {
  try {
    stocks.forEach((s) => {
      const v = Number(s?.price);
      if (!Number.isFinite(v) || v < MIN_STOCK_PRICE) {
        s.price = randomInitialPrice();
      }
    });
    syncEtfPriceFromMarket();
  } catch (e) {
    console.warn("repairInvalidStockPrices", e);
  }
}

const STOCK_SPECS = [
  {
    id: "JBD",
    name: "재빈디자인",
    desc: "크리에이티브 디자인 스튜디오.",
    price: 10_000,
    chartColor: "#ff6b6b",
  },
  {
    id: "SYW",
    name: "승윤윙즈",
    desc: "모빌리티 테크 기업.",
    price: 10_000,
    chartColor: "#f472b6",
  },
  {
    id: "MJS",
    name: "민준스테이",
    desc: "케어 서비스 플랫폼.",
    price: 10_000,
    chartColor: "#38bdf8",
  },
  {
    id: "BSL",
    name: "범서랩",
    desc: "기능성 뷰티 브랜드.",
    price: 10_000,
    chartColor: "#fb7185",
  },
  {
    id: "SYG",
    name: "석영기어",
    desc: "정밀 시스템 제조사.",
    price: 10_000,
    chartColor: "#a78bfa",
  },
  {
    id: "JWF",
    name: "진우펀드",
    desc: "자산 운용 및 투자사.",
    price: 10_000,
    chartColor: "#34d399",
  },
  {
    id: "YHL",
    name: "요한룩",
    desc: "패션 큐레이션 플랫폼.",
    price: 10_000,
    chartColor: "#fbbf24",
  },
  {
    id: "SWB",
    name: "선웅비즈",
    desc: "종합 비즈니스 솔루션 플랫폼.",
    price: 10_000,
    chartColor: "#22d3ee",
  },
  {
    id: "GDR",
    name: "고배당 리츠",
    desc: "저변동·횡보 위주. 매월 1일 보유 가치의 일부가 배당으로 지급됩니다.",
    price: 10_000,
    chartColor: "#94a3b8",
    kind: "reit",
  },
  {
    id: "MIX",
    name: "시장종합 ETF",
    desc: "일반 종목 평균가 추종. 개별 뉴스·급등락 스파이크 없음.",
    price: 10_000,
    chartColor: "#64748b",
    kind: "etf",
  },
];

let saveDebounceId = null;

let sb = null;
let onlineMode = false;
let marketChannel = null;
/** 친구 풀매수/풀매도 Realtime */
let socialTradeChannel = null;
let friendTradeToastTimer = null;
/** 온라인: 10초마다 리더 선출 → 시장 1스텝 DB 반영 (Edge 없음) */
let marketClientTickId = null;
/** 리더가 공용 시장만 시뮬할 때: 배당은 수신 시 클라이언트별 정산 */
let onlineLeaderSimulating = false;
/** 서버 newsFeed 스냅샷 — 직렬화 시 사용 */
let serverNewsFeedItems = [];
/** 이전 서버 market_state — 배당 봉 감지용 */
let lastMarketSnapshotForDividend = null;

/** 전체 화면 전환 — 한 번에 하나만 display:flex */
const SCREEN_IDS = ["screen-login", "screen-setup", "screen-tutorial", "screen-game"];

function showScreen(activeId) {
  SCREEN_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = id === activeId ? "flex" : "none";
  });
  tutorialGateActive = activeId !== "screen-game";
}

/** sessionStorage 키 — 새로고침 후에도 이름표 유지 */
const SESSION_LOGIN_NAME_KEY = "stockLifePlayerName";
/** DB `users.login_name` 과 동일(정규화된 표시 이름) */
let loginDisplayName = null;

function normalizeLoginName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function renderPlayerLoginBadge() {
  const el = document.getElementById("playerLoginBadge");
  if (!el) return;
  if (loginDisplayName) {
    el.hidden = false;
    el.textContent = `플레이어: ${loginDisplayName}`;
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

/** sessionStorage — 새로고침 시 이름표 재입력 방지 (LocalStorage 미사용) */
function restorePlayerNameFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_LOGIN_NAME_KEY);
    if (!raw) return false;
    const n = normalizeLoginName(raw);
    if (!n) return false;
    loginDisplayName = n;
    return true;
  } catch {
    return false;
  }
}

function saveSessionName(name) {
  try {
    sessionStorage.setItem(SESSION_LOGIN_NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

function clearSessionName() {
  try {
    sessionStorage.removeItem(SESSION_LOGIN_NAME_KEY);
  } catch {
    /* ignore */
  }
  loginDisplayName = null;
}

const game = {
  age: 25,
  cash: INITIAL_CAPITAL,
  holdings: {},
  costBasis: {},
  /** 손익 표시 기준(세션 시작 자본) */
  initialCapital: INITIAL_CAPITAL,
  /** 서버 `users.trade_blocked_until_ms` — 급전 알바 등(실시간 잠금) */
  tradeBlockedUntilMs: 0,
};

let gameDayIndex = 0;
let headlineImpulse = 0;
let sessionCandleCount = 0;
let dividendCandleCounter = 0;

let isMarketClosed = false;
/** 장 마감 직후 ~ 다음날 08:00 롤 전까지(짧은 대기 + 시계 정지) */
let awaitingDayRoll = false;

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

function emptyPremarketNewsCounts() {
  const o = {};
  STOCK_SPECS.forEach((s) => {
    o[s.id] = { pos: 0, neg: 0 };
  });
  return o;
}

/** 프리마켓(당일 08:00~08:50) 종목별 호재/악재 누적 — 09:00 갭에 사용 */
let premarketNewsCounts = emptyPremarketNewsCounts();
/** 당일 프리마켓 뉴스 스케줄(분 → 이벤트) — 롤오버 시 생성 */
let premarketNewsScheduleByMin = {};
/** 전일 시간외 + 당일 프리마켓 뉴스 누적(호·악) — 09:00 갭에 합산 */
let afterHoursNewsCounts = emptyPremarketNewsCounts();
/** 15:30~16:30 시간외 뉴스 스케줄(분 → 이벤트) */
let afterHoursNewsScheduleByMin = {};
/** 당일 시간외 뉴스 스케줄 생성 여부 */
let afterHoursPlanGeneratedToday = false;
/** 09:00 시초가 갭 반영 여부(하루 1회) */
let openingGapAppliedToday = false;

/** 종목별 오늘 뉴스(체이닝) 건수 — 최대 3 */
let newsCountByStock = emptyChainState();
/** 체이닝 다음 스텝 인덱스 */
let chainStepByStock = emptyChainState();

const stocks = STOCK_SPECS.map((spec) => ({
  ...spec,
}));

function stockSpecById(id) {
  return STOCK_SPECS.find((s) => s.id === id);
}
function isEtfId(id) {
  return stockSpecById(id)?.kind === "etf";
}
function isReitId(id) {
  return stockSpecById(id)?.kind === "reit";
}

/** 지정가 예약 주문 (클라이언트 + profile JSON 동기화) */
let pendingOrders = [];

/** 종목별 '진짜 뉴스' 후 급등·급락 틱 잔여 횟수(다음 시세 틱에서 소모) */
let newsSpikeTicksLeft = emptyChainState();
/** 종목별 급등(1) / 급락(-1) */
let newsSpikeDirection = Object.fromEntries(
  STOCK_SPECS.map((s) => [s.id, 1])
);
/** 극호재/극악재 등 스파이크 모드 */
let newsSpikeMode = Object.fromEntries(
  STOCK_SPECS.map((s) => [s.id, "normal"])
);

function resetNewsSpikeState() {
  newsSpikeTicksLeft = emptyChainState();
  STOCK_SPECS.forEach((s) => {
    newsSpikeDirection[s.id] = 1;
    newsSpikeMode[s.id] = "normal";
  });
}

/** 체이닝·일정 등: 페이로드 impact 부호로 방향만 쓰고, 3~5틱 급등·급락 스케줄 */
function scheduleNewsSpikeForStock(stockId, directionSign) {
  if (!getStockById(stockId) || isEtfId(stockId)) return;
  const ticks = 3 + Math.floor(Math.random() * 3);
  newsSpikeTicksLeft[stockId] = Math.max(
    newsSpikeTicksLeft[stockId] || 0,
    ticks
  );
  newsSpikeDirection[stockId] = directionSign >= 0 ? 1 : -1;
  newsSpikeMode[stockId] = "normal";
}

/** 극호재(5~10배)·극악재(~1/10) — ETF 제외, 희귀 이벤트 */
function rollExtremeNewsKnock(stockId, positive) {
  if (!getStockById(stockId) || isEtfId(stockId)) return;
  newsSpikeTicksLeft[stockId] = Math.max(newsSpikeTicksLeft[stockId] || 0, 1);
  newsSpikeDirection[stockId] = positive ? 1 : -1;
  newsSpikeMode[stockId] = positive ? "extremeBull" : "extremeBear";
}

function scheduleNewsSpikeFromImpacts(impacts) {
  if (!impacts || typeof impacts !== "object") return;
  Object.entries(impacts).forEach(([id, raw]) => {
    const imp = Number(raw);
    if (!imp || !Number.isFinite(imp)) return;
    if (isEtfId(id)) return;
    scheduleNewsSpikeForStock(id, imp > 0 ? 1 : -1);
  });
}

/** 종목별 10분봉 시퀀스 (날짜 누적, 장 마감 후에도 유지) */
const candleHistory = Object.fromEntries(
  STOCK_SPECS.map((s) => [s.id, []])
);

/** 상세 화면 캔들/거래량 차트만 사용 */
const apexDetail = { candle: null, vol: null, stockId: null, chartRange: "all" };

let selectedStockId = null;
/** 상세 차트 기간: all | d2 | d5 | w1 | m1 */
let detailChartRange = "all";
/** 종목 상세 현재가 표시 직전 가격(틱 애니메이션) */
let detailLastShownPrice = null;

/** 관심 종목 티커 — 뉴스 가중치에 사용 */
let watchlistIds = [];

function GAME_ANCHOR_DATE() {
  return new Date(2000, 3, 1);
}

function dayIndexToDate(dayIndex) {
  const d = new Date(GAME_ANCHOR_DATE());
  d.setDate(d.getDate() + dayIndex);
  return d;
}

function dateToDayIndex(date) {
  const a = GAME_ANCHOR_DATE();
  return Math.round((date - a) / 86400000);
}

function getMonthContextForDayIndex(dayIndex) {
  const d = dayIndexToDate(dayIndex);
  const y = d.getFullYear();
  const mo = d.getMonth();
  const first = new Date(y, mo, 1);
  const last = new Date(y, mo + 1, 0);
  const startIdx = dateToDayIndex(first);
  const daysInMonth = last.getDate();
  const padSun = first.getDay();
  const monthKey = `${y}-${mo + 1}`;
  return { y, m: mo + 1, startIdx, daysInMonth, padSun, monthKey };
}

function formatShares(q) {
  const n = Math.floor(Number(q));
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

function isTradeBlockedByPenalty() {
  const until = game.tradeBlockedUntilMs || 0;
  return until > 0 && Date.now() < until;
}

function ensureTradeLockPolling() {
  if (!game.tradeBlockedUntilMs || Date.now() >= game.tradeBlockedUntilMs) {
    if (tradeLockPollIntervalId) {
      clearInterval(tradeLockPollIntervalId);
      tradeLockPollIntervalId = null;
    }
    return;
  }
  if (tradeLockPollIntervalId) return;
  tradeLockPollIntervalId = setInterval(() => {
    syncTradeButtons();
    updateDetailTradeLivePreview();
    renderLifeTab();
    if (!game.tradeBlockedUntilMs || Date.now() >= game.tradeBlockedUntilMs) {
      clearInterval(tradeLockPollIntervalId);
      tradeLockPollIntervalId = null;
      syncTradeButtons();
    }
  }, 1000);
}

function maybeApplyMonthlySalary() {
  const { day } = getCalendarParts(gameDayIndex);
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  if (day !== 1) return;
  if (playerProfile.lastSalaryMonthKey !== mk) {
    game.cash += MONTHLY_SALARY;
    playerProfile.lastSalaryMonthKey = mk;
    addNewsItem(`월급 입금 ${formatWon(MONTHLY_SALARY)} (매월 1일 자동)`, "salary", "", {
      global: true,
    });
    setMessage(`월급 ${formatWon(MONTHLY_SALARY)}이 입금되었습니다.`, "ok");
    schedulePersistUser();
  }
  maybeApplyReitMonthlyDividend();
}

const REIT_MONTHLY_DIVIDEND_RATE = 0.03;

function maybeApplyReitMonthlyDividend() {
  const { day } = getCalendarParts(gameDayIndex);
  if (day !== 1) return;
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  if (playerProfile.lastReitDivMonthKey === mk) return;
  playerProfile.lastReitDivMonthKey = mk;
  const q = Math.max(0, Math.floor(Number(game.holdings.GDR ?? 0)));
  if (q <= 0) {
    schedulePersistUser();
    return;
  }
  const s = getStockById("GDR");
  if (!s) return;
  const val = q * s.price;
  const div = Math.round(val * REIT_MONTHLY_DIVIDEND_RATE);
  if (div <= 0) return;
  game.cash += div;
  addNewsItem(
    `[고배당 리츠] 월 배당 ${formatWon(div)} (보유 가치의 ${(REIT_MONTHLY_DIVIDEND_RATE * 100).toFixed(0)}%)`,
    "dividend",
    "",
    { stockId: "GDR", global: true }
  );
  schedulePersistUser();
}

function matchesMainNewsFilter(it) {
  if (!it || it.global) return true;
  if (!it.stockId) return false;
  const hold = (game.holdings[it.stockId] ?? 0) > 0;
  const watch = watchlistIds.includes(it.stockId);
  return hold || watch;
}

function syncTradeButtons() {
  const canMarket =
    isRegularSession() && !isTradeBlockedByPenalty();
  const canLimit =
    isLimitOrderWindowAllowed() && !isTradeBlockedByPenalty();
  ["detailBtnBuy", "detailBtnSell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !canMarket;
      el.classList.toggle("is-trade-locked", !canMarket);
    }
  });
  document.querySelectorAll("#stockRows button[data-action]").forEach((btn) => {
    btn.disabled = !canTrade;
    btn.classList.toggle("is-trade-locked", !canTrade);
  });
}

function renderLifeStatus() {
  renderProfileDisplay();
  renderLifeTab();
}

/** 다음날 08:00 프리마켓 진입 직후 UI (시초가 갭은 09:00에 적용) */
function finishRollToPreMarketDay() {
  refreshDetailChart();
  renderDateTimeLine();
  updatePremarketChartOverlay();
  renderCalendarUI();
  renderStockListMain();
  updateDetailPriceLine();
  renderAssetSummary();
  renderLifeStatus();

  const { month, day } = getCalendarParts(gameDayIndex);
  addNewsItem(
    `${month}월 ${day}일 08:00 — 장 시작 전 · 프리마켓 뉴스를 확인하세요 (09:00 시초가 갭)`,
    "news",
    "",
    { global: true }
  );

  if (!onlineMode) {
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }

  schedulePersistUser();
  syncNextTurnButton();
  syncTradeButtons();
}

function isTutorialDone() {
  try {
    return localStorage.getItem(LS_TUTORIAL_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 튜토리얼 숙지 후 게임 화면 + 시계 시작 */
function proceedAfterTutorialGate() {
  try {
    localStorage.setItem(LS_TUTORIAL_DONE_KEY, "1");
  } catch {
    /* ignore */
  }
  showScreen("screen-game");
  startGameClockFromInit(false);
}

function bindTutorialUiOnce() {
  const root = document.getElementById("screen-tutorial");
  const btn = document.getElementById("btnTutorialDismiss");
  if (!root || !btn || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  let dismissed = false;
  const go = (e) => {
    if (dismissed) return;
    e.preventDefault();
    e.stopPropagation();
    dismissed = true;
    proceedAfterTutorialGate();
  };
  btn.addEventListener("click", go);
  btn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      go(e);
    },
    { passive: false }
  );
}

/** 로그인 직후·세션 복구 후: 설정 → 튜토리얼 → 게임 순으로 분기 */
function routeOnboardingScreens() {
  populateSetupForm();
  if (!playerProfile.setupComplete) {
    showScreen("screen-setup");
    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    syncNextTurnButton();
    requestAnimationFrame(() => document.getElementById("setupPlayerName")?.focus());
    return;
  }
  if (!isTutorialDone()) {
    showScreen("screen-tutorial");
    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    syncNextTurnButton();
    requestAnimationFrame(() => document.getElementById("btnTutorialDismiss")?.focus());
    return;
  }
  showScreen("screen-game");
  renderAssetSummary();
  renderLifeStatus();
  renderStocks();
  syncTradeButtons();
  syncNextTurnButton();
  startGameClockFromInit(false);
}

function renderLifeTab() {
  const salaryEl = document.getElementById("lifeSalaryInfo");
  const lockEl = document.getElementById("lifeTradeLockHint");
  const btn = document.getElementById("btnEmergencyHanRiver");
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  if (salaryEl) {
    salaryEl.textContent = `매월 1일 자동 입금 ${formatWon(
      MONTHLY_SALARY
    )} · 이번 달 키: ${ctx.monthKey}`;
  }
  const blocked = isTradeBlockedByPenalty();
  if (lockEl) {
    if (blocked && game.tradeBlockedUntilMs) {
      const left = Math.max(0, game.tradeBlockedUntilMs - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      lockEl.hidden = false;
      lockEl.textContent = `매매 잠금 중 · 약 ${m}분 ${s}초 남음 (차트·호가는 실시간)`;
    } else {
      lockEl.hidden = true;
      lockEl.textContent = "";
    }
  }
  if (btn) {
    const poor = game.cash < EMERGENCY_JOB_CASH_THRESHOLD;
    btn.disabled = !onlineMode || !sb || !loginDisplayName || blocked || !poor;
    btn.title = !poor
      ? `예수금이 ${formatWon(EMERGENCY_JOB_CASH_THRESHOLD)} 미만일 때 이용할 수 있습니다.`
      : blocked
        ? "잠금이 풀린 뒤 이용할 수 있습니다."
        : "급전을 받고 일정 시간 매매가 제한됩니다.";
  }
}

async function onEmergencyHanRiverClick() {
  if (!onlineMode || !sb || !loginDisplayName) {
    setMessage("Supabase 연결이 필요합니다.", "err");
    return;
  }
  if (isTradeBlockedByPenalty()) {
    setMessage("이미 매매 잠금 중입니다.", "err");
    return;
  }
  if (game.cash >= EMERGENCY_JOB_CASH_THRESHOLD) {
    setMessage("예수금이 충분할 때는 이용할 수 없습니다.", "err");
    return;
  }
  const { data, error } = await sb.rpc("emergency_han_river_job", {
    p_login_name: loginDisplayName,
  });
  if (error) {
    setMessage(error.message || "급전 요청 실패", "err");
    return;
  }
  if (!data?.ok) {
    setMessage(data?.reason || "급전 실패", "err");
    return;
  }
  game.cash = Number(data.cash);
  game.tradeBlockedUntilMs = Number(data.trade_blocked_until_ms) || 0;
  renderAssetSummary();
  schedulePersistUser();
  syncTradeButtons();
  ensureTradeLockPolling();
  renderLifeTab();
  addNewsItem(
    `한강물 온도 재기 알바 완료 · 급전 ${formatWon(
      Number(data.bonus) || 0
    )} 입금. ${Math.round(EMERGENCY_LOCK_MS / 60000)}분간 매매가 제한됩니다.`,
    "life",
    "",
    { global: true }
  );
  setMessage(
    `급전 입금 · ${Math.round(EMERGENCY_LOCK_MS / 60000)}분간 매매가 잠깁니다. 차트는 계속 확인하세요.`,
    "ok"
  );
}

function bindLifeUi() {
  const btn = document.getElementById("btnEmergencyHanRiver");
  if (btn && btn.dataset.bound !== "1") {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      onEmergencyHanRiverClick().catch((e) => console.warn(e));
    });
  }
  renderLifeTab();
}

/** @deprecated 호환용 — 탭 전환 시 동일 */
function renderJobScheduleUi() {
  renderLifeTab();
}

// ----- Supabase: 유저 동기화 (LocalStorage 제거) -----

/**
 * 이름표로 `users` 조회 — 없으면 초기값 Insert 후 로드
 * (Supabase public.users / public.portfolios)
 */
async function loginOrRegisterPlayer(rawName) {
  if (!sb) return { ok: false, reason: "연결되지 않았습니다." };
  const nm = normalizeLoginName(rawName);
  if (!nm) {
    return { ok: false, reason: "이름을 입력해 주세요." };
  }
  loginDisplayName = nm;

  const { data: existing, error: selErr } = await sb
    .from(TBL_USERS)
    .select("login_name")
    .eq("login_name", nm)
    .maybeSingle();
  if (selErr) {
    console.warn(selErr);
    return { ok: false, reason: selErr.message || "조회에 실패했습니다." };
  }

  if (!existing) {
    const { error: insErr } = await sb.from(TBL_USERS).insert({
      login_name: nm,
      cash: INITIAL_CAPITAL,
      hp: 100,
      stress: 0,
      sim_age: 25,
      trade_blocked_until_ms: 0,
      initial_capital: INITIAL_CAPITAL,
      profile: {},
    });
    if (insErr) {
      if (insErr.code !== "23505") {
        return { ok: false, reason: insErr.message || "가입에 실패했습니다." };
      }
    }
  }

  saveSessionName(nm);
  await loadUserFromServer();
  return { ok: true };
}

/** 로그인 직후 `users` 행이 반드시 있어야 할 때 (insert 경합 등) */
async function ensureUserRowExists(nm) {
  if (!sb || !nm) return;
  const { data: row } = await sb
    .from(TBL_USERS)
    .select("login_name")
    .eq("login_name", nm)
    .maybeSingle();
  if (row) return;
  const { error } = await sb.from(TBL_USERS).insert({
    login_name: nm,
    cash: INITIAL_CAPITAL,
    hp: 100,
    stress: 0,
    sim_age: 25,
    trade_blocked_until_ms: 0,
    initial_capital: INITIAL_CAPITAL,
    profile: {},
  });
  if (error && error.code !== "23505") {
    console.warn("ensureUserRowExists", error);
  }
}

async function loadUserFromServer() {
  if (!sb || !loginDisplayName) return;
  const nm = loginDisplayName;
  let { data: row, error } = await sb
    .from(TBL_USERS)
    .select("*")
    .eq("login_name", nm)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      await ensureUserRowExists(nm);
      const again = await sb
        .from(TBL_USERS)
        .select("*")
        .eq("login_name", nm)
        .single();
      row = again.data;
      error = again.error;
    } else {
      console.warn("loadUserFromServer", error);
      return;
    }
  }
  if (!row) {
    console.warn("loadUserFromServer: users 행 없음", nm);
    return;
  }
  game.age = row.sim_age ?? 25;
  game.cash = Number(row.cash);
  game.initialCapital = Number(row.initial_capital) || INITIAL_CAPITAL;
  game.tradeBlockedUntilMs = Number(row.trade_blocked_until_ms) || 0;

  const prof = row.profile && typeof row.profile === "object" ? row.profile : {};
  playerProfile.name = typeof prof.name === "string" ? prof.name : nm;
  playerProfile.age = typeof prof.age === "number" ? prof.age : 20;
  playerProfile.birthday = typeof prof.birthday === "string" ? prof.birthday : "";
  playerProfile.setupComplete = !!prof.setupComplete;
  playerProfile.lastSalaryMonthKey =
    typeof prof.lastSalaryMonthKey === "string" ? prof.lastSalaryMonthKey : "";
  if (!playerProfile.lastSalaryMonthKey) {
    playerProfile.lastSalaryMonthKey =
      getMonthContextForDayIndex(gameDayIndex).monthKey;
  }
  playerProfile.lastReitDivMonthKey =
    typeof prof.lastReitDivMonthKey === "string" ? prof.lastReitDivMonthKey : "";
  pendingOrders = Array.isArray(prof.pendingOrders)
    ? prof.pendingOrders.filter(
        (o) =>
          o &&
          typeof o.id === "string" &&
          typeof o.symbol === "string" &&
          STOCK_SPECS.some((s) => s.id === o.symbol) &&
          (o.side === "buy" || o.side === "sell") &&
          Number.isFinite(Number(o.limitPrice)) &&
          Number.isFinite(Number(o.qty))
      )
    : [];
  watchlistIds = Array.isArray(prof.watchlist)
    ? prof.watchlist.filter((id) => STOCK_SPECS.some((s) => s.id === id))
    : [];

  const { data: ports } = await sb
    .from(TBL_PORTFOLIOS)
    .select("*")
    .eq("login_name", nm);
  game.holdings = {};
  game.costBasis = {};
  STOCK_SPECS.forEach((spec) => {
    game.holdings[spec.id] = 0;
    game.costBasis[spec.id] = 0;
  });
  (ports || []).forEach((p) => {
    game.holdings[p.symbol] = Math.max(0, Math.floor(Number(p.shares)));
    game.costBasis[p.symbol] = Number(p.avg_cost);
  });
  renderPlayerLoginBadge();
  renderJobScheduleUi();
  ensureTradeLockPolling();
  maybeApplyMonthlySalary();
  renderNewsFeedFromServer(serverNewsFeedItems);
}

function maybePayDividendFromServerTick(prev, next) {
  if (!prev || !next) return;
  const a = prev.dividendCandleCounter ?? 0;
  const b = next.dividendCandleCounter ?? 0;
  if (b > a && b % DIVIDEND_EVERY_CANDLES === 0) {
    payDividends();
    schedulePersistUser();
  }
}

function clearNewsFeedRevealTimers() {
  newsFeedRevealTimers.forEach((id) => clearTimeout(id));
  newsFeedRevealTimers = [];
}

function appendStockNewsTags(container, stockId) {
  if (!stockId || !container) return;
  if (watchlistIds.includes(stockId)) {
    const tag = document.createElement("span");
    tag.className = "news-stock-tag news-tag-fav";
    tag.textContent = "[관심]";
    container.appendChild(tag);
  }
  if ((game.holdings[stockId] ?? 0) > 0) {
    const tag = document.createElement("span");
    tag.className = "news-stock-tag news-tag-own";
    tag.textContent = "[보유]";
    container.appendChild(tag);
  }
}

function renderNewsFeedFromServer(items) {
  const list = document.getElementById("newsFeed");
  if (!list || !Array.isArray(items)) return;
  clearNewsFeedRevealTimers();
  list.innerHTML = "";
  const arr = items
    .filter(matchesMainNewsFilter)
    .sort((a, b) => newsItemSortKey(b) - newsItemSortKey(a))
    .slice(0, MAX_NEWS_ITEMS);
  arr.forEach((it) => {
    const li = document.createElement("li");
    li.className = `news-item news-${it.type || "news"}`;
    if (it.stockId) li.dataset.stockId = it.stockId;
    const timeEl = document.createElement("span");
    timeEl.className = "news-time";
    timeEl.textContent = newsItemDisplayTime(it);
    const body = document.createElement("span");
    body.className = "news-item-body";
    const tagWrap = document.createElement("span");
    tagWrap.className = "news-stock-tags";
    appendStockNewsTags(tagWrap, it.stockId);
    if (tagWrap.childNodes.length > 0) body.appendChild(tagWrap);
    const textEl = document.createElement("span");
    textEl.className = "news-text";
    textEl.textContent = newsTextForDisplay(it);
    body.appendChild(textEl);
    li.appendChild(timeEl);
    li.appendChild(body);
    list.appendChild(li);
  });
  if (selectedStockId) renderDetailStockNewsSection();
}

function applyServerMarketState(m) {
  if (!m || m.initialized === false) return;
  try {
  const prev = lastMarketSnapshotForDividend;
  if (!tutorialGateActive) {
    maybePayDividendFromServerTick(prev, m);
  }
  lastMarketSnapshotForDividend = JSON.parse(JSON.stringify(m));

  gameDayIndex = m.gameDayIndex ?? 0;
  maybeApplyMonthlySalary();
  gameMinutes = m.gameMinutes ?? MARKET_OPEN_MIN;
  awaitingDayRoll = !!m.awaitingDayRoll;
  const gm0 = m.gameMinutes ?? MARKET_OPEN_MIN;
  if (m.awaitingDayRoll === undefined && m.isMarketClosed && gm0 >= MARKET_CLOSE_MIN) {
    awaitingDayRoll = true;
  }
  isMarketClosed = awaitingDayRoll;

  premarketNewsCounts = emptyPremarketNewsCounts();
  if (m.premarketNewsCounts && typeof m.premarketNewsCounts === "object") {
    STOCK_SPECS.forEach((spec) => {
      const p = m.premarketNewsCounts[spec.id];
      if (p && typeof p.pos === "number" && typeof p.neg === "number") {
        premarketNewsCounts[spec.id] = { pos: p.pos, neg: p.neg };
      }
    });
  }
  premarketNewsScheduleByMin =
    m.premarketNewsScheduleByMin && typeof m.premarketNewsScheduleByMin === "object"
      ? { ...m.premarketNewsScheduleByMin }
      : {};
  openingGapAppliedToday =
    typeof m.openingGapAppliedToday === "boolean"
      ? m.openingGapAppliedToday
      : gm0 < MARKET_OPEN_MIN
        ? false
        : true;
  headlineImpulse = m.headlineImpulse ?? 0;
  nextCalendarEventId = m.nextCalendarEventId ?? 1;
  scheduledEvents = Array.isArray(m.scheduledEvents) ? m.scheduledEvents : [];
  newsCountByStock = { ...emptyChainState(), ...m.newsCountByStock };
  chainStepByStock = { ...emptyChainState(), ...m.chainStepByStock };
  if (m.newsSpikeTicksLeft && typeof m.newsSpikeTicksLeft === "object") {
    STOCK_SPECS.forEach((spec) => {
      const v = m.newsSpikeTicksLeft[spec.id];
      newsSpikeTicksLeft[spec.id] =
        typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    });
  }
  if (m.newsSpikeDirection && typeof m.newsSpikeDirection === "object") {
    STOCK_SPECS.forEach((spec) => {
      const v = m.newsSpikeDirection[spec.id];
      newsSpikeDirection[spec.id] = v === -1 ? -1 : 1;
    });
  }
  if (m.newsSpikeMode && typeof m.newsSpikeMode === "object") {
    STOCK_SPECS.forEach((spec) => {
      const v = m.newsSpikeMode[spec.id];
      newsSpikeMode[spec.id] =
        v === "extremeBull" || v === "extremeBear" ? v : "normal";
    });
  }
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  if (m.afterHoursNewsCounts && typeof m.afterHoursNewsCounts === "object") {
    STOCK_SPECS.forEach((spec) => {
      const p = m.afterHoursNewsCounts[spec.id];
      if (p && typeof p.pos === "number" && typeof p.neg === "number") {
        afterHoursNewsCounts[spec.id] = { pos: p.pos, neg: p.neg };
      }
    });
  }
  afterHoursNewsScheduleByMin =
    m.afterHoursNewsScheduleByMin &&
    typeof m.afterHoursNewsScheduleByMin === "object"
      ? { ...m.afterHoursNewsScheduleByMin }
      : {};
  afterHoursPlanGeneratedToday =
    typeof m.afterHoursPlanGeneratedToday === "boolean"
      ? m.afterHoursPlanGeneratedToday
      : false;
  dividendCandleCounter = m.dividendCandleCounter ?? 0;
  sessionCandleCount = m.sessionCandleCount ?? 0;
  tickInCandle = m.tickInCandle ?? 0;
  candlePeriodStartMin = m.candlePeriodStartMin ?? MARKET_OPEN_MIN;

  const stockRowsById = new Map();
  (m.stocks || []).forEach((row) => {
    if (!row || typeof row.id !== "string") return;
    stockRowsById.set(row.id, row);
  });
  STOCK_SPECS.forEach((spec) => {
    const s = getStockById(spec.id);
    if (!s) return;
    const row = stockRowsById.get(spec.id);
    if (!row) {
      s.price = randomInitialPrice();
      return;
    }
    const px = Number(row.price);
    if (!Number.isFinite(px) || px < MIN_STOCK_PRICE) {
      s.price = randomInitialPrice();
    } else {
      s.price = clampStockPrice(px);
    }
  });
  repairInvalidStockPrices();

  STOCK_SPECS.forEach((spec) => {
    const id = spec.id;
    candleHistory[id] = Array.isArray(m.candleHistory?.[id])
      ? m.candleHistory[id].map((r) => normalizeCandleRow({ ...r }))
      : [];
  });

  Object.keys(sessionOpenPrice).forEach((k) => delete sessionOpenPrice[k]);
  Object.assign(sessionOpenPrice, m.sessionOpenPrice || {});
  stocks.forEach((s) => {
    prevTickPrice[s.id] = s.price;
  });

  if (m.candleOhlcBuffer && typeof m.candleOhlcBuffer === "object") {
    candleOhlcBuffer = {};
    stocks.forEach((s) => {
      const b = m.candleOhlcBuffer[s.id];
      const o = b != null ? Number(b.o) : NaN;
      const h = b != null ? Number(b.h) : NaN;
      const l = b != null ? Number(b.l) : NaN;
      if (
        b &&
        Number.isFinite(o) &&
        Number.isFinite(h) &&
        Number.isFinite(l)
      ) {
        candleOhlcBuffer[s.id] = {
          o: clampStockPrice(o),
          h: clampStockPrice(h),
          l: clampStockPrice(l),
        };
      } else {
        candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
      }
    });
  } else {
    candleOhlcBuffer = {};
    stocks.forEach((s) => {
      candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
    });
  }

  serverNewsFeedItems = Array.isArray(m.newsFeed)
    ? m.newsFeed
        .map((it) => ({
          ts: it.ts || new Date().toISOString(),
          text: it.text || "",
          type: it.type || "news",
          stockId: it.stockId,
          global: it.global === true,
          subline: it.subline,
          is_rumor: it.is_rumor === true,
          gameDayIndex:
            typeof it.gameDayIndex === "number" ? it.gameDayIndex : undefined,
          gameMinutes:
            typeof it.gameMinutes === "number" ? it.gameMinutes : undefined,
          gameTimeOrdinal:
            typeof it.gameTimeOrdinal === "number"
              ? it.gameTimeOrdinal
              : undefined,
        }))
        .slice(0, MAX_NEWS_ITEMS)
    : [];
  renderNewsFeedFromServer(serverNewsFeedItems);
  renderJobScheduleUi();
  updatePremarketChartOverlay();
  syncTradeButtons();
  syncNextTurnButton();
  } catch (e) {
    console.warn("applyServerMarketState", e);
    repairInvalidStockPrices();
  }
}

/** 온보딩(캐릭터 미완료)·튜토리얼·로그인 전: 시장 관련 토스트 숨김 */
function shouldSuppressMarketToast() {
  if (!loginDisplayName) return true;
  if (!playerProfile.setupComplete) return true;
  return tutorialGateActive;
}

/** DB에 행이 없거나 state가 비어 있을 때: 현재 클라이언트 시장 스냅샷(동전주 초기화 직후 initNewGame 기준)을 upsert */
async function seedMarketStateFromCurrentClient(options = {}) {
  const silent = options.silent === true;
  if (!sb) return false;
  const stateObj = serializeMarketState();
  const { error } = await sb.from(TBL_MARKET_STATE).upsert(
    { id: 1, state: stateObj },
    { onConflict: "id" }
  );
  if (error) {
    console.warn("seedMarketStateFromCurrentClient", error);
    if (!silent && !shouldSuppressMarketToast()) {
      setMessage(
        "시장 초기 저장에 실패했습니다. Supabase에서 market_state에 대한 INSERT 권한(RLS)을 확인하세요.",
        "err"
      );
    }
    return false;
  }
  applyServerMarketState(stateObj);
  if (!silent && !shouldSuppressMarketToast()) {
    setMessage("시장 데이터가 없어 동전주(100~200원) 초기 세팅을 저장했습니다.", "ok");
  }
  return true;
}

function shouldSeedMarketState(serverState) {
  if (serverState == null) return true;
  if (typeof serverState !== "object") return true;
  if (serverState.initialized === false) return true;
  const rows = serverState.stocks;
  if (!Array.isArray(rows) || rows.length === 0) {
    return true;
  }
  const byId = new Map();
  rows.forEach((row) => {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  });
  if (byId.size < STOCK_SPECS.length) {
    return true;
  }
  for (let i = 0; i < STOCK_SPECS.length; i += 1) {
    const spec = STOCK_SPECS[i];
    const row = byId.get(spec.id);
    if (!row) return true;
    const px = Number(row.price);
    if (!Number.isFinite(px) || px < MIN_STOCK_PRICE) {
      return true;
    }
  }
  return false;
}

/**
 * users 행이 있고 캐릭터 설정 완료 후에 호출하는 것이 안전(RLS·시드).
 * options.silent: true면 성공/실패 토스트 없음(온보딩·튜토리얼 중).
 */
async function fetchMarketOnce(options = {}) {
  const silent = options.silent === true || shouldSuppressMarketToast();
  if (!sb) return;
  const { data, error } = await sb
    .from(TBL_MARKET_STATE)
    .select("state")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("fetchMarketOnce", error);
    if (!silent) {
      setMessage("시장 데이터를 불러오지 못했습니다. Edge Function·DB를 확인하세요.", "err");
    }
    return;
  }
  const raw = data?.state;
  if (!data || shouldSeedMarketState(raw)) {
    await seedMarketStateFromCurrentClient({ silent });
    return;
  }
  applyServerMarketState(raw);
}

/** 로그인·캐릭터 생성 완료 후에만 시장 fetch/시드 (빈 DB 깡통 접속 시 온보딩 중 에러 방지) */
async function tryFetchSeedMarketOnce(options = {}) {
  if (!sb || !onlineMode) return;
  if (!loginDisplayName || !playerProfile.setupComplete) return;
  await fetchMarketOnce(options);
}

function clearMarketClientTick() {
  if (marketClientTickId) {
    clearInterval(marketClientTickId);
    marketClientTickId = null;
  }
}

function serializeMarketState() {
  const ch = {};
  STOCK_SPECS.forEach((spec) => {
    ch[spec.id] = (candleHistory[spec.id] || []).map((r) => ({ ...r }));
  });
  return {
    initialized: true,
    gameDayIndex,
    gameMinutes,
    isMarketClosed: awaitingDayRoll,
    awaitingDayRoll,
    premarketNewsCounts: JSON.parse(JSON.stringify(premarketNewsCounts)),
    premarketNewsScheduleByMin: { ...premarketNewsScheduleByMin },
    openingGapAppliedToday,
    headlineImpulse,
    nextCalendarEventId,
    scheduledEvents: JSON.parse(JSON.stringify(scheduledEvents)),
    newsCountByStock: { ...newsCountByStock },
    chainStepByStock: { ...chainStepByStock },
    newsSpikeTicksLeft: { ...newsSpikeTicksLeft },
    newsSpikeDirection: { ...newsSpikeDirection },
    newsSpikeMode: { ...newsSpikeMode },
    afterHoursNewsCounts: JSON.parse(JSON.stringify(afterHoursNewsCounts)),
    afterHoursNewsScheduleByMin: { ...afterHoursNewsScheduleByMin },
    afterHoursPlanGeneratedToday,
    dividendCandleCounter,
    sessionCandleCount,
    tickInCandle,
    candlePeriodStartMin,
    stocks: stocks.map((s) => ({
      id: s.id,
      price: s.price,
    })),
    candleHistory: ch,
    sessionOpenPrice: { ...sessionOpenPrice },
    candleOhlcBuffer: JSON.parse(JSON.stringify(candleOhlcBuffer)),
    newsFeed: serverNewsFeedItems.slice(0, MAX_NEWS_ITEMS).map((it) => ({
      ts: it.ts,
      text: it.text,
      type: it.type,
      stockId: it.stockId,
      global: it.global === true,
      subline: it.subline,
      is_rumor: it.is_rumor === true,
      gameDayIndex: it.gameDayIndex,
      gameMinutes: it.gameMinutes,
      gameTimeOrdinal: it.gameTimeOrdinal,
    })),
  };
}

function advanceOneGameMinuteOnline() {
  if (awaitingDayRoll) return;

  if (gameMinutes < MARKET_OPEN_MIN) {
    releasePremarketNewsForMinute(gameMinutes);
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    if (gameMinutes === MARKET_OPEN_MIN) {
      applyOpeningGapFromPremarket();
    }
    processPendingOrdersMatch();
    return;
  }

  if (gameMinutes === MARKET_OPEN_MIN && !openingGapAppliedToday) {
    applyOpeningGapFromPremarket();
  }

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarketOnline();
    return;
  }

  if (gameMinutes >= MARKET_OPEN_MIN && gameMinutes < MARKET_REGULAR_CLOSE_MIN) {
    beginCandlePeriodIfNeeded();
    oneMicroPriceStep();
    stocks.forEach((s) => {
      const b = candleOhlcBuffer[s.id];
      if (b) {
        const px = Number(s.price);
        const p = Number.isFinite(px) ? px : MIN_STOCK_PRICE;
        const bh = Number(b.h);
        const bl = Number(b.l);
        b.h = Number.isFinite(bh) ? Math.max(bh, p) : p;
        b.l = Number.isFinite(bl) ? Math.min(bl, p) : p;
      }
    });
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    tickInCandle += 1;
    if (tickInCandle >= TICKS_PER_CANDLE) {
      sealCurrentCandleAndReset();
    }
    processPendingOrdersMatch();
    if (gameMinutes >= MARKET_CLOSE_MIN) {
      closeMarketOnline();
    }
    return;
  }

  if (isAfterHoursSession()) {
    if (gameMinutes === MARKET_REGULAR_CLOSE_MIN) {
      if (tickInCandle > 0) {
        sealCurrentCandleAndReset();
      }
      if (!afterHoursPlanGeneratedToday) {
        generateAfterHoursNewsPlan();
        afterHoursPlanGeneratedToday = true;
      }
    }
    releaseAfterHoursNewsForMinute(gameMinutes);
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    processPendingOrdersMatch();
    if (gameMinutes >= MARKET_CLOSE_MIN) {
      closeMarketOnline();
    }
  }
}

function closeMarketOnline() {
  if (awaitingDayRoll) return;
  if (tickInCandle > 0) {
    sealCurrentCandleAndReset();
  }
  awaitingDayRoll = true;
  isMarketClosed = true;
  gameMinutes = MARKET_CLOSE_MIN;
  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close", "", {
    global: true,
  });
  syncNextTurnButton();
}

function openNextTradingDayOnline() {
  gameDayIndex += 1;
  awaitingDayRoll = false;
  isMarketClosed = false;
  gameMinutes = PREMARKET_START_MIN;
  tickInCandle = 0;
  candlePeriodStartMin = MARKET_OPEN_MIN;
  candleOhlcBuffer = {};
  headlineImpulse *= 0.4;
  resetDailyNewsState();
  generatePremarketNewsPlan();
  dividendCandleCounter = 0;
  afterHoursPlanGeneratedToday = false;
  resetNewsSpikeState();
  ensureCalendarHorizon();
  fireDueCalendarEvents();
  maybeApplyMonthlySalary();
  const { month, day } = getCalendarParts(gameDayIndex);
  addNewsItem(
    `${month}월 ${day}일 08:00 — 장 시작 전 · 프리마켓 뉴스를 확인하세요`,
    "news",
    "",
    { global: true }
  );
  syncNextTurnButton();
  syncTradeButtons();
}

async function pushMarketStateIfMatch(expectedUpdatedAt, stateObj) {
  if (!sb) return false;
  const { data, error } = await sb
    .from(TBL_MARKET_STATE)
    .update({
      state: stateObj,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .eq("updated_at", expectedUpdatedAt)
    .select("id");
  if (error) {
    console.warn("pushMarketStateIfMatch", error);
    await fetchMarketOnce();
    return false;
  }
  if (!data || data.length === 0) {
    await fetchMarketOnce();
    return false;
  }
  return true;
}

async function maybeAdvanceOnlineMarketAsLeader() {
  if (!onlineMode || !sb || tutorialGateActive || !gameClockEverStarted) return;
  try {
    const { data, error } = await sb
      .from(TBL_MARKET_STATE)
      .select("state, updated_at")
      .eq("id", 1)
      .single();
    if (error || !data) {
      console.warn("maybeAdvance fetch", error);
      return;
    }
    const st = data.state;
    const prevAt = data.updated_at;
    const ageMs = Date.now() - new Date(prevAt).getTime();
    const initialized = st && st.initialized !== false;
    if (initialized) {
      applyServerMarketState(st);
    }
    const stale = !initialized || ageMs >= ONLINE_STALE_AFTER_MS;
    if (!stale) return;

    onlineLeaderSimulating = true;
    try {
      if (!initialized) {
        const m = serializeMarketState();
        m.initialized = true;
        await pushMarketStateIfMatch(prevAt, m);
        renderDateTimeLine();
        renderCalendarUI();
        renderStockListMain();
        refreshDetailChart();
        updateDetailPriceLine();
        renderAssetSummary();
        syncNextTurnButton();
        reflowGameScreenUi();
        return;
      }
      if (awaitingDayRoll) {
        openNextTradingDayOnline();
      } else {
        for (let i = 0; i < 10; i += 1) {
          if (awaitingDayRoll) break;
          advanceOneGameMinuteOnline();
          if (awaitingDayRoll) break;
        }
      }
      const m = serializeMarketState();
      m.initialized = true;
      await pushMarketStateIfMatch(prevAt, m);
    } finally {
      onlineLeaderSimulating = false;
    }

    renderDateTimeLine();
    renderCalendarUI();
    renderStockListMain();
    refreshDetailChart();
    updateDetailPriceLine();
    renderAssetSummary();
    syncNextTurnButton();
    syncTradeButtons();
    processPendingOrdersMatch();
    reflowGameScreenUi();
  } catch (e) {
    console.warn("maybeAdvanceOnlineMarketAsLeader", e);
  }
}

/**
 * 게임 화면(#screen-game) 진입 후: Realtime 구독 + 10초 클라이언트 틱(리더 선출).
 */
function ensureOnlineMarketSync(reason = "") {
  if (!onlineMode || !sb) return;
  try {
    fetchMarketOnce({ silent: shouldSuppressMarketToast() }).catch((e) =>
      console.warn("fetchMarketOnce", reason, e)
    );
    subscribeMarketRealtime();
    subscribeSocialTradeRealtime();
    clearMarketClientTick();
    marketClientTickId = setInterval(() => {
      maybeAdvanceOnlineMarketAsLeader().catch((e) =>
        console.warn("client tick", e)
      );
    }, ONLINE_CLIENT_TICK_MS);
    setTimeout(() => {
      maybeAdvanceOnlineMarketAsLeader().catch((e) =>
        console.warn("client tick initial", e)
      );
    }, 600);
  } catch (e) {
    console.warn("ensureOnlineMarketSync", reason, e);
  }
}

function subscribeMarketRealtime() {
  if (!sb) return;
  if (marketChannel) {
    sb.removeChannel(marketChannel);
    marketChannel = null;
  }
  marketChannel = sb
    .channel("market_state_live")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: TBL_MARKET_STATE,
        filter: "id=eq.1",
      },
      (payload) => {
        try {
          const st = payload.new?.state;
          if (st) applyServerMarketState(st);
          renderDateTimeLine();
          refreshDetailChart();
          renderStockListMain();
          updateDetailPriceLine();
          renderAssetSummary();
          syncNextTurnButton();
          syncTradeButtons();
          updatePremarketChartOverlay();
          updateDetailTradeLivePreview();
        } catch (e) {
          console.warn("market_state handler", e);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        fetchMarketOnce({ silent: shouldSuppressMarketToast() }).catch((e) =>
          console.warn("fetch after subscribe", e)
        );
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("market_state channel", status);
      }
    });
}

/** display:none 해제 직후 Apex·목록 레이아웃이 0이었을 때 보정 */
function reflowGameScreenUi() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        renderDateTimeLine();
        renderCalendarUI();
        renderStockListMain();
        if (apexDetail.candle && typeof apexDetail.candle.resize === "function") {
          apexDetail.candle.resize();
        }
        if (apexDetail.vol && typeof apexDetail.vol.resize === "function") {
          apexDetail.vol.resize();
        }
        refreshDetailChart();
        updateDetailPriceLine();
        updatePremarketChartOverlay();
        if (selectedStockId) updateOrderBookAndStrength(selectedStockId);
      } catch (e) {
        console.warn("reflowGameScreenUi", e);
      }
    });
  });
}

async function persistUserNow() {
  if (!onlineMode || !sb || !loginDisplayName) return;
  await sb
    .from(TBL_USERS)
    .update({
      cash: Math.round(game.cash),
      hp: 100,
      stress: 0,
      sim_age: game.age,
      trade_blocked_until_ms: Math.max(0, Math.floor(game.tradeBlockedUntilMs || 0)),
      initial_capital: game.initialCapital,
      profile: {
        name: playerProfile.name,
        age: playerProfile.age,
        birthday: playerProfile.birthday,
        setupComplete: playerProfile.setupComplete,
        watchlist: watchlistIds,
        lastSalaryMonthKey: playerProfile.lastSalaryMonthKey || "",
        lastReitDivMonthKey: playerProfile.lastReitDivMonthKey || "",
        pendingOrders,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("login_name", loginDisplayName);
}

function schedulePersistUser() {
  if (!onlineMode) return;
  if (saveDebounceId) clearTimeout(saveDebounceId);
  saveDebounceId = setTimeout(() => {
    saveDebounceId = null;
    persistUserNow().catch((e) => console.warn("persistUserNow", e));
  }, 400);
}

function flushPersistUser() {
  if (saveDebounceId) clearTimeout(saveDebounceId);
  saveDebounceId = null;
  persistUserNow().catch(() => {});
}

async function bootstrapSupabase() {
  const cfg = window.STOCK_LIFE_CONFIG || {};
  const url = (cfg.supabaseUrl || cfg.SUPABASE_URL || "").trim();
  const key = (cfg.supabaseAnonKey || cfg.SUPABASE_KEY || "").trim();
  if (!url || !key) {
    return false;
  }
  sb = createClient(url, key);
  onlineMode = true;
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

function gameTimeOrdinalFromParts(dayIndex, periodStartMin) {
  return dayIndex * GAME_MINUTES_PER_DAY + periodStartMin;
}

/** 게임 캘린더 월/일 → dayIndex (앵커 2000-04-01) */
function dayIndexFromMonthDay(month, day) {
  const tgt = new Date(2000, month - 1, day);
  const a = GAME_ANCHOR_DATE();
  return Math.round((tgt - a) / 86400000);
}

/** 기존 저장본 X 문자열에서 dayIndex·periodStartMin 복구 */
function parseCandleXToGameParts(x) {
  if (!x || typeof x !== "string") return null;
  const legacy = x.match(/^D(\d+)·(\d{2}):(\d{2})$/);
  if (legacy) {
    return {
      dayIndex: Number(legacy[1]) - 1,
      periodStartMin: Number(legacy[2]) * 60 + Number(legacy[3]),
    };
  }
  const md = x.match(/^(\d+)\/(\d+)\s+(\d{1,2}):(\d{2})$/);
  if (md) {
    return {
      dayIndex: dayIndexFromMonthDay(Number(md[1]), Number(md[2])),
      periodStartMin: Number(md[3]) * 60 + Number(md[4]),
    };
  }
  return null;
}

function normalizeCandleRow(r) {
  if (!r || typeof r !== "object") return r;
  let dayIndex = r.dayIndex;
  let periodStartMin = r.periodStartMin;
  if (typeof dayIndex !== "number" || typeof periodStartMin !== "number") {
    const p = parseCandleXToGameParts(r.x);
    if (p) {
      dayIndex = p.dayIndex;
      periodStartMin = p.periodStartMin;
    } else {
      dayIndex = 0;
      periodStartMin = MARKET_OPEN_MIN;
    }
  }
  const gameTimeOrdinal =
    typeof r.gameTimeOrdinal === "number"
      ? r.gameTimeOrdinal
      : gameTimeOrdinalFromParts(dayIndex, periodStartMin);
  return {
    ...r,
    dayIndex,
    periodStartMin,
    gameTimeOrdinal,
    x: r.x || formatCandleXLabel(dayIndex, periodStartMin),
    o: clampStockPrice(r.o),
    h: clampStockPrice(r.h),
    l: clampStockPrice(r.l),
    c: clampStockPrice(r.c),
  };
}

/** 게임 내 날짜·장내 시각 (X축, 실시간 시계와 무관) */
function formatCandleXLabel(dayIndex, periodStartMin) {
  const { month, day } = getCalendarParts(dayIndex);
  return `${month}/${day} ${formatMinuteOfDay(periodStartMin)}`;
}

function minDayIndexForChartRange(range) {
  const d = gameDayIndex;
  switch (range) {
    case "d2":
      return Math.max(0, d - 1);
    case "d5":
      return Math.max(0, d - 4);
    case "w1":
      return Math.max(0, d - 6);
    case "m1":
      return Math.max(0, d - 29);
    default:
      return 0;
  }
}

function filterCandleRowsForChartRange(rows, range) {
  if (!rows || rows.length === 0) return [];
  if (range === "all") return rows;
  const minDay = minDayIndexForChartRange(range);
  return rows.filter((r) => (r.dayIndex ?? 0) >= minDay);
}

function getFilteredCandleHistory(stockId) {
  const raw = candleHistory[stockId] || [];
  const range = detailChartRange || "all";
  return filterCandleRowsForChartRange(raw, range);
}

function getAvgCostForStock(stockId) {
  const sh = Math.max(0, Math.floor(Number(game.holdings[stockId] ?? 0)));
  if (sh <= 0) return null;
  const cb = game.costBasis[stockId] ?? 0;
  const a = Math.floor(cb / sh);
  return Number.isFinite(a) && a > 0 ? a : null;
}

function buildDetailChartAnnotations(stockId) {
  const avg = getAvgCostForStock(stockId);
  if (avg == null) {
    return { yaxis: [], xaxis: [] };
  }
  return {
    yaxis: [
      {
        y: avg,
        borderColor: "rgba(250, 204, 21, 0.9)",
        strokeDashArray: 6,
        label: {
          text: "평단",
          style: {
            color: "#facc15",
            fontSize: "10px",
            fontWeight: 600,
          },
          position: "right",
          offsetX: -4,
        },
      },
    ],
  };
}

function syncDetailChartRangeButtons() {
  document.querySelectorAll("[data-chart-range]").forEach((b) => {
    const r = b.getAttribute("data-chart-range");
    b.classList.toggle("is-active", r === detailChartRange);
  });
}

function bindDetailChartRangeUiOnce() {
  const bar = document.getElementById("detailChartRangeBar");
  if (!bar || bar.dataset.bound === "1") return;
  bar.dataset.bound = "1";
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chart-range]");
    if (!btn) return;
    const r = btn.getAttribute("data-chart-range");
    if (!r) return;
    detailChartRange = r;
    apexDetail.chartRange = r;
    syncDetailChartRangeButtons();
    if (selectedStockId && apexDetail.candle) {
      refreshDetailChart();
    }
  });
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

/** 뉴스·속보 타임스탬프 — 현실 시계가 아닌 게임 내 시각 */
function formatGameNewsTimeLabel(dayIdx, minutes) {
  const yc = getYearChar(dayIdx);
  const { month, day } = getCalendarParts(dayIdx);
  const t = formatMinuteOfDay(minutes);
  return `[${yc}년차 ${month}월 ${day}일 ${t}]`;
}

function newsItemDisplayTime(it) {
  if (
    typeof it.gameDayIndex === "number" &&
    Number.isFinite(it.gameDayIndex) &&
    typeof it.gameMinutes === "number" &&
    Number.isFinite(it.gameMinutes)
  ) {
    return formatGameNewsTimeLabel(it.gameDayIndex, it.gameMinutes);
  }
  return "—";
}

function newsItemSortKey(it) {
  if (typeof it.gameTimeOrdinal === "number" && Number.isFinite(it.gameTimeOrdinal)) {
    return it.gameTimeOrdinal;
  }
  if (
    typeof it.gameDayIndex === "number" &&
    typeof it.gameMinutes === "number"
  ) {
    return gameTimeOrdinalFromParts(it.gameDayIndex, it.gameMinutes);
  }
  return 0;
}

/** 정규장 09:00~15:30 — 시장가·실시간 시세 틱 */
function isRegularSession() {
  return gameMinutes >= MARKET_OPEN_MIN && gameMinutes < MARKET_REGULAR_CLOSE_MIN;
}
/** 시간외 15:30~16:30 — 가격 틱 없음, 지정가 예약만 */
function isAfterHoursSession() {
  return (
    gameMinutes >= MARKET_REGULAR_CLOSE_MIN && gameMinutes < MARKET_CLOSE_MIN
  );
}
/** 정규 매매 구간(시장가) — 구 코드 호환명 */
function isTradingWindowActive() {
  return isRegularSession();
}

/** 08:00~09:00 장 시작 전(프리마켓 대기) */
function isPreMarketWindow() {
  return gameMinutes >= PREMARKET_START_MIN && gameMinutes < MARKET_OPEN_MIN;
}

function shouldAdvanceMarketClock() {
  if (awaitingDayRoll) return false;
  return isPreMarketWindow() || isRegularSession() || isAfterHoursSession();
}

/** 다음 턴(1년) — 정규·시간외 장이 아닐 때만 */
function canAdvanceYearTurn() {
  return !isRegularSession() && !isAfterHoursSession();
}

function isTradingSession() {
  return isTradingWindowActive();
}

/** 다음 턴(1년)은 일일 장 마감 후에만 가능 — 장중·장전 클릭 방지 */
function syncNextTurnButton() {
  const btn = document.getElementById("btnNextTurn");
  if (!btn) return;
  const canAdvance = canAdvanceYearTurn();
  btn.disabled = !canAdvance;
  btn.setAttribute("aria-disabled", canAdvance ? "false" : "true");
  btn.title = canAdvance
    ? ""
    : "장 마감 후에만 다음 턴(1년)을 진행할 수 있습니다.";
}

function resetDailyNewsState() {
  newsCountByStock = emptyChainState();
  chainStepByStock = emptyChainState();
}

function buildPremarketHeadline(stockId, positive) {
  const chain = NEWS_CHAINS[stockId];
  if (chain && chain.length > 0) {
    const pickFrom = positive
      ? chain.filter((_, i) => i % 2 === 0)
      : chain.filter((_, i) => i % 2 === 1);
    const pool = pickFrom.length > 0 ? pickFrom : chain;
    return pool[Math.floor(Math.random() * pool.length)].headline;
  }
  const s = getStockById(stockId);
  const name = s ? s.name : stockId;
  return positive
    ? `[프리마켓] ${name} — 긍정적 속보가 유통됩니다`
    : `[프리마켓] ${name} — 부정적 속보가 유통됩니다`;
}

/** 다음 거래일 08:00 진입 시: 종목별 호·악 뉴스 건수 및 08:00~08:50 분 단위 스케줄 */
function generatePremarketNewsPlan() {
  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  openingGapAppliedToday = false;

  const events = [];
  STOCK_SPECS.forEach((spec) => {
    if (spec.kind === "etf") {
      premarketNewsCounts[spec.id] = { pos: 0, neg: 0 };
      return;
    }
    let pos = Math.floor(Math.random() * 5);
    let neg = Math.floor(Math.random() * 5);
    if (pos + neg === 0) {
      if (Math.random() < 0.5) pos += 1;
      else neg += 1;
    }
    premarketNewsCounts[spec.id] = { pos, neg };
    for (let i = 0; i < pos; i += 1) {
      events.push({ stockId: spec.id, positive: true });
    }
    for (let i = 0; i < neg; i += 1) {
      events.push({ stockId: spec.id, positive: false });
    }
  });

  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }

  const minLo = PREMARKET_START_MIN;
  const maxMin = PREMARKET_NEWS_END_MIN - 1;
  const span = Math.max(1, maxMin - minLo + 1);
  events.forEach((ev) => {
    const minute = minLo + Math.floor(Math.random() * span);
    if (!premarketNewsScheduleByMin[minute]) {
      premarketNewsScheduleByMin[minute] = [];
    }
    premarketNewsScheduleByMin[minute].push(ev);
  });
}

function releasePremarketNewsForMinute(minute) {
  if (
    minute < PREMARKET_START_MIN ||
    minute >= PREMARKET_NEWS_END_MIN
  ) {
    return;
  }
  const batch =
    premarketNewsScheduleByMin[minute] ??
    premarketNewsScheduleByMin[String(minute)];
  if (!batch || batch.length === 0) return;
  batch.forEach((ev) => {
    const type = ev.positive ? "premarket-pos" : "premarket-neg";
    const asRumor = rollIsRumor();
    addNewsItem(buildPremarketHeadline(ev.stockId, ev.positive), type, "", {
      stockId: ev.stockId,
      is_rumor: asRumor,
    });
    if (!asRumor) {
      if (Math.random() < 0.015) {
        rollExtremeNewsKnock(ev.stockId, ev.positive);
      } else {
        scheduleNewsSpikeForStock(ev.stockId, ev.positive ? 1 : -1);
      }
    }
  });
}

function buildAfterHoursHeadline(stockId, positive) {
  const s = getStockById(stockId);
  const name = s ? s.name : stockId;
  return positive
    ? `[시간외] ${name} — 호재 속보가 유통됩니다`
    : `[시간외] ${name} — 악재 속보가 유통됩니다`;
}

/** 15:30~16:30 시간외 뉴스 스케줄(당일 1회 생성) */
function generateAfterHoursNewsPlan() {
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  afterHoursNewsScheduleByMin = {};
  const events = [];
  STOCK_SPECS.forEach((spec) => {
    if (spec.kind === "etf") {
      afterHoursNewsCounts[spec.id] = { pos: 0, neg: 0 };
      return;
    }
    let pos = Math.floor(Math.random() * 4);
    let neg = Math.floor(Math.random() * 4);
    if (pos + neg === 0) {
      if (Math.random() < 0.5) pos += 1;
      else neg += 1;
    }
    afterHoursNewsCounts[spec.id] = { pos, neg };
    for (let i = 0; i < pos; i += 1) {
      events.push({ stockId: spec.id, positive: true });
    }
    for (let i = 0; i < neg; i += 1) {
      events.push({ stockId: spec.id, positive: false });
    }
  });
  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  const minLo = AFTER_HOURS_NEWS_START_MIN;
  const maxMin = AFTER_HOURS_NEWS_END_MIN - 1;
  const span = Math.max(1, maxMin - minLo + 1);
  events.forEach((ev) => {
    const minute = minLo + Math.floor(Math.random() * span);
    if (!afterHoursNewsScheduleByMin[minute]) {
      afterHoursNewsScheduleByMin[minute] = [];
    }
    afterHoursNewsScheduleByMin[minute].push(ev);
  });
}

function releaseAfterHoursNewsForMinute(minute) {
  if (
    minute < AFTER_HOURS_NEWS_START_MIN ||
    minute >= AFTER_HOURS_NEWS_END_MIN
  ) {
    return;
  }
  const batch =
    afterHoursNewsScheduleByMin[minute] ??
    afterHoursNewsScheduleByMin[String(minute)];
  if (!batch || batch.length === 0) return;
  batch.forEach((ev) => {
    const type = ev.positive ? "afterhours-pos" : "afterhours-neg";
    const asRumor = rollIsRumor();
    addNewsItem(buildAfterHoursHeadline(ev.stockId, ev.positive), type, "", {
      stockId: ev.stockId,
      is_rumor: asRumor,
    });
    if (!asRumor) {
      /* 시간외: 시세 틱 없음. 갭은 generateAfterHoursNewsPlan 의 pos/neg 누적만 사용 */
    }
  });
}

function triggerGapOpenAnimation() {
  /* 정적 UI — 갭 애니메이션(깜빡임) 제거 */
}

function updatePremarketChartOverlay() {
  const el = document.getElementById("chartPremarketOverlay");
  if (!el) return;
  const show = Boolean(
    selectedStockId &&
      isPreMarketWindow() &&
      shouldAdvanceMarketClock()
  );
  el.hidden = !show;
}

/** 09:00 첫 틱 직전 호출: 전일 종가 대비 Net Impact로 시초가 갭 */
function applyOpeningGapFromPremarket() {
  if (openingGapAppliedToday) return;
  openingGapAppliedToday = true;

  const oldPrices = snapshotPrices();
  const summaryBits = [];

  STOCK_SPECS.forEach((spec) => {
    if (spec.kind === "etf") return;
    const p = premarketNewsCounts[spec.id] || { pos: 0, neg: 0 };
    const a = afterHoursNewsCounts[spec.id] || { pos: 0, neg: 0 };
    const net = p.pos - p.neg + (a.pos - a.neg);
    const s = getStockById(spec.id);
    if (!s) return;
    const mult = 1 + net * GAP_PCT_PER_NET_IMPACT;
    s.price = clampStockPrice(Math.floor(s.price * mult));
    summaryBits.push(`${spec.id} ${net > 0 ? "+" : ""}${net}`);
  });
  syncEtfPriceFromMarket();
  summaryBits.push("MIX≈시장평균");

  finalizePriceUI(oldPrices);

  tickInCandle = 0;
  candlePeriodStartMin = MARKET_OPEN_MIN;
  candleOhlcBuffer = {};
  stocks.forEach((s) => {
    candleOhlcBuffer[s.id] = { o: s.price, h: s.price, l: s.price };
  });

  snapshotSessionOpen();

  addNewsItem(
    `09:00 시초가 갭 반영 — Net Impact 요약: ${summaryBits.join(" · ")}`,
    "premarket-open",
    "",
    { global: true }
  );
  setMessage(
    "09:00 개장 — 프리마켓·시간외 뉴스가 시초가에 반영되었습니다.",
    "ok"
  );

  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  afterHoursNewsScheduleByMin = {};
  updatePremarketChartOverlay();
}

function initHoldings() {
  stocks.forEach((s) => {
    if (game.holdings[s.id] === undefined) game.holdings[s.id] = 0;
    if (game.costBasis[s.id] === undefined) game.costBasis[s.id] = 0;
  });
}

function formatWon(n) {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

/** 호가·종목 시세 표시용 — 항상 정수(바닥) */
function formatStockWon(n) {
  return `₩${Math.floor(Number(n)).toLocaleString("ko-KR")}`;
}

function getStockById(id) {
  return stocks.find((s) => s.id === id);
}

/** 튜토리얼 플래그·세션 이름 등 브라우저 캐시 제거(전역 리셋 후 등) */
function clearStockLifeLocalCaches() {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

function showFriendTradeToast(message) {
  const root = document.getElementById("friendTradeToast");
  const textEl = document.getElementById("friendTradeToastText");
  if (!root || !textEl) return;
  if (friendTradeToastTimer) {
    clearTimeout(friendTradeToastTimer);
    friendTradeToastTimer = null;
  }
  textEl.textContent = message;
  root.hidden = false;
  friendTradeToastTimer = setTimeout(() => {
    root.hidden = true;
    friendTradeToastTimer = null;
  }, 2600);
}

/** 시드 기반 0~1 (호가 잔량 시각 안정화) */
function pseudo01(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function buildOrderBookLevels(stockId) {
  const s = getStockById(stockId);
  if (!s) return { asks: [], bids: [], tick: 1 };
  const p = Math.floor(s.price);
  const tick = Math.max(1, Math.floor(p * 0.02));
  const asks = [];
  const bids = [];
  const base = gameDayIndex * 10000 + stockId.charCodeAt(0) * 97;
  for (let i = 5; i >= 1; i -= 1) {
    const price = Math.floor(p + i * tick);
    const vol = Math.round(
      800 + pseudo01(base + i * 13) * 42000 * (0.3 + i * 0.14)
    );
    asks.push({ price, vol });
  }
  for (let i = 1; i <= 5; i += 1) {
    const price = Math.max(MIN_STOCK_PRICE, Math.floor(p - i * tick));
    const vol = Math.round(
      800 + pseudo01(base + 50 + i * 17) * 42000 * (0.3 + (6 - i) * 0.14)
    );
    bids.push({ price, vol });
  }
  return { asks, bids, tick };
}

function updateOrderBookAndStrength(stockId) {
  const wrap = document.getElementById("detailOrderBookRows");
  const bar = document.getElementById("detailExecStrengthBar");
  const pctEl = document.getElementById("detailExecStrengthPct");
  if (!wrap || !bar || !pctEl) return;

  const s = getStockById(stockId);
  if (!s) return;

  const prev = prevTickPrice[stockId];
  let strength;
  if (prev === undefined || prev === s.price) {
    strength = 95 + pseudo01(gameDayIndex + stockId.length * 31) * 10;
  } else if (s.price > prev) {
    strength = 100 + Math.random() * 35;
  } else {
    strength = 55 + Math.random() * 44;
  }
  const pct = Math.round(strength * 10) / 10;
  pctEl.textContent = `${pct.toFixed(1)}%`;
  const barW = Math.min(150, Math.max(40, pct));
  bar.style.width = `${(barW / 150) * 100}%`;
  bar.classList.toggle("is-hot", pct >= 100);
  bar.classList.toggle("is-cold", pct < 100);

  const { asks, bids } = buildOrderBookLevels(stockId);
  const maxVol = Math.max(
    1,
    ...asks.map((a) => a.vol),
    ...bids.map((b) => b.vol)
  );

  const rowHtml = (label, price, vol, side) => {
    const w = Math.round((vol / maxVol) * 100);
    return `<div class="ob-row ob-row--${side}">
      <span class="ob-tag">${label}</span>
      <span class="ob-price ${side === "ask" ? "chg-up" : "chg-down"}">${formatStockWon(price)}</span>
      <span class="ob-vol">${vol.toLocaleString("ko-KR")}</span>
      <span class="ob-vol-bar" aria-hidden="true"><i style="width:${w}%"></i></span>
    </div>`;
  };

  let html = "";
  asks.forEach((a, idx) => {
    html += rowHtml(`매도${5 - idx}`, a.price, a.vol, "ask");
  });
  html += `<div class="ob-mid"><span>현재가</span><strong>${formatStockWon(s.price)}</strong></div>`;
  bids.forEach((b, idx) => {
    html += rowHtml(`매수${idx + 1}`, b.price, b.vol, "bid");
  });
  wrap.innerHTML = html;
}

function subscribeSocialTradeRealtime() {
  if (!sb || !onlineMode) return;
  if (socialTradeChannel) {
    sb.removeChannel(socialTradeChannel);
    socialTradeChannel = null;
  }
  socialTradeChannel = sb
    .channel("social_trade_live")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: TBL_SOCIAL_TRADE,
      },
      (payload) => {
        try {
          const row = payload.new;
          if (!row || !row.login_name) return;
          if (loginDisplayName && row.login_name === loginDisplayName) return;
          const name = row.stock_display_name || row.symbol;
          const verb =
            row.kind === "full_buy"
              ? "풀매수"
              : row.kind === "full_sell"
                ? "풀매도"
                : "매매";
          showFriendTradeToast(
            `📢 ${row.login_name}님이 ${name} 종목을 ${verb}했습니다!`
          );
        } catch (e) {
          console.warn("social_trade handler", e);
        }
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("social_trade channel", status);
      }
    });
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

async function buyStock(stockId, quantityRaw, mode = "shares") {
  if (tutorialGateActive) {
    return { ok: false, reason: "튜토리얼을 먼저 완료해 주세요." };
  }
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  const q = Math.max(
    0,
    Math.floor(Number(computeTradeQtyFromInput(stockId, "buy", quantityRaw, mode)))
  );
  if (!q || q <= 0) {
    return { ok: false, reason: "수량·금액을 올바르게 입력해 주세요." };
  }
  const stock = getStockById(stockId);
  if (!stock) return { ok: false, reason: "존재하지 않는 종목입니다." };

  const { data, error } = await sb.rpc("execute_buy_by_name", {
    p_login_name: loginDisplayName,
    p_symbol: stockId,
    p_qty: q,
  });
  if (error) {
    return { ok: false, reason: error.message || "매수 요청 실패" };
  }
  if (!data?.ok) {
    return { ok: false, reason: data?.reason || "매수 실패" };
  }
  game.cash = Number(data.cash);
  await loadUserFromServer();
  schedulePersistUser();
  return { ok: true };
}

async function sellStock(stockId, quantityRaw, mode = "shares") {
  if (tutorialGateActive) {
    return { ok: false, reason: "튜토리얼을 먼저 완료해 주세요." };
  }
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  const q = Math.max(
    0,
    Math.floor(Number(computeTradeQtyFromInput(stockId, "sell", quantityRaw, mode)))
  );
  if (!q || q <= 0) {
    return { ok: false, reason: "수량·금액을 올바르게 입력해 주세요." };
  }
  const stock = getStockById(stockId);
  if (!stock) return { ok: false, reason: "존재하지 않는 종목입니다." };

  const { data, error } = await sb.rpc("execute_sell_by_name", {
    p_login_name: loginDisplayName,
    p_symbol: stockId,
    p_qty: q,
  });
  if (error) {
    return { ok: false, reason: error.message || "매도 요청 실패" };
  }
  if (!data?.ok) {
    return { ok: false, reason: data?.reason || "매도 실패" };
  }
  game.cash = Number(data.cash);
  await loadUserFromServer();
  schedulePersistUser();
  return { ok: true };
}

function isLimitOrderWindowAllowed() {
  return isRegularSession() || isAfterHoursSession();
}

function renderPendingOrdersUi() {
  const ul = document.getElementById("detailPendingOrdersList");
  if (!ul) return;
  ul.innerHTML = "";
  if (pendingOrders.length === 0) {
    const li = document.createElement("li");
    li.className = "pending-order-empty";
    li.textContent = "대기 중인 지정가 주문이 없습니다.";
    ul.appendChild(li);
    return;
  }
  pendingOrders.forEach((o) => {
    const li = document.createElement("li");
    li.className = "pending-order-row";
    const span = document.createElement("span");
    span.textContent = `${o.symbol} ${o.side === "buy" ? "매수" : "매도"} ${o.qty}주 @ ${formatStockWon(o.limitPrice)}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-mts ghost btn-pending-cancel";
    btn.textContent = "취소";
    btn.addEventListener("click", () => {
      pendingOrders = pendingOrders.filter((x) => x.id !== o.id);
      renderPendingOrdersUi();
      schedulePersistUser();
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function processPendingOrdersMatchAsync() {
  if (tutorialGateActive || pendingOrders.length === 0) return;
  const snapshot = pendingOrders.slice();
  const keep = [];
  try {
    for (const o of snapshot) {
      if (!o || typeof o.symbol !== "string") {
        if (o) keep.push(o);
        continue;
      }
      const lim = Number(o.limitPrice);
      const q = Math.floor(Number(o.qty));
      if (!Number.isFinite(lim) || !Number.isFinite(q) || q <= 0) {
        keep.push(o);
        continue;
      }
      const s = getStockById(o.symbol);
      if (!s) {
        keep.push(o);
        continue;
      }
      const px = Number(s.price);
      if (!Number.isFinite(px) || px < MIN_STOCK_PRICE) {
        keep.push(o);
        continue;
      }
      const hit =
        o.side === "buy" ? px <= lim : px >= lim;
      if (!hit) {
        keep.push(o);
        continue;
      }
      const r =
        o.side === "buy"
          ? await buyStock(o.symbol, String(q), "shares")
          : await sellStock(o.symbol, String(q), "shares");
      if (!r.ok) {
        keep.push(o);
        continue;
      }
      setMessage(`${o.symbol} 지정가 예약이 체결되었습니다.`, "ok");
    }
  } catch (e) {
    console.warn("processPendingOrdersMatchAsync", e);
    pendingOrders = snapshot;
    renderPendingOrdersUi();
    schedulePersistUser();
    return;
  }
  pendingOrders = keep;
  renderPendingOrdersUi();
  schedulePersistUser();
}

function processPendingOrdersMatch() {
  void processPendingOrdersMatchAsync().catch((e) =>
    console.warn("processPendingOrdersMatch", e)
  );
}

/** 일반 종목 평균가 → ETF 1주 가격 (뉴스·개별 틱 없음) */
function syncEtfPriceFromMarket() {
  try {
    const etf = getStockById("MIX");
    if (!etf) return;
    let sum = 0;
    let n = 0;
    STOCK_SPECS.forEach((spec) => {
      if (spec.kind === "etf") return;
      const st = getStockById(spec.id);
      if (!st) return;
      const p = Number(st.price);
      if (!Number.isFinite(p) || p < MIN_STOCK_PRICE) return;
      sum += p;
      n += 1;
    });
    if (n > 0) {
      etf.price = clampStockPrice(Math.floor(sum / n));
    } else {
      etf.price = clampStockPrice(etf.price);
    }
  } catch (e) {
    console.warn("syncEtfPriceFromMarket", e);
  }
}

/**
 * 평상시: 틱당 -2~+2원 횡보. 진짜 뉴스(스파이크) 구간: 틱당 대폭 상승·하락(원 단위).
 * REIT: 초저변동. ETF: 별도 동기화.
 */
function oneMicroPriceStep() {
  stocks.forEach((s) => {
    const id = s.id;
    if (isEtfId(id)) return;
    const spikeLeft = newsSpikeTicksLeft[id] ?? 0;
    const mode = newsSpikeMode[id] || "normal";
    if (spikeLeft > 0) {
      newsSpikeTicksLeft[id] = spikeLeft - 1;
      if (mode === "extremeBull") {
        const mult = 5 + Math.random() * 5;
        s.price = clampStockPrice(Math.floor(s.price * mult));
        newsSpikeMode[id] = "normal";
        return;
      }
      if (mode === "extremeBear") {
        const f = 0.05 + Math.random() * 0.05;
        s.price = clampStockPrice(
          Math.max(MIN_STOCK_PRICE, Math.floor(s.price * f))
        );
        newsSpikeMode[id] = "normal";
        return;
      }
      const up = (newsSpikeDirection[id] ?? 1) >= 0;
      let delta;
      if (up) {
        delta = 20 + Math.floor(Math.random() * 31);
      } else {
        delta = -(20 + Math.floor(Math.random() * 21));
      }
      s.price = clampStockPrice(s.price + delta);
      return;
    }
    let delta;
    if (isReitId(id)) {
      delta = -1 + Math.floor(Math.random() * 3);
    } else {
      delta = -2 + Math.floor(Math.random() * 5);
    }
    s.price = clampStockPrice(s.price + delta);
  });
  syncEtfPriceFromMarket();
}

function payDividends() {
  let total = 0;
  stocks.forEach((s) => {
    if (isReitId(s.id) || isEtfId(s.id)) return;
    const q = game.holdings[s.id] ?? 0;
    if (q <= 0) return;
    total += q * Math.max(1, Math.floor(s.price * 0.00085));
  });
  if (total <= 0) return;

  game.cash += Math.round(total);
  addNewsItem(`배당금 입금 완료 · ${formatWon(total)}`, "dividend", "", {
    global: true,
  });
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
  const row = normalizeCandleRow({
    dayIndex: candleDayIndex,
    periodStartMin,
    gameTimeOrdinal: gameTimeOrdinalFromParts(candleDayIndex, periodStartMin),
    x: formatCandleXLabel(candleDayIndex, periodStartMin),
    o: Math.floor(open),
    h: Math.floor(high),
    l: Math.floor(low),
    c: Math.floor(close),
    v: Math.round(volume),
  });
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
  });

  sessionCandleCount += 1;
  dividendCandleCounter += 1;
  if (dividendCandleCounter % DIVIDEND_EVERY_CANDLES === 0) {
    if (!onlineLeaderSimulating) {
      payDividends();
    }
  }

  const completed = Math.floor(
    (gameMinutes - MARKET_OPEN_MIN) / CANDLE_GAME_MINUTES
  );
  tryFireChainNews(completed);
  tryEmitExtraRumorChatter();
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

function finalizePriceUI(oldPrices) {
  refreshDetailChart();
  renderStockListMain();
  renderAssetSummary();
  stocks.forEach((s) => {
    prevTickPrice[s.id] = s.price;
  });
}

function applyNewsPayload(ev) {
  scheduleNewsSpikeFromImpacts(ev.impacts || {});
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
    tooltip: { enabled: false },
    states: {
      hover: { filter: { type: "none" } },
      active: { filter: { type: "none" } },
    },
  };
}

/** 진행 중 봉의 추정 거래량(차트 막대) */
function estimatePartialBarVolume(stockId) {
  const b = candleOhlcBuffer[stockId];
  const s = getStockById(stockId);
  if (!b || !s) return 1;
  const o = b.o;
  const h = Math.max(b.h, s.price);
  const l = Math.min(b.l, s.price);
  const c = s.price;
  const progress = Math.max(1, tickInCandle) / TICKS_PER_CANDLE;
  return Math.max(
    1,
    Math.round(
      ((h - l) / Math.max(o, 1)) * 2_800_000 * progress +
        Math.abs(c - o) * 42 +
        Math.random() * 6000 +
        12000
    )
  );
}

function buildCandleSeriesData(stockId) {
  const hist = getFilteredCandleHistory(stockId);
  const rows = hist.map((r) => ({
    x: r.x,
    y: [
      Math.floor(r.o),
      Math.floor(r.h),
      Math.floor(r.l),
      Math.floor(r.c),
    ],
  }));
  if (
    tickInCandle > 0 &&
    isTradingWindowActive() &&
    gameMinutes < MARKET_CLOSE_MIN &&
    candleOhlcBuffer[stockId]
  ) {
    const b = candleOhlcBuffer[stockId];
    const s = getStockById(stockId);
    if (s) {
      const o = b.o;
      const h = Math.max(b.h, s.price);
      const l = Math.min(b.l, s.price);
      const c = s.price;
      rows.push({
        x: formatCandleXLabel(gameDayIndex, candlePeriodStartMin),
        y: [
          Math.floor(o),
          Math.floor(h),
          Math.floor(l),
          Math.floor(c),
        ],
      });
    }
  }
  return rows;
}

function buildVolumeSeriesData(stockId) {
  const hist = getFilteredCandleHistory(stockId);
  const rows = hist.map((r) => {
    const up = r.c >= r.o;
    return {
      x: r.x,
      y: r.v,
      fillColor: up ? CANDLE_UP : CANDLE_DOWN,
    };
  });
  if (
    tickInCandle > 0 &&
    isTradingWindowActive() &&
    gameMinutes < MARKET_CLOSE_MIN &&
    candleOhlcBuffer[stockId]
  ) {
    const b = candleOhlcBuffer[stockId];
    const s = getStockById(stockId);
    if (s) {
      const o = b.o;
      const c = s.price;
      rows.push({
        x: formatCandleXLabel(gameDayIndex, candlePeriodStartMin),
        y: estimatePartialBarVolume(stockId),
        fillColor: c >= o ? CANDLE_UP : CANDLE_DOWN,
      });
    }
  }
  return rows;
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
    chart: {
      ...candleBase.chart,
      animations: {
        enabled: true,
        easing: "easeinout",
        speed: 420,
        dynamicAnimation: { enabled: true, speed: 260 },
      },
    },
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
    annotations: buildDetailChartAnnotations(stockId),
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
        formatter: (v) => Math.floor(v).toLocaleString("ko-KR"),
      },
    },
  };

  const volBase = apexCommonChartOpts(88, "bar");
  const volOpts = {
    ...volBase,
    chart: {
      ...volBase.chart,
      animations: {
        enabled: true,
        easing: "easeinout",
        speed: 380,
        dynamicAnimation: { enabled: true, speed: 240 },
      },
    },
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

  try {
    apexDetail.candle = new ApexCharts(cEl, candleOpts);
    apexDetail.vol = new ApexCharts(vEl, volOpts);
    apexDetail.stockId = stockId;
    apexDetail.candle.render();
    apexDetail.vol.render();
  } catch (e) {
    console.warn("initDetailCharts", e);
    apexDetail.candle = null;
    apexDetail.vol = null;
    apexDetail.stockId = null;
  }
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
  try {
    apexDetail.candle.updateOptions(
      { annotations: buildDetailChartAnnotations(id) },
      false,
      true
    );
  } catch (e) {
    console.warn("refreshDetailChart annotations", e);
  }
  updateOrderBookAndStrength(id);
  updateDetailTradeLivePreview();
}

function computeTradeQtyFromInput(stockId, action, rawInput, mode) {
  const s = getStockById(stockId);
  if (!s || s.price <= 0) return 0;
  const clean = String(rawInput ?? "").replace(/,/g, "").trim();
  const shHeld = Math.max(0, Math.floor(Number(game.holdings[stockId] ?? 0)));
  if (mode === "won") {
    const won = Math.floor(Number(parseFloat(clean)));
    if (!Number.isFinite(won) || won <= 0) return 0;
    if (action === "buy") {
      const cap = Math.min(won, Math.floor(game.cash));
      return Math.max(0, Math.floor(cap / s.price));
    }
    const maxWon = Math.floor(shHeld * s.price);
    const use = Math.min(won, maxWon);
    return Math.max(0, Math.floor(use / s.price));
  }
  let q = Math.max(0, Math.floor(Number(parseFloat(clean))));
  if (!q || q <= 0) return 0;
  if (action === "sell") {
    if (q > shHeld) return shHeld;
  }
  return q;
}

function renderDetailStockNewsSection() {
  const ul = document.getElementById("detailStockNewsList");
  if (!ul || !selectedStockId) return;
  const id = selectedStockId;
  const s = getStockById(id);
  const nameOk = s?.name ? String(s.name) : "";
  const items = serverNewsFeedItems
    .filter((it) => {
      if (it.stockId === id) return true;
      if (nameOk && it.text && String(it.text).includes(nameOk)) return true;
      return false;
    })
    .sort((a, b) => newsItemSortKey(b) - newsItemSortKey(a));
  ul.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "detail-news-empty";
    li.textContent = "이 종목 관련 속보가 아직 없습니다.";
    ul.appendChild(li);
    return;
  }
  items.slice(0, 40).forEach((it) => {
    const li = document.createElement("li");
    li.className = "detail-news-item";
    const timeEl = document.createElement("time");
    timeEl.className = "detail-news-time";
    timeEl.textContent = newsItemDisplayTime(it);
    const row = document.createElement("div");
    row.className = "detail-news-text-row";
    const tagWrap = document.createElement("span");
    tagWrap.className = "news-stock-tags";
    appendStockNewsTags(tagWrap, it.stockId);
    const p = document.createElement("p");
    p.className = "detail-news-text";
    p.textContent = newsTextForDisplay(it);
    if (tagWrap.childNodes.length > 0) row.appendChild(tagWrap);
    row.appendChild(p);
    li.appendChild(timeEl);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

function updateDetailTradeLivePreview() {
  const wrap = document.getElementById("detailTradePreview");
  const inp = document.getElementById("detailQtyInput");
  if (!wrap || !inp || !selectedStockId) return;
  const s = getStockById(selectedStockId);
  if (!s) return;
  const qty = Math.max(
    0,
    Math.floor(
      computeTradeQtyFromInput(
        selectedStockId,
        lastDetailTradeAction,
        inp.value,
        detailTradeInputMode
      )
    )
  );
  const avgEl = document.getElementById("detailPreviewAvg");
  const plEl = document.getElementById("detailPreviewPl");
  const wtEl = document.getElementById("detailPreviewWeight");
  if (!qty || qty <= 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const sh = Math.max(0, Math.floor(Number(game.holdings[selectedStockId] ?? 0)));
  const cb = game.costBasis[selectedStockId] ?? 0;
  const P = s.price;

  if (lastDetailTradeAction === "buy") {
    const cost = Math.round(P * qty);
    const newSh = sh + qty;
    const newCb = cb + cost;
    const newAvg = newSh > 0 ? newCb / newSh : 0;
    const newStockVal = newSh * P;
    const oldStockVal = sh * P;
    const hypNw = netWorth() - oldStockVal + newStockVal - cost;
    const pl = newStockVal - newCb;
    const pct = newCb > 0 ? ((newStockVal - newCb) / newCb) * 100 : 0;
    if (avgEl) avgEl.textContent = formatStockWon(Math.floor(newAvg));
    if (plEl) {
      plEl.textContent = `${pl >= 0 ? "+" : ""}${formatStockWon(Math.floor(pl))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
      plEl.className = `detail-preview-pl ${
        pl > 0 ? "value-up" : pl < 0 ? "value-down" : "value-neutral"
      }`;
    }
    if (wtEl) {
      const w = hypNw > 0 ? (newStockVal / hypNw) * 100 : 0;
      wtEl.textContent = `${w.toFixed(1)}%`;
      wtEl.className = `detail-preview-wt ${
        w >= 0 ? "value-neutral" : "value-neutral"
      }`;
    }
  } else {
    const sellQty = Math.min(qty, sh);
    const propCost = sh > 0 ? (cb * sellQty) / sh : 0;
    const gain = sellQty * P - propCost;
    const newSh = sh - sellQty;
    const newCb = cb - propCost;
    const newAvg = newSh > 1e-8 ? newCb / newSh : 0;
    const newStockVal = Math.max(0, newSh * P);
    const oldStockVal = sh * P;
    const g = Math.round(P * sellQty);
    const hypNw = netWorth() - oldStockVal + newStockVal + g;
    if (avgEl) {
      avgEl.textContent =
        newSh < 1e-8 ? "—" : formatStockWon(Math.floor(newAvg));
    }
    if (plEl) {
      plEl.textContent = `${gain >= 0 ? "+" : ""}${formatStockWon(Math.floor(gain))} (이번 매도)`;
      plEl.className = `detail-preview-pl ${
        gain > 0 ? "value-up" : gain < 0 ? "value-down" : "value-neutral"
      }`;
    }
    if (wtEl) {
      const w = hypNw > 0 ? (newStockVal / hypNw) * 100 : 0;
      wtEl.textContent = newSh < 1e-8 ? "0%" : `${w.toFixed(1)}%`;
    }
  }
}

function addNewsItem(text, type = "news", subline = "", meta = {}) {
  const gDay = gameDayIndex;
  const gMin = gameMinutes;
  const item = {
    ts: new Date().toISOString(),
    gameDayIndex: gDay,
    gameMinutes: gMin,
    gameTimeOrdinal: gameTimeOrdinalFromParts(gDay, gMin),
    text,
    type: type || "news",
    subline: subline || "",
    stockId: meta.stockId,
    global: meta.global === true,
    is_rumor: meta.is_rumor === true,
  };
  if (onlineMode && onlineLeaderSimulating) {
    serverNewsFeedItems.unshift(item);
    while (serverNewsFeedItems.length > MAX_NEWS_ITEMS) {
      serverNewsFeedItems.pop();
    }
    return;
  }

  serverNewsFeedItems.unshift(item);
  while (serverNewsFeedItems.length > MAX_NEWS_ITEMS) {
    serverNewsFeedItems.pop();
  }
  renderNewsFeedFromServer(serverNewsFeedItems);
}

/** 장중 봉 확정 시 가끔 추가 찌라시 한 줄(시세 무관) — 피드만 시끌벅적하게 */
function tryEmitExtraRumorChatter() {
  if (tutorialGateActive) return;
  if (!isTradingWindowActive()) return;
  if (Math.random() >= 0.14) return;
  const s = stocks[Math.floor(Math.random() * stocks.length)];
  if (!s) return;
  const lines = [
    () => `[소문] ${s.name} — 거래소 인근에서 '큰 손' 이야기만 무성합니다`,
    () => `[익명] ${s.name} 관련 내부 메모가 돌고 있다는 말이 나옵니다`,
    () => `${s.name} — 실적 시즌 전 '깜짝 변수' 거론되나 확인 불가`,
    () => `[현장] ${s.name} 앞 증권가 TV에 단골 애널리스트가 잠복 중이랍니다`,
    () => `[단톡] ${s.name} — 지인의 지인의 펀드매니저가 뭐라던데…`,
  ];
  const line = lines[Math.floor(Math.random() * lines.length)]();
  addNewsItem(line, "ambient", "", { stockId: s.id, is_rumor: true });
}

function tryFireChainNews(completedCandleCount) {
  Object.keys(NEWS_CHAINS).forEach((stockId) => {
    const sched = CHAIN_SCHEDULE[stockId];
    if (!sched) return;
    const step = chainStepByStock[stockId];
    if (step >= sched.length || newsCountByStock[stockId] >= 3) return;
    if (completedCandleCount !== sched[step]) return;

    const story = NEWS_CHAINS[stockId][step];
    const asRumor = rollIsRumor();
    addNewsItem(story.headline, "chain", "", { stockId, is_rumor: asRumor });
    if (!asRumor) applyNewsPayload(story);
    chainStepByStock[stockId] += 1;
    newsCountByStock[stockId] += 1;
  });
}

/** 보조 속보 — 간격 길게, 관심 종목 가중 */
const AMBIENT_NEWS_TEMPLATES = [
  (name) => `[현장] ${name} — 거래대금 상위권, 체결 밀도가 두드러진 구간`,
  (name) => `[증권가] ${name} 수급 이슈로 매매대금 주목`,
  (name) => `[분석] ${name} 차입·사업 구조 점검 리포트 확산`,
  (name) => `[보도] ${name} 공급·수요 밸런스 재평가 분위기`,
  (name) => `[이슈] ${name} 업황·실적 가시성에 시선 분산`,
];

function pickStockIdForAmbientNews() {
  const wl = watchlistIds.filter((id) => getStockById(id));
  const allIds = stocks.map((s) => s.id);
  if (allIds.length === 0) return null;
  if (wl.length === 0) {
    return allIds[Math.floor(Math.random() * allIds.length)];
  }
  if (Math.random() < 0.68) {
    return wl[Math.floor(Math.random() * wl.length)];
  }
  return allIds[Math.floor(Math.random() * allIds.length)];
}

function scheduleAmbientNewsTimer() {
  clearTimeout(newsTimeoutId);
  const delay = 150000 + Math.random() * 130000;
  newsTimeoutId = setTimeout(() => {
    if (isTradingSession()) {
      const sid = pickStockIdForAmbientNews();
      const s = sid ? getStockById(sid) : null;
      if (s) {
        const tpl =
          AMBIENT_NEWS_TEMPLATES[
            Math.floor(Math.random() * AMBIENT_NEWS_TEMPLATES.length)
          ];
        const asRumor = rollIsRumor();
        addNewsItem(tpl(s.name), "ambient", "", {
          stockId: sid,
          is_rumor: asRumor,
        });
        if (!asRumor) {
          scheduleNewsSpikeForStock(sid, Math.random() < 0.52 ? 1 : -1);
        }
      }
    }
    if (shouldAdvanceMarketClock()) scheduleAmbientNewsTimer();
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

function updatePhoneShellClock() {
  const el = document.getElementById("phoneStatusTime");
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderProfileDisplay() {
  const n = document.getElementById("profileNameDisplay");
  const b = document.getElementById("profileBirthDisplay");
  if (n) n.textContent = playerProfile.name?.trim() ? playerProfile.name : "—";
  if (b) {
    if (playerProfile.birthday) {
      const d = new Date(`${playerProfile.birthday}T12:00:00`);
      b.textContent = Number.isNaN(d.getTime())
        ? playerProfile.birthday
        : `${d.getMonth() + 1}월 ${d.getDate()}일`;
    } else {
      b.textContent = "—";
    }
  }
}

function populateSetupForm() {
  const nameEl = document.getElementById("setupPlayerName");
  const ageEl = document.getElementById("setupPlayerAge");
  const birthEl = document.getElementById("setupPlayerBirth");
  if (nameEl) nameEl.value = playerProfile.name || "";
  if (ageEl) ageEl.value = String(playerProfile.age ?? 20);
  if (birthEl) birthEl.value = playerProfile.birthday || "";
}

function bindCharacterSetup() {
  const btn = document.getElementById("btnCharacterSetupOk");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    const nameRaw = document.getElementById("setupPlayerName")?.value ?? "";
    const name = nameRaw.trim();
    const ageNum = parseInt(
      document.getElementById("setupPlayerAge")?.value ?? "20",
      10
    );
    const birth =
      document.getElementById("setupPlayerBirth")?.value?.trim() ?? "";
    if (!name) {
      setMessage("이름을 입력해 주세요.", "err");
      return;
    }
    playerProfile.name = name;
    playerProfile.age = Number.isFinite(ageNum)
      ? Math.min(99, Math.max(15, ageNum))
      : 20;
    playerProfile.birthday = birth;
    playerProfile.setupComplete = true;
    renderProfileDisplay();
    if (onlineMode && sb && loginDisplayName) {
      await persistUserNow().catch((e) =>
        console.warn("persistUserNow after setup", e)
      );
    }
    void tryFetchSeedMarketOnce({ silent: true }).catch((e) =>
      console.warn("tryFetchSeedMarketOnce after setup", e)
    );
    if (!isTutorialDone()) {
      showScreen("screen-tutorial");
      requestAnimationFrame(() => document.getElementById("btnTutorialDismiss")?.focus());
    } else {
      showScreen("screen-game");
      startGameClockFromInit(false);
    }
  });
}

function startGameClockFromInit(loaded) {
  if (gameClockEverStarted) return;
  try {
    if (onlineMode) {
      clearGameClockTimer();
      clearAmbientNewsTimer();
      ensureOnlineMarketSync("startGameClockFromInit");
    } else if (!loaded) {
      addNewsItem(
        "시장 개장 · 현실 1초=장내 1분, 10분봉은 현실 10초마다 확정",
        "news",
        "",
        { global: true }
      );
      onSessionSecondTick();
      startGameClockTimer();
      scheduleAmbientNewsTimer();
    } else if (awaitingDayRoll) {
      scheduleNextTradingDay();
    } else {
      startGameClockTimer();
      scheduleAmbientNewsTimer();
    }

    if (phoneClockIntervalId) clearInterval(phoneClockIntervalId);
    updatePhoneShellClock();
    phoneClockIntervalId = setInterval(updatePhoneShellClock, 15000);

    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    if (!loaded) schedulePersistUser();
    else flushPersistUser();
    syncNextTurnButton();
    reflowGameScreenUi();
    gameClockEverStarted = true;
  } catch (e) {
    console.error("startGameClockFromInit", e);
  }
}

function renderDateTimeLine() {
  const el = document.getElementById("gameDateTime");
  if (!el) return;
  el.textContent = formatDateTimeBracket();
  updatePhoneShellClock();
}

function toggleWatchlist(stockId) {
  const idx = watchlistIds.indexOf(stockId);
  if (idx >= 0) watchlistIds.splice(idx, 1);
  else watchlistIds.push(stockId);
  schedulePersistUser();
  renderStockListMain();
  updateDetailWatchlistButton();
  renderNewsFeedFromServer(serverNewsFeedItems);
  if (selectedStockId) renderDetailStockNewsSection();
}

function updateDetailWatchlistButton() {
  const btn = document.getElementById("btnDetailWatchlist");
  if (!btn || !selectedStockId) return;
  const on = watchlistIds.includes(selectedStockId);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const star = btn.querySelector(".watchlist-star");
  if (star) star.textContent = on ? "★" : "☆";
  btn.classList.toggle("is-active", on);
}

async function resetAllLocalDataAndReload() {
  if (
    !confirm(
      "서버에 저장된 이 캐릭터의 진행이 초기화되고 페이지가 새로고침됩니다.\n계속할까요?"
    )
  ) {
    return;
  }
  clearStockLifeLocalCaches();
  if (onlineMode && sb && loginDisplayName) {
    const { error } = await sb.rpc("reset_name_progress", { p_login_name: loginDisplayName });
    if (error) {
      setMessage(error.message, "err");
      return;
    }
  }
  clearSessionName();
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("clearLocal", "1");
    location.href = u.toString();
  } catch {
    location.reload();
  }
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

    const watched = watchlistIds.includes(s.id);

    const li = document.createElement("li");
    li.className = "stock-list-row";
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    li.dataset.stockId = s.id;
    li.innerHTML = `
      <div class="stock-list-row-main">
        <button type="button" class="btn-watchlist list-watch-btn" data-watch-stock="${escapeHtml(s.id)}" aria-label="관심 종목" aria-pressed="${watched}" title="관심 종목">
          <span class="watchlist-star" aria-hidden="true">${watched ? "★" : "☆"}</span>
        </button>
        <div class="stock-list-name-block">
          <span class="stock-list-name">${escapeHtml(s.name)}</span>
          <span class="stock-list-ticker">${escapeHtml(s.id)}</span>
        </div>
        <div class="stock-list-price-block">
          <span class="stock-list-price watch-price" data-watch-price="${escapeHtml(s.id)}">${formatStockWon(s.price)}</span>
          <span class="stock-list-pct ${chgCls}">${sign}${chgPct.toFixed(2)}%</span>
        </div>
      </div>
      <p class="stock-list-desc">${escapeHtml(s.desc)}</p>
    `;

    const wbtn = li.querySelector(".list-watch-btn");
    if (wbtn) {
      wbtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleWatchlist(s.id);
      });
    }

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
  if (!el || !s) return;
  el.textContent = formatStockWon(s.price);
  detailLastShownPrice = s.price;
}

function openStockDetail(stockId) {
  const s = getStockById(stockId);
  if (!s) return;
  const sp0 = Number(s.price);
  if (!Number.isFinite(sp0) || sp0 < MIN_STOCK_PRICE) {
    repairInvalidStockPrices();
  }

  selectedStockId = stockId;
  syncTradeButtons();
  const list = document.getElementById("marketListView");
  const det = document.getElementById("stockDetailView");
  if (list) list.hidden = true;
  if (det) det.hidden = false;

  const nameEl = document.getElementById("detailStockName");
  const tickEl = document.getElementById("detailStockTicker");
  const descEl = document.getElementById("detailStockDesc");
  if (nameEl) nameEl.textContent = s.name;
  if (tickEl) tickEl.textContent = s.id;
  if (descEl) descEl.textContent = s.desc || "";

  detailChartRange = "all";
  apexDetail.chartRange = "all";
  syncDetailChartRangeButtons();
  detailLastShownPrice = null;
  updateDetailPriceLine();

  initDetailCharts(stockId);
  updateDetailWatchlistButton();
  updatePremarketChartOverlay();
  updateOrderBookAndStrength(stockId);
  syncDetailQtyLabel();
  const lp = document.getElementById("detailLimitPriceInput");
  if (lp) lp.value = String(Math.max(MIN_STOCK_PRICE, Math.floor(s.price)));
  syncDetailOrderTypeUi();
  renderPendingOrdersUi();
  updateDetailTradeLivePreview();
  renderDetailStockNewsSection();
}

function closeStockDetail() {
  selectedStockId = null;
  destroyDetailCharts();
  updatePremarketChartOverlay();
  const list = document.getElementById("marketListView");
  const det = document.getElementById("stockDetailView");
  if (list) list.hidden = false;
  if (det) det.hidden = true;
}

function syncDetailQtyLabel() {
  const lab = document.getElementById("detailQtyLabel");
  if (!lab) return;
  lab.textContent =
    detailTradeInputMode === "won" ? "금액(원)" : "수량(주)";
}

function syncDetailOrderTypeUi() {
  const limitRow = document.getElementById("detailLimitPriceRow");
  if (limitRow) limitRow.hidden = detailTradeOrderType !== "limit";
  document.querySelectorAll("[data-detail-order-type]").forEach((b) => {
    const t = b.getAttribute("data-detail-order-type");
    b.classList.toggle("is-active", t === detailTradeOrderType);
  });
}

function bindDetailTrade() {
  const back = document.getElementById("btnBackToList");
  if (back) back.addEventListener("click", closeStockDetail);

  const wlBtn = document.getElementById("btnDetailWatchlist");
  if (wlBtn) {
    wlBtn.addEventListener("click", () => {
      if (selectedStockId) toggleWatchlist(selectedStockId);
    });
  }

  document.querySelectorAll("[data-detail-qty-mode]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const m = btn.getAttribute("data-detail-qty-mode");
      if (m !== "shares" && m !== "won") return;
      detailTradeInputMode = m;
      document.querySelectorAll("[data-detail-qty-mode]").forEach((b) => {
        b.classList.toggle("is-active", b.getAttribute("data-detail-qty-mode") === m);
      });
      syncDetailQtyLabel();
      updateDetailTradeLivePreview();
    });
  });

  document.querySelectorAll("[data-detail-order-type]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-detail-order-type");
      if (t !== "market" && t !== "limit") return;
      detailTradeOrderType = t;
      syncDetailOrderTypeUi();
      syncTradeButtons();
    });
  });

  const buyBtn = document.getElementById("detailBtnBuy");
  const sellBtn = document.getElementById("detailBtnSell");
  const qtyInput = document.getElementById("detailQtyInput");
  const maxBuyBtn = document.getElementById("detailBtnMaxBuy");
  const sellAllBtn = document.getElementById("detailBtnSellAll");

  async function doTrade(action) {
    const id = selectedStockId;
    if (!id || !qtyInput) return;
    if (tutorialGateActive) {
      setMessage("튜토리얼을 먼저 완료해 주세요.", "err");
      return;
    }
    lastDetailTradeAction = action;
    const raw = qtyInput.value;

    if (detailTradeOrderType === "limit") {
      if (!isLimitOrderWindowAllowed()) {
        setMessage("지정가 예약은 정규장·시간외(15:30~16:30)에만 가능합니다.", "err");
        return;
      }
      const limitInp = document.getElementById("detailLimitPriceInput");
      const lp = Math.floor(Number(limitInp?.value ?? 0));
      if (!Number.isFinite(lp) || lp < MIN_STOCK_PRICE) {
        setMessage("예약가를 올바르게 입력해 주세요.", "err");
        return;
      }
      const q = Math.max(
        0,
        Math.floor(
          computeTradeQtyFromInput(id, action, raw, detailTradeInputMode)
        )
      );
      if (!q) {
        setMessage("수량·금액을 올바르게 입력해 주세요.", "err");
        return;
      }
      pendingOrders.push({
        id: `po_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        symbol: id,
        side: action,
        qty: q,
        limitPrice: lp,
      });
      renderPendingOrdersUi();
      schedulePersistUser();
      setMessage(`${id} 지정가 예약을 등록했습니다.`, "ok");
      return;
    }

    const result =
      action === "buy"
        ? await buyStock(id, raw, detailTradeInputMode)
        : await sellStock(id, raw, detailTradeInputMode);
    if (result.ok) {
      const q = Math.max(
        0,
        Math.floor(
          computeTradeQtyFromInput(id, action, raw, detailTradeInputMode)
        )
      );
      const unit =
        detailTradeInputMode === "won"
          ? `${formatWon(Math.floor(Number(String(raw).replace(/,/g, "")) || 0))}어치`
          : `${formatShares(q)}주`;
      setMessage(
        action === "buy"
          ? `${id} 매수 완료 (${unit}).`
          : `${id} 매도 완료 (${unit}).`,
        "ok"
      );
      renderAssetSummary();
      renderStocks();
      renderStockListMain();
      updateDetailPriceLine();
      updateDetailTradeLivePreview();
      schedulePersistUser();
    } else {
      setMessage(result.reason, "err");
    }
  }

  if (qtyInput) {
    ["input", "change"].forEach((ev) =>
      qtyInput.addEventListener(ev, () => updateDetailTradeLivePreview())
    );
  }

  if (maxBuyBtn) {
    maxBuyBtn.addEventListener("click", () => {
      if (!selectedStockId) return;
      const s = getStockById(selectedStockId);
      if (!s || s.price <= 0) return;
      lastDetailTradeAction = "buy";
      detailTradeInputMode = "shares";
      document.querySelectorAll("[data-detail-qty-mode]").forEach((b) => {
        b.classList.toggle(
          "is-active",
          b.getAttribute("data-detail-qty-mode") === "shares"
        );
      });
      syncDetailQtyLabel();
      const q = Math.max(
        0,
        Math.floor((Math.floor(game.cash) * 0.999) / s.price)
      );
      if (qtyInput) qtyInput.value = q > 0 ? String(q) : "0";
      updateDetailTradeLivePreview();
    });
  }
  if (sellAllBtn) {
    sellAllBtn.addEventListener("click", () => {
      if (!selectedStockId) return;
      lastDetailTradeAction = "sell";
      detailTradeInputMode = "shares";
      document.querySelectorAll("[data-detail-qty-mode]").forEach((b) => {
        b.classList.toggle(
          "is-active",
          b.getAttribute("data-detail-qty-mode") === "shares"
        );
      });
      syncDetailQtyLabel();
      const sh = Math.max(0, Math.floor(Number(game.holdings[selectedStockId] ?? 0)));
      if (qtyInput) qtyInput.value = sh > 0 ? String(sh) : "0";
      updateDetailTradeLivePreview();
    });
  }

  if (buyBtn) {
    buyBtn.addEventListener("click", () => {
      lastDetailTradeAction = "buy";
      doTrade("buy");
    });
  }
  if (sellBtn) {
    sellBtn.addEventListener("click", () => {
      lastDetailTradeAction = "sell";
      doTrade("sell");
    });
  }
  syncDetailQtyLabel();
  syncDetailOrderTypeUi();
  syncTradeButtons();
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
    li.className = "calendar-item";

    const when = document.createElement("span");
    when.className = "calendar-when";
    when.textContent = `${whenLabel} · ${month}/${day}`;

    const title = document.createElement("div");
    title.className = "calendar-title";
    title.textContent = ev.title;

    const meta = document.createElement("div");
    meta.className = "calendar-meta";

    const badge = document.createElement("span");
    badge.className = "calendar-badge calendar-badge-neutral";
    badge.textContent = "관련";

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
  const impacts = {};
  ev.targets.forEach((id) => {
    impacts[id] = ev.shock;
  });
  scheduleNewsSpikeFromImpacts(impacts);
}

function fireDueCalendarEvents() {
  scheduledEvents.forEach((ev) => {
    if (ev.fired || ev.dayIndex !== gameDayIndex) return;
    ev.fired = true;
    addNewsItem(`[경제 일정] ${ev.title}`, "calendar", "", {
      stockId: ev.targets?.[0],
    });
    setMessage(`경제 일정 · ${ev.title}`, "ok");
    applyCalendarEventPayload(ev);
  });
}

function onSessionSecondTick() {
  if (tutorialGateActive) return;
  if (onlineMode) return;
  if (awaitingDayRoll) return;
  if (!shouldAdvanceMarketClock()) return;

  if (gameMinutes < MARKET_OPEN_MIN) {
    releasePremarketNewsForMinute(gameMinutes);
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    renderDateTimeLine();
    updatePremarketChartOverlay();
    refreshDetailChart();
    renderStockListMain();
    updateDetailPriceLine();
    renderAssetSummary();
    syncNextTurnButton();
    syncTradeButtons();
    processPendingOrdersMatch();
    schedulePersistUser();
    return;
  }

  if (gameMinutes === MARKET_OPEN_MIN && !openingGapAppliedToday) {
    applyOpeningGapFromPremarket();
  }

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket();
    return;
  }

  if (gameMinutes >= MARKET_OPEN_MIN && gameMinutes < MARKET_REGULAR_CLOSE_MIN) {
    beginCandlePeriodIfNeeded();
    oneMicroPriceStep();
    stocks.forEach((s) => {
      const b = candleOhlcBuffer[s.id];
      if (b) {
        const px = Number(s.price);
        const p = Number.isFinite(px) ? px : MIN_STOCK_PRICE;
        const bh = Number(b.h);
        const bl = Number(b.l);
        b.h = Number.isFinite(bh) ? Math.max(bh, p) : p;
        b.l = Number.isFinite(bl) ? Math.min(bl, p) : p;
      }
    });
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    tickInCandle += 1;
    renderDateTimeLine();
    updatePremarketChartOverlay();
    if (tickInCandle >= TICKS_PER_CANDLE) {
      sealCurrentCandleAndReset();
    }
    processPendingOrdersMatch();
    refreshDetailChart();
    renderStockListMain();
    updateDetailPriceLine();
    renderAssetSummary();
    stocks.forEach((s) => {
      prevTickPrice[s.id] = s.price;
    });
    schedulePersistUser();
    syncTradeButtons();
    if (gameMinutes >= MARKET_CLOSE_MIN) {
      closeMarket();
    } else {
      syncNextTurnButton();
    }
    return;
  }

  if (isAfterHoursSession()) {
    if (gameMinutes === MARKET_REGULAR_CLOSE_MIN) {
      if (tickInCandle > 0) {
        sealCurrentCandleAndReset();
      }
      if (!afterHoursPlanGeneratedToday) {
        generateAfterHoursNewsPlan();
        afterHoursPlanGeneratedToday = true;
      }
    }
    releaseAfterHoursNewsForMinute(gameMinutes);
    gameMinutes += GAME_MINUTES_PER_REAL_SEC;
    renderDateTimeLine();
    processPendingOrdersMatch();
    refreshDetailChart();
    renderStockListMain();
    updateDetailPriceLine();
    renderAssetSummary();
    schedulePersistUser();
    syncTradeButtons();
    if (gameMinutes >= MARKET_CLOSE_MIN) {
      closeMarket();
    } else {
      syncNextTurnButton();
    }
  }
}

function startGameClockTimer() {
  if (onlineMode) return;
  clearGameClockTimer();
  gameClockIntervalId = setInterval(onSessionSecondTick, 1000);
}

function scheduleNextTradingDay() {
  if (onlineMode) return;
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
  if (onlineMode) return;
  gameDayIndex += 1;
  awaitingDayRoll = false;
  isMarketClosed = false;
  gameMinutes = PREMARKET_START_MIN;
  tickInCandle = 0;
  candlePeriodStartMin = MARKET_OPEN_MIN;
  candleOhlcBuffer = {};
  headlineImpulse *= 0.4;

  resetDailyNewsState();
  generatePremarketNewsPlan();
  dividendCandleCounter = 0;
  afterHoursPlanGeneratedToday = false;

  resetNewsSpikeState();

  ensureCalendarHorizon();
  fireDueCalendarEvents();

  maybeApplyMonthlySalary();

  finishRollToPreMarketDay();
}

function closeMarket() {
  if (onlineMode) return;
  if (awaitingDayRoll) return;

  if (tickInCandle > 0) {
    sealCurrentCandleAndReset();
  }

  awaitingDayRoll = true;
  isMarketClosed = true;
  gameMinutes = MARKET_CLOSE_MIN;
  renderDateTimeLine();

  clearGameClockTimer();
  clearAmbientNewsTimer();

  refreshDetailChart();
  renderStockListMain();
  updateDetailPriceLine();
  updatePremarketChartOverlay();

  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close", "", {
    global: true,
  });
  setMessage("장 마감 — 다음 거래일 08:00부터 프리마켓이 시작됩니다.", "ok");

  flushPersistUser();
  scheduleNextTradingDay();
  syncNextTurnButton();
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
    const avg = owned > 0 ? Math.floor(cb / owned) : 0;
    const evalVal = owned * s.price;
    const pl = Math.round(evalVal - cb);
    const plCls = pl > 0 ? "chg-up" : pl < 0 ? "chg-down" : "chg-flat";

    tr.innerHTML = `
      <td>
        <span class="stock-name">${escapeHtml(s.name)}</span>
        <span class="stock-ticker">${escapeHtml(s.id)}</span>
      </td>
      <td><span data-portfolio-price="${escapeHtml(s.id)}" class="watch-price">${formatStockWon(s.price)}</span></td>
      <td>${owned > 0 ? formatStockWon(avg) : "—"}</td>
      <td>${owned > 0 ? formatShares(owned) : "—"}</td>
      <td class="${plCls}">${owned > 0 ? `${pl >= 0 ? "+" : ""}${formatWon(pl)}` : "—"}</td>
      <td class="cell-qty-portfolio">
        <input type="number" class="qty-input" min="0" step="1" value="1" data-stock="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)} 수량" />
        <div class="portfolio-qty-quick">
          <button type="button" class="btn-mts ghost btn-qty-quick" data-portfolio-max="${escapeHtml(s.id)}">MAX</button>
          <button type="button" class="btn-mts ghost btn-qty-quick" data-portfolio-sellall="${escapeHtml(s.id)}">전량</button>
        </div>
      </td>
      <td class="cell-actions">
        <button type="button" class="btn-mts buy" data-action="buy" data-stock="${escapeHtml(s.id)}">매수</button>
        <button type="button" class="btn-mts sell" data-action="sell" data-stock="${escapeHtml(s.id)}">매도</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-portfolio-max]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.getAttribute("data-portfolio-max");
      const st = getStockById(id);
      const row = b.closest("tr");
      const input = row?.querySelector(".qty-input");
      if (!st || !input || st.price <= 0) return;
      const q = Math.max(
        0,
        Math.floor((Math.floor(game.cash) * 0.999) / st.price)
      );
      input.value = q > 0 ? String(q) : "0";
    });
  });
  tbody.querySelectorAll("[data-portfolio-sellall]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.getAttribute("data-portfolio-sellall");
      const row = b.closest("tr");
      const input = row?.querySelector(".qty-input");
      const sh = Math.max(0, Math.floor(Number(game.holdings[id] ?? 0)));
      if (input) input.value = sh > 0 ? String(sh) : "0";
    });
  });

  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-stock");
      const action = btn.getAttribute("data-action");
      const row = btn.closest("tr");
      const input = row.querySelector(".qty-input");
      const qty = input.value;

      let result;
      if (action === "buy") result = await buyStock(id, qty, "shares");
      else result = await sellStock(id, qty, "shares");

      if (result.ok) {
        const q = Math.max(
          0,
          Math.floor(computeTradeQtyFromInput(id, action, qty, "shares"))
        );
        setMessage(
          action === "buy"
            ? `${id} 매수 완료 (${formatShares(q)}주).`
            : `${id} 매도 완료 (${formatShares(q)}주).`,
          "ok"
        );
        renderAssetSummary();
        renderStocks();
        renderStockListMain();
        schedulePersistUser();
      } else {
        setMessage(result.reason, "err");
      }
    });
  });
  syncTradeButtons();
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
    life: document.getElementById("tab-life"),
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
    if (tab === "life") renderJobScheduleUi();
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
  if (isTradingSession()) {
    setMessage(
      "장이 열려 있는 동안에는 다음 턴(1년)을 진행할 수 없습니다.",
      "err"
    );
    return;
  }
  if (!canAdvanceYearTurn()) {
    setMessage("다음 턴(1년)은 장 마감 후에만 진행할 수 있습니다.", "err");
    return;
  }
  game.age += 1;
  if (!onlineMode) {
    tickStockPrices();
    setMessage(`${game.age}세가 되었습니다. 시장 가격이 변동했습니다.`);
  } else {
    setMessage(`${game.age}세가 되었습니다. 시장 가격은 서버에서 공유됩니다.`);
  }
  renderAssetSummary();
  renderStocks();
  schedulePersistUser();
}

function initNewGame() {
  gameDayIndex = 0;
  gameMinutes = MARKET_OPEN_MIN;
  awaitingDayRoll = false;
  isMarketClosed = false;
  openingGapAppliedToday = true;
  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  afterHoursNewsScheduleByMin = {};
  afterHoursPlanGeneratedToday = false;
  pendingOrders = [];
  scheduledEvents = buildInitialCalendar();
  ensureCalendarHorizon();

  game.age = 25;
  game.cash = INITIAL_CAPITAL;
  game.holdings = {};
  game.costBasis = {};
  game.initialCapital = INITIAL_CAPITAL;
  game.tradeBlockedUntilMs = 0;
  playerProfile.lastSalaryMonthKey =
    getMonthContextForDayIndex(gameDayIndex).monthKey;

  stocks.forEach((s) => {
    s.price = randomInitialPrice();
  });
  resetNewsSpikeState();

  headlineImpulse = 0;
  dividendCandleCounter = 0;
  sessionCandleCount = 0;

  watchlistIds = [];

  initHoldings();
  resetDailyNewsState();
  clearCandleHistory();

  warmupPrices();
  syncEtfPriceFromMarket();
  snapshotSessionOpen();
}

async function runGameBootstrap() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("clearLocal") === "1") {
      clearStockLifeLocalCaches();
      const u = new URL(window.location.href);
      u.searchParams.delete("clearLocal");
      history.replaceState({}, "", u.pathname + u.search + u.hash);
    }
  } catch {
    /* ignore */
  }
  initNewGame();
  await loadUserFromServer();
  subscribeMarketRealtime();
  subscribeSocialTradeRealtime();

  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();
  renderProfileDisplay();

  initTabs();

  bindDetailChartRangeUiOnce();

  bindLifeUi();
  bindCharacterSetup();
  bindTutorialUiOnce();
  document.getElementById("btnNextTurn").addEventListener("click", onNextTurn);
  const btnReset = document.getElementById("btnResetData");
  if (btnReset) btnReset.addEventListener("click", () => resetAllLocalDataAndReload());

  bindDetailTrade();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPersistUser();
      return;
    }
    if (
      onlineMode &&
      sb &&
      gameClockEverStarted &&
      !tutorialGateActive
    ) {
      fetchMarketOnce().catch((e) => console.warn("fetch on visible", e));
    }
  });
  window.addEventListener("beforeunload", () => {
    clearMarketClientTick();
    flushPersistUser();
  });

  routeOnboardingScreens();
  await tryFetchSeedMarketOnce({ silent: tutorialGateActive });
}

async function init() {
  const showLoginError = (msg) => {
    const el = document.getElementById("loginGateError");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  };

  const booted = await bootstrapSupabase();
  if (!booted) {
    showScreen("screen-login");
    setMessage(
      "config.js에 supabaseUrl·supabaseAnonKey를 넣고 새로고침하세요. (config.example.js 참고)",
      "err"
    );
    return;
  }

  if (restorePlayerNameFromSession()) {
    await runGameBootstrap();
    return;
  }

  showScreen("screen-login");
  showLoginError("");

  const input = document.getElementById("loginNameInput");
  const btn = document.getElementById("btnLoginStart");

  const onStart = async () => {
    showLoginError("");
    const r = await loginOrRegisterPlayer(input?.value ?? "");
    if (!r.ok) {
      showLoginError(r.reason || "시작할 수 없습니다.");
      return;
    }
    await runGameBootstrap();
  };

  if (btn) {
    btn.addEventListener("click", () => {
      onStart().catch((e) => console.error(e));
    });
  }
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onStart().catch((err) => console.error(err));
      }
    });
    input.focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => console.error(e));
});
