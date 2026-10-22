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
//
// B18（2026-10-22）接上的部分：叫声。
//   src/audio.js 与 render/input 同形：一个浏览器全局都不碰，音频图由**注入**得到，
//   于是整个叫声层（嗓音映射、六声表、跨越判据、冷却、发声上限、节点收支）在 Node 里可单测。
//   本文件因此多出三样别处没有的东西：
//   · 那两个构造名（一个以 A-u-d 开头、一个以 w-e-b 开头）**只许出现在这里**，
//     而 tests/constraints.test.js 的正例守卫现在也盯着这一点；
//   · **懒创建**：AudioContext 在首次 pointerdown 上创建并 resume（见 boot 里那段注释），
//     失败就降级 —— 缸的其余部分照常，`controller.audioState` 是可读的证据；
//   · 静音 API 与倍速同形（模块级 setMuted/getMuted + controller 上那两个方法），
//     计划 2 没有 HUD，所以右上角那颗静音按钮属计划 3（裁定记在 spec §5.4.1 第 8 条）。
//
// B19b-ii（2026-10-22）接上的部分：可选 API 档（spec §4.13.2 / §4.13.2.1，默认关闭）。
//   src/api.js 里装着"算"的那一半（摘要、请求描述、回复校验、超时判据、暂存队列），
//   本文件只装"碰"的那一半：本机存储、f-e-t-c-h、AbortController、每帧把队列排空。
//   四条纪律都落在这一段，且每条都有 boot 级测试钉着（tests/api.test.js 末段）：
//   · **输出侧旁路，不是门**（§4.13.2.1 第 1 条）：内核照旧决定说不说、照旧发那条带规则
//     文案的 say 事件；本文件只在档位开着时把那一拍**按住最多 apiHoldMs 毫秒**，
//     然后无论手上是什么文案都交出去。档位关掉时**一个字节都不多做**（零延时、零请求、
//     交付缓冲都不分配）—— 那是断言，不是注释。
//   · **零定时器**（决策 B）：超时机制是帧循环里 duePending 那一趟扫描，
//     所以 stop() 之后没有回调会把字塞进气泡池，也没有定时器要收拾。
//   · **key 只住 localStorage**（决策 C / §7.2 末第 4 条）：save.json 是多设备共享的
//     明文文件，一个字符都不许进去；对外只给 getApiConfig() 那份脱敏读数（决策 D）。
//   · **每个注入参数都有测试用它**（决策 E，B18 的反面教训）：options.fetch /
//     options.storage 两个口子各有一条用例真的走它，另有一条用例证明**不注入**时
//     走的就是 globalThis 上那两个真货。
//
// C-1（2026-10-22）接上的部分：存档落地（spec §7.2.1）。
//   src/save.js 从计划 1 起就有全绿的 13 条单测，但整个页面**没有一条路径**能把一缸写出去
//   再读回来 —— 于是 §9.2 第 5 条（关掉三天再打开，它们还在你离开的那一秒）不是"没验证"，
//   而是结构性做不到。这一层接的就是那根断掉的线。分工照旧：
//   挑哪些字段进档 = save.js 的 serialize()（纯变换，Node 里可测）；什么时候写、写不进怎么办 = 本文件。
//   四条裁定各有一条 boot 级用例钉着（tests/save.test.js 末段），其中承重的那条是 R-1：
//   · **读不懂的档绝不被覆盖**。坏档先**原样**挪进 `tank.save.v2.corrupt`，再开新缸；
//     连挪都挪不动（存储写不了）就**永不再写主键** —— 症状从"我的缸没了"退成"这次没存上"，
//     而前者是不可恢复的。`controller.saveState` 是唯一可读的证据。
//   · **零定时器**（与 B19b-ii 的决策 B 同一条理由）：落盘骑在帧循环上，
//     每 CONFIG.save.everySimSec **模拟**秒一次，外加 visibilitychange→hidden 与 pagehide 两次即时写。
//   · **成本下限**：两次写入之间至少隔 minIntervalMs。满缸一次 serialize+stringify 实测
//     中位 1.86ms / 最坏 4.22ms（约 160KB），而连点标签页会连着发 hidden —— 没有这道下限就是十几次同步写。
//   · **读档保证的是状态的延续，不是随机流的延续**：rng 闭包里那个私有序列进不了 JSON
//     （JSON.stringify 给的是 `{}`），所以这里**不许**写"存→读→跑 N tick 与连跑逐位相同"那种假断言。

import { CONFIG } from './config.js';
import { createWorld, tickWorld, restoreWorld } from './sim.js';
import { updateBodies, reconcileBodies } from './body.js';
import { createRenderer, consumeEvents } from './render.js';
import { attachInput } from './input.js';
import { createAudio } from './audio.js';
import { serialize, migrate, assertCreatureShape } from './save.js';
import { tokenBudget } from './lexicon.js';
import {
  createPending, pushPending, duePending, releasePending, resolvePending, clearGive,
  dropAllPending,
  buildSummary, buildRequest, configIssue, validateReply, maySend, deadlineFor,
  PUSH_REASONS,
} from './api.js';

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

// ---------------------------------------------------------------- 可选 API 档（B19b-ii）

// 本机存储里那一个键。⚠️ key 只住在这里，**绝不住进 save.json** ——
// 后者是局域网内多设备共享的明文文件（spec §7.2 末第 4 条），写进去等于把 key 广播。
// 这也是 tests/api.test.js 那条"存档里搜不到 key 的子串"的守卫对象。
const API_STORE_KEY = 'tank.api.v1';

// 补丁里认识的字段。名单之外的键一律忽略：不然设置页哪天传个 `world` 进来就能改世界了。
const API_FIELDS = ['enabled', 'endpoint', 'model', 'key', 'timeoutMs', 'maxInFlight'];

const str = (v) => (typeof v === 'string' ? v : '');
const posNum = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
const posInt = (v, dflt) => (Number.isInteger(v) && v >= 0 ? v : dflt);

// 默认的存储与默认的发请求能力。两行都读 globalThis 上那两个名字，
// 而 tests/constraints.test.js 的正例守卫现在也盯着 main.js 里这两个名字 —— 拦的是
// B18 记过的那一类"根本没接线"：接线没接上时它必须红，而不是安静地一缸哑巴。
// ⚠️ 私有模式 / Safari 读 localStorage 这个属性**本身就会抛**，所以整个读取包在 try 里。
const globalStore = () => {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null;
  } catch (err) { return null; }
};

