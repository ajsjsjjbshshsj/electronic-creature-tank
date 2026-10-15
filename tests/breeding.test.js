import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { createCreature, growthFactor, sizeOf } from '../src/creature.js';
import { ensure, adjust, remember, get, KINSHIP } from '../src/memory.js';
import { inherit, phenotype, ALL_GENES } from '../src/genes.js';
import {
  courtshipScore, canCourt, startCourtship, tickCourtship, interruptCourtship,
  layEggs, tickEgg, hatch, kinshipOf, registerKinship,
} from '../src/breeding.js';

let uid = 0;
const rng = () => createRng(1000 + (uid++));

// 一对可繁殖的成体，彼此有好感，距离很近
const pair = (over = {}) => {
  const r = rng();
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: r });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: r });
  a.emotions.arousal = 0.8;
  b.emotions.arousal = 0.8;
  a.needs.hunger = 0.1; b.needs.hunger = 0.1;
  a.needs.energy = 0.1; b.needs.energy = 0.1;
  adjust(a.memory, 'b', 0.6, 0.5);
  adjust(b.memory, 'a', 0.6, 0.5);
  return { a, b, ...(over || {}) };
};

const OK = { population: 8, populationCap: 24, distance: 0.05 };

// ---------- canCourt：近亲回避与前置条件 ----------
//
// ⚠️ **本组测试不能用 `ensure` 设定亲缘**（2026-10-14 预飞审查发现的原计划缺陷）。
// `pair()` 已经用 `adjust(a.memory, 'b', 0.6, 0.5)` 建立过条目，而 `adjust` 内部走
// `ensure`；`ensure` 是**幂等**的 —— 条目已存在就直接返回，**不会**用 `opts` 覆盖
// `kinship`/`role`（这是刻意的："它是它妈妈"这类关系一旦确立就不该被改）。
// 于是 `ensure(a.memory,'b',{kinship:0.5})` 是个**空操作**，kinship 停在 0，
// `canCourt` 的亲缘闸门根本不会被执行 —— 把整段近亲回避删掉测试也照样绿。
// 这类"测试比标题弱"的缺陷正是本项目反复抓到的静默失败。
//
// 必须用 `remember()`：它是存档恢复路径，会**原地覆写**那五个字段，并且会校验入参。
// 每个用例都加一条"前置条件"断言，专门锁死"亲缘真的写进去了" ——
// 若哪天有人把这里改回 ensure，前置条件会立刻变红，而不是静默退化。
const seedKin = (m, otherId, kinship, role) => remember(m, {
  id: otherId, familiarity: 0.5, affection: 0.6, kinship, role,
});

test('两只健康的、有好感的成体可以求偶', () => {
  const { a, b } = pair();
  assert.equal(canCourt(a, b, OK), true);
  // 基线：pair() 的亲缘确实是 0，所以上面那条不是靠"闸门没生效"通过的
  assert.equal(get(a.memory, 'b').kinship, 0, 'pair() 默认无亲缘');
});

test('kinship > 0.25 绝不求偶（spec 4.12 第 5 条）', () => {
  const { a, b } = pair();
  seedKin(a.memory, 'b', 0.5, 'sibling');
  seedKin(b.memory, 'a', 0.5, 'sibling');
  assert.equal(get(a.memory, 'b').kinship, 0.5, '前置条件：亲缘必须真的写进去了');
  assert.equal(canCourt(a, b, OK), false, '同胞不得求偶');
});

test('kinship 超过 0.25 时被拒绝（祖孙一档已属近亲）', () => {
  const { a, b } = pair();
  seedKin(a.memory, 'b', 0.26, null);
  seedKin(b.memory, 'a', 0.26, null);
  assert.equal(get(a.memory, 'b').kinship, 0.26, '前置条件：亲缘必须真的写进去了');
  assert.equal(canCourt(a, b, OK), false);
});

test('kinship 恰好等于 0.25 时允许（拒绝条件是严格大于，见 CONFIG.kinshipMateMax）', () => {
  const { a, b } = pair();
  seedKin(a.memory, 'b', 0.25, null);
  seedKin(b.memory, 'a', 0.25, null);
  assert.equal(get(a.memory, 'b').kinship, 0.25, '前置条件：亲缘必须真的写进去了');
  assert.equal(canCourt(a, b, OK), true, '恰好 0.25（半同胞/祖孙）属于允许的边缘');
});

