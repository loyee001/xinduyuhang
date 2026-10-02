'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pilot = require('../dist/autopilot.js');
const traffic = require('../dist/traffic.js');
const physics = require('../dist/physics.js');
const road = require('../dist/road.js');
const lane = require('../dist/lane-control.js');
const car = (overrides = {}) => ({ x: 0, y: 0, speed: 25, heading: 0, steer: 0, gear: 'forward', elapsedTime: 10, ...overrides });
const vehicle = (overrides = {}) => ({ id: 1, x: 0, y: 90, speed: 15, lane: 1, direction: 1,
  length: 4.5, width: 1.85, ...overrides });
const world = vehicles => ({ vehicles, elapsedTime: 0, contacts: 0 });
function nextDrop(start = 0) {
  if (typeof traffic.nextLimit !== 'function') return traffic.signsAround(start, 5000).find(sign =>
    sign.y > start && traffic.limitAt(sign.y - .01) > sign.limitKmh);
  let probe = start;
  for (let index = 0; index < 20; index++) {
    const next = traffic.nextLimit(probe, 1);
    if (traffic.limitAt(next.y - .01) > next.limitKmh) return next;
    probe = next.y + .01;
  }
  throw new Error('No downward limit transition found in the test route');
}

test('empty highway cruise respects each current road cap and the requested lower target', () => {
  for (const y of [0, 3000, 9000]) {
    const advice = pilot.evaluate(world([]), car({ y, speed: 0 }));
    assert.ok(advice.targetSpeed <= traffic.limitAt(y) / 3.6);
    assert.equal(advice.throttle, 1);
    assert.equal(advice.brake, 0);
    assert.equal(advice.laneDirection, 0);
  }
  assert.equal(pilot.evaluate(world([]), car(), { targetSpeed: 12 }).targetSpeed, 12);
});

test('free beneficial adjacent lanes are chosen deterministically without crossing the shoulder', () => {
  const state = world([vehicle(), vehicle({ x: 3.75, lane: 2, y: 0 })]);
  const advice = pilot.evaluate(state, car());
  assert.equal(advice.laneDirection, -1);
  assert.equal(advice.status, 'changing');
  for (const [laneTarget, x] of [[0, -3.75], [2, 3.75]]) {
    const edge = pilot.evaluate(world([vehicle({ x, lane: laneTarget })]), car({ x }), { laneTarget });
    assert.equal(edge.laneDirection, laneTarget === 0 ? 1 : -1);
  }
});

test('solid lines and their prospective eight-second path veto autonomous lane changes', () => {
  for (const y of [150, 350, 500, 600]) {
    const state = world([vehicle({ y: y + 90 })]);
    const decision = pilot.evaluate(state, car({ y }));
    assert.equal(road.canChangeLane(y, { speed: 25, targetSpeed: 120 / 3.6 }).allowed, false);
    assert.equal(decision.laneDirection, 0, `y=${y}`);
  }
});

test('maneuvers, cooldown and an off-center body suppress repeated decisions', () => {
  const state = world([vehicle()]);
  for (const options of [{ laneChanging: true }, { cooldownUntil: 11 }, { laneTarget: 0 }])
    assert.equal(pilot.evaluate(state, car(), options).laneDirection, 0);
  assert.equal(pilot.evaluate(state, car({ x: .4 })).laneDirection, 0);
  assert.equal(pilot.evaluate(state, car(), { cooldownUntil: 10 }).laneDirection, -1);
});

test('locked, shoulder and reverse-shift states brake without changing velocity or steering', () => {
  for (const options of [{ locked: true }, { shoulderAlert: true }, { shiftPending: true }, { laneTarget: 3 }]) {
    const decision = pilot.evaluate(world([]), car(), options);
    assert.equal(decision.brake, 1);
    assert.equal(decision.throttle, 0);
    assert.equal(decision.targetSpeed, 0);
    assert.equal(decision.laneDirection, 0);
  }
  assert.equal(pilot.evaluate(world([]), car({ gear: 'reverse' })).status, 'shifting');
  assert.equal(pilot.evaluate(world([]), car({ x: 7 })).status, 'locked');
});

