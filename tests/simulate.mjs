// 无头验收模拟器：跑一段模拟时间，打印种群的生老病死统计。
//
// 这不是单元测试 —— 它是**本计划自己的验收目标**的可执行证据。依据是 spec 4.11（寿命与阶段）
// 与 4.12（繁殖），**不是** spec 9.2 的成功标准。
//
// ⚠️ 2026-10-14 控制方裁定后，本文件断言的目标**已收窄**，别再按旧描述理解它：
//   旧目标："种群能自我延续到多代、不爆炸也不灭绝"。
//   新目标：**不爆缸**（峰值 ≤ 上限）、**色相全程锁在粉色区间**、**繁殖确实在发生**
//           （世代 ≥ 2 且出生 ≥ 2，这条抓的是 arousal 被循环门控锁死那类真死锁）。
//   "不灭绝"**不再是判据** —— 实测表明灭绝由结构决定、调参修不好（创始 4 只 → 5/8 灭绝，
//   8 只 → 3/8，12 只 → 2/8；机制是血统坍缩后被严格近亲回避冻结出生），
//   故裁定为**合法结局**：缸断了玩家开新缸。完整实测与否决过的调参路线见下方
//   验收断言处的注释，以及 src/config.js 里 initialCreatures 的注释。
//
// ⚠️ 更正：这里原先写"它是 spec 9.2 成功标准第 3、5 条的可执行证据"，那是错的 ——
//   §9.2 第 3 条是「你能看出孩子像谁，并且偶尔遇到一次隔代遗传的惊喜」（视觉/遗传，需要计划 2），
//   §9.2 第 5 条是「关掉三天再打开，它们还在你离开的那一秒」（需要计划 3 的存档与离线暂停）。
//   两条都不是"种群自我延续"。§9.2 的六条标准**没有一条**能由本计划兑现：
//   1/3/6 是视觉或涌现的，2 需要计划 2 的渲染，4 需要计划 2 的响应式布局，5 需要计划 3 的存档。
//   追溯表已同步更正，免得有人以为 §9.2 已被本计划覆盖。
//
// ── 这是**手动**验收门，不在 `node --test` 的覆盖范围内 ─────────────────────
//
// 「跨 Task 交接要求」第 4 条问的是：`node --test tests/` 会不会顺带跑起本文件？
// 答案是不会，理由是**文件名的模式不匹配**，不是靠别处的约定：
// Node v20.19.0 的 runner 在收到目录参数时，只挑匹配它内置测试文件模式的名字 ——
//   `**/*.test.{cjs,mjs,js}`、`**/*-test.*`、`**/test-*.*`、`**/test.*`，
//   以及 `test/` 目录下的文件（注意是 `test/`，不是本仓库的 `tests/`）。
// `tests/simulate.mjs` 一条都不匹配：没有 `.test` / `-test` / `test-` 标记，
// 目录名是 `tests` 而不是 `test`。这条结论有三份实测证据（都在本机 Node v20.19.0 上跑过）：
//   ① 加入本文件**前后**，`node --test tests/` 都是 382 条用例（本文件不贡献任何一条）；
//   ② 该命令的输出里没有本文件的表头/`✓ 验收通过`，即它确实没被执行；
//   ③ 一个直接的模式实验（`.superpowers/sdd/probe-tests/`，不进版本库）：
//      同目录下 aaa.mjs 未被拾取，而 bbb.test.mjs / ddd-test.mjs / test-ccc.mjs / test.mjs /
//      test/ddd.mjs 五个全被拾取 —— 与上面列的模式一一对上，
//      而 `tests/simulate.mjs` 与 `aaa.mjs` 同类（无标记 + 目录名不是 `test`）。
// 所以长模拟不会混进全量回归 —— 但**反过来说，种群循环坏了也只有手动跑才看得见**。
// 为了不让"哪只生物一出生就把世界搞停"这类问题溜到长模拟里才暴露，
// 另有一条廉价的门放在 `tests/sim.test.js`（'种群循环的廉价门 …' 一条）：
// 新缸跑 420 模拟秒必须真的孵出个体。本文件负责"跑久了会怎样"，那条门负责"它到底会不会跑"。
//
// 期望耗时（本机实测：Node v20.19.0 / Windows / 60Hz 固定步长，单线程；
// 数字就是脚本末尾那行"本次耗时"的值）。
//
// ⚠️ 2026-10-14 起基准**整体变了**，旧数字（默认种子 89.2 / 90.8 / 97.2s，种子 999 = 156.5s，
//   种子 31337 = 23.5s）已作废。两个原因，都是本轮改动的直接后果：
//   ① `tickEggs` 加了孵化时容量闸门 ⇒ 峰值由 47/52 降到**恰好 24**。每步成本随存活数增长
//     （碰撞是 O(n²)，感知是每个体一次网格查询），所以砍掉一半峰值把最慢的种子砍了约 2.4 倍：
//     种子 999 由 156.5s → **64.9s**。
//   ② `CONFIG.initialCreatures` 4 → 8 ⇒ 血统数上升、缸更容易撑住，于是"早早灭绝、后半程空转"
//     的种子变少了 —— 空转是最快的（每步几乎没有个体要算）。
// 本轮四个种子各跑一次（60 模拟分钟）：**20261014 = 29.5s（3472s 断代）、1 = 17.6s（2071s 断代）、
//   999 = 64.9s（存活到窗口结束）、31337 = 63.9s（存活到窗口结束）**。
// ⚠️ 注意耗时与种子结果的**关系已经反转**：旧基准里种子 31337 是最快的（23.5s），因为它早早灭绝；
//   现在它是最慢的一档（63.9s），因为它活着并把缸填满。**断代的缸跑得快，撑住的缸跑得慢** ——
//   所以判断"慢"要连着结果表里的存活数与灭绝时刻一起看，不能只看墙钟，
//   更不能拿"比旧基准快"当成性能改善的证据（那可能只是种群死光了）。
//   脚本末尾会打印本次实际耗时供对照，好让人区分"机器慢"和"它卡住了"。
//
// 运行：node tests/simulate.mjs [种子] [模拟分钟数]
//
// 两条边界（与内核契约一致，别在这里"优化"）：
//   · **不缩放 dt**：倍速必须用子步进实现（CONFIG.timeScales 属计划 2 的 main.js），
//     因为 emotions.update 是刻意不具步长无关性的前向欧拉（交接要求第 2 条）。
//   · **每步清空 world.events**：内核只写不读，无头运行没有表现层来取走它。

