import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { createCreature, growthFactor, sizeOf } from '../src/creature.js';
import { ensure, adjust, remember, get, KINSHIP, kinshipBetween } from '../src/memory.js';
import { inherit, phenotype, ALL_GENES } from '../src/genes.js';
import {
  layEggs, tickEgg, eggDuration, hatch, kinshipOf, registerKinship,
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

// （OK 这个 opts 常量随 canCourt 组一起删除 —— 它只服务于求偶评分。）

// （2026-10-20 删除本节）原「canCourt：近亲回避与前置条件」整组测试随孤雌制移除 ——
// 它们测的是**闸门**（kinship 超阈值就不许求偶），闸门没有了。
// 亲缘本身仍然有效，测它的活交给下面的 kinshipOf / registerKinship 两组。
// 一并删掉的还有 seedKin 这个 helper：它存在的唯一理由就是给闸门测试预置亲缘。

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

test('registerKinship 不受调用顺序影响：已存在 kinship 0 的条目也会被写正', () => {
  // 危险场景：双方先在社交里打过照面，adjust 已经为对方建出了 kinship 默认 0 的条目，
  // 之后 registerKinship 才跑。ensure 是**幂等**的，只靠它就**不会**改正 kinship ——
  // 于是亲缘永远停在 0，近亲回避静默失效，症状只是"兄妹怎么生了孩子"。
  // 本实现因此在 ensure 之后显式把缓存值写正（亲缘是客观事实，不该依赖调用顺序）。
  const r = rng();
  const mother = createCreature({ id: 'M', name: 'M', age: 700, rng: r });
  const baby = createCreature({
    id: 'B', name: 'B', age: 0, stage: 'hatchling', rng: r, mother: 'M',
  });
  const byId = (id) => ({ M: mother, B: baby }[id] || null);

  // 模拟"先照面"：两侧都被 adjust 建出条目（kinship 默认 0）
  adjust(baby.memory, 'M', 0.1);
  adjust(mother.memory, 'B', 0.1);
  assert.equal(get(baby.memory, 'M').kinship, 0, '前置条件：条目已存在且 kinship 为 0');
  assert.equal(get(mother.memory, 'B').kinship, 0, '前置条件：同上');

  registerKinship(baby, [mother], byId);

  assert.equal(get(baby.memory, 'M').kinship, KINSHIP.mother, '已存在的条目也必须被写正');
  assert.equal(get(mother.memory, 'B').kinship, KINSHIP.mother, '母亲侧同理');
  assert.equal(get(baby.memory, 'M').role, 'mother');
  assert.equal(get(mother.memory, 'B').role, 'offspring');
  // 反向：写亲缘不得顺手把好感/熟悉度抹掉（那些是互动累积出来的）
  assert.ok(get(baby.memory, 'M').affection > 0, '写亲缘不应重置 affection');
  assert.ok(get(baby.memory, 'M').familiarity > 0, '写亲缘不应重置 familiarity');
  // 而且写正之后，求偶闸门必须真的关上（端到端确认写对了地方）
  assert.equal(kinshipBetween(baby.memory, 'M'), KINSHIP.mother);
});

test('registerKinship 不用 null 覆盖已确立的 role（0.25 档不得抹掉 offspring）', () => {
  // 强制写入 kinship 时，role 只在算出**非 null** 时才覆盖 ——
  // 否则 0.25 档（祖孙/半同胞，在 ROLES 里没有对应角色，算出来就是 null）
  // 会用一个 null 把已确立的 role 抹掉，而那正是"它是我的谁"这类一旦确立就不该变的信息。
  // 这条守的是那半个 if：把它改成无条件 `e.role = role`，全套测试原本照样绿
  // （因为当时唯一的 null 写入，其目标条目的 role 本来就是 null）。
  const r = rng();
  // 谱系：祖母 G → 母亲 M → 雏体 B，所以 G 对 B 是祖孙档（0.25）
  const G = createCreature({ id: 'G', name: 'G', age: 900, rng: r });
  const M = createCreature({ id: 'M', name: 'M', age: 700, rng: r, mother: 'G' });
  const baby = createCreature({
    id: 'B', name: 'B', age: 0, stage: 'hatchling', rng: r, mother: 'M',
  });
  const byId = (id) => ({ G, M, B: baby }[id] || null);

  // 前置条件：G 记忆里已有一条带 role 的条目
  ensure(G.memory, 'B', { kinship: 0.25, role: 'offspring' });
  assert.equal(get(G.memory, 'B').role, 'offspring', '前置条件：role 已确立');
  assert.equal(kinshipOf(baby, G, byId), KINSHIP.grandparent, '前置条件：G 对 B 是祖孙档');

  registerKinship(baby, [G, M], byId);

  assert.equal(get(G.memory, 'B').kinship, KINSHIP.grandparent, '祖孙档应被写入');
  assert.equal(get(G.memory, 'B').role, 'offspring',
    '祖孙档算出的 role 是 null，不得用它覆盖已确立的 role');
  assert.equal(get(baby.memory, 'M').role, 'mother', '同一轮里母亲的 role 仍应正常写入');
});

test('dom ≠ 0.5 的基因座使 slot 顺序承重（前提，无 rng，完全确定）', () => {
  // genes.phenotype 是 `a[0]*dom + a[1]*(1-dom)`，所以对 dom ≠ 0.5 的基因座
  // （pattern 0.7、glow 0.6）**slot 顺序是承重的**：slot 0 = 母方。
  // 先把这条前提本身钉死（纯函数，不涉随机），下面的集成断言才站得住。
  assert.ok(Math.abs(phenotype('pattern', [0.9, 0.1]) - 0.66) < 1e-12, '0.9*0.7+0.1*0.3 = 0.66');
  assert.ok(Math.abs(phenotype('pattern', [0.1, 0.9]) - 0.34) < 1e-12, '反交得 0.34，与上一行不同');
  assert.equal(phenotype('hue', [0.9, 0.1]), phenotype('hue', [0.1, 0.9]),
    'dom = 0.5 的座对顺序不敏感 —— 所以只用 hue 做遗传测试根本测不出 slot 约定');
});

test('tickEgg 在卵期未满时返回 incubating', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg, 1), 'incubating');
  assert.ok(Math.abs(egg.age - 1) < 1e-9);
});

