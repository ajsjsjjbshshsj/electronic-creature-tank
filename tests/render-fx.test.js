import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { tickEgg } from '../src/breeding.js';
import { createBody, updateBody, begLevelOf } from '../src/body.js';
import { begEscalation } from '../src/behavior.js';
import { createCreature } from '../src/creature.js';
import { createRng } from '../src/rng.js';
import { createViewport } from '../src/main.js';
import {
  createRenderer, drawCreature, writeBodyScreen, screenY, radiusPx,
  dissolveT, dissolveAlphaOf, dissolveGlowOf, dissolveExpandOf, dissolveLiftOf,
  dimFactorFor, sickDesaturate,
  hopProgress, hopImpulse, hopLiftAt, hopSquashAt,
  eggGlowFor, eggShellRevealFor, eggRadiusPx, eggTintHex,
  foodRadiusPx, foodColorFor, drawEggs, drawFoods,
  createBursts, burst, updateBursts, drawBursts, consumeEvents,
} from '../src/render.js';

// ==================================================================== 桩
//
// 与 tests/render.test.js（B13）/ tests/render-body.test.js（B14/B15）**同一套记录型桩**：
// 只统计「方法被调用的次数」与「属性被写入的次数」与它们的**先后**，
// 不模拟像素、不记颜色、不记参数值、不记朝向。
//
// ⚠️ 因此本文件**刻意不写**下列断言（它们进手工清单，见文件末尾那一条）：
//   · 溶散好不好看、微粒够不够"上升消散"而不是"炸开"
//   · 八色蛋在深靛紫底上读不读得出来马卡龙（颜色只能由 CONFIG 侧断言，屏上的读感不能）
//   · 跳起来到底有没有"落地感"
//   · 三种食物的颜色一眼能不能分开（桩看不见 fillStyle 的**值**）
// 桩数得出的东西全部数了：调用次数、上界、顺序、深度，以及**纯函数的数值形状**。

const GRADIENT_STUB = { addColorStop() {} };