import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld, aliveCreatures, worldStats } from '../src/sim.js';
// adjust 只在"玩家羁绊观察"里用一次，用途写在那一节（内核买不到好感时才用得上）。
import { adjust, affectionFor, familiarityFor, PLAYER_ID } from '../src/memory.js';
// 抚摸/戳的速度阈值从 behavior 取，不写本地字面量：这个数在项目里原本有三份，
// 导出它（EAT_DIST 同理）就是为了不再有第二份。
import { HAND_SPEED_POKE } from '../src/behavior.js';

const wallStart = process.hrtime.bigint();

const seedArg = process.argv[2];
const minutesArg = process.argv[3];
const seed = Number(seedArg === undefined || seedArg === '' ? 20261014 : seedArg);
const minutes = Number(minutesArg === undefined || minutesArg === '' ? 60 : minutesArg);
// 手写参数要挡一下：Number('abc') 是 NaN，NaN 会经 rng 污染整个世界，
// 症状是一张全是 NaN 的表 + 一串莫名其妙的验收失败。直接说清楚用法更有用。
if (!Number.isFinite(seed) || !Number.isFinite(minutes) || minutes <= 0) {
  console.error('用法：node tests/simulate.mjs [种子] [模拟分钟数]');
  console.error(`收到：种子=${String(seedArg)} 分钟=${String(minutesArg)}（两者都必须是有限数，分钟数需 > 0）`);
  process.exit(2);
}

const dt = CONFIG.fixedDt;
const totalSteps = Math.round((minutes * 60) / dt);
const reportEvery = Math.round((5 * 60) / dt);      // 每 5 模拟分钟报告一次

const world = createWorld({ seed });

console.log(`种子 ${seed} · 模拟 ${minutes} 分钟 · 上限 ${world.populationCap}`);
console.log('─'.repeat(74));
console.log(
  '时刻    存活  卵  食物  出生  死亡  孵化失败  拒绝  世代  最老个体',
);
console.log('─'.repeat(74));

let extinctAt = -1;
let peak = 0;
// 色相区间用两个累加器，**不留样本数组**。
// 原先这里是 `hueSamples.push(c.traits.hue)`：每个成体每一步都 push，
// 60 分钟 × 最多 24 只 ≈ 216000 × 24 ≈ 5×10^6 个数只为了最后算一次 min/max，
// 长跑时白白吃掉几百 MB。累加器给出完全相同的 min/max，内存是常数。
let hueMin = Infinity;
let hueMax = -Infinity;
let hueSampleCount = 0;
// ⚠️ 但 min/max **不足以**判定色相是否全程合法 —— 粉色区间是 `315–360 ∪ 0–25`，
// 是**跨 0° 的并集**，不是一段连续区间。实测两个种子的极值分别是
// `0.1° – 359.4°` 与 `1.3° – 357.9°`：最小值落在 0–25、最大值落在 315–360，
// 两个端点都合法 ⇒ 只查 hueMin/hueMax 会**放行任何中间值**（比如 150° 完全不会被发现，
// 因为它既不改变 min 也不改变 max）。
// 所以另加一个**违例计数器**：它逐个样本判定，才是 spec 4.2「色相永远锁在粉色区间」的真正证据。
// hueMin/hueMax 保留，但只用于**显示**范围，不再承担判定职责。
let hueViolations = 0;
let hueFirstViolation = null;

