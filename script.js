/**
 * Stock Life — SVG 스크롤 캔들+거래량, 1초=장내 1분, 10분봉(현실 10초), 뉴스 체이닝
 * 다음 거래일 08:00~09:00 프리마켓(매매 불가) → 09:00 Net Impact 시초가 갭
 * 온라인: Supabase `market_state`(클라이언트 주도 10초 틱 + Realtime) + RPC 매매
 */
import { createClient } from "@supabase/supabase-js";
import {
  createSpecialEventsGenerator,
  DEFAULT_SPECIAL_EVENT_CONFIG,
} from "./special_events_generator.js";

/**
 * Supabase `public` 스키마 테이블명 — `supabase/stock_life_full_setup.sql` 과 동일해야 함.
 * (구버전 name_players / name_portfolios 사용 금지)
 */
const TBL_USERS = "users";
const TBL_PORTFOLIOS = "portfolios";
const TBL_MARKET_STATE = "market_state";
const TBL_SOCIAL_TRADE = "social_trade_events";
/** 실시간 매매 피드 — `trade_logs` (Supabase Realtime INSERT) */
const TBL_TRADE_LOGS = "trade_logs";

/** 온보딩 튜토리얼 1회 완료 플래그 (브라우저 로컬) */
const LS_TUTORIAL_DONE_KEY = "stockLifeTutorialV1Done";
const LS_STARTING_FUND_GUARD_PREFIX = "stockLifeStartingFundGuard:";

/** 튜토리얼 표시 중: 시계·로컬 생활 로직 정지, 시세 Realtime만 수신 */
let tutorialGateActive = false;
let isUserDataLoaded = false;

const MAX_NEWS_ITEMS = 48;
/** 찌라시 비율 — 화면에만 표시, 시세·페이로드(체이닝 impact 등) 반영 없음. 갭·프리마켓 카운트 로직은 변경하지 않음 */
const RUMOR_FRACTION = 0.3;
function rollIsRumor() {
  return Math.random() < RUMOR_FRACTION;
}

/** 종목 속보 표시 시 접두 태그(해시 고정) — 찌라시·실제 구분 가리기 */
const NEWS_DISPLAY_PREFIX_TAGS = [
  "[단독]",
  "[속보]",
  "[특징주]",
  "[마감전]",
  "[특종]",
  "[긴급]",
];
const specialEventsGenerator = createSpecialEventsGenerator(
  DEFAULT_SPECIAL_EVENT_CONFIG
);

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
 * 뉴스 목록·상세 표시문. 원본 `it.text` 미변경. 글로벌 안내(월급 등)만 원문 그대로.
 */
function newsTextForDisplay(it) {
  if (!it) return "";
  const raw = String(it.text ?? "");
  if (it.global === true) {
    return raw;
  }
  let body = raw.replace(/찌라시/g, "");
  body = stripLeadingBracketTags(body);
  body = body.replace(/\s{2,}/g, " ").trim();
  const tag =
    NEWS_DISPLAY_PREFIX_TAGS[
      stableHashForNewsDisplay(it) % NEWS_DISPLAY_PREFIX_TAGS.length
    ];
  if (!body) return tag;
  return `${tag} ${body}`;
}
const NEXT_TRADING_DAY_DELAY_MS = 2200;
const INITIAL_CAPITAL = 1_000_000;
const BANK_DAILY_DEPOSIT_RATE = 0.015;
const BANK_DAILY_LOAN_RATE = 0.08;
const BANK_MAX_LTV = 0.5;
const DAILY_DIVIDEND_MIN_PRICE = 500;
const DAILY_DIVIDEND_PER_SHARE = 2;
const RATIONAL_TRADER_RATIO = 0.5;
const MAX_DELIST_PER_TICK = 1;
const DELIST_PROBABILITY = 0.00001; // 0.001%
/** 긴급 구조(V자) — 초기 상장가 대비 85% 이상 폭락 또는 10원 이하 구간에서 최대 확률 */
const RESCUE_PROB_CAP_DEEP_CRASH = 0.3;
/** 재상장 쿨다운: 430~720 '캔들틱'(각 10초) ≈ 현실 1~2시간 */
const RELIST_COOLDOWN_CANDLE_TICKS_MIN = 430;
const RELIST_COOLDOWN_CANDLE_TICKS_MAX = 720;
/** 중앙은행 QE: 위기 비율(상장가 대비 80% 하락 또는 20원 이하) */
const QE_CRISIS_PRICE_MAX = 20;
const QE_CRISIS_DROP_FRAC = 0.2;
const QE_CRISIS_MASS_RATIO = 0.4;
const QE_PUMP_MIN = 1.3;
const QE_PUMP_MAX = 1.5;
/** 게임 캘린더 매월 1일 자동 입금 */
const MONTHLY_SALARY = 1_000_000;
/** 이 금액 미만이면 급전 알바 버튼 활성(게임 규칙) */
const EMERGENCY_JOB_CASH_THRESHOLD = 1_000_000;
/** 한강 급전 알바 매매 잠금(밀리초) — DB `emergency_han_river_job` 과 동일 */
const EMERGENCY_LOCK_MS = 15 * 60 * 1000;
/** 매매 수량은 DB(bigint 등)와 맞추기 위해 항상 정수(주)만 사용 */

/** 가격 하한(원): 0원 허용, 0원 이하는 상장폐지 처리 */
const MIN_STOCK_PRICE = 0;
const MAX_SAFE_WON = Number.MAX_SAFE_INTEGER;
/** 거래 수수료 0.25% — 매수 시 총액×1.0025, 매도 시 총액×0.9975 (RPC·클라이언트 동일) */
const TRADE_FEE_RATE = 0.0025;
const TRADE_FEE_MULT_BUY = 1 + TRADE_FEE_RATE;
const TRADE_FEE_MULT_SELL = 1 - TRADE_FEE_RATE;
/** 관심 종목(속보 푸시·피드 필터) 상한 */
const MAX_WATCHLIST_IDS = 3;
const FLEX_SHOP_ITEMS = [
  { id: "rolex", name: "롤렉스 시계", price: 50_000_000, icon: "⌚" },
  { id: "porsche", name: "포르쉐", price: 300_000_000, icon: "🏎️" },
  { id: "gangnamApt", name: "강남 아파트", price: 2_000_000_000, icon: "🏢" },
  { id: "signielPenthouse", name: "시그니엘 펜트하우스", price: 10_000_000_000, icon: "🏙️" },
];
const MARKET_TEMPERATURE_WEIGHTS = [
  { key: "hot", w: 0.2 },
  { key: "stable", w: 0.6 },
  { key: "cold", w: 0.2 },
];

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
/** 09:00 시초가 갭 중 즉시 반영 비율(나머지는 개장 직후 수 분에 걸쳐 급격히 추적) */
const OPEN_GAP_IMMEDIATE_FRAC_MIN = 0.28;
const OPEN_GAP_IMMEDIATE_FRAC_MAX = 0.42;
/** 개장 직후 갭 잔여분을 나눠 먹는 게임 분(틱) 수 범위 */
const OPEN_GAP_SPREAD_STEPS_MIN = 5;
const OPEN_GAP_SPREAD_STEPS_MAX = 10;

/** 갭 잔여 추적 진행 곡선(낮을수록 초반에 더 가파르게) */
function easedOpenGapFrac(immediateFrac, stepIndex, spreadSteps) {
  if (spreadSteps <= 0) return 1;
  const t = Math.min(1, Math.max(0, stepIndex / spreadSteps));
  return immediateFrac + (1 - immediateFrac) * Math.pow(t, 0.44);
}
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
  /** 초기 자금 지급 완료(중복 지급 방지) */
  hasReceivedStartingFund: false,
  /** 전일 마감 기준 총자산(현금+평가) */
  previousDayTotalAssets: INITIAL_CAPITAL,
  /** 당일 09:00 세션 시작 시점 순자산 — 일일 손익(입출금·대출 제외 목적) */
  sessionOpenNetWorthPl: INITIAL_CAPITAL,
  /** 은행 예치금/대출금 */
  bankDeposit: 0,
  bankLoan: 0,
  bankDepositRate: BANK_DAILY_DEPOSIT_RATE,
  bankLoanRate: BANK_DAILY_LOAN_RATE,
  /** 가장 비싼 플렉스 소비 아이템 */
  flexTopItemId: "",
};

let gameClockEverStarted = false;
let phoneClockIntervalId = null;

let newsFeedRevealTimers = [];

let messageHideTimer = null;
let messageDismissFadeTimer = null;

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

/** 재상장 시 상장가 — 동전주 100~500원 */
function randomRelistIpoPrice() {
  return 100 + Math.floor(Math.random() * 401);
}

function computeRelistCooldownMs() {
  const span =
    RELIST_COOLDOWN_CANDLE_TICKS_MIN +
    Math.floor(
      Math.random() *
        (RELIST_COOLDOWN_CANDLE_TICKS_MAX - RELIST_COOLDOWN_CANDLE_TICKS_MIN + 1)
    );
  return span * TICKS_PER_CANDLE * 1000;
}

function ensureIpoAnchorForStock(stockId, fallbackPrice) {
  const v = Number(fallbackPrice);
  const fb = Number.isFinite(v) && v > 0 ? Math.floor(v) : randomInitialPrice();
  if (!ipoListingPriceByStock[stockId] || ipoListingPriceByStock[stockId] <= 0) {
    ipoListingPriceByStock[stockId] = Math.max(100, fb);
  }
}

function clampStockPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return MIN_STOCK_PRICE;
  return Math.max(MIN_STOCK_PRICE, Math.floor(n));
}

/** 상장폐지(0원 이하) 상태 종목 추적 */
const delistedStocks = {};
/** 상장폐지 후 재상장 대기 상태 */
const pendingRelistingByStock = {};
const RELIST_ALERT_BEFORE_MS = 60 * 1000;
/** 종목별 초기 상장가(동전주 100~500 등) — 긴급 구조·QE·위기 판정 */
const ipoListingPriceByStock = {};
/** 상폐 한도로 1원에 고정된 틱 — 가상 매수 압력 제외 */
const survivedDelistCapAt1Won = {};
/** 1원 연속 유지 틱 — 좀비 청산 */
const consecutive1WonTicks = {};
/** 데드캣 바운스: bait(미끼) | armed(유저 매수 후 다음 틱 처형) */
const deadCatTrapState = {};
let qeCrisisLatchActive = false;
/** 100명 가상 유저 종목별 잔고(시뮬레이션) */
const virtualTraderHoldingsByStock = {};
/** 플레이어/군중 수급 압력(가격 엔진 반영) */
const tradePressureByStock = {};
const crowdFomoStateByStock = {};
const lastShockNewsOrdinalByStock = {};

function clampSafeInteger(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  if (v > MAX_SAFE_WON) return MAX_SAFE_WON;
  if (v < -MAX_SAFE_WON) return -MAX_SAFE_WON;
  return Math.trunc(v);
}

function safeMulInteger(a, b) {
  const av = clampSafeInteger(a, 0);
  const bv = clampSafeInteger(b, 0);
  return clampSafeInteger(av * bv, 0);
}

/** 구버전 market_state·손상 데이터로 NaN/누락 가격 복구 */
function repairInvalidStockPrices() {
  try {
    stocks.forEach((s) => {
      const v = Number(s?.price);
      if (!Number.isFinite(v) || v < 0) {
        s.price = randomInitialPrice();
        delistedStocks[s.id] = false;
      }
    });
    syncEtfPriceFromMarket();
  } catch (e) {
    console.warn("repairInvalidStockPrices", e);
  }
}

async function syncDelistedPortfolioToServer(stockId) {
  if (!onlineMode || !sb || !loginDisplayName) return;
  try {
    await sb
      .from(TBL_PORTFOLIOS)
      .upsert(
        {
          login_name: loginDisplayName,
          symbol: stockId,
          shares: 0,
          avg_cost: 0,
        },
        { onConflict: "login_name,symbol" }
      );
  } catch (e) {
    console.warn("syncDelistedPortfolioToServer", e);
  }
}

function burnDelistedShares(stockId, opts = {}) {
  const silent = opts.silent === true;
  const syncServer = opts.syncServer !== false;
  const heldBefore = Math.max(0, Math.floor(Number(game.holdings[stockId] ?? 0)));
  game.holdings[stockId] = 0;
  game.costBasis[stockId] = 0;
  virtualTraderHoldingsByStock[stockId] = 0;
  if (!silent && heldBefore > 0) {
    const nm = getStockById(stockId)?.name || stockId;
    const msg = `🚨 [상장폐지] 보유 중이던 ${nm} 주식이 휴짓조각이 되어 전량 소각되었습니다.`;
    addNewsItem(msg, "calendar", "", { stockId, global: true });
    setMessage(msg, "err");
  }
  if (syncServer) {
    void syncDelistedPortfolioToServer(stockId);
  }
}

function markStockDelisted(stockId) {
  if (!stockId || delistedStocks[stockId]) return;
  delistedStocks[stockId] = true;
  delete deadCatTrapState[stockId];
  const cd = computeRelistCooldownMs();
  const t0 = Date.now();
  pendingRelistingByStock[stockId] = {
    startedAt: t0,
    warnAt: t0 + cd - RELIST_ALERT_BEFORE_MS,
    relistAt: t0 + cd,
    warned: false,
  };
  const st = getStockById(stockId);
  if (st) st.price = 0;
  burnDelistedShares(stockId);
  if (Array.isArray(pendingOrders) && pendingOrders.length > 0) {
    pendingOrders = pendingOrders.filter((o) => o.symbol !== stockId);
    renderPendingOrdersUi();
  }
  addNewsItem(`[상장폐지] ${stockId} 주가가 0원 이하로 하락했습니다.`, "calendar", "", {
    stockId,
    global: true,
  });
}

function tryMarkStockDelisted(stockId, fallbackPrice = 1) {
  if (!stockId || delistedStocks[stockId]) return false;
  if (Math.random() < DELIST_PROBABILITY) {
    markStockDelisted(stockId);
    return true;
  }
  const s = getStockById(stockId);
  if (s && Number(s.price) <= 0) {
    s.price = Math.max(1, Math.floor(Number(fallbackPrice) || 1));
  }
  return false;
}

function executeRelisting(stockId) {
  const st = getStockById(stockId);
  if (!st) return;
  delistedStocks[stockId] = false;
  delete pendingRelistingByStock[stockId];
  delete deadCatTrapState[stockId];
  consecutive1WonTicks[stockId] = 0;

  const relistPx = randomRelistIpoPrice();
  ipoListingPriceByStock[stockId] = relistPx;
  st.price = relistPx;
  burnDelistedShares(stockId);
  sessionOpenPrice[stockId] = relistPx;
  prevTickPrice[stockId] = relistPx;
  candleHistory[stockId] = [];
  console.log(`[executeRelisting] cleared ${stockId} at ${Date.now()}`);
  delete openingGapBlendByStock[stockId];
  newsSpikeTicksLeft[stockId] = 0;
  newsSpikeDirection[stockId] = 1;
  newsSpikeMode[stockId] = "normal";
  delete newsSpikeExtremeTarget[stockId];
  if (candleOhlcBuffer[stockId]) {
    candleOhlcBuffer[stockId] = {
      o: relistPx,
      h: relistPx,
      l: relistPx,
    };
  }
  if (Array.isArray(pendingOrders) && pendingOrders.length > 0) {
    pendingOrders = pendingOrders.filter((o) => o.symbol !== stockId);
  }
  renderPendingOrdersUi();
  addNewsItem(
    `🎉 [IPO] ${st.name} 경영진 교체 후 화려한 부활! 신규 상장! (기준가 ${relistPx.toLocaleString("ko-KR")}원)`,
    "news",
    "",
    {
      stockId,
      global: true,
    }
  );
  setMessage(`🚀 ${st.name}(${stockId}) 재상장 · 기준가 ${formatWon(relistPx)}`, "ok");
  if (selectedStockId === stockId) {
    initDetailCharts(stockId);
  } else {
    refreshDetailChart();
  }
}

