import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { createViewport, boot } from '../src/main.js';
import {
  createRenderer, hueBucket, sizeBucket, screenX, screenY, createMotes, updateMotes,
} from '../src/render.js';

// ------------------------------------------------------- 记录型桩 ctx
//
// 这个桩是本 Task 最有价值的产出，比水体本身重要。
// 它让 spec §5.3 的三条硬约束（不每帧 shadowBlur、不每帧新建渐变、运行时不分配对象）
// 变成**会变红的断言**，而不是写在注释里靠人评审记住的愿望。
// 计划 1 的经验是：靠评审记不住的约束，交给测试。
//
// 它只统计、不真画。所以这些测试跑在 Node 里、不需要浏览器、不需要 headless canvas。
//
// ⚠️ 它能测的**只有**"方法被调用的次数"。它不模拟像素，也不记参数，所以
//   高光朝向、渐变方向、颜色对不对、sprite 画得美不美 —— 全部测不到，只能进手工清单。
//   凡疑灵属于"只有真实渲染才看出来"的东西，这里刻意**不写**假装能测的断言。

const GRADIENT_STUB = { addColorStop() {} };

function createStubCtx() {
  const counts = new Map();
  const stub = {
    counts,
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    reset() { counts.clear(); stub.shadowBlurWrites = 0; },
    count(name) { return counts.get(name) || 0; },
  };
  const record = (name) => () => { counts.set(name, (counts.get(name) || 0) + 1); };
  for (const m of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke',
    'clip', 'clearRect', 'fillRect', 'setTransform', 'translate', 'rotate', 'scale',
    'drawImage', 'fillText']) stub[m] = record(m);
  // 渐变工厂要**既计数又返回一个可用的桩**，所以不能直接用 record()：
  // 调用方拿到返回值后会接着调 addColorStop，返回 undefined 会在测试里炸成
  // "Cannot read properties of undefined"，把真正的失败原因（每帧新建渐变）盖掉。
  stub.createRadialGradient = () => {
    counts.set('createRadialGradient', (counts.get('createRadialGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.createLinearGradient = () => {
    counts.set('createLinearGradient', (counts.get('createLinearGradient') || 0) + 1);
    return GRADIENT_STUB;
  };
  stub.measureText = () => ({ width: 0 });
  // shadowBlur 是**属性**不是方法，所以必须用 defineProperty 才能数到写入次数。
  // spec §5.3 说它是"手机浏览器上最大的性能杀手"，而它恰好是最容易被人顺手加上的一个属性。
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return stub._shadowBlur; },
    set(v) { stub.shadowBlurWrites += 1; stub._shadowBlur = v; },
  });
  return stub;
}