for (let step = 0; step <= totalSteps; step++) {
  if (step > 0) tickWorld(world, dt);
  // 表现层会消费 events 后清空；无头运行时也必须清，否则队列无限增长
  world.events.length = 0;

  const alive = aliveCreatures(world);
  peak = Math.max(peak, alive.length);

  if (alive.length === 0 && extinctAt < 0) extinctAt = step * dt;

  for (const c of alive) {
    if (c.stage === 'adult') {
      // Math.min/max 对 NaN 是"传染"的：一旦某个 hue 是 NaN，累加器就变 NaN，
      // 末尾的区间检查会因此失败（见下方断言里的比较形式说明）。
      if (c.traits.hue < hueMin) hueMin = c.traits.hue;
      if (c.traits.hue > hueMax) hueMax = c.traits.hue;
      hueSampleCount += 1;
      // **逐个样本**判定，这才是 spec 4.2 的证据（min/max 判不出跨 0° 并集里的中间违例，
      // 见 hueViolations 声明处的注释）。沿用 `!(x >= 315 || x <= 25)` 这一形状：
      // NaN 对两个比较都是 false，取反后为真 ⇒ NaN 一样会被计成违例，不会静默通过。
      if (!(c.traits.hue >= 315 || c.traits.hue <= 25)) {
        hueViolations += 1;
        if (hueFirstViolation === null) {
          hueFirstViolation = { name: c.name, hue: c.traits.hue, at: step * dt };
        }
      }
    }
  }

  if (step % reportEvery === 0) {
    const s = worldStats(world);
    // 最老个体：表头写的是「最老个体」，所以这一列要打印**那一只**的年龄与名字。
    // 原先打印的年龄来自 reduce 求最大、名字却取 alive[0].name —— 那是"插入顺序最早的
    // 幸存者"。本内核只按投放/孵化顺序追加个体、且 age 与时间同步推进，两者目前恰好
    // 同一个人，但那是巧合而不是契约（没有测试钉住"插入顺序即年龄顺序"）。
    // 一次遍历同时取年龄与对象，就不会再出现表头说了 A、列里印了 B 的错位。
    let oldest = null;
    for (const c of alive) if (!oldest || c.age > oldest.age) oldest = c;
    const mm = String(Math.floor(s.time / 60)).padStart(2, '0');
    const ss = String(Math.floor(s.time % 60)).padStart(2, '0');
    console.log(
      `${mm}:${ss}   `
      + `${String(s.alive).padStart(4)}  `
      + `${String(s.eggs).padStart(3)}  `
      + `${String(s.foods).padStart(4)}  `
      + `${String(s.births).padStart(5)}  `
      + `${String(s.deaths).padStart(5)}  `
      + `${String(s.hatchFailures).padStart(9)}  `
      + `${String(s.rejected).padStart(5)}  `
      + `${String(s.generation).padStart(5)}  `
      + `${(oldest ? oldest.age.toFixed(0) : '0').padStart(7)}s  `
      + (oldest ? oldest.name : '—'),
    );
  }
}

// 模拟窗口结束时的状态快照。**下面的玩家羁绊观察会继续推进世界**（多跑 15 分钟以上），
// 所以结果块、断言、幸存者名单一律用这份快照，不能在那之后再读 world ——
// 否则会打印出"已经死掉、年龄被 clamp 在寿命上限"的个体，还把标着「幸存者」的名单
// 变成一份讣告（这处错位原先就是这样：`alive` 在观察之前取，在观察之后打印）。
const s = worldStats(world);
const alive = aliveCreatures(world);
const survivorLines = alive.slice(0, 8).map((c) => {
  const p = c.traits.personality;
  const dominant = ['bold', 'clingy', 'irritable', 'gluttonous', 'curious', 'libido']
    .sort((a, b) => p[b] - p[a])[0];
  return `  ${c.name.padEnd(10)} 第${c.generation}代  ${c.stage.padEnd(10)} `
    + `${c.age.toFixed(0).padStart(4)}s  hue ${c.traits.hue.toFixed(0).padStart(3)}°  `
    + `${c.traits.pattern.padEnd(7)} 性格偏${dominant}`;
});

