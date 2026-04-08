const DEFAULT_KEYWORD_POOLS = {
  JBD: ["그림판 AI", "네온 간판", "외계인 패턴", "3D 로고 빔프로젝터"],
  SYW: ["자율주행 드론", "전동 킥보드", "제트팩", "하늘 배달 캐리어"],
  MJS: ["힐링티", "시니어 케어봇", "수면 캡슐", "VIP 라운지 키트"],
  BSL: ["탈모약", "수면 앰플", "형광 립스틱", "초고농축 세럼"],
  SYG: ["초정밀 톱니바퀴", "방탄 강철", "로봇 팔", "자기부상 베어링"],
  JWF: ["VIP 펀드", "사주팔자", "비트코인", "초고위험 파생옵션"],
  YHL: ["명품 정장", "시스루 빤스", "방한복", "초경량 런웨이 수트"],
  SWB: ["B2B 메신저", "업무 자동화 봇", "퇴근 가속 버튼", "클라우드 결재 엔진"],
};

const COMBO_TEMPLATES = [
  {
    id: "launch-crash-rebound",
    steps: [
      {
        feedType: "chain",
        tone: "good",
        text: "🚨 [단독] {CompanyA} x {CompanyB} 미친 콜라보! '{KeywordA}' 기능 탑재한 '{KeywordB}' 전격 출시!",
        impactMode: "both-up-strong",
      },
      {
        feedType: "chain",
        tone: "bad",
        text: "📉 [충격] 신제품 오작동 대참사... {CompanyA} 대표, {CompanyB} 본사 찾아가 멱살잡이",
        impactMode: "both-down-crash",
      },
    ],
  },
  {
    id: "acquire-vanish",
    steps: [
      {
        feedType: "chain",
        tone: "good",
        text: "🚨 [속보] {CompanyA}, {CompanyB}의 핵심 기술 '{KeywordB}' 전격 인수! 업계 지각변동",
        impactMode: "a-strong-b-mild-up",
      },
      {
        feedType: "chain",
        tone: "bad",
        text: "📉 [단독] 인수한 기술 알고보니 유튜브 보고 베낀 것... 두 대표 동반 잠적",
        impactMode: "both-down-heavy",
      },
    ],
  },
  {
    id: "festival-lawsuit",
    steps: [
      {
        feedType: "chain",
        tone: "good",
        text: "🚨 [특종] {CompanyA}와 {CompanyB}, '{KeywordA}' x '{KeywordB}' 페스티벌 개최! 예약 폭주",
        impactMode: "both-up-mid",
      },
      {
        feedType: "chain",
        tone: "bad",
        text: "📉 [긴급] 페스티벌 후기 조작 의혹... {CompanyA}·{CompanyB} 집단 소송",
        impactMode: "both-down-heavy",
      },
    ],
  },
];

const SINGLE_RUMOR_TEMPLATES = [
  {
    text: "🧪 [B급 루머] {CompanyA}, '{KeywordA}' 기술이 사실은 중고장터 재조립품 논란",
    tone: "bad",
    min: 0.18,
    max: 0.32,
  },
  {
    text: "🧪 [B급 루머] {CompanyA}, '{KeywordA}'가 해외 밈 커뮤니티에서 신의 기술로 등극",
    tone: "good",
    min: 0.22,
    max: 0.42,
  },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPct(min, max, sign = 1) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return sign * (lo + Math.random() * (hi - lo));
}

function renderTemplate(str, vars) {
  return str
    .replaceAll("{CompanyA}", vars.companyA)
    .replaceAll("{CompanyB}", vars.companyB)
    .replaceAll("{KeywordA}", vars.keywordA)
    .replaceAll("{KeywordB}", vars.keywordB)
    .replaceAll("{Singer}", vars.singer || "초특급 스타");
}

function buildImpacts(mode, aId, bId) {
  switch (mode) {
    case "both-up-strong":
      return {
        [aId]: randomPct(0.2, 0.3, 1),
        [bId]: randomPct(0.2, 0.3, 1),
      };
    case "both-up-mid":
      return {
        [aId]: randomPct(0.15, 0.24, 1),
        [bId]: randomPct(0.15, 0.24, 1),
      };
    case "a-strong-b-mild-up":
      return {
        [aId]: randomPct(0.25, 0.34, 1),
        [bId]: randomPct(0.1, 0.19, 1),
      };
    case "both-down-crash":
      return {
        [aId]: randomPct(0.3, 0.4, -1),
        [bId]: randomPct(0.3, 0.4, -1),
      };
    case "both-down-heavy":
      return {
        [aId]: randomPct(0.26, 0.38, -1),
        [bId]: randomPct(0.26, 0.38, -1),
      };
    case "both-up-jackpot":
      return {
        [aId]: randomPct(1.0, 1.5, 1),
        [bId]: randomPct(1.0, 1.5, 1),
      };
    default:
      return {
        [aId]: randomPct(0.12, 0.2, 1),
        [bId]: randomPct(0.12, 0.2, 1),
      };
  }
}

