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

/** 온보딩 튜토리얼 1회 완료 플래그 (브라우저 로컬) */
const LS_TUTORIAL_DONE_KEY = "stockLifeTutorialV1Done";

/** 튜토리얼 표시 중: 시계·로컬 생활 로직 정지, 시세 Realtime만 수신 */
let tutorialGateActive = false;

const MAX_NEWS_ITEMS = 48;
const NEXT_TRADING_DAY_DELAY_MS = 2200;
const INITIAL_CAPITAL = 1_000_000;

/** 현실 1초 = 게임 내 1분 */
const GAME_MINUTES_PER_REAL_SEC = 1;
/** 한 봉 = 게임 시간 10분 = 현실 10초 (매초 시세 변동, 10초마다 봉 확정) */
const CANDLE_GAME_MINUTES = 10;
const TICKS_PER_CANDLE = 10;
const DIVIDEND_EVERY_CANDLES = 4;

const MARKET_OPEN_MIN = 9 * 60;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
/** 장 시작 전 대기(프리마켓) — 08:00~09:00, 매매 불가 · 시계만 진행 */
const PREMARKET_START_MIN = 8 * 60;
/** 08:00~08:50(게임분 480~529): 프리마켓 뉴스 폭격 구간 */
const PREMARKET_NEWS_END_MIN = 8 * 60 + 50;
/** Net Impact 1당 전일 종가 대비 시초가 변동률(±) */
const GAP_PCT_PER_NET_IMPACT = 0.05;
/** 09:00~15:30 = 390게임분 = 현실 390초(6분30초), 10분봉 39개 */
const SESSION_GAME_MINUTES = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;
const CANDLES_PER_SESSION = SESSION_GAME_MINUTES / CANDLE_GAME_MINUTES;

/** 온라인: 현실 10초마다 클라이언트가 리더 선출 후 DB 갱신(게임 내 10분봉 1개분과 동일) */
const ONLINE_CLIENT_TICK_MS = 10_000;
const ONLINE_STALE_AFTER_MS = 10_000;

const CANDLE_UP = "#ff4b4b";
const CANDLE_DOWN = "#3182f6";

/** 이번 달 알바 스케줄: 일당 시드 지급 · N일 이상 시 피로 패널티 */
const JOB_PAY_PER_DAY = 22_000;
const JOB_OVERWORK_DAYS = 15;
/** 피로 시 매수·매도 가격 대비 추가 부담(실수 수수료) */
const FATIGUE_EXTRA_FEE_RATE = 0.052;

/** 플레이어 프로필 — 캐릭터 설정 + 알바 스케줄(프로필 JSON 동기화) */
let playerProfile = {
  name: "",
  age: 20,
  birthday: "",
  setupComplete: false,
  /** `"2026-4"`: { count, days: number[], overwork } */
  jobCommitByMonth: {},
};

let gameClockEverStarted = false;
let phoneClockIntervalId = null;

/** 이 게임일 인덱스에 도달하면 인생 이벤트 1회(차단 모달 없음) */
let lifeNextEventDayIndex = 999999;

/** 과다 알바 시 다음 달 시작까지: 뉴스 지연·가림 + 매매 추가 부담 */
let jobFatigueUntilDayIndex = 0;

let newsFeedRevealTimers = [];

/** 달력 UI에서 선택한 일(1~31) */
let jobScheduleSelectedDays = new Set();

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

let saveDebounceId = null;

let sb = null;
let onlineMode = false;
let marketChannel = null;
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
};

let gameDayIndex = 0;
let headlineImpulse = 0;
let sessionCandleCount = 0;
let dividendCandleCounter = 0;

let isPaused = false;
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
/** 09:00 시초가 갭 반영 여부(하루 1회) */
let openingGapAppliedToday = false;

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

/** 관심 종목 티커 — 뉴스 가중치에 사용 */
let watchlistIds = [];

