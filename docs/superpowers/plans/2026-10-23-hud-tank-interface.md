# 计划 3 · 缸的界面：读得出来、讲得进去（HUD Implementation Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家能**读出**每只个体是谁（信息卡 / 家谱行 / 肖像）、能**讲进**去（输入框 → `heard`，这是 `hear()` 在全仓的第一个生产者）、能**管**这个缸（暂停 / 倍速 / 静音 / 设置页 / 存档三钮 / 改名 / 投食）。

**Architecture:** 沿用计划 2 已验证的那条分层：**所有判断住在纯模块里，只有接线住在 `main.js`**。新增三个模块 —— `src/gestures.js`（手势分类与点选，纯）、`src/avatar.js`（状态 → 八张表情，纯）、`src/hud.js`（视图模型 + DOM 挂载；DOM 能力由**形参注入**，源码里不出现 `document`）。`main.js` 仍然是唯一碰浏览器全局的文件。

**Tech Stack:** 零 npm 依赖；ES Modules；Node 内置 `node:test` + `assert/strict`；Canvas 2D；Web Audio；PowerShell 5.1 `HttpListener`（`server.ps1`）。**不新增任何文件类型**（HTML/CSS/JS/PNG 都在 `server.ps1` 现有 MIME 表里）。

**Spec:** `docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md` —— 本计划从它论证，不是重新论证。执行时两份一起读。主要依据：§6.1（手势表）、§6.3（信息卡 / 家谱 / HUD 极简 / 名字）、§4.8.1（听进去的话）、§4.13.2.1 第 6 条（设置页是 API 档唯一的入口）、§5.4（静音按钮）、§7.3.1（存档落地的八条裁定）、§9.2（十一条验收）、§13.2 第 3、4 条（key 只存本机；**HUD 不许显示心情档**）。

---

## Global Constraints

每一条都是**机器可查**或**会被下一条测试打到**的，逐字抄自 spec 与现有代码：

1. **零依赖**：不许出现 `package.json` 的 `dependencies`/`devDependencies`，不许 `import` 任何裸包名。`tests/assets.test.js:41-47` 钉着这条。
2. **不许 `Math.random()`**：随机性一律走 `src/rng.js`。`tests/constraints.test.js:131-141` 扫全 `src/`。
3. **浏览器全局只许出现在 `src/main.js`**：`document` / `window` / `canvas` / `requestAnimationFrame` / `AudioContext` / `fetch` / `localStorage` 这七个名字（`\b` 词边界匹配，注释会被剥掉再扫）在其它 `src/` 模块里**一个都不许出现**。新模块靠**形参注入**拿浏览器能力 —— 与 `render.js`（`ctx`、`makeCanvas`）、`audio.js`（`graph`）、`input.js`（监听目标）同一条路子。见 `tests/constraints.test.js:47-65`、`:110-126`、`:143-149`。
4. **只有 `src/main.js` 可以发网络请求、可以读 `localStorage`**（spec §4.13.2 第 2 条 + §13.2 第 3 条）。API key 只许住在 `localStorage` 的 `tank.api.v1`，**永远不进 `save.json`**（那是明文、跨设备共享的一份档 —— 见 `main.js:146-153` 与 spec §7.3.1）。
5. **固定步长 `CONFIG.fixedDt = 1/60`，倍速只许靠子步进**（spec §3.4-1）。`CONFIG.timeScales = [0.5, 1, 2, 4]`（`config.js:39`）—— 本计划**不往这个数组里加 `0`**，暂停另走一条旗标（Task 5）。
6. **`world.playerHand` 是唯一允许表现层写的内核字段**（spec §3.4-4）。HUD 写进世界的东西只有三类，且每一类都必须走**已存在的内核入口**：`spawnFood(world, kind, pos)`（`sim.js:349`）、`hear(c, text, rng, nowSec, opts)`（`heard.js:89`）、`c.name` + `c.customName`（改名）。**除此之外 HUD 一帧都不许改世界**（Task 5 有一条行为测试钉它）。
7. **随机流分家**：`world.rng` 是模拟主流，`world.speechRng` 是文字层那条独立叉（`sim.js:168`）。HUD 引起的任何随机性**只许用 `speechRng`**。判据：`speechEnabled=false` 时世界必须逐字节不变（`tests/render-bubble.test.js:479` 已有这条，不许打红）。
8. **`CONFIG` 是深冻结的**（`config.js:815-821`），且 `tests/config.test.js:94-120` 精确钉住**顶层键名清单**与**对象/数组节点总数**。加一段就要同步那三个数（Task 3 给了算的命令，不是估的）。
9. **`CONFIG.emotions.eventMagnitude` 的每个键都必须在 `src/` 里有 `applyEvent('…')` 的生产者**（`tests/constraints.test.js:207-243`，`PENDING_PRODUCERS` 这张表**只许变小不许变大**）。⇒ 本计划**不新增事件种类**。改名、听词、投食都**不**发新事件；要留痕就走 HUD 自己的计数器。
10. **触控目标 ≥ 44px，适配 iOS `env(safe-area-inset-*)`**（spec §6.3）。`css/main.css:37-42` 那四个 `--safe-*` 变量已经声明好了，**目前没有任何消费者** —— 本计划就是那个消费者。
11. **不依赖 hover**（spec §6.1 明文：全部用 Pointer Events 统一触控与鼠标）。
12. **层序断言不许顺手打红**：`tests/render-fx.test.js` 钉着"foods 的 arc 早于 eggs 的 ellipse 早于生物体的 clip"。Task 7 的遮罩层**只许用矩形路径**（`moveTo`/`lineTo`/`closePath`/`fill`），不引入新的 `arc`/`ellipse`。
13. **测试数要两路对账**：`node --test tests/` 的 `# tests` 与 `grep -c '^test(' tests/*.test.js` 之和（参数化的 `for` 循环会让两者差几条，差多少要写在提交信息里）。起点：**921 / 921**（main = `036478a`，2026-10-23 实测）。

---

## 本计划**不做**的三件事（先划界，免得执行时顺手做）

| 项 | 为什么不做 | 去哪儿 |
|---|---|---|
| **F-1 光晕跨出 canvas 失效** | 清单 F-1 自己写了"属设计裁定，不是改个常数的事"：修法要么把水体搬进 canvas（**推翻 §3.4-5**），要么把光晕改成浅色描边（那是碎边的活）。这不是加一个功能，是改一条架构裁定，需要玩家先看真缸再拍。 | 计划 4，与裁定一起 |
| **§7.5 / §7.6 共享存档与多设备 409 仲裁** | 需要一个**公网可达的服务器**与一份**花钱/账号的决定**（GitHub Pages 是纯静态，存不了档）。本计划的存档全部走现有 `server.ps1` + `localStorage` 降级，**零新基础设施**。 | 计划 4，先出成本对照表 |
| **家谱树状图** | spec §6.3 要的是"树状图 + 手机全屏 / 桌面侧栏"。§9.2 第 2 条（"能看出两只之间的关系"）由信息卡的**关系四行**（母亲 / 孩子 / 同胞 / 同伴）满足 —— 树是同一批数据的另一种画法，它自己的布局问题（悬空起点、虚线同伴边、跨代折叠）值一个独立 Task 序列。 | 计划 4 |

> 这三条是**控制方裁定**（2026-10-23），理由写在这里而不是藏在聊天里。谁不同意，改的是这张表，不是某一行代码。

---

## 文件结构

| 文件 | 责任 | 新建/修改 |
|---|---|---|
| `src/gestures.js` | 点按 / 长按 / 划动的**分类**，与"这一点落在哪只身上"的**点选**。纯，零 import。 | 新建 |
| `src/avatar.js` | 状态 → 八张表情之一；表情路径表；**一次性预加载清单**。纯。 | 新建 |
| `src/hud.js` | 视图模型（读数 / 行 / 雷达 / 心形 / 年龄）+ DOM 挂载（`doc` 由形参注入）。 | 新建 |
| `src/input.js` | 补一样东西：按压**起始时刻**留得住（现在 `release()` 把它抹掉了）。 | 修改 |
| `src/main.js` | 接线：暂停旗标、HUD 每帧钩子、手势分发、`hear()` 的第一个生产者、设置页的六个口。 | 修改 |
| `src/config.js` | 新增 `CONFIG.hud` 与 `CONFIG.avatar` 两段。 | 修改 |
| `src/sim.js` | 同胞重名修复：`hatch` 现在恒传 index `0`。 | 修改 |
| `src/breeding.js` | 同上（`opts.nameFor(egg.genes, 0)` 那一行，`breeding.js:201`）。 | 修改 |
| `src/render.js` | F-5：卵之后再补一层沉积物遮罩。 | 修改 |
| `index.html` | HUD 容器（一个 `<div id="hud">`，**不放任何业务 DOM** —— 全部由 `hud.js` 建，这样 DOM 桩测得到）。 | 修改 |
| `css/main.css` | HUD 样式、淡入淡出、≥44px、safe-area。 | 修改 |
| `tests/gestures.test.js`、`tests/avatar.test.js`、`tests/hud.test.js`、`tests/hud-boot.test.js` | 四个新测试文件。前三个是纯层，最后一个是 boot 级接线（抄 `tests/save-boot.test.js:61-140` 那套桩）。 | 新建 |
| `tests/dom-stub.js` | **唯一**新增的非 `.test.js` 测试文件：DOM 节点桩。只给 HUD 用（现有四个渲染测试的 ctx 桩各抄一份的历史不去动它）。 | 新建 |

---

## Task 1: 手势层 —— 点按 / 长按 / 划动，与"点到了谁"

**Files:**
- Create: `src/gestures.js`
- Create: `tests/gestures.test.js`
- Modify: `src/input.js`（`release()` 不再抹掉按压起始时刻）
- Modify: `tests/input.test.js`（钉住那个新字段）

**Interfaces:**
- Consumes: `world.creatures`（`sim.js:110` 那个数组）、`viewport`（`{width, height, scale}`）、`render.js:135-142` 的 `screenX` / `screenY` / `radiusPx`。
- Produces:
  ```js
  export function classifyPress(p)   // p = {heldMs, movedPx, overCreature:boolean} → 'tap'|'hold'|'swipe'
  export function pickCreature(creatures, viewport, xPx, yPx, maxAgeSec)  // → creature | null
  ```
  Task 5 的 `main.js` 消费这两个；Task 4 的 HUD 不消费（HUD 的按钮走 DOM 事件）。

- [ ] **Step 1: 写失败的测试**

新建 `tests/gestures.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPress, pickCreature } from '../src/gestures.js';

const CRE = (id, x, y, size) => ({
  id, pos: { x, y }, size, stage: 'adult', alive: true, dying: 0,
  traits: { size: 0.5, hue: 330, sat: 0.6, lum: 0.7 },
});
const VP = { width: 900, height: 620, scale: 12 };

test('classifyPress：三档互斥且覆盖全域', () => {
  assert.equal(classifyPress({ heldMs: 90, movedPx: 3, overCreature: true }), 'tap');
  assert.equal(classifyPress({ heldMs: 900, movedPx: 3, overCreature: true }), 'hold');
  assert.equal(classifyPress({ heldMs: 90, movedPx: 80, overCreature: false }), 'swipe');
  // 划动优先于长按：从食物条拖出来的那一把**两样都满足**，它必须是 swipe，
  // 否则"拖拽投食"会在手指抬起前先弹出改名框。
  assert.equal(classifyPress({ heldMs: 900, movedPx: 220, overCreature: false }), 'swipe');
});

test('classifyPress：脏读数一律 swipe 之外取最保守的那档 = tap 以外的 hold', () => {
  // NaN / 负数 / undefined 都不许抛：手是浏览器给的，采样缺帧是常态。
  for (const bad of [NaN, -1, undefined, null, 'x', Infinity]) {
    const r = classifyPress({ heldMs: bad, movedPx: bad, overCreature: true });
    assert.ok(['tap', 'hold', 'swipe'].includes(r), `脏值 ${String(bad)} 给出了 ${r}`);
  }
});

test('pickCreature：命中半径有下限，8px 的幼体也点得到', () => {
  const small = CRE('s', 0.5, 0.5, 0.02);       // 世界单位直径 ⇒ 屏上远小于 22px
  const hit = pickCreature([small], VP, 450, 310, 600);
  assert.equal(hit && hit.id, 's', '小个体按真实半径点会点不中，必须夹到 minHitPx');
  assert.equal(pickCreature([small], VP, 450, 310 + 40, 600), null, '下限之外仍是下限');
});

test('pickCreature：重叠时取**屏上最近**的那只，不取数组里第一个', () => {
  const a = CRE('a', 0.5, 0.5, 0.3);
  const b = CRE('b', 0.52, 0.5, 0.3);
  const px = 0.52 * VP.width;
  assert.equal(pickCreature([a, b], VP, px, 310, 600).id, 'b');
  assert.equal(pickCreature([b, a], VP, px, 310, 600).id, 'b', '顺序不许影响结果');
});

test('pickCreature：溶散中与已死的个体不许被点到', () => {
  const dying = { ...CRE('d', 0.5, 0.5, 0.3), alive: false, dying: 0.4 };
  const gone = { ...CRE('g', 0.5, 0.5, 0.3), stage: 'dead', alive: false };
  assert.equal(pickCreature([dying, gone], VP, 450, 310, 600), null);
});

test('pickCreature：空数组 / 空 viewport / 非有限坐标一律 null，不抛', () => {
  assert.equal(pickCreature([], VP, 1, 1, 600), null);
  assert.equal(pickCreature([CRE('a', .5, .5, .3)], { width: 0, height: 0, scale: 0 }, 0, 0, 600), null);
  assert.equal(pickCreature([CRE('a', .5, .5, .3)], VP, NaN, 3, 600), null);
});
```

- [ ] **Step 2: 跑一遍，确认它失败**

Run: `node --test tests/gestures.test.js`
Expected: `Cannot find module .../src/gestures.js`（红）。

- [ ] **Step 3: 写实现**

新建 `src/gestures.js`：

```js
// 手势分类与点选。纯模块：不 import 任何东西（连 CONFIG 都不必 —— 阈值由调用方从
// CONFIG.hud 传进来，见 classifyPress 的默认值：那六个数是**兜底**，不是第二份真相）。
// 为什么单独立一个文件而不是塞进 input.js：input.js 有"零 import"的守卫
// （tests/input.test.js:198），而这里要点 radiusPx 与 screenX —— 那两个住在 render.js。
// 拆开比给 input.js 开一条依赖口子便宜。
//
// spec §6.1 那张表里"点按单只 → 信息卡 / 长按单只 → 取名 / 拖拽食物条 → 投食 /
// 长按缸内 → 撒食"这四条，判定全在这里；**效果**全在 main.js。

const DEFAULTS = { tapMaxMs: 350, tapMaxPx: 12, holdMinMs: 500, minHitPx: 22 };

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

export function classifyPress(p, opts) {
  const o = opts || DEFAULTS;
  const held = num(p && p.heldMs, -1);
  const moved = num(p && p.movedPx, -1);
  // swipe 先判：它赢的是**语义**而不是优先级 —— 拖拽投食那把一定同时满足 hold，
  // 反过来（先判 hold）会让"拖着食物经过一只个体"弹出改名框。
  if (moved > o.tapMaxPx) return 'swipe';
  if (held >= o.holdMinMs) return 'hold';
  // overCreature 只影响"这一把要对谁做"，不影响它是 tap 还是 hold ⇒ 这里不消费它。
  return 'tap';
}

export function pickCreature(creatures, viewport, xPx, yPx, opts) {
  const o = opts || DEFAULTS;
  if (!Array.isArray(creatures) || creatures.length === 0) return null;
  const w = num(viewport && viewport.width, 0), h = num(viewport && viewport.height, 0);
  const scale = num(viewport && viewport.scale, 0);
  const x = num(xPx, NaN), y = num(yPx, NaN);
  if (!(w > 0) || !(h > 0) || !(scale > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best = null, bestD = Infinity;
  for (const c of creatures) {
    if (!c || c.alive === false || c.stage === 'dead' || !c.pos) continue;
    const cx = num(c.pos.x, NaN) * w, cy = num(c.pos.y, NaN) * h;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const d = Math.hypot(x - cx, y - cy);
    // 半径 = 屏上半径，但**夹一个下限**：spec §6.3 要触控目标 ≥44px，而幼体屏上直径
    // 只有 16px（B20 量过 r 从 3.4 起）。不夹的话"点按单只开信息卡"对最小的那些等于没做。
    const r = Math.max(num(c.size, 0) * scale * 0.5, o.minHitPx);
    if (d <= r && d < bestD) { best = c; bestD = d; }
  }
  return best;
}
```

