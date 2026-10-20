import { CONFIG } from './config.js';

// 四个导出数组全部冻结，与 src/config.js 深冻结共享常量、src/emotions.js 冻结
// EMOTION_KEYS / EVENT_KINDS 是同一条纪律：这些数组会被 creature / breeding / sim
// 导入，一次意外的就地 .sort() / .push() / .reverse() 会静默改变基因集合或
// pattern 的分桶顺序，且全程不报错 —— 症状是"所有生物的花纹突然变了"，极难追溯。
// 实测：冻结前 PATTERNS.reverse() 静默成功（变成 stars,clouds,rings,spots,none），
// ALL_GENES.push('affection') 让长度从 19 变成 20；冻结后两者都抛 TypeError。
//
// 冻结不影响读取与展开：ALL_GENES 用 [...] 生成新数组，randomGenome / decode /
// patternBucket 只遍历不修改，故冻结是纯粹的防呆，无行为变化。
export const APPEARANCE_GENES = Object.freeze([
  'hue', 'sat', 'lum', 'size', 'glow', 'pattern', 'patternDensity', 'wobble',
  'fluff', 'eggTint',
]);
export const PERSONALITY_GENES = Object.freeze([
  'bold', 'clingy', 'irritable', 'gluttonous', 'curious',
  'activity', 'talk', 'intellect', 'broody',
]);
export const ALL_GENES = Object.freeze([...APPEARANCE_GENES, ...PERSONALITY_GENES]);

// PATTERNS 的**顺序是承重的**：patternBucket(v) 按 v 落在哪个五等分区间来选花纹，
// 索引 0..4 直接映射到这五个名字。就地重排它不会报错，只会让所有生物的花纹错位。
export const PATTERNS = Object.freeze(['none', 'spots', 'rings', 'clouds', 'stars']);

