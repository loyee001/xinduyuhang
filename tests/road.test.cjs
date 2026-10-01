'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const road = require('../dist/road.js');

test('solid zones and exits are deterministic world events in both directions', () => {
  const before = road.eventsAround(4800, 7000);
  road.eventsAround(99999);
  assert.deepEqual(road.eventsAround(4800, 7000), before);
  assert.deepEqual(road.getState(500).activeSolid, { id: 'solid-0', start: 350, end: 600 });
  assert.ok(road.eventsAround(-2400).solids.some(zone => zone.start < 0));
  assert.deepEqual(road.getState(-2000), road.getState(-2000));
});
test('solid-zone boundaries and clear gaps agree with the painted schedule', () => {
  for (const y of [350, 500, 600]) assert.equal(road.getState(y).solid, true);
  for (const y of [0, 349.999, 600.001, 1200]) assert.equal(road.getState(y).solid, false);
  assert.equal(road.getState(0).nextSolid.distance, 350);
  assert.equal(road.getState(0).nextExit.distance, 1200);
});
test('intervals and lengths vary while exits remain outside solid zones', () => {
  const { solids, exits } = road.eventsAround(8000, 12000);
  assert.ok(new Set(solids.slice(1).map((zone, i) => zone.start - solids[i].start)).size > 2);
  assert.ok(new Set(solids.map(zone => zone.end - zone.start)).size > 1);
  assert.ok(new Set(exits.slice(1).map((exit, i) => exit.start - exits[i].start)).size > 2);
  for (const exit of exits) assert.ok(!solids.some(zone => zone.end >= exit.openingStart && zone.start <= exit.openingEnd));
});
test('lane changes reserve an eight-second path and include the vehicle body', () => {
  assert.equal(road.canChangeLane(500).allowed, false);
  assert.equal(road.canChangeLane(0, { speed: 30 }).allowed, true);
  assert.equal(road.canChangeLane(100, { speed: 30, targetSpeed: 35 }).allowed, false);
  assert.equal(road.canChangeLane(0, { speed: 0, targetSpeed: 100 }).allowed, false);
  assert.equal(road.canChangeLane(602).allowed, false);
  assert.equal(road.canChangeLane(603).allowed, true);
  assert.ok(road.canChangeLane(500).remaining > 100);
});
test('reverse checks the road behind rather than the next forward solid', () => {
  assert.equal(road.canChangeLane(800, { speed: 5, gear: 'reverse' }).allowed, true);
  assert.equal(road.canChangeLane(640, { speed: 5, gear: 'reverse' }).allowed, false);
  assert.equal(road.canChangeLane(300, { speed: 5, gear: 'reverse' }).allowed, true);
  assert.equal(road.canChangeLane(349, { speed: 0, gear: 'reverse' }).allowed, false);
});
test('a drivable exit connects the right lane smoothly to the ordinary road', () => {
  const exit = road.getState(0).nextExit;
  assert.equal(exit.name, '1 号出口');
  assert.equal(exit.width, 5);
  assert.equal(exit.speedLimitKmh, 40);
  assert.equal(road.centerForExit(exit, exit.entryStart - 10), 3.75);
  assert.equal(road.centerForExit(exit, exit.entryStart), 3.75);
  assert.equal(road.centerForExit(exit, exit.entryStart + 420), 29);
  assert.equal(road.centerForExit(exit, exit.rampEnd), 29);
  assert.ok(exit.rampEnd - exit.entryStart - 420 >= 300);
  let previous = 3.75;
  for (let y = exit.entryStart; y <= exit.rampEnd; y++) {
    const x = road.centerForExit(exit, y);
    assert.ok(x >= previous && x - previous < .1);
    previous = x;
  }
  assert.equal(road.getState(exit.entryStart).activeExit.id, exit.id);
  assert.equal(road.getState(exit.rampEnd + 1).activeExit, null);
});
test('the ordinary road has one lane in each direction and a separate speed limit', () => {
  assert.deepEqual(road.localRoad, { speedLimitKmh:50, laneCenter:29,
    oncomingLaneCenter:25.5, width:7, halfLaneWidth:1.75 });
  const exit = road.getState(0).nextExit;
  assert.equal(road.centerForExit(exit,exit.rampEnd),road.localRoad.laneCenter);
  assert.equal(road.centerForExit(exit,exit.rampEnd+10000),road.localRoad.laneCenter);
});
test('long-distance and invalid-input queries stay finite and bounded', () => {
  for (const y of [-10000000, 10000000, NaN, Infinity]) {
    const state = road.getState(y);
    assert.ok(Number.isFinite(state.nextSolid.start));
    assert.ok(Number.isFinite(state.nextExit.start));
    assert.ok(Number.isFinite(road.canChangeLane(y, { speed: NaN }).remaining));
  }
  assert.ok(road.eventsAround(0, Infinity).solids.length < 30);
});

