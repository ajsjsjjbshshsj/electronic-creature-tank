// 所有可调常量的唯一来源。修改数值只改这里，不要散落到各模块。
const CONFIG = {
  // ---- 种群 ----
  populationCap: { desktop: 24, mobile: 16 },
  // 新缸生成 8 只亚成体（spec 9.1，2026-10-14 由 4 调到 8 —— 见下方实测）。
  //
  // ⚠️ 为什么不是 4：4 只创始个体下，约 60% 的缸会在一小时内整批灭绝。
  // 机制是量出来的**血统坍缩**，不是繁殖率不够：
  //   4 只创始 → 平均只有 7.00 位不同母亲 → 全缸变成单一亲缘组 →
  //   `kinship > 0.25` 的严格近亲回避把**每一对**都挡掉 → 出生冻结 → 整批老死。
  //   实测 seed 999 在 t=1440 有 11 只成体，55/55 个成体×成体配对全被谱系近亲挡掉；
  //   seed 31337 末态 5 只的亲缘分布是 {"0.5":10}（每一对都是全同胞或亲子），出自同一个母亲。
  //   存活门槛很清楚：**母亲数 ≥ 10 的种子全部存活，≤ 7 的全部灭绝**。
  // 扫创始个体数（8 个种子 × 60 分钟，`.superpowers/sdd/diag-founders2.mjs`）：
  //   4 只 → 灭绝 5/8，平均母亲 7.00，平均出生 44.1，平均世代 4.63
  //   8 只 → 灭绝 3/8，平均母亲 10.13，平均出生 53.8，平均世代 5.63
  //  12 只 → 灭绝 2/8，平均母亲 13.13，平均出生 62.3，平均世代 6.25
  // 单调，且平均母亲数恰好在"灭绝开始下降"处越过实测存活门槛 10 ⇒ 因果链闭合。
  // 取 8 而不是 12：12 只一开缸就占掉上限 24 的一半，"看得见长大"的余量和
  // 后续繁殖空间都被压缩；8 只已把母亲数推过门槛，且 12 只也**没有**做到 0/8
  // （seed 31337 / 20261014 仍灭绝，母亲数只有 9 / 7）。
  //
  // ⚠️ 已被实测排除的三条路（别再重推）：错开创始年龄（4 种方案全是 4/8 灭绝，
  // 年龄结构不是杠杆）、把容量判定从产卵时移到孵化时（灭绝 4/8 → 5/8，**更差**）、
  // 调 crowding 的 onset 与下限（"完全无压制"对照与基线**持平** 5/8）。
  //
  // ⚠️ 灭绝**不是** bug，是合法结局（控制方 2026-10-14 裁定）：约 3/8 的缸仍会断代，
  // 玩家开新缸。spec §9.2 的六条验收依据里本来就没有"种群自我延续"。
  initialCreatures: 8,

  // ---- 生命周期（模拟秒 @1×）----
  // 卵单独计时；孵化后 creature.age 从 0 开始，
  // 完整寿命 = 180+300+480+180 = 1140s
  stage: { egg: 60, hatchling: 180, juvenile: 300, adult: 480, elder: 180 },

  // ---- 模拟 ----
  fixedDt: 1 / 60,
  dtAccumCap: 0.25,
  timeScales: [0.5, 1, 2, 4],

  // ---- 遗传 ----
  mutationRate: 0.06,
  hueRange: [315, 25],          // 跨 0° 的粉色区间；解码式见 genes.decode
  minSize: 14,
  maxSize: 38,

  // ---- 繁殖（孤雌，2026-10-20）----
  // 求偶时代的五个常量（courtship.min/max、kinshipMateMax、courtshipRange、
  // rejectionAffection）与 motion.courtshipFactor 已随 spec §4.12 改孤雌删除。
  eggsPerClutch: [1, 3],
  // 达上限时卵孵化失败的概率（spec 4.12 第 6 条）。
  // ⚠️ 当前实现**不采样**这个值：`layEggs` 用 `viable: !atPopulationCap`，是确定性的。
  // 值为 1 时两者行为完全等价（达上限必失败），所以不是 bug —— 但它目前**没有消费者**。
  // 注意：`tests/config.test.js` 并**没有**针对它的断言（它的 breeding 段落没有这一项），
  // 所以将来若决定删掉这个旋钮，不需要同步改任何测试 —— 删掉它即可。
  // 留着它的唯一理由是给 Plan 2/3 一个调参入口（若想让"达上限时偶尔仍能孵化"）。
  eggFailChanceAtCap: 1,

  // ---- 孤雌产卵与蛋（2026-10-20 新增，spec §4.11 / §4.12 / §11）----
  broody: { intervalMin: 120, intervalMax: 260 },   // 秒；两次自产卵的间隔区间
  eggSize: {
    min: 0.6, max: 1.4,      // 相对值，由母方 size × broody × 营养决定
    hatchGain: 0.5,          // 起点加成：eggBoost = (归一 − 0.5) × 该值 ⇒ 出壳 ±19.5% 体型
                             // （0.25 × (1 − growthFactor 0.22)）
    bias: 0,                 // ⚠️ 控制方裁定（10-20 不追认）：蛋大小**不影响**成年体型。
                             //    结构留着，改这一个数即可恢复；不许在别处再乘一次。
    durationFactor: [0.8, 0.5],   // 孵化时长 = stage.egg × (f0 + f1 × 归一) ⇒ 大蛋孵得久
    // （原 hatchlingFactor「大蛋幼体期更短」没有落地：stageForAge 用的是全局边界，
    //   要做个体差异得改阶段模型。它不在本轮任何裁定里，也不该留一个没人读的旋钮，
    //   所以删掉，并在 spec §13 记为未实现。见 progress.md 的 A2 一节。）
  },
  // 蛋色用**累积边界**分段，不用宽度数组（宽度要额外断言浮点和为 1，会漂）。
  // 末项必须恰为 1.0，由 tests/genes.test.js 钉住。黑蛋 0.025 是稀有度的唯一来源。
  eggTint: {
    colors: Object.freeze(['macaron-pink', 'macaron-blue', 'macaron-mint', 'macaron-lilac',
                           'macaron-cream', 'macaron-peach', 'white', 'black']),
    edges: Object.freeze([0.145, 0.29, 0.435, 0.58, 0.725, 0.87, 0.975, 1.0]),
  },
  // 外来血统漂入：孤雌下杂合度按 (1/2)^t 衰减，这是多样性的**唯一**补给阀门。
  // 判据在 tests/simulate.mjs 与 Task A3（正反两向），不要凭感觉调频率。
  drift: { interval: 240, form: 'egg' },

  // ---- 蹦跳与语言（2026-10-20 新增，spec §4.7.2 / §4.13）----
  hop: {
    weightBase: 0.4, weightGain: 1.2,   // hopWeight = base + activity × gain
    energyCost: 0.02,                   // 每次落地从 energy 扣
    drainBase: 0.7, drainGain: 1.0,     // energyDrainFactor：好动的把精力掉得更快
    impulseBase: 1.0,                   // 跳起冲量 = base × (0.5 + activity)，表现层用
    minDurationBase: 0.6,               // 秒；实际 = base / (0.3 + activity)，表现层用
  },
  speech: {
    enabled: true,                      // 关掉它，spec §9.2 第 7 条必须仍然全部成立
    cooldownMin: 6, cooldownMax: 18,    // talk 高 → 取靠近 min 的一侧
    heardBase: 4, heardGain: 8,         // heardCap = base + round(intellect × gain) = 4..12
    misspeakMax: 0.25,                  // intellect=0 的说错词概率，线性递减到 0
    maxTokens: 5,
    // ---- A6 实现时补的旋钮（spec §12 授权：按观感定，但两侧取值由测试钉住）----
    tokensBase: 2, tokensGain: 3,      // tokenBudget = min(maxTokens, base + round(talk × gain)) ⇒ 2..5
    sayBase: 0.15, sayGain: 0.8,       // 出词概率的"有多想说"一项：0.15 + 0.8 × salience
    talkFloor: 0.35,                   // talk=0 时意愿只剩 35%，talk=1 时是 100%（性格进第二个地方）
    cutePoolFloor: 0.5,                // talk × clingy ≥ 该值才有萌系口癖
    middlePoolFloor: 0.2,              // 再低就是中性词，最低档只剩"哼"
    needSpeakMin: 0.35,                // 匮乏到这条线才值得把需求词说出口
    catchphraseChance: 0.6,
    addressChance: 0.4,                // 叫"主人"的抽样（仍要同时满足 playerNear 与 addressAffMin）
    addressAffMin: 0.3,
    otherNameChance: 0.35,
    onscreenMax: 2,                     // 同屏气泡上限（性能 + 审美，spec §5.3）
    bubbleTtl: 3,
  },

  // ---- 听进去的话（spec §4.8.1，Task A7）----
  heard: {
    halfLife: 300,             // 秒：一次都没再听到的词掉到一半要这么久
    strongUses: 2,             // 听到次数达到它 ⇒ 半衰期加倍（"反复说的记得牢"）
    strongFactor: 2,
    retainMin: 0.25,           // 剩余强度低于它就不再冒出来（遗忘是真的）
    suppressBelow: -0.6,       // 价格低于它 ⇒ 它自己绝不再提这个词（"你骂过的词它会躲"）
    moodBoost: 0.5,            // 心情对上的候选词在排序里加权
    takeBase: 1, takeGain: 4,  // 一次听进去几个 = round(base + curious × gain) ⇒ 1..5
    // 价格表：**听到时**的心情给这个词定的价。calm 是 0（既不奖励也不惩罚）。
    // 少一档的后果是静默的（undefined 存盘变 null、读回 0），所以键集由测试对齐 MOODS。
    moodPrice: Object.freeze({
      anger: -0.8, sad: -0.5, bliss: 0.9, happy: 0.6, calm: 0,
    }),
  },

  // ---- 五档心情的阈值（spec §4.5.1，2026-10-20 新增）----
  // **顺序**在 emotions.moodOf 的 if 链里，不在这里：愤怒必须第一个判，
  // 否则"又饿又气但 joy 还有惯性残留"的个体会报出"幸福"—— 那是当着玩家的面说谎。
  // 这八个数是语言层选词的唯一依据，spec 把它们列进 §12 的授权范围（按观感调），
  // 但两侧取值由 tests/emotions.test.js 逐条钉住，调它们必须是一次有意识的动作。
  mood: {
    angerMin: 0.5,          // anger ≥ 该值 → 愤怒
    sadJoyMax: 0.25,        // joy < 该值 且 fear ≥ sadFearMin → 伤心
    sadFearMin: 0.4,
    sadSocialMin: 0.7,      // 社交匮乏 ≥ 该值单独就够 → 伤心
    happyJoyMin: 0.45,      // joy ≥ 该值 → 快乐
    blissJoyMin: 0.6,       // 幸福要三样齐全：joy、四条需求、对玩家好感
    blissNeedMax: 0.25,
    blissAffMin: 0.6,
  },

  // ---- 需求（每秒变化率）----
  needs: {
    hungerRate: 0.0083,        // 裸速率下 1/0.0083 ≈ 120s，但这不是"从 0 到 1"的真实耗时：
                               // decay 还要乘 sizeFactor × gluttonFactor，而
                               // sizeFactor = 0.7 + size/maxSize×0.6 是按 maxSize 归一化的
                               // （不是以中型体型为中心），所以中性个体 size = (14+38)/2 = 26
                               // 的因子是 1.1105 而非 1.0。真实耗时 = 1/(rate×两因子)：
                               //   中性个体（size 26, gluttonous 0.5）≈ 108.5s
                               //   最快（size = maxSize 38, gluttonous 1）≈ 71.3s
                               //   最慢（size = minSize 14, gluttonous 0）≈ 186.9s
                               // 写测试窗口时按 108.5s 算，别按 120s —— 120s 已经越过 clamp。
    energyRateActive: 0.0042,  // 移动时约 240s 耗尽
    energyRateIdle: 0.0017,    // 静止时消耗更慢
    energyRateRest: -0.017,    // 休息时恢复，约 60s 回满
    socialRate: 0.0056,        // 约 180s 从 0 到 1
    socialRelief: 0.9,         // 有同伴在场时的抑制系数
    safetyRecover: 0.02,       // 约 50s 平复
    feedAmount: 0.45,          // 一份光藻恢复的饥饿
    startleAmount: 0.55,       // 被戳一次的安全感冲击
  },

  // ---- 情绪 ----
  emotions: {
    inertia: 1.6,              // 每秒趋近目标值的比例系数
    eventMagnitude: {          // 事件冲击：立即生效，不走惯性
      poked:    { fear: 0.45, anger: 0.25, joy: -0.3 },
      petted:   { joy: 0.4, fear: -0.2 },
      fed:      { joy: 0.3 },
      bumped:   { anger: 0.35, fear: 0.1 },
          laid:     { joy: 0.6 },   // 2026-10-20：原 mated（求偶成功）随孤雌制改名
      startled: { fear: 0.6 },
      death:    { fear: 0.25, joy: -0.4 },   // 目击同族死亡 → 触发哀悼
      // 求关注升级到第二级那一刻的冲击（spec §4.10）。
      // 生产者恰好一处：sim.tickCreature 跨过 begEscalate.protestAfter 时发一次。
      ignored:  { anger: 0.25, joy: -0.2 },
    },
  },

  // ---- 记忆 ----
  memoryCapacity: 12,
  affectionDecay: 0.02,        // 普通关系，每秒指数衰减系数
  affectionDecayKin: 0.002,    // 亲属/伴侣，近乎不忘
  familiarityDecay: 0.004,

  // ---- 行为 ----
  behavior: {
    noiseScale: 0.12,          // 效用评分的随机扰动幅度，避免机械感
    minIntentDuration: 1.2,    // 秒；行为的最短持续时间，防止高频抖动切换
    seekFoodUrgency: 1.6,      // 觅食评分对饥饿的放大
    // 卖萌评分对 playerApproach 的放大。
    // ⚠️ 2026-10-14 由 1.3 调到 7.0 —— 起因是验收模拟器实测"卖萌在真实缸里一次都不出现"。
    // 实测（本目录下 .superpowers/sdd 的诊断脚本，四个种子各抚摸 180 秒，读 beg 的胜出占比）：
    //   1.3（原值）→ 0.0%      4 → 0.0%        5 → 0.0%      5.5 → 0/0/6.7/0%
    //   6 → 3.4/0.8/79.6/0%    6.5 → 70/23/57/0%            7 → 65/66/85/0%
    //   8 → 74/52/85/0%        12 → 92/91/93/0%             24 → 95/96/95/85%（近乎饱和）
    // 原值下 beg 的最高分（≈0.15）**低于缸里普通活动的地板**（explore 0.4~0.6、
    // socialize 1~2、court 3~4），所以它根本排不上号；而好感在内核里**只有 beg 自己**
    // 会累积 ⇒ affection 恒为 0 ⇒ 卖萌的门永远打不开。
    // 这不是参数微调，是把卖萌放在了错误的量级上。
    // 7.0 让"手温柔地在旁边 + 已经认识你"时 beg 落在 1 上下、与 socialize 同量级：
    // 三个种子分别 65%/66%/85% 出现，第四个种子（playerApproach = 0.046，按设计不卖萌）为 0%。
    // 取 7.0 而不是 8~12，是因为它在这三个种子上**最一致**（65/66/85），
    // 而 12 以上会趋于"只要手在旁边就一直在卖萌"（≈95%）。
    // 仍然不是挂机计时器：beg 要求手在附近且不粗暴，且 (affection > 0.1 || familiarity > 0.3)；
    // playerApproach ≤ 0 的个体（暴躁/胆小）按设计**永远不会**卖萌 —— 实测这类约占个体总数的 1/4。
    // ⚠️ 待计划 2/3 复核：真实的手有"停在那儿"（速度≈0）与"缓慢划动"（速度>0）之分，
    // 而本模块只按 `speed > HAND_SPEED_POKE` 区分粗暴/温柔，不区分静止与划动。
    // 所以"手一直停着也能一直卖萌"这件事要等有真实输入后再调 ——
    // 合理的下一步是让 beg 的分数随手的**移动**上升，而不是仅凭"手在附近"。
    begUrgency: 7.0,
    // 求关注升级链（spec §4.10）：**不是新意图**，是 beg 这一个动机的三档强度。
    // 做成独立 attract 意图的话，beg 与 attract 会在效用评分里互相竞争，
    // 出现"它一边卖萌一边生气"的分裂表现。
    // 两个加成一律写成 **begUrgency 的分数**：调 begUrgency 时整条升级链跟着走，
    // 不会留下两个各自漂移的常数（计划 A4 的陷阱条）。
    // 取 0.25 / 0.25 而不是 0.3 / 0.3，还有一层实际理由：0.25 × 7 = 1.75 是二进制精确的，
    // 0.3 × 7 = 2.1000000000000005 会让测试里的字面量断言带上浮点尾巴。
    begEscalate: {
      hopAfter: 3,          // 秒：被冷落这么久 → 第一级（蹦到手的正前方、尾巴幅度拉满、出词）
      protestAfter: 8,      // 秒：第一级之后**再 5 秒** → 第二级（生气、背过身、不理你）
      hopBonus: 0.25,       // × begUrgency ⇒ 1.75，第一级给 hop 的加成
      protestFloor: 0.25,   // × begUrgency ⇒ 1.75，第二级给 protest 的保底分（此时没有 provoker）
    },
    broodUrgency: 1.5,           // 自产卵候选的放大（孤雌，spec §4.10）
    fightUrgency: 1.1,
    fleeUrgency: 2.2,          // 逃避优先于一切，靠高权重而非硬门控实现
  },

  // ---- 身体 ----
  bodyPoints: 24,
  eyeWidthRatio: 0.28,
  glowHueBuckets: 32,

  // 软体弹簧与形变（spec §5.1、§4.7）。这一节是计划 2R 从旧计划 Task 2 搬来的：
  // 它们的"实测"是 tests/visual-checklist.md 的手工核对，不是无头模拟的统计量 ——
  // 形变好不好看没法在 Node 里量，能量的部分（过冲、体积守恒、方向）都进了 tests/body.test.js。
  // ⚠️ body.js 里不许出现任何数值字面量（由 tests/body.test.js 的源码扫描钉住，
  //    先例是 A5 的 moodOf 那条），所以旧计划代码里散在函数体中的那几个魔法数
  //    （脉动幅度的四项、sick 的 0.15、溶散的两项）也一并搬进来了。
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
    // 脉动**幅度**的四项（旧计划把它们写成了函数体里的字面量，与"数值只在 CONFIG"这条纪律冲突）
    pulseAmpBase: 0.03,
    pulseAmpJoy: 0.05,
    pulseAmpArousal: 0.09,
    pulseAmpSleepy: 0.02,

    // sick 与溶散这两条"把一切都压小"的通道（旧计划同样是函数体字面量，已搬进来）
    sickCalm: 0.15,            // sim 要求 sick 个体被画成"变暗、静止"
    dyingCalm: 0.6,            // 溶散末段把残余形变再压六成
    dyingCollapse: 0.55,       // 溶散到结束时目标半径缩到 45%（**不等于 0**：0 半径会让 render 退化）

    // 冲击检测（碰撞局部凹陷，spec §5.1）。
    // 用的是**位置的二阶差分**，不是速度差 —— 理由见 src/body.js 里 detectImpact 的注释：
    // moveToward 撞墙时只 clamp 位置、不改 vel，所以 vel 在墙上没有任何信号。
    impactEps: 0.0012,         // 约 1.3 倍单步位移（baseSpeed×dt = 0.000917），低于它算平滑游动
    impactFullDent: 0.0040,    // 二阶差分达到这个量级时凹陷打满
    dentMax: 0.34,             // 最大凹陷深度（局部单位圆空间）
    dentDecay: 6.0,            // 每秒衰减系数（指数）
  },

  // ---- 造型四组（计划 2R B12 新增；spec §4.6 / §4.7 / §4.7.1 / §5.1 / §11）----
  // 参考物是用户那张粉色卷毛五角星抱枕的照片。数值逐字取自 spec §11，
  // 行为两侧由 tests/body.test.js 负责（这里只钉数值本身，与 mood / heard / speech 同构）。
  star: {
    corners: 5,                // 五角星的"五"。spec §11 没单列这个数（它是造型定义本身），
                               // 但 body.js 不许有字面量 ⇒ 结构常数也得进 CONFIG。
    outerRatio: 1.0,           // STAR_OUTER_RATIO：外角半径 / 身体半径
    innerRatio: 0.62,          // STAR_INNER_RATIO：0.62 是照片那只的比例，靠观感调
  },
  fluff: {
    lenRatio: 0.18,            // FLUFF_LEN_RATIO：毛长 = 该值 × 身体半径 × fluff 表现型
    sprites: 2,                // FLUFF_SPRITES：常态 / 炸开。§4.7"只画毛尖碎边"换来的便宜
                               // （按"每根毛有自己的颜色"做要 256 张 sprite，或每帧 2880 段贝塞尔）
  },
  tail: {
    segs: 3,                   // TAIL_SEGS
    lenRatio: 0.5,             // TAIL_LEN_RATIO：× 身体半径。**由体型派生，不新增基因**
    swingBase: 1.2,            // TAIL_SWING_BASE：弧度/秒 × (0.4 + activity) × (1 + arousal)
    // 下面两个是上面那条 spec 公式**自身**的两个常数（§4.7.1 明文写在公式里），
    // 搬进 CONFIG 只是为了让 body.js 保持无字面量。
    swingActivityFloor: 0.4,
    swingArousalGain: 1,
    // 以下七项属 spec §12 授权（"实现时按观感定，两侧取值由测试钉住"）：
    // §4.7.1 只给了幅度的**排序**（幸福 > 快乐 > 安静 > 伤心）与 fear 夹起来、anger 急促，
    // 没给数，所以数在这里，排序在 tests/body.test.js 的四档断言里。
    ampQuiet: 0.12,            // 弧度：安静态的基础摆幅（安静 ≠ 不动，只是幅度小、频率低）
    ampJoy: 0.5,               // 摆幅排序主要由这一项撑起：幸福(1,1) > 快乐(0.6,0.4) > 安静
    ampArousal: 0.18,
    ampAnger: 0.1,
    angerRateGain: 0.8,        // anger=1 ⇒ 摆速 ×1.8（"急促前后抽"）
    fearTuck: 0.85,            // fear=1 ⇒ 摆幅与链长同时收缩 85%（"夹起来"）
    curlQuiet: 0.3,            // 低 joy 时尾尖的静态卷角（"垂着不动，尖端轻微卷"）
    waveLag: 0.7,              // 相邻段的相位差（弧度）：波从根部往尖端传，不是整条一起摆
    followRate: 16,            // 每秒向目标位置松弛的系数（显式积分 ⇒ 必须跑在固定步长里）
    dragRate: 8,               // Verlet 阻尼（每秒，换算成 exp(-rate×dt) 而非每步常数）
  },
  blink: {
    intervalBase: 4.0,         // BLINK_INTERVAL_BASE：秒；实际 = BASE / (0.4 + activity)
    activityFloor: 0.4,        // 同一条 spec §4.6 公式里的地板常数，与尾巴的 activity 同源
  },

  // ---- 世界 ----
  particles: { desktop: 120, mobile: 60 },
  foodMax: 40,
  foodRespawnRate: 0.35,       // 每秒再生概率
  perceiveRadius: 0.28,        // 归一化感知半径
  gridCell: 0.1,               // 空间网格边长（归一化）
  mournRadius: 0.18,           // 目击死亡并进入哀悼的距离

  // ---- 哀悼与死亡动画 ----
  mournDuration: 6,        // 目击死亡后停顿变暗的秒数（spec 4.11）
  dissolveDuration: 4,     // 尸体溶散为微粒的秒数

  // ---- 运动 ----
  motion: {
    baseSpeed: 0.055,      // 归一化世界单位/秒
    stageFactor: { hatchling: 0.45, juvenile: 0.85, adult: 1, elder: 0.55 },
    fleeFactor: 2.2,
    facingLerp: 6,         // 朝向插值速率；实际还会乘 thresholds.turnRate / 4
    wallMargin: 0.03,      // 边界内缩，避免身体一半贴在缸壁上
  },

  // ---- 食物（spec 6.2）----
  food: {
    algae:   { energy: 0.45, respawn: true  },   // 光藻：基础食物，会自然再生
    nectar:  { energy: 0.85, respawn: false },   // 蜜珠：高能量，只能由玩家投喂
    crystal: { energy: 0.15, respawn: false, calms: 0.5 },  // 冰晶：安抚，降 anger/fear
  },

  // ---- 颜色（spec 4.2 / 4.3）----
  colors: {
    bgTop: '#0B0620',
    bgMid: '#1A0B2E',
    bgBottom: '#2D1240',
    mote: '#FFD9E8',
    pupil: '#2D1240',
    blush: '#FF6B9D',
    sakura: '#FFC8DE',
    peach: '#FF9EB5',
    coral: '#FF8FA3',
    orchid: '#E8A7D8',
    rose: '#FF4D8D',
    angry: '#FF1F6B',
    pale: '#D8C4CC',
    drowsy: '#8E6A8C',
  },
};

// 深层冻结，防止运行时被意外改写导致"改了配置却没生效"这类难查的问题。
// 必须完全递归 —— CONFIG 里有三层嵌套（如 motion.stageFactor.hatchling、
// food.algae.energy、needs.hungerRate），只冻一两层会留下可被改写的缺口。
// CONFIG 是一棵纯数据树、无环，所以不需要 visited 集合；
// Object.isFrozen 短路既防重复工作，也让本函数对已冻结的子树安全。
const deepFreeze = (obj) => {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) deepFreeze(value);
  return obj;
};
deepFreeze(CONFIG);

export { CONFIG };
