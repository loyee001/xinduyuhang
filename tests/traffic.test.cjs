'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const traffic = require('../dist/traffic.js');

function vehicle(overrides = {}) {
  return { id: 1, lane: 1, x: 0, y: 40, previousY: 40, speed: 20, direction: 1,
    heading: 0, length: 4.5, width: 1.85, height: 1.5, cruiseFactor: .85,
    kind: 'car', color: '#e7e7d9', ...overrides };
}
function world(vehicles) { return { vehicles, elapsedTime: 0, contacts: 0 }; }

test('the initial highway has clear nearby same-direction and opposing traffic', () => {
  const state = traffic.createState();
  assert.equal(state.vehicles.length, 78);
  assert.ok(state.vehicles.some(v => v.direction === -1 && v.y > 0 && v.y < 200));
  for (const lane of [0, 1, 2]) assert.ok(state.vehicles.some(v => v.lane === lane && v.y >= 50 && v.y <= 150));
  const snapshot = traffic.getSnapshot(state, { x: 0, y: 0 });
  assert.equal(snapshot.speedLimitKmh, 120);
  assert.equal(snapshot.nearestAhead.lane, 1);
  assert.ok(snapshot.nearestAhead.distance > 130 && snapshot.nearestAhead.distance < 140);
});

test('same-direction vehicles advance, opposing traffic approaches, ego controls stay untouched', () => {
  const state = traffic.createState();
  const own = state.vehicles.find(v => v.lane === 0 && v.y > 0);
  const opposing = state.vehicles.find(v => v.lane === 3 && v.y > 0);
  const ownY = own.y, opposingY = opposing.y;
  const ego = { x: 0, y: 0, speed: 0, heading: 0, braking: false, estop: false };
  const copy = { ...ego };
  traffic.step(state, ego, .5);
  assert.ok(own.y > ownY + 10);
  assert.ok(opposing.y < opposingY - 10);
  assert.deepEqual(ego, copy);
});

test('all posted signs and repeating zone boundaries agree with the speed-limit model', () => {
  for (const [y, expected] of [[0,120],[999.999,120],[1000,100],[1999.999,100],[2000,80],[2999.999,80],[3000,120],[1000000,100]]) {
    assert.equal(traffic.limitAt(y), expected);
  }
  for (const y of [-800, 0, 399, 400, 980, 1999, 3200, 1000000]) {
    const signs = traffic.signsAround(y);
    assert.ok(signs.length >= 6);
    for (const sign of signs) assert.equal(sign.limitKmh, traffic.limitAt(sign.y));
    for (let boundary = Math.ceil((y-1600)/1000)*1000; boundary <= y+1600; boundary += 1000) {
      assert.ok(signs.some(sign => sign.y === boundary));
    }
  }
});

test('NPCs keep a geometric gap when approaching a stopped queue for varied frame times', () => {
  for (const dt of [1/144, 1/60, .1, .75]) {
    const leader = vehicle({ id: 1, y: 130, speed: 0, cruiseFactor: 0 });
    const follower = vehicle({ id: 2, y: 0, speed: 35 });
    const state = world([follower, leader]);
    for (let elapsed = 0; elapsed < 15; elapsed += dt) {
      traffic.step(state, { x: 6, y: 0, speed: 0 }, dt);
      const gap = leader.y - follower.y - (leader.length + follower.length)/2;
      assert.ok(gap >= traffic.constants.minGap - 1e-8, `dt=${dt}, gap=${gap}`);
      assert.ok(Number.isFinite(follower.y) && Number.isFinite(follower.speed));
    }
    assert.ok(follower.speed < 1);
  }
});

test('NPC following treats a stopped ego as a leader without moving or braking ego', () => {
  const behind = vehicle({ y: -80, speed: 30 });
  const state = world([behind]);
  const ego = { x: 0, y: 0, speed: 0, heading: 0, braking: false };
  for (let i = 0; i < 900; i++) traffic.step(state, ego, 1/60);
  assert.ok(behind.y <= -7.5 + 1e-8);
  assert.ok(behind.speed < .1);
  assert.equal(ego.speed, 0);
  assert.equal(ego.braking, false);
});

