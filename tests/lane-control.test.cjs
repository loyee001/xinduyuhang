'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../dist/physics.js');
const lane = require('../dist/lane-control.js');
const headingDegrees = car => Math.atan2(Math.sin(car.heading * Math.PI / 180),
  Math.cos(car.heading * Math.PI / 180)) * 180 / Math.PI;

function follow(car, targetX, { seconds = 40, wet = false, speed = car.speed,
  brake = 0, dt = 1 / 60 } = {}) {
  const result = { minimumX: car.x, maximumX: car.x, maxLateralAcceleration: 0,
    maxHeading: Math.abs(headingDegrees(car)), centeredAt: null };
  const frames = Math.ceil(seconds / dt);
  for (let i = 0; i < frames; i += 1) {
    const steering = lane.steeringFor(car, targetX, { wet });
    assert.ok(Number.isFinite(steering) && Math.abs(steering) <= 1);
    physics.step(car, { throttle: brake ? 0 : 1, brake, steering, wet,
      gear: car.gear, targetSpeed: speed, guardrails: false }, seconds / frames);
    result.minimumX = Math.min(result.minimumX, car.x);
    result.maximumX = Math.max(result.maximumX, car.x);
    result.maxLateralAcceleration = Math.max(result.maxLateralAcceleration,
      Math.abs(car.lateralAcceleration));
    result.maxHeading = Math.max(result.maxHeading, Math.abs(headingDegrees(car)));
    if (result.centeredAt === null && lane.isCentered(car, targetX)) {
      result.centeredAt = (i + 1) * seconds / frames;
    }
  }
  return result;
}

test('normal lane selection excludes the emergency shoulder', () => {
  assert.deepEqual(lane.constants.laneCenters, [-3.75, 0, 3.75]);
  assert.equal(lane.nearestLane(-20), 0);
  assert.equal(lane.nearestLane(0.1), 1);
  assert.equal(lane.nearestLane(3.9), 2);
  assert.equal(lane.nearestLane(lane.constants.shoulderCenter), 2);
  assert.ok(lane.constants.shoulderBoundary > lane.constants.laneCenters[2]);
});

test('lane completion requires both centring and an unwound heading and steering', () => {
  const car = physics.createState();
  assert.equal(lane.isCentered(car, 0), true);
  car.heading = 359.8;
  assert.equal(lane.isCentered(car, 0), true, 'wrapped angles should be equivalent');
  car.heading = 3;
  assert.equal(lane.isCentered(car, 0), false);
  car.heading = 0;
  car.steer = 0.04;
  assert.equal(lane.isCentered(car, 0), false);
  car.steer = 0;
  car.x = 0.2;
  assert.equal(lane.isCentered(car, 0), false);
});

for (const wet of [false, true]) {
  for (const speed of [1, 5, 22, 33]) {
    test(`physical lane changes settle in both directions at ${speed} m/s, wet=${wet}`, () => {
      const car = physics.createState();
      car.speed = speed;
      for (const target of [3.75, 0, -3.75, 0]) {
        const from = car.x;
        const result = follow(car, target, { speed, wet, seconds: speed === 1 ? 42 : 20 });
        assert.ok(lane.isCentered(car, target), `must settle at ${target}: ${JSON.stringify(car)}`);
        assert.ok(result.minimumX >= Math.min(from, target) - 0.04, 'no leftward overshoot');
        assert.ok(result.maximumX <= Math.max(from, target) + 0.04, 'no rightward overshoot');
        assert.ok(result.maxHeading < 21, 'must stay aligned with the highway');
        assert.ok(result.maxLateralAcceleration <= (wet ? 2.25 : 3.25), 'controlled lateral force');
        assert.ok(result.centeredAt < (speed === 1 ? 32 : 10), 'lane change must complete');
        assert.ok(car.speed > speed - 0.1, 'lane changes do not command longitudinal braking');
      }
    });
  }
}