test('Canvas fallback renders solid roads and exits through forward and reverse origin changes', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  let painted = 0, pathPoints = [], bottomCenter = null;
  const point = (x, y) => { assert.ok(Number.isFinite(x) && Number.isFinite(y)); pathPoints.push([x,y]); };
  const coversBottomCenter = () => {
    let inside = false;
    for (let i = 0, j = pathPoints.length-1; i < pathPoints.length; j = i++) {
      const [xi,yi] = pathPoints[i], [xj,yj] = pathPoints[j];
      if ((yi > 299) !== (yj > 299) && 195 < (xj-xi)*(299-yi)/(yj-yi)+xi) inside = !inside;
    }
    return inside;
  };
  const context2d = { createLinearGradient: () => ({ addColorStop() {} }), fillRect() { bottomCenter = null; },
    beginPath() { pathPoints = []; }, moveTo: point, lineTo: point, closePath() {},
    fill() { painted++; if (coversBottomCenter()) bottomCenter = this.fillStyle; } };
  const canvas = { width: 0, height: 0, getContext: kind => kind === '2d' ? context2d : null,
    getBoundingClientRect: () => ({ width: 390, height: 300 }), addEventListener() {}, removeEventListener() {} };
  const window = { RoverRoad: road, addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
  const context = vm.createContext({ window, performance: { now: () => 0 } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/simulator.js'), 'utf8'), context);
  const camera = window.RoverSimulator.createCamera(canvas);
  for (const [y, gear] of [[0,'forward'],[500,'forward'],[1200,'forward'],[1800,'reverse'],[500,'reverse'],[-400,'reverse']]) {
    const exit = road.getState(y).activeExit;
    const x = exit && y > 1400 ? road.centerForExit(exit,y) : 0;
    assert.equal(camera.draw({ x, y, heading: 0, gear, traffic: [] }), true);
    assert.equal(camera.stats.roadSolid, road.getState(y).solid);
    assert.equal(camera.stats.worldOrigin, Math.floor(y / 400) * 400);
  }
  assert.equal(camera.stats.backend, 'Canvas 2D');
  assert.ok(painted > 1000);
  const exit = road.getState(0).nextExit;
  for (const y of [exit.rampEnd-100,exit.rampEnd-1,exit.rampEnd,exit.rampEnd+20,6000,12340]) {
    const localRoad = y >= exit.rampEnd;
    camera.draw({ x:29, y, heading:0, gear:'forward', traffic:[], exitRoute:exit, localRoad });
    assert.equal(bottomCenter, 'rgb(81,89,97)', `continuous pavement before and after the connection at ${y} m`);
    assert.equal(camera.stats.roadType, localRoad ? 'local' : 'exit');
    if (localRoad) {
      assert.equal(camera.stats.nearbyExits,0,'later highway exits cannot overwrite the ordinary road');
      assert.equal(camera.stats.roadSolid,false,'highway solid-zone state is not reused on the ordinary road');
    }
  }
  camera.draw({ x:25.5, y:12340, heading:0, gear:'reverse', traffic:[], exitRoute:exit, localRoad:true });
  assert.equal(bottomCenter, 'rgb(81,89,97)', 'the opposing lane remains paved across distant reverse views');
  for (const y of [exit.entryStart-100,-2000,-12000]) {
    camera.draw({ x:29,y,heading:0,gear:'reverse',traffic:[],exitRoute:exit,localRoad:true });
    assert.equal(bottomCenter,'rgb(81,89,97)','ordinary-road reverse travel remains paved beyond the original connection');
    assert.equal(camera.stats.roadType,'local');
    assert.equal(camera.stats.nearbyExits,0);
  }
  camera.draw({ x:29, y:12340, heading:0, gear:'forward', localRoad:true, exitRoute:exit,
    traffic:[{ id:1,kind:'car',color:'#ffffff',width:1.85,length:4.5,x:0,y:12380,direction:1 }] });
  assert.equal(camera.stats.visibleTraffic,0,'unmapped highway traffic is not drawn on ordinary-road grass');
  camera.dispose();
  assert.equal(camera.draw({ x: 0, y: 0, heading: 0 }), false);
});
