import test from 'node:test';
import assert from 'node:assert/strict';
import { thresholds } from '../src/personality.js';

const P = (over = {}) => ({
  bold: 0.5, clingy: 0.5, irritable: 0.5,
  gluttonous: 0.5, curious: 0.5, libido: 0.5,
  ...over,
});

const FIELDS = [
  'fearThreshold', 'angerThreshold', 'angerDuration', 'hungerTrigger',
  'socialTrigger', 'exploreRadius', 'playerApproach',
  'turnRate', 'courtshipWillingness',
];

test('输出包含全部约定字段且都是有限数', () => {
  const t = thresholds(P());
  for (const k of FIELDS) {
    assert.ok(k in t, `缺少字段 ${k}`);
    assert.equal(typeof t[k], 'number', `${k} 应为 number`);
    assert.ok(Number.isFinite(t[k]), `${k} 非有限数: ${t[k]}`);
  }
});

test('阈值字段集恰好是 FIELDS —— 不多不少', () => {
  // 上面那条只检查"FIELDS 里的都在"，对**多出来的字段**完全不敏感：
  // 把被刻意删除的 arousalRate 加回去，那条依旧全绿（实测 17/17 通过）。
  // 而"多一个字段"恰恰是本任务要防的事 —— arousalRate 是个没人读的死旋钮，
  // 谁把它接上去，libido 对 arousal 的影响就会被重复计算一次。
  const t = thresholds(P());
  assert.deepEqual(Object.keys(t).sort(), [...FIELDS].sort(),
    '输出键集必须与 FIELDS 完全一致（多一个或少一个都要变红）');
  assert.equal(FIELDS.length, 9, '阈值恰好 9 个 —— 删除 arousalRate 后不得变回 10 个');
  assert.equal(Object.keys(t).length, 9);
  assert.ok(!('arousalRate' in t),
    'arousalRate 已被刻意删除（死字段：无消费者，spec 4.9 那行由 Task 4 的 arousal 目标值实现）');
});