const globalFetcher = () => {
  try {
    const f = globalThis.fetch;
    // 包一层而不是直接返回：`fetch` 绑在 window 上，裸着当回调传出去会 Illegal invocation。
    return typeof f === 'function' ? (input, init) => f(input, init) : null;
  } catch (err) { return null; }
};

// 档位的全部接线。它是**输出侧的旁路**：世界照旧决定说不说，这里只决定那一句
// 晚多久出现、以及出现的是谁的措辞。关掉时（默认、或 cfg 不合格）它一个字节都不多做。
function attachApiTier(world, opts) {
  const options = opts || {};
  const A = CONFIG.api;
  const p = createPending(A.pendingCap);
  // 注入优先（决策 E：两个口子都有测试真的走它）；不注入就走 globalThis 上的真货。
  const store = options.storage !== undefined ? options.storage : globalStore();
  const send = options.fetch !== undefined ? options.fetch : globalFetcher();

  const cfg = {
    enabled: A.enabled, endpoint: '', model: '', key: '',
    timeoutMs: A.timeoutMs, maxInFlight: A.maxInFlight,
  };
  const state = {
    active: false,        // 本帧是否参与交付（= 唯一那条"要不要按住"的读数的缓存）
    status: 'off',        // 'off' | 'ready' | 机器可读的拒绝原因（configIssue.reason 那一张表）
    storage: store ? 'ok' : 'absent',
    fetcher: send ? 'ok' : 'absent',
    reason: null,         // 存储读不出来时的原文（不含值，只含报错消息）
  };
  const stats = {
    sent: 0, delivered: 0, inFlight: 0, inFlightMax: 0, fetchCalls: 0,
    gateClosed: 0, badShape: 0, notTaken: 0, noCreature: 0, summaryFailed: 0, noRequest: 0,
    httpFailed: 0, bodyFailed: 0, networkFailed: 0, replyRejected: 0,
    replyAccepted: 0, aborted: 0, errors: 0, frames: 0,
    warned: { read: 0, write: 0 },      // 两条降级各只许响一次（§7.7 不静默，也不刷屏）
  };
  // 每个槽位一份的接线侧账（与队列同宽、一次建满、运行中只改值）：
  // req[i] 1 = 那一拍还挂着一个请求；ctrl[i] 就是那个中止控制器。
  // ⚠️ 这里**不留代号**：代号只有队列那份 `p.token` 一处，两处各存就会各漂。
  const req = new Uint8Array(p.n);
  const ctrl = new Array(p.n).fill(null);

  // 帧时刻的缓存：本文件的时钟只有一个来源（step(t) 里那个 rAF 读数）。
  // 回复的回调落在两帧之间，那一刻没有"当下"可用 —— 用上一帧的时刻，
  // 于是那一拍在**下一帧**的扫描里出去（延后一帧，不是延后无限，也不许设定时器）。
  let clockMs = 0;
  const nowMs = () => clockMs;

  // 一次请求的终点。**每个**终局分支都只许从这里结在途的账，而 req[i] 那个坑保证只结一次：
  // 队列交付那一拍时也会结束它（超时先到那一支），两边谁先到都只减一遍（决策 F）。
  const endFlight = (i) => {
    if (i < 0 || i >= p.n || req[i] !== 1) return 0;
    req[i] = 0;
    stats.inFlight -= 1;
    const c = ctrl[i];
    ctrl[i] = null;
    if (c) { try { c.abort(); } catch (err) { stats.errors += 1; } }
    return 1;
  };

  // 降级只许响一次：静默是 §7.7 禁止的，而每帧刷屏同样是被抓过两次的老毛病。
  const warnOnce = (slot, msg) => {
    if (stats.warned[slot] > 0) return;
    stats.warned[slot] += 1;
    console.warn(msg);
  };

  const readStore = () => {
    if (!store) return;                       // 没有存储 ⇒ cfg 停在 CONFIG 的形状上（关闭）
    try {
      const raw = store.getItem(API_STORE_KEY);
      if (raw === null || raw === undefined || raw === '') return;
      const o = JSON.parse(String(raw));
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      if (typeof o.enabled === 'boolean') cfg.enabled = o.enabled;
      cfg.endpoint = str(o.endpoint);
      cfg.model = str(o.model);
      cfg.key = str(o.key);
      cfg.timeoutMs = posNum(o.timeoutMs, A.timeoutMs);
      cfg.maxInFlight = posInt(o.maxInFlight, A.maxInFlight);
      state.storage = 'localStorage';
    } catch (err) {
      // 读不出来就当档位关着 —— 缸照常跑，而且**只响一次**（§7.7 不许静默，也不许刷屏）。
      cfg.enabled = false;
      state.storage = 'unreadable';
      state.reason = String((err && err.message) || err);
      warnOnce('read', `API 档的本机存储读不出来（${state.reason}）：这一档按关着处理，缸照常跑。`);
    }
  };

  const refresh = () => {
    const bad = configIssue(cfg);
    if (!cfg.enabled) { state.active = false; state.status = 'off'; state.reason = null; return; }
    if (!send) { state.active = false; state.status = 'no-fetcher'; state.reason = null; return; }
    if (bad) { state.active = false; state.status = bad.reason; state.reason = bad.field; return; }
    state.active = true;
    state.status = 'ready';
    state.reason = null;
  };

  const redacted = () => ({
    // 决策 D：这份读数**永远不许有 key 那个键**。测试用 JSON.stringify 搜子串钉它。
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    model: cfg.model,
    hasKey: cfg.key !== '',
    timeoutMs: cfg.timeoutMs,
    maxInFlight: cfg.maxInFlight,
    source: state.storage === 'localStorage' ? 'localStorage' : 'default',
  });

  const setConfig = (patch) => {
    const src = patch && typeof patch === 'object' ? patch : {};
    for (const k of API_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const v = src[k];
      if (k === 'enabled') cfg.enabled = !!v;
      else if (k === 'endpoint' || k === 'model' || k === 'key') cfg[k] = str(v);
      else if (k === 'timeoutMs') cfg.timeoutMs = posNum(v, A.timeoutMs);
      else cfg.maxInFlight = posInt(v, A.maxInFlight);
    }
    // 落盘：整份（含 key）只写进 localStorage 那一个键下。写失败 ⇒ 本次改动只在内存里，
    // 也照样要说出来（静默的"设置了但没生效"是最难查的那类）。
    if (store) {
      try {
        store.setItem(API_STORE_KEY, JSON.stringify({
          enabled: cfg.enabled, endpoint: cfg.endpoint, model: cfg.model,
          key: cfg.key, timeoutMs: cfg.timeoutMs, maxInFlight: cfg.maxInFlight,
        }));
        state.storage = 'localStorage';
        state.reason = null;
      } catch (err) {
        state.storage = 'unwritable';
        state.reason = String((err && err.message) || err);
        warnOnce('write', `API 档写不进本机存储（${state.reason}）：本次设置只在这一个页面里生效。`);
      }
    } else {
      state.reason = 'no-store';
    }
    refresh();
    return redacted();
  };

  // 给已经接管的那一拍发一个请求。返回 1 = 真的发出去了，0 = 一个字节都没动
  // （调用方必须当场交付那一拍 —— 这就是"发不出去也照旧说话"的那条路）。
  const dispatch = (i, s, c, ev) => {
    if (!maySend(stats.inFlight, cfg)) { stats.gateClosed += 1; return 0; }
    let summary;
    try {
      summary = buildSummary(c, world, { mood: ev.mood, suggestion: ev.text });
    } catch (err) {
      stats.summaryFailed += 1;
      return 0;                      // 摘要都拼不出来 ⇒ 不接管，规则档那句照旧说
    }
    const r = buildRequest(summary, cfg);
    if (!r) { stats.noRequest += 1; return 0; }
    const budget = tokenBudget(c.traits.personality.talk);
    let controller = null;
    try {
      // 老 Safari 没有这个构造器就**不带 signal**：那一拍的超时仍由帧循环的到期扫描兜住
      // （决策 B），少一个 signal 只是连接可能多活一会儿，绝不影响缸。
      if (typeof AbortController === 'function') controller = new AbortController();
    } catch (err) { stats.errors += 1; }
    req[i] = 1;
    ctrl[i] = controller;
    stats.inFlight += 1;
    if (stats.inFlight > stats.inFlightMax) stats.inFlightMax = stats.inFlight;
    stats.sent += 1;
    stats.fetchCalls += 1;
    let promise = null;
    try {
      const init = {
        method: r.method,
        headers: r.headers,          // authorization 头里那个 key 只在这一处出门
        body: JSON.stringify(r.body),
      };
      if (controller) init.signal = controller.signal;
      promise = send(r.url, init);
    } catch (err) {
      promise = null;                // 同步就抛（非法 URL、能力被策略挡掉）⇒ 走回落
    }
    if (!promise || typeof promise.then !== 'function') {
      endFlight(i);
      stats.networkFailed += 1;
      return 0;
    }
    // 一次请求的唯一终点：先结在途的账（只结一次），再问队列那一拍还在不在。
    // 迟到的那一份会在 resolvePending 里被丢掉并计数，绝不塞进后来那句话（决策 F）。
    const settle = (utterance, why) => {
      endFlight(i);
      const applied = resolvePending(p, i, utterance, nowMs(), s);
      if (utterance && applied === 1) stats.replyAccepted += 1;
      if (why) stats[why] += 1;
    };
    promise.then((res) => {
      if (!res || res.ok !== true) { settle(null, 'httpFailed'); return; }   // 非 2xx 不可能产出替换
      let jsonish;
      try { jsonish = res.json(); } catch (err) { settle(null, 'bodyFailed'); return; }
      if (!jsonish || typeof jsonish.then !== 'function') { settle(null, 'bodyFailed'); return; }
      jsonish.then((json) => {
        let v = null;
        try { v = validateReply(json, budget, c); } catch (err) { stats.errors += 1; }
        if (v && v.ok === true) settle(v.utterance, null);
        else { if (v) stats.replyRejected += 1; settle(null, null); }
      }, () => settle(null, 'bodyFailed'));
    }, () => settle(null, 'networkFailed'));
    return 1;
  };

  // 把交付缓冲区里的那几拍交回消费路径。交付的那一刻，还没落地的请求就地掐掉并结账。
  const drainGive = (out) => {
    if (p.giveCount === 0) return;
    for (let i = 0; i < p.giveCount; i++) {
      endFlight(p.giveIdx[i]);
      out.push(p.give[i]);
      stats.delivered += 1;
    }
    clearGive(p);
  };

  // 一帧的全部工作：① 接管这一帧新说的句子（能发才按，发不了就照旧当帧交付）
  // ② 到期扫描（**这就是超时机制**，本文件没有任何定时器）③ 把该出现的字交出去。
  const frame = (events, tMs, out) => {
    clockMs = Number.isFinite(tMs) ? tMs : clockMs;
    stats.frames += 1;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.kind !== 'say') { out.push(ev); continue; }
      // 按住的上界 = min(暂存预算, 请求预算)：存储里填了个比 apiHoldMs 还短的 timeoutMs 时，
      // 提前松手才是对的 —— 那一拍等的东西已经不可能再来了。"最多晚 apiHoldMs 毫秒"
      // 这条上界因此仍然成立（只会更早，不会更晚）。
      // ⚠️ 用 deadlineFor 而不是自己相加：它对"时钟回拨"那一支有处理（api.js 里那条注释），
      // 照抄 start + timeout 会把 deadline 留在过去、每条都当场被判超时，
      // 症状恰好就是 spec §4.13.2 第 1 条禁止的"填了 key 反而不说话了"。
      const holdUntil = deadlineFor(clockMs, clockMs, A.apiHoldMs);
      const reqUntil = deadlineFor(clockMs, clockMs, cfg.timeoutMs);
      if (pushPending(p, ev, reqUntil < holdUntil ? reqUntil : holdUntil) === 0) {
        // 队列没收这一拍：形状不对，或腾不出位（give 满而槽位全占）。
        // 两种都当场原样交付 —— 返回值 0 的含义是"这一拍不归队列管"，不是"这一拍不说了"。
        if (p.lastReason === PUSH_REASONS.BAD_SHAPE) stats.badShape += 1;
        else stats.notTaken += 1;
        out.push(ev);
        continue;
      }
      const idx = p.lastIdx;
      const s = p.lastToken;
      let c = null;
      for (let k = 0; k < world.creatures.length; k++) {
        if (world.creatures[k].id === ev.id) { c = world.creatures[k]; break; }
      }
      let sent = 0;
      if (!c) stats.noCreature += 1;              // 说话的那只已经不在缸里了
      else sent = dispatch(idx, s, c, ev);
      drainGive(out);                // 顶位/挤出来的那几条也是在这一刻交出去的
      // 没发出去 ⇒ 按着它毫无意义，当场交付规则档那一句（**附加延时为零**）。
      if (sent === 0) resolvePending(p, idx, null, clockMs, s);
    }
    const n = duePending(p, clockMs);
    for (let j = 0; j < n; j++) {
      const idx = p.due[j];
      endFlight(idx);                // 请求还挂着 ⇒ 掐掉并结掉在途的账
      releasePending(p, idx);        // 到期就带着**当下手上的文案**出去
    }
    drainGive(out);
    return out;
  };

  // 缸停了：还挂着的请求一律掐掉，还按着的话不再交付（屏幕已经不画了），两条都留读数。
  const abandon = () => {
    let requests = 0;
    for (let i = 0; i < p.n; i++) {
      if (req[i] === 1 && endFlight(i) === 1) { stats.aborted += 1; requests += 1; }
    }
    return { requests, beats: dropAllPending(p) };
  };

  readStore();
  refresh();

  return {
    pending: p, state, stats,
    getApiConfig: redacted,
    setApiConfig: setConfig,
    frame,
    abandon,
  };
}

