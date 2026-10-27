// 社交同步的纯层（spec §4.12 第 6 条 / 设计见 docs/superpowers/specs/2026-10-27-social-bond-sync-design.md）。
//
// 这一层的价值在于**门控可以被逐条打破**：六个条件各一条断言，而不是一条"合格的一对返回 true"。
// 只测"合格"的测试是空的 —— 把任何一条门删掉它都还是绿的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { pairEligible, syncDegree, companionReady, bondStep } from '../src/social.js';
import { adjust } from '../src/memory.js';

const S = CONFIG.social;
const DT = CONFIG.fixedDt;

// 一只"正在社交"的个体的最小形状。social.js 只读这些键，所以不需要 createCreature
// （那会连带抽基因、建 needs/emotions 全套，让"这一条门为什么挡住"淹没在无关字段里）。
function mk(id, over = {}) {
  return {
    id,
    alive: true, sick: false, held: false,
    intent: { kind: 'socialize', targetId: 'other' },
    emotions: { joy: CONFIG.mood.happyJoyMin + 0.05 },
    needs: { hunger: 1 - S.fedMin - 0.05 },
    memory: { entries: [] },
    bondId: null, bondSync: 0, bondTotal: 0,
    ...over,
  };
}

// 一对**互相**指向对方、并且互有好感的个体。
function pair(aff = S.affMin + 0.05) {
  const a = mk('a', { intent: { kind: 'socialize', targetId: 'b' } });
  const b = mk('b', { intent: { kind: 'socialize', targetId: 'a' } });
  adjust(a.memory, 'b', aff, 0.5);
  adjust(b.memory, 'a', aff, 0.5);
  return [a, b];
}

const steps = (sec) => Math.round(sec / DT);

test('CONFIG.social 的旋钮被字面量钉住（不是 > 0）', () => {
  assert.equal(S.pairDist, 0.09);
  assert.equal(S.fedMin, 0.6);
  assert.equal(S.affMin, 0.15);
  assert.equal(S.syncSeconds, 6);
  assert.equal(S.breakDecay, 2, '必须 > 1：断续同步攒不满，"连续"才是判据');
  assert.equal(S.totalSeconds, 90);
  assert.equal(S.totalDecay, 0.01);
  assert.equal(S.affectionRate, 0.05);
  assert.equal(S.familiarityRate, 0.06);
  assert.equal(S.arousalRate, 0.12);
  assert.equal(S.joyRate, 0.05);
  assert.ok(S.breakDecay > 1, 'breakDecay <= 1 的话断续与连续没有区别');
});

test('门控六条：逐条打破都必须变 false', () => {
  {
    const [a, b] = pair();
    assert.equal(pairEligible(a, b, 0.05), true, '合格的一对');
    assert.equal(pairEligible(a, b, S.pairDist), true, '恰好压在 pairDist 上也算（<= 判定）');
  }
  {
    const [a, b] = pair(); b.alive = false;
    assert.equal(pairEligible(a, b, 0.05), false, '死了不算');
  }
  {
    const [a, b] = pair(); b.sick = true;
    assert.equal(pairEligible(a, b, 0.05), false, 'sick 不算');
  }
  {
    const [a, b] = pair(); b.held = true;
    assert.equal(pairEligible(a, b, 0.05), false, '被玩家拎着不算');
  }
  {
    const [a, b] = pair(); b.intent = { kind: 'forage', targetId: 'a' };
    assert.equal(pairEligible(a, b, 0.05), false, '对方不在 socialize 不算');
  }
  {
    const [a, b] = pair(); b.intent = { kind: 'socialize', targetId: 'c' };
    assert.equal(pairEligible(a, b, 0.05), false, '单相思不算（对方目标是别人）');
  }
  {
    const [a, b] = pair();
    assert.equal(pairEligible(a, b, S.pairDist + 1e-9), false, '超出 pairDist 不算');
  }
  {
    const [a, b] = pair(); b.needs.hunger = 1 - S.fedMin + 0.05;
    assert.equal(pairEligible(a, b, 0.05), false, '对方没吃饱不算');
  }
  {
    const [a, b] = pair(); a.needs.hunger = 1;
    assert.equal(pairEligible(a, b, 0.05), false, '自己没吃饱也不算（两侧都要判）');
  }
  {
    const [a, b] = pair(); b.emotions.joy = CONFIG.mood.happyJoyMin - 0.05;
    assert.equal(pairEligible(a, b, 0.05), false, '对方不开心不算（读 CONFIG.mood 那个数）');
  }
  {
    const [a, b] = pair(); adjust(b.memory, 'a', -(S.affMin + 0.2), 0.5);
    assert.equal(pairEligible(a, b, 0.05), false, '对方好感掉到门下不算');
  }
  {
    const a = mk('a', { intent: { kind: 'socialize', targetId: 'a' } });
    assert.equal(pairEligible(a, a, 0), false, '自己跟自己不算一对');
  }
  {
    const [a, b] = pair();
    assert.equal(pairEligible(a, b, Number.NaN), false, 'NaN 距离不许被判成"很近"');
    assert.equal(pairEligible(null, b, 0.05), false);
    assert.equal(pairEligible(a, undefined, 0.05), false);
  }
});