test('近亲回避是双向检查（只要一方记得亲缘就拒绝）', () => {
  const { a, b } = pair();
  seedKin(a.memory, 'b', 0.5, null);   // 只有 a 记得
  assert.equal(get(a.memory, 'b').kinship, 0.5, '前置条件：a 记得 0.5');
  assert.equal(get(b.memory, 'a').kinship, 0, '前置条件：b 记的是 0');
  assert.equal(canCourt(a, b, OK), false, '单向记得也必须拒绝');
});

// ---------- 谱系 → 亲缘系数（交接要求第 5 条）----------
//
// 上面那组验证的是"canCourt 会读 kinship 闸门"，用的是手写数值。
// 这组验证的是闸门**在真实谱系数据上**会被触发 —— 两者缺一不可：
// 只测前者会漏掉"没有任何代码把 kinship 写进记忆"这个致命缺口（原计划正是如此）。

test('kinshipOf 从谱系正确识别亲子 / 同胞 / 半同胞 / 祖孙 / 无血缘', () => {
  // 手工搭一个最小谱系：
  //   祖母 G ── X        M（母亲）── F（父亲）  ⇒ C1、C2（全同胞）
  //                      M ── F2              ⇒ H（同母异父，半同胞）
  const mk = (id, mother = null, father = null) => ({
    id, lineage: { mother, father, mates: [], offspring: [] },
  });
  const G = mk('G');
  const M = mk('M', 'G', 'X');
  const F = mk('F');
  const F2 = mk('F2');
  const C1 = mk('C1', 'M', 'F');
  const C2 = mk('C2', 'M', 'F');
  const H = mk('H', 'M', 'F2');
  const world = { G, M, F, F2, C1, C2, H };
  const byId = (id) => world[id] || null;

  assert.equal(kinshipOf(M, C1, byId), KINSHIP.offspring, '母女应为 0.5');
  assert.equal(kinshipOf(C1, M, byId), KINSHIP.offspring, '亲子系数应左右对称');
  assert.equal(kinshipOf(C1, C2, byId), KINSHIP.sibling, '同父母的全同胞 0.5');
  assert.equal(kinshipOf(C1, H, byId), KINSHIP.halfSibling, '同母异父的半同胞 0.25');
  assert.equal(kinshipOf(G, C1, byId), KINSHIP.grandparent, '祖孙 0.25');
  assert.equal(kinshipOf(C1, G, byId), KINSHIP.grandparent, '祖孙反向也是 0.25');
  assert.equal(kinshipOf(C1, F2, byId), 0, '没有共同亲本应为 0');
  assert.equal(kinshipOf(M, F, byId), 0, '配偶不是近亲（spec 4.8：mate 系数为 0）');
  assert.equal(kinshipOf(C1, C1, byId), 0, '自己与自己不是亲缘');
  assert.equal(kinshipOf(C1, F2), 0, '不传 byId 时只认两代内的关系，不应抛错');
});

test('registerKinship 把亲缘写进双方记忆，角色按各自视角填', () => {
  const r = rng();
  const father = createCreature({ id: 'F', name: 'F', age: 700, rng: r });
  const mother = createCreature({ id: 'M', name: 'M', age: 700, rng: r });
  const baby = createCreature({ id: 'B', name: 'B', age: 0, stage: 'hatchling', rng: r, mother: 'M', father: 'F' });
  const byId = (id) => ({ F: father, M: mother, B: baby }[id] || null);

  registerKinship(baby, [father, mother], byId);

  assert.equal(get(baby.memory, 'M').kinship, KINSHIP.mother, '雏体应记得母亲');
  assert.equal(get(baby.memory, 'M').role, 'mother');
  assert.equal(get(baby.memory, 'F').role, 'father');
  assert.equal(get(mother.memory, 'B').kinship, KINSHIP.mother, '母亲侧系数相同');
  assert.equal(get(mother.memory, 'B').role, 'offspring', '母亲侧角色是 offspring，不是 mother');
  assert.equal(get(father.memory, 'B').role, 'offspring');
});

