/**
 * Stock Life — ApexCharts 캔들+거래량, 1초=장내 1분, 10분봉(현실 10초), 뉴스 체이닝
 * 온라인: Supabase Realtime `market_state` + RPC 매매
 */
import { createClient } from "@supabase/supabase-js";

/**
 * Supabase `public` 스키마 테이블명 — `supabase/stock_life_full_setup.sql` 과 동일해야 함.
 * (구버전 name_players / name_portfolios 사용 금지)
 */
const TBL_USERS = "users";
const TBL_PORTFOLIOS = "portfolios";
const TBL_MARKET_STATE = "market_state";

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
/** 09:00~15:30 = 390게임분 = 현실 390초(6분30초), 10분봉 39개 */
const SESSION_GAME_MINUTES = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;
const CANDLES_PER_SESSION = SESSION_GAME_MINUTES / CANDLE_GAME_MINUTES;

const CANDLE_UP = "#ff4b4b";
const CANDLE_DOWN = "#3182f6";

const LIFE_HP_MAX = 100;
const LIFE_STRESS_MAX = 100;
/** 매수·매도 1회당 스트레스 소폭 상승 */
const TRADE_STRESS_DELTA = 2;
const HOSPITAL_FEE_MAX = 250_000;
const TRADE_BLOCK_MS = 30_000;

/** 리얼 알바: 현실 30초, 시장 틱은 백그라운드 유지 */
const JOB_DURATION_MS = 30_000;
const COUPANG_HIGH_PAY = 280_000;

const PART_TIME_JOBS = {
  coupang: {
    label: "쿠팡 물류센터",
    hpCost: 44,
    pay: COUPANG_HIGH_PAY,
    stressAdd: 6,
  },
  mart: {
    label: "편의점 카운터",
    hpCost: 5,
    pay: Math.round(COUPANG_HIGH_PAY / 5),
    stressAdd: 2,
  },
  hof: {
    label: "호프집 서빙",
    hpCost: 14,
    pay: 64_000,
    stressAdd: 5,
  },
  kidscafe: {
    label: "키즈카페",
    hpCost: 9,
    pay: 52_000,
    stressAdd: 3,
  },
};

let activeJobId = null;
let activeJobUntil = 0;
let activeJobTimerId = null;
let hofGuestLoopId = null;
let kidStressLoopId = null;
/** 호프 손님 호출 중 매매 금지까지 */
let hofGuestCallUntil = 0;

/** 플레이어 프로필 — 캐릭터 설정 */
let playerProfile = {
  name: "",
  age: 20,
  birthday: "",
  setupComplete: false,
};

let gameClockEverStarted = false;
let phoneClockIntervalId = null;

let lifeHp = LIFE_HP_MAX;
let lifeStress = 0;
/** Date.now() 이전이면 매매 가능 */
let tradeBlockedUntil = 0;
/** 이 게임일 인덱스에 도달하면 인생 이벤트 1회 */
let lifeNextEventDayIndex = 999999;
let tradeBlockTimerId = null;
let pendingLifeEventApply = null;
/** 인생 이벤트 확인 후 `finishOpenNextTradingDay()` 호출 필요 */
let pendingFinishOpenTradingDay = false;

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
/** 이전 서버 market_state — 배당 봉 감지용 */
let lastMarketSnapshotForDividend = null;

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

/** 관심 종목 티커 — 뉴스 가중치에 사용 */
let watchlistIds = [];

const LIFE_RANDOM_EVENTS = [
  {
    body: "전공 과제에 시달리다 배달 음식으로 한 끼를 때웠습니다. 지출이 생겼지만 숨이 좀 돌아왔습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 30_000);
      lifeStress = Math.max(0, lifeStress - 25);
    },
  },
  {
    body: "학생회 오티 회비를 납부했습니다. 계좌에서 돈이 빠져나갔습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 50_000);
    },
  },
  {
    body: "친구들과 멀리 떠난 바다 여행을 다녀왔습니다. 통장은 가벼워졌지만 몸과 마음이 한결 가벼워졌습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 150_000);
      lifeHp = LIFE_HP_MAX;
      lifeStress = 0;
    },
  },
  {
    body: "동아리 방에서 밤새 과제를 마무리했습니다. 카페 값과 야식 비용이 들었습니다.",
    apply() {
      game.cash = Math.max(0, game.cash - 18_000);
      lifeStress = Math.min(LIFE_STRESS_MAX, lifeStress + 6);
    },
  },
  {
    body: "어릴 적 친구가 찾아와 오랜만에 밥을 사줬습니다. 덕분에 지갑은 그대로였습니다.",
    apply() {
      lifeStress = Math.max(0, lifeStress - 8);
    },
  },
];

