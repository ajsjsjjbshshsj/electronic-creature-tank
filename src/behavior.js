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
// 刻意不 import breeding —— 求偶可行性与分数由 Task 10 用 courtshipScore 预算好
// 放进 senses.courtshipOptions，否则会形成 behavior → breeding → creature 的耦合链。
import { CONFIG } from './config.js';
import { affectionFor, familiarityFor, PLAYER_ID } from './memory.js';

// 12 个候选行为。**必须冻结**（项目纪律，见 Task 2/4/5/7 的同类处理）：
// 这是导出的共享数组，而 `decide` 按数组顺序裁决平局（严格 `>` 配 bestKind 初值），
// 一次就地 `.sort()` / `.reverse()` / `.push()` 会静默改变平局结果与 `scoreAll` 的键集，
// 全链路不报错。冻结本身必须被测试钉住 ——
// **摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（它比内容不比可变性）。
// （Task 2 的 PATTERNS 就是这样被 .reverse() 静默重排、害得整缸花纹错位的。）
export const INTENTS = Object.freeze([
  'forage', 'eat', 'rest', 'socialize', 'court', 'explore',
  'flee', 'beg', 'protest', 'fight', 'mourn', 'idle',
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
//   court 3.3× —— 刻意最长。求偶仪式本来就不该被一点风吹草动打断。
//   fight 0.85× —— 略短于基准：打斗是短促的爆发，不该拖成僵持。
const M = CONFIG.behavior.minIntentDuration;
// 导出（仅供测试与调试，与 scoreAll 同理）并冻结：它是 12 个意图的锁定时长表，
// 与 INTENTS 一一对应；被就地改动会让某个行为被锁死或失去锁。
// 冻结理由同 INTENTS —— 摘掉 Object.freeze 不会让任何内容断言变红。
export const MIN_DURATION = Object.freeze({
  forage: M * 1.25, eat: M, rest: M * 2.5, socialize: M * 1.7,
  court: M * 3.3, explore: M * 1.7, flee: M * 0.4, beg: M * 1.25,
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
  const bestSuitor = senses.courtshipOptions.length
    ? senses.courtshipOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;

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

    // 求偶：分数直接来自 sim 预算好的 courtshipScore，
    // 因此"种群上限压低求偶"与"近亲归零"自动传导到这里。
    court: bestSuitor && bestSuitor.score > 0
      ? bestSuitor.score * e.arousal * 1.6
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
    protest: e.anger > t.angerThreshold && provoker
      ? e.anger * 1.2 * (1 - e.fear)
      : 0,

    // 争斗：只有打得过才打。体型差是硬门槛，
    // 否则会出现"幼体去撞成体"这种既不可信也不可爱的画面。
    //
    // 与 protest 的关系（**已复核，纠正过一处错误论证**）：
    // 两者共用同一个 anger 系数，所以比值是
    //   fight/protest = 1.1×(1−0.2×playerApproach) / (1.2×(1−fear))
    // ⚠️ 这里原先写着"该比值在 fear < 0.35 内上界是 0.9808，所以 fight 总是输给 protest"，
    // 并据此加了一个额外的"贴身分支"。**那个论证是错的**：
    // 0.9808 是 fear→0 时的取值，而 fear 在 protest 的**分母**上，
    // 所以比值随 fear 上升而上升 —— 中性性格（playerApproach = 0.225）下
    // 只需 fear > 0.1246 就 crossover，而本分支的门槛允许 fear 到 0.35。
    // 于是 fight 在主分支里**本来就可达**（fear ∈ (0.1246, 0.35)），
    // 实测移除那个额外分支后 40 条测试全绿，故已删除它 ——
    // 它是一次不必要的、改动游戏行为的偏离：会让"贴得很近 + 愤怒只略高于阈值"
    // 也开打（门槛 anger > thr+0.05、dist < 0.06），而没有任何测试要求这一点。
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
  const bestSuitor = senses.courtshipOptions.length
    ? senses.courtshipOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;

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
    case 'court':
      intent.targetId = bestSuitor.id;
      break;
    case 'beg':
      intent.targetPos = { x: senses.playerHand.pos.x, y: senses.playerHand.pos.y };
      break;
    case 'protest':
    case 'fight': {
      const provoker = senses.neighbors.find((x) => x.id === senses.provokerId);
      if (provoker) {
        intent.targetId = provoker.id;
        intent.targetPos = { x: provoker.pos.x, y: provoker.pos.y };
      }
      break;
    }
    case 'flee': {
      // 逃向威胁的反方向；缸壁附近时贴着壁走，避免"逃到墙角卡住"
      const threat = senses.threats[0]
        || (senses.playerHand ? { pos: senses.playerHand.pos } : null);
      if (threat) {
        let dx = c.pos.x - threat.pos.x;
        let dy = c.pos.y - threat.pos.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        // 靠近边界时把逃离方向掰向缸中心，否则会一直顶着壁
        const cx = c.pos.x < 0.2 || c.pos.x > 0.8 ? (0.5 - c.pos.x) * 0.6 : 0;
        const cy = c.pos.y < 0.2 || c.pos.y > 0.8 ? (0.5 - c.pos.y) * 0.6 : 0;
        intent.targetPos = {
          x: clampPos(c.pos.x + dx * 0.25 + cx),
          y: clampPos(c.pos.y + dy * 0.25 + cy),
        };
      } else {
        intent.targetPos = { x: clampPos(0.5), y: clampPos(0.5) };
      }
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
