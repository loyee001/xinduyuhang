(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./traffic.js') : root.RoverTraffic,
    node ? require('./road.js') : root.RoverRoad,
    node ? require('./lane-control.js') : root.RoverLaneControl,
    node ? require('./physics.js') : root.RoverPhysics);
  if (node) module.exports = api;
  if (root) root.RoverAutopilot = api;
})(typeof window !== 'undefined' ? window : globalThis, function (traffic, road, laneControl, physics) {
  'use strict';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

  /**
   * A stateless, forward-driving controller. It returns physical control
   * requests; neither vehicle velocity nor the traffic world is changed.
   * The app owns steering, route selection and the post-maneuver cooldown.
   */
  function evaluate(world, car, { wet = false, targetSpeed = 100, roadType = 'highway', laneTarget = 1,
    laneChanging = false, shoulderAlert = false, shiftPending = false, locked = false, cooldownUntil = 0,
    allowLaneChange = true } = {}) {
    car = car || {};
    const speed = Math.max(0, finite(car.speed)), y = finite(car.y), x = finite(car.x);
    const stopped = (status, reason) => ({ targetSpeed: 0, brake: 1, throttle: 0, laneDirection: 0, status, reason });
    if (locked) return stopped('locked', '驾驶控制已锁定，持续制动至停稳');
    if (shoulderAlert || (roadType === 'highway' &&
      (laneTarget < 0 || laneTarget > 2 || x > laneControl.constants.shoulderBoundary || x < -5.625)))
      return stopped('locked', '已到达应急车道或道路边界，保持制动等待接管');
    if (shiftPending || car.gear === 'reverse') return stopped('shifting', '先制动停稳，切换至前进挡后自动驾驶');

    const roadCap = (roadType === 'local' ? road.localRoad.speedLimitKmh :
      roadType === 'ramp' ? road.constants.rampLimitKmh : traffic.limitAt(y)) / 3.6;
    const requested = clamp(finite(targetSpeed, 100), 0, physics.constants.maxSpeed);
    const cruiseTarget = Math.min(requested, roadCap);
    let target = cruiseTarget, status = 'cruising', reason = roadType === 'local' ?
      '沿普通道路本车道自动巡航，限速 50 km/h' : roadType === 'ramp' ?
        '沿出口匝道行驶，限速 40 km/h' : '保持车道，按道路限速自动巡航';

    if (roadType === 'highway') {
      // Reserve a response margin as well as the physical deceleration
      // distance. This lowers the control target before a speed-limit sign.
      const comfortableDeceleration = wet ? 1.6 : 2.5;
      const buffer = 10 + speed * (wet ? 1.2 : .8);
      const upcoming = [];
      if (typeof traffic.nextLimit === 'function') {
        let probe = y;
        for (let index = 0; index < 4; index++) {
          const next = traffic.nextLimit(probe, 1);
          if (!next || !Number.isFinite(next.y) || next.y <= probe) break;
          upcoming.push(next);
          probe = next.y + .01;
        }
      } else {
        // Compatibility with older traffic data; only actual speed changes
        // count, never informational signs repeating the same speed.
        upcoming.push(...traffic.signsAround(y, 5000).filter(sign => sign.y > y &&
          traffic.limitAt(sign.y - .01) !== traffic.limitAt(sign.y + .01)).slice(0, 4));
      }
      for (const next of upcoming) {
        const boundary = next.y, futureCap = next.limitKmh / 3.6;
        if (futureCap >= cruiseTarget) continue;
        const permitted = Math.sqrt(futureCap * futureCap +
          2 * comfortableDeceleration * Math.max(0, boundary - y - buffer));
        if (permitted < target) {
          target = permitted;
          status = 'anticipating-limit';
          reason = `前方 ${Math.max(0, Math.ceil(boundary - y))} 米限速 ${next.limitKmh} km/h，提前减速`;
        }
      }
    }
    const routeTarget = target;

    const angle = finite(car.heading) * Math.PI / 180;
    const halfX = .93 * Math.abs(Math.cos(angle)) + 2.25 * Math.abs(Math.sin(angle));
    const halfY = 2.25 * Math.abs(Math.cos(angle)) + .93 * Math.abs(Math.sin(angle));
    const corridors = [x];
    if (roadType === 'local') corridors.push(road.localRoad.laneCenter);
    else if (roadType === 'highway' && laneChanging && Number.isInteger(laneTarget) && laneTarget >= 0 && laneTarget <= 2)
      corridors.push(laneControl.constants.laneCenters[laneTarget]);
    const vehicles = Array.isArray(world?.vehicles) ? world.vehicles : [];
    const brakingBudget = wet ? 2.4 : 4.5, headway = wet ? 2.6 : 1.8;
    let following = false, urgent = false, nearestGap = Infinity;
    for (const vehicle of vehicles) {
      if (![vehicle.x, vehicle.y].every(Number.isFinite) || !corridors.some(center =>
        Math.abs(vehicle.x - center) < halfX + Math.max(.5, finite(vehicle.width, 1.85)) / 2 + .2)) continue;
      const offset = vehicle.y - y, bodyLength = halfY + Math.max(1, finite(vehicle.length, 4.5)) / 2;
      if (offset < -bodyLength) continue;
      const gap = offset - bodyLength;
      const frontSpeed = Math.max(0, finite(vehicle.speed)) * (vehicle.direction === -1 ? -1 : 1);
      const desiredGap = 7 + speed * headway;
      const gapTarget = Math.max(0, frontSpeed + (gap - desiredGap) * .45);
      // The NPC may brake at 5 m/s². Do not credit it with the longer
      // stopping distance of this controller's comfortable braking budget.
      const stoppingSpace = Math.max(0, gap - 7 - speed * (wet ? .8 : .6));
      const stoppingTarget = Math.sqrt(Math.max(0, frontSpeed) ** 2 * brakingBudget / 5 +
        2 * brakingBudget * stoppingSpace);
      // Hold a stopped queue at a small standstill margin. Without this
      // deadband a proportional gap controller creeps forever toward 7 m.
      const allowed = frontSpeed < .2 && gap <= 10 ? 0 : Math.min(gapTarget, stoppingTarget);
      if (allowed < target) { target = allowed; following = true; nearestGap = Math.min(nearestGap, gap); }
      const neededDeceleration = Math.max(0, speed * speed - Math.max(0, frontSpeed) ** 2) /
        (2 * Math.max(.1, gap - 6));
      if (gap < 7 + speed * .3 || neededDeceleration > brakingBudget) {
        urgent = true;
        following = true;
        nearestGap = Math.min(nearestGap, gap);
      }
    }

    target = clamp(target, 0, cruiseTarget);
    const gripDeceleration = (wet ? physics.constants.wetMu : physics.constants.dryMu) * physics.constants.g;
    const speedError = speed - target;
    let brake = speedError > .08 ? clamp(speedError * 1.8 / gripDeceleration, .04, 1) : 0;
    if (urgent || (target < .08 && speed < .3)) brake = 1;
    const throttle = brake > 0 || target < .08 || speed > target + .02 ? 0 : 1;
    if (following) {
      status = urgent ? 'braking' : 'following';
      reason = urgent ? '前车距离不足，正在制动保持间距' :
        `前方车距 ${Math.max(0, Math.round(nearestGap))} 米，自动跟车并保持间距`;
    } else if (brake > 0 && status !== 'anticipating-limit') {
      status = 'braking';
      reason = target < .08 ? '目标速度为零，自动制动至停止' : '车速高于当前目标，正在按物理过程减速';
    }

    let laneDirection = 0;
    if (roadType === 'highway') {
      const centered = Number.isInteger(laneTarget) && laneTarget >= 0 && laneTarget <= 2 &&
        laneControl.isCentered(car, laneControl.constants.laneCenters[laneTarget]);
      if (laneChanging) { status = 'changing'; reason = '正在完成变道，同时监测前方车距'; }
      else if (allowLaneChange && centered && brake === 0 && finite(car.elapsedTime) >= cooldownUntil) {
        const advice = traffic.getLaneRecommendation(world, car, { wet, desiredSpeed: routeTarget });
        if (advice.status === 'recommend' && advice.currentLane === laneTarget &&
          advice.targetLane >= 0 && advice.targetLane <= 2 && Math.abs(advice.targetLane - laneTarget) === 1) {
          const rule = road.canChangeLane(y, { speed, gear: 'forward', targetSpeed: routeTarget });
          if (rule.allowed) {
            laneDirection = advice.targetLane - laneTarget;
            status = 'changing'; reason = `前方车流较慢，自动向${laneDirection < 0 ? '左' : '右'}变道`;
          } else if (!following) { status = 'waiting'; reason = `${rule.reason}，保持车道`; }
        }
      }
    }
    return { targetSpeed: target, brake, throttle, laneDirection, status, reason };
  }

  return Object.freeze({ evaluate });
});