function clampLifeHpStress() {
  lifeHp = Math.max(0, Math.min(LIFE_HP_MAX, Math.round(lifeHp)));
  lifeStress = Math.max(0, Math.min(LIFE_STRESS_MAX, Math.round(lifeStress)));
}

function isHospitalTradeBlocked() {
  return Date.now() < tradeBlockedUntil;
}

function isJobTradeBlocked() {
  if (!activeJobId || Date.now() >= activeJobUntil) return false;
  if (activeJobId === "coupang") return true;
  if (activeJobId === "hof" && Date.now() < hofGuestCallUntil) return true;
  return false;
}

function isTradeBlocked() {
  return isHospitalTradeBlocked() || isJobTradeBlocked();
}

function isJobBusyNow() {
  return !!(activeJobId && Date.now() < activeJobUntil);
}

function scheduleTradeBlockEndTimer() {
  if (tradeBlockTimerId) clearTimeout(tradeBlockTimerId);
  const ms = Math.max(0, tradeBlockedUntil - Date.now());
  if (ms <= 0) {
    tradeBlockTimerId = null;
    return;
  }
  tradeBlockTimerId = setTimeout(() => {
    tradeBlockTimerId = null;
    syncTradeButtons();
    setMessage("매매 제한이 해제되었습니다.", "ok");
  }, ms);
}

function syncTradeButtons() {
  const blocked = isTradeBlocked();
  ["detailBtnBuy", "detailBtnSell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = blocked;
      el.classList.toggle("is-trade-locked", blocked);
    }
  });
  document.querySelectorAll("#stockRows button[data-action]").forEach((btn) => {
    btn.disabled = blocked;
    btn.classList.toggle("is-trade-locked", blocked);
  });
}

function renderLifeStatus() {
  clampLifeHpStress();
  const hpT = document.getElementById("lifeHpText");
  const hpF = document.getElementById("lifeHpFill");
  const stT = document.getElementById("lifeStressText");
  const stF = document.getElementById("lifeStressFill");
  const hpTr = document.querySelector(".life-gauge:first-child .life-bar-track");
  const stTr = document.querySelector(".life-gauge:last-child .life-bar-track");
  if (hpT) hpT.textContent = `${lifeHp} / ${LIFE_HP_MAX}`;
  if (hpF) hpF.style.width = `${(lifeHp / LIFE_HP_MAX) * 100}%`;
  if (hpTr) {
    hpTr.setAttribute("aria-valuenow", String(lifeHp));
    hpTr.setAttribute("aria-valuemax", String(LIFE_HP_MAX));
  }
  if (stT) stT.textContent = `${lifeStress} / ${LIFE_STRESS_MAX}`;
  if (stF) stF.style.width = `${(lifeStress / LIFE_STRESS_MAX) * 100}%`;
  if (stTr) {
    stTr.setAttribute("aria-valuenow", String(lifeStress));
    stTr.setAttribute("aria-valuemax", String(LIFE_STRESS_MAX));
  }
  syncPartTimeButtons();
}

function syncPartTimeButtons() {
  clampLifeHpStress();
  const busy = isJobBusyNow();
  document.querySelectorAll(".parttime-btn[data-parttime]").forEach((btn) => {
    const key = btn.getAttribute("data-parttime");
    const job = PART_TIME_JOBS[key];
    if (!job) return;
    const can = lifeHp >= job.hpCost;
    btn.disabled = !can || busy;
    btn.title = busy
      ? "알바 진행 중입니다."
      : can
        ? ""
        : "체력이 부족합니다.";
  });
}

function addStressFromTrade() {
  lifeStress = Math.min(LIFE_STRESS_MAX, lifeStress + TRADE_STRESS_DELTA);
  renderLifeStatus();
  checkLifeCritical();
}

function checkLifeCritical() {
  clampLifeHpStress();
  if (lifeHp <= 0 || lifeStress >= LIFE_STRESS_MAX) {
    void triggerCollapsePenalty();
  }
}

