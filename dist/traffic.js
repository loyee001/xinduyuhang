(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverTraffic = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const constants = Object.freeze({ laneWidth: 3.75, zoneLength: 1000, signSpacing: 500,
    recycleDistance: 2050, spawnDistance: 1750, minGap: 3, headway: 1.5, maxSubstep: 1 / 30,
    guardrailCenter: 6.45, guardrailLeft: -6.45, guardrailRight: 7.95 });
  const densityPresets = Object.freeze({
    low: Object.freeze({ label: '较少', countPerLane: 7, vehicleCount: 42, spacing: 590, headway: 1.8,
      speedFactor: 1, recycleDistance: 2200, spawnDistance: 1900 }),
    medium: Object.freeze({ label: '中等', countPerLane: 13, vehicleCount: 78, spacing: 310, headway: 1.5,
      speedFactor: 1, recycleDistance: 2050, spawnDistance: 1750 }),
    dense: Object.freeze({ label: '拥挤', countPerLane: 29, vehicleCount: 174, spacing: 50, headway: 1.1,
      speedFactor: .42, recycleDistance: 950, spawnDistance: 780 })
  });
  const lanes = [-3.75, 0, 3.75, -25.75, -22, -18.25];
  const paint = ['#bd534b', '#e7e7d9', '#4f84ad', '#c9a456', '#657778', '#ece8df', '#50756c'];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
  const modulo = (n, d) => ((n % d) + d) % d;

  function limitAt(y) { return [120, 100, 80][modulo(Math.floor(finite(y) / constants.zoneLength), 3)]; }
  function signsAround(y, radius = 1600) {
    y = finite(y); radius = clamp(finite(radius, 1600), 0, 5000);
    const signs = [];
    for (let at = Math.ceil((y - radius) / constants.signSpacing) * constants.signSpacing;
      at <= y + radius; at += constants.signSpacing) signs.push({ y: at, limitKmh: limitAt(at) });
    if (Math.abs(y - 40) <= radius) signs.push({ y: 40, limitKmh: 120 });
    return signs.sort((a, b) => a.y - b.y);
  }
  const densityFor = density => Object.prototype.hasOwnProperty.call(densityPresets, density) ? density : 'medium';
  const presetFor = world => densityPresets[densityFor(world?.density)];
  const travelDirection = ego => ego.gear === 'reverse' ? -1 : 1;
  function createState(ego = {}, { density = 'medium' } = {}) {
    const world = { vehicles: [], density: densityFor(density), elapsedTime: 0, contacts: 0 };
    populate(world, ego);
    return world;
  }
  function populate(world, ego = {}) {
    const preset = presetFor(world), extent = egoExtents(ego), egoX = finite(ego.x), egoY = finite(ego.y);
    const offsets = world.density === 'dense' ? [0, 17, 35, 11, 28, 43] : [0, 70, 45, 30, 125, 210];
    const base = world.density === 'medium' ? -1790 : -(preset.countPerLane - 1) / 2 * preset.spacing + (world.density === 'dense' ? 25 : 70);
    // Rebuilding a selected density is deterministic. Keep a clear corridor
    // in the player's lane in both directions, even when switching at speed.
    const clearance = Math.max(25, Math.abs(finite(ego.speed)) * 1.5) + extent.y + 5;
    world.vehicles = [];
    for (let lane = 0; lane < lanes.length; lane++) {
      const laneVehicles = [];
      for (let row = 0; row < preset.countPerLane; row++) {
        const id = lane * preset.countPerLane + row;
        const truck = id % 7 === 3 || (lane === 2 && row === 6);
        const y = egoY + base + row * preset.spacing + offsets[lane];
        const cruiseFactor = (lane % 3 === 0 ? .94 : lane % 3 === 1 ? .86 : .77) - (truck ? .09 : 0) + (id % 3) * .015;
        laneVehicles.push({ id, lane, x: lanes[lane], y, previousY: y, direction: lane < 3 ? 1 : -1,
          heading: lane < 3 ? 0 : 180, speed: limitAt(y) / 3.6 * cruiseFactor * preset.speedFactor, cruiseFactor,
          length: truck ? 8.4 : 4.5, width: truck ? 2.35 : 1.85, height: truck ? 3.2 : 1.5,
          kind: truck ? 'truck' : 'car', color: paint[id % paint.length], braking: false });
      }
      let low = laneVehicles[0].y, high = laneVehicles[laneVehicles.length - 1].y;
      for (const v of laneVehicles) {
        if (Math.abs(v.x - egoX) >= v.width / 2 + extent.x + .3 || Math.abs(v.y - egoY) >= clearance) continue;
        // Move only blocked spawn slots to the ends, leaving all other gaps
        // unchanged and never moving the player's car or controls.
        v.y = v.y < egoY ? (low -= preset.spacing) : (high += preset.spacing);
        v.previousY = v.y;
        v.speed = limitAt(v.y) / 3.6 * v.cruiseFactor * preset.speedFactor;
      }
      world.vehicles.push(...laneVehicles);
    }
  }
  function setDensity(world, ego, density) {
    if (!world || !Array.isArray(world.vehicles)) return world;
    const next = densityFor(density);
    if (world.density === next) return world;
    world.density = next;
    populate(world, ego);
    world.lastContact = null;
    return world;
  }
  function egoExtents(ego) {
    const angle = finite(ego.heading) * Math.PI / 180;
    return { x: .93 * Math.abs(Math.cos(angle)) + 2.25 * Math.abs(Math.sin(angle)),
      y: 2.25 * Math.abs(Math.cos(angle)) + .93 * Math.abs(Math.sin(angle)) };
  }
  function recycle(world, ego) {
    const preset = presetFor(world);
    for (const vehicle of world.vehicles) {
      const offset = vehicle.y - ego.y;
      if (Math.abs(offset) <= preset.recycleDistance) continue;
      // Dense traffic has a shorter distant recycling window, keeping its
      // visible queue dense without requiring hundreds of additional cars.
      // Candidates are always far from ego and cannot overlap another NPC.
      const side = offset < 0 ? 1 : -1;
      let candidate = ego.y + side * preset.spawnDistance;
      let attempts = 0;
      const clearGap = Math.min(85, preset.spacing * .6), stride = clearGap + 10;
      while (world.vehicles.some(other => other !== vehicle && other.lane === vehicle.lane &&
        Math.abs(other.y - candidate) < clearGap + (vehicle.length + other.length) / 2) && attempts++ < 40) candidate += side * stride;
      if (attempts > 40) continue;
      vehicle.y = vehicle.previousY = candidate;
      vehicle.speed = limitAt(candidate) / 3.6 * vehicle.cruiseFactor * preset.speedFactor;
      vehicle.braking = false;
    }
  }
  function step(world, ego, dt) {
    if (!world || !Array.isArray(world.vehicles) || !Number.isFinite(dt) || dt <= 0) return world;
    ego = ego || {};
    const egoY = finite(ego.y), egoX = finite(ego.x), extent = egoExtents(ego);
    const egoForwardSpeed = travelDirection(ego) * finite(ego.speed) * Math.cos(finite(ego.heading) * Math.PI / 180);
    const preset = presetFor(world);
    const substeps = Math.ceil(Math.min(dt, 10) / constants.maxSubstep), subDt = Math.min(dt, 10) / substeps;
    for (const vehicle of world.vehicles) vehicle.previousY = vehicle.y;
    const laneGroups = lanes.map((_, lane) => world.vehicles.filter(v => v.lane === lane));
    for (let i = 0; i < substeps; i++) {
      for (const group of laneGroups) {
        if (!group.length) continue;
        const direction = group[0].direction;
        group.sort((a, b) => direction * (b.y - a.y));
        let leader = null;
        for (const vehicle of group) {
          let gap = Infinity, leaderSpeed = 0, stopAt = null;
          if (leader) {
            gap = direction * (leader.y - vehicle.y) - (vehicle.length + leader.length) / 2;
            leaderSpeed = leader.speed;
            stopAt = leader.y - direction * ((vehicle.length + leader.length) / 2 + constants.minGap);
          }
          if (Math.abs(vehicle.x - egoX) < vehicle.width / 2 + extent.x + .2 &&
            direction * (egoY - vehicle.y) > 0) {
            const egoGap = direction * (egoY - vehicle.y) - vehicle.length / 2 - extent.y;
            if (egoGap < gap) {
              gap = egoGap; leaderSpeed = Math.max(0, direction * egoForwardSpeed);
              stopAt = egoY - direction * (vehicle.length / 2 + extent.y + constants.minGap);
            }
          }
          const roadSpeed = Math.min(limitAt(vehicle.y), limitAt(vehicle.y + direction * 95)) / 3.6;
          let desired = roadSpeed * vehicle.cruiseFactor * preset.speedFactor;
          if (Number.isFinite(gap)) {
            // A stopping-distance + time-headway bound makes a slow queue
            // stable, including when the player's car is standing still.
            const decel = 4.5, head = decel * preset.headway;
            const safe = Math.max(0, Math.sqrt(head * head + leaderSpeed * leaderSpeed +
              2 * decel * Math.max(0, gap - constants.minGap)) - head);
            desired = Math.min(desired, safe);
          }
          const before = vehicle.speed;
          const startY = vehicle.y;
          vehicle.speed = Math.max(0, before + clamp((desired - before) * 1.2, -5, 1.6) * subDt);
          vehicle.braking = vehicle.speed < before - .025;
          vehicle.y += direction * (before + vehicle.speed) * .5 * subDt;
          // The geometric final bound prevents tunnelling in very tight queues.
          if (stopAt !== null && direction * (vehicle.y - stopAt) > 0) {
            // A reversing ego can consume the gap. Stop this NPC instead of
            // dragging it backwards ahead of the player's physical contact.
            vehicle.y = startY + direction * Math.max(0, direction * (stopAt - startY));
            vehicle.speed = Math.min(vehicle.speed, leaderSpeed);
          }
          leader = vehicle;
        }
      }
      world.elapsedTime += subDt;
    }
    recycle(world, { x: egoX, y: egoY });
    return world;
  }
  function getSnapshot(world, ego = {}) {
    const x = finite(ego.x), y = finite(ego.y), extent = egoExtents(ego);
    let nearestAhead = null, nearestBehind = null;
    for (const vehicle of world.vehicles) {
      if (vehicle.direction !== 1 || Math.abs(vehicle.x - x) >= vehicle.width / 2 + extent.x) continue;
      const distance = Math.max(0, Math.abs(vehicle.y - y) - vehicle.length / 2 - extent.y);
      const item = { id: vehicle.id, lane: vehicle.lane, distance, speedKmh: vehicle.speed * 3.6 };
      if (vehicle.y >= y && (!nearestAhead || distance < nearestAhead.distance)) nearestAhead = item;
      if (vehicle.y < y && (!nearestBehind || distance < nearestBehind.distance)) nearestBehind = item;
    }
    return { speedLimitKmh: limitAt(y), density: densityFor(world.density), vehicleCount: world.vehicles.length,
      nearestAhead, nearestBehind, vehicles: world.vehicles, roadSigns: signsAround(y) };
  }
  // Swept relative AABB collision catches high-speed crossings between frames.
  // This intentionally small arcade contact model does not operate controls
  // or emergency-stop state. It corrects motion/brake measurements when a
  // collision truncates the physics step. NPCs stay in their lanes.
  function resolveContact(world, ego, previousPose) {
    if (!world || !ego || ![ego.x, ego.y, ego.speed].every(Number.isFinite)) return null;
    const previous = previousPose && [previousPose.x, previousPose.y].every(Number.isFinite) ? previousPose : ego;
    const extent = egoExtents(ego), contacts = [];
    for (const v of world.vehicles) {
      const halfX = extent.x + v.width / 2, halfY = extent.y + v.length / 2;
      const sx = previous.x - v.x, sy = previous.y - finite(v.previousY, v.y);
      const dx = ego.x - previous.x, dy = ego.y - previous.y - (v.y - finite(v.previousY, v.y));
      let enter = 0, exit = 1, axis = 'y';
      let hit = true;
      for (const [start, delta, half, name] of [[sx, dx, halfX, 'x'], [sy, dy, halfY, 'y']]) {
        if (Math.abs(delta) < 1e-10) { if (Math.abs(start) >= half) hit = false; continue; }
        let a = (-half - start) / delta, b = (half - start) / delta;
        if (a > b) [a, b] = [b, a];
        if (a > enter) { enter = a; axis = name; }
        exit = Math.min(exit, b);
      }
      if (!hit || enter > exit || exit < 0 || enter > 1) continue;
      const alreadyInside = Math.abs(sx) < halfX && Math.abs(sy) < halfY;
      if (alreadyInside) axis = halfX - Math.abs(sx) < halfY - Math.abs(sy) ? 'x' : 'y';
      contacts.push({ v, at: Math.max(0, enter), axis, sx, sy, halfX, halfY });
    }
    if (!contacts.length) return null;
    contacts.sort((a, b) => a.at - b.at);
    const hit = contacts[0], v = hit.v, dx = ego.x - previous.x, dy = ego.y - previous.y;
    const oldSpeed = ego.speed;
    const brakeEpisode = ego.braking || (previous.braking && ego.speed === 0);
    const sideX = v.x + (hit.sx < 0 ? -1 : 1) * (hit.halfX + .02);
    // A car pinned against a guardrail must separate along the road. Moving
    // through the barrier would cause physics/contact to fight every frame.
    if (hit.axis === 'x' && (sideX < constants.guardrailLeft || sideX > constants.guardrailRight)) hit.axis = 'y';
    const freshSideImpact = !world.lastContact || world.lastContact.id !== v.id ||
      finite(world.elapsedTime) - world.lastContact.time > .4;
    if (hit.axis === 'x') {
      ego.x = sideX;
      ego.y = previous.y + dy * hit.at;
      if (freshSideImpact) ego.speed *= .94;
    } else {
      const sign = hit.sy < 0 ? -1 : 1;
      ego.y = v.y + sign * (hit.halfY + .03);
      ego.x = previous.x + dx * hit.at;
      const forward = travelDirection(ego) * Math.cos(finite(ego.heading) * Math.PI / 180);
      const alignedSpeed = v.direction * forward > 0 ? v.speed / Math.max(.2, Math.abs(forward)) : 0;
      ego.speed = Math.min(ego.speed, alignedSpeed * .94);
    }
    if (previous !== ego) {
      const attempted = Math.hypot(dx, dy), actual = Math.min(attempted, Math.hypot(ego.x - previous.x, ego.y - previous.y));
      const removed = Math.max(0, attempted - actual);
      if (Number.isFinite(ego.distance)) ego.distance = Math.max(finite(previous.distance), ego.distance - removed);
      if (brakeEpisode && Number.isFinite(ego.brakeDistance)) ego.brakeDistance = Math.max(0, ego.brakeDistance - removed);
      if (brakeEpisode && ego.speed === 0 && Number.isFinite(ego.brakeTime)) {
        const beforeBrakeTime = previous.braking ? finite(previous.brakeTime) : 0;
        ego.brakeTime = beforeBrakeTime + Math.max(0, ego.brakeTime - beforeBrakeTime) * hit.at;
      }
    }
    // A collision can reach rest after physics has already evaluated its stop
    // transition. Finish that same measurement now, before UI / AI reads it.
    if (brakeEpisode && ego.speed === 0) {
      ego.lastBrakeDistance = ego.brakeDistance;
      ego.lastBrakeStartSpeed = ego.brakeStartSpeed;
      ego.lastBrakeTime = ego.brakeTime;
      ego.braking = false;
    }
    world.contacts++;
    world.lastContact = { id: v.id, time: finite(world.elapsedTime) };
    const angle = finite(ego.heading) * Math.PI / 180, signedSpeed = travelDirection(ego) * oldSpeed;
    return { vehicleId: v.id, relativeSpeed: Math.hypot(signedSpeed * Math.sin(angle),
      signedSpeed * Math.cos(angle) - v.direction * v.speed), side: hit.axis === 'x' };
  }
  return Object.freeze({ constants, densityPresets, createState, setDensity, step, limitAt, signsAround, getSnapshot, resolveContact });
});
