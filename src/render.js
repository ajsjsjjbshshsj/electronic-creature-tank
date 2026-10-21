// render.js —— Canvas 绘制层（spec §5.1、§5.2、§5.3）。
//
// 纯逻辑模块：**不碰任何浏览器全局**。画布上下文由调用方以形参传入（ctx），
// 离屏画布由 main.js 注入的 makeCanvas 工厂提供。
// 这么做的回报是：本文件里那些真正容易写错的东西 —— 色相分桶、尺寸分桶、坐标映射、
// 微粒积分、绘制调用序列 —— 全部能在 Node 里断言，不需要 headless 浏览器。
// 这就是 tests/constraints.test.js 的 DOM 扫描能把本文件继续留在覆盖范围内的原因。
//
// ⚠️ 两个会咬人的命名陷阱（扫描器只剥注释、不剥字符串字面量，且用 \b 词边界匹配）：
//   · 局部变量**不得**用那个以 c-a-n 开头的名字（叫 sprite / offscreen / sctx）。
//   · 代码里**不得**出现那个字的字符串字面量（引号是非单词字符，会构成词边界而被匹配到）。
//     创建可绘制对象只能由注入的 makeCanvas 做。
// 这两条绕的是扫描器的**假阳性**（局部变量与字符串并非对浏览器全局的引用），
// 而它的意图（"这些标识符在 Node 里不存在，引用它们会让模块 import 阶段就抛 ReferenceError"）
// 被完整保留 —— tests/render.test.js 里就有一条直接 import 本模块来验证那个意图。
//
// ⚠️ 注入约定（旧计划 Task 4 Step 4 末尾明文定死）：
//   makeCanvas(w, h) => { ctx, surface }
//   surface 是**能直接喂给 ctx.drawImage 的东西**（浏览器里是离屏元素，桩里是记录对象）。
//   有了这个约定，本文件里就不许再出现 `x.ctx.canvas !== undefined ? ... : ...`
//   那种兼容两种注入形状的丑陋三元式 —— 它是坏味道，而且会让"到底传了什么"这件事
//   在测试里无法被钉住。
//
// ⚠️ 本 Task（B13）只交付**水体层**：微粒、光束、缸底沉积。
// 生物（光晕 / 本体 / 花纹 / 体内光）、食物、卵、溶散、气泡在 B14–B16 接进 draw()。
// bodies 参数现在就进签名是为了让 main.js 的调用形状一次定下来（Task 5 起直接读它）。
//
// ⚠️ 绘制**不可重入**：逐点屏幕坐标写进 renderer 上的复用数组（spec §5.3 运行时零分配）。
// 单线程顺序绘制天然满足；计划 3 若想加"缩略图预览"之类的并发绘制，必须先改掉这一点。
//
// ⚠️ 桩 ctx 只数调用次数（因此"高光朝向"这类只能进手工清单）。
// 本文件里凡属于"只有真实渲染才看得出来"的东西 —— 渐变的朝向、颜色的观感、
// 光束够不够柔、沉积带厚不厚 —— 都由 tests/visual-checklist 手工核对，
// 这里刻意不写假装能测的断言。

import { CONFIG } from './config.js';
import { renderSizeOf } from './body.js';

const TAU = Math.PI * 2;
const R = CONFIG.render;

// ---------------------------------------------------------------- 纯函数

// 色相分桶。粉色区间是 [315,360] ∪ [0,25]，**跨 0° 的并集** ——
// genes.decode 的公式是 hue = (315 + p.hue × 70) mod 360，所以整个区间宽 70°。
// 先把 hue 折算成"距区间起点 315° 的角距离"（0–70），再均分成 buckets 份。
// 这样跨 0° 是**连续**的：359.9° 与 0.1° 落在相邻桶，而不是首尾两端。
// 由 tests/render.test.js 的单调性与跨 0° 连续性两条断言钉住（计划 1 证明过这个盲区）。
export function hueBucket(hue, buckets) {
  const span = CONFIG.hueRange[1] - CONFIG.hueRange[0] + 360;   // 25 - 315 + 360 = 70
  const start = CONFIG.hueRange[0];                             // 315
  let d = (hue - start) % 360;
  if (d < 0) d += 360;                       // hue < 315 时折回正数（0° → 45°）
  if (d > span) d = span;                    // 理论上不该发生（decode 保证了范围），防御性夹住
  const b = Math.floor((d / span) * buckets);
  return b >= buckets ? buckets - 1 : b;     // d === span 时 floor 会给出 buckets，必须夹回
}

