// behavior.js —— 效用评分决策（spec 4.10）。
//
// 这是唯一的"思考"模块：给它一只生物的当前状态与它感知到的东西（Senses），
// 它挑出一个候选行为，并给出这个行为至少持续多久。
//
// 两条贯穿全模块的边界：
//
// 1. **需求不决定行为，只为评分提供紧迫度（spec 4.4）。** 每个候选的分数都是
//    非负乘积，需求只出现在乘子里。没有任何一处"饥饿 > x 就直接返回 forage"——
//    那样会让一个需求一票否决其余十一个候选，是明确违反 spec 的设计。
//    这一点由测试 '需求只为效用评分提供紧迫度，绝不一票否决（spec 4.4）' 钉住。
//
// 2. **本模块是纯读的。** decide / scoreAll 不修改 c，也不修改 senses；
//    写 c.intent、执行移动、扣需求、发事件全部是 Task 10 的职责。
//    这条边界让决策可以脱离世界单测，也让它不依赖 sim 的 tick 顺序。
//    由测试 'scoreAll 是纯函数（不修改 creature，也不修改 senses）' 钉住。
//
// 依赖方向：本模块**只**依赖 config 与 memory（read-only 查询）。
// 刻意不 import breeding —— 产卵 readiness 由 sim 的 broodScore 预算好放进 senses.broodScore，
// 否则会形成 behavior → breeding → creature 的耦合链。（2026-10-20 孤雌：原 courtshipOptions 已删。）
import { CONFIG } from './config.js';
import { affectionFor, familiarityFor, PLAYER_ID } from './memory.js';

// 12 个候选行为。**必须冻结**（项目纪律，见 Task 2/4/5/7 的同类处理）：
// 这是导出的共享数组，而 `decide` 按数组顺序裁决平局（严格 `>` 配 bestKind 初值），
// 一次就地 `.sort()` / `.reverse()` / `.push()` 会静默改变平局结果与 `scoreAll` 的键集，
// 全链路不报错。冻结本身必须被测试钉住 ——
// **摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（它比内容不比可变性）。
// （Task 2 的 PATTERNS 就是这样被 .reverse() 静默重排、害得整缸花纹错位的。）
export const INTENTS = Object.freeze([
  'forage', 'eat', 'rest', 'socialize', 'brood', 'explore',
  'flee', 'beg', 'hop', 'protest', 'fight', 'mourn', 'idle',
]);

// ---------------------------------------------------------------- 共享阈值
//
// 下面两个阈值同时被本模块和 Task 10 的 sim.js 使用，所以在整个项目里
// **必须有唯一定义点**，否则会出现"同一件事的两份数字慢慢漂移"这种最难查的问题：
//
//   EAT_DIST        —— scoreAll 的 eat 门槛 与 executeIntent 的 `case 'eat'` 里
//                      `if (d < …)` 是**同一个判定**：够得着才吃。
//                      两处若不一致就会出现"选了 eat 却吃不到"的死循环：
//                      scoreAll 的门槛更宽时，生物在 eat 半径外沿被判定"够得着"、
//                      选中 eat，而执行层够不着、不喂食，锁定到期后重新决策又选中
//                      eat —— 它贴着一份光藻饿死。
//                      反过来（执行层更宽）则 forage 会一直抢先，同样永远不吃。
//   HAND_SPEED_POKE —— 手的粗糙阈值在项目里原本写着三份（本模块的 handIsRough、
//                      Task 10 的 emotionCtx.threat、Task 10 的 familiarity 门）。
//                      它们必须是同一个数：一个速度算"戳"的自相矛盾会让
//                      "温柔的手让它认识你"与"粗暴的手让它害怕"同时成立/同时失效。
//
// 导出它们（而不是各写各的）是给 Task 10 用的：sim.js 已经 import 本模块的
// decide，再 import 这两个常量不产生新耦合。
//
// ⚠️ 建议（**留给控制方**，本 Task 无权改 config.js）：这两项其实是 CONFIG 形状的
// 可调游戏性常量，最终应搬进 CONFIG.behavior（如 eatDist / handPokeSpeed），
// 由 config.js 做唯一来源。搬之前必须先确认 Task 10 的两处引用一起改掉，
// 否则会从"两份字面量"变成"CONFIG 一份 + 本地一份"，反而更难查。
export const EAT_DIST = 0.035;
export const HAND_SPEED_POKE = 0.25;

