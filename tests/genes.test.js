import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';
import {
  ALL_GENES, APPEARANCE_GENES, PERSONALITY_GENES, PATTERNS,
  phenotype, phenotypeAll, randomGenome, gamete, combine, inherit,
  patternBucket, decode,
} from '../src/genes.js';

test('基因清单完整且无重复', () => {
  assert.equal(ALL_GENES.length, APPEARANCE_GENES.length + PERSONALITY_GENES.length);
  assert.equal(new Set(ALL_GENES).size, ALL_GENES.length);
  assert.equal(APPEARANCE_GENES.length, 8);
  assert.equal(PERSONALITY_GENES.length, 6);
});

test('randomGenome 为每个基因生成两个 [0,1] 等位基因', () => {
  const g = randomGenome(createRng(1));
  for (const name of ALL_GENES) {
    assert.ok(Array.isArray(g[name]) && g[name].length === 2, `${name} 应为二元数组`);
    for (const a of g[name]) assert.ok(a >= 0 && a <= 1);
  }
});

test('共显性基因的表现型 = 两等位基因均值', () => {
  assert.equal(phenotype('hue', [0.2, 0.8]), 0.5);
  assert.equal(phenotype('size', [0, 1]), 0.5);
});

test('偏显性基因的表现型偏向显性等位基因', () => {
  // pattern 的 dom = 0.7 → 0.9*0.7 + 0.1*0.3 = 0.66
  assert.ok(Math.abs(phenotype('pattern', [0.9, 0.1]) - 0.66) < 1e-9);
  assert.ok(phenotype('pattern', [0.9, 0.1]) > 0.5, '应偏向显性的 0.9');
});

test('glow 的显性度为 0.6', () => {
  assert.ok(Math.abs(phenotype('glow', [1.0, 0.0]) - 0.6) < 1e-9);
});

test('未知基因名抛错（尽早暴露拼写错误）', () => {
  assert.throws(() => phenotype('colour', [0.5, 0.5]), /未知基因/);
});

test('子代表现型均值落在双亲之间（共显性基因，大样本）', () => {
  const rng = createRng(11);
  const A = randomGenome(rng);
  const B = randomGenome(rng);
  A.hue = [0.1, 0.1];
  B.hue = [0.9, 0.9];
  let sum = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) sum += phenotype('hue', inherit(rng, A, B).hue);
  const mean = sum / N;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `子代 hue 均值偏离双亲中点: ${mean}`);
});

test('变异被 clamp 到 [0,1]（极端纯合亲本也不越界）', () => {
  const rng = createRng(12);
  const high = {};
  const low = {};
  for (const g of ALL_GENES) { high[g] = [1, 1]; low[g] = [0, 0]; }
  for (let i = 0; i < 3000; i++) {
    for (const g of ALL_GENES) {
      const hi = gamete(rng, high)[g];
      const lo = gamete(rng, low)[g];
      assert.ok(hi >= 0 && hi <= 1, `${g} 上界越界: ${hi}`);
      assert.ok(lo >= 0 && lo <= 1, `${g} 下界越界: ${lo}`);
    }
  }
});

test('变异确实发生（纯合亲本的子代不再全为纯合）', () => {
  const rng = createRng(13);
  const pure = {};
  for (const g of ALL_GENES) pure[g] = [0.5, 0.5];
  const child = inherit(rng, pure, pure);
  const drifted = ALL_GENES.filter((g) => child[g][0] !== 0.5 || child[g][1] !== 0.5);
  assert.ok(drifted.length > 0, '变异率 0.06 下应有基因发生漂移');
});

test('隐性性状能隔代出现（spec 4.1 的设计承诺）', () => {
  // 构造：深玫红（低 hue 表现型）为隐性。
  // 祖代 P = [深, 浅]，两个 F1 都表现为浅色但都可能携带深色等位基因，
  // F1 × F1 交配应能产出深色 F2。
  const rng = createRng(2024);
  let sawRecessive = false;
  for (let trial = 0; trial < 600 && !sawRecessive; trial++) {
    const P = randomGenome(rng);
    P.hue = [0.02, 0.98];
    const f1a = inherit(rng, P, P);
    const f1b = inherit(rng, P, P);
    // 只保留双亲都是"浅色表现型"（> 0.5）的配对，才构成真正的"隔代"
    if (phenotype('hue', f1a.hue) <= 0.5) continue;
    if (phenotype('hue', f1b.hue) <= 0.5) continue;
    const f2 = inherit(rng, f1a, f1b);
    if (phenotype('hue', f2.hue) < 0.2) sawRecessive = true;
  }
  assert.ok(sawRecessive, '600 次试验内应至少出现一次隔代隐性性状');
});