const LIFE_RANDOM_EVENTS = [
  {
    body: "전공 과제에 시달리다 배달 음식으로 한 끼를 때웠습니다. 지출이 생겼지만 숨이 좀 돌아왔습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 30_000);
    },
  },
  {
    body: "학생회 오티 회비를 납부했습니다. 계좌에서 돈이 빠져나갔습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 50_000);
    },
  },
  {
    body: "친구들과 멀리 떠난 바다 여행을 다녀왔습니다. 통장은 가벼워졌지만 기분은 좋았습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 150_000);
    },
  },
  {
    body: "동아리 방에서 밤새 과제를 마무리했습니다. 카페 값과 야식 비용이 들었습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 18_000);
    },
  },
  {
    body: "어릴 적 친구가 찾아와 오랜만에 밥을 사줬습니다. 덕분에 지갑은 그대로였습니다.",
    apply() {
      /* 변동 없음 */
    },
  },
];

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

function firstDayIndexOfNextMonth(dayIdx) {
  const d = dayIndexToDate(dayIdx);
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return dateToDayIndex(next);
}

function hasJobFatigue() {
  return gameDayIndex < jobFatigueUntilDayIndex;
}

function syncTradeButtons() {
  const canTrade = isTradingWindowActive();
  ["detailBtnBuy", "detailBtnSell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !canTrade;
      el.classList.toggle("is-trade-locked", !canTrade);
    }
  });
  document.querySelectorAll("#stockRows button[data-action]").forEach((btn) => {
    btn.disabled = !canTrade;
    btn.classList.toggle("is-trade-locked", !canTrade);
  });
}

function renderLifeStatus() {
  renderProfileDisplay();
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
    `${month}월 ${day}일 08:00 — 장 시작 전 · 프리마켓 뉴스를 확인하세요 (09:00 시초가 갭)`,
    "news"
  );

  if (!onlineMode) {
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }

  schedulePersistUser();
  syncNextTurnButton();
  syncTradeButtons();
}

function scheduleNextLifeEventDay() {
  lifeNextEventDayIndex = gameDayIndex + 2 + Math.floor(Math.random() * 4);
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
  const pauseBtn = document.getElementById("btnPause");
  populateSetupForm();
  if (!playerProfile.setupComplete) {
    showScreen("screen-setup");
    if (pauseBtn) pauseBtn.disabled = true;
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
    if (pauseBtn) pauseBtn.disabled = true;
    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    syncNextTurnButton();
    requestAnimationFrame(() => document.getElementById("btnTutorialDismiss")?.focus());
    return;
  }
  showScreen("screen-game");
  if (pauseBtn) {
    if (awaitingDayRoll) {
      pauseBtn.disabled = true;
      const lab = pauseBtn.querySelector(".mts-pause-label");
      if (lab) lab.textContent = "종료";
      pauseBtn.classList.add("market-ended");
    } else {
      pauseBtn.disabled = false;
      pauseBtn.classList.remove("market-ended");
      updatePauseButton();
    }
  }
  renderAssetSummary();
  renderLifeStatus();
  renderStocks();
  syncTradeButtons();
  syncNextTurnButton();
  startGameClockFromInit(false);
}

function syncJobScheduleSelectionFromProfile() {
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  const committed = playerProfile.jobCommitByMonth?.[mk];
  jobScheduleSelectedDays = new Set();
  if (committed && Array.isArray(committed.days)) {
    committed.days.forEach((d) => jobScheduleSelectedDays.add(d));
  }
}