test('recycling occurs beyond the far plane and never spawns over another car or ego', () => {
  const recycled = vehicle({ y: -2200 });
  const occupied = vehicle({ id: 2, y: 1750 });
  const near = vehicle({ id: 3, y: 150 });
  const state = world([recycled, occupied, near]);
  const nearY = near.y;
  traffic.step(state, { x: 0, y: 0, speed: 0 }, 1/60);
  assert.ok(recycled.y >= traffic.constants.spawnDistance);
  assert.ok(Math.abs(recycled.y - occupied.y) >= 85 + recycled.length);
  assert.ok(near.y > nearY && near.y < nearY + 1);
  assert.ok(Math.abs(recycled.y) > 1500);
});

test('swept contact catches a fast crossing and corrects distance without changing estop/brake flags', () => {
  const state = world([vehicle({ y: 21, previousY: 20 })]);
  const previous = { x: 0, y: 0, heading: 0, speed: 100, distance: 500, brakeDistance: 0 };
  const ego = { ...previous, y: 60, distance: 560, speed: 100, brakeDistance: 60, braking: true, estop: false };
  const contact = traffic.resolveContact(state, ego, previous);
  assert.equal(contact.vehicleId, 1);
  assert.equal(contact.side, false);
  assert.ok(ego.y < 16.5 && ego.y > 16);
  assert.ok(ego.speed < 20 && ego.speed >= 0);
  assert.ok(Math.abs(ego.distance - (500 + ego.y)) < 1e-8);
  assert.ok(Math.abs(ego.brakeDistance - ego.y) < 1e-8);
  assert.equal(ego.braking, true);
  assert.equal(ego.estop, false);
});

test('side contact separates bodies, while distant and invalid inputs remain harmless', () => {
  const v = vehicle({ y: 0, previousY: 0, speed: 15 });
  const state = world([v]);
  const ego = { x: .8, y: 0, speed: 20, heading: 0, distance: 0, braking: false };
  const contact = traffic.resolveContact(state, ego);
  assert.equal(contact.side, true);
  assert.ok(ego.x > (v.width + 1.86)/2);
  assert.ok(ego.speed > 18 && ego.speed < 20);
  assert.equal(traffic.resolveContact(state, { x: 6, y: 0, speed: 20 }), null);
  const before = v.y;
  for (const dt of [NaN, Infinity, -1, 0]) traffic.step(state, ego, dt);
  assert.equal(v.y, before);
});

test('a truck side contact at the guardrail stays inside the road; sustained scraping has one impact loss', () => {
  for (const side of [-1, 1]) {
    const railX = side < 0 ? traffic.constants.guardrailLeft : traffic.constants.guardrailRight;
    const truck = vehicle({ x: railX - side * 2.65, y: 0, previousY: 0, width: 2.35, length: 8.4 });
    const state = world([truck]);
    const ego = { x: railX - side * .05, y: 0, heading: 90, speed: 20 };
    const contact = traffic.resolveContact(state, ego);
    assert.ok(contact);
    assert.ok(ego.x >= traffic.constants.guardrailLeft && ego.x <= traffic.constants.guardrailRight);
    assert.ok(Math.abs(ego.y) >= truck.length/2 + .93);
  }
  const centered = world([vehicle({ y: 0, previousY: 0 })]);
  const scraping = { x: 1.7, y: 0, speed: 20, heading: 0 };
  traffic.resolveContact(centered, scraping);
  const firstSpeed = scraping.speed;
  scraping.x = 1.7;
  centered.elapsedTime = 1/60;
  traffic.resolveContact(centered, scraping);
  assert.equal(scraping.speed, firstSpeed);
});