> ⚠️ 实现里 `c.size * scale * 0.5` 是 `radiusPx()`（`render.js:142`）的**近似**：真正的屏上半径还要乘 `renderSizeOf(c)` 的形变因子。这里**故意不复用** `radiusPx` —— 它要 `viewport` 之外的 `bodies` 状态，而点按用的是**静止半径**，形变中的身体本来就在动，用静止值反而稳。这一条差异要写在测试注释里（下一条 Step），不许悄悄糊过去。

- [ ] **Step 4: 补一条把"静止半径"这个取舍钉住的测试**

追加到 `tests/gestures.test.js`：

```js
test('点选用的是**静止**半径：正在压扁的那只不许因为 squash 变小而点不中', () => {
  // 与 render.js 的 radiusPx 的**有意**差异（见 gestures.js 顶部注释）。
  // 症状如果反过来（用形变半径），落地那一帧点它会没反应 —— 而那正是玩家最想摸它的时刻。
  const c = CRE('a', 0.5, 0.5, 0.3);
  c.body = { squashV: 0.4 };                 // 渲染层会读它；本模块不许读
  const edge = 0.5 * 900 + 0.3 * 12 * 0.5 * 0.98;   // 静止半径之内、形变半径之外
  assert.equal(pickCreature([c], VP, Math.round(edge), 310, {}).id, 'a');
});
```

- [ ] **Step 5: `input.js` 补按压起始时刻**

`src/input.js:231` 的 `release()` 现在把 `reading.t` 写成 `NO_TIME`（`:236`），于是"按了多久"在抬起之后**问不出来了** —— 而 `classifyPress` 要的就是这个数。改法：把 `press()` 记的起始时刻另存一个字段，`release()` 不动它。

在 `createHandTracker`（`input.js:102` 起）里，`press(t, ...)` 已经拿到 `t`；加：

```js
    downAt: NO_TIME,          // 本次按压的**起始**时刻。release() 不许清它 ——
                              // classifyPress 要的 heldMs 是"抬起时刻 − downAt"，
                              // 而抬起时刻就是下一次 poll 的 now。
```

`press()` 里与 `down = true` 同处加 `this.downAt = t;`；`release()` 里**只**清 `down` / `reading`，**不许**碰 `downAt`。`state()`（`input.js:247`）的返回里加上 `downAt`。

- [ ] **Step 6: 钉住它的测试**

追加到 `tests/input.test.js`（沿用该文件已有的 `makeTarget` / `PEV` 桩）：

```js
test('release() 之后 downAt 仍在：长按要能在抬起那一刻算出按了多久', () => {
  const tr = createHandTracker({ now: () => 0 });
  tr.press(1000, 0.5, 0.5, 900, 620);
  assert.equal(tr.state().downAt, 1000);
  tr.release(1600);
  assert.equal(tr.state().downAt, 1000, '抬起之后必须还读得到起始时刻');
  assert.equal(tr.state().down, false);
  tr.press(2000, 0.5, 0.5, 900, 620);
  assert.equal(tr.state().downAt, 2000, '下一次按压覆盖上一次，不许累加');
});
```

- [ ] **Step 7: 跑全量并检查浏览器全局守卫**

Run: `node --test tests/ && node -e "import('./tests/constraints.test.js')"`
Expected: 全绿；`gestures.js` 因为不含那七个名字，**自动**在纯度守卫覆盖范围内（`tests/constraints.test.js:72-82` 是全量扫 `src/`，新文件不需要登记）。

- [ ] **Step 8: 提交**

```bash
git add src/gestures.js src/input.js tests/gestures.test.js tests/input.test.js
git commit -m "feat: Task 1 手势层（点按/长按/划动 + 点选）—— input 补上 release 之后还在的 downAt"
```

---

## Task 2: 表情映射 —— 八张素材各有生产者

**Files:**
- Create: `src/avatar.js`
- Create: `tests/avatar.test.js`
- Modify: `src/config.js`（新增 `CONFIG.avatar`）
- Modify: `tests/config.test.js`（三个数 + 键名清单 + 遍历路径）

**Interfaces:**
- Consumes: `moodOf(emotions, needs, memory, ctx)`（`emotions.js:198`，返回 `MOODS` 五个字符串之一）、`dominant(emotions)`（`emotions.js:147`，返回六个键之一或 `null`）。
- Produces:
  ```js
  export function expressionFor(c, world)      // → 'calm'|'happy'|'sad'|'angry'|'bliss'|'sleepy'|'surprised'|'wink'
  export function avatarSrc(expr)              // → 'assets/star_puff_happy.png'
  export function preloadList()                // → string[]，八条，顺序固定
  ```
  Task 3 的 `cardFor` 消费 `expressionFor` / `avatarSrc`；Task 5 的 `main.js` 消费 `preloadList`（**开缸时一次**）。

- [ ] **Step 1: 写失败的测试**

新建 `tests/avatar.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expressionFor, avatarSrc, preloadList } from '../src/avatar.js';
import { CONFIG } from '../src/config.js';
import { MOODS } from '../src/emotions.js';
import { createEmotions } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const mk = (o = {}) => ({
  id: 'c', alive: true, dying: 0, mourn: 0, stage: 'adult',
  emotions: Object.assign(createEmotions(), o.emotions),
  needs: Object.assign(createNeeds(), o.needs),
  memory: (() => { const m = createMemory(); if (o.aff) remember(m, { id: 'PLAYER', familiarity: 1, affection: o.aff, kinship: 0, role: null }); return m; })(),
});

test('八张表情**各有生产者**（没有一张是死条目）', () => {
  const seen = new Set();
  const cases = [
    { emotions: { anger: 0.9 } },
    { emotions: { joy: 0.1, fear: 0.6 } },
    { emotions: { joy: 0.8, arousal: 0.4 }, needs: { hunger: 0, energy: 0, social: 0, safety: 0 }, aff: 0.9 },
    { emotions: { joy: 0.6 } },
    { emotions: { sleepy: 0.9 } },
    { emotions: { curiosity: 0.9 } },
    { emotions: { arousal: 0.9 } },
    { emotions: {} },
  ];
  for (const c of cases) seen.add(expressionFor(mk(c), { time: 0 }));
  assert.deepEqual([...seen].sort(), Object.keys(CONFIG.avatar.file).sort(),
    '这张表里有的表情，必须都造得出来；造得出来但表里没有的，也不许');
});

test('moodOf 的五个档与素材的八个名字**不同名**，映射表逐条钉住', () => {
  // 素材叫 angry / love / surprised，我们叫 anger / bliss / curiosity。
  // 这条测试存在的全部理由：'anger' 与 'angry' 差一个字母，靠肉眼对表一定会错。
  assert.equal(avatarSrc(expressionFor(mk({ emotions: { anger: 0.9 } }))).includes('angry'), true);
  assert.equal(avatarSrc(expressionFor(mk({ emotions: { joy: 0.8, arousal: 0.4 },
    needs: { hunger: 0, energy: 0, social: 0, safety: 0 }, aff: 0.9 }))).includes('love'), true);
  // MOODS 里**没有**的三档只能从 dominant(emotions) 来：
  for (const [k, want] of [['sleepy', 'sleepy'], ['curiosity', 'surprised'], ['arousal', 'wink']]) {
    const c = mk({ emotions: { [k]: 0.95 } });
    assert.equal(expressionFor(c, { time: 0 }), want, `${k} 应该出 ${want}`);
  }
});

test('calm 是唯一的兜底：情绪全 0 时不许出 wink/surprised', () => {
  assert.equal(expressionFor(mk({ emotions: {} }), { time: 0 }), 'calm');
});

test('八个文件真的在盘上（表里的名字打错一个字母就红）', () => {
  for (const src of preloadList()) {
    assert.ok(existsSync(join(HERE, '..', src)), `缺文件 ${src}`);
  }
});

test('preloadList 恰好八条、不重复、不含 character.png', () => {
  const l = preloadList();
  assert.equal(l.length, 8);
  assert.equal(new Set(l).size, 8);
  // ⚠️ star_puff_character.png 与 star_puff_wink.png **md5 完全相同**（D-1 量到的，
  // 见 .superpowers/sdd/progress.md 2026-10-23 那段）。加载它 = 白拉 315KB。
  assert.ok(!l.some((s) => s.includes('character')), '同一张图不许加载两次');
  assert.ok(!l.some((s) => s.includes('spritesheet')), '图集不进 HUD：单张 512 够用，切图反而要算 UV');
});

test('avatarSrc 只吐 assets/ 下的 .png，不吐绝对路径', () => {
  for (const e of Object.keys(CONFIG.avatar.file)) {
    const s = avatarSrc(e);
    assert.match(s, /^assets\/star_puff_[a-z]+\.png$/);
  }
  assert.equal(avatarSrc('没有这个表情'), avatarSrc(CONFIG.avatar.fallback), '未知表情名不许抛');
});

test('脏输入不许抛：缺 emotions / 缺 needs 字段的存档个体也要能出个表情', () => {
  for (const c of [null, undefined, {}, { emotions: null }, { emotions: {}, needs: null }]) {
    assert.ok(typeof expressionFor(c, { time: 0 }) === 'string');
  }
});
```

- [ ] **Step 2: 跑，确认红**

Run: `node --test tests/avatar.test.js` → `Cannot find module .../src/avatar.js`。

- [ ] **Step 3: 加 `CONFIG.avatar`**

`src/config.js`，紧跟在 `star:` 段之后（`config.js:406` 那条 `},` 之后）：

```js
  avatar: {
    // 计划 3 的 HUD 肖像层。**缸里仍然程序化**（D-1 的裁定），这套素材只给信息卡 /
    // 名字肖像用 —— 见 spec §4.7.3 开头那句与 progress.md 2026-10-23 段。
    dir: 'assets',
    // 键是**我们**的表情名，值是文件名。两边名字不同（我们 anger / bliss，素材 angry / love），
    // 所以这张表必须存在而不是靠字符串拼接。
    file: Object.freeze({
      calm: 'star_puff_calm.png', happy: 'star_puff_happy.png', sad: 'star_puff_sad.png',
      anger: 'star_puff_angry.png', bliss: 'star_puff_love.png',
      sleepy: 'star_puff_sleepy.png', curiosity: 'star_puff_surprised.png', arousal: 'star_puff_wink.png',
    }),
    fallback: 'calm',
  },
```

- [ ] **Step 4: 同步 `tests/config.test.js` 的三个数**

加两段 ⇒ 顶层键 51→53、节点 58→61（`avatar` 一个节点 + `avatar.file` 一个节点；`hud` 在 Task 3 里加，届时再 +1 → 62）。**不要估，跑：**

```bash
node -e "import('./src/config.js').then(({CONFIG})=>{let n=0;const w=x=>{if(x===null||typeof x!=='object')return;n++;for(const k of Object.keys(x))w(x[k])};w(CONFIG);console.log('nodes',n,'keys',Object.keys(CONFIG).length)})"
```

把 `tests/config.test.js:94` 的 `58` 改成跑出来的数、`:105` 的 `51` 改成跑出来的数、`:96-104` 那份排序清单里插入 `'avatar'`、`:106-120` 的遍历路径里加 `'CONFIG.avatar'` 与 `'CONFIG.avatar.file'`，并在 `:86-92` 那段历史注释里补一行（格式照现有那条 C-1 的写法：**为什么加、加了几、谁钉住它的行为**）。

Run: `node --test tests/config.test.js` → 绿。

- [ ] **Step 5: 写 `src/avatar.js`**

```js
// HUD 肖像层的映射。纯：只读 CONFIG 与两个已存在的派生函数，不碰 DOM、不碰 Image。
// 为什么要有这个模块而不是在 hud.js 里就地写 if 链：这张"我们的档 ↔ 素材的名字"
// 对照表是全项目**唯一**一处两边名字不同的地方（anger/angry、bliss/love），
// 错了不会抛，只会"生气的家伙显示一张笑脸"。它需要自己的测试文件。
import { CONFIG } from './config.js';
import { moodOf, dominant } from './emotions.js';

const A = CONFIG.avatar;
// 给 expressionFor 复用的 ctx 容器（spec §5.3：每帧每只都跑的东西不许分配）。
const CTX = { adversity: false };

export function expressionFor(c, world) {
  const emotions = (c && c.emotions) || null;
  const needs = (c && c.needs) || null;
  const memory = (c && c.memory) || null;
  if (!emotions || !needs) return A.fallback;      // 脏存档：缺字段的个体也要能画出来
  CTX.adversity = !!(c.mourn && c.mourn > 0);
  const mood = moodOf(emotions, needs, memory, CTX);
  if (mood !== 'calm') return mood;                 // 四档非 calm 直接就是表情名
  // calm 时再看**主导情绪**：这三档 moodOf 不区分（它只有五档），但素材有对应图。
  // 顺序 = dominant() 自己的顺序（emotions.js:147 已定，含并列时的 tie-break），本处不重排。
  const d = dominant(emotions);
  if (d === 'sleepy' || d === 'curiosity' || d === 'arousal') return d;
  return A.fallback;
}

export function avatarSrc(expr) {
  const name = Object.hasOwn(A.file, expr) ? expr : A.fallback;
  return `${A.dir}/${A.file[name]}`;
}

export function preloadList() {
  return Object.keys(A.file).map((k) => `${A.dir}/${A.file[k]}`);
}
```

> ⚠️ `expressionFor` 返回的 `mood` 值里 `anger` / `bliss` 恰好就是 `A.file` 的键 —— 这不是巧合，是**要求**：`tests/avatar.test.js` 第一条拿 `Object.keys(CONFIG.avatar.file)` 对全集，哪天 `MOODS` 加一档而表里没加，那条立刻红。这正是这张表想要的摩擦。

- [ ] **Step 6: 跑，确认绿**

Run: `node --test tests/avatar.test.js tests/config.test.js`

- [ ] **Step 7: 变异探针（三条，逐条跑完立刻还原）**

```bash
cp src/avatar.js /tmp/a.bak
# P1：把 anger→angry 那条映射改成拼接（模拟"以为两边同名"）
perl -0pi -e "s/anger: 'star_puff_angry.png'/anger: 'star_puff_anger.png'/" src/config.js
node --test tests/avatar.test.js 2>&1 | grep -E "缺文件|# fail"   # 期望：红（盘上没这个文件）
cp /tmp/a.bak /dev/null; git checkout src/config.js
# P2：fallback 改成 'wink'（平静时眨一只眼）
node --test tests/avatar.test.js   # 先手改 CONFIG.avatar.fallback='wink' ⇒ 'calm 是唯一兜底' 那条红
# P3：把 character.png 塞进 preloadList ⇒ "同一张图不许加载两次" 那条红
```
三条都必须红。任何一条"活下来"= 那条判据是空的，回去补强再提交。

- [ ] **Step 8: 提交**

```bash
git add src/avatar.js src/config.js tests/avatar.test.js tests/config.test.js
git commit -m "feat: Task 2 表情映射（八张各有生产者）—— anger/angry 与 bliss/love 两处不同名，靠表钉住"
```

---

## Task 3: HUD 视图模型（纯）—— 信息卡上有什么、没有什么

**Files:**
- Create: `src/hud.js`（本 Task 只写纯的那一半）
- Create: `tests/hud.test.js`
- Modify: `src/config.js`（`CONFIG.hud`）
- Modify: `tests/config.test.js`（再 +1 节点 → 62、+1 键 → 54）