// ---------------------------------------------------------------- 求关注升级链（spec §4.10）
//
// 用户要的是"最喜欢主人，想要主人的关注，会做一些自己认为可以吸引主人注意的事"。
// 做法**不是**新增 attract 意图（那会让 beg 与 attract 在同一张效用表里互相竞争，
// 读出"它一边卖萌一边生气"的分裂表现），而是让 beg 这一个动机有三档强度：
//
//   0 档  刚被理睬，或玩家不在场           → 正常卖萌
//   1 档  被冷落满 begEscalate.hopAfter    → 蹦到手的正前方（hop 拿到加成并有了目标点）
//   2 档  再满 5 秒                        → 抗议：生气、背对手、不理你（并挨一次 ignored 冲击）
//
// 计时器 `c.begIgnored` 的生产者只有一处：sim.tickCreature。这里**只读**，
// 与本模块"纯读"的边界一致（文件头第 2 条）。
//
// 两个加成都是 `分数 × CONFIG.behavior.begUrgency` 的形状，不是绝对数值：
// 这样 begUrgency 一旦重调（它本身就是 ff84886 为真实缸调出来的数），
// 升级链整体跟着缩放，不会留下两个各自漂移的常数。
// 这一条由 tests/behavior.test.js 的"源码必须同时引用两个 CONFIG 常数"守着 ——
// 只断言乘出来的值是不够的：字面量 1.75 与 0.25 × 7.0 相等，但前者让两个旋钮变成死配置。
export function begEscalation(c) {
  const E = CONFIG.behavior.begEscalate;
  const U = CONFIG.behavior.begUrgency;
  const ignored = c.begIgnored || 0;
  const level = ignored >= E.protestAfter ? 2 : ignored >= E.hopAfter ? 1 : 0;
  return {
    level,
    // **只有第一级**加 hop。到第二级就放弃讨关注了，再继续蹦就成了"讨好与生气同时满分"，
    // 读起来是它越被冷落越开心 —— 恰好是 spec §4.10 相反的表现。出口是**替换**的，不是叠加的。
    hopBonus: level === 1 ? E.hopBonus * U : 0,
    protestFloor: level >= 2 ? E.protestFloor * U : 0,
  };
}

// 与 needs.js / emotions.js / memory.js 同型：两个比较对 NaN 都是 false，
// 所以 NaN 会**原样穿过**。这里不加逐调用的有限性守卫（60Hz × 24 只的热路径），
// 跨模块的 NaN 累积由 Task 10 的收尾断言负责（见计划「跨 Task 交接要求」第 1 条）。
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampPos = (v) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);

// 每个候选的最小持续时间（秒）。
//
// 全部从 CONFIG.behavior.minIntentDuration 派生，而不是写死绝对秒数 ——
// 否则那个配置项就成了没人读的死配置，调它的时候行为不会有任何变化，
// 而这正是"改了配置却没生效"这类最难查的问题。
//
// 相对倍率的含义：
//   flee  0.4× —— 刻意最短。逃命时必须能随时改向，被锁定 1.2 秒会一头撞墙。
//   brood 2.0× —— 中等。孵一窝不是仪式，做完就该起身；原来的 court 3.3×（刻意最长）
//   随求偶制一起删了。
//   fight 0.85× —— 略短于基准：打斗是短促的爆发，不该拖成僵持。
const M = CONFIG.behavior.minIntentDuration;
// 导出（仅供测试与调试，与 scoreAll 同理）并冻结：它是 12 个意图的锁定时长表，
// 与 INTENTS 一一对应；被就地改动会让某个行为被锁死或失去锁。
// 冻结理由同 INTENTS —— 摘掉 Object.freeze 不会让任何内容断言变红。
export const MIN_DURATION = Object.freeze({
  forage: M * 1.25, eat: M, rest: M * 2.5, socialize: M * 1.7,
  brood: M * 2.0, explore: M * 1.7, flee: M * 0.4, beg: M * 1.25,
  hop: M * 0.7,
  protest: M, fight: M * 0.85, mourn: M * 1.7, idle: M * 1.25,
});

