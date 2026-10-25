// body.js 是纯逻辑模块（不碰 DOM / canvas），所以 spec §4.7 那句
// "形变必须带过冲回弹（squash & stretch + overshoot）"、§4.7.1 那句
// "尾巴 = 3 段 Verlet 链，长由体型派生，摆速 = base × (0.4 + activity) × (1 + arousal)"、
// §4.7 那句"毛长 = fluff × 0.18 × 身体半径"全都是**机器可查**的，不必等人在浏览器里盯着看。
//
// 相对旧计划 Task 2 的三处必改（计划 2R 明文）：
//   1. 目标半径数组从"圆"改成"五角星"（5 外角 + 5 内凹，STAR_INNER_RATIO = 0.62）。
//      ⇒ 本文件里凡是旧计划写"静止时均匀落在单位圆上"的断言都改成了"落在星形轮廓上"，
//        并新增一组"它真的是五角星、不是圆"的形状断言。
//   2. 加 3 段尾巴的 Verlet 链（长度由体型派生，**不新增基因**）。
//   3. fluff 进 body 状态并暴露给渲染层读（渲染纪律"只画毛尖碎边、2 张 sprite"属 B14）。
//
// 旧计划里**没搬**的东西（照搬会挂，全部已 grep 确认 src/ 里不存在）：
//   court / courtship / courtshipFactor / canCourt / startCourtship —— 内核改孤雌 brood 后删净。
//   旧 Task 2 的测试清单本身没有引用它们，所以本文件没有"删掉某条测试"，只有下面两处修正。
//
// 两处对旧计划的修正（都在回报里点名）：
//   · makeCreature 的 age 用 960 而不是旧计划写的 600：growthFactor 的成体峰值 1.00
//     在 BOUNDARIES[2] = 960 才取到（600 是 0.8875），旧计划那行注释"成体，growthFactor = 1.00"
//     本身就对不上 creature.js 的分段。形状断言不依赖它，但"体型派生"那几条依赖。
//   · 旧计划「撞墙也能被检出」那条用 2 秒窗口断言 dip < 1e-6，实测按 dentDecay = 6.0
//     只衰减到 2.1e-6（exp(-12) × dentMax 0.34）。改成 4 秒窗口 + 保持 1e-6 的阈值，
//     即**延长观察窗而不是放宽阈值**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createBody, updateBody, springParams, meanRadius, starRadius,
  blinkInterval, tailSwingRate, reconcileBodies, updateBodies, renderSizeOf } from '../src/body.js';
import { createCreature, sizeOf } from '../src/creature.js';
import { randomGenome } from '../src/genes.js';
import { createRng } from '../src/rng.js';

// 与 tests/constraints.test.js 同一套剥注释启发式：源码扫描类断言必须先看代码不看散文，
// 否则"模块头注释里解释纪律"的那些词会被当成违规（第一天就红、然后被人注释掉）。
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

const DT = CONFIG.fixedDt;
const TAU = Math.PI * 2;

const emo = (over) => ({
  joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0, ...over,
});

// 造一只"标准生物"。不靠 createCreature：body.js 只读字段，
// 用一个普通对象就够了，而且这样测试不会连带把内核的构造校验拖进来。
// （下面 fluff 那一组里有一条**故意**用真 createCreature，那是为了钉"基因 → 表现层"的接线。）
const makeCreature = (over) => ({
  traits: { wobble: 0.5, size: 26, fluff: 0.5, personality: { activity: 0.5 } },
  emotions: emo(),
  vel: { x: 0, y: 0 },
  facing: { x: 1, y: 0 },
  pos: { x: 0.5, y: 0.5 },
  moving: false,
  alive: true,
  dying: 0,
  sick: false,
  age: 960,          // 成体峰值，growthFactor = 1.00（见文件头的修正条）
  eggBoost: 0,
  ...over,
});

const withTraits = (over) => makeCreature({
  traits: { wobble: 0.5, size: 26, fluff: 0.5, personality: { activity: 0.5 }, ...over },
});

const run = (body, c, seconds) => {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) updateBody(body, c, DT);
};

const radiusOf = (p) => Math.hypot(p.x, p.y);

// 尾尖相对挂点的距离（局部单位：身体半径 = 1）
const tipDistance = (body) => {
  const anchor = body.points[body.tailAnchor];
  const tip = body.tail.nodes[body.tail.nodes.length - 1];
  return Math.hypot(tip.x - anchor.x, tip.y - anchor.y);
};

// 摆动的过零计数：drive = amp × sin(phase) 是尾链的**驱动力**，
// 数它的符号翻转就等于数"摇了多少次"，比量坐标差更直接，也不受形状漂移干扰。
const countCrossings = (body, c, seconds) => {
  let prev = 0;
  let n = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    updateBody(body, c, DT);
    const d = body.tail.drive;
    if (prev !== 0 && d !== 0 && (d < 0) !== (prev < 0)) n += 1;
    if (d !== 0) prev = d;
  }
  return n;
};

const maxAbsDrive = (body, c, seconds) => {
  let m = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    updateBody(body, c, DT);
    m = Math.max(m, Math.abs(body.tail.drive));
  }
  return m;
};

// ---------------------------------------------------------------- 骨架：弹簧与控制点

test('createBody 造出 bodyPoints 个点，静止位落在五角星轮廓上（不是单位圆）', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  assert.equal(body.points.length, CONFIG.bodyPoints);
  assert.equal(body.dip.length, CONFIG.bodyPoints);
  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    const a = (i / CONFIG.bodyPoints) * TAU;
    // 角度采样（计划 2R 明文；spec §5.1 原文"按弧长分布"见回报的偏离条）
    const r = starRadius(a);
    assert.ok(Math.abs(p.x - Math.cos(a) * r) < 1e-12, `点 ${i} 的 x 不在星形轮廓上`);
    assert.ok(Math.abs(p.y - Math.sin(a) * r) < 1e-12, `点 ${i} 的 y 不在星形轮廓上`);
    // rx/ry 是静止位，此后不变；render 与测试都靠它当基准
    assert.equal(p.rx, p.x);
    assert.equal(p.ry, p.y);
    assert.equal(p.vx, 0);
    assert.equal(p.vy, 0);
    assert.equal(body.dip[i], 0);
  }
});

test('springParams：wobble 越高越软越弹，且两端都欠阻尼（spec §4.7 要求过冲）', () => {
  const stiff = springParams(0);
  const soft = springParams(1);
  assert.ok(stiff.stiffness > soft.stiffness, 'wobble 高应当更软（刚度更低）');
  assert.ok(stiff.zeta > soft.zeta, 'wobble 高应当更弹（阻尼比更低）');
  // 阻尼比必须 < 1，否则是临界/过阻尼，不会过冲 —— spec §4.7 的"必须带过冲回弹"就没了
  assert.ok(stiff.zeta < 1 && soft.zeta < 1, '两端都必须欠阻尼');
  // 中点必须是两端之间，且 wobble 越界要 clamp（基因值是 [0,1]，但脏存档会给 1.7）
  const mid = springParams(0.5);
  assert.ok(mid.stiffness < stiff.stiffness && mid.stiffness > soft.stiffness);
  assert.equal(springParams(9).stiffness, soft.stiffness, 'wobble 越界必须被 clamp');
  // 阻尼系数由刚度与阻尼比推出（damping = 2√k·ζ），不是独立旋钮，
  // 否则两个旋钮能被调成互相矛盾的组合
  assert.ok(Math.abs(stiff.damping - 2 * Math.sqrt(stiff.stiffness) * stiff.zeta) < 1e-12);
});

// 把呼吸脉动从读数里除掉：meanRadius 是"弹簧状态 × 整体胀缩"，而胀缩是**均匀**乘在
// 所有目标上的，所以除以同一时刻的 breathe 因子（两个数都由 body 自己公开）就能还原弹簧状态。
// 不除的话这条测量是**假的**：变异探针把 zetaAtFullWobble 调成 1.2（过阻尼、物理上不会过冲）
// 之后原写法照样绿 —— 因为 joy=1 时脉动幅度是 0.08，单点峰值与稳态之差 0.08 除以
// 阶跃量 0.13 就有 0.6 的"假过冲"，比真过冲（30.9% × 0.13 ≈ 0.04）还大。
const correctedRadius = (body) => meanRadius(body) / (1 + body.pulse * Math.sin(body.phase * TAU));