// ---------------------------------------------------------------- 存档层（C-1，spec §7.2.1）

// 两个键名都在 CONFIG.save 里（裁定 R-2）：键名住在常量表，tests/config.test.js 钉它，
// 而 API 档那把 key 住在**另一个键**（tank.api.v1）且**永不进存档** —— 那条由
// tests/api.test.js 的"落盘文本里搜不到 key"钉住，它测的就是下面这一条写入路径。
const SAVE_KEY = CONFIG.save.key;
const SAVE_CORRUPT_KEY = CONFIG.save.corruptKey;

// 隔离失败那一类 blocked 值：**人的动作也不许穿过这道守卫**。
// 'quota' / 'write-failed' 是暂时写不进（腾出空间后 saveNow() 该能重试），
// 而 'quarantine-failed' / 'store-unreadable' 的含义是"主键下躺着一份我们读不懂、
// 又挪不动的档" —— 那正是 R-1 要保住的东西，一次 devtools 里的"手滑一按"就能把它盖掉。
const HARD_SAVED_BLOCKS = ['quarantine-failed', 'store-unreadable'];

const isQuotaError = (err) => !!err && (
  err.name === 'QuotaExceededError'
  || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  || err.code === 22 || err.code === 1014
  || /quota/i.test(String(err.message || ''))
);