function processRelistingQueue() {
  const now = Date.now();
  STOCK_SPECS.forEach((spec) => {
    const id = spec.id;
    const state = pendingRelistingByStock[id];
    if (!state || !delistedStocks[id]) return;
    if (!state.warned && now >= state.warnAt) {
      state.warned = true;
      addNewsItem(`🚨 [공지] ${id} 종목의 재상장이 60초 후 시작됩니다!`, "calendar", "", {
        stockId: id,
        global: true,
      });
      setMessage(`🚨 [공지] ${id} 종목의 재상장이 60초 후 시작됩니다!`, "ok");
    }
    if (now >= state.relistAt) {
      executeRelisting(id);
    }
  });
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

function memeNewsEligibleSpec(spec) {
  if (!spec) return false;
  if (spec.kind === "etf" || spec.kind === "reit") return false;
  if (delistedStocks[spec.id]) return false;
  const st = getStockById(spec.id);
  if (!st || Math.floor(Number(st.price) || 0) <= 0) return false;
  return true;
}

function memeNewsEligibleId(id) {
  return memeNewsEligibleSpec(STOCK_SPECS.find((s) => s.id === id));
}

let saveDebounceId = null;

let sb = null;
let onlineMode = false;
let marketChannel = null;
/** 친구 풀매수/풀매도 Realtime */
let socialTradeChannel = null;
/** 개미지옥: trade_logs + users/portfolios Realtime */
let multiplayerChannel = null;
let mpTradeLogIdsSeen = new Set();
let mpLeaderboardDebounceId = null;
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

function startingFundGuardKey(nm) {
  return `${LS_STARTING_FUND_GUARD_PREFIX}${nm}`;
}

function readStartingFundGuard(nm) {
  try {
    return localStorage.getItem(startingFundGuardKey(nm)) === "1";
  } catch {
    return false;
  }
}

function writeStartingFundGuard(nm) {
  try {
    localStorage.setItem(startingFundGuardKey(nm), "1");
  } catch {
    /* ignore */
  }
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
/** 개장 직후 목표 시초가까지 분산 추적(한 틱에 한 단계) */
let openingGapBlendByStock = {};

/** 종목별 오늘 뉴스(체이닝) 건수 — 최대 6 */
let newsCountByStock = emptyChainState();
/** 체이닝 다음 스텝 인덱스 */
let chainStepByStock = emptyChainState();
/** 체결강도(100명 가상 유저 틱) */
const VIRTUAL_TRADER_COUNT = 100;
const executionFlowByStock = {};

const stocks = STOCK_SPECS.map((spec) => ({
  ...spec,
}));
STOCK_SPECS.forEach((spec) => {
  if (delistedStocks[spec.id] === undefined) delistedStocks[spec.id] = false;
  if (!executionFlowByStock[spec.id]) {
    executionFlowByStock[spec.id] = { buyVol: 1, sellVol: 1 };
  }
  if (tradePressureByStock[spec.id] === undefined) tradePressureByStock[spec.id] = 0;
  if (!crowdFomoStateByStock[spec.id]) crowdFomoStateByStock[spec.id] = { buyRush: 0, sellPanic: 0 };
});

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
/** extremeBull/Bear 구간에서 틱마다 접근할 목표 가격(다 틱에 도달) */
let newsSpikeExtremeTarget = {};

function resetNewsSpikeState() {
  newsSpikeTicksLeft = emptyChainState();
  newsSpikeExtremeTarget = {};
  STOCK_SPECS.forEach((s) => {
    newsSpikeDirection[s.id] = 1;
    newsSpikeMode[s.id] = "normal";
  });
}

/** 체이닝·일정 등: 페이로드 impact 부호로 방향만 쓰고, 3~5틱 급등·급락 스케줄 */
function scheduleNewsSpikeForStock(stockId, directionSign) {
  if (!getStockById(stockId) || isEtfId(stockId)) return;
  if (delistedStocks[stockId]) return;
  const st0 = getStockById(stockId);
  if (!st0 || Math.floor(Number(st0.price) || 0) <= 0) return;
  const ticks = 2 + Math.floor(Math.random() * 2);
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
  if (delistedStocks[stockId]) return;
  const s = getStockById(stockId);
  const p = Number(s.price);
  if (!Number.isFinite(p) || p <= 0) return;
  const spreadTicks = 2 + Math.floor(Math.random() * 2);
  newsSpikeTicksLeft[stockId] = Math.max(
    newsSpikeTicksLeft[stockId] || 0,
    spreadTicks
  );
  newsSpikeDirection[stockId] = positive ? 1 : -1;
  newsSpikeMode[stockId] = positive ? "extremeBull" : "extremeBear";
  if (positive) {
    newsSpikeExtremeTarget[stockId] = clampStockPrice(
      Math.floor(p * (1.4 + Math.random() * 1.0))
    );
  } else {
    newsSpikeExtremeTarget[stockId] = clampStockPrice(
      Math.max(1, Math.floor(p * (0.62 + Math.random() * 0.24)))
    );
  }
}

function pickWeightedMarketTemperature() {
  const total = MARKET_TEMPERATURE_WEIGHTS.reduce((a, b) => a + b.w, 0);
  let r = Math.random() * total;
  for (const it of MARKET_TEMPERATURE_WEIGHTS) {
    r -= it.w;
    if (r <= 0) return it.key;
  }
  return "stable";
}

function marketTemperatureLabel(key = marketTemperature) {
  if (key === "hot") return "과열기";
  if (key === "cold") return "침체기";
  return "안정기";
}

function setMarketTemperature(next, reason = "") {
  const allowed = next === "hot" || next === "stable" || next === "cold";
  const nv = allowed ? next : "stable";
  if (marketTemperature === nv) return;
  marketTemperature = nv;
  const rs = reason ? ` · ${reason}` : "";
  addNewsItem(`🌡️ [거시 브리핑] 시장 국면 전환 신호${rs}`, "news", "", {
    global: true,
  });
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

/** Detail view: candles & volume (canvas) */
const detailChartView = {
  stockId: null,
  chartRange: "d1",
  chartType: "candle",
};

let selectedStockId = null;
/** 상세 차트 기간: all | d1 | w1 | m1 (UI는 일·주·월) */
let detailChartRange = "d1";

/** 상세 차트 렌더 방어: 범위별 최대 포인트 수 */
const DETAIL_CHART_MAX_POINTS = {
  d1: 420, // 당일(10분봉) + 장중 진행 봉 여유
  w1: 1200,
  m1: 1600,
  all: 1800,
};
const DETAIL_CHART_SAMPLE_MAX_POINTS = 120;
const DETAIL_CHART_BUCKET_MINUTES_BY_RANGE = {
  d1: 10, // 10분봉(원본)
  w1: 60,
  m1: 240,
  all: 480,
};
const GAME_DAY_MS = 510_000; // 게임 1일(08:00~16:30) = 현실 510초
/** 상세 차트 탭별 표시 창(ms). all은 무한대(전체) */
const GAME_DAY_REAL_MS = 510_000;
const DETAIL_CHART_RANGE_MS = {
  d1: GAME_DAY_REAL_MS * 1,
  w1: GAME_DAY_REAL_MS * 7,
  m1: GAME_DAY_REAL_MS * 30,
  all: Infinity,
};
/** Sealed candle real-time span (ms) */
const DETAIL_CHART_REAL_CANDLE_MS = TICKS_PER_CANDLE * 1000;
/** 상세 캔버스 차트 팔레트 (상승=파랑, 하락=빨강) */
const DETAIL_CANVAS = {
  up: "#4a9eff",
  down: "#ff5b5b",
  volUp: "rgba(74,158,255,0.55)",
  volDown: "rgba(255,91,91,0.55)",
  ma5: "#ff7043",
  ma20: "#26a69a",
  grid: "rgba(255,255,255,0.07)",
  axis: "#8b95a8",
  cross: "rgba(255,255,255,0.25)",
};

let detailChartLiveBundle = null;

/** Detail canvas: X by bar index only (no swipe). */
const detailChartInteraction = {
  crossIdx: null,
};

/** Bars per screen: day 51, week 255, month 1020; all = null. */
const DETAIL_CHART_PAGE_SIZE = Object.freeze({
  d1: 51,
  w1: 255,
  m1: 1020,
  all: null,
});

/** Page into past for d1/w1/m1 (0 = newest). Unused for all. */
let detailChartPageIndex = 0;

const DETAIL_CHART_CANDLES_D1 = Math.max(
  1,
  Math.floor((MARKET_CLOSE_MIN - PREMARKET_START_MIN) / CANDLE_GAME_MINUTES)
); // 51
const DETAIL_CHART_CANDLES_W1 = DETAIL_CHART_CANDLES_D1 * 5; // 255
const DETAIL_CHART_CANDLES_M1 = 1020;

const DETAIL_SVG_MAIN_H = 210;
const DETAIL_SVG_VOL_H = 88;
const DETAIL_SVG_PAD_L = 8;
const DETAIL_SVG_PAD_R = 8;
const DETAIL_SVG_PAD_T = 14;
const DETAIL_SVG_PAD_B = 26;
/** 가로 스크롤 차트: 봉당 최소 픽셀(토스형 촘촘한 간격) */
const DETAIL_CHART_MIN_CANDLE_SLOT_PX = 6;

/** 상세 차트: candle | line */
let detailChartType = "candle";
/** 종목 상세 현재가 표시 직전 가격(틱 애니메이션) */
let detailLastShownPrice = null;

/** 관심 종목 티커 — 뉴스 가중치에 사용 */
let watchlistIds = [];
/** 시장 리스트 필터: all | mine */
let marketListFilterMode = "all";
let marketTemperature = "stable";

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
  if (!isUserDataLoaded) return;
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

function ensurePreviousDayAssetsBase() {
  const v = Number(playerProfile.previousDayTotalAssets);
  if (Number.isFinite(v) && v > 0) return v;
  return INITIAL_CAPITAL;
}

function snapshotPreviousDayTotalAssets() {
  const nw = sessionOpenNetWorthValue();
  playerProfile.previousDayTotalAssets = Math.max(0, Math.floor(Number(nw) || 0));
  schedulePersistUser();
}

function sessionOpenNetWorthValue() {
  const cash = Math.max(0, Math.floor(Number(game.cash) || 0));
  const dep = bankDepositAmount();
  const loan = bankLoanAmount();
  const pv = portfolioValue();
  return clampSafeInteger(cash + dep + pv - loan, 0);
}

function snapshotSessionOpenNetWorthForDailyPl() {
  playerProfile.sessionOpenNetWorthPl = sessionOpenNetWorthValue();
  schedulePersistUser();
}

function ensureSessionOpenNetWorthForDailyPl() {
  const v = Number(playerProfile.sessionOpenNetWorthPl);
  if (Number.isFinite(v) && v >= 0) return Math.max(0, Math.floor(v));
  return sessionOpenNetWorthValue();
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
  if (!it) return false;
  if (it.global) return true;
  if (!it.stockId) return false;
  return watchlistIds.includes(it.stockId);
}

function syncTradeButtons() {
  const penalty = isTradeBlockedByPenalty();
  // 정규장(09:00~15:30): 시장가 즉시 매매
  const canMarket = isRegularSession() && !penalty;
  // 정규장 + 시간외(15:30~16:30): 지정가 예약만 (isLimitOrderWindowAllowed)
  const canLimit = isLimitOrderWindowAllowed() && !penalty;
  // 메인 종목표 매수/매도: 항상 시장가 RPC → 정규장에서만
  const canTrade = canMarket;
  // 상세 매수/매도: 주문 유형에 따라 (시장가=정규장, 지정가=정규+시간외)
  const detailTradeOk =
    detailTradeOrderType === "limit" ? canLimit : canMarket;
  ["detailBtnBuy", "detailBtnSell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !detailTradeOk;
      el.classList.toggle("is-trade-locked", !detailTradeOk);
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
    requestAnimationFrame(() => document.getElementById("setupPlayerName")?.focus());
    return;
  }
  if (!isTutorialDone()) {
    showScreen("screen-tutorial");
    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    requestAnimationFrame(() => document.getElementById("btnTutorialDismiss")?.focus());
    return;
  }
  showScreen("screen-game");
  renderAssetSummary();
  renderLifeStatus();
  renderStocks();
  syncTradeButtons();
  startGameClockFromInit(false);
}

function renderLifeTab() {
  const salaryEl = document.getElementById("lifeSalaryInfo");
  const lockEl = document.getElementById("lifeTradeLockHint");
  const btn = document.getElementById("btnEmergencyHanRiver");
  if (salaryEl) {
    salaryEl.textContent = `매월 1일 자동 입금 ${formatWon(MONTHLY_SALARY)}`;
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
      profile: { hasReceivedStartingFund: true },
    });
    if (insErr) {
      if (insErr.code !== "23505") {
        return { ok: false, reason: insErr.message || "가입에 실패했습니다." };
      }
    }
  }

  saveSessionName(nm);
  writeStartingFundGuard(nm);
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
    profile: { hasReceivedStartingFund: true },
  });
  if (error && error.code !== "23505") {
    console.warn("ensureUserRowExists", error);
  }
}

async function ensureStartingFundGuardOnce(row, nm) {
  if (!row || !nm || !sb) return row;
  const prof = row.profile && typeof row.profile === "object" ? row.profile : {};
  const dbFlag = prof.hasReceivedStartingFund === true;
  const lsFlag = readStartingFundGuard(nm);
  const cashNum = Number(row.cash);
  const hasPositiveCash = Number.isFinite(cashNum) && cashNum > 0;

  if (hasPositiveCash) {
    if (!dbFlag) {
      const nextProfile = { ...prof, hasReceivedStartingFund: true };
      await sb
        .from(TBL_USERS)
        .update({ profile: nextProfile, updated_at: new Date().toISOString() })
        .eq("login_name", nm);
      row.profile = nextProfile;
    }
    writeStartingFundGuard(nm);
    return row;
  }

  if (dbFlag || lsFlag) {
    writeStartingFundGuard(nm);
    return row;
  }

  const nextProfile = { ...prof, hasReceivedStartingFund: true };
  await sb
    .from(TBL_USERS)
    .update({
      cash: INITIAL_CAPITAL,
      initial_capital: Number(row.initial_capital) || INITIAL_CAPITAL,
      profile: nextProfile,
      updated_at: new Date().toISOString(),
    })
    .eq("login_name", nm);
  row.cash = INITIAL_CAPITAL;
  row.initial_capital = Number(row.initial_capital) || INITIAL_CAPITAL;
  row.profile = nextProfile;
  writeStartingFundGuard(nm);
  return row;
}

async function loadUserFromServer() {
  if (!sb || !loginDisplayName) return;
  isUserDataLoaded = false;
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
  row = await ensureStartingFundGuardOnce(row, nm);
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
  playerProfile.hasReceivedStartingFund = prof.hasReceivedStartingFund === true;
  playerProfile.previousDayTotalAssets = Number.isFinite(Number(prof.previousDayTotalAssets))
    ? Math.max(0, Math.floor(Number(prof.previousDayTotalAssets)))
    : INITIAL_CAPITAL;
  playerProfile.sessionOpenNetWorthPl = Number.isFinite(Number(prof.sessionOpenNetWorthPl))
    ? Math.max(0, Math.floor(Number(prof.sessionOpenNetWorthPl)))
    : sessionOpenNetWorthValue();
  playerProfile.bankDeposit = Math.max(0, Math.floor(Number(prof.bankDeposit) || 0));
  playerProfile.bankLoan = Math.max(0, Math.floor(Number(prof.bankLoan) || 0));
  playerProfile.bankDepositRate = Number(prof.bankDepositRate) > 0
    ? Number(prof.bankDepositRate)
    : BANK_DAILY_DEPOSIT_RATE;
  playerProfile.bankLoanRate = Number(prof.bankLoanRate) > 0
    ? Number(prof.bankLoanRate)
    : BANK_DAILY_LOAN_RATE;
  playerProfile.flexTopItemId = typeof prof.flexTopItemId === "string" ? prof.flexTopItemId : "";
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
    ? prof.watchlist
        .filter((id) => STOCK_SPECS.some((s) => s.id === id))
        .slice(0, MAX_WATCHLIST_IDS)
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
    delistedStocks[spec.id] = false;
    delete pendingRelistingByStock[spec.id];
    virtualTraderHoldingsByStock[spec.id] = 0;
    executionFlowByStock[spec.id] = { buyVol: 1, sellVol: 1 };
  });
  (ports || []).forEach((p) => {
    game.holdings[p.symbol] = Math.max(0, Math.floor(Number(p.shares)));
    game.costBasis[p.symbol] = Math.max(0, clampSafeInteger(p.avg_cost, 0));
  });
  renderPlayerLoginBadge();
  renderJobScheduleUi();
  renderBankAndFlexUi();
  ensureTradeLockPolling();
  renderNewsFeedFromServer(serverNewsFeedItems);
  isUserDataLoaded = true;
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
  openingGapBlendByStock = {};
  if (m.openingGapBlendByStock && typeof m.openingGapBlendByStock === "object") {
    STOCK_SPECS.forEach((spec) => {
      if (spec.kind === "etf") return;
      const b = m.openingGapBlendByStock[spec.id];
      if (!b || typeof b !== "object") return;
      const anchor = Number(b.anchor);
      const target = Number(b.target);
      const nextIdx = Number(b.nextIdx);
      const totalSpread = Number(b.totalSpread);
      const imm = Number(b.immediateFrac);
      if (
        Number.isFinite(anchor) &&
        Number.isFinite(target) &&
        Number.isFinite(nextIdx) &&
        Number.isFinite(totalSpread) &&
        Number.isFinite(imm) &&
        totalSpread >= 1
      ) {
        openingGapBlendByStock[spec.id] = {
          anchor: clampStockPrice(Math.round(anchor)),
          target: clampStockPrice(Math.round(target)),
          nextIdx: Math.max(1, Math.floor(nextIdx)),
          totalSpread: Math.min(
            OPEN_GAP_SPREAD_STEPS_MAX,
            Math.max(OPEN_GAP_SPREAD_STEPS_MIN, Math.floor(totalSpread))
          ),
          immediateFrac: Math.min(0.55, Math.max(0.15, imm)),
        };
      }
    });
  }
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
  newsSpikeExtremeTarget = {};
  if (m.newsSpikeExtremeTarget && typeof m.newsSpikeExtremeTarget === "object") {
    STOCK_SPECS.forEach((spec) => {
      const v = Number(m.newsSpikeExtremeTarget[spec.id]);
      if (Number.isFinite(v) && v > 0) {
        newsSpikeExtremeTarget[spec.id] = clampStockPrice(Math.round(v));
      }
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
    if (!Number.isFinite(px) || px < 0) {
      s.price = randomInitialPrice();
      delistedStocks[spec.id] = false;
      delete pendingRelistingByStock[spec.id];
    } else {
      s.price = clampStockPrice(px);
      delistedStocks[spec.id] = s.price <= 0;
      if (delistedStocks[spec.id]) {
        burnDelistedShares(spec.id, { silent: true, syncServer: false });
        if (!pendingRelistingByStock[spec.id]) {
          const cd = computeRelistCooldownMs();
          const t0 = Date.now();
          pendingRelistingByStock[spec.id] = {
            startedAt: t0,
            warnAt: t0 + cd - RELIST_ALERT_BEFORE_MS,
            relistAt: t0 + cd,
            warned: false,
          };
        }
      } else {
        delete pendingRelistingByStock[spec.id];
      }
    }
  });
  repairInvalidStockPrices();

  STOCK_SPECS.forEach((spec) => {
    delete ipoListingPriceByStock[spec.id];
  });
  if (m.ipoListingPriceByStock && typeof m.ipoListingPriceByStock === "object") {
    Object.assign(ipoListingPriceByStock, m.ipoListingPriceByStock);
  }
  STOCK_SPECS.forEach((spec) => {
    ensureIpoAnchorForStock(spec.id, getStockById(spec.id)?.price);
  });

  STOCK_SPECS.forEach((spec) => {
    delete deadCatTrapState[spec.id];
    delete consecutive1WonTicks[spec.id];
  });
  if (m.deadCatTrapState && typeof m.deadCatTrapState === "object") {
    Object.assign(deadCatTrapState, m.deadCatTrapState);
  }
  if (m.consecutive1WonTicks && typeof m.consecutive1WonTicks === "object") {
    Object.assign(consecutive1WonTicks, m.consecutive1WonTicks);
  }
  qeCrisisLatchActive = m.qeCrisisLatchActive === true;

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
  renderAssetSummary();
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
    openingGapBlendByStock: JSON.parse(JSON.stringify(openingGapBlendByStock)),
    headlineImpulse,
    nextCalendarEventId,
    scheduledEvents: JSON.parse(JSON.stringify(scheduledEvents)),
    newsCountByStock: { ...newsCountByStock },
    chainStepByStock: { ...chainStepByStock },
    newsSpikeTicksLeft: { ...newsSpikeTicksLeft },
    newsSpikeDirection: { ...newsSpikeDirection },
    newsSpikeMode: { ...newsSpikeMode },
    newsSpikeExtremeTarget: { ...newsSpikeExtremeTarget },
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
    ipoListingPriceByStock: { ...ipoListingPriceByStock },
    deadCatTrapState: JSON.parse(JSON.stringify(deadCatTrapState)),
    consecutive1WonTicks: { ...consecutive1WonTicks },
    qeCrisisLatchActive,
  };
}

function advanceOneGameMinuteOnline() {
  processRelistingQueue();
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
  applyBankDailyAccrual();
  applyDailyStockDividends();
  snapshotPreviousDayTotalAssets();
  awaitingDayRoll = true;
  isMarketClosed = true;
  gameMinutes = MARKET_CLOSE_MIN;
  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close", "", {
    global: true,
  });
  schedulePersistUser();
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
  setMarketTemperature(pickWeightedMarketTemperature(), "일일 시장 순환");
  const { month, day } = getCalendarParts(gameDayIndex);
  addNewsItem(
    `${month}월 ${day}일 08:00 — 장 시작 전 · 프리마켓 뉴스를 확인하세요`,
    "news",
    "",
    { global: true }
  );
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
    subscribeMultiplayerRealtime();
    setMultiplyOfflineHints();
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
          if (st) {
            applyServerMarketState(st);
          } else {
            renderAssetSummary();
          }
          renderDateTimeLine();
          refreshDetailChart();
          renderStockListMain();
          updateDetailPriceLine();
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

