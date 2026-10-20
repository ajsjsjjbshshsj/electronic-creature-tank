# 计划 2R「毛绒的缸」Implementation Plan

> **状态**：本计划取代 `2026-10-20-living-tank.md`（那份已标注 superseded，只搬它的仍成立部分）。
> 依据 spec：`docs/superpowers/specs/2026-10-14-electronic-creature-tank-design.md`，
> 提交 `582e22c`（大修）+ `3d80269`（撤回 EGG_SIZE_BIAS）。**开工前先读 spec §13。**

**Goal:** 把 2026-10-20 的三项裁定落到代码上 —— **孤雌自产卵 + 外来血统漂入**、**毛绒五角星 + 尾巴 + 蹦跳 + 星星眼/委屈眼**、**规则档语言系统（含可选 API 档）** —— 并让这口缸在浏览器里活起来。

**Architecture:** 分两个阶段，**顺序不可交换**：Phase A 全部在 Node 里可测、不碰任何浏览器 API；Phase B 是 Phase A 产物的只读消费者。理由很硬：`hatchSize` 的输入是 `eggSize`（A2 才有）、`speech` 的输入是 `moodOf`（A5 才有）、`hop` 的视觉的输入是 `INTENTS` 里的 `hop`（A4 才有）。反过来先写渲染，就会写出一堆等输入的桩，然后 A 阶段每改一次就得回头改一遍渲染 —— 那正是旧计划 12 处"约定与实现不一致"的成因。

**Tech Stack:** 零依赖。Node 内置 `node:test` + `node:assert/strict`；浏览器侧 Canvas 2D + ES Modules + Pointer Events + Web Audio；静态服务用 PowerShell 5.1 自带的 .NET `HttpListener`。

**前置:** 计划 1「生命内核」已交付并合并（`origin/main` = `2f9b7a2`），**386/386 全绿（本计划开工前实跑确认）**。当前分支 `docs/spec-fluffy-star-2026-10-20`。

---

## 0. 本计划的粒度：为什么这里没有可直接落盘的完整代码

**这是一次刻意的偏离，先说清代价和理由，免得被当成偷懒。**

旧计划 5918 行，每个 Task 都写了完整实现代码。它自己的 Self-Review 抓出 12 处缺陷，其中 6 处是同一个成因：「先凭设计意图写约定，再一个 Task 一个 Task 写实现，实现在写的过程中长出了设计时没预见的字段，而约定没有回头改」。最典型那条是 `VoiceParams` 约定写 `{freq, freq2, timbre, gain}`、实现写 `{pitch, timbre, detune}`，四个字段只有一个名字对得上。

**把完整代码写进计划，等于把"约定"和"实现"分成两份会各自漂移的东西。** 所以本计划只钉三样：

1. **接口**（函数签名、入参出参形状、谁持有状态）—— 这是跨 Task 的契约，必须提前定死；
2. **判据**（失败测试的**逐条清单**、变异探针、Expected 数字）—— 这是"做对了没有"的定义；
3. **陷阱**（这个 Task 里最容易写错的那一两处，附为什么）。

实现代码由被派发的子代理在测试倒逼下写。**每个 Task 的测试清单是逐条列出的，所以 Expected 数字是数出来的，不是估的** —— 填进台账前仍要用 `grep -c '^test('` 复核，这是纪律，不是不信任。

---

## Global Constraints

逐字来自 spec 与本轮裁定，所有 Task 隐含包含：

