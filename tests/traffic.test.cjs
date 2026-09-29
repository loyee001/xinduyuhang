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
  const truck = vehicle({ x: 3.75, y: 0, previousY: 0, width: 2.35, length: 8.4 });
  const state = world([truck]);
  const ego = { x: 6.4, y: 0, heading: 90, speed: 20 };
  const contact = traffic.resolveContact(state, ego);
  assert.ok(contact);
  assert.ok(Math.abs(ego.x) <= traffic.constants.guardrailCenter);
  assert.ok(Math.abs(ego.y) >= truck.length/2 + .93);
  const centered = world([vehicle({ y: 0, previousY: 0 })]);
  const scraping = { x: 1.7, y: 0, speed: 20, heading: 0 };
  traffic.resolveContact(centered, scraping);
  const firstSpeed = scraping.speed;
  scraping.x = 1.7;
  centered.elapsedTime = 1/60;
  traffic.resolveContact(centered, scraping);
  assert.equal(scraping.speed, firstSpeed);
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