test('normal-road and ramp caps forbid lane changes and ignore irrelevant highway signs', () => {
  for (const [roadType, x, expected] of [['local', 29, 50], ['ramp', 12, 40]]) {
    const decision = pilot.evaluate(world([]), car({ x, y: 995, speed: 8 }), { roadType });
    assert.equal(decision.targetSpeed, expected / 3.6);
    assert.equal(decision.laneDirection, 0);
  }
  const local = pilot.evaluate(world([vehicle({ x: 29, y: 30, speed: 0 }),
    vehicle({ x: 25.5, y: 12, direction: -1 })]), car({ x: 29, speed: 12 }), { roadType: 'local' });
  assert.ok(local.brake > 0);
  assert.equal(local.laneDirection, 0);
});

test('a parked leader or a very short gap triggers real full braking, never an unsafe escape change', () => {
  for (const gap of [10, 20]) {
    const ego = car();
    const decision = pilot.evaluate(world([vehicle({ y: gap + 4.5, speed: 0 })]), ego);
    assert.equal(decision.brake, 1);
    assert.equal(decision.throttle, 0);
    assert.equal(decision.laneDirection, 0);
    assert.equal(ego.speed, 25);
  }
});

test('dense nearby lanes produce stable following instead of repeated unsafe changes', () => {
  const state = world([0, 1, 2].flatMap((laneIndex) => [
    vehicle({ id: laneIndex * 2, lane: laneIndex, x: [-3.75, 0, 3.75][laneIndex], y: 65, speed: 10 }),
    vehicle({ id: laneIndex * 2 + 1, lane: laneIndex, x: [-3.75, 0, 3.75][laneIndex], y: -20, speed: 14 })]));
  const decision = pilot.evaluate(state, car());
  assert.equal(decision.laneDirection, 0);
  assert.ok(decision.targetSpeed < 25);
  assert.ok(decision.brake > 0);
});

test('the destination corridor is watched from the beginning of an active lane change', () => {
  const decision = pilot.evaluate(world([vehicle({ x: -3.75, lane: 0, y: 25, speed: 0 })]), car(),
    { laneChanging: true, laneTarget: 0 });
  assert.equal(decision.brake, 1);
  assert.equal(decision.throttle, 0);
  assert.equal(decision.laneDirection, 0);
});

test('incoming yielding traffic reserves its destination before crossing the lane marking', () => {
  const incoming = vehicle({ x: 3.75, lane: 2, y: 30, speed: 5,
    laneChange: { fromLane: 2, targetLane: 1 } });
  const decision = pilot.evaluate(world([incoming]), car(), { allowLaneChange: false });
  assert.equal(decision.brake, 1);
  assert.equal(decision.throttle, 0);
  assert.equal(decision.laneDirection, 0);
  assert.equal(pilot.evaluate(world([{ ...incoming, laneChange: null }]), car(),
    { allowLaneChange: false }).brake, 0, 'ordinary adjacent traffic must not slow the ego car');
});

test('outgoing yielding leaders keep their source reserved until the change finishes', () => {
  const departing = vehicle({ x: 3.7, lane: 1, y: 30, speed: 5,
    laneChange: { fromLane: 1, targetLane: 2 } });
  const decision = pilot.evaluate(world([departing]), car(), { allowLaneChange: false });
  assert.equal(decision.brake, 1);
  assert.equal(decision.throttle, 0);
  departing.lane = 2;
  departing.x = 3.75;
  departing.laneChange = null;
  const clear = pilot.evaluate(world([departing]), car(), { allowLaneChange: false });
  assert.equal(clear.brake, 0);
  assert.equal(clear.throttle, 1);
});

test('ego destination monitoring includes a yielding car that has physically left that corridor', () => {
  const departing = vehicle({ x: -3.7, lane: 1, y: 25, speed: 0,
    laneChange: { fromLane: 1, targetLane: 0 } });
  const decision = pilot.evaluate(world([departing]), car({ x: 3.75 }),
    { laneChanging: true, laneTarget: 1 });
  assert.equal(decision.brake, 1);
  assert.equal(decision.throttle, 0);
  assert.equal(decision.laneDirection, 0);
});