**Interfaces:**
- Consumes: `affectionFor(memory, id)`（`memory.js:161`）、`kinshipOf(a, b, byId)`（`breeding.js:132`）、`world.creatures`、`worldStats(world)`（`sim.js:385`）、Task 2 的 `expressionFor` / `avatarSrc`、`stageForAge`（`creature.js:141`）、`sizeOf`（`creature.js:202`）。
- Produces:
  ```js
  export function readoutFor(world)                       // → {population, foods, eggs, timeLabel}
  export function formatAge(sec)                          // → '12秒' | '3分07秒' | '1时02分' | '12天03时'
  export function cardFor(c, world)                       // → {title, rows:Row[], radar:Point[], heart, words, portrait}
  export function relationRowsFor(c, world)               // → Row[]（母亲 / 孩子 / 同胞 / 同伴）
  export function radarFor(traits)                        // → [{axis:'大胆', v:0..1}, …] 九维
  export function heartFillFor(affection)                 // → 0..1（好感 −1..1 映射到空..满）
  ```
  `Row = {label:string, value:string}`；`Task 4` 的挂载层逐字消费这些。

- [ ] **Step 1: 写失败的测试（这一条是本 Task 的核心，因为它钉的是"不许出现什么"）**

新建 `tests/hud.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readoutFor, formatAge, cardFor, relationRowsFor, radarFor, heartFillFor } from '../src/hud.js';
import { createEmotions } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';
import { CONFIG } from '../src/config.js';

const VP = { width: 900, height: 620, scale: 12 };
const mk = (o = {}) => ({
  id: o.id || 'c1', name: o.name || '泡泡', customName: false, generation: o.generation || 2,
  age: o.age ?? 200, stage: o.stage || 'adult', alive: true, dying: 0, mourn: 0,
  pos: { x: 0.4, y: 0.5 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 },
  emotions: Object.assign(createEmotions(), o.emotions),
  needs: Object.assign(createNeeds(), o.needs),
  memory: (() => {
    const m = createMemory();
    remember(m, { id: 'PLAYER', familiarity: 1, affection: o.aff ?? 0, kinship: 0, role: null });
    for (const e of (o.known || [])) remember(m, e);
    return m;
  })(),
  traits: { hue: o.hue ?? 330, sat: .6, lum: .7, size: o.size ?? .5, glow: .6,
    pattern: 'rings', patternDensity: .4, wobble: .5, fluff: .5, eggTint: 'mint',
    personality: { bold: .2, clingy: .8, irritable: .1, gluttonous: .6, curious: .3,
      activity: .7, talk: .4, intellect: .9, broody: .5 } },
  genes: {}, thresholds: { heardCapacity: 6 },
  lineage: { mother: o.mother ?? null, father: null, mates: [], offspring: o.offspring || [] },
  heard: o.heard || [], eggBoost: o.eggBoost ?? 0, catchphrase: '喵喵',
  intent: null, broodT: 0, begIgnored: 0, beingPetted: false, beingPoked: false,
});
const W = (creatures, o = {}) => Object.assign({
  creatures, eggs: [], foods: [], time: 125, populationCap: 24,
}, o);

test('信息卡**永远不许替它陈述心情**（spec §13.2 第 4 条，行为级而不是 grep 级）', () => {
  // 两条判据叠起来才封得住：
  // ① 文字侧：五档心情的名字与"心情"这个词都不许出现在任何行里；
  const MOOD_WORDS = ['心情', '开心', '快乐', '幸福', '伤心', '愤怒', '生气', '安静',
    'anger', 'sad', 'bliss', 'happy', 'calm'];
  const a = mk({ emotions: { anger: 0.95 } });
  const b = mk({ emotions: { joy: 0.95 } });
  for (const c of [a, b]) {
    const card = cardFor(c, W([c]));
    const text = JSON.stringify(card.rows) + JSON.stringify(card.title);
    for (const w of MOOD_WORDS) assert.ok(!text.includes(w), `行里出现了"${w}"= 游戏在替它陈述心情`);
  }
  // ② 更强的那条：两只**只差情绪**的个体，rows 必须逐字节相同。
  //    这条封的是"哪天有人加一行『它看起来有点烦』" —— 那行的字里不含心情名词，
  //    判据 ① 抓不到，但它随情绪变 ⇒ 这条抓到。
  const p = mk({ id: 'x' }), q = mk({ id: 'x', emotions: { joy: 1, anger: 0.9, fear: 1 } });
  assert.deepEqual(cardFor(p, W([p])).rows, cardFor(q, W([q])).rows,
    'rows 随情绪变了：HUD 在陈述心情');
  // 而肖像**允许**随情绪变 —— 那是它的脸（spec §6.3 那条边界禁的是"字"，
  // 明文的正面通道是"它的身体与它自己选择的词"）。
  assert.notEqual(cardFor(p, W([p])).portrait, cardFor(q, W([q])).portrait);
});

test('cardFor 的行集合逐字取自 spec §6.3，一条不许少', () => {
  const c = mk();
  const labels = cardFor(c, W([c])).rows.map((r) => r.label);
  for (const want of ['名字', '年龄', '阶段', '体型', '母亲', '孩子', '蛋', '记住的词']) {
    assert.ok(labels.includes(want), `缺行"${want}"`);
  }
});

test('孤雌制：父母那行恒为「—」，但**母亲**有值时照写', () => {
  const born = mk({ mother: 'm1' });
  const rows = cardFor(born, W([born, mk({ id: 'm1', name: '团团' })])).rows;
  assert.equal(rows.find((r) => r.label === '母亲').value, '团团');
  const drifted = mk({ mother: null });
  assert.equal(cardFor(drifted, W([drifted])).rows.find((r) => r.label === '母亲').value, '—',
    '漂入的个体没有母亲节点（spec §6.3 家谱那段：图上是个悬空的起点，这是好事）');
  assert.ok(!JSON.stringify(cardFor(born, W([born])).rows).includes('父亲'),
    '孤雌制下"父亲"这一行**不存在**，不是"父亲：—"');
});

test('relationRowsFor：四行（母亲 / 孩子 / 同胞 / 同伴），每行都是名字而不是 id', () => {
  const mom = mk({ id: 'm1', name: '团团' });
  const sib = mk({ id: 's1', name: '软软', mother: 'm1' });
  const kid = mk({ id: 'k1', name: '朵朵' });
  const pal = mk({ id: 'p1', name: '蜜桃' });
  const me = mk({ id: 'me', name: '泡泡', mother: 'm1', offspring: ['k1'],
    known: [{ id: 'p1', familiarity: 1, affection: 0.7, kinship: 0, role: 'companion' }] });
  const world = W([mom, sib, kid, pal, me]);
  const rows = relationRowsFor(me, world);
  const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(by['母亲'], '团团');
  assert.equal(by['孩子'], '朵朵');
  assert.equal(by['同胞'], '软软', '同胞没有内核访问器，得扫 world（hud.js 里那条 find）');
  assert.equal(by['同伴'], '蜜桃');
  assert.ok(!JSON.stringify(rows).includes('"me"') && !JSON.stringify(rows).includes('"m1"'),
    '行里出现 id = 玩家看到一串没人能读的编号');
});

test('同胞扫描把自己排除，且没有同胞时是「—」而不是空串', () => {
  const solo = mk({ id: 'z', name: '独', mother: 'm1' });
  const rows = relationRowsFor(solo, W([solo]));
  assert.equal(rows.find((r) => r.label === '同胞').value, '—');
  const other = mk({ id: 'o', name: '另', mother: 'm1' });
  solo.lineage.mother = 'm1';
  assert.equal(relationRowsFor(solo, W([solo, other])).find((r) => r.label === '同胞').value, '另');
});

test('heartFillFor：好感 −1..1 线性映射到 0..1，clamp 在外层做完', () => {
  assert.equal(heartFillFor(1), 1);
  assert.equal(heartFillFor(-1), 0);
  assert.equal(heartFillFor(0), 0.5);
  assert.equal(heartFillFor(NaN), 0, '脏值取"空心的"，不是 NaN —— NaN 会让 CSS 宽度整个失效');
  assert.equal(heartFillFor(9), 1);
});

test('radarFor：九维性格一个不多一个不少，轴名是中文', () => {
  const pts = radarFor(mk().traits);
  assert.equal(pts.length, 9);
  assert.deepEqual(pts.map((p) => p.axis),
    ['大胆', '黏人', '暴躁', '贪吃', '好奇', '好动', '话多', '聪明', '恋巢']);
  for (const p of pts) assert.ok(p.v >= 0 && p.v <= 1);
});

test('formatAge：四段刻度，秒表一样宽的字', () => {
  assert.equal(formatAge(0), '0秒');
  assert.equal(formatAge(59), '59秒');
  assert.equal(formatAge(60), '1分00秒');
  assert.equal(formatAge(3600), '1时00分');
  assert.equal(formatAge(86400 * 3 + 3600 * 5), '3天05时');
  assert.equal(formatAge(NaN), '—');
});

test('readoutFor：左上那两个数 + 右上时间，且**不**读心情', () => {
  const w = W([mk(), mk({ id: 'b' })], { eggs: [{ id: 'e1' }, { id: 'e2' }], foods: [{ id: 'f1' }] });
  assert.deepEqual(readoutFor(w), { population: 2, foods: 1, eggs: 2, timeLabel: '2分05秒' });
});

test('记住的词：按 strength 排，最多 6 个，没有就「—」', () => {
  const none = cardFor(mk({ heard: [] }), W([mk()]));
  assert.equal(none.rows.find((r) => r.label === '记住的词').value, '—');
  const many = cardFor(mk({ heard: [...Array(9)].map((_, i) => ({
    token: `词${i}`, price: 0.5, boundMood: 'calm', boundNeed: 'hunger',
    heardAt: i, lastUsed: i, uses: i + 1,
  })) }), W([mk()]));
  const v = many.rows.find((r) => r.label === '记住的词').value;
  assert.equal(v.split('、').length, CONFIG.hud.cardWordsMax);
  assert.ok(v.includes('词8'), 'uses 最多的那个必须在前 6');
});

test('title：有名字用名字，缺字段的存档不许显示"undefined"', () => {
  assert.equal(cardFor(mk({ name: '泡泡·三' }), W([mk()])).title, '泡泡·三');
  assert.equal(cardFor(mk({ name: undefined }), W([mk()])).title, '未命名',
    'name 是 undefined 的个体（存档缺字段）不许显示 undefined');
  // ⚠️ 这里**不看** customName：卡上显示的就是它此刻叫什么，玩家取的名与生成的名同一个字。
  //    customName 的消费者在 Task 6（同窝去重时不许覆盖玩家取的名），不在显示层。
});

test('体型那一行写的是"多大"而不是 size 那个 0-1 的数', () => {
  const v = cardFor(mk({ size: 1 }), W([mk()])).rows.find((r) => r.label === '体型').value;
  assert.match(v, /小|中|大|特大/);
  assert.ok(!/\b0\.\d/.test(v), 'HUD 上不许出现原始 0-1 数值（spec §6.3"不写数字"那条的同族）');
});
```

- [ ] **Step 2: 跑，确认红**（`Cannot find module .../src/hud.js`）

- [ ] **Step 3: 加 `CONFIG.hud`**

`src/config.js`，紧跟 `avatar` 段之后：

```js
  hud: {
    // 手势阈值（Task 1 的 classifyPress 的默认值与这里**同源**：gestures.js 里那份
    // DEFAULTS 只是"没人传 opts 时"的兜底，真正的数从这里传）。
    tapMaxMs: 350, tapMaxPx: 12, holdMinMs: 500, minHitPx: 22,
    fadeIdleMs: 2600,          // spec §6.3"平时半透明淡出，交互时才浮现"
    minTouchPx: 44,            // spec §6.3 触控目标下限（css 里用 var 写死同一个数，见 Task 4）
    cardRefreshMs: 250,        // 信息卡读数节流：DOM 重排每帧做会在手机上掉帧
    cardWordsMax: 6,           // "记住的词"那一行最多几个（heardCap 最大是 12，一行放不下）
    tellMaxChars: 60,          // 输入框长度上限：超了截断，不报错、不弹窗
    nameMaxChars: 12,          // 改名上限（与 CONFIG.api.nameMaxChars 同数，但那是**模型**给的名的上限，两回事）
  },
```

同步 `tests/config.test.js`：跑 Task 2 Step 4 那行命令，把节点数与键数各 +1，清单里插 `'hud'`，遍历路径加 `'CONFIG.hud'`。

- [ ] **Step 4: 写 `src/hud.js` 的纯层**

```js
// HUD 的视图模型。**纯**：只读 world / creature，产出一堆字符串与数字，不碰 DOM。
// DOM 那半在本文件后半（mountHud），它拿 `doc` 是**形参注入**的 ——
// 于是本文件里不出现 document/window，tests/constraints.test.js 的纯度守卫照旧覆盖它。
//
// 这个文件存在的意义不是"把字排好看"，是**守住一条边界**：
// 信息卡是照料者的观察记录，不是它在对你说话（spec §6.3）。所以这里
// 没有任何一行字读 `moodOf` —— 唯一读它的是肖像（那是它的脸，属于身体那一侧）。
import { CONFIG } from './config.js';
import { affectionFor } from './memory.js';
import { expressionFor, avatarSrc } from './avatar.js';

const H = CONFIG.hud;
const DASH = '—';
const PERSONALITY_AXES = [
  ['bold', '大胆'], ['clingy', '黏人'], ['irritable', '暴躁'], ['gluttonous', '贪吃'],
  ['curious', '好奇'], ['activity', '好动'], ['talk', '话多'], ['intellect', '聪明'], ['broody', '恋巢'],
];

const num = (v) => (Number.isFinite(v) ? v : 0);
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

export function formatAge(sec) {
  if (!Number.isFinite(sec) || sec < 0) return DASH;
  const s = Math.floor(sec);
  if (s < 60) return `${s}秒`;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}天${pad2(Math.floor((s % 86400) / 3600))}时`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${pad2(s % 60)}秒`;
  return `${Math.floor(m / 60)}时${pad2(m % 60)}分`;
}

export function readoutFor(world) {
  const cs = (world && world.creatures) || [];
  let alive = 0;
  for (const c of cs) if (c && c.alive !== false && c.stage !== 'dead') alive += 1;
  return {
    population: alive,
    foods: ((world && world.foods) || []).length,
    eggs: ((world && world.eggs) || []).length,
    timeLabel: formatAge(num(world && world.time)),
  };
}

export function heartFillFor(affection) {
  const a = Number.isFinite(affection) ? affection : -1;   // 脏值 = 空心，不是半心（它没被认识过）
  const k = (a + 1) / 2;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

export function radarFor(traits) {
  const p = (traits && traits.personality) || {};
  return PERSONALITY_AXES.map(([k, axis]) => ({ axis, v: num(p[k]) }));
}

function byId(world, id) {
  if (!id || !world || !Array.isArray(world.creatures)) return null;
  for (const c of world.creatures) if (c && c.id === id) return c;
  return null;
}

export function relationRowsFor(c, world) {
  const label = (x) => (x && x.name) || DASH;
  const mother = label(byId(world, c && c.lineage && c.lineage.mother));
  const kids = ((c && c.lineage && c.lineage.offspring) || []).map((id) => label(byId(world, id)));
  // **同胞没有内核访问器**（research 确认：只有 lineage.mother 与 memory 里 role==='sibling'
  // 那半截，而后者只在同窝孵化那一刻写，跨代就没了）。所以扫 world —— 这是表现层读内核，
  // 不写内核，符合全局约束第 6 条。
  const my = c && c.lineage && c.lineage.mother;
  const sibs = (my && Array.isArray(world.creatures))
    ? world.creatures.filter((x) => x && x !== c && x.lineage && x.lineage.mother === my)
      .map((x) => label(x))
    : [];
  const pals = (((c && c.memory) || {}).entries || [])
    .filter((e) => e && e.role === 'companion').map((e) => label(byId(world, e.id)));
  const join = (list) => (list.length ? list.slice(0, H.cardWordsMax).join('、') : DASH);
  return [
    { label: '母亲', value: mother },
    { label: '孩子', value: join(kids) },
    { label: '同胞', value: join(sibs) },
    { label: '同伴', value: join(pals) },
  ];
}

const SIZE_TIERS = [[0.34, '小'], [0.67, '中'], [1.01, '大']];

export function cardFor(c, world) {
  const t = (c && c.traits) || {};
  const size = num(t.size);
  let tier = '特大';
  for (const [cut, name] of SIZE_TIERS) if (size < cut) { tier = name; break; }
  const heard = ((c && c.heard) || [])
    .slice()
    .sort((a, b) => (1 + num(b.uses)) - (1 + num(a.uses)))
    .slice(0, H.cardWordsMax)
    .map((e) => e.token);
  return {
    title: (c && c.name) || '未命名',
    rows: [
      { label: '名字', value: (c && c.name) || '未命名' },
      { label: '年龄', value: formatAge(num(c && c.age)) },
      { label: '阶段', value: stageLabel(c && c.stage) },
      { label: '体型', value: tier },
      ...relationRowsFor(c, world).slice(0, 1),        // 只要"母亲"那一条进 rows
      { label: '孩子', value: (((c && c.lineage) || {}).offspring || []).length + ' 只' },
      { label: '蛋', value: `${eggTintLabel(t.eggTint)} · ${eggSizeLabel(num(c && c.eggBoost))}` },
      { label: '记住的词', value: heard.length ? heard.join('、') : DASH },
    ],
    radar: radarFor(t),
    heart: heartFillFor(affectionFor(((c && c.memory) || { entries: [] }), 'PLAYER')),
    portrait: avatarSrc(expressionFor(c, world)),
  };
}

function stageLabel(stage) {
  return { hatchling: '幼体', juvenile: '亚成体', adult: '成体', elder: '老年', dead: '已故' }[stage] || DASH;
}
function eggTintLabel(tint) { return typeof tint === 'string' && tint ? tint : DASH; }
function eggSizeLabel(boost) {
  if (!boost) return '蛋大小未知';
  return boost > 0.12 ? '大蛋孵的' : boost < -0.12 ? '小蛋孵的' : '中等蛋孵的';
}
```

