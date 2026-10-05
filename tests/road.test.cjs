'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const road = require('../dist/road.js');

test('solid zones and exits are deterministic world events in both directions', () => {
  const before = road.eventsAround(4800, 7000);
  road.eventsAround(99999);
  assert.deepEqual(road.eventsAround(4800, 7000), before);
  assert.deepEqual(road.getState(500).activeSolid, { id: 'solid-0', start: 350, end: 600 });
  assert.ok(road.eventsAround(-2400).solids.some(zone => zone.start < 0));
  assert.deepEqual(road.getState(-2000), road.getState(-2000));
});
test('solid-zone boundaries and clear gaps agree with the painted schedule', () => {
  for (const y of [350, 500, 600]) assert.equal(road.getState(y).solid, true);
  for (const y of [0, 349.999, 600.001, 1200]) assert.equal(road.getState(y).solid, false);
  assert.equal(road.getState(0).nextSolid.distance, 350);
  assert.equal(road.getState(0).nextExit.distance, 1200);
});
test('intervals and lengths vary while exits remain outside solid zones', () => {
  const { solids, exits } = road.eventsAround(8000, 12000);
  assert.ok(new Set(solids.slice(1).map((zone, i) => zone.start - solids[i].start)).size > 2);
  assert.ok(new Set(solids.map(zone => zone.end - zone.start)).size > 1);
  assert.ok(new Set(exits.slice(1).map((exit, i) => exit.start - exits[i].start)).size > 2);
  for (const exit of exits) assert.ok(!solids.some(zone => zone.end >= exit.openingStart && zone.start <= exit.openingEnd));
});
test('lane changes reserve an eight-second path and include the vehicle body', () => {
  assert.equal(road.canChangeLane(500).allowed, false);
  assert.equal(road.canChangeLane(0, { speed: 30 }).allowed, true);
  assert.equal(road.canChangeLane(100, { speed: 30, targetSpeed: 35 }).allowed, false);
  assert.equal(road.canChangeLane(0, { speed: 0, targetSpeed: 100 }).allowed, false);
  assert.equal(road.canChangeLane(602).allowed, false);
  assert.equal(road.canChangeLane(603).allowed, true);
  assert.ok(road.canChangeLane(500).remaining > 100);
});
test('reverse checks the road behind rather than the next forward solid', () => {
  assert.equal(road.canChangeLane(800, { speed: 5, gear: 'reverse' }).allowed, true);
  assert.equal(road.canChangeLane(640, { speed: 5, gear: 'reverse' }).allowed, false);
  assert.equal(road.canChangeLane(300, { speed: 5, gear: 'reverse' }).allowed, true);
  assert.equal(road.canChangeLane(349, { speed: 0, gear: 'reverse' }).allowed, false);
});
test('a drivable exit connects the right lane smoothly to the ordinary road', () => {
  const exit = road.getState(0).nextExit;
  assert.equal(exit.name, '1 号出口');
  assert.equal(exit.width, 5);
  assert.equal(exit.speedLimitKmh, 40);
  assert.equal(exit.entryStart,840);
  assert.equal(exit.decelerationStart,exit.entryStart);
  assert.equal(exit.splitStart,1200);
  assert.equal(exit.entryEnd,exit.splitStart);
  assert.equal(exit.decelerationCenter,7.125);
  assert.equal(exit.laneWidth,3);
  assert.equal(road.centerForExit(exit, exit.entryStart - 10), 3.75);
  assert.equal(road.centerForExit(exit, exit.entryStart), 3.75);
  assert.equal(road.centerForExit(exit, exit.entryStart + 100), 7.125);
  assert.equal(road.centerForExit(exit, exit.splitStart - 1), 7.125);
  assert.equal(road.centerForExit(exit, exit.splitStart), 7.125);
  assert.equal(road.centerForExit(exit, exit.splitStart + 420), 29);
  assert.equal(road.centerForExit(exit, exit.rampEnd), 29);
  assert.ok(exit.rampEnd - exit.splitStart - 420 >= 200);
  let previous = 3.75;
  for (let y = exit.entryStart; y <= exit.rampEnd; y++) {
    const x = road.centerForExit(exit, y);
    assert.ok(x >= previous && x - previous < .1);
    previous = x;
  }
  assert.equal(road.getState(exit.entryStart).activeExit.id, exit.id);
  assert.equal(road.getState(exit.rampEnd + 1).activeExit, null);
});
test('deceleration lanes remain parallel before the split and clear the mainline rail',()=>{
  for (const exit of road.eventsAround(0,20000).exits) {
    for (const y of [exit.entryStart,exit.entryStart+100,exit.splitStart,exit.splitStart+420]) {
      assert.ok(Math.abs(road.centerForExit(exit,y+.001)-road.centerForExit(exit,y-.001))<.000001,
        'lane-entry and ramp tangents remain continuous');
    }
    for(let y=exit.entryStart+100;y<=exit.splitStart;y++)
      assert.equal(road.centerForExit(exit,y),exit.decelerationCenter);
    for(let y=exit.splitStart;y<exit.rampEnd;y++) {
      const x=road.centerForExit(exit,y);
      if(Math.abs(x-8.9)<=exit.width/2+.6)
        assert.ok(y>=exit.openingStart&&y<=exit.openingEnd,'the entire branch clears the mainline outer rail');
    }
  }
});
test('overspeed returns start at the actual vehicle pose and join the right lane smoothly',()=>{
  const exit=road.getState(0).nextExit;
  for(const [y,speed] of [[exit.entryStart+120,27],[exit.splitStart+100,20],[exit.rampEnd-1,100]]) {
    const x=road.centerForExit(exit,y)+.35, heading=4;
    const route=road.createExitReturn(exit,{x,y,speed,heading});
    assert.equal(route.start,y);
    assert.equal(road.centerForReturn(route,y),x);
    assert.equal(road.centerForReturn(route,route.end),3.75);
    assert.equal(road.centerForReturn(route,route.end+1000),3.75);
    assert.ok(route.end-route.start>=speed*13);
    const entrySlope=(road.centerForReturn(route,y+.001)-x)/.001;
    assert.ok(Math.abs(entrySlope-Math.tan(heading*Math.PI/180))<.00001,'return preserves the starting tangent');
    const endSlope=(3.75-road.centerForReturn(route,route.end-.001))/.001;
    assert.ok(Math.abs(endSlope)<.00001,'return rejoins facing along the mainline');
    let previous=x;
    for(let at=y+.1;at<route.end;at+=.1) {
      const next=road.centerForReturn(route,at);
      assert.ok(Number.isFinite(next)&&Math.abs(next-previous)<.025,'return is a continuous drivable curve');
      previous=next;
    }
  }
  const invalid=road.createExitReturn(null,{x:NaN,y:Infinity,speed:NaN,heading:Infinity});
  assert.ok(Number.isFinite(road.centerForReturn(invalid,NaN)));
});
test('normal steering physically completes return connections without leaving their paved width',()=>{
  const physics=require('../dist/physics.js'), lane=require('../dist/lane-control.js');
  const exit=road.getState(0).nextExit;
  for(const speed of [12,33])for(const wet of [false,true])for(const offset of [100,210,649]) {
    const y=exit.splitStart+offset, x=road.centerForExit(exit,y);
    const heading=Math.atan2(road.centerForExit(exit,y+1)-road.centerForExit(exit,y-1),2)*180/Math.PI;
    const car=Object.assign(physics.createState(),{x,y,speed,heading});
    const route=road.createExitReturn(exit,car);
    for(let elapsed=0;elapsed<120&&!(car.y>=route.end&&lane.isCentered(car,3.75));elapsed+=.05) {
      const ahead=1.5*Math.max(5.5,car.speed*(wet?1.7:1.4)), previous={...car};
      physics.step(car,{steering:lane.steeringFor(car,road.centerForReturn(route,car.y+ahead),{wet}),
        throttle:1,targetSpeed:speed,gear:'forward',wet,guardrails:false},.05);
      assert.ok(car.y>previous.y,'return continues forwards');
      assert.ok(Math.hypot(car.x-previous.x,car.y-previous.y)<=speed*.05+.01,'no frame teleports');
      assert.ok(Math.abs(car.x-road.centerForReturn(route,car.y))+.95<route.width/2,
        'the complete car body remains on the connecting pavement');
    }
    assert.ok(car.y>=route.end&&lane.isCentered(car,3.75),'ordinary steering finishes in the right-lane center');
  }
});
test('the ordinary road has one lane in each direction and a separate speed limit', () => {
  assert.deepEqual(road.localRoad, { speedLimitKmh:50, laneCenter:29,
    oncomingLaneCenter:25.5, width:7, halfLaneWidth:1.75 });
  const exit = road.getState(0).nextExit;
  assert.equal(road.centerForExit(exit,exit.rampEnd),road.localRoad.laneCenter);
  assert.equal(road.centerForExit(exit,exit.rampEnd+10000),road.localRoad.laneCenter);
});
test('highway entrances recur in stable world cells including negative coordinates', () => {
  const first = road.getState(0).nextEntrance;
  assert.equal(first.id,'entrance-0');
  assert.equal(first.name,'1 号入口');
  assert.equal(first.start,1950);
  assert.equal(first.distance,1950);
  const events = road.eventsAround(0,20000).entrances;
  assert.ok(events.some(entrance=>entrance.start<0));
  assert.ok(events.length<20);
  for (let index=1;index<events.length;index++) {
    const interval=events[index].start-events[index-1].start;
    assert.ok(interval>=2340&&interval<=2460);
  }
  const saved=road.eventsAround(-1200,7000);
  road.eventsAround(999999,20000);
  assert.deepEqual(road.eventsAround(-1200,7000),saved);
});
test('entrance state includes the active merge and advances only after its end', () => {
  const entrance=road.getState(0).nextEntrance;
  assert.equal(road.getState(entrance.start-1).activeEntrance,null);
  for (const y of [entrance.start,entrance.accelerationStart,entrance.mergeStart,entrance.mergeEnd,entrance.end]) {
    assert.equal(road.getState(y).activeEntrance.id,entrance.id);
    assert.equal(road.getState(y).nextEntrance.id,entrance.id);
    assert.equal(road.getState(y).nextEntrance.distance,0);
  }
  assert.equal(road.getState(entrance.end+1).activeEntrance,null);
  assert.notEqual(road.getState(entrance.end+1).nextEntrance.id,entrance.id);
});
test('ordinary-road entrances have recurring manual turn windows and distinct highway handoffs',()=>{
  const first=road.getState(0).nextCityEntrance;
  assert.equal(first.id,'entrance-0');
  assert.equal(first.cityEntryStart,1860);
  assert.equal(first.cityEntryEnd,1885);
  assert.equal(first.cityJoinY,first.accelerationStart);
  assert.equal(first.citySpeedLimitKmh,20);
  assert.equal(first.cityWidth,5);
  assert.equal(first.distance,first.cityEntryStart);
  assert.equal(road.getState(first.cityEntryStart-1).activeCityEntrance,null);
  assert.equal(road.getState(first.cityEntryStart).activeCityEntrance.id,first.id);
  assert.equal(road.getState(first.cityEntryEnd).nextCityEntrance.id,first.id);
  assert.notEqual(road.getState(first.cityEntryEnd+.01).nextCityEntrance.id,first.id);
  assert.equal(road.getState(first.end).activeCityEntrance.id,first.id);
  assert.equal(road.getState(first.end+.01).activeCityEntrance,null);
  const entries=road.eventsAround(0,20000).entrances;
  for(let i=1;i<entries.length;i++)
    assert.ok(entries[i].cityEntryStart-entries[i-1].cityEntryStart>=2340&&
      entries[i].cityEntryStart-entries[i-1].cityEntryStart<=2460);
  assert.ok(entries.some(entrance=>entrance.cityEntryStart<0));
});
test('manual city turns preserve the actual starting pose and clear the opposing lane through the junction',()=>{
  const entry=road.getState(0).nextCityEntrance;
  for(const offset of [0,12.5,25]) {
    const car={x:29.03,y:entry.cityEntryStart+offset,heading:.3};
    const route=road.createCityEntrance(entry,car);
    assert.equal(route.cityEntryStart,car.y);
    assert.equal(route.id,entry.id);
    assert.equal(route.crossingEnd,car.y+60);
    assert.equal(road.centerForCityEntrance(route,car.y),car.x);
    const slope=(road.centerForCityEntrance(route,car.y+.001)-car.x)/.001;
    assert.ok(Math.abs(slope-Math.tan(car.heading*Math.PI/180))<.00001);
    assert.equal(road.centerForCityEntrance(route,route.crossingEnd),18);
    assert.equal(road.centerForCityEntrance(route,route.cityJoinY),7.125);
    assert.equal(road.centerForCityEntrance(route,route.mergeEnd),3.75);
    assert.equal(road.centerForCityEntrance(route,route.end+1000),3.75);
    for(const y of [route.crossingEnd,route.cityJoinY,route.mergeStart,route.mergeEnd])
      assert.ok(Math.abs(road.centerForCityEntrance(route,y+.001)-road.centerForCityEntrance(route,y-.001))<.000001,
        'city connector and highway ramp meet with a continuous tangent');
    for(let y=route.cityEntryStart;y<=route.crossingEnd;y+=.1) {
      const x=road.centerForCityEntrance(route,y);
      if(x-.95<=27.38&&x+.95>=27.12)
        assert.ok(y>=entry.cityJunctionStart&&y<=entry.cityJunctionEnd,'crossing the centerline is inside the marked opening');
    }
  }
  assert.equal(road.createCityEntrance(null,{}),null);
  assert.equal(road.centerForCityEntrance(null,NaN),29);
});
test('city turn physics stays on pavement through the opposing-lane crossing and the highway merge',()=>{
  const physics=require('../dist/physics.js'),lane=require('../dist/lane-control.js');
  const entry=road.getState(0).nextCityEntrance,speed=20/3.6;
  for(const offset of [0,12.5,25])for(const wet of [false,true]) {
    const car=Object.assign(physics.createState(),{x:29,y:entry.cityEntryStart+offset,speed});
    const route=road.createCityEntrance(entry,car);
    let crossed=false;
    for(let elapsed=0;elapsed<130&&!(car.y>=route.mergeEnd&&lane.isCentered(car,3.75));elapsed+=.05) {
      const before={...car},ahead=1.5*Math.max(5.5,car.speed*(wet?1.7:1.4));
      physics.step(car,{throttle:1,targetSpeed:speed,guardrails:false,wet,
        steering:lane.steeringFor(car,road.centerForCityEntrance(route,car.y+ahead),{wet})},.05);
      assert.ok(car.y>before.y&&Math.hypot(car.x-before.x,car.y-before.y)<=speed*.05+.01,'every frame follows physical motion');
      const angle=car.heading*Math.PI/180,halfBody=.95*Math.abs(Math.cos(angle))+2.5*Math.abs(Math.sin(angle));
      const halfRoad=car.y<route.cityJoinY?route.cityWidth/2:route.width/2;
      assert.ok(Math.abs(car.x-road.centerForCityEntrance(route,car.y))+halfBody<halfRoad,'whole vehicle fits on the connection');
      if(Math.abs(car.x-25.5)<=halfBody+1) {
        crossed=true;
        assert.ok(car.y>=entry.cityJunctionStart&&car.y<=entry.cityJunctionEnd,'opposing lane is crossed only inside the open intersection');
      }
    }
    assert.ok(crossed,'this is a real turn through the intersection, not a teleport');
    assert.ok(car.y>=route.mergeEnd&&lane.isCentered(car,3.75),'car finishes in the highway right lane');
  }
});
test('entrance roads bend smoothly into an acceleration lane and then the right lane', () => {
  const entrance=road.getState(0).nextEntrance;
  assert.equal(entrance.width,3);
  for (const y of [entrance.start-100,entrance.start]) assert.equal(road.centerForEntrance(entrance,y),18);
  for (const y of [entrance.accelerationStart,entrance.mergeStart-1,entrance.mergeStart]) assert.equal(road.centerForEntrance(entrance,y),7.125);
  for (const y of [entrance.mergeEnd,entrance.end,entrance.end+100]) assert.equal(road.centerForEntrance(entrance,y),3.75);
  let previous=18;
  for (let y=entrance.start;y<=entrance.end;y++) {
    const x=road.centerForEntrance(entrance,y);
    assert.ok(x<=previous&&previous-x<.15);
    previous=x;
  }
  for (const y of [entrance.start,entrance.accelerationStart,entrance.mergeStart,entrance.mergeEnd])
    assert.ok(Math.abs(road.centerForEntrance(entrance,y+.01)-road.centerForEntrance(entrance,y-.01))<.00001,'tangent is continuous at each segment boundary');
});
test('entrance corridors have guardrail clearance and do not overlap exit openings or solid zones', () => {
  const {entrances,exits,solids}=road.eventsAround(0,20000);
  for (const entrance of entrances) {
    assert.ok(!exits.some(exit=>exit.openingStart<=entrance.openingEnd&&exit.openingEnd>=entrance.openingStart));
    assert.ok(!solids.some(solid=>solid.start<=entrance.end&&solid.end>=entrance.start));
    for (let y=entrance.start;y<=entrance.mergeEnd;y++) {
      const x=road.centerForEntrance(entrance,y);
      if (Math.abs(x-8.9)<=entrance.width/2+.3)
        assert.ok(y>=entrance.openingStart&&y<=entrance.openingEnd,'the whole ramp is clear of the highway outer rail');
      assert.ok(x+entrance.width/2<road.localRoad.oncomingLaneCenter-road.localRoad.halfLaneWidth,'the ramp stays separate from the parallel ordinary road');
    }
  }
});
test('long-distance and invalid-input queries stay finite and bounded', () => {
  for (const y of [-10000000, 10000000, NaN, Infinity]) {
    const state = road.getState(y);
    assert.ok(Number.isFinite(state.nextSolid.start));
    assert.ok(Number.isFinite(state.nextExit.start));
    assert.ok(Number.isFinite(state.nextEntrance.start));
    assert.ok(Number.isFinite(road.canChangeLane(y, { speed: NaN }).remaining));
  }
  assert.ok(road.eventsAround(0, Infinity).solids.length < 30);
  assert.ok(road.eventsAround(0,Infinity).entrances.length<30);
});

