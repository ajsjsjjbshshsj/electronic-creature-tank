# 伙伴关系 · 同步脉动 · 小铃音 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `socialize` 补上它的"高级表现"—— 两只吃饱、互相有好感、都开心的个体会自发同步脉动，同步成功响一记两音小铃，长期凑在一起的互相成为 `companion`（家谱虚线与信息卡"同伴"行的第一个生产者）。

**Architecture:** 内核新增一个纯模块 `src/social.js`（门控 + 同步度读数 + 计时推进），由 `sim.js` 的新 `tickSocial` 每 tick 逐只调用；三个瞬时字段挂在 creature 上（不入档）。表现层只加两处：`body.js` 的相位对齐（`body.phase` 的唯一产地）与 `audio.js` 的第九声 `bell`（走既有事件通道）。

**Tech Stack:** ES Modules、零依赖、Canvas 2D、`node:test` + `assert/strict`。

**Spec:** `docs/superpowers/specs/2026-10-27-social-bond-sync-design.md`（裁定 1–6 与十条验收判据都在那里；本计划只写怎么落地）

## Global Constraints

- 只有 `src/main.js` 可以碰 `document/window/canvas/requestAnimationFrame/AudioContext/fetch/localStorage`（`tests/constraints.test.js` 守着）。
- `CONFIG` 深冻结；所有可调数一律进 `src/config.js`，源文件里不许有字面量阈值。
- 固定步长 `CONFIG.fixedDt = 1/60`；运行时零分配（每 tick 不许 `new` 对象/数组，`for...of [a,b]` 这种也算）。
- 表现层只读世界，唯一可写的是 `world.playerHand`；跑完一层之后 `JSON.stringify(world)` 必须逐字节不变。
- 阈值只许一处定义：joy 门读 `CONFIG.mood.happyJoyMin`，不在 `CONFIG.social` 里另立（裁定 1）。
- 每条测试都必须能被一个具体的 bug 翻红（不许 `> 0` 这类空判据，要钉字面量、数调用次数、比两端量级）。

---

### Task 1: CONFIG.social + 纯层 src/social.js

**Files:**
- Create: `src/social.js`
- Modify: `src/config.js`（新增 `social` 段；位置放在 `grab` 段之后、`hand` 段之前）
- Test: `tests/social.test.js`（新建）、`tests/config.test.js`（计数与段名清单）

**Interfaces:**
- Consumes: `CONFIG.mood.happyJoyMin`、`affectionFor(memory, id)`（`src/memory.js`）
- Produces:
  - `pairEligible(a, b, dist) → boolean`
  - `syncDegree(c) → number`（∈ [0,1]，无伙伴时 0）
  - `companionReady(c) → boolean`
  - `bondStep(c, partnerId, eligible, dt) → { degree: number, crossed: boolean }`（原地改 `c.bondId/bondSync/bondTotal`）

- [ ] **Step 1: 写红测（门控六条逐条可翻 + degree 是读数 + 断续攒不满）**