function updateJobScheduleSummary() {
  const summary = document.getElementById("jobScheduleSummary");
  const hint = document.getElementById("jobSchedulePenaltyHint");
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  const n = jobScheduleSelectedDays.size;
  const pay = n * JOB_PAY_PER_DAY;
  const committed = playerProfile.jobCommitByMonth?.[mk];
  if (summary) {
    if (committed) {
      summary.textContent = `확정됨: ${committed.count}일 · 총 ${formatWon(
        committed.count * JOB_PAY_PER_DAY
      )} 지급 완료${committed.overwork ? " · 과로 경고 적용됨" : ""}`;
    } else {
      summary.textContent = `선택 ${n}일 · 예상 급여 ${formatWon(pay)} (확정 시 일시 지급)`;
    }
  }
  if (hint) {
    if (hasJobFatigue()) {
      hint.hidden = false;
      hint.textContent =
        "피로 누적: 뉴스가 늦게 표시되고 일부 문구가 흐릿합니다. 매매 시 추가 부담이 붙습니다.";
    } else if (!committed && n >= JOB_OVERWORK_DAYS) {
      hint.hidden = false;
      hint.textContent = `선택 ${n}일: 확정 시 당분간 뉴스 지연·추가 매매 부담이 적용됩니다.`;
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
}

function renderJobScheduleUi() {
  const label = document.getElementById("jobScheduleMonthLabel");
  const row = document.getElementById("jobScheduleWeekdayRow");
  const cal = document.getElementById("jobScheduleCalendar");
  const btn = document.getElementById("btnJobScheduleConfirm");
  if (!label || !cal) return;
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  label.textContent = `${ctx.y}년 ${ctx.m}월 (게임 캘린더)`;
  if (row) {
    row.innerHTML = ["일", "월", "화", "수", "목", "금", "토"]
      .map((d) => `<span>${d}</span>`)
      .join("");
  }
  syncJobScheduleSelectionFromProfile();
  const committed = playerProfile.jobCommitByMonth?.[mk];
  cal.innerHTML = "";
  for (let i = 0; i < ctx.padSun; i += 1) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "job-schedule-day is-muted";
    b.disabled = true;
    b.setAttribute("aria-hidden", "true");
    cal.appendChild(b);
  }
  for (let d = 1; d <= ctx.daysInMonth; d += 1) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "job-schedule-day";
    b.dataset.day = String(d);
    b.textContent = String(d);
    if (jobScheduleSelectedDays.has(d)) b.classList.add("is-selected");
    if (committed) {
      b.disabled = true;
      b.classList.add("is-muted");
    }
    cal.appendChild(b);
  }
  if (btn) {
    btn.disabled = !!committed;
    btn.textContent = committed ? "이번 달 스케줄 확정됨" : "이번 달 스케줄 확정하기";
  }
  updateJobScheduleSummary();
}

function onConfirmJobSchedule() {
  const ctx = getMonthContextForDayIndex(gameDayIndex);
  const mk = ctx.monthKey;
  if (playerProfile.jobCommitByMonth?.[mk]) {
    setMessage("이미 확정된 달입니다.", "err");
    return;
  }
  const n = jobScheduleSelectedDays.size;
  if (n <= 0) {
    setMessage("알바할 날짜를 하나 이상 선택하세요.", "err");
    return;
  }
  const days = Array.from(jobScheduleSelectedDays).sort((a, b) => a - b);
  const pay = n * JOB_PAY_PER_DAY;
  const overwork = n >= JOB_OVERWORK_DAYS;
  game.cash += pay;
  if (!playerProfile.jobCommitByMonth) playerProfile.jobCommitByMonth = {};
  playerProfile.jobCommitByMonth[mk] = { count: n, days, overwork };
  if (overwork) {
    jobFatigueUntilDayIndex = firstDayIndexOfNextMonth(gameDayIndex);
  }
  setMessage(
    overwork
      ? `알바 ${n}일 확정 · ${formatWon(pay)} 지급. 과로로 뉴스·매매에 불이익이 당분간 적용됩니다.`
      : `알바 ${n}일 확정 · ${formatWon(pay)} 지급.`,
    "ok"
  );
  renderAssetSummary();
  schedulePersistUser();
  renderJobScheduleUi();
}

function bindLifeUi() {
  const cal = document.getElementById("jobScheduleCalendar");
  const btn = document.getElementById("btnJobScheduleConfirm");
  if (cal && cal.dataset.bound !== "1") {
    cal.dataset.bound = "1";
    cal.addEventListener("click", (e) => {
      const t = e.target.closest(".job-schedule-day");
      if (!t || t.disabled || t.classList.contains("is-muted")) return;
      const day = Number(t.dataset.day);
      if (!Number.isFinite(day)) return;
      const mk = getMonthContextForDayIndex(gameDayIndex).monthKey;
      if (playerProfile.jobCommitByMonth?.[mk]) return;
      if (jobScheduleSelectedDays.has(day)) jobScheduleSelectedDays.delete(day);
      else jobScheduleSelectedDays.add(day);
      t.classList.toggle("is-selected", jobScheduleSelectedDays.has(day));
      updateJobScheduleSummary();
    });
  }
  if (btn && btn.dataset.bound !== "1") {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => onConfirmJobSchedule());
  }
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

  const prof = row.profile && typeof row.profile === "object" ? row.profile : {};
  playerProfile.name = typeof prof.name === "string" ? prof.name : nm;
  playerProfile.age = typeof prof.age === "number" ? prof.age : 20;
  playerProfile.birthday = typeof prof.birthday === "string" ? prof.birthday : "";
  playerProfile.setupComplete = !!prof.setupComplete;
  playerProfile.jobCommitByMonth =
    prof.jobCommitByMonth && typeof prof.jobCommitByMonth === "object"
      ? prof.jobCommitByMonth
      : {};
  if (typeof prof.jobFatigueUntilDayIndex === "number") {
    jobFatigueUntilDayIndex = prof.jobFatigueUntilDayIndex;
  } else {
    jobFatigueUntilDayIndex = 0;
  }
  watchlistIds = Array.isArray(prof.watchlist)
    ? prof.watchlist.filter((id) => STOCK_SPECS.some((s) => s.id === id))
    : [];
  if (typeof prof.nextLifeEventDayIndex === "number") {
    lifeNextEventDayIndex = prof.nextLifeEventDayIndex;
  }

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
    game.holdings[p.symbol] = Number(p.shares);
    game.costBasis[p.symbol] = Number(p.avg_cost);
  });
  if (jobFatigueUntilDayIndex > 0 && gameDayIndex >= jobFatigueUntilDayIndex) {
    jobFatigueUntilDayIndex = 0;
  }
  renderPlayerLoginBadge();
  renderJobScheduleUi();
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

