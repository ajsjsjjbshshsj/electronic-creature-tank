import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import {
  PLAYER_ID, ROLES, KINSHIP,
  createMemory, get, ensure, adjust, affectionFor, familiarityFor,
  decay, prune, kinshipBetween, remember,
} from '../src/memory.js';

// ============================================================================
// 第 1 部分：brief 逐字规定的用例。
// ============================================================================

test('PLAYER_ID 与角色表符合 spec 4.8', () => {
  assert.equal(PLAYER_ID, 'PLAYER');
  assert.deepEqual(ROLES, ['mother', 'father', 'sibling', 'mate', 'offspring']);
});

test('亲缘系数：父母/同胞/子代 0.5，祖孙 0.25，伴侣 0', () => {
  assert.equal(KINSHIP.mother, 0.5);
  assert.equal(KINSHIP.father, 0.5);
  assert.equal(KINSHIP.sibling, 0.5);
  assert.equal(KINSHIP.offspring, 0.5);
  assert.equal(KINSHIP.grandparent, 0.25);
  assert.equal(KINSHIP.grandchild, 0.25);
  assert.equal(KINSHIP.halfSibling, 0.25);
  assert.equal(KINSHIP.mate, 0, '配偶无血缘，近亲回避不得因配偶关系误判');
});

test('createMemory 是空的', () => {
  assert.deepEqual(createMemory(), { entries: [] });
});

test('get 对不存在的 id 返回 null', () => {
  assert.equal(get(createMemory(), 'nobody'), null);
});

test('ensure 创建记录并带上 kinship / role', () => {
  const m = createMemory();
  const e = ensure(m, 'c2', { kinship: 0.5, role: 'sibling' });
  assert.equal(e.id, 'c2');
  assert.equal(e.kinship, 0.5);
  assert.equal(e.role, 'sibling');
  assert.equal(e.affection, 0);
  assert.equal(e.familiarity, 0);
  assert.equal(m.entries.length, 1);
});

test('ensure 对同一 id 幂等（不重复创建）', () => {
  const m = createMemory();
  const a = ensure(m, 'c2');
  const b = ensure(m, 'c2');
  assert.equal(a, b, '应返回同一个对象');
  assert.equal(m.entries.length, 1);
});

test('ensure 不会覆盖已有的 kinship / role', () => {
  const m = createMemory();
  ensure(m, 'c2', { kinship: 0.5, role: 'sibling' });
  const e = ensure(m, 'c2');
  assert.equal(e.role, 'sibling', '第二次 ensure 不应把 role 清空');
  assert.equal(e.kinship, 0.5);
});

test('adjust 累积好感并 clamp 到 [-1,1]', () => {
  const m = createMemory();
  adjust(m, 'c2', 0.3);
  assert.ok(Math.abs(affectionFor(m, 'c2') - 0.3) < 1e-9);
  for (let i = 0; i < 20; i++) adjust(m, 'c2', 0.3);
  assert.equal(affectionFor(m, 'c2'), 1);
  for (let i = 0; i < 40; i++) adjust(m, 'c2', -0.3);
  assert.equal(affectionFor(m, 'c2'), -1);
});

test('adjust 默认也提升 familiarity', () => {
  const m = createMemory();
  adjust(m, 'c2', 0.1);
  assert.ok(familiarityFor(m, 'c2') > 0);
});

test('adjust 可以只改好感不改熟悉度', () => {
  const m = createMemory();
  adjust(m, 'c2', 0.1, 0);
  assert.equal(familiarityFor(m, 'c2'), 0);
});

test('adjust 返回被修改的那条记录', () => {
  const m = createMemory();
  const e = adjust(m, 'c2', 0.1);
  assert.equal(e, get(m, 'c2'));
});

test('affectionFor / familiarityFor / kinshipBetween 对无记录返回 0 而非 undefined', () => {
  const m = createMemory();
  assert.equal(affectionFor(m, 'ghost'), 0);
  assert.equal(familiarityFor(m, 'ghost'), 0);
  assert.equal(kinshipBetween(m, 'ghost'), 0);
});

test('decay 使好感指数衰减趋向 0（会淡忘）', () => {
  const m = createMemory();
  adjust(m, 'c2', 0.9, 1);
  const before = affectionFor(m, 'c2');
  for (let i = 0; i < 600; i++) decay(m, 1 / 60);       // 10 秒
  const after = affectionFor(m, 'c2');
  assert.ok(after < before && after > 0, `${before} → ${after}`);
});

test('亲属与伴侣的衰减显著慢于普通关系（近乎不忘，spec 4.8）', () => {
  const kin = createMemory();
  const plain = createMemory();
  // 顺序很重要：ensure 必须先于 adjust。
  // ensure 对已存在的记录不会覆盖 kinship/role（那是"它是它妈妈"这类
  // 一旦确立就不该再变的事实），所以先 adjust 再 ensure 会让 role 永远是 null。
  ensure(kin, 'mom', { role: 'mother', kinship: 0.5 });
  adjust(kin, 'mom', 0.9, 1);
  adjust(plain, 'stranger', 0.9, 1);
  for (let i = 0; i < 60 * 60; i++) { decay(kin, 1 / 60); decay(plain, 1 / 60); }
  assert.ok(
    Math.abs(affectionFor(kin, 'mom')) > Math.abs(affectionFor(plain, 'stranger')) * 2,
    `亲属 ${affectionFor(kin, 'mom')} vs 普通 ${affectionFor(plain, 'stranger')}`,
  );
});