// 降级只许响一次。api 档里那个同名的局部实现是它的先例（§7.7 不许静默，
// 而每帧刷屏在这个仓库里被抓过两次）；这里写成模块级而**不去改 api 档那一份**，
// 因为那份的计数住在它自己的 stats.warned 里、有测试钉着，动它属于顺手重构。
const savedWarnOnce = (bag, slot, msg) => {
  if (bag[slot] > 0) return;
  bag[slot] += 1;
  console.warn(msg);
};

// 这台设备的存储到底是**根本没有**还是**一摸就抛**。
// 前者不必吵（`saveState.enabled === false` 就是可读证据，而且用户对它无能为力），
// 后者是降级（Safari 隐私模式读 localStorage 这个属性本身就抛），必须响一次。
// globalStore() 把两种情况都归成 null —— 那是 api 档的形状，B19b-ii 的测试钉着它，不改；
// 存档层需要区分，所以另给一个探针。
const probeStore = () => {
  try {
    const s = globalThis.localStorage;
    return {
      store: (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') ? s : null,
      error: null,
    };
  } catch (err) {
    return { store: null, error: String((err && err.message) || err) };
  }
};

// 存档层的全部接线。**它必须在 createWorld 之前跑**：读到的那份档决定了种子用哪一颗
// （裁定 R-7），而"seed Silently 赢了存档"是这一层最容易被写错的一行。
// 返回的 doc 要么是一份迁移好的存档（调用方拿它去 restoreWorld），要么是 null（开新缸）。
function attachSaveTier(probe, options) {
  const S = CONFIG.save;
  const store = options.storage !== undefined ? options.storage : probe.store;
  const enc = new TextEncoder();     // 只用来量字节（saveState.bytes 是那条成本裁定的读数）
  const warned = {};
  const state = {
    // ---- 裁定要求的这七个字段一个不多一个不少地都在（spec §7.2.1）----
    enabled: options.save !== false && !!store,
    source: 'fresh',                 // 'fresh' | 'restored' | 'corrupt-moved' | 'unreadable'
    reason: null,                    // 机器可搜的原文；null = 一切正常
    bytes: 0,                        // 最近一次**成功写入**的 utf8 字节数
    writes: 0,
    writeErrors: 0,
    quotaHits: 0,
    // ---- 同一条裁定里"可读的落盘状态"那半句要求的其余读数 ----
    quarantined: false,              // 隔离区里是否真有一份原档（本次会话判定）
    quarantineBytes: 0,
    discarded: 0,                    // 第二次及以后的坏档：只计数，绝不覆盖已有的那份
    blocked: null,                   // null | 'quarantine-failed' | 'store-unreadable' | 'quota' | 'write-failed'
    reads: 0,
    cleared: 0,                      // clearSave() 摘掉了几个键
    bytesRead: 0,                    // 读到的那一份原文有多少 utf8 字节（诊断隔离区有多大）
    events: false,                   // 那两条即时落盘的监听是否真的挂上了
    lastSavedAtSim: 0,               // 最近一次成功落盘时的**模拟秒**
    lastWriteAtMs: -Infinity,        // 最近一次成功落盘时的**墙上毫秒**（minIntervalMs 的下限就量它）
    seed: { used: 0, requested: null, source: 'clock' },
  };
  // 探针分得出两种"没有存储"：这台设备**根本没有**（不吵，enabled=false 就是证据），
  // 与**一摸就抛**（Safari 隐私模式）。后者是降级，必须响一次（§7.7）。
  if (!store && probe.error) {
    state.enabled = false;
    state.source = 'unreadable';
    state.blocked = 'store-unreadable';
    state.reason = probe.error;
    savedWarnOnce(warned, 'read',
      `本机存储一摸就抛（${probe.error}）：存档通道关掉，缸照常跑；本次会话不读也不写任何键。`);
  }

  // 把一份读不懂的原档**原样**挪进隔离区。R-1 的承重语句在这一段里。
  const quarantine = (raw) => {
    let existing = null;
    try {
      state.reads += 1;
      existing = store.getItem(SAVE_CORRUPT_KEY);
      if (existing === null || existing === undefined || existing === '') {
        store.setItem(SAVE_CORRUPT_KEY, raw);   // **一个字节都不改**：改了它就不再是证据
        state.quarantined = true;
        state.quarantineBytes = enc.encode(raw).length;
      } else {
        // 隔离区已经有一份了：**留最早那一份**，这一次挪进来的丢弃并计数。
        // 一个会被第二次失败覆盖掉的隔离区就不是隔离区了，而"最早那份"恰恰是
        // 玩家真正失去的那一缸（新的这份本来就写不进第二遍）。
        state.quarantined = true;
        state.discarded += 1;
      }
      state.source = 'corrupt-moved';
      state.blocked = null;
    } catch (err) {
      // 挪不动 ⇒ 那份读不懂的原档**还躺在主键下**。此时唯一安全的动作是永不再写这个键：
      // 覆盖它 = 玩家失去唯一的副本，而这正是本条裁定要让它不可能发生的那个序列。
      const move = String((err && err.message) || err);
      state.source = 'unreadable';
      state.blocked = 'quarantine-failed';
      state.reason = `${state.reason || ''}；坏档挪不开（${move}）：此后不再写主键`;
      savedWarnOnce(warned, 'quarantine',
        `存档读不出来、也挪不开（${state.reason}）：这一缸只在内存里跑，落盘已停止 —— 不改写上一次的存档。`);
    }
  };

  // 一次读取 + 迁移 + 自检。**"任何一步失败"都算失败**：坏 JSON、比本程序新的版本、
  // 缺 creatures、过了 migrate 但过不了 assertCreatureShape（缺字段的记忆条目、脏 role）、
  // 以及被配额截断写到一半的那份。失败之后走的都是 quarantine 那一条路。
  const load = () => {
    if (!state.enabled) return null;
    let raw = null;
    try {
      raw = store.getItem(SAVE_KEY);
      state.reads += 1;
    } catch (err) {
      // 连读都读（隐私模式）：整条通道按 save:false 处理，缸照常跑，响一次。
      state.enabled = false;
      state.source = 'unreadable';
      state.blocked = 'store-unreadable';
      state.reason = String((err && err.message) || err);
      savedWarnOnce(warned, 'read',
        `本机存储读不出来（${state.reason}）：存档通道关掉，缸照常跑；本次会话不读也不写任何键。`);
      return null;
    }
    if (raw === null || raw === undefined || raw === '') {
      state.source = 'fresh';       // 存储里什么都没有 ⇒ 新缸，什么都没被动过
      return null;
    }
    const bytesOfRaw = enc.encode(String(raw)).length;
    let doc = null;
    try {
      doc = migrate(JSON.parse(String(raw)));
      for (let i = 0; i < doc.creatures.length; i++) assertCreatureShape(doc.creatures[i]);
    } catch (err) {
      doc = null;
      state.reason = String((err && err.message) || err);
    }
    if (doc) {
      state.source = 'restored';
      state.bytesRead = bytesOfRaw;
      return doc;
    }
    state.bytesRead = bytesOfRaw;
    quarantine(String(raw));
    return null;
  };

  const doc = load();

  let world = null;
  let clockMs = 0;
  let getPacing = () => 1;           // 倍速的唯一读数在 main 的 state 里；内核不认它，所以由 attach 传进来

  // 一次落盘。`why` 只影响两件事：manual 不受 minIntervalMs 的下限管，
  // 也不受 'quota'/'write-failed' 那两类**暂时**失败的限制（见 HARD_SAVED_BLOCKS 那条注释）。
  const write = (why, tMs) => {
    if (!world || !state.enabled) return 0;
    if (state.blocked && HARD_SAVED_BLOCKS.includes(state.blocked)) return 0;
    if (why !== 'manual' && Number.isFinite(state.lastWriteAtMs)
      && tMs - state.lastWriteAtMs < S.minIntervalMs) return 0;
    let text;
    let bytes;
    try {
      // serialize 只挑字段、不读时钟（它是纯函数，Node 里可 deepEqual）；
      // 墙上时间戳由这里给，而 §7.4 明写"恢复时不补算流逝时间"⇒ savedAt 只是给人看的证据。
      text = JSON.stringify(serialize(world, {
        savedAt: new Date(Date.now()).toISOString(),
        timeScale: getPacing(),
      }));
      bytes = enc.encode(text).length;
    } catch (err) {
      state.writeErrors += 1;
      state.reason = `序列化失败：${String((err && err.message) || err)}`;
      savedWarnOnce(warned, 'serialize', `${state.reason}：这一缸落不了盘，其余照常。`);
      return 0;
    }
    try {
      store.setItem(SAVE_KEY, text);
    } catch (err) {
      state.writeErrors += 1;
      if (isQuotaError(err)) {
        state.quotaHits += 1;
        state.blocked = 'quota';
      } else {
        state.blocked = 'write-failed';
      }
      // **不再重试**：一次 160KB 的同步写失败之后，每 30 模拟秒再撞一次是纯成本；
      // 更要紧的是"写到一半"的猜想 —— 主键若被截断成一份读不懂的档，下一次开缸就得走
      // 隔离那条路，而那份档里的这一缸是真的没了。停手 + 把 blocked 挂出来是更诚实的形状。
      const why2 = `存档写不进本机存储（${String((err && err.message) || err)}）`;
      // 读档那一步的原因**不许被写盘那一步盖掉**：saveState 是这一层唯一的证据，
      // 少了前半句就分不清"这份档本来就坏"与"这台设备满了"。
      state.reason = state.reason ? `${state.reason}；${why2}` : why2;
      savedWarnOnce(warned, 'write',
        `${state.reason}：此后停止落盘，缸照常跑；已存的那一份保持原样不动。`);
      return 0;
    }
    state.writes += 1;
    state.bytes = bytes;
    state.blocked = null;
    state.lastWriteAtMs = tMs;
    state.lastSavedAtSim = world.time;
    return bytes;
  };

  // 帧循环里的那一眼（裁定 R-3：**没有 setInterval**）。
  // 判据是**模拟秒**，所以 4× 倍速不会改变"缸推进了 30 秒才写一次"这件事；
  // 墙上时钟那道具体的间隔交给 minIntervalMs（R-4），它兜的是事件那两条路。
  const frame = (tMs) => {
    clockMs = Number.isFinite(tMs) ? tMs : clockMs;
    if (!state.enabled || state.blocked) return;
    if (world.time - state.lastSavedAtSim >= S.everySimSec) write('cadence', clockMs);
  };

  const onVisibility = () => {
    // 只在**转去后台**那一刻写。手机切后台太常见了，而 rAF 一到后台就停 ——
    // 不补这一笔，"最后 30 模拟秒"就永远留在内存里（§7.3 那两句的原样理由）。
    if (globalThis.document && globalThis.document.visibilityState === 'hidden') write('hidden', clockMs);
  };

  const onPageHide = () => { write('pagehide', clockMs); };

  const attach = (w, pacing) => {
    world = w;
    if (typeof pacing === 'function') getPacing = pacing;
    state.lastSavedAtSim = w.time;      // 读档进来的缸：从"它当前那一刻"起算下一次落盘
    if (!state.enabled || state.blocked) return;
    const d = globalThis.document;
    const win = globalThis.window;
    // ⚠️ 两处都要 typeof 守卫：visibilitychange **只挂在 document 上**（挂 window 收不到），
    // 而测试桩里的 document 未必有 addEventListener —— 少这一行守卫就是整套 boot 测试当场炸。
    if (d && typeof d.addEventListener === 'function') d.addEventListener('visibilitychange', onVisibility);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', onPageHide);
    state.events = true;
  };

  const detach = () => {
    const d = globalThis.document;
    const win = globalThis.window;
    if (d && typeof d.removeEventListener === 'function') d.removeEventListener('visibilitychange', onVisibility);
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', onPageHide);
    state.events = false;
  };

  return {
    state, doc, attach, detach, frame,
    saveNow() { return write('manual', clockMs); },
    clearSave() {
      if (!store) return 0;
      let removed = 0;
      for (const key of [SAVE_KEY, SAVE_CORRUPT_KEY]) {
        try {
          if (store.removeItem) { store.removeItem(key); removed += 1; }
        } catch (err) {
          savedWarnOnce(warned, 'clear',
            `清档失败（${String((err && err.message) || err)}）：那一个键可能还在，下一次开缸仍会读到它。`);
        }
      }
      state.cleared = removed;
      // 主键空了 ⇒ "不许覆盖读不懂的档"这道禁令的前提消失了，允许重新落盘。
      if (state.blocked === 'quarantine-failed' || state.blocked === 'store-unreadable') state.blocked = null;
      if (removed > 0) { state.lastSavedAtSim = world ? world.time : 0; state.lastWriteAtMs = -Infinity; }
      return removed;
    },
  };
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

// B18：静音与倍速走同一条路 —— 计划 2 没有 HUD，所以这两个只能在 devtools 里调
// （globalThis.__tank.setMuted(true)）。spec §5.4 那句"右上角有静音按钮"属 HUD，
// 按计划 2 的范围**不落地**，裁定记在 spec §5.4.1 第 8 条。
// 刻意**不抛错**而返回一个布尔：静音按钮的置灰状态要能在缸没跑起来时也读一次。
export function setMuted(value) {
  if (!activeController) return !!value;
  return activeController.setMuted(value);
}

export function getMuted() {
  if (!activeController) return true;
  return activeController.getMuted();
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

  // 存档层**必须跑在 createWorld 之前**（裁定 R-7）：读回来的那份档决定种子用哪一颗。
  // ⚠️ 探针也要在这一步之后才摸 globalThis：options.save === false 时连**属性访问**都不许有
  //    （Safari 隐私模式下光是读 globalThis.localStorage 就会抛），而 options.storage 给了就用给的。
  const probe = (options.save === false || options.storage !== undefined)
    ? { store: options.storage === undefined ? null : options.storage, error: null }
    : probeStore();
  const save = attachSaveTier(probe, options);

  // 种子：存档优先 → boot 传入 → 启动时刻。
  // ⚠️ 中间那一步是**让位**而不是覆盖：`boot({ seed })` 在有档的时候不能再"总是开新缸"，
  // 否则计划 3 每次传 seed 都会把玩家那一缸悄悄扔掉（而 saveState 之外没有任何地方看得见）。
  // 谁赢了要写进 saveState.seed —— 这就是裁定 R-7 要的"记下用的是哪一颗"。
  // 用 Date.now 而不是 Math.random：后者被 tests/constraints.test.js 全局禁止，
  // 而"每次开缸都不一样"是想要的行为，时间源足以提供它。
  const requested = options.seed !== undefined ? options.seed : null;
  const savedSeed = save.doc && Number.isFinite(save.doc.world.seed) ? save.doc.world.seed : null;
  const seed = savedSeed !== null ? savedSeed : (requested !== null ? requested : (Date.now() >>> 0));
  save.state.seed = {
    used: seed,
    requested,
    source: savedSeed !== null ? 'save' : (requested !== null ? 'boot' : 'clock'),
  };
  const world = createWorld({ seed, populationCap: cap });

  // 读档：把迁移好的那份**装进**刚建好的世界（就地改写，理由见 sim.js 的 restoreWorld 头部）。
  // 顺序要紧的两点：① 必须晚于 createWorld（那里撒了初始光藻与 8 只个体，restoreWorld 清掉它们）；
  // ② 必须早于 renderer（它拿的是 world.rng.fork()，读档会把那条流换成新的）。
  let restoredTimeScale = 1;
  if (save.doc) {
    restoreWorld(world, save.doc);
    // 倍速跟着存档走（§7.2 里 world.timeScale 那一行的唯一消费点）：只认 CONFIG.timeScales 的值，
    // 脏值就当没写过 —— 静默接受一个 1e6 会把子步进数打爆（setTimeScale 那条守卫同理）。
    if (CONFIG.timeScales.includes(save.doc.world.timeScale)) restoredTimeScale = save.doc.world.timeScale;
  }

  // viewport 只存几何量（width/height/dpr/scale）。scale 是"世界单位 → CSS 像素"，
  // 由短边推导并 clamp（spec §3.4-2，算法在下面的 createViewport 里，Node 可测）。
  // ⚠️ 它是**同一个对象被原地改写**（见 resize）：渲染层持有它的引用，
  // 换成新对象就会让 renderer.viewport 指到一份过期几何上。
  const viewport = { width: 0, height: 0, dpr: 1, scale: 1 };
  const loop = { acc: 0, steps: 0 };
  // Body 表：id → 软体状态（视状态，不进存档）。一次创建、终身复用同一个 Map，
  // 里面只在出生时增长 —— 见 body.js 的 updateBodies / reconcileBodies 注释。
  const bodies = new Map();
  // timeScale 的初值来自存档（C-1）：没有档可读时是 1，与 B11 以来的行为逐字节相同。
  const state = { frame: 0, timeScale: restoredTimeScale, lastT: -1, rafId: 0, running: true };

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
  // 声音（B18）。三条接线纪律，全部落在这一段：
  //
  // 1. **懒创建**：AudioContext 只在**首次 pointerdown** 那一刻创建。
  //    开缸就 new 的话，手机浏览器会给一个 suspended 上下文（iOS Safari 连构造都可能拒绝），
  //    症状是"桌面有声、手机上永远没声"，而且不报错。
  //    它挂在自己的那条 addEventListener 上，而不是复用 input 的 onHand 回调：
  //    onHand 由 step() 里的 input.poll() 触发，那是 rAF 的调用栈、**不是**手势的调用栈，
  //    而 resume() 只在手势调用栈内才被移动端认可。
  //    这与 B17 的"每帧一次读数"不打架：这条监听器一次都不读指针坐标，
  //    且在第一次按下时就把自己摘掉，此后零成本。
  // 2. **一次定终身**：`tried` 为真之后不再尝试 —— 连按 24 下不许 new 出 24 个上下文，
  //    console 也只响一次。降级不静默靠的是 `controller.audioState`（计划 3 的静音按钮
  //    读它决定显示与否），而不是往刷屏。
  // 3. **options.audio 注入优先**：测试用替身整个换掉叫声层时，本文件连那条手势监听都不许加。
  const audioState = { tried: false, ok: false, reason: null };
  let audio = options.audio || null;

  // 默认的上下文工厂。**整个 src/ 里那两个以 A-u-d 与 w-e-b 开头的构造名只出现在这两行**，
  // 而本文件是 tests/constraints.test.js 唯一豁免的模块（那条白名单正例守卫现在也盯着这里）。
  // ⚠️ 这里刻意**不**开 options.makeAudioContext 那个注入口：真实测试用例把构造器挂在
  // 那个假 window 上就能替（tests/audio.test.js 的三条 boot 用例走的都是这条路），
  // 多一个没人读的注入参数就是本项目反复清账的那类债。
  const makeContext = () => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('unsupported');
    return new Ctor();
  };

  const unlockAudio = () => {
    if (audioState.tried || audio) return;
    audioState.tried = true;
    try {
      const ctx = makeContext();
      // resume() 的 Promise **不等**：等就把创建推到了微任务上，而那一刻已经不在手势栈里。
      if (ctx && typeof ctx.resume === 'function' && ctx.state === 'suspended') ctx.resume();
      audio = createAudio({ graph: ctx });
      audioState.ok = true;
      audioState.reason = ctx && ctx.state === 'suspended' ? 'suspended' : null;
    } catch (err) {
      // 构造失败 ⇒ 叫声层整个不启动，缸的其余部分照常（spec §7.7 表里"AudioContext 被阻止"那一行）。
      // reason 挂在 controller 上可读 —— 这就是"不静默"：玩家/开发者都查得到为什么没声音。
      audio = null;
      audioState.ok = false;
      audioState.reason = String((err && err.message) || err);
      console.warn(`音频已降级（${audioState.reason}）：缸的其余部分照常运行。`);
    }
  };

  // 首次手势解锁音频。挂在**绘制元素**而不是 window 上：那样本文件不必为了音频
  // 再多摸一个浏览器对象，且页面别处的点击不会白白点亮一个上下文。
  // options.audio 已注入（测试替身）时不加这条监听 —— 替身不该被真实手势点亮第二个图。
  let gestureTarget = null;
  if (!audio && canvasEl && typeof canvasEl.addEventListener === 'function') {
    gestureTarget = canvasEl;
    canvasEl.addEventListener('pointerdown', unlockAudio);
  }

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

  // 可选 API 档（B19b-ii）。它住在本文件而不是 api.js 的理由写在 tests/constraints.test.js：
  // 那两个名字（本机存储与发请求的能力）在 src/ 里只许出现在这里。
  //
  // ⚠️ 关掉时（出厂默认，或存储里的 cfg 不合格）它在帧循环里**一个字节都不多做**：
  // 下面 step() 里那个 `api.state.active` 是唯一的分支，false 时连交付数组都不碰。
  // 这条不是注释 —— tests/api.test.js 拿"零次请求 + 世界指纹与对照缸逐位相同"钉它。
  //
  // ⚠️ 交付顺序：档位开着时，那一拍的 say 事件被**两个消费方一起晚收到**（气泡与「啾」
  // 同时出现，只是晚一点，最多晚 apiHoldMs 毫秒）。这是表现侧的时序，世界状态一个字节没变
  // （spec §4.13.2.1 第 7 条把这条代价如实记着）。
  const api = attachApiTier(world, { storage: options.storage, fetch: options.fetch });
  // 只有档位开着时才用的交付缓冲（复用，每帧清空，不在关闭路径上分配）。
  const delivery = [];

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

    // 落盘那一眼（C-1，裁定 R-3）。放在子步循环**之后**：要存的是本帧推进完的世界，
    // 放之前就会每次都少存一帧（最多差一个 fixedDt = 16.7 模拟毫秒，看不见，但没必要留)。
    // ⚠️ 这一眼可能吃掉一整帧的成本（实测满缸 serialize+stringify 中位 1.86ms、最坏 4.22ms，
    //    再加一次同步的 localStorage 写），所以它**必须**由 everySimSec 与 minIntervalMs 两道闸拦住 ——
    //    这里的分支只是"够不够 30 模拟秒"这一次数值比较，没到点时一个字节都不做。
    save.frame(t);

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

    // 事件消费（B16 接溶散粒子、B18 接叫声、B19a 接气泡、B19b-ii 接 API 档的暂存交付）。
    // ⚠️ 必须每帧清空：world.events 是**无界增长**的（sim.js 只写不读、不代为清理），
    // 开一小时的标签页会把它涨到几十万条，然后每帧遍历它。
    // ⚠️ 清空由**这里**做、消费方一律不清空：renderer 与 audio 读同一批事件，
    // 谁先清空谁就把事件从另一个人手里抢走了（render.js 的 consumeEvents 顶部那条）。
    // 这就是 B16 已经在接、而 audio 要到 B18 才存在也不能改成"audio 自己清"的原因。
    //
    // ⚠️ 档位开着时消费者读的是 `delivery`（= 本帧该出现的那些话，含刚从暂存队列放出来的），
    // 关掉时读的就是 `world.events` 本身 —— 同一个数组引用，一次拷贝都没有。
    // 那条 `api.state.active` 是这一段唯一的分支，也是"关掉 ⇒ 零额外动作"那条断言的对象。
    let events = world.events;
    if (api.state.active) {
      delivery.length = 0;
      events = api.frame(world.events, t, delivery);
    }
    if (events.length > 0) {
      if (renderer) consumeEvents(renderer, events);
    }
    // ⚠️ audio.consume 刻意**不在**上面那个 `events.length > 0` 的守卫里 —— 这是 B18 接线上
    // 唯一一处非对称，理由值得写全：
    // renderer 只读事件，没有事件的帧它确实无事可做；而叫声层有**第二条通道**——
    // 内核不发明"情绪事件"（spec §5.4.1 第 1 条），所以"开心/生气/困倦/撒娇"那几声与
    // hop 落地那记闷响全靠每帧巡检 world 的现量、判阈值跨越。
    // 把它放进 if 里的症状不是报错，而是"这缸只在有 eat/hatch/死掉的那些帧里才可能叫"，
    // 而那样的帧在 60 分钟里占不到百分之几 —— 玩家听到的是一缸哑巴。
    // 这一条由 tests/audio.test.js 的「audio.consume 不在事件守卫之内（它还有第二通道）」钉住。
    // ⚠️ B19b-ii 之后它读的也是 `events`（档位开着时那份"本帧该出现的"而不是原始那批）：
    // 还回 world.events 的话，被按住的那一拍会在按住它的那几帧里**先响一声**，
    // 而决策 A 说得很清楚：气泡与「啾」要一起晚一点出现，而不是各响一次。
    if (audio) audio.consume(events, world);
    world.events.length = 0;
  };

  const controller = {
    world,
    viewport,
    bodies,
    input,           // B17：暴露给 devtools 与测试取证（metrics 里那三个计数器）
    get audio() { return audio; },        // B18：懒创建，所以按之前是 null、按之后是那个实例
    audioState,      // { tried, ok, reason } —— 降级是否发生的**唯一**可读证据
    getMuted() { return audio ? audio.getMuted() : true; },
    setMuted(value) {
      // 没有音频可控制时**返回当前事实**（true = 听不见），而不是抛错：
      // 计划 3 的静音按钮在降级缸里也得能把按钮自己置灰，靠的是这个返回值而不是异常。
      if (!audio) return true;
      audio.setMuted(value);
      return audio.getMuted();
    },
    get frame() { return state.frame; },
    // ---- 存档层（C-1，裁定 R-6：计划 2 没有 HUD，所以这三个就是唯一的入口）----
    // `__tank.saveState` 是这一层**唯一**的可读证据（与 audioState 同形）：
    // source 说这次开缸读到了什么，bytes/writes/quotaHits 说落盘的代价与失败，
    // quarantined/discarded 说那份读不懂的档现在在哪儿。
    save,
    saveState: save.state,
    // 立刻落一次盘（跳过 minIntervalMs 那道节流，但**不跳过** R-1 那道守卫：
    // 'quarantine-failed'/'store-unreadable' 时它返回 0 并什么都不写）。返回写入的字节数。
    saveNow() { return save.saveNow(); },
    // 两个键**都**摘掉：只清主键会把隔离区里那份留成孤儿，而它再也没人读了。
    clearSave() { return save.clearSave(); },
    // ---- 可选 API 档（B19b-ii）----
    // 档位的全部读数：`{ pending, state, stats, getApiConfig, setApiConfig, frame, abandon }`。
    // 计划 2 没有设置页，所以填端点与 key 的入口就是这两个方法（spec §4.13.2.1 第 6 条），
    // 而 `globalThis.__tank` 就是下面这个 controller —— 于是 devtools 里
    // `__tank.setApiConfig({enabled:true, endpoint:'https://…', model:'…', key:'…'})` 是唯一的通道。
    api,
    // ⚠️ 决策 D：这份读数**永远不许含 key 的值**（它只报 hasKey）。tests/api.test.js
    // 拿"JSON.stringify 里搜不到那条子串"钉它 —— 靠注释挡不住下一个改这里的人。
    getApiConfig: api.getApiConfig,
    setApiConfig(patch) { return api.setApiConfig(patch); },
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
      // 那条一次性的手势监听也要摘掉：缸停了还留一个会创建 AudioContext 的回调，
      // 就是"关掉页面之后第一下点击把音频图又点亮"。
      if (gestureTarget) {
        gestureTarget.removeEventListener('pointerdown', unlockAudio);
        gestureTarget = null;
      }
      if (audio && audio.close) audio.close();
      // 档位（B19b-ii）：把还挂着的请求一律掐掉、把还按着的话一律收走（都带计数）。
      // 这一步之后不可能再有"迟到的回复把字塞进气泡池"那一幕 —— 因为本文件从头到尾
      // **没有一个定时器**：交付只发生在 step() 里，而 step() 已经不跑了（决策 B）。
      api.abandon();
      // 存档层（C-1）：**只摘监听，不落盘**（裁定 R-3 的最后一句，spec §7.2.1 里写着理由）。
      // stop() 是 devtools 与测试的收尾入口，不是浏览器的收尾入口 —— 后者是 pagehide，
      // 而那条**已经**会落一次盘。让 stop() 也写就会出这样一幕：一缸被测试泵出来的
      // 假世界盖掉玩家真读过的那一份 —— 恰好是 R-1 禁止的那个形状。
      save.detach();
      window.removeEventListener('resize', resize);
      if (activeController === controller) activeController = null;
    },
  };

  window.addEventListener('resize', resize);
  resize();
  // 存档层的挂载点在这里而不是别处：`getPacing` 要读的是**上面那个 state**，
  // 而两条即时落盘的监听必须等到 controller 拼好、world 已经装完才挂（早挂一步，
  // 监听器就会在一个还没有 bodies / renderer 的世界里落一次盘 —— 那份档本身没问题，
  // 但 saveState 的读数会指向一个还没装配完的缸，取证时会把自己绕进去）。
  save.attach(world, () => state.timeScale);
  activeController = controller;
  state.rafId = requestAnimationFrame(step);
  return controller;
}

// 自动启动。守卫让本模块在 Node 里 import 时**不执行**任何 DOM 代码 ——
// tests/loop.test.js 依赖这一点。
//
// ⚠️ globalThis.__tank 是计划 2 的临时手段：没有 HUD，所以倍速与静音只能在 devtools 里调
// （__tank.setTimeScale(4) / __tank.setMuted(true) / __tank.audio.stats 取证）。
// 计划 3 加了 HUD 之后应当删掉它（或者留着当调试入口，但要写进文档）。
if (typeof globalThis.document !== 'undefined') {
  globalThis.__tank = boot();
}
