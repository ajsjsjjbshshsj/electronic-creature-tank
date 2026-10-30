import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGradient, assertGradient } from './ctx-stub.js';
import { CONFIG } from '../src/config.js';
import { createWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { drawPokeFurLayer, drawPetFurLayer } from '../src/render.js';

// 局部炸毛（被戳时）：只在**被戳的那一侧**把毛炸起来。
// 与抚摸倒伏共用同一套几何来源（body.js 投影好的方向），但方向相反：倒伏是压下去，
// 炸毛是往外立。这一层不新增 sprite、不改 fluff 那两张贴图的账单。

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
  speed: 4, down: true, appeared: false, grab: null,
});

function fixture() {
  const world = createWorld({ seed: 883 });
  const c = world.creatures[0];
  c.pos.x = 0.5; c.pos.y = 0.5;
  c.facing.x = 1; c.facing.y = 0;
  c.vel.x = 0; c.vel.y = 0; c.moving = false;
  c.beingPetted = false;
  c.beingPoked = false;
  const body = createBody(c.traits);
  return { world, c, body };
}

const rendererStub = () => ({
  fx: { alpha: 1, squashV: 1, stretchH: 1 },
  sx: new Float64Array(CONFIG.bodyPoints),
  sy: new Float64Array(CONFIG.bodyPoints),
  squashAlong: 1, squashPerp: 1,
});

test('没被戳时一笔都不画，renderer 的坐标缓存保持原样', () => {
  const { c, body } = fixture();
  c.beingPoked = false;
  updateBody(body, c, DT, handAt(c, 0.04, 0));
  const r = rendererStub();
  r.sx.fill(7);
  r.sy.fill(9);
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, r, c, body, 100, 100, 30, 1, 0);
  assert.equal(ctx.count('beginPath'), 0);
  assert.equal(ctx.count('stroke'), 0);
  assert.equal(r.sx[0], 7, '没戳时连坐标缓存都不许动（与抚摸层同一条纪律）');
});

test('被戳时画在**被戳的那一侧**：手在右，笔画就落在右半边', () => {
  const { c, body } = fixture();
  c.beingPoked = true;
  updateBody(body, c, DT, handAt(c, 0.05, 0));
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  const segs = ctx.calls.filter((x) => x.op === 'lineTo');
  assert.ok(segs.length >= CONFIG.fluff.pokeCount, `笔画太少：${segs.length}`);
  for (const s of segs) {
    assert.ok(s.args[0] > 100, `手在右边，笔画却落到了左边：x=${s.args[0].toFixed(1)}`);
  }
  // 反向：手换到左边，笔画必须整体翻过去 —— 只测一侧证明不了"方向来自手"。
  const { c: c2, body: b2 } = fixture();
  c2.beingPoked = true;
  updateBody(b2, c2, DT, handAt(c2, -0.05, 0));
  const ctx2 = createLogCtx();
  drawPokeFurLayer(ctx2, rendererStub(), c2, b2, 100, 100, 30, 1, 0);
  const segs2 = ctx2.calls.filter((x) => x.op === 'lineTo');
  assert.ok(segs2.length >= CONFIG.fluff.pokeCount);
  for (const s of segs2) assert.ok(s.args[0] < 100, `手在左边，笔画却落到了右边：x=${s.args[0].toFixed(1)}`);
});

test('炸开的毛**比轮廓更外**（是立起来，不是压下去），且比抚摸那道压毛带亮', () => {
  const { c, body } = fixture();
  c.beingPoked = true;
  updateBody(body, c, DT, handAt(c, 0.05, 0));
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  const segs = ctx.calls.filter((x) => x.op === 'lineTo');
  const maxDx = Math.max(...segs.map((s) => s.args[0] - 100));
  // 顶点必须真的探出轮廓：轮廓半径是 30，毛尖再长 pokeLen×r 出去。
  assert.ok(maxDx > 30, `笔画最远只到 ${maxDx.toFixed(1)}px —— 没立起来`);
  // 描边色是**浅色**（hsl 的 lum 高于压毛带那条暗带的 alpha 语义）：
  // 这里钉的是"用的是 strokeStyle 且 alpha 高于抚摸压毛带"，因为两者都是半透明叠色。
  const alphaOf = (call) => {
    const v = String(call.args[0]);
    const m = v.match(/([\d.]+)\)\s*$/);
    return m ? Number(m[1]) : NaN;
  };
  const strokeSet = ctx.calls.filter((x) => x.op === 'set:strokeStyle').map(alphaOf).filter((n) => Number.isFinite(n));
  assert.ok(strokeSet.length >= 1, '炸毛必须设过 strokeStyle');
  assert.ok(strokeSet.some((a) => a > CONFIG.fluff.petPressAlpha),
    `炸毛要比压毛带显眼（>${CONFIG.fluff.petPressAlpha}），实测 ${strokeSet.join(',')}`);
});

