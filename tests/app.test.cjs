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
      closest() { return null; },
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
  for (const name of ['physics.js', 'traffic.js', 'lane-control.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(dist, name), 'utf8'), context, { filename: name });
  }
  // Lexical bindings are exposed only in this VM; production needs no hook.
  const app = vm.runInContext(`({
    get car() { return car; }, get state() { return state; },
    get world() { return trafficWorld; },
    advanceElapsed, render, readState
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
    key(type, code, repeat = false) {
      const event = {
        code, key: code, target: document.body, repeat, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      };
      for (const callback of listeners.get(type) || []) callback(event);
      return event;
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
  for (const [boundary, previous, next] of [[1000, 120, 100], [2000, 100, 80], [3000, 80, 120]]) {
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
    Object.assign(app.car, { x: 0, y: 999.9, speed: 120 / 3.6 });
    driver.advance(0.1);
    assert.ok(app.car.speed > 100 / 3.6);
    assert.ok(app.state.lastInput.brake > 0);
    const firstSpeed = app.car.speed;
    driver.advance(15);
    assert.ok(app.car.speed < firstSpeed && app.car.speed <= 100 / 3.6);
    assert.ok(app.car.speed > 20, 'automatic limit braking must not continue to zero');
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
  assert.match(ui('next-road-limit').textContent, /倒车方向 9\d\d m · 限速 100/);
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

function advanceUntil(driver, predicate, timeout = 20) {
  for (let elapsed = 0; elapsed < timeout && !predicate(); elapsed += 0.05) driver.advance(0.05);
  assert.ok(predicate(), `simulation must reach the requested state within ${timeout} seconds`);
}

function headingError(car) {
  return Math.abs((car.heading + 180) % 360 - 180);
}

function enterEmergencyShoulder(driver) {
  const { app, ui } = driver;
  app.world.vehicles = [];
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
