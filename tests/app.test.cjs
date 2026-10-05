'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dist = path.join(__dirname, '../dist');

// A small DOM surface for application integration, not a browser/layout test.
// IDs and data attributes come from the real HTML, so missing UI targets fail.
function createDOM() {
  function element(tagName) {
    const node = {
      tagName: tagName.toUpperCase(), attributes: {}, dataset: {}, children: [],
      className: '', textContent: '', value: '', hidden: false, disabled: false,
      style: { setProperty(name, value) { this[name] = value; } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'class') this.className = String(value);
      },
      getAttribute(name) { return this.attributes[name] ?? null; },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
          .filter(child => matches(child, selector));
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { return selector.split(',').some(part => matches(node, part.trim())) ? node : null; },
      focus() {}, scrollIntoView() {}, setPointerCapture() {},
      showModal() { this.open = true; }, close() { this.open = false; }
    };
    const classes = () => new Set(node.className.split(/\s+/).filter(Boolean));
    node.classList = {
      contains(name) { return classes().has(name); },
      add(...names) { const next = classes(); names.forEach(name => next.add(name)); node.className = [...next].join(' '); },
      remove(...names) { const next = classes(); names.forEach(name => next.delete(name)); node.className = [...next].join(' '); },
      toggle(name, force) {
        const next = force ?? !this.contains(name);
        if (next) this.add(name); else this.remove(name);
        return next;
      }
    };
    return node;
  }
  function matches(node, selector) {
    if (selector === '*') return true;
    if (selector === 'dialog[open]') return node.tagName === 'DIALOG' && !!node.open;
    if (selector === '[contenteditable="true"]') return node.getAttribute('contenteditable') === 'true';
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    const data = selector.match(/^\[data-([\w-]+)\]$/);
    if (data) return Object.hasOwn(node.dataset, data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    return node.tagName.toLowerCase() === selector;
  }
  const nodes = [];
  const ids = new Map();
  for (const match of fs.readFileSync(path.join(dist, 'index.html'), 'utf8').matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
    const node = element(match[1]);
    for (const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)"|'([^']*)')?/g)) {
      const name = attr[1], value = attr[2] ?? attr[3] ?? '';
      node.setAttribute(name, value);
      if (name === 'id') ids.set(value, node);
      if (name === 'value') node.value = value;
      if (name === 'hidden' || name === 'disabled') node[name] = true;
      if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    nodes.push(node);
  }
  const listeners = new Map();
  return {
    hidden: false,
    body: nodes.find(node => node.tagName === 'BODY'),
    createElement: element,
    getElementById(id) { return ids.get(id) || null; },
    querySelectorAll(selector) { return nodes.filter(node => matches(node, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    dispatch(name) { for (const callback of listeners.get(name) || []) callback({type:name}); }
  };
}

function loadApp(windowOverrides = {}) {
  const document = createDOM();
  const modelTools = new Map();
  document.modelContext = { registerTool(tool) { modelTools.set(tool.name, tool); } };
  const listeners = new Map();
  let now = 0, timer = 0;
  const drawn = [];
  const window = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    RoverSimulator: {
      createCamera(canvas) {
        assert.equal(canvas.tagName, 'CANVAS');
        return { stats: { fps: 30, frames: 0, backend: 'test camera' }, pause() {}, draw(pose) { drawn.push(JSON.parse(JSON.stringify(pose))); return true; } };
      }
    }
  };
  Object.assign(window, windowOverrides);
  const context = vm.createContext({
    window, document, console, AbortController, performance: { now: () => now },
    location: { protocol: 'file:' },
    requestAnimationFrame() { return ++timer; },
    setTimeout() { return ++timer; }, clearTimeout() {}
  });
  for (const name of ['physics.js', 'road.js', 'traffic.js', 'lane-control.js', 'commands.js', 'autopilot.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(dist, name), 'utf8'), context, { filename: name });
  }
  // Lexical bindings are exposed only in this VM; production needs no hook.
  const app = vm.runInContext(`({
    get car() { return car; }, get state() { return state; },
    get world() { return trafficWorld; },
    get road() { return window.RoverRoad; },
    get traffic() { return window.RoverTraffic; },
    advanceElapsed, render, readState, parseCommand, submitCommand, startPlan, requestExit, tick
  })`, context);
  const ui = id => {
    const node = document.getElementById(id);
    assert.ok(node, `real HTML must contain #${id}`);
    return node;
  };
  return {
    app, document, ui, modelTools, drawn,
    frame(seconds) { now += seconds * 1000; app.tick(now); },
    advance(seconds) {
      app.advanceElapsed(seconds);
      now += seconds * 1000;
      app.render();
    },
    key(type, code, repeat = false, target = document.body) {
      const event = {
        code, key: code === 'Space' ? ' ' : code, target, repeat, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      };
      target['on' + type]?.(event);
      for (const callback of listeners.get(type) || []) callback(event);
      return event;
    },
    dispatch(name) {
      for (const callback of listeners.get(name) || []) callback({ type: name });
    },
    setTarget(value) {
      const slider = ui('speed-slider');
      slider.value = String(value);
      slider.oninput({ target: slider });
    }
  };
}

function assertNoAutomaticBrake(app) {
  assert.equal(app.state.estop, false);
  assert.equal(app.state.serviceBrake, 0);
  assert.equal(app.state.failsafe, false);
  assert.equal(app.state.lastInput.brake, 0);
  assert.equal(app.car.brakeForce, 0);
  assert.equal(app.car.braking, false);
}

test('a guardrail impact freezes the scene at contact and requests a restart without faking a full stop', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: -6.44, heading: -15, speed: 30 });
  app.state.laneTarget = 0;
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.3);
  assert.equal(app.car.wallContactCount, 1);
  assert.equal(app.state.collision.kind, 'guardrail');
  assert.ok(app.state.collisionEffect.peakHeight >= 1.8 && app.state.collisionEffect.peakHeight < 2.6,
    'even a scrape visibly lifts the whole car, but uses lateral impact speed to keep below a head-on launch');
  assert.equal(app.state.estop, false);
  assert.equal(app.state.controls.size, 0);
  assert.ok(app.car.speed > 0 && app.car.speed < 30, 'the paused impact keeps its physical velocity');
  assert.ok(!driver.ui('collision-dialog').open, 'show the brief impact animation before the result');
  const atImpact = JSON.stringify({ car: app.car, world: app.world, trail: app.state.trail });
  driver.advance(10);
  assert.equal(driver.ui('collision-dialog').open, true);
  assert.equal(JSON.stringify({ car: app.car, world: app.world, trail: app.state.trail }), atImpact);
  assert.equal(app.readState().collision.kind, 'guardrail');
});

test('road-limit crossings apply gradual braking, retain throttle, and release at the limit', () => {
  const traffic = loadApp().app.traffic;
  const transitions = [];
  for (let cursor = 0; transitions.length < 3;) {
    const next = traffic.nextLimit(cursor, 1);
    transitions.push([next.y, traffic.limitAt(next.y - 0.1), next.limitKmh]);
    cursor = next.y + 0.1;
  }
  for (const [boundary, previous, next] of transitions) {
    const driver = loadApp(), { app, ui, document } = driver;
    app.world.vehicles = [];
    driver.setTarget(100);
    driver.key('keydown', 'ArrowUp');
    Object.assign(app.car, { x: 0, y: boundary - 0.1, heading: 0, steer: 0, speed: 40 });
    app.render();
    assert.equal(ui('road-limit-sign').textContent, String(previous));
    driver.advance(0.02);
    assert.ok(app.car.y > boundary);
    assert.equal(ui('road-limit-sign').textContent, String(next));
    assert.equal(ui('road-limit-sign').getAttribute('aria-label'), `道路限速${next}公里每小时`);
    assert.match(ui('road-speed-status').textContent, /^自动制动至 /);
    assert.equal(document.querySelector('.road-awareness').classList.contains('overspeed'), true);
    assert.equal(app.readState().roadLimitKmh, next);
    assert.equal(app.state.speedLimit, 100, 'the requested target stays visible');
    assert.equal(app.state.lastInput.targetSpeed, next / 3.6);
    assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
    assert.ok(app.car.speed < 40 && app.car.speed > 39.5, 'brakes must decelerate, not teleport velocity');
    assert.ok(app.state.lastInput.brake > 0 && app.car.brakeForce > 0);
    assert.equal(app.state.estop, false);
    driver.advance(20);
    assert.ok(app.car.speed <= next / 3.6 + 0.001 && app.car.speed > next / 3.6 - 0.02);
    assert.equal(app.state.autoLimitBraking, false);
    assert.equal(app.state.lastInput.throttle, 1);
    assertNoAutomaticBrake(app);
  }
});

test('a lower speed zone brakes a legal cruise and does not stop or latch a lock', () => {
  for (const wet of [false, true]) {
    const driver = loadApp(), { app } = driver;
    app.state.wet = wet;
    app.world.vehicles = [];
    let cursor = 0, next;
    for (let attempts = 0; attempts < 20; attempts++) {
      next = app.traffic.nextLimit(cursor, 1);
      if (next.limitKmh < app.traffic.limitAt(next.y - 0.1)) break;
      cursor = next.y + 0.1;
    }
    const previousLimit = app.traffic.limitAt(next.y - 0.1), lowerSpeed = next.limitKmh / 3.6;
    assert.ok(next.limitKmh < previousLimit, 'the generated route must offer a real lower-speed transition');
    Object.assign(app.car, { x: 0, y: next.y - 0.1, speed: previousLimit / 3.6 });
    driver.advance(0.1);
    assert.ok(app.car.speed > lowerSpeed);
    assert.ok(app.state.lastInput.brake > 0);
    const firstSpeed = app.car.speed;
    driver.advance(15);
    assert.ok(app.car.speed < firstSpeed && app.car.speed <= lowerSpeed);
    assert.ok(app.car.speed > lowerSpeed - 5, 'automatic limit braking must not continue to zero');
    assert.equal(app.car.lastBrakeDistance, null, 'slowing to a limit is not a completed stop');
    assertNoAutomaticBrake(app);
  }
});

test('actual traffic advances in both directions and reset rebuilds the initial scene', () => {
  const driver = loadApp(), { app, ui } = driver;
  const initialWorld = app.world;
  const initialVehicles = JSON.stringify(initialWorld.vehicles);
  const own = app.world.vehicles.find(v => v.lane === 0 && v.y > 0 && v.y < 200);
  const opposing = app.world.vehicles.find(v => v.lane === 3 && v.y > 0 && v.y < 200);
  assert.ok(own && opposing);
  const ownY = own.y, opposingY = opposing.y;
  driver.key('keydown', 'ArrowUp');
  driver.advance(2);
  assert.ok(own.y > ownY + 40);
  assert.ok(opposing.y < opposingY - 40);
  assert.ok(app.car.distance > 5);
  assert.ok(app.world.elapsedTime > 1.99);
  assert.equal(app.readState().trafficCount, 78);

  ui('reset-session').onclick();
  assert.notEqual(app.world, initialWorld);
  assert.equal(JSON.stringify(app.world.vehicles), initialVehicles);
  assert.equal(app.world.elapsedTime, 0);
  assert.equal(app.world.contacts, 0);
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.distance, 0);
  assert.equal(app.state.controls.size, 0);
  assert.equal(app.state.plan, null);
  assert.equal(ui('road-limit-sign').textContent, '120');
  assert.equal(app.readState().trafficCount, 78);
});

test('real traffic contact loses speed once, clears held throttle and freezes all traffic', () => {
  const driver = loadApp(), { app } = driver;
  const leader = app.world.vehicles.find(v => v.lane === 1 && v.y > 0);
  Object.assign(app.car, { x: 0, y: leader.y - 5, speed: 33 });
  driver.setTarget(100);
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.5);
  assert.equal(app.world.contacts, 1);
  assert.ok(app.car.speed > 0 && app.car.speed < 33);
  assert.equal(app.state.collision.kind, 'vehicle');
  assert.equal(app.state.controls.size, 0);
  assert.equal(app.state.lastInput.throttle, 0);
  assert.equal(app.state.estop, false);
  assert.ok(!driver.ui('collision-dialog').open);
  const atImpact = JSON.stringify({ car: app.car, world: app.world });
  driver.advance(60);
  assert.equal(driver.ui('collision-dialog').open, true);
  assert.equal(JSON.stringify({ car: app.car, world: app.world }), atImpact);
  assert.equal(app.world.contacts, 1, 'a held overlap cannot record repeated crashes while paused');
});

function causeVehicleCollision(driver, { reverse = false, local = false, seconds = 6,
  speed = reverse ? 5 : 25, offsetX = 0 } = {}) {
  const { app } = driver, y = local ? app.car.y : 900, x = local ? 29 : 0;
  Object.assign(app.car, { x, y, heading: 0, steer: 0, speed,
    gear: reverse ? 'reverse' : 'forward' });
  app.state.requestedGear = app.car.gear;
  app.state.laneTarget = 1;
  const lead = adviceVehicle(local ? 0 : 1, y + (reverse ? -5 : 5), 0, 999);
  lead.x = x + offsetX;
  app.world.vehicles = [lead];
  driver.advance(seconds);
  assert.equal(app.state.collision?.kind, 'vehicle', 'the fixture must produce a real traffic collision');
  return app.state.collision;
}

test('reverse contact also pauses the simulation and restart restores a stopped forward vehicle', () => {
  const driver = loadApp(), { app, ui } = driver;
  causeVehicleCollision(driver, { reverse: true });
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.readState().collision.kind, 'vehicle');
  ui('collision-restart').onclick();
  assert.equal(app.state.collision, null);
  assert.equal(app.readState().collision, null);
  assert.equal(ui('collision-dialog').open, false);
  assert.equal(app.car.gear, 'forward');
  assert.equal(app.state.requestedGear, 'forward');
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.distance, 0);
  assert.equal(app.world.contacts, 0);
  driver.advance(5);
  assert.equal(app.car.speed, 0, 'restart must wait for a fresh driving action');
  assert.equal(app.car.y, 0);
});

test('collision cancels manual input, a compound AI task and automatic driving in every control mode', () => {
  for (const mode of ['manual', 'ai', 'auto']) {
    const driver = loadApp(), { app, ui } = driver;
    app.world.vehicles = [];
    if (mode === 'manual') driver.key('keydown', 'KeyW');
    if (mode === 'ai') {
      ui('ai-tab').onclick();
      app.submitCommand('直行500米后向左变道并制动');
      app.startPlan();
      assert.equal(app.state.plan.status, 'running');
    }
    if (mode === 'auto') startAutomatic(driver);
    causeVehicleCollision(driver);
    assert.equal(app.state.mode, mode);
    assert.equal(app.state.controls.size, 0, mode);
    assert.equal(app.state.autodrive.active, false, mode);
    assert.equal(app.state.exitCruise, false, mode);
    assert.notEqual(app.state.plan?.status, 'running', mode);
    assert.equal(app.state.lastInput.throttle, 0, mode);
    ui('collision-restart').onclick();
    assert.equal(app.state.mode, mode, 'restart keeps the selected control panel');
    driver.advance(3);
    assert.equal(app.car.speed, 0, mode + ' must not resume the previous driving owner');
    assert.equal(app.state.autodrive.active, false);
    assert.equal(app.state.plan, null);
  }
});

test('paused collisions reject touch, keyboard, horn, route, density and WebMCP driving commands', () => {
  const driver = loadApp(), { app, ui, document, modelTools } = driver;
  const collision = causeVehicleCollision(driver);
  const frozen = JSON.stringify({ car: app.car, world: app.world });
  const hornCount = app.state.horn.count, lane = app.state.laneTarget, density = app.state.trafficDensity;
  driver.key('keydown', 'KeyW');
  driver.key('keydown', 'ArrowLeft');
  document.querySelectorAll('[data-drive]').find(button => button.dataset.drive === 'throttle')
    .onpointerdown({ button: 0, pointerId: 33, preventDefault() {} });
  ui('horn-button').onclick();
  ui('gear-reverse').onclick();
  ui('auto-start').onclick();
  ui('lane-right').onclick();
  app.requestExit();
  document.querySelectorAll('[data-density]').find(button => button.dataset.density === 'dense').onclick();
  assert.equal(app.submitCommand('前进20米').status, 'blocked');
  app.startPlan();
  assert.equal(modelTools.get('stage_rover_simulation_command').execute({ command: '直行50米后停车' }).status, 'blocked');
  assert.equal(modelTools.get('change_rover_simulation_lane').execute({ direction: 'left' }).accepted, false);
  modelTools.get('emergency_stop_rover_simulation').execute({});
  driver.advance(20);
  assert.equal(app.state.collision, collision, 'blocked actions cannot replace the first collision');
  assert.equal(JSON.stringify({ car: app.car, world: app.world }), frozen);
  assert.equal(app.state.controls.size, 0);
  assert.equal(app.state.autodrive.active, false);
  assert.notEqual(app.state.plan?.status, 'ready');
  assert.equal(app.state.horn.count, hornCount);
  assert.equal(app.state.laneTarget, lane);
  assert.equal(app.state.trafficDensity, density);
  assert.equal(app.state.requestedGear, 'forward');
  assert.equal(ui('collision-dialog').open, true);
});

