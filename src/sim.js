// sim.js —— 无头世界编排器：唯一知道"世界"的模块。
//
// 它把前面九个**纯库**模块编排成一个可以脱离浏览器运行的模拟：
// 空间网格 → 感知 → 决策 → 行动执行 → 交互结算 → 死亡/哀悼 → 卵 → 事件队列。
// 计划 2 的 main.js 直接复用本模块，只在外面套一层渲染与输入；
// 所以这里不碰 DOM、不碰计时器、不做 I/O（由 tests/constraints.test.js 扫描保证）。
//
// 三条贯穿本模块的边界：
//
// 1. **固定步长由调用方负责。** tickWorld(world, dt) 只是把 dt 透传下去，
//    本模块**任何地方都不缩放 dt**：accumulator 与倍速（CONFIG.timeScales）
//    属于计划 2 的 main.js，且必须用**子步进**实现。
//    原因（计划「跨 Task / 跨计划交接要求」第 2 条）：emotions.update 是 brief 指定的
//    前向欧拉 k = min(1, inertia*dt)，刻意**不具**步长无关性 —— 4× 若靠放大 dt 实现，
//    1 模拟秒后的 joy 是 0.815836699487 而不是 0.802441461932（差值 1.6693%），
//    快进下的生物会与 1× 下不一样。这两个数被 tests/emotions.test.js 的特征化测试钉住。
//    本模块里的累加量（world.time / c.intentTime / c.mourn / c.dying / egg.age）
//    全是线性积分，天然与步长无关；**不要**把它们改成 (1 - rate*dt) 之类。
//
// 2. **world.events 是与表现层唯一的通道，且只写不读。**
//    内核往队列里 push，从不关心谁读、也不检查它是否被清空。
//    它是**一次性**事件（death / hatch / eat / mated / rejected / dissolved / eggFailed /
//    error），不是状态快照 —— 状态由 world 本身提供。消费方（计划 2）每帧取走后清空，
//    否则队列会无界增长（本模块不代为清理，因为"取走"这个动作只有消费方知道）。
//
// 3. **症状必须是可见的、而不是静默的。** 单只生物 tick 抛错时隔离它并记一条 error
//    （spec 7.7），而不是让世界崩掉、也不是把它悄悄从 creatures 里删掉：
//    表现层会画出一只变暗静止的个体，玩家看得见异常。同理，非法输入（未知食物种类）
//    抛 TypeError，而不是让它经原型链解析成一个 truthy 的函数、最后变成 NaN 需求。
import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { randomGenome } from './genes.js';
import { decay as decayNeeds, feed as feedNeeds, comfort } from './needs.js';
import { computeTargets, update as updateEmotions, applyEvent } from './emotions.js';
import {
  adjust as adjustMemory, decay as decayMemory, ensure as ensureMemory,
  PLAYER_ID, KINSHIP,
} from './memory.js';
import { createCreature, ageCreature, canBreed, sizeOf } from './creature.js';
import {
  courtshipScore, kinshipOf, startCourtship, tickCourtship, interruptCourtship,
  layEggs, tickEgg, hatch, registerKinship,
} from './breeding.js';
import { decide, EAT_DIST, HAND_SPEED_POKE } from './behavior.js';

// 与 needs / emotions / memory / behavior 里的同名函数同型：两个比较对 NaN 都是 false，
// 所以 NaN 会**原样穿过**。这里刻意不加逐调用的有限性守卫（60Hz × 24 只的热路径），
// 跨模块的 NaN 累积由 tests/sim.test.js 的收尾断言兜住（计划「跨 Task 交接要求」第 1 条），
// 而那一条断言**必须**把 Number.isFinite 放在范围比较之前 —— 否则 NaN 会被误报成"越界"。
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// 位置内缩一个 wallMargin：不内缩的话，表现层会把身体的一半画到缸壁外面。
const clampPos = (v) => (v < CONFIG.motion.wallMargin
  ? CONFIG.motion.wallMargin
  : v > 1 - CONFIG.motion.wallMargin ? 1 - CONFIG.motion.wallMargin : v);

// 食物 id 计数器。模块级可变状态，与 breeding.js 的 eggSeq 同型：
// 只生成唯一 id —— 不消费随机数、也不进任何数值计算，所以固定种子下的**世界状态**
// 与进程此前 spawnFood 过多少次无关。
// 唯一的例外是并列裁决：两份**距离完全相等**的食物会按 id 字典序排先后，
// 而 id 的绝对值取决于计数器的历史。这只在浮点距离恰好相等时才会触及，
// 且不改变任何世界状态（候选集合不变，只是 [0] 换成了另一个等距目标）。
let foodSeq = 0;

// 并列裁决：dist 相同时按 id 字典序。
//
// 不裁决的话，dist 相等的两个元素谁排前面就取决于**扫描顺序**：
// neighbors 走网格的 cx/cy 升序桶序，foods 走 world.foods 的数组插入序。
// 而 behavior 会直接读 foods[0] / neighbors[0] / threats[0]（behavior.js 里
// "依赖的是排序键（dist），不是并列时谁在前"针对的是评分，取目标点时仍读 [0]），
// 于是"谁最近"会随 addCreature / spawnFood 的先后而变，没有任何测试能看见。
// 按 id 裁决之后，顺序只由内容决定，与插入顺序、与坐标落在哪个格子都无关。
const byDistThenId = (a, b) => (a.dist - b.dist) || (a.id < b.id ? -1 : 1);

// ---------------------------------------------------------------- 求偶评分（世界层）

const byIdIn = (world) => (id) => world.creatures.find((x) => x.id === id) || null;

// 世界层面的求偶评分 = **谱系**近亲回避 + breeding 的 courtshipScore。
//
// 为什么要在 breeding 的记忆式判定（canCourt 读 kinshipBetween(memory, id)）之外
// 再加一道由 lineage 推出来的闸门：memory 是**有容量上限**的缓存，而 registerKinship
// 会给每一只同胞各写一条 familiarity 为 0 的条目；一窝超过 12 只时
// `prune` 按"familiarity 最低"淘汰，先被挤掉的正是这些亲属条目
// （实测：往一个空记忆里按 mother / father / 11 个 sibling 的顺序 ensure 13 条，
//   第 13 条一进来母亲那条就没了 —— memoryCapacity 是 12）。
// 缓存一丢，`kinship > 0.25` 的近亲回避就静默失效 —— 兄妹可以互相求偶产卵，全链路不报错。
// ⚠️ 这里原写着"实测：去掉这道闸门后，同胞之间在 200 秒里产下了 10 枚卵"，
// 但那个数字**无法从测试复现**：那条同胞测试只有一只母亲/父亲条目（远不到 12 条容量），
// 所以它根本没有走到淘汰路径，去掉闸门也不会产卵。
// 能复现的说法只有上面那条：往空记忆里 ensure 13 条会把最早写入的亲属条目挤掉
// （对应测试 '父母条目被容量淘汰后会被重新缓存回来' 里构造的前置条件）。
// 闸门本身的价值不依赖那个数字：只要缓存可能丢，把亲缘判定建立在**客观谱系**上就更稳。
// 亲缘是**客观事实**（breeding.kinshipOf 只读 lineage，与"它还记不记得"无关），
// 所以世界层用谱系来把关，不受缓存淘汰影响。阈值仍用 CONFIG.kinshipMateMax 与
// 严格 `>`：恰好 0.25 的祖孙/半同胞**不被**阻断（交接要求第 6 条）。
// 注意这只是补强：canCourt 的记忆判定原样保留，两者都只会让它更不可能求偶。
function mateScore(world, c, o, distance) {
  if (kinshipOf(c, o, byIdIn(world)) > CONFIG.kinshipMateMax) return 0;
  return courtshipScore(c, o, {
    population: aliveCreatures(world).length,
    populationCap: world.populationCap,
    distance,
  });
}

