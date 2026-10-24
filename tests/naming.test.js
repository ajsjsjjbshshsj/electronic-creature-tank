import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dedupeNames, createWorld, tickWorld } from '../src/sim.js';
import { hatch, layEggs } from '../src/breeding.js';
import { createRng } from '../src/rng.js';
import { CONFIG } from '../src/config.js';

// ---------------------------------------------------------------- 名字的唯一性
//
// 计划 3 Task 6。两条相关的事实：
//   · breeding.js 的 hatch 原本恒传 `nameFor(egg.genes, 0)` ⇒ **同一窝全叫同一个名**。
//     改名功能上线之后，玩家会以为是自己改砸了；而 §9.2 第 2 条（能看出两只之间的关系）
//     与第 3 条（看得出孩子像谁）都要求"叫得出名字"。
//   · creature.js 的 customName 字段自 B1 起就有定义、**全仓零生产者零消费者**。
//     Task 5 给了生产者（改名），这一轮给它一个消费者：自动去重**不许**动玩家取的名。

const mkCreature = (o = {}) => ({
  id: o.id, name: o.name, customName: !!o.customName,
  lineage: { mother: o.mother ?? null, father: null, mates: [], offspring: o.offspring ?? [] },
  alive: true, stage: 'adult', pos: { x: 0.5, y: 0.5 }, age: 2000,
  genes: { size: [[0.5, 0.5]] }, traits: { size: 26, eggTint: 'macaron-pink', personality: {} },
});

// 真基因：从一缸真世界里借一只成体的，省得手搓漏位点。
// （第一版手搓了 `genes: { size: [[0.4,0.6]] }`，hatch 里 genes.decode 一碰缺的位点就
//   TypeError —— 症状看起来像"hatch 被改坏了"，其实是 fixture 不像话。用真卵就没这个问题。）
let REAL_MOTHER = null;
function realMother() {
  // 直接借一缸真世界里的**整只**个体当母亲（连 traits.personality 一起），
  // 而不是只借 genes：hatch 与 layEggs 会读 personality 上的位点（broody 等），
  // 手搓一个半套的 traits 得到的 TypeError 看起来像"被测代码坏了"，其实是 fixture 不像话。
  if (!REAL_MOTHER) REAL_MOTHER = createWorld({ seed: 4242, populationCap: 24 }).creatures[0];
  const m = REAL_MOTHER;
  return { ...m, id: 'm1', pos: { x: 0.5, y: 0.85 } };
}
const eggOf = (mother, i) => layEggs(mother, createRng(1000 + i), {})[0];

test('hatch 用传进去的 nameIndex：同窝不同名靠的是它，不是恒 0', () => {
  const mother = realMother();
  const names = [];
  const nameFor = (genes, index) => `泡泡·${index + 1}`;
  for (let i = 0; i < 3; i++) {
    const baby = hatch(eggOf(mother, i), createRng(7), { nameFor, generation: 2, nameIndex: i });
    names.push(baby.name);
  }
  assert.deepEqual(names, ['泡泡·1', '泡泡·2', '泡泡·3']);
});

test('不传 nameIndex 时退回 0（旧调用点与旧存档不许炸）', () => {
  const baby = hatch(eggOf(realMother(), 0), createRng(7), { nameFor: (g, i) => `N${i}`, generation: 1 });
  assert.equal(baby.name, 'N0');
});

test('dedupeNames：重复的自动名都被改，玩家取的名一个都不动', () => {
  const world = { creatures: [
    mkCreature({ id: 'a', name: '泡泡' }),
    mkCreature({ id: 'b', name: '泡泡' }),
    mkCreature({ id: 'c', name: '泡泡', customName: true }),
  ] };
  const changed = dedupeNames(world);
  // 两只自动名**都**要让路：customName 的那只把"泡泡"这个名字占了。
  assert.equal(changed, 2, '少改了一只 = 缸里还剩两个自动叫泡泡的');
  assert.equal(world.creatures[2].name, '泡泡', '玩家取的名被自动逻辑改了');
  assert.notEqual(world.creatures[0].name, '泡泡');
  assert.notEqual(world.creatures[1].name, '泡泡');
  assert.match(world.creatures[0].name, /^泡泡·\d+$/);
  assert.equal(new Set(world.creatures.map((c) => c.name)).size, 3);
});

test('dedupeNames 认得已有的 ·N 后缀：换号而不是叠成 泡泡·2·2', () => {
  const world = { creatures: [
    mkCreature({ id: 'a', name: '团团' }),
    mkCreature({ id: 'b', name: '团团' }),
    mkCreature({ id: 'c', name: '团团·2' }),
  ] };
  dedupeNames(world);
  const names = world.creatures.map((c) => c.name);
  assert.equal(new Set(names).size, 3, names.join(','));
  assert.ok(!names.some((n) => /·\d+·\d+/.test(n)), `后缀叠起来了：${names.join(',')}`);
});

test('dedupeNames 幂等：再跑一次什么都不改', () => {
  const world = { creatures: [
    mkCreature({ id: 'a', name: '软软' }), mkCreature({ id: 'b', name: '软软' }),
  ] };
  dedupeNames(world);
  const snapshot = world.creatures.map((c) => c.name).join(',');
  assert.equal(dedupeNames(world), 0, '第二趟还在改名 = 每出生一只就全体抖一次名字');
  assert.equal(world.creatures.map((c) => c.name).join(','), snapshot);
});

test('dedupeNames 不碰没有名字的个体，也不碰空 world', () => {
  for (const world of [{ creatures: [] }, { creatures: [null, { id: 'x' }] }, {}]) {
    assert.equal(dedupeNames(world), 0);
  }
});

test('真出生路径：跑一段之后缸里不许有两个同名', () => {
  // 端到端的一条：走 createWorld + 正常 tick（里面就有 layEggs 与孵化），不是手搓名字。
  // 判据只有一条 —— 玩家打开两只个体的信息卡，"名字"那一行不许一模一样。
  const world = createWorld({ seed: 20261023, populationCap: 24 });
  for (let i = 0; i < 60 * 60 * 12; i++) tickWorld(world, CONFIG.fixedDt);
  const names = world.creatures.map((c) => c.name).filter(Boolean);
  assert.ok(names.length >= 8, `这一缸连名字都没有几只？${names.length}`);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.equal(dupes.length, 0, `重名了：${[...new Set(dupes)].join(',')}`);
});

// ---------------------------------------------------------------- 出生即去重
//
// dedupeNames 由谁调用也要钉住：一个没人调的纯函数与"没修"是同一件事
// （save.js 在 C-1 之前的状态就是活例子）。

test('孵化那一段真的调了 dedupeNames（不是只写了个函数放着）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/sim.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  assert.match(src, /dedupeNames\(/, 'sim.js 里只有定义没有调用');
});