test('wobble=1 的过冲明显大于 wobble=0（"有的孩子天生更 Q，有的更挺"）', () => {
  // 手法：给一个阶跃目标（突然把 joy 从 0 拉到 1 ⇒ 目标半径膨胀），
  // 然后逐步记录最大半径。过冲 = 最大半径超过最终稳态半径的部分。
  const measure = (wobble) => {
    const body = createBody({ wobble, fluff: 0.5 });
    const c = makeCreature({ traits: { wobble, size: 26, fluff: 0.5, personality: { activity: 0.5 } } });
    run(body, c, 1.0);                       // 先收敛到 joy=0 的稳态
    const base = correctedRadius(body);
    c.emotions.joy = 1;                      // 阶跃
    let peak = 0;
    for (let i = 0; i < Math.round(1.5 / DT); i++) {
      updateBody(body, c, DT);
      peak = Math.max(peak, correctedRadius(body));
    }
    // 稳态取长时间收敛之后的读数（1.5 秒处还没收敛完）
    for (let i = 0; i < Math.round(6 / DT); i++) updateBody(body, c, DT);
    const settled = correctedRadius(body);
    return (peak - settled) / (settled - base);
  };
  const overSoft = measure(1);
  const overStiff = measure(0);
  assert.ok(overSoft > 0.05, `wobble=1 必须有可辨的过冲（spec §4.7：形变必须带过冲回弹），实测 ${overSoft.toFixed(4)}`);
  assert.ok(overStiff > 0.005, `wobble=0 也必须过冲，只是幅度小（spec §4.7：两端都要 overshoot），实测 ${overStiff.toFixed(4)}`);
  assert.ok(overSoft > overStiff * 2, `软的过冲应当显著更大：实测 ${overSoft.toFixed(4)} vs ${overStiff.toFixed(4)}`);
});

// 稳态平均半径：把 meanRadius 在一段**多个呼吸周期**上取时间平均。
// 直接读单个时刻的 meanRadius 会被脉动污染 —— pulseAmpBase 0.03、加上 joy 是 0.08，
// 也就是 ±8% 的整圈胀缩；而"joy 应当膨胀 16%"、"sleepy 把形变压到一半以下"这两条
// 要分辨的分别是 13% 与 3.9%。不平均的话，测到的相位数就能决定断言的红绿。
const steadyRadius = (body, c, settle, window) => {
  run(body, c, settle);
  const steps = Math.round(window / DT);
  let s = 0;
  for (let i = 0; i < steps; i++) { updateBody(body, c, DT); s += meanRadius(body); }
  return s / steps;
};

const radiusWith = (emotions, over) => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  return steadyRadius(body, makeCreature({ emotions, ...over }), 4, 30);
};

test('joy 膨胀、fear 收缩、方向与 spec §4.5 的表一致', () => {
  const neutral = radiusWith(emo());
  const joyful = radiusWith({ joy: 1 });
  const afraid = radiusWith({ fear: 1 });
  assert.ok(joyful > neutral, `开心应当膨胀：${joyful.toFixed(4)} vs ${neutral.toFixed(4)}`);
  assert.ok(afraid < neutral, `害怕应当收缩：${afraid.toFixed(4)} vs ${neutral.toFixed(4)}`);
  // 两侧都要有**量级**：只差 0.5% 的话"膨胀"这件事肉眼看不见
  assert.ok(joyful / neutral > 1.05, `膨胀幅度应当可辨，实测 ${joyful.toFixed(4)} vs ${neutral.toFixed(4)}`);
  assert.ok(afraid / neutral < 0.95, `收缩幅度应当可辨，实测 ${afraid.toFixed(4)} vs ${neutral.toFixed(4)}`);
});

test('anger 把身体压扁且前端变尖（垂直 facing 缩短、正前方推远）', () => {
  const extent = (anger) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ emotions: emo({ anger }) });
    run(body, c, 2.0);
    let fwd = 0, side = 0;
    for (const p of body.points) {
      fwd = Math.max(fwd, p.x);       // 局部 +x = facing 方向
      side = Math.max(side, Math.abs(p.y));
    }
    return { fwd, side };
  };
  const calm = extent(0);
  const mad = extent(1);
  assert.ok(mad.side < calm.side, '生气应当压扁（垂直 facing 的半径变小）');
  assert.ok(mad.fwd > calm.fwd, '生气应当前端变尖（正前方被推远）');
});

