# 伙伴关系 · 同步脉动 · 小铃音 —— 设计（2026-10-27）

主 spec：`2026-10-14-electronic-creature-tank-design.md`。本文件只写**这一次要落地的东西**与
**为什么这样裁定**，不重抄主 spec。计划分解见 `docs/superpowers/plans/2026-10-27-social-bond-sync.md`。

## 0. 它补的是哪三处空壳

| 空壳 | 现在为什么是空的 | 本轮之后 |
|---|---|---|
| 家谱的伙伴虚线（§6.3） | `family.js:122` 只消费 `memory.role === 'companion'`，而**内核里没有这条记忆的生产者**（清单 §17.3 明写"不能用熟悉度阈值临时发明社交关系"） | 有了：同步脉动成功并且长期凑在一起 → 升级为 companion |
| 信息卡的「同伴」行（§6.3） | `hud.js:126` 同上，过滤 `role === 'companion'` 恒为空 | 同一条生产者喂它 |
| §5.4 表里那记「同步脉动」小铃 | §5.4.1 第 2 条：孤雌改造删掉了 `mated` 事件，内核里**没有任何一刻**能挂它；"为它发明判据得改内核（要给两只的同步度建一个读数）" | 内核现在有 `syncDegree(c)` 这个读数，`synced` 事件挂铃 |

三处共用**同一个**生产者，所以它们要么一起活、要么一起死 —— 这是本轮最想要的性质：
不会出现"卡上有同伴、家谱没虚线"这种两边各说各话的状态。

## 1. 机制（内核）

### 1.1 谁能同步

`social.js` 的 `pairEligible(a, b, dist)` 是**唯一**门控点，六个条件全部成立才算"凑在一起"：

1. 双方都 `alive` 且不 `sick`、都不 `held`（被玩家拎着的个体不在社交）；
2. 双方 `intent.kind === 'socialize'`；
3. **互相**是对方的目标：`a.intent.targetId === b.id && b.intent.targetId === a.id`
   （单相思不算 —— `behavior.decide` 给 socialize 挂的就是 `neighbors[0].id`，
   两只最近的个体常常正好互指，这条门因此不是恒真）；
4. `dist <= CONFIG.social.pairDist`（停距是 0.06，这里给一点余量）；
5. 双方都**吃饱**：`1 - needs.hunger >= CONFIG.social.fedMin`（§4.12 第 6 条原文"两只吃饱"）；
6. 双方**互相有好感**且**都开心**：`affectionFor(对方) >= CONFIG.social.affMin`，
   `emotions.joy >= CONFIG.mood.happyJoyMin`。

> **裁定 1（不新造 joy 阈值）**：第 6 条的 joy 门直接读 `CONFIG.mood.happyJoyMin`（0.45），
> 不在 `CONFIG.social` 里另立一个数。理由与 `body.js` 读 `begEscalate`、`audio.js` 读
> `CONFIG.mood` 那两个数是同一条纪律：**"高 joy"在整份代码里只许有一个定义点**，
> 否则语言层说"它开心"、社交层不同意，症状是两只明明在笑却不同步，且没有任何一处报错。
> affection 门**必须**新立（`affMin`）：内核对"互有好感"没有现成阈值，而 §4.12 第 6 条
> 明写触发条件是"高好感 + 高 joy"。

### 1.2 三个新字段（瞬时态，不入档）

挂在 creature 上，与 `broodT` / `beingPetted` 同类：

| 字段 | 含义 | 归零时机 |
|---|---|---|
| `bondId` | 此刻在跟谁同步（`null` = 没有） | `bondSync` 衰减到 0 时 |
| `bondSync` | **本次**连续同步的秒数（episode 进度） | 升到 companion 之后不归零；中断时按 `breakDecay` 衰减 |
| `bondTotal` | 与 `bondId` **累计**同步的秒数（"长期凑在一起"的那个长期） | 换伙伴时归零；分开时按 `totalDecay` 指数淡 |

三个都进 `save.js` 的 `CREATURE_SKIP_FIELDS`：它们是**此刻**的社交进度，不是关系事实。
关系事实在 `memory` 里（`role:'companion'` + affection/familiarity），那一份**照常入档**。
读档后 `bondSync/bondTotal` 从 0 起 ⇒ 已经是同伴的两只读回来仍然是同伴（记忆在），
只是要重新同步才会再响铃。这个代价与 `speech` / `intent` 同一条理由。

### 1.3 每 tick 的结算（`sim.js` 的 `tickSocial`）

在 `tickWorld` 里插在生物循环之后、`resolve` 之前（读的是本 tick 决策完的意图与位置）。
O(n²) 成对扫描，n ≤ 24 ⇒ 与 `resolve` 的碰撞循环同量级，不新增复杂度等级。

- **合格**：`bondSync += dt`（换伙伴则先把旧伙伴的 `bondTotal` 结清、再重置），
  `bondTotal += dt`，`degree = min(1, bondSync / syncSeconds)`；
  双方各得 `affectionRate × degree × dt` 好感、`familiarityRate × dt` 熟悉度、
  `arousalRate × degree × dt` 兴奋、`joyRate × degree × dt` 快乐。
