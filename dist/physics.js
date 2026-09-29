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
    drivetrainEfficiency: 0.9, accessoryPower: 500, maxSubstep: 1 / 120,
    guardrailX: 6.45, guardrailImpactLoss: 0.06, guardrailScrapeDeceleration: 0.4
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
      brakeTime: 0, lastBrakeTime: null, elapsedTime: 0,
      wallContact: null, wallContactCount: 0
    };
  }

  function normalizeInput(input) {
    input = input || {};
    return {
      throttle: clamp(finite(input.throttle, 0), 0, 1),
      brake: clamp(finite(input.brake, 0), 0, 1),
      steering: clamp(finite(input.steering, 0), -1, 1),
      targetSpeed: clamp(finite(input.targetSpeed, constants.maxSpeed), 0, constants.maxSpeed),
      wet: Boolean(input.wet), guardrails: Boolean(input.guardrails)
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

  function arcPoint(x, y, heading, curvature, travel) {
    const halfTurn = curvature * travel / 2;
    const correction = Math.abs(halfTurn) > 1e-9 ? Math.sin(halfTurn) / halfTurn : 1;
    return {
      x: x + Math.sin(heading + halfTurn) * travel * correction,
      y: y + Math.cos(heading + halfTurn) * travel * correction,
      heading: heading + halfTurn * 2
    };
  }

  function firstRailHit(x, y, heading, curvature, travel) {
    const limit = constants.guardrailX;
    const epsilon = 1e-10;
    for (const side of [-1, 1]) {
      const outwardSpeed = side * Math.sin(heading);
      const outwardTurn = side * Math.cos(heading) * curvature;
      if (side * x >= limit - epsilon && (outwardSpeed > epsilon ||
        (Math.abs(outwardSpeed) <= epsilon && outwardTurn >= 0))) {
        return { side, travel: 0 };
      }
    }
    // Split at lateral extrema so a curved path cannot cross a rail and
    // return inside during the same substep without registering contact.
    const stops = [0, travel];
    if (Math.abs(curvature) > epsilon) {
      const endHeading = heading + curvature * travel;
      const low = Math.min(heading, endHeading);
      const high = Math.max(heading, endHeading);
      for (let n = Math.ceil(low / Math.PI); n * Math.PI < high; n += 1) {
        const at = (n * Math.PI - heading) / curvature;
        if (at > 0 && at < travel) stops.push(at);
      }
    }
    stops.sort((a, b) => a - b);
    for (let i = 1; i < stops.length; i += 1) {
      const endX = arcPoint(x, y, heading, curvature, stops[i]).x;
      const side = endX >= limit ? 1 : endX <= -limit ? -1 : 0;
      if (!side) continue;
      let low = stops[i - 1];
      let high = stops[i];
      for (let j = 0; j < 36; j += 1) {
        const mid = (low + high) / 2;
        if (side * arcPoint(x, y, heading, curvature, mid).x >= limit) high = mid;
        else low = mid;
      }
      return { side, travel: high };
    }
    return null;
  }

  function constrainToRails(state, motion, acceleration, curvature, dt) {
    const heading = state.heading / RAD_TO_DEG;
    const hit = motion.travel > 0
      ? firstRailHit(state.x, state.y, heading, curvature, motion.travel) : null;
    if (!hit) return motion;
    const contact = hit.side < 0 ? 'left' : 'right';
    const atHit = arcPoint(state.x, state.y, heading, curvature, hit.travel);
    const impactSpeed = Math.sqrt(Math.max(0, state.speed * state.speed + 2 * acceleration * hit.travel));
    const hitTime = state.speed + impactSpeed > 0 ? 2 * hit.travel / (state.speed + impactSpeed) : 0;
    const isNewContact = state.wallContact !== contact;
    if (isNewContact) state.wallContactCount += 1;
    const loss = isNewContact ? constants.guardrailImpactLoss * Math.abs(Math.sin(atHit.heading)) : 0;
    const slidingSpeed = impactSpeed * (1 - loss);
    const along = Math.cos(atHit.heading) >= 0 ? 1 : -1;
    const railHeading = along > 0 ? 0 : Math.PI;
    const steeringAway = hit.side * along * curvature < 0;
    const slideAcceleration = acceleration - (steeringAway ? 0 : constants.guardrailScrapeDeceleration);
    const remainingTime = Math.max(0, dt - hitTime);
    const speed = Math.max(0, slidingSpeed + slideAcceleration * remainingTime);
    const slideTime = speed === 0 && slideAcceleration < 0
      ? Math.min(remainingTime, slidingSpeed / -slideAcceleration) : remainingTime;
    const slideTravel = Math.max(0, (slidingSpeed + speed) * 0.5 * slideTime);
    // Deliberately simplified rail guidance, not rigid-body crash physics:
    // redirect along the rail, lose at most 6% on entry, then dissipate scrape
    // energy continuously. There is no brake input, control lock, or repeated
    // per-frame impact multiplier. Inward steering immediately leaves the rail.
    const end = arcPoint(hit.side * constants.guardrailX, atHit.y, railHeading,
      steeringAway ? curvature : 0, slideTravel);
    end.x = clamp(end.x, -constants.guardrailX, constants.guardrailX);
    return {
      ...end, speed, travel: hit.travel + slideTravel,
      movingTime: hitTime + slideTime,
      wallContact: steeringAway && slideTravel > 0 ? null : contact
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
    let motion = {
      ...arcPoint(state.x, state.y, state.heading / RAD_TO_DEG, curvature, travel),
      speed: finalSpeed, travel, movingTime, wallContact: null
    };
    if (input.guardrails) motion = constrainToRails(state, motion, acceleration, curvature, dt);
    const headingChange = motion.heading - state.heading / RAD_TO_DEG;
    const turn = Math.atan2(Math.sin(headingChange), Math.cos(headingChange));
    state.x = motion.x;
    state.y = motion.y;
    state.heading = ((motion.heading * RAD_TO_DEG) % 360 + 360) % 360;
    state.speed = motion.speed;
    state.wallContact = motion.wallContact;
    state.acceleration = (motion.speed - startSpeed) / dt;
    state.yawRate = motion.speed > 0 ? turn / dt : 0;
    state.lateralAcceleration = motion.speed > 0 ? turnForces.lateralAcceleration : 0;
    state.distance += motion.travel;
    state.elapsedTime += dt;
    state.driveForce = middle.drive;
    state.brakeForce = middle.brake;
    state.dragForce = middle.drag;
    state.rollingForce = startSpeed > 0 || motion.speed > 0 ? middle.rolling : 0;
    // Positive battery energy only; regenerative braking is not modelled.
    const energyJ = middle.drive * motion.travel / constants.drivetrainEfficiency + constants.accessoryPower * dt;
    state.energyKWh += energyJ / 3600000;
    state.powerW = energyJ / dt;
    if (state.braking) {
      state.brakeDistance += motion.travel;
      state.brakeTime += motion.movingTime;
      if (motion.speed === 0) {
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
   * Optional guardrails constrain x to +/- guardrailX with simplified sliding
   * guidance; disabled by default, including for straight-road stop estimates.
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