async function triggerCollapsePenalty() {
  abortActiveJobForEmergency();

  let paid = Math.min(HOSPITAL_FEE_MAX, game.cash);
  if (onlineMode && sb && loginDisplayName) {
    const { data } = await sb.rpc("apply_hospital_penalty_by_name", {
      p_login_name: loginDisplayName,
    });
    if (data?.ok && data.paid != null) paid = Number(data.paid);
    await loadUserFromServer();
  } else {
    game.cash -= paid;
    lifeHp = 45;
    lifeStress = 55;
    tradeBlockedUntil = Date.now() + TRADE_BLOCK_MS;
    clampLifeHpStress();
  }

  const body = document.getElementById("collapseModalBody");
  if (body) {
    body.textContent = `과로로 쓰러져 응급실을 찾았습니다. 진료비로 ${formatWon(
      paid
    )}이(가) 청구되었습니다. 의사는 ${TRADE_BLOCK_MS / 1000}초간 주식 매매를 삼가라고 했습니다.`;
  }
  const overlay = document.getElementById("collapseModal");
  if (overlay) {
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
  }

  scheduleTradeBlockEndTimer();
  syncTradeButtons();
  renderLifeStatus();
  renderAssetSummary();
  schedulePersistUser();

  const okBtn = document.getElementById("collapseModalOk");
  if (okBtn) {
    requestAnimationFrame(() => okBtn.focus());
  }
}

function hideCollapseModal() {
  const overlay = document.getElementById("collapseModal");
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
  }
}

function showLifeEventModal(ev) {
  pendingLifeEventApply = ev;
  const body = document.getElementById("lifeEventModalBody");
  const overlay = document.getElementById("lifeEventModal");
  if (body) body.textContent = ev.body;
  if (overlay) overlay.hidden = false;
}

function hideLifeEventModal() {
  const overlay = document.getElementById("lifeEventModal");
  if (overlay) overlay.hidden = true;
  pendingLifeEventApply = null;
}

function finishOpenNextTradingDay() {
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
    `장 개장 — ${month}월 ${day}일 09:00 (10분봉, 현실 10초마다 확정)`,
    "news"
  );

  if (!onlineMode) {
    onSessionSecondTick();
    startGameClockTimer();
    scheduleAmbientNewsTimer();
  }

  schedulePersistUser();
  syncNextTurnButton();
}

function scheduleNextLifeEventDay() {
  lifeNextEventDayIndex = gameDayIndex + 2 + Math.floor(Math.random() * 4);
}

function clearActiveJobTimers() {
  if (activeJobTimerId) clearTimeout(activeJobTimerId);
  activeJobTimerId = null;
  if (hofGuestLoopId) clearTimeout(hofGuestLoopId);
  hofGuestLoopId = null;
  if (kidStressLoopId) clearTimeout(kidStressLoopId);
  kidStressLoopId = null;
  hofGuestCallUntil = 0;
  const coup = document.getElementById("jobCoupangOverlay");
  if (coup) coup.hidden = true;
  const hof = document.getElementById("hofGuestOverlay");
  if (hof) hof.hidden = true;
}

/** 과로·응급: 알바 타이머·오버레이 제거(보상 없음) — 모달이 다른 레이어에 가리지 않도록 */
function abortActiveJobForEmergency() {
  clearActiveJobTimers();
  activeJobId = null;
  activeJobUntil = 0;
  syncTradeButtons();
  syncPartTimeButtons();
}

function finishActiveJob() {
  const key = activeJobId;
  const job = key ? PART_TIME_JOBS[key] : null;
  clearActiveJobTimers();
  activeJobId = null;
  activeJobUntil = 0;
  if (!job) {
    syncTradeButtons();
    syncPartTimeButtons();
    return;
  }
  lifeHp = Math.max(0, lifeHp - job.hpCost);
  lifeStress = Math.min(LIFE_STRESS_MAX, lifeStress + job.stressAdd);
  game.cash += job.pay;
  clampLifeHpStress();
  setMessage(`${job.label} 퇴근 · ${formatWon(job.pay)} 입금`, "ok");
  renderLifeStatus();
  renderAssetSummary();
  checkLifeCritical();
  schedulePersistUser();
  syncTradeButtons();
  syncPartTimeButtons();
}

