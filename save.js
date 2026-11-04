import {create, advance, firms, divisions, playerTrade, finishEarly} from "./engine.js";

const key = "stocklife_season_v4";
const legacyKey = "stocklife_season_v3";

export function orderToken(order) {
  const index = firms.findIndex(([code])=>code===order.code);
  return (order.side==="buy"?"b":"s")+index+order.qty.toString(36);
}

function decodeOrder(token) {
  if(!/^[bs][0-7][0-9a-z]{1,10}$/.test(token)) throw Error("저장된 주문 형식 오류");
  return {side:token[0]==="b"?"buy":"sell",code:firms[Number(token[1])][0],qty:parseInt(token.slice(2),36)};
}

export function encodeSeason(seed, division, actions) {
  return [seed.toString(36),division,...actions].join(".");
}

export function decodeSeason(value,legacy=false) {
  if(!value) throw Error("저장된 시즌 형식 오류");
  const [seedText,divisionText,...tokens]=value.split(".");
  if(!/^[0-9a-z]{1,7}$/.test(seedText) || !/^[0-2]$/.test(divisionText))
    throw Error("저장된 시즌 형식 오류");
  const seed=parseInt(seedText,36), division=Number(divisionText);
  if(seed>0xffffffff || !divisions[division]) throw Error("저장된 시즌 형식 오류");
  const actions=legacy?tokens.map(token=>"l"+token):tokens;
  let state=create(division,seed);
  for(const token of actions) {
    if(token==="h") state=advance(state);
    else if(token==="e") finishEarly(state);
    else if(token[0]==="l") state=advance(state,token==="lh"?null:decodeOrder(token.slice(1)),true);
    else playerTrade(state,decodeOrder(token));
  }
  return {seed,actions,state};
}

function cookieValue(name) {
  return document.cookie.split("; ").find(value=>value.startsWith(name+"="))?.slice(name.length+1);
}

export function loadSeason() {
  const stored=cookieValue(key);
  if(stored==="~") return decodeSeason(localStorage.getItem(key));
  if(stored) return decodeSeason(stored);
  const old=cookieValue(legacyKey);
  return old?decodeSeason(old,true):null;
}

export function saveSeason(seed,division,actions) {
  const stored=encodeSeason(seed,division,actions);
  const overflow=stored.length>3500;
  if(overflow) localStorage.setItem(key,stored);
  const cookie=overflow?"~":stored;
  document.cookie=key+"="+cookie+"; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
  return cookieValue(key)===cookie;
}
