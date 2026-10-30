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
//    它是**一次性**事件（death / hatch / eat / laid / dissolved / eggFailed /
//    error），不是状态快照 —— 状态由 world 本身提供。消费方（计划 2）每帧取走后清空，
//    否则队列会无界增长（本模块不代为清理，因为"取走"这个动作只有消费方知道）。
//
// 3. **症状必须是可见的、而不是静默的。** 单只生物 tick 抛错时隔离它并记一条 error
//    （spec 7.7），而不是让世界崩掉、也不是把它悄悄从 creatures 里删掉：
//    表现层会画出一只变暗静止的个体，玩家看得见异常。同理，非法输入（未知食物种类）
//    抛 TypeError，而不是让它经原型链解析成一个 truthy 的函数、最后变成 NaN 需求。
import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { randomGenome, phenotype, eggTintBucket } from './genes.js';
import { decay as decayNeeds, feed as feedNeeds, comfort, startle as startleNeeds } from './needs.js';
import { computeTargets, update as updateEmotions, applyEvent, moodOf } from './emotions.js';
import {
  adjust as adjustMemory, decay as decayMemory, ensure as ensureMemory,
  affectionFor, kinshipBetween, PLAYER_ID, KINSHIP,
  companionOf, promoteCompanion, demoteCompanion,
} from './memory.js';
import { createCreature, ageCreature, canBreed, sizeOf, STAGES } from './creature.js';
import { maybeSay } from './speech.js';
import { recall } from './heard.js';
import { mostUrgent } from './needs.js';
import {
  kinshipOf, crowdingFactor, layEggs, tickEgg, hatch, registerKinship, reserveEggSeq,
} from './breeding.js';
import { decide, EAT_DIST, EAT_HUNGER, HAND_SPEED_POKE } from './behavior.js';
import { heldStep, enjoyOf, carryEffects } from './grab.js';
import { pairEligible, companionReady, bondStep } from './social.js';

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

// 世界层的产卵 readiness 评分（孤雌，spec §4.12 第 1 条）。
//
// 与原 mateScore 最大的区别：**没有对象**。所以"近亲闸门"整段消失了 —— 它当年防的是
// 兄妹互相求偶，而孤雌不需要同意。kinshipOf / registerKinship 仍然留着，
// 因为亲缘还要管亲属偏好、守巢与家谱。
//
// readiness 是"这只憋了多久"：随 broodT 线性升到 1，产卵后归零。所以产卵不是定时器
// 触发的事件，而是**与其他候选一起竞争胜出**的行为（spec §4.10）—— 一只又饿又怕的
// 成体即使憋满也不会去孵，这正是效用评分比定时器真实的地方。
//
// 种群上限仍走"压低而非硬阻断"：crowdingFactor 下限 0.12，**永不为 0**。
function broodScore(world, c) {
  if (!canBreed(c)) return 0;
  const interval = Math.max(1e-6, c.thresholds.broodInterval);
  const readiness = Math.min(1, (c.broodT || 0) / interval);
  const loadRatio = world.populationCap > 0
    ? aliveCreatures(world).length / world.populationCap : 0;
  return readiness * crowdingFactor(loadRatio)
    * (0.4 + c.emotions.arousal) * (1.2 - c.needs.hunger);
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
    // 外来血统漂入（spec §4.12）。nextDriftAt 是**下一次漂入的模拟时刻**，
    // 不是倒计时 —— 它进存档（spec §7.2），读档后不会重置节奏。
    // driftInterval 可以被 opts 覆盖成 Infinity 来关掉，多样性判据的正反两向
    // 就靠这个开关做 A/B（见 tests/sim.test.js 的漂入组）。
    nextDriftAt: opts.driftInterval ?? CONFIG.drift.interval,
    driftInterval: opts.driftInterval ?? CONFIG.drift.interval,
    driftCount: 0,
    stats: { births: 0, deaths: 0, hatchFailures: 0, generation: 1, driftIns: 0, emigrations: 0, said: 0 },
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

  // 语言层用**自己的一条分叉流**，而不是 world.rng。
  // 理由不是风格：maybeSay 每次出词要抽 2–6 个随机数，若它走主流，
  // "关掉文字层"就会让全缸的觅食/产卵/漂入取值整体平移 ——
  // 那样 spec §9.2 第 7 条想要的对照（关掉文字层、其余逐位不变）根本做不出来，
  // 而"文字层不碰世界"这件事就只能是注释里的一句愿望。
  // 分叉放在初始个体投放**之后**：主流的既有取值序列一个都不动。
  world.speechRng = rng.fork();
  // 运行时开关（计划 3 的设置页要能改它）。CONFIG.speech.enabled 只是默认值 ——
  // CONFIG 是深冻结的常量表，不该被当成状态表用。
  world.speechEnabled = opts.speechEnabled ?? CONFIG.speech.enabled;

  return world;
}

// 默认命名：粉色系叠词 + 序号。计划 3 会用 names.js 替换它，
// 这里给一个够用的实现，避免内核依赖尚未存在的模块。
const NAME_SYLLABLES = ['泡泡', '团团', '蜜桃', '软软', '樱樱', '糯糯', '朵朵', '糖糖', '圆圆', '咕咕'];
function defaultNameFor(genes, index) {
  const base = NAME_SYLLABLES[index % NAME_SYLLABLES.length];
  return index < NAME_SYLLABLES.length ? base : `${base}·${Math.floor(index / NAME_SYLLABLES.length) + 1}`;
}

/**
 * 把缸里重名的"自动名"改掉。**customName 为真的个体一个都不动** ——
 * 这是那个字段在全仓的第一个消费者（生产者是计划 3 Task 5 的改名）。
 *
 * 为什么需要它，而不是只在出生时给对序号：
 *   · 出生序号只保证**新**的一窝不撞；老存档里那批同窝同名的个体（hatch 曾恒传 index 0）
 *     不会因此变好；
 *   · 玩家能把两只改成同名之外的名字，也可能改到与别人撞 —— 撞了就要有一个人让路，
 *     而让路的绝不能是玩家亲手取的那个。
 * 两趟：第一趟让所有 customName 先占位，第二趟按出生顺序给重复者换 `·N`。
 * 不消费随机数 ⇒ 不影响可复现性（这条很重要：名字进了 world 就进存档）。
 * 返回改了几只，调用方计数。
 */
