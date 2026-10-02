'use strict';
const icons={settings:'<path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3Z" transform="translate(1 2)"/><circle cx="12" cy="11" r="3"/>',camera:'<path d="M14 4h-4L8 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4Z"/><circle cx="12" cy="13" r="3"/>',route:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h8"/>',expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',battery:'<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4m-16-3v2m4-2v2m4-2v2"/>',gauge:'<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1"/>',signal:'<path d="M3 19v-3m6 3v-7m6 7V8m6 11V4"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',gamepad:'<path d="M7 7h10a4 4 0 0 1 4 3l1 7a2 2 0 0 1-3 2l-4-3H9l-4 3a2 2 0 0 1-3-2l1-7a4 4 0 0 1 4-3Z"/><path d="M6 11h4m-2-2v4m8-2h.1m2 2h.1"/>',sparkles:'<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 2v4m-2-2h4"/>','chevron-right':'<path d="m9 5 7 7-7 7"/>','chevron-left':'<path d="m15 5-7 7 7 7"/>','chevron-up':'<path d="m5 15 7-7 7 7"/>','chevron-down':'<path d="m5 9 7 7 7-7"/>','arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>','arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>','turn-left':'<path d="m9 3-6 6 6 6M3 9h10a7 7 0 0 1 7 7v5"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',play:'<path d="m8 4 12 8-12 8Z"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-5"/>',octagon:'<path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6Z"/><path d="M9 9h6v6H9Z"/>',refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',x:'<path d="m6 6 12 12M6 18 18 6"/>','wifi-off':'<path d="m3 3 18 18M2 8a16 16 0 0 1 4-2m4-1a16 16 0 0 1 12 3M5 12a11 11 0 0 1 5-2m5 1 4 1M8 16a6 6 0 0 1 8 0m-4 4h.01"/>'};
function paintIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[el.dataset.icon]||icons.info}</svg>`;});}
icons.horn='<path d="M3 9h4l6-5v16l-6-5H3Z"/><path d="M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>';
paintIcons();
const $=id=>document.getElementById(id);
const physics=window.RoverPhysics;
const traffic=window.RoverTraffic;
const laneControl=window.RoverLaneControl;
const roadModel=window.RoverRoad;
const commands=window.RoverCommands;
const autopilot=window.RoverAutopilot;
const laneCenters=[...laneControl.constants.laneCenters,laneControl.constants.shoulderCenter];
const laneName=index=>['左车道','中间车道','右车道','应急车道'][index];
let car=physics.createState();
let trafficWorld=traffic.createState(car,{density:'medium'});
const state={connected:true,mode:'manual',speedLimit:30,requestedGear:'forward',trafficDensity:'medium',autoLimitBraking:false,shiftPending:false,laneTarget:1,laneChanging:false,shoulderAlert:false,shoulderRecovery:false,wet:false,estop:false,serviceBrake:0,failsafe:false,plan:null,controls:new Map(),logs:[],trail:[[0,0]],latency:null,map:false,started:performance.now(),brakeAnchor:null,contactUntil:0,lastContactNotice:-Infinity,trafficInfo:null,lastInput:{throttle:0,brake:0,steering:0},predicted:0,pausedAt:null};
let camera=null,cameraReady=false,lastFrame=performance.now(),lastRender=0,lastCameraFrame=0,toastTimer;
state.laneAdvice=null;state.adviceCooldownUntil=0;
state.exitActive=null;state.exitCompleted=false;state.exitCruise=false;
state.autodrive={active:false,route:'cruise',decision:null,nextLaneCheck:0,reason:'选择行程后点击启动，车辆将自动控制油门和刹车。'};
state.horn={lastAt:-Infinity,count:0,status:'idle',reason:'前车会在允许变道且车距安全时避让。',vehicleId:null,targetLane:null,vehicle:null};
state.collision=null;
state.collisionEffect=null;
let collisionFramePending=false;
let hornAudio=null;
const driveNames={throttle:'油门',brake:'刹车',left:'左转向',right:'右转向'};
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3000);}
function log(message){state.logs.unshift({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),message});state.logs=state.logs.slice(0,80);renderLogs();}
function renderLogs(){const list=$('activity-log');list.replaceChildren();for(const entry of state.logs){const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');time.textContent=entry.time;text.textContent=entry.message;li.append(time,text);list.append(li);}}
function collisionAnimating(){return !!state.collisionEffect&&state.collisionEffect.elapsed<state.collisionEffect.duration;}
function finishCollisionAnimation({draw=true}={}){
  if(!state.collision)return;
  if(state.collisionEffect)state.collisionEffect.elapsed=state.collisionEffect.duration;
  // Render the settled pose before opening the modal. Failed or hidden cameras
  // must still leave a working restart path, with no deferred timer to leak.
  if(draw&&cameraReady&&state.connected&&!document.hidden){try{drawCameraFrame(performance.now());}catch{}}
  collisionFramePending=false;camera?.pause();render();
  if(!$('collision-dialog').open)$('collision-dialog').showModal();
}
function advanceCollisionAnimation(elapsed,background=false){
  if(!collisionAnimating())return;
  if(background||document.hidden||!cameraReady||!state.connected){finishCollisionAnimation({draw:false});return;}
  state.collisionEffect.elapsed=Math.min(state.collisionEffect.duration,state.collisionEffect.elapsed+Math.max(0,elapsed));
  collisionFramePending=true;
  if(!collisionAnimating())finishCollisionAnimation();
}
function finishWithCollision(kind,previousPose,contact=null){
  if(state.collision)return;
  const label=kind==='vehicle'?'与其他车辆发生碰撞':'与护栏发生碰撞';
  state.collision={kind,label,vehicleId:contact?.vehicleId??null,speed:previousPose.speed,
    distance:car.distance,elapsedTime:car.elapsedTime,sessionSeconds:(performance.now()-state.started)/1000};
  const impact=kind==='guardrail'?Math.abs(previousPose.speed*Math.sin(previousPose.heading*Math.PI/180)):Math.max(0,contact?.relativeSpeed||0);
  // Every impact lifts the entire car clearly above the road. Impact speed
  // adds height within a fixed visual envelope instead of an unbounded launch.
  const strength=Math.min(1,impact/24),peakHeight=1.8+2*strength;
  const flightTime=2*Math.sqrt(2*peakHeight/9.81);
  // Keep a bounded portion of the pre-impact momentum. Horizontal motion
  // continues through flight, then friction brings the wreck to rest.
  const launchSpeed=Math.min(18,previousPose.speed*(kind==='guardrail'?.75:.55));
  const travelHeading=previousPose.heading+(previousPose.gear==='reverse'?180:0);
  const slideTime=Math.max(.35,Math.min(1.7,launchSpeed*.65/7)),smokeDwell=1.2;
  const reducedMotion=!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const other=trafficWorld.vehicles.find(vehicle=>vehicle.id===contact?.vehicleId);
  const side=kind==='guardrail'?(car.x<0?1:-1):(other&&other.x!==car.x?Math.sign(car.x-other.x):1);
  state.collisionEffect={elapsed:0,duration:reducedMotion?0:flightTime+slideTime+smokeDwell,flightTime,peakHeight,
    launchSpeed,travelHeading,slideTime,smokeDwell,contactVehicleId:contact?.vehicleId??null,
    impactEnd:previousPose.gear==='reverse'?'rear':'front',
    pitchDeg:(car.gear==='reverse'?-1:1)*(kind==='guardrail'?2+3*strength:3+8*strength),
    rollDeg:side*(kind==='guardrail'?3+5*strength:1.5+3*strength),reducedMotion};
  // Preserve the collision solver's final pose and speed. Pausing the round
  // is separate from physical braking and must freeze NPCs as well as ego.
  state.controls.clear();cancelPlan('发生碰撞，本次驾驶已结束');
  state.serviceBrake=0;state.lastInput={throttle:0,brake:0,steering:0};state.brakeAnchor=null;
  state.autoLimitBraking=false;state.shiftPending=false;
  if(['yielding','waiting','returning'].includes(state.horn.status)){
    state.horn.status='cancelled';state.horn.reason='本次驾驶已结束，避让已暂停。';
  }
  state.trail.push([car.x,car.y]);
  clearTimeout(toastTimer);$('toast').classList.remove('visible');$('toast').textContent='';
  log(label+'，本次驾驶已结束');
  for(const dialog of document.querySelectorAll('.sheet'))if(dialog.open)dialog.close();
  state.map=false;$('map-view').hidden=true;
  const viewLabel=$('view-switch').querySelector('span');if(viewLabel)viewLabel.textContent='轨迹';
  $('view-switch').setAttribute('aria-label','切换到行驶轨迹');
  $('camera-panel').scrollIntoView({block:'nearest',behavior:'instant'});
  collisionFramePending=true;camera?.pause();renderPlan();render();
  if(reducedMotion||document.hidden||!cameraReady||!state.connected)finishCollisionAnimation();
}
function restartCollision(){
  if(!state.collision)return false;
  resetSession({clearEmergency:true});
  $(state.mode+'-tab').focus();return true;
}
$('collision-restart').onclick=restartCollision;
$('collision-replay').onclick=()=>{
  if(!state.collision||!state.collisionEffect||state.collisionEffect.reducedMotion||!cameraReady||!state.connected||document.hidden)return;
  state.collisionEffect.elapsed=0;collisionFramePending=true;lastFrame=performance.now();lastCameraFrame=0;
  $('collision-dialog').close();camera?.pause();render();
};
$('collision-restart').onkeydown=event=>{
  if(['Enter',' '].includes(event.key)){event.preventDefault();if(!event.repeat)restartCollision();}
};
$('collision-dialog').oncancel=event=>event.preventDefault();
$('collision-dialog').onclose=()=>{if(state.collision&&!collisionAnimating()&&!$('collision-dialog').open)$('collision-dialog').showModal();};
function renderCollision(){
  const collision=state.collision;
  $('camera-panel').classList.toggle('collision-ended',!!collision);
  $('camera-panel').classList.toggle('collision-animating',collisionAnimating());
  if(!collision)return;
  $('collision-detail').textContent=collision.label+'。画面和车流已暂停，可以重新开始一局。';
  $('collision-speed').textContent=(collision.speed*3.6).toFixed(1)+' km/h';
  $('collision-distance').textContent=collision.distance.toFixed(1)+' m';
  $('collision-replay').hidden=!!state.collisionEffect?.reducedMotion||!cameraReady||!state.connected;
  $('view-title').textContent=collisionAnimating()?'碰撞动画 · 车外视角':'碰撞现场 · 车外视角';
  const effect=state.collisionEffect;
  const collisionPhase=effect.elapsed<effect.flightTime?'碰撞 · 腾空前冲':
    effect.elapsed<effect.flightTime+effect.slideTime?'碰撞 · 落地滑行':'碰撞 · 车辆受损冒烟';
  $('camera-status').textContent=collisionAnimating()?collisionPhase:'车辆受损 · 本局结束';
  $('camera-live-clock').textContent=collisionAnimating()?'碰撞动画':'碰撞暂停';
  $('safety-title').textContent='发生碰撞 · 已暂停';
  $('safety-description').textContent=collisionAnimating()?'碰撞过程结束后可重新开始':'点击重新开始，返回起点';
  $('lane-status').textContent='本局结束 · 已暂停';$('lane-hint').textContent='重新开始后返回中间车道，再启动驾驶。';
  $('braking-hud').hidden=true;
  $('actual-brake-label').textContent=car.braking?'碰撞时制动':'上次制动';$('brake-result-label').textContent='本局已结束 · 数值已冻结';
  $('frame-rate').textContent=collisionAnimating()?'碰撞动画':'PAUSED';$('device-fps').textContent=collisionAnimating()?'碰撞动画':'碰撞暂停';
}
function playHorn(){
  // Audio is created only by a deliberate press. The visual/simulation action
  // stays usable when a browser has no audio support or blocks playback.
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  if(!AudioContext)return;
  try{
    if(!hornAudio||hornAudio.state==='closed')hornAudio=new AudioContext();
    const context=hornAudio;
    const sound=()=>{
      if(context.state!=='running')return;
      const start=context.currentTime,gain=context.createGain();
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.075,start+.02);
      gain.gain.setValueAtTime(.075,start+.22);gain.gain.linearRampToValueAtTime(0,start+.32);
      gain.connect(context.destination);
      let remaining=2;
      for(const frequency of [350,440]){
        const tone=context.createOscillator();tone.type='triangle';tone.frequency.value=frequency;tone.connect(gain);
        tone.onended=()=>{tone.disconnect();if(--remaining===0)gain.disconnect();};
        tone.start(start);tone.stop(start+.34);
      }
    };
    if(context.state==='suspended')Promise.resolve(context.resume()).then(()=>{if(!document.hidden)sound();}).catch(()=>{});
    else sound();
  }catch{/* Sound is optional; traffic behaviour must remain available. */}
}
function pressHorn(){
  if(state.collision||!state.connected||!cameraReady||document.hidden||car.energyKWh>=51.6)return false;
  if(car.elapsedTime-state.horn.lastAt<1.2)return false;
  state.horn.lastAt=car.elapsedTime;state.horn.count++;playHorn();
  const result=traffic.requestYield(trafficWorld,car,{wet:state.wet,roadType:currentRoadType(),canChangeLane:roadModel.canChangeLane});
  const tracking=trafficWorld.vehicles.includes(state.horn.vehicle)&&state.horn.vehicle?.laneChange;
  // A second beep can be declined while the first car is still moving. Keep
  // observing that car so waiting, returning and completion remain visible.
  if(result.status==='yielding'||!tracking)Object.assign(state.horn,{status:result.status,reason:result.reason,vehicleId:result.vehicleId??null,targetLane:result.targetLane??null,vehicle:trafficWorld.vehicles.find(item=>item.id===result.vehicleId)||null});
  log('鸣笛：'+result.reason);toast(result.reason);render();return result;
}
$('horn-button').onclick=pressHorn;
$('horn-button').onkeydown=event=>{
  if(['Enter',' '].includes(event.key)){event.preventDefault();if(!event.repeat)pressHorn();}
};
function renderHorn(){
  const horn=state.horn,vehicle=trafficWorld.vehicles.includes(horn.vehicle)?horn.vehicle:null;
  if(['yielding','waiting','returning'].includes(horn.status)){
    if(!vehicle?.laneChange){
      horn.status=vehicle?.lane===horn.targetLane?'completed':'cancelled';
      horn.reason=horn.status==='completed'?'前车已完成避让，请继续保持安全车距。':'路况已变化，前车取消避让，请保持安全车距。';
    }else{
      horn.status=vehicle.laneChange.status==='waiting'?'waiting':vehicle.laneChange.returning?'returning':'yielding';
      horn.reason=horn.status==='waiting'?'前车正在等待安全间隙，暂缓避让。':horn.status==='returning'?'目标车道出现风险，前车正在返回原车道。':`前车收到鸣笛，正在向${horn.targetLane>vehicle.laneChange.fromLane?'右':'左'}安全避让`;
    }
  }
  const cooling=car.elapsedTime-horn.lastAt<1.2;
  $('horn-button').disabled=!!state.collision||!state.connected||!cameraReady||document.hidden||car.energyKWh>=51.6;
  // Preserve keyboard focus during cooldown so a held Space key cannot fall
  // through to the page's braking shortcut after the first beep.
  $('horn-button').setAttribute('aria-disabled',String($('horn-button').disabled||cooling));
  $('horn-button').classList.toggle('sounding',car.elapsedTime-horn.lastAt<.4);
  $('horn-label').textContent=cooling?'已鸣笛':'鸣笛';
  if($('horn-status').textContent!==horn.reason)$('horn-status').textContent=horn.reason;
  $('horn-feedback').dataset.status=horn.status;
}
function cancelPlan(reason){stopAutodrive(reason);const cruising=state.exitCruise;state.exitCruise=false;if(cruising){log('普通道路 AI 巡航已结束：'+reason);renderPlan();}if(state.plan&&['running','ready'].includes(state.plan.status)){state.plan.status='cancelled';state.plan.reason=reason;renderPlan();}}
function requestBrake(reason,amount=.55,{emergency=false}={}){if(state.collision)return false;state.controls.clear();cancelPlan(reason);state.serviceBrake=Math.max(state.serviceBrake,amount);if(emergency)state.estop=true;log(reason);render();}
function emergencyStop(){if(state.collision)return false;requestBrake('紧急制动：全力刹车，车辆仍将继续移动直至停止',1,{emergency:true});toast('正在全力制动，刹车距离会持续累计');}
function releaseEmergency(){
  if(state.collision)return false;
  if(car.speed>.01)return;
  state.estop=false;state.failsafe=false;state.serviceBrake=0;
  if(state.shoulderAlert){
    state.shoulderRecovery=true;state.laneTarget=2;state.laneChanging=true;
    log('已解除应急车道制动锁定，按住油门后自动返回右车道');
  }else log('制动锁定已解除，车辆保持静止');
  render();
}
function available(){if(state.collision)return false;if(state.estop){toast('请等车辆停稳后解除制动锁定');return false;}if(!state.connected||!cameraReady){toast('连接或画面不可用，保持制动');return false;}if(car.energyKWh>=51.6){toast('模拟电量耗尽，请重置模拟');return false;}return true;}
const controlModes=['manual','ai','auto'];
function switchMode(mode){if(state.collision)return;if(!controlModes.includes(mode))return;if(mode!==state.mode){state.controls.clear();if(state.plan?.status==='running'||state.exitCruise||state.autodrive.active)requestBrake('已切换控制方式，取消 AI 并开始常规制动');state.mode=mode;}for(const name of controlModes){const active=name===mode;$(name+'-panel').hidden=!active;$(name+'-tab').classList.toggle('active',active);$(name+'-tab').setAttribute('aria-selected',String(active));$(name+'-tab').tabIndex=active?0:-1;}render();}
$('auto-tab').onclick=()=>switchMode('auto');$('manual-tab').onclick=()=>switchMode('manual');$('ai-tab').onclick=()=>switchMode('ai');$('ai-shortcut').onclick=()=>{switchMode('ai');$('ai-tab').scrollIntoView({block:'nearest',behavior:'smooth'});};
for(const mode of controlModes)$(mode+'-tab').onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'manual':event.key==='End'?'auto':controlModes[(controlModes.indexOf(mode)+(event.key==='ArrowLeft'?2:1))%3];switchMode(next);$(next+'-tab').focus();}};
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
function requestLaneChange(direction,{fromPlan=false}={}){
  if(![-1,1].includes(direction)||!available())return false;
  if(state.exitActive){if(!fromPlan)toast(state.exitCompleted?'普通道路双向各一条车道，请保持本车道，不能跨越双黄线':'已选择出口路线，请沿匝道驶离或在入口前取消');return false;}
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
  const rule=roadModel.canChangeLane(car.y,{speed:car.speed,gear:car.gear,targetSpeed:effectiveTarget(state.autodrive.active?100:state.speedLimit)});
  if(!rule.allowed){if(!fromPlan)toast(rule.reason);return false;}
  if(!fromPlan)cancelPlan('手动变道接管');state.laneTarget=target;state.laneChanging=true;
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
  const advice=traffic.getLaneRecommendation(trafficWorld,car,{wet:state.wet,desiredSpeed:effectiveTarget(state.autodrive.active?100:state.speedLimit)});
  const rule=roadModel.canChangeLane(car.y,{speed:car.speed,gear:car.gear,targetSpeed:effectiveTarget(state.autodrive.active?100:state.speedLimit)});
  let reason='';
  if(state.collision)reason='本次驾驶发生碰撞，重新开始后再评估车道。';
  else if(state.exitActive)reason=state.exitCompleted?'普通道路双向各一条车道，保持本车道，禁止跨越双黄线。':'正在沿出口路线行驶，暂停普通车道建议。';
  else if(!rule.allowed)reason=rule.reason;
  else if(state.estop||state.failsafe||!state.connected||!cameraReady)reason='制动锁定或连接不可用，暂停变道建议。';
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
  document.querySelector('.advice-lanes').hidden=state.exitCompleted;
  const title=state.collision?'碰撞结束 · 建议已暂停':recommended?`推荐向${advice.direction==='left'?'左':'右'}变道`:
    advice.status==='keep'?'保持当前车道':advice.status==='blocked'?'暂不建议变道':
    state.exitCompleted?'普通道路 · 保持本车道':state.laneChanging?'正在完成变道':advice.reason==='车速较低，起步后再评估变道'?'起步后评估车流':'变道建议已暂停';
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
  if(state.collision||event.defaultPrevented||event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
  if(event.code==='Space'){event.preventDefault();requestBrake('按下空格，常规制动至停止');return;}
  if(event.key==='Escape'){requestBrake('已请求常规制动');if($('camera-panel').classList.contains('expanded'))toggleExpand(false);return;}
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  if(event.code==='KeyR'){event.preventDefault();if(!event.repeat){cancelPlan('键盘手动接管');switchMode('manual');setGear(state.requestedGear==='reverse'?'forward':'reverse');}return;}
  if(laneKeyMap[event.code]||keyMap[event.code]){cancelPlan('键盘手动接管');if(state.mode!=='manual')switchMode('manual');}
  if(laneKeyMap[event.code]){event.preventDefault();if(!event.repeat)requestLaneChange(laneKeyMap[event.code]);return;}
  if(!keyMap[event.code])return;event.preventDefault();if(!event.repeat)pressDrive(keyMap[event.code],'k'+event.code);
});
window.addEventListener('keyup',event=>releaseDrive('k'+event.code));
function failSafe(reason){if(state.collision)return;state.failsafe=true;requestBrake(reason,1);}
window.addEventListener('blur',()=>{if(car.speed>.01||state.controls.size||state.plan?.status==='running'||state.exitCruise||state.autodrive.active)failSafe('页面失去焦点，接管为全力制动');});
document.addEventListener('visibilitychange',()=>{if(state.collision){if(document.hidden)finishCollisionAnimation({draw:false});else collisionFramePending=true;lastFrame=performance.now();return;}if(document.hidden){state.pausedAt=performance.now();failSafe('页面进入后台，自动制动已触发');camera?.pause();}else{const elapsed=state.pausedAt===null?0:(performance.now()-state.pausedAt)/1000;advanceElapsed(Math.min(elapsed,60),true);state.pausedAt=null;lastFrame=performance.now();lastCameraFrame=0;render();}});
window.addEventListener('pagehide',()=>{if(state.collision){finishCollisionAnimation({draw:false});return;}state.controls.clear();state.failsafe=true;cancelPlan('页面离开');});
$('normal-stop').onclick=()=>requestBrake('常规制动：持续刹车至完全停止');$('emergency-stop').onclick=emergencyStop;$('reset-estop').onclick=releaseEmergency;
function currentRoadType(){return state.exitCompleted?'local':state.exitActive?'ramp':'highway';}
function currentRoadCap(){return (state.exitCompleted?roadModel.localRoad.speedLimitKmh:state.exitActive?40:traffic.limitAt(car.y))/3.6;}
function effectiveTarget(target,gear=state.requestedGear){return Math.min(target,currentRoadCap(),gear==='reverse'?physics.constants.maxReverseSpeed:100);}
function motionHeading(){return (car.heading+(car.gear==='reverse'?180:0))%360;}
function setGear(gear){
  if(!['forward','reverse'].includes(gear)||gear===state.requestedGear||!available())return;
  if(state.exitActive&&!state.exitCompleted){toast('出口匝道内保持前进挡，进入普通道路后可以倒车');return;}
  cancelPlan('手动换挡');state.controls.clear();state.requestedGear=gear;state.serviceBrake=0;state.failsafe=false;state.brakeAnchor=null;
  state.shiftPending=car.gear!==gear;
  log(car.speed>0?`已选择${gear==='reverse'?'倒车 R':'前进 D'}，先制动至停稳再换挡`:`已选择${gear==='reverse'?'倒车 R':'前进 D'}`);
  render();
}
$('gear-forward').onclick=()=>setGear('forward');$('gear-reverse').onclick=()=>setGear('reverse');
document.querySelectorAll('[data-density]').forEach(button=>button.onclick=()=>{
  if(state.collision)return;
  const density=button.dataset.density;if(!traffic.densityPresets[density]||density===state.trafficDensity)return;
  traffic.setDensity(trafficWorld,car,density);state.trafficDensity=density;state.contactUntil=0;
  log(`车流切换为${traffic.densityPresets[density].label}，已重新布置周围车辆`);render();
});
$('speed-slider').oninput=event=>{if(state.collision)return;const value=Number(event.target.value),max=state.requestedGear==='reverse'?physics.constants.maxReverseSpeed:100;if(!Number.isFinite(value)||value<1||value>max)return;state.speedLimit=value;render();};
function setRoad(wet){if(state.collision)return;if(car.braking){toast('请在本次制动结束后切换路面');return;}state.wet=wet;state.brakeAnchor=null;log(`路面切换为${wet?'湿滑':'干燥'}，摩擦系数 ${wet?.45:.85}`);render();}
$('dry-road').onclick=()=>setRoad(false);$('wet-road').onclick=()=>setRoad(true);
function nextExitForRoute(){return roadModel.eventsAround(car.y,7000).exits.filter(exit=>exit.entryStart+25>=car.y).sort((a,b)=>a.entryStart-b.entryStart)[0]||null;}
function requestExit({fromPlan=false,exit=null}={}){
  if(!available()||state.exitActive)return false;
  const selected=exit||nextExitForRoute();
  let reason='';
  if(car.gear!=='forward'||state.requestedGear!=='forward'||state.shiftPending)reason='驶入出口需要前进挡';
  else if(state.shoulderAlert||state.shoulderRecovery||state.laneTarget!==2||state.laneChanging||!laneControl.isCentered(car,laneCenters[2]))reason='请先到达右车道中央，再驶入出口';
  else if(!selected||car.y<selected.entryStart-300)reason='出口尚未进入可驶入范围，请按距离提示继续前进';
  else if(car.y>selected.entryStart+25)reason='已错过这个出口，请继续驶向下一个出口';
  if(reason){if(!fromPlan)toast(reason);return false;}
  if(!fromPlan)cancelPlan('手动选择出口路线');
  state.exitActive=selected;state.exitCompleted=false;state.requestedGear='forward';
  log(`已选择${selected.name}，减速至 40 km/h 后沿匝道驶离`);render();return true;
}
$('exit-action').onclick=()=>{
  if(state.collision)return;
  if(state.exitActive){
    if(state.exitCompleted)return;
    if(car.y<state.exitActive.entryStart){cancelPlan('取消出口路线');state.exitActive=null;log('已取消出口路线，继续沿右车道行驶');render();}
    return;
  }
  requestExit();
};
function routeSteering(){
  if(!state.exitActive)return laneControl.steeringFor(car,laneCenters[state.laneTarget],{wet:state.wet});
  if(state.exitCompleted)return laneControl.steeringFor(car,roadModel.localRoad.laneCenter,{wet:state.wet});
  const ahead=1.5*Math.max(5.5,car.speed*(state.wet?1.7:1.4));
  return laneControl.steeringFor(car,roadModel.centerForExit(state.exitActive,car.y+ahead),{wet:state.wet});
}
function updateExitState(){
  if(state.exitActive&&!state.exitCompleted&&car.y>=state.exitActive.rampEnd){
    state.exitCompleted=true;
    trafficWorld=traffic.transitionToLocal(trafficWorld,car,state.exitActive);
    log(`已从${state.exitActive.name}驶入普通道路，限速 50 km/h，可继续行驶`);
  }
}
function renderEntrance(section){
  const panel=$('entrance-preview');
  const reversing=car.gear==='reverse';
  const entrance=section.activeEntrance||(reversing?
    roadModel.eventsAround(car.y,4000).entrances?.filter(entry=>entry.start<car.y).at(-1):section.nextEntrance);
  panel.hidden=currentRoadType()!=='highway'||!entrance;
  if(panel.hidden)return;
  const distance=Math.max(0,reversing?car.y-entrance.end:entrance.mergeStart-car.y);
  const entries=(state.trafficInfo?.merging?.list||[]).filter(vehicle=>vehicle.entranceId===entrance.id);
  const merging=entries.filter(vehicle=>vehicle.status==='merging').length;
  const waiting=entries.filter(vehicle=>vehicle.status==='waiting').length;
  panel.classList.toggle('nearby',distance<500);panel.classList.toggle('joining',merging>0);
  $('entrance-name').textContent=entrance.name;
  $('entrance-detail').textContent=section.activeEntrance?'正在经过汇入口 · 留意右侧车辆':
    `${reversing?'倒车方向':'前方'} ${Math.ceil(distance)} m · 右侧加速车道汇入`;
  const status=state.collision?'本局已结束，汇入车流也已暂停':
    merging?`${merging} 辆车正在汇入右车道，请保持安全车距`:
    waiting?`${waiting} 辆车在加速车道等待安全间隙`:
    entries.length?`${entries.length} 辆车正沿入口匝道接近`:'入口车流会在间隙安全时汇入';
  if($('entrance-status').textContent!==status)$('entrance-status').textContent=status;
}
function renderRoadEvents(){
  const section=roadModel.getState(car.y),rule=roadModel.canChangeLane(car.y,{speed:car.speed,gear:car.gear,targetSpeed:effectiveTarget(state.autodrive.active?100:state.speedLimit)});
  renderEntrance(section);
  $('road-rule-title').textContent=state.exitCompleted?'普通道路 · 限速 50 km/h':state.exitActive?'出口匝道 · 限速 40 km/h':section.solid?'实线路段 · 禁止变道':!rule.allowed?'前方实线 · 暂缓变道':'虚线路段 · 可变道';
  $('road-rule-detail').textContent=state.exitCompleted?'双向各一条车道 · 保持右侧行驶，不得跨越双黄线':state.exitActive?'沿匝道接入普通道路，进入后可继续行驶':!rule.allowed?rule.reason:`前方 ${Math.max(0,Math.ceil(section.nextSolid?.distance||0))} m 进入实线路段`;
  $('road-events').classList.toggle('solid-zone',!rule.allowed&&!state.exitActive);$('road-events').classList.toggle('exiting',!!state.exitActive);
  const exit=state.exitActive||nextExitForRoute(),button=$('exit-action');
  $('exit-name').textContent=exit?exit.name:'出口信息加载中';
  $('exit-detail').textContent=state.exitActive?(state.exitCompleted?`已接入普通道路 · 继续行驶 ${Math.max(0,Math.floor(car.y-exit.rampEnd))} m`:`接入普通道路 · 还有 ${Math.max(0,Math.ceil(exit.rampEnd-car.y))} m`):exit?`入口 ${Math.max(0,Math.ceil(exit.entryStart-car.y))} m · 从右车道驶入`:'继续沿高速行驶';
  const trafficExit=state.exitActive||section.activeExit||exit;
  const exiting=(state.trafficInfo?.exiting?.list||[]).filter(vehicle=>vehicle.exitId===trafficExit?.id);
  const leaving=exiting.filter(vehicle=>vehicle.status==='ramp').length;
  const approaching=exiting.filter(vehicle=>vehicle.status==='approaching').length;
  const exitTrafficStatus=state.collision?'本局已结束，驶离车流也已暂停':
    leaving?`${trafficExit.name} · ${leaving} 辆车正在沿匝道驶离`:
    approaching?`${approaching} 辆右车道车辆正减速准备驶离`:'部分右车道车辆会从出口驶离';
  $('exit-traffic-status').hidden=state.exitCompleted;
  if($('exit-traffic-status').textContent!==exitTrafficStatus)$('exit-traffic-status').textContent=exitTrafficStatus;
  button.textContent=state.exitActive?(state.exitCompleted?'普通道路行驶中':car.y<exit.entryStart?'取消驶离':'沿匝道行驶中'):'驶入这个出口';
  button.disabled=state.exitActive?(state.exitCompleted?true:car.y>=exit.entryStart):(!exit||car.y<exit.entryStart-300||car.y>exit.entryStart+25||state.laneTarget!==2||state.laneChanging||car.gear!=='forward'||state.estop||!state.connected||!cameraReady);
}
function parseCommand(raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>240)throw new Error('请输入 1～240 字的指令。');
  const text=raw.trim().replace(/\s+/g,'').replace(/[，,。！!]/g,'');
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
  return commands.parse(raw,{targetSpeed:state.speedLimit});
}
function brakingTest(target,title){
  if(!Number.isFinite(target)||target<1||target>100)throw new Error('设定速度必须在 1～100 m/s 之间，实际行驶遵守路段限速。');
  return {kind:'brake-test',gear:'forward',target,title,labels:[brakingTargetLabel(target),'达到车速后全力制动；60 秒未达速则结束加速']};
}
function brakingTargetLabel(target){const capped=effectiveTarget(target,'forward');return `加速至 ${capped.toFixed(1)} m/s（${(capped*3.6).toFixed(0)} km/h）${target>capped?' · 已按路段限速调整':''}`;}
function submitCommand(raw){if(state.collision)return {status:'blocked',reason:'发生碰撞，请先重新开始'};try{const parsed=parseCommand(raw);if(parsed.emergency){emergencyStop();return {status:'braking'};}if(parsed.stop){requestBrake('AI 指令请求常规制动至停止');$('ai-feedback').textContent='已经踩下刹车，速度和实际制动距离仍会继续变化，直至停车。';return {status:'braking'};}if(!available())return {status:'blocked'};if(state.plan?.status==='running'||state.exitCruise||state.autodrive.active)requestBrake('新计划替换旧任务，先开始制动');state.plan={...parsed,status:'ready',phase:0,startDistance:car.distance,brakeStartDistance:0};$('ai-feedback').textContent='请确认计划。行驶遵守路段限速，超速会自动制动；前进 / 倒车切换会先停稳。';$('ai-feedback').classList.remove('error');log(`生成计划：${parsed.title}`);renderPlan();return {status:'ready',steps:parsed.labels};}catch(error){$('ai-feedback').textContent=error.message;$('ai-feedback').classList.add('error');return {status:'error',message:error.message};}}
$('command-form').onsubmit=event=>{event.preventDefault();submitCommand($('command-input').value);};$('command-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submitCommand(event.target.value);}};
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>{$('command-input').value=button.dataset.command;submitCommand(button.dataset.command);});
function startPlan({fromAuto=false}={}){
  const plan=state.plan;
  if(plan?.status!=='ready'||!available())return false;
  if(state.exitActive&&!state.exitCompleted&&(plan.gear==='reverse'||plan.steps?.some((step,index)=>step.gear==='reverse'&&!plan.steps.slice(0,index).some(prior=>prior.type==='exit')))){toast('出口匝道内保持前进，请在进入普通道路后倒车');return false;}
  if(state.exitCompleted&&plan.steps?.some(step=>step.type==='exit'||step.type==='lane')){toast('当前为双向单车道普通道路，请选择直行、调速、停车或倒车任务');return false;}
  if(!fromAuto)stopAutodrive('开始新的 AI 任务');
  state.exitCruise=false;
  state.controls.clear();state.serviceBrake=0;state.failsafe=false;state.brakeAnchor=null;
  Object.assign(plan,{status:'running',phase:0,startDistance:car.distance,startTime:car.elapsedTime});
  if(plan.kind==='sequence'){
    Object.assign(plan,{gear:state.requestedGear,target:state.speedLimit,motionStarted:true,stepStarted:false,waitingReason:''});
    updateSequencePlan(plan);
  }else{
    state.requestedGear=plan.gear;state.shiftPending=car.gear!==plan.gear;plan.motionStarted=!state.shiftPending;state.speedLimit=plan.target;
  }
  log(`AI 开始执行：${plan.title}`);renderPlan();render();return true;
}
function sequenceWait(plan,reason){if(plan.waitingReason!==reason){plan.waitingReason=reason;renderPlan();}}
function blockSequence(plan,reason){
  plan.status='blocked';plan.waitingReason=reason;state.serviceBrake=1;state.controls.clear();
  log(`计划暂停并制动：${reason}`);$('ai-feedback').textContent=reason;renderPlan();
}
function finishSequenceStep(plan){
  plan.phase++;plan.stepStarted=false;plan.waitingReason='';
  if(plan.phase>=plan.steps.length){
    plan.status='completed';state.exitCruise=plan.steps[plan.phase-1].type==='exit'&&state.exitCompleted&&!state.autodrive.active;state.serviceBrake=state.exitCruise||state.autodrive.active?0:1;
    const message=state.autodrive.active?'已接入普通道路，继续全自动驾驶。':state.exitCruise?'已进入普通道路，AI 继续按限速巡航；手动操作或停车指令可接管。':'所有步骤已完成，车辆已停稳。可以输入新的任务。';
    log(message);$('ai-feedback').textContent=message;
  }
  if(plan.status==='running')beginSequenceStep(plan,plan.steps[plan.phase]);
  renderPlan();
}
function beginSequenceStep(plan,step){
  plan.stepStarted=true;plan.stepTime=car.elapsedTime;plan.stepDistance=car.distance;plan.waitSince=null;plan.laneGoal=null;plan.laneStarted=false;plan.nextLaneCheck=0;
  if(step.type==='drive'){plan.gear=step.gear;plan.target=step.target;state.requestedGear=step.gear;plan.motionStarted=car.gear===step.gear;}
  if(step.type==='speed'){plan.target=step.target;if(step.gear){plan.gear=step.gear;state.requestedGear=step.gear;}}
  if(step.type==='lane')plan.laneGoal=state.laneTarget+step.direction;
  if(step.type==='exit'){plan.gear='forward';state.requestedGear='forward';plan.routeExit=state.exitActive||plan.preferredExit||nextExitForRoute();plan.exitTimeout=Math.max(900,((plan.routeExit?.rampEnd||car.y)-car.y)/Math.max(1,Math.min(plan.target,40/3.6))*3+120);}
  state.speedLimit=plan.target;
}
function attemptPlanLane(plan,direction){
  if(state.laneChanging){sequenceWait(plan,'正在移至目标车道中央');return false;}
  if(!laneControl.isCentered(car,laneCenters[state.laneTarget])){sequenceWait(plan,'正在回正，请等待车辆居中');return false;}
  if(car.gear!==plan.gear||state.shiftPending){sequenceWait(plan,'正在停稳换挡');return false;}
  if(car.elapsedTime<plan.nextLaneCheck)return false;
  plan.nextLaneCheck=car.elapsedTime+.2;
  const rule=roadModel.canChangeLane(car.y,{speed:car.speed,gear:car.gear,targetSpeed:effectiveTarget(state.autodrive.active?100:plan.target,plan.gear)});
  if(!rule.allowed){sequenceWait(plan,rule.reason+'，保持车道等待虚线');return false;}
  const advice=traffic.getLaneRecommendation(trafficWorld,car,{wet:state.wet,desiredSpeed:effectiveTarget(state.autodrive.active?100:plan.target,plan.gear)}),target=advice.lanes[state.laneTarget+direction],current=advice.lanes[state.laneTarget];
  if(car.gear==='reverse'){
    const laneX=laneCenters[state.laneTarget+direction];
    if(trafficWorld.vehicles.some(v=>Math.abs(v.x-laneX)<1.8&&Math.abs(v.y-car.y)<Math.max(25,(v.speed+car.speed)*8))){sequenceWait(plan,'倒车方向有来车，保持车道等待间距');return false;}
  }else if(!target?.safe||(current?.departureFrontGap!==null&&current?.departureFrontGap<10)){
    sequenceWait(plan,'相邻车道或当前前车距离不足，等待安全间距');return false;
  }
  if(requestLaneChange(direction,{fromPlan:true})){sequenceWait(plan,'正在移至目标车道中央');return true;}
  return false;
}
function updateSequencePlan(plan){
  const step=plan.steps[plan.phase];if(!step)return;
  if(!plan.stepStarted)beginSequenceStep(plan,step);
  // Bound stalled execution while allowing the longest legal journey and wait.
  const timeout=step.type==='drive'?Math.max(300,step.distance/Math.max(1,effectiveTarget(plan.target,plan.gear))*3+60):step.type==='wait'?step.duration+60:step.type==='exit'?plan.exitTimeout:120;
  if(car.elapsedTime-plan.stepTime>timeout){blockSequence(plan,'当前步骤长时间未能完成，已制动停车；请调整路线或车流后重新下达任务');return;}
  if(step.type==='drive'){
    if(!plan.motionStarted){if(car.gear!==plan.gear){sequenceWait(plan,'先减速停稳，再切换行驶方向');return;}plan.motionStarted=true;plan.stepDistance=car.distance;}
    sequenceWait(plan,'');if(car.distance-plan.stepDistance>=step.distance)finishSequenceStep(plan);
  }else if(step.type==='speed'){
    if(car.gear===plan.gear&&Math.abs(car.speed-effectiveTarget(plan.target,plan.gear))<.15)finishSequenceStep(plan);
  }else if(step.type==='brake'){
    if(car.speed===0)finishSequenceStep(plan);
  }else if(step.type==='wait'){
    if(car.speed>0){sequenceWait(plan,'先制动至停稳，再开始计时');return;}
    if(plan.waitSince===null)plan.waitSince=car.elapsedTime;
    sequenceWait(plan,`停车等待，还剩 ${Math.max(0,Math.ceil(step.duration-(car.elapsedTime-plan.waitSince)))} 秒`);
    if(car.elapsedTime-plan.waitSince>=step.duration)finishSequenceStep(plan);
  }else if(step.type==='lane'){
    if(state.exitActive){blockSequence(plan,'已进入出口路线，不能执行普通车道变更');return;}
    if(plan.laneGoal<0||plan.laneGoal>2){blockSequence(plan,'目标方向已无普通车道，AI 不会驶入应急车道');return;}
    if(!plan.laneStarted)plan.laneStarted=attemptPlanLane(plan,step.direction);
    else if(!state.laneChanging&&laneControl.isCentered(car,laneCenters[plan.laneGoal]))finishSequenceStep(plan);
  }else if(step.type==='exit'){
    if(state.exitActive){sequenceWait(plan,state.exitCompleted?'已接入普通道路，限速 50 km/h':'沿出口匝道行驶，限速 40 km/h');if(state.exitCompleted)finishSequenceStep(plan);return;}
    if(!plan.routeExit||car.y>plan.routeExit.entryStart+25){blockSequence(plan,'未能在出口前完成靠右变道，已错过本次出口；请重新选择行程');return;}
    if(state.laneTarget<2){attemptPlanLane(plan,1);return;}
    if(state.laneChanging){sequenceWait(plan,'正在进入右车道');return;}
    if(car.y<plan.routeExit.entryStart-300){sequenceWait(plan,`保持右车道，距离出口入口 ${Math.ceil(plan.routeExit.entryStart-car.y)} 米`);return;}
    if(requestExit({fromPlan:true,exit:plan.routeExit}))sequenceWait(plan,'已选择出口，减速后沿匝道驶离');
  }
}
function sequenceTarget(plan){
  let target=effectiveTarget(plan.target,plan.gear);
  // While waiting for a legal gap, follow the current vehicle instead of
  // repeatedly running into it. This controller only belongs to AI plans.
  if(plan.gear==='forward'){
    const ahead=traffic.getSnapshot(trafficWorld,{...car,exitRoute:state.exitActive}).nearestAhead;
    if(ahead){const frontSpeed=ahead.speedKmh/3.6,gap=Math.max(12,car.speed*1.8);target=Math.min(target,Math.max(0,frontSpeed+(ahead.distance-gap)*.3));}
  }
  return target;
}
$('task-action').onclick=()=>{if(state.collision)return;if(state.plan?.status==='ready')startPlan();else if(state.plan?.status==='running'||state.exitCruise)requestBrake('停止 AI 任务，持续常规制动');else{state.plan=null;renderPlan();}};
function renderPlan(){const plan=state.plan;$('task-card').hidden=!plan;if(!plan)return;if(plan.kind==='brake-test'&&plan.phase===0)plan.labels[0]=brakingTargetLabel(plan.target);const status={ready:'待确认',running:plan.kind==='sequence'?(plan.waitingReason?'等待 / 执行中':'执行中'):plan.phase?'制动中':'执行中',blocked:'受阻 · 制动停车',completed:state.exitCruise?'已驶离 · 巡航中':'已完成',limited:'未达目标 · 已结束',cancelled:state.collision?'碰撞结束':car.speed>.01?(state.lastInput.brake>0?'已取消 · 制动中':'已取消 · 滑行中'):'已取消'};$('task-badge').textContent=status[plan.status];$('task-waiting').hidden=!plan.waitingReason;$('task-waiting').textContent=plan.waitingReason||'';$('task-steps').replaceChildren();plan.labels.forEach((label,index)=>{const li=document.createElement('li'),number=document.createElement('span'),text=document.createElement('span');number.className='step-number';const done=plan.status==='completed'||index<plan.phase;number.textContent=done?'✓':String(index+1);text.textContent=label;li.className=done?'done':plan.status==='running'&&index===plan.phase?'current':'';li.append(number,text);$('task-steps').append(li);});const action=$('task-action');action.replaceChildren();const icon=document.createElement('i'),text=document.createElement('span');icon.dataset.icon=plan.status==='running'||state.exitCruise?'stop':plan.status==='ready'?'play':'refresh';text.textContent=state.exitCruise?'结束巡航并制动':plan.status==='running'?'取消并制动':plan.status==='ready'?'开始执行':'新的任务';action.append(icon,text);paintIcons(action);}
function updatePlan(){
  const plan=state.plan;if(plan?.status!=='running')return;
  if(plan.kind==='sequence'){updateSequencePlan(plan);return;}
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
function stopAutodrive(reason){
  if(!state.autodrive.active)return;
  state.autodrive.active=false;state.autodrive.decision=null;state.autodrive.reason=reason;
  log('自动驾驶已退出：'+reason);
}
function prepareAutoExit(preferredExit=null){
  state.plan={...parseCommand('从下一个出口驶离高速'),status:'ready',phase:0,startDistance:car.distance,preferredExit};
  return startPlan({fromAuto:true});
}
function startAutodrive(){
  if(!available())return false;
  if(state.shoulderAlert||state.shoulderRecovery){toast('请先停稳并返回正常车道，再启动自动驾驶');return false;}
  const route=state.autodrive.route;
  cancelPlan('切换为全自动驾驶');switchMode('auto');
  state.plan=null;state.controls.clear();state.exitCruise=false;state.serviceBrake=0;state.failsafe=false;state.brakeAnchor=null;
  state.requestedGear='forward';state.shiftPending=car.gear!=='forward';
  Object.assign(state.autodrive,{active:true,route,decision:null,nextLaneCheck:0,reason:'正在接管油门、刹车和车道控制'});
  if(route==='exit'&&!state.exitCompleted)prepareAutoExit();
  log(route==='exit'&&!state.exitCompleted?'全自动驾驶启动：自动靠右，从下一个可用出口驶离':'全自动驾驶启动：按道路限速持续巡航');
  updateAutodrive();renderPlan();render();return true;
}
function updateAutodrive(){
  const auto=state.autodrive;if(!auto.active)return;
  if(state.estop||state.failsafe||!state.connected||!cameraReady||car.energyKWh>=51.6){requestBrake('自动驾驶已中止，保持制动',1);return;}
  if(auto.route==='exit'&&state.plan?.status==='blocked'&&!state.exitActive){
    const oldExit=state.plan.routeExit;
    const next=roadModel.eventsAround(car.y,10000).exits.filter(exit=>exit.entryStart>Math.max(car.y+25,oldExit?.entryStart||0)).sort((a,b)=>a.entryStart-b.entryStart)[0];
    if(next){state.serviceBrake=0;prepareAutoExit(next);log('本次出口无法安全驶入，自动继续前往下一个出口');}
    else{requestBrake('当前没有可用出口，自动驾驶已停车等待');return;}
  }
  const choosingLane=car.elapsedTime>=auto.nextLaneCheck;
  if(choosingLane)auto.nextLaneCheck=car.elapsedTime+.25;
  const routePending=auto.route==='exit'&&state.plan?.status==='running';
  auto.decision=autopilot.evaluate(trafficWorld,car,{wet:state.wet,targetSpeed:100,roadType:currentRoadType(),exitRoute:state.exitActive,laneTarget:state.laneTarget,laneChanging:state.laneChanging,shoulderAlert:state.shoulderAlert||state.shoulderRecovery,shiftPending:car.gear!=='forward',cooldownUntil:state.adviceCooldownUntil,allowLaneChange:choosingLane&&!routePending});
  if(auto.decision.laneDirection&&requestLaneChange(auto.decision.laneDirection,{fromPlan:true}))state.adviceCooldownUntil=car.elapsedTime+5;
  auto.reason=routePending?(state.plan.waitingReason||'自动选择出口路线'):auto.decision.reason;
}
$('auto-start').onclick=startAutodrive;
$('auto-stop').onclick=()=>requestBrake('已结束自动驾驶，制动至完全停止');
for(const button of document.querySelectorAll('[data-auto-route]'))button.onclick=()=>{
  if(state.collision)return;
  const route=button.dataset.autoRoute;if(route===state.autodrive.route)return;
  state.autodrive.route=route;if(state.autodrive.active)startAutodrive();else render();
};
function renderAutodrive(){
  const auto=state.autodrive,decision=auto.decision;
  const labels={cruising:'自动巡航中',following:'自动跟车中',braking:'自动制动中','anticipating-limit':'前方降速 · 提前制动',changing:'自动变道中',shifting:'停稳换挡中',waiting:'等待通行条件',locked:'自动制动中'};
  $('auto-status-card').classList.toggle('active',auto.active);
  $('auto-status-title').textContent=auto.active?(auto.route==='exit'&&!state.exitCompleted?'自动驶向出口':labels[decision?.status]||'自动驾驶中'):'自动驾驶待命';
  if($('auto-status-reason').textContent!==auto.reason)$('auto-status-reason').textContent=auto.reason;
  $('auto-throttle').textContent=auto.active?(state.lastInput.throttle>0?'自动给油':'自动释放'):'待命';
  $('auto-brake').textContent=auto.active?(state.lastInput.brake>0?Math.round(state.lastInput.brake*100)+'% 制动力':'自动释放'):'待命';
  $('auto-speed').textContent=auto.active?((decision?.targetSpeed||0)*3.6).toFixed(0)+' km/h':'按路段限速';
  $('auto-steering').textContent=state.exitActive?(state.exitCompleted?'普通道路居中':'沿匝道循迹'):state.laneChanging?'移向'+laneName(state.laneTarget):'自动保持车道';
  $('auto-start').hidden=auto.active;$('auto-stop').hidden=!auto.active;
  $('auto-start').disabled=!!state.collision||state.estop||!state.connected||!cameraReady||state.shoulderAlert||state.shoulderRecovery;
  for(const button of document.querySelectorAll('[data-auto-route]')){const selected=button.dataset.autoRoute===auto.route;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=button.dataset.autoRoute==='exit'&&state.exitCompleted;}
}
function getInput(){
  const values=[...state.controls.values()],plan=state.plan;
  let throttle=values.includes('throttle')?1:0,brake=values.includes('brake')?.55:state.serviceBrake,steering=routeSteering();
  const gear=state.autodrive.active?'forward':plan?.status==='running'?plan.gear:state.requestedGear;
  const target=state.autodrive.active?(state.autodrive.decision?.targetSpeed||0):plan?.status==='running'&&plan.kind==='sequence'?sequenceTarget(plan):state.exitCruise?sequenceTarget({target:state.speedLimit,gear}):effectiveTarget(plan?.status==='running'?plan.target:state.speedLimit,gear);
  if(plan?.status==='running'){
    if(plan.kind==='sequence'){const step=plan.steps[plan.phase];if(['brake','wait'].includes(step?.type)){throttle=0;brake=step.amount||1;}else{throttle=car.speed<=target?1:0;brake=car.speed>target+.12?.55:0;}}
    else if(plan.phase===1){throttle=0;brake=1;}
    else{throttle=car.speed<=target?1:0;brake=car.speed>target+.12?.35:0;}
  }
  if(state.exitCruise){throttle=car.speed<=target?1:0;brake=car.speed>target+.12?.55:0;}
  if(state.autodrive.active){throttle=state.autodrive.decision?.throttle||0;brake=state.autodrive.decision?.brake||0;}
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
  return {throttle,brake,steering,targetSpeed:target,gear,wet:state.wet,guardrails:!state.exitActive};
}
function updateLaneState(){
  if(state.exitActive)return;
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
  if(state.collision)return;
  updateExitState();updateLaneState();updatePlan();updateAutodrive();
  const input=getInput();state.lastInput=input;
  // Limit braking ends at the legal speed, so it has no fixed parking line.
  // Keep the live full-stop prediction and avoid integrating a new stop on
  // every proportional-controller substep.
  if(state.autodrive.active||(state.autoLimitBraking&&!state.shiftPending&&input.brake<1))state.brakeAnchor=null;
  else if(input.brake>0&&car.speed>0&&(!car.braking||state.brakeAnchor?.pressure!==input.brake)){
    state.brakeAnchor={x:car.x,y:car.y,heading:motionHeading(),pressure:input.brake,distance:physics.estimateBrakingDistance(car.speed,{wet:state.wet,brake:input.brake})};
  }else if(input.brake===0&&car.braking)state.brakeAnchor=null;
  const previousPose={...car},wasBraking=car.braking,contacts=car.wallContactCount;
  traffic.step(trafficWorld,car,dt,{roadModel,merging:currentRoadType()==='highway',exiting:!state.exitCompleted,wet:state.wet,egoLaneTarget:state.laneChanging?state.laneTarget:null});
  physics.step(car,input,dt);
  state.shiftPending=state.requestedGear!==car.gear;
  if(previousPose.gear!==car.gear){state.brakeAnchor=null;log(`已停稳换入${car.gear==='reverse'?'倒车 R':'前进 D'}挡`);}
  const contact=traffic.resolveContact(trafficWorld,car,previousPose);
  if(contact||car.wallContactCount>contacts){
    if(contact)car.acceleration=(car.speed-previousPose.speed)/dt;
    finishWithCollision(contact?'vehicle':'guardrail',previousPose,contact);
    return;
  }
  updateExitState();updateLaneState();
  const prev=state.trail[state.trail.length-1];
  if(Math.hypot(car.x-prev[0],car.y-prev[1])>.5){state.trail.push([car.x,car.y]);if(state.trail.length>1500)state.trail.splice(1,1);}
  if(wasBraking&&!car.braking&&car.speed===0){log(`车辆已停稳，制动距离 ${(car.lastBrakeDistance||0).toFixed(2)} m`);if(!state.estop&&!state.failsafe)state.serviceBrake=0;renderPlan();}
  updatePlan();
}
function advanceElapsed(elapsed,background=false){let remaining=Math.max(0,elapsed);while(remaining>0&&!state.collision){const step=Math.min(remaining,1/120);advance(step);remaining-=step;if(background&&car.speed===0)break;}if(state.collision)advanceCollisionAnimation(remaining,background);}
function openSheet(id){if(state.collision)return;requestBrake('打开信息面板，开始常规制动');$(id).showModal();}
$('device-button').onclick=()=>openSheet('device-dialog');$('log-button').onclick=()=>openSheet('log-dialog');document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());document.querySelectorAll('.sheet').forEach(dialog=>dialog.onclick=event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
$('toggle-connection').onclick=()=>{if(state.collision)return;state.connected=!state.connected;failSafe(state.connected?'连接已恢复，车辆继续制动至停止':'模拟连接断开，触发全力制动');camera?.pause();render();};
function resetSession({clearEmergency=!!state.collision}={}){
  const keepLocked=state.estop&&!clearEmergency;
  Object.assign(state.horn,{lastAt:-Infinity,count:0,status:'idle',reason:'前车会在允许变道且车距安全时避让。',vehicleId:null,targetLane:null,vehicle:null});
  Object.assign(state.autodrive,{active:false,route:'cruise',decision:null,nextLaneCheck:0,reason:'模拟已重置，点击启动自动驾驶。'});
  car=physics.createState();trafficWorld=traffic.createState(car,{density:state.trafficDensity});
  Object.assign(state,{collision:null,collisionEffect:null,laneAdvice:null,adviceCooldownUntil:0,exitActive:null,exitCompleted:false,exitCruise:false,
    estop:keepLocked,requestedGear:'forward',autoLimitBraking:false,shiftPending:false,laneTarget:1,laneChanging:false,
    shoulderAlert:false,shoulderRecovery:false,serviceBrake:0,failsafe:false,plan:null,trail:[[0,0]],logs:[],started:performance.now(),
    brakeAnchor:null,contactUntil:0,lastContactNotice:-Infinity,trafficInfo:null,lastInput:{throttle:0,brake:0,steering:0},predicted:0,pausedAt:null});
  state.controls.clear();collisionFramePending=false;
  lastFrame=performance.now();lastCameraFrame=0;lastRender=0;camera?.pause();
  clearTimeout(toastTimer);$('toast').classList.remove('visible');$('toast').textContent='';
  if($('collision-dialog').open)$('collision-dialog').close();
  $('camera-live-clock').textContent='00:00.0';$('view-title').textContent=state.map?'行驶轨迹':'高速公路 · 驾驶视角';
  $('command-input').value='';$('ai-feedback').textContent='支持距离、变道、调速、制动、等待、倒车与出口；可用“然后 / 并”组合，最多 8 步。';
  $('ai-feedback').classList.remove('error');log('模拟已重置，车辆回到起点');renderPlan();render();
}
$('reset-session').onclick=()=>{resetSession();$('device-dialog').close();};
$('view-switch').onclick=()=>{if(state.collision)return;state.map=!state.map;camera?.pause();$('map-view').hidden=!state.map;$('view-title').textContent=state.map?'行驶轨迹':'高速公路 · 驾驶视角';$('view-switch').querySelector('span').textContent=state.map?'画面':'轨迹';$('view-switch').setAttribute('aria-label',state.map?'切换到驾驶画面':'切换到行驶轨迹');render();};
function toggleExpand(force){if(state.collision)return;const expanded=force??!$('camera-panel').classList.contains('expanded');$('camera-panel').classList.toggle('expanded',expanded);$('expand-button').setAttribute('aria-label',expanded?'缩小画面':'放大画面');$('expand-button').setAttribute('aria-expanded',String(expanded));document.body.style.overflow=expanded?'hidden':'';}
$('expand-button').onclick=()=>toggleExpand();
window.addEventListener('resize',()=>{if(state.collision)collisionFramePending=true;});
function render(){const moving=car.speed>.01,braking=state.lastInput.brake>0&&moving;state.predicted=physics.estimateBrakingDistance(car.speed,{wet:state.wet,brake:1});$('speed-value').textContent=car.speed.toFixed(1);$('speed-kmh').textContent=(car.speed*3.6).toFixed(1)+' km/h';$('predicted-brake').textContent=state.predicted.toFixed(1);$('actual-brake').textContent=car.braking?car.brakeDistance.toFixed(1):car.lastBrakeDistance===null?'—':car.lastBrakeDistance.toFixed(1);$('actual-brake-label').textContent=car.braking?'正在制动':'上次制动';$('brake-result-label').textContent=car.braking?'距离正在累计':'停车后保留实测结果';$('braking-hud').hidden=!braking;$('braking-hud-distance').textContent=car.brakeDistance.toFixed(1)+' m';$('braking-hud-label').textContent=state.estop?'紧急制动':state.shiftPending?'换挡制动':state.autoLimitBraking?'限速自动制动':state.lastInput.brake>=1?'全力制动':'常规制动';$('speed-limit-label').textContent=String(state.speedLimit);$('target-kmh').textContent=(state.speedLimit*3.6).toFixed(0)+' km/h';$('odometer-live').textContent=car.distance.toFixed(1)+' m';$('distance-value').textContent=car.distance.toFixed(1);$('map-distance').textContent=car.distance.toFixed(1)+' m';$('heading-live').textContent=(Math.round(car.heading)%360)+'°';$('acceleration-live').textContent=car.acceleration.toFixed(2)+' m/s²';$('position-text').textContent=`X ${car.x.toFixed(1)} · Y ${car.y.toFixed(1)} m`;$('heading-text').textContent=String(Math.round(car.heading)%360).padStart(3,'0')+'°';$('steering-angle').textContent=(car.steer*180/Math.PI).toFixed(1)+'°';$('steering-indicator').style.transform=`rotate(${car.steer*180/Math.PI*3}deg)`;
  const touchingWall=!!car.wallContact&&moving,touchingTraffic=performance.now()<state.contactUntil;
  const drivingLabel=state.autodrive.active?(state.autodrive.reason||'全自动驾驶中'):state.exitActive?(state.exitCompleted?(braking?'普通道路 · 正在制动':moving?(state.exitCruise?'普通道路 · AI 巡航':car.gear==='reverse'?'普通道路 · 倒车':'普通道路 · 持续行驶'):'普通道路 · 已停稳'):braking?'出口路线 · 减速至 40 km/h':'沿出口匝道驶离高速'):state.shoulderAlert?(state.estop?(moving?'应急车道 · 紧急制动':'应急车道 · 已停稳锁定'):(moving?'正在返回右车道':'返回右车道 · 按油门继续')):state.laneChanging?(moving?`正在变道至${laneName(state.laneTarget)}`:`待起步 → ${laneName(state.laneTarget)}`):state.shiftPending&&moving?'减速至停稳 · 准备换挡':state.autoLimitBraking&&braking?'超速自动制动 · 降至限速':braking?'正在制动，车辆仍在移动':touchingWall?'沿护栏擦行 · 摩擦减速':touchingTraffic?'车辆接触 · 控制仍可用':moving?(car.gear==='reverse'?(state.lastInput.throttle?'正在倒车':'倒车惯性滑行'):(state.lastInput.throttle?'正在加速 / 巡航':'松开油门，惯性滑行')):'车辆已停稳';$('camera-mode').textContent=(state.autodrive.active?'自动驾驶':state.plan?.status==='running'||state.exitCruise?'AI 试驾':'手动驾驶')+' · '+(car.gear==='reverse'?'R 倒车':'D 前进')+' · '+(state.wet?'湿滑路面':'干燥路面');$('camera-status').textContent=drivingLabel;$('safety-title').textContent=state.shoulderAlert?drivingLabel:state.estop?(moving?'紧急制动中':'已停稳 · 制动锁定'):drivingLabel;$('safety-description').textContent=state.shoulderAlert?(state.estop?(moving?`已制动 ${car.brakeDistance.toFixed(1)} m`:'停稳后可解除，返回右车道'):(moving?'自动回正居中，到达后解除警报':'按住油门，自动返回右车道')):state.estop?(moving?`已制动 ${car.brakeDistance.toFixed(1)} m`:'解除后不会自动行驶'):moving?`${car.speed.toFixed(1)} m/s · ${braking?'持续减速':'注意刹车距离'}`:'按住油门开始驾驶';document.querySelector('.safety-bar').classList.toggle('stopped',state.estop);$('emergency-stop').hidden=state.estop;$('reset-estop').hidden=!state.estop;$('reset-estop').disabled=moving;$('reset-estop').textContent=moving?'制动中，等待停稳':state.shoulderAlert?'解除并返回右车道':'解除制动锁定';$('connection-dot').classList.toggle('offline',!state.connected);$('connection-label').textContent=state.connected?'模拟连接正常':'失联，自动制动';$('camera-offline').hidden=state.connected;$('device-status').textContent=state.connected?'模拟连接正常':'已断开，制动中';$('toggle-connection').textContent=state.connected?'断开模拟连接':'恢复模拟连接';$('dry-road').classList.toggle('selected',!state.wet);$('dry-road').setAttribute('aria-pressed',String(!state.wet));$('wet-road').classList.toggle('selected',state.wet);$('wet-road').setAttribute('aria-pressed',String(state.wet));$('dry-road').disabled=car.braking;$('wet-road').disabled=car.braking;$('grip-value').textContent=state.wet?'μ 0.45':'μ 0.85';$('device-grip').textContent=state.wet?'0.45（湿滑）':'0.85（干燥）';$('device-rtt').textContent=location.protocol==='file:'?'本地文件 · 无网络请求':state.latency===null?'未测量 / 不可达':state.latency.toFixed(1)+' ms';$('device-power').textContent=Math.max(0,86-car.energyKWh/60*100).toFixed(1)+'% / '+((car.powerW||0)/1000).toFixed(1)+' kW';
  const road=state.trafficInfo=traffic.getSnapshot(trafficWorld,{...car,exitRoute:state.exitActive}),speedKmh=car.speed*3.6;road.speedLimitKmh=Math.round(currentRoadCap()*3.6);const overspeed=speedKmh>road.speedLimitKmh+.05;
  $('road-limit-sign').textContent=String(road.speedLimitKmh);
  $('road-limit-sign').setAttribute('aria-label',`道路限速${road.speedLimitKmh}公里每小时`);
  $('road-speed-status').textContent=state.autoLimitBraking?'自动制动至 '+road.speedLimitKmh+' km/h':'限速保护已开启';
  const travelDirection=Math.cos(motionHeading()*Math.PI/180)>=0?1:-1;
  const nextSign=traffic.nextLimit(car.y,travelDirection);
  const nextLimit=nextSign?.limitKmh;
  $('next-road-limit').textContent=state.exitCompleted?'普通道路 · 限速 50 km/h':state.exitActive?'出口匝道 · 限速 40 km/h':nextSign?`${car.gear==='reverse'?'倒车方向':'前方'} ${Math.ceil(Math.abs(nextSign.y-car.y))} m · 限速 ${nextLimit}`:'超速自动制动 · 达标后释放';
  const reverse=car.gear==='reverse',ahead=reverse?road.nearestBehind:road.nearestAhead,close=!!ahead&&ahead.distance<Math.max(10,car.speed*1.5);
  $('traffic-direction-label').textContent=reverse?'同车道后车':'同车道前车';
  $('traffic-gap').textContent=ahead?`${Math.max(0,ahead.distance).toFixed(0)} m`:reverse?'后方畅通':'前方畅通';
  $('traffic-status').textContent=ahead?`${close?'车距偏近 · ':''}${reverse?'后车':'前车'} ${ahead.speedKmh.toFixed(0)} km/h`:'同向 / 对向车流运行中';
  document.querySelector('.road-awareness').classList.toggle('overspeed',overspeed);
  document.querySelector('.road-awareness').classList.toggle('auto-braking',state.autoLimitBraking);
  const max=state.requestedGear==='reverse'?physics.constants.maxReverseSpeed:100,shownTarget=Math.min(state.speedLimit,max);
  $('speed-slider').max=String(max);$('speed-slider').value=String(shownTarget);$('speed-slider').setAttribute('aria-label',`目标速度，最高${max}米每秒`);
  $('speed-slider').style.setProperty('--speed-progress',((shownTarget-1)/(max-1)*100)+'%');
  $('speed-limit-label').textContent=String(Number(shownTarget.toFixed(2)));$('target-kmh').textContent=(shownTarget*3.6).toFixed(0)+' km/h';
  $('effective-speed-note').textContent=`实际目标 ${(effectiveTarget(state.autodrive.active?100:state.speedLimit)*3.6).toFixed(0)} km/h · ${state.requestedGear==='reverse'?'倒车限速':'遵守路段限速'}`;
  $('gear-status').textContent=state.shiftPending?'减速换挡中':reverse?'R · 倒车':'D · 前进';
  $('gear-hint').textContent=state.shiftPending?'先停稳再换向，油门在换挡期间暂停':reverse?'倒车上限 5 m/s · 画面朝后，按住油门倒车':'换挡时先减速至停稳，再切换行驶方向';
  $('throttle-hint').textContent=state.requestedGear==='reverse'?'按住倒车':'按住前进';
  for(const gear of ['forward','reverse']){const button=$('gear-'+gear),selected=state.requestedGear===gear;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=state.estop||!state.connected||!cameraReady;}
  document.querySelector('.gear-control').classList.toggle('shifting',state.shiftPending);
  for(const button of document.querySelectorAll('[data-density]')){const selected=button.dataset.density===state.trafficDensity;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
  $('traffic-density-note').textContent=`${traffic.densityPresets[state.trafficDensity].label} · ${road.vehicleCount} 辆模拟车`;
  const sceneName=state.exitCompleted?'普通道路':state.exitActive?'出口匝道':'高速公路';
  $('view-title').textContent=state.map?'行驶轨迹':sceneName+(reverse?' · 倒车视角':' · 驾驶视角');
  $('road-scene-caption').textContent=state.exitCompleted?'实时车流 · 普通道路 · 双向行驶':state.exitActive?'实时驾驶 · 出口匝道 · 接入普通道路':'实时车流 · 高速公路 · 三车道';
  $('camera-panel').classList.toggle('reversing',reverse);
  $('lane-status').textContent=state.exitActive?(state.exitCompleted?'普通道路 · 自动居中':'出口匝道 · 自动循迹'):laneName(state.laneTarget)+(state.estop&&state.shoulderAlert?(moving?' · 制动中':' · 制动锁定'):state.laneChanging?(moving?' · 变道中':' · 待起步'):' · 已居中');
  $('lane-hint').textContent=state.exitCompleted?'保持本车道继续行驶，双黄线禁止跨越；可制动或换挡倒车':state.exitActive?'沿选定匝道接入普通道路，驶出后继续行驶':state.shoulderAlert?(state.estop?'应急车道已触发急刹，停稳后解除并返回右车道':(moving?'正在自动返回右车道，到达中央后警报解除':'已选择返回右车道，重新按住油门驶回')):state.laneChanging?'自动移至目标车道中央，完成后可再次点按':state.laneTarget===2?'继续向右将进入应急车道，并触发紧急制动':car.gear==='reverse'?'倒车时左右仍按道路方向选择，自动移至车道中央':'每次点按切换相邻车道，松手后自动完成变道';
  document.querySelector('.highway-steering').classList.toggle('changing',state.laneChanging);
  for(const button of document.querySelectorAll('[data-lane-change]')){
    button.disabled=!!state.exitActive||state.estop||!state.connected||!cameraReady;
    button.classList.toggle('shoulder-next',button.dataset.laneChange==='1'&&state.laneTarget===2);
  }
  renderRoadEvents();renderLaneAdvice();renderAutodrive();renderHorn();
  $('shoulder-alert').hidden=!state.shoulderAlert;
  $('shoulder-alert-title').textContent=state.estop?(moving?'已进入应急车道 · 紧急制动':'应急车道 · 已停稳，制动锁定'):(moving?'正在返回右车道':'返回右车道 · 等待驾驶操作');
  $('shoulder-alert-detail').textContent=state.estop?(moving?'正在全力减速，仍有制动距离。请等待车辆停稳。':'点击底部“解除并返回右车道”，再按住油门驶回。'):(moving?'正在自动驶回并回正，到达右车道中央后警报解除。':'已选择右车道，按住油门自动驶回；到达中央后警报解除。');
  $('camera-panel').classList.toggle('shoulder-emergency',state.shoulderAlert);
  document.querySelector('.road-awareness').classList.toggle('contact',touchingWall||touchingTraffic);
  document.querySelector('.traffic-awareness').classList.toggle('close',close);
  $('camera-panel').classList.toggle('wall-contact',touchingWall||touchingTraffic);
  for(const button of document.querySelectorAll('[data-drive]')){button.classList.toggle('active',[...state.controls.values()].includes(button.dataset.drive));button.disabled=state.estop||!state.connected||!cameraReady;}const fps=state.connected&&!state.map?camera?.stats.fps:0;$('frame-rate').textContent=state.connected?`${fps||'—'} FPS`:'PAUSED';$('device-fps').textContent=fps?`${fps} FPS · ${camera.stats.backend}`:'画面暂停 / 测量中';const seconds=Math.floor(state.collision?state.collision.sessionSeconds:(performance.now()-state.started)/1000);$('session-clock').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');if(state.plan){$('task-action').disabled=state.plan.status==='ready'&&(state.estop||!state.connected||!cameraReady);let progress=state.plan.status==='completed'?1:state.plan.kind==='sequence'?state.plan.phase/state.plan.steps.length:state.plan.status==='running'&&!state.plan.motionStarted?0:state.plan.phase? .5+.5*(1-car.speed/Math.max(1,car.brakeStartSpeed)):state.plan.kind==='brake-test'?.5*Math.min(1,car.speed/effectiveTarget(state.plan.target,state.plan.gear)):.5*Math.min(1,(car.distance-state.plan.startDistance)/state.plan.distance);$('task-progress-fill').style.width=Math.max(0,Math.min(100,progress*100))+'%';}
  renderCollision();
  if(state.map){const scale=.5,latest=car.y;const originY=260+latest*scale;$('map-origin').setAttribute('transform',`translate(320 ${originY})`);$('map-origin').style.display=originY>=0&&originY<=330?'':'none';$('route-trail').setAttribute('points',state.trail.filter(p=>p[1]>latest-480&&p[1]<latest+160).map(([x,y])=>`${320+x*8},${260-(y-latest)*scale}`).join(' '));$('map-rover').setAttribute('transform',`translate(${320+car.x*8} 260) rotate(${car.heading})`);}
}
function drawCameraFrame(now){
  const pose={...car,exitRoute:state.exitActive,localRoad:state.exitCompleted,emergencyLaneAlert:state.shoulderAlert,
    wet:state.wet,brakePrediction:state.collision?0:state.predicted,brakeAnchor:state.brakeAnchor,
    traffic:trafficWorld.vehicles,roadSigns:state.exitCompleted?[]:traffic.signsAround(car.y),collisionEffect:state.collisionEffect};
  if(!camera.draw(pose,now))return false;
  collisionFramePending=false;$('camera-canvas').dataset.frame=String(camera.stats.frames);
  const seconds=(now-state.started)/1000;
  $('camera-live-clock').textContent=state.collision?(collisionAnimating()?'碰撞动画':'碰撞暂停'):
    String(Math.floor(seconds/60)).padStart(2,'0')+':'+(seconds%60).toFixed(1).padStart(4,'0');
  return true;
}
function tick(now){
  if(!document.hidden){
    const elapsed=(now-lastFrame)/1000;lastFrame=now;
    if(elapsed>.5&&!state.collision){
      if(car.speed>.01||state.controls.size||state.plan?.status==='running'||state.exitCruise||state.autodrive.active)failSafe('画面发生长时间停顿，自动接管制动');
      camera?.pause();
    }
    advanceElapsed(Math.min(Math.max(0,elapsed),60));
    const interval=1000/30;
    if(cameraReady&&state.connected&&!state.map&&(!state.collision||collisionFramePending||collisionAnimating())&&now-lastCameraFrame>=interval){
      lastCameraFrame=now-((now-lastCameraFrame)%interval);
      try{if(!drawCameraFrame(now)&&state.collision)finishCollisionAnimation({draw:false});}
      catch(error){
        cameraReady=false;$('camera-error').hidden=false;
        if(state.collision)finishCollisionAnimation({draw:false});else failSafe('画面丢失，继续全力制动');
        console.error(error);
      }
    }
    if(now-lastRender>100){render();lastRender=now;}
  }
  requestAnimationFrame(tick);
}
try{camera=window.RoverSimulator.createCamera($('camera-canvas'));cameraReady=true;}catch(error){$('camera-error').hidden=false;console.error(error);}
window.addEventListener('rover-camera-lost',()=>{cameraReady=false;if(state.collision)finishCollisionAnimation({draw:false});failSafe('画面丢失，继续全力制动');$('camera-error').hidden=false;});
async function probeLocalService(){if(location.protocol==='file:')return;if(document.hidden){setTimeout(probeLocalService,2000);return;}const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000),started=performance.now();try{const response=await fetch('./health.json?t='+Math.floor(started),{method:'HEAD',cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error();state.latency=performance.now()-started;}catch{state.latency=null;}finally{clearTimeout(timer);setTimeout(probeLocalService,2000);}}
function readState(){const road=traffic.getSnapshot(trafficWorld,{...car,exitRoute:state.exitActive});return {collision:state.collision?{...state.collision}:null,simulationPaused:!!state.collision,collisionAnimation:state.collisionEffect?{...state.collisionEffect,active:collisionAnimating()}:null,horn:{count:state.horn.count,status:state.horn.status,reason:state.horn.reason,vehicleId:state.horn.vehicleId,targetLane:state.horn.targetLane},autodrive:{active:state.autodrive.active,route:state.autodrive.route,status:state.autodrive.decision?.status||'idle',reason:state.autodrive.reason},roadType:currentRoadType(),exitCruise:state.exitCruise,road:state.exitCompleted?{type:'local',speedLimitKmh:50,solid:true,nextExit:null}:roadModel.getState(car.y),exit:state.exitActive?{...state.exitActive,completed:state.exitCompleted}:null,taskStep:state.plan?.kind==='sequence'?state.plan.steps[state.plan.phase]:null,taskWaiting:state.plan?.waitingReason||'',laneRecommendation:getLaneAdvice(),laneTarget:state.laneTarget,laneTargetName:state.exitCompleted?'普通道路本车道':laneName(state.laneTarget),laneChanging:state.laneChanging,emergencyLaneAlert:state.shoulderAlert,returningFromEmergencyLane:state.shoulderRecovery,gear:car.gear,requestedGear:state.requestedGear,signedSpeed:car.speed*(car.gear==='reverse'?-1:1),trafficDensity:state.trafficDensity,automaticSpeedLimit:true,autoLimitBraking:state.autoLimitBraking,effectiveTargetSpeed:effectiveTarget(state.autodrive.active?100:state.speedLimit),roadLimitKmh:Math.round(currentRoadCap()*3.6),overspeed:car.speed>currentRoadCap()+.01,trafficCount:road.vehicles.length,merging:road.merging,exiting:road.exiting,nearestAhead:road.nearestAhead,nearestBehind:road.nearestBehind,wallContact:car.wallContact,simulation:true,scenario:currentRoadType(),model:'simplified vehicle dynamics',connected:state.connected,emergencyBrake:state.estop,speed:car.speed,maxSpeed:100,targetSpeed:state.speedLimit,acceleration:car.acceleration,position:{x:car.x,y:car.y,heading:car.heading},distance:car.distance,braking:car.braking,brakeDistance:car.brakeDistance,lastBrakeDistance:car.lastBrakeDistance,predictedBrakingDistance:state.predicted,wet:state.wet,taskStatus:state.plan?.status||'none',cameraFps:camera?.stats.fps||0,localLatencyMs:state.latency};}
if(document.modelContext?.registerTool){const lifecycle=new AbortController();const definitions=[{name:'change_rover_simulation_lane',title:'切换模拟车辆车道',description:'Request one adjacent lane through the same controls as the left/right buttons. Left/right refer to the road. Entering the right emergency shoulder triggers physical emergency braking.',inputSchema:{type:'object',properties:{direction:{type:'string',enum:['left','right']}},required:['direction'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||!['left','right'].includes(input.direction))throw new Error('direction required');const accepted=requestLaneChange(input.direction==='left'?-1:1);if(accepted)switchMode('manual');return {accepted,...readState()};}},{name:'read_rover_simulation',title:'查看车辆物理模拟状态',description:'Read local highway physics, actual speed and physical braking distance. No real hardware.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:readState},{name:'stage_rover_simulation_command',title:'准备高速模拟任务',description:'Stage a local highway simulation plan for confirmation. Brake commands apply deceleration immediately; they do not teleport speed to zero.',inputSchema:{type:'object',properties:{command:{type:'string',minLength:1,maxLength:240}},required:['command'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||typeof input.command!=='string')throw new Error('command required');if(state.collision)return {status:'blocked',reason:'发生碰撞，请先重新开始'};switchMode('ai');$('command-input').value=input.command;return submitCommand(input.command);}},{name:'emergency_stop_rover_simulation',title:'全力制动模拟车辆',description:'Latch full emergency brakes in the local simulation. Speed decreases physically over a nonzero braking distance. Does not immediately stop or control real hardware.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false},execute(){emergencyStop();return readState();}}];for(const tool of definitions){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}
log('车道辅助已就绪：左右点按自动变道居中，进入应急车道会紧急制动');render();requestAnimationFrame(tick);probeLocalService();