test('tickEgg 在卵期满时返回 ready', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg, eggDuration(egg) + 0.1), 'ready');
});

test('tickEgg 的 ready 边界是包含的（恰好等于 stage.egg 就 ready）', () => {
  // 上面那条用 `stage.egg + 0.1` 越过边界，所以它**测不出** `>=` 与 `>` 的区别：
  // 把实现改成 `egg.age > eggDuration(egg)` 全套测试照样绿，
  // 而那会让孵化整整晚一帧（在 60Hz 下约 16.7ms，视觉上无所谓，
  // 但"恰好到期"这条契约就没人守了）。
  // 注意：不可孵化的卵走的是**早退分支**（`if (!egg.viable) return 'failed'`），
  // 根本走不到年龄比较，所以只测 failed 那条也守不住这里。
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg, eggDuration(egg)), 'ready', '恰好到期即应 ready（边界包含）');
  // 反向：差一点点不能 ready，否则就是提前孵化
  const { a: a2, b: b2 } = pair();
  const [egg2] = layEggs(a2, rng(), { atPopulationCap: false });
  assert.equal(tickEgg(egg2, eggDuration(egg2) - 1e-9), 'incubating', '差一点点不应 ready');
});

test('不可孵化的卵返回 failed 而不是 ready（spec 4.12 第 6 条）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: true });
  assert.equal(tickEgg(egg, eggDuration(egg) + 0.1), 'failed');
});

test('tickEgg 与时间步长无关', () => {
  const { a, b } = pair();
  const [e1] = layEggs(a, createRng(1), { atPopulationCap: false });
  const [e2] = layEggs(a, createRng(1), { atPopulationCap: false });
  for (let i = 0; i < 30 * 60; i++) tickEgg(e1, 1 / 60);
  tickEgg(e2, 30);
  assert.ok(Math.abs(e1.age - e2.age) < 1e-9, `${e1.age} vs ${e2.age}`);
});

test('failed 的卵年龄继续推进但永远不会 ready', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: true });
  for (let i = 0; i < 10; i++) {
    assert.equal(tickEgg(egg, eggDuration(egg)), 'failed');
  }
});

