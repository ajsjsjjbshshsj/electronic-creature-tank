import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGradient, assertGradient, assertEllipse } from './ctx-stub.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createBody, updateBody, starRadius } from '../src/body.js';
import { randomGenome, decode } from '../src/genes.js';
import { dominant, EMOTION_KEYS } from '../src/emotions.js';
import { INTENTS } from '../src/behavior.js';
import { remember, PLAYER_ID } from '../src/memory.js';
import { createViewport, boot } from '../src/main.js';
import {
  createRenderer, hueBucket, screenX, screenY, radiusPx,
  coreColorFor, peltStopsFor, patternColorFor, patternAlphaFor, peltAlphaFor, glowAlphaFor,
  innerAlphaFor, innerRadiusFor, fluffOuterRadius, fluffInnerRadius, peltKey,
  breatheOf, tailLiftPx, writeBodyScreen, buildBodyPath, drawCreature,
  getGlowSprite, getFluffSprite,
} from '../src/render.js';
// ==================================================================== 桩
//
// 与 tests/render.test.js（B13）的**记录型桩 ctx 同一套纪律**：
// 只统计「方法被调用的次数」与「属性被写入的次数」，不模拟像素、不记颜色/朝向/参数。
// 本文件在它上面多加了两件 B13 用不到、B14 必须用的东西：
//   1. **有序事件日志** —— 分层绘制（spec §5.1 的 1/2/3/4/5/7 层）要断言的是**先后**，
//      光有总数断言的话把尾巴画到本体前面照样全绿。
//   2. **save/restore 的深度** —— 深度是从 save/restore 计数推出来的，不是新记的参数。
//      有了它「花纹与体内亮区都在身体轮廓的 clip 之内」「碎边在 clip 之外」才成为事实。
//
// ⚠️ 仍然测不到的东西（渐变朝向、碎边亮度对比够不好看、受光侧真的在左上吗）
// 一律进 tests/visual-checklist 手工清单，本文件**刻意不写假装能测的断言**。

// 会抛的那一份，不是 `{ addColorStop() {} }`：见 tests/ctx-stub.js 的实测表
const GRADIENT_STUB = makeGradient();