test('joy 门读的是 CONFIG.mood.happyJoyMin，不是 social 里另立的一个数', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(S, 'joyMin'), false,
    'social 段里不许有 joyMin：阈值只许一处定义（与 body.js 读 begEscalate 同一条纪律）');
  const [a, b] = pair();
  b.emotions.joy = CONFIG.mood.happyJoyMin;      // 恰好压在阈值上（>= 判定）
  assert.equal(pairEligible(a, b, 0.05), true);
  b.emotions.joy = CONFIG.mood.happyJoyMin - 1e-9;
  assert.equal(pairEligible(a, b, 0.05), false);
});

test('syncDegree 是连续读数：半程 ≈ 0.5，封顶 1，无伙伴恒 0', () => {
  const [a] = pair();
  assert.equal(syncDegree(a), 0, '没有伙伴时是 0，不是 NaN 也不是 1');
  assert.equal(syncDegree(null), 0);
  assert.equal(syncDegree({}), 0, '脏形状不许抛');
  for (let i = 0; i < steps(S.syncSeconds / 2); i++) bondStep(a, 'b', true, DT);
  assert.ok(Math.abs(syncDegree(a) - 0.5) < 0.02, `半程读到 ${syncDegree(a)}`);
  for (let i = 0; i < steps(S.syncSeconds * 2); i++) bondStep(a, 'b', true, DT);
  assert.equal(syncDegree(a), 1, '封顶在 1，不许溢出');
  assert.equal(a.bondSync, S.syncSeconds, 'bondSync 也要封顶：跑一夜之后不该是四位数');
});

test('中断按 breakDecay 退，且退到 0 之后清掉伙伴', () => {
  const [a] = pair();
  for (let i = 0; i < steps(3); i++) bondStep(a, 'b', true, DT);
  const half = syncDegree(a);
  assert.ok(half > 0.4, `先要真的攒起来：${half}`);
  for (let i = 0; i < steps(3); i++) bondStep(a, 'b', false, DT);
  assert.equal(syncDegree(a), 0, `3 秒同步 + 3 秒分开应当退干净，实到 ${syncDegree(a)}`);
  assert.equal(a.bondId, null, '退到 0 之后伙伴要清掉');
});

