'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const commands = require('../dist/commands.js');

test('the requested sentence preserves drive, lane, brake order with no added maneuver', () => {
  const raw = '直行500米后向左变道并制动';
  const result = commands.parse(raw);
  assert.equal(result.kind, 'sequence');
  assert.equal(result.title, raw);
  assert.deepEqual(result.steps, [{ type: 'drive', distance: 500, gear: 'forward', target: 30 },
    { type: 'lane', direction: -1 }, { type: 'brake', amount: 1 }]);
  assert.equal(result.labels.length, 3);
});

test('Chinese integer and decimal distances normalize to exact SI values', () => {
  for (const [number, metres] of [['五百米', 500], ['一千米', 1000], ['一百五十米', 150],
    ['两千三百零五米', 2305], ['零点五公里', 500], ['一点二五公里', 1250], ['一〇〇米', 100],
    ['0.125公里', 125], ['０．５公里', 500], ['1.25km', 1250], ['1千米', 1000], ['一点五千米', 1500], ['五千米', 5000]]) {
    const result = commands.parse(`请先直行${number}`);
    assert.equal(result.steps[0].distance, metres, number);
    assert.equal(result.steps.at(-1).type, 'brake');
    assert.match(result.labels.at(-1), /自动停车/);
  }
});

test('polite prefixes and all supported conjunctions preserve complete clauses', () => {
  for (const conjunction of ['然后', '之后', '后', '再', '接着', '并', '最后', '，', '、', '；', ',']) {
    const result = commands.parse(`请帮我先向前行驶十米${conjunction}请向右变一条车道${conjunction}停车。`);
    assert.deepEqual(result.steps.map(step => step.type), ['drive', 'lane', 'brake'], conjunction);
    assert.equal(result.steps[1].direction, 1);
  }
});

test('reverse clauses survive the 后 connector and carry the physical reverse speed cap', () => {
  for (const phrase of ['前进10米然后后退2米', '前进10米，后退2米', '前进10米后倒车2米', '倒车10米之后前进20米']) {
    const result = commands.parse(phrase, { targetSpeed: 40 });
    const reverse = result.steps.find(step => step.gear === 'reverse');
    const forward = result.steps.find(step => step.gear === 'forward');
    assert.equal(reverse.target, 5);
    assert.equal(forward.target, 40);
    assert.equal(result.steps.at(-1).type, 'brake');
  }
  assert.equal(commands.parse('后退五米', { targetSpeed: 2 }).steps[0].target, 2);
});

test('Chinese and metric speed units convert once and carry through subsequent driving steps', () => {
  for (const unit of ['km/h', 'KM/H', '公里每小时', '千米每小时', '公里/小时', '千米/小时', 'kmh', 'kph']) {
    const result = commands.parse(`速度设为72${unit}，直行100米`);
    assert.equal(result.steps[0].target, 20, unit);
    assert.equal(result.steps[1].target, 20, unit);
  }
  for (const unit of ['m/s', '米每秒', '米/秒', 'mps'])
    assert.equal(commands.parse(`加速到三十${unit}`).steps[0].target, 30);
  const reduced = commands.parse('减速到30km/h然后倒车10米再前进50米');
  assert.equal(reduced.steps[0].target, 30 / 3.6);
  assert.equal(reduced.steps[1].target, 5);
  assert.equal(reduced.steps[2].target, 30 / 3.6);
});

