import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { HAND_SPEED_POKE } from '../src/behavior.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { familiarityFor, PLAYER_ID } from '../src/memory.js';
import { boot } from '../src/main.js';
import { attachInput, computeSpeed, createHandTracker, NO_TIME } from '../src/input.js';

// ---------------------------------------------------------------- 这个文件在守什么
//
// input.js 的产物只有一个：`world.playerHand = { pos: {x, y}, speed } | null`，
// 而 playerHand 是**内核唯一接受表现层写入的字段**（sim.js 模块头与 createWorld 都写了）。
// 所以这里每一条断言都可以翻译成一句"否则缸里会出现什么症状"：
//
//   · pos 必须是归一化 [0,1]² —— 内核拿它和 c.pos（同为归一化）算"手离它多远"，
//     喂 CSS 像素的话那个距离会算成 1900，于是**永远不在感知范围内**，
//     手对缸里的世界等于不存在（不是报错，是静默的什么都不发生）。
//   · speed 必须是**归一化单位 / 秒** —— HAND_SPEED_POKE 是每秒口径的数，
//     写成"每帧位移"会让它在 60Hz 下被悄悄除掉 60 倍，**戳永远判不出来**。
//   · 抬手必须送回 null —— 否则生物会永久围着一只已经不存在的手转。
//   · 事件频率必须与消费频率解耦 —— 指针上报可以远高于 60Hz（手机 120–240Hz，
//     部分鼠标 1000Hz），解耦不了就是每秒上千次环形插入与速度重算，
//     而 spec §5.3 要的是"运行时不分配对象"。
//
// 坐标口径的两条理由（这是**本 Task 定的口径**，内核只是消费它）：
//   · 归一化而不是 CSS 像素：内核算距离用的就是归一化坐标，两者必须同单位。
//   · 但"归一化"只保证**屏幕比例**意义上的同样手势算同样快，**不保证**物理手指速度
//     意义上的同样手势算同样快（0.25 归一化/秒在 1920 宽 = 480px/s，在 390 宽 = 97.5px/s）。
//     这条换算与它的后果写在 .superpowers/sdd/diag-hand-speed.mjs 里，且**没有真人数据**，
//     所以本文件不许出现"阈值已按实测校准"这种断言 —— 只断言"读数落在阈值哪一侧"。

const W = 1920, H = 1080;

const tracker = () => createHandTracker({});

// 假目标：**只有** attachInput 需要的能力。没有 document / window 也能跑，
// 这正是"监听目标由形参传入"这条设计的可测性回报。
function makeTarget(opts) {
  const o = opts || {};
  const listeners = new Map();
  const target = {
    clientWidth: o.clientWidth === undefined ? W : o.clientWidth,
    clientHeight: o.clientHeight === undefined ? H : o.clientHeight,
    captures: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const k = arr.indexOf(fn);
      if (k >= 0) arr.splice(k, 1);
    },
    setPointerCapture(id) { target.captures.push(id); },
    emit(type, ev) {
      const arr = listeners.get(type);
      if (!arr) return;
      for (const fn of arr.slice()) fn(ev);
    },
    listenerTotal() {
      let n = 0;
      for (const arr of listeners.values()) n += arr.length;
      return n;
    },
    types() { return [...listeners.keys()].sort(); },
  };
  return target;
}

// 源码扫描用**剥掉注释**的版本 —— 与交付的 tests/constraints.test.js 的做法一致。
// 理由（那边也写了）：不剥注释的话守卫第一天就是红的，因为注释里必须**提到**被禁的名字
// 才能解释为什么禁它；然后人会去把守卫注释掉，那才是真正的损失。
const INPUT_SRC = readFileSync(fileURLToPath(new URL('../src/input.js', import.meta.url)), 'utf8');
const INPUT_CODE = INPUT_SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const PEV = (x, y, id) => ({ clientX: x, clientY: y, pointerId: id === undefined ? 1 : id });

// ---------------------------------------------------------------- 旧计划 Task 8 Step 1 的九条

test('没有指针时 state() 是 null（内核据此判断"手不在缸里"）', () => {
  const t = tracker();
  assert.equal(t.state(), null);
  t.sample(0, 100, 100, W, H);
  assert.notEqual(t.state(), null);
  t.release();
  assert.equal(t.state(), null, '抬起后必须变回 null，否则生物会永久围着一只不存在的手转');
  // 缓冲也必须倒空：留着的话下一次按下的第一笔速度会**跟上一次的手势**做差，
  // 跨手势的假速度可以大到几十 ⇒ "刚伸出的手"被当成猛戳，玩家每次伸手都吓它一次。
  assert.equal(t.count, 0, `抬手必须倒空采样缓冲，实测还剩 ${t.count} 笔`);
});

test('pos 归一化到 [0,1]²，且与内核的坐标系一致', () => {
  const t = tracker();
  t.sample(0, 0, 0, W, H);
  let s = t.state();
  assert.equal(s.pos.x, 0);
  assert.equal(s.pos.y, 0);
  t.sample(16, W, H, W, H);
  s = t.state();
  assert.equal(s.pos.x, 1);
  assert.equal(s.pos.y, 1);
  t.sample(32, W / 2, H / 2, W, H);
  s = t.state();
  assert.ok(Math.abs(s.pos.x - 0.5) < 1e-12 && Math.abs(s.pos.y - 0.5) < 1e-12, `${s.pos.x}, ${s.pos.y}`);
  // 越界必须夹住：指针可以移出目标元素（拖出窗口、手指滑到边缘外），
  // 越界的归一化坐标会让"手离它多远"失去意义。
  t.sample(48, W * 2, -H, W, H);
  s = t.state();
  assert.ok(s.pos.x === 1 && s.pos.y === 0, `越界未夹住：${s.pos.x}, ${s.pos.y}`);
});