- **零依赖**：不得引入 npm 包、不得创建 `node_modules`、`package.json` 不得有 `dependencies`/`devDependencies`/`peerDependencies`。不加载任何音频素材。
- **不使用 `Math.random()`**：一切随机经由传入的 `rng`。表现层要随机只能 `world.rng.fork()`，且**只在初始化取一次**（否则同一份存档在两台设备上长得不一样）。
- **只有 `src/main.js` 可以触碰浏览器 API。** `document`/`window`/`canvas`/`requestAnimationFrame`/`AudioContext`/`fetch`/`localStorage` 七个标识符只允许出现在 `main.js`。这条**已有自动化守卫**：`tests/constraints.test.js` 扫 `src/**` 且 `fetch` 已在禁用清单里 —— 所以 §4.13.2 那条"API 档的 fetch 只能在 main.js"是扩展守卫，不是纸面承诺。
- **倍速必须用子步进实现，绝不能放大 `dt`**：`emotions.update` 是前向欧拉 `k = min(1, inertia*dt)`，不具步长无关性；4× 靠放大 dt 推进 1 模拟秒会得到 `0.815837` 而非 `0.802441`（偏差 **1.6693%**）。这个偏差只出现在情绪层，格外难查。
- **累加器封顶 `CONFIG.dtAccumCap = 0.25` 秒**。
- **纯逻辑模块不得 import `canvas`/`world`、不得触碰 DOM**；`speech.js` 尤其不得 `fetch`。
- **`inherit` 的内部逻辑一行不改**，只改第二个实参传谁（孤雌）。slot 0 = 第一配子的排序契约必须原样保留。
- **未裁定的行为不写进内核**（EGG_SIZE_BIAS 归零就是这条的执行结果）。任何本轮新长出来的"我觉得更好"，先回来说，不许直接落码。

---

## 阶段与依赖

```
Phase A（内核，Node 可测）        Phase B（表现层，浏览器）
A1 基因位点扩容  ─┬─→ A2 孤雌繁殖 ─┬─→ A3 漂入+多样性判据 ─→ A9 验收脚本升级
                │                │
                ├─→ A4 hop+beg升级链
                ├─→ A5 moodOf ──→ A6 speech+lexicon ──→ A7 memory.heard
                └─→ A8 config+存档v2+守卫扩展
                                          ↓
                                   B10 服务与骨架 → B11 主循环 → B12 星形软体+尾巴
                                   → B13 桩ctx+水体 → B14 分层绘制+毛边 → B15 眼睛
                                   → B16 蹦跳/死亡/求关注视觉 → B17 input → B18 audio
                                   → B19 气泡+API档 → B20 清单+性能+端到端
```

A1–A9 完成后 `node --test tests/` 必须全绿且 `tests/simulate.mjs` 三条新判据可跑，**才允许进 B**。

---

# Phase A：内核

## Task A1：基因位点扩容（外观 8→10、性格 6→9）

**产出**：`genes.js` 的 `APPEARANCE_GENES` 加 `fluff`、`eggTint`；`PERSONALITY_GENES` 加 `activity`、`talk`、`intellect`，`libido` 改名 `broody`；`decode()` 加 `fluff`/`eggTint` 的解码；`personality.js` 的阈值映射表补四维并把 `libido` 那行改成 `broody`。

**先改测试再改实现**（这三条断言不含 `court` 等关键词，但一定红，别指望悄悄通过）：

- `tests/genes.test.js:13` `APPEARANCE_GENES.length === 8` → `=== 10`
- `tests/genes.test.js:14` `PERSONALITY_GENES.length === 6` → `=== 9`
- `tests/genes.test.js:310` `deepEqual(Object.keys(personality).sort(), [...PERSONALITY_GENES].sort())` → 键集自动跟上

**新增测试（7 条，Expected +7）**：

1. `fluff 解码：phenotype 0 → 0，1 → 1（透传，不做单位换算）`
2. `eggTint 分段：phenotype 落在各段边界两侧取到相邻两色，黑段只在 ≥0.975 时命中`
3. `eggTint 分段边界表与 EGG_TINT_BANDS 之和为 1（防漂移）`
4. `PERSONALITY_GENES 冻结：九维数组 Object.isFrozen 且逐元素 frozen 不可行则至少数组冻结`
5. `新位点全部参与遗传：双亲 activity 全 0 且变异率 0 时子代 activity 恒 0`
6. `personality 映射：activity 高 → hop 权重高、energy 衰减快（方向断言，不断言绝对值）`
7. `personality 映射：talk 高 → 出词冷却短；intellect 高 → heardCap 大`

**变异探针**：把 `eggTint` 的分段表整体平移 0.01 —— 边界测试（第 2 条）必须红。若没红，说明边界用例选得太松，黑蛋稀有度会悄悄漂移。

**陷阱**：`GENE_KEYS`/`ALL_GENES` 是冻结数组（Task 2 复查钉过）。加位点时**同时**改 `ALL_GENES = [...APPEARANCE, ...PERSONALITY]` 的派生而不是手写一份字面量，否则两份会各长各的。

