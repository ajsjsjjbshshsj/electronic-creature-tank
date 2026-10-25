# 拎着玩（grab & carry）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家用手指（或鼠标）按住一只星绒绒把它拎起来拖着走，被拎的那只按性格 × 好感给出反应，松手带惯性甩出去但不引入任何伤害通道。

**Architecture:** 判定分两半：**"抓的是哪只"留在表现层**（`main.js` 用现成的 `pickCreature`，与信息卡同一套几何），结论塞进表现层唯一可写字段 `world.playerHand` 的新载荷 `grab: { id }`；**"抓着之后世界怎么变"全在内核**（`sim.js` + 新的纯函数模块 `grab.js`）。被拎的那只走一条独立的临界阻尼追随运动律，不复用 `moveToward`（它把速率钳在 `baseSpeed`，症状是"一拖就脱手"）。

**Tech Stack:** 零依赖原生 ES Modules；Canvas 2D；测试用 Node 内建 `node:test` + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-10-24-grab-and-carry-design.md` —— 六条裁定（R-1…R-6）、§6 让路规则、§9 十五条判据都在那里。**计划与 spec 一起读**，本文件只写"怎么落地"，不重述"为什么"。

## Global Constraints

每一个任务都必须同时满足下面这些（全部逐字来自本仓库现行约束）：

- **零 npm 依赖**，不新增任何包。
- **只有 `src/main.js` 允许出现七个浏览器标识符**：`document`、`window`、`canvas`、`requestAnimationFrame`、`AudioContext`、`fetch`、`localStorage`。新模块要浏览器能力就靠**参数注入**（`tests/constraints.test.js` 是机器守卫）。
- **`Math.random()` 全仓禁用**（同一条守卫）。
- **表现层不许写世界**，唯一例外是 `world.playerHand` 这一个字段（`src/main.js:38`、`src/sim.js:819`）。本设计给它加载荷，但**仍然是那一个字段**。
- **固定步长 `1/60`**（`CONFIG.fixedDt`），倍速只能靠子步进；位移一律写"速率 × dt"，**不许写"每帧位移"**。
- **每个丢弃 / 越权 / 失败都要有计数器或事件**（spec §7.7 绝不静默）。
- **常数守卫**：`tests/config.test.js` 用精确相等钉 `CONFIG` 的节点数、顶层键名列表与一条路径抽查表；**新增一段 CONFIG 必须同时更新这三处，且数字要跑出来不能估**（文件里那句"数出来的不是估的"是字面意思）。
- **TDD**：每个任务先写会红的测试，再写实现；实现完必须做**探针**（故意把实现写坏，确认测试真的红）。
- **提交节奏**：每个任务一次提交；`git push` 前用 `git ls-remote` 核对远程状态，别信 push 输出里的 "Everything up-to-date"（443 半途断连会假报成功）。
- 测试基线：本计划起点 **1052 / 1052**（`main` = `41689d6`）。每个任务结束时报"总数 + pass + fail"，并用 `grep -c '^test(' tests/*.test.js` 对账（现差值 **+4**，来自参数化循环；差值变了要说明为什么）。

---

## 文件结构（先定死，任务边界从这里来）

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/config.js` | `CONFIG.grab` 一段（几何阈值、追随刚度、反应系数）+ `CONFIG.emotions.eventMagnitude` 两行新事件 | 修改 |
| `src/grab.js` | **纯函数**：身体半径、越界判据、临界阻尼追随一步、`enjoyOf`、`carryEffects`（每 tick 的反应增量） | 新建 |
| `tests/grab.test.js` | 上面五件事的数学与单调性 + 探针判据 | 新建 |
| `src/sim.js` | 转发 `grab`（拷贝）、`isHeld`、三个谓词让路、`executeIntent` 顶部接管运动、上升沿反应与事件、`c.held` 寄存器归零 | 修改 |
| `src/save.js` | `CREATURE_SKIP_FIELDS` 加 `'held'` | 修改 |
| `src/main.js` | 候选 pick（用 `appeared` 上升沿）、`pulledOut` 成立、**粘住**、抬起 / 目标消失清空、`stop()` 清理 | 修改 |
| `tests/sim.test.js` | 内核行为判据（拖 ≠ 扎、逐只让路、墙、惯性、确定性） | 修改 |
| `tests/hud-boot.test.js` | 接线判据（grab.id 与信息卡同一只、引用不是同一个对象） | 修改 |
| `tests/config.test.js` | 常量守卫三处更新 + 两条不等式守卫 | 修改 |
| `docs/superpowers/specs/2026-10-14-…-design.md` | §6.1 / §9.2 第 7 条 / §4.7 / §7.2 回写 + 两条新判据 | 修改 |
| `docs/superpowers/checklists/2026-10-22-plan2-visual-checklist.md` | 新开 §11（这一轮：等玩家手感的格子 + 已知缺口） | 修改 |

---

### Task 1: `CONFIG.grab` 与两行情绪事件（先把常数与守卫立起来）

**Files:**
- Modify: `src/config.js`（在 `CONFIG.hud` 那段之后加一段；`CONFIG.emotions.eventMagnitude` 加两行，见 `src/config.js:249-262`）
- Modify: `tests/config.test.js`（节点数 `:103`、键名表 `:106-113`、键数 `:114`、路径抽查表 `:115-130`）
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: 无（本任务是最前面一段）
- Produces:
  - `CONFIG.grab.pullOutRatio: number`、`CONFIG.grab.followStiffness: number`、`CONFIG.grab.shakeSpeedFloor: number`、`CONFIG.grab.shakePerSecond: number`、`CONFIG.grab.affectionRate: number`、`CONFIG.grab.familiarityRate: number`、`CONFIG.grab.w.{clingy, affection, irritable}: number`
  - `CONFIG.emotions.eventMagnitude.grabbedHappy` / `.grabbedRough`（形状与 `poked` / `petted` 相同：`{ 情绪名: delta }`）
  - 后续任务一律**只从 `CONFIG.grab` 读数**，不许在 `grab.js` / `sim.js` / `main.js` 里再写一份兜底常数（Task 1 计划在 `gestures.js` 上犯的 DEFAULTS 错误，本任务从结构上避免）。

- [ ] **Step 1: 先写"当前必然红"的守卫测试**

在 `tests/config.test.js` 末尾加一段（数值此时全是编的也没关系 —— 这一步要的是**红**）：

```js
// ---------------------------------------------------------------- 拎着玩（grab & carry）
test('CONFIG.grab 一段的形状（七个键：六个标量 + 一个三项权重子表）', () => {
  assert.deepEqual(Object.keys(CONFIG.grab).sort(),
    ['affectionRate', 'familiarityRate', 'followStiffness', 'pullOutRatio',
     'shakePerSecond', 'shakeSpeedFloor', 'w'],
    `CONFIG.grab 键集变了：${Object.keys(CONFIG.grab).sort()}`);
  assert.deepEqual(Object.keys(CONFIG.grab.w).sort(), ['affection', 'clingy', 'irritable']);
});

// 两条不等式守卫是这件功能的地基，不是"顺手加的校验"：
//   ① 越界阈值必须大于抚摸接触阈值，否则"拎"与"摸"同时为真，让路规则白写；
//   ② 被拎起来的情绪冲击不许比被戳更疼（|delta| 逐项不超 poked 那一行）。
test('pullOutRatio 必须严格大于 petContactRatio —— 否则摸与拎重叠', () => {
  assert.ok(CONFIG.grab.pullOutRatio > CONFIG.behavior.petContactRatio,
    `重叠了：pullOutRatio ${CONFIG.grab.pullOutRatio} ≤ petContactRatio ${CONFIG.behavior.petContactRatio}`);
});

test('grabbedRough 不许比 poked 更疼（逐项对比绝对值）', () => {
  const rough = CONFIG.emotions.eventMagnitude.grabbedRough;
  const poked = CONFIG.emotions.eventMagnitude.poked;
  for (const [k, v] of Object.entries(rough)) {
    assert.ok(Math.abs(v) <= Math.abs(poked[k] ?? 0) + 1e-12,
      `${k}：被拎 ${v} 比被戳 ${poked[k]} 还狠，那没人敢碰娃娃了`);
  }
});
```

- [ ] **Step 2: 跑测试确认它红**

Run: `node --test tests/config.test.js`
Expected: FAIL，报 `Cannot read properties of undefined (reading 'sort')`（`CONFIG.grab` 还不存在），后两条报 `Cannot read properties of undefined`。三条都得红 —— 只红一条说明夹具在空转。

- [ ] **Step 3: 写 `CONFIG.grab` 与两行事件表**

`src/config.js`，`CONFIG.hud` 那段之后：

```js
  // ---- 拎着玩（grab & carry，spec 2026-10-24 §3–§5）----
  // 阈值分两类，别混：
  //   ① pullOutRatio 是**手感量**，只能由玩家的手一票否决（清单 §11 那一格），
  //      这里的初值是几何推定：petContactRatio 1.15 是"擦到毛边就算摸"，
  //      而"拎起来"要让指尖整个越出星臂尖之外，故取 1.5（≈ 臂尖外再 0.35 倍半径）。
  //      守卫只钉"不许与抚摸重叠"那条不等式，不钉它的绝对值 —— 绝对值错了不会红，
  //      只有人手会抱怨"要拔老高才拎得起"。
  //   ② followStiffness 是**数学量**，Task 2 用脚本量出来回填（收敛用时与最大过冲），
  //      所以这里写的必须是实测数，注释里带上量到的两个数。
  grab: {
    pullOutRatio: 1.5,
    followStiffness: 140,        // ← Task 2 Step 5 实测后回填，别照抄
    shakeSpeedFloor: 0.06,       // 归一化单位/秒：手速低于这个不算"摇"（与 HAND_SPEED_POKE 同口径）
    shakePerSecond: 0.16,        // 每秒不适累积上限系数（乘 (1 − enjoy)）
    affectionRate: 0.03,         // 只有 enjoy > 0.5 才买好感；比 petAffectionRate 0.06 的一半略低
    familiarityRate: 0.04,       // "认识"照旧买（与 sim.js 里手停附近那条同值）
    w: { clingy: 0.5, affection: 0.5, irritable: 0.35 },   // enjoyOf 的三项权重
  },
```

`CONFIG.emotions.eventMagnitude` 里 `poked` 那行下面：

```js
      // 拎着玩的两个方向（spec §5）。刻意写成**两行**而不是一行带符号：
      // applyEvent 对表里每一项乘**同一个** scale，一行写不出"不开心时 joy 降而 anger 升"。
      grabbedHappy: { joy: 0.3, fear: -0.15 },
      grabbedRough: { anger: 0.2, fear: 0.25, joy: -0.2 },
```

- [ ] **Step 4: 用脚本量出真实的节点数与键数，回填守卫**

Run:

```bash
node -e "let n=0;const w=(x)=>{if(!x||typeof x!=='object')return;n++;for(const k of Object.keys(x))w(x[k])};import('./src/config.js').then(({CONFIG})=>{w(CONFIG);console.log('nodes',n,'keys',Object.keys(CONFIG).length)})"
```

Expected: `nodes 64 keys 54` —— **但必须以这条命令的输出为准**，不许照抄我写的数（起点是 nodes 61 / keys 53，本任务净加：`grab` 一段 + 其 `w` 子表 + `grabbedHappy` + `grabbedRough` = 4 个节点）。把 `tests/config.test.js:103` 的 `61`、`:114` 的 `53` 改成量到的数，键名表里按字母序插入 `'grab'`，并在上面那段"⚠️ 60 → 61"注释后**照现有格式**补一行说明本轮加了几段、加了什么：

```js
  // ⚠️ 61 → 64、53 → 54（2026-10-24 拎着玩 Task 1）：新增 **CONFIG.grab 一段**（grab + w 两个节点、
  //    六个标量 + 一个三项权重子表）与 eventMagnitude 的 **grabbedHappy / grabbedRough 两行**（两个节点）。
  //    数字是上面那条 node -e 跑出来的。
```

- [ ] **Step 5: 路径抽查表加三条**

同文件那段 `for (const path of [...])` 列表里追加（`visited` 必须显式包含新路径，否则"某段完全没被遍历"仍会漏）：

```js
    'CONFIG.grab', 'CONFIG.grab.w', 'CONFIG.emotions.eventMagnitude.grabbedHappy',   // 2026-10-24 拎着玩
```

Run: `node --test tests/config.test.js` → Expected: 全绿。

- [ ] **Step 6: 探针（三条，逐条做完立刻还原）**

1. 把 `pullOutRatio` 改成 `1.1`（≤ petContactRatio）⇒ 不等式守卫必须红。
2. 把 `grabbedRough.fear` 改成 `0.5`（> poked 的 0.45？不是 —— poked.fear 是 0.45，0.5 更大）⇒ "不许比 poked 更疼"必须红。
3. 删掉 `'CONFIG.grab'` 那一行路径抽查 ⇒ **必须仍然绿**，这是预期的：节点数守卫靠 `visited.length` 总数，路径表只是抽查。**如果这条探针让测试红了，说明路径表被当成了唯一守卫，要停下来查 `config.test.js` 的遍历起点。**

还原方式：`cp` 备份后改回并 `cmp` 校验（**不许用 `git checkout` 还原探针** —— 计划 3 Task 2 就是这么抹掉未提交的实现的）。

- [ ] **Step 7: 全绿后提交**

```bash
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
git add src/config.js tests/config.test.js
git commit -m "feat: CONFIG.grab 一段与两行拎起情绪 + 不等式守卫（摸/拎不许重叠、拎不许比戳疼）"
```

---

### Task 2: `src/grab.js` 纯函数层（几何、追随数学、反应系数）

**Files:**
- Create: `src/grab.js`
- Create: `tests/grab.test.js`
- Modify: `src/config.js`（回填 `followStiffness` 的实测值）

**Interfaces:**
- Consumes: `CONFIG.grab`（Task 1）、`sizeOf(c)`（`src/creature.js:202`）
- Produces（签名逐字照此，Task 3 / Task 4 按这些名字调用）:
  - `bodyRadius(c) → number`（世界归一化半径，= `sizeOf(c) / 1000`）
  - `pulledOut({ handDist, r }) → boolean`
  - `heldStep({ pos, vel, target, dt, k }) → { x, y, vx, vy }`
  - `enjoyOf(c, affection) → number ∈ [0,1]`
  - `carryEffects({ enjoy, speed, dt }) → { joy, anger, fear, affection, familiarity }`
- **本模块不 import `render.js`**（半径一律走 `bodyRadius` = 内核 `inContact` 的同一口径），也**不碰任何浏览器对象**。

- [ ] **Step 1: 写 `pulledOut` 与 `bodyRadius` 的失败测试**

`tests/grab.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { bodyRadius, pulledOut, heldStep, enjoyOf, carryEffects } from '../src/grab.js';

const C = (size) => ({ traits: { size } });

test('bodyRadius 就是内核 inContact 用的那一个口径（sizeOf/1000）', () => {
  assert.ok(Math.abs(bodyRadius(C(26)) - 0.026) < 1e-12, `${bodyRadius(C(26))}`);
  // ⚠️ 这条不是洁癖：让路规则的成立与否取决于"摸"与"拎"量的是同一把尺。
  // 两处不同尺的话，Task 3 的让路会随视口大小漂移。
  assert.ok(CONFIG.grab.pullOutRatio > CONFIG.behavior.petContactRatio);
});

test('pulledOut：没越过 pullOutRatio 不算拎起（那还是抚摸）', () => {
  const r = 0.026;
  const cut = r * CONFIG.grab.pullOutRatio;
  assert.equal(pulledOut({ handDist: cut * 0.99, r }), false);
  assert.equal(pulledOut({ handDist: cut * 1.01, r }), true);
});

test('pulledOut 的脏输入一律 false，不抛', () => {
  for (const bad of [{}, { handDist: NaN, r: 0.026 }, { handDist: 0.1, r: 0 },
                     { handDist: -1, r: 0.026 }, null]) {
    assert.equal(pulledOut(bad ?? {}), false, JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node --test tests/grab.test.js`
Expected: FAIL，`Cannot find module '…/src/grab.js'`。

- [ ] **Step 3: 写 `src/grab.js` 的几何两件事**

```js
// 拎着玩的纯函数层：抓的几何、跟随的数学、反应的系数。
//
// 为什么单开一个文件而不是塞进 sim.js：这三件事**没有世界也能算**，
// 而 sim.js 的测试夹具要拖住一只个体跑好几个 tick 才能问到同一个问题。
// 拆出来之后"过冲不许反向"这类数学性质直接在 Node 里量（见 tests/grab.test.js）。
//
// 边界：本文件不 import render.js（半径口径必须与内核 inContact 同一把尺，见 bodyRadius），
// 不碰浏览器对象，不用 Math.random。
import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 世界归一化半径。刻意与 sim.js 的 inContact 同一个表达式 ——
// 两处各写一遍就会随视口漂移，"摸得到但拎不起"就是这么冒出来的。
export function bodyRadius(c) {
  return num(sizeOf(c), 0) / 1000;
}

/**
 * 手是否已经把这只"带离"了身体（spec §3 的位移判据）。
 * 只在**还没拎住**时用来判成立；一旦成立，调用方（main.js）负责粘住。
 */