function createLogCtx() {
  const counts = new Map();
  const ops = [];               // 有序：{ op, depth }
  let depth = 0;
  const stub = {
    ops,
    counts,
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    reset() { counts.clear(); ops.length = 0; depth = 0; stub.shadowBlurWrites = 0; },
    count(name) { return counts.get(name) || 0; },
    indexOf(name) { return ops.findIndex((o) => o.op === name); },
    firstOf(...names) {
      let best = Infinity;
      for (const n of names) { const i = ops.findIndex((o) => o.op === n); if (i >= 0 && i < best) best = i; }
      return best === Infinity ? -1 : best;
    },
    indicesOf(name) { const out = []; ops.forEach((o, i) => { if (o.op === name) out.push(i); }); return out; },
  };
  const bump = (name) => { counts.set(name, (counts.get(name) || 0) + 1); return name; };
  for (const m of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
    'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'clearRect',
    'fillRect', 'translate', 'rotate', 'scale', 'drawImage', 'fillText', 'setTransform']) {
    stub[m] = () => { ops.push({ op: bump(m), depth }); };
  }
  stub.save = () => { depth += 1; ops.push({ op: bump('save'), depth }); };
  stub.restore = () => { ops.push({ op: bump('restore'), depth }); depth -= 1; };
  // ellipse 的半径是第 3、4 个参数：真浏览器给负半径抛 DOMException，而下面那个方法名循环
  // 只认名字不认参数，所以单独包这一层（其余方法没有域，不包）。
  const rawEllipse = stub.ellipse;
  stub.ellipse = (...a) => { assertEllipse(a[2], a[3]); return rawEllipse(); };
  stub.createRadialGradient = (...a) => { assertGradient('createRadial', ...a);
    counts.set('createRadialGradient', (counts.get('createRadialGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.createLinearGradient = (...a) => { assertGradient('createLinear', ...a);
    counts.set('createLinearGradient', (counts.get('createLinearGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.measureText = () => ({ width: 0 });
  // 属性写入：只记「写了几次」，不记写了什么值。
  const trackAttr = (name, store) => {
    let value = 0;
    Object.defineProperty(stub, name, {
      get() { return value; },
      set(v) { value = v; counts.set(name, (counts.get(name) || 0) + 1); if (store) ops.push({ op: name, depth }); },
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

// 每帧 drawImage 的**上界**（spec §5.3 那一行："毛尖碎边：每只 1 次 drawImage"）。
// 六层的贴图账单：光晕 1 + 本体 1 + 体内亮区 1 + 尾巴 3 + 碎边 1 = 7。
// 花纹与轮廓走路径，不贴图。这个数字与 bodyPoints 无关 —— 把它写成字面量而不是
// 从 CONFIG.bodyPoints 推导，正是为了让"改成每帧画贝塞尔毛"必须撞红一条断言。
const DI_PER_CREATURE = 7;
// 身体轮廓：每点一段 Catmull-Rom 贝塞尔（spec §5.1"绘制 = Catmull-Rom 平滑闭合曲线"）。
const BEZIER_PER_CREATURE = CONFIG.bodyPoints;
// 第 6 层（B15 眼睛与腮红）每只的**固定路径账单**：眼白 1 + 瞳孔 1 + 高光 1 + 眼睑 1 + 腮红 1 = 5。
// ⚠️ 它是 5 条**路径**而不是 5 次贴图：这一层零 drawImage、零 clip、零 globalCompositeOperation，
//    所以上面那个 7 与下面那两条"每只只裁一次 / 混合模式写 3 次"的精确守卫**一个数字都没改**。
//    这是 B15 的架构决定（render.js 的层注释写了为什么），本文件下面那条眼睛账单测试把它钉住。
const EYE_PATHS = 5;

// ============================================================ 第 1 层：光晕

test('光晕 sprite 恰好 glowHueBuckets 张，在 createRenderer 时一次建好，之后一帧都不新建', () => {
  const world = makeWorld(11);
  const created = [];
  const r = makeRenderer(world, DESKTOP, false, created);
  assert.equal(r.glow.length, CONFIG.glowHueBuckets,
    '光晕按色相分桶预渲染（spec §3.4-3）；桶数唯一来源是 CONFIG.glowHueBuckets');
  for (const s of r.glow) {
    assert.ok(s && s.surface, '每张光晕都要有能直接喂 drawImage 的 surface');
    assert.ok(s.size > 0);
  }
  const after = created.length;
  const bodies = makeBodies(world);
  const ctx = createLogCtx();
  // 先预热：本体与亮区是**惰性**缓存（首次命中某个色相/情绪档才建），
  // 所以"不新建"这句话必须用在稳态帧上，不能用在第一帧上（那条独立的 100 帧判据同此）。
  for (let i = 0; i < 60; i++) r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  const steady = created.length;
  assert.ok(steady >= after, '预热期允许建缓存，但必须收敛');
  for (let i = 0; i < 200; i++) {
    tickWorld(world, CONFIG.fixedDt);
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(created.length, steady,
    `稳态 200 帧里新建了 ${created.length - steady} 张离屏画布 —— sprite 必须只建一次，尺寸变化靠缩放`);
});

test('碎边只有 CONFIG.fluff.sprites 张（常态/炸开），启动时建好，且随身体的 squash 变换而非重算位置', () => {
  // spec §4.7 的性能裁定：毛边只需 2 张预渲染 sprite。
  // 32 色相桶 × 8 蓬松档 = 256 张、或每帧 24 只 × 120 段贝塞尔 = 2880 段，都被这条否掉。
  const world = makeWorld(11);
  const created = [];
  const r = makeRenderer(world, DESKTOP, false, created);
  assert.equal(r.fluff.length, CONFIG.fluff.sprites,
    `碎边 sprite 数必须恰为 CONFIG.fluff.sprites（spec §11 FLUFF_SPRITES = 2），实测 ${r.fluff.length}`);
  for (const s of r.fluff) assert.ok(s.surface && s.size > 0);
  // 选哪一张由 body.js 算好的 body.fluffSprite 决定，render.js 不再自己判情绪
  assert.equal(getFluffSprite(r, 0), r.fluff[0]);
  assert.equal(getFluffSprite(r, 1), r.fluff[1]);
  assert.notEqual(r.fluff[0], r.fluff[1], '常态与炸开必须是两张不同的图，否则炸开那一档白做');
  assert.ok(created.every((c) => c.width > 0 && c.height > 0));
});

test('第 1 层光晕比旧凝胶方案半径收小、alpha 压暗（spec §5.1 第 1 层：毛会散射光）', () => {
  // 旧计划 Task 5 的两个数是 glowRadiusFactor 2.6 / glowAlphaFactor 0.55。
  // spec §5.1 重排时明文要求"半径收小、alpha 降低"，所以这两个数必须**低于**旧值，
  // 同时仍大于 0（不是干脆不画）。这一条守的是 2026-10-20 的第 4 处改动的前半。
  const R = CONFIG.render;
  assert.ok(R.glowRadiusFactor > 1 && R.glowRadiusFactor < 2.6,
    `光晕半径系数应当比旧凝胶方案的 2.6 收小、又不至于塌到不比身体大，实测 ${R.glowRadiusFactor}`);
  assert.ok(R.glowAlphaFactor > 0 && R.glowAlphaFactor < 0.55,
    `光晕 alpha 系数应当低于旧的 0.55（现在是"整只柔和地亮起来"），实测 ${R.glowAlphaFactor}`);
  // traits.glow ∈ [0.35,1]（spec §4.1 的下限推理仍然成立），alpha 必须单调随它上升
  const lo = glowAlphaFor(0.35);
  const hi = glowAlphaFor(1);
  assert.ok(hi > lo, `glow 越大光晕必须越亮：${lo} → ${hi}`);
  assert.ok(hi <= 1 && lo >= 0);
  assert.equal(glowAlphaFor(NaN), 0, '脏值（NaN）必须给 0 而不是 NaN —— NaN alpha 会让整只消失且不报错');
});

// ==================================================== 第 2 层：不透明本体
//
// 旧设计要改掉的第 1、2 处都落在这里：
//   · 半透明凝胶（alpha≈0.55）→ **不透明**填充
//   · 跨色相的径向渐变 → 同色相上的"受光侧提亮 / 背光侧压暗"
// 桩 ctx 记不到颜色，所以这三条断言打在**真正被喂给 addColorStop 的那些字符串**上：
// peltStopsFor 是建 sprite 时唯一的取色路径（buildPeltSprite 逐条喂给它），
// 不是测试专用的旁证。

const parseHsla = (s) => {
  const m = /^hsla\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+))%,\s*(-?\d+(?:\.\d+))%,\s*(-?\d+(?:\.\d+)?)\)$/.exec(s);
  assert.ok(m, `不是预期的 hsla 字符串：${s}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]), a: Number(m[4]) };
};

test('本体填充不透明：pelt sprite 的每一个色标 alpha 恒为 1（改掉旧半透明凝胶的第 1 处）', () => {
  // 旧计划 Task 5 Step 1 写的是 gelAlpha: 0.55，spec §5.1 第 2 层逐字改成"不透明填充"。
  // 变异探针 ③ 就撞在这条上：把本体改回半透明 ⇒ 某个 alpha 不再是 1 ⇒ 红。
  for (const hue of [315, 330, 345, 359.5, 3, 12, 25]) {
    const stops = peltStopsFor(hue, 0.7, 0.73);
    assert.ok(stops.length >= 3, `至少要有受光/中间/背光三段，实测 ${stops.length}`);
    for (const st of stops) {
      const c = parseHsla(st.color);
      assert.equal(c.a, 1, `本体在 hue=${hue} 的第 ${st.at} 段 alpha=${c.a}（毛绒不透明，spec §5.1 第 2 层）`);
    }
  }
  // 桩记不到 drawCreature 里那次 globalAlpha 赋值的**值**，所以"不透明"必须还要有一个
  // 纯函数侧的钉子：赋值处唯一的路径就是 peltAlphaFor()，它任何一次返回 <1 都是把
  // 凝胶方案改回来 —— 这条是那个改动唯一的机器证据（写死在函数体里就没人能拦）。
  assert.equal(peltAlphaFor(), 1, '本体层的整体 alpha 必须是 1');
  const world = makeWorld(11);
  // 而且它确实被调用在 clip 之内、本体 drawImage 之前：那次 globalAlpha 写入必须存在
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  drawCreature(ctx, r, world.creatures[0], bodies.get(world.creatures[0].id), DESKTOP);
  const clipIdx = ctx.indexOf('clip');
  const firstAlpha = ctx.indexOf('globalAlpha');
  assert.ok(ctx.indicesOf('globalAlpha').some((i) => i > clipIdx),
    'clip 之后必须有一次 globalAlpha 写入（不透明是靠那次赋值声明的，不是靠"什么都没做"）');
  assert.ok(firstAlpha < clipIdx, '第 1 层光晕自己就要写一次 alpha');
  const diList = ctx.indicesOf('drawImage');
  assert.equal(ctx.ops[diList[1] - 1].op, 'globalAlpha',
    '本体贴图的前一次操作必须是那次 globalAlpha 赋值 —— 顺序反了就是"先贴再改"，等于没声明');
});

test('受光侧提亮、背光侧压暗只在明度与饱和度上动，色相逐段完全相同（第 2 处：不跨色相）', () => {
  // ⚠️ 粉色区间 [315,360]∪[0,25] **跨 0°**。任何"在两个色相之间插值"的写法都不许出现：
  // 对度数直接 lerp 会把 359° 与 1° 插到 180°（绿色），B12/A3 都栽过这个坑。
  // 本实现的规矩是：H 一个字都不改，只动 L（背光压暗/受光提亮）与 S。
  const PRINT_EPS = 5e-3;          // hsla() 把 hue 打到两位小数，这是打印精度，不是算法误差
  const inPink = (h) => (h >= 315 || h <= 25);
  for (const hue of [315, 330, 345, 355, 359.9, 0, 0.1, 5, 12, 25]) {
    const raw = peltStopsFor(hue, 0.7, 0.73);
    const stops = raw.map((st) => parseHsla(st.color));
    for (const c of stops) {
      assert.ok(Math.abs(c.h - hue) < PRINT_EPS,
        `hue=${hue} 的色标跑到了 ${c.h}°（对色相做了插值/偏移 —— 跨 0° 时会插进绿色）`);
      assert.ok(inPink(c.h), `色标 ${c.h}° 离开了粉色区间（spec §4.2 的色系锁）`);
      assert.ok(c.l >= 0 && c.l <= 100, `明度越界：${c.l}`);
      assert.ok(c.s >= 0 && c.s <= 100, `饱和度越界：${c.s}`);
      // 承重的一条：四段之间的 H **逐位相同**（不是"差不多"）。
      // 只要有任何一段动了 hue，跨 0° 的那只（359.9）就会在渐变里拖出一条绿边。
      assert.equal(c.h, stops[0].h, `第 ${c.h}° 段与其他段的色相不一致：${stops[0].h}`);
    }
    // 单调：按 stop 位置排序后，明度必须**从受光侧到背光侧单调下降**
    const ordered = raw.slice().sort((a, b) => a.at - b.at).map((st) => parseHsla(st.color).l);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(ordered[i] <= ordered[i - 1] + 1e-9,
        `明度在 hue=${hue} 处非单调（${ordered}）：渐变方向会翻，症状是背光侧在发光`);
    }
    assert.ok(ordered[0] - ordered[ordered.length - 1] >= 8,
      `受光侧与背光侧的明度差只有 ${(ordered[0] - ordered[ordered.length - 1]).toFixed(1)} 个百分点，`
      + '毛绒的体积感就没了（spec §5.1："靠毛尖碎边在受光侧更亮"）');
  }
  // 与 genes.decode 同源：hue 已经是 decode 算好的度数，表现层不得再解一次
  const rng = createWorld({ seed: 99 }).rng;
  for (let i = 0; i < 200; i++) {
    const t = decode(randomGenome(rng));
    assert.ok(inPink(t.hue), `decode 给出的 hue 不在粉色区间：${t.hue}`);
    for (const st of peltStopsFor(t.hue, t.sat, t.lum)) {
      const c = parseHsla(st.color);
      assert.ok(Math.abs(c.h - t.hue) < PRINT_EPS, '色标偏离了 decode 的 hue');
      assert.ok(inPink(c.h), '色标离开粉色区间');
    }
  }
});

test('本体 sprite 的缓存键分桶稳定且有界（同桶必须命中同一张，否则就是每帧新建渐变的马甲）', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  // 330.05 与 330.10 落在**同一个**色相桶（32 桶 / 70° ⇒ 每桶 2.1875°）。
  // 旧计划 Task 5 用的是 330 与 330.4（跨了桶界：6.857 → 7.04），那条断言在该实现上
  // 从来没成立过 —— 又一处"计划里的测试没跑过"的证据，这里按同桶内重写。
  const a = r.getPeltSprite(330.05, 0.70, 0.73);
  const b = r.getPeltSprite(330.10, 0.705, 0.735);
  assert.equal(a, b, '同桶的 (hue,sat,lum) 必须复用同一张 sprite');
  assert.equal(r.getPeltSprite(330.05, 0.70, 0.73), a, '第二次取必须是缓存里的同一张，不许重建');
  const N = CONFIG.glowHueBuckets;
  const k = peltKey(330, 0.7, 0.73);
  assert.equal(typeof k, 'number', '整数键而不是字符串键：拼接是分配，索引不是（spec §5.3）');
  assert.ok(Number.isInteger(k) && k >= 0 && k < N * 16, `pelt 键越界：${k}`);
  assert.equal(peltKey(330, 0.7, 0.73), peltKey(330.05, 0.69, 0.74), '同桶必须给出同一个整数键');
  assert.ok(r.pelts.size <= N * 16, `缓存 ${r.pelts.size} 超过上界 ${N * 16}`);
});

test('hueBucket 与 genes.decode 的实际输出同源，400 个基因组铺满大部分桶', () => {
  // 分桶公式若与 decode 不同源，症状是"颜色几乎一样的两只，光晕与本体差两档"。
  const rng = createWorld({ seed: 99 }).rng;
  const N = CONFIG.glowHueBuckets;
  const buckets = new Set();
  for (let i = 0; i < 400; i++) {
    const t = decode(randomGenome(rng));
    const bk = hueBucket(t.hue, N);
    assert.ok(bk >= 0 && bk < N, `hue ${t.hue} 分到越界的桶 ${bk}`);
    buckets.add(bk);
  }
  assert.ok(buckets.size >= N * 0.75,
    `400 个随机基因组只覆盖了 ${buckets.size}/${N} 个色相桶（分桶与 decode 不同源）`);
});

// ================================================ 第 3 层：花纹（alpha 压到 0.35）

test('花纹 alpha 压在 0.35 一档，且 pattern=none 时那一层整个跳过（第 3 处改动）', () => {
  // spec §5.1 第 3 层逐字："alpha 压到 0.35 左右 —— 花纹是绣在毛里的，不是印在塑料上的"。
  // 桩记不到 globalAlpha 的**值**，所以数**写入次数**：none 的个体必须比有花纹的少一次
  // （那一层根本没进入），而值的两侧由 config.test.js 的字面量钉住。
  const R = CONFIG.render;
  assert.ok(R.patternAlpha >= 0.25 && R.patternAlpha <= 0.45,
    `花纹 alpha = ${R.patternAlpha}，不在 spec §5.1 的"0.35 左右"里`);
  assert.equal(patternAlphaFor('none'), 0, 'none 必须给 0（这一层整个不存在，不是画一张透明图案）');
  for (const p of ['spots', 'rings', 'clouds', 'stars']) {
    assert.equal(patternAlphaFor(p), R.patternAlpha, `${p} 的花纹 alpha 必须走同一个旋钮`);
  }

  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const mk = (pattern) => {
    const c = world.creatures[0];
    c.traits.pattern = pattern;
    const ctx = createLogCtx();
    drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
    return ctx;
  };
  const none = mk('none');
  const spots = mk('spots');
  assert.equal(spots.count('globalAlpha'), none.count('globalAlpha') + 1,
    'pattern=none 时必须少一次 globalAlpha 写入（那一层被跳过，而不是画成透明）');
  assert.equal(none.count('beginPath'), 1 + EYE_PATHS,
    'none 的个体只该有身体轮廓 + 第 6 层那 5 条路径（B15 起；花纹那一层仍然一条都不加）');
  assert.ok(spots.count('beginPath') > 1, 'spots 的花纹要留下路径痕迹，否则"花纹"两个字是空的');
  world.creatures[0].traits.pattern = 'spots';
});

test('花纹颜色是同色相的暗一档，且 alpha 由 globalAlpha 施加（不在颜色字符串里自带半透明）', () => {
  const c = parseHsla(patternColorFor(330, 0.7, 0.73));
  assert.equal(Math.round(c.h), 330, `花纹色偏了色相：${c.h}`);
  assert.equal(c.a, 1, '花纹的透明度只许走 globalAlpha，不许在 fillStyle 里再乘一次（两层相乘会让花纹几乎看不见）');
  const base = parseHsla(peltStopsFor(330, 0.7, 0.73)[0].color);
  assert.ok(c.l < base.l, `花纹必须比本体受光侧暗：${c.l} vs ${base.l}`);
  // **档间**要能分开：sprite 是按 sat/lum 各 4 档预渲染的（档内归一是"预渲染换零分配"付掉的一项），
  // 所以这里的判据是"不同档给出不同颜色"，不是"每只个体的颜色都逐位精确"。
  // 同档内的残余差异由碎边与亮区承担，观感进 B20 手工清单。
  const a = parseHsla(patternColorFor(330, 0.45, 0.62));
  const b = parseHsla(patternColorFor(330, 0.95, 0.84));
  assert.notEqual(a.s, b.s, '花纹饱和度没有跟随 traits.sat（分档失灵）');
  assert.notEqual(a.l, b.l, '花纹明度没有跟随 traits.lum（分档失灵）');
});

// ========================================= 第 4 层：体内亮区（旧"发光核"改掉）

test('体内亮区是"一片"而不是"一颗"：半径大于旧发光核，且仍随 glow 与脉动呼吸', () => {
  // spec §5.1 第 4 层：原来的"发光核（一颗清晰亮椭圆）"改成"透过毛看到的一片柔和亮区"，
  // 位置仍在体心，脉动节奏不变（glow 基线 × 情绪系数，§4.1 的下限 0.35 仍然成立）。
  const R = CONFIG.render;
  assert.ok(R.innerRadiusFactor > 0.30,
    `亮区半径系数 ${R.innerRadiusFactor} 不大于旧发光核的 0.30 —— 那还是一"颗"，不是一片`);
  assert.ok(R.innerAlpha > 0 && R.innerAlpha < 0.85,
    `亮区 alpha ${R.innerAlpha}：清晰亮椭圆的 0.85 比毛还实，那是"发光核"留下的旧数值`);
  const lo = innerAlphaFor(0.35, 1);
  const hi = innerAlphaFor(1, 1);
  assert.ok(hi > lo, `glow 越大必须越亮：${lo} → ${hi}`);
  // 脉动：同一个 breathe 值下半径必须跟着胀缩（节奏来自 body.js，不在这里另计时钟）
  assert.ok(innerRadiusFor(40, 1.05) > innerRadiusFor(40, 0.95), '亮区必须随呼吸胀缩');
  assert.equal(innerAlphaFor(NaN, NaN), lo, '脏值必须塌到 glow 下限而不是 NaN（NaN 会让整只消失）');
  assert.ok(Number.isFinite(innerRadiusFor(40, NaN)) && innerRadiusFor(40, NaN) > 0);
});

test('coreColorFor 只返回 CONFIG.colors 里的既有字符串，且不自己另写一套主导情绪判定', () => {
  // spec §5.3 禁止运行时分配：每帧拼一个 hsl(...) 就是 24×60 次分配。
  // 情绪色只能从查色表里**取**。dominant() 是内核的权威判定，表现层不许再 argmax 一遍。
  const known = new Set(Object.values(CONFIG.colors));
  const emotions = {};
  for (const k of EMOTION_KEYS) emotions[k] = 0;
  const seen = new Set();
  for (const key of EMOTION_KEYS) {
    for (const v of [0, 0.5, 1]) {
      emotions[key] = v;
      const color = coreColorFor(emotions);
      assert.ok(known.has(color), `情绪 ${key}=${v} 的颜色 ${color} 不在 CONFIG.colors 里（是新构造的字符串）`);
      seen.add(color);
    }
    emotions[key] = 0;
  }
  assert.ok(seen.size >= EMOTION_KEYS.length, `${EMOTION_KEYS.length} 种情绪只映射出 ${seen.size} 种颜色`);
  const world = makeWorld(11);
  for (const c of world.creatures) {
    assert.ok(known.has(coreColorFor(c.emotions)));
    assert.ok(typeof dominant(c.emotions) === 'string');
  }
});

// ============================================= 第 5 层：尾巴（3 段，段数固定）

test('尾巴画 3 段贴图，段数恒等于 CONFIG.tail.segs，不随体型或身体点数增长（spec §5.3）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const body = bodies.get(c.id);
  assert.equal(body.tail.nodes.length, CONFIG.tail.segs);
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, body, DESKTOP);
  const tail = ctx.indicesOf('drawImage').slice(3);   // 前 3 次是光晕 / 本体 / 体内亮区
  assert.equal(tail.length, CONFIG.tail.segs + 1,
    `尾巴 ${CONFIG.tail.segs} 段 + 碎边 1 次 = ${CONFIG.tail.segs + 1} 次贴图，实测 ${tail.length}`);
  // 段数与体型无关：把 size 基因推到最大，贴图次数一个都不许多
  c.traits.size = CONFIG.maxSize;
  const big = createBody(c.traits);
  for (let i = 0; i < 30; i++) updateBody(big, c, CONFIG.fixedDt);
  const ctx2 = createLogCtx();
  drawCreature(ctx2, r, c, big, DESKTOP);
  assert.equal(ctx2.count('drawImage'), ctx.count('drawImage'), '贴图次数随体型长了 = 尾巴分段跟着变长');
  assert.equal(ctx2.count('bezierCurveTo'), ctx.count('bezierCurveTo'));
});

test('tailLiftPx：屏幕空间的"高举"随尾巴幅度单调上升，fear 夹起来时归零（§4.7.1 的表）', () => {
  // 局部空间没有上下（body.js 文件头那条 ⚠️），所以"竖直高举 / 垂着不动"由本层在
  // 旋转之后加一次屏幕位移。这条测的是**映射方向**，不是观感。
  const mk = (amp, tuck) => ({ tail: { amp, tuck, curl: 0 } });
  assert.ok(tailLiftPx(mk(0.5, 1), 40) > tailLiftPx(mk(0.1, 1), 40), '摆幅越大举得越高');
  assert.ok(tailLiftPx(mk(0.5, 1), 40) > tailLiftPx(mk(0.5, 1), 20), '大的个体尾巴要更长（按体半径派生）');
  assert.ok(Math.abs(tailLiftPx(mk(0.5, 0.15), 40)) < Math.abs(tailLiftPx(mk(0.5, 1), 40)),
    'fear 夹起来（tuck→0）时举起量必须跟着缩，否则"夹尾巴"只夹了一半');
  assert.equal(tailLiftPx(mk(0, 1), 40), 0, '伤心那一档：垂着不动 ⇒ 屏幕位移必须为 0');
});

// ========================================= 第 7 层：毛尖碎边（性能生死线）

test('碎边的几何：外缘半径随毛长单调，内缘不得跑到身体轮廓之外（§4.7"否则就成了光晕"）', () => {
  const R = CONFIG.fluff;
  assert.equal(R.lenRatio, 0.18, 'spec §4.7 逐字：毛长 = fluff × 0.18 × 身体半径');
  // 毛长为 0 时碎边完全落在轮廓内（velvet 一圈），毛长打满时外缘恰好在 1.18r
  assert.ok(Math.abs(fluffOuterRadius(50, 0) - 50) < 1e-9);
  assert.ok(Math.abs(fluffOuterRadius(50, R.lenRatio) - 50 * 1.18) < 1e-9);
  assert.ok(fluffOuterRadius(50, R.lenRatio) > fluffOuterRadius(50, R.lenRatio * 0.5));
  for (const len of [0, 0.05, 0.09, R.lenRatio]) {
    const inner = fluffInnerRadius(50, len);
    assert.ok(inner <= 50 + 1e-9,
      `毛长 ${len} 时碎边内缘在 ${inner.toFixed(2)}，越过轮廓 50 ⇒ 毛与身体之间露出水，读起来就是一圈光晕`);
    assert.ok(inner < fluffOuterRadius(50, len), '内缘必须始终在出缘之内');
  }
});

// ======================================================= 层序与每帧调用账单

test('drawCreature 的六层层序与贴图深度（spec §5.1 第 1/2/3/4/5/7 层）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.traits.pattern = 'spots';
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);

  const di = ctx.indicesOf('drawImage');
  assert.equal(di.length, DI_PER_CREATURE,
    `每只每帧 ${DI_PER_CREATURE} 次贴图（光晕1+本体1+亮区1+尾巴3+碎边1），实测 ${di.length}`);
  const depthOf = (i) => ctx.ops[i].depth;
  assert.deepEqual(di.map(depthOf), [2, 2, 3, 2, 2, 2, 2],
    '贴图所在的 save 深度就是层序证明：光晕(2) → 本体(2) → 体内亮区(3，在 clip 之内) → 尾巴×3 → 碎边(2，在 clip 之外)');

  const clipIdx = ctx.indexOf('clip');
  assert.ok(clipIdx >= 0, '本体必须在身体轮廓的 clip 之内 —— 不裁的话挤压与凹陷完全看不出来');
  assert.ok(clipIdx > di[0] && clipIdx < di[1], '第 1 层光晕在 clip 之前，第 2 层本体在 clip 之内');
  // 花纹是身体这六层里**唯一**用 arc/ellipse 的（其余五层全贴图、尾巴也是贴图）
  const patternIdx = ctx.firstOf('arc', 'ellipse');
  assert.ok(patternIdx > clipIdx && patternIdx < di[2],
    '第 3 层花纹必须落在 clip 之内、体内亮区之前（spec §5.1 的顺序）');
  assert.equal(ctx.count('clip'), 1, '每只只裁一次：clip 是用来裁本体 sprite 的，不是每层各裁一次');
  assert.ok(di[3] > clipIdx && di.map(depthOf)[3] === 2,
    '第 5 层尾巴必须在 clip 那一层之外（尾巴与 B15 的眼睛不许被轮廓裁掉）');
  assert.ok(di[di.length - 1] > di[3], '第 7 层碎边是身体这侧最外的一层');
  const st = ctx.indicesOf('setTransform');
  assert.ok(st.length >= 2, '体内亮区与碎边各要一次矩阵变换（碎边靠 squash 矩阵，不重算毛的位置）');
  assert.equal(ctx.ops[st[st.length - 1] + 1].op, 'drawImage',
    '碎边必须是"一次 setTransform + 一次 drawImage"：中间出现任何路径调用就是有人在每帧画毛');
  assert.equal(ctx.ops[st[0] + 1].op, 'drawImage', '体内亮区同样只贴图，不新建路径');
});

test('性能上限一：每只每帧 drawImage 是常数级，与 bodyPoints 无关', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  const n = bodies.size;
  for (const c of world.creatures) {
    const b = bodies.get(c.id);
    if (b) drawCreature(ctx, r, c, b, DESKTOP);
  }
  assert.equal(ctx.count('drawImage'), n * DI_PER_CREATURE);
  assert.ok(ctx.count('drawImage') <= n * 8,
    `每只上界 8 次贴图，实测 ${(ctx.count('drawImage') / n).toFixed(2)} 次 —— 超了就是把毛一根根贴了`);
  assert.ok(ctx.count('drawImage') < n * CONFIG.bodyPoints,
    '贴图次数不得与身体点数成正比（成正比 = 每个点一根毛的旧方案回来了）');
});

test('性能上限二：主 ctx 每帧的贝塞尔段数只等于身体轮廓，毛一段都不许走路径', () => {
  // spec §4.7 的生死线：24 只 × 120 段 = 2880 段贝塞尔/帧，手机必崩。
  // 换来的便宜是"只画毛尖碎边 + 2 张 sprite"。这条断言是那句话唯一的机器证据。
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  const n = bodies.size;
  for (const c of world.creatures) {
    const b = bodies.get(c.id);
    if (b) drawCreature(ctx, r, c, b, DESKTOP);
  }
  assert.equal(ctx.count('bezierCurveTo'), n * BEZIER_PER_CREATURE,
    `贝塞尔段数必须恰为 每只 bodyPoints（Catmull-Rom 轮廓）。实测 ${ctx.count('bezierCurveTo')} / ${n} 只`);
  assert.ok(ctx.count('quadraticCurveTo') === 0, '身体层不许出现二段贝塞尔（毛如果按 quadratic 画，这里立刻红）');
  // beginPath 的上界 = 每只 1 条轮廓 + 花纹斑点（最多的那一型 9 个）+ 第 6 层那 5 条，
  // 毛一个都不加。B15 之前这个上界是 1+9；眼睛是**第一批**合法新增路径的层，
  // 所以上界跟着加 5 —— 这条守卫的原意（"有人给毛开了路径"）一个字都没松。
  assert.ok(ctx.count('beginPath') <= n * (1 + 9 + EYE_PATHS),
    `beginPath ${ctx.count('beginPath')} 超过 ${n}×${1 + 9 + EYE_PATHS}（轮廓 + 花纹斑点 + 眼睛的上界）—— 有人给毛开了路径`);
});

test('性能上限三：连续 100 帧不新建任何离屏画布（sprite 只在首次/分档变化时构建）', () => {
  const created = [];
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false, created);
  const ctx = createLogCtx();
  // 预热：让每只的色相/情绪档都命中一次缓存
  for (let i = 0; i < 120; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  const afterWarm = created.length;
  ctx.reset();
  for (let i = 0; i < 100; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(created.length, afterWarm,
    `稳态 100 帧里新建了 ${created.length - afterWarm} 张离屏画布 —— 每帧重建 canvas 就是每帧画贝塞尔的另一种写法`);
  assert.equal(ctx.count('createRadialGradient'), 0, '稳态帧在主 ctx 上建渐变 = 预渲染白做（spec §5.3）');
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.shadowBlurWrites, 0, 'spec §5.3："手机浏览器上最大的性能杀手"');
});

test('渲染一帧不向 rng 取任何一个数（否则同一份存档在两台设备上长得不一样）', () => {
  // 全局纪律第 2 条在 B14 的具体化：花纹位置如果顺手写成 rng.range(...)，
  // 除了画面每帧沸腾，还会**消耗 world.rng 的序列** ⇒ 同一个种子跑出另一个缸。
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
  const r = createRenderer({ makeCanvas: makeCanvasStub(), rng: counting, viewport: DESKTOP, isMobile: false });
  const built = calls;
  assert.ok(built > 0, '建池时**应当**取随机数（毛尖碎边的抖动要从 rng 来，否则每台设备一样也一样都不像毛）');
  const ctx = createLogCtx();
  for (let i = 0; i < 60; i++) r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.equal(calls, built, `绘制阶段取了 ${calls - built} 个随机数 —— 内核的随机序列会被表现层吃掉`);
});

test('六层全部画在 save/restore 成对的括号里（漏一次 restore 会把 lighter 污染给后面所有层）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  for (const c of world.creatures) {
    const b = bodies.get(c.id);
    if (b) drawCreature(ctx, r, c, b, DESKTOP);
  }
  assert.equal(ctx.count('save'), ctx.count('restore'),
    `save ${ctx.count('save')} / restore ${ctx.count('restore')}`);
  assert.equal(ctx.ops[ctx.ops.length - 1].depth, 1, '画完一只必须回到深度 0（最后一次 restore 前的深度是 1）');
  // globalCompositeOperation 每只写 3 次：光晕、体内亮区、碎边都要 'lighter'
  assert.equal(ctx.count('globalCompositeOperation'), bodies.size * 3,
    '混合模式写入次数是这三层存在的证据（桩记不到值，值进手工清单）');
});

// ============================================================ 轮廓与坐标变换

test('writeBodyScreen：局部 +x 落在 facing 方向，且复用同一个 typed array（spec §5.3 零分配）', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const body = createBody({ wobble: 0.5 });
  const cx = 500, cy = 300, rad = 40;
  const facing = { x: 0.6, y: 0.8 };
  const sxRef = r.sx, syRef = r.sy;
  writeBodyScreen(r, body, cx, cy, rad, facing);
  const p0 = body.points[0];
  assert.ok(Math.abs(r.sx[0] - (cx + (p0.x * facing.x - p0.y * facing.y) * rad)) < 1e-9);
  assert.ok(Math.abs(r.sy[0] - (cy + (p0.x * facing.y + p0.y * facing.x) * rad)) < 1e-9);
  // facing 已是单位向量 ⇒ 不需要 atan2/sin/cos（每帧每只省三次三角函数）
  const q = CONFIG.bodyPoints / 4;
  assert.ok(Math.abs(r.sx[q] - (cx + (body.points[q].x * facing.x - body.points[q].y * facing.y) * rad)) < 1e-9);
  for (let i = 0; i < 300; i++) writeBodyScreen(r, body, 100, 100, 30, { x: 1, y: 0 });
  assert.equal(r.sx, sxRef, 'typed array 必须是同一个引用');
  assert.equal(r.sy, syRef);
  assert.equal(r.sx.length, CONFIG.bodyPoints);
});

test('buildBodyPath：星形轮廓是闭合曲线，每点一段贝塞尔（24 点直接 lineTo 会露出棱角）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const body = bodies.get(c.id);
  const ctx = createLogCtx();
  buildBodyPath(ctx, r, c, body, 400, 300, 50);
  assert.equal(ctx.count('bezierCurveTo'), CONFIG.bodyPoints, `实测 ${ctx.count('bezierCurveTo')}`);
  assert.equal(ctx.count('beginPath'), 1);
  assert.equal(ctx.count('closePath'), 1, '必须闭合，否则花纹的 clip 会漏');
  assert.equal(ctx.count('moveTo'), 1);
  // 轮廓形状来自 body.js 的星形（挂点、内凹都在），不是本文件另算一套
  const rest = createBody({ wobble: 0 });
  for (let i = 0; i < rest.points.length; i++) {
    const a = (i / rest.points.length) * Math.PI * 2;
    assert.ok(Math.abs(Math.hypot(rest.points[i].rx, rest.points[i].ry) - starRadius(a)) < 1e-12);
  }
});

test('breatheOf：脉动只读 body.phase / body.pulse，绝不自建时钟（求偶与呼吸同步的教训）', () => {
  const body = { phase: 0.25, pulse: 0.1 };
  const a = breatheOf(body);
  assert.ok(a > 1, `phase=0.25 时 sin=1，呼吸系数应 >1，实测 ${a}`);
  body.phase = 0.75;
  assert.ok(breatheOf(body) < 1, '半个周期后必须收缩');
  body.pulse = 0;
  assert.equal(breatheOf(body), 1, 'pulse=0 ⇒ 完全不胀缩');
  assert.ok(Number.isFinite(breatheOf({ phase: NaN, pulse: 0.1 })), 'NaN 相位不许传染成 NaN 半径');
});

// ================================================================ 稳健性与接线

test('太小的个体（r < 0.5px）与脏坐标：直接跳过，一帧里一次贴图都不产生也不抛', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  c.traits.size = 0.01;
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  assert.equal(ctx.count('drawImage'), 0, '小于一像素的东西不该花任何绘制预算');
  c.traits.size = CONFIG.minSize;
  c.pos.x = NaN;
  assert.doesNotThrow(() => drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP));
  assert.equal(ctx.count('drawImage'), 0, 'NaN 坐标会让整只消失且全程不报错 —— 必须被挡住');
});

test('四档视口下都能画：手机竖屏的个体仍然有完整七次贴图', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, PHONE, true);
  const ctx = createLogCtx();
  const n = bodies.size;
  for (const c of world.creatures) {
    const b = bodies.get(c.id);
    if (b) drawCreature(ctx, r, c, b, PHONE);
  }
  assert.equal(ctx.count('drawImage'), n * DI_PER_CREATURE);
  assert.ok(radiusPx(world.creatures[0], PHONE) > 0);
  assert.equal(ctx.count('globalCompositeOperation'), n * 3);
});

test('main.js 接上真 renderer 后，身体真的被画进了主 ctx（每只 7 次贴图的整数倍）', () => {
  const raf = [];
  const makeElement = () => ({
    width: 0, height: 0, clientWidth: 1024, clientHeight: 640, getContext: () => createLogCtx(),
    addEventListener: () => {}, removeEventListener: () => {},   // B17：attachInput 的注入目标
  });
  const canvasEl = makeElement();
  const mainCtx = createLogCtx();
  canvasEl.getContext = () => mainCtx;
  const fakeWindow = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => () => {},
    removeEventListener: () => {},
  };
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
  };
  g.document = { createElement: makeElement };
  g.window = fakeWindow;
  g.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  g.cancelAnimationFrame = () => {};
  try {
    const controller = boot({ hud: false, canvas: canvasEl, seed: 20261023 });
    const step = () => raf[raf.length - 1];
    for (let i = 0; i <= 30; i++) step()(i * (1000 / 60));
    const n = controller.bodies.size;
    assert.ok(n > 0);
    // 微粒那 120 次贴图也在同一个 ctx 上，所以这里断言"身体那部分一定在里面"
    assert.ok(mainCtx.count('drawImage') >= 30 * n * DI_PER_CREATURE,
      `30 帧 × ${n} 只至少应有 ${30 * n * DI_PER_CREATURE} 次身体贴图，实测 ${mainCtx.count('drawImage')}`);
    assert.ok(mainCtx.count('bezierCurveTo') >= 30 * n * BEZIER_PER_CREATURE);
    assert.equal(mainCtx.count('createRadialGradient'), 0);
    assert.equal(mainCtx.shadowBlurWrites, 0);
    controller.stop();
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
});

test('render.js 里不出现 document / 七个浏览器全局，也不 import main.js（依赖注入这条不许松）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(stripped), `render.js 出现了 ${name}`);
  }
  assert.ok(!/'\.\/main\.js'/.test(src), 'render.js 不得 import main.js');
  assert.ok(!/Math\.random\s*\(/.test(src), 'render.js 不得调用 Math.random()');
  // 离屏画布只能来自注入的工厂
  assert.ok(/makeCanvas/.test(stripped), 'render.js 不再用注入的 makeCanvas 建 sprite？');
});

test('旧符号没有复活：src/ 下不存在求偶制的 court / courtship 相关标识符', () => {
  // 内核已改孤雌自产卵（spec §4.12）。旧计划 Task 7 的"求偶编舞"整块不搬。
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const dead of ['court', 'courtship', 'courtshipFactor', 'canCourt', 'courtPhase', 'drawCourtship']) {
    assert.ok(!new RegExp(`\\b${dead}\\b`).test(stripped), `render.js 里复活了求偶制符号 ${dead}`);
  }
  // 反向确认词汇表本身：INTENTS 现在是 13 项、含 hop/brood、不含 court
  assert.equal(INTENTS.length, 13, `INTENTS 长度 ${INTENTS.length}，孤雌制后应当是 13 项`);
  assert.ok(INTENTS.includes('hop') && INTENTS.includes('brood'));
  assert.ok(!INTENTS.includes('court'), '求偶意图已经随 spec §4.12 删除，渲染层不许再为它画任何东西');
});

test('七项旧设计里被这次改动牺牲掉的那条：不再有半透明 gelAlpha 这个旋钮', () => {
  // 防止有人"顺手"把 alpha 调回 0.55 —— 那会把毛绒退回凝胶。
  const R = CONFIG.render;
  assert.equal(R.gelAlpha, undefined, 'gelAlpha 是凝胶方案的旋钮，spec §5.1 第 2 层已经改成不透明填充');
  assert.equal(R.coreAlpha, undefined, '"发光核"已经改成"透过毛看到的一片柔和亮区"（第 4 处改动）');
  assert.ok(R.innerAlpha > 0, '新的亮区旋钮必须存在');
  assert.ok(screenX(0.5, DESKTOP) === DESKTOP.width / 2);
});

// ==================================================== 第 6 层：眼睛与腮红（B15）
//
// ⚠️ 记录型桩测不到的东西（诚实边界）：眯弧弯得够不够、星星眼在屏上像不像一只星、
// 含泪高光看不看得见、腮红位置对不对、瞳孔有没有真的朝手看过去。
// 那些全在手工清单里。这里断言的只有**层序、深度、路径/贴图的次数账单，
// 以及"四角星走几个顶点"这一半可数的东西**。
// 四参数与十行表的数值本身由 tests/eyes.test.js 直接打纯函数，不经过这里。

// 取 (from, to) 之间的操作计数
const opsWithin = (ctx, from, to) => {
  const out = {};
  for (let i = from + 1; i < to; i++) {
    const op = ctx.ops[i].op;
    out[op] = (out[op] || 0) + 1;
  }
  return out;
};

// **第 6 层自己的**操作窗口。⚠️ 不能简单地取"尾巴最后一次贴图 → 碎边那次贴图"之间：
// 那一段里还夹着尾巴层的收尾 restore 与碎边层的起笔 save（含它的 'lighter' 写入），
// 照那个边界数出来的账单会把邻层的操作算到眼睛头上。
// 所以边界取"尾巴那一层的 restore 之后"到"碎边那一层的 save 之前"。
const eyeWindow = (ctx) => {
  const di = ctx.indicesOf('drawImage');
  assert.equal(di.length, DI_PER_CREATURE, '先确认六层贴图都在，否则下面的边界没有意义');
  let from = di[5];
  while (ctx.ops[from].op !== 'restore') from += 1;
  let to = di[6];
  while (ctx.ops[to].op !== 'save') to -= 1;
  assert.ok(to > from, '找不到第 6 层的边界（尾巴与碎边之间被压成零长了？）');
  return { from, to, di, counts: opsWithin(ctx, from, to) };
};

// 让某只个体进入 幸福 那一格：心情档由 emotions / needs / memory / mourn 共同决定，
// 所以"造一个人设"就是改这四样（与 tests/eyes.test.js 的夹具同一套思路）。
const makeBlissful = (c) => {
  c.alive = true;
  c.mourn = 0;
  c.emotions.joy = 0.85;
  c.emotions.anger = 0;
  c.emotions.fear = 0;
  c.emotions.sleepy = 0;
  c.emotions.arousal = 0.5;
  for (const k of Object.keys(c.needs)) c.needs[k] = 0.1;
  remember(c.memory, { id: PLAYER_ID, familiarity: 1, affection: 0.9, kinship: 0, role: null });
};

test('第 6 层的层序：眼睛在尾巴之后、毛尖碎边之前，且与尾巴一样在 clip 之外（spec §5.1 的 5→6→7）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  const clipIdx = ctx.indexOf('clip');
  const win0 = eyeWindow(ctx);
  assert.ok(win0.to > win0.from + 1, '尾巴与碎边之间必须有东西 —— 那就是第 6 层');
  const win = win0.counts;
  assert.ok(win.beginPath > 0 && win.fill > 0, `眼睛窗口里必须真有路径与填充：${JSON.stringify(win)}`);
  assert.equal(win.drawImage, undefined, '眼睛不许贴图（新增 sprite 会撕掉 B14 那三条精确守卫）');
  assert.equal(win.clip, undefined, '眼睛不许 clip：半闭的瞳孔靠几何收进去，不靠裁剪');
  assert.equal(win.globalCompositeOperation, undefined, '混合模式那三次写入属于身体三层，眼睛不掺');
  for (let i = win0.from + 1; i < win0.to; i++) {
    assert.ok(ctx.ops[i].depth >= 2, `第 6 层的操作必须都在 save 括号里（第 ${i} 个深度 ${ctx.ops[i].depth}）`);
  }
  assert.ok(clipIdx < win0.from, 'clip 属于本体那一层，第 6 层整层在轮廓之外');
  const st = ctx.indicesOf('setTransform');
  assert.equal(ctx.ops[st[st.length - 1] + 1].op, 'drawImage',
    '碎边仍然是最后一次矩阵变换 + 贴图 —— 眼睛若去抢 setTransform 就破坏它的层序证据');
  assert.equal(ctx.count('bezierCurveTo'), BEZIER_PER_CREATURE,
    '贝塞尔段数仍然只等于身体轮廓：眼睛用 arc/ellipse，一段贝塞尔都不加');
  assert.equal(ctx.count('quadraticCurveTo'), 0);
});

test('眼睛层的固定路径账单：眼白 / 瞳孔 / 高光 / 眼睑 + 腮红 = 5 条路径，闭眼时整层跳过', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.traits.pattern = 'none';
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, bodies.get(c.id), DESKTOP);
  const win = eyeWindow(ctx).counts;
  assert.equal(win.beginPath, EYE_PATHS, `第 6 层每只应当恰好 ${EYE_PATHS} 条路径，实测 ${win.beginPath}`);
  assert.equal(win.fill, EYE_PATHS - 1, '5 条路径里 4 条填充、1 条描边（眼睑线只描不填）');
  assert.equal(win.stroke, 1, '描边恰好一次：那是上眼睑 / ^^ 那一笔');
  assert.equal(win.save, 2, '两个括号：眼睛一个、腮红一个');
  assert.equal(win.restore, 2, 'save/restore 必须成对，否则 globalAlpha 会漏给第 7 层');
  assert.equal(win.strokeStyle, 1, '只有眼睑线用描边');
  assert.equal(win.fillStyle, 4, '眼白 / 瞳孔 / 高光 / 腮红 各一次取色');
  assert.equal(win.lineTo || 0, 0, '常态瞳孔是椭圆，一次 lineTo 都不该有');
  assert.equal(ctx.count('clip'), 1, '每只仍然只裁一次（本体那一刀），眼睛没有第二刀');

  // 闭眼（死亡）时整层跳过：窗口里一次绘制都不剩，而尾巴与碎边照常。
  const dead = createLogCtx();
  c.alive = false;
  c.dying = CONFIG.eye.deathCloseSeconds * 2;
  drawCreature(dead, r, c, bodies.get(c.id), DESKTOP);
  const ddi = dead.indicesOf('drawImage');
  assert.equal(ddi.length, DI_PER_CREATURE, '闭眼不省贴图（身体那 7 次一次不少）');
  const dwin = eyeWindow(dead).counts;
  assert.equal(dwin.beginPath || 0, 0, `闭眼之后那一格不该留下路径：${JSON.stringify(dwin)}`);
  assert.equal(dwin.fill || 0, 0, '尸体也不该泛腮红（blushFor 的 alive 门）');
  c.alive = true;
  c.dying = 0;
});

test('星星眼的瞳孔走四角星：每只 2×starPoints 个顶点；快乐那一格一次 lineTo 都不加', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  c.traits.pattern = 'none';
  c.emotions.joy = 0.9;
  const happy = createLogCtx();
  drawCreature(happy, r, c, bodies.get(c.id), DESKTOP);
  const hwin = eyeWindow(happy).counts;
  assert.equal(hwin.lineTo || 0, 0, '快乐是眯弧 + 椭圆瞳孔，不许有星形顶点');
  assert.ok(hwin.arc > 0, '眼睑那一格要用 arc 画出上弯的 ^^');

  makeBlissful(c);
  const bliss = createLogCtx();
  drawCreature(bliss, r, c, bodies.get(c.id), DESKTOP);
  const bwin = eyeWindow(bliss).counts;
  const verts = 2 * CONFIG.eye.starPoints;
  assert.equal(bwin.moveTo, 2, `两只星各一次起笔（每只 ${verts} 个顶点），实测 ${bwin.moveTo}`);
  assert.equal(bwin.lineTo, 2 * (verts - 1),
    `四角星瞳孔：每只 ${verts} 个顶点 ⇒ 2×(${verts}−1) = ${2 * (verts - 1)} 次 lineTo，实测 ${bwin.lineTo}`);
  assert.equal(bwin.closePath, 2, '两只星各自闭合（第三条 closePath 是身体轮廓，在窗口之外）');
  assert.equal(bwin.beginPath, EYE_PATHS, '换画法不许改变路径条数，否则 B14 那条上界失去意义');
});

test('render.js 的第 6 层只从 eyes.js 拿数：眼睛那几行里没有颜色与比例的第二个定义点', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const from = stripped.indexOf('function drawEyeLayer');
  const to = stripped.indexOf('export function drawCreature');
  assert.ok(from > 0 && to > from, '找不到第 6 层的实现（drawEyeLayer 被改名或搬走了？）');
  const eye = stripped.slice(from, to);
  assert.ok(/pupilColor\(\)/.test(eye), '瞳孔颜色必须走 eyes.js 导出的 pupilColor()（唯一来源 CONFIG.colors.pupil）');
  assert.ok(/eyeWhiteColor\(\)/.test(eye) && /eyeHighlightColor\(\)/.test(eye));
  assert.ok(/blushColor\(\)/.test(eye), '腮红颜色必须走 blushColor()');
  assert.ok(!/#2D1240/.test(eye), '第 6 层里抄了一份瞳孔色号 —— spec §4.6 裁定 3 的定义点分家了');
  assert.ok(!/0\.28/.test(eye), '第 6 层里抄了眼睛比例的 28%；那是 CONFIG.eyeWidthRatio，只能有一处');
  assert.ok(!/0\.30|0\.55|0\.95/.test(eye), '十行表的读数只能出现在 eyes.js 的返回值里，不许在画的那一侧各写一份');
  assert.ok(/eyeParamsInto\(/.test(eye) && /eyeAnchorsInto\(/.test(eye),
    '四参数与锚点必须来自 eyes.js；在 render.js 里重算一份就是"测的与跑的不是同一个函数"');
});

test('draw() 只读 world.playerHand：搬进 renderer.hand，不改世界状态（表现层边界）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createLogCtx();
  world.playerHand = { pos: { x: 0.4, y: 0.5 }, speed: 0.01 };
  const snap = JSON.stringify({ pos: world.playerHand.pos, speed: world.playerHand.speed });
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.equal(r.hand, world.playerHand, '第 6 层的瞳孔朝向与 slow blink 读的就是这个引用');
  assert.equal(JSON.stringify({ pos: world.playerHand.pos, speed: world.playerHand.speed }), snap,
    '表现层不许改写 playerHand（写它是 input 层的职责，spec §4.6 的那半句 facing 更不许动）');
  for (const c of world.creatures) assert.equal(c.mood, undefined, '心情不许被写成个体状态（spec §4.5.1）');
  world.playerHand = null;
  r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.equal(r.hand, null, '手离场后必须把引用清掉，否则眼睛会永远斜视着一只不存在的手');
});

test('第 6 层不向 rng 取任何一个数、不新建任何离屏画布（眨眼相位由 id 哈希给出）', () => {
  const created = [];
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  makeRenderer(world, DESKTOP, false, created);
  const baseRng = world.rng.fork();
  let calls = 0;
  const counting = {
    next() { calls += 1; return baseRng.next(); },
    range(a, b) { calls += 1; return baseRng.range(a, b); },
    int(a, b) { calls += 1; return baseRng.int(a, b); },
    chance(p) { calls += 1; return baseRng.chance(p); },
    gaussian() { calls += 1; return baseRng.gaussian(); },
    pick(arr) { calls += 1; return baseRng.pick(arr); },
    fork() { return counting; },
  };
  const r2 = createRenderer({ makeCanvas: makeCanvasStub(created), rng: counting, viewport: DESKTOP, isMobile: false });
  const built = calls;
  const ctx = createLogCtx();
  for (let i = 0; i < 60; i++) r2.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.equal(calls, built, `第 6 层取了 ${calls - built} 个随机数 —— 随机流属于内核，表现层一帧都不该动它`);
  const before = created.length;
  for (let i = 0; i < 60; i++) r2.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  assert.equal(created.length, before, '眼睛不许新建 sprite：眼白是扁平填充，这是"不改 B14 精确账单"的代价与决定');
});

// ============================================ F-tail：B20 §8.2 明确不通过的那一条
//
// B20 在真像素里判"尾巴读不成一条"：三段各自是独立的小团，中间各留一道缝 ⇒ 看上去是虚线/三个点。
// 这条判据是一个**值**（相邻圆盘到底重不重叠），混在 drawImage 那三笔里就只剩"贴了几次图"这种证据，
// 而次数对"有没有缝"完全无感 —— 所以走 render.js 的 tailSegInto，并且**从真实绘制路径之后**
// 读那份复用槽（renderer.tailSeg）：测的是调用点真的用了这套几何，不是测试自己抄了一份公式。
test('尾巴相邻两段必须互相重叠 —— 读成一条尾巴，不是三个点（§8.2 / F-tail）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false);
  const c = world.creatures[0];
  const body = bodies.get(c.id);
  const ctx = createLogCtx();
  drawCreature(ctx, r, c, body, DESKTOP);
  const seg = r.tailSeg;
  assert.equal(seg.count, CONFIG.tail.segs, '段数恒 CONFIG.tail.segs，不随体型变（spec §5.3）');
  const rr = radiusPx(c, DESKTOP);
  const nodes = body.tail.nodes;
  for (let i = 0; i + 1 < seg.count; i++) {
    // 真实间距：量节点坐标（单位空间 × 屏幕半径），**不假设**它等于 segPx × 2
    const gap = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y) * rr;
    const cover = seg.radii[i] + seg.radii[i + 1];
    assert.ok(cover >= gap * 1.15,
      `第 ${i}→${i + 1} 段之间有缝：两半径之和 ${cover.toFixed(2)} < 间距 ${gap.toFixed(2)} × 1.15`
      + `（重叠率 ${((cover / gap - 1) * 100).toFixed(0)}%，要 ≥ 15% 才读得成一条尾巴）`);
  }
  // 根段不许粗过身体的一半：尾巴是尾巴，不是第二条腿
  assert.ok(seg.radii[0] <= rr * 0.5, `尾根半径 ${seg.radii[0].toFixed(2)} 超过体半径的一半`);
});

test('尾尖不许退化到看不见：锥度有上界、绝对尺寸有下界（F-tail 的第二半）', () => {
  // ⚠️ 这条原来写的是"手机上最小的一只，尾尖 ≥ 1.5 CSS px"，跑出来是 0.65px 而**判不了修复成功**：
  // 尾巴总长按 spec 就是 `lenRatio × 身体半径 = 0.5r`，一只 r ≈ 12px 的幼体整条尾巴才 6px，
  // 要它的尾尖达到 1.5px 半径就等于要求"尾巴和它自己一样粗" —— 那读起来是一坨，不是尾巴。
  // **是我的阈值错了，不是代码错了**，所以换成两条真能判据的：
  //   ① 锥度有上界（尾尖 ≥ 尾根的 60%）：这条与体型无关，管住"递减到消失"；
  //   ② 成体在手机视口上尾尖 ≥ 1 CSS px：低于 1px 是真正的"sub-pixel，画了等于没画"。
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const ctx = createLogCtx();

  const r1 = makeRenderer(world, DESKTOP, false);
  const c1 = world.creatures[0];
  drawCreature(ctx, r1, c1, bodies.get(c1.id), DESKTOP);
  const seg = r1.tailSeg;
  const tip = seg.radii[seg.count - 1];
  assert.ok(tip >= seg.radii[0] * 0.6,
    `尾尖只剩尾根的 ${(tip / seg.radii[0] * 100).toFixed(0)}%，锥度太大等于把尾巴画没了`);

  const r2 = makeRenderer(world, PHONE, false);
  const adult = world.creatures.find((c) => c.stage === 'adult') || world.creatures[0];
  drawCreature(ctx, r2, adult, bodies.get(adult.id), PHONE);
  const s2 = r2.tailSeg;
  assert.ok(s2.radii[s2.count - 1] >= 1,
    `成体在手机视口上尾尖只有 ${s2.radii[s2.count - 1].toFixed(2)} CSS px（< 1 就是 sub-pixel）`);
});
