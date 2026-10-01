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
    vehicleLength: 5, rampWidth: 5, rampLimitKmh: 40, rampBendLength: 420 });
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
    const start = index * constants.cellLength + 1200 + variation(index, 307) % 160;
    const entryStart = start - 120, rampEnd = start + 650;
    const number = ((index % 99) + 99) % 99 + 1;
    return { id: `exit-${index}`, number, name: `${number} 号出口`, start, end: rampEnd,
      entryStart, entryEnd: start + 140, openingStart: entryStart - 30,
      openingEnd: entryStart + 260, rampEnd, width: constants.rampWidth,
      speedLimitKmh: constants.rampLimitKmh, signStart: start - 600 };
  }
  function eventsAround(y, radius = 1600) {
    y = coordinate(y);
    radius = clamp(Math.abs(coordinate(radius)), 0, 20000);
    const low = y - radius, high = y + radius;
    const first = Math.floor((low - 2000) / constants.cellLength);
    const last = Math.floor((high + 600) / constants.cellLength);
    const solids = [], exits = [];
    for (let index = first; index <= last; index++) {
      const solid = solidInCell(index), exit = exitInCell(index);
      if (solid.end >= low && solid.start <= high) solids.push(solid);
      if (exit.rampEnd >= low && exit.signStart <= high) exits.push(exit);
    }
    return { solids, exits };
  }
  function getState(y) {
    y = coordinate(y);
    const { solids, exits } = eventsAround(y, constants.cellLength * 2);
    const activeSolid = solids.find(zone => y >= zone.start && y <= zone.end) || null;
    const activeExit = exits.find(exit => y >= exit.entryStart && y <= exit.rampEnd) || null;
    const nextSolid = solids.find(zone => zone.start > y);
    const nextExit = exits.find(exit => exit.entryEnd >= y);
    return { solid: Boolean(activeSolid), activeSolid,
      nextSolid: nextSolid ? { ...nextSolid, distance: nextSolid.start - y } : null,
      nextExit: nextExit ? { ...nextExit, distance: Math.max(0, nextExit.start - y) } : null,
      activeExit };
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
    const t = clamp((coordinate(y) - exit.entryStart) / constants.rampBendLength, 0, 1);
    return 3.75 + 25.25 * t * t * (3 - 2 * t);
  }
  return Object.freeze({ constants, localRoad, eventsAround, getState, canChangeLane, centerForExit });
});