function renderNewsFeedFromServer(items) {
  const list = document.getElementById("newsFeed");
  if (!list || !Array.isArray(items)) return;
  clearNewsFeedRevealTimers();
  list.innerHTML = "";
  const arr = items.slice(0, MAX_NEWS_ITEMS);
  const fatigue = hasJobFatigue();
  arr.forEach((it, index) => {
    const delay = fatigue ? Math.min(9000, 900 + index * 550) : 0;
    const blur = fatigue && (index % 3 !== 1 || Math.random() < 0.4);
    const show = () => {
      const li = document.createElement("li");
      li.className = `news-item news-${it.type || "news"}`;
      const timeEl = document.createElement("span");
      timeEl.className = "news-time";
      const d = new Date(it.ts || Date.now());
      timeEl.textContent = d.toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const textEl = document.createElement("span");
      textEl.className = "news-text" + (blur ? " news-text--fatigue" : "");
      textEl.textContent = it.text || "";
      li.appendChild(timeEl);
      li.appendChild(textEl);
      list.appendChild(li);
    };
    if (delay > 0) {
      const tid = setTimeout(show, delay);
      newsFeedRevealTimers.push(tid);
    } else {
      show();
    }
  });
}

function applyServerMarketState(m) {
  if (!m || m.initialized === false) return;
  const prev = lastMarketSnapshotForDividend;
  if (!tutorialGateActive) {
    maybePayDividendFromServerTick(prev, m);
  }
  lastMarketSnapshotForDividend = JSON.parse(JSON.stringify(m));

  gameDayIndex = m.gameDayIndex ?? 0;
  if (jobFatigueUntilDayIndex > 0 && gameDayIndex >= jobFatigueUntilDayIndex) {
    jobFatigueUntilDayIndex = 0;
    schedulePersistUser();
  }
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
  isPaused = false;
  headlineImpulse = m.headlineImpulse ?? 0;
  nextCalendarEventId = m.nextCalendarEventId ?? 1;
  scheduledEvents = Array.isArray(m.scheduledEvents) ? m.scheduledEvents : [];
  newsCountByStock = { ...emptyChainState(), ...m.newsCountByStock };
  chainStepByStock = { ...emptyChainState(), ...m.chainStepByStock };
  dividendCandleCounter = m.dividendCandleCounter ?? 0;
  sessionCandleCount = m.sessionCandleCount ?? 0;
  tickInCandle = m.tickInCandle ?? 0;
  candlePeriodStartMin = m.candlePeriodStartMin ?? MARKET_OPEN_MIN;

  (m.stocks || []).forEach((row) => {
    const s = getStockById(row.id);
    if (!s) return;
    s.price = Math.round(row.price);
    s.volatilityMod = row.volatilityMod ?? 1;
    s.priceBias = row.priceBias ?? 0;
  });

  STOCK_SPECS.forEach((spec) => {
    const id = spec.id;
    candleHistory[id] = Array.isArray(m.candleHistory?.[id])
      ? m.candleHistory[id].map((r) => ({ ...r }))
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
      if (b && typeof b.o === "number") {
        candleOhlcBuffer[s.id] = { o: b.o, h: b.h, l: b.l };
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
        }))
        .slice(0, MAX_NEWS_ITEMS)
    : [];
  renderNewsFeedFromServer(serverNewsFeedItems);
  renderJobScheduleUi();
  updatePremarketChartOverlay();
  syncTradeButtons();
  syncNextTurnButton();
}