`tests/social.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { pairEligible, syncDegree, companionReady, bondStep } from '../src/social.js';
import { adjust, ensure } from '../src/memory.js';

const S = CONFIG.social;
const DT = CONFIG.fixedDt;

function mk(id, over = {}) {
  const c = {
    id, alive: true, sick: false, held: false,
    intent: { kind: 'socialize', targetId: over.target ?? 'other' },
    emotions: { joy: CONFIG.mood.happyJoyMin + 0.05 },
    needs: { hunger: 1 - S.fedMin - 0.05 },
    memory: { entries: [] },
    bondId: null, bondSync: 0, bondTotal: 0,
    ...over,
  };
  return c;
}

// 一对**互相**指向对方、并且互有好感的个体
function pair(aff = S.affMin + 0.05) {
  const a = mk('a', { target: 'b' });
  const b = mk('b', { target: 'a' });
  adjust(a.memory, 'b', aff, 0.5);
  adjust(b.memory, 'a', aff, 0.5);
  return [a, b];
}

test('CONFIG.social 的旋钮被字面量钉住（不是 > 0）', () => {
  assert.equal(S.pairDist, 0.09);
  assert.equal(S.fedMin, 0.6);
  assert.equal(S.affMin, 0.15);
  assert.equal(S.syncSeconds, 6);
  assert.equal(S.breakDecay, 2, '必须 > 1：断续同步攒不满，"连续"才是判据');
  assert.equal(S.totalSeconds, 90);
  assert.equal(S.totalDecay, 0.01);
  assert.equal(S.affectionRate, 0.05);
  assert.equal(S.familiarityRate, 0.06);
  assert.equal(S.arousalRate, 0.12);
  assert.equal(S.joyRate, 0.05);
  assert.ok(S.breakDecay > 1);
});

test('门控六条：逐条打破都必须变 false', () => {
  const base = () => pair();
  let [a, b] = base();
  assert.equal(pairEligible(a, b, 0.05), true, '合格的一对');

  [a, b] = base(); b.alive = false;
  assert.equal(pairEligible(a, b, 0.05), false, '死了不算');
  [a, b] = base(); b.sick = true;
  assert.equal(pairEligible(a, b, 0.05), false, 'sick 不算');
  [a, b] = base(); b.held = true;
  assert.equal(pairEligible(a, b, 0.05), false, '被玩家拎着不算');
  [a, b] = base(); b.intent = { kind: 'forage', targetId: 'a' };
  assert.equal(pairEligible(a, b, 0.05), false, '对方不在 socialize 不算');
  [a, b] = base(); b.intent = { kind: 'socialize', targetId: 'c' };
  assert.equal(pairEligible(a, b, 0.05), false, '单相思不算（对方目标是别人）');
  [a, b] = base();
  assert.equal(pairEligible(a, b, S.pairDist + 1e-9), false, '超出 pairDist 不算');
  [a, b] = base(); b.needs.hunger = 1 - S.fedMin + 0.05;
  assert.equal(pairEligible(a, b, 0.05), false, '对方没吃饱不算');
  [a, b] = base(); b.emotions.joy = CONFIG.mood.happyJoyMin - 0.05;
  assert.equal(pairEligible(a, b, 0.05), false, '对方不开心不算（读 CONFIG.mood 那个数）');
  [a, b] = base(); adjust(b.memory, 'a', -(S.affMin + 0.2), 0.5);
  assert.equal(pairEligible(a, b, 0.05), false, '对方好感掉到门下不算');
});

test('joy 门读的是 CONFIG.mood.happyJoyMin，不是 social 里另立的一个数', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(S, 'joyMin'), false,
    'social 段里不许有 joyMin：阈值只许一处定义');
  const [a, b] = pair();
  b.emotions.joy = CONFIG.mood.happyJoyMin;      // 恰好压在阈值上（>= 判定）
  assert.equal(pairEligible(a, b, 0.05), true);
});

test('syncDegree 是连续读数：半程 ≈ 0.5，封顶 1，无伙伴恒 0', () => {
  const [a] = pair();
  assert.equal(syncDegree(a), 0, '没有伙伴时是 0，不是 NaN 也不是 1');
  for (let i = 0; i < Math.round(S.syncSeconds / 2 / DT); i++) bondStep(a, 'b', true, DT);
  assert.ok(Math.abs(syncDegree(a) - 0.5) < 0.02, `半程读到 ${syncDegree(a)}`);
  for (let i = 0; i < Math.round(S.syncSeconds / DT); i++) bondStep(a, 'b', true, DT);
  assert.equal(syncDegree(a), 1, '封顶在 1，不许溢出');
});

test('中断按 breakDecay 退，断续同步攒不满（"连续"是判据）', () => {
  const [a] = pair();
  const steps = Math.round(3 / DT);
  for (let i = 0; i < steps; i++) bondStep(a, 'b', true, DT);   // 同步 3 秒
  const half = syncDegree(a);
  for (let i = 0; i < steps; i++) bondStep(a, 'b', false, DT);  // 分开 3 秒
  assert.ok(syncDegree(a) < half - 0.3, `退得不够：${syncDegree(a)} vs ${half}`);
  assert.equal(a.bondId, null, '退到 0 之后伙伴要清掉');

  const [, b2] = pair();
  b2.id = 'a2';
  const c = mk('c2', { target: 'a2' });
  for (let round = 0; round < 12; round++) {                    // 3 秒同步 / 3 秒分开 × 12
    for (let i = 0; i < steps; i++) bondStep(c, 'a2', true, DT);
    for (let i = 0; i < steps; i++) bondStep(c, 'a2', false, DT);
  }
  assert.ok(syncDegree(c) < 1, `断续也攒满的话，"连续"这条判据就是空的：${syncDegree(c)}`);
});

test('crossed 只在跨到 1 的那一 tick 为 true（上升沿，不是"在阈上"）', () => {
  const [a] = pair();
  let fires = 0;
  for (let i = 0; i < Math.round(30 / DT); i++) {               // 连续同步 30 秒
    if (bondStep(a, 'b', true, DT).crossed) fires += 1;
  }
  assert.equal(fires, 1, `30 秒里响了 ${fires} 次，应该恰好一次`);
  for (let i = 0; i < Math.round(S.syncSeconds / DT); i++) bondStep(a, 'b', false, DT);
  for (let i = 0; i < Math.round(30 / DT); i++) {               // 再来一轮
    if (bondStep(a, 'b', true, DT).crossed) fires += 1;
  }
  assert.equal(fires, 2, '掉下去再同步满，才算新的一次');
});

test('换伙伴把长期计数结清：bondTotal 是"与这一只"的累计', () => {
  const [a] = pair();
  for (let i = 0; i < Math.round(10 / DT); i++) bondStep(a, 'b', true, DT);
  assert.ok(a.bondTotal > 9 && a.bondTotal < 11, `bondTotal = ${a.bondTotal}`);
  bondStep(a, 'z', true, DT);
  assert.equal(a.bondId, 'z');
  assert.ok(a.bondTotal < 0.1, `换了伙伴还留着旧账：${a.bondTotal}`);
});

test('companionReady 只在长期计数到 totalSeconds 之后为 true', () => {
  const [a] = pair();
  for (let i = 0; i < Math.round((S.totalSeconds - 1) / DT); i++) bondStep(a, 'b', true, DT);
  assert.equal(companionReady(a), false, '差一秒还不算');
  for (let i = 0; i < Math.round(2 / DT); i++) bondStep(a, 'b', true, DT);
  assert.equal(companionReady(a), true);
});

test('bondStep 不分配对象：返回的形状固定，且反复调用不新增键', () => {
  const [a] = pair();
  const before = Object.keys(a).sort().join(',');
  const r = bondStep(a, 'b', true, DT);
  assert.deepEqual(Object.keys(r).sort(), ['crossed', 'degree']);
  for (let i = 0; i < 600; i++) bondStep(a, 'b', true, DT);
  assert.equal(Object.keys(a).sort().join(','), before, '个体身上不许长出新键');
});
```

`tests/config.test.js` 里改三处（节点数、顶层键数、段名清单）：

```js
  // ⚠️ 66 → 67、55 → 56（2026-10-27 伙伴同步）：新增 **CONFIG.social 一段**（一个节点、11 个标量）。
  // 与 CONFIG.grab 同型：这些旋钮之间没有"逐键比对"的结构关系，所以不需要子表。
  assert.equal(visited.length, 67, `CONFIG 的对象/数组节点数变了（现 ${visited.length}）`);
  // 段名清单里加 'social'
  assert.equal(Object.keys(CONFIG).length, 56);
```

- [ ] **Step 2: 跑测试确认全红**

Run: `node --test tests/social.test.js tests/config.test.js`
Expected: FAIL —— `Cannot find module '../src/social.js'`，以及 config 的两条计数红（现 66 / 55）。

- [ ] **Step 3: 写 CONFIG.social 与 src/social.js**

`src/config.js`（`grab` 段之后）：

```js
  // ---- 社交同步（spec §4.12 第 6 条：socialize 的"高级表现"）----
  // 设计与六条裁定见 docs/superpowers/specs/2026-10-27-social-bond-sync-design.md。
  // ⚠️ 这一段里**没有** joyMin：高 joy 那道门读 CONFIG.mood.happyJoyMin ——
  //    "它开心"在整份代码里只许有一个定义点（与 body.js 读 begEscalate 同一条纪律）。
  social: {
    pairDist: 0.09,        // 互相 socialize 且距离在此之内才算"凑在一起"（停距 0.06 + 余量）
    fedMin: 0.6,           // 双方的 (1 − hunger) 下限：§4.12 第 6 条原文"两只吃饱"
    affMin: 0.15,          // 双方**互相**的好感下限（memory.affection ∈ [−1,1]）
    syncSeconds: 6,        // 连续同步这么久 → degree 到 1（响铃、算"同步上了"）
    breakDecay: 2,         // 中断后 episode 进度每秒退几秒；**必须 > 1**，否则断续也能攒满
    totalSeconds: 90,      // 与同一只**累计**同步这么久 → 互相升级 companion（"长期凑在一起"）
    totalDecay: 0.01,      // 分开时长期计数的指数衰减（半衰 ≈ 69 秒）
    affectionRate: 0.05,   // 同步期间每秒给双方的好感 × degree（§4.8：同步脉动 → affection+）
    familiarityRate: 0.06, // 同期熟悉度（与 CONFIG.grab.familiarityRate 同量级）
    arousalRate: 0.12,     // 社交高峰：arousal 已经接进脉率/亮度/膨胀，这条是"看得见"的出口
    joyRate: 0.05,
  },
```

`src/social.js`：