function createLogCtx() {
  const counts = new Map();
  const ops = [];
  let depth = 0;
  const stub = {
    ops,
    counts,
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    lastGlobalAlpha: 1,
    alphaAtDraw: [],
    reset() {
      counts.clear(); ops.length = 0; depth = 0;
      stub.shadowBlurWrites = 0; stub.alphaAtDraw.length = 0; stub.lastGlobalAlpha = 1;
    },
    count(name) { return counts.get(name) || 0; },
    indexOf(name) { return ops.findIndex((o) => o.op === name); },
    indicesOf(name) { const out = []; ops.forEach((o, i) => { if (o.op === name) out.push(i); }); return out; },
  };
  const bump = (name) => { counts.set(name, (counts.get(name) || 0) + 1); return name; };
  for (const m of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
    'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'clearRect',
    'fillRect', 'translate', 'rotate', 'scale', 'drawImage', 'fillText', 'setTransform']) {
    // ⚠️ drawImage 额外记一笔**当时的 globalAlpha**。这是本桩唯一一处记"值"的地方，
    // 理由是探针 P7 逼出来的：变暗系数被写死成 1 时，次数、顺序、上界**一条都不变**，
    // 而"死掉与坏掉的个体必须看得见"是 spec §7.7 的硬要求。
    // 只记 drawImage 这一处、只记这一个属性 —— 全面记值会让每条断言都对参数脆断，
    // 那是 B13/B14 立"只数次数"这条纪律时要避免的东西。
    if (m === 'drawImage') {
      stub[m] = () => { ops.push({ op: bump(m), depth }); stub.alphaAtDraw.push(stub.lastGlobalAlpha); };
      continue;
    }
    stub[m] = () => { ops.push({ op: bump(m), depth }); };
  }
  stub.alphaAtDraw = [];
  stub.save = () => { depth += 1; ops.push({ op: bump('save'), depth }); };
  stub.restore = () => { ops.push({ op: bump('restore'), depth }); depth -= 1; };
  stub.createRadialGradient = () => {
    counts.set('createRadialGradient', (counts.get('createRadialGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.createLinearGradient = () => {
    counts.set('createLinearGradient', (counts.get('createLinearGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.measureText = () => ({ width: 0 });
  const trackAttr = (name, store) => {
    let value = 0;
    Object.defineProperty(stub, name, {
      get() { return value; },
      set(v) {
        value = v;
        counts.set(name, (counts.get(name) || 0) + 1);
        if (name === 'globalAlpha') stub.lastGlobalAlpha = v;
        if (store) ops.push({ op: name, depth });
      },
    });
  };
  trackAttr('globalAlpha', true);
  trackAttr('globalCompositeOperation', true);
  trackAttr('fillStyle', true);
  trackAttr('strokeStyle', true);
  trackAttr('lineWidth', false);
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return stub._shadowBlur; },
    set(v) { stub.shadowBlurWrites += 1; stub._shadowBlur = v; },
  });
  return stub;
}

const makeCanvasStub = (created) => (w, h) => {
  const c = createLogCtx();
  c.width = w; c.height = h;
  if (created) created.push(c);
  return { ctx: c, surface: c };
};

const DESKTOP = createViewport(1920, 1080, 1);
const PHONE = createViewport(390, 844, 3);

const makeWorld = (seed) => {
  const w = createWorld({ seed });
  for (let i = 0; i < 30; i++) tickWorld(w, CONFIG.fixedDt);
  return w;
};

const makeBodies = (world) => {
  const bodies = new Map();
  for (const c of world.creatures) {
    const b = createBody(c.traits);
    for (let i = 0; i < 30; i++) updateBody(b, c, CONFIG.fixedDt);
    bodies.set(c.id, b);
  }
  return bodies;
};

const makeRenderer = (world, viewport, isMobile, created) => createRenderer({
  makeCanvas: makeCanvasStub(created), rng: world.rng.fork(), viewport, isMobile,
});

// B14 立下的三条精确上界，B16 一条都不许动（本文件末尾把它们在**含卵/食物/溶散/粒子**的
// 场景下重跑一遍，而不是只重跑干净缸）。
const DI_PER_CREATURE = 7;
const BEZIER_PER_CREATURE = CONFIG.bodyPoints;

// 造一只"只改一个读数"的个体：溶散 / sick / 哀悼 / hop / 求关注都只读 creature 上
// 的既有字段，所以夹具只需要标准生物 + 那一个字段，不必跑完整套内核。
const fixture = (over) => {
  const c = createCreature({
    id: 'c-fx', name: '测试', x: 0.4, y: 0.5, age: 900, stage: 'adult',
    genes: {
      hue: [0.83, 0.85], size: [0.5, 0.5], pattern: [0.2, 0.2], patternDensity: [0.5, 0.5],
      glow: [0.6, 0.6], sat: [0.7, 0.7], lum: [0.7, 0.7], wobble: [0.5, 0.5],
      fluff: [0.6, 0.6], eggTint: [0.1, 0.1],
      bold: [0.5, 0.5], clingy: [0.5, 0.5], irritable: [0.5, 0.5], gluttonous: [0.5, 0.5],
      curious: [0.5, 0.5], activity: [0.5, 0.5], talk: [0.5, 0.5], intellect: [0.5, 0.5],
      broody: [0.5, 0.5],
    },
    generation: 1, rng: createRng(7),
  });
  return Object.assign(c, over || {});
};

const eggFixture = (over) => Object.assign({
  id: 'e1', genes: null, age: 0, pos: { x: 0.5, y: 0.9 },
  motherId: 'c1', fatherId: null,
  eggSize: (CONFIG.eggSize.min + CONFIG.eggSize.max) / 2,
  eggTint: CONFIG.eggTint.colors[0], viable: true,
}, over || {});

// 十六进制 → 色相。测试专用的小工具，**不进 src/**：表现层不得自己解码颜色空间，
// 但测试需要一个独立判定来交叉验证 CONFIG 里的颜色，否则就是拿实现验实现。
// （沿用旧计划 Task 7 的这段，它对付的是"粉色区间跨 0°"那个坑。）
function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  assert.ok(m, `${hex} 不是 #RRGGBB`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function hexToHue(hex) {
  const [r255, g255, b255] = hexToRgb(hex);
  const r = r255 / 255, g = g255 / 255, b = b255 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
// 相对亮度（WCAG 的那条线性化 + 系数），用于"在深靛紫底上可读"这条 spec §11 的硬要求。
function luminance(hex) {
  const lin = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// ============================================================ 一、死亡溶散
//
// spec §4.11 死亡那一行：「停止运动 → 光慢慢熄灭 → 身体溶散成微粒上升消散」。
// 停止运动是内核的事（alive=false 之后不再决策），**光先熄灭、身体后散开**是表现层的事。

test('dissolveT 只读 c.dying 与 CONFIG.dissolveDuration，越界与脏值都安全', () => {
  // ⚠️ 表现层**不得**自己另计一套溶散时钟：reapDead 就是按 dying >= dissolveDuration
  // 才把个体 splice 掉的。两套时钟必然漂移，症状是"动画没播完生物就没了"或反过来。
  assert.equal(dissolveT(fixture({ alive: true, dying: 0 })), 0, '活着的个体没有溶散进度');
  assert.equal(dissolveT(fixture({ alive: false, dying: 0 })), 0);
  assert.equal(dissolveT(fixture({ alive: false, dying: CONFIG.dissolveDuration / 2 })), 0.5);
  assert.equal(dissolveT(fixture({ alive: false, dying: CONFIG.dissolveDuration })), 1);
  // 脏存档防御（计划 1 的先例：负值、NaN、越界一律吃掉，不许传染成 NaN 的 alpha）
  assert.equal(dissolveT(fixture({ alive: false, dying: -5 })), 0, '负的 dying 当成"刚开始"');
  assert.equal(dissolveT(fixture({ alive: false, dying: CONFIG.dissolveDuration * 3 })), 1,
    '超时长（同一帧里 render 还拿着它）必须夹在 1，不许继续外推');
  assert.equal(dissolveT(fixture({ alive: false, dying: NaN })), 0, 'NaN 必须给 0');
  assert.equal(CONFIG.dissolveDuration, 4, '溶散时长来自内核那一个数（4 秒），不是表现层自定');
});

test('溶散四条曲线：光比身体先熄灭、身体散开而不是缩没、并逐渐上浮', () => {
  const pts = [0, 0.25, 0.5, 0.75, 1];
  const alpha = pts.map(dissolveAlphaOf);
  const glow = pts.map(dissolveGlowOf);
  const expand = pts.map(dissolveExpandOf);
  const lift = pts.map(dissolveLiftOf);
  for (const [name, arr] of [['alpha', alpha], ['glow', glow]]) {
    assert.equal(arr[0], 1, `${name} 起点应当满值`);
    assert.ok(arr[1] > arr[2] && arr[2] > arr[3] && arr[3] > arr[4], `${name} 必须单调变淡`);
  }
  assert.ok(alpha[4] <= 1e-9, `溶散结束时身体必须完全透明：${alpha[4]}`);
  assert.ok(glow[4] <= 1e-9, `结束时光也必须熄灭：${glow[4]}`);
  // spec 那句话的顺序是"光慢慢熄灭"在"身体溶散"**之前** ⇒ 同一条进度上光必须更暗
  for (let i = 1; i < 4; i++) {
    assert.ok(glow[i] < alpha[i],
      `t=${pts[i]} 时光应当比身体先熄灭：glow ${glow[i]} vs alpha ${alpha[i]}`);
  }
  assert.equal(expand[0], 1, '未开始时体型不变');
  assert.ok(expand[1] < expand[2] && expand[2] < expand[3] && expand[3] < expand[4],
    '必须逐渐散开');
  assert.ok(Math.abs(expand[4] - CONFIG.render.dissolveExpand) < 1e-12,
    `终点等于 CONFIG.render.dissolveExpand（${CONFIG.render.dissolveExpand}），实测 ${expand[4]}`);
  assert.ok(expand[4] > 1, '散开的方向是变大，不是缩没');
  assert.equal(lift[0], 0, '未开始时不上浮');
  assert.ok(lift[1] < lift[2] && lift[2] < lift[4], '必须逐渐上浮（"溶进水里"）');
  assert.ok(lift[4] > 0 && Number.isFinite(lift[4]));
});

test('溶散中的身体仍然按 B14 的六层画满，只是被外层 alpha 与 expand 接管', () => {
  // spec §7.7 的反面：绝不静默。死亡必须看得见 —— 少画一层、提前消失都算违约。
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  const healthy = ctx.count('drawImage');
  assert.equal(healthy, DI_PER_CREATURE);
  ctx.reset();
  c.alive = false;
  c.dying = CONFIG.dissolveDuration * 0.5;
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(ctx.count('drawImage'), DI_PER_CREATURE,
    '溶散到一半的个体仍然画满六层（贴图次数与健康时逐次相同）');
  assert.equal(ctx.count('clip'), 1, '轮廓裁剪仍然只有那一次');
  assert.equal(ctx.count('bezierCurveTo'), BEZIER_PER_CREATURE);
  assert.equal(ctx.count('quadraticCurveTo'), 0);
});

test('溶散与 dim 的读数不写回 creature：每帧重算，不入档（spec §7.2）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.alive = false;
  c.dying = 1.25;
  const snapshot = () => JSON.stringify({
    keys: Object.keys(c).sort(), pos: c.pos, vel: c.vel, dying: c.dying, mourn: c.mourn,
  });
  const before = snapshot();
  const ctx = createLogCtx();
  for (let i = 0; i < 5; i++) drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(snapshot(), before,
    '绘制五帧之后 creature 的键集与位置必须逐字节相同（表现层的身体状态一律不入档）');
});

test('sick 个体被画成静止、变暗，但一次贴图都不少（spec §7.7 "绝不静默"）', () => {
  // sim.js 把这条义务点名交给了表现层：「sick 个体仍然留在 creatures 里被 render 画出来
  // （变暗、静止），这样问题对用户是可见的，而不是无声地少了一只。」
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  const healthyDraws = ctx.count('drawImage');
  const healthyAlphas = ctx.count('globalAlpha');
  ctx.reset();
  c.sick = true;
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(ctx.count('drawImage'), healthyDraws,
    'sick 不得被跳过任何一层 —— 跳过就是"悄悄少一只"');
  assert.equal(ctx.count('globalAlpha'), healthyAlphas,
    '变暗走的是同一批 globalAlpha 写入（乘上去），不是新增一层也不是少画一层');
  const healthyAlpha = dimFactorFor(fixture({ alive: true, sick: false, mourn: 0 }));
  assert.equal(healthyAlpha, 1, '健康个体的亮度乘数必须恰好是 1（不改亮度）');
  assert.ok(dimFactorFor(c) < healthyAlpha, 'sick 的亮度乘数必须明显低于健康个体');
  assert.ok(dimFactorFor(c) > 0, '但也不能暗到看不见（暗到 0 等于又把它藏起来了）');
});

test('sick 的去饱和只动饱和度，且复用已有的低饱和档 sprite（不新建离屏画布）', () => {
  const t = fixture({}).traits;
  assert.ok(sickDesaturate(t.sat) < t.sat, 'sick 必须真的掉饱和度');
  assert.equal(sickDesaturate(t.sat), t.sat * (1 - CONFIG.render.sickDesat),
    '去饱和幅度唯一来自 CONFIG.render.sickDesat');
  assert.equal(sickDesaturate(0), 0);
  assert.equal(sickDesaturate(NaN), 0, '脏值不许传染成 NaN');
  assert.ok(sickDesaturate(9) <= 1 && sickDesaturate(-3) >= 0, '越界输入必须夹回 [0,1]');
  // ⚠️ 用 ctx.filter='saturate()' 是最直接的写法，但它在部分移动端浏览器上不支持或极慢，
  // 而 spec §5.3 的预算是按手机算的 ⇒ 这里用**取色换档**：饱和度落到既有的低饱和档上。
  // 扫描必须**先剥注释**（与 constraints.test.js 同一套启发式）：render.js 的模块头与
  // sickDesaturate 上方都要靠提到 ctx.filter 来说明"为什么不用它"，不剥就会把纪律本身
  // 当成违规（这正是 constraints.test.js 注释里记的那类假阳性）。
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/\bctx\.filter\b/.test(src), 'render.js 不得使用 ctx.filter（移动端性能未知）');
  // 反向防空转：同一条正则必须能在**没剥注释**的原文里数出那句话来，
  // 否则"剥完之后什么都不剩"的扫描器等于什么都没测。
  const raw = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  assert.ok(/\bctx\.filter\b/.test(raw), '防空转：那条不用 ctx.filter 的理由必须写在注释里');
});

test('哀悼是"停顿、变暗一小会儿"，而且暗得比 sick 轻（spec §4.11 / §7.7 分得开）', () => {
  const full = CONFIG.mournDuration;
  const justLost = fixture({ alive: true, sick: false, mourn: full });
  const recovering = fixture({ alive: true, sick: false, mourn: full / 2 });
  const over = fixture({ alive: true, sick: false, mourn: full * 3 });
  const done = fixture({ alive: true, sick: false, mourn: 0 });
  assert.ok(Math.abs(dimFactorFor(justLost) - CONFIG.render.mournDim) < 1e-12,
    `满值时就是 CONFIG.render.mournDim，实测 ${dimFactorFor(justLost)}`);
  assert.ok(dimFactorFor(justLost) < dimFactorFor(recovering)
    && dimFactorFor(recovering) < dimFactorFor(done),
    '哀悼按剩余时间**线性回到正常**，不许到点突然变亮');
  assert.equal(dimFactorFor(over), CONFIG.render.mournDim, '剩余时间越界必须夹住');
  assert.ok(CONFIG.render.mournDim > CONFIG.render.sickDim,
    '哀悼是情绪、sick 是故障：前者若暗得比后者还狠，玩家会以为它坏了');
  assert.ok(dimFactorFor(fixture({ alive: false, dying: 1, mourn: 0 })) === 1,
    '尸体那一侧由 dissolveAlphaOf 接管，dimFactorFor 不重复施压（否则两头相乘成双倍暗）');
});

// ======================================================== 二、溶散微粒（对象池）

test('burst 环形写入：池满只覆盖最老的粒子，永不扩容（spec §5.3 运行时不分配）', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const cap = r.bursts.n;
  assert.equal(cap, CONFIG.render.burstPool);
  for (let k = 0; k < 40; k++) {
    consumeEvents(r, [{ kind: 'death', id: 'c1', pos: { x: 0.5, y: 0.5 }, name: 'x' }]);
  }
  assert.equal(r.bursts.n, cap, '粒子池不得扩容（扩容 = 运行时分配）');
  assert.ok(r.bursts.live <= cap, `live 不得越过池容量：${r.bursts.live}`);
  for (let i = 0; i < cap; i++) {
    assert.ok(Number.isFinite(r.bursts.x[i]) && Number.isFinite(r.bursts.y[i]),
      `粒子 ${i} 坐标不是有限数（环形写入越界了）`);
    assert.ok(r.bursts.life[i] >= 0);
  }
});

test('consumeEvents 覆盖内核当前发的一切事件种类且不抛；它不清空 events', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const id = world.creatures[0].id;
  const all = [
    { kind: 'eat', id, foodId: 'f1', foodKind: 'algae' },
    { kind: 'laid', id, eggs: 2, atPopulationCap: false },
    { kind: 'say', id, text: '喵', tokens: 1, mood: '快乐' },
    { kind: 'death', id, pos: { x: 0.5, y: 0.5 }, name: 'x' },
    { kind: 'dissolved', id },
    { kind: 'drift', id: 'e-drift-1' },
    { kind: 'emigrate', id, age: 1000 },
    { kind: 'hatch', id, pos: { x: 0.5, y: 0.9 }, eggId: 'e1' },
    { kind: 'eggFailed', id: 'e2', pos: { x: 0.5, y: 0.9 } },
  ];
  for (const ev of all) {
    assert.doesNotThrow(() => consumeEvents(r, [ev]), `事件 ${ev.kind} 让 consumeEvents 抛了`);
  }
  assert.doesNotThrow(() => consumeEvents(r, [{ kind: 'something-new', id }]));
  assert.doesNotThrow(() => consumeEvents(r, []));
  // 死亡要真的放粒子，而且粒子数就是 CONFIG 那个数
  const before = r.bursts.live;
  consumeEvents(r, [{ kind: 'death', id, pos: { x: 0.3, y: 0.4 }, name: 'x' }]);
  assert.equal(r.bursts.live - before, CONFIG.render.dissolveParticles,
    '每只死亡爆发的微粒数唯一来自 CONFIG.render.dissolveParticles');
  // ⚠️ **不清空**：清空由 main.js 每帧做，因为 audio（B18）要消费同一批事件。
  // 谁先清空谁就把事件从另一个人手里抢走了。
  const evs = [{ kind: 'death', id, pos: { x: 0.1, y: 0.1 }, name: 'x' }];
  consumeEvents(r, evs);
  assert.equal(evs.length, 1, 'consumeEvents 不得清空传入的事件数组');
});

test('溶散粒子全部用同一张微粒 sprite 缩放：一帧 N 次贴图、零新建画布、零贝塞尔', () => {
  const created = [];
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false, created);
  const n0 = created.length;
  consumeEvents(r, [{ kind: 'death', id: 'c1', pos: { x: 0.5, y: 0.5 }, name: 'x' }]);
  const ctx = createLogCtx();
  const live = r.bursts.live;
  drawBursts(ctx, r, DESKTOP);
  assert.equal(ctx.count('drawImage'), live,
    '每颗粒一次贴图，且用的是同一张 sprite（为每颗粒建画布就是 B14 那条上界的死法）');
  assert.equal(created.length, n0, '粒子不许新建任何离屏画布');
  assert.equal(ctx.count('quadraticCurveTo'), 0);
  assert.equal(ctx.count('bezierCurveTo'), 0);
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('save'), ctx.count('restore'), 'save/restore 必须成对');
  ctx.reset();
  drawBursts(ctx, r, DESKTOP);
  assert.equal(ctx.count('drawImage'), live, '同一帧重复绘制次数稳定（粒子不自己增长）');
});