export function pulledOut({ handDist, r } = {}) {
  const d = num(handDist, -1);
  const rr = num(r, -1);
  if (!(d >= 0) || !(rr > 0)) return false;
  return d > rr * CONFIG.grab.pullOutRatio;
}
```

Run: `node --test tests/grab.test.js` → Expected: 前 3 条 PASS。

- [ ] **Step 4: 写 `heldStep` 的三条数学性质测试（先红）**

追加到 `tests/grab.test.js`：

```js
// 半隐式欧拉的临界阻尼追随。这三条性质是"手感"的数学替身 ——
// 人不在这儿，但"过冲反向"与"dt 不线性"都会变成可断言的红。
const drive = (x0, vx0, tx, n, dt, k) => {
  let pos = { x: x0, y: 0 }, vel = { x: vx0, y: 0 };
  const trail = [];
  for (let i = 0; i < n; i += 1) {
    pos = heldStep({ pos, vel, target: { x: tx, y: 0 }, dt, k });
    vel = { x: pos.vx, y: 0 };
    trail.push(pos);
  }
  return trail;
};

test('heldStep 临界阻尼：朝目标冲过去之后不许反向 overshoot（不抖）', () => {
  const trail = drive(0, 0, 1, 240, 1 / 60, CONFIG.grab.followStiffness);
  const crossed = trail.filter((p) => p.x > 1).length;
  assert.equal(crossed, 0, `越过后反向冲回 ${crossed} 帧 —— 阻尼写错了`);
  assert.ok(trail[trail.length - 1].x > 0.99, '两秒还没跟到手边，k 太小');
});

test('heldStep 对 dt 线性：一次 1/60 ≈ 两次 1/120（容差写死，不许事后放宽）', () => {
  const one = heldStep({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, target: { x: 0.05, y: 0 },
    dt: 1 / 60, k: CONFIG.grab.followStiffness });
  let pos = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
  for (let i = 0; i < 2; i += 1) {
    const s = heldStep({ pos, vel, target: { x: 0.05, y: 0 }, dt: 1 / 120,
      k: CONFIG.grab.followStiffness });
    pos = { x: s.x, y: s.y }; vel = { x: s.vx, y: s.vy };
  }
  assert.ok(Math.abs(one.x - pos.x) < 2e-4, `半隐式与子步差 ${(one.x - pos.x).toExponential(2)}`);
});

test('heldStep：目标与位置重合时速度归零（不会自己在原地晃）', () => {
  const s = heldStep({ pos: { x: 0.3, y: 0.4 }, vel: { x: 0, y: 0 }, target: { x: 0.3, y: 0.4 },
    dt: 1 / 60, k: CONFIG.grab.followStiffness });
  assert.ok(Math.abs(s.vx) < 1e-12 && Math.abs(s.x - 0.3) < 1e-12, JSON.stringify(s));
});

test('heldStep 的脏输入退化而不抛：dt 非有限 ⇒ 原样交出', () => {
  const s = heldStep({ pos: { x: 0.2, y: 0.3 }, vel: { x: 1, y: 1 }, target: { x: 0.8, y: 0.3 },
    dt: NaN, k: CONFIG.grab.followStiffness });
  assert.equal(s.x, 0.2); assert.equal(s.vx, 1);
});
```

Run: `node --test tests/grab.test.js` → Expected: 这四条红（`heldStep is not a function`）。

- [ ] **Step 5: 写 `heldStep` 并实测 `followStiffness`**

```js
/**
 * 被拎的那只朝手位走**临界阻尼追随**一步（spec §4 / R-6）。
 * 不复用 moveToward：那条把速率钳在 CONFIG.motion.baseSpeed ⇒ 手快拖时追不上 ⇒ "一拖就脱手"。
 * 这里的 vel 是真实位移率，所以松手即惯性，不需要第二个"投掷"公式。
 * 半隐式：先更新速度再更新位置 —— 显式欧拉在 k=140、dt=1/60 下发散（下面那条 dt 线性测试会红）。
 * a = ω²(target − pos) − 2ω·v，ω = √k ⇒ 临界阻尼，理论上零过冲。
 */
