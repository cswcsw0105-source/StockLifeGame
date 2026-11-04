import {create, advance, firms, divisions} from "./engine.js";

const key = "stocklife_season_v2";
const maxTurns = 105;

export function encodeSeason(seed, division, actions) {
  return [seed.toString(36), division, ...actions.map(order => {
    if (!order) return "h";
    const i = firms.findIndex(([code]) => code === order.code);
    return (order.side === "buy" ? "b" : "s") + i + order.qty.toString(36);
  })].join(".");
}

export function decodeSeason(value) {
  if (!value || value.length > 3500) throw Error("저장된 시즌 형식 오류");
  const [seedText, divisionText, ...tokens] = value.split(".");
  if (!/^[0-9a-z]{1,7}$/.test(seedText) || !/^[0-2]$/.test(divisionText) || tokens.length > maxTurns)
    throw Error("저장된 시즌 형식 오류");
  const seed = parseInt(seedText,36), division = Number(divisionText);
  if (seed > 0xffffffff || !divisions[division]) throw Error("저장된 시즌 형식 오류");
  const actions = tokens.map(token => {
    if (token === "h") return null;
    if (!/^[bs][0-9][0-9a-z]{1,10}$/.test(token)) throw Error("저장된 주문 형식 오류");
    return {side: token[0] === "b" ? "buy" : "sell", code: firms[Number(token[1])][0], qty:parseInt(token.slice(2),36)};
  });
  return {seed, actions, state:actions.reduce(advance,create(division,seed))};
}

function cookieValue() {
  return document.cookie.split("; ").find(value=>value.startsWith(key+"="))?.slice(key.length+1);
}
export function loadSeason() {
  const stored = cookieValue();
  return stored ? decodeSeason(stored) : null;
}
export function saveSeason(seed, division, actions) {
  const stored = encodeSeason(seed,division,actions);
  document.cookie = key+"="+stored+"; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
  return cookieValue() === stored;
}