test('the collision dialog cannot be dismissed by Escape or clicking outside its content', () => {
  const driver = loadApp(), { ui } = driver;
  causeVehicleCollision(driver);
  const dialog = ui('collision-dialog');
  let prevented = false;
  dialog.oncancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'native Escape cancellation must be prevented');
  dialog.getBoundingClientRect = () => ({ left: 10, right: 200, top: 10, bottom: 200 });
  dialog.onclick?.({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, true);
});

test('collision restart preserves driving preferences while clearing locks, inputs, timers and impact data', () => {
  for (const connected of [true, false]) {
    const driver = loadApp(), { app, ui, document } = driver;
    ui('wet-road').onclick();
    driver.setTarget(19);
    document.querySelectorAll('[data-density]').find(button => button.dataset.density === 'low').onclick();
    ui('ai-tab').onclick();
    // An existing brake lock can still end in a collision before its physical
    // braking distance is exhausted. Restart begins a new run, unlike reset.
    ui('emergency-stop').onclick();
    app.state.connected = connected;
    causeVehicleCollision(driver);
    assert.equal(app.state.estop, true);
    assert.equal(app.state.wet, true);
    ui('collision-restart').onclick();
    assert.equal(app.state.connected, connected);
    assert.equal(app.state.mode, 'ai');
    assert.equal(app.state.speedLimit, 19);
    assert.equal(app.state.trafficDensity, 'low');
    assert.equal(app.state.wet, true);
    assert.equal(app.world.vehicles.length, 42);
    assert.equal(app.state.estop, false);
    assert.equal(app.state.serviceBrake, 0);
    assert.equal(app.state.failsafe, false);
    assert.equal(app.state.lastInput.throttle, 0);
    assert.equal(app.state.lastInput.brake, 0);
    assert.equal(app.state.lastInput.steering, 0);
    assert.equal(app.state.brakeAnchor, null);
    assert.equal(app.state.contactUntil, 0);
    assert.equal(app.car.elapsedTime, 0);
    assert.equal(app.world.elapsedTime, 0);
    assert.equal(app.world.contacts, 0);
    assert.equal(app.car.wallContactCount, 0);
    assert.equal(app.state.laneTarget, 1);
    assert.equal(app.state.shiftPending, false);
    assert.equal(app.state.shoulderAlert, false);
    assert.equal(app.state.shoulderRecovery, false);
    assert.equal(app.state.horn.count, 0);
    assert.equal(app.state.horn.status, 'idle');
    driver.advance(1);
    assert.equal(app.car.speed, 0);
  }
});

test('collision during ordinary-road cruise clears its route on restart and waits for fresh input', () => {
  const driver = localRoadAutodrive(), { app, ui } = driver;
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.exitCruise, false);
  causeVehicleCollision(driver, { local: true });
  assert.equal(app.state.exitCruise, false);
  ui('collision-restart').onclick();
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.readState().roadType, 'highway');
  assert.equal(app.state.horn.count, 0);
  driver.key('keydown', 'KeyW', true);
  driver.advance(1);
  assert.equal(app.car.speed, 0, 'a key still held from the old run is not a new driving action');
  driver.key('keyup', 'KeyW');
  driver.key('keydown', 'KeyW');
  driver.advance(1);
  assert.ok(app.car.speed > 0);
  assert.ok(app.car.y > 0);
  assert.equal(app.state.collision, null);
});

test('a 100 m/s AI request transparently tests at the road limit and records a real stop', () => {
  const driver = loadApp(), { app, ui } = driver;
  ui('ai-tab').onclick();
  ui('command-input').value = '加速到 100 米每秒然后刹车';
  ui('command-form').onsubmit({ preventDefault() {} });
  assert.equal(app.state.plan.status, 'ready');
  assert.match(app.state.plan.labels[0], /120 km\/h.*路段限速调整/);
  ui('task-action').onclick();
  driver.advance(30);
  assert.equal(app.state.plan.status, 'completed');
  assert.ok(app.state.plan.brakeStartSpeed <= 120 / 3.6);
  assert.ok(app.state.plan.brakeStartSpeed > 33.3);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.lastBrakeDistance > 60 && app.car.lastBrakeDistance < 70);
  assert.match(ui('task-badge').textContent, /已完成/);
  assert.equal(app.state.estop, false);
});

test('density buttons rebuild distinct traffic levels without resetting the car or controls', () => {
  const driver = loadApp(), { app, ui, document } = driver;
  Object.assign(app.car, { y: 85, speed: 20, distance: 85 });
  driver.key('keydown', 'ArrowUp');
  for (const [density, label, count] of [['low', '较少', 42], ['dense', '拥挤', 174], ['medium', '中等', 78]]) {
    document.querySelectorAll('[data-density]').find(button => button.dataset.density === density).onclick();
    assert.equal(app.readState().trafficDensity, density);
    assert.equal(app.world.vehicles.length, count);
    assert.equal(app.car.y, 85);
    assert.equal(app.car.speed, 20);
    assert.equal(app.car.distance, 85);
    assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
    assert.match(ui('traffic-density-note').textContent, new RegExp(label + '.*' + count));
  }
  document.querySelectorAll('[data-density]').find(button => button.dataset.density === 'dense').onclick();
  ui('reset-session').onclick();
  assert.equal(app.world.vehicles.length, 174);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.y, 0);
});

test('reverse gear drives backwards with a rear view, bounded speed and positive braking distance', () => {
  const driver = loadApp(), { app, ui } = driver;
  ui('gear-reverse').onclick();
  driver.advance(0.02);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(ui('speed-slider').max, '5');
  assert.match(ui('view-title').textContent, /倒车视角/);
  assert.equal(ui('traffic-direction-label').textContent, '同车道后车');
  driver.key('keydown', 'KeyW');
  driver.advance(3);
  assert.ok(app.car.y < -10);
  const nextLimit = app.traffic.nextLimit(app.car.y, -1);
  assert.equal(ui('next-road-limit').textContent, `倒车方向 ${Math.ceil(nextLimit.distance)} m · 限速 ${nextLimit.limitKmh}`);
  assert.ok(app.car.speed > 4.9 && app.car.speed <= 5);
  assert.equal(app.car.heading, 0);
  assert.ok(app.car.distance > 10);
  assert.ok(app.readState().signedSpeed < 0);
  driver.key('keyup', 'KeyW');
  ui('normal-stop').onclick();
  const brakeStartY = app.car.y;
  driver.advance(0.1);
  assert.ok(app.car.speed > 0);
  assert.ok(app.car.y < brakeStartY);
  assert.equal(app.state.brakeAnchor.heading, 180);
  driver.advance(2);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.lastBrakeDistance > 2);
});

test('requesting the opposite gear while moving brakes to rest before changing direction', () => {
  const driver = loadApp(), { app, ui } = driver;
  Object.assign(app.car, { x: 0, speed: 20 });
  driver.key('keydown', 'KeyW');
  ui('gear-reverse').onclick();
  assert.equal(app.state.controls.size, 0);
  driver.advance(0.1);
  assert.equal(app.car.gear, 'forward');
  assert.ok(app.car.y > 1 && app.car.speed > 19);
  assert.equal(app.state.shiftPending, true);
  assert.match(ui('gear-status').textContent, /换挡/);
  driver.advance(6);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.lastBrakeDistance > 40);
  assert.equal(app.car.heading, 0);
  const stoppedY = app.car.y;
  driver.key('keyup', 'KeyW');
  driver.key('keydown', 'KeyW');
  driver.advance(1);
  assert.ok(app.car.y < stoppedY && app.car.speed > 0);
});

test('AI reverse task excludes gear-change stopping distance and finishes with a real rearward stop', () => {
  const driver = loadApp(), { app, ui } = driver;
  Object.assign(app.car, { x: 0, speed: 12 });
  ui('ai-tab').onclick();
  ui('command-input').value = '倒车 10 米';
  ui('command-form').onsubmit({ preventDefault() {} });
  assert.equal(app.state.plan.gear, 'reverse');
  ui('task-action').onclick();
  driver.advance(0.5);
  assert.equal(app.car.gear, 'forward');
  assert.equal(app.state.plan.phase, 0);
  assert.equal(app.state.plan.motionStarted, false);
  assert.equal(ui('task-progress-fill').style.width, '0%');
  driver.advance(15);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.state.plan.status, 'completed');
  assert.ok(app.state.plan.startDistance > 10, 'initial forward braking must not count as reverse travel');
  const reverseTravel = app.car.distance - app.state.plan.startDistance;
  assert.ok(reverseTravel > 10 && reverseTravel < 13);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.car.heading, 0);
});

function advanceUntil(driver, predicate, timeout = 20, increment = 0.05) {
  for (let elapsed = 0; elapsed < timeout && !predicate(); elapsed += increment) driver.advance(increment);
  assert.ok(predicate(), `simulation must reach the requested state within ${timeout} seconds`);
}

function headingError(car) {
  return Math.abs((car.heading + 180) % 360 - 180);
}

function enterEmergencyShoulder(driver) {
  const { app, ui } = driver;
  app.world.vehicles = [];
  // Keep shoulder/recovery scenarios within a long dashed-line window;
  // solid-line permissions have their own integration tests below. Stay past
  // the exit split so a right change still means the emergency shoulder.
  app.car.y = 1500;
  driver.setTarget(20);
  driver.key('keydown', 'KeyW');
  ui('lane-right').onclick();
  advanceUntil(driver, () => !app.state.laneChanging);
  assert.equal(app.state.laneTarget, 2);
  assert.ok(Math.abs(app.car.x - 3.75) <= 0.08);
  ui('lane-right').onclick();
  assert.equal(app.state.laneTarget, 3);
  assert.equal(app.state.estop, false, 'selecting the shoulder must not brake before entering it');
  advanceUntil(driver, () => app.state.estop);
}

test('a single lane button click completes and holds one adjacent lane without held steering', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  driver.setTarget(20);
  driver.key('keydown', 'KeyW');
  driver.advance(2);
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 0);
  assert.equal(app.state.laneChanging, true);
  assert.equal(app.state.controls.size, 1, 'a lane request must not become a held drive control');
  assert.equal(app.state.controls.get('kKeyW'), 'throttle');
  advanceUntil(driver, () => !app.state.laneChanging);
  assert.ok(Math.abs(app.car.x + 3.75) <= 0.08);
  assert.ok(headingError(app.car) <= 0.6);
  const centeredY = app.car.y;
  driver.advance(5);
  assert.ok(app.car.y > centeredY + 90);
  assert.ok(Math.abs(app.car.x + 3.75) < 0.02, 'the car must stay centered after finishing the change');
  assert.ok(headingError(app.car) < 0.1);
  assertNoAutomaticBrake(app);
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 0, 'the left boundary must reject another lane change');
  assert.match(ui('toast').textContent, /最左侧/);
});

test('lane keyboard repeats do not queue lanes and key release does not cancel a change', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  app.car.y = 900;
  driver.key('keydown', 'KeyW');
  driver.advance(2);
  driver.key('keydown', 'ArrowRight');
  driver.key('keydown', 'ArrowRight', true);
  assert.equal(app.state.laneTarget, 2);
  assert.equal(app.state.controls.has('kArrowRight'), false);
  driver.key('keyup', 'ArrowRight');
  driver.advance(0.2);
  assert.equal(app.state.laneChanging, true);
  const target = app.state.laneTarget;
  ui('lane-left').onclick();
  ui('lane-right').onclick();
  driver.key('keydown', 'KeyD');
  assert.equal(app.state.laneTarget, target, 'new requests are rejected until the current lane center is reached');
  assert.match(ui('toast').textContent, /到达车道中央/);
  advanceUntil(driver, () => !app.state.laneChanging);
  driver.key('keydown', 'ArrowRight', true);
  driver.key('keydown', 'KeyD', true);
  assert.equal(app.state.laneTarget, 2, 'holding a key through completion must not enter the shoulder');
  assert.equal(app.state.estop, false);

  const button = ui('lane-left');
  const event = { key: 'Enter', repeat: false, prevented: false, preventDefault() { this.prevented = true; } };
  button.onkeydown(event);
  assert.equal(event.prevented, true, 'prevent the native keyboard click from duplicating the request');
  assert.equal(app.state.laneTarget, 1);
  advanceUntil(driver, () => !app.state.laneChanging);
  button.onkeydown({ ...event, repeat: true });
  assert.equal(app.state.laneTarget, 1, 'button keyboard repeats must not choose another lane');
});

test('selecting a lane while parked queues physical motion and the opposite button can cancel it', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  ui('lane-right').onclick();
  assert.equal(app.state.laneTarget, 2);
  driver.advance(3);
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.distance, 0);
  assert.match(ui('lane-status').textContent, /待起步/);
  ui('lane-right').onclick();
  assert.equal(app.state.laneTarget, 2, 'a stationary pending change must not queue the shoulder');
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 1);
  driver.advance(1);
  assert.equal(app.state.laneChanging, false);
  ui('lane-right').onclick();
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => !app.state.laneChanging);
  assert.ok(Math.abs(app.car.x - 3.75) <= 0.08);
  assert.ok(app.car.distance > 5 && app.car.y > 5);
});

test('the second right change enters the shoulder, visibly warns and physically emergency brakes', () => {
  const driver = loadApp(), { app, ui } = driver;
  enterEmergencyShoulder(driver);
  assert.ok(app.car.x > 5.625);
  assert.ok(app.car.speed > 15, 'entry must not teleport a moving car to rest');
  assert.equal(app.state.shoulderAlert, true);
  assert.equal(app.state.controls.size, 0, 'emergency braking must discard the held throttle');
  assert.equal(app.state.serviceBrake, 1);
  assert.equal(ui('shoulder-alert').hidden, false);
  assert.match(ui('shoulder-alert-title').textContent, /应急车道.*紧急制动/);
  assert.equal(ui('reset-estop').disabled, true);
  const entrySpeed = app.car.speed, entryDistance = app.car.distance;
  ui('reset-estop').onclick();
  assert.equal(app.state.estop, true, 'brake lock cannot release before the car stops');
  driver.advance(0.1);
  assert.ok(app.car.speed < entrySpeed && app.car.speed > entrySpeed - 2);
  assert.equal(app.state.lastInput.brake, 1);
  assert.equal(app.state.lastInput.throttle, 0);
  assert.ok(app.car.brakeDistance > 0);
  advanceUntil(driver, () => app.car.speed === 0);
  assert.ok(app.car.distance > entryDistance + 10);
  assert.ok(app.car.lastBrakeDistance > 10);
  assert.equal(app.state.estop, true);
  assert.equal(ui('reset-estop').disabled, false);
  assert.match(ui('shoulder-alert-title').textContent, /已停稳/);
  assert.equal(ui('shoulder-alert').hidden, false, 'the warning remains visible while stopped on the shoulder');
});

test('shoulder release waits for new throttle, returns to the right lane and rearms the next emergency stop', () => {
  const driver = loadApp(), { app, ui } = driver;
  enterEmergencyShoulder(driver);
  advanceUntil(driver, () => app.car.speed === 0);
  const stopped = { x: app.car.x, y: app.car.y, distance: app.car.distance };
  ui('reset-estop').onclick();
  assert.equal(app.state.estop, false);
  assert.equal(app.state.shoulderRecovery, true);
  assert.equal(app.state.laneTarget, 2);
  assert.equal(app.state.controls.size, 0);
  driver.advance(1);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.x, stopped.x);
  assert.equal(app.car.y, stopped.y);
  assert.equal(app.car.distance, stopped.distance);
  ui('lane-right').onclick();
  assert.equal(app.state.laneTarget, 2, 'recovery must finish before another change is accepted');
  driver.key('keyup', 'KeyW');
  driver.key('keydown', 'KeyW');
  driver.advance(0.1);
  assert.ok(app.car.speed > 0);
  assert.equal(app.state.estop, false, 'remaining inside the shoulder must not immediately relock the brakes');
  assert.match(ui('camera-status').textContent, /正在返回右车道/);
  assert.match(ui('shoulder-alert-title').textContent, /正在返回右车道/);
  assert.doesNotMatch(ui('safety-description').textContent, /已制动/);
  advanceUntil(driver, () => !app.state.shoulderRecovery);
  assert.equal(app.state.shoulderAlert, false);
  assert.equal(ui('shoulder-alert').hidden, true);
  assert.ok(Math.abs(app.car.x - 3.75) <= 0.08);
  assert.equal(app.state.laneChanging, false);
  ui('lane-right').onclick();
  advanceUntil(driver, () => app.state.estop);
  assert.ok(app.car.x > 5.625 && app.car.speed > 0);
  assert.equal(app.state.shoulderAlert, true);
  assert.equal(app.state.controls.size, 0);
  driver.advance(0.02);
  assert.equal(app.state.lastInput.brake, 1);
});

