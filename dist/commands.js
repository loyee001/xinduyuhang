(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RoverCommands = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const numberToken = '(?:[+-]?\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二两三四五六七八九]+)?)';
  const speedUnit = '(?:公里每小时|千米每小时|公里/小时|千米/小时|km/h|kmh|kph|米每秒|米/秒|m/s|mps)';
  const driveVerb = '(向前行驶|向后行驶|向前走|前进|直行|行驶|向前|倒车|后退|向后)';
  const distanceUnit = '(公里|千米|km|米|m)';
  const drivePattern = new RegExp(`^${driveVerb}(${numberToken})${distanceUnit}`);
  const pacedDrivePattern = new RegExp(`^以(${numberToken})(${speedUnit})(?:的速度)?${driveVerb}(${numberToken})${distanceUnit}`);
  const lanePattern = new RegExp(`^(?:向|往)?(左|右)(?:变道|变(${numberToken})(?:条|个)?车道)`);
  const speedPattern = new RegExp(`^(?:将速度设置为|把速度设置为|将速度设为|把速度设为|速度设置为|速度设为|设定速度为|加速到|加速至|减速到|减速至|速度调到|速度调至|速度)(${numberToken})(${speedUnit})`);
  const waitPattern = new RegExp(`^(?:停车等待|停下等待|等待|等候|停留|wait|等)(${numberToken})(?:秒钟|秒|s)`);
  const exitPattern = /^(?:(?:从|在)?(?:下一个|下个|下一处)出口(?:驶出高速公路|驶离高速公路|驶出高速|驶离高速|离开高速|下高速|驶离)|(?:驶入|进入|驶向)(?:下一个|下个|下一处)出口)/;
  const digits = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
  const units = Object.freeze({ 十: 10, 百: 100, 千: 1000, 万: 10000 });

  function chineseInteger(word) {
    if (/^[零〇一二两三四五六七八九]+$/.test(word))
      return Number([...word].map(char => digits[char]).join(''));
    let value = 0, pending = null, lastUnit = Infinity, zero = false;
    for (let i = 0; i < word.length; i++) {
      const char = word[i];
      if (Object.prototype.hasOwnProperty.call(digits, char)) {
        const digit = digits[char];
        if (digit === 0) {
          if (i === 0 || pending !== null || zero || i === word.length - 1) throw new Error('中文数字格式不正确。');
          zero = true;
        } else {
          if (pending !== null) throw new Error('中文数字格式不正确。');
          pending = digit;
        }
      } else {
        const unit = units[char];
        if (!unit || unit >= lastUnit || zero || (pending === null && !(unit === 10 && i === 0)))
          throw new Error('中文数字格式不正确。');
        value += (pending === null ? 1 : pending) * unit;
        lastUnit = unit;
        pending = null;
      }
      if (pending !== null) zero = false;
    }
    return value + (pending || 0);
  }

  function numeric(word) {
    let value;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(word)) value = Number(word);
    else if (/^[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二两三四五六七八九]+)?$/.test(word)) {
      const [integer, fraction] = word.split('点');
      value = chineseInteger(integer) + (fraction ? Number(`0.${[...fraction].map(char => digits[char]).join('')}`) : 0);
    } else throw new Error('数字格式不正确，请使用 500、五百或零点五这样的写法。');
    if (!Number.isFinite(value)) throw new Error('请输入有效数字。');
    return value;
  }

  const polite = text => text.replace(/^(?:(?:请帮我|麻烦你|请先|帮我|帮忙|麻烦|请|先))+/u, '');
  const readable = value => String(Math.round(value * 1000) / 1000);
  const speedLabel = target => `将速度设为 ${readable(target)} m/s（${readable(target * 3.6)} km/h，遵守路段限速）`;

  function parse(raw, { targetSpeed = 30 } = {}) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 240)
      throw new Error('请输入 1～240 字的指令。');
    let remaining = raw.trim().replace(/[０-９]/g, char => String(char.charCodeAt(0) - 0xff10))
      .replace(/．/g, '.').replace(/／/g, '/').replace(/\s+/g, '').toLowerCase().replace(/[。！!？?]+$/, '');
    remaining = polite(remaining);
    if (/^(?:急停|紧急停车|紧急制动|紧急刹车)$/.test(remaining)) return { emergency: true };
    if (/^(?:刹车|刹车停止|制动|制动停车|停车|停下|停止|停止移动|停止任务|停止执行)$/.test(remaining)) return { stop: true };
    if (!Number.isFinite(targetSpeed) || targetSpeed < 1 || targetSpeed > 100)
      throw new Error('设定速度必须在 1～100 m/s 之间。');

    const steps = [], labels = [];
    let activeTarget = targetSpeed;
    function add(step, label) {
      if (steps.some(previous => previous.type === 'exit') && ['lane', 'exit'].includes(step.type))
        throw new Error('驶离高速后的普通道路双向各一条车道，不支持继续变道或再次驶入高速出口。');
      if (steps.length >= 8) throw new Error('一个计划最多支持 8 步（包含自动停车），请拆成两次指令。');
      steps.push(step);
      labels.push(label);
    }
    function addDrive(verb, amount, unit) {
      const gear = /向后|倒车|后退/.test(verb) ? 'reverse' : 'forward';
      const distance = numeric(amount) * (/公里|千米|km/.test(unit) ? 1000 : 1);
      const maximum = gear === 'reverse' ? 200 : 5000;
      if (distance < 1 || distance > maximum) throw new Error(`${gear === 'reverse' ? '倒车' : '前进'}任务支持 1～${maximum} 米。`);
      const target = gear === 'reverse' ? Math.min(activeTarget, 5) : activeTarget;
      add({ type: 'drive', distance, gear, target }, `${gear === 'reverse' ? '倒车' : '直行'} ${readable(distance)} 米（遵守限速）`);
    }
    function addSpeed(amount, unit, gear = null) {
      const value = numeric(amount);
      const target = /小时|km\/h|kmh|kph/.test(unit) ? value / 3.6 : value;
      if (target < 1 || target > 100) throw new Error('设定速度必须在 1～100 m/s（3.6～360 km/h）之间。');
      activeTarget = target;
      add({ type: 'speed', target, ...(gear ? { gear } : {}) },
        `${gear ? `切换${gear === 'reverse' ? '倒车' : '前进'}挡，` : ''}${speedLabel(target)}`);
    }
    while (remaining) {
      remaining = polite(remaining);
      let match, consumed = '';
      if ((match = remaining.match(pacedDrivePattern))) {
        addSpeed(match[1], match[2], /向后|倒车|后退/.test(match[3]) ? 'reverse' : 'forward');
        addDrive(match[3], match[4], match[5]);
        consumed = match[0];
      } else if ((match = remaining.match(drivePattern))) {
        addDrive(match[1], match[2], match[3]);
        consumed = match[0];
      } else if ((match = remaining.match(lanePattern))) {
        const direction = match[1] === '左' ? -1 : 1;
        const count = match[2] === undefined ? 1 : numeric(match[2]);
        if (!Number.isInteger(count) || count < 1 || count > 2) throw new Error('一次支持变更 1～2 条车道，将逐条执行。');
        for (let index = 0; index < count; index++)
          add({ type: 'lane', direction }, `向${match[1]}变更一条车道${count > 1 ? `（第 ${index + 1}/${count} 条）` : ''}`);
        consumed = match[0];
      } else if ((match = remaining.match(speedPattern))) {
        addSpeed(match[1], match[2]);
        consumed = match[0];
      } else if ((match = remaining.match(waitPattern))) {
        const duration = numeric(match[1]);
        if (duration < .1 || duration > 300) throw new Error('停车等待支持 0.1～300 秒。');
        add({ type: 'wait', duration }, `停车等待 ${readable(duration)} 秒`);
        consumed = match[0];
      } else if ((match = remaining.match(exitPattern))) {
        add({ type: 'exit' }, '从下一个出口驶离高速，进入普通道路');
        consumed = match[0];
      } else if ((match = remaining.match(/^(?:缓慢刹车|缓慢制动|平稳停车|轻刹车|轻刹|缓刹|刹车停止|制动停车|刹车|制动|停车|停下|停止)/))) {
        const amount = /缓慢|平稳|轻刹|缓刹/.test(match[0]) ? .55 : 1;
        add({ type: 'brake', amount }, amount === 1 ? '制动至停车（仍有刹车距离）' : '平稳制动至停车（仍有刹车距离）');
        consumed = match[0];
      } else if (/^(?:急停|紧急停车|紧急制动|紧急刹车)/.test(remaining)) {
        throw new Error('急停请单独下达；顺序计划中可使用“制动”或“停车”。');
      } else throw new Error(`无法识别“${remaining.slice(0, 32)}”，请使用直行、变道、设定速度、制动、等待或驶离出口。`);

      remaining = remaining.slice(consumed.length);
      if (!remaining) break;
      let separated = false;
      while (true) {
        // The short connector 后 must not consume the first character of 后退.
        const separator = remaining.match(/^(?:然后|之后|以后|接着|随后|并且|最后|最终|再|并|后(?!退)|[，,、；;])/);
        if (!separator) break;
        separated = true;
        remaining = remaining.slice(separator[0].length);
      }
      if (!separated) throw new Error(`无法识别剩余内容“${remaining.slice(0, 32)}”，请用“然后”连接完整动作。`);
      if (!remaining) throw new Error('连接词后缺少动作，请补全指令。');
    }
    if (!steps.length) throw new Error('请补全要执行的动作。');
    if (['drive', 'lane', 'speed'].includes(steps[steps.length - 1].type))
      add({ type: 'brake', amount: 1 }, '自动停车：最后一步完成后制动至停止');
    return { kind: 'sequence', title: raw, steps, labels };
  }

  return Object.freeze({ parse });
});