/** display:none 해제 직후 목록·상세 차트 레이아웃이 0이었을 때 보정 */
function reflowGameScreenUi() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        renderDateTimeLine();
        renderCalendarUI();
        renderStockListMain();
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
        hasReceivedStartingFund: playerProfile.hasReceivedStartingFund === true,
        previousDayTotalAssets: Math.max(
          0,
          Math.floor(Number(playerProfile.previousDayTotalAssets) || 0)
        ),
        sessionOpenNetWorthPl: Math.max(
          0,
          Math.floor(Number(playerProfile.sessionOpenNetWorthPl) || 0)
        ),
        bankDeposit: bankDepositAmount(),
        bankLoan: bankLoanAmount(),
        bankDepositRate: Number(playerProfile.bankDepositRate) || BANK_DAILY_DEPOSIT_RATE,
        bankLoanRate: Number(playerProfile.bankLoanRate) || BANK_DAILY_LOAN_RATE,
        flexTopItemId: playerProfile.flexTopItemId || "",
        watchlist: watchlistIds.slice(0, MAX_WATCHLIST_IDS),
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
    { headline: "디자인 시안 100번째 수정 중 수석 디자이너 오열... '굴림체는 안 된다고 했잖아요'", impacts: { JBD: 0.007 }, bias: { JBD: 0.005 }, volFactor: 1.26 },
    "|�들:",
    { headline: "대표, 핀터레스트 켜놓고 영감 찾는 척하다 낮잠 자는 모습 포착돼", impacts: { JBD: 0.008 }, bias: { JBD: 0.006 }, volFactor: 1.28 },
    { headline: "디자인 팀 막내, PPT에 보노보노 넣었다가 해외 바이어에게 '아방가르드하다'며 극찬받아", impacts: { JBD: -0.007 }, bias: { JBD: -0.005 }, volFactor: 1.22 },
    { headline: "사옥 외벽 페인트칠, 페인트공의 수전증으로 의도치 않은 '그라데이션 예술' 탄생", impacts: { JBD: 0.006 }, bias: { JBD: 0.004 }, volFactor: 1.25 },
    { headline: "대표, 탕비실 믹스커피 비율 맞추는 데 하루 종일 집중... '이것이 진정한 황금비율'", impacts: { JBD: -0.008 }, bias: { JBD: -0.006 }, volFactor: 1.3 },
  ],
  SYW: [
    { headline: "테스트 비행 중이던 택배 드론, 비둘기 떼와 영역 싸움 벌이다 추락", impacts: { SYW: 0.009 }, bias: { SYW: 0.006 }, volFactor: 1.27 },
    { headline: "자율주행 킥보드, 지 혼자 한강 공원 편의점 앞까지 주행 후 배터리 방전", impacts: { SYW: -0.007 }, bias: { SYW: -0.005 }, volFactor: 1.23 },
    { headline: "CEO, '이제 걸어 다니는 시대는 끝났다' 선언 후 퇴근길 지하철에서 목격돼", impacts: { SYW: 0.008 }, bias: { SYW: 0.007 }, volFactor: 1.3 },
    { headline: "신형 드론, 배달 치킨 싣고 날아가다 갈매기 떼에게 격추당해 공중 분해", impacts: { SYW: -0.009 }, bias: { SYW: -0.006 }, volFactor: 1.26 },
    { headline: "자율주행 휠체어 개발 중... 최고 시속 80km로 측정돼 '노인 폭주족' 우려", impacts: { SYW: 0.007 }, bias: { SYW: 0.005 }, volFactor: 1.24 },
    { headline: "차세대 로켓 부스터, 실수로 대표실 의자에 장착... '승천하는 주가 기원'", impacts: { SYW: -0.008 }, bias: { SYW: -0.005 }, volFactor: 1.29 },
  ],
  MJS: [
    { headline: "VIP 케어 서비스에 '할머니 약손' 요법 도입... 만족도 500% 폭발", impacts: { MJS: 0.01 }, bias: { MJS: 0.007 }, volFactor: 1.32 },
    { headline: "신규 플랫폼 서버 다운... 원인은 서버실에서 라면 끓여 먹다 전원 뽑음", impacts: { MJS: -0.008 }, bias: { MJS: -0.006 }, volFactor: 1.28 },
    "|�들:",
    { headline: "AI 룸서비스 로봇, 길 잃고 인근 편의점에서 소주 사오다 적발돼", impacts: { MJS: -0.007 }, bias: { MJS: -0.005 }, volFactor: 1.22 },
    { headline: "VIP 스위트룸 변기 막힘... 배관공이 실수로 숨겨진 금괴 발견해 지분 떡상 논란", impacts: { MJS: 0.011 }, bias: { MJS: 0.008 }, volFactor: 1.33 },
    "|�들:",
  ],
  BSL: [
    { headline: "연구원 실수로 '민트초코맛 떡볶이' 소스 개발... 품절 대란 조짐", impacts: { BSL: 0.008 }, bias: { BSL: 0.005 }, volFactor: 1.23 },
    "|�들:",
    { headline: "랩실 냉장고에서 누군가 남겨둔 마카롱 도난 사건 발생, 팀워크 붕괴 우려", impacts: { BSL: 0.009 }, bias: { BSL: 0.006 }, volFactor: 1.26 },
    { headline: "숙취해소제 임상실험 중 부작용으로 '노래방 탬버린 1시간 무한 체력' 효과 발견", impacts: { BSL: -0.008 }, bias: { BSL: -0.005 }, volFactor: 1.29 },
    { headline: "랩실 탈출한 실험용 쥐, 인근 PC방에서 마우스 갉아먹다 현행범 체포", impacts: { BSL: 0.007 }, bias: { BSL: 0.005 }, volFactor: 1.24 },
    { headline: "수면 유도제 완벽 개발 성공! ...근데 개발팀 전원이 3일째 꿀잠 자느라 출근 안 함", impacts: { BSL: -0.009 }, bias: { BSL: -0.006 }, volFactor: 1.31 },
  ],
  SYG: [
    { headline: "공장장, 기어 윤활유 대신 실수로 참기름 발라... '고소한 냄새에 작업 능률 떡상'", impacts: { SYG: 0.009 }, bias: { SYG: 0.007 }, volFactor: 1.28 },
    { headline: "신형 정밀 모듈에서 알 수 없는 삐걱 소리 발생... 알고 보니 기계에 낀 귀뚜라미 탓", impacts: { SYG: -0.008 }, bias: { SYG: -0.005 }, volFactor: 1.25 },
    "|�들:",
    { headline: "부품 결함으로 톱니바퀴 역방향 회전... '시간 여행' 테마주로 편입되나?", impacts: { SYG: -0.007 }, bias: { SYG: -0.005 }, volFactor: 1.22 },
    "|�들:",
    "|�들:",
  ],
  JWF: [
    { headline: "펀드매니저, 점심시간에 도지코인 풀매수했다가 대표한테 걸려 시말서 작성", impacts: { JWF: 0.006 }, bias: { JWF: 0.005 }, volFactor: 1.18 },
    { headline: "투자 설명회 중 PPT 대신 본인 롤(LoL) 매드무비 재생하는 대참사 발생", impacts: { JWF: -0.006 }, bias: { JWF: -0.004 }, volFactor: 1.2 },
    { headline: "메인 서버에 몰래 비트코인 채굴기 연결한 인턴, 수익률 500% 달성해 본부장 특진", impacts: { JWF: 0.008 }, bias: { JWF: 0.006 }, volFactor: 1.24 },
    { headline: "AI 트레이딩 봇, 딥러닝 중 유튜브 알고리즘에 빠져 10시간째 먹방만 시청 중", impacts: { JWF: -0.007 }, bias: { JWF: -0.005 }, volFactor: 1.22 },
    { headline: "사내 체육대회 윷놀이에서 대표가 '빽도' 던진 후 펀드 수익률도 빽도 치는 중", impacts: { JWF: 0.007 }, bias: { JWF: 0.005 }, volFactor: 1.19 },
    { headline: "고객 수익률 방어용으로 '기도 메타' 도입... 전 직원 매일 아침 성수 뿌리며 출근", impacts: { JWF: -0.008 }, bias: { JWF: -0.005 }, volFactor: 1.25 },
  ],
  YHL: [
    { headline: "S/S 신상 컬렉션 '할매니얼 꽃무늬 몸빼바지', 파리 패션위크에서 기립박수 받아", impacts: { YHL: 0.009 }, bias: { YHL: 0.006 }, volFactor: 1.27 },
    { headline: "수석 디자이너, 츄리닝 입고 출근하다 정문 경비 아저씨한테 입구 컷 당해", impacts: { YHL: -0.007 }, bias: { YHL: -0.005 }, volFactor: 1.23 },
    { headline: "신상 '구멍 난 양말', 빈티지 감성으로 10만 원에 완판... '이게 패션이다'", impacts: { YHL: 0.008 }, bias: { YHL: 0.006 }, volFactor: 1.26 },
    { headline: "모델 피팅 중 바지 터지는 사고 발생... '트임 팬츠'로 이름 바꿔 출시 결의", impacts: { YHL: -0.008 }, bias: { YHL: -0.005 }, volFactor: 1.28 },
    { headline: "수석 디자이너, 영감 얻겠다고 3일 안 씻고 출근했다가 파리 떼 꼬여서 자체 모자이크", impacts: { YHL: 0.01 }, bias: { YHL: 0.007 }, volFactor: 1.3 },
    { headline: "차기작으로 '투명 망토' 콘셉트 발표했으나 그냥 옷 안 입은 거 아니냐는 논란 일어", impacts: { YHL: -0.009 }, bias: { YHL: -0.006 }, volFactor: 1.31 },
  ],
  SWB: [
    "|�들:",
    "|�들:",
    { headline: "최선웅 대표, 점심 메뉴 고르는 AI 개발하다 3박 4일째 짜장면 vs 짬뽕 무한 루프", impacts: { SWB: 0.008 }, bias: { SWB: 0.006 }, volFactor: 1.24 },
    { headline: "신입사원, 회식 자리에서 사장님 정수리에 소맥 제조... '강력한 MZ의 등장' 주가 요동", impacts: { SWB: -0.008 }, bias: { SWB: -0.005 }, volFactor: 1.26 },
    { headline: "B2B 메신저에 '오타 자동 완성' 기능 넣었더니 '부장님 사랑해요'가 '부장님 사퇴하세요'로 전송돼 서버 폭주", impacts: { SWB: 0.009 }, bias: { SWB: 0.006 }, volFactor: 1.28 },
    "|�들:",
  ],
};

/** 당일 완료 봉 수(1-based) — 종목당 체이닝 최대 6회 */
const CHAIN_SCHEDULE = {
  JBD: [3, 9, 15, 21, 27, 33],
  SYW: [4, 10, 16, 22, 28, 34],
  MJS: [5, 11, 17, 23, 29, 35],
  BSL: [3, 8, 14, 20, 26, 32],
  SYG: [4, 9, 15, 21, 27, 34],
  JWF: [5, 10, 16, 22, 28, 36],
  YHL: [6, 11, 17, 23, 29, 37],
  SWB: [7, 12, 18, 24, 30, 38],
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
    x:
      typeof r.x === "number" && Number.isFinite(r.x)
        ? r.x
        : candleDateMs(dayIndex, periodStartMin),
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

function candleDateMs(dayIndex, periodStartMin) {
  const d = new Date(2000, 3, 1, 0, 0, 0, 0);
  d.setDate(d.getDate() + Math.floor(Number(dayIndex) || 0));
  d.setMinutes(Math.floor(Number(periodStartMin) || 0), 0, 0);
  return d.getTime();
}

function detailChartRangeWindowMs(range) {
  const v = DETAIL_CHART_RANGE_MS[range];
  if (v === undefined || v === Infinity) return null;
  return v;
}

/** 정규장(09:00~15:30) 캔들만 연속 X — 야간·휴장 구간 생략 */
function chartSessionOrdinalFromRow(r) {
  const row = normalizeCandleRow(r);
  const day = Math.floor(Number(row.dayIndex));
  const m = Number(row.periodStartMin);
  if (!Number.isFinite(day)) return 0;
  let clamped = MARKET_OPEN_MIN;
  if (Number.isFinite(m)) {
    clamped = Math.max(
      MARKET_OPEN_MIN,
      Math.min(MARKET_REGULAR_CLOSE_MIN - 1, m)
    );
  }
  const offsetInDay = clamped - MARKET_OPEN_MIN;
  return day * SESSION_GAME_MINUTES + offsetInDay;
}

function detailChartRangeWindowOrdinal(range) {
  const DAY = SESSION_GAME_MINUTES;
  switch (range) {
    case "d1":
      return DAY;
    case "w1":
      return 5 * DAY;
    case "m1":
      return 22 * DAY;
    default:
      return null;
  }
}

function filterDetailChartRowsForRange(rows, range) {
  if (!rows || rows.length === 0) return [];
  const norm = rows.map((r) => normalizeCandleRow({ ...r }));
  norm.sort(
    (a, b) => chartSessionOrdinalFromRow(a) - chartSessionOrdinalFromRow(b)
  );
  if (range === "all") return norm;
  if (range === "d1") {
    let out = norm.filter((r) => r.dayIndex === gameDayIndex);
    if (out.length === 0 && norm.length > 0) {
      const lastDay = norm[norm.length - 1].dayIndex;
      out = norm.filter((r) => r.dayIndex === lastDay);
    }
    return out;
  }
  if (range === "w1") {
    const dMin = gameDayIndex - 4;
    return norm.filter((r) => r.dayIndex >= dMin && r.dayIndex <= gameDayIndex);
  }
  if (range === "m1") {
    const dMin = gameDayIndex - 21;
    return norm.filter((r) => r.dayIndex >= dMin && r.dayIndex <= gameDayIndex);
  }
  return norm;
}

function uniqueSortedSessionDaysFromRows(rows) {
  const set = new Set();
  rows.forEach((r) => {
    const d = Math.floor(Number(r.dayIndex));
    if (Number.isFinite(d)) set.add(d);
  });
  return Array.from(set).sort((a, b) => a - b);
}

function getDetailChartSessionDayCount(stockId) {
  try {
    const raw = buildFullCanvasRowsForScrollChart(stockId);
    if (!raw.length) return 0;
    const norm = raw.map((r) => normalizeCandleRow({ ...r }));
    return uniqueSortedSessionDaysFromRows(norm).length;
  } catch {
    return 0;
  }
}

function formatChartOrdinalAxisLabel(ord) {
  const o = Number(ord);
  if (!Number.isFinite(o)) return "—";
  const day = Math.floor(o / SESSION_GAME_MINUTES);
  const off = o - day * SESSION_GAME_MINUTES;
  const periodStartMin = MARKET_OPEN_MIN + off;
  return formatCandleXLabel(day, periodStartMin);
}

function getDetailChartHistoryFirstTs(stockId) {
  const rawHist = candleHistory[stockId] || [];
  let firstTs = Number(rawHist[0]?.timestamp);
  if (Number.isFinite(firstTs)) return firstTs;
  const x0 = Number(rawHist[0]?.x);
  if (Number.isFinite(x0)) return x0;
  return null;
}

function capDetailChartRows(rows, range) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const key = Object.prototype.hasOwnProperty.call(DETAIL_CHART_MAX_POINTS, range)
    ? range
    : "all";
  const cap = DETAIL_CHART_MAX_POINTS[key];
  if (!Number.isFinite(cap) || cap <= 0 || rows.length <= cap) return rows;
  return rows.slice(-cap);
}

function sampleRowsForDetailChart(rows, maxPoints = DETAIL_CHART_SAMPLE_MAX_POINTS) {
  if (!Array.isArray(rows) || rows.length <= maxPoints) return rows;
  const cap = Math.max(10, Math.floor(Number(maxPoints) || DETAIL_CHART_SAMPLE_MAX_POINTS));
  const out = [];
  const step = (rows.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i += 1) {
    const idx = Math.min(rows.length - 1, Math.round(i * step));
    out.push(rows[idx]);
  }
  return out;
}

function getFilteredCandleHistory(stockId) {
  const raw = candleHistory[stockId] || [];
  const range = detailChartRange || "all";
  const normalized = raw
    .map((r) => normalizeCandleRow({ ...r }))
    .filter((r) => isValidCandleRow(r));
  if (normalized.length === 0) return [];
  normalized.sort(
    (a, b) => Number(a.gameTimeOrdinal) - Number(b.gameTimeOrdinal)
  );
  return capDetailChartRows(normalized, range);
}

function isValidCandleRow(r) {
  if (!r || typeof r !== "object") return false;
  const nums = [r.o, r.h, r.l, r.c];
  if (!nums.every((v) => Number.isFinite(Number(v)))) return false;
  return Number.isFinite(Number(r.gameTimeOrdinal));
}

function aggFactorForDetailRange(range) {
  return DETAIL_CHART_BUCKET_MINUTES_BY_RANGE[range] || 10;
}

function aggregateCandleRows(rows, bucketMinutes) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const bucket = Math.max(10, Math.floor(Number(bucketMinutes) || 10));
  if (bucket <= 10) return rows.slice();
  const out = [];
  let grp = [];
  let grpKey = null;
  const flush = () => {
    if (grp.length === 0) return;
    const first = grp[0];
    const last = grp[grp.length - 1];
    const o = Number(first.o);
    const c = Number(last.c);
    let h = -Infinity;
    let l = Infinity;
    let v = 0;
    grp.forEach((r) => {
      h = Math.max(h, Number(r.h));
      l = Math.min(l, Number(r.l));
      v += Number(r.v) || 0;
    });
    out.push(
      normalizeCandleRow({
        dayIndex: last.dayIndex,
        periodStartMin: last.periodStartMin,
        gameTimeOrdinal: last.gameTimeOrdinal,
        x: candleDateMs(last.dayIndex, last.periodStartMin),
        o,
        h,
        l,
        c,
        v: Math.max(1, Math.floor(v)),
      })
    );
  };
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const ord = Number(r.gameTimeOrdinal);
    if (!Number.isFinite(ord)) continue;
    const key = Math.floor(ord / bucket);
    if (grpKey == null) {
      grpKey = key;
      grp.push(r);
      continue;
    }
    if (key !== grpKey) {
      flush();
      grp = [r];
      grpKey = key;
    } else {
      grp.push(r);
    }
  }
  flush();
  return out;
}

function buildPreparedDetailRows(stockId, opts = {}) {
  const range = detailChartRange || "all";
  const hist = getFilteredCandleHistory(stockId)
    .filter((r) => isValidCandleRow(r))
    .sort((a, b) => Number(a.gameTimeOrdinal) - Number(b.gameTimeOrdinal));
  const rows = hist.map((r) => normalizeCandleRow({ ...r }));
  if (
    !delistedStocks[stockId] &&
    tickInCandle > 0 &&
    isTradingWindowActive() &&
    gameMinutes < MARKET_CLOSE_MIN &&
    candleOhlcBuffer[stockId]
  ) {
    const b = candleOhlcBuffer[stockId];
    const s = getStockById(stockId);
    if (s) {
      rows.push(
        normalizeCandleRow({
          dayIndex: gameDayIndex,
          periodStartMin: candlePeriodStartMin,
          gameTimeOrdinal: gameTimeOrdinalFromParts(
            gameDayIndex,
            candlePeriodStartMin
          ),
          x: candleDateMs(gameDayIndex, candlePeriodStartMin),
          o: Math.floor(b.o),
          h: Math.floor(Math.max(b.h, s.price)),
          l: Math.floor(Math.min(b.l, s.price)),
          c: Math.floor(s.price),
          v: estimatePartialBarVolume(stockId),
        })
      );
    }
  }
  const bucketBase = aggFactorForDetailRange(range);
  const forced = Number(opts.forceBucketMinutes);
  const aggBucket =
    Number.isFinite(forced) && forced > 0 ? forced : bucketBase;
  const aggregated = aggregateCandleRows(rows, aggBucket);
  const sampled = sampleRowsForDetailChart(aggregated);
  if (sampled.length > 0) {
    return sampled.sort((a, b) => Number(a.x) - Number(b.x));
  }
  if (delistedStocks[stockId]) {
    const x = candleDateMs(gameDayIndex, gameMinutes);
    return [
      normalizeCandleRow({
        dayIndex: gameDayIndex,
        periodStartMin: gameMinutes,
        gameTimeOrdinal: gameTimeOrdinalFromParts(gameDayIndex, gameMinutes),
        x,
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 1,
      }),
    ].sort((a, b) => Number(a.x) - Number(b.x));
  }
  return sampled;
}

/** 전체 캔들 캔버스용: 기간 필터 없이(all) 준비 후 깊은 복사 + 시간 오름차순 정렬 */
function buildFullCanvasRowsForScrollChart(stockId) {
  const hist = (candleHistory[stockId] || [])
    .map((r) => normalizeCandleRow({ ...r }))
    .filter((r) => isValidCandleRow(r))
    .sort((a, b) => Number(a.gameTimeOrdinal) - Number(b.gameTimeOrdinal));
  const out = hist.map((r) => ({ ...r }));
  // 전체/1주/1달 기간 분리를 위해 원본 히스토리를 샘플링 없이 그대로 사용한다.
  if (
    !delistedStocks[stockId] &&
    tickInCandle > 0 &&
    isTradingWindowActive() &&
    gameMinutes < MARKET_CLOSE_MIN &&
    candleOhlcBuffer[stockId]
  ) {
    const b = candleOhlcBuffer[stockId];
    const s = getStockById(stockId);
    if (s) {
      out.push(
        normalizeCandleRow({
          dayIndex: gameDayIndex,
          periodStartMin: candlePeriodStartMin,
          gameTimeOrdinal: gameTimeOrdinalFromParts(
            gameDayIndex,
            candlePeriodStartMin
          ),
          x: candleDateMs(gameDayIndex, candlePeriodStartMin),
          timestamp: Date.now(),
          o: Math.floor(b.o),
          h: Math.floor(Math.max(b.h, s.price)),
          l: Math.floor(Math.min(b.l, s.price)),
          c: Math.floor(s.price),
          v: estimatePartialBarVolume(stockId),
        })
      );
    }
  }
  if (out.length === 0 && delistedStocks[stockId]) {
    out.push(
      normalizeCandleRow({
        dayIndex: gameDayIndex,
        periodStartMin: gameMinutes,
        gameTimeOrdinal: gameTimeOrdinalFromParts(gameDayIndex, gameMinutes),
        x: candleDateMs(gameDayIndex, gameMinutes),
        timestamp: Date.now(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 1,
      })
    );
  }
  return out.sort((a, b) => Number(a.gameTimeOrdinal) - Number(b.gameTimeOrdinal));
}

function getAvgCostForStock(stockId) {
  const sh = Math.max(0, Math.floor(Number(game.holdings[stockId] ?? 0)));
  if (sh <= 0) return null;
  const cb = Math.max(0, clampSafeInteger(game.costBasis[stockId] ?? 0, 0));
  const a = Math.floor(cb / sh);
  return Number.isFinite(a) && a > 0 ? a : null;
}

function buildDetailChartAnnotations(stockId) {
  const avg = getAvgCostForStock(stockId);
  const delisted = !!delistedStocks[stockId];
  const yaxis = [];
  if (avg == null) {
    if (!delisted) return { yaxis: [], xaxis: [] };
  } else {
    yaxis.push({
      y: avg,
      borderColor: "rgba(250, 204, 21, 0.9)",
      strokeDashArray: 6,
      label: {
        text: "평단",
        position: "left",
        textAnchor: "start",
        borderColor: "transparent",
        style: {
          color: "#facc15",
          fontSize: "10px",
          fontWeight: 600,
          background: "rgba(30, 30, 30, 0.7)",
        },
      },
    });
  }
  if (delisted) {
    yaxis.push({
      y: 0,
      borderColor: "rgba(99, 102, 241, 0.75)",
      strokeDashArray: 0,
      label: {
        text: "상장폐지 상태",
        position: "left",
        textAnchor: "start",
        borderColor: "transparent",
        style: {
          color: "#dbeafe",
          fontSize: "10px",
          fontWeight: 600,
          background: "rgba(31, 41, 55, 0.8)",
        },
      },
    });
  }
  return { yaxis, xaxis: [] };
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
    if (!r || (r !== "d1" && r !== "w1" && r !== "m1" && r !== "all")) return;
    detailChartRange = r;
    detailChartView.chartRange = r;
    syncDetailChartRangeButtons();
    if (selectedStockId) {
      initDetailCharts(selectedStockId, { logChartRange: true });
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

function isTradingSession() {
  return isTradingWindowActive();
}

function resetDailyNewsState() {
  newsCountByStock = emptyChainState();
  chainStepByStock = emptyChainState();
  specialEventsGenerator.resetDay();
}

function syncMarketListFilterButtons() {
  document.querySelectorAll("[data-market-filter]").forEach((b) => {
    const m = b.getAttribute("data-market-filter");
    b.classList.toggle("is-active", m === marketListFilterMode);
  });
}

function bindMarketListFilterUiOnce() {
  const bar = document.getElementById("marketListFilterBar");
  if (!bar || bar.dataset.bound === "1") return;
  bar.dataset.bound = "1";
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-market-filter]");
    if (!btn) return;
    const mode = btn.getAttribute("data-market-filter");
    if (mode !== "all" && mode !== "mine") return;
    if (marketListFilterMode === mode) return;
    marketListFilterMode = mode;
    syncMarketListFilterButtons();
    renderStockListMain();
  });
  syncMarketListFilterButtons();
}