test('dry and wet autopilot physically slows for a gradually merging yielding vehicle without contact', () => {
  for (const wet of [false, true]) {
    const ego = Object.assign(physics.createState(), car({ y: 700, speed: 25 }));
    const leader = vehicle({ x: 3.75, lane: 2, y: wet ? 850 : 810, speed: 8,
      laneChange: { fromLane: 2, targetLane: 1 } });
    const state = world([leader]);
    let contact = null, smallestGap = Infinity;
    for (let index = 0; index < 1200; index++) {
      const decision = pilot.evaluate(state, ego, { wet, allowLaneChange: false });
      const previous = { ...ego };
      physics.step(ego, { ...decision, wet, steering: 0 }, 1 / 120);
      leader.previousX = leader.x;
      leader.previousY = leader.y;
      const progress = Math.min(1, (index + 1) / 720);
      leader.x = 3.75 * (1 - progress * progress * (3 - 2 * progress));
      leader.y += leader.speed / 120;
      if (progress === 1) { leader.lane = 1; leader.laneChange = null; }
      contact ||= traffic.resolveContact(state, ego, previous);
      if (Math.abs(leader.x - ego.x) < 1.86) smallestGap = Math.min(smallestGap, leader.y - ego.y - 4.5);
    }
    assert.equal(contact, null, `wet=${wet}`);
    assert.ok(smallestGap > 7, `wet=${wet}, gap=${smallestGap}`);
    assert.ok(ego.speed < 12, 'the following speed changes through the physical controller');
  }
});

test('lower limits are anticipated before the sign, with earlier wet-road slowing', () => {
  const drop = nextDrop(), initialCap = traffic.limitAt(drop.y - .01);
  const dry = pilot.evaluate(world([]), car({ y: drop.y - 100, speed: initialCap / 3.6 }));
  const wet = pilot.evaluate(world([]), car({ y: drop.y - 100, speed: initialCap / 3.6 }), { wet: true });
  assert.equal(wet.status, 'anticipating-limit');
  assert.ok(wet.targetSpeed < dry.targetSpeed);
  assert.ok(wet.brake > 0);
  const close = pilot.evaluate(world([]), car({ y: drop.y - 40, speed: initialCap / 3.6 }));
  assert.equal(close.status, 'anticipating-limit');
  assert.ok(close.brake > 0);
  assert.equal(traffic.limitAt(drop.y - 40), initialCap, 'deceleration begins while the old cap still applies');
});

test('physical dry and wet approaches reach a lower limit before crossing its boundary', () => {
  for (const wet of [false, true]) {
    const drop = nextDrop(), initialCap = traffic.limitAt(drop.y - .01);
    const ego = Object.assign(physics.createState(), car({ y: drop.y - 350, speed: initialCap / 3.6 }));
    let previousSpeed = ego.speed;
    while (ego.y < drop.y) {
      const decision = pilot.evaluate(world([]), ego, { wet, cooldownUntil: Infinity });
      physics.step(ego, { ...decision, wet, steering: 0 }, 1 / 120);
      assert.ok(Math.abs(ego.speed - previousSpeed) < .1, 'velocity evolves continuously');
      previousSpeed = ego.speed;
    }
    assert.ok(ego.speed <= drop.limitKmh / 3.6 + .1, `wet=${wet}, crossing speed=${ego.speed}`);
  }
});

test('real physics stops behind parked and braking leaders without contact on dry and wet roads', () => {
  for (const wet of [false, true]) for (const moving of [false, true]) {
    const ego = Object.assign(physics.createState(), car({ speed: 30 }));
    const leader = vehicle({ y: wet ? 155 : 110, speed: moving ? 18 : 0 });
    const state = world([leader]);
    let smallestGap = Infinity;
    for (let index = 0; index < 2400; index++) {
      const decision = pilot.evaluate(state, ego, { wet, cooldownUntil: Infinity });
      physics.step(ego, { ...decision, wet, steering: 0 }, 1 / 120);
      const oldLeaderSpeed = leader.speed;
      leader.speed = Math.max(0, leader.speed - 5 / 120);
      leader.y += (oldLeaderSpeed + leader.speed) / 240;
      smallestGap = Math.min(smallestGap, leader.y - ego.y - 4.5);
    }
    assert.ok(smallestGap >= 6.5, `wet=${wet}, moving=${moving}, gap=${smallestGap}`);
    assert.equal(ego.speed, 0);
  }
});

