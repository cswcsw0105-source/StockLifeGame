/**
 * Stock Life Game — 핵심 상태와 주식 매수/매도 기초 로직
 */

const game = {
  age: 25,
  cash: 10_000_000,
  /** 종목 코드 → 보유 주 수 */
  holdings: {},
};

const stocks = [
  { id: "AAA", name: "알파 테크", price: 50_000 },
  { id: "BBB", name: "베타 바이오", price: 32_000 },
  { id: "CCC", name: "감마 에너지", price: 18_000 },
];

function initHoldings() {
  stocks.forEach((s) => {
    if (game.holdings[s.id] === undefined) game.holdings[s.id] = 0;
  });
}

function formatWon(n) {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}

function getStockById(id) {
  return stocks.find((s) => s.id === id);
}

/**
 * 보유 주식 평가액 (현재가 기준)
 */
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

/**
 * 매수: 현금에서 (가격 × 수량) 차감, holdings 증가
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
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

  game.cash -= cost;
  game.holdings[stockId] = (game.holdings[stockId] ?? 0) + q;
  return { ok: true };
}

/**
 * 매도: holdings에서 차감, 현금 증가
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
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

  game.holdings[stockId] = owned - q;
  game.cash += stock.price * q;
  return { ok: true };
}

/**
 * 턴 진행 시 호출할 가격 변동 (기초: ±범위 내 랜덤)
 */
function tickStockPrices() {
  stocks.forEach((s) => {
    const drift = 0.92 + Math.random() * 0.16;
    s.price = Math.max(1_000, Math.round(s.price * drift));
  });
}

function setMessage(text, type = "") {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = "message" + (type ? ` ${type}` : "");
}

function renderLife() {
  document.getElementById("age").textContent = String(game.age);
  document.getElementById("cash").textContent = formatWon(game.cash);
  document.getElementById("netWorth").textContent = formatWon(netWorth());
}

function renderStocks() {
  const tbody = document.getElementById("stockRows");
  tbody.innerHTML = "";

  stocks.forEach((s) => {
    const tr = document.createElement("tr");
    const owned = game.holdings[s.id] ?? 0;
    tr.innerHTML = `
      <td>
        <span class="stock-name">${escapeHtml(s.name)}</span>
        <span class="stock-ticker">${escapeHtml(s.id)}</span>
      </td>
      <td>${formatWon(s.price)}</td>
      <td>${owned.toLocaleString("ko-KR")}주</td>
      <td>
        <input type="number" class="qty-input" min="1" value="1" data-stock="${escapeHtml(s.id)}" aria-label="${escapeHtml(s.name)} 수량" />
      </td>
      <td class="cell-actions">
        <button type="button" class="btn buy" data-action="buy" data-stock="${escapeHtml(s.id)}">매수</button>
        <button type="button" class="btn sell" data-action="sell" data-stock="${escapeHtml(s.id)}">매도</button>
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
        renderLife();
        renderStocks();
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

function onNextTurn() {
  game.age += 1;
  tickStockPrices();
  setMessage(`${game.age}세가 되었습니다. 시장 가격이 변동했습니다.`);
  renderLife();
  renderStocks();
}

function init() {
  initHoldings();
  renderLife();
  renderStocks();
  document.getElementById("btnNextTurn").addEventListener("click", onNextTurn);
}

document.addEventListener("DOMContentLoaded", init);