export const DEFAULT_SPECIAL_EVENT_CONFIG = {
  keywordPools: DEFAULT_KEYWORD_POOLS,
  comboTemplates: COMBO_TEMPLATES,
  rumorTemplates: SINGLE_RUMOR_TEMPLATES,
  triggerChancePerCall: 0.2,
  comboChance: 0.68,
  jackpotWaveChance: 0.28,
  jackpotSingers: [
    "지디",
    "아이유",
    "뉴진스 민지",
    "에스파 카리나",
    "임영웅",
  ],
};

export function createSpecialEventsGenerator(config = DEFAULT_SPECIAL_EVENT_CONFIG) {
  const state = {
    activeCombo: null,
  };

  function resetDay() {
    state.activeCombo = null;
  }

  function nextEvent({ stocks }) {
    if (!Array.isArray(stocks) || stocks.length === 0) return null;
    if (Math.random() > (config.triggerChancePerCall ?? 0.2)) return null;

    const byId = new Map(stocks.map((s) => [s.id, s]));
    const idsWithPool = stocks
      .map((s) => s.id)
      .filter((id) => Array.isArray(config.keywordPools[id]) && config.keywordPools[id].length > 0);
    if (idsWithPool.length === 0) return null;

    if (state.activeCombo) {
      const combo = state.activeCombo;
      if (!byId.has(combo.aId) || !byId.has(combo.bId)) {
        state.activeCombo = null;
      } else {
        const nextStep = combo.template.steps[combo.stepIdx];
        if (nextStep) {
          const headline = renderTemplate(nextStep.text, combo.vars);
          const impacts = buildImpacts(nextStep.impactMode, combo.aId, combo.bId);
          combo.stepIdx += 1;
          if (combo.stepIdx >= combo.template.steps.length) state.activeCombo = null;
          return {
            headline,
            impacts,
            primaryStockId: combo.aId,
            feedType: nextStep.feedType || "chain",
            isRumor: false,
            bias: {
              [combo.aId]: impacts[combo.aId] >= 0 ? 0.01 : -0.01,
              [combo.bId]: impacts[combo.bId] >= 0 ? 0.01 : -0.01,
            },
            volFactor: 1.6,
          };
        }
        state.activeCombo = null;
      }
    }

    const wantCombo = Math.random() < (config.comboChance ?? 0.68);
    if (wantCombo && idsWithPool.length >= 2) {
      const shuffled = idsWithPool.slice().sort(() => Math.random() - 0.5);
      const aId = shuffled[0];
      const bId = shuffled[1];
      const a = byId.get(aId);
      const b = byId.get(bId);
      const keywordA = pick(config.keywordPools[aId]);
      const keywordB = pick(config.keywordPools[bId]);
      const template = pick(config.comboTemplates);
      const vars = {
        companyA: a?.name || aId,
        companyB: b?.name || bId,
        keywordA,
        keywordB,
        singer: pick(config.jackpotSingers || ["월드스타"]),
      };
      const templateSteps = template.steps.map((s) => ({ ...s }));
      if (
        templateSteps.length >= 2 &&
        (templateSteps[1].impactMode || "").startsWith("both-down") &&
        Math.random() < (config.jackpotWaveChance ?? 0.28)
      ) {
        templateSteps[1] = {
          ...templateSteps[1],
          tone: "good",
          text: "🔥 [특보] {CompanyA} x {CompanyB} 제품, 빌보드 스타 {Singer}가 착용하며 전 세계 품절 대란! 물 들어올 때 노 젓는다!",
          impactMode: "both-up-jackpot",
        };
      }
      const templateResolved = { ...template, steps: templateSteps };
      state.activeCombo = { aId, bId, vars, template: templateResolved, stepIdx: 1 };
      const first = templateResolved.steps[0];
      return {
        headline: renderTemplate(first.text, vars),
        impacts: buildImpacts(first.impactMode, aId, bId),
        primaryStockId: aId,
        feedType: first.feedType || "chain",
        isRumor: false,
        bias: {},
        volFactor: 1.55,
      };
    }

    const rumor = pick(config.rumorTemplates);
    const aId = pick(idsWithPool);
    const a = byId.get(aId);
    const keywordA = pick(config.keywordPools[aId]);
    const headline = renderTemplate(rumor.text, {
      companyA: a?.name || aId,
      companyB: "",
      keywordA,
      keywordB: "",
    });
    const sign = rumor.tone === "good" ? 1 : -1;
    const pct = randomPct(rumor.min ?? 0.15, rumor.max ?? 0.3, sign);
    return {
      headline,
      impacts: { [aId]: pct },
      primaryStockId: aId,
      feedType: "ambient",
      isRumor: true,
      bias: { [aId]: pct >= 0 ? 0.01 : -0.01 },
      volFactor: 1.5,
    };
  }

  return { nextEvent, resetDay };
}
