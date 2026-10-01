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
    }
  };
}

function loadApp() {
  const document = createDOM();
  const listeners = new Map();
  let now = 0, timer = 0;
  const window = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    RoverSimulator: {
      createCamera(canvas) {
        assert.equal(canvas.tagName, 'CANVAS');
        return { stats: { fps: 30, frames: 0, backend: 'test camera' }, pause() {}, draw() { return true; } };
      }
    }
  };
  const context = vm.createContext({
    window, document, console, performance: { now: () => now },
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
    advanceElapsed, render, readState, parseCommand, submitCommand, startPlan, requestExit
  })`, context);
  const ui = id => {
    const node = document.getElementById(id);
    assert.ok(node, `real HTML must contain #${id}`);
    return node;
  };
  return {
    app, document, ui,
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

test('a left guardrail contact alone does not emergency brake and lane assistance recovers', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: -6.44, heading: -15, speed: 30 });
  app.state.laneTarget = 0;
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.3);
  assert.ok(app.car.wallContactCount > 0);
  assert.equal(app.state.estop, false);
  assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
  driver.advance(10);
  assert.ok(Math.abs(app.car.x + 3.75) < 0.08);
  assert.equal(app.car.wallContact, null);
  assertNoAutomaticBrake(app);
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

test('real traffic contact loses speed but retains the held throttle and available controls', () => {
  const driver = loadApp(), { app } = driver;
  const leader = app.world.vehicles.find(v => v.lane === 1 && v.y > 0);
  Object.assign(app.car, { x: 0, y: leader.y - 5, speed: 33 });
  driver.setTarget(100);
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.5);
  assert.ok(app.world.contacts > 0);
  assert.ok(app.car.speed > 0 && app.car.speed < 33);
  assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
  assert.equal(app.state.lastInput.throttle, 1);
  assertNoAutomaticBrake(app);
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
  // solid-line permissions have their own integration tests below.
  app.car.y = 900;
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

test('exit selection requires the right lane, forward gear and the actual entry approach', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  app.car.y = 900;
  assert.equal(app.requestExit(), false, 'an exit cannot be selected from the middle lane');
  assert.equal(app.state.exitActive, null);
  assert.match(ui('toast').textContent, /右车道/);
  app.car.x = 3.75;
  app.state.laneTarget = 2;
  app.car.y = 700;
  assert.equal(app.requestExit(), false, 'the exit must first enter its approach window');
  app.car.y = 900;
  app.car.gear = app.state.requestedGear = 'reverse';
  assert.equal(app.requestExit(), false);
  assert.match(ui('toast').textContent, /前进挡/);
  app.car.gear = app.state.requestedGear = 'forward';
  app.render();
  assert.equal(ui('exit-action').disabled, false);
  ui('exit-action').onclick();
  assert.equal(app.state.exitActive.id, 'exit-0');
  assert.equal(app.state.exitCompleted, false);
  assert.match(ui('exit-action').textContent, /取消/);
  ui('exit-action').onclick();
  assert.equal(app.state.exitActive, null, 'the route may still be cancelled before the entry');
  app.car.y = 1341;
  assert.equal(app.requestExit(), false, 'missing the entry must not steer backward into it');
  assert.equal(app.state.exitActive, null);
});