// ---------------------------------------------------------------- 世界构建

export function createWorld(opts) {
  const rng = createRng(opts.seed);
  const world = {
    seed: opts.seed,
    rng,
    time: 0,
    populationCap: opts.populationCap || CONFIG.populationCap.desktop,
    creatures: [],
    eggs: [],
    foods: [],
    grid: new Map(),
    playerHand: null,      // { pos, speed } | null —— 由计划 2 的 input 层写入
    stats: { births: 0, deaths: 0, hatchFailures: 0, generation: 1, rejected: 0 },
    events: [],
    nameFor: opts.nameFor || defaultNameFor,
  };

  // 初始光藻，避免新缸一开始就闹饥荒。
  // min(12, foodMax/3) = min(12, 13) = 12；写 foodMax 的比例而不是常数，
  // 是为了让 foodMax 调小时初始食物跟着缩，而不是把缸塞得比上限还满。
  const initialFood = Math.min(12, Math.floor(CONFIG.foodMax / 3));
  for (let i = 0; i < initialFood; i++) {
    spawnFood(world, 'algae', { x: rng.range(0.08, 0.92), y: rng.range(0.2, 0.95) });
  }

  // 初始 8 只亚成体（spec 9.1；2026-10-14 由 4 调到 8）：几分钟内就能看到第一次求偶，
  // 而不是让玩家对着空缸等。
  // ⚠️ 8 不是随手挑的，是量出来的：4 只创始个体下约 60% 的缸会在一小时内**整批灭绝**，
  //   机制是血统坍缩 —— 4 只创始 → 平均只有 7.00 位不同母亲 → 全缸变成单一亲缘组 →
  //   `kinship > 0.25` 的严格近亲回避把**每一对**都挡掉 → 出生冻结 → 整批老死。
  //   扫创始个体数（8 种子 × 60 分钟）：4→灭绝 5/8、8→3/8（母亲 10.13）、12→2/8（13.13），
  //   单调且恰好在实测存活门槛（母亲数 ≥ 10 全活、≤ 7 全灭）处转折。
  //   取 8 不取 12：12 只一开缸就占掉上限 24 的一半，挤掉下面那句"看得见长大"的余量。
  //   完整实测数据与被否决的调参路线见 CONFIG.initialCreatures 的注释。
  // age 落在 hatchling 结束之后、juvenile 区间中段（180 + 150 = 330），
  // 距离成体（480）还有 150 秒 —— 这正好是"看得见长大"的观察窗口。
  const count = opts.initialCreatures !== undefined ? opts.initialCreatures : CONFIG.initialCreatures;
  for (let i = 0; i < count; i++) {
    const genes = randomGenome(rng);
    addCreature(world, createCreature({
      id: `c-init-${i}`,
      name: world.nameFor(genes, i),
      x: rng.range(0.2, 0.8),
      y: rng.range(0.25, 0.75),
      age: CONFIG.stage.hatchling + CONFIG.stage.juvenile * 0.5,
      stage: 'juvenile',
      generation: 1,
      genes,
      rng,
    }));
  }

  return world;
}

// 默认命名：粉色系叠词 + 序号。计划 3 会用 names.js 替换它，
// 这里给一个够用的实现，避免内核依赖尚未存在的模块。
const NAME_SYLLABLES = ['泡泡', '团团', '蜜桃', '软软', '樱樱', '糯糯', '朵朵', '糖糖', '圆圆', '咕咕'];
function defaultNameFor(genes, index) {
  const base = NAME_SYLLABLES[index % NAME_SYLLABLES.length];
  return index < NAME_SYLLABLES.length ? base : `${base}·${Math.floor(index / NAME_SYLLABLES.length) + 1}`;
}

// 强制加入，**不检查 populationCap**：调用方只有 createWorld（初始投放）与
// tickEggs（孵化）。孵化那条路径的上限已经由 layEggs 用 `viable: false` 把过关了，
// 这里再查一次等于两个地方各自维护同一条规则，迟早打架。
// 由测试 'addCreature 是强制加入，上限由 layEggs 的 viable 标记把关' 钉住。
export function addCreature(world, c) {
  world.creatures.push(c);
  // 顺手重建网格。若不重建，任何**没跑过 tick** 就调 perceive 的调用方
  // 都会看到一个空 Map（perceive 只查网格、不做暴力遍历），于是"缸里只有我自己"。
  // 本文件的感知测试正是 addCreature 之后直接 perceive 的，实际踩到了这个坑：
  // 计划里那三条测试与 perceive 的网格实现互相矛盾，重建网格才让两边同时成立。
  // 代价是 O(n) 一次，而 addCreature 只在开缸与孵化时被调用（24 只的缸可以忽略）。
  rebuildGrid(world);
}

export function spawnFood(world, kind, pos) {
  // 未知食物种类必须抛错，不能静默接受（与 emotions.applyEvent 用 Object.hasOwn
  // 拒绝 'toString'、memory.ensure 拒绝未知 opts 键是同一条纪律）。
  // 为什么需要设防：`CONFIG.food` 是朴素对象字面量，`CONFIG.food['toString']` /
  // `['constructor']` / `['valueOf']` 经原型链解析成 **truthy 的函数**，于是
  // `if (!CONFIG.food[kind])` 这种写法拦不住它们（普通拼写错误如 'algai' 会解析成
  // undefined、反而拦得住）—— 一条撞上原型键的食物名会被当成合法食物收下。
  //
  // ⚠️ 这里**不能**照抄"于是 .energy 是 undefined → feedNeeds 得到 undefined →
  // 饥饿变 NaN"这条理由 —— 实测它是错的：needs.js 的 `feed(needs, amount =
  // CONFIG.needs.feedAmount)` 有默认参数，undefined 会落回默认份量 0.45，
  // 饥饿**不会**变成 NaN（本文件曾按那条理由写过注释，已按实测更正：
  // 让一只饥饿 0.9153 的生物吃掉 kind = 'toString' 的食物后，实测饥饿 = 0.4653 =
  // 0.9153 − 0.45，即**静默按默认份量**生效）。真实后果就是这个**静默喂错份量**，
  // 外加 eat 事件里带着 foodKind = 'toString' 这种原型键名送给表现层。
  // spawnFood 是导出函数，也是 Plan 3 玩家投喂 UI 的天然入口，必须设防。
  if (!Object.hasOwn(CONFIG.food, kind)) {
    throw new TypeError(
      `未知食物种类: ${String(kind)}（只接受 ${Object.keys(CONFIG.food).join(' / ')}）`,
    );
  }
  foodSeq += 1;
  const food = {
    id: `f${foodSeq}`,
    kind,
    pos: { x: clamp01(pos.x), y: clamp01(pos.y) },
    amount: 1,
  };
  world.foods.push(food);
  return food;
}