console.log('─'.repeat(74));
console.log('结果');
console.log(`  最终存活     ${s.alive}`);
console.log(`  峰值种群     ${peak}`);
console.log(`  累计出生     ${s.births}`);
console.log(`  累计死亡     ${s.deaths}`);
console.log(`  孵化失败     ${s.hatchFailures}  （达种群上限所致）`);
console.log(`  求偶被拒     ${s.rejected}`);
console.log(`  最高世代     ${s.generation}`);
console.log(`  灭绝时刻     ${extinctAt < 0 ? '未灭绝' : extinctAt.toFixed(0) + 's'}`);

if (hueSampleCount > 0) {
  console.log(`  色相范围     ${hueMin.toFixed(1)}° – ${hueMax.toFixed(1)}°  `
    + `（${hueSampleCount} 个成体·步样本；粉色区间 315–360 / 0–25）`);
}

// ── 玩家羁绊观察（交接要求第 8 条）───────────────────────────────────────────
//
// 这一节存在的唯一理由：spec 4.8 让玩家那条记忆的 affection 按**普通速率**衰减
// （CONFIG.affectionDecay = 0.02，半衰期 ln2/0.02 ≈ 34.657 秒），
// 而 familiarity 与淘汰被豁免（人类裁定）。那条裁定留下一句"待观察实跑后再定速率"，
// 所以这里必须真的把它打印出来，否则那个决定永远无法用证据复核。
//
// 做法：挑一只幸存者，先**抚摸 20 秒**（手速低 = 抚摸，spec 4.6），
// 再**完全不互动地推进 15 分钟**，按 1/2/5/10/15 分钟采样好感，
// 打印衰减曲线与实测半衰期，供人对照"亲属级慢速率 346.574 秒"决定要不要改。
//
// ⚠️ 实跑发现（**已修复，保留记录**）：
//   本节最初的实跑结果是"抚摸 20 秒买不到任何好感"：beg 的效用分被 explore/forage/socialize
//   压着，**一次都没胜出**（20 秒里 beg 胜出 0 tick；7 只幸存者逐个试、延长到 300 秒也全是 0）。
//   而好感在内核里只有一条来源 —— sim.js 对 PLAYER_ID 的 adjustMemory 只有 beg 分支
//   传了非零 dAffection（温柔的手那一段只给 familiarity），于是 affection 恒为 0，
//   卖萌的门 (affection > 0.1 || familiarity > 0.3) 就永远打不开 —— 死锁。
//   根因是 **beg 被放在了错误的量级上**：它的最高分（≈0.15）低于缸里普通活动的地板
//   （explore 0.4~0.6、socialize 1~2、court 3~4），根本排不上号。
//   已把 CONFIG.behavior.begUrgency 从 1.3 调到 7.0（扫值数据见 src/config.js 的注释），
//   现在实测：合适个体抚摸 20 秒 beg 胜出约 58%、affection 升到 0.21。
//   所以这一节下面：
//     ① 先如实打印"抚摸 20 秒买到了多少"与 beg 胜出的 tick 数（**现在应当非 0**）；
//        若打印出 0，说明 begUrgency 又被调回不可达的量级，或选中的个体不肯靠近玩家。
//     ② 再**注入一个已知好感**（经公开的 memory.adjust，不是手伸进 entries）测衰减本身，
//        这样即使 ① 因为个体差异买不到，第 8 条要观察的那个**速率**依然拿得到数据。
//   两件事分开打印、分别标注：① 是"能不能买到"，② 是"买到之后掉多快"。
if (alive.length) {
  // 挑观察对象：在**卖萌够得着**的个体里挑**剩余寿命最长**的那只。
  // 三个条件都是有理由的：
  //   ① beg 的评分含因子 Math.max(0, thresholds.playerApproach)（值域最低 −0.35）——
  //      抽到 ≤ 0 的个体，这一节必然是一条全 0 的平线，看起来像"羁绊一碰就碎"，
  //      真相却是"它从来不肯靠近你"（spec 4.9：暴躁/胆小的本来就躲手）。
  //   ② 只是 "> 0" 还不够：beg 分 = (0.2 + affection + familiarity×0.4) × playerApproach
  //      × begUrgency × (0.5 + joy×0.5)，**整条乘积**才决定它能不能压过 explore（地板 0.4~0.6）。
  //      实测两个例子（begUrgency 都已是 7.0）：
  //        playerApproach 0.182 + familiarity 1.000 → beg ≈ 0.72~0.96 ⇒ 胜出 505/1200 tick（买得到）
  //        playerApproach 0.096 + familiarity 0.800 → beg ≈ 0.26      ⇒ 胜出   0/1200 tick（买不到）
  //      所以 0.2 是**保守裕度**而不是锐利阈值（0.182 其实也够）。这里取与
  //      tests/sim.test.js 那条卖萌测试**完全相同**的筛选条件（playerApproach > 0.2 且 age < 900），
  //      免得两处各挑各的、一处能复现一处不能。
  //   ③ **剩余寿命最长**这一条是实跑补上的：主模拟跑完时整缸常常都是 973~1011 的老年个体
  //      （寿命 1140），挑谁都会在 15 分钟的停手观察里老死，曲线被截断。
  // ⚠️ 原先这里的注释写着"所以挑最愿意靠近的那只"，但代码是 `.sort((a,b) => a.age - b.age)`
  //   ——**按年龄挑最年轻的**，playerApproach 只当并列时的次级键。注释描述的意图代码从没实现，
  //   后果就是 seed 31337 实测挑中 playerApproach=0.096 的个体、beg 0/1200，
  //   然后打印"好感买不到 ⇒ 见 begUrgency"，把一个**选错观察对象**的问题误报成常量又被调坏了。
  const BEG_REACHABLE = 0.2;      // 保守裕度，与 tests/sim.test.js 的卖萌测试同口径
  const reachablePool = alive.filter((c) => c.thresholds.playerApproach > BEG_REACHABLE && c.age < 900);
  const willingPool = alive.filter((c) => c.thresholds.playerApproach > 0);
  const pool = (reachablePool.length ? reachablePool : (willingPool.length ? willingPool : alive)).slice()
    .sort((a, b) => (a.age - b.age) || (b.thresholds.playerApproach - a.thresholds.playerApproach));
  const pet = pool[0];
  // 这只到底够不够得着卖萌 —— 决定下面 beg 0/1200 该归因给谁
  const petCanBeg = pet.thresholds.playerApproach > BEG_REACHABLE;
  console.log('\n玩家羁绊观察（交接要求第 8 条）');
  console.log(`  观察对象     ${pet.name}（playerApproach=${pet.thresholds.playerApproach.toFixed(3)}`
    + `，age=${pet.age.toFixed(0)}s（剩余约 ${Math.max(0, 1140 - pet.age).toFixed(0)}s）`
    + `，stage=${pet.stage}）`
    + (petCanBeg ? '' : ` ← playerApproach ≤ ${BEG_REACHABLE}（实测可达裕度），这只**本来就卖不了萌**`
      + '，下面的 beg 计数与好感必然是 0，属预期而非缺陷'));

  // 抚摸阶段。手速取 HAND_SPEED_POKE 的一个零头（0.01），稳稳落在"抚摸"一侧。
  const petSteps = Math.round(20 / dt);
  let begTicks = 0;
  world.playerHand = { pos: { x: pet.pos.x, y: pet.pos.y }, speed: HAND_SPEED_POKE * 0.04 };
  for (let i = 0; i < petSteps; i++) {
    world.playerHand.pos.x = pet.pos.x;
    world.playerHand.pos.y = pet.pos.y;
    tickWorld(world, dt);
    world.events.length = 0;
    if (pet.intent && pet.intent.kind === 'beg') begTicks += 1;
  }
  world.playerHand = null;

  const a0 = affectionFor(pet.memory, PLAYER_ID);
  const f0 = familiarityFor(pet.memory, PLAYER_ID);
  console.log(`  抚摸 20s      beg 胜出 ${begTicks}/${petSteps} tick`
    // ⚠️ 这里原先无条件写"beg 一次都没胜出 ⇒ 好感买不到；见 begUrgency"。
    // 那句归因在"选中的个体本来就卖不了萌"时是**错的**，会把一个观察对象选择问题
    // 误报成常量又被调坏（seed 31337 实测就是这么被误报的：playerApproach=0.096）。
    // 所以按 petCanBeg 分两种说法，各自指向真正该查的地方。
    + (begTicks === 0
      ? (petCanBeg
        ? '（beg 一次都没胜出，而这只 playerApproach 已过实测可达裕度 ⇒ 先怀疑 begUrgency 又被调回不可达量级）'
        : `（beg 一次都没胜出，但**不是** begUrgency 的问题：这只 playerApproach=${pet.thresholds.playerApproach.toFixed(3)}`
          + ` ≤ ${BEG_REACHABLE}，beg 分被这个因子压到 explore 地板（0.4~0.6）之下 ⇒ 是观察对象选得不对，见上方标注）`)
      : ''));
  console.log(`  抚摸 20s 后   affection=${a0.toFixed(4)}  familiarity=${f0.toFixed(4)}`);

  if (!pet.alive) {
    console.log('  （观察对象在抚摸期间死亡，跳过衰减采样）');
  } else {
    // ② 注入已知好感，测衰减本身。
    const INJECTED = 0.5;
    // dFamiliarity 传 0：这只是"当前好感"的变化，不该顺带让它更认识你
    //（与 memory.adjust 的注释同一条约定）。
    adjust(pet.memory, PLAYER_ID, INJECTED, 0);
    const aStart = affectionFor(pet.memory, PLAYER_ID);
    console.log(`  注入起始值     affection ${a0.toFixed(4)} → ${aStart.toFixed(4)}`
      // ⚠️ 这里原先写"因为抚摸买不到，见上一行"。`begUrgency` 1.3→7.0 之后那句话**已经不成立** ——
      //   实测 seed 31337 抚摸 20 秒就买到了 affection=0.0955（beg 胜出 301/1200 tick），
      //   seed 999 买到 0.1503（beg 胜出 505/1200）。留着就是在教错人：
      //   它会让人以为注入是为了绕过一个仍然存在的缺陷。
      // 注入的**真正**理由与"买不买得到"无关：交接要求第 8 条要观察的是**衰减速率**，
      //   而速率必须从一个**已知**起点测才准 —— 抚摸买到的量随个体性格与当时情绪而变，
      //   拿它当起点就没法与理论半衰期 ln2/0.02 对表。所以无论 ① 买到多少，这里都注入到已知值。
      + `（memory.adjust，dFamiliarity=0；目的是给衰减一个**已知起点**，好与理论半衰期对表 ——`
      + ` 与上一行"买到了多少"无关：① 测能不能买到，② 测买到之后掉多快）`);
    console.log(`  CONFIG.affectionDecay=${CONFIG.affectionDecay} → 理论半衰期 ${(Math.LN2 / CONFIG.affectionDecay).toFixed(3)}s`
      + `（对照：亲属级 ${CONFIG.affectionDecayKin} → ${(Math.LN2 / CONFIG.affectionDecayKin).toFixed(3)}s）`);

    // 采样点按**绝对**时刻推进到 1/2/5/10/15 分钟（累计 15 分钟）。
    // 这一处必须显式累计已推进的秒数：brief 原先写的是每轮推进 `min*60`，
    // 而 min 是绝对采样时刻 ⇒ 实际一共推进 1+2+5+10+15 = 33 分钟，标签也与时刻不符。
    // 这不是理论问题，实测看得出来：按 brief 的写法，"停手 2 分钟"那一行的好感是
    // 0.013662 = 0.5·exp(−0.02×180)，也就是**已经衰减了 180 秒**而不是 120 秒
    //（种子 20261014 / 5 分钟窗口，注入 0.5 后读回的值）。改成绝对时刻之后，
    // 每个采样点的实测半衰期都应当等于理论值 34.657s。
    let elapsed = 0;
    for (const min of [1, 2, 5, 10, 15]) {
      const target = min * 60;
      const steps = Math.round((target - elapsed) / dt);
      for (let i = 0; i < steps; i++) {
        tickWorld(world, dt);
        world.events.length = 0;
      }
      elapsed += steps * dt;
      const a = affectionFor(pet.memory, PLAYER_ID);
      // 实测半衰期只在这一只还活着、且好感还没下溢到 0 时才有意义：
      // 它一旦死亡，tickCreature 不再碰它的记忆（死亡与 sick 个体在 tickWorld 里被跳过），
      // 衰减就停了，后面的读数是一条平线 —— 那不是"衰减停了"，是"没人再衰减它了"。
      const halfLife = pet.alive && a > 0
        ? Math.LN2 / (Math.log(aStart / a) / elapsed)
        : NaN;
      console.log(`  停手 ${String(min).padStart(2)} 分钟后  affection=${a.toFixed(6)}`
        + `  familiarity=${familiarityFor(pet.memory, PLAYER_ID).toFixed(6)}`
        + `${Number.isFinite(halfLife) ? `  实测半衰期 ${halfLife.toFixed(3)}s` : ''}`
        + `${pet.alive ? '' : '   ← 观察对象已死亡，此后不再衰减，上面的半衰期不再可信'}`
        + `${a < 0.01 ? '   ← 已基本淡忘，"卖萌"将不再触发' : ''}`);
    }
  }
} else {
  console.log('\n玩家羁绊观察（交接要求第 8 条）');
  console.log('  （模拟窗口结束时缸里没有任何幸存者 —— 没有对象可观察。）');
  // ⚠️ 这里原先写"种群先爆缸、再成批老死"。爆缸已由 src/sim.js 的孵化时容量闸门修好
  // （实测峰值由 52/47/30/29 降到一律恰好 24），所以那个归因已经不成立、会教错人。
  // 现在空缸的原因是**血统坍缩**：单一亲缘组 + 严格近亲回避 ⇒ 出生冻结 ⇒ 整批老死。
  console.log('   这本身就是观察结果：种群断代、最后一只老死之后，"它认不认得你"无从谈起。');
  console.log('   （2026-10-14 起断代是**合法结局**、不是缺陷；机制见下方验收断言处的注释。）');
}

