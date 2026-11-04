export const capital = 1_000_000;
import {firms,stories,marketBriefs} from "./content.js";
export {firms};
export const rivals = [
  ["헤드라인", "뉴스 추종"], ["스프린트", "추세 추종"], ["리바운드", "낙폭 반등"],
  ["리밸런서", "분산 배분"], ["퀵컷", "빠른 손절"], ["딥밸류", "저평가 매집"], ["파이널랩", "순위 따라 베팅"],
];
export const divisions = ["루키", "챌린저", "프리미어"];
export const phases = ["개장", "오전", "오후"];
export const grade = {2:"강한 호재",1:"호재",[-1]:"악재",[-2]:"강한 악재"};
const money = n => Math.round(n);
const names = ["나", ...rivals.map(r => r[0])];
const createPlayer = (name, id) => ({name, id, cash:capital, holdings:{}, active:true, exit:null});
function random(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}
function drawSymbols(state) {
  const pool = firms.map(([code]) => code);
  return Array.from({length:3}, () => pool.splice(Math.floor(random(state)*pool.length), 1)[0]);
}
function legacyNews(state) {
  const eligible = stories.filter(([,title]) => title !== state.news?.title);
  const [code, title, impact] = eligible[Math.floor(random(state)*eligible.length)];
  return {code, title, impact, expected: random(state) < .35};
}
function news(state) {
  if (!state.newsRules) return legacyNews(state);
  const previous = state.news?.article;
  const assigned = state.players[0].symbols;
  const relevant = marketBriefs.flatMap((brief,index)=>
    brief[2].some(([code])=>assigned.includes(code)) ? [index] : []);
  let candidates = relevant.filter(index=>!state.seenBriefs.includes(index));
  if (!candidates.length) {
    state.seenBriefs = [];
    candidates = relevant.filter(index=>index!==previous);
  }
  const article = candidates[Math.floor(random(state)*candidates.length)];
  state.seenBriefs.push(article);
  const [title, body, outcomes] = marketBriefs[article];
  const names = new Map(firms.map(([code,name])=>[code,name]));
  const expand = text=>text.replace(/\{([A-Z]+)\}/g, (_,code)=>names.get(code)??code);
  return {article, title:expand(title), body:expand(body), outcomes};
}
export function upgradeNews(state) {
  if (state.winner!==null || state.newsRules) return;
  state.newsRules=2;
  state.seenBriefs=[];
  state.news=news(state);
}
export function create(division=0, seed=Date.now()>>>0, withBriefs=true, difficulty=1) {
  const state = {version:1, division, seed, turn:0, winner:null, players:[],
    market:Object.fromEntries(firms.map(([code,,,price])=>[code,{price, bars:[], drift:0}])),
    trades:[], closing:[], news:null};
  state.players=names.map((name,id)=>({...createPlayer(name,id), symbols:drawSymbols(state)}));
  if(difficulty!==1) state.difficulty=difficulty;
  if(withBriefs) upgradeNews(state);
  else state.news=legacyNews(state);
  return state;
}
export const value = (p,s) => p.cash + Object.entries(p.holdings).reduce((a,[code,h])=>a+h.qty*s.market[code].price,0);
export const ranking = s => s.players.filter(p=>p.active).sort((a,b)=>value(b,s)-value(a,s) || a.id-b.id);
export function trade(s,p,order,legacyFees=false) {
  if (!order || !p.active) return null;
  const {code,side,qty}=order, price=s.market[code]?.price;
  if (!p.symbols.includes(code)) throw Error("배정받은 종목만 거래할 수 있습니다.");
  if (!price || !Number.isSafeInteger(qty) || qty<1 || !["buy","sell"].includes(side)) throw Error("주문 수량을 확인하세요.");
  const h=p.holdings[code] || {qty:0,basis:0};
  const gross=price*qty, fee=legacyFees?Math.ceil(gross*.0025):0;
  if (side==="buy") {
    if(gross+fee>p.cash) throw Error("주문 금액이 예수금을 초과합니다.");
    p.cash-=gross+fee; h.qty+=qty; h.basis+=gross+fee;
  } else {
    if(qty>h.qty) throw Error("보유 수량을 초과합니다.");
    h.basis=h.qty===qty?0:money(h.basis*(h.qty-qty)/h.qty);
    h.qty-=qty; p.cash+=gross-fee;
  }
  if(h.qty) p.holdings[code]=h; else delete p.holdings[code];
  return {turn:s.turn,id:p.id,name:p.name,code,side,qty,price,fee};
}
export function playerTrade(state,order) {
  if(state.winner!==null) throw Error("리그가 종료됐습니다.");
  const fill=trade(state,state.players[0],order);
  state.trades.push(fill);
  return fill;
}
export function finishEarly(state) {
  if(state.winner!==null) throw Error("리그가 종료됐습니다.");
  state.winner=-1;
  state.endedEarly=true;
  state.news=null;
  return state;
}
function readNews(s,p) {
  if (!s.newsRules) return s.news;
  const signals=s.news.outcomes.filter(([code])=>p.symbols.includes(code));
  const bullish=signals.find(([,reading])=>reading>0);
  const bearish=signals.find(([,reading])=>reading<0);
  const lead=bullish??bearish;
  const price=s.market[lead?.[0]];
  const last=price?.bars.at(-1);
  const alreadyMoved=last ? Math.abs(last.close/last.open-1)>=.035 : false;
  return {code:lead?.[0], impact:lead?.[1]??0, expected:alreadyMoved, bearish:bearish?.[0]};
}
function decide(s,p,place,legacyFees) {
  const n=readNews(s,p);
  const entries=firms.filter(([code])=>p.symbols.includes(code)).map(([code,,,base])=>{
    const m=s.market[code], last=m.bars.at(-1);
    return {code,price:m.price,momentum:last?(last.close-last.open)/last.open:0,relative:m.price/base-1};
  });
  const style=p.id, held=Object.entries(p.holdings);
  const difficulty=s.difficulty??1;
  if(difficulty===0 && (s.turn+p.id)%3===0) return;
  for(const [code,h] of held) {
    const ret=s.market[code].price*h.qty/h.basis-1;
    const baseline=style===5?-.025:style===6?-.14:-.075;
    const stop=difficulty===2?baseline*.72:baseline;
    const target=style===3?.055:style===5?.035:.10;
    if(ret<stop || ret>target || (style===1 && (code===n.bearish || (code===n.code && n.impact<0))))
      return {code,side:"sell",qty:h.qty};
  }
  const sorted = (key,descending=true) => entries.slice().sort((a,b)=>descending?b[key]-a[key]:a[key]-b[key]);
  let pick, fraction=.24;
  switch(style) {
    case 1: if(n.impact>0) pick=entries.find(e=>e.code===n.code); fraction=.43; break;
    case 2: pick=sorted("momentum")[0]; if(pick.momentum<.012) return; fraction=.31; break;
    case 3: pick=sorted("momentum",false)[0]; if(pick.momentum>-.035) return; break;
    case 4: pick=entries.find(e=>!p.holdings[e.code] && !(e.code===n.bearish || (e.code===n.code && n.impact<0))); fraction=.17; break;
    case 5: if((s.newsRules?n.impact>0:n.impact===2) && !n.expected) pick=entries.find(e=>e.code===n.code); fraction=.32; break;
    case 6: pick=sorted("relative",false)[0]; if(pick.relative>-.065) return; fraction=.21; break;
    case 7: if(n.impact>0) pick=entries.find(e=>e.code===n.code);
      fraction=place>=ranking(s).length-2?.60:.14; break;
  }
  if(difficulty===2 && (!pick || p.holdings[pick.code])) {
    pick=sorted("momentum").find(e=>!p.holdings[e.code] && e.momentum>.018 &&
      e.code!==n.bearish && !(e.code===n.code && n.impact<0));
  }
  if(!pick || p.holdings[pick.code]) return;
  if(difficulty===0) fraction*=.65;
  const qty=Math.floor(p.cash*Math.min(.70,fraction+s.division*.035)/(legacyFees?pick.price*1.0025+1:pick.price));
  if(qty>0) return {code:pick.code,side:"buy",qty};
}
export function advance(previous,order=null,legacyFees=false) {
  if(previous.winner!==null) throw Error("리그가 종료됐습니다.");
  const s=structuredClone(previous);
  const planned=ranking(previous).flatMap((p,i)=>p.id===0?[]:[[p.id,decide(previous,p,i,legacyFees)]]);
  const newFills=[trade(s,s.players[0],order,legacyFees),
    ...planned.map(([id,request])=>trade(s,s.players[id],request,legacyFees))].filter(Boolean);
  const fills=[...s.trades.filter(fill=>fill.turn===s.turn),...newFills];
  s.trades.push(...newFills);
  for(const [code] of firms) {
    const m=s.market[code], open=m.price;
    let shock=0, reversal=0;
    if(s.newsRules) {
      const event=s.news.outcomes.find(([symbol])=>symbol===code);
      if(event && event[2]) {
        shock=event[2]/100*(.65+random(s)*.7);
        const last=m.bars.at(-1);
        if(last && Math.sign(last.close-last.open)===Math.sign(shock))
          reversal=-(last.close/last.open-1)*.30;
      }
    } else if(code===s.news.code) {
      shock=s.news.impact*(s.news.expected?.019:.043)*(.6+random(s)*.8);
      reversal=s.news.expected?-Math.sign(shock)*random(s)*.043:0;
    }
    const flow=fills.filter(f=>f.code===code).reduce((a,f)=>a+(f.side==="buy"?1:-1)*f.qty*open,0);
    const movement=(random(s)-.5)*.035+m.drift+shock+reversal+Math.max(-.014,Math.min(.014,flow/55_000_000));
    const close=Math.max(100, money(open*(1+Math.max(-.19,Math.min(.19,movement)))));
    const high=money(Math.max(open,close)*(1+random(s)*.016));
    const low=money(Math.min(open,close)*(1-random(s)*.016));
    m.price=close; m.drift=(s.newsRules ? shock!==0 : code===s.news.code)?shock*.24:m.drift*.36;
    m.bars.push({turn:s.turn,open,high,low,close});
  }
  s.turn++;
  if(s.turn%3===0) s.closing.push({day:s.turn/3, ranks:ranking(s).map(p=>({id:p.id,name:p.name,total:value(p,s)}))});
  if(s.turn%15===0) {
    const ranks=ranking(s);
    // Equal final assets eliminate the higher roster number by a declared tie rule.
    const last=ranks.at(-1);
    last.exit={week:s.turn/15,total:value(last,s)};
    last.active=false;
    if(ranks.length===2 || last.id===0) s.winner=ranks.length===2?ranks[0].id:-1;
  }
  s.news=s.winner===null?news(s):null;
  return s;
}
