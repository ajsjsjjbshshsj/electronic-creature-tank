// main.js —— 页面入口，也是**唯一**被允许触碰浏览器 API 的模块。
//
// 它做四件事：
//   1. 装配世界（createWorld）与表现层挂钩（renderer / audio / input，B12–B19 接入）
//   2. 用固定步长累加器推进 tickWorld，倍速靠**子步进**实现
//   3. resize 时重算 canvas 位图尺寸与视口
//   4. 每帧清空 world.events（内核只写不读，见 sim.js 模块头第 2 条）
//
// 边界：除了 world.playerHand（内核唯一接受表现层写入的字段，见 sim.js 的 createWorld），
// 本文件**不写任何内核状态**。不改 c.pos、不改 c.emotions、不直接调 adjustMemory。
//
// ⚠️ 本文件在 Node 里也能被 import：顶层只有函数定义与一个 typeof 守卫，
// 不会执行任何 DOM 代码。tests/loop.test.js 依赖这一点来测 advanceLoop。
//
// 相对旧计划 Task 3 的删减（2026-10-21 B11 落地时，均有台账记录）：
//   · createViewport / CONFIG.render：config.test.js 用精确相等钉住 CONFIG 键集
//     （41 键 / 39 节点），B11 不许动它 ⇒ 视口缩放段随渲染层（B13）一起加。
//   · reconcileBodies / 软体子步进：src/body.js 是 B12 的交付物，还不存在。
//     B12 接弹簧时，updateBody 必须放进下面的子步循环（固定步长），不是渲染帧率。
//   · 临时调试圆点：B11 不画任何东西，页面此时就是 CSS 渐变空缸（预期状态）。

import { CONFIG } from './config.js';
import { createWorld, tickWorld } from './sim.js';

// ---------------------------------------------------------------- 纯逻辑（可在 Node 测）

// 原地修改，不返回新对象。
//
// 这个 API 形状是刻意的：返回 { acc, steps } 看起来更"纯"，但那是**每帧一次分配**，
// 而 spec §5.3 把"运行时不分配对象"列为硬约束。60fps 下每秒 60 个小对象
// 足以在低端手机上变成可感知的 GC 卡顿 —— 而且它不会出现在任何 profile 的热点里，
// 只会表现为"偶尔掉帧"，极难归因。
//
// 封顶语义：丢弃超出的时间，而不是留着慢慢追（spec §3.4-1）。
// 追的话标签页从后台恢复时缸会"快进"到当下，玩家看到的是一缸生物瞬移。
//
// ⚠️ 倍速**只许**乘进累加器（靠子步进多出 tick），绝不许改成放大 tickWorld 的 dt：
// emotions.update 是前向欧拉 k = min(1, inertia*dt)，不具步长无关性，
// 放大 dt 会把 1 模拟秒的情绪从 0.802441 推成 0.815837（偏差 1.6693%），
// 而这一偏差只在情绪层，肉眼与统计断言都看不出来。
// 由 tests/loop.test.js「4× 子步进的世界与直接连跑逐位相同」反向钉死。
export function advanceLoop(loop, frameDt, timeScale) {
  let acc = loop.acc + frameDt * timeScale;
  if (acc > CONFIG.dtAccumCap) acc = CONFIG.dtAccumCap;
  let steps = 0;
  while (acc >= CONFIG.fixedDt) {
    acc -= CONFIG.fixedDt;
    steps += 1;
  }
  loop.acc = acc;
  loop.steps = steps;
  return steps;
}

// ---------------------------------------------------------------- 活动 controller

let activeController = null;

// 供 devtools 与计划 3 的 HUD 调用（计划 2 刻意不做 HUD，见"范围边界"）。
export function setTimeScale(scale) {
  if (!activeController) throw new Error('setTimeScale: 缸未在运行（boot 尚未调用或已 stop）');
  activeController.setTimeScale(scale);
}

export function getTimeScale() {
  if (!activeController) throw new Error('getTimeScale: 缸未在运行（boot 尚未调用或已 stop）');
  return activeController.getTimeScale();
}

// ---------------------------------------------------------------- 装配（浏览器侧）