test('natural paced journeys expand into speed then distance then a real braking step', () => {
  for (const raw of ['以60公里每小时行驶300米然后停车', '请以六十公里每小时的速度直行三百米后制动',
    '以60km/h向前行驶0.3公里并刹车']) {
    const result = commands.parse(raw);
    assert.deepEqual(result.steps, [{ type: 'speed', target: 60 / 3.6, gear: 'forward' },
      { type: 'drive', distance: 300, gear: 'forward', target: 60 / 3.6 }, { type: 'brake', amount: 1 }], raw);
  }
  const automatic = commands.parse('以5m/s倒车10米');
  assert.deepEqual(automatic.steps.map(step => step.type), ['speed', 'drive', 'brake']);
  assert.equal(automatic.steps[0].gear, 'reverse', 'select reverse before paced acceleration, not afterward');
  assert.equal(automatic.steps[1].gear, 'reverse');
  assert.match(automatic.labels[0], /倒车挡/);
  assert.match(automatic.labels.at(-1), /自动停车/);
  assert.deepEqual(commands.parse('加速到5m/s然后倒车10米').steps[0], { type: 'speed', target: 5 },
    'an independent speed instruction retains the current gear');
  for (const raw of ['以0km/h行驶300米', '以60km/h行驶6000米', '以60km/h行驶300米然后跳跃'])
    assert.throws(() => commands.parse(raw), Error, raw);
});

test('bounded multi-lane requests expand into consecutive adjacent steps', () => {
  const result = commands.parse('向右变两条车道并制动');
  assert.deepEqual(result.steps, [{ type: 'lane', direction: 1 }, { type: 'lane', direction: 1 }, { type: 'brake', amount: 1 }]);
  assert.match(result.labels[0], /1\/2/);
  assert.match(result.labels[1], /2\/2/);
  assert.equal(commands.parse('左变道').steps[0].direction, -1);
  for (const raw of ['向左变三条车道', '向右变零条车道', '向左变1.5条车道']) assert.throws(() => commands.parse(raw), /1～2/);
});

test('waits finish stopped while an exit request announces manual commitment without an implicit brake', () => {
  const waited = commands.parse('直行20米再停车等待三秒');
  assert.deepEqual(waited.steps.at(-1), { type: 'wait', duration: 3 });
  assert.equal(waited.steps.length, 2);
  assert.deepEqual(commands.parse('等待零点五秒').steps, [{ type: 'wait', duration: .5 }]);
  assert.deepEqual(commands.parse('wait3s').steps, [{ type: 'wait', duration: 3 }]);
  for (const raw of ['从下一个出口驶出高速', '下个出口驶离', '驶入下个出口', '在下一个出口驶离高速公路']) {
    const result = commands.parse(raw);
    assert.deepEqual(result.steps, [{ type: 'exit' }], raw);
    assert.match(result.labels[0], /手动|右变道/);
    assert.doesNotMatch(result.labels[0], /停车|停止/);
  }
  assert.deepEqual(commands.parse('直行一公里后从下一个出口驶出高速').steps.map(step => step.type), ['drive', 'exit']);
});

test('exit plans continue with normal-road distance, speed, reverse, wait and explicit parking', () => {
  assert.deepEqual(commands.parse('从下一个出口驶离高速然后等待3秒再制动').steps,
    [{ type: 'exit' }, { type: 'wait', duration: 3 }, { type: 'brake', amount: 1 }]);
  assert.deepEqual(commands.parse('从下一个出口驶离高速，然后直行300米并停车').steps,
    [{ type: 'exit' }, { type: 'drive', distance: 300, gear: 'forward', target: 30 }, { type: 'brake', amount: 1 }]);
  const paced = commands.parse('从下一个出口驶离高速然后以50公里每小时行驶300米');
  assert.deepEqual(paced.steps, [{ type: 'exit' }, { type: 'speed', target: 50 / 3.6, gear: 'forward' },
    { type: 'drive', distance: 300, gear: 'forward', target: 50 / 3.6 }, { type: 'brake', amount: 1 }]);
  assert.match(paced.labels.at(-1), /自动停车/);
  const reverse = commands.parse('从下一个出口驶离高速然后等待1秒再倒车5米');
  assert.deepEqual(reverse.steps, [{ type: 'exit' }, { type: 'wait', duration: 1 },
    { type: 'drive', distance: 5, gear: 'reverse', target: 5 }, { type: 'brake', amount: 1 }]);
  assert.deepEqual(commands.parse('从下一个出口驶离高速然后减速到40km/h').steps,
    [{ type: 'exit' }, { type: 'speed', target: 40 / 3.6 }, { type: 'brake', amount: 1 }]);
});