export function aliveCreatures(world) {
  return world.creatures.filter((c) => c.alive);
}

export function worldStats(world) {
  return {
    time: world.time,
    population: world.creatures.length,
    alive: aliveCreatures(world).length,
    eggs: world.eggs.length,
    foods: world.foods.length,
    births: world.stats.births,
    deaths: world.stats.deaths,
    generation: world.stats.generation,
    hatchFailures: world.stats.hatchFailures,
    rejected: world.stats.rejected,
  };
}

// ---------------------------------------------------------------- 空间网格

// 均匀网格把感知从 O(n²) 降到接近 O(n)（spec 3.4 第 4 条）。
// 每 tick 重建一次，而不是增量维护：24 只个体的重建成本远低于维护增量更新的复杂度，
// 而且不会有"忘记更新网格"导致的幽灵邻居 bug。
//
// 代价是**一 tick 的位置滞后**：tickWorld 在行动之前建网格，所以本 tick 里
// 每只生物感知到的是邻居在 tick 开始时的位置。位移上限是
// baseSpeed × fleeFactor × dt ≈ 0.055 × 2.2 / 60 ≈ 0.002（碰撞推开最多约 0.019），
// 远小于 gridCell 0.1；且 perceive 仍会按**当前位置**复核距离，所以滞后只会
// 表现为"极少数跨格瞬间的邻居晚一 tick 才出现"，不会凭空多出幽灵邻居。
const CELL = CONFIG.gridCell;

function cellKey(cx, cy) {
  return cx + ',' + cy;
}

function rebuildGrid(world) {
  world.grid.clear();
  for (let i = 0; i < world.creatures.length; i++) {
    const c = world.creatures[i];
    if (!c.alive) continue;
    const key = cellKey(Math.floor(c.pos.x / CELL), Math.floor(c.pos.y / CELL));
    let bucket = world.grid.get(key);
    if (!bucket) { bucket = []; world.grid.set(key, bucket); }
    bucket.push(i);
  }
}

