import {capital,firms,rivals,divisions,phases,grade,create,value,ranking,advance,trade} from "./engine.js";
const $=id=>document.getElementById(id);
import {loadSeason,saveSeason} from "./save.js";
const number=n=>n.toLocaleString("ko-KR");
const won=n=>number(n)+"원";
const pct=n=>((n/capital-1)*100).toFixed(2)+"%";
let seed=Date.now()>>>0, actions=[], state=create(0,seed), symbol=firms[0][0];
let queued, feedback="";
try {
 const saved=loadSeason();
 if(saved) ({seed,actions,state}=saved);
} catch {
 $("error").textContent="기존 쿠키를 읽지 못해 새 시즌을 열었습니다.";
}
function save() {
 try {
  if(saveSeason(seed,state.division,actions)) return;
 } catch {}
 $("error").textContent="쿠키 저장이 차단되어 새로고침하면 진행 기록을 잃을 수 있습니다.";
}
function startSeason(division) {
 seed=Date.now()>>>0;
 actions=[]; queued=undefined; feedback="";
 state=create(division,seed);
 $("error").textContent="";
 save();render();
}
function chart() {
 const bars=state.market[symbol].bars.slice(-24);
 if(!bars.length) {$("chart").innerHTML='<p class="hint">첫 구간을 진행하면 캔들이 생깁니다.</p>';return;}
 const min=Math.min(...bars.map(b=>b.low)), max=Math.max(...bars.map(b=>b.high));
 const y=p=>214-(p-min)/Math.max(1,max-min)*184, x=i=>27+i*(545/Math.max(12,bars.length));
 const grids=[0,1,2,3].map(i=>{const p=min+(max-min)*i/3;return '<path stroke="#344657" d="M12 '+y(p)+' H575"/><text x="585" y="'+(y(p)+4)+'">'+number(Math.round(p))+'</text>';}).join("");
 const candles=bars.map((b,i)=>{
  const color=b.close>=b.open?"#ff7888":"#79a5ff", xx=x(i),yy=y(b.open),cy=y(b.close);
  const fill=state.trades.find(f=>f.turn===b.turn&&f.code===symbol&&f.id===0);
  const marker=!fill?"":fill.side==="buy"
   ?'<path fill="#ffd166" d="M'+xx+' '+(yy-7)+' l7 7 -7 7 -7 -7 Z"><title>매수 '+fill.qty+'주 · '+won(fill.price)+'</title></path>'
   :'<rect x="'+(xx-5)+'" y="'+(yy-5)+'" width="10" height="10" fill="#dca6ff"><title>매도 '+fill.qty+'주 · '+won(fill.price)+'</title></rect>';
  return '<g><title>거래일 '+(Math.floor(b.turn/3)+1)+' · 시가 '+won(b.open)+' · 고가 '+won(b.high)+' · 저가 '+won(b.low)+' · 종가 '+won(b.close)+'</title><path d="M'+xx+' '+y(b.high)+' V'+y(b.low)+'" stroke="'+color+'" stroke-width="2"/><rect x="'+(xx-6)+'" y="'+Math.min(yy,cy)+'" width="12" height="'+Math.max(2,Math.abs(yy-cy))+'" fill="'+color+'"/></g>'+marker;
 }).join("");
 $("chart").innerHTML='<svg viewBox="0 0 655 237" role="img" aria-label="시가 고가 저가 종가 캔들" fill="#a2b4c2" font-size="12">'+grids+candles+'</svg><span class="hint">◆ 매수　■ 매도</span>';
}
function render() {
 const day=Math.floor(state.turn/3)+1, phase=phases[state.turn%3], n=state.news, me=state.players[0];
 const closed=state.winner!==null;
 $("season").innerHTML='<strong>'+divisions[state.division]+' 리그</strong>'+(closed?'시즌 종료':Math.ceil(day/5)+'주차 · '+day+'일 · '+phase);
 $("news").innerHTML=n?'<h2>'+n.title+'</h2><span class="badge '+(n.impact>0?"positive":"negative")+'">'+grade[n.impact]+'</span><p>'+firms.find(([code])=>code===n.code)[1]+' · '+(n.expected?"시장에 돌던 소문입니다. 일부는 이미 가격에 반영됐을 수 있습니다.":"시장에 새로 공개된 정보입니다.")+'</p>':'<p>시즌이 마감됐습니다.</p>';
 $("symbols").innerHTML=firms.map(([code,name])=>'<button data-code="'+code+'" class="'+(code===symbol?"selected":"")+'" aria-pressed="'+(code===symbol)+'">'+name+'</button>').join("");
 const market=state.market[symbol], last=market.bars.at(-1);
 const move=last?((last.close/last.open-1)*100):0;
 $("orderinfo").textContent=won(market.price)+" · 직전 턴 "+(move>0?"+":"")+move.toFixed(2)+"% · 보유 "+(me.holdings[symbol]?.qty||0)+"주";
 $("queued").textContent=queued===undefined?"매수·매도·보유 중 하나를 선택하세요.":queued?
  firms.find(([code])=>code===queued.code)[1]+" "+queued.qty+"주 "+(queued.side==="buy"?"매수":"매도")+" 대기":
  "보유·관망 대기";
 $("feedback").textContent=feedback;
 $("advance").disabled=closed||queued===undefined;
 for(const id of ["buy","sell","wait","qty"]) $(id).disabled=closed;
 $("ranks").innerHTML=[...ranking(state),...state.players.filter(p=>!p.active).sort((a,b)=>b.exit.week-a.exit.week)].map((p,i)=>{
  const v=p.exit?.total??value(p,state);
  return '<div class="rank '+(p.id===0?"me ":"")+(!p.active?"out":"")+'"><div>'+ (p.active?(i+1)+'위':p.exit.week+'주차 탈락')+' · '+p.name+'<small>'+(p.id?rivals[p.id-1][1]:"플레이어")+'</small></div><div>'+won(v)+'<small>'+pct(v)+'</small></div></div>';
 }).join("");
 $("account").innerHTML='<div class="asset"><span>예수금</span><strong>'+won(me.cash)+'</strong></div><div class="asset"><span>평가자산</span><strong>'+won(me.exit?.total??value(me,state))+'</strong></div>'+Object.entries(me.holdings).map(([code,h])=>'<div class="asset"><span>'+firms.find(f=>f[0]===code)[1]+'</span><span>'+h.qty+'주</span></div>').join("");
 const end=Math.floor(state.turn/3)*3;
 const tape=state.trades.filter(f=>f.turn>=end-3&&f.turn<end);
 $("tape").innerHTML=end&&tape.length?tape.map(f=>'<div class="fill"><div>'+f.name+'<small>'+firms.find(x=>x[0]===f.code)[1]+'</small></div><div>'+(f.side==="buy"?"매수":"매도")+' '+f.qty+'주<small>'+won(f.price)+'</small></div></div>').join(""):'<p class="hint">완료된 거래일의 주문 내역이 표시됩니다.</p>';
 const result=$("result");
 result.hidden=!closed;
 if(closed) {
 const win=state.winner===0;
 result.innerHTML='<h2>'+(win?"리그 우승":"시즌 탈락")+'</h2><p>'+(win?"다음 리그는 동일한 시작 자금으로 진행합니다.":"다음 시즌에 다시 도전할 수 있습니다.")+'</p><button id="next">'+(win&&state.division<divisions.length-1?"상위 리그로 승격":"이 리그 다시 시작")+'</button>';
 $("next").onclick=()=>{startSeason(Math.min(state.division+(win?1:0),divisions.length-1));};
 }
 chart();
}
function select(side) {
 $("error").textContent="";
 const draft=side?{code:symbol,side,qty:$("qty").valueAsNumber}:null;
 try {
  trade(state,structuredClone(state.players[0]),draft);
  queued=draft;render();
 } catch(error){$("error").textContent=error.message;}
}
function progress() {
 if(queued===undefined) return;
 $("error").textContent="";
 try {
  const code=queued?.code??symbol, before=state.market[code].price;
  const next=advance(state,queued), after=next.market[code].price;
  const name=firms.find(([id])=>id===code)[1], change=(after/before-1)*100;
  const side=queued?.side;
  const result=side==="buy"?"매수 체결":side==="sell"?"매도 체결":"보유·관망";
  feedback=result+" · "+name+" "+won(before)+" → "+won(after)+" ("+
   (change>0?"+":"")+change.toFixed(2)+"%)";
  actions.push(queued);state=next;queued=undefined;save();render();
 } catch(error){$("error").textContent=error.message;}
}
$("symbols").onclick=e=>{if(e.target.dataset.code){symbol=e.target.dataset.code;render();}};
$("buy").onclick=()=>select("buy");$("sell").onclick=()=>select("sell");$("wait").onclick=()=>select();
$("advance").onclick=progress;
$("reset").onclick=()=>{if(confirm("현재 리그의 시즌을 초기화할까요?"))startSeason(state.division);};
render();