async function fetchMarketOnce() {
  if (!sb) return;
  const { data, error } = await sb
    .from(TBL_MARKET_STATE)
    .select("state")
    .eq("id", 1)
    .single();
  if (error) {
    console.warn("fetchMarketOnce", error);
    setMessage("시장 데이터를 불러오지 못했습니다. Edge Function·DB를 확인하세요.", "err");
    return;
  }
  if (data?.state) applyServerMarketState(data.state);
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
    dividendCandleCounter,
    sessionCandleCount,
    tickInCandle,
    candlePeriodStartMin,
    stocks: stocks.map((s) => ({
      id: s.id,
      price: s.price,
      volatilityMod: s.volatilityMod,
      priceBias: s.priceBias,
    })),
    candleHistory: ch,
    sessionOpenPrice: { ...sessionOpenPrice },
    candleOhlcBuffer: JSON.parse(JSON.stringify(candleOhlcBuffer)),
    newsFeed: serverNewsFeedItems.slice(0, MAX_NEWS_ITEMS),
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
    return;
  }

  if (gameMinutes === MARKET_OPEN_MIN && !openingGapAppliedToday) {
    applyOpeningGapFromPremarket();
  }

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarketOnline();
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
  if (tickInCandle >= TICKS_PER_CANDLE) {
    sealCurrentCandleAndReset();
  }
  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarketOnline();
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
  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close");
  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.disabled = true;
    const lab = pauseBtn.querySelector(".mts-pause-label");
    if (lab) lab.textContent = "종료";
    pauseBtn.classList.add("market-ended");
  }
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
  stocks.forEach((s) => {
    s.priceBias = 0;
  });
  ensureCalendarHorizon();
  fireDueCalendarEvents();
  const { month, day } = getCalendarParts(gameDayIndex);
  addNewsItem(
    `${month}월 ${day}일 08:00 — 장 시작 전 · 프리마켓 뉴스를 확인하세요`,
    "news"
  );
  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.querySelector(".mts-pause-label").textContent = "멈춤";
    pauseBtn.classList.remove("paused", "market-ended");
    pauseBtn.setAttribute("aria-pressed", "false");
    pauseBtn.setAttribute("aria-label", "시간 멈춤");
  }
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
    fetchMarketOnce().catch((e) => console.warn("fetchMarketOnce", reason, e));
    subscribeMarketRealtime();
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
        } catch (e) {
          console.warn("market_state handler", e);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        fetchMarketOnce().catch((e) => console.warn("fetch after subscribe", e));
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
      trade_blocked_until_ms: 0,
      initial_capital: game.initialCapital,
      profile: {
        name: playerProfile.name,
        age: playerProfile.age,
        birthday: playerProfile.birthday,
        setupComplete: playerProfile.setupComplete,
        watchlist: watchlistIds,
        nextLifeEventDayIndex: lifeNextEventDayIndex,
        jobCommitByMonth: playerProfile.jobCommitByMonth || {},
        jobFatigueUntilDayIndex,
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

/** 정규 매매 구간 09:00~15:30 (게임 분 기준) */
function isTradingWindowActive() {
  return gameMinutes >= MARKET_OPEN_MIN && gameMinutes < MARKET_CLOSE_MIN;
}

/** 08:00~09:00 장 시작 전(프리마켓 대기) */
function isPreMarketWindow() {
  return gameMinutes >= PREMARKET_START_MIN && gameMinutes < MARKET_OPEN_MIN;
}

function shouldAdvanceMarketClock() {
  if (isPaused || awaitingDayRoll) return false;
  return isPreMarketWindow() || isTradingWindowActive();
}

/** 다음 턴(1년) — 정규 장중이 아닐 때만 */
function canAdvanceYearTurn() {
  return !isTradingWindowActive();
}

function isTradingSession() {
  return !isPaused && isTradingWindowActive();
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
    addNewsItem(buildPremarketHeadline(ev.stockId, ev.positive), type);
  });
}