test('近亲回避在真实谱系数据上生效（端到端，含对照组）', () => {
  // 这是交接要求第 5 条的端到端验收：两只**只通过 lineage 相连**的同胞，
  // 在没有任何手写 kinship 的情况下必须无法求偶。
  // 对照组（无血缘的同龄成体可以求偶）用来排除"false 是因为别的原因"。
  const r = rng();
  const father = createCreature({ id: 'F', name: 'F', age: 700, rng: r });
  const mother = createCreature({ id: 'M', name: 'M', age: 700, rng: r });
  const s1 = createCreature({ id: 'S1', name: 'S1', age: 600, rng: r, mother: 'M', father: 'F' });
  const s2 = createCreature({ id: 'S2', name: 'S2', age: 600, rng: r, mother: 'M', father: 'F' });
  const outsider = createCreature({ id: 'O', name: 'O', age: 600, rng: r });
  const byId = (id) => ({ F: father, M: mother, S1: s1, S2: s2, O: outsider }[id] || null);

  registerKinship(s1, [father, mother, s2], byId);
  registerKinship(s2, [father, mother, s1], byId);

  // 前置条件：亲缘必须真的进了记忆，否则下面的 false 可能来自别处
  assert.equal(get(s1.memory, 'S2').kinship, KINSHIP.sibling, '前置条件：s1 记得 s2 是同胞');
  assert.equal(kinshipOf(s1, s2, byId), KINSHIP.sibling, '前置条件：谱系推导也说是同胞');

  // 双方都满足硬性条件（成体、有意愿、不饿、不害怕、距离近）
  const ready = (c) => {
    c.emotions.arousal = 0.9; c.emotions.fear = 0;
    c.needs.hunger = 0.1; c.needs.energy = 0.1;
  };
  ready(s1); ready(s2); ready(outsider);

  assert.equal(canCourt(s1, s2, OK), false, '同胞绝不能求偶（仅凭谱系，无手写 kinship）');
  assert.equal(courtshipScore(s1, s2, OK), 0, '同胞的求偶评分必须归零');

  // 对照组：无血缘的同龄成体可以求偶 —— 证明上面不是"谁都求不了偶"
  adjust(s1.memory, 'O', 0.6, 0.5);
  adjust(outsider.memory, 'S1', 0.6, 0.5);
  assert.equal(kinshipOf(s1, outsider, byId), 0, '对照组无血缘');
  assert.equal(canCourt(s1, outsider, OK), true, '无血缘的成体应当可以求偶（对照组）');
});

test('半同胞（0.25）可以求偶，全同胞（0.5）不行 —— 阈值两侧都用真实谱系', () => {
  // 交接要求第 6 条的另一半：`> 0.25` 的严格性必须在**真实谱系**上也成立，
  // 而不只是手写数值上。用同一个母亲、不同父亲造出半同胞。
  const r = rng();
  const mother = createCreature({ id: 'M', name: 'M', age: 700, rng: r });
  const f1 = createCreature({ id: 'F1', name: 'F1', age: 700, rng: r });
  const f2 = createCreature({ id: 'F2', name: 'F2', age: 700, rng: r });
  const h1 = createCreature({ id: 'H1', name: 'H1', age: 600, rng: r, mother: 'M', father: 'F1' });
  const h2 = createCreature({ id: 'H2', name: 'H2', age: 600, rng: r, mother: 'M', father: 'F2' });
  const byId = (id) => ({ M: mother, F1: f1, F2: f2, H1: h1, H2: h2 }[id] || null);

  assert.equal(kinshipOf(h1, h2, byId), KINSHIP.halfSibling, '同母异父应为 0.25');
  registerKinship(h1, [mother, f1, h2], byId);
  registerKinship(h2, [mother, f2, h1], byId);
  adjust(h1.memory, 'H2', 0.6, 0.5);
  adjust(h2.memory, 'H1', 0.6, 0.5);

  for (const c of [h1, h2]) {
    c.emotions.arousal = 0.9; c.emotions.fear = 0;
    c.needs.hunger = 0.1; c.needs.energy = 0.1;
  }
  assert.equal(get(h1.memory, 'H2').kinship, KINSHIP.halfSibling, '前置条件：0.25 已写入');
  assert.equal(canCourt(h1, h2, OK), true,
    '恰好 0.25 属于允许的边缘（拒绝条件是严格大于），间隔一代的繁殖是"偶尔返祖惊喜"的来源');
});

// ---------- 好感门槛（spec 4.12 第 2 条）----------

