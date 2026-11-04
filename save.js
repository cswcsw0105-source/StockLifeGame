import {create, advance, firms, divisions, playerTrade, finishEarly, upgradeNews, updateRoster, roster} from "./engine.js";

const key = "stocklife_season_v6";
const formerKey = "stocklife_season_v5";
const previousKey = "stocklife_season_v4";
const legacyKey = "stocklife_season_v3";

export function orderToken(order) {
  const index = firms.findIndex(([code])=>code===order.code);
  return (order.side==="buy"?"b":"s")+index+order.qty.toString(36);
}

function decodeOrder(token,state) {
  if(!/^[bs][0-7][0-9a-z]{1,10}$/.test(token)) throw Error("저장된 주문 형식 오류");
  const firm=roster(state)[Number(token[1])];
  if(!firm) throw Error("저장된 종목 코드 오류");
  return {side:token[0]==="b"?"buy":"sell",code:firm[0],qty:parseInt(token.slice(2),36)};
}

export function encodeSeason(seed, division, actions) {
  return [seed.toString(36),division,...actions].join(".");
}

export function decodeSeason(value,version=6) {
  if(!value) throw Error("저장된 시즌 형식 오류");
  const [seedText,divisionText,...tokens]=value.split(".");
  if(!/^[0-9a-z]{1,7}$/.test(seedText) || !/^[0-2]$/.test(divisionText))
    throw Error("저장된 시즌 형식 오류");
  const seed=parseInt(seedText,36), division=Number(divisionText);
  if(seed>0xffffffff || !divisions[division]) throw Error("저장된 시즌 형식 오류");
  const actions=version===3?tokens.map(token=>"l"+token):tokens;
  const offset=actions[0]==="r"?1:0;
  const config=actions[offset];
  const older=version<5 || config==="v";
  const hasDifficulty=/^d[012]$/.test(config??"");
  const difficulty=hasDifficulty?Number(config[1]):1;
  let state=create(division,seed,!older,difficulty,version<6 || offset===1);
  for(const token of actions.slice(offset+(config==="v" || hasDifficulty?1:0))) {
    if(token==="h") state=advance(state);
    else if(token==="e") finishEarly(state);
    else if(token==="n") upgradeNews(state);
    else if(token==="m") updateRoster(state);
    else if(token[0]==="l") state=advance(state,token==="lh"?null:decodeOrder(token.slice(1),state),true);
    else playerTrade(state,decodeOrder(token,state));
  }
  if(version<5) {
    actions.unshift("v");
    if(state.winner===null) {
      actions.push("n");
      upgradeNews(state);
    }
  }
  if(version<6) {
    actions.unshift("r");
    actions.push("m");
    updateRoster(state);
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
  const former=cookieValue(formerKey);
  if(former) return decodeSeason(former==="~"?localStorage.getItem(formerKey):former,5);
  const previous=cookieValue(previousKey);
  if(previous) return decodeSeason(previous==="~"?localStorage.getItem(previousKey):previous,4);
  const old=cookieValue(legacyKey);
  return old?decodeSeason(old,3):null;
}

export function saveSeason(seed,division,actions) {
  const stored=encodeSeason(seed,division,actions);
  const overflow=stored.length>3500;
  if(overflow) localStorage.setItem(key,stored);
  const cookie=overflow?"~":stored;
  document.cookie=key+"="+cookie+"; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
  return cookieValue(key)===cookie;
}