function buildMiniSparklineSvg(stockId) {
  const st = getStockById(stockId);
  const rows = (candleHistory[stockId] || [])
    .slice(-24)
    .map((r) => normalizeCandleRow(r))
    .filter((r) => Number.isFinite(Number(r.c)));
  const vals = rows.map((r) => Number(r.c));
  if (vals.length === 0 && st) vals.push(Number(st.price) || 0);
  const width = 280;
  const height = 56;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const pts = vals
    .map((v, i) => {
      const x = vals.length <= 1 ? width / 2 : (i / (vals.length - 1)) * width;
      const y = height - ((v - min) / span) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = delistedStocks[stockId] ? "#94a3b8" : vals[vals.length - 1] >= vals[0] ? CANDLE_UP : CANDLE_DOWN;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts}" /></svg>`;
}

/** 상승/하락 편에 맞는 밈 헤드라인( impacts 부호 기준 ) */
function pickMemeHeadlineForPolarity(stockId, positive) {
  const chain = NEWS_CHAINS[stockId];
  if (!chain || chain.length === 0) {
    const s = getStockById(stockId);
    const name = s ? s.name : stockId;
    return positive
      ? `${name} 쪽에서 호재 소문이 돈다`
      : `${name} 쪽에서 악재 소문이 돈다`;
  }
  const pickFrom = chain.filter((story) => {
    const v = story.impacts[stockId];
    if (v === undefined || v === 0) return true;
    return positive ? v > 0 : v < 0;
  });
  const pool = pickFrom.length > 0 ? pickFrom : chain;
  return pool[Math.floor(Math.random() * pool.length)].headline;
}

function randomMemeHeadlineFromChain(stockId) {
  const chain = NEWS_CHAINS[stockId];
  if (!chain || chain.length === 0) return null;
  return chain[Math.floor(Math.random() * chain.length)].headline;
}

function buildPremarketHeadline(stockId, positive) {
  return pickMemeHeadlineForPolarity(stockId, positive);
}

/** 다음 거래일 08:00 진입 시: 종목별 호·악 뉴스 건수 및 08:00~08:50 분 단위 스케줄 */
function generatePremarketNewsPlan() {
  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  openingGapAppliedToday = false;
  openingGapBlendByStock = {};

  const events = [];
  STOCK_SPECS.forEach((spec) => {
    if (spec.kind === "etf" || spec.kind === "reit") {
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
  return pickMemeHeadlineForPolarity(stockId, positive);
}

/** 15:30~16:30 시간외 뉴스 스케줄(당일 1회 생성) */
function generateAfterHoursNewsPlan() {
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  afterHoursNewsScheduleByMin = {};
  const events = [];
  STOCK_SPECS.forEach((spec) => {
    if (spec.kind === "etf" || spec.kind === "reit") {
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
    const anchor = clampStockPrice(s.price);
    const target = clampStockPrice(Math.floor(anchor * mult));
    const immediateFrac =
      OPEN_GAP_IMMEDIATE_FRAC_MIN +
      Math.random() *
        (OPEN_GAP_IMMEDIATE_FRAC_MAX - OPEN_GAP_IMMEDIATE_FRAC_MIN);
    const spreadSteps =
      OPEN_GAP_SPREAD_STEPS_MIN +
      Math.floor(
        Math.random() *
          (OPEN_GAP_SPREAD_STEPS_MAX - OPEN_GAP_SPREAD_STEPS_MIN + 1)
      );
    if (target !== anchor) {
      s.price = clampStockPrice(
        Math.round(anchor + (target - anchor) * immediateFrac)
      );
      openingGapBlendByStock[spec.id] = {
        anchor,
        target,
        nextIdx: 1,
        totalSpread: spreadSteps,
        immediateFrac,
      };
    } else {
      s.price = anchor;
    }
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
  snapshotSessionOpenNetWorthForDailyPl();

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

function recordExecutionFlowTick(stockId, prevPrice, nextPrice) {
  if (!stockId) return;
  if (!executionFlowByStock[stockId]) {
    executionFlowByStock[stockId] = { buyVol: 1, sellVol: 1 };
  }
  const stFlow = getStockById(stockId);
  if (
    delistedStocks[stockId] ||
    !stFlow ||
    Math.floor(Number(stFlow.price) || 0) <= 0
  ) {
    return;
  }
  const flow = executionFlowByStock[stockId];
  flow.buyVol = Math.max(1, flow.buyVol * 0.86);
  flow.sellVol = Math.max(1, flow.sellVol * 0.86);

  if (survivedDelistCapAt1Won[stockId]) {
    delete survivedDelistCapAt1Won[stockId];
    for (let i = 0; i < VIRTUAL_TRADER_COUNT; i += 1) {
      const qty = 1 + Math.floor(Math.random() * 14);
      flow.sellVol += qty;
    }
    return;
  }

  const prev = Number(prevPrice);
  const next = Number(nextPrice);
  const momentum =
    Number.isFinite(prev) && prev > 0 && Number.isFinite(next)
      ? (next - prev) / prev
      : 0;
  const buyBias = Math.min(0.88, Math.max(0.12, 0.5 + momentum * 7.2));
  for (let i = 0; i < VIRTUAL_TRADER_COUNT; i += 1) {
    const qty = 1 + Math.floor(Math.random() * 14);
    if (Math.random() < buyBias) flow.buyVol += qty;
    else flow.sellVol += qty;
  }
}

function updateOrderBookAndStrength(stockId) {
  const wrap = document.getElementById("detailOrderBookRows");
  const bar = document.getElementById("detailExecStrengthBar");
  const pctEl = document.getElementById("detailExecStrengthPct");
  if (!wrap || !bar || !pctEl) return;
  const s = getStockById(stockId);
  if (!s) return;
  wrap.innerHTML =
    '<p class="detail-orderbook-hint" style="margin:0">호가 정보는 비공개입니다. 뉴스·차트·커뮤니티와 체결강도로 판단하세요.</p>';

  if (delistedStocks[stockId] || Math.floor(Number(s.price) || 0) <= 0) {
    pctEl.textContent = "—";
    bar.style.width = "0%";
    bar.classList.remove("is-hot", "is-cold");
    return;
  }

  const flow = executionFlowByStock[stockId] || { buyVol: 1, sellVol: 1 };
  const buyVol = Math.max(1, Number(flow.buyVol) || 1);
  const sellVol = Math.max(1, Number(flow.sellVol) || 1);
  const pct = Math.round((buyVol / sellVol) * 1000) / 10;
  pctEl.textContent = `${pct.toFixed(1)}%`;
  const barW = Math.min(150, Math.max(40, pct));
  bar.style.width = `${(barW / 150) * 100}%`;
  bar.classList.toggle("is-hot", pct >= 100);
  bar.classList.toggle("is-cold", pct < 100);
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
    const qty = Math.max(0, clampSafeInteger(game.holdings[s.id] ?? 0, 0));
    const px = Math.max(MIN_STOCK_PRICE, clampSafeInteger(s.price, MIN_STOCK_PRICE));
    v = clampSafeInteger(v + safeMulInteger(qty, px), 0);
  });
  return v;
}

function netWorth() {
  return sessionOpenNetWorthValue();
}

function bankDepositAmount() {
  return Math.max(0, Math.floor(Number(playerProfile.bankDeposit) || 0));
}

function bankLoanAmount() {
  return Math.max(0, Math.floor(Number(playerProfile.bankLoan) || 0));
}

function flexItemById(id) {
  return FLEX_SHOP_ITEMS.find((x) => x.id === id) || null;
}

function flexTopItemFromProfile(profileLike) {
  const pid = profileLike && typeof profileLike === "object" ? profileLike.flexTopItemId : "";
  return flexItemById(typeof pid === "string" ? pid : "");
}

function bankBorrowLimit() {
  const limit = Math.floor(netWorth() * BANK_MAX_LTV) - bankLoanAmount();
  return Math.max(0, limit);
}

function applyBankDailyAccrual() {
  const dep = bankDepositAmount();
  const loan = bankLoanAmount();
  const depRate = Number(playerProfile.bankDepositRate) || BANK_DAILY_DEPOSIT_RATE;
  const loanRate = Number(playerProfile.bankLoanRate) || BANK_DAILY_LOAN_RATE;
  const depInt = Math.max(0, Math.floor(dep * depRate));
  const loanInt = Math.max(0, Math.floor(loan * loanRate));
  if (depInt > 0) {
    playerProfile.bankDeposit = dep + depInt;
    addNewsItem(`🏦 [은행] 예금 이자 ${formatWon(depInt)}가 복리로 붙었습니다.`, "news", "", {
      global: true,
    });
  }
  if (loanInt > 0) {
    playerProfile.bankLoan = loan + loanInt;
    addNewsItem(`💣 [은행] 대출 이자 ${formatWon(loanInt)}가 불어나 빚이 커졌습니다.`, "news", "", {
      global: true,
    });
  }
  if (depInt > 0 || loanInt > 0) {
    schedulePersistUser();
  }
}

function applyDailyStockDividends() {
  let totalDiv = 0;
  stocks.forEach((s) => {
    if (isEtfId(s.id)) return;
    if (delistedStocks[s.id]) return;
    if (Math.floor(Number(s.price) || 0) < DAILY_DIVIDEND_MIN_PRICE) return;
    const q = Math.max(0, Math.floor(Number(game.holdings[s.id] || 0)));
    if (q <= 0) return;
    totalDiv += q * DAILY_DIVIDEND_PER_SHARE;
  });
  if (totalDiv <= 0) return;
  game.cash = Math.max(0, Math.floor(Number(game.cash) || 0) + totalDiv);
  addNewsItem(
    `💸 [일일 배당] 보유 주식 배당금 ${formatWon(totalDiv)} 지급 완료`,
    "dividend",
    "",
    { global: true }
  );
  schedulePersistUser();
}

function totalStockCost() {
  let t = 0;
  stocks.forEach((s) => {
    const q = Math.max(0, clampSafeInteger(game.holdings[s.id] ?? 0, 0));
    if (q <= 0) return;
    t = clampSafeInteger(t + Math.max(0, clampSafeInteger(game.costBasis[s.id] ?? 0, 0)), 0);
  });
  return t;
}

function stockEvalProfit() {
  let ev = 0;
  let cost = 0;
  stocks.forEach((s) => {
    const q = Math.max(0, clampSafeInteger(game.holdings[s.id] ?? 0, 0));
    if (q <= 0) return;
    const cb = Math.max(0, clampSafeInteger(game.costBasis[s.id] ?? 0, 0));
    const px = Math.max(MIN_STOCK_PRICE, clampSafeInteger(s.price, MIN_STOCK_PRICE));
    cost = clampSafeInteger(cost + cb, 0);
    ev = clampSafeInteger(ev + safeMulInteger(q, px), 0);
  });
  return { eval: ev, cost, pl: clampSafeInteger(ev - cost, 0) };
}

/** RPC `execute_sell_by_name` 와 동일한 실현손익(매도 직전 상태 기준) */
function computeRealizedProfitBeforeSell(stockId, qty) {
  const stock = getStockById(stockId);
  const sh = Math.max(0, Math.floor(Number(game.holdings[stockId] ?? 0)));
  const cb = Math.max(0, Math.floor(Number(game.costBasis[stockId] ?? 0)));
  const q = Math.max(0, Math.floor(Number(qty)));
  if (!stock || q <= 0 || sh < q) return 0;
  const px = Number(stock.price);
  if (!Number.isFinite(px) || px <= 0) return 0;
  const gain = Math.round(px * q * (1 - TRADE_FEE_RATE));
  let newCb;
  if (sh === q) {
    newCb = 0;
  } else {
    newCb = Math.round(cb * ((sh - q) / sh));
  }
  return gain - (cb - newCb);
}

async function insertTradeLogRow({ side, symbol, qty, price, profit }) {
  if (!sb || !onlineMode || !loginDisplayName) return;
  const display_name =
    (playerProfile.name && String(playerProfile.name).trim()) || loginDisplayName;
  const row = {
    login_name: loginDisplayName,
    display_name,
    side,
    symbol,
    qty: Math.max(1, Math.floor(Number(qty))),
    price: Math.max(0, Math.floor(Number(price))),
    profit:
      profit === null || profit === undefined
        ? null
        : Math.round(Number(profit)),
  };
  const { error } = await sb.from(TBL_TRADE_LOGS).insert(row);
  if (error) console.warn("insertTradeLogRow", error);
}

function tradeFeedItemClass(row) {
  if (row.side === "buy") return "mp-feed-item mp-feed-buy";
  const p = row.profit != null ? Number(row.profit) : 0;
  if (p > 0) return "mp-feed-item mp-feed-win";
  if (p < 0) return "mp-feed-item mp-feed-loss";
  return "mp-feed-item mp-feed-flat";
}

function tradeFeedLineHtml(row) {
  const name = escapeHtml(String(row.display_name || row.login_name || ""));
  const spec = stockSpecById(row.symbol);
  const sn = escapeHtml(spec ? spec.name : String(row.symbol));
  const price = Math.max(0, Math.floor(Number(row.price)));
  const qty = Math.max(0, Math.floor(Number(row.qty)));
  const priceStr = price.toLocaleString("ko-KR");
  if (row.side === "buy") {
    return `🔥 [뇌동매매] ${name}님이 ${sn}을(를) ${priceStr}원에 ${qty}주 매수했습니다.`;
  }
  const p = row.profit != null ? Math.round(Number(row.profit)) : 0;
  const absStr = Math.abs(p).toLocaleString("ko-KR");
  if (p > 0) {
    return `💰 [기만자] ${name}님이 ${sn}에서 +${absStr}원을 벌고 익절했습니다!`;
  }
  if (p < 0) {
    return `💀 [피눈물] ${name}님이 ${sn}에서 -${absStr}원을 잃고 빤스런했습니다...`;
  }
  return `📌 [본전] ${name}님이 ${sn} ${qty}주를 본전에 매도했습니다.`;
}

function createTradeFeedLi(row) {
  const li = document.createElement("li");
  li.className = tradeFeedItemClass(row);
  if (row.id != null) li.dataset.logId = String(row.id);
  li.innerHTML = tradeFeedLineHtml(row);
  return li;
}

function prependMultiplyTradeFeedRow(row) {
  const ul = document.getElementById("mpTradeFeed");
  if (!ul || row == null) return;
  const id = row.id != null ? String(row.id) : null;
  if (id && mpTradeLogIdsSeen.has(id)) return;
  if (id) mpTradeLogIdsSeen.add(id);
  if (mpTradeLogIdsSeen.size > 400) {
    mpTradeLogIdsSeen = new Set([...mpTradeLogIdsSeen].slice(-200));
  }
  ul.insertBefore(createTradeFeedLi(row), ul.firstChild);
  while (ul.children.length > 60) {
    const last = ul.lastChild;
    const lid = last?.dataset?.logId;
    if (lid) mpTradeLogIdsSeen.delete(lid);
    last.remove();
  }
}

const TRADE_TOAST_MAX_STACK = 6;
const TRADE_TOAST_VISIBLE_MS = 4600;

function tradeToastVariantClass(row) {
  if (row.side === "buy") return "trade-toast--buy";
  const p = row.profit != null ? Number(row.profit) : 0;
  if (p > 0) return "trade-toast--win";
  if (p < 0) return "trade-toast--loss";
  return "trade-toast--flat";
}

/** 다른 유저 매매만 우측 상단 토스트(본인 INSERT는 제외) */
function pushTradeLogToast(row) {
  if (!row || tutorialGateActive) return;
  if (!onlineMode || !sb) return;
  if (!loginDisplayName) return;
  const actor = String(row.login_name || "").trim();
  if (actor && actor === String(loginDisplayName).trim()) return;

  const stack = document.getElementById("tradeToastStack");
  if (!stack) return;

  const el = document.createElement("div");
  el.className = `trade-toast-item ${tradeToastVariantClass(row)}`;
  el.setAttribute("role", "status");
  el.innerHTML = tradeFeedLineHtml(row);

  stack.insertBefore(el, stack.firstChild);
  while (stack.children.length > TRADE_TOAST_MAX_STACK) {
    stack.lastChild?.remove();
  }

  requestAnimationFrame(() => {
    el.classList.add("trade-toast-item--visible");
  });

  window.setTimeout(() => {
    el.classList.remove("trade-toast-item--visible");
    el.classList.add("trade-toast-item--leaving");
    window.setTimeout(() => el.remove(), 400);
  }, TRADE_TOAST_VISIBLE_MS);
}

async function fetchMultiplyTradeLogsInitial() {
  if (!sb || !onlineMode) return;
  const ul = document.getElementById("mpTradeFeed");
  if (!ul) return;
  const { data, error } = await sb
    .from(TBL_TRADE_LOGS)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.warn("fetchMultiplyTradeLogsInitial", error);
    return;
  }
  mpTradeLogIdsSeen = new Set();
  ul.innerHTML = "";
  (data || []).forEach((row) => {
    if (row.id != null) mpTradeLogIdsSeen.add(String(row.id));
    ul.appendChild(createTradeFeedLi(row));
  });
}

function displayNameFromProfile(profile, loginName) {
  if (profile && typeof profile === "object" && profile.name) {
    const n = String(profile.name).trim();
    if (n) return n;
  }
  return loginName || "—";
}

async function refreshMultiplyLeaderboard() {
  const ol = document.getElementById("mpLeaderboard");
  const hintOff = document.getElementById("mpRankOfflineHint");
  if (!ol) return;
  if (!sb || !onlineMode) {
    ol.innerHTML = "";
    if (hintOff) hintOff.hidden = false;
    return;
  }
  if (hintOff) hintOff.hidden = true;
  const { data: userRows, error: uErr } = await sb
    .from(TBL_USERS)
    .select("login_name, cash, profile");
  const { data: portRows, error: pErr } = await sb
    .from(TBL_PORTFOLIOS)
    .select("login_name, symbol, shares, avg_cost");
  if (uErr || pErr) {
    console.warn("refreshMultiplyLeaderboard", uErr || pErr);
    return;
  }
  const byName = new Map();
  (userRows || []).forEach((u) => {
    byName.set(u.login_name, {
      login_name: u.login_name,
      cash: Math.max(0, Math.floor(Number(u.cash) || 0)),
      profile: u.profile,
      stockVal: 0,
    });
  });
  (portRows || []).forEach((p) => {
    const row = byName.get(p.login_name);
    if (!row) return;
    const st = getStockById(p.symbol);
    const sh = Math.max(0, Math.floor(Number(p.shares) || 0));
    if (!st || sh <= 0) return;
    row.stockVal += sh * st.price;
  });
  const list = [...byName.values()].map((r) => ({
    ...r,
    total: r.cash + r.stockVal,
    label: displayNameFromProfile(r.profile, r.login_name),
    flexTopItem: flexTopItemFromProfile(r.profile),
  }));
  list.sort((a, b) => b.total - a.total);
  ol.innerHTML = "";
  const n = list.length;
  list.forEach((r, idx) => {
    const rank = idx + 1;
    const li = document.createElement("li");
    li.className = "mp-leader-row";
    if (n > 1 && rank === 1) li.classList.add("mp-leader-row--first");
    if (n > 1 && rank === n) li.classList.add("mp-leader-row--last");
    const rankEl = document.createElement("span");
    rankEl.className = "mp-leader-rank";
    rankEl.textContent = `${rank}.`;
    const nameEl = document.createElement("span");
    nameEl.className = "mp-leader-name";
    nameEl.textContent = r.label;
    if (r.flexTopItem?.icon) {
      const badge = document.createElement("span");
      badge.className = "mp-leader-flex-badge";
      badge.textContent = r.flexTopItem.icon;
      nameEl.appendChild(badge);
    }
    const valEl = document.createElement("span");
    valEl.className = "mp-leader-value";
    valEl.textContent = formatWon(Math.round(r.total));
    li.appendChild(rankEl);
    li.appendChild(nameEl);
    li.appendChild(valEl);
    ol.appendChild(li);
  });
}

function scheduleMultiplyLeaderboardRefresh() {
  if (mpLeaderboardDebounceId) clearTimeout(mpLeaderboardDebounceId);
  mpLeaderboardDebounceId = setTimeout(() => {
    mpLeaderboardDebounceId = null;
    refreshMultiplyLeaderboard();
  }, 320);
}

function setMultiplyOfflineHints() {
  const rankHint = document.getElementById("mpRankOfflineHint");
  const show = !onlineMode || !sb;
  if (rankHint) rankHint.hidden = !show;
}

function subscribeMultiplayerRealtime() {
  if (!sb || !onlineMode) return;
  if (multiplayerChannel) {
    sb.removeChannel(multiplayerChannel);
    multiplayerChannel = null;
  }
  multiplayerChannel = sb
    .channel("multiply_live")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TBL_USERS,
      },
      () => scheduleMultiplyLeaderboardRefresh()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TBL_PORTFOLIOS,
      },
      () => scheduleMultiplyLeaderboardRefresh()
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        scheduleMultiplyLeaderboardRefresh();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("multiply channel", status);
      }
    });
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
  if (delistedStocks[stockId] || Number(stock.price) <= 0) {
    return { ok: false, reason: "상장폐지된 종목은 매수할 수 없습니다." };
  }
  const execPx = Math.floor(Number(stock.price));

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
  addTradePressure(stockId, "buy", q);
  schedulePersistUser();
  await insertTradeLogRow({
    side: "buy",
    symbol: stockId,
    qty: q,
    price: execPx,
    profit: null,
  });
  if (deadCatTrapState[stockId]?.phase === "bait") {
    deadCatTrapState[stockId] = { phase: "armed" };
  }
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
  if (delistedStocks[stockId] || Number(stock.price) <= 0) {
    return { ok: false, reason: "상장폐지된 종목은 매도할 수 없습니다." };
  }
  const execPx = Math.floor(Number(stock.price));
  const realizedPl = computeRealizedProfitBeforeSell(stockId, q);

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
  addTradePressure(stockId, "sell", q);
  schedulePersistUser();
  await insertTradeLogRow({
    side: "sell",
    symbol: stockId,
    qty: q,
    price: execPx,
    profit: realizedPl,
  });
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
      if (!Number.isFinite(px) || px <= 0 || delistedStocks[o.symbol]) {
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
      if (delistedStocks[spec.id]) return;
      const p = Number(st.price);
      if (!Number.isFinite(p) || p <= 0) return;
      sum += p;
      n += 1;
    });
    if (n > 0) {
      const target = Math.floor(sum / n);
      const prev = Number(etf.price);
      if (Number.isFinite(prev) && prev > 0) {
        const stepCap = Math.max(2, Math.floor(prev * 0.028));
        const d = target - prev;
        etf.price = clampStockPrice(
          prev + Math.max(-stepCap, Math.min(stepCap, d))
        );
      } else {
        etf.price = clampStockPrice(target);
      }
    } else {
      etf.price = 0;
    }
  } catch (e) {
    console.warn("syncEtfPriceFromMarket", e);
  }
}