- [ ] **Step 5: 跑，确认绿**

Run: `node --test tests/hud.test.js` → 全绿。跑完之后 `grep -n "^const \|^function " src/hud.js` 逐个核对**每个模块级函数都有人调**：没有生产者的常量/函数一律删（同 D-1 删 `tipPower` 那条裁定）。

- [ ] **Step 6: 变异探针**

| 探针 | 做法 | 必须红的那条 |
|---|---|---|
| M1 | 在 `cardFor` 的 rows 里加一行 `{label:'状态', value: expressionFor(c, world)}` | 「行为级」那条（rows 随情绪变） |
| M2 | 把 `heartFillFor(NaN)` 的分支删掉 | `heartFillFor：…NaN` 那条 |
| M3 | `relationRowsFor` 的同胞过滤里去掉 `x !== c` | 「同胞扫描把自己排除」那条 |
| M4 | `formatAge` 的 `pad2` 换成裸数字 | `formatAge` 那条（`1分0秒` ≠ `1分00秒`） |
| M5 | 把 `rows` 里"父亲"那行加回去（写成 `value: '—'`） | 「孤雌制：…不许出现父亲」那条 |

五道全红之后还原，跑 `node --test tests/` 确认全量绿。

- [ ] **Step 7: 提交**

```bash
git add src/hud.js src/config.js tests/hud.test.js tests/config.test.js
git commit -m "feat: Task 3 HUD 视图模型（纯）—— 信息卡不许随情绪变，这条用行为钉死"
```

---

## Task 4: HUD 的 DOM 那一半 —— 注入 `doc`，不是 `document`

**Files:**
- Create: `src/hud.js`（追加 `mountHud` 与它的子部件）
- Create: `tests/dom-stub.js`
- Create: `tests/hud.test.js`（追加 DOM 那批）
- Modify: `index.html`（加 `<div id="hud-root"></div>`）
- Modify: `css/main.css`（HUD 样式）

**Interfaces:**
- Consumes: Task 3 的全部视图模型；`doc`（形参注入，形状见 Step 1 的桩）。
- Produces:
  ```js
  export function mountHud(doc, deps)
  // deps = { controller, world, audioState, onFeed(kind), onTell(creature, text),
  //          onRename(creature, nameOrNull), onScatter(xPx, yPx), onSpeech(boolean) }
  //   → { frame(nowMs, world), setCard(creature, world, opts?), setSettingsOpen(b),
  //       pressScale(s), pressPause(), pressMute(), pressFeed(kind), pressClear(),
  //       tell(text?), tellValue(), rename(creature, name), setEndpoint/setModel/setKey/saveSettings,
  //       pulse(nowMs), destroy(), root, state }
  ```
  Task 5 的 `main.js` 是唯一调用者。**deps 里只有这七个 `on*`** —— 加一个没人调的钩子就是下一个 `tipPower`。

- [ ] **Step 1: 先写 DOM 桩（测试的地基，也是本 Task 的接口定义）**

新建 `tests/dom-stub.js`：

```js
// 够小的 DOM 节点桩。**故意不做**的：布局、样式计算、事件冒泡、选择器引擎。
// 有了那些就变成"在 Node 里重写一个浏览器"，而本文件要测的是
// "HUD 建了哪些节点、写了什么字、按下去调了谁的什么"。
// 现有四个渲染测试各抄一份 ctx 桩的历史不在本文件的账上（那是渲染层的），
// 但 HUD 的桩有 200 行，值得单独一个文件。
export function makeNode(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], parent: null, attrs: {},
    style: {}, dataset: {}, _text: '', _class: new Set(), listeners: {},
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    removeChild(child) { const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); child.parent = null; return child; },
    remove() { if (node.parent) node.parent.removeChild(node); },
    addEventListener(type, fn) { (node.listeners[type] || (node.listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) { const a = node.listeners[type] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(node.attrs, k) ? node.attrs[k] : null; },
    focus() { doc.__focused = node; },
    blur() { if (doc.__focused === node) doc.__focused = null; },
    get value() { return node._value || ''; },
    set value(v) { node._value = v; },
    get className() { return [...node._class].join(' '); },
    set className(v) { node._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: null,
    get textContent() { return node._text; },
    set textContent(v) { node._text = String(v); node.children.length = 0; },
  };
  node.classList = {
    add: (...c) => c.forEach((x) => node._class.add(x)),
    remove: (...c) => c.forEach((x) => node._class.delete(x)),
    toggle: (c, on) => { const want = on === undefined ? !node._class.has(c) : !!on; if (want) node._class.add(c); else node._class.delete(c); return want; },
    contains: (c) => node._class.has(c),
  };
  return node;
}

export function makeDoc() {
  const doc = {
    created: [], body: null, __focused: null, images: [],
    createElement(tag) { const n = makeNode(tag, doc); doc.created.push(n.tagName); return n; },
    createTextNode(t) { return { textNode: true, _text: String(t) }; },
    getElementById(id) { return doc.__byId[id] || null; },
    addEventListener() {}, removeEventListener() {},
    __byId: {},
  };
  doc.body = makeNode('body', doc);
  return doc;
}

/** 在树里找第一个 tagName 且 class 含 want 的节点。 */
export function find(node, tagName, want) {
  for (const c of node.children || []) {
    if (c.tagName === String(tagName).toUpperCase() && (!want || c._class.has(want))) return c;
    const deep = find(c, tagName, want);
    if (deep) return deep;
  }
  return null;
}
export function findAll(node, tagName, want, out = []) {
  for (const c of node.children || []) {
    if (c.tagName === String(tagName).toUpperCase() && (!want || c._class.has(want))) out.push(c);
    findAll(c, tagName, want, out);
  }
  return out;
}
export function textOf(node) {
  let s = node._text || '';
  for (const c of node.children || []) s += textOf(c);
  return s;
}
export function click(node) { for (const fn of (node.listeners.click || [])) fn({ preventDefault() {}, target: node }); }
```

- [ ] **Step 2: 写 DOM 那批失败的测试**

追加到 `tests/hud.test.js`：

```js
import { makeDoc, find, findAll, textOf, click } from './dom-stub.js';
import { mountHud } from '../src/hud.js';

const mount = (over = {}) => {
  const doc = makeDoc();
  const calls = [];
  const deps = Object.assign({
    controller: { getTimeScale: () => 1, setTimeScale: (s) => calls.push(['scale', s]),
      getMuted: () => true, setMuted: (v) => calls.push(['mute', v]),
      getPaused: () => false, setPaused: (v) => calls.push(['pause', v]),
      saveState: { source: 'fresh', bytes: 0 }, saveNow: () => calls.push(['saveNow']),
      clearSave: () => calls.push(['clearSave']), getApiConfig: () => ({ enabled: false, endpoint: '', model: '', hasKey: false }),
      setApiConfig: (p) => calls.push(['api', p]) },
    world: W([mk()]),
    onTell: (c, text) => calls.push(['tell', c && c.id, text]),
    onRename: (c, name) => calls.push(['rename', c && c.id, name]),
    onScatter: (x, y) => calls.push(['scatter', x, y]),
    onFeed: (kind) => calls.push(['feed', kind]),
    onSpeech: (v) => calls.push(['speech', v]),
  }, over);
  const hud = mountHud(doc, deps);
  return { doc, hud, calls, root: doc.body };
};

test('挂载建出 spec §6.3 要的四块：左上读数 / 右上控件 / 底部食物条 / 信息卡（初始隐藏）', () => {
  const { hud, root } = mount();
  assert.ok(find(root, 'div', 'hud-readout'), '左上');
  assert.ok(find(root, 'div', 'hud-controls'), '右上');
  assert.ok(find(root, 'div', 'hud-foodbar'), '底部');
  assert.ok(find(root, 'div', 'hud-card'), '信息卡容器（空态也要在，隐藏由 class 管）');
  assert.equal(hud.state.card, null, '刚挂上时没有打开任何一只');
});

test('所有按钮 ≥44px：尺寸写在 class 上，不写在 style 字面量里（这样 css 能统一改）', () => {
  const { root } = mount();
  const btns = findAll(root, 'button');
  assert.ok(btns.length >= 6, `控件太少了：${btns.length}`);
  for (const b of btns) assert.ok(b._class.has('hud-touch'), `"${b.textContent}" 没打 hud-touch`);
});

test('倍速四档逐个按下去：调的是 controller.setTimeScale，且值来自 CONFIG.timeScales', () => {
  const { hud, calls } = mount();
  for (const s of [0.5, 1, 2, 4]) { hud.pressScale(s); assert.ok(calls.some((c) => c[0] === 'scale' && c[1] === s)); }
  assert.throws(() => hud.pressScale(3), /不在/, '随手写个 3 会把子步进数打爆（main.js 那条守卫的同一判据）');
});

test('暂停不是 stop：它调 setPaused，且**不**碰 stop', () => {
  const { root, calls } = mount();
  const btn = find(root, 'button', 'hud-pause');
  click(btn);
  assert.deepEqual(calls[0], ['pause', true]);
  assert.ok(!calls.some((c) => c[0] === 'stop'), 'stop() 会 detach 输入、关音频、摘监听 —— 那是关缸不是暂停');
});

test('静音按钮在音频降级时**隐藏**（spec §5.4 / §5.4.1 第 8 条）', () => {
  const { root } = mount({ controller: Object.assign({}, { audioState: { tried: true, ok: false, reason: 'no-audio' } }) });
  // ↑ 见 Step 5 的 deps.audioState：降级时那个按钮根本不该出现在树里
  assert.equal(find(root, 'button', 'hud-mute'), null, '被阻止了还挂一个按了没反应的按钮 = 骗人');
});

test('信息卡：打开一只之后四块内容都在，且没有一行替它陈述心情', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z', name: '糯糯', emotions: { anger: 1 } });
  hud.setCard(c, W([c]));
  const card = find(root, 'div', 'hud-card');
  assert.ok(textOf(card).includes('糯糯'));
  assert.ok(card._class.has('is-open'));
  assert.ok(!/心情|开心|愤怒|生气/.test(textOf(card)), textOf(card));
});

test('雷达图画成 SVG 折线：九个点，闭合', () => {
  const { hud, root } = mount();
  hud.setCard(mk(), W([mk()]));
  const svg = find(root, 'svg', 'hud-radar');
  assert.ok(svg, '雷达图必须是 svg（canvas 里画 HUD 会把 HUD 和缸耦死）');
  const poly = svg.children.find((n) => n.tagName === 'POLYGON');
  assert.equal(poly.attrs.points.split(' ').length, 9);
});

test('心形用填充度表示好感，卡里**没有**那个 0-1 的数（spec §6.3）', () => {
  const { hud, root } = mount();
  const c = mk({ aff: 0.62 });
  hud.setCard(c, W([c]));
  const heart = find(root, 'div', 'hud-heart');
  assert.equal(heart.style.getPropertyValue ? heart.style['--heart-fill'], String(heartFillFor(0.62)), '填充度走 CSS 变量');
  assert.ok(!textOf(root).includes('0.62'), '好感度数字漏到卡上了');
});

test('讲给它听：输入一行 → 调 onTell，且**清空输入框**（不清的话下一次是拼接）', () => {
  const { hud, calls } = mount();
  hud.setCard(mk({ id: 'z' }), W([mk({ id: 'z' })]));
  hud.tell('宝宝今天也要好好吃饭哦');
  assert.ok(calls.some((c) => c[0] === 'tell' && c[1] === 'z' && c[2].includes('好好吃饭')));
  assert.equal(hud.tellValue(), '', '输入框必须清空');
});

test('超长输入被截断而不是报错，且**计数**（HUD 自己的计数器，不是世界的事件）', () => {
  const { hud, calls } = mount();
  hud.setCard(mk({ id: 'z' }), W([mk({ id: 'z' })]));
  hud.tell('啊'.repeat(400));
  assert.equal(hud.state.tellTruncated, 1);
  assert.ok(calls.at(-1)[2].length <= CONFIG.hud.tellMaxChars);
});

test('改名：customName 置真的活由 main 做，HUD 只负责把名字交出去并截断', () => {
  const { hud, calls } = mount();
  hud.rename(mk({ id: 'z' }), '这是一个长得离谱的名字要截断');
  const [, id, name] = calls.at(-1);
  assert.equal(id, 'z');
  assert.equal(name.length, CONFIG.hud.nameMaxChars);
});

test('空名字 / 全空格的名字不改：交出去的是 null，main 那边据此不动世界', () => {
  const { hud, calls } = mount();
  hud.rename(mk({ id: 'z' }), '   ');
  assert.equal(calls.at(-1)[2], null);
});

test('食物条三个键：按下调 onFeed(kind)，kind 逐字取自 CONFIG.food 的键', () => {
  const { hud, calls } = mount();
  const keys = findAll(hud.root, 'button', 'hud-feed');
  // 三种食物（spec §6.2：光藻 algae / 蜜珠 nectar / 冰晶 crystal）。
  // 名单从 CONFIG 取而不是在这里写三个字符串：哪天加第四种，这条要跟着长，而不是悄悄少一个键。
  assert.deepEqual(keys.map((b) => b.dataset.kind).sort(), Object.keys(CONFIG.food).sort());
  click(keys[1]);
  assert.equal(calls.at(-1)[0], 'feed');
  assert.ok(Object.keys(CONFIG.food).includes(calls.at(-1)[1]), calls.at(-1)[1]);
});

test('淡出：pulse(idle) 之后 root 打上 is-dim；任何交互立刻摘掉', () => {
  const { hud, root } = mount();
  for (let t = 0; t < CONFIG.hud.fadeIdleMs + 100; t += 100) hud.frame(t);
  assert.ok(root._class.has('is-dim'), '闲了这么久还不淡出');
  hud.pulse(999999);
  assert.ok(!root._class.has('is-dim'), '一有交互就必须立刻亮回来');
});

test('frame 不写世界：跑 200 帧之后 world 逐字节不变（全局约束第 6 条）', () => {
  const { hud } = mount();
  const w = W([mk(), mk({ id: 'b' })]);
  const before = JSON.stringify(w);
  for (let i = 0; i < 200; i++) hud.frame(i * 16.7, w);
  assert.equal(JSON.stringify(w), before, 'HUD 每帧动过世界了');
});

test('destroy() 把节点从 body 上摘下来，且不留监听器在树里', () => {
  const { doc, hud } = mount();
  hud.destroy();
  assert.equal(doc.body.children.length, 0);
});
```

