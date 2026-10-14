import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { decode, randomGenome } from '../src/genes.js';
import { createRng } from '../src/rng.js';
import { createNeeds, decay, feed, startle, comfort, rest, mostUrgent } from '../src/needs.js';

// 中性个体：把会被基因调制的项固定住，好断言数量级
const neutralTraits = () => {
  const t = decode(randomGenome(createRng(1)));
  t.personality.gluttonous = 0.5;
  t.personality.clingy = 0.5;
  t.personality.bold = 0.5;
  t.size = (CONFIG.minSize + CONFIG.maxSize) / 2;
  return t;
};
const IDLE = { moving: false, resting: false, companions: 0 };

test('createNeeds 的初值是低匮乏的', () => {
  const n = createNeeds();
  assert.deepEqual(Object.keys(n).sort(), ['energy', 'hunger', 'safety', 'social']);
  for (const v of Object.values(n)) assert.ok(v >= 0 && v <= 1);
  assert.ok(n.hunger < 0.3, '新个体应带一点饥饿好让它马上觅食');
  assert.equal(n.safety, 0);
});

test('时间流逝使饥饿上升', () => {
  const n = createNeeds();
  n.hunger = 0;
  decay(n, 10, neutralTraits(), IDLE);
  assert.ok(n.hunger > 0);
});

test('约 120 秒饥饿升到可观水平但不越界', () => {
  const n = createNeeds();
  n.hunger = 0;
  const t = neutralTraits();
  for (let i = 0; i < 120 * 60; i++) decay(n, 1 / 60, t, IDLE);
  assert.ok(n.hunger > 0.4 && n.hunger <= 1, `120s 后饥饿 = ${n.hunger}`);
});

test('所有需求永远被 clamp 在 [0,1]', () => {
  const n = createNeeds();
  const t = neutralTraits();
  for (let i = 0; i < 60 * 60 * 10; i++) {
    decay(n, 1 / 60, t, { moving: true, resting: false, companions: 0 });
  }
  for (const [k, v] of Object.entries(n)) assert.ok(v >= 0 && v <= 1, `${k} 越界: ${v}`);
});

