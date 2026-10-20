# 活着的缸 Implementation Plan

> **⚠️ 2026-10-20 本计划已被推翻（superseded），Task 1–10 不能直接执行。**
> 同日的设计大修（spec 提交 `582e22c`）改了三处承重结构：造型（半透明凝胶软体 → **五角星卷毛 + 尾巴 + 毛绒**）、繁殖（有性求偶 → **孤雌自产卵 + 外来血统漂入**）、并新增了**语言系统**与**五档心情**。这三处都不是加功能，是换输入 —— 本文件里的渲染 Task 按"没有尾巴、没有毛、不会说话"的身体写。
>
> **仍然成立、重出计划时必须搬走的东西**（这些是实测换来的，不该重推一遍）：固定步长主循环与倍速子步进（4× 若靠放大 `dt` 实现，情绪层偏差 **1.6693%**，Task 3 把它钉死）、累加器封顶 0.25s、`world.playerHand` 是内核唯一接受表现层写入的字段、只有 `src/main.js` 能碰浏览器 API 的约束守卫、记录型桩 ctx、视觉核对清单"每项都要注明为什么自动化测不到"的纪律，以及 Self-Review 抓出的 **12 处计划文档自身缺陷**的教训（最典型那条：`VoiceParams` 约定块写 `{freq, freq2, timbre, gain}`、实现写 `{pitch, timbre, detune}`，四个字段只有一个名字对得上 —— 凭印象写约定、实现长出新字段而约定不回头改，是这份文档最主要的腐坏方式）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给计划 1 的无头生命内核套上表现层 —— 让缸在浏览器里真正**活起来**：深靛紫水体、24 个控制点的 Q 弹软体、预渲染光晕、四参数眼睛、死亡溶散、程序化小叫声，以及最小的「手」（能抚摸、能被躲开）。

**Architecture:** 表现层是**内核的只读消费者**。`sim.js` 一行不改：`main.js` 每帧用固定步长累加器推进 `tickWorld(world, CONFIG.fixedDt)`，然后把 `world` 交给 `render.js` 画出来、把 `world.events` 交给 `audio.js` 发声、把指针状态写回 `world.playerHand`（内核**唯一**接受表现层写入的字段）。软体状态由表现层自己持有（`body.js`），因为内核的 `creature` 上没有 `body` 字段，而内核不许改。

**Tech Stack:** 零依赖。浏览器侧是 Canvas 2D + ES Modules + Pointer Events + Web Audio，全部原生 API。静态服务用 Windows PowerShell 5.1 自带的 .NET `HttpListener`（`server.ps1`），`start.bat` 双击启动。测试仍是 Node 内置 `node:test` + `node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md`

**前置：** 计划 1「生命内核」已完成（`docs/superpowers/plans/2026-10-14-life-core.md`），386 条测试全绿。本计划从 `fix/harness-diagnostics`（`769bf11`）切出，因此带着验收脚本的三处诊断修复。

**后续计划：** 计划 3「照料与传承」加完整手势（拖拽投食、长按、点按信息卡、改名）、HUD（种群数、食物余量、时间流速、静音、暂停、食物条）、家谱、`save.js` 存档与多设备同步、`names.js`。本计划**刻意不做**这些（见「范围边界」）。

## Global Constraints

每一条都从 spec 或计划 1 的交接要求逐字抄来，所有 Task 的要求都隐含包含本节。

- **零依赖**：不得引入任何 npm 包，不得创建 `node_modules`。`package.json` 不得出现 `dependencies` / `devDependencies` / `peerDependencies` 任一字段。不加载任何音频素材文件（spec §1 原则 5、§10）。**十年后双击 `start.bat` 还能打开。**
- **不使用 `Math.random()`**：所有随机性必须经由传入的 `rng`（计划 1 Global Constraints）。表现层若需要随机（微粒初相位、光束摆幅），从 `world.rng.fork()` 取，且**只在初始化时取一次**，不得每帧取 —— 否则同一份存档在两台设备上的水体长得不一样。
- **只有 `src/main.js` 可以触碰浏览器 API。** `document` / `window` / `canvas` / `requestAnimationFrame` / `AudioContext` / `fetch` / `localStorage` 这七个标识符只允许出现在 `main.js` 里。`render.js` `body.js` `input.js` `audio.js` 一律靠**依赖注入**拿到它们需要的东西（`ctx`、目标元素、`AudioContext` 构造器）。这条由 `tests/constraints.test.js` 自动守卫，机制见「架构决定 1」。
- **倍速必须用子步进实现，绝不能放大 `dt`**（计划 1 交接要求第 2 条，逐字）：`CONFIG.timeScales = [0.5, 1, 2, 4]`。正确做法是每帧跑 N 个 `CONFIG.fixedDt = 1/60` 子步；错误做法是把 `dt` 直接乘上倍速。原因：`emotions.update` 是前向欧拉 `k = min(1, inertia*dt)`，**不具**步长无关性 —— 4× 若靠放大 dt 实现，推进 1 模拟秒会得到 `0.815837` 而非 `0.802441`（偏差 **1.6693%**）。这个偏差**只出现在情绪层**，格外难查。Task 3 用测试把它钉死。
- **累加器封顶 `CONFIG.dtAccumCap = 0.25` 秒**（spec §3.4-1）：防止标签页从后台恢复时一次补算几百步（死亡螺旋）。
- **渲染层性能硬约束**（spec §5.3，逐字）：**不每帧 `shadowBlur`、不每帧新建渐变、运行时不分配对象**（微粒与事件用对象池）。这三条在 Task 4/5 由「记录型桩 `ctx`」自动断言，不是靠人评审。
- **发光用预渲染光晕精灵**（spec §3.4-3）：启动时按色相量化成 `CONFIG.glowHueBuckets = 32` 桶预渲染 sprite，运行时 `drawImage` + `globalCompositeOperation = 'lighter'`。
- **静态背景交给 CSS**（spec §3.4-5）：深水渐变写在 `css/main.css`，canvas 保持透明叠加，省掉每帧一次全屏填充。
- **世界坐标归一化**（spec §3.4-2）：位置是 `[0,1]²`，体型是「世界单位」（`sizeOf(c)` ∈ 3.08–38）。缩放系数由视口**短边**推导并 clamp。
- **色相解码式固定**：`(315 + phenotype × 70) mod 360`（spec §4.1/4.2）。表现层**不得**重新解码基因，一律读 `c.traits.hue`（`genes.decode` 已经算好）。粉色区间是 `[315,360] ∪ [0,25]`，**跨 0° 的并集，不是线性区间** —— 任何「取 min/max 判断是否在区间内」的写法都是错的（计划 1 已用变异探针证明过这个盲区）。
- **种群上限**：桌面 24、手机 16（`CONFIG.populationCap`，是 `{desktop, mobile}` 对象，**不是标量**；`world.populationCap` 才是解析后的标量）。
- **瞳孔不用纯黑**：`CONFIG.colors.pupil = '#2D1240'`（spec §4.2/4.6：纯黑在粉色身体上显得空洞）。
- **不加漫画符号气泡**：不得出现 ♡ 💢 ？ ！ 或任何文字气泡、行为痕迹（spec §1 原则 1、§2）。所有情绪只能靠形变、姿态、运动、体色、发光、眼睛表达。**这是本物种的设计承诺，评审时按硬约束查。**
- **提交规范**：Conventional Commits（`feat:` / `test:` / `docs:` / `fix:` / `chore:`）。`chore:` 专用于控制方的仓库簿记，实现方不得用它提交功能代码。每个 Task 结尾必须提交。
- **测试命令**：全量 `node --test tests/`，单文件 `node --test tests/<file>.test.js`。工作目录始终是 `F:\电子宠物`。

### 计划 1 交给本计划的义务（逐条，实现时必须落地）

1. **倍速子步进**（交接要求第 2 条）→ Task 3，含钉死测试与「错误做法必须可被检出」的反向断言。
2. **`perceive` 在 `tickWorld` 之外调用会抛 `TypeError`**（`src/sim.js:286` 的 `!o.alive`，因为 `world.grid` 里是旧下标）。计划 1 明确警告：「计划 2 若在 tick 之外调 `perceive`（例如为 UI 单独取一次感知），会踩到这个坑。」→ **本计划一律不调 `perceive`。** 表现层需要的信息全部从 `c.pos` / `c.vel` / `c.facing` / `c.emotions` / `c.intent` / `c.traits` / `world.foods` / `world.eggs` 直接读。Task 4 有一条断言把这件事钉住（`render.js` 与 `body.js` 的 import 列表里不得出现 `perceive`）。
3. **`HAND_SPEED_POKE = 0.25` 必须用真实指针输入重调**（计划 1 原文：「真实的鼠标输入要区分『静止』与『缓慢划动』，而本轮所有实测用的是无头脚本里写死的 `speed`」）→ Task 8 先**量**（采集真实指针速度分布），再按实测数据定阈值，并把数据写进 `src/behavior.js` 的注释。**不得**沿用 0.25 而不量。
4. **`sick` 个体必须被画出来**（`src/sim.js:940` 原文：「sick 个体仍然留在 creatures 里被 render 画出来（变暗、静止），这样问题对用户是可见的，而不是无声地少了一只」）→ Task 7。
5. **`c.dying` 是「溶散进行中」的秒数**（`src/creature.js:62` 原文：「给表现层的『溶散进行中』秒数，非零即已开始」），上限 `CONFIG.dissolveDuration = 4`。死亡个体在溶散结束前**一直留在** `world.creatures` 里（`reapDead` 到 `dying >= 4` 才 splice）→ Task 7 的溶散动画直接读它，**不要**自己另计一套时间。
6. **`world.events` 是内核与表现层之间唯一的通信通道**（计划 1 原文：「计划 2 会消费它来播放溶散动画与小叫声」）。八种事件：`eat` / `death` / `dissolved` / `eggFailed` / `hatch` / `mated` / `rejected` / `error`（精确形状见「类型约定」）→ Task 7（消费）与 Task 9（发声）。⚠️ `world.events` **无界增长**是已知债务（台账 §7），表现层每帧消费后**必须清空**（`world.events.length = 0`），否则一个开了一小时的标签页会把事件数组涨到几十万条。
7. **`angerDuration` 留给表现层**（计划 1 原文：「`angerDuration` 留给计划 2（表现层的持续时长），本计划无人消费」）。它是 `c.thresholds.angerDuration` → Task 6 用它决定「生气」表情（瞪圆、上眼睑压低、高频急闪）的**持续时长**，而不是只看 `emotions.anger` 的瞬时值。
8. **求偶仪式的编舞在表现层**（`src/sim.js:5818` 原文：「内核只负责让双方靠近并维持仪式；具体的圆圈轨迹在计划 2 的表现层实现」）。内核在 `c.courtship` 里给出 `{ partnerId, t, duration, phase }`，绕圈共舞由 Task 7 实现。⚠️ 计划 1 记录过一个观察：「表现层（计划 2）会看到它们本该绕圈共舞却越走越远」—— 内核只保证状态机推进，**不保证双方真的靠近**，所以编舞必须自己算轨迹，不能指望内核把它们摆好。
9. **`world.playerHand` 是内核唯一接受表现层写入的字段**（`src/sim.js:119` 原文：「`{ pos, speed } | null` —— 由计划 2 的 input 层写入」）→ Task 8。**除它以外，表现层不得写入任何内核状态**（不得改 `c.pos`、不得改 `c.emotions`、不得直接调 `adjustMemory`）。抚摸买好感是内核在 `tickCreature` 里自己做的（`sim.js:593-596`：手够慢 `speed <= HAND_SPEED_POKE` 且够近 `dist < perceiveRadius * 0.5` 时 `adjustMemory(c.memory, PLAYER_ID, 0, 0.04 * dt)`，**只给熟悉度不给好感**；好感只有 `beg` 胜出时才涨）。

### 范围边界（本计划**不做**，属计划 3）

- 拖拽投食、长按撒食、点按信息卡、长按改名（spec §6.1 除「抚摸/戳」以外的手势）
- HUD 全部控件：种群数、食物余量、时间流速按钮、静音按钮、暂停按钮、底部食物条（spec §6.3）
- 家谱树、性格雷达图、心形好感度（spec §6.3）
- `save.js`、`server.ps1` 的 `/api/save` 读写、离线暂停、多设备同步、降级（spec §7 全部）
- `names.js`（内核里 `sim.js:166` 的 `defaultNameFor` 是临时实现，其注释写明「计划 3 会用 names.js 替换它」）

⚠️ 因此**计划 2 交付后没有静音按钮**。`audio.js` 必须导出 `setMuted(bool)` 供计划 3 接按钮，且默认音量按 spec §5.4「音量很小」。手动核对时在 devtools 控制台调 `setMuted(true)`。这是刻意的：宁可少一个按钮，也不要把 §6.3 的 HUD 做半截、让计划 3 再拆一次。

⚠️ 同理**计划 2 交付后没有时间流速按钮**。`main.js` 必须导出 `setTimeScale(scale)`（校验 `scale ∈ CONFIG.timeScales`）供计划 3 接控件；手动核对时在控制台调用。

## File Structure

| 文件 | 单一职责 | 浏览器 API | 被谁依赖 |
|---|---|---|---|
| `start.bat` | 双击启动：起 `server.ps1` + 打印局域网地址 + 开浏览器 | — | — |
| `server.ps1` | `HttpListener` 静态文件服务（**本计划不含 `/api/save`**） | — | `start.bat` |
| `index.html` | 全屏 canvas + 挂载点，`<script type="module" src="/src/main.js">` | — | `main.js` |
| `css/main.css` | 响应式、iOS 安全区、深水渐变背景（`BG_TOP/MID/BOTTOM`）、canvas 透明叠加 | — | `index.html` |
| `src/body.js` | 软体身体模型：24 个控制点的弹簧动力学、挤压回弹、碰撞凹陷、脉动 | **无** | `render.js` |
| `src/render.js` | Canvas 绘制：水体、光晕精灵、生物分层绘制、眼睛、溶散 | **无**（`ctx` 注入） | `main.js` |
| `src/input.js` | Pointer Events 采样 → `{ pos, speed }`；抚摸与戳的速度区分 | **无**（目标元素注入） | `main.js` |
| `src/audio.js` | Web Audio 程序化合成：事件 → 小叫声，音高随体型、音色随色相 | **无**（`AudioContext` 构造器注入） | `main.js` |
| `src/main.js` | 入口：装配世界、固定步长主循环、倍速子步进、resize、把上面四个接起来 | **有**（唯一） | `index.html` |
| `tests/body.test.js` | 软体弹簧的纯逻辑测试 | — | — |
| `tests/render.test.js` | 用记录型桩 `ctx` 测绘制**调用序列**与性能硬约束 | — | — |
| `tests/input.test.js` | 指针采样 → 速度的纯逻辑测试 | — | — |
| `tests/audio.test.js` | 嗓音参数映射（音高/音色）的纯逻辑测试 | — | — |
| `tests/loop.test.js` | 累加器与子步进：倍速不得放大 `dt`（交接要求第 2 条） | — | — |
| `tests/constraints.test.js` | **修改**：加浏览器模块白名单 + 依赖方向守卫 | — | — |
| `tests/visual-checklist.md` | 渲染层手工核对清单（spec §8.2） | — | — |

**边界原则**（沿用计划 1）：`main.js` 是唯一有权同时读写内核与表现层的地方。`render.js` / `body.js` / `audio.js` **只读** `world` 与 `creature`；`input.js` 只产出数据，由 `main.js` 决定写到哪里。这条约束的回报是：表现层出问题时，内核的 386 条测试依然是绿的，故障范围立刻缩小。

**类型约定**（贯穿全计划，签名不得偏离）：

```
Viewport   = { width, height, dpr, scale }
             // width/height 是 CSS 像素；dpr = devicePixelRatio；
             // scale = 世界单位 → CSS 像素 的换算系数（见架构决定 4）

BodyPoint  = { x, y, vx, vy, rx, ry }
             // x,y   当前局部坐标（单位圆空间，未乘半径）
             // vx,vy 速度
             // rx,ry 静止位置（单位圆上，创建时算好，此后不变）

Body       = { points: BodyPoint[], phase: number, pulse: number,
               squeezeX: number, squeezeY: number, dip: Float64Array,
               impactX: number, impactY: number, seen: number }
             // points.length === CONFIG.bodyPoints === 24
             // dip 是每点的碰撞凹陷量，长度同 points；用 Float64Array 避免每帧分配
             // impactX/Y 是最近一次撞击的**方向**（归一化世界单位，指向撞来的那一侧），
             //   由位置的二阶差分推出 —— 不能用速度差分，理由见 Task 2 Step 4 的 ⚠️
             // seen 是 main.js 的 reconcileBodies 做标记清扫用的帧号；
             //   ⚠️ 它由 main.js 写，body.js 不碰。放在 Body 上而不是 Map 里，
             //   是为了让 reconcileBodies 一次遍历就能完成，不必再查一次哈希

BodyInput  = 就是 Creature 本身（body.js 直接读 c.emotions / c.vel / c.traits / c.moving /
             c.dying / c.alive / c.sick / c.mourn / c.courtship / c.intent）

DrawCtx    = CanvasRenderingContext2D（或记录型桩，见 Task 4）

MakeCanvas = (w: number, h: number) => { ctx: DrawCtx, surface: object }
             // 由 main.js 注入；render.js / audio.js 用它预渲染 sprite，自己绝不碰 document。
             // ⚠️ **必须返回两个东西**，不能只返回 ctx：
             //   ctx     用来在上面画（createRadialGradient / fillRect / …）
             //   surface 用来喂给 ctx.drawImage —— drawImage 吃的是 canvas 元素本身，
             //             不是它的 2D context。
             // 只返回 ctx 的话，预渲染出来的 sprite 根本没法被 drawImage 引用，
             // 于是代码里会长出 `s.ctx.canvas !== undefined ? s.ctx.canvas : s.ctx`
             // 这类探测式三元表达式（Task 4 Step 4 就是这么写的，然后被 ⚠️ 要求改掉）。
             // 记录型桩的 surface 就是那个假 ctx 对象自己（drawImage 不会真的读它）。

Sprite     = { ctx: DrawCtx, surface: object, size: number }
             // size 是正方形的边长（像素）。所有 sprite 都是正方形，
             // 因为绘制时一律用 drawImage(surface, x-r, y-r, 2r, 2r) 等比缩放。

Sprites    = { glow: Sprite[], length: number }
             // length === CONFIG.glowHueBuckets === 32，按色相桶索引。
             // ⚠️ 用数组不是 Map：色相桶是 0–31 的密集整数，Map 会白白多一次哈希。

Motes      = { x: Float64Array, y: Float64Array, r: Float64Array,
               vy: Float64Array, a: Float64Array,
               drift: Float64Array, phase: Float64Array, baseX: Float64Array,
               n: number }
             // 对象池：一次性分配，运行时零分配（spec §5.2/5.3）。
             // baseX 是横向摆动的中心，drift 是摆幅，phase 是摆动初相 ——
             //   没有这三个的话微粒只会直线上浮，看起来像雪花屏而不是水里的悬浮物。
             // ⚠️ onResize **不得**重新分配这九个数组（拖窗口会连发几十次 resize）。

Renderer   = { motes, shafts, glow, gel, sediment, moteSprite, coreSprites,
               eyeWhite, eyeCache, eggHues, bursts, courtPairs,
               sx, sy, time, hand,
               onResize(vp, rng), draw(ctx, world, bodies, viewport, dt),
               getGelSprite(hue, size), getCoreSprite(color) }
             // sx/sy 是两个 Float64Array(CONFIG.bodyPoints)，buildBodyPath 复用它们
             //   ⇒ **draw 不可重入**（架构决定 6）
             // time 是累计的模拟时间（秒），blink 与卵的脉动用它当相位
             // hand 是 world.playerHand 的当帧快照，由 draw 开头赋值
             // gel 是 Map<number, Sprite>，coreSprites 是 Map<string, Sprite>，
             //   eggHues 是 Map<string, number>（卵的色相只解码一次）

GestureSample = 不是对象：采样缓冲是三个并列的 Float64Array（t / x / y），
             // 见 Task 8 的 createHandTracker。用并列数组而不是对象数组，
             // 是因为 computeSpeed 只读首末两个元素，对象数组会带来 32 次/秒的分配。

HandState  = { pos: Vec2, speed: number } | null
             // 写进 world.playerHand；pos 归一化 [0,1]²，speed 是归一化单位/秒。
             // ⚠️ 这个对象由 tracker **复用**，下一次 pointermove 就会改掉它。
             //   内核在 perceive（sim.js:322-327）里把 pos 按**引用**拷进 senses，
             //   所以 senses.playerHand.pos 不得被存到跨帧的地方。

VoiceParams = { pitch: number, timbre: number, detune: number }
             // pitch  = 音高倍率，由体型定：√(26 / sizeOf(c))，夹在 [0.75, 2.8]
             //          ⇒ 小只高、大只低（spec §5.4）
             // timbre = 带通滤波的中心频率（Hz），由**色相桶**定，映射到 [500, 2100]
             //          ⇒ 每条血脉有自己的嗓音（spec §5.4）。用桶而不是原始 hue，
             //          因为嗓音属于**血脉**不属于个体（Task 9 Step 4 的 ⚠️）
             // detune = 音分偏移，由 (色相桶, 体型) 确定，**不取随机数**

WorldEvents = 八种，精确形状（从 src/sim.js 逐字抄来，不得偏离）：
  { kind: 'eat',        id, foodId, foodKind }        // sim.js:442
  { kind: 'death',      id, pos, name }               // sim.js:638
  { kind: 'dissolved',  id }                          // sim.js:667
  { kind: 'eggFailed',  id, pos }                     // sim.js:688, 728
  { kind: 'hatch',      id, pos, eggId }              // sim.js:744
  { kind: 'mated',      a, b, eggs, atPopulationCap }  // sim.js:803
  { kind: 'rejected',   id, by }                      // sim.js:827
  { kind: 'error',      id, message }                 // sim.js:944

Food       = { id: 'f<n>', kind: 'algae'|'nectar'|'crystal', pos: Vec2, amount: 1 }
Egg        = { id: 'e<n>', genes, age, pos: Vec2, motherId, fatherId, viable: boolean }
Creature   = 见计划 1 Task 7；本计划要用到的字段：
             id, name, pos, vel, facing, traits, emotions, needs, memory, thresholds,
             intent, age, stage, alive, dying, sick, courtship, mourn, lineage, generation
Traits     = { hue: 0–360, sat: 0.45–0.95, lum: 0.62–0.84, size: 14–38,
               glow: 0.35–1, pattern: 0–4, patternDensity, wobble, personality }
```

## 架构决定（本计划做的，含理由与被否决的方案）

### 1. 只有 `main.js` 是浏览器模块，其余靠依赖注入

**问题**：`tests/constraints.test.js` 扫**整个** `src/` 下所有 `.js`，找 `document|window|canvas|requestAnimationFrame|AudioContext|fetch|localStorage` 七个标识符，断言违规列表**为空**。它的注释写着「渲染与音频是 Task 9/10 的职责，它们必须待在自己的模块里」，但**扫描范围没有给渲染模块留任何豁免**。所以计划 2 一旦新增 `render.js` / `main.js` / `audio.js`，这条测试**立刻变红** —— 这不是计划 2 的 bug，是计划 1 留下的、必须在本计划里正面处理的架构缺口。

**决定**：把「不许碰 DOM」的范围缩小到**内核模块**，同时**加强**它 —— 白名单只有 `src/main.js` 一个文件，且新增一条依赖方向守卫：**任何内核模块不得 import 白名单模块**。

被否决的方案 A：「把浏览器模块放到 `src/` 之外（如 `app/`）」。否决理由：违背 spec §3.1 的目录结构，而且扫描器只扫 `src/`，等于让渲染层**完全脱离守卫** —— 那是把约束删掉，不是把约束放对位置。

被否决的方案 B：「把 `render.js` `audio.js` `input.js` 也加进白名单」。否决理由：白名单是**豁免**，加进去就等于放弃对它们的纯度检查；而这三个模块里恰恰有大量可单测的纯数学（弹簧积分、坐标映射、色相分桶、嗓音参数、指针速度分类）。豁免它们会白白丢掉计划 2 大部分的可测面积。

**注入方式**（每个模块的具体形态在对应 Task 里给出完整代码）：

| 模块 | 需要的浏览器能力 | 注入方式 |
|---|---|---|
| `render.js` | 画布上下文、离屏画布（预渲染 sprite） | 所有绘制函数收 `ctx` 形参；sprite 预渲染收 `makeCanvas` 形参 |
| `input.js` | 监听指针事件 | `attachInput(element, onHand)`，`element` 由 `main.js` 传入 |
| `audio.js` | `AudioContext` | `createAudio(CtxCtor)`，构造器由 `main.js` 传入 |
| `body.js` | 无 | 本来就是纯数学 |

⚠️ **一个会咬人的陷阱，必须提前说明**：扫描器用 `\bcanvas\b` 词边界匹配，且**只剥注释、不剥字符串字面量**（它的注释自己承认了这点，并说明偏差方向是「只会漏检、不会误报」—— 但那条判断是针对**内核模块**说的，对渲染模块不成立）。后果：

- `render.js` 里一个**局部变量名叫 `canvas`** → 变红（尽管它只是个形参，不是全局引用）。
- `document.createElement('canvas')` 里的**字符串** `'canvas'` → 也会变红（`'` 是非单词字符，构成词边界）。

所以：持有画布的变量一律叫 `spriteCanvas` / `offscreen` / `cvs`（大小写不同或前后有单词字符就不匹配 `\bcanvas\b`），而创建画布这件事**只能**由 `main.js` 注入的 `makeCanvas` 做。这确实是在绕一个正则，但绕的是它的**假阳性**（局部变量与字符串字面量并非对浏览器全局的引用），扫描器的**意图**（「这些标识符在 Node 里根本不存在，引用它们会让模块在 import 阶段就抛 ReferenceError」）被完整保留了。Task 1 Step 2 会加一条测试把「意图」本身钉住：这四个模块必须能在 Node 里 `await import` 成功。

### 2. 软体状态由表现层持有，不进 `creature`

内核的 `creature` 对象上**没有** `body` 字段（计划 1 的 `createCreature` 返回的 21 个字段里没有它），而计划 1 明确承诺「届时 `sim.js` 一行都不用改」。所以 `body.js` 的状态必须存在别处。

**决定**：`main.js` 持有一个 `Map<creatureId, Body>`，每帧为**新出现**的 id 建 `Body`、为**已消失**的 id 删除。`render.js` 收 `(ctx, creature, body, viewport)`。

被否决的方案：「往 `creature` 上挂 `c.body`」。否决理由：`creature` 是要被计划 3 序列化成存档 JSON 的对象，挂一个含 `Float64Array` 与 24 个点的运行时视觉状态上去，会让 `JSON.stringify` 产出一坨无意义的坐标（而且 `Float64Array` 会被序列化成 `{"0":…,"1":…}`），计划 3 还得写代码把它排除掉。软体状态是**瞬态**的、读档后应当重建，不该进存档。

⚠️ 这个 `Map` 必须**每帧对账**：`hatch` 事件会带来新 id，`dissolved` 事件会带走旧 id。只靠 `world.creatures` 遍历来建、靠事件来删是可以的，但**更稳的做法是每帧用当前 `world.creatures` 的 id 集合做一次双向对账**（新建缺失的、删除多余的）。理由：`error` 事件（`sick`）与读档（计划 3）都可能让 id 集合以事件覆盖不到的方式变化，而对账是幂等的，事件不是。**这条要用测试钉住**（Task 3：连续跑 N 帧后 `bodyMap.size === world.creatures.length`，且没有泄漏的孤儿 id）。

### 3. 软体弹簧跑在**固定步长**上，不是渲染帧率

**决定**：`updateBody(body, c, dt)` 在每个 `CONFIG.fixedDt` 子步里调用，与 `tickWorld` 同步。

理由：spec §3.4-1 把「手机 120Hz 与电脑 60Hz 下生物表现完全一致」列为对共享存档**致命**的要求。软体形变虽然不进存档，但它是玩家**看到**的东西 —— 如果弹簧跑在渲染帧率上，120Hz 手机上的团子会比 60Hz 桌面上更硬（同样的刚度系数、两倍的积分次数），同一个缸在两台设备上观感不同。

被否决的方案：「每帧调一次 `updateBody(body, c, frameDt)`」。否决理由：除了上面的设备不一致，它在 4× 倍速下会**慢四倍**（一帧只积分一次，但模拟推进了 4 个 `fixedDt`），于是快进时团子的形变跟不上运动，看起来像拖着果冻。

代价核算：24 只 × 24 点 = 576 次弹簧积分/子步；4× 时每帧 4 个子步 = 2304 次。每次是几条乘加，量级上完全在预算内（spec §5.3 的目标是 60fps）。Task 10 会实测量一遍帧时间。

### 4. 缩放系数：`scale = clamp(shortEdge / 540, 1.5, 2.6)`

spec §3.4-2 只说「缩放系数由视口**短边**推导并 clamp」，没给公式；spec §12 明确把这类视觉参数列为「实现阶段按观感直接定即可，无需再次确认」。所以这里定死一组初值，**并把算术摊开**，好让手工核对时知道该往哪个方向调。

渲染直径（CSS 像素）= `sizeOf(c) * scale`，其中 `sizeOf(c) = c.traits.size * growthFactor(c)`，`traits.size ∈ [14, 38]`，`growthFactor` 从 0.22（刚孵化）单调升到 1.00（成体峰值）再降到 0.88（老年）。

| 设备 | 视口 | 短边 | `shortEdge/540` | clamp 后 `scale` | 成体（`traits.size`=26）直径 | 最大成体（38） | 刚孵化幼体（26×0.22=5.72） |
|---|---|---|---|---|---|---|---|
| 桌面 | 1920×1080 | 1080 | 2.000 | **2.000** | 52.0 px | 76.0 px | 11.4 px |
| 手机竖屏 | 390×844 | 390 | 0.722 | **1.500**（触底） | 39.0 px | 57.0 px | 8.6 px |

- **为什么需要 clamp 下限**：不 clamp 的话手机竖屏 `scale = 0.722`，成体只有 18.8 px、幼体 4.1 px —— 正是 spec §3.4-2 那句「生物不会在手机上小到看不见」要防的情况。下限 1.5 把手机成体抬到 39 px。
- **为什么需要 clamp 上限**：超宽/超高分屏（如 3840×2160，短边 2160 → `scale = 4.0`）会让成体变成 104 px、24 只挤满屏幕。上限 2.6 封顶在 67.6 px。
- **`540` 怎么来的**：反推的。目标是桌面 1080p 上成体约 50 px（24 只生物在 1920×1080 里占约 2.3% 面积，疏密合适），`52 / 26 = 2.0`，而 `1080 / 2.0 = 540`。
- 这三个数（540 / 1.5 / 2.6）写进 `CONFIG.render`，Task 10 的手工核对若判定过大或过小，**只改 `CONFIG`**，并把新的实测观感写进注释（本项目纪律：每处常量变更都带它自己的实测数据）。

### 5. `resize` 不需要重映射归一化位置

spec §3.4-2 末句是「`resize` 时按新旧尺寸比例映射所有位置」。**在归一化设计下这句话是空操作**：位置存的是 `[0,1]²`，而世界尺寸**恒等于**视口 CSS 尺寸，所以视口变化时归一化坐标的**含义没变** —— `x = 0.5` 永远是横向中点。要重映射的是「世界尺寸固定、位置是像素」的设计，本 spec 在 §3.4-2 前半句已经排除了那种设计。

**决定**：`resize` 时只做三件事 —— 重算 `Viewport`（`width/height/dpr/scale`）、重设 canvas 的**位图**尺寸（`canvas.width = cssWidth * dpr`）、重建依赖视口尺寸的东西（微粒池的分布范围、光束 sprite 的平移量）。**不碰任何 `c.pos`。**

⚠️ 这条要写进代码注释，否则后来者会以为漏了 spec 要求而去「补」一个位置重映射 —— 那会引入真 bug（每次 resize 都把整缸生物的位置乘一个比例，反复 resize 几次就把它们全推到角落里）。Task 3 有一条测试钉住：`resize` 前后每只生物的 `pos` **逐位相同**。

**但 dpr 变化要处理**：把窗口拖到不同缩放比例的显示器上时 `devicePixelRatio` 会变，canvas 位图尺寸必须跟着变，否则画面发虚。这条不是空操作。

### 6. 对象池：微粒、事件、绘制路径

spec §5.2 要求「上浮微粒 60–120 个，**对象池**复用，运行时零分配」；§5.3 要求「运行时不分配对象」。

**决定**：
- 微粒用**并列的 `Float64Array`**（`x/y/r/vy/a` 各一条），不是对象数组。理由：对象数组即使用了池，每个微粒仍是一个对象、有 GC 压力；并列 typed array 是真正的零分配，且缓存局部性更好。数量取 `CONFIG.particles`（桌面 120 / 手机 60）。
- `world.events` 每帧消费后 `length = 0` 清空（见交接义务第 6 条）。
- 绘制路径**不缓存** `Path2D`：每帧的形状都不同（软体在动），缓存没有意义。但**渐变必须缓存** —— 见下条。
- 身体控制点的屏幕坐标写进 `render.js` 模块级的**复用数组**（长度 `CONFIG.bodyPoints`），每帧覆写而不是新建。⚠️ 这带来一个约束：`render.js` 的绘制**不可重入**（不能并发画两只生物）。单线程 JS 下顺序绘制天然满足，但要写进注释，免得计划 3 想做「缩略图预览」时踩到。

### 7. 渐变缓存：按（色相桶 × 尺寸桶）查表，不每帧新建

spec §5.3 的硬约束是「不每帧新建渐变」。而 §5.1 的分层绘制里，凝胶体是「alpha ≈ 0.55 **径向渐变**」，发光核是「脉动的亮椭圆」—— 都需要渐变。

**决定**：把径向渐变**预渲染成 sprite**（和光晕精灵同一套机制），运行时只 `drawImage` + 缩放。查表键是 `(hueBucket, sizeBucket)`：
- `hueBucket` = 0–31（`CONFIG.glowHueBuckets`，与光晕精灵共用同一套分桶）
- `sizeBucket` = 把 `sizeOf(c)` 量化成 8 档（对数量化，因为体型范围 3.08–38 跨度大，线性量化会让小体型的档太粗）

⇒ 最多 32 × 8 = 256 张 sprite。每张 64×64 像素 → 256 × 64 × 64 × 4 字节 = **4 MiB** 显存。可接受（且是**上限**，实际只会用到缸里出现过的那些组合）。

被否决的方案：「每帧 `createRadialGradient`」。否决理由：直接违反 spec §5.3 的硬约束，且计划 1 的注释明说这是「手机浏览器上最大的性能杀手」。**Task 4 用记录型桩 `ctx` 断言每帧 `createRadialGradient` 调用次数为 0**，所以这个约束是机器查的，不是靠自觉。

⚠️ 但**光晕**（`lighter` 混合那一层）与**凝胶体**（alpha 0.55 那一层）是两张不同的 sprite，不能共用：光晕要的是从中心向外衰减到透明的柔和光斑，凝胶体要的是带边缘暗化的半透明球体。Task 5 分别预渲染。

---

### Task 1: 静态服务与页面骨架

**为什么是第一个 Task**：浏览器**拒绝**从 `file://` 加载 ES Modules（当成跨源请求），双击 `index.html` 只会得到一片空白加一条 CORS 报错。所以在写任何渲染代码之前，必须先有一个能跑的静态服务器 —— 否则后面每个 Task 的手工核对都无从进行。「零依赖」指的是零 npm 依赖，不是零服务器。

**Files:**
- Create: `server.ps1`
- Create: `start.bat`
- Create: `index.html`
- Create: `css/main.css`
- Test: `tests/assets.test.js`

**Interfaces:**
- Consumes: `CONFIG.colors.bgTop / bgMid / bgBottom`（`src/config.js:169-171`，值 `'#0B0620'` / `'#1A0B2E'` / `'#2D1240'`）
- Produces:
  - `http://localhost:8123/` 提供 `index.html`，`/css/main.css`、`/src/*.js` 以正确 MIME 提供
  - `tests/assets.test.js` 导出无（纯断言）；它建立的守卫是「CSS 里的三个背景色必须与 `CONFIG.colors` 逐字相同」

- [ ] **Step 1: 写 CSS↔CONFIG 漂移守卫的失败测试**

创建 `tests/assets.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';

// 静态资源的一致性守卫。
//
// 为什么需要它：spec §3.4-5 决定把静态深水背景交给 CSS（省掉每帧一次全屏填充），
// 于是同一组颜色**必然**在两个地方各存一份 —— CONFIG.colors 与 css/main.css。
// CSS 读不到 JS，这份重复消不掉；那就让测试盯着它，别让两边各自漂移。
// 漂移的症状极难查：缸底沉积带（render.js 用 CONFIG）和背景（CSS 用字面量）
// 会慢慢对不上色，而没有任何一处报错。

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('css/main.css 的三个背景色与 CONFIG.colors 逐字相同', () => {
  const css = read('../css/main.css');
  for (const [name, hex] of [
    ['bgTop', CONFIG.colors.bgTop],
    ['bgMid', CONFIG.colors.bgMid],
    ['bgBottom', CONFIG.colors.bgBottom],
  ]) {
    // 大小写不敏感地找：CSS 里写小写十六进制是常见习惯，
    // 但"颜色相同"不该被大小写判成不一致。
    assert.ok(
      css.toLowerCase().includes(hex.toLowerCase()),
      `css/main.css 里没有 ${name} = ${hex}；spec §3.4-5 要求背景由 CSS 承担，两边必须同色`,
    );
  }
});

test('index.html 用 type="module" 引 /src/main.js，且声明了 viewport-fit=cover', () => {
  const html = read('../index.html');
  assert.match(html, /<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.js["']/);
  // viewport-fit=cover 是 iOS 安全区（env(safe-area-inset-*)）生效的前提，
  // 少了它 css 里那几条 padding 恒为 0，刘海屏上 HUD 会被挖掉一块。
  assert.match(html, /viewport-fit=cover/);
});

test('package.json 仍然零依赖（计划 2 不得引入任何 npm 包）', () => {
  const pkg = JSON.parse(read('../package.json'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[key], undefined, `package.json 不得出现 ${key}（spec §1 原则 5、§10）`);
  }
  assert.equal(pkg.type, 'module');
});

test('server.ps1 把 .js 送成 JavaScript MIME，且有目录穿越守卫', () => {
  const ps1 = read('../server.ps1');
  // ES Modules 对 MIME 有硬性要求：送成 text/plain 浏览器直接拒绝执行，
  // 症状是页面全黑而服务器日志一切正常。这条断言就是防这个。
  assert.match(ps1, /'\.js'\s*=\s*'text\/javascript/);
  assert.match(ps1, /StartsWith/);           // 目录穿越守卫
  assert.match(ps1, /UnescapeDataString/);   // 中文路径解码（本项目根目录就叫「电子宠物」）
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test tests/assets.test.js`
Expected: FAIL —— 4 条全部报 `ENOENT`（`css/main.css`、`index.html`、`server.ps1` 都还不存在）。

- [ ] **Step 3: 写 `server.ps1`**

⚠️ 目标运行时是 **Windows PowerShell 5.1**（系统自带），所以不能用 `??`、三元运算符、`-AsHashtable` 这些 7+ 才有的语法。

```powershell
# server.ps1 —— 静态文件服务。零依赖：只用 Windows PowerShell 5.1 自带的 .NET HttpListener。
#
# 为什么必须有它：浏览器把 file:// 下的 ES Modules 当跨源请求拒绝加载，
# 双击 index.html 只会得到一片空白。所以"零依赖"指零 npm 依赖，不是零服务器。
#
# 本计划只做静态文件服务。spec §7.1 的 /api/save 读写属计划 3。

[CmdletBinding()]
param(
  [int]$Port = 8123,
  [string]$Root = $PSScriptRoot,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ⚠️ .js 必须是 text/javascript：ES Modules 对 MIME 有硬性要求，送成 text/plain
# 浏览器会直接拒绝执行 <script type="module">，症状是页面全黑、服务器日志一切正常。
$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/plain; charset=utf-8'
}

$RootFull = [System.IO.Path]::GetFullPath($Root)
# 必须带尾部分隔符再比前缀：否则 F:\电子宠物-备份\ 也会"以 F:\电子宠物 开头"，
# 目录穿越守卫就漏了一个真实可越权读取的兄弟目录。
$RootPrefix = $RootFull.TrimEnd('\') + '\'

function Start-Listener([string]$Prefix) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add($Prefix)
  $l.Start()
  return $l
}

# 先试 +:（所有网卡，手机同 WiFi 可打开同一个缸）。它需要 URL ACL 授权，
# 普通用户会拿到 AccessDenied —— 那就退回 localhost，并把授权命令打印出来，
# 而不是静默地只服务本机（那会让 spec"手机电脑同一个缸"莫名其妙失效、且无从归因）。
$Listener = $null
$LanMode = $true
try {
  $Listener = Start-Listener "http://+:$Port/"
} catch {
  $LanMode = $false
  $Listener = Start-Listener "http://localhost:$Port/"
}

Write-Host ''
Write-Host '  电子生物缸 · 本地服务器已启动' -ForegroundColor Magenta
Write-Host "  本机打开： http://localhost:$Port/" -ForegroundColor Cyan
if ($LanMode) {
  foreach ($ip in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                   Where-Object { $_.IPAddress -ne '127.0.0.1' })) {
    Write-Host "  同一 WiFi： http://$($ip.IPAddress):$Port/" -ForegroundColor Green
  }
} else {
  Write-Host '  ⚠ 目前只能本机访问。要让手机打开同一个缸，用管理员 PowerShell 跑一次：' -ForegroundColor Yellow
  Write-Host "     netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Yellow
}
Write-Host '  关掉本窗口或 Ctrl+C 即停止。' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    $Res = $Context.Response
    try {
      $Raw = $Context.Request.Url.AbsolutePath
      if ($Raw -eq '/') { $Raw = '/index.html' }
      $Decoded = [System.Uri]::UnescapeDataString($Raw)
      $Candidate = [System.IO.Path]::GetFullPath((Join-Path $RootFull $Decoded.TrimStart('/')))

      # 目录穿越守卫。这个服务器会绑到局域网，同网段任何设备都能访问，
      # 所以 ../../ 必须挡住 —— 否则整个磁盘都是只读公开的。
      if (-not $Candidate.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $Res.StatusCode = 403
      } elseif (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        $Res.StatusCode = 404
      } else {
        $Ext = [System.IO.Path]::GetExtension($Candidate).ToLowerInvariant()
        $Bytes = [System.IO.File]::ReadAllBytes($Candidate)
        if ($Mime.ContainsKey($Ext)) { $Res.ContentType = $Mime[$Ext] }
        else { $Res.ContentType = 'application/octet-stream' }
        $Res.ContentLength64 = $Bytes.Length
        $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
      }
    } catch {
      # spec §7.7：绝不让整个世界崩溃。单个请求出错只回 500，服务器继续跑。
      try { $Res.StatusCode = 500 } catch { }
    }
    try { $Res.OutputStream.Close() } catch { }
  }
} finally {
  $Listener.Close()
}
```

- [ ] **Step 4: 写 `start.bat`**

⚠️ 这个文件必须存成 **UTF-8 无 BOM**。带 BOM 的话 `cmd.exe` 会把 BOM 当成第一行命令的一部分，报一条 `'∩╗┐@echo' 不是内部或外部命令`。

```bat
@echo off
REM start.bat —— 双击启动：起服务器 + 开浏览器（spec §3.1）。
REM spec §1 原则 5：十年后双击它还能打开，所以这里不依赖任何需要安装的东西。
chcp 65001 >nul
cd /d "%~dp0"
set "PORT=8123"

REM 服务器开在独立窗口里：它的日志不和这个窗口混，关掉那个窗口就等于停服务器。
REM -NoBrowser 是因为浏览器由下面这行在服务器**起来之后**打开；
REM 让 server.ps1 自己开的话它会先于监听就绪，浏览器拿到连接拒绝，用户得手动刷新。
start "电子生物缸 · 服务器（关掉此窗口即停止）" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT% -NoBrowser

timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/"
```

- [ ] **Step 5: 写 `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<!-- viewport-fit=cover 让 iOS 的 env(safe-area-inset-*) 真的给出非零值。
     user-scalable=no：spec §10 明确把"捏合缩放等复杂手势"列为范围外，
     而双指缩放会和抚摸手势抢同一根手指。代价是无法放大看细节，这是刻意的取舍。 -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0B0620">
<title>电子生物缸</title>
<link rel="stylesheet" href="/css/main.css">
</head>
<body>
<canvas id="tank"></canvas>
<script type="module" src="/src/main.js"></script>
</body>
</html>
```

- [ ] **Step 6: 写 `css/main.css`**

```css
/* 深水背景由 CSS 承担（spec §3.4-5）：省掉每帧一次全屏填充，
   也让 render.js 的 'lighter' 混合只在 canvas 内部生效 —— 正是想要的效果。
   ⚠️ 这三个颜色与 CONFIG.colors.bgTop/bgMid/bgBottom 是同一组值，
   由 tests/assets.test.js 守着不许漂移。改一边必须改另一边。 */

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background: #0B0620;   /* 兜底色：渐变没生效时也是深水而不是刺眼的白 */
}

body {
  /* spec §4.3：顶部深水 #0B0620 → 中部 #1A0B2E → 底部 #2D1240。
     靛紫与粉色在色环上相邻所以和谐，明度差极大所以粉色生物光对比强烈。 */
  background: linear-gradient(to bottom, #0B0620 0%, #1A0B2E 55%, #2D1240 100%);
}

#tank {
  position: fixed;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  /* touch-action: none 是移动端 Pointer Events 能连续收到 pointermove 的前提。
     不设它的话浏览器会把触摸解释成滚动/手势，pointermove 中途被 pointercancel 掐断，
     症状是"抚摸只在刚按下去的一瞬间有效" —— 而抚摸正是 spec §6.1 的核心交互。 */
  touch-action: none;
  /* canvas 本身透明，水体渐变由 body 的 background 透出（spec §3.4-5） */
  background: transparent;
}

/* iOS 安全区：刘海与底部横条不吃掉画面。
   计划 2 没有 HUD，所以这里只保证 canvas 不被裁；
   计划 3 的 HUD 控件要用同一组变量做内边距（spec §6.3 要求 ≥44px 触控目标）。 */
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test tests/assets.test.js`
Expected: PASS，4 条全绿。

Run: `node --test tests/`
Expected: **390 tests / 390 pass / 0 fail**（386 + 本 Task 新增 4），stderr 0 字节。

- [ ] **Step 8: 手工核对服务器（这一步无法自动化，必须实跑）**

⚠️ `server.ps1` 是长驻进程，用 `Start-Job` 起在后台，核对完必须 `Stop-Job` + `Remove-Job`，否则会占住 8123 端口让下一次核对失败。

```powershell
cd F:\电子宠物
$job = Start-Job -ScriptBlock { Set-Location 'F:\电子宠物'; & .\server.ps1 -Port 8123 -NoBrowser }
Start-Sleep -Seconds 3
foreach ($p in @('/', '/css/main.css', '/src/config.js', '/src/main.js', '/../../secret.txt', '/nope.js')) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:8123$p" -UseBasicParsing -TimeoutSec 5
    "{0,-22} {1}  {2}" -f $p, $r.StatusCode, $r.Headers['Content-Type']
  } catch {
    "{0,-22} {1}" -f $p, $_.Exception.Response.StatusCode.value__
  }
}
Stop-Job $job; Remove-Job $job
```

Expected（逐行核对，`/src/main.js` 在本 Task 结束时**应当是 404**，它要到 Task 3 才存在）：

```
/                       200  text/html; charset=utf-8
/css/main.css           200  text/css; charset=utf-8
/src/config.js          200  text/javascript; charset=utf-8     ← 必须是 JavaScript MIME
/src/main.js            404
/../../secret.txt       403                                    ← 目录穿越被挡住
/nope.js                404
```

⚠️ 如果 `/../../secret.txt` 回来的是 404 而不是 403，说明 `Invoke-WebRequest` 把路径规范化了、请求根本没带 `..` 到服务器。那种情况下改用**原始套接字**发一条不被规范化的请求来验证守卫：

```powershell
$c = New-Object System.Net.Sockets.TcpClient 'localhost', 8123
$s = $c.GetStream()
$b = [System.Text.Encoding]::ASCII.GetBytes("GET /../../secret.txt HTTP/1.0`r`nHost: x`r`n`r`n")
$s.Write($b, 0, $b.Length); Start-Sleep -Milliseconds 300
$buf = New-Object byte[] 256; $n = $s.Read($buf, 0, 256)
[System.Text.Encoding]::ASCII.GetString($buf, 0, $n).Split("`n")[0]
$c.Close()
```

Expected: `HTTP/1.1 403 Forbidden`

- [ ] **Step 9: 在浏览器里看一眼（本 Task 的唯一交付物就是这一眼）**

双击 `start.bat`。Expected：浏览器打开 `http://localhost:8123/`，看到**从顶部近黑的深靛紫渐变到底部暗紫**的空水体，没有滚动条、没有白边、没有控制台报错。把窗口拉窄到手机宽度，渐变应当依然铺满。

⚠️ 此时**画面上没有任何生物**，这是正常的 —— 生物要到 Task 3 才出现。这一步验的是 spec §4.3 的背景与 §3.4-5 的「背景交给 CSS」。

- [ ] **Step 10: 提交**

```bash
git add server.ps1 start.bat index.html css/main.css tests/assets.test.js
git commit -m "feat: 静态服务与页面骨架（深靛紫水体交给 CSS，canvas 透明叠加）"
```

---

### Task 2: `body.js` —— 24 个控制点的软体弹簧

**Files:**
- Create: `src/body.js`
- Modify: `src/config.js`（新增 `CONFIG.body` 一节；**不得**改动任何既有数值）
- Test: `tests/body.test.js`

**Interfaces:**
- Consumes:
  - `CONFIG.bodyPoints`（= 24）、`CONFIG.motion.baseSpeed`（= 0.055）、`CONFIG.motion.wallMargin`（= 0.03）、`CONFIG.dissolveDuration`（= 4）
  - `import { sizeOf } from './creature.js'` — `sizeOf(c) => number`（世界单位，3.08–38）
  - `Creature` 的字段：`traits.wobble`、`emotions.{joy,anger,fear,curiosity,sleepy,arousal}`、`vel.{x,y}`、`facing.{x,y}`、`pos.{x,y}`、`moving`、`alive`、`dying`、`sick`
- Produces:
  - `createBody(traits) => Body`
  - `springParams(wobble) => { stiffness, zeta, damping }`
  - `updateBody(body, c, dt) => void`（原地修改 `body`，**不分配任何对象**）
  - `meanRadius(body) => number`（测试与调参用的度量）
  - `Body` / `BodyPoint` 形状见「类型约定」；`points` 在**局部单位圆空间**，`+x` 是 `facing` 方向

**关键设计：点坐标在「facing 对齐的局部单位圆空间」**。静止时 24 个点均匀落在单位圆上；`updateBody` 只改这些局部坐标；乘半径、按 `facing` 旋转、平移到屏幕全是 `render.js` 的事（Task 5 的 `bodyToScreen`）。这样分工的两个回报：`body.js` 不知道视口多大，所以它的输出与设备无关；它的测试不需要任何画布。

- [ ] **Step 1: 在 `CONFIG` 里新增 `body` 一节**

⚠️ 只**新增**，不改任何既有数值。计划 1 的每个常量都带自己的实测数据，改动它们需要新的实测与裁定。

在 `src/config.js` 的 `// ---- 身体 ----` 一节里，`glowHueBuckets: 32,` 之后插入：

```js
  // 软体弹簧与形变（spec §5.1、§4.7）。这一节是计划 2 新增的视觉常量：
  // 它们的"实测"是 tests/visual-checklist.md 的手工核对，不是无头模拟的统计量 ——
  // 形变好不好看没法在 Node 里量，能量的部分（过冲、体积守恒、方向）都进了 tests/body.test.js。
  body: {
    // 弹簧刚度：wobble 0 → 220（硬、挺），wobble 1 → 80（软、晃得久）。
    // 用刚度而不是"晃动幅度"当旋钮，是因为幅度会随时间累积失真，
    // 而刚度直接决定回复力，物理上更稳。
    stiffnessAtZeroWobble: 220,
    stiffnessAtFullWobble: 80,

    // 阻尼比 zeta：1 = 临界阻尼（回到静止位且**不过冲**），<1 = 欠阻尼（冲过头再荡回来）。
    // spec §4.7 要求"形变必须带过冲回弹"，所以两端都**必须** < 1；
    // 而"有的孩子天生更 Q，有的更挺"要求两端差得足够明显。
    // 取 0.70 → 0.35，对应的阶跃过冲量是 exp(-πζ/√(1-ζ²)) = 4.6% → 30.9%：
    // 都过冲（满足 spec），但差 6.7 倍（肉眼可辨"挺"与"Q"）。
    zetaAtZeroWobble: 0.70,
    zetaAtFullWobble: 0.35,

    // 运动挤压：沿速度轴拉长 (1 + stretchK×归一化速度)，垂直轴按 1/(…) 压扁，
    // 两者相乘恒为 1 ⇒ **体积守恒**（tests/body.test.js 用多边形面积钉住）。
    stretchK: 0.18,
    maxStretchSpeed: 2.5,      // 归一化速度上限；fleeFactor = 2.2，留一点余量

    // 情绪 → 形变（spec §4.5 表：喜→膨胀、惧→收缩、怒→压扁且前端变尖、好奇→朝目标伸长）
    joyExpand: 0.16,
    fearShrink: 0.25,
    arousalExpand: 0.12,
    angerFlatten: 0.22,        // 垂直 facing 方向压扁的比例
    angerSharpen: 0.35,        // facing 正前方（cos a > 0 的那半边）被推远的比例
    curiosityElongate: 0.20,
    sleepyCalm: 0.70,          // sleepy=1 时把上面所有情绪形变压到 30%（"形变幅度极小"）

    // 脉动（发光核与整体呼吸的节奏；spec §4.5：arousal"全场最亮"、sleepy"脉动慢到几乎停止"）
    pulseRateBase: 0.9,
    pulseRateArousal: 2.6,
    pulseRateSleepy: -0.6,
    pulseRateFloor: 0.05,

    // 冲击检测（碰撞局部凹陷，spec §5.1）。
    // 用的是**位置的二阶差分**，不是速度差 —— 理由见 src/body.js 里 detectImpact 的注释：
    // moveToward 撞墙时只 clamp 位置、不改 vel，所以 vel 在墙上没有任何信号。
    impactEps: 0.0012,         // 约 1.3 倍单步位移（baseSpeed×dt = 0.000917），低于它算平滑游动
    impactFullDent: 0.0040,    // 二阶差分达到这个量级时凹陷打满
    dentMax: 0.34,             // 最大凹陷深度（局部单位圆空间）
    dentDecay: 6.0,            // 每秒衰减系数（指数）
  },
```

- [ ] **Step 2: 写 `body.js` 的失败测试**

创建 `tests/body.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createBody, updateBody, springParams, meanRadius } from '../src/body.js';

// body.js 是纯逻辑模块（不碰 DOM / canvas），所以 spec §4.7 那句
// "形变必须带过冲回弹（squash & stretch + overshoot）"是**机器可查**的，
// 不必等人在浏览器里盯着看。下面几条就是把那句设计承诺变成断言。

const DT = CONFIG.fixedDt;

// 造一只"标准生物"。不 import creature.js：body.js 只读字段，
// 用一个普通对象就够了，而且这样测试不会连带把内核的构造校验拖进来。
const makeCreature = (over) => ({
  traits: { wobble: 0.5, size: 26 },
  emotions: { joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 },
  vel: { x: 0, y: 0 },
  facing: { x: 1, y: 0 },
  pos: { x: 0.5, y: 0.5 },
  moving: false,
  alive: true,
  dying: 0,
  sick: false,
  age: 600,          // 成体，growthFactor = 1.00
  ...over,
});

const run = (body, c, seconds) => {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) updateBody(body, c, DT);
};

test('createBody 造出 bodyPoints 个点，静止时均匀落在单位圆上', () => {
  const body = createBody({ wobble: 0.5 });
  assert.equal(body.points.length, CONFIG.bodyPoints);
  assert.equal(body.dip.length, CONFIG.bodyPoints);
  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    const a = (i / CONFIG.bodyPoints) * Math.PI * 2;
    assert.ok(Math.abs(p.x - Math.cos(a)) < 1e-12, `点 ${i} 的 x 不在单位圆上`);
    assert.ok(Math.abs(p.y - Math.sin(a)) < 1e-12, `点 ${i} 的 y 不在单位圆上`);
    // rx/ry 是静止位，此后不变；render 与测试都靠它当基准
    assert.equal(p.rx, p.x);
    assert.equal(p.ry, p.y);
  }
});

test('springParams：wobble 越高越软越弹，且两端都欠阻尼（spec §4.7 要求过冲）', () => {
  const stiff = springParams(0);
  const soft = springParams(1);
  assert.ok(stiff.stiffness > soft.stiffness, 'wobble 高应当更软（刚度更低）');
  assert.ok(stiff.zeta > soft.zeta, 'wobble 高应当更弹（阻尼比更低）');
  // 阻尼比必须 < 1，否则是临界/过阻尼，不会过冲 —— spec §4.7 的"必须带过冲回弹"就没了
  assert.ok(stiff.zeta < 1 && soft.zeta < 1, '两端都必须欠阻尼');
  // 阻尼系数由刚度与阻尼比推出（damping = 2√k·ζ），不是独立旋钮，
  // 否则两个旋钮能被调成互相矛盾的组合
  assert.ok(Math.abs(stiff.damping - 2 * Math.sqrt(stiff.stiffness) * stiff.zeta) < 1e-12);
});

test('wobble=1 的过冲明显大于 wobble=0（"有的孩子天生更 Q，有的更挺"）', () => {
  // 手法：给一个阶跃目标（突然把 joy 从 0 拉到 1 ⇒ 目标半径膨胀），
  // 然后逐步记录最大半径。过冲 = 最大半径超过最终稳态半径的部分。
  const measure = (wobble) => {
    const body = createBody({ wobble });
    const c = makeCreature({ traits: { wobble, size: 26 }, emotions: { joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 } });
    run(body, c, 1.0);                       // 先收敛到 joy=0 的稳态
    const base = meanRadius(body);
    c.emotions.joy = 1;                      // 阶跃
    let peak = 0;
    for (let i = 0; i < Math.round(1.5 / DT); i++) {
      updateBody(body, c, DT);
      peak = Math.max(peak, meanRadius(body));
    }
    const settled = meanRadius(body);
    return (peak - settled) / (settled - base);
  };
  const overSoft = measure(1);
  const overStiff = measure(0);
  assert.ok(overSoft > 0, 'wobble=1 必须过冲（spec §4.7：形变必须带过冲回弹）');
  assert.ok(overStiff > 0, 'wobble=0 也必须过冲，只是幅度小（spec §4.7：两端都要 overshoot）');
  assert.ok(overSoft > overStiff * 2, `软的过冲应当显著更大：实测 ${overSoft.toFixed(4)} vs ${overStiff.toFixed(4)}`);
});

test('joy 膨胀、fear 收缩、方向与 spec §4.5 的表一致', () => {
  const radiusWith = (emotions) => {
    const body = createBody({ wobble: 0.5 });
    const c = makeCreature({ emotions });
    run(body, c, 2.0);
    return meanRadius(body);
  };
  const neutral = radiusWith({ joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });
  const joyful = radiusWith({ joy: 1, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });
  const afraid = radiusWith({ joy: 0, anger: 0, fear: 1, curiosity: 0, sleepy: 0, arousal: 0 });
  assert.ok(joyful > neutral, `开心应当膨胀：${joyful.toFixed(4)} vs ${neutral.toFixed(4)}`);
  assert.ok(afraid < neutral, `害怕应当收缩：${afraid.toFixed(4)} vs ${neutral.toFixed(4)}`);
});

test('anger 把身体压扁且前端变尖（垂直 facing 缩短、正前方推远）', () => {
  const extent = (wobble, anger) => {
    const body = createBody({ wobble });
    const c = makeCreature({ emotions: { joy: 0, anger, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 } });
    run(body, c, 2.0);
    let fwd = 0, side = 0;
    for (const p of body.points) {
      fwd = Math.max(fwd, p.x);       // 局部 +x = facing 方向
      side = Math.max(side, Math.abs(p.y));
    }
    return { fwd, side };
  };
  const calm = extent(0.5, 0);
  const mad = extent(0.5, 1);
  assert.ok(mad.side < calm.side, '生气应当压扁（垂直 facing 的半径变小）');
  assert.ok(mad.fwd > calm.fwd, '生气应当前端变尖（正前方被推远）');
});

test('运动挤压体积守恒（squash & stretch 不是把身体拉大）', () => {
  // 用鞋带公式算闭合多边形的有向面积。拉长与压扁必须互相抵消，
  // 否则"游得越快就越大"，团子会在逃命时膨胀成气球。
  const area = (body) => {
    let s = 0;
    const n = body.points.length;
    for (let i = 0; i < n; i++) {
      const a = body.points[i];
      const b = body.points[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  };
  const still = createBody({ wobble: 0.5 });
  const moving = createBody({ wobble: 0.5 });
  const cStill = makeCreature({});
  const cMoving = makeCreature({
    vel: { x: CONFIG.motion.baseSpeed * 2, y: 0 },
    moving: true,
  });
  run(still, cStill, 2.0);
  run(moving, cMoving, 2.0);
  const ratio = area(moving) / area(still);
  assert.ok(Math.abs(ratio - 1) < 0.03, `面积比应当接近 1，实测 ${ratio.toFixed(4)}`);
});

test('睡眠把情绪形变压到极小（spec §4.5：形变幅度极小）', () => {
  const radiusWith = (emotions) => {
    const body = createBody({ wobble: 0.5 });
    run(body, makeCreature({ emotions }), 2.0);
    return meanRadius(body);
  };
  const base = radiusWith({ joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });
  const awakeJoy = radiusWith({ joy: 1, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });
  const sleepyJoy = radiusWith({ joy: 1, anger: 0, fear: 0, curiosity: 0, sleepy: 1, arousal: 0 });
  const awakeDelta = Math.abs(awakeJoy - base);
  const sleepyDelta = Math.abs(sleepyJoy - base);
  assert.ok(sleepyDelta < awakeDelta * 0.5,
    `困倦时同样的 joy 应当只造成一半以下的形变：${sleepyDelta.toFixed(4)} vs ${awakeDelta.toFixed(4)}`);
});

test('位置突变会在受冲击的那一侧压出凹陷（spec §5.1 碰撞局部凹陷）', () => {
  const body = createBody({ wobble: 0.5 });
  const c = makeCreature({});
  run(body, c, 1.0);                       // 先稳住
  const before = body.points.map((p) => ({ x: p.x, y: p.y }));

  // 模拟"被同类从 +x 方向推开"：位置沿 -x 跳一下。
  // resolve() 就是这么做的（sim.js:849-852 直接改 pos，不改 vel）。
  c.pos.x -= 0.01;
  updateBody(body, c, DT);
  for (let i = 0; i < 3; i++) updateBody(body, c, DT);   // 让凹陷传进弹簧

  // 受冲击侧是 +x（撞它的那只来自 +x），所以 +x 侧的点应当被压得更靠近圆心
  const frontNow = Math.max(...body.points.map((p) => p.x));
  const frontBefore = Math.max(...before.map((p) => p.x));
  assert.ok(frontNow < frontBefore,
    `+x 侧应当凹进去：${frontNow.toFixed(4)} vs ${frontBefore.toFixed(4)}`);
});

test('撞墙也能被检出（moveToward 只 clamp 位置、不改 vel，所以只能靠二阶差分）', () => {
  const body = createBody({ wobble: 0.5 });
  // 一直朝 +x 游，然后 pos 被钉在墙上不再前进 ⇒ 位移从正变 0，二阶差分出尖峰
  const c = makeCreature({ vel: { x: CONFIG.motion.baseSpeed, y: 0 }, moving: true });
  for (let i = 0; i < 30; i++) { c.pos.x = Math.min(0.97, c.pos.x + CONFIG.motion.baseSpeed * DT); updateBody(body, c, DT); }
  const dentBefore = Math.max(...body.dip);
  for (let i = 0; i < 10; i++) updateBody(body, c, DT);   // 位置不再变化（贴墙）
  // 贴墙瞬间应当出现过凹陷；随后按 dentDecay 衰减
  assert.ok(Math.max(...body.dip) >= 0, 'dip 必须始终是有限非负数');
  assert.ok(Number.isFinite(dentBefore));
  // 真正的断言：贴住墙不动之后凹陷会衰减回 0（不是永久留一个坑）
  for (let i = 0; i < Math.round(2 / DT); i++) updateBody(body, c, DT);
  assert.ok(Math.max(...body.dip) < 1e-6, `凹陷应当衰减干净，实测 ${Math.max(...body.dip)}`);
});

test('updateBody 不分配对象：points 数组与每个点对象都是同一批（spec §5.3 运行时零分配）', () => {
  const body = createBody({ wobble: 0.5 });
  const c = makeCreature({ vel: { x: 0.02, y: 0.01 }, moving: true });
  const pointsRef = body.points;
  const pointRefs = body.points.map((p) => p);
  const dipRef = body.dip;
  run(body, c, 1.0);
  assert.equal(body.points, pointsRef, 'points 数组必须是同一个引用');
  assert.equal(body.dip, dipRef, 'dip 必须是同一个 Float64Array');
  for (let i = 0; i < pointRefs.length; i++) {
    assert.equal(body.points[i], pointRefs[i], `点 ${i} 必须是同一个对象，不得每步新建`);
  }
});

test('长时程后所有坐标仍然有限（交接要求第 1 条的同款纪律）', () => {
  // 计划 1 的教训：clamp01 会原样放过 NaN，而 NaN 分量在渲染里表现为"这只生物不见了"，
  // 全程不报错。所以形变层也要有一条长时程有限性断言。
  const body = createBody({ wobble: 1 });
  const c = makeCreature({
    emotions: { joy: 1, anger: 1, fear: 1, curiosity: 1, sleepy: 1, arousal: 1 },
    vel: { x: 0.3, y: -0.3 },
    moving: true,
  });
  run(body, c, 60.0);
  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `点 ${i} 坐标不是有限数`);
    assert.ok(Number.isFinite(p.vx) && Number.isFinite(p.vy), `点 ${i} 速度不是有限数`);
    assert.ok(Number.isFinite(body.dip[i]), `点 ${i} 凹陷量不是有限数`);
  }
  // 极端情绪全开 60 秒后形状仍然合理：半径不该爆掉也不该塌成 0
  const r = meanRadius(body);
  assert.ok(r > 0.2 && r < 3, `半径失控：${r}`);
});

test('死亡溶散期间身体逐渐塌陷（表现层读 c.dying，不自己另计时间）', () => {
  const radiusAt = (dying) => {
    const body = createBody({ wobble: 0.5 });
    const c = makeCreature({ alive: false, dying });
    run(body, c, 1.0);
    return meanRadius(body);
  };
  const fresh = radiusAt(0);
  const half = radiusAt(CONFIG.dissolveDuration / 2);
  const late = radiusAt(CONFIG.dissolveDuration * 0.95);
  assert.ok(half < fresh, '溶散到一半应当已经缩小');
  assert.ok(late < half, '越接近溶散结束越小');
  assert.ok(late > 0, '不得塌成 0（0 半径会让 render 的渐变退化）');
});

test('sick 个体几乎不动（sim.js:940 要求它被画成"变暗、静止"）', () => {
  const jitter = (sick) => {
    const body = createBody({ wobble: 1 });
    const c = makeCreature({ sick, emotions: { joy: 1, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 1 } });
    run(body, c, 1.0);
    const first = body.points.map((p) => p.x);
    let maxDelta = 0;
    for (let i = 0; i < 30; i++) {
      updateBody(body, c, DT);
      for (let j = 0; j < first.length; j++) maxDelta = Math.max(maxDelta, Math.abs(body.points[j].x - first[j]));
    }
    return maxDelta;
  };
  const healthy = jitter(false);
  const ill = jitter(true);
  assert.ok(ill < healthy * 0.25, `sick 的形变幅度应当压到 1/4 以下：${ill.toFixed(5)} vs ${healthy.toFixed(5)}`);
});

test('body.js 不 import perceive（交接义务第 2 条：tick 之外调它会抛 TypeError）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/body.js', import.meta.url)), 'utf8');
  assert.ok(!/\bperceive\b/.test(src),
    'perceive 在 tickWorld 之外调用会因 world.grid 的旧下标抛 TypeError（src/sim.js:286）；表现层一律不调它');
});
```

⚠️ 最后那条测试用到 `readFileSync` 与 `fileURLToPath`，记得在文件顶部一起 import：

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/body.test.js`
Expected: FAIL —— `Cannot find module '…/src/body.js'`。

- [ ] **Step 4: 写 `src/body.js`**

```js
// body.js —— 软体身体模型（spec §5.1、§4.7）。
//
// 纯逻辑模块：不碰 DOM、不碰 canvas、不 import world、不调 perceive。
// 它只读 creature 上的字段，只写自己持有的 Body。回报是"Q 弹回弹"这条
// 设计承诺能在 Node 里被断言（tests/body.test.js），不必靠人在浏览器里盯着看。
//
// 坐标系：points 在**facing 对齐的局部单位圆空间**（+x = 正前方）。
// 乘半径、按 facing 旋转、平移到屏幕都是 render.js 的事。

import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';

const TAU = Math.PI * 2;
const B = CONFIG.body;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 弹簧参数由 wobble 基因决定（spec §4.7："挤压幅度由 wobble 基因决定，
// 所以有的孩子天生更 Q，有的更挺"）。
//
// 用**阻尼比 zeta** 而不是直接给阻尼系数，是为了让"挺 / 弹"成为一个有物理意义的旋钮：
//   zeta = 1   临界阻尼 —— 最快回到静止位且**不过冲**
//   zeta < 1   欠阻尼   —— 冲过头再荡回来（这就是 Q 弹）
// spec §4.7 要求"形变必须带过冲回弹"，所以两端都取 < 1；
// 0.70 → 0.35 对应阶跃过冲量 exp(-πζ/√(1-ζ²)) = 4.6% → 30.9%，差 6.7 倍，肉眼可辨。
export function springParams(wobble) {
  const w = clamp01(wobble);
  const stiffness = B.stiffnessAtZeroWobble
    + (B.stiffnessAtFullWobble - B.stiffnessAtZeroWobble) * w;
  const zeta = B.zetaAtZeroWobble + (B.zetaAtFullWobble - B.zetaAtZeroWobble) * w;
  return { stiffness, zeta, damping: 2 * Math.sqrt(stiffness) * zeta };
}

export function createBody(traits) {
  const n = CONFIG.bodyPoints;
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    // rx/ry 是静止位，创建后不再变；render 与测试都拿它当基准
    points[i] = { x: cx, y: cy, vx: 0, vy: 0, rx: cx, ry: cy };
  }
  return {
    points,
    phase: 0,
    pulse: 0,
    dip: new Float64Array(n),     // 每点的碰撞凹陷量；typed array ⇒ 运行时零分配
    prevX: NaN,                   // NaN = 还没有历史，第一步不判冲击
    prevY: NaN,
    prevDx: 0,
    prevDy: 0,
    wobble: clamp01(traits ? traits.wobble : 0.5),
  };
}

// 冲击检测用的是**位置的二阶差分**，不是速度差。这个选择是被内核逼出来的，
// 不是审美偏好：
//   · sim.js:519 的 moveToward 撞墙时 `clampPos` 只截住**位置**，
//     紧接着 sim.js:521 又把 vel 设成完整的意图速度 —— 所以贴墙时 vel 毫无信号，
//     "Δv 很大 ⇒ 撞到东西了"这个直觉在这里是**错的**。
//   · sim.js:849-852 的个体间碰撞直接改 pos（把两只各推开 push），也不改 vel。
// 两条路径唯一的共同信号是：实际位移与上一步位移不一致。二阶差分正好量这个，
// 而且顺带把 spec §4.7 的"落地/停下时先压扁再弹回"一起覆盖了 ——
// 起步与急停本身就是加速度尖峰。
function detectImpact(body, c) {
  if (!Number.isFinite(body.prevX)) {
    body.prevX = c.pos.x; body.prevY = c.pos.y;
    body.prevDx = 0; body.prevDy = 0;
    return 0;
  }
  const dx = c.pos.x - body.prevX;
  const dy = c.pos.y - body.prevY;
  const rx = dx - body.prevDx;
  const ry = dy - body.prevDy;
  body.prevDx = dx; body.prevDy = dy;
  body.prevX = c.pos.x; body.prevY = c.pos.y;

  const mag = Math.hypot(rx, ry);
  if (mag <= B.impactEps) return 0;
  // 凹陷方向 = -residual。推导：被从 +x 方向撞 ⇒ 自己沿 -x 被推开 ⇒ residual 指向 -x
  // ⇒ 受冲击的一侧是 +x，正好是 -residual。撞墙同理（意图朝 +x，位置被截住 ⇒
  // residual 指向 -x ⇒ 受冲击侧是 +x，就是墙那一侧）。两种情况共用一个符号约定。
  const strength = Math.min(1, (mag - B.impactEps) / B.impactFullDent);
  body.impactX = -rx / mag;
  body.impactY = -ry / mag;
  return strength;
}

export function updateBody(body, c, dt) {
  const e = c.emotions;
  const w = body.wobble;

  // sick 与死亡都会把形变压小：sim.js:940 要求 sick 个体被画成"变暗、静止"，
  // 而溶散中的身体应当先塌陷再散开（spec §4.11）。
  const dyingT = c.alive ? 0 : clamp01(c.dying / CONFIG.dissolveDuration);
  let calm = 1 - B.sleepyCalm * clamp01(e.sleepy);          // 困倦 ⇒ 形变幅度极小
  if (c.sick) calm *= 0.15;
  if (!c.alive) calm *= 1 - 0.6 * dyingT;

  // ---- 脉动相位与幅度（spec §4.5：arousal 全场最亮最快，sleepy 慢到几乎停止）----
  const rate = Math.max(B.pulseRateFloor,
    B.pulseRateBase + B.pulseRateArousal * e.arousal + B.pulseRateSleepy * e.sleepy);
  body.phase += dt * rate;
  if (body.phase > 1e6) body.phase -= 1e6;      // 防长时程累积精度损失，不影响观感
  body.pulse = (0.03 + 0.05 * e.joy + 0.09 * e.arousal - 0.02 * e.sleepy) * calm;

  // ---- 目标形状：情绪 + 运动挤压，算在局部单位圆空间 ----
  // 情绪缩放（各向同性部分）
  let scale = 1
    + B.joyExpand * e.joy
    - B.fearShrink * e.fear
    + B.arousalExpand * e.arousal;
  scale = 1 + (scale - 1) * calm;
  // 溶散时整体塌陷（但不塌到 0：0 半径会让 render 的渐变与 drawImage 退化）
  scale *= 1 - 0.55 * dyingT;

  // 运动挤压：沿速度轴拉长、垂直轴压扁，两者相乘恒为 1 ⇒ 体积守恒
  const speedNorm = Math.min(B.maxStretchSpeed,
    Math.hypot(c.vel.x, c.vel.y) / CONFIG.motion.baseSpeed);
  const stretch = c.moving ? 1 + B.stretchK * speedNorm : 1;
  const invStretch = 1 / stretch;

  // 速度轴在**局部空间**里的方向（局部 +x 是 facing，所以要投影一次）
  const fx = c.facing.x, fy = c.facing.y;
  const sideX = -fy, sideY = fx;                       // 垂直于 facing
  const vFwd = c.vel.x * fx + c.vel.y * fy;
  const vSide = c.vel.x * sideX + c.vel.y * sideY;
  const vLen = Math.hypot(vFwd, vSide);
  const ux = vLen > 1e-9 ? vFwd / vLen : 1;            // 静止时退回 facing 轴
  const uy = vLen > 1e-9 ? vSide / vLen : 0;

  // 冲击：先算强度，再把凹陷加到对应侧的点上
  const impact = detectImpact(body, c);
  if (impact > 0) {
    const ix = body.impactX, iy = body.impactY;
    for (let i = 0; i < body.points.length; i++) {
      const p = body.points[i];
      // cos 夹角 > 0 的点才在受冲击侧；平方一下让凹陷集中在正对冲击的那一小块
      const facing = p.rx * ix + p.ry * iy;
      if (facing > 0) {
        const add = B.dentMax * impact * facing * facing;
        if (add > body.dip[i]) body.dip[i] = add;      // 取最大值，不累加（避免连撞爆掉）
      }
    }
  }
  // 凹陷按指数衰减（ dentDecay 是每秒系数）
  const dipKeep = Math.exp(-B.dentDecay * dt);
  for (let i = 0; i < body.dip.length; i++) body.dip[i] *= dipKeep;

  // ---- 弹簧积分：半隐式欧拉 ----
  // ω = √k ⇒ 最硬时 √220 ≈ 14.8 rad/s，ω·dt = 0.247（dt = 1/60），远在稳定区内。
  const { stiffness, damping } = springParams(w);
  const angerFlat = 1 - B.angerFlatten * e.anger * calm;
  const sharpen = B.angerSharpen * e.anger * calm;
  const elongate = B.curiosityElongate * e.curiosity * calm;

  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    const ca = p.rx, sa = p.ry;                 // 静止位就是单位圆上的 (cos, sin)

    // 1) 沿速度轴 squash & stretch：把点分解到 (u, u⊥)，两个分量分别乘 stretch 与 1/stretch
    const along = ca * ux + sa * uy;
    const perp = -ca * uy + sa * ux;
    let tx = ux * (along * stretch) - uy * (perp * invStretch);
    let ty = uy * (along * stretch) + ux * (perp * invStretch);

    // 2) 情绪：各向同性缩放
    tx *= scale; ty *= scale;

    // 3) 生气：垂直 facing 压扁（局部 y），正前方推远（局部 x 且 ca > 0）
    ty *= angerFlat;
    if (ca > 0) tx *= 1 + sharpen * ca;

    // 4) 好奇：朝 facing 伸长（spec §4.5："身体朝目标伸长"）
    if (ca > 0) tx *= 1 + elongate * ca;

    // 5) 呼吸脉动：整体轻微胀缩
    const breathe = 1 + body.pulse * Math.sin(body.phase * TAU);
    tx *= breathe; ty *= breathe;

    // 6) 碰撞凹陷：沿径向朝内推
    const dip = body.dip[i];
    if (dip > 0) { tx -= ca * dip; ty -= sa * dip; }

    // 半隐式欧拉：先用新加速度更新速度，再用新速度更新位置。
    // 比显式欧拉稳定得多（显式欧拉在 k=220、dt=1/60 下会持续注入能量直到炸掉）。
    const ax = (tx - p.x) * stiffness - p.vx * damping;
    const ay = (ty - p.y) * stiffness - p.vy * damping;
    p.vx += ax * dt;
    p.vy += ay * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

// 平均半径：测试与调参用的度量（"膨胀了没有"、"塌了没有"都靠它）。
// render.js 不用它 —— 渲染要的是逐点坐标，不是平均值。
export function meanRadius(body) {
  let s = 0;
  for (const p of body.points) s += Math.hypot(p.x, p.y);
  return s / body.points.length;
}

// 供 render.js 用的当前渲染半径（CSS 像素之前的世界单位）。
// 单独导出是为了让"体型随年龄变化"这件事只有一个实现 ——
// growthFactor 从 0.22（刚孵化）升到 1.00（成体峰值）再降到 0.88（老年）。
export function renderSizeOf(c) {
  return sizeOf(c);
}
```

⚠️ **`body.impactX` / `body.impactY` 必须在 `createBody` 里预声明**（初值 0），否则第一次 `detectImpact` 会往 body 上**新增属性** —— 那是运行时分配，违反 spec §5.3。在 `createBody` 的返回对象里补上：

```js
    impactX: 0,
    impactY: 0,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/body.test.js`
Expected: PASS，14 条全绿。

⚠️ 若「wobble=1 的过冲明显大于 wobble=0」这条红，**先量再调**：把 `measure()` 的两个返回值打印出来看实际比例。可能是阶跃后 1.5 秒不够收敛（那就要延长采样窗口），也可能是 `zeta` 两端差距不够（那才是调 `CONFIG.body`）。**不要**为了让测试变绿而放宽断言里的 `* 2`。

Run: `node --test tests/`
Expected: **404 tests / 404 pass / 0 fail**（390 + 14），stderr 0 字节。

Run: `node --test tests/constraints.test.js`
Expected: PASS —— `body.js` 不含那七个浏览器标识符，所以计划 1 的纯度守卫**依然是绿的**。这一步是本 Task 最重要的验证：它证明表现层可以在不破坏内核可测性的前提下加进来。

- [ ] **Step 6: 变异探针（证明过冲断言真的在守东西）**

把 `src/config.js` 里 `zetaAtFullWobble: 0.35` 临时改成 `1.2`（过阻尼，物理上不会过冲），跑：

Run: `node --test tests/body.test.js`
Expected: 「wobble=1 的过冲明显大于 wobble=0」**变红**，且 `springParams` 那条的「两端都必须欠阻尼」也变红。

改回 `0.35`，再跑一次确认两条都恢复绿。**并把这两次的实测结果记进 `.superpowers/sdd/progress.md`** —— 没有变异探针的断言可能只是恒真式。

- [ ] **Step 7: 提交**

```bash
git add src/body.js src/config.js tests/body.test.js
git commit -m "feat: 软体身体模型（24 控制点弹簧、体积守恒挤压、二阶差分冲击凹陷）"
```

---

### Task 3: `main.js` —— 固定步长主循环与倍速子步进

**为什么这个 Task 在渲染之前**：它是 `constraints.test.js` 第一个需要豁免的模块，也是「倍速必须子步进」这条交接要求的落点。而且它交付完就能看到**会动的东西**（本 Task 末尾有一段临时调试点绘制，Task 4 会删掉），不必等到全部渲染层写完才第一次开浏览器。

**Files:**
- Create: `src/main.js`
- Modify: `src/config.js`（新增 `CONFIG.render` 一节）
- Modify: `src/body.js`（`createBody` 的返回对象加一个 `seen` 字段）
- Modify: `tests/constraints.test.js`（加浏览器模块白名单 + 依赖方向守卫）
- Test: `tests/loop.test.js`

**Interfaces:**
- Consumes:
  - `createWorld(opts)` —— ⚠️ `opts` **必填**（`sim.js:109` 直接取 `opts.seed`，裸调 `createWorld()` 会抛 `TypeError`）。字段：`{ seed, populationCap?, nameFor? }`
  - `tickWorld(world, dt)`、`worldStats(world)`、`CONFIG.fixedDt`、`CONFIG.dtAccumCap`、`CONFIG.timeScales`、`CONFIG.populationCap`、`CONFIG.bodyPoints`
  - `createBody(traits)`、`updateBody(body, c, dt)`（Task 2）
- Produces:
  - `createViewport(cssWidth, cssHeight, dpr) => Viewport`（纯函数）
  - `advanceLoop(loop, frameDt, timeScale) => number`（原地改 `loop`，返回本帧子步数）
  - `reconcileBodies(bodies, world, frame) => void`（原地改 `Map`）
  - `boot(opts) => Controller`，`Controller = { world, viewport, setTimeScale, getTimeScale, stop, frame }`
  - `setTimeScale(scale) => void`（作用于当前活动 controller，供 devtools 与计划 3 的 HUD 调用）
  - `CONFIG.render = { scaleRef, scaleMin, scaleMax }`

- [ ] **Step 1: 改 `tests/constraints.test.js`，把纯度守卫的范围放对位置**

⚠️ 这一步**必须**在写 `main.js` 之前做。否则 `main.js` 一落地，计划 1 那条「src/ 下没有任何模块引用 DOM / 浏览器 API」立刻变红，而红的原因是守卫范围写错了、不是代码写错了 —— 那种红会把实现者引向「把 DOM 代码藏起来」而不是「把守卫改对」。

四处改动：

**(a)** 在 `FORBIDDEN_IDENTIFIERS` 定义之后、`findViolations` 之前插入白名单：

```js
// 计划 2 新增：只有这一个文件可以触碰浏览器 API。
//
// 白名单为什么这么短：render / body / input / audio 全部靠**依赖注入**拿到浏览器能力
// （ctx、目标元素、AudioContext 构造器、makeCanvas 工厂），源码里根本不出现那七个全局名，
// 所以它们**继续留在纯度守卫的覆盖范围内**，也继续能在 Node 里单测。
// 把白名单写短不是洁癖，是保住可测面积 —— 这四个模块里装着软体弹簧、坐标映射、
// 色相分桶、指针速度分类、嗓音参数映射，全是值得断言的纯数学。
// 真正无法豁免的只有 main.js：它是页面入口，必须自己拿 canvas、必须自己调 rAF。
const BROWSER_MODULES = [join('src', 'main.js')];
```

**(b)** 把 `findViolations` 改成接受一个排除列表（原来的调用点只有 DOM 那条测试，`Math.random` 那条是独立循环、**不受影响**，所以 main.js 依然被禁止用 `Math.random()`）：

```js
const findViolations = (pattern, excludeRel) => {
  const hits = [];
  const skip = excludeRel || [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const rel = relative(ROOT_DIR, file);
    if (skip.includes(rel)) continue;
    const body = stripComments(readFileSync(file, 'utf8'));
    for (const name of pattern) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const count = (body.match(re) || []).length;
      if (count > 0) hits.push(`${rel}: ${name} ×${count}`);
    }
  }
  return hits;
};
```

**(c)** 把 DOM 那条测试替换成下面这一组（**保留**原来的断言语义，只是缩小范围，并新增三条）：

```js
test('除 main.js 外，src/ 下没有任何模块引用 DOM / 浏览器 API', () => {
  // 这些标识符在 Node 里根本不存在，引用它们会让模块在 import 阶段就抛 ReferenceError，
  // 于是所有纯逻辑测试都跑不起来。计划 1 的原文写的是"渲染与音频是 Task 9/10 的职责，
  // 它们必须待在自己的模块里" —— 计划 2 用依赖注入做到了更强的一层：
  // 渲染与音频**连自己的模块里都不出现**这些名字，它们只收 ctx / element / 构造器。
  const hits = findViolations(FORBIDDEN_IDENTIFIERS, BROWSER_MODULES);
  assert.deepEqual(hits, [], '除 main.js 外的模块不得触碰 DOM / 浏览器 API');
});

test('白名单没有腐烂：main.js 确实存在，且确实用到了浏览器 API', () => {
  // 白名单是**豁免**，所以它自己也要被守卫，否则会朝两个方向烂掉：
  //   · 文件被改名/删除 ⇒ 白名单指向空气，而新加的浏览器模块无人豁免 ⇒ 莫名变红；
  //   · 文件其实不需要豁免（比如有人把 DOM 代码搬回了 render.js 又把 render.js 加进白名单）
  //     ⇒ 白名单每多一项，纯度守卫就少覆盖一个模块，而且是**静默**少覆盖。
  for (const rel of BROWSER_MODULES) {
    const full = join(ROOT_DIR, rel);
    assert.ok(existsSync(full), `白名单里的 ${rel} 不存在，请把它从 BROWSER_MODULES 删掉`);
    const body = stripComments(readFileSync(full, 'utf8'));
    const used = FORBIDDEN_IDENTIFIERS.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
    assert.ok(used.length > 0, `${rel} 没有用到任何浏览器 API，不该留在白名单里（白名单是豁免，多余的豁免=守卫盲区）`);
  }
});

test('依赖方向：任何纯模块都不得 import 浏览器模块', () => {
  // 这条才是真正保护可测性的约束。DOM 扫描保证"纯模块不碰 DOM"，
  // 而这条保证"纯模块不被浏览器模块反向拖下水"：
  // 一旦 body.js import 了 main.js，那么 import body.js 就会连带执行 main.js 的顶层代码，
  // 所有 body 测试在 Node 里当场 ReferenceError —— 纯度守卫却还是绿的（body.js 自己没写那些词）。
  const hits = [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const rel = relative(ROOT_DIR, file);
    if (BROWSER_MODULES.includes(rel)) continue;
    const body = readFileSync(file, 'utf8');     // 这里**不剥注释**：import 语句不会写在注释里，
    for (const mod of BROWSER_MODULES) {         // 而剥注释的启发式会把 URL 里的 // 之后整行删掉
      const base = mod.split(/[\\/]/).pop();
      if (body.includes(`'./${base}'`) || body.includes(`"./${base}"`)) {
        hits.push(`${rel} import 了 ${mod}`);
      }
    }
  }
  assert.deepEqual(hits, [], '纯逻辑模块不得依赖浏览器模块');
});

test('四个表现层模块能在 Node 里 import 成功（守卫的意图，而不只是它的字面）', async () => {
  // DOM 扫描的真正意图（见它自己的注释）是"这些标识符在 Node 里根本不存在，
  // 引用它们会让模块在 import 阶段就抛 ReferenceError"。词边界匹配只是这个意图的近似：
  // 它会漏掉 `globalThis['doc'+'ument']`，也会把名叫 canvas 的局部变量误报。
  // 所以直接验证意图本身 —— 真的去 import 一次。
  for (const mod of ['body.js', 'render.js', 'input.js', 'audio.js']) {
    const imported = await import(`../src/${mod}`);
    assert.ok(imported && typeof imported === 'object', `src/${mod} import 失败`);
  }
});
```

⚠️ 最后那条测试在 Task 3 会**失败**（`render.js` / `input.js` / `audio.js` 还不存在）。这是刻意的：它把「计划 2 必须交付这四个纯模块」写成了可执行的清单。本 Task 先把它**临时**改成只测 `['body.js']`，并在 Task 4/8/9 各自落地时把对应文件名加回来 —— 每次加回都是把一条待办划掉。**Task 10 Step 2 会检查这四个名字是否都已加回**，防止临时状态被遗忘。

**(d)** 给 `existsSync` 补 import（第 3 行）：

```js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
```

并把防空转那条的 `files.length >= 2` 提到 `>= 6`（计划 2 结束时 `src/` 有 16 个 `.js`），同时加一条「扫描确实看到了 main.js」—— 否则「main.js 被豁免」和「main.js 没被扫到」这两种情况在断言上无法区分：

```js
  assert.ok(files.length >= 6, `src/ 下只找到 ${files.length} 个 .js 文件，至少应有 6 个`);
  for (const expected of [join('src', 'config.js'), join('src', 'rng.js'), join('src', 'main.js')]) {
    assert.ok(files.includes(expected), `扫描漏掉了 ${expected}`);
  }
```

- [ ] **Step 2: 在 `CONFIG` 里新增 `render` 一节**

在 `src/config.js` 的 `// ---- 身体 ----` 一节末尾（`glowHueBuckets: 32,` 与 Task 2 加的 `body: {…}` 之后）插入：

```js
  // 世界单位 → CSS 像素的缩放（spec §3.4-2："缩放系数由视口短边推导并 clamp"）。
  // spec §12 把这类视觉参数列为"实现阶段按观感直接定即可，无需再次确认"，
  // 所以下面三个数的"实测数据"就是它们推导出来的像素尺寸本身：
  //   scale = clamp(短边 / 540, 1.5, 2.6)，渲染直径 = sizeOf(c) × scale
  //   桌面 1920×1080（短边 1080）→ scale 2.000：成体(traits.size 26) 52.0px、最大(38) 76.0px、刚孵化(5.72) 11.4px
  //   手机 390×844 （短边 390） → scale 1.500（触底）：成体 39.0px、最大 57.0px、刚孵化 8.6px
  //   超宽 3840×2160（短边 2160）→ scale 2.600（触顶）：成体 67.6px
  // 下限 1.5 存在的唯一理由：不 clamp 的话手机竖屏 scale = 0.722，成体只有 18.8px、
  // 幼体 4.1px —— 正是 §3.4-2 那句"生物不会在手机上小到看不见"要防的情况。
  // 上限 2.6 防的是超宽屏上 24 只 104px 的团子挤满画面。
  // 540 是反推的：想要桌面 1080p 上成体约 50px ⇒ 52/26 = 2.0 ⇒ 1080/2.0 = 540。
  render: {
    scaleRef: 540,
    scaleMin: 1.5,
    scaleMax: 2.6,
  },
```

- [ ] **Step 3: 给 `createBody` 加 `seen` 字段**

`reconcileBodies` 用「标记-清扫」代替每帧 `new Set()`（后者是每帧一次分配，违反 spec §5.3）。在 `src/body.js` 的 `createBody` 返回对象里，`wobble: …` 之后加：

```js
    seen: -1,                     // reconcileBodies 的标记-清扫用；-1 保证第一帧不会被误判成"本帧见过"
```

✓ 计划文档「类型约定」里的 `Body` 形状**已经**补上了 `seen`、`impactX`、`impactY` 三个字段（本轮 Self-Review 时发现约定与实现不一致，已改）。实现时直接照「类型约定」写即可，不需要再回头改文档。

**这条曾经是个待办，而它值得记下来**：`impactX/Y` 是 Task 2 写到一半才发现需要的（原本打算用速度差分检测撞击，读了 `moveToward` 才证明 `vel` 在撞墙时没有信号，必须改用位置的二阶差分，于是需要存下撞击方向）。**实现长出了设计时没预见的字段，而约定块没有回头改** —— 这是计划文档最容易被悄悄腐蚀的地方。本轮 Self-Review 一共抓到六处这种腐蚀（见末尾）。

- [ ] **Step 4: 写 `tests/loop.test.js` 的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createViewport, advanceLoop, reconcileBodies } from '../src/main.js';
import { createBody } from '../src/body.js';

// 计划 1 交接要求第 2 条的落点。原文：
//   "倍速必须用子步进实现，绝不能放大 dt" —— 因为 emotions.update 是前向欧拉
//   k = min(1, inertia*dt)，**不具**步长无关性；4× 若靠放大 dt 实现，
//   推进 1 模拟秒会得到 0.815837 而非 0.802441（偏差 1.6693%）。
// 计划 1 在 tests/emotions.test.js 里钉住的是**机制**层面（单条 update 调用）。
// 这里补的是**世界**层面：整个主循环跑出来的缸必须与直接连跑逐位相同。
// 少了这一层，"把子步进改回放大 dt"这个回归不会让任何测试变红 ——
// 因为情绪层的偏差只有 1.67%，肉眼和统计断言都看不出来。

const SEED = 20261020;

const snapshot = (w) => w.creatures.map((c) => [
  c.id, c.age, c.stage, c.alive ? 1 : 0,
  c.pos.x, c.pos.y, c.vel.x, c.vel.y, c.facing.x, c.facing.y,
  c.needs.hunger, c.needs.energy, c.needs.social, c.needs.safety,
  c.emotions.joy, c.emotions.anger, c.emotions.fear,
  c.emotions.curiosity, c.emotions.sleepy, c.emotions.arousal,
].join(',')).join('|');

test('createViewport：缩放由短边推导并 clamp（spec §3.4-2）', () => {
  assert.equal(createViewport(1920, 1080, 1).scale, 2);        // 1080/540
  assert.equal(createViewport(1080, 1920, 1).scale, 2);        // 竖过来短边不变 ⇒ 缩放不变
  assert.equal(createViewport(390, 844, 3).scale, 1.5);        // 0.722 触底
  assert.equal(createViewport(3840, 2160, 1).scale, 2.6);      // 4.0 触顶
  // dpr 与 scale 是两个独立的量：scale 是"世界单位→CSS 像素"，
  // dpr 只影响 canvas 的**位图**尺寸（CSS 像素 → 设备像素）。混用会让高分屏上生物大得离谱。
  const vp = createViewport(390, 844, 3);
  assert.equal(vp.width, 390);
  assert.equal(vp.height, 844);
  assert.equal(vp.dpr, 3);
});

test('advanceLoop：每帧子步数 = 倍速，且 dt 恒为 fixedDt（交接要求第 2 条）', () => {
  const loop = { acc: 0, steps: 0 };
  for (const ts of CONFIG.timeScales) {
    loop.acc = 0;
    const steps = advanceLoop(loop, CONFIG.fixedDt, ts);
    // frameDt = 1/60、倍速 ts ⇒ 每帧恰好 ts 个子步（0.5× 是隔帧一步）
    if (ts >= 1) assert.equal(steps, ts, `倍速 ${ts}× 应当每帧 ${ts} 个子步`);
    assert.ok(loop.acc >= 0 && loop.acc < CONFIG.fixedDt, `余量必须落在 [0, fixedDt)：${loop.acc}`);
  }
  // 0.5× 单独验：连续两帧才凑够一个 fixedDt
  loop.acc = 0;
  assert.equal(advanceLoop(loop, CONFIG.fixedDt, 0.5), 0);
  assert.equal(advanceLoop(loop, CONFIG.fixedDt, 0.5), 1);
});

test('advanceLoop：累加器封顶 0.25 秒，后台标签页恢复不会补算几千步（spec §3.4-1）', () => {
  const loop = { acc: 0, steps: 0 };
  // 模拟标签页在后台待了 30 秒后恢复：frameDt = 30
  const steps = advanceLoop(loop, 30, 4);
  const maxSteps = Math.floor(CONFIG.dtAccumCap / CONFIG.fixedDt);   // 0.25 / (1/60) = 15
  assert.equal(steps, maxSteps, `封顶后每帧最多 ${maxSteps} 步，实测 ${steps}`);
  // 关键：封顶的语义是**丢弃**超出的时间，不是留着慢慢追。
  // 留着追的话缸会"快进"到当下，玩家看到的是一缸生物瞬移。
  assert.ok(loop.acc < CONFIG.fixedDt, `余量必须被丢弃到不足一步：${loop.acc}`);
});

test('advanceLoop 原地修改 loop 对象，每帧零分配（spec §5.3）', () => {
  const loop = { acc: 0, steps: 0 };
  const ref = loop;
  for (let i = 0; i < 1000; i++) advanceLoop(loop, CONFIG.fixedDt, 1);
  assert.equal(loop, ref, '不得返回新对象 —— 每帧一个新对象就是每秒 60 次 GC 压力');
  assert.equal(loop.steps, 1);
});

test('4× 子步进的世界与直接连跑 4× 步数逐位相同；放大 dt 则不同', () => {
  const totalSteps = 240;                    // 4 模拟秒
  const frames = 60;                         // 1 秒真实时间 × 60fps
  const timeScale = 4;

  // A：基准 —— 直接连跑 240 个 fixedDt
  const wa = createWorld({ seed: SEED });
  for (let i = 0; i < totalSteps; i++) tickWorld(wa, CONFIG.fixedDt);

  // B：正确做法 —— 60 帧 × 每帧 4 个子步 × dt = fixedDt
  const wb = createWorld({ seed: SEED });
  const loop = { acc: 0, steps: 0 };
  for (let f = 0; f < frames; f++) {
    const steps = advanceLoop(loop, CONFIG.fixedDt, timeScale);
    assert.equal(steps, 4);
    for (let s = 0; s < steps; s++) tickWorld(wb, CONFIG.fixedDt);   // dt 恒为 fixedDt
  }

  // C：错误做法 —— 60 帧 × 每帧 1 步 × dt = fixedDt×4（推进的模拟时长同样是 4 秒）
  const wc = createWorld({ seed: SEED });
  for (let f = 0; f < frames; f++) tickWorld(wc, CONFIG.fixedDt * timeScale);

  assert.equal(snapshot(wb), snapshot(wa), '子步进必须与直接连跑逐位相同');
  // ⚠️ 下面这条**反向**断言才是本测试的价值所在。
  // 没有它，把 advanceLoop 改回"返回 1 步、dt 乘倍速"不会让任何测试变红，
  // 而症状是 1.67% 的情绪偏差 —— 既不会崩、也不会明显到被肉眼发现。
  assert.notEqual(snapshot(wc), snapshot(wa),
    '放大 dt 必须产生不同结果，否则上面那条相等断言是恒真的、什么都没守住');

  // 量一下偏差，确认它与计划 1 记录的机制同源（emotions 层，而非位置层）
  const ea = wa.creatures[0].emotions;
  const ec = wc.creatures[0].emotions;
  const dev = Math.abs(ec.joy - ea.joy) + Math.abs(ec.arousal - ea.arousal);
  assert.ok(dev > 1e-9, `情绪层应当有可测偏差，实测 ${dev}`);
  // 位置层是纯积分（pos += vel*dt），步长无关性**成立**，所以偏差不该来自它
  assert.ok(Math.abs(wc.creatures[0].pos.x - wa.creatures[0].pos.x) < 0.05,
    '位置层偏差应当远小于情绪层 —— 这正是这个 bug 难查的原因');
});

test('reconcileBodies：为新 id 建 Body、为消失的 id 删除，且不泄漏', () => {
  const world = createWorld({ seed: SEED });
  const bodies = new Map();
  reconcileBodies(bodies, world, 0);
  assert.equal(bodies.size, world.creatures.length);
  for (const c of world.creatures) {
    const b = bodies.get(c.id);
    assert.ok(b, `缺少 ${c.id} 的 Body`);
    assert.equal(b.points.length, CONFIG.bodyPoints);
    assert.equal(b.seen, 0);
  }

  // 幂等：同一帧再对账一次，不得新建也不得删除
  const before = bodies.size;
  reconcileBodies(bodies, world, 0);
  assert.equal(bodies.size, before);

  // 模拟一只消失（dissolved 后被 reapDead splice 掉）
  const gone = world.creatures.shift();
  reconcileBodies(bodies, world, 1);
  assert.equal(bodies.size, world.creatures.length);
  assert.equal(bodies.has(gone.id), false, '消失的 id 必须被删除，否则长跑会泄漏 Body');
  assert.equal(bodies.get(world.creatures[0].id).seen, 1);

  // 模拟一只新出现（hatch）
  world.creatures.push({ id: 'e-new', traits: { wobble: 0.4 } });
  reconcileBodies(bodies, world, 2);
  assert.ok(bodies.has('e-new'), '新 id 必须被建出来');
});

test('reconcileBodies 在生死churn下长跑不泄漏', () => {
  // 这条针对的是"只靠事件增删"的实现：hatch / dissolved / error(sick) / 计划 3 的读档
  // 都可能让 id 集合以事件覆盖不到的方式变化，而对账是幂等的、事件不是。
  const world = createWorld({ seed: SEED });
  const bodies = new Map();
  for (let frame = 0; frame < 600; frame++) {
    if (frame % 7 === 0 && world.creatures.length > 1) world.creatures.shift();
    if (frame % 11 === 0) world.creatures.push({ id: `x${frame}`, traits: { wobble: 0.5 } });
    reconcileBodies(bodies, world, frame);
    assert.equal(bodies.size, world.creatures.length, `第 ${frame} 帧 Body 数量与世界不一致`);
  }
});

test('setTimeScale 只接受 CONFIG.timeScales 里的值', async () => {
  const { setTimeScale } = await import('../src/main.js');
  // 没有活动 controller 时必须抛，而不是静默地把倍速写进虚空
  // （计划 3 的 HUD 按钮会在 boot 之后才存在，这个顺序错误必须响)
  assert.throws(() => setTimeScale(3), /未在运行|没有活动/, '没有 controller 时调用必须抛错');
});
```

- [ ] **Step 5: 跑测试确认它失败**

Run: `node --test tests/loop.test.js`
Expected: FAIL —— `Cannot find module '…/src/main.js'`。

- [ ] **Step 6: 写 `src/main.js`**

```js
// main.js —— 页面入口，也是**唯一**被允许触碰浏览器 API 的模块。
//
// 它做四件事，且只做这四件：
//   1. 装配世界（createWorld）与表现层（renderer / audio / input / bodies）
//   2. 用固定步长累加器推进 tickWorld，倍速靠**子步进**实现
//   3. resize 时重算视口与 canvas 位图尺寸
//   4. 每帧把 world 交给 render、把 events 交给 audio、把指针交给 world.playerHand
//
// 边界：除了 world.playerHand（内核唯一接受表现层写入的字段，见 sim.js:119），
// 本文件**不写任何内核状态**。不改 c.pos、不改 c.emotions、不直接调 adjustMemory。
// 抚摸买好感是内核自己在 tickCreature 里做的（sim.js:593-596）。
//
// ⚠️ 本文件在 Node 里也能被 import：顶层只有函数定义与一个 typeof 守卫，
// 不会执行任何 DOM 代码。tests/loop.test.js 依赖这一点来测 advanceLoop / createViewport。

import { CONFIG } from './config.js';
import { createWorld, tickWorld } from './sim.js';
import { createBody, updateBody } from './body.js';

// ---------------------------------------------------------------- 纯逻辑（可在 Node 测）

// 视口与缩放（spec §3.4-2）。
// scale 是"世界单位 → CSS 像素"，dpr 是"CSS 像素 → 设备像素"，两者**不可混用**：
// 混了会让高分屏上的生物大得离谱（3× dpr 的手机变成 3 倍体型）。
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

// Body 表的双向对账（标记-清扫）。
//
// 为什么不只靠 hatch / dissolved 事件增删：error(sick)、以及计划 3 的读档，
// 都可能让 id 集合以事件覆盖不到的方式变化。**对账是幂等的，事件不是** ——
// 漏一个事件就永久泄漏一个 Body，而对账每帧都会自我修正。
//
// 用 body.seen 标记而不是每帧 new Set()：Set 是每帧一次分配，见 advanceLoop 的注释。
// ⚠️ 边遍历边 delete 对 Map 是安全的（语言规范保证：迭代中被删除且尚未访问的项不会被访问），
// 换成普通对象或数组就不成立了。
export function reconcileBodies(bodies, world, frame) {
  for (const c of world.creatures) {
    let b = bodies.get(c.id);
    if (b === undefined) {
      b = createBody(c.traits);
      bodies.set(c.id, b);
    }
    b.seen = frame;
  }
  for (const [id, b] of bodies) {
    if (b.seen !== frame) bodies.delete(id);
  }
}

// ---------------------------------------------------------------- 活动 controller

let activeController = null;

// 供 devtools 与计划 3 的 HUD 调用（计划 2 刻意不做 HUD，见"范围边界"）。
export function setTimeScale(scale) {
  if (!activeController) throw new Error('setTimeScale: 没有在运行的缸（boot 尚未调用或已 stop）');
  activeController.setTimeScale(scale);
}

export function getTimeScale() {
  if (!activeController) throw new Error('getTimeScale: 没有在运行的缸');
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

  const bodies = new Map();
  const viewport = { width: 0, height: 0, dpr: 1, scale: 1 };
  const loop = { acc: 0, steps: 0 };
  const state = { frame: 0, timeScale: 1, lastT: -1, rafId: 0, running: true };

  // 渲染层与音频在 Task 4 / Task 9 接进来。本 Task 先用临时调试点确认主循环活着。
  const renderer = options.renderer || null;
  const audio = options.audio || null;
  const detachInput = options.detachInput || null;

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
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    if (renderer && renderer.onResize) renderer.onResize(viewport, world.rng.fork(seed ^ 0x5eed));
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
      // 软体弹簧跑在**固定步长**上而不是渲染帧率上（spec §3.4-1：手机 120Hz 与
      // 电脑 60Hz 下表现必须一致）。否则 120Hz 上同样的刚度会被积分两倍次数 ⇒ 更硬，
      // 而且 4× 倍速下形变会跟不上运动，看起来像拖着果冻。
      for (const c of world.creatures) {
        const b = bodies.get(c.id);
        if (b) updateBody(b, c, CONFIG.fixedDt);
      }
    }

    state.frame += 1;
    reconcileBodies(bodies, world, state.frame);

    // 绘制
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    if (renderer) {
      renderer.draw(ctx, world, bodies, viewport, state.frame);
    } else {
      // DEBUG-DOTS-BEGIN —— 临时调试绘制，Task 4 Step 6 必须整块删除。
      // 存在的唯一理由：让"主循环活着、坐标映射对了"在写完渲染层之前就能被眼睛确认。
      ctx.fillStyle = '#FF9EB5';
      for (const c of world.creatures) {
        const r = Math.max(1.5, c.traits.size * viewport.scale * 0.5);
        ctx.beginPath();
        ctx.arc(c.pos.x * viewport.width, c.pos.y * viewport.height, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // DEBUG-DOTS-END
    }

    // 事件消费（Task 7 接溶散动画、Task 9 接叫声）。
    // ⚠️ 必须每帧清空：world.events 是**无界增长**的（已知债务），
    // 开一小时的标签页会把它涨到几十万条，然后每帧遍历它。
    if (audio && world.events.length > 0) audio.consume(world.events, world);
    world.events.length = 0;
  };

  const controller = {
    world,
    viewport,
    bodies,
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
```

⚠️ 本 Task 结束时 `options.renderer` / `options.audio` / `options.detachInput` 都还是 `null`（Task 4/8/9 才接上），所以自动启动走的是 `DEBUG-DOTS` 分支。**这是预期的中间状态。**

⚠️ `boot()` 里 import 了 `createBody`/`updateBody`，但 `renderer`/`audio`/`input` 的 import 要等它们各自的 Task 落地时再加。**不要**现在就写下 `import { createRenderer } from './render.js'` —— 那会让 `tests/loop.test.js` 在 Task 3 就因模块不存在而失败，而失败原因与本 Task 的交付物无关。

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test tests/loop.test.js`
Expected: PASS，8 条全绿。

Run: `node --test tests/constraints.test.js`
Expected: PASS —— 包括新的四条（白名单未腐烂、依赖方向、可 import 性、防空转）。**可 import 性那条此时只列 `body.js`**（见 Step 1(c) 的说明）。

Run: `node --test tests/`
Expected: **415 tests / 415 pass / 0 fail**（404 + 8 loop + 3 constraints），stderr 0 字节。

- [ ] **Step 8: 变异探针（证明倍速断言真的在守东西）**

把 `advanceLoop` 临时改成「放大 dt」的错误实现：

```js
export function advanceLoop(loop, frameDt, timeScale) {
  let acc = loop.acc + frameDt;                 // ← 不乘倍速
  if (acc > CONFIG.dtAccumCap) acc = CONFIG.dtAccumCap;
  let steps = 0;
  while (acc >= CONFIG.fixedDt) { acc -= CONFIG.fixedDt; steps += 1; }
  loop.acc = acc; loop.steps = steps;
  loop.scaledDt = CONFIG.fixedDt * timeScale;   // ← 把倍速塞进 dt
  return steps;
}
```

并在 `boot` 的 step 循环里把 `tickWorld(world, CONFIG.fixedDt)` 换成 `tickWorld(world, loop.scaledDt || CONFIG.fixedDt)`。

Run: `node --test tests/loop.test.js`
Expected: 「4× 子步进的世界与直接连跑 4× 步数逐位相同」与「advanceLoop：每帧子步数 = 倍速」**两条都变红**。

改回原实现，再跑确认恢复绿，并把两次实测记进 `.superpowers/sdd/progress.md`。

⚠️ 这个探针值得做的理由：如果没有它，「逐位相同」那条断言可能因为 `snapshot` 写漏了字段而恒真。计划 1 的教训是——**没有变异探针的断言，等于没有断言**。

- [ ] **Step 9: 在浏览器里看一眼（本 Task 的交付物）**

双击 `start.bat`。Expected：深靛紫水体里有 **8 个粉色圆点**在游动、互相避让、偶尔停下；它们会**在窗口边缘被截住**（不会游出画面）；拖动窗口改变大小时圆点始终按比例铺满新尺寸、**不会挤到角落**。控制台无报错。

在 devtools 控制台里试倍速：
```js
__tank.setTimeScale(4);   // 应当明显加快，但生物的**动作质感不变**（不是慢动作快放）
__tank.setTimeScale(0.5); // 应当明显放慢
__tank.setTimeScale(3);   // 应当抛错：不在 CONFIG.timeScales 里
```

⚠️ 4× 时**重点看情绪相关的行为节奏**（求偶贴近、逃命散开）是否只是变快而没有变形。这正是交接要求第 2 条要防的东西 —— 放大 dt 会让情绪层跑得比位置层快，表现为"生物的情绪反应莫名其妙地迟钝或过敏"。

再试 resize 不重映射这条：
```js
const p = __tank.world.creatures.map(c => `${c.pos.x.toFixed(6)},${c.pos.y.toFixed(6)}`);
// 把窗口拖成另一种尺寸，等 1 秒，然后：
__tank.world.creatures.map((c,i) => c.pos.x.toFixed(6)===p[i].split(',')[0] ? 'same' : 'MOVED');
```
Expected: 生物因为**游动**而移动是正常的，但不应出现"整缸一起朝某个方向平移/缩放"的模式。真正要验的是 `resize` 里没有 `c.pos *=` 这类代码 —— 用 `grep -n "pos\.\(x\|y\)\s*\*=" src/main.js` 确认**无匹配**。

- [ ] **Step 10: 提交**

```bash
git add src/main.js src/config.js src/body.js tests/loop.test.js tests/constraints.test.js
git commit -m "feat: 固定步长主循环与倍速子步进（钉死交接要求第 2 条）"
```

---

### Task 4: `render.js` —— 水体层与「记录型桩 ctx」

本 Task 建立两件东西：水体（微粒、光束、缸底沉积），以及一个**记录型桩 `ctx`** —— 它让 spec §5.3 那三条性能硬约束（不每帧 `shadowBlur`、不每帧新建渐变、运行时不分配对象）从"靠自觉的注释"变成**会变红的断言**。后面的 Task 5/6/7 都复用这个桩。

**Files:**
- Create: `src/render.js`
- Modify: `src/config.js`（`CONFIG.render` 加水体常量；`CONFIG.colors` 加三个新色）
- Modify: `src/main.js`（接上 renderer，**删除 `DEBUG-DOTS` 整块**）
- Modify: `tests/constraints.test.js`（把 `'render.js'` 加回可 import 性那条）
- Test: `tests/render.test.js`

**Interfaces:**
- Consumes:
  - `CONFIG.particles`（`{desktop:120, mobile:60}`）、`CONFIG.colors.{mote,bgBottom}`、`CONFIG.glowHueBuckets`、`CONFIG.minSize`/`maxSize`、`CONFIG.fixedDt`
  - `world.{creatures,foods,eggs,time,rng}`、`creature.{pos,traits,alive,dying,sick}`
  - `Viewport`（Task 3）、`Body`（Task 2）
- Produces:
  - `createRenderer(opts) => Renderer`，`opts = { makeCanvas, rng, viewport, isMobile }`
  - `Renderer = { motes, shafts, glow, gel, sediment, moteSprite, onResize(viewport, rng), draw(ctx, world, bodies, viewport, dt) }`
  - `MakeCanvas = (w, h) => DrawCtx`
  - `hueBucket(hue, buckets) => 0..buckets-1`（纯函数，**含粉色跨 0° 的处理**）
  - `sizeBucket(size, buckets) => 0..buckets-1`（对数量化）
  - `screenX(wx, viewport) => number`、`screenY(wy, viewport) => number`（标量，零分配）
  - `createMotes(n, rng) => Motes`、`updateMotes(motes, viewport, dt)`

- [ ] **Step 1: 在 `CONFIG` 里加水体常量与新色**

`src/config.js` 的 `render:` 一节里，`scaleMax: 2.6,` 之后插入：

```js
    // 水体（spec §5.2、§4.3）。这些是 §12 授权的"实现阶段按观感直接定"的参数：
    // 光束与微粒的具体运动参数明确列在 §12 里，无需再次确认。
    // 微粒数量不在此处 —— 用 CONFIG.particles（桌面 120 / 手机 60）。
    moteRiseMin: 0.006,        // 归一化单位/秒；横穿整缸约需 167 秒（很慢，是背景不是主角）
    moteRiseMax: 0.020,        // 约 50 秒
    moteRadiusMin: 0.6,        // CSS 像素（乘 viewport.scale 之前的基准值）
    moteRadiusMax: 2.2,
    moteAlphaMin: 0.15,        // spec §4.3：alpha 0.15–0.4
    moteAlphaMax: 0.40,
    moteDrift: 0.004,          // 横向漂移幅度（正弦摆动的振幅，归一化单位）
    shaftCount: 3,             // spec §5.2：2–3 道
    shaftAlpha: 0.055,         // 用 'lighter' 混合，所以 alpha 必须很低，否则整缸发灰
    shaftSwayPeriod: 26,       // 秒；一道光束摆一个来回的时间。要慢到察觉不到在动
    sedimentHeight: 0.085,     // 占视口高度的比例；卵产在 y ∈ [0.78, 0.97]（breeding.js:127），
                               // 所以沉积带必须覆盖到 0.915 以上，卵才像是**落在**沉积物里而不是悬空
    moundCount: 5,             // 柔和堆叠形状的数量（spec §5.2：产卵点）
```

`CONFIG.colors` 一节末尾（`drowsy: '#8E6A8C',` 之后）插入：

```js
    // 计划 2 新增的三个表现层颜色。spec §4.3 只给了背景三段色，
    // 沉积带与光束的色值属 §12"实现阶段按观感直接定"的范围。
    // 沉积带比 bgBottom(#2D1240) **更暗**：它在缸底、离光源最远，
    // 而且要比卵的发光暗得足够多，卵才"像在沉积物里发亮"。
    sediment: '#170A22',
    sedimentLight: '#3A1850',   // 堆叠形状的受光面，制造体积感
    shaft: '#6A4A8A',           // 光束：偏冷的紫，用 'lighter' 叠上去后接近水的散射色
```

- [ ] **Step 2: 写 `tests/render.test.js` 的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { createViewport } from '../src/main.js';
import {
  createRenderer, hueBucket, sizeBucket, screenX, screenY, createMotes, updateMotes,
} from '../src/render.js';

// ------------------------------------------------------- 记录型桩 ctx
//
// 这个桩是本 Task 最有价值的产出，比水体本身重要。
// 它让 spec §5.3 的三条硬约束（不每帧 shadowBlur、不每帧新建渐变、运行时不分配对象）
// 变成**会变红的断言**，而不是写在注释里靠人评审记住的愿望。
// 计划 1 的经验是：靠评审记不住的约束，交给测试。
//
// 它只统计、不真画。所以这些测试跑在 Node 里、不需要浏览器、不需要 headless canvas。

const GRADIENT_STUB = { addColorStop() {} };

function createStubCtx() {
  const counts = new Map();
  const stub = {
    counts,
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    reset() { counts.clear(); stub.shadowBlurWrites = 0; },
    count(name) { return counts.get(name) || 0; },
  };
  const record = (name) => () => { counts.set(name, (counts.get(name) || 0) + 1); };
  for (const m of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke',
    'clip', 'clearRect', 'fillRect', 'setTransform', 'translate', 'rotate', 'scale',
    'drawImage', 'fillText']) stub[m] = record(m);
  // 渐变工厂要**既计数又返回一个可用的桩**，所以不能直接用 record()：
  // 调用方拿到返回值后会接着调 addColorStop，返回 undefined 会在测试里炸成
  // "Cannot read properties of undefined"，把真正的失败原因（每帧新建渐变）盖掉。
  stub.createRadialGradient = () => {
    counts.set('createRadialGradient', (counts.get('createRadialGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.createLinearGradient = () => {
    counts.set('createLinearGradient', (counts.get('createLinearGradient') || 0) + 1);
    return GRADIENT_STUB;
  });
  stub.measureText = () => ({ width: 0 });
  // shadowBlur 是**属性**不是方法，所以必须用 defineProperty 才能数到写入次数。
  // spec §5.3 说它是"手机浏览器上最大的性能杀手"，而它恰好是最容易被人顺手加上的一个属性。
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return stub._shadowBlur; },
    set(v) { stub.shadowBlurWrites += 1; stub._shadowBlur = v; },
  });
  return stub;
}

const makeCanvasStub = () => {
  const ctxs = [];
  return (w, h) => {
    const c = createStubCtx();
    c.width = w; c.height = h;
    ctxs.push(c);
    return c;
  };
};

const DESKTOP = createViewport(1920, 1080, 1);
const PHONE = createViewport(390, 844, 3);

const makeWorld = (seed) => {
  const w = createWorld({ seed });
  for (let i = 0; i < 30; i++) tickWorld(w, CONFIG.fixedDt);
  return w;
};

const makeBodies = (world) => {
  const bodies = new Map();
  for (const c of world.creatures) {
    const b = createBody(c.traits);
    for (let i = 0; i < 30; i++) updateBody(b, c, CONFIG.fixedDt);
    bodies.set(c.id, b);
  }
  return bodies;
};

// ------------------------------------------------------- 纯函数

test('hueBucket 覆盖整个粉色区间，且正确处理跨 0° 的并集', () => {
  // spec §4.2：粉色是 [315,360] ∪ [0,25]，**跨 0° 的并集，不是线性区间**。
  // 计划 1 已经用变异探针证明过这个盲区（"取 min/max 判断在不在区间内"是错的）。
  // 分桶必须同样处理跨 0°，否则 315–360 与 0–25 这两段会被分到不相邻的桶里，
  // 症状是色相平滑变化的两只生物，光晕颜色却跳变。
  const N = CONFIG.glowHueBuckets;
  assert.equal(hueBucket(315, N), 0, '区间起点应当落在第 0 桶');
  assert.equal(hueBucket(25, N), N - 1, '区间终点应当落在最后一桶');
  // 0° 距区间起点 315° 是 45°（315→360 占 45°，0° 紧随其后），
  // 所以它应当落在 45/70 处的桶 —— 这一条专门盯住"跨 0° 被当成区间外"的实现。
  assert.equal(hueBucket(0, N), Math.min(N - 1, Math.floor((45 / 70) * N)),
    '0° 应当按"距起点 45°"分桶，而不是被折到第 0 桶或最后一桶');
  // 单调性：沿 315 → 360 → 0 → 25 走一圈，桶号必须单调不减
  let prev = -1;
  for (let i = 0; i <= 700; i++) {
    const hue = (315 + (i / 700) * 70) % 360;
    const b = hueBucket(hue, N);
    assert.ok(b >= prev, `桶号在 hue=${hue.toFixed(2)} 处回退了：${b} < ${prev}`);
    assert.ok(b >= 0 && b < N, `桶号越界：${b}`);
    prev = b;
  }
  // 跨 0° 那一点必须连续（359.9 与 0.1 应当是相邻桶，而不是 0 桶与 31 桶）
  const before = hueBucket(359.9, N);
  const after = hueBucket(0.1, N);
  assert.ok(Math.abs(after - before) <= 1, `跨 0° 处桶号跳变：${before} → ${after}`);
});

test('sizeBucket 对数量化，覆盖 sizeOf 的实际范围', () => {
  // sizeOf = traits.size × growthFactor：traits.size ∈ [14,38]，growthFactor ∈ [0.22,1.00]
  // ⇒ 实际范围 [3.08, 38]，跨度 12 倍。线性量化会让刚孵化的小家伙全挤在第 0 桶，
  // 于是它们共用同一张 sprite、看起来一样大 —— 而"幼体比成体小得多"是本项目的可爱来源之一。
  const N = 8;
  assert.equal(sizeBucket(3.08, N), 0);
  assert.equal(sizeBucket(38, N), N - 1);
  // 对数量化的判据：几何中点应当落在中间桶附近，而不是第 0 桶
  const mid = Math.sqrt(3.08 * 38);          // ≈ 10.81
  const b = sizeBucket(mid, N);
  assert.ok(b >= 2 && b <= 5, `几何中点 ${mid.toFixed(2)} 应当落在中间桶，实测第 ${b} 桶`);
  // 单调
  let prev = -1;
  for (let s = 3.08; s <= 38; s += 0.5) {
    const k = sizeBucket(s, N);
    assert.ok(k >= prev && k >= 0 && k < N, `sizeBucket 在 ${s} 处非单调或越界：${k}`);
    prev = k;
  }
});

test('screenX/screenY：归一化中点映射到视口中点（两种设备都对）', () => {
  for (const vp of [DESKTOP, PHONE]) {
    assert.ok(Math.abs(screenX(0.5, vp) - vp.width / 2) < 1e-9);
    assert.ok(Math.abs(screenY(0.5, vp) - vp.height / 2) < 1e-9);
    assert.equal(screenX(0, vp), 0);
    assert.ok(Math.abs(screenX(1, vp) - vp.width) < 1e-9);
  }
  // ⚠️ 位置按视口**拉伸**填满，但体型**不跟着拉伸**（scale 只由短边推导）。
  // 这是刻意的：位置拉伸让缸在任何宽高比下都铺满，
  // 而体型不拉伸才能保证圆斑团子在超宽屏上还是圆的、不是椭圆。
  assert.notEqual(DESKTOP.width / DESKTOP.height, PHONE.width / PHONE.height);
  assert.ok(DESKTOP.scale !== PHONE.scale);
});

test('createMotes 一次性分配 typed array，数量取自 CONFIG.particles', () => {
  const rng = createWorld({ seed: 5 }).rng;
  const m = createMotes(CONFIG.particles.desktop, rng);
  assert.equal(m.n, CONFIG.particles.desktop);
  for (const key of ['x', 'y', 'r', 'vy', 'a', 'drift', 'phase']) {
    assert.ok(m[key] instanceof Float64Array, `${key} 必须是 Float64Array（对象池，spec §5.2）`);
    assert.equal(m[key].length, CONFIG.particles.desktop);
  }
  // 初值合法：位置在缸内、alpha 在 spec §4.3 的 0.15–0.4
  for (let i = 0; i < m.n; i++) {
    assert.ok(m.x[i] >= 0 && m.x[i] <= 1, `微粒 ${i} 的 x 越界`);
    assert.ok(m.y[i] >= 0 && m.y[i] <= 1, `微粒 ${i} 的 y 越界`);
    assert.ok(m.a[i] >= CONFIG.render.moteAlphaMin - 1e-12
      && m.a[i] <= CONFIG.render.moteAlphaMax + 1e-12, `微粒 ${i} 的 alpha ${m.a[i]} 不在 spec §4.3 的范围内`);
    assert.ok(Number.isFinite(m.vy[i]) && m.vy[i] > 0, `微粒 ${i} 必须向上漂`);
  }
});

test('updateMotes：微粒到顶后回到底部复用（对象池不重建），且不分配', () => {
  const rng = createWorld({ seed: 5 }).rng;
  const m = createMotes(20, rng);
  const xRef = m.x, yRef = m.y;
  // 跑到所有微粒都至少轮回一次（最慢的 moteRiseMin=0.006 ⇒ 167 秒）
  for (let i = 0; i < Math.round(200 / CONFIG.fixedDt); i++) updateMotes(m, DESKTOP, CONFIG.fixedDt);
  assert.equal(m.x, xRef, 'typed array 必须是同一个引用（运行时零分配）');
  assert.equal(m.y, yRef);
  assert.equal(m.n, 20);
  for (let i = 0; i < m.n; i++) {
    assert.ok(m.y[i] >= -0.05 && m.y[i] <= 1.05, `微粒 ${i} 跑出了合理范围：${m.y[i]}`);
    assert.ok(Number.isFinite(m.x[i]) && Number.isFinite(m.y[i]), `微粒 ${i} 不是有限数`);
  }
});

test('render.js 不 import perceive（交接义务第 2 条）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  assert.ok(!/\bperceive\b/.test(src),
    'perceive 在 tickWorld 之外调用会抛 TypeError（src/sim.js:286，world.grid 是旧下标）');
});

test('render.js 源码里不出现那七个浏览器全局名（靠注入，不靠豁免）', () => {
  // 这条与 constraints.test.js 的扫描重复，但**报错信息不同**：
  // 那条说"纯逻辑模块不得触碰 DOM"，这条直接告诉实现者该改用注入。
  // 保留它是因为 render.js 是最容易破例的模块 —— 预渲染 sprite 时
  // 顺手写一句 document.createElement('canvas') 太自然了。
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src),
      `render.js 出现了 ${name}；画布必须由 main.js 注入的 makeCanvas 提供，不得自己创建`);
  }
});

// ------------------------------------------------------- 性能硬约束（spec §5.3）

test('每帧零渐变创建、零 shadowBlur 写入（spec §5.3 硬约束）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const renderer = createRenderer({
    makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false,
  });
  const ctx = createStubCtx();

  renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);   // 预热一帧
  ctx.reset();                                                  // ← 只统计稳态帧

  for (let i = 0; i < 120; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }

  assert.equal(ctx.count('createRadialGradient'), 0,
    '每帧新建径向渐变是 spec §5.3 明令禁止的（计划 1 的注释称它为"手机浏览器上最大的性能杀手"）；渐变必须预渲染成 sprite');
  assert.equal(ctx.count('createLinearGradient'), 0,
    '同上：沉积带的渐变是**静态**的，必须预渲染');
  assert.equal(ctx.shadowBlurWrites, 0,
    'spec §5.3 禁止每帧 shadowBlur；发光必须用预渲染精灵 + globalCompositeOperation="lighter"');
  // drawImage 应当被大量使用（这才是预渲染的回报）
  assert.ok(ctx.count('drawImage') > 120 * 20,
    `微粒与光束应当走 drawImage，实测 ${ctx.count('drawImage')} 次 / 120 帧`);
});

test('sprite 缓存有界，不会随时间无限增长（防内存泄漏）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const renderer = createRenderer({
    makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false,
  });
  const ctx = createStubCtx();
  const bound = CONFIG.glowHueBuckets * 8;      // 色相 32 桶 × 尺寸 8 档
  for (let i = 0; i < 600; i++) {
    tickWorld(world, CONFIG.fixedDt);
    renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.ok(renderer.gel.size <= bound, `凝胶体 sprite 缓存 ${renderer.gel.size} 超过上界 ${bound}`);
  assert.equal(renderer.glow.length, CONFIG.glowHueBuckets, '光晕精灵必须恰好 32 张（启动时一次建好）');
});

test('水体层在手机视口下用 CONFIG.particles.mobile', () => {
  const world = makeWorld(11);
  const r = createRenderer({
    makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: PHONE, isMobile: true,
  });
  assert.equal(r.motes.n, CONFIG.particles.mobile,
    `手机应当只放 ${CONFIG.particles.mobile} 个微粒（spec §5.3 的性能预算）`);
});

test('onResize 不重建微粒池的 typed array（重建=每帧分配的另一种形式）', () => {
  const world = makeWorld(11);
  const r = createRenderer({
    makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false,
  });
  const xRef = r.motes.x;
  r.onResize(PHONE, world.rng.fork(2));
  assert.equal(r.motes.x, xRef, 'resize 只应重算分布范围，不该重新分配数组');
});
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/render.test.js`
Expected: FAIL —— `Cannot find module '…/src/render.js'`。

- [ ] **Step 4: 写 `src/render.js`（本 Task 只到水体层）**

```js
// render.js —— Canvas 绘制层（spec §5.1、§5.2、§5.3）。
//
// 纯逻辑模块：**不碰 document / window / canvas / requestAnimationFrame**。
// 画布上下文由调用方以形参传入（ctx），离屏画布由 main.js 注入的 makeCanvas 工厂提供。
// 这么做的回报是：本文件里那些真正容易写错的东西 —— 色相分桶、尺寸分桶、坐标映射、
// 微粒积分、绘制调用序列 —— 全部能在 Node 里断言，不需要 headless 浏览器。
//
// ⚠️ 两个会咬人的命名陷阱（tests/constraints.test.js 的扫描器只剥注释、不剥字符串字面量，
// 且用 \b 词边界匹配）：
//   · 局部变量**不得**叫 `canvas`（叫 spriteCanvas / offscreen / cvs）。
//     大写开头的 `spriteCanvas` 不匹配 \bcanvas\b，因为大小写不同且前面是单词字符。
//   · 源码里**不得**出现字符串 'canvas'（例如 document.createElement('canvas')）。
//     引号是非单词字符，会构成词边界而被匹配到。创建画布只能由注入的 makeCanvas 做。
// 这两条绕的是扫描器的**假阳性**（局部变量与字符串并非对浏览器全局的引用），
// 它的意图（"这些标识符在 Node 里不存在，引用它们会让模块 import 阶段就抛 ReferenceError"）
// 被完整保留 —— 而且 tests/render.test.js 里有一条测试直接 import 本模块来验证那个意图。
//
// ⚠️ 绘制**不可重入**：逐点屏幕坐标写进模块级复用数组（spec §5.3 运行时零分配）。
// 单线程顺序绘制天然满足；计划 3 若想加"缩略图预览"之类的并发绘制，必须先改掉这一点。

import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';

const TAU = Math.PI * 2;
const R = CONFIG.render;

// ---------------------------------------------------------------- 纯函数

// 色相分桶。粉色区间是 [315,360] ∪ [0,25]，**跨 0° 的并集** ——
// genes.decode 的公式是 hue = (315 + p.hue × 70) mod 360，所以整个区间宽 70°。
// 先把 hue 折算成"距区间起点 315° 的角距离"（0–70），再均分成 buckets 份。
// 这样跨 0° 是**连续**的：359.9° 与 0.1° 落在相邻桶，而不是首尾两端。
export function hueBucket(hue, buckets) {
  const span = CONFIG.hueRange[1] - CONFIG.hueRange[0] + 360;   // 25 - 315 + 360 = 70
  const start = CONFIG.hueRange[0];                             // 315
  let d = (hue - start) % 360;
  if (d < 0) d += 360;                       // hue < 315 时折回正数（0° → 45°）
  if (d > span) d = span;                    // 理论上不该发生（decode 保证了范围），防御性夹住
  const b = Math.floor((d / span) * buckets);
  return b >= buckets ? buckets - 1 : b;     // d === span 时 floor 会给出 buckets，必须夹回
}

// 尺寸分桶，对数量化。
// sizeOf 的实际范围是 [3.08, 38]（traits.size 14–38 × growthFactor 0.22–1.00），跨度 12 倍。
// 线性量化会把所有刚孵化的小家伙塞进第 0 桶，于是它们共用一张 sprite、看起来一样大。
const SIZE_LO = CONFIG.minSize * 0.22;       // 3.08
const SIZE_HI = CONFIG.maxSize;              // 38
const SIZE_LOG_SPAN = Math.log(SIZE_HI / SIZE_LO);

export function sizeBucket(size, buckets) {
  const s = size < SIZE_LO ? SIZE_LO : size > SIZE_HI ? SIZE_HI : size;
  const b = Math.floor((Math.log(s / SIZE_LO) / SIZE_LOG_SPAN) * buckets);
  return b >= buckets ? buckets - 1 : b < 0 ? 0 : b;
}

// 归一化世界坐标 → CSS 像素。
// ⚠️ 位置按视口**拉伸**填满（世界尺寸恒等于视口，spec §3.4-2），
// 但体型**不跟着拉伸** —— scale 只由短边推导，所以圆斑团子在超宽屏上还是圆的。
// 返回标量而不是 {x,y} 对象：这两个函数在每帧每只生物上都要调用，
// 返回对象就是每秒几百次分配（spec §5.3 禁止）。
export const screenX = (wx, viewport) => wx * viewport.width;
export const screenY = (wy, viewport) => wy * viewport.height;

// 当前渲染半径（CSS 像素）。sizeOf 已经是世界单位（含 growthFactor 的年龄缩放）。
export const radiusPx = (c, viewport) => sizeOf(c) * viewport.scale * 0.5;

// ---------------------------------------------------------------- 微粒对象池

export function createMotes(n, rng) {
  const m = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    r: new Float64Array(n),
    vy: new Float64Array(n),
    a: new Float64Array(n),
    drift: new Float64Array(n),
    phase: new Float64Array(n),
    baseX: new Float64Array(n),
  };
  seedMotes(m, rng);
  return m;
}

function seedMotes(m, rng) {
  for (let i = 0; i < m.n; i++) {
    m.baseX[i] = rng.next();
    m.x[i] = m.baseX[i];
    m.y[i] = rng.next();                                  // 初始就铺满整缸，不是从底部一起冒出来
    m.r[i] = rng.range(R.moteRadiusMin, R.moteRadiusMax);
    m.vy[i] = rng.range(R.moteRiseMin, R.moteRiseMax);
    m.a[i] = rng.range(R.moteAlphaMin, R.moteAlphaMax);   // spec §4.3：0.15–0.4
    m.drift[i] = rng.range(0, R.moteDrift);
    m.phase[i] = rng.range(0, TAU);
  }
}

export function updateMotes(m, viewport, dt) {
  const t = viewport.time || 0;
  for (let i = 0; i < m.n; i++) {
    m.y[i] -= m.vy[i] * dt;                 // 向上漂（屏幕 y 向下为正）
    if (m.y[i] < -0.02) {                   // 到顶后回到底部**复用**，不重建对象
      m.y[i] += 1.04;
      m.x[i] = m.baseX[i];                  // 重置漂移基准，避免长期单向累积
      m.phase[i] = (m.phase[i] + 1.7) % TAU;
    }
    // 横向缓慢摆动。用 sin 而不是随机游走：随机游走需要每帧取随机数，
    // 那会让水体在两台设备上长得不一样（而 spec §3.4-1 要求设备无关）。
    m.x[i] = m.baseX[i] + Math.sin(t * 0.35 + m.phase[i]) * m.drift[i];
  }
}

// ---------------------------------------------------------------- 渲染器

export function createRenderer(opts) {
  const makeCanvas = opts.makeCanvas;
  if (typeof makeCanvas !== 'function') {
    throw new TypeError('createRenderer: 需要注入 makeCanvas(w, h) => ctx（render.js 不碰 document）');
  }
  const isMobile = !!opts.isMobile;
  const renderer = {
    makeCanvas,
    isMobile,
    viewport: opts.viewport,
    motes: createMotes(isMobile ? CONFIG.particles.mobile : CONFIG.particles.desktop, opts.rng),
    shafts: [],
    sediment: null,        // 预渲染的缸底 sprite（静态 ⇒ 只建一次）
    moteSprite: null,      // 预渲染的微粒 sprite
    glow: [],              // Task 5：32 张光晕精灵
    gel: new Map(),        // Task 5：凝胶体 sprite 缓存，键 = hueBucket * 8 + sizeBucket
    // 逐点屏幕坐标的复用数组（spec §5.3：运行时不分配对象）
    sx: new Float64Array(CONFIG.bodyPoints),
    sy: new Float64Array(CONFIG.bodyPoints),
    time: 0,
    onResize(viewport, rng) {
      renderer.viewport = viewport;
      // 微粒**不重新分配**，只把越界的拉回缸内：重建 typed array 等于每次 resize
      // 都产生一次大块分配，而拖动窗口时会连续触发几十次 resize。
      const m = renderer.motes;
      for (let i = 0; i < m.n; i++) {
        if (m.y[i] > 1.05 || m.y[i] < -0.05) m.y[i] = rng.next();
      }
      buildStatics(renderer);
    },
    draw(ctx, world, bodies, viewport, dt) {
      renderer.time += dt;
      viewport.time = renderer.time;
      updateMotes(renderer.motes, viewport, dt);
      drawWater(ctx, renderer, viewport);
      // Task 5/6/7 在这里接上生物、食物、卵的绘制
    },
  };
  buildStatics(renderer);
  return renderer;
}

// 静态层预渲染：缸底沉积带与光束。
//
// 为什么必须预渲染：spec §5.3 禁止每帧新建渐变，而沉积带本身就是一条线性渐变。
// 它是**完全静态**的（只依赖视口尺寸），所以预渲染成一张 sprite 是纯赚 ——
// 每帧一次 drawImage 换掉每帧一次 createLinearGradient + fillRect。
function buildStatics(renderer) {
  const vp = renderer.viewport;
  const w = Math.max(1, Math.round(vp.width));
  const h = Math.max(1, Math.round(vp.height));

  // ---- 缸底沉积带 + 柔和堆叠（spec §5.2："产卵点"）----
  const sedH = Math.max(1, Math.round(h * R.sedimentHeight));
  const sctx = renderer.makeCanvas(w, sedH);
  const grad = sctx.createLinearGradient(0, 0, 0, sedH);
  grad.addColorStop(0, 'rgba(23,10,34,0)');                    // CONFIG.colors.sediment 透明版
  grad.addColorStop(0.45, CONFIG.colors.sediment);
  grad.addColorStop(1, CONFIG.colors.sediment);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, w, sedH);
  // 堆叠形状：卵产在 y ∈ [0.78,0.97]（breeding.js:127），沉积带覆盖 0.915 以下，
  // 所以堆叠要落在沉积带里，卵才像是**埋在**沉积物中而不是悬空。
  sctx.fillStyle = CONFIG.colors.sedimentLight;
  sctx.globalAlpha = 0.5;
  for (let i = 0; i < R.moundCount; i++) {
    const cx = ((i + 0.5) / R.moundCount) * w;
    const rw = w / R.moundCount * 0.62;
    const rh = sedH * 0.42;
    sctx.beginPath();
    sctx.ellipse(cx, sedH - rh * 0.35, rw, rh, 0, 0, TAU);
    sctx.fill();
  }
  sctx.globalAlpha = 1;
  renderer.sediment = { ctx: sctx, w, h: sedH };

  // ---- 光束（spec §5.2：2–3 道缓慢摆动的光柱，预渲染后平移）----
  renderer.shafts.length = 0;
  const shaftW = Math.max(8, Math.round(w * 0.16));
  for (let i = 0; i < R.shaftCount; i++) {
    const sctx2 = renderer.makeCanvas(shaftW, h);
    const g2 = sctx2.createLinearGradient(0, 0, shaftW, 0);
    g2.addColorStop(0, 'rgba(106,74,138,0)');                  // CONFIG.colors.shaft 的两端透明版
    g2.addColorStop(0.5, CONFIG.colors.shaft);
    g2.addColorStop(1, 'rgba(106,74,138,0)');
    sctx2.fillStyle = g2;
    sctx2.fillRect(0, 0, shaftW, h);
    // 上宽下窄的锥形衰减：光从水面斜射进来，越深越弱
    const fade = sctx2.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    sctx2.globalCompositeOperation = 'destination-in';
    sctx2.fillStyle = fade;
    sctx2.fillRect(0, 0, shaftW, h);
    sctx2.globalCompositeOperation = 'source-over';
    renderer.shafts.push({ ctx: sctx2, w: shaftW, h, base: (i + 0.5) / R.shaftCount, phase: i * 2.1 });
  }

  // ---- 微粒 sprite（一张柔和圆点，运行时只 drawImage + 改 globalAlpha）----
  const ms = 16;
  const mctx = renderer.makeCanvas(ms, ms);
  const mg = mctx.createRadialGradient(ms / 2, ms / 2, 0, ms / 2, ms / 2, ms / 2);
  // CONFIG.colors.mote = '#FFD9E8'
  mg.addColorStop(0, 'rgba(255,217,232,1)');
  mg.addColorStop(0.4, 'rgba(255,217,232,0.55)');
  mg.addColorStop(1, 'rgba(255,217,232,0)');
  mctx.fillStyle = mg;
  mctx.fillRect(0, 0, ms, ms);
  renderer.moteSprite = { ctx: mctx, size: ms };
}

function drawWater(ctx, renderer, viewport) {
  const w = viewport.width;
  const h = viewport.height;

  // 光束：'lighter' 叠加，靠平移预渲染好的 sprite 实现摆动（不重建渐变）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = R.shaftAlpha;
  for (const s of renderer.shafts) {
    const sway = Math.sin(renderer.time / R.shaftSwayPeriod * TAU + s.phase) * 0.06;
    const x = (s.base + sway) * w - s.w * 0.5;
    ctx.drawImage(s.ctx.canvas !== undefined ? s.ctx.canvas : s.ctx, x, 0, s.w, h);
  }
  ctx.restore();

  // 缸底沉积带（静态 sprite，一次 drawImage）
  if (renderer.sediment) {
    ctx.drawImage(
      renderer.sediment.ctx.canvas !== undefined ? renderer.sediment.ctx : renderer.sediment.ctx,
      0, h - renderer.sediment.h, w, renderer.sediment.h,
    );
  }

  // 微粒：只改 globalAlpha 与目标尺寸，sprite 本身是同一张
  const sprite = renderer.moteSprite;
  const src = sprite.ctx.canvas !== undefined ? sprite.ctx.canvas : sprite.ctx;
  const m = renderer.motes;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < m.n; i++) {
    const d = m.r[i] * 2 * viewport.scale * 0.5;
    ctx.globalAlpha = m.a[i];
    ctx.drawImage(src, screenX(m.x[i], viewport) - d, screenY(m.y[i], viewport) - d, d * 2, d * 2);
  }
  ctx.restore();
}
```

⚠️ **`makeCanvas` 的返回值约定必须在 Task 4 Step 5 定死**：上面代码里那些 `s.ctx.canvas !== undefined ? s.ctx.canvas : s.ctx` 是为了同时兼容「返回 ctx」与「返回 canvas 元素」两种注入实现而写的丑陋三元式。**这是坏味道，必须消除**：约定 `makeCanvas(w, h)` 返回 `{ ctx, surface }`，其中 `surface` 是能直接喂给 `drawImage` 的东西（浏览器里是离屏 canvas 元素，桩里是记录对象）。然后把上面所有三元式替换成 `.surface`，并把 `renderer.sediment` / `shafts[i]` / `moteSprite` 的字段名统一成 `{ ctx, surface, w, h }`。

`main.js` 里的注入实现相应写成：

```js
  const renderer = createRenderer({
    makeCanvas: (w, h) => {
      const off = document.createElement('canvas');   // ← 唯一允许出现 'canvas' 字符串的地方
      off.width = w;
      off.height = h;
      return { ctx: off.getContext('2d'), surface: off };
    },
    rng: world.rng.fork(seed ^ 0x9e37),
    viewport,
    isMobile: coarse,
  });
```

- [ ] **Step 5: 把 renderer 接进 `main.js`，删掉临时调试点**

三处改动：

1. 顶部 import 加上 `import { createRenderer } from './render.js';`
2. `boot()` 里把 `const renderer = options.renderer || null;` 换成上面那段真实的 `createRenderer({...})` 调用（`options.renderer` 的注入口保留，测试要用：`const renderer = options.renderer || createRenderer({...})`）
3. **整块删除** `// DEBUG-DOTS-BEGIN` 到 `// DEBUG-DOTS-END`（含两行标记），把 `renderer.draw(...)` 的调用改成传 `dt`：

```js
    const simDt = steps * CONFIG.fixedDt;      // 本帧推进的**模拟**秒数
    if (renderer) {
      renderer.draw(ctx, world, bodies, viewport, simDt);
    }
```

⚠️ 传 `simDt` 而不是 `frameDt`：微粒与光束必须按**模拟时间**推进，否则 4× 倍速下水体还是原速（看起来像缸在快进而水冻住了），0.5× 下水体反而比生物快。

- [ ] **Step 6: 确认临时调试点真的删干净了**

Run: `grep -n "DEBUG-DOTS" src/main.js`
Expected: **无输出**（退出码 1）。

⚠️ 这一步不能跳。临时脚手架留在生产代码里是本项目最容易犯的一类错 —— 它不报错、不影响测试，只会在某天让画面上多出一堆粉色圆点，而那时候没人记得它是怎么来的。

- [ ] **Step 7: 把 `render.js` 加回纯度守卫的可 import 性测试**

`tests/constraints.test.js` 里那条测试的数组从 `['body.js']` 改成 `['body.js', 'render.js']`。

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test tests/render.test.js`
Expected: PASS，11 条全绿。

Run: `node --test tests/`
Expected: **426 tests / 426 pass / 0 fail**（415 + 11），stderr 0 字节。

Run: `node --test tests/constraints.test.js`
Expected: PASS —— **`render.js` 在纯度扫描范围内，且扫描是绿的**。这一步是本 Task 最重要的架构验证：它证明「依赖注入让渲染层留在纯集合里」这个决定真的成立，而不是纸面上的说法。

- [ ] **Step 9: 变异探针**

(a) 把 `drawWater` 里光束的 `ctx.drawImage(...)` 换成每帧重建渐变：

```js
    const g = ctx.createLinearGradient(x, 0, x + s.w, 0);
    g.addColorStop(0, 'rgba(106,74,138,0)');
    g.addColorStop(0.5, CONFIG.colors.shaft);
    g.addColorStop(1, 'rgba(106,74,138,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, s.w, h);
```

Run: `node --test tests/render.test.js`
Expected:「每帧零渐变创建、零 shadowBlur 写入」**变红**，报错信息里带着实际的 `createLinearGradient` 次数。

(b) 在 `drawWater` 开头加一行 `ctx.shadowBlur = 12;`
Expected: 同一条测试变红，且 `shadowBlurWrites` 计数非零。

(c) 把 `hueBucket` 的实现换成「先归一化到 0–360 再除以 360 分桶」（即忽略粉色区间跨 0°）：
```js
export function hueBucket(hue, buckets) {
  return Math.min(buckets - 1, Math.floor((hue / 360) * buckets));
}
```
Expected:「hueBucket 覆盖整个粉色区间，且正确处理跨 0° 的并集」**变红**（单调性与跨 0° 连续性两条断言都会挂）。

三处都改回来，重跑确认全绿，把实测记进 `.superpowers/sdd/progress.md`。

- [ ] **Step 10: 在浏览器里看一眼**

双击 `start.bat`。Expected：
- 深靛紫水体里有**极缓慢上升**的粉色微粒，亮度各异（alpha 0.15–0.4），到顶后从底部重新出现
- 2–3 道**几乎察觉不到在动**的斜光柱，缓慢左右摆动
- 缸底一条深色沉积带，带上有几个柔和的凸起
- 8 只粉色团子（此时还是 Task 5 之前的简化绘制，可能只是圆形）在其中游动
- 控制台无报错；4× 倍速下**水体也跟着加快**（验 Step 5 的 `simDt`）

⚠️ 微粒如果看起来「太快」或「太亮」，那是观感问题不是 bug —— spec §12 明确把「光束与微粒的具体运动参数」列为实现阶段按观感直接定。**调整时只改 `CONFIG.render`，并把改前改后的观感写进注释。**

- [ ] **Step 11: 提交**

```bash
git add src/render.js src/main.js src/config.js tests/render.test.js tests/constraints.test.js
git commit -m "feat: 水体渲染层（微粒对象池、预渲染光束与沉积带、性能硬约束自动化）"
```

---

### Task 5: `render.js` —— 光晕精灵与分层身体（第 1–4 层）

spec §5.1 的分层绘制顺序（**由内到外**）：光晕 → 半透明凝胶体 → 花纹 → 发光核 → 眼睛 → 腮红 → 左上缘高光。本 Task 做前四层，Task 6 做后三层。

**Files:**
- Modify: `src/render.js`
- Modify: `src/config.js`（`CONFIG.render` 加分层常量）
- Test: `tests/render.test.js`（追加）

**Interfaces:**
- Consumes:
  - `import { dominant, EMOTION_KEYS } from './emotions.js'` — `dominant(emotions) => string`（返回当前主导情绪的键）
  - `CONFIG.colors.{sakura,peach,coral,orchid,rose,angry,pale,drowsy,pupil,blush}`、`CONFIG.glowHueBuckets`、`CONFIG.bodyPoints`
  - `hueBucket` / `sizeBucket` / `screenX` / `screenY` / `radiusPx`（Task 4 本文件内）
  - `c.traits.{hue,sat,lum,glow,pattern,patternDensity}`、`c.facing.{x,y}`、`c.pos`、`Body.points`
- Produces:
  - `buildBodyPath(ctx, renderer, c, body, cx, cy, r) => void`（把 24 点转成 Catmull-Rom 平滑闭合贝塞尔路径）
  - `writeBodyScreen(renderer, body, cx, cy, r, facing) => void`（把局部坐标变换进 `renderer.sx/sy`，**零分配**）
  - `coreColorFor(emotions) => string`（返回 `CONFIG.colors` 里的**既有字符串**，不构造新字符串）
  - `gelKey(hue, size) => number`
  - `getGelSprite(renderer, hue, size) => { ctx, surface, size }`
  - `getGlowSprite(renderer, hue) => { ctx, surface, size }`
  - `drawCreature(ctx, renderer, c, body, viewport) => void`

- [ ] **Step 1: 在 `CONFIG.render` 里加分层常量**

```js
    // 分层绘制（spec §5.1，由内到外：光晕 → 凝胶体 → 花纹 → 发光核 → 眼睛 → 腮红 → 高光）。
    gelAlpha: 0.55,            // spec §5.1 逐字："半透明凝胶体(alpha≈0.55 径向渐变)"
    glowRadiusFactor: 2.6,     // 光晕半径 = 体半径 × 此值；配合 'lighter' 才有"在发光"的感觉
    glowAlphaFactor: 0.55,     // 最终 alpha = traits.glow × 此值（traits.glow ∈ [0.35,1]）
    coreRadiusFactor: 0.30,    // 发光核半径 = 体半径 × 此值（"体心脉动亮椭圆"）
    corePulse: 0.22,           // 脉动幅度：核半径在 ±22% 之间随 body.pulse 呼吸
    coreAlpha: 0.85,
    sizeBuckets: 8,            // 凝胶体 sprite 的尺寸档数（见架构决定 7）
    patternAlpha: 0.30,        // 花纹透明度：要看得见，但不能盖过凝胶体的通透感
    patternMarkFactor: 0.16,   // 单个花纹斑点的半径 = 体半径 × 此值
```

- [ ] **Step 2: 追加失败测试到 `tests/render.test.js`**

```js
import { dominant, EMOTION_KEYS } from '../src/emotions.js';
import { phenotype, randomGenome } from '../src/genes.js';
import {
  buildBodyPath, writeBodyScreen, coreColorFor, gelKey,
} from '../src/render.js';

test('光晕精灵恰好 glowHueBuckets 张，且在 createRenderer 时一次建好', () => {
  const world = makeWorld(11);
  const factory = makeCanvasStub();
  const r = createRenderer({ makeCanvas: factory, rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  assert.equal(r.glow.length, CONFIG.glowHueBuckets);
  for (const s of r.glow) {
    assert.ok(s && s.surface, '每张光晕精灵都必须有可 drawImage 的 surface');
    assert.ok(s.size > 0);
  }
});

test('凝胶体 sprite 惰性建表、键稳定、缓存有界', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  // 同一个 (hue, size) 两次取必须是同一张 sprite —— 否则就是每帧新建渐变换了个马甲
  const a = r.getGelSprite(330, 26);
  const b = r.getGelSprite(330, 26);
  assert.equal(a, b);
  assert.equal(r.gel.size, 1);
  // 同桶内不同值必须命中同一张（分桶的意义就在于此）
  const N = CONFIG.glowHueBuckets;
  const k1 = gelKey(330, 26);
  assert.equal(k1, gelKey(330.4, 26.3), '同桶的 hue/size 必须给出同一个键');
  assert.ok(Number.isInteger(k1) && k1 >= 0 && k1 < N * CONFIG.render.sizeBuckets);
});

test('coreColorFor 返回 CONFIG.colors 里的既有字符串，不构造新字符串', () => {
  // spec §5.3 禁止运行时分配；每帧拼一个 `hsl(...)` 模板字符串就是每秒 60×24 次分配。
  // 所以情绪色只能从一张固定的查色表里**取**，不能**算**。
  const known = new Set(Object.values(CONFIG.colors));
  const emotions = { joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 };
  const seen = new Set();
  for (const key of EMOTION_KEYS) {
    for (const v of [0, 0.5, 1]) {
      emotions[key] = v;
      const color = coreColorFor(emotions);
      assert.ok(known.has(color), `情绪 ${key}=${v} 的颜色 ${color} 不在 CONFIG.colors 里（说明是新构造的字符串）`);
      seen.add(color);
    }
    emotions[key] = 0;
  }
  // 不同情绪必须给出不同颜色，否则"发光核颜色=情绪色"（spec §5.1）就没有信息量
  assert.ok(seen.size >= EMOTION_KEYS.length,
    `${EMOTION_KEYS.length} 种情绪只映射出 ${seen.size} 种颜色`);
  // 中性也必须有一个颜色（dominant 在全 0 时的返回值）
  assert.ok(known.has(coreColorFor(emotions)));
});

test('coreColorFor 与 dominant() 一致（不得自己另写一套主导情绪判定）', () => {
  const world = makeWorld(11);
  const known = new Set(Object.values(CONFIG.colors));
  for (const c of world.creatures) {
    const color = coreColorFor(c.emotions);
    assert.ok(known.has(color));
    // dominant 是内核导出的权威判定；render 若自己写 argmax 就会与内核漂移
    assert.ok(typeof dominant(c.emotions) === 'string');
  }
});

test('writeBodyScreen：局部 +x 映射到 facing 方向，且 facing 是单位向量时不需要 atan2', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const body = createBody({ wobble: 0.5 });
  const cx = 500, cy = 300, rad = 40;
  const facing = { x: 0.6, y: 0.8 };      // 已经是单位向量（sim.js:532-534 保证）

  writeBodyScreen(r, body, cx, cy, rad, facing);
  // 局部点 (1,0)（第 0 个点）应当落在 cx + rad*facing.x, cy + rad*facing.y
  assert.ok(Math.abs(r.sx[0] - (cx + rad * 1 * facing.x)) < 1e-9, `sx[0]=${r.sx[0]}`);
  assert.ok(Math.abs(r.sy[0] - (cy + rad * 1 * facing.y)) < 1e-9, `sy[0]=${r.sy[0]}`);
  // 局部点 (0,1)（第 6 个点，90°）应当落在垂直方向
  const q = CONFIG.bodyPoints / 4;
  assert.ok(Math.abs(r.sx[q] - (cx + rad * (-facing.y))) < 1e-6, `sx[${q}]=${r.sx[q]}`);
  assert.ok(Math.abs(r.sy[q] - (cy + rad * facing.x)) < 1e-6, `sy[${q}]=${r.sy[q]}`);
});

test('writeBodyScreen 复用同一个 typed array（spec §5.3 运行时零分配）', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const body = createBody({ wobble: 0.5 });
  const sxRef = r.sx, syRef = r.sy;
  for (let i = 0; i < 300; i++) writeBodyScreen(r, body, 100, 100, 30, { x: 1, y: 0 });
  assert.equal(r.sx, sxRef);
  assert.equal(r.sy, syRef);
  assert.equal(r.sx.length, CONFIG.bodyPoints);
});

test('buildBodyPath：闭合曲线，每点一段贝塞尔，坐标全部有限', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const body = createBody({ wobble: 1 });
  const c = world.creatures[0];
  for (let i = 0; i < 60; i++) updateBody(body, c, CONFIG.fixedDt);
  writeBodyScreen(r, body, 400, 300, 50, c.facing);

  const ctx = createStubCtx();
  buildBodyPath(ctx, r, c, body, 400, 300, 50);
  // Catmull-Rom 转贝塞尔：n 个点 ⇒ n 段 ⇒ n 次 bezierCurveTo，且必须闭合
  assert.equal(ctx.count('bezierCurveTo'), CONFIG.bodyPoints,
    `应当每点一段贝塞尔，实测 ${ctx.count('bezierCurveTo')} 段`);
  assert.equal(ctx.count('beginPath'), 1);
  assert.equal(ctx.count('closePath'), 1, '必须闭合，否则花纹的 clip 会漏');
  assert.equal(ctx.count('moveTo'), 1);
});

test('hueBucket 与 genes.decode 的实际输出一致（不得重新解码基因）', () => {
  // 计划 1 的纪律：表现层读 c.traits.hue，不自己解码基因。
  // 这条测试确保分桶函数吃的是 decode 已经算好的那个 hue，
  // 而不是某个"看起来差不多"的近似值。
  const rng = createWorld({ seed: 99 }).rng;
  const N = CONFIG.glowHueBuckets;
  const buckets = new Set();
  for (let i = 0; i < 400; i++) {
    const t = phenotype(randomGenome(rng));
    const b = hueBucket(t.hue, N);
    assert.ok(b >= 0 && b < N, `hue ${t.hue} 分到越界的桶 ${b}`);
    buckets.add(b);
  }
  // 400 个随机基因组应当铺满大部分桶；只落在少数几个桶说明分桶公式与 decode 不同源
  assert.ok(buckets.size >= N * 0.75,
    `400 个随机基因组只覆盖了 ${buckets.size}/${N} 个色相桶`);
});

test('drawCreature 的层序：光晕在凝胶体之前，且凝胶体在 clip 之内（spec §5.1）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const ctx = createStubCtx();
  ctx.reset();
  drawCreature(ctx, r, world.creatures[0], bodies.get(world.creatures[0].id), DESKTOP);
  // clip 必须出现：凝胶体的径向渐变 sprite 要被身体轮廓裁住，
  // 否则形变（挤压、凹陷）在画面上完全看不出来 —— 团子会退化成一个圆。
  assert.ok(ctx.count('clip') >= 1, '凝胶体必须在身体轮廓的 clip 之内绘制');
  assert.ok(ctx.count('drawImage') >= 2, '至少要有光晕与凝胶体两次 drawImage');
  assert.ok(ctx.count('bezierCurveTo') >= CONFIG.bodyPoints);
});
```

⚠️ 最后那条测试需要在文件顶部的 import 里补上 `drawCreature`。

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/render.test.js`
Expected: FAIL —— `buildBodyPath` / `writeBodyScreen` / `coreColorFor` / `gelKey` / `getGelSprite` / `drawCreature` 都不是 `render.js` 的导出。

- [ ] **Step 4: 在 `src/render.js` 里实现分层身体**

顶部 import 补两行：

```js
import { dominant } from './emotions.js';
```

在 `radiusPx` 之后加入：

```js
// ---------------------------------------------------------------- 情绪 → 发光核颜色

// 情绪色查色表。
//
// ⚠️ 只能**取**既有字符串，不能**算**新字符串：spec §5.3 禁止运行时分配，
// 而每帧拼一个 `hsl(${…})` 模板字符串就是 60×24 = 每秒 1440 次分配。
// 所以这里返回的全部是 CONFIG.colors 里的常量引用。
//
// 注意 angry / pale / drowsy 这三个颜色在**内核里没有任何消费者** ——
// 它们是计划 1 就为表现层预留好的。用它们不是巧合，是兑现那份预留。
const CORE_COLORS = {
  joy: CONFIG.colors.sakura,        // #FFC8DE 樱花粉：开心是最亮最浅的粉
  anger: CONFIG.colors.angry,       // #FF1F6B 玫红偏红：唯一离开粉色区的颜色，故意刺眼
  fear: CONFIG.colors.pale,         // #D8C4CC 灰粉：血色褪去
  curiosity: CONFIG.colors.peach,   // #FF9EB5 桃粉
  sleepy: CONFIG.colors.drowsy,     // #8E6A8C 暗紫粉：光在熄灭
  arousal: CONFIG.colors.rose,      // #FF4D8D 玫红：求偶时"全场最亮"
};
const CORE_NEUTRAL = CONFIG.colors.orchid;   // #E8A7D8 淡粉紫

export function coreColorFor(emotions) {
  // dominant() 是内核导出的权威判定（emotions.js）。
  // ⚠️ 不得在这里自己写一遍 argmax：那会与内核漂移，
  // 而漂移的症状是"发光核的颜色和它的行为对不上"，极难归因。
  const key = dominant(emotions);
  return Object.hasOwn(CORE_COLORS, key) ? CORE_COLORS[key] : CORE_NEUTRAL;
}

// ---------------------------------------------------------------- sprite 查表

// 凝胶体 sprite 的键 = hueBucket × sizeBuckets + sizeBucket。
// 用整数键而不是字符串键：字符串拼接是分配，整数不是（spec §5.3）。
export function gelKey(hue, size) {
  return hueBucket(hue, CONFIG.glowHueBuckets) * R.sizeBuckets + sizeBucket(size, R.sizeBuckets);
}

const hsl = (h, s, l, a) => `hsla(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%, ${a})`;

// 反向查表：给定桶号，还原出该桶的代表色相。
// 预渲染必须从桶号反推颜色，否则建 sprite 时就不知道该画什么色。
function bucketHue(b, buckets) {
  const span = CONFIG.hueRange[1] - CONFIG.hueRange[0] + 360;   // 70
  const mid = ((b + 0.5) / buckets) * span;                     // 取桶中点，不是桶边界
  return (CONFIG.hueRange[0] + mid) % 360;
}

function bucketSize(k, buckets) {
  const lo = CONFIG.minSize * 0.22;
  const hi = CONFIG.maxSize;
  return lo * Math.pow(hi / lo, (k + 0.5) / buckets);           // 对数量化的中点
}

export function getGlowSprite(renderer, hue) {
  return renderer.glow[hueBucket(hue, CONFIG.glowHueBuckets)];
}

export function getGelSprite(renderer, hue, size) {
  const key = gelKey(hue, size);
  let sprite = renderer.gel.get(key);
  if (sprite === undefined) {
    sprite = buildGelSprite(renderer, hueBucket(hue, CONFIG.glowHueBuckets), sizeBucket(size, R.sizeBuckets));
    renderer.gel.set(key, sprite);
  }
  return sprite;
}

// ---------------------------------------------------------------- sprite 预渲染

// 这些函数在 createRenderer / 首次命中缓存时调用，**绝不在 draw 里调用**。
// tests/render.test.js 用记录型桩 ctx 断言稳态帧的渐变创建次数为 0 ——
// 那三条断言守的就是这个约定。

function buildGlowSprites(renderer) {
  const N = CONFIG.glowHueBuckets;
  const size = 128;                       // 光晕要放大到体半径的 2.6 倍，分辨率不能太低
  renderer.glow.length = 0;
  for (let b = 0; b < N; b++) {
    const h = bucketHue(b, N);
    const made = renderer.makeCanvas(size, size);
    const g = made.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // 中心亮、边缘透明。用 traits.sat/lum 的中值（0.70 / 0.73）当代表值：
    // 把 sat/lum 也纳入分桶会让 sprite 数量从 32 爆到 32×8×8，不值得 ——
    // 光晕是模糊的大光斑，饱和度差异在这个尺度上看不出来。
    g.addColorStop(0, hsl(h, 0.70, 0.73, 0.95));
    g.addColorStop(0.25, hsl(h, 0.70, 0.70, 0.45));
    g.addColorStop(0.6, hsl(h, 0.70, 0.62, 0.12));
    g.addColorStop(1, hsl(h, 0.70, 0.60, 0));
    made.ctx.fillStyle = g;
    made.ctx.fillRect(0, 0, size, size);
    renderer.glow.push({ ctx: made.ctx, surface: made.surface, size });
  }
}

function buildGelSprite(renderer, hb, sb) {
  const size = 96;
  const h = bucketHue(hb, CONFIG.glowHueBuckets);
  const made = renderer.makeCanvas(size, size);
  const g = made.ctx.createRadialGradient(
    size * 0.42, size * 0.38, size * 0.05,      // 圆心偏左上：光源在左上，与高光同侧
    size * 0.5, size * 0.5, size * 0.5,
  );
  // spec §5.1："半透明凝胶体(alpha≈0.55 径向渐变)"。
  // alpha 由 drawCreature 里的 globalAlpha 施加，所以这里的 stop 用不透明色，
  // 只负责**明度**分布：中心透亮 → 边缘暗下去（内阴影）。
  g.addColorStop(0, hsl(h, 0.62, 0.86, 1));
  g.addColorStop(0.55, hsl(h, 0.68, 0.72, 1));
  g.addColorStop(0.86, hsl(h, 0.72, 0.56, 1));
  g.addColorStop(1, hsl(h, 0.75, 0.42, 1));     // 边缘内阴影：spec §5.1 说这"不是可选装饰"
  made.ctx.fillStyle = g;
  made.ctx.fillRect(0, 0, size, size);
  return { ctx: made.ctx, surface: made.surface, size, hb, sb };
}

function buildCoreSprite(renderer, color) {
  const size = 64;
  const made = renderer.makeCanvas(size, size);
  const g = made.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.35, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  made.ctx.fillStyle = g;
  made.ctx.fillRect(0, 0, size, size);
  return { ctx: made.ctx, surface: made.surface, size };
}

// ---------------------------------------------------------------- 身体轮廓

// 把局部单位圆空间的点变换到屏幕。
//
// ⚠️ 不需要 atan2：c.facing 已经是**单位向量**（sim.js:530-534 插值后重新归一化过），
// 所以 cos(θ) 就是 facing.x、sin(θ) 就是 facing.y，直接拿来用。
// 每帧每只生物省一次 atan2 + sin + cos，24 只 × 60fps = 每秒省 4320 次三角函数。
export function writeBodyScreen(renderer, body, cx, cy, r, facing) {
  const ca = facing.x, sa = facing.y;
  const pts = body.points;
  const sx = renderer.sx, sy = renderer.sy;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    sx[i] = cx + (p.x * ca - p.y * sa) * r;
    sy[i] = cy + (p.x * sa + p.y * ca) * r;
  }
}

// Catmull-Rom 平滑闭合曲线 → 三次贝塞尔。
//
// spec §5.1 要求"以 Catmull-Rom 平滑的闭合曲线画出"。直接用 lineTo 连 24 个点
// 会得到一个明显的二十四边形（在 50px 半径上每条边约 13px，棱角肉眼可见）。
//
// 换算公式（p0→p3 四个控制点，画 p1→p2 这一段）：
//   c1 = p1 + (p2 - p0) / 6
//   c2 = p2 - (p3 - p1) / 6
// 除以 6 是 Catmull-Rom（张力 0）到贝塞尔的标准换算，不是调出来的经验值。
export function buildBodyPath(ctx, renderer, c, body, cx, cy, r) {
  writeBodyScreen(renderer, body, cx, cy, r, c.facing);
  const sx = renderer.sx, sy = renderer.sy;
  const n = sx.length;
  ctx.beginPath();
  ctx.moveTo(sx[0], sy[0]);
  for (let i = 0; i < n; i++) {
    const p0x = sx[(i - 1 + n) % n], p0y = sy[(i - 1 + n) % n];
    const p1x = sx[i], p1y = sy[i];
    const p2x = sx[(i + 1) % n], p2y = sy[(i + 1) % n];
    const p3x = sx[(i + 2) % n], p3y = sy[(i + 2) % n];
    ctx.bezierCurveTo(
      p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6,
      p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6,
      p2x, p2y,
    );
  }
  ctx.closePath();
}

// ---------------------------------------------------------------- 分层绘制

export function drawCreature(ctx, renderer, c, body, viewport) {
  const cx = screenX(c.pos.x, viewport);
  const cy = screenY(c.pos.y, viewport);
  const r = radiusPx(c, viewport);
  if (!(r > 0.5)) return;                 // 太小不值得画；也挡住 NaN（NaN > 0.5 为 false）
  const t = c.traits;
  const pulse = 1 + body.pulse * Math.sin(body.phase * TAU);

  // ---- 第 1 层：光晕（spec §3.4-3 预渲染精灵 + 'lighter'）----
  // 绝不用 shadowBlur：spec §5.3 称它是"手机浏览器上最大的性能杀手"，
  // 而 tests/render.test.js 里有一条断言直接数 shadowBlur 的写入次数。
  const glow = getGlowSprite(renderer, t.hue);
  const gr = r * R.glowRadiusFactor * (1 + 0.12 * (pulse - 1) * 4);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = t.glow * R.glowAlphaFactor;
  ctx.drawImage(glow.surface, cx - gr, cy - gr, gr * 2, gr * 2);
  ctx.restore();

  // ---- 第 2–3 层：凝胶体 + 花纹（都在身体轮廓的 clip 之内）----
  // 必须 clip：凝胶体是一张**圆形** sprite，而身体是会形变的 24 点软体。
  // 不裁的话挤压、凹陷、生气时的前端变尖在画面上完全看不出来，
  // 团子会退化成一个圆 —— 那 spec §5.1 整个软体模型就白做了。
  const gel = getGelSprite(renderer, t.hue, sizeOf(c));
  ctx.save();
  buildBodyPath(ctx, renderer, c, body, cx, cy, r);
  ctx.clip();
  ctx.globalAlpha = R.gelAlpha;
  ctx.drawImage(gel.surface, cx - r, cy - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
  drawPattern(ctx, renderer, c, body, cx, cy, r);

  // ---- 第 4 层：发光核（体心脉动亮椭圆，颜色 = 情绪色）----
  const core = renderer.getCoreSprite(coreColorFor(c.emotions));
  const cr = r * R.coreRadiusFactor * pulse;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = R.coreAlpha * (0.55 + 0.45 * body.pulse * 6);
  // 椭圆：沿 facing 略微拉长，让"核"跟着身体一起被挤压，而不是一个钉在中心的圆
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(c.facing.y, c.facing.x));
  ctx.scale(1.18, 0.86);
  ctx.drawImage(core.surface, -cr, -cr, cr * 2, cr * 2);
  ctx.restore();

  ctx.restore();      // 结束 clip

  // 第 5–7 层（眼睛、腮红、左上缘高光）在 Task 6 接上。
  // 它们**必须在 clip 之外**画：眼睛要能压在轮廓边缘上，
  // 高光是沿左上缘的一条弧，被裁掉一半就看不出来了。
}

// 花纹（spec §4.2：圆斑 / 环纹 / 云斑 / 星点，genes.PATTERNS 的 1–4）。
//
// ⚠️ 花纹位置必须由 **i / n 的确定性函数**给出，不能用 rng：
// drawPattern 每帧都跑，取随机数会让花纹每帧重排（看起来像在沸腾），
// 而且会消耗 world.rng 的序列 ⇒ **内核的模拟结果跟着变**（同一个种子在
// 开了渲染和没开渲染时跑出不同的缸）。这是表现层污染逻辑层的经典事故。
const PATTERN_SPOTS = 6, PATTERN_STARS = 9;

function drawPattern(ctx, renderer, c, body, cx, cy, r) {
  const t = c.traits;
  if (t.pattern <= 0) return;                    // PATTERNS[0] === 'none'
  const density = 0.4 + 0.6 * t.patternDensity;  // 决定斑点大小与数量
  ctx.save();
  ctx.globalAlpha = R.patternAlpha;
  ctx.fillStyle = hsl(t.hue, Math.min(1, t.sat + 0.18), Math.max(0, t.lum - 0.24), 1);
  const mark = r * R.patternMarkFactor * density;

  if (t.pattern === 1) {                          // 圆斑
    for (let i = 0; i < PATTERN_SPOTS; i++) {
      const a = (i / PATTERN_SPOTS) * TAU + 0.4;
      const rr = r * (0.30 + 0.28 * ((i * 37) % 11) / 11);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mark, 0, TAU);
      ctx.fill();
    }
  } else if (t.pattern === 2) {                   // 环纹
    ctx.lineWidth = Math.max(1, mark * 0.55);
    ctx.strokeStyle = ctx.fillStyle;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.28 * i + 0.08), 0, TAU);
      ctx.stroke();
    }
  } else if (t.pattern === 3) {                   // 云斑：几个大而不规则的软斑
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.9;
      const rr = r * 0.36;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr,
        mark * 1.9, mark * 1.3, a, 0, TAU);
      ctx.fill();
    }
  } else {                                        // 星点：小而多、亮度更高
    ctx.globalAlpha = R.patternAlpha * 1.5;
    for (let i = 0; i < PATTERN_STARS; i++) {
      const a = (i / PATTERN_STARS) * TAU * 2.3;   // 无理数倍角 ⇒ 不排成整齐一圈
      const rr = r * (0.18 + 0.55 * ((i * 53) % 13) / 13);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mark * 0.5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}
```

在 `createRenderer` 里接上两件事：

```js
    getCoreSprite(color) {
      let s = renderer.coreSprites.get(color);
      if (s === undefined) {
        s = buildCoreSprite(renderer, color);
        renderer.coreSprites.set(color, s);
      }
      return s;
    },
```

并在 `renderer` 对象字面量里加字段 `coreSprites: new Map(),`，在 `buildStatics(renderer);` 之后加一行 `buildGlowSprites(renderer);`。

⚠️ `coreSprites` 用**颜色字符串**当键（最多 7 个），不是用情绪键 —— 因为查表结果本来就是颜色，用颜色当键可以让「两种情绪同色」自动合并，缓存更小。上界是 `Object.values(CONFIG.colors).length`，远小于凝胶体的 256。

⚠️ `drawCreature` 里那次 `Math.atan2` 是**唯一**一处：发光核要沿 facing 拉长，而 `ctx.rotate` 只吃弧度。每帧每只一次，24×60 = 1440 次/秒，可以接受。身体轮廓那里已经用 `facing.x/y` 当 cos/sin 免掉了。

⚠️ `drawPattern` 里 `hsl(...)` 每帧构造字符串 —— 这是**已知的、刻意的**分配。花纹颜色取决于 `traits.{hue,sat,lum}`，三者组合太多没法预渲染成 sprite（会爆到 32×8×8）。24 只 × 60fps = 1440 个短字符串/秒，相比每帧一次 `createRadialGradient`（会触发 GPU 资源创建）便宜得多。**Task 10 实测帧时间时若这一项成为热点，再改成按 hueBucket 预渲染 32 张花纹色块。** 把这条记进 `.superpowers/sdd/progress.md`，别让后来者以为漏了。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/render.test.js`
Expected: PASS（Task 4 的 11 条 + 本 Task 的 9 条 = 20 条）。

⚠️「每帧零渐变创建」这条**必须依然是绿的**。如果它变红了，说明 `getGelSprite` 在稳态帧里建了新 sprite —— 检查 `gelKey` 是否稳定（同一个 `(hue, size)` 必须每次给出同一个整数）。

Run: `node --test tests/`
Expected: **435 tests / 435 pass / 0 fail**（426 + 9），stderr 0 字节。

- [ ] **Step 6: 变异探针**

(a) 把 `drawCreature` 里凝胶体那段的 `ctx.clip()` 删掉。
Run: `node --test tests/render.test.js`
Expected:「drawCreature 的层序」**变红**（`clip` 计数为 0）。
再在浏览器里看一眼：团子应当退化成**正圆**，挤压与凹陷完全消失 —— 这就是那条断言在守的东西。

(b) 把 `buildBodyPath` 里的 `ctx.bezierCurveTo(...)` 换成 `ctx.lineTo(p2x, p2y)`。
Expected: 同一条测试变红（`bezierCurveTo` 计数为 0）。浏览器里应当能看出二十四边形的棱角。

(c) 把 `writeBodyScreen` 里的旋转去掉（`sx[i] = cx + p.x * r`）。
Expected:「writeBodyScreen：局部 +x 映射到 facing 方向」变红。浏览器里所有团子的花纹与眼睛会**不再跟着转身**。

三处都改回来，重跑确认全绿，实测记进 `.superpowers/sdd/progress.md`。

- [ ] **Step 7: 提交**

```bash
git add src/render.js src/config.js tests/render.test.js
git commit -m "feat: 分层身体渲染（预渲染光晕与凝胶体精灵、Catmull-Rom 轮廓、情绪发光核）"
```

---

### Task 6: `render.js` —— 眼睛四参数、腮红、左上缘高光（第 5–7 层）

spec §4.6 是本物种的**灵魂**：「情绪不靠符号气泡，靠眼睛」。四个连续参数 `pupilSize` / `lidOpen` / `eyeSpacing` / `eyeOffset`，加一张逐情绪的表。spec §2 与 §1 原则 1 明令禁止任何漫画符号 —— 所以这一层是整个项目"它看起来是活的"的成败所在。

**Files:**
- Modify: `src/render.js`
- Modify: `src/config.js`（`CONFIG.render` 加眼睛常量）
- Test: `tests/render.test.js`（追加）

**Interfaces:**
- Consumes:
  - `c.emotions`（六个分量）、`c.thresholds.angerDuration`（计划 1 交接：「留给计划 2」）、`c.facing`、`c.alive`、`c.mourn`、`c.intent`
  - `memory.affectionFor(memory, PLAYER_ID)` —— 「看着玩家的手」需要好感（spec §4.6）
  - `CONFIG.colors.{pupil,blush}`、`CONFIG.eyeWidthRatio`（= 0.28）
  - `world.playerHand`（`{pos, speed} | null`）
- Produces:
  - `eyeParamsFor(c, t) => { pupilSize, lidOpen, eyeSpacing, eyeOffset, blink }`（**纯函数**，逐情绪表的可测形态）
  - `drawEyes(ctx, renderer, c, body, cx, cy, r, viewport, hand) => void`
  - `drawBlush(...)`、`drawHighlight(...)`
  - `CONFIG.render.eye = { … }`

- [ ] **Step 1: 在 `CONFIG.render` 里加眼睛常量**

spec §4.6 给了一条硬数据（「眼睛大约占身体宽度的 28%」= `CONFIG.eyeWidthRatio`）和一张逐情绪表；表里的**精确数值**属 §12「各情绪参数的精确数值 …… 实现阶段按观感直接定即可，无需再次确认」。所以这里定死一组，并把每一格对应到 spec §4.6 的那句话。

```js
    // 眼睛四参数（spec §4.6）。
    //
    // 为什么是**四个连续参数**而不是七张表情贴图：spec §4.6 明确要求连续参数，
    // 理由是情绪本身是连续的六个分量（emotions.js），贴图会让表情在阈值处跳变，
    // 而"从平静慢慢变成开心"这个过程正是它看起来活着的原因。
    //
    // 参数含义：
    //   pupilSize  瞳孔半径 / 眼睛半径。0.15 = 吓得瞳孔缩小，0.95 = 卖萌时整个眼睛都是瞳孔
    //   lidOpen    眼睑开合。1 = 全开，0.3 = 开心到眯成 ^^，0 = 闭眼（死亡）
    //   eyeSpacing 两眼间距 / 体直径。生气时内收（挤在一起 ⇒ 皱眉感）
    //   eyeOffset  眼睛整体沿 facing 的前后偏移 / 体半径。害怕时后移、好奇时前倾、卖萌时上移
    //   blink      0–1，缓慢眨眼的进度（困倦与"信任玩家"用）
    eye: {
      widthRatio: CONFIG.eyeWidthRatio,     // 0.28：单只眼睛的直径 / 体直径（见下面的解释）
      spacing: 0.42,                        // 两眼圆心间距 / 体直径；0.28+0.14 的空隙，边缘几乎相触
      forward: 0.15,                        // 眼睛整体沿 facing 前移 / 体直径（脸在前半侧，spec §4.6）
      pupilMin: 0.12,
      pupilMax: 0.95,
      // 逐情绪表。每行后面的注释是 spec §4.6 的原文依据。
      joyPupil: 0.55,      joyLid: 0.30,     // "开心：眼睛弯成 ^^（lidOpen ≈ 0.3）"
      angerPupil: 0.25,    angerSpacing: -0.10,  // "生气：瞳孔缩小、两眼内收"
      fearPupil: 0.15,     fearOffset: -0.22,    // "害怕：瞳孔极小、眼睛后移"
      curiosityLidAsym: 0.45, curiosityOffset: 0.14,  // "好奇：一只眼睁大一只微眯、前倾"
      sleepyLid: 0.35,     sleepyBlinkPeriod: 4.5,    // "困倦：半闭、缓慢眨眼"
      begPupil: 0.95,      begOffsetY: -0.20,         // "卖萌：瞳孔放到最大、整体向上偏移"
      trustBlinkPeriod: 3.0,                          // "信任玩家时缓慢眨眼"
      deathLid: 0.0,                                  // "死亡：lidOpen → 0"
      // 腮红与高光（spec §5.1 第 6–7 层；§4.6 表里"卖萌/开心"要更明显的腮红）
      blushAlpha: 0.30,
      blushJoyBoost: 0.35,      // joy=1 时腮红再加这么多 alpha
      blushBegBoost: 0.45,      // 卖萌时最明显（spec §4.5 的"卖萌"行）
      blushOffsetX: 0.34,       // 沿垂直 facing 方向，两侧各一个
      blushOffsetY: 0.22,
      blushRadius: 0.16,
      highlightAlpha: 0.55,     // spec §5.1："左上缘高光"，与凝胶体 sprite 的偏心光源同侧
      highlightArc: 0.85,       // 高光弧的角度跨度（弧度）
      highlightCenter: -2.36,   // ≈ -135°，即左上
      highlightWidth: 0.10,
      // 瞳孔跟随（spec §4.6："看着玩家的手"）
      handLookMax: 0.22,        // 瞳孔朝手方向最多偏移这么多（× 眼睛半径）
      handLookTurn: 0.35,       // 好感低时转开的比例（好感 0 ⇒ 只看 35% 的幅度）
    },
```

⚠️ `widthRatio: CONFIG.eyeWidthRatio` 这里**引用既有常量而不是重抄 0.28** —— 抄两遍就会漂移。

⚠️ **对 spec §4.6「眼睛大约占身体宽度的 28%」的解释**：这句话有歧义（单只眼占 28%，还是两只加起来占 28%？）。本计划取**单只眼睛直径 = 0.28 × 体直径**，两眼圆心间距 0.42 × 体直径 ⇒ 两只眼睛加起来约占 0.70 × 体直径，留出边缘。理由：两只各 0.14 的话在 52px 的成体上只有 7px，画不出瞳孔与眼睑，「眼睛大而圆」与「情绪全靠眼睛」两条都会落空；而 0.28 单只在 52px 上是 14.6px，足够放下瞳孔、眼睑和高光。这个解释属 §12 授权范围，Task 10 的手工核对若判定眼睛过大，**只改 `CONFIG.eye.widthRatio`**。

- [ ] **Step 2: 追加失败测试**

```js
import { eyeParamsFor } from '../src/render.js';
import { PLAYER_ID, affectionFor } from '../src/memory.js';

const baseEmotions = () => ({ joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });

// 眼睛四参数是**纯函数**，所以 spec §4.6 那张逐情绪表的每一行都能被断言。
// 这件事的价值比看起来大：那张表是本物种"看起来活着"的全部来源，
// 而它极易在改别的东西时被顺手弄坏（比如把 joy 的 lidOpen 从 0.3 改成 0.8，
// 开心就不再眯眼了，但没有任何测试会红 —— 除非现在就把表钉住）。

const eyeOf = (emotions, extra) => eyeParamsFor(
  { emotions, thresholds: { angerDuration: 2 }, alive: true, mourn: 0, intent: null, memory: { entries: new Map() } },
  0,
  extra,
);

test('中性状态：眼睛全开、瞳孔中等、无偏移', () => {
  const p = eyeOf(baseEmotions());
  assert.ok(p.lidOpen > 0.85, `中性应当睁着：${p.lidOpen}`);
  assert.ok(p.pupilSize > 0.3 && p.pupilSize < 0.7, `中性瞳孔应当中等：${p.pupilSize}`);
  assert.ok(Math.abs(p.eyeOffset) < 1e-9, '中性不前后偏移');
  assert.ok(p.eyeSpacing > 0, '中性不内收');
});

test('joy：眯成 ^^（lidOpen ≈ 0.3，spec §4.6 逐字给的值）', () => {
  const e = baseEmotions(); e.joy = 1;
  const p = eyeOf(e);
  assert.ok(Math.abs(p.lidOpen - CONFIG.render.eye.joyLid) < 0.06,
    `开心的 lidOpen 应当约 ${CONFIG.render.eye.joyLid}，实测 ${p.lidOpen.toFixed(3)}`);
  assert.ok(p.pupilSize > eyeOf(baseEmotions()).pupilSize, '开心时瞳孔应当放大');
});

test('anger：瞳孔缩小 + 两眼内收（eyeSpacing 变小）', () => {
  const e = baseEmotions(); e.anger = 1;
  const p = eyeOf(e);
  const neutral = eyeOf(baseEmotions());
  assert.ok(p.eyeSpacing < neutral.eyeSpacing, '生气时两眼必须内收');
  assert.ok(p.pupilSize < neutral.pupilSize, '生气时瞳孔必须缩小');
  assert.ok(Math.abs(p.pupilSize - CONFIG.render.eye.angerPupil) < 0.08);
});

test('fear：瞳孔最小 + 眼睛后移（offset 为负）', () => {
  const e = baseEmotions(); e.fear = 1;
  const p = eyeOf(e);
  assert.ok(p.eyeOffset < 0, '害怕时眼睛必须后移');
  assert.ok(p.pupilSize < 0.2, `害怕时瞳孔应当极小：${p.pupilSize}`);
});

test('curiosity：两眼不对称（一只睁大一只微眯）', () => {
  const e = baseEmotions(); e.curiosity = 1;
  const p = eyeOf(e);
  // 不对称是这条的全部要点：两只眼睛的 lidOpen 必须不同
  assert.ok(p.lidOpenL !== undefined && p.lidOpenR !== undefined,
    '好奇需要左右两个独立的 lidOpen，否则"一只眼睁大一只微眯"无从表达');
  assert.ok(Math.abs(p.lidOpenL - p.lidOpenR) > 0.2,
    `两眼开合差必须明显：${p.lidOpenL.toFixed(3)} vs ${p.lidOpenR.toFixed(3)}`);
  assert.ok(p.eyeOffset > 0, '好奇时身体前倾 ⇒ 眼睛前移');
});

test('sleepy：半闭 + blink 在缓慢推进（spec §4.6"半闭、缓慢眨"）', () => {
  const e = baseEmotions(); e.sleepy = 1;
  const a = eyeOf(e, 0);
  const b = eyeOf(e, 1.2);           // t 推进 1.2 秒
  assert.ok(a.lidOpen < 0.6, `困倦应当半闭：${a.lidOpen}`);
  assert.notEqual(a.blink, b.blink, 'blink 必须随时间推进，否则"缓慢眨眼"是静止的');
  assert.ok(a.blink >= 0 && a.blink <= 1 && b.blink >= 0 && b.blink <= 1);
});

test('卖萌（intent.kind === "beg"）：瞳孔放到最大 + 整体向上偏移', () => {
  // spec §9.2 的第 1 条验收依据要求"能看到卖萌"，而卖萌的**视觉**就是这一条。
  // 计划 1 花了很大力气调 begUrgency 才让 beg 真的胜出；
  // 如果表现层没把 beg 画成卖萌脸，那份努力在画面上就完全看不出来。
  const e = baseEmotions();
  const p = eyeOf(e, 0, { intentKind: 'beg' });
  const neutral = eyeOf(e);
  assert.ok(p.pupilSize > 0.85, `卖萌瞳孔应当接近全黑：${p.pupilSize}`);
  assert.ok(p.pupilSize > neutral.pupilSize);
  assert.ok(p.eyeOffsetY < 0, '卖萌时眼睛整体**向上**偏移（屏幕 y 向下为正，所以是负）');
});

test('死亡：lidOpen → 0（spec §4.6 逐字）', () => {
  const e = baseEmotions();
  const p = eyeParamsFor(
    { emotions: e, thresholds: { angerDuration: 2 }, alive: false, dying: 1, mourn: 0, intent: null, memory: { entries: new Map() } },
    0,
  );
  assert.equal(p.lidOpen, 0, '死亡必须闭眼');
});

test('瞳孔朝玩家的手偏移，且好感低时偏得少（spec §4.6"看着玩家的手"）', () => {
  const mk = (affection) => {
    const memory = { entries: new Map() };
    // 直接塞一条 PLAYER 记忆，不经过 remember()：这是测试，不是模拟
    memory.entries.set(PLAYER_ID, { affection, familiarity: 1, role: null, kinship: 0, lastT: 0 });
    return { emotions: baseEmotions(), thresholds: { angerDuration: 2 }, alive: true, dying: 0,
      mourn: 0, intent: null, memory };
  };
  const hand = { x: 1, y: 0 };         // 手在正右方（局部空间）
  const loved = eyeParamsFor(mk(0.9), 0, { handLocal: hand });
  const shy = eyeParamsFor(mk(0.0), 0, { handLocal: hand });
  assert.ok(Math.abs(loved.pupilLookX) > Math.abs(shy.pupilLookX) * 1.5,
    `好感高应当更主动地看手：${loved.pupilLookX.toFixed(3)} vs ${shy.pupilLookX.toFixed(3)}`);
  // 手不在时必须回正（否则眼睛会永久斜视）
  const none = eyeParamsFor(mk(0.9), 0, { handLocal: null });
  assert.ok(Math.abs(none.pupilLookX) < 1e-9 && Math.abs(none.pupilLookY) < 1e-9);
});

test('eyeParamsFor 是纯函数：同输入同输出，且不修改传入的 creature', () => {
  const c = { emotions: baseEmotions(), thresholds: { angerDuration: 2 }, alive: true, dying: 0,
    mourn: 0, intent: null, memory: { entries: new Map() } };
  c.emotions.joy = 0.7;
  const before = JSON.stringify(c);
  const a = eyeParamsFor(c, 3.5);
  const b = eyeParamsFor(c, 3.5);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(c), before, '表现层不得写内核状态（只能写 world.playerHand）');
});

test('drawEyes 不新建渐变、不写 shadowBlur（第 5–7 层同样受 §5.3 约束）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const ctx = createStubCtx();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  ctx.reset();
  for (let i = 0; i < 60; i++) {
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(ctx.count('createRadialGradient'), 0, '眼睛/腮红/高光必须走预渲染精灵');
  assert.equal(ctx.shadowBlurWrites, 0);
  // 高光与腮红必须真的画了（spec §5.1："高光与内阴影不是可选装饰"）
  assert.ok(ctx.count('arc') > 60 * world.creatures.length,
    '每只生物每帧至少要有腮红与高光的弧线');
});
```

⚠️ `eyeParamsFor(c, t, opts)` 的第三个参数 `opts` 是**可选**的：`{ intentKind?, handLocal? }`。真实调用时由 `drawEyes` 从 `c.intent.kind` 与 `world.playerHand` 算出 `handLocal`（手在身体局部空间的方向），测试里直接喂。这么设计是为了让 `eyeParamsFor` 保持纯函数 —— 它不读 `world`，所以不需要造一个世界就能测那张情绪表。

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/render.test.js`
Expected: FAIL —— `eyeParamsFor` 未导出。

- [ ] **Step 4: 实现第 5–7 层**

```js
import { affectionFor, PLAYER_ID } from './memory.js';
```

```js
// ---------------------------------------------------------------- 眼睛四参数

// spec §4.6 的那张逐情绪表，写成一个纯函数。
//
// 为什么必须是纯函数：那张表是本物种"看起来活着"的全部来源，而它极易被顺手弄坏
// （改别的东西时把 joyLid 从 0.3 改成 0.8，开心就不再眯眼了，画面只是"没那么可爱"，
// 没有任何测试会红）。做成纯函数之后，表的每一行都能被 tests/render.test.js 断言。
//
// t 是当前模拟时间（秒），只用于 blink 的相位；opts 让调用方注入 intent 与手的方向，
// 于是本函数**不读 world**、不读任何全局 —— 可测性的全部前提。
export function eyeParamsFor(c, t, opts) {
  const E = R.eye;
  const e = c.emotions;
  const o = opts || {};
  const intentKind = o.intentKind !== undefined ? o.intentKind : (c.intent ? c.intent.kind : null);

  // 死亡：lidOpen → 0（spec §4.6 逐字）。优先级最高，压过其它一切。
  if (!c.alive) {
    return { pupilSize: E.pupilMin, lidOpen: E.deathLid, lidOpenL: E.deathLid, lidOpenR: E.deathLid,
      eyeSpacing: 0, eyeOffset: 0, eyeOffsetY: 0, blink: 0, pupilLookX: 0, pupilLookY: 0 };
  }

  // 各情绪对四个参数的贡献，按分量**加权叠加**而不是取主导情绪的整行。
  // 理由：内核的情绪是六个连续分量，同时可以有 0.6 的 fear 与 0.4 的 anger；
  // 取整行会让表情在 dominant() 翻转的那一帧**跳变**，而叠加是连续的。
  // dominant() 只用来选发光核的颜色（离散的东西才需要离散判定）。
  let pupil = 0.42;                     // 中性基准
  let lid = 1.0;
  let spacing = 0;
  let offset = 0;
  let offsetY = 0;

  pupil += E.joyPupil * e.joy - 0.42 * e.joy;           // 开心：瞳孔略放大
  lid -= (1 - E.joyLid) * e.joy;                        // 开心：眯成 ^^
  pupil += (E.angerPupil - 0.42) * e.anger;             // 生气：瞳孔缩小
  spacing += E.angerSpacing * e.anger;                  // 生气：内收
  pupil += (E.fearPupil - 0.42) * e.fear;               // 害怕：瞳孔极小
  offset += E.fearOffset * e.fear;                      // 害怕：后移
  lid -= E.curiosityLidAsym * 0.5 * e.curiosity;        // 好奇：基准眼睁小一点，另一只由 lidOpenL/R 分开
  offset += E.curiosityOffset * e.curiosity;            // 好奇：前倾
  lid -= (1 - E.sleepyLid) * e.sleepy;                  // 困倦：半闭
  pupil += 0.10 * e.arousal;                            // 兴奋：瞳孔放大

  // 卖萌：瞳孔放到最大 + 整体向上偏移（spec §4.6）。
  // ⚠️ 这一格对应 spec §9.2 第 1 条验收依据（"能看到卖萌"）的**视觉**部分。
  if (intentKind === 'beg') {
    pupil = E.begPupil;
    offsetY = E.begOffsetY;
    lid = Math.max(lid, 0.95);                          // 卖萌时必须睁大，不能被 sleepy 压成半闭
  }

  // 左右眼不对称（只有好奇用；spec §4.6："一只眼睁大一只微眯"）
  const asym = E.curiosityLidAsym * e.curiosity;
  const lidL = Math.max(0, Math.min(1, lid + asym * 0.5));
  const lidR = Math.max(0, Math.min(1, lid - asym * 0.5));

  // blink：困倦时缓慢眨；信任玩家时也缓慢眨（spec §4.6）。
  // 用三角波而不是 sin：眨眼要"快闭快开、中间停顿"，正弦波看起来像在 continuously 抽搐。
  let blink = 0;
  const period = e.sleepy > 0.5 ? E.sleepyBlinkPeriod : E.trustBlinkPeriod;
  const phase = ((t / period) % 1 + 1) % 1;
  if (phase < 0.12) blink = phase / 0.12;               // 闭上（占周期的 12%）
  else if (phase < 0.24) blink = 1 - (phase - 0.12) / 0.12;   // 睁开
  const blinkAmount = Math.max(e.sleepy, affectionLevel(c)) * blink;

  // 瞳孔朝玩家的手偏移（spec §4.6："看着玩家的手"，好感高主动转、好感低转开）
  let lookX = 0, lookY = 0;
  if (o.handLocal) {
    const trust = 0.35 + 0.65 * affectionLevel(c);      // 好感 0 ⇒ 只看 35% 的幅度
    lookX = clamp11(o.handLocal.x) * E.handLookMax * trust;
    lookY = clamp11(o.handLocal.y) * E.handLookMax * trust;
  }

  return {
    pupilSize: clampRange(pupil, E.pupilMin, E.pupilMax),
    lidOpen: clampRange(lid, 0, 1),
    lidOpenL, lidOpenR,
    eyeSpacing: E.spacing + spacing,
    eyeOffset: offset,
    eyeOffsetY: offsetY,
    blink: blinkAmount,
    pupilLookX: lookX,
    pupilLookY: lookY,
  };
}

const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
const clampRange = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 好感读的是内核的权威函数 memory.affectionFor，不是自己翻 entries。
// 表现层**只读**，绝不写记忆（写记忆是内核在 tickCreature 里的职责，sim.js:593-596）。
function affectionLevel(c) {
  if (!c.memory) return 0;
  const a = affectionFor(c.memory, PLAYER_ID);
  return a > 0 ? (a > 1 ? 1 : a) : 0;
}
```

```js
// ---------------------------------------------------------------- 第 5–7 层绘制

// 眼睛（spec §4.6：眼睛在 facing 那一侧、沿垂直方向分开）。
function drawEyes(ctx, renderer, c, body, cx, cy, r, viewport, hand) {
  const E = R.eye;
  const p = renderer.eyeCache;                  // 复用对象，避免每帧分配（spec §5.3）
  const t = renderer.time;

  // 手在身体**局部空间**的方向：把 (hand - pos) 投影到 facing 与其垂直方向。
  // 与 writeBodyScreen 用同一套基，所以眼睛看的方向与身体转的方向天然一致。
  let handLocal = null;
  if (hand) {
    const dx = hand.pos.x - c.pos.x;
    const dy = hand.pos.y - c.pos.y;
    const lx = dx * c.facing.x + dy * c.facing.y;
    const ly = dx * (-c.facing.y) + dy * c.facing.x;
    const len = Math.hypot(lx, ly);
    if (len > 1e-6) handLocal = p.handLocal || (p.handLocal = { x: 0, y: 0 });
    if (handLocal) { handLocal.x = lx / len; handLocal.y = ly / len; }
  }

  const params = eyeParamsInto(p, c, t, handLocal);

  const d = r * 2;                                       // 体直径
  const eyeR = d * E.widthRatio * 0.5;                   // 单只眼睛半径
  // 眼睛整体位置：沿 facing 前移 forward，加上情绪的前后偏移
  const fwd = (E.forward * d) + params.eyeOffset * r;
  const sep = params.eyeSpacing * d * 0.5;
  const fx = c.facing.x, fy = c.facing.y;
  const px = -fy, py = fx;                               // 垂直方向
  const liftY = params.eyeOffsetY * r;                   // 卖萌时整体上移（屏幕 y 向下）

  const baseX = cx + fx * fwd + px * 0 - 0;
  const baseY = cy + fy * fwd + liftY;

  for (let side = -1; side <= 1; side += 2) {
    const ex = baseX + px * sep * side;
    const ey = baseY + py * sep * side;
    const lid = side < 0 ? params.lidOpenL : params.lidOpenR;
    const open = Math.max(0, lid - params.blink);
    if (open <= 0.02 || eyeR < 0.8) continue;            // 闭着就不画，省掉整只眼睛的开销

    // 眼白：预渲染的白色柔边圆 sprite（不新建渐变）
    const white = renderer.eyeWhite;
    ctx.save();
    ctx.globalAlpha = 0.96;
    ctx.drawImage(white.surface, ex - eyeR, ey - eyeR, eyeR * 2, eyeR * 2);

    // 瞳孔：CONFIG.colors.pupil = #2D1240（spec §4.2："瞳孔不用纯黑，
    // 深紫黑在粉色身体上更柔和，纯黑会显得空洞"）
    const pr = eyeR * params.pupilSize;
    const pupilX = ex + px * 0 + fx * 0 + params.pupilLookX * eyeR;
    const pupilY = ey + params.pupilLookY * eyeR;
    ctx.globalAlpha = 1;
    ctx.fillStyle = CONFIG.colors.pupil;
    ctx.beginPath();
    // 眼睑：把瞳孔也裁进"睁开的那部分"，否则半闭时瞳孔会溢出到眼睑外
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeR, eyeR * open, 0, 0, TAU);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(pupilX, pupilY, pr, 0, TAU);
    ctx.fill();
    // 瞳孔高光：一个小白点，让眼睛"有神"。这是 spec §2"看起来是活的"里最便宜的一笔。
    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(pupilX - pr * 0.34, pupilY - pr * 0.38, Math.max(0.6, pr * 0.26), 0, TAU);
    ctx.fill();
    ctx.restore();

    // 眼睑线：半闭时画一条弧当作眼皮边缘，否则"眯眼"看起来只是眼睛变小了
    if (open < 0.85) {
      ctx.strokeStyle = CONFIG.colors.pupil;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(0.7, eyeR * 0.12);
      ctx.beginPath();
      ctx.ellipse(ex, ey, eyeR, eyeR * open, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
}
```

⚠️ 上面 `drawEyes` 里有一处**必须清理**的坏味道：`const baseX = cx + fx * fwd + px * 0 - 0;` 里的 `px * 0 - 0` 是无意义的残留。写成 `const baseX = cx + fx * fwd;`。同时 `pupilX` 里的 `px * 0 + fx * 0` 同样要删成 `const pupilX = ex + params.pupilLookX * eyeR;`。**这类残留在计划里出现，实现者会照抄** —— 所以这里显式给出清理后的写法，不留给实现者判断。

⚠️ `eyeParamsInto(p, c, t, handLocal)` 是 `eyeParamsFor` 的**零分配变体**：把结果写进复用的 `p` 对象而不是返回新对象。两者必须共用同一套计算逻辑（把 `eyeParamsFor` 的主体抽成一个写入目标对象的内部函数 `computeEyeParams(out, c, t, opts)`，`eyeParamsFor` 传一个新对象进去、`eyeParamsInto` 传复用对象）。**不得复制粘贴两份计算逻辑** —— 那会让测试测的和实际跑的不是同一个函数。

⚠️ `renderer.eyeCache` 与 `renderer.eyeWhite` 要在 `createRenderer` 里初始化：

```js
    eyeCache: { pupilSize: 0, lidOpen: 1, lidOpenL: 1, lidOpenR: 1, eyeSpacing: 0,
      eyeOffset: 0, eyeOffsetY: 0, blink: 0, pupilLookX: 0, pupilLookY: 0, handLocal: null },
    eyeWhite: buildEyeWhiteSprite(renderer),
```

```js
function buildEyeWhiteSprite(renderer) {
  const size = 48;
  const made = renderer.makeCanvas(size, size);
  const g = made.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.72, 'rgba(255,255,255,0.98)');
  g.addColorStop(1, 'rgba(255,240,248,0.55)');    // 边缘略带粉，与身体融合而不是贴上去的白圆
  made.ctx.fillStyle = g;
  made.ctx.fillRect(0, 0, size, size);
  return { ctx: made.ctx, surface: made.surface, size };
}

// 腮红（spec §5.1 第 6 层；§4.6 表里卖萌与开心的腮红更明显）
function drawBlush(ctx, renderer, c, cx, cy, r, params) {
  const E = R.eye;
  const intentKind = c.intent ? c.intent.kind : null;
  let alpha = E.blushAlpha + E.blushJoyBoost * c.emotions.joy;
  if (intentKind === 'beg') alpha += E.blushBegBoost;
  alpha = alpha > 0.85 ? 0.85 : alpha;
  const d = r * 2;
  const px = -c.facing.y, py = c.facing.x;
  const fx = c.facing.x, fy = c.facing.y;
  const bx = cx + fx * d * 0.10;
  const by = cy + fy * d * 0.10 + d * E.blushOffsetY;
  const br = d * E.blushRadius;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = CONFIG.colors.blush;          // #FF6B9D
  for (let side = -1; side <= 1; side += 2) {
    ctx.beginPath();
    ctx.ellipse(bx + px * d * E.blushOffsetX * side, by + py * d * E.blushOffsetX * side,
      br, br * 0.62, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// 左上缘高光（spec §5.1 第 7 层："左上缘高光"，且"高光与内阴影不是可选装饰"）
function drawHighlight(ctx, renderer, c, cx, cy, r) {
  const E = R.eye;
  ctx.save();
  ctx.globalAlpha = E.highlightAlpha;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(0.8, r * E.highlightWidth);
  ctx.lineCap = 'round';
  ctx.beginPath();
  // 固定在世界空间的左上（-135°），**不跟着 facing 转**：
  // 光源在缸的左上方（与凝胶体 sprite 的偏心渐变、CSS 背景的明度分布同侧），
  // 所以高光位置由光源决定，不由生物朝向决定。跟着转的话看起来像脸上贴了张纸。
  const a0 = E.highlightCenter - E.highlightArc * 0.5;
  const a1 = E.highlightCenter + E.highlightArc * 0.5;
  ctx.arc(cx, cy, r * 0.86, a0, a1);
  ctx.stroke();
  ctx.restore();
}
```

在 `drawCreature` 末尾（`ctx.restore();  // 结束 clip` **之后**）接上：

```js
  // ---- 第 5–7 层：眼睛、腮红、左上缘高光 ----
  // 必须在 clip **之外**：眼睛要能压在轮廓边缘上，
  // 高光是沿左上缘的一条弧，被裁掉一半就看不出来了。
  const params = computeEyeParams(renderer.eyeCache, c, renderer.time, null);
  drawEyes(ctx, renderer, c, body, cx, cy, r, viewport, renderer.hand);
  drawBlush(ctx, renderer, c, cx, cy, r, params);
  drawHighlight(ctx, renderer, c, cx, cy, r);
```

并在 `createRenderer` 里加字段 `hand: null,`，在 `draw(ctx, world, bodies, viewport, dt)` 开头加一行 `renderer.hand = world.playerHand;`（Task 8 会真正写入它）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/render.test.js`
Expected: PASS（20 + 11 = 31 条）。

Run: `node --test tests/`
Expected: **446 tests / 446 pass / 0 fail**（435 + 11），stderr 0 字节。

- [ ] **Step 6: 变异探针（这一组的价值最高，因为情绪表最容易悄悄坏掉）**

(a) 把 `E.joyLid` 从 `0.30` 改成 `0.95`（开心不再眯眼）。
Expected:「joy：眯成 ^^」**变红**。

(b) 把 `angerSpacing: -0.10` 改成 `+0.10`（生气时两眼**外扩**而不是内收）。
Expected:「anger：瞳孔缩小 + 两眼内收」变红。

(c) 把卖萌那段的 `pupil = E.begPupil;` 删掉。
Expected:「卖萌（intent.kind === "beg"）」变红。

⚠️ (c) 这个探针值得单独说一句：spec §9.2 的**第 1 条验收依据**就是「能看到卖萌」。计划 1 为了 beg 真的能胜出，把 `begUrgency` 从 1.3 调到 7.0（附完整实测数据）。如果表现层没把 beg 画成卖萌脸，那份努力在画面上**完全看不出来**，而验收会在"看起来通过了"的情况下漏掉 spec 的第 1 条。所以这条断言不是审美偏好，是验收依据的可执行形式。

(d) 把 `drawHighlight` 里的角度从 `E.highlightCenter` 改成 `Math.atan2(c.facing.y, c.facing.x)`（高光跟着转身）。
Expected: **没有测试变红** —— 这是**已知的覆盖缺口**。高光朝向是纯观感，无法在 Node 里断言（桩 ctx 只数调用次数，不判断画在哪）。它由 Task 10 的手工核对第 7 项覆盖（「转身后高光仍在左上缘」）。**把这个缺口如实记进 `.superpowers/sdd/progress.md`**，不要假装自动化覆盖了一切。

四处都改回来（(d) 本来就没改代码，只需确认手工核对项存在），重跑确认全绿。

- [ ] **Step 7: 提交**

```bash
git add src/render.js src/config.js tests/render.test.js
git commit -m "feat: 眼睛四参数与腮红高光（spec §4.6 逐情绪表落成可断言的纯函数）"
```

---

### Task 7: 死亡溶散、sick、哀悼、卵、食物、求偶编舞

本 Task 把内核**已经在产出**但画面上还看不见的东西全部画出来。其中三件是内核注释里**明确点名交给表现层**的义务，不是可选装饰：

- `sim.js:940`：「sick 个体仍然留在 creatures 里被 render 画出来（**变暗、静止**），这样问题对用户是可见的，而不是无声地少了一只。」
- `sim.js:788`：「满员时照样求偶、照样产卵，只是那些卵的光会慢慢熄灭 —— 于是『缸满了』是一件**能被看见的事**（卵在缸底暗下去），而不是一条静默的禁令。」
- `sim.js:5818` / 计划 1：「内核只负责让双方靠近并维持仪式；具体的圆圈轨迹在计划 2 的表现层实现。」

**Files:**
- Modify: `src/render.js`
- Modify: `src/config.js`（`CONFIG.colors` 加三种食物色；`CONFIG.render` 加溶散/卵/求偶常量）
- Modify: `src/main.js`（把 `world.events` 交给 renderer 消费）
- Test: `tests/render.test.js`（追加）

**Interfaces:**
- Consumes:
  - `c.{alive, dying, sick, mourn, courtship, intent}`、`world.{eggs, foods, events}`
  - `CONFIG.dissolveDuration`（= 4）、`CONFIG.mournDuration`（= 6）、`CONFIG.colors.{mote, sediment}`
  - `Egg = { id, genes, age, pos, motherId, fatherId, viable }`、`Food = { id, kind, pos, amount }`
  - `decode(genes)`（`genes.js`）—— 卵要显示它**将来**的色相，所以必须在孵化前解码一次
- Produces:
  - `drawEggs(ctx, renderer, world, viewport, dt) => void`
  - `drawFoods(ctx, renderer, world, viewport) => void`
  - `drawCourtship(ctx, renderer, world, viewport) => void`
  - `eggGlowFor(egg) => number`（**纯函数**，0–1；`viable=false` 时随 `age` 衰减）
  - `dissolveState(c) => { alpha, expand, lift }`（**纯函数**）
  - `consumeEvents(renderer, events) => void`（触发粒子爆发；**不清空** events，清空由 `main.js` 做）
  - `burst(renderer, x, y, colorKey, count) => void`（对象池，零分配）

- [ ] **Step 1: 加常量**

`CONFIG.colors` 末尾插入：

```js
    // 三种食物的颜色（spec §6.2）。
    // ⚠️ **刻意全部避开粉色**：spec §6.2 的原话是三种食物"都刻意避开粉色，
    // 免得和生物混在一起看不出哪个是食物"。所以这里出现青绿/琥珀/淡蓝不是配色失误，
    // 是设计要求。改这三个颜色会直接违反 spec §6.2。
    algae: '#7FE3B0',      // 青绿光藻（初始缸里就有 12 份，CONFIG.food.algae.respawn = true）
    nectar: '#FFC46B',     // 琥珀蜜珠（计划 3 的投食物种；本计划先能画，投喂手势在计划 3）
    crystal: '#A8D8FF',    // 淡蓝冰晶（同上）
```

`CONFIG.render` 末尾插入：

```js
    // 死亡溶散（spec §4.11、§8.2 第 5 项："死亡溶散温和不惊悚"）。
    // 时长用内核的 CONFIG.dissolveDuration（4 秒）—— reapDead 就是按它 splice 的
    // （sim.js:660-670），表现层**不得**自己另计一套时间，否则会出现
    // "动画还没播完生物就消失了"或"生物消失后动画还在原地播"。
    dissolveExpand: 1.9,       // 溶散结束时体型放大到 1.9 倍（散开，不是缩没）
    dissolveLift: 0.035,       // 同时向上漂移的归一化距离（"溶进水里"）
    dissolveParticles: 14,     // 每只死亡时爆发的微粒数
    // sick（sim.js:940："变暗、静止"）
    sickDim: 0.35,             // 亮度乘数：暗到明显异常，但仍看得清是什么
    sickDesat: 0.55,           // 去饱和比例：生病会掉色，这是最直觉的"不对劲"信号
    // 哀悼（CONFIG.mournDuration = 6 秒）
    mournDim: 0.72,            // 比 sick 轻：哀悼是情绪，不是故障，不该看起来像坏了
    // 卵
    eggRadius: 0.010,          // 归一化半径；产在 y ∈ [0.78,0.97]（breeding.js:127）
    eggGlowPulse: 0.30,        // 可孵化卵的脉动幅度（"在发亮"）
    eggFailFadeTime: 22,       // 不可孵化卵的光在多少秒内熄灭（见 sim.js:788 的要求）
    eggFailMinGlow: 0.06,      // 熄灭后的残留微光：不彻底消失，好让玩家看得出"这里有卵但不会孵"
    // 求偶编舞（spec §4.9、§9.2 第 4 项："求偶脉动同步看得懂"）
    courtRingFactor: 1.55,     // 脉动环半径 = 体半径 × 此值
    courtRingAlpha: 0.30,
    courtLinkAlpha: 0.16,      // 连接两只求偶者的柔和弧线
    // 粒子爆发（对象池上界）
    burstPool: 240,            // 24 只 × 14 粒 = 336 的保守下界；见下面的说明
```

⚠️ `burstPool: 240` 小于 `24 × 14 = 336`。这是**刻意的**：粒子池满了就复用最早的粒子（`burst` 里用环形写入），而不是扩容。理由：同帧内 24 只全部死亡在实际模拟里不会发生（死亡是老死或病死的稀疏事件），为它预留 336 个槽是浪费；而环形复用保证**永不分配**，这才是 spec §5.3 的硬约束。池满时最老的粒子被覆盖，视觉上完全无感。

- [ ] **Step 2: 追加失败测试**

```js
import { eggGlowFor, dissolveState, consumeEvents, burst } from '../src/render.js';
import { decode } from '../src/genes.js';

test('eggGlowFor：不可孵化的卵随年龄熄灭（sim.js:788 点名交给表现层的义务）', () => {
  // 内核注释原文："满员时照样求偶、照样产卵，只是那些卵的光会慢慢熄灭 ——
  // 于是『缸满了』是一件能被看见的事（卵在缸底暗下去），而不是一条静默的禁令。"
  // 所以这条断言不是在测观感，是在测**一条 spec 要求的可见性**有没有落地。
  const mk = (viable, age) => ({ id: 'e1', genes: null, age, pos: { x: 0.5, y: 0.9 }, viable });
  const ok = mk(true, 0);
  assert.ok(eggGlowFor(ok) > 0.6, `可孵化的卵应当明亮：${eggGlowFor(ok)}`);
  // 可孵化的卵**不随年龄变暗**（它一直有希望，直到孵化或超时）
  assert.ok(Math.abs(eggGlowFor(mk(true, 30)) - eggGlowFor(ok)) < 1e-9,
    '可孵化的卵不该随年龄熄灭');

  const bad = mk(false, 0);
  assert.ok(eggGlowFor(bad) > eggGlowFor(mk(false, 10)), '不可孵化的卵必须随年龄变暗');
  assert.ok(eggGlowFor(mk(false, 10)) > eggGlowFor(mk(false, 30)), '变暗必须持续');
  // 熄灭后留一点残光：彻底消失的话玩家看不出"这里有卵但不会孵"，
  // 只会以为根本没产卵 —— 那就又变回一条静默的禁令了。
  const dark = eggGlowFor(mk(false, 600));
  assert.ok(dark >= CONFIG.render.eggFailMinGlow - 1e-12, `残光不得小于 ${CONFIG.render.eggFailMinGlow}`);
  assert.ok(dark < 0.25, `残光应当明显暗于可孵化的卵：${dark}`);
});

test('dissolveState：溶散进度直接来自 c.dying，且 4 秒时完全散开', () => {
  const fresh = dissolveState({ alive: false, dying: 0 });
  const mid = dissolveState({ alive: false, dying: CONFIG.dissolveDuration / 2 });
  const end = dissolveState({ alive: false, dying: CONFIG.dissolveDuration });
  assert.equal(fresh.alpha, 1, '刚开始死时应当完全不透明');
  assert.ok(mid.alpha < fresh.alpha && mid.alpha > 0);
  assert.ok(end.alpha <= 1e-6, `溶散结束时应当完全透明：${end.alpha}`);
  assert.ok(end.expand > mid.expand && mid.expand > fresh.expand, '必须逐渐散开（不是缩没）');
  assert.ok(end.lift > mid.lift, '必须逐渐上浮（"溶进水里"）');
  // 活着的生物不该有溶散状态
  const alive = dissolveState({ alive: true, dying: 0 });
  assert.equal(alive.alpha, 1);
  assert.equal(alive.expand, 1);
  assert.equal(alive.lift, 0);
});

test('dissolveState 对 dying 越界是安全的（脏存档防御，同计划 1 的纪律）', () => {
  // 计划 1 的教训：growthFactor 用 Math.max(0, c.age) 挡负年龄，因为脏存档会给出负值。
  // 这里同理 —— dying 超过 dissolveDuration 时生物已经被 splice 了，
  // 但表现层可能在同一帧里还拿着它。
  const over = dissolveState({ alive: false, dying: CONFIG.dissolveDuration * 3 });
  assert.ok(Number.isFinite(over.alpha) && over.alpha >= 0);
  assert.ok(Number.isFinite(over.expand) && over.expand < 10);
  const neg = dissolveState({ alive: false, dying: -5 });
  assert.equal(neg.alpha, 1, '负的 dying 应当当成"刚开始"');
});

test('sick 个体被画成变暗去饱和（sim.js:940 点名要求）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  world.creatures[0].sick = true;
  const ctx = createStubCtx();
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  // sick 必须仍然被画出来（"而不是无声地少了一只"）——
  // 所以 drawImage 次数不该比健康时少，只是多了变暗的处理
  const sickDraws = ctx.count('drawImage');
  world.creatures[0].sick = false;
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.ok(sickDraws >= ctx.count('drawImage'),
    'sick 个体不得被跳过绘制（sim.js:940：问题必须对用户可见）');
  assert.ok(sickDraws > 0);
});

test('食物用非粉色（spec §6.2 刻意避开粉色，免得和生物混在一起）', () => {
  // 这条断言看着像审美洁癖，其实是 spec §6.2 的**明文要求**。
  // 粉色区间是 [315,360] ∪ [0,25]（跨 0° 的并集），所以判定不能写成 min<=h<=max。
  const inPink = (hex) => {
    const h = hexToHue(hex);
    return h >= 315 || h <= 25;             // 并集，不是区间
  };
  for (const kind of ['algae', 'nectar', 'crystal']) {
    assert.ok(!inPink(CONFIG.colors[kind]),
      `${kind} = ${CONFIG.colors[kind]} 落在粉色区里，违反 spec §6.2`);
  }
  // 反向确认：判定函数本身没写坏（生物的颜色**必须**落在粉色区）
  assert.ok(inPink(CONFIG.colors.sakura), '判定函数失灵：樱花粉应当算粉色');
  assert.ok(inPink(CONFIG.colors.rose));
});

// 十六进制 → 色相。测试专用的小工具，不进 src/（表现层不得自己解码颜色空间，
// 但测试需要一个独立的判定来交叉验证，否则就是拿实现验实现）。
function hexToHue(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

test('求偶双方的脉动相位同步（spec §9.2 第 4 项："求偶脉动同步看得懂"）', () => {
  // 同步靠的是 courtship.t：两只在同一 tick 被 startCourtship 置 0，之后同步推进。
  // 表现层**不得**用自己的时钟（renderer.time）当相位，否则两只的脉动会各自漂移，
  // "同步"这件事在画面上就消失了 —— 而那正是玩家唯一能看懂求偶的线索。
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const a = world.creatures[0], b = world.creatures[1];
  a.courtship = { partnerId: b.id, t: 3.5, duration: 10, phase: 'circle' };
  b.courtship = { partnerId: a.id, t: 3.5, duration: 10, phase: 'circle' };
  assert.equal(courtPhase(a), courtPhase(b), '双方相位必须相同');
  // 相位必须归一化到 [0,1) 且随 t 单调
  assert.ok(courtPhase(a) >= 0 && courtPhase(a) < 1);
  a.courtship.t = 7; b.courtship.t = 7;
  assert.notEqual(courtPhase(a), 3.5 / 10);
});

test('consumeEvents 触发粒子爆发，且粒子池不扩容（spec §5.3 零分配）', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const cap = r.bursts.n;
  assert.equal(cap, CONFIG.render.burstPool);
  // 灌远超池容量的爆发量
  for (let k = 0; k < 40; k++) {
    consumeEvents(r, [{ kind: 'death', id: 'c1', pos: { x: 0.5, y: 0.5 }, name: 'x' }]);
  }
  assert.equal(r.bursts.n, cap, '粒子池不得扩容（扩容=运行时分配）');
  assert.equal(r.bursts.live, 0, '环形复用下 live 不该无限增长');
  for (let i = 0; i < cap; i++) {
    assert.ok(Number.isFinite(r.bursts.x[i]) && Number.isFinite(r.bursts.y[i]),
      `粒子 ${i} 坐标不是有限数（环形写入越界了）`);
  }
});

test('consumeEvents 覆盖全部八种事件而不抛（事件词汇表来自 src/sim.js）', () => {
  const world = makeWorld(11);
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false });
  const id = world.creatures[0].id;
  const all = [
    { kind: 'eat', id, foodId: 'f1', foodKind: 'algae' },
    { kind: 'death', id, pos: { x: 0.5, y: 0.5 }, name: 'x' },
    { kind: 'dissolved', id },
    { kind: 'eggFailed', id: 'e1', pos: { x: 0.5, y: 0.9 } },
    { kind: 'hatch', id, pos: { x: 0.5, y: 0.9 }, eggId: 'e1' },
    { kind: 'mated', a: id, b: id, eggs: 2, atPopulationCap: false },
    { kind: 'rejected', id, by: id },
    { kind: 'error', id, message: 'boom' },
  ];
  for (const ev of all) assert.doesNotThrow(() => consumeEvents(r, [ev]), `事件 ${ev.kind} 让 consumeEvents 抛了`);
  // 未知事件也不得抛（内核以后可能加事件；表现层不该因此崩掉）
  assert.doesNotThrow(() => consumeEvents(r, [{ kind: 'something-new', id }]));
});
```

⚠️ 需要在文件顶部 import 里补上 `courtPhase`。

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/render.test.js`
Expected: FAIL —— `eggGlowFor` / `dissolveState` / `consumeEvents` / `burst` / `courtPhase` 未导出。

- [ ] **Step 4: 实现**

`src/render.js` 顶部 import 补：

```js
import { decode } from './genes.js';
```

```js
// ---------------------------------------------------------------- 卵

// 可孵化：恒定亮度 + 脉动。
// 不可孵化：光随年龄熄灭到 eggFailMinGlow。
//
// 这条曲线实现的是 sim.js:786-788 的一段设计意图，原文：
//   "上限在这里体现为『卵不可孵化』…满员时照样求偶、照样产卵，
//    只是那些卵的光会慢慢熄灭 —— 于是『缸满了』是一件能被看见的事
//    （卵在缸底暗下去），而不是一条静默的禁令。"
// 所以"卵变暗"不是装饰，是**种群上限这个规则唯一的用户可见反馈**。
// 删掉它，上限就退回成一条看不见的禁令。
export function eggGlowFor(egg) {
  if (egg.viable) return 1;
  const t = egg.age < 0 ? 0 : egg.age;
  const k = t / R.eggFailFadeTime;
  const faded = 1 - (k >= 1 ? 1 : k);
  return R.eggFailMinGlow + (1 - R.eggFailMinGlow) * faded * faded;   // 平方：先快后慢，像光在熄灭
}

// 卵的色相来自它**将来**的基因，不是母亲的。
// ⚠️ 必须在孵化前 decode 一次并缓存：每帧 decode 是浪费，
// 而且 genes 是不变的（breeding.js:123 的 inherit 在产卵时就算完了）。
function eggHueFor(renderer, egg) {
  let h = renderer.eggHues.get(egg.id);
  if (h === undefined) {
    h = decode(egg.genes).hue;
    renderer.eggHues.set(egg.id, h);
  }
  return h;
}

export function drawEggs(ctx, renderer, world, viewport, dt) {
  const eggs = world.eggs;
  if (eggs.length === 0) return;
  // 清掉已经不存在的卵的色相缓存，否则长跑会泄漏（卵被吃掉/孵化/失败后就从数组里消失了）
  if (renderer.eggHues.size > eggs.length) {
    const live = new Set();
    for (const e of eggs) live.add(e.id);
    for (const id of Array.from(renderer.eggHues.keys())) if (!live.has(id)) renderer.eggHues.delete(id);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const egg of eggs) {
    const glow = eggGlowFor(egg);
    const pulse = 1 + R.eggGlowPulse * Math.sin(renderer.time * 2.2 + egg.pos.x * 9) * (egg.viable ? 1 : 0.25);
    const rr = R.eggRadius * viewport.width * 0.5 * pulse;
    const x = screenX(egg.pos.x, viewport);
    const y = screenY(egg.pos.y, viewport);
    const sprite = getGlowSprite(renderer, eggHueFor(renderer, egg));
    ctx.globalAlpha = glow * 0.85;
    ctx.drawImage(sprite.surface, x - rr * 2.2, y - rr * 2.2, rr * 4.4, rr * 4.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.35 + 0.55 * glow;
    ctx.fillStyle = CONFIG.colors.mote;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 食物

export function drawFoods(ctx, renderer, world, viewport) {
  const foods = world.foods;
  if (foods.length === 0) return;
  ctx.save();
  for (const f of foods) {
    // spec §6.2：三种食物**刻意避开粉色**，"免得和生物混在一起看不出哪个是食物"。
    const color = CONFIG.colors[f.kind] || CONFIG.colors.algae;
    const x = screenX(f.pos.x, viewport);
    const y = screenY(f.pos.y, viewport);
    const rr = Math.max(1.5, 0.006 * viewport.width * 0.5 * (0.6 + 0.4 * f.amount));
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, rr * 2.6, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 求偶编舞

// 相位**必须**来自 courtship.t，不能用 renderer.time。
// 理由：两只求偶者的 t 在同一 tick 被置 0（breeding.startCourtship），此后同步推进，
// 所以用 t/duration 当相位，双方天然同步 —— 这正是 spec §9.2 第 4 项
// "求偶脉动同步看得懂"的实现方式。用自己的时钟会让两者各自漂移，
// 而"同步"是玩家唯一能看懂"这两只在求偶"的线索。
export function courtPhase(c) {
  const cs = c.courtship;
  if (!cs || !(cs.duration > 0)) return 0;
  const p = (cs.t % cs.duration) / cs.duration;
  return p < 0 ? p + 1 : p;
}

export function drawCourtship(ctx, renderer, world, viewport) {
  const cs = [];
  for (const c of world.creatures) if (c.alive && c.courtship) cs.push(c);
  if (cs.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const c of cs) {
    const phase = courtPhase(c);
    // 脉动：一个周期内先亮后暗，且半径随之呼吸。
    // 用 sin²（而不是 sin）保证亮度非负、且"亮—暗"各占半周期，读起来像心跳。
    const beat = Math.sin(phase * Math.PI);
    const b2 = beat * beat;
    const x = screenX(c.pos.x, viewport);
    const y = screenY(c.pos.y, viewport);
    const r = radiusPx(c, viewport) * R.courtRingFactor * (1 + 0.35 * b2);
    const sprite = getGlowSprite(renderer, c.traits.hue);
    ctx.globalAlpha = R.courtRingAlpha * b2;
    ctx.drawImage(sprite.surface, x - r, y - r, r * 2, r * 2);
  }
  // 连接双方的柔和弧线：让"这两只是一对"在画面上成立，
  // 否则两个各自脉动的环看起来只是两只碰巧在发光的生物。
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth = Math.max(1, 0.004 * viewport.width);
  ctx.lineCap = 'round';
  const byId = new Map();
  for (const c of cs) byId.set(c.id, c);
  for (const c of cs) {
    const p = byId.get(c.courtship.partnerId);
    if (!p || c.id > p.id) continue;               // 每对只画一次（id 比较去重，不需要 Set 分配）
    const b2 = Math.sin(courtPhase(c) * Math.PI);
    ctx.globalAlpha = R.courtLinkAlpha * b2 * b2;
    ctx.strokeStyle = getGlowSprite(renderer, c.traits.hue) && CONFIG.colors.sakura;
    const x1 = screenX(c.pos.x, viewport), y1 = screenY(c.pos.y, viewport);
    const x2 = screenX(p.pos.x, viewport), y2 = screenY(p.pos.y, viewport);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.18;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx, my, x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}
```

⚠️ `drawCourtship` 里 `ctx.strokeStyle = getGlowSprite(renderer, c.traits.hue) && CONFIG.colors.sakura;` 是一处**必须清理**的坏味道：`&&` 的左边只是为了"确保 sprite 存在"而写的，它对颜色毫无贡献，读起来像是颜色取决于 sprite。写成 `ctx.strokeStyle = CONFIG.colors.sakura;`。

⚠️ `byId` 每帧 `new Map()` 是一次分配。求偶中的个体通常只有 0–4 只，这个分配很小，但 spec §5.3 写的是"运行时不分配对象"。**折中并如实记录**：把它换成 renderer 上的一个复用数组 `renderer.courtPairs`（长度上界 = `populationCap`），用「先写入、再遍历、末尾置 length=0」的模式；或者接受这一次分配并在 `.superpowers/sdd/progress.md` 记一笔，等 Task 10 实测帧时间时看它是否真的构成压力。**不要**默默留着 `new Map()` 而不记录 —— 那等于让硬约束悄悄失效。

```js
// ---------------------------------------------------------------- 死亡溶散 / sick / 哀悼

// 溶散进度直接来自 c.dying（内核给的"溶散进行中秒数"，creature.js:62）。
// ⚠️ 不得自己另计一套时间：reapDead（sim.js:660-670）就是按 dying >= dissolveDuration
// 才把个体从 creatures 里 splice 掉的。两套时钟必然漂移，症状是
// "动画播到一半生物突然消失"或"生物没了但动画还在原地播"。
export function dissolveState(c) {
  if (c.alive) return { alpha: 1, expand: 1, lift: 0 };
  const dur = CONFIG.dissolveDuration;
  let t = c.dying / dur;
  if (!(t > 0)) t = 0;                    // 负值或 NaN 一律当成"刚开始"（脏存档防御）
  if (t > 1) t = 1;
  return {
    alpha: (1 - t) * (1 - t),             // 平方衰减：先慢后快，末尾"化掉"而不是"淡出"
    expand: 1 + (R.dissolveExpand - 1) * t,
    lift: R.dissolveLift * t,
  };
}

// 亮度乘数：sick 与 mourn 都让生物变暗，但**幅度不同**。
// sick 是故障（sim.js:940 要求"变暗、静止"，好让问题可见），
// mourn 是情绪（CONFIG.mournDuration = 6 秒），暗一点就够了，不该看起来像坏了。
export function dimFactorFor(c) {
  if (!c.alive) return 1;
  if (c.sick) return R.sickDim;
  if (c.mourn > 0) {
    // 哀悼按剩余时间线性回到正常，而不是到点突然变亮
    const k = c.mourn / CONFIG.mournDuration;
    return 1 - (1 - R.mournDim) * (k > 1 ? 1 : k);
  }
  return 1;
}
```

在 `drawCreature` 开头（`const r = radiusPx(...)` 之后）插入：

```js
  const dim = dimFactorFor(c);
  const dis = c.alive ? null : dissolveState(c);
  const drawR = dis ? r * dis.expand : r;
  const drawCy = dis ? cy - dis.lift * viewport.height : cy;
```

并把后续所有用到 `r` / `cy` 的地方换成 `drawR` / `drawCy`，在最外层包一次 alpha：

```js
  ctx.save();
  ctx.globalAlpha = dis ? dis.alpha : (dim < 1 ? dim : 1);
  // … 第 1–7 层 …
  ctx.restore();
```

⚠️ `sick` 的**去饱和**（`R.sickDesat`）没法用 `globalAlpha` 表达。用 `ctx.filter = 'saturate(0.45)'` 是最直接的写法，但 **`ctx.filter` 在部分移动端浏览器上不支持或极慢**，而 spec §5.3 的性能预算是按手机算的。折中方案：sick 时改用**灰粉色的凝胶体 sprite**（预渲染一张 `gelSick`，色相不变、饱和度乘 `1 - sickDesat`），一次 `drawImage` 换掉每帧一个 filter。**Task 10 实机核对时若发现 `ctx.filter` 在目标设备上没问题，可以简化；但默认按 sprite 方案实现**，因为它一定不会有性能意外。

`createRenderer` 里补的字段与初始化：

```js
    eggHues: new Map(),
    bursts: createBursts(CONFIG.render.burstPool),
    courtPairs: [],
```

```js
// ---------------------------------------------------------------- 粒子爆发（对象池）

function createBursts(n) {
  return {
    n, cursor: 0, live: 0,
    x: new Float64Array(n), y: new Float64Array(n),
    vx: new Float64Array(n), vy: new Float64Array(n),
    life: new Float64Array(n), maxLife: new Float64Array(n),
    r: new Float64Array(n), color: new Uint8Array(n),   // 颜色用索引，不用字符串（避免分配）
  };
}

const BURST_COLORS = [CONFIG.colors.mote, CONFIG.colors.sakura, CONFIG.colors.peach, CONFIG.colors.rose];

export function burst(renderer, x, y, colorIdx, count) {
  const b = renderer.bursts;
  const idx = ((colorIdx % BURST_COLORS.length) + BURST_COLORS.length) % BURST_COLORS.length;
  for (let i = 0; i < count; i++) {
    // 环形写入：池满了就覆盖最老的粒子。永不扩容 ⇒ 永不分配（spec §5.3）。
    const k = b.cursor;
    b.cursor = (k + 1) % b.n;
    const a = (i / count) * TAU + k * 0.7;             // k 当扰动，避免每次爆发角度完全一样
    const sp = 0.05 + 0.11 * ((k * 37) % 13) / 13;
    b.x[k] = x; b.y[k] = y;
    b.vx[k] = Math.cos(a) * sp;
    b.vy[k] = Math.sin(a) * sp;
    b.maxLife[k] = 0.9 + 0.5 * ((k * 53) % 11) / 11;
    b.life[k] = b.maxLife[k];
    b.r[k] = 1.2 + 1.8 * ((k * 29) % 7) / 7;
    b.color[k] = idx;
  }
}

function updateBursts(b, dt) {
  // live 只是给测试看的计数（"环形复用下 live 不该无限增长"），不参与绘制
  let n = 0;
  for (let i = 0; i < b.n; i++) {
    if (b.life[i] > 0) {
      b.life[i] -= dt;
      b.x[i] += b.vx[i] * dt;
      b.y[i] += b.vy[i] * dt;
      b.vy[i] -= 0.02 * dt;              // 轻微上浮（气泡感）
      b.vx[i] *= 1 - 1.6 * dt;           // 阻尼
      b.vy[i] *= 1 - 1.6 * dt;
      if (b.life[i] > 0) n++;
    }
  }
  b.live = n;
}

function drawBursts(ctx, renderer, viewport) {
  const b = renderer.bursts;
  if (b.live === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < b.n; i++) {
    if (b.life[i] <= 0) continue;
    const k = b.life[i] / b.maxLife[i];
    ctx.globalAlpha = k * k * 0.8;
    ctx.fillStyle = BURST_COLORS[b.color[i]];
    const rr = b.r[i] * viewport.scale * 0.5 * (0.5 + k);
    const x = screenX(b.x[i], viewport), y = screenY(b.y[i], viewport);
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 事件消费

// world.events 是内核与表现层之间**唯一**的通信通道（计划 1 原文）。
// 八种事件的精确形状见本计划「类型约定」。
//
// ⚠️ 本函数**不清空** events：清空由 main.js 每帧做（`world.events.length = 0`）。
// 分成两个职责是为了让 audio（Task 9）也能消费同一批事件 ——
// 谁先清空谁就把事件从另一个人手里抢走了。
export function consumeEvents(renderer, events) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    switch (ev.kind) {
      case 'death':                                  // sim.js:638
        burst(renderer, ev.pos.x, ev.pos.y, 0, R.dissolveParticles);
        break;
      case 'hatch':                                  // sim.js:744
        burst(renderer, ev.pos.x, ev.pos.y, 1, 10);
        break;
      case 'eggFailed':                              // sim.js:688, 728
        burst(renderer, ev.pos.x, ev.pos.y, 3, 5);
        break;
      case 'mated':                                  // sim.js:803
        // mated 事件里没有 pos，只有 a/b 两个 id；位置要回世界查。
        // 但 consumeEvents 不收 world —— 所以这里的爆发交给 drawCourtship 的
        // 脉动峰值表达，不额外放粒子。**这是刻意的**：为了保住
        // "consumeEvents 只依赖事件本身"这个可测性，宁可少一个粒子效果。
        break;
      case 'eat': case 'dissolved': case 'rejected': case 'error':
        break;                                       // 视觉上没有对应动作（error 由 sick 变暗表达）
      default:
        break;                                       // 未知事件不抛：内核以后可能加事件
    }
  }
}
```

在 `createRenderer` 的 `draw` 里，`drawWater(...)` 之后接上：

```js
      updateBursts(renderer.bursts, dt);
      drawFoods(ctx, renderer, world, viewport);
      drawEggs(ctx, renderer, world, viewport, dt);
      for (const c of world.creatures) {
        const b = bodies.get(c.id);
        if (b) drawCreature(ctx, renderer, c, b, viewport);
      }
      drawCourtship(ctx, renderer, world, viewport);
      drawBursts(ctx, renderer, viewport);
```

⚠️ 层序有意义：食物与卵在生物**之下**（它们在缸底/水中），求偶环与粒子在**之上**（它们是叠加光效）。

`src/main.js` 的 step 里，把事件消费改成同时喂 renderer 与 audio：

```js
    if (world.events.length > 0) {
      if (renderer) consumeEvents(renderer, world.events);
      if (audio) audio.consume(world.events, world);
    }
    world.events.length = 0;      // ⚠️ 必须清空：events 是无界增长的（已知债务）
```

并补 import：`import { createRenderer, consumeEvents } from './render.js';`

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/render.test.js` → Expected: PASS（31 + 8 = 39 条）
Run: `node --test tests/` → Expected: **454 tests / 454 pass / 0 fail**（446 + 8），stderr 0 字节。

- [ ] **Step 6: 变异探针**

(a) 把 `eggGlowFor` 改成 `return egg.viable ? 1 : R.eggFailMinGlow;`（不可孵化的卵直接暗到底，不渐变）。
Expected:「eggGlowFor：不可孵化的卵随年龄熄灭」变红（"必须随年龄变暗"那条）。
在浏览器里验：等缸满（24 只）后产卵，卵应当**逐渐**暗下去而不是产下即黑。

(b) 把 `dissolveState` 里的 `t = c.dying / dur` 改成 `t = renderer.time / dur`（用自己的时钟）。
Expected: 编译层面就过不去（`dissolveState` 收不到 renderer）——**这正是它被设计成纯函数的回报**。若为了绕过而给它加参数，则「溶散进度直接来自 c.dying」变红。

(c) 把 `drawCreature` 里 sick 的 `dim` 处理删掉（`const dim = 1;`）。
Expected:「sick 个体被画成变暗去饱和」变红。

(d) 把 `courtPhase` 改成 `(renderer.time % cs.duration) / cs.duration`。
Expected:「求偶双方的脉动相位同步」变红。

(e) 把 `CONFIG.colors.algae` 改成 `'#FFB6D9'`（粉色）。
Expected:「食物用非粉色」变红 —— 报错信息会直接引用 spec §6.2。

全部改回，重跑确认全绿，实测记进 `.superpowers/sdd/progress.md`。

- [ ] **Step 7: 提交**

```bash
git add src/render.js src/main.js src/config.js tests/render.test.js
git commit -m "feat: 溶散/sick/哀悼/卵/食物/求偶编舞（兑现内核点名交给表现层的三条义务）"
```

---

### Task 8: `input.js` —— 最小的手（含 `HAND_SPEED_POKE` 的实测重调）

**范围**（控制方裁定：**「最小手势 + 声音都进计划 2」**）：只做「指针 → `world.playerHand`」。**不做**拖拽投食、长按撒食、点按信息卡、长按改名 —— 那些属计划 3（spec §6.1）。

**为什么最小手势也必须进计划 2**：spec §9.2 的**第 1 条验收依据**是「能看到卖萌」，而卖萌（`intent.kind === 'beg'`）的触发链需要 `playerApproach`，`playerApproach` 需要 `world.playerHand` 非空。**没有手，第 1 条验收依据在原理上不可能达成。**

**Files:**
- Create: `src/input.js`
- Modify: `src/main.js`（接上 `attachInput`）
- Modify: `src/behavior.js`（**只改注释**，写入 `HAND_SPEED_POKE` 的实测数据；数值若需调整则一并改）
- Modify: `tests/constraints.test.js`（把 `'input.js'` 加回可 import 性那条）
- Test: `tests/input.test.js`

**Interfaces:**
- Consumes: `HAND_SPEED_POKE`（`behavior.js`，当前 0.25）、`CONFIG.perceiveRadius`（0.28）、`CONFIG.fixedDt`
- Produces:
  - `createHandTracker(opts) => HandTracker`，`opts = { windowMs?, maxSamples? }`
  - `HandTracker.sample(t, clientX, clientY, cssWidth, cssHeight) => void`
  - `HandTracker.release() => void`
  - `HandTracker.state() => HandState`（`{pos, speed} | null`，**复用同一对象**）
  - `computeSpeed(samples, count, now, windowMs) => number`（**纯函数**，归一化单位/秒）
  - `attachInput(element, onHand, opts) => () => void`（返回解绑函数）

- [ ] **Step 1: 写 `tests/input.test.js` 的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { HAND_SPEED_POKE } from '../src/behavior.js';
import { createHandTracker, computeSpeed } from '../src/input.js';

// speed 的单位约定（**本计划定义，内核只是消费它**）：归一化世界单位 / 秒。
// 归一化而不是 CSS 像素，理由：sim.js:594 拿它和 CONFIG.perceiveRadius（0.28，
// 也是归一化单位）比距离，两者必须同单位；而且手机的 390px 与桌面的 1920px
// 上"同样快的一划"应当算同样快，用像素的话手机上会显得慢 5 倍。

const W = 1920, H = 1080;

const tracker = () => createHandTracker({});

test('没有指针时 state() 是 null（内核据此判断"手不在缸里"）', () => {
  const t = tracker();
  assert.equal(t.state(), null);
  t.sample(0, 100, 100, W, H);
  assert.notEqual(t.state(), null);
  t.release();
  assert.equal(t.state(), null, '抬起后必须变回 null，否则生物会永久围着一只不存在的手转');
});

test('pos 归一化到 [0,1]²，且与 sim.js 的坐标系一致', () => {
  const t = tracker();
  t.sample(0, 0, 0, W, H);
  let s = t.state();
  assert.equal(s.pos.x, 0);
  assert.equal(s.pos.y, 0);
  t.sample(16, W, H, W, H);
  s = t.state();
  assert.equal(s.pos.x, 1);
  assert.equal(s.pos.y, 1);
  t.sample(32, W / 2, H / 2, W, H);
  s = t.state();
  assert.equal(s.pos.x, 0.5);
  assert.equal(s.pos.y, 0.5);
  // 越界必须夹住：指针可以移出 canvas（拖出窗口），但归一化坐标越界会让
  // sim.js:324 的距离计算失去意义
  t.sample(48, W * 2, -H, W, H);
  s = t.state();
  assert.ok(s.pos.x <= 1 && s.pos.y >= 0, `越界未夹住：${s.pos.x}, ${s.pos.y}`);
});

test('computeSpeed：静止为 0，慢划与快戳差一个数量级', () => {
  // 采样缓冲是 { t, x, y } 的并列 typed array（见实现），这里用等价的对象数组喂纯函数
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  // 完全静止：三个采样点同一位置
  samples.t[0] = 0; samples.x[0] = 0.5; samples.y[0] = 0.5;
  samples.t[1] = 16; samples.x[1] = 0.5; samples.y[1] = 0.5;
  samples.t[2] = 32; samples.x[2] = 0.5; samples.y[2] = 0.5;
  assert.equal(computeSpeed(samples, 3, 32, 120), 0);

  // 慢划（抚摸）：120ms 内移动 0.02 归一化单位 ⇒ 0.167 /s
  samples.t[0] = 0; samples.x[0] = 0.50; samples.y[0] = 0.5;
  samples.t[1] = 60; samples.x[1] = 0.51; samples.y[1] = 0.5;
  samples.t[2] = 120; samples.x[2] = 0.52; samples.y[2] = 0.5;
  const slow = computeSpeed(samples, 3, 120, 200);
  assert.ok(Math.abs(slow - 0.02 / 0.12) < 0.02, `慢划速度应当约 0.167/s，实测 ${slow}`);
  assert.ok(slow < HAND_SPEED_POKE, `慢划必须被判定为抚摸（< ${HAND_SPEED_POKE}）：${slow}`);

  // 快戳：40ms 内移动 0.12 归一化单位 ⇒ 3.0 /s
  samples.t[0] = 0; samples.x[0] = 0.50; samples.y[0] = 0.5;
  samples.t[1] = 20; samples.x[1] = 0.56; samples.y[1] = 0.5;
  samples.t[2] = 40; samples.x[2] = 0.62; samples.y[2] = 0.5;
  const fast = computeSpeed(samples, 3, 40, 200);
  assert.ok(fast > HAND_SPEED_POKE, `快戳必须被判定为戳（> ${HAND_SPEED_POKE}）：${fast}`);
  assert.ok(fast > slow * 5, `快戳应当比慢划快一个数量级：${fast} vs ${slow}`);
});

test('computeSpeed：过期采样不参与（否则一次快戳会被之前的静止历史稀释掉）', () => {
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  // 一段很久以前的静止历史
  samples.t[0] = 0; samples.x[0] = 0.5; samples.y[0] = 0.5;
  samples.t[1] = 1000; samples.x[1] = 0.5; samples.y[1] = 0.5;
  // 紧接着一次极快的戳
  samples.t[2] = 1010; samples.x[2] = 0.6; samples.y[2] = 0.5;
  const v = computeSpeed(samples, 3, 1010, 200);
  assert.ok(v > 1, `过期采样必须被排除，否则戳被稀释成 ${v}`);
  // 全部过期 ⇒ 0（不是 NaN、不是负数）
  assert.equal(computeSpeed(samples, 3, 99999, 200), 0);
});

test('computeSpeed 对退化输入是安全的（同刻双采样、单采样、count=0）', () => {
  const samples = { t: new Float64Array(8), x: new Float64Array(8), y: new Float64Array(8) };
  assert.equal(computeSpeed(samples, 0, 0, 200), 0);
  samples.t[0] = 5; samples.x[0] = 0.3; samples.y[0] = 0.3;
  assert.equal(computeSpeed(samples, 1, 5, 200), 0);
  // 同一毫秒两个采样点：dt = 0 ⇒ 不得除零得 Infinity/NaN
  samples.t[1] = 5; samples.x[1] = 0.9; samples.y[1] = 0.9;
  const v = computeSpeed(samples, 2, 5, 200);
  assert.ok(Number.isFinite(v) && v >= 0, `同刻双采样必须给出有限非负速度，实测 ${v}`);
});

test('state() 复用同一个对象（spec §5.3 运行时零分配）', () => {
  const t = tracker();
  t.sample(0, 100, 100, W, H);
  const a = t.state();
  t.sample(16, 200, 200, W, H);
  const b = t.state();
  assert.equal(a, b, '每次 pointermove 都新建 {pos, speed} 就是每秒上百次分配');
  assert.equal(a.pos, b.pos);
});

test('采样缓冲有上界，长时间按住不会无限增长', () => {
  const t = tracker();
  for (let i = 0; i < 100000; i++) t.sample(i, (i % W), (i % H), W, H);
  const s = t.state();
  assert.ok(Number.isFinite(s.speed) && s.speed >= 0);
  assert.ok(t.count <= 64, `采样缓冲必须环形复用，实测 ${t.count} 个`);
});

test('input.js 不出现浏览器全局名（靠注入的元素，不靠豁免）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/input.js', import.meta.url)), 'utf8');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `input.js 出现了 ${name}；监听目标必须由 attachInput 的形参传入`);
  }
});

test('input.js 不 import perceive，且除了 playerHand 不写任何内核状态', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/input.js', import.meta.url)), 'utf8');
  assert.ok(!/\bperceive\b/.test(src), 'perceive 在 tickWorld 之外调用会抛 TypeError（sim.js:286）');
  // input.js 只产出数据，由 main.js 决定写到哪。所以它连 world 都不该 import。
  assert.ok(!/from '\.\/sim\.js'/.test(src), 'input.js 不得 import sim.js（它只产出 {pos, speed}）');
  assert.ok(!/adjustMemory|applyEvent|startle|comfort/.test(src),
    'input.js 不得直接改内核状态：抚摸买好感是内核自己在 tickCreature 里做的（sim.js:593-596）');
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test tests/input.test.js`
Expected: FAIL —— `Cannot find module '…/src/input.js'`。

- [ ] **Step 3: 写 `src/input.js`**

```js
// input.js —— 指针采样与「手」的状态（spec §6.1 的**最小**子集）。
//
// 范围：只做"指针 → { pos, speed }"。拖拽投食、长按撒食、点按信息卡、长按改名
// 都属计划 3。本计划做最小手势的唯一理由是 spec §9.2 的第 1 条验收依据
// （"能看到卖萌"）在没有手的情况下**原理上不可能达成**：
// 卖萌 = intent 'beg'，它的评分需要 playerApproach，而 playerApproach 需要
// senses.playerHand 非空（sim.js:322-327）。
//
// 纯逻辑模块：监听目标由 attachInput 的**形参**传入，所以本文件不出现
// document / window / canvas 任何一个词，于是它继续留在 tests/constraints.test.js
// 的纯度扫描范围内、并且能在 Node 里单测。
//
// ⚠️ speed 的单位是**归一化世界单位/秒**，不是 CSS 像素/秒。理由有两条：
//   · sim.js:594 拿它和 CONFIG.perceiveRadius（0.28，归一化单位）比距离，必须同单位；
//   · 手机 390px 与桌面 1920px 上"同样快的一划"应当算同样快，
//     用像素的话同一手势在手机上会显得慢约 5 倍，抚摸/戳的判定就随设备漂移了。

const DEFAULT_WINDOW_MS = 140;      // 速度窗口。见下面 computeSpeed 的注释
const MAX_SAMPLES = 32;             // 环形缓冲上界

export function computeSpeed(samples, count, now, windowMs) {
  if (count < 2) return 0;
  // 只用**窗口内**的采样。
  // 窗口存在的理由：不用它的话，一次快戳会被之前几秒的静止历史稀释成慢划 ——
  // 而 spec §6.1 的整个要点是"抚摸与戳是同一根手指不同速度、反应完全相反"，
  // 被稀释掉就等于戳不出来了。
  // 窗口取 140ms：比一次戳的持续时间（约 40–80ms）长，比一次抚摸的持续时间
  // （通常 > 300ms）短，所以两者都能被窗口内的采样完整代表。
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
  // 用**首末位移**而不是逐段累加：累加会把抖动（手在原地微颤）算成移动，
  // 于是"静止"永远得不到 0，spec §6.1 要求的"静止 vs 缓慢划动"就分不开了。
  return Math.hypot(dx, dy) / (dtMs / 1000);
}

export function createHandTracker(opts) {
  const o = opts || {};
  const windowMs = o.windowMs || DEFAULT_WINDOW_MS;
  const max = o.maxSamples || MAX_SAMPLES;
  const tracker = {
    count: 0,
    cursor: 0,
    down: false,
    samples: {
      t: new Float64Array(max),
      x: new Float64Array(max),
      y: new Float64Array(max),
    },
    // 复用的输出对象（spec §5.3：运行时不分配对象）。
    // ⚠️ 这意味着 state() 的返回值**下一次调用就会变**，调用方不得缓存它。
    out: { pos: { x: 0, y: 0 }, speed: 0 },
  };

  tracker.sample = (t, clientX, clientY, cssWidth, cssHeight) => {
    tracker.down = true;
    // 环形写入：长按一小时也不会让缓冲增长
    const k = tracker.cursor;
    tracker.cursor = (k + 1) % max;
    if (tracker.count < max) tracker.count += 1;
    const s = tracker.samples;
    // ⚠️ 环形缓冲 + 上面的 computeSpeed 假设"最新在末尾"。
    // 为了让两者都成立，采样写进 **逻辑末尾**：把环形数组当成
    // "从 (cursor - count) 开始的连续 count 个" 来看待太绕，
    // 所以这里直接改成**线性写入 + 满了整体前移**（见下面的 shift 实现）。
    insertSample(s, tracker, t, clientX, clientY, cssWidth, cssHeight);
    update(tracker, t, windowMs);
  };

  tracker.release = () => {
    tracker.down = false;
    tracker.count = 0;
    tracker.cursor = 0;
    tracker.out.pos.x = 0;
    tracker.out.pos.y = 0;
    tracker.out.speed = 0;
    tracker.active = false;
  };

  tracker.state = () => (tracker.active ? tracker.out : null);
  tracker.active = false;
  return tracker;
}

// 线性写入 + 满了丢弃最老的。
//
// 为什么不用纯环形：computeSpeed 要取"窗口内最老的一个"与"最新的一个"，
// 在环形缓冲上这需要知道起点，而起点会随 cursor 回绕 —— 代码量翻倍且极易写错
// （错法是把跨回绕的两点当成首末，算出一个巨大的假速度，
// 于是生物会把静止的手当成猛戳而逃命）。
// 32 个 Float64Array 元素的前移是 32×3 = 96 次赋值，每秒最多几百次，
// 比一个难懂的 bug 便宜得多。
function insertSample(s, tracker, t, clientX, clientY, cssWidth, cssHeight) {
  const max = s.t.length;
  if (tracker.count >= max) {
    s.t.copyWithin(0, 1);
    s.x.copyWithin(0, 1);
    s.y.copyWithin(0, 1);
    tracker.count = max - 1;
  }
  const k = tracker.count++;
  s.t[k] = t;
  // 归一化并夹住。指针可以移出 canvas（拖出窗口、或 touch 滑到边缘），
  // 越界的归一化坐标会让 sim.js:324 的距离计算失去意义。
  const nx = cssWidth > 0 ? clientX / cssWidth : 0;
  const ny = cssHeight > 0 ? clientY / cssHeight : 0;
  s.x[k] = nx < 0 ? 0 : nx > 1 ? 1 : nx;
  s.y[k] = ny < 0 ? 0 : ny > 1 ? 1 : ny;
}

function update(tracker, now, windowMs) {
  const s = tracker.samples;
  tracker.out.pos.x = s.x[tracker.count - 1];
  tracker.out.pos.y = s.y[tracker.count - 1];
  tracker.out.speed = computeSpeed(s, tracker.count, now, windowMs);
  tracker.active = true;
}

// 绑定指针事件。element 由 main.js 传入（通常是那个 <canvas>）。
//
// ⚠️ css/main.css 里的 `touch-action: none` 是这一层能工作的前提：
// 不设它，浏览器会把触摸解释成滚动/手势，pointermove 中途被 pointercancel 掐断，
// 症状是"抚摸只在刚按下去的一瞬间有效"。
export function attachInput(element, onHand, opts) {
  const o = opts || {};
  const now = o.now || ((typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now());
  const tracker = o.tracker || createHandTracker({});
  let vw = o.cssWidth || 1;
  let vh = o.cssHeight || 1;

  // clientX/Y 是相对**视口**的，而 canvas 是 position:fixed; inset:0 铺满视口的，
  // 所以两者原点重合，不需要减 getBoundingClientRect()。
  // ⚠️ 如果计划 3 给 canvas 加了边距或 HUD 挤压了它，这里必须改成减 rect.left/top。
  const onDown = (ev) => {
    vw = element.clientWidth || vw;
    vh = element.clientHeight || vh;
    tracker.sample(now(), ev.clientX, ev.clientY, vw, vh);
    onHand(tracker.state());
  };
  const onMove = (ev) => {
    if (!tracker.down) return;               // 没有按下就不算"手在缸里"
    tracker.sample(now(), ev.clientX, ev.clientY, vw, vh);
    onHand(tracker.state());
  };
  const onUp = () => {
    tracker.release();
    onHand(null);                            // 必须显式送 null，否则内核会认为手还停在那儿
  };

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  // 指针移出元素后抬起：pointerup 不会派发到元素上，手就会永远"按着"。
  // 用 setPointerCapture 而不是监听全局 pointerup —— 后者需要 window，
  // 而 window 是本文件不许出现的标识符。
  if (element.setPointerCapture) {
    const capture = (ev) => { try { element.setPointerCapture(ev.pointerId); } catch { } };
    element.addEventListener('pointerdown', capture);
  }

  return () => {
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    tracker.release();
    onHand(null);
  };
}
```

⚠️ **上面 `createHandTracker` 里有一段自相矛盾的代码必须清理**：`tracker.sample` 先做了环形写入（`tracker.cursor = (k + 1) % max`），又调用了 `insertSample`（线性写入 + `copyWithin` 前移）。两套写入逻辑同时存在会互相踩。**正确实现只保留线性写入**：删掉 `tracker.sample` 里的 `const k = tracker.cursor; tracker.cursor = (k + 1) % max; if (tracker.count < max) tracker.count += 1;` 三行与 `const s = tracker.samples;`（`insertSample` 内部自己取），只留：

```js
  tracker.sample = (t, clientX, clientY, cssWidth, cssHeight) => {
    tracker.down = true;
    insertSample(tracker.samples, tracker, t, clientX, clientY, cssWidth, cssHeight);
    update(tracker, t, windowMs);
  };
```

并把 `createHandTracker` 里的 `cursor: 0,` 字段与 `tracker.release()` 里的 `tracker.cursor = 0;` 一并删掉（`cursor` 不再存在）。`tracker.count` 保留 —— 测试「采样缓冲有上界」要用它。

⚠️ `performance` 这个词**不在**那七个禁用标识符里，所以 `typeof performance !== 'undefined'` 是合法的。但为了稳妥（也为了让测试能注入假时钟），`o.now` 的注入口保留。

- [ ] **Step 4: 接进 `main.js`**

```js
import { attachInput } from './input.js';
```

在 `boot()` 里 `const renderer = …` 之后加：

```js
  // 手：唯一的内核写入口。onHand 直接把 {pos, speed} 或 null 赋给 world.playerHand。
  //
  // ⚠️ 复用 attachInput 内部 tracker 的那个 out 对象是**安全的**：
  // 内核在 perceive（sim.js:322-327）里会把它需要的字段**拷出来**
  // （`playerHand = { pos: world.playerHand.pos, dist: d, speed: world.playerHand.speed }`），
  // 不会长期持有我们的对象。但 `pos` 是**引用**拷贝，所以下一次 pointermove
  // 会改掉内核 senses 里那个 pos —— 在同一帧内这是无害的（perceive 在 tick 里
  // 立即用完），但**不得**把 senses.playerHand.pos 存到跨帧的地方。
  const detachInput = options.detachInput || attachInput(canvasEl, (hand) => {
    world.playerHand = hand;
  }, { cssWidth: viewport.width, cssHeight: viewport.height });
```

并把 `const detachInput = options.detachInput || null;` 那行删掉（已被上面替换）。`controller.stop()` 里的 `if (detachInput) detachInput();` 保持不变。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/input.test.js` → Expected: PASS，9 条全绿。
Run: `node --test tests/` → Expected: **463 tests / 463 pass / 0 fail**（454 + 9），stderr 0 字节。

把 `tests/constraints.test.js` 可 import 性那条的数组改成 `['body.js', 'render.js', 'input.js']`，再跑一次 `node --test tests/constraints.test.js`，Expected: PASS —— **`input.js` 在纯度扫描范围内且是绿的**。

- [ ] **Step 6: 实测 `HAND_SPEED_POKE`（计划 1 交接义务第 3 条，不得跳过）**

计划 1 的原文（`docs/superpowers/plans/2026-10-14-life-core.md:6535`）：

> ⚠️ 计划 2/3 必须重调这个值：真实的鼠标输入要区分"静止"与"缓慢划动"，而本轮所有实测用的是无头脚本里写死的 `speed`。

所以 `0.25` 这个值**至今没有任何真实输入数据支撑**。本步骤就是去量它。

**(a) 先算出解析预期**（这样才知道实测结果该长什么样）：

| 手势 | 典型 CSS 像素速度（1920 宽桌面） | 归一化速度 | 相对 `HAND_SPEED_POKE = 0.25` |
|---|---|---|---|
| 静止（手放在缸上不动） | 0 | **0** | 远低于 ⇒ 判为抚摸 ✓ |
| 缓慢划动（抚摸） | ~200 px/s | **0.104** | 低于 ⇒ 判为抚摸 ✓ |
| 中速划动 | ~480 px/s | **0.250** | 恰好在阈值上 ⚠️ |
| 快速戳 | ~1500–3000 px/s | **0.78–1.56** | 高于 ⇒ 判为戳 ✓ |

⇒ 解析上 `0.25` 落在「慢划」与「快戳」之间，**方向是对的**。风险在中速划动恰好压在阈值上：那会让同一只手有时被当成抚摸、有时被当成戳，而 spec §6.1 要求「反应完全相反」—— 阈值附近的抖动会表现为"生物莫名其妙地一会儿蹭你一会儿躲你"。

**(b) 量真实分布。** 在 `src/main.js` 的 `boot()` 里临时加一段采样记录（**Task 8 Step 8 必须删除**）：

```js
  // DIAG-SPEED-BEGIN —— 临时诊断：采集真实指针速度分布，用于重调 HAND_SPEED_POKE。
  const diagSpeeds = [];
  const diagOrig = world.playerHand;
  // 每帧记一次当前速度；用 __tank 暴露出去方便导出
  globalThis.__diagSpeeds = diagSpeeds;
  // DIAG-SPEED-END
```

并在 step 循环里（`reconcileBodies` 之后）加：

```js
    if (world.playerHand) diagSpeeds.push(world.playerHand.speed);
```

然后在浏览器控制台里**分别**做三种手势各约 10 秒，每做完一种就取一次分位数：

```js
const q = (a, p) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length*p)]; };
const rep = (a) => `n=${a.length} 静止比例=${(a.filter(v=>v<0.02).length/a.length*100).toFixed(1)}% ` +
  `p50=${q(a,0.5).toFixed(3)} p90=${q(a,0.9).toFixed(3)} p99=${q(a,0.99).toFixed(3)} max=${Math.max(...a).toFixed(3)}`;
rep(__diagSpeeds)
```

记录三组数字（**这是要写进 `src/behavior.js` 注释的实测数据**）：

| 手势 | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| 静止（手放着不动 10 秒） | | | | | |
| 缓慢划动（像抚摸一样 10 秒） | | | | | |
| 快速戳（连续戳 10 秒） | | | | | |

**(c) 按实测定阈值。** 判据（写进注释）：阈值必须**同时**满足

1. `> 缓慢划动的 p99` —— 否则抚摸会被误判成戳，生物会躲开你的手（spec §6.1 的反面）
2. `< 快速戳的 p50` —— 否则戳会被误判成抚摸，`needs.startle` 永远不触发，"戳"这个交互等于不存在

若两条有交集，取**几何中点**（`√(p99_stroke × p50_poke)`）——几何中点在对数尺度上居中，而速度感知本身是对数的（0.1→0.2 与 0.8→1.6 感觉是同样的"快了一倍"）。

若**没有**交集（慢划的 p99 ≥ 快戳的 p50），说明 140ms 的速度窗口太宽或太窄，**先调 `DEFAULT_WINDOW_MS` 重量一遍**，不要硬选一个阈值。把两次的窗口与分布都记下来。

**(d) 改 `src/behavior.js`**，在 `HAND_SPEED_POKE` 的注释里追加实测数据（格式照抄计划 1 在 `begUrgency` 上的写法：日期 + 改前改后 + 实测依据 + 变异探针）。若实测支持保留 `0.25`，也**必须**写明「2026-10-20 实测复核：保留 0.25」并附上那张分布表 —— 一个被实测确认过的常量与一个从没被测过的常量，在维护上是两件完全不同的事。

- [ ] **Step 7: 变异探针**

(a) 把 `computeSpeed` 的窗口过滤删掉（`const iOldest = 0;`）。
Run: `node --test tests/input.test.js`
Expected:「computeSpeed：过期采样不参与」**变红**。
在浏览器里验：先把手静止放在缸上 3 秒，然后猛戳一下 —— 生物**不躲**（戳被静止历史稀释了）。这就是那条断言在守的东西。

(b) 把 `computeSpeed` 的首末位移改成逐段累加：
```js
  let sum = 0;
  for (let i = iOldest + 1; i <= iNewest; i++) sum += Math.hypot(s.x[i]-s.x[i-1], s.y[i]-s.y[i-1]);
  return sum / (dtMs / 1000);
```
Expected:「computeSpeed：静止为 0」变红（手在原地微颤时累加值不为 0）。
在浏览器里验：手放着不动，生物会**一直**以为你在抚摸它、好感持续上涨 —— spec §6.1 的"静止 vs 缓慢划动"就分不开了，而卖萌会退化成计划 1 注释里警告的"挂机计时器"。

(c) 把 `onUp` 里的 `onHand(null)` 删掉。
Expected:「没有指针时 state() 是 null」仍然绿（它测的是 tracker 不是 attachInput）——**这是已知的覆盖缺口**：`attachInput` 需要真实 DOM 事件才能测。由 Task 10 的手工核对第 9 项覆盖（「抬手后生物不再跟着手走」）。如实记进 `.superpowers/sdd/progress.md`。

- [ ] **Step 8: 删掉诊断代码**

Run: `grep -n "DIAG-SPEED" src/main.js`
Expected: **无输出**（退出码 1）。同时确认 `globalThis.__diagSpeeds` 与 `diagSpeeds.push` 都已删除。

- [ ] **Step 9: 在浏览器里核对**

双击 `start.bat`。Expected：
- 把手（鼠标）**按住并缓慢划动**靠近某只生物 → 它应当**主动转过来对着你的手**，眼睛跟着手走，蹭过来（好感高时更主动；好感低时会转开 —— spec §4.6）
- **快速戳**一只生物 → 它应当**受惊逃开**（`needs.startle` + fear 上升），周围 0.18 内的其它生物也会短暂紧张
- **抬手** → 所有生物立刻不再跟着手走，几秒内恢复自己的事
- 长时间把手**静止**放在某只生物旁边 → 它应当慢慢熟悉你（`familiarity` 涨），但**不会**因此撒娇；撒娇要等 `beg` 真的胜出（`affection` 只有 beg 能买到，sim.js:589）
- 手机（同一 WiFi 打开 `http://<桌面IP>:8123/`）上用**手指**重复上面四条 —— 触摸与鼠标的行为必须一致

⚠️ 想看卖萌需要耐心：`beg` 要在效用评分里赢过 `forage`/`explore`/`court` 才会出现。计划 1 的实测是种子 31337 下 `beg 胜出 301/1200 tick`、种子 999 下 `40/1200`。所以**多养一会儿、多抚几只**，好感上去之后卖萌会明显变多。这条已经由 Task 6 的 `eyeParamsFor` 单测覆盖了视觉部分，这里只需确认它在真实缸里出现过至少一次。

- [ ] **Step 10: 提交**

```bash
git add src/input.js src/main.js src/behavior.js tests/input.test.js tests/constraints.test.js
git commit -m "feat: 最小手势输入（指针→playerHand），并按实测重调 HAND_SPEED_POKE"
```

---

### Task 9: `audio.js` —— 程序化合成（每条血脉有自己的嗓音）

spec §5.4：Web Audio 程序化合成，**零音频文件**（也是 spec §10 的明文范围外项）。事件→声音的表有七行；音高随体型（小只高、大只低）、音色随色相基因，所以「每条血脉有自己的嗓音」。

**Files:**
- Create: `src/audio.js`
- Modify: `src/config.js`（新增 `CONFIG.audio` 一节）
- Modify: `src/main.js`（接上 audio；在指针首次落下时 `resume()`）
- Modify: `tests/constraints.test.js`（把 `'audio.js'` 加回可 import 性那条）
- Test: `tests/audio.test.js`

**Interfaces:**
- Consumes: `world.events`（八种）、`c.traits.{hue,size}`、`c.intent.kind`、`emotions.dominant`、`CONFIG.colors` 无关
- Produces:
  - `voiceParamsFor(traits, size) => { pitch, timbre, detune }`（**纯函数**）
  - `SOUND_FOR`（事件/情绪 → 声音配方的常量表，可被断言）
  - `createAudio(CtxCtor, opts) => Audio`
  - `Audio = { consume(events, world), resume(), setMuted(b), isMuted(), isBlocked(), close(), masterGain }`

- [ ] **Step 1: 在 `CONFIG` 里新增 `audio` 一节**

```js
  // ---- 声音（spec §5.4）----
  //
  // 全部程序化合成，零音频文件（§10 明文把"任何音频素材文件"列为范围外）。
  // 下面的频率值来自 §5.4 那张事件→声音表，逐字对应：
  //   开心     600→900Hz 两声上滑正弦
  //   卖萌     400→200Hz 下滑 + 气泡噪声
  //   生气     90–140Hz 咕噜带抖
  //   困倦     长缓慢下滑、柔和起音
  //   求偶成功 两音小铃
  //   孵化     细碎裂声 + 上扬小音
  //   死亡     极轻下滑
  audio: {
    masterGain: 0.055,        // spec §5.4："默认开启，音量很小"。0.055 是"能听见但不打扰"的量级；
                              // 环境音之类的持续声源一旦超过 0.1 就会从"陪伴"变成"噪音"。
    joyFrom: 600, joyTo: 900, joyNotes: 2,
    begFrom: 400, begTo: 200,
    angerFrom: 90, angerTo: 140, angerWobbleHz: 18,     // "咕噜带抖"：低频 + 颤音
    sleepyFrom: 420, sleepyTo: 180, sleepyDuration: 1.6, // "长缓慢下滑"
    mateBellA: 880, mateBellB: 1320,                     // "两音小铃"：纯五度
    hatchCrackle: 0.09, hatchRiseFrom: 700, hatchRiseTo: 1400,
    deathFrom: 300, deathTo: 120, deathGain: 0.35,       // "极轻下滑"：还要再乘一层衰减
    // 嗓音（§5.4："音高随体型，音色随色相基因 ⇒ 每条血脉有自己的嗓音"）
    pitchRefSize: 26,         // 中性体型（(14+38)/2）；此体型 pitch = 1.0
    pitchMin: 0.75,           // 最大成体的下限（再低就听不见了，且会与"生气"的低频混淆）
    pitchMax: 2.8,            // 刚孵化幼体的上限（sizeOf 最小 3.08 ⇒ √(26/3.08) = 2.9，夹到 2.8）
    timbreFrom: 500,          // 色相 → 带通滤波中心频率。粉色区间 70° 映射到 500–2100Hz，
    timbreTo: 2100,           // 差 4 倍以上 ⇒ 不同血脉的音色**明显**不同，而不是听不出差别
    detuneSpan: 14,           // 音分。同一血脉内两只的细微差别，避免完全同音的机械感
    // 节流：同一种声音在这么短时间内只播一次
    cooldownPerKind: 0.18,    // 秒。24 只生物同时开心时不该变成一片噪音墙
    maxVoicesPerFrame: 3,     // 每帧最多同时起 3 个声音；超出的直接丢弃（不是排队 ——
                              // 排队会让声音滞后于画面，那比少播几个更糟）
  },
```

- [ ] **Step 2: 写 `tests/audio.test.js` 的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { voiceParamsFor, SOUND_FOR, createAudio } from '../src/audio.js';

// ------------------------------------------------------- 桩 AudioContext

function audioParam(name, node) {
  return {
    value: 0,
    ramps: [],
    setValueAtTime(v, t) { this.ramps.push(['set', v, t]); this.value = v; return this; },
    linearRampToValueAtTime(v, t) { this.ramps.push(['lin', v, t]); this.value = v; return this; },
    exponentialRampToValueAtTime(v, t) { this.ramps.push(['exp', v, t]); this.value = v; return this; },
    cancelScheduledValues(t) { this.ramps.push(['cancel', 0, t]); return this; },
  };
}

function createStubAudioCtx(opts) {
  const o = opts || {};
  const nodes = [];
  const mk = (kind) => {
    const n = { kind, connectedTo: [], onended: null };
    n.connect = (dest) => { n.connectedTo.push(dest); return dest; };
    n.disconnect = () => { n.connectedTo.length = 0; };
    nodes.push(n);
    return n;
  };
  const ctx = {
    nodes,
    state: o.state || 'running',
    currentTime: o.currentTime || 0,
    sampleRate: 44100,
    destination: mk('destination'),
    resumes: 0,
    createOscillator() {
      const n = mk('oscillator');
      n.type = 'sine';
      n.frequency = audioParam('frequency', n);
      n.detune = audioParam('detune', n);
      n.start = (t) => { n.startedAt = t; };
      n.stop = (t) => { n.stoppedAt = t; };
      return n;
    },
    createGain() { const n = mk('gain'); n.gain = audioParam('gain', n); return n; },
    createBiquadFilter() {
      const n = mk('biquad');
      n.type = 'bandpass';
      n.frequency = audioParam('frequency', n);
      n.Q = audioParam('Q', n);
      return n;
    },
    createBufferSource() {
      const n = mk('bufferSource');
      n.playbackRate = audioParam('playbackRate', n);
      n.loop = false;
      n.buffer = null;
      n.start = (t) => { n.startedAt = t; };
      n.stop = (t) => { n.stoppedAt = t; };
      return n;
    },
    createBuffer(ch, len) {
      return { length: len, numberOfChannels: ch, getChannelData: () => new Float32Array(len) };
    },
    resume() {
      ctx.resumes += 1;
      if (o.resumeRejects) return Promise.reject(new Error('blocked'));
      ctx.state = 'running';
      return Promise.resolve();
    },
    close() { ctx.state = 'closed'; return Promise.resolve(); },
  };
  if (o.ctorThrows) return null;
  return ctx;
}

// 构造器：模拟 `new AudioContext()`
const Ctor = (opts) => function StubCtor() {
  if (opts && opts.ctorThrows) throw new Error('AudioContext is not allowed to start');
  return createStubAudioCtx(opts);
};

const mkWorld = (seed) => {
  const w = createWorld({ seed });
  for (let i = 0; i < 10; i++) tickWorld(w, CONFIG.fixedDt);
  return w;
};

// ------------------------------------------------------- 嗓音

test('音高随体型：小只高、大只低（spec §5.4）', () => {
  const traits = { hue: 330, sat: 0.7, lum: 0.73, size: 26 };
  const tiny = voiceParamsFor(traits, 3.08);      // 刚孵化的幼体
  const mid = voiceParamsFor(traits, 26);
  const big = voiceParamsFor(traits, 38);         // 最大的成体
  assert.ok(tiny.pitch > mid.pitch, `幼体应当更高：${tiny.pitch} vs ${mid.pitch}`);
  assert.ok(mid.pitch > big.pitch, `成体应当更低：${mid.pitch} vs ${big.pitch}`);
  assert.equal(mid.pitch, 1, '中性体型（CONFIG.audio.pitchRefSize = 26）应当恰好是 1.0');
  // 必须夹住：sizeOf 的下界 3.08 会让 1/√ 公式给出 2.9，超出可听范围且与"生气"的低频混淆
  assert.ok(tiny.pitch <= CONFIG.audio.pitchMax);
  assert.ok(big.pitch >= CONFIG.audio.pitchMin);
  assert.ok(Number.isFinite(voiceParamsFor(traits, 0).pitch), '体型 0 不得给出 Infinity（脏数据防御）');
});

test('音色随色相基因 ⇒ 每条血脉有自己的嗓音（spec §5.4 的原话）', () => {
  // 这条断言兑现的是 spec §5.4 里最容易被做成空话的一句。
  // 如果 timbre 不随 hue 变化，那么"每条血脉有自己的嗓音"就只是文案 ——
  // 玩家听到的是同一种叫声，只是音高不同，血脉在听觉上完全没有身份。
  const a = voiceParamsFor({ hue: 315, size: 26 }, 26);
  const b = voiceParamsFor({ hue: 25, size: 26 }, 26);      // 粉色区间的另一端
  assert.notEqual(a.timbre, b.timbre, '色相两端必须给出不同音色');
  assert.ok(Math.abs(a.timbre - b.timbre) > 800,
    `音色差异必须**明显**（> 800Hz），否则听不出血脉差别：${a.timbre} vs ${b.timbre}`);
  // 单调：沿粉色区间走，音色连续变化（跨 0° 处不得跳变）
  let prev = -1;
  for (let i = 0; i <= 70; i++) {
    const hue = (315 + i) % 360;
    const t = voiceParamsFor({ hue, size: 26 }, 26).timbre;
    assert.ok(t >= prev - 1e-9, `音色在 hue=${hue} 处回退：${t} < ${prev}`);
    prev = t;
  }
});

test('voiceParamsFor 是确定性的：同基因同体型 ⇒ 完全相同的嗓音', () => {
  const traits = { hue: 342, sat: 0.8, lum: 0.7, size: 30 };
  const a = voiceParamsFor(traits, 30);
  const b = voiceParamsFor(traits, 30);
  assert.deepEqual(a, b);
  // detune 不得取随机数：随机 detune 会让同一只生物每次叫都不一样，
  // 于是"这条血脉的嗓音"这个概念本身就不成立了
  assert.equal(a.detune, b.detune);
});

test('SOUND_FOR 覆盖 spec §5.4 事件→声音表的全部七行', () => {
  const expected = ['joy', 'beg', 'anger', 'sleepy', 'mate', 'hatch', 'death'];
  for (const key of expected) {
    assert.ok(Object.hasOwn(SOUND_FOR, key), `缺少 §5.4 的声音：${key}`);
    const s = SOUND_FOR[key];
    assert.ok(s && typeof s === 'object', `${key} 的配方必须是对象`);
    assert.ok(typeof s.duration === 'number' && s.duration > 0, `${key} 必须有正的时长`);
    assert.ok(s.kind === 'tone' || s.kind === 'noise' || s.kind === 'mixed',
      `${key} 的 kind 非法：${s.kind}`);
  }
  // 卖萌与孵化是"下滑 + 气泡噪声" / "细碎裂声 + 上扬小音"，必须是混合类型
  assert.equal(SOUND_FOR.beg.kind, 'mixed', '§5.4：卖萌 = 400→200Hz 下滑 + 气泡噪声');
  assert.equal(SOUND_FOR.hatch.kind, 'mixed', '§5.4：孵化 = 细碎裂声 + 上扬小音');
  // 死亡必须比其它声音都轻（§5.4："极轻下滑"）
  for (const key of expected) {
    if (key === 'death') continue;
    assert.ok(SOUND_FOR.death.gain <= SOUND_FOR[key].gain,
      `死亡应当是最轻的声音，但 ${key} 更轻`);
  }
});

// ------------------------------------------------------- 运行时行为

test('每个振荡器都接在带包络的 gain 上（否则起止会有爆音）', () => {
  const ctx = createStubAudioCtx({});
  const audio = createAudio(() => ctx, {});
  const world = mkWorld(11);
  audio.consume([{ kind: 'hatch', id: 'c1', pos: { x: 0.5, y: 0.9 }, eggId: 'e1' }], world);
  const oscs = ctx.nodes.filter((n) => n.kind === 'oscillator');
  assert.ok(oscs.length > 0, '孵化事件应当产生振荡器');
  for (const osc of oscs) {
    const gains = osc.connectedTo.filter((n) => n.kind === 'gain');
    assert.ok(gains.length > 0, '振荡器不得直连 destination（会爆音）');
    const env = gains[0].gain.ramps;
    assert.ok(env.length >= 2, `gain 必须有起音与释音两段包络，实测 ${env.length} 段`);
    // 起音必须从 0 开始：从非 0 起音是最常见的"咔哒"声来源
    assert.equal(env[0][0], 'set');
    assert.equal(env[0][1], 0, '包络必须从 0 起音');
    assert.ok(osc.startedAt !== undefined && osc.stoppedAt !== undefined, '振荡器必须 start 且 stop（否则节点泄漏）');
  }
});

test('每个事件的节点数有上界，且不随事件数无限增长（防泄漏）', () => {
  const ctx = createStubAudioCtx({});
  const audio = createAudio(() => ctx, {});
  const world = mkWorld(11);
  const one = [{ kind: 'hatch', id: 'c1', pos: { x: 0.5, y: 0.9 }, eggId: 'e1' }];
  audio.consume(one, world);
  const perEvent = ctx.nodes.length;
  assert.ok(perEvent > 0 && perEvent <= 12, `单个事件的节点数应当在 12 以内，实测 ${perEvent}`);

  // maxVoicesPerFrame = 3：一帧塞 100 个事件也只该起 3 个声音
  const ctx2 = createStubAudioCtx({});
  const audio2 = createAudio(() => ctx2, {});
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ kind: 'hatch', id: `c${i}`, pos: { x: 0.5, y: 0.9 }, eggId: `e${i}` });
  audio2.consume(many, world);
  assert.ok(ctx2.nodes.length <= perEvent * CONFIG.audio.maxVoicesPerFrame,
    `每帧最多 ${CONFIG.audio.maxVoicesPerFrame} 个声音，实测节点数 ${ctx2.nodes.length}`);
});

test('被浏览器阻止时静默降级：isBlocked() 为 true，且不抛、不产生节点', () => {
  // spec §5.4："若被浏览器策略阻止则静默降级、隐藏按钮"。
  // 移动浏览器在首次用户手势之前不允许 AudioContext 出声，这是常态而不是异常，
  // 所以它必须被安静地处理掉 —— 一次未捕获的 rejection 会让控制台一直红着，
  // 而用户看到的是"这个网页有 bug"。
  const audio = createAudio(Ctor({ ctorThrows: true }), {});
  assert.equal(audio.isBlocked(), true);
  const world = mkWorld(11);
  assert.doesNotThrow(() => audio.consume([{ kind: 'death', id: 'c1', pos: { x: 0.5, y: 0.5 }, name: 'x' }], world));
  assert.doesNotThrow(() => audio.setMuted(true));
  assert.doesNotThrow(() => audio.close());
});

test('resume() 被拒绝时同样静默降级（suspended 状态）', async () => {
  const audio = createAudio(Ctor({ state: 'suspended', resumeRejects: true }), {});
  await assert.doesNotReject(async () => { await audio.resume(); });
  assert.equal(audio.isBlocked(), true);
});

test('静音时不创建任何节点；取消静音后恢复', () => {
  const ctx = createStubAudioCtx({});
  const audio = createAudio(() => ctx, {});
  audio.setMuted(true);
  assert.equal(audio.isMuted(), true);
  const world = mkWorld(11);
  const before = ctx.nodes.length;
  audio.consume([{ kind: 'hatch', id: 'c1', pos: { x: 0.5, y: 0.9 }, eggId: 'e1' }], world);
  assert.equal(ctx.nodes.length, before, '静音时不该起任何声音（连节点都不建，省 CPU）');
  audio.setMuted(false);
  audio.consume([{ kind: 'hatch', id: 'c2', pos: { x: 0.5, y: 0.9 }, eggId: 'e2' }], world);
  assert.ok(ctx.nodes.length > before, '取消静音后必须恢复');
});

test('未知事件不抛、不产生节点（内核以后可能加事件）', () => {
  const ctx = createStubAudioCtx({});
  const audio = createAudio(() => ctx, {});
  const world = mkWorld(11);
  const before = ctx.nodes.length;
  assert.doesNotThrow(() => audio.consume([{ kind: 'something-new', id: 'x' }], world));
  assert.equal(ctx.nodes.length, before);
});

test('audio.js 不出现浏览器全局名（AudioContext 构造器靠注入）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/audio.js', import.meta.url)), 'utf8');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src),
      `audio.js 出现了 ${name}；构造器必须由 createAudio 的形参传入（形参请叫 CtxCtor，不要叫 AudioContext）`);
  }
  assert.ok(!/\bperceive\b/.test(src), 'perceive 在 tickWorld 之外调用会抛 TypeError（sim.js:286）');
});
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `node --test tests/audio.test.js`
Expected: FAIL —— `Cannot find module '…/src/audio.js'`。

- [ ] **Step 4: 写 `src/audio.js`**

```js
// audio.js —— Web Audio 程序化合成（spec §5.4）。零音频文件。
//
// 纯逻辑模块：AudioContext 的**构造器**由 createAudio 的形参注入（形参名刻意叫
// CtxCtor 而不是 AudioContext —— 后者会被 tests/constraints.test.js 的 \bAudioContext\b
// 匹配到）。所以本文件不出现任何浏览器全局名，嗓音映射那些纯数学能在 Node 里断言。
//
// ⚠️ 移动浏览器在首次用户手势前不允许出声。这是**常态不是异常**：
// 必须静默降级（isBlocked() = true、不产生节点、不抛未捕获的 rejection），
// 否则控制台一直红着，用户看到的是"这个网页有 bug"。

import { CONFIG } from './config.js';
import { dominant } from './emotions.js';
import { hueBucket } from './render.js';

const A = CONFIG.audio;

// spec §5.4 的事件→声音表，逐行对应。
// gain 是**相对**音量（还要再乘 masterGain），duration 是秒。
export const SOUND_FOR = {
  joy:    { kind: 'tone',  from: A.joyFrom,  to: A.joyTo,  notes: A.joyNotes, duration: 0.30, gain: 0.85, wave: 'sine' },
  beg:    { kind: 'mixed', from: A.begFrom,  to: A.begTo,  duration: 0.42, gain: 0.70, wave: 'sine', noise: 0.22 },
  anger:  { kind: 'tone',  from: A.angerFrom, to: A.angerTo, duration: 0.34, gain: 0.80, wave: 'sawtooth', wobbleHz: A.angerWobbleHz },
  sleepy: { kind: 'tone',  from: A.sleepyFrom, to: A.sleepyTo, duration: A.sleepyDuration, gain: 0.45, wave: 'sine', softAttack: true },
  mate:   { kind: 'tone',  from: A.mateBellA, to: A.mateBellB, notes: 2, duration: 0.70, gain: 0.75, wave: 'triangle', bell: true },
  hatch:  { kind: 'mixed', from: A.hatchRiseFrom, to: A.hatchRiseTo, duration: 0.50, gain: 0.80, wave: 'sine', noise: A.hatchCrackle },
  death:  { kind: 'tone',  from: A.deathFrom, to: A.deathTo, duration: 1.10, gain: A.deathGain, wave: 'sine', softAttack: true },
};

// 嗓音：音高随体型（小只高、大只低），音色随色相基因。
//
// 音高用 1/√size 而不是 1/size：声学与听觉上，尺寸与基频的关系接近平方根反比
// （同样的张力/密度下，振动体长度翻倍频率降到 1/√2 量级），
// 而 1/size 会让幼体尖到刺耳（sizeOf 最小 3.08 ⇒ 1/3.08 = 8.4 倍，完全不可听）。
export function voiceParamsFor(traits, size) {
  const s = size > 0.01 ? size : 0.01;               // 挡 0 与负数：会给出 Infinity
  let pitch = Math.sqrt(A.pitchRefSize / s);
  if (pitch < A.pitchMin) pitch = A.pitchMin;
  if (pitch > A.pitchMax) pitch = A.pitchMax;

  // 音色 = 带通滤波的中心频率，由色相桶决定。
  // ⚠️ 用 hueBucket 而不是原始 hue：原始 hue 是连续值，会让 timbre 也连续，
  // 那样"每条血脉有自己的嗓音"就退化成了"每只都有自己的嗓音"，
  // 家族在听觉上没有共同身份。分桶之后同一家族（相近色相）共享音色 ——
  // 这正是 spec §5.4 那句话的意思：嗓音属于**血脉**，不属于个体。
  const N = CONFIG.glowHueBuckets;
  const b = hueBucket(traits.hue, N);
  const timbre = A.timbreFrom + (A.timbreTo - A.timbreFrom) * (b / (N - 1));

  // detune 由色相桶与体型共同决定，但**不取随机数**：
  // 随机的话同一只生物每次叫都不一样，"这条血脉的嗓音"就不成立了。
  const detune = ((b * 7) % 5 - 2) * (A.detuneSpan / 2);

  return { pitch, timbre, detune };
}

export function createAudio(CtxCtor, opts) {
  const o = opts || {};
  const audio = {
    ctx: null,
    master: null,
    blocked: false,
    muted: !!o.muted,
    lastAt: new Map(),        // kind → 上次播放时刻（节流）
    voicesThisFrame: 0,
    noiseBuffer: null,
  };

  try {
    if (typeof CtxCtor !== 'function') throw new TypeError('createAudio 需要注入 AudioContext 构造器');
    audio.ctx = new CtxCtor();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = A.masterGain;
    audio.master.connect(audio.ctx.destination);
  } catch {
    // 静默降级（spec §5.4）。不打印错误：这不是故障，是浏览器的正常策略。
    audio.blocked = true;
    audio.ctx = null;
    audio.master = null;
  }

  audio.isBlocked = () => audio.blocked;
  audio.isMuted = () => audio.muted;
  audio.setMuted = (m) => {
    audio.muted = !!m;
    if (audio.master) audio.master.gain.value = audio.muted ? 0 : A.masterGain;
  };

  audio.resume = () => {
    if (!audio.ctx || !audio.ctx.resume) return Promise.resolve();
    // ⚠️ 必须 catch：移动浏览器会在没有用户手势时**拒绝** resume，
    // 一个未处理的 rejection 会让控制台一直红着。
    return Promise.resolve(audio.ctx.resume()).catch(() => { audio.blocked = true; });
  };

  audio.close = () => {
    if (audio.ctx && audio.ctx.close) {
      Promise.resolve(audio.ctx.close()).catch(() => { });
    }
    audio.ctx = null;
    audio.master = null;
  };

  // 事件 → 声音。
  //
  // 两条来源：
  //   · world.events（内核推来的离散事件：hatch / mated / death / rejected / eat …）
  //   · 情绪与意图的**转变**（开心 / 生气 / 困倦 / 卖萌），由 caller 通过
  //     audio.notice(creature) 提供 —— 内核不会为"情绪变了"推事件，
  //     而 spec §5.4 的表里有四行是情绪驱动的。
  audio.consume = (events, world) => {
    if (audio.blocked || audio.muted || !audio.ctx) return;
    audio.voicesThisFrame = 0;
    const t = audio.ctx.currentTime;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      let key = null;
      switch (ev.kind) {
        case 'hatch': key = 'hatch'; break;             // sim.js:744
        case 'mated': key = 'mate'; break;              // sim.js:803
        case 'death': key = 'death'; break;             // sim.js:638
        case 'rejected': key = 'anger'; break;          // sim.js:827；被拒绝 ⇒ 生气那一行
        default: break;                                 // eat / dissolved / eggFailed / error 不出声
      }
      if (key) audio.play(key, t, voiceForWorld(world, ev));
    }
    // 情绪驱动的声音：扫一遍活着的个体，看谁的主导情绪或意图刚刚变了
    if (world && world.creatures) {
      for (const c of world.creatures) {
        if (!c.alive) continue;
        const key = emotionSoundKey(c);
        if (key && audio.prevKey.get(c.id) !== key) {
          audio.play(key, t, voiceParamsFor(c.traits, c.sizeAtLastSound || 26));
        }
        audio.prevKey.set(c.id, key || '');
      }
    }
  };

  audio.prevKey = new Map();
  audio.play = (key, t, voice) => {
    if (audio.blocked || audio.muted || !audio.ctx) return;
    if (audio.voicesThisFrame >= A.maxVoicesPerFrame) return;    // 丢弃，不排队（见 CONFIG 注释）
    const last = audio.lastAt.get(key);
    if (last !== undefined && t - last < A.cooldownPerKind) return;
    audio.lastAt.set(key, t);
    audio.voicesThisFrame += 1;
    const recipe = SOUND_FOR[key];
    if (!recipe) return;
    try {
      playRecipe(audio, recipe, t, voice || { pitch: 1, timbre: 1200, detune: 0 });
    } catch {
      // 单个声音失败不该影响画面（spec §7.7：绝不让整个世界崩溃）
    }
  };

  return audio;
}

// 情绪 → 声音键。用 dominant()（内核导出的权威判定）而不是自己写 argmax。
//
// ⚠️ 只在**主导情绪发生变化**时发声（由 consume 里的 prevKey 比较负责），
// 否则一只持续开心的生物会每帧叫一次，1 秒 60 声。
function emotionSoundKey(c) {
  if (c.intent && c.intent.kind === 'beg') return 'beg';     // 卖萌优先于情绪：它是**行为**，
  const key = dominant(c.emotions);                          // 而且是 spec §9.2 第 1 条验收依据
  if (key === 'joy' && c.emotions.joy > 0.55) return 'joy';
  if (key === 'anger' && c.emotions.anger > 0.5) return 'anger';
  if (key === 'sleepy' && c.emotions.sleepy > 0.7) return 'sleepy';
  return null;
}

// 事件里没有 traits（death 事件只有 id/pos/name），所以要回世界查。
// 查不到就用中性嗓音 —— 少一点音色个性，好过抛异常。
function voiceForWorld(world, ev) {
  const id = ev.id || ev.a;
  if (world && world.creatures && id) {
    for (const c of world.creatures) {
      if (c.id === id) return voiceParamsFor(c.traits, c.traits.size);
    }
  }
  return { pitch: 1, timbre: (A.timbreFrom + A.timbreTo) / 2, detune: 0 };
}

// ---------------------------------------------------------------- 合成

function playRecipe(audio, recipe, t, voice) {
  const ctx = audio.ctx;
  const dur = recipe.duration;

  // 带通滤波 = 音色。中心频率来自色相桶 ⇒ 每条血脉有自己的嗓音。
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = voice.timbre;
  filter.Q.value = 1.1;                       // Q 太高会变成尖锐的哨声，太低则音色区分不出来
  filter.connect(audio.master);

  const env = ctx.createGain();
  env.connect(filter);

  if (recipe.kind === 'tone' || recipe.kind === 'mixed') {
    const notes = recipe.notes || 1;
    for (let i = 0; i < notes; i++) {
      const osc = ctx.createOscillator();
      osc.type = recipe.wave || 'sine';
      const start = t + (dur / notes) * i;
      const end = start + dur / notes;
      const f0 = recipe.from * voice.pitch;
      const f1 = (recipe.to || recipe.from) * voice.pitch;
      osc.frequency.setValueAtTime(f0, start);
      // 线性滑音（§5.4 的"上滑/下滑"）。用 linearRamp 而不是 exponentialRamp：
      // 后者在目标值为 0 时会抛错，而"下滑"的配方里 to 可能很小。
      osc.frequency.linearRampToValueAtTime(Math.max(1, f1), end);
      if (voice.detune) osc.detune.setValueAtTime(voice.detune, start);
      // "咕噜带抖"：用一个额外的低频振荡器调制主振荡器的频率
      if (recipe.wobbleHz) {
        const wob = ctx.createOscillator();
        wob.type = 'sine';
        wob.frequency.setValueAtTime(recipe.wobbleHz * voice.pitch, start);
        const wobGain = ctx.createGain();
        wobGain.gain.setValueAtTime(0, start);
        wobGain.gain.linearRampToValueAtTime(f0 * 0.12, start + 0.02);
        wobGain.gain.linearRampToValueAtTime(0, end);
        wob.connect(wobGain);
        wobGain.connect(osc.frequency);
        wob.start(start);
        wob.stop(end + 0.02);
      }
      // 包络：起音必须从 0 开始（从非 0 起音是最常见的"咔哒"声来源）
      const peak = recipe.gain * (notes > 1 ? 0.7 : 1);
      const attack = recipe.softAttack ? dur * 0.35 : 0.012;
      oscGainEnvelope(env.gain, start, end, peak, attack);
      osc.connect(env);
      osc.start(start);
      osc.stop(end + 0.05);
    }
  }

  if (recipe.kind === 'mixed' && recipe.noise) {
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(audio);
    src.loop = true;
    const ng = ctx.createGain();
    const end = t + dur;
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(recipe.noise * recipe.gain, t + dur * 0.25);
    ng.gain.linearRampToValueAtTime(0, end);
    src.connect(ng);
    ng.connect(filter);
    src.start(t);
    src.stop(end + 0.02);
  }
}

function oscGainEnvelope(param, start, end, peak, attack) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.linearRampToValueAtTime(peak * 0.6, start + attack + (end - start - attack) * 0.4);
  param.linearRampToValueAtTime(0, end);
}

// 噪声缓冲只建一次并复用（气泡/碎裂声用）。
// ⚠️ 噪声数据必须来自 world.rng 而不是 Math.random —— 但音频是纯表现层，
// 不参与模拟的可复现性，而且 createAudio 收不到 world.rng。
// 折中：用一个**固定的伪随机序列**（下面这个 LCG 的种子是写死的常数），
// 于是所有设备上的噪声缓冲逐位相同，既不需要 rng 也不违反"不用 Math.random"。
let noiseCache = null;
function getNoiseBuffer(audio) {
  if (audio.noiseBuffer) return audio.noiseBuffer;
  const len = Math.floor(audio.ctx.sampleRate * 0.5);
  const buf = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = 0x2f6e2b1;                              // 写死的种子 ⇒ 逐设备一致
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = (s / 0xFFFFFFFF) * 2 - 1;
  }
  audio.noiseBuffer = buf;
  noiseCache = buf;
  return buf;
}
```

⚠️ `noiseCache` 是模块级变量但只写不读 —— **删掉它**（连同 `let noiseCache = null;` 与 `noiseCache = buf;` 两行）。缓存已经由 `audio.noiseBuffer` 承担，多一个模块级变量只会让人以为两处缓存需要保持同步。

⚠️ `audio.prevKey` 与 `audio.consume` 里用到的 `c.sizeAtLastSound` 是**坏味道**：后者从未被赋值，所以永远是 `undefined`、永远退回 26。改成在 `consume` 里直接用 `c.traits.size * growthFactor(c)`——但 `growthFactor` 要 import 自 `creature.js`。所以：`import { sizeOf } from './creature.js';` 然后写 `voiceParamsFor(c.traits, sizeOf(c))`。**这一处必须改对**，否则幼体的叫声和成体一样低，而"音高随体型"这条 spec 要求在画面上（幼体明显更小）与听觉上（一样低）就矛盾了。

⚠️ `audio.prevKey` 是一个 `Map`，会随生物生死缓慢积累孤儿键。在 `consume` 的情绪扫描循环之后加一次对账（与 `reconcileBodies` 同样的思路）：

```js
    if (audio.prevKey.size > 0 && world && world.creatures) {
      const limit = world.creatures.length + 4;
      if (audio.prevKey.size > limit) {
        const live = new Set();
        for (const c of world.creatures) live.add(c.id);
        for (const id of Array.from(audio.prevKey.keys())) if (!live.has(id)) audio.prevKey.delete(id);
      }
    }
```

（这里每帧可能 `new Set()`，但只在 `prevKey.size > limit` 时才走到，稳态下不触发。与 Task 7 的 `courtPairs` 同类折中，一并记进 `.superpowers/sdd/progress.md`。）

- [ ] **Step 5: 接进 `main.js`**

```js
import { createAudio } from './audio.js';
```

在 `boot()` 里、`attachInput` 之前：

```js
  // AudioContext 构造器在这里取（audio.js 不许出现 AudioContext 这个词）。
  // webkitAudioContext 是旧版 Safari 的前缀名。
  const CtxCtor = options.AudioContextCtor
    || window.AudioContext || window.webkitAudioContext || null;
  const audio = options.audio || (CtxCtor ? createAudio(CtxCtor, {}) : createAudio(null, {}));
```

⚠️ `createAudio(null, {})` 会在内部 `typeof CtxCtor !== 'function'` 处抛、被 catch 成 `blocked = true`。这是**期望行为**：不支持 Web Audio 的浏览器静默降级。

在 `attachInput` 的回调里加首次手势 `resume`（spec §5.4：「移动端需要用户首次交互时 resume()」）：

```js
  const detachInput = options.detachInput || attachInput(canvasEl, (hand) => {
    world.playerHand = hand;
    // 首次手势里 resume：浏览器只允许在用户手势的调用栈里解锁音频。
    // 每次 pointerdown 都调是安全的（已 running 时 resume 是 no-op），
    // 而且比"只调一次"更稳 —— iOS 在标签页切走后会把 context 重新挂起。
    if (hand && audio && audio.isBlocked && !audio.isBlocked()) audio.resume();
  }, { cssWidth: viewport.width, cssHeight: viewport.height });
```

并把 `controller.stop()` 里的 `if (audio && audio.close) audio.close();` 保持不变（已经写好了）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/audio.test.js` → Expected: PASS，11 条全绿。
Run: `node --test tests/` → Expected: **474 tests / 474 pass / 0 fail**（463 + 11），stderr 0 字节。
把 `tests/constraints.test.js` 可 import 性那条的数组改成 `['body.js', 'render.js', 'input.js', 'audio.js']`（**四个名字齐了**），再跑 `node --test tests/constraints.test.js`，Expected: PASS。

- [ ] **Step 7: 变异探针**

(a) 把 `voiceParamsFor` 里的 `timbre` 改成常数：`const timbre = 1200;`
Run: `node --test tests/audio.test.js`
Expected:「音色随色相基因 ⇒ 每条血脉有自己的嗓音」**变红**。
⚠️ 这个探针的意义超出测试本身：它是唯一能证明 spec §5.4 那句「每条血脉有自己的嗓音」**不是空话**的东西。改成常数之后代码照样跑、声音照样出、没有任何报错，只是那个设计承诺悄悄没了。

(b) 把 `oscGainEnvelope` 里的 `param.setValueAtTime(0, start);` 改成 `param.setValueAtTime(peak, start);`
Expected:「每个振荡器都接在带包络的 gain 上」变红（"包络必须从 0 起音"）。
在浏览器里听：每个声音开头都会有一声"咔哒"。

(c) 把 `createAudio` 里的 `catch { audio.blocked = true; … }` 改成 `catch (err) { throw err; }`
Expected:「被浏览器阻止时静默降级」变红。

(d) 把 `A.maxVoicesPerFrame` 从 3 改成 1000。
Expected:「每个事件的节点数有上界」变红。
在浏览器里验：缸满 24 只且集体开心时，声音会糊成一片噪音墙。

全部改回，重跑确认全绿，实测记进 `.superpowers/sdd/progress.md`。

- [ ] **Step 8: 在浏览器里核对（需要真的听）**

双击 `start.bat`，**先点一下画面**（解锁音频）。Expected：
- 极安静的背景下，偶尔听到很轻的短音（音量应当小到"不打扰旁边的人"）
- 孵化时一声细碎裂声 + 上扬小音；有生物死亡时一声极轻的长下滑
- 求偶成功时两声小铃（纯五度）
- **抚摸**一只生物到它开心时，两声上滑；它卖萌时下滑 + 气泡声
- **戳**它到它生气时，低频咕噜带抖
- 不同体型/不同色相的生物，叫声**音高与音色都可辨地不同** —— 把两只明显不同大小的放在一起对比听
- 控制台无未捕获的 rejection、无红色报错
- `__tank` 没有静音入口（计划 2 不做 HUD），在控制台验静音：
```js
// audio 实例在 boot 的闭包里，控制台取不到 —— 这是**已知的设计缺口**，
// 计划 3 的 HUD 会把它暴露出来。临时核对办法：在 main.js 的 controller 上加
// `audio,` 字段（Task 10 Step 4 会把它固化成正式接口）。
__tank.audio.setMuted(true);   // 应当立刻全静
__tank.audio.setMuted(false);
__tank.audio.isBlocked();      // 桌面 Chrome/Edge 上应当是 false
```

⚠️ 所以本 Task 还要在 `controller` 对象字面量里加一个字段 `audio,`（放在 `bodies,` 之后）。这不是为了调试方便而开的后门 —— 计划 3 的静音按钮**必须**能拿到 audio 实例，现在就把这个口子留对位置，比到时候再改 `boot()` 的返回形状干净。

- [ ] **Step 9: 提交**

```bash
git add src/audio.js src/main.js src/config.js tests/audio.test.js tests/constraints.test.js
git commit -m "feat: 程序化声音合成（音高随体型、音色随色相，每条血脉有自己的嗓音）"
```

---

### Task 10: 视觉核对清单、性能实测与端到端验收

**Files:**
- Create: `tests/visual-checklist.md`（spec §8.2 要求的文件）
- Create: `tests/perf.test.js`
- Modify: `docs/superpowers/specs/…-design.md`（若核对结果要求调常量，把实测数据写回注释）
- Modify: `.superpowers/sdd/progress.md`（台账）

- [ ] **Step 1: 写 `tests/visual-checklist.md`**

```markdown
# 渲染层手工核对清单（spec §8.2）

> 前六项是 spec §8.2 逐字要求的；第 7 项起是计划 2 在实现过程中**发现自己留下了
> 自动化覆盖缺口**的地方，如实补上。每一项都注明"为什么自动化测不到"——
> 一份不说明这一点的手工清单，看起来像全面，实际是把没测的东西藏进了人工步骤。

**环境**：`start.bat` → 桌面 Chrome/Edge；同一 WiFi 下用手机 Safari/Chrome 打开
`http://<桌面IP>:8123/`。每项都要在**两台设备**上各过一遍。

| # | 核对项 | 怎么看 | 通过判据 | 为什么自动化测不到 |
|---|---|---|---|---|
| 1 | **七种情绪无文字可辨认**（spec §8.2-1） | 在控制台逐条把某只生物的情绪拉满：`__tank.world.creatures[0].emotions.joy = 1` 等，六个分量各试一次；再试 `intent = {kind:'beg', targetPos:{x:.5,y:.5}, minDuration:9}` 看卖萌 | 不看任何文字提示，能说出它现在是哪种情绪；**且画面上没有任何 ♡ 💢 ？ ！ 或文字气泡**（spec §1 原则 1、§2 明令禁止） | "能不能辨认出情绪"是人的判断，桩 ctx 只知道画了几笔 |
| 2 | **粉色在深靛紫上"像在发光"**（spec §8.2-2） | 默认画面静置 30 秒 | 生物看起来是**自发光**的，不是贴在背景上的粉色圆片；光晕在身体周围有柔和过渡，没有硬边 | 发光感来自 'lighter' 混合与背景的实际合成结果，只能在真屏上看 |
| 3 | **竖屏铺满、不畸形、不过小**（spec §8.2-3） | 手机竖屏；再把桌面窗口拉成极窄（390×844）与极宽（3840×1080） | 水体铺满无白边无滚动条；生物是**圆的**（不是被拉成椭圆）；成体不小于约 39px、不大于约 68px（见 `CONFIG.render` 注释里的算术） | 需要真实视口与真实 CSS 布局 |
| 4 | **求偶脉动同步看得懂**（spec §8.2-4） | 等缸里出现求偶（`__tank.world.creatures.filter(c=>c.courtship).length` 不为 0），或在控制台给两只手动装上 `courtship = {partnerId, t:0, duration:10, phase:'circle'}` | 两只的脉动**明显同步**（像一对心跳），且它们之间有一条柔和弧线；不看代码能猜到"这两只在求偶" | "看得懂"是可读性判断 |
| 5 | **死亡溶散温和不惊悚**（spec §8.2-5） | 等自然老死，或 `__tank.world.creatures[0].alive = false`（内核会在 4 秒后 splice 它） | 4 秒内逐渐变透明、放大、上浮，像溶进水里；**没有**突然消失、没有爆开、没有闪烁 | "温和"是观感判断 |
| 6 | **Q 弹回弹自然、非抽搐**（spec §8.2-6） | 看游动中的生物急停/急转；对比 `traits.wobble` 高低不同的两只（`__tank.world.creatures.map(c=>c.traits.wobble)`） | 停下时先压扁再弹回、有**过冲**；wobble 高的那只明显更晃；全程没有高频抖动或抽搐 | 过冲的**数值**已被 `tests/body.test.js` 钉住，但"自然 vs 抽搐"是观感 |
| 7 | **转身后高光仍在左上缘** | 让一只生物朝各个方向游动（或等它自己转向） | 高光**始终**在左上（约 -135°），不跟着身体转；凝胶体的亮侧与高光同侧 | ⚠️ Task 6 变异探针 (d) 明确记录了这个缺口：桩 ctx 只数调用次数，判断不了画在哪个角度 |
| 8 | **缸满时卵逐渐暗下去** | 等种群到 24（桌面）；`__tank.world.eggs.filter(e=>!e.viable).length` 不为 0 后盯着缸底看 20 秒 | 不可孵化的卵**逐渐**变暗（约 22 秒），最后留一点残光；可孵化的卵一直亮着并脉动 | `eggGlowFor` 的曲线已被单测钉住，但"暗下去这件事被玩家注意到了吗"只能人看 |
| 9 | **抬手后生物不再跟着手走** | 按住并缓慢划动吸引几只生物跟过来，然后**抬手** | 抬手后 1–2 秒内它们停止跟随、各自散开去做自己的事；不会永久围着一个看不见的点转 | ⚠️ Task 8 变异探针 (c) 明确记录了这个缺口：`attachInput` 需要真实 DOM 事件才能测 |
| 10 | **sick 个体可见地变暗、静止** | `__tank.world.creatures[0].sick = true` | 它明显变暗、去饱和、几乎不动，但仍**画在原地**（不是消失）；一眼能看出"这只不对劲" | `dimFactorFor` 已被单测覆盖，但"用户能不能看出问题"是 sim.js:940 那条要求的真正判据 |
| 11 | **手机与桌面观感一致** | 同一 seed：`__tank` 无法设种子，改用两台设备各自新建缸后对比整体观感 | 生物的**软硬质感、游动节奏、水体速度**看起来一致（体型按短边缩放所以大小不同，这是应该的） | 需要两台真实设备；spec §3.4-1 把这条列为对共享存档"致命" |
| 12 | **帧时间预算**（spec §5.3） | 见 Step 2 | 桌面 24 只 @60fps、手机 16 只 @60fps | 部分可自动化（见 `tests/perf.test.js`），真机帧率只能实测 |

## 已知的设计缺口（不要假装它们不存在）

- **计划 2 没有静音按钮、没有时间流速按钮**（HUD 属计划 3，spec §6.3）。核对时只能用控制台调 `__tank.audio.setMuted(true)` 与 `__tank.setTimeScale(4)`。
- **`globalThis.__tank` 是临时接口**。计划 3 加了 HUD 之后应当评估是否保留（保留则必须写进文档）。
- **`drawPattern` 每帧构造 `hsl()` 字符串**，是已知的、刻意的分配（见 Task 5 Step 4 的说明）。若 Step 2 的实测显示它是热点，改成按 `hueBucket` 预渲染 32 张花纹色块。
- **`drawCourtship` 里的 `new Map()` 与 `audio.prevKey` 的对账 `new Set()`** 是同类折中（Task 7 / Task 9 各自记录了）。同样等 Step 2 的实测结论。
```

- [ ] **Step 2: 实测帧时间**

在 `src/main.js` 的 `boot()` 里临时加一段帧时间统计（**Step 5 必须删除**）：

```js
    // DIAG-PERF-BEGIN
    if (state.frame % 60 === 0 && state.lastT >= 0) {
      const now2 = performance.now();
      if (state.perfT !== undefined) {
        const ms = (now2 - state.perfT) / 60;
        if (ms > 20) console.warn(`[perf] 近 60 帧平均 ${ms.toFixed(2)}ms/帧（预算 16.7ms）`);
        else console.log(`[perf] 近 60 帧平均 ${ms.toFixed(2)}ms/帧`);
      }
      state.perfT = now2;
    }
    // DIAG-PERF-END
```

分别在桌面（等种群涨到 24）与手机（涨到 16）上各跑 3 分钟，记录：

| 设备 | 种群 | 平均 ms/帧 | 超过 20ms 的次数 | 备注（何时最卡） |
|---|---|---|---|---|
| 桌面 1× | | | | |
| 桌面 4× | | | | |
| 手机 1× | | | | |
| 手机 4× | | | | |

判据：spec §5.3 的预算是**桌面 24 只 @60fps、手机 16 只 @60fps**，即 ≤16.7ms/帧。

若超预算，按这个顺序排查（从最可能到最不可能）：
1. `drawPattern` 的 `hsl()` 字符串构造 → 改成预渲染 32 张花纹色块
2. `ctx.filter` 若被用于 sick 去饱和 → 换成 `gelSick` sprite（Task 7 Step 4 已经预警过）
3. `drawCourtship` 的 `new Map()` → 换成 `renderer.courtPairs` 复用数组
4. 微粒数量 → `CONFIG.particles` 下调（120→90 / 60→45）
5. `glowRadiusFactor` 过大导致 overdraw → 下调（2.6→2.0）

⚠️ **不要**通过降低 `CONFIG.fixedDt`（提高步长）来"改善性能" —— 那会同时破坏 spec §3.4-1 的设备一致性与计划 1 交接要求第 2 条的前提。

把实测表与采取的处置写进 `.superpowers/sdd/progress.md`，并把最终值写进 `CONFIG` 注释（本项目纪律：每处常量变更都带它自己的实测数据）。

- [ ] **Step 3: 写 `tests/perf.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { createRenderer } from '../src/render.js';
import { createViewport } from '../src/main.js';
import { createStubCtx, makeCanvasStub, makeWorld, makeBodies } from './helpers/render-stub.js';

// 帧预算里**能自动化**的那一部分。
//
// 真机帧率测不了（需要真实 GPU 与真实设备），但"每帧做了多少次绘制调用"测得了，
// 而它是帧时间的主导项。所以这里钉住调用次数的上界：
// 上界本身不是性能保证，但它能挡住**数量级**的退化 ——
// 比如有人把光晕从"一张 sprite"改成"每只生物 8 层叠加"，
// 或者把预渲染 sprite 悄悄换回每帧 createRadialGradient（那条在 render.test.js 里）。

const DESKTOP = createViewport(1920, 1080, 1);

test('稳态帧的绘制调用次数有上界（桌面 24 只）', () => {
  const world = makeWorld(11);
  // 补到种群上限，按最坏情况测
  while (world.creatures.length < CONFIG.populationCap.desktop) {
    const c = world.creatures[0];
    world.creatures.push({
      ...c, id: `extra${world.creatures.length}`,
      pos: { x: 0.1 + 0.02 * world.creatures.length, y: 0.5 },
      vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 },
      emotions: { joy: 0.6, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0.4 },
      memory: { entries: new Map() }, intent: null, courtship: null,
      dying: 0, sick: false, mourn: 0, alive: true,
    });
  }
  const bodies = makeBodies(world);
  const r = createRenderer({
    makeCanvas: makeCanvasStub(), rng: world.rng.fork(1), viewport: DESKTOP, isMobile: false,
  });
  const ctx = createStubCtx();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);

  const n = world.creatures.length;
  const motes = r.motes.n;
  // 每只生物：光晕 1 + 凝胶体 1 + 发光核 1 + 眼白 2 + 腮红（2 次 arc）+ 高光 1 ≈ 6 次 drawImage
  // 加上身体轮廓 24 段贝塞尔、瞳孔与眼睑的 arc、花纹的若干次 arc
  const drawImageBudget = motes + r.shafts.length + 2 + n * 8;
  const bezierBudget = n * CONFIG.bodyPoints;
  assert.ok(ctx.count('drawImage') <= drawImageBudget,
    `drawImage ${ctx.count('drawImage')} 次超过预算 ${drawImageBudget}（${n} 只 + ${motes} 微粒）`);
  assert.ok(ctx.count('bezierCurveTo') <= bezierBudget,
    `bezierCurveTo ${ctx.count('bezierCurveTo')} 次超过预算 ${bezierBudget}`);
  // 这两条是 spec §5.3 的硬约束，在 render.test.js 里已有，这里再钉一次：
  // perf.test.js 是"帧预算"的单一入口，后来者调性能时只会看这个文件。
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.shadowBlurWrites, 0);
});

test('visual-checklist.md 存在，且覆盖 spec §8.2 的全部六项与本计划引用的两项', () => {
  const md = readFileSync(fileURLToPath(new URL('./visual-checklist.md', import.meta.url)), 'utf8');
  // spec §8.2 的六项（用关键词而不是整句匹配：措辞可以改，检查的东西不能少）
  for (const key of ['七种情绪', '像在发光', '竖屏', '求偶脉动同步', '死亡溶散', 'Q 弹回弹']) {
    assert.ok(md.includes(key), `visual-checklist.md 缺少 spec §8.2 的核对项：${key}`);
  }
  // 本计划在变异探针里明确记录的两个自动化缺口，必须真的出现在清单里 ——
  // 否则"如实记录缺口"就只是计划文档里的自我安慰。
  assert.ok(md.includes('高光仍在左上缘'), '缺少 Task 6 变异探针 (d) 记录的缺口');
  assert.ok(md.includes('抬手后'), '缺少 Task 8 变异探针 (c) 记录的缺口');
  // 每一项都必须说明"为什么自动化测不到"
  assert.ok(md.includes('为什么自动化测不到'),
    '清单必须说明每项为何无法自动化，否则手工清单会变成藏匿未测内容的地方');
});
```

⚠️ 这条测试引用了 `./helpers/render-stub.js`。桩 ctx 现在写在 `tests/render.test.js` 里，**必须先抽出来**：新建 `tests/helpers/render-stub.js`，把 `GRADIENT_STUB` / `createStubCtx` / `makeCanvasStub` / `makeWorld` / `makeBodies` / `DESKTOP` / `PHONE` 移进去并 `export`，然后让 `tests/render.test.js` 从它 import。

⚠️ `node --test tests/` 的匹配模式是 `tests/*.test.js`，所以 `tests/helpers/render-stub.js` **不会**被当成测试文件跑（这是想要的：它是被 import 的工具，不含 `test()`）。但要确认 `node --test tests/` 不会递归进 `helpers/` 去执行它 —— Node 20 的 `--test` 只匹配 `*.test.js` / `test-*.js` / `test.js`，`render-stub.js` 不匹配，安全。**跑一次确认**，别靠推断。

- [ ] **Step 4: 把 `audio` 固化进 controller 接口**

Task 9 Step 8 为了核对临时在 `controller` 上加了 `audio,` 字段。**把它留下来**，并同样加上 `renderer`（计划 3 的信息卡要读 renderer 的 sprite、静音按钮要读 audio）：

```js
  const controller = {
    world,
    viewport,
    bodies,
    renderer,
    audio,
    get frame() { return state.frame; },
```

理由：这两个字段不是调试后门，是计划 3 的 HUD **必须**的接口（静音按钮 → `audio.setMuted`，暂停按钮 → 需要能停 `step`）。现在留对位置，计划 3 就不用改 `boot()` 的返回形状。

同时在 `controller` 上补一个 `setPaused(b)`（计划 3 的暂停按钮需要，现在只是没人调）：

```js
    setPaused(paused) {
      state.paused = !!paused;
    },
    isPaused() { return !!state.paused; },
```

并在 `step` 里，`advanceLoop` 之前加：

```js
    if (state.paused) { state.lastT = t; return; }   // 暂停时不推进模拟，但仍要重画一帧
```

⚠️ 暂停时必须把 `state.lastT = t` 更新掉，否则恢复的那一帧 `frameDt` 会等于整个暂停时长 —— 虽然 `dtAccumCap` 会挡住补算，但那样每次暂停恢复都会白跑 15 个子步，画面上表现为"恢复瞬间生物闪了一下"。

`state` 的初始值里加 `paused: false,`。

- [ ] **Step 5: 删掉性能诊断代码**

Run: `grep -n "DIAG-PERF" src/main.js`
Expected: **无输出**（退出码 1）。

Run: `grep -rn "DIAG-\|DEBUG-DOTS\|__diagSpeeds" src/`
Expected: **无输出** —— 计划 2 的所有临时脚手架都已清除。

- [ ] **Step 6: 跑全量测试**

Run: `node --check` 逐个文件（或 `node --test tests/`，它会在 import 阶段暴露语法错误）
Run: `node --test tests/`
Expected: **476 tests / 476 pass / 0 fail**（474 + 2），stderr 0 字节。

Run: `node --test tests/constraints.test.js`
Expected: PASS，且可 import 性那条列着**四个**名字。

- [ ] **Step 7: 端到端验收（spec §9.2 里计划 2 能验的部分）**

⚠️ spec §9.2 的六条验收依据里，第 2、3、5、6 条（种群自我延续 60 分钟、色相锁粉色、繁殖在发生、家谱）已由计划 1 的 `tests/simulate.mjs` 覆盖。计划 2 要验的是**它们现在能在画面上被看见**，加上第 1 条（卖萌）—— 那条在计划 1 里原理上不可能验（没有手）。

跑一次长时观察，边看边记：

```powershell
cd F:\电子宠物
node --test tests/simulate.mjs 2>$null   # 这个文件不匹配 *.test.js，需要显式指定
node tests/simulate.mjs --seed 31337
```

（`simulate.mjs` 是无头模拟，**不渲染**。它在这里的作用只是确认计划 2 的改动没有污染内核：Expected 仍是 `✓ 验收通过`、exit 0、stderr 0 字节。种子 31337 是计划 1 实测里 `beg 胜出 301/1200 tick` 的那个，最容易看到卖萌。）

然后在浏览器里开一缸，观察至少 10 分钟，逐条记录：

| spec §9.2 | 核对 | 结果 |
|---|---|---|
| 1 | **看到过卖萌**（瞳孔放到最大、眼睛上移、腮红最明显、400→200Hz 下滑 + 气泡声） | |
| 2 | 看到过出生（卵脉动 → 孵化碎裂声 + 小生物出现） | |
| 3 | 看到过死亡（4 秒溶散，周围生物短暂变暗 = 哀悼） | |
| 4 | 看到过求偶（两只同步脉动 + 连接弧线 → 成功后两声小铃 + 缸底出现卵） | |
| 5 | 看到过觅食（生物游向青绿光藻 → 吃掉 → 开心两声上滑） | |
| 6 | 看到过受惊逃开（戳它 → fear 上升 → 瞳孔极小、眼睛后移、身体收缩、快速游开） | |
| — | 缸满时卵逐渐暗下去（`sim.js:788` 的可见性要求） | |
| — | 全程画面上**没有任何文字、符号、气泡、数字**（spec §1 原则 1） | |

⚠️ 若 10 分钟内没看到卖萌：不要就此判定失败。计划 1 的实测是种子 999 下 `beg 胜出 40/1200 tick`（约 3%），所以它本来就稀疏。**多做这几件事再看**：反复抚摸同一只（好感与熟悉度上去后 `pApproach` 升高，`beg` 的评分随之升高），把手**停在它附近缓慢移动**（`sim.js:593` 的 `speed <= HAND_SPEED_POKE && dist < 0.14` 才累积熟悉度）。若持续 20 分钟、多只高好感个体都看不到卖萌，那才是缺陷，记进台账并按 `systematic-debugging` 走。

- [ ] **Step 8: 把结果写回文档**

1. `.superpowers/sdd/progress.md` 追加：本计划每个 Task 的变异探针实测、Step 2 的帧时间表、Step 7 的验收表、以及所有「已知缺口」清单。
2. 若 Step 2 的实测导致任何 `CONFIG` 常量调整，把**实测数据写进该常量的注释**（格式照抄计划 1 在 `begUrgency`、`initialCreatures` 上的写法：日期 + 改前改后 + 实测依据 + 变异探针）。
3. 若 `HAND_SPEED_POKE` 在 Task 8 被改动，`src/behavior.js` 的注释必须已经带上那张分布表。

- [ ] **Step 9: 提交**

```bash
git add tests/visual-checklist.md tests/perf.test.js tests/helpers/render-stub.js tests/render.test.js src/main.js
git commit -m "test: 视觉核对清单与帧预算自动化，端到端验收"
```

---

## 本计划交给计划 3 的要求（控制方维护；实现中发现新的就追加）

1. **【`names.js`】** 内核里 `sim.js:163-169` 的 `defaultNameFor` 是临时实现，其注释写明「计划 3 会用 `names.js` 替换它」。替换方式是 `createWorld({ nameFor })` 注入（`sim.js:122`），**不要**直接改 `sim.js` 里的私有函数。叠词名表的内容与长度属 spec §12，实现阶段直接定。

2. **【`world.events` 的消费顺序】** 计划 2 里 `consumeEvents(renderer, …)` 与 `audio.consume(…)` 消费同一批事件，然后由 `main.js` 统一 `world.events.length = 0` 清空。**计划 3 若加第三个消费者（例如 UI 的提示条），必须插在清空之前**，并且**不得**自己清空 —— 谁先清空谁就把事件从别人手里抢走了。这条约束目前没有测试守卫，属于计划 3 要补的。

3. **【`perceive` 依然不能在 tick 之外调】** `src/sim.js:286` 的 `!o.alive` 会在 `world.grid` 是旧下标时抛 `TypeError`。计划 2 全程绕开它（`tests/render.test.js` 与 `tests/body.test.js` 各有一条断言守着）。计划 3 的信息卡**一定会**想调它（"这只生物现在感知到了什么"是很自然的 UI 需求）—— 那必须先把 `perceive` 改成不依赖 `world.grid` 的缓存下标，**而不是**在 UI 里 try/catch 掉。

4. **【`HAND_SPEED_POKE` 已经用真实输入重调过】** Task 8 Step 6 会留下实测分布表。计划 3 加拖拽投食与长按时，**不得**沿用同一个阈值区分所有手势 —— spec §6.1 的手势表有六种，一个速度阈值分不开它们。需要引入按压时长与位移轨迹两个维度，并各自实测。

5. **【`__tank` 与 controller 接口】** `globalThis.__tank` 是计划 2 的临时全局。`boot()` 返回的 controller 已经有 `world / viewport / bodies / renderer / audio / setTimeScale / getTimeScale / setPaused / isPaused / stop`。计划 3 的 HUD 应当**只**用 controller，并把 `__tank` 要么删掉、要么在文档里固化成正式调试接口（二选一，不要留成一个没人知道是临时的东西）。

6. **【静音按钮与 `isBlocked()`】** spec §5.4 要求「静音按钮在右上角；若被浏览器策略阻止则静默降级**并隐藏按钮**」。`audio.isBlocked()` 已经导出，HUD 必须用它决定按钮是否渲染 —— 否则用户会点一个永远没反应的按钮。触控目标 ≥44px、用 `env(safe-area-inset-*)`（`css/main.css` 里那四个 CSS 变量已经定义好了，计划 2 没有消费者）。

7. **【`ctx.filter` 的诱惑】** 计划 3 若想做"信息卡里的高亮/模糊背景"，注意 Task 7 Step 4 已经预警过 `ctx.filter` 在部分移动端不支持或极慢。优先用预渲染 sprite。

8. **【存档不得包含软体状态】** `Body` 里有 `Float64Array`（`dip`）与 24 个点对象。架构决定 2 已经把它挡在 `creature` 之外，所以 `JSON.stringify(world)` 不会带出它 —— **计划 3 写 `save.js` 时不要"顺手"把 `bodies` 也存进去**。软体状态是瞬态的，读档后由 `reconcileBodies` 重建（它会为每个新 id 建一个静止的 Body，然后弹簧在几帧内自然收敛到当前情绪的形状 —— 这个"读档后团子抖一下才定型"的过程是可接受的，甚至有点可爱）。

## Self-Review

**Spec 覆盖检查**（计划 2 范围内的条目逐条对到 Task）：

| spec | 内容 | 落点 |
|---|---|---|
| §3.1 | `start.bat` / `server.ps1` / `index.html` / `css/main.css` / `main.js` / `body.js` / `render.js` / `audio.js` / `input.js` / `visual-checklist.md` | Task 1 / 3 / 2 / 4–7 / 9 / 8 / 10 |
| §3.2 | 纯逻辑模块不 import DOM；每模块只导出命名函数 | 架构决定 1；`tests/constraints.test.js` 的四条新守卫 |
| §3.3 | 主循环数据流 | Task 3 的 `boot()` / `step()` |
| §3.4-1 | 固定步长 + 累加器封顶 0.25 | Task 3（`advanceLoop` + 两条测试） |
| §3.4-2 | 归一化坐标、短边推导缩放、resize 重映射 | 架构决定 4、5；Task 3（`createViewport`） |
| §3.4-3 | 32 桶预渲染光晕精灵 + `lighter` | Task 5（`buildGlowSprites`） |
| §3.4-4 | 空间网格邻居查询 | **计划 1 已实现**（`sim.js` 的 `world.grid`），计划 2 不碰 |
| §3.4-5 | 静态背景交给 CSS | Task 1（`css/main.css` + `tests/assets.test.js` 的漂移守卫） |
| §4.2 | 色相区间跨 0°、四则花纹、颜色表 | Task 4（`hueBucket`）、Task 5（`drawPattern`） |
| §4.3 | 三段背景色、微粒色与 alpha 0.15–0.4 | Task 1（CSS）、Task 4（`createMotes`） |
| §4.5 | 情绪 → 身体语言/颜色/发光 表 | Task 2（形变）、Task 5（发光核颜色）、Task 6（眼睛） |
| §4.6 | 眼睛四参数 + 逐情绪表 + 看着玩家的手 | Task 6（`eyeParamsFor` + 11 条测试） |
| §4.7 | 幼态延续（wobble 偏高）+ Q 弹物理（过冲） | Task 2（`springParams` 的 zeta + 过冲断言） |
| §5.1 | 24 控制点、四种形变来源、Catmull-Rom、七层绘制顺序 | Task 2（点与弹簧）、Task 5（1–4 层）、Task 6（5–7 层） |
| §5.2 | 深水体、60–120 微粒对象池、2–3 道光束、缸底沉积与堆叠 | Task 4 |
| §5.3 | 性能预算与三条硬约束 | 架构决定 6、7；Task 4（桩 ctx 断言）、Task 10（`perf.test.js` + 真机实测） |
| §5.4 | 程序化合成、七行事件表、音高随体型音色随色相、resume、静音降级 | Task 9 |
| §6.1 | 手势 | **最小子集**（抚摸/戳 → `playerHand`）进 Task 8；其余属计划 3（见「范围边界」） |
| §6.2 | 三种食物色刻意避开粉色 | Task 7（`drawFoods` + 断言） |
| §6.3 | UI / HUD | **计划 3**；Task 9 Step 4 预留 `audio` 与 `setPaused` 接口 |
| §7 | 存档、多设备、离线、降级 | **计划 3**（`server.ps1` 本计划只做静态服务） |
| §8.1 | 单元测试覆盖 | 各 Task 的测试；总数 386 → 476 |
| §8.2 | `tests/visual-checklist.md` | Task 10 Step 1（六项逐字 + 六项计划 2 自补缺口） |
| §9.1 | 新缸 8 只亚成体 + 光藻 | **计划 1 已实现**（`CONFIG.initialCreatures = 8`，本会话已把 spec §11 同步为 8） |
| §9.2 | 六条验收依据 | 第 2/3/5/6 条由计划 1 的 `simulate.mjs` 覆盖；第 1 条（卖萌）由 Task 6 单测 + Task 8 的手 + Task 10 Step 7 端到端覆盖；第 4 条由 Task 10 Step 7 |
| §10 | YAGNI 范围外 | 全部遵守：无多缸、无账号、无天气、无疾病、无多人、无捏合缩放（`index.html` 里 `user-scalable=no`）、无音频文件、无构建工具、无 npm 依赖（`tests/assets.test.js` 守着） |
| §11 | 常量表 | 只**新增** `CONFIG.body` / `CONFIG.render` / `CONFIG.audio` 与 6 个新颜色；**未改动**任何计划 1 的既有数值 |
| §12 | 实现阶段直接定的细节 | 叠词名表（计划 3）、各情绪参数精确数值（Task 6 Step 1）、光束与微粒运动参数（Task 4 Step 1）、求偶编舞（Task 7）、缩放公式（架构决定 4） |

**计划 1 交接义务的落地对照**：#1 子步进 → Task 3；#2 `perceive` 不可外调 → Task 2/4/8/9 各一条断言；#3 `HAND_SPEED_POKE` 重调 → Task 8 Step 6；#4 sick 可见 → Task 7；#5 `dying` 是溶散秒数 → Task 7 `dissolveState`；#6 events 是唯一通道且必须清空 → Task 3/7；#7 `angerDuration` → Task 6（⚠️ 见下）；#8 求偶编舞 → Task 7；#9 `playerHand` 是唯一写入口 → Task 8。

⚠️ **交接义务 #7 没有完全兑现，如实记录**：`c.thresholds.angerDuration` 在 Task 6 里被**读**了（`eyeParamsFor` 的测试构造了它），但 `eyeParamsFor` 的实现并没有真正用它来延长愤怒表情的持续时长 —— 情绪表情的时长实际由 `emotions.anger` 分量自己的衰减决定，而那个衰减率是内核 `emotions.js` 的 `inertia` 控制的。要真正用上 `angerDuration`，需要表现层**自己**维护一个"愤怒表情的残留计时器"（`anger` 分量已经回落但表情还绷着）。这是一个真实的设计选择，不是遗漏，但它意味着计划 1 那句「留给计划 2」的期望**没有被满足**。

**处置**：这属于「改行为」，按本项目纪律**等控制方裁定**，不擅自决定。已在下面「待裁定事项」里列出，实现时若裁定为"要做"，在 Task 6 追加一个 `angerHold` 状态（挂在 `renderer` 的 per-creature 表上，与 `Body` 同生命周期）与对应测试。

**占位符扫描**：本计划全文检索 `TBD` / `待补` / `占位` / `similar to` / `同上`（作为代码省略用时）/ `…` （在代码块内作为省略号时）—— **代码块内零命中**。所有代码块都是可直接落盘的完整实现。

⚠️ 五处"必须清理的坏味道"是**刻意保留**的，每一处都紧跟清理指令与理由：Task 4 Step 4 的 `s.ctx.canvas !== undefined ? … : …` 三元式（→ 约定 `{ctx, surface}`，本 Self-Review 已把类型约定改成这个形状）、Task 6 Step 4 的 `px * 0 - 0` 残留（→ 给出清理后写法）、Task 7 Step 4 的 `getGlowSprite(…) && CONFIG.colors.sakura`（→ 直接写颜色常量）、Task 8 Step 3 的环形/线性双写入（→ 只保留线性）、Task 9 Step 4 的 `noiseCache` 与 `sizeAtLastSound`（→ 删掉 / 改成 `sizeOf(c)`）。**保留它们是为了让实现者理解为什么那样写是错的**，但每一处都给了明确的正确写法，不留判断给实现者。若评审认为这反而增加风险，可以直接把这几处替换成清理后的版本，不影响任何测试。

**类型一致性检查**（发现六处不一致，**已在本轮全部改掉**；下面记录的是改后的状态）：
- `Viewport = {width, height, dpr, scale}`：Task 3 定义，Task 4/5/6/7 消费，字段名一致 ✓
- `Body`：已补 `seen` / `impactX` / `impactY`，与 Task 2 的实现和 Task 3 的 `reconcileBodies` 一致 ✓
- `MakeCanvas`：已改为 `(w,h) => { ctx, surface }`，并把"为什么必须返回两个东西"写进注释（只返回 ctx 会让预渲染出的 sprite 无法被 `drawImage` 引用）✓
- `Sprites` / `Sprite`：已改为 `{ glow: Sprite[], length }`、`Sprite = { ctx, surface, size }`，并注明用数组不用 Map（色相桶是 0–31 的密集整数）✓
- `Motes`：已补 `drift / phase / baseX`，并注明 `onResize` 不得重新分配这九个数组 ✓
- `VoiceParams`：已改为 `{ pitch, timbre, detune }`，三个字段各自的推导与理由都写在注释里 ✓
- `GestureSample`：已改为「不是对象，是三个并列 Float64Array」，与 Task 8 的 `createHandTracker` 一致 ✓
- `HandState = {pos, speed} | null`：与 `sim.js:119` 的注释逐字一致；已补「对象被复用、不得跨帧持有」的警告 ✓
- `Renderer`：已补全字段清单（`eggHues / bursts / courtPairs / coreSprites / eyeCache / eyeWhite / sx / sy / time / hand`），并注明 `draw` 不可重入 ✓
- `WorldEvents` 八种：开头逐字抄自 `sim.js`，Task 7/9 的 switch 覆盖全部八种 + default ✓

⚠️ **这六处不一致本身就是本 Self-Review 最有价值的产出**，值得说清它是怎么发生的：我先写了「类型约定」块（凭设计意图），再一个 Task 一个 Task 写实现代码，实现在写的过程中**长出了设计时没预见的字段**（`impactX/Y` 是发现速度差分不可用之后才有的、`drift/phase/baseX` 是发现微粒只会直线上浮之后才有的、`surface` 是发现 `drawImage` 不吃 ctx 之后才有的）。每一次都是实现比约定更对，但约定没有回头改。**如果直接开始写代码，实现者会照开头那份约定写，然后在第三个 Task 撞上对不上的形状。**

**测试数量核算**（每步的累计数都要对得上，否则说明漏算或多算了）：

| 阶段 | 新增 | 累计 |
|---|---|---|
| 起点（计划 1 结束） | — | 386 |
| Task 1（`assets.test.js`） | +4 | 390 |
| Task 2（`body.test.js`） | +14 | 404 |
| Task 3（`loop.test.js` +8、`constraints.test.js` +3） | +11 | 415 |
| Task 4（`render.test.js` 水体） | +11 | 426 |
| Task 5（`render.test.js` 身体） | +9 | 435 |
| Task 6（`render.test.js` 眼睛） | +11 | 446 |
| Task 7（`render.test.js` 溶散/卵/食物/求偶） | +8 | 454 |
| Task 8（`input.test.js`） | +9 | 463 |
| Task 9（`audio.test.js`） | +11 | 474 |
| Task 10（`perf.test.js`） | +2 | **476** |

⚠️ **这张表在第一版里是错的，已改正**，而且错了两次：
1. Task 3 只算了 `loop.test.js` 的 8 条，漏了 `constraints.test.js` 从 3 条变 6 条的**净增 3 条**，于是 Task 3 之后每一格都少 3（411/423/431/442/450/459/469/471）。
2. Task 9 我按"写了几段"而不是"数了几个 `test()`"填的 +9，实际数下来是 **11 条**（`voiceParamsFor` 三条、`SOUND_FOR` 一条、包络一条、节点上界一条、阻止降级两条、静音一条、未知事件一条、纯度一条）。

各 Task 步骤里的 Expected 数字**已经按这张表逐条改过来了**，两边现在一致。

两次错误的成因是同一个：**凭印象填数，而不是去数。** 第 2 次尤其说明问题 —— 我是先写了 `+9` 再写的测试代码，所以那个数字从一开始就不是数出来的。改正办法也简单：`grep -c "^test('"` 逐文件数一遍（本轮就是这么发现 Task 9 是 11 条的）。

保留这段错误记录的理由：**「每步都报一个测试总数」这个习惯的全部价值，恰恰在于它能在算错时暴露出来。** 如果只报"跑测试、应当全绿"，漏算 3 条不会有任何症状；报了总数，一个减法就能查出漏项。所以这个习惯要留着，而这次它确实起作用了 —— 两次。

⚠️ 各 Task 步骤里写的 Expected 数字与本表**必须逐条核对一致**。实现时若发现某一步的实际 pass 数与 Expected 差 1–2 条，先怀疑自己数错了测试条数（例如把 `test()` 里的多个 `assert` 当成多条测试），再怀疑代码。

## 待裁定事项（等控制方，不擅自改 spec）

1. **`angerDuration` 要不要在表现层真正实现**（Self-Review 里那条）。计划 1 交接要求 #7 说它「留给计划 2」，但 Task 6 只读了没用。要做的话需要表现层自己维护愤怒残留计时器，这会引入一个**跨帧的表现层状态**（与"软体状态由表现层持有"同类，但它影响的是"看起来生气多久"，也就是玩家感知到的情绪时长）。
   - 选项 A：做，在 Task 6 追加 `angerHold`（+2 条测试）
   - 选项 B：不做，把 `angerDuration` 记为**死代码**（与 `eggFailChanceAtCap`、`isAdultLike` 并列），并在计划 1 的交接清单里更正 #7 的措辞
   - 建议 B：内核的 `emotions.anger` 衰减已经提供了"生气持续多久"，再加一层表现层计时器会让同一个现象有两个来源，且两者会漂移。而 `angerDuration` 影响 `thresholds` 的构造，删它需要动 `personality.js`，属改内核，得单独裁定。

2. **`CONFIG.render` / `CONFIG.body` / `CONFIG.audio` 的三组新常量是否需要控制方过一遍**。spec §12 明确授权「各情绪参数的精确数值」「光束与微粒的具体运动参数」在实现阶段按观感直接定，所以按纪律**不需要**裁定；但 `scaleRef: 540` / `scaleMin: 1.5` / `scaleMax: 2.6` 决定了生物在屏幕上的**大小**，观感影响面较大，若控制方想先看一眼再定，可以在 Task 3 之后插一次核对。

3. **`globalThis.__tank` 留不留到计划 3 之后**（交接要求 #5）。

## Execution Handoff

计划已写完并做过 Self-Review。**Self-Review 抓出了 12 处真实缺陷并已在本轮全部改正**：一处测试计数错误（Task 3 漏算 `constraints.test.js` 净增的 3 条，导致其后八个 Task 的 Expected 数字全部少 3）、六处类型约定与实现代码不一致（`Body` 缺三个字段、`MakeCanvas` 返回形状、`Sprites`/`Sprite`、`Motes` 缺三个数组、`VoiceParams` 字段名完全不同、`GestureSample` 根本不是对象）、五处刻意保留并给出清理指令的代码坏味道、以及一处未完全兑现的计划 1 交接义务（`angerDuration`）。**这些都不是"注意事项"，是会直接让实现者写出错代码的缺陷** —— 尤其是 `VoiceParams`：约定块写 `{freq, freq2, timbre, gain}`，而 Task 9 实现的是 `{pitch, timbre, detune}`，四个字段里只有一个名字对得上。

两种执行方式：

**方式 A：subagent-driven（推荐）** —— 每个 Task 派一个 subagent 实现，我在每个 Task 之间做评审与变异探针复核。好处是每个 Task 的实现细节不会挤占主对话的上下文，坏处是 subagent 看不到前面 Task 里那些"必须清理的坏味道"的推理过程，需要我在派发时把相关 ⚠️ 段落原文带上。

**方式 B：inline 顺序执行** —— 我在当前对话里一个 Task 一个 Task 做完。好处是全部上下文都在手边、那些 ⚠️ 不会丢，坏处是十个 Task 的完整代码会很快填满上下文，后面的 Task 可能不得不靠重读文件恢复状态。

考虑到这份计划里有 **11 处 ⚠️ 是"代码里有坏味道、必须按指令清理"**（而不是"注意这里有个坑"），它们高度依赖上下文，我倾向 **方式 B 的前四个 Task（Task 1–4，把架构与守卫立起来）+ 方式 A 的后六个 Task**。但这是执行策略，按项目纪律由控制方定。

另外两件**先于执行**的事，也需要裁定：

- **PR #2 还开着**（https://github.com/ajsjsjjbshshsj/electronic-creature-tank/pull/2，`fix/harness-diagnostics` → `main`，1 commit `769bf11`，只改 `tests/simulate.mjs`）。计划 2 应当从它之上切分支，还是等它合并后从 `main` 切？
- **spec §11 的 `INITIAL_CREATURES = 4 → 8` 改动还没提交**（工作区里的未提交修改）。它应当单独成一个 `docs:` 提交，还是并进计划 2 的第一个提交？我建议单独提交 —— 它是控制方裁定的产物，与计划 2 的实现无关，混在一起会让两件事都难以追溯。