// makeCanvas 的返回约定（旧计划 Task 4 Step 4 末尾明文要求定死）：
//   { ctx, surface } —— surface 是能直接喂给 drawImage 的东西。
// 浏览器里 surface 是离屏画布元素，桩里就是同一个记录对象；
// 因此 render.js 里**不许**再出现 `x.ctx.canvas !== undefined ? ... : ...` 那种三元式。
const makeCanvasStub = (created) => (w, h) => {
  const c = createStubCtx();
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

// 与 tests/constraints.test.js 的扫描器**同一套**剥注释启发式。
// 为什么这里也要剥：那条守卫的真实语义是"这些标识符在 Node 里不存在，引用它们会让
// 模块在 import 阶段抛 ReferenceError"，而注释里的散文不构成引用 —— render.js 的模块头
// 恰恰要靠写出那几个名字来说明"为什么不许写它们"。不剥注释的话，那条守卫会去管它
// 本来管不着的东西（旧计划 Task 4 的测试清单里就漏了这一步）。
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

// ------------------------------------------------------- 纯函数

test('hueBucket 覆盖整个粉色区间，且正确处理跨 0° 的并集', () => {
  // spec §4.2：粉色是 [315,360] ∪ [0,25]，**跨 0° 的并集，不是线性区间**。
  // 计划 1 已经用变异探针证明过这个盲区（"取 min/max 判断在不在区间内"是错的）。
  // 分桶必须同样处理跨 0°，否则 315–360 与 0–25 这两段会被分到不相邻的桶里，
  // 症状是色相平滑变化的两只生物，光晕颜色却跳变。
  const N = CONFIG.glowHueBuckets;
  assert.equal(hueBucket(315, N), 0, '区间起点应当落在第 0 桶');
  assert.equal(hueBucket(25, N), N - 1, '区间终点应当落在最后一桶');
  // 0° 距区间起点 315° 是 45°（315→360 占 45°，0° 紧随其后），
  // 所以它应当落在 45/70 处的桶 —— 这一条专门盯住"跨 0° 被当成区间外"的实现。
  assert.equal(hueBucket(0, N), Math.min(N - 1, Math.floor((45 / 70) * N)),
    '0° 应当按"距起点 45°"分桶，而不是被折到第 0 桶或最后一桶');
  // 单调性：沿 315 → 360 → 0 → 25 走一圈，桶号必须单调不减
  let prev = -1;
  for (let i = 0; i <= 700; i++) {
    const hue = (315 + (i / 700) * 70) % 360;
    const b = hueBucket(hue, N);
    assert.ok(b >= prev, `桶号在 hue=${hue.toFixed(2)} 处回退了：${b} < ${prev}`);
    assert.ok(b >= 0 && b < N, `桶号越界：${b}`);
    prev = b;
  }
  // 跨 0° 那一点必须连续（359.9 与 0.1 应当是相邻桶，而不是 0 桶与 31 桶）
  const before = hueBucket(359.9, N);
  const after = hueBucket(0.1, N);
  assert.ok(Math.abs(after - before) <= 1, `跨 0° 处桶号跳变：${before} → ${after}`);
});

test('sizeBucket 对数量化，覆盖 sizeOf 的实际范围', () => {
  // sizeOf = traits.size × growthFactor：traits.size ∈ [14,38]，growthFactor ∈ [0.22,1.00]
  // ⇒ 实际范围 [3.08, 38]，跨度 12 倍。线性量化会让刚孵化的小家伙全挤在第 0 桶，
  // 于是它们共用同一张 sprite、看起来一样大 —— 而"幼体比成体小得多"是本项目的可爱来源之一。
  const N = 8;
  assert.equal(sizeBucket(3.08, N), 0);
  assert.equal(sizeBucket(38, N), N - 1);
  // 对数量化的判据：几何中点应当落在中间桶附近，而不是第 0 桶
  const mid = Math.sqrt(3.08 * 38);          // ≈ 10.81
  const b = sizeBucket(mid, N);
  assert.ok(b >= 2 && b <= 5, `几何中点 ${mid.toFixed(2)} 应当落在中间桶，实测第 ${b} 桶`);
  // 单调
  let prev = -1;
  for (let s = 3.08; s <= 38; s += 0.5) {
    const k = sizeBucket(s, N);
    assert.ok(k >= prev && k >= 0 && k < N, `sizeBucket 在 ${s} 处非单调或越界：${k}`);
    prev = k;
  }
});

test('createViewport：缩放由短边推导并 clamp（spec §3.4-2，B11 推迟到本 Task）', () => {
  assert.equal(createViewport(1920, 1080, 1).scale, 2);        // 1080/540
  assert.equal(createViewport(1080, 1920, 1).scale, 2);        // 竖过来短边不变 ⇒ 缩放不变
  assert.equal(createViewport(390, 844, 3).scale, 1.5);        // 0.722 触底
  assert.equal(createViewport(3840, 2160, 1).scale, 2.6);      // 4.0 触顶
  // dpr 与 scale 是两个独立的量：scale 是"世界单位→CSS 像素"，
  // dpr 只影响画布位图尺寸（CSS 像素 → 设备像素）。混用会让高分屏上生物大得离谱。
  const vp = createViewport(390, 844, 3);
  assert.equal(vp.width, 390);
  assert.equal(vp.height, 844);
  assert.equal(vp.dpr, 3);
});

test('screenX/screenY：归一化中点映射到视口中点（两种设备都对）', () => {
  for (const vp of [DESKTOP, PHONE]) {
    assert.ok(Math.abs(screenX(0.5, vp) - vp.width / 2) < 1e-9);
    assert.ok(Math.abs(screenY(0.5, vp) - vp.height / 2) < 1e-9);
    assert.equal(screenX(0, vp), 0);
    assert.ok(Math.abs(screenX(1, vp) - vp.width) < 1e-9);
  }
  // ⚠️ 位置按视口**拉伸**填满，但体型**不跟着拉伸**（scale 只由短边推导）。
  // 这是刻意的：位置拉伸让缸在任何宽高比下都铺满，
  // 而体型不拉伸才能保证星形在超宽屏上还是那只星形、不是被横着拽长的。
  assert.notEqual(DESKTOP.width / DESKTOP.height, PHONE.width / PHONE.height);
  assert.ok(DESKTOP.scale !== PHONE.scale);
});

test('createMotes 一次性分配 typed array，数量取自 CONFIG.particles', () => {
  const rng = createWorld({ seed: 5 }).rng;
  const m = createMotes(CONFIG.particles.desktop, rng);
  assert.equal(m.n, CONFIG.particles.desktop);
  for (const key of ['x', 'y', 'r', 'vy', 'a', 'drift', 'phase']) {
    assert.ok(m[key] instanceof Float64Array, `${key} 必须是 Float64Array（对象池，spec §5.2）`);
    assert.equal(m[key].length, CONFIG.particles.desktop);
  }
  // 初值合法：位置在缸内、alpha 在 spec §4.3 的 0.15–0.4
  for (let i = 0; i < m.n; i++) {
    assert.ok(m.x[i] >= 0 && m.x[i] <= 1, `微粒 ${i} 的 x 越界`);
    assert.ok(m.y[i] >= 0 && m.y[i] <= 1, `微粒 ${i} 的 y 越界`);
    assert.ok(m.a[i] >= CONFIG.render.moteAlphaMin - 1e-12
      && m.a[i] <= CONFIG.render.moteAlphaMax + 1e-12, `微粒 ${i} 的 alpha ${m.a[i]} 不在 spec §4.3 的范围内`);
    assert.ok(Number.isFinite(m.vy[i]) && m.vy[i] > 0, `微粒 ${i} 必须向上漂`);
  }
});

test('updateMotes：微粒到顶后回到底部复用（对象池不重建），且不分配', () => {
  const rng = createWorld({ seed: 5 }).rng;
  const m = createMotes(20, rng);
  const xRef = m.x, yRef = m.y;
  // 跑到所有微粒都至少轮回一次（最慢的 moteRiseMin=0.006 ⇒ 167 秒）
  for (let i = 0; i < Math.round(200 / CONFIG.fixedDt); i++) updateMotes(m, DESKTOP, CONFIG.fixedDt);
  assert.equal(m.x, xRef, 'typed array 必须是同一个引用（运行时零分配）');
  assert.equal(m.y, yRef);
  assert.equal(m.n, 20);
  for (let i = 0; i < m.n; i++) {
    assert.ok(m.y[i] >= -0.05 && m.y[i] <= 1.05, `微粒 ${i} 跑出了合理范围：${m.y[i]}`);
    assert.ok(Number.isFinite(m.x[i]) && Number.isFinite(m.y[i]), `微粒 ${i} 不是有限数`);
  }
});

test('微粒的相位与随机初值全部来自注入的 rng，不用 Date.now 也不用下标哈希', () => {
  // 全局纪律第 2 条。症状很隐蔽：用 Date.now 或 `i * 0.37` 之类凑"每颗粒一个偏移"，
  // 画面照样好看，但同一份存档在两台设备上水体的样子不同（spec §3.4-1 的设备无关性），
  // 而且没法复现。所以这里用**同种子两个独立实例**比对：必须逐位相同。
  const a = createMotes(40, createWorld({ seed: 77 }).rng);
  const b = createMotes(40, createWorld({ seed: 77 }).rng);
  for (let i = 0; i < 40; i++) {
    assert.ok(a.phase[i] !== 0 || b.phase[i] !== 0, '相位不该恒为 0（恒 0 = 用下标凑的）');
    assert.equal(a.phase[i], b.phase[i], `微粒 ${i} 的相位不可复现`);
    assert.equal(a.x[i], b.x[i], `微粒 ${i} 的 x 不可复现`);
    assert.equal(a.vy[i], b.vy[i], `微粒 ${i} 的上浮速度不可复现`);
  }
  // 而且**不能全都一样**：全都一样说明偏移是从下标推的，不是随机抽的
  let distinct = 0;
  for (let i = 1; i < 40; i++) if (a.phase[i] !== a.phase[0]) distinct += 1;
  assert.ok(distinct > 30, `相位几乎全等（distinct=${distinct}）—— 偏移不是从 rng 来的`);
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  assert.ok(!/Math\.random\s*\(/.test(src), 'render.js 不得调用 Math.random()');
});

test('render.js 不 import perceive（交接义务第 2 条）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  assert.ok(!/\bperceive\b/.test(src),
    'perceive 在 tickWorld 之外调用会抛 TypeError（src/sim.js，world.grid 是旧下标）');
});