function scheduleHofGuestCallLoop() {
  if (hofGuestLoopId) clearTimeout(hofGuestLoopId);
  if (activeJobId !== "hof" || Date.now() >= activeJobUntil) return;
  const delay = 2500 + Math.random() * 5500;
  hofGuestLoopId = setTimeout(() => {
    if (activeJobId !== "hof" || Date.now() >= activeJobUntil) return;
    const blockMs = 2000 + Math.floor(Math.random() * 1000);
    hofGuestCallUntil = Date.now() + blockMs;
    const ov = document.getElementById("hofGuestOverlay");
    if (ov) ov.hidden = false;
    syncTradeButtons();
    setTimeout(() => {
      hofGuestCallUntil = 0;
      if (ov) ov.hidden = true;
      syncTradeButtons();
      if (activeJobId === "hof" && Date.now() < activeJobUntil) {
        scheduleHofGuestCallLoop();
      }
    }, blockMs);
  }, delay);
}

function scheduleKidsCafeStressLoop() {
  if (kidStressLoopId) clearTimeout(kidStressLoopId);
  if (activeJobId !== "kidscafe" || Date.now() >= activeJobUntil) return;
  const delay = 4000 + Math.random() * 9000;
  kidStressLoopId = setTimeout(() => {
    if (activeJobId !== "kidscafe" || Date.now() >= activeJobUntil) return;
    lifeStress = Math.min(
      LIFE_STRESS_MAX,
      lifeStress + 12 + Math.floor(Math.random() * 11)
    );
    renderLifeStatus();
    setMessage("아이가 울음을 터뜨렸습니다!", "err");
    addNewsItem("키즈카페 · 돌발 상황에 정신이 팔렸습니다.", "life");
    checkLifeCritical();
    scheduleKidsCafeStressLoop();
  }, delay);
}

function startPartTimeJob(key) {
  const job = PART_TIME_JOBS[key];
  if (!job) return;
  if (isJobBusyNow()) {
    setMessage("이미 알바 중입니다.", "err");
    return;
  }
  clampLifeHpStress();
  if (lifeHp < job.hpCost) {
    setMessage("체력이 부족합니다.", "err");
    return;
  }
  activeJobId = key;
  activeJobUntil = Date.now() + JOB_DURATION_MS;
  syncPartTimeButtons();
  syncTradeButtons();
  if (key === "coupang") {
    const el = document.getElementById("jobCoupangOverlay");
    if (el) el.hidden = false;
  }
  if (key === "hof") scheduleHofGuestCallLoop();
  if (key === "kidscafe") scheduleKidsCafeStressLoop();
  activeJobTimerId = setTimeout(finishActiveJob, JOB_DURATION_MS);
  setMessage(`${job.label} 출근 · ${JOB_DURATION_MS / 1000}초`, "ok");
}

function bindLifeUi() {
  const okLife = document.getElementById("lifeEventModalOk");
  if (okLife) {
    okLife.addEventListener("click", () => {
      if (pendingLifeEventApply && typeof pendingLifeEventApply.apply === "function") {
        pendingLifeEventApply.apply();
      }
      hideLifeEventModal();
      renderLifeStatus();
      renderAssetSummary();
      const runFinish = pendingFinishOpenTradingDay;
      if (pendingFinishOpenTradingDay) pendingFinishOpenTradingDay = false;
      if (runFinish) {
        scheduleNextLifeEventDay();
        if (!onlineMode) finishOpenNextTradingDay();
        else schedulePersistUser();
      }
      checkLifeCritical();
      schedulePersistUser();
    });
  }
  const okCol = document.getElementById("collapseModalOk");
  if (okCol && okCol.dataset.bound !== "1") {
    okCol.dataset.bound = "1";
    okCol.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideCollapseModal();
    });
  }

  document.querySelectorAll(".parttime-btn[data-parttime]").forEach((btn) => {
    btn.addEventListener("click", () => {
      startPartTimeJob(btn.getAttribute("data-parttime"));
    });
  });
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
      hp: LIFE_HP_MAX,
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
    hp: LIFE_HP_MAX,
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
  lifeHp = Math.max(0, Math.min(LIFE_HP_MAX, row.hp ?? LIFE_HP_MAX));
  lifeStress = Math.max(0, Math.min(LIFE_STRESS_MAX, row.stress ?? 0));
  tradeBlockedUntil = Number(row.trade_blocked_until_ms) || 0;

  const prof = row.profile && typeof row.profile === "object" ? row.profile : {};
  playerProfile.name = typeof prof.name === "string" ? prof.name : nm;
  playerProfile.age = typeof prof.age === "number" ? prof.age : 20;
  playerProfile.birthday = typeof prof.birthday === "string" ? prof.birthday : "";
  playerProfile.setupComplete = !!prof.setupComplete;
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
  renderPlayerLoginBadge();
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