test('hatch 产出从 hatchling 开始的新个体', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: (g, i) => `幼体${i}`, generation: 2 });
  assert.equal(baby.stage, 'hatchling');
  assert.equal(baby.age, 0);
  assert.equal(baby.alive, true);
  assert.equal(baby.generation, 2);
});

test('hatch 出的幼体确实极小（growthFactor 起点低，这是"刚孵化"的可见信号）', () => {
  const { a, b } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  assert.equal(baby.age, 0);
  assert.ok(growthFactor(baby) < 0.3, `新生幼体的生长系数应很小，实际 ${growthFactor(baby)}`);
  assert.ok(sizeOf(baby) < sizeOf(a) * 0.4,
    `幼体应显著小于成体母本: ${sizeOf(baby)} vs ${sizeOf(a)}`);
});

test('hatch 的返回值自带亲子关系，sim 无需回查卵就能写回母亲侧', () => {
  const { a } = pair();
  const [egg] = layEggs(a, rng(), { atPopulationCap: false });
  const baby = hatch(egg, rng(), { nameFor: () => 'x', generation: 2 });
  // 这几条是 tickEggs 写回母亲记忆与家谱所依赖的全部信息
  assert.equal(baby.lineage.mother, egg.motherId, 'mother 必须来自卵');
  assert.equal(baby.lineage.father, egg.fatherId, 'father 必须来自卵（孤雌下恒 null）');
  assert.equal(baby.lineage.mother, 'a');
  // 2026-10-20 孤雌：原来这里断言 father === 'b'，那是双亲契约。
  // 现在父亲这个概念在本物种里没有受者了，键必须**在**但值必须是 null。
  assert.equal(baby.lineage.father, null);
  assert.equal(baby.id, `c-${egg.id}`, 'id 由卵 id 派生，保证唯一且可追溯');
});

test('hatch 同一种子下完全可复现', () => {
  const { a, b } = pair();
  const e1 = layEggs(a, createRng(7), { atPopulationCap: false })[0];
  const e2 = layEggs(a, createRng(7), { atPopulationCap: false })[0];
  const b1 = hatch(e1, createRng(8), { nameFor: (g, i) => `n${i}`, generation: 2 });
  const b2 = hatch(e2, createRng(8), { nameFor: (g, i) => `n${i}`, generation: 2 });
  assert.deepEqual(b1.genes, b2.genes);
  assert.equal(b1.name, b2.name);
  assert.deepEqual(b1.pos, b2.pos);
});

// ==================== 2026-10-20 孤雌自产卵（spec §4.12 / §4.11）====================
//
// 签名变更：`layEggs(mother, rng, opts)` —— 第二个亲参没有了。
// 计划 2R 的接口块写的是 `layEggs(rng, mother, config)`，这里按本模块既有的
// "实体在前、rng 在后"顺序落地（与 `hatch(egg, rng, opts)` 同构）。偏差已记进提交信息。
//
// ⚠️ 这一组是**先写后实现**的：现在跑必然红（layEggs 仍要求两个亲参）。

const motherOf = () => {
  const r = rng();
  const m = createCreature({ id: 'm', name: 'M', x: 0.5, y: 0.5, age: 600, rng: r });
  m.needs.hunger = 0.1;
  m.emotions.arousal = 0.8;
  return m;
};
const LAY = { atPopulationCap: false };

// 造一枚指定大小 / 指定基因来源的蛋，用于测 eggSize 的三条下游通道
const eggOf = (mother, eggSize, over = {}) => ({
  id: 'e-probe',
  genes: inherit(rng(), mother.genes, mother.genes),
  age: 0,
  pos: { x: 0.4, y: 0.9 },
  motherId: mother.id,
  fatherId: null,
  viable: true,
  eggSize,
  eggTint: 'macaron-pink',
  ...over,
});

test('蛋只记母亲：motherId 有值，father 键存在但恒为 null', () => {
  const eggs = layEggs(motherOf(), rng(), LAY);
  assert.ok(eggs.length >= 1);
  for (const e of eggs) {
    assert.equal(e.motherId, 'm');
    assert.ok('fatherId' in e, 'fatherId 键必须保留（存档形状契约，spec §7.2）');
    assert.equal(e.fatherId, null);
  }
});