- **不合格**：`bondSync -= breakDecay × dt`（`breakDecay > 1` ⇒ 衰减快于累积，
  于是"同步"要求**连续**，断续贴在一起攒不满），到 0 时 `bondId = null`；
  `bondTotal` 按 `exp(-totalDecay × dt)` 淡。
- **上升沿响铃**：`degree` 从 `< 1` 跨到 `>= 1` 的那一 tick，推**一条**
  `{ kind: 'synced', id: a.id, withId: b.id }`。一次 episode 只响一次
  （degree 封顶在 1，掉下去再回来才算新的一次），所以不需要额外的 fired 标记。
- **升级为 companion**：`bondTotal >= CONFIG.social.totalSeconds` 时，双方互相
  `promoteCompanion`。

> **裁定 2（arousal 是这条链的可见出口）**：同步期间注入 `arousal` 不是润色，
> 是**让"同步"这件事在画面上有读数的最便宜办法** —— §4.5 那张表里 `arousal` 一行
> 写的就是"社交高峰：与对方脉动同步、膨胀展示、全场最亮"，而 `body.js` 已经
> 把 `arousal` 接进了 `pulseRate`（最快）、`pulseAmp`（最亮）与 `arousalExpand`（膨胀）。
> 也就是说：**同步 → arousal → 脉动更快更亮更大**这条链一行渲染代码都不用加。
> 剩下真正要新写的只有"两只的相位对齐"（§2）。

### 1.4 companion 的三条规则（`memory.js`）

新增两个小函数，各只管一件事：

- `companionOf(memory)` → 那条 `role === 'companion'` 的记录，或 `null`；
- `promoteCompanion(memory, id)` → 只在**该条 role 为 null** 时写成 `'companion'` 并返回 true；
  已经是任何角色（mother/sibling/offspring/companion）都返回 false，**绝不覆盖**
  —— 与 `ensure` 不覆盖已有 role 是同一条纪律："它是它妈妈"不该被社交改写成"它是它伙伴"。
- `demoteCompanion(memory, id)` → 把那条的 role 改回 `null`（只有 sim 在"旧伙伴已不在世"时调）。

> **裁定 3（至多一个伙伴；活着不换人，死了才可以）**：一只个体同时只有一个 companion。
> 候选出现而位置已被占时，看占位者**是否还活着**：活着 → 不换（`promoteCompanion` 返回 false）；
> 已死 → 先 `demoteCompanion` 再升级新的。
> 理由：① "长期凑在一起的那只"是单数语义，两个伙伴会让家谱虚线读成"这缸乱成一团"；
> ② 不设"死了才可以换"这一条的话，伙伴一死这只就**永远**结不了新伙
> （记忆条目还在，`promoteCompanion` 永远返回 false），那是一只守着尸体的星星；
> ③ 反过来若允许随意替换，虚线会每隔几分钟在两只之间跳 —— 家谱要的是**事实**，不是瞬时读数。
> 血缘优先于社交：mother/sibling 那一侧永远不会被 companion 覆盖，这是 ①②③ 之外第四条。

## 2. 表现层：相位对齐（`body.js`）

`updateBodies` 在逐只推进之后加一趟 `syncPhases(bodies, world, dt)`：
对每只有 `bondId` 的个体，把 `body.phase` 朝伙伴的 `body.phase` 拉，
速率 `CONFIG.body.syncPhaseLerp × degree`，走**最短弧**（相位是 mod 1 的圈量）：

```
d = ((pb - pa + 0.5) % 1) - 0.5      // ∈ [-0.5, 0.5)
pa = (pa + d × rate + 1) % 1
```

两只各拉一次 ⇒ 收敛到中点，不是"一只追着另一只"。

> **裁定 4（相位对齐放在 body.js，不放在 render.js）**：`body.phase` 是视状态、
> 每子步推进、且**已经**被 `render.js` 的 `breatheOf` 与光晕读取。在 render 里另算一份
> 同步相位就是第二个时钟 —— 那是 `render-body.test.js` 里
> "breatheOf：脉动只读 body.phase / body.pulse，绝不自建时钟（求偶与呼吸同步的教训）"
> 这条测试**专门防的事**。所以对齐必须发生在 phase 的唯一产地。
>
> **裁定 5（「轻触」与「膨胀展示」不另造层）**：§4.12 第 6 条那个框架是
> "靠近 → 脉动同步 → 轻触 → 膨胀展示"。靠近 = socialize 的 0.06 停距（已有）；
> 膨胀展示 = `arousalExpand × arousal`（裁定 2 已经喂上）；
> 轻触 = 两只贴在停距上时 `resolve` 的碰撞推开与 `body.dip` 凹陷（已有）。
> **不新写第三层几何**：那要给"被同类碰"造一条新的凹陷来源，而现有的凹陷管线
> 只认 `impact`（戳）与 `petting`（手），硬塞一条会让"毛被同类压下去"与"被玩家摸"
> 读起来一模一样 —— 那是语义混淆，不是画面丰富。