**提交**：`feat: 基因位点扩容 —— fluff/eggTint 与 activity/talk/intellect/broody`

---

## Task A2：繁殖改孤雌自产卵

**产出**：`breeding.js` 的 `layEggs(mother)`（签名去掉第二参）、蛋对象加 `eggSize`/`eggTint`、孵化时长按蛋、`creature.js` 出壳体型读蛋；`sim.js` 的结算路径去掉求偶；`INTENTS` 删 `court`（与 A4 同批改数组，避免两次破测试）。

**接口契约（定死，B 阶段依赖）**：

```js
layEggs(rng, mother, config) -> Egg[]
Egg = { id, mother, genes, eggSize /* 0.6..1.4 */, eggTint /* 8 色之一 */, age, x, y }
hatch(egg, config) -> Creature   // size 起点 = EGG_SIZE_MIN + (eggSize−MIN)×HATCH_GAIN
                                  // adultSize 完全由 size 基因定（EGG_SIZE_BIAS = 0）
```

**新增/改写测试（Expected：`breeding.test.js` 整文件重写，最终条数以 `grep -c '^test('` 为准；本 Task 新增清单 9 条）**：

1. `自体合并：inherit 收到两个相同实参时仍产出双等位基因`
2. `同胞互不相同：同一母亲同一次产卵的两枚蛋 genes 不全等`
3. `eggSize 单调于 hunger：喂饱的母亲蛋更大`
4. `孵化时长随 eggSize 单调递增`
5. `hatchSize 随 eggSize 单调递增`
6. `成年体型与 eggSize 无关（EGG_SIZE_BIAS=0 的钉子：两只同 genes 不同蛋大小的个体，成年 size 表现型相等）`
7. `father 恒为 null，但 lineage 仍保留 father 键（存档形状契约）`
8. `种群达上限时 broody 评分被压低（原"求偶评分被压低"改写）`
9. `eggTint 由母方基因决定，同母亲的多枚蛋可以不同色（分离）`

**删除**：所有 `court`/`COURTSHIP`/`KINSHIP_MATE_MAX` 相关测试（33 条命中，逐条判定"删"还是"改写成 socialize 版本"，不许整片注释掉留尸体）。

**变异探针**：把 `layEggs` 里第二个 `mother.genes` 换成 `null` —— 至少 2 条要红。若只红 1 条，说明自体合并的路径没被真正测到。

**陷阱**：`kinship` 这个量**保留**（亲属偏好、守巢、家谱边）。`memory.test.js` 里 30 条命中 `kinship` 的测试**绝大多数原样有效** —— 别顺手删了，那是本次最容易犯的过度清除。

**提交**：`feat: 孤雌自产卵 —— 自体合并、蛋大小与蛋色、删求偶闸门`

---

## Task A3：外来血统漂入 + 多样性判据（正反两向）

**产出**：`sim.js`/`world` 加 `driftIn`，`world.nextDriftAt`，`CONFIG.drift.interval = 240`。漂入物是**一枚带全新随机等位基因的蛋**（裁定 5）。

**这是本轮技术上最关键的一个 Task** —— §4.12 那条"杂合度一代砍一半"的论证，只有靠正反两向的实测才站得住：

**新增测试（Expected +6）**：

1. `漂入按 DRIFT_INTERVAL 发生，且携带的等位基因与缸内任何个体都不相同`
2. `漂入不越过种群上限`
3. `漂入的蛋 mother 为 null，家谱图上可识别为外来支系`
4. **`关掉漂入：连续 4 代均值杂合度比值 ≈ 0.5（容差 ±0.15）`**
5. **`开着漂入：跑 6 代（约 7200 模拟秒）均值杂合度稳在 > 0.2`**
6. `确定性：同种子两次跑出完全相同的漂入时刻与基因`

**判据 4/5 是本 Task 的全部价值**。没有 4，"漂入维持多样性"就只是个没人信的安慰剂；没有 5，漂入就只是"看起来在动"。两条都必须**实测通过**，不通过就回来改 `DRIFT_INTERVAL`，不许改判据迁就实现。

**实测脚本**：`.superpowers/sdd/diag-drift.mjs`（沿用 harness 的 diag-* 命名），打印每代杂合度、色相方差、母亲数。