test('an accepted exit slows physically on the ramp and continuously joins the ordinary road without braking', () => {
  const driver = loadApp(), { app, ui } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: 900, speed: 20 });
  app.state.laneTarget = 2;
  driver.setTarget(30);
  driver.key('keydown', 'KeyW');
  app.render();
  assert.equal(app.readState().roadType, 'highway');
  ui('exit-action').onclick();
  const exit = app.state.exitActive;
  assert.ok(exit && exit.entryStart === 1080 && exit.rampEnd === 1850);
  assert.equal(app.readState().roadType, 'ramp');
  driver.advance(0.1);
  assert.ok(app.car.speed < 20 && app.car.speed > 19, 'the ramp cap applies braking without assigning the capped velocity');
  assert.equal(app.state.lastInput.targetSpeed, 40 / 3.6);
  assert.ok(app.state.lastInput.brake > 0);
  assert.equal(app.state.estop, false);
  assert.match(ui('road-rule-title').textContent, /40 km\/h/);
  advanceUntil(driver, () => app.car.y > 1200, 50, 0.25);
  assert.ok(app.car.speed <= 40 / 3.6 + 0.02);
  assert.ok(app.car.x > 5.625, 'the exit route must actually leave the normal highway lanes');
  assert.equal(app.state.shoulderAlert, false, 'a selected ramp must not be treated as an illegal shoulder entry');
  assert.equal(app.state.estop, false);
  assert.equal(ui('exit-action').disabled, true, 'the route is committed after the entry');
  const routeId = app.state.exitActive.id;
  ui('exit-action').onclick();
  assert.equal(app.state.exitActive.id, routeId);
  ui('lane-left').onclick();
  assert.equal(app.state.laneTarget, 2, 'ordinary lane changes must not redirect an active ramp route');
  advanceUntil(driver, () => app.car.y >= exit.rampEnd - 5, 100, 0.1);
  let previous = { ...app.car };
  for (let step = 0; step < 120 && !app.state.exitCompleted; step++) {
    driver.advance(1 / 120);
    assert.ok(app.car.y > previous.y && app.car.y - previous.y < 0.15, 'road transition keeps continuous position');
    assert.ok(Math.abs(app.car.x - previous.x) < 0.01);
    assert.ok(Math.abs(app.car.speed - previous.speed) < 0.1, 'road transition keeps continuous velocity');
    assert.equal(app.state.lastInput.brake, 0);
    previous = { ...app.car };
  }
  assert.equal(app.state.exitCompleted, true);
  app.world.vehicles = [];
  assert.equal(app.readState().roadType, 'local');
  assert.ok(app.car.speed > 10);
  assert.equal(app.state.controls.get('kKeyW'), 'throttle', 'the transition retains a held manual throttle');
  assert.equal(app.state.serviceBrake, 0);
  assert.equal(app.state.exitCruise, false, 'manual driving must not create an AI cruise latch');
  assert.equal(app.readState().roadLimitKmh, 50);
  assert.ok(Math.abs(app.car.x - 29) < 0.5);
  assert.equal(app.state.estop, false);
  assert.equal(app.state.shoulderAlert, false);
  assert.match(ui('road-rule-title').textContent, /普通道路|普通公路/);
  assert.doesNotMatch(ui('exit-detail').textContent, /正在停车|已停稳/);
  driver.advance(5);
  const coastStart = { y: app.car.y, speed: app.car.speed };
  driver.key('keyup', 'KeyW');
  driver.advance(3);
  assert.ok(app.car.y > coastStart.y && app.car.speed < coastStart.speed && app.car.speed > 0);
  assert.equal(app.state.lastInput.throttle, 0);
  assert.equal(app.state.lastInput.brake, 0);
  ui('reset-session').onclick();
  assert.equal(app.state.exitActive, null);
  assert.equal(app.state.exitCompleted, false);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.car.y, 0);
  assert.equal(app.car.x, 0);
  assert.equal(app.readState().roadType, 'highway');
});

test('a compound AI plan exits, drives another 300 meters on the ordinary road and physically parks', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: 900 });
  app.state.laneTarget = 2;
  driver.setTarget(20);
  stageAndStart(driver, '直行10米，然后从下一个出口驶离，再直行300米，最后停车');
  assert.deepEqual(Array.from(app.state.plan.steps, step => step.type), ['drive', 'exit', 'drive', 'brake']);
  advanceUntil(driver, () => !!app.state.exitActive, 15);
  assert.equal(app.state.plan.status, 'running');
  assert.equal(app.state.plan.phase, 1);
  assert.equal(app.state.exitActive.id, 'exit-0');
  advanceUntil(driver, () => app.state.exitCompleted, 120, 0.25);
  assert.ok(app.car.speed > 0);
  assert.equal(app.state.plan.status, 'running');
  assert.equal(app.state.plan.phase, 2, 'the next drive starts when the car reaches the ordinary road');
  assert.equal(app.state.exitCruise, false, 'an unfinished compound plan retains control of its own next step');
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.state.lastInput.brake, 0);
  const localStartDistance = app.state.plan.stepDistance;
  advanceUntil(driver, () => app.state.plan.status === 'completed', 50, 0.1);
  assert.equal(app.car.speed, 0);
  assert.ok(app.car.x > 28 && app.car.y >= 2150);
  assert.ok(app.car.distance - localStartDistance >= 300 && app.car.distance - localStartDistance < 330);
  assert.ok(app.car.lastBrakeDistance > 0);
  assert.equal(app.state.estop, false);
  assert.equal(app.state.shoulderAlert, false);
  assert.equal(app.state.exitCruise, false);
});

// The complete geometry is exercised above. These fixtures place a selected
// exit just before its endpoint to isolate cruise handoff and interruption.
function localRoadCruise() {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: 900, speed: 40 / 3.6 });
  app.state.laneTarget = 2;
  driver.setTarget(30);
  assert.equal(app.requestExit(), true);
  Object.assign(app.car, { x: 29, y: app.state.exitActive.rampEnd - 0.2, heading: 0, steer: 0 });
  stageAndStart(driver, '从下一个出口驶离');
  advanceUntil(driver, () => app.state.plan.status === 'completed', 2);
  // Joining the ordinary road intentionally creates its own traffic world.
  // Keep these controller tests isolated from independently tested following.
  app.world.vehicles = [];
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.state.exitCruise, true);
  assert.ok(app.car.speed > 0);
  return driver;
}

test('a final AI exit step hands off to continuous ordinary-road cruising for several kilometers', () => {
  const driver = localRoadCruise(), { app } = driver;
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
    assert.equal(app.state.plan.status, 'completed');
    assert.equal(app.state.exitCruise, true);
    assert.equal(app.state.lastInput.throttle, 1);
    assert.equal(app.state.lastInput.brake, 0);
    assert.equal(app.state.estop, false);
  }
  assert.ok(app.car.y - initialY > 4000);
  assert.ok(app.car.distance - initialDistance > 4000);
});