test('运动挤压体积守恒（squash & stretch 不是把身体拉大）', () => {
  // 用鞋带公式算闭合多边形的有向面积。拉长与压扁必须互相抵消，
  // 否则"游得越快就越大"，星形团子会在逃命时膨胀成气球。
  const area = (body) => {
    let s = 0;
    const n = body.points.length;
    for (let i = 0; i < n; i++) {
      const a = body.points[i];
      const b = body.points[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  };
  const still = createBody({ wobble: 0.5, fluff: 0.5 });
  const moving = createBody({ wobble: 0.5, fluff: 0.5 });
  const cStill = makeCreature({});
  const cMoving = makeCreature({
    vel: { x: CONFIG.motion.baseSpeed * 2, y: 0 },
    moving: true,
  });
  run(still, cStill, 2.0);
  run(moving, cMoving, 2.0);
  const ratio = area(moving) / area(still);
  assert.ok(Math.abs(ratio - 1) < 0.03, `面积比应当接近 1，实测 ${ratio.toFixed(4)}`);
  // 而且确实被拉长了：不然"恒等于 1"可以靠"什么都没做"混过去
  const longAxis = (body) => Math.max(...body.points.map((p) => Math.hypot(p.x, p.y)));
  assert.ok(Math.max(...moving.points.map((p) => p.x)) > Math.max(...still.points.map((p) => p.x)),
    '沿速度轴必须真的拉长过，否则守恒是空转');
  assert.ok(longAxis(moving) > 0);
});

test('睡眠把情绪形变压到极小（spec §4.5：形变幅度极小）', () => {
  const base = radiusWith(emo());
  const awakeJoy = radiusWith({ joy: 1 });
  const sleepyJoy = radiusWith({ joy: 1, sleepy: 1 });
  const awakeDelta = Math.abs(awakeJoy - base);
  const sleepyDelta = Math.abs(sleepyJoy - base);
  assert.ok(sleepyDelta < awakeDelta * 0.5,
    `困倦时同样的 joy 应当只造成一半以下的形变：${sleepyDelta.toFixed(4)} vs ${awakeDelta.toFixed(4)}`);
  // 而且困倦不等于停止呼吸（脉动下限那条旋钮）
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  run(body, makeCreature({ emotions: emo({ sleepy: 1 }) }), 4.0);
  assert.ok(body.pulse > 0, 'sleepy=1 时仍要有一丝脉动，完全静止会读成"死了"');
});

test('位置突变会在受冲击的那一侧压出凹陷（spec §5.1 碰撞局部凹陷）', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({});
  run(body, c, 1.0);                       // 先稳住
  const before = body.points.map((p) => ({ x: p.x, y: p.y }));

  // 模拟"被同类从 +x 方向推开"：位置沿 -x 跳一下。
  // resolve() 就是这么做的（直接改 pos，不改 vel）。
  c.pos.x -= 0.01;
  updateBody(body, c, DT);
  for (let i = 0; i < 3; i++) updateBody(body, c, DT);   // 让凹陷传进弹簧

  // 受冲击侧是 +x（撞它的那只来自 +x），所以 +x 侧的点应当被压得更靠近圆心
  const frontNow = Math.max(...body.points.map((p) => p.x));
  const frontBefore = Math.max(...before.map((p) => p.x));
  assert.ok(frontNow < frontBefore,
    `+x 侧应当凹进去：${frontNow.toFixed(4)} vs ${frontBefore.toFixed(4)}`);
});

test('冲击方向投影到 facing 局部轴：朝向转过去之后，凹的应当是局部那一侧', () => {
  // 这条钉的是**从旧计划搬过来的一处修正**。旧代码把世界位移 (dx, dy) 直接当局部方向用，
  // 只在 facing = (1,0) 时碰巧正确（旧测试恰好全用 (1,0)）。真实缸里朝向是任意角度，
  // 于是"被撞的位置在身后、凹陷却压在局部头顶"—— 玩家看到的是"它被从后面撞了一下，
  // 结果前脸瘪了"。
  //
  // 断言读的是 **dip 数组**而不是坐标：坐标上还叠着整体呼吸脉动（±3%–8%），
  // 用坐标比大小会先被脉动相位决定红绿（这是本轮实测踩到的一次，见文件头修正条）。
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  // 朝上（局部 +x = 世界的 +y），然后沿世界的 +y 跳 = 沿 facing 向前跳
  // ⇒ 位移在局部里是 +x ⇒ 受冲击侧是局部 −x（身后），前脸不该瘪。
  const c = makeCreature({ facing: { x: 0, y: 1 } });
  run(body, c, 1.0);
  assert.equal(Math.max(...body.dip), 0, '前置条件：匀速静止时没有任何凹陷');
  c.pos.y += 0.01;
  updateBody(body, c, DT);
  const frontDip = body.points.reduce((s, p, i) => Math.max(s, p.rx > 0 ? body.dip[i] : 0), 0);
  const rearDip = body.points.reduce((s, p, i) => Math.max(s, p.rx < 0 ? body.dip[i] : 0), 0);
  assert.ok(rearDip > 0, `身后（局部 −x，尾巴挂点那一侧）必须有凹陷，实测 ${rearDip}`);
  assert.equal(frontDip, 0, '前脸一点凹陷都不该有 —— 有就说明位移没投影到 facing 轴上');
  // 尾巴挂点正是那个受冲击的凹角：挂点侧的 dip 必须就是最大 dip（星形挂点与冲击侧对齐）
  assert.ok(body.dip[body.tailAnchor] > 0, '挂点侧正是受冲击侧，尾巴应当跟着被压进去');
});

test('撞墙能被检出：逃命速度下贴墙压出凹陷（朝墙那一侧），之后按 dentDecay 衰减干净', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const wall = 1 - CONFIG.motion.wallMargin;
  const flee = CONFIG.motion.baseSpeed * CONFIG.motion.fleeFactor;
  const c = makeCreature({ pos: { x: 0.9, y: 0.5 }, vel: { x: flee, y: 0 }, moving: true });
  // 先平滑地游一段（这段时间不许出凹陷），再让 pos 被墙截住
  for (let i = 0; i < 40 && c.pos.x < wall; i++) {
    c.pos.x = Math.min(wall, c.pos.x + flee * DT);
    updateBody(body, c, DT);
  }
  assert.ok(c.pos.x >= wall - 1e-12, '前置条件：这一只确实贴到了墙上');
  for (let i = 0; i < 2; i++) updateBody(body, c, DT);   // 位置不再变化（贴墙）
  const sideDip = (sign) => body.points.reduce(
    (s, p, i) => (sign(p.rx) ? Math.max(s, body.dip[i]) : s), 0);
  const front = sideDip((rx) => rx > 0);
  const rear = sideDip((rx) => rx < 0);
  assert.ok(front > 0, '贴墙瞬间朝墙那一侧（局部 +x）必须压出凹陷 —— vel 在墙上没有任何信号，只有二阶差分有');
  assert.ok(front > rear, `凹陷必须在受冲击那一侧：前侧 ${front.toFixed(5)} vs 后侧 ${rear.toFixed(5)}`);
  for (let i = 0; i < Math.round(4 / DT); i++) updateBody(body, c, DT);
  assert.ok(Math.max(...body.dip) < 1e-6, `凹陷应当衰减干净，实测 ${Math.max(...body.dip)}`);
});

test('impactEps 的实际效果（已知降级，写清楚而不是假装）：匀速游动不误报，base 速度的急停也不出信号', () => {
  // CONFIG.body.impactEps = 0.0012，而一个子步的匀速位移 = baseSpeed × fixedDt = 0.000917。
  // ⇒ 二阶差分最高的情形（从匀速到骤停）是 0.000917，**低于**阈值。
  // 也就是说：慢速贴墙不会有凹陷，只有 flee（×2.2 ⇒ 0.002017）以上才有。
  // 这条不是给实现开脱 —— 它是把"阈值挡掉了什么"变成一个断言：
  // 将来谁把 impactEps 调到 0.0009 以下，匀速游动会被判成连续冲击（凹陷一路刷过去），这条立刻红。
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const step = CONFIG.motion.baseSpeed * DT;
  const c = makeCreature({ vel: { x: CONFIG.motion.baseSpeed, y: 0 }, moving: true });
  for (let i = 0; i < 60; i++) { c.pos.x += step; updateBody(body, c, DT); }
  assert.equal(Math.max(...body.dip), 0, '平滑游动期间必须一个凹陷都没有');
  for (let i = 0; i < 3; i++) updateBody(body, c, DT);   // 骤停：位移从 step 变 0
  assert.equal(Math.max(...body.dip), 0,
    'base 速度的骤停在阈值之下 —— 这是 impactEps 的读数，不是实现漏洞，但必须被写下来');
});

const handAt = (c, dx, dy) => ({
  pos: { x: c.pos.x + dx, y: c.pos.y + dy },
  speed: 0, down: true, appeared: false, grab: null,
});

test('被摸时只压凹离手最近的角，正后方保持零凹陷', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ beingPetted: true });
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  assert.ok(body.dip[0] > 0, '手在局部 +x，正前方的外角必须凹下去');
  const expected = CONFIG.body.petDentMax * Math.exp(-CONFIG.body.dentDecay * DT);
  assert.ok(Math.abs(body.dip[0] - expected) < 1e-12,
    `最近角的凹陷应来自 petDentMax，实测 ${body.dip[0]}，期望 ${expected}`);
  for (let i = 0; i < body.points.length; i++) {
    if (body.points[i].rx < 0) assert.equal(body.dip[i], 0, `远侧点 ${i} 不该跟着凹`);
  }
});

test('手方向先投影到 facing：世界方向变了，仍凹局部离手最近的那一角', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ facing: { x: 0, y: 1 }, beingPetted: true });
  updateBody(body, c, DT, handAt(c, 0, 0.02));
  assert.ok(body.dip[0] > 0, '世界 +y 与 facing 同向，应凹局部 +x 的角');
  assert.equal(body.dip[12], 0, '局部正后方不该凹');

  const sideBody = createBody({ wobble: 0.5, fluff: 0.5 });
  const sideC = makeCreature({ facing: { x: 0, y: 1 }, beingPetted: true });
  updateBody(sideBody, sideC, DT, handAt(sideC, 0.02, 0));
  assert.ok(sideBody.dip[18] > 0, 'facing 为世界 +y 时，世界 +x 是局部 -y，应凹第 18 点一侧');
  assert.equal(sideBody.dip[6], 0, '局部 +y 侧不该凹；若凹了就说明侧向投影符号反了');
});

test('连续摸不累加，松手后仍按 dentDecay 回弹干净', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ beingPetted: true });
  const hand = handAt(c, 0.02, 0);
  for (let i = 0; i < 120; i++) updateBody(body, c, DT, hand);
  assert.ok(body.dip[0] > CONFIG.body.petDentMax * 0.9,
    `持续接触要维持可见凹陷，实测 ${body.dip[0]}`);
  assert.ok(body.dip[0] <= CONFIG.body.petDentMax,
    `每子步取最大而不是累加，凹陷不得越过 ${CONFIG.body.petDentMax}`);
  c.beingPetted = false;
  for (let i = 0; i < Math.round(4 / DT); i++) updateBody(body, c, DT);
  assert.ok(Math.max(...body.dip) < 1e-6, `松手 4 秒后应回弹干净，实测 ${Math.max(...body.dip)}`);
});