test('九个阈值的系数与两端取值都被字面量钉住', () => {
  // 与 playerApproach 同理：只测方向的断言是空洞的。
  // 实测把 angerDuration / hungerTrigger / turnRate 的斜率缩小 10 倍，
  // 17 条既有测试仍然全绿 —— 而这三个值直接决定"气多久""多饿才觅食""转身多果断"。
  // 这与 Task 3 复查发现的"速率表整体错 13 倍也能过 CI"是同一类缺陷。
  // 每条都取基因的两个极端（0 与 1），把斜率与截距一起钉死。
  //
  // 为什么用 1e-12 容差而不是 assert.equal：**不是**因为值模糊，而是因为十进制字面量
  // 在二进制下本就不可精确表示。实测这几个值确实带浮点尾巴：
  //   hungerTrigger gluttonous=1 → 0.25000000000000006（写 0.25 会不等）
  //   socialTrigger clingy=1     → 0.21999999999999997（写 0.22 会不等）
  //   angerThreshold 中性        → 0.42500000000000004（写 0.425 会不等）
  // 容差 1e-12 相对这些量的量级（≈0.2~16）仍能抓住任何 0.1% 以上的系数错误。
  // 具体到"斜率缩小 10 倍"这个变异，被钉住的取值会偏移：
  //   hungerTrigger  gluttonous=1 → 0.25  变 0.52  （差 0.27）
  //   turnRate       bold=1        → 6     变 2.4   （差 3.6）
  //   angerDuration  irritable=1   → 16    变 5.2   （差 10.8）
  // 即斜率本身差 10 倍（1 个数量级），绝对值差 0.27~10.8 ——
  // 而容差是 1e-12，两者相差约 11~12 个数量级，绝无蒙混过关的余地。
  // （此前这里写的是"差 2 个数量级"，那是错的：斜率差的是 10 倍而非 100 倍。
  //   数值断言旁边的量级说明也必须准确，否则它本身就是一处待发现的错。）
  // （Task 4 的教训：一条 1e-6 容差曾让一个错到第 7 位的字面量蒙混过关 ——
  //   容差必须与"要抓的错误量级"一起说明，否则就是藏错的地方。）
  const t = (o) => thresholds(P(o));
  // fearThreshold = 0.3 + bold*0.5
  assert.ok(Math.abs(t({ bold: 0 }).fearThreshold - 0.3) < 1e-12);
  assert.ok(Math.abs(t({ bold: 1 }).fearThreshold - 0.8) < 1e-12);
  // angerThreshold = 0.65 - irritable*0.45
  assert.ok(Math.abs(t({ irritable: 0 }).angerThreshold - 0.65) < 1e-12);
  assert.ok(Math.abs(t({ irritable: 1 }).angerThreshold - 0.2) < 1e-12);
  // angerDuration = 4 + irritable*12（秒）
  assert.ok(Math.abs(t({ irritable: 0 }).angerDuration - 4) < 1e-12);
  assert.ok(Math.abs(t({ irritable: 1 }).angerDuration - 16) < 1e-12);
  // hungerTrigger = 0.55 - gluttonous*0.3
  assert.ok(Math.abs(t({ gluttonous: 0 }).hungerTrigger - 0.55) < 1e-12);
  assert.ok(Math.abs(t({ gluttonous: 1 }).hungerTrigger - 0.25) < 1e-12);
  // socialTrigger = 0.5 - clingy*0.28
  assert.ok(Math.abs(t({ clingy: 0 }).socialTrigger - 0.5) < 1e-12);
  assert.ok(Math.abs(t({ clingy: 1 }).socialTrigger - 0.22) < 1e-12);
  // exploreRadius = 0.25 + curious*0.6
  assert.ok(Math.abs(t({ curious: 0 }).exploreRadius - 0.25) < 1e-12);
  assert.ok(Math.abs(t({ curious: 1 }).exploreRadius - 0.85) < 1e-12);
  // turnRate = 2 + bold*4（rad/s）
  assert.ok(Math.abs(t({ bold: 0 }).turnRate - 2) < 1e-12);
  assert.ok(Math.abs(t({ bold: 1 }).turnRate - 6) < 1e-12);
  // courtshipWillingness = 0.6 + libido*0.8
  assert.ok(Math.abs(t({ libido: 0 }).courtshipWillingness - 0.6) < 1e-12);
  assert.ok(Math.abs(t({ libido: 1 }).courtshipWillingness - 1.4) < 1e-12);
  // 中性性格（全 0.5）的整组取值，作为整体快照
  const n = thresholds(P());
  assert.ok(Math.abs(n.fearThreshold - 0.55) < 1e-12);
  assert.ok(Math.abs(n.angerThreshold - 0.425) < 1e-12);
  assert.ok(Math.abs(n.angerDuration - 10) < 1e-12);
  assert.ok(Math.abs(n.hungerTrigger - 0.4) < 1e-12);
  assert.ok(Math.abs(n.socialTrigger - 0.36) < 1e-12);
  assert.ok(Math.abs(n.exploreRadius - 0.55) < 1e-12);
  assert.ok(Math.abs(n.turnRate - 4) < 1e-12);
  assert.ok(Math.abs(n.courtshipWillingness - 1) < 1e-12);
});

test('bold 高 → fearThreshold 高（要更大威胁才害怕）', () => {
  assert.ok(thresholds(P({ bold: 1 })).fearThreshold > thresholds(P({ bold: 0 })).fearThreshold);
});

test('bold 高 → turnRate 高（转身果断）', () => {
  assert.ok(thresholds(P({ bold: 1 })).turnRate > thresholds(P({ bold: 0 })).turnRate);
});