test('kinship >= 0.25 的无角色关系也享受慢衰减', () => {
  const m = createMemory();
  ensure(m, 'cousin', { kinship: 0.25 });   // 先建立关系，再改数值
  adjust(m, 'cousin', 0.9, 1);
  const plain = createMemory();
  adjust(plain, 'x', 0.9, 1);
  for (let i = 0; i < 60 * 60; i++) { decay(m, 1 / 60); decay(plain, 1 / 60); }
  assert.ok(Math.abs(affectionFor(m, 'cousin')) > Math.abs(affectionFor(plain, 'x')));
});

test('decay 不改变符号（好感不会从正翻负）', () => {
  const m = createMemory();
  adjust(m, 'c2', 0.8, 1);
  adjust(m, 'c3', -0.8, 1);
  for (let i = 0; i < 600; i++) decay(m, 1 / 60);
  assert.ok(affectionFor(m, 'c2') > 0);
  assert.ok(affectionFor(m, 'c3') < 0);
});

test('decay 与时间步长严格无关（指数衰减的数学性质）', () => {
  const a = createMemory();
  const b = createMemory();
  adjust(a, 'c2', 0.9, 1);
  adjust(b, 'c2', 0.9, 1);
  for (let i = 0; i < 60; i++) decay(a, 1 / 60);
  decay(b, 1);
  assert.ok(Math.abs(affectionFor(a, 'c2') - affectionFor(b, 'c2')) < 1e-9);
  assert.ok(Math.abs(familiarityFor(a, 'c2') - familiarityFor(b, 'c2')) < 1e-9);
});

test('容量上限 12：超出时淘汰 familiarity 最低的（spec 4.8）', () => {
  const m = createMemory();
  for (let i = 0; i < CONFIG.memoryCapacity; i++) {
    ensure(m, `c${i}`);
    get(m, `c${i}`).familiarity = (i + 1) / 100;
  }
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
  ensure(m, 'c99');                                     // 第 13 条
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
  assert.equal(get(m, 'c0'), null, 'c0 的 familiarity 最低，应被淘汰');
  assert.ok(get(m, 'c99'), '新记录应留下');
  assert.ok(get(m, `c${CONFIG.memoryCapacity - 1}`), 'familiarity 最高的应留下');
});

test('prune 单独调用也生效', () => {
  const m = createMemory();
  for (let i = 0; i < 20; i++) {
    ensure(m, `c${i}`);
    get(m, `c${i}`).familiarity = i / 100;
  }
  prune(m);
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
  assert.equal(get(m, 'c0'), null);
  assert.ok(get(m, 'c19'));
});

test('prune 保留 familiarity 最高的那些（无序输入也正确）', () => {
  const m = createMemory();
  const fams = [0.5, 0.1, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.05, 0.95, 0.35, 0.55];
  fams.forEach((f, i) => { ensure(m, `c${i}`); get(m, `c${i}`).familiarity = f; });
  ensure(m, 'extra');
  get(m, 'extra').familiarity = 0.99;
  prune(m);
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
  const kept = m.entries.map((e) => e.id);
  assert.ok(kept.includes('extra'));
  assert.ok(!kept.includes('c9'), 'familiarity 0.05 应被淘汰');
  assert.ok(!kept.includes('c1'), 'familiarity 0.1 应被淘汰');
});

test('kinshipBetween 返回记录中的亲缘系数', () => {
  const m = createMemory();
  ensure(m, 'mom', { kinship: 0.5, role: 'mother' });
  assert.equal(kinshipBetween(m, 'mom'), 0.5);
});

test('remember 可批量写入且同 id 覆盖（存档恢复用）', () => {
  const m = createMemory();
  remember(m, { id: 'c1', familiarity: 0.5, affection: 0.2, kinship: 0, role: null });
  remember(m, { id: 'c1', familiarity: 0.8, affection: 0.4, kinship: 0, role: 'mate' });
  assert.equal(m.entries.length, 1);
  assert.equal(affectionFor(m, 'c1'), 0.4, '同 id 应覆盖');
  assert.equal(get(m, 'c1').role, 'mate');
  assert.equal(get(m, 'c1').familiarity, 0.8);
});

test('remember 也遵守容量上限', () => {
  const m = createMemory();
  for (let i = 0; i < CONFIG.memoryCapacity + 5; i++) {
    remember(m, { id: `c${i}`, familiarity: i / 100, affection: 0, kinship: 0, role: null });
  }
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
});