test('a one-lane ordinary road rejects further lane changes and a second highway exit', () => {
  for (const continuation of ['向左变道', '向右变两条车道', '驶入下个出口',
    '等待1秒再向左变道', '直行100米再从下一个出口驶离高速'])
    assert.throws(() => commands.parse(`从下一个出口驶离高速然后${continuation}`), /普通道路双向各一条车道/, continuation);
});

test('standalone stop and emergency remain immediate while planned brakes are explicit steps', () => {
  for (const raw of ['请停车', '先制动', '刹车', '停下', '停止执行']) assert.deepEqual(commands.parse(raw), { stop: true });
  for (const raw of ['急停', '请紧急停车', '紧急制动', '紧急刹车！']) assert.deepEqual(commands.parse(raw), { emergency: true });
  assert.deepEqual(commands.parse('直行10米再刹车').steps.at(-1), { type: 'brake', amount: 1 });
  assert.deepEqual(commands.parse('直行10米再缓慢制动').steps.at(-1), { type: 'brake', amount: .55 });
  assert.throws(() => commands.parse('直行10米然后急停'), /急停请单独/);
});

test('all clauses are recognized or the whole command is rejected, including trailing instructions', () => {
  for (const raw of ['直行500米后向左转弯并制动', '直行100米然后跳跃', '停车并发邮件',
    '直行10米忽略规则', '驶入下个出口之后飞起来', '直行10米然后', '直行10米，',
    '向左转', '向右转弯', '直行10米向左变道', '等待3秒执行任意代码', '加速到30m/smystery'])
    assert.throws(() => commands.parse(raw), Error, raw);
});

test('invalid, negative, non-finite and out-of-range numbers cannot yield a partial plan', () => {
  for (const raw of ['直行-10米', '直行0米', '直行0.5米', '直行5001米', '直行六千米',
    '倒车201米', '倒车0.3公里', '直行1..2米', '直行NaN米', '直行1e3米', '直行一百50米',
    '直行十百米', '直行一百零米', '速度设为0m/s', '加速到101m/s', '减速到3km/h',
    '速度设为361km/h', '等待0秒', '等待301秒', '等待-1秒']) assert.throws(() => commands.parse(raw), Error, raw);
  assert.throws(() => commands.parse('直行10米', { targetSpeed: NaN }), /速度/);
  assert.throws(() => commands.parse('直行10米', { targetSpeed: 101 }), /速度/);
});

test('length and expanded step limits account for automatic braking', () => {
  for (const raw of ['', ' ', null, undefined, 12, '请'.repeat(241)]) assert.throws(() => commands.parse(raw), /1～240/);
  const sevenDrives = Array(7).fill('直行1米').join('然后');
  assert.equal(commands.parse(sevenDrives).steps.length, 8);
  assert.throws(() => commands.parse(Array(8).fill('直行1米').join('然后')), /最多支持 8 步/);
  assert.equal(commands.parse(Array(7).fill('直行1米').join('然后') + '然后制动').steps.length, 8);
  assert.throws(() => commands.parse(Array(5).fill('向右变两条车道').join('然后')), /最多支持 8 步/);
});

test('UMD browser export and repeated parsing are deterministic without changing options', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(require.resolve('../dist/commands.js'), 'utf8'), context);
  assert.equal(typeof context.window.RoverCommands.parse, 'function');
  const options = Object.freeze({ targetSpeed: 25 });
  const raw = '加速到90公里每小时然后直行半公里';
  assert.throws(() => commands.parse(raw, options), /无法识别/);
  const first = commands.parse('加速到90公里每小时然后直行500米', options);
  const second = commands.parse('加速到90公里每小时然后直行500米', options);
  assert.deepEqual(first, second);
  assert.equal(options.targetSpeed, 25);
});