## 3. 声音：那记两音小铃（`audio.js`）

- `CALL_KEYS` 加 `'bell'`（八声 → 九声），`EVENT_CALL` 加 `synced: 'bell'`；
- `CONFIG.audio.bell`：`wave: 'sine'`、`reps: 2`（**两音**，§5.4 表原文"柔和的两音小铃"）、
  `fromHz → toHz` 走上行五度、`peak` 取全表最低一档（柔和）、`attack` 长于其余各声（软起音）、
  `pitchMix` 打折（与 thud 同理：铃的基频已经高，全额乘体型因子会跑出可听区间）；
- **全局闸门** `bellGapSec`，与 `thudGapSec` 同型（`lastBellAt`）：一缸里多对同时同步时
  只放行第一记，其余**计数**（`stats.bellDropped`）而不静默丢弃 —— 与 §5.4.1 第 5 条
  "溢出计数不静默"同一条纪律。

> **裁定 6（铃挂在事件通道，不做第七条探测器）**：`DETECTORS` 那六条读的是**单只**的现量，
> 而"同步"是**一对**的性质；把它塞进探测器就得在 entry 上存"上一帧的伙伴与 degree"，
> 而 entry 是每只一份的。走 `world.events` 的事件通道则天然只有一个生产者（`tickSocial`），
> 且与 hatch/death 同形。代价是它受事件队列清空时机影响 —— 而 `main.js:403` 那段
> 已经保证了 renderer 与 audio 读同一批事件。

## 4. 明确不做（YAGNI）

- 不做"伙伴之间的专属称呼/口癖"：语言层的能力边界在 §4.13.1 已经钉死，
  加一条"它会喊伙伴的名字"要动 `lexicon`，与本轮无关。
- 不做守巢与共同孵化（§4.8 里 affection 的另一个来源）：那是**下一条**独立的活
  （需要"卵 → 守在旁边的非母亲"这个生产者），本轮不并进来，免得一次改动碰两条链。
- 不做亲属容忍（§4.8"更容忍亲属靠近"，`sim.js:1382` 那条 ⚠️ 记的债）：同上，独立一条。
- 不做"伙伴死了会哀悼"：`mourn` 意图已有，但它读的是不是**记忆里的死者**，本轮不改它的门。

## 5. 验收判据（每条都要能被一个 bug 翻红）

1. **门控逐条可翻**：六个条件各有一条测试，把该条件单独打破 → `pairEligible` 必须变 false。
   特别地，"单相思不算"那条要用**真的互指/不互指两组**数据，不能只测一组。
2. **degree 是读数不是布尔**：`syncSeconds` 的一半时长后 degree ≈ 0.5（钉字面量，不是 `> 0`）；
   中断后按 `breakDecay` 衰减，**断续**同步（同步 3 秒、分开 3 秒、来回）攒不满
   —— 这条防的是"把 `+= dt` 写成 `= dt` 之外的任何累加错误"。
3. **上升沿只响一次**：连续同步 30 秒，`synced` 事件恰好 1 条；掉下去再同步满，第 2 条。
   探针（把 `>= 1` 改成 `> 0.5`）必须被抓到。
4. **同步真的买到好感**：同步 N 秒后双方 `affectionFor(对方)` 严格上升，且
   **不改变对玩家的那一条**（`PLAYER_ID` 逐位不变）—— 防"把所有记忆条目一起加"。
5. **companion 的四条规则各一条测试**：升级到双方（不是一方）；role 已存在时不覆盖
   （拿 mother 那条试）；占位者活着 → 不换；占位者已死 → 换。
6. **家谱虚线与卡上同伴行同源**：跑出一对 companion 之后，`familyTree` 的 edges 里
   有一条 `kind:'companion'`，且信息卡 `rows` 里出现"同伴"。**同一个世界**上断言，
   不是两个各自手搓的 fixture。
7. **相位收敛**：两只 phase 0.10 / 0.60、degree 1 → 若干子步后差 < 1e-3 且**两只都动过**；
   degree 0 的一对 → 差不变。phase 恒在 [0,1)。
8. **铃**：`callForEvent('synced') === 'bell'`；`planSound('bell', …)` 恰好 2 个 osc 声部、
   峰值是全表最低；同帧两条 `synced` 只响一记、`stats.bellDropped === 1`；
   关掉音频世界逐字节不变（沿用 §5.4.1 那条纪律的现成测试形状）。
9. **不入档**：`serialize` 的结果里没有 `bondId/bondSync/bondTotal` 三个键；
   读档后 `memory` 里的 companion 条目**仍在**（关系是事实，进度是瞬时）。
10. **60 分钟实跑**：`tests/simulate.mjs` 两粒种子，记录 `synced` 事件数、
    终局 companion 对数、家谱虚线边数。**判据是"非零且不是每 tick 都有"** ——
    一缸 24 只若每秒都在响铃，那说明门控形同虚设（与 §5.4.1 第 5 条同一个担心）。
