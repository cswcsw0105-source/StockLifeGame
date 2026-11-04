import {capital,firms,rivals,divisions,phases,create,value,ranking,advance,playerTrade,finishEarly} from "./engine.js";
const $=id=>document.getElementById(id);
import {loadSeason,saveSeason,orderToken} from "./save.js";
const number=n=>n.toLocaleString("ko-KR");
const won=n=>number(n)+"원";
const pct=n=>((n/capital-1)*100).toFixed(2)+"%";
let seed=Date.now()>>>0, actions=[], state=create(0,seed);
let feedback="", hasSave=false, screen="home";
const difficulties=["쉬움","보통","어려움"];
const turnDuration = 10_000;
const speed = $("speed-mode");
try {speed.checked=localStorage.getItem("stocklife_mode")==="speed";}
catch {speed.checked=false;}
let timer, deadline, remaining = turnDuration;
try {
 const saved=loadSeason();
 if(saved) {({seed,actions,state}=saved);hasSave=true;}
} catch {
 $("error").textContent="기존 쿠키를 읽지 못해 새 시즌을 열었습니다.";
}
let symbol=state.players[0].symbols[0];
function save() {
 hasSave=true;
 try {
  if(saveSeason(seed,state.division,actions)) return;
 } catch {}
 $("error").textContent="쿠키 저장이 차단되어 새로고침하면 진행 기록을 잃을 수 있습니다.";
}
function startSeason(division,difficulty=state.difficulty??1) {
 seed=Date.now()>>>0;
 actions=difficulty===1?[]:["d"+difficulty]; feedback="";
 state=create(division,seed,true,difficulty);
 symbol=state.players[0].symbols[0];
 $("error").textContent="";
 save();render();resetTimer();
}
function chart() {
 const bars=state.market[symbol].bars.slice(-24);
 if(!bars.length) {$("chart").innerHTML='<p class="hint">첫 구간을 진행하면 캔들이 생깁니다.</p>';return;}
 const min=Math.min(...bars.map(b=>b.low)), max=Math.max(...bars.map(b=>b.high));
 const y=p=>214-(p-min)/Math.max(1,max-min)*184, x=i=>27+i*(545/Math.max(12,bars.length));
 const grids=[0,1,2,3].map(i=>{const p=min+(max-min)*i/3;return '<path stroke="#344657" d="M12 '+y(p)+' H575"/><text x="585" y="'+(y(p)+4)+'">'+number(Math.round(p))+'</text>';}).join("");
 const candles=bars.map((b,i)=>{
  const color=b.close>=b.open?"#ff7888":"#79a5ff", xx=x(i),yy=y(b.open),cy=y(b.close);
  const fills=state.trades.filter(f=>f.turn===b.turn&&f.code===symbol&&f.id===0);
  const marker=["buy","sell"].map(side=>{
   const qty=fills.filter(f=>f.side===side).reduce((sum,f)=>sum+f.qty,0);
   if(!qty) return "";
   const mx=xx+(fills.some(f=>f.side!==side)?(side==="buy"?-6:6):0);
   return side==="buy"
   ?'<path fill="#ffd166" d="M'+mx+' '+(yy-7)+' l7 7 -7 7 -7 -7 Z"><title>매수 '+qty+'주 · '+won(b.open)+'</title></path>'
   :'<rect x="'+(mx-5)+'" y="'+(yy-5)+'" width="10" height="10" fill="#dca6ff"><title>매도 '+qty+'주 · '+won(b.open)+'</title></rect>';
  }).join("");
  return '<g><title>거래일 '+(Math.floor(b.turn/3)+1)+' · 시가 '+won(b.open)+' · 고가 '+won(b.high)+' · 저가 '+won(b.low)+' · 종가 '+won(b.close)+'</title><path d="M'+xx+' '+y(b.high)+' V'+y(b.low)+'" stroke="'+color+'" stroke-width="2"/><rect x="'+(xx-6)+'" y="'+Math.min(yy,cy)+'" width="12" height="'+Math.max(2,Math.abs(yy-cy))+'" fill="'+color+'"/></g>'+marker;
 }).join("");
 $("chart").innerHTML='<svg viewBox="0 0 655 237" role="img" aria-label="시가 고가 저가 종가 캔들" fill="#a2b4c2" font-size="12">'+grids+candles+'</svg><span class="hint">◆ 매수　■ 매도</span>';
}
function render() {
 const day=Math.floor(state.turn/3)+1, phase=phases[state.turn%3], n=state.news, me=state.players[0];
 const closed=state.winner!==null;
 const own=me.symbols;
 $("turn-panel").hidden=closed;
 $("season").innerHTML='<strong>'+divisions[state.division]+' 리그 · '+difficulties[state.difficulty??1]+'</strong>'+(closed?'시즌 종료':Math.ceil(day/5)+'주차 · '+day+'일 · '+phase);
 const newsPanel=$("news");
 newsPanel.replaceChildren();
 const headline=document.createElement(n?"h2":"p");
 headline.textContent=n?.title??"시즌이 마감됐습니다.";
 newsPanel.append(headline);
 if(n?.body) {
  const body=document.createElement("p");
  body.textContent=n.body;
  newsPanel.append(body);
 }
 $("symbols").innerHTML=firms.filter(([code])=>own.includes(code)).map(([code,name])=>'<button data-code="'+code+'" class="'+(code===symbol?"selected":"")+'" aria-pressed="'+(code===symbol)+'">'+name+'</button>').join("");
 const market=state.market[symbol], last=market.bars.at(-1);
 const move=last?((last.close/last.open-1)*100):0;
 $("orderinfo").textContent=won(market.price)+" · 직전 턴 "+(move>0?"+":"")+move.toFixed(2)+"% · 보유 "+(me.holdings[symbol]?.qty||0)+"주";
 $("feedback").textContent=feedback;
 $("advance").disabled=closed;
 $("qty").disabled=closed;
 updateOrderPreview();
 $("account").innerHTML='<div class="asset"><span>예수금</span><strong>'+won(me.cash)+'</strong></div><div class="asset"><span>평가자산</span><strong>'+won(me.exit?.total??value(me,state))+'</strong></div>'+Object.entries(me.holdings).map(([code,h])=>'<div class="asset"><span>'+firms.find(f=>f[0]===code)[1]+'</span><span>'+h.qty+'주</span></div>').join("");
 const end=Math.floor(state.turn/3)*3;
 const tape=state.trades.filter(f=>f.turn>=end-3&&f.turn<end&&own.includes(f.code));
 $("tape").innerHTML=end&&tape.length?tape.map(f=>'<div class="fill"><div>'+f.name+'<small>'+firms.find(x=>x[0]===f.code)[1]+'</small></div><div>'+(f.side==="buy"?"매수":"매도")+' '+f.qty+'주<small>'+won(f.price)+'</small></div></div>').join(""):'<p class="hint">완료된 거래일의 주문 내역이 표시됩니다.</p>';
 const result=$("result");
 result.hidden=!closed;
 if(closed) {
 const win=state.winner===0;
 const champion=win && state.division===divisions.length-1;
 const standings=[...ranking(state),...state.players.filter(p=>!p.active).sort((a,b)=>b.exit.week-a.exit.week)].map((p,i)=>{
  const v=p.exit?.total??value(p,state);
  return '<div class="rank '+(p.id===0?"me ":"")+(!p.active?"out":"")+'"><div>'+ ((i+1)+'위'+(p.exit?' · '+p.exit.week+'주차 탈락':''))+' · '+p.name+'<small>'+(p.id?rivals[p.id-1][1]:"플레이어")+'</small></div><div>'+won(v)+'<small>'+pct(v)+'</small></div></div>';
 }).join("");
 result.innerHTML='<h2>'+(champion?"키 크는 약 획득":win?"리그 우승":state.endedEarly?"현재 자산으로 정산":"시즌 탈락")+'</h2><p>'+(champion?"프리미어 리그 정상에 올라 우승 상품을 받았습니다.":win?"다음 리그는 동일한 시작 자금으로 진행합니다.":state.endedEarly?"현재 가격으로 평가한 순위입니다. 조기 정산은 승격에 반영되지 않습니다.":"다음 시즌에 다시 도전할 수 있습니다.")+'</p><h2>시즌 결과</h2><p class="hint">생존자는 시즌 종료 시점, 탈락자는 탈락 시점 기준</p>'+standings+'<button id="next">'+(win&&state.division<divisions.length-1?"상위 리그로 승격":"이 리그 다시 시작")+'</button>';
 $("next").onclick=()=>{startSeason(Math.min(state.division+(win?1:0),divisions.length-1));};
 }
 chart();
}
function updateOrderPreview() {
 const player=state.players[0], price=state.market[symbol].price, qty=$("qty").valueAsNumber;
 const buyMax=Math.floor(player.cash/price), sellMax=player.holdings[symbol]?.qty??0;
 const valid=Number.isSafeInteger(qty)&&qty>0;
 $("order-preview").textContent="최대 매수 "+number(buyMax)+"주 · 최대 매도 "+number(sellMax)+"주"+
  (valid?" · "+number(qty)+"주 주문 금액 "+won(qty*price):"");
 $("buy").disabled=state.winner!==null||!valid||qty>buyMax;
 $("sell").disabled=state.winner!==null||!valid||qty>sellMax;
}
function executeOrder(side) {
 $("error").textContent="";
 const order={code:symbol,side,qty:$("qty").valueAsNumber};
 try {
  const fill=playerTrade(state,order);
  actions.push(orderToken(order));
  const name=firms.find(([code])=>code===fill.code)[1];
  feedback=name+" "+number(fill.qty)+"주 "+(side==="buy"?"매수":"매도")+" 체결 · "+won(fill.price)+" × "+number(fill.qty)+"주 = "+won(fill.price*fill.qty);
  save();render();
 } catch(error){$("error").textContent=error.message;}
}
function progress(timedOut=false) {
 if(state.winner!==null) return;
 $("error").textContent="";
 try {
  const before=state.market[symbol].price;
  const traded=state.trades.at(-1)?.turn===state.turn;
  const next=advance(state), after=next.market[symbol].price;
  const name=firms.find(([code])=>code===symbol)[1], change=(after/before-1)*100;
  feedback=(timedOut?"시간 종료 · ":"")+(traded?"턴 마감":"보유·관망")+" · "+name+" "+won(before)+" → "+won(after)+" ("+
   (change>0?"+":"")+change.toFixed(2)+"%)";
  actions.push("h");state=next;save();render();resetTimer();
 } catch(error){
  if(timedOut) {speed.checked=false;resetTimer();}
  $("error").textContent=error.message;
 }
}
$("symbols").onclick=e=>{if(e.target.dataset.code){symbol=e.target.dataset.code;render();}};
$("qty").oninput=updateOrderPreview;
$("buy").onclick=()=>executeOrder("buy");
$("sell").onclick=()=>executeOrder("sell");
$("advance").onclick=()=>progress();
$("finish").onclick=()=>{
 if(state.winner!==null || !confirm("현재 평가자산으로 시즌을 끝내고 결과를 볼까요?")) return;
 finishEarly(state);actions.push("e");save();render();resetTimer();
};