test('手凹陷与碰撞在不同侧各自成立', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({});
  run(body, c, 1);
  body.dip[12] = CONFIG.body.dentMax;
  c.beingPetted = true;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  assert.ok(body.dip[0] > 0, '碰撞在后侧时，手仍应在前侧压出自己的凹陷');
  assert.ok(body.dip[12] >= CONFIG.body.dentMax * Math.exp(-CONFIG.body.dentDecay * DT) - 1e-12,
    '手部凹陷不许把另一侧更深的碰撞凹陷抹掉');
});

test('同侧浅抚摸不覆盖更深的碰撞凹陷', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ beingPetted: true });
  body.dip[0] = CONFIG.body.dentMax;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  const expected = CONFIG.body.dentMax * Math.exp(-CONFIG.body.dentDecay * DT);
  assert.ok(Math.abs(body.dip[0] - expected) < 1e-12,
    `同一点的深碰撞只能按原衰减保留，不能被浅抚摸写成 ${CONFIG.body.petDentMax}：${body.dip[0]}`);
});

test('updateBodies 把同一份手交给被摸的那只，被拎住的不产生抚摸凹陷', () => {
  const petted = makeCreature({ beingPetted: true });
  petted.id = 'petted';
  const held = makeCreature({ beingPetted: false, held: true });
  held.id = 'held';
  const world = { creatures: [petted, held], playerHand: handAt(petted, 0.02, 0) };
  const bodies = new Map();
  updateBodies(bodies, world, DT);
  assert.ok(bodies.get('petted').dip[0] > 0, 'world.playerHand 必须真正接到 body 的手部凹陷');
  assert.equal(Math.max(...bodies.get('held').dip), 0, '拎着是追随，不是抚摸');
});

test('updateBody 不分配对象：points、dip、tail.nodes 与每个点对象都是同一批（spec §5.3）', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ vel: { x: 0.02, y: 0.01 }, moving: true });
  const pointsRef = body.points;
  const pointRefs = body.points.map((p) => p);
  const dipRef = body.dip;
  const tailRef = body.tail;
  const nodesRef = body.tail.nodes;
  const nodeRefs = body.tail.nodes.map((nd) => nd);
  run(body, c, 1.0);
  assert.equal(body.points, pointsRef, 'points 数组必须是同一个引用');
  assert.equal(body.dip, dipRef, 'dip 必须是同一个 Float64Array');
  assert.equal(body.tail, tailRef, 'tail 必须是同一个对象');
  assert.equal(body.tail.nodes, nodesRef, 'nodes 数组必须是同一个引用');
  for (let i = 0; i < nodeRefs.length; i++) {
    assert.equal(body.tail.nodes[i], nodeRefs[i], `尾节点 ${i} 不得每步新建`);
  }
  for (let i = 0; i < pointRefs.length; i++) {
    assert.equal(body.points[i], pointRefs[i], `点 ${i} 必须是同一个对象，不得每步新建`);
  }
});

test('长时程后所有坐标仍然有限（交接要求第 1 条的同款纪律）', () => {
  // 计划 1 的教训：clamp01 会原样放过 NaN，而 NaN 分量在渲染里表现为"这只生物不见了"，
  // 全程不报错。所以形变层也要有一条长时程有限性断言。
  const body = createBody({ wobble: 1, fluff: 1 });
  const c = makeCreature({
    emotions: emo({ joy: 1, anger: 1, fear: 1, curiosity: 1, sleepy: 1, arousal: 1 }),
    vel: { x: 0.3, y: -0.3 },
    moving: true,
  });
  run(body, c, 60.0);
  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `点 ${i} 坐标不是有限数`);
    assert.ok(Number.isFinite(p.vx) && Number.isFinite(p.vy), `点 ${i} 速度不是有限数`);
    assert.ok(Number.isFinite(body.dip[i]), `点 ${i} 凹陷量不是有限数`);
  }
  for (const nd of body.tail.nodes) {
    assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y) && Number.isFinite(nd.px) && Number.isFinite(nd.py),
      '尾节点坐标不是有限数');
  }
  // 极端情绪全开 60 秒后形状仍然合理：半径不该爆掉也不该塌成 0
  const r = meanRadius(body);
  assert.ok(r > 0.2 && r < 3, `半径失控：${r}`);
  assert.ok(Math.abs(body.tail.drive) < 3, `驱动力失控：${body.tail.drive}`);
});

test('情绪字段缺失（脏存档）不会把形状变成 NaN', () => {
  // 读档路径给的对象可能少了 arousal；NaN 在渲染里的症状是"这只不见了"且不报错，
  // 所以形变层要把它按 0 处理，而不是让 NaN 一路乘进坐标。
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({ emotions: { joy: 0.5 } });
  run(body, c, 1.0);
  for (const p of body.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  for (const nd of body.tail.nodes) assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y));
});

test('死亡溶散期间身体逐渐塌陷（表现层读 c.dying，不自己另计时间）', () => {
  const radiusAt = (dying) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ alive: false, dying });
    run(body, c, 1.0);
    return meanRadius(body);
  };
  const fresh = radiusAt(0);
  const half = radiusAt(CONFIG.dissolveDuration / 2);
  const late = radiusAt(CONFIG.dissolveDuration * 0.95);
  assert.ok(half < fresh, '溶散到一半应当已经缩小');
  assert.ok(late < half, '越接近溶散结束越小');
  assert.ok(late > 0, '不得塌成 0（0 半径会让 render 的渐变退化）');
});

test('sick 个体几乎不动（sim 要求它被画成"变暗、静止"）', () => {
  const jitter = (sick) => {
    const body = createBody({ wobble: 1, fluff: 1 });
    const c = makeCreature({ sick, emotions: emo({ joy: 1, arousal: 1 }) });
    run(body, c, 1.0);
    const first = body.points.map((p) => p.x);
    let maxDelta = 0;
    for (let i = 0; i < 30; i++) {
      updateBody(body, c, DT);
      for (let j = 0; j < first.length; j++) maxDelta = Math.max(maxDelta, Math.abs(body.points[j].x - first[j]));
    }
    return maxDelta;
  };
  const healthy = jitter(false);
  const ill = jitter(true);
  assert.ok(ill < healthy * 0.25, `sick 的形变幅度应当压到 1/4 以下：${ill.toFixed(5)} vs ${healthy.toFixed(5)}`);
});

test('body.js 不 import perceive（交接义务第 2 条：tick 之外调它会抛 TypeError）', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/body.js', import.meta.url)), 'utf8');
  // 剥注释是必需的：body.js 的模块头就要靠提到 perceive 来说明纪律（同 constraints.test.js 的理由）。
  const src = stripComments(raw);
  assert.ok(!/\bperceive\b/.test(src),
    'perceive 在 tickWorld 之外调用会因 world.grid 的旧下标抛 TypeError；表现层一律不调它');
});

test('renderSizeOf 与 creature.sizeOf 是同一个实现（体型只有一个出处）', () => {
  const c = makeCreature({ age: 960 });
  assert.equal(renderSizeOf(c), sizeOf(c));
  assert.ok(renderSizeOf(makeCreature({ age: 0 })) < sizeOf(c), '幼体必须更小');
});

// ---------------------------------------------------------------- 五角星目标轮廓

