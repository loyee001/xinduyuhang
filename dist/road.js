(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverRoad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Events belong to world coordinates, including negative coordinates when
  // reversing. Rendering rebases its camera; it never rebases this schedule.
  const constants = Object.freeze({ cellLength: 2400, maneuverSeconds: 8,
    vehicleLength: 5, rampWidth: 5, rampLimitKmh: 40, rampBendLength: 420,
    decelerationLength: 360, decelerationCenter: 7.125, decelerationWidth: 3 });
  const localRoad = Object.freeze({ speedLimitKmh: 50, laneCenter: 29,
    oncomingLaneCenter: 25.5, width: 7, halfLaneWidth: 1.75 });
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const coordinate = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  function variation(index, salt) {
    if (index === 0) return 0;
    let n = Math.imul(index | 0, 374761393) ^ salt;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function solidInCell(index) {
    const start = index * constants.cellLength + 350 + variation(index, 71) % 280;
    return { id: `solid-${index}`, start, end: start + 250 + variation(index, 131) % 100 };
  }
  function exitInCell(index) {
    // Reserve a clear dashed approach even when a cell's solid section is long.
    const start = Math.max(index * constants.cellLength + 1200 + variation(index, 307) % 160,
      solidInCell(index).end + constants.decelerationLength + 40);
    const entryStart = start - constants.decelerationLength, rampEnd = start + 650;
    const number = ((index % 99) + 99) % 99 + 1;
    return { id: `exit-${index}`, number, name: `${number} 号出口`, start, end: rampEnd,
      entryStart, entryEnd: start, decelerationStart: entryStart, splitStart: start,
      decelerationCenter: constants.decelerationCenter, laneWidth: constants.decelerationWidth,
      openingStart: entryStart - 30, openingEnd: start + 230, rampEnd, width: constants.rampWidth,
      speedLimitKmh: constants.rampLimitKmh, signStart: start - 600 };
  }
  function entranceInCell(index) {
    const start = index * constants.cellLength + 1950 + variation(index, 491) % 61;
    const number = ((index % 99) + 99) % 99 + 1;
    return { id: `entrance-${index}`, number, name: `${number} 号入口`, start,
      rampStart: start, accelerationStart: start + 110, mergeStart: start + 190,
      mergeEnd: start + 370, end: start + 400, openingStart: start + 60,
      openingEnd: start + 400, signStart: start - 500, width: 3,
      cityEntryStart: start - 90, cityEntryEnd: start - 65,
      cityJoinY: start + 110, cityJunctionStart: start - 95,
      cityJunctionEnd: start + 5, citySpeedLimitKmh: 20, cityWidth: 5 };
  }
  function eventsAround(y, radius = 1600) {
    y = coordinate(y);
    radius = clamp(Math.abs(coordinate(radius)), 0, 20000);
    const low = y - radius, high = y + radius;
    const first = Math.floor((low - 2000) / constants.cellLength);
    const last = Math.floor((high + 600) / constants.cellLength);
    const solids = [], exits = [], entrances = [];
    for (let index = first; index <= last; index++) {
      const solid = solidInCell(index), exit = exitInCell(index), entrance = entranceInCell(index);
      if (solid.end >= low && solid.start <= high) solids.push(solid);
      if (exit.rampEnd >= low && exit.signStart <= high) exits.push(exit);
      if (entrance.end >= low && entrance.signStart <= high) entrances.push(entrance);
    }
    return { solids, exits, entrances };
  }
  function getState(y) {
    y = coordinate(y);
    const { solids, exits, entrances } = eventsAround(y, constants.cellLength * 2);
    const activeSolid = solids.find(zone => y >= zone.start && y <= zone.end) || null;
    const activeExit = exits.find(exit => y >= exit.entryStart && y <= exit.rampEnd) || null;
    const nextSolid = solids.find(zone => zone.start > y);
    const nextExit = exits.find(exit => exit.entryEnd >= y);
    const activeEntrance = entrances.find(entrance => y >= entrance.start && y <= entrance.end) || null;
    const nextEntrance = entrances.find(entrance => entrance.end >= y);
    const activeCityEntrance = entrances.find(entrance => y >= entrance.cityEntryStart && y <= entrance.end) || null;
    const nextCityEntrance = entrances.find(entrance => entrance.cityEntryEnd >= y);
    return { solid: Boolean(activeSolid), activeSolid,
      nextSolid: nextSolid ? { ...nextSolid, distance: nextSolid.start - y } : null,
      nextExit: nextExit ? { ...nextExit, distance: Math.max(0, nextExit.start - y) } : null,
      activeExit, activeEntrance, activeCityEntrance,
      nextCityEntrance: nextCityEntrance ? { ...nextCityEntrance, distance: Math.max(0,nextCityEntrance.cityEntryStart-y) } : null,
      nextEntrance: nextEntrance ? { ...nextEntrance, distance: Math.max(0, nextEntrance.start - y) } : null };
  }
  function canChangeLane(y, { speed = 0, gear = 'forward', targetSpeed = speed } = {}) {
    y = coordinate(y);
    const direction = gear === 'reverse' ? -1 : 1;
    const velocity = clamp(Math.max(Math.abs(coordinate(speed)), Math.abs(coordinate(targetSpeed))), 0, 100);
    const distance = velocity * constants.maneuverSeconds + constants.vehicleLength;
    // Include the rear of the vehicle as well as the entire prospective path.
    const low = Math.min(y, y + direction * distance) - constants.vehicleLength / 2;
    const high = Math.max(y, y + direction * distance) + constants.vehicleLength / 2;
    const solids = eventsAround(y, distance + constants.vehicleLength).solids;
    const blocks = solids.filter(zone => zone.start <= high && zone.end >= low);
    const block = direction > 0 ? blocks[0] : blocks.at(-1);
    if (!block) return { allowed: true, reason: '', remaining: 0 };
    const inside = y >= block.start && y <= block.end;
    const remaining = Math.max(0, direction > 0 ? block.end + constants.vehicleLength / 2 - y : y - block.start + constants.vehicleLength / 2);
    return { allowed: false, reason: inside ? `实线路段禁止变道，还需行驶 ${Math.ceil(remaining)} 米` :
      `前方实线距离不足以完成变道，请通过实线路段后再试`, remaining, blockedBy: block.id };
  }
  function centerForExit(exit, y) {
    if (!exit || !Number.isFinite(exit.entryStart)) return 3.75;
    const position = coordinate(y), center = exit.decelerationCenter ?? constants.decelerationCenter;
    const splitStart = exit.splitStart ?? exit.start;
    // Traffic moves over gradually; the player enters this parallel lane
    // with a manual right lane-change before following the branching ramp.
    if (position < splitStart) {
      const t = clamp((position - exit.entryStart) / 100, 0, 1);
      return 3.75 + (center - 3.75) * t * t * (3 - 2 * t);
    }
    const t = clamp((position - splitStart) / constants.rampBendLength, 0, 1);
    return center + (localRoad.laneCenter - center) * t * t * (3 - 2 * t);
  }
  function createExitReturn(exit, car = {}) {
    const start = coordinate(car.y), fromX = coordinate(car.x), toX = 3.75;
    const speed = clamp(Math.abs(coordinate(car.speed)), 0, 100);
    // A speed-scaled paved connection gives steering time to unwind. Its
    // start uses the actual car position, never the ideal ramp centerline.
    const length = Math.max(240, speed * 13, Math.abs(fromX - toX) * 18);
    const heading = coordinate(car.heading) * Math.PI / 180;
    const startSlope = clamp(Math.tan(heading), -.18, .18);
    return { id: `return-${exit?.id || 'exit'}-${start.toFixed(3)}-${fromX.toFixed(3)}`,
      exitId: exit?.id || null, start, end: start + length,
      fromX, toX, startSlope, width: constants.rampWidth };
  }
  function centerForReturn(route, y) {
    if (!route || !Number.isFinite(route.start) || !(route.end > route.start)) return 3.75;
    const length = route.end - route.start, t = clamp((coordinate(y) - route.start) / length, 0, 1);
    // Cubic Hermite interpolation preserves the entry tangent and arrives
    // parallel to the mainline, while all longitudinal travel remains real.
    return (2*t*t*t - 3*t*t + 1) * route.fromX +
      (t*t*t - 2*t*t + t) * length * route.startSlope +
      (-2*t*t*t + 3*t*t) * route.toX;
  }
  function centerForEntrance(entrance, y) {
    if (!entrance || !Number.isFinite(entrance.start)) return 3.75;
    const position = coordinate(y);
    if (position < entrance.accelerationStart) {
      const t = clamp((position - entrance.start) / (entrance.accelerationStart - entrance.start), 0, 1);
      return 18 + (7.125 - 18) * t * t * (3 - 2 * t);
    }
    const t = clamp((position - entrance.mergeStart) / (entrance.mergeEnd - entrance.mergeStart), 0, 1);
    return 7.125 + (3.75 - 7.125) * t * t * (3 - 2 * t);
  }
  function createCityEntrance(entrance, car = {}) {
    if (!entrance || !Number.isFinite(entrance.cityEntryStart)) return null;
    const cityEntryStart = Number.isFinite(car.y) ? car.y : entrance.cityEntryStart;
    const cityFromX = Number.isFinite(car.x) ? car.x : localRoad.laneCenter;
    const cityStartSlope = clamp(Math.tan(coordinate(car.heading)*Math.PI/180),-.18,.18);
    return { ...entrance, cityEntryStart, cityFromX, cityStartSlope,
      crossingEnd: cityEntryStart+60,
      cityRouteId: `city-${entrance.id}-${cityEntryStart.toFixed(3)}-${cityFromX.toFixed(3)}` };
  }
  function centerForCityEntrance(entrance, y) {
    if (!entrance || !Number.isFinite(entrance.cityEntryStart)) return localRoad.laneCenter;
    const position=coordinate(y), crossingEnd=entrance.crossingEnd ?? entrance.cityEntryStart+60;
    const fromX=entrance.cityFromX ?? localRoad.laneCenter;
    if (position < crossingEnd) {
      const length=crossingEnd-entrance.cityEntryStart;
      const t=clamp((position-entrance.cityEntryStart)/length,0,1);
      // Turning begins from the real pose. The first 60 m clears the opposing
      // local lane through the marked intersection before approaching the ramp.
      return (2*t*t*t-3*t*t+1)*fromX +
        (t*t*t-2*t*t+t)*length*(entrance.cityStartSlope||0) + (-2*t*t*t+3*t*t)*18;
    }
    if (position < entrance.cityJoinY) {
      const t=clamp((position-crossingEnd)/(entrance.cityJoinY-crossingEnd),0,1);
      return 18+(constants.decelerationCenter-18)*t*t*(3-2*t);
    }
    return centerForEntrance(entrance,position);
  }
  return Object.freeze({ constants, localRoad, eventsAround, getState, canChangeLane,
    centerForExit, createExitReturn, centerForReturn, centerForEntrance,
    createCityEntrance, centerForCityEntrance });
});