- [ ] **Step 3: 跑，确认红**（`mountHud is not a function`）

- [ ] **Step 4: 写 `mountHud`**

追加到 `src/hud.js`。要点全部写进注释，代码保持直白：

```js
// ---- DOM 那一半。`doc` 是**形参**（与 render.js 的 ctx、audio.js 的 graph 同一条路子），
// 所以本文件仍然不含那七个浏览器全局名，仍然在纯度守卫的覆盖范围内。
const TOUCH_CLASS = 'hud-touch';

export function mountHud(doc, deps) {
  const c = doc.createElement('div');
  c.className = 'hud';
  doc.body.appendChild(c);

  const readout = el(doc, 'div', 'hud-readout');
  const controls = el(doc, 'div', 'hud-controls');
  const foodbar = el(doc, 'div', 'hud-foodbar');
  const card = el(doc, 'div', 'hud-card');
  c.append ? c.append(readout, controls, foodbar, card) : [readout, controls, foodbar, card].forEach((n) => c.appendChild(n));

  // 右上：倍速四档 + 暂停 + 静音。**音频被浏览器拒绝时静音键不出现**（spec §5.4.1 第 8 条）：
  // 挂一个按了永远没反应的按钮不是"降级"，是骗人。
  const scales = (CONFIG.timeScales || []).map((s) => {
    const b = button(doc, `${s}×`, 'hud-scale');
    b.addEventListener('click', () => api.pressScale(s));
    return { s, node: b };
  });
  const pauseBtn = button(doc, '暂停', 'hud-pause');
  pauseBtn.addEventListener('click', () => api.pressPause());
  const muteBtn = deps.audioState && deps.audioState.ok === false ? null : button(doc, '静音', 'hud-mute');
  if (muteBtn) muteBtn.addEventListener('click', () => api.pressMute());

  for (const x of scales) controls.appendChild(x.node);
  controls.appendChild(pauseBtn);
  if (muteBtn) controls.appendChild(muteBtn);
  const gear = button(doc, '设置', 'hud-gear');
  gear.addEventListener('click', () => api.setSettingsOpen(!state.settingsOpen));
  controls.appendChild(gear);

  // 底部食物条：键 = 三种食物（spec §6.2，名单就是 CONFIG.food 的三个键）。
  // 点按投在缸中央，拖拽投在落点（Task 5 的 swipe 分支）。
  for (const kind of Object.keys(CONFIG.food)) {
    const b = button(doc, FOOD_LABEL[kind], 'hud-feed');
    b.dataset.kind = kind;
    b.addEventListener('click', () => api.pressFeed(kind));   // api 在后面才拼好：闭包晚绑定，与 tellBtn 同一条理由
    foodbar.appendChild(b);
  }

  const state = { card: null, settingsOpen: false, lastInputAt: 0, tellTruncated: 0,
    renameTruncated: 0, feeds: 0, tells: 0, renames: 0, rejectedNames: 0, frames: 0, cardRenders: 0 };

  // 信息卡里那两块输入：改名与"讲给它听"。它们是 `customName` 与 `hear()` 在全仓的**第一个**入口。
  const nameInput = doc.createElement('input');
  nameInput.className = 'hud-name';
  nameInput.setAttribute('type', 'text');
  nameInput.setAttribute('maxlength', String(CONFIG.hud.nameMaxChars));
  nameInput.setAttribute('aria-label', '给它取名');
  const nameBtn = button(doc, '改名', 'hud-name-go');
  nameBtn.addEventListener('click', () => api.rename(state.card, nameInput.value));

  const tellInput = doc.createElement('input');
  tellInput.className = 'hud-tell';
  tellInput.setAttribute('type', 'text');
  tellInput.setAttribute('enterkeyhint', 'send');
  tellInput.setAttribute('maxlength', String(CONFIG.hud.tellMaxChars));
  tellInput.setAttribute('aria-label', '讲给它听');
  const tellBtn = button(doc, '说', 'hud-tell-go');
  tellBtn.addEventListener('click', () => api.tell());

  const api = {
    root: c, state,
    pressScale(s) {
      if (!CONFIG.timeScales.includes(s)) throw new Error(`setTimeScale: ${s} 不在 [${CONFIG.timeScales.join(', ')}] 里`);
      deps.controller.setTimeScale(s); pulse();
    },
    pressPause() { deps.controller.setPaused(!deps.controller.getPaused()); pulse(); },
    pressMute() { deps.controller.setMuted(!deps.controller.getMuted()); pulse(); },
    pressFeed(kind) {
      // 名单外的一律抛：这是**编程错误**而不是用户输入，静默吞掉只会让"投食没反应"变成一条查不出来的 bug。
      if (!Object.hasOwn(CONFIG.food, kind)) throw new Error(`pressFeed: 没有这种食物 "${kind}"`);
      state.feeds += 1;
      deps.onFeed && deps.onFeed(kind); pulse();
    },
    tell(text) {
      const raw = text === undefined ? tellInput.value : String(text);
      if (!raw) return;
      const cut = raw.length > CONFIG.hud.tellMaxChars;
      if (cut) state.tellTruncated += 1;
      state.tells += 1;
      deps.onTell && deps.onTell(state.card, cut ? raw.slice(0, CONFIG.hud.tellMaxChars) : raw);
      tellInput.value = '';                       // 不清空 ⇒ 下一句是拼接，症状是"它记住了两句半"
      pulse();
    },
    tellValue() { return tellInput.value; },
    rename(creature, name) {
      const v = String(name == null ? '' : name).trim().slice(0, CONFIG.hud.nameMaxChars);
      state.renames += 1;
      if (!v) { state.rejectedNames += 1; deps.onRename(creature, null); pulse(); return; }
      deps.onRename(creature, v); pulse();
    },
    setCard(creature, world, opts) {
      state.card = creature || null;
      renderCard(creature, world);
      card.classList.toggle('is-open', !!creature);
      state.cardOpens += creature ? 1 : 0;
      // 长按那一路是"开卡 + 直接把改名框聚焦"，不是另一个控件：软键盘弹一次就够，
      // 而且手机上"先点开卡再点名字"是两步，spec §6.1 那张表里长按就是为了一步到位。
      if (creature && opts && opts.focusName) { nameInput.value = String(creature.name || ''); nameInput.focus(); }
      pulse();
    },
    setSettingsOpen(open) { state.settingsOpen = !!open; renderSettings(); pulse(); },
    pulse,
    frame(nowMs, world) {
      state.frames += 1;
      renderReadout(world);
      // 节流：卡片里的数字每帧重排 DOM 会在手机上掉帧（spec §5.3）。
      if (state.card && nowMs - (state._lastCard || 0) >= CONFIG.hud.cardRefreshMs) {
        state._lastCard = nowMs; renderCard(state.card, world); state.cardRenders += 1;
      }
      c.classList.toggle('is-dim', nowMs - state.lastInputAt >= CONFIG.hud.fadeIdleMs);
    },
    destroy() { if (c.remove) c.remove(); else if (c.parent) c.parent.removeChild(c); },
  };
  // tellBtn / nameBtn 要在 api 之后才绑得起来（它们要调 api.tell / api.rename）—— 顺序是有意的，
  // 别顺手挪到上面。
  tellBtn.addEventListener('click', () => api.tell());
  card.appendChild(nameInput); card.appendChild(nameBtn);
  card.appendChild(tellInput); card.appendChild(tellBtn);
  function pulse() { state.lastInputAt = state._now || 0; c.classList.remove('is-dim'); }
  // …renderReadout / renderCard / renderSettings / radarSvg / el / button / FOOD_LABEL 见 Step 5
  return api;
}
```

> ⚠️ 上面这段是**骨架**，Step 5 把里面点到的每个 helper 补完并跑绿。不许把 helper 留成"见实现"—— 那正是本仓库最恨的占位符。

- [ ] **Step 5: 补完 helper 并跑绿**

`el(doc, tag, cls)`、`button(doc, text, cls)`（建 `<button>`、打 `hud-touch`、`type='button'` —— **必须显式写 `type`**，否则在 `<form>` 里会提交页面）、`FOOD_LABEL`（`{algae: '光藻', nectar: '蜜珠', crystal: '冰晶'}`，逐字取自 spec §6.2 那张表；**它必须覆盖 `Object.keys(CONFIG.food)`**，Step 5 补一条测试：`assert.deepEqual(Object.keys(FOOD_LABEL).sort(), Object.keys(CONFIG.food).sort())` —— 少一个键的症状是"投食条上少一个按钮"，而它不会抛）、`renderReadout(world)`（把 `readoutFor` 的三个数 + 时间写进 `.hud-readout` 的子节点，**只在值变了的时候写 `textContent`**）、`renderCard(c, world)`（`cardFor` → 行 + `radarSvg(card.radar)` + 心形 + 肖像 `<img>`）、`radarSvg(points)`（SVG `polygon`，九点闭合，坐标在 0..100 的单位圆里算）、`renderSettings()`（Task 6 的内容，本 Task 先建空壳并留 `state.settingsOpen` 的 class）。

Run: `node --test tests/hud.test.js` → 全绿。

- [ ] **Step 6: `index.html` 与 `css/main.css`**

`index.html` 的 `<canvas id="tank"></canvas>` 之后加一行（**只加容器，不加业务 DOM** —— 全部由 `mountHud` 建，否则 DOM 桩测不到那一半）：

```html
<!-- HUD 容器。里面是空的：所有节点由 src/hud.js 建（tests/dom-stub.js 测得到）。 -->
<div id="hud-root"></div>
```

`css/main.css` 末尾追加（`--safe-*` 四个变量在 `:37-42` 已经声明好，这里是它们的**第一个消费者**）：

```css
/* ---- 计划 3 HUD ---- */
.hud { position: fixed; inset: 0; pointer-events: none; z-index: 2;
  padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  transition: opacity 400ms ease; }
.hud.is-dim { opacity: .25; }            /* spec §6.3：平时半透明淡出，不遮挡水体 */
.hud > * { pointer-events: auto; }
.hud-readout { position: absolute; top: calc(12px + var(--safe-top)); left: 12px; font: 12px/1.5 system-ui; color: #f7d9ec; }
.hud-controls { position: absolute; top: calc(12px + var(--safe-top)); right: 12px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.hud-foodbar { position: absolute; bottom: calc(12px + var(--safe-bottom)); left: 50%; transform: translateX(-50%); display: flex; gap: 10px; }
.hud-card { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: min(88vw, 340px); max-height: 78vh; overflow: auto; display: none;
  background: rgba(20,10,40,.92); border-radius: 16px; padding: 16px; color: #ffeaf6; }
.hud-card.is-open { display: block; }
.hud-touch { min-width: 44px; min-height: 44px; }   /* spec §6.3 触控目标下限，与 CONFIG.hud.minTouchPx 同一个数 */
```

> `z-index: 2` 是必须的：canvas 没有 stacking context（`css/main.css:20-32` 没有 `z-index`），HUD 不抬一层会被水体盖住。`pointer-events: none` 在外层、`auto` 在子块 —— 这样"点水面上的空白"仍然落到 canvas，投食与抚摸不受影响。

- [ ] **Step 7: 跑 `tests/assets.test.js`**

Run: `node --test tests/assets.test.js`
Expected: 绿。它钉 `index.html` 必须保留 `<script type="module" src="/src/main.js">` 与 `viewport-fit=cover`（`:33-39`）、CSS 三段背景色与 `CONFIG.colors` 相等（`:17-31`）—— 本 Task 都没动那些。

- [ ] **Step 8: 全量 + 提交**

```bash
node --test tests/
git add src/hud.js tests/hud.test.js tests/dom-stub.js index.html css/main.css
git commit -m "feat: Task 4 HUD 的 DOM 层（doc 形参注入）—— 音频降级时静音键不出现，--safe-* 变量第一次有人用"
```

---

## Task 5: `main.js` 接线 —— 暂停、手势分发、`hear()` 的第一个生产者

**Files:**
- Modify: `src/main.js`
- Create: `tests/hud-boot.test.js`
- Modify: `src/config.js`（无新段，`hud` 已在 Task 3）

**Interfaces:**
- Consumes: `mountHud(doc, deps)`（Task 4）、`classifyPress` / `pickCreature`（Task 1）、`spawnFood(world, kind, pos)`（`sim.js:349`）、`hear(c, text, rng, nowSec, opts)`（`heard.js:89`）、`moodOf`、`mostUrgent(needs)`（`needs.js:101`）。
- Produces: `controller.setPaused(bool)` / `controller.getPaused()`；`boot({hud})` 支持注入替身（测试用，与 `renderer` / `audio` / `input` 同形）。

- [ ] **Step 1: 写失败的 boot 测试**

新建 `tests/hud-boot.test.js`（**逐字沿用** `tests/save-boot.test.js:61-140` 那套 `makeCtx` / `makeCanvas` / `withSaveTank` 桩，只把 fake `document` 换成能 `createElement` 出节点的那个 —— 直接 `import { makeDoc } from './dom-stub.js'` 并把它的 `body` 交给桩）：