function randomSignedDeltaByPct(price, minPct, maxPct) {
  const p = Math.max(0, Math.floor(Number(price) || 0));
  if (p <= 0) return 0;
  const lo = Math.max(0.0001, Number(minPct) || 0.01);
  const hi = Math.max(lo, Number(maxPct) || lo);
  const pct = lo + Math.random() * (hi - lo);
  const mag = Math.max(1, Math.floor(p * pct));
  return (Math.random() < 0.5 ? -1 : 1) * mag;
}

function addTradePressure(stockId, side, qty) {
  if (!stockId || side == null) return;
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) return;
  const sign = side === "buy" ? 1 : -1;
  tradePressureByStock[stockId] =
    (Number(tradePressureByStock[stockId]) || 0) + sign * q * 2.2;
}

function maybeEmitShockTicker(stockId, pctMove) {
  const absPct = Math.abs(Number(pctMove) || 0);
  if (absPct < 30) return;
  const nowOrd = gameTimeOrdinalFromParts(gameDayIndex, gameMinutes);
  const last = Number(lastShockNewsOrdinalByStock[stockId]) || -Infinity;
  if (nowOrd - last < 20) return;
  lastShockNewsOrdinalByStock[stockId] = nowOrd;
  const nm = getStockById(stockId)?.name || stockId;
  if (pctMove > 0) {
    addNewsItem(
      `🔥 [속보] ${nm} ${pctMove.toFixed(1)}% 폭등! 상한가 근접, 개미들 단체 환호`,
      "news",
      "",
      { stockId, global: true }
    );
  } else {
    addNewsItem(
      `💀 [긴급] ${nm} ${Math.abs(pctMove).toFixed(1)}% 급락! 투매 발생, 호가창 비명`,
      "news",
      "",
      { stockId, global: true }
    );
  }
}

function maybeRescueDelistCandidate(stockId) {
  const s = getStockById(stockId);
  if (!s || delistedStocks[stockId]) return false;
  const px = Math.max(0, Math.floor(Number(s.price) || 0));
  if (px > 100) return false;
  const anchor = Math.max(
    100,
    Number(ipoListingPriceByStock[stockId]) ||
      Number(sessionOpenPrice[stockId]) ||
      100
  );
  const deepCrash =
    px <= 10 || (anchor > 0 && px <= anchor * (1 - 0.85));
  let p = marketTemperature === "hot" ? 0.2 : marketTemperature === "cold" ? 0.5 : 0.35;
  if (deepCrash) {
    p = Math.min(p, RESCUE_PROB_CAP_DEEP_CRASH);
  }
  if (Math.random() >= p) return false;
  const isMna = Math.random() < 0.5;
  const jumpPct = isMna ? 0.7 + Math.random() * 1.1 : 0.35 + Math.random() * 0.7;
  const base = Math.max(100, px);
  s.price = clampStockPrice(base + Math.max(20, Math.floor(base * jumpPct)));
  addNewsItem(
    isMna
      ? `🚨 [긴급] ${s.name} 적대적 M&A설 급부상! 상장폐지 위기서 극적 반등`
      : `🏦 [긴급지원] ${s.name} 상장 유지 지원금 투입! 급한 불 진화`,
    "news",
    "",
    { stockId, global: true }
  );
  return true;
}

function maybeApplyCentralBankQE() {
  const listable = stocks.filter(
    (s) => !isEtfId(s.id) && !isReitId(s.id) && !delistedStocks[s.id]
  );
  if (listable.length === 0) return;
  const crisisIds = [];
  listable.forEach((s) => {
    const px = Math.max(0, Math.floor(Number(s.price) || 0));
    const anchor = Math.max(
      100,
      Number(ipoListingPriceByStock[s.id]) ||
        Number(sessionOpenPrice[s.id]) ||
        100
    );
    const isCrisis =
      px <= QE_CRISIS_PRICE_MAX || (anchor > 0 && px <= anchor * QE_CRISIS_DROP_FRAC);
    if (isCrisis) crisisIds.push(s.id);
  });
  const ratio = crisisIds.length / listable.length;
  if (ratio < 0.22) {
    qeCrisisLatchActive = false;
  }
  if (ratio < QE_CRISIS_MASS_RATIO || qeCrisisLatchActive) return;
  qeCrisisLatchActive = true;
  marketTemperature = "hot";
  addNewsItem(
    "🚨 [긴급속보] 중앙은행 무제한 양적완화 발표! 시장에 돈 푼다!",
    "news",
    "",
    { global: true }
  );
  addNewsItem(
    `🌡️ [시장 온도] ${marketTemperatureLabel("hot")} 진입 · 시스템 위기 대응(QE)`,
    "news",
    "",
    { global: true }
  );
  const crisisSet = new Set(crisisIds);
  listable.forEach((s) => {
    if (crisisSet.has(s.id)) return;
    const mult = QE_PUMP_MIN + Math.random() * (QE_PUMP_MAX - QE_PUMP_MIN);
    s.price = clampStockPrice(Math.floor(Number(s.price) * mult));
  });
}

/** 1원 좀비·데드캣(미끼) — 메인 틱 가격 확정 후 */
function applyPennyStockMicroRules() {
  stocks.forEach((s) => {
    const id = s.id;
    if (isEtfId(id) || isReitId(id) || delistedStocks[id]) return;
    const px = Math.max(0, Math.floor(Number(s.price) || 0));
    if (px !== 1) {
      consecutive1WonTicks[id] = 0;
      return;
    }
    const n = (consecutive1WonTicks[id] || 0) + 1;
    if (n >= 3) {
      tryMarkStockDelisted(id, 1);
      return;
    }
    consecutive1WonTicks[id] = n;
    if (deadCatTrapState[id] || n > 2) return;
    if (Math.random() < 0.2) {
      const bounce = 2 + Math.floor(Math.random() * 4);
      s.price = bounce;
      deadCatTrapState[id] = { phase: "bait" };
      consecutive1WonTicks[id] = 0;
      const nm = getStockById(id)?.name || id;
      addNewsItem(
        `🍀 [단독] ${nm} 유상증자 철회·채권단 '잠정 양호'… 단기 급등 주의`,
        "news",
        "",
        { stockId: id, global: true }
      );
    }
  });
}

/**
 * 평상시: 틱당 가격대 비례 무작위 횡보. 뉴스 스파이크: 틱당 대폭 변동.
 * REIT: 정규장 대비 낮은 변동. ETF: 별도 동기화.
 */
function oneMicroPriceStep() {
  let delistedThisTick = 0;
  stocks.forEach((s) => {
    const id = s.id;
    if (isEtfId(id)) return;
    if (deadCatTrapState[id]?.phase === "armed" && !delistedStocks[id]) {
      tryMarkStockDelisted(id, 1);
      delete deadCatTrapState[id];
    }
  });

  stocks.forEach((s) => {
    const id = s.id;
    if (isEtfId(id)) return;
    const prevPrice = Number(s.price);
    if (delistedStocks[id]) {
      s.price = 0;
      recordExecutionFlowTick(id, prevPrice, s.price);
      return;
    }

    const gapBlend = openingGapBlendByStock[id];
    const flowRaw = Number(tradePressureByStock[id]) || 0;
    tradePressureByStock[id] = flowRaw * 0.82;
    if (gapBlend && typeof gapBlend === "object") {
      const {
        anchor,
        target,
        nextIdx,
        totalSpread,
        immediateFrac,
      } = gapBlend;
      const ni = Math.floor(Number(nextIdx)) || 1;
      const ts = Math.max(1, Math.floor(Number(totalSpread)) || 1);
      const imm = Number(immediateFrac);
      if (
        Number.isFinite(anchor) &&
        Number.isFinite(target) &&
        Number.isFinite(imm) &&
        ni <= ts
      ) {
        const frac = easedOpenGapFrac(imm, ni, ts);
        s.price = clampStockPrice(Math.round(anchor + (target - anchor) * frac));
        if (s.price <= 0) {
          tryMarkStockDelisted(id, 1);
          delete openingGapBlendByStock[id];
          recordExecutionFlowTick(id, prevPrice, s.price);
          return;
        }
        if (ni >= ts) {
          delete openingGapBlendByStock[id];
        } else {
          gapBlend.nextIdx = ni + 1;
        }
        recordExecutionFlowTick(id, prevPrice, s.price);
        return;
      }
      delete openingGapBlendByStock[id];
    }

    const spikeLeft = newsSpikeTicksLeft[id] ?? 0;
    const mode = newsSpikeMode[id] || "normal";
    if (spikeLeft > 0) {
      newsSpikeTicksLeft[id] = spikeLeft - 1;
      if (mode === "extremeBull" || mode === "extremeBear") {
        const tgt = newsSpikeExtremeTarget[id];
        if (tgt != null && Number.isFinite(tgt)) {
          const leftAfter = newsSpikeTicksLeft[id];
          if (leftAfter <= 0) {
            s.price = clampStockPrice(Math.round(tgt));
          } else {
            const alpha = 0.12 + Math.random() * 0.08;
            s.price = clampStockPrice(
              Math.round(s.price + (tgt - s.price) * alpha)
            );
          }
          if (s.price <= 0) {
            tryMarkStockDelisted(id, 1);
            newsSpikeMode[id] = "normal";
            delete newsSpikeExtremeTarget[id];
            recordExecutionFlowTick(id, prevPrice, s.price);
            return;
          }
          if (leftAfter <= 0) {
            newsSpikeMode[id] = "normal";
            delete newsSpikeExtremeTarget[id];
          }
          recordExecutionFlowTick(id, prevPrice, s.price);
          return;
        }
        newsSpikeMode[id] = "normal";
        delete newsSpikeExtremeTarget[id];
      }
      const up = (newsSpikeDirection[id] ?? 1) >= 0;
      const absDelta = Math.max(
        1,
        Math.floor((s.price || 0) * (0.004 + Math.random() * 0.012))
      );
      const deltaRaw = up ? absDelta : -absDelta;
      const spikeCap = Math.max(2, Math.floor((Number(prevPrice) || 0) * 0.03));
      const delta = Math.max(-spikeCap, Math.min(spikeCap, deltaRaw));
      s.price = clampStockPrice(s.price + delta);
      if (s.price <= 0) {
        const rescued = maybeRescueDelistCandidate(id);
        if (!rescued) {
          if (delistedThisTick < MAX_DELIST_PER_TICK) {
            if (tryMarkStockDelisted(id, 1)) delistedThisTick += 1;
          } else {
            s.price = 1;
            survivedDelistCapAt1Won[id] = true;
          }
        }
      }
      const pct = prevPrice > 0 ? ((s.price - prevPrice) / prevPrice) * 100 : 0;
      maybeEmitShockTicker(id, pct);
      recordExecutionFlowTick(id, prevPrice, s.price);
      return;
    }

    let delta = 0;
    const buf = candleOhlcBuffer[id];
    const anchor = Number(buf?.o) || prevPrice || s.price;
    const pulsePct = anchor > 0 ? ((Number(s.price) - anchor) / anchor) * 100 : 0;
    const fomoState = crowdFomoStateByStock[id] || { buyRush: 0, sellPanic: 0 };
    if (pulsePct >= 8.0) {
      fomoState.buyRush = Math.max(fomoState.buyRush, 2 + Math.floor(Math.random() * 3));
      fomoState.sellPanic = Math.max(0, fomoState.sellPanic - 1);
    } else if (pulsePct <= -8.0) {
      fomoState.sellPanic = Math.max(fomoState.sellPanic, 2 + Math.floor(Math.random() * 3));
      fomoState.buyRush = Math.max(0, fomoState.buyRush - 1);
    } else {
      fomoState.buyRush = Math.max(0, fomoState.buyRush - 1);
      fomoState.sellPanic = Math.max(0, fomoState.sellPanic - 1);
    }
    crowdFomoStateByStock[id] = fomoState;

    const volScale =
      marketTemperature === "hot" ? 1.35 : marketTemperature === "cold" ? 0.72 : 1.0;
    if (isReitId(id)) {
      delta = randomSignedDeltaByPct(s.price, 0.011 * volScale, 0.026 * volScale);
    } else {
      delta = randomSignedDeltaByPct(s.price, 0.012 * volScale, 0.032 * volScale);
      if (Math.random() < (marketTemperature === "hot" ? 0.04 : 0.02)) {
        const kick = Math.max(
          1,
          Math.floor((s.price || 0) * ((0.008 + Math.random() * 0.022) * volScale))
        );
        delta += (Math.random() < 0.5 ? -1 : 1) * kick;
      }
    }
    if (s.price <= 3 && Math.random() < 0.12) {
      delta -= 1;
    }

    const liquidity = Math.max(3000, Math.floor((Number(s.price) || 0) * 38));
    const pressureDelta = Math.trunc(
      (flowRaw / liquidity) * Math.max(8, (s.price || 0) * 0.1)
    );
    delta += pressureDelta;

    const irrationalCount = Math.max(1, Math.floor(VIRTUAL_TRADER_COUNT * (1 - RATIONAL_TRADER_RATIO)));
    const rationalCount = Math.max(1, VIRTUAL_TRADER_COUNT - irrationalCount);
    if (fomoState.buyRush > 0) {
      const maniaQty = irrationalCount * (30 + Math.floor(Math.random() * 90));
      const maniaDelta = Math.max(1, Math.floor((maniaQty / liquidity) * Math.max(9, (s.price || 0) * 0.2)));
      delta += maniaDelta;
      const rationalTakeProfitQty = rationalCount * (20 + Math.floor(Math.random() * 70));
      const rationalDelta = Math.max(1, Math.floor((rationalTakeProfitQty / liquidity) * Math.max(7, (s.price || 0) * 0.12)));
      delta -= rationalDelta;
      fomoState.buyRush -= 1;
    } else if (fomoState.sellPanic > 0) {
      const panicQty = irrationalCount * (35 + Math.floor(Math.random() * 100));
      const panicDelta = Math.max(1, Math.floor((panicQty / liquidity) * Math.max(9, (s.price || 0) * 0.24)));
      delta -= panicDelta;
      const rationalDipBuyQty = rationalCount * (20 + Math.floor(Math.random() * 80));
      const rationalDelta = Math.max(1, Math.floor((rationalDipBuyQty / liquidity) * Math.max(7, (s.price || 0) * 0.11)));
      delta += rationalDelta;
      fomoState.sellPanic -= 1;
    }

    const upCap = Math.max(2, Math.floor((Number(prevPrice) || 0) * 0.07));
    const dnCap = Math.max(2, Math.floor((Number(prevPrice) || 0) * 0.08));
    delta = Math.max(-dnCap, Math.min(upCap, delta));
    s.price = clampStockPrice(s.price + delta);
    if (s.price <= 0) {
      const rescued = maybeRescueDelistCandidate(id);
      if (!rescued) {
        if (delistedThisTick < MAX_DELIST_PER_TICK) {
          if (tryMarkStockDelisted(id, 1)) delistedThisTick += 1;
        } else {
          s.price = 1;
          survivedDelistCapAt1Won[id] = true;
        }
      }
    }
    const pct = prevPrice > 0 ? ((s.price - prevPrice) / prevPrice) * 100 : 0;
    maybeEmitShockTicker(id, pct);
    recordExecutionFlowTick(id, prevPrice, s.price);
  });
  applyPennyStockMicroRules();
  maybeApplyCentralBankQE();
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
    timestamp: Date.now(),
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
  tryFireMutantNewsEvent(completed);
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
  const rows = buildPreparedDetailRows(stockId).map((r) => ({
    x: r.x,
    y: [
      Math.floor(r.o),
      Math.floor(r.h),
      Math.floor(r.l),
      Math.floor(r.c),
    ],
  }));
  return rows.filter(
    (p) =>
      Number.isFinite(Number(p.x)) &&
      Array.isArray(p.y) &&
      p.y.length === 4 &&
      p.y.every((v) => Number.isFinite(Number(v)))
  );
}

function buildVolumeSeriesData(stockId) {
  const rows = buildPreparedDetailRows(stockId).map((r) => {
    const up = r.c >= r.o;
    return {
      x: r.x,
      y: r.v,
      fillColor: up ? CANDLE_UP : CANDLE_DOWN,
    };
  });
  return rows.filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
}

function getDetailChartCategoriesAndCandleSeries(stockId) {
  const points = buildCandleSeriesData(stockId);
  const candleSeriesData = points.map((p) => ({
    x: detailChartDatetimeFormatter(p.x),
    y: p.y,
  }));
  return {
    categories: points.map((p) => detailChartDatetimeFormatter(p.x)),
    candleSeriesData,
  };
}

/** 종가 기준 선차트 — X 라벨은 캔들과 동일한 시계열 */
function buildLineSeriesData(stockId) {
  const rows = buildPreparedDetailRows(stockId).map((r) => ({
    x: detailChartDatetimeFormatter(r.x),
    y: Math.floor(r.c),
  }));
  return rows.filter((p) => typeof p.x === "string" && Number.isFinite(Number(p.y)));
}

function detailLineStrokeColor(stockId) {
  const pts = buildLineSeriesData(stockId);
  if (pts.length < 2) return CANDLE_UP;
  const a = pts[0].y;
  const b = pts[pts.length - 1].y;
  return b >= a ? CANDLE_UP : CANDLE_DOWN;
}

function computeDetailChartYBounds(stockId) {
  const avg = getAvgCostForStock(stockId);
  let min = Infinity;
  let max = -Infinity;
  if (detailChartType === "line") {
    const pts = buildLineSeriesData(stockId);
    pts.forEach((p) => {
      const y = Number(p.y);
      if (y > 0) {
        min = Math.min(min, y);
        max = Math.max(max, y);
      }
    });
  } else {
    const pts = buildCandleSeriesData(stockId);
    pts.forEach((p) => {
      const [o, h, l, c] = p.y.map(Number);
      const vals = [o, h, l, c].filter((v) => v > 0);
      if (vals.length) {
        min = Math.min(min, ...vals);
        max = Math.max(max, ...vals);
      }
    });
  }
  if (avg != null && avg > 0) {
    min = Math.min(min, avg);
    max = Math.max(max, avg);
  }
  const st = getStockById(stockId);
  const spot = Math.max(0, Math.floor(Number(st?.price) || 0));
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const fb = Math.max(1, spot || 100);
    return { min: 0, max: Math.ceil(fb * 1.08) };
  }
  if (min === max) {
    const pad = Math.max(1, Math.floor(min * 0.004) || 1);
    return { min: Math.max(0, min - pad), max: max + pad };
  }
  const span = max - min;
  const pad = Math.max(span * 0.06, 1);
  return {
    min: Math.max(0, Math.floor(min - pad)),
    max: Math.ceil(max + pad),
  };
}

function computeYBoundsForSvgRows(viewRows, stockId, avgCost) {
  const prices = [];
  if (detailChartType === "line") {
    viewRows.forEach((r) => {
      const c = Number(r.c);
      if (Number.isFinite(c) && c > 0) prices.push(c);
    });
  } else {
    viewRows.forEach((r) => {
      const o = Number(r.o);
      const h = Number(r.h);
      const l = Number(r.l);
      const c = Number(r.c);
      [o, h, l, c].forEach((v) => {
        if (Number.isFinite(v) && v > 0) prices.push(v);
      });
    });
  }
  if (avgCost != null && avgCost > 0) prices.push(avgCost);
  if (prices.length === 0) {
    const px = Math.max(0, Math.floor(Number(getStockById(stockId)?.price) || 0));
    const fb = Math.max(1, px || 100);
    return { min: 0, max: Math.ceil(fb * 1.08) };
  }
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const px = Math.max(0, Math.floor(Number(getStockById(stockId)?.price) || 0));
    const fb = Math.max(1, px || 100);
    return { min: 0, max: Math.ceil(fb * 1.08) };
  }
  if (min === max) {
    const pad = Math.max(1, Math.floor(min * 0.004) || 1);
    return { min: Math.max(0, min - pad), max: max + pad };
  }
  const span = max - min;
  const pad = Math.max(span * 0.15, 1);
  let outMin = Math.max(0, Math.floor(min - pad));
  let outMax = Math.ceil(max + pad);
  if (min > 0 && max / min > 3.2 && prices.length >= 8) {
    const sorted = [...prices].sort((a, b) => a - b);
    const n = sorted.length;
    const qLo = sorted[Math.floor(n * 0.06)] ?? min;
    const qHi = sorted[Math.min(n - 1, Math.ceil(n * 0.94))] ?? max;
    const qSpan = Math.max(qHi - qLo, qLo * 0.02, 1);
    outMin = Math.max(0, Math.floor(qLo - qSpan * 0.12));
    outMax = Math.ceil(qHi + qSpan * 0.12);
  }
  return { min: outMin, max: outMax };
}