test('computeSpeed：静止为 0，慢划与快戳差一个数量级', () => {
  // 采样缓冲是 { t, x, y } 三个并列 typed array（见实现），这里用等价对象喂纯函数
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  samples.t[0] = 0; samples.x[0] = 0.5; samples.y[0] = 0.5;
  samples.t[1] = 16; samples.x[1] = 0.5; samples.y[1] = 0.5;
  samples.t[2] = 32; samples.x[2] = 0.5; samples.y[2] = 0.5;
  assert.equal(computeSpeed(samples, 3, 32, 120), 0);

  // 慢划（抚摸）：120ms 内移动 0.02 归一化单位 ⇒ 0.167 /s
  samples.t[0] = 0; samples.x[0] = 0.50; samples.y[0] = 0.5;
  samples.t[1] = 60; samples.x[1] = 0.51; samples.y[1] = 0.5;
  samples.t[2] = 120; samples.x[2] = 0.52; samples.y[2] = 0.5;
  const slow = computeSpeed(samples, 3, 120, 200);
  assert.ok(Math.abs(slow - 0.02 / 0.12) < 0.02, `慢划速度应当约 0.167/s，实测 ${slow}`);
  assert.ok(slow < HAND_SPEED_POKE, `慢划必须被判定为抚摸（< ${HAND_SPEED_POKE}）：${slow}`);

  // 快戳：40ms 内移动 0.12 归一化单位 ⇒ 3.0 /s
  samples.t[0] = 0; samples.x[0] = 0.50; samples.y[0] = 0.5;
  samples.t[1] = 20; samples.x[1] = 0.56; samples.y[1] = 0.5;
  samples.t[2] = 40; samples.x[2] = 0.62; samples.y[2] = 0.5;
  const fast = computeSpeed(samples, 3, 40, 200);
  assert.ok(fast > HAND_SPEED_POKE, `快戳必须被判定为戳（> ${HAND_SPEED_POKE}）：${fast}`);
  assert.ok(fast > slow * 5, `快戳应当比慢划快一个数量级：${fast} vs ${slow}`);
});

test('computeSpeed：过期采样不参与（否则一次快戳会被之前的静止历史稀释掉）', () => {
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  samples.t[0] = 0; samples.x[0] = 0.5; samples.y[0] = 0.5;
  samples.t[1] = 1000; samples.x[1] = 0.5; samples.y[1] = 0.5;
  samples.t[2] = 1010; samples.x[2] = 0.6; samples.y[2] = 0.5;
  const v = computeSpeed(samples, 3, 1010, 200);
  assert.ok(v > 1, `过期采样必须被排除，否则戳被稀释成 ${v}`);
  assert.equal(computeSpeed(samples, 3, 99999, 200), 0, '全部过期 ⇒ 0（不是 NaN、不是负数）');
});

test('computeSpeed 对退化输入是安全的（同刻双采样、单采样、count=0）', () => {
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  assert.equal(computeSpeed(samples, 0, 0, 200), 0);
  samples.t[0] = 5; samples.x[0] = 0.3; samples.y[0] = 0.3;
  assert.equal(computeSpeed(samples, 1, 5, 200), 0);
  // 同一毫秒两个采样点：dt = 0 ⇒ 不得除零得 Infinity/NaN
  samples.t[1] = 5; samples.x[1] = 0.9; samples.y[1] = 0.9;
  const v = computeSpeed(samples, 2, 5, 200);
  assert.ok(Number.isFinite(v) && v >= 0, `同刻双采样必须给出有限非负速度，实测 ${v}`);
});

test('state() 复用同一个对象（spec §5.3 运行时零分配）', () => {
  const t = tracker();
  t.sample(0, 100, 100, W, H);
  const a = t.state();
  t.sample(16, 200, 200, W, H);
  const b = t.state();
  assert.equal(a, b, '每次 pointermove 都新建 {pos, speed} 就是每秒上百次分配');
  assert.equal(a.pos, b.pos);
  t.poll(32);
  assert.equal(t.state(), a, 'poll 也不许新建输出对象');
});

test('采样缓冲有上界，长时间按住不会无限增长', () => {
  const t = tracker();
  for (let i = 0; i < 100000; i++) t.sample(i, (i % W), (i % H), W, H);
  const s = t.state();
  assert.ok(Number.isFinite(s.speed) && s.speed >= 0);
  assert.ok(t.count <= 64, `采样缓冲必须环形复用，实测 ${t.count} 个`);
});