test('好感低于 rejectionAffection 时拒绝开始求偶（阈值两侧 + 双向 + 对照）', () => {
  // 原计划漏了这条门槛：`rejectionAffection` 被列进 Consumes，却只在 Task 10 里
  // 当"被拒后的记忆惩罚"用，于是 affection = -1 的一对也会开始完整的求偶仪式。
  const { a, b } = pair();
  assert.equal(CONFIG.rejectionAffection, -0.15, 'spec §11 的值');
  const setAff = (v) => {
    get(a.memory, 'b').affection = v;
    get(b.memory, 'a').affection = v;
  };
  setAff(CONFIG.rejectionAffection);
  assert.equal(canCourt(a, b, OK), true, '恰好 -0.15 属于允许的边缘（条件是严格小于）');
  setAff(CONFIG.rejectionAffection - 0.01);
  assert.equal(canCourt(a, b, OK), false, '低于阈值应拒绝');
  // 双向：只有一方好感低也必须拒绝
  setAff(0.5);
  get(b.memory, 'a').affection = CONFIG.rejectionAffection - 0.01;
  assert.equal(canCourt(a, b, OK), false, '单向好感低也必须拒绝');
  // 对照：pair() 默认好感 0.6 时可以求偶 —— 证明上面的 false 不是别的原因
  setAff(0.6);
  assert.equal(canCourt(a, b, OK), true, '对照组：正常好感应可求偶');
});

// ---------- slot 顺序承重（交接要求第 3 条）----------
test('dom ≠ 0.5 的基因座使 slot 顺序承重（前提，无 rng，完全确定）', () => {
  // genes.phenotype 是 `a[0]*dom + a[1]*(1-dom)`，所以对 dom ≠ 0.5 的基因座
  // （pattern 0.7、glow 0.6）**slot 顺序是承重的**：slot 0 = 母方。
  // 先把这条前提本身钉死（纯函数，不涉随机），下面的集成断言才站得住。
  assert.ok(Math.abs(phenotype('pattern', [0.9, 0.1]) - 0.66) < 1e-12, '0.9*0.7+0.1*0.3 = 0.66');
  assert.ok(Math.abs(phenotype('pattern', [0.1, 0.9]) - 0.34) < 1e-12, '反交得 0.34，与上一行不同');
  assert.equal(phenotype('hue', [0.9, 0.1]), phenotype('hue', [0.1, 0.9]),
    'dom = 0.5 的座对顺序不敏感 —— 所以只用 hue 做遗传测试根本测不出 slot 约定');
});

test('layEggs 把母方放在 slot 0（用 dom ≠ 0.5 的 pattern 座观察）', () => {
  // 这是交接要求第 3 条要求"真的观察一个 dom ≠ 0.5 的基因座"的落地。
  // 原计划的 Task 8 全部遗传测试都用 hue（dom = 0.5），
  // 于是把 layEggs 里的 `inherit(rng, mother.genes, father.genes)` 写成
  // `inherit(rng, father.genes, mother.genes)`（换序）不会有任何测试变红 ——
  // 反交在 pattern / glow 上结果不同，是刻意的设计，必须有测试守着。
  const { a, b } = pair();
  // 母方 pattern 纯合 0.9，父方纯合 0.1。
  // 子代 slot 0 取母方配子（≈0.9），slot 1 取父方（≈0.1）；
  // 变异幅度远不足以跨越 0.5 这条分界，所以用中点判定是稳健的。
  a.genes.pattern = [0.9, 0.9];
  b.genes.pattern = [0.1, 0.1];

  const eggs = layEggs(a, b, createRng(4242), { atPopulationCap: false });
  assert.ok(eggs.length > 0, '前置条件：这一胎必须有卵，否则下面的循环是空转');
  for (const e of eggs) {
    assert.ok(e.genes.pattern[0] > 0.5,
      `卵 ${e.id} 的 pattern slot 0 应来自母方（≈0.9），实际 ${e.genes.pattern[0]} —— 若换成父方会得 ≈0.1`);
    assert.ok(e.genes.pattern[1] < 0.5,
      `卵 ${e.id} 的 pattern slot 1 应来自父方（≈0.1），实际 ${e.genes.pattern[1]}`);
  }
});

test('亚成体不求偶', () => {
  const { a, b } = pair();
  a.age = 200; a.stage = 'juvenile';
  assert.equal(canCourt(a, b, OK), false);
});

test('老年不求偶', () => {
  const { a, b } = pair();
  a.age = 1000; a.stage = 'elder';
  assert.equal(canCourt(a, b, OK), false);
});

test('死亡个体不求偶', () => {
  const { a, b } = pair();
  a.alive = false;
  assert.equal(canCourt(a, b, OK), false);
});

test('自己不能和自己求偶', () => {
  const { a } = pair();
  assert.equal(canCourt(a, a, OK), false);
});