test('对 PLAYER 的记忆与对个体的记忆结构完全一致（spec 4.8）', () => {
  const m = createMemory();
  adjust(m, PLAYER_ID, 0.4);
  const e = get(m, PLAYER_ID);
  assert.equal(e.id, PLAYER_ID);
  assert.deepEqual(
    Object.keys(e).sort(),
    ['affection', 'familiarity', 'id', 'kinship', 'role'],
  );
  assert.ok(affectionFor(m, PLAYER_ID) > 0, '玩家好感可累积 —— 跨设备"它还认得你"的基础');
});

test('记忆条目不共享引用（remember 应拷贝而非持有外部对象）', () => {
  const m = createMemory();
  const src = { id: 'c1', familiarity: 0.5, affection: 0.2, kinship: 0, role: null };
  remember(m, src);
  src.affection = 0.99;
  assert.equal(affectionFor(m, 'c1'), 0.2, '外部对象被改不应影响记忆');
});

// ============================================================================
// 第 2 部分：brief 之外补的不变量。每条都对应一个**静默失败**的形状 ——
// 出错时不会抛异常，只会让后面的 Task 拿到错误的数，所以必须由测试钉住。
// ============================================================================

test('ROLES 与 KINSHIP 被冻结，且冻结这件事本身被钉住', () => {
  // 纪律来自 Task 2 复查：src/genes.js 的 PATTERNS 曾被别处 .reverse() 静默重排，
  // 而重排会让整缸生物的花纹错位、且没有任何一处报错。
  //
  // 关键点：**摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（deepEqual
  // 比的是内容与原型，不是可变性）。所以冻结必须被单独断言。
  //
  // 本模块的两个导出常量都会被 Task 8（近亲回避）与 Task 9（卖萌触发）import：
  //   ROLES.sort()   → 角色表顺序被改（无害但说明有人在改共享常量）
  //   KINSHIP.mate = 0.5 → 配偶被判成近亲 → 繁殖过的两只从此绝不再求偶，
  //                        种群静默绝育，没有任何一处抛错。
  // KINSHIP 是对象、ROLES 是数组，可写探针不同：
  // 对象上 obj.push?.() 会**静默不抛**（可选调用短路成 undefined），
  // 于是 assert.throws 反而报"缺少预期异常"。所以分开测。
  assert.ok(Object.isFrozen(ROLES), 'ROLES 应被冻结');
  assert.throws(() => ROLES.push('__probe__'), TypeError, 'ROLES.push 应抛 TypeError');
  assert.throws(() => ROLES.reverse(), TypeError, 'ROLES.reverse 应抛 TypeError');
  assert.throws(() => { ROLES[0] = '__probe__'; }, TypeError, 'ROLES[0] 赋值应抛 TypeError');
  assert.deepEqual(ROLES, ['mother', 'father', 'sibling', 'mate', 'offspring'],
    '写入探针之后 ROLES 的内容与顺序都不得改变');

  assert.ok(Object.isFrozen(KINSHIP), 'KINSHIP 应被冻结');
  assert.throws(() => { KINSHIP.mate = 0.5; }, TypeError, 'KINSHIP.mate 必须不可写');
  assert.throws(() => { KINSHIP.grandparent = 0.9; }, TypeError, 'KINSHIP.grandparent 必须不可写');
  assert.throws(() => { KINSHIP.__probe__ = 1; }, TypeError, 'KINSHIP 加新键应抛 TypeError');
  assert.throws(() => { delete KINSHIP.mother; }, TypeError, 'KINSHIP 删键应抛 TypeError');
  assert.equal(KINSHIP.mate, 0, '写入探针之后 mate 仍应是 0');
  assert.equal(KINSHIP.grandparent, 0.25, '写入探针之后 grandparent 仍应是 0.25');

  // 反向确认：冻结只挡写，不挡读与展开（否则 Task 8 / Task 9 会跟着坏）
  assert.equal(typeof [...ROLES].sort().join(','), 'string', 'ROLES 仍应可展开');
  assert.equal(typeof Object.keys(KINSHIP).join(','), 'string', 'KINSHIP 仍应可枚举');
});

test('KINSHIP 的键集恰好是 spec 4.8 / 4.12 的八个，无多余项', () => {
  // 多一个键不会让上面那条逐系数断言变红，却会让 Task 8 的遍历行为改变。
  assert.deepEqual(
    Object.keys(KINSHIP).sort(),
    ['father', 'grandchild', 'grandparent', 'halfSibling', 'mate', 'mother', 'offspring', 'sibling'],
  );
});

test('ROLES 里每个角色都有 KINSHIP 系数（Task 8 会按 role 查表）', () => {
  // 若某个角色缺系数，KINSHIP[role] 是 undefined：
  //   undefined > 0.25 → false → 近亲回避**静默失效**，不抛错。
  // 这正是 requirements 里点名的"unknown key 不得静默 no-op"那一类。
  for (const role of ROLES) {
    assert.ok(Object.hasOwn(KINSHIP, role), `角色 ${role} 缺少 KINSHIP 系数`);
    const k = KINSHIP[role];
    assert.ok(Number.isFinite(k), `${role} 的系数应是有限数，实际 ${k}`);
    assert.ok(k >= 0 && k <= 1, `${role} 的系数应落在 [0,1]，实际 ${k}`);
  }

  // 把危险如实钉住，而不是假装它不存在：KINSHIP 是朴素对象字面量，
  // 原型键在它上面解析成 **truthy 的继承值**，所以 `if (!KINSHIP[role])`
  // 挡不住它们 —— Task 4 的 applyEvent(e, 'toString') 就踩过这个坑。
  // Task 8 查表时必须用 Object.hasOwn，或者先用 ROLES 判成员资格。
  assert.equal(Object.hasOwn(KINSHIP, 'toString'), false, 'toString 不是自有键');
  assert.equal(typeof KINSHIP.toString, 'function', '但它经原型链解析成函数（truthy）');
  assert.ok(KINSHIP['constructor'], 'constructor 同样是 truthy 的继承值');
});