test('render.js 源码里不出现那七个浏览器全局名（靠注入，不靠豁免）', () => {
  // 这条与 constraints.test.js 的扫描重复，但**报错信息不同**：
  // 那条说"纯逻辑模块不得触碰 DOM"，这条直接告诉实现者该改用注入。
  // 保留它是因为 render.js 是最容易破例的模块 —— 预渲染 sprite 时
  // 顺手写一句 createElement 拿画布太自然了。
  const src = stripComments(
    readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8'));
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src),
      `render.js 出现了 ${name}；画布必须由 main.js 注入的 makeCanvas 提供，不得自己创建`);
  }
});

// ------------------------------------------------------- 性能硬约束（spec §5.3）

test('每帧零渐变创建、零 shadowBlur 写入（spec §5.3 硬约束）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const renderer = makeRenderer(world, DESKTOP, false);
  const ctx = createStubCtx();

  renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);   // 预热一帧
  ctx.reset();                                                  // ← 只统计稳态帧

  for (let i = 0; i < 120; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }

  assert.equal(ctx.count('createRadialGradient'), 0,
    '每帧新建径向渐变是 spec §5.3 明令禁止的（计划 1 的注释称它为"手机浏览器上最大的性能杀手"）；渐变必须预渲染成 sprite');
  assert.equal(ctx.count('createLinearGradient'), 0,
    '同上：沉积带的渐变是**静态**的，必须预渲染');
  assert.equal(ctx.shadowBlurWrites, 0,
    'spec §5.3 禁止每帧 shadowBlur；发光必须用预渲染精灵 + globalCompositeOperation="lighter"');
  // drawImage 应当被大量使用（这才是预渲染的回报）
  assert.ok(ctx.count('drawImage') > 120 * 20,
    `微粒与光束应当走 drawImage，实测 ${ctx.count('drawImage')} 次 / 120 帧`);
});

