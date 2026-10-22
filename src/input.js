// input.js —— 指针采样与「手」的状态（spec §6.1 的**最小**子集）。
//
// 这是玩家与缸之间**唯一**的物理通道，产物也只有一个东西：
// 交给内核的 `{ pos: {x, y}, speed } | null`（内核那边把它挂在一个只接受表现层
// 写入的字段上；除那一个字段之外，本文件不知道、也不许知道任何别的内核状态）。
//
// 范围：只做「指针 → 读数 → 速度」。
// **不做**拖拽投食、长按撒食、点按信息卡、长按改名、捏合缩放 —— 前四项属计划 3
// （spec §6.1 的手势表有六行，一个速度阈值分不开它们），后者是 spec §10 的明文范围外项。
//
// 为什么最小手势也必须进本计划：spec §9.2 第 1 条验收依据（"看出它在卖萌"）的触发链
// 需要 playerApproach，playerApproach 需要那只手非空。**没有手，第 1 条在原理上不可能达成。**
//
// 纯逻辑模块：监听目标由 attachInput 的**形参**传入，所以本文件的代码里
// document / window / 那七个名字一个都不出现，于是它继续留在 tests/constraints.test.js
// 的纯度扫描范围内、并且能在 Node 里用**合成事件**单测（tests/input.test.js 就是这么做的）。
//
// 本文件**零 import**（由一条源码测试钉住）。三条理由：
//   1. 它只产出数据，不需要认识世界，也不需要认识任何阈值 —— 因此不可能出现
//      第二份"戳"的速度阈值。内核那个阈值有三处消费者，必须同源（behavior.js 文件头
//      专门解释了这件事），而"阈值只有一个定义点"最省事的保证方式就是让产出速度的
//      这一层**根本看不到阈值**。
//   2. 于是速度窗口、缓冲长度、节流间隔这些**输入层自己的**几何参数就留在本文件里，
//      它们不是游戏性常量（改它们不会改变缸里任何一只生物的裁定口径，只会改变读数的
//      灵敏度），搬进 CONFIG 反而会把两个口径混成一个。
//   3. 零 import 也让 Node 侧与浏览器侧的构造成本完全一致，没有"测试里恰好没连上"的缝隙。
//
// ⚠️ speed 的单位是**归一化世界单位 / 秒**（不是 CSS 像素/秒、也不是每帧位移）。
//   · 必须是归一化：内核把手的位置与生物的位置放在同一个 [0,1]² 里算距离。
//   · 必须是**每秒**：内核的粗糙阈值是每秒口径的数，写成每帧位移会在 60Hz 下被除掉 60 倍，
//     症状是"永远戳不出来"（不是报错，是那个交互等于不存在）。
//   · 归一化带来一个**必须如实记下的代价**：0.25 单位/秒在 1920px 宽的窗口 = 480px/s，
//     在 390px 宽的手机上 = 97.5px/s。所以"划过半屏"在两种设备算同样快，
//     而"手指移动同样快的物理距离"**不算**同样快（手机上更容易被读成粗暴）。
//     这条换算与它的后果见 .superpowers/sdd/diag-hand-speed.mjs；阈值本身至今**没有真人数据**。
//
// ⚠️ 事件频率 ≠ 消费频率（B17 的纪律 4）。指针上报可以到 120–1000Hz，
//   而生物按 CONFIG.fixedDt 走。所以事件里**只**更新一个读数（三次赋值，零分配），
//   插入采样与重算速度都只发生在 poll() 里，由 main.js 每帧调一次。
//   上界是"重活次数 ≤ poll 次数"，与事件数无关 —— 由 tests/input.test.js 那条
//   「1000 次 pointermove 不产生 1000 次任何重活」钉住。

