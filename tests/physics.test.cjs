'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../dist/physics.js');
const { constants: c, createState, step, estimateBrakingDistance } = physics;

function runFor(state, input, seconds, dt = 1 / 60) {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i += 1) step(state, input, seconds / steps);
  return state;
}

function stopFrom(speed, options = {}, dt = 1 / 60) {
  const state = createState();
  state.speed = speed;
  const input = { brake: options.brake ?? 0.55, wet: options.wet ?? false };
  for (let i = 0; state.speed > 0 && i < 100000; i += 1) step(state, input, dt);
  assert.equal(state.speed, 0, 'vehicle must eventually stop');
  return state;
}

test('release throttle coasts; lowering the governor target cannot snap speed', () => {
  const state = createState();
  state.speed = 30;
  step(state, { throttle: 0, targetSpeed: 0 }, 0.1);
  assert.ok(state.speed > 29.9 && state.speed < 30);
  state.speed = 100;
  step(state, { throttle: 1, targetSpeed: 10 }, 0.1);
  assert.ok(state.speed > 99 && state.speed < 100);
  assert.equal(state.driveForce, 0);
});

test('the high-power governor reaches 100 m/s continuously and holds its target', () => {
  const state = createState();
  let lastSpeed = 0;
  for (let i = 0; i < 600; i += 1) {
    step(state, { throttle: 1, targetSpeed: 100 }, 0.1);
    assert.ok(state.speed - lastSpeed < c.maxDriveForce / c.mass * 0.1 + 1e-9);
    assert.ok(state.speed >= lastSpeed - 1e-9 && state.speed <= 100 + 1e-9);
    lastSpeed = state.speed;
  }
  assert.ok(Math.abs(state.speed - 100) < 0.01);
  assert.ok(state.powerW > 450000 && state.powerW < 500000);
  assert.ok(state.energyKWh > 1400 * 100 * 100 / 2 / c.drivetrainEfficiency / 3600000);
});

test('braking distance grows approximately as speed squared and wet grip extends it', () => {
  for (const brake of [0.55, 1]) {
    for (const wet of [false, true]) {
      const slow = estimateBrakingDistance(60 / 3.6, { wet, brake });
      const fast = estimateBrakingDistance(120 / 3.6, { wet, brake });
      assert.ok(fast / slow > 3.7 && fast / slow < 4.05);
    }
    assert.ok(estimateBrakingDistance(120 / 3.6, { wet: true, brake }) >
      estimateBrakingDistance(120 / 3.6, { wet: false, brake }) * 1.7);
  }
});

test('numerical straight-road estimates agree with the independent drag-plus-constant-force solution', () => {
  for (const speed of [60 / 3.6, 120 / 3.6, 100]) {
    for (const wet of [false, true]) {
      for (const brake of [0.55, 1]) {
        const a = ((wet ? c.wetMu : c.dryMu) * brake + c.Crr) * c.g;
        const b = 0.5 * c.rho * c.CdA / c.mass;
        const analytic = Math.log1p(b * speed * speed / a) / (2 * b);
        const numerical = estimateBrakingDistance(speed, { wet, brake });
        assert.ok(Math.abs(numerical - analytic) < 0.02, `${speed}, wet=${wet}, brake=${brake}`);
      }
    }
  }
});

test('measured stopping distance matches estimates at service and emergency input', () => {
  for (const speed of [60 / 3.6, 120 / 3.6, 100]) {
    for (const wet of [false, true]) {
      for (const brake of [0.55, 1]) {
        const state = stopFrom(speed, { wet, brake }, 0.1);
        const estimated = estimateBrakingDistance(speed, { wet, brake });
        assert.ok(Math.abs(state.lastBrakeDistance - estimated) <= Math.max(0.15, estimated * 0.01));
        assert.equal(state.braking, false);
        assert.equal(state.lastBrakeStartSpeed, speed);
        assert.ok(state.lastBrakeTime > 0);
      }
    }
  }
});

test('100 m/s emergency stops remain finite with the expected wet-road penalty', () => {
  const dry = estimateBrakingDistance(100, { brake: 1 });
  const wet = estimateBrakingDistance(100, { brake: 1, wet: true });
  assert.ok(dry > 500 && dry < 520);
  assert.ok(wet > 840 && wet < 870);
  assert.ok(estimateBrakingDistance(100) > dry);
});

test('emergency braking decelerates over time, never reverses, and rests without drifting', () => {
  const state = createState();
  state.speed = 100;
  step(state, { brake: 1 }, 0.1);
  assert.ok(state.speed > 98 && state.speed < 100);
  assert.equal(state.braking, true);
  assert.equal(state.lastBrakeDistance, null);
  runFor(state, { brake: 1 }, 30);
  assert.equal(state.speed, 0);
  assert.equal(state.braking, false);
  const stopped = { x: state.x, y: state.y, distance: state.distance, brakeDistance: state.lastBrakeDistance };
  runFor(state, { brake: 1, steering: 1 }, 5);
  assert.equal(state.speed, 0);
  assert.equal(state.x, stopped.x);
  assert.equal(state.y, stopped.y);
  assert.equal(state.distance, stopped.distance);
  assert.equal(state.lastBrakeDistance, stopped.brakeDistance);
});