test('星臂剖面**逐点**贴住 assets 里那只星绒绒（D-1 标尺）', () => {
  // 标尺怎么来的（两步，缺一不可）：
  //  ① `.superpowers/sdd/tmp/measure-star.mjs` 零依赖解 PNG（zlib + 手写 unfilter），
  //     取 alpha>128 的实心轮廓，360 条射线各二分找轮廓半径。八张表情图共用同一个身体，数一致。
  //  ② `.superpowers/sdd/tmp/d1-phase.mjs` 把这条轮廓按 72° **对称化**（瓣尖相位 55°+72k，
  //     代价函数取"凹/尖最小"的那个对齐 —— 错相位会把凹口抹平）。
  // 第②步是本轮补的：素材那只戴睡帽、有手脚，**单条**轮廓直接取 min/max 会读到 0.545，
  // 而那只是"帽子压在左瓣上"的一条深沟；五瓣平均之后的凹口是 **0.71**
  // （逐瓣单独量的凹/尖 = 0.55 0.56 0.64 0.69 0.70 0.70 0.77 0.77 0.77 0.80，中位 0.70）。
  // 上一版把 innerRatio 定成 0.55 就是被 ① 单独误导的结果，这条测试钉住它不许回去。
  // 下面这张表就是对称化之后的半边轮廓：瓣尖 0° → 凹口 36°，**每 1° 一点、共 37 点**，
  // 整条再除以平均瓣尖高（素材五瓣不等长，不除就成了比"谁画得大"而不是比形状）。
  const ASSET = [
    1.0000, 0.9990, 0.9990, 0.9981, 0.9932, 0.9894, 0.9884, 0.9826, 0.9758, 0.9681,
    0.9613, 0.9526, 0.9429, 0.9332, 0.9226, 0.9109, 0.9003, 0.8858, 0.8742, 0.8616,
    0.8480, 0.8345, 0.8190, 0.8045, 0.7899, 0.7764, 0.7628, 0.7502, 0.7435, 0.7348,
    0.7280, 0.7202, 0.7164, 0.7135, 0.7115, 0.7096, 0.7106,
  ];
  const at = (deg) => starRadius(deg * Math.PI / 180) / starRadius(0);
  let sse = 0, worst = 0, worstAt = 0;
  for (let d = 0; d < ASSET.length; d++) {
    const e = at(d) - ASSET[d];
    sse += e * e;
    if (Math.abs(e) > Math.abs(worst)) { worst = e; worstAt = d; }
  }
  const rms = Math.sqrt(sse / ASSET.length);
  // 阈值不是拍的。同一把尺子下四条剖面（`.superpowers/sdd/tmp/d1-knobs.mjs` 逐点扫出来的）：
  //   现在 smoothstep + inner 0.71      → RMS 0.0117，最大逐点偏差 0.021
  //   线性     + inner 0.71             → RMS 0.0270，偏差 0.042  ← 只换深度不换形状，仍不合格
  //   线性     + inner 0.62（改前）      → RMS 0.0557，偏差 0.091
  //   幂 3.2   + inner 0.55（上一版）    → RMS 0.0635，偏差 0.161  ← 被 min/max=0.545 带偏的那次
  // 0.02 卡在"比线性 + 对的深度还好"；0.035 那道最大偏差在 r=15px 的个体上是 0.5px，一像素以内。
  assert.ok(rms <= 0.02,
    `剖面与素材的逐点 RMS=${rms.toFixed(4)}（线性剖面哪怕把凹口调对也是 0.027）⇒ 不像那只抱枕`);
  assert.ok(Math.abs(worst) <= 0.035,
    `${worstAt}° 处偏了 ${worst.toFixed(3)}（RMS 会藏住局部大偏差）`);
  // 最要紧的那一个数，单独钉一遍：报错时要能一眼看出是"凹口不对"而不是"整体缩放不对"
  assert.ok(Math.abs(at(36) - 0.71) <= 0.03,
    `凹口深度 ${(at(36) * 100).toFixed(1)}%，素材对称化之后量到的是 71%`);
  // 钝度是**沿臂单调**收拢的，不许中途鼓包（那会在身体侧面长出一个多余的肉球）
  let prev = at(0);
  for (let deg = 2; deg <= 36; deg += 2) {
    const r = at(deg);
    assert.ok(r <= prev + 1e-12, `${deg}° 处半径反弹了（${prev.toFixed(4)} → ${r.toFixed(4)}）：剖面不单调`);
    prev = r;
  }
});

test('starRadius 的两个端点就是 spec §11 的两个比值', () => {
  assert.equal(starRadius(0), CONFIG.star.outerRatio, '外角顶点在 0°  ⇒ 正前方是一个角');
  assert.equal(starRadius(TAU / 10), CONFIG.star.innerRatio, '相邻内凹角在 36°');
  assert.ok(CONFIG.star.innerRatio < CONFIG.star.outerRatio);
});

test('starRadius 有严格的五重旋转对称', () => {
  const sector = TAU / CONFIG.star.corners;
  // 五个互质的采样点上逐个比对"转一个扇区之后取值相同"；
  // 用 24 点采样的相位做样本，顺带证明"点相位不齐"不影响轮廓本身的对称性。
  for (let k = 0; k < CONFIG.bodyPoints; k++) {
    const a = (k / CONFIG.bodyPoints) * TAU;
    for (let m = 1; m < CONFIG.star.corners; m++) {
      assert.ok(Math.abs(starRadius(a) - starRadius(a + m * sector)) < 1e-12,
        `角 ${a.toFixed(4)} 转 ${m} 个扇区之后不该变`);
    }
  }
});

test('starRadius 恒在两比值之间，且从外角到内角单调收拢（每条臂只折一次）', () => {
  const inner = CONFIG.star.innerRatio;
  const outer = CONFIG.star.outerRatio;
  const N = 5000;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < N; i++) {
    const r = starRadius((i / N) * TAU);
    assert.ok(r >= inner - 1e-12 && r <= outer + 1e-12, `半径越界：${r}`);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  assert.ok(Math.abs(max - outer) < 1e-12, '一圈之内必须取到外角比值');
  assert.ok(Math.abs(min - inner) < 1e-12, '一圈之内必须取到内凹比值');
  // 单调：0°（外角）到 36°（内凹）之间不许再鼓回来 —— 星形的每个臂只折一次
  const sector = TAU / CONFIG.star.corners;
  let prev = starRadius(0);
  const S = 200;
  for (let i = 1; i <= S; i++) {
    const r = starRadius((i / S) * (sector / 2));
    assert.ok(r <= prev, `外角到内角必须单调收拢，${i} 处反弹了`);
    prev = r;
  }
  assert.ok(Math.abs(prev - inner) < 1e-12);
});

test('收敛后的静止形状是五角星而不是圆（5 个极大 + 5 个极小）', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  run(body, makeCreature({}), 6.0);        // 收敛到目标轮廓
  const rs = body.points.map(radiusOf);
  const maxima = [];
  const minima = [];
  const n = rs.length;
  for (let i = 0; i < n; i++) {
    const prev = rs[(i - 1 + n) % n];
    const next = rs[(i + 1) % n];
    if (rs[i] > prev && rs[i] >= next) maxima.push(i);
    if (rs[i] < prev && rs[i] <= next) minima.push(i);
  }
  assert.equal(maxima.length, CONFIG.star.corners, `星形应当有 5 个外角，实测 ${maxima.length}`);
  assert.equal(minima.length, CONFIG.star.corners, `星形应当有 5 个内凹，实测 ${minima.length}`);
  // 呼吸脉动是**整体均匀**缩放，所以它不改变极大极小的个数，也不改变最大/最小半径的**比值**。
  // 用比值而不是各自与端点比，正是为了让这条断言不受脉动幅度影响（B 组那条测脉动本身）。
  const ratio = Math.max(...rs) / Math.min(...rs);
  assert.ok(Math.abs(ratio - CONFIG.star.outerRatio / CONFIG.star.innerRatio) < 1e-3,
    `最大/最小半径之比应当是两比值之比 ${CONFIG.star.outerRatio / CONFIG.star.innerRatio}，实测 ${ratio}`);
  // 反面对照：圆的话 24 个半径全都相等（比值 1）。这里必须明显不等于 1，
  // 否则"目标半径数组从圆改成星形"这条计划 2R 的必改项就没有任何东西在守。
  assert.ok(ratio > 1.3, `星形的半径比值必须远大于 1，实测 ${ratio}`);
});

test('尾巴挂点落在最正后的那个内凹角上（spec §4.7.1「挂点在星形后侧的那个凹角」）', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const idx = body.tailAnchor;
  assert.ok(Number.isInteger(idx) && idx >= 0 && idx < body.points.length);
  const p = body.points[idx];
  assert.ok(p.rx < 0 && Math.abs(p.ry) < 1e-12, '挂点的静止方向必须是 -facing（正后方）');
  assert.ok(Math.abs(Math.hypot(p.rx, p.ry) - CONFIG.star.innerRatio) < 1e-12,
    '挂点必须是内凹角，不是外角：凹角才夹得住"屁股对着你"的姿态');
});