const DEFAULT_WINDOW_MS = 140;      // 速度窗口，理由见 computeSpeed
const MAX_SAMPLES = 64;             // 采样缓冲上界（= minInterval 8ms 下 512ms 的历史）
const DEFAULT_MIN_INTERVAL_MS = 8;  // poll 之间的最小插入间隔（上界 125 次/秒）
// "还没有任何采样"的哨兵值。**必须**用 -Infinity 而不是 -1 或 0：
// 下面那个单调夹住（`when < lastInsertT` 就抬平）会把任何合法时刻与哨兵比较，
// 而 -1 落在合法时刻的**旁边** —— 于是"第一笔采样的时刻是 0"会被抬平成 -1，
// 整个窗口只剩 1ms 的时长，速度被放大 100 倍以上。
// （这不是假想的：B17 落地时跨层测试先用 -1 跑出来一个 3.4/s 的假"猛戳"读数，
//   由 tests/input.test.js 的「首笔采样的时刻可以是 0 或负数」那条钉住。）
const NO_TIME = Number.NEGATIVE_INFINITY;

// ---------------------------------------------------------------- 纯函数

// 窗口内**首末位移 / 首末时间差**，归一化单位/秒。
//
// 只用窗口内的采样。窗口存在的理由：不用它的话一次快戳会被之前几秒的静止历史
// 稀释成慢划 —— 而 spec §6.1 的全部要点是"抚摸与戳是同一根手指不同速度、反应完全相反"，
// 被稀释掉就等于戳不出来了。（旧计划 Task 8 Step 7(a) 的探针删掉这段过滤，
// 红的是 tests/input.test.js 的「过期采样不参与」那一条。）
//
// 窗口取 140ms：比一次戳的持续时间（约 40–80ms）长，比一次抚摸的持续时间
// （通常 > 300ms）短，所以两者都能被窗口内的采样代表。
//
// 取**首末位移**而不是逐段累加，两个理由，每个都有对应测试：
//   1. 累加会把设备抖动（手在原地微颤、传感器 ±1px）算成移动，于是"静止"永远
//      得不到 0 ⇒ 内核会把停着的手当成一直在划（那一条警告写在 CONFIG.behavior 里）。
//   2. 累加还会随浏览器**合并事件**（coalescing）漂移：合并掉的中间点在累加口径里
//      是丢掉的真实路径，而首末位移只依赖窗口两端 ⇒ 与上报密度无关。
// 窗口边界用**含等号**的 `>=`（写成 `>` 会让恰好落在边界上的采样被丢掉，
// 在 8ms 节流下这是系统性的、每帧都在发生的一小段偏短的路径）。
export function computeSpeed(samples, count, now, windowMs) {
  if (count < 2) return 0;
  const cutoff = now - windowMs;
  let iOldest = count - 1;
  for (let i = count - 1; i >= 0; i--) {
    if (samples.t[i] >= cutoff) iOldest = i; else break;
  }
  const iNewest = count - 1;
  if (iOldest === iNewest) return 0;
  const dtMs = samples.t[iNewest] - samples.t[iOldest];
  if (!(dtMs > 0)) return 0;                       // 同刻双采样 ⇒ 不得除零
  const dx = samples.x[iNewest] - samples.x[iOldest];
  const dy = samples.y[iNewest] - samples.y[iOldest];
  return Math.hypot(dx, dy) / (dtMs / 1000);
}