export function heldStep({ pos, vel, target, dt, k } = {}) {
  const d = num(dt, 0), kk = Math.max(0, num(k, 0));
  const px = num(pos && pos.x, 0), py = num(pos && pos.y, 0);
  const vx0 = num(vel && vel.x, 0), vy0 = num(vel && vel.y, 0);
  const tx = num(target && target.x, px), ty = num(target && target.y, py);
  if (!(d > 0)) return { x: px, y: py, vx: vx0, vy: vy0 };
  const w = Math.sqrt(kk);
  const ax = w * w * (tx - px) - 2 * w * vx0;
  const ay = w * w * (ty - py) - 2 * w * vy0;
  const vx = vx0 + ax * d, vy = vy0 + ay * d;
  return { x: px + vx * d, y: py + vy * d, vx, vy };
}
```

然后**实测**回填 `followStiffness`（不许留 Step 3 里那个 140 的占位数）：

```bash
node -e "
const {heldStep}=await import('./src/grab.js');
for (const k of [40,80,140,220,320,480]) {
  let pos={x:0,y:0},vel={x:0,y:0},over=0,t95=null;
  for(let i=0;i<240;i++){const s=heldStep({pos,vel,target:{x:1,y:0},dt:1/60,k});
    pos={x:s.x,y:s.y};vel={x:s.vx,y:s.vy};
    if(s.x>1.001)over++; if(t95===null&&s.x>0.95)t95=(i+1)/60;}
  console.log('k',k,'过冲帧',over,'95%收敛',(t95*1000).toFixed(1)+'ms');
}" --input-type=module
```

挑选规则（写进提交信息里）：**95% 收敛在 100–160 ms 之间且过冲帧数为 0 的最小 k**。把量到的数写回 `src/config.js` 的 `followStiffness`，并把那两个读数补进常数上方的注释（例：`k=220 ⇒ 95% 收敛 132.5 ms、过冲 0 帧`）。

Run: `node --test tests/grab.test.js tests/config.test.js` → Expected: 全绿（含 Task 1 的不等式守卫）。

- [ ] **Step 6: 写 `enjoyOf` 与 `carryEffects`（先测试后实现）**

测试：

```js
const CR = (o = {}) => ({ traits: { personality: { clingy: o.clingy ?? 0.5,
  irritable: o.irritable ?? 0.5, bold: 0.5 } } });

test('enjoyOf 三个方向各自单调（R-2：同一句话拖两只要得到两种反应）', () => {
  const mid = enjoyOf(CR({}), 0.5);
  assert.ok(enjoyOf(CR({ clingy: 0.9 }), 0.5) > mid, '黏人的应该更享受');
  assert.ok(enjoyOf(CR({ irritable: 0.9 }), 0.5) < mid, '易怒的应该更抗拒');
  assert.ok(enjoyOf(CR({}), 0.9) > mid, '好感高的应该更享受');
  assert.ok(enjoyOf(CR({}), 0) < mid);
});

test('enjoyOf 三项全 0 ⇒ 落在中段而不是 0（不然出厂个体一律"被吓"）', () => {
  const e = enjoyOf(CR({ clingy: 0, irritable: 0 }), 0);
  assert.ok(e >= 0.2 && e <= 0.8, `${e}`);
  for (const bad of [{}, { traits: {} }, { traits: { personality: {} } }, null]) {
    assert.equal(typeof enjoyOf(bad ?? {}, NaN), 'number', '脏输入不许抛，也不许 NaN');
  }
});

test('carryEffects：手不动（无摇）仍买 familiarity，但不买好感、不积不适', () => {
  // familiarity（"认识"）与 affection（"喜欢"）是两条通道，**别一起门控**：
  // 手速为 0 就是"把它拎在手里不动"，那仍然是在理它 —— 熟悉度与冷落计时都该继续走。
  // 这条测试存在的意义，是让下一个想"顺手把 familiarity 也挂到 shake 上"的人必须解释为什么。
  const z = carryEffects({ enjoy: 0.5, speed: CONFIG.grab.shakeSpeedFloor - 0.01, dt: 1 / 60 });
  assert.deepEqual(z, {
    joy: 0, anger: 0, fear: 0, affection: 0, familiarity: CONFIG.grab.familiarityRate / 60,
  });
});

test('carryEffects：摇得越快，同一 enjoy 下恐惧/愤怒越大；而 enjoy 翻转符号方向（不新增第二套规则）', () => {
  const a = carryEffects({ enjoy: 0.1, speed: 0.3, dt: 1 });
  const b = carryEffects({ enjoy: 0.1, speed: 0.6, dt: 1 });
  assert.ok(b.fear > a.fear && b.anger > a.anger && b.joy < a.joy);
  const happy = carryEffects({ enjoy: 0.9, speed: 0.6, dt: 1 });
  assert.equal(happy.anger, 0, '享受的那只不该积愤怒');
  assert.ok(happy.joy > 0);
});

// ⚠️ 这条是本仓库最容易被写坏的地方：只断"结果对不对"分不出实现。
// 好感**只在 enjoy > 0.5 才涨**，否则把手挂在那只身上就能刷满好感度（spec §5 的分工）。
test('carryEffects：enjoy ≤ 0.5 一律不买好感（刷不了），但认识照旧买', () => {
  assert.equal(carryEffects({ enjoy: 0.5, speed: 0.4, dt: 1 }).affection, 0);
  assert.ok(carryEffects({ enjoy: 0.51, speed: 0.4, dt: 1 }).affection > 0);
  assert.ok(carryEffects({ enjoy: 0, speed: 0.4, dt: 1 }).familiarity > 0);
});
```

实现（追加到 `src/grab.js`）：

```js
/** 反应方向：性格 × 好感（spec §5）。affection 由调用方读好传进来，本模块不 import memory.js。 */
export function enjoyOf(c, affection) {
  const p = (c && c.traits && c.traits.personality) || {};
  const w = CONFIG.grab.w;
  return clamp01(num(p.clingy, 0.5) * w.clingy
    + num(affection, 0) * w.affection
    - num(p.irritable, 0.5) * w.irritable);
}

/**
 * 被拎着期间每个 tick 的反应增量。摇动带来的不适，符号由同一个 enjoy 翻转，不新增第二套规则。
 * 返回五个**增量**（调用方负责加与钳位），这样"不该买的没买"能被逐字段断言。
 *
 * ⚠️ familiarity **不在** shake 的门里：拎在手里不动仍然是在理它（spec §5 把"认识"与"喜欢"
 * 分成两条通道，只有"喜欢"需要享受才买）。写在这里而不是让调用方补 —— 两处各补一次就会漏一次。
 */
export function carryEffects({ enjoy, speed, dt } = {}) {
  const e = clamp01(num(enjoy, 0.5));
  const d = Math.max(0, num(dt, 0));
  const over = num(speed, 0) - CONFIG.grab.shakeSpeedFloor;
  const shake = over > 0 ? CONFIG.grab.shakePerSecond * over * d : 0;
  const rough = 1 - e;
  return {
    joy: shake * e * 0.5,
    anger: shake * rough,
    fear: shake * rough,
    affection: e > 0.5 ? CONFIG.grab.affectionRate * d : 0,
    familiarity: CONFIG.grab.familiarityRate * d,
  };
}
```

- [ ] **Step 7: 探针（四条，逐条还原，`cp` + `cmp`）**

1. `heldStep` 的 `2 * w * vx` 改成 `w * vx`（欠阻尼）⇒ 过冲测试必须红。
2. `enjoyOf` 的 `- num(p.irritable, 0.5) * w.irritable` 整项删掉 ⇒ "易怒的应该更抗拒"必须红。
3. `carryEffects` 的 `affection` 三元改成无条件 `affectionRate * d` ⇒ "enjoy ≤ 0.5 不买好感"必须红。
4. `pulledOut` 的 `>` 改成 `>=` ⇒ **应当仍然绿**（边界点两侧都不落在测试取的数上）。这是一条**预期存活**的探针，写进提交信息：它说明阈值精度不是这件功能的承重点，别为它加测试。

- [ ] **Step 8: 提交**

```bash
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
git add src/grab.js tests/grab.test.js src/config.js
git commit -m "feat: grab.js —— 抓的几何、临界阻尼追随、性格×好感的反应系数（全纯函数）