test('right-lane side contact may separate into the paved emergency lane without crossing its outer rail', () => {
  const truck = vehicle({ x: 3.75, y: 0, previousY: 0, width: 2.35, length: 8.4 });
  const ego = { x: 6.4, y: 0, heading: 90, speed: 20, estop: false };
  const contact = traffic.resolveContact(world([truck]), ego);
  assert.equal(contact.side, true);
  assert.ok(ego.x > 6.45 && ego.x <= traffic.constants.guardrailRight);
  assert.equal(ego.y, 0);
  assert.equal(ego.estop, false, 'the controller, not collision separation, owns emergency-lane stopping');
});

test('a collision stopping an active brake measurement finalizes corrected values in the same frame', () => {
  const state = world([vehicle({ y: 10, previousY: 10, speed: 0 })]);
  const previous = { x: 0, y: 0, heading: 0, speed: 30, distance: 10,
    braking: true, brakeDistance: 10, brakeTime: 1, brakeStartSpeed: 35 };
  const ego = { ...previous, y: 10, distance: 20, speed: 29, brakeDistance: 20, brakeTime: 1.4,
    lastBrakeDistance: 2, lastBrakeTime: .4, lastBrakeStartSpeed: 5, estop: false };
  traffic.resolveContact(state, ego, previous);
  assert.equal(ego.speed, 0);
  assert.equal(ego.braking, false);
  assert.ok(Math.abs(ego.lastBrakeDistance - (10 + ego.y)) < 1e-8);
  assert.equal(ego.lastBrakeStartSpeed, 35);
  assert.ok(ego.lastBrakeTime > 1 && ego.lastBrakeTime < 1.4);
  assert.equal(ego.estop, false);
});

test('long-running traffic stays finite and collision-free in each NPC lane', () => {
  const state = traffic.createState();
  const ego = { x: 0, y: 0, speed: 33, heading: 0 };
  for (let i = 0; i < 2400; i++) {
    ego.y += ego.speed * .1;
    traffic.step(state, ego, .1);
    for (let lane = 0; lane < 6; lane++) {
      const cars = state.vehicles.filter(v => v.lane === lane).sort((a,b) => a.y-b.y);
      for (let n = 0; n < cars.length; n++) {
        assert.ok(Number.isFinite(cars[n].y) && Number.isFinite(cars[n].speed));
        if (n) assert.ok(cars[n].y-cars[n-1].y >= (cars[n].length+cars[n-1].length)/2+2.9);
      }
    }
  }
});

test('density presets change physical car counts, spacing and congested cruising speed', () => {
  const cases = [['low', '较少', 42], ['medium', '中等', 78], ['dense', '拥挤', 174]];
  const nearbyCounts = [], meanSpeeds = [];
  for (const [density, label, count] of cases) {
    const state = traffic.createState({ x: 0, y: 0 }, { density });
    const snapshot = traffic.getSnapshot(state, { x: 0, y: 0 });
    assert.equal(traffic.densityPresets[density].label, label);
    assert.equal(state.vehicles.length, count);
    assert.equal(snapshot.vehicleCount, count);
    assert.equal(snapshot.density, density);
    const lane = state.vehicles.filter(v => v.lane === 0).sort((a,b) => a.y-b.y);
    assert.ok(Math.abs(lane[1].y - lane[0].y - traffic.densityPresets[density].spacing) < 1e-8);
    nearbyCounts.push(state.vehicles.filter(v => v.direction === 1 && v.y > 0 && v.y < 300).length);
    meanSpeeds.push(state.vehicles.reduce((sum,v) => sum+v.speed, 0)/count);
  }
  assert.ok(nearbyCounts[2] >= nearbyCounts[1]*3, `visible near traffic: ${nearbyCounts}`);
  assert.ok(meanSpeeds[2] < meanSpeeds[1]*.6);
  assert.equal(traffic.createState({}, { density: 'invalid' }).density, 'medium');
});