// 效用评分（spec 4.10）。
//
// 各项相乘而非相加，是有意的：任何一项为 0 都会让整个候选归零。
// 这实现了"情境可行性"的硬约束（没有食物就不能 eat、没有邻居就不能 socialize），
// 而不需要为每个候选写一堆 if。相加则会让"完全不可行但需求很强"的候选胜出。
//
// 返回的分数全部 >= 0（每个乘子都是 clamp 过的非负量或字面量），调用方可以直接比较。
// 注意：**不要**在这里写 `assert(v >= 0)` 当作守门 —— 那里恒真、是死断言。
// 真正有价值的是把具体量级钉住，见测试
// 'scoreAll 的数值量级被字面量钉住（urgency 权重不是"只要 > 0"就行）'。
export function scoreAll(c, senses) {
  const t = c.thresholds;
  const n = c.needs;
  const e = c.emotions;

  // 数组由 Task 10 的 perceive 按 dist 升序排好，所以 [0] 就是最近的。
  // 这里依赖的是**排序键**（dist），不是"并列时谁在前"——见 decide 里关于平局的说明。
  const nearestFood = senses.foods.length ? senses.foods[0] : null;
  const nearestNeighbor = senses.neighbors.length ? senses.neighbors[0] : null;
  const nearestThreat = senses.threats.length ? senses.threats[0] : null;
  const hand = senses.playerHand;
  // provoker：senses 显式指出的肇事者（perceive 用 anger > 0.5 && dist < 0.08 选出），
  // 再回 neighbors 里取它的完整信息。筛选标准只在 perceive 里定义一处。
  const provokerId = senses.provokerId || null;
  const provoker = provokerId
    ? senses.neighbors.find((x) => x.id === provokerId) || null
    : null;

  const playerAffection = affectionFor(c.memory, PLAYER_ID);
  const playerFamiliarity = familiarityFor(c.memory, PLAYER_ID);
  // 手移动得快 = 戳，慢 = 抚摸（spec 6.1 的核心区分）
  const handIsRough = hand ? hand.speed > HAND_SPEED_POKE : false;
  // 求关注的档位与加成（spec §4.10）。hand 不在场时第二级不给 protest 保底分：
  // 对着空气闹脾气读起来是坏的。
  const esc = begEscalation(c);

  const scores = {
    // 觅食：饥饿超过性格阈值才启动；贪吃者阈值低，会更早动身
    forage: n.hunger > t.hungerTrigger && nearestFood
      ? n.hunger * CONFIG.behavior.seekFoodUrgency * (1 + e.curiosity * 0.2)
      : 0,

    // 进食：已经贴着食物了才有意义。由 forage 抵达后自然触发。
    // 距离阈值与 Task 10 的 `case 'eat'` 是同一个数（EAT_DIST），见文件头的说明。
    eat: nearestFood && nearestFood.dist < EAT_DIST && n.hunger > 0.05
      ? n.hunger * 2.5
      : 0,

    rest: n.energy > 0.55 ? n.energy * 1.4 * (1 - e.fear * 0.8) : 0,

    socialize: n.social > t.socialTrigger && nearestNeighbor
      ? n.social * 1.3 * (1 + t.playerApproach * 0.15)
      : 0,

    // 自产卵（孤雌）：分数由 sim 的 broodScore 预算好，读的是"这只憋了多久"× 拥挤乘数。
    // 于是"种群上限压低产卵"自动传导到这里，与当年求偶分数的传导路径同构。
    brood: senses.broodScore > 0
      ? senses.broodScore * CONFIG.behavior.broodUrgency
      : 0,

    // 蹦跳（spec §4.7.2）。**energy 是乘子里的一项而不是 if 门控**：
    // 累了它自己就掉出竞争，不需要任何一处硬编码"累了不许跳"。
    // 好动的两项都推高它（hopWeight 随 activity 上升、能量掉得也快），
    // 于是"越好动跳得越勤、也越早歇"是同一条因果的两端。
    //
    // 升级到第一级再加 esc.hopBonus（= hopBonus × begUrgency）：被冷落够久会
    // "蹦到手的正前方"来讨关注。**门控仍在**：累到极点时加成打不开这扇门，
    // "累了会休息"压过闹脾气 —— 由测试专门钉住。
    hop: (e.joy > 0.25 && n.energy < 0.7)
      ? t.hopWeight * (0.3 + e.joy) * (1 - n.energy) + esc.hopBonus
      : 0,

    // 探索：好奇驱动，且在没有更紧迫的事时才有分量
    explore: e.curiosity * (0.4 + t.exploreRadius) * (1.2 - Math.max(n.hunger, n.energy)),

    // 逃避：权重最高（spec 4.10 的 fleeUrgency），但没有威胁时为 0。
    // 玩家的手粗暴地戳过来也算威胁。
    flee: Math.max(
      nearestThreat ? e.fear * CONFIG.behavior.fleeUrgency * (1 + (0.2 - nearestThreat.dist)) : 0,
      hand && handIsRough && playerAffection < 0.2 && t.playerApproach < 0.2
        ? e.fear * CONFIG.behavior.fleeUrgency
        : 0,
    ),

    // 卖萌：由"对玩家的好感 + 熟悉度 + 性格倾向 + 手在附近且动作温柔"共同触发。
    //
    // familiarity 单独也能开门（但阈值更高、权重更低），这是必需的正确性条件，
    // 不是可选的润色：内核里 affection 只有 beg 自己会累积，若只认 affection，
    // 就会死锁成"它因为不认识你所以不撒娇，因为不撒娇所以永远不认识你"，
    // 卖萌这个 spec 明确要求的表情将永远不会出现。
    //
    // 但"喜欢"仍然必须由抚摸买来（计划 3 的 input 层）—— 光是把手放在那儿
    // 只能买到"认识"，否则卖萌就退化成一个挂机计时器。
    //
    // 好感为负时归零 —— 它躲你，不会讨好你。
    beg: hand && !handIsRough && playerAffection >= 0
      && (playerAffection > 0.1 || playerFamiliarity > 0.3)
      ? (0.2 + playerAffection + playerFamiliarity * 0.4)
        * Math.max(0, t.playerApproach) * CONFIG.behavior.begUrgency
        * (0.5 + e.joy * 0.5)
      : 0,

    // 抗议：生气但不敢/不想真打。愤怒超过性格阈值才启动。
    // 求关注升级链的第二级（spec §4.10）：beg 被冷落够久就从"卖萌"翻成"抗议"。
    // 加成挂在 begIgnored 上，所以这不是新机制 —— 是同一个被冷落计时的第二个出口。
    //
    // 两个出口共用一个 kind，但走的是**两条不同的门**：
    //   常规门  —— 有惹它的邻居且气过了阈值（原来那条）
    //   冷落门  —— 没有 provoker，但它被玩家冷落到第二级且手还在视野里。
    //              这里必须有保底分：内核里"被冷落"不会生成 provoker（它不是邻居），
    //              不加这一支，"背过身不理你"在整个代码里就没有生产者，
    //              而那是 spec §4.10 第二级唯一的可读表现。
    protest: (e.anger > t.angerThreshold && provoker)
      ? e.anger * 1.2 * (1 - e.fear)
      : (esc.protestFloor > 0 && hand ? esc.protestFloor : 0),

    // 争斗：只有打得过才打。体型差是硬门槛，
    // 否则会出现"幼体去撞成体"这种既不可信也不可爱的画面。
    //
    // 与 protest 的关系（**已复核，纠正过一处错误论证**）：
    // 两者共用同一个 anger 系数，所以比值是
    //   fight/protest = fightUrgency×(1−0.2×playerApproach) / (1.2×(1−fear))
    //                 = 1.1×(1−0.2×p) / (1.2×(1−fear))        （fightUrgency = 1.1）
    // ⚠️ 这里原先写着"该比值在 fear < 0.35 内上界是 0.9808，所以 fight 总是输给 protest"，
    // 并据此加了一个额外的"贴身分支"。**那个论证是错的**，两个层面都错：
    //   (a) 0.9808 **不是**通用的上界，它只是 p = −0.35（playerApproach 的下限）
    //       且 fear→0 时的取值。该比值随 p 增大而**减小**、随 fear 增大而**增大**：
    //         p = −0.35 → 0.980833（fear→0）
    //         p =  0.225 → 0.875417（fear→0，中性性格）
    //         p = −0.50 → 1.008333（注意：这个 p 低于基因下限，仅用于说明趋势）
    //   (b) 更关键的是 fear 在 protest 的**分母**上，所以比值随 fear 上升而上升，
    //       不是被某个常量封顶。crossover（比值 = 1）解为
    //         fear* = 1 − 1.1×(1−0.2p)/1.2
    //       中性性格下 fear* = 0.1246，而本分支的门槛允许 fear 到 0.35 ——
    //       所以 fight 在**主分支里本来就可达**（fear ∈ (0.1246, 0.35)）。
    // 实测：移除那个额外分支后 40 条测试全绿（全量 327 条也全绿），
    // 且把 fight 的幅度归零仍能恰好让 fight 那条测试变红 —— 它没有被任何测试需要。
    // 故已删除 —— 它是一次不必要的、改动游戏行为的偏离：会把门槛从 anger > thr+0.15
    // 放宽到 thr+0.05（外加 dist < 0.06），让"贴得很近、只是有点生气"也开打，
    // 而没有任何测试或 spec 要求这一点。
    // 保留下来的语义是干净的："气得够狠 + 不太怕 + 打得过"。
    fight: e.anger > t.angerThreshold + 0.15 && provoker && e.fear < 0.35
      && provoker.size <= c.traits.size * 1.25
      ? e.anger * CONFIG.behavior.fightUrgency * (1 + t.playerApproach * -0.2)
      : 0,

    // 哀悼：mourn 计时器 > 0 时有效。它压过日常行为但压不过逃命。
    mourn: c.mourn > 0 ? 1.8 * Math.min(1, c.mourn) : 0,

    // 兜底：什么都不做。基础分很低，只在其他候选都归零时胜出。
    // ⚠️ 0.12 被测试用字面量钉住（实测把它改成 0 会红 11 条用例：
    // idle 一旦为 0，calm 场景就只能靠 explore，多种"无对象"场景会失去兜底）。
    idle: 0.12,
  };

  return scores;
}