test('粒子积分随时间收敛到零活口，且位置不发散', () => {
  const b = createBursts(CONFIG.render.burstPool);
  burst({ bursts: b }, 0.5, 0.5, 0, CONFIG.render.dissolveParticles);
  assert.equal(b.live, CONFIG.render.dissolveParticles);
  const dt = CONFIG.fixedDt;
  for (let i = 0; i < 60 * 4; i++) updateBursts(b, dt);
  assert.equal(b.live, 0, '四秒内粒子必须全部消亡（溶散不是一场永不停的下雪）');
  for (let i = 0; i < 60 * 200; i++) updateBursts(b, dt);
  assert.equal(b.live, 0, '没有活口时不得凭空复活');
  for (let i = 0; i < b.n; i++) {
    assert.ok(Number.isFinite(b.x[i]) && Number.isFinite(b.y[i]), `粒子 ${i} 发散了`);
  }
});

test('粒子随机来自可复现的确定性流：同样的事件序列在两台设备上给出同样的粒子（纪律 2）', () => {
  // 溶散粒子的抖动**不取 rng**（帧率相关的 rng 消耗会让同种子在不同设备上跑出不同的水），
  // 也不许用 Math.random ⇒ 它只能是环形游标自身的确定性哈希。两台设备逐位相同。
  const mk = () => {
    const world = createWorld({ seed: 4242 });
    return createRenderer({
      makeCanvas: makeCanvasStub(), rng: world.rng.fork(), viewport: DESKTOP, isMobile: false,
    });
  };
  const a = mk(), b = mk();
  const events = [
    { kind: 'death', id: 'x', pos: { x: 0.21, y: 0.66 }, name: 'n' },
    { kind: 'hatch', id: 'y', pos: { x: 0.83, y: 0.12 }, eggId: 'e' },
  ];
  consumeEvents(a, events);
  consumeEvents(b, events);
  for (let i = 0; i < a.bursts.n; i++) {
    assert.equal(a.bursts.x[i], b.bursts.x[i]);
    assert.equal(a.bursts.y[i], b.bursts.y[i]);
    assert.equal(a.bursts.vx[i], b.bursts.vx[i]);
    assert.equal(a.bursts.life[i], b.bursts.life[i]);
  }
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  assert.ok(!/Math\.random\s*\(/.test(src), 'render.js 不得调用 Math.random()');
});

// ================================================================ 三、hop 蹦跳
//
// spec §4.7.2：「跳起冲量 = base × (0.5 + activity) ⇒ 好动的跳得高」
//         §4.7.2：「落地 = 走 §4.7 的 squash & overshoot」
// 身体模型是 2D 的（body.points 在平面上），所以"跳起来"需要一条**竖向偏移**，
// 而它不是世界状态 ⇒ 必须由渲染层从 intent.kind/intentTime 推导，每帧重算、不入档。

test('hopProgress 只在 intent.kind 是 hop 时非零，且时长读 intent.minDuration 不重抄公式', () => {
  const inHop = fixture({ intent: { kind: 'hop', minDuration: 0.84 }, intentTime: 0.42 });
  assert.ok(Math.abs(hopProgress(inHop) - 0.5) < 1e-12, '半程 = 0.5');
  // ⚠️ 时长**读内核给的 intent.minDuration**，不在表现层重抄 spec §4.7.2 的
  // 0.6/(0.3+activity)：内核那一处目前是常数 0.84s（已知偏差，另有单独提交处理）。
  // 表现层跟着读数走，将来内核改掉那条公式时这里一行都不用动。
  const shortHop = fixture({ intent: { kind: 'hop', minDuration: 0.42 }, intentTime: 0.42 });
  assert.equal(hopProgress(shortHop), 1, '同样的 intentTime、更短的 minDuration ⇒ 进度更大');
  assert.ok(hopProgress(inHop) < hopProgress(shortHop));
  for (const kind of ['beg', 'protest', 'idle', 'forage']) {
    assert.equal(hopProgress(fixture({ intent: { kind, minDuration: 0.84 }, intentTime: 0.4 })), 0,
      `${kind} 意图不许产生蹦跳偏移`);
  }
  assert.equal(hopProgress(fixture({ intent: null, intentTime: 0 })), 0);
  assert.equal(hopProgress(fixture({ intent: { kind: 'hop', minDuration: 0 }, intentTime: 0.3 })), 0,
    'minDuration 为 0（脏值）必须给 0，不许除出 Infinity');
  assert.equal(hopProgress(fixture({ intent: { kind: 'hop', minDuration: NaN }, intentTime: 0.3 })), 0);
  assert.equal(hopProgress(fixture({ intent: { kind: 'hop', minDuration: 0.84 }, intentTime: 99 })), 1,
    '越界夹到 1（意图换掉之前那一帧仍然要收敛）');
  assert.equal(hopProgress(fixture({ intent: { kind: 'hop', minDuration: 0.84 }, intentTime: -1 })), 0);
});

test('hopImpulse 逐字实现 spec §4.7.2：base × (0.5 + activity)（CONFIG.hop.impulseBase 的第一个消费者）', () => {
  const base = CONFIG.hop.impulseBase;
  assert.equal(base, 1.0, 'spec §11：HOP_IMPULSE_BASE = 1.0');
  assert.equal(hopImpulse(0), base * 0.5, 'activity=0 时冲量是 base 的一半（逐字）');
  assert.equal(hopImpulse(1), base * 1.5, 'activity=1 时是 1.5 倍（逐字）');
  assert.ok(hopImpulse(1) / hopImpulse(0) === 3, '好动的与不好动的冲量比恰为 3 倍');
  assert.ok(hopImpulse(0.8) > hopImpulse(0.2), '单调');
  assert.equal(hopImpulse(NaN), base * 0.5, '脏 activity 落到地板而不是炸成 NaN');
  assert.ok(hopImpulse(9) === hopImpulse(1), '越界夹到 1');
});

test('hop 的竖向轨迹形状：起跳→滞空→落地压扁→过冲回弹→恢复', () => {
  const impulse = hopImpulse(1);
  const LAND = CONFIG.render.hopLandAt;
  // ---- 起跳
  assert.equal(hopLiftAt(0, impulse), 0, '起跳瞬间位移为 0');
  assert.equal(hopSquashAt(0), 1, '起跳瞬间不形变');
  // ---- 滞空：抬起来，并且身体被**拉长**（spec §4.7 的 stretch）
  const apex = hopLiftAt(LAND / 2, impulse);
  assert.ok(apex > 0, `滞空时必须真的离开底部：lift ${apex}`);
  assert.ok(hopLiftAt(LAND * 0.25, impulse) < apex && apex > hopLiftAt(LAND * 0.75, impulse),
    '轨迹是抛物线形状：上升段比下降段早到顶，顶在滞空中点');
  assert.ok(hopSquashAt(LAND / 2) > 1,
    `滞空中点应当被拉长（>1），实测 ${hopSquashAt(LAND / 2)}`);
  // ---- 落地：位置回到地面，身体**压扁**（竖向尺度 < 1）
  assert.equal(hopLiftAt(LAND, impulse), 0, '落地那一刻抬升量归零');
  assert.ok(hopLiftAt(Math.min(1, LAND + 0.1), impulse) === 0, '落地之后不再离开地面');
  assert.ok(Math.abs(hopSquashAt(LAND) - CONFIG.render.hopSquashMin) < 1e-12,
    `落地那一刻压到 CONFIG.render.hopSquashMin，实测 ${hopSquashAt(LAND)}`);
  assert.ok(hopSquashAt(LAND) < 1, '压扁 = 竖向尺度小于 1');
  // ---- 过冲回弹：弹回来时**超过**原尺寸一点点，然后收敛（spec §4.7 的 overshoot）
  let maxOver = 1;
  for (let i = 0; i <= 200; i++) {
    const p = LAND + (1 - LAND) * (i / 200);
    if (hopSquashAt(p) > maxOver) maxOver = hopSquashAt(p);
  }
  assert.ok(maxOver > 1, `落地后必须过冲（超过静止尺寸），实测峰值尺度 ${maxOver}`);
  const dent = 1 - CONFIG.render.hopSquashMin;
  assert.ok(maxOver - 1 < dent,
    `过冲量必须小于压扁量（"超过原尺寸**一点点**"）：过冲 ${(maxOver - 1).toFixed(4)} vs 压扁 ${dent.toFixed(4)}`);
  // ---- 恢复：进度到 1 时严格回到恒等（不留残余形变，否则下一帧会"弹一下"）
  assert.ok(Math.abs(hopSquashAt(1) - 1) < 1e-12, `恢复必须恰好为 1，实测 ${hopSquashAt(1)}`);
  assert.equal(hopLiftAt(1, impulse), 0);
  assert.equal(hopSquashAt(0), 1);
  // ---- 冲量真的决定高度：spec 那句"好动的跳得高"
  assert.ok(Math.abs(hopLiftAt(LAND / 2, hopImpulse(1)) / hopLiftAt(LAND / 2, hopImpulse(0)) - 3) < 1e-9,
    '最高点高度之比必须等于冲量之比（3 倍）');
  // ---- 全程有限、不越界
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    const l = hopLiftAt(p, impulse), s = hopSquashAt(p);
    assert.ok(Number.isFinite(l) && l >= 0, `lift 在 p=${p} 越界：${l}`);
    assert.ok(Number.isFinite(s) && s > 0.2 && s < 3, `squash 在 p=${p} 越界：${s}`);
  }
});