test('arousal 不足时不求偶', () => {
  const { a, b } = pair();
  a.emotions.arousal = 0.05;
  b.emotions.arousal = 0.05;
  assert.equal(canCourt(a, b, OK), false);
});

test('极度饥饿时不求偶（饿着肚子不想恋爱）', () => {
  const { a, b } = pair();
  a.needs.hunger = 0.95;
  assert.equal(canCourt(a, b, OK), false);
});

test('距离超过 courtshipRange 时不求偶', () => {
  const { a, b } = pair();
  assert.equal(canCourt(a, b, { ...OK, distance: CONFIG.courtshipRange + 0.01 }), false);
  assert.equal(canCourt(a, b, { ...OK, distance: CONFIG.courtshipRange - 0.01 }), true);
});

test('已在求偶中的个体不再开始新的求偶', () => {
  const { a, b } = pair();
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: rng() });
  c.emotions.arousal = 0.9;
  startCourtship(a, b, rng());
  assert.equal(canCourt(a, c, OK), false, 'a 已名花有主');
});

test('fear 过高时不求偶（附近有威胁）', () => {
  const { a, b } = pair();
  a.emotions.fear = 0.8;
  assert.equal(canCourt(a, b, OK), false);
});

// ---------- courtshipScore：种群上限用叙事而非硬屏蔽 ----------

test('courtshipScore 对可求偶的一对返回正分', () => {
  const { a, b } = pair();
  assert.ok(courtshipScore(a, b, OK) > 0);
});

test('courtshipScore 对不可求偶的一对返回 0', () => {
  const { a, b } = pair();
  a.age = 200; a.stage = 'juvenile';
  assert.equal(courtshipScore(a, b, OK), 0);
});

test('好感越高分数越高', () => {
  const p1 = pair();
  const p2 = pair();
  adjust(p2.a.memory, 'b', 0.4, 0);      // p2 好感更高
  adjust(p2.b.memory, 'a', 0.4, 0);
  assert.ok(courtshipScore(p2.a, p2.b, OK) > courtshipScore(p1.a, p1.b, OK));
});

test('arousal 越高分数越高', () => {
  // ⚠️ 原始 brief 的写法是"造两对（p1、p2）、只抬高 p2 的 arousal 再比较"，
  // 那**不是受控实验**：`pair()` 每次都用新的种子造出两只生物，而
  // `thresholds.courtshipWillingness`（由 libido 基因决定）是随机的，
  // 它在评分里是一个**纯乘数**。于是"p2 的分数更高"这件事同时取决于
  // arousal 和两个随机乘数之差 —— 后者偶尔会把前者盖过去。
  //
  // 这不是推测，是实测：把 uid 从 0 起按对穷举 30 对，
  // 有 4 对（uid 18/19、38/39、44/45、50/51）会因为 p1 的 willingness 明显更高而变红。
  // 也就是说这条测试**是否通过取决于文件里前面的用例消耗了多少次 uid** ——
  // 加一条无关的用例就可能让它翻面。实测中它确实在本套件里失败了。
  //
  // 改法是真正的受控：**同一对生物**，只改 arousal，其他因子逐个消掉。
  const { a, b } = pair();
  a.emotions.arousal = 0.5;
  b.emotions.arousal = 0.5;
  const low = courtshipScore(a, b, OK);
  a.emotions.arousal = 1;
  b.emotions.arousal = 1;
  const high = courtshipScore(a, b, OK);
  assert.ok(high > low, `arousal 提高后分数应变大: ${low} → ${high}`);
});

test('libido（courtshipWillingness）越高分数越高', () => {
  const { a, b } = pair();
  a.thresholds.courtshipWillingness = 1.4;
  b.thresholds.courtshipWillingness = 1.4;
  const eager = courtshipScore(a, b, OK);
  a.thresholds.courtshipWillingness = 0.6;
  b.thresholds.courtshipWillingness = 0.6;
  assert.ok(eager > courtshipScore(a, b, OK));
});

test('达种群上限时分数被显著压低但不归零（spec 4.12 第 6 条：叙事而非硬屏蔽）', () => {
  const { a, b } = pair();
  const below = courtshipScore(a, b, { population: 8, populationCap: 24, distance: 0.05 });
  const atCap = courtshipScore(a, b, { population: 24, populationCap: 24, distance: 0.05 });
  assert.ok(atCap < below * 0.25, `上限时应大幅压低: ${below} → ${atCap}`);
  assert.ok(atCap > 0, '不归零 —— 它们仍"彼此不太感兴趣"地尝试，而不是被代码禁止');
});

