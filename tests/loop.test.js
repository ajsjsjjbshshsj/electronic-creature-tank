import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { advanceLoop } from '../src/main.js';

// 计划 1 交接要求第 2 条的落点。原文：
//   "倍速必须用子步进实现，绝不能放大 dt" —— 因为 emotions.update 是前向欧拉
//   k = min(1, inertia*dt)，**不具**步长无关性；4× 若靠放大 dt 实现，
//   推进 1 模拟秒会得到 0.815837 而非 0.802441（偏差 1.6693%）。
// 计划 1 在 tests/emotions.test.js 里钉住的是**机制**层面（单条 update 调用）。
// 这里补的是**世界**层面：整个主循环跑出来的缸必须与直接连跑逐位相同。
// 少了这一层，"把子步进改回放大 dt"这个回归不会让任何测试变红 ——
// 因为情绪层的偏差只有 1.67%，肉眼和统计断言都看不出来。
//
// 相对旧计划 Task 3 的两处删减（2026-10-21 B11 落地时）：
//   · createViewport 组测试删了：CONFIG.render 加不进去 —— config.test.js 用
//     **精确相等**钉住 CONFIG 顶层键集（41 键 / 39 节点），加一个 render 段必须
//     同步改它，而 B11 被禁止动 constraints 之外的测试。视口缩放随渲染层（B13）一起进。
//   · reconcileBodies 组测试删了：src/body.js 是 B12 的交付物，本 Task 不存在该模块。

const SEED = 20261020;

const snapshot = (w) => w.creatures.map((c) => [
  c.id, c.age, c.stage, c.alive ? 1 : 0,
  c.pos.x, c.pos.y, c.vel.x, c.vel.y, c.facing.x, c.facing.y,
  c.needs.hunger, c.needs.energy, c.needs.social, c.needs.safety,
  c.emotions.joy, c.emotions.anger, c.emotions.fear,
  c.emotions.curiosity, c.emotions.sleepy, c.emotions.arousal,
].join(',')).join('|');

test('advanceLoop：每帧子步数 = 倍速，且 dt 恒为 fixedDt（交接要求第 2 条）', () => {
  const loop = { acc: 0, steps: 0 };
  for (const ts of CONFIG.timeScales) {
    loop.acc = 0;
    const steps = advanceLoop(loop, CONFIG.fixedDt, ts);
    // frameDt = 1/60、倍速 ts ⇒ 每帧恰好 ts 个子步（0.5× 是隔帧一步）
    if (ts >= 1) assert.equal(steps, ts, `倍速 ${ts}× 应当每帧 ${ts} 个子步`);
    assert.ok(loop.acc >= 0 && loop.acc < CONFIG.fixedDt, `余量必须落在 [0, fixedDt)：${loop.acc}`);
  }
  // 0.5× 单独验：连续两帧才凑够一个 fixedDt
  loop.acc = 0;
  assert.equal(advanceLoop(loop, CONFIG.fixedDt, 0.5), 0);
  assert.equal(advanceLoop(loop, CONFIG.fixedDt, 0.5), 1);
});

test('advanceLoop：累加器封顶 0.25 秒，后台标签页恢复不会补算几千步（spec §3.4-1）', () => {
  const loop = { acc: 0, steps: 0 };
  // 模拟标签页在后台待了 30 秒后恢复：frameDt = 30
  const steps = advanceLoop(loop, 30, 4);
  const maxSteps = Math.floor(CONFIG.dtAccumCap / CONFIG.fixedDt);   // 0.25 / (1/60) = 15
  assert.equal(steps, maxSteps, `封顶后每帧最多 ${maxSteps} 步，实测 ${steps}`);
  // 关键：封顶的语义是**丢弃**超出的时间，不是留着慢慢追。
  // 留着追的话缸会"快进"到当下，玩家看到的是一缸生物瞬移。
  assert.ok(loop.acc < CONFIG.fixedDt, `余量必须被丢弃到不足一步：${loop.acc}`);
});

test('advanceLoop 原地修改 loop 对象，每帧零分配（spec §5.3）', () => {
  const loop = { acc: 0, steps: 0 };
  const ref = loop;
  for (let i = 0; i < 1000; i++) advanceLoop(loop, CONFIG.fixedDt, 1);
  assert.equal(loop, ref, '不得返回新对象 —— 每帧一个新对象就是每秒 60 次 GC 压力');
  assert.equal(loop.steps, 1);
});

test('4× 子步进的世界与直接连跑 4× 步数逐位相同；放大 dt 则不同', () => {
  const totalSteps = 240;                    // 4 模拟秒
  const frames = 60;                         // 1 秒真实时间 × 60fps
  const timeScale = 4;

  // A：基准 —— 直接连跑 240 个 fixedDt
  const wa = createWorld({ seed: SEED });
  for (let i = 0; i < totalSteps; i++) tickWorld(wa, CONFIG.fixedDt);

  // B：正确做法 —— 60 帧 × 每帧 4 个子步 × dt = fixedDt
  const wb = createWorld({ seed: SEED });
  const loop = { acc: 0, steps: 0 };
  for (let f = 0; f < frames; f++) {
    const steps = advanceLoop(loop, CONFIG.fixedDt, timeScale);
    assert.equal(steps, 4);
    for (let s = 0; s < steps; s++) tickWorld(wb, CONFIG.fixedDt);   // dt 恒为 fixedDt
  }

  // C：错误做法 —— 60 帧 × 每帧 1 步 × dt = fixedDt×4（推进的模拟时长同样是 4 秒）
  const wc = createWorld({ seed: SEED });
  for (let f = 0; f < frames; f++) tickWorld(wc, CONFIG.fixedDt * timeScale);

  assert.equal(snapshot(wb), snapshot(wa), '子步进必须与直接连跑逐位相同');
  // ⚠️ 下面这条**反向**断言才是本测试的价值所在。
  // 没有它，把 advanceLoop 改回"返回 1 步、dt 乘倍速"不会让任何测试变红，
  // 而症状是 1.67% 的情绪偏差 —— 既不会崩、也不会明显到被肉眼发现。
  assert.notEqual(snapshot(wc), snapshot(wa),
    '放大 dt 必须产生不同结果，否则上面那条相等断言是恒真的、什么都没守住');

  // 量一下偏差，确认它与计划 1 记录的机制同源（emotions 层，而非位置层）
  const ea = wa.creatures[0].emotions;
  const ec = wc.creatures[0].emotions;
  const dev = Math.abs(ec.joy - ea.joy) + Math.abs(ec.arousal - ea.arousal);
  assert.ok(dev > 1e-9, `情绪层应当有可测偏差，实测 ${dev}`);
  // 位置层是纯积分（pos += vel*dt），步长无关性**成立**，所以偏差不该来自它
  assert.ok(Math.abs(wc.creatures[0].pos.x - wa.creatures[0].pos.x) < 0.05,
    '位置层偏差应当远小于情绪层 —— 这正是这个 bug 难查的原因');
});

test('setTimeScale 只接受 CONFIG.timeScales 里的值', async () => {
  const { setTimeScale } = await import('../src/main.js');
  // 没有活动 controller 时必须抛，而不是静默地把倍速写进虚空
  // （计划 3 的 HUD 按钮会在 boot 之后才存在，这个顺序错误必须响）
  assert.throws(() => setTimeScale(3), /未在运行|没有活动/, '没有 controller 时调用必须抛错');
});
