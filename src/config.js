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
    minDurationBase: 0.6,               // 秒；实际时长 = base / (floor + activity)
    minDurationFloor: 0.3,              // 分母里的常数项：activity=0 时也不许把锁定拉到无穷长
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
    // ---- B19a（2026-10-22）补的显示纪律旋钮（spec §4.13.1 末段；数值侧由
    // tests/render-bubble.test.js 逐条钉住，行为侧在同一文件）----
    bubbleFontPx: 14,                   // spec 逐字「字号 ≥14px」，**CSS 像素**（不是位图）
    bubbleMaxLines: 2,                  // spec 逐字「最多 2 行」⇒ fillText 每帧上界 2×2
    bubbleQueueMul: 4,                  // 队列容量 = onscreenMax × 该值。spec 只说「其余排队」，
                                        // 没说排多少 ⇒ 没有上界就是无界增长（world.events 那个教训）
    bubblePadding: 7,                   // 文本框内边距（也当圆角半径用，不再多一个旋钮）
    bubbleLineGap: 5,                   // 行距（14px 的字挤在一起读不出两行）
    bubbleHeadGap: 8,                   // 框底与毛尖的空隙，同时是那条指向脑袋的小三角的高度
    bubbleFadeHold: 0.4,                // 前 40% 生命满亮，之后 1.8 秒淡到 0（先读得完，再淡出）
    bubbleMaxWidthFrac: 0.34,           // 文本框最宽 34% 视口：再宽就是横跨整缸的一条弹幕
    bubbleStroke: 1.5,                  // 描边粗细（CSS px）：1px 在手机上等于没有绣线
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
    // 它在看着你（spec §4.6 末段）。facing 的松弛目标由好感决定：
    // 高好感转过去、负好感转开、**中间地带什么都不做**（否则就成了"有手就盯着"）。
    // 速率是 turnRate 的一个分数 —— 这是一次 glance，不是瞬间掉头；
    // turnRate 本身由 bold 调制，所以"胆大的敢直视、胆小的瞥一眼就躲"是涌现的。
    lookTowardAffection: 0.2,
    lookAwayAffection: 0,
    lookRateFactor: 0.35,
    // 抚摸买到好感（spec §6.1 的"抚摸 → affection+ / joy+"，2026-10-21 落地）。
    // 三条通道的分工：手在附近且温柔 ⇒ familiarity（认识）；手**贴着身体**且温柔 ⇒
    // affection（喜欢）+ 一次 petted 事件；它自己 beg 蹭上来 ⇒ affection（原有通道）。
    // 接触半径用 sizeOf(c)/1000 —— 与 resolve() 里"两只身体的接触距离"同一口径，
    // 不另立第二个体型→世界坐标的换算，否则两处会漂。
    petContactRatio: 1.15,      // × 身体世界半径；留 15% 余量，指尖"擦到毛边"就算摸到
    petAffectionRate: 0.06,     // 每秒好感：摸 10 秒 +0.6，而半衰期 34.7s ⇒ 不摸就很快还回去
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
    // 求关注升级链的第三条读出通道（spec §4.10："升一级：… 尾巴幅度拉满"）。
    // 档位判定读 CONFIG.behavior.begEscalate 的两个秒数，**不在这里另写阈值**。
    ampBeg: 0.34,              // 第一档给摆幅的加数（拉满；到第二档就**撤掉**，见下面那条）
    begRateGain: 0.9,          // 第二档（protest，背对手生气）给摆速的增益：急促前后抽
  },
  blink: {
    intervalBase: 4.0,         // BLINK_INTERVAL_BASE：秒；实际 = BASE / (0.4 + activity)
    activityFloor: 0.4,        // 同一条 spec §4.6 公式里的地板常数，与尾巴的 activity 同源
  },

  // ---- 眼睛（spec §4.6 的十行表，2026-10-21 B15）----
  // 分工与 mood / tail / blink 三组一样：**数在这里，映射在 src/eyes.js**。
  // eyes.js 里不许出现数值字面量（由 tests/eyes.test.js 的源码扫描钉住，先例是
  // body.test.js 对 body.js 那条），所以十行表每一格的读数都只能从这一段取。
  // 注释里标了"spec 逐字"的那些是 §4.6 表里写死的数值，改它们要先改 spec；
  // 其余属 §12 授权"实现阶段按观感直接定"的范围，改它们只需要一次有意识的动作
  // （tests/eyes.test.js 里那一格的行为断言会跟着红，这是想要的摩擦）。
  eye: {
    // 四参数的基准值（spec §4.6：pupilSize / lidOpen / eyeSpacing / eyeOffset）
    neutralPupil: 0.42,        // 中性瞳孔半径 / 眼睛半径
    spacing: 0.42,             // 两眼圆心间距 / 体直径；单只眼 0.28 ⇒ 边缘几乎相触
    forward: 0.15,             // 眼睛整体沿 facing 前移 / 体直径（脸长在前半侧）
    pupilMin: 0.12,            // 瞳孔下限：再小就在屏幕上塌成一个点
    pupilMax: 0.95,            // 瞳孔上限 = 卖萌那一格（spec 逐字 0.95），婴儿式
    eyeSizeMin: 0.45,          // 害怕收缩的下限（0 半径的路径在 canvas 上是无效绘制）
    leakGain: 0.22,            // 次要情绪的泄漏幅度（spec §4.5："次要情绪会泄漏出来"）
    phaseModulus: 997,         // 眨眼相位的取模质数：由 id 哈希来，不许用随机数也不许用下标

    // 第 1 行 joy 快乐 = ^^ 眯弧
    happyLid: 0.30,            // spec 逐字："眯成两道上弯弧 ^^，lidOpen ≈ 0.3"
    happyPupil: 0.62,          // 开心时瞳孔比中性放大（spec 只说"放大"，数属 §12）

    // 第 2 行 幸福 = 星星眼（2026-10-20 裁定 1：稀有才是奖赏）
    blissPupil: 0.80,          // spec 逐字："pupilSize ≈ 0.8"
    blissLid: 0.92,            // 星星眼要睁着才看得见（不许同时是 ^^）
    starPoints: 4,             // spec 逐字："瞳孔画成**四角星**"
    starSpinMax: 0.22,         // "随 arousal 轻微旋转"的最大弧度（"轻微"有上界）
    starScaleMax: 0.18,        // "随 arousal 轻微缩放"的最大幅度（± 此值）
    starSpinPeriod: 2.6,       // 秒：星慢慢转一圈的周期

    // 第 3 行 伤心 = 委屈眼（2026-10-20 裁定 2：独立形态，不是 fear 的复用）
    sadLid: 0.55,              // spec 逐字："lidOpen ≈ 0.55"
    sadLowerLid: 0.42,         // spec 逐字："**下眼睑上抬**（不是上眼睑下垂）"
    sadPupil: 0.72,            // "瞳孔放大"（spec 只给方向，数属 §12）
    sadSpacing: 0.10,          // "eyeSpacing 外扩"
    sadOffset: -0.18,          // "整只后移"（沿 facing 的负偏移）
    sadHighlightY: 0.45,       // "高光偏到眼睛下缘"（+y = 屏幕向下 ⇒ 含泪感）

    // 第 4 行 anger
    angerPupil: 0.25,          // spec 逐字："pupilSize ≈ 0.25"
    angerTopLid: 0.42,         // "瞪圆但**上眼睑压低**"
    angerSpacing: -0.10,       // "eyeSpacing 内收"（挤在一起 ⇒ 皱眉感）
    angerLid: 0.95,            // 瞪圆：开合几乎不动，压低的活交给 angerTopLid

    // 第 5 行 fear
    fearPupil: 0.15,           // spec 逐字："pupilSize ≈ 0.15"
    fearLid: 1.00,             // "瞪到最大"
    fearOffset: -0.22,         // "eyeOffset 沿 facing 后移"
    fearShrink: 0.22,          // 裁定 2 里害怕的"整只收缩"（委屈没有这一项）

    // 第 6 行 curiosity
    curiosityAsym: 0.55,       // "一只眼睁大一只微眯"：左右 lidOpen 的差
    curiosityPupil: 0.62,      // "瞳孔放大"
    curiosityOffset: 0.14,     // "eyeOffset 前倾"

    // 第 7 行 sleepy
    sleepyLid: 0.40,           // "半闭"
    sleepyBlinkStretch: 2.4,   // "极缓慢地眨"：眨眼周期 × 此值（> 1 才是"缓慢"）

    // 第 8 行 卖萌
    begPupil: 0.95,            // spec 逐字："瞳孔放到最大 ≈ 0.95（婴儿式）"
    begLid: 0.96,              // 卖萌要睁大眼睛（不许被 sleepy 压成半闭）
    begLiftY: 0.20,            // "叠加一个向上的垂直偏移"（微微上望）

    // 第 9 行 信任玩家（猫的 slow blink）
    trustBlinkStretch: 1.8,    // "缓慢眨一次眼"：周期 × 此值
    trustAffectionMin: 0.5,    // 好感低于此不慢眨：陌生人不欠你一个 slow blink

    // 第 10 行 死亡
    deathCloseSeconds: 1.2,    // "眼睛**缓缓**闭合"：从断气到 lidOpen → 0 的秒数

    // 眨眼的波形（三角波：快闭快开、中间有停顿；正弦波看起来像在抽搐）
    blinkWaveFrac: 0.24,       // 一次眨眼占整个周期的比例（其余时间是睁着的）
    arousalPupil: 0.08,        // 兴奋对瞳孔的额外放大（叠加层，不改任何一格的名义值）

    // "看着玩家的手"（spec §4.6 里**瞳孔**那半；facing 那半内核还做不到）
    lookMax: 0.22,             // 瞳孔朝手最多偏移这么多（× 眼睛半径）
    lookTrustMin: 0.35,        // 好感 0 时只看 35% 的幅度（好感低会"转开"）
    handNearRadius: 0.16,      // 归一化距离：手在这个半径内才算"在附近"

    // 瞳孔高光（"有神"的那一笔；常态在左上，委屈那一格被推到下缘）
    highlightX: -0.34,         // × 瞳孔半径，负 = 朝屏幕左
    highlightY: -0.38,         // × 瞳孔半径，负 = 朝屏幕上
    highlightRadius: 0.26,     // × 瞳孔半径

    // 腮红（spec §5.1 第 6 层"眼睛 → 腮红"的后半；§4.5 的卖萌行"腮红泛开"）
    blushAlpha: 0.30,
    blushJoyBoost: 0.35,       // joy=1 时再加这么多
    blushBegBoost: 0.45,       // 卖萌时最明显（spec §4.5 的卖萌行）
    blushMax: 0.85,            // 上限：再红就不是毛绒而是猴屁股
    blushOffsetX: 0.34,        // 沿垂直 facing 方向，两侧各一个 / 体直径
    blushOffsetY: 0.22,        // 沿 facing 方向压到眼睛下方 / 体直径
    blushRadius: 0.16,         // × 体直径
    blushAlong: 0.10,          // 沿 facing 的前移量 / 体直径
  },

  // ---- 渲染（spec §3.4-2 的缩放、§5.2 的水体）----
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

    // 水体（spec §5.2、§4.3）。这些是 §12 授权的"实现阶段按观感直接定"的参数：
    // 光束与微粒的具体运动参数明确列在 §12 里，无需再次确认。
    // 微粒数量不在此处 —— 用 CONFIG.particles（桌面 120 / 手机 60）。
    moteRiseMin: 0.006,        // 归一化单位/秒；横穿整缸约需 167 秒（很慢，是背景不是主角）
    moteRiseMax: 0.020,        // 约 50 秒
    moteRadiusMin: 0.6,        // CSS 像素（乘 viewport.scale 之前的基准值）
    moteRadiusMax: 2.2,
    moteAlphaMin: 0.15,        // spec §4.3：alpha 0.15–0.4（这一对是 spec 给的字面量，不是观感自定）
    moteAlphaMax: 0.40,
    moteDrift: 0.004,          // 横向漂移幅度（正弦摆动的振幅，归一化单位）
    shaftCount: 3,             // spec §5.2：2–3 道
    shaftAlpha: 0.055,         // 用 'lighter' 混合，所以 alpha 必须很低，否则整缸发灰
    shaftSwayPeriod: 26,       // 秒；一道光束摆一个来回的时间。要慢到察觉不到在动
    sedimentHeight: 0.085,     // 占视口高度的比例；卵产在 y ∈ [0.78, 0.97]（breeding.js），
                               // 所以沉积带必须覆盖到 0.915 以上，卵才像是**落在**沉积物里而不是悬空
    moundCount: 5,             // 柔和堆叠形状的数量（spec §5.2：产卵点）

    // ---- 分层身体（spec §5.1 由内到外的第 1/2/3/4/5/7 层，2026-10-20 重排）----
    // 计划 2R B14。眼睛（第 6 层）与语言气泡（第 8 层）不在这里，属 B15/B19；
    // 蹦跳压扁与死亡溶散属 B16，所以本段也**没有**溶散/卵/食物的旋钮。
    // ⚠️ 旧计划 Task 5 的 gelAlpha: 0.55 与 coreAlpha: 0.85 **没有搬过来** ——
    // 它们属于"半透明凝胶团子"那套被否掉的造型（spec §5.1 的四处改动第 1、4 条）。
    glowSpriteSize: 128,       // 光晕 sprite 边长（px）；光斑要放大到体半径的 1.75 倍，分辨率不能太低
    glowRadiusFactor: 1.75,    // 第 1 层：旧值是 2.6。毛会散射光 ⇒ 收小（spec §5.1 第 4 处改动）
    glowAlphaFactor: 0.30,     // 第 1 层：旧值 0.55。现在是"整只柔和地亮起来"，不是"一圈清晰的光边"
    peltSpriteSize: 96,        // 第 2 层本体 sprite 边长（px）；尺寸变化靠缩放，不重建
    peltLitBoost: 0.13,        // 第 2 层：受光侧在**同色相**上提亮的明度量（不跨色相，spec §5.1）
    peltDarkCut: 0.30,         // 第 2 层：背光侧压暗的明度量。与上面那项之和 = 明度跨度（≥8 个百分点）
    peltSatLift: 0.10,         // 第 2 层：受光侧顺带提饱和（毛尖泛白靠第 7 层，这里只让暗面发闷）
    patternAlpha: 0.35,        // 第 3 层：spec 逐字"alpha 压到 0.35 左右"（旧计划是 0.30 的凝胶配套值）
    patternMarkFactor: 0.16,   // 第 3 层：单个花纹斑点的半径 = 体半径 × 此值 × 密度
    innerRadiusFactor: 0.46,   // 第 4 层：旧"发光核"是 0.30（一颗）；亮区是**一片**，必须更大
    innerAlpha: 0.34,          // 第 4 层：旧 coreAlpha 0.85 比毛还实；透过毛看到的亮区要低得多
    innerPulse: 0.45,          // 第 4 层：呼吸幅度（节奏仍来自 body.js 的 phase/pulse，不在这里另计时钟）
    tailSegFactor: 0.72,       // 第 5 层：单段贴图的半径 = 段长 × 此值（段数恒 CONFIG.tail.segs，spec §5.3）
    tailTaper: 0.20,           // 第 5 层：段间递减（根粗尖细），3 段之后仍 > 0
    tailLiftFactor: 0.30,      // 第 5 层：屏幕空间的"高举"量 × 摆幅（§4.7.1 表里幸福那一档）
    fluffSpriteSize: 160,      // 第 7 层碎边 sprite 边长（px）；**总共只有 CONFIG.fluff.sprites 张**

    // ---- B16（2026-10-21）：死亡溶散 / sick / 哀悼 / 卵 / 食物 / 蹦跳 ----
    // 这一段的分工与上面几段一致：数在这里，**行为**由 tests/render-fx.test.js 钉。
    // 死亡溶散（spec §4.11 那一行："停止运动 → 光慢慢熄灭 → 身体溶散成微粒上升消散"）。
    // ⚠️ 时长**不在这里**：它用内核的 CONFIG.dissolveDuration（4 秒），因为 reapDead
    // 就是按 dying >= dissolveDuration 把个体 splice 掉的（sim.js 的 reapDead）。
    // 表现层另计一套时钟必然漂移，症状是"动画没播完生物就没了"或反过来。
    dissolveExpand: 1.9,       // 结束时体型放大到 1.9 倍：**散开**而不是缩没
    dissolveLift: 0.035,       // 同时向上漂移的归一化距离（"溶进水里"）
    dissolveAlphaPow: 2,       // 身体 alpha = (1−t)^此值：末尾"化掉"而不是线性淡出
    dissolveGlowPow: 3,        // 光晕 alpha = (1−t)^此值：**幂更大 ⇒ 光比身体先熄灭**（spec 那句话的顺序）
    dissolveParticles: 14,     // 每只死亡时爆发的微粒数
    burstPool: 240,            // 粒子对象池容量。**刻意小于** 24×14=336：池满就环形覆盖最老的粒子，
                               // 而同帧 24 只全死在实际模拟里不会发生（死亡是稀疏事件）。
                               // 环形覆盖保证永不扩容 ⇒ 永不分配（spec §5.3）。
    // sick（spec §7.7："单只生物 tick 抛异常 → 隔离这一只、标 sick"；sim.js 把
    // "画成变暗、静止，而不是无声地少一只"这条义务点名交给了表现层）
    sickDim: 0.35,             // 亮度乘数：暗到明显异常，但仍看得清是什么
    sickDesat: 0.55,           // 去饱和比例。**换档而不是加滤镜**：ctx.filter 在部分移动端
                               // 浏览器上不支持或极慢，而 spec §5.3 的预算是按手机算的。
    // 哀悼（spec §4.11："死亡时附近的个体会停顿、变暗一小会儿"；时长 = CONFIG.mournDuration）
    mournDim: 0.72,            // 比 sick 轻：哀悼是情绪、不是故障，不该看起来像坏了
    // 卵（spec §4.11 / §4.12 第 6 条）
    eggRadius: 12,             // 世界单位半径（× viewport.scale × eggSize），eggSize 的两端是 0.6/1.4
    eggGlowPulse: 0.30,        // 可孵化卵的脉动幅度（"缸底微光脉动"）
    eggFailFadeTime: 22,       // 不可孵化卵的光在多少个 **egg.age 秒**内熄灭（同一条时间轴）
    eggFailMinGlow: 0.06,      // 熄灭后的残光：彻底消失就又变成一条**静默的禁令**了
    eggRevealAt: 0.60,         // 孵化进度到这一档才开始"壳内透出轮廓"（spec §4.11 卵那一行）
    // 食物（spec §6.2 的三种外观）
    foodRadius: 7,             // 世界单位基准半径（× viewport.scale × amount 项）
    // 蹦跳（spec §4.7.2 落地那半句 + §4.7 的 squash & overshoot）
    // ⚠️ 竖向偏移**不是世界状态**：它每帧由 intent.kind === 'hop' 与 intentTime 重算，
    // 不入档（spec §7.2"表现层的身体状态一律不入档"），时长读 intent.minDuration。
    hopLiftRatio: 0.55,        // 最高点 = 该值 × 身体半径 × 冲量（冲量见 CONFIG.hop.impulseBase）
    hopLandAt: 0.72,           // 落地落在 hop 窗口的这一进度上，**留出后面的过冲段**
    hopSquashMin: 0.62,        // 落地那一刻的竖向尺度（压扁 38%）
    hopStretchAir: 1.10,       // 滞空中点的竖向尺度（拉长 10%；与压扁共用一条 sin 弧）
  },

  // ---- 叫声（spec §5.4 的声音表 + §5.4.1 的落地裁定，2026-10-22 B18）----
  // 分工与 eye / render 两段完全一致：**数在这里，映射与调度在 src/audio.js**（纯函数、
  // Node 里全测），而 AudioContext 只出现在 src/main.js。
  // 表里那六个 fromHz/toHz 是 spec §5.4 **逐字**的数（600→900、400→200、90–140、
  // 下滑、上扬、极轻），它们描述的是**参考体型**那一只的嗓音；真实个体要乘 voiceFor()
  // 从体型推导的音高因子 —— 这就是"音高随体型、音色随色相"那条 headline 的实现方式。
  // 新增的 thud / chirp 两行**不在 spec 表里**，是计划 2 的两条增量，理由写在 §5.4.1 第 5 条。
  audio: {
    masterGain: 0.16,            // spec §5.4"默认开启、音量很小"。总线上还有一层，见 peak
    maxVoices: 6,                // 同时活跃的发声数上界；溢出**计数丢弃**（§7.7 不许静默丢）
    lookaheadSec: 0.012,         // 排程提前量：0 时刻排程会让 Web Audio 立刻截掉起音
    refSize: 26,                 // 参考体型 = (minSize+maxSize)/2 的中性成体（与 needs 那段同源）
    pitchMin: 0.55,              // 音高因子两端：大只最低 0.55×、小只最高 2.6×
    pitchMax: 2.6,
    hueBuckets: 12,              // 音色分桶：同一桶 = 同一家族的嗓音（血脉可听）
    hueTurn: 360,                // 一整圈：跨 0° 区间的展开式里那个 360（genes.decode 同一条式子）。
                                 // 它是结构常数而不是调参旋钮，但 audio.js 不许有字面量
                                 // （先例：body.js 连五角星的"五"都搬进了 CONFIG.star.corners）。
    // 音色这两项**都相对基频**，不是绝对 Hz：低通的绝对中心一旦落在基频之下，
    // 它就不再是"音色"而是"音量"（600→900 那一声被 700Hz 低通一砍，只剩发闷）。
    // 于是色相决定的是"泛音留多少"与"倍音偏多少"，与体型推出的音高不会互相抵消。
    filterRatioMin: 2,           // 低通中心 = 基频 × 此区间的一端（桶 0，最暗的一系）
    filterRatioMax: 6,           // 桶末（最亮的一系）
    filterQ: 1.1,
    overtoneMix: 0.18,           // 倍音那只振荡器的增益 / 主振荡的 peak（"嗓音里的共鸣"）
    overtoneRatioMin: 2.02,      // 倍音比：略微偏离八度 ⇒ 拍频，血脉之间听得出"不是同一副嗓子"
    overtoneRatioMax: 2.97,

    // ---- 检测阈值（内核**没有**情绪事件，见 §5.4.1 第 1 条：表现层只读阈值跨越）----
    // joyMin / angerMin **不在这里**：读 CONFIG.mood.happyJoyMin 与 CONFIG.mood.angerMin，
    // 与 body.js 读 CONFIG.behavior.begEscalate 同一条纪律（阈值只许一处定义）。
    sleepyMin: 0.50,             // emotions.sleepy 跨过它 → 困倦那一声明
    tiredMin: 0.72,              // needs.energy（疲劳匮乏度）跨过它 → 同一声明（两个读数共用一条冷却）
    affectionMin: 0.35,          // 对玩家好感跨过它 → 卖萌那一声明（另一条来源是 begLevelOf 升档）
    cooldownSec: 4,              // 同一只、同一声明的最小**真实秒**间隔。防的是阈值沿线抖动
                                 // （joy 在 0.45 上下微摆时，只靠"跨越"会连发）。
    thudGapSec: 0.35,            // 落地闷响的**全局**最小间隔：24 只好动个体在 4× 下不能变成机关枪
    thudPerSec: 0.9,             // 同一只两次落地之间的最小间隔（一个 hop 窗口最多一记）
    // 出词前那记「啾」的**全局**闸门。数值是**量出来的**（spec §5.4.1 第 5 条）：
    // 60 分钟一缸实测最坏单秒 5 句、最坏三秒窗 8 句 ⇒ 4× 下就是 20 记/真实秒，而单音长只有 0.045s。
    // 0.3 刻意选在"**1× 下不 binding**（三秒窗最多放行 10 记 > 实测 8 记）、4× 下才咬人"：
    // 正常话痨的手感一个字都不动，只把倍速捅出来的那一梭子拦住。上限 ≈ 3.3 记/真实秒。
    chirpGapSec: 0.3,
    releaseSec: 0.03,            // 每个声部在 noteSec 之后的释音段（stop 时刻 = 音长 + 这一段）
    silenceGain: 0.0001,         // 包络终点的"零"：真 0 会让 exponentialRamp 在本秒变成非法值
    noiseStepSec: 0.031,         // 噪声层各段读取共享 buffer 的偏移步长（碎裂感的来源）
    noiseBufferSec: 0.2,         // 那块共享 buffer 的秒数；必须盖过最大偏移 + 最长一段
    fallbackSampleRate: 44100,   // 注入的图没有 sampleRate 时用它（真实浏览器都是 44100/48000）
    lfoSeedModulus: 7,           // 「生气抖动」速率的每只变化量：**由 id 派生**，不消费随机数
    lfoSeedSpread: 0.06,         // × 上述派生的偏移（±3 × 0.06 ⇒ 速率在 0.82–1.18 之间散开）

    // 八行的共同形状：wave / fromHz / toHz / noteSec / gapSec / reps / attack / peak / pitchMix。
    // pitchMix = 音高因子**用多少**：1 = 全额随体型（spec 要求的那几行与那记「啾」），
    // 0.5 = 只走一半（低沉那一类的低频端再乘 0.55 就掉到手机扬声器发不出的 39Hz）。
    // noise* 四项只在有噪声层的行里出现（气泡噪声 / 细碎裂声），没有就不写。
    joy: { wave: 'sine', fromHz: 600, toHz: 900, noteSec: 0.085, gapSec: 0.055, reps: 2,
           attack: 0.006, peak: 0.50, pitchMix: 1 },
    beg: { wave: 'triangle', fromHz: 400, toHz: 200, noteSec: 0.14, gapSec: 0, reps: 1,
           attack: 0.008, peak: 0.42, pitchMix: 1,
           noiseCount: 4, noiseDur: 0.030, noiseGap: 0.028, noisePeak: 0.10 },
    anger: { wave: 'sawtooth', fromHz: 140, toHz: 92, noteSec: 0.34, gapSec: 0, reps: 1,
             attack: 0.020, peak: 0.46, pitchMix: 1,
             lfoRateBase: 11, lfoDepthHz: 8 },      // "轻微抖动"：LFO 调制主振荡的频率
    sleepy: { wave: 'sine', fromHz: 300, toHz: 120, noteSec: 0.80, gapSec: 0, reps: 1,
              attack: 0.260, peak: 0.32, pitchMix: 1 },   // 柔和起音 = attack 占掉三分之一音长
    hatch: { wave: 'sine', fromHz: 520, toHz: 900, noteSec: 0.16, gapSec: 0, reps: 1,
             attack: 0.008, peak: 0.36, pitchMix: 1,
             noiseCount: 6, noiseDur: 0.018, noiseGap: 0.032, noisePeak: 0.14 },
    death: { wave: 'sine', fromHz: 230, toHz: 96, noteSec: 0.90, gapSec: 0, reps: 1,
             attack: 0.120, peak: 0.12, pitchMix: 1 },     // 几乎听不见：peak 是全表最低一档
    thud: { wave: 'sine', fromHz: 118, toHz: 58, noteSec: 0.10, gapSec: 0, reps: 1,
            attack: 0.004, peak: 0.34, pitchMix: 0.5 },
    chirp: { wave: 'sine', fromHz: 1150, toHz: 1560, noteSec: 0.045, gapSec: 0, reps: 1,
             attack: 0.003, peak: 0.20, pitchMix: 1 },
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
    // B15 眼睛（spec §4.6）。eyeWhite 不是纯白而是带回粉的白：
    // 纯白的眼白贴在粉色卷毛上会读成"贴纸"，而 spec §4.2 那条"不用纯黑"是同一个理由的两端。
    eyeWhite: '#FFF2F8',
    eyeHighlight: '#FFFFFF',   // 瞳孔高光那一笔是纯白：它要的就是"湿"的反光
    sakura: '#FFC8DE',
    peach: '#FF9EB5',
    coral: '#FF8FA3',
    orchid: '#E8A7D8',
    rose: '#FF4D8D',
    angry: '#FF1F6B',
    pale: '#D8C4CC',
    drowsy: '#8E6A8C',
    // 计划 2 新增的三个表现层颜色。spec §4.3 只给了背景三段色，
    // 沉积带与光束的色值属 §12"实现阶段按观感直接定"的范围。
    // 沉积带比 bgBottom(#2D1240) **更暗**：它在缸底、离光源最远，
    // 而且要比卵的发光暗得足够多，卵才"像在沉积物里发亮"。
    sediment: '#170A22',
    sedimentLight: '#3A1850',   // 堆叠形状的受光面，制造体积感
    shaft: '#6A4A8A',           // 光束：偏冷的紫，用 'lighter' 叠上去后接近水的散射色
    // 三种食物的颜色（spec §6.2）。
    // ⚠️ **刻意全部避开粉色**：spec §6.2 的原话是三种食物"避开粉色系（青绿 / 琥珀 / 淡蓝），
    // 这样它们在粉紫色的世界里一眼可辨，不会被误认为生物"。所以这里出现青绿/琥珀/淡蓝
    // 不是配色失误，是设计要求 —— 改这三个颜色会直接违反 spec §6.2，
    // 由 tests/render-fx.test.js 的"三种食物刻意避开粉色系"用色相并集判定拦住。
    algae: '#7FE3B0',           // 青绿光藻：基础食物，会自然再生（初始缸里就有 12 份）
    nectar: '#FFC46B',          // 琥珀金珠：高能量，争抢的主要来源（色相 36°，恰在粉色区外）
    crystal: '#A8D8FF',         // 淡蓝结晶：安抚，玩家的"灭火器"
    // 蛋色（spec §11 EGG_TINTS 的八色：**键集必须与 CONFIG.eggTint.colors 同一份**）。
    // 具体色值属 §12 授权（按观感定），但 spec §11 留了两条硬要求：
    //   ① 在深靛紫底（#2D1240）上全部可读 ⇒ 黑蛋不能真是 #000000（那样在缸底彻底看不见），
    //      它是八色里最暗的一档但仍抬到对比度下限之上；
    //   ② 不与 PUPIL_COLOR（#2D1240）撞色。
    // 两条都由 tests/render-fx.test.js 用独立实现的相对亮度算子核对（不在 src/ 里，
    // 因为表现层不得自己再解码一次颜色空间）。
    eggTints: Object.freeze({
      'macaron-pink': '#FFB3D1',
      'macaron-blue': '#A8CFFF',
      'macaron-mint': '#A6E9C8',
      'macaron-lilac': '#D8BEFF',
      'macaron-cream': '#FFEFC2',
      'macaron-peach': '#FFC9A3',
      'white': '#F6F1F8',       // 不是纯白：纯白贴在深紫上会读成"贴纸"（B15 眼白那条同理由）
      'black': '#4A4458',       // 抬亮的炭灰：可读性下限要求的唯一一处妥协，见上面 ①
    }),
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