test('switching density at speed preserves ego and leaves a clear front and rear spawn corridor', () => {
  const ego = { x: 0, y: 7341, heading: 0, speed: 100, gear: 'reverse',
    braking: true, brakeDistance: 18, distance: 2000, estop: false };
  const original = { ...ego }, state = traffic.createState(ego);
  state.elapsedTime = 30;
  state.contacts = 2;
  state.lastContact = { id: 2, time: 29 };
  for (const density of ['dense','low','medium']) {
    const result = traffic.setDensity(state, ego, density);
    assert.equal(result, state);
    assert.equal(state.vehicles.length, traffic.densityPresets[density].vehicleCount);
    assert.equal(state.elapsedTime, 30);
    assert.equal(state.contacts, 2);
    assert.equal(state.lastContact, null);
    assert.deepEqual(ego, original);
    const corridor = state.vehicles.filter(v => v.lane === 1);
    assert.ok(corridor.every(v => Math.abs(v.y-ego.y) >= 157.25));
    assert.ok(corridor.some(v => v.y < ego.y) && corridor.some(v => v.y > ego.y));
    for (const v of state.vehicles) assert.equal(v.previousY, v.y);
    assert.equal(traffic.resolveContact(state, ego, original), null);
    const stable = state.vehicles;
    traffic.setDensity(state, ego, density);
    assert.equal(state.vehicles, stable, 'reselecting current density should keep existing traffic');
  }
});

test('rear snapshot reports same-lane vehicles independently of the selected gear', () => {
  const state = world([vehicle({ id: 1, y: 45 }), vehicle({ id: 2, y: -20 }),
    vehicle({ id: 3, x: 3.75, y: -5 }), vehicle({ id: 4, y: -50 })]);
  for (const gear of ['forward','reverse']) {
    const snapshot = traffic.getSnapshot(state, { x: 0, y: 0, gear });
    assert.equal(snapshot.nearestAhead.id, 1);
    assert.equal(snapshot.nearestBehind.id, 2);
    assert.equal(snapshot.nearestBehind.distance, 15.5);
  }
});

test('backing into a rear car stops the ego without switching gear, controls, or phantom distance', () => {
  const state = world([vehicle({ y: -19, previousY: -20, speed: 5 })]);
  const previous = { x: 0, y: 0, heading: 0, speed: 10, gear: 'reverse', distance: 100,
    braking: true, brakeDistance: 2, brakeTime: .2, brakeStartSpeed: 12 };
  const ego = { ...previous, y: -25, distance: 125, brakeDistance: 27, brakeTime: .7, estop: false };
  const contact = traffic.resolveContact(state, ego, previous);
  assert.ok(contact);
  assert.equal(contact.relativeSpeed, 15, 'opposite travel directions add closing speed');
  assert.equal(ego.speed, 0);
  assert.equal(ego.gear, 'reverse');
  assert.equal(ego.estop, false);
  assert.ok(ego.y > -15 && ego.y < -14);
  assert.ok(Math.abs(ego.distance - (100 + Math.abs(ego.y))) < 1e-8);
  assert.ok(Math.abs(ego.lastBrakeDistance - (2 + Math.abs(ego.y))) < 1e-8);
  assert.equal(ego.braking, false);
});

test('reverse-facing travel uses its signed velocity when following a forward moving car', () => {
  const state = world([vehicle({ y: 21, previousY: 20, speed: 6 })]);
  const previous = { x: 0, y: 0, heading: 180, speed: 10, gear: 'reverse', distance: 0 };
  const ego = { ...previous, y: 25, distance: 25, braking: false };
  const contact = traffic.resolveContact(state, ego, previous);
  assert.ok(contact);
  assert.ok(Math.abs(contact.relativeSpeed - 4) < 1e-8);
  assert.ok(ego.speed > 5 && ego.speed < 6, 'matching world travel should not be treated as an opposing impact');
  assert.equal(ego.gear, 'reverse');
});