test('三个衰减速率的精确量级被字面量钉住（10 秒、远离任何 clamp）', () => {
  // Task 3 复查发现：没有任何测试约束速率量级，于是速率表整体错 13 倍也能过 CI，
  // energyRateIdle = 0 与 socialRate = 1e-6 同样能过。这里不许重演。
  //
  // 字面量是硬编码的，不从 CONFIG 反算 —— 反算等于把断言写成恒真式。
  // 10 秒窗口下三个值都远离边界（好感 0.9 → 0.737，熟悉度 0.5 → 0.480），
  // 没有任何 clamp 参与，所以断言测的确实是速率本身。
  //
  // 灵敏度（已实算）：若三个速率同时错 13 倍，普通好感会变成 0.066846220（13×）
  // 或 0.886259811（1/13×），与钉住的 0.736857678 相差巨大，当场变红。
  const m = createMemory();
  adjust(m, 'plain', 0.9, 0.5);
  ensure(m, 'kin', { role: 'mother', kinship: KINSHIP.mother });
  adjust(m, 'kin', 0.9, 0.5);
  for (let i = 0; i < 600; i++) decay(m, 1 / 60);          // 恰好 10 秒

  assert.ok(Math.abs(affectionFor(m, 'plain') - 0.736857677770184) < 1e-9,
    `affectionDecay=0.02 下 0.9 经 10 秒应为 0.736857677770184，实际 ${affectionFor(m, 'plain')}`);
  assert.ok(Math.abs(affectionFor(m, 'kin') - 0.882178805976080) < 1e-9,
    `affectionDecayKin=0.002 下 0.9 经 10 秒应为 0.882178805976080，实际 ${affectionFor(m, 'kin')}`);
  assert.ok(Math.abs(familiarityFor(m, 'plain') - 0.480394719576162) < 1e-9,
    `familiarityDecay=0.004 下 0.5 经 10 秒应为 0.480394719576162，实际 ${familiarityFor(m, 'plain')}`);
  // CONFIG 里只有**一个** familiarityDecay，没有亲属变体 ——
  // 钉住这一点，否则有人给亲属也放慢熟悉度衰减时不会有任何测试变红。
  assert.ok(Math.abs(familiarityFor(m, 'kin') - 0.480394719576162) < 1e-9,
    '熟悉度衰减与亲缘无关，亲属与普通关系必须一致');
});

test('衰减半衰期：普通好感 34.657 秒、亲属好感 346.57 秒、熟悉度 173.29 秒', () => {
  // 半衰期是"它多久忘掉一件事"的直觉量纲，Task 9（卖萌触发窗口）与
  // Task 11（种群统计）都会拿它当参照。三条独立断言，各自用一份记忆，
  // 时间取 ln2/rate 的浮点值，期望值取起始值的一半。
  const plain = createMemory();
  adjust(plain, 'x', 0.9, 0.5);
  decay(plain, Math.LN2 / 0.02);
  assert.ok(Math.abs(affectionFor(plain, 'x') - 0.45) < 1e-9,
    `普通好感半衰期应为 ln2/0.02 ≈ 34.657359 秒，实际残留 ${affectionFor(plain, 'x')}`);

  const kin = createMemory();
  ensure(kin, 'mom', { role: 'mother', kinship: KINSHIP.mother });
  adjust(kin, 'mom', 0.9, 0.5);
  decay(kin, Math.LN2 / 0.002);
  assert.ok(Math.abs(affectionFor(kin, 'mom') - 0.45) < 1e-9,
    `亲属好感半衰期应为 ln2/0.002 ≈ 346.574 秒（慢 10 倍），实际残留 ${affectionFor(kin, 'mom')}`);

  const fam = createMemory();
  adjust(fam, 'y', 0, 0.5);
  decay(fam, Math.LN2 / 0.004);
  assert.ok(Math.abs(familiarityFor(fam, 'y') - 0.25) < 1e-9,
    `熟悉度半衰期应为 ln2/0.004 ≈ 173.287 秒，实际残留 ${familiarityFor(fam, 'y')}`);
});