test('Canvas fallback renders solid roads and exits through forward and reverse origin changes', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  let painted = 0, pathPoints = [], bottomCenter = null, roadAtBottom=false;
  const point = (x, y) => { assert.ok(Number.isFinite(x) && Number.isFinite(y)); pathPoints.push([x,y]); };
  const coversBottomCenter = () => {
    let inside = false;
    for (let i = 0, j = pathPoints.length-1; i < pathPoints.length; j = i++) {
      const [xi,yi] = pathPoints[i], [xj,yj] = pathPoints[j];
      if ((yi > 299) !== (yj > 299) && 195 < (xj-xi)*(299-yi)/(yj-yi)+xi) inside = !inside;
    }
    return inside;
  };
  const context2d = { createLinearGradient: () => ({ addColorStop() {} }), fillRect() { bottomCenter = null;roadAtBottom=false; },
    beginPath() { pathPoints = []; }, moveTo: point, lineTo: point, closePath() {},
    fill() { painted++; if (coversBottomCenter()) {bottomCenter = this.fillStyle;if(this.fillStyle==='rgb(81,89,97)')roadAtBottom=true;} } };
  const canvas = { width: 0, height: 0, getContext: kind => kind === '2d' ? context2d : null,
    getBoundingClientRect: () => ({ width: 390, height: 300 }), addEventListener() {}, removeEventListener() {} };
  const window = { RoverRoad: road, addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
  const context = vm.createContext({ window, performance: { now: () => 0 } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/simulator.js'), 'utf8'), context);
  const camera = window.RoverSimulator.createCamera(canvas);
  for (const [y, gear] of [[0,'forward'],[500,'forward'],[1200,'forward'],[1800,'reverse'],[500,'reverse'],[-400,'reverse']]) {
    const exit = road.getState(y).activeExit;
    const x = exit && y > 1400 ? road.centerForExit(exit,y) : 0;
    assert.equal(camera.draw({ x, y, heading: 0, gear, traffic: [] }), true);
    assert.equal(camera.stats.roadSolid, road.getState(y).solid);
    assert.equal(camera.stats.worldOrigin, Math.floor(y / 400) * 400);
  }
  assert.equal(camera.stats.backend, 'Canvas 2D');
  assert.ok(painted > 1000);
  for (const entrance of road.eventsAround(0,5000).entrances) {
    for (const y of [entrance.start+5,entrance.accelerationStart+5,entrance.mergeStart+5,entrance.mergeEnd-10]) {
      const x=road.centerForEntrance(entrance,y);
      camera.draw({x,y,heading:0,gear:'forward',traffic:[]});
      assert.equal(bottomCenter,'rgb(81,89,97)',`entrance has real continuous pavement at ${y} m`);
      assert.ok(camera.stats.nearbyEntrances>0);
    }
  }
  const exit = road.getState(0).nextExit;
  for(const y of [exit.entryStart+10,exit.entryStart+150,exit.splitStart-30,exit.splitStart+150]) {
    const x=y<exit.splitStart?exit.decelerationCenter:road.centerForExit(exit,y);
    camera.draw({x,y,heading:0,gear:'forward',traffic:[],exitRoute:exit});
    assert.equal(bottomCenter,'rgb(81,89,97)',`deceleration lane and ramp have actual pavement at ${y} m`);
  }
  for(const startY of [exit.splitStart-60,exit.splitStart+180,exit.rampEnd-5]) {
    const returnRoute=road.createExitReturn(exit,{x:road.centerForExit(exit,startY),y:startY,speed:30,heading:0});
    for(const fraction of [.1,.3,.5,.75,.98]) {
      const y=returnRoute.start+(returnRoute.end-returnRoute.start)*fraction;
      const x=road.centerForReturn(returnRoute,y);
      const heading=Math.atan2(road.centerForReturn(returnRoute,y+1)-road.centerForReturn(returnRoute,y-1),2)*180/Math.PI;
      camera.draw({x,y,heading,gear:'forward',traffic:[],exitRoute:exit,exitReturn:returnRoute});
      assert.equal(bottomCenter,'rgb(81,89,97)',`recovery connection has actual pavement at ${startY} / ${fraction}`);
      assert.equal(camera.stats.roadType,'return');
    }
  }
  const lateReturn=road.createExitReturn(exit,{x:29,y:exit.rampEnd-5,speed:30,heading:0});
  const followingEntrance=road.getState(exit.rampEnd).nextEntrance;
  for(const y of [followingEntrance.start+5,followingEntrance.accelerationStart+5,followingEntrance.mergeStart+5]) {
    const x=road.centerForEntrance(followingEntrance,y);
    camera.draw({x,y,heading:0,gear:'forward',traffic:[],exitRoute:exit,exitReturn:lateReturn});
    assert.equal(bottomCenter,'rgb(81,89,97)',`returning highway traffic retains real entrance pavement at ${y} m`);
    assert.ok(camera.stats.nearbyEntrances>0,'highway entrances remain present during a return');
    assert.equal(camera.stats.roadType,'return');
  }
  const followingExit=road.eventsAround(exit.rampEnd,5000).exits.find(other=>other.start>exit.start);
  camera.draw({x:followingExit.decelerationCenter,y:followingExit.entryStart+150,heading:0,gear:'forward',traffic:[],
    exitRoute:exit,exitReturn:lateReturn});
  assert.equal(bottomCenter,'rgb(81,89,97)','later exits retain their deceleration-lane pavement during a return');
  const remoteDeparture={id:303,kind:'car',color:'#ffffff',width:1.85,length:4.5,direction:1,heading:0,
    x:29,y:followingExit.rampEnd+760,exitRoute:{event:followingExit,status:'local'}};
  camera.draw({x:29,y:remoteDeparture.y-30,heading:0,gear:'forward',traffic:[remoteDeparture],
    exitRoute:exit,exitReturn:lateReturn});
  assert.equal(bottomCenter,'rgb(81,89,97)','other departing traffic keeps its continued ordinary road during a return');
  assert.equal(camera.stats.visibleTraffic,1,'other exit traffic is not dropped while returning');
  const beyondOldRoadEnd=exit.rampEnd+720;
  camera.draw({x:29,y:beyondOldRoadEnd,heading:0,gear:'forward',traffic:[]});
  assert.notEqual(bottomCenter,'rgb(81,89,97)','the unoccupied preview road has its original finite extent');
  for(const y of [beyondOldRoadEnd,exit.rampEnd+1200,exit.rampEnd+3500]) {
    const exiting={id:301,kind:'car',color:'#ffffff',width:1.85,length:4.5,direction:1,heading:0,x:29,y:y+30,
      exitRoute:{event:exit,status:'local'}};
    camera.draw({x:29,y,heading:0,gear:'forward',traffic:[exiting]});
    assert.equal(bottomCenter,'rgb(81,89,97)',`NPC ordinary road continues beyond the old 700 m cutoff at ${y} m`);
    assert.equal(camera.stats.visibleTraffic,1,'exiting NPC remains visible on that continued road');
    assert.equal(camera.stats.roadType,'highway','seeing an NPC exit does not switch the driver out of the highway');
  }
  for (const y of [exit.rampEnd-100,exit.rampEnd-1,exit.rampEnd,exit.rampEnd+20,6000,12340]) {
    const localRoad = y >= exit.rampEnd;
    camera.draw({ x:29, y, heading:0, gear:'forward', traffic:[], exitRoute:exit, localRoad });
    assert.equal(bottomCenter, 'rgb(81,89,97)', `continuous pavement before and after the connection at ${y} m`);
    assert.equal(camera.stats.roadType, localRoad ? 'local' : 'exit');
    assert.equal(camera.stats.nearbyEntrances,0,'entrances are hidden after choosing an exit route');
    if (localRoad) {
      assert.equal(camera.stats.nearbyExits,0,'later highway exits cannot overwrite the ordinary road');
      assert.equal(camera.stats.roadSolid,false,'highway solid-zone state is not reused on the ordinary road');
    }
  }
  const cityEntry=road.getState(exit.rampEnd).nextCityEntrance;
  for(const shift of [0,25]) {
    const cityRoute=road.createCityEntrance(cityEntry,{x:29,y:cityEntry.cityEntryStart+shift,heading:0});
    for(const y of [cityRoute.cityEntryStart+22,cityRoute.crossingEnd-10,cityRoute.crossingEnd+30,cityRoute.cityJoinY,
      cityRoute.mergeStart+60,cityRoute.mergeEnd+5]) {
      const x=road.centerForCityEntrance(cityRoute,y);
      const heading=Math.atan2(road.centerForCityEntrance(cityRoute,y+1)-road.centerForCityEntrance(cityRoute,y-1),2)*180/Math.PI;
      camera.draw({x,y,heading,gear:'forward',traffic:[],localRoad:true,exitRoute:exit});
      assert.ok(roadAtBottom,`city entrance pavement exists before selection at ${y} m`);
      assert.ok(camera.stats.nearbyCityEntrances>0);
      camera.draw({x,y,heading,gear:'forward',traffic:[],localRoad:true,exitRoute:exit,cityEntrance:cityRoute});
      assert.ok(roadAtBottom,`continuous pavement remains throughout the chosen city entrance at ${y} m`);
      assert.equal(camera.stats.roadType,'entrance');
    }
  }
  camera.draw({x:27.12,y:cityEntry.cityEntryStart-40,heading:0,gear:'forward',traffic:[],localRoad:true,exitRoute:exit});
  assert.equal(bottomCenter,'rgb(245,187,81)','ordinary-road centerlines remain solid outside intersections');
  camera.draw({x:27.12,y:cityEntry.cityEntryStart+22,heading:0,gear:'forward',traffic:[],localRoad:true,exitRoute:exit});
  assert.equal(bottomCenter,'rgb(81,89,97)','the city entrance has a visible centerline opening');
  camera.draw({ x:25.5, y:12340, heading:0, gear:'reverse', traffic:[], exitRoute:exit, localRoad:true });
  assert.equal(bottomCenter, 'rgb(81,89,97)', 'the opposing lane remains paved across distant reverse views');
  for (const y of [exit.entryStart-100,-2000,-12000]) {
    camera.draw({ x:29,y,heading:0,gear:'reverse',traffic:[],exitRoute:exit,localRoad:true });
    assert.equal(bottomCenter,'rgb(81,89,97)','ordinary-road reverse travel remains paved beyond the original connection');
    assert.equal(camera.stats.roadType,'local');
    assert.equal(camera.stats.nearbyExits,0);
  }
  camera.draw({ x:29, y:12340, heading:0, gear:'forward', localRoad:true, exitRoute:exit,
    traffic:[{ id:1,kind:'car',color:'#ffffff',width:1.85,length:4.5,x:0,y:12380,direction:1 }] });
  assert.equal(camera.stats.visibleTraffic,0,'unmapped highway traffic is not drawn on ordinary-road grass');
  camera.dispose();
  assert.equal(camera.draw({ x: 0, y: 0, heading: 0 }), false);
});