test('reverse gear uses the same road-relative lane buttons and stays centered after changing', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  ui('gear-reverse').onclick();
  driver.advance(0.02);
  ui('lane-left').onclick();
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => !app.state.laneChanging);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.state.laneTarget, 0);
  assert.ok(app.car.x < 0 && Math.abs(app.car.x + 3.75) <= 0.08);
  assert.ok(app.car.y < -5 && app.car.distance > 5);
  assert.ok(app.car.speed > 4.9 && app.car.speed <= 5);
  assert.ok(headingError(app.car) <= 0.6);
  assert.match(ui('view-title').textContent, /倒车视角/);
  const centeredY = app.car.y;
  driver.advance(5);
  assert.ok(app.car.y < centeredY - 24);
  assert.ok(Math.abs(app.car.x + 3.75) < 0.02);
  assert.ok(headingError(app.car) < 0.1);
  assertNoAutomaticBrake(app);
});

test('reset clears shoulder and pending-lane state while retaining an existing emergency lock', () => {
  const driver = loadApp(), { app, ui } = driver;
  enterEmergencyShoulder(driver);
  ui('reset-session').onclick();
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.steer, 0);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.shoulderAlert, false);
  assert.equal(app.state.shoulderRecovery, false);
  assert.equal(app.state.controls.size, 0);
  assert.equal(app.state.estop, true);
  assert.equal(ui('shoulder-alert').hidden, true);
  assert.match(ui('lane-status').textContent, /中间车道.*已居中/);
  ui('reset-estop').onclick();
  assert.equal(app.state.estop, false);
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 0);
  ui('reset-session').onclick();
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.estop, false);
});


test('cancelling a lane change after stopping partway still requires a physical return to center', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  app.car.speed = 5;
  ui('lane-right').onclick();
  driver.advance(0.6);
  ui('normal-stop').onclick();
  advanceUntil(driver, () => app.car.speed === 0);
  assert.ok(app.car.x > 0.5 && app.car.x < 1.5);
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, true);
  assert.match(ui('lane-status').textContent, /待起步/);
  assert.doesNotMatch(ui('lane-status').textContent, /已居中/);
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => !app.state.laneChanging);
  assert.ok(Math.abs(app.car.x) <= 0.08 && headingError(app.car) <= 0.6);
});

function adviceVehicle(lane, y, speed, id) {
  return { id, lane, x: [-3.75, 0, 3.75][lane], y, previousY: y, direction: 1,
    heading: 0, speed, cruiseFactor: speed / (120 / 3.6), length: 4.5, width: 1.85,
    height: 1.5, kind: 'car', color: '#657778', braking: false };
}

// A slower leader makes a change useful; a car alongside blocks the other
// adjacent lane. These are actual traffic objects, not a mocked advice result.
function setAdviceTraffic(driver, direction = 'left', lane = 1) {
  const { app } = driver;
  Object.assign(app.car, { x: [-3.75, 0, 3.75][lane], heading: 0, steer: 0, speed: 25, gear: 'forward' });
  app.state.laneTarget = lane;
  app.world.vehicles = [adviceVehicle(lane, app.car.y + 90, 15, 901)];
  const blocked = lane + (direction === 'left' ? 1 : -1);
  if (blocked >= 0 && blocked <= 2) app.world.vehicles.push(adviceVehicle(blocked, app.car.y, 25, 902));
  app.render();
}

test('live lane advice reads traffic and renders gaps without operating the vehicle', () => {
  const driver = loadApp(), { app, ui } = driver;
  setAdviceTraffic(driver);
  const before = JSON.stringify({ car: app.car, input: app.state.lastInput, vehicles: app.world.vehicles });
  for (let i = 0; i < 5; i++) {
    app.render();
    const advice = app.readState().laneRecommendation;
    assert.equal(advice.status, 'recommend');
    assert.equal(advice.direction, 'left');
    assert.equal(advice.targetLane, 0);
  }
  assert.equal(JSON.stringify({ car: app.car, input: app.state.lastInput, vehicles: app.world.vehicles }), before);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.controls.size, 0);
  assert.equal(ui('lane-advice').dataset.status, 'recommend');
  assert.match(ui('lane-advice-title').textContent, /推荐向左/);
  assert.equal(ui('lane-advice-accept').disabled, false);
  assert.equal(ui('lane-advice-live').textContent, ui('lane-advice-title').textContent);
  assert.equal(ui('advice-lane-0').classList.contains('recommended'), true);
  assert.equal(ui('advice-lane-1').classList.contains('current'), true);
  assert.equal(ui('advice-lane-2').classList.contains('blocked'), true);
  for (let lane = 0; lane < 3; lane++) {
    assert.match(ui('advice-gap-' + lane).textContent, /前 .+ · 后 .+/);
    assert.doesNotMatch(ui('advice-gap-' + lane).textContent, /NaN|Infinity/);
    assert.ok(ui('advice-status-' + lane).textContent);
  }
  driver.advance(0.2);
  assert.equal(app.car.x, 0);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.lastInput.throttle, 0);
  assert.equal(app.state.lastInput.brake, 0);
});

test('accepting either recommendation starts one physical adjacent change and requires a new decision afterward', () => {
  for (const [direction, target, x] of [['left', 0, -3.75], ['right', 2, 3.75]]) {
    const driver = loadApp(), { app, ui } = driver;
    setAdviceTraffic(driver, direction);
    ui('ai-tab').onclick();
    assert.equal(app.readState().laneRecommendation.direction, direction);
    assert.equal(ui('lane-advice-accept').onclick(), true);
    assert.equal(app.state.mode, 'manual');
    assert.equal(app.state.laneTarget, target);
    assert.equal(app.state.laneChanging, true);
    assert.equal(app.car.x, 0, 'acceptance queues real steering instead of moving the car instantly');
    assert.equal(app.car.speed, 25);
    assert.equal(app.state.controls.size, 0, 'accepting advice must not apply the throttle');
    assert.equal(ui('lane-advice-accept').disabled, true);
    assert.equal(ui('lane-advice-accept').onclick(), false);
    assert.equal(app.state.laneTarget, target, 'a repeated click must not queue another lane');
    app.world.vehicles = [];
    advanceUntil(driver, () => !app.state.laneChanging);
    assert.ok(Math.abs(app.car.x - x) <= 0.08);
    assert.ok(headingError(app.car) <= 0.6);
    assert.equal(app.state.estop, false);
    assert.ok(app.state.adviceCooldownUntil > app.car.elapsedTime + 4.9);
    assert.equal(app.state.lastInput.throttle, 0);
  }
});

test('Enter and Space accept focused lane advice without braking or repeating after completion', () => {
  for (const [code, direction, target] of [['Enter', 'left', 0], ['Space', 'right', 2]]) {
    const driver = loadApp(), { app, ui } = driver;
    app.car.y = 900;
    setAdviceTraffic(driver, direction);
    const button = ui('lane-advice-accept');
    const event = driver.key('keydown', code, false, button);
    assert.equal(event.defaultPrevented, true, 'the focused button must suppress native duplicate clicks and global shortcuts');
    assert.equal(app.state.laneTarget, target);
    assert.equal(app.state.laneChanging, true);
    assert.equal(app.car.x, 0);
    assertNoAutomaticBrake(app);
    driver.key('keydown', code, true, button);
    assert.equal(app.state.laneTarget, target);
    assertNoAutomaticBrake(app);
    app.world.vehicles = [];
    advanceUntil(driver, () => !app.state.laneChanging);
    driver.advance(5.1);
    // A newly available opposite recommendation must still require a fresh
    // press even if the original key remains held through the entire change.
    setAdviceTraffic(driver, direction === 'left' ? 'right' : 'left', target);
    assert.equal(app.state.laneAdvice.status, 'recommend');
    assert.equal(app.state.laneAdvice.targetLane, 1);
    assert.equal(button.disabled, false);
    const repeated = driver.key('keydown', code, true, button);
    assert.equal(repeated.defaultPrevented, true);
    assert.equal(app.state.laneTarget, target);
    assert.equal(app.state.laneChanging, false);
    assertNoAutomaticBrake(app);
    driver.key('keyup', code, false, button);
    driver.key('keydown', code, false, button);
    assert.equal(app.state.laneTarget, 1);
    assert.equal(app.state.laneChanging, true);
    assertNoAutomaticBrake(app);
  }
});

test('traffic changing between the shown suggestion and its click cannot silently choose another lane', () => {
  const driver = loadApp(), { app, ui } = driver;
  setAdviceTraffic(driver, 'left');
  assert.equal(app.state.laneAdvice.targetLane, 0);
  // The last rendered direction stays left, but a new car now blocks it and
  // the right lane clears before the next frame renders.
  app.world.vehicles = [adviceVehicle(1, 90, 15, 911), adviceVehicle(0, 0, 25, 912)];
  assert.equal(app.readState().laneRecommendation.targetLane, 2);
  assert.equal(app.state.laneAdvice.targetLane, 0);
  assert.equal(ui('lane-advice-accept').onclick(), false);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.car.x, 0);
  assert.equal(app.state.laneAdvice.targetLane, 2);
  assert.match(ui('lane-advice-title').textContent, /推荐向右/);
  assert.match(ui('toast').textContent, /路况已变化/);
  assert.equal(ui('lane-advice-accept').onclick(), true, 'a separate click may accept the refreshed right recommendation');
  assert.equal(app.state.laneTarget, 2);
});

test('a newly dangerous departure rejects stale advice even when the recommended lane stays clear', () => {
  const driver = loadApp(), { app, ui } = driver;
  setAdviceTraffic(driver, 'left');
  assert.equal(app.state.laneAdvice.targetLane, 0);
  const leader = app.world.vehicles.find(vehicle => vehicle.lane === 1);
  leader.y = leader.previousY = app.car.y + 8;
  const fresh = app.readState().laneRecommendation;
  assert.equal(fresh.lanes[0].safe, true, 'the target corridor remains clear');
  assert.equal(fresh.status, 'blocked', 'the car must have room to leave its original lane first');
  assert.match(fresh.reason, /当前前车过近/);
  assert.equal(app.state.laneAdvice.status, 'recommend', 'the old UI suggestion has not refreshed yet');
  assert.equal(ui('lane-advice-accept').onclick(), false);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.car.x, 0);
  assert.equal(app.state.laneAdvice.status, 'blocked');
  assert.equal(ui('lane-advice-accept').disabled, true);
  assertNoAutomaticBrake(app);
});

test('maneuvers, brakes and unavailable controls invalidate displayed advice before accepting it', () => {
  const gates = [
    ['active lane change', ({ app }) => { app.state.laneChanging = true; app.state.laneTarget = 0; }],
    ['emergency shoulder', ({ app }) => { app.state.shoulderAlert = true; }],
    ['shoulder recovery', ({ app }) => { app.state.shoulderRecovery = true; }],
    ['emergency lock', ({ app }) => { app.state.estop = true; }],
    ['failsafe', ({ app }) => { app.state.failsafe = true; }],
    ['disconnected', ({ app }) => { app.state.connected = false; }],
    ['reverse gear', ({ app }) => { app.car.gear = app.state.requestedGear = 'reverse'; }],
    ['reverse requested', ({ app }) => { app.state.requestedGear = 'reverse'; }],
    ['gear change pending', ({ app }) => { app.state.shiftPending = true; }],
    ['held brake', ({ app }) => { app.state.controls.set('kArrowDown', 'brake'); }],
    ['service brake', ({ app }) => { app.state.serviceBrake = 0.55; }],
    ['automatic limit brake', ({ app }) => { app.state.autoLimitBraking = true; }],
    ['last physical brake input', ({ app }) => { app.state.lastInput.brake = 1; }],
    ['guardrail contact', ({ app }) => { app.car.wallContact = 'left'; }],
    ['traffic contact', ({ app }) => { app.state.contactUntil = 1000; }],
    ['off center', ({ app }) => { app.car.x = 1.1; }],
    ['cooldown', ({ app }) => { app.state.adviceCooldownUntil = app.car.elapsedTime + 5; }]
  ];
  for (const [name, apply] of gates) {
    const driver = loadApp(), { app, ui } = driver;
    setAdviceTraffic(driver);
    assert.equal(app.state.laneAdvice.status, 'recommend', name);
    apply(driver);
    const target = app.state.laneTarget, changing = app.state.laneChanging;
    assert.equal(app.readState().laneRecommendation.status, 'unavailable', name);
    assert.equal(ui('lane-advice-accept').onclick(), false, name);
    assert.equal(app.state.laneTarget, target, name);
    assert.equal(app.state.laneChanging, changing, name);
    assert.equal(ui('lane-advice-accept').disabled, true, name);
    assert.equal(ui('lane-advice').dataset.status, 'unavailable', name);
    assert.equal(app.state.laneAdvice.targetLane, null, name);
  }
  const driver = loadApp();
  setAdviceTraffic(driver);
  driver.dispatch('rover-camera-lost');
  assert.equal(driver.app.readState().laneRecommendation.status, 'unavailable');
  assert.equal(driver.ui('lane-advice-accept').disabled, true);
  assert.equal(driver.ui('lane-advice-accept').onclick(), false);
  assert.equal(driver.app.state.laneTarget, 1);
});

test('finishing a real lane change waits five simulation seconds before recommending another', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  app.car.y = 900;
  app.car.speed = 25;
  driver.setTarget(25);
  driver.key('keydown', 'KeyW');
  ui('lane-right').onclick();
  advanceUntil(driver, () => !app.state.laneChanging);
  const cooldown = app.state.adviceCooldownUntil;
  assert.ok(cooldown > app.car.elapsedTime + 4.9);
  setAdviceTraffic(driver, 'left', 2);
  assert.equal(app.readState().laneRecommendation.status, 'unavailable');
  assert.match(ui('lane-advice-reason').textContent, /刚完成变道/);
  driver.advance(4);
  assert.equal(app.readState().laneRecommendation.status, 'unavailable');
  assert.equal(app.state.laneTarget, 2);
  driver.advance(1.1);
  assert.ok(app.car.elapsedTime > cooldown);
  // The original slow leader has drawn too close during those five seconds.
  // Present a new safe-but-beneficial gap to isolate cooldown expiry from
  // the separate rule that forbids departing too late behind a close car.
  app.world.vehicles = [adviceVehicle(2, app.car.y + 90, 15, 921)];
  app.render();
  assert.equal(app.readState().laneRecommendation.status, 'recommend');
  assert.equal(app.readState().laneRecommendation.targetLane, 1);
  assert.equal(app.state.laneTarget, 2, 'cooldown expiry shows advice without starting a change');
  assert.equal(app.state.laneChanging, false);
  ui('reset-session').onclick();
  assert.equal(app.state.adviceCooldownUntil, 0);
  assert.equal(app.state.laneAdvice.status, 'unavailable');
  assert.equal(ui('lane-advice-accept').disabled, true);
});

function stageAndStart(driver, command) {
  const { app, ui } = driver;
  ui('ai-tab').onclick();
  ui('command-input').value = command;
  ui('command-form').onsubmit({ preventDefault() {} });
  assert.equal(app.state.plan?.status, 'ready', ui('ai-feedback').textContent);
  ui('task-action').onclick();
  assert.equal(app.state.plan.status, 'running');
}

test('driving shortcuts take over an active AI task from either control tab', () => {
  for (const [code, action, target] of [
    ['KeyW', 'throttle'], ['ArrowUp', 'throttle'], ['KeyS', 'brake'], ['ArrowDown', 'brake'],
    ['KeyA', 'lane', 0], ['ArrowLeft', 'lane', 0], ['KeyD', 'lane', 2], ['ArrowRight', 'lane', 2]
  ]) {
    const driver = loadApp(), { app } = driver;
    app.world.vehicles = [];
    stageAndStart(driver, '前进 200 米');
    driver.advance(0.5);
    assert.equal(app.state.mode, 'ai');
    const beforeX = app.car.x;
    const event = driver.key('keydown', code);
    assert.equal(event.defaultPrevented, true, code);
    assert.equal(app.state.mode, 'manual', code);
    assert.equal(app.state.plan.status, 'cancelled', code);
    if (action === 'lane') {
      assert.equal(app.state.laneTarget, target, code);
      assert.equal(app.state.laneChanging, true, code);
      assert.equal(app.car.x, beforeX, 'the shortcut selects a lane without teleporting');
      driver.key('keydown', code, true);
      assert.equal(app.state.laneTarget, target, 'keyboard repeat must not queue another target');
    } else {
      assert.equal(app.state.controls.get('k' + code), action, code);
      driver.advance(0.02);
      assert.ok(action === 'brake' ? app.state.lastInput.brake > 0 : app.state.lastInput.throttle > 0, code);
      driver.key('keyup', code);
      assert.equal(app.state.controls.has('k' + code), false, code);
    }
    assert.equal(app.state.estop, false, code);
  }
});