if (survivorLines.length) {
  console.log(`\n幸存者（模拟 ${minutes} 分钟结束时的快照）`);
  for (const line of survivorLines) console.log(line);
}

// ---- 自动断言：这个脚本本身就是验收，不合格要以非零码退出 ----
const failures = [];

// ⚠️ 2026-10-14 控制方裁定：**灭绝不再是验收失败，它是一个合法结局。**
// 这条原先是 `failures.push(...)`，把"种群自我延续"当成本计划的验收目标；
// 但 spec §9.2 的六条验收依据里**没有**这一条（1/3/6 是视觉或涌现、2 需计划 2 渲染、
// 4 需计划 2 响应式、5 需计划 3 存档）—— 它是计划**自定**的目标，不是 spec 义务。
// 实测（8 个种子 × 60 分钟，`.superpowers/sdd/diag-founders2.mjs`）表明它由**结构**决定、
// 调参修不好：创始 4 只 → 灭绝 5/8（平均只有 7.00 位不同母亲）；
// 8 只 → 3/8（10.13）；12 只 → 2/8（13.13）。单调，且恰好在实测存活门槛
// （母亲数 ≥ 10 全活、≤ 7 全灭）处转折。
// 机制是**血统坍缩**：母亲数不足 ⇒ 全缸变成单一亲缘组 ⇒ `kinship > 0.25` 的严格近亲回避
// 把**每一对**都挡掉（seed 999 在 t=1440：11 只成体、55/55 个成体配对全被谱系近亲挡掉；
// seed 31337 末态 5 只的亲缘分布是 {"0.5":10}，出自同一个母亲）⇒ 出生冻结 ⇒ 整批老死。
// 已被实测排除的调参路线（别再重推一遍）：错开创始年龄（4 种方案全是 4/8，年龄结构不是杠杆）、
// 把容量判定从产卵时移到孵化时（灭绝 4/8 → 5/8，**更差**）、调 crowding 的 onset 与下限
// （"完全无压制"对照与基线**持平** 5/8）。
// 裁定同时把 CONFIG.initialCreatures 由 4 调到 8（实测数据见 src/config.js 的注释），
// 让"存活"成为常态、"断代"成为偶尔发生的、有戏剧性的结局 —— 这也正是 spec §9.2 #6
// 「你会舍不得让某一只死掉」想要的情绪。缸断了，玩家开新缸。
if (extinctAt >= 0) {
  console.log(`\n⚠ 观察（按裁定**不计为**验收失败）：种群在 ${extinctAt.toFixed(0)}s 灭绝了。`);
  console.log('   这是合法结局，机制是血统坍缩成单一亲缘组后被近亲回避冻结出生。');
  console.log(`   本次：出生 ${s.births} 只、最高第 ${s.generation} 代、峰值 ${peak} 只。`);
}
if (s.generation < 2) {
  failures.push(`只到第 ${s.generation} 代 —— ${minutes} 分钟内应至少繁衍一代`);
}
if (s.births < 2) {
  failures.push(`只出生了 ${s.births} 只 —— 繁殖几乎没发生`);
}
if (peak > world.populationCap) {
  failures.push(`峰值 ${peak} 超过上限 ${world.populationCap}`);
}
// 色相区间的两种写法都刻意用 `!(x >= 315 || x <= 25)` 这一形状：
// 两个比较对 NaN 都是 false，取反后为真 —— 所以 **NaN 会被抓出来**。
// 若改写成 `x < 315 && x > 25` 之类，NaN 会静默通过（两个比较还是 false），
// 这正是本项目里 clamp01 放过 NaN 的老问题，别在这里重演。
for (const c of alive) {
  if (!(c.traits.hue >= 315 || c.traits.hue <= 25)) {
    failures.push(`${c.name} 的色相 ${c.traits.hue} 跑出了粉色区间`);
  }
}
// ⚠️ 这里原先是两条 min/max 断言（查 hueMin 与 hueMax），注释还写着
//   "累加器覆盖整段模拟里每个成体的每一步，所以这条断言才兑现了 spec 4.2"。
//   **覆盖**那半句是对的，**结论**那半句是错的：粉色区间是 `315–360 ∪ 0–25`，
//   跨 0° 的**并集**，不是一段连续区间。只查两个端点，任何落在 (25, 315) 的中间值
//   都不会改变 min 也不会改变 max ⇒ **静默放行**。实测数据正好是这个形状：
//   seed 20261014 = `0.1° – 359.4°`、seed 1 = `1.3° – 357.9°`、seed 31337 = `0.4° – 359.9°`，
//   三个种子的极值全都合法，于是旧断言全过 —— 它对中间有没有 150° 一无所知。
// 现在改查**违例计数**：逐样本判定，才真正兑现 spec 4.2「色相永远锁在粉色区间」。
// hueMin/hueMax 保留但只用于显示范围（上方"色相范围"那行），不再承担判定职责。
if (hueSampleCount > 0 && hueViolations > 0) {
  failures.push(`全程有 ${hueViolations}/${hueSampleCount} 个成体·步样本的色相跑出了粉色区间`
    + `（首个违例：${hueFirstViolation.name} hue=${hueFirstViolation.hue}`
    + ` @ ${hueFirstViolation.at.toFixed(0)}s）`);
}