export function dedupeNames(world) {
  const list = ((world && world.creatures) || []).filter((c) => c && typeof c.name === 'string' && c.name);
  const taken = new Set();
  for (const c of list) if (c.customName) taken.add(c.name);
  let renamed = 0;
  for (const c of list) {
    if (c.customName) continue;                     // 玩家取的名不参与去重
    if (!taken.has(c.name)) { taken.add(c.name); continue; }
    const base = c.name.replace(/·\d+$/, '');       // 先剥掉旧后缀，否则叠成 泡泡·2·2
    let k = 2;
    let next = `${base}·${k}`;
    while (taken.has(next)) { k += 1; next = `${base}·${k}`; }
    c.name = next;
    taken.add(next);
    renamed += 1;
  }
  return renamed;
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

// ---------------------------------------------------------------- 读档（Task C-1）

// 把一份**已经过 save.js 的 migrate() 与 assertCreatureShape()** 的裸对象装回一个已存在的世界。
//
// 为什么必须是**就地改写**而不是返回一个新世界：boot() 里三处握着 world 这一个引用 ——
// renderer 与 audio 是每帧拿它读、input 的 onHand 回调往 `world.playerHand` 写、
// API 档的闭包（attachApiTier）捕获的是同一个对象。换成新对象，症状是
// "缸在跑，但画面、叫声与档位说的是另一缸"，而 world.playerHand 会写到一份没人读的物体上。
//
// 为什么这件事必须由内核提供而不是 main.js 自己塞字段（spec §7.2.1 的边界）：
// "读档"要动的是世界状态的**构造**，而构造规则（哪些字段必须存在、编号怎么避让、
// 网格要不要重建）全部住在本文件。让页面入口逐字段 poke 就等于把内核的形状契约
// 复制第二份到唯一被纯度守卫豁免的文件里 —— 那份复制没人会记得同步。
//
// ⚠️ 入参必须是迁移过的：没迁移的存档里 memory 是裸数组、traits/thresholds 缺失，
//    直接塞进世界的症状是第一 tick 由 refreshKinMemory 抛 "memory.entries is not iterable"，
//    或由 decode 之外的某处读出 undefined。调用方（main.js）的读档路径把 migrate 与
//    assertCreatureShape 放在同一个 try 里，所以那种 blob 到不了这里 —— 由探针保证这条不是注释。
export function restoreWorld(world, doc) {
  if (world === null || typeof world !== 'object' || !Array.isArray(world.creatures)) {
    throw new TypeError('restoreWorld: 需要一个由 createWorld 造出的世界');
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.creatures)) {
    throw new TypeError('restoreWorld: 存档必须是 migrate() 的输出（要有 creatures 数组）');
  }
  const w = doc.world || {};

  // 种子与两条随机流：⚠️ **读回来的是一条全新的流**（从存档里那个 seed 重新起头），
  // 不是"当时那一条流停在哪儿就从哪儿继续"—— save.js 里没有任何一条路径能把
  // rng 闭包里的那个 `s` 写出去（JSON.stringify 给的是 `{}`）。
  // 所以"存 → 读 → 跑 N tick"与"连跑 N tick"**不可能逐位相同**，
  // 而把这句话写在这里而不是藏在测试注释里，是为了让下一个人不再去写那条假的逐位断言。
  // 详见 spec §7.2.1 R-5。
  const seed = Number.isFinite(w.seed) ? w.seed : world.seed;
  world.seed = seed;
  world.rng = createRng(seed);
  world.speechRng = world.rng.fork();

  world.time = Number.isFinite(w.time) ? w.time : 0;
  world.nextDriftAt = Number.isFinite(w.nextDriftAt) ? w.nextDriftAt : world.driftInterval;
  world.driftInterval = Number.isFinite(w.driftInterval) ? w.driftInterval : CONFIG.drift.interval;
  world.driftCount = Number.isInteger(w.driftCount) ? w.driftCount : 0;

  // ⚠️ `populationCap` **刻意不读存档**：上限由**这台设备**决定（桌面 24 / 手机 16），
  // 而 createWorld 处那条"只在开缸时判定一次、之后不随 resize 改"的纪律讲的是同一个进程内。
  // 跟着存档走会让一份在电脑上写的档把手机也顶到 24 只 —— 那是 §5.3 预算要防的那件事，
  // 也与 §9.2 第 4 条（同一份档在两种屏上都合适）相反。
  // 存档里的个体数**多于**本机上限时不杀任何一只：上限由 layEggs 的 `viable` 把关（见 addCreature），
  // 所以症状是"这一缸暂时不生蛋"，而不是"读个档少了几只"。
  if (typeof w.speechEnabled === 'boolean') world.speechEnabled = w.speechEnabled;

  world.stats = {
    births: 0, deaths: 0, hatchFailures: 0, generation: 1, driftIns: 0, emigrations: 0, said: 0,
    ...(doc.stats || {}),
  };

  // 三个成员表整份替换（用 length=0 + push 保住数组引用：grid 里存的是下标，
  // 而任何在 boot 之前就把 world.creatures 存进闭包的调用方都指望这是同一个数组）。
  world.creatures.length = 0;
  for (const c of doc.creatures) world.creatures.push(restoreCreature(c));
  world.eggs.length = 0;
  for (const e of (Array.isArray(doc.eggs) ? doc.eggs : [])) world.eggs.push({ ...e, pos: { ...e.pos } });
  // 食物：存档里**有这一层**才替换。老档没这一层时保留 createWorld 撒下的那 12 份初始光藻，
  // 否则读一个旧档会把缸凭空饿成饥荒 —— 那是"读档后更像会死"的静默劣化。
  if (Array.isArray(doc.foods)) {
    world.foods.length = 0;
    for (const f of doc.foods) world.foods.push({ ...f, pos: { ...f.pos } });
  }

  // id 编号避让：eggSeq / foodSeq 是**模块级**计数器，新进程从 0 起（见本文件顶部与 breeding.js）。
  // 不避让的话，读档后新产的卵会拿到 `e1` 这个**已经存在**的编号，孵化出的个体 id
  // `c-e1` 于是也重复 —— 而 byIdIn / memory.get 都按 id 取**第一个**，
  // 症状是"它记得的那只不是它妈"，全程不报错。这条正是 §7.2.1 R-1 那一族的兄弟：
  // 存档接上之后才第一次变得可达，所以它属于"接线"要负责的后果，不是内核的旧账。
  reserveIdSeqs(world);

  rebuildGrid(world);
  world.events.length = 0;
  return world;
}

// 读档路径的**前置**校验：只查"这只装不装得进去"，一个字节都不改。
// 为什么单独导出：main.js 的 load() 必须在**动世界之前**问这句话 ——
// restoreWorld 是就地改写的，让它改到一半才抛，用户得到的是一缸被清掉一半的僵尸，
// 而不是一缸干净的新缸。导出一份、两处用（load 与 restoreCreature 自己），
// 免得校验规则长成两份各自漂移的清单。
// 脏 stage 不拦的症状是"这只永远不能繁殖也不算成年"，跟迁移取默认值一样**完全没有症状**，
// 所以这道防线必须在读档这条绕过 createCreature 的路上重设一遍。
export function assertRestorable(doc) {
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.creatures)) {
    throw new TypeError('restoreWorld: 存档必须是 migrate() 的输出（要有 creatures 数组）');
  }
  for (let i = 0; i < doc.creatures.length; i++) {
    const c = doc.creatures[i];
    if (c === null || typeof c !== 'object') {
      throw new TypeError(`restoreWorld: 第 ${i} 个个体不是对象（收到 ${JSON.stringify(c)}）`);
    }
    if (typeof c.id !== 'string' || c.id === '') {
      throw new TypeError(`restoreWorld: 个体缺 id（收到 ${JSON.stringify(c.id)}）`);
    }
    if (!STAGES.includes(c.stage)) {
      throw new TypeError(`restoreWorld: ${c.id} 的 stage "${String(c.stage)}" 不在 STAGES 里：${STAGES.join(' / ')}`);
    }
  }
}