test('每枚蛋携带全部 19 个位点、每个都是 [0,1] 的二元等位', () => {
  for (const e of layEggs(motherOf(), rng(), LAY)) {
    assert.deepEqual(Object.keys(e.genes).sort(), [...ALL_GENES].sort());
    for (const name of ALL_GENES) {
      assert.equal(e.genes[name].length, 2, `${name} 应为二元数组`);
      for (const a of e.genes[name]) {
        assert.ok(Number.isFinite(a) && a >= 0 && a <= 1, `${name} 等位越界: ${a}`);
      }
    }
  }
});

test('自体合并仍让同窝每枚蛋互不相同（分离与变异各自独立发生）', () => {
  const mother = motherOf();
  const r = rng();
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    for (const e of layEggs(mother, r, LAY)) {
      seen.add(JSON.stringify(e.genes.hue) + JSON.stringify(e.genes.pattern));
    }
  }
  assert.ok(seen.size > 20, `40 窝下来只有 ${seen.size} 种组合，分离疑似退化`);
});

test('产卵枚数落在 CONFIG.eggsPerClutch 区间内', () => {
  const [lo, hi] = CONFIG.eggsPerClutch;
  const r = rng();
  const mother = motherOf();
  for (let i = 0; i < 30; i++) {
    const n = layEggs(mother, r, LAY).length;
    assert.ok(n >= lo && n <= hi, `枚数越界: ${n}`);
  }
});

test('eggSize 落在区间内，且吃饱的母亲蛋更大', () => {
  const { min, max } = CONFIG.eggSize;
  const r = rng();
  const hungry = motherOf(); hungry.needs.hunger = 0.95;
  const full = motherOf(); full.needs.hunger = 0.02;
  const sizeOfClutch = (m) => {
    let sum = 0, n = 0;
    for (let i = 0; i < 60; i++) for (const e of layEggs(m, r, LAY)) { sum += e.eggSize; n++; }
    return sum / n;
  };
  const a = sizeOfClutch(hungry), b = sizeOfClutch(full);
  assert.ok(a >= min && a <= max && b >= min && b <= max, `eggSize 越界: ${a} / ${b}`);
  assert.ok(b > a, `喂得饱的蛋应当更大：饿 ${a.toFixed(4)} vs 饱 ${b.toFixed(4)}`);
});

test('蛋色由母方 eggTint 表现型决定：同窝同色，两家两色', () => {
  const tints = new Set(CONFIG.eggTint.colors);
  // 写这条时我先断言的是"同窝可以不同色"，那是**错的**：蛋色若走子代分离，
  // 一窝蛋五颜六色，"这一家都下蓝蛋"这条家谱线索就没了（spec §4.1 加这个位点的唯一理由）。
  // 决定蛋色的是**母方**的表现型；子代自己的 eggTint 等位要到它成年产卵时才兑现。
  const mother = motherOf();
  mother.genes.eggTint = [0.99, 0.99];          // 表尾 ⇒ 黑蛋段
  const r = rng();
  const got = new Set();
  for (let i = 0; i < 30; i++) {
    for (const e of layEggs(mother, r, LAY)) {
      assert.ok(tints.has(e.eggTint), `非法蛋色: ${e.eggTint}`);
      got.add(e.eggTint);
    }
  }
  assert.deepEqual([...got], ['black'], `母方 eggTint 拉满时全窝应为黑蛋，实际 ${[...got]}`);

  const other = motherOf();
  other.genes.eggTint = [0.05, 0.05];           // 表头 ⇒ 第一种马卡龙
  const otherTints = new Set();
  for (let i = 0; i < 30; i++) for (const e of layEggs(other, r, LAY)) otherTints.add(e.eggTint);
  assert.deepEqual([...otherTints], [CONFIG.eggTint.colors[0]],
    `另一家应全下头一档的色，实际 ${[...otherTints]}`);
  assert.notDeepEqual([...got], [...otherTints], '两家必须下不同色的蛋，否则家谱线索不存在');
});

test('大蛋孵得久：孵化时长随 eggSize 单调递增', () => {
  const mother = motherOf();
  const dur = (eggSize) => {
    const egg = eggOf(mother, eggSize);
    let t = 0;
    for (let i = 0; i < 10000; i++) {
      t += 1 / 60;
      if (tickEgg(egg, 1 / 60) === 'ready') return t;
    }
    return Infinity;
  };
  const small = dur(CONFIG.eggSize.min), big = dur(CONFIG.eggSize.max);
  assert.ok(big > small, `大蛋反而更快（小 ${small} / 大 ${big}）`);
  assert.ok(small > 0 && Number.isFinite(big), '两侧都必须在有限时间内孵化');
});