**陷阱**：杂合度定义要写死在测试里 —— `mean over loci of (a !== b ? 1 : 0)`，且**排除 `eggTint` 之外的位点还是全含**必须明说（本计划：全含，因为 `eggTint` 的分离正是家谱线索的来源之一）。定义不一致会让 4/5 两条测出不同的东西。

**提交**：`feat: 外来血统漂入 + 杂合度正反两向判据`

---

## Task A4：`hop` 意图与 `beg` 升级链

**产出**：`INTENTS = ['forage','eat','rest','socialize','explore','flee','beg','protest','fight','mourn','idle','hop','brood']`（13 项：删 `court`、加 `hop`；`brood` 若 A2 未建则本 Task 建）。`behavior.js` 加 `scoreHop`、`beg` 的升级计数挂在 `memory[PLAYER]`。

**新增测试（Expected +8）**：

1. `INTENTS 冻结且长度为 13`
2. `energy 低时 hop 让位给 rest（"累了会休息"是涌现的：同 seed、只改 energy，断言意图翻转）`
3. `activity 高 → hop 得分高（方向断言）`
4. `hop 消耗 energy，且消耗量随 activity 上升`
5. `beg 3s 未被理睬 → 升级到 hop/靠近路径`
6. `再 5s 未被理睬 → protest`
7. `被抚摸后升级计数归零`
8. `同 seed 决策可重现（含 hop 与升级链）`

**变异探针**：把 `scoreHop` 里的 `energy` 项去掉 —— 第 2 条必须红。这是本 Task 唯一真正在测的东西。

**陷阱**：`begUrgency` 已经是 7.0（ff84886 为了让卖萌在真实缸里可达调的）。升级链的阈值要**从它推导**，不许再硬编码一个魔法数，否则两个常数会漂移。

**提交**：`feat: 蹦跳意图与求关注升级链`

---

## Task A5：`moodOf` 五档心情（纯派生，不写回）

**产出**：`emotions.js` 导出 `moodOf(emotions, needs, memory) -> 'anger'|'sad'|'bliss'|'happy'|'calm'`，阈值读 `CONFIG.mood`。

**新增测试（Expected +7）**：

1. `anger 0.6 + joy 0.7 → 报 anger，不报 bliss（判据顺序的钉子）`
2. `joy 0.65 + 刚有死亡事件 + social 0.1 → 报 sad`
3. `joy 0.7 + 四条需求全 ≤0.25 + affection(PLAYER) 0.7 → bliss`
4. `joy 0.5 其余低 → happy`
5. `全低 → calm`
6. `moodOf 不修改任何入参（deepStrictEqual 前后快照）`
7. `阈值全部来自 CONFIG.mood，源码里无硬编码数字（正则扫）`

**陷阱**：`bliss` 依赖 `memory[PLAYER].affection`，而那条记忆**豁免 familiarity 衰减但 affection 仍衰减**（90be12e 的裁定）。所以"放着不管十分钟后所有个体的 bliss 都会消失"是**正确行为**，别在测试里给它开后门。

**提交**：`feat: 五档心情 moodOf —— 连续内核与离散词表之间的唯一桥`

---

## Task A6：`speech.js` + `lexicon.js`（规则档）

**产出**：两个纯逻辑模块。`lexicon.js` 是数据（三层词表 + 句式模板 + 口癖候选集）；`speech.js` 导出 `maybeSay(creature, ctx, rng, nowSec) -> {text, tokens} | null`。

**接口**：出词判定 = 冷却到期 && `rng` 抽样通过 && 有可说的内容。口癖在**出生时**由 `rng.fork()` 抽定一次，固化进 creature（不入表现层）。

**新增测试（Expected +10）**：

1. `同状态 + 同 rng → 出词完全相同（可复现）`
2. `talk=0.1 与 talk=0.9 各跑 1200 模拟秒，出词数之比 ≥ 3（断言比值，不断言绝对值）`
3. `冷却期内不出词`
4. `同一句不连发`
5. `句长 ≤ SPEECH_MAX_TOKENS`
6. `speech.enabled=false → 恒返回 null，且不修改 creature 任何字段`
7. `口癖由 talk×clingy 的候选集抽定，且终身稳定（fork 两次结果一致）`
8. `需求词映射到最紧的那条需求`
9. `心情档决定情绪词层选词（bliss 才可能出"幸福"类词）`
10. `speech.js 源码不含 fetch/document（守卫扩展，见 A8）`

