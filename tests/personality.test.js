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