test('typing in form fields or editable content does not trigger driving shortcuts', () => {
  const driver = loadApp(), { app, ui, document } = driver;
  app.world.vehicles = [];
  stageAndStart(driver, '前进 200 米');
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  const targets = [ui('command-input'), document.createElement('input'), document.createElement('select'), editable];
  for (const target of targets) {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']) {
      const event = driver.key('keydown', code, false, target);
      assert.equal(event.defaultPrevented, false, `${target.tagName} ${code}`);
      assert.equal(app.state.mode, 'ai');
      assert.equal(app.state.plan.status, 'running');
      assert.equal(app.state.controls.size, 0);
      assert.equal(app.state.laneTarget, 1);
      assert.equal(app.state.serviceBrake, 0);
    }
  }
});

test('solid markings prevent buttons, keyboard changes and otherwise useful traffic advice', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.car.y = 450;
  setAdviceTraffic(driver, 'left');
  assert.equal(app.road.getState(app.car.y).solid, true);
  assert.notEqual(app.readState().laneRecommendation.status, 'recommend');
  assert.match(ui('lane-advice-reason').textContent, /实线/);
  assert.equal(ui('lane-advice-accept').disabled, true);
  for (const side of ['left', 'right']) {
    ui('lane-' + side).onclick();
    assert.equal(app.state.laneTarget, 1);
    assert.equal(app.state.laneChanging, false);
  }
  driver.key('keydown', 'KeyA');
  driver.key('keydown', 'ArrowRight');
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.car.x, 0);
  assert.match(ui('toast').textContent, /实线/);
  app.car.y = 650;
  setAdviceTraffic(driver, 'left');
  assert.equal(app.road.getState(app.car.y).solid, false);
  assert.equal(app.readState().laneRecommendation.status, 'recommend');
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 0);
  assert.equal(app.state.laneChanging, true);
});

test('lane permission reserves space before a solid section in both forward and reverse travel', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { y: 220, speed: 20 });
  driver.setTarget(20);
  assert.equal(app.road.getState(app.car.y).solid, false);
  ui('lane-right').onclick();
  assert.equal(app.state.laneTarget, 1, 'a forward change must finish before the upcoming solid line');
  assert.match(ui('toast').textContent, /实线/);

  Object.assign(app.car, { y: 620, speed: 5, gear: 'reverse' });
  app.state.requestedGear = 'reverse';
  assert.equal(app.road.getState(app.car.y).solid, false);
  driver.key('keydown', 'ArrowLeft');
  assert.equal(app.state.laneTarget, 1, 'a reverse change must check the section behind the car');
  assert.match(ui('toast').textContent, /实线/);
  app.car.y = 700;
  driver.key('keyup', 'ArrowLeft');
  driver.key('keydown', 'ArrowLeft');
  assert.equal(app.state.laneTarget, 0);
});

test('an unsupported clause rejects the entire compound command without starting a partial task', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  ui('ai-tab').onclick();
  ui('command-input').value = '前进 50 米，然后飞起来，再向左变道';
  ui('command-form').onsubmit({ preventDefault() {} });
  assert.equal(app.state.plan, null);
  assert.equal(ui('ai-feedback').classList.contains('error'), true);
  assert.ok(ui('ai-feedback').textContent.length > 0);
  driver.advance(2);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.distance, 0);
  assert.equal(app.state.laneTarget, 1);
});

test('a compound drive-lane-stop plan waits through the solid section then physically changes and brakes', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  driver.setTarget(20);
  stageAndStart(driver, '前进500米，然后向左变道，最后停车');
  assert.equal(app.state.plan.kind, 'sequence');
  assert.deepEqual(Array.from(app.state.plan.steps, step => step.type), ['drive', 'lane', 'brake']);
  advanceUntil(driver, () => /实线/.test(app.state.plan.waitingReason || ''), 40, 0.1);
  assert.equal(app.state.plan.status, 'running');
  assert.equal(app.state.plan.phase, 1);
  assert.ok(app.car.y >= 500 && app.car.y <= 603);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.ok(Math.abs(app.car.x) < 0.01, 'the AI must keep its lane while waiting for a legal change');
  const waitingY = app.car.y;
  advanceUntil(driver, () => app.state.laneChanging, 20, 0.1);
  assert.ok(app.car.y > waitingY && app.car.y > 602.5);
  assert.equal(app.state.laneTarget, 0);
  assert.equal(app.state.plan.status, 'running');
  advanceUntil(driver, () => app.state.plan.status === 'completed', 30, 0.1);
  assert.equal(app.car.speed, 0);
  assert.ok(Math.abs(app.car.x + 3.75) <= 0.1);
  assert.ok(headingError(app.car) <= 0.6);
  assert.ok(app.car.lastBrakeDistance > 15);
  assert.equal(app.state.estop, false);
  assert.equal(app.state.shoulderAlert, false);
  assert.match(ui('task-badge').textContent, /已完成/);
  assert.equal(ui('task-steps').children.length, 3);
  assert.ok(ui('task-steps').children.every(step => step.className === 'done'));
});

test('compound speed, stationary wait and reverse steps execute in order with real stops', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { y: 1500, speed: 20 });
  stageAndStart(driver, '减速至36公里每小时，然后直行10米，等待2秒，再倒车5米，最后停车');
  assert.deepEqual(Array.from(app.state.plan.steps, step => step.type), ['speed', 'drive', 'wait', 'drive', 'brake']);
  driver.advance(0.1);
  assert.ok(app.car.speed < 20 && app.car.speed > 18, 'speed changes must use physical deceleration');
  advanceUntil(driver, () => app.state.plan.phase === 2 && app.car.speed === 0, 30);
  const stoppedY = app.car.y, stoppedDistance = app.car.distance, stoppedAt = app.car.elapsedTime;
  assert.equal(app.car.gear, 'forward');
  driver.advance(1);
  assert.equal(app.state.plan.phase, 2, 'waiting duration must count after stopping, not while braking');
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.y, stoppedY);
  assert.equal(app.car.distance, stoppedDistance);
  advanceUntil(driver, () => app.state.plan.phase > 2, 5);
  assert.ok(app.car.elapsedTime - stoppedAt >= 1.9);
  advanceUntil(driver, () => app.state.plan.status === 'completed', 15);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.y < stoppedY - 5);
  assert.ok(app.car.distance > stoppedDistance + 5);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.state.estop, false);
});

test('an AI lane step waits for a blocked target corridor and resumes when the real gap clears', () => {
  const driver = loadApp(), { app } = driver;
  Object.assign(app.car, { y: 1500, speed: 15 });
  driver.setTarget(15);
  app.world.vehicles = [adviceVehicle(0, app.car.y, 15, 990)];
  stageAndStart(driver, '向左变道，然后停车');
  driver.advance(0.2);
  assert.equal(app.state.plan.phase, 0);
  assert.ok(app.state.plan.waitingReason);
  assert.doesNotMatch(app.state.plan.waitingReason, /实线/);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.laneChanging, false);
  assert.ok(Math.abs(app.car.x) < 0.01);
  app.world.vehicles = [];
  advanceUntil(driver, () => app.state.laneChanging);
  assert.equal(app.state.laneTarget, 0);
  advanceUntil(driver, () => app.state.plan.status === 'completed', 30);
  assert.ok(Math.abs(app.car.x + 3.75) <= 0.1);
  assert.equal(app.car.speed, 0);
  assert.equal(app.state.estop, false);
});

// Only physical user lane controls can commit an exit. This fixture leaves
// the whole route to the real physics; no production function bypasses input.
function enterManualExit({ speed = 10, target = speed, wet = false, input = 'button' } = {}) {
  const driver = loadApp(), { app, ui } = driver;
  const exit = app.road.getState(0).nextExit;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: exit.entryStart + 20, speed });
  app.state.laneTarget = 2;
  app.state.wet = wet;
  driver.setTarget(target);
  if (input === 'button') ui('lane-right').onclick();
  else driver.key('keydown', input);
  assert.equal(app.state.exitActive?.id, exit.id);
  assert.equal(app.state.exitStage, 'deceleration');
  return driver;
}

test('exit has no action button and only a fresh manual right change enters its deceleration lane', () => {
  for (const input of ['button', 'ArrowRight', 'KeyD']) {
    const driver = enterManualExit({ input }), { app, document } = driver;
    assert.equal(document.getElementById('exit-action'), null);
    assert.equal(app.car.x, 3.75, 'accepting the input must not teleport to the new lane');
    assert.equal(app.state.shoulderAlert, false);
    driver.key('keydown', 'KeyW');
    advanceUntil(driver, () => Math.abs(app.car.x - 7.125) < .12, 25);
    assert.equal(app.state.exitStage, 'deceleration');
    assert.equal(app.state.estop, false);
    assert.equal(app.car.wallContactCount, 0);
    const selected = app.state.exitActive.id;
    driver.key('keydown', 'ArrowRight', true);
    driver.key('keydown', 'KeyD', true);
    assert.equal(app.state.exitActive.id, selected, 'a held key cannot queue another route');
  }
});

test('the exit requires the real forward entry window and rejects programmatic lane tools', () => {
  const driver = loadApp(), { app, ui, modelTools } = driver;
  const exit = app.road.getState(0).nextExit;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: exit.entryStart + 20, speed: 10 });
  app.state.laneTarget = 2;
  driver.setTarget(10);
  assert.equal(app.requestExit(), false, 'the former direct route selector is not user consent');
  assert.equal(modelTools.get('change_rover_simulation_lane').execute({ direction: 'right' }).accepted, false);
  assert.equal(app.state.exitActive, null, 'a model tool cannot replace manual right input');
  for (const [name, setup] of [
    ['before entry', () => { app.car.y = exit.entryStart - 10; }],
    ['too late', () => { app.car.y = exit.splitStart - 5; }],
    ['reverse gear', () => { app.car.y = exit.entryStart + 20; app.car.gear = app.state.requestedGear = 'reverse'; }]
  ]) {
    ui('reset-session').onclick();
    app.world.vehicles = [];
    Object.assign(app.car, { x: 3.75, y: exit.entryStart + 20, speed: 10 });
    app.state.laneTarget = 2;
    driver.setTarget(10);
    setup();
    ui('lane-right').onclick();
    assert.equal(app.state.exitActive, null, name);
  }
});

test('the deceleration lane keeps manual throttle and brake ownership without applying the ramp cap', () => {
  const driver = enterManualExit({ speed: 15, target: 15 }), { app } = driver;
  driver.key('keydown', 'KeyW');
  driver.advance(.1);
  assert.equal(app.readState().roadType, 'highway');
  assert.ok(app.readState().roadLimitKmh >= 60);
  assert.ok(app.car.speed > 40 / 3.6);
  assert.equal(app.state.lastInput.brake, 0, 'entering a deceleration lane must not brake automatically');
  assert.equal(app.state.lastInput.throttle, 1);
  assert.equal(app.state.estop, false);
  driver.key('keyup', 'KeyW');
  const coastingSpeed = app.car.speed;
  driver.advance(1);
  assert.ok(app.car.speed < coastingSpeed && app.car.speed > 40 / 3.6);
  assert.equal(app.state.lastInput.brake, 0);
  driver.key('keydown', 'KeyS');
  driver.advance(.1);
  assert.ok(app.state.lastInput.brake > 0, 'the user can deliberately slow for the exit');
  assert.ok(app.car.brakeDistance > 0);
});

test('a manually slowed exit follows the ramp continuously and continues on the ordinary road', () => {
  const driver = enterManualExit({ speed: 15, target: 10 }), { app, ui } = driver;
  const exit = app.state.exitActive;
  driver.key('keydown', 'KeyS');
  advanceUntil(driver, () => app.car.speed <= 10, 8);
  driver.key('keyup', 'KeyS');
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitStage === 'ramp', 80, .1);
  assert.equal(app.readState().roadType, 'ramp');
  assert.ok(app.car.speed <= 40 / 3.6);
  assert.equal(app.state.shoulderAlert, false);
  assert.equal(app.state.estop, false);
  advanceUntil(driver, () => app.car.y >= exit.rampEnd - 5, 100, .1);
  let previous = { ...app.car };
  for (let step = 0; step < 120 && !app.state.exitCompleted; step++) {
    driver.advance(1 / 120);
    assert.ok(app.car.y > previous.y && app.car.y - previous.y < .15);
    assert.ok(Math.abs(app.car.x - previous.x) < .01);
    assert.ok(Math.abs(app.car.speed - previous.speed) < .1);
    assert.equal(app.state.lastInput.brake, 0);
    previous = { ...app.car };
  }
  assert.equal(app.state.exitCompleted, true);
  assert.equal(app.state.exitStage, 'local');
  app.world.vehicles = [];
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.readState().roadLimitKmh, 50);
  assert.equal(app.state.controls.get('kKeyW'), 'throttle');
  assert.equal(app.state.exitCruise, false);
  assert.ok(Math.abs(app.car.x - 29) < .5);
  driver.advance(5);
  const coastStart = { y: app.car.y, speed: app.car.speed };
  driver.key('keyup', 'KeyW');
  driver.advance(3);
  assert.ok(app.car.y > coastStart.y && app.car.speed < coastStart.speed && app.car.speed > 0);
  assert.equal(app.state.lastInput.brake, 0);
  ui('reset-session').onclick();
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitReturn, null);
  assert.equal(app.state.exitStage, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.readState().roadType, 'highway');
});

test('overspeed at the split returns physically to the highway without braking or teleporting', () => {
  for (const wet of [false, true]) {
    const driver = enterManualExit({ speed: 15, target: 15, wet }), { app } = driver;
    driver.key('keydown', 'KeyW');
    advanceUntil(driver, () => app.state.exitStage === 'returning', 40, 1 / 60);
    assert.ok(app.car.speed > 40 / 3.6);
    assert.ok(app.car.x > 5.625);
    assert.equal(app.state.lastInput.brake, 0);
    assert.equal(app.state.exitCompleted, false);
    const returnStart = { ...app.car }, selected = app.state.exitActive.id;
    let previous = { ...app.car }, samples = 0;
    while (app.state.exitActive && samples++ < 40 * 120) {
      driver.advance(1 / 120);
      assert.ok(app.car.y > previous.y, 'returning keeps forward momentum');
      assert.ok(Math.abs(app.car.x - previous.x) < .2, 'returning is a path, not a position assignment');
      assert.ok(Math.abs(app.car.speed - previous.speed) < .1);
      assert.equal(app.state.lastInput.brake, 0, 'the ramp overspeed response is return, not automatic braking');
      assert.equal(app.state.collision, null, 'the return must stay clear of the outside rail');
      previous = { ...app.car };
    }
    assert.equal(app.state.exitActive, null);
    assert.equal(app.state.exitReturn, null);
    assert.equal(app.state.exitStage, null);
    assert.equal(app.state.laneTarget, 2);
    assert.ok(Math.abs(app.car.x - 3.75) <= .15);
    assert.ok(app.car.y > returnStart.y + 20);
    assert.equal(app.state.controls.get('kKeyW'), 'throttle');
    assert.equal(app.state.estop, false);
    assert.equal(app.state.shoulderAlert, false);
    driver.key('keyup', 'KeyW');
    driver.key('keydown', 'ArrowRight');
    assert.notEqual(app.state.exitActive?.id, selected, 'a missed exit cannot be reselected behind the car');
  }
});

test('new ramp overspeed also returns and cannot be overridden by AI, repeated right keys or reverse gear', () => {
  const driver = enterManualExit(), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitStage === 'ramp', 60, .1);
  app.car.speed = 14;
  const before = { ...app.car };
  driver.advance(1 / 120);
  assert.equal(app.state.exitStage, 'returning');
  assert.ok(Math.abs(app.car.x - before.x) < .2 && app.car.y > before.y);
  assert.equal(app.state.lastInput.brake, 0);
  const returning = app.state.exitReturn;
  driver.key('keydown', 'KeyD');
  ui('gear-reverse').onclick();
  app.submitCommand('直行20米');
  assert.equal(app.startPlan(), false);
  ui('auto-start').onclick();
  assert.equal(app.state.autodrive.active, false);
  assert.equal(app.state.exitReturn, returning);
  assert.equal(app.state.requestedGear, 'forward');
  assert.equal(app.state.exitStage, 'returning');
});