// 显性度：0.5 = 共显性（表现型为两等位基因均值），>0.5 = 第一个等位基因偏显性。
// "显性"在这里是位点属性而非等位基因属性 —— 这是为了让 pattern 这类离散性状
// 能稳定地"像某一方"，而不是永远卡在两桶之间。
//
// 槽位约定（承重契约，由 tests/genes.test.js 钉住，不要"改成顺序无关"）：
// slot 0 是第一配子、slot 1 是第二配子。2026-10-20 改孤雌之后，两个配子都由母方提供
// （breeding.layEggs(rng, mother) → inherit(rng, mother.genes, mother.genes)），
// 所以"母方/父方"这套说法已经没有对象了 —— 但 slot 0 的排序契约必须原样保留：
// dom > 0.5 的位点（pattern 0.7、glow 0.6）仍然会因为两个配子互换而改变取值，
// 而这份随机性正是"同一位母亲的一窝蛋彼此就不一样"的来源。
// 对 dom = 0.5 的位点（含最显眼的 hue）仍然严格与顺序无关。
// 公式本身来自 spec 第 145 行（phenotype = a × dom + b × (1 − dom)），逐字实现。
const DOMINANCE = {
  hue: 0.5, sat: 0.5, lum: 0.5, size: 0.5,
  glow: 0.6, pattern: 0.7, patternDensity: 0.5, wobble: 0.5,
  fluff: 0.5, eggTint: 0.5,
  bold: 0.5, clingy: 0.5, irritable: 0.5,
  gluttonous: 0.5, curious: 0.5,
  activity: 0.5, talk: 0.5, intellect: 0.5, broody: 0.5,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function phenotype(gene, alleles) {
  const dom = DOMINANCE[gene];
  if (dom === undefined) throw new Error(`未知基因: ${gene}`);
  return clamp01(alleles[0] * dom + alleles[1] * (1 - dom));
}

export function phenotypeAll(genes) {
  const out = {};
  for (const g of ALL_GENES) out[g] = phenotype(g, genes[g]);
  return out;
}

export function randomGenome(rng) {
  const genes = {};
  for (const g of ALL_GENES) genes[g] = [rng.next(), rng.next()];
  return genes;
}

// 配子形成：每个位点随机分离一个等位基因，再叠加高斯变异。
// 变异必须 clamp —— 否则多代累积后会出现越界值污染 decode，
// 表现为"某一代之后所有孩子都变成同一个极端颜色"。
export function gamete(rng, genes) {
  const g = {};
  for (const name of ALL_GENES) {
    const [a, b] = genes[name];
    const picked = rng.chance(0.5) ? a : b;
    g[name] = clamp01(picked + rng.gaussian() * CONFIG.mutationRate);
  }
  return g;
}

export function combine(gameteA, gameteB) {
  const genes = {};
  for (const name of ALL_GENES) genes[name] = [gameteA[name], gameteB[name]];
  return genes;
}

// 实参顺序有意义：genesA 的等位基因落在 slot 0（第一配子），genesB 落在 slot 1。
// 对 dom !== 0.5 的位点（glow 0.6、pattern 0.7）交换两个实参会得到不同的表现型，
// 对 dom = 0.5 的位点则完全等价。
// 2026-10-20 孤雌：调用方（breeding.layEggs）现在传 (mother.genes, mother.genes)。
// **本函数一行未改** —— 这是刻意的：自体合并只是把第二个实参换成同一个对象，
// 分离与变异的机制完全复用，改签名反而会把 slot 契约弄丢。
// 每次调用都重新形成两份配子 —— 同一位母亲的每枚蛋因此各自独立，互不相同。
export function inherit(rng, genesA, genesB) {
  return combine(gamete(rng, genesA), gamete(rng, genesB));
}

export function patternBucket(v) {
  const i = Math.min(PATTERNS.length - 1, Math.floor(clamp01(v) * PATTERNS.length));
  return PATTERNS[i];
}

// eggTint 用**累积边界**分段（CONFIG.eggTint.edges），不是"宽度数组"。
// 理由见 spec §11：宽度数组要额外断言"和恰好为 1"，而浮点求和会漂
// （本 spec 早先写过一版 [0.13×6, 0.12, 0.025]，实际和是 0.925）。
// 累积边界只需断言"严格递增且末项 === 1.0"，一条加法误差都不会有。
// 末项是 1.0 而 x 可以取到 1.0，所以循环走完要兜底返回最后一色 ——
// 否则 x === 1.0 的个体会拿到 undefined，症状是"存档里偶尔出现 null 蛋色"。
export function eggTintBucket(v) {
  const { colors, edges } = CONFIG.eggTint;
  if (colors.length !== edges.length) {
    throw new Error(`eggTint colors(${colors.length}) 与 edges(${edges.length}) 长度不等`);
  }
  const x = clamp01(v);
  for (let i = 0; i < edges.length; i += 1) if (x < edges[i]) return colors[i];
  return colors[colors.length - 1];
}

// 表现型 → 实际性状。这是唯一知道"单位"的地方，
// 其他所有模块只处理 [0,1] 的无量纲基因值。
// hue 的解码式来自 spec 4.1：(315 + p*70) mod 360，
// 其中 70 = 从 315° 跨 0° 到 25° 的弧长。
export function decode(genes) {
  const p = phenotypeAll(genes);
  const [hueStart, hueEnd] = CONFIG.hueRange;
  const span = (hueEnd - hueStart + 360) % 360;      // 315→25 = 70
  return {
    hue: (hueStart + p.hue * span) % 360,
    sat: 0.45 + p.sat * 0.5,                          // 45%–95%
    lum: 0.62 + p.lum * 0.22,                         // 62%–84%
    size: CONFIG.minSize + p.size * (CONFIG.maxSize - CONFIG.minSize),
    glow: 0.35 + p.glow * 0.65,
    pattern: patternBucket(p.pattern),
    patternDensity: p.patternDensity,
    wobble: p.wobble,
    fluff: p.fluff,                        // 透传，单位换算属表现层（spec §4.1）
    eggTint: eggTintBucket(p.eggTint),     // 唯一不解码成身体性状的位点：它决定蛋色
    personality: {
      bold: p.bold,
      clingy: p.clingy,
      irritable: p.irritable,
      gluttonous: p.gluttonous,
      curious: p.curious,
      activity: p.activity,
      talk: p.talk,
      intellect: p.intellect,
      broody: p.broody,
    },
  };
}