test('sprite 缓存有界，不会随时间无限增长（防内存泄漏）', () => {
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const renderer = makeRenderer(world, DESKTOP, false);
  const ctx = createStubCtx();
  // ⚠️ B14 把本体 sprite 的键从"色相桶 × 尺寸档"改成了"色相桶 × 饱和档 × 明度档"
  //（本体是不透明填充，明度梯度必须带个体的 sat/lum，而尺寸靠 drawImage 的缩放，不进键）。
  // 上界因此从 32×8 变成 32×16；惰性构建让实际驻留量 ≈ 缸里的个体数。
  const bound = CONFIG.glowHueBuckets * 16;
  for (let i = 0; i < 600; i++) {
    tickWorld(world, CONFIG.fixedDt);
    renderer.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.ok(renderer.pelts.size <= bound, `本体 sprite 缓存 ${renderer.pelts.size} 超过上界 ${bound}`);
  assert.ok(renderer.coreSprites.size <= Object.values(CONFIG.colors).length,
    `体内亮区 sprite 缓存 ${renderer.coreSprites.size} 应当不超过 CONFIG.colors 的条目数`);
  // 光晕与碎边是**启动时一次建好**的定长数组，不参与惰性缓存 ⇒ 永远不可能泄漏
  assert.equal(renderer.glow.length, CONFIG.glowHueBuckets);
  assert.equal(renderer.fluff.length, CONFIG.fluff.sprites);
});

test('水体三层的每帧 drawImage 数 = 微粒 + 光束 + 1（删掉任何一层都会红）', () => {
  // 上面那条只要求 drawImage "足够多"：把沉积带或整组光束的绘制调用删掉，
  // 120 个微粒仍然远超 2400 的门槛 ⇒ 守卫一片绿而缸底少了一条带、水面少了几道光。
  // 所以这里钉**精确等式**：三层各贡献多少次就是多少次。
  //
  // ⚠️ B14 起生物层也往同一个 ctx 贴图（每只 7 次），所以这条把 bodies 换成**空表**：
  // 空表 ⇒ draw() 里每只都查不到 Body ⇒ 只剩水体三层，等式重新变成精确的。
  // 生物那一侧的精确账单由 tests/render-body.test.js 钉（每只恰好 7 次、24 段贝塞尔）。
  const created = [];
  const world = makeWorld(11);
  const renderer = makeRenderer(world, DESKTOP, false, created);
  const ctx = createStubCtx();
  renderer.draw(ctx, world, new Map(), DESKTOP, CONFIG.fixedDt);
  ctx.reset();
  renderer.draw(ctx, world, new Map(), DESKTOP, CONFIG.fixedDt);

  assert.equal(renderer.shafts.length, CONFIG.render.shaftCount,
    `光束应当预渲染 ${CONFIG.render.shaftCount} 道（spec §5.2："2–3 道"）`);
  assert.ok(renderer.sediment, '沉积带 sprite 必须存在');
  assert.ok(renderer.moteSprite, '微粒 sprite 必须存在');
  assert.equal(ctx.count('drawImage'),
    renderer.motes.n + renderer.shafts.length + 1,
    '每帧贴图次数 = 微粒 + 光束 + 一次沉积带。对不上就是某一层没画（或多画了一层）');
  // save/restore 成对：'lighter' 混合模式漏了 restore 会污染后面所有层（Task 5 起就有身体了）
  assert.equal(ctx.count('save'), ctx.count('restore'),
    `save ${ctx.count('save')} 次 / restore ${ctx.count('restore')} 次 —— 必须成对`);
});

test('渐变确实被预渲染过（防"干脆不画"这种绕过零渐变约束的假绿）', () => {
  // "每帧零 createLinearGradient"有一个平凡的错误实现能满足：根本不建沉积带和光束。
  // 这条把另一个方向也钉住：建池时**必须**建过渐变，而且只在建池时建。
  const created = [];
  const world = makeWorld(11);
  const renderer = makeRenderer(world, DESKTOP, false, created);
  const waterSprites = 1 + CONFIG.render.shaftCount + 1;
  const bodySprites = CONFIG.glowHueBuckets + CONFIG.fluff.sprites;
  assert.equal(created.length, waterSprites + bodySprites,
    `启动时应建 1 张沉积带 + ${CONFIG.render.shaftCount} 张光束 + 1 张微粒 sprite
     + ${CONFIG.glowHueBuckets} 张光晕 + ${CONFIG.fluff.sprites} 张碎边（B14），实测 ${created.length} 张`);
  assert.ok(renderer.sediment.ctx.count('createLinearGradient') >= 1, '沉积带的静态渐变必须建出来');
  assert.ok(renderer.sediment.ctx.count('fillRect') >= 1);
  for (const s of renderer.shafts) {
    assert.ok(s.ctx.count('createLinearGradient') >= 2, '光束要有横向色带 + 纵向衰减两条渐变');
  }
  assert.equal(renderer.moteSprite.ctx.count('createRadialGradient'), 1, '微粒是一张径向渐变的圆点');
  // B14：光晕与碎边同样是**预渲染**的，运行时只 drawImage
  for (const g of renderer.glow) {
    assert.equal(g.ctx.count('createRadialGradient'), 1, '每张光晕恰好建一次渐变（建池时）');
  }
  for (const f of renderer.fluff) {
    assert.ok(f.ctx.count('drawImage') === 0, '碎边 sprite 不该由别的贴图合成');
    assert.ok(f.ctx.count('stroke') >= CONFIG.bodyPoints,
      `碎边要有毛尖的形状（建 sprite 时画 ${f.ctx.count('stroke')} 根，运行时一根都不画）`);
  }
  // 沉积带要盖到卵的下沿（卵产在 y ∈ [0.78, 0.97]，breeding.js），否则卵悬空
  assert.ok(renderer.sediment.h >= DESKTOP.height * 0.05,
    `沉积带太薄（${renderer.sediment.h}px），卵会像悬在沉积带上方`);
});

test('水体层在手机视口下用 CONFIG.particles.mobile', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, PHONE, true);
  assert.equal(r.motes.n, CONFIG.particles.mobile,
    `手机应当只放 ${CONFIG.particles.mobile} 个微粒（spec §5.3 的性能预算）`);
});