test('the ramp limit boundary allows exactly 40 km/h and rejects a measurable excess', () => {
  for (const [speed, stage] of [[40 / 3.6, 'ramp'], [40 / 3.6 + .03, 'returning']]) {
    const driver = enterManualExit({ speed: 10 }), { app } = driver;
    Object.assign(app.car, { x: 7.125, y: app.state.exitActive.splitStart - .02, heading: 0, steer: 0, speed });
    app.state.laneChanging = false;
    driver.advance(1 / 120);
    assert.equal(app.state.exitStage, stage);
    assert.equal(app.state.lastInput.brake, 0);
  }
});

test('a manual left change cancels from the deceleration lane through a continuous return', () => {
  const driver = enterManualExit(), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => Math.abs(app.car.x - 7.125) < .12, 25);
  const before = { ...app.car };
  assert.equal(ui('lane-left').onclick(), true);
  assert.equal(app.state.exitStage, 'returning');
  assert.equal(app.car.x, before.x);
  assert.equal(app.car.y, before.y);
  assert.equal(app.car.speed, before.speed);
  driver.advance(.1);
  assert.equal(app.state.lastInput.brake, 0);
  assert.equal(app.state.controls.get('kKeyW'), 'throttle');
  advanceUntil(driver, () => app.state.exitActive === null, 50, .1);
  assert.ok(Math.abs(app.car.x - 3.75) < .15);
  assert.ok(app.car.y > before.y + 100);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.collision, null);
});

test('reset during an overspeed return removes the route and waits for a fresh driving input', () => {
  const driver = enterManualExit({ speed: 15, target: 15 }), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitStage === 'returning', 40, .1);
  ui('reset-session').onclick();
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitReturn, null);
  assert.equal(app.state.exitStage, null);
  assert.equal(app.state.skippedExit, null);
  driver.key('keydown', 'KeyW', true);
  driver.advance(1);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.state.lastInput.brake, 0);
});

test('an AI exit plan hands off without automatically entering or executing its later clauses', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  const exit = app.road.getState(0).nextExit;
  Object.assign(app.car, { x: 3.75, y: exit.entryStart - 100, speed: 10 });
  app.state.laneTarget = 2;
  driver.setTarget(10);
  stageAndStart(driver, '直行10米，然后从下一个出口驶离，再直行300米，最后停车');
  advanceUntil(driver, () => app.state.plan.status === 'handoff', 10);
  assert.equal(app.state.plan.phase, 1);
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.serviceBrake, 0, 'handoff must not silently slow the car for the ramp');
  assert.match(ui('task-waiting').textContent + ui('ai-feedback').textContent, /手动|右变道/);
  driver.advance(10);
  assert.equal(app.state.plan.status, 'handoff');
  assert.equal(app.state.plan.phase, 1, 'later drive and park clauses wait for an explicit new user action');
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.lastInput.brake, 0);
});

// Full entry and ramp geometry are exercised above. Place the already manual
// route near its endpoint here to isolate ordinary-road controller behavior.
function localRoadManual() {
  const driver = enterManualExit(), { app } = driver;
  app.state.exitStage = 'ramp';
  app.state.laneChanging = false;
  Object.assign(app.car, { x: 29, y: app.state.exitActive.rampEnd - .2, heading: 0, steer: 0 });
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitCompleted, 2);
  app.world.vehicles = [];
  // Controller fixtures use an empty road; timed entrances and late city
  // arrivals are covered separately with explicit moving traffic below.
  if (app.state.highwayTraffic) {
    app.state.highwayTraffic.vehicles = [];
    app.state.highwayTraffic.nextEntranceArrival = app.car.elapsedTime + 10000;
  }
  assert.equal(app.readState().roadType, 'local');
  return driver;
}

function localRoadAutodrive() {
  const driver = localRoadManual(), { app } = driver;
  startAutomatic(driver);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.exitCruise, false);
  assert.ok(app.car.speed > 0);
  return driver;
}

test('automatic driving after a manual exit continues on the ordinary road for several kilometers', () => {
  const driver = localRoadAutodrive(), { app } = driver;
  const initialY = app.car.y, initialDistance = app.car.distance, exitId = app.state.exitActive.id;
  for (let minute = 0; minute < 5; minute++) {
    const previousY = app.car.y;
    driver.advance(60);
    assert.ok(app.car.y > previousY + 800, 'driving must continue beyond the original rendered exit range');
    assert.ok(Math.abs(app.car.x - 29) < 0.1);
    assert.ok(app.car.speed > 13.8 && app.car.speed <= 50 / 3.6 + 0.01);
    assert.equal(app.readState().roadType, 'local');
    assert.equal(app.readState().roadLimitKmh, 50);
    assert.equal(app.state.exitActive.id, exitId, 'passing other highway events must not replace the selected local route');
    assert.equal(app.state.autodrive.active, true);
    assert.equal(app.state.exitCruise, false);
    assert.equal(app.state.lastInput.throttle, 1);
    assert.equal(app.state.lastInput.brake, 0);
    assert.equal(app.state.estop, false);
  }
  assert.ok(app.car.y - initialY > 4000);
  assert.ok(app.car.distance - initialDistance > 4000);
});

test('ordinary-road overspeed braking reduces speed physically to 50 km/h and then resumes cruise', () => {
  const driver = localRoadAutodrive(), { app, ui } = driver;
  app.car.speed = 25;
  driver.advance(0.1);
  assert.ok(app.car.speed < 25 && app.car.speed > 24, 'the ordinary-road cap must not assign velocity directly');
  assert.equal(app.state.lastInput.throttle, 0);
  assert.ok(app.state.lastInput.brake > 0);
  assert.equal(app.state.autoLimitBraking, true);
  assert.equal(app.readState().roadLimitKmh, 50);
  assert.equal(ui('road-limit-sign').textContent, '50');
  driver.advance(15);
  assert.ok(app.car.speed <= 50 / 3.6 + 0.01 && app.car.speed > 13.8);
  assert.equal(app.state.autoLimitBraking, false);
  assert.equal(app.state.lastInput.brake, 0);
  assert.equal(app.state.lastInput.throttle, 1);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.state.estop, false);
});

test('manual shortcuts, requested braking and focus loss cancel ordinary-road automatic driving', () => {
  const interruptions = [
    ['manual throttle', driver => driver.key('keydown', 'KeyW'), false],
    ['manual lane shortcut', driver => driver.key('keydown', 'KeyA'), false],
    ['manual brake', driver => driver.key('keydown', 'KeyS'), true],
    ['normal stop', driver => driver.ui('normal-stop').onclick(), true],
    ['keyboard stop', driver => driver.key('keydown', 'Space'), true],
    ['focus loss', driver => driver.dispatch('blur'), true]
  ];
  for (const [name, interrupt, braking] of interruptions) {
    const driver = localRoadAutodrive(), { app } = driver;
    const localLane = app.state.laneTarget;
    interrupt(driver);
    assert.equal(app.state.exitCruise, false, name);
    assert.equal(app.state.autodrive.active, false, name);
    driver.advance(0.1);
    assert.equal(app.state.lastInput.brake > 0, braking, name);
    if (name === 'manual throttle') {
      assert.equal(app.state.lastInput.throttle, 1);
      driver.key('keyup', 'KeyW');
      const speed = app.car.speed;
      driver.advance(1);
      assert.equal(app.state.lastInput.throttle, 0);
      assert.ok(app.car.speed < speed, 'releasing a takeover throttle must not restore cruise');
    } else if (braking) {
      advanceUntil(driver, () => app.car.speed === 0, 8);
      driver.advance(1);
      assert.equal(app.car.speed, 0, name + ' must not restart after the stop');
      assert.equal(app.state.lastInput.throttle, 0, name);
    } else {
      assert.equal(app.state.lastInput.throttle, 0);
      assert.equal(app.state.laneTarget, localLane, 'taking over does not steer into the opposing ordinary-road lane');
    }
    assert.equal(app.readState().roadType, 'local', name);
  }
});

test('the one-lane ordinary road rejects cross-direction lane changes and permits a new speed-drive-stop task', () => {
  const driver = localRoadAutodrive(), { app, ui } = driver;
  const positionX = app.car.x, localLane = app.state.laneTarget;
  assert.equal(app.state.entranceActive, null);
  assert.equal(ui('lane-right').disabled, true);
  for (const direction of ['left', 'right']) ui('lane-' + direction).onclick();
  assert.equal(app.state.entranceActive, null, 'outside a marked entrance the left control does not cross the city center line');
  assert.equal(app.state.laneTarget, localLane);
  assert.equal(app.state.laneChanging, false);
  driver.advance(1);
  assert.ok(Math.abs(app.car.x - positionX) < 0.02);
  stageAndStart(driver, '以36公里每小时行驶20米，然后停车');
  assert.equal(app.state.exitCruise, false, 'a new explicit plan takes ownership from automatic cruise');
  advanceUntil(driver, () => app.state.plan.status === 'completed', 20);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.state.exitCruise, false);
  assert.ok(Math.abs(app.car.x - 29) < 0.1);
});

test('ordinary-road reverse tasks work after stopping and reset clears the cruise route', () => {
  const driver = localRoadAutodrive(), { app, ui } = driver;
  // Leave enough ordinary road behind the car to keep this reverse maneuver
  // distinct from the separate protection at the former motorway ramp.
  driver.advance(20);
  ui('normal-stop').onclick();
  advanceUntil(driver, () => app.car.speed === 0, 8);
  const stoppedY = app.car.y;
  stageAndStart(driver, '倒车10米');
  advanceUntil(driver, () => app.state.plan.status === 'completed', 15);
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.y < stoppedY - 10);
  assert.ok(Math.abs(app.car.x - 29) < 0.1);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.readState().roadType, 'local');
  ui('reset-session').onclick();
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.readState().roadType, 'highway');
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.state.requestedGear, 'forward');
  const cruising = localRoadAutodrive();
  assert.equal(cruising.app.state.autodrive.active, true);
  cruising.ui('reset-session').onclick();
  assert.equal(cruising.app.state.autodrive.active, false, 'reset also clears active automatic driving');
  assert.equal(cruising.app.state.exitActive, null);
  assert.equal(cruising.app.readState().roadType, 'highway');
  cruising.advance(1);
  assert.equal(cruising.app.car.speed, 0);
});

function cityEntranceFixture({ input = null, speed = 5, yOffset = 2 } = {}) {
  const driver = localRoadManual(), { app, ui } = driver;
  const event = app.road.getState(app.car.y).nextCityEntrance;
  assert.ok(event, 'ordinary roads must expose upcoming highway entrances');
  app.world.vehicles = [];
  if (app.state.highwayTraffic) {
    app.state.highwayTraffic.vehicles = [];
    app.state.highwayTraffic.nextEntranceArrival = app.car.elapsedTime + 1000;
  }
  Object.assign(app.car, { x: 29, y: event.cityEntryStart + yOffset, heading: 0, steer: 0, speed });
  driver.setTarget(5);
  if (input === 'button') ui('lane-left').onclick();
  else if (input) driver.key('keydown', input);
  return { ...driver, event };
}

test('a city entrance accepts only a fresh manual left control and keeps its approach position continuous', () => {
  for (const input of ['button', 'ArrowLeft', 'KeyA']) {
    const driver = cityEntranceFixture(), { app, ui, event } = driver;
    const before = { ...app.car };
    app.render();
    assert.equal(ui('lane-left').disabled, false);
    if (input === 'button') ui('lane-left').onclick();
    else driver.key('keydown', input);
    assert.equal(app.state.entranceActive?.id, event.id, input);
    assert.equal(app.state.entranceStage, 'joining');
    assert.equal(app.readState().roadType, 'entrance');
    assert.equal(app.car.x, before.x);
    assert.equal(app.car.y, before.y);
    assert.equal(app.car.speed, before.speed);
    assert.equal(app.state.exitCompleted, true, 'keep the city route until the physical merge finishes');
    const selected = app.state.entranceActive;
    driver.key('keydown', 'ArrowLeft', true);
    driver.key('keydown', 'KeyA', true);
    assert.equal(app.state.entranceActive, selected);
    assert.equal(app.state.estop, false);
  }
});

test('city double-yellow markings reject crossing outside the entrance, above 20 km/h, in reverse or by AI', () => {
  const cases = [
    ['before opening', (driver) => { driver.app.car.y = driver.event.cityEntryStart - 1; }],
    ['missed opening', (driver) => { driver.app.car.y = driver.event.cityEntryEnd + 1; }],
    ['too fast', (driver) => { driver.app.car.speed = 20 / 3.6 + .2; }],
    ['reverse', (driver) => { driver.app.car.gear = driver.app.state.requestedGear = 'reverse'; }],
    ['not centered', (driver) => { driver.app.car.x = 28.4; }]
  ];
  for (const [name, setup] of cases) {
    const driver = cityEntranceFixture(), { app, ui } = driver;
    setup(driver);
    const before = { x: app.car.x, y: app.car.y, speed: app.car.speed };
    ui('lane-left').onclick();
    assert.equal(app.state.entranceActive, null, name);
    assert.equal(app.car.x, before.x, name);
    assert.equal(app.car.y, before.y, name);
    assert.equal(app.car.speed, before.speed, name);
    assert.equal(app.readState().roadType, 'local', name);
  }
  const driver = cityEntranceFixture(), { app, ui, modelTools } = driver;
  ui('lane-right').onclick();
  assert.equal(app.state.entranceActive, null, 'the outside of the city lane is not a highway entrance');
  assert.equal(modelTools.get('change_rover_simulation_lane').execute({ direction: 'left' }).accepted, false);
  assert.equal(app.state.entranceActive, null, 'AI cannot replace manual entrance consent');
  driver.key('keydown', 'ArrowLeft', true);
  assert.equal(app.state.entranceActive, null, 'a key already held before the opening cannot commit the entrance');
});

test('a dangerous oncoming car blocks the city entrance until its real corridor clears', () => {
  const driver = cityEntranceFixture(), { app, ui } = driver;
  const oncoming = { ...adviceVehicle(1, app.car.y + 75, 12, 911), x: 25.5,
    previousX: 25.5, direction: -1, heading: 180 };
  app.world.vehicles = [oncoming];
  assert.equal(ui('lane-left').onclick(), false);
  assert.equal(app.state.entranceActive, null);
  assert.match(ui('toast').textContent, /对向|来车|间隙|等待/);
  app.world.vehicles = [];
  assert.equal(ui('lane-left').onclick(), true);
  assert.equal(app.state.entranceStage, 'joining');
});

test('a parked selected city entrance rechecks opposing traffic before a delayed throttle starts the turn', () => {
  const driver = cityEntranceFixture({ speed: 0 }), { app, ui } = driver;
  driver.key('keyup', 'KeyW');
  const oncoming = { ...adviceVehicle(1, app.car.y + 180, 12, 912), x: 25.5,
    previousX: 25.5, direction: -1, heading: 180, cruiseFactor: 12 / (50 / 3.6) };
  app.world.vehicles = [oncoming];
  const origin = { ...app.car };
  assert.equal(ui('lane-left').onclick(), true, 'a future route can be selected while its current gap is safe');
  driver.advance(10);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.x, origin.x);
  assert.equal(app.car.y, origin.y);
  assert.ok(oncoming.y - app.car.y > 58 && oncoming.y - app.car.y < 62);
  driver.key('keydown', 'KeyW');
  driver.advance(.5);
  assert.equal(app.state.lastInput.throttle, 0, 'old route selection must not preserve a stale turning permission');
  assert.ok(app.car.speed < .1);
  assert.ok(Math.abs(app.car.x - origin.x) < .02 && app.car.y - origin.y < .2,
    'any slight startup is physically braked within the original city lane');
  assert.equal(app.state.collision, null);
  driver.advance(8);
  assert.equal(app.state.collision, null, 'the delayed turn cannot cross the approaching car');
  assert.ok(app.car.x < origin.x && app.car.y > origin.y, 'held manual throttle may proceed after the opposing car has passed');
});

test('full 20 km/h city-entry targets never cut across close opposing traffic on dry or wet starts', () => {
  for (const [wet, speed, frontDistance] of [[false, 0, 40], [true, 0, 40], [false, 5, 34], [true, 5, 32]]) {
    const driver = cityEntranceFixture({ speed }), { app, ui } = driver;
    driver.key('keyup', 'KeyW');
    app.state.wet = wet;
    driver.setTarget(20 / 3.6);
    const oncoming = { ...adviceVehicle(1, app.car.y + frontDistance, 12, 913), x: 25.5,
      previousX: 25.5, direction: -1, heading: 180, cruiseFactor: 12 / (50 / 3.6) };
    app.world.vehicles = [oncoming];
    const accepted = ui('lane-left').onclick();
    driver.key('keydown', 'KeyW');
    for (let tick = 0; tick < 200; tick++) {
      driver.advance(.05);
      assert.equal(app.state.collision, null,
        `wet=${wet}, start=${speed} m/s, oncoming=${frontDistance} m: reject or yield instead of cutting across`);
      if (!accepted) {
        assert.equal(app.state.entranceActive, null);
        assert.ok(Math.abs(app.car.x - 29) < .1, 'a rejected left gesture keeps the original city lane');
      }
    }
  }
});

