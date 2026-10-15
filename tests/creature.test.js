import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { ALL_GENES, decode, randomGenome } from '../src/genes.js';
import { EMOTION_KEYS } from '../src/emotions.js';
import {
  STAGES, createCreature, stageForAge, ageCreature, growthFactor, sizeOf, canBreed, isAdultLike,
} from '../src/creature.js';

const mk = (over = {}) => createCreature({
  id: 'c1', name: '泡泡', x: 0.5, y: 0.5, rng: createRng(100), ...over,
});

const totalLife = CONFIG.stage.hatchling + CONFIG.stage.juvenile
  + CONFIG.stage.adult + CONFIG.stage.elder;

test('STAGES 不含 egg（卵是独立实体）', () => {
  assert.deepEqual(STAGES, ['hatchling', 'juvenile', 'adult', 'elder', 'dead']);
  assert.ok(!STAGES.includes('egg'));
});

test('STAGES 被冻结，且冻结这件事本身被钉住', () => {
  // 只断言内容是不够的：deepEqual 比的是内容与原型，**不是可变性**，
  // 所以摘掉 Object.freeze 不会让上面那条变红，之后一次就地改写也无人察觉。
  // （Task 2 的 PATTERNS 就是这样被 .reverse() 静默重排的。）
  assert.ok(Object.isFrozen(STAGES), 'STAGES 应被冻结');
  assert.throws(() => STAGES.push('egg'), TypeError, 'push 应抛 TypeError');
  assert.throws(() => { STAGES[1] = 'adult'; }, TypeError, '下标赋值应抛 TypeError');
  assert.throws(() => STAGES.reverse(), TypeError, 'reverse 应抛 TypeError');
  // 反向确认：冻结只挡写，不挡读与展开（stageForAge / 表现层靠读它工作）
  assert.equal([...STAGES].length, 5);
  assert.equal([...STAGES].join(','), 'hatchling,juvenile,adult,elder,dead');
});

test('createCreature 生成完整的状态容器', () => {
  const c = mk({ genes: undefined });
  for (const k of [
    'id', 'name', 'customName', 'generation', 'genes', 'traits', 'thresholds',
    'age', 'stage', 'alive', 'sick', 'dying', 'pos', 'vel', 'facing',
    'needs', 'emotions', 'memory', 'intent', 'intentTime',
    'resting', 'moving', 'courtship', 'mourn', 'lineage',
  ]) {
    assert.ok(k in c, `缺少字段 ${k}`);
  }
  assert.equal(c.id, 'c1');
  assert.equal(c.name, '泡泡');
  assert.equal(c.customName, false);
  assert.equal(c.alive, true);
  assert.equal(c.sick, false);
  assert.equal(c.dying, 0);
  assert.deepEqual(c.pos, { x: 0.5, y: 0.5 });
  assert.deepEqual(c.vel, { x: 0, y: 0 });
  assert.equal(c.intent, null);
  assert.equal(c.courtship, null);
  assert.equal(c.mourn, 0);
});

test('未提供 genes 时自动生成合法基因组', () => {
  const c = mk();
  for (const g of ALL_GENES) {
    assert.ok(Array.isArray(c.genes[g]) && c.genes[g].length === 2);
    for (const a of c.genes[g]) assert.ok(a >= 0 && a <= 1);
  }
});

test('提供 genes 时原样使用，且不需要 rng（读档路径）', () => {
  const genes = randomGenome(createRng(55));
  const c = createCreature({ id: 'c9', name: '读档', x: 0.4, y: 0.6, genes });
  assert.deepEqual(c.genes, genes);
  assert.deepEqual(c.traits, decode(genes));
});

test('既没有 genes 也没有 rng 时立刻抛错（不允许退化成不可复现的随机源）', () => {
  assert.throws(
    () => createCreature({ id: 'x', name: 'x', x: 0.5, y: 0.5 }),
    /rng/,
  );
});

test('traits 与 thresholds 在创建时就解码好（避免每帧重复计算）', () => {
  const c = mk();
  assert.deepEqual(c.traits, decode(c.genes));
  assert.ok(typeof c.thresholds.fearThreshold === 'number');
  assert.ok(typeof c.thresholds.playerApproach === 'number');
});