export function boot(opts) {
  const options = opts || {};
  const canvasEl = options.canvas || document.getElementById('tank');
  if (!canvasEl) throw new Error('boot: 找不到 <canvas id="tank">');
  const ctx = canvasEl.getContext('2d');

  // 手机/桌面决定种群上限（CONFIG.populationCap 是 {desktop, mobile}，不是标量）。
  // ⚠️ 只在创建世界时判定一次：populationCap 写进 world 之后不再随 resize 改变，
  // 否则把窗口拖窄就会**杀掉**已有的生物。
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const cap = options.populationCap
    || CONFIG.populationCap[coarse ? 'mobile' : 'desktop'];

  // 种子：不给就用启动时刻。用 Date.now 而不是 Math.random ——
  // 后者被 tests/constraints.test.js 全局禁止，而"每次开缸都不一样"是想要的行为，
  // 时间源足以提供它，且计划 3 会把 seed 存进 save.json 以便复现。
  const seed = options.seed !== undefined ? options.seed : (Date.now() >>> 0);
  const world = createWorld({ seed, populationCap: cap });

  // viewport 只存几何量；世界单位→像素的 scale 属渲染层（B13），
  // 它依赖的 CONFIG.render 因 config.test.js 的键集快照无法在本 Task 加入。
  const viewport = { width: 0, height: 0, dpr: 1 };
  const loop = { acc: 0, steps: 0 };
  const state = { frame: 0, timeScale: 1, lastT: -1, rafId: 0, running: true };

  // 渲染层与音频在 B12–B18 接进来；本 Task 刻意不画任何东西（空渐变是预期状态）。
  const renderer = options.renderer || null;
  const audio = options.audio || null;
  const detachInput = options.detachInput || null;

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvasEl.clientWidth || window.innerWidth;
    const cssH = canvasEl.clientHeight || window.innerHeight;
    viewport.width = cssW;
    viewport.height = cssH;
    viewport.dpr = dpr;
    // 位图尺寸 = CSS 尺寸 × dpr，否则高分屏上画面发虚。
    // ⚠️ 这里**不碰任何 c.pos**：位置是归一化的 [0,1]²，世界尺寸恒等于视口，
    // 所以视口变化时归一化坐标的含义没变，spec §3.4-2 那句"按新旧尺寸比例映射所有位置"
    // 在本设计下是**空操作**。真要"补"一个位置重映射反而会引入 bug：
    // 每次 resize 都把整缸乘一个比例，来回拖几次窗口就把它们全推进角落。
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    if (renderer && renderer.onResize) renderer.onResize(viewport);
  };

  const step = (t) => {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(step);

    // 第一帧没有"上一帧时刻"，frameDt 取 0 而不是 t（否则第一帧会补算从纪元到现在的秒数）
    const frameDt = state.lastT < 0 ? 0 : Math.min(1, (t - state.lastT) / 1000);
    state.lastT = t;

    const steps = advanceLoop(loop, frameDt, state.timeScale);
    for (let i = 0; i < steps; i++) {
      tickWorld(world, CONFIG.fixedDt);
    }

    state.frame += 1;

    // 绘制。B11 只清帧不画内容：canvas 保持透明，水体渐变由 CSS 的 body 背景透出
    // （spec §3.4-5）。B12–B14 在这里接 renderer.draw。
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    if (renderer) renderer.draw(ctx, world, viewport, state.frame);

    // 事件消费（B16 接溶散动画、B18 接叫声、B19 接气泡）。
    // ⚠️ 必须每帧清空：world.events 是**无界增长**的（sim.js 只写不读、不代为清理），
    // 开一小时的标签页会把它涨到几十万条，然后每帧遍历它。
    if (audio && world.events.length > 0) audio.consume(world.events, world);
    world.events.length = 0;
  };

  const controller = {
    world,
    viewport,
    get frame() { return state.frame; },
    setTimeScale(scale) {
      // 只接受 CONFIG.timeScales 里的值：随手写个 3 或 10 会让子步进数暴涨，
      // 而 spec §3.4-1 的固定步长保证也就跟着失效了。
      if (!CONFIG.timeScales.includes(scale)) {
        throw new Error(`setTimeScale: ${scale} 不在 CONFIG.timeScales [${CONFIG.timeScales.join(', ')}] 里`);
      }
      state.timeScale = scale;
    },
    getTimeScale() { return state.timeScale; },
    stop() {
      state.running = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (detachInput) detachInput();
      if (audio && audio.close) audio.close();
      window.removeEventListener('resize', resize);
      if (activeController === controller) activeController = null;
    },
  };

  window.addEventListener('resize', resize);
  resize();
  activeController = controller;
  state.rafId = requestAnimationFrame(step);
  return controller;
}

// 自动启动。守卫让本模块在 Node 里 import 时**不执行**任何 DOM 代码 ——
// tests/loop.test.js 依赖这一点。
//
// ⚠️ globalThis.__tank 是计划 2 的临时手段：没有 HUD，所以倍速/静音只能在 devtools 里调。
// 计划 3 加了 HUD 之后应当删掉它（或者留着当调试入口，但要写进文档）。
if (typeof globalThis.document !== 'undefined') {
  globalThis.__tank = boot();
}