// 一只裸对象 → 一只能跑的生物。补的三类东西各有出处：
//   · memory / traits / thresholds / speech / heard / catchphrase 由 save.migrate() 备齐，
//     这里**不重做**（重做就是两份形状定义，正是 save.js 文件头禁止的那件事）；
//   · 决策层与上升沿寄存器不入档（save.js 的 CREATURE_SKIP_FIELDS），在这里回到出厂值；
//   · stage 必须是 STAGES 之一：createCreature 对显式 stage 设了这道防（creature.js 那条注释），
//     而读档路径绕过了 createCreature，所以防线必须搬到这里来。脏 stage 不抛的话，
//     症状是"这只永远不能繁殖也不算成年"，跟迁移取默认值一样**完全没有症状**。
function restoreCreature(c) {
  assertRestorable({ creatures: [c] });
  const out = { ...c };
  if (out.pos) out.pos = { ...c.pos };
  if (out.vel) out.vel = { ...c.vel };
  if (out.facing) out.facing = { ...c.facing };
  out.intent = null;
  out.intentTime = 0;
  out.moving = false;
  out.resting = false;
  out.beingPetted = false;
  out.beingPoked = false;
  out.held = false;        // 读档后没有人正被拎着 —— 手属于输入层，档里那份 playerHand 早作废了
  return out;
}

// 从 id 里读出已经用过的编号，把两个模块级计数器推到它们之外（只前进，不回退）。
// 只认 `e<整数>` / `f<整数>` 这两种出厂形状，别的（`c-init-3`、`e-drift-2`）一律不参与：
// 那些编号的来源是别处（初始投放与漂入计数），把它们混进这套避让就会**误读**。
function reserveIdSeqs(world) {
  let eggMax = 0;
  let foodMax = 0;
  const bump = (id, re, setter) => {
    if (typeof id !== 'string') return;
    const m = re.exec(id);
    if (m) setter(Number(m[1]));
  };
  const eat = (n) => { if (n > eggMax) eggMax = n; };
  const eatFood = (n) => { if (n > foodMax) foodMax = n; };
  for (const e of world.eggs) bump(e.id, /^e(\d+)$/, eat);
  for (const c of world.creatures) {
    bump(c.id, /^c-e(\d+)$/, eat);         // 由卵孵出的个体：id 里嵌的就是那个卵的编号
    bump(c.id, /^e(\d+)$/, eat);
  }
  for (const f of world.foods) bump(f.id, /^f(\d+)$/, eatFood);
  if (eggMax > 0) reserveEggSeq(eggMax);
  if (foodMax > foodSeq) foodSeq = foodMax;   // 本文件自己那一个，直接推
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
    // down / appeared 必须一起转发：perceive 返回的是**新建的对象**，
    // 漏抄字段就等于在感知层把输入信号丢了 —— 症状是"戳它完全没反应"，
    // 而 input.js 与 world.playerHand 两边都是对的，最难查的那种断链。
    const grabId = world.playerHand.grab ? world.playerHand.grab.id : null;
    const grabbed = grabId !== null && grabId === c.id;
    // 手比同类更"显眼"：感知半径放宽到 1.5 倍，好让玩家一伸手就有反应。
    // ⚠️ 正被拎着的那只不受这道半径门限制：追随是有滞后度的，手甩到缸对面时
    //    个体一时跟不上，若在这里被半径挡掉，grab 就**静默消失** ——
    //    症状是拎着拎着娃娃自己落地，且没有任何事件说明发生过这件事。
    if (d <= R * 1.5 || grabbed) {
      playerHand = {
        pos: world.playerHand.pos, dist: d, speed: world.playerHand.speed,
        down: !!world.playerHand.down, appeared: !!world.playerHand.appeared,
        // grab 必须是**新对象**。main.js:932 那条 ⚠️ 说"pos 按引用搬是安全的，因为本 tick 用完"，
        // 而抓的语义是跨帧的（c.held 会活过很多 tick）—— 按引用搬就得到隔帧读到别人的 id。
        // ⚠️ 这里刻意**不按 c 筛**（原实现筛了，于是 isHeld 里那句 id === c.id 永远不会为假，
        // 成了一条没有 bug 能翻它的死条件）。perceive 的职责是转发输入，"这只正被拎着"
        // 的判定只写在 isHeld 一处 —— 探针 P2（把它改成整只手一刀切）现在抓得住。
        grab: grabId === null || grabId === undefined ? null : { id: grabId },
      };
    }
  }

  // 产卵 readiness（孤雌）：由世界层算好放进 senses，behavior 只读数字 ——
  // behavior 刻意不 import breeding，否则会形成 behavior → breeding → creature 的耦合链。
  // 分数里已含种群上限的压制（crowdingFactor 下限 0.12，永不为 0），
  // 所以上限本身不会把评分归零，只会让产卵变得稀少。这就是 spec §4.12 第 6 条要的
  // "压低而非硬阻断"。原来的 courtshipOptions 列表（每个邻居一项、配对打分）整组作废。
  // 满员判定：perceive 与 resolve 各算一次是刻意的（两处读的种群时点不同）。
  const atCap = aliveCreatures(world).length >= world.populationCap;
  const brood = broodScore(world, c);
  // provoker：最近那个也在生气、且离得很近的邻居。
  // behavior 用它决定 protest / fight 的目标（筛选标准只在 perceive 里定义一处）。
  const provoker = neighbors.find((n) => n.anger > 0.5 && n.dist < 0.08);

  return {
    foods, neighbors, threats, playerHand, broodScore: brood,
    provokerId: provoker ? provoker.id : null,
    // population / populationCap / atPopulationCap 目前**没有**生产代码里的消费者：
    // 种群上限的效果全部经由 broodScore 传导（见上），
    // 所以 behavior 不需要读它们。留着是给计划 2/3 的表现层与调试面板用的只读诊断读数
    // （例如显示"24/24"或给 UI 一个"缸满了"的提示）。**不要**在 behavior 里
    // 把它们接成条件门控 —— 那就成了 spec 4.12 第 6 条禁止的硬阻断。
    population: aliveCreatures(world).length,
    populationCap: world.populationCap,
    atPopulationCap: atCap,
  };
}

// ---------------------------------------------------------------- 情绪情境