// 逃/背到威胁的**反方向**，靠近缸壁时把方向掰向缸中心，否则会一直顶着壁。
// 抽成函数是因为有两个出口共用这段算术：flee（真的有害）与升级来的 protest
// （背对手）。各写一遍迟早漂移，而漂移的表现是"它生气时反而往人身上撞"。
// step 是位移量：flee 用 0.25（逃得远），protest 用同一个数就够 ——
// 它不是逃跑，只是把身子转过去。
function awayFrom(c, fromPos, step = 0.25) {
  let dx = c.pos.x - fromPos.x;
  let dy = c.pos.y - fromPos.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const cx = c.pos.x < 0.2 || c.pos.x > 0.8 ? (0.5 - c.pos.x) * 0.6 : 0;
  const cy = c.pos.y < 0.2 || c.pos.y > 0.8 ? (0.5 - c.pos.y) * 0.6 : 0;
  return { x: clampPos(c.pos.x + dx * step + cx), y: clampPos(c.pos.y + dy * step + cy) };
}

// 选出最高分候选，并附上目标信息。
//
// 随机扰动（noiseScale）加在乘法之后：它让势均力敌的候选之间产生分歧，
// 避免生物每次都做"最优"选择而显得机械；但幅度很小（±12%），
// 而压倒性需求领先第二名多少是**实测**过的：
// '扰动幅度有限' 那条用例里 forage/idle = 1.584/0.12 = 13.2 倍，
// 要翻盘需要噪声把 forage 压到 0.88× 以下、同时把 idle 抬到 1.12× 以上
//（比值需 < 0.4848），实际 300 个种子全部落在 forage。
//
// 平局规则：`for (const kind of INTENTS)` + 严格 `>` + bestScore 初值 -Infinity
// ⇒ 分数相同时**按 INTENTS 的数组顺序**取先出现的那个。所以 INTENTS 被冻结；
// 一次就地重排会静默改变平局结果。（这也是"数组顺序承载语义"的唯一一处，
// 显式写在这里，免得后来者以为它只是个列表。）
export function decide(c, senses, rng) {
  const scores = scoreAll(c, senses);

  let bestKind = 'idle';
  let bestScore = -Infinity;
  for (const kind of INTENTS) {
    const noisy = scores[kind] * (1 + rng.range(-1, 1) * CONFIG.behavior.noiseScale);
    if (noisy > bestScore) { bestScore = noisy; bestKind = kind; }
  }

  // 下面这几行再取一次"最近/最优"，是为了把目标信息附在 Intent 上。
  // 刻意不复用 scoreAll 里的局部变量（那会让 scoreAll 返回一个额外的结构，
  // 从而改变它"纯粹是 Record<string, number>"的接口）。
  const nearestFood = senses.foods.length ? senses.foods[0] : null;
  const nearestNeighbor = senses.neighbors.length ? senses.neighbors[0] : null;
  const intent = { kind: bestKind, minDuration: MIN_DURATION[bestKind] };

  switch (bestKind) {
    case 'forage':
    case 'eat':
      intent.targetId = nearestFood.id;
      intent.targetPos = { x: nearestFood.pos.x, y: nearestFood.pos.y };
      break;
    case 'socialize':
      intent.targetId = nearestNeighbor.id;
      intent.targetPos = { x: nearestNeighbor.pos.x, y: nearestNeighbor.pos.y };
      break;
    case 'brood':
      // 没有对象，也没有目标点：它就在原地趴下来孵。
      break;
    case 'beg':
      intent.targetPos = { x: senses.playerHand.pos.x, y: senses.playerHand.pos.y };
      break;
    case 'hop': {
      // 平时 hop 没有目标点（原地蹦一下）。升级到第一级之后它改成"蹦到手的正前方"
      // —— 这就是 spec §4.10 要的"会做一些自己认为可以吸引主人注意的事"在内核里的形状。
      const esc = begEscalation(c);
      if (esc.level >= 1 && senses.playerHand) {
        intent.targetPos = { x: senses.playerHand.pos.x, y: senses.playerHand.pos.y };
      }
      break;
    }
    case 'protest':
    case 'fight': {
      const provoker = senses.neighbors.find((x) => x.id === senses.provokerId);
      if (provoker) {
        intent.targetId = provoker.id;
        intent.targetPos = { x: provoker.pos.x, y: provoker.pos.y };
      } else if (bestKind === 'protest' && senses.playerHand
                 && begEscalation(c).level >= 2) {
        // 升级来的抗议没有 provoker（冷落不是邻居），目标是**背对手**。
        // 不给目标点的话 executeIntent 会立刻 `c.intent = null`，
        // 于是 protest 每一帧被换掉、决策锁形同虚设 —— 表现是"它抽搐着生气"。
        intent.targetPos = awayFrom(c, senses.playerHand.pos);
      }
      break;
    }
    case 'flee': {
      // 逃向威胁的反方向；缸壁附近时贴着壁走，避免"逃到墙角卡住"
      const threat = senses.threats[0] || senses.playerHand;
      if (threat) intent.targetPos = awayFrom(c, threat.pos);
      else intent.targetPos = { x: clampPos(0.5), y: clampPos(0.5) };
      break;
    }
    case 'explore':
      // 在探索半径内随机挑一个点。半径由 curious 基因决定，
      // 所以胆大好奇的孩子会跑得更远 —— 这是可见的性格差异。
      intent.targetPos = {
        x: clampPos(c.pos.x + rng.range(-1, 1) * c.thresholds.exploreRadius),
        y: clampPos(c.pos.y + rng.range(-1, 1) * c.thresholds.exploreRadius),
      };
      break;
    case 'mourn':
    case 'rest':
    case 'idle':
    default:
      break;
  }

  return intent;
}