test('input.js 不出现浏览器全局名（靠注入的目标，不靠豁免）', () => {
  // 这条**重复**交付的 tests/constraints.test.js 那道全局扫描，是刻意的：
  // 全局扫描按目录走，哪天有人把 input.js 挪出 src/ 或塞进白名单，这里还会红。
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(INPUT_CODE),
      `input.js 的代码里出现了 ${name}；监听目标必须由 attachInput 的形参传入`);
  }
  // Pointer Events 的 API 名**不在**那七个里，可以正常用（这是本层能工作的前提）。
  for (const allowed of ['addEventListener', 'removeEventListener', 'pointerdown', 'pointermove',
    'pointerup', 'pointercancel', 'pointerId', 'setPointerCapture']) {
    assert.ok(INPUT_CODE.includes(allowed), `input.js 不再使用 Pointer Events 的 ${allowed}？`);
  }
});

test('input.js 零 import：不碰内核，更不许有第二份速度阈值', () => {
  // 内核里 HAND_SPEED_POKE 有**三处**消费者（behavior.scoreAll 的 handIsRough、
  // 情绪情境里的 threat、isPetting 的 familiarity 门），behavior.js 文件头专门解释了
  // 为什么必须同源。input.js 只**产出速度**，一个阈值都不该知道 ——
  // 于是"零 import"就是"零第二定义点"的最强形式（连 import 都没有，谈不上复制常量）。
  assert.ok(!/^\s*import\s/m.test(INPUT_CODE), 'input.js 不该有任何 import（它只产出 {pos, speed}）');
  assert.ok(!/from '\.\/sim\.js'/.test(INPUT_SRC), 'input.js 不得 import sim.js');
  assert.ok(!/from '\.\/behavior\.js'/.test(INPUT_SRC), "input.js 不得 import behavior.js（阈值唯一定义点在那边）");
  assert.ok(!/HAND_SPEED_POKE|handPokeSpeed|perceiveRadius/.test(INPUT_CODE), 'input.js 里出现了速度阈值的名字');
  // 也不许写内核状态：温柔的手买"认识"是内核自己在它的 tick 里做的。
  assert.ok(!/adjustMemory|applyEvent|playerHand|startle|comfort/.test(INPUT_CODE),
    'input.js 不得直接改内核状态（它连 world 都不认识）');
  // 0.25 这个数不许出现在本文件里 —— 它就是"第二份阈值"最典型的形状。
  assert.ok(!/0\.25\b/.test(INPUT_CODE), 'input.js 里出现了 0.25（那是 HAND_SPEED_POKE 的字面量）');
});

// ---------------------------------------------------------------- 解耦与节流（B17 的纪律 4）

test('事件频率与模拟频率解耦：1000 次 pointermove 不产生 1000 次任何重活', () => {
  const target = makeTarget();
  let clock = 0;
  const handed = [];
  const input = attachInput(target, (h) => handed.push(h === null ? null : h.speed), { now: () => clock });
  const m = input.tracker.metrics;

  target.emit('pointerdown', PEV(100, 100));
  for (let i = 0; i < 1000; i++) {
    clock += 1;                                    // 1000Hz 上报（手机 120–240Hz 的极端版）
    target.emit('pointermove', PEV(100 + i, 100));
  }
  // 事件阶段：一次回调都没有 —— 唯一的消费者是 poll，这就是解耦的定义。
  assert.equal(handed.length, 0, `pointermove 里不许调 onHand（实测 ${handed.length} 次）`);
  assert.equal(m.inserts, 0, `pointermove 里不许往采样缓冲写（实测 ${m.inserts} 次插入）`);
  assert.equal(m.computes, 0, `pointermove 里不许重算速度（实测 ${m.computes} 次）`);
  assert.equal(m.reads, 1001, `每个事件只该更新一次读数，实测 ${m.reads}`);

  clock += 1;
  input.poll(clock);
  // 重活的上界是**消费者次数**，与事件数无关。
  assert.ok(m.inserts <= 1, `一次 poll 最多插入一个采样，实测 ${m.inserts}`);
  assert.equal(m.computes, 1);
  assert.equal(handed.length, 1);

  for (let f = 0; f < 5; f++) { clock += 16; input.poll(clock); }
  assert.ok(m.inserts <= m.computes, `插入次数必须永远 ≤ poll 次数：${m.inserts} vs ${m.computes}`);
  assert.equal(m.computes, 6);
  assert.ok(handed.length <= 6, `onHand 次数 ≤ poll 次数，实测 ${handed.length}`);
  input.detach();
});

test('poll 在没有新事件时仍把速度衰减到 0（静止的手读数≈0，不是上一次快戳的残值）', () => {
  const t = tracker();
  t.sample(0, 0.1 * W, 500, W, H);
  t.sample(10, 0.4 * W, 500, W, H);
  assert.ok(t.state().speed > HAND_SPEED_POKE, `快戳读数应当越过阈值，实测 ${t.state().speed}`);
  // 手从此**一动不动**（设备不再上报），只有消费者在 poll
  for (let i = 1; i <= 20; i++) t.poll(10 + i * 16);
  const s = t.state();
  assert.ok(s.speed < 0.02, `静止 320ms 后读数必须归零，实测 ${s.speed}`);
  assert.ok(s.pos.x > 0.39 && s.pos.x < 0.41, `位置必须留在最后一次读数上，实测 ${s.pos.x}`);
});

