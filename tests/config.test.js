import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';

// 本文件是 ES module，而 ESM 一律运行在严格模式下 —— 对冻结对象赋值本来就会抛
// TypeError。所以这里不需要写 'use strict'：模块顶层那条指令是空操作，删掉它行为
// 完全不变。此前注释声称"要靠 'use strict' 才能把静默失败变成抛错"，那是错的
// （在非模块的 sloppy-mode 脚本里才成立），已一并更正。
const expectFrozen = (obj, path) => {
  assert.ok(Object.isFrozen(obj), `${path} 未被冻结`);
  assert.throws(() => { obj.__probe__ = 1; }, TypeError, `${path} 仍可写入属性`);
};

test('deepFreeze 递归到 CONFIG 的每一个对象与数组节点', () => {
  // 原先的逐点抽查只碰到了 21 个节点里的 10 个：CONFIG.behavior、CONFIG.courtship、
  // CONFIG.particles 从来没被检查过 —— 一个恰好漏掉这些子树的 deepFreeze 回归，
  // 能让整套测试保持全绿。所以这里改成整棵树递归，逐节点断言 Object.isFrozen，
  // 并在失败时报出具体路径（如 CONFIG.emotions.eventMagnitude.poked），而不是只说"有东西没冻住"。
  //
  // 这一条取代了之前的「顶层被冻结」「嵌套对象也被冻结」「数组型配置被冻结」三条：
  // 它检查的节点是那三条的严格超集。（那三条里的写入探针与它们自己的 isFrozen
  // 断言在同一对象上重复 —— 冻结对象在严格模式下加属性必抛 —— 所以合并后没有丢覆盖面。）
  const unfrozen = [];
  const visited = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;   // 原始值无需冻结
    visited.push(path);
    if (!Object.isFrozen(node)) unfrozen.push(path);
    for (const key of Object.keys(node)) walk(node[key], `${path}.${key}`);
  };
  walk(CONFIG, 'CONFIG');

  assert.deepEqual(unfrozen, [], 'deepFreeze 漏掉了下列节点');

  // 防空转：遍历自身写错（一个节点都没走到）时，上面的 deepEqual 会空着通过。
  // 用节点数下限 + 关键路径点名，把"确实走遍了整棵树"钉住。
  // 21 是当前 CONFIG 的全部对象/数组节点数；后续 Task 往 CONFIG 里加东西只会让它变大，
  // 所以这里用 >= 而不是 ==，免得每次加常量都要回来改测试。
  assert.ok(visited.length >= 21, `只遍历到 ${visited.length} 个节点，少于已知的 21 个`);
  for (const path of [
    'CONFIG',
    'CONFIG.behavior', 'CONFIG.courtship', 'CONFIG.particles',   // 抽查时代漏掉的三个
    'CONFIG.emotions.eventMagnitude.poked',                       // 第三层
    'CONFIG.timeScales', 'CONFIG.hueRange', 'CONFIG.eggsPerClutch', // 数组节点
  ]) {
    assert.ok(visited.includes(path), `遍历没有到达 ${path}`);
  }
});

test('三层嵌套写入必须抛错（deepFreeze 递归深度的回归防线）', () => {
  // CONFIG.emotions.eventMagnitude.poked 是第三层。
  // 只递归两层的实现会让这一层保持可写，而它恰恰是调"手感"时最常改的地方。
  expectFrozen(CONFIG.emotions.eventMagnitude, 'CONFIG.emotions.eventMagnitude');
  expectFrozen(CONFIG.emotions.eventMagnitude.poked, 'CONFIG.emotions.eventMagnitude.poked');
  assert.throws(() => { CONFIG.emotions.eventMagnitude.poked.joy = 99; }, TypeError);
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
  // 逐个字段断言 undefined 是漏的：peerDependencies、optionalDependencies，
  // 乃至任何一个不在白名单里的键，都能从"dependencies/devDependencies 为空"旁边溜过去。
  // 而这条约束管着全部十一个 Task，这里是它唯一的自动化守卫 —— 所以改成整体键集比对，
  // 一次性堵掉所有入口：多一个键就红，不管那个键叫什么。
  assert.deepEqual(Object.keys(pkg).sort(), ['name', 'private', 'scripts', 'type'],
    'package.json 只允许这四个键 —— 任何依赖字段都违反零依赖约束');
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['simulate', 'test']);
});
