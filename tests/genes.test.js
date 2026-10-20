import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';
import { CONFIG } from '../src/config.js';
import {
  ALL_GENES, APPEARANCE_GENES, PERSONALITY_GENES, PATTERNS,
  phenotype, phenotypeAll, randomGenome, gamete, combine, inherit,
  patternBucket, eggTintBucket, decode,
} from '../src/genes.js';

test('基因清单完整且无重复', () => {
  assert.equal(ALL_GENES.length, APPEARANCE_GENES.length + PERSONALITY_GENES.length);
  assert.equal(new Set(ALL_GENES).size, ALL_GENES.length);
  // 2026-10-20 孤雌与毛绒改造：外观 8 → 10（加 fluff、eggTint），
  // 性格 6 → 9（libido 改名 broody，再加 activity、talk、intellect）。
  assert.equal(APPEARANCE_GENES.length, 10);
  assert.equal(PERSONALITY_GENES.length, 9);
  assert.equal(ALL_GENES.length, 19);
});

test('四个导出基因数组都被冻结（就地修改必须抛错，不得静默成功）', () => {
  // 这些数组会被 creature / breeding / sim 导入共享。冻结前实测：
  //   PATTERNS.reverse()          静默成功 → 变成 stars,clouds,rings,spots,none
  //   ALL_GENES.push('affection') 静默成功 → 长度 19 变 20
  // 两者都不报错，而后果是全局的：patternBucket(v) 按索引 0..4 映射花纹名，
  // 重排 PATTERNS 会让所有生物的花纹错位；给 ALL_GENES 加一个不存在的基因名
  // 会让 randomGenome / inherit 遍历到它并产出 undefined 等位基因。
  // 症状是"整缸生物突然变样"，没有任何一处抛错 —— 正是最难追溯的那类 bug。
  //
  // 这条测试的存在理由：冻结是**易失的**属性。有人为了在别处 sort 一下而摘掉
  // Object.freeze，不会让任何一条既有测试变红。所以冻结本身必须被钉住。
  for (const [name, arr] of [
    ['APPEARANCE_GENES', APPEARANCE_GENES],
    ['PERSONALITY_GENES', PERSONALITY_GENES],
    ['ALL_GENES', ALL_GENES],
    ['PATTERNS', PATTERNS],
  ]) {
    assert.ok(Object.isFrozen(arr), `${name} 应被冻结`);
    assert.throws(() => arr.push('__probe__'), TypeError, `${name}.push 应抛 TypeError`);
    assert.throws(() => arr.reverse(), TypeError, `${name}.reverse 应抛 TypeError`);
    assert.throws(() => { arr[0] = '__probe__'; }, TypeError, `${name}[0] 赋值应抛 TypeError`);
    // 反向确认：冻结只挡写，不挡读与展开（否则 randomGenome / decode 会跟着坏）
    assert.equal(typeof [...arr].sort().join(','), 'string', `${name} 仍应可展开`);
  }

  // PATTERNS 的顺序是承重的：patternBucket(v) 按 v 落在哪个五等分区间取 PATTERNS[i]，
  // 所以索引 0..4 直接决定花纹名。单独钉住顺序本身 ——
  // 区间边界的穷举已由下面 'patternBucket 分五桶且边界正确' 那条负责，此处不重复。
  assert.deepEqual([...PATTERNS], ['none', 'spots', 'rings', 'clouds', 'stars']);
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

test('同一对双亲的 40 个后代互不相同，且共显性位点有非零表现型方差', () => {
  // spec 要求一窝的每枚蛋各自独立地"分离 + 重组 + 变异"（"所以每枚都不同"）。
  // 现有测试里没有一条能发现"inherit 每次都返回同一个孩子"这类回归 ——
  // 例如配子只算一次然后被复用、或变异被漏掉。这里把它钉住。
  //
  // 用固定种子 ⇒ 本测试完全确定，不可能偶发失败：这 40 个基因型要么全不相同，
  // 要么不是，由种子唯一决定（实测 seed 202 下 40 个全不相同）。
  // 要撞上重复，需要 14 个位点全部选中同一个亲本等位基因并得到完全相同的高斯扰动。
  const rng = createRng(202);
  const mother = randomGenome(rng);
  const father = randomGenome(rng);
  const genotypes = new Set();
  let minHue = Infinity;
  let maxHue = -Infinity;
  for (let i = 0; i < 40; i++) {
    // 单个持续推进的 rng：模拟真实的产卵循环，而不是每枚蛋重开一个流。
    const child = inherit(rng, mother, father);
    genotypes.add(JSON.stringify(child));
    const h = phenotype('hue', child.hue);
    if (h < minHue) minHue = h;
    if (h > maxHue) maxHue = h;
  }
  assert.equal(genotypes.size, 40, `40 个后代的基因型应全部不同，实际只有 ${genotypes.size} 种`);
  // hue 是共显性位点（dom = 0.5），纯分离 + 变异就应当产生非零方差。
  // 只断言"大于 0"而非某个具体区间 —— 这里要抓的是"完全没变化"，不是分布形状。
  const spread = maxHue - minHue;
  assert.ok(spread > 0, `hue 表现型极差应大于 0，实际 ${spread}（min=${minHue}, max=${maxHue}）`);
});

test('combine 让双亲各贡献一个等位基因且顺序稳定', () => {
  const ga = {};
  const gb = {};
  for (const g of ALL_GENES) { ga[g] = 0.1; gb[g] = 0.9; }
  const child = combine(ga, gb);
  for (const g of ALL_GENES) assert.deepEqual(child[g], [0.1, 0.9]);
});

test('槽位约定：slot 0 = 母方、slot 1 = 父方，对 dom ≠ 0.5 的位点改变可见性状', () => {
  // 上一条测试钉住了 combine 的顺序本身；这一条钉住它的后果 —— 这才是承重的部分。
  // Task 8 的 layEggs(mother, father, …) 调用 inherit(rng, mother.genes, father.genes)，
  // 所以 slot 0 是母方、slot 1 是父方，dom > 0.5 意味着性状偏向母方。
  // 如果哪天有人悄悄调换了实参顺序（或把 phenotype 换成顺序无关的取值方式），
  // 缸里每只宠物的 pattern 与 glow 都会变，而这条测试会立刻失败。
  // 构造沿用上面的 combine 测试：两个合成配子，每个位点分别取 0.1 / 0.9。
  const ga = {};
  const gb = {};
  for (const g of ALL_GENES) { ga[g] = 0.1; gb[g] = 0.9; }
  const maternalFirst = combine(ga, gb);   // 母方 0.1 落在 slot 0
  const paternalFirst = combine(gb, ga);   // 父方 0.9 落在 slot 0

  // pattern（dom = 0.7）：同样的遗传物质，换个顺序，花纹桶就换了。
  //   母在前：0.1*0.7 + 0.9*0.3 = 0.34 → 'spots'
  //   父在前：0.9*0.7 + 0.1*0.3 = 0.66 → 'clouds'
  // 这是本条测试的核心断言：基因完全相同，只是双亲顺序相反，动物看起来就不一样。
  const pMaternal = phenotype('pattern', maternalFirst.pattern);
  const pPaternal = phenotype('pattern', paternalFirst.pattern);
  assert.ok(Math.abs(pMaternal - 0.34) < 1e-9, `pattern（母在前）应为 0.34，实际 ${pMaternal}`);
  assert.ok(Math.abs(pPaternal - 0.66) < 1e-9, `pattern（父在前）应为 0.66，实际 ${pPaternal}`);
  assert.equal(patternBucket(pMaternal), 'spots');
  assert.equal(patternBucket(pPaternal), 'clouds');
  // 同一个结论走到 decode 这一层（真正决定画面上长什么样的地方）也成立。
  assert.equal(decode(maternalFirst).pattern, 'spots');
  assert.equal(decode(paternalFirst).pattern, 'clouds');

  // glow（dom = 0.6）：两个顺序给出不同值，且偏向母方的顺序给出较低的那个
  // （因为 slot 0 携带的是 0.1）：0.1*0.6 + 0.9*0.4 = 0.42 vs 0.9*0.6 + 0.1*0.4 = 0.58。
  const gMaternal = phenotype('glow', maternalFirst.glow);
  const gPaternal = phenotype('glow', paternalFirst.glow);
  assert.ok(Math.abs(gMaternal - 0.42) < 1e-9, `glow（母在前）应为 0.42，实际 ${gMaternal}`);
  assert.ok(Math.abs(gPaternal - 0.58) < 1e-9, `glow（父在前）应为 0.58，实际 ${gPaternal}`);
  assert.notEqual(gMaternal, gPaternal, 'dom = 0.6 的位点必须与双亲顺序有关');
  assert.ok(gMaternal < gPaternal, 'slot 0 携带 0.1，偏母方的顺序应给出较低的 glow');
  assert.notEqual(decode(maternalFirst).glow, decode(paternalFirst).glow);

  // hue（dom = 0.5）：共显性保证 —— 两个顺序必须给出同一个值 0.5。
  // 这一条的分量与它的长度不成正比：色相是全项目最显眼的性状，
  // 它必须是双亲的公平混合，绝不能因为"谁被写在前面"而偏移。
  assert.equal(phenotype('hue', maternalFirst.hue), 0.5);
  assert.equal(phenotype('hue', paternalFirst.hue), 0.5);
  assert.equal(
    phenotype('hue', maternalFirst.hue),
    phenotype('hue', paternalFirst.hue),
    '共显性位点必须与双亲顺序无关',
  );
  assert.equal(decode(maternalFirst).hue, decode(paternalFirst).hue);
});

test('inherit 把 genesA 的等位基因放进 slot 0（母方）', () => {
  // 上一条钉住了 combine 的槽位约定；这一条把同一契约钉在 inherit 的实参顺序上 ——
  // Task 8 调用的是 inherit(rng, mother.genes, father.genes)，若有人把 inherit 的实现
  // 改写成 combine(gamete(rng, genesB), gamete(rng, genesA))，母/父映射即被反转，
  // 而此前没有任何测试能发现：现有 inherit 测试要么双亲对称（pure × pure），
  // 要么只观察 dom = 0.5 的 hue（对顺序天然失明）。
  //
  // 为什么本测试不可能偶发失败：双亲都是纯合的 ⇒ 分离不是干扰项，
  // slot 0 的等位基因只可能来自母方的 0.1，slot 1 只可能来自父方的 0.9；
  // 变异是零均值高斯、σ = CONFIG.mutationRate = 0.06，要把 0.1 推过 0.5
  // 需要约 6.7 个标准差；且使用固定种子，结果由种子唯一决定，完全确定。
  const rng = createRng(14);
  const mother = {};
  const father = {};
  for (const g of ALL_GENES) { mother[g] = [0.1, 0.1]; father[g] = [0.9, 0.9]; }
  const child = inherit(rng, mother, father);   // 纯合亲本 ⇒ 每个 slot 只可能来自对应亲本
  assert.ok(child.pattern[0] < 0.5, `slot 0 应来自母方 0.1，实际 ${child.pattern[0]}`);
  assert.ok(child.pattern[1] > 0.5, `slot 1 应来自父方 0.9，实际 ${child.pattern[1]}`);
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

// ---------------- 2026-10-20 新增位点（fluff / eggTint）与孤雌遗传 ----------------

test('fluff 解码是透传：单位换算留给表现层', () => {
  const genes = { ...randomGenome(createRng(77)), fluff: [0.3, 0.7] };
  const d = decode(genes);
  // dom = 0.5 ⇒ 表现型就是两等位的均值；透传意味着 decode 不做任何区间映射
  assert.ok(Math.abs(d.fluff - 0.5) < 1e-12, `透传失败，得到 ${d.fluff}`);
  assert.equal(decode({ ...genes, fluff: [0, 0] }).fluff, 0);
  assert.equal(decode({ ...genes, fluff: [1, 1] }).fluff, 1);
});

test('eggTint 按累积边界分段，边界两侧取到相邻两色', () => {
  // 0.145 是第 1、2 色的分界；0.975 是白与黑（黑蛋稀有度）的分界。
  // 这两个点必须**各测两侧**，否则把边界挪 0.01 不会有任何症状，
  // 而黑蛋稀有度恰好就是这条边界给的（spec §11）。
  assert.equal(eggTintBucket(0.10), 'macaron-pink');
  assert.equal(eggTintBucket(0.15), 'macaron-blue');
  assert.equal(eggTintBucket(0.97), 'white');
  assert.equal(eggTintBucket(0.975), 'black');
  assert.equal(eggTintBucket(0.98), 'black');
});

test('eggTint 在 x 恰好为 1 时仍返回最后一色（循环走完的兜底路径）', () => {
  // 末项边界是 1.0，而 `x < edges[i]` 在 x === 1.0 时全不成立。
  // 少了兜底那行，表型恰为 1 的个体拿到 undefined，症状是"存档里偶尔出现 null 蛋色"。
  assert.equal(eggTintBucket(1), 'black');
  assert.equal(eggTintBucket(2), 'black');   // clamp01 之后同样是 1
});

test('CONFIG.eggTint 的 edges 严格递增、末项恰为 1.0、与 colors 等长', () => {
  const { colors, edges } = CONFIG.eggTint;
  assert.equal(colors.length, edges.length, '长度不等会让 eggTintBucket 抛错');
  for (let i = 0; i < edges.length; i += 1) {
    if (i > 0) assert.ok(edges[i] > edges[i - 1], `edges 第 ${i} 项未递增`);
  }
  assert.equal(edges[edges.length - 1], 1.0, '末项必须是 1.0，否则有表型取不到色');
  assert.equal(new Set(colors).size, colors.length, '色名不得重复');
});

test('DOMINANCE 覆盖全部 19 个位点（漏一个就会在 phenotype 抛"未知基因"）', () => {
  // 新增位点时最容易漏的就是这张表：漏了不会在 import 时报错，
  // 只会在第一次 decode 时抛 —— 而那时已经是在跑模拟了。
  const g = randomGenome(createRng(5));
  for (const name of ALL_GENES) {
    const v = phenotype(name, g[name]);
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${name} 解码越界: ${v}`);
  }
});

test('inherit 覆盖全部 19 个位点，每个都是 [0,1] 二元数组', () => {
  const mother = randomGenome(createRng(11));
  // 孤雌：两个实参是同一个对象。这里仍按双实参调用，因为 inherit 本身没改。
  const child = inherit(createRng(12), mother, mother);
  assert.deepEqual(Object.keys(child).sort(), [...ALL_GENES].sort());
  for (const name of ALL_GENES) {
    assert.equal(child[name].length, 2, `${name} 应为二元等位`);
    for (const a of child[name]) {
      assert.ok(Number.isFinite(a) && a >= 0 && a <= 1, `${name} 等位越界: ${a}`);
    }
  }
});

test('六个新位点的 dom 都是 0.5：交换等位顺序必须得到同一结果', () => {
  // 变异探针实测：把 DOMINANCE 里 eggTint 从 0.5 改成 0.9、或把 intellect 改成 0.9，
  // 其余 396 条**全部照样绿** —— 因为 fluff 那条只钉了 [0.3,0.7] 一个方向的取值，
  // 而 eggTint/intellect 根本没有从 decode 侧走过 phenotype。
  // 这就是这条测试存在的理由：dom 写错不会抛错、不会越界，只会让"这个性状像第一配子"，
  // 而 spec §4.1 明写新位点一律共显性（性格是公平混合，不偏向任何一方）。
  const base = randomGenome(createRng(31));
  for (const name of ['fluff', 'eggTint', 'activity', 'talk', 'intellect', 'broody']) {
    const [a, b] = base[name];
    if (a === b) continue;                       // 相同等位时交换无意义，跳过
    const forward = phenotype(name, [a, b]);
    const swapped = phenotype(name, [b, a]);
    assert.ok(Math.abs(forward - swapped) < 1e-12,
      `${name} 的 dom 不是 0.5：交换等位得到 ${forward} vs ${swapped}`);
  }
});