test('真实设备的上报抖动不许把"静止"读成"在划"', () => {
  // 鼠标按住不动时并不安静：光学传感器会以 125Hz–1000Hz 报 ±1 CSS 像素的抖动。
  // 这一条钉的是 computeSpeed 取**首末位移**而不是**逐段累加**（旧计划 Task 8 Step 7(b) 的探针）：
  // 累加会把抖动全算成移动，于是"静止"永远得不到 0，
  // spec §6.1 要的"静止 vs 缓慢划动"就分不开，内核会把停着的手当成一直在划。
  const t = tracker();
  for (let ms = 0; ms <= 2000; ms += 8) {
    t.sample(ms, 0.5 * W + ((ms % 3) - 1) * 4, 0.5 * H, W, H);   // ±4px 的有界抖动
  }
  const still = t.state().speed;
  assert.ok(still < HAND_SPEED_POKE * 0.1,
    `抖动下的静止读数必须远低于阈值（实测 ${still}，阈值 ${HAND_SPEED_POKE}）`);
  // 同样的抖动叠加真实的缓慢划动（每 8ms 前进 1px ≈ 125px/s）—— 仍然应当在阈值之下
  const t2 = tracker();
  for (let ms = 0; ms <= 2000; ms += 8) {
    t2.sample(ms, 0.3 * W + (ms / 8) + ((ms % 3) - 1) * 4, 0.5 * H, W, H);
  }
  assert.ok(t2.state().speed < HAND_SPEED_POKE, `缓慢划动仍应算温柔，实测 ${t2.state().speed}`);
});

// ---------------------------------------------------------------- 抬手与手势边界

test('pointerup / pointercancel / lostpointercapture 之后必须立刻送回 null', () => {
  // 旧计划 Task 8 Step 7(c) 把这条记成"attachInput 需要真实 DOM 事件才能测"的覆盖缺口。
  // **不实**：注入目标之后合成事件就能测，所以这里直接钉住，不必等手工清单。
  for (const upType of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const target = makeTarget();
    let clock = 0;
    const handed = [];
    const input = attachInput(target, (h) => handed.push(h), { now: () => clock });
    target.emit('pointerdown', PEV(300, 300));
    input.poll(clock);
    assert.notEqual(handed[handed.length - 1], null, `${upType} 之前手应当在缸里`);
    target.emit(upType, PEV(300, 300));
    assert.equal(handed[handed.length - 1], null, `${upType} 必须立刻送回 null（不等下一帧）`);
    handed.length = 0;
    target.emit('pointermove', PEV(400, 400));
    input.poll(clock);
    assert.equal(handed.length, 0, `${upType} 之后的 pointermove 不该让手复活`);
    input.detach();
  }
});

test('只跟第一根手指：第二根手指落下不许劫持这只手（捏合属 spec §10 范围外）', () => {
  const target = makeTarget();
  let clock = 0;
  const handed = [];
  const input = attachInput(target, (h) => handed.push(h && h.pos ? h.pos.x : null), { now: () => ++clock });
  target.emit('pointerdown', PEV(100, 100, 1));
  input.poll(clock);
  const first = handed[handed.length - 1];
  target.emit('pointerdown', PEV(900, 900, 2));            // 第二根手指
  target.emit('pointermove', PEV(950, 950, 2));
  input.poll(clock);
  assert.equal(handed[handed.length - 1], first, '多指不许把这只手搬到第二根手指上');
  target.emit('pointermove', PEV(200, 100, 1));            // 第一根手指自己动
  input.poll(clock);
  assert.notEqual(handed[handed.length - 1], first, '第一根手指自己动仍然有效');
  target.emit('pointerup', PEV(200, 100, 1));
  assert.equal(handed[handed.length - 1], null, '第一根手指抬起后手就没了（不接管第二根）');
  input.detach();
});