function renderNewsFeedFromServer(items) {
  const list = document.getElementById("newsFeed");
  if (!list || !Array.isArray(items)) return;
  list.innerHTML = "";
  items.slice(0, MAX_NEWS_ITEMS).forEach((it) => {
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
    textEl.className = "news-text";
    textEl.textContent = it.text || "";
    li.appendChild(timeEl);
    li.appendChild(textEl);
    list.appendChild(li);
  });
}

function applyServerMarketState(m) {
  if (!m || m.initialized === false) return;
  const prev = lastMarketSnapshotForDividend;
  maybePayDividendFromServerTick(prev, m);
  lastMarketSnapshotForDividend = JSON.parse(JSON.stringify(m));

  gameDayIndex = m.gameDayIndex ?? 0;
  gameMinutes = m.gameMinutes ?? MARKET_OPEN_MIN;
  isMarketClosed = !!m.isMarketClosed;
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

  renderNewsFeedFromServer(m.newsFeed || []);
}

async function fetchMarketOnce() {
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

function subscribeMarketRealtime() {
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
        const st = payload.new?.state;
        if (st) applyServerMarketState(st);
        renderDateTimeLine();
        refreshDetailChart();
        renderStockListMain();
        updateDetailPriceLine();
        renderAssetSummary();
        syncNextTurnButton();
      }
    )
    .subscribe();
}