test('hop 的竖向偏移**不是世界状态**：画一帧之后 pos/intent/intentTime 逐字段不变', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.intent = { kind: 'hop', minDuration: 0.84 };
  c.intentTime = 0.3;
  const snapshot = () => JSON.stringify({
    keys: Object.keys(c).sort(), pos: c.pos, vel: c.vel,
    intent: c.intent, intentTime: c.intentTime,
  });
  const before = snapshot();
  const ctx = createLogCtx();
  for (let i = 0; i < 8; i++) drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(snapshot(), before,
    'spec §7.2："表现层的身体状态一律不入档" —— 跳起来这件事不许写进 creature');
  assert.ok(!('hopLift' in c) && !('hopSquash' in c) && !('bounce' in c),
    'creature 上不许长出表现层自己造的字段');
});

test('hop 的 squash 与毛边/亮区走同一条矩阵，且体积守恒（横向按倒数补偿）', () => {
  // spec §4.7："毛必须跟着形变走……而不是重新计算毛的位置"。
  // 竖向压扁如果没有同时把横向拉开，跳起来就是一只忽大忽小的星，不是压扁。
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const body = createBody({ wobble: 0.5, fluff: 0.6 });
  const facing = { x: 1, y: 0 };
  writeBodyScreen(r, body, 500, 300, 40, facing);
  const baseAlong = new Float64Array(r.sx), basePerp = new Float64Array(r.sy);
  writeBodyScreen(r, body, 500, 300, 40, facing, 0.5);
  for (let i = 0; i < CONFIG.bodyPoints; i++) {
    assert.ok(Math.abs((r.sx[i] - 500) - (baseAlong[i] - 500) * 2) < 1e-9,
      `点 ${i} 的横向应当放大 1/0.5 = 2 倍（体积守恒），实测 ${r.sx[i] - 500} vs ${(baseAlong[i] - 500) * 2}`);
    assert.ok(Math.abs((r.sy[i] - 300) - (basePerp[i] - 300) * 0.5) < 1e-9,
      `点 ${i} 的竖向应当压到 0.5 倍，实测 ${r.sy[i] - 300}`);
  }
  assert.equal(r.squashAlong, 1, '量出的 squash 仍然是**身体自己**的形变，不掺 hop 那一项');
  assert.equal(r.squashPerp, 1);
  // 默认（不传第七参）与传 1 逐位相同 ⇒ B14/B15 既有的那些坐标断言一个字都没改
  writeBodyScreen(r, body, 500, 300, 40, facing);
  for (let i = 0; i < CONFIG.bodyPoints; i++) assert.equal(r.sx[i], baseAlong[i]);
});

test('hop 中仍然恰好 7 次贴图：竖向偏移靠几何，不靠新增一层', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.intent = { kind: 'hop', minDuration: 0.84 };
  c.intentTime = 0.6;
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(ctx.count('drawImage'), DI_PER_CREATURE);
  assert.equal(ctx.count('clip'), 1);
  assert.equal(ctx.count('globalCompositeOperation'), 3);
  const st = ctx.indicesOf('setTransform');
  assert.ok(st.length >= 2, '亮区与碎边各一次矩阵变换（hop 的 squash 就乘在这两个矩阵里）');
  assert.equal(ctx.ops[st[st.length - 1] + 1].op, 'drawImage',
    '碎边仍然是"一次 setTransform + 一次 drawImage"：hop 不许给毛开路径');
});

// ==================================================== 四、求关注升级链的三档表现

test('body.begLevelOf 与内核 behavior.begEscalation 的档位逐点相同（两处定义不许分家）', () => {
  // body.js **没有** import begEscalation 而是自己按同一份 CONFIG 阈值比了两次：
  // 那个函数每次调用都要新分配一个对象，而 updateBody 跑在每只每子步上
  // （24 只 × 60 子步 = 每秒 1440 次分配，spec §5.3 明令禁止）。
  // 分家的代价由这条扫描线守住。
  const E = CONFIG.behavior.begEscalate;
  const probes = [0, 0.5, E.hopAfter - 0.001, E.hopAfter, E.hopAfter + 0.5,
    E.protestAfter - 0.001, E.protestAfter, E.protestAfter + 3, -1, NaN];
  for (const ignored of probes) {
    const c = fixture({ begIgnored: ignored });
    assert.equal(begLevelOf(c), begEscalation(c).level,
      `begIgnored=${ignored} 时 body 侧与 behavior 侧的档位必须相同`);
  }
});

test('求关注三档在尾巴上互不相同：第一档幅度拉满、第二档换成急促（替换而非叠加）', () => {
  const step = (ignored) => {
    const c = fixture({ begIgnored: ignored });
    // 三档共用同一份情绪读数 ⇒ 测到的差异只可能来自 begIgnored 本身
    c.emotions.joy = 0.3; c.emotions.anger = 0; c.emotions.fear = 0;
    c.emotions.arousal = 0.2; c.emotions.sleepy = 0;
    const body = createBody(c.traits);
    for (let i = 0; i < 30; i++) updateBody(body, c, CONFIG.fixedDt);
    return { body, c };
  };
  const a = step(0), b = step(CONFIG.behavior.begEscalate.hopAfter + 0.5),
    d = step(CONFIG.behavior.begEscalate.protestAfter + 0.5);
  assert.ok(b.body.tail.amp > a.body.tail.amp,
    `第一档"尾巴幅度拉满"：amp ${a.body.tail.amp} → ${b.body.tail.amp}`);
  assert.ok(Math.abs(d.body.tail.amp - a.body.tail.amp) < 1e-12,
    '第二档不再加幅度（spec §4.10 裁定：两级的出口是**替换而非叠加**）');
  // 第二档换的是**摆速**（急促前后抽），第一档只换幅度 —— 所以三档的读数两两不同：
  // 0 与 1 差在 amp，0/1 与 2 差在 rate。断言写成"三档的 rate 严格递增"是**错的**：
  // 第一档并不跳得更快，它只是把尾巴摇得更开（实测 1.296 / 1.296 / 2.4624）。
  assert.ok(Math.abs(b.body.tail.rate - a.body.tail.rate) < 1e-12,
    `第一档不该改摆速（幅度拉满而已）：${a.body.tail.rate} vs ${b.body.tail.rate}`);
  assert.ok(d.body.tail.rate > a.body.tail.rate && d.body.tail.rate > b.body.tail.rate,
    `第二档的摆速必须真的更快：${a.body.tail.rate} / ${b.body.tail.rate} / ${d.body.tail.rate}`);
  // 摆幅直接决定屏幕上的举高（render.tailLiftPx 读 amp），所以 0/1 两档的举高也不同：
  // 上面那条 amp(0) === amp(2) 是**刻度不同**而非"两档一样"，那条区别落在 rate 上。
  assert.ok(b.body.tail.drive !== 0 && a.body.tail.drive !== 0,
    '两档都还在摆（不是把第一档做成"僵住"）');
});

test('第二档的"急促"在 20 模拟秒里数得出更多次方向翻转（画面上读得出"生气"）', () => {
  const crossings = (ignored) => {
    const c = fixture({ begIgnored: ignored });
    c.emotions.joy = 0.3; c.emotions.fear = 0; c.emotions.sleepy = 0;
    const body = createBody(c.traits);
    let prev = 0, n = 0;
    for (let i = 0; i < 60 * 20; i++) {
      updateBody(body, c, CONFIG.fixedDt);
      const d = body.tail.drive;
      if (prev !== 0 && Math.sign(d) !== prev) n += 1;
      if (d !== 0) prev = Math.sign(d);
    }
    return n;
  };
  const calm = crossings(0);
  const angry = crossings(CONFIG.behavior.begEscalate.protestAfter + 0.5);
  assert.ok(angry > calm, `第二档的过零次数必须更多（急促前后抽）：${angry} vs ${calm}`);
});

