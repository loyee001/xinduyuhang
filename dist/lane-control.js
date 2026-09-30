(function (root, factory) {
  'use strict';
  const physics = typeof module === 'object' && module.exports
    ? require('./physics.js') : root.RoverPhysics;
  const api = factory(physics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverLaneControl = api;
})(typeof window !== 'undefined' ? window : globalThis, function (physics) {
  'use strict';

  const constants = Object.freeze({
    laneCenters: Object.freeze([-3.75, 0, 3.75]),
    shoulderCenter: 7.125,
    shoulderBoundary: 5.625
  });
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const bodyHeading = car => {
    const angle = finite(car.heading) * Math.PI / 180;
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  };

  /** The emergency shoulder is deliberately excluded from normal lanes. */
  function nearestLane(x) {
    let nearest = 0;
    for (let i = 1; i < constants.laneCenters.length; i += 1) {
      if (Math.abs(finite(x) - constants.laneCenters[i]) <
        Math.abs(finite(x) - constants.laneCenters[nearest])) nearest = i;
    }
    return nearest;
  }

  /**
   * A damped geometric path follower. The app selects one target lane; this
   * controller only requests steering, leaving all motion to RoverPhysics.
   * Speed-scaled lookahead limits lateral acceleration at highway speed. The
   * heading term unwinds the steering before the lane centre, so the vehicle
   * arrives facing along the road instead of continuing to rotate.
   *
   * Coordinates refer to the road: a larger targetX is always to its right.
   * Reverse gear changes the heading feedback sign, while body heading itself
   * stays unchanged. This lets the same target lane work in either direction.
   */
  function steeringFor(car, targetX, { wet = false } = {}) {
    if (!Number.isFinite(targetX)) return 0;
    const speed = Math.max(0, finite(car.speed));
    const direction = car.gear === 'reverse' ? -1 : 1;
    const heading = bodyHeading(car);
    const error = targetX - finite(car.x);
    const lookahead = Math.max(5.5, speed * (wet ? 1.7 : 1.4));
    const curvature = (2 * error * Math.cos(heading) -
      3 * direction * lookahead * Math.sin(heading)) /
      (lookahead * lookahead + error * error);
    // Reserve grip for braking and avoid an abrupt full-lock highway turn.
    // The physics model still applies its own friction circle and steer rate.
    const maximumCurvature = (wet ? 2.2 : 3.2) / Math.max(speed * speed, 1);
    const requested = Math.atan(physics.constants.wheelbase *
      clamp(curvature, -maximumCurvature, maximumCurvature));
    return clamp(requested / physics.constants.maxSteer, -1, 1);
  }

  function isCentered(car, targetX) {
    return Number.isFinite(targetX) && Math.abs(finite(car.x) - targetX) <= 0.08 &&
      Math.abs(bodyHeading(car)) <= 0.6 * Math.PI / 180 &&
      Math.abs(finite(car.steer)) <= 0.015;
  }

  return Object.freeze({ constants, nearestLane, steeringFor, isCentered });
});
