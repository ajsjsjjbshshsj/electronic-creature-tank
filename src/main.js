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
//   · createViewport / CONFIG.render：config.test.js 用精确相等钉住 CONFIG 的键集
//     （当时 41 键 / 39 节点），B11 不许动它 ⇒ 视口缩放段随渲染层（B13）一起加。
//     ✅ B13（2026-10-21）已交付：createViewport 在下面，CONFIG.render 十五个旋钮，
//     键集快照同步到 47 键 / 45 节点（数出来的）。
//   · 临时调试圆点：B11 不画任何东西，页面此时就是 CSS 渐变空缸（预期状态）。
//     ✅ B13 起画的是真水体（微粒 / 光束 / 沉积带），临时调试点从未落地过，无需删除。
//
// B12（2026-10-21）接上的部分：软体子步进。
//   updateBodies 被放进下面的子步循环，喂 CONFIG.fixedDt 而不是 frameDt ——
//   弹簧积分与尾巴松弛都是显式积分，**不具**步长无关性，放在渲染帧率下会让
//   高刷屏上的身体更硬、低刷屏上更软。这条纪律由 tests/body.test.js 的
//   「main.js 把 updateBodies 放进子步循环」与「一个 1 秒大步 ≠ 六十个小步」两条一起守。
//
// B13（2026-10-21）接上的部分：渲染层。
//   createRenderer 靠**依赖注入**拿离屏画布（makeCanvas 工厂），所以 src/render.js
//   自己一个浏览器全局都不碰、继续在 Node 里被单测（tests/constraints.test.js 的
//   DOM 扫描因此仍然覆盖它）。本文件是七个浏览器全局名唯一允许出现的地方。
//
// B17（2026-10-21）接上的部分：手。
//   attachInput 同样靠依赖注入拿监听目标，所以 src/input.js 也留在纯度守卫里。
//   它带来的唯一一条新纪律是**频率解耦**：指针事件只更新一个读数，
//   下面的 step() 才是消费者（input.poll(t)，每帧一次）。
//   除此之外本文件仍然只写 world.playerHand 那一个字段 —— 那是内核明文允许的唯一例外。

import { CONFIG } from './config.js';
import { createWorld, tickWorld } from './sim.js';
import { updateBodies, reconcileBodies } from './body.js';
import { createRenderer, consumeEvents } from './render.js';
import { attachInput } from './input.js';

// ---------------------------------------------------------------- 纯逻辑（可在 Node 测）