test('三档的贴图账单完全相同：升级链不新增任何一层（B14 的 7 次不动）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  for (const ignored of [0, 3.5, 8.5]) {
    c.begIgnored = ignored;
    const b = createBody(c.traits);
    for (let i = 0; i < 30; i++) updateBody(b, c, CONFIG.fixedDt);
    ctx.reset();
    drawCreature(ctx, r, c, b, DESKTOP);
    assert.equal(ctx.count('drawImage'), DI_PER_CREATURE, `begIgnored=${ignored} 的贴图账单变了`);
    assert.equal(ctx.count('bezierCurveTo'), BEZIER_PER_CREATURE);
    assert.equal(ctx.count('quadraticCurveTo'), 0);
    assert.equal(ctx.count('save'), ctx.count('restore'));
  }
});

// ==================================================================== 五、卵

test('eggGlowFor：可孵化的卵恒定明亮，不可孵化的卵随 age 慢慢熄灭', () => {
  // sim.js 把这条义务点名交给了表现层：满员时照样产卵，但"那些卵的光会慢慢熄灭
  // —— 于是『缸满了』是一件**能被看见的事**，而不是一条静默的禁令"。
  // 所以这条断言测的不是观感，是**种群上限这个规则唯一的用户可见反馈**有没有落地。
  const ok = eggFixture({ viable: true, age: 0 });
  assert.ok(eggGlowFor(ok) > 0.6, `可孵化的卵应当明亮：${eggGlowFor(ok)}`);
  assert.equal(eggGlowFor(eggFixture({ viable: true, age: 30 })), eggGlowFor(ok),
    '可孵化的卵不该随年龄熄灭（它一直有希望，直到孵化或超时）');
  assert.ok(eggGlowFor(eggFixture({ viable: false, age: 0 }))
    > eggGlowFor(eggFixture({ viable: false, age: 10 })), '不可孵化的卵必须随年龄变暗');
  assert.ok(eggGlowFor(eggFixture({ viable: false, age: 10 }))
    > eggGlowFor(eggFixture({ viable: false, age: 20 })), '变暗必须持续');
  const dark = eggGlowFor(eggFixture({ viable: false, age: 600 }));
  assert.ok(dark >= CONFIG.render.eggFailMinGlow - 1e-12,
    `残光不得小于 ${CONFIG.render.eggFailMinGlow}：彻底消失的话玩家只会以为根本没产卵`);
  assert.ok(dark < 0.25, `残光应当明显暗于可孵化的卵：${dark}`);
  assert.equal(eggGlowFor(eggFixture({ viable: false, age: -5 })), eggGlowFor(eggFixture({ viable: false, age: 0 })),
    '负 age 当成"刚产下"');
  assert.ok(Number.isFinite(eggGlowFor(eggFixture({ viable: false, age: NaN }))), 'NaN 不许传染');
});

test('不可孵化的卵走**同一条 age 时间轴**：内核推进 age，表现层只读它', () => {
  // spec §4.12 第 6 条 / §4.11：不孵化 = "这枚卵的光慢慢熄灭了"，
  // 而不是"不产卵"或"另起一个失败倒计时"。
  const egg = eggFixture({ viable: false, age: 0 });
  const g0 = eggGlowFor(egg);
  const r0 = eggShellRevealFor(egg);
  assert.equal(tickEgg(egg, 1), 'failed', '内核那边照样判 failed（行为不改）');
  assert.ok(egg.age > 0, '内核在推进 egg.age —— 这就是唯一的那条时间轴');
  assert.ok(eggGlowFor(egg) < g0, '表现层读同一个 age，于是看见光在熄灭');
  // 壳内透出轮廓那一项：不可孵化的卵**也**沿 age 走同一条进度（它只是不会孵出来，
  // 不是时间停住了），但它永远不该亮过可孵化的同一时刻。
  const viable = eggFixture({ viable: true, age: egg.age });
  assert.ok(eggShellRevealFor(viable) >= r0);
  assert.ok(eggShellRevealFor(viable) >= eggShellRevealFor(egg));
});

test('eggShellRevealFor：壳内透出轮廓只在孵化后段出现，且随进度单调', () => {
  assert.equal(eggShellRevealFor(eggFixture({ viable: true, age: 0 })), 0, '刚产下不透轮廓');
  const dur = CONFIG.stage.egg;
  const mid = eggFixture({ viable: true, age: dur * 0.5 });
  const late = eggFixture({ viable: true, age: dur * 0.9 });
  assert.ok(eggShellRevealFor(mid) <= CONFIG.render.eggRevealAt, `半程还不该亮：${eggShellRevealFor(mid)}`);
  assert.ok(eggShellRevealFor(late) > eggShellRevealFor(mid), '越接近孵化越透得出轮廓');
  assert.ok(eggShellRevealFor(late) <= 1 && eggShellRevealFor(late) > 0);
  assert.ok(eggShellRevealFor(eggFixture({ viable: true, age: dur * 50 })) <= 1, '越界夹在 1');
});

test('eggRadiusPx 直接读 eggSize：大蛋明显更大（spec §4.11 那条"喂得好蛋就大"的可见半边）', () => {
  const small = eggFixture({ eggSize: CONFIG.eggSize.min });
  const mid = eggFixture({ eggSize: (CONFIG.eggSize.min + CONFIG.eggSize.max) / 2 });
  const big = eggFixture({ eggSize: CONFIG.eggSize.max });
  const rs = eggRadiusPx(small, DESKTOP), rm = eggRadiusPx(mid, DESKTOP), rb = eggRadiusPx(big, DESKTOP);
  assert.ok(rs > 0 && rs < rm && rm < rb, `半径必须随 eggSize 单调：${rs} / ${rm} / ${rb}`);
  assert.ok(Math.abs(rb / rs - CONFIG.eggSize.max / CONFIG.eggSize.min) < 1e-9,
    '两端比值就是 eggSize 的两端比值（线性映射，没有第二个旋钮）');
  assert.ok(eggRadiusPx(mid, PHONE) < eggRadiusPx(mid, DESKTOP), '手机短边小 ⇒ 蛋也小（靠 scale，不靠另一个常数）');
  assert.ok(Number.isFinite(eggRadiusPx(eggFixture({ eggSize: NaN }), DESKTOP))
    && eggRadiusPx(eggFixture({ eggSize: NaN }), DESKTOP) > 0, '脏 eggSize 不许炸成 0 或 NaN');
});

test('八色蛋色齐备、在深靛紫底上全部可读、且不跟瞳孔撞色（spec §11 那条硬要求）', () => {
  const names = CONFIG.eggTint.colors;
  assert.equal(names.length, 8, '马卡龙六色 + 白 + 黑');
  for (const name of names) {
    const hex = eggTintHex(name);
    assert.ok(/^#[0-9A-F]{6}$/.test(hex), `${name} 的颜色 ${hex} 必须是大写 #RRGGBB`);
    assert.notEqual(hex, CONFIG.colors.pupil, `${name} 与瞳孔色撞色（spec §11 明文禁止）`);
    // spec §11：「必须满足：在深靛紫底（#2D1240）上全部可读」。
    // 黑蛋是唯一被这条**抬起来**的：它按字面做成 #000000 会在缸底彻底看不见。
    assert.ok(contrast(hex, CONFIG.colors.bgBottom) >= 1.6,
      `${name}（${hex}）在 #2D1240 上对比度只有 ${contrast(hex, CONFIG.colors.bgBottom).toFixed(2)}`);
  }
  // 八色之间彼此可分（否则"读得出蛋色"这件事没有意义）
  const set = new Set(names.map(eggTintHex));
  assert.equal(set.size, names.length, '八色必须两两不同');
  const lum = names.map((n) => [n, luminance(eggTintHex(n))]);
  lum.sort((a, b) => a[1] - b[1]);
  assert.equal(lum[0][0], 'black', '黑蛋必须是八色里最暗的那一枚（名字要对得上读感）');
  assert.equal(lum[lum.length - 1][0], 'white', '白蛋必须是最亮的那一枚');
  // 反向：未知名字不抛（脏存档 / 将来加色位点时的容错）
  assert.equal(eggTintHex('nope'), eggTintHex(names[0]));
});

test('卵的每帧账单：≤ 2 次贴图（光晕 + 壳内透出），零贝塞尔、零新建画布', () => {
  const created = [];
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false, created);
  const n0 = created.length;
  const ctx = createLogCtx();
  world.eggs.push(
    eggFixture({ id: 'a', age: 1, pos: { x: 0.3, y: 0.9 }, eggTint: CONFIG.eggTint.colors[1] }),
    eggFixture({ id: 'b', age: CONFIG.stage.egg * 0.95, pos: { x: 0.4, y: 0.85 } }),
    eggFixture({ id: 'c', age: 30, viable: false, pos: { x: 0.5, y: 0.95 } }),
  );
  drawEggs(ctx, r, world, DESKTOP);
  const total = ctx.count('drawImage');
  assert.ok(total <= 2 * world.eggs.length,
    `每颗卵每帧至多 2 次贴图，实测 ${total} / ${world.eggs.length} 颗`);
  assert.ok(total >= world.eggs.length, '一颗卵至少要有光晕（干脆不画就是"看不见缸里有卵"）');
  assert.equal(ctx.count('bezierCurveTo'), 0);
  assert.equal(ctx.count('quadraticCurveTo'), 0);
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(created.length, n0, '卵不许新建任何离屏画布（色相光晕复用已有的那 32 张）');
  assert.equal(ctx.count('save'), ctx.count('restore'), '卵层的 save/restore 必须成对');
  // 后段那枚才有第二次贴图 ⇒ "壳内透出轮廓"确实是一件**发生**过的事
  ctx.reset();
  drawEggs(ctx, r, { eggs: [world.eggs[0]] }, DESKTOP);
  assert.equal(ctx.count('drawImage'), 1, '刚产下的卵只有光晕那一次贴图');
  ctx.reset();
  drawEggs(ctx, r, { eggs: [world.eggs[1]] }, DESKTOP);
  assert.equal(ctx.count('drawImage'), 2, '孵化后段的卵多出"壳内透出轮廓"那一次');
  ctx.reset();
  drawEggs(ctx, r, { eggs: [] }, DESKTOP);
  assert.equal(ctx.count('drawImage'), 0, '缸里没有卵时一次贴图都不花');
});