// ---------------------------------------------------------------- 尾巴（spec §4.7.1）

test('createBody 造出 TAIL_SEGS 段尾巴，静止时沿挂点法线向后排开', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  assert.equal(body.tail.nodes.length, CONFIG.tail.segs);
  const anchor = body.points[body.tailAnchor];
  const segLen = CONFIG.tail.lenRatio / CONFIG.tail.segs;
  for (let i = 0; i < body.tail.nodes.length; i++) {
    const nd = body.tail.nodes[i];
    const prev = i === 0 ? anchor : body.tail.nodes[i - 1];
    const d = Math.hypot(nd.x - prev.x, nd.y - prev.y);
    assert.ok(Math.abs(d - segLen) < 1e-12, `段 ${i} 静止长度应为 ${segLen}，实测 ${d}`);
    assert.equal(nd.px, nd.x, 'Verlet 的上一位置初值必须与当前位置相同（否则一上手就有隐速度）');
    assert.equal(nd.py, nd.y);
  }
  // 整条链在挂点的后方（局部 −x），且没有侧向偏移
  for (const nd of body.tail.nodes) {
    assert.ok(nd.x < anchor.x, '尾节点必须排在挂点之后');
    assert.ok(Math.abs(nd.y) < 1e-12);
  }
});

test('尾链总长 = TAIL_LEN_RATIO × 身体半径（局部空间身体半径恒为 1），且不新增基因', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  run(body, makeCreature({}), 3.0);
  const anchor = body.points[body.tailAnchor];
  const tip = body.tail.nodes[body.tail.nodes.length - 1];
  const segLen = CONFIG.tail.lenRatio / CONFIG.tail.segs;
  // 逐段核对：约束把每一段都钉在 lenRatio/segs 附近（松弛跟随允许小偏差，实测 < 1%）。
  let path = 0;
  let prev = anchor;
  for (const nd of body.tail.nodes) {
    const d = Math.hypot(nd.x - prev.x, nd.y - prev.y);
    assert.ok(Math.abs(d - segLen) < segLen * 0.05, `段长偏离钉住的值：${d} vs ${segLen}`);
    path += d;
    prev = nd;
  }
  assert.ok(Math.abs(path / CONFIG.tail.lenRatio - 1) < 0.05,
    `整链弧长应当就是 lenRatio，实测 ${path.toFixed(5)}`);
  assert.ok(tip.x < anchor.x, '静止（振幅很小）时尾尖必须在挂点之后');
  // 基因位点**没有**变多：尾巴的一切都由体型与性格派生（spec 明文"不新增基因"）
  const traits = makeCreature({}).traits;
  assert.ok(!('tail' in traits) && !('tailLength' in traits), '尾巴不得成为新的性状位点');
});

test('尾巴的世界长度由体型派生：幼体短、成体长，比值恒为 TAIL_LEN_RATIO', () => {
  const worldOf = (age) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    run(body, makeCreature({ age }), 2.0);
    return body.tailWorldLen;
  };
  const adult = makeCreature({ age: 960 });
  assert.ok(Math.abs(worldOf(960) - CONFIG.tail.lenRatio * sizeOf(adult)) < 1e-9);
  assert.ok(Math.abs(worldOf(0) - CONFIG.tail.lenRatio * sizeOf(makeCreature({ age: 0 }))) < 1e-9);
  assert.ok(worldOf(0) < worldOf(960), '幼体的尾巴必须更短（跟着体型走，不是常数）');
  assert.ok(worldOf(960) > 0);
});

test('tailSwingRate 逐字实现 spec §4.7.1 的公式', () => {
  const base = CONFIG.tail.swingBase;
  const floor = CONFIG.tail.swingActivityFloor;
  assert.ok(Math.abs(tailSwingRate(0, 0) - base * floor) < 1e-12, 'activity=0 也要有地板：安静的个体照样摇尾，只是慢');
  assert.ok(Math.abs(tailSwingRate(1, 0) - base * (floor + 1)) < 1e-12);
  assert.ok(Math.abs(tailSwingRate(1, 1) - base * (floor + 1) * (1 + CONFIG.tail.swingArousalGain)) < 1e-12);
  // 单调：越动越快、越兴奋越快
  assert.ok(tailSwingRate(1, 0) > tailSwingRate(0, 0));
  assert.ok(tailSwingRate(0.5, 1) > tailSwingRate(0.5, 0));
  assert.ok(tailSwingRate(0, 0) > 0);
});

test('摆速随 activity 上升：好动的个体同样的模拟时长里摇得更多（spec §4.1 activity 调制尾巴）', () => {
  const crossingsOf = (activity) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ traits: { wobble: 0.5, size: 26, fluff: 0.5, personality: { activity } } });
    return countCrossings(body, c, 20.0);
  };
  const quiet = crossingsOf(0);
  const active = crossingsOf(1);
  assert.ok(active > quiet, `好动的个体摇尾更勤：${active} 次 vs ${quiet} 次`);
  assert.ok(quiet > 0, '安静的个体也必须还在摇（(0.4 + activity) 的地板项）');
});

test('摆速随 arousal 上升（spec §4.7.1 公式里的 (1 + arousal) 项在做事）', () => {
  const crossingsOf = (arousal) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    return countCrossings(body, makeCreature({ emotions: emo({ arousal }) }), 20.0);
  };
  assert.ok(crossingsOf(1) > crossingsOf(0));
});

test('摆幅排序 幸福 > 快乐 > 安静 > 伤心（spec §4.7.1 的表）', () => {
  const ampOf = (emotions) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ emotions });
    run(body, c, 1.0);                 // 先让情绪形变收敛，amp 每步都写
    updateBody(body, c, DT);
    return Math.abs(body.tail.amp);
  };
  const bliss = ampOf(emo({ joy: 1, arousal: 1 }));
  const happy = ampOf(emo({ joy: 0.6, arousal: 0.4 }));
  const calm = ampOf(emo());
  const sad = ampOf(emo({ fear: 0.5 }));
  assert.ok(bliss > happy, `幸福 > 快乐：${bliss.toFixed(4)} vs ${happy.toFixed(4)}`);
  assert.ok(happy > calm, `快乐 > 安静：${happy.toFixed(4)} vs ${calm.toFixed(4)}`);
  assert.ok(calm > sad, `安静 > 伤心：${calm.toFixed(4)} vs ${sad.toFixed(4)}`);
});

test('fear 把尾巴夹起来：摆幅趋零、整条链收拢到身体附近（spec §4.7.1 表）', () => {
  const measure = (fear) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ emotions: emo({ fear }) });
    run(body, c, 2.0);
    return { amp: maxAbsDrive(body, c, 3.0), dist: tipDistance(body) };
  };
  const loose = measure(0);
  const tucked = measure(1);
  assert.ok(tucked.amp < loose.amp * 0.25, `受惊时摆幅要打夹：${tucked.amp.toFixed(4)} vs ${loose.amp.toFixed(4)}`);
  assert.ok(tucked.dist < loose.dist, `受惊时尾尖必须更靠近身体：${tucked.dist.toFixed(4)} vs ${loose.dist.toFixed(4)}`);
});

test('anger 让尾巴急促前后抽（同样 20 秒里过零次数更多，spec §4.7.1 表）', () => {
  const crossingsOf = (anger) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    return countCrossings(body, makeCreature({ emotions: emo({ anger }) }), 20.0);
  };
  assert.ok(crossingsOf(1) > crossingsOf(0), '怒气应当把摆速推上去（"急促前后抽"）');
});

test('伤心/安静时尾尖轻微卷，幸福时绷直（spec §4.7.1 表）', () => {
  const curlOf = (emotions) => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ emotions });
    run(body, c, 2.0);
    return body.tail.curl;
  };
  assert.ok(curlOf(emo()) > curlOf(emo({ joy: 1, arousal: 1 })),
    '低 joy 的静止档必须有静态卷角，幸福档应当绷直');
  assert.ok(Math.abs(curlOf(emo({ joy: 1, arousal: 1 }))) < 1e-12, '幸福时不该带卷');
});