followStiffness = <实测数>，量法：95% 收敛 <x> ms、过冲 0 帧（node -e 跑出来的，不是估的）。
探针四条：欠阻尼被抓、删 irritable 项被抓、好感门控被抓；>= 与 > 互换**预期存活**并记进提交信息。"
```

---

### Task 3: 内核接管（转发、让路、运动、上升沿、寄存器与存档）

**Files:**
- Modify: `src/sim.js`（`perceive` 的手部转发 `:517-530`、`isPetting` / `isBeingPetted` / `isPoking` `:566-597`、`executeIntent` 顶部 `:629-646`、`tickCreature` 的上升沿段 `:929-950`、`restoreCreature` `:343-360`）
- Modify: `src/save.js`（`CREATURE_SKIP_FIELDS` `:189-193`）
- Modify: `src/creature.js`（`createCreature` 里与 `beingPetted` / `beingPoked` 同处加 `held: false`，见 `:106-109`）
- Test: `tests/sim.test.js`

**Interfaces:**
- Consumes: `pulledOut`（不需要）、`heldStep` / `enjoyOf` / `carryEffects`（Task 2）、`CONFIG.grab`（Task 1）
- Produces:
  - `senses.playerHand.grab → { id } | null`（**拷贝**，不是引用）
  - `isHeld(c, senses) → boolean`、`isPettingNear(c, senses) → boolean`（模块内函数，与 `isPoking` 同族）
  - 新世界字段 `c.held: boolean`（上升沿寄存器，不入档）
  - 新事件 `{ kind: 'grab', id, enjoy }`、`{ kind: 'release', id, enjoy, speed }`

**本任务测试用的夹具（名字与 `tests/sim.test.js` 现有的导入对齐，不新造世界观）：**

```js
// 该文件已经 import 了 createWorld / addCreature / createCreature / createRng /
// tickWorld / CONFIG / PLAYER_ID / ensure / get / sizeOf（见 tests/sim.test.js:3-13），
// 所以这里只用它们。初代个体由 createWorld 自己播种 —— 刻意不手工搭一套"更像样"的缸，
// 否则夹具与真缸行为分叉，测到的就不是线上那条路径。
const freshWorld = (opts = {}) => {
  const w = createWorld({ seed: 20261024, ...opts });
  w.foods.length = 0;
  for (const c of w.creatures) {
    // 钉成 idle（同 tests/sim.test.js:1737 那条的理由）：不锁的话它自己游走，
    // 而手是固定的，接触会一会儿断一会儿 —— 于是"拎的语义"测成了随机游走。
    c.intent = { kind: 'idle', minDuration: 1e9 };
    ensure(c.memory, PLAYER_ID);
  }
  return w;
};
// 世界坐标下"贴上身体"的尺度，沿用该文件已有的 touchDist（:1741）
```

**两处新 import（本任务与 Task 4 各自要的那两行，落地时补，别在测试里现取）：**

```js
// src/sim.js 顶部：
import { heldStep, enjoyOf, carryEffects } from './grab.js';
// src/main.js 顶部（pickCreature 已经在那儿了）：
import { bodyRadius, pulledOut } from './grab.js';
```

补 import 的顺序按各文件现有的那一段走（都是相对路径、按层排序），并且**只有 `src/main.js` 那行不新增浏览器标识符** —— `grab.js` 是纯模块，`tests/constraints.test.js` 的白名单不用放宽；跑一遍它确认（Task 4 Step 7 之前）。

- [ ] **Step 1: 转发 `grab`，并写"不是同一个引用"的判据**

`src/sim.js:517-530` 那段改成：

```js
  let playerHand = null;
  if (world.playerHand) {
    const d = Math.hypot(world.playerHand.pos.x - c.pos.x, world.playerHand.pos.y - c.pos.y);
    // 手比同类更"显眼"：感知半径放宽到 1.5 倍，好让玩家一伸手就有反应。
    // ⚠️ 例外：正被拎着的那只不受半径门限制 —— 否则手甩到缸对面时 grab 会因为
    // perceive 半径失效而**静默脱手**（症状：拎着拎着娃娃自己掉地上了，没有任何事件）。
    const grabbedId = world.playerHand.grab ? world.playerHand.grab.id : null;
    if (d <= R * 1.5 || grabbedId === c.id) {
      playerHand = {
        pos: world.playerHand.pos, dist: d, speed: world.playerHand.speed,
        down: !!world.playerHand.down, appeared: !!world.playerHand.appeared,
        // grab 必须是**新对象**：main.js:932 那段 ⚠️ 说"pos 按引用搬是安全的，因为本 tick 用完"，
        // 而抓的语义是跨帧的（c.held 会活过很多 tick）。按引用搬就得到"隔帧读到的 id 是别人的"。
        grab: grabbedId === null || grabbedId === undefined ? null : { id: grabbedId },
      };
    }
  }
```

测试（追加到 `tests/sim.test.js`，夹具沿用该文件已有的 `mk` / `world` 写法）：

```js
test('senses.playerHand.grab 不是 world.playerHand.grab 那个对象（跨帧拷贝）', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  const grab = { id: c.id };
  w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false, grab };
  const s = perceive(w, c);
  assert.deepEqual(s.playerHand.grab, { id: c.id });
  assert.notEqual(s.playerHand.grab, grab, '按引用搬 ⇒ 表现层改一个字段就等于写了内核的感知');
});

test('被拎的那只不受感知半径限制（甩到对面不许静默脱手）', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  w.playerHand = { pos: { x: 0.99, y: 0.01 }, speed: 1.2, down: true, appeared: false,
    grab: { id: c.id } };
  assert.ok(c.pos.x < 0.5, '夹具得把手和个体拉开，否则这条在空转');
  const s = perceive(w, c);
  assert.ok(s.playerHand && s.playerHand.grab, `半径门外就丢了 grab：dist=${Math.hypot(0.99 - c.pos.x, 0.01 - c.pos.y)}`);
});
```

`perceive` 是 `src/sim.js:481` 的导出。`tests/sim.test.js` 顶部若还没引它，就把名字**加进那行已有的 `from '../src/sim.js'`** —— 同一个模块开两条 import 会让下一个读这个文件的人以为两条有区别。

- [ ] **Step 2: 跑确认红 ⇒ 实现 ⇒ 绿**

Run: `node --test tests/sim.test.js` → Expected: 两条红（`s.playerHand.grab` 是 undefined）。
实现就是 Step 1 那段代码；然后 `node --test tests/sim.test.js` 全绿。

- [ ] **Step 3: `isHeld` + 三个谓词让路（先写"拖 ≠ 扎"的硬判据）**

这是整件功能的核心判据。测试：

```js
// R-1 的全部意义在这一条：不处理的话"拎起一只走"= 一路上升沿发 poked，
// 玩家得到的是"我一动它就被连扎"而不是"我拎起了它"。
// 断的是**次数**（数出来的就是 0），不是"情绪没变"—— 后者在分支没走到时也会绿。
test('拎着一只快速拖动 ⇒ poked 上升沿 0 次、startle 未被冲击、事件里没有 poke', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  c.traits.personality.clingy = 0.9;                 // 排除"因为享受所以别的路径挡了戳"这种巧合
  c.pos = { x: 0.5, y: 0.5 };
  let pokedEvents = 0;
  let hand = { x: 0.5, y: 0.5 };
  for (let i = 0; i < 40; i += 1) {
    hand = { x: 0.5 + 0.004 * (i % 8), y: 0.5 + 0.002 * i };
    // 每帧都算"按下 + 手速快 + 贴上身体"，除了 grab 之外与戳完全同形
    w.playerHand = { pos: { x: hand.x, y: hand.y }, speed: 0.5, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    pokedEvents += w.events.filter((e) => e.kind === 'poke').length;
    w.events.length = 0;
  }
  assert.equal(pokedEvents, 0, `被拎的那只还是被发了 ${pokedEvents} 次 poke`);
  assert.ok(c.needs.safety >= 0.99, `startle 还是被冲击了：safety=${c.needs.safety}`);
});

test('拎着 A 快速划过 B ⇒ B 的 poke 照发（让路必须逐只判）', () => {
  const w = freshWorld();
  const a = w.creatures[0];
  const b = w.creatures[1];
  b.pos = { x: 0.6, y: 0.5 };
  w.playerHand = { pos: { x: 0.6, y: 0.5 }, speed: 0.6, down: true, appeared: false,
    grab: { id: a.id } };
  tickWorld(w, CONFIG.fixedDt);
  assert.ok(w.events.some((e) => e.kind === 'poke' && e.id === b.id),
    `B 没被算成戳：${JSON.stringify(w.events)}`);
});
```

实现：在 `isPetting` 上方加：

```js
// 被拎住的那只。三个谓词（抚摸 / 贴上抚摸 / 戳）都在开头让路，且**只让给它自己** ——
// 拎着 A 划过 B 时 B 仍然算被戳（spec §6）。让路点只写在这一处：
// 散到各调用方的 if (grab) 早晚会被下一个消费者漏掉。
function isHeld(c, senses) {
  const h = senses.playerHand;
  return !!h && !!h.grab && h.grab.id === c.id;
}
```

三个谓词里有两个带 `c`，直接在开头各加一句：

```js
function isBeingPetted(c, senses) {
  if (isHeld(c, senses)) return false;
  const h = senses.playerHand;
  ...
}
function isPoking(c, senses) {
  if (isHeld(c, senses)) return false;
  const h = senses.playerHand;
  ...
}
```

`isPetting(senses)` 也要让路，但它**不能直接改**（它没有 `c` 参数，而让路必须逐只判）。
加一个"单一新谓词 + 两处调用点"的写法，与它自己那条注释（"这个谓词有两个消费者，必须是同一个定义点"）保持同构：

```js
// 手停附近的"认识"通道。被拎住的那只让路 —— 它的 familiarity 由 carryEffects 独家供给
// （spec §6 那张表把 isPetting 也列进来了，让路点必须与抚摸/戳同一处族）。
// 刻意包一层而不是在原谓词里加参数：isPetting 还被冷落计时用着，两处必须同一判据。
function isPettingNear(c, senses) {
  return !isHeld(c, senses) && isPetting(senses);
}
```

然后把 `src/sim.js:905` 与 `:961` 那两处 `isPetting(senses)` 换成 `isPettingNear(c, senses)`。

**这条改动的真正代价必须写下来**：拎着时 familiarity 只剩 `carryEffects` 一条通道，
速率恰好等于 `CONFIG.grab.familiarityRate`（0.04/s，与原来那条同值）—— 所以玩家看到的
"认识速度"不变，变的只是**来源**。这条由下面的测试钉死（它才是本轮少见的"两条通道速率相同"
带来的隐患：写成叠加就是 0.08/s，谁都不会 notice）。

补一条测试（放在 Step 3 那两条之后）：

```js
test('拎着时 familiarity 只从一条通道来（速率恰为 grab.familiarityRate，不是两倍）', () => {
  const w = freshWorld({ seed: 921 });
  const c = w.creatures[0];
  get(c.memory, PLAYER_ID).familiarity = 0;
  get(c.memory, PLAYER_ID).affection = 0;
  w.playerHand = { pos: { x: c.pos.x + touchDist(c) * 0.2, y: c.pos.y }, speed: 0,
    down: true, appeared: false, grab: { id: c.id } };
  for (let i = 0; i < 60; i += 1) { tickWorld(w, 1 / 60); w.events.length = 0; }
  const f = get(c.memory, PLAYER_ID).familiarity;
  const want = CONFIG.grab.familiarityRate;                 // 60 tick = 1 秒
  assert.ok(Math.abs(f - want) < want * 0.1,
    `一秒买到 ${f.toFixed(4)}，期望 ${want.toFixed(4)}（偏离 10% 内）—— 像是两条通道叠加了`);
});
```

Run: `node --test tests/sim.test.js` → Expected: 三条绿。

- [ ] **Step 4: 上升沿反应 + 事件（grab / release）**

`tickCreature` 里，抚摸段之前（`:925` 附近）插入：

```js
  // ---- 拎（spec 2026-10-24 §5）----
  // 上升沿走 c.held 寄存器，与 beingPetted / beingPoked 同族：倍速子步会把同一份手样本
  // 喂进多个 tick，靠"这帧速度过阈值"判次数必然翻倍。
  const held = isHeld(c, senses);
  if (held && !c.held) {
    c.held = true;
    const enjoy = enjoyOf(c, affectionFor(c.memory, PLAYER_ID));
    applyEvent(c.emotions, 'grabbedHappy', enjoy);
    applyEvent(c.emotions, 'grabbedRough', 1 - enjoy);
    world.events.push({ kind: 'grab', id: c.id, enjoy });
  } else if (!held && c.held) {
    c.held = false;
    const enjoy = enjoyOf(c, affectionFor(c.memory, PLAYER_ID));
    world.events.push({ kind: 'release', id: c.id, enjoy,
      speed: senses.playerHand ? senses.playerHand.speed : c.vel.x });
  }
  if (held) {
    const eff = carryEffects({ enjoy: enjoyOf(c, affectionFor(c.memory, PLAYER_ID)),
      speed: senses.playerHand.speed, dt });
    c.emotions.joy = clamp01(c.emotions.joy + eff.joy);
    c.emotions.anger = clamp01(c.emotions.anger + eff.anger);
    c.emotions.fear = clamp01(c.emotions.fear + eff.fear);
    if (eff.affection > 0 || eff.familiarity > 0) {
      adjustMemory(c.memory, PLAYER_ID, eff.affection, eff.familiarity);
    }
  }