async function persistUserNow() {
  if (!onlineMode || !sb || !loginDisplayName) return;
  await sb
    .from(TBL_USERS)
    .update({
      cash: Math.round(game.cash),
      hp: lifeHp,
      stress: lifeStress,
      sim_age: game.age,
      trade_blocked_until_ms: Math.round(tradeBlockedUntil),
      initial_capital: game.initialCapital,
      profile: {
        name: playerProfile.name,
        age: playerProfile.age,
        birthday: playerProfile.birthday,
        setupComplete: playerProfile.setupComplete,
        watchlist: watchlistIds,
        nextLifeEventDayIndex: lifeNextEventDayIndex,
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

function isTradingSession() {
  return (
    !isMarketClosed &&
    !isPaused &&
    gameMinutes >= MARKET_OPEN_MIN &&
    gameMinutes < MARKET_CLOSE_MIN
  );
}

/** 다음 턴(1년)은 일일 장 마감 후에만 가능 — 장중·장전 클릭 방지 */
function syncNextTurnButton() {
  const btn = document.getElementById("btnNextTurn");
  if (!btn) return;
  const canAdvance = isMarketClosed;
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
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  if (isTradeBlocked()) {
    return {
      ok: false,
      reason: "과로로 인해 매매가 일시 중지되었습니다. 잠시 후 다시 시도하세요.",
    };
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
  addStressFromTrade();
  schedulePersistUser();
  return { ok: true };
}

async function sellStock(stockId, quantity) {
  if (!onlineMode || !sb || !loginDisplayName) {
    return { ok: false, reason: "Supabase 연결이 필요합니다. config.js를 확인하세요." };
  }
  if (isTradeBlocked()) {
    return {
      ok: false,
      reason: "과로로 인해 매매가 일시 중지되었습니다. 잠시 후 다시 시도하세요.",
    };
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
  addStressFromTrade();
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
    !isMarketClosed &&
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
    !isMarketClosed &&
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
    if (!isPaused && !isMarketClosed && isTradingSession()) {
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

function showCharacterSetupModal() {
  const m = document.getElementById("characterSetupModal");
  const nameEl = document.getElementById("setupPlayerName");
  const ageEl = document.getElementById("setupPlayerAge");
  const birthEl = document.getElementById("setupPlayerBirth");
  if (nameEl) nameEl.value = playerProfile.name || "";
  if (ageEl) ageEl.value = String(playerProfile.age ?? 20);
  if (birthEl) birthEl.value = playerProfile.birthday || "";
  if (m) m.hidden = false;
}

function hideCharacterSetupModal() {
  const m = document.getElementById("characterSetupModal");
  if (m) m.hidden = true;
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
    hideCharacterSetupModal();
    renderProfileDisplay();
    schedulePersistUser();
    startGameClockFromInit(false);
  });
}

function startGameClockFromInit(loaded) {
  if (gameClockEverStarted) return;
  gameClockEverStarted = true;

  if (onlineMode) {
    clearGameClockTimer();
    clearAmbientNewsTimer();
  } else if (!loaded) {
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

  if (phoneClockIntervalId) clearInterval(phoneClockIntervalId);
  updatePhoneShellClock();
  phoneClockIntervalId = setInterval(updatePhoneShellClock, 15000);

  const pb = document.getElementById("btnPause");
  if (pb) {
    if (isMarketClosed) {
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
  if (tradeBlockedUntil > Date.now()) scheduleTradeBlockEndTimer();
  syncTradeButtons();
  if (!loaded) schedulePersistUser();
  else flushPersistUser();
  syncNextTurnButton();
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
    if (isTradeBlocked()) {
      setMessage(
        "과로로 인해 매매가 일시 중지되었습니다. 잠시 후 다시 시도하세요.",
        "err"
      );
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
  if (onlineMode) return;
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

  schedulePersistUser();

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

  if (gameDayIndex >= lifeNextEventDayIndex) {
    const ev =
      LIFE_RANDOM_EVENTS[Math.floor(Math.random() * LIFE_RANDOM_EVENTS.length)];
    pendingFinishOpenTradingDay = true;
    showLifeEventModal(ev);
    schedulePersistUser();
    return;
  }

  finishOpenNextTradingDay();
}

function closeMarket() {
  if (onlineMode) return;
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

  flushPersistUser();
  scheduleNextTradingDay();
  syncNextTurnButton();
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
  if (onlineMode) {
    setMessage("온라인 모드에서는 공용 시장 시계를 멈출 수 없습니다.", "err");
    return;
  }
  if (isMarketClosed) return;
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
      if (isTradeBlocked()) {
        setMessage(
          "과로로 인해 매매가 일시 중지되었습니다. 잠시 후 다시 시도하세요.",
          "err"
        );
        return;
      }
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
  if (!isMarketClosed) {
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
  isMarketClosed = false;
  isPaused = false;
  scheduledEvents = buildInitialCalendar();
  ensureCalendarHorizon();

  game.age = 25;
  game.cash = INITIAL_CAPITAL;
  game.holdings = {};
  game.costBasis = {};
  game.initialCapital = INITIAL_CAPITAL;

  lifeHp = LIFE_HP_MAX;
  lifeStress = 0;
  tradeBlockedUntil = 0;
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

  bindLifeUi();
  bindCharacterSetup();
  document.getElementById("btnNextTurn").addEventListener("click", onNextTurn);
  const btnReset = document.getElementById("btnResetData");
  if (btnReset) btnReset.addEventListener("click", () => resetAllLocalDataAndReload());

  bindDetailTrade();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistUser();
  });
  window.addEventListener("beforeunload", flushPersistUser);

  if (!playerProfile.setupComplete) {
    showCharacterSetupModal();
    if (pauseBtn) pauseBtn.disabled = true;
    renderAssetSummary();
    renderLifeStatus();
    renderStocks();
    syncTradeButtons();
    syncNextTurnButton();
    return;
  }

  startGameClockFromInit(false);
}

async function init() {
  const booted = await bootstrapSupabase();
  if (!booted) {
    setMessage(
      "config.js에 supabaseUrl·supabaseAnonKey를 넣고 새로고침하세요. (config.example.js 참고)",
      "err"
    );
    return;
  }

  const mainApp = document.getElementById("mainApp");
  const loginGate = document.getElementById("loginGate");

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

  if (restorePlayerNameFromSession()) {
    if (loginGate) loginGate.hidden = true;
    if (mainApp) mainApp.hidden = false;
    await runGameBootstrap();
    return;
  }

  if (mainApp) mainApp.hidden = true;
  if (loginGate) loginGate.hidden = false;
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
    if (loginGate) loginGate.hidden = true;
    if (mainApp) mainApp.hidden = false;
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