test('a real manual highway exit, city journey and new entrance returns to the same live highway world', () => {
  const driver = enterManualExit({ speed: 10, target: 10 }), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitCompleted, 130, .1);
  const cityWorld = app.world, highwayWorld = app.state.highwayTraffic;
  assert.ok(highwayWorld && highwayWorld !== cityWorld);
  assert.equal(cityWorld.roadType, 'local');
  assert.equal(highwayWorld.roadType, 'highway');
  const event = app.road.getState(app.car.y).nextCityEntrance;
  app.world.vehicles = [];
  highwayWorld.vehicles = [];
  highwayWorld.nextEntranceArrival = app.car.elapsedTime + 1000;
  driver.key('keyup', 'KeyW');
  driver.key('keydown', 'KeyS');
  advanceUntil(driver, () => app.car.speed <= 5, 8);
  driver.key('keyup', 'KeyS');
  driver.setTarget(5);
  driver.key('keydown', 'KeyW');
  const cityStart = { ...app.car };
  advanceUntil(driver, () => app.car.y >= event.cityEntryStart + 1, 60, .05);
  assert.ok(app.car.y > cityStart.y, 'drive through the ordinary road instead of placing the car at the entrance');
  assert.equal(ui('lane-left').onclick(), true);
  assert.equal(app.state.highwayTraffic, highwayWorld);
  const sentinel = adviceVehicle(0, app.car.y + 300, 15, 9917);
  highwayWorld.vehicles = [sentinel];
  const sentinelStart = sentinel.y, entryY = app.car.y;
  let previous = { ...app.car }, samples = 0;
  while (app.state.entranceActive && samples++ < 150 * 60) {
    driver.advance(1 / 60);
    assert.ok(app.car.y >= previous.y && app.car.y - previous.y < .3);
    assert.ok(Math.abs(app.car.x - previous.x) < .15, 'all entry and merge positions come from motion');
    assert.ok(Math.abs(app.car.speed - previous.speed) < .2);
    assert.equal(app.state.collision, null);
    assert.equal(app.state.shoulderAlert, false);
    previous = { ...app.car };
  }
  assert.equal(app.state.entranceActive, null);
  assert.equal(app.state.entranceStage, null);
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.exitReturn, null);
  assert.equal(app.readState().roadType, 'highway');
  assert.equal(app.world, highwayWorld, 'the highway traffic was running before the merge, not spawned at completion');
  assert.ok(app.world.vehicles.includes(sentinel));
  assert.ok(sentinel.y > sentinelStart + 100);
  assert.ok(app.car.y > entryY + 200 && Math.abs(app.car.x - 3.75) < .15);
  assert.equal(app.state.laneTarget, 2);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.readState().roadLimitKmh, app.traffic.limitAt(app.car.y));
  assert.equal(app.state.estop, false);
  assert.equal(app.state.controls.get('kKeyW'), 'throttle');
  driver.advance(.5);
  assert.equal(app.state.lastInput.guardrails, true);
});

test('a blocked highway merge physically waits for a clear gap without acquiring automatic throttle', () => {
  const driver = cityEntranceFixture({ input: 'button' }), { app } = driver;
  const route = app.state.entranceActive;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.car.y > route.crossingEnd + 10, 35, .1);
  app.state.highwayTraffic.vehicles = Array.from({ length: 28 }, (_, index) =>
    ({ ...adviceVehicle(2, route.mergeStart - 60 + index * 10, 0, 922 + index), cruiseFactor: 0 }));
  advanceUntil(driver, () => app.state.entranceStage === 'waiting', 80, .05);
  assert.ok(app.car.y < route.mergeStart);
  const waitAt = app.car.y, speed = app.car.speed;
  driver.advance(.1);
  assert.ok(app.car.speed <= speed && app.car.y >= waitAt, 'wait braking keeps physical motion');
  advanceUntil(driver, () => app.car.speed === 0, 25, .05);
  assert.ok(app.car.y > waitAt && app.car.y < route.mergeStart - 12);
  assert.ok(app.car.lastBrakeDistance > 0, 'the merge protection stops through a real braking distance');
  assert.equal(app.state.entranceStage, 'waiting');
  driver.key('keyup', 'KeyW');
  app.state.highwayTraffic.vehicles = [];
  driver.advance(1);
  assert.equal(app.state.lastInput.throttle, 0, 'an available gap does not press the user throttle');
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.entranceActive === null, 100, .1);
  assert.equal(app.readState().roadType, 'highway');
  assert.equal(app.state.estop, false);
});

test('reset during a city entrance clears both route states and background traffic ownership', () => {
  const driver = cityEntranceFixture({ input: 'KeyA' }), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  driver.advance(2);
  assert.ok(app.state.entranceActive);
  ui('reset-session').onclick();
  assert.equal(app.state.entranceActive, null);
  assert.equal(app.state.entranceStage, null);
  assert.equal(app.state.highwayTraffic, null);
  assert.equal(app.state.localTraffic, null);
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.car.x, 0);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
  assert.equal(app.world.roadType, 'highway');
  driver.key('keydown', 'KeyW', true);
  driver.advance(1);
  assert.equal(app.car.speed, 0);
});

test('Chinese digit sequences keep their complete distance and malformed numerals reject the whole command', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  driver.setTarget(10);
  stageAndStart(driver, '前进一二三米');
  assert.equal(app.state.plan.steps[0].distance, 123, '一二三 must mean 123, never just the final digit');
  advanceUntil(driver, () => app.state.plan.status === 'completed', 30, 0.1);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.distance >= 123 && app.car.distance < 135, 'actual travel includes 123 m plus physical stopping distance');

  for (const command of ['前进二百百米', '前进20米，然后直行二百百米，再停车']) {
    const rejected = loadApp();
    const result = rejected.app.submitCommand(command);
    assert.equal(result.status, 'error');
    assert.equal(rejected.app.state.plan, null, 'no valid prefix may start if a later numeral is invalid');
    assert.equal(rejected.ui('ai-feedback').classList.contains('error'), true);
    rejected.advance(1);
    assert.equal(rejected.app.car.distance, 0);
    assert.equal(rejected.app.car.speed, 0);
  }
});

test('a paced reverse command switches gear before accelerating and never moves forward', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  assert.equal(app.car.gear, 'forward');
  stageAndStart(driver, '以5米每秒倒车10米');
  assert.equal(app.state.requestedGear, 'reverse');
  let previousY = app.car.y;
  for (let tick = 0; tick < 30 * 120 && app.state.plan.status === 'running'; tick++) {
    app.advanceElapsed(1 / 120);
    assert.ok(app.car.y <= previousY + 1e-10, 'every physical substep must move rearward or remain still');
    if (app.car.speed > 0) assert.equal(app.car.gear, 'reverse');
    assert.ok(app.car.speed <= 5);
    previousY = app.car.y;
  }
  assert.equal(app.state.plan.status, 'completed');
  assert.equal(app.car.gear, 'reverse');
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.y < -10 && app.car.distance > 10);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.state.estop, false);
});

test('a paced forward command physically stops a reversing car before gear change and starts its distance later', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { y: 1500, speed: 5, gear: 'reverse' });
  app.state.requestedGear = 'reverse';
  stageAndStart(driver, '以36公里每小时行驶20米');
  assert.equal(app.state.requestedGear, 'forward');
  driver.advance(0.1);
  assert.equal(app.car.gear, 'reverse');
  assert.ok(app.car.speed > 4 && app.car.speed < 5, 'changing direction must apply real deceleration');
  assert.ok(app.car.y < 1500);
  assert.equal(app.state.plan.phase, 0);
  for (let tick = 0; tick < 5 * 120 && app.car.gear === 'reverse'; tick++) {
    const previousY = app.car.y;
    app.advanceElapsed(1 / 120);
    assert.ok(app.car.y <= previousY + 1e-10);
    if (app.car.gear === 'forward') assert.equal(app.car.speed, 0, 'gear changes only when braking reaches zero, including the final substep');
  }
  assert.equal(app.car.gear, 'forward');
  assert.ok(app.car.lastBrakeDistance > 1);
  assert.equal(app.state.plan.phase, 0, 'forward distance cannot count during the shift or acceleration phase');
  advanceUntil(driver, () => app.state.plan.phase === 1, 15);
  const driveStartDistance = app.state.plan.stepDistance;
  assert.ok(driveStartDistance > 10, 'reverse braking and forward acceleration must be excluded from the 20 m drive step');
  assert.equal(app.state.plan.steps[1].distance, 20);
  assert.ok(app.car.speed > 9.8 && app.car.speed <= 10);
  advanceUntil(driver, () => app.state.plan.status === 'completed', 15);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.gear, 'forward');
  assert.ok(app.car.distance - driveStartDistance >= 20 && app.car.distance - driveStartDistance < 30);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.state.estop, false);
});

function startAutomatic(driver, route = 'cruise') {
  const { app, ui, document } = driver;
  ui('auto-tab').onclick();
  const choice = document.querySelectorAll('[data-auto-route]').find(button => button.dataset.autoRoute === route);
  assert.ok(choice, 'automatic driving must expose both route choices');
  choice.onclick();
  ui('auto-start').onclick();
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.autodrive.route, route);
}

function setHornTraffic(driver) {
  const { app } = driver;
  Object.assign(app.car, { x:0, y:900, heading:0, speed:20, gear:'forward' });
  app.world.vehicles = [adviceVehicle(1,980,18,990)];
  app.render();
  return app.world.vehicles[0];
}

test('the common horn button produces a real gradual yield without changing ego controls', () => {
  const driver = loadApp(), { app, ui } = driver, lead = setHornTraffic(driver);
  const before = JSON.stringify(app.car);
  const result = ui('horn-button').onclick();
  assert.equal(result.status,'yielding');
  assert.equal(JSON.stringify(app.car),before,'pressing the horn must not change the player pose or speed');
  assert.equal(lead.x,0,'the lead car must not teleport at the button press');
  assert.equal(app.state.controls.size,0);
  assertNoAutomaticBrake(app);
  assert.match(ui('horn-status').textContent,/安全避让/);
  driver.advance(.8);
  assert.ok(lead.x>0 && lead.x<3.75);
  assert.equal(app.readState().horn.count,1);
  driver.advance(4);
  assert.equal(lead.x,3.75);
  assert.equal(lead.lane,2);
  assert.equal(app.readState().horn.status,'completed');
  assert.match(ui('horn-status').textContent,/已完成避让/);
  assert.equal(app.world.contacts,0);
});

test('horn activation and repeated presses preserve automatic driving ownership', () => {
  const driver = loadApp(), { app, ui } = driver;
  setHornTraffic(driver);
  app.state.adviceCooldownUntil=999;
  startAutomatic(driver);
  const first=ui('horn-button').onclick();
  assert.equal(first.status,'yielding');
  assert.equal(ui('horn-button').onclick(),false);
  assert.equal(app.state.horn.count,1);
  assert.equal(app.state.mode,'auto');
  assert.equal(app.state.autodrive.active,true);
  driver.advance(5);
  assert.equal(app.state.autodrive.active,true);
  assert.equal(app.state.mode,'auto');
  assert.equal(app.car.x,0);
  assert.equal(app.world.contacts,0);
  assert.equal(app.state.estop,false);
});

test('Space and Enter on the horn sound once without triggering the global brake shortcut', () => {
  for(const code of ['Space','Enter']){
    const driver=loadApp(),{app,ui}=driver;
    setHornTraffic(driver);
    const button=ui('horn-button');
    const press=driver.key('keydown',code,false,button);
    driver.key('keydown',code,true,button);
    assert.equal(press.defaultPrevented,true);
    assert.equal(app.state.horn.count,1);
    assert.equal(app.state.horn.status,'yielding');
    assert.equal(button.disabled,false,'cooldown must preserve keyboard focus');
    assert.equal(button.getAttribute('aria-disabled'),'true');
    assertNoAutomaticBrake(app);
  }
});

test('a second beep during either cooldown still tracks the first car until it completes yielding', () => {
  for(const seconds of [1.3,2.6]){
    const driver=loadApp(),{app,ui}=driver,lead=setHornTraffic(driver);
    ui('horn-button').onclick();driver.advance(seconds);
    assert.equal(ui('horn-button').onclick().status,'cooldown');
    assert.equal(app.state.horn.vehicle,lead);
    assert.equal(app.state.horn.targetLane,2);
    driver.advance(5);
    assert.equal(app.state.horn.status,'completed');
    assert.match(ui('horn-status').textContent,/已完成避让/);
  }
});

test('the horn evaluates the leading car solid line rather than only the player road position', () => {
  const driver=loadApp(),{app,ui}=driver,lead=setHornTraffic(driver);
  app.car.y=300;lead.y=lead.previousY=380;
  const result=ui('horn-button').onclick();
  assert.equal(result.status,'blocked');
  assert.match(ui('horn-status').textContent,/实线/);
  assert.ok(!lead.laneChange);
  assert.equal(app.state.serviceBrake,0);
});

test('a horn with no nearby car still gives clear feedback without changing the driving plan', () => {
  const driver=loadApp(),{app,ui}=driver;
  app.world.vehicles=[];app.car.y=900;
  app.submitCommand('直行500米后停车');app.startPlan();
  assert.equal(app.state.plan.status,'running');
  const result=ui('horn-button').onclick();
  assert.equal(result.status,'unavailable');
  assert.match(ui('horn-status').textContent,/100 米/);
  assert.equal(app.state.plan.status,'running');
  assert.equal(app.state.serviceBrake,0);
});

test('unsupported audio does not break horn feedback or traffic yielding', () => {
  const driver=loadApp({AudioContext:function(){throw new Error('audio unavailable');}}),{app,ui}=driver;
  setHornTraffic(driver);
  assert.equal(ui('horn-button').onclick().status,'yielding');
  driver.advance(5);
  assert.equal(app.state.horn.status,'completed');
});

test('disconnect disables the horn and reset clears its feedback and cooldown', () => {
  const driver=loadApp(),{app,ui}=driver;
  setHornTraffic(driver);ui('horn-button').onclick();
  ui('toggle-connection').onclick();
  assert.equal(ui('horn-button').disabled,true);
  assert.equal(ui('horn-button').onclick(),false);
  assert.equal(app.state.horn.count,1);
  ui('toggle-connection').onclick();ui('reset-session').onclick();
  assert.equal(app.readState().horn.status,'idle');
  assert.equal(app.readState().horn.count,0);
  assert.equal(ui('horn-button').disabled,false);
  assert.ok(app.world.vehicles.every(vehicle=>!vehicle.laneChange));
});

test('rebuilding traffic cancels the reported yield instead of attributing it to a replacement car', () => {
  const driver=loadApp(),{app,ui,document}=driver;
  setHornTraffic(driver);ui('horn-button').onclick();
  document.querySelectorAll('[data-density]').find(button=>button.dataset.density==='low').onclick();
  assert.equal(app.state.horn.status,'cancelled');
  assert.match(ui('horn-status').textContent,/取消避让/);
  assert.ok(app.world.vehicles.every(vehicle=>!vehicle.laneChange));
});

test('automatic driving starts from rest without held controls and leaves the manual speed setting independent', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  driver.setTarget(5);
  ui('auto-tab').onclick();
  assert.equal(app.state.autodrive.active, false, 'opening the tab alone must not move the car');
  assert.equal(app.car.speed, 0);
  ui('auto-start').onclick();
  driver.advance(3);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.car.gear, 'forward');
  assert.ok(app.car.y > 10 && app.car.speed > 5);
  assert.ok(app.car.speed <= app.readState().roadLimitKmh / 3.6);
  assert.equal(app.state.controls.size, 0);
  assert.equal(app.state.speedLimit, 5, 'autonomous road-speed targeting must not rewrite the manual slider');
  assert.equal(app.state.exitCruise, false);
  const status = app.readState().autodrive;
  assert.equal(status.active, true);
  assert.equal(status.route, 'cruise');
  assert.ok(status.status && status.reason);
  assert.equal(ui('auto-stop').hidden, false);
});

