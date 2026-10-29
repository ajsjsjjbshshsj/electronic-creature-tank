// 共享存档**接线**的 boot 级测试（与 tests/remote.test.js 的纯层分家）。
//
// 纯层只证明"怎么理解响应"；这一层证明"页面真的把缸交给服务器、真的在 409 时停手、
// 真的在两份选择里各做对一件事"。这四件事只有跑真的 boot() 才测得到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { boot, primeRemote } from '../src/main.js';
import { createWorld } from '../src/sim.js';
import { serialize } from '../src/save.js';

const KEY = CONFIG.save.key;

// ---------------------------------------------------------------- 桩

function makeStore(initial) {
  const m = new Map(Object.entries(initial || {}));
  const s = {
    perKey: {},
    bump(kind, k) { const id = `${kind}:${k}`; s.perKey[id] = (s.perKey[id] || 0) + 1; },
    readsOf: (k) => s.perKey[`read:${k}`] || 0,
    writesOf: (k) => s.perKey[`write:${k}`] || 0,
    getItem(k) { s.bump('read', k); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { s.bump('write', k); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    has: (k) => m.has(k),
    raw: (k) => (m.has(k) ? m.get(k) : null),
  };
  return s;
}

// 一台"能记账"的服务器：`routes` 是一串预设响应，按调用顺序取；用完之后用最后一条。
// 每一次调用都记下来 —— 断言"409 之后再也不发 PUT"只能靠这个计数。
// 返回的是**函数本身**（boot 的 options.fetch 就是它），calls/puts 挂在函数上 ——
// 否则很容易顺手把 {fetch, calls} 这个对象当 fetch 传进去，而错误会以
// "fetcher is not a function" 的形式在 promise 里被吞成一次降级，看起来像接线坏了。
function fakeServer(routes) {
  const calls = [];
  const fetch = (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
    const idx = Math.min(calls.length - 1, routes.length - 1);
    const r = routes[idx];
    if (r && r.throw) return Promise.reject(new Error(r.throw));
    return Promise.resolve({
      status: r.status,
      text: () => Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    });
  };
  fetch.calls = calls;
  fetch.puts = () => calls.filter((c) => c.method === 'PUT');
  return fetch;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 一份真的能过 migrate/assert 的缸（用 serialize 从真世界导出，不手搓字段）。
function realDoc(seed, revision, savedAt) {
  const doc = JSON.parse(JSON.stringify(serialize(createWorld({ seed, initialCreatures: 2 }), { savedAt })));
  doc.revision = revision;
  doc.savedAt = savedAt;
  return doc;
}

function makeCtx(canvas) {
  const real = {
    canvas,
    measureText: (s) => ({ width: String(s).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(real, {
    get(t, p) { if (p in t) return t[p]; t[p] = function noop() {}; return t[p]; },
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

async function withRemoteTank(opts, fn) {
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
    addEventListener(type, f) { this.listeners[type] = f; },
    removeEventListener(type) { delete this.listeners[type]; },
    visibilityState: 'visible',
  };
  g.window = {
    devicePixelRatio: 1, innerWidth: 900, innerHeight: 620,
    matchMedia: () => ({ matches: false }),
    listeners: {},
    addEventListener(type, f) { this.listeners[type] = f; },
    removeEventListener(type) { delete this.listeners[type]; },
  };
  g.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  g.cancelAnimationFrame = () => {};
  const warns = [];
  console.warn = (...a) => { warns.push(a.join(' ')); };

  const store = o.store === undefined ? makeStore() : o.store;
  const bootOpts = {
    hud: false,
    canvas: makeCanvas(900, 620),
    seed: o.seed === undefined ? 20261022 : o.seed,
    storage: store,
    fetch: o.fetch,
    remote: o.remote,
  };
  let controller = null;
  let lastT = 0;
  const frame = (dtMs) => { lastT += dtMs === undefined ? 16.7 : dtMs; cbs[cbs.length - 1](lastT); };
  const run = (simSec) => { const n = Math.ceil((simSec * 1000) / 16.7); for (let i = 0; i < n; i++) frame(); };
  try {
    controller = boot(bootOpts);
    return await fn({ controller, store, frame, run, warns });
  } finally {
    if (controller) controller.stop();
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
    console.warn = saved.warn;
  }
}

// ============================================================ 判据

test('primeRemote：网络错不抛，归成 error；200+HTML（静态站）也归 error', async () => {
  const down = await primeRemote({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
  assert.equal(down.kind, 'error');
  assert.match(down.reason, /ECONNREFUSED/, '降级的原因必须可读（§7.7 不许静默）');
  const staticSite = await primeRemote({ fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve('<html>') }) });
  assert.equal(staticSite.kind, 'error', 'GitHub Pages 那种静态站必须走降级而不是当成空缸');
  const thrown = await primeRemote({ fetch: () => Promise.resolve({ status: 200, text: () => Promise.reject(new Error('aborted')) }) });
  assert.equal(thrown.kind, 'error', '读 body 时出的错也必须归 error');
});

test('远端有档、本机空 ⇒ 用远端那一缸，backend 是 remote，本机主键一次都不写', () => withRemoteTank({
  remote: { kind: 'ok', revision: 5, doc: realDoc(7, 5, 'r5') },
  fetch: fakeServer([{ status: 200, body: { revision: 6 } }]),
}, async ({ controller, store, run }) => {
  assert.equal(controller.remoteState.backend, 'remote');
  assert.equal(controller.saveState.revision, 5);
  assert.equal(controller.world.seed, 7, '世界必须来自远端那一份（种子是它的）');
  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.equal(store.writesOf(KEY), 0, '远端模式**不许**写本机主键：两份真相并存就得先猜谁是新的');
  assert.equal(controller.remoteState.stats.puts, 1, '跑过节奏之后必须真的 PUT 了一次');
  assert.equal(controller.remoteState.stats.ok, 1);
  assert.equal(controller.saveState.revision, 6, '版本号只认服务器回来的那个');
}));

test('服务器不可达 ⇒ 退回本机档、挂降级原因；角标判据就是 fallbackReason 非空', () => withRemoteTank({
  remote: { kind: 'error', reason: 'ECONNREFUSED' },
  fetch: fakeServer([{ throw: 'ECONNREFUSED' }]),
}, async ({ controller, store, run }) => {
  assert.equal(controller.remoteState.backend, 'local');
  assert.equal(controller.saveState.fallbackReason, 'ECONNREFUSED');
  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.ok(store.has(KEY), '降级之后必须真的写本机，否则这一缸就只活在内存里');
  assert.equal(controller.remoteState.stats.puts, 0, '降级之后不许再去敲服务器');
}));

test('409 ⇒ 冻结远端、转本机继续存；冲突读数里带着服务器的版本号', () => withRemoteTank({
  remote: { kind: 'ok', revision: 5, doc: realDoc(7, 5, 'r5') },
  fetch: fakeServer([
    { status: 409, body: { revision: 9 } },
    { status: 200, body: { revision: 10 } },
  ]),
}, async ({ controller, store, run }) => {
  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.deepEqual(controller.saveState.conflict, { remoteRevision: 9 });
  assert.equal(controller.remoteState.backend, 'local', '冲突之后转本机：这一缸还得活得下去');
  const putsAfterConflict = controller.remoteState.stats.puts;
  assert.equal(putsAfterConflict, 1);

  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.equal(controller.remoteState.stats.puts, putsAfterConflict, '冲突没解决之前**再也不许** PUT');
  assert.ok(store.has(KEY), '冲突期间的进度必须落到本机（绝不静默丢）');

  // "接管"：拿服务器的 9 当 baseRevision 再来一次，回来 10
  assert.equal(controller.resolveConflict('force-mine'), true);
  await tick();
  const last = controller.remoteState.stats;
  assert.equal(last.puts, putsAfterConflict + 1, '"接管"必须真的再发一次 PUT');
  assert.equal(controller.saveState.conflict, null, '解决之后冲突读数要清掉');
  assert.equal(controller.saveState.revision, 10);
  assert.equal(controller.remoteState.backend, 'remote');
}));

test('"加载它的版本"：GET 回来并用它 restore 现场（不用刷新页面）', () => withRemoteTank({
  remote: { kind: 'ok', revision: 5, doc: realDoc(7, 5, 'r5') },
  fetch: fakeServer([
    { status: 409, body: { revision: 9 } },
    { status: 200, body: { revision: 9, doc: realDoc(8, 9, 'r9') } },   // 之后所有的 GET
    { status: 200, body: { revision: 10 } },
  ]),
}, async ({ controller, run }) => {
  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.ok(controller.saveState.conflict, '前置条件：先进入冲突');
  const before = controller.world.seed;
  await controller.resolveConflict('take-theirs');
  assert.equal(controller.saveState.conflict, null);
  assert.equal(controller.saveState.revision, 9);
  assert.equal(controller.remoteState.backend, 'remote');
  assert.equal(controller.world.seed, 8, `现场必须换成远端那一缸（原 ${before}）`);
}));

test('两端都有档且不同 ⇒ 启动时就是冲突（静默挑一边就是丢一边的进度）', () => withRemoteTank({
  store: makeStore({ [KEY]: JSON.stringify(realDoc(3, 2, 'local')) }),
  remote: { kind: 'ok', revision: 5, doc: realDoc(7, 5, 'r5') },
  fetch: fakeServer([{ status: 200, body: { revision: 6 } }]),
}, async ({ controller, run }) => {
  assert.deepEqual(controller.saveState.conflict, { remoteRevision: 5 },
    '两边不一样就必须摆给玩家看，而不是"远端更新所以用远端"');
  assert.equal(controller.world.seed, 3, '冲突时先跑本地那份（这一缸是玩家眼前这一份）');
  run(CONFIG.save.everySimSec + 2);
  await tick();
  assert.equal(controller.remoteState.stats.puts, 0, '冲突期间一次 PUT 都不许发');
}));
