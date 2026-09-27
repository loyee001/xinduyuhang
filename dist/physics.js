(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // SI units throughout, except heading (degrees clockwise from north/+y).
  // This is a high-power demonstration vehicle, not a calibrated road car.
  const constants = Object.freeze({
    mass: 1400, wheelbase: 2.7, rho: 1.225, CdA: 0.66, Crr: 0.012,
    g: 9.81, dryMu: 0.85, wetMu: 0.45, maxSpeed: 100,
    maxDriveForce: 8000, maxPower: 650000,
    maxSteer: Math.PI / 6, steerRate: Math.PI / 3,
    drivetrainEfficiency: 0.9, accessoryPower: 500, maxSubstep: 1 / 120
  });
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const RAD_TO_DEG = 180 / Math.PI;

  function createState() {
    return {
      x: 0, y: 0, heading: 0, speed: 0, steer: 0, acceleration: 0,
      yawRate: 0, lateralAcceleration: 0, distance: 0, energyKWh: 0,
      powerW: 0, driveForce: 0, brakeForce: 0, dragForce: 0,
      rollingForce: 0, brakeDistance: 0, brakeStartSpeed: 0,
      braking: false, lastBrakeDistance: null, lastBrakeStartSpeed: null,
      brakeTime: 0, lastBrakeTime: null, elapsedTime: 0
    };
  }

  function normalizeInput(input) {
    input = input || {};
    return {
      throttle: clamp(finite(input.throttle, 0), 0, 1),
      brake: clamp(finite(input.brake, 0), 0, 1),
      steering: clamp(finite(input.steering, 0), -1, 1),
      targetSpeed: clamp(finite(input.targetSpeed, constants.maxSpeed), 0, constants.maxSpeed),
      wet: Boolean(input.wet)
    };
  }

  function forces(speed, steer, input) {
    const c = constants;
    const grip = (input.wet ? c.wetMu : c.dryMu) * c.mass * c.g;
    const drag = 0.5 * c.rho * c.CdA * speed * speed;
    const rolling = c.Crr * c.mass * c.g;
    // Limit the desired lateral force, then share the tyre friction circle
    // between turning and braking. Steering therefore lengthens a stop.
    let lateral = clamp(c.mass * speed * speed * Math.tan(steer) / c.wheelbase, -grip, grip);
    let brake = input.brake * grip;
    const requestedGrip = Math.hypot(lateral, brake);
    if (requestedGrip > grip) {
      const scale = grip / requestedGrip;
      lateral *= scale;
      brake *= scale;
    }
    const availableDriveGrip = Math.sqrt(Math.max(0, grip * grip - lateral * lateral));
    const availableDrive = input.throttle * Math.min(c.maxDriveForce, c.maxPower / Math.max(speed, 0.1));
    // A proportional governor with road-load feed-forward never applies a
    // brake or changes velocity directly. A lower target lets the car coast.
    const governedDrive = speed > input.targetSpeed ? 0 : Math.max(0,
      drag + rolling + c.mass * 2 * (input.targetSpeed - speed));
    const drive = input.brake > 0 ? 0 : Math.min(availableDrive, availableDriveGrip,
      input.targetSpeed === 0 ? 0 : governedDrive);
    const netForce = drive - drag - rolling - brake;
    return {
      drive, brake, drag, rolling,
      acceleration: speed === 0 && netForce < 0 ? 0 : netForce / c.mass,
      lateralAcceleration: lateral / c.mass
    };
  }

  function substep(state, input, dt) {
    const startSpeed = state.speed;
    const steerTarget = input.steering * constants.maxSteer;
    state.steer += clamp(steerTarget - state.steer, -constants.steerRate * dt, constants.steerRate * dt);
    const initial = forces(startSpeed, state.steer, input);
    const midSpeed = Math.max(0, startSpeed + initial.acceleration * dt / 2);
    const middle = forces(midSpeed, state.steer, input);
    // Use the initial deceleration if the midpoint prediction already crossed
    // zero. At rest the force model correctly reports zero acceleration.
    const acceleration = midSpeed === 0 && startSpeed > 0 ? initial.acceleration : middle.acceleration;
    const finalSpeed = Math.max(0, startSpeed + acceleration * dt);
    const movingTime = finalSpeed === 0 && acceleration < 0
      ? Math.min(dt, startSpeed / -acceleration) : dt;
    const travel = Math.max(0, (startSpeed + finalSpeed) * 0.5 * movingTime);
    const meanSpeed = (startSpeed + finalSpeed) / 2;
    const turnForces = forces(meanSpeed, state.steer, input);
    const curvature = meanSpeed > 1e-9 ? turnForces.lateralAcceleration / (meanSpeed * meanSpeed) : 0;
    const turn = curvature * travel;
    const halfTurn = turn / 2;
    const midpointHeading = state.heading / RAD_TO_DEG + halfTurn;
    const arcCorrection = Math.abs(halfTurn) > 1e-9 ? Math.sin(halfTurn) / halfTurn : 1;
    state.x += Math.sin(midpointHeading) * travel * arcCorrection;
    state.y += Math.cos(midpointHeading) * travel * arcCorrection;
    state.heading = ((state.heading + turn * RAD_TO_DEG) % 360 + 360) % 360;
    state.speed = finalSpeed;
    state.acceleration = (finalSpeed - startSpeed) / dt;
    state.yawRate = finalSpeed > 0 ? turn / dt : 0;
    state.lateralAcceleration = finalSpeed > 0 ? turnForces.lateralAcceleration : 0;
    state.distance += travel;
    state.elapsedTime += dt;
    state.driveForce = middle.drive;
    state.brakeForce = middle.brake;
    state.dragForce = middle.drag;
    state.rollingForce = startSpeed > 0 || finalSpeed > 0 ? middle.rolling : 0;
    // Positive battery energy only; regenerative braking is not modelled.
    const energyJ = middle.drive * travel / constants.drivetrainEfficiency + constants.accessoryPower * dt;
    state.energyKWh += energyJ / 3600000;
    state.powerW = energyJ / dt;
    if (state.braking) {
      state.brakeDistance += travel;
      state.brakeTime += movingTime;
      if (finalSpeed === 0) {
        state.lastBrakeDistance = state.brakeDistance;
        state.lastBrakeStartSpeed = state.brakeStartSpeed;
        state.lastBrakeTime = state.brakeTime;
        state.braking = false;
      }
    }
  }

  /** Mutates and returns state. steer and yawRate use radians and radians/s.
   * A braking measurement starts at brake application while moving and ends
   * at zero speed. Releasing early cancels the episode (its partial distance
   * remains visible), preserving lastBrakeDistance from the last full stop.
   * Applying the brake again starts a new measurement from the current speed.
   * No reaction time/distance is included. Inputs are held throughout dt.
   */
  function step(state, rawInput, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return state;
    const input = normalizeInput(rawInput);
    if (input.brake <= 0) state.braking = false;
    else if (!state.braking && state.speed > 0) {
      state.braking = true;
      state.brakeDistance = 0;
      state.brakeStartSpeed = state.speed;
      state.brakeTime = 0;
    }
    const steps = Math.ceil(dt / constants.maxSubstep);
    const subDt = dt / steps;
    for (let i = 0; i < steps; i += 1) substep(state, input, subDt);
    return state;
  }

  /** Straight, level-road stopping distance in metres; zero reaction distance.
   * Uses exactly the same force model and substep as step(). Brake defaults
   * to .55 (service); 1 represents maximum tyre-limited emergency braking.
   */
  function estimateBrakingDistance(speed, options) {
    options = options || {};
    const state = createState();
    state.speed = Math.max(0, finite(speed, 0));
    if (state.speed === 0) return 0;
    const input = { brake: clamp(finite(options.brake, 0.55), 0, 1), wet: Boolean(options.wet) };
    // Even brake=0 eventually stops under rolling resistance and aero drag.
    while (state.speed > 0) step(state, input, constants.maxSubstep);
    return state.distance;
  }

  return Object.freeze({ constants, createState, step, estimateBrakingDistance });
});