test('automatic driving physically stops reverse motion before switching to forward and accelerating', () => {
  for (const speed of [0, 5]) {
    const driver = loadApp(), { app } = driver;
    app.world.vehicles = [];
    Object.assign(app.car, { y: 900, gear: 'reverse', speed });
    app.state.requestedGear = 'reverse';
    startAutomatic(driver);
    assert.equal(app.state.requestedGear, 'forward');
    const initialY = app.car.y;
    if (speed > 0) {
      driver.advance(0.1);
      assert.equal(app.car.gear, 'reverse');
      assert.ok(app.car.speed > 0 && app.car.speed < speed);
      assert.ok(app.car.y < initialY);
    }
    for (let tick = 0; tick < 5 * 120 && app.car.gear === 'reverse'; tick++) {
      app.advanceElapsed(1 / 120);
      if (speed > 0 && app.car.gear === 'forward') assert.equal(app.car.speed, 0);
    }
    assert.equal(app.car.gear, 'forward');
    if (speed > 0) assert.ok(app.car.lastBrakeDistance > 0);
    const shiftedY = app.car.y;
    driver.advance(2);
    assert.ok(app.car.y > shiftedY && app.car.speed > 0);
    assert.equal(app.state.autodrive.active, true);
    assert.equal(app.state.estop, false);
  }
});

test('automatic following physically stops behind a queue and restarts when the obstruction clears', () => {
  const driver = loadApp(), { app, document } = driver;
  document.querySelectorAll('[data-density]').find(button => button.dataset.density === 'dense').onclick();
  Object.assign(app.car, { y: 900, speed: 20 });
  app.world.vehicles = [0, 1, 2].map(lane => adviceVehicle(lane, 950, 0, 1200 + lane));
  startAutomatic(driver);
  driver.advance(0.1);
  assert.ok(app.car.speed < 20 && app.car.speed > 18, 'a queue must cause physical deceleration');
  assert.ok(app.state.lastInput.brake > 0);
  advanceUntil(driver, () => app.car.speed === 0, 25, 0.1);
  assert.ok(app.car.y < 945.5 && app.car.y > 900);
  assert.equal(app.world.contacts, 0);
  assert.equal(app.state.laneTarget, 1);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.estop, false, 'normal queue braking must not latch emergency stop');
  const stoppedY = app.car.y;
  driver.advance(1);
  assert.equal(app.car.speed, 0);
  assert.equal(app.car.y, stoppedY);
  app.world.vehicles = [];
  driver.advance(3);
  assert.ok(app.car.speed > 1 && app.car.y > stoppedY + 1);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.lastInput.brake, 0);
});

test('automatic driving chooses a safe adjacent lane and holds its center after the maneuver', () => {
  const driver = loadApp(), { app } = driver;
  app.car.y = 900;
  setAdviceTraffic(driver, 'left');
  startAutomatic(driver);
  advanceUntil(driver, () => app.state.laneChanging, 3);
  assert.equal(app.state.laneTarget, 0);
  assert.equal(app.state.autodrive.active, true, 'an internally requested lane change must not cancel autonomous driving');
  app.world.vehicles = [];
  advanceUntil(driver, () => !app.state.laneChanging, 20);
  assert.ok(Math.abs(app.car.x + 3.75) <= 0.08);
  assert.ok(headingError(app.car) <= 0.6);
  driver.advance(3);
  assert.ok(Math.abs(app.car.x + 3.75) < 0.05);
  assert.equal(app.state.laneTarget, 0);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.shoulderAlert, false);
});

test('automatic driving stays within its lane through a solid section despite a slower leader', () => {
  const driver = loadApp(), { app } = driver;
  Object.assign(app.car, { y: 450, speed: 20 });
  app.world.vehicles = [adviceVehicle(1, 540, 15, 1210), adviceVehicle(2, 450, 20, 1211)];
  startAutomatic(driver);
  let inspected = false;
  for (let tick = 0; tick < 300 && app.car.y <= 602.5; tick++) {
    driver.advance(0.1);
    if (app.car.y <= 602.5) {
      inspected = true;
      assert.equal(app.state.laneTarget, 1);
      assert.equal(app.state.laneChanging, false);
      assert.ok(Math.abs(app.car.x) < 0.01);
    }
  }
  assert.equal(inspected, true);
  assert.ok(app.car.y > 602.5, 'the car should continue through the solid section while following');
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.shoulderAlert, false);
});

test('automatic driving anticipates the next generated lower limit and crosses it at a legal speed', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  const limit = app.traffic.nextLimit(0, 1);
  const oldLimit = app.traffic.limitAt(limit.y - 0.1);
  assert.ok(limit.limitKmh < oldLimit);
  Object.assign(app.car, { y: limit.y - 80, speed: oldLimit / 3.6 });
  startAutomatic(driver);
  driver.advance(0.1);
  assert.ok(app.car.y < limit.y);
  assert.ok(app.state.lastInput.brake > 0, 'deceleration begins before the limit sign');
  assert.ok(app.car.speed < oldLimit / 3.6 && app.car.speed > limit.limitKmh / 3.6);
  advanceUntil(driver, () => app.car.y >= limit.y, 15, 0.05);
  assert.ok(app.car.speed <= limit.limitKmh / 3.6 + 0.15);
  assert.equal(app.readState().roadLimitKmh, limit.limitKmh);
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.estop, false);
});

test('the automatic exit route hands control to the user instead of choosing the deceleration lane', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  const exit = app.road.getState(0).nextExit;
  Object.assign(app.car, { x: 3.75, y: exit.entryStart - 500 });
  app.state.laneTarget = 2;
  driver.setTarget(5);
  startAutomatic(driver, 'exit');
  advanceUntil(driver, () => app.state.plan.status === 'handoff', 30, .1);
  assert.equal(app.state.speedLimit, 5, 'route assistance keeps the manual speed setting independent');
  assert.equal(app.state.autodrive.active, false);
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.serviceBrake, 0);
  assert.ok(app.car.speed > 0, 'handoff preserves actual momentum');
  assert.match(ui('task-waiting').textContent + ui('ai-feedback').textContent, /手动|右变道/);
  driver.advance(25);
  assert.equal(app.state.exitActive, null, 'without a new right gesture the car stays on the main road');
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.lastInput.brake, 0);
  assert.equal(app.state.shoulderAlert, false);
});

test('an automatic exit uses its actual cruising speed to reserve room before a solid section', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  app.car.y = 334;
  driver.setTarget(1);
  startAutomatic(driver, 'exit');
  assert.equal(app.state.speedLimit, 1, 'route safety must not rewrite the independent manual slider');
  assert.equal(app.state.laneChanging, false, 'automatic acceleration needs more room than the manual 1 m/s preview');
  for (let tick = 0; tick < 200 && app.car.y <= 602.5; tick++) {
    driver.advance(0.1);
    if (app.car.y <= 602.5) {
      assert.equal(app.state.laneTarget, 1);
      assert.equal(app.state.laneChanging, false);
      assert.ok(Math.abs(app.car.x) < 0.01);
    }
  }
  assert.ok(app.car.y > 602.5);
  advanceUntil(driver, () => app.state.laneChanging, 5);
  assert.equal(app.state.laneTarget, 2);
  assert.equal(app.state.autodrive.active, true);
});

test('changing an active automatic route assists toward the exit but still requires manual commitment', () => {
  const driver = loadApp(), { app, document } = driver;
  app.world.vehicles = [];
  const exit = app.road.getState(0).nextExit;
  Object.assign(app.car, { x: 3.75, y: exit.entryStart - 500 });
  app.state.laneTarget = 2;
  startAutomatic(driver);
  driver.advance(.5);
  const before = { x: app.car.x, y: app.car.y, speed: app.car.speed };
  document.querySelectorAll('[data-auto-route]').find(button => button.dataset.autoRoute === 'exit').onclick();
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.autodrive.route, 'exit');
  assert.equal(app.car.x, before.x);
  assert.equal(app.car.y, before.y);
  assert.equal(app.car.speed, before.speed);
  advanceUntil(driver, () => app.state.plan.status === 'handoff', 30, .1);
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.autodrive.active, false);
  assert.equal(app.state.lastInput.brake, 0);
  assert.equal(app.state.estop, false);
});

test('automatic driving on an ordinary road never changes into the opposing lane', () => {
  const driver = localRoadAutodrive(), { app, ui } = driver;
  startAutomatic(driver);
  assert.equal(app.state.exitCruise, false);
  driver.advance(5);
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.state.entranceActive, null, 'automatic city cruising does not commit a highway entrance');
  assert.equal(ui('lane-right').disabled, true);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.autodrive.decision.laneDirection, 0);
  assert.ok(Math.abs(app.car.x - 29) < 0.1);
  assert.equal(app.state.autodrive.active, true);
});

test('manual takeover, stopping, faults, new commands and reset relinquish autonomous driving', () => {
  const interruptions = [
    ['throttle key', driver => driver.key('keydown', 'KeyW'), false],
    ['throttle touch', driver => driver.document.querySelectorAll('[data-drive]').find(button => button.dataset.drive === 'throttle')
      .onpointerdown({ button: 0, pointerId: 7, preventDefault() {} }), false],
    ['lane key', driver => driver.key('keydown', 'KeyA'), false],
    ['brake key', driver => driver.key('keydown', 'KeyS'), true],
    ['manual tab', driver => driver.ui('manual-tab').onclick(), true],
    ['AI task tab', driver => driver.ui('ai-tab').onclick(), true],
    ['auto stop', driver => driver.ui('auto-stop').onclick(), true],
    ['normal stop', driver => driver.ui('normal-stop').onclick(), true],
    ['AI stop command', driver => driver.app.submitCommand('停车'), true],
    ['emergency stop', driver => driver.ui('emergency-stop').onclick(), true],
    ['lost focus', driver => driver.dispatch('blur'), true],
    ['lost connection', driver => driver.ui('toggle-connection').onclick(), true],
    ['lost camera', driver => driver.dispatch('rover-camera-lost'), true],
    ['new task', driver => driver.app.submitCommand('前进20米'), true],
    ['reset', driver => driver.ui('reset-session').onclick(), false]
  ];
  for (const [name, interrupt, braking] of interruptions) {
    const driver = loadApp(), { app } = driver;
    app.world.vehicles = [];
    startAutomatic(driver);
    driver.advance(2);
    assert.ok(app.car.speed > 0);
    interrupt(driver);
    assert.equal(app.state.autodrive.active, false, name);
    assert.equal(app.state.exitCruise, false, name);
    driver.advance(0.1);
    assert.equal(app.state.lastInput.brake > 0, braking, name);
    if (braking) {
      advanceUntil(driver, () => app.car.speed === 0, 8);
      if (name === 'emergency stop') driver.ui('reset-estop').onclick();
      driver.advance(1);
      assert.equal(app.car.speed, 0, name + ' must not silently restart autonomy');
      assert.equal(app.state.autodrive.active, false);
    }
    if (name === 'reset') {
      assert.equal(app.car.speed, 0);
      assert.equal(app.state.autodrive.decision, null);
      assert.equal(app.state.autodrive.nextLaneCheck, 0);
      assert.equal(app.readState().roadType, 'highway');
    }
  }
});

test('automatic startup cannot override an emergency lock or drive out of the emergency shoulder', () => {
  for (const shoulder of [false, true]) {
    const driver = loadApp(), { app, ui } = driver;
    app.world.vehicles = [];
    if (shoulder) {
      app.car.x = 7.125;
      app.state.laneTarget = 3;
      app.state.shoulderAlert = true;
    }
    ui('emergency-stop').onclick();
    ui('auto-tab').onclick();
    ui('auto-start').onclick();
    driver.advance(1);
    assert.equal(app.state.autodrive.active, false);
    assert.equal(app.car.speed, 0);
    assert.equal(app.state.lastInput.throttle, 0);
    ui('reset-estop').onclick();
    driver.advance(1);
    assert.equal(app.state.autodrive.active, false, 'releasing emergency stop never resumes automatic control');
    assert.equal(app.car.speed, 0);
  }
});

test('highway entrances create real timed arrivals and refresh the roadside preview', () => {
  const driver = loadApp(), { app, ui } = driver;
  const entrance = app.road.getState(0).nextEntrance;
  app.world.vehicles = [];
  app.car.y = entrance.start - 200;
  driver.advance(0.1);
  assert.equal(ui('entrance-preview').hidden, false);
  assert.equal(ui('entrance-name').textContent, entrance.name);
  assert.match(ui('entrance-detail').textContent, /前方 390 m/);
  assert.match(ui('entrance-status').textContent, /沿入口匝道接近/);
  const first = app.world.vehicles.find(vehicle => vehicle.fromEntrance);
  assert.ok(first && first.x > 8.625, 'an arrival starts outside the motorway, on the feeder');
  driver.advance(32);
  assert.ok(app.readState().merging.arrivals >= 2, 'traffic keeps entering in separate timed waves');
  assert.ok(app.readState().merging.completed >= 1, 'a clear ramp joins the live right lane');
  assert.equal(first.lane, 2);
  assert.equal(first.x, 3.75);
  assert.equal(app.state.collision, null);
  app.car.y = entrance.end + 1;
  app.render();
  assert.notEqual(ui('entrance-name').textContent, entrance.name, 'passing one entrance previews the next');
});

test('an entrance queue freezes on collision and restarting clears its vehicles and counters', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  app.car.y = app.road.getState(0).nextEntrance.start - 200;
  driver.advance(0.1);
  assert.equal(app.readState().merging.activeCount, 1);
  Object.assign(app.car, { x:-6.44, heading:-15, speed:30 });
  app.state.laneTarget = 0;
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.3);
  assert.equal(app.state.collision.kind, 'guardrail');
  assert.match(ui('entrance-status').textContent, /本局已结束/);
  const frozen = JSON.stringify(app.world);
  driver.advance(30);
  assert.equal(JSON.stringify(app.world), frozen);
  ui('collision-restart').onclick();
  const snapshot = app.readState().merging;
  assert.equal(snapshot.arrivals, 0);
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.activeCount, 0);
  assert.ok(app.world.vehicles.every(vehicle => !vehicle.fromEntrance));
  assert.equal(app.car.y, 0);
  assert.equal(app.car.speed, 0);
});

test('a manual ramp hides highway notices and the city road shows a manual route back to the highway', () => {
  const driver = enterManualExit(), { app, ui } = driver;
  driver.key('keydown', 'KeyW');
  advanceUntil(driver, () => app.state.exitStage === 'ramp', 60, .1);
  assert.equal(ui('entrance-preview').hidden, true);
  advanceUntil(driver, () => app.state.exitCompleted, 120, .1);
  assert.equal(ui('entrance-preview').hidden, false);
  assert.match(ui('entrance-name').textContent, /返回高速/);
  assert.match(ui('entrance-status').textContent, /左|入口/);
  driver.advance(30);
  assert.ok(app.car.y > app.road.getState(0).nextEntrance.start);
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.readState().merging.arrivals, 0);
  assert.equal(app.readState().merging.activeCount, 0);
});

test('collision animation advances its visual clock while the impact and traffic stay frozen', () => {
  const driver=loadApp(),{app,ui,drawn}=driver;
  app.state.map=true;ui('map-view').hidden=false;
  causeVehicleCollision(driver,{seconds:.05});
  assert.equal(app.state.map,false,'a collision must be visible even when the map was selected');
  assert.equal(ui('map-view').hidden,true);
  assert.equal(app.readState().collisionAnimation.active,true);
  assert.ok(!ui('collision-dialog').open);
  const frozen=JSON.stringify({car:app.car,world:app.world,collision:app.state.collision});
  driver.frame(.12);
  assert.ok(drawn.at(-1).collisionEffect.elapsed>0);
  assert.ok(drawn.at(-1).collisionEffect.elapsed<drawn.at(-1).collisionEffect.duration);
  driver.key('keydown','KeyW');driver.key('keydown','ArrowRight');
  assert.equal(app.state.controls.size,0);
  let shows=0;
  ui('collision-dialog').showModal=function(){
    shows++;this.open=true;
    const effect=drawn.at(-1).collisionEffect;
    assert.equal(effect.elapsed,effect.duration,'the settled frame is drawn before the modal');
  };
  driver.frame(app.state.collisionEffect.duration);
  assert.equal(ui('collision-dialog').open,true);
  assert.equal(app.readState().collisionAnimation.active,false);
  assert.equal(JSON.stringify({car:app.car,world:app.world,collision:app.state.collision}),frozen);
  driver.frame(1);
  assert.equal(shows,1,'completed frames do not reopen the modal repeatedly');
});