```

（`clamp01` / `adjustMemory` / `affectionFor` / `PLAYER_ID` 都已在 `sim.js` 的 import 里；缺哪个补哪个，别新造同名函数。）

测试：

```js
test('抓住的上升沿只发一次 grab 事件，且按 enjoy 互补缩放', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  c.traits.personality.clingy = 0.95; c.traits.personality.irritable = 0;
  for (let i = 0; i < 3; i += 1) {
    w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
  }
  const grabs = [];
  for (let i = 0; i < 20; i += 1) {
    w.events.length = 0;
    tickWorld(w, CONFIG.fixedDt);
    grabs.push(...w.events.filter((e) => e.kind === 'grab'));
  }
  assert.equal(grabs.length, 0, `上升沿重放 ${grabs.length} 次 —— 倍速下会把一次拎当成二十次`);
  assert.ok(c.emotions.joy > 0, '黏人又好感的这只该享受');
});

test('把 scale 写成 1 就会被抓到：enjoy 低时 joy 不许升', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  c.traits.personality.clingy = 0; c.traits.personality.irritable = 0.95;
  ensure(c.memory, PLAYER_ID);
  get(c.memory, PLAYER_ID).affection = 0;      // 抗拒 + 生面孔 ⇒ enjoy 贴地
  get(c.memory, PLAYER_ID).familiarity = 0;
  const before = c.emotions.joy;
  w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
    grab: { id: c.id } };
  tickWorld(w, CONFIG.fixedDt);
  // 断的是**下降量**而不是 `joy <= before`：同 tick 末尾 updateEmotions 会按惯性往
  // 目标值回收一点，用不等号会把"回收得比冲击多"这种真 bug 放过去，也会把正确的实现判红。
  assert.ok(before - c.emotions.joy > 0.1,
    `joy 没降反升或降幅太小（${before} → ${c.emotions.joy}）—— 两行的 scale 大概都是 1`);
  assert.ok(c.emotions.anger > 0 || c.emotions.fear > 0, '抗拒的那只该有情绪反应');
});
```

- [ ] **Step 5: `executeIntent` 顶部接管运动（含墙与速度分量归零）**

`src/sim.js:629` 那个函数体最前面加：

```js
  // 被拎住 ⇒ 本 tick 的运动由"追随手"接管，正常意图一帧都不执行（spec §4 / R-6）。
  // 决策照常跑（tickCreature 在前面已经 decide 过），松手后下一 tick 自然接管，
  // 所以这里**不需要**任何"恢复"逻辑。
  if (isHeld(c, senses)) {
    const k = CONFIG.grab.followStiffness;
    const s = heldStep({ pos: c.pos, vel: c.vel, target: senses.playerHand.pos, dt, k });
    c.pos.x = clampPos(s.x);
    c.pos.y = clampPos(s.y);
    // 被墙截住的那个轴向速度归零：墙不存弹性能量（与 moveToward 撞墙的现有语义一致），
    // 也免得松手时那一点"朝墙里冲"的速度把个体甩进墙里再抖一下。
    let vx = s.vx, vy = s.vy;
    if (c.pos.x !== s.x) vx = 0;
    if (c.pos.y !== s.y) vy = 0;
    c.vel.x = vx; c.vel.y = vy;
    c.moving = true;
    c.resting = false;
    return;
  }
```

测试（三条：墙不越界且不额外受伤、松手有惯性、决策重新接管）：

```js
// ⚠️ 这条刻意**不**断"needs 逐字节不变" —— decayNeeds 每 tick 都在动（拎着 moving=true 还会
// 多耗 energy），那种断言会在正确实现上红。要钉的是"撞墙这件事本身不额外扣"，
// 所以拿同一种子、同一只、只差手位的一条对照缸来比。
const carryTo = (handX, seed = 20261024) => {
  const w = freshWorld({ seed });
  const c = w.creatures[0];
  for (let i = 0; i < 120; i += 1) {
    w.playerHand = { pos: { x: handX, y: 0.5 }, speed: 0.8, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    w.events.length = 0;
  }
  const g = w.creatures.find((x) => x.id === c.id);
  return { x: g.pos.x, vx: g.vel.x, safety: g.needs.safety, w };
};

test('拖到墙外：位置被 clampPos 截住、撞墙那轴速度归零、撞墙不额外扣安全感', () => {
  const open = carryTo(0.5);          // 同一种子，手在缸中央 ⇒ 全程不碰墙
  const wall = carryTo(5);            // 手在缸外 ⇒ 一路压到右壁
  assert.ok(wall.x <= 1 - CONFIG.motion.wallMargin + 1e-9, `越界了：${wall.x}`);
  assert.ok(wall.vx <= 1e-9, `撞墙那轴还在往外推：${wall.vx}`);
  assert.ok(wall.safety >= open.safety - 1e-6,
    `撞墙比不撞墙多扣了安全感（R-3 明写不许引入伤害通道）：wall=${wall.safety} open=${open.safety}`);
});

test('松手那一下 vel 不归零（惯性），且下一 tick 决策重新接管', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  c.pos = { x: 0.4, y: 0.5 };
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.6, down: true, appeared: false,
    grab: { id: c.id } };
  tickWorld(w, CONFIG.fixedDt);
  const fling = c.vel.x;
  assert.ok(fling > 0, `追随没给出朝手方向的速度：${fling}`);
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.6, down: false, appeared: false, grab: null };
  tickWorld(w, CONFIG.fixedDt);
  assert.equal(c.held, false);
  assert.ok(c.vel.x > 0, `松手那一下速度被清了（${c.vel.x}）= 甩不出去`);
});

// spec §6 那张表的最后一行："个体间碰撞照旧参与"。
// 它容易被写坏的样子是：给 held 分支加了 return 之后，顺手把被拎的那只从 resolve 的
// 成对推开里也跳过（"反正它在手里"），症状是拎着一只穿过另一只时后者毫无反应。
test('被拎的那只仍然参与个体碰撞：邻居照旧被推开', () => {
  const w = freshWorld({ seed: 918 });
  const a = w.creatures[0];
  const b = w.creatures[1];
  b.pos = { x: a.pos.x + 0.004, y: a.pos.y };        // 几乎重叠 ⇒ 推开量可测
  const bx0 = b.pos.x;
  w.playerHand = { pos: { x: a.pos.x, y: a.pos.y }, speed: 0, down: true, appeared: false,
    grab: { id: a.id } };
  tickWorld(w, CONFIG.fixedDt);
  assert.notEqual(b.pos.x, bx0, `邻居一点没被推开：${bx0} → ${b.pos.x}`);
});
```

- [ ] **Step 6: `c.held` 入族（出厂、读档、不入档）**

`src/creature.js` 的 `beingPetted: false` / `beingPoked: false` 旁边加 `held: false`；`src/sim.js:353-354`（`restoreCreature`）加 `out.held = false;`；`src/save.js` 的 `CREATURE_SKIP_FIELDS` 里 `'beingPetted', 'beingPoked',` 之后加 `'held',`。

测试（这条要新增两行 import：`serialize` 与 `migrate` 来自 `src/save.js:245 / :104`，`restoreWorld` 来自 `src/sim.js:248`）：

```js
test('held 是瞬时寄存器：存出去读回来必须为 false，且序列化里不出现 "held"', () => {
  const w = freshWorld();
  const c = w.creatures[0];
  w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
    grab: { id: c.id } };
  tickWorld(w, CONFIG.fixedDt);
  assert.equal(c.held, true, '夹具没把这只拎起来，这条在空转');
  const doc = serialize(w);
  assert.ok(!/"held"/.test(JSON.stringify(doc)), '表现层瞬时状态入档了（spec §7.2）');
  const w2 = createWorld({ seed: 1, initialCreatures: 0 });
  restoreWorld(w2, migrate(doc));
  assert.equal(w2.creatures.find((x) => x.id === c.id).held, false,
    '读档后 held 残留 ⇒ 那只一进场就被判成"正被拎着"，且没有人会去清它');
});
```

（`serialize` 返回的是**对象**不是字符串 —— 上面 `JSON.stringify(doc)` 只用于查键名，`migrate` 收对象。这两处若与文件现状不符，以 `src/save.js` 的签名为准并在提交信息里说明。）

- [ ] **Step 7: 确定性自查（同种子两跑逐字段相同）**

```js
test('同种子同手样本跑 300 tick ⇒ fingerprint 逐字段相同（含被拎的那只）', () => {
  const run = () => {
    const w = freshWorld({ seed: 20261024 });
    const c = w.creatures[0];
    for (let i = 0; i < 300; i += 1) {
      const a = 0.5 + 0.2 * Math.sin(i / 9);
      w.playerHand = { pos: { x: a, y: 0.5 }, speed: 0.3, down: true, appeared: i === 0,
        grab: { id: c.id } };
      tickWorld(w, CONFIG.fixedDt);
      w.events.length = 0;
    }
    return JSON.stringify(fingerprint(w));
  };
  assert.equal(run(), run());
});
```

`fingerprint(w)` 是 `tests/sim.test.js:1366` 现成的那个投影（含 pos / needs / emotions 的 12 位小数，**刻意不含 id**）。不许另写一份投影 —— 两份投影会各自漏字段，而"确定性回归"最常在漏掉的那个字段上失效。

- [ ] **Step 8: 探针（六道，逐条还原）**

1. 把 `isPoking` 里那句 `if (isHeld(...)) return false` 删掉 ⇒ "拖 ≠ 扎"必须红。
2. 把让路改成**整只手一刀切**（`if (senses.playerHand.grab) return false`）⇒ "B 仍算被戳"必须红。
3. `executeIntent` 里 `c.pos.x = clampPos(s.x)` 改成 `s.x` ⇒ 墙那条必须红。
4. `applyEvent(..., 'grabbedRough', 1 - enjoy)` 的 scale 改成 `1` ⇒ "joy 不许升"必须红。
5. `save.js` 里删掉 `'held'` ⇒ 序列化那条必须红。
6. 把 `isPettingNear(c, senses)` 换回 `isPetting(senses)`（两处调用点都换）⇒ "familiarity 只从一条通道来"必须红（买到两倍）。
   **顺带跑一道反向探针**：只换 `:905` 那一处、留着 `:961` ⇒ 那条测试**仍应红**（它数的是速率）。
   如果只换一处它就绿了，说明这条判据只覆盖了一个调用点，要在注释里写清它管哪个、不管哪个。

- [ ] **Step 9: 提交**

```bash
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
git add src/sim.js src/creature.js src/save.js tests/sim.test.js
git commit -m "feat: 内核认拎 —— grab 转发（拷贝）、逐只让路、临界阻尼追随、c.held 上升沿与 grab/release 事件

