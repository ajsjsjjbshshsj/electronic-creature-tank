import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { bodyRadius, pulledOut, heldStep, enjoyOf, carryEffects } from '../src/grab.js';

// ================================================================ 拎着玩的纯函数层
//
// 这个文件测的是**没有世界也能算**的那几件事：抓的几何、跟随的数学、反应的系数。
// 为什么不在 tests/sim.test.js 里测：那边要问同一个问题得拖住一只个体跑好几个 tick，
// 而"临界阻尼不许反向"这种性质是**逐步函数**的性质，跑tick反而把它和决策、碰撞搅在一起。
//
// ⚠️ 夹具必须带 age：sizeOf 走 growthFactor(c)，那里读的是 Math.max(0, c.age)，
// 手搭的 { traits: { size } } 会得到 NaN 半径 —— 于是 bodyRadius 那条断言看起来在测东西，
// 其实在比 NaN。下面那行"半径必须是正有限数"就是为此而写的反空判据。

const mk = (size, age = 960) => ({ traits: { size }, age });   // 960 = growthFactor 的峰值 1.0

test('bodyRadius 就是内核 inContact 用的那一个口径（sizeOf/1000）', () => {
  const r = bodyRadius(mk(26));
  assert.ok(Number.isFinite(r) && r > 0, `夹具没走到 growthFactor 的峰值：r=${r}`);
  assert.ok(Math.abs(r - 0.026) < 1e-12, `${r}`);
  // ⚠️ 这条不是洁癖：让路规则的成立与否取决于"摸"与"拎"量的是同一把尺。
  // 两处不同尺的话，Task 3 的让路会随视口大小漂移。
  assert.ok(CONFIG.grab.pullOutRatio > CONFIG.behavior.petContactRatio);
});

test('pulledOut：没越过 pullOutRatio 不算拎起（那还是抚摸）', () => {
  const r = bodyRadius(mk(26));
  const cut = r * CONFIG.grab.pullOutRatio;
  assert.equal(pulledOut({ handDist: cut * 0.99, r }), false);
  assert.equal(pulledOut({ handDist: cut * 1.01, r }), true);
});