**陷阱**：第 2 条最容易写成"绝对值断言"，那会让每次调 `SPEECH_COOLDOWN` 全线红。**比值**才是性格在做事的证据。

**提交**：`feat: 规则档语言层 —— 三层词表 × 性格 × 心情`

---

## Task A7：`memory.heard` —— 听进去的话

**产出**：`memory.js` 加 `hear(creature, text, rng, nowSec, config)` 与 `recall(creature, contextTags)`；中文分词按标点/空白切 + 2–3 gram 兜底 + 停用词表（在 `lexicon.js`）。

**新增测试（Expected +8）**：

1. `hear 抽出实词候选，数量随 curious 上升`
2. `heardCap = 4 + round(intellect × 8)`
3. `uses 高的 token 半衰期是普通的两倍`
4. **`heard 不挤占关系记忆的 12 条配额`**（往 12 条已满的缸里 hear，关系记忆不减）
5. `intellect=0 时复述有 25% 概率换成近邻词；intellect=1 时为 0`
6. `相关情境才冒出来：存了"吃饭"，hunger 低时 recall 不返回它`
7. `token 的 price 由听到时的心情定价，正/负价影响后续反应方向`
8. `同 seed 下 hear 结果可复现`

**陷阱**：分词是这轮唯一一处"没有标准答案"的实现。**测试只能钉行为，不能钉具体切法** —— 否则换个分词策略就全红。第 1/6/7 条都是行为级断言，故意如此。

**提交**：`feat: 听进去的话 —— 关键词记忆、智力决定容量与还原度`

---

## Task A8：config 新常量 + 存档 v1→v2 + 守卫扩展

**产出**：`config.js` 删 3 键加约 30 键；`SAVE_VERSION = 2` + `migrateV1toV2`；`constraints.test.js` 扩 main.js 白名单（为 B 阶段铺路）。

**新增测试（Expected +9）**：

1. `CONFIG 全树递归 Object.isFrozen（沿用现有）且节点数下限改为按 src 文件数推导` —— **顺手修掉台账里那条老 Minor**：`config.test.js:39` 的 `visited.length >= 21` 在下一次加常量时不会报警，正是"脚本教错人"
2. `v1 存档迁移：新增位点用 rng(seed+id) 派生，两次迁移结果逐位相同`
3. `迁移不取默认值（构造两只旧个体，断言它们的新位点不全相等）`
4. `father 键在旧档非 null 时原样保留`
5. `heard 缺失时补空数组`
6. `catchphrase 缺失时按 id 派生且稳定`
7. `EGG_SIZE_BIAS === 0`（把裁定钉成测试，防止有人"顺手"调回 0.3）
8. `SPEECH_ONSCREEN_MAX === 2`（B 阶段的气泡排队依赖它）
9. `constraints：speech.js/lexicon.js 出现在扫描清单里且无禁用标识符`

**陷阱**：第 2/3 条是本次最容易做错的 —— 用默认值迁移会让所有旧个体性格趋同，而**这条错误不会有任何症状**，只有这两条测试能抓。

**提交**：`feat: 常量扩容、存档 v2 迁移与约束守卫扩展`

---

## Task A9：验收脚本升级（三条新判据）

**产出**：`tests/simulate.mjs` 判据改为：不爆缸、色相全程锁粉色区间（**不动**，裁定 1）、繁殖确实在发生、**+多样性**（色相方差 + 均值杂合度，正反两向）、**+漂入确实在发生**、**+出词确实在发生且分布随 `talk` 分化**。

**为什么第三条必须加**：否则整个语言层可以一行没实现而脚本全绿。这是"脚本不得教错人"的直接推论。

**Expected**：脚本无新增 `test()`（它不是 node:test 文件），但**必须实跑 4 个种子 × 60 分钟**并把输出贴进台账。跑法沿用 harness：`node tests/simulate.mjs --seed 999 --minutes 60`。

**提交**：`test: 验收脚本加三条判据（多样性、漂入、出词分布）`

---

# Phase B：表现层