test('an NPC yields to reverse motion without retreating ahead of contact', () => {
  const forwardFollower = vehicle({ y: -35, speed: 15 });
  const reverseFollower = vehicle({ y: -35, speed: 15 });
  traffic.step(world([forwardFollower]), { x: 0, y: 0, speed: 12, gear: 'forward' }, 1);
  traffic.step(world([reverseFollower]), { x: 0, y: 0, speed: 12, gear: 'reverse' }, 1);
  assert.ok(reverseFollower.speed < forwardFollower.speed);

  const rear = vehicle({ y: -7.5, speed: 0, cruiseFactor: 0 });
  const state = world([rear]);
  const ego = { x: 0, y: 0, speed: 5, gear: 'reverse', heading: 0, distance: 0, estop: false };
  let contact = null;
  for (let i = 0; i < 40 && !contact; i++) {
    const previous = { ...ego };
    traffic.step(state, ego, .02);
    ego.y -= .1; ego.distance += .1;
    contact = traffic.resolveContact(state, ego, previous);
    assert.equal(rear.y, -7.5, 'a reversing ego must not drag the other vehicle backward');
  }
  assert.ok(contact);
  assert.equal(ego.speed, 0);
  assert.ok(ego.y >= rear.y + 4.5);
  assert.equal(ego.estop, false);
});

test('dense traffic remains separated and does not recycle its whole population every frame', () => {
  const state = traffic.createState({}, { density: 'dense' });
  const ego = { x: 0, y: 0, speed: 33, heading: 0, gear: 'forward' };
  let resetCount = 0;
  for (let i = 0; i < 1800; i++) {
    const oldY = state.vehicles.map(v => v.y);
    ego.y += ego.speed*.1;
    traffic.step(state, ego, .1);
    const resets = state.vehicles.filter((v,j) => Math.abs(v.y-oldY[j]) > 100).length;
    assert.ok(resets <= 8, `unexpected mass recycle: ${resets}`);
    resetCount += resets;
    for (let lane = 0; lane < 6; lane++) {
      const cars = state.vehicles.filter(v => v.lane === lane).sort((a,b) => a.y-b.y);
      for (let j = 1; j < cars.length; j++) {
        assert.ok(cars[j].y-cars[j-1].y >= (cars[j].length+cars[j-1].length)/2+2.9);
      }
    }
  }
  assert.ok(resetCount > state.vehicles.length, 'exercise multiple complete traffic rotations');
});

const cruisingEgo = (overrides = {}) => ({ x: 0, y: 0, speed: 25, heading: 0, gear: 'forward', ...overrides });
const slowLeader = (overrides = {}) => vehicle({ y: 90, speed: 15, ...overrides });
const laneCar = (lane, overrides = {}) => vehicle({ lane, x: [-3.75, 0, 3.75][lane], ...overrides });

test('advice recommends the clear adjacent lane in either direction with bumper gaps', () => {
  for (const [target, blocked, direction] of [[0, 2, 'left'], [2, 0, 'right']]) {
    const state = world([slowLeader(), laneCar(blocked, { id: 2, y: 0 })]);
    const advice = traffic.getLaneRecommendation(state, cruisingEgo());
    assert.equal(advice.status, 'recommend');
    assert.equal(advice.direction, direction);
    assert.equal(advice.targetLane, target);
    assert.equal(advice.currentLane, 1);
    assert.equal(advice.lanes[1].frontGap, 85.5);
    assert.equal(advice.lanes[target].frontGap, null);
    assert.equal(advice.lanes[target].rearGap, null);
    assert.equal(advice.lanes[target].safe, true);
    assert.equal(advice.lanes[blocked].safe, false);
    assert.match(advice.lanes[blocked].reason, /并排/);
  }
});

test('advice only permits one lane at a time at both road edges and excludes shoulder/opposite lanes', () => {
  for (const currentLane of [0, 2]) {
    const x = [-3.75, 0, 3.75][currentLane];
    const state = world([slowLeader({ lane: currentLane, x }),
      vehicle({ lane: 3, x: -25.75, y: 0, direction: -1 }),
      vehicle({ lane: 6, x: 7.125, y: 0, direction: 1 })]);
    const advice = traffic.getLaneRecommendation(state, cruisingEgo({ x }));
    assert.equal(advice.status, 'recommend');
    assert.equal(advice.targetLane, 1);
    assert.equal(advice.direction, currentLane === 0 ? 'right' : 'left');
    assert.deepEqual(advice.lanes.map(lane => lane.lane), [0, 1, 2]);
    assert.equal(advice.lanes[2 - currentLane].safe, false);
    assert.match(advice.lanes[2 - currentLane].reason, /跨越/);
  }
});