```js
// 社交同步的纯层：谁能同步、同步到什么程度、计时怎么推进。
// 设计见 docs/superpowers/specs/2026-10-27-social-bond-sync-design.md。
//
// 本模块**只碰三个字段**（c.bondId / c.bondSync / c.bondTotal），都是瞬时态、不入档
// （save.js 的 CREATURE_SKIP_FIELDS）。关系事实住在 memory 里，不在这里。
//
// 为什么单独一个模块而不是塞进 sim.js：门控有六个条件，而"哪一条挡住了"是调参时
// 唯一想知道的事。塞进 O(n²) 的成对循环里，就没法在 Node 里单独断言任何一条。
import { CONFIG } from './config.js';
import { affectionFor } from './memory.js';

const S = CONFIG.social;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v) => (Number.isFinite(v) ? v : 0);

// 单只这一侧的四条：活着、没病、没被拎着、正在社交，且**吃饱 + 开心**。
// joy 门读 CONFIG.mood.happyJoyMin —— 见文件头那条纪律。
function readySelf(c) {
  if (!c || c.alive !== true || c.sick || c.held) return false;
  if (!c.intent || c.intent.kind !== 'socialize') return false;
  if (num(c.emotions && c.emotions.joy) < CONFIG.mood.happyJoyMin) return false;
  return (1 - num(c.needs && c.needs.hunger)) >= S.fedMin;
}

// 唯一的门控点：六个条件全成立才算"凑在一起"。
// 第三条（互相是对方的目标）不是恒真 —— behavior.decide 给 socialize 挂的是 neighbors[0]，
// 两只最近的个体常常正好互指，但"它追着它、它追着第三只"同样常见。
export function pairEligible(a, b, dist) {
  if (!a || !b || a.id === b.id) return false;
  if (!readySelf(a) || !readySelf(b)) return false;
  if (a.intent.targetId !== b.id || b.intent.targetId !== a.id) return false;
  if (!(num(dist) <= S.pairDist)) return false;
  return affectionFor(a.memory, b.id) >= S.affMin
      && affectionFor(b.memory, a.id) >= S.affMin;
}

// 同步度读数（spec §5.4.1 第 2 条要的那个"内核里的同步度"）。∈ [0,1]，无伙伴恒 0。
export function syncDegree(c) {
  if (!c || c.bondId === null || c.bondId === undefined) return 0;
  return clamp01(num(c.bondSync) / S.syncSeconds);
}

// "长期凑在一起"到了没有。用累计秒数而不是熟悉度阈值 —— 清单 §17.3 明写
// **不能用熟悉度阈值临时发明社交关系**，所以这里的判据是"真的一起同步了多久"。
export function companionReady(c) {
  return !!c && c.bondId !== null && c.bondId !== undefined
    && num(c.bondTotal) >= S.totalSeconds;
}

// 推进一只的同步计时。**原地改**，不分配（返回值那两个键是固定的）。
// crossed 是上升沿：prev < 1 且现在 >= 1 —— 与 audio.js 的 crossedUp 同一个理由，
// "在阈上"会每 tick 都成立，那记铃就成了持续音。
export function bondStep(c, partnerId, eligible, dt) {
  const prev = syncDegree(c);
  if (eligible) {
    if (c.bondId !== partnerId) { c.bondId = partnerId; c.bondSync = 0; c.bondTotal = 0; }
    // 封顶在 syncSeconds：不封顶的话跑一夜之后 bondSync 是四位数，
    // 而 degree 早就是 1 —— 白占精度，还让"退到 0"要退几个小时。
    c.bondSync = Math.min(S.syncSeconds, num(c.bondSync) + dt);
    c.bondTotal = num(c.bondTotal) + dt;
  } else {
    c.bondSync = Math.max(0, num(c.bondSync) - S.breakDecay * dt);
    if (c.bondSync === 0) c.bondId = null;
    c.bondTotal = num(c.bondTotal) * Math.exp(-S.totalDecay * dt);
  }
  const degree = syncDegree(c);
  return { degree, crossed: prev < 1 && degree >= 1 };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test tests/social.test.js tests/config.test.js`
Expected: PASS（config 的段名清单若还红，把 `'social'` 加进那份清单）。

- [ ] **Step 5: 提交**

```bash
git add src/social.js src/config.js tests/social.test.js tests/config.test.js
git commit -m "feat: 社交同步的纯层与 CONFIG.social（门控六条 + 同步度读数）"
```

---

### Task 2: memory.js 的 companion 升级规则

**Files:**
- Modify: `src/memory.js`（`adjust`/`affectionFor` 附近）
- Test: `tests/memory.test.js`

**Interfaces:**
- Consumes: `ensure(memory, id)`、`get(memory, id)`（同文件）
- Produces:
  - `companionOf(memory) → entry | null`
  - `promoteCompanion(memory, id) → boolean`（只在 role 为 null 时写 `'companion'`）
  - `demoteCompanion(memory, id) → boolean`（只把 `'companion'` 改回 `null`）

- [ ] **Step 1: 写红测**

```js
test('promoteCompanion 只升级 role 为 null 的那条，绝不覆盖血缘', () => {
  const m = createMemory();
  adjust(m, 'x', 0.4, 0.6);
  assert.equal(promoteCompanion(m, 'x'), true);
  assert.equal(get(m, 'x').role, 'companion');
  assert.equal(promoteCompanion(m, 'x'), false, '重复升级返回 false，且不改任何东西');

  ensure(m, 'MOM', { kinship: KINSHIP.mother, role: 'mother' });
  assert.equal(promoteCompanion(m, 'MOM'), false, '妈妈不能被改写成伙伴');
  assert.equal(get(m, 'MOM').role, 'mother');
});

test('companionOf 找到那唯一一条；没有时是 null（不是 undefined）', () => {
  const m = createMemory();
  assert.equal(companionOf(m), null);
  promoteCompanion(m, 'x');
  adjust(m, 'y', 0.2, 0.3);
  assert.equal(companionOf(m).id, 'x');
});

test('demoteCompanion 只 demote 伙伴，血缘与陌生条目都不动', () => {
  const m = createMemory();
  ensure(m, 'MOM', { kinship: KINSHIP.mother, role: 'mother' });
  adjust(m, 'y', 0.2, 0.3);
  assert.equal(demoteCompanion(m, 'MOM'), false);
  assert.equal(get(m, 'MOM').role, 'mother');
  assert.equal(demoteCompanion(m, 'y'), false);
  assert.equal(demoteCompanion(m, 'nobody'), false, '不存在的条目不许被顺手建出来');
  assert.equal(get(m, 'nobody'), null);
  promoteCompanion(m, 'x');
  assert.equal(demoteCompanion(m, 'x'), true);
  assert.equal(get(m, 'x').role, null);
});

test('companion 走慢衰减：升级之后好感按 affectionDecayKin 淡（spec §4.8"近乎不忘"）', () => {
  const m = createMemory();
  adjust(m, 'x', 0.8, 0.9);
  promoteCompanion(m, 'x');
  const dt = 10;
  decay(m, dt);
  const kin = 0.8 * Math.exp(-CONFIG.affectionDecayKin * dt);
  const normal = 0.8 * Math.exp(-CONFIG.affectionDecay * dt);
  assert.ok(Math.abs(get(m, 'x').affection - kin) < 1e-9,
    `伙伴应当走慢衰减 ${kin}，实到 ${get(m, 'x').affection}（普通速率是 ${normal}）`);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/memory.test.js`