test('接近上限时分数就开始下降（渐变而非断崖）', () => {
  const { a, b } = pair();
  const scores = [10, 16, 20, 22, 24].map(
    (pop) => courtshipScore(a, b, { population: pop, populationCap: 24, distance: 0.05 }),
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1] + 1e-9, `种群越密分数应越低: ${scores}`);
  }
});

test('距离越远分数越低', () => {
  const { a, b } = pair();
  const near = courtshipScore(a, b, { ...OK, distance: 0.02 });
  const far = courtshipScore(a, b, { ...OK, distance: CONFIG.courtshipRange - 0.01 });
  assert.ok(near > far);
});

// ---------- 求偶仪式状态机 ----------

test('startCourtship 在两只身上各写入互相指向的 courtship', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  assert.equal(a.courtship.partnerId, 'b');
  assert.equal(b.courtship.partnerId, 'a');
  assert.equal(a.courtship.t, 0);
  assert.equal(b.courtship.t, 0);
});

test('仪式时长落在 CONFIG.courtship 区间内', () => {
  for (let i = 0; i < 200; i++) {
    const { a, b } = pair();
    startCourtship(a, b, createRng(i));
    assert.ok(a.courtship.duration >= CONFIG.courtship.min, `过短: ${a.courtship.duration}`);
    assert.ok(a.courtship.duration <= CONFIG.courtship.max, `过长: ${a.courtship.duration}`);
    assert.equal(a.courtship.duration, b.courtship.duration, '双方时长必须一致，否则一方会先结束');
  }
});

test('tickCourtship 推进计时并在未完成时返回 ongoing', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  assert.equal(tickCourtship(a, 1), 'ongoing');
  assert.ok(Math.abs(a.courtship.t - 1) < 1e-9);
});

test('tickCourtship 在时长耗尽时返回 complete', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  const d = a.courtship.duration;
  let result = 'ongoing';
  for (let i = 0; i < Math.ceil(d * 60) + 10 && result === 'ongoing'; i++) {
    result = tickCourtship(a, 1 / 60);
  }
  assert.equal(result, 'complete');
});

test('complete 后 courtship 被清空（不会重复完成）', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  for (let i = 0; i < (CONFIG.courtship.max + 1) * 60; i++) tickCourtship(a, 1 / 60);
  assert.equal(a.courtship, null);
  assert.equal(tickCourtship(a, 1 / 60), 'ongoing', '没有进行中的仪式时应返回 ongoing 且不抛错');
});

test('interruptCourtship 清空仪式', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  interruptCourtship(a);
  assert.equal(a.courtship, null);
});

test('仪式可被打断：一方中断后另一方也应在下一次 tick 感知（由 sim 负责），本模块提供 phase 推进', () => {
  const { a, b } = pair();
  startCourtship(a, b, rng());
  // phase 随进度从 0 推进到 3：0 绕圈 / 1 脉动同步 / 2 轻触 / 3 膨胀展示
  //
  // ⚠️ 原始 brief 在这条末尾还有一次 `tickCourtship(a, duration * 0.2)`，
  // 然后断言 `a.courtship.phase === 3`。那一步是**不可满足的**：
  // 前三次累积到 0.9d，第四次把累积推到 1.1d ≥ d，于是这一次调用**必然**
  // 返回 'complete' 并把 a.courtship 置为 null —— 紧接着读 `.phase`
  // 就是在读 null 的属性（实测 TypeError: Cannot read properties of null），
  // 任何实现都无法同时满足"完成即清空"（上一组用例要求的）与这条断言。
  // 实测：phase 在**第三次** tick 就已经是 3（累积 0.9d 落在 [0.85, 1) 区间），
  // 所以去掉那一步之后这条断言仍然真的在检查"最后一段是膨胀展示"。
  tickCourtship(a, a.courtship.duration * 0.1);
  assert.equal(a.courtship.phase, 0);
  tickCourtship(a, a.courtship.duration * 0.4);
  assert.ok(a.courtship.phase >= 1, `应进入脉动同步阶段，实际 ${a.courtship.phase}`);
  tickCourtship(a, a.courtship.duration * 0.4);
  assert.ok(a.courtship.phase >= 2, `应进入轻触阶段，实际 ${a.courtship.phase}`);
  assert.equal(a.courtship.phase, 3, `累积 0.9d 应已进入膨胀展示阶段，实际 ${a.courtship.phase}`);
});