B 阶段大部分从旧计划 `2026-10-20-living-tank.md` 搬，**下面只写搬什么、改什么**，不重复旧文档已经写对的内容：

| Task | 搬旧计划的 | 必须改的 |
|---|---|---|
| B10 静态服务与页面骨架 | 旧 Task 1 全部 | 无 |
| B11 主循环与倍速子步进 | 旧 Task 3 全部（含 1.6693% 偏差测试） | 无 |
| B12 星形软体 + 尾巴 | 旧 Task 2 的弹簧/控制点骨架 | **目标半径数组从圆改成五角星**（5 外角 + 5 内凹，`STAR_INNER_RATIO=0.62`）；加 3 段尾巴 Verlet 链；`fluff` 进 body 状态 |
| B13 桩 ctx + 水体层 | 旧 Task 4 全部 | 无 |
| B14 分层绘制 | 旧 Task 5/6/7 的 sprite 与分层框架 | **半透明凝胶 → 不透明填充**；新增第 7 层"毛尖碎边"（2 张预渲染 sprite + squash 矩阵，**不许每帧画贝塞尔**）；花纹 alpha 压到 0.35；发光核 → 透过毛的亮区 |
| B15 眼睛 | 旧 Task 6 的四参数 | 加**星星眼**（bliss）与**委屈眼**（sad）两个新形态；眨眼间隔 `BASE/(0.4+activity)` |
| B16 蹦跳/死亡/求关注 | 旧 Task 7 的死亡溶散 | 加 hop 的竖向 squash + 过冲；求关注升级链的可见表现 |
| B17 input 最小的手 | 旧 Task 8 全部（含 `HAND_SPEED_POKE` 实测重调） | 无 |
| B18 audio | 旧 Task 9 全部（音高随体型、音色随色相） | 加 hop 落地闷响、出词前导"啾"；**叫声与文字不许同步**（§5.4 纪律） |
| B19 气泡 + API 档 | — | 全新：同屏 ≤2 排队、3s 淡出、`main.js` 里的 `fetch` 装饰器 + 失败回落规则档 + **模型不许改世界** |
| B20 清单 + 性能 + 端到端 | 旧 Task 10 的框架 | 清单加 spec §8.2 新增的 8 项，**最后一项是关掉 `speech.enabled` 复跑全部** |

**旧计划里必须原样搬走的纪律**（这几条是实测换来的）：`world.playerHand` 是内核唯一接受表现层写入的字段；记录型桩 ctx 只数调用次数（因此"高光朝向"这类只能进手工清单）；手工清单每项注明"为什么自动化测不到"；性能不达标时的降级顺序（先砍光束摆动 → 再降碎边密度 → 最后才动尾巴）。

---

## 风险清单（这次最可能翻车的三处）

1. **A3 的杂合度判据可能测不过**。如果 `(1/2)^t` 的实测比值落在 0.35–0.65 之外（小样本 + 变异率 0.06 会抬高它），**先怀疑判据的容差定得太严，而不是急着改漂入频率** —— 把实测数字记进台账再决定。这是本轮唯一一处"理论值可能和实测对不上"的地方。
2. **A2 的大规模删测试容易过度清除**。`memory.test.js` 那 30 条 `kinship` 命中绝大多数要留。判据是"这条测的是**闸门**还是**关系**"：闸门删，关系留。
3. **B14 的毛绒性能**。2880 段贝塞尔/帧必崩，靠"只画毛尖碎边 + 2 张 sprite + squash 矩阵"救。若 B20 实测仍不达标，**降级顺序不许临场发挥**，按上面的顺序砍。

---

## 执行方式建议

**A1–A4 inline，A5–A9 与 B 阶段 subagent-driven。** 理由：A1–A4 是全链路 breaking 的改动（冻结数组、签名变更、33 条测试的删留判定），高度依赖上下文，派发时把判断标准讲不清就会做错；A5 之后每个 Task 的判据都是自足的，适合派发。派发时**必须把本 Task 的"陷阱"段原文带上** —— 那是唯一一处子代理自己想不出来的信息。

**每完成一个 Task**：跑 `node --test tests/`，把**实际**测试数（`grep -c '^test('` 数出来的）追加进 `.superpowers/sdd/progress.md`，格式沿用台账的 `Task N: complete (commits <base7>..<head7>, review clean)`。