Expected: FAIL —— `promoteCompanion is not a function`（或未导入）。

- [ ] **Step 3: 实现三个函数**

`src/memory.js`：

```js
// ---- companion（spec §4.8：长期凑在一起、会自发同步脉动的那只）----
// 三个函数各只管一件事，规则合起来是设计文档的裁定 3：
//   · 至多一个伙伴；· 血缘优先，永不覆盖；· 占位者活着不换人；· 占位者已死才可以换。
// 后两条要读世界（谁还活着），所以**判在 sim.js**，这里只提供两个原子操作。
export function companionOf(memory) {
  for (const e of memory.entries) if (e.role === 'companion') return e;
  return null;
}

// 幂等且**不覆盖**：与 ensure 不覆盖已有 kinship/role 同一条纪律 ——
// "它是它妈妈"这条事实不该被社交改写成"它是它伙伴"。
export function promoteCompanion(memory, id) {
  const e = ensure(memory, id);
  if (e.role !== null) return false;
  e.role = 'companion';
  return true;
}

// 只 demote 伙伴。条目不存在时返回 false 且**不新建**：
// 顺手 ensure 会让"查一下"变成"记一笔"，那是记忆层最不该有的副作用。
export function demoteCompanion(memory, id) {
  const e = get(memory, id);
  if (!e || e.role !== 'companion') return false;
  e.role = null;
  return true;
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test tests/memory.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/memory.js tests/memory.test.js
git commit -m "feat: memory 的 companion 升级三件套（不覆盖血缘、不误建条目）"
```

---

### Task 3: creature 的三个瞬时字段 + 存档跳过

**Files:**
- Modify: `src/creature.js`（`broodT` 附近）
- Modify: `src/save.js:205-209`（`CREATURE_SKIP_FIELDS`）
- Test: `tests/creature.test.js`、`tests/save.test.js`

**Interfaces:**
- Produces: 每只新建个体带 `bondId: null, bondSync: 0, bondTotal: 0`

- [ ] **Step 1: 写红测**

`tests/creature.test.js`：

```js
test('新个体带三个社交同步字段，且两只不共享（与 needs/memory 同一条理由）', () => {
  const a = createCreature({ id: 'a', genes: randomGenome(rng) });
  const b = createCreature({ id: 'b', genes: randomGenome(rng) });
  assert.equal(a.bondId, null);
  assert.equal(a.bondSync, 0);
  assert.equal(a.bondTotal, 0);
  a.bondSync = 3;
  assert.equal(b.bondSync, 0, '写到一只身上不许出现在另一只上');
});
```

`tests/save.test.js`：

```js
test('bondId / bondSync / bondTotal 不入档（瞬时进度），但 companion 这条记忆照常入档', () => {
  const w = createWorld({ seed: 7, now: () => 0 });
  const c = w.creatures[0];
  const other = w.creatures[1];
  c.bondId = other.id; c.bondSync = 4; c.bondTotal = 80;
  promoteCompanion(c.memory, other.id);
  const doc = serialize(w);
  const raw = JSON.parse(JSON.stringify(doc));
  for (const k of ['bondId', 'bondSync', 'bondTotal']) {
    assert.equal(Object.prototype.hasOwnProperty.call(raw.creatures[0], k), false,
      `${k} 是"此刻在跟谁同步"的进度，不是关系事实，不该进档`);
  }
  const back = migrate(raw);
  const entry = back.creatures[0].memory.entries.find((e) => e.id === other.id);
  assert.equal(entry.role, 'companion', '读回来它们仍然是伙伴');
  assert.equal(back.creatures[0].bondSync, 0, '进度从 0 起：要重新同步才会再响铃');
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/creature.test.js tests/save.test.js`
Expected: FAIL —— `a.bondId` 是 `undefined`；存档里三个键都在。

- [ ] **Step 3: 实现**

`src/creature.js`（`broodT: 0,` 之后）：

```js
    // ---- 社交同步（spec §4.12 第 6 条；设计见 2026-10-27-social-bond-sync-design.md）----
    // 三个都是**瞬时进度**，不入档（save.js 的 CREATURE_SKIP_FIELDS）：
    // 关系事实住在 memory 里（role:'companion' + 好感/熟悉度），那一份照常存。
    bondId: null,      // 此刻在跟谁同步；bondSync 退到 0 时清掉
    bondSync: 0,       // 本次连续同步的秒数（episode 进度，封顶 CONFIG.social.syncSeconds）
    bondTotal: 0,      // 与 bondId **累计**同步的秒数 —— "长期凑在一起"的那个长期
```

`src/save.js`（`CREATURE_SKIP_FIELDS` 加一行，并在上面的注释里补一条理由）：

```js
// · bondId / bondSync / bondTotal —— 社交同步的**此刻进度**（与谁、同步了几秒）。
//   关系本身在 memory 里（role:'companion'），那一份照常入档；进度存下来的症状是
//   "读档第一帧就响铃"，而那一记铃应当是它们**这一次**聊得来的结果。
export const CREATURE_SKIP_FIELDS = Object.freeze([
  'traits', 'thresholds', 'speech',
  'intent', 'intentTime', 'moving', 'resting',
  'beingPetted', 'beingPoked', 'held',
  'bondId', 'bondSync', 'bondTotal',
]);
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test tests/creature.test.js tests/save.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/creature.js src/save.js tests/creature.test.js tests/save.test.js
git commit -m "feat: 个体带三个同步计时字段，且明确不入档"
```

---

### Task 4: sim.js 的 tickSocial（内核接线）

**Files:**
- Modify: `src/sim.js`（import；`resolve` 之前新增 `tickSocial`；`tickWorld` 里插一行）
- Test: `tests/sim.test.js`、`tests/family.test.js` 或 `tests/hud.test.js`（同源判据）

**Interfaces:**
- Consumes: `pairEligible / syncDegree / companionReady / bondStep`（`src/social.js`）、`companionOf / promoteCompanion / demoteCompanion / adjustMemory`（`src/memory.js`）
- Produces: `world.events` 里新的一种 `{ kind: 'synced', id, withId }`；`memory` 里的 `role:'companion'`

- [ ] **Step 1: 写红测**

`tests/sim.test.js`：

