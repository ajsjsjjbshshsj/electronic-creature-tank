// C-1：存档**接线**的 boot 级测试（与 tests/save.test.js 的纯函数层分家）。
//
// 为什么单独一个文件、为什么这些测试非 boot 不可：`save.js` 早就有 13 条单测，
// 而它当时仍然是一个**没人 import 的模块** —— 纯函数测得再全，也证不了"页面真的会落盘、
// 真的会读回来、读不懂时真的不会把用户的唯一一份覆盖掉"。那三件事全在接线层，
// 而接线层只有跑真的 `boot()` 才测得到。
//
// 承重的是一条数据丢失路径（裁定 R-1）：
//   加载失败 → 起一缸新的 → 定期落盘 → **把用户那份读不懂、但可能救得回的档覆盖掉**。
// 所以下面最严的一条不是"能存能读"，而是"坏档先原样挪进隔离区，且之后任何一次自动落盘
// 都不许碰隔离区"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { boot } from '../src/main.js';
import { SAVE_VERSION } from '../src/save.js';
import { ALL_GENES } from '../src/genes.js';

const KEY = CONFIG.save.key;
const CORRUPT = CONFIG.save.corruptKey;

// ---------------------------------------------------------------- 桩

// 一个**会数自己**的 localStorage：`save:false` 那条要断言的是"连读都没有读"，
// 所以计数必须由被观测方自己报，不能让测试猜。
function makeStore(initial) {
  const m = new Map(Object.entries(initial || {}));
  const s = {
    reads: 0, writes: 0, removes: 0, failWrite: false,
    // 按**键**计数：API 档与存档共用同一个 storage，只数总数的话
    // "存档这一层关着时零读写"那条会被另一层的正常读给假红掉。
    perKey: {},
    bump(kind, k) { const id = `${kind}:${k}`; s.perKey[id] = (s.perKey[id] || 0) + 1; },
    readsOf: (k) => s.perKey[`read:${k}`] || 0,
    writesOf: (k) => s.perKey[`write:${k}`] || 0,
    getItem(k) { s.reads += 1; s.bump('read', k); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      s.writes += 1; s.bump('write', k);
      if (s.failWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem(k) { s.removes += 1; m.delete(k); },
    has: (k) => m.has(k),
    raw: (k) => (m.has(k) ? m.get(k) : null),
    keys() { return [...m.keys()]; },
  };
  return s;
}

// 一碰就抛的存储：Safari 隐私模式下**光是读 localStorage 这个属性**就抛，
// 所以这里抛在 getter 上而不是方法上。
const boomStore = {
  get reads() { throw new Error('SecurityError'); },
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
  removeItem() { throw new Error('SecurityError'); },
};

// ctx 用 Proxy 兜住：绘制层用到的方法一直在长（B13→B20 加了八层），
// 逐个数方法名的桩会在下一次加层时假红成"存档接线坏了"。只有真有返回值的三个特判。
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

function makeCanvas(w, h) {
  const el = { width: w, height: h, clientWidth: w, clientHeight: h, style: {} };
  el.getContext = () => makeCtx(el);
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  return el;
}

// 跑一缸真的 boot 起来的页面：假 document / window / rAF，帧由测试手动泵。
// ⚠️ 每个碰过的全局都在 finally 里还原 —— 否则后面的文件会继承一个被桩替掉的
// localStorage，那种串味在这个项目里咬过不止一次。
async function withSaveTank(opts, fn) {
  const o = opts || {};
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
    warn: console.warn,
  };
  const cbs = [];
  g.document = {
    createElement: () => makeCanvas(900, 620),
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    visibilityState: 'visible',
  };
  g.window = {
    devicePixelRatio: 1, innerWidth: 900, innerHeight: 620,
    matchMedia: () => ({ matches: false }),
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
  };
  g.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  g.cancelAnimationFrame = () => {};
  const warns = [];
  console.warn = (...a) => { warns.push(a.join(' ')); };

  const store = o.store === undefined ? makeStore() : o.store;
  const bootOpts = {
    canvas: makeCanvas(900, 620),
    seed: o.seed === undefined ? 20261022 : o.seed,
    storage: store,
  };
  if (o.save === false) bootOpts.save = false;
  let controller = null;
  let lastT = 0;
  const frame = (dtMs) => { lastT += dtMs === undefined ? 16.7 : dtMs; cbs[cbs.length - 1](lastT); };
  // 落盘节奏是 **30 模拟秒**，而一次 frame 只推进 16.7ms ⇒ "等一会儿"必须是显式的。
  const run = (simSec) => { const n = Math.ceil((simSec * 1000) / 16.7); for (let i = 0; i < n; i++) frame(); };
  try {
    controller = boot(bootOpts);
    return await fn({ controller, store, frame, run, warns, doc: g.document, win: g.window, lastT: () => lastT });
  } finally {
    if (controller) controller.stop();
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
    console.warn = saved.warn;
  }
}

// ============================================================ 第 1 行：空档 ⇒ 新缸，并且真的落盘

test('空存储开局：source 是 fresh；跑过 everySimSec 之后主键下真的躺了一份档', () => withSaveTank({}, ({ controller, store, run }) => {
  assert.equal(controller.saveState.enabled, true, '默认必须开着（关掉是设置页的动作）');
  assert.equal(controller.saveState.source, 'fresh', '空存储不该假装"恢复了"');
  assert.equal(store.has(KEY), false, '刚 boot 就写盘 = 每次刷新都白写一次');
  run(CONFIG.save.everySimSec + 5);
  assert.ok(store.has(KEY), '跑过节奏之后必须已经落盘');
  assert.ok(controller.saveState.writes >= 1, `落盘次数要有读数，实测 ${controller.saveState.writes}`);
  assert.ok(store.raw(KEY).length > 1000, '档 contents 太短说明序列化根本没带上个体');
}));

test('落盘节奏走的是**模拟秒**：倍速只改真实墙钟的密度，不改"缸推进了多少才存一次"', () => withSaveTank({}, ({ controller, store, frame }) => {
  // 1× 下攒够一次写入
  runToFirstWrite(controller, store, frame, 16.7);
  const w1 = controller.saveState.writes;
  assert.ok(w1 >= 1, '一次都没写 = 节奏根本没接上帧循环');
  // 再跑同样多的**模拟秒**，写入数必须继续涨（不是"跑满多少毫秒才写"）
  runToFirstWrite(controller, store, frame, 16.7);
  assert.ok(controller.saveState.writes > w1,
    `同样多的模拟秒没有换来第二次落盘 ⇒ 节奏被墙钟绑架了：${w1} → ${controller.saveState.writes}`);
}));

function runToFirstWrite(controller, store, frame, dt) {
  const before = controller.saveState.writes;
  const t0 = controller.world.time;
  let guard = 0;
  while (controller.saveState.writes === before && guard < 6000) { frame(dt); guard += 1; }
  assert.ok(controller.world.time - t0 < CONFIG.save.everySimSec + 2,
    '跑了远超 everySimSec 还没落盘：节奏没接上');
  return controller.saveState.writes;
}

// ============================================================ 第 2 行：存下去、读回来

test('存下去再开一缸：source 是 restored，个体的名字/基因/口癖逐字回来', () => {
  const shared = makeStore();
  return withSaveTank({ store: shared }, ({ controller, run }) => {
    run(CONFIG.save.everySimSec + 5);
    controller.saveNow();
    const c = controller.world.creatures[0];
    shared.snapshot = {
      name: c.name, genes: JSON.parse(JSON.stringify(c.genes)), catchphrase: c.catchphrase,
      hue: c.traits.hue, time: controller.world.time,
    };
  }).then(() => withSaveTank({ store: shared }, ({ controller }) => {
    assert.equal(controller.saveState.source, 'restored', '第二缸必须认得出这是从档里来的');
    const c = controller.world.creatures[0];
    const want = shared.snapshot;
    assert.equal(c.name, want.name, '名字没回来 = 恢复只恢复了数字，个体还是陌生的');
    assert.deepEqual(c.genes, want.genes, '基因必须逐位相同（血脉是这份档最值钱的东西）');
    assert.equal(c.catchphrase, want.catchphrase, '口癖是**唯一**允许入档的表现层状态（§7.2），必须回来');
    assert.equal(c.traits.hue, want.hue);
    assert.ok(controller.world.time >= want.time - 1,
      `world.time 要接得上：${controller.world.time} vs ${want.time}`);
  }));
});

test('恢复走的是 migrate()，不是"把 JSON 直接塞进世界"（裁定 R-5 的机器形式）', () => withSaveTank({
  store: makeStore({
    // 一份**v1 形状**的旧档（照 tests/save.test.js 那份夹具的骨架）：
    // 14 个位点（v2 是 19 个）、没有 traits / thresholds / heard / catchphrase 这一整批派生字段。
    [KEY]: JSON.stringify({
      version: 1,
      world: { seed: 12345, time: 900 },
      creatures: [{
        id: 'old-1', name: '旧旧', customName: false, generation: 2,
        stage: 'juvenile', age: 214.5, alive: true, sick: false,
        genes: Object.fromEntries(ALL_GENES.slice(0, 14).map((g) => [g, [0.4, 0.7]])),
        needs: { hunger: 0.2, energy: 0.4, social: 0.1, safety: 0.05 },
        emotions: { joy: 0.6, anger: 0, fear: 0.1, curiosity: 0.3, sleepy: 0.2, arousal: 0 },
        pos: { x: 0.4, y: 0.6 }, vel: { x: 0, y: 0 },
        memory: [], lineage: { mother: null, father: null, offspring: [] },
      }],
    }),
  }),
}, ({ controller }) => {
  assert.equal(controller.saveState.source, 'restored', 'v1 档是**能迁**的，不该被当坏档隔离');
  const c = controller.world.creatures[0];
  assert.equal(c.name, '旧旧');
  assert.ok(c.traits && Number.isFinite(c.traits.size), 'migrate 必须把 sizeOf 那批派生字段补回来');
  assert.ok(c.thresholds && Number.isFinite(c.thresholds.hopMinDuration),
    'thresholds 没重建 = 这只个体一辈子不会蹦跳，而且不报错');
  assert.equal(c.generation, 2, '世代是这份档最值钱的信息之一，必须原样回来');
  assert.ok(Array.isArray(c.heard), 'heard 缺失会被 normalizeMemory 补成空数组，不是 undefined');
  assert.equal(controller.world.creatures.length, 1);
}));

// ============================================================ 第 3 行：R-1，坏档绝不被覆盖

// 三种"读不懂"各测一遍：坏 JSON、比实现更新的版本、能解析但形状不对。
// 它们必须走同一条路：**原样挪进隔离区** → 开新缸 → 之后任何自动落盘都不许碰隔离区。
const badBlobs = [
  ['坏 JSON', '{ "version": 2, 这不是 JSON'],
  ['比实现还新的版本', JSON.stringify({ version: SAVE_VERSION + 1, creatures: [], world: {} })],
  ['能解析但没有 creatures', JSON.stringify({ version: SAVE_VERSION, world: { time: 1 } })],
  ['有 creatures 但个体缺 id', JSON.stringify({ version: SAVE_VERSION, creatures: [{ name: '没身份' }], world: {} })],
];

for (const [label, blob] of badBlobs) {
  test(`坏档（${label}）：先原样进隔离区，再开新缸，且自动落盘不许覆盖隔离区（R-1）`, () => withSaveTank({
    store: makeStore({ [KEY]: blob }),
  }, ({ controller, store, run }) => {
    assert.equal(store.raw(CORRUPT), blob,
      '隔离区里必须是**逐字节原样**的那一份 —— 转手 JSON.parse 再 stringify 就等于二次损坏');
    assert.equal(controller.saveState.source, 'corrupt-moved', '可读证据必须说清这份档去哪了');
    assert.ok(controller.saveState.quarantined, 'quarantined 读数必须为真');
    assert.equal(controller.world.creatures.length, CONFIG.initialCreatures, '新缸照常起');

    // 承重的那一步：跑过节奏，让自动落盘真的发生，然后回头看隔离区
    const before = controller.saveState.writes;
    run(CONFIG.save.everySimSec + 5);
    assert.ok(controller.saveState.writes > before, '夹具：这段时间里必须真的落过盘');
    assert.equal(store.raw(CORRUPT), blob, '自动落盘把隔离区覆盖了 ⇒ 用户那份档彻底没了');
    assert.notEqual(store.raw(KEY), blob, '主键下现在应该是新缸的档');
  }));
}

test('隔离区已经有一份时又来一份坏档：留最早的那一份，后一份**计数**丢弃（不静默）', () => withSaveTank({
  store: makeStore({ [KEY]: '第一份坏档', [CORRUPT]: '更早的一份坏档' }),
}, ({ controller, store }) => {
  assert.equal(store.raw(CORRUPT), '更早的一份坏档', '隔离区不许被后来的覆盖 —— 那等于二次销毁');
  assert.ok(controller.saveState.discarded >= 1,
    `被放弃的那一份必须有计数，否则"丢了"和"没丢"看起来一样：${controller.saveState.discarded}`);
}));

// ============================================================ 第 4 行：写不进 / 根本不能用

test('配额爆了：缸照常跑、quotaHits 计数、warn 恰好一次', () => withSaveTank({}, ({ controller, store, run, warns }) => {
  store.failWrite = true;
  run(CONFIG.save.everySimSec * 3);
  assert.ok(controller.saveState.quotaHits >= 1, '写失败要留读数');
  assert.equal(controller.world.creatures.length, CONFIG.initialCreatures, '写不进去不影响这一缸活着');
  const n = warns.filter((w) => /配额|quota|写不进/i.test(w)).length;
  assert.ok(n <= 1, `每帧刷一条 warn 是把"不静默"做成骚扰：实测 ${n} 条`);
}));

test('存储整个不可用（Safari 隐私模式）：按关着处理，缸照常跑，只 warn 一次', () => withSaveTank({
  store: boomStore,
}, ({ controller, warns }) => {
  assert.equal(controller.saveState.enabled, false, '读都不许读成功 ⇒ 这一层整个退场');
  assert.equal(controller.world.creatures.length, CONFIG.initialCreatures, '没有存档也必须有一缸活的');
  // 只数**存档这一层**的警告：同一个 storage 也喂给了 API 档，它自己也会响一次
  // （"API 档的本机存储读不出来…"）。两层各响一次是**正确行为**，数在一起就是一条假红。
  const mine = warns.filter((w) => /存档通道/.test(w));
  assert.ok(mine.length === 1, `存档通道的降级警告必须恰好一条，实测 ${mine.length} 条：${JSON.stringify(warns)}`);
}));

test('save:false 时连**属性访问**都不许有（隐私模式下读 localStorage 就会抛）', () => withSaveTank({
  store: makeStore({ [KEY]: '不该被读到的东西' }), save: false,
}, ({ controller, store, run }) => {
  assert.equal(controller.saveState.enabled, false);
  run(CONFIG.save.everySimSec * 2);
  assert.equal(store.readsOf(KEY), 0, `关着还读了主键 ${store.readsOf(KEY)} 次`);
  assert.equal(store.writesOf(KEY), 0, '关着还写了主键');
  assert.equal(store.readsOf(CORRUPT), 0, '关着还不许去探隔离区');
}));

// ============================================================ 第 5 行：手动口与清理

test('saveNow() 立刻落盘、clearSave() 摘掉两个键，之后开缸是 fresh', () => withSaveTank({}, ({ controller, store }) => {
  controller.saveNow();
  assert.ok(store.has(KEY), '显式按了就该落盘（"按了没反应"会让人以为存档坏了）');
  store.setItem(CORRUPT, '一份坏档');
  controller.clearSave();
  assert.equal(store.has(KEY), false, 'clearSave 必须真的把主键摘掉');
  assert.equal(store.has(CORRUPT), false, '隔离区也要一起清，否则清完还是"读不懂"');
  assert.ok(controller.saveState.cleared >= 2, `摘掉的键数要可断言：${controller.saveState.cleared}`);
}));

test('存档里不许有 API 档的 key（§7.2 末那条纪律在落盘路径上的形式）', () => {
  const store = makeStore();
  return withSaveTank({ store, seed: 20261023 }, ({ controller, run }) => {
    controller.setApiConfig({ enabled: true, endpoint: 'https://x.test/v1', model: 'm', key: 'sk-NEVER-IN-THE-SAVE-9z' });
    run(CONFIG.save.everySimSec + 5);
    controller.saveNow();
    const blob = store.raw(KEY) || '';
    assert.ok(!blob.includes('sk-NEVER-IN-THE-SAVE-9z'),
      'save.json 是局域网多设备共享的明文，写进去等于把 key 广播到每台设备');
    assert.ok(!/tank\.api\.v1/.test(blob), 'API 配置不许被顺带存进世界档里');
  });
});

// ============================================================ 第 6 行：minIntervalMs 这道墙钟下限

// 节奏那半边由**模拟秒**管，这一条管另一件事：连点标签页会在几秒里发十几次
// visibilitychange，没有墙钟下限就是十几次 160KB 的同步写。
// ⚠️ 显式 saveNow() **不受**这条限制（那是人在 devtools 里按的，"按了没落盘"更糟），
// 所以这里走的是事件那两条路，不是 saveNow。
test('visibilitychange 连发：minIntervalMs 之内只许落一次盘（事件路径的墙钟下限）', () => withSaveTank({}, ({ controller, store, frame, doc, win }) => {
  const fire = () => {
    // 真实浏览器只在**切走**那一刻发 visibilitychange，而处理器第一行就是查 visibilityState；
    // 所以夹具必须把状态真的改成 hidden，否则测的是"切走但不隐藏"那条根本不存在的路径。
    doc.visibilityState = 'hidden';
    if (doc.listeners.visibilitychange) doc.listeners.visibilitychange();
    else if (win.listeners.pagehide) win.listeners.pagehide();
  };
  assert.ok(doc.listeners.visibilitychange || win.listeners.pagehide,
    '那两条即时落盘的监听必须真的挂上了，否则这条测试是在空转');
  frame();
  const w0 = controller.saveState.writes;
  fire();
  assert.ok(controller.saveState.writes > w0, '第一次切走必须立刻落盘（崩溃前最后一次机会）');
  const w1 = controller.saveState.writes;
  for (let i = 0; i < 12; i++) { frame(50); fire(); }        // 600ms 内连发 12 次，远小于 2000ms
  assert.equal(controller.saveState.writes, w1,
    `墙钟下限没拦住：600ms 内又写了 ${controller.saveState.writes - w1} 次同步落盘`);
  frame(CONFIG.save.minIntervalMs + 100);
  fire();
  assert.ok(controller.saveState.writes > w1, '过了下限之后必须还能写，否则这条守卫变成"只存一次"');
  void store;
}));

test('显式 saveNow() 绕过墙钟下限（人按的按钮不该被防抖吞掉）', () => withSaveTank({}, ({ controller, store }) => {
  controller.saveNow();
  const n = store.writesOf(KEY);
  controller.saveNow();
  assert.equal(store.writesOf(KEY), n + 1, '连按两次必须真的写两次');
}));
