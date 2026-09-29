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
  for (const name of ['physics.js', 'traffic.js', 'app.js']) {
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
    key(type, code) {
      const event = {
        code, key: code, target: document.body, repeat: false, defaultPrevented: false,
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

test('keyboard driving survives either guardrail contact and steering can leave the rail', () => {
  for (const side of [-1, 1]) {
    const driver = loadApp(), { app, ui } = driver;
    const toward = side < 0 ? 'ArrowLeft' : 'ArrowRight';
    const away = side < 0 ? 'ArrowRight' : 'ArrowLeft';
    Object.assign(app.car, { x: side * 6.35, heading: side * 15, speed: 30 });
    assert.equal(driver.key('keydown', 'ArrowUp').defaultPrevented, true);
    driver.key('keydown', toward);
    driver.advance(0.3);
    assert.equal(app.car.wallContact, side < 0 ? 'left' : 'right');
    assert.equal(app.car.wallContactCount, 1);
    assert.ok(app.car.speed > 28 && app.car.y > 8);
    assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
    assert.equal(app.state.controls.get('k' + toward), side < 0 ? 'left' : 'right');
    assert.equal(app.state.lastInput.throttle, 1);
    assert.equal(ui('braking-hud').hidden, true);
    assert.match(ui('camera-status').textContent, /护栏擦行/);
    assertNoAutomaticBrake(app);

    const distanceAtContact = app.car.distance;
    driver.key('keyup', toward);
    driver.key('keydown', away);
    driver.advance(1);
    assert.equal(app.car.wallContact, null);
    assert.ok(side * app.car.x < 6, 'inward steering must leave the rail');
    assert.ok(app.car.distance > distanceAtContact + 25);
    assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
    assertNoAutomaticBrake(app);

    driver.key('keyup', away);
    driver.key('keyup', 'ArrowUp');
    driver.advance(0.1);
    assert.equal(app.state.controls.size, 0);
    assert.equal(app.state.lastInput.throttle, 0);
    assert.ok(app.car.speed > 0, 'releasing the keys must coast');
    assertNoAutomaticBrake(app);
  }
});

test('road-limit HUD follows zone crossings while overspeed stays advisory', () => {
  const driver = loadApp(), { app, ui, document } = driver;
  driver.setTarget(100);
  driver.key('keydown', 'ArrowUp');
  for (const [boundary, previous, next] of [[1000, 120, 100], [2000, 100, 80], [3000, 80, 120]]) {
    Object.assign(app.car, { x: 6, y: boundary - 0.1, heading: 0, steer: 0, speed: 40 });
    app.render();
    assert.equal(ui('road-limit-sign').textContent, String(previous));
    driver.advance(0.02);
    assert.ok(app.car.y > boundary);
    assert.equal(ui('road-limit-sign').textContent, String(next));
    assert.equal(ui('road-limit-sign').getAttribute('aria-label'), `道路限速${next}公里每小时`);
    assert.match(ui('road-speed-status').textContent, /^超速 /);
    assert.equal(document.querySelector('.road-awareness').classList.contains('overspeed'), true);
    assert.equal(app.readState().roadLimitKmh, next);
    assert.equal(app.readState().overspeed, true);
    assert.equal(app.state.speedLimit, 100, 'posted road limit must not overwrite the manual target');
    assert.equal(app.state.lastInput.targetSpeed, 100);
    assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
    assert.ok(app.car.speed > 40, 'overspeed does not secretly apply brakes');
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
  Object.assign(app.car, { x: 0, y: leader.y - 6.5, speed: 40 });
  driver.setTarget(100);
  driver.key('keydown', 'ArrowUp');
  driver.advance(0.5);
  assert.ok(app.world.contacts > 0);
  assert.ok(app.car.speed > 0 && app.car.speed < 40);
  assert.equal(app.state.controls.get('kArrowUp'), 'throttle');
  assert.equal(app.state.lastInput.throttle, 1);
  assertNoAutomaticBrake(app);
});

test('a 100 m/s AI test limited by real traffic ends after 60 seconds and coasts', () => {
  const driver = loadApp(), { app, ui } = driver;
  ui('ai-tab').onclick();
  ui('command-input').value = '加速到 100 米每秒然后刹车';
  ui('command-form').onsubmit({ preventDefault() {} });
  assert.equal(app.state.plan.status, 'ready');
  ui('task-action').onclick();
  assert.equal(app.state.plan.status, 'running');
  driver.advance(61);
  assert.ok(app.world.contacts > 0, 'real surrounding traffic must constrain this test');
  assert.equal(app.state.plan.status, 'limited');
  assert.equal(app.state.plan.phase, 0, 'the unreachable speed must not count as a completed brake test');
  assert.ok(app.car.speed > 0 && app.car.speed < 100);
  assert.equal(app.state.lastInput.throttle, 0);
  assert.equal(app.car.lastBrakeDistance, null);
  assert.match(ui('task-badge').textContent, /未达目标.*已结束/);
  assert.match(ui('ai-feedback').textContent, /60 秒.*自然滑行/);
  assertNoAutomaticBrake(app);
  const coastStart = app.car.speed, coastDistance = app.car.distance;
  driver.advance(0.5);
  assert.ok(app.car.speed < coastStart && app.car.distance > coastDistance);
  assertNoAutomaticBrake(app);
});