test('every collision lifts the whole car clearly while stronger impacts stay bounded', () => {
  const gentle=loadApp(),strong=loadApp(),reverse=loadApp();
  causeVehicleCollision(gentle,{speed:3});
  causeVehicleCollision(strong,{speed:33});
  causeVehicleCollision(reverse,{reverse:true});
  assert.ok(gentle.app.state.collisionEffect.peakHeight<strong.app.state.collisionEffect.peakHeight);
  for(const driver of [gentle,strong,reverse]){
    const effect=driver.app.state.collisionEffect;
    assert.ok(effect.peakHeight>=1.8&&effect.peakHeight<=3.8);
    assert.ok(effect.flightTime>=1.2&&effect.flightTime<=1.8);
    assert.ok(effect.duration>effect.flightTime+effect.slideTime&&effect.duration<4.7);
    assert.ok(Math.abs(effect.pitchDeg)<=12&&Math.abs(effect.rollDeg)<=9);
  }
  assert.ok(reverse.app.state.collisionEffect.pitchDeg<0);
  assert.equal(reverse.app.state.collisionEffect.travelHeading,180);
  assert.equal(reverse.app.state.collisionEffect.impactEnd,'rear');
  assert.equal(strong.app.state.collisionEffect.travelHeading,0);
  assert.equal(strong.app.state.collisionEffect.impactEnd,'front');
  assert.ok(gentle.app.state.collisionEffect.launchSpeed<strong.app.state.collisionEffect.launchSpeed);
  assert.ok(strong.app.state.collisionEffect.launchSpeed<=18);
});

test('centred vehicle collisions tumble over the struck end in forward and reverse gear', () => {
  for(const reverse of [false,true]){
    const driver=loadApp();
    causeVehicleCollision(driver,{reverse});
    const effect=driver.app.state.collisionEffect;
    assert.equal(effect.tumbleAxis,'pitch');
    assert.equal(Math.sign(effect.tumbleRateDeg),reverse?1:-1,
      'front and rear impacts need opposite pitch directions');
    assert.equal(effect.impactEnd,reverse?'rear':'front');
    assert.equal(effect.travelHeading,reverse?180:0,
      'tumbling does not reverse the existing horizontal launch direction');
    assert.equal(driver.app.readState().collisionAnimation.tumbleRateDeg,effect.tumbleRateDeg);
    assert.equal(driver.drawn.at(-1).collisionEffect.tumbleAxis,effect.tumbleAxis);
    assert.equal(driver.drawn.at(-1).collisionEffect.tumbleRateDeg,effect.tumbleRateDeg);
  }
});

test('left and right guardrails generate opposite rolls away from the contacted side', () => {
  const effects=[];
  for(const direction of [-1,1]){
    const driver=loadApp(),{app}=driver;
    app.world.vehicles=[];
    Object.assign(app.car,{x:direction<0?-6.44:7.94,heading:direction*15,speed:30});
    app.state.laneTarget=direction<0?0:3;
    driver.key('keydown','ArrowUp');
    driver.advance(.3);
    assert.equal(app.state.collision?.kind,'guardrail','the fixture must hit a real guardrail');
    const effect=app.state.collisionEffect;
    assert.equal(effect.tumbleAxis,'roll');
    assert.equal(Math.sign(effect.tumbleRateDeg),direction);
    effects.push(effect);
  }
  assert.ok(effects[0].tumbleRateDeg*effects[1].tumbleRateDeg<0);
});

test('off-centre vehicle impacts switch to side rolls for either contacted side and gear', () => {
  for(const reverse of [false,true]){
    for(const offsetX of [-1.1,1.1]){
      const driver=loadApp();
      causeVehicleCollision(driver,{reverse,offsetX});
      const effect=driver.app.state.collisionEffect;
      assert.equal(effect.tumbleAxis,'roll','an eccentric contact must visibly differ from a centred pitch');
      assert.equal(Math.sign(effect.tumbleRateDeg),Math.sign(offsetX),
        'the struck side determines roll direction even while reversing');
      assert.equal(effect.impactEnd,reverse?'rear':'front');
    }
  }
});

test('stronger collisions increase tumble angular speed within a bounded visual envelope', () => {
  const magnitudes=[];
  for(const speed of [3,15,33,100]){
    const driver=loadApp();
    causeVehicleCollision(driver,{speed});
    const effect=driver.app.state.collisionEffect;
    const magnitude=Math.abs(effect.tumbleRateDeg);
    assert.ok(Number.isFinite(magnitude)&&magnitude>=150&&magnitude<=260,
      'even the 100 m/s maximum must retain a finite bounded angular speed');
    assert.equal(effect.tumbleAxis,'pitch');
    assert.ok(effect.tumbleRateDeg<0);
    magnitudes.push(magnitude);
  }
  assert.ok(magnitudes[0]<magnitudes[1]&&magnitudes[1]<magnitudes[2],
    'impact strength must affect the visible spin instead of using one animation for all speeds');
  assert.ok(magnitudes[3]>=magnitudes[2]);
});

test('collision phases show forward flight, landing slide and wreck smoke before the restart dialog', () => {
  const driver=loadApp(),{app,ui}=driver;
  causeVehicleCollision(driver,{seconds:.05});
  const effect=app.state.collisionEffect;
  const frozen=JSON.stringify({car:app.car,world:app.world});
  assert.match(ui('camera-status').textContent,/腾空前冲/);
  driver.advance(effect.flightTime-effect.elapsed+.05);
  assert.match(ui('camera-status').textContent,/落地滑行/);
  assert.ok(!ui('collision-dialog').open);
  driver.advance(effect.flightTime+effect.slideTime-effect.elapsed+.05);
  assert.match(ui('camera-status').textContent,/受损冒烟/);
  assert.ok(!ui('collision-dialog').open,'smoke gets a visible dwell before the modal');
  driver.advance(effect.duration-effect.elapsed+.05);
  assert.equal(ui('collision-dialog').open,true);
  assert.match(ui('camera-status').textContent,/车辆受损/);
  assert.equal(JSON.stringify({car:app.car,world:app.world}),frozen);
});

test('reduced motion renders a static collision result immediately', () => {
  const driver=loadApp({matchMedia:query=>({matches:query==='(prefers-reduced-motion: reduce)'})});
  causeVehicleCollision(driver,{seconds:.05});
  assert.equal(driver.ui('collision-dialog').open,true);
  assert.equal(driver.app.readState().collisionAnimation.active,false);
  assert.equal(driver.drawn.at(-1).collisionEffect.reducedMotion,true);
});

test('backgrounding and losing the camera during a hop always expose restart without advancing physics', () => {
  for(const interruption of ['visibilitychange','pagehide','rover-camera-lost']){
    const driver=loadApp();causeVehicleCollision(driver,{seconds:.05});
    const frozen=JSON.stringify({car:driver.app.car,world:driver.app.world});
    if(interruption==='visibilitychange'){
      driver.document.hidden=true;driver.document.dispatch(interruption);
    }else driver.dispatch(interruption);
    assert.equal(driver.ui('collision-dialog').open,true,interruption);
    assert.equal(driver.app.readState().collisionAnimation.active,false);
    assert.equal(JSON.stringify({car:driver.app.car,world:driver.app.world}),frozen);
  }
});

test('failed animation frames do not leave a collision without a restart dialog', () => {
  for(const throwing of [false,true]){
    const driver=loadApp({RoverSimulator:{createCamera(){return {
      stats:{fps:30,frames:0,backend:'test camera'},pause(){},
      draw(){if(throwing)throw new Error('expected test camera failure');return false;}
    };}}});
    causeVehicleCollision(driver,{seconds:.05});
    driver.frame(.12);
    assert.equal(driver.ui('collision-dialog').open,true);
    assert.equal(driver.app.readState().collisionAnimation.active,false);
  }
});

test('resetting during a collision animation clears the visual effect and cannot reopen an old result', () => {
  const driver=loadApp();causeVehicleCollision(driver,{seconds:.05});
  driver.ui('reset-session').onclick();
  driver.frame(3);
  assert.equal(driver.app.state.collision,null);
  assert.equal(driver.app.state.collisionEffect,null);
  assert.ok(!driver.ui('collision-dialog').open);
  assert.equal(driver.app.car.speed,0);
  assert.equal(driver.ui('camera-panel').classList.contains('collision-animating'),false);
});

test('returning from background and resizing redraw the landed collision pose', () => {
  const driver=loadApp();causeVehicleCollision(driver,{seconds:.05});driver.frame(.1);
  const airborne=driver.drawn.at(-1).collisionEffect;
  assert.ok(airborne.elapsed<airborne.flightTime);
  driver.document.hidden=true;driver.document.dispatch('visibilitychange');
  driver.document.hidden=false;driver.document.dispatch('visibilitychange');driver.frame(.1);
  assert.equal(driver.drawn.at(-1).collisionEffect.elapsed,driver.app.state.collisionEffect.duration);
  const frames=driver.drawn.length;
  driver.dispatch('resize');driver.frame(.1);
  assert.equal(driver.drawn.length,frames+1);
  assert.equal(driver.drawn.at(-1).collisionEffect.elapsed,driver.app.state.collisionEffect.duration);
});

test('replaying the short collision animation keeps the world frozen and returns to the restart dialog', () => {
  const driver=loadApp();causeVehicleCollision(driver);
  const frozen=JSON.stringify({car:driver.app.car,world:driver.app.world});
  const effect=driver.app.state.collisionEffect;
  const parameters=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='elapsed')));
  const originalParameters=parameters(effect);
  assert.ok(Math.abs(effect.tumbleRateDeg)>0);
  driver.ui('collision-replay').onclick();
  driver.ui('collision-dialog').onclose();
  assert.ok(!driver.ui('collision-dialog').open);
  assert.equal(driver.app.readState().collisionAnimation.active,true);
  assert.equal(driver.app.state.collisionEffect.elapsed,0);
  assert.equal(parameters(driver.app.state.collisionEffect),originalParameters,
    'replay reuses the original impact, rotation and flight parameters');
  driver.frame(.15);
  assert.ok(driver.drawn.at(-1).collisionEffect.elapsed>0);
  assert.equal(parameters(driver.drawn.at(-1).collisionEffect),originalParameters,
    'the renderer receives the same tumble parameters while the replay clock advances');
  assert.equal(JSON.stringify({car:driver.app.car,world:driver.app.world}),frozen);
  driver.frame(driver.app.state.collisionEffect.duration);
  assert.equal(driver.ui('collision-dialog').open,true);
  assert.equal(JSON.stringify({car:driver.app.car,world:driver.app.world}),frozen);
  assert.equal(parameters(driver.app.state.collisionEffect),originalParameters);
  driver.ui('collision-restart').onclick();
  assert.equal(driver.app.state.collisionEffect,null);
  assert.equal(driver.app.car.speed,0);
  assert.equal(driver.app.readState().collisionAnimation,null);
  driver.frame(effect.duration);
  assert.equal(driver.app.state.collisionEffect,null,'an old tumble cannot resume after restarting');
  assert.equal(driver.app.car.speed,0);
  causeVehicleCollision(driver,{reverse:true});
  assert.equal(driver.app.state.collisionEffect.tumbleAxis,'pitch');
  assert.ok(driver.app.state.collisionEffect.tumbleRateDeg>0,
    'a subsequent reverse collision generates its own direction instead of reusing the previous tumble');
});

test('exit traffic is selected from ordinary right-lane cars and the card follows real route phases', () => {
  const driver=loadApp(),{app,ui}=driver;
  Object.assign(app.car,{y:900,x:0,speed:0});
  app.world.vehicles=Array.from({length:8},(_,index)=>adviceVehicle(2,660+index*45,12,700+index));
  driver.advance(.1);
  const selected=app.readState().exiting;
  assert.ok(selected.activeCount>0&&selected.activeCount<8);
  assert.match(ui('exit-traffic-status').textContent,/减速准备驶离/);
  assert.equal(ui('exit-traffic-status').hidden,false);
  advanceUntil(driver,()=>app.readState().exiting.list.some(vehicle=>vehicle.status==='ramp'),45,.25);
  assert.match(ui('exit-traffic-status').textContent,/沿匝道驶离/);
  const exiting=app.world.vehicles.find(vehicle=>vehicle.exitRoute?.status==='ramp');
  driver.advance(4);
  assert.ok(exiting.x>3.75&&exiting.y>exiting.exitRoute.event.entryStart,'the card describes real curved travel');
  assert.equal(app.car.x,0);assert.equal(app.car.y,900);
  ui('reset-session').onclick();
  assert.equal(app.readState().exiting.activeCount,0);
  assert.equal(app.readState().exiting.completed,0);
  assert.match(ui('exit-traffic-status').textContent,/部分右车道车辆/);
});

test('AI tasks and full automatic driving cannot take over the manual deceleration lane or ramp', () => {
  const driver = enterManualExit(), { app, ui } = driver;
  for (const stage of ['deceleration', 'ramp']) {
    assert.equal(app.state.exitStage, stage);
    assert.equal(app.submitCommand('直行20米').status, 'ready');
    assert.equal(app.startPlan(), false, stage + ' cannot automatically accelerate or brake into the exit');
    ui('auto-start').onclick();
    assert.equal(app.state.autodrive.active, false);
    assert.equal(app.state.plan.status, 'ready');
    assert.equal(app.state.serviceBrake, 0);
    assert.equal(app.state.exitCruise, false);
    if (stage === 'deceleration') {
      driver.key('keydown', 'KeyW');
      advanceUntil(driver, () => app.state.exitStage === 'ramp', 60, .1);
    }
  }
});

test('following exit traffic onto the ordinary road preserves nearby cars without a transition teleport', () => {
  const driver=enterManualExit(),{app,ui}=driver,exit=app.state.exitActive;
  Object.assign(app.car,{x:29,y:exit.rampEnd-.04,speed:10,heading:0});
  app.state.exitStage='ramp';
  driver.key('keydown','KeyW');
  const leader=adviceVehicle(2,exit.rampEnd+35,12,999);
  Object.assign(leader,{x:29,exitRoute:{event:exit,status:'local',wet:false}});
  const follower=adviceVehicle(2,exit.rampEnd-40,9,998);
  Object.assign(follower,{x:29,exitRoute:{event:exit,status:'ramp',wet:false}});
  app.world.vehicles=[leader,follower];
  const before=leader.y;
  driver.advance(.1);
  assert.equal(app.state.exitCompleted,true);
  assert.equal(app.readState().roadType,'local');
  assert.equal(app.world.vehicles.find(vehicle=>vehicle.id===999),leader);
  assert.equal(app.world.vehicles.find(vehicle=>vehicle.id===998),follower);
  assert.ok(app.state.highwayTraffic);
  assert.ok(!app.state.highwayTraffic.vehicles.includes(leader));
  assert.ok(!app.state.highwayTraffic.vehicles.includes(follower), 'each transferred NPC belongs to exactly one updating world');
  const allCars = [...app.world.vehicles, ...app.state.highwayTraffic.vehicles];
  assert.equal(new Set(allCars.map(vehicle=>vehicle.id)).size, allCars.length);
  assert.ok(leader.y>before&&leader.y<before+2);
  assert.equal(app.readState().nearestAhead.id,999);
  assert.equal(ui('exit-traffic-status').hidden,true);
  driver.advance(2);
  assert.ok(leader.y>before+10);
  assert.equal(app.state.collision,null);
});


test('a later highway exit arrival joins city following exactly once and stops behind a city queue', () => {
  const driver = localRoadManual(), { app } = driver;
  driver.key('keyup', 'KeyW');
  app.car.speed = 0;
  const exit = app.state.exitActive;
  const leader = { ...adviceVehicle(0, app.car.y + 100, 0, 9101), x: 29,
    previousX: 29, cruiseFactor: 0 };
  const arriving = { ...adviceVehicle(2, app.car.y + 70, 12, 9102), x: 29,
    previousX: 29, cruiseFactor: 1, exitRoute: { event: exit, status: 'local', wet: false } };
  app.world.vehicles = [leader];
  app.state.highwayTraffic.vehicles = [arriving];
  const initialY = arriving.y;
  driver.advance(.05);
  assert.ok(app.world.vehicles.includes(arriving), 'late departures enter the same city following calculation');
  assert.ok(!app.state.highwayTraffic.vehicles.includes(arriving));
  assert.equal(app.world.vehicles.filter(vehicle => vehicle === arriving).length, 1);
  assert.ok(arriving.y > initialY && arriving.y - initialY < 1, 'handoff keeps the existing physical pose');
  const clearance = (leader.length + arriving.length) / 2 + app.traffic.constants.minGap;
  for (let tick = 0; tick < 160; tick++) {
    driver.advance(.05);
    assert.ok(leader.y - arriving.y >= clearance - .01, 'two worlds must not allow their cars to pass through each other');
    assert.equal(app.state.collision, null);
  }
  assert.ok(arriving.speed < .2);
  const stoppedY = arriving.y;
  app.world.vehicles = app.world.vehicles.filter(vehicle => vehicle !== leader);
  driver.advance(3);
  assert.ok(arriving.y > stoppedY + 1 && arriving.speed > 1, 'the transferred arrival resumes when the city queue clears');
  assert.ok(!app.state.highwayTraffic.vehicles.includes(arriving));
});