test('fast closing rear traffic vetoes a lane despite a large present gap', () => {
  const state = world([slowLeader(), laneCar(0, { y: -140, speed: 45 }), laneCar(2, { y: 0 })]);
  const advice = traffic.getLaneRecommendation(state, cruisingEgo());
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.targetLane, null);
  assert.equal(advice.lanes[0].rearGap, 135.5);
  assert.ok(advice.lanes[0].projectedRearGap < 0);
  assert.equal(advice.lanes[0].safe, false);
  assert.match(advice.lanes[0].reason, /后车快速接近/);
});

test('a farther fast rear car is not masked by the nearest rear vehicle', () => {
  const state = world([slowLeader(), laneCar(0, { id: 2, y: -70, speed: 25 }),
    laneCar(0, { id: 3, y: -150, speed: 47 }), laneCar(2, { id: 4, y: 0 })]);
  const advice = traffic.getLaneRecommendation(state, cruisingEgo());
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.lanes[0].rearGap, 65.5);
  assert.equal(advice.lanes[0].rearSpeed, 25);
  assert.ok(advice.lanes[0].projectedRearGap < 0);
  assert.equal(advice.lanes[0].safe, false);
});

test('a near rear follower blocks the lane even without a large closing speed', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader(), laneCar(0, { y: -24.5, speed: 25 }),
    laneCar(2, { y: 0 })]), cruisingEgo());
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.lanes[0].rearGap, 20);
  assert.match(advice.lanes[0].reason, /后方间距不足/);
});

test('front clearance uses the complete vehicle body, including trucks', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader(),
    laneCar(0, { y: 37, speed: 32, length: 8.4 }), laneCar(2, { y: 0 })]), cruisingEgo());
  assert.equal(advice.status, 'blocked');
  assert.ok(Math.abs(advice.lanes[0].frontGap - 30.55) < 1e-8);
  assert.match(advice.lanes[0].reason, /前方间距不足/);
});

test('prediction rejects a slow car that ego would catch during a gradual lane change', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader(), laneCar(0, { y: 160, speed: 10 }),
    laneCar(2, { y: 0 })]), cruisingEgo());
  assert.equal(advice.lanes[0].frontGap, 155.5);
  assert.ok(advice.lanes[0].projectedFrontGap < 25);
  assert.equal(advice.lanes[0].safe, false);
  assert.match(advice.lanes[0].reason, /变道期间.*前车/);
  assert.equal(advice.status, 'blocked');
});

test('front prediction budgets acceleration toward the requested speed, while rear prediction gives no acceleration credit', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader(),
    laneCar(0, { y: 54.5, speed: 25 }), laneCar(0, { id: 3, y: -44.5, speed: 27 })]), cruisingEgo());
  const left = advice.lanes[0];
  assert.equal(left.frontGap, 50);
  assert.ok(left.projectedFrontGap < 10, '50 m headway erodes during acceleration to 120 km/h');
  assert.equal(left.projectedRearGap, 26, 'rear gap assumes current speed, not intended acceleration');
  assert.equal(left.safe, false);
});

test('accelerating from low speed reserves the physical full-throttle travel distance before recommending a lane', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader({ y: 35, speed: 1.5 }),
    laneCar(0, { y: 130, speed: 8 }), laneCar(2, { y: 0 })]), cruisingEgo({ speed: 5 }), { desiredSpeed: 30 });
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.lanes[0].frontGap, 125.5);
  assert.ok(advice.lanes[0].projectedFrontGap < 30);
  assert.equal(advice.lanes[0].safe, false);
  assert.match(advice.lanes[0].reason, /变道期间.*前车/);
});

