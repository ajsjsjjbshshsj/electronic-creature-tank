import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';

// 严格模式下对冻结对象赋值会抛错；非严格模式会静默失败。
// 用 assert.throws 强制走严格路径，这样"没冻住"会明确报错而不是悄悄通过。
const expectFrozen = (obj, path) => {
  assert.ok(Object.isFrozen(obj), `${path} 未被冻结`);
  assert.throws(() => { 'use strict'; obj.__probe__ = 1; }, TypeError,
    `${path} 仍可写入属性`);
};

test('CONFIG 顶层被冻结', () => {
  expectFrozen(CONFIG, 'CONFIG');
});

test('CONFIG 的嵌套对象也被冻结（不是一层）', () => {
  expectFrozen(CONFIG.stage, 'CONFIG.stage');
  expectFrozen(CONFIG.needs, 'CONFIG.needs');
  expectFrozen(CONFIG.emotions, 'CONFIG.emotions');
  expectFrozen(CONFIG.colors, 'CONFIG.colors');
  expectFrozen(CONFIG.populationCap, 'CONFIG.populationCap');
  expectFrozen(CONFIG.hueRange, 'CONFIG.hueRange');
});

test('三层嵌套同样被冻结（deepFreeze 递归深度的回归防线）', () => {
  // CONFIG.emotions.eventMagnitude.poked 是第三层。
  // 只递归两层的实现会让这一层保持可写，而它恰恰是调"手感"时最常改的地方。
  expectFrozen(CONFIG.emotions.eventMagnitude, 'CONFIG.emotions.eventMagnitude');
  expectFrozen(CONFIG.emotions.eventMagnitude.poked, 'CONFIG.emotions.eventMagnitude.poked');
  assert.throws(() => { 'use strict'; CONFIG.emotions.eventMagnitude.poked.joy = 99; }, TypeError);
});

test('数组型配置被冻结', () => {
  expectFrozen(CONFIG.timeScales, 'CONFIG.timeScales');
  expectFrozen(CONFIG.eggsPerClutch, 'CONFIG.eggsPerClutch');
});

// ---- 以下钉住 spec §11 的默认值 ----
// 改动其中任何一个，都必须同时改 spec 与依赖它的测试；
// 让失败发生在这里，而不是在十个 Task 之外以莫名其妙的方式发生。

test('阶段时长之和就是寿命（1140 秒 = 19 分钟）', () => {
  const s = CONFIG.stage;
  assert.equal(s.egg, 60);
  assert.equal(s.hatchling, 180);
  assert.equal(s.juvenile, 300);
  assert.equal(s.adult, 480);
  assert.equal(s.elder, 180);
  assert.equal(s.hatchling + s.juvenile + s.adult + s.elder, 1140,
    '孵化后的四段之和决定寿命；Task 7 的阶段边界与死亡测试都依赖这个数');
});

test('种群上限：桌面 24 / 手机 16', () => {
  assert.equal(CONFIG.populationCap.desktop, 24);
  assert.equal(CONFIG.populationCap.mobile, 16);
  assert.equal(CONFIG.initialCreatures, 4);
});

test('色相区间是粉色：315° 到 25°（跨 0°）', () => {
  assert.deepEqual([...CONFIG.hueRange], [315, 25]);
});

test('体型区间 14–38', () => {
  assert.equal(CONFIG.minSize, 14);
  assert.equal(CONFIG.maxSize, 38);
});

test('固定步长与累加上限', () => {
  assert.ok(Math.abs(CONFIG.fixedDt - 1 / 60) < 1e-12);
  assert.equal(CONFIG.dtAccumCap, 0.25);
  assert.deepEqual([...CONFIG.timeScales], [0.5, 1, 2, 4]);
});

test('近亲回避阈值 0.25，求偶范围 0.22，拒绝好感惩罚 -0.15', () => {
  assert.equal(CONFIG.kinshipMateMax, 0.25);
  assert.equal(CONFIG.courtshipRange, 0.22);
  assert.equal(CONFIG.rejectionAffection, -0.15);
  assert.equal(CONFIG.courtship.min, 8);
  assert.equal(CONFIG.courtship.max, 12);
  assert.deepEqual([...CONFIG.eggsPerClutch], [1, 3]);
});

test('记忆容量 12，三条衰减率齐备', () => {
  assert.equal(CONFIG.memoryCapacity, 12);
  assert.equal(CONFIG.affectionDecay, 0.02);
  assert.equal(CONFIG.affectionDecayKin, 0.002);
  assert.equal(CONFIG.familiarityDecay, 0.004);
  assert.ok(CONFIG.affectionDecayKin < CONFIG.affectionDecay,
    '亲属的淡忘必须比普通关系慢，否则"近乎不忘"不成立');
});

test('情绪惯性与八个事件冲击都在', () => {
  assert.equal(CONFIG.emotions.inertia, 1.6);
  const kinds = Object.keys(CONFIG.emotions.eventMagnitude).sort();
  assert.deepEqual(kinds,
    ['bumped', 'death', 'fed', 'mated', 'petted', 'poked', 'rejected', 'startled']);
});

test('需求速率齐备，且休息是唯一的负值（恢复）', () => {
  const n = CONFIG.needs;
  for (const k of ['hungerRate', 'energyRateActive', 'energyRateIdle', 'socialRate',
    'safetyRecover', 'feedAmount', 'startleAmount', 'socialRelief']) {
    assert.equal(typeof n[k], 'number', `缺少 needs.${k}`);
    assert.ok(Number.isFinite(n[k]), `needs.${k} 非有限数`);
  }
  assert.ok(n.energyRateRest < 0, 'energyRateRest 必须是负数 —— 它是恢复而非消耗');
  assert.ok(n.energyRateActive > n.energyRateIdle, '移动应比静止更耗能');
  assert.ok(n.socialRelief > 0 && n.socialRelief < 1, 'socialRelief 是比例，应在 (0,1)');
});

test('感知半径大于网格边长（否则跨格邻居会漏）', () => {
  assert.ok(CONFIG.perceiveRadius > CONFIG.gridCell,
    `perceiveRadius ${CONFIG.perceiveRadius} 必须大于 gridCell ${CONFIG.gridCell}`);
});

test('package.json 不含任何依赖（零依赖约束）', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module', '必须是 ESM');
  assert.equal(pkg.dependencies, undefined, '不得有 dependencies');
  assert.equal(pkg.devDependencies, undefined, '不得有 devDependencies');
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['simulate', 'test']);
});
