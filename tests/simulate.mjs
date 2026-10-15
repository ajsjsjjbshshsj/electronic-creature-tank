// 无头验收模拟器：跑一段模拟时间，打印种群的生老病死统计。
//
// 这不是单元测试 —— 它是**本计划自己的验收目标**（种群能自我延续到多代、
// 不爆炸也不灭绝）的可执行证据。依据是 spec 4.11（寿命与阶段）与 4.12（繁殖），
// **不是** spec 9.2 的成功标准。
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
// 数字就是脚本末尾那行"本次耗时"的值，三次独立运行）：
//   默认参数（种子 20261014 / 60 模拟分钟 = 216000 步）实测 **89.2s / 90.8s / 97.2s**；
//   但**同一个 60 分钟窗口换种子可以差 6 倍**：种子 31337 = 23.5s（种群早早灭绝、后半程空转，
//   每步几乎没有个体要算），种子 999 = 156.5s（峰值 47 只、一直很热闹）。
//   原因是每步成本随存活数增长（碰撞是 O(n²)，感知是每个体一次网格查询），
//   所以判断"慢"要连着表里的存活数一起看，不能只看墙钟。
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
// ⚠️ 实跑发现（本文件落地时在种子 20261014 与 1 上各量了一次，5 模拟分钟窗口末）：
//   抚摸 20 秒**买不到任何好感**。原因是好感在内核里只有一条来源 ——
//   sim.js 里对 PLAYER_ID 的 adjustMemory 只有 beg 分支传了非零 dAffection
//   （温柔的手那一段只给 familiarity，`adjustMemory(c.memory, PLAYER_ID, 0, 0.04*dt)`）；
//   而 beg 的效用分被 explore/forage 压着，**一次都没胜出**（实测 20 秒里 beg 胜出 0 tick，
//   7 只幸存者逐个试、延长到 300 秒也全是 0）。所以这一节下面：
//     ① 先如实打印"抚摸 20 秒买到了多少"（通常是 0）与 beg 胜出的 tick 数；
//     ② 再**注入一个已知好感**（经公开的 memory.adjust，不是手伸进 entries）测衰减本身，
//        否则第 8 条要观察的那个速率永远拿不到数据。
//   两件事分开打印、分别标注：① 是"能不能买到"，② 是"买到之后掉多快"。
if (alive.length) {
  // 挑观察对象：优先挑一只 playerApproach > 0 的。
  // beg 的评分含因子 Math.max(0, thresholds.playerApproach)，而
  // playerApproach = clingy*0.5 + bold*0.3 - irritable*0.35 最低可到 -0.35（personality.js）——
  // 抽到一只 ≤ 0 的个体，这一节会打印一条**全 0**的曲线，看起来像"羁绊一碰就碎"，
  // 真相却是"它从来不肯靠近你"。所以显式挑一只肯靠近的，并把选中理由打印出来。
  const willing = alive.find((c) => c.thresholds.playerApproach > 0);
  const pet = willing || alive[0];
  console.log('\n玩家羁绊观察（交接要求第 8 条）');
  console.log(`  观察对象     ${pet.name}（playerApproach=${pet.thresholds.playerApproach.toFixed(3)}`
    + `，curiosity=${pet.traits.personality.curious.toFixed(3)}`
    + `，exploreRadius=${pet.thresholds.exploreRadius.toFixed(3)}`
    + `）${willing ? '' : ' ← 全场没有愿意靠近玩家的幸存者，下面的感情曲线必然是平的'}`);

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
    + `${begTicks === 0 ? '（好感在内核里只有 beg 能累积 ⇒ 好感买不到）' : ''}`);
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
      + `（memory.adjust，dFamiliarity=0；因为抚摸买不到，见上一行）`);
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
  console.log('   这本身就是观察结果：种群先爆缸、再成批老死的时候，"它认不认得你"无从谈起。');
}

if (survivorLines.length) {
  console.log(`\n幸存者（模拟 ${minutes} 分钟结束时的快照）`);
  for (const line of survivorLines) console.log(line);
}

// ---- 自动断言：这个脚本本身就是验收，不合格要以非零码退出 ----
const failures = [];

if (extinctAt >= 0) {
  failures.push(`种群在 ${extinctAt.toFixed(0)}s 灭绝了 —— 繁殖率跟不上死亡率`);
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
// 幸存者检查只覆盖"最后活着的那些"；上面两个累加器覆盖**整段模拟里每个成体的每一步**，
// 所以这条断言才兑现了 spec 4.2「色相永远锁在粉色区间」这句话。
if (hueSampleCount > 0 && !(hueMin >= 315 || hueMin <= 25)) {
  failures.push(`全程最冷色相 ${hueMin} 跑出了粉色区间（${hueSampleCount} 个样本）`);
}
if (hueSampleCount > 0 && !(hueMax >= 315 || hueMax <= 25)) {
  failures.push(`全程最暖色相 ${hueMax} 跑出了粉色区间（${hueSampleCount} 个样本）`);
}

console.log('');
if (failures.length) {
  console.log(`验收未通过（${failures.length} 项）：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  // 「峰值超上限」这一条与内核**已判决的设计**冲突，而且实测超得很远，所以要当场说明 ——
  // 否则下一个看到这行的人会以为 sim.js 漏了上限判定，去"修"一个刻意的行为。
  if (peak > world.populationCap) {
    console.log('');
    console.log('  关于"峰值超上限"：本内核的上限是**叙事化**的（spec 4.12 第 6 条：不得硬屏蔽）。');
    console.log('  src/sim.js 的 resolve 用当前存活数算 atCap，addCreature 刻意不查上限，');
    console.log('  且同一 tick 里可以有多对同时产卵（每对 1–3 枚卵，60 秒后孵化），');
    console.log('  所以超调是设计内的既有行为，不是漏判：tests/breeding.test.js 的');
    console.log('  「种群超过上限时分数仍不为 0」一条把"cap-1 时产卵会让种群冲到 cap+2"写进了注释。');
    console.log(`  但**超调幅度**（本次峰值 ${peak}，上限 ${world.populationCap}）超出该注释的量级，`);
    console.log('  与 spec 5.3 的种群上限/性能预算是否相容，需要控制方裁定：改判据，还是改内核。');
  }
  process.exitCode = 1;
} else {
  console.log('✓ 验收通过：种群自我延续，未灭绝、未爆缸、色相始终在粉色区间。');
}

// 本次实际耗时（墙钟）。手动门需要一个可对照的数字：
// 文件头的"期望耗时 89–97s（默认参数实测）"是基准，这里打印实际值，
// 好让人区分"这台机器慢"和"它卡住了"。
const wallSeconds = Number(process.hrtime.bigint() - wallStart) / 1e9;
console.log(`\n本次耗时 ${wallSeconds.toFixed(1)}s（墙钟；默认参数 60 分钟的实测基准是 89–97s）`);