test('onResize 不重建微粒池的 typed array（重建=每帧分配的另一种形式）', () => {
  const world = makeWorld(11);
  const r = makeRenderer(world, DESKTOP, false);
  const xRef = r.motes.x;
  r.onResize(PHONE, world.rng.fork());
  assert.equal(r.motes.x, xRef, 'resize 只应重算分布范围，不该重新分配数组');
});

test('resize 不重映射任何 c.pos（架构决定 5：spec §3.4-2 那句在归一化设计下是空操作）', () => {
  // 这是 B11 实测确认过、并被明令"不许补上"的一件事：位置存 [0,1]²，世界尺寸恒等于视口，
  // 所以视口变了而归一化坐标的含义没变。真去"按新旧尺寸比例映射所有位置"反而是 bug：
  // 每次拖窗口把整缸乘一个比例，来回拖几次就把它们全推进角落。
  // 本测试用假 DOM 跑真实的 boot() → 触发真实的 resize handler。
  const raf = [];
  const handlers = {};
  const fakeDocument = { createElement: () => makeElement() };
  const mainCtx = createStubCtx();
  const fakeWindow = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, handler) => { handlers[type] = handler; },
    removeEventListener: () => {},
  };
  const makeElement = () => ({
    width: 0, height: 0, clientWidth: 0, clientHeight: 0, getContext: () => createStubCtx(),
    // B17：main.js 现在会把指针监听听绑到这个元素上（attachInput 靠注入拿目标）。
    // 这几条测试不关心手，所以收下监听但没人派发事件 —— 空实现即可。
    // tests/input.test.js 里那个 makeTarget 才是真派发的那一条。
    addEventListener: () => {}, removeEventListener: () => {},
  });
  const canvasEl = makeElement();
  canvasEl.clientWidth = 1920;
  canvasEl.clientHeight = 1080;
  canvasEl.getContext = () => mainCtx;
  const draws = [];
  const resizes = [];
  const spyRenderer = {
    draw(ctx, world, bodies, viewport, dt) { draws.push({ ctx, world, bodies, viewport, dt }); },
    onResize(viewport) { resizes.push(viewport); },
  };

  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
  };
  g.document = fakeDocument;
  g.window = fakeWindow;
  g.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  g.cancelAnimationFrame = () => {};
  try {
    const controller = boot({ hud: false, canvas: canvasEl, renderer: spyRenderer, seed: 20261020 });
    const world = controller.world;
    assert.ok(typeof controller.viewport.scale === 'number' && controller.viewport.scale > 0,
      '视口必须带 scale（世界单位→CSS 像素）');
    const before = world.creatures.map((c) => [c.pos.x, c.pos.y]);

    // 拖窗口 + 换到不同 dpr 的显示器：这是唯一"新旧尺寸比例"不为 1 的时刻
    canvasEl.clientWidth = 500;
    canvasEl.clientHeight = 1200;
    fakeWindow.devicePixelRatio = 2;
    handlers.resize();

    const after = world.creatures.map((c) => [c.pos.x, c.pos.y]);
    assert.equal(after.length, before.length, 'resize 不得增删生物');
    for (let i = 0; i < before.length; i++) {
      // 逐位相同（Object.is 区分 ±0 与 NaN，比 === 更严）
      assert.ok(Object.is(after[i][0], before[i][0]),
        `生物 ${world.creatures[i].id} 的 pos.x 被 resize 改写了：${before[i][0]} → ${after[i][0]}`);
      assert.ok(Object.is(after[i][1], before[i][1]),
        `生物 ${world.creatures[i].id} 的 pos.y 被 resize 改写了：${before[i][1]} → ${after[i][1]}`);
    }
    // resize 该做的三件事仍然要做（否则"不重映射"会退化成"什么都不做"）
    assert.equal(controller.viewport.width, 500);
    assert.equal(controller.viewport.height, 1200);
    assert.equal(controller.viewport.dpr, 2);
    assert.equal(controller.viewport.scale, CONFIG.render.scaleMin, '500×1200 短边 500 ⇒ 0.926 触底 1.5');
    assert.equal(canvasEl.width, 1000, '位图尺寸 = CSS × dpr');
    assert.equal(canvasEl.height, 2400);
    assert.ok(resizes.length >= 2, `resize 必须通知渲染层（onResize 实测 ${resizes.length} 次）`);
    assert.equal(controller.viewport, resizes[resizes.length - 1], 'onResize 要收到同一个视口对象');
    controller.stop();
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
});