function triggerGapOpenAnimation() {
  const wrap = document.querySelector(".chart-stack");
  if (!wrap) return;
  wrap.classList.remove("chart-gap-open-flash");
  void wrap.offsetWidth;
  wrap.classList.add("chart-gap-open-flash");
  setTimeout(() => wrap.classList.remove("chart-gap-open-flash"), 1400);
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
    const { pos, neg } = premarketNewsCounts[spec.id] || { pos: 0, neg: 0 };
    const net = pos - neg;
    const s = getStockById(spec.id);
    if (!s) return;
    const mult = 1 + net * GAP_PCT_PER_NET_IMPACT;
    s.price = Math.round(Math.max(1_000, s.price * mult));
    summaryBits.push(`${spec.id} ${net > 0 ? "+" : ""}${net}`);
  });

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
    "premarket-open"
  );
  setMessage("09:00 개장 — 프리마켓 뉴스가 시초가에 반영되었습니다.", "ok");
  triggerGapOpenAnimation();

  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  updatePremarketChartOverlay();
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

async function buyStock(stockId, quantity) {
  if (tutorialGateActive) {
    return { ok: false, reason: "튜토리얼을 먼저 완료해 주세요." };
  }
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, reason: "수량은 1 이상의 정수여야 합니다." };
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
  if (hasJobFatigue()) {
    const extra = Math.round(stock.price * q * FATIGUE_EXTRA_FEE_RATE);
    if (extra > 0) {
      game.cash = Math.max(0, game.cash - extra);
      setMessage(`피로 누적 추가 부담 ${formatWon(extra)}`, "err");
    }
  }
  schedulePersistUser();
  return { ok: true };
}

async function sellStock(stockId, quantity) {
  if (tutorialGateActive) {
    return { ok: false, reason: "튜토리얼을 먼저 완료해 주세요." };
  }
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, reason: "수량은 1 이상의 정수여야 합니다." };
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
  if (hasJobFatigue()) {
    const gross = Math.round(stock.price * q);
    const extra = Math.round(gross * FATIGUE_EXTRA_FEE_RATE);
    if (extra > 0) {
      game.cash = Math.max(0, game.cash - extra);
      setMessage(`피로 누적 추가 부담 ${formatWon(extra)}`, "err");
    }
  }
  schedulePersistUser();
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
    if (!onlineLeaderSimulating) {
      payDividends();
    }
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
  const rows = candleHistory[stockId].map((r) => ({
    x: r.x,
    y: [r.o, r.h, r.l, r.c],
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
        y: [Math.round(o), Math.round(h), Math.round(l), Math.round(c)],
      });
    }
  }
  return rows;
}