test('尾链惯性跟随挂点：撞一下就是一阵波动，不是整条链瞬移', () => {
  const body = createBody({ wobble: 0.5, fluff: 0.5 });
  const c = makeCreature({});
  run(body, c, 2.0);
  const anchor = body.points[body.tailAnchor];
  const before = { a: { x: anchor.x, y: anchor.y }, nodes: body.tail.nodes.map((nd) => ({ x: nd.x, y: nd.y })) };
  // 沿局部 +x 猛跳一下 ⇒ 受冲击侧是局部 −x ⇒ 正是挂点那一侧被压凹
  c.pos.x += 0.012;
  for (let i = 0; i < 4; i++) updateBody(body, c, DT);
  const move = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const dAnchor = move(anchor, before.a);
  const dRoot = move(body.tail.nodes[0], before.nodes[0]);
  const dTip = move(body.tail.nodes[body.tail.nodes.length - 1], before.nodes[body.tail.nodes.length - 1]);
  assert.ok(dAnchor > 1e-4, `前置条件：挂点确实被这次冲击推动了，实测 ${dAnchor}`);
  assert.ok(dRoot < dAnchor, `尾根必须滞后于挂点（Verlet 惯性）：${dRoot.toFixed(5)} vs ${dAnchor.toFixed(5)}`);
  assert.ok(dTip < dAnchor, `尾尖也必须滞后于挂点：${dTip.toFixed(5)} vs ${dAnchor.toFixed(5)}`);
  // 滞后的直接后果是链被瞬时拉伸/压缩：段长偏离钉住值
  const segLen = CONFIG.tail.lenRatio / CONFIG.tail.segs;
  const d0 = move(body.tail.nodes[0], anchor);
  assert.ok(Math.abs(d0 - segLen) > 1e-5,
    `冲击瞬间第 0 段必须被拉离钉住的段长（这就是"跟随"而非"刚性附着"），实测 ${d0}`);
});

test('死亡时尾巴松掉：驱动力随形变一起归零（spec §4.7.1 表「死亡：松掉」）', () => {
  const living = (() => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ emotions: emo({ joy: 1, arousal: 1 }) });
    run(body, c, 2.0);
    return maxAbsDrive(body, c, 3.0);
  })();
  const dead = (() => {
    const body = createBody({ wobble: 0.5, fluff: 0.5 });
    const c = makeCreature({ alive: false, dying: CONFIG.dissolveDuration * 0.9, emotions: emo({ joy: 1, arousal: 1 }) });
    run(body, c, 2.0);
    return maxAbsDrive(body, c, 3.0);
  })();
  assert.ok(dead < living * 0.5, `溶散中的尾巴应当松掉：${dead.toFixed(5)} vs ${living.toFixed(5)}`);
  assert.ok(dead >= 0);
});

test('尾巴长时程不发散：段长不会越跑越长，坐标全部有限', () => {
  const body = createBody({ wobble: 1, fluff: 1 });
  const c = makeCreature({
    emotions: emo({ joy: 1, anger: 1, fear: 0.3, curiosity: 1, arousal: 1 }),
    vel: { x: 0.3, y: -0.2 }, moving: true,
  });
  run(body, c, 120.0);
  const segMax = CONFIG.tail.lenRatio;      // 整链拉直的上限（局部单位）
  let path = 0;
  for (let i = 0; i < body.tail.nodes.length; i++) {
    const nd = body.tail.nodes[i];
    assert.ok(Number.isFinite(nd.x) && Number.isFinite(nd.y));
    const prev = i === 0 ? body.points[body.tailAnchor] : body.tail.nodes[i - 1];
    path += Math.hypot(nd.x - prev.x, nd.y - prev.y);
  }
  assert.ok(path < segMax * 1.5, `尾链总长不该发散：实测 ${path.toFixed(4)}（上限 ${segMax}）`);
  assert.ok(path > CONFIG.tail.lenRatio * 0.2, `尾链不该缩成一团：实测 ${path.toFixed(4)}`);
});

// ---------------------------------------------------------------- 卷毛（spec §4.7 第三机制）

test('fluff 进 body 状态：毛长 = FLUFF_LEN_RATIO × fluff 表现型（局部，身体半径 = 1）', () => {
  const lenOf = (fluff) => {
    const body = createBody({ wobble: 0.5, fluff });
    run(body, makeCreature(withTraits({ fluff })), 2.0);
    return body.fluffLen;
  };
  assert.ok(Math.abs(lenOf(1) - CONFIG.fluff.lenRatio) < 1e-12, '中性情绪下满档毛长应当恰好是比值');
  assert.ok(Math.abs(lenOf(0.5) - CONFIG.fluff.lenRatio * 0.5) < 1e-12);
  assert.equal(lenOf(0), 0, 'fluff=0 的个体没有毛');
  assert.ok(lenOf(0.9) > lenOf(0.3), '毛长必须随性状单调');
});

test('毛长是线性的一等公民：一窝孩子毛不一样蓬（spec §4.1 的物种认同论证）', () => {
  // 这条走真 createCreature，钉的是"基因 → 表现型 → body 状态"整条接线，
  // 而不是 body.js 自己那个乘法。
  const rng = createRng(20261020);
  const mk = (v) => {
    const genes = randomGenome(rng);
    genes.fluff = [v, v];
    return createCreature({ id: 1, x: 0.5, y: 0.5, genes });
  };
  const fluffies = [0.15, 0.5, 0.95].map((v) => {
    const c = mk(v);
    const body = createBody(c.traits);
    run(body, c, 2.0);
    return body.fluffLen;
  });
  assert.ok(fluffies[0] < fluffies[1] && fluffies[1] < fluffies[2],
    `三只不同 fluff 基因的个体毛长必须互不相同：${fluffies.join(' / ')}`);
  assert.ok(Math.abs(fluffies[2] - CONFIG.fluff.lenRatio * 0.95) < 1e-12);
});

test('受惊时毛收缩（§4.7 那句"2 张 sprite（常态/收缩）"里的收缩这一半，用长度实现）', () => {
  const body = createBody({ wobble: 0.5, fluff: 1 });
  const c = makeCreature({});
  run(body, c, 2.0);
  const loose = body.fluffLen;
  c.emotions.fear = 1;
  run(body, c, 2.0);
  assert.ok(body.fluffLen < loose, `害怕时毛应贴紧：${body.fluffLen.toFixed(4)} vs ${loose.toFixed(4)}`);
  assert.ok(body.fluffLen > 0, '收缩不等于没有毛（0 会让 sprite 变换退化）');
});

test('毛 sprite 只在 [0, FLUFF_SPRITES) 里取整数，anger 高时切到炸开那一档', () => {
  const spriteOf = (anger) => {
    const body = createBody({ wobble: 0.5, fluff: 0.8 });
    const c = makeCreature({ emotions: emo({ anger }) });
    run(body, c, 1.5);
    updateBody(body, c, DT);
    return body.fluffSprite;
  };
  assert.equal(spriteOf(0), 0, '常态必须是第 0 档');
  assert.equal(spriteOf(1), 1, '怒气打满必须切到炸开那一档（spec §4.7.1 表）');
  assert.ok(Number.isInteger(spriteOf(0.2)) && spriteOf(0.2) >= 0 && spriteOf(0.2) < CONFIG.fluff.sprites);
  assert.equal(CONFIG.fluff.sprites, 2, '只有两档：再多就要 256 张 sprite（spec §4.7 的性能生死线）');
});

test('卷毛长度与尾巴都不引入新的基因位点（spec §4.7.1「不新增基因」）', async () => {
  const { ALL_GENES, APPEARANCE_GENES } = await import('../src/genes.js');
  assert.ok(APPEARANCE_GENES.includes('fluff'), 'fluff 是既有位点，本轮只是把它接进表现层');
  assert.ok(!ALL_GENES.some((g) => /tail|star|blink/i.test(g)),
    '尾巴/星形/眨眼都不许成为基因位点');
});