test('卵落在缸底沉积带里（screenY 的几何关系，spec §5.2 的"产卵点"）', () => {
  const top = DESKTOP.height * (1 - CONFIG.render.sedimentHeight);
  for (const y of [0.78, 0.9, 0.97]) {
    const py = screenY(y, DESKTOP);
    assert.ok(py > DESKTOP.height * 0.5, `y=${y} 的卵必须落在视口下半缸：${py}`);
  }
  assert.ok(screenY(0.97, DESKTOP) > top,
    '最低的卵（0.97）必须在沉积带上沿之下 —— 否则它悬在带子上方，不像"埋在沉积物里"');
});

// ================================================================== 六、食物

test('三种食物的外观在调用日志里互不相同：微粒簇 / 珠子+高光 / 晶面的直边', () => {
  // spec §6.2：光藻=青绿微粒、蜜珠=琥珀金珠、冰晶=淡蓝结晶。
  // 桩看不见颜色，但**看得见用了哪一类图元**：微粒是一簇 arc、珠子是一个 ellipse
  // 加一颗高光、结晶只有直边（lineTo）。三条断言合起来就是"三种形状各不同"的机器证据。
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  // ⚠️ 每个种类**各用一个 ctx**：三种食物画在同一个真实 ctx 上是事实，但在这里
  // 复用同一个桩会让"上一种的次数"被后一种冲掉（count() 读的是当下那份计数），
  // 症状是三条互不相同的断言全绿或全红，全凭调用顺序。
  const one = (kind) => {
    const ctx = createLogCtx();
    drawFoods(ctx, r, { foods: [{ id: 'f', kind, pos: { x: 0.5, y: 0.5 }, amount: 1 }] }, DESKTOP);
    return ctx;
  };
  const algae = one('algae');
  assert.ok(algae.count('arc') >= 3, `光藻应当是一簇微粒（≥3 颗 arc），实测 ${algae.count('arc')}`);
  assert.equal(algae.count('lineTo'), 0, '光藻没有直边');
  assert.equal(algae.count('ellipse'), 0, '光藻不是珠子');

  const nectar = one('nectar');
  assert.ok(nectar.count('ellipse') >= 1, `蜜珠的主体应当是 ellipse，实测 ${nectar.count('ellipse')}`);
  assert.equal(nectar.count('lineTo'), 0, '蜜珠没有直边');
  assert.notEqual(nectar.count('arc'), algae.count('arc'), '蜜珠的圆点簇与光藻的微粒簇数量必须不同');

  const crystal = one('crystal');
  assert.ok(crystal.count('lineTo') >= 5, `冰晶是结晶：至少五条直边，实测 ${crystal.count('lineTo')}`);
  assert.equal(crystal.count('ellipse'), 0, '冰晶不是珠子');
  assert.ok(crystal.count('closePath') >= 1, '晶面必须是闭合多边形');
  assert.ok(crystal.count('stroke') >= 1, '结晶靠描边读得出棱');
});

test('食物零贴图、半径读 amount、未知种类退回光藻而不抛', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  drawFoods(ctx, r, world, DESKTOP);
  assert.equal(ctx.count('drawImage'), 0,
    '食物一律走路径：微粒 sprite 是粉色的，拿它贴食物会违反 spec §6.2 的"避开粉色"');
  assert.doesNotThrow(() => drawFoods(ctx, r, { foods: [{ id: 'x', kind: 'nope', pos: { x: 0.5, y: 0.5 }, amount: 1 }] }, DESKTOP));
  assert.equal(foodColorFor('nope'), foodColorFor('algae'), '未知 kind 退回光藻色');
  assert.equal(foodColorFor('toString'), foodColorFor('algae'),
    '原型键名也必须退回（CONFIG.food 是朴素对象字面量，sim.js 里记过这个坑）');
  const full = foodRadiusPx({ amount: 1 }, DESKTOP), empty = foodRadiusPx({ amount: 0 }, DESKTOP);
  assert.ok(full > empty > 0, `半径必须随 amount 单调且不为 0：${empty} → ${full}`);
  const nanR = foodRadiusPx({ amount: NaN }, DESKTOP);
  assert.ok(Number.isFinite(nanR) && nanR > 0, `脏 amount 不许炸成 0 或 NaN：${nanR}`);
  assert.ok(foodRadiusPx({ amount: 1 }, PHONE) < foodRadiusPx({ amount: 1 }, DESKTOP));
});

test('三种食物刻意避开粉色系（spec §6.2 的明文要求，不是配色失误）', () => {
  // 原话：食物"刻意避开粉色系（青绿 / 琥珀 / 淡蓝），这样它们在粉紫色的世界里一眼可辨"。
  // 粉色区间是 [315,360] ∪ [0,25] 的**跨 0° 并集** ⇒ 判定不能写成 min <= h <= max。
  const inPink = (hex) => { const h = hexToHue(hex); return h >= 315 || h <= 25; };
  for (const kind of ['algae', 'nectar', 'crystal']) {
    const hex = foodColorFor(kind);
    assert.ok(!inPink(hex), `${kind} = ${hex} 落在粉色区里，违反 spec §6.2`);
    assert.ok(contrast(hex, CONFIG.colors.bgBottom) >= 1.6, `${kind} 在深底上读不出来`);
  }
  // 反向确认判定函数本身没写坏：生物的颜色必须算粉色
  assert.ok(inPink(CONFIG.colors.sakura), '判定函数失灵：樱花粉应当算粉色');
  assert.ok(inPink(CONFIG.colors.rose));
  // 跨 0° 的**另一侧**（0–25° 那一段）：判定写成 min<=h<=max 会把它整段漏掉。
  // 用一个字面量而不是 CONFIG 里的颜色：实测 CONFIG.colors 里没有任何一支落在 0–25° 段内
  // （桃粉 #FF9EB5 解出来是 345.8°，在 315–360 那一侧），所以这一段只能靠合成样本测判定函数。
  assert.ok(inPink('#FFB3A0'), '判定函数失灵：色相 12°（0° 那一侧）必须算粉色');
  assert.ok(inPink(CONFIG.colors.peach), '桃粉（345.8°）在 315° 那一侧，也必须算粉色');
  // ⚠️ 顺手量到一个既有的事实，写在这里而不是"修掉"它：CONFIG.colors.orchid（#E8A7D8，
  // 名字是淡粉紫）解出来的色相是 **314.77°**，比 spec §11 那条 HUE_RANGE 的下沿 315°
  // 还差 0.23°，按字面**不算**粉色区间内的颜色。它是计划 1 定下的颜色，当前只被
  // render.js 当作体内亮区的**兜底色**（dominant 返回 null 时）用，不是任何个体的体相，
  // 所以这不是违规；但把它写进上面那条反向断言会红 —— 别误以为判定函数失灵了。
  assert.ok(!inPink(CONFIG.colors.orchid), 'orchid 实测在 315° 之外：这是既有颜色表的读数，不是判定失灵');
});

// ================================================ 七、draw() 接线与三条旧上界

test('draw() 的层序：水 → 食物 → 卵 → 生物 → 粒子（缸底的东西在生物之下）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  world.eggs.push(eggFixture({ id: 'e', age: 2, pos: { x: 0.5, y: 0.9 } }));
  const ctx = createLogCtx();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  consumeEvents(r, [{ kind: 'death', id: 'c1', pos: { x: 0.5, y: 0.5 }, name: 'x' }]);
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  // 沉积带是水体最后一次贴图，卵紧接着它、生物再紧接着卵
  const di = ctx.indicesOf('drawImage');
  assert.ok(di.length > 0);
  const bodyFirst = ctx.count('clip');
  assert.ok(bodyFirst >= world.creatures.length, '每只仍然各自裁一次轮廓');
  assert.equal(ctx.indexOf('drawImage') >= 0, true);
  // 层序的可数证据：微粒（水体）之后才出现卵的那次 ellipse，再之后是本体的 clip
  const eggIdx = ctx.indexOf('ellipse');
  const clipIdx = ctx.indexOf('clip');
  assert.ok(eggIdx >= 0 && clipIdx >= 0, '这一帧里卵与本体都要出现过');
  assert.ok(eggIdx < clipIdx, '卵画在生物**之下**（先画）');
  assert.ok(world.foods.length > 0);
  const foodIdx = ctx.ops.findIndex((o, i) => i < eggIdx && o.op === 'arc' && ctx.ops[i].depth >= 1);
  assert.ok(foodIdx >= 0, '食物画在卵之前（它在缸底/水中）');
});