test('emotions / needs / memory 是独立实例，不共享引用', () => {
  const a = mk({ id: 'a' });
  const b = mk({ id: 'b' });
  a.needs.hunger = 1;
  a.emotions.joy = 1;
  assert.equal(b.needs.hunger < 1, true, 'needs 被共享了');
  assert.equal(b.emotions.joy, 0, 'emotions 被共享了');
  assert.notEqual(a.memory, b.memory);
});

test('facing 是单位向量', () => {
  const c = mk();
  const len = Math.hypot(c.facing.x, c.facing.y);
  assert.ok(Math.abs(len - 1) < 1e-9, `facing 长度 = ${len}`);
});

test('默认从 hatchling 阶段、age 0 开始', () => {
  const c = mk();
  assert.equal(c.stage, 'hatchling');
  assert.equal(c.age, 0);
});

test('可以指定初始阶段与年龄（新缸生成亚成体，spec 9.1）', () => {
  const c = mk({ age: 200, stage: 'juvenile' });
  assert.equal(c.age, 200);
  assert.equal(c.stage, 'juvenile');
});

test('lineage 记录父母且默认为空数组的 mates/offspring', () => {
  const c = mk({ mother: 'm1', father: 'f1' });
  assert.equal(c.lineage.mother, 'm1');
  assert.equal(c.lineage.father, 'f1');
  assert.deepEqual(c.lineage.mates, []);
  assert.deepEqual(c.lineage.offspring, []);
});

test('lineage 的 mates/offspring 不共享引用', () => {
  const a = mk({ id: 'a' });
  const b = mk({ id: 'b' });
  a.lineage.offspring.push('x');
  assert.equal(b.lineage.offspring.length, 0);
});

test('stageForAge 按年龄正确切换（spec 4.11）', () => {
  assert.equal(stageForAge(0), 'hatchling');
  assert.equal(stageForAge(179.9), 'hatchling');
  assert.equal(stageForAge(180), 'juvenile');
  assert.equal(stageForAge(479.9), 'juvenile');
  assert.equal(stageForAge(480), 'adult');
  assert.equal(stageForAge(959.9), 'adult');
  assert.equal(stageForAge(960), 'elder');
  assert.equal(stageForAge(totalLife - 0.1), 'elder');
  assert.equal(stageForAge(totalLife), 'dead');
  assert.equal(stageForAge(totalLife + 1000), 'dead');
});

test('stageForAge 与 CONFIG.stage 的边界一致（防止两处数字打架）', () => {
  const h = CONFIG.stage.hatchling;
  const j = h + CONFIG.stage.juvenile;
  const a = j + CONFIG.stage.adult;
  const e = a + CONFIG.stage.elder;
  assert.equal(stageForAge(h - 1e-6), 'hatchling');
  assert.equal(stageForAge(h), 'juvenile');
  assert.equal(stageForAge(j), 'adult');
  assert.equal(stageForAge(a), 'elder');
  assert.equal(stageForAge(e), 'dead');
});

test('ageCreature 推进年龄并自动切换阶段', () => {
  const c = mk();
  for (let i = 0; i < 200 * 60; i++) ageCreature(c, 1 / 60);
  assert.ok(c.age > 199 && c.age < 201, `age = ${c.age}`);
  assert.equal(c.stage, 'juvenile');
  for (let i = 0; i < 400 * 60; i++) ageCreature(c, 1 / 60);
  assert.equal(c.stage, 'adult');
});

test('ageCreature 与时间步长无关', () => {
  const a = mk({ id: 'a' });
  const b = mk({ id: 'b' });
  for (let i = 0; i < 600; i++) ageCreature(a, 1 / 60);
  ageCreature(b, 10);
  assert.ok(Math.abs(a.age - b.age) < 1e-9, `${a.age} vs ${b.age}`);
  assert.equal(a.stage, b.stage);
});

test('活满寿命后死亡：alive=false 且 stage 停在 elder', () => {
  const c = mk();
  for (let i = 0; i < (totalLife + 5) * 60; i++) ageCreature(c, 1 / 60);
  assert.equal(c.alive, false);
  assert.equal(c.stage, 'elder', '死亡不改变阶段标签，靠 alive 与 dying 表达');
  assert.ok(c.dying > 0, 'dying 应被启动，供表现层播放溶散动画');
});

test('死亡后 ageCreature 不再推进（spec 8.1：死亡后不再 tick）', () => {
  const c = mk();
  for (let i = 0; i < (totalLife + 5) * 60; i++) ageCreature(c, 1 / 60);
  const ageAtDeath = c.age;
  const dyingAtDeath = c.dying;
  for (let i = 0; i < 600; i++) ageCreature(c, 1 / 60);
  assert.equal(c.age, ageAtDeath);
  assert.equal(c.dying, dyingAtDeath);
});