test('releasing brakes cancels partial measurement, preserving the last complete stop', () => {
  const state = stopFrom(20, { brake: 1 });
  const previous = state.lastBrakeDistance;
  state.speed = 30;
  step(state, { brake: 0.55 }, 0.1);
  assert.equal(state.braking, true);
  assert.equal(state.brakeStartSpeed, 30);
  const partial = state.brakeDistance;
  step(state, { brake: 0 }, 0.1);
  assert.equal(state.braking, false);
  assert.equal(state.lastBrakeDistance, previous);
  assert.equal(state.brakeDistance, partial);
  const nextStart = state.speed;
  step(state, { brake: 1 }, 0.1);
  assert.equal(state.brakeStartSpeed, nextStart);
  assert.ok(state.brakeDistance < partial);
});

test('integration is stable for 10, 60, and 144 Hz callers', () => {
  const simulate = dt => {
    const state = createState();
    runFor(state, { throttle: 1, targetSpeed: 100 }, 10, dt);
    runFor(state, { steering: 0.2, brake: 0.55 }, 3, dt);
    runFor(state, { steering: -0.15 }, 2, dt);
    return state;
  };
  const coarse = simulate(0.1);
  for (const dt of [1 / 60, 1 / 144]) {
    const state = simulate(dt);
    assert.ok(Math.abs(state.speed - coarse.speed) < 0.03);
    assert.ok(Math.abs(state.distance - coarse.distance) < 0.05);
    assert.ok(Math.hypot(state.x - coarse.x, state.y - coarse.y) < 0.25);
    assert.ok(Math.abs(state.energyKWh - coarse.energyKWh) < 0.001);
  }
});

test('steering returns to centre, does not spin at rest, and uses +y north/+x east', () => {
  const stationary = createState();
  runFor(stationary, { steering: 1 }, 1);
  assert.equal(stationary.x, 0);
  assert.equal(stationary.y, 0);
  assert.equal(stationary.heading, 0);
  assert.equal(stationary.yawRate, 0);
  assert.equal(stationary.steer, c.maxSteer);
  step(stationary, { steering: 0 }, 0.1);
  assert.ok(stationary.steer > 0 && stationary.steer < c.maxSteer);
  runFor(stationary, {}, 1);
  assert.equal(stationary.steer, 0);
  const north = createState();
  north.speed = 10;
  step(north, {}, 0.1);
  assert.equal(north.x, 0);
  assert.ok(north.y > 0);
  const east = createState();
  east.speed = 10;
  east.heading = 90;
  step(east, {}, 0.1);
  assert.ok(east.x > 0);
  assert.ok(Math.abs(east.y) < 1e-9);
});

test('cornering and braking share finite tyre grip, so cornering lengthens a stop', () => {
  for (const wet of [false, true]) {
    const state = createState();
    state.speed = 100;
    state.steer = c.maxSteer;
    step(state, { steering: 1, brake: 1, wet }, 1 / 120);
    const maxTireForce = (wet ? c.wetMu : c.dryMu) * c.mass * c.g;
    assert.ok(Math.hypot(state.lateralAcceleration * c.mass, state.brakeForce) <= maxTireForce + 0.1);
    assert.ok(state.brakeForce < maxTireForce * 0.72);
    assert.ok(Math.abs(state.yawRate) <= (wet ? c.wetMu : c.dryMu) * c.g / state.speed + 1e-3);
    for (let i = 0; state.speed > 0 && i < 10000; i += 1) step(state, { steering: 1, brake: 1, wet }, 1 / 60);
    assert.equal(state.speed, 0);
    assert.ok(state.lastBrakeDistance > estimateBrakingDistance(100, { brake: 1, wet }) * 1.2);
  }
});

test('bounded randomized inputs keep all state values finite and velocity nonnegative', () => {
  const state = createState();
  let seed = 7919;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 6000; i += 1) {
    step(state, {
      throttle: random() * 1.4, brake: random() > 0.8 ? random() : 0,
      steering: random() * 2 - 1, targetSpeed: random() * 100, wet: random() > 0.5
    }, 0.002 + random() * 0.098);
    assert.ok(state.speed >= 0);
    for (const [key, value] of Object.entries(state)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), key);
    }
  }
  assert.equal(estimateBrakingDistance(0), 0);
  assert.equal(estimateBrakingDistance(NaN), 0);
  assert.equal(step(state, {}, 0), state);
});