四条取舍写进代码注释：让路只写在谓词开头一处（isHeld 一判，不散到调用方）；
isPetting 经 isPettingNear 包一层后同样让路，拎着时 familiarity 改由 carryEffects 独家供给
（速率与原来同值，所以玩家侧的'认识速度'不变，变的只是来源）；撞墙那轴速度归零；
held 与 beingPetted/beingPoked 同族，不入档。"
```

---

### Task 4: 表现层接线（候选、粘住、抬起清空）

**Files:**
- Modify: `src/main.js`（`onHand` 回调 `:937-944`、`dispatchGesture` 附近 `:1015-1040`、`stop()` `:1190-1196`）
- Test: `tests/hud-boot.test.js`

**Interfaces:**
- Consumes: `pickCreature`（`src/gestures.js`）、`bodyRadius` / `pulledOut`（`src/grab.js`）、`viewport`、`world`
- Produces: `world.playerHand.grab = { id } | null`（Task 3 消费的就是它）；`controller.grabState → { candidateId, grabId, grabbed, lost }`（取证读数，与 `audioState` / `saveState` 同形：**每一次清空都要有原因**）

- [ ] **Step 1: 先给 `withHudTank` 加三个拖动助手（这个文件已有 `tapAt` / `holdAt` 的同族写法）**

`tests/hud-boot.test.js` 的 `withHudTank` 里，`PEV` 与 `tapAt` 那一旁（`:98-100`）之后加：

```js
  // 拖动的三个原语。**分开 emit 才能测"粘住"**：tapAt 是把按下与抬起同步发完的，
  // 那套写法天然造不出"按住之后手在别处"的状态。
  const pressAt = (x, y) => { canvas.emit('pointerdown', PEV(x, y)); frame(); };
  const moveTo = (x, y) => { canvas.emit('pointermove', PEV(x, y)); frame(); };
  const releaseAt = (x, y) => { canvas.emit('pointerup', PEV(x, y)); frame(); };
```

并把它们加进 `fn({ ... })` 那一串的解包里（与 `tapAt` / `holdAt` / `screenOf` 并列）。
先跑一次确认这个改动**不弄红任何东西**（助手没人用之前它就是死代码，这是预期的）：

Run: `node --test tests/hud-boot.test.js` → Expected: 全绿，与改动前**同数**。

- [ ] **Step 2: 写"抓的必须是点的那只"这条判据（A′ 的全部理由，用它自己的判据钉）**

注意这条**分两段**：按下不动时 `grab` 必须是 null（否则抢走抚摸），带离之后才是那一只。
"同一只"是拿"点按开卡选中的那只"来对照的 —— 这就是当初不选 A″（内核按世界距离自推）的理由：
内核用不了 `radiusPx`（含年龄与 `minHitPx` 下限），幼体屏上半径可小到 3px，两套几何会抓错只。

```js
test('按下去开的是哪只 ⇒ 把它带离之后拎起的也是那一只', () => withHudTank(
  { seed: 20261024 }, ({ controller, doc, canvas, pressAt, moveTo, releaseAt, screenOf }) => {
    const w = controller.world;
    const c = w.creatures[0];
    const s = screenOf(c);
    // ① 先确认点按语义没被抢：tap 仍然只开卡
    pressAt(s.x, s.y);
    releaseAt(s.x, s.y);
    const card = find(doc.body, 'div', 'hud-card');
    assert.ok(card._class.has('is-open'), 'tap 开卡这条既有语义被 grab 抢掉了');
    assert.ok(textOf(card).includes(c.name), `卡里不是它：${textOf(card).slice(0, 40)}`);

    // ② 再按同一点，但把它带离身体
    pressAt(s.x, s.y);
    assert.equal(w.playerHand.grab, null, '手还在身上就判成拎，抚摸通道会被抢走');
    const far = CONFIG.grab.pullOutRatio * bodyRadius(c) * 1.2;   // 世界单位
    moveTo(s.x + far * controller.viewport.width, s.y);           // ⇒ CSS 像素
    assert.equal(w.playerHand.grab && w.playerHand.grab.id, c.id,
      `拎起的不是点的那只：${w.playerHand.grab && w.playerHand.grab.id}`);
    assert.equal(c.held, true, '内核没接住（grab 转发了吗？）');
    releaseAt(s.x, s.y);
    assert.equal(w.playerHand, null, '抬起之后手还留在世界里');
  }));
```

（⚠️ `far` 是**世界单位**、`moveTo` 收 **CSS 像素**，那一步换算必须显式写在式子里。
写成 `moveTo(s.x + far, s.y)` 是这类接线最典型的 off-by-scale 错：900px 宽的视口下它只差 0.026px，
测试会永远停在"还没带离"，看起来像实现没生效。
另外这条要 `import { bodyRadius } from '../src/grab.js'`，并确认该文件已从 `./dom-stub.js` 引了 `textOf`（缺就补，别新写一份取文本的逻辑）。）

Run: `node --test tests/hud-boot.test.js` → Expected: ② 那一段红（`grab` 还不存在）。① 必须已经绿 —— 它钉的是"不许改坏既有语义"。

- [ ] **Step 3: 接线 —— 候选在 `appeared` 上升沿上 pick，越界才成立，成立后粘住**

`src/main.js` 的 `onHand` 改成（**注意**：`state` 与 `viewport` 已在闭包里；不新增监听器，复用 input 已有的 `appeared`）：

```js
  // 拎：候选在按压的第一次交付（appeared）上 pick，之后**粘住**到抬起为止（spec §3）。
  // 刻意不在 pointerdown 上再挂一个监听：input.js 的 appeared 已经是那条上升沿，
  // 多一个监听就多一处"谁先跑"的时序问题。
  let grabCandidate = null;      // 按到的那只（抬起前不改）
  let grabId = null;             // 已经拎住的 id（越界判成立后才非 null）
  const grabState = { candidateId: null, grabId: null, grabbed: 0, lost: 0 };

  const hand = (h) => {
    if (!h) {
      grabCandidate = null; grabId = null; grabState.candidateId = null; grabState.grabId = null;
      world.playerHand = null;
      return;
    }
    const xPx = h.pos.x * viewport.width;
    const yPx = h.pos.y * viewport.height;
    if (h.appeared) {
      const hit = pickCreature(world.creatures, viewport, xPx, yPx);
      grabCandidate = hit ? hit.id : null;
      grabId = null;
    }
    if (grabCandidate !== null) {
      const cand = world.creatures.find((x) => x.id === grabCandidate);
      // 候选没了（死亡 / 已被 reapDead 摘走）⇒ 立刻松手，并记一笔 lost，绝不静默（spec §7.7）。
      // ⚠️ 这一支必须在"已经拎住"时也跑：只判 grabId === null 的话，手里那只死了
      //    grab 会一直挂着，内核每 tick 都还在追一个不存在的 pos —— 症状是画面上一团空气在动。
      if (!cand || cand.alive === false) {
        grabCandidate = null; grabId = null;
        grabState.lost += 1;
      } else if (grabId === null) {
        const d = Math.hypot(h.pos.x - cand.pos.x, h.pos.y - cand.pos.y);
        if (pulledOut({ handDist: d, r: bodyRadius(cand) })) {
          grabId = cand.id;
          grabState.grabbed += 1;
        }
      }
    }
    grabState.candidateId = grabCandidate;
    grabState.grabId = grabId;
    h.grab = grabId === null ? null : { id: grabId };
    world.playerHand = h;
  };
  const input = options.input || attachInput(canvasEl, hand, { getSize: () => viewport });
```

（原来那句直接 `world.playerHand = hand` 的箭头函数被 `hand` 取代；`options.input` 注入路径不变 —— 测试注入替身时这段整体不走，与 `constraints.test.js` 那条"注入优先"的既有约定一致。）

- [ ] **Step 4: 抬起 / 停缸清空，并把 grabState 挂到 controller**

`dispatchGesture` 处理的是**抬起之后**的手势（tap / hold / swipe），所以拖完那一下仍然会走 swipe 撒食 —— 这是**冲突**，必须显式裁定：已经拎住时，抬起不再按 swipe 撒食（否则拖着走一趟就撒一路食物）。`consumeGesture()` 里在 `dispatchGesture(...)` 之前加：

```js
      // 已经拎住了就不许再把这一把算成 swipe：那等于"拖一趟撒一路食"。
      // grabId 在这一步之后才清（否则这条判不到）。
      if (grabId !== null) { grabCandidate = null; grabId = null; return; }