test('pulledOut 的脏输入一律 false，不抛', () => {
  for (const bad of [{}, { handDist: NaN, r: 0.026 }, { handDist: 0.1, r: 0 },
                     { handDist: -1, r: 0.026 }, null]) {
    assert.equal(pulledOut(bad ?? {}), false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- 跟随的数学
// 半隐式欧拉的临界阻尼。这三条性质是"手感"的数学替身 ——
// 人不在这儿，但"过冲反向"与"dt 不线性"都会变成可断言的红。
const drive = (x0, vx0, tx, n, dt, k) => {
  let pos = { x: x0, y: 0 };
  let vel = { x: vx0, y: 0 };
  const trail = [];
  for (let i = 0; i < n; i += 1) {
    const s = heldStep({ pos, vel, target: { x: tx, y: 0 }, dt, k });
    pos = { x: s.x, y: s.y };
    vel = { x: s.vx, y: s.vy };
    trail.push(s);
  }
  return trail;
};

test('heldStep 临界阻尼：朝目标冲过去之后不许反向 overshoot（不抖）', () => {
  const trail = drive(0, 0, 1, 120, 1 / 60, CONFIG.grab.followStiffness);
  const crossed = trail.filter((p) => p.x > 1.0000001).length;
  assert.equal(crossed, 0, `越过目标又冲回来 ${crossed} 帧 —— 阻尼写成了欠阻尼`);
  assert.ok(trail[trail.length - 1].x > 0.99, `两秒还没跟到手边，k 太小：${trail[trail.length - 1].x}`);
});

// ⚠️ 这里原本写的是一条**错的性质**（"一次 1/60 ≈ 两次 1/120，容差 2e-4"）：
// 半隐式欧拉的全局误差是 O(dt)，所以细化步长只会**误差减半**，不会两次结果相等 ——
// 实测 k=900：1×(1/60) 误差 1.08e-2，2×(1/120) 误差 5.2e-3，比 2.08。
// 于是这条测试换成真正成立、也真正有用的那两条：① 一阶收敛；② 稳定裕度。
test('heldStep 一阶收敛：步长细化一半，误差近似减半（而不是"相等"）', () => {
  const k = CONFIG.grab.followStiffness;
  const ref = (dt, n) => {              // 细步参考解
    let pos = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
    for (let i = 0; i < n; i += 1) {
      const s = heldStep({ pos, vel, target: { x: 1, y: 0 }, dt, k });
      pos = { x: s.x, y: s.y }; vel = { x: s.vx, y: s.vy };
    }
    return pos.x;
  };
  const fine = ref(1 / 6000, 100);
  const e1 = Math.abs(ref(1 / 60, 1) - fine);
  const e2 = Math.abs(ref(1 / 120, 2) - fine);
  assert.ok(e1 > 0, '夹具在空转：粗步长没有误差');
  assert.ok(e2 < e1 * 0.75, `细化一半步长误差没降下来（${e1.toExponential(2)} → ${e2.toExponential(2)}）`);
  assert.ok(e2 > e1 * 0.25, `误差降得太快（>4×）不像一阶，大概是把 dt 写成 dt² 了`);
});

test('heldStep 的稳定裕度：ω·dt 必须留在实测振铃点之下', () => {
  // 实测扫描（k=320…2500）：ω·dt = √k · fixedDt 到 0.83（k=2500）时出现 88 帧过冲，
  // 也就是半隐式在粗步长下**不是真临界阻尼**，会数值振铃。
  // 阈值取 0.8 —— 不是"当前值离它有多远"的洁癖，而是这个 k 是给人调的手感旋钮：
  // 调到 2500 会红，且红的不是实现而是这条测试自己，注释会告诉他为什么。
  const wdt = Math.sqrt(CONFIG.grab.followStiffness) * CONFIG.fixedDt;
  assert.ok(wdt < 0.8, `ω·dt=${wdt.toFixed(3)} 已到实测振铃点（0.83）：身体会在手里发抖`);
});

test('heldStep 收敛用时与过冲帧数（回填 followStiffness 的那两个读数）', () => {
  const k = CONFIG.grab.followStiffness;
  const trail = drive(0, 0, 1, 120, 1 / 60, k);
  const over = trail.filter((p) => p.x > 1.0000001).length;
  const t95 = trail.find((p) => p.x > 0.95);
  assert.equal(over, 0, `零过冲是临界阻尼的定义，实测 ${over} 帧`);
  assert.ok(t95, '120 tick 内没收敛到 95%');
  const ms = ((trail.indexOf(t95) + 1) / 60) * 1000;
  assert.ok(ms >= 100 && ms <= 200, `95% 收敛 ${ms.toFixed(1)}ms，不在 100–200ms 的手感区间`);
});

// ---------------------------------------------------------------- 反应的系数
const CR = (o = {}) => ({ age: 960, traits: { size: 26, personality: {
  clingy: o.clingy ?? 0.5, irritable: o.irritable ?? 0.5, bold: 0.5 } } });

test('enjoyOf 三个方向各自单调；中位是 0.5 而不是被默认值推到偏享受（R-2）', () => {
  const mid = enjoyOf(CR({}), 0.5);
  assert.ok(Math.abs(mid - 0.5) < 1e-12,
    `默认个体的 enjoy 不在 0.5（实为 ${mid}）—— 三项直接相加会把它推到 0.825，于是全缸一律"喜欢被拎"`);
  assert.ok(enjoyOf(CR({ clingy: 1 }), 0.5) > mid, '黏人的应该更享受');
  assert.ok(enjoyOf(CR({ irritable: 1 }), 0.5) < mid, '易怒的应该更抗拒');
  assert.ok(enjoyOf(CR({}), 0.9) > mid, '好感高的应该更享受');
  assert.ok(enjoyOf(CR({}), 0) < mid, '陌生个体不该比半生不熟的更享受');
});

test('enjoyOf 极端基因推得到两端，脏输入不抛不 NaN', () => {
  assert.equal(enjoyOf(CR({ clingy: 1, irritable: 0 }), 1), 1, '满配黏人 + 满好感该推到顶');
  assert.equal(enjoyOf(CR({ clingy: 0, irritable: 1 }), 0), 0, '满配易怒 + 生面孔该推到底');
  assert.ok(enjoyOf(CR({ clingy: 0, irritable: 0 }), 0) >= 0.2, '三项全 0 不许直接判成"被吓"');
  for (const bad of [{}, { traits: {} }, { traits: { personality: {} } }, null]) {
    assert.equal(typeof enjoyOf(bad ?? {}, NaN), 'number', '脏输入不许抛，也不许 NaN');
    assert.ok(Number.isFinite(enjoyOf(bad ?? {}, NaN)));
  }
});

test('carryEffects：手不动（无摇）仍买 familiarity，但不买好感、不积不适', () => {
  // familiarity（"认识"）与 affection（"喜欢"）是两条通道，**别一起门控**：
  // 手速为 0 就是"把它拎在手里不动"，那仍然是在理它。
  // 这条测试存在的意义，是让下一个想"顺手把 familiarity 也挂到 shake 上"的人必须解释为什么。
  const z = carryEffects({ enjoy: 0.5, speed: CONFIG.grab.shakeSpeedFloor - 0.01, dt: 1 / 60 });
  assert.deepEqual(z, {
    joy: 0, anger: 0, fear: 0, affection: 0, familiarity: CONFIG.grab.familiarityRate / 60,
  });
});

test('carryEffects：摇得越快不适越大；而同一 tick 只走一个方向（不许又哭又笑）', () => {
  const a = carryEffects({ enjoy: 0.1, speed: 0.3, dt: 1 });
  const b = carryEffects({ enjoy: 0.1, speed: 0.6, dt: 1 });
  assert.ok(b.fear > a.fear && b.anger > a.anger);
  // ⚠️ 这条抓的是混合式（joy 乘 e、anger 乘 1−e）：那种写法下抗拒的个体摇得越快 joy 也涨，
  // 等于"一边挣扎一边开心"。以中位为界切两段之后，joy 必须**恰好为 0**。
  assert.equal(a.joy, 0, `抗拒的那只还在积 joy（${a.joy}）= 又哭又笑`);
  const happy = carryEffects({ enjoy: 0.9, speed: 0.6, dt: 1 });
  assert.equal(happy.anger, 0, '享受的那只不该积愤怒');
  assert.equal(happy.fear, 0, '享受的那只不该积恐惧');
  assert.ok(happy.joy > 0);
});

// ⚠️ 这条是本仓库最容易被写坏的地方：只断"结果对不对"分不出实现。
// 好感**只在 enjoy > 0.5 才涨**，否则把手挂在那只身上就能刷满好感度（spec §5 的分工）。
test('carryEffects：enjoy ≤ 0.5 一律不买好感（刷不了）', () => {
  assert.equal(carryEffects({ enjoy: 0.5, speed: 0.4, dt: 1 }).affection, 0);
  assert.ok(carryEffects({ enjoy: 0.51, speed: 0.4, dt: 1 }).affection > 0);
});

test('carryEffects 的脏输入不抛、不 NaN，dt=0 时全是 0', () => {
  for (const bad of [{}, { enjoy: NaN, speed: NaN, dt: NaN }, null]) {
    const z = carryEffects(bad ?? {});
    for (const v of Object.values(z)) assert.ok(Number.isFinite(v), JSON.stringify(z));
  }
  const z = carryEffects({ enjoy: 0.9, speed: 1, dt: 0 });
  for (const v of Object.values(z)) assert.equal(v, 0);
});

test('heldStep：目标与位置重合时不晃（位置不动、速度归零）', () => {
  const s = heldStep({ pos: { x: 0.3, y: 0.4 }, vel: { x: 0, y: 0 }, target: { x: 0.3, y: 0.4 },
    dt: 1 / 60, k: CONFIG.grab.followStiffness });
  assert.ok(Math.abs(s.vx) < 1e-12 && Math.abs(s.x - 0.3) < 1e-12, JSON.stringify(s));
});

test('heldStep 的脏输入退化而不抛：dt 非有限 ⇒ 原样交出', () => {
  const s = heldStep({ pos: { x: 0.2, y: 0.3 }, vel: { x: 1, y: 1 }, target: { x: 0.8, y: 0.3 },
    dt: NaN, k: CONFIG.grab.followStiffness });
  assert.equal(s.x, 0.2);
  assert.equal(s.vx, 1);
});
