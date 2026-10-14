import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { decode, randomGenome } from '../src/genes.js';
import { createRng } from '../src/rng.js';
import { createNeeds, decay, feed, startle, comfort, mostUrgent } from '../src/needs.js';

// 中性个体：把会被基因调制的项固定住，好断言"谁比谁快"这类方向性结论。
// 注意它**不能**用来断言绝对量级 —— decode(randomGenome(…)) 的 size 由 rng 决定，
// 期望值无法手算。量级由下面 PINNED_TRAITS 那条测试负责。
const neutralTraits = () => {
  const t = decode(randomGenome(createRng(1)));
  t.personality.gluttonous = 0.5;
  t.personality.clingy = 0.5;
  t.personality.bold = 0.5;
  t.size = (CONFIG.minSize + CONFIG.maxSize) / 2;
  return t;
};
const IDLE = { moving: false, resting: false, companions: 0 };

// 量级钉桩专用的显式性状。刻意不复用 neutralTraits()：如果在这里重算一遍
// decay 的公式（例如写成 CONFIG.needs.hungerRate * sizeFactor * 30），
// 那只是同义反复 —— 速率表改成什么值它都跟着变，永远通过。
//
// 这里改成完全显式、可手算的取值，让 decay 会读的四个调制因子都恰好等于 1.0：
//   size       = 19（= maxSize 38 的一半）→ sizeFactor    = 0.7 + (19/38)×0.6 = 1.0
//   gluttonous = 0.5                      → gluttonFactor = 0.7 + 0.5×0.6     = 1.0
//   clingy     = 0.5                      → clingyFactor  = 0.6 + 0.5×0.8     = 1.0
//   bold       = 0.5                      → boldFactor    = 0.5 + 0.5         = 1.0
// 于是每条需求在 t 秒后的变化量就退化成"裸速率 × t"，字面量可以肉眼复核。
// 只列出 decay 实际读取的字段；hue/sat/lum/pattern 等它根本不碰，故无需提供。
const PINNED_TRAITS = { size: 19, personality: { gluttonous: 0.5, clingy: 0.5, bold: 0.5 } };
// 20s 是 safety 允许的最长窗口：safety 是四条里走得最快的（0.02/s，且方向向下），
// 从 0.5 出发会在 25s 撞到下界 clamp。取 20s 让四条需求全部停在纯线性区。
const PIN_HORIZON = 20;
const PIN_SEED = { hunger: 0, energy: 0.5, social: 0, safety: 0.5 };

test('createNeeds 的初值被精确钉住（键集 + 数值）', () => {
  // 一条 deepEqual（strict 模式下即 deepStrictEqual）同时钉住：键集不多不少、
  // 每个初值的确切数字、以及原型。因此旧的 sorted-keys 检查与 [0,1] 范围检查
  // 都被它完全涵盖，留着只是噪音。
  //
  // 为什么要钉死数值而不是"低匮乏就行"：hunger = 0.15 是让新孵化的幼体立刻
  // 开始觅食的设计值（见 src/needs.js 里的注释）。松断言（hunger < 0.3、
  // safety === 0）会让 energy / social 悄悄变成 0 或 0.29 都通过 ——
  // 而这两条恰好决定了幼体孵化后多久会累、多久会孤独。
  assert.deepEqual(createNeeds(), { hunger: 0.15, energy: 0.1, social: 0.1, safety: 0 });
});

test('时间流逝使饥饿上升', () => {
  const n = createNeeds();
  n.hunger = 0;
  decay(n, 10, neutralTraits(), IDLE);
  assert.ok(n.hunger > 0);
});