test('decay 的步长无关性在长时程、三种步长、严格内部值下都成立', () => {
  // brief 的那条只比了 1 秒（60×1/60 vs 1×1）。这里把时程拉到 30 秒、
  // 步长拉到三种，并且**先断言三条路径的结果都严格落在 (0, 起点) 内部**。
  //
  // 为什么"内部"是硬要求：如果两条路径都被 clamp 到同一个边界值上，
  // 那么比较对**任何**实现都恒真 —— 包括彻底坏掉的实现。Task 3 的步长无关
  // 测试就曾经这样空转过一轮复查才被抓住。本模块的 decay 其实不做 clamp，
  // 这条断言于是成了"确实没有触碰边界"的证明，而不是防护。
  //
  // 探测能力（已实算，30 秒时程）：
  //   真指数形式  —— 三种步长两两之差 ≤ 4.42e-14，容差 1e-9 有约 5 个数量级余量；
  //   线性 (1-rate*dt) —— 最细与最粗之差 9.6006e-4，是容差的 960060 倍，当场变红。
  const HORIZON = 30;                                    // 模拟秒
  const build = () => {
    const m = createMemory();
    adjust(m, 'pos', 0.6, 0.5);
    adjust(m, 'neg', -0.6, 0.5);                         // 负向也要一致，否则 abs() 实现能蒙混
    return m;
  };
  const fine = build(), mid = build(), coarse = build();
  for (let i = 0; i < HORIZON * 60; i++) decay(fine, 1 / 60);
  for (let i = 0; i < HORIZON * 30; i++) decay(mid, 1 / 30);
  for (let i = 0; i < HORIZON * 2; i++) decay(coarse, 0.5);

  for (const [name, m] of [['1/60', fine], ['1/30', mid], ['0.5', coarse]]) {
    for (const id of ['pos', 'neg']) {
      const v = affectionFor(m, id);
      const f = familiarityFor(m, id);
      // 有限性排在范围之前：NaN >= 0 与 NaN <= 1 都是 false，
      // 顺序颠倒会把"非有限数"误报成"越界"，诊断信息就丢了。
      assert.ok(Number.isFinite(v), `${name} / ${id} 好感非有限数: ${v}`);
      assert.ok(Number.isFinite(f), `${name} / ${id} 熟悉度非有限数: ${f}`);
      const mag = Math.abs(v);
      assert.ok(mag > 0 && mag < 0.6, `${name} / ${id} 好感未严格落在内部: ${v}`);
      assert.ok(f > 0 && f < 0.5, `${name} / ${id} 熟悉度未严格落在内部: ${f}`);
    }
  }

  for (const id of ['pos', 'neg']) {
    const a = affectionFor(fine, id), b = affectionFor(mid, id), c = affectionFor(coarse, id);
    assert.ok(Math.abs(a - b) < 1e-9, `${id} 好感 1/60 vs 1/30: ${a} vs ${b}`);
    assert.ok(Math.abs(a - c) < 1e-9, `${id} 好感 1/60 vs 0.5: ${a} vs ${c}`);
    const fa = familiarityFor(fine, id);
    assert.ok(Math.abs(fa - familiarityFor(mid, id)) < 1e-9, `${id} 熟悉度 1/60 vs 1/30`);
    assert.ok(Math.abs(fa - familiarityFor(coarse, id)) < 1e-9, `${id} 熟悉度 1/60 vs 0.5`);
  }
  // 三条路径共同收敛到的闭式解，同样用字面量钉住
  assert.ok(Math.abs(affectionFor(fine, 'pos') - 0.329286981656416) < 1e-9);
  assert.ok(Math.abs(affectionFor(fine, 'neg') + 0.329286981656416) < 1e-9);
  assert.ok(Math.abs(familiarityFor(fine, 'pos') - 0.443460218358579) < 1e-9);
});

test('kinship 阈值两侧都被钉住：恰好 0.25 走慢衰减，0.24 走快衰减', () => {
  // Task 4 复查发现：一个 >= 阈值没有"恰好等于"的用例，于是把它改成 >
  // 之后 38 条测试全绿。这里两侧都用**字面量**钉住，不靠相对比较。
  //
  // 两个方向的探测能力：
  //   >= 改成 >   → 恰好 0.25 那条落到快速率，0.882178806 变 0.736857678，变红；
  //   阈值改成 0.2 → 0.24 那条落到慢速率，0.736857678 变 0.882178806，变红。
  const at = createMemory();
  const below = createMemory();
  const none = createMemory();
  ensure(at, 'c', { kinship: 0.25 });                    // 恰好等于阈值，role 为 null
  ensure(below, 'c', { kinship: 0.24 });                 // 刚好在阈值之下
  adjust(at, 'c', 0.9, 1);
  adjust(below, 'c', 0.9, 1);
  adjust(none, 'c', 0.9, 1);
  for (let i = 0; i < 600; i++) { decay(at, 1 / 60); decay(below, 1 / 60); decay(none, 1 / 60); }

  assert.ok(Math.abs(affectionFor(at, 'c') - 0.882178805976080) < 1e-9,
    `kinship 恰好 0.25 应享受亲属速率，实际 ${affectionFor(at, 'c')}`);
  assert.ok(Math.abs(affectionFor(below, 'c') - 0.736857677770184) < 1e-9,
    `kinship 0.24 应走普通速率，实际 ${affectionFor(below, 'c')}`);
  assert.ok(Math.abs(affectionFor(none, 'c') - 0.736857677770184) < 1e-9,
    `无 kinship 无 role 应走普通速率，实际 ${affectionFor(none, 'c')}`);
  assert.ok(affectionFor(at, 'c') > affectionFor(below, 'c'),
    '阈值两侧的差必须方向正确（亲缘越近忘得越慢）');
});