test('bold 高 → playerApproach 高（敢接近玩家的手）', () => {
  assert.ok(thresholds(P({ bold: 1 })).playerApproach > thresholds(P({ bold: 0 })).playerApproach);
});

test('irritable 高 → angerThreshold 低（更易怒）', () => {
  assert.ok(thresholds(P({ irritable: 1 })).angerThreshold < thresholds(P({ irritable: 0 })).angerThreshold);
});

test('irritable 高 → angerDuration 长（气得更久）', () => {
  assert.ok(thresholds(P({ irritable: 1 })).angerDuration > thresholds(P({ irritable: 0 })).angerDuration);
});

test('irritable 高 → playerApproach 低（不乐意凑过来）', () => {
  assert.ok(thresholds(P({ irritable: 1 })).playerApproach < thresholds(P({ irritable: 0 })).playerApproach);
});

test('gluttonous 高 → hungerTrigger 低（更早去觅食）', () => {
  assert.ok(thresholds(P({ gluttonous: 1 })).hungerTrigger < thresholds(P({ gluttonous: 0 })).hungerTrigger);
});

test('clingy 高 → socialTrigger 低（更早去找同伴）', () => {
  assert.ok(thresholds(P({ clingy: 1 })).socialTrigger < thresholds(P({ clingy: 0 })).socialTrigger);
});

test('clingy 高 → playerApproach 高（更常卖萌）', () => {
  assert.ok(thresholds(P({ clingy: 1 })).playerApproach > thresholds(P({ clingy: 0 })).playerApproach);
});

test('curious 高 → exploreRadius 大', () => {
  assert.ok(thresholds(P({ curious: 1 })).exploreRadius > thresholds(P({ curious: 0 })).exploreRadius);
});

test('libido 高 → courtshipWillingness 更高', () => {
  // 注意：原计划这里还断言了一个 `arousalRate`（"求偶欲上升快"），现已**删除该字段**（2026-10-14 预飞审查）。
  // 理由：全项目没有任何消费者，而 spec 4.9 那行"求偶欲上升快"实际是由
  // Task 4 的 computeTargets 给 arousal **目标值** 0.25 权重实现的，
  // 上升快慢则由全局 CONFIG.emotions.inertia 决定 —— 都不是"每只生物一个速率"。
  // 保留它等于留一个"看起来在起作用、其实没人读"的旋钮，
  // 哪天有人真的接上去就会把 libido 的影响重复计算一次。
  // libido 对 arousal 的调制已在 tests/emotions.test.js 的目标值测试里钉住。
  assert.ok(
    thresholds(P({ libido: 1 })).courtshipWillingness
    > thresholds(P({ libido: 0 })).courtshipWillingness,
  );
});

test('playerApproach 的各项系数与两端取值被字面量钉住（含负值一侧）', () => {
  // 这个系数是 Task 9 里 beg / socialize 的乘子，所以它的**量级**是承重的。
  // 原计划只测方向（bold 1 > bold 0、irritable 1 < irritable 0、clingy 1 > clingy 0），
  // 那是空洞的：把 bold 的 0.3 改成 0.3/0.1/0.05/0.02/0.01 中的任何一个，
  // 三条方向测试全绿，而"胆大 → 更常卖萌"（spec 4.9 的那一行）已经几乎消失。
  // 同时负值一侧原本从未被走到，于是"允许为负 —— 主动避开玩家的手"也只是散文。
  const t = (o) => thresholds(P(o)).playerApproach;
  assert.ok(Math.abs(t({ bold: 1, clingy: 1, irritable: 0 }) - 0.8) < 1e-12, '1*0.5 + 1*0.3 = 0.8');
  assert.ok(Math.abs(t({ bold: 0, clingy: 0, irritable: 1 }) - (-0.35)) < 1e-12,
    '负值一侧：-1*0.35 = -0.35，"主动避开玩家的手"必须真的可达');
  assert.ok(Math.abs(t({ bold: 0, clingy: 0, irritable: 0 }) - 0) < 1e-12, '三项全 0 → 0');
  // 逐项单独钉，避免"三项恰好凑对"掩盖某个单项系数写错
  assert.ok(Math.abs(t({ bold: 1, clingy: 0, irritable: 0 }) - 0.3) < 1e-12, 'bold 系数 0.3');
  assert.ok(Math.abs(t({ bold: 0, clingy: 1, irritable: 0 }) - 0.5) < 1e-12, 'clingy 系数 0.5');
  assert.ok(Math.abs(t({ bold: 0, clingy: 0, irritable: 1 }) - (-0.35)) < 1e-12, 'irritable 系数 -0.35');
  // 中性性格：0.5*0.5 + 0.5*0.3 - 0.5*0.35 = 0.25 + 0.15 - 0.175 = 0.225
  assert.ok(Math.abs(thresholds(P()).playerApproach - 0.225) < 1e-12, '默认性格应为 0.225');
});