/** 상세 차트 X축 라벨 */
function detailChartDatetimeFormatter(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

function syncDetailChartTypeButtons() {
  document.querySelectorAll("[data-chart-type]").forEach((b) => {
    const t = b.getAttribute("data-chart-type");
    const on = t === detailChartType;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function bindDetailChartTypeToggleOnce() {
  const bar = document.getElementById("detailChartTypeBar");
  if (!bar || bar.dataset.bound === "1") return;
  bar.dataset.bound = "1";
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chart-type]");
    if (!btn) return;
    const t = btn.getAttribute("data-chart-type");
    if (t !== "candle" && t !== "line") return;
    if (t === detailChartType) return;
    detailChartType = t;
    detailChartView.chartType = t;
    syncDetailChartTypeButtons();
    if (selectedStockId) {
      initDetailCharts(selectedStockId);
    }
  });
}

/** d1: horizontal pan only (no separate day swipe) */
function bindDetailChartD1DaySwipeOnce() {
  return;
}

/** 정렬된 full 배열에서 range·pageIndex로 slice만 */
function sliceDetailChartRowsForPage(fullSorted, rangeKey, pageIndex) {
  const n = fullSorted.length;
  if (n === 0) return [];
  if (rangeKey === "all") return fullSorted.slice();
  const pageSize = DETAIL_CHART_PAGE_SIZE[rangeKey];
  if (!pageSize) return fullSorted.slice();
  const end = Math.max(0, n - pageIndex * pageSize);
  const start = Math.max(0, end - pageSize);
  return fullSorted.slice(start, end);
}

function buildDetailChartRowsFiltered(stockId) {
  const fullRaw = buildFullCanvasRowsForScrollChart(stockId);
  if (!fullRaw.length) return [];
  const range = detailChartRange || "d1";
  return sliceDetailChartRowsForPage(fullRaw, range, detailChartPageIndex);
}

function detailChartAxisLabelFromRow(r) {
  if (!r) return "—";
  const ts = Number(r.timestamp);
  const anchor = detailChartLiveBundle && detailChartLiveBundle.chartFirstCandleTs;
  if (Number.isFinite(ts) && Number.isFinite(Number(anchor))) {
    const g = toGameTime(ts, anchor);
    return `${g.dayLabel} ${g.time}`;
  }
  const d0 = Math.floor(Number(r.dayIndex));
  const m0 = Math.floor(Number(r.periodStartMin));
  if (!Number.isFinite(d0) || !Number.isFinite(m0)) return "—";
  return formatCandleXLabel(d0, m0);
}

const DETAIL_CANDLE_W = 8;
const DETAIL_CANDLE_GAP = 2;
const DETAIL_STEP = DETAIL_CANDLE_W + DETAIL_CANDLE_GAP;
const DETAIL_X_LABEL_MIN_GAP = 80;

/** X: firstTs = candleHistory[stockId][0]; 1s real = 1m game; 510 game-min/day = 510s real. */
function toGameTime(ts, firstTs) {
  const GAME_DAY_REAL_MS = 510_000;
  const t0 = Number(firstTs);
  const t = Number(ts);
  if (!Number.isFinite(t) || !Number.isFinite(t0)) {
    return { dayIndex: 0, time: "—", dayLabel: "1일차" };
  }
  const elapsedRealMs = Math.max(0, t - t0);
  const dayIndex = Math.floor(elapsedRealMs / GAME_DAY_REAL_MS);
  const inDayGameMin = Math.floor((elapsedRealMs % GAME_DAY_REAL_MS) / 1000);
  const gameHour = Math.floor(inDayGameMin / 60) + 8;
  const gameMin = inDayGameMin % 60;
  return {
    dayIndex,
    time: `${String(gameHour).padStart(2, "0")}:${String(gameMin).padStart(2, "0")}`,
    dayLabel: `${dayIndex + 1}일차`,
  };
}

function calcMA(candles, period) {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    return slice.reduce((s, c) => s + c.close, 0) / period;
  });
}

/** X: bar index 0..n-1 evenly across plotInnerW (no time gaps). */
function applyDetailChartViewport(bundle) {
  const { rows, plotInnerW } = bundle;
  const n = rows.length;
  bundle.startIdx = 0;
  bundle.endIdx = n;
  if (n === 0) {
    bundle.step = 0;
    bundle.candleW = DETAIL_CANDLE_W;
    return;
  }
  const slot = plotInnerW / n;
  bundle.step = slot;
  bundle.candleW = Math.max(2, Math.min(DETAIL_CANDLE_W, slot * 0.72));
}

function detailChartXCandleCenter(i, bundle) {
  const { plotLeft, startIdx, step } = bundle;
  return plotLeft + (i - startIdx) * step + step / 2;
}

function detailChartIndexFromClientX(clientX, canvas, bundle) {
  applyDetailChartViewport(bundle);
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const { plotLeft, plotInnerW, startIdx, endIdx, step, rows } = bundle;
  if (x < plotLeft || x > plotLeft + plotInnerW) return null;
  const rel = x - plotLeft;
  const fi = (rel - step / 2) / step + startIdx;
  let idx = Math.round(fi);
  idx = Math.max(startIdx, Math.min(endIdx - 1, idx));
  if (idx < 0 || idx >= rows.length) return null;
  return idx;
}

function resizeDetailCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

function updateDetailChartOhlcHud(row) {
  const el = document.getElementById("detailChartOhlcHud");
  if (!el) return;
  if (!row) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const o = Math.floor(Number(row.o));
  const h = Math.floor(Number(row.h));
  const l = Math.floor(Number(row.l));
  const c = Math.floor(Number(row.c));
  const ts = Number(row.timestamp);
  const anchor = detailChartLiveBundle && detailChartLiveBundle.chartFirstCandleTs;
  let timePart = "";
  if (Number.isFinite(ts) && Number.isFinite(Number(anchor))) {
    const g = toGameTime(ts, anchor);
    timePart = ` · ${g.dayLabel} ${g.time}`;
  }
  el.hidden = false;
  el.textContent = `시작: ${o.toLocaleString("ko-KR")}  고가: ${h.toLocaleString("ko-KR")}  저가: ${l.toLocaleString("ko-KR")}  종가: ${c.toLocaleString("ko-KR")}${timePart}`;
}

function strokeDetailMaSeries(ctx, yPriceFn, maArr, startIdx, endIdx, xAt, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let pen = false;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = maArr[i];
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = xAt(i);
    const y = yPriceFn(v);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function paintDetailChartCanvas(bundle) {
  const canvasM = bundle.canvasMain;
  const canvasV = bundle.canvasVol;
  const canvasA = bundle.canvasAxis;
  if (!canvasM || !canvasV || !canvasA) return;

  const cssW = bundle.cssW;
  const mainH = bundle.mainH;
  const volH = bundle.volH;
  const axisH = bundle.axisH;
  resizeDetailCanvas(canvasM, cssW, mainH);
  resizeDetailCanvas(canvasV, cssW, volH);
  resizeDetailCanvas(canvasA, cssW, axisH);

  const ctxM = canvasM.getContext("2d");
  const ctxV = canvasV.getContext("2d");
  const ctxA = canvasA.getContext("2d");
  if (!ctxM || !ctxV || !ctxA) return;

  ctxM.clearRect(0, 0, cssW, mainH);
  ctxV.clearRect(0, 0, cssW, volH);
  ctxA.clearRect(0, 0, cssW, axisH);

  const { rows, stockId, plotLeft, plotTop, plotBottom, plotInnerW } = bundle;
  if (!rows.length) return;
  applyDetailChartViewport(bundle);
  const { startIdx, endIdx, step, candleW } = bundle;
  const n = rows.length;

  const visRows = rows.slice(startIdx, endIdx);
  const avgCost = getAvgCostForStock(stockId);
  let yb = computeYBoundsForSvgRows(
    visRows.length ? visRows : rows,
    stockId,
    avgCost
  );
  if (delistedStocks[stockId]) yb = { min: 0, max: 100 };
  if (!Number.isFinite(Number(yb.min)) || !Number.isFinite(Number(yb.max))) {
    yb = { min: 0, max: 100 };
  }

  const lo = Number(yb.min);
  const hi = Number(yb.max);
  const spanY = Math.max(1, hi - lo);
  const plotH = Math.max(1, plotBottom - plotTop);

  const yPrice = (price) => {
    const p = Number(price);
    const tNorm = (Number.isFinite(p) ? p : lo) - lo;
    const tt = tNorm / spanY;
    let y = plotTop + (1 - tt) * plotH;
    if (!Number.isFinite(y)) y = plotBottom;
    return Math.max(plotTop, Math.min(plotBottom, y));
  };

  const xAt = (i) => detailChartXCandleCenter(i, bundle);

  for (let g = 0; g <= 4; g += 1) {
    const yy = plotTop + (plotH * g) / 4;
    ctxM.strokeStyle = DETAIL_CANVAS.grid;
    ctxM.lineWidth = 1;
    ctxM.beginPath();
    ctxM.moveTo(plotLeft, yy);
    ctxM.lineTo(plotLeft + plotInnerW, yy);
    ctxM.stroke();
    const pv = yb.max - ((yb.max - yb.min) * g) / 4;
    const pvTxt = Number.isFinite(pv) ? Math.floor(pv).toLocaleString("ko-KR") : "—";
    ctxM.fillStyle = DETAIL_CANVAS.axis;
    ctxM.font = "10px system-ui, sans-serif";
    ctxM.textAlign = "left";
    ctxM.fillText(pvTxt, plotLeft + plotInnerW + 6, yy + 3);
  }

  const candleObjs = rows.map((r) => ({ close: Number(r.c) || 0 }));
  const ma5 = detailChartType === "candle" ? calcMA(candleObjs, 5) : [];
  const ma20 = detailChartType === "candle" ? calcMA(candleObjs, 20) : [];

  if (detailChartType === "line") {
    ctxM.strokeStyle =
      endIdx > startIdx &&
      Number(rows[endIdx - 1].c) >= Number(rows[startIdx].c)
        ? DETAIL_CANVAS.up
        : DETAIL_CANVAS.down;
    ctxM.lineWidth = 2;
    ctxM.beginPath();
    let moved = false;
    for (let i = startIdx; i < endIdx; i += 1) {
      const c = Number(rows[i].c);
      if (!Number.isFinite(c) || c <= 0) continue;
      const x = xAt(i);
      const y = yPrice(c);
      if (!moved) {
        ctxM.moveTo(x, y);
        moved = true;
      } else ctxM.lineTo(x, y);
    }
    ctxM.stroke();
  } else {
    for (let i = startIdx; i < endIdx; i += 1) {
      const r = rows[i];
      const o = Number(r.o);
      const h = Number(r.h);
      const l = Number(r.l);
      const c = Number(r.c);
      if (![o, h, l, c].every((v) => Number.isFinite(v))) continue;
      const cx = xAt(i);
      const up = c >= o;
      const col = up ? DETAIL_CANVAS.up : DETAIL_CANVAS.down;
      ctxM.strokeStyle = col;
      ctxM.lineWidth = 1.2;
      ctxM.beginPath();
      ctxM.moveTo(cx, yPrice(h));
      ctxM.lineTo(cx, yPrice(l));
      ctxM.stroke();
      const yTop = yPrice(Math.max(o, c));
      const yBot = yPrice(Math.min(o, c));
      const bh = Math.max(1, Math.abs(yBot - yTop));
      ctxM.fillStyle = col;
      ctxM.fillRect(cx - candleW / 2, Math.min(yTop, yBot), candleW, bh);
    }
  }

  if (detailChartType === "candle") {
    strokeDetailMaSeries(ctxM, yPrice, ma5, startIdx, endIdx, xAt, DETAIL_CANVAS.ma5);
    strokeDetailMaSeries(ctxM, yPrice, ma20, startIdx, endIdx, xAt, DETAIL_CANVAS.ma20);
  }

  const crossIdx = detailChartInteraction.crossIdx;
  if (
    crossIdx != null &&
    crossIdx >= 0 &&
    crossIdx < n &&
    bundle.crossInPlot
  ) {
    const cx = xAt(crossIdx);
    const r = rows[crossIdx];
    const cc = Number(r.c);
    if (Number.isFinite(cc) && Number.isFinite(cx)) {
      const cy = yPrice(cc);
      ctxM.strokeStyle = DETAIL_CANVAS.cross;
      ctxM.lineWidth = 1;
      ctxM.beginPath();
      ctxM.moveTo(cx, plotTop);
      ctxM.lineTo(cx, plotBottom);
      ctxM.moveTo(plotLeft, cy);
      ctxM.lineTo(plotLeft + plotInnerW, cy);
      ctxM.stroke();
    }
  }

  const volPadT = 4;
  const volPlotH = Math.max(8, volH - volPadT - 4);
  const volBottom = volH - 4;
  let vmax = 1;
  for (let i = startIdx; i < endIdx; i += 1) {
    vmax = Math.max(vmax, Number(rows[i].v) || 0);
  }
  for (let i = startIdx; i < endIdx; i += 1) {
    const r = rows[i];
    const v = Number(r.v) || 0;
    const cx = xAt(i);
    const bh = Math.max(2, (v / vmax) * volPlotH);
    const up = Number(r.c) >= Number(r.o);
    ctxV.fillStyle = up ? DETAIL_CANVAS.volUp : DETAIL_CANVAS.volDown;
    ctxV.fillRect(cx - candleW / 2, volBottom - bh, candleW, bh);
  }

  if (
    crossIdx != null &&
    crossIdx >= 0 &&
    crossIdx < n &&
    bundle.crossInPlot
  ) {
    const cx = xAt(crossIdx);
    if (Number.isFinite(cx)) {
      ctxV.strokeStyle = DETAIL_CANVAS.cross;
      ctxV.lineWidth = 1;
      ctxV.beginPath();
      ctxV.moveTo(cx, 0);
      ctxV.lineTo(cx, volH);
      ctxV.stroke();
    }
  }

  const firstTs = bundle.chartFirstCandleTs;
  ctxA.fillStyle = DETAIL_CANVAS.axis;
  ctxA.font = "9px system-ui, sans-serif";
  let lastLabelX = -Infinity;
  const xAxisY = axisH - 4;
  for (let i = startIdx; i < endIdx; i += 1) {
    const cx = plotLeft + (i - startIdx) * step + step / 2;
    if (cx - lastLabelX < DETAIL_X_LABEL_MIN_GAP) continue;
    const ts = Number(rows[i].timestamp);
    const t = Number.isFinite(ts) ? ts : Number(rows[i].x);
    if (!Number.isFinite(t)) continue;
    const cur = toGameTime(t, firstTs);
    const dCur = Math.floor(Number(rows[i].dayIndex));
    const dPrev = i > 0 ? Math.floor(Number(rows[i - 1].dayIndex)) : NaN;
    const isNewDay =
      i === 0 ||
      !Number.isFinite(dCur) ||
      !Number.isFinite(dPrev) ||
      dCur !== dPrev;
    const label = isNewDay ? cur.dayLabel : cur.time;
    const hi = crossIdx === i;
    ctxA.fillStyle = hi ? "rgba(255,255,255,0.95)" : DETAIL_CANVAS.axis;
    ctxA.textAlign = "center";
    ctxA.fillText(label, cx, xAxisY);
    lastLabelX = cx;
  }
  ctxA.textAlign = "left";
}

function buildDetailChartBundle(stockId, rows, opts) {
  const preserveScroll = opts.preserveScroll === true;
  const stack = document.getElementById("detailChartCanvasStack");
  const canvasMain = document.getElementById("detailChartCanvasMain");
  const canvasVol = document.getElementById("detailChartCanvasVol");
  const canvasAxis = document.getElementById("detailChartCanvasAxis");
  if (!stack || !canvasMain || !canvasVol || !canvasAxis) return null;

  const prevStock = detailChartLiveBundle && detailChartLiveBundle.stockId;
  const prevRange = detailChartLiveBundle && detailChartLiveBundle.rangeKey;
  if (
    !preserveScroll ||
    prevStock !== stockId ||
    prevRange !== (detailChartRange || "d1")
  ) {
    detailChartInteraction.crossIdx = null;
    updateDetailChartOhlcHud(null);
  }

  const cssW = Math.max(1, stack.getBoundingClientRect().width || stack.clientWidth || 1);
  const mainH = Math.max(1, canvasMain.getBoundingClientRect().height || 1);
  const volH = Math.max(1, canvasVol.getBoundingClientRect().height || 1);
  const axisH = Math.max(1, canvasAxis.getBoundingClientRect().height || 1);

  const axisW = 52;
  const plotLeft = 8;
  const plotInnerW = Math.max(40, cssW - plotLeft - axisW - 4);
  const plotTop = 10;
  const plotBottom = mainH - 10;

  let chartFirstCandleTs = getDetailChartHistoryFirstTs(stockId);
  if (chartFirstCandleTs == null && rows.length > 0) {
    const t0 = Number(rows[0].timestamp);
    if (Number.isFinite(t0)) chartFirstCandleTs = t0;
    else {
      const x0 = Number(rows[0].x);
      chartFirstCandleTs = Number.isFinite(x0) ? x0 : null;
    }
  }
  if (chartFirstCandleTs == null && rows.length > 0) {
    chartFirstCandleTs = Date.now();
  }

  return {
    stockId,
    rangeKey: detailChartRange || "d1",
    rows,
    canvasMain,
    canvasVol,
    canvasAxis,
    cssW,
    mainH,
    volH,
    axisH,
    plotLeft,
    plotTop,
    plotBottom,
    plotInnerW,
    chartFirstCandleTs,
    crossInPlot: false,
  };
}

function destroyDetailCharts() {
  detailChartLiveBundle = null;
  detailChartInteraction.crossIdx = null;
  const m = document.getElementById("detailChartCanvasMain");
  const v = document.getElementById("detailChartCanvasVol");
  const a = document.getElementById("detailChartCanvasAxis");
  if (m && m.getContext) {
    const ctx = m.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, m.width, m.height);
  }
  if (v && v.getContext) {
    const ctx = v.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, v.width, v.height);
  }
  if (a && a.getContext) {
    const ctx = a.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, a.width, a.height);
  }
  updateDetailChartOhlcHud(null);
}

function bindDetailChartScrollSyncOnce() {
  return;
}