```js
test('boot 之后 HUD 挂在 body 上，且**不点它的时候世界逐字节不变**', () => {
  // 全局约束第 6 条的行为形式。HUD 每帧都跑，它要是偷偷写了世界，
  // 症状是"开了 HUD 的缸与没开的缸对不上"，而且只在长跑之后才看得出来。
  withTank((ctrl, doc) => {
    const before = JSON.stringify(ctrl.world.creatures);
    run(300);
    assert.notEqual(JSON.stringify(ctrl.world.creatures), before, '世界自己没动？那这条测试在空转');
    const a = snapshot(); run(1); const b = snapshot();
    assert.equal(a, b, '有一帧 HUD 写了世界');
  });
});

test('暂停：world.time 冻结，但 frame 计数与 renderer.draw 照旧', () => {
  withTank((ctrl) => {
    ctrl.setPaused(true);
    const t0 = ctrl.world.time, f0 = ctrl.frame;
    run(60);
    assert.equal(ctrl.world.time, t0, '暂停了还在推进模拟');
    assert.ok(ctrl.frame > f0, '暂停不该停掉帧循环：HUD 与画面要还能响应');
    ctrl.setPaused(false); run(10);
    assert.ok(ctrl.world.time > t0);
  });
});

test('暂停时存档**不落盘**（sim 时间冻结 ⇒ everySimSec 永远不到）', () => {
  withTank((ctrl) => { ctrl.setPaused(true); run(600); assert.equal(ctrl.saveState.writes, 0); });
});

test('点按一只 ⇒ 打开信息卡；点空白 ⇒ 关掉', () => {
  withTank((ctrl, doc, hud) => {
    const c = ctrl.world.creatures[0];
    tapAt(screenOf(c));
    assert.equal(hud.state.card && hud.state.card.id, c.id);
    tapAt({ x: 5, y: 5 });
    assert.equal(hud.state.card, null);
  });
});

test('讲给它听：hear() 第一次有生产者 —— 卡里那只的 heard 长了，且**只**长它', () => {
  withTank((ctrl, doc, hud) => {
    const c = ctrl.world.creatures[0], other = ctrl.world.creatures[1];
    hud.setCard(c, ctrl.world);
    const before = c.heard.length, otherBefore = other.heard.length;
    hud.tell('宝宝今天也要好好吃饭哦');
    assert.ok(c.heard.length > before, '一个词都没存进去');
    assert.equal(other.heard.length, otherBefore, '话传给别的只了');
  });
});

test('听词走 speechRng：world.rng 一步不许动（全局约束第 7 条）', () => {
  withTank((ctrl, doc, hud) => {
    const c = ctrl.world.creatures[0];
    hud.setCard(c, ctrl.world);
    const r0 = JSON.stringify(ctrl.world.rng.state ? ctrl.world.rng.state() : ctrl.world.rng);
    hud.tell('测试用的一句话');
    const r1 = JSON.stringify(ctrl.world.rng.state ? ctrl.world.rng.state() : ctrl.world.rng);
    assert.equal(r1, r0, '主流被动了：这会让"关掉文字层 ⇒ 世界逐字节相同"当场作废');
  });
});

test('speechEnabled=false 时**仍然听得进**（输入是玩家的动作，不是输出）', () => {
  withTank((ctrl, doc, hud) => {
    ctrl.world.speechEnabled = false;
    const c = ctrl.world.creatures[0]; hud.setCard(c, ctrl.world);
    const before = c.heard.length; hud.tell('听得见吗');
    assert.ok(c.heard.length > before, '把输入也一起关了 = 玩家讲的话掉在地上');
  });
});

test('投食走 spawnFood：三个食物键各投出对应 kind，且受 foodMax 上限', () => {
  withTank((ctrl, doc, hud) => {
    const n0 = ctrl.world.foods.length;
    hud.pressFeed('nectar');                      // 蜜珠（spec §6.2：高能量、只能由玩家投喂）
    assert.equal(ctrl.world.foods.length, n0 + 1);
    assert.equal(ctrl.world.foods.at(-1).kind, 'nectar');
    assert.throws(() => hud.pressFeed('不存在'), /没有这种食物/, '名单外的 kind 是编程错误，必须抛');
  });
});

test('改名：customName 置真 + name 换掉；空名字那一次**什么都不动**', () => {
  withTank((ctrl, doc, hud) => {
    const c = ctrl.world.creatures[0], old = c.name;
    hud.setCard(c, ctrl.world); hud.rename(c, '小星');
    assert.equal(c.name, '小星'); assert.equal(c.customName, true);
    hud.rename(c, '   ');
    assert.equal(c.name, '小星', '空名字把已有的抹掉 = 一次误触丢名字');
  });
});

test('长按缸内 ⇒ 撒食；长按个体 ⇒ 开改名而不是撒食', () => {
  withTank((ctrl, doc, hud) => {
    const c = ctrl.world.creatures[0];
    const n0 = ctrl.world.foods.length;
    holdAt({ x: 20, y: 20 }, 900);
    assert.ok(ctrl.world.foods.length > n0);
    holdScreenOf(c, 900);
    assert.equal(hud.state.card.id, c.id);
  });
});

test('stop() 之后 HUD 的节点摘干净，且再按按钮不抛', () => {
  withTank((ctrl, doc, hud) => { ctrl.stop(); hud.pressScale(2); assert.equal(doc.body.children.length, 0); });
});
```

- [ ] **Step 2: 跑，确认红**

- [ ] **Step 3: `main.js` 加暂停旗标**

`state` 定义处（`main.js:828`）加 `paused: false`。`step` 里 `advanceLoop` 之前（`:984` 那一行）：

```js
    // 暂停 = **不推进模拟，但帧循环照跑**（画面、HUD、输入都要还能响应）。
    // 为什么不往 CONFIG.timeScales 里加一个 0：那会让 advanceLoop 拿到 0 倍速，
    // 于是 loop.acc 每帧白攒一格，恢复的瞬间把攒下的全补掉 —— 症状是"暂停一会儿再放，
    // 世界跳一大步"。另开一条旗标才是对的。
    const steps = state.paused ? 0 : advanceLoop(loop, frameDt, state.timeScale);
```

controller 上加（`main.js:1084` 那对 `setTimeScale` / `getTimeScale` 旁边）：

```js
    setPaused(value) { state.paused = !!value; return state.paused; },
    getPaused() { return state.paused; },
```

- [ ] **Step 4: 手势分发**

`main.js` 里 `attachInput` 之后（`:924` 附近）加一个**读 tracker 的 downAt**、在抬起那一刻分发的层。注意 `input.poll(t)` 已经在 `:982` 跑了，所以分发要放在它之后、`advanceLoop` 之前：

```js
  // ---- 计划 3 手势分发 ----
  // 判在 gestures.js（纯），效果在这里。tracker 的 downAt 由 Task 1 补上。
  const gesture = { downT: -1, downX: 0, downY: 0, moved: 0 };
  const onGesture = (px, py, phase) => {
    if (phase === 'down') { gesture.downT = perfNow(); gesture.downX = px; gesture.downY = py; gesture.moved = 0; return; }
    if (phase !== 'up') { gesture.moved = Math.max(gesture.moved, Math.hypot(px - gesture.downX, py - gesture.downY)); return; }
    const kind = classifyPress({ heldMs: perfNow() - gesture.downT, movedPx: gesture.moved }, CONFIG.hud);
    const hit = pickCreature(world.creatures, viewport, px, py, CONFIG.hud);
    if (kind === 'swipe') { if (dragFood) spawnAt(dragFood, px, py); return; }
    if (kind === 'hold') { if (!hit) scatter(px, py); else hud.setCard(hit, world, { focusName: true }); return; }
    hud.setCard(hit, world);        // tap：点到了开卡，点空白关卡（hit 为 null 就是关）
  };
```

> `perfNow()`：`main.js` 现在用 rAF 回调的 `t`（真实毫秒）做节流，**不要引入 `performance.now()` 的新调用点** —— 直接用最后一次 `step(t)` 收到的 `t` 存进 `state.lastT`（那个字段已经存在，`main.js:828`），手势层读它。这样"浏览器全局之外还多一个时钟源"这件事不会发生。

- [ ] **Step 5: `hear()` 的接线（本计划最重要的一行）**

```js
    tell(creature, text) {
      if (!creature || !text) return;
      // hear() 在全仓**第一个**生产者。它要的三个东西都得现算：
      //   mood —— 只用来定"这个词值多少分"（CONFIG.heard.moodPrice），**不上 HUD**；
      //   need —— 最紧的那条需求（hear 的 opts.need 是必填，没有默认）；
      //   rng   —— 必须是 speechRng：hear 内部会 next()，走主流会让
      //            "关掉文字层 ⇒ 世界逐字节相同"那条承诺当场作废（tests/render-bubble.test.js:479）。
      const mood = moodOf(creature.emotions, creature.needs, creature.memory, { adversity: creature.mourn > 0 });
      const need = mostUrgent(creature.needs);
      const taken = hear(creature, text, world.speechRng, world.time, { mood, need });
      hudStats.tellsReceived += taken;
    },
```

- [ ] **Step 6: 投食 / 撒食**

```js
  const spawnAt = (kind, px, py) => {
    if (world.foods.length >= CONFIG.foodMax) { hudStats.foodRejected += 1; return; }
    spawnFood(world, kind, { x: px / viewport.width, y: py / viewport.height });
    hudStats.feeds += 1;
  };
  const scatter = (px, py) => {
    const n = CONFIG.hud.scatterCount;      // 加进 CONFIG.hud：3
    for (let i = 0; i < n; i++) {
      if (world.foods.length >= CONFIG.foodMax) { hudStats.foodRejected += 1; break; }
      spawnFood(world, 'algae', { x: (px + (i - 1) * 18) / viewport.width, y: py / viewport.height });
      hudStats.feeds += 1;
    }
  };
```

> ⚠️ `spawnFood` 的 `pos` 参数语义要先读 `sim.js:349-377` 确认是归一化还是世界单位 —— **不许猜**。读完之后把结论写进这行注释里（这是本仓库的规矩：把"我查过了"留在原地，而不是留在聊天里）。

- [ ] **Step 7: HUD 每帧钩子**

`step` 末尾（`world.events.length = 0;` 之后，`main.js:1044`）：

```js
    if (hud) hud.frame(t, world);
```

- [ ] **Step 8: `boot({hud})` 注入口 + 计数器**

`boot` 的 options 表（`main.js:770-830` 那一片）加 `options.hud`，与 `renderer` / `audio` / `input` 同形（给了就用给的）。`hudStats` 挂在 controller 上：`{ feeds, foodRejected, tells, tellsReceived, renames, rejectedNames, cardOpens }` —— **每一个丢弃/拒绝都必须有计数器**（spec §7.7"绝不静默"那条的同族）。

> **两套计数器不是重复**：`hud.state.*` 数的是**界面看到了什么**（截断了几次、端点被拒几次、卡片开了几次），`controller.hudStats.*` 数的是**世界收到了什么**（`tellsReceived` 是 `hear()` 的返回值之和、`foodRejected` 是撞 `foodMax` 的次数）。两者的差就是漏掉的东西 —— 只留一套的话，"玩家讲了十句、它一句没记住"与"输入框根本没通"在画面上长得一样。

- [ ] **Step 9: 跑 boot 测试到绿，再跑全量**

```bash
node --test tests/hud-boot.test.js && node --test tests/
```
Expected: 全绿。**特别注意** `tests/render-bubble.test.js:479`（关掉文字层 ⇒ 七层调用序列逐笔相同）与 `tests/audio.test.js:842`（叫完一整套之后 world 逐字节不变）—— 这两条是 Task 5 最容易打红的，红了说明 `tell` 走了主流或 HUD 写了世界。

- [ ] **Step 10: 提交**

```bash
git add src/main.js src/config.js tests/hud-boot.test.js
git commit -m "feat: Task 5 HUD 接线 + 暂停 + hear() 的第一个生产者（走 speechRng，主流一步不动）"
```

---

## Task 6: 设置页 —— key 只写不读，清空存档要按两次

**Files:**
- Modify: `src/hud.js`（`renderSettings` 补完）
- Modify: `src/main.js`（`rename` 与 speech 开关）
- Modify: `tests/hud.test.js`、`tests/hud-boot.test.js`
- Modify: `src/sim.js` + `src/breeding.js`（同胞重名修复，见 Step 6）

- [ ] **Step 1: 失败的测试 —— 六行设置**

```js
test('设置页六行：端点 / 模型 / key / 文字层开关 / 存档来源 / 危险动作', () => {
  const { hud, root } = mount();
  hud.setSettingsOpen(true);
  for (const cls of ['hud-set-endpoint', 'hud-set-model', 'hud-set-key',
    'hud-set-speech', 'hud-set-save', 'hud-set-danger']) {
    assert.ok(find(root, 'div', cls), `缺 ${cls}`);
  }
});

test('key 是**只写**的：填进去之后 DOM 树里搜不到那个串（决策 D 的 UI 侧）', () => {
  const { hud, doc, root, calls } = mount();
  hud.setSettingsOpen(true);
  const SENTINEL = 'sk-DO-NOT-LEAK-1234567890';
  hud.setKey(SENTINEL);
  hud.saveSettings();
  assert.ok(calls.some((c) => c[0] === 'api' && c[1].key === SENTINEL), 'key 没交给 setApiConfig');
  assert.ok(!JSON.stringify(doc.body).includes(SENTINEL), 'key 回显在 DOM 上了');
  const box = find(root, 'input', 'hud-set-key');
  assert.equal(box.attrs.type, 'password');
  assert.equal(box.value, '', '保存之后输入框必须清空');
});

test('getApiConfig 那一份读数里只有 hasKey，设置页显示"已保存（••••）"', () => {
  const { hud, root } = mount();
  hud.setSettingsOpen(true);
  assert.ok(/已保存/.test(textOf(find(root, 'div', 'hud-set-key'))));
});

test('端点非 https 时**当场报**，不落盘（spec §13.2 第 3 条）', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true);
  hud.setEndpoint('http://evil.example/'); hud.saveSettings();
  assert.equal(hud.state.endpointRejected, 1);
  assert.ok(!calls.some((c) => c[0] === 'api'), '被拒的配置不许写进 localStorage');
});

test('文字层开关写的是 world.speechEnabled（不是 CONFIG），且关掉之后世界逐字节不变', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true); hud.setSpeech(false);
  assert.deepEqual(calls.at(-1), ['speech', false]);
});

test('清空存档要**按两次**：第一次只亮出确认态，第二次才调 clearSave', () => {
  const { hud, calls, root } = mount();
  hud.setSettingsOpen(true);
  const btn = find(root, 'button', 'hud-clear-save');
  click(btn);
  assert.ok(!calls.some((c) => c[0] === 'clearSave'), '一次就清 = 一次误触丢掉一缸');
  assert.ok(btn._class.has('is-armed'));
  click(btn);
  assert.ok(calls.some((c) => c[0] === 'clearSave'));
});

test('确认态 4 秒不点就自己收回（armed 的按钮亮着不管 = 下一次随手一按就清了）', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true); hud.pressClear();
  for (let t = 0; t < CONFIG.hud.confirmArmedMs + 100; t += 100) hud.frame(t, W([mk()]));
  hud.pressClear();
  assert.ok(!calls.some((c) => c[0] === 'clearSave'));
});

test('存档那一行写的是 source 与字节数，不写"成功/失败"这种没有依据的话', () => {
  const { hud, root } = mount();
  hud.setSettingsOpen(true);
  const t = textOf(find(root, 'div', 'hud-set-save'));
  assert.ok(/本机|文件|不可读/.test(t), t);
});
```

- [ ] **Step 2: 实现 `renderSettings` 与那六个方法**（`setEndpoint` / `setModel` / `setKey` / `setSpeech` / `saveSettings` / `pressClear`）。要点：
  - `saveSettings()` 先本地判 https（复用 `api.js` 已有的 `configIssue(cfg)` —— 它**只报字段名不报值**，正是这里要的），有 issue 就 `state.endpointRejected += 1` 并把字段名标红，**不**调 `setApiConfig`。
  - `CONFIG.hud.confirmArmedMs = 4000`（新加一个数，同步 config 测试那两个数）。
  - 存档那一行的三个 source 文案：`fresh→'本机新档'` / `restored→'读回本机档'` / `corrupt-moved→'旧档读不懂，已留证据'` / `unreadable→'存储不可用（只玩不存）'` —— 逐字与 `main.js:509-530` 的 `saveState.source` 对得上。

- [ ] **Step 3: `main.js` 侧补 `onSpeech` 与 `onRename`**

```js
    onSpeech(v) { world.speechEnabled = !!v; },        // 写 world，不写 CONFIG（CONFIG 是深冻结的，且它是默认值不是运行时状态）
    onRename(creature, name) {
      if (!creature) return;
      if (!name) { hudStats.rejectedNames += 1; return; }   // 空名字：什么都不动（boot 测试钉着）
      creature.name = name; creature.customName = true;      // customName 在全仓的第一个生产者
      hudStats.renames += 1;
    },
```

- [ ] **Step 4: 跑绿**

`node --test tests/hud.test.js tests/hud-boot.test.js tests/api.test.js`
（`tests/api.test.js` 里那条"JSON.stringify 搜不到 key 子串"的判据与本 Task 同族，一起跑确认没互相打红。）

- [ ] **Step 5: 同胞重名修复（顺手，因为它就在改名旁边）**

现状：`breeding.js:201` 恒传 `opts.nameFor(egg.genes, 0)` ⇒ 同一窝的孩子全叫同一个名。改成按卵在窝里的序号：

```js
  // 同窝不重名：index 用**这枚卵在窝里的序号**而不是恒 0。
  // defaultNameFor 的后缀规则（sim.js:180-181）是 index<10 不加后缀、之后 `·N`，
  // 所以恒 0 的现在症状是"一窝五只全叫泡泡"—— 玩家分不清谁是谁，§9.2 第 2 条跟着塌。
  name: opts.nameFor(egg.genes, opts.clutchIndex || 0),
```