// 尺寸分桶，对数量化。
// sizeOf 的实际范围是 [3.08, 38]（traits.size 14–38 × growthFactor 0.22–1.00），跨度 12 倍。
// 线性量化会把所有刚孵化的小家伙塞进第 0 桶，于是它们共用一张 sprite、看起来一样大。
const SIZE_LO = CONFIG.minSize * 0.22;       // 3.08
const SIZE_HI = CONFIG.maxSize;              // 38
const SIZE_LOG_SPAN = Math.log(SIZE_HI / SIZE_LO);

export function sizeBucket(size, buckets) {
  const s = size < SIZE_LO ? SIZE_LO : size > SIZE_HI ? SIZE_HI : size;
  const b = Math.floor((Math.log(s / SIZE_LO) / SIZE_LOG_SPAN) * buckets);
  return b >= buckets ? buckets - 1 : b < 0 ? 0 : b;
}

// 归一化世界坐标 → CSS 像素。
// ⚠️ 位置按视口**拉伸**填满（世界尺寸恒等于视口，spec §3.4-2），
// 但体型**不跟着拉伸** —— scale 只由短边推导，所以星形在超宽屏上还是那只星形。
// 返回标量而不是 {x,y} 对象：这两个函数在每帧每只生物上都要调用，
// 返回对象就是每秒几百次分配（spec §5.3 禁止）。
export const screenX = (wx, viewport) => wx * viewport.width;
export const screenY = (wy, viewport) => wy * viewport.height;

// 当前渲染半径（CSS 像素）。renderSizeOf 已经是世界单位（含 growthFactor 的年龄缩放），
// 而 sizeOf × scale 是**直径**（见 CONFIG.render 顶部那张表），所以再乘 0.5。
// 走 body.js 的 renderSizeOf 而不是直接 import creature.js 的 sizeOf：
// B12 把那条导出的理由写明了——"让『体型随年龄变化』这件事只有一个实现"。
export const radiusPx = (c, viewport) => renderSizeOf(c) * viewport.scale * 0.5;

// ---------------------------------------------------------------- 微粒对象池

// 并列的 Float64Array，不是对象数组（架构决定 6）。
// 偏移量（半径、速度、alpha、漂移、相位）**全部来自注入的 rng**：
// 全局纪律第 2 条 —— 用 Date.now 或下标哈希凑"每颗粒一个偏移"会让同一份存档
// 在两台设备上长出不同的水，而 spec §3.4-1 要求设备无关。
export function createMotes(n, rng) {
  const m = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    r: new Float64Array(n),
    vy: new Float64Array(n),
    a: new Float64Array(n),
    drift: new Float64Array(n),
    phase: new Float64Array(n),
    baseX: new Float64Array(n),
  };
  seedMotes(m, rng);
  return m;
}

function seedMotes(m, rng) {
  for (let i = 0; i < m.n; i++) {
    m.baseX[i] = rng.next();
    m.x[i] = m.baseX[i];
    m.y[i] = rng.next();                                  // 初始就铺满整缸，不是从底部一起冒出来
    m.r[i] = rng.range(R.moteRadiusMin, R.moteRadiusMax);
    m.vy[i] = rng.range(R.moteRiseMin, R.moteRiseMax);
    m.a[i] = rng.range(R.moteAlphaMin, R.moteAlphaMax);   // spec §4.3：0.15–0.4
    m.drift[i] = rng.range(0, R.moteDrift);
    m.phase[i] = rng.range(0, TAU);
  }
}

// 就地积分。到顶的微粒回到底部**复用**同一个槽位（对象池，spec §5.2/§5.3）。
export function updateMotes(m, viewport, dt) {
  const t = viewport.time || 0;
  for (let i = 0; i < m.n; i++) {
    m.y[i] -= m.vy[i] * dt;                 // 向上漂（屏幕 y 向下为正）
    if (m.y[i] < -0.02) {                   // 到顶后回到底部
      m.y[i] += 1.04;
      m.x[i] = m.baseX[i];                  // 重置漂移基准，避免长期单向累积
      m.phase[i] = (m.phase[i] + 1.7) % TAU;
    }
    // 横向缓慢摆动。用 sin 而不是随机游走：随机游走需要每帧取随机数，
    // 那会让水体在两台设备上长得不一样（而 spec §3.4-1 要求设备无关）。
    m.x[i] = m.baseX[i] + Math.sin(t * 0.35 + m.phase[i]) * m.drift[i];
  }
}