function syncDetailChartPaginationUi(stockId) {
  const bar = document.getElementById("detailChartPaginationBar");
  const prev = document.getElementById("btnDetailChartPrev");
  const next = document.getElementById("btnDetailChartNext");
  if (!bar || !prev || !next) return;
  const range = detailChartRange || "d1";
  if (range === "all") {
    bar.hidden = true;
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const full = buildFullCanvasRowsForScrollChart(stockId);
  const n = full.length;
  const size = DETAIL_CHART_PAGE_SIZE[range];
  if (!size || n === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const end = Math.max(0, n - detailChartPageIndex * size);
  const start = Math.max(0, end - size);
  prev.disabled = start <= 0;
  next.disabled = detailChartPageIndex <= 0;
}

function bindDetailChartPaginationOnce() {
  const bar = document.getElementById("detailChartPaginationBar");
  if (!bar || bar.dataset.paginationBound === "1") return;
  bar.dataset.paginationBound = "1";
  const prev = document.getElementById("btnDetailChartPrev");
  const next = document.getElementById("btnDetailChartNext");
  const goPrev = () => {
    const sid = selectedStockId || detailChartView.stockId;
    if (!sid) return;
    const range = detailChartRange || "d1";
    if (range === "all") return;
    const size = DETAIL_CHART_PAGE_SIZE[range];
    const full = buildFullCanvasRowsForScrollChart(sid);
    const n = full.length;
    const end = Math.max(0, n - detailChartPageIndex * size);
    const start = Math.max(0, end - size);
    if (start <= 0) return;
    detailChartPageIndex += 1;
    renderScrollDetailCharts(sid, { preserveScroll: true });
  };
  const goNext = () => {
    const sid = selectedStockId || detailChartView.stockId;
    if (!sid) return;
    if (detailChartPageIndex <= 0) return;
    detailChartPageIndex -= 1;
    renderScrollDetailCharts(sid, { preserveScroll: true });
  };
  prev?.addEventListener("click", goPrev);
  next?.addEventListener("click", goNext);
}

function bindDetailChartCrosshairOnce() {
  const main = document.getElementById("detailChartCanvasMain");
  if (!main || main.dataset.crosshairBound === "1") return;
  main.dataset.crosshairBound = "1";
  main.addEventListener("mousemove", (e) => {
    if (!detailChartLiveBundle) return;
    const idx = detailChartIndexFromClientX(e.clientX, main, detailChartLiveBundle);
    const rect = main.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const inPlot =
      idx != null &&
      y >= detailChartLiveBundle.plotTop &&
      y <= detailChartLiveBundle.plotBottom;
    detailChartLiveBundle.crossInPlot = inPlot;
    detailChartInteraction.crossIdx = inPlot ? idx : null;
    if (inPlot && idx != null) updateDetailChartOhlcHud(detailChartLiveBundle.rows[idx]);
    else updateDetailChartOhlcHud(null);
    paintDetailChartCanvas(detailChartLiveBundle);
  });
  main.addEventListener("mouseleave", () => {
    if (!detailChartLiveBundle) return;
    detailChartInteraction.crossIdx = null;
    detailChartLiveBundle.crossInPlot = false;
    updateDetailChartOhlcHud(null);
    paintDetailChartCanvas(detailChartLiveBundle);
  });
  main.addEventListener(
    "touchmove",
    (e) => {
      if (!detailChartLiveBundle) return;
      if (e.touches.length !== 1) return;
      const idx = detailChartIndexFromClientX(
        e.touches[0].clientX,
        main,
        detailChartLiveBundle
      );
      const rect = main.getBoundingClientRect();
      const y = e.touches[0].clientY - rect.top;
      const inPlot =
        idx != null &&
        y >= detailChartLiveBundle.plotTop &&
        y <= detailChartLiveBundle.plotBottom;
      detailChartLiveBundle.crossInPlot = inPlot;
      detailChartInteraction.crossIdx = inPlot ? idx : null;
      if (inPlot && idx != null) updateDetailChartOhlcHud(detailChartLiveBundle.rows[idx]);
      else updateDetailChartOhlcHud(null);
      paintDetailChartCanvas(detailChartLiveBundle);
    },
    { passive: true }
  );
}

function setDetailChartCanvasPlaceholder(message) {
  const stack = document.getElementById("detailChartCanvasStack");
  const canvasMain = document.getElementById("detailChartCanvasMain");
  const canvasVol = document.getElementById("detailChartCanvasVol");
  const canvasAxis = document.getElementById("detailChartCanvasAxis");
  if (!stack || !canvasMain || !canvasVol || !canvasAxis) return;
  const cssW = Math.max(1, stack.clientWidth || 1);
  const mainH = Math.max(1, canvasMain.getBoundingClientRect().height || 158);
  const volH = Math.max(1, canvasVol.getBoundingClientRect().height || 52);
  const axisH = Math.max(1, canvasAxis.getBoundingClientRect().height || 22);
  resizeDetailCanvas(canvasMain, cssW, mainH);
  resizeDetailCanvas(canvasVol, cssW, volH);
  resizeDetailCanvas(canvasAxis, cssW, axisH);
  const ctxM = canvasMain.getContext("2d");
  const ctxV = canvasVol.getContext("2d");
  const ctxA = canvasAxis.getContext("2d");
  if (ctxM) {
    ctxM.clearRect(0, 0, cssW, mainH);
    ctxM.fillStyle = "#8b95a8";
    ctxM.font = "12px system-ui, sans-serif";
    ctxM.textAlign = "center";
    ctxM.fillText(message, cssW / 2, mainH / 2);
  }
  if (ctxV) ctxV.clearRect(0, 0, cssW, volH);
  if (ctxA) ctxA.clearRect(0, 0, cssW, axisH);
}

/** Detail chart entry (canvas). */
function renderChart(stockId, opts) {
  return renderScrollDetailCharts(stockId, opts || {});
}

function renderScrollDetailCharts(stockId, opts = {}) {
  const preserveScroll = opts.preserveScroll === true;
  detailChartView.stockId = stockId;
  detailChartView.chartRange = detailChartRange;
  detailChartView.chartType = detailChartType;

  let rows = [];
  try {
    rows = buildDetailChartRowsFiltered(stockId);
  } catch (e) {
    console.warn("buildDetailChartRowsFiltered", e);
    rows = [];
  }

  if (!rows.length) {
    syncDetailChartPaginationUi(stockId);
    setDetailChartCanvasPlaceholder("\ub370\uc774\ud130 \ub85c\ub529 \uc911\u2026");
    return;
  }

  try {
    const bundle = buildDetailChartBundle(stockId, rows, { preserveScroll });
    if (!bundle) return;
    detailChartLiveBundle = bundle;
    paintDetailChartCanvas(bundle);
    syncDetailChartPaginationUi(stockId);
    bindDetailChartPaginationOnce();
    bindDetailChartCrosshairOnce();
  } catch (e) {
    console.warn("renderScrollDetailCharts", e);
    syncDetailChartPaginationUi(stockId);
    setDetailChartCanvasPlaceholder("\ub370\uc774\ud130 \ub85c\ub529 \uc911\u2026");
  }
}

function initDetailCharts(stockId, opts) {
  const s = getStockById(stockId);
  if (!s) return;
  detailChartPageIndex = 0;
  destroyDetailCharts();
  renderScrollDetailCharts(stockId, {
    preserveScroll: false,
    logChartRange: opts && opts.logChartRange === true,
  });
}

const LS_STOCK_COMMUNITY = "stockLifeCommunityV1";
const COMMUNITY_MAX_PER_STOCK = 120;
let stockCommunityBySymbol = {};
let lastCommunityAiEmitMs = 0;

const COMMUNITY_AI_LINES = {
  bull: [
    "여기 층간소음 없어서 좋네요 ㅋㅋㅋ",
    "꽉 잡아! 우주로 간다!",
    "이거 진짜 대박 각 나왔다",
    "차트 보니까 심장이 두근거림",
    "물타기 존버 승리다",
    "|�들:",
    "내일 시초가 상한가 각",
    "추천 ㅊㅊ 이거 왜 안 사 ㄹㅇ",
    "오늘 저녁은 소고기다 ㅋㅋ",
    "반등 한 번만… 제발… 아 상승이네 ㅋㅋ",
    "댓글만 봐도 벌써 수익 각",
    "이 종목만 믿고 산다 진짜",
  ],
  bear: [
    "대주주 구속 수사해라",
    "이거 진짜 상폐냐? 한강물 따뜻하냐...",
    "손절 못 하고 물만 먹는 중",
    "공매도가 판을 치는구나",
    "경영진 나와서 해명해라",
    "이 재료로 이 가격? 사기 아님?",
    "반등은 주는 거야? 미끼야?",
    "추천 비추 ㅅㅌㅊ 차라리 현금이 낫다",
    "ㅈ됐다… 오늘도 마이너스",
    "왜 샀냐 나 자신아",
    "답 없다 진짜 ㅠㅠ",
    "차트 보지 말 걸 그랬다",
  ],
  delist: [
    "휴지 쪼가리 기념품으로 간직합니다...",
    "내 청춘 반환해줘",
    "상폐 전에 한 번만…",
    "계좌에 흔적도 없이 증발",
    "다음 생엔 우량주만",
    "여기 댓글만 남고 다 갔네…",
    "ㅠㅠ 진짜 끝인가요",
    "추천은 사라지고 비추만 남았다",
  ],
  flat: [
    "오늘도 옆으로 걷는 주식",
    "거래량 어디 갔냐",
    "박스권 탈출 언제냐",
    "뉴스나 좀 터져라",
    "지루해서 잠 옴",
    "호가창이 고요하다…",
    "답답하다 그냥…",
    "댓글만 도배되고 주가는 안 움직여",
    "이거 스크롤만 하는 중",
    "오늘도 무슨 일 없음 ㅋ",
  ],
};

const COMMUNITY_CONTRARIAN_LINES = {
  bull: [
    "이럴 때가 제일 위험한 거 알지? 거래량 식으면 바로 눌린다",
    "고점 냄새 진하게 난다, 난 분할매도 중",
    "|�들:",
    "재료 소멸이면 순식간에 음봉 나옴",
  ],
  bear: [
    "공포 구간에서 줍는 사람이 결국 먹더라",
    "이 정도 하락이면 악재 반영 끝 아닌가",
    "|�들:",
    "바닥 다지는 느낌인데 나만 보이나",
  ],
  delist: [
    "끝난 줄 알았는데 저런 건 가끔 기적 반등 뜬다",
    "상폐 이슈도 정책 한 줄이면 뒤집힌다",
    "죽은 줄 알았던 종목이 살아난 사례 많다",
  ],
  flat: [
    "횡보 끝나면 방향 크게 나온다, 슬슬 포지션 잡을 때",
    "지루한 박스가 오히려 기회일 수 있음",
    "잠잠할 때 모으는 게 편하다",
  ],
};

function communityPriceMovePct(stockId) {
  const s = getStockById(stockId);
  const open = Number(sessionOpenPrice[stockId]);
  const p = Number(s?.price);
  if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  return ((p - open) / open) * 100;
}

function buildDynamicCommunityLine(stockId, regime) {
  const move = communityPriceMovePct(stockId);
  const useContrarian = Math.random() < 0.28;
  const basePool = useContrarian
    ? COMMUNITY_CONTRARIAN_LINES[regime] || COMMUNITY_AI_LINES.flat
    : COMMUNITY_AI_LINES[regime] || COMMUNITY_AI_LINES.flat;
  const base = pickCommunityLine(basePool);
  const moodTag = move >= 0
    ? (Math.random() < 0.5 ? "수익 인증각" : "익절 고민중")
    : (Math.random() < 0.5 ? "멘탈 흔들림" : "분할매수 고민");
  const tailPool = [
    "추천/비추 갈린다",
    "실시간으로 분위기 뒤집히는 중",
    "댓글창 여론전 치열하다",
    "|�들:",
    "단타 vs 존버 전쟁터",
  ];
  const tail = pickCommunityLine(tailPool);
  if (Math.random() < 0.4) {
    return `${base} · ${moodTag} (${move >= 0 ? "+" : ""}${move.toFixed(1)}%)`;
  }
  return `${base} · ${tail}`;
}

/** 위키트리 톡방 느낌의 고정 닉 100명 풀 */
const COMMUNITY_AI_BOT_NAMES = (() => {
  const bases = [
    "불타는천사",
    "한강물살아",
    "존버대장",
    "단타초짜",
    "삼전맘",
    "물타기귀신",
    "동전템플러",
    "차트무새",
    "공매도충",
    "신규양학",
    "레버리지킹",
    "밈주인",
    "시초가헌터",
    "상한가기원",
    "하락장인",
    "분봉마법사",
    "거래량요정",
    "기관블러핑",
    "외인손절",
    "개미대장",
    "청산각",
    "우주가즈아",
    "반등은사기",
    "뉴스기다림",
    "호가창지킴",
  ];
  const out = [];
  for (let i = 0; i < 100; i += 1) {
    out.push(`${bases[i % bases.length]}${String(i + 1).padStart(2, "0")}`);
  }
  return out;
})();

function pickCommunityLine(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAiCommunityHandle() {
  return COMMUNITY_AI_BOT_NAMES[
    Math.floor(Math.random() * COMMUNITY_AI_BOT_NAMES.length)
  ];
}

/** 토론방이 비어 있을 때 AI 댓글을 한 번에 채움 */
function ensureCommunityAiSeed(stockId) {
  if (!stockId) return;
  if (!stockCommunityBySymbol[stockId]) stockCommunityBySymbol[stockId] = [];
  const list = stockCommunityBySymbol[stockId];
  if (list.length > 0) return;
  const count = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i += 1) {
    appendRandomCommunityAiPost(stockId);
  }
}

function loadStockCommunityStore() {
  try {
    const raw = localStorage.getItem(LS_STOCK_COMMUNITY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === "object") stockCommunityBySymbol = o;
  } catch {
    /* ignore */
  }
}

function saveStockCommunityStore() {
  try {
    localStorage.setItem(LS_STOCK_COMMUNITY, JSON.stringify(stockCommunityBySymbol));
  } catch {
    /* ignore */
  }
}

function getStockCommunityRegime(stockId) {
  if (delistedStocks[stockId]) return "delist";
  const s = getStockById(stockId);
  if (!s) return "flat";
  const open = Number(sessionOpenPrice[stockId]);
  const p = Math.floor(Number(s.price) || 0);
  if (!Number.isFinite(open) || open <= 0) return "flat";
  const pct = ((p - open) / open) * 100;
  if (pct <= -3) return "bear";
  if (pct >= 3) return "bull";
  return "flat";
}

function formatCommunityGameTime(entry) {
  const di = Math.floor(Number(entry?.dayIndex));
  const mm = Math.floor(Number(entry?.minute));
  if (Number.isFinite(di) && Number.isFinite(mm)) {
    return formatCandleXLabel(di, Math.max(0, Math.min(1439, mm)));
  }
  return formatCandleXLabel(gameDayIndex, gameMinutes);
}

function pushCommunityEntry(stockId, entry) {
  if (!stockId || !entry?.text) return;
  if (!stockCommunityBySymbol[stockId]) stockCommunityBySymbol[stockId] = [];
  const list = stockCommunityBySymbol[stockId];
  const di = Math.floor(Number(entry?.dayIndex));
  const mm = Math.floor(Number(entry?.minute));
  list.unshift({
    ...entry,
    dayIndex: Number.isFinite(di) ? di : gameDayIndex,
    minute: Number.isFinite(mm) ? Math.max(0, Math.min(1439, mm)) : gameMinutes,
    ts: Number.isFinite(Number(entry?.ts)) ? Number(entry.ts) : Date.now(),
  });
  while (list.length > COMMUNITY_MAX_PER_STOCK) list.pop();
  saveStockCommunityStore();
}

function appendRandomCommunityAiPost(stockId) {
  const regime = getStockCommunityRegime(stockId);
  pushCommunityEntry(stockId, {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    kind: "ai",
    author: randomAiCommunityHandle(),
    text: buildDynamicCommunityLine(stockId, regime),
    ts: Date.now(),
    dayIndex: gameDayIndex,
    minute: gameMinutes,
  });
}

function tickStockCommunityAiIfNeeded(stockId) {
  if (!stockId || tutorialGateActive) return;
  const now = Date.now();
  if (now - lastCommunityAiEmitMs < 3500) return;
  if (Math.random() > 0.42) return;
  lastCommunityAiEmitMs = now;
  appendRandomCommunityAiPost(stockId);
  if (selectedStockId === stockId) renderStockCommunityPanel(stockId);
}

function renderStockCommunityPanel(stockId) {
  ensureCommunityAiSeed(stockId);
  const ul = document.getElementById("detailCommunityList");
  if (!ul) return;
  const items = stockCommunityBySymbol[stockId] || [];
  if (items.length === 0) {
    ul.innerHTML = `<li class="detail-community-item detail-community-item--empty">아직 댓글이 없습니다. 첫 글을 남겨 보세요.</li>`;
    return;
  }
  ul.innerHTML = items
    .map((it) => {
      const badge =
        it.kind === "player"
          ? `<span class="comm-badge comm-badge--player">[주주]</span>`
          : `<span class="comm-badge comm-badge--ai">[AI]</span>`;
      const timeStr = formatCommunityGameTime(it);
      return `<li class="detail-community-item">
        <div class="detail-community-meta">
          <span class="detail-community-author">${escapeHtml(it.author || "익명")}</span>
          ${badge}
          <span class="detail-community-time">${escapeHtml(timeStr)}</span>
        </div>
        <p class="detail-community-text">${escapeHtml(it.text || "")}</p>
      </li>`;
    })
    .join("");
}

function bindStockCommunityOnce() {
  const send = document.getElementById("detailCommunitySend");
  const input = document.getElementById("detailCommunityInput");
  if (!send || !input || send.dataset.bound === "1") return;
  send.dataset.bound = "1";
  const submit = () => {
    if (!selectedStockId) return;
    const raw = String(input.value || "").trim();
    if (!raw) {
      setMessage("댓글을 입력해 주세요.", "err");
      return;
    }
    const name =
      (loginDisplayName && loginDisplayName.trim()) ||
      (playerProfile?.name && String(playerProfile.name).trim()) ||
      "플레이어";
    pushCommunityEntry(selectedStockId, {
      id: `pl-${Date.now()}`,
      kind: "player",
      author: name,
      text: raw.slice(0, 280),
      ts: Date.now(),
      dayIndex: gameDayIndex,
      minute: gameMinutes,
    });
    input.value = "";
    renderStockCommunityPanel(selectedStockId);
    setMessage("댓글이 등록되었습니다.", "ok");
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

function refreshDetailChart() {
  if (!selectedStockId || detailChartView.stockId !== selectedStockId) return;
  const id = selectedStockId;
  renderScrollDetailCharts(id, { preserveScroll: true });
  updateOrderBookAndStrength(id);
  updateDetailTradeLivePreview();
  tickStockCommunityAiIfNeeded(id);
}

/** 예수금·주가 기준 수수료 반영 최대 매수 주수(RPC ROUND와 맞춤) */
function maxBuySharesForCash(cash, price) {
  const c = Math.floor(Number(cash));
  const p = Number(price);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  let hi = Math.floor(c / p);
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    const cost = Math.round(mid * p * TRADE_FEE_MULT_BUY);
    if (cost <= c) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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
      let lo = 0;
      let hi =
        Math.floor(cap / (s.price * TRADE_FEE_MULT_BUY)) + 2;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (Math.round(mid * s.price * TRADE_FEE_MULT_BUY) <= cap) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    }
    const maxWon = Math.floor(shHeld * s.price);
    const use = Math.min(won, maxWon);
    return Math.max(0, Math.floor(use / s.price));
  }
  let q = Math.max(0, Math.floor(Number(parseFloat(clean))));
  if (!q || q <= 0) return 0;
  if (action === "sell") {
    if (q > shHeld) return shHeld;
  } else if (action === "buy") {
    const maxAff = maxBuySharesForCash(game.cash, s.price);
    if (q > maxAff) q = maxAff;
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
  const cb = Math.max(0, clampSafeInteger(game.costBasis[selectedStockId] ?? 0, 0));
  const P = Math.max(MIN_STOCK_PRICE, clampSafeInteger(s.price, MIN_STOCK_PRICE));

  if (lastDetailTradeAction === "buy") {
    const cost = Math.round(P * qty * TRADE_FEE_MULT_BUY);
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
    const proceeds = Math.round(P * sellQty * TRADE_FEE_MULT_SELL);
    const gain = proceeds - propCost;
    const newSh = sh - sellQty;
    const newCb = cb - propCost;
    const newAvg = newSh > 1e-8 ? newCb / newSh : 0;
    const newStockVal = Math.max(0, newSh * P);
    const oldStockVal = sh * P;
    const hypNw = netWorth() - oldStockVal + newStockVal + proceeds;
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
  const pool = stocks.filter((s) => memeNewsEligibleSpec(s));
  if (pool.length === 0) return;
  const s = pool[Math.floor(Math.random() * pool.length)];
  const line = randomMemeHeadlineFromChain(s.id);
  if (!line) return;
  addNewsItem(line, "ambient", "", { stockId: s.id, is_rumor: true });
}

function tryFireChainNews(completedCandleCount) {
  Object.keys(NEWS_CHAINS).forEach((stockId) => {
    if (delistedStocks[stockId]) return;
    const stCh = getStockById(stockId);
    if (!stCh || Math.floor(Number(stCh.price) || 0) <= 0) return;
    const sched = CHAIN_SCHEDULE[stockId];
    if (!sched) return;
    const step = chainStepByStock[stockId];
    if (step >= sched.length || newsCountByStock[stockId] >= 6) return;
    if (completedCandleCount !== sched[step]) return;

    const story = NEWS_CHAINS[stockId][step];
    const asRumor = rollIsRumor();
    addNewsItem(story.headline, "chain", "", { stockId, is_rumor: asRumor });
    if (!asRumor) applyNewsPayload(story);
    chainStepByStock[stockId] += 1;
    newsCountByStock[stockId] += 1;
  });
}

function tryFireMutantNewsEvent(completedCandleCount) {
  if (!isTradingWindowActive()) return;
  if (completedCandleCount < 2) return;
  const candidates = stocks.filter(
    (s) =>
      !isEtfId(s.id) &&
      !delistedStocks[s.id] &&
      Number.isFinite(Number(s.price)) &&
      Number(s.price) > 0
  );
  const ev = specialEventsGenerator.nextEvent({
    stocks: candidates.map((s) => ({
      id: s.id,
      name: s.name,
      price: s.price,
      isDelisted: !!delistedStocks[s.id],
    })),
  });
  if (!ev) return;
  addNewsItem(ev.headline, ev.feedType || "chain", "", {
    stockId: ev.primaryStockId,
    global: true,
    is_rumor: ev.isRumor === true,
  });
  setMessage(ev.headline, "ok");
  applyNewsPayload({
    headline: ev.headline,
    impacts: ev.impacts || {},
    bias: ev.bias || {},
    volFactor: ev.volFactor || 1.5,
  });
}
function pickStockIdForAmbientNews() {
  const wl = watchlistIds.filter((id) => memeNewsEligibleId(id));
  if (wl.length === 0) return null;
  return wl[Math.floor(Math.random() * wl.length)];
}

function scheduleAmbientNewsTimer() {
  clearTimeout(newsTimeoutId);
  const delay = 150000 + Math.random() * 130000;
  newsTimeoutId = setTimeout(() => {
    if (isTradingSession()) {
      const sid = pickStockIdForAmbientNews();
      const line = sid ? randomMemeHeadlineFromChain(sid) : null;
      if (sid && line) {
        const asRumor = rollIsRumor();
        addNewsItem(line, "ambient", "", {
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
  else {
    if (watchlistIds.length >= MAX_WATCHLIST_IDS) {
      setMessage(
        "정보력의 한계! 관심 종목은 최대 3개까지만 등록 가능합니다.",
        "ok"
      );
      return;
    }
    watchlistIds.push(stockId);
  }
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

  const visible = stocks.filter((s) => {
    if (marketListFilterMode !== "mine") return true;
    const held = Math.max(0, Math.floor(Number(game.holdings[s.id] ?? 0)));
    return held > 0;
  });
  if (visible.length === 0) {
    ul.innerHTML = `<li class="stock-list-row"><p class="stock-list-desc">보유 중인 주식이 없습니다. 먼저 종목을 매수해 주세요.</p></li>`;
    return;
  }

  visible.forEach((s) => {
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
    const pendingRelisting = !!pendingRelistingByStock[s.id];
    li.innerHTML = `
      <div class="stock-list-row-main">
        <button type="button" class="btn-watchlist list-watch-btn" data-watch-stock="${escapeHtml(s.id)}" aria-label="관심 종목" aria-pressed="${watched}" title="관심 종목 (최대 ${MAX_WATCHLIST_IDS}개)">
          <span class="watchlist-star" aria-hidden="true">${watched ? "★" : "☆"}</span>
        </button>
        <div class="stock-list-name-block">
          <span class="stock-list-name">${escapeHtml(s.name)}</span>
          <span class="stock-list-ticker">${escapeHtml(s.id)}</span>
          ${pendingRelisting ? '<span class="stock-list-status-badge relisting">재상장 준비 중</span>' : ""}
        </div>
        <div class="stock-list-price-block">
          <span class="stock-list-price watch-price" data-watch-price="${escapeHtml(s.id)}">${formatStockWon(s.price)}</span>
          <span class="stock-list-pct ${chgCls}">${sign}${chgPct.toFixed(2)}%</span>
        </div>
      </div>
      <p class="stock-list-desc">${escapeHtml(s.desc)}</p>
      <div class="stock-mini-chart">${buildMiniSparklineSvg(s.id)}</div>
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

  detailChartRange = "d1";
  detailChartView.chartRange = "d1";
  syncDetailChartRangeButtons();
  syncDetailChartTypeButtons();
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
  renderStockCommunityPanel(stockId);
}

function closeStockDetail() {
  selectedStockId = null;
  detailChartView.stockId = null;
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
    if (delistedStocks[id]) {
      setMessage("상장폐지된 종목은 거래할 수 없습니다.", "err");
      return;
    }
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
      if (!Number.isFinite(lp) || lp <= 0) {
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
      const q = maxBuySharesForCash(game.cash, s.price);
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

/** 내 투자 탭 테이블: 시세 틱마다 현재가·평가손익만 갱신(행 전체 재생성 없음) */
function refreshPortfolioTableCells() {
  const tbody = document.getElementById("stockRows");
  if (!tbody || tbody.querySelectorAll("tr").length === 0) return;
  const esc =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? (id) => CSS.escape(id)
      : (id) => String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  stocks.forEach((s) => {
    const priceEl = tbody.querySelector(
      `[data-portfolio-price="${esc(s.id)}"]`
    );
    if (priceEl) priceEl.textContent = formatStockWon(s.price);
    const plTd = tbody.querySelector(`td[data-portfolio-pl="${esc(s.id)}"]`);
    if (!plTd) return;
    const owned = game.holdings[s.id] ?? 0;
    const cb = game.costBasis[s.id] ?? 0;
    const evalVal = owned * s.price;
    const pl = Math.round(evalVal - cb);
    const plCls = pl > 0 ? "chg-up" : pl < 0 ? "chg-down" : "chg-flat";
    plTd.className = `${plCls} portfolio-pl-cell`;
    plTd.textContent =
      owned > 0 ? `${pl >= 0 ? "+" : ""}${formatWon(pl)}` : "—";
  });
}

function renderAssetSummary() {
  const nw = netWorth();
  const dayOpenBase = ensureSessionOpenNetWorthForDailyPl();
  const dayPl = nw - dayOpenBase;
  const dayPlPct = dayOpenBase > 0 ? (dayPl / dayOpenBase) * 100 : 0;
  const cumBase = Math.max(0, Math.floor(Number(game.initialCapital) || INITIAL_CAPITAL));
  const totalPl = nw - cumBase;
  const totalPlPct = cumBase > 0 ? (totalPl / cumBase) * 100 : 0;

  const totalEl = document.getElementById("summaryTotalProfit");
  const totalPctEl = document.getElementById("summaryTotalProfitPct");
  const dailyEl = document.getElementById("summaryDailyProfit");
  const dailyPctEl = document.getElementById("summaryDailyProfitPct");
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

  if (totalEl && totalPctEl && dailyEl && dailyPctEl) {
    totalEl.textContent = `총 평가손익: ${totalPl >= 0 ? "+" : ""}${formatWon(totalPl)}`;
    totalPctEl.textContent = `(${totalPlPct >= 0 ? "+" : ""}${totalPlPct.toFixed(2)}%)`;
    dailyEl.textContent = `오늘 하루 손익: ${dayPl >= 0 ? "+" : ""}${formatWon(dayPl)}`;
    dailyPctEl.textContent = `(${dayPlPct >= 0 ? "+" : ""}${dayPlPct.toFixed(2)}%)`;

    const totalCls =
      totalPl > 0 ? "value-up" : totalPl < 0 ? "value-down" : "value-neutral";
    const dailyCls =
      dayPl > 0 ? "value-up" : dayPl < 0 ? "value-down" : "value-neutral";
    totalEl.className = `asset-sub ${totalCls}`;
    totalPctEl.className = `asset-pct ${totalCls}`;
    dailyEl.className = `asset-sub-daily ${dailyCls}`;
    dailyPctEl.className = `asset-pct ${dailyCls}`;
  }

  refreshPortfolioTableCells();
  renderBankAndFlexUi();
}

function renderFlexShopList() {
  const ul = document.getElementById("flexShopList");
  if (!ul) return;
  ul.innerHTML = "";
  FLEX_SHOP_ITEMS.forEach((item) => {
    const li = document.createElement("li");
    li.className = "flex-shop-item";
    const left = document.createElement("div");
    const nm = document.createElement("div");
    nm.className = "flex-shop-name";
    nm.textContent = `${item.icon} ${item.name}`;
    const pr = document.createElement("div");
    pr.className = "flex-shop-price";
    pr.textContent = formatWon(item.price);
    left.appendChild(nm);
    left.appendChild(pr);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-mts ghost";
    btn.textContent = "구매";
    btn.addEventListener("click", () => {
      if (game.cash < item.price) {
        setMessage("예수금이 부족합니다.", "err");
        return;
      }
      game.cash = Math.max(0, Math.floor(game.cash - item.price));
      const oldItem = flexItemById(playerProfile.flexTopItemId);
      if (!oldItem || oldItem.price < item.price) {
        playerProfile.flexTopItemId = item.id;
      }
      addNewsItem(`🛍️ [플렉스] ${item.name} 결제 완료! 현금 ${formatWon(item.price)} 영구 소각.`, "news", "", {
        global: true,
      });
      setMessage(`${item.icon} ${item.name} 구매 완료!`, "ok");
      schedulePersistUser();
      renderAssetSummary();
      scheduleMultiplyLeaderboardRefresh();
    });
    li.appendChild(left);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function renderBankAndFlexUi() {
  const dep = bankDepositAmount();
  const loan = bankLoanAmount();
  const depRate = Number(playerProfile.bankDepositRate) || BANK_DAILY_DEPOSIT_RATE;
  const loanRate = Number(playerProfile.bankLoanRate) || BANK_DAILY_LOAN_RATE;
  const depInt = Math.max(0, Math.floor(dep * depRate));
  const loanInt = Math.max(0, Math.floor(loan * loanRate));
  const depEl = document.getElementById("bankDepositValue");
  const loanEl = document.getElementById("bankLoanValue");
  const depIntEl = document.getElementById("bankDepositInterestValue");
  const loanIntEl = document.getElementById("bankLoanInterestValue");
  const hintEl = document.getElementById("bankLimitHint");
  if (depEl) depEl.textContent = formatWon(dep);
  if (loanEl) loanEl.textContent = formatWon(loan);
  if (depIntEl) depIntEl.textContent = formatWon(depInt);
  if (loanIntEl) loanIntEl.textContent = formatWon(loanInt);
  if (hintEl) {
    hintEl.textContent = `대출 가능 한도: ${formatWon(bankBorrowLimit())} (총자산의 ${(BANK_MAX_LTV * 100).toFixed(0)}% 기준)`;
  }
}

function bindBankAndFlexUiOnce() {
  const root = document.getElementById("tab-arena");
  if (!root || root.dataset.bankBound === "1") return;
  root.dataset.bankBound = "1";
  const amountInput = document.getElementById("bankAmountInput");
  const readAmt = () => Math.max(0, Math.floor(Number(amountInput?.value) || 0));
  const btnDeposit = document.getElementById("btnBankDeposit");
  const btnWithdraw = document.getElementById("btnBankWithdraw");
  const btnBorrow = document.getElementById("btnBankBorrow");
  const btnRepay = document.getElementById("btnBankRepay");

  btnDeposit?.addEventListener("click", () => {
    const amt = readAmt();
    if (amt <= 0 || game.cash < amt) {
      setMessage("예금 금액이 올바르지 않거나 예수금이 부족합니다.", "err");
      return;
    }
    game.cash -= amt;
    playerProfile.bankDeposit = bankDepositAmount() + amt;
    setMessage(`예금 ${formatWon(amt)}을(를) 예치했습니다.`, "ok");
    schedulePersistUser();
    renderAssetSummary();
  });
  btnWithdraw?.addEventListener("click", () => {
    const amt = Math.min(readAmt(), bankDepositAmount());
    if (amt <= 0) {
      setMessage("출금 가능한 예치금이 없습니다.", "err");
      return;
    }
    playerProfile.bankDeposit = bankDepositAmount() - amt;
    game.cash += amt;
    setMessage(`예금 ${formatWon(amt)}을(를) 출금했습니다.`, "ok");
    schedulePersistUser();
    renderAssetSummary();
  });
  btnBorrow?.addEventListener("click", () => {
    const amt = readAmt();
    const limit = bankBorrowLimit();
    if (amt <= 0 || amt > limit) {
      setMessage("대출 가능 한도를 초과했습니다.", "err");
      return;
    }
    playerProfile.bankLoan = bankLoanAmount() + amt;
    game.cash += amt;
    setMessage(`대출 ${formatWon(amt)} 실행 완료. 빚 관리 주의!`, "ok");
    schedulePersistUser();
    renderAssetSummary();
  });
  btnRepay?.addEventListener("click", () => {
    const amt = Math.min(readAmt(), bankLoanAmount(), Math.max(0, Math.floor(game.cash)));
    if (amt <= 0) {
      setMessage("상환 가능한 금액이 없습니다.", "err");
      return;
    }
    playerProfile.bankLoan = bankLoanAmount() - amt;
    game.cash -= amt;
    setMessage(`대출 ${formatWon(amt)} 상환 완료.`, "ok");
    schedulePersistUser();
    renderAssetSummary();
  });
  renderFlexShopList();
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
      global: true,
    });
    setMessage(`경제 일정 · ${ev.title}`, "ok");
    applyCalendarEventPayload(ev);
    if (typeof ev.title === "string") {
      if (ev.title.includes("금리") && (ev.title.includes("인상") || ev.title.includes("긴축"))) {
        setMarketTemperature("cold", "금리 이슈 반영");
      } else if (ev.title.includes("금리") && (ev.title.includes("인하") || ev.title.includes("완화"))) {
        setMarketTemperature("hot", "금리 완화 기대");
      }
    }
  });
}

function onSessionSecondTick() {
  processRelistingQueue();
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
  setMarketTemperature(pickWeightedMarketTemperature(), "일일 시장 순환");

  finishRollToPreMarketDay();
}

function closeMarket() {
  if (onlineMode) return;
  if (awaitingDayRoll) return;

  if (tickInCandle > 0) {
    sealCurrentCandleAndReset();
  }
  applyBankDailyAccrual();
  applyDailyStockDividends();
  snapshotPreviousDayTotalAssets();

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
}

function dismissMessage() {
  const shell = document.getElementById("message");
  if (!shell) return;
  clearTimeout(messageHideTimer);
  messageHideTimer = null;
  clearTimeout(messageDismissFadeTimer);
  shell.classList.add("mts-toast--hiding");
  messageDismissFadeTimer = setTimeout(() => {
    shell.hidden = true;
    shell.classList.remove("mts-toast--hiding");
    messageDismissFadeTimer = null;
  }, 320);
}

function setMessage(text, type = "") {
  const shell = document.getElementById("message");
  const textEl = document.getElementById("messageText");
  if (!shell || !textEl) return;
  clearTimeout(messageHideTimer);
  clearTimeout(messageDismissFadeTimer);
  messageHideTimer = null;
  shell.classList.remove("mts-toast--hiding");
  textEl.textContent = text;
  const card = shell.querySelector(".mts-toast-card");
  if (card) {
    card.className = "mts-toast-card" + (type ? ` ${type}` : "");
  }
  shell.hidden = false;
  messageHideTimer = setTimeout(() => dismissMessage(), 3600);
}

function bindToastUiOnce() {
  const shell = document.getElementById("message");
  const btn = document.getElementById("messageClose");
  if (!shell || !btn || shell.dataset.toastBound === "1") return;
  shell.dataset.toastBound = "1";
  btn.addEventListener("click", () => dismissMessage());
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
      <td class="td-portfolio-name">
        <span class="stock-name">${escapeHtml(s.name)}</span>
        <span class="stock-ticker">${escapeHtml(s.id)}</span>
      </td>
      <td class="td-portfolio-price"><span data-portfolio-price="${escapeHtml(s.id)}" class="watch-price portfolio-price-cell">${formatStockWon(s.price)}</span></td>
      <td class="td-portfolio-avg">${owned > 0 ? formatStockWon(avg) : "—"}</td>
      <td class="td-portfolio-held">${owned > 0 ? formatShares(owned) : "—"}</td>
      <td class="${plCls} portfolio-pl-cell" data-portfolio-pl="${escapeHtml(s.id)}">${owned > 0 ? `${pl >= 0 ? "+" : ""}${formatWon(pl)}` : "—"}</td>
      <td class="cell-qty-portfolio">
        <input type="number" class="qty-input portfolio-qty-input" min="0" step="1" value="1" data-stock="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)} 수량" inputmode="numeric" />
        <div class="portfolio-qty-quick">
          <button type="button" class="btn-mts ghost btn-qty-quick btn-portfolio-smart" data-portfolio-smart="${escapeHtml(s.id)}" title="보유 시: 전량 매도 수량 · 미보유 시: 예수금 풀매수 수량">전량</button>
        </div>
      </td>
      <td class="cell-actions cell-actions-portfolio">
        <button type="button" class="btn-mts buy btn-portfolio-trade" data-action="buy" data-stock="${escapeHtml(s.id)}">매수</button>
        <button type="button" class="btn-mts sell btn-portfolio-trade" data-action="sell" data-stock="${escapeHtml(s.id)}">매도</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-portfolio-smart]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.getAttribute("data-portfolio-smart");
      const st = getStockById(id);
      const row = b.closest("tr");
      const input = row?.querySelector(".qty-input");
      if (!st || !input || st.price <= 0) return;
      const sh = Math.max(0, Math.floor(Number(game.holdings[id] ?? 0)));
      if (sh > 0) {
        input.value = String(sh);
      } else {
        const q = maxBuySharesForCash(game.cash, st.price);
        input.value = q > 0 ? String(q) : "0";
      }
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
    arena: document.getElementById("tab-arena"),
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
    if (tab === "arena") {
      setMultiplyOfflineHints();
      scheduleMultiplyLeaderboardRefresh();
      renderBankAndFlexUi();
    }
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

async function runSeason2HardReset() {
  clearGameClockTimer();
  clearAmbientNewsTimer();
  clearMarketClientTick();

  gameDayIndex = 0;
  gameMinutes = MARKET_OPEN_MIN;
  awaitingDayRoll = false;
  isMarketClosed = false;
  openingGapAppliedToday = true;
  openingGapBlendByStock = {};
  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  afterHoursNewsCounts = emptyPremarketNewsCounts();
  afterHoursNewsScheduleByMin = {};
  afterHoursPlanGeneratedToday = false;
  pendingOrders = [];
  scheduledEvents = buildInitialCalendar();
  ensureCalendarHorizon();

  game.cash = 1_000_000;
  game.initialCapital = 1_000_000;
  playerProfile.hasReceivedStartingFund = true;
  playerProfile.previousDayTotalAssets = 1_000_000;
  playerProfile.sessionOpenNetWorthPl = 1_000_000;
  playerProfile.bankDeposit = 0;
  playerProfile.bankLoan = 0;
  playerProfile.bankDepositRate = BANK_DAILY_DEPOSIT_RATE;
  playerProfile.bankLoanRate = BANK_DAILY_LOAN_RATE;
  playerProfile.flexTopItemId = "";
  if (loginDisplayName) writeStartingFundGuard(loginDisplayName);
  game.holdings = {};
  game.costBasis = {};
  STOCK_SPECS.forEach((spec) => {
    game.holdings[spec.id] = 0;
    game.costBasis[spec.id] = 0;
    virtualTraderHoldingsByStock[spec.id] = 0;
    executionFlowByStock[spec.id] = { buyVol: 1, sellVol: 1 };
    tradePressureByStock[spec.id] = 0;
    crowdFomoStateByStock[spec.id] = { buyRush: 0, sellPanic: 0 };
    delete lastShockNewsOrdinalByStock[spec.id];
  });

  stocks.forEach((s) => {
    const spec = stockSpecById(s.id);
    s.price = Math.max(0, Math.floor(Number(spec?.price) || 100));
    delistedStocks[s.id] = false;
    delete pendingRelistingByStock[s.id];
    ipoListingPriceByStock[s.id] = Math.max(100, Math.floor(s.price));
  });
  Object.keys(deadCatTrapState).forEach((k) => {
    delete deadCatTrapState[k];
  });
  Object.keys(consecutive1WonTicks).forEach((k) => {
    delete consecutive1WonTicks[k];
  });
  Object.keys(survivedDelistCapAt1Won).forEach((k) => {
    delete survivedDelistCapAt1Won[k];
  });
  qeCrisisLatchActive = false;

  resetNewsSpikeState();
  resetDailyNewsState();
  clearCandleHistory();
  snapshotSessionOpen();
  renderPendingOrdersUi();

  const msg =
    "🚨 [긴급] 경제 대공황으로 인한 화폐 개혁 실시! 모든 자산이 100만 원으로 재설정되었습니다. 시즌 2 시작!";
  addNewsItem(msg, "calendar", "", { global: true });
  setMessage(msg, "ok");

  if (onlineMode && sb && loginDisplayName) {
    try {
      await sb.rpc("reset_name_progress", { p_login_name: loginDisplayName });
      await loadUserFromServer();
      STOCK_SPECS.forEach((spec) => {
        game.holdings[spec.id] = 0;
        game.costBasis[spec.id] = 0;
      });
      game.cash = 1_000_000;
      game.initialCapital = 1_000_000;
    } catch (e) {
      console.warn("runSeason2HardReset rpc", e);
    }
  }

  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();
  renderStocks();
  renderAssetSummary();
  updateDetailPriceLine();
  if (selectedStockId) {
    refreshDetailChart();
    updateOrderBookAndStrength(selectedStockId);
  }
  syncTradeButtons();
  schedulePersistUser();
  flushPersistUser();
}

function initNewGame() {
  isUserDataLoaded = false;
  gameDayIndex = 0;
  gameMinutes = MARKET_OPEN_MIN;
  awaitingDayRoll = false;
  isMarketClosed = false;
  openingGapAppliedToday = true;
  openingGapBlendByStock = {};
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
  playerProfile.previousDayTotalAssets = INITIAL_CAPITAL;
  playerProfile.sessionOpenNetWorthPl = INITIAL_CAPITAL;
  playerProfile.bankDeposit = 0;
  playerProfile.bankLoan = 0;
  playerProfile.bankDepositRate = BANK_DAILY_DEPOSIT_RATE;
  playerProfile.bankLoanRate = BANK_DAILY_LOAN_RATE;
  playerProfile.flexTopItemId = "";
  playerProfile.lastSalaryMonthKey =
    getMonthContextForDayIndex(gameDayIndex).monthKey;

  stocks.forEach((s) => {
    s.price = randomInitialPrice();
    ipoListingPriceByStock[s.id] = Math.max(100, s.price);
    delistedStocks[s.id] = false;
    delete pendingRelistingByStock[s.id];
    virtualTraderHoldingsByStock[s.id] = 0;
    executionFlowByStock[s.id] = { buyVol: 1, sellVol: 1 };
    tradePressureByStock[s.id] = 0;
    crowdFomoStateByStock[s.id] = { buyRush: 0, sellPanic: 0 };
    delete lastShockNewsOrdinalByStock[s.id];
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
  snapshotSessionOpenNetWorthForDailyPl();
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
  subscribeMultiplayerRealtime();
  setMultiplyOfflineHints();

  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();
  renderProfileDisplay();

  initTabs();

  bindDetailChartRangeUiOnce();
  bindDetailChartD1DaySwipeOnce();
  bindDetailChartTypeToggleOnce();
  loadStockCommunityStore();
  bindStockCommunityOnce();
  bindMarketListFilterUiOnce();
  bindBankAndFlexUiOnce();

  bindLifeUi();
  bindCharacterSetup();
  bindTutorialUiOnce();
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
  bindToastUiOnce();
  window.season2HardReset = () =>
    runSeason2HardReset().catch((e) => console.error("season2HardReset", e));
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