// 视口与缩放（spec §3.4-2）。
// scale 是"世界单位 → CSS 像素"，dpr 是"CSS 像素 → 设备像素"，两者**不可混用**：
// 混了会让高分屏上的生物大得离谱（3× dpr 的手机变成 3 倍体型）。
// 纯函数、不碰任何浏览器对象 ⇒ tests/render.test.js 直接断言它的 clamp 行为。
export function createViewport(cssWidth, cssHeight, dpr) {
  const short = Math.min(cssWidth, cssHeight);
  const R = CONFIG.render;
  let scale = short / R.scaleRef;
  if (scale < R.scaleMin) scale = R.scaleMin;
  if (scale > R.scaleMax) scale = R.scaleMax;
  return { width: cssWidth, height: cssHeight, dpr, scale };
}

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

  // viewport 只存几何量（width/height/dpr/scale）。scale 是"世界单位 → CSS 像素"，
  // 由短边推导并 clamp（spec §3.4-2，算法在下面的 createViewport 里，Node 可测）。
  // ⚠️ 它是**同一个对象被原地改写**（见 resize）：渲染层持有它的引用，
  // 换成新对象就会让 renderer.viewport 指到一份过期几何上。
  const viewport = { width: 0, height: 0, dpr: 1, scale: 1 };
  const loop = { acc: 0, steps: 0 };
  // Body 表：id → 软体状态（视状态，不进存档）。一次创建、终身复用同一个 Map，
  // 里面只在出生时增长 —— 见 body.js 的 updateBodies / reconcileBodies 注释。
  const bodies = new Map();
  const state = { frame: 0, timeScale: 1, lastT: -1, rafId: 0, running: true };

  // 渲染层（B13：水体层；B14：生物六层）。options.renderer 的注入口保留 —— 测试要用 spy 替掉它。
  // makeCanvas 是本文件**唯一**允许创建可绘制对象的地方：render.js 拿到的是
  // { ctx, surface }，surface 直接喂 drawImage，所以那个模块里不需要任何浏览器全局。
  // B14 起这条注入被两类东西共用：水体的静态 sprite（随 resize 重建）与
  // 身体的 sprite（光晕 32 张 + 碎边 2 张 + 本体/亮区的惰性缓存）——
  // 后者与视口尺寸无关，**只建一次**，尺寸变化靠 drawImage 的缩放与 setTransform 的矩阵。
  // 症状对比：如果把身体 sprite 也搬进 resize 里重建，拖动一次窗口就重画几十张离屏，
  // 而它换来的画面和上一次一模一样。
  const renderer = options.renderer || createRenderer({
    makeCanvas: (w, h) => {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      return { ctx: off.getContext('2d'), surface: off };
    },
    // 水体偏移量（每颗粒的半径、速度、alpha、相位）必须来自注入的 rng，
    // 不许用 Date.now 或下标哈希凑 —— 那会让同一份存档在两台设备上长出不同的水。
    // ⚠️ rng.fork() 不接受参数（见 src/rng.js：分叉只从父流自己的状态推），
    // 所以旧计划写的 fork(seed ^ 0x9e37) 里那个参数是**空写的**，不搬。
    rng: world.rng.fork(),
    viewport,
    isMobile: coarse,
  });
  const audio = options.audio || null;
  // 手（B17）：玩家与缸之间**唯一**的物理通道。
  //
  // attachInput 靠**依赖注入**拿监听目标（这里传进来的就是那个全屏绘制元素），
  // 所以 src/input.js 里一个浏览器全局都不出现、继续在纯度守卫覆盖范围内、
  // 继续在 Node 里用合成事件单测。本文件是那七个名字唯一允许出现的地方。
  //
  // onHand 只做一件事：把 { pos, speed }（或 null）交给那个唯一可写的字段。
  // 坐标是归一化 [0,1]²、速度是归一化单位/秒 —— 单位口径由 input.js 定义，内核消费。
  //
  // ⚠️ 复用 input.js 内部那个 out 对象是**安全的**，但安全性来自两侧各做对了一半：
  //   · 内核在感知层把 speed 与 dist 拷成**标量**、把 pos 按引用搬过去后立刻在本 tick 用完；
  //   · 决策层写意图目标点时取的是 .x / .y 两个标量（不是 pos 引用）。
  //   两件事各由 tests/input.test.js 的一条钉住（「复用同一个对象是安全的」那条）。
  //   哪天内核改成把 senses.playerHand.pos 存进跨帧结构，这里就必须改成每次交付一份拷贝。
  const input = options.input || attachInput(canvasEl, (hand) => {
    world.playerHand = hand;
  }, {
    // 尺寸来源用**已有的视口**而不是元素的 clientWidth：
    // 那样手势期间一次布局读取都没有（input.js 默认会读元素尺寸，那是给
    // 没有视口对象的调用方用的；这里有更便宜的东西）。
    getSize: () => viewport,
  });

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvasEl.clientWidth || window.innerWidth;
    const cssH = canvasEl.clientHeight || window.innerHeight;
    const next = createViewport(cssW, cssH, dpr);
    viewport.width = next.width;
    viewport.height = next.height;
    viewport.dpr = next.dpr;
    viewport.scale = next.scale;
    // 位图尺寸 = CSS 尺寸 × dpr，否则高分屏上画面发虚。
    // ⚠️ 这里**不碰任何 c.pos**：位置是归一化的 [0,1]²，世界尺寸恒等于视口，
    // 所以视口变化时归一化坐标的含义没变，spec §3.4-2 那句"按新旧尺寸比例映射所有位置"
    // 在本设计下是**空操作**。真要"补"一个位置重映射反而会引入 bug：
    // 每次 resize 都把整缸乘一个比例，来回拖几次窗口就把它们全推进角落。
    // 这条由 tests/render.test.js 的「resize 不重映射任何 c.pos」逐位钉住。
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    if (renderer && renderer.onResize) renderer.onResize(viewport, world.rng.fork());
  };

  const step = (t) => {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(step);

    // 第一帧没有"上一帧时刻"，frameDt 取 0 而不是 t（否则第一帧会补算从纪元到现在的秒数）
    const frameDt = state.lastT < 0 ? 0 : Math.min(1, (t - state.lastT) / 1000);
    state.lastT = t;

    // 手：**每帧一次**消费指针读数（B17 的纪律 4）。
    // 指针事件的上报频率可以远高于 60Hz（手机 120–240Hz、部分鼠标 1000Hz），
    // 而生物按 CONFIG.fixedDt 走 —— 两者必须解耦，否则每秒上千次采样插入与速度重算。
    // 事件里只写一个读数（input.js 的 observe），这里才是唯一的消费者，
    // 所以上界是"重活次数 ≤ 帧数"。那条 1000 事件的测试钉的就是这个形状。
    // ⚠️ 放在 advanceLoop **之前**：本帧的子步必须看得见最新的手，
    // 放在之后会让"手进缸"的那一帧里所有生物都还在按旧位置决策（读起来慢半拍）。
    input.poll(t);

    const steps = advanceLoop(loop, frameDt, state.timeScale);
    for (let i = 0; i < steps; i++) {
      tickWorld(world, CONFIG.fixedDt);
      updateBodies(bodies, world, CONFIG.fixedDt);
    }
    // 清扫放在子步循环**之外**：增员由 updateBodies 就地完成（卵可能在一个子步中间孵化，
    // 等下一帧就晚了一帧），只有减员需要按世界成员身份扫一遍，而它是每帧一次的事。
    if (steps > 0) reconcileBodies(bodies, world);

    state.frame += 1;

    // 绘制。canvas 保持透明，水体渐变由 CSS 的 body 背景透出（spec §3.4-5），
    // 所以这里只清空、不填背景色。B13 画水体三层，B14 起在同一 ctx 上叠生物六层
    //（光晕 / 不透明本体 / 花纹 / 体内亮区 / 尾巴 / 毛尖碎边），
    // 层序写在 render.js 的 draw() 里：水在下、生物在中、B16 的溶散与 B19 的气泡在中上。
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    // ⚠️ 喂给渲染层的 dt 必须是**模拟**秒数（本帧子步数 × fixedDt），不是 frameDt。
    // 传 frameDt 的症状是"4× 倍速下缸在快进而水冻在原速、0.5× 下水体反而比生物快"，
    // 不报错、不影响模拟，只有一屏动画不对 —— 由 tests/render.test.js 的一条直接钉。
    const simDt = loop.steps * CONFIG.fixedDt;
    if (renderer) renderer.draw(ctx, world, bodies, viewport, simDt);

    // 事件消费（B16 接溶散粒子、B18 接叫声、B19 接气泡）。
    // ⚠️ 必须每帧清空：world.events 是**无界增长**的（sim.js 只写不读、不代为清理），
    // 开一小时的标签页会把它涨到几十万条，然后每帧遍历它。
    // ⚠️ 清空由**这里**做、消费方一律不清空：renderer 与 audio 读同一批事件，
    // 谁先清空谁就把事件从另一个人手里抢走了（render.js 的 consumeEvents 顶部那条）。
    // 这就是 B16 已经在接、而 audio 要到 B18 才存在也不能改成"audio 自己清"的原因。
    if (world.events.length > 0) {
      if (renderer) consumeEvents(renderer, world.events);
      if (audio) audio.consume(world.events, world);
    }
    world.events.length = 0;
  };

  const controller = {
    world,
    viewport,
    bodies,
    input,           // B17：暴露给 devtools 与测试取证（metrics 里那三个计数器）
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
      // 解绑监听并把那只手从世界里**拿走**（onHand(null) 由 detach 内部送）。
      // 少这一步的症状：stop 之后 world.playerHand 还留在最后一次按下的位置上，
      // 而 main.js 已经不推进了 —— 计划 3 若复用同一个 world 做快照/换缸就会带进去。
      input.detach();
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
