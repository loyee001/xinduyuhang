'use strict';
const icons={settings:'<path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3Z" transform="translate(1 2)"/><circle cx="12" cy="11" r="3"/>',camera:'<path d="M14 4h-4L8 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4Z"/><circle cx="12" cy="13" r="3"/>',route:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h8"/>',expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4m-16-3v2m4-2v2m4-2v2"/>',gauge:'<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1"/>',signal:'<path d="M3 19v-3m6 3v-7m6 7V8m6 11V4"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',gamepad:'<path d="M7 7h10a4 4 0 0 1 4 3l1 7a2 2 0 0 1-3 2l-4-3H9l-4 3a2 2 0 0 1-3-2l1-7a4 4 0 0 1 4-3Z"/><path d="M6 11h4m-2-2v4m8-2h.1m2 2h.1"/>',sparkles:'<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 2v4m-2-2h4"/>','chevron-right':'<path d="m9 5 7 7-7 7"/>','chevron-left':'<path d="m15 5-7 7 7 7"/>','chevron-up':'<path d="m5 15 7-7 7 7"/>','chevron-down':'<path d="m5 9 7 7 7-7"/>','arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>','arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>','turn-left':'<path d="m9 3-6 6 6 6M3 9h10a7 7 0 0 1 7 7v5"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',play:'<path d="m8 4 12 8-12 8Z"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-5"/>',octagon:'<path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6Z"/><path d="M9 9h6v6H9Z"/>',refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',x:'<path d="m6 6 12 12M6 18 18 6"/>','wifi-off':'<path d="m3 3 18 18M2 8a16 16 0 0 1 4-2m4-1a16 16 0 0 1 12 3M5 12a11 11 0 0 1 5-2m5 1 4 1M8 16a6 6 0 0 1 8 0m-4 4h.01"/>'};
function paintIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[el.dataset.icon]||icons.info}</svg>`;});}
paintIcons();
const $=id=>document.getElementById(id);
const physics=window.RoverPhysics;
const traffic=window.RoverTraffic;
const laneControl=window.RoverLaneControl;
const laneCenters=[...laneControl.constants.laneCenters,laneControl.constants.shoulderCenter];
const laneName=index=>['左车道','中间车道','右车道','应急车道'][index];
let car=physics.createState();
let trafficWorld=traffic.createState(car,{density:'medium'});
const state={connected:true,mode:'manual',speedLimit:30,requestedGear:'forward',trafficDensity:'medium',autoLimitBraking:false,shiftPending:false,laneTarget:1,laneChanging:false,shoulderAlert:false,shoulderRecovery:false,wet:false,estop:false,serviceBrake:0,failsafe:false,plan:null,controls:new Map(),logs:[],trail:[[0,0]],latency:null,map:false,started:performance.now(),brakeAnchor:null,contactUntil:0,lastContactNotice:-Infinity,trafficInfo:null,lastInput:{throttle:0,brake:0,steering:0},predicted:0,pausedAt:null};
let camera=null,cameraReady=false,lastFrame=performance.now(),lastRender=0,lastCameraFrame=0,toastTimer;
state.laneAdvice=null;state.adviceCooldownUntil=0;
const driveNames={throttle:'油门',brake:'刹车',left:'左转向',right:'右转向'};
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3000);}
function log(message){state.logs.unshift({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),message});state.logs=state.logs.slice(0,80);renderLogs();}
function renderLogs(){const list=$('activity-log');list.replaceChildren();for(const entry of state.logs){const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');time.textContent=entry.time;text.textContent=entry.message;li.append(time,text);list.append(li);}}
function cancelPlan(reason){if(state.plan&&['running','ready'].includes(state.plan.status)){state.plan.status='cancelled';state.plan.reason=reason;renderPlan();}}
function requestBrake(reason,amount=.55,{emergency=false}={}){state.controls.clear();cancelPlan(reason);state.serviceBrake=Math.max(state.serviceBrake,amount);if(emergency)state.estop=true;log(reason);render();}
function emergencyStop(){requestBrake('紧急制动：全力刹车，车辆仍将继续移动直至停止',1,{emergency:true});toast('正在全力制动，刹车距离会持续累计');}
function releaseEmergency(){
  if(car.speed>.01)return;
  state.estop=false;state.failsafe=false;state.serviceBrake=0;
  if(state.shoulderAlert){
    state.shoulderRecovery=true;state.laneTarget=2;state.laneChanging=true;
    log('已解除应急车道制动锁定，按住油门后自动返回右车道');
  }else log('制动锁定已解除，车辆保持静止');
  render();
}
function available(){if(state.estop){toast('请等车辆停稳后解除制动锁定');return false;}if(!state.connected||!cameraReady){toast('连接或画面不可用，保持制动');return false;}if(car.energyKWh>=51.6){toast('模拟电量耗尽，请重置模拟');return false;}return true;}
function switchMode(mode){if(!['manual','ai'].includes(mode))return;if(mode!==state.mode){state.controls.clear();if(state.plan?.status==='running')requestBrake('已切换控制方式，取消 AI 并开始常规制动');state.mode=mode;}for(const name of ['manual','ai']){const active=name===mode;$(name+'-panel').hidden=!active;$(name+'-tab').classList.toggle('active',active);$(name+'-tab').setAttribute('aria-selected',String(active));$(name+'-tab').tabIndex=active?0:-1;}render();}
$('manual-tab').onclick=()=>switchMode('manual');$('ai-tab').onclick=()=>switchMode('ai');$('ai-shortcut').onclick=()=>{switchMode('ai');$('ai-tab').scrollIntoView({block:'nearest',behavior:'smooth'});};
for(const mode of ['manual','ai'])$(mode+'-tab').onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'manual':event.key==='End'?'ai':mode==='manual'?'ai':'manual';switchMode(next);$(next+'-tab').focus();}};
function pressDrive(action,id){if(state.controls.has(id)||!available())return false;cancelPlan('手动接管');state.failsafe=false;state.controls.set(id,action);if(action==='throttle'){state.serviceBrake=0;}log(`手动操作：${driveNames[action]}`);render();return true;}
function releaseDrive(id,cancelled=false){const action=state.controls.get(id);if(!action)return;state.controls.delete(id);if(cancelled)requestBrake('触控中断，开始常规制动');else if(action==='throttle')log('松开油门，车辆按阻力自然滑行');render();}
document.querySelectorAll('[data-drive]').forEach(button=>{
  button.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();const id='p'+event.pointerId;if(!pressDrive(button.dataset.drive,id))return;try{button.setPointerCapture(event.pointerId);}catch{releaseDrive(id,true);}};
  button.onpointerup=event=>releaseDrive('p'+event.pointerId);
  button.onpointercancel=event=>releaseDrive('p'+event.pointerId,true);
  button.onlostpointercapture=event=>releaseDrive('p'+event.pointerId,true);
  button.oncontextmenu=event=>event.preventDefault();
  button.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();if(!event.repeat)pressDrive(button.dataset.drive,'k'+event.code);}};
});
window.addEventListener('pointerup',event=>releaseDrive('p'+event.pointerId));
window.addEventListener('pointercancel',event=>releaseDrive('p'+event.pointerId,true));
function requestLaneChange(direction){
  if(![-1,1].includes(direction)||!available())return false;
  if(state.shoulderRecovery){toast('正在返回右车道，完成后可继续变道');return false;}
  if(state.laneChanging&&!laneControl.isCentered(car,laneCenters[state.laneTarget])){
    // A pending change can be cancelled while parked; a held/repeated input
    // must never queue several lanes behind a single gesture.
    const nearest=laneControl.nearestLane(car.x);
    if(car.speed===0&&state.laneTarget+direction===nearest){state.laneTarget=nearest;state.laneChanging=!laneControl.isCentered(car,laneCenters[nearest]);log(state.laneChanging?'已选择返回原车道，起步后自动居中':'已取消待起步变道');render();return true;}
    toast(car.speed===0?'已选择目标车道，按住油门开始变道':'正在变道，到达车道中央后可再次切换');return false;
  }
  const target=state.laneTarget+direction;
  if(target<0||target>3){toast(target<0?'已经是最左侧车道':'右侧已无可用车道');return false;}
  cancelPlan('手动变道接管');state.laneTarget=target;state.laneChanging=true;
  log(`向${direction<0?'左':'右'}变道至${laneName(target)}${target===3?'，进入后将触发紧急制动':''}`);
  if(target===3)toast('正在驶向应急车道，进入后会紧急制动');
  render();return true;
}
for(const button of document.querySelectorAll('[data-lane-change]')){
  const direction=Number(button.dataset.laneChange);
  button.onclick=()=>requestLaneChange(direction);
  button.onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();if(!event.repeat)requestLaneChange(direction);}};
}
function getLaneAdvice(){
  const advice=traffic.getLaneRecommendation(trafficWorld,car,{wet:state.wet,desiredSpeed:effectiveTarget(state.speedLimit)});
  let reason='';
  if(state.estop||state.failsafe||!state.connected||!cameraReady)reason='制动锁定或连接不可用，暂停变道建议。';
  else if(state.shoulderAlert||state.shoulderRecovery)reason='请先完成应急车道停车与返回，再评估正常车道。';
  else if(state.shiftPending||state.requestedGear!==car.gear)reason='正在换挡，请等待停稳并完成换挡。';
  else if(car.gear==='reverse'||state.requestedGear==='reverse')reason='倒车时暂停变道建议，请留意后方车辆。';
  else if(state.laneChanging)reason='正在完成变道，到达目标车道中央后重新评估。';
  else if(state.serviceBrake>0||state.autoLimitBraking||state.lastInput.brake>0||[...state.controls.values()].includes('brake'))reason='正在制动，请先稳定车速再评估变道。';
  else if(car.energyKWh>=51.6)reason='模拟电量耗尽，请重置模拟。';
  else if(car.wallContact||performance.now()<state.contactUntil)reason='车辆刚发生接触，请先保持车道并稳定行驶。';
  else if(!laneControl.isCentered(car,laneCenters[state.laneTarget]))reason='正在回正居中，请先稳定在当前车道。';
  else if(car.elapsedTime<state.adviceCooldownUntil)reason='刚完成变道，先保持当前车道再评估。';
  return reason?{...advice,status:'unavailable',direction:null,targetLane:null,reason}:advice;
}
function renderLaneAdvice(){
  const advice=state.laneAdvice=getLaneAdvice(),recommended=advice.status==='recommend';
  const title=recommended?`推荐向${advice.direction==='left'?'左':'右'}变道`:
    advice.status==='keep'?'保持当前车道':advice.status==='blocked'?'暂不建议变道':
    state.laneChanging?'正在完成变道':advice.reason==='车速较低，起步后再评估变道'?'起步后评估车流':'变道建议已暂停';
  $('lane-advice').dataset.status=advice.status;
  $('lane-advice-title').textContent=title;$('lane-advice-reason').textContent=advice.reason;
  $('lane-advice-icon').textContent=recommended?(advice.direction==='left'?'←':'→'):advice.status==='blocked'?'Ⅱ':'↑';
  const button=$('lane-advice-accept');button.disabled=!recommended;
  button.textContent=recommended?`按推荐向${advice.direction==='left'?'左':'右'}变道`:'按推荐变道';
  // Announce only a changed recommendation, not ten changing gap readings/sec.
  if($('lane-advice-live').textContent!==title)$('lane-advice-live').textContent=title;
  for(const lane of advice.lanes){
    const current=lane.lane===advice.currentLane,chosen=recommended&&lane.lane===advice.targetLane;
    const card=$('advice-lane-'+lane.lane),paused=advice.status==='unavailable';
    card.classList.toggle('current',current);card.classList.toggle('recommended',chosen);
    card.classList.toggle('blocked',!current&&!lane.safe&&!paused);
    $('advice-status-'+lane.lane).textContent=current?'当前车道':chosen?'推荐驶入':paused?'暂停评估':!lane.adjacent?'需逐条变道':lane.safe?'间隙足够':'暂不适合';
    const gapText=gap=>gap===null?'畅通':Math.max(0,gap).toFixed(0)+'m';
    $('advice-gap-'+lane.lane).textContent=`前 ${gapText(lane.frontGap)} · 后 ${gapText(lane.rearGap)}`;
    card.setAttribute('title',current?'当前车道':paused?advice.reason:lane.reason);
  }
  $('lane-left').classList.toggle('recommended-direction',recommended&&advice.direction==='left');
  $('lane-right').classList.toggle('recommended-direction',recommended&&advice.direction==='right');
}
function acceptLaneRecommendation(){
  const shown=state.laneAdvice,fresh=getLaneAdvice();
  if(shown?.status!=='recommend'||fresh.status!=='recommend'||fresh.targetLane!==shown.targetLane||fresh.direction!==shown.direction){
    render();toast('路况已变化，请查看最新变道建议');return false;
  }
  const direction=fresh.direction==='left'?-1:1;
  if(fresh.targetLane<0||fresh.targetLane>2||fresh.targetLane!==state.laneTarget+direction)return false;
  if(!requestLaneChange(direction))return false;
  log(`已采纳变道建议：驶向${laneName(fresh.targetLane)}`);switchMode('manual');return true;
}
$('lane-advice-accept').onclick=acceptLaneRecommendation;
$('lane-advice-accept').onkeydown=event=>{
  if(['Enter',' '].includes(event.key)){event.preventDefault();if(!event.repeat)acceptLaneRecommendation();}
};
const keyMap={ArrowUp:'throttle',KeyW:'throttle',ArrowDown:'brake',KeyS:'brake'};
const laneKeyMap={ArrowLeft:-1,KeyA:-1,ArrowRight:1,KeyD:1};
window.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
  if(event.code==='Space'){event.preventDefault();requestBrake('按下空格，常规制动至停止');return;}
  if(event.key==='Escape'){requestBrake('已请求常规制动');if($('camera-panel').classList.contains('expanded'))toggleExpand(false);return;}
  if(state.mode==='manual'&&event.code==='KeyR'){event.preventDefault();if(!event.repeat)setGear(state.requestedGear==='reverse'?'forward':'reverse');return;}
  if(state.mode!=='manual')return;
  if(laneKeyMap[event.code]){event.preventDefault();if(!event.repeat)requestLaneChange(laneKeyMap[event.code]);return;}
  if(!keyMap[event.code])return;event.preventDefault();if(!event.repeat)pressDrive(keyMap[event.code],'k'+event.code);
});
window.addEventListener('keyup',event=>releaseDrive('k'+event.code));
function failSafe(reason){state.failsafe=true;requestBrake(reason,1);}
window.addEventListener('blur',()=>{if(car.speed>.01||state.controls.size||state.plan?.status==='running')failSafe('页面失去焦点，接管为全力制动');});
document.addEventListener('visibilitychange',()=>{if(document.hidden){state.pausedAt=performance.now();failSafe('页面进入后台，自动制动已触发');camera?.pause();}else{const elapsed=state.pausedAt===null?0:(performance.now()-state.pausedAt)/1000;advanceElapsed(Math.min(elapsed,60),true);state.pausedAt=null;lastFrame=performance.now();lastCameraFrame=0;render();}});
window.addEventListener('pagehide',()=>{state.controls.clear();state.failsafe=true;cancelPlan('页面离开');});
$('normal-stop').onclick=()=>requestBrake('常规制动：持续刹车至完全停止');$('emergency-stop').onclick=emergencyStop;$('reset-estop').onclick=releaseEmergency;
function currentRoadCap(){return traffic.limitAt(car.y)/3.6;}
function effectiveTarget(target,gear=state.requestedGear){return Math.min(target,currentRoadCap(),gear==='reverse'?physics.constants.maxReverseSpeed:100);}
function motionHeading(){return (car.heading+(car.gear==='reverse'?180:0))%360;}
function setGear(gear){
  if(!['forward','reverse'].includes(gear)||gear===state.requestedGear||!available())return;
  cancelPlan('手动换挡');state.controls.clear();state.requestedGear=gear;state.serviceBrake=0;state.failsafe=false;state.brakeAnchor=null;
  state.shiftPending=car.gear!==gear;
  log(car.speed>0?`已选择${gear==='reverse'?'倒车 R':'前进 D'}，先制动至停稳再换挡`:`已选择${gear==='reverse'?'倒车 R':'前进 D'}`);
  render();
}
$('gear-forward').onclick=()=>setGear('forward');$('gear-reverse').onclick=()=>setGear('reverse');
document.querySelectorAll('[data-density]').forEach(button=>button.onclick=()=>{
  const density=button.dataset.density;if(!traffic.densityPresets[density]||density===state.trafficDensity)return;
  traffic.setDensity(trafficWorld,car,density);state.trafficDensity=density;state.contactUntil=0;
  log(`车流切换为${traffic.densityPresets[density].label}，已重新布置周围车辆`);render();
});
$('speed-slider').oninput=event=>{const value=Number(event.target.value),max=state.requestedGear==='reverse'?physics.constants.maxReverseSpeed:100;if(!Number.isFinite(value)||value<1||value>max)return;state.speedLimit=value;render();};
function setRoad(wet){if(car.braking){toast('请在本次制动结束后切换路面');return;}state.wet=wet;state.brakeAnchor=null;log(`路面切换为${wet?'湿滑':'干燥'}，摩擦系数 ${wet?.45:.85}`);render();}
$('dry-road').onclick=()=>setRoad(false);$('wet-road').onclick=()=>setRoad(true);
function chineseNumbers(text){const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};return text.replace(/[零一二两三四五六七八九十百]+/g,word=>{let sum=0,current=0;for(const char of word){if(char==='百'||char==='十'){sum+=(current||1)*(char==='百'?100:10);current=0;}else current=digits[char];}return String(sum+current);});}
function parseCommand(raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>120)throw new Error('请输入 1～120 字的指令。');
  const text=chineseNumbers(raw.trim().replace(/\s+/g,'').replace(/[，,。！!]/g,''));
  if(/^(急停|紧急停车|紧急制动|紧急刹车)$/.test(text))return {emergency:true};
  if(/^(刹车|刹车停止|停止|停止移动|停车|停下|停止任务|停止执行)$/.test(text))return {stop:true};
  if(/^(制动测试|刹车测试)$/.test(text))return brakingTest(state.speedLimit,raw);
  let match=text.match(/^(?:加速(?:到|至)?|以)?(\d+(?:\.\d+)?)(?:米每秒|m\/s)(?:(?:然后|后|再)?(?:刹车|制动|停车|制动测试))$/i);
  if(match)return brakingTest(Number(match[1]),raw);
  match=text.match(/^(向前走|前进|行驶|向前|倒车|后退|向后)(\d+(?:\.\d+)?)(?:米|m)$/i);
  if(match){
    const reverse=/倒车|后退|向后/.test(match[1]),distance=Number(match[2]),max=reverse?200:5000;
    if(distance<1||distance>max)throw new Error(`${reverse?'倒车':'前进'}任务支持 1～${max} 米。`);
    return {kind:'drive',gear:reverse?'reverse':'forward',target:reverse?Math.min(state.speedLimit,physics.constants.maxReverseSpeed):state.speedLimit,distance,title:raw,
      labels:[`${reverse?'倒车':'前进'} ${distance} 米（遵守限速）`,'达到里程后制动，仍有移动距离']};
  }
  throw new Error('试试“前进 200 米”“倒车 10 米”或“加速到 30 米每秒然后刹车”。');
}
function brakingTest(target,title){
  if(!Number.isFinite(target)||target<1||target>100)throw new Error('设定速度必须在 1～100 m/s 之间，实际行驶遵守路段限速。');
  return {kind:'brake-test',gear:'forward',target,title,labels:[brakingTargetLabel(target),'达到车速后全力制动；60 秒未达速则结束加速']};
}
function brakingTargetLabel(target){const capped=effectiveTarget(target,'forward');return `加速至 ${capped.toFixed(1)} m/s（${(capped*3.6).toFixed(0)} km/h）${target>capped?' · 已按路段限速调整':''}`;}
function submitCommand(raw){try{const parsed=parseCommand(raw);if(parsed.emergency){emergencyStop();return {status:'braking'};}if(parsed.stop){requestBrake('AI 指令请求常规制动至停止');$('ai-feedback').textContent='已经踩下刹车，速度和实际制动距离仍会继续变化，直至停车。';return {status:'braking'};}if(!available())return {status:'blocked'};if(state.plan?.status==='running')requestBrake('新计划替换旧任务，先开始制动');state.plan={...parsed,status:'ready',phase:0,startDistance:car.distance,brakeStartDistance:0};$('ai-feedback').textContent='请确认计划。行驶遵守路段限速，超速会自动制动；前进 / 倒车切换会先停稳。';$('ai-feedback').classList.remove('error');log(`生成计划：${parsed.title}`);renderPlan();return {status:'ready',steps:parsed.labels};}catch(error){$('ai-feedback').textContent=error.message;$('ai-feedback').classList.add('error');return {status:'error',message:error.message};}}
$('command-form').onsubmit=event=>{event.preventDefault();submitCommand($('command-input').value);};$('command-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submitCommand(event.target.value);}};
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>{$('command-input').value=button.dataset.command;submitCommand(button.dataset.command);});
function startPlan(){if(state.plan?.status!=='ready'||!available())return false;state.controls.clear();state.serviceBrake=0;state.failsafe=false;state.brakeAnchor=null;state.plan.status='running';state.plan.phase=0;state.plan.startDistance=car.distance;state.plan.startTime=car.elapsedTime;state.requestedGear=state.plan.gear;state.shiftPending=car.gear!==state.requestedGear;state.plan.motionStarted=!state.shiftPending;state.speedLimit=state.plan.target;$('speed-slider').value=String(state.speedLimit);$('speed-slider').style.setProperty('--speed-progress',((state.speedLimit-1)/99*100)+'%');log(`AI 开始执行：${state.plan.title}`);renderPlan();render();return true;}
$('task-action').onclick=()=>{if(state.plan?.status==='ready')startPlan();else if(state.plan?.status==='running')requestBrake('停止 AI 任务，持续常规制动');else{state.plan=null;renderPlan();}};
function renderPlan(){const plan=state.plan;$('task-card').hidden=!plan;if(!plan)return;if(plan.kind==='brake-test'&&plan.phase===0)plan.labels[0]=brakingTargetLabel(plan.target);const status={ready:'待确认',running:plan.phase?'制动中':'执行中',completed:'已完成',limited:'未达目标 · 已结束',cancelled:car.speed>.01?(state.lastInput.brake>0?'已取消 · 制动中':'已取消 · 滑行中'):'已取消'};$('task-badge').textContent=status[plan.status];$('task-steps').replaceChildren();plan.labels.forEach((label,index)=>{const li=document.createElement('li'),number=document.createElement('span'),text=document.createElement('span');number.className='step-number';const done=plan.status==='completed'||index<plan.phase;number.textContent=done?'✓':String(index+1);text.textContent=label;li.className=done?'done':plan.status==='running'&&index===plan.phase?'current':'';li.append(number,text);$('task-steps').append(li);});const action=$('task-action');action.replaceChildren();const icon=document.createElement('i'),text=document.createElement('span');icon.dataset.icon=plan.status==='running'?'stop':plan.status==='ready'?'play':'refresh';text.textContent=plan.status==='running'?'取消并制动':plan.status==='ready'?'开始执行':'新的任务';action.append(icon,text);paintIcons(action);}
function updatePlan(){
  const plan=state.plan;if(plan?.status!=='running')return;
  if(!plan.motionStarted){if(car.gear!==plan.gear)return;plan.motionStarted=true;plan.startDistance=car.distance;}
  if(plan.phase===0){
    const target=effectiveTarget(plan.target,plan.gear);
    if(plan.effectiveTarget!==target){plan.effectiveTarget=target;renderPlan();}
    const reached=plan.kind==='brake-test'?Math.abs(car.speed-target)<.01:car.distance-plan.startDistance>=plan.distance;
    if(!reached&&car.elapsedTime-plan.startTime>=60&&(plan.kind==='brake-test'||car.distance-plan.startDistance<1)){
      plan.status='limited';state.serviceBrake=0;state.brakeAnchor=null;
      const message='60 秒内未达到阶段目标，测试已结束；车辆自然滑行，超速时仍会自动限速。可手动接管。';
      log(message);$('ai-feedback').textContent=message;toast('未达到阶段目标，已结束加速');renderPlan();return;
    }
    if(reached){plan.phase=1;plan.brakeStartDistance=car.distance;plan.brakeStartSpeed=car.speed;car.braking=false;state.brakeAnchor=null;log(`达到阶段目标，开始全力制动；初速 ${car.speed.toFixed(2)} m/s`);renderPlan();}
  }else if(car.speed<.0001){
    plan.status='completed';state.serviceBrake=0;log(`AI 制动完成：实际刹车距离 ${(car.lastBrakeDistance||0).toFixed(2)} m`);
    $('ai-feedback').textContent=`已完全停车。实际制动距离 ${(car.lastBrakeDistance||0).toFixed(2)} 米，车辆按物理过程减速。`;toast('测试完成，实际刹车距离已保留');renderPlan();
  }
}
function getInput(){
  const values=[...state.controls.values()],plan=state.plan;
  let throttle=values.includes('throttle')?1:0,brake=values.includes('brake')?.55:state.serviceBrake,steering=laneControl.steeringFor(car,laneCenters[state.laneTarget],{wet:state.wet});
  const gear=plan?.status==='running'?plan.gear:state.requestedGear;
  const target=effectiveTarget(plan?.status==='running'?plan.target:state.speedLimit,gear);
  if(plan?.status==='running'){
    if(plan.phase===1){throttle=0;brake=1;}
    else{throttle=car.speed<=target?1:0;brake=car.speed>target+.12?.35:0;}
  }
  state.shiftPending=gear!==car.gear;
  if(state.shiftPending&&car.speed>0){throttle=0;brake=Math.max(brake,.55);}
  const roadCap=currentRoadCap();
  // Actual deceleration through the same tyre/drag model; never snap speed or
  // latch emergency stop. Held throttle can resume once the legal speed is met.
  if(car.speed>roadCap+.01)state.autoLimitBraking=true;
  else if(car.speed<=roadCap)state.autoLimitBraking=false;
  if(state.autoLimitBraking){throttle=0;brake=Math.max(brake,Math.min(.55,Math.max(.06,(car.speed-roadCap)/8)));}
  if(state.estop||state.failsafe||!state.connected||!cameraReady||car.energyKWh>=51.6){throttle=0;brake=1;}
  if(brake>0)throttle=0;
  return {throttle,brake,steering,targetSpeed:target,gear,wet:state.wet,guardrails:true};
}
function updateLaneState(){
  if(car.x>laneControl.constants.shoulderBoundary&&!state.shoulderAlert&&!state.shoulderRecovery){
    state.shoulderAlert=true;state.laneTarget=3;state.laneChanging=true;
    requestBrake('已进入应急车道，触发全力紧急制动',1,{emergency:true});
    toast('已进入应急车道！紧急制动中，请等待停稳');
  }
  if(state.laneChanging&&laneControl.isCentered(car,laneCenters[state.laneTarget])){
    state.laneChanging=false;state.adviceCooldownUntil=car.elapsedTime+5;log(`已到达${laneName(state.laneTarget)}中央，自动保持居中`);
    if(state.shoulderRecovery){state.shoulderRecovery=false;state.shoulderAlert=false;log('已返回正常车道，应急车道警报解除');}
  }
}
function advance(dt){
  updateLaneState();updatePlan();
  const input=getInput();state.lastInput=input;
  // Limit braking ends at the legal speed, so it has no fixed parking line.
  // Keep the live full-stop prediction and avoid integrating a new stop on
  // every proportional-controller substep.
  if(state.autoLimitBraking&&!state.shiftPending&&input.brake<1)state.brakeAnchor=null;
  else if(input.brake>0&&car.speed>0&&(!car.braking||state.brakeAnchor?.pressure!==input.brake)){
    state.brakeAnchor={x:car.x,y:car.y,heading:motionHeading(),pressure:input.brake,distance:physics.estimateBrakingDistance(car.speed,{wet:state.wet,brake:input.brake})};
  }else if(input.brake===0&&car.braking)state.brakeAnchor=null;
  const previousPose={...car},wasBraking=car.braking,contacts=car.wallContactCount;
  traffic.step(trafficWorld,car,dt);
  physics.step(car,input,dt);
  state.shiftPending=state.requestedGear!==car.gear;
  if(previousPose.gear!==car.gear){state.brakeAnchor=null;log(`已停稳换入${car.gear==='reverse'?'倒车 R':'前进 D'}挡`);}
  const contact=traffic.resolveContact(trafficWorld,car,previousPose);
  if(car.wallContactCount>contacts){
    state.brakeAnchor=null;
    log('擦碰护栏：碰撞与摩擦使车速略降，可继续给油或转向离开');
  }
  if(contact){
    car.acceleration=(car.speed-previousPose.speed)/dt;
    state.brakeAnchor=null;
    state.contactUntil=performance.now()+1000;
    if(performance.now()-state.lastContactNotice>1500){
      state.lastContactNotice=performance.now();
      log('车辆发生接触，碰撞损失动能；驾驶控制保持可用');
    }
  }
  updateLaneState();
  const prev=state.trail[state.trail.length-1];
  if(Math.hypot(car.x-prev[0],car.y-prev[1])>.5){state.trail.push([car.x,car.y]);if(state.trail.length>1500)state.trail.splice(1,1);}
  if(wasBraking&&!car.braking&&car.speed===0){log(`车辆已停稳，制动距离 ${(car.lastBrakeDistance||0).toFixed(2)} m`);if(!state.estop&&!state.failsafe)state.serviceBrake=0;renderPlan();}
  updatePlan();
}
function advanceElapsed(elapsed,background=false){let remaining=Math.max(0,elapsed);while(remaining>0){const step=Math.min(remaining,1/120);advance(step);remaining-=step;if(background&&car.speed===0)break;}}
function openSheet(id){requestBrake('打开信息面板，开始常规制动');$(id).showModal();}
$('device-button').onclick=()=>openSheet('device-dialog');$('log-button').onclick=()=>openSheet('log-dialog');document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());document.querySelectorAll('dialog').forEach(dialog=>dialog.onclick=event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
$('toggle-connection').onclick=()=>{state.connected=!state.connected;failSafe(state.connected?'连接已恢复，车辆继续制动至停止':'模拟连接断开，触发全力制动');camera?.pause();render();};
function resetSession(){state.laneAdvice=null;state.adviceCooldownUntil=0;const keepLocked=state.estop;car=physics.createState();trafficWorld=traffic.createState(car,{density:state.trafficDensity});Object.assign(state,{estop:keepLocked,requestedGear:'forward',autoLimitBraking:false,shiftPending:false,laneTarget:1,laneChanging:false,shoulderAlert:false,shoulderRecovery:false,serviceBrake:0,failsafe:false,plan:null,trail:[[0,0]],logs:[],started:performance.now(),brakeAnchor:null,contactUntil:0,lastContactNotice:-Infinity,trafficInfo:null});state.controls.clear();$('command-input').value='';$('ai-feedback').textContent='支持前进、倒车与制动测试；超速自动减速到路段限速。';$('ai-feedback').classList.remove('error');log('模拟已重置，车辆回到起点');renderPlan();render();}
$('reset-session').onclick=()=>{resetSession();$('device-dialog').close();};
$('view-switch').onclick=()=>{state.map=!state.map;camera?.pause();$('map-view').hidden=!state.map;$('view-title').textContent=state.map?'行驶轨迹':'高速公路 · 驾驶视角';$('view-switch').querySelector('span').textContent=state.map?'画面':'轨迹';$('view-switch').setAttribute('aria-label',state.map?'切换到驾驶画面':'切换到行驶轨迹');render();};
function toggleExpand(force){const expanded=force??!$('camera-panel').classList.contains('expanded');$('camera-panel').classList.toggle('expanded',expanded);$('expand-button').setAttribute('aria-label',expanded?'缩小画面':'放大画面');$('expand-button').setAttribute('aria-expanded',String(expanded));document.body.style.overflow=expanded?'hidden':'';}
$('expand-button').onclick=()=>toggleExpand();
function render(){const moving=car.speed>.01,braking=state.lastInput.brake>0&&moving;state.predicted=physics.estimateBrakingDistance(car.speed,{wet:state.wet,brake:1});$('speed-value').textContent=car.speed.toFixed(1);$('speed-kmh').textContent=(car.speed*3.6).toFixed(1)+' km/h';$('predicted-brake').textContent=state.predicted.toFixed(1);$('actual-brake').textContent=car.braking?car.brakeDistance.toFixed(1):car.lastBrakeDistance===null?'—':car.lastBrakeDistance.toFixed(1);$('actual-brake-label').textContent=car.braking?'正在制动':'上次制动';$('brake-result-label').textContent=car.braking?'距离正在累计':'停车后保留实测结果';$('braking-hud').hidden=!braking;$('braking-hud-distance').textContent=car.brakeDistance.toFixed(1)+' m';$('braking-hud-label').textContent=state.estop?'紧急制动':state.shiftPending?'换挡制动':state.autoLimitBraking?'限速自动制动':state.lastInput.brake>=1?'全力制动':'常规制动';$('speed-limit-label').textContent=String(state.speedLimit);$('target-kmh').textContent=(state.speedLimit*3.6).toFixed(0)+' km/h';$('odometer-live').textContent=car.distance.toFixed(1)+' m';$('distance-value').textContent=car.distance.toFixed(1);$('map-distance').textContent=car.distance.toFixed(1)+' m';$('heading-live').textContent=(Math.round(car.heading)%360)+'°';$('acceleration-live').textContent=car.acceleration.toFixed(2)+' m/s²';$('position-text').textContent=`X ${car.x.toFixed(1)} · Y ${car.y.toFixed(1)} m`;$('heading-text').textContent=String(Math.round(car.heading)%360).padStart(3,'0')+'°';$('steering-angle').textContent=(car.steer*180/Math.PI).toFixed(1)+'°';$('steering-indicator').style.transform=`rotate(${car.steer*180/Math.PI*3}deg)`;
  const touchingWall=!!car.wallContact&&moving,touchingTraffic=performance.now()<state.contactUntil;
  const drivingLabel=state.shoulderAlert?(state.estop?(moving?'应急车道 · 紧急制动':'应急车道 · 已停稳锁定'):(moving?'正在返回右车道':'返回右车道 · 按油门继续')):state.laneChanging?(moving?`正在变道至${laneName(state.laneTarget)}`:`待起步 → ${laneName(state.laneTarget)}`):state.shiftPending&&moving?'减速至停稳 · 准备换挡':state.autoLimitBraking&&braking?'超速自动制动 · 降至限速':braking?'正在制动，车辆仍在移动':touchingWall?'沿护栏擦行 · 摩擦减速':touchingTraffic?'车辆接触 · 控制仍可用':moving?(car.gear==='reverse'?(state.lastInput.throttle?'正在倒车':'倒车惯性滑行'):(state.lastInput.throttle?'正在加速 / 巡航':'松开油门，惯性滑行')):'车辆已停稳';$('camera-mode').textContent=(state.plan?.status==='running'?'AI 试驾':'手动驾驶')+' · '+(car.gear==='reverse'?'R 倒车':'D 前进')+' · '+(state.wet?'湿滑路面':'干燥路面');$('camera-status').textContent=drivingLabel;$('safety-title').textContent=state.shoulderAlert?drivingLabel:state.estop?(moving?'紧急制动中':'已停稳 · 制动锁定'):drivingLabel;$('safety-description').textContent=state.shoulderAlert?(state.estop?(moving?`已制动 ${car.brakeDistance.toFixed(1)} m`:'停稳后可解除，返回右车道'):(moving?'自动回正居中，到达后解除警报':'按住油门，自动返回右车道')):state.estop?(moving?`已制动 ${car.brakeDistance.toFixed(1)} m`:'解除后不会自动行驶'):moving?`${car.speed.toFixed(1)} m/s · ${braking?'持续减速':'注意刹车距离'}`:'按住油门开始驾驶';document.querySelector('.safety-bar').classList.toggle('stopped',state.estop);$('emergency-stop').hidden=state.estop;$('reset-estop').hidden=!state.estop;$('reset-estop').disabled=moving;$('reset-estop').textContent=moving?'制动中，等待停稳':state.shoulderAlert?'解除并返回右车道':'解除制动锁定';$('connection-dot').classList.toggle('offline',!state.connected);$('connection-label').textContent=state.connected?'模拟连接正常':'失联，自动制动';$('camera-offline').hidden=state.connected;$('device-status').textContent=state.connected?'模拟连接正常':'已断开，制动中';$('toggle-connection').textContent=state.connected?'断开模拟连接':'恢复模拟连接';$('dry-road').classList.toggle('selected',!state.wet);$('dry-road').setAttribute('aria-pressed',String(!state.wet));$('wet-road').classList.toggle('selected',state.wet);$('wet-road').setAttribute('aria-pressed',String(state.wet));$('dry-road').disabled=car.braking;$('wet-road').disabled=car.braking;$('grip-value').textContent=state.wet?'μ 0.45':'μ 0.85';$('device-grip').textContent=state.wet?'0.45（湿滑）':'0.85（干燥）';$('device-rtt').textContent=location.protocol==='file:'?'本地文件 · 无网络请求':state.latency===null?'未测量 / 不可达':state.latency.toFixed(1)+' ms';$('device-power').textContent=Math.max(0,86-car.energyKWh/60*100).toFixed(1)+'% / '+((car.powerW||0)/1000).toFixed(1)+' kW';
  const road=state.trafficInfo=traffic.getSnapshot(trafficWorld,car),speedKmh=car.speed*3.6,overspeed=speedKmh>road.speedLimitKmh+.05;
  $('road-limit-sign').textContent=String(road.speedLimitKmh);
  $('road-limit-sign').setAttribute('aria-label',`道路限速${road.speedLimitKmh}公里每小时`);
  $('road-speed-status').textContent=state.autoLimitBraking?'自动制动至 '+road.speedLimitKmh+' km/h':'限速保护已开启';
  const travelDirection=Math.cos(motionHeading()*Math.PI/180)>=0?1:-1;
  const nextSign=road.roadSigns.filter(sign=>sign.y%traffic.constants.zoneLength===0&&(sign.y-car.y)*travelDirection>=0&&traffic.limitAt(sign.y+travelDirection*.01)!==road.speedLimitKmh).sort((a,b)=>(a.y-b.y)*travelDirection)[0];
  const nextLimit=nextSign?traffic.limitAt(nextSign.y+travelDirection*.01):null;
  $('next-road-limit').textContent=nextSign?`${car.gear==='reverse'?'倒车方向':'前方'} ${Math.ceil(Math.abs(nextSign.y-car.y))} m · 限速 ${nextLimit}`:'超速自动制动 · 达标后释放';
  const reverse=car.gear==='reverse',ahead=reverse?road.nearestBehind:road.nearestAhead,close=!!ahead&&ahead.distance<Math.max(10,car.speed*1.5);
  $('traffic-direction-label').textContent=reverse?'同车道后车':'同车道前车';
  $('traffic-gap').textContent=ahead?`${Math.max(0,ahead.distance).toFixed(0)} m`:reverse?'后方畅通':'前方畅通';
  $('traffic-status').textContent=ahead?`${close?'车距偏近 · ':''}${reverse?'后车':'前车'} ${ahead.speedKmh.toFixed(0)} km/h`:'同向 / 对向车流运行中';
  document.querySelector('.road-awareness').classList.toggle('overspeed',overspeed);
  document.querySelector('.road-awareness').classList.toggle('auto-braking',state.autoLimitBraking);
  const max=state.requestedGear==='reverse'?physics.constants.maxReverseSpeed:100,shownTarget=Math.min(state.speedLimit,max);
  $('speed-slider').max=String(max);$('speed-slider').value=String(shownTarget);$('speed-slider').setAttribute('aria-label',`目标速度，最高${max}米每秒`);
  $('speed-slider').style.setProperty('--speed-progress',((shownTarget-1)/(max-1)*100)+'%');
  $('speed-limit-label').textContent=String(shownTarget);$('target-kmh').textContent=(shownTarget*3.6).toFixed(0)+' km/h';
  $('effective-speed-note').textContent=`实际目标 ${(effectiveTarget(state.speedLimit)*3.6).toFixed(0)} km/h · ${state.requestedGear==='reverse'?'倒车限速':'遵守路段限速'}`;
  $('gear-status').textContent=state.shiftPending?'减速换挡中':reverse?'R · 倒车':'D · 前进';
  $('gear-hint').textContent=state.shiftPending?'先停稳再换向，油门在换挡期间暂停':reverse?'倒车上限 5 m/s · 画面朝后，按住油门倒车':'换挡时先减速至停稳，再切换行驶方向';
  $('throttle-hint').textContent=state.requestedGear==='reverse'?'按住倒车':'按住前进';
  for(const gear of ['forward','reverse']){const button=$('gear-'+gear),selected=state.requestedGear===gear;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=state.estop||!state.connected||!cameraReady;}
  document.querySelector('.gear-control').classList.toggle('shifting',state.shiftPending);
  for(const button of document.querySelectorAll('[data-density]')){const selected=button.dataset.density===state.trafficDensity;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
  $('traffic-density-note').textContent=`${traffic.densityPresets[state.trafficDensity].label} · ${road.vehicleCount} 辆模拟车`;
  $('view-title').textContent=state.map?'行驶轨迹':reverse?'高速公路 · 倒车视角':'高速公路 · 驾驶视角';
  $('camera-panel').classList.toggle('reversing',reverse);
  $('lane-status').textContent=laneName(state.laneTarget)+(state.estop&&state.shoulderAlert?(moving?' · 制动中':' · 制动锁定'):state.laneChanging?(moving?' · 变道中':' · 待起步'):' · 已居中');
  $('lane-hint').textContent=state.shoulderAlert?(state.estop?'应急车道已触发急刹，停稳后解除并返回右车道':(moving?'正在自动返回右车道，到达中央后警报解除':'已选择返回右车道，重新按住油门驶回')):state.laneChanging?'自动移至目标车道中央，完成后可再次点按':state.laneTarget===2?'继续向右将进入应急车道，并触发紧急制动':car.gear==='reverse'?'倒车时左右仍按道路方向选择，自动移至车道中央':'每次点按切换相邻车道，松手后自动完成变道';
  document.querySelector('.highway-steering').classList.toggle('changing',state.laneChanging);
  for(const button of document.querySelectorAll('[data-lane-change]')){
    button.disabled=state.estop||!state.connected||!cameraReady;
    button.classList.toggle('shoulder-next',button.dataset.laneChange==='1'&&state.laneTarget===2);
  }
  renderLaneAdvice();
  $('shoulder-alert').hidden=!state.shoulderAlert;
  $('shoulder-alert-title').textContent=state.estop?(moving?'已进入应急车道 · 紧急制动':'应急车道 · 已停稳，制动锁定'):(moving?'正在返回右车道':'返回右车道 · 等待驾驶操作');
  $('shoulder-alert-detail').textContent=state.estop?(moving?'正在全力减速，仍有制动距离。请等待车辆停稳。':'点击底部“解除并返回右车道”，再按住油门驶回。'):(moving?'正在自动驶回并回正，到达右车道中央后警报解除。':'已选择右车道，按住油门自动驶回；到达中央后警报解除。');
  $('camera-panel').classList.toggle('shoulder-emergency',state.shoulderAlert);
  document.querySelector('.road-awareness').classList.toggle('contact',touchingWall||touchingTraffic);
  document.querySelector('.traffic-awareness').classList.toggle('close',close);
  $('camera-panel').classList.toggle('wall-contact',touchingWall||touchingTraffic);
  for(const button of document.querySelectorAll('[data-drive]')){button.classList.toggle('active',[...state.controls.values()].includes(button.dataset.drive));button.disabled=state.estop||!state.connected||!cameraReady;}const fps=state.connected&&!state.map?camera?.stats.fps:0;$('frame-rate').textContent=state.connected?`${fps||'—'} FPS`:'PAUSED';$('device-fps').textContent=fps?`${fps} FPS · ${camera.stats.backend}`:'画面暂停 / 测量中';const seconds=Math.floor((performance.now()-state.started)/1000);$('session-clock').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');if(state.plan){$('task-action').disabled=state.plan.status==='ready'&&(state.estop||!state.connected||!cameraReady);let progress=state.plan.status==='completed'?1:state.plan.status==='running'&&!state.plan.motionStarted?0:state.plan.phase? .5+.5*(1-car.speed/Math.max(1,car.brakeStartSpeed)):state.plan.kind==='brake-test'?.5*Math.min(1,car.speed/effectiveTarget(state.plan.target,state.plan.gear)):.5*Math.min(1,(car.distance-state.plan.startDistance)/state.plan.distance);$('task-progress-fill').style.width=Math.max(0,Math.min(100,progress*100))+'%';}
  if(state.map){const scale=.5,latest=car.y;const originY=260+latest*scale;$('map-origin').setAttribute('transform',`translate(320 ${originY})`);$('map-origin').style.display=originY>=0&&originY<=330?'':'none';$('route-trail').setAttribute('points',state.trail.filter(p=>p[1]>latest-480&&p[1]<latest+160).map(([x,y])=>`${320+x*8},${260-(y-latest)*scale}`).join(' '));$('map-rover').setAttribute('transform',`translate(${320+car.x*8} 260) rotate(${car.heading})`);}
}
function tick(now){if(!document.hidden){const elapsed=(now-lastFrame)/1000;lastFrame=now;if(elapsed>.5){if(car.speed>.01||state.controls.size||state.plan?.status==='running')failSafe('画面发生长时间停顿，自动接管制动');camera?.pause();}advanceElapsed(Math.min(Math.max(0,elapsed),60));const interval=1000/30;if(cameraReady&&state.connected&&!state.map&&now-lastCameraFrame>=interval){lastCameraFrame=now-((now-lastCameraFrame)%interval);const pose={...car,emergencyLaneAlert:state.shoulderAlert,wet:state.wet,brakePrediction:state.predicted,brakeAnchor:state.brakeAnchor,traffic:trafficWorld.vehicles,roadSigns:traffic.signsAround(car.y)};if(camera.draw(pose,now)){$('camera-canvas').dataset.frame=String(camera.stats.frames);const seconds=(now-state.started)/1000;$('camera-live-clock').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+(seconds%60).toFixed(1).padStart(4,'0');}}if(now-lastRender>100){render();lastRender=now;}}requestAnimationFrame(tick);}
try{camera=window.RoverSimulator.createCamera($('camera-canvas'));cameraReady=true;}catch(error){$('camera-error').hidden=false;console.error(error);}
window.addEventListener('rover-camera-lost',()=>{cameraReady=false;failSafe('画面丢失，继续全力制动');$('camera-error').hidden=false;});
async function probeLocalService(){if(location.protocol==='file:')return;if(document.hidden){setTimeout(probeLocalService,2000);return;}const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000),started=performance.now();try{const response=await fetch('./health.json?t='+Math.floor(started),{method:'HEAD',cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error();state.latency=performance.now()-started;}catch{state.latency=null;}finally{clearTimeout(timer);setTimeout(probeLocalService,2000);}}
function readState(){const road=traffic.getSnapshot(trafficWorld,car);return {laneRecommendation:getLaneAdvice(),laneTarget:state.laneTarget,laneTargetName:laneName(state.laneTarget),laneChanging:state.laneChanging,emergencyLaneAlert:state.shoulderAlert,returningFromEmergencyLane:state.shoulderRecovery,gear:car.gear,requestedGear:state.requestedGear,signedSpeed:car.speed*(car.gear==='reverse'?-1:1),trafficDensity:state.trafficDensity,automaticSpeedLimit:true,autoLimitBraking:state.autoLimitBraking,effectiveTargetSpeed:effectiveTarget(state.speedLimit),roadLimitKmh:road.speedLimitKmh,overspeed:car.speed*3.6>road.speedLimitKmh+.05,trafficCount:road.vehicles.length,nearestAhead:road.nearestAhead,nearestBehind:road.nearestBehind,wallContact:car.wallContact,simulation:true,scenario:'highway',model:'simplified vehicle dynamics',connected:state.connected,emergencyBrake:state.estop,speed:car.speed,maxSpeed:100,targetSpeed:state.speedLimit,acceleration:car.acceleration,position:{x:car.x,y:car.y,heading:car.heading},distance:car.distance,braking:car.braking,brakeDistance:car.brakeDistance,lastBrakeDistance:car.lastBrakeDistance,predictedBrakingDistance:state.predicted,wet:state.wet,taskStatus:state.plan?.status||'none',cameraFps:camera?.stats.fps||0,localLatencyMs:state.latency};}
if(document.modelContext?.registerTool){const lifecycle=new AbortController();const definitions=[{name:'change_rover_simulation_lane',title:'切换模拟车辆车道',description:'Request one adjacent lane through the same controls as the left/right buttons. Left/right refer to the road. Entering the right emergency shoulder triggers physical emergency braking.',inputSchema:{type:'object',properties:{direction:{type:'string',enum:['left','right']}},required:['direction'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||!['left','right'].includes(input.direction))throw new Error('direction required');const accepted=requestLaneChange(input.direction==='left'?-1:1);if(accepted)switchMode('manual');return {accepted,...readState()};}},{name:'read_rover_simulation',title:'查看车辆物理模拟状态',description:'Read local highway physics, actual speed and physical braking distance. No real hardware.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:readState},{name:'stage_rover_simulation_command',title:'准备高速模拟任务',description:'Stage a local highway simulation plan for confirmation. Brake commands apply deceleration immediately; they do not teleport speed to zero.',inputSchema:{type:'object',properties:{command:{type:'string',minLength:1,maxLength:120}},required:['command'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||typeof input.command!=='string')throw new Error('command required');switchMode('ai');$('command-input').value=input.command;return submitCommand(input.command);}},{name:'emergency_stop_rover_simulation',title:'全力制动模拟车辆',description:'Latch full emergency brakes in the local simulation. Speed decreases physically over a nonzero braking distance. Does not immediately stop or control real hardware.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false},execute(){emergencyStop();return readState();}}];for(const tool of definitions){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}
log('车道辅助已就绪：左右点按自动变道居中，进入应急车道会紧急制动');render();requestAnimationFrame(tick);probeLocalService();