function showClock() {
 const output=$("countdown");
 output.hidden=!speed.checked;
 $("timer-hint").hidden=!speed.checked;
 if(!speed.checked) return;
 const ms=deadline===undefined?remaining:Math.max(0,deadline-performance.now());
 const seconds=Math.ceil(ms/1000);
 output.textContent=document.hidden?"일시정지 · "+seconds+"초":seconds+"초";
 output.dataset.urgent=String(seconds<=5);
}
function tick() {
 showClock();
 const ms=deadline-performance.now();
 if(ms<=0) progress(true);
 else timer=setTimeout(tick,Math.min(ms,200));
}
function pauseTimer() {
 clearTimeout(timer);
 if(deadline!==undefined) remaining=Math.max(0,deadline-performance.now());
 deadline=undefined;
 showClock();
}
function resumeTimer() {
 if(screen!=="game" || !speed.checked || state.winner!==null || document.hidden || deadline!==undefined) return;
 deadline=performance.now()+remaining;
 tick();
}
function resetTimer() {
 clearTimeout(timer);
 deadline=undefined;
 remaining=turnDuration;
 showClock();
 resumeTimer();
}
function rememberMode() {
 try {localStorage.setItem("stocklife_mode",speed.checked?"speed":"normal");} catch {}
}
speed.onchange=()=>{rememberMode();resetTimer();};
document.addEventListener("visibilitychange",()=>document.hidden?pauseTimer():resumeTimer());