test('B16 之后三条旧上界原样保住：每只 7 次贴图、quadraticCurveTo 0、稳态 200 帧零新建', () => {
  const created = [];
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false, created);
  // 把这一 Task 新增的**全部**东西都塞进同一个缸：卵（三种状态）、食物、
  // 一只溶散中的、一只 sick、一只哀悼、一只正在 hop。
  world.eggs.push(
    eggFixture({ id: 'a', age: 1 }),
    eggFixture({ id: 'b', age: CONFIG.stage.egg * 0.95 }),
    eggFixture({ id: 'c', age: 30, viable: false }),
  );
  world.creatures[0].sick = true;
  world.creatures[1].mourn = CONFIG.mournDuration;
  world.creatures[2].intent = { kind: 'hop', minDuration: 0.84 };
  world.creatures[2].intentTime = 0.5;
  const ctx = createLogCtx();
  for (let i = 0; i < 120; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  const warm = created.length;
  ctx.reset();
  for (let i = 0; i < 200; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(created.length, warm,
    `稳态 200 帧新建了 ${created.length - warm} 张离屏画布 —— 卵/食物/溶散粒子必须复用既有 sprite`);
  assert.equal(ctx.count('quadraticCurveTo'), 0,
    '贝塞尔段数仍然只等于身体轮廓：这一 Task 新增的每一样东西都不许抢贝塞尔预算');
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.shadowBlurWrites, 0);
  assert.equal(ctx.count('save'), ctx.count('restore'), 'save/restore 必须成对');
  // 每只**仍然**恰好 7 次贴图：把水体的微粒与光束扣掉之后是只数的整数倍
  const n = bodies.size;
  const perFrame = ctx.count('drawImage') / 200;
  const water = world.creatures.length ? r.motes.n + r.shafts.length + 1 : 0;
  const eggMax = 2 * world.eggs.length;
  assert.ok(perFrame >= water + n * DI_PER_CREATURE,
    `每帧至少要有水体 + 每只 7 次：实测 ${perFrame.toFixed(2)}`);
  assert.ok(perFrame <= water + n * DI_PER_CREATURE + eggMax + r.bursts.n,
    `每帧上界 = 水体 + 每只 7 + 每颗卵 2 + 全部粒子：实测 ${perFrame.toFixed(2)} / 上界 ${(water + n * DI_PER_CREATURE + eggMax + r.bursts.n).toFixed(2)}`);
  assert.ok(perFrame < water + n * DI_PER_CREATURE + eggMax + r.bursts.n + water,
    '粒子与卵的预算必须是**小头**：加进来的量不许超过水体本身');
});

test('新增的绘制一帧都不向 rng 取数（溶散粒子的抖动是确定性哈希）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  let calls = 0;
  const base = world.rng.fork();
  const counting = {
    next() { calls += 1; return base.next(); },
    range(a, b) { calls += 1; return base.range(a, b); },
    int(a, b) { calls += 1; return base.int(a, b); },
    chance(p) { calls += 1; return base.chance(p); },
    gaussian() { calls += 1; return base.gaussian(); },
    pick(arr) { calls += 1; return base.pick(arr); },
    fork() { return counting; },
  };
  const r = createRenderer({
    makeCanvas: makeCanvasStub(), rng: counting, viewport: DESKTOP, isMobile: false,
  });
  const built = calls;
  assert.ok(built > 0, '建池时**应当**取随机数（碎边抖动要从 rng 来）');
  world.eggs.push(eggFixture({ id: 'a', age: CONFIG.stage.egg * 0.9 }));
  const ctx = createLogCtx();
  for (let i = 0; i < 60; i++) r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  consumeEvents(r, [{ kind: 'death', id: 'x', pos: { x: 0.2, y: 0.3 }, name: 'n' }]);
  drawBursts(ctx, r, DESKTOP);
  assert.equal(calls, built, `新增绘制取了 ${calls - built} 个随机数 —— 内核的随机序列会被表现层吃掉`);
});

test('sick 的那次去饱和**真的被绘制路径消费掉了**，而且落在既有的饱和分档上', () => {
  // 上面那条只证明了纯函数 sickDesaturate 的数值对。桩**看不见 drawImage 的参数**，
  // 但看得见**结果**：本体 sprite 是按"色相桶 × 饱和档 × 明度档"惰性缓存的，
  // 于是"drawBodyLayers 到底有没有查 sick"这件事变成了一条次数断言 ——
  // 与 B14 的"稳态零新建"用的是同一套词汇，没有偷偷去记参数值。
  // 降饱和必然跨档（sat ∈ [0.45,0.95] 落在档 1–3，×0.45 之后落在档 0–1），
  // 所以第一次画这只 sick 的**必然**只是惰性多命中一张既有分档的图，不是新建第三种机制。
  const world = makeWorld(11);
  const created = [];
  const r = makeRenderer(world, DESKTOP, false, created);
  // 用固定夹具而不是缸里的第一只：sat 的表现型必须由我钉死，
  // 否则"换档跨没跨档"取决于随机基因，测试会在某个种子上无缘由地红。
  // 夹具 sat 表现型 0.7 → decode 0.8 → 档 3；去饱和后 0.36 → 档 1 ⇒ **必然**跨档。
  const c = fixture({});
  const body = createBody(c.traits);
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, body, DESKTOP);      // 只画这一只：缓存里只有它自己那一档
  const before = created.length;
  c.sick = true;
  drawCreature(ctx, r, c, body, DESKTOP);
  assert.equal(created.length - before, 1,
    `sick 换档必须**确实**反映到本体取色上（应当恰好惰性多建 1 张），实测 ${created.length - before}`);
  assert.ok(c.traits.sat > 0.75 && c.traits.sat < 0.85,
    `夹具的饱和表现型必须是档 3 那一档（实测 ${c.traits.sat}），否则上面那条断言在测巧合`);
  const after = created.length;
  for (let i = 0; i < 5; i++) drawCreature(ctx, r, c, body, DESKTOP);
  assert.equal(created.length, after,
    '第二次起必须命中缓存：为 sick 每帧新建 sprite 就是 B14 那条"稳态零新建"的死法');
  assert.ok(r.pelts.size <= CONFIG.glowHueBuckets * 16,
    `换档不许把本体缓存撑出上界：${r.pelts.size}`);
  ctx.reset();                      // 上面已经画了七次：不清就变成 49 次贴图了
  drawCreature(ctx, r, c, body, DESKTOP);
  assert.equal(ctx.count('drawImage'), DI_PER_CREATURE, '换档之后贴图次数仍然不多不少');
});

test('globalAlpha 的唯一写入点是那个乘了 dim 的 helper（变暗不许漏掉任何一层）', () => {
  // 记录型桩记不到 alpha 的**值**，所以"每一层都乘上了 dim"这件事只能这样留证据：
  // 全文件只允许有一处 `ctx.globalAlpha =` 赋值，它必须带乘数。
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const sites = src.match(/\bctx\.globalAlpha\s*=[^=]/g) || [];
  assert.equal(sites.length, 1,
    `ctx.globalAlpha 的赋值点应当恰好一处（乘 dim 的唯一入口），实测 ${sites.length} 处`);
  assert.ok(/\*\s*(k|alpha|fx)/.test(src.split('ctx.globalAlpha =')[1].split('\n')[0]),
    '那一处赋值必须乘上 dim/alpha 那个系数');
});

test('main.js 把事件喂给 renderer 之后仍然每帧清空（audio 与 render 共用同一批）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8');
  assert.ok(/consumeEvents/.test(src), 'main.js 没有把 world.events 交给 renderer 消费（溶散粒子不会有）');
  assert.ok(/world\.events\.length\s*=\s*0/.test(src), 'main.js 仍然必须每帧清空 events（无界增长）');
});

test('抬升、上浮、散开三项都**进了绘制的屏幕几何**（不是只算出来挂在 fx 上没人读）', () => {
  // 变异探针咬出来的一个真缺口：`fx.lift` / `fx.rise` / `fx.expand` 算对了但 drawCreature
  // 忘了把它们并进 cy / r，画面就是"跳了但没离开地面、死了但没散开"，
  // 而次数类断言一条都不会红（贴图还是那 7 次）。
  // 这里沿用 tests/render-body.test.js 的 writeBodyScreen 那条的做法：
  // **重推一遍变换公式**去比对 renderer.sx/sy 里那份坐标快照 ——
  // 快照是绘制真正用的坐标，不是桩的参数记录（桩仍然一个参数都没记）。
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const body = bodies.get(c.id);
  // 静止形状：排掉软体自身形变对坐标的干扰，让差值只可能来自 lift / rise / expand。
  for (const p of body.points) { p.x = p.rx; p.y = p.ry; }
  const ctx = createLogCtx();
  const expectSy0 = () => {
    const fx = r.fx;
    const ca = c.facing.x, sa = c.facing.y;
    const p = body.points[0];
    const worldR = radiusPx(c, DESKTOP);
    const cy = screenY(c.pos.y, DESKTOP) - fx.lift - fx.rise;
    return cy + (p.x * sa + p.y * ca) * worldR * fx.expand * fx.squashV;
  };

  // ① 蹦跳顶点：lift 必须真的把整只抬起来（fx.lift > 0 且落在坐标里）
  c.intent = { kind: 'hop', minDuration: 0.84 };
  c.intentTime = 0.84 * CONFIG.render.hopLandAt / 2;
  drawCreature(ctx, r, c, body, DESKTOP);
  assert.ok(r.fx.lift > 1, `夹具必须落在真的抬起来的那一刻，实测 lift ${r.fx.lift}`);
  assert.ok(Math.abs(r.sy[0] - expectSy0()) < 1e-9, '竖向抬升没进绘制坐标');
  const hopping = r.sy[0];
  // ② 没有 hop 的同一只：同一个点必须落回地面（否则"跳"是一圈永久悬浮）
  c.intent = null; c.intentTime = 0;
  drawCreature(ctx, r, c, body, DESKTOP);
  assert.equal(r.fx.lift, 0);
  assert.ok(hopping < r.sy[0] - 1, `跳起来那帧的 y 必须**明显更小**（屏幕向上）：${hopping} vs ${r.sy[0]}`);
  assert.ok(Math.abs(r.sy[0] - expectSy0()) < 1e-9, '回到静止后坐标必须恰好等于不抬升的那一个');

  // ③ 溶散：上浮 + 散开都要进坐标
  c.alive = false;
  c.dying = CONFIG.dissolveDuration * 0.5;
  drawCreature(ctx, r, c, body, DESKTOP);
  assert.ok(r.fx.rise > 0 && r.fx.expand > 1, `夹具必须落在溶散中段：rise ${r.fx.rise} expand ${r.fx.expand}`);
  assert.ok(Math.abs(r.sy[0] - expectSy0()) < 1e-9, '溶散的上浮/散开没进绘制坐标');
  // ④ 脏值（没有 Body 形状可比）也不许把 NaN 写进坐标
  c.dying = NaN;
  assert.doesNotThrow(() => drawCreature(ctx, r, c, body, DESKTOP));
  for (let i = 0; i < CONFIG.bodyPoints; i++) {
    assert.ok(Number.isFinite(r.sy[i]), `第 ${i} 点的 y 不是有限数（脏 dying 传染进几何了）`);
    assert.ok(Number.isFinite(r.sx[i]), `第 ${i} 点的 x 不是有限数`);
  }
});