// ---------- 产卵 ----------

test('layEggs 产出 1–3 枚卵', () => {
  const { a, b } = pair();
  const counts = new Set();
  for (let i = 0; i < 300; i++) {
    const eggs = layEggs(a, b, createRng(i), { atPopulationCap: false });
    assert.ok(eggs.length >= CONFIG.eggsPerClutch[0], `过少: ${eggs.length}`);
    assert.ok(eggs.length <= CONFIG.eggsPerClutch[1], `过多: ${eggs.length}`);
    counts.add(eggs.length);
  }
  assert.equal(counts.size, 3, '1、2、3 枚都应出现');
});

test('每枚卵都携带完整的合法基因组', () => {
  const { a, b } = pair();
  const eggs = layEggs(a, b, rng(), { atPopulationCap: false });
  for (const egg of eggs) {
    for (const g of ALL_GENES) {
      assert.ok(Array.isArray(egg.genes[g]) && egg.genes[g].length === 2);
      for (const allele of egg.genes[g]) assert.ok(allele >= 0 && allele <= 1);
    }
  }
});

test('同一窝的每枚卵基因互不相同（spec 4.12 第 3 条）', () => {
  const { a, b } = pair();
  let sawDifference = false;
  for (let i = 0; i < 200 && !sawDifference; i++) {
    const eggs = layEggs(a, b, createRng(i), { atPopulationCap: false });
    if (eggs.length < 2) continue;
    const keys = eggs.map((e) => JSON.stringify(e.genes));
    sawDifference = new Set(keys).size === keys.length;
  }
  assert.ok(sawDifference, '同窝卵应各不相同');
});

test('卵的基因确实来自双亲（子代表现型落在双亲之间）', () => {
  const r = rng();
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: r });
  const b = createCreature({ id: 'b', name: 'B', x: 0.5, y: 0.5, age: 600, rng: r });
  a.genes.hue = [0.1, 0.1];
  b.genes.hue = [0.9, 0.9];
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 400; i++) {
    for (const egg of layEggs(a, b, createRng(i), { atPopulationCap: false })) {
      sum += phenotype('hue', egg.genes.hue);
      n++;
    }
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.5) < 0.06, `子代 hue 均值偏离双亲中点: ${mean}`);
});

test('layEggs 记录双亲 id、位置与初始年龄', () => {
  const { a, b } = pair();
  a.pos = { x: 0.3, y: 0.9 };
  const eggs = layEggs(a, b, rng(), { atPopulationCap: false });
  for (const egg of eggs) {
    assert.equal(egg.motherId, 'a');
    assert.equal(egg.fatherId, 'b');
    assert.equal(egg.age, 0);
    assert.equal(egg.viable, true);
    assert.ok(egg.id && typeof egg.id === 'string');
    assert.ok(egg.pos.x >= 0 && egg.pos.x <= 1, '卵应产在缸内');
    assert.ok(egg.pos.y >= 0 && egg.pos.y <= 1);
  }
});

test('同一窝的卵 id 互不重复', () => {
  const { a, b } = pair();
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    for (const egg of layEggs(a, b, createRng(i), { atPopulationCap: false })) {
      assert.ok(!ids.has(egg.id), `id 重复: ${egg.id}`);
      ids.add(egg.id);
    }
  }
});

test('卵产在缸底附近（spec 4.12：雌性在缸底产卵）', () => {
  const { a, b } = pair();
  a.pos = { x: 0.5, y: 0.2 };      // 母体在水体中部
  for (let i = 0; i < 100; i++) {
    for (const egg of layEggs(a, b, createRng(i), { atPopulationCap: false })) {
      assert.ok(egg.pos.y > 0.7, `卵应落在缸底，实际 y = ${egg.pos.y}`);
    }
  }
});

test('达种群上限时卵被标记为不可孵化（叙事化：卵的光会慢慢熄灭）', () => {
  const { a, b } = pair();
  const eggs = layEggs(a, b, rng(), { atPopulationCap: true });
  assert.ok(eggs.length > 0, '仍然产卵 —— 不硬屏蔽');
  for (const egg of eggs) assert.equal(egg.viable, false);
});

test('layEggs 把双亲互记为 mate、并预留 offspring 关联', () => {
  const { a, b } = pair();
  layEggs(a, b, rng(), { atPopulationCap: false });
  assert.ok(a.lineage.mates.includes('b'), 'a 应记住 b 是伴侣');
  assert.ok(b.lineage.mates.includes('a'));
  assert.equal(a.lineage.mates.filter((x) => x === 'b').length, 1, '重复产卵不该重复记录 mate');
});

