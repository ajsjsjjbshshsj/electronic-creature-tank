import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGradient, assertGradient, assertEllipse } from './ctx-stub.js';
import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/sim.js';
import { createBody } from '../src/body.js';
import { createViewport } from '../src/main.js';
import { createRenderer, drawHandLayer, consumeEvents, burst } from '../src/render.js';

const GRADIENT_STUB = makeGradient();
const say = (id, text) => ({ kind: 'say', id, text, tokens: text.split(' '), mood: '开心' });

function createLogCtx() {
  const counts = new Map();
  const ops = [];
  const calls = [];
  let depth = 0;
  const stub = {
    counts,
    ops,
    calls,
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    reset() {
      counts.clear(); ops.length = 0; calls.length = 0; depth = 0; stub.shadowBlurWrites = 0;
    },
    count(name) { return counts.get(name) || 0; },
    call(name) { return calls.find((c) => c.op === name); },
  };
  const bump = (name) => {
    counts.set(name, (counts.get(name) || 0) + 1);
    return name;
  };
  for (const m of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
    'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip',
    'clearRect', 'fillRect', 'translate', 'rotate', 'scale', 'drawImage',
    'fillText', 'setTransform']) {
    stub[m] = (...a) => { calls.push({ op: m, args: a }); ops.push(m); bump(m); };
  }
  stub.save = () => { calls.push({ op: 'save', args: [] }); depth += 1; ops.push('save'); bump('save'); };
  stub.restore = () => {
    calls.push({ op: 'restore', args: [] });
    ops.push('restore'); bump('restore');
    depth -= 1; assert.ok(depth >= 0, 'restore 多于 save');
  };
  const rawEllipse = stub.ellipse;
  stub.ellipse = (...a) => { assertEllipse(a[2], a[3]); return rawEllipse(...a); };
  stub.createRadialGradient = (...a) => {
    assertGradient('createRadial', ...a);
    counts.set('createRadialGradient', (counts.get('createRadialGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.createLinearGradient = (...a) => {
    assertGradient('createLinear', ...a);
    counts.set('createLinearGradient', (counts.get('createLinearGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.measureText = () => ({ width: 0 });
  for (const name of ['globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth',
    'lineCap', 'lineJoin', 'globalCompositeOperation']) {
    let value = 0;
    Object.defineProperty(stub, name, {
      get() { return value; },
      set(v) {
        value = v;
        ops.push(`set:${name}`);
        calls.push({ op: `set:${name}`, args: [v] });
        counts.set(name, (counts.get(name) || 0) + 1);
      },
    });
  }
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return stub._shadowBlur; },
    set(v) { stub.shadowBlurWrites += 1; stub._shadowBlur = v; },
  });
  return stub;
}

const makeCanvasStub = (created) => (w, h) => {
  const ctx = createLogCtx();
  ctx.width = w; ctx.height = h;
  if (created) created.push(ctx);
  return { ctx, surface: ctx };
};

const DESKTOP = createViewport(1920, 1080, 1);
const handAt = (x, y) => ({
  pos: { x, y }, speed: 0, down: true, appeared: false, grab: null,
});
const makeRenderer = (world, created) => createRenderer({
  makeCanvas: makeCanvasStub(created),
  rng: world.rng.fork(),
  viewport: DESKTOP,
  isMobile: false,
});
const makeBodies = (world) => {
  const bodies = new Map();
  for (const c of world.creatures) bodies.set(c.id, createBody(c.traits));
  return bodies;
};

test('没有手时手部层一笔都不画', () => {
  const world = createWorld({ seed: 731 });
  const r = makeRenderer(world);
  r.hand = null;
  r.petting = false;
  const ctx = createLogCtx();
  const pose = drawHandLayer(ctx, r, DESKTOP);
  assert.equal(pose.active, false);
  assert.equal(ctx.count('beginPath'), 0);
  assert.equal(ctx.count('fill'), 0);
  assert.equal(ctx.count('stroke'), 0);
  assert.equal(ctx.count('drawImage'), 0);
});

test('按下时画出手：路径可见、save/restore 成对，不用贴图/渐变/阴影', () => {
  const world = createWorld({ seed: 732 });
  const r = makeRenderer(world);
  r.hand = handAt(0.5, 0.5);
  r.time = 1;
  r.petting = false;
  const ctx = createLogCtx();
  const pose = drawHandLayer(ctx, r, DESKTOP);

  assert.equal(pose.active, true, '手存在时几何必须 active');
  assert.equal(pose.petting, false);
  assert.ok(ctx.count('beginPath') >= 1, '手掌/手指必须留下路径');
  assert.ok(ctx.count('fill') >= 1, '肉垫必须有填充，不能只有一根线');
  assert.ok(ctx.count('stroke') >= 1, '粉色描边必须有');
  assert.equal(ctx.count('save'), ctx.count('restore'), 'save/restore 必须成对');
  assert.equal(ctx.count('drawImage'), 0, '手是路径画出来的，不许偷偷贴图');
  assert.equal(ctx.count('createRadialGradient'), 0, '每帧新建渐变违反 §5.3');
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.shadowBlurWrites, 0, 'shadowBlur 是手机上的性能杀手');
});

test('抚摸成立时同一个指尖多出接触光，且掌心进入 rocking', () => {
  const world = createWorld({ seed: 733 });
  const r = makeRenderer(world);
  r.hand = handAt(0.5, 0.5);
  r.petTime = 0.5;

  r.petting = false;
  const neutralCtx = createLogCtx();
  const neutral = drawHandLayer(neutralCtx, r, DESKTOP);
  const neutralSnapshot = {
    contactRadius: neutral.contactRadius,
    tipX: neutral.tipX,
    tipY: neutral.tipY,
    arcs: neutralCtx.count('arc'),
  };

  r.petting = true;
  const pettedCtx = createLogCtx();
  const petted = drawHandLayer(pettedCtx, r, DESKTOP);

  assert.equal(neutralSnapshot.contactRadius, 0, '普通按压不画接触反馈');
  assert.ok(petted.contactRadius > 0, '抚摸必须给出接触半径');
  assert.notEqual(petted.rock, 0, '抚摸时掌心应当摆动');
  assert.equal(petted.tipX, neutralSnapshot.tipX, '指尖仍钉在指针上');
  assert.equal(petted.tipY, neutralSnapshot.tipY);
  assert.ok(pettedCtx.count('arc') >= neutralSnapshot.arcs + 2,
    `抚摸至少多两圈接触弧：${neutralSnapshot.arcs} → ${pettedCtx.count('arc')}`);
  assert.equal(pettedCtx.count('drawImage'), 0);
});

test('抚摸的接触圈在两帧之间真的展开，不是静态装饰', () => {
  const world = createWorld({ seed: 741 });
  const r = makeRenderer(world);
  r.hand = handAt(0.5, 0.5);
  r.petting = true;
  const radiiAt = (t) => {
    r.petTime = t;
    const ctx = createLogCtx();
    const pose = drawHandLayer(ctx, r, DESKTOP);
    return {
      pulse: pose.contactPulse,
      radii: ctx.calls.filter((c) => c.op === 'arc').map((c) => c.args[2]),
    };
  };
  const early = radiiAt(0.1);
  const late = radiiAt(0.5);
  assert.equal(early.radii.length, 2, '前置条件：两圈接触光');
  assert.ok(late.pulse > early.pulse + 0.5,
    `接触脉冲必须真的展开：${early.pulse} → ${late.pulse}`);
  for (let i = 0; i < 2; i++) {
    assert.ok(late.radii[i] > early.radii[i] + 1,
      `第 ${i + 1} 圈半径必须向外走：${early.radii[i]} → ${late.radii[i]}`);
  }
});

test('手心是肉色而不是星绒绒的粉色', () => {
  const world = createWorld({ seed: 742 });
  const r = makeRenderer(world);
  r.hand = handAt(0.5, 0.5);
  r.petting = false;
  const ctx = createLogCtx();
  drawHandLayer(ctx, r, DESKTOP);
  const fills = ctx.calls.filter((c) => c.op === 'set:fillStyle').map((c) => c.args[0]);
  const strokes = ctx.calls.filter((c) => c.op === 'set:strokeStyle').map((c) => c.args[0]);
  assert.ok(fills.includes(CONFIG.colors.handSkin), '手掌/手指必须用肉色填充');
  assert.ok(strokes.includes(CONFIG.colors.handShade), '手形描边必须用更深的肤色');
  assert.ok(!fills.includes(CONFIG.colors.sakura), '手本体不许继续使用樱花粉');
});

test('绘制真的消费 pose：指尖/方向/摆动/掌位不是画在固定位置', () => {
  const world = createWorld({ seed: 738 });
  const r = makeRenderer(world);
  r.hand = handAt(0.7, 0.35);
  r.petTime = 0.5;
  r.petting = true;
  const ctx = createLogCtx();
  const pose = drawHandLayer(ctx, r, DESKTOP);

  const tr = ctx.call('translate');
  const sc = ctx.call('scale');
  const rot = ctx.call('rotate');
  assert.ok(tr && sc && rot, '前置条件：手部层确实设置了变换');
  assert.ok(Math.abs(tr.args[0] - pose.tipX) < 1e-9 && Math.abs(tr.args[1] - pose.tipY) < 1e-9,
    `translate 必须落在指尖：${tr.args} vs ${pose.tipX},${pose.tipY}`);
  assert.equal(sc.args[0], pose.dirX);
  assert.equal(sc.args[1], pose.dirY);
  assert.ok(Math.abs(rot.args[0] - pose.rock) < 1e-12,
    `rotate 必须用 pose.rock：${rot.args[0]} vs ${pose.rock}`);

  const fingerTips = ctx.calls.filter((c) => c.op === 'lineTo');
  assert.ok(fingerTips.some((c) => Math.abs(c.args[0]) < 1e-9 && Math.abs(c.args[1]) < 1e-9),
    `必须有一根手指的指尖精确落在 (0,0)：${JSON.stringify(fingerTips.map((c) => c.args))}`);

  const palm = ctx.call('ellipse');
  const lx = CONFIG.hand.offsetX * pose.size;
  const ly = CONFIG.hand.offsetY * pose.size;
  assert.ok(Math.abs(palm.args[0] - lx) < 1e-9 && Math.abs(palm.args[1] - ly) < 1e-9,
    '第一枚椭圆必须是掌心的局部坐标');
  const cs = Math.cos(pose.rock);
  const sn = Math.sin(pose.rock);
  const screenX = pose.tipX + pose.dirX * (lx * cs - ly * sn);
  const screenY = pose.tipY + pose.dirY * (lx * sn + ly * cs);
  assert.ok(Math.abs(screenX - pose.palmX) < 1e-9 && Math.abs(screenY - pose.palmY) < 1e-9,
    `画出来的掌位与 pose.palm 分家了：${screenX},${screenY} vs ${pose.palmX},${pose.palmY}`);
});

test('rocking 从本次抚摸起点渐入，不会在第一帧跳满', () => {
  const world = createWorld({ seed: 740 });
  const bodies = makeBodies(world);
  const c = world.creatures[0];
  c.beingPetted = true;
  world.playerHand = handAt(c.pos.x, c.pos.y);
  const r = makeRenderer(world);
  const ctx = createLogCtx();
  const dt = CONFIG.fixedDt;

  r.draw(ctx, world, bodies, DESKTOP, dt);
  assert.ok(Math.abs(r.petTime - dt) < 1e-12, '抚摸计时必须从本次接触开始');
  assert.ok(Math.abs(r.handPose.rock) < 0.03,
    `第一帧摆动必须接近 0（渐入），实测 ${r.handPose.rock}`);

  let maxRock = 0;
  let maxPulse = 0;
  for (let i = 0; i < 60; i++) {
    r.draw(ctx, world, bodies, DESKTOP, dt);
    maxRock = Math.max(maxRock, Math.abs(r.handPose.rock));
    maxPulse = Math.max(maxPulse, r.handPose.contactPulse);
  }
  assert.ok(maxRock > 0.12,
    `约 1 秒内摆动必须长到看得见（>0.12 rad），实测峰值 ${maxRock}`);
  assert.ok(maxPulse > 0.8, `接触圈也必须在同一段里明显展开，实测峰值 ${maxPulse}`);

  c.beingPetted = false;
  r.draw(ctx, world, bodies, DESKTOP, dt);
  assert.equal(r.petTime, 0, '抚摸结束必须重置相位，下一次重新渐入');
  assert.equal(r.handPose.rock, 0);
});

test('renderer.draw 只读 world.playerHand 与既有 beingPetted，不改世界', () => {
  const world = createWorld({ seed: 734 });
  const bodies = makeBodies(world);
  const c = world.creatures[0];
  c.beingPetted = true;
  world.playerHand = handAt(c.pos.x, c.pos.y - 0.02);
  const r = makeRenderer(world);
  const ctx = createLogCtx();
  const before = JSON.stringify(world);

  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.equal(JSON.stringify(world), before, '画一只玩家的手不许写世界（含 beingPetted）');
  assert.equal(r.petting, true, '手部状态必须来自内核已有的 beingPetted');
  assert.equal(r.handPose.active, true);
  assert.equal(r.handPose.tipX, c.pos.x * DESKTOP.width);

  c.beingPetted = false;
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.equal(r.petting, false, '没有一只被抚摸时，手不应继续摆出接触姿态');
  assert.equal(r.handPose.active, true, '手仍按着，只是不再是抚摸');
});

test('松手后 renderer.hand 读到 null，手部几何立即 inactive', () => {
  const world = createWorld({ seed: 735 });
  const bodies = makeBodies(world);
  world.playerHand = handAt(0.5, 0.5);
  const r = makeRenderer(world);
  const ctx = createLogCtx();

  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.equal(r.handPose.active, true);
  world.playerHand = null;
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.equal(r.handPose.active, false, '松手那一帧手就要消失，不许留下悬空的手');
  const handCtx = createLogCtx();
  const pose = drawHandLayer(handCtx, r, DESKTOP);
  assert.equal(pose.active, false);
  assert.equal(handCtx.count('beginPath'), 0, '松手后手部层不许留下一笔');
  assert.equal(handCtx.count('save'), 0);
});

test('手画在语言气泡之下：气泡文字仍是最上面的那一层', () => {
  const world = createWorld({ seed: 737 });
  const bodies = makeBodies(world);
  const c = world.creatures[0];
  world.playerHand = handAt(c.pos.x, c.pos.y);
  world.speechEnabled = true;
  const r = makeRenderer(world);
  r.time = 100;
  consumeEvents(r, [say(c.id, '喵喵 开心')]);
  const ctx = createLogCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);

  const handLayer = ctx.ops.indexOf('set:lineJoin');
  const bubbleText = ctx.ops.indexOf('fillText');
  assert.ok(handLayer >= 0, '前置条件：手部层确实画了（lineJoin 是它独有的设置）');
  assert.ok(bubbleText >= 0, '前置条件：这一帧确实有气泡文字');
  assert.ok(handLayer < bubbleText,
    `手必须压在气泡下面：手在第 ${handLayer} 笔，文字在第 ${bubbleText} 笔`);
});

test('手画在溶散粒子之上：粒子不许盖住手', () => {
  const world = createWorld({ seed: 739 });
  world.playerHand = handAt(0.5, 0.5);
  const r = makeRenderer(world);
  burst(r, 300, 300, 0, 6);
  assert.ok(r.bursts.live > 0, '前置条件：这一帧确实有活着的溶散粒子');
  const ctx = createLogCtx();
  r.draw(ctx, world, new Map(), DESKTOP, 0);

  const handLayer = ctx.ops.indexOf('set:lineJoin');
  const lastImage = ctx.ops.lastIndexOf('drawImage');
  assert.ok(handLayer >= 0 && lastImage >= 0, '前置条件：手与粒子都画了');
  assert.ok(handLayer > lastImage,
    `手必须在最后一次粒子贴图之后：手在第 ${handLayer} 笔，最后一次 drawImage 在第 ${lastImage} 笔`);
});

test('画手不新建离屏画布，手部 pose 是每帧复用的同一个对象', () => {
  const world = createWorld({ seed: 736 });
  const created = [];
  const r = makeRenderer(world, created);
  r.hand = handAt(0.4, 0.6);
  const ctx = createLogCtx();
  const built = created.length;
  drawHandLayer(ctx, r, DESKTOP);
  const poseRef = r.handPose;
  drawHandLayer(ctx, r, DESKTOP);
  assert.equal(r.handPose, poseRef, 'pose 容器必须复用');
  assert.equal(created.length, built, '手部层一张离屏画布都不许新建');
});