// ---------------------------------------------------------------- 眨眼间隔（spec §4.6）

test('blinkInterval = BASE / (0.4 + activity)：好动的眨眼勤、安静的半天一次', () => {
  const base = CONFIG.blink.intervalBase;
  const floor = CONFIG.blink.activityFloor;
  assert.ok(Math.abs(blinkInterval(0) - base / floor) < 1e-12);
  assert.ok(Math.abs(blinkInterval(1) - base / (floor + 1)) < 1e-12);
  assert.ok(blinkInterval(1) < blinkInterval(0), '好动的间隔必须更短（眨得勤）');
  assert.ok(Number.isFinite(blinkInterval(0)) && blinkInterval(0) > 0, '分母有地板，永不为 0');
});

test('blinkInterval 对越界输入取钳位（脏存档给 activity = 9 也不许倒着眨）', () => {
  assert.equal(blinkInterval(9), blinkInterval(1));
  assert.equal(blinkInterval(-3), blinkInterval(0));
});

// ---------------------------------------------------------------- 全局纪律与接线

test('body.js 源码里没有数值字面量（除 0/1/2 这类结构性常数）—— 照 A5 moodOf 的先例', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/body.js', import.meta.url)), 'utf8');
  const src = stripComments(raw);
  // 三条正则各自拦一类漂移，都要求数字是**独立的 token**：
  // 不这样 `new Float64Array(n)` 里的 "64" 会被当成字面量（它是标识符的一部分）。
  const decimals = src.match(/(?<![\w$.])\d*\.\d+/g);
  assert.equal(decimals, null, `body.js 里出现小数字面量（${decimals && decimals.join(' ')}）—— 请搬进 CONFIG`);
  const sci = src.match(/(?<![\w$.])\d+[eE][-+]?\d+/g);
  assert.equal(sci, null, `body.js 里出现科学计数法字面量（${sci && sci.join(' ')}）`);
  const multi = src.match(/(?<![\w$.])\d{2,}(?![\w$])/g);
  assert.equal(multi, null, `body.js 里出现多位整数字面量（${multi && multi.join(' ')}）`);
  // 反向防空转：把 CONFIG 的读取换成硬编码必然撞上第一条。
  // 这里用同一条正则去扫**已知有**多位整数的一段（config.test.js 自己），确认扫描器不是摆设。
  assert.ok(stripComments(readFileSync(fileURLToPath(new URL('../src/config.js', import.meta.url)), 'utf8'))
    .match(/(?<![\w$.])\d{2,}(?![\w$])/g), '防空转：同样的正则在 config.js 里必须能数出多位整数');
});

test('body.js 不引用任何浏览器 API，也不 import main.js（Node 里能跑完整套本文件已是证据）', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/body.js', import.meta.url)), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `body.js 引用了 ${name}`);
  }
  assert.ok(!/Math\.random\s*\(/.test(src), 'body.js 不得调用 Math.random()');
  assert.ok(!/'\.\/main\.js'/.test(raw) && !/"\.\/main\.js"/.test(raw), 'body.js 不得 import main.js');
});

test('main.js 把 updateBodies 放进子步循环，并且喂的是 CONFIG.fixedDt（B11 留给本 Task 的话）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8');
  assert.ok(/from '\.\/body\.js'/.test(src), 'main.js 没有 import body.js');
  // 取出子步循环的**代码块**（大括号配对），要求它同时含 tickWorld 与 updateBodies
  const m = src.match(/for\s*\([^)]*steps[^)]*\)\s*\{/);
  assert.ok(m, 'main.js 里找不到子步循环 for (... steps ...)');
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, '子步循环的块没能配对闭合');
  const block = src.slice(start, end + 1);
  assert.ok(block.includes('tickWorld'), '子步循环里没有 tickWorld');
  assert.ok(block.includes('updateBodies'), `软体弹簧必须在子步循环里，块内实测：${block}`);
  assert.ok(/updateBodies\([^)]*CONFIG\.fixedDt\)/.test(block), 'updateBodies 必须吃固定步长');
  assert.ok(!/updateBodies\([^)]*frameDt/.test(src), 'updateBodies 绝不吃渲染帧率');
});

test('显式积分对步长敏感：同样的模拟时长，一个大步 ≠ 六十个小步（所以必须子步进）', () => {
  // 这条是 main.js 接线纪律的**反向断言**（同 tests/loop.test.js 那条的写法）。
  // 若 updateBody 改成步长无关（比如解析解），把它放在渲染帧率下不会有症状，
  // 而现实是它每一步的形变都随 dt 变 —— 高刷屏上的身体会更硬、低刷屏上更软。
  const c1 = makeCreature({ emotions: emo({ joy: 1, arousal: 0.8 }), vel: { x: 0.02, y: 0 }, moving: true });
  const b1 = createBody({ wobble: 1, fluff: 0.5 });
  const c2 = makeCreature({ emotions: emo({ joy: 1, arousal: 0.8 }), vel: { x: 0.02, y: 0 }, moving: true });
  const b2 = createBody({ wobble: 1, fluff: 0.5 });
  const seconds = 1;
  for (let i = 0; i < Math.round(seconds / DT); i++) updateBody(b1, c1, DT);
  updateBody(b2, c2, seconds);                 // 一个 1 秒的巨步（错误做法）
  const diff = b1.points.reduce((s, p, i) => s + Math.abs(p.x - b2.points[i].x), 0);
  assert.ok(diff > 1e-3, `大步与小步的结果必须不同（实测差 ${diff}），否则"必须放进子步循环"这条要求是无病呻吟`);
  assert.ok(Number.isFinite(b2.points[0].x), '即使被误用大步长也不许 NaN');
});

test('reconcileBodies / updateBodies 与世界同步：出生补建、移除清除、活着的复用同一批对象', () => {
  const a = makeCreature({});
  a.id = 'a';
  const b = makeCreature({});
  b.id = 'b';
  const world = { creatures: [a, b] };
  const bodies = new Map();

  updateBodies(bodies, world, DT);
  assert.equal(bodies.size, 2);
  const refA = bodies.get('a');
  assert.equal(refA.points, bodies.get('a').points);

  // 再跑一批子步：不得重建
  for (let i = 0; i < 10; i++) updateBodies(bodies, world, DT);
  reconcileBodies(bodies, world);
  assert.equal(bodies.get('a'), refA, '同一只个体的 Body 必须复用，不得每帧新建');

  // 出生：世界多一只，子步循环里当帧就该有 Body（卵孵化就发生在子步中间）
  const c = makeCreature({});
  c.id = 'c';
  world.creatures.push(c);
  updateBodies(bodies, world, DT);
  reconcileBodies(bodies, world);
  assert.equal(bodies.size, 3);

  // 死亡被从 world 里摘掉：Body 也要跟着消失，否则缸跑久了 Map 无限增长
  world.creatures.splice(1, 1);
  updateBodies(bodies, world, DT);
  reconcileBodies(bodies, world);
  assert.equal(bodies.size, 2);
  assert.ok(!bodies.has('b'), '已经不存在的个体其 Body 必须被清掉');
  assert.equal(bodies.get('a'), refA);
});

test('updateBodies 逐只更新且互不污染：两只个体的形状各自跟随自己的情绪', () => {
  const happy = makeCreature({ emotions: emo({ joy: 1 }) });
  happy.id = 'happy';
  happy.traits = { wobble: 0.5, size: 38, fluff: 0.5, personality: { activity: 0.5 } };
  const scared = makeCreature({ emotions: emo({ fear: 1 }) });
  scared.id = 'scared';
  scared.traits = { wobble: 0.5, size: 38, fluff: 0.5, personality: { activity: 0.5 } };
  const bodies = new Map();
  const world = { creatures: [happy, scared] };
  for (let i = 0; i < Math.round(2 / DT); i++) updateBodies(bodies, world, DT);
  assert.ok(meanRadius(bodies.get('happy')) > meanRadius(bodies.get('scared')),
    '同体型下开心的那只应当比害怕的那只鼓');
});