test('wet roads require more clearance and a longer prediction interval', () => {
  const state = world([slowLeader(), laneCar(0, { y: 44.5, speed: 25 }), laneCar(2, { y: 0 })]);
  const dry = traffic.getLaneRecommendation(state, cruisingEgo(), { desiredSpeed: 25 });
  const wet = traffic.getLaneRecommendation(state, cruisingEgo(), { wet: true, desiredSpeed: 25 });
  assert.equal(dry.status, 'recommend');
  assert.equal(dry.targetLane, 0);
  assert.equal(wet.status, 'blocked');
  assert.equal(wet.lanes[0].safe, false);
  const approaching = world([slowLeader(), laneCar(0, { y: -75, speed: 30 }), laneCar(2, { y: 0 })]);
  const dryRear = traffic.getLaneRecommendation(approaching, cruisingEgo(), { desiredSpeed: 25 });
  const wetRear = traffic.getLaneRecommendation(approaching, cruisingEgo(), { wet: true, desiredSpeed: 25 });
  assert.equal(dryRear.status, 'recommend');
  assert.equal(wetRear.status, 'blocked');
  assert.equal(wetRear.lanes[0].projectedRearGap, dryRear.lanes[0].projectedRearGap - 5);
});

test('open current lanes and equal congestion do not produce pointless lane changes', () => {
  assert.equal(traffic.getLaneRecommendation(world([]), cruisingEgo()).status, 'keep');
  assert.equal(traffic.getLaneRecommendation(world([slowLeader({ y: 400 })]), cruisingEgo()).status, 'keep');
  const congested = world([0, 1, 2].map(lane => laneCar(lane, { y: 65, speed: 15 })));
  const advice = traffic.getLaneRecommendation(congested, cruisingEgo());
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.direction, null);
  assert.match(advice.reason, /没有明显通行优势/);
});

test('higher user speed settings cannot invent an advantage above the road limit', () => {
  const ego = cruisingEgo({ y: 1200 });
  const advice = traffic.getLaneRecommendation(world([slowLeader({ y: 1250, speed: 100 / 3.6 })]), ego,
    { desiredSpeed: 100 });
  assert.equal(advice.status, 'keep');
  for (const lane of advice.lanes) assert.ok(lane.availableSpeed <= 100 / 3.6);
  const slowing = traffic.getLaneRecommendation(world([slowLeader({ y: 1265 })]), cruisingEgo({ y: 1200, speed: 35 }));
  assert.equal(slowing.status, 'unavailable');
  assert.match(slowing.reason, /限速/);
});

test('a reduced speed target does not describe a too-close leading car as clear traffic', () => {
  const advice = traffic.getLaneRecommendation(world([slowLeader({ y: 10, speed: 12 })]), cruisingEgo(),
    { desiredSpeed: 10 });
  assert.equal(advice.status, 'keep');
  assert.match(advice.reason, /留意前车/);
  assert.doesNotMatch(advice.reason, /通行顺畅/);
});

test('an empty adjacent lane cannot justify a departure that reaches the current leader before lateral clearance', () => {
  for (const gap of [10, 20]) {
    for (const wet of [false, true]) {
      const advice = traffic.getLaneRecommendation(world([slowLeader({ y: gap + 4.5 }),
        laneCar(2, { y: 0 })]), cruisingEgo(), { desiredSpeed: 30, wet });
      assert.equal(advice.lanes[0].safe, true, 'destination is clear; the danger is leaving this lane');
      assert.equal(advice.status, 'blocked', `gap=${gap}, wet=${wet}`);
      assert.equal(advice.targetLane, null);
      assert.equal(advice.direction, null);
      assert.match(advice.reason, /当前前车过近.*先减速/);
      assert.ok(advice.lanes[1].departureFrontGap < 10);
    }
  }
});

test('departure clearance accounts for low-speed acceleration and keeps useful highway recommendations', () => {
  for (const wet of [false, true]) {
    const low = traffic.getLaneRecommendation(world([slowLeader({ y: 64.5, speed: 2 }), laneCar(2, { y: 0 })]),
      cruisingEgo({ speed: 5 }), { desiredSpeed: 30, wet });
    assert.equal(low.lanes[1].frontGap, 60);
    assert.equal(low.status, 'blocked', `wet=${wet}`);
    assert.match(low.reason, /当前前车过近/);
    assert.ok(low.lanes[1].departureFrontGap < 10);
    const early = traffic.getLaneRecommendation(world([slowLeader(), laneCar(2, { y: 0 })]), cruisingEgo(),
      { desiredSpeed: 30, wet });
    assert.equal(early.status, 'recommend', `early departure remains useful, wet=${wet}`);
    assert.equal(early.targetLane, 0);
    assert.ok(early.lanes[1].departureFrontGap >= 10);
  }
});

