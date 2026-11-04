export const capital = 1_000_000;
import {firms,stories} from "./content.js";
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
function news(state) {
  const eligible = stories.filter(([,title]) => title !== state.news?.title);
  const [code, title, impact] = eligible[Math.floor(random(state)*eligible.length)];
  return {code, title, impact, expected: random(state) < .35};
}
export function create(division=0, seed=Date.now()>>>0) {
  const state = {version:1, division, seed, turn:0, winner:null, players:[],
    market:Object.fromEntries(firms.map(([code,,,price])=>[code,{price, bars:[], drift:0}])),
    trades:[], closing:[], news:null};
  state.players=names.map((name,id)=>({...createPlayer(name,id), symbols:drawSymbols(state)}));
  state.news=news(state);
  return state;
}
export const value = (p,s) => p.cash + Object.entries(p.holdings).reduce((a,[code,h])=>a+h.qty*s.market[code].price,0);
export const ranking = s => s.players.filter(p=>p.active).sort((a,b)=>value(b,s)-value(a,s) || a.id-b.id);
export function trade(s,p,order) {
  if (!order || !p.active) return null;
  const {code,side,qty}=order, price=s.market[code]?.price;
  if (!p.symbols.includes(code)) throw Error("배정받은 종목만 거래할 수 있습니다.");
  if (!price || !Number.isSafeInteger(qty) || qty<1 || !["buy","sell"].includes(side)) throw Error("주문 수량을 확인하세요.");
  const h=p.holdings[code] || {qty:0,basis:0};
  const gross=price*qty, fee=Math.ceil(gross*.0025);
  if (side==="buy") {
    if(gross+fee>p.cash) throw Error("수수료를 포함한 주문 금액이 예수금을 초과합니다.");
    p.cash-=gross+fee; h.qty+=qty; h.basis+=gross+fee;
  } else {
    if(qty>h.qty) throw Error("보유 수량을 초과합니다.");
    h.basis=h.qty===qty?0:money(h.basis*(h.qty-qty)/h.qty);
    h.qty-=qty; p.cash+=gross-fee;
  }
  if(h.qty) p.holdings[code]=h; else delete p.holdings[code];
  return {turn:s.turn,id:p.id,name:p.name,code,side,qty,price,fee};
}
function decide(s,p,place) {
  const n=s.news;
  const entries=firms.filter(([code])=>p.symbols.includes(code)).map(([code,,,base])=>{
    const m=s.market[code], last=m.bars.at(-1);
    return {code,price:m.price,momentum:last?(last.close-last.open)/last.open:0,relative:m.price/base-1};
  });
  const style=p.id, held=Object.entries(p.holdings);
  for(const [code,h] of held) {
    const ret=s.market[code].price*h.qty/h.basis-1;
    const stop=style===5?-.025:style===6?-.14:-.075;
    const target=style===3?.055:style===5?.035:.10;
    if(ret<stop || ret>target || (style===1 && code===n.code && n.impact<0))
      return {code,side:"sell",qty:h.qty};
  }
  const sorted = (key,descending=true) => entries.slice().sort((a,b)=>descending?b[key]-a[key]:a[key]-b[key]);
  let pick, fraction=.24;
  switch(style) {
    case 1: if(n.impact>0) pick=entries.find(e=>e.code===n.code); fraction=.43; break;
    case 2: pick=sorted("momentum")[0]; if(pick.momentum<.012) return; fraction=.31; break;
    case 3: pick=sorted("momentum",false)[0]; if(pick.momentum>-.035) return; break;
    case 4: pick=entries.find(e=>!p.holdings[e.code] && !(e.code===n.code && n.impact<0)); fraction=.17; break;
    case 5: if(n.impact===2 && !n.expected) pick=entries.find(e=>e.code===n.code); fraction=.32; break;
    case 6: pick=sorted("relative",false)[0]; if(pick.relative>-.065) return; fraction=.21; break;
    case 7: if(n.impact>0) pick=entries.find(e=>e.code===n.code);
      fraction=place>=ranking(s).length-2?.60:.14; break;
  }
  if(!pick || p.holdings[pick.code]) return;
  const qty=Math.floor(p.cash*Math.min(.70,fraction+s.division*.035)/(pick.price*1.0025+1));
  if(qty>0) return {code:pick.code,side:"buy",qty};
}
export function advance(previous,order=null) {
  if(previous.winner!==null) throw Error("리그가 종료됐습니다.");
  const s=structuredClone(previous);
  const planned=ranking(previous).flatMap((p,i)=>p.id===0?[]:[[p.id,decide(previous,p,i)]]);
  const fills=[trade(s,s.players[0],order),...planned.map(([id,request])=>trade(s,s.players[id],request))].filter(Boolean);
  s.trades.push(...fills);
  for(const [code] of firms) {
    const m=s.market[code], open=m.price, targeted=code===s.news.code;
    const shock=targeted ? s.news.impact*(s.news.expected?.019:.043)*(0.6+random(s)*.8):0;
    const reversal=targeted && s.news.expected ? -Math.sign(shock)*random(s)*.043 : 0;
    const flow=fills.filter(f=>f.code===code).reduce((a,f)=>a+(f.side==="buy"?1:-1)*f.qty*open,0);
    const movement=(random(s)-.5)*.035+m.drift+shock+reversal+Math.max(-.014,Math.min(.014,flow/55_000_000));
    const close=Math.max(100, money(open*(1+Math.max(-.19,Math.min(.19,movement)))));
    const high=money(Math.max(open,close)*(1+random(s)*.016));
    const low=money(Math.min(open,close)*(1-random(s)*.016));
    m.price=close; m.drift=targeted?shock*.24:m.drift*.36;
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