function showScreen(target) {
 if(target!=="game") pauseTimer();
 screen=target;
 for(const name of ["home","setup","training","game"]) $(name+"-screen").hidden=name!==target;
 $("back-home").hidden=target!=="game";
 if(target==="home") {
  $("continue-game").hidden=!hasSave;
  $("continue-game").textContent=state.winner===null?"이어하기":"지난 결과 보기";
  $("save-summary").textContent=hasSave?divisions[state.division]+" 리그 · "+difficulties[state.difficulty??1]+" · "+
   (state.winner===null?Math.floor(state.turn/3)+1+"일차":"시즌 종료"):"";
 }
 if(target==="game") {render();resumeTimer();}
}
$("back-home").onclick=()=>showScreen("home");
$("cancel-setup").onclick=()=>showScreen("home");
$("new-game").onclick=()=>showScreen("setup");
$("continue-game").onclick=()=>showScreen("game");
$("setup-form").onsubmit=event=>{
 event.preventDefault();
 if(hasSave && state.winner===null && !confirm("새 게임을 시작하면 진행 중인 시즌이 바뀝니다. 시작할까요?")) return;
 const settings=new FormData(event.currentTarget);
 speed.checked=settings.get("mode")==="speed";
 rememberMode();
 startSeason(0,Number(settings.get("difficulty")));
 showScreen("game");
};

