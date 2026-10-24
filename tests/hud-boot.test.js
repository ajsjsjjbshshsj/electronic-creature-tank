import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from '../src/main.js';
import { CONFIG } from '../src/config.js';
import { makeDoc, find, findAll } from './dom-stub.js';

// ================================================================ HUD 的 boot 级接线（Task 5）
//
// 纯层（gestures / avatar / hud 的视图模型与挂载）各自有单测；这个文件只管一件事：
// **接线上有没有把世界改坏**。所以这里跑的是真 boot，桩只假到"能开一页"的程度。
//
// 逐字沿用 tests/save-boot.test.js 的那套（Proxy 兜 ctx、手动泵帧、每个碰过的全局都在
// finally 里还原）—— 那套的注释解释了为什么 Proxy 而不是逐个数方法名：绘制层还在加层，
// 逐个数会在下一次加层时假红成"HUD 接线坏了"。

function makeCtx(canvas) {
  const real = {
    canvas,
    measureText: (s) => ({ width: String(s).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(real, {
    get(t, p) {
      if (p in t) return t[p];
      t[p] = function noop() {};
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeCanvasEl(w = 900, h = 620) {
  const el = { width: w, height: h, clientWidth: w, clientHeight: h, style: {}, listeners: {}, captures: [] };
  el.getContext = () => makeCtx(el);
  el.addEventListener = (t, fn) => { (el.listeners[t] || (el.listeners[t] = [])).push(fn); };
  el.removeEventListener = (t, fn) => {
    const a = el.listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  el.setPointerCapture = (id) => el.captures.push(id);
  el.releasePointerCapture = () => {};
  el.emit = (type, ev) => { for (const fn of (el.listeners[type] || []).slice()) fn(ev); };
  return el;
}

// HUD 要一棵真的节点树，而渲染层要 canvas.getContext —— 两者都得从同一个 createElement 出来。
function makeHudDoc() {
  const doc = makeDoc();
  const base = doc.createElement;
  doc.createElement = (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvasEl() : base(tag));
  doc.visibilityState = 'visible';
  doc.listeners = {};
  doc.addEventListener = (t, fn) => { (doc.listeners[t] || (doc.listeners[t] = [])).push(fn); };
  doc.removeEventListener = (t, fn) => {
    const a = doc.listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  return doc;
}

async function withHudTank(opts, fn) {
  const o = opts || {};
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
    warn: console.warn,
  };
  const doc = makeHudDoc();
  const cbs = [];
  g.document = doc;
  g.window = {
    devicePixelRatio: 1, innerWidth: 900, innerHeight: 620,
    matchMedia: () => ({ matches: false }),
    listeners: {},
    addEventListener(t, f) { (this.listeners[t] || (this.listeners[t] = [])).push(f); },
    removeEventListener(t, f) {
      const a = this.listeners[t] || [];
      const i = a.indexOf(f);
      if (i >= 0) a.splice(i, 1);
    },
  };
  g.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  g.cancelAnimationFrame = () => {};
  console.warn = () => {};

  const canvas = makeCanvasEl();
  const bootOpts = { canvas, seed: o.seed === undefined ? 20261022 : o.seed, save: false };
  if ('hud' in o) bootOpts.hud = o.hud;
  if ('audio' in o) bootOpts.audio = o.audio;
  let controller = null;
  let lastT = 0;
  const frame = (dtMs) => { lastT += dtMs === undefined ? 16.7 : dtMs; cbs[cbs.length - 1](lastT); };
  const run = (simSec) => { const n = Math.ceil((simSec * 1000) / 16.7); for (let i = 0; i < n; i++) frame(); };
  const PEV = (x, y, id) => ({ clientX: x, clientY: y, pointerId: id === undefined ? 1 : id });
  // 一次完整的按下+抬起。**同步发**：默认时钟下 heldMs ≈ 0 ⇒ classifyPress 判成 tap。
  const tapAt = (x, y) => { canvas.emit('pointerdown', PEV(x, y)); canvas.emit('pointerup', PEV(x, y)); frame(); };
  try {
    controller = boot(bootOpts);
    return await fn({
      controller, doc, canvas, frame, run, tapAt, boot,
      // 长按没有假时钟可用（attachInput 的 now 走浏览器时钟，见 input.js 的 defaultNow），
      // 所以这里在**抬起之后**直接改写 tracker 的两个时刻字段 —— 手势层对它们只做减法。
      // 顺序要紧：先 emit 再改。反过来改完再 emit 的话，pointerup 里的 release()
      // 会把 upAt 重新写成真实时钟，那一把就又变成 0ms 的"点按"了（第一版就是这么错的）。
      holdAt: (x, y, ms) => {
        canvas.emit('pointerdown', PEV(x, y));
        canvas.emit('pointerup', PEV(x, y));
        const tr = controller.input.tracker;
        tr.upAt = tr.downAt + ms;
        frame();
      },
      screenOf: (c) => ({ x: c.pos.x * controller.viewport.width, y: c.pos.y * controller.viewport.height }),
    });
  } finally {
    if (controller) controller.stop();
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
    console.warn = saved.warn;
  }
}

// 世界的可比投影。**不含** rng 对象本体（它内部有函数），只含可复现的数。
const projection = (w) => JSON.stringify({
  time: w.time,
  creatures: w.creatures.map((c) => [c.id, c.name, c.customName, c.age, c.stage,
    c.pos.x, c.pos.y, c.emotions.joy, c.emotions.anger, c.needs.hunger, c.heard.length,
    c.lineage.offspring.length]),
  eggs: w.eggs.map((e) => [e.id, e.x, e.y]),
  foods: w.foods.map((f) => [f.kind, f.pos.x, f.pos.y]),
});

// ---------------------------------------------------------------- 挂载与"不改世界"

test('boot 之后 HUD 挂在 document.body 上，controller.hud 能拿到', () => withHudTank({}, ({ doc, controller }) => {
  assert.ok(find(doc.body, 'div', 'hud'), 'HUD 没挂上');
  assert.ok(controller.hud, 'controller.hud 不在（设置页与取证都要它）');
  assert.equal(controller.hud.state.card, null);
}));

test('HUD 开着与关着，跑同样的帧 ⇒ 世界逐字段相同（全局约束第 6 条）', async () => {
  // 防"空转"的正确做法不是断言两缸不同（那恰好是要它们**相同**），
  // 而是先证明这一缸在这 20 秒里**真的动了**：出生、移动、需求都在变。
  const on = await withHudTank({}, ({ controller, run }) => {
    const a = projection(controller.world);
    run(20);
    return { a, b: projection(controller.world) };
  });
  assert.notEqual(on.a, on.b, '这 20 秒里世界没动 ⇒ 两缸"相同"是假的，这条在空转');
  const off = await withHudTank({ hud: false }, ({ controller, run }) => {
    run(20);
    return projection(controller.world);
  });
  assert.equal(on.b, off, 'HUD 改变了世界：开了界面，缸就不是那个缸了');
});

test('boot({hud:false}) 时一个 HUD 节点都不建，且点缸不抛', () => withHudTank({ hud: false }, ({ doc, tapAt }) => {
  assert.equal(find(doc.body, 'div', 'hud'), null);
  tapAt(450, 310);
  tapAt(10, 10);
}));

// ---------------------------------------------------------------- 暂停

test('暂停：world.time 冻结，但帧计数与渲染照跑', () => withHudTank({}, ({ controller, frame, run }) => {
  controller.setPaused(true);
  const t0 = controller.world.time;
  const f0 = controller.frame;
  run(5);
  assert.equal(controller.world.time, t0, '暂停了还在推进模拟');
  assert.ok(controller.frame > f0, '暂停不许停掉帧循环：画面与 HUD 要还能响应');
  controller.setPaused(false);
  frame();
  assert.ok(controller.world.time > t0, '恢复之后必须重新推进');
}));

test('暂停**不是** stop：不摘输入、不关音频、rAF 还在排', () => withHudTank({}, ({ controller, doc }) => {
  controller.setPaused(true);
  assert.equal(controller.getPaused(), true);
  assert.ok(find(doc.body, 'div', 'hud'), 'stop() 才会把 HUD 摘掉；暂停不该动界面');
  controller.setPaused(false);
}));

test('暂停时不落盘（模拟时间冻结 ⇒ everySimSec 永远不到）', () => withHudTank({ save: true }, ({ controller, run }) => {
  controller.save.clearSave?.();
  controller.setPaused(true);
  run(120);
  assert.equal(controller.saveState.writes, 0, '暂停期间写了档：暂停的那段被存进去了');
}));

test('暂停时按倍速键仍然生效（两件事不互相覆盖）', () => withHudTank({}, ({ controller, run }) => {
  controller.setPaused(true);
  controller.setTimeScale(4);
  run(2);
  assert.equal(controller.getTimeScale(), 4);
  assert.equal(controller.world.time, 0, '倍速生效也不许在暂停时推进');
}));

// ---------------------------------------------------------------- 手势分发

test('点按一只 ⇒ 打开它的信息卡；点空白 ⇒ 关掉', () => withHudTank({}, ({ controller, tapAt, screenOf }) => {
  const c = controller.world.creatures[0];
  tapAt(screenOf(c).x, screenOf(c).y);
  assert.equal(controller.hud.state.card && controller.hud.state.card.id, c.id);
  tapAt(4, 4);
  assert.equal(controller.hud.state.card, null, '点空白没关卡');
}));

test('长按缸内空白 ⇒ 撒食；长按某只 ⇒ 开它的卡并聚焦改名框', () => withHudTank({}, ({
  controller, holdAt, screenOf, doc,
}) => {
  // 不比 foods.length：缸里的个体会**吃**，那个数在测试期间自己就会掉。
  // 比 hudStats（投食成功的次数）与"新食物的位置就在手指那儿"。
  const s0 = controller.hudStats.scatters;
  holdAt(20, 20, 900);
  assert.ok(controller.hudStats.scatters > s0, '长按撒食没记到账上');
  const near = controller.world.foods.filter((f) => Math.abs(f.pos.x - 20 / 900) < 0.05
    && Math.abs(f.pos.y - 20 / 620) < 0.06);
  assert.ok(near.length >= 1, `投到了别处：${JSON.stringify(controller.world.foods.map((f) => f.pos))}`);
  const c = controller.world.creatures[0];
  holdAt(screenOf(c).x, screenOf(c).y, 900);
  assert.equal(controller.hud.state.card.id, c.id);
  const focused = doc.__focused;
  assert.ok(focused && focused._class.has('hud-name'), '长按没把光标落到改名框上');
}));

test('划动 ⇒ 沿路径撒几颗，而不是弹改名框', () => withHudTank({}, ({ controller, canvas, frame }) => {
  const s0 = controller.hudStats.scatters;
  canvas.emit('pointerdown', { clientX: 100, clientY: 300, pointerId: 1 });
  for (let x = 110; x <= 400; x += 30) {
    canvas.emit('pointermove', { clientX: x, clientY: 300, pointerId: 1 });
    frame();
  }
  canvas.emit('pointerup', { clientX: 400, clientY: 300, pointerId: 1 });
  const tr = controller.input.tracker;
  tr.upAt = tr.downAt + 30;
  frame();
  assert.ok(controller.hudStats.scatters > s0, '拖拽投食什么都没投');
  assert.equal(controller.hud.state.card, null, '拖个路过的食物就把信息卡弹出来');
}));

test('溶散中的那一只点不开（卡上会是一张空壳）', () => withHudTank({}, ({ controller, tapAt, screenOf }) => {
  const c = controller.world.creatures[0];
  c.alive = false; c.stage = 'dead'; c.dying = 0.4;
  const s = screenOf(c);
  tapAt(s.x, s.y);
  assert.equal(controller.hud.state.card, null);
}));

// ---------------------------------------------------------------- 讲进去 / 改名 / 投食

test('讲给它听：hear() 第一次有生产者 —— 卡里那只的 heard 长了，且**只**长它', () => withHudTank({}, ({ controller }) => {
  const a = controller.world.creatures[0];
  const b = controller.world.creatures[1];
  controller.hud.setCard(a, controller.world);
  const before = a.heard.length;
  const otherBefore = b.heard.length;
  controller.hud.tell('宝宝今天也要好好吃饭哦');
  assert.ok(a.heard.length > before, '一个词都没存进去');
  assert.equal(b.heard.length, otherBefore, '话传给别的只了');
  assert.equal(controller.hudStats.tells, 1);
}));

test('一次按压只被消费一次：upAt 的比较必须是"更新"而不是"不相等"', () => withHudTank({}, ({ controller, tapAt, screenOf, frame }) => {
  // 用 >= 的话，抬起之后的**每一帧**都会把同一把按压重新分发一遍：
  // 症状是"点一下开卡"变成"点一下之后卡反复开关"，以及投食被重复投。
  const c = controller.world.creatures[0];
  tapAt(screenOf(c).x, screenOf(c).y);
  const g0 = controller.hudStats.gestures;
  frame(); frame(); frame(); frame();
  assert.equal(controller.hudStats.gestures, g0, '同一把按压被消费了多次');
  assert.equal(controller.hud.state.card.id, c.id);
}));

test('speechEnabled=false 时**仍然听得进**：输入是玩家的动作，不是输出', () => withHudTank({}, ({ controller }) => {
  controller.world.speechEnabled = false;
  const a = controller.world.creatures[0];
  controller.hud.setCard(a, controller.world);
  const before = a.heard.length;
  controller.hud.tell('听得见吗');
  assert.ok(a.heard.length > before, '把输入也一起关了 = 玩家讲的话掉在地上');
}));

test('没开卡时 tell 被丢弃并计数，世界一个字节都不动', () => withHudTank({}, ({ controller }) => {
  const before = projection(controller.world);
  controller.hud.tell('对着空缸说话');
  assert.equal(controller.hud.state.tellDropped, 1);
  assert.equal(projection(controller.world), before);
}));

test('投食走 spawnFood：投的是点的那种，且撞上限时**计数**而不是静默失败', () => withHudTank({}, ({ controller, doc }) => {
  const n0 = controller.world.foods.length;
  const btn = findAll(doc.body, 'button', 'hud-feed').find((b) => b.dataset.kind === 'nectar');
  btn.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.world.foods.length, n0 + 1);
  assert.equal(controller.world.foods[controller.world.foods.length - 1].kind, 'nectar');
  assert.equal(controller.hudStats.feeds, 1);
  while (controller.world.foods.length < CONFIG.foodMax) controller.world.foods.push({ id: 'x', kind: 'algae', pos: { x: 0.5, y: 0.5 }, amount: 1 });
  btn.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.world.foods.length, CONFIG.foodMax, '撞上限还塞 = 破 §9.2 第 1 条的不爆缸');
  assert.ok(controller.hudStats.foodRejected >= 1, '被拒的一次没计数 = 静默丢失');
}));

test('改名：customName 置真 + name 换掉；空名字那一次什么都不动', () => withHudTank({}, ({ controller }) => {
  const c = controller.world.creatures[0];
  const old = c.name;
  controller.hud.setCard(c, controller.world);
  controller.hud.rename(c, '小星');
  assert.equal(c.name, '小星');
  assert.equal(c.customName, true, 'customName 是它的第一个生产者（消费者在 Task 6 的去重）');
  controller.hud.rename(c, '   ');
  assert.equal(c.name, '小星', '空名字把已有的抹掉 = 一次误触丢名字');
  assert.equal(controller.hudStats.rejectedNames, 1);
}));

test('静音与倍速两个键真的落到 controller 上（不是 HUD 自己的记账）', () => withHudTank({
  audio: (() => {
    let m = true;
    return { getMuted: () => m, setMuted: (v) => { m = !!v; }, consume() {}, close() {} };
  })(),
}, ({ controller, doc }) => {
  const mute = find(doc.body, 'button', 'hud-mute');
  assert.ok(mute, '有音频时静音键必须在（spec §5.4 右上角那颗）');
  mute.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.getMuted(), false, '按了静音键，controller 却说没变');
  mute.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.getMuted(), true);
  const two = findAll(doc.body, 'button', 'hud-scale').find((b) => b.textContent === '2×');
  two.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.getTimeScale(), 2);
}));

test('音频不可用时按静音键**不撒谎**：getMuted 仍然说听不见', () => withHudTank({}, ({ controller, doc }) => {
  // 没有 audio（懒创建要等一次真实手势），controller.setMuted 按 main.js 里那条
  // "返回当前事实而不是抛"的契约工作。这条测试钉的是：HUD 不会自顾自把按钮点亮。
  const mute = find(doc.body, 'button', 'hud-mute');
  assert.ok(mute, '还没试过音频时按钮要在（第一次真实手势就会创建）');
  mute.listeners.click[0]({ preventDefault() {} });
  assert.equal(controller.getMuted(), true, '没音频却说"已取消静音" = 骗人');
}));

// ---------------------------------------------------------------- 收尾

test('stop() 把 HUD 摘干净，之后再按按钮不抛', () => withHudTank({}, ({ controller, doc }) => {
  controller.stop();
  assert.equal(find(doc.body, 'div', 'hud'), null, '缸停了界面还挂着');
  controller.hud.pressScale(2);
  controller.hud.pulse(0);
}));

test('图片在开缸时就交出去八张，且不含那张重复的 character.png', () => withHudTank({}, ({ controller }) => {
  assert.equal(controller.hud.preload.length, 8);
  assert.ok(!controller.hud.preload.some((s) => s.includes('character')),
    'wink 与 character 是同一张图（md5 相同），加载两次 = 白拉 315KB');
}));

test('HUD 每帧真的被喂到了：左上读数跟着世界变（钉住 step 末尾那一眼）', () => withHudTank({}, ({ controller, doc, run }) => {
  const readout = find(doc.body, 'div', 'hud-readout');
  const nums = findAll(readout, 'span', 'hud-num');
  assert.equal(nums.length, 3, '读数应该是 种群 / 食物 / 卵 三个数');
  run(2);
  assert.equal(nums[0].textContent, String(controller.world.creatures.length),
    '帧循环没把 world 交给 HUD：读数会永远停在 0');
  // 再吃掉一颗食物之后数字要动（证明不是"只在挂载时写了一次"）。
  const before = nums[1].textContent;
  controller.world.foods.push({ id: 'zz9', kind: 'nectar', pos: { x: 0.5, y: 0.5 }, amount: 1 });
  run(1);
  assert.notEqual(nums[1].textContent, before, '读数只写了一次：HUD 没在每帧被喂');
}));

test('听词走 speechRng：模拟主流一次都不许被碰（全局约束第 7 条）', () => withHudTank({}, ({ controller }) => {
  // ⚠️ 这条换过写法。第一版是"两缸同种子、只差一次 tell，比之后抽的三个数"，
  // 结果"tell 改成走 world.rng"那道探针**活着**：那只个体的 curious 让
  // selectCandidates 走了 `uniq.length <= n` 的早退分支，一次随机数都没消费，
  // 于是两缸当然相同 —— 判据不是弱，是**根本没跑到那条路径上**。
  // 另外 speechRng 那道"必须不同"也是假的：tell 改了 heard ⇒ 之后出词不同 ⇒ 消耗自然不同，
  // 它测的并不是"hear 从哪儿抽的数"。
  // 现在不比结果，**直接数调用**：两个 rng 各包一层计数器。
  const a = controller.world.creatures[0];
  a.traits.personality.curious = 0;          // n = round(takeBase + 0×takeGain) = 1，候选远多于 1 ⇒ 必抽样
  const counted = (rng) => {
    const box = { n: 0 };
    const wrap = {};
    for (const k of Object.keys(rng)) {
      if (typeof rng[k] !== 'function') { wrap[k] = rng[k]; continue; }
      wrap[k] = (...args) => { box.n += 1; return rng[k](...args); };
    }
    return [wrap, box];
  };
  const [mainWrap, mainBox] = counted(controller.world.rng);
  const [speechWrap, speechBox] = counted(controller.world.speechRng);
  const realMain = controller.world.rng;
  const realSpeech = controller.world.speechRng;
  controller.hud.setCard(a, controller.world);
  controller.world.rng = mainWrap;
  controller.world.speechRng = speechWrap;
  const heard0 = a.heard.length;
  controller.hud.tell('宝宝今天也要好好吃饭哦 记得多喝水呀');
  controller.world.rng = realMain;
  controller.world.speechRng = realSpeech;
  assert.ok(a.heard.length > heard0, '一个词都没存下 ⇒ 这条测试在空转');
  assert.equal(mainBox.n, 0,
    `tell 碰了模拟主流 ${mainBox.n} 次 ⇒ "关掉文字层世界逐字节相同"那条承诺当场作废`);
  assert.ok(speechBox.n > 0,
    `speechRng 一次都没被消费（${speechBox.n}）⇒ hear 没走到抽样，上面那个 0 是假的`);
}));