// 被拎住的那只。三个谓词（戳 / 贴上抚摸 / 手停附近）都在开头让路，且**只让给它自己** ——
// 拎着 A 划过 B 时 B 仍然算被戳。让路点只写在这一处：
// 散到各调用方的 `if (grab) skip` 早晚会被下一个消费者漏掉。
// senses.playerHand.grab 在 perceive 里已经按"是不是这只"筛过（sim.js 的感知段），
// 所以这里只判有无。
function isHeld(c, senses) {
  const h = senses.playerHand;
  return !!h && !!h.grab && h.grab.id === c.id;
}

// "玩家真的理它了"的唯一判定：**温柔的手**且**近到能碰上**。
// 这个谓词有两个消费者，必须是同一个定义点，否则会出现
// "熟悉度按 A 距离累积、冷落计时按 B 距离归零"这种自相矛盾：
//   1. tickCreature 里的熟悉度通道（把手放那儿只买到"认识"，买不到"喜欢"）
//   2. tickCreature 里的求关注升级计时（spec §4.10）
// 速度阈值与 behavior 的 handIsRough、emotionCtx 的 threat 共用 HAND_SPEED_POKE。
function isPetting(senses) {
  const h = senses.playerHand;
  return !!h && h.speed <= HAND_SPEED_POKE && h.dist < CONFIG.perceiveRadius * 0.5;
}

// 抚摸谓词的"逐只"版本：被拎住的那只不让路的话，它的 familiarity 会由两条通道同时供给
// —— 而 CONFIG.grab.familiarityRate 与这条**同值**（0.04/s），叠加成 0.08/s 玩家看不出来，
// 只有 tests/sim.test.js 那条速率断言抓得住。两个消费者（熟悉度通道、冷落计时）必须同一判据，
// 所以包一层而不是在各调用点散着写 if (isHeld)。
function isPettingNear(c, senses) {
  return !isHeld(c, senses) && isPetting(senses);
}

// 抚摸的第二层判定：在 isPetting（温柔 + 够近）之上还要求**贴上身体**。
// 接触半径读 sizeOf(c)/1000 —— 与 resolve() 里两只身体的接触距离同一口径。
// 刻意不写成 `dist < 某个固定常数`：幼体与成体的"贴上去"差着一个数量级，
// 固定数会让"摸一只幼体"变成必须把手插进它身体里才算。
function isBeingPetted(c, senses) {
  if (isHeld(c, senses)) return false;      // 被拎住 ⇒ "贴着身体"是追随的结果，不是玩家在摸
  const h = senses.playerHand;
  if (!h || h.speed > HAND_SPEED_POKE) return false;
  return inContact(c, h);
}

// "贴上身体"这个几何判定只有一处定义（抚摸与戳共用）。
// 两处各写一遍的话，改一处就会让"摸得到但戳不到"这类不对称悄悄出现。
function inContact(c, hand) {
  return hand.dist <= (sizeOf(c) / 1000) * CONFIG.behavior.petContactRatio;
}

// 戳 = **按下** + 快速 + 贴上。
// 为什么戳要 `down` 而抚摸不要：手机上没有 hover，手指一接触屏幕就是按下，
// 两者都有 down；但桌面鼠标"悬停划过"是合法的抚摸（spec §6.1 的"缓慢划动"），
// 而"没按下的快速移动"只是手划过，不该被当成攻击。
// 缺 down 一律按 false 处理 —— 反过来（当成 true）会把每次快速划过都判成戳。
function isPoking(c, senses) {
  if (isHeld(c, senses)) return false;      // 拖拽天然满足"按下 + 快 + 贴上"，不让路就等于一路扎
  const h = senses.playerHand;
  if (!h || !h.down) return false;
  if (h.speed <= HAND_SPEED_POKE) return false;
  return inContact(c, h);
}

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
    // 为什么：这门控**只看阶段**（成体、活着、不 sick），刻意不再要求"此刻真能产卵"。
    // 孤雌改造后这条约束换了名字但**没有消失**：arousal 是 broodScore 的一项乘子
    // （0.4 + arousal），而 arousal 又只能由这个 canBreed 门控打开。若这里再叠一层
    // "broodT 已经憋满"之类的条件，两者互为前提 ⇒ arousal 永远停在 0 ⇒ 全缸不生，
    // 且不报错、不抛异常，症状只是"这个缸不生"。原实测记录见 Task 9-11 的预飞审查。
    // emotions.js 的模块说明也是这个意思：这门控是为了"亚成体与老年个体不该有性冲动"。
    canBreed: canBreed(c),
  };
}

// ---------------------------------------------------------------- 行动执行

// 吃下去的**唯一**结算：自吃（下面 case 'eat'）与手喂（held 分支）都调它。
// 为什么必须只有一份：这段里有四个副作用（需求、fed 事件、冰晶的 calms 那一支、
// 摘食物 + eat 事件），两处各写一遍的话，第五个副作用一定会只进一边 ——
// 而"手喂不安抚 / 自吃不记事件"这种不对称，玩家只能靠对着两个食物分别试一次才发现。
// tests/sim.test.js 的"同一份食物：自吃与手喂的结算逐字段相同"钉的就是这件事。
function eatFood(world, c, f) {
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
}