// ============================================================ 边界与诚实清单

test('render.js 与 body.js 里不出现浏览器全局、不 import main.js、不用 Math.random（纪律 3）', () => {
  for (const rel of ['../src/render.js', '../src/body.js']) {
    const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame',
      'AudioContext', 'fetch', 'localStorage']) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(stripped), `${rel} 出现了 ${name}`);
    }
    assert.ok(!/'\.\/main\.js'/.test(raw), `${rel} import 了 main.js`);
    assert.ok(!/Math\.random\s*\(/.test(raw), `${rel} 调用了 Math.random()`);
  }
});

test('这一 Task 新增的数值全部在 CONFIG 里（表现层不留魔法数）', () => {
  const R = CONFIG.render;
  for (const k of ['dissolveExpand', 'dissolveLift', 'dissolveParticles', 'burstPool',
    'sickDim', 'sickDesat', 'mournDim',
    'eggRadius', 'eggGlowPulse', 'eggFailFadeTime', 'eggFailMinGlow', 'eggRevealAt',
    'foodRadius', 'hopLiftRatio', 'hopLandAt', 'hopSquashMin', 'hopStretchAir']) {
    assert.equal(typeof R[k], 'number', `CONFIG.render.${k} 缺失`);
    assert.ok(Number.isFinite(R[k]), `CONFIG.render.${k} 不是有限数`);
  }
  assert.ok(R.dissolveExpand > 1, '溶散是散开不是缩没');
  assert.ok(R.hopLandAt > 0 && R.hopLandAt < 1, '落地必须落在 hop 窗口之内，才留得出过冲的那一段');
  assert.ok(R.hopSquashMin < 1 && R.hopStretchAir > 1, '压扁 <1、拉长 >1');
  assert.ok(R.sickDim < R.mournDim, 'sick 比哀悼更暗（故障 vs 情绪）');
  assert.ok(R.eggFailMinGlow > 0, '熄灭后必须留残光，否则"缸满了"又变回一条静默的禁令');
  for (const k of ['algae', 'nectar', 'crystal']) {
    assert.equal(typeof CONFIG.colors[k], 'string', `CONFIG.colors.${k} 缺失`);
  }
  assert.equal(typeof CONFIG.colors.eggTints, 'object');
  assert.deepEqual(Object.keys(CONFIG.colors.eggTints).sort(), [...CONFIG.eggTint.colors].sort(),
    '蛋色的键集必须与遗传位点那八个名字**同一份**（分家就是"读不出蛋色"）');
});

test('手工清单（记录型桩测不到，绝不写成假装能测的断言）', () => {
  // 这一条不测任何东西，它把"为什么这里没有更多断言"变成文档的一部分。
  // 逐项在 B20 的 tests/visual-checklist 里核对，每一项都注明为什么自动化测不到：
  const manual = [
    '溶散看起来温和不惊悚（微粒是"上升消散"还是"炸开"，桩只数得出粒子个数）',
    '八色蛋在深靛紫底上读不读得出马卡龙（桩看不见 fillStyle 的值，只能由 CONFIG 侧断言对比度）',
    '大蛋与小蛋的差别一眼可见（eggRadiusPx 的单调性已测，"看得出来"没有）',
    'hop 有没有落地感（轨迹五段的数值形状已测，"像不像跳了一下"没有）',
    'sick 的掉色在屏上读不读得出"不对劲"（sickDesaturate 的数值已测，观感没有）',
    '哀悼那一下"停顿、变暗"会不会被玩家注意到（dimFactorFor 已测，注意与否没有）',
    '三种食物的颜色一眼能否分开（图元类型已测，颜色值没有）',
    '卵看起来是不是"埋在沉积物里"（screenY 与沉积带上沿的关系已测，厚度与质感没有）',
    '求关注第二档"背对手"读不读得出来（facing 是内核状态，属 B15 的眼睛与手工清单）',
  ];
  assert.equal(manual.length, 9, '手工清单的条目数（改动时同步 B20 的 visual-checklist）');
});

// ============================================================ 三条"接线"断言
//
// 这三条都是**控制方侧补的**（实现方子代理在轮次上限前没跑到探针）。
// 三条各自对应一个**活下来的变异探针**，共同点是同一个失败模式：
// **纯函数被测到了，调用点没被测到。** 把 `dimFactorFor(c)` 换成 `1`、
// 把 `hopImpulse(activity)` 换成常量、把 `worldR * fx.expand` 换成 `worldR`，
// 前面 42 条测试一条都不红 —— 因为函数本身仍然正确、次数与顺序也完全没变。
// "算对了但没接上去"是表现层最容易发生、也最难看见的一类缺陷。

test('变暗必须真的作用到**绘制时的 alpha**（探针 P7：把 dim 写死成 1 必须红）', () => {
  const world = makeWorld(19);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  c.alive = true; c.sick = false; c.mourn = 0; c.dying = 0;
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  const healthy = Math.min(...ctx.alphaAtDraw);
  const healthyFx = r.fx.alpha;
  assert.equal(healthyFx, 1, '前置条件：健康个体的 fx.alpha 必须是 1');
  ctx.reset();
  c.sick = true;
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.ok(r.fx.alpha < 1, `fx.alpha 必须被 dimFactorFor 拉下来，实测 ${r.fx.alpha}`);
  assert.ok(Math.min(...ctx.alphaAtDraw) < healthy,
    `绘制时的 alpha 必须真的更低：健康 ${healthy} vs sick ${Math.min(...ctx.alphaAtDraw)}`);
  assert.equal(ctx.count('drawImage'), DI_PER_CREATURE,
    '变暗只改亮度，不许少画任何一层（spec §7.7：要看得见异常，不是消失）');
});

test('溶散的"散开"必须真的把 24 点撑开（探针 P2：半径不用 fx.expand 必须红）', () => {
  // ⚠️ 单点断言在这里是**盲区**：`r.sy[0]` 那一条只在 `facing.y ≈ 0` 时对半径敏感，
  // 因为第 0 点的横向偏重在朝向上被投影掉了 —— 于是"整只没撑开"和"撑开了"
  // 在那个点上可以完全相同。改成测**跨度**（max − min），它对平移不变、对缩放敏感。
  const world = makeWorld(20);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const body = bodies.get(c.id);
  for (const p of body.points) { p.x = p.rx; p.y = p.ry; }   // 排掉软体自身形变的干扰
  const ctx = createLogCtx();
  const spreadOf = (arr) => Math.max(...arr) - Math.min(...arr);
  c.alive = true; c.dying = 0; c.intent = null;
  drawCreature(ctx, r, c, body, DESKTOP);
  const healthySpread = spreadOf(r.sy);
  assert.ok(healthySpread > 1, `前置条件：静止时 24 点必须有跨度，实测 ${healthySpread}`);
  c.alive = false;
  c.dying = CONFIG.dissolveDuration * 0.5;
  drawCreature(ctx, r, c, body, DESKTOP);
  const dyingSpread = spreadOf(r.sy);
  assert.ok(r.fx.expand > 1, `前置条件：溶散中段必须正在散开，实测 ${r.fx.expand}`);
  assert.ok(dyingSpread > healthySpread * 1.05,
    `屏幕上的身体必须真的变大：${healthySpread.toFixed(3)} → ${dyingSpread.toFixed(3)}`);
  // 精确等式：跨度只可能被 expand × squashV 这两个因子缩放（同一个 body、同一组点）
  const expect = healthySpread * r.fx.expand * r.fx.squashV;
  assert.ok(Math.abs(dyingSpread - expect) < 1e-6,
    `跨度缩放不对：期望 ${expect.toFixed(6)}，实测 ${dyingSpread.toFixed(6)}`);
});

test('好动的必须跳得更高（探针 P9：冲量不读 activity 必须红）', () => {
  // 纯函数 hopImpulse 自己被测过了；这条测的是**调用点真的把 activity 传进去**。
  const world = makeWorld(21);
  const bodies = makeBodies(world);
  const ctx = createLogCtx();
  const liftOf = (activity) => {
    const r = makeRenderer(world, DESKTOP, false);
    const c = world.creatures[0];
    const body = bodies.get(c.id);
    for (const p of body.points) { p.x = p.rx; p.y = p.ry; }
    c.alive = true; c.dying = 0;
    c.traits.personality.activity = activity;
    c.intent = { kind: 'hop', minDuration: 0.84 };
    c.intentTime = 0.84 * CONFIG.render.hopLandAt / 2;   // 都取抛物线顶点，进度一致
    ctx.reset();
    drawCreature(ctx, r, c, body, DESKTOP);
    return { lift: r.fx.lift, y: r.sy[0], p: hopProgress(c) };
  };
  const calm = liftOf(0);
  const lively = liftOf(1);
  assert.equal(lively.p, calm.p, '前置条件：两次必须落在蹦跳的同一进度上');
  assert.ok(lively.lift > calm.lift * 1.5,
    `冲量必须随 activity 上升：lift ${calm.lift.toFixed(3)} vs ${lively.lift.toFixed(3)}`);
  assert.ok(lively.y < calm.y, '好动的那只在这一帧屏幕上必须真的更高（y 更小）');
});