test('main.js 把 bodies 与**模拟**秒数交给 renderer.draw（4× 下水体不能冻住）', () => {
  // 旧计划 Task 4 Step 5 的警告：传 simDt 而不是 frameDt。
  // 传错的症状是"4× 倍速下缸在快进而水冻在原速"，0.5× 下水体反而比生物快 —— 没人报错。
  const raf = [];
  const handlers = {};
  const makeElement = () => ({
    width: 0, height: 0, clientWidth: 1280, clientHeight: 720, getContext: () => createStubCtx(),
    addEventListener: () => {}, removeEventListener: () => {},   // B17：attachInput 的注入目标
  });
  const canvasEl = makeElement();
  const fakeWindow = {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, handler) => { handlers[type] = handler; },
    removeEventListener: () => {},
  };
  const draws = [];
  const spyRenderer = {
    draw(ctx, world, bodies, viewport, dt) { draws.push({ bodies, viewport, dt }); },
    onResize() {},
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
    const controller = boot({ hud: false, canvas: canvasEl, renderer: spyRenderer, seed: 20261021 });
    const step = () => raf[raf.length - 1];
    step()(0);                                   // 第一帧 frameDt = 0 ⇒ 0 个子步
    step()(1000 / 60);                           // 1× 下一帧：1 个子步
    assert.equal(draws.length, 2);
    assert.equal(draws[1].dt, CONFIG.fixedDt, '1× 的一帧推进一个 fixedDt');
    assert.equal(draws[1].bodies, controller.bodies, '第 3 个参数必须是 bodies（Task 5 起要读它）');
    assert.equal(draws[1].viewport, controller.viewport);

    controller.setTimeScale(4);
    const t = 1000 / 60;
    step()(t + 1000 / 60);                       // 4× 下同样的一帧真实时间 ⇒ 4 个子步
    const last = draws[draws.length - 1];
    assert.equal(last.dt, 4 * CONFIG.fixedDt,
      `4× 时传给渲染层的必须是 4 个 fixedDt，实测 ${last.dt}`);
    assert.notEqual(last.dt, 1 / 60, '传成 frameDt 就是"水体不随倍速走"那个 bug');
    // 空帧（0.5× 的隔帧）也必须还在绘制，只是 dt = 0
    controller.setTimeScale(0.5);
    step()(t + 2 * (1000 / 60));
    step()(t + 3 * (1000 / 60));
    assert.ok(draws.some((d) => d.dt === 0), '0.5× 的空帧 dt 应当为 0 而不是负数或 NaN');
    controller.stop();
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
});

