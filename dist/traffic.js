(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverTraffic = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const constants = Object.freeze({ laneWidth: 3.75, zoneLength: 1000, signSpacing: 500,
    recycleDistance: 2050, spawnDistance: 1750, minGap: 3, headway: 1.5, maxSubstep: 1 / 30,
    guardrailCenter: 6.45, guardrailLeft: -6.45, guardrailRight: 7.95,
    hornRange: 100, hornCooldown: 2.5, yieldSeconds: 4, maxEntranceVehicles: 8 });
  const densityPresets = Object.freeze({
    low: Object.freeze({ label: '较少', countPerLane: 7, vehicleCount: 42, spacing: 590, headway: 1.8,
      speedFactor: 1, recycleDistance: 2200, spawnDistance: 1900 }),
    medium: Object.freeze({ label: '中等', countPerLane: 13, vehicleCount: 78, spacing: 310, headway: 1.5,
      speedFactor: 1, recycleDistance: 2050, spawnDistance: 1750 }),
    dense: Object.freeze({ label: '拥挤', countPerLane: 29, vehicleCount: 174, spacing: 50, headway: 1.1,
      speedFactor: .42, recycleDistance: 950, spawnDistance: 780 })
  });
  const lanes = [-3.75, 0, 3.75, -25.75, -22, -18.25];
  const localLanes = [29, 25.5];
  const localRoad = Object.freeze({ speedLimitKmh:50, left:23.75, right:30.75 });
  const paint = ['#bd534b', '#e7e7d9', '#4f84ad', '#c9a456', '#657778', '#ece8df', '#50756c'];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;

  // Every boundary has a stable, independently jittered world position.
  // The 1400 m spacing is an indexing aid, not a repeating speed zone: both
  // lengths and values come from the index hash, and equal neighbours merge.
  const limitSpacing = 1400, limitChoices = [120,100,80];
  function roadHash(index, salt) {
    const high = Math.floor(index / 4294967296);
    let value = Math.imul(index | 0,374761393) ^ Math.imul(high | 0,668265263) ^ salt;
    value = Math.imul(value ^ (value >>> 13),1274126177);
    return (value ^ (value >>> 16)) >>> 0;
  }
  const limitBoundary = index => index * limitSpacing + (index === 0 ? 0 : roadHash(index,0x1b873593) % 501);
  const limitForIndex = index => index === 0 ? 120 : limitChoices[roadHash(index,0x51ed270b) % limitChoices.length];
  function limitIndex(y) {
    const index = Math.floor(y / limitSpacing);
    return y < limitBoundary(index) ? index-1 : index;
  }
  function limitAt(y) { return limitForIndex(limitIndex(finite(y))); }
  function nextLimit(y, direction = 1) {
    y = finite(y); direction = direction < 0 ? -1 : 1;
    const current = limitAt(y);
    let index = limitIndex(y) + (direction > 0 ? 1 : 0);
    // A bounded search also makes out-of-precision caller inputs harmless.
    for (let attempts = 0; attempts < 512; attempts++, index += direction) {
      const at = limitBoundary(index), next = limitForIndex(index-(direction < 0 ? 1 : 0));
      if (next !== current && direction*(at-y) >= 0)
        return { y:at,limitKmh:next,distance:Math.max(0,direction*(at-y)) };
    }
    throw new RangeError('Road coordinate is outside the supported numeric precision');
  }
  function signsAround(y, radius = 1600) {
    y = finite(y); radius = clamp(finite(radius, 1600), 0, 5000);
    const signs = new Map();
    for (let at = Math.ceil((y - radius) / constants.signSpacing) * constants.signSpacing;
      at <= y + radius; at += constants.signSpacing) signs.set(at,{ y:at,limitKmh:limitAt(at) });
    const first = limitIndex(y-radius), last = limitIndex(y+radius)+1;
    for (let index = first; index <= last; index++) {
      const at = limitBoundary(index);
      if (at >= y-radius && at <= y+radius && limitForIndex(index) !== limitForIndex(index-1))
        signs.set(at,{ y:at,limitKmh:limitForIndex(index) });
    }
    if (Math.abs(y - 40) <= radius) signs.set(40,{ y:40,limitKmh:120 });
    return [...signs.values()].sort((a, b) => a.y - b.y);
  }
  const densityFor = density => Object.prototype.hasOwnProperty.call(densityPresets, density) ? density : 'medium';
  const presetFor = world => densityPresets[densityFor(world?.density)];
  const isLocal = world => world?.roadType === 'local';
  const lanesFor = world => isLocal(world) ? localLanes : lanes;
  const limitFor = (world, y) => isLocal(world) ? localRoad.speedLimitKmh : limitAt(y);
  const directionFor = (world, lane) => lane < (isLocal(world) ? 1 : 3) ? 1 : -1;
  const travelDirection = ego => ego.gear === 'reverse' ? -1 : 1;
  function createState(ego = {}, { density = 'medium', roadType = 'highway', roadStart } = {}) {
    const world = { vehicles: [], density: densityFor(density), roadType:roadType === 'local' ? 'local' : 'highway',
      roadStart:Number.isFinite(roadStart) ? roadStart : null, elapsedTime: 0, contacts: 0,
      nextEntranceId:1000, nextEntranceArrival:0, entranceArrivals:0, entranceCompleted:0, exitSelected:0, exitCompleted:0 };
    populate(world, ego, true);
    return world;
  }
  function populate(world, ego = {}, initial = false) {
    const preset = presetFor(world), extent = egoExtents(ego), egoX = finite(ego.x), egoY = finite(ego.y);
    const offsets = world.density === 'dense' ? [0, 17, 35, 11, 28, 43] : [0, 70, 45, 30, 125, 210];
    let base = world.density === 'medium' ? -1790 : -(preset.countPerLane - 1) / 2 * preset.spacing + (world.density === 'dense' ? 25 : 70);
    // The first ordinary-road generation starts after the ramp connection.
    // Subsequent recycling/density changes stay centered on ego, including
    // when reversing a long distance past the original connection coordinate.
    if (initial && isLocal(world) && Number.isFinite(world.roadStart)) base = Math.max(base,world.roadStart+10-egoY);
    // Rebuilding a selected density is deterministic. Keep a clear corridor
    // in the player's lane in both directions, even when switching at speed.
    const clearance = Math.max(25, Math.abs(finite(ego.speed)) * 1.5) + extent.y + 5;
    world.vehicles = [];
    const laneCenters = lanesFor(world);
    for (let lane = 0; lane < laneCenters.length; lane++) {
      const laneVehicles = [];
      for (let row = 0; row < preset.countPerLane; row++) {
        const id = lane * preset.countPerLane + row;
        const truck = id % 7 === 3 || (lane === 2 && row === 6);
        const y = egoY + base + row * preset.spacing + offsets[lane];
        const cruiseFactor = (lane % 3 === 0 ? .94 : lane % 3 === 1 ? .86 : .77) - (truck ? .09 : 0) + (id % 3) * .015;
        const direction = directionFor(world,lane);
        laneVehicles.push({ id, lane, x: laneCenters[lane], previousX: laneCenters[lane], y, previousY: y, direction,
          heading: direction > 0 ? 0 : 180, speed: limitFor(world,y) / 3.6 * cruiseFactor * preset.speedFactor, cruiseFactor,
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
        v.speed = limitFor(world,v.y) / 3.6 * v.cruiseFactor * preset.speedFactor;
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
    world.hornUntil = 0;
    world.lastYield = null;
    world.nextEntranceArrival = finite(world.elapsedTime) + 3;
    world.entranceArrivals = 0; world.entranceCompleted = 0;
    world.exitSelected = 0; world.exitCompleted = 0; world.nextExitScan = 0;
    return world;
  }
  function egoExtents(ego) {
    const angle = finite(ego.heading) * Math.PI / 180;
    return { x: .93 * Math.abs(Math.cos(angle)) + 2.25 * Math.abs(Math.sin(angle)),
      y: 2.25 * Math.abs(Math.cos(angle)) + .93 * Math.abs(Math.sin(angle)) };
  }
  function vehicleExtents(vehicle, heading = vehicle.heading) {
    const angle = finite(heading) * Math.PI / 180;
    return { x:vehicle.width / 2 * Math.abs(Math.cos(angle)) + vehicle.length / 2 * Math.abs(Math.sin(angle)),
      y:vehicle.length / 2 * Math.abs(Math.cos(angle)) + vehicle.width / 2 * Math.abs(Math.sin(angle)) };
  }
  const occupiedLanes = vehicle => vehicle.exitRoute ?
    [`exit:${vehicle.exitRoute.event.id}`, ...(Math.abs(vehicle.x - localLanes[0]) < vehicleExtents(vehicle).x + .93 + .2 ? ['local-forward'] : []), ...(vehicle.exitRoute.localTraffic ?
      (Math.abs(vehicle.x - localLanes[0]) < vehicleExtents(vehicle).x + .93 + .2 ? [0] : []) :
      (Math.abs(vehicle.x - lanes[2]) < vehicleExtents(vehicle).x + .93 + .2 ? [2] : []))] : vehicle.entranceMerge ?
    (vehicle.entranceMerge.committed ? [6, 2] : [6]) : vehicle.laneChange ?
    [vehicle.laneChange.fromLane, vehicle.laneChange.targetLane] : [vehicle.lane];
  const overlapsCorridor = (vehicle, x, halfWidth = .93, margin = 0) =>
    Math.abs(vehicle.x - x) < halfWidth + vehicleExtents(vehicle).x + margin ||
    Boolean((vehicle.laneChange || vehicle.entranceMerge?.committed) && occupiedLanes(vehicle).some(lane =>
      Math.abs(lanes[lane] - x) < halfWidth + vehicle.width / 2 + margin));
  function yieldLaneSafe(world, vehicle, ego, lane, wet, horizon) {
    const speed = Math.max(0, vehicle.speed), headway = wet ? 1.6 : 1.1;
    const halfLength = vehicle.length / 2;
    const obstacles = world.vehicles.filter(other => other !== vehicle &&
      overlapsCorridor(other, lanes[lane], vehicle.width / 2, .2));
    const extent = egoExtents(ego);
    if (Math.abs(finite(ego.x) - lanes[lane]) < extent.x + vehicle.width / 2 + .2)
      obstacles.push({ y:finite(ego.y), length:extent.y * 2,
        speed:travelDirection(ego) * Math.max(0, finite(ego.speed)) * Math.cos(finite(ego.heading) * Math.PI / 180), direction:1 });
    for (const other of obstacles) {
      const offset = other.y - vehicle.y, gap = Math.abs(offset) - halfLength - other.length / 2;
      const otherSpeed = other.speed * other.direction;
      if (gap < 5) return false;
      if (offset >= 0) {
        // Reserve acceleration room; following control still caps acceleration
        // against both lanes while the full vehicle leaves the source lane.
        const future = gap + (otherSpeed - speed) * horizon - .8 * horizon * horizon;
        if (gap < Math.max(10, speed * headway) || future < Math.max(8, speed * .7)) return false;
      } else {
        // Do not count on our acceleration, or on a fast rear car braking.
        const future = gap + (speed - otherSpeed) * horizon - .8 * horizon * horizon;
        if (gap < Math.max(8, otherSpeed * headway) || future < Math.max(7, otherSpeed * .65)) return false;
      }
    }
    return true;
  }
  function yieldRoadAllowed(check, vehicle, reservedDistance = null) {
    if (typeof check !== 'function') return false;
    const upperSpeed = Math.max(vehicle.speed, Math.min(limitAt(vehicle.y) / 3.6, vehicle.speed + 8));
    // RoverRoad reserves eight seconds. A distance budget during an ongoing
    // turn includes both its unfinished path and a full stop before a solid.
    const speed = reservedDistance === null ? vehicle.speed : Math.max(0, reservedDistance) / 8;
    const targetSpeed = reservedDistance === null ? upperSpeed : speed;
    const result = check(vehicle.y, { speed, gear:'forward', targetSpeed });
    return result === true || result?.allowed === true;
  }
  function requestYield(world, ego = {}, { wet = false, roadType = 'highway', canChangeLane } = {}) {
    const answer = (status, reason, vehicle, targetLane) => ({ status, reason,
      ...(vehicle ? { vehicleId:vehicle.id } : {}), ...(Number.isInteger(targetLane) ? { targetLane } : {}) });
    if (!world || !Array.isArray(world.vehicles)) return answer('unavailable', '车流尚未就绪');
    if (isLocal(world) || roadType !== 'highway') return answer('unavailable', '当前道路没有可安全避让的同向车道');
    if (ego.gear === 'reverse' || ![ego.x, ego.y].every(Number.isFinite) ||
      Math.abs(finite(ego.heading)) > 8 || !lanes.slice(0, 3).some(x => Math.abs(x - ego.x) < .8))
      return answer('unavailable', '请在正常行车道内向前行驶时鸣笛');
    if (typeof canChangeLane !== 'function') return answer('unavailable', '路况信息未就绪，前车保持车道');
    if (finite(world.elapsedTime) < finite(world.hornUntil)) return answer('cooldown', '请稍候再鸣笛，给前车留出反应时间');
    world.hornUntil = finite(world.elapsedTime) + constants.hornCooldown;
    const extent = egoExtents(ego);
    const lead = world.vehicles.filter(vehicle => vehicle.direction === 1 && vehicle.lane >= 0 && vehicle.lane <= 2 &&
      vehicle.y > ego.y && vehicle.y - ego.y - vehicle.length / 2 - extent.y <= constants.hornRange &&
      overlapsCorridor(vehicle, ego.x, extent.x)).sort((a, b) => a.y - b.y)[0];
    if (!lead) return answer('unavailable', '前方 100 米内没有可提醒的同向车辆');
    if (lead.speed < 2) return answer('blocked', '前车车速较低，起步并有足够空间后才能安全避让', lead);
    if (lead.laneChange || lead.entranceMerge || lead.exitRoute || finite(lead.yieldCooldownUntil) > finite(world.elapsedTime))
      return answer('cooldown', '前车正在避让或刚完成变道，请保持安全距离', lead);
    if (!yieldRoadAllowed(canChangeLane, lead)) return answer('blocked', '前车处于实线或临近实线路段，暂时无法避让', lead);
    const duration = constants.yieldSeconds + (wet ? 1 : 0);
    if (!yieldLaneSafe(world, lead, ego, lead.lane, wet, duration))
      return answer('blocked', '前车当前车道间距不足，请先保持安全距离', lead);
    const target = [lead.lane + 1, lead.lane - 1].find(lane => lane >= 0 && lane <= 2 &&
      yieldLaneSafe(world, lead, ego, lane, wet, duration));
    if (!Number.isInteger(target)) return answer('blocked', '相邻车道没有安全间隙，前车继续保持车道', lead);
    lead.laneChange = { fromLane:lead.lane, targetLane:target, startX:lead.x,
      endX:lanes[target], progress:0, duration, referenceSpeed:Math.max(12, lead.speed), wet, canChangeLane, status:'moving' };
    lead.yieldCooldownUntil = finite(world.elapsedTime) + duration + 8;
    const result = answer('yielding', `前车收到鸣笛，正在向${target > lead.lane ? '右' : '左'}安全避让`, lead, target);
    world.lastYield = result;
    return result;
  }
  function advanceYield(world, vehicle, ego, dt) {
    const turn = vehicle.laneChange;
    if (!turn) return;
    const remaining = (1 - turn.progress) * turn.duration;
    const destination = turn.returning ? turn.fromLane : turn.targetLane;
    const horizon = Math.min(8, remaining * turn.referenceSpeed / Math.max(2, vehicle.speed));
    const safe = yieldLaneSafe(world, vehicle, ego, destination, turn.wet, horizon);
    // Reserving completion + stopping travel prevents a paused turn from
    // consuming all road space before a solid and becoming stranded there.
    const completionTravel = remaining * Math.max(turn.referenceSpeed, vehicle.speed);
    const stoppingTravel = vehicle.speed * vehicle.speed / 8 + Math.max(5, vehicle.speed * .5);
    const legal = yieldRoadAllowed(turn.canChangeLane, vehicle, completionTravel + stoppingTravel);
    if (!safe || !legal) {
      // An early change can return only after checking the entire source
      // corridor. Otherwise hold lateral position and brake in both lanes.
      if (!turn.returning && turn.progress > 0 && turn.progress < .45 && legal &&
        yieldLaneSafe(world, vehicle, ego, turn.fromLane, turn.wet, Math.max(1.5, turn.progress * turn.duration))) {
        turn.returning = true;
        turn.startX = vehicle.x; turn.endX = lanes[turn.fromLane];
        turn.duration = Math.max(1.5, turn.progress * turn.duration); turn.progress = 0;
        turn.status = 'returning';
      } else {
        turn.status = 'waiting'; vehicle.heading = 0; return;
      }
    }
    turn.status = turn.returning ? 'returning' : 'moving';
    const beforeX = vehicle.x;
    // A stopped car cannot translate sideways. Tie turn progress to forward
    // travel; the 12 m/s reference bounds yaw to about seven degrees even
    // while a previously moving car slows almost to rest.
    const progressRate = vehicle.speed < 2 ? 0 : Math.min(1, vehicle.speed / turn.referenceSpeed);
    turn.progress = Math.min(1, turn.progress + dt / turn.duration * progressRate);
    const t = turn.progress, eased = t * t * (3 - 2 * t);
    vehicle.x = turn.startX + (turn.endX - turn.startX) * eased;
    vehicle.heading = Math.atan2((vehicle.x - beforeX) / dt, Math.max(.001, vehicle.speed)) * 180 / Math.PI;
    if (t >= 1) {
      vehicle.lane = turn.returning ? turn.fromLane : turn.targetLane;
      vehicle.x = lanes[vehicle.lane]; vehicle.heading = 0;
      vehicle.laneChange = null;
    }
  }
  function spawnEntranceTraffic(world, ego, options) {
    const road = options.roadModel;
    if (!options.merging || isLocal(world) || typeof road?.eventsAround !== 'function' ||
      typeof road?.centerForEntrance !== 'function' ||
      finite(world.elapsedTime) < finite(world.nextEntranceArrival) ||
      finite(world.elapsedTime) < finite(world.nextEntranceScan)) return;
    world.nextEntranceScan = finite(world.elapsedTime) + .5;
    const arrivals = world.vehicles.filter(vehicle => vehicle.fromEntrance);
    if (arrivals.length >= constants.maxEntranceVehicles) return;
    const entrances = road.eventsAround(finite(ego.y), 1000)?.entrances || [];
    const entry = entrances.filter(event => event.start >= finite(ego.y) - 300 && event.start <= finite(ego.y) + 650)
      .sort((a, b) => Math.abs(a.start - finite(ego.y)) - Math.abs(b.start - finite(ego.y)))
      .find(event => !arrivals.some(vehicle => vehicle.entranceMerge?.event.id === event.id &&
        vehicle.y - event.start < 40));
    if (!entry) return;
    const x = road.centerForEntrance(entry, entry.start), y = entry.start;
    // Keep all IDs unique, including caller-provided traffic fixtures.
    const id = Math.max(1000, finite(world.nextEntranceId, 1000),
      ...world.vehicles.map(vehicle => finite(vehicle.id) + 1));
    world.nextEntranceId = id + 1;
    const vehicle = { id, lane:6, x, previousX:x, y, previousY:y, direction:1,
      heading:0, previousHeading:0, speed:12, cruiseFactor:.88, length:4.5,
      width:1.85, height:1.5, kind:'car', color:paint[id % paint.length], braking:false,
      fromEntrance:true, entranceMerge:{ event:entry, committed:false, status:'approaching', wet:Boolean(options.wet) } };
    // The vehicle starts at the physical feeder mouth, never inside ego.
    if (Math.abs(x - finite(ego.x)) < egoExtents(ego).x + vehicle.width / 2 + 2 &&
      Math.abs(y - finite(ego.y)) < egoExtents(ego).y + vehicle.length / 2 + 15) return;
    world.vehicles.push(vehicle);
    world.entranceArrivals = finite(world.entranceArrivals) + 1;
    world.nextEntranceArrival = finite(world.elapsedTime) + ({ low:16, medium:12, dense:8 }[densityFor(world.density)]);
  }
  function entranceGapSafe(world, vehicle, ego, options, remaining) {
    const wet = vehicle.entranceMerge.wet, speed = Math.max(0, vehicle.speed);
    const headway = wet ? 2 : 1.4, braking = wet ? 2.4 : 4.5;
    const horizon = clamp(remaining / Math.max(12, speed), 2, 14);
    const cruise = Math.min(25, limitAt(vehicle.y) / 3.6 * .88);
    const accelerationTime = Math.min(horizon, Math.max(0, cruise - speed) / 1.6);
    const projectedTravel = speed * horizon + .8 * accelerationTime * accelerationTime +
      Math.max(0, cruise - speed) * (horizon - accelerationTime);
    const obstacles = world.vehicles.filter(other => other !== vehicle && overlapsCorridor(other, lanes[2], vehicle.width / 2, .15));
    const extent = egoExtents(ego);
    const egoReservesRight = options.egoLaneTarget === 2 || Math.abs(finite(ego.x) - lanes[2]) < extent.x + vehicle.width / 2 + .2;
    if (egoReservesRight) obstacles.push({ y:finite(ego.y), length:extent.y * 2,
      speed:travelDirection(ego) * Math.max(0, finite(ego.speed)) * Math.cos(finite(ego.heading) * Math.PI / 180), direction:1 });
    for (const other of obstacles) {
      const offset = other.y - vehicle.y, gap = Math.abs(offset) - (vehicle.length + other.length) / 2;
      const otherSpeed = other.speed * other.direction;
      if (gap < 7) return false;
      if (offset >= 0) {
        const stoppingGap = Math.max(0, (speed * speed - Math.max(0, otherSpeed) ** 2) / (2 * braking));
        if (gap < 7 + speed * headway + stoppingGap ||
          gap + otherSpeed * horizon - projectedTravel < 7 + Math.max(speed, cruise) * headway) return false;
      } else {
        const stoppingGap = Math.max(0, (otherSpeed * otherSpeed - speed * speed) / (2 * braking));
        if (gap < 7 + Math.max(0, otherSpeed) * headway + stoppingGap ||
          gap + (speed - otherSpeed) * horizon < 7 + Math.max(0, otherSpeed) * headway) return false;
      }
    }
    return true;
  }
  function prepareEntranceMerge(world, vehicle, ego, options) {
    const entry = vehicle.entranceMerge;
    if (!entry) return;
    entry.wet = Boolean(options.wet);
    const remaining = Math.max(0, entry.event.mergeEnd - vehicle.y);
    const near = vehicle.y >= entry.event.accelerationStart;
    if (!near) { entry.status = 'approaching'; return; }
    // Only the head of this ramp queue may reserve the live lane. A tail
    // reservation would reject the head's rear-gap check, while that tail
    // is itself following the stopped head: neither could ever proceed.
    const queuedAhead = world.vehicles.some(other => other !== vehicle && other.y > vehicle.y &&
      other.entranceMerge?.event.id === entry.event.id);
    if (queuedAhead && !entry.committed) { entry.status = 'waiting'; return; }
    const safe = entranceGapSafe(world, vehicle, ego, options, remaining);
    if (!entry.committed) {
      if (safe) { entry.committed = true; entry.status = 'merging'; }
      else entry.status = 'waiting';
    } else {
      // Before entering the taper a newly unsafe gap can be relinquished.
      // Once moving into the live lane, retain its reservation while braking
      // along the curved path; stopped cars cannot translate sideways.
      const stopping = vehicle.speed * vehicle.speed / (2 * (entry.wet ? 2.4 : 4.5)) + 5;
      if (!safe && vehicle.y + stopping < entry.event.mergeStart - 8) {
        entry.committed = false; entry.status = 'waiting';
      } else entry.status = safe ? 'merging' : 'waiting';
    }
  }
  function advanceEntrancePose(world, vehicle, previousY, dt, road) {
    const entry = vehicle.entranceMerge;
    if (!entry || typeof road?.centerForEntrance !== 'function') return;
    const previousX = vehicle.x;
    vehicle.x = road.centerForEntrance(entry.event, vehicle.y);
    vehicle.heading = Math.atan2(vehicle.x - previousX, Math.max(.00001, vehicle.y - previousY)) * 180 / Math.PI;
    if (vehicle.y >= entry.event.mergeEnd) {
      vehicle.lane = 2; vehicle.x = lanes[2]; vehicle.heading = 0;
      vehicle.entranceMerge = null;
      vehicle.yieldCooldownUntil = finite(world.elapsedTime) + 5;
      world.entranceCompleted = finite(world.entranceCompleted) + 1;
    }
  }
  function entranceSnapshot(world, ego) {
    const list = world.vehicles.filter(vehicle => vehicle.entranceMerge).map(vehicle => ({
      id:vehicle.id, entranceId:vehicle.entranceMerge.event.id, entranceName:vehicle.entranceMerge.event.name,
      status:vehicle.entranceMerge.status, committed:vehicle.entranceMerge.committed,
      distance:vehicle.y - finite(ego.y), speedKmh:vehicle.speed * 3.6 }));
    return { activeCount:list.length, waitingCount:list.filter(item => item.status === 'waiting').length,
      mergingCount:list.filter(item => item.committed).length, arrivals:finite(world.entranceArrivals),
      completed:finite(world.entranceCompleted),
      nearest:list.slice().sort((a,b) => Math.abs(a.distance) - Math.abs(b.distance))[0] || null, list };
  }
  function chooseExitTraffic(world, ego, options) {
    const road = options.roadModel;
    if (!options.exiting || isLocal(world) || typeof road?.eventsAround !== 'function' ||
      typeof road?.centerForExit !== 'function' || finite(world.elapsedTime) < finite(world.nextExitScan)) return;
    world.nextExitScan = finite(world.elapsedTime) + .5;
    const exits = road.eventsAround(finite(ego.y), 1800).exits || [];
    for (const vehicle of world.vehicles) {
      if (vehicle.direction !== 1 || vehicle.lane !== 2 || vehicle.laneChange || vehicle.entranceMerge || vehicle.exitRoute) continue;
      const event = exits.find(exit => vehicle.y >= exit.entryStart - 450 && vehicle.y < exit.entryStart - 45);
      if (!event || vehicle.lastExitConsidered === event.id) continue;
      vehicle.lastExitConsidered = event.id;
      // Stable route preferences select only part of the ordinary right-lane
      // traffic. Existing vehicles take the slip road; no car appears there.
      if ((vehicle.id + roadHash(Math.floor(event.start), 0x635b729d)) % 3 !== 0) continue;
      const rampSpeed = event.speedLimitKmh / 3.6, deceleration = options.wet ? 1.6 : 2.5;
      const reserve = Math.max(0, (vehicle.speed * vehicle.speed - rampSpeed * rampSpeed) / (2 * deceleration)) + vehicle.speed * 1.5 + 15;
      if (event.entryStart - vehicle.y < reserve) continue;
      vehicle.exitRoute = { event, status:'approaching', wet:Boolean(options.wet) };
      world.exitSelected = finite(world.exitSelected) + 1;
    }
  }
  function exitTargetSpeed(vehicle, options) {
    const route = vehicle.exitRoute, event = route.event;
    route.wet = Boolean(options.wet);
    if (vehicle.y >= event.rampEnd) return localRoad.speedLimitKmh / 3.6;
    const rampSpeed = event.speedLimitKmh / 3.6;
    if (vehicle.y >= event.entryStart) return rampSpeed;
    const buffer = 12 + vehicle.speed * 1.5, deceleration = route.wet ? 1.6 : 2.5;
    return Math.sqrt(rampSpeed * rampSpeed + 2 * deceleration * Math.max(0, event.entryStart - vehicle.y - buffer));
  }
  function advanceExitPose(world, vehicle, previousY, road) {
    const route = vehicle.exitRoute;
    if (!route || typeof road?.centerForExit !== 'function') return;
    const previousX = vehicle.x;
    vehicle.x = road.centerForExit(route.event, vehicle.y);
    vehicle.heading = Math.atan2(vehicle.x - previousX, Math.max(.00001, vehicle.y - previousY)) * 180 / Math.PI;
    if (vehicle.y >= route.event.rampEnd) {
      if (route.status !== 'local') world.exitCompleted = finite(world.exitCompleted) + 1;
      route.status = 'local'; vehicle.x = localLanes[0]; vehicle.heading = 0;
      if (isLocal(world)) { vehicle.exitRoute = null; vehicle.lane = 0; }
    } else route.status = vehicle.y >= route.event.entryStart ? 'ramp' : 'approaching';
  }
  function exitSnapshot(world, ego) {
    const list = world.vehicles.filter(vehicle => vehicle.exitRoute).map(vehicle => ({
      id:vehicle.id, exitId:vehicle.exitRoute.event.id, exitName:vehicle.exitRoute.event.name,
      status:vehicle.exitRoute.status, x:vehicle.x, y:vehicle.y,
      distance:vehicle.y - finite(ego.y), speedKmh:vehicle.speed * 3.6 }));
    return { activeCount:list.filter(item=>item.status!=='local').length,
      departedCount:list.filter(item=>item.status==='local').length, completed:finite(world.exitCompleted),
      nearest:list.slice().sort((a,b)=>Math.abs(a.distance)-Math.abs(b.distance))[0] || null, list };
  }
  function transitionToLocal(world, ego, exit) {
    const next = createState(ego,{density:world?.density,roadType:'local',roadStart:exit?.rampEnd});
    if (!world || !exit) return next;
    const preset = presetFor(next);
    const retained = world.vehicles.filter(vehicle => vehicle.exitRoute?.event.id === exit.id &&
      Math.abs(vehicle.y - finite(ego.y)) <= preset.recycleDistance)
      .sort((a,b)=>Math.abs(a.y-finite(ego.y))-Math.abs(b.y-finite(ego.y)))
      .slice(0,preset.countPerLane);
    const retainedIds = new Set(retained.map(vehicle=>vehicle.id));
    let uniqueId = Math.max(1000, finite(world.nextEntranceId), ...world.vehicles.map(vehicle=>finite(vehicle.id)+1));
    let seeds = next.vehicles.filter(vehicle => vehicle.direction < 0 || !retained.some(other =>
      Math.abs(vehicle.y-other.y) < (vehicle.length+other.length)/2 + Math.max(10, other.speed*preset.headway)));
    const maxSeeds = preset.countPerLane*2 - retained.length;
    while (seeds.length > maxSeeds) {
      const candidates = seeds.filter(vehicle=>vehicle.direction>0).sort((a,b)=>Math.abs(b.y-finite(ego.y))-Math.abs(a.y-finite(ego.y)));
      if (!candidates.length) break;
      seeds.splice(seeds.indexOf(candidates[0]),1);
    }
    for (const vehicle of seeds) { while(retainedIds.has(uniqueId)) uniqueId++; vehicle.id=uniqueId++; }
    for (const vehicle of retained) {
      vehicle.lane = 0;
      vehicle.exitRoute.localTraffic = true;
      if (vehicle.exitRoute.status === 'local') vehicle.exitRoute = null;
      vehicle.fromEntrance = false;
    }
    next.vehicles = [...seeds,...retained];
    next.nextEntranceId = uniqueId;
    next.elapsedTime = finite(world.elapsedTime);
    next.exitCompleted = finite(world.exitCompleted);
    return next;
  }
  // Retain two independent, moving traffic populations while the player travels
  // between roads. IDs stay distinct because the renderer tracks cars by ID.
  function createHighwayFromLocal(world, ego) {
    const next = createState(ego, { density:world?.density });
    let id = Math.max(10000, finite(world?.nextEntranceId), ...(world?.vehicles || []).map(v=>finite(v.id)+1));
    for (const vehicle of next.vehicles) vehicle.id = id++;
    next.nextEntranceId = id;
    next.elapsedTime = finite(world?.elapsedTime);
    next.nextEntranceArrival = next.elapsedTime + 3;
    return next;
  }
  function cityEntranceAllowed(world, ego, event, {wet=false,targetSpeed=20/3.6}={}) {
    if (!event || !isLocal(world)) return {allowed:false,reason:'当前没有可驶入的城市入口'};
    const speed = Math.max(0,finite(ego.speed)), start = finite(ego.y), startX = finite(ego.x,29);
    // Predict the first turn, including a stationary start. The opposed lane
    // must remain clear until the entire body has crossed it, not just now.
    const cap = clamp(targetSpeed,1,20/3.6);
    // Cover both a gentle start and the force model's maximum acceleration.
    // A slow-only prediction incorrectly assumes the oncoming car will have
    // passed before this high-power demo car actually crosses its lane.
    for (const acceleration of [wet?1.2:1.6,wet?4.3:5.6]) {
    for (let t=0; t<=90; t+=.25) {
      const rampTime = Math.max(0,(cap-speed)/acceleration), accelerated = Math.min(t,rampTime);
      const travel = speed*accelerated + .5*acceleration*accelerated*accelerated + Math.max(0,t-rampTime)*Math.max(cap,speed);
      const u = clamp(travel/60,0,1), x = startX + (18-startX)*u*u*(3-2*u);
      if (x < 22) break;
      for (const vehicle of world.vehicles) {
        const ext = vehicleExtents(vehicle), direction = finite(vehicle.direction,1);
        const futureY = vehicle.y + direction*Math.max(0,finite(vehicle.speed))*t;
        if (Math.abs(vehicle.x-x) < ext.x+1.8 && Math.abs(futureY-(start+travel)) < ext.y+3.5+(wet?3:1)) {
          return {allowed:false,vehicleId:vehicle.id,oncoming:direction<0,reason:direction<0?'对向有来车，请在本车道等待安全间隙':'入口附近有车辆，请让行后再左转'};
        }
      }
    }
    }
    return {allowed:true,reason:'路口间隙足够，可以低速左转进入匝道'};
  }
  function highwayMergeAllowed(world, ego, {wet=false}={}) {
    if (!world) return {allowed:false,reason:'正在确认高速车流'};
    const speed = Math.max(0,finite(ego.speed)), extent = egoExtents(ego);
    for (const vehicle of world.vehicles) {
      if (vehicle.direction < 0 || !overlapsCorridor(vehicle,lanes[2],.93,.2)) continue;
      const delta = vehicle.y-finite(ego.y), gap = Math.abs(delta)-vehicleExtents(vehicle).y-extent.y;
      const otherSpeed = Math.max(0,finite(vehicle.speed)), horizon = wet?8:6;
      const projected = gap + (delta>=0?otherSpeed-speed:speed-otherSpeed)*horizon;
      const margin = delta>=0?Math.max(12,speed*(wet?2:1.5)):Math.max(12,otherSpeed*(wet?2:1.4));
      if (gap<margin || projected<margin) return {allowed:false,reason:delta>=0?'高速右车道前方间距不足，等待汇入':'高速右车道后车接近，等待汇入'};
    }
    return {allowed:true,reason:'高速右车道前后间隙足够'};
  }
  function recycle(world, ego) {
    const preset = presetFor(world);
    // Entrance arrivals have a real source. Retire distant arrivals instead
    // of teleporting the same car back onto its ramp or into another lane.
    world.vehicles = world.vehicles.filter(vehicle => !vehicle.fromEntrance ||
      Math.abs(vehicle.y - ego.y) <= (vehicle.exitRoute ? Math.max(2200, preset.recycleDistance) : preset.recycleDistance));
    for (const vehicle of world.vehicles) {
      const offset = vehicle.y - ego.y;
      if (vehicle.fromEntrance) continue;
      // Departing vehicles remain observable for the full slip road even
      // with the shorter recycling range used by dense motorway traffic.
      const wideRecycle = Boolean(vehicle.exitRoute || vehicle.exitRecycled);
      const recycleRange = wideRecycle ? Math.max(2200, preset.recycleDistance) : preset.recycleDistance;
      if (Math.abs(offset) <= recycleRange) continue;
      // Dense traffic has a shorter distant recycling window, keeping its
      // visible queue dense without requiring hundreds of additional cars.
      // Candidates are always far from ego and cannot overlap another NPC.
      const side = offset < 0 ? 1 : -1;
      let candidate = ego.y + side * (wideRecycle ? Math.max(1900, preset.spawnDistance) : preset.spawnDistance);
      let attempts = 0;
      const clearGap = Math.min(85, preset.spacing * .6), stride = clearGap + 10;
      while (world.vehicles.some(other => other !== vehicle && occupiedLanes(other).includes(vehicle.lane) &&
        Math.abs(other.y - candidate) < clearGap + (vehicle.length + other.length) / 2) && attempts++ < 40) candidate += side * stride;
      if (attempts > 40) continue;
      vehicle.y = vehicle.previousY = candidate;
      vehicle.laneChange = null;
      if (vehicle.exitRoute) vehicle.exitRecycled = true;
      vehicle.exitRoute = null; vehicle.lastExitConsidered = null;
      vehicle.x = vehicle.previousX = lanesFor(world)[vehicle.lane];
      vehicle.heading = vehicle.previousHeading = vehicle.direction > 0 ? 0 : 180;
      vehicle.yieldCooldownUntil = 0;
      vehicle.speed = limitFor(world,candidate) / 3.6 * vehicle.cruiseFactor * preset.speedFactor;
      vehicle.braking = false;
    }
  }
  function step(world, ego, dt, options = {}) {
    if (!world || !Array.isArray(world.vehicles) || !Number.isFinite(dt) || dt <= 0) return world;
    ego = ego || {};
    if (options.roadModel) world.roadModel = options.roadModel;
    const egoY = finite(ego.y), egoX = finite(ego.x), extent = egoExtents(ego);
    const egoForwardSpeed = travelDirection(ego) * finite(ego.speed) * Math.cos(finite(ego.heading) * Math.PI / 180);
    const preset = presetFor(world);
    spawnEntranceTraffic(world, ego, options);
    chooseExitTraffic(world, ego, options);
    const substeps = Math.ceil(Math.min(dt, 10) / constants.maxSubstep), subDt = Math.min(dt, 10) / substeps;
    for (const vehicle of world.vehicles) {
      vehicle.previousY = vehicle.y; vehicle.previousX = vehicle.x; vehicle.previousHeading = vehicle.heading;
    }
    for (let i = 0; i < substeps; i++) {
      for (const vehicle of world.vehicles) {
        advanceYield(world, vehicle, ego, subDt);
        prepareEntranceMerge(world, vehicle, ego, options);
      }
      // A turning car occupies both lanes until centered. Build predecessor
      // lists once per substep, then move every car exactly once, front first.
      const leaders = new Map();
      const laneGroups = Array.from({length:lanesFor(world).length + (isLocal(world) ? 0 : 1)},(_,lane)=>lane);
      laneGroups.push(...new Set(world.vehicles.flatMap(vehicle=>occupiedLanes(vehicle)).filter(lane=>typeof lane==='string')));
      for (const lane of laneGroups) {
        const direction = typeof lane === 'string' || lane === 6 ? 1 : directionFor(world, lane);
        const group = world.vehicles.filter(vehicle => occupiedLanes(vehicle).includes(lane))
          .sort((a, b) => direction * (b.y - a.y));
        for (let j = 1; j < group.length; j++) {
          const list = leaders.get(group[j]) || [];
          list.push(group[j-1]); leaders.set(group[j], list);
        }
      }
      const ordered = world.vehicles.slice().sort((a, b) => b.direction - a.direction || a.direction * (b.y - a.y));
      for (const vehicle of ordered) {
          const direction = vehicle.direction;
          let gap = Infinity, leaderSpeed = 0, stopAt = null;
          for (const leader of leaders.get(vehicle) || []) {
            const candidateGap = direction * (leader.y - vehicle.y) - (vehicle.length + leader.length) / 2;
            if (candidateGap < gap) {
              gap = candidateGap; leaderSpeed = leader.speed;
              stopAt = leader.y - direction * ((vehicle.length + leader.length) / 2 + constants.minGap);
            }
          }
          const exitEgoAhead = vehicle.exitRoute && typeof options.roadModel?.centerForExit === 'function' &&
            Math.abs(egoX - options.roadModel.centerForExit(vehicle.exitRoute.event, egoY)) < extent.x + vehicle.width / 2 + .2;
          if ((overlapsCorridor(vehicle, egoX, extent.x, .2) || exitEgoAhead) &&
            direction * (egoY - vehicle.y) > 0) {
            const egoGap = direction * (egoY - vehicle.y) - vehicle.length / 2 - extent.y;
            if (egoGap < gap) {
              gap = egoGap; leaderSpeed = Math.max(0, direction * egoForwardSpeed);
              stopAt = egoY - direction * (vehicle.length / 2 + extent.y + constants.minGap);
            }
          }
          const roadSpeed = Math.min(limitFor(world,vehicle.y), limitFor(world,vehicle.y + direction * 95)) / 3.6;
          let desired = roadSpeed * vehicle.cruiseFactor * preset.speedFactor;
          if (vehicle.laneChange?.status === 'waiting') desired = 0;
          if (vehicle.exitRoute) desired = Math.min(desired, exitTargetSpeed(vehicle, options));
          const entry = vehicle.entranceMerge;
          if (entry) {
            // Match motorway traffic while using the acceleration lane; a
            // blocked arrival brakes to the waiting line before the taper.
            desired = Math.min(roadSpeed * .88, entry.committed ? Infinity : 25);
            if (!entry.committed) {
              const line = entry.event.mergeStart - 8, remaining = Math.max(0, line - vehicle.y);
              const deceleration = entry.wet ? 2.4 : 3.5, response = deceleration * 1.5;
              desired = Math.min(desired, Math.max(0, Math.sqrt(response * response +
                2 * deceleration * Math.max(0, remaining - 4)) - response));
              if (remaining < .2) desired = 0;
              stopAt = stopAt === null ? line : Math.min(stopAt, line);
            } else if (entry.status === 'waiting') desired = 0;
          }
          if (Number.isFinite(gap)) {
            // A stopping-distance + time-headway bound makes a slow queue
            // stable, including when the player's car is standing still.
            const decel = vehicle.exitRoute && options.wet ? 2.4 : 4.5, head = decel * (preset.headway + (vehicle.exitRoute && options.wet ? .6 : 0));
            const safe = Math.max(0, Math.sqrt(head * head + leaderSpeed * leaderSpeed +
              2 * decel * Math.max(0, gap - constants.minGap)) - head);
            desired = Math.min(desired, safe);
          }
          const before = vehicle.speed;
          const startY = vehicle.y;
          vehicle.speed = Math.max(0, before + clamp((desired - before) * 1.2, -5, 1.6) * subDt);
          if (desired === 0 && vehicle.speed < .03) vehicle.speed = 0;
          vehicle.braking = vehicle.speed < before - .025;
          vehicle.y += direction * (before + vehicle.speed) * .5 * subDt;
          // The geometric final bound prevents tunnelling in very tight queues.
          if (stopAt !== null && direction * (vehicle.y - stopAt) > 0) {
            // A reversing ego can consume the gap. Stop this NPC instead of
            // dragging it backwards ahead of the player's physical contact.
            vehicle.y = startY + direction * Math.max(0, direction * (stopAt - startY));
            vehicle.speed = Math.min(vehicle.speed, leaderSpeed);
          }
          advanceEntrancePose(world, vehicle, startY, subDt, options.roadModel);
          advanceExitPose(world, vehicle, startY, options.roadModel);
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
      const returning = !isLocal(world) && ego.exitReturn;
      const route = !returning && !isLocal(world) && ego.exitRoute;
      const pathCenter = returning && typeof world.roadModel?.centerForReturn === 'function' ?
        world.roadModel.centerForReturn(returning, vehicle.y) :
        route && typeof world.roadModel?.centerForExit === 'function' ?
          world.roadModel.centerForExit(route, vehicle.y) : x;
      const sameExit = route && vehicle.exitRoute?.event.id === route.id;
      if (vehicle.direction !== 1 || (!sameExit && !overlapsCorridor(vehicle, pathCenter, extent.x))) continue;
      const distance = Math.max(0, Math.abs(vehicle.y - y) - vehicle.length / 2 - extent.y);
      const item = { id: vehicle.id, lane: vehicle.lane, distance, speedKmh: vehicle.speed * 3.6 };
      if (vehicle.y >= y && (!nearestAhead || distance < nearestAhead.distance)) nearestAhead = item;
      if (vehicle.y < y && (!nearestBehind || distance < nearestBehind.distance)) nearestBehind = item;
    }
    return { speedLimitKmh: limitFor(world,y), roadType:isLocal(world) ? 'local' : 'highway',
      density: densityFor(world.density), vehicleCount: world.vehicles.length,
      nearestAhead, nearestBehind, vehicles: world.vehicles, merging: entranceSnapshot(world, ego), exiting: exitSnapshot(world, ego),
      roadSigns: signsAround(y).map(sign => isLocal(world) ? { ...sign,limitKmh:localRoad.speedLimitKmh } : sign) };
  }

  /**
   * Advisory only: observe the three normal lanes without touching vehicles or
   * controls. Gaps are bumper-to-bumper, not centre distances. A seven-second
   * dry / eight-second wet window covers the geometric controller's gradual
   * lane change. Front prediction uses an upper bound on physical acceleration
   * (6 m/s² dry, 4.5 m/s² wet) toward the requested, road-capped speed;
   * rear prediction does not assume that acceleration will open a safe gap.
   * The current lane also needs clearance for the first four / five seconds:
   * an empty destination cannot make a too-late departure safe.
   */
  function getLaneRecommendation(world, ego = {}, { wet = false, desiredSpeed = limitAt(ego.y) / 3.6 } = {}) {
    if (isLocal(world)) return { status:'unavailable', direction:null, targetLane:null, currentLane:0,
      reason:'普通道路每方向一条车道，请沿当前车道行驶', lanes:[] };
    const x = finite(ego.x), y = finite(ego.y), speed = Math.max(0, finite(ego.speed));
    const currentLane = [0, 1, 2].reduce((best, lane) =>
      Math.abs(x - lanes[lane]) < Math.abs(x - lanes[best]) ? lane : best, 0);
    const roadSpeed = limitAt(y) / 3.6;
    const desired = clamp(finite(desiredSpeed, roadSpeed), 0, roadSpeed);
    const horizon = wet ? 8 : 7, acceleration = wet ? 4.5 : 6, extent = egoExtents(ego);
    const projectedTravel = duration => {
      const accelerationTime = Math.min(duration, Math.max(0, desired - speed) / acceleration);
      return speed * duration + .5 * acceleration * accelerationTime * accelerationTime +
        Math.max(0, desired - speed) * (duration - accelerationTime);
    };
    const projectedDistance = projectedTravel(horizon);
    const departureHorizon = wet ? 5 : 4, departureDistance = projectedTravel(departureHorizon);
    const frontMargin = Math.max(12, speed * (wet ? 1.8 : 1.3));
    const futureFrontMargin = Math.max(10, Math.max(speed, desired) * (wet ? 1.4 : 1));
    const vehicles = Array.isArray(world?.vehicles) ? world.vehicles : [];
    const metres = gap => `${Math.max(0, Math.round(gap))} 米`;
    const laneInfo = [0, 1, 2].map(lane => {
      let frontGap = Infinity, rearGap = Infinity, frontSpeed = null, rearSpeed = null;
      let projectedFrontGap = Infinity, projectedRearGap = Infinity, departureFrontGap = Infinity, availableSpeed = desired;
      let overlap = false, shortFront = false, shortRear = false, closingFront = false, closingRear = false;
      let fastRear = false;
      // Check every car in the target corridor. A second, faster rear car
      // must not be hidden by a nearer slower one in the same lane.
      for (const v of vehicles) {
        if (![v.x, v.y].every(Number.isFinite) ||
          !overlapsCorridor(v, lanes[lane], extent.x, .15)) continue;
        const carSpeed = Math.max(0, finite(v.speed)) * (v.direction === -1 ? -1 : 1);
        const offset = v.y - y, halfLength = extent.y + Math.max(1, finite(v.length, 4.5)) / 2;
        const gap = Math.abs(offset) - halfLength;
        if (gap <= 2) overlap = true;
        if (offset >= 0) {
          const projectedGap = gap + carSpeed * horizon - projectedDistance;
          if (gap < frontGap) { frontGap = gap; frontSpeed = carSpeed; }
          projectedFrontGap = Math.min(projectedFrontGap, projectedGap);
          departureFrontGap = Math.min(departureFrontGap, gap, gap + carSpeed * departureHorizon - departureDistance);
          shortFront ||= gap < frontMargin;
          closingFront ||= projectedGap < futureFrontMargin;
          availableSpeed = Math.min(availableSpeed,
            Math.max(0, carSpeed + Math.max(0, gap - frontMargin) / horizon));
        } else {
          const projectedGap = gap + (speed - carSpeed) * horizon;
          if (gap < rearGap) { rearGap = gap; rearSpeed = carSpeed; }
          projectedRearGap = Math.min(projectedRearGap, projectedGap);
          shortRear ||= gap < Math.max(10, carSpeed * (wet ? 1.8 : 1.2));
          const unsafeFuture = projectedGap < Math.max(10, carSpeed * (wet ? 1.2 : .8));
          closingRear ||= unsafeFuture;
          fastRear ||= unsafeFuture && carSpeed - speed > 3;
        }
      }
      const adjacent = Math.abs(lane - currentLane) === 1;
      const reachable = lane === currentLane || adjacent;
      const safe = reachable && !overlap && !shortFront && !shortRear && !closingFront && !closingRear;
      const reason = !reachable ? '需逐条变道，不能跨越车道' : overlap ? '有车辆并排行驶，等待间隙' :
        shortFront ? `前车仅 ${metres(frontGap)}，前方间距不足` : fastRear ? '后车快速接近，变道期间间距不足' :
        shortRear ? `后车仅 ${metres(rearGap)}，后方间距不足` : closingFront ? '预计变道期间会过于接近前车' :
        closingRear ? '预计变道期间后方间距不足' : lane === currentLane ? '当前车道' : '前后间距满足当前变道预测';
      const nullable = value => Number.isFinite(value) ? value : null;
      return { lane, frontGap: nullable(frontGap), rearGap: nullable(rearGap), frontSpeed, rearSpeed,
        projectedFrontGap: nullable(projectedFrontGap), projectedRearGap: nullable(projectedRearGap),
        departureFrontGap: nullable(departureFrontGap), availableSpeed, safe, adjacent, reason };
    });
    const result = (status, reason, targetLane = null) => ({ status,
      direction: targetLane === null ? null : targetLane < currentLane ? 'left' : 'right',
      targetLane, currentLane, reason, lanes: laneInfo });
    if (ego.gear === 'reverse') return result('unavailable', '倒车中，暂不推荐变道');
    if (speed < 2) return result('unavailable', '车速较低，起步后再评估变道');
    if (x > 5.625 || x < -5.625) return result('unavailable', '请先返回正常行车道');
    const heading = Math.atan2(Math.sin(finite(ego.heading) * Math.PI / 180), Math.cos(finite(ego.heading) * Math.PI / 180));
    if (Math.abs(x - lanes[currentLane]) > .6 || Math.abs(heading) > 8 * Math.PI / 180)
      return result('unavailable', '正在调整车道位置，回正后重新评估');
    if (speed > roadSpeed + .5) return result('unavailable', '正在降至道路限速，先保持当前车道');
    const current = laneInfo[currentLane];
    if (desired - current.availableSpeed < 2) {
      const frontNeedsAttention = current.frontGap !== null &&
        (current.frontGap < frontMargin || current.projectedFrontGap < futureFrontMargin);
      return result('keep', frontNeedsAttention ? '前方间距较小，请留意前车并控制车速' : '当前车道通行顺畅，保持车道');
    }
    const beneficial = laneInfo.filter(info => info.adjacent && info.availableSpeed - current.availableSpeed >= 2);
    const candidates = beneficial.filter(info => info.safe).sort((a, b) =>
      b.availableSpeed - a.availableSpeed ||
      Math.min(300, b.projectedFrontGap ?? 300) - Math.min(300, a.projectedFrontGap ?? 300) || a.lane - b.lane);
    if (!candidates.length) return result('blocked', beneficial.length ?
      '前方车流较慢，相邻车道间距不足，暂缓变道' : '相邻车道没有明显通行优势，保持当前车道');
    if (current.departureFrontGap !== null && current.departureFrontGap < 10)
      return result('blocked', '当前前车过近，请先减速拉开车距再变道');
    const target = candidates[0], direction = target.lane < currentLane ? '左' : '右';
    return result('recommend', `前方车流较慢，建议向${direction}变道；请留意周围车辆`, target.lane);
  }
  // Swept relative AABB collision catches high-speed crossings between frames.
  // This intentionally small arcade contact model does not operate controls
  // or emergency-stop state. It corrects motion/brake measurements when a
  // collision truncates the physics step, including NPC lateral movement.
  function resolveContact(world, ego, previousPose) {
    if (!world || !ego || ![ego.x, ego.y, ego.speed].every(Number.isFinite)) return null;
    const previous = previousPose && [previousPose.x, previousPose.y].every(Number.isFinite) ? previousPose : ego;
    const extent = egoExtents(ego), contacts = [];
    for (const v of world.vehicles) {
      const npcExtent = vehicleExtents(v), previousExtent = vehicleExtents(v, finite(v.previousHeading, v.heading));
      const halfX = extent.x + Math.max(npcExtent.x, previousExtent.x);
      const halfY = extent.y + Math.max(npcExtent.y, previousExtent.y);
      const sx = previous.x - finite(v.previousX, v.x), sy = previous.y - finite(v.previousY, v.y);
      const dx = ego.x - previous.x - (v.x - finite(v.previousX, v.x));
      const dy = ego.y - previous.y - (v.y - finite(v.previousY, v.y));
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
    const leftBoundary = isLocal(world) ? localRoad.left+extent.x : constants.guardrailLeft;
    const rightBoundary = isLocal(world) ? localRoad.right-extent.x : constants.guardrailRight;
    if (hit.axis === 'x' && (sideX < leftBoundary || sideX > rightBoundary)) hit.axis = 'y';
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
  return Object.freeze({ constants, densityPresets, createState, setDensity, step, limitAt, nextLimit, signsAround, getSnapshot,
    getLaneRecommendation, requestYield, resolveContact, transitionToLocal,
    createHighwayFromLocal, cityEntranceAllowed, highwayMergeAllowed });
});