test('the browser export matches Node and evaluating frozen inputs has no side effects', () => {
  const context = vm.createContext({ window: { RoverTraffic: traffic, RoverRoad: road,
    RoverLaneControl: lane, RoverPhysics: physics } });
  vm.runInContext(fs.readFileSync(require.resolve('../dist/autopilot.js'), 'utf8'), context);
  const ego = Object.freeze(car());
  const state = Object.freeze({ vehicles: Object.freeze([Object.freeze(vehicle())]) });
  const before = JSON.stringify({ state, ego });
  const first = pilot.evaluate(state, ego), second = pilot.evaluate(state, ego);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(context.window.RoverAutopilot.evaluate(state, ego)));
  assert.equal(JSON.stringify({ state, ego }), before);
  assert.doesNotThrow(() => pilot.evaluate(null, null));
});

test('the app can throttle costly recommendation checks without throttling immediate following and braking', () => {
  let recommendations = 0;
  const context = vm.createContext({ window: { RoverTraffic: { ...traffic,
    getLaneRecommendation(...args) { recommendations++; return traffic.getLaneRecommendation(...args); } },
    RoverRoad: road, RoverLaneControl: lane, RoverPhysics: physics } });
  vm.runInContext(fs.readFileSync(require.resolve('../dist/autopilot.js'), 'utf8'), context);
  const evaluate = context.window.RoverAutopilot.evaluate;
  const cruising = evaluate(world([vehicle()]), car(), { allowLaneChange: false });
  assert.equal(recommendations, 0);
  assert.equal(cruising.laneDirection, 0);
  const obstacle = evaluate(world([vehicle({ y: 15, speed: 0 })]), car(), { allowLaneChange: false });
  assert.equal(recommendations, 0);
  assert.equal(obstacle.brake, 1);
  assert.equal(obstacle.throttle, 0);
  const considered = evaluate(world([vehicle()]), car(), { allowLaneChange: true });
  assert.equal(recommendations, 1);
  assert.equal(considered.laneDirection, -1);
});

test('autopilot anticipates committed entrance traffic before body overlap and ignores a waiting ramp', () => {
  const entry=road.eventsAround(1800,1000).entrances[0];
  const arrival=vehicle({x:7.125,lane:6,y:entry.mergeStart,speed:10,
    entranceMerge:{event:entry,committed:true,status:'merging'}});
  const ego=car({x:3.75,y:arrival.y-40,speed:20});
  const options={allowLaneChange:false,laneTarget:2};
  const anticipates=pilot.evaluate(world([arrival]),ego,options);
  assert.ok(anticipates.brake>0);
  assert.ok(anticipates.targetSpeed<15);
  const waiting=pilot.evaluate(world([{...arrival,entranceMerge:{...arrival.entranceMerge,committed:false,status:'waiting'}}]),ego,options);
  const empty=pilot.evaluate(world([]),ego,options);
  assert.deepEqual(waiting,empty,'waiting outside the live lane does not obstruct highway traffic');
  const enteringLane=pilot.evaluate(world([arrival]),car({x:0,y:ego.y,speed:20}),{...options,laneChanging:true});
  assert.ok(enteringLane.brake>0,'ego destination reservation watches the incoming merger too');
});

test('dry and wet autopilot follows a real entrance maneuver through completion without contact', () => {
  const event=road.eventsAround(1800,1000).entrances[0];
  for(const wet of [false,true]) {
    const ego=Object.assign(physics.createState(),car({x:3.75,y:event.accelerationStart-110,speed:18}));
    const arrival=vehicle({id:1000,x:7.125,previousX:7.125,lane:6,y:event.accelerationStart,
      previousY:event.accelerationStart,speed:19,heading:0,cruiseFactor:.88,fromEntrance:true,
      entranceMerge:{event,committed:true,status:'merging',wet}});
    const state=world([arrival]);
    let closest=Infinity;
    for(let i=0;i<2400;i++) {
      const previous={...ego};
      const decision=pilot.evaluate(state,ego,{wet,laneTarget:2,allowLaneChange:false});
      physics.step(ego,{...decision,steering:0,wet},1/120);
      traffic.step(state,ego,1/120,{roadModel:road,merging:false,wet});
      assert.equal(traffic.resolveContact(state,ego,previous),null);
      closest=Math.min(closest,arrival.y-ego.y-(arrival.length/2+2.25));
    }
    assert.equal(arrival.entranceMerge,null);
    assert.ok(closest>7,`wet=${wet}, gap=${closest}`);
    assert.ok(ego.y>event.mergeStart);
  }
});