```js
// 造一对"已经在互相 socialize、吃饱、开心、互有好感"的个体，位置贴在一起。
function bondingPair(world) {
  const [a, b] = aliveCreatures(world);
  a.pos.x = 0.4; a.pos.y = 0.5; b.pos.x = 0.44; b.pos.y = 0.5;
  for (const [c, o] of [[a, b], [b, a]]) {
    c.intent = { kind: 'socialize', targetId: o.id, targetPos: { x: o.pos.x, y: o.pos.y },
                 minDuration: 60 };
    c.intentTime = 0;
    c.needs.hunger = 0;
    c.emotions.joy = 0.8;
    adjustMemory(c.memory, o.id, 0.5, 0.5);
  }
  return [a, b];
}

test('同步期间互买好感与熟悉度，且**不动对玩家的那一条**', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  adjustMemory(a.memory, PLAYER_ID, 0.4, 0.7);
  adjustMemory(b.memory, PLAYER_ID, 0.4, 0.7);
  const before = JSON.stringify([a.memory.entries.find((e) => e.id === PLAYER_ID),
    b.memory.entries.find((e) => e.id === PLAYER_ID)]);
  for (let i = 0; i < 600; i++) tickWorld(world, CONFIG.fixedDt);
  assert.ok(affectionFor(a.memory, b.id) > 0.5 + 0.1,
    `十秒同步之后好感只到 ${affectionFor(a.memory, b.id)}`);
  assert.ok(familiarityFor(a.memory, b.id) > 0.5, '熟悉度也要涨');
  assert.equal(JSON.stringify([a.memory.entries.find((e) => e.id === PLAYER_ID),
    b.memory.entries.find((e) => e.id === PLAYER_ID)]), before,
    '社交只许写"对彼此"的那一条：把玩家那条一起加是最容易犯的错');
});

test('同步把 arousal 与 joy 推上去（§4.5 的"社交高峰"要有生产者）', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a] = bondingPair(world);
  a.emotions.arousal = 0;
  for (let i = 0; i < 300; i++) tickWorld(world, CONFIG.fixedDt);
  assert.ok(a.emotions.arousal > 0.2, `arousal 只到 ${a.emotions.arousal}`);
});

test('synced 事件是上升沿：一次 episode 恰好一条，且带 withId', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  const seen = [];
  for (let i = 0; i < Math.round(40 / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const ev of world.events) if (ev.kind === 'synced') seen.push(ev);
    world.events.length = 0;
  }
  assert.equal(seen.length, 1, `40 秒里响了 ${seen.length} 记，应该恰好一记`);
  const ids = [seen[0].id, seen[0].withId].sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test('不同步就没有 synced：把任一条门控打破，事件数必须是 0', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  b.needs.hunger = 1;                       // 对方饿了
  let n = 0;
  for (let i = 0; i < Math.round(40 / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    n += world.events.filter((e) => e.kind === 'synced').length;
    world.events.length = 0;
  }
  assert.equal(n, 0);
});

test('长期同步之后**双方**都记下 companion，家谱虚线与信息卡同伴行同源出现', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  for (let i = 0; i < Math.round((CONFIG.social.totalSeconds + 5) / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(companionOf(a.memory)?.id, b.id, '升级必须是双方的，只升一边家谱画不出边');
  assert.equal(companionOf(b.memory)?.id, a.id);
  const model = familyTree(world);
  assert.equal(model.edges.filter((e) => e.kind === 'companion').length, 1,
    '家谱的伙伴虚线：这一轮之前恒为 0（清单 §17.3）');
  const rows = relationRowsFor(a, world);
  assert.ok(rows.some((r) => r.label === '同伴' && String(r.value).includes(b.name ?? b.id)),
    `信息卡的同伴行：${JSON.stringify(rows)}`);
});

test('伙伴还活着时不换人；伙伴死了之后可以结新伙（裁定 3）', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  for (let i = 0; i < Math.round((CONFIG.social.totalSeconds + 5) / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(companionOf(a.memory).id, b.id);

  // 换一只来同步：b 还活着 ⇒ 不许换人
  const c = world.creatures.find((x) => x.id !== a.id && x.id !== b.id);
  b.intent = { kind: 'rest', minDuration: 600 };
  bondFrom(a, c);                            // 把 a 与 c 摆成互相 socialize 的合格对
  for (let i = 0; i < Math.round((CONFIG.social.totalSeconds + 5) / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(companionOf(a.memory).id, b.id, 'b 还活着，伙伴不该被换掉');

  // 现在让 b 死掉：a 才可以与 c 结伙
  b.alive = false; b.dying = CONFIG.dissolveDuration;
  for (let i = 0; i < Math.round((CONFIG.social.totalSeconds + 20) / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(companionOf(a.memory).id, c.id, '守着尸体的星星不是我们要的');
});

test('血缘优先：已经是 mother 的那条不会被社交改写成 companion', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a, b] = bondingPair(world);
  ensure(a.memory, b.id, { kinship: KINSHIP.mother, role: 'mother' });
  for (let i = 0; i < Math.round((CONFIG.social.totalSeconds + 5) / CONFIG.fixedDt); i++) {
    tickWorld(world, CONFIG.fixedDt);
    world.events.length = 0;
  }
  assert.equal(get(a.memory, b.id).role, 'mother');
});

test('tickSocial 不给个体长新键、也不在世界对象上挂新容器（零分配那一侧的形状判据）', () => {
  const world = createWorld({ seed: 3, now: () => 0 });
  const [a] = bondingPair(world);
  const keys = Object.keys(a).sort().join(',');
  const wKeys = Object.keys(world).sort().join(',');
  for (let i = 0; i < 600; i++) tickWorld(world, CONFIG.fixedDt);
  assert.equal(Object.keys(a).sort().join(','), keys);
  assert.equal(Object.keys(world).sort().join(','), wKeys);
});
```

> `bondFrom(a, c)` 是测试文件里的一个小工具，把 `bondingPair` 那套摆放动作对任意两只重复一次
> （位置贴近、互相 socialize、吃饱、开心、互有好感）。写成 helper 而不是复制粘贴，
> 因为"合格对"的六个条件在同一个文件里出现三次，漂移一次就会出现"这条测试测的是别的门"。

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/sim.test.js`
Expected: FAIL —— 好感没涨、`synced` 事件 0 条、companion 恒 null、家谱虚线 0 条。

- [ ] **Step 3: 实现 tickSocial**

`src/sim.js`（import 段加 `pairEligible, syncDegree, companionReady, bondStep` 与
`companionOf, promoteCompanion, demoteCompanion`；`resolve` 之前新增）：

```js
// ---------------------------------------------------------------- 社交同步