// ---------------------------------------------------------------- 渲染器

export function createRenderer(opts) {
  const makeOffscreen = opts.makeCanvas;
  if (typeof makeOffscreen !== 'function') {
    throw new TypeError('createRenderer: 需要注入 makeCanvas(w, h) => { ctx, surface }（本模块不碰浏览器全局）');
  }
  const isMobile = !!opts.isMobile;
  const renderer = {
    makeCanvas: makeOffscreen,
    isMobile,
    viewport: opts.viewport,
    motes: createMotes(isMobile ? CONFIG.particles.mobile : CONFIG.particles.desktop, opts.rng),
    shafts: [],
    sediment: null,        // 预渲染的缸底 sprite（静态 ⇒ 只建一次）
    moteSprite: null,      // 预渲染的微粒 sprite
    glow: [],              // B14（Task 5）：32 张光晕精灵
    gel: new Map(),        // B14：凝胶体 sprite 缓存，键 = hueBucket * 8 + sizeBucket
    // 逐点屏幕坐标的复用数组（spec §5.3：运行时不分配对象）。B14 起被身体层使用。
    sx: new Float64Array(CONFIG.bodyPoints),
    sy: new Float64Array(CONFIG.bodyPoints),
    time: 0,
    onResize(nextViewport, rng) {
      renderer.viewport = nextViewport;
      // 微粒**不重新分配**，只把越界的拉回缸内：重建 typed array 等于每次 resize
      // 都产生一次大块分配，而拖动窗口时会连续触发几十次 resize。
      const m = renderer.motes;
      for (let i = 0; i < m.n; i++) {
        if (m.y[i] > 1.05 || m.y[i] < -0.05) m.y[i] = rng.next();
      }
      buildStatics(renderer);
    },
    draw(ctx, world, bodies, viewport, dt) {
      renderer.time += dt;
      // 水体的摆动时钟挂在视口对象上（updateMotes 读 viewport.time）。
      // 同一个对象被 main.js 原地改写，所以这里写回去不会造成任何额外分配。
      viewport.time = renderer.time;
      updateMotes(renderer.motes, viewport, dt);
      drawWater(ctx, renderer, viewport);
      // B14/B15/B16 在这里接上生物、食物、卵的绘制（bodies 已经在签名里等着）
    },
  };
  buildStatics(renderer);
  return renderer;
}