test('role 为 mate 走慢衰减，但 kinship 仍是 0（Task 8 的近亲回避不得拦住配偶）', () => {
  // 这是本模块最容易写错的一处：spec 4.8 要求"长期伴侣的衰减极慢"，
  // 而 spec 4.12 第 5 条要求"kinship > 0.25 绝不求偶"。
  // 若为了让伴侣不被遗忘就把 KINSHIP.mate 设成 0.5，繁殖过的两只
  // 从此永远不再求偶 —— 种群静默绝育，且没有任何一处抛错。
  // 正确解法是两条通道分开：慢衰减看 role，近亲回避只看 kinship。
  const m = createMemory();
  ensure(m, 'p', { role: 'mate', kinship: KINSHIP.mate });
  adjust(m, 'p', 0.9, 1);
  for (let i = 0; i < 600; i++) decay(m, 1 / 60);        // 10 秒
  assert.ok(Math.abs(affectionFor(m, 'p') - 0.882178805976080) < 1e-9,
    `伴侣应按 affectionDecayKin 衰减，实际 ${affectionFor(m, 'p')}`);
  assert.equal(kinshipBetween(m, 'p'), 0);
  assert.equal(kinshipBetween(m, 'p') > CONFIG.kinshipMateMax, false,
    '配偶不得触发近亲回避');
  // 反向确认：母子确实**会**被近亲回避拦住，否则上面那条 false 毫无意义
  const kin = createMemory();
  ensure(kin, 'mom', { role: 'mother', kinship: KINSHIP.mother });
  assert.equal(kinshipBetween(kin, 'mom') > CONFIG.kinshipMateMax, true,
    '母子必须触发近亲回避');
});

test('prune 的 protectId 参数真的豁免那一条（直接调用，不经 ensure）', () => {
  // brief 的用例只直接调用过 prune(m)，protectId 仅经 ensure 间接演练。
  // 一个把 protectId 形参删掉、只留排序截断的实现，在这条测试下会当场变红。
  //
  // 构造方式：ensure 在第 13 条时才会触发淘汰，所以先用 ensure 建满 12 条，
  // 再直接 push 第 13 条 —— Memory = { entries: [] } 是计划里写明的公开类型，
  // 不是内部实现。第 13 条的 familiarity 刻意给成**全场最低**，
  // 于是"保护它"与"淘汰最低"两件事直接对立，无法蒙混。
  const m = createMemory();
  for (let i = 0; i < CONFIG.memoryCapacity; i++) {
    ensure(m, `c${i}`);
    get(m, `c${i}`).familiarity = (i + 1) / 100;         // c0 = 0.01 最低
  }
  m.entries.push({ id: 'cX', familiarity: 0.005, affection: 0, kinship: 0, role: null });
  assert.equal(m.entries.length, CONFIG.memoryCapacity + 1);

  assert.equal(prune(m, 'cX'), undefined);
  assert.equal(m.entries.length, CONFIG.memoryCapacity);
  assert.ok(get(m, 'cX'), '被 protectId 豁免的那条必须留下，哪怕它 familiarity 最低');
  assert.equal(get(m, 'c0'), null, '未豁免里 familiarity 最低的 c0 应被淘汰');
  assert.ok(get(m, 'c11'), 'familiarity 最高的应留下');

  // 对照组：同样的输入，不传 protectId → 排序截断，淘汰的正是全场最低的 cX。
  const n = createMemory();
  for (let i = 0; i < CONFIG.memoryCapacity; i++) {
    ensure(n, `c${i}`);
    get(n, `c${i}`).familiarity = (i + 1) / 100;
  }
  n.entries.push({ id: 'cX', familiarity: 0.005, affection: 0, kinship: 0, role: null });
  prune(n);
  assert.equal(get(n, 'cX'), null, '不传 protectId 时应淘汰 familiarity 最低的 cX');
  assert.ok(get(n, 'c0'), '此时 c0 应留下');
});

test('记忆满时新建的条目一定留下（哪怕所有旧条目 familiarity 都是 1）', () => {
  // 新记录保护的存在理由，取它最尖锐的形式：旧条目全部 familiarity = 1，
  // 新条目 familiarity = 0，是全场唯一最低。没有保护它就是必被淘汰的那条 ——
  // 于是"第一次见面"会被"记住它"这个动作自己挤掉，它将永远记不住任何新个体。
  const m = createMemory();
  for (let i = 0; i < CONFIG.memoryCapacity; i++) {
    ensure(m, `c${i}`);
    get(m, `c${i}`).familiarity = 1;
  }
  const fresh = ensure(m, 'newcomer');
  assert.equal(fresh.familiarity, 0, '新记录 familiarity 应从 0 起');
  assert.equal(m.entries.length, CONFIG.memoryCapacity, '容量仍应是 12');
  assert.ok(get(m, 'newcomer'), '新记录必须留下');
  // 旧条目应恰好少一条。这里不断言"少的是哪一条"—— 并列时的取舍
  // 不是 spec 规定的行为，钉住它只会让将来无害的重构变红。
  assert.equal(m.entries.filter((e) => e.id !== 'newcomer').length, CONFIG.memoryCapacity - 1);
});

