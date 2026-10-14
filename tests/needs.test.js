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

test('约 120 秒饥饿升到可观水平但不越界', () => {
  const n = createNeeds();
  n.hunger = 0;
  const t = neutralTraits();
  for (let i = 0; i < 120 * 60; i++) decay(n, 1 / 60, t, IDLE);
  assert.ok(n.hunger > 0.4 && n.hunger <= 1, `120s 后饥饿 = ${n.hunger}`);
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

test('mostUrgent 返回最匮乏的一条', () => {
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.9, social: 0.4, safety: 0.1 }), 'energy');
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.1, social: 0.4, safety: 0.95 }), 'safety');
  assert.equal(mostUrgent({ hunger: 0.9, energy: 0.1, social: 0.4, safety: 0.2 }), 'hunger');
});

test('mostUrgent 全零时返回 hunger（稳定的默认值，不给 undefined）', () => {
  assert.equal(mostUrgent({ hunger: 0, energy: 0, social: 0, safety: 0 }), 'hunger');
});