// spec §4.12 第 6 条的"socialize 高级表现"：两只吃饱、互相有好感、都开心的个体
// 会自发同步脉动；同步成功响一记小铃（audio.js 的 synced → bell），
// 长期凑在一起的互相成为 companion（家谱虚线与信息卡"同伴"行的生产者）。
// 设计与六条裁定见 docs/superpowers/specs/2026-10-27-social-bond-sync-design.md。
//
// **逐只**遍历而不是成对遍历，两个理由：
//   1. 没在跟任何人同步的那些也要衰减 —— 成对循环只走"凑上对的"，
//      漏掉的那一半会永远停在旧进度上（degree 卡在 1，铃随时可能再响一次）。
//   2. 每只只写**自己**这一侧（自己的 memory、自己的情绪），所以两只各跑一次
//      正好是完整的一笔，不需要"谁先谁后"或"别加两遍"这种约定。
// 事件去重靠 `a.id < b.id`：crossed 在两只身上可能不在同一 tick（各自的历史进度不同），
// 但两侧各判一次的话，只有 id 较小的那一侧会放行 ⇒ 一次 episode 恰好一条。
function tickSocial(world, dt) {
  const alive = aliveCreatures(world);
  for (let i = 0; i < alive.length; i++) {
    const a = alive[i];
    const wantId = a.intent && a.intent.kind === 'socialize' ? a.intent.targetId : null;
    let b = null;
    if (wantId) {
      for (let j = 0; j < alive.length; j++) if (alive[j].id === wantId) { b = alive[j]; break; }
    }
    const ok = b !== null && pairEligible(a, b, Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y));
    const r = bondStep(a, ok ? b.id : null, ok, dt);
    if (!ok) continue;

    const deg = r.degree;
    if (deg > 0) {
      // §4.8：同步脉动 → affection+。熟悉度同期上升（它们在互相认识）。
      adjustMemory(a.memory, b.id, CONFIG.social.affectionRate * deg * dt,
        CONFIG.social.familiarityRate * dt);
      // §4.5 的 arousal 一行原文就是"社交高峰：与对方脉动同步、膨胀展示、全场最亮"，
      // 而 body.js 已经把 arousal 接进脉率/幅度/膨胀 ⇒ 这三样是这条注入的现成读数。
      a.emotions.arousal = clamp01(a.emotions.arousal + CONFIG.social.arousalRate * deg * dt);
      a.emotions.joy = clamp01(a.emotions.joy + CONFIG.social.joyRate * deg * dt);
    }
    if (r.crossed && a.id < b.id) {
      world.events.push({ kind: 'synced', id: a.id, withId: b.id });
    }
    if (companionReady(a)) promoteIfNeeded(world, a, b.id);
  }
}

// 裁定 3 的后两条要读世界（占位者还活着吗），所以判在这里，不在 memory.js。
function promoteIfNeeded(world, c, partnerId) {
  const cur = companionOf(c.memory);
  if (cur && cur.id !== partnerId) {
    let alive = false;
    for (const x of world.creatures) if (x.id === cur.id && x.alive) { alive = true; break; }
    if (alive) return;                       // 占位者还在 ⇒ 不换人（家谱虚线不该跳）
    demoteCompanion(c.memory, cur.id);
  }
  promoteCompanion(c.memory, partnerId);
}
```

`tickWorld` 里插一行（在生物循环之后、`resolve` 之前）：

```js
  maybeDrift(world);
  tickEggs(world, dt);
  tickSocial(world, dt);      // 读的是本 tick 决策完的意图与位置；碰撞推开在它之后
  resolve(world, dt);
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test tests/sim.test.js tests/family.test.js tests/hud.test.js`
Expected: PASS。若 `relationRowsFor` 未从 `hud.js` 导出，把它加进导出清单（它已经是纯函数）。

- [ ] **Step 5: 提交**

```bash
git add src/sim.js src/hud.js tests/sim.test.js
git commit -m "feat: tickSocial —— 同步脉动的内核生产者、synced 事件与 companion 升级"
```

---

### Task 5: body.js 的相位对齐

**Files:**
- Modify: `src/body.js`（`updateBodies` 之后加 `syncPhases`；`updateBodies` 末尾调它）
- Modify: `src/config.js`（`body` 段加 `syncPhaseLerp`）
- Test: `tests/body.test.js`、`tests/config.test.js`（body 段的旋钮清单若有计数）

**Interfaces:**
- Consumes: `syncDegree(c)`（`src/social.js`）、`c.bondId`
- Produces: `syncPhases(bodies, world, dt) → void`（原地改 `body.phase`）

- [ ] **Step 1: 写红测**

```js
test('同步的两只相位收敛，且**两只都动过**（不是一只追着另一只）', () => {
  const world = { creatures: [] };
  const bodies = new Map();
  const [a, b] = [mkC('a'), mkC('b')];
  a.bondId = 'b'; a.bondSync = CONFIG.social.syncSeconds;
  b.bondId = 'a'; b.bondSync = CONFIG.social.syncSeconds;
  world.creatures.push(a, b);
  bodies.set('a', createBody(a.traits));
  bodies.set('b', createBody(b.traits));
  bodies.get('a').phase = 0.10;
  bodies.get('b').phase = 0.60;
  const gap = () => Math.abs(((bodies.get('b').phase - bodies.get('a').phase + 0.5) % 1) - 0.5);
  for (let i = 0; i < Math.round(3 / DT); i++) syncPhases(bodies, world, DT);
  assert.ok(gap() < 1e-3, `3 秒后相位差还有 ${gap()}`);
  assert.ok(Math.abs(bodies.get('a').phase - 0.10) > 0.05, 'a 必须真的动过');
  assert.ok(Math.abs(bodies.get('b').phase - 0.60) > 0.05, 'b 也必须真的动过');
});

test('degree 为 0 的一对相位不受影响；phase 恒在 [0,1)', () => {
  const world = { creatures: [] };
  const bodies = new Map();
  const [a, b] = [mkC('a'), mkC('b')];
  a.bondId = 'b'; a.bondSync = 0;            // 有伙伴但一点没同步上
  b.bondId = 'a'; b.bondSync = 0;
  world.creatures.push(a, b);
  bodies.set('a', createBody(a.traits));
  bodies.set('b', createBody(b.traits));
  bodies.get('a').phase = 0.10;
  bodies.get('b').phase = 0.60;
  for (let i = 0; i < Math.round(3 / DT); i++) syncPhases(bodies, world, DT);
  assert.equal(bodies.get('a').phase, 0.10);
  assert.equal(bodies.get('b').phase, 0.60);

  a.bondSync = CONFIG.social.syncSeconds; b.bondSync = CONFIG.social.syncSeconds;
  for (let i = 0; i < Math.round(60 / DT); i++) {
    bodies.get('a').phase = 0.99; bodies.get('b').phase = 0.01;   // 反复跨 0 那一点
    syncPhases(bodies, world, DT);
    for (const id of ['a', 'b']) {
      const p = bodies.get(id).phase;
      assert.ok(p >= 0 && p < 1, `phase 跑出 [0,1)：${p}`);
      assert.ok(Number.isFinite(p), 'phase 变成 NaN 了');
    }
  }
});