test('ordinary-road overspeed braking reduces speed physically to 50 km/h and then resumes cruise', () => {
  const driver = localRoadCruise(), { app, ui } = driver;
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
  assert.equal(app.state.exitCruise, true);
  assert.equal(app.state.estop, false);
});

test('manual shortcuts, requested braking and focus loss all cancel automatic exit cruise', () => {
  const interruptions = [
    ['manual throttle', driver => driver.key('keydown', 'KeyW'), false],
    ['manual lane shortcut', driver => driver.key('keydown', 'KeyA'), false],
    ['manual brake', driver => driver.key('keydown', 'KeyS'), true],
    ['normal stop', driver => driver.ui('normal-stop').onclick(), true],
    ['keyboard stop', driver => driver.key('keydown', 'Space'), true],
    ['focus loss', driver => driver.dispatch('blur'), true]
  ];
  for (const [name, interrupt, braking] of interruptions) {
    const driver = localRoadCruise(), { app } = driver;
    interrupt(driver);
    assert.equal(app.state.exitCruise, false, name);
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
      assert.equal(app.state.laneTarget, 2, 'taking over does not steer into the opposing ordinary-road lane');
    }
    assert.equal(app.readState().roadType, 'local', name);
  }
});

test('the one-lane ordinary road rejects cross-direction lane changes and permits a new speed-drive-stop task', () => {
  const driver = localRoadCruise(), { app, ui } = driver;
  const positionX = app.car.x;
  assert.equal(ui('lane-left').disabled, true);
  assert.equal(ui('lane-right').disabled, true);
  for (const direction of ['left', 'right']) ui('lane-' + direction).onclick();
  assert.equal(app.state.laneTarget, 2);
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
  const driver = localRoadCruise(), { app, ui } = driver;
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
  const cruising = localRoadCruise();
  assert.equal(cruising.app.state.exitCruise, true);
  cruising.ui('reset-session').onclick();
  assert.equal(cruising.app.state.exitCruise, false, 'reset also clears a currently active cruise latch');
  assert.equal(cruising.app.state.exitActive, null);
  assert.equal(cruising.app.readState().roadType, 'highway');
  cruising.advance(1);
  assert.equal(cruising.app.car.speed, 0);
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

test('the automatic exit route keeps driving after joining the ordinary road without a second cruise owner', () => {
  const driver = loadApp(), { app } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: 900 });
  app.state.laneTarget = 2;
  driver.setTarget(5);
  startAutomatic(driver, 'exit');
  assert.equal(app.state.speedLimit, 5, 'the automatic exit plan also keeps the manual speed setting independent');
  advanceUntil(driver, () => !!app.state.exitActive, 10);
  assert.equal(app.readState().roadType, 'ramp');
  advanceUntil(driver, () => app.state.exitCompleted, 130, 0.25);
  assert.equal(app.readState().roadType, 'local');
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.exitCruise, false, 'autonomous mode must remain the sole continuous controller');
  assert.equal(app.state.speedLimit, 5);
  assert.ok(app.car.speed > 0);
  app.world.vehicles = [];
  const localY = app.car.y;
  driver.advance(10);
  assert.ok(app.car.y > localY + 100);
  assert.ok(Math.abs(app.car.x - 29) < 0.1);
  assert.ok(app.car.speed <= 50 / 3.6 + 0.01);
  assert.equal(app.state.laneChanging, false);
  assert.equal(app.state.shoulderAlert, false);
  assert.equal(app.state.estop, false);
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

test('changing an active automatic route to the next exit keeps control and starts the selected route', () => {
  const driver = loadApp(), { app, document } = driver;
  app.world.vehicles = [];
  Object.assign(app.car, { x: 3.75, y: 900 });
  app.state.laneTarget = 2;
  startAutomatic(driver);
  driver.advance(0.5);
  const before = { x: app.car.x, y: app.car.y, speed: app.car.speed };
  document.querySelectorAll('[data-auto-route]').find(button => button.dataset.autoRoute === 'exit').onclick();
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.autodrive.route, 'exit');
  assert.equal(app.car.x, before.x);
  assert.equal(app.car.y, before.y);
  assert.equal(app.car.speed, before.speed);
  advanceUntil(driver, () => !!app.state.exitActive, 5);
  assert.equal(app.state.exitActive.id, 'exit-0');
  assert.equal(app.state.autodrive.active, true);
  assert.equal(app.state.exitCruise, false);
  assert.equal(app.state.estop, false);
});

test('automatic driving on an ordinary road never changes into the opposing lane', () => {
  const driver = localRoadCruise(), { app, ui } = driver;
  startAutomatic(driver);
  assert.equal(app.state.exitCruise, false);
  driver.advance(5);
  assert.equal(app.readState().roadType, 'local');
  assert.equal(ui('lane-left').disabled, true);
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