test('render.js 接进 main.js 后能在 Node 里跑起来（真 renderer，不是 spy）', () => {
  // 这一条同时是"依赖注入让渲染层留在纯集合里"的正向证明：
  // 主循环 + 真 createRenderer + 假 DOM + 记录型桩 ⇒ 不需要浏览器就能跑若干帧。
  const raf = [];
  const makeElement = () => ({
    width: 0, height: 0, clientWidth: 1024, clientHeight: 640, getContext: () => createStubCtx(),
    addEventListener: () => {}, removeEventListener: () => {},   // B17：attachInput 的注入目标
  });
  const canvasEl = makeElement();
  const mainCtx = createStubCtx();
  canvasEl.getContext = () => mainCtx;
  const fakeWindow = {
    devicePixelRatio: 2,
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
    const controller = boot({ hud: false, canvas: canvasEl, seed: 20261022 });
    const step = () => raf[raf.length - 1];
    for (let i = 0; i <= 60; i++) step()(i * (1000 / 60));
    assert.ok(mainCtx.count('drawImage') > 0, '真 renderer 必须往主 ctx 上贴图');
    assert.equal(mainCtx.count('createLinearGradient'), 0);
    assert.equal(mainCtx.count('createRadialGradient'), 0);
    assert.equal(mainCtx.shadowBlurWrites, 0);
    // spec §3.4-5：静态深水背景归 CSS，canvas 只 clearRect 不填色 ⇒ 每帧省掉一次全屏填充。
    // 这条**是**桩数得出的（fillRect 的次数），所以进了自动化而不是手工清单。
    assert.equal(mainCtx.count('fillRect'), 0,
      '主 ctx 上出现 fillRect = 有人把全屏背景色搬回 canvas 了（spec §3.4-5 要求它留在 CSS）');
    assert.ok(mainCtx.count('clearRect') >= 60, '每帧一次 clearRect（让 CSS 背景透出来）');
    assert.ok(controller.bodies.size > 0, 'bodies 表应被填起来（渲染层下一步就读它）');
    controller.stop();
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
});

test('沉积带 / 光束 / 微粒的 rgba 字面量与 CONFIG.colors 的三个新色同源', () => {
  // spec §4.3 只给了背景三段色；沉积带、光束、微粒的透明版色值各存了两份
  //（CONFIG.colors 的十六进制 + render.js 里渐变的 rgba 端点）。
  // tests/assets.test.js 已经在 CSS↔CONFIG 那条边界上立了同类守卫，这里补 CONFIG↔render.js。
  // 漂移的症状：改 CONFIG.colors.sediment 之后缸底只改一半，而没有任何一处报错。
  const src = readFileSync(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
  const rgbOf = (hex) => {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
    assert.ok(m, `${hex} 不是 #RRGGBB`);
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  };
  for (const name of ['sediment', 'shaft', 'mote']) {
    const [r, gg, b] = rgbOf(CONFIG.colors[name]);
    assert.ok(src.includes(`rgba(${r},${gg},${b},`),
      `render.js 里没有 ${name}（${CONFIG.colors[name]} → rgb(${r},${gg},${b})）的透明版端点；两边已经分家`);
  }
});