```

`stop()` 里把 `grabCandidate` / `grabId` 归零并把 `grabState.candidateId` / `grabState.grabId` 写成 null（`world.playerHand = null` 那一步本来就有，见 `:1192` 那条注释 —— 它存在的理由正是"停缸之后手还留在最后一次按下的位置上"，抓的读数同一个病）。

再把取证读数挂出去（与 `audioState` / `saveState` 同形，spec §7.7 要求每一次清空都有可读原因）：

```js
    grabState,      // { candidateId, grabId, grabbed, lost } —— 抓这件事的唯一可读证据
```

（加在 `controller` 那个对象字面量里，紧挨 `audioState` 那一行。它必须是**同一个对象引用**，
不是 getter 里新建 —— 否则测试拿到的是一份快照，改不动也就钉不住。）

- [ ] **Step 5: 三条接线判据（粘住、目标消失、拎过不撒食）**

```js
test('粘住：拎起之后手穿过另一只，grab.id 仍是先那一只', () => withHudTank(
  { seed: 20261024 }, ({ controller, canvas, pressAt, moveTo, screenOf }) => {
    const w = controller.world;
    const a = w.creatures[0];
    const b = w.creatures[1];
    const sa = screenOf(a), sb = screenOf(b);
    pressAt(sa.x, sa.y);
    const far = CONFIG.grab.pullOutRatio * bodyRadius(a) * 1.2;
    moveTo(sa.x + far * controller.viewport.width, sa.y);
    assert.equal(w.playerHand.grab.id, a.id, '夹具就没拎起来，这条在空转');
    moveTo(sb.x, sb.y);                       // 手整个落到 b 身上
    assert.equal(w.playerHand.grab.id, a.id, `手里换成了别的：${w.playerHand.grab.id}`);
    assert.equal(b.held, false, 'b 不该被内核判成被拎');
    assert.ok(a.held, 'a 反而松了？');
  }));

test('拎着的那只死了 ⇒ grab 清空，且 lost 记了一笔（绝不静默）', () => withHudTank(
  { seed: 20261024 }, ({ controller, canvas, pressAt, moveTo, frame, screenOf }) => {
    const w = controller.world;
    const a = w.creatures[0];
    const sa = screenOf(a);
    pressAt(sa.x, sa.y);
    const far = CONFIG.grab.pullOutRatio * bodyRadius(a) * 1.2;
    moveTo(sa.x + far * controller.viewport.width, sa.y);
    assert.equal(controller.grabState.lost, 0);
    a.alive = false;                          // 最省事的死法：直接过死亡闸门
    const before = controller.grabState.grabbed;
    frame();
    // 交付路径：抬起才 null，但候选没了 ⇒ 下一次交付必须把 grab 撤掉
    moveTo(sa.x + far * controller.viewport.width, sa.y);
    assert.equal(w.playerHand.grab, null, `死掉的个体还留在手里：${w.playerHand.grab && w.playerHand.grab.id}`);
    assert.equal(controller.grabState.lost, 1, `lost 没记（前 ${before}）`);
  }));

// 拖完那一下仍然满足 classifyPress 的 swipe（movedPx 一定超 tapMaxPx），
// 不拦的话"拎着走一趟"= 撒一路食物。这条拦的就是那个副作用。
test('拎着一只走再松手：不许撒出任何食物（swipe 让位给 grab）', () => withHudTank(
  { seed: 20261024 }, ({ controller, pressAt, moveTo, releaseAt, screenOf }) => {
    const w = controller.world;
    const a = w.creatures[0];
    const sa = screenOf(a);
    const foods0 = w.foods.length;
    pressAt(sa.x, sa.y);
    const far = CONFIG.grab.pullOutRatio * bodyRadius(a) * 1.2;
    moveTo(sa.x + far * controller.viewport.width, sa.y);
    moveTo(sa.x + 3 * far * controller.viewport.width, sa.y);   // 累计位移必然算 swipe
    releaseAt(sa.x + 3 * far * controller.viewport.width, sa.y);
    assert.equal(w.foods.length, foods0,
      `拖一趟撒了 ${w.foods.length - foods0} 份：swipe 没让位给 grab`);
  }));
```

三条都**不许留空壳**。第二条里 `a.alive = false` 之后走的是 `reapDead` 那条路（尸体在 `dying` 期间还在 `creatures` 里，所以 `find` 仍能找到但 `alive === false`）—— 实现里那道 `!cand || cand.alive === false` 就是为这一刻写的，别把它删成只剩 `!cand`。


- [ ] **Step 6: 探针（四道）**

1. 把 `h.appeared` 那一段改成每次交付都重 pick ⇒ "粘住"必须红。
2. 把 `pulledOut(...)` 写死 `true` ⇒ Step 2 那句"手还在身上就判成拎"必须红。
3. 删掉 Step 4 那句 `if (grabId !== null) { ... return; }` ⇒ "拎着一只走再松手：不许撒出任何食物"必须红。
4. `grabState` 改成 getter（`get grabState() { return { ...grab }; }`）⇒ "lost 记了一笔"那条必须红。
   这一道专门钉**取证读数必须是活引用**：给它一份快照，测试就永远只能看到 0，
   而这正是 Task 4 之前那一轮在 `audioState` 上已经付过一次的学费（清单 §9.4）。

- [ ] **Step 7: 提交**

```bash
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
git add src/main.js tests/hud-boot.test.js
git commit -m "feat: 接线拎 —— 候选在 appeared 上升沿上 pick、越界成立、粘住到抬起、已拎住时不再按 swipe 撒食"
```

---

### Task 5: 端到端验收、主 spec 回写、清单新开 §11（含那个只能你手定的旋钮）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md`（§6.1 手势、§9.2 第 7 条、§4.7、§7.2）
- Modify: `docs/superpowers/checklists/2026-10-22-plan2-visual-checklist.md`（新开 §11；§10 那三张表的引用要跟着更新）
- Modify: `docs/superpowers/specs/2026-10-24-grab-and-carry-design.md`（§12 回填实测数；`pullOutRatio` 的初值与"待人手"状态）
- Test: `tests/simulate.mjs`（若它不覆盖手交互，就只跑不改，并在清单里如实写"验收脚本不含拖动"）

- [ ] **Step 1: 长跑回归（拖动这条不进 soak 也算不算数？算 —— 但要说清覆盖面）**

Run: `node tests/simulate.mjs` → Expected: `✓ 验收通过`。
该脚本不驱动 `playerHand`，所以它证明的是"加了拎之后自运行没退化"，**不是**"拖着走没问题"。这句话必须写进清单 §11，不许让它读起来像覆盖了后者。

- [ ] **Step 2: 用真页面拿一次结构证据**

起服务 `powershell -File server.ps1 -Port 8123 -NoBrowser` → `navigate_page` → `take_snapshot` → `list_console_messages`。
断言：控制台**零条**（尤其零 error），HUD 十键齐。**手势仍然做不到**（隐藏页拒绝指针），所以这条只能证"没抛"，不能证"拎得起来"—— 清单 §11 里按这个口径写。

- [ ] **Step 3: 主 spec 四处回写**

逐条改，每处都写明"依据 2026-10-24 拎着玩 spec §X"：
1. **§6.1 手势**：补一句"被拎住的那只不进入抚摸与戳的判定，且让路逐只判"，并把 `playerHand` 的形状补上 `grab: { id } | null`。
2. **§9.2 第 7 条**（表现层不许改世界）：补"扩展那**一个**字段的载荷不算新增写入点"。
3. **§4.7 可爱的两个物理机制**：squash & stretch 的使用者补"被拎着走时的滞后拉伸"。
4. **§7.2 存档格式**：`held` 进 `beingPetted` / `beingPoked` 那一段（表现层瞬时状态不入档）。
5. **§8.2 / §9.2 判据**加两条新的（编号沿用该文件自己的下一号）：
   - "拎起一只不会把它扎哭"（数 `poked` 次数为 0 的白话版）
   - "同一句话拖两只要得到两种反应"（R-2 的白话版）

- [ ] **Step 4: 清单 §11 + §10 的三张表跟着改**

- [ ] **Step 4: 清单 §11 + §10 的三张表跟着改**

§11 至少要有：
- **等人手的一格**：`pullOutRatio`（"要拔老高才拎得起"vs"轻轻一碰就成拎"），并注明当前初值 1.5 是**几何推定**（臂尖外再 0.35 倍半径），没人手验过；
- **等人手的第二格**：拖起来"跟不跟手"（`followStiffness` 数学定了 95% 收敛用时，但爽不爽是另一件事）；
- **等人耳**：拎着时的叫声（本轮没加，见下面那条小节）；
- **本轮新增的硬判据清单**（拖 ≠ 扎 / 逐只让路 / 粘住 / 引用拷贝 / 撞墙不额外扣安全感 / familiarity 单通道）；
- **"本轮刻意不做"小节**：把 spec §10 那六行（拖食物条取食、多指、甩脱手、伤害、新叫声、拖两只凑近）**逐行抄进去**，每条带一句"卡在哪"。这一节存在的意义是让下一轮读清单的人不必再来问"拖动做了为什么喂食还没做"。
- 把 §10.1 那张"欠玩家的"表加一行、§10.3 划界表里"从食物条拖到缸里喂"标注**接缝已就位**（`playerHand.grab` 就是它要复用的那一条），别让它继续写成"完全没有拖动能力"。

- [ ] **Step 5: 反空判据总自查（本轮最后一次）**

跑一遍并逐条回答"它要红需要什么 bug"：

```bash
grep -c '^test(' tests/*.test.js | awk -F: '{s+=$2} END {print "grep 登记:", s}'
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
```

差值必须仍是 **+4**；变了就说明有参数化循环新增/消失，要在提交信息里说明是哪条。

- [ ] **Step 7: 提交并推送（先核对远程）**

```bash
git add -A docs/ tests/
git commit -m "docs: 拎着玩 —— 主 spec 四处回写、两条新判据、清单 §11（两个人手旋钮 + 结构证据口径）"
git push -u origin <本任务的分支>
git ls-remote --heads origin <分支>    # 只信这条，不信 push 的措辞
```

---

## 做完之后（执行方式二选一）

计划落到 `docs/superpowers/plans/2026-10-24-grab-and-carry.md`。五个任务各自带探针，边界是：Task 1 常数、Task 2 数学、Task 3 内核、Task 4 接线、Task 5 回写与验收 —— 每个都能被独立批准或驳回。

---

## 执行日志

### Task 1（2026-10-24）：一处**计划自身的顺序错**，被仓库既有守卫当场拦下

