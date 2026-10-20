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
    'CONFIG.behavior', 'CONFIG.eggTint', 'CONFIG.particles',   // 抽查时代漏掉的三个
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
  // 2026-10-14 由 4 调到 8（控制方裁定）。4 只创始个体下约 60% 的缸在一小时内整批灭绝，
  // 机制是**血统坍缩**而非繁殖率不够：4 只创始 → 平均只有 7.00 位不同母亲 →
  // 全缸变成单一亲缘组 → `kinship > 0.25` 的严格近亲回避把每一对都挡掉 → 出生冻结。
  // 实测存活门槛是"母亲数 ≥ 10 全活、≤ 7 全灭"。
  // 扫创始个体数（8 种子 × 60 分钟）：4→灭绝 5/8（母亲 7.00）、8→3/8（10.13）、12→2/8（13.13），
  // 单调且恰好在门槛处转折。取 8 不取 12：12 只一开缸就占掉上限 24 的一半，
  // 挤掉"看得见长大"的余量，而它也没做到 0/8。详见 src/config.js 的注释。
  // ⚠️ 灭绝被裁定为**合法结局**（玩家开新缸），不是 bug：spec §9.2 的六条验收依据里
  // 本来就没有"种群自我延续"。别把这条断言当成"缸必须永不灭绝"来"修"。
  assert.equal(CONFIG.initialCreatures, 8);
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

test('孤雌繁殖常量齐备（求偶三常量已随 spec §4.12 删除）', () => {
  assert.deepEqual([...CONFIG.eggsPerClutch], [1, 3]);
  assert.equal(CONFIG.eggSize.min, 0.6);
  assert.equal(CONFIG.eggSize.max, 1.4);
  // 这条是裁定的钉子：控制方 2026-10-20 **不追认**蛋大小影响成年体型。
  // 没有它，将来有人觉得"大蛋就该长成大的"顺手调成 0.3，全库不会有任何测试变红。
  assert.equal(CONFIG.eggSize.bias, 0, 'EGG_SIZE_BIAS 必须是 0（裁定）');
  assert.equal(CONFIG.drift.interval, 240, '漂入是孤雌下多样性的唯一补给阀门');
  assert.equal(CONFIG.drift.form, 'egg');
  // 反向确认：删掉的必须真的没了。留着"看起来还在其实没人读"的常量，
  // 比删掉更糟 —— 调它不会有任何效果，而这正是"改了配置却没生效"那一类。
  assert.equal(CONFIG.kinshipMateMax, undefined, '近亲闸门常量必须已删除');
  assert.equal(CONFIG.courtship, undefined, '求偶时长区间必须已删除');
  assert.equal(CONFIG.rejectionAffection, undefined, '拒绝好感惩罚必须已删除');
});

test('记忆容量 12，三条衰减率齐备', () => {
  assert.equal(CONFIG.memoryCapacity, 12);
  assert.equal(CONFIG.affectionDecay, 0.02);
  assert.equal(CONFIG.affectionDecayKin, 0.002);
  assert.equal(CONFIG.familiarityDecay, 0.004);
  assert.ok(CONFIG.affectionDecayKin < CONFIG.affectionDecay,
    '亲属的淡忘必须比普通关系慢，否则"近乎不忘"不成立');
});

test('情绪惯性与八个事件冲击都在（mated→laid，rejected 随求偶制删除，ignored 随升级链新增）', () => {
  assert.equal(CONFIG.emotions.inertia, 1.6);
  const kinds = Object.keys(CONFIG.emotions.eventMagnitude).sort();
  assert.deepEqual(kinds,
    ['bumped', 'death', 'fed', 'ignored', 'laid', 'petted', 'poked', 'startled']);
  // 'rejected' 曾经的生产者只有一处：求偶被拒。孤雌下那个场景不存在了，
  // 所以整个事件种类删掉 —— 留一个永远不会被 applyEvent 到的种类，
  // 就是 Task 9 复查抓过的"无生产者的字段"。
  assert.ok(!('rejected' in CONFIG.emotions.eventMagnitude));
  // 'ignored' 的生产者恰好相反，它**有**：sim.tickCreature 在跨过第二级
  // （begIgnored ≥ begEscalate.protestAfter）的那一刻发一次，由
  // tests/sim.test.js 的"发一次 ignored 冲击，而且只发一次"钉住。
  assert.ok('ignored' in CONFIG.emotions.eventMagnitude);
});

test('求关注升级链的两个秒数与两个加成都在，且第二级 = 第一级 + 5 秒', () => {
  // 计划 A4 的陷阱条：升级链的强度必须从 begUrgency 推导，不能各写一个魔法数。
  // 这里把四个旋钮钉成字面量，behavior.test.js 再把"加成 = hopBonus × begUrgency"钉住 ——
  // 于是调 begUrgency 会让**两处同时变红**，两个常数就没法悄悄分家。
  const e = CONFIG.behavior.begEscalate;
  assert.equal(e.hopAfter, 3, 'spec §4.10：beg 了 3 秒没被理睬 → 升一级');
  assert.equal(e.protestAfter, 8, 'spec §4.10：再 5 秒仍没被理睬 → 再升一级（3 + 5 = 8）');
  assert.equal(e.protestAfter - e.hopAfter, 5, '两级之间必须正好是"再 5 秒"');
  assert.equal(e.hopBonus, 0.25);
  assert.equal(e.protestFloor, 0.25);
  // 加成写成 7.0 的分数，两端取值必须是二进制精确的 —— 否则测试里的字面量断言
  // 会像 personality 那组一样带上浮点尾巴（0.3 × 7 = 2.1000000000000005）。
  assert.equal(e.hopBonus * CONFIG.behavior.begUrgency, 1.75);
  assert.equal(e.protestFloor * CONFIG.behavior.begUrgency, 1.75);
  assert.ok(CONFIG.emotions.eventMagnitude.ignored, '第二级要有情绪冲击才读得出来');
  assert.deepEqual(CONFIG.emotions.eventMagnitude.ignored, { anger: 0.25, joy: -0.2 });
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