`sim.js` 结算孵化处把 `clutchIndex` 传下去（`egg.seq` 已有 —— `reserveEggSeq(n)` 在 `breeding.js:19`，读 `egg` 上那个字段的确切名字再写，**不许猜**）。

- [ ] **Step 6: 测试**

```js
test('同一窝孵出来的孩子**名字互不相同**', () => {
  // 症状：一窝五只全叫"泡泡"。§9.2 第 2 条（能看出两只之间的关系）与改名功能都跟着塌，
  // 而且玩家会以为是自己改砸了名。
  const kids = hatchClutch(5);
  assert.equal(new Set(kids.map((k) => k.name)).size, 5);
});

test('customName 的**消费者**：同窝去重不许覆盖玩家取的名', () => {
  // 没有这一条，customName 就是"有生产者没消费者"的那个形状（D-1 删 tipPower 的同一条判据）。
  const a = mkKid({ name: '泡泡', customName: true });
  const b = mkKid({ name: '泡泡', customName: false });
  dedupeClutch([a, b]);
  assert.equal(a.name, '泡泡', '玩家取的名被自动逻辑改了');
  assert.notEqual(b.name, '泡泡', '该改的那只没改 ⇒ 这条测试在空转');
});
```

- [ ] **Step 7: 全量 + 提交**

```bash
node --test tests/
git add src/hud.js src/main.js src/breeding.js src/sim.js src/config.js tests/hud.test.js tests/hud-boot.test.js tests/config.test.js
git commit -m "feat: Task 6 设置页（key 只写不读、清空要按两次）+ 顺手修同窝重名"
```

---

## Task 7: F-5 —— 卵埋进沉积物里（新遮罩层，不动层序账）

**Files:**
- Modify: `src/render.js`（`drawEggs` 之后加一层遮罩）
- Modify: `src/config.js`（`CONFIG.render.eggMaskRatio`）
- Modify: `tests/render-fx.test.js`（追加两条）

**Interfaces:**
- Consumes: `renderer.sediment`（`buildStatics` 里建的那张带子图，`render.js:1799-1821`）、`eggRadiusPx`（`render.js:304`）、`viewport`。
- Produces: 无新导出（纯多画一层）。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/render-fx.test.js`（沿用该文件已有的记录型 ctx 桩）：

```js
test('F-5：卵画完之后**再补一层沉积物遮罩**，把下沿盖住', () => {
  const { ctx, renderer, world, viewport } = fixtureWithEggs();
  renderer.draw(ctx, world, new Map(), viewport, 1 / 60);
  const order = ctx.order();                       // 该文件已有的"调用顺序"读数
  const eggs = order.indexOf('drawEggs');
  const mask = order.indexOf('eggMask');
  assert.ok(eggs >= 0 && mask > eggs, '遮罩必须在卵之后，否则盖不住任何东西（这正是 F-5 的病根）');
});

test('遮罩只用矩形路径：不许新增 arc / ellipse（那条"arc 早于 ellipse 早于 clip"的层序断言的账不能变）', () => {
  const { ctx, renderer, world, viewport } = fixtureWithEggs();
  const before = { arc: ctx.count('arc'), ellipse: ctx.count('ellipse') };
  renderer.draw(ctx, world, new Map(), viewport, 1 / 60);
  assert.ok(ctx.count('fill') > before.fill0 || true, 'fill 会变，这不算问题');
  assert.ok(ctx.count('ellipse') === ctx.count('ellipse'), '自比无意义 —— 见下');
  // 真正的判据：与"没有这一层"的基线比 arc/ellipse 的**次数**。
  assert.equal(ctx.count('ellipse'), ELLIPSE_BASELINE,
    `ellipse 次数变了（${ctx.count('ellipse')} vs 基线 ${ELLIPSE_BASELINE}）：遮罩用了椭圆，会把层序断言打红`);
  assert.equal(ctx.count('arc'), ARC_BASELINE, 'arc 次数同理');
});
```

> `ELLIPSE_BASELINE` / `ARC_BASELINE` 在测试文件顶部**跑一次打印出来再填**（`console.log(ctx.count('ellipse'))`），填完把那行删掉。这两个数是量出来的，不是估的 —— 与 `CONFIG` 那两个数同一条规矩。

- [ ] **Step 2: 实现**

`render.js` 的 `draw()` 里 `drawEggs(...)`（`:1760`）之后：

```js
  // F-5（2026-10-23）：沉积带画在卵**之前**，所以卵的下沿永远不被任何东西遮住 ——
  // 画面上就是"一颗颗蛋浮在带子前面"。补一层遮罩：只画带子上沿以下的那一条，
  // 用矩形路径（不用 ellipse/arc：那两条的**次数**被 tests/render-fx.test.js 的层序断言钉着）。
  drawEggMask(ctx, renderer, world, viewport);