test('阈值单调：基因从 0 到 1 连续扫描时方向不变', () => {
  const steps = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const fear = steps.map((v) => thresholds(P({ bold: v })).fearThreshold);
  const anger = steps.map((v) => thresholds(P({ irritable: v })).angerThreshold);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(fear[i] > fear[i - 1], `fearThreshold 应随 bold 单调递增: ${fear}`);
    assert.ok(anger[i] < anger[i - 1], `angerThreshold 应随 irritable 单调递减: ${anger}`);
  }
});

test('极端基因也不产生荒谬值（区间与正负号都合理）', () => {
  for (const p of [
    P({ bold: 0, clingy: 0, irritable: 0, gluttonous: 0, curious: 0, libido: 0 }),
    P({ bold: 1, clingy: 1, irritable: 1, gluttonous: 1, curious: 1, libido: 1 }),
    P({ bold: 1, irritable: 0, clingy: 0, curious: 0 }),
    P({ bold: 0, irritable: 1, clingy: 1, curious: 1 }),
  ]) {
    const t = thresholds(p);
    assert.ok(t.fearThreshold > 0 && t.fearThreshold <= 1, `fearThreshold: ${t.fearThreshold}`);
    assert.ok(t.angerThreshold > 0 && t.angerThreshold <= 1, `angerThreshold: ${t.angerThreshold}`);
    assert.ok(t.angerDuration >= 1 && t.angerDuration <= 30, `angerDuration: ${t.angerDuration}`);
    assert.ok(t.hungerTrigger > 0 && t.hungerTrigger < 1, `hungerTrigger: ${t.hungerTrigger}`);
    assert.ok(t.socialTrigger > 0 && t.socialTrigger < 1, `socialTrigger: ${t.socialTrigger}`);
    assert.ok(t.exploreRadius > 0 && t.exploreRadius <= 1, `exploreRadius: ${t.exploreRadius}`);
    assert.ok(t.playerApproach >= -1 && t.playerApproach <= 1, `playerApproach: ${t.playerApproach}`);
    assert.ok(t.turnRate > 0 && t.turnRate <= 12, `turnRate: ${t.turnRate}`);
    assert.ok(t.courtshipWillingness > 0 && t.courtshipWillingness <= 2, `courtshipWillingness: ${t.courtshipWillingness}`);
  }
});

test('纯函数：同样输入给出同样输出，且不修改入参', () => {
  const p = P({ bold: 0.7 });
  const snapshot = { ...p };
  const a = thresholds(p);
  const b = thresholds(p);
  assert.deepEqual(a, b);
  assert.deepEqual(p, snapshot, '入参不得被修改');
});

test('thresholds 是纯映射，不依赖任何随机源', () => {
  // 同一份性格在不同"时刻"调用结果一致 —— 行为可复现的前提
  const p = P({ clingy: 0.3, curious: 0.9 });
  assert.deepEqual(thresholds(p), thresholds(p));
});