test('大蛋孵出来就更大：出壳体型随 eggSize 单调递增', () => {
  const mother = motherOf();
  const r = rng();
  // 基因必须只抽一次、两只共用。第一版每次调用都走 eggOf() 重新 inherit，
  // 于是比的是"两只不同基因的幼体谁大"，而不是蛋大小的影响 ——
  // 变异探针（hatchGain 归零）当场存活，就是这个原因。
  const genes = inherit(r, mother.genes, mother.genes);
  const at = (eggSize) => sizeOf(hatch({ ...eggOf(mother, eggSize), genes }, r, {
    nameFor: () => 'X', generation: 2,
  }));
  const small = at(CONFIG.eggSize.min), big = at(CONFIG.eggSize.max);
  assert.ok(big > small, `出壳体型没有随蛋大小上升：${small} vs ${big}`);
});

test('成年体型与 eggSize 无关（EGG_SIZE_BIAS = 0 的钉子，控制方裁定）', () => {
  const mother = motherOf();
  const r = rng();
  // 基因必须**只抽一次**、两只共用。第一版这里每次调用都重新 inherit，
  // 于是测出来的是"两只不同基因的成体体型不同"，而不是蛋大小的影响 —— 假失败。
  const genes = inherit(r, mother.genes, mother.genes);
  const adultSize = (eggSize) => {
    const c = hatch({ ...eggOf(mother, eggSize), genes }, r, { nameFor: () => 'X', generation: 2 });
    c.age = 960;              // 成体起点，growthFactor 峰值
    c.stage = 'adult';
    return sizeOf(c);
  };
  const a = adultSize(CONFIG.eggSize.min), b = adultSize(CONFIG.eggSize.max);
  assert.ok(Math.abs(a - b) < 1e-12, `成年体型受蛋大小影响：${a} vs ${b}（裁定是 0 影响）`);
});

test('hatch 只建立"认妈妈"的记忆；father 为 null 时不写入任何父方条目', () => {
  const mother = motherOf();
  const baby = hatch(eggOf(mother, 1.0), rng(), { nameFor: () => 'X', generation: 2 });
  assert.equal(baby.lineage.mother, 'm');
  assert.equal(baby.lineage.father, null);
  const mom = get(baby.memory, 'm');
  assert.ok(mom, '幼体必须有母亲的记忆条目');
  assert.equal(mom.role, 'mother');
  assert.equal(baby.memory.entries.filter((e) => e.role === 'father').length, 0, '不得有父方条目');
  assert.equal(baby.memory.entries.length, 1, '幼体出生时只该有母亲这一条记忆');
});

test('自体合并：子代的每个等位都来自母方（± 变异），没有外来基因混入', () => {
  // 这条是被**变异探针逼出来的**：把 layEggs 里的第二个实参从 mother.genes
  // 换成 randomGenome(rng)（等于偷偷引入父方），其余 345 条**全部照样绿** ——
  // 因为"卵的基因来自双亲"那条老测试被删掉之后，再没有任何一条在测血统来源。
  // 母方在 hue 上纯合 0.5，配子只能是 0.5 + N(0, 0.06)；
  // 偏离 0.3 相当于 5σ（单侧概率约 3e-7），400 次抽样里出一次都算异常。
  // 而一份随机基因组会有约 40% 的等位落在 0.5 ± 0.3 之外 ⇒ 探针必红。
  const mother = motherOf();
  mother.genes.hue = [0.5, 0.5];
  const r = rng();
  let alleles = 0;
  for (let i = 0; i < 200; i++) {
    for (const e of layEggs(mother, r, LAY)) {
      for (const a of e.genes.hue) {
        alleles += 1;
        assert.ok(Math.abs(a - 0.5) <= 0.3,
          `子代 hue 等位偏离母方纯合值过远: ${a}（疑似有外来基因组混入）`);
      }
    }
  }
  assert.ok(alleles >= 400, `前置条件：样本量不足，只采到 ${alleles} 个等位`);
});