test('wet departure reserves another second in the original lane', () => {
  const state = world([slowLeader({ y: 59.5 }), laneCar(2, { y: 0 })]);
  const dry = traffic.getLaneRecommendation(state, cruisingEgo(), { desiredSpeed: 25 });
  const wet = traffic.getLaneRecommendation(state, cruisingEgo(), { desiredSpeed: 25, wet: true });
  assert.equal(dry.status, 'recommend');
  assert.equal(dry.lanes[1].departureFrontGap, 15);
  assert.equal(wet.status, 'blocked');
  assert.equal(wet.lanes[1].departureFrontGap, 5);
  assert.match(wet.reason, /当前前车过近/);
});

test('the departure veto covers real collisions before the geometric steering controller clears the original lane', () => {
  const physics = require('../dist/physics.js');
  const laneControl = require('../dist/lane-control.js');
  for (const gap of [10, 20]) {
    for (const wet of [false, true]) {
      const ego = Object.assign(physics.createState(), cruisingEgo());
      const leader = slowLeader({ y: gap + 4.5 });
      const state = world([leader]);
      const advice = traffic.getLaneRecommendation(state, ego, { wet, desiredSpeed: 30 });
      assert.equal(advice.status, 'blocked');
      // Reproduce the previously unsafe maneuver by deliberately ignoring
      // the advice and feeding its former left target to the real controller.
      let collision = null;
      for (let elapsed = 0; elapsed < 4 && !collision; elapsed += 1 / 120) {
        const previous = { ...ego };
        leader.previousY = leader.y;
        leader.y += leader.speed / 120;
        physics.step(ego, { throttle: 1, targetSpeed: 30, wet,
          steering: laneControl.steeringFor(ego, -3.75, { wet }) }, 1 / 120);
        collision = traffic.resolveContact(state, ego, previous);
      }
      assert.ok(collision, `real body overlap must reproduce, gap=${gap}, wet=${wet}`);
      assert.ok(ego.x > -2.2, 'contact occurs before the car has cleared the original lane');
      assert.equal(laneControl.isCentered(ego, -3.75), false);
    }
  }
});

test('reverse, near-rest, emergency shoulder, and an unfinished lane change suppress advice', () => {
  const state = world([slowLeader()]);
  for (const pose of [{ gear: 'reverse' }, { speed: 0 }, { speed: 1.9 }, { x: 5.626 },
    { x: -5.626 }, { x: 1 }, { heading: 12 }]) {
    const advice = traffic.getLaneRecommendation(state, cruisingEgo(pose));
    assert.equal(advice.status, 'unavailable', JSON.stringify(pose));
    assert.equal(advice.targetLane, null);
    assert.equal(advice.direction, null);
  }
});

test('recommendations are deterministic and never mutate world, car, braking or controls', () => {
  const ego = Object.freeze(cruisingEgo({ braking: true, estop: false, steer: 0, throttle: .7 }));
  const state = Object.freeze({ vehicles: Object.freeze([Object.freeze(slowLeader())]),
    elapsedTime: 4, contacts: 0 });
  const before = JSON.stringify({ state, ego });
  const first = traffic.getLaneRecommendation(state, ego);
  const second = traffic.getLaneRecommendation(state, ego);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'recommend');
  assert.equal(first.targetLane, 0, 'equal free lanes use a deterministic left-hand tie break');
  assert.equal(JSON.stringify({ state, ego }), before);
  assert.equal(first.lanes.length, 3);
  assert.doesNotThrow(() => traffic.getLaneRecommendation(null));
});