// 查询以 (x, y) 为中心、半径 r 内的所有个体下标。
// 扫描覆盖该圆的所有格子（floor((x-r)/CELL) 到 floor((x+r)/CELL) 全闭），
// 因此不可能漏掉跨格子的近邻 —— 由测试
// '网格查询结果与暴力遍历一致（空间网格不能漏掉邻居）' 与暴力遍历逐只对照。
function queryGrid(world, x, y, r) {
  const out = [];
  const minCx = Math.floor((x - r) / CELL);
  const maxCx = Math.floor((x + r) / CELL);
  const minCy = Math.floor((y - r) / CELL);
  const maxCy = Math.floor((y + r) / CELL);
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = world.grid.get(cellKey(cx, cy));
      if (bucket) for (const i of bucket) out.push(i);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 感知

export function perceive(world, c) {
  const R = CONFIG.perceiveRadius;
  const neighbors = [];
  const threats = [];

  for (const i of queryGrid(world, c.pos.x, c.pos.y, R)) {
    const o = world.creatures[i];
    if (o === c || !o.alive) continue;
    // 网格是按 tick 开头的位置建的，所以这里必须用当前位置复核距离：
    // 网格只负责"圈定候选"，判定始终以调用时刻的真实位置为准。
    const d = Math.hypot(o.pos.x - c.pos.x, o.pos.y - c.pos.y);
    if (d > R) continue;
    neighbors.push({
      id: o.id, pos: o.pos, dist: d,
      size: sizeOf(o), stage: o.stage, alive: o.alive,
      anger: o.emotions.anger,
    });
    // 威胁：明显更大且正在生气。
    // 1.35 这个倍数与 behavior 里 fight 的 1.25 倍**不是同一个判定**，两者各自独立：
    //   本处 1.35 只决定"它看起来有威胁"（喂给 flee 与逃跑方向的选择）；
    //   fight 的 1.25 在 behavior.scoreAll 里读 provoker.size（由 provokerId 选中，
    //   规则是 anger > 0.5 && dist < 0.08），决定"真打起来打不打得过"。
    if (sizeOf(o) > sizeOf(c) * 1.35 && o.emotions.anger > 0.4) {
      threats.push({ id: o.id, pos: o.pos, dist: d });
    }
  }
  neighbors.sort(byDistThenId);
  threats.sort(byDistThenId);

  const foods = [];
  for (const f of world.foods) {
    const d = Math.hypot(f.pos.x - c.pos.x, f.pos.y - c.pos.y);
    if (d <= R) foods.push({ id: f.id, kind: f.kind, pos: f.pos, dist: d });
  }
  foods.sort(byDistThenId);

  let playerHand = null;
  if (world.playerHand) {
    const d = Math.hypot(world.playerHand.pos.x - c.pos.x, world.playerHand.pos.y - c.pos.y);
    // 手比同类更"显眼"：感知半径放宽到 1.5 倍，好让玩家一伸手就有反应。
    if (d <= R * 1.5) {
      playerHand = { pos: world.playerHand.pos, dist: d, speed: world.playerHand.speed };
    }
  }

  // 求偶候选：分数由 mateScore（谱系闸门 + breeding 的 courtshipScore）预算，
  // behavior 只读这个数字（behavior 刻意不 import breeding，见 behavior.js 文件头）。
  // 分数里已经包含了种群上限的压制：crowding 这一项的下限是 0.12，**永不为 0** ——
  // 所以上限本身不会把评分归零，它只会让求偶变得稀少（归零只来自与上限无关的闸门：
  // 亲缘 > 0.25、意愿不足、好感过低）。这就是 spec 4.12 第 6 条要的"压低而非硬阻断"。
  // 候选列表对每个邻居都给一项，不可行的给 0 分而不是从列表里剔掉；
  // behavior 用 `bestSuitor.score > 0` 判可行性，列表长度本身不承载语义
  // （空列表会让 bestSuitor 为 null，同样得到 court = 0）。
  const atCap = aliveCreatures(world).length >= world.populationCap;
  const courtshipOptions = [];
  for (const n of neighbors) {
    const o = world.creatures.find((x) => x.id === n.id);
    if (!o) continue;
    courtshipOptions.push({
      id: n.id,
      dist: n.dist,
      score: mateScore(world, c, o, n.dist),
    });
  }

  // provoker：最近那个也在生气、且离得很近的邻居。
  // behavior 用它决定 protest / fight 的目标（筛选标准只在 perceive 里定义一处）。
  const provoker = neighbors.find((n) => n.anger > 0.5 && n.dist < 0.08);

  return {
    foods, neighbors, threats, playerHand, courtshipOptions,
    provokerId: provoker ? provoker.id : null,
    // population / populationCap / atPopulationCap 目前**没有**生产代码里的消费者：
    // 种群上限的效果全部经由 courtshipOptions[].score 传导（见上），
    // 所以 behavior 不需要读它们。留着是给计划 2/3 的表现层与调试面板用的只读诊断读数
    // （例如显示"24/24"或给 UI 一个"缸满了"的提示）。**不要**在 behavior 里
    // 把它们接成条件门控 —— 那就成了 spec 4.12 第 6 条禁止的硬阻断。
    population: aliveCreatures(world).length,
    populationCap: world.populationCap,
    atPopulationCap: atCap,
  };
}

// ---------------------------------------------------------------- 情绪情境

function emotionCtx(c, senses) {
  const hand = senses.playerHand;
  const threat = senses.threats[0];
  return {
    // 进食中的愉悦最强；有同伴次之；独处时给一点基础值，
    // 免得"什么都不发生"的生物永远 joy=0 而显得死气沉沉。
    pleasure: c.intent && c.intent.kind === 'eat'
      ? 0.8
      : (senses.neighbors.length > 0 ? 0.25 : 0.08),
    provocation: senses.provokerId ? 0.6 : 0,
    threat: threat
      ? clamp01(0.5 + (0.2 - threat.dist))
      // 粗暴的手直接算威胁（速度阈值与 behavior 里的 handIsRough 是同一个常量 ——
      // 一个速度算"戳"的自相矛盾会让"温柔让它认识你"与"粗暴让它害怕"同时失效）。
      : (hand && hand.speed > HAND_SPEED_POKE ? 0.5 : 0),
    novelty: hand ? 0.6 : (senses.foods.length ? 0.25 : 0.1),
    // arousal 的开关**只看阶段**（canBreed：成体、活着、不 sick），
    // 刻意**不**再要求"已经有合法求偶对象"。
    // 为什么：这个情境是 emotions.computeTargets 里 arousal 的一票门控，
    // 而 courtshipScore 又要求双方 arousal >= 0.35 —— 若这里也要求
    // `courtshipOptions.some(score > 0)`，两者互为前提，arousal 会永远停在 0：
    // 全缸不求偶、没有后代，且不报错、不抛异常，症状只是"这个缸不生"。
    // emotions.js 的模块说明也是这个意思：这门控是为了"亚成体与老年个体不该有求偶欲"。
    canBreed: canBreed(c),
  };
}

// ---------------------------------------------------------------- 行动执行

function executeIntent(world, c, senses, dt) {
  const intent = c.intent;
  c.moving = false;
  c.resting = false;

  if (!intent) return;

  const stageFactor = CONFIG.motion.stageFactor[c.stage] || 1;
  let speedFactor = stageFactor;
  // 幼态的笨拙（spec 4.7）：幼体与亚成体偶尔冲过头，靠速度上的轻微随机抖动实现
  if (c.stage === 'hatchling' || c.stage === 'juvenile') {
    speedFactor *= 0.85 + world.rng.range(0, 0.3);
  }
  if (intent.kind === 'flee') speedFactor *= CONFIG.motion.fleeFactor;
  if (c.courtship) speedFactor *= CONFIG.motion.courtshipFactor;
  if (c.mourn > 0 && intent.kind === 'mourn') speedFactor *= 0.1;   // 哀悼 = 几乎静止

  switch (intent.kind) {
    case 'rest':
    case 'mourn':
    case 'idle':
      c.resting = intent.kind === 'rest';
      // 休息时缓慢下沉到缸底（每秒 1.2% 世界高度）。
      // 写成 "速率 × dt" 而不是 "每帧位移" —— 后者会让 120Hz 的手机下沉得比 60Hz 快一倍。
      if (c.resting) c.pos.y = clampPos(c.pos.y + 0.012 * dt);
      break;

    case 'eat': {
      const f = world.foods.find((x) => x.id === intent.targetId);
      if (!f) { c.intent = null; break; }
      const d = Math.hypot(f.pos.x - c.pos.x, f.pos.y - c.pos.y);
      // 与 behavior.scoreAll 的 eat 门槛是**同一个常量**（EAT_DIST）：
      // 两处若漂移，就会出现"选了 eat 却吃不到"的死循环 —— 生物贴着一份光藻饿死。
      if (d < EAT_DIST) {
        feedNeeds(c.needs, CONFIG.food[f.kind].energy);
        applyEvent(c.emotions, 'fed');
        // 冰晶的安抚：需求侧走 comfort，情绪侧直接压 anger/fear
        if (CONFIG.food[f.kind].calms) {
          comfort(c.needs, CONFIG.food[f.kind].calms);
          c.emotions.anger = clamp01(c.emotions.anger - CONFIG.food[f.kind].calms);
          c.emotions.fear = clamp01(c.emotions.fear - CONFIG.food[f.kind].calms);
        }
        world.events.push({ kind: 'eat', id: c.id, foodId: f.id, foodKind: f.kind });
        const idx = world.foods.indexOf(f);
        if (idx >= 0) world.foods.splice(idx, 1);
        c.intent = null;      // 吃完了，下一步重新决策
      } else {
        moveToward(c, f.pos, dt, speedFactor);
      }
      break;
    }

    case 'forage': {
      const f = world.foods.find((x) => x.id === intent.targetId);
      // 目标食物被别的个体吃掉了：本次意图作废，下一 tick 重新决策
      if (!f) { c.intent = null; break; }
      moveToward(c, f.pos, dt, speedFactor);
      break;
    }

    case 'socialize':
    case 'protest':
    case 'fight':
    case 'beg': {
      const target = intent.targetPos
        || (intent.targetId ? (world.creatures.find((x) => x.id === intent.targetId) || {}).pos : null);
      if (!target) { c.intent = null; break; }
      // 社交保持一点距离，不要完全重叠；抗议/争斗则要贴上去
      const stopDist = intent.kind === 'socialize' ? 0.06 : 0.03;
      const d = Math.hypot(target.x - c.pos.x, target.y - c.pos.y);
      if (d > stopDist) moveToward(c, target, dt, speedFactor);
      if (intent.kind === 'beg' && senses.playerHand) {
        // 卖萌：蹭玩家的手，累积好感（spec 6.1）。
        // 这里给的是**好感**（affection），而"认识你"（familiarity）在 tickCreature 里给 ——
        // 两条必须分开：光把手放那儿只能买到熟悉度，否则卖萌会退化成挂机计时器。
        adjustMemory(c.memory, PLAYER_ID, 0.02 * dt, 0.03 * dt);
        c.emotions.joy = clamp01(c.emotions.joy + 0.1 * dt);
      }
      break;
    }
    case 'explore':
    case 'flee':
      if (intent.targetPos) moveToward(c, intent.targetPos, dt, speedFactor);
      break;

    case 'court': {
      // 求偶的编舞由 breeding 的 phase 驱动（绕圈/脉动同步/轻触/膨胀展示）。
      // 内核只负责让双方靠近并维持仪式；具体的圆圈轨迹在计划 2 的表现层实现。
      const partner = world.creatures.find((x) => x.id === intent.targetId);
      if (!partner || !partner.alive) { interruptCourtship(c); c.intent = null; break; }
      if (!c.courtship) {
        const d = Math.hypot(partner.pos.x - c.pos.x, partner.pos.y - c.pos.y);
        // 回到求偶范围内才起仪式；分数为 0（近亲、意愿不足、好感过低等）就不起，
        // 继续靠近。这里与 perceive 用**同一个** mateScore ——
        // 只在一处设闸会让另一条路径绕过它（perceive 挡住了但这里放行，就会真的产卵）。
        if (d < CONFIG.courtshipRange && mateScore(world, c, partner, d) > 0) {
          startCourtship(c, partner, world.rng);
        } else {
          moveToward(c, partner.pos, dt, speedFactor);
        }
      } else {
        moveToward(c, partner.pos, dt, speedFactor * 0.6);
      }
      break;
    }

    default:
      break;
  }
}

function moveToward(c, target, dt, speedFactor) {
  const speed = CONFIG.motion.baseSpeed * speedFactor;
  let dx = target.x - c.pos.x;
  let dy = target.y - c.pos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  dx /= len;
  dy /= len;
  c.pos.x = clampPos(c.pos.x + dx * speed * dt);
  c.pos.y = clampPos(c.pos.y + dy * speed * dt);
  c.vel.x = dx * speed;
  c.vel.y = dy * speed;
  c.moving = true;

  // 朝向平滑转向（spec 4.6）：不是瞬间掉头，转向速率还受 bold 调制 ——
  // 胆大的转身果断（personality 里 turnRate = 2 + bold*4），胆小的迟疑。
  // 转向系数因此落在 [3, 9] × dt：60Hz 下每帧把朝向往目标方向推 5%~15%，
  // 再重新归一化，于是朝向永远是单位向量（不会因为插值而缩短）。
  const rate = Math.min(1, (CONFIG.motion.facingLerp * (c.thresholds.turnRate / 4)) * dt);
  const fx = c.facing.x + (dx - c.facing.x) * rate;
  const fy = c.facing.y + (dy - c.facing.y) * rate;
  const flen = Math.hypot(fx, fy) || 1;
  c.facing.x = fx / flen;
  c.facing.y = fy / flen;
}

// ---------------------------------------------------------------- 单只 tick

function tickCreature(world, c, dt) {
  decayMemory(c.memory, dt);

  const senses = perceive(world, c);

  c.intentTime += dt;

  // 求偶仪式进行中：锁定 court 意图，完全不重新决策。
  //
  // 这不是优化，是必需的正确性修复。canCourt 要求 `!a.courtship`，
  // 所以仪式一旦开始，courtshipScore 对这一对就返回 0 —— 若此时照常重新决策，
  // court 候选的分数归零，两只会各自游开，仪式在半路上散掉。
  // 表现层（计划 2）会看到它们本该绕圈共舞却越走越远。
  if (c.courtship) {
    c.intent = {
      kind: 'court',
      targetId: c.courtship.partnerId,
      minDuration: c.courtship.duration,
    };
    c.intentTime = 0;
  } else if (!c.intent || c.intentTime >= c.intent.minDuration) {
    // 行为有最小持续时间，防止每帧重新决策导致的高频抖动（spec 4.10）。
    //
    // 语义**就是"至少保持 minDuration，然后重新决策一次"**：重新决策时一律
    // 换上新的意图对象并把计时器归零，而不是只在 kind 变化时才归零。
    // 只在 kind 变化时归零会同时坏掉两件事（都由 tests/sim.test.js 的
    // '同一意图反复胜出时…' 钉住）：
    //   · 同一个 kind 连着胜出时 intentTime 一路累加，比较恒真 ⇒ decide() 变成
    //     **每帧**都跑（探针实测：去掉归零后 intentTime 会越过 minDuration，
    //     2.05 > 2.04），而 decide 每次调用都给 12 个候选重抽一遍 ±12% 的噪声 ——
    //     势均力敌时相邻两帧可以直接翻盘（把 explore 调到与 idle 的 0.12 完全相等后
    //     实测翻盘率 1002/1999 = 50.1%），本该防抖的机制反而成了抖动的来源；
    //   · 同一 kind 再次胜出时丢掉 decide 的新目标点（intent 对象没被替换）⇒
    //     只要 explore 一直胜出，它走到那个点后就原地不动；beg 会一直追着
    //     一个早已移开的手的位置（beg 的目标是 intent.targetPos 快照）。
    // 归零后重新决策的节奏被限制在"每个 minDuration 一次"，与 spec 4.10 一致。
    const next = decide(c, senses, world.rng);
    c.intent = next;
    c.intentTime = 0;
  }

  executeIntent(world, c, senses, dt);

  // 温柔的手停在附近 → 它注意到你了：familiarity 上升，affection 不动。
  //
  // 这一小段是 behavior 里 beg 门槛能打开的唯一来源（见 Task 9 的注释与 behavior.js
  // 对 beg 的说明）：beg 要求 `affection > 0.1 || familiarity > 0.3`，
  // 而内核里 affection 只有 beg 自己会累积、familiarity 只有这一段会累积 ——
  // 少了它，卖萌永远不可能被触发（它因为不认识你所以不撒娇，因为不撒娇所以永远不认识你）。
  //
  // 刻意只给"认识"不给"喜欢"：喜欢必须由计划 3 的抚摸输入买来。
  // 光是把手放在那儿就能刷好感的话，卖萌会退化成一个挂机计时器，
  // 而 spec 6.1 的整个要点是"温柔与否有区别"。
  // 速度阈值与 behavior 的 handIsRough、emotionCtx 的 threat 共用 HAND_SPEED_POKE。
  if (senses.playerHand && senses.playerHand.speed <= HAND_SPEED_POKE
      && senses.playerHand.dist < CONFIG.perceiveRadius * 0.5) {
    adjustMemory(c.memory, PLAYER_ID, 0, 0.04 * dt);
  }

  decayNeeds(c.needs, dt, c.traits, {
    moving: c.moving,
    resting: c.resting,
    companions: senses.neighbors.length,
  });

  updateEmotions(c.emotions, computeTargets(c.needs, emotionCtx(c, senses), c.traits), dt);

  // 求偶仪式推进。
  //
  // tickCourtship 在返回 'complete' 的同时会把 c.courtship 置为 null
  // （这是它防止同一场仪式被完成两次的机制）。但 resolve() 需要知道
  // "刚才是和谁完成的"才能配对产卵，所以必须在清空之前把 partnerId 抄下来。
  // 漏掉这一行，求偶永远完成不了、永远不会产卵。
  if (c.courtship) {
    c.courtshipPartnerId = c.courtship.partnerId;
    if (tickCourtship(c, dt) === 'complete') c.courtshipCompleted = true;
  } else {
    c.courtshipCompleted = false;
    c.courtshipPartnerId = null;
  }

  if (c.mourn > 0) c.mourn = Math.max(0, c.mourn - dt);

  ageCreature(c, dt);
  // 死亡闸门。ageCreature 在判定死亡的那一次调用里把 dying 写成哨兵值（1e-6 > 0），
  // 所以这道闸门**只在同一 tick 内刚死掉的个体**上为真，onDeath 恰好跑一次。
  // 它不会在读档时重放：tickWorld 的循环在调用 tickCreature 之前就 `continue` 掉了
  // 所有 !alive 的个体，已经死掉的个体根本走不到这里。
  // 之后的尸体溶散由 reapDead 独立负责（c.dying += dt），与这道闸门无关。
  if (!c.alive && c.dying > 0 && !c.deathHandled) {
    c.deathHandled = true;
    onDeath(world, c);
  }
}

// ---------------------------------------------------------------- 死亡与哀悼

function onDeath(world, c) {
  world.stats.deaths += 1;
  world.events.push({ kind: 'death', id: c.id, pos: { ...c.pos }, name: c.name });

  // 不解释、不提示 —— 这是给看得懂的人的。
  //
  // 规则刻意**不**按年龄或阶段过滤：spec 4.11 的原话是"死亡时，附近的个体会停顿、
  // 变暗一小会儿"，没有任何年龄限定，所以 mournRadius 内的每个活着的个体都会哀悼，
  // 幼体也一样。这里只排除死者自己（它已经 alive=false，本来也不在 aliveCreatures 里，
  // 这个判断是防御性的）。
  for (const o of aliveCreatures(world)) {
    if (o === c) continue;
    if (Math.hypot(o.pos.x - c.pos.x, o.pos.y - c.pos.y) <= CONFIG.mournRadius) {
      o.mourn = CONFIG.mournDuration;
      applyEvent(o.emotions, 'death');
    }
  }
}

// 尸体溶散：与死亡闸门完全独立的一条路径。
// 它对**所有** alive=false 的个体累加 dying（无论 onDeath 是否在本进程里跑过），
// 因此读档进来的尸体也会被正常清掉；用 `>=` 与 dissolveDuration 比较，
// 哨兵值 1e-6 只贡献一个可以忽略的起始偏移（由测试
// '溶散动画的时长由 dying 哨兵值决定' 钉住这个数量级关系）。
function reapDead(world, dt) {
  for (let i = world.creatures.length - 1; i >= 0; i--) {
    const c = world.creatures[i];
    if (c.alive) continue;
    c.dying += dt;
    if (c.dying >= CONFIG.dissolveDuration) {
      world.creatures.splice(i, 1);
      world.events.push({ kind: 'dissolved', id: c.id });
    }
  }
}

// ---------------------------------------------------------------- 卵

function tickEggs(world, dt) {
  for (let i = world.eggs.length - 1; i >= 0; i--) {
    const egg = world.eggs[i];
    const result = tickEgg(egg, dt);

    if (result === 'failed') {
      // 卵的光慢慢熄灭（spec 4.12 第 6 条）—— 不是立刻消失，而是先变得不可孵化，
      // 再过一会儿才安静地散去。两个阶段共用一个 age：
      //   age < 3×egg  → 只计入一次失败（failCounted 去重，否则每 tick 记一次）
      //   age >= 3×egg → 从世界移除并发出 eggFailed
      // 注意：不可孵化的卵**仍然**走 tickEgg 的 age 累加，所以"光熄灭"的时长
      // 用的是同一根时间轴，不会因为没在孵化而停住。
      if (egg.age >= CONFIG.stage.egg * 3) {
        world.eggs.splice(i, 1);
        world.events.push({ kind: 'eggFailed', id: egg.id, pos: { ...egg.pos } });
      } else if (!egg.failCounted) {
        egg.failCounted = true;
        world.stats.hatchFailures += 1;
      }
      continue;
    }

    if (result === 'ready') {
      // ⚠️ 到期的卵在孵化前必须**再判一次**容量。
      //
      // 为什么：`addCreature` 是强制加入、不查上限（Task 10 的测试
      // 'addCreature 是强制加入，上限由 layEggs 的 viable 标记把关' 钉住了这一点），
      // 而 layEggs 的 viable 是在**产卵那一刻**判的 —— 卵要 60 秒才孵化，
      // 这 60 秒里种群完全可能从"未满"变成"已满"。缺了这道闸门，
      // 到期卵就会一路孵进一个已经满员的缸。
      // 实测后果（诊断脚本，4 个种子 × 45 分钟，上限 24）：峰值 **52 / 47 / 30 / 29**，
      // 即种群冲到上限的两倍以上；加上这道闸门后同口径实测 **0/12 个种子超上限**，
      // 峰值一律恰好等于 24。这是这道闸门存在的全部理由 —— 它修的是**超上限**，不是灭绝。
      //
      // 为什么是"等"而不是"当场判死"：这枚卵是在**未满**时合法产下的，
      // 只是孵化时赶上了满员；立刻判死等于让一次时序竞态去惩罚一次合法繁殖。
      // 所以给它一段宽限：位置一空就孵。等待**有界** —— 超过 3×egg 这根既有的
      // 时间轴（与不可孵化卵共用同一条"光慢慢熄灭"的曲线）就散去，
      // 免得满员期间卵无界堆积。失败只在散去那一刻记一次（splice 之后不会再见到这枚卵，
      // 所以这里不需要 failCounted 去重；等待期间反复计数会让"孵化失败"变成 tick 数的函数）。
      //
      // 📌 控制方裁定（实测否决，记录以免重推）：spec 4.12 第 6 条的字面语义是
      // "达上限时卵**孵化失败**"，据此曾把容量判定整个移到孵化时 ——
      // layEggs 一律产出 viable 卵，由这里排队等位置。实测**更差**：
      // 同 8 个种子 × 60 分钟，灭绝 4/8 → **5/8**；seed 20261014 从
      // "存活满 60 分钟、出生 72、母亲 12、世代 6" 退化成 "2102s 灭绝、出生 24、母亲 3"。
      // 机制：排队让腾出的位置被立刻补上 ⇒ 种群长期钉死在上限 ⇒ 血统停止更新；
      // 而产卵时判死反而靠"卵全灭 → 种群跌破上限 → crowding 松绑 → 重新繁殖"的
      // 振荡维持了多条血统。所以这里**只**保留"防超上限"的有界等待，
      // 容量的主判定仍留在 layEggs（viable=false，走 failed 路径）。
      if (aliveCreatures(world).length >= world.populationCap) {
        if (egg.age >= CONFIG.stage.egg * 3) {
          world.eggs.splice(i, 1);
          world.stats.hatchFailures += 1;
          world.events.push({ kind: 'eggFailed', id: egg.id, pos: { ...egg.pos } });
        }
        continue;                     // 位置不够：这枚卵保持 ready，下一 tick 再试
      }
      const mother = world.creatures.find((x) => x.id === egg.motherId);
      const father = world.creatures.find((x) => x.id === egg.fatherId);
      // 世代取双亲里更高的那一代 +1，而不是只看母亲：
      // 一方缺记录时（读档、或亲代已溶散）也能给出合理的世代号。
      const generation = Math.max(
        (mother ? mother.generation : 0) + 1,
        (father ? father.generation : 0) + 1,
      );
      const baby = hatch(egg, world.rng, { nameFor: world.nameFor, generation });
      addCreature(world, baby);
      world.stats.births += 1;
      world.stats.generation = Math.max(world.stats.generation, generation);
      world.events.push({ kind: 'hatch', id: baby.id, pos: { ...baby.pos }, eggId: egg.id });

      // 父母侧的关系记忆与家谱由世界写回 ——
      // breeding.hatch 不持有世界，拿不到父母对象（见 Task 8 的设计说明）。
      if (mother) {
        ensureMemory(mother.memory, baby.id, { kinship: KINSHIP.offspring, role: 'offspring' });
        if (!mother.lineage.offspring.includes(baby.id)) mother.lineage.offspring.push(baby.id);
      }
      if (father) {
        ensureMemory(father.memory, baby.id, { kinship: KINSHIP.offspring, role: 'offspring' });
        if (!father.lineage.offspring.includes(baby.id)) father.lineage.offspring.push(baby.id);
      }

      // 亲缘写进**双方**记忆（交接要求第 5 条）。
      // 上面只处理了父母 ← 雏体这一个方向，而**同胞与祖孙此前没有任何代码登记**：
      // memory[兄弟姐妹].kinship 恒为 0，于是 `kinship > 0.25` 的近亲回避永不触发
      // —— 兄妹可以互相求偶，全链路不报错。这里按谱系统一补齐。
      // registerKinship 对每个有亲缘的个体用 ensure 的写入路径（对方 id 是新键），
      // 已存在的母子/父子条目因 ensure 幂等而保持原值，不会互相覆盖。
      registerKinship(baby, world.creatures,
        (id) => world.creatures.find((x) => x.id === id) || null);

      world.eggs.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- 交互结算

function resolve(world, dt) {
  const alive = aliveCreatures(world);

  // 求偶完成：双方都在同一 tick 标记完成才算成功。
  // 单方完成（对方被打断/死亡）则视为被拒绝，触发 rejected 事件。
  const completed = alive.filter((c) => c.courtshipCompleted);
  const paired = new Set();
  for (const a of completed) {
    const partner = alive.find((x) => x.id === a.courtshipPartnerId && x.courtshipCompleted);
    if (partner && !paired.has(a.id) && !paired.has(partner.id)) {
      paired.add(a.id);
      paired.add(partner.id);
      // 上限在这里体现为"卵不可孵化"（layEggs 的 viable=false），
      // 而不是"不许产卵"。用 >= 判断，且**没有**任何 `> cap` 的拒绝分支：
      // 满员时照样求偶、照样产卵，只是那些卵的光会慢慢熄灭 ——
      // 于是"缸满了"是一件**能被看见的事**（卵在缸底暗下去），而不是一条静默的禁令。
      // ⚠️ 控制方曾把这道判定从"产卵时"移到"孵化时"（卵改为一律 viable，
      // 由 tickEggs 排队等位置），理由是 spec 4.12 第 6 条的字面语义是"达上限时卵**孵化失败**"。
      // 实测**否决**了这个改动（diag-hatchgate.mjs / diag-crowding.mjs，同 8 个种子 × 60 分钟）：
      // 灭绝 4/8 → **5/8**，且 seed 20261014 从"存活 60 分钟、出生 72、母亲 12、世代 6"
      // 退化成"2102s 灭绝、出生 24、母亲 3"。机制是：排队让腾出的位置被**立刻**补上 ⇒
      // 种群长期钉死在上限 ⇒ 血统停止更新；而旧行为靠"卵全灭 → 种群跌破上限 →
      // crowding 松绑 → 重新繁殖"的振荡，反而维持了多条血统。已撤销，保留这条记录免得重推一遍。
      const atCap = alive.length >= world.populationCap;
      const eggs = layEggs(a, partner, world.rng, { atPopulationCap: atCap });
      for (const egg of eggs) world.eggs.push(egg);
      applyEvent(a.emotions, 'mated');
      applyEvent(partner.emotions, 'mated');
      adjustMemory(a.memory, partner.id, 0.25, 0.1);
      adjustMemory(partner.memory, a.id, 0.25, 0.1);
      world.events.push({
        kind: 'mated', a: a.id, b: partner.id,
        eggs: eggs.length, atPopulationCap: atCap,
      });
      a.courtshipCompleted = false;
      partner.courtshipCompleted = false;
    }
  }
  // 落单的完成者：对方没能一起完成（被打断、死亡、或走开了），算一次失败的求偶。
  //
  // 被拒绝要在关系记忆里留痕（CONFIG.rejectionAffection = -0.15）——
  // 这是 spec 4.8"恩怨"的一部分：被同一只拒绝过几次之后，
  // 它下次再靠近时这只的好感已经低了，求偶评分随之下降，于是会去别处。
  // 少了这一行，拒绝就只是一次性动画，世界不会记住它。
  //
  // 必须先抄下 partnerId 再清空，否则下面就找不到该记在谁的头上了。
  for (const a of completed) {
    if (!paired.has(a.id)) {
      const pid = a.courtshipPartnerId;
      a.courtshipCompleted = false;
      a.courtshipPartnerId = null;
      applyEvent(a.emotions, 'rejected');
      if (pid) adjustMemory(a.memory, pid, CONFIG.rejectionAffection, 0.05);
      world.stats.rejected += 1;
      world.events.push({ kind: 'rejected', id: a.id, by: pid });
    }
  }

  // 身体碰撞：重叠时互相推开，并给双方一点"被撞"的情绪冲击。
  // 只在真的挤到一起时触发，避免正常游动也被判为冲突。
  //
  // 接触距离用 (sizeOf(a) + sizeOf(b)) / 2000 把体型换算到 [0,1]² 世界坐标：
  // sizeOf = traits.size × growthFactor，取值范围 [3.08, 38]（traits.size ∈ [14,38]），
  // 于是两只最大体型相撞的接触距离是 76/2000 = 0.038，两只最小幼体是 0.003。
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      const minDist = (sizeOf(a) + sizeOf(b)) / 2000;
      if (d < minDist && d > 1e-6) {
        const push = (minDist - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.pos.x = clampPos(a.pos.x - nx * push);
        a.pos.y = clampPos(a.pos.y - ny * push);
        b.pos.x = clampPos(b.pos.x + nx * push);
        b.pos.y = clampPos(b.pos.y + ny * push);

        // 求偶中的碰撞不算冲突 —— 仪式本来就要贴近
        if (!a.courtship && !b.courtship) {
          applyEvent(a.emotions, 'bumped', 0.4);
          applyEvent(b.emotions, 'bumped', 0.4);
          // 记住这笔小账：好感轻微下降，多次碰撞才会累积成恩怨
          adjustMemory(a.memory, b.id, -0.01, 0.02);
          adjustMemory(b.memory, a.id, -0.01, 0.02);
        }
        // ⚠️ spec 4.8 的"更容忍亲属靠近"在整个内核里**没有生产者**：
        // 这里的推开对所有个体一视同仁（推的是身体，不是关系），perceive 也不按 kinship
        // 放宽距离。全项目内 kinship 的消费者只有近亲回避（mateScore / canCourt）
        // 与 memory.decay 的慢衰减通道。如实记下，免得后来者以为这里已经实现了它。
      }
    }
  }
}

// ---------------------------------------------------------------- 食物再生

function respawnFood(world, dt) {
  const algae = world.foods.filter((f) => f.kind === 'algae').length;
  // 只有光藻自然再生，且上限是 foodMax（蜜珠/冰晶只能由玩家投喂）。
  if (algae >= CONFIG.foodMax) return;
  // 概率随 dt 缩放，保证不同帧率下再生速率一致（0.35/秒 ⇒ 60Hz 下每 tick 0.58%）
  if (world.rng.chance(CONFIG.foodRespawnRate * dt)) {
    spawnFood(world, 'algae', {
      x: world.rng.range(0.05, 0.95),
      y: world.rng.range(0.15, 0.95),
    });
  }
}

// ---------------------------------------------------------------- 亲缘缓存自愈

// spec 4.11 的"幼体认妈妈"必须活得过记忆的容量淘汰。
//
// 背景（**可复现**，不是推测）：hatch 在雏体记忆里写下父母，registerKinship 又给每只同胞
// 各写一条，这些条目都由 ensure 建立，familiarity 恒为 0；而 memory.prune 在超过
// memoryCapacity（12）时按"familiarity 最低"淘汰，且只保护**本次**新建的那一条 ——
// 于是只要记忆溢出，familiarity 为 0 且最早写入的父母条目就是第一个牺牲品。
// 复现方式（与测试 '父母条目被容量淘汰后会被重新缓存回来' 完全一致）：
//   给一只生物写 MOM/DAD 两条亲属条目，再 ensure 13 个新 id 强制溢出 ⇒ MOM 与 DAD 都消失。
// 更关键的是这一步发生在出生之后：雏体每遇到一个新同胞/陌生态都可能挤掉一条亲属条目，
// 所以"在孵化那一刻补一次"是不够的 —— 必须每 tick 补。
//
// spec 4.8 的原则是"亲属/伴侣近乎不忘"，而这正是记忆侧该做的事 —— 但 memory.js 不归本 Task 改，
// 所以世界层每 tick 把**父母**这一条重新缓存一次（spec 4.11 明文对应的那一件事）。
// 代价可控：ensure 命中已存在的条目会立刻返回，所以正常情况下每只每 tick 只是两次
// 线性扫描（12 条以内）的空操作；只有条目真的被挤掉时才会重建（并顺带挤掉别的低熟悉度条目）。
// 同胞/祖孙那一侧不在这里补：近亲回避已经由 mateScore 的谱系闸门兜住，不依赖缓存。
//
// ⚠️ 已知债务（记在计划 Task 5 段的说明里，不是本模块能修的）：memory.prune 只按
// familiarity 淘汰、没有任何亲属保留规则，所以"母子近乎不忘"这句 spec 在**保留**这一侧
// 仍未被实现 —— 本函数只是把最要紧的"认妈妈"从后果里救了出来。原则上正确的修法是让
// prune 像 decay 那样跳过亲属条目（decay 的 isKin 判据就是现成的：role != null || kinship >= 0.25）。
function refreshKinMemory(world) {
  for (const c of world.creatures) {
    if (!c.alive) continue;
    if (c.lineage.mother) {
      ensureMemory(c.memory, c.lineage.mother, { kinship: KINSHIP.mother, role: 'mother' });
    }
    if (c.lineage.father) {
      ensureMemory(c.memory, c.lineage.father, { kinship: KINSHIP.father, role: 'father' });
    }
  }
}

// ---------------------------------------------------------------- 主 tick

export function tickWorld(world, dt) {
  world.time += dt;
  rebuildGrid(world);
  respawnFood(world, dt);

  for (const c of world.creatures) {
    // sick 个体被完全冻结：不再感知、决策、进食、繁殖。
    // 不跳过的话，导致它出错的那个损坏字段会在每一 tick 再抛一次，
    // events 队列会被同一条 error 刷满（600 条/10 秒），把真正有用的事件淹掉。
    // 冻结也让表现层的处理变简单：sick 就是一只静止、变暗的生物。
    // 同样跳过所有 !alive 的（含正在溶散的尸体）—— 这既让死者不再行动，
    // 也是"死亡闸门不会在读档时重放 onDeath"的原因（见 tickCreature 末尾）。
    if (!c.alive || c.sick) continue;
    try {
      tickCreature(world, c, dt);
    } catch (err) {
      // 隔离故障个体而不是让整个世界崩溃（spec 7.7）。
      // sick 个体仍然留在 creatures 里被 render 画出来（变暗、静止），
      // 这样问题对用户是可见的，而不是无声地少了一只。
      c.sick = true;
      c.intent = null;
      world.events.push({
        kind: 'error',
        id: c.id,
        message: String((err && err.message) || err),
      });
    }
  }

  tickEggs(world, dt);
  resolve(world, dt);
  reapDead(world, dt);
  // 放在最后：本 tick 里新建的关系条目（碰撞、拒绝、孵化）都已经写完，
  // 这一步保证"谁是它的父母"这条亲属事实在 tick 结束时一定在记忆里。
  refreshKinMemory(world);
}