test('长时间无人照料：需求饱和于边界且始终有限', () => {
  // 这条测试曾经叫"约 120 秒饥饿升到可观水平但不越界"，断言 hunger > 0.4 && <= 1。
  // 那个名字是假的：按真实速率，hunger 在约 108.5s 就撞到上界 clamp，
  // 之后一直停在 1，所以断言检验的是 clamp01 而不是速率 —— 把 hungerRate
  // 改大 10 倍它照样通过。而 src/config.js 里恰好有一条注释警告
  // "别用 120s 窗口，已经越过 clamp"，两者自相矛盾。
  //
  // 速率的**绝对量级**由下面那条显式性状的钉桩测试负责（20s 线性区 + 字面量）。
  // 这条测试的职责是另一件事，也是它那条 <= 1 断言从头到尾真正在测的东西：
  // 长时间放养之后，每条需求都停在边界上，且不会溢出、不会变成 NaN。
  //
  // 别把它"修"回速率测试 —— 那会重新变成一条名字骗人的空断言。
  const n = createNeeds();
  n.hunger = 0;
  const t = neutralTraits();
  for (let i = 0; i < 600 * 60; i++) decay(n, 1 / 60, t, IDLE);   // 10 分钟模拟时间

  // 从不喂食 ⇒ hunger 走满上界。用 exact 相等：clamp 之后它就是字面量 1，
  // 任何"超过 1 又没被夹住"的实现都会在这里露出来（600s 裸积分约 5.5）。
  assert.equal(n.hunger, 1, `600s 不喂食后 hunger 应饱和于 1，实际 ${n.hunger}`);
  // safety 只随时间下降且初值为 0 ⇒ 恒为 0，绝不能变成负数（spec 8.1：满足后不会变负）。
  assert.equal(n.safety, 0, `safety 应停在下界 0，实际 ${n.safety}`);

  // energy 与 social 在 600s 下同样饱和于 1，这里只要求它们合法，
  // 免得把初值/速率的任何调整都变成对这条测试的破坏。
  for (const [k, v] of Object.entries(n)) {
    assert.ok(v >= 0 && v <= 1, `${k} 越界: ${v}`);
    // 这一条比看上去重要：clamp01 会原样放过 NaN（NaN < 0 与 NaN > 1 都是 false），
    // 而 mostUrgent() 里 NaN > bestV 也恒为 false —— 于是一个 NaN 需求会
    // 在行为评分里静默失去发言权，全程不报错。长时间积分正是它最可能现形的地方。
    assert.ok(Number.isFinite(v), `${k} 非有限数: ${v}`);
  }
});

test('所有需求永远被 clamp 在 [0,1]', () => {
  const n = createNeeds();
  const t = neutralTraits();
  for (let i = 0; i < 60 * 60 * 10; i++) {
    decay(n, 1 / 60, t, { moving: true, resting: false, companions: 0 });
  }
  for (const [k, v] of Object.entries(n)) assert.ok(v >= 0 && v <= 1, `${k} 越界: ${v}`);
});