test('竖直方向的手也一样跟：手在下方，笔画就落向下半边', () => {
  const { c, body } = fixture();
  c.beingPoked = true;
  // ⚠️ 世界/屏幕的 y 轴**向下**（与 canvas 一致，sim 里的 pos.y 也是这个方向）：
  // handAt(+0.05) 是"手在下方"。第一版这条测试按"向上"写，实现没错、判据反了。
  updateBody(body, c, DT, handAt(c, 0, 0.05));
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  const segs = ctx.calls.filter((x) => x.op === 'lineTo');
  assert.ok(segs.length >= CONFIG.fluff.pokeCount);
  for (const s of segs) assert.ok(s.args[1] > 100, `手在下方，笔画却落到了上方：y=${s.args[1].toFixed(1)}`);
  // 反向：手在上方（-0.05）时笔画必须整体翻上去
  const { c: c2, body: b2 } = fixture();
  c2.beingPoked = true;
  updateBody(b2, c2, DT, handAt(c2, 0, -0.05));
  const ctx2 = createLogCtx();
  drawPokeFurLayer(ctx2, rendererStub(), c2, b2, 100, 100, 30, 1, 0);
  for (const s of ctx2.calls.filter((x) => x.op === 'lineTo')) {
    assert.ok(s.args[1] < 100, `手在上方，笔画却落到了下方：y=${s.args[1].toFixed(1)}`);
  }
});

test('病号与死者不炸毛；每帧只画 1 次 path、不新增任何 sprite', () => {
  for (const patch of [{ sick: true }, { alive: false }]) {
    const { c, body } = fixture();
    c.beingPoked = true;
    Object.assign(c, patch);
    updateBody(body, c, DT, handAt(c, 0.05, 0));
    const ctx = createLogCtx();
    drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
    assert.equal(ctx.count('stroke'), 0, `${JSON.stringify(patch)} 不许炸毛`);
  }
  const { c, body } = fixture();
  c.beingPoked = true;
  updateBody(body, c, DT, handAt(c, 0.05, 0));
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(ctx.count('beginPath'), 1, '所有炸毛段共用一条 path：每只每帧只多一次 stroke');
  assert.equal(ctx.count('stroke'), 1);
  assert.equal(ctx.count('drawImage'), 0, '这一层不许贴图（sprite 账单不能动）');
  assert.equal(ctx.count('createRadialGradient'), 0, '也不许在帧里建渐变（§5.3 零分配）');
});

test('抚摸与戳互不冒充：只摸不戳时不走炸毛；只戳不摸时不走倒伏', () => {
  const { c, body } = fixture();
  c.beingPoked = false;
  c.beingPetted = true;
  updateBody(body, c, DT, handAt(c, 0.04, 0));
  const ctx = createLogCtx();
  drawPokeFurLayer(ctx, rendererStub(), c, body, 100, 100, 30, 1, 0);
  assert.equal(ctx.count('stroke'), 0, '摸的时候不该炸毛');

  const { c: c2, body: b2 } = fixture();
  c2.beingPoked = true;
  c2.beingPetted = false;
  updateBody(b2, c2, DT, handAt(c2, 0.06, 0));
  const ctx2 = createLogCtx();
  drawPetFurLayer(ctx2, rendererStub(), c2, b2, 100, 100, 30, 1, 0);
  assert.equal(ctx2.count('stroke'), 0, '戳的时候不该倒伏');

  // 两者同时成立（同一根手指不可能，但脏状态不许让两层叠出双倍笔画）
  const { c: c3, body: b3 } = fixture();
  c3.beingPoked = true;
  c3.beingPetted = true;
  updateBody(b3, c3, DT, handAt(c3, 0.06, 0));
  const ctx3 = createLogCtx();
  drawPokeFurLayer(ctx3, rendererStub(), c3, b3, 100, 100, 30, 1, 0);
  assert.equal(ctx3.count('beginPath'), 1, '两层同开时炸毛仍然只有一条 path');
});