test('an exit leader is followed around the curve before reaching the current x corridor', () => {
  const exit=road.getState(1000).nextExit,y=exit.entryStart+160;
  const ego=car({x:road.centerForExit(exit,y),y,speed:40/3.6});
  const leader=vehicle({x:road.centerForExit(exit,y+42),y:y+42,speed:0,lane:2,
    exitRoute:{event:exit,status:'ramp'}});
  assert.ok(leader.x-ego.x>3,'the leading car has already turned out of the straight corridor');
  const options={roadType:'ramp',exitRoute:exit};
  const decision=pilot.evaluate(world([leader]),ego,options);
  assert.ok(decision.brake>0);assert.ok(decision.targetSpeed<ego.speed);
  assert.equal(decision.laneDirection,0);
  const empty=pilot.evaluate(world([]),ego,options);
  for(const unrelated of [
    {...leader,x:3.75,exitRoute:null},
    {...leader,x:3.75},
    {...leader,exitRoute:{event:{...exit,id:'different-exit'},status:'ramp'}},
    {...leader,y:y-20,x:road.centerForExit(exit,y-20)}
  ]) assert.deepEqual(pilot.evaluate(world([unrelated]),ego,options),empty,
    'a separate highway lane, other route or car behind does not block the ramp');
});

test('turning exit trucks remain physical obstacles only while their body overlaps the highway', () => {
  const ego=car({x:3.75,y:1200,speed:20});
  const truck=vehicle({x:6.2,y:1220,speed:0,lane:2,heading:5.15,width:2.35,length:8.4,
    exitRoute:{event:road.getState(1000).nextExit,status:'ramp'}});
  const options={laneTarget:2,allowLaneChange:false};
  assert.equal(pilot.evaluate(world([truck]),ego,options).brake,1,
    'the angled rear of the truck still occupies the right lane');
  assert.deepEqual(pilot.evaluate(world([{...truck,x:7}]),ego,options),
    pilot.evaluate(world([]),ego,options),'fully separated exit traffic releases the highway');
});

test('same-exit following continues across the ordinary-road handoff', () => {
  const exit=road.getState(1000).nextExit;
  const ego=car({x:29,y:exit.rampEnd-15,speed:40/3.6});
  const leader=vehicle({x:29,y:exit.rampEnd+15,speed:0,lane:0});
  for(const exitRoute of [null,{event:exit,status:'local'}]) {
    const decision=pilot.evaluate(world([{...leader,exitRoute}]),ego,{roadType:'ramp',exitRoute:exit});
    assert.ok(decision.brake>0);assert.ok(decision.targetSpeed<ego.speed);
  }
  const local=pilot.evaluate(world([leader]),{...ego,y:exit.rampEnd+1},{roadType:'local',exitRoute:exit});
  assert.equal(local.brake,1);assert.equal(local.laneDirection,0);
});

test('dry and wet ramp following physically parks behind a stopped curved-path leader without contact', () => {
  const exit=road.getState(1000).nextExit,y=exit.entryStart+160;
  for(const wet of [false,true]) {
    const heading=Math.atan2(road.centerForExit(exit,y+1)-road.centerForExit(exit,y-1),2)*180/Math.PI;
    const ego=Object.assign(physics.createState(),car({x:road.centerForExit(exit,y),y,heading,speed:40/3.6}));
    const leader=vehicle({x:road.centerForExit(exit,y+42),y:y+42,speed:0,lane:2,
      heading:5,exitRoute:{event:exit,status:'ramp'}});
    const state=world([leader]),before=JSON.stringify(leader);
    let nearest=Infinity;
    for(let i=0;i<1800;i++) {
      const previous={...ego},decision=pilot.evaluate(state,ego,{roadType:'ramp',exitRoute:exit,wet});
      const lookahead=1.5*Math.max(5.5,ego.speed*(wet?1.7:1.4));
      const steering=lane.steeringFor(ego,road.centerForExit(exit,ego.y+lookahead),{wet});
      physics.step(ego,{...decision,steering,wet,guardrails:false},1/120);
      assert.equal(traffic.resolveContact(state,ego,previous),null);
      nearest=Math.min(nearest,leader.y-ego.y-4.5);
    }
    assert.equal(ego.speed,0,`wet=${wet} fully stops behind the queue`);
    assert.ok(nearest>7,`wet=${wet}, closest gap=${nearest}`);
    assert.equal(JSON.stringify(leader),before,'the controller never moves the observed NPC');
  }
});