let practice, practiceCode, trainingStep;
function openTraining() {
 practice=create(0,42);
 practiceCode=practice.players[0].symbols[0];
 practice.news={outcomes:[[practiceCode,1,4.5]]};
 trainingStep=0;
 showScreen("training");
 renderTraining();
}
function renderTraining() {
 const company=firms.find(([code])=>code===practiceCode)[1];
 const player=practice.players[0];
 const price=practice.market[practiceCode].price;
 const quotes=[
  "대형 계약을 따냈지만 매출은 납품이 끝난 뒤 반영됩니다. 이번에는 조건을 읽고 연습용으로 1주만 사 봅니다.",
  "체결은 끝났습니다. 다음 턴을 누르면 뉴스가 반영된 가격을 확인할 수 있어요.",
  "새 가격이 공개됐습니다. 1주를 팔아 매도 금액이 예수금에 들어오는지 확인하세요.",
  "매수, 턴 진행, 매도를 연습했습니다. 본게임에서는 직접 수량과 타이밍을 정합니다.",
 ];
 $("training-news").textContent=trainingStep<2?company+" · 공급 계약 발표":company+" · 오전 가격 "+won(price);
 $("training-account").textContent="예수금 "+won(player.cash)+" · 현재가 "+won(price)+" · 보유 "+(player.holdings[practiceCode]?.qty??0)+"주";
 $("training-guide").textContent=quotes[trainingStep];
 $("training-action").textContent=["1주 매수","다음 턴 진행","1주 매도","연습 끝내고 메인으로"][trainingStep];
 $("leave-training").hidden=trainingStep===3;
}
$("open-tutorial").onclick=openTraining;
$("leave-training").onclick=()=>showScreen("home");
$("training-action").onclick=()=>{
 if(trainingStep===3){showScreen("home");return;}
 if(trainingStep===1) practice=advance(practice);
 else playerTrade(practice,{code:practiceCode,side:trainingStep===0?"buy":"sell",qty:1});
 trainingStep++;
 renderTraining();
};
showScreen("home");