test('pointerdown 必须请求指针捕获，detach 必须解绑全部监听', () => {
  const target = makeTarget();
  const input = attachInput(target, () => {}, { now: () => 0 });
  target.emit('pointerdown', PEV(10, 10, 7));
  assert.deepEqual(target.captures, [7], '必须调用 setPointerCapture(ev.pointerId)');
  assert.deepEqual(target.types(),
    ['lostpointercapture', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
  input.detach();
  assert.equal(target.listenerTotal(), 0, `detach 必须解绑全部监听，实测剩 ${target.listenerTotal()}`);
});

test('detach 之后 onHand 收到最后一次 null，且 poll 不再写任何东西', () => {
  const target = makeTarget();
  const handed = [];
  const input = attachInput(target, (h) => handed.push(h), { now: () => 0 });
  target.emit('pointerdown', PEV(500, 500));
  input.poll(0);
  assert.notEqual(handed[handed.length - 1], null);
  input.detach();
  assert.equal(handed[handed.length - 1], null, 'world.playerHand 不许留在已经离开的这只手上');
  const before = handed.length;
  target.emit('pointerdown', PEV(600, 600));               // 解绑后的派发不该再有反应
  input.poll(16);
  assert.equal(handed.length, before, 'detach 后 poll 不许再送出手');
});

test('尺寸在 pointerdown 时读一次，绝不在 pointermove 里读（布局读取会被 1000Hz 拖死）', () => {
  const target = makeTarget({ clientWidth: 800, clientHeight: 600 });
  let sizeReads = 0;
  Object.defineProperty(target, 'clientWidth', {
    get() { sizeReads += 1; return 800; },
  });
  const input = attachInput(target, () => {}, { now: () => 0 });
  target.emit('pointerdown', PEV(400, 300));
  for (let i = 0; i < 1000; i++) target.emit('pointermove', PEV(400, 300 + (i % 2)));
  assert.ok(sizeReads <= 2, `1000 次 move 里读了 ${sizeReads} 次尺寸，必须只在按下时取一次`);
  const s = input.poll(0);
  assert.equal(s.pos.x, 0.5, '按 800 宽归一化：400 ⇒ 0.5');
  input.detach();
});

test('尺寸拿不到时不许炸成 NaN（0 宽 / 缺字段的目标在 Node 与某些 webview 里都存在）', () => {
  const target = makeTarget({ clientWidth: 0, clientHeight: 0 });
  const input = attachInput(target, () => {}, { now: () => 0 });
  target.emit('pointerdown', PEV(10, 10));
  const s = input.poll(0);
  assert.ok(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y) && Number.isFinite(s.speed),
    `退化尺寸必须给出有限读数，实测 ${JSON.stringify(s)}`);
  input.detach();
});

test('浏览器合并事件（coalescing）不影响速度：只用首末位移就天然免疫', () => {
  // 高频设备上浏览器会把多个真实采样**合并**成一个事件派发，中间点在 ev 里丢了。
  // 逐段累加的实现会因此随合并与否漂移（同一手势在 60Hz 合并流里算出来更慢）。
  // 首末位移只依赖窗口两端的坐标 ⇒ 与上报密度无关。这一条就是那个性质的证明。
  const dense = tracker();
  const sparse = tracker();
  for (let ms = 0; ms <= 120; ms += 4) dense.sample(ms, (0.2 + ms / 8000) * W, 0.5 * H, W, H);
  for (const ms of [0, 60, 120]) sparse.sample(ms, (0.2 + ms / 8000) * W, 0.5 * H, W, H);
  const a = dense.state().speed;
  const b = sparse.state().speed;
  assert.ok(Math.abs(a - b) / a < 0.02, `稠密 ${a} 与稀疏 ${b} 必须基本一致`);
  assert.ok(a < HAND_SPEED_POKE, `这一档划动应当算温柔，实测 ${a}`);
});

test('时钟倒灌不许产生非法读数（事件时刻与帧时刻来自同一个注入时钟，但要防混用）', () => {
  const t = tracker();
  t.sample(1000, 0.3 * W, 0.5 * H, W, H);
  const s = t.poll(500);                          // 帧时刻"早于"上一次采样：真实世界不会，但必须不崩
  assert.ok(Number.isFinite(s.speed) && s.speed >= 0, `倒灌读数必须有限非负，实测 ${s.speed}`);
  assert.ok(s.pos.x > 0.29 && s.pos.x < 0.31);
});

// ---------------------------------------------------------------- 与内核的同源交叉验证

test('同一条真实轨迹经 input.js 后：温柔的手买"认识"，粗暴的手买"害怕"（三处同源）', () => {
  // 这条是**跨层**的：它不问阈值等于多少，只问"同一份速度送进内核后，内核的三处消费者
  // 是否给出彼此一致的裁定"。若 HAND_SPEED_POKE 在两处漂移成两个数，这里会立刻变成
  // "既买了认识又买了害怕"这种自相矛盾 —— 而那正是 behavior.js 文件头警告的事。
  const run = (poke) => {
    const world = createWorld({ seed: 20261024, driftInterval: Infinity });
    const c = world.creatures[0];
    const t = createHandTracker({});
    const fear0 = c.emotions.fear;
    // 两种手势**只差快慢这一个维度**：同一个 ±0.1 的摆动幅度、同一只生物旁边、同样 2 模拟秒。
    // ±0.1 是刻意选的：内核那句"够近"的上界是 perceiveRadius × 0.5 = 0.14，
    // 两侧都必须在它之内 —— 否则 familiarity 的差异可能来自距离而不是速度，
    // 这条测试就不再是"三处同源"的证据了。
    //
    // 粗暴那一侧用 **3 帧一个周期**的三段台阶（−0.05 → 0 → +0.05），不用正弦也不用长锯齿：
    //   · 正弦在极值处会让窗口首末位移压到 0；锯齿的周期与 140ms 窗口（≈8 帧）成整数倍时
    //     同样会（相位混叠）。那都是**测量手段的伪影**，用它会把"戳"测成"偶尔温柔"。
    //   · 3 与 8 互质 ⇒ 任何窗口的首末相位差都至少跨 2 个台阶 ⇒ 位移下界 0.05，
    //     读数下界约 0.38/s，在阈值之上。
    // 两侧都**对称**（不用带符号的偏移），这样就不需要"靠墙翻面"那种会把位置跳变
    // 变成假读数的写法；而 x 越界被夹住同样是假读数，所以用下面那条区间守卫盯着。
    const offAt = (i) => (poke
      ? 0.1 * (((i % 3) - 1) / 2)
      // 温柔那一侧：同一个幅度，周期 60 帧（1 秒）⇒ 读数上界约 0.1/s
      : 0.1 * Math.sin(i / 60));
    let minSpeed = Infinity;
    let maxSpeed = 0;
    let minX = 1;
    let maxX = 0;
    const feed = (i, tick) => {
      const x = c.pos.x + offAt(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      t.sample(i * (1000 / 60), x * W, c.pos.y * H, W, H);
      world.playerHand = t.state();
      return tick ? t.state().speed : 0;
    };
    // **预热**：先喂 12 笔采样（200ms > 窗口 140ms）但不推进世界。
    // 新落下的手在第一笔读数时没有历史 ⇒ 速度只能是 0（那件事单独由
    // 「新落下的第一笔读数速度是 0」那条测试钉住并量了代价）。
    // 不预热的话这条跨层测试就变成在断言一个启动瞬态，症状是
    // "粗暴的手第一 tick 买了 0.00066 的 familiarity" —— 实现没错，是测试在测空气。
    for (let i = -12; i < 0; i++) feed(i, false);
    for (let i = 0; i < 120; i++) {               // 2 模拟秒 @60Hz
      const sp = feed(i, true);
      if (sp > maxSpeed) maxSpeed = sp;
      if (sp < minSpeed) minSpeed = sp;
      tickWorld(world, CONFIG.fixedDt);
      world.events.length = 0;
    }
    return {
      familiarity: familiarityFor(c.memory, PLAYER_ID),
      dFear: c.emotions.fear - fear0,
      minSpeed, maxSpeed, minX, maxX,
      alive: c.alive,
    };
  };
  const gentle = run(false);
  const rough = run(true);
  assert.ok(gentle.alive && rough.alive, '两只都得活着，否则下面的对比没有意义');
  // 先自证轨迹本身（不成立时报错会说清是轨迹/种子的問題，不是内核的问题）：
  // 越界会被夹住 ⇒ 夹住 = 一段平的静止 = 假温柔，所以位置必须全程在 [0,1] 内。
  assert.ok(gentle.minX > 0 && gentle.maxX < 1 && rough.minX > 0 && rough.maxX < 1,
    `手势轨迹越界被夹住了：温柔 [${gentle.minX}, ${gentle.maxX}] 粗暴 [${rough.minX}, ${rough.maxX}]`);
  assert.ok(gentle.maxSpeed <= HAND_SPEED_POKE,
    `温柔那一侧整段都必须在阈值之下，峰值 ${gentle.maxSpeed}`);
  assert.ok(rough.minSpeed > HAND_SPEED_POKE,
    `戳那一侧整段都必须在阈值之上，谷值 ${rough.minSpeed}`);
  // 然后是内核的三条裁定
  assert.ok(gentle.familiarity > 0.01, `温柔的手必须买到 familiarity，实测 ${gentle.familiarity}`);
  assert.equal(rough.familiarity, 0, `粗暴的手一律不许买 familiarity（实测 ${rough.familiarity}）`);
  assert.ok(rough.dFear > gentle.dFear,
    `粗暴的手要让 fear 涨得比温柔的多：温柔 Δ${gentle.dFear} vs 粗暴 Δ${rough.dFear}`);
});

test('新落下的第一笔读数速度只能是 0（没有历史）；这条把它的代价量出来而不是假装没有', () => {
  // 速度是**窗口内首末位移 / 首末时间差**，所以手势的第一笔没有任何可比的历史 ⇒ 0。
  // 0 ≤ 阈值 ⇒ 内核在那一个 tick 会把这只手当成"温柔"。真实代价必须被量化：
  //   familiarity 的累积率是 0.04 / 秒，一个 tick 就是 0.04 × fixedDt ≈ 0.00067 ——
  //   比一次完整抚摸（2 秒 ≈ 0.08）小两个数量级，且只发生在落下的那一 tick。
  // 写成断言而不是散文：哪天窗口/节流改大（比如 windowMs 300ms），
  // 这段"低读数"的 tick 数会跟着变多，"猛戳会把生物吓一次再逃"就开始成形了，
  // 而这条测试会先给出数字。
  const world = createWorld({ seed: 20261027, driftInterval: Infinity });
  const c = world.creatures[0];
  const t = createHandTracker({});
  const familiar0 = familiarityFor(c.memory, PLAYER_ID);
  // 朝缸中心的方向快戳，保证轨迹不会被 [0,1] 夹住（夹住 = 平的静止 = 假低速）。
  const dir = c.pos.x > 0.5 ? -1 : 1;
  let lowTicks = 0;
  for (let i = 0; i < 12; i++) {                  // 0.2 模拟秒的**纯快戳**
    const x = c.pos.x + dir * (0.05 + i * 0.02);
    t.sample(i * (1000 / 60), x * W, c.pos.y * H, W, H);
    world.playerHand = t.state();
    if (t.state().speed <= HAND_SPEED_POKE) lowTicks += 1;
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(lowTicks, 1, `整段快戳里只有第一笔该读成低速，实测 ${lowTicks} 个 tick`);
  const gained = familiarityFor(c.memory, PLAYER_ID) - familiar0;
  assert.ok(gained > 0, '第一 tick 确实会被当成温柔（这条要量的就是这个，不是"没有"）');
  assert.ok(gained <= 0.04 * CONFIG.fixedDt + 1e-12,
    `启动瞬态买到 familiarity 的上界应当是一个 tick 的量（0.04 × ${CONFIG.fixedDt}），实测 ${gained}`);
});

test('首笔采样的时刻可以是 0 或负数（哨兵值不许落在合法时刻旁边）', () => {
  // B17 实测踩到的真 bug：哨兵原本写成 -1，于是任何 t < -1 的第一笔采样都被
  // 那个单调夹住抬平成 -1 ⇒ 整个窗口只剩 1ms 的时长 ⇒ 0.0035 的位移被读成 3.5/s
  // 的猛戳（阈值 0.25）。症状是"手一落下就把生物吓一跳"，而它只需要一个
  // **从负数开始的时钟**（本文件那条跨层测试的预热就是这么写的）。
  // 浏览器里 performance.now() 非负，所以这条在真机上不会犯 ——
  // 但它钉的是"哨兵与合法取值范围不得重叠"这条一般不变量，改哨兵的人必须先看这里。
  const mk = (times) => {
    const t = tracker();
    for (let i = 0; i < times.length; i++) {
      t.sample(times[i], (0.30 + 0.0005 * i) * W, 0.5 * H, W, H);   // 极慢的划动
    }
    return t.state().speed;
  };
  const slow = 0.0005 * 6 / 0.1;                    // 首末位移 / 首末时间差 = 0.03/s
  const fromZero = mk([0, 16, 33, 50, 66, 83, 100]);
  const fromNegative = mk([-100, -84, -67, -50, -34, -17, 0]);
  assert.ok(Math.abs(fromZero - slow) < 0.01, `从 0 开始的时钟：期望约 ${slow}/s，实测 ${fromZero}`);
  assert.ok(Math.abs(fromNegative - slow) < 0.01, `含负时刻：期望约 ${slow}/s，实测 ${fromNegative}`);
  assert.ok(fromNegative < HAND_SPEED_POKE, `慢划被读成 ${fromNegative} ⇒ 会被判成戳`);
});

test('playerHand 复用同一个对象是安全的：内核把目标点拷成标量，不跨帧持有 pos 引用', () => {
  // input.js 的 out 对象终身复用（spec §5.3），而 behavior 会把手的位置写进 intent.targetPos。
  // 那里若写的是**引用**，下一次 pointermove 就会改掉已经发出去的意图目标点（跨帧别名 bug）。
  const world = createWorld({ seed: 20261025, driftInterval: Infinity });
  const c = world.creatures[0];
  const t = createHandTracker({});
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    t.sample(i * 16, (0.2 + 0.5 * (i % 2)) * W, 0.5 * H, W, H);
    world.playerHand = t.state();
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
    for (const other of world.creatures) {
      const tp = other.intent && other.intent.targetPos;
      if (!tp) continue;
      checked += 1;
      assert.notEqual(tp, world.playerHand && world.playerHand.pos,
        `生物 ${other.id} 的 intent.targetPos 是这只手 pos 的引用 ⇒ 下一帧会被改掉`);
    }
  }
  assert.ok(checked > 0, '一条都没检查到 ⇒ 这条断言在空转');
});

// ---------------------------------------------------------------- boot 接线（唯一的物理通道真的通了吗）

test('boot 之后：一次真实指针手势必须把 world.playerHand 写进内核，抬手必须写回 null', () => {
  const raf = [];
  const target = makeTarget({ clientWidth: 1280, clientHeight: 720 });
  target.getContext = () => ({
    setTransform() {}, clearRect() {}, save() {}, restore() {},
    drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    arc() {}, fill() {}, stroke() {}, fillRect() {},
    createLinearGradient() { return {}; },
    createRadialGradient() { return {}; },
  });
  const fakeWindow = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => () => {},
    removeEventListener: () => {},
  };
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
  };
  g.document = { createElement: () => target };
  g.window = fakeWindow;
  g.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  g.cancelAnimationFrame = () => {};
  try {
    // 不注入手势层本身 —— 这条要验的就是**真的** attachInput 被接上了 boot。
    const controller = boot({ canvas: target, seed: 20261026, renderer: { draw() {}, onResize() {} } });
    const world = controller.world;
    assert.equal(world.playerHand, null, '开缸时手不在缸里');
    assert.ok(controller.input, 'controller 必须暴露 input（性能与台账都靠它取证）');

    const t0 = performance.now();
    target.emit('pointerdown', PEV(640, 360));
    for (let i = 0; i < 200; i++) target.emit('pointermove', PEV(640 + i, 360));
    const step = () => raf[raf.length - 1];
    step()(t0);                                     // 第一帧 frameDt = 0
    step()(t0 + 16.7);                              // 第二帧 ⇒ 消费者 poll 过至少一次

    const hand = world.playerHand;
    assert.ok(hand, 'pointerdown + 帧之后 world.playerHand 必须非空（这条通道真的接通了）');
    assert.ok(hand.pos.x > 0.45 && hand.pos.x < 0.7, `pos 必须是归一化的，实测 ${hand.pos.x}`);
    assert.ok(hand.pos.y > 0.45 && hand.pos.y < 0.55, `pos 必须是归一化的，实测 ${hand.pos.y}`);
    assert.ok(Number.isFinite(hand.speed) && hand.speed >= 0);
    const m = controller.input.tracker.metrics;
    assert.ok(m.inserts <= m.computes + 1, `插入只能发生在 poll：inserts ${m.inserts} vs computes ${m.computes}`);
    assert.ok(m.reads >= 201, `201 个事件应当有 201 次读数，实测 ${m.reads}`);

    target.emit('pointerup', PEV(840, 360));
    assert.equal(world.playerHand, null, '抬手后必须立刻为 null（不等下一帧）');
    controller.stop();
    target.emit('pointerdown', PEV(10, 10));
    step()(t0 + 33.4);
    assert.equal(world.playerHand, null, 'stop 之后解绑了的手不许再写内核');
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
});

test('交付的样本带 down / appeared —— 内核的戳与惊吓只有这一条来源', () => {
  // 这条是**接线断言**，不是功能断言。B17c 在内核里读 h.down 与 h.appeared，
  // 而 input.js 的 out 原本只有 { pos, speed } —— 于是那两条内核路径在真实浏览器里
  // **永远走不到**，全部测试却仍然绿（sim 那边的测试是手搓 playerHand 对象喂进去的）。
  // 这正是本项目在 B16 刚抓过的那一类："纯函数被测到，调用点没被测到"。
  const target = makeTarget();
  const delivered = [];
  const input = attachInput(target, (h) => delivered.push(h && { down: h.down, appeared: h.appeared }),
    { now: () => 1000 });
  target.emit('pointerdown', PEV(300, 200));
  const s1 = input.poll(1000);
  assert.ok(s1, '按下之后第一次 poll 必须交付样本');
  assert.equal(s1.down, true, '样本必须带 down');
  assert.equal(s1.appeared, true, '进缸的第一次交付必须 appeared');
  const s2 = input.poll(1020);
  assert.ok(s2, '第二次 poll 仍然在交付（手还按着）');
  assert.equal(s2.appeared, false, 'appeared 是一次性的，第二次必须落回 false');
  assert.deepEqual(delivered[0], { down: true, appeared: true }, '回调拿到的必须是同一份读数');
  assert.equal(delivered[1].appeared, false);
  input.detach();
});

test('抬手再按下：appeared 再亮一次（每次进缸都算一次"出现"）', () => {
  const target = makeTarget();
  const input = attachInput(target, () => {}, { now: () => 1000 });
  target.emit('pointerdown', PEV(100, 100, 7));
  assert.equal(input.poll(1000).appeared, true, '第一次进缸');
  assert.equal(input.poll(1020).appeared, false);
  target.emit('pointerup', PEV(100, 100, 7));
  assert.equal(input.poll(1040), null, '抬手之后不交付任何样本');
  target.emit('pointerdown', PEV(120, 110, 7));
  assert.equal(input.poll(1060).appeared, true, '第二次进缸必须也算出现');
  input.detach();
});

// ---------------------------------------------------------------- 计划 3 Task 1：按压的起止时刻

test('press 记 downAt；release 之后它必须还在（长按是抬起那一刻才要算时长的）', () => {
  const t = tracker();
  t.press(1000, 100, 100, W, H);
  assert.equal(t.downAt, 1000);
  assert.equal(t.upAt, NO_TIME, '还没抬起，不许有一个"已完成的按压"等着被消费');
  t.release(1600);
  assert.equal(t.downAt, 1000, 'release 把 downAt 抹掉了 ⇒ classifyPress 永远算不出 heldMs');
  assert.equal(t.upAt, 1600);
  assert.equal(t.state(), null, 'state() 抬起后仍然是 null —— 正因如此这两个数不放 out 里');
  t.press(2000, 100, 100, W, H);
  assert.equal(t.downAt, 2000, '下一次按压覆盖起始时刻');
  assert.equal(t.upAt, NO_TIME, '上一把的抬起必须清掉：不清的话消费者会把它当成这一把抬起再算一次');
});

test('脏时钟不许把 NaN 写进 downAt / upAt', () => {
  const t = tracker();
  t.press(NaN, 1, 1, W, H);
  assert.equal(t.downAt, NO_TIME, 'NaN 一旦乘进 heldMs，classifyPress 三档全部走空');
  t.release(undefined);
  assert.equal(t.upAt, NO_TIME);
});

test('attachInput 端到端：一次"整把掉在同一帧之间"的快按，抬起时刻仍然留得住', () => {
  // 这条是 upAt 存在的**全部**理由：poll 每帧一次，而 pointerdown+pointerup
  // 可以整个挤在两个 rAF 之间（手机掉帧时间隙能到 100ms 以上）。
  // 只有 downAt 的话，下一次按下会把它盖掉 —— 症状是"界面偶尔不理人"，最难查的那种。
  let clock = 1000;
  const target = makeTarget();
  const input = attachInput(target, () => {}, { now: () => clock });
  target.emit('pointerdown', PEV(100, 100, 3));
  clock = 1090;
  target.emit('pointerup', PEV(100, 100, 3));
  clock = 1100;
  assert.equal(input.poll(1100), null, '这一帧根本没看见那只手');
  assert.equal(input.tracker.downAt, 1000);
  assert.equal(input.tracker.upAt, 1090);
  assert.equal(input.tracker.upAt - input.tracker.downAt, 90, 'classifyPress 要的就是这个差');
  input.detach();
});

test('抬手之后再来一次按下，前一次的 upAt 被清干净（不重复消费）', () => {
  let clock = 500;
  const target = makeTarget();
  const input = attachInput(target, () => {}, { now: () => clock });
  target.emit('pointerdown', PEV(10, 10, 1));
  clock = 600;
  target.emit('pointerup', PEV(10, 10, 1));
  assert.notEqual(input.tracker.upAt, NO_TIME);
  clock = 700;
  target.emit('pointerdown', PEV(10, 10, 1));
  assert.equal(input.tracker.upAt, NO_TIME, '新的一次按下必须让"上一次已完成"这件事失效');
  input.detach();
});