// 静态层预渲染：缸底沉积带与光束、微粒圆点。
//
// 为什么必须预渲染：spec §5.3 禁止每帧新建渐变，而沉积带本身就是一条线性渐变。
// 它是**完全静态**的（只依赖视口尺寸），所以预渲染成一张 sprite 是纯赚 ——
// 每帧一次 drawImage 换掉每帧一次 createLinearGradient + fillRect。
//
// 只在启动与 resize 时被调用，绝不在 draw 里被调用 —— 这条由
// tests/render.test.js 的"每帧零渐变创建"与"启动时恰好建 5 张"两条一起守。
function buildStatics(renderer) {
  const vp = renderer.viewport;
  const w = Math.max(1, Math.round(vp.width));
  const h = Math.max(1, Math.round(vp.height));

  // ---- 缸底沉积带 + 柔和堆叠（spec §5.2："产卵点"）----
  const sedH = Math.max(1, Math.round(h * R.sedimentHeight));
  const sediment = renderer.makeCanvas(w, sedH);
  const sctx = sediment.ctx;
  const grad = sctx.createLinearGradient(0, 0, 0, sedH);
  grad.addColorStop(0, 'rgba(23,10,34,0)');                    // CONFIG.colors.sediment 透明版
  grad.addColorStop(0.45, CONFIG.colors.sediment);
  grad.addColorStop(1, CONFIG.colors.sediment);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, w, sedH);
  // 堆叠形状：卵产在 y ∈ [0.78,0.97]（breeding.js），沉积带覆盖到 0.915 以下，
  // 所以堆叠要落在沉积带里，卵才像是**埋在**沉积物中而不是悬空。
  sctx.fillStyle = CONFIG.colors.sedimentLight;
  sctx.globalAlpha = 0.5;
  for (let i = 0; i < R.moundCount; i++) {
    const cx = ((i + 0.5) / R.moundCount) * w;
    const rw = w / R.moundCount * 0.62;
    const rh = sedH * 0.42;
    sctx.beginPath();
    sctx.ellipse(cx, sedH - rh * 0.35, rw, rh, 0, 0, TAU);
    sctx.fill();
  }
  sctx.globalAlpha = 1;
  renderer.sediment = { ctx: sctx, surface: sediment.surface, w, h: sedH };

  // ---- 光束（spec §5.2：2–3 道缓慢摆动的光柱，预渲染后平移）----
  renderer.shafts.length = 0;
  const shaftW = Math.max(8, Math.round(w * 0.16));
  for (let i = 0; i < R.shaftCount; i++) {
    const built = renderer.makeCanvas(shaftW, h);
    const shaftCtx = built.ctx;
    const g2 = shaftCtx.createLinearGradient(0, 0, shaftW, 0);
    g2.addColorStop(0, 'rgba(106,74,138,0)');                  // CONFIG.colors.shaft 的两端透明版
    g2.addColorStop(0.5, CONFIG.colors.shaft);
    g2.addColorStop(1, 'rgba(106,74,138,0)');
    shaftCtx.fillStyle = g2;
    shaftCtx.fillRect(0, 0, shaftW, h);
    // 上宽下窄的锥形衰减：光从水面斜射进来，越深越弱
    const fade = shaftCtx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    shaftCtx.globalCompositeOperation = 'destination-in';
    shaftCtx.fillStyle = fade;
    shaftCtx.fillRect(0, 0, shaftW, h);
    shaftCtx.globalCompositeOperation = 'source-over';
    renderer.shafts.push({
      ctx: shaftCtx, surface: built.surface, w: shaftW, h,
      base: (i + 0.5) / R.shaftCount, phase: i * 2.1,
    });
  }

  // ---- 微粒 sprite（一张柔和圆点，运行时只 drawImage + 改 globalAlpha）----
  const ms = 16;
  const moteBuilt = renderer.makeCanvas(ms, ms);
  const moteCtx = moteBuilt.ctx;
  const mg = moteCtx.createRadialGradient(ms / 2, ms / 2, 0, ms / 2, ms / 2, ms / 2);
  // CONFIG.colors.mote = '#FFD9E8'
  mg.addColorStop(0, 'rgba(255,217,232,1)');
  mg.addColorStop(0.4, 'rgba(255,217,232,0.55)');
  mg.addColorStop(1, 'rgba(255,217,232,0)');
  moteCtx.fillStyle = mg;
  moteCtx.fillRect(0, 0, ms, ms);
  renderer.moteSprite = { ctx: moteCtx, surface: moteBuilt.surface, size: ms };
}

// 水体三层的绘制。顺序即层序：光束（最远）→ 沉积带（缸底）→ 微粒（最浅，向上升）。
// 每一层都是"一次 drawImage 一堆"，没有任何渐变创建（spec §5.3）。
function drawWater(ctx, renderer, viewport) {
  const w = viewport.width;
  const h = viewport.height;

  // 光束：'lighter' 叠加，靠平移预渲染好的 sprite 实现摆动（不重建渐变）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = R.shaftAlpha;
  for (const s of renderer.shafts) {
    const sway = Math.sin(renderer.time / R.shaftSwayPeriod * TAU + s.phase) * 0.06;
    const x = (s.base + sway) * w - s.w * 0.5;
    ctx.drawImage(s.surface, x, 0, s.w, h);
  }
  ctx.restore();

  // 缸底沉积带（静态 sprite，一次 drawImage）
  if (renderer.sediment) {
    ctx.drawImage(renderer.sediment.surface, 0, h - renderer.sediment.h, w, renderer.sediment.h);
  }

  // 微粒：只改 globalAlpha 与目标尺寸，sprite 本身是同一张
  const sprite = renderer.moteSprite;
  const src = sprite.surface;
  const m = renderer.motes;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < m.n; i++) {
    const d = m.r[i] * 2 * viewport.scale * 0.5;
    ctx.globalAlpha = m.a[i];
    ctx.drawImage(src, screenX(m.x[i], viewport) - d, screenY(m.y[i], viewport) - d, d * 2, d * 2);
  }
  ctx.restore();
}