test('updateBodies 每子步都会对齐一次（接线判据，防"函数写了没人调"）', () => {
  const world = { creatures: [], playerHand: null };
  const bodies = new Map();
  const [a, b] = [mkC('a'), mkC('b')];
  a.bondId = 'b'; a.bondSync = CONFIG.social.syncSeconds;
  b.bondId = 'a'; b.bondSync = CONFIG.social.syncSeconds;
  world.creatures.push(a, b);
  for (let i = 0; i < Math.round(3 / DT); i++) updateBodies(bodies, world, DT);
  const pa = bodies.get('a').phase;
  const pb = bodies.get('b').phase;
  assert.ok(Math.abs(((pb - pa + 0.5) % 1) - 0.5) < 0.02,
    `updateBodies 之后两只仍然不同步：${pa} vs ${pb}`);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/body.test.js`
Expected: FAIL —— `syncPhases` 未导出；第三条（接线）也红。

- [ ] **Step 3: 实现**

`src/config.js` 的 `body` 段加一个标量（**不新增节点**，计数不动）：

```js
    syncPhaseLerp: 1.6,          // 同步时把两只的脉动相位往一起拉的速率（× degree × dt）
```

`src/body.js`：

```js
// 同步脉动的**相位对齐**（spec §4.12 第 6 条那套编舞里"脉动同步"这一步）。
//
// ⚠️ 为什么在 body.js 而不是 render.js：body.phase 是相位的**唯一产地**，
// 而 render 的 breatheOf / 光晕都只读它。在 render 里另算一份同步相位就是第二个时钟 ——
// 那正是 tests/render-body.test.js 里"breatheOf 绝不自建时钟（求偶与呼吸同步的教训）"
// 这条测试专门防的事。
//
// 走**最短弧**：phase 是 mod 1 的圈量，0.99 与 0.01 差 0.02 而不是 0.98。
// 两只各拉一次 ⇒ 收敛到中点，所以画面上是"它们对上拍子"，不是"一只追着另一只"。
export function syncPhases(bodies, world, dt) {
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!c.alive || !c.bondId) continue;
    const body = bodies.get(c.id);
    if (!body) continue;
    const degree = syncDegree(c);
    if (degree <= 0) continue;
    let p = null;
    for (let j = 0; j < cs.length; j++) if (cs[j].id === c.bondId) { p = cs[j]; break; }
    if (!p || !p.alive) continue;
    const pb = bodies.get(p.id);
    if (!pb) continue;
    const rate = Math.min(1, B.syncPhaseLerp * degree * dt);
    const d = ((pb.phase - body.phase + 0.5) % 1) - 0.5;
    body.phase = (body.phase + d * rate + 1) % 1;
  }
}
```

`updateBodies` 末尾加一行：

```js
    updateBody(body, c, dt, world.playerHand);
  }
  syncPhases(bodies, world, dt);
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test tests/body.test.js tests/render-body.test.js`
Expected: PASS（`render-body` 那条"不自建时钟"必须仍然绿）。

- [ ] **Step 5: 提交**

```bash
git add src/body.js src/config.js tests/body.test.js tests/config.test.js
git commit -m "feat: 同步时把两只的脉动相位拉到一起（相位的唯一产地）"
```

---

### Task 6: audio.js 的第九声 bell

**Files:**
- Modify: `src/audio.js`（`CALL_KEYS`、`EVENT_CALL`、`consume` 的全局闸门、`stats`）
- Modify: `src/config.js`（`audio` 段加 `bellGapSec` 与 `bell` 声表）
- Test: `tests/audio.test.js`、`tests/config.test.js`

**Interfaces:**
- Consumes: `{ kind: 'synced', id, withId }`（Task 4）
- Produces: `callForEvent('synced') === 'bell'`；`stats.bellDropped`

- [ ] **Step 1: 写红测**

```js
test('synced → bell：那记"柔和的两音小铃"落地（§5.4 表里最后一行空壳）', () => {
  assert.equal(callForEvent('synced'), 'bell');
  assert.ok(CALL_KEYS.includes('bell'));
  const plan = planSound('bell', referenceVoice(), 0, 1);
  const oscs = plan.parts.filter((p) => p.kind === 'osc');
  assert.equal(oscs.length, 2, '表里写的是"两音"，不是三音也不是单音');
  assert.ok(oscs[1].from > oscs[0].from, '两音要上行（原「求偶成功」那一记的形状）');
});

test('bell 的峰值是全表最低：它必须柔和，不能盖过死亡那一声', () => {
  const peaks = CALL_KEYS.map((k) => planSound(k, referenceVoice(), 0, 1).parts[0].peak);
  const bell = peaks[CALL_KEYS.indexOf('bell')];
  assert.equal(bell, Math.min(...peaks), `bell 的 peak ${bell} 不是全表最低`);
  assert.ok(bell < 0.12, 'death 是 0.12；铃要比它更轻');
});

test('bell 有全局闸门：同一批里两条 synced 只响一记，且溢出**计数**（不静默）', () => {
  const rec = new Recorder();                       // tests/audio.test.js 里现成的记录型图
  const a = createAudio({ audioContext: rec.ctx, now: () => t });
  const world = { creatures: [creatureAt('a', 26, 315), creatureAt('b', 26, 315)] };
  let t = 0;
  a.consume([{ kind: 'synced', id: 'a', withId: 'b' },
             { kind: 'synced', id: 'b', withId: 'a' }], world);
  assert.equal(a.stats.calls.bell, 1, `响了 ${a.stats.calls.bell} 记`);
  assert.equal(a.stats.bellDropped, 1, '被闸门挡下的那一记必须有计数');
});