console.log('');
if (failures.length) {
  console.log(`验收未通过（${failures.length} 项）：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  // 「峰值超上限」这一条现在是**真正的回归探测器**，不再是"与内核设计冲突的判据"。
  // 2026-10-14 控制方裁定：叙事化的是 spec 4.12 第 6 条那**两条机制**
  // （达上限后求偶评分被压低、卵的光慢慢熄灭），而"活体数不超过上限"本来就是硬约束，
  // 两者可以并存 —— 所以这条判据不必放宽。
  // ⚠️ 这里原先有一大段解释，说超调是设计内的既有行为、不要去"修"，还引用了
  //   tests/breeding.test.js 里"cap-1 时产卵会让种群冲到 cap+2"的注释。
  //   那段话在 src/sim.js 的 tickEggs 加了**孵化时容量闸门**之后已经**不成立**，
  //   留着就是在教错人（会让人以为爆缸是刻意的、从而去"恢复"一个已修好的缺陷）。
  // 实测：加闸门前 4 个种子峰值 52 / 47 / 30 / 29（上限 24，冲到两倍以上）；
  //   加闸门后同口径 0/12 个种子超上限、峰值一律恰好 24；
  //   crowding 的 5 个变体（含"完全无压制"对照）也全部 0/8 超上限
  //   ⇒ 管住上限的是那道闸门，不是 crowding。
  // 根因：addCreature 刻意不查上限，而 layEggs 的 viable 是在**产卵那一刻**判的，
  //   卵却要 60 秒后才孵化 —— 这期间种群可能从"未满"变成"已满"。
  // 闸门语义：满员时到期的卵**等位置**（有个体老死就立刻补上），等待**有界**
  //   （超过 3×egg 这根既有时间轴就让光熄灭并计一次 hatchFailures，避免卵无界堆积）。
  // 这道闸门另有 2 条单元测试钉住（tests/sim.test.js 的"满员时到期的卵会**等位置**"
  //   与"一直等不到位置的卵会在 3×egg 后熄灭"）—— 必须进 `node --test`，
  //   而本文件不会（见文件头：文件名不匹配 Node runner 的模式）。
  //   两次变异探针已证明它们会咬：摘掉整道闸门 ⇒ 两条都红（expected 2 / actual 3，爆缸重现）；
  //   只删有界熄灭 ⇒ 只有熄灭那条红、等待那条仍绿（两条互相独立）。
  if (peak > world.populationCap) {
    console.log('');
    console.log(`  关于"峰值超上限"（本次峰值 ${peak}，上限 ${world.populationCap}）：`);
    console.log('  这是**真缺陷**，不是叙事化上限的既有行为 —— 见上方注释与 src/sim.js 的孵化时闸门。');
    console.log('  最可能的原因是那道闸门被改动或移除了；先跑 tests/sim.test.js 里那两条闸门测试定位。');
  }
  process.exitCode = 1;
} else {
  // ⚠️ 这里原先写"种群自我延续，未灭绝、未爆缸"。2026-10-14 裁定灭绝为合法结局之后，
  // 那句话会在"缸断了、但其余判据都过"的情况下**说谎**（它声称的"未灭绝"根本没被断言）。
  // 改为只陈述真正被断言的三件事，并在断代时补一行说明，免得读者以为脚本漏判。
  console.log('✓ 验收通过：峰值未超上限、色相全程锁在粉色区间、繁殖确实在发生（世代 ≥ 2 且出生 ≥ 2）。');
  if (extinctAt >= 0) {
    console.log(`  （注：本缸在 ${extinctAt.toFixed(0)}s 断代 —— 按裁定这是合法结局，不计为失败。）`);
  }
}

// 本次实际耗时（墙钟）。手动门需要一个可对照的数字：
// 文件头的"期望耗时"是基准（2026-10-14 起：断代种子 ~18–30s、撑住的种子 ~64s），
// 这里打印实际值，好让人区分"这台机器慢"和"它卡住了"。
// ⚠️ 但别把"比基准快"读成好事 —— 断代的缸跑得**快**（后半程空转），撑住的缸跑得慢。
const wallSeconds = Number(process.hrtime.bigint() - wallStart) / 1e9;
console.log(`\n本次耗时 ${wallSeconds.toFixed(1)}s（墙钟；2026-10-14 起的实测基准：断代种子 ~18–30s、`
  + '存活种子 ~64s。跑得比基准**快**可能只是种群死光了，见文件头）');