// ---------- 孵化 ----------

test('tickEgg 在卵期未满时返回 incubating', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg, 1), 'incubating');
  assert.ok(Math.abs(egg.age - 1) < 1e-9);
});

test('tickEgg 在卵期满时返回 ready', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg, CONFIG.stage.egg + 0.1), 'ready');
});

test('不可孵化的卵返回 failed 而不是 ready（spec 4.12 第 6 条）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: true });
  assert.equal(tickEgg(egg, CONFIG.stage.egg + 0.1), 'failed');
});

test('tickEgg 与时间步长无关', () => {
  const { a, b } = pair();
  const [e1] = layEggs(a, b, createRng(1), { atPopulationCap: false });
  const [e2] = layEggs(a, b, createRng(1), { atPopulationCap: false });
  for (let i = 0; i < 30 * 60; i++) tickEgg(e1, 1 / 60);
  tickEgg(e2, 30);
  assert.ok(Math.abs(e1.age - e2.age) < 1e-9, `${e1.age} vs ${e2.age}`);
});

test('failed 的卵年龄继续推进但永远不会 ready', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: true });
  for (let i = 0; i < 10; i++) {
    assert.equal(tickEgg(egg, CONFIG.stage.egg), 'failed');
  }
});

test('hatch 产出从 hatchling 开始的新个体', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: (g, i) => `幼体${i}`, generation: 2 });
  assert.equal(baby.stage, 'hatchling');
  assert.equal(baby.age, 0);
  assert.equal(baby.alive, true);
  assert.equal(baby.generation, 2);
});

test('hatch 的基因组就是卵的基因组（不再二次变异）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  assert.deepEqual(baby.genes, egg.genes);
});

test('hatch 建立亲缘记忆：孩子认得父母，父母认得孩子', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  assert.equal(baby.lineage.mother, 'a');
  assert.equal(baby.lineage.father, 'b');
  // 孩子的记忆里应有父母，亲缘系数 0.5
  const babyMom = baby.memory.entries.find((e) => e.id === 'a');
  assert.ok(babyMom, '孩子应记得妈妈');
  assert.equal(babyMom.kinship, 0.5);
  assert.equal(babyMom.role, 'mother');
});

test('hatch 的位置在卵的位置附近（幼体紧贴孵化点，spec 4.11）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  egg.pos = { x: 0.4, y: 0.85 };
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  assert.ok(Math.abs(baby.pos.x - 0.4) < 0.05);
  assert.ok(Math.abs(baby.pos.y - 0.85) < 0.05);
});

test('hatch 出的幼体确实极小（growthFactor 起点低，这是"刚孵化"的可见信号）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  assert.equal(baby.age, 0);
  assert.ok(growthFactor(baby) < 0.3, `新生幼体的生长系数应很小，实际 ${growthFactor(baby)}`);
  assert.ok(sizeOf(baby) < sizeOf(a) * 0.4,
    `幼体应显著小于成体母本: ${sizeOf(baby)} vs ${sizeOf(a)}`);
});

test('hatch 的返回值自带完整亲子关系，sim 无需回查卵就能写回父母侧', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, b, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  // 这三条是 tickEggs 写回父母记忆与家谱所依赖的全部信息
  assert.equal(baby.lineage.mother, egg.motherId, 'mother 必须来自卵');
  assert.equal(baby.lineage.father, egg.fatherId, 'father 必须来自卵');
  assert.equal(baby.lineage.mother, 'a');
  assert.equal(baby.lineage.father, 'b');
  assert.equal(baby.id, `c-${egg.id}`, 'id 由卵 id 派生，保证唯一且可追溯');
});

test('hatch 同一种子下完全可复现', () => {
  const { a, b } = pair();
  const e1 = layEggs(a, b, createRng(7), { atPopulationCap: false })[0];
  const e2 = layEggs(a, b, createRng(7), { atPopulationCap: false })[0];
  const b1 = hatch(e1, createRng(8), { nameFor: (g, i) => `n${i}`, generation: 2 });
  const b2 = hatch(e2, createRng(8), { nameFor: (g, i) => `n${i}`, generation: 2 });
  assert.deepEqual(b1.genes, b2.genes);
  assert.equal(b1.name, b2.name);
  assert.deepEqual(b1.pos, b2.pos);
});