// 归一化 + 夹住。指针可以移出监听目标（拖出窗口、手指滑到边缘外），
// 越界会让内核那句"手离它多远"失去意义；拿不到尺寸（0/NaN/undefined）时退回原点，
// 绝不能返回 NaN —— NaN 会原样穿过内核的距离比较（两个比较都是 false），
// 症状是"这只生物再也不理这只手了"，且没有任何报错。
function normalize(value, size) {
  if (!(size > 0)) return 0;
  const v = typeof value === 'number' ? value / size : 0;
  if (!(v > 0)) return 0;                          // 同时挡住 NaN
  return v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- tracker

export function createHandTracker(opts) {
  const o = opts || {};
  const windowMs = o.windowMs > 0 ? o.windowMs : DEFAULT_WINDOW_MS;
  const max = o.maxSamples > 0 ? o.maxSamples : MAX_SAMPLES;
  const minIntervalMs = o.minIntervalMs >= 0 ? o.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;

  const tracker = {
    count: 0,
    down: false,        // 手指/鼠标按着的这段时间叫"手在缸里"
    active: false,      // 有可用读数（state() 非 null）
    lastInsertT: NO_TIME,
    samples: { t: new Float64Array(max), x: new Float64Array(max), y: new Float64Array(max) },
    // **唯一**被事件写入的那个读数。这就是解耦的落点：高频事件只碰这五个字段。
    reading: { t: NO_TIME, x: 0, y: 0, fresh: false },
    // 复用的输出对象（spec §5.3：运行时不分配对象）。
    // ⚠️ state() 的返回值**下一次 poll 就会被改掉**，调用方不得缓存它、
    //   也不得把 out.pos 的引用存到跨帧的地方（内核那边拷的是 x/y 两个**标量**，
    //   这件事由 tests/input.test.js 的「复用同一个对象是安全的」那条验证）。
    // down / appeared 是给内核的两个读数（spec §6.1 的"戳"与"惊吓"）：
    //   down     —— 此刻按着。poll 只在按着时才交样本，所以交付时它恒为 true；
    //               仍然要**显式交出去**，否则内核只能靠"样本存在"去猜，
    //               而那个猜测在 main.js 改了交付条件的那天就会悄悄变成错的。
    //   appeared —— 进缸后的**第一次**交付。内核用它发一次 startled（突然出现在身边会吓一跳）。
    out: { pos: { x: 0, y: 0 }, speed: 0, down: false, appeared: false },
    justPressed: false,
    // 三个整数计数器。**存在的全部理由是让"重活 ≤ poll 次数"这条上界可被断言**；
    // 整数自增不是分配，也不参与任何几何计算。
    metrics: { reads: 0, inserts: 0, computes: 0, releases: 0 },
  };

  // 事件路径：三次赋值 + 一个标记。没有数组写入、没有除法以外的算术、没有分支依赖状态。
  function observe(t, clientX, clientY, cssWidth, cssHeight) {
    const r = tracker.reading;
    r.x = normalize(clientX, cssWidth);
    r.y = normalize(clientY, cssHeight);
    r.t = t;
    r.fresh = true;
    tracker.metrics.reads += 1;
  }

  function insert(at, useReadingTime) {
    const s = tracker.samples;
    // 单调夹住：采样数组必须非降序，否则 computeSpeed 的"从后往前扫、遇到过期就停"
    // 会停在错误位置（真实世界的事件时钟与帧时钟都单调，这里防的是**混用两个时钟**
    // 这种接线错误 —— 症状是速度算出一个巨大的假值，生物会把静止的手当成猛戳而逃命）。
    let when = useReadingTime ? tracker.reading.t : at;
    if (when < tracker.lastInsertT) when = tracker.lastInsertT;
    if (tracker.count >= s.t.length) {
      // 满了就丢最老的一个。为什么用线性 + copyWithin 而不是纯环形：
      // computeSpeed 要取"窗口内最老的"与"最新的"，在环形缓冲上得先解出起点，
      // 而起点随回绕变化 —— 代码量翻倍且极易写错（错法是把跨回绕的两点当首末，
      // 算出一个巨大的假速度）。64 个 Float64 元素的前移是 192 次 memcpy 级移动，
      // 而它每秒最多发生 125 次（poll 的上界），比一个难懂的 bug 便宜得多。
      s.t.copyWithin(0, 1);
      s.x.copyWithin(0, 1);
      s.y.copyWithin(0, 1);
      tracker.count = s.t.length - 1;
    }
    const k = tracker.count++;
    s.t[k] = when;
    s.x[k] = tracker.reading.x;
    s.y[k] = tracker.reading.y;
    tracker.lastInsertT = when;
    tracker.metrics.inserts += 1;
  }

  function recompute(now) {
    const s = tracker.samples;
    const last = tracker.count - 1;
    tracker.out.pos.x = last >= 0 ? s.x[last] : 0;
    tracker.out.pos.y = last >= 0 ? s.y[last] : 0;
    tracker.out.speed = computeSpeed(s, tracker.count, now, windowMs);
    tracker.out.down = tracker.down;
    tracker.active = tracker.count > 0;
  }

  // 消费者路径（main.js 每帧一次）。手没按着就什么都不做 —— 连速度都不必重算。
  tracker.poll = (now) => {
    if (!tracker.down) {
      tracker.active = false;
      return null;
    }
    // 时刻必须由调用方给（main.js 传的是它那一帧的时间戳）。没给就退到最近的
    // 已知时刻，**绝不能**让 NO_TIME 参与减法 —— 那是 NaN 的入口，而 NaN 会原样
    // 穿过内核的距离比较（症状是"这只生物再也不理这只手了"，且不报错）。
    let t = now;
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      t = Number.isFinite(tracker.reading.t) ? tracker.reading.t
        : (Number.isFinite(tracker.lastInsertT) ? tracker.lastInsertT : 0);
    }
    if (tracker.reading.fresh || t - tracker.lastInsertT >= minIntervalMs) {
      insert(t, tracker.reading.fresh);
      tracker.reading.fresh = false;
    }
    recompute(t);
    // appeared 只在"按下之后的第一次成功交付"上为 true：按下了但还没采到任何样本时
    // 不能算出现（那时交的是 null，标记必须留着等真正交付的那一次）。
    tracker.out.appeared = tracker.active && tracker.justPressed;
    if (tracker.active) tracker.justPressed = false;
    tracker.metrics.computes += 1;
    return tracker.active ? tracker.out : null;
  };

  // 低频/一次性调用方的便捷入口：记一次读数并**立刻**插入 + 重算（不受节流影响）。
  // 真实浏览器里走的是 observe + poll 两条路；这条留给单测与任何"我就是要马上要一个读数"的调用。
  tracker.sample = (t, clientX, clientY, cssWidth, cssHeight) => {
    tracker.down = true;
    tracker.justPressed = true;
    observe(t, clientX, clientY, cssWidth, cssHeight);
    insert(t, true);
    tracker.reading.fresh = false;     // 这一笔已经被消费掉了，否则下一次 poll 会把它再插一遍
    recompute(t);
    tracker.out.down = tracker.down;
    tracker.out.appeared = tracker.justPressed;
    tracker.justPressed = false;
    tracker.metrics.computes += 1;
    return tracker.state();
  };

  // pointerdown：按下这件事本身就是"手进缸"，不需要等第一次移动。
  tracker.press = (t, clientX, clientY, cssWidth, cssHeight) => {
    tracker.down = true;
    tracker.justPressed = true;
    observe(t, clientX, clientY, cssWidth, cssHeight);
  };

  // 手离开了。**必须**把 active 清掉并把缓冲倒空：
  // 留着的话下一次按下的第一笔速度会跟上一次的手势做差（跨手势的假速度可以大到几十），
  // 于是"刚伸出的手"会被当成猛戳，生物在玩家每次重新伸手时都被吓一次。
  tracker.release = () => {
    tracker.down = false;
    tracker.active = false;
    tracker.count = 0;
    tracker.lastInsertT = NO_TIME;
    tracker.reading.t = NO_TIME;
    tracker.reading.x = 0;
    tracker.reading.y = 0;
    tracker.reading.fresh = false;
    tracker.out.pos.x = 0;
    tracker.out.pos.y = 0;
    tracker.out.speed = 0;
    tracker.metrics.releases += 1;
  };

  tracker.observe = observe;
  tracker.state = () => (tracker.active ? tracker.out : null);
  return tracker;
}