test('结果与时间步长无关（固定步长的核心保证，spec 8.1）', () => {
  // 在不触发 clamp 的区间内，60 步 × 1/60s 必须严格等于 1 步 × 1s
  const t = neutralTraits();
  const a = createNeeds();
  const b = createNeeds();
  for (const n of [a, b]) { n.hunger = 0; n.energy = 0; n.social = 0; n.safety = 0.5; }
  for (let i = 0; i < 60; i++) decay(a, 1 / 60, t, IDLE);
  decay(b, 1, t, IDLE);
  for (const k of Object.keys(a)) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`);
  }
});

test('贪吃基因使饥饿上升更快', () => {
  const base = neutralTraits();
  const gluttonous = { ...base, personality: { ...base.personality, gluttonous: 1 } };
  const abstemious = { ...base, personality: { ...base.personality, gluttonous: 0 } };
  const a = createNeeds(); a.hunger = 0;
  const b = createNeeds(); b.hunger = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, gluttonous, IDLE);
    decay(b, 1 / 60, abstemious, IDLE);
  }
  assert.ok(a.hunger > b.hunger, '贪吃者应更饿');
});

test('体型更大者饥饿上升更快', () => {
  const base = neutralTraits();
  const big = { ...base, size: CONFIG.maxSize };
  const small = { ...base, size: CONFIG.minSize };
  const a = createNeeds(); a.hunger = 0;
  const b = createNeeds(); b.hunger = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, big, IDLE);
    decay(b, 1 / 60, small, IDLE);
  }
  assert.ok(a.hunger > b.hunger);
});

test('有同伴在场时社交匮乏显著更慢', () => {
  const t = neutralTraits();
  const alone = createNeeds(); alone.social = 0;
  const together = createNeeds(); together.social = 0;
  for (let i = 0; i < 600; i++) {
    decay(alone, 1 / 60, t, { moving: false, resting: false, companions: 0 });
    decay(together, 1 / 60, t, { moving: false, resting: false, companions: 3 });
  }
  assert.ok(together.social < alone.social, '有同伴不应更孤独');
});

test('黏人基因使社交匮乏上升更快', () => {
  const base = neutralTraits();
  const clingy = { ...base, personality: { ...base.personality, clingy: 1 } };
  const aloof = { ...base, personality: { ...base.personality, clingy: 0 } };
  const a = createNeeds(); a.social = 0;
  const b = createNeeds(); b.social = 0;
  for (let i = 0; i < 600; i++) {
    decay(a, 1 / 60, clingy, IDLE);
    decay(b, 1 / 60, aloof, IDLE);
  }
  assert.ok(a.social > b.social);
});

test('移动时精力消耗快于静止', () => {
  const t = neutralTraits();
  const moving = createNeeds(); moving.energy = 0;
  const idle = createNeeds(); idle.energy = 0;
  for (let i = 0; i < 600; i++) {
    decay(moving, 1 / 60, t, { moving: true, resting: false, companions: 0 });
    decay(idle, 1 / 60, t, IDLE);
  }
  assert.ok(moving.energy > idle.energy, 'energy 是匮乏度，移动者应更高');
});

test('休息时精力匮乏下降', () => {
  const n = createNeeds();
  n.energy = 0.8;
  for (let i = 0; i < 600; i++) decay(n, 1 / 60, neutralTraits(), { moving: false, resting: true, companions: 0 });
  assert.ok(n.energy < 0.8, `休息后应恢复，实际 ${n.energy}`);
});

test('胆大基因使安全感恢复更快', () => {
  const base = neutralTraits();
  const bold = { ...base, personality: { ...base.personality, bold: 1 } };
  const timid = { ...base, personality: { ...base.personality, bold: 0 } };
  const a = createNeeds(); a.safety = 0.9;
  const b = createNeeds(); b.safety = 0.9;
  for (let i = 0; i < 300; i++) {
    decay(a, 1 / 60, bold, IDLE);
    decay(b, 1 / 60, timid, IDLE);
  }
  assert.ok(a.safety < b.safety, '胆大者应更快平静（safety 是匮乏度）');
});

test('feed 降低饥饿且不会变负', () => {
  const n = createNeeds(); n.hunger = 0.8;
  feed(n);
  assert.ok(n.hunger < 0.8);
  feed(n); feed(n); feed(n);
  assert.equal(n.hunger, 0, '吃饱后不得为负');
});

test('feed 接受自定义份量', () => {
  const n = createNeeds(); n.hunger = 1;
  feed(n, 0.25);
  assert.ok(Math.abs(n.hunger - 0.75) < 1e-9);
});

test('startle 提高不安全、comfort 降低不安全，均 clamp', () => {
  const n = createNeeds(); n.safety = 0;
  startle(n);
  assert.ok(n.safety > 0.4);
  startle(n); startle(n); startle(n);
  assert.equal(n.safety, 1, '不得超过 1');
  for (let i = 0; i < 10; i++) comfort(n);
  assert.equal(n.safety, 0, '不得低于 0');
});

test('rest 恢复精力且与步长无关', () => {
  const a = createNeeds(); a.energy = 0.5;
  const b = createNeeds(); b.energy = 0.5;
  rest(a, 1);
  for (let i = 0; i < 60; i++) rest(b, 1 / 60);
  assert.ok(Math.abs(a.energy - b.energy) < 1e-9);
  assert.ok(a.energy < 0.5);
});

test('mostUrgent 返回最匮乏的一条', () => {
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.9, social: 0.4, safety: 0.1 }), 'energy');
  assert.equal(mostUrgent({ hunger: 0.2, energy: 0.1, social: 0.4, safety: 0.95 }), 'safety');
  assert.equal(mostUrgent({ hunger: 0.9, energy: 0.1, social: 0.4, safety: 0.2 }), 'hunger');
});

test('mostUrgent 全零时返回 hunger（稳定的默认值，不给 undefined）', () => {
  assert.equal(mostUrgent({ hunger: 0, energy: 0, social: 0, safety: 0 }), 'hunger');
});