function executeIntent(world, c, senses, dt) {
  // 被拎住 ⇒ 本 tick 的运动由"追随手"接管，正常意图一帧都不执行（spec 2026-10-24 §4 / R-6）。
  // 刻意**不**复用下面的 moveToward：那条把速率钳在 CONFIG.motion.baseSpeed，
  // 手快拖时身体追不上，症状就是"一拖就脱手"——而这件功能卖的正是"拎得起来"。
  // 决策照旧在 tickCreature 里跑（本函数之后才轮到），所以松手之后下一 tick 自然接管，
  // 这里不需要任何"恢复"逻辑。
  if (isHeld(c, senses)) {
    const s = heldStep({ pos: c.pos, vel: c.vel, target: senses.playerHand.pos,
      dt, k: CONFIG.grab.followStiffness });
    c.pos.x = clampPos(s.x);
    c.pos.y = clampPos(s.y);
    // 被墙截住的那个轴向速度归零：墙不存弹性能量（与 moveToward 撞墙的既有语义一致），
    // 也免得松手时那一点"朝墙里冲"的速度把个体甩进墙里再抖一下。
    c.vel.x = c.pos.x === s.x ? s.vx : 0;
    c.vel.y = c.pos.y === s.y ? s.vy : 0;
    c.moving = true;
    c.resting = false;
    // ---- 手喂（2026-10-25）----
    // 把饿的那只拖到食物上就算喂。闸门沿用**内核觅食那两个数**（EAT_DIST / EAT_HUNGER）：
    // 手只是帮它够到本来就该吃的那一口，不是新开一条供给通道 —— 所以吃饱的拖过去不咬。
    // 位置用**移动之后**的 c.pos 量（不是 perceive 那份快照）：玩家眼里"放到食物上"
    // 说的是它最后停在哪儿，拿旧位置量会让快拖漏吃得更明显。
    // 扫描 world.foods 而不是 senses.foods：这里要的是"贴着"（EAT_DIST 0.035），
    // 而 senses 的半径是 0.28 且是移动前的；一次 O(40) 的点距比较，最多一只在手里的代价。
    if (c.needs.hunger > EAT_HUNGER) {
      let bite = null;
      let biteD = EAT_DIST;
      for (const f of world.foods) {
        const fd = Math.hypot(f.pos.x - c.pos.x, f.pos.y - c.pos.y);
        if (fd < biteD) { bite = f; biteD = fd; }
      }
      if (bite) {
        eatFood(world, c, bite);
        // 你喂的，它记账：这一口**只买好感**，熟悉度不在这里重复买 ——
        // 拎着期间 familiarity 已由 carryEffects 那条连续通道供给（速率恰好是一条通道），
        // 这里再买一次就成了"吃一口认识度跳一下"，两条通道的账就混了。
        // 额度是**离散的每口一次**，不是速率：写成速率等于承认"拖在食物上不动也能一直喂"，
        // 而那份食物早被第一口吃掉了 —— 数字的形状会误导下一个人。
        adjustMemory(c.memory, PLAYER_ID, CONFIG.grab.feedAffection, 0);
      }
    }
    return;
  }

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
  // （原 `if (c.courtship) speedFactor *= motion.courtshipFactor` 随求偶制删除。）
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
        eatFood(world, c, f);
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

    case 'hop': {
      // 一次蹦跳只扣一次精力。标记挂在 **intent** 上而不是 creature 上 ——
      // 换意图天然就重置了（与 brood 的 intent.laid 同型；上一轮正因为
      // 把一次性状态挂错地方而踩过坑）。
      //
      // 为什么这一扣是承重的：hop 的效用分里有 (1 − energy) 这个乘子，
      // "越好动 → 跳得越勤 → 自己把精力耗光 → 必须歇"这条闭环原本只靠
      // energyDrainFactor 的被动消耗。补上主动扣费之后，蹦得越多累得越快，
      // 累到 energy ≥ 0.7 它自己就退出竞争 —— 全程没有任何硬门控。
      if (!intent.costed) {
        intent.costed = true;
        c.needs.energy = clamp01(c.needs.energy + CONFIG.hop.energyCost);
      }
      // 平时原地蹦（无目标点）；升级到第一级后 behavior 会把目标点设成手的位置。
      if (intent.targetPos) moveToward(c, intent.targetPos, dt, speedFactor);
      break;
    }
    case 'brood': {
      // 孵卵不移动：它就在原地趴着。产卵在意图**第一次被执行到**时结算，一次性。
      //
      // ⚠️ 为什么不在 resolve 里等"意图做满 minDuration 再结算"：那样永远等不到。
      // tickCreature 的判定是 `if (!c.intent || c.intentTime >= minDuration) 重新决策`，
      // 而它跑在 resolve **之前** —— 计时器刚到阈值就被换成新意图并归零，
      // resolve 每次看到的都是"刚起的新 brood"，条件恒不成立。
      // 实测症状：新缸跑 420 秒 eggs=0 births=0，全链路不报错。
      // 一次性标记挂在 intent 上（而不是 creature 上），所以换意图天然就重置了。
      if (!intent.laid) {
        intent.laid = true;
        c.broodT = 0;
        const atCap = aliveCreatures(world).length >= world.populationCap;
        const eggs = layEggs(c, world.rng, { atPopulationCap: atCap });
        for (const egg of eggs) world.eggs.push(egg);
        applyEvent(c.emotions, 'laid');
        world.events.push({ kind: 'laid', id: c.id, eggs: eggs.length, atPopulationCap: atCap });
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

// ---------------------------------------------------------------- 出词

// 语言层的唯一接线点。它**只读**世界状态，唯一的产物是 world.events 里的一条 say
// （以及 creature.speech 这个私有状态）。
//
// 为什么要有 `world.speechRng` 这条独立流，见 createWorld 末尾的注释：
// 那才是"关掉文字层之后其余统计逐位不变"能做对照的原因，也就是 spec §4.13.2 第 2 条
// （语言产出是只读旁路，不许改世界）在规则档里的等价保证。
function speak(world, c, senses) {
  const nearest = senses.neighbors.length ? senses.neighbors[0] : null;
  const otherRef = nearest ? world.creatures.find((x) => x.id === nearest.id) : null;
  const mood = moodOf(c.emotions, c.needs, c.memory, { adversity: c.mourn > 0 });
  // 听进去的话只在文字层开着时检索：recall 是纯读的，但它要抽随机数（说错词），
  // 关掉之后还去抽样就是白白让私有流往前走 —— 不影响世界，只是没必要。
  const need = mostUrgent(c.needs);
  const hit = world.speechEnabled ? recall(c, { need, mood }, world.time, world.speechRng) : null;
  const u = maybeSay(c, {
    mood,
    need,
    heard: hit ? hit.token : null,
    playerNear: senses.playerHand !== null,
    other: otherRef ? { id: otherRef.id, name: otherRef.name } : null,
    speechEnabled: world.speechEnabled,
  }, world.speechRng, world.time);
  if (!u) return;
  world.stats.said += 1;
  // mood 一起进事件：表现层的气泡样式跟心情走（spec §5.3），
  // 而它不该为了拿心情再去调 moodOf —— 定义点已经有这里一处了。
  world.events.push({ kind: 'say', id: c.id, text: u.text, tokens: u.tokens, mood });
}

// ---------------------------------------------------------------- 它在看着你（spec §4.6 末段）

// 玩家的手在附近时，facing 缓慢转向它（好感高）或转开（好感 ≤ 0）。
//
// 为什么必须在内核做而不是在表现层：B15 交付眼睛时，渲染层只能**读** c.facing。
// 在 render 里顺手改 c.facing 能让"它在看你"看起来成立，但那会把一个内核缺口
// 伪装成已完成 —— 而且违反本模块的边界（表现层唯一可写的字段是 world.playerHand）。
//
// 三条门控，每条都对应一个真实的错误表现：
//   · **只在 !c.moving 时生效** —— 正在逃、正在觅食时 facing 由位移方向决定。
//     覆盖它会让它"斜着身子去觅食"，读起来是坏了而不是可爱。
//   · **好感分三档**（转过去 / 不动 / 转开）。写成"有手就盯着"就把这条变成了
//     挂机注视，而 spec 的原话是"好感高时主动转，好感低时反而转开"。
//   · **步长上限 = turnRate × lookRateFactor × dt**。没有上限就是一次瞬移；
//     有上限才叫 glance。turnRate 由 bold 调制 ⇒ "胆大的敢直视、胆小的瞥一眼就躲"。
//
// 用 atan2 + cos/sin 重写而不是向量插值：后者会让 facing 在插值中途**缩短**，
// 而全项目都假设它是单位向量（spec §4.6 明写）。长度漂移是静默的。
function lookAtHand(c, senses, dt) {
  const B = CONFIG.behavior;
  const hand = senses.playerHand;
  if (!hand || c.moving) return;
  const aff = affectionFor(c.memory, PLAYER_ID);
  let dir = 0;
  if (aff >= B.lookTowardAffection) dir = 1;
  else if (aff <= B.lookAwayAffection) dir = -1;
  if (dir === 0) return;

  const dx = hand.pos.x - c.pos.x;
  const dy = hand.pos.y - c.pos.y;
  // 转开 = 看反方向。合成一个表达式会让"转开"读起来像 bug（它在瞪别处），
  // 所以这里显式取反并注释它对应 spec 的哪半句。
  const target = Math.atan2(dy, dx) + (dir > 0 ? 0 : Math.PI);
  const cur = Math.atan2(c.facing.y, c.facing.x);
  let delta = target - cur;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  if (delta === 0) return;

  const maxStep = c.thresholds.turnRate * B.lookRateFactor * dt;
  const step = delta > maxStep ? maxStep : (delta < -maxStep ? -maxStep : delta);
  const next = cur + step;
  c.facing.x = Math.cos(next);
  c.facing.y = Math.sin(next);
}

// ---------------------------------------------------------------- 单只 tick

function tickCreature(world, c, dt) {
  decayMemory(c.memory, dt);

  const senses = perceive(world, c);

  c.intentTime += dt;

  // 2026-10-20：这里原有一整段"仪式进行中锁定 court 意图、完全不重新决策"的逻辑。
  // 它存在的理由是 canCourt 要求 !a.courtship，于是仪式一开始分数就归零，
  // 不锁定的话两只会在半路各自游开。**孤雌下没有对象，这个失效模式整类消失**，
  // 所以锁定逻辑一并删除，而不是"改成锁定 brood"。
  if (!c.intent || c.intentTime >= c.intent.minDuration) {
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
  if (isPettingNear(c, senses)) {
    adjustMemory(c.memory, PLAYER_ID, 0, 0.04 * dt);
  }

  // ---- 求关注升级计时（spec §4.10）----
  // 放在 executeIntent **之后**：本次 beg 蹭到的那一点好感先结算完，
  // 再判定"这一 tick 到底算不算被理睬"，否则同一 tick 里既归零又累加，顺序就决定了结果。
  //
  // 三种情形：
  //   被理睬（isPetting）    → 归零。spec 明文"被抚摸后升级计数归零"。
  //   手不在场               → 归零。没人在场还累加，读起来是"对着空气闹脾气"。
  //   手在场但没回应         → 累加。粗暴的手**也算没回应**：
  //     "被理睬"在 spec 里指的是它想要的那种回应（抚摸），不是"玩家碰了我一下"。
  //     被戳的时候 fear/flee 会接管行为，这条计时只是不被清零，不会让它更黏人。
  //
  // 跨过第二级那一刻发**一次** ignored 冲击。用 before/after 比较而不是挂标记：
  // 计时器本身单调，跨点只会发生一次，加一个 c.ignoredFired 字段反而多一个
  // 需要归零路径的状态（上一轮在 brood 结算上踩过"一次性标记挂错地方"的坑）。
  // ---- 拎（spec 2026-10-24 §5）----
  // 上升沿走 c.held 寄存器，与 beingPetted / beingPoked 同族：倍速子步会把同一份手样本
  // 喂进多个 tick，靠"这帧手速过阈值"判次数必然翻倍（tests/sim.test.js 那条钉的就是这个）。
  const heldNow = isHeld(c, senses);
  if (heldNow !== c.held) {
    const enjoy = enjoyOf(c, affectionFor(c.memory, PLAYER_ID));
    if (heldNow) {
      c.held = true;
      applyEvent(c.emotions, 'grabbedHappy', enjoy);
      applyEvent(c.emotions, 'grabbedRough', 1 - enjoy);
      world.events.push({ kind: 'grab', id: c.id, enjoy });
    } else {
      c.held = false;
      // speed 是"松手那一拍手有多快"—— 表现层拿它决定要不要出一声"哎呀"。
      // 没有手了（抬起）时读不到 speed，退回本个体的速度大小，那是同一件事的近似。
      world.events.push({ kind: 'release', id: c.id, enjoy,
        speed: senses.playerHand ? senses.playerHand.speed
          : Math.hypot(c.vel.x, c.vel.y) });
    }
  }
  if (heldNow) {
    const eff = carryEffects({
      enjoy: enjoyOf(c, affectionFor(c.memory, PLAYER_ID)),
      speed: senses.playerHand.speed, dt,
    });
    // 三个情绪各自钳位；这里刻意**不**用 applyEvent —— 它是"一次冲击"的形状，
    // 而摇是连续累积，走 inertia 那条路会让 60Hz 与 120Hz 攒出不同结果。
    c.emotions.joy = clamp01(c.emotions.joy + eff.joy);
    c.emotions.anger = clamp01(c.emotions.anger + eff.anger);
    c.emotions.fear = clamp01(c.emotions.fear + eff.fear);
    if (eff.affection > 0 || eff.familiarity > 0) {
      adjustMemory(c.memory, PLAYER_ID, eff.affection, eff.familiarity);
    }
  }

  // ---- 抚摸（spec §6.1）----
  // 温柔的手**贴着身体**才算摸：贴着才买好感，靠近只买熟悉度。
  // 这条分工是 spec §6.1 的全部要点（"温柔与否有区别"），也是"挂机刷好感"
  // 不会被实现的原因 —— 合并成一条通道的话，把手放在屏幕边上就能喂满好感度。
  if (isBeingPetted(c, senses)) {
    adjustMemory(c.memory, PLAYER_ID, CONFIG.behavior.petAffectionRate * dt, 0);
    if (!c.beingPetted) {
      c.beingPetted = true;
      applyEvent(c.emotions, 'petted');   // 上升沿一次：petted 从计划 1 起就没有生产者
    }
  } else {
    c.beingPetted = false;
  }

  // ---- 戳（spec §6.1）----
  // "抚摸与戳是同一根手指、不同速度，反应完全相反" —— 这条区分是整个交互的核心。
  // 一次戳同时做三件事：poked 情绪冲击（fear+ anger+ joy−）、safety 受冲击
  // （needs.startle，它从计划 1 起也没有消费者）、以及**不买好感**。
  if (isPoking(c, senses)) {
    if (!c.beingPoked) {
      c.beingPoked = true;
      applyEvent(c.emotions, 'poked');
      startleNeeds(c.needs, CONFIG.needs.startleAmount);
      world.events.push({ kind: 'poke', id: c.id });   // 给表现层：它会躲开或抗议（B16/B17 的读道）
    }
  } else {
    c.beingPoked = false;
  }

  // ---- 惊吓（手突然出现）----
  // `appeared` 是 input 层的一次性读数（第一帧之后自己变 false），所以这里不需要
  // 内核侧的上升沿状态 —— 生产者已经保证了"一次"。
  // 距离门用感知半径而不是接触半径：突然出现在它旁边就够吓一跳，不必真的碰到。
  if (senses.playerHand && senses.playerHand.appeared
      && senses.playerHand.dist <= CONFIG.perceiveRadius) {
    applyEvent(c.emotions, 'startled');
  }

  const petting = isPettingNear(c, senses);
  if (petting || !senses.playerHand) {
    c.begIgnored = 0;
  } else {
    const before = c.begIgnored;
    c.begIgnored = before + dt;
    const { protestAfter } = CONFIG.behavior.begEscalate;
    if (before < protestAfter && c.begIgnored >= protestAfter) applyEvent(c.emotions, 'ignored');
  }

  lookAtHand(c, senses, dt);

  decayNeeds(c.needs, dt, c.traits, {
    moving: c.moving,
    resting: c.resting,
    drainFactor: c.thresholds.energyDrainFactor,
    companions: senses.neighbors.length,
  });

  updateEmotions(c.emotions, computeTargets(c.needs, emotionCtx(c, senses), c.traits), dt);

  // 憋卵计时（孤雌）。broodScore 读它，产卵结算时归零。
  // 原来这段是 tickCourtship + courtshipCompleted/courtshipPartnerId 两个一次性标记，
  // 那是"双方都要在同一 tick 标记完成才算成功"的配对协议 —— 没有对象就没有协议。
  c.broodT = (c.broodT || 0) + dt;
  if (c.mourn > 0) c.mourn = Math.max(0, c.mourn - dt);

  // 出词（spec §4.13.1）。放在情绪更新与哀悼计时**之后**：moodOf 读的必须是本 tick 的新情绪，
  // 而 adversity 要读刚减过一次的 mourn —— 否则说的话慢一帧，且会在哀悼结束的那一 tick
  // 多冒一句"呜呜"。成本有界：maybeSay 在冷却没到期时一次随机数都不抽、也不组装。
  speak(world, c, senses);

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

// ---------------------------------------------------------------- 外来血统漂入

// 孤雌是**自体合并**，杂合度按 (1/2)^t 衰减；漂入是多样性的唯一外部补给。
// 没有它，缸不会灭绝（闸门已经删了），但会**单调**：颜色趋同、花纹分化消失、
// 隔代惊喜枯竭（spec §9.2 第 3 条）。判据与实测在 tests/sim.test.js 的漂入组。
//
// 漂入物是**一枚来历不明的蛋**，不是成年访客（控制方裁定 §13.2 第 5 条）：
// 直接漂入一只亚成体会在家谱里凭空造出一个没有母亲的成年个体，
// 而蛋天然带"来历不明"的叙事，且要孵化才入场 —— 玩家看得见它来。
function maybeDrift(world) {
  if (!(world.time >= world.nextDriftAt)) return;
  // 截止点先推进再决定进不进：满员时这一格可能腾不出来，但绝不能让它
  // 下一 tick 又立刻到期而每帧重查。
  world.nextDriftAt += world.driftInterval;
  if (aliveCreatures(world).length >= world.populationCap) {
    // 控制方裁定 C（2026-10-20）：满员时不放弃，而是让**最老的老年个体**顺水流漂走，
    // 给新血统腾出这一格。实测依据：缸一旦跑起来就长期钉在上限（24/24、cap=12 时 12/12），
    // 原来的"满员就跳过"让 40 个漂入窗口全部落空、开与关的模拟逐字节相同 —— 那等于没有漂入。
    //
    // 为什么必须是老年：① spec §4.11 里它本来就不再繁殖，移走它对种群产量影响最小；
    // ② "挤走一只幼体/成体"读起来是掠食或杀婴，不是"水流带来一位新客人"。
    // 找不到老年个体就**这一轮放弃** —— 宁可不进，也不悄悄降低标准去搬一只成体。
    const elder = pickEmigrant(world);
    if (!elder) return;
    emigrate(world, elder);
  }

  const genes = randomGenome(world.rng);
  const { min, max } = CONFIG.eggSize;
  world.driftCount += 1;
  world.eggs.push({
    id: `e-drift-${world.driftCount}`,
    genes,
    age: 0,
    pos: {
      x: clampPos(world.rng.range(0.08, 0.92)),
      y: clampPos(world.rng.range(0.78, 0.97)),
    },
    // motherId 为 null 是**特征不是缺陷**：家谱图上这一支就是悬空的起点，
    // 玩家一眼能看出"这支是外来的"（spec §6.3 家谱那条）。
    motherId: null,
    fatherId: null,
    eggSize: (min + max) / 2,
    eggTint: eggTintBucket(phenotype('eggTint', genes.eggTint)),
    viable: true,
    drift: true,
  });
  world.stats.driftIns += 1;
  world.events.push({ kind: 'drift', id: `e-drift-${world.driftCount}` });
}

/* 漂入需要 randomGenome / phenotype / eggTintBucket，见文件头 import */

// 满员腾位时挑的是"最老的那只老年个体"，而不是"第一个 elder"：
// 后者会让种群列表头部的某一只反复被选中（列表顺序由加入顺序决定，与年龄无关）。
function pickEmigrant(world) {
  let best = null;
  for (const c of aliveCreatures(world)) {
    if (c.stage !== 'elder' || c.sick) continue;
    if (!best || c.age > best.age) best = c;
  }
  return best;
}

// 漂走 ≠ 死亡：不记 stats.deaths、不发 death 事件、不触发周围个体的哀悼
// （spec §4.11 的哀悼明确挂在"死亡"上）。dying 直接给到溶解时长，
// 所以本 tick 末尾的 reapDead 就把它收走，下一 tick 的死亡闸门也不会补跑 onDeath。
function emigrate(world, c) {
  c.alive = false;
  c.emigrated = true;
  c.dying = CONFIG.dissolveDuration;
  world.stats.emigrations += 1;
  world.events.push({ kind: 'emigrate', id: c.id, age: c.age });
}

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
      // 名字序号 = 这只母亲**已经孵出来几只**。原来恒传 0，于是同窝全叫一个名
      // （症状：玩家以为改名功能坏了，而 §9.2 第 2、3 条都要靠"叫得出谁是谁"）。
      // 母亲已经溶散时退回"扫一遍还有谁认她当妈"，不然那一窝又会全部撞在一起。
      const nameIndex = mother
        ? mother.lineage.offspring.length
        : world.creatures.filter((x) => x.lineage && x.lineage.mother === egg.motherId).length;
      const baby = hatch(egg, world.rng, { nameFor: world.nameFor, generation, nameIndex });
      addCreature(world, baby);
      // 出生即去重：老存档里那批同名的个体也在这一步被理顺（dedupeNames 不动玩家取的名）。
      dedupeNames(world);
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

// ---------------------------------------------------------------- 社交同步

// spec §4.12 第 6 条的"socialize 高级表现"：两只吃饱、互相有好感、都开心的个体
// 会自发同步脉动；跨过顶点响一记小铃（audio.js 的 synced → bell），
// 长期凑在一起的互相成为 companion（家谱虚线与信息卡"同伴"行的生产者）。
// 设计与六条裁定见 docs/superpowers/specs/2026-10-27-social-bond-sync-design.md。
//
// **逐只**遍历而不是成对遍历，两个理由：
//   1. 没在跟任何人同步的那些也要衰减 —— 成对循环只走"凑上对的"，
//      漏掉的那一半会永远停在旧进度上（度卡在 1，铃随时可能再响一次）。
//   2. 每只只写**自己**这一侧（自己的 memory、自己的情绪），所以两只各跑一次
//      正好是完整的一笔，不需要"谁先谁后"或"别加两遍"这种约定。
// 事件去重靠 `a.id < b.id`：上升沿在两只身上可能不在同一 tick（各自的历史进度不同），
// 但只有 id 较小的一侧会放行 ⇒ 一次 episode 恰好一条。
function tickSocial(world, dt) {
  const alive = aliveCreatures(world);
  for (let i = 0; i < alive.length; i += 1) {
    const a = alive[i];
    const wantId = a.intent && a.intent.kind === 'socialize' ? a.intent.targetId : null;
    let b = null;
    if (wantId !== null && wantId !== undefined) {
      for (let j = 0; j < alive.length; j += 1) {
        if (alive[j].id === wantId) { b = alive[j]; break; }
      }
    }
    // 距离用世界坐标的欧氏距离：pairDist 是"凑在一起"的半径，与 socialize 的
    // stopDist（0.06）相容 —— 它们停在 0.06 处，仍在 0.09 之内。
    const dist = b === null ? NaN : Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    const near = Number.isFinite(dist) && dist <= CONFIG.social.pairDist;
    const ok = near && pairEligible(a, b, dist);
    const r = bondStep(a, ok ? b.id : null, ok, dt);
    if (near) {
      // §4.8 那道"互相有好感"（affMin）的**唯一生产者**：凑在一起待着就会熟络、慢慢生出好感。
      // 没有它，个体之间的 affection 全仓只有 resolve 里那笔 -0.01（碰撞的怨气）——
      // 2026-10-27 实测：10 分钟里互相 socialize 且贴在一起的有 24496 个个体·tick，
      // 而双向好感的最高值恒为 0.0000 ⇒ 同步永远不开始（60 分钟实跑 0 记铃、0 对伙伴）。
      // 只写**自己**这一侧：单向的 fondness 是允许的（家谱与升级仍要求双向）。
      adjustMemory(a.memory, b.id, CONFIG.social.idleAffectionRate * dt,
        CONFIG.social.familiarityRate * dt);
    }
    if (!ok) continue;

    const deg = r.degree;
    if (deg > 0) {
      // §4.8：同步脉动 → affection+。熟悉度同期上升（它们在互相认识）。
      adjustMemory(a.memory, b.id, CONFIG.social.affectionRate * deg * dt,
        CONFIG.social.familiarityRate * dt);
      // §4.5 那一行原文就是"社交高峰：与对方脉动同步、膨胀展示、全场最亮"，
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

// 裁定 3 的后两条要读世界（占位者还活着吗），所以判在这里、不放进 memory.js：
// memory 是纯的"关系账本"，它不知道谁还活着。
function promoteIfNeeded(world, c, partnerId) {
  const cur = companionOf(c.memory);
  if (cur !== null && cur.id !== partnerId) {
    let alive = false;
    for (const x of world.creatures) if (x.id === cur.id && x.alive) { alive = true; break; }
    if (alive) return;                       // 占位者还在 ⇒ 不换人（家谱虚线不该跳）
    demoteCompanion(c.memory, cur.id);
  }
  promoteCompanion(c.memory, partnerId);
}

// ---------------------------------------------------------------- 交互结算

function resolve(world, dt) {
  const alive = aliveCreatures(world);

  // （2026-10-20：自产卵的结算不在这里，在 executeIntent 的 case 'brood'。
  //   原来放在这里会导致产卵永远不发生 —— 理由那条注释写在 case 'brood' 里。）
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
        // 亲属偏好（spec §4.8/§4.12）：kinship > 0 的一对更容忍彼此靠近 ——
        // 推开、被撞的情绪冲击、好感罚三样一起打折（见 CONFIG.behavior.kin*）。
        // 判据只看"有没有亲缘"，不看角色：母子、同胞、祖孙都是 kinship > 0。
        const kin = kinshipBetween(a.memory, b.id) > 0 || kinshipBetween(b.memory, a.id) > 0;
        const kb = kin ? CONFIG.behavior.kinBumpScale : 1;
        const push = (minDist - d) / 2 * (kin ? CONFIG.behavior.kinPushScale : 1);
        const nx = dx / d;
        const ny = dy / d;
        a.pos.x = clampPos(a.pos.x - nx * push);
        a.pos.y = clampPos(a.pos.y - ny * push);
        b.pos.x = clampPos(b.pos.x + nx * push);
        b.pos.y = clampPos(b.pos.y + ny * push);

        // 2026-10-20：原来这里包着一层"求偶中的碰撞不算冲突"的豁免（仪式本来就要贴近）。
        // 没有仪式了，豁免条件恒真 —— 留着就是一段永不成立的分支在假装做事，所以直接摊平。
        applyEvent(a.emotions, 'bumped', 0.4 * kb);
        applyEvent(b.emotions, 'bumped', 0.4 * kb);
        // 记住这笔小账：好感轻微下降，多次碰撞才会累积成恩怨（亲属那边打得同样轻）
        adjustMemory(a.memory, b.id, -0.01 * kb, 0.02);
        adjustMemory(b.memory, a.id, -0.01 * kb, 0.02);
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
// 同胞/祖孙那一侧不在这里补：它原本由 mateScore 的谱系闸门兜住（不依赖缓存）；
// 孤雌改造后那道闸门已删，这里补的只是**记忆缓存**，供慢衰减通道与家谱使用。
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

  maybeDrift(world);
  tickEggs(world, dt);
  // 读的是本 tick 决策完的意图与移动后的位置；碰撞推开在它之后，
  // 所以"贴到 0.06 停下"的那个距离在这一步已经成立。
  tickSocial(world, dt);
  resolve(world, dt);
  reapDead(world, dt);
  // 放在最后：本 tick 里新建的关系条目（碰撞、拒绝、孵化）都已经写完，
  // 这一步保证"谁是它的父母"这条亲属事实在 tick 结束时一定在记忆里。
  refreshKinMemory(world);
}