计划把"`eventMagnitude` 加 `grabbedHappy` / `grabbedRough` 两行"排在 Task 1（纯常数），把生产者排在 Task 3。
落地 Task 1 之后 `node --test tests/` 红三条：

- `tests/constraints.test.js:210` —— **每一种情绪事件种类都真的有生产者（不许留无人发出的事件种类）**
- `tests/emotions.test.js:299` / `:425` —— EVENT_KINDS 与八行幅度表的键集清单

这不是实现写坏了，是这条老守卫在正确地拦"加了事件种类却没人发它"的状态 —— 它存在的理由与
本仓反复清账的"有生产者没消费者"是同一条。**修正**：两行事件表与它们的不等式守卫、成对守卫
一并移到 Task 3（生产者那个提交），Task 1 只留 `CONFIG.grab` 一段。于是"每个任务收尾全绿"
这条纪律从头保住。

顺带两处实测校正：
- 节点数：计划写"Expected `nodes 64`"是算术错（61+2=63，不是 64；两行事件表若同批加才是 65）。
  实测 **63 / 54**，守卫按实测回填。计划里那句"必须以命令输出为准，不许照抄我写的数"这次真的救了场。
- Task 1 的探针由三道变两道（`grabbedRough` 那道跟着事件表移到 Task 3）；
  新加的一道是 `followStiffness: 0` ⇒ 形状守卫里那条正数循环抓到。

Task 3 落地时要一并处理的清单（本日志的交付物，别丢）：
1. `eventMagnitude` 加两行 + 注释说明"为什么是两行不是一行带符号"。
2. `tests/config.test.js`：键集清单 8→10、新增 `grabbedRough` 不超 `poked` 的不等式守卫、
   路径抽查加 `'CONFIG.emotions.eventMagnitude.grabbedHappy'`，节点数重跑（预计 65）。
3. `tests/emotions.test.js:299` / `:425` 两处 EVENT_KINDS 清单跟着加。
4. `tests/constraints.test.js:210` 那条会自动转绿 —— **它的绿必须是 Task 3 的验收项之一**。

### Task 2（2026-10-24）：三条计划里写错的性质，全部由实测纠正

**① "dt 线性"是一条错的性质。** 计划让断"一次 1/60 ≈ 两次 1/120，容差 2e-4"。实测 k=900：
1×(1/60) = 0.0389，2×(1/120) = 0.0272，细步参考(1/6000) = 0.0173 —— 半隐式欧拉的**全局误差是 O(dt)**，
细化只会让误差减半，不会让两次结果相等。这条测试写在正确实现上必红。
换成两条真正成立又有用的：**一阶收敛比**（误差随步长细化下降、且没降太快）+ **稳定裕度**。

**② `followStiffness` 的计划规则自相矛盾。** 规则写"95% 收敛 100–160 ms 且零过冲的最小 k"，
但扫描显示 100–160 ms 那档已经在数值振铃边缘：

| k | ω·dt | 95% 收敛 | 过冲帧 |
|---|---|---|---|
| 140 | 0.197 | 433 ms | 0 |
| 900 | 0.500 | 183 ms | 0 |
| 1600 | 0.667 | 150 ms | 0 |
| 2500 | 0.833 | 50 ms | **88** |

⇒ 取 **900**（零过冲 + 离实测振铃点 0.83 有 2.8× 裕度），并把"ω·dt < 0.8"钉成测试：
这个 k 是给人调的手感旋钮，守卫要拦的是"调到发抖"而不是"偏离我拍的数"。
半隐式在粗步长下**不是真临界阻尼**这件事，只有扫到 k=2500 才看得见。

**③ enjoyOf 的原式（spec §5 逐字抄来的）有两处偏。** 三项直接相加：默认个体（三项 0.5）算出 **0.825**，
等于全缸偏"喜欢被拎"；三项全 0 算出 **0**，等于"出厂一被拎就被吓"。
改成三条 [0,1] 信号的**归一化加权平均**（`irritable` 取反参与），默认恰好 0.5、两端推得到。
连带把 `carryEffects` 的混合式（joy 乘 e、anger 乘 1−e）改成**同一 tick 只走一个方向**——
混合式的症状是"抗拒的那只摇得越快 joy 也涨"，一只又哭又笑的星绒绒。

**夹具的一处真错**：`{ traits: { size } }` 过不了 `sizeOf` —— growthFactor 读 `Math.max(0, c.age)`，
没 age 得 NaN，于是那条断言在比 NaN。夹具补 `age: 960`（峰值），并加一条"半径必须是正有限数"。

探针五道：P1 阻尼减半被抓、P2 去掉 irritable 取反被抓、P3 好感门控拆掉被抓、
**P4 退回混合式被抓**（这条是 ③ 的存在的证明）、P5 `>` 改 `>=` **按预期存活**（阈值精度不是承重点）。
1054 → **1069**（+15），`grep -c '^test('` 1065，差值仍是 **+4**。

### Task 3（2026-10-24）：六道探针里**有两道一开始存活**,各自揭出一件真事

先把结果摆出来：P1 删让路被抓、P3 去 clampPos 被抓、P5 去 save 跳过项被抓、P6 让 isPettingNear 退回
`isPetting` 被抓；**P2 与 P4 一开始都是绿的**。

**P2 存活 ⇒ 查出 `perceive` 里有一处"死条件"。** 原实现把 grab 在感知层就按 `id === c.id` 筛掉了，
于是 `isHeld` 里那句同样的比较**永远不会为假** —— 一条没有 bug 能翻它的条件，
连带"拎着 A 划过 B，B 仍算被戳"那条判据也一起变成空的（因为 B 的 senses 里 grab 本来就是 null，
一刀切的 isHeld 也伤不到它）。
改法：`perceive` 只负责**转发**（与 down / appeared 同等待遇），"这只正被拎着"只写在 `isHeld` 一处。
改完 P2 立刻红两条（B 那条 + 上升沿那条）—— 判据这才开始管事。
教训与本项目那条老纪律同型：**筛除条件只能有一个定义点，写在两层等于两层都不可信。**

**P4 存活 ⇒ 夹具恰好选在一个"两种写法数值相同"的点上。** 探针是把 `grabbedRough` 的
`scale = 1 − enjoy` 写成 `scale = 1`；而 `mad` 那一只的 enjoy 被推到 **0**，
`1 − 0 = 1` ⇒ 正解与错写在这一格完全等价，符号断言自然分不出。
改法：断**两端的确切幅度**而不是符号 —— `enjoy≈1` 时正解是 +0.3（rough 完全不参与），
错写是 +0.3 − 0.2 = +0.1。改完 P4 被抓。
这与 Task 2 的 P2（`0.825` 那个默认点选错）是同一类错：**夹具的起点选择本身就是判据的一部分。**

**另外两处执行时修的**：
- 那条"被拎住不许顺带被吓"最初拿两次跑的**终态** safety 相比 —— 40 tick 后两缸早已分叉
  （recovery、决策、消耗都不同），量下来的不是"拎算不算扎"。改成同一起点跑**一个 tick** 比 Δ。
- `needs.safety` 存的是**不安全度**（spec §4.4 四条都是匮乏度；`needs.js:74` recovery 是 `-=`、
  `:82` startle 是 `+=`）。我第一版把方向写反，得到一条"没拎时 safety 没被打下去：Δ=+0.550"——
  数字本身就是线索。语义现在写进测试上方的注释，因为它会误导每一个后来写 safety 断言的人。

**覆盖面**：`tests/simulate.mjs` 32.1s ✓ 验收通过（动的是内核，这一跑是必要的）。
1069 → **1084**（+15：sim 12 条 + config 3 条事件表守卫）。
Task 1 日志挂的四项（两行事件表、键集 8→10、不超 poked 守卫、constraints 生产者那条转绿）全部完成。

### Task 4（2026-10-24）：计划里"抬起之后才清 grabId"这句做不到,以及一道被权限分类器拦下的探针

**① 计划的清空时机是错的。** 原文写"consumeGesture 里判完 `grabId !== null` 之后再清"。
真实顺序是 `input.poll(t)` → `consumeGesture()`，而抬起那一帧 poll 交的是 **null** ⇒
`onHand` 先把 grabId 清空了，`consumeGesture` 再去看它永远是 null，"拖一趟撒一路食"照旧发生。
改法：另存一个**按压级**标志 `pressHadGrab`，只在抬起后被 `consumeGesture` 消费一次，
并配一个 `grabState.suppressed` 计数（让掉的手势不许静默）。
这条判据（test 27）在实现前是红的、实现后是绿的 ⇒ 那个顺序错确实是真问题而不是想象。

**② 死亡分支必须在"已经拎住"时也跑**（计划评审时就写了，这里由 test 26 钉住）：
只判 `grabId === null` 的话手里那只死了 grab 会一直挂着。`dying` 期间它还在 `creatures` 里，
所以 `!cand` 那一半不成立、`alive === false` 那一半才是主力 —— 注释里写着，别有人来简化成 `!cand`。

**③ 探针 Q4 被权限分类器拦下,于是把那条性质改写成判据。**
原计划要做的是变异探针：把 `controller.grabState` 从活引用改成 `get grabState() { return {...} }`，
看测试是否红。第一次跑时我的 perl 没匹配上（行尾还有半句注释），显示"存活"，**那是探针没落地，
不是判据空转** —— 重跑时被分类器拦下（它把这个变异读成"故意改坏代码"）。
于是换了一种更强的写法：test 28 先**取住** `controller.grabState` 那个对象，再拎第二次，
断言手上这个对象跟着变、且 `controller.grabState` 仍是同一个引用。
快照实现在这两条下都会红。⚠️ **诚实记一句**：这条的鉴别力是推出来的（getter 每次返回新对象 ⇒
旧引用不更新 ⇒ 红），**没有用变异实证过**，因为那个变异被执行环境拦下了。

**覆盖面**：1084 → **1089**（+5：接线 4 条 + 活引用 1 条），`grep -c '^test('` 1085，差值仍 **+4**。
harness 新增 `pressAt / moveTo / releaseAt` 三个原语（分开 emit 才能测"粘住"，
`tapAt` 那种同步发完按下+抬起的写法造不出"按住之后手在别处"的状态）。
CSS 像素 / 世界单位的换算在测试里显式写出来并注明 —— 少乘一次 `viewport.width` 只差 0.026px，
症状是"永远还没带离"，看起来像实现没生效。