test('mutator 约定：decay / prune / remember 原地改并返回 undefined，只读函数不改入参', () => {
  // src/needs.js 与 src/emotions.js 的模块头都把"哪个入参被原地修改"写成了
  // 承重契约，因为写错的失败方式是静默的（c.memory = decay(...) 会把它变成
  // undefined）。本模块同形状，但有一个**例外**必须一并钉住：
  // ensure / adjust 也原地改，却返回那条记录（调用方常写成 const e = adjust(...)）。
  const m = createMemory();
  ensure(m, 'c', { role: 'mother', kinship: KINSHIP.mother });
  adjust(m, 'c', 0.5, 0.5);
  assert.equal(ensure(m, 'c'), get(m, 'c'), 'ensure 应返回记录本身，而不是 undefined');
  assert.equal(adjust(m, 'c', 0), get(m, 'c'), 'adjust 应返回记录本身，而不是 undefined');

  assert.equal(decay(m, 1 / 60), undefined);
  assert.equal(prune(m), undefined);
  assert.equal(remember(m, { id: 'z', familiarity: 0.1, affection: 0.1, kinship: 0, role: null }), undefined);

  const snapshot = JSON.parse(JSON.stringify(m));
  get(m, 'c');
  get(m, 'z');
  affectionFor(m, 'c');
  familiarityFor(m, 'c');
  kinshipBetween(m, 'c');
  affectionFor(m, 'nobody');
  assert.deepEqual(m, snapshot, '只读函数不得修改记忆');
});

test('remember 覆盖同 id 时原地更新（持有旧引用的调用方不会失效）', () => {
  // Task 7 / Task 10 很可能在局部变量里存着一条 MemoryEntry 的引用。
  // 若 remember 改成 entries[i] = {...entry}，那个引用就指向了被丢弃的旧对象，
  // 于是"读出来是对的、写进去没人看见" —— 全程不报错。
  const m = createMemory();
  remember(m, { id: 'c1', familiarity: 0.5, affection: 0.2, kinship: 0, role: null });
  const held = get(m, 'c1');
  remember(m, { id: 'c1', familiarity: 0.9, affection: -0.4, kinship: 0.5, role: 'mother' });
  assert.equal(get(m, 'c1'), held, '应是同一个对象');
  assert.equal(held.affection, -0.4);
  assert.equal(held.familiarity, 0.9);
  assert.equal(held.kinship, 0.5);
  assert.equal(held.role, 'mother');
});

test('id 是普通字符串：原型链键名不会被误当成已有记录', () => {
  // get() 是对 entries 的线性扫描（e.id === id），不是对象索引 ——
  // 所以 'toString' / 'constructor' / '__proto__' 这些 id 都是合法的普通字符串。
  // 值得钉住，因为一旦将来有人把 Memory 重构成 Record<id, entry>，
  // get(m, 'toString') 就会返回继承来的函数而不是 null，
  // 而 affectionFor 会返回 NaN 或一个函数 —— 静默地污染下游。
  const m = createMemory();
  for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.equal(get(m, key), null, `${key} 不应解析成记录`);
    assert.equal(affectionFor(m, key), 0, `${key} 的 affectionFor 应是 0`);
    assert.equal(familiarityFor(m, key), 0, `${key} 的 familiarityFor 应是 0`);
    assert.equal(kinshipBetween(m, key), 0, `${key} 的 kinshipBetween 应是 0`);
  }
  // 而且它们可以被正常记住
  const e = ensure(m, 'toString', { kinship: 0.5, role: 'sibling' });
  assert.equal(e.id, 'toString');
  assert.equal(get(m, 'toString'), e);
  adjust(m, 'toString', 0.3);
  assert.ok(Math.abs(affectionFor(m, 'toString') - 0.3) < 1e-9);
  assert.equal(affectionFor(m, 'hasOwnProperty'), 0, '别的原型键仍应无记录');
});