test('死亡只触发一次（dying 不会被重置）', () => {
  const c = mk();
  for (let i = 0; i < (totalLife + 5) * 60; i++) ageCreature(c, 1 / 60);
  const first = c.dying;
  ageCreature(c, 1 / 60);
  assert.equal(c.dying, first);
});

test('dying 的哨兵值受字面量约束（远小于溶散时长）', () => {
  // 上面两条只断言 `dying > 0` 与"不被重置"，那是空洞的：
  // `c.dying = 1`（"动画已开始"的另一种自然读法）同样满足它们。
  // 但 Task 10 用 `c.dying += dt` 累加、再与 `CONFIG.dissolveDuration`（4 秒）比较
  // 来决定移除时机，所以哨兵值直接决定溶散动画播多久 —— 写成 1 会静默截短它。
  //
  // ⚠️ 这里**不能**断言 `c.dying < CONFIG.dissolveDuration`：
  // `dissolveDuration` 由 **Task 10** 追加进 config.js，而 Task 7 跑在它前面，
  // 此刻该字段还不存在（= undefined），比较会得到 NaN 而使本条变红。
  // 因此 Task 7 只钉住哨兵值本身，跨模块的关系由 Task 10 的测试负责断言。
  const c = mk();
  for (let i = 0; i < (totalLife + 5) * 60; i++) ageCreature(c, 1 / 60);
  assert.equal(c.dying, 1e-6, '哨兵值必须是 1e-6');
  assert.ok(c.dying > 0, '又必须非零 —— 它是"动画已开始"的标志位');
});

test('显式 stage 优先于 age（孵化与读档依赖这条优先级）', () => {
  // 这是**故意传入不一致的一对**，专门钉住优先级规则。
  // 原计划只有 `mk({ age: 200, stage: 'juvenile' })` 这一个用例，而那一对本来就是
  // 自洽的 —— 派生实现（忽略 opts.stage、只用 stageForAge(age)）也能通过，等于没测。
  // 为什么必须钉：Task 8 的 hatch 传的是 `{ age: 0, stage: 'hatchling' }`（自洽，同样测不出来），
  // 而 Plan 3 读档时可能拿到"年龄与阶段标签不同步"的存档。
  // 若哪天有人"简化"成 `stage: stageForAge(opts.age || 0)`，
  // 一只 age=600 但标签是 hatchling 的幼体会被静默记成成体。
  const c = mk({ age: 600, stage: 'hatchling' });
  assert.equal(c.age, 600, '显式 age 生效');
  assert.equal(c.stage, 'hatchling', '不一致时以显式 stage 为准，而不是从 age 派生');

  // 反向：不传 stage 时才从 age 派生 —— 保证上面那条不是"stage 被无条件信任"的巧合
  const d = mk({ age: 600 });
  assert.equal(d.stage, 'adult', '不传 stage 时应由 age 派生出 adult');
});

test('growthFactor 是连续插值，不是阶段跳变（spec 4.11）', () => {
  const c = mk();
  const samples = [];
  for (let age = 0; age <= totalLife; age += 10) {
    c.age = age;
    samples.push(growthFactor(c));
  }
  // 相邻采样点的差值不应出现巨大跳跃
  for (let i = 1; i < samples.length; i++) {
    assert.ok(Math.abs(samples[i] - samples[i - 1]) < 0.08,
      `age ${(i) * 10} 处生长跳变: ${samples[i - 1]} → ${samples[i]}`);
  }
});

test('growthFactor 单调增长到成体峰值，老年略微回缩', () => {
  const c = mk();
  c.age = 0;
  const hatch = growthFactor(c);
  c.age = CONFIG.stage.hatchling + CONFIG.stage.juvenile + CONFIG.stage.adult - 1;
  const adult = growthFactor(c);
  c.age = totalLife - 1;
  const elder = growthFactor(c);
  assert.ok(hatch < 0.35, `幼体应很小: ${hatch}`);
  assert.ok(adult > hatch * 2.5, `成体应显著更大: ${hatch} → ${adult}`);
  assert.ok(adult <= 1.0001, `成体峰值应约为 1: ${adult}`);
  assert.ok(elder < adult, `老年应微缩: ${adult} → ${elder}`);
  assert.ok(elder > adult * 0.8, '老年只是微缩，不该塌缩');
});