test('四条需求的衰减速率绝对量级被硬编码字面量钉住（spec：衰减速率正确）', () => {
  // 为什么必须有这一条：spec 对本模块的测试要求就是"衰减速率正确"，但本文件
  // 其余断言全部只约束**方向**（A > B）。方向对量级毫无约束力 —— 整张速率表
  // 统一乘 13 倍、energyRateIdle 写成 0、socialRate 写成 1e-6，都能全绿。
  // 原来那条"约 120 秒"的长窗口测试也堵不上这个洞：hunger 在 ~108.5s 就撞上
  // 上限 clamp 并被钉在 1，所以它实际检验的是 clamp01，不是速率。
  //
  // 做法：把窗口压到 20s（见 PIN_HORIZON 的注释：这是 safety 撞下界前的最长余量），
  // 配合 PINNED_TRAITS 让四个调制因子都恰好为 1.0，于是每条需求的位移就是
  // "裸速率 × 20s"，可以直接写死成字面量。算式就写在每个字面量右边，便于复核。
  //
  // 断言分两趟：第一趟先确认四条结果**严格落在 (0,1) 内部**。这一步是守卫，
  // 不是凑数 —— 如果将来有人把某个速率改大到 20s 内就触发 clamp，clamp 会把
  // 越界的值洗成 0 或 1，量级断言可能因此静默通过或给出一条误导性的失败。
  // 让守卫先炸出来，失败信息才指向真正的原因。
  // 下面四个 ctx 各自给全四条需求的期望值。hunger 和 safety 完全不读 ctx，
  // 所以四行数值相同；social 只在 companions > 0 时不同；energy 三个分支各不同。
  // 重复写出而不是只在 idle 那组写，是为了让任何一条在某 ctx 下"意外开始读 ctx"
  // 都能被当场抓住。
  const CASES = [
    {
      name: 'idle（静止无伴）',
      ctx: { moving: false, resting: false, companions: 0 },
      expect: {
        hunger: 0.166,   // 0 + 0.0083 × 1.0 × 1.0 × 20 = 0.166
        energy: 0.534,   // 0.5 + 0.0017 × 20           = 0.534
        social: 0.112,   // 0 + 0.0056 × 1.0 × 1 × 20   = 0.112
        safety: 0.1,     // 0.5 − 0.02 × 1.0 × 20       = 0.1
      },
    },
    {
      name: 'moving（移动）',
      ctx: { moving: true, resting: false, companions: 0 },
      expect: {
        hunger: 0.166,   // 同上，hunger 与 ctx 无关
        energy: 0.584,   // 0.5 + 0.0042 × 20           = 0.584
        social: 0.112,
        safety: 0.1,
      },
    },
    {
      name: 'resting（休息，energyRateRest 是负速率）',
      ctx: { moving: false, resting: true, companions: 0 },
      expect: {
        hunger: 0.166,
        energy: 0.16,    // 0.5 + (−0.017) × 20         = 0.16
        social: 0.112,
        safety: 0.1,
      },
    },
    {
      name: 'companions=3（有同伴，socialRelief 生效）',
      ctx: { moving: false, resting: false, companions: 3 },
      expect: {
        hunger: 0.166,
        energy: 0.534,
        social: 0.0112,  // 0 + 0.0056 × 1.0 × (1 − 0.9) × 20 = 0.0112
        safety: 0.1,
      },
    },
  ];

  for (const c of CASES) {
    const n = createNeeds();
    Object.assign(n, PIN_SEED);
    for (let i = 0; i < PIN_HORIZON * 60; i++) decay(n, 1 / 60, PINNED_TRAITS, c.ctx);

    // 守卫趟：四条都必须严格在开区间内，否则下面的量级比较失去意义
    for (const k of Object.keys(c.expect)) {
      assert.ok(n[k] > 0 && n[k] < 1,
        `${c.name} / ${k} 在 ${PIN_HORIZON}s 内触及 clamp（实际 ${n[k]}）——`
        + ' 量级断言会被 clamp 掩盖，请缩短窗口或调整 PIN_SEED');
    }
    // 量级趟：与字面量逐一比对。1e-9 的容差只为吸收 1200 次 1/60 步累加的
    // 浮点结合误差（实测最大偏差约 2e-13），远小于任何有意义的速率改动。
    for (const [k, want] of Object.entries(c.expect)) {
      assert.ok(Math.abs(n[k] - want) < 1e-9,
        `${c.name} / ${k}: 实际 ${n[k]}，钉住的期望 ${want}`);
    }
  }
});