// ---------------------------------------------------------------- 绑定

// 默认时钟：performance.now 与浏览器给 requestAnimationFrame 的那个时间戳同源，
// 所以事件时刻与 poll 时刻天然可减。Date.now 只做兜底。
const defaultNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

// 绑定 Pointer Events（spec §6.1：统一触控与鼠标，**不依赖 hover**，手机没有 hover）。
//
// 形参 `target` 是"能收 pointer 事件的东西"由调用方给 —— 生产环境是那个全屏的绘制元素，
// 单测里是一个只实现了 addEventListener / removeEventListener / setPointerCapture 的普通对象。
// 因为目标来自形参，本文件不需要 document，也就不需要被排除在纯度守卫之外。
//
// ⚠️ 样式层里的 `touch-action: none`（css/main.css）是这一层能工作的前提：
// 不设它，浏览器会把触摸解释成滚动/手势，pointermove 中途被 pointercancel 掐断，
// 症状是"抚摸只在刚按下去的一瞬间有效"。
//
// 返回 `{ poll, detach, tracker }`：
//   · poll(now)  —— **唯一的消费者入口**，main.js 每帧调一次；本函数不会在任何事件里调它。
//   · detach()   —— 解绑 + 送最后一次 null（controller.stop() 走这条路）。
//   · tracker    —— 只为了 metrics 可被取证（那条 1000 事件的测试读它）。
export function attachInput(target, onHand, opts) {
  const o = opts || {};
  const tracker = o.tracker || createHandTracker(o);
  const now = o.now || defaultNow;
  const add = o.addListener || ((type, fn) => target.addEventListener(type, fn));
  const remove = o.removeListener || ((type, fn) => target.removeEventListener(type, fn));
  // 尺寸来源可注入（main.js 注入它自己那份视口，省掉一次布局读取）。
  const getSize = o.getSize || (() => ({ width: target.clientWidth, height: target.clientHeight }));

  let vw = 1;
  let vh = 1;
  let trackedId = null;      // 正在跟的那根手指；null = 没有手
  let reported = false;      // 上一次有没有把非 null 交出去（防重复送 null）

  // ⚠️ 只在**按下时**读一次尺寸，绝不在 pointermove 里读：布局读取会强制同步重排，
  // 而 pointermove 可以是 1000Hz。代价是一次手势中间的 resize 不生效（无害，
  // 手势本来就短）；收益是热路径上零布局读取。
  function refreshSize() {
    const s = getSize();
    vw = s && s.width > 0 ? s.width : 1;
    vh = s && s.height > 0 ? s.height : 1;
  }

  function lift() {
    trackedId = null;
    tracker.release();
    if (reported) {
      reported = false;
      onHand(null);
    }
  }

  const onDown = (ev) => {
    if (trackedId !== null) return;            // 只跟第一根手指；捏合缩放属 spec §10 范围外
    trackedId = ev.pointerId;
    refreshSize();
    // 指针捕获：不请求的话，指针移出监听目标之后抬起，pointerup 就不再派发到它身上，
    // 手会**永远**"按着" —— 生物会永久围着一只早已不在缸里的手转。
    // 用 setPointerCapture 而不是在窗口级监听 pointerup，正是因为后者需要 window，
    // 而 window 是本文件不许出现的名字之一。
    if (typeof target.setPointerCapture === 'function') {
      try { target.setPointerCapture(ev.pointerId); } catch (e) { /* 桩目标没有真实现：忽略 */ }
    }
    tracker.press(now(), ev.clientX, ev.clientY, vw, vh);
  };

  const onMove = (ev) => {
    if (trackedId === null || ev.pointerId !== trackedId) return;
    tracker.observe(now(), ev.clientX, ev.clientY, vw, vh);
  };

  const onUp = (ev) => {
    if (trackedId === null) return;
    if (ev && ev.pointerId !== undefined && ev.pointerId !== trackedId) return;
    lift();
  };

  // lostpointercapture 是"捕获被系统收回"的兜底（例如目标被移除）。
  // 它通常紧跟 pointerup，那时 reported 已经是 false，所以不会重复送 null。
  add('pointerdown', onDown);
  add('pointermove', onMove);
  add('pointerup', onUp);
  add('pointercancel', onUp);
  add('lostpointercapture', onUp);

  const poll = (t) => {
    const s = tracker.poll(t);
    if (s) {
      reported = true;
      onHand(s);
    } else if (reported) {
      reported = false;
      onHand(null);                            // 必须显式送 null，否则内核会认为手还停在那儿
    }
    return s;
  };

  const detach = () => {
    remove('pointerdown', onDown);
    remove('pointermove', onMove);
    remove('pointerup', onUp);
    remove('pointercancel', onUp);
    remove('lostpointercapture', onUp);
    trackedId = null;
    tracker.release();
    reported = false;
    onHand(null);
  };

  return { poll, detach, tracker };
}
