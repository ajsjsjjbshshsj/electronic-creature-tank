import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGradient, assertGradient, assertEllipse } from './ctx-stub.js';
import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { drawPetFurLayer } from '../src/render.js';

const GRADIENT_STUB = makeGradient();

function createLogCtx() {
  const counts = new Map();
  const calls = [];
  const stub = {
    counts, calls,
    count(name) { return counts.get(name) || 0; },
    reset() { counts.clear(); calls.length = 0; },
  };
  const bump = (name) => { counts.set(name, (counts.get(name) || 0) + 1); return name; };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'stroke',
    'fill', 'save', 'restore', 'drawImage', 'clip', 'arc', 'ellipse']) {
    stub[m] = (...a) => { calls.push({ op: m, args: a }); bump(m); };
  }
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
  for (const name of ['globalAlpha', 'strokeStyle', 'fillStyle', 'lineWidth',
    'lineCap', 'globalCompositeOperation']) {
    let value = 0;
    Object.defineProperty(stub, name, {
      get() { return value; },
      set(v) { value = v; calls.push({ op: `set:${name}`, args: [v] }); },
    });
  }
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return 0; },
    set() { counts.set('shadowBlur', (counts.get('shadowBlur') || 0) + 1); },
  });
  return stub;
}

const DT = CONFIG.fixedDt;
const handAt = (c, dx, dy) => ({
  pos: { x: c.pos.x + dx, y: c.pos.y + dy },
  speed: 0, down: true, appeared: false, grab: null,
});
function fixture() {
  const world = createWorld({ seed: 881 });
  const c = world.creatures[0];
  c.pos.x = 0.5; c.pos.y = 0.5;
  c.facing.x = 1; c.facing.y = 0;
  c.vel.x = 0; c.vel.y = 0; c.moving = false;
  const body = createBody(c.traits);
  return { world, c, body };
}
const rendererStub = () => ({
  fx: { alpha: 1, squashV: 1, stretchH: 1 },
  sx: new Float64Array(CONFIG.bodyPoints),
  sy: new Float64Array(CONFIG.bodyPoints),
  squashAlong: 1, squashPerp: 1,
});

test('不抚摸时毛层一笔都不画，renderer 坐标缓存保持原样', () => {
  const { c, body } = fixture();
  c.beingPetted = false;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  const r = rendererStub();
  r.sx.fill(7);
  r.sy.fill(9);
  const ctx = createLogCtx();
  drawPetFurLayer(ctx, r, c, body, 100, 100, 30, 1, 0);
  assert.equal(ctx.count('beginPath'), 0);
  assert.equal(ctx.count('stroke'), 0);
  assert.equal(ctx.count('save'), 0);
  assert.deepEqual([...r.sx], new Array(CONFIG.bodyPoints).fill(7));
  assert.deepEqual([...r.sy], new Array(CONFIG.bodyPoints).fill(9));
});

test('抚摸时近手侧出现压毛带与短伏毛，方向随手的局部方向切换', () => {
  const { c, body } = fixture();
  c.beingPetted = true;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  const right = createLogCtx();
  const r = rendererStub();
  drawPetFurLayer(right, r, c, body, 100, 100, 30, 1, 0);
  assert.ok(right.count('stroke') >= 2, `压毛带 + 伏毛至少两笔，实测 ${right.count('stroke')}`);
  assert.ok(right.count('quadraticCurveTo') >= 1, '伏毛必须有弯曲方向，不是直线延长');
  assert.ok(right.count('quadraticCurveTo') <= CONFIG.bodyPoints,
    '每只最多每个轮廓点一根伏毛，不许重抄整圈贝塞尔');
  const rightMoves = right.calls.filter((x) => x.op === 'moveTo').map((x) => x.args);
  assert.ok(rightMoves.length >= 1);
  for (const [x] of rightMoves) assert.ok(x > 100, `手在 +x 时毛只应向近手侧倒：${x}`);
  // 压毛带只能连接相邻轮廓点：段长必须小于半个身体半径，否则就是跨过身体的弦。
  let lastMove = null;
  for (const call of right.calls) {
    if (call.op === 'moveTo') lastMove = call.args;
    else if (call.op === 'lineTo') {
      assert.ok(lastMove, 'lineTo 前必须有 moveTo');
      const d = Math.hypot(call.args[0] - lastMove[0], call.args[1] - lastMove[1]);
      assert.ok(d < 15, `压毛带跨过了身体内部：单段 ${d.toFixed(2)}px`);
    }
  }

  // 同一只、手换到屏幕上方：倒伏必须跟着转到上侧。
  c.facing.x = 1; c.facing.y = 0;
  const topBody = createBody(c.traits);
  updateBody(topBody, c, DT, handAt(c, 0, 0.02));
  const top = createLogCtx();
  drawPetFurLayer(top, rendererStub(), c, topBody, 100, 100, 30, 1, 0);
  const topMoves = top.calls.filter((x) => x.op === 'moveTo').map((x) => x.args);
  assert.ok(topMoves.length >= 1);
  for (const [, y] of topMoves) assert.ok(y > 100, `手在 +y 时毛只应向上侧倒：${y}`);

  // facing 旋转 90°：世界 +x 的手在局部 −y；屏幕效果必须在 +x。
  const turnedC = c;
  turnedC.facing.x = 0; turnedC.facing.y = 1;
  const turnedBody = createBody(c.traits);
  updateBody(turnedBody, turnedC, DT, handAt(turnedC, 0.02, 0));
  const turned = createLogCtx();
  drawPetFurLayer(turned, rendererStub(), turnedC, turnedBody, 100, 100, 30, 0, 1);
  const turnedMoves = turned.calls.filter((x) => x.op === 'moveTo').map((x) => x.args);
  assert.ok(turnedMoves.length >= 1);
  for (const [x] of turnedMoves) assert.ok(x > 100, `facing +y、手在世界 +x 时毛仍倒在手的屏幕一侧：${x}`);
});

test('死亡或 sick 的个体即使残留 beingPetted 也不画倒伏', () => {
  const { c, body } = fixture();
  c.beingPetted = true;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  c.sick = true;
  const sick = createLogCtx();
  drawPetFurLayer(sick, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(sick.count('stroke'), 0);
  c.sick = false;
  c.alive = false;
  const dead = createLogCtx();
  drawPetFurLayer(dead, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(dead.count('stroke'), 0);
});

test('毛倒伏层不使用贴图/渐变/阴影，也不写 world 或 creature', () => {
  const { world, c, body } = fixture();
  c.beingPetted = true;
  updateBody(body, c, DT, handAt(c, 0.02, 0));
  const ctx = createLogCtx();
  const before = JSON.stringify({ c, w: world.time });
  drawPetFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(JSON.stringify({ c, w: world.time }), before);
  assert.equal(ctx.count('drawImage'), 0);
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.count('shadowBlur'), 0);
  assert.equal(ctx.count('globalCompositeOperation'), 0);
});

test('fluff 为 0 或半径无效时早早退出，不留半条毛', () => {
  const { c, body } = fixture();
  c.beingPetted = true;
  body.fluffLen = 0;
  body.petX = 1;
  body.petY = 0;
  const ctx = createLogCtx();
  drawPetFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(ctx.count('stroke'), 0);
  body.fluffLen = 0.1;
  drawPetFurLayer(ctx, rendererStub(), c, body, NaN, 100, 30, 1, 0);
  assert.equal(ctx.count('stroke'), 0);
});