test('decay 让好感幅度单调收缩、不越零、不振荡（600 步逐步检查）', () => {
  // "淡忘"的数学含义：|affection| 严格递减趋向 0，符号不变，不越过 0 反弹。
  // 逐步断言而不是只看首尾 —— 只看首尾的话，一个"先涨后跌"或"来回振荡"
  // 的实现只要终点更低就能通过。
  const m = createMemory();
  adjust(m, 'pos', 0.8, 0.7);
  adjust(m, 'neg', -0.8, 0.7);
  let prevPos = affectionFor(m, 'pos');
  let prevNeg = affectionFor(m, 'neg');
  let prevFam = familiarityFor(m, 'pos');
  for (let i = 0; i < 600; i++) {
    decay(m, 1 / 60);
    const pos = affectionFor(m, 'pos');
    const neg = affectionFor(m, 'neg');
    const fam = familiarityFor(m, 'pos');
    // 有限性先于范围（NaN 对两个比较都是 false，顺序颠倒会误报成"越界"）
    assert.ok(Number.isFinite(pos) && Number.isFinite(neg) && Number.isFinite(fam),
      `第 ${i} 步出现非有限数: ${pos} ${neg} ${fam}`);
    assert.ok(pos > 0 && pos < prevPos, `第 ${i} 步正向好感未严格递减: ${prevPos} → ${pos}`);
    assert.ok(neg < 0 && neg > prevNeg, `第 ${i} 步负向好感未向 0 收缩: ${prevNeg} → ${neg}`);
    assert.ok(fam > 0 && fam < prevFam, `第 ${i} 步熟悉度未严格递减: ${prevFam} → ${fam}`);
    prevPos = pos; prevNeg = neg; prevFam = fam;
  }
  assert.ok(Math.abs(prevPos) < 0.8 && Math.abs(prevNeg) < 0.8, '10 秒后幅度确实收缩了');
});

test('模块无状态：createMemory 每次返回互不相干的新对象', () => {
  // 计划的架构约束是"每个系统一个 ES module，**无状态**"。
  // 若 createMemory 返回了共享的模块级数组，两只生物的记忆会互相渗透 ——
  // 而症状是"A 突然认得 B 的朋友"，没有任何一处抛错。
  const a = createMemory();
  const b = createMemory();
  assert.notEqual(a, b);
  assert.notEqual(a.entries, b.entries);
  adjust(a, 'x', 0.5);
  assert.deepEqual(b, { entries: [] }, '写入 a 不得影响 b');
  assert.equal(affectionFor(b, 'x'), 0);
});

test('长跑（5 分钟 @60Hz，固定种子驱动）后所有条目有限、在范围内、容量不越界', () => {
  // 与 needs.test.js / emotions.test.js 同款的整体不变量测试：
  // 不在热路径里加逐帧守卫，而是让 mutator 交替作用上万步之后检查一次。
  //
  // 为什么值得：adjust 的 clamp 写成 (v < lo ? lo : v > hi ? hi : v)，
  // 两个比较对 NaN 都是 false，于是 NaN 会**原样穿过** clamp；
  // 一个 NaN 分量此后在所有 > 比较里恒为 false，在行为评分里静默失去发言权。
  // 输入全部由固定种子的 rng 驱动，因此可复现。
  const rng = createRng(0x5EED);
  const ids = [PLAYER_ID, 'c1', 'c2', 'c3', 'mom', 'kid', 'rival', 'stranger'];
  const m = createMemory();
  ensure(m, 'mom', { role: 'mother', kinship: KINSHIP.mother });
  ensure(m, 'kid', { role: 'offspring', kinship: KINSHIP.offspring });

  const STEPS = 60 * 60 * 5;                             // 5 分钟模拟时间
  for (let i = 0; i < STEPS; i++) {
    if (rng.chance(0.05)) adjust(m, rng.pick(ids), rng.range(-0.4, 0.4), rng.range(0, 0.3));
    if (rng.chance(0.02)) {
      remember(m, {
        id: rng.pick(ids), familiarity: rng.next(), affection: rng.range(-1, 1),
        kinship: rng.chance(0.5) ? 0.5 : 0, role: null,
      });
    }
    decay(m, 1 / 60);

    assert.ok(m.entries.length <= CONFIG.memoryCapacity,
      `第 ${i} 步容量越界: ${m.entries.length} > ${CONFIG.memoryCapacity}`);
    for (const e of m.entries) {
      // 有限性先于范围：NaN >= -1 与 NaN <= 1 都是 false，顺序颠倒会把
      // "非有限数"误报成"越界"，诊断信息就丢了。
      assert.ok(Number.isFinite(e.affection), `第 ${i} 步 ${e.id} 的 affection 非有限数: ${e.affection}`);
      assert.ok(Number.isFinite(e.familiarity), `第 ${i} 步 ${e.id} 的 familiarity 非有限数: ${e.familiarity}`);
      assert.ok(e.affection >= -1 && e.affection <= 1, `第 ${i} 步 ${e.id} 的 affection 越界: ${e.affection}`);
      assert.ok(e.familiarity >= 0 && e.familiarity <= 1, `第 ${i} 步 ${e.id} 的 familiarity 越界: ${e.familiarity}`);
    }
  }
  assert.ok(m.entries.length > 0, '防空转：长跑之后记忆里确实有东西');
  // 键集检查放在循环外：它要 sort + deepEqual，放进 18000×12 的内层循环里
  // 会把这条测试的耗时放大一个数量级，而它对"哪一步开始漂移"没有额外诊断价值。
  for (const e of m.entries) {
    assert.equal(typeof e.id, 'string');
    assert.deepEqual(Object.keys(e).sort(),
      ['affection', 'familiarity', 'id', 'kinship', 'role'], `${e.id} 的键集被改动`);
  }
});