```

```js
function drawEggMask(ctx, renderer, world, viewport) {
  const h = viewport.height, w = viewport.width;
  const band = h * CONFIG.render.sedimentHeight;
  const top = h - band;
  const cover = band * CONFIG.render.eggMaskRatio;      // 盖住带子上部这一段 ⇒ 卵的下沿陷进沙里
  ctx.save();
  ctx.fillStyle = renderer.sedimentMaskColor || COLORS.sedimentMask;
  ctx.beginPath();
  ctx.moveTo(0, top + cover);
  ctx.lineTo(w, top + cover);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
```

> 遮罩色必须与沉积带**同色**（从 `buildStatics` 里那三段色取，别新造一个数）；否则缸底会出现一条看得见的接缝 —— 那比"蛋浮在沙上"更糟。取不到就**先停**，回来把这条写进发现清单。

- [ ] **Step 3: 跑绿 + 全量**

`node --test tests/render-fx.test.js && node --test tests/`

- [ ] **Step 4: 变异探针**：把 `drawEggMask` 挪到 `drawEggs` 之前 ⇒ 第一条必须红；把它改成 `ctx.ellipse(...)` ⇒ 第二条必须红。

- [ ] **Step 5: 提交**

```bash
git add src/render.js src/config.js tests/render-fx.test.js
git commit -m "fix: Task 7 F-5 卵埋进沉积物（新遮罩层）—— 矩形路径，arc/ellipse 的次数一个字没变"
```

---

## Task 8: 端到端验收 —— §9.2 那六条现在有了出口

**Files:**
- Modify: `docs/superpowers/checklists/2026-10-22-plan2-visual-checklist.md`（新增 §9）
- Modify: `docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md`（§9.3 结果、§13.2 第 4 条的落点、§6.3 的"计划 3 已做/未做"）
- Modify: `tests/simulate.mjs`（加一条 HUD 无关的缸级判据不许红）

- [ ] **Step 1: 全量对账（两路）**

```bash
node --test tests/ 2>&1 | grep -E "^# (tests|pass|fail)"
grep -c '^test(' tests/*.test.js | awk -F: '{s+=$2} END {print s}'
node tests/simulate.mjs 2>&1 | tail -3
```
Expected: 全绿；两个数之差要能解释（参数化的 `for` 循环）。起点 921。

- [ ] **Step 2: 2 小时缸（§9.2 第 9 条，B20 欠的那一条）**

```bash
node tests/simulate.mjs --minutes 120   # 若脚本不接参数，改它顶部的常量并**还原**
```
判据：第 6 代前后仍看得出 ≥3 种明显不同的颜色/花纹。**把实测的代际数、色相组内标准差、耗时逐字记进清单 §9** —— 不许写"通过"了事。

- [ ] **Step 3: 真像素（这一轮浏览器通道可能仍被拦，拦了就如实写）**

`start.bat` → `http://localhost:8123/`。看六件事，逐条记"看到什么"而不是"通过"：
1. HUD 淡出/亮回；所有按钮拇指能按到（≥44px）；iOS 刘海不压字。
2. 点一只 ⇒ 信息卡；**读一遍卡上的字，找有没有任何一句在替它陈述心情**（§13.2 第 4 条）。
3. 长按一只 ⇒ 改名；改完它自己的气泡里会不会喊出新名（§4.8.1 那条"你叫它，它回头"）。
4. 输入框讲一句话 ⇒ 过一会儿在相关情境下它自己冒出来；找一只 `intellect` 低的看它会不会说错。
5. 卵：下沿是不是**陷进沙里**了（F-5）。
6. 暂停 30 秒再放：世界**不许**跳一大步（Task 5 那条裁定的真机形式）。

- [ ] **Step 4: 清单 §9 与 spec 回写**

清单里每条判据写清"机器侧证明（文件 + 测试名）/ 人眼侧看到什么 / 结论"，**沿用 §1 那张表的格式**，并且**不许把全绿读成 §9.2 通过**（B20 那句原话照抄进结论段：11 条里当时只有 1 条完全通过，这一轮补上了哪几条、哪几条仍然不是）。

spec 回写三处：§9.3 验收结果加一行本轮；§6.3 里"属计划 3 的 UI"那几条改成"已由计划 3 的 `src/hud.js` 实现"；§13.2 第 4 条补一句"落点：`tests/hud.test.js` 的行为级判据（只差情绪的两只个体 rows 逐字节相同）"。

- [ ] **Step 5: 提交 + PR**

```bash
git add -A && git commit -m "docs: Task 8 计划 3 端到端验收 —— §9.2 补上了哪几条，哪几条仍然不是"
git push -u origin <branch> && gh pr create --repo ajsjsjjbshshsj/electronic-creature-tank ...
```

---

## Self-Review（写完对着 spec 走一遍，逐条）

**1. Spec 覆盖率** —— §6.1 手势表：点按 ✓、长按改名 ✓、长按撒食 ✓、拖拽投食 ✓（Task 5 的 `swipe` 分支 + `dragFood`）、抚摸/戳 = 计划 2 已有 ✓。§6.3：名字 ✓、信息卡九项 ✓（性格雷达 ✓、心形好感 ✓、记住的词 ✓、蛋 ✓、父母 ✓）、**家谱树 ✗ → 计划 4**（界已划）、HUD 极简四件 ✓（左上读数 / 右上倍速+静音+暂停 / 底部食物条 / 淡出）、≥44px ✓、safe-area ✓。§4.8.1 讲进去 ✓。§4.13.2.1 第 6 条设置页 ✓。§5.4 静音按钮 ✓（含降级隐藏）。§7.3.1 存档三钮 ✓。**§7.5/§7.6 多设备 ✗ → 计划 4**。F-1 ✗ → 计划 4。F-5 ✓。§9.2 第 2/3/5/10 条有了出口 ✓，第 6/8 条仍然只能等人。

**2. 占位符扫描** —— Task 4 Step 4 那段 `mountHud` 骨架里点到 `el` / `button` / `renderReadout` / `renderCard` / `radarSvg` / `renderSettings` / `FOOD_LABEL`，除 `renderSettings`（Task 6 明确接管）之外**全部在 Step 5 补完并跑绿**，没有"见实现"。`spawnFood` 的 `pos` 语义与 `egg.seq` 的字段名两处标了"先读、不许猜"—— 那是**要求执行者去读的事实**，不是 TBD。

**3. 类型一致性** —— `Row = {label, value}` 在 Task 3 定义、Task 4 消费 ✓；`expressionFor` / `avatarSrc` / `preloadList` 三个名字在 Task 2 定义、Task 3 消费 ✓；`classifyPress(p, opts)` 与 `pickCreature(creatures, viewport, xPx, yPx, opts)` 的签名在 Task 1 定义、Task 5 按同一形状调用 ✓；`mountHud(doc, deps)` 的 `deps` 七个键（`controller / world / audioState / onFeed / onTell / onRename / onScatter / onSpeech`）与 Task 4 的 `mount()`、Task 5 的实际传参三处一致 ✓；`api` 上暴露的 `pressFeed / setCard(…, {focusName}) / tell / rename / pressClear` 与 boot 测试调用的完全同名同参 ✓。

**4. 两处故意留给执行者去读的事实**（不是占位符 —— 占位符是"这里以后再说"，这两处是"这里必须先去读，读到的结论要写回注释"）：
- Task 5 Step 6：`spawnFood(world, kind, pos)` 的 `pos` 到底是归一化还是世界单位 —— 读 `sim.js:349-377`。
- Task 6 Step 5：窝里那枚卵的序号字段的确切名字 —— 读 `breeding.js:19` 的 `reserveEggSeq` 与 `egg` 的构造处。
两处都**不许猜**，因为猜错的症状不是报错而是"投出来的食不在手指那儿" / "去重把名字全改没了"这一类查半天的活。

---

## 执行日志（边做边记：计划与现实的差，逐条）

### Task 1（2026-10-23 做完）—— 六处偏离，全部是计划错了而不是实现错了

| # | 计划里写的 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `pickCreature(creatures, viewport, xPx, yPx, maxAgeSec)` | 第五参是 `opts`（`{minHitPx}`） | 那个 `maxAgeSec` 是我写计划时手滑，签名里根本没有它的消费者 |
| 2 | gestures.js "纯，**零 import**" | `import { radiusPx } from './render.js'` | 自己另算一份半径 = 第二份真相。radiusPx 含年龄与蛋加成，另算的话幼体的**可点范围会和画出来的对不上** |
| 3 | 一条测"点选用的是**静止**半径而不是形变半径" | **删掉，前提不成立** | 读完 `render.js:142` 才发现 `radiusPx = renderSizeOf(c) × scale × 0.5`，而 `renderSizeOf` 只含年龄；挤压走的是 ctx 变换，**不进半径**。换成一条"命中边界就是 radiusPx 那个数"的耦合测试 |
| 4 | tracker 只加 `downAt` | 加了 `downAt` **与 `upAt`** | 只有 downAt 的话，"一次按下+抬起整个掉在同一帧间隙里"（手机掉帧时间隙 >100ms）会被下一次按下盖掉 —— 症状是"界面偶尔不理人"，最难查的那类。`upAt` 让"有一次已完成的按压没被消费"本身可读。残留限制（单槽寄存器，同帧两次按压仍会丢第一次）写在 `input.js` 的注释里，不为此上队列 |
| 5 | `classifyPress` 收 `overCreature`、DEFAULTS 里有 `tapMaxMs` | 两个都删 | 没有消费者。`tapMaxMs` 在"只有 hold 一条时间判据"的方案里根本改变不了任何结果 |
| 6 | 入口处 `if (!Number.isFinite(x) …) return null` | **删掉** | 变异探针 P7 活着回来了：NaN 减什么都得 NaN，`NaN <= r` 恒 false，脏坐标在比较里被自然吸收。留着只会让下一个人以为 NaN 需要特判 |

另外：`NO_TIME` 从模块私有改成导出 —— 测试要断"没有一次已完成的按压等着被消费"就得引用同一个哨兵，在测试里另写 `-Infinity` 就是第二份真相。

**⚠️ 给下一个执行者的一条环境事实**：本仓库源码是 **CRLF**。写变异探针时 `perl -0pi -e 's/…\n…//'` 这种**跨行**模式会静默不匹配，
看起来像"探针活着 = 测试是空的"，其实是根本没改到。跨行模式一律写 `\r?\n`，并且**每次改完先 grep 确认改到了再跑测试**。
本轮 P5/P6 第一次就是这么假活过去的。

### Task 2（2026-10-23 做完）—— 三处偏离，其中两条是执行事故，值得留着

| # | 计划里写的 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `expressionFor(c, world)` | `expressionFor(c)` | `world` 从头到尾没人读。参数也是旋钮，没有消费者就不许留（同 D-1 删 `tipPower`） |
| 2 | 未提 `EXPRESSIONS` 这个导出 | 加了 | 测试要拿"表里的八个名字"当全集比对，再抄一遍字面量就是第二份真相 |
| 3 | 未提 `!memory` 守卫 | 加了，并且**为它补了一条真会走到它的测试** | 见下 |

**执行事故一：`git checkout` 把未提交的实现抹掉了。**
探针 M2 要改 `CONFIG.avatar`，我用 `git checkout src/config.js` 还原 —— 而那段 `CONFIG.avatar`
**还没提交**，于是整个被 revert。症状是接下来四道探针全部报"模块加载失败"，看起来像代码坏了，
其实是配置没了。这条仓库早就记过（B17b 那轮 `git checkout` 毁掉未提交工作，换来一条
"先落绿色检查点再跑变异探针"的规则），我又犯了一次。
**规则**：探针还原一律 `cp <备份> <文件>`，**不许**对探针目标用 `git checkout` / `git restore`；
改文件之前先 `cp` 一份到 `.superpowers/sdd/tmp/`。

**执行事故二：探针活着 ≠ 判据是空的，也可能是夹具走不到那条路径。**
M5（删掉 `!memory` 守卫）第一次活着回来。两种解释：守卫是白写的，或者测试根本没碰到它。
分开的方法是把守卫删掉之后**直接跑那条路径**：
`expressionFor({ emotions: { joy: 0.9 … }, needs: createNeeds() })` —— 一抛 `TypeError` 就说明
守卫是承重的，是测试坏了。根因很蠢：夹具写的是 `{ emotions: createEmotions(), needs: … }`，
joy 恒 0，`moodOf` 在走到 `affectionFor` **之前**就返回 `calm` 了。
**规则**：凡是"脏输入不抛"这类守卫，夹具必须**构造到那条判据的门口**（这里 = joy≥0.6 且四条
needs≤0.25），否则它测的是"函数会返回东西"，不是"这里不抛"。

探针六道（M1 表指错文件 · M2 兜底改成 wink · M3 `hasOwn`→`in` · M4 判序反了 ·
M5 删 memory 守卫 · M6 `mourn` 不参与 adversity）—— 修正夹具与还原方式之后**六道全红**。

### Task 3（2026-10-23 做完）—— 视图模型；两处计划里的数值错误，一条探针证不到的守卫

**偏离计划：**

| # | 计划里写的 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `CONFIG.hud` 只 9 个数，gestures.js 自带一份 DEFAULTS 兜底、调用方传 opts | **DEFAULTS 删了**，gestures.js 直接 `import { CONFIG }`，`opts` 参数一并去掉 | 计划自己写了"真相在 CONFIG.hud"，却又留了第二份 —— 那就是"两处要同步改"的隐患本体。Task 3 是它第一次可能消失的时机，就在此处收编 |
| 2 | 体型档位阈值 0.34 / 0.67 | 按 `sizeOf` 的**世界单位**三等分 [14,22) 小 · [22,30) 中 · [30,38] 大 | 计划那两个数是按"traits.size 是 0..1"写的，而 `genes.js:130` 早就把它映到 14..38 了。照 0..1 写会让每一只都显示"特大" |
| 3 | 未提 `sizeTier` 的输入 | 传 `sizeOf(c)` 而不是 `c.traits.size` | 用后者的话幼体显示"中"，而它在画面上就是比同窝的小 |

**两条弱夹具（都是 Task 2 那条 M5 教训的同类，本轮自己抓到并改掉）：**
1. 本文件 `mk()` 默认 `age: 200` ⇒ 所有"成体"断言其实在比两只幼体，`eggBoost` 收敛那条 **trivially 成立**。改成显式 `age: 1000`。
2. 改完之后 `size 34 / age 2000` 又踩在档界下沿（老年 g=0.88 ⇒ 34×0.88 = 29.92 < 30 ⇒ 读成"中"）。
   选年龄不能只看"是不是成年"，还要看 `growthFactor` 落在哪 —— 这条写进注释了。

**七道变异探针 + 一道源码守卫：**
M1 加一行随情绪变的字（故意不含任何心情名词，专门骗 grep 级判据）· M2 `heartFillFor` 的 NaN 分支 ·
M3 同胞过滤漏掉自己 · M4 `pad2` 不补零 · M5 把"父亲"那行加回来 · M6 蛋色查不到时吐英文键 —— **六道全红**。
**P7 类的一道例外**：把 `CONFIG.hud.tapMaxPx` 换成字面量 `12`，**行为一模一样**，任何行为探针都抓不到，
而"两处数字要同步改"的隐患恰恰藏在"现在恰好相等"里。所以补了一条**源码守卫**
（`tests/gestures.test.js` 末条）：要求源码引用那三个 `CONFIG.hud.*` 名字、不许再出现 `DEFAULTS`、
不许出现裸的 12/500/22。它验证的是接线而不是行为 —— 与 `tests/api.test.js` 里那条 key 泄漏守卫同一类。

**判据的成色**：`信息卡不许替它陈述心情` 那条用的是"只差情绪的两只个体 rows 逐字节相同"，
M1 那道探针（一行写着"它看起来有点烦"）被它抓到了 —— 而这行字里**没有任何**心情名词，
grep 级判据对它是瞎的。这就是为什么那条测试要写成行为级。

### Task 4（2026-10-23 做完）—— DOM 层；两处计划调整，一条被测试抓到的真 bug

**偏离计划：**

| # | 计划里写的 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `index.html` 加 `<div id="hud-root">` 容器 | **index.html 一个字没改** | `mountHud` 直接 append 到 `doc.body`。加一个容器就成了"没人用的节点"，而测试的 `makeDoc().body` 与真页面的 `document.body` 因此是**同一个形状** —— 少一层，桩与真的差异就少一处 |
| 2 | DOM 测试接在 `tests/hud.test.js` 后面 | 单开 `tests/hud-dom.test.js` | 那个文件测**纯层**、一个节点都不碰；混在一起，将来"纯层回归"与"DOM 结构改动"两种红会搅在一个文件里，而它们的修法完全不同 |

**测试抓到的一条真 bug（不是计划错，是实现漏）：**
`tell(text)` 原本写 `text === undefined ? 读输入框 : String(text)`。传 `null` 时
`String(null)` 得到字面量 `"null"` —— 症状是**玩家什么都没讲，它记住了一个词："null"**。
改成 `text == null`。这类"把 null 变成字符串"的错在 JS 里是默认行为，只有测试会抓到。

**我自己的两条测试错（都记下来，因为它们都是同一类）：**
1. `focusName` 那条第二断言，我以为"普通点按不抢焦点"，但桩里没有真焦点模型 ——
   上一次 `focus()` 的目标会一直亮着。改成**先把 `doc.__focused` 清掉再验**，
   而不是给桩补一套 blur 链（那是重写浏览器焦点语义，超出这个桩该管的范围）。
2. 淡出那条我拿 `doc.body` 去查 `is-dim`，而 class 打在 `.hud` 上。fixture 层级看错了。

**十道变异探针全红：** 忽略音频降级总挂静音键 · 不写 `type=button` · tell 不清空输入框 ·
不截断超长输入 · 卡片不节流 · destroy 空转 · pressScale 不校验档位 · 淡出永不触发 ·
食物标签少一个 · 好感度从 CSS 变量改成写进文字（那条专抓 §6.3"不写数字"）。

**顺带**：`--safe-*` 四个变量（`css/main.css:37-42` 声明后一直没人消费）从这一版起真的被用了。

### Task 5（2026-10-23 做完）—— 接线；一条判据**连骗我两次**，最后换了测法

**接上的东西：**`state.paused` + `controller.setPaused/getPaused`（不往 `CONFIG.timeScales` 加 0，
理由见 §Global Constraints 第 5 条与代码注释里的"攒一格补一大步"）；`consumeGesture()` 每帧收一次
已完成的按压；`dispatchGesture` 把 tap/hold/swipe 分发到开卡 / 改名 / 撒食；`feedAt`/`scatterAt`
走 `spawnFood`；**`hear()` 在全仓的第一个生产者**；`mountHud(document, deps)`；step 末尾 `hud.frame`；
`stop()` 摘 HUD；`boot({hud:false})` 注入口。

**计划里写的三处，实现时改了：**

| # | 计划 | 实际 | 为什么 |
|---|---|---|---|
| 1 | 手势层自己累加每帧位移算 `movedPx` | `input.js` 补 `downX/downY/upX/upY`，跨度用按下点↔抬起点直线算 | 一次"按下+抬起整个掉在同一帧间隙"的快按，`poll` 一次都看不见那只手 —— 累加出来是 0，而且**不知道它发生在哪儿**。代价（绕一圈回到原点的划动会被读成点按）写在注释里，不藏 |
| 2 | 时钟用 `state.lastT`，"不引入新调用点" | 按压时刻仍走 `input.js` 的 `defaultNow` | 用最后一次 rAF 的时间戳的话，同一帧间隙内的 down 与 up 读到**同一个 t** ⇒ 长按永远判不出来。`defaultNow` 本来就在 input.js 里，不是新引入的 |
| 3 | `stop()` 里 `hud = null` | 只 `destroy()`，不置 null | `controller.hud` 这个读数 stop 之后还要拿得到；置 null 会让"停了再按按钮不抛"那条测试直接 TypeError |

**一条判据连骗两次 —— 这是本轮最值得记的事。**
判据：「tell 只许走 `speechRng`，不许碰模拟主流」（全局约束第 7 条的直接推论）。

1. 第一版写 `JSON.stringify(world.rng)` 前后比对。探针（把 `hear` 的 rng 参数换成 `world.rng`）**活着**。
   根因：mulberry32 的状态是**闭包里的一个数**（`rng.js:5`），对象上全是函数，stringify 恒等于 `{}`。
2. 第二版改成"两缸同种子、只差一次 tell，之后各抽三个数比对"。探针**又活着**。
   根因更深：那只个体的 `curious` 让 `selectCandidates` 走了 `uniq.length <= n` 的**早退分支**，
   一次随机数都没消费 ⇒ 两缸当然相同。判据不是"弱"，是**根本没跑到那条路径上**。
   而且我给它配的反向哨兵（"speechRng 必须不同"）也是假的：tell 改了 `heard` ⇒ 之后出词不同
   ⇒ speechRng 消耗自然不同，它测的并不是"hear 从哪儿抽的数"。
3. 第三版不比结果，**直接数调用**：两个 rng 各包一层计数器，tell 之后主流必须 0 次、
   `speechRng` 必须 > 0 次（后者不成立就报"这条在空转"），并把 `curious` 设成 0 强制走抽样那条路。
   这回探针死了。

**推论（写下来防再犯）：** 判"某段代码没碰某个资源"时，**数它对那个资源的调用次数**，
不要用"前后状态相同"来反推 —— 状态相同可能只是因为**根本没走到那儿**。

**十道探针全红：** 暂停旗标不生效 · tell 走主流 · 改名不置 customName · 空名字照写 ·
投食不查上限 · 按压用 `>=` 判（重复消费）· 不挂 `hud.frame` · stop 不摘 HUD ·
`hud:false` 被忽略 · onTell 不调 hear（反证那条判据不空转）。

**顺带修掉的一条真 bug：**静音键的显隐原本只看 `audioState.ok === false`。开缸那一刻它是
`{tried:false, ok:false}`（AudioContext 要等第一次真实手势才创建），只看 `ok` 会让那颗按钮
**永远不出现**。条件补上 `tried`。这条是 boot 级测试逼出来的 —— 纯层测试里我手写的
`audioState` 恰好是 `{tried:true, ok:true}`，看不见。

**波及面如实记：** `boot()` 现在会挂 HUD，所以 6 个既有测试文件里那 11 处 `boot({...})`
全部加了 `hud: false`（它们的 document 桩没有 `body`）。HUD 自己的路径由本文件覆盖。

### Task 6（2026-10-23 做完）—— 设置页与去重；三条执行记录，其中两条是我自己造的

| # | 计划 | 实际 | 为什么 |
|---|---|---|---|
| 1 | 设置页常驻、用 class 隐藏 | **开时建、关时拆** | key 框少活一会儿就少一处能被读到的地方；而且"关着的时候不许在树里"这条判据只有拆开才成立 |
| 2 | `saveSettings` 用 `configIssue` 判端点 | 只用它判 **insecure**；空端点放行 | `configIssue` 要求端点+模型+key 三样齐，照它来会让"先填 key、下次再填端点"这种正常填表被拒。安全的那条（明文 http 会把 key 广播到局域网）必须硬拦，UX 的那条不必 |
| 3 | `dedupeNames` 只改第二只 | 改**所有**与 customName 撞车的自动名 | 玩家取的名先占位，自动名一律让路。测试期望值一开始写错了（写成 1，实算是 2），是我的判据想错了不是代码错了 |

**记录一：又踩 CRLF，这次代价是半个工作日。**
一条多行 `perl -0pi -e 's/…\r?\n…/…/'` 的替换写崩了 `src/hud.js`（"Substitution replacement not terminated"），
12 条测试瞬间变红。靠**事先的 `cp` 备份**还原了。规矩再确认一遍：
**改源码用 Edit 工具，perl 只用来做探针；每道探针改完先 `cmp` 确认改到了再跑测试。**

**记录二：`draft.keySaved` 是第二份真相，它自己冒出来了。**
"存过 key 没有"这件事 `getApiConfig().hasKey` 已经回答，HUD 里又存了一份 ——
于是"重开设置页"时它被覆盖，明明存过却显示"未填"。删掉本地那份，`hasKey` 只有一个来源。
测试侧同步把 `getApiConfig`/`setApiConfig` 改成读写**同一份** `cfg`：
两个互不相干的桩会让这类不一致**两边都测不到**，这正是它长出来的土壤。

**记录三：探针测不出红 ≠ 没有判据，但必须换判法。**
S4（把 `draft.key` 回填进框）与 S10（保存后不清 `draft.key`）两道探针都逼不出红 ——
因为"key 不进 DOM"在这版实现里是**结构性**的：没有任何一条路径把它写进节点。
于是不补行为测试，改补一条**源码守卫**（`draft.key` 不许出现在 `.value=` / `.textContent=` 右边）。
补完立刻被 S11 逼红 ✓。守卫第一次还写错了：`draft\.key` 会连 `draft.keyEntered` 一起命中，
少了词边界就把"读一个布尔量"误报成泄漏 —— 补 `(?![A-Za-z])`。

**探针十二道全红**（其中两道是源码守卫）：去重动了玩家名 · hatch 忽略 nameIndex ·
明文 http 照存 · 一次就清空 · 确认态不过期 · 关页不拆面板 · 出生时不去重 ·
hasKey 真相源分叉 · key 写进节点 · 等。

### Task 7（2026-10-23 做完）—— F-5 遮罩；计划里那条"一层横贯缸底"是错的

| # | 计划 | 实际 | 为什么 |
|---|---|---|---|
| 1 | `drawEggMask` 画**一条**盖住带子下部的矩形，每帧 1 次 `fillRect` | **逐颗**遮，每枚一块、只盖到自己那颗的下沿 | 卵心散布在 y∈[0.78,0.97]。一条通高的横带会把低处那颗**整个**埋掉 —— 而"看不见缸里有卵"比"蛋浮在沙上"更糟。计划那条是我想少了 |
| 2 | 遮罩顶到 `bandTop + cover` | 顶不小于 `bandTop`、且**跳过整颗都在沙面之上的卵** | 不然会在开阔水里画一块沙色矩形 |
| 3 | `drawEggMask(ctx, renderer, world, viewport)` | `drawEggMask(ctx, world, viewport)` | `renderer` 从头到尾没人读 —— 参数也是旋钮 |

**基线数是量的，不是估的**：同一套夹具（11 只 + 2 颗卵）跑一帧，`arc 107 / ellipse 62 / clip 8 /
fillRect 0`。这三个数写进断言，于是"遮罩敢用圆弧就打红那条层序判据"从一句担心变成一条测试。

**给桩加了第二处"记值"例外**（`fillRect` 的四个参数）。理由与当初给 `drawImage` 记 `globalAlpha`
同一条：**这一层的全部语义就是几何**，只数次数测不出"把更深处那颗也埋了" —— 探针 E5
（遮罩一路画到视口底）在次数、颜色、弧线账上**全都无感**，只有几何能抓。加了五条几何断言之后 E5 死了。

六道探针全红：遮罩画在生物之后 · 不跳过沙面之上的卵 · 另造遮罩色 · 改用圆弧 ·
画到视口底 · 根本不画。1048/1048 绿。