test('growthFactor 的四段端点值与中点值都被字面量钉住', () => {
  // 上面两条只测了"相邻采样不跳变"（|Δ| < 0.08）与单调性，那是**单侧**的：
  // 把首段的 0.22 改成 0.25、或改动任一斜率，两条都仍然全绿，
  // 而"幼体很小 → 成体最大 → 老年微缩"的观感正是由这些端点值决定的。
  // growthFactor 只读 c.age，所以传裸对象即可 —— 顺带把这一点固定下来。
  const g = (age) => growthFactor({ age });
  // 四个分段端点（BOUNDARIES = [180, 480, 960, 1140]）
  assert.ok(Math.abs(g(0) - 0.22) < 1e-12, '出生时 0.22');
  assert.ok(Math.abs(g(180) - 0.5) < 1e-12, '幼体段起点 0.50');
  assert.ok(Math.abs(g(480) - 0.85) < 1e-12, '成体段起点 0.85');
  assert.ok(Math.abs(g(960) - 1) < 1e-12, '成年峰值 1.00 —— 在 age = 960，不是 780');
  assert.ok(Math.abs(g(1140) - 0.88) < 1e-12, '寿命终点微缩到 0.88');
  // 每段中点，钉住斜率（端点对但中间弯折的实现会被这几条抓住）
  assert.ok(Math.abs(g(90) - 0.36) < 1e-12, '第一段中点 0.22 + 0.28×0.5');
  assert.ok(Math.abs(g(330) - 0.675) < 1e-12, '第二段中点 0.50 + 0.35×0.5');
  assert.ok(Math.abs(g(720) - 0.925) < 1e-12, '第三段中点 0.85 + 0.15×0.5');
  assert.ok(Math.abs(g(1050) - 0.94) < 1e-12, '第四段中点 1 − 0.12×0.5');
});

test('growthFactor 始终为正（体型不会变成 0 或负）', () => {
  const c = mk();
  for (let age = 0; age <= totalLife; age += 5) {
    c.age = age;
    assert.ok(growthFactor(c) > 0, `age ${age} 时 growthFactor = ${growthFactor(c)}`);
  }
});

test('sizeOf = traits.size × growthFactor', () => {
  const c = mk();
  c.age = 300;
  assert.ok(Math.abs(sizeOf(c) - c.traits.size * growthFactor(c)) < 1e-9);
});

// canBreed / isAdultLike 读的是 c.stage，不是 c.age ——
// stage 只由 ageCreature 在推进年龄时切换。测试里直接改 age 必须同步改 stage，
// 否则测的是"一个年龄与阶段自相矛盾的非法状态"。
const atAge = (c, age) => {
  c.age = age;
  c.stage = stageForAge(age);
  return c;
};

test('canBreed 只在成体为真', () => {
  const c = mk();
  assert.equal(canBreed(atAge(c, 0)), false, '幼体不能繁殖');
  assert.equal(canBreed(atAge(c, 200)), false, '亚成体不能繁殖');
  assert.equal(canBreed(atAge(c, 600)), true, '成体能繁殖');
  assert.equal(canBreed(atAge(c, 1000)), false, '老年不再繁殖（spec 4.11）');
});

test('canBreed 对已死亡个体为假', () => {
  const c = atAge(mk(), 600);
  assert.equal(canBreed(c), true);
  c.alive = false;
  assert.equal(canBreed(c), false);
});

test('canBreed 对 sick 个体为假', () => {
  const c = atAge(mk(), 600);
  c.sick = true;
  assert.equal(canBreed(c), false, '被隔离的个体不该继续繁殖');
});

test('isAdultLike 涵盖成体与老年（用于社交与哀悼判定）', () => {
  const c = mk();
  assert.equal(isAdultLike(atAge(c, 0)), false);
  assert.equal(isAdultLike(atAge(c, 200)), false);
  assert.equal(isAdultLike(atAge(c, 600)), true);
  assert.equal(isAdultLike(atAge(c, 1000)), true);
});

test('emotion 与 needs 字段齐全（供下游模块直接消费）', () => {
  const c = mk();
  assert.deepEqual(Object.keys(c.emotions).sort(), [...EMOTION_KEYS].sort());
  assert.deepEqual(Object.keys(c.needs).sort(), ['energy', 'hunger', 'safety', 'social']);
});