function buildVolumeSeriesData(stockId) {
  const hist = candleHistory[stockId];
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

function triggerNewsShake() {
  const app = document.querySelector(".mts-app");
  if (!app) return;
  app.classList.remove("screen-shake");
  void app.offsetWidth;
  app.classList.add("screen-shake");
  setTimeout(() => app.classList.remove("screen-shake"), 450);
}

function addNewsItem(text, type = "news", subline = "") {
  if (onlineMode && onlineLeaderSimulating) {
    serverNewsFeedItems.unshift({
      ts: new Date().toISOString(),
      text,
      type: type || "news",
    });
    while (serverNewsFeedItems.length > MAX_NEWS_ITEMS) {
      serverNewsFeedItems.pop();
    }
    return;
  }

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

  triggerNewsShake();
}

function tryFireChainNews(completedCandleCount) {
  Object.keys(NEWS_CHAINS).forEach((stockId) => {
    const sched = CHAIN_SCHEDULE[stockId];
    if (!sched) return;
    const step = chainStepByStock[stockId];
    if (step >= sched.length || newsCountByStock[stockId] >= 3) return;
    if (completedCandleCount !== sched[step]) return;

    const story = NEWS_CHAINS[stockId][step];
    addNewsItem(story.headline, "chain");
    applyNewsPayload(story);
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
    if (!isPaused && isTradingSession()) {
      const sid = pickStockIdForAmbientNews();
      const s = sid ? getStockById(sid) : null;
      if (s) {
        const tpl =
          AMBIENT_NEWS_TEMPLATES[
            Math.floor(Math.random() * AMBIENT_NEWS_TEMPLATES.length)
          ];
        addNewsItem(tpl(s.name), "ambient");
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
  const a = document.getElementById("profileAgeDisplay");
  const b = document.getElementById("profileBirthDisplay");
  if (n) n.textContent = playerProfile.name?.trim() ? playerProfile.name : "—";
  if (a) {
    a.textContent =
      typeof playerProfile.age === "number" ? `${playerProfile.age}살` : "—";
  }
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
  btn.addEventListener("click", () => {
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
    schedulePersistUser();
    const pauseBtn = document.getElementById("btnPause");
    if (!isTutorialDone()) {
      showScreen("screen-tutorial");
      if (pauseBtn) pauseBtn.disabled = true;
      requestAnimationFrame(() => document.getElementById("btnTutorialDismiss")?.focus());
    } else {
      showScreen("screen-game");
      if (pauseBtn) {
        if (awaitingDayRoll) {
          pauseBtn.disabled = true;
          const lab = pauseBtn.querySelector(".mts-pause-label");
          if (lab) lab.textContent = "종료";
          pauseBtn.classList.add("market-ended");
        } else {
          pauseBtn.disabled = false;
          pauseBtn.classList.remove("market-ended");
          updatePauseButton();
        }
      }
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
        "news"
      );
      onSessionSecondTick();
      startGameClockTimer();
      scheduleAmbientNewsTimer();
    } else if (awaitingDayRoll) {
      scheduleNextTradingDay();
    } else if (isPaused) {
      clearGameClockTimer();
      clearAmbientNewsTimer();
    } else {
      startGameClockTimer();
      scheduleAmbientNewsTimer();
    }

    if (phoneClockIntervalId) clearInterval(phoneClockIntervalId);
    updatePhoneShellClock();
    phoneClockIntervalId = setInterval(updatePhoneShellClock, 15000);

    const pb = document.getElementById("btnPause");
    if (pb) {
      if (awaitingDayRoll) {
        pb.disabled = true;
        const lab = pb.querySelector(".mts-pause-label");
        if (lab) lab.textContent = "종료";
        pb.classList.add("market-ended");
      } else {
        pb.disabled = false;
        pb.classList.remove("market-ended");
        updatePauseButton();
      }
    }

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

function toggleWatchlist(stockId) {
  const idx = watchlistIds.indexOf(stockId);
  if (idx >= 0) watchlistIds.splice(idx, 1);
  else watchlistIds.push(stockId);
  schedulePersistUser();
  renderStockListMain();
  updateDetailWatchlistButton();
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
  if (onlineMode && sb && loginDisplayName) {
    const { error } = await sb.rpc("reset_name_progress", { p_login_name: loginDisplayName });
    if (error) {
      setMessage(error.message, "err");
      return;
    }
  }
  clearSessionName();
  location.reload();
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
          <span class="mts-badge ${volatilityBadgeClass(s.volatility)}">${volatilityLabel(s.volatility)}</span>
        </div>
        <div class="stock-list-price-block">
          <span class="stock-list-price watch-price" data-watch-price="${escapeHtml(s.id)}">${formatWon(s.price)}</span>
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
  if (el && s) el.textContent = formatWon(s.price);
}

function openStockDetail(stockId) {
  const s = getStockById(stockId);
  if (!s) return;

  selectedStockId = stockId;
  syncTradeButtons();
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
  updateDetailWatchlistButton();
  updatePremarketChartOverlay();
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

function bindDetailTrade() {
  const back = document.getElementById("btnBackToList");
  if (back) back.addEventListener("click", closeStockDetail);

  const wlBtn = document.getElementById("btnDetailWatchlist");
  if (wlBtn) {
    wlBtn.addEventListener("click", () => {
      if (selectedStockId) toggleWatchlist(selectedStockId);
    });
  }

  const buyBtn = document.getElementById("detailBtnBuy");
  const sellBtn = document.getElementById("detailBtnSell");
  const qtyInput = document.getElementById("detailQtyInput");

    async function doTrade(action) {
    const id = selectedStockId;
    if (!id || !qtyInput) return;
    if (tutorialGateActive) {
      setMessage("튜토리얼을 먼저 완료해 주세요.", "err");
      return;
    }
    const qty = qtyInput.value;
    const result =
      action === "buy" ? await buyStock(id, qty) : await sellStock(id, qty);
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
      schedulePersistUser();
    } else {
      setMessage(result.reason, "err");
    }
  }

  if (buyBtn) buyBtn.addEventListener("click", () => doTrade("buy"));
  if (sellBtn) sellBtn.addEventListener("click", () => doTrade("sell"));
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
    setMessage(`경제 일정 · ${ev.title}`, "ok");
    applyCalendarEventPayload(ev);
  });
}

function onSessionSecondTick() {
  if (tutorialGateActive) return;
  if (onlineMode) return;
  if (isPaused || awaitingDayRoll) return;
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
  updatePremarketChartOverlay();

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

  schedulePersistUser();
  syncTradeButtons();

  if (gameMinutes >= MARKET_CLOSE_MIN) {
    closeMarket();
  } else {
    syncNextTurnButton();
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

  stocks.forEach((s) => {
    s.priceBias = 0;
  });

  ensureCalendarHorizon();
  fireDueCalendarEvents();

  if (gameDayIndex >= lifeNextEventDayIndex) {
    const ev =
      LIFE_RANDOM_EVENTS[Math.floor(Math.random() * LIFE_RANDOM_EVENTS.length)];
    ev.apply();
    addNewsItem(`[인생] ${ev.body}`, "life");
    scheduleNextLifeEventDay();
    schedulePersistUser();
  }

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

  addNewsItem("장 마감 — 오늘의 거래가 종료되었습니다.", "close");
  setMessage("장 마감 — 다음 거래일 08:00부터 프리마켓이 시작됩니다.", "ok");

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.querySelector(".mts-pause-label").textContent = "종료";
    pauseBtn.classList.add("market-ended");
  }

  flushPersistUser();
  scheduleNextTradingDay();
  syncNextTurnButton();
}

function updatePauseButton() {
  const btn = document.getElementById("btnPause");
  if (!btn || awaitingDayRoll) return;
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
  if (onlineMode) {
    setMessage("온라인 모드에서는 공용 시장 시계를 멈출 수 없습니다.", "err");
    return;
  }
  if (awaitingDayRoll) return;
  if (!gameClockEverStarted) return;
  isPaused = paused;
  if (isPaused) {
    clearGameClockTimer();
    clearAmbientNewsTimer();
  } else {
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }
  updatePauseButton();
  schedulePersistUser();
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
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-stock");
      const action = btn.getAttribute("data-action");
      const row = btn.closest("tr");
      const input = row.querySelector(".qty-input");
      const qty = input.value;

      let result;
      if (action === "buy") result = await buyStock(id, qty);
      else result = await sellStock(id, qty);

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

function onPauseClick() {
  setPaused(!isPaused);
}

function initNewGame() {
  gameDayIndex = 0;
  gameMinutes = MARKET_OPEN_MIN;
  awaitingDayRoll = false;
  isMarketClosed = false;
  openingGapAppliedToday = true;
  premarketNewsCounts = emptyPremarketNewsCounts();
  premarketNewsScheduleByMin = {};
  isPaused = false;
  scheduledEvents = buildInitialCalendar();
  ensureCalendarHorizon();

  game.age = 25;
  game.cash = INITIAL_CAPITAL;
  game.holdings = {};
  game.costBasis = {};
  game.initialCapital = INITIAL_CAPITAL;

  jobFatigueUntilDayIndex = 0;
  playerProfile.jobCommitByMonth = {};
  scheduleNextLifeEventDay();

  stocks.forEach((s) => {
    s.price = randomInitialPrice();
    s.volatilityMod = 1;
    s.priceBias = 0;
  });

  headlineImpulse = 0;
  dividendCandleCounter = 0;
  sessionCandleCount = 0;

  watchlistIds = [];

  initHoldings();
  resetDailyNewsState();
  clearCandleHistory();

  warmupPrices();
  snapshotSessionOpen();
}

async function runGameBootstrap() {
  initNewGame();
  await fetchMarketOnce();
  subscribeMarketRealtime();
  await loadUserFromServer();

  renderDateTimeLine();
  renderCalendarUI();
  renderStockListMain();
  renderProfileDisplay();

  initTabs();

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", onPauseClick);
    if (awaitingDayRoll) {
      pauseBtn.disabled = true;
      pauseBtn.querySelector(".mts-pause-label").textContent = "종료";
      pauseBtn.classList.add("market-ended");
    } else {
      pauseBtn.disabled = false;
      pauseBtn.classList.remove("market-ended");
      updatePauseButton();
    }
  }

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