test('同一种子下 inherit 完全可复现', () => {
  const A = randomGenome(createRng(5));
  const B = randomGenome(createRng(6));
  assert.deepEqual(inherit(createRng(77), A, B), inherit(createRng(77), A, B));
});

test('combine 让双亲各贡献一个等位基因且顺序稳定', () => {
  const ga = {};
  const gb = {};
  for (const g of ALL_GENES) { ga[g] = 0.1; gb[g] = 0.9; }
  const child = combine(ga, gb);
  for (const g of ALL_GENES) assert.deepEqual(child[g], [0.1, 0.9]);
});

test('patternBucket 分五桶且边界正确', () => {
  assert.equal(patternBucket(0), 'none');
  assert.equal(patternBucket(0.19), 'none');
  assert.equal(patternBucket(0.2), 'spots');
  assert.equal(patternBucket(0.39), 'spots');
  assert.equal(patternBucket(0.4), 'rings');
  assert.equal(patternBucket(0.6), 'clouds');
  assert.equal(patternBucket(0.8), 'stars');
  assert.equal(patternBucket(0.99), 'stars');
  assert.equal(patternBucket(1), 'stars', '1.0 不得越界');
  assert.equal(PATTERNS.length, 5);
});

test('decode 的色相永远落在粉色区间 315°–360° ∪ 0°–25°', () => {
  const rng = createRng(31);
  for (let i = 0; i < 5000; i++) {
    const { hue } = decode(randomGenome(rng));
    assert.ok(hue >= 315 || hue <= 25, `色相跑出粉色区间: ${hue}`);
  }
});

test('decode 的色相解码式为 (315 + p*70) mod 360', () => {
  const g = randomGenome(createRng(2));
  g.hue = [0, 0];
  assert.ok(Math.abs(decode(g).hue - 315) < 1e-9);
  g.hue = [1, 1];
  assert.ok(Math.abs(decode(g).hue - 25) < 1e-9);      // (315+70) mod 360
  g.hue = [0.5, 0.5];
  assert.ok(Math.abs(decode(g).hue - 350) < 1e-9);     // 315+35
});

test('基因空间插值不会绕过色环远路（spec 4.1 的关键理由）', () => {
  // 315°（区间起点）× 25°（区间终点）的子代必须仍在粉色区间内，
  // 而不是绕到 170° 那种绿色。
  const rng = createRng(33);
  const A = randomGenome(rng);
  const B = randomGenome(rng);
  A.hue = [0.0, 0.0];
  B.hue = [1.0, 1.0];
  for (let i = 0; i < 300; i++) {
    const { hue } = decode(inherit(rng, A, B));
    assert.ok(hue >= 315 || hue <= 25, `子代色相跑出粉色区间: ${hue}`);
  }
});

test('decode 的 size 落在 [minSize, maxSize]', () => {
  const rng = createRng(41);
  for (let i = 0; i < 500; i++) {
    const { size } = decode(randomGenome(rng));
    assert.ok(size >= 14 && size <= 38, `size 越界: ${size}`);
  }
});

test('decode 的 sat / lum / glow 落在设计区间', () => {
  const rng = createRng(43);
  for (let i = 0; i < 500; i++) {
    const t = decode(randomGenome(rng));
    assert.ok(t.sat >= 0.45 && t.sat <= 0.95, `sat: ${t.sat}`);
    assert.ok(t.lum >= 0.62 && t.lum <= 0.84, `lum: ${t.lum}`);
    assert.ok(t.glow >= 0.35 && t.glow <= 1, `glow: ${t.glow}`);
  }
});

test('decode 输出全部六个性格基因且均在 [0,1]', () => {
  const { personality } = decode(randomGenome(createRng(9)));
  assert.deepEqual(Object.keys(personality).sort(), [...PERSONALITY_GENES].sort());
  for (const v of Object.values(personality)) assert.ok(v >= 0 && v <= 1);
});

test('decode 的 pattern 一定是 PATTERNS 之一', () => {
  const rng = createRng(47);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const { pattern } = decode(randomGenome(rng));
    assert.ok(PATTERNS.includes(pattern), `非法花纹: ${pattern}`);
    seen.add(pattern);
  }
  assert.equal(seen.size, PATTERNS.length, '五种花纹都应能出现');
});

test('phenotypeAll 覆盖全部基因', () => {
  const p = phenotypeAll(randomGenome(createRng(10)));
  assert.deepEqual(Object.keys(p).sort(), [...ALL_GENES].sort());
});