for (const wet of [false, true]) {
  for (const speed of [1, 5]) {
    test(`reversing follows the same road lanes at ${speed} m/s, wet=${wet}`, () => {
      const car = physics.createState();
      car.gear = 'reverse';
      car.speed = speed;
      for (const target of [-3.75, 0, 3.75, 0]) {
        const startY = car.y;
        follow(car, target, { speed, wet, seconds: speed === 1 ? 42 : 20 });
        assert.ok(lane.isCentered(car, target));
        assert.ok(car.y < startY, 'reverse motion must still travel backwards');
        assert.ok(Math.abs(headingDegrees(car)) < 0.1);
        assert.equal(car.gear, 'reverse');
      }
      assert.ok(car.distance > 0);
    });
  }
}

test('a lane request cannot translate or rotate a stationary car', () => {
  const car = physics.createState();
  follow(car, 3.75, { speed: 0, seconds: 3 });
  assert.equal(car.x, 0);
  assert.equal(car.y, 0);
  assert.equal(car.heading, 0);
  assert.equal(car.distance, 0);
  assert.equal(lane.isCentered(car, 3.75), false);
  follow(car, 3.75, { speed: 5, seconds: 20 });
  assert.ok(lane.isCentered(car, 3.75), 'queued steering follows the lane once driving starts');
});

test('shoulder centring is a physical trajectory rather than a position snap', () => {
  const car = physics.createState();
  car.x = 3.75;
  car.speed = 33;
  const before = { x: car.x, y: car.y, heading: car.heading, speed: car.speed };
  lane.steeringFor(car, lane.constants.shoulderCenter);
  assert.deepEqual({ x: car.x, y: car.y, heading: car.heading, speed: car.speed }, before,
    'the controller must not mutate physical state');
  follow(car, lane.constants.shoulderCenter, { seconds: 1 });
  assert.ok(car.x > 3.75 && car.x < lane.constants.shoulderBoundary);
  follow(car, lane.constants.shoulderCenter, { seconds: 15 });
  assert.ok(lane.isCentered(car, lane.constants.shoulderCenter));
});

test('emergency braking keeps a finite steer trajectory, rests without drift, and can resume centring', () => {
  for (const wet of [false, true]) {
    const car = physics.createState();
    car.x = 3.75;
    car.speed = 33;
    for (let i = 0; car.x < lane.constants.shoulderBoundary && i < 3000; i += 1) {
      follow(car, lane.constants.shoulderCenter, { seconds: 1 / 60, speed: 33, wet });
    }
    assert.ok(car.x >= lane.constants.shoulderBoundary);
    const speedAtEntry = car.speed;
    follow(car, lane.constants.shoulderCenter, { seconds: 1 / 60, brake: 1, wet });
    assert.ok(car.speed > 0 && car.speed < speedAtEntry, 'braking must reduce speed over time');
    follow(car, lane.constants.shoulderCenter, { seconds: 12, brake: 1, wet });
    assert.equal(car.speed, 0);
    assert.ok(car.x < lane.constants.shoulderCenter + 0.05);
    assert.ok(car.x > lane.constants.shoulderBoundary);
    assert.ok(car.lastBrakeDistance > 0);
    const rest = { x: car.x, y: car.y, heading: car.heading };
    follow(car, lane.constants.shoulderCenter, { seconds: 3, brake: 1, wet });
    assert.deepEqual({ x: car.x, y: car.y, heading: car.heading }, rest);
    follow(car, lane.constants.shoulderCenter, { seconds: 20, speed: 5, wet });
    assert.ok(lane.isCentered(car, lane.constants.shoulderCenter));
  }
});

test('mobile rendering cadence does not change the destination lane', () => {
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    const car = physics.createState();
    car.speed = 33;
    const result = follow(car, -3.75, { seconds: 16, dt });
    assert.ok(lane.isCentered(car, -3.75));
    assert.ok(result.minimumX >= -3.79);
    assert.ok(result.centeredAt < 7);
  }
});