test('断续同步攒不满（"连续"是判据，不是"累计够久"）', () => {
  const c = mk('c', { intent: { kind: 'socialize', targetId: 'p' } });
  for (let round = 0; round < 12; round++) {          // 3 秒同步 / 3 秒分开 × 12 = 72 秒
    for (let i = 0; i < steps(3); i++) bondStep(c, 'p', true, DT);
    for (let i = 0; i < steps(3); i++) bondStep(c, 'p', false, DT);
    assert.ok(syncDegree(c) < 1, `第 ${round} 轮就攒满了，断续与连续没有区别`);
  }
  // 72 秒里只有一半在同步（累计 36 秒），而且还一路在淡 ⇒ 不许升级到 companion。
  assert.equal(companionReady(c), false, `断续也能升级的话，"长期凑在一起"这条就是空的（bondTotal=${c.bondTotal}）`);
  assert.ok(c.bondTotal < S.totalSeconds, `bondTotal = ${c.bondTotal}`);
  // 对照：**连续**同步同样长的时间必须能升级 —— 两端都量，才证明这条判据真的在分辨。
  const d = mk('d', { intent: { kind: 'socialize', targetId: 'p' } });
  for (let i = 0; i < steps(S.totalSeconds + 1); i++) bondStep(d, 'p', true, DT);
  assert.equal(companionReady(d), true);
});

test('crossed 只在跨到 1 的那一 tick 为 true（上升沿，不是"在阈上"）', () => {
  const [a] = pair();
  let fires = 0;
  for (let i = 0; i < steps(30); i++) if (bondStep(a, 'b', true, DT).crossed) fires += 1;
  assert.equal(fires, 1, `连续同步 30 秒响了 ${fires} 次，应该恰好一次`);
  for (let i = 0; i < steps(S.syncSeconds); i++) bondStep(a, 'b', false, DT);
  for (let i = 0; i < steps(30); i++) if (bondStep(a, 'b', true, DT).crossed) fires += 1;
  assert.equal(fires, 2, '掉下去再同步满，才算新的一次');
});

test('换伙伴把长期计数结清：bondTotal 是"与这一只"的累计', () => {
  const [a] = pair();
  for (let i = 0; i < steps(10); i++) bondStep(a, 'b', true, DT);
  assert.ok(a.bondTotal > 9.9 && a.bondTotal < 10.1, `bondTotal = ${a.bondTotal}`);
  bondStep(a, 'z', true, DT);
  assert.equal(a.bondId, 'z');
  assert.ok(a.bondTotal <= DT + 1e-9, `换了伙伴还留着旧账：${a.bondTotal}`);
  // 这一步已经加了一帧，所以读到的是 DT/syncSeconds 而不是 0 —— 关键是它**从 0 起算**。
  assert.ok(syncDegree(a) <= DT / S.syncSeconds + 1e-12,
    `换了伙伴 episode 应当从 0 起，实到 ${syncDegree(a)}`);
});

test('长期计数分开时按 totalDecay 指数淡（不是线性、也不是不动）', () => {
  const [a] = pair();
  for (let i = 0; i < steps(10); i++) bondStep(a, 'b', true, DT);
  const before = a.bondTotal;
  for (let i = 0; i < steps(10); i++) bondStep(a, 'b', false, DT);
  const expect = before * Math.exp(-S.totalDecay * 10);
  assert.ok(Math.abs(a.bondTotal - expect) < 1e-6,
    `应当是 ${expect}，实到 ${a.bondTotal}（原来 ${before}）`);
  assert.ok(a.bondTotal < before, '分开之后必须下降');
});

test('companionReady 只在长期计数到 totalSeconds 之后为 true', () => {
  const [a] = pair();
  for (let i = 0; i < steps(S.totalSeconds - 1); i++) bondStep(a, 'b', true, DT);
  assert.equal(companionReady(a), false, '差一秒还不算');
  for (let i = 0; i < steps(2); i++) bondStep(a, 'b', true, DT);
  assert.equal(companionReady(a), true);
  assert.equal(companionReady(mk('x')), false, '没有伙伴时不算');
});

test('bondStep 不分配对象：返回形状固定，且反复调用不在个体身上长新键', () => {
  const [a] = pair();
  const before = Object.keys(a).sort().join(',');
  const r = bondStep(a, 'b', true, DT);
  assert.deepEqual(Object.keys(r).sort(), ['crossed', 'degree']);
  assert.equal(typeof r.degree, 'number');
  assert.equal(typeof r.crossed, 'boolean');
  for (let i = 0; i < 600; i++) bondStep(a, 'b', true, DT);
  assert.equal(Object.keys(a).sort().join(','), before, '个体身上不许长出新键');
});