test('结果与时间步长无关（固定步长的核心保证，spec 8.1）', () => {
  // 在不触发 clamp 的区间内，60 步 × 1/60s 必须严格等于 1 步 × 1s。
  //
  // 这条测试对**每个 ctx 分支**都跑一遍，而不只是 idle。理由：步长无关性是
  // "每个速率都是每秒线性量"这个前提的唯一守卫，而 energy 的三条分支
  // （energyRateIdle / energyRateActive / energyRateRest）和 social 的 relief
  // 分支各自的量纲都可能写错 —— 比如把 energyRateRest 当成"每帧"而不是"每秒"，
  // 只测 idle 永远发现不了。此前 resting 分支的这项覆盖来自 rest() 的专属测试；
  // rest() 已按评审意见删除（它是 decay 休息分支的逐字副本，单独调用会冻结
  // 另外三条需求、与 decay 同时调用会让精力恢复跑成 2 倍速），覆盖必须搬到这里，
  // 不能留空。
  //
  // 这里继续用 neutralTraits() 而非 PINNED_TRAITS：它的 sizeFactor ≈ 1.1105
  // 不等于 1.0，正好顺带检验"调制因子非平凡时步长无关性依然成立"。
  // 绝对量级由上一条测试负责，两条互补。
  const t = neutralTraits();
  const CONTEXTS = [
    ['idle', { moving: false, resting: false, companions: 0 }],
    ['moving', { moving: true, resting: false, companions: 0 }],
    ['resting', { moving: false, resting: true, companions: 0 }],
    ['companions=3', { moving: false, resting: false, companions: 3 }],
  ];
  // 两条**会下降**的需求刻意不播 0，否则断言会退化成恒真：
  //   safety 是 decay 里唯一无条件下降的需求，从 0 出发会被钉在下界，两条路径都
  //        得到 0，比较毫无信息量 —— 所以播 0.5（这是本测试原本就有的设计）。
  //   energy 在 resting 分支同样下降（energyRateRest = −0.017），从 0 出发会犯
  //        一模一样的错，因此新增 resting 上下文时必须把它也改成播 0.5。
  // hunger / social 恒增，播 0 没问题：1s 后分别约 0.0092 / 0.0056
  //        （有同伴时 0.00056），都严格大于 0。
  // 1s 窗口下四条需求的位移都 ≤ 0.02，离两个边界都很远。但这个"很远"不靠
  // 注释担保 —— 下方守卫断言会把"其实已经 clamp 了"当场暴露出来。
  const SEED = { hunger: 0, energy: 0.5, social: 0, safety: 0.5 };

  for (const [name, ctx] of CONTEXTS) {
    const a = createNeeds();
    const b = createNeeds();
    for (const n of [a, b]) Object.assign(n, SEED);
    for (let i = 0; i < 60; i++) decay(a, 1 / 60, t, ctx);
    decay(b, 1, t, ctx);
    for (const k of Object.keys(a)) {
      assert.ok(a[k] > 0 && a[k] < 1 && b[k] > 0 && b[k] < 1,
        `${name} / ${k} 触及 clamp（${a[k]} vs ${b[k]}）—— 两条路径会一起被钉在边界上，`
        + ' 比较退化成恒真；请缩短窗口或调整 SEED');
      assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${name} / ${k}: ${a[k]} vs ${b[k]}`);
    }
  }
});

test('贪吃基因使饥饿上升更快', () => {
  const base = neutralTraits();
  const gluttonous = { ...base, personality: { ...base.personality, gluttonous: 1 } };
  const abstemious = { ...base, personality: { ...base.personality, gluttonous: 0 } };
  const a = createNeeds(); a.hunger = 0;
  const b = createNeeds(); b.hunger = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, gluttonous, IDLE);
    decay(b, 1 / 60, abstemious, IDLE);
  }
  assert.ok(a.hunger > b.hunger, '贪吃者应更饿');
});

test('体型更大者饥饿上升更快', () => {
  const base = neutralTraits();
  const big = { ...base, size: CONFIG.maxSize };
  const small = { ...base, size: CONFIG.minSize };
  const a = createNeeds(); a.hunger = 0;
  const b = createNeeds(); b.hunger = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, big, IDLE);
    decay(b, 1 / 60, small, IDLE);
  }
  assert.ok(a.hunger > b.hunger);
});

test('有同伴在场时社交匮乏显著更慢', () => {
  const t = neutralTraits();
  const alone = createNeeds(); alone.social = 0;
  const together = createNeeds(); together.social = 0;
  for (let i = 0; i < 600; i++) {
    decay(alone, 1 / 60, t, { moving: false, resting: false, companions: 0 });
    decay(together, 1 / 60, t, { moving: false, resting: false, companions: 3 });
  }
  assert.ok(together.social < alone.social, '有同伴不应更孤独');
});

test('黏人基因使社交匮乏上升更快', () => {
  const base = neutralTraits();
  const clingy = { ...base, personality: { ...base.personality, clingy: 1 } };
  const aloof = { ...base, personality: { ...base.personality, clingy: 0 } };
  const a = createNeeds(); a.social = 0;
  const b = createNeeds(); b.social = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, clingy, IDLE);
    decay(b, 1 / 60, aloof, IDLE);
  }
  assert.ok(a.social > b.social);
});

test('移动时精力消耗快于静止', () => {
  const t = neutralTraits();
  const moving = createNeeds(); moving.energy = 0;
  const idle = createNeeds(); idle.energy = 0;
  for (let i = 0; i < 600; i++) {
    decay(moving, 1 / 60, t, { moving: true, resting: false, companions: 0 });
    decay(idle, 1 / 60, t, IDLE);
  }
  assert.ok(moving.energy > idle.energy, 'energy 是匮乏度，移动者应更高');
});

test('休息时精力匮乏下降', () => {
  const n = createNeeds();
  n.energy = 0.8;
  for (let i = 0; i < 600; i++) decay(n, 1 / 60, neutralTraits(), { moving: false, resting: true, companions: 0 });
  assert.ok(n.energy < 0.8, `休息后应恢复，实际 ${n.energy}`);
});

test('胆大基因使安全感恢复更快', () => {
  const base = neutralTraits();
  const bold = { ...base, personality: { ...base.personality, bold: 1 } };
  const timid = { ...base, personality: { ...base.personality, bold: 0 } };
  const a = createNeeds(); a.safety = 0.9;
  const b = createNeeds(); b.safety = 0.9;
  for (let i = 0; i < 300; i++) {
    decay(a, 1 / 60, bold, IDLE);
    decay(b, 1 / 60, timid, IDLE);
  }
  assert.ok(a.safety < b.safety, '胆大者应更快平静（safety 是匮乏度）');
});

test('feed 降低饥饿且不会变负', () => {
  const n = createNeeds(); n.hunger = 0.8;
  feed(n);
  assert.ok(n.hunger < 0.8);
  feed(n); feed(n); feed(n);
  assert.equal(n.hunger, 0, '吃饱后不得为负');
});

test('feed 接受自定义份量', () => {
  const n = createNeeds(); n.hunger = 1;
  feed(n, 0.25);
  assert.ok(Math.abs(n.hunger - 0.75) < 1e-9);
});

test('startle 提高不安全、comfort 降低不安全，均 clamp', () => {
  const n = createNeeds(); n.safety = 0;
  startle(n);
  assert.ok(n.safety > 0.4);
  startle(n); startle(n); startle(n);
  assert.equal(n.safety, 1, '不得超过 1');
  for (let i = 0; i < 10; i++) comfort(n);
  assert.equal(n.safety, 0, '不得低于 0');
});

test('两个冲激常量的绝对量级被字面量钉住（feedAmount / startleAmount）', () => {
  // 上一轮把四条**速率**钉住了，但两个**冲激**常量仍然只有下界：
  // 旧断言 `n.safety > 0.4` 对 startleAmount = 0.45 和 = 1.0 都成立，
  // feedAmount 只要 >= 0.2 也能过。这两个数是"手感"常量 ——
  // 喂一口能压下去多少饥饿、戳一下能吓出多少不安 —— 数量级写错
  // 不会让任何测试变红，只会让整个照料节奏悄悄变味。
  //
  // 起点刻意选在不触发 clamp 的位置，否则断言测的是 clamp01 而不是常量本身
  // （这正是"约 120 秒"那条测试曾经犯过的错，见其注释）。
  // 字面量必须是字面量：写成 0.9 - CONFIG.needs.feedAmount 就是同义反复，
  // 常量改成什么它都跟着变，永远通过。

  // startle: 0 + startleAmount = 0 + 0.55 = 0.55（安全感的匮乏度上升）
  const a = createNeeds(); a.safety = 0;
  startle(a);
  assert.ok(Math.abs(a.safety - 0.55) < 1e-9, `startle 后 safety = ${a.safety}，期望 0.55`);

  // feed: 0.9 - feedAmount = 0.9 - 0.45 = 0.45（饥饿下降）
  const b = createNeeds(); b.hunger = 0.9;
  feed(b);
  assert.ok(Math.abs(b.hunger - 0.45) < 1e-9, `feed 后 hunger = ${b.hunger}，期望 0.45`);

  // comfort: 0.9 - startleAmount = 0.9 - 0.55 = 0.35
  // 这一条同时钉住了 comfort 默认复用 startleAmount 的那个耦合：
  // 若哪天有人给 comfort 换成别的默认值（或把两个常量拆开），这里会立刻变红。
  const c = createNeeds(); c.safety = 0.9;
  comfort(c);
  assert.ok(Math.abs(c.safety - 0.35) < 1e-9, `comfort 后 safety = ${c.safety}，期望 0.35`);
});

test('ctx.resting 与 ctx.moving 同时为真时，休息优先', () => {
  // src/needs.js 里那个三元表达式把 resting 放在外层，是一条**刻意的优先级规则**：
  // 一只躺下休息的生物不该因为"刚刚游过来"就按移动速率继续耗能。
  // 但此前没有任何测试同时把两个标志置真，所以这条规则是未被验证的 ——
  // 把三元内外调换（改成 moving 优先）不会让任何测试失败。
  //
  // Task 10 理论上不该构造出这种 ctx，但规则本身值得钉住：
  // 它是"休息能恢复精力"这条玩家可感知的承诺的前提。
  // energy 速率不受任何性状调制，故这里用 PINNED_TRAITS 只为形状一致。
  const HORIZON = 20;   // 与量级钉桩测试同一窗口，便于对照三个分支的字面量

  const both = createNeeds(); both.energy = 0.5;
  decay(both, HORIZON, PINNED_TRAITS, { moving: true, resting: true, companions: 0 });

  const restingOnly = createNeeds(); restingOnly.energy = 0.5;
  decay(restingOnly, HORIZON, PINNED_TRAITS, { moving: false, resting: true, companions: 0 });

  const movingOnly = createNeeds(); movingOnly.energy = 0.5;
  decay(movingOnly, HORIZON, PINNED_TRAITS, { moving: true, resting: false, companions: 0 });

  // 0.5 - 0.017×20 = 0.16。用容差而非 assert.equal：IEEE-754 下它算出
  // 0.15999999999999998，exact 相等会假失败。
  assert.ok(Math.abs(both.energy - 0.16) < 1e-9,
    `两者同真时 energy = ${both.energy}，期望走休息速率得 0.16`);
  // 与"只休息"逐位相同 —— 这才是"优先"的确切含义
  assert.equal(both.energy, restingOnly.energy, 'resting 应当压过 moving，结果须与纯休息一致');
  // 反面对照：若规则被调换，both 会等于这个值（0.5 + 0.0042×20 = 0.584）
  assert.ok(Math.abs(movingOnly.energy - 0.584) < 1e-9,
    `纯移动时 energy = ${movingOnly.energy}，期望 0.584`);
  assert.notEqual(both.energy, movingOnly.energy,
    '若这条失败，说明 resting 已不再优先于 moving');
});

test('mostUrgent 返回最匮乏的一条', () => {
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.9, social: 0.4, safety: 0.1 }), 'energy');
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.1, social: 0.4, safety: 0.95 }), 'safety');
  assert.equal(mostUrgent({ hunger: 0.9, energy: 0.1, social: 0.4, safety: 0.2 }), 'hunger');
});

test('mostUrgent 全零时返回 hunger（稳定的默认值，不给 undefined）', () => {
  assert.equal(mostUrgent({ hunger: 0, energy: 0, social: 0, safety: 0 }), 'hunger');
});