test('关掉音频时 synced 不改世界一个字节（沿用 §5.4.1 那条纪律）', () => {
  const world = makeWorldWithSyncedPair();
  const before = JSON.stringify(world);
  const a = createAudio({ audioContext: null, now: () => 0 });
  a.consume(world.events, world);
  assert.equal(JSON.stringify(world), before);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/audio.test.js`
Expected: FAIL —— `callForEvent('synced')` 是 `null`；`planSound('bell', …)` 抛"未知叫声"。

- [ ] **Step 3: 实现**

`src/config.js` 的 `audio` 段（`chirpGapSec` 之后加闸门，声表末尾加 bell）：

```js
    bellGapSec: 0.6,             // 同步小铃的**全局**最小间隔：一缸里多对同时同步时只放行第一记
```

```js
    // 第九声（spec §5.4 表里"同步脉动（社交高峰，原「求偶成功」）"那一行）：
    // 柔和的**两音**小铃，上行五度。peak 是全表最低 —— 它要比"几乎听不见"的死亡那一声还轻，
    // 因为它是这一缸里唯一一记**纯装饰**的声音（其余各声都对应一次状态变化）。
    // pitchMix 只走 0.35：铃的基频已经高，全额乘小只的 2.6× 会跑到刺耳的区间。
    bell: { wave: 'sine', fromHz: 780, toHz: 1170, noteSec: 0.22, gapSec: 0.09, reps: 2,
            attack: 0.060, peak: 0.10, pitchMix: 0.35 },
```

`src/audio.js`：

```js
// 九种发声。前六个是 spec §5.4 表里那六行，后三个是增量：
// thud = hop 落地那记闷响，chirp = 出词前那记「啾」，bell = 同步脉动那记两音小铃
// （§5.4.1 第 2 条在 2026-10-27 之前记的"这一行没有生产者"已由 sim.js 的 tickSocial 补上）。
export const CALL_KEYS = Object.freeze([
  'joy', 'beg', 'anger', 'sleepy', 'hatch', 'death', 'thud', 'chirp', 'bell',
]);

const EVENT_CALL = Object.freeze({ say: 'chirp', hatch: 'hatch', death: 'death', synced: 'bell' });
```

`createAudio` 里（`lastThudAt` 旁边）加 `let lastBellAt = Number.NEGATIVE_INFINITY;`
与 `stats.bellDropped = 0;`，并在 `consume` 的事件循环里、`chirp` 那段闸门之后加：

```js
        if (key === 'bell') {
          // 与 thud / chirp 同型的全局闸门：多对同时同步时只放行第一记，
          // 其余**计数**而不静默（§5.4.1 第 5 条：溢出必须有数）。
          const t = now();
          if (t - lastBellAt < AUD.bellGapSec) { stats.bellDropped += 1; continue; }
          lastBellAt = t;
        }
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test tests/audio.test.js tests/config.test.js`
Expected: PASS。config 那两条计数会变（`audio` 段多一个节点）：把 67 → 68 与声表键数一并改掉，并在旁边写一行"⚠️ 67 → 68（2026-10-27 伙伴同步）：`CONFIG.audio` 多一张 `bell` 声表"。

- [ ] **Step 5: 提交**

```bash
git add src/audio.js src/config.js tests/audio.test.js tests/config.test.js
git commit -m "feat: 第九声 bell —— 同步脉动那记两音小铃（含全局闸门与溢出计数）"
```

---

### Task 7: 端到端验收 + 文档回写 + PR

**Files:**
- Modify: `tests/simulate.mjs`（统计里加 `synced` 事件数与终局 companion 对数）
- Modify: `docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md`（§4.8 / §4.12 第 6 条 / §5.4 表 / §5.4.1 第 2 条 / §8.2 那条视觉清单）
- Modify: `docs/superpowers/checklists/2026-10-22-plan2-visual-checklist.md`（新增一节 + §17.3 那条"伙伴虚线通常为空"改写）
- Modify: `.superpowers/sdd/progress.md`（gitignored 台账）

- [ ] **Step 1: 全套测试**

Run: `node --test tests/`
Expected: 全绿。记下总数（上一轮是 1185）。

- [ ] **Step 2: 60 分钟实跑两粒种子**

Run: `node tests/simulate.mjs --minutes 60 --seed 20261022` 与 `--seed 7`
Expected: 无 error 事件；记录 `synced` 总数、终局 companion 对数、家谱虚线边数。
判据（设计文档第 10 条）：**非零，且不是每 tick 都有** —— 若 `synced` 数量与 tick 数同量级，
说明门控形同虚设，回头查 `pairEligible` 是不是恒真。

- [ ] **Step 3: 探针（证明判据非空）**

逐个改一处、跑对应测试、确认**红**，然后改回：
1. `pairEligible` 里删掉"互相指向"那条 → Task 4 的"不同步就没有 synced"必须红；
2. `bondStep` 的 `breakDecay * dt` 改成 `dt / S.breakDecay` → "断续攒不满"必须红；
3. `tickSocial` 里把 `a.id < b.id` 去掉 → "一次 episode 恰好一条"必须红；
4. `promoteIfNeeded` 里去掉"占位者活着就 return" → "伙伴还活着时不换人"必须红；
5. `syncPhases` 只拉 a 不拉 b → "两只都动过"必须红；
6. `bell` 的 `peak` 改成 0.5 → "全表最低"必须红。

- [ ] **Step 4: 真页面证据（能拿就拿，拿不到就如实记）**

`pwsh server.ps1 -Port 8123 -NoBrowser` → browser-use 的 `navigate_page` + `take_screenshot`。
要看的三样：两只贴在一起时呼吸/发光是否对上拍子、家谱里的伙伴虚线、信息卡的"同伴"行。
若分类器拦下 localhost 导航，**在清单里明写"本轮没有真页面证据"与被拦的原文**，
不许把"测试全绿"写成"页面验过"。

- [ ] **Step 5: 文档回写**

- 主 spec §5.4.1 第 2 条：把"同步脉动这一行是空壳"改成"已由 `sim.js` 的 `tickSocial` +
  `audio.js` 的 `bell` 落地（2026-10-27）"，并保留原来那段"为什么当时做不到"作为历史。
- 主 spec §5.4 表那一行去掉"**计划 2 不出声**"。
- 主 spec §4.12 第 6 条与 §4.8：把"改挂在 socialize 的高级表现上（记账）"改成已落地，
  并指向本设计文档。
- 清单 §17.3 的"伙伴虚线通常为空"改成"有生产者了（2026-10-27）"，并写出实跑到的边数。
- `progress.md` 追加本轮条目（含探针清单与实跑数字）。

- [ ] **Step 6: 提交、开 PR、合并**

```bash
git checkout -b feat/social-bond-sync        # 若尚未在分支上
git add -A && git commit -m "docs: 伙伴同步的验收记录与 spec 回写"
gh pr create --repo ajsjsjjbshshsj/electronic-creature-tank --title "feat: 伙伴关系 + 同步脉动 + 小铃音" --body "…"
gh pr merge --repo ajsjsjjbshshsj/electronic-creature-tank --merge   # 与前几轮一致：merge commit，不 squash
git checkout main && git pull --ff-only
node --test tests/                            # 合并后的 main 上再跑一次
```

---

## Self-Review

**Spec coverage**：设计文档 §1.1 门控 → Task 1；§1.2 三字段 → Task 3；§1.3 结算 → Task 4；
§1.4 三条规则 → Task 2 + Task 4 的 `promoteIfNeeded`；§2 相位对齐 → Task 5；
§3 铃 → Task 6；§5 十条判据 → 十条分别落在 Task 1（1、2、3 的一部分）、Task 4（3、4、5、6、10）、
Task 5（7）、Task 6（8）、Task 3（9）。§4"明确不做"的四条不需要任务。
**缺口**：判据 3 的"上升沿只响一次"在 Task 1 是纯层版本、在 Task 4 是端到端版本，两处都要有（已列）。

**Placeholder scan**：无 TBD/TODO；每个代码步骤都给了可粘贴的实现或测试；
`bondFrom` / `mkC` / `creatureAt` / `Recorder` 都在 Task 内说明了是测试文件里的现成或新增 helper。

**Type consistency**：`pairEligible(a, b, dist)`、`syncDegree(c)`、`companionReady(c)`、
`bondStep(c, partnerId, eligible, dt) → {degree, crossed}`、`syncPhases(bodies, world, dt)`、
`promoteCompanion(memory, id) → boolean`、`demoteCompanion(memory, id) → boolean`、
`companionOf(memory) → entry|null`、`callForEvent('synced') === 'bell'`
在 Task 1/2/4/5/6 的 Interfaces 与代码块中拼写一致。
