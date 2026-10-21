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
import { renderSizeOf, starRadius } from './body.js';
import { dominant } from './emotions.js';
// 第 6 层（B15）：四参数与十行表的**计算全在 eyes.js**（纯函数、Node 里全测），
// 本文件只负责把它们画出来 —— 这是本 Task 的架构裁定，不是顺手拆分。
import {
  eyeParamsInto, eyeAnchorsInto, blushFor,
  pupilColor, eyeWhiteColor, eyeHighlightColor, blushColor,
} from './eyes.js';

// ⚠️ B14 交付**分层身体的第 1/2/3/4/5/7 层**，B15（2026-10-21）补上第 6 层（spec §5.1 由内到外）：
//   1 光晕 → 2 不透明本体 → 3 花纹（绣在毛里）→ 4 体内亮区（透过毛看到的一片）
//   → 5 尾巴（3 段贴图）→ **6 眼睛 + 腮红（B15，走路径不贴图）** → 7 毛尖碎边
//   （1 次 setTransform + 1 次 drawImage）→ [8 语言气泡 = B19]。
//   蹦跳压扁、死亡溶散、卵与食物的绘制仍不在本次（B16），所以 CONFIG.render 里也没有它们的常量。
//
// ⚠️ 相对旧计划 Task 5 的四处改动，全部按 spec §5.1 的 2026-10-20 重排落地：
//   1. 半透明凝胶（gelAlpha 0.55）→ **不透明**填充：本体 sprite 的每个色标 alpha 恒为 1，
//      而且 drawCreature 在 clip 之内显式写一次 globalAlpha = 1。
//   2. 跨色相的径向渐变 → **同色相**的"受光侧提亮 / 背光侧压暗"：peltStopsFor 只改 L 与 S，
//      H 一个数字都不动。⚠️ 粉色区间 [315,360]∪[0,25] 是**跨 0° 的并集**，
//      任何"在两个色相之间插值"的写法都会把 359°→1° 插到 180°（绿色）。
//      B12/A3 都栽过这个坑（那次是在度数上算标准差，得到 167° 的假数）。
//      所以这里连 hue 的**偏移**都不做，而不是"用 decode 的方式去插值"——没有需要插的。
//   3. 花纹 alpha 压到 CONFIG.render.patternAlpha（0.35）："花纹是绣在毛里的，不是印在塑料上的"。
//   4. "发光核"（alpha 0.85 的一颗清晰亮椭圆、半径系数 0.30）→ **一片**柔和亮区
//      （innerRadiusFactor 0.46 / innerAlpha 0.34），位置仍在体心，脉动节奏不变
//      （仍读 body.js 的 phase/pulse，不在这里另计时钟）。光晕同时半径收小、alpha 降低，
//      因为毛会散射光 —— 现在是"整只柔和地亮起来"，不再是"暗水里一圈清晰的光边"。
//
// ⚠️ 毛绒的性能生死线（spec §4.7 / §5.3）：**绝不允许每帧画贝塞尔毛**。
// 24 只 × 120 段 = 2880 段贝塞尔/帧，手机必崩。换来的便宜是"只画毛尖碎边"：
// 总共 CONFIG.fluff.sprites = 2 张预渲染 sprite（常态 / 炸开），每只每帧一次贴图 + 一次矩阵，
// 随身体的 squash 一起变换，**不重算毛的位置**。
//
// ⚠️ 旧计划 Task 7 的"求偶编舞"那一节**整块没搬**：内核已改孤雌自产卵（spec §4.12），
// court / courtship / courtshipFactor / canCourt 在 src/ 里已经不存在，
// 由 tests/render-body.test.js 的一条反向断言盯着它们不许复活。
//
// ⚠️ 桩数不到的东西（渐变朝向、碎边亮度对比好不好看、受光侧真的在左上吗）一律进手工清单。
// 但**颜色与 alpha 的语义**不走桩：peltStopsFor / patternColorFor / glowAlphaFor /
// innerAlphaFor 是建 sprite 与施透明度的唯一取色路径，所以"不透明""不跨色相""0.35 一档"
// 这些是能在 Node 里真断言的，不是假装能测。

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

// ---------------------------------------------------------------- 颜色与 alpha 的纯函数
//
// 这一节是 B14 唯一能把"颜色语义"钉进自动化的地方：桩 ctx 记不到参数，
// 所以凡是必须被证明的东西（本体不透明、色相不跨、花纹压到 0.35）都写成**返回字符串/数字的
// 纯函数**，由建 sprite 的与绘制的那一侧唯一地调用它们。测试打的是同一个实现，不是旁证。

const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

// ⚠️ hue 在这里**只被打印**，永远不参与算术：hsla() 的 H 分量从进来到出去是同一个数。
// spec §5.1 第 2 层要的是"同色相渐变"，而跨 0° 的粉色区间（[315,360]∪[0,25]）
// 恰好是让"顺手加个 hue 偏移"变成绿色事故的那个数区。
const hsla = (h, s, l, a) => `hsla(${h.toFixed(2)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%, ${a})`;

// 反向查表：给定桶号还原该桶的代表色相。预渲染必须从桶号反推颜色。
// 与 hueBucket 同一条弧（起点 315°、跨度 70°），取桶**中点**而不是边界，
// 所以 359° 与 1° 的邻居给出相邻的两个色相 —— 跨 0° 连续。
function bucketHue(b, buckets) {
  const span = CONFIG.hueRange[1] - CONFIG.hueRange[0] + 360;   // 25 - 315 + 360 = 70
  const mid = ((b + 0.5) / buckets) * span;
  return (CONFIG.hueRange[0] + mid) % 360;
}

// 第 2 层：本体的四段色标（受光 → 背光）。
// ⚠️ 全部 alpha = 1（毛绒不透明，这是与凝胶最直接的区别）；
// ⚠️ 全部同一个 H；只有 L 单调下降（背光压暗）、末端 S 略提（暗面在深水里发闷）。
// 渐变**圆心的偏移**（把第一段摆在左上）是 drawImage 时的几何，桩看不见，进手工清单。
export function peltStopsFor(hue, sat, lum) {
  const s = clamp01(sat);
  const l = clamp01(lum);
  const litL = Math.min(1, l + R.peltLitBoost);
  const darkL = Math.max(0, l - R.peltDarkCut);
  const midL = (litL + darkL) / 2;
  const rimL = Math.max(0, darkL - 0.06);                  // 边缘再压一档：轮廓才立得住
  return [
    { at: 0, color: hsla(hue, s, litL, 1) },
    { at: 0.45, color: hsla(hue, s, midL, 1) },
    { at: 0.80, color: hsla(hue, s, darkL, 1) },
    { at: 1, color: hsla(hue, Math.min(1, s + R.peltSatLift), rimL, 1) },
  ];
}

// 第 3 层：花纹颜色 = 同色相上暗一档（"绣在毛里"的线迹）。
// 透明度**不在这里**（不许在 fillStyle 里再乘一次，那会和 globalAlpha 相乘成几乎看不见），
// 由 patternAlphaFor 单独走 globalAlpha。
export function patternColorFor(hue, sat, lum) {
  return hsla(hue, Math.min(1, clamp01(sat) + 0.18), Math.max(0, clamp01(lum) - 0.24), 1);
}

// 第 3 层的 alpha。'none' 给 0 意味着**那一层整个跳过**（不是画一张全透明的图案），
// 所以桩能数出 globalAlpha 写入次数少一次 —— 这是"四型花纹里 none 真的是 none"的机器证据。
export function patternAlphaFor(pattern) {
  if (!pattern || pattern === 'none') return 0;
  return R.patternAlpha;
}

// 第 2 层的整体 alpha：恒为 1，而且**必须**是 1。
// 为什么单独写成一个函数而不是在赋值处写死 `globalAlpha = 1`：桩 ctx 不记参数，
// 所以"本体不透明"这条 spec §5.1 第 1 处改动**只有**在纯函数这一侧才可能被自动化守住
// —— tests/render-body.test.js 断言它对任何一只个体都返回 1。
// 它同时是 B16 的挂载点：sick 变暗与死亡溶散的 dim 系数要乘在这里（以及最外层的 save 里），
// 而不是乘在 sprite 的色标 alpha 上（那些 alpha 是"毛绒不透明"这件事本身的证据）。
export function peltAlphaFor() {
  return 1;
}

// 第 1 层：光晕 alpha = traits.glow × 系数。
// 脏值给 0（不是 NaN）：NaN 的 globalAlpha 在 Canvas 里是**忽略赋值**，
// 症状是这只生物顶着上一只的亮度，而不是消失，极难归因。
export function glowAlphaFor(traitGlow) {
  if (!Number.isFinite(traitGlow)) return 0;
  return Math.min(1, Math.max(0, traitGlow) * R.glowAlphaFactor);
}

// 第 4 层：体内亮区的 alpha = glow 基线 × 情绪系数（spec §5.1 第 4 层逐字的脉动节奏）。
// glow ∈ [0.35,1]（spec §4.1 那条下限 0.35 的推理仍然成立），归一化后拉成 0.55–1.0 的基线，
// 呼吸项用 breathe（= 1 + body.pulse·sin(body.phase·TAU)）× innerPulse 调制。
export function innerAlphaFor(traitGlow, breathe) {
  const g = Number.isFinite(traitGlow) ? clamp01((traitGlow - 0.35) / 0.65) : 0;
  const b = Number.isFinite(breathe) ? Math.min(1.5, Math.max(0.5, breathe)) : 1;
  return Math.min(1, R.innerAlpha * (0.55 + 0.45 * g) * (1 + R.innerPulse * (b - 1)));
}

// 第 4 层的半径：**一片**而不是一颗（旧 coreRadiusFactor 0.30 由 CONFIG 的那条不等式盯着）。
export function innerRadiusFor(r, breathe) {
  const b = Number.isFinite(breathe) ? Math.min(1.5, Math.max(0.5, breathe)) : 1;
  return r * R.innerRadiusFactor * b;
}

// 呼吸系数：只读 body.js 的 phase/pulse。⚠️ 表现层**不许**用自己的时钟（renderer.time）
// 当脉动相位 —— 旧计划 Task 7 在求偶相位上栽过一次，这次换成呼吸也一样：两套时钟必然漂移。
export function breatheOf(body) {
  const ph = Number.isFinite(body.phase) ? body.phase : 0;
  const pu = Number.isFinite(body.pulse) ? body.pulse : 0;
  return 1 + pu * Math.sin(ph * TAU);
}

// 第 5 层：尾巴在屏幕空间的"高举"量。
// body.js 的局部空间**没有上下**（文件头那条 ⚠️ 明说"屏幕上的朝上由 B14 在旋转之后决定"），
// 所以 spec §4.7.1 表里"竖直高举 / 垂着不动"落到这里 = 摆幅越大举得越高、
// fear 夹起来（tuck→0）时跟着缩、伤心（amp=0）时为 0。
export function tailLiftPx(body, r) {
  const tail = body.tail;
  const amp = Number.isFinite(tail.amp) ? Math.max(0, tail.amp) : 0;
  const tuck = Number.isFinite(tail.tuck) ? clamp01(tail.tuck) : 1;
  return R.tailLiftFactor * r * amp * tuck;
}

// 第 7 层：碎边的外缘半径。毛长 = CONFIG.fluff.lenRatio × 身体半径 × fluff 表现型（spec §4.7），
// 而那个乘积已经由 body.js 算进 body.fluffLen，这里只做单位换算，不再乘第二次。
export function fluffOuterRadius(r, fluffLen) {
  const len = Number.isFinite(fluffLen) ? Math.max(0, fluffLen) : 0;
  return r * (1 + Math.min(CONFIG.fluff.lenRatio, len));
}

// 碎边的内缘半径。⚠️ 它**必须**始终 ≤ 身体轮廓 r：
// spec §4.7 明说"毛如果独立于身体动，视觉上就变成一圈光晕，那正是 §4.3 已有的东西，
// 等于白画一层"。内缘越过轮廓 = 毛与身体之间露出一条水 = 就是那个光晕。
// 毛长为 0 时碎边完全落在轮廓之内（一圈绒面），毛长打满（= lenRatio）时内缘恰好等于 r。
export function fluffInnerRadius(r, fluffLen) {
  return fluffOuterRadius(r, fluffLen) / (1 + CONFIG.fluff.lenRatio);
}

// 本体 sprite 的键 = 色相桶 × 饱和度档 × 明度档（整数键，字符串拼接是分配，索引不是）。
// 4 档而不是 8 档：sat 的实际域是 [0.45,0.95]、lum 是 [0.62,0.84]（genes.decode 定的），
// 4 档已经把两只同 hue 不同 lum 的孩子分开了，8 档只会把 sprite 数翻倍而看不出来。
const PELT_TIERS = 4;
const tierOf = (v) => {
  const k = Math.floor(clamp01(v) * PELT_TIERS);
  return k >= PELT_TIERS ? PELT_TIERS - 1 : k;
};
const tierMid = (k) => (k + 0.5) / PELT_TIERS;

export function peltKey(hue, sat, lum) {
  return hueBucket(hue, CONFIG.glowHueBuckets) * (PELT_TIERS * PELT_TIERS)
    + tierOf(sat) * PELT_TIERS + tierOf(lum);
}

// ---------------------------------------------------------------- 身体轮廓
//
// 把局部单位空间（body.js 的坐标系，身体半径恒为 1）的点变换到屏幕。
// ⚠️ 不需要 atan2：c.facing 已经是单位向量（sim.js 插值后重新归一化过），
// cos(θ) 就是 facing.x、sin(θ) 就是 facing.y，直接拿来用。
// 顺带在同一次遍历里量出当前 squash（毛边与体内亮区都要用它，spec §4.7"毛必须跟着形变走"）。
export function writeBodyScreen(renderer, body, cx, cy, r, facing) {
  const ca = facing.x, sa = facing.y;
  const pts = body.points;
  const sx = renderer.sx, sy = renderer.sy;
  let along = 0, perp = 0, restAlong = 0, restPerp = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const la = p.x * ca - p.y * sa;
    const lp = p.x * sa + p.y * ca;
    sx[i] = cx + la * r;
    sy[i] = cy + lp * r;
    const ra = p.rx * ca - p.ry * sa;
    const rp = p.rx * sa + p.ry * ca;
    const aa = Math.abs(la), ap = Math.abs(lp), ar = Math.abs(ra), arp = Math.abs(rp);
    if (aa > along) along = aa;
    if (ap > perp) perp = ap;
    if (ar > restAlong) restAlong = ar;
    if (arp > restPerp) restPerp = arp;
  }
  renderer.squashAlong = squashRatio(along, restAlong);
  renderer.squashPerp = squashRatio(perp, restPerp);
}

// 夹到 [0.2, 3]：负半径或 0 半径会让 drawImage 退化（spec §5.1 那条"不塌到 0"同理），
// 而脏存档给出的 NaN 也必须在这里被吃掉，不许传染到矩阵。
const squashRatio = (now, rest) => {
  if (!(rest > 0) || !Number.isFinite(now)) return 1;
  const q = now / rest;
  return q < 0.2 ? 0.2 : q > 3 ? 3 : q;
};

// Catmull-Rom 平滑闭合曲线 → 三次贝塞尔。每点一段 ⇒ 每只每帧恰好 CONFIG.bodyPoints 段。
// ⚠️ 这是主 ctx 上**唯一**一处贝塞尔来源。毛不走路径（spec §4.7），
// 所以"每帧贝塞尔段数 = 只数 × bodyPoints"是一条能被断言的上界。
// 换算公式（p0→p3 四个控制点，画 p1→p2 那一段）：c1 = p1 + (p2−p0)/6、c2 = p2 − (p3−p1)/6，
// 除以 6 是 Catmull-Rom（张力 0）到贝塞尔的标准换算，不是调出来的经验值。
// 直接用 lineTo 连 24 个点会得到一个明显的二十四边形（50px 半径上每条边约 13px，棱角肉眼可见）。
export function buildBodyPath(ctx, renderer, c, body, cx, cy, r) {
  writeBodyScreen(renderer, body, cx, cy, r, c.facing);
  const sx = renderer.sx, sy = renderer.sy;
  const n = sx.length;
  ctx.beginPath();
  ctx.moveTo(sx[0], sy[0]);
  for (let i = 0; i < n; i++) {
    const p0x = sx[(i - 1 + n) % n], p0y = sy[(i - 1 + n) % n];
    const p1x = sx[i], p1y = sy[i];
    const p2x = sx[(i + 1) % n], p2y = sy[(i + 1) % n];
    const p3x = sx[(i + 2) % n], p3y = sy[(i + 2) % n];
    ctx.bezierCurveTo(
      p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6,
      p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6,
      p2x, p2y,
    );
  }
  ctx.closePath();
}

// ---------------------------------------------------------------- sprite 查表

export function getGlowSprite(renderer, hue) {
  return renderer.glow[hueBucket(hue, CONFIG.glowHueBuckets)];
}

// 两张碎边 sprite：选哪一张由 body.js 算好的 body.fluffSprite 决定（anger ⇒ 炸开）。
// 本文件**不再自己判情绪**，否则情绪→表现的那张表会有两份。
export function getFluffSprite(renderer, index) {
  const k = Number.isFinite(index) ? Math.min(renderer.fluff.length - 1, Math.max(0, index | 0)) : 0;
  return renderer.fluff[k];
}

// ---------------------------------------------------------------- 情绪 → 亮区颜色

// 情绪色查色表。⚠️ 只能**取**既有字符串，不能**算**新字符串：spec §5.3 禁止运行时分配，
// 每帧拼一个 hsl(...) 就是 24×60 = 1440 次/秒的分配。
// angry / pale / drowsy 这三个颜色在内核里没有任何消费者 —— 它们是计划 1 为表现层预留的，
// 用它们不是巧合，是兑现那份预留。
const CORE_COLORS = {
  joy: CONFIG.colors.sakura,        // #FFC8DE 樱花粉：开心是最亮最浅的粉
  anger: CONFIG.colors.angry,       // #FF1F6B 玫红偏红：唯一离开粉色区的颜色，故意刺眼
  fear: CONFIG.colors.pale,         // #D8C4CC 灰粉：血色褪去
  curiosity: CONFIG.colors.peach,   // #FF9EB5 桃粉
  sleepy: CONFIG.colors.drowsy,     // #8E6A8C 暗紫粉：光在熄灭
  arousal: CONFIG.colors.rose,      // #FF4D8D 玫红
};
const CORE_NEUTRAL = CONFIG.colors.orchid;   // #E8A7D8 淡粉紫（dominant 返回 null 时）
const EMPTY_EMOTIONS = {};

export function coreColorFor(emotions) {
  // dominant() 是内核导出的权威判定。⚠️ 不得在这里自己写一遍 argmax：
  // 那会与内核漂移，而漂移的症状是"亮区的颜色和它的行为对不上"，极难归因。
  const key = dominant(emotions || EMPTY_EMOTIONS);
  return Object.hasOwn(CORE_COLORS, key) ? CORE_COLORS[key] : CORE_NEUTRAL;
}

// ---------------------------------------------------------------- 分层绘制（第 1/2/3/4/5/7 层）
//
// 每层的贴图/路径账单（spec §5.3 那张表 + 本文件的三条上界断言）：
//   第 1 层 光晕      1 次 drawImage + 1 次 globalCompositeOperation
//   第 2 层 本体      1 条闭合路径（24 段贝塞尔）+ 1 次 clip + 1 次 drawImage + globalAlpha=1
//   第 3 层 花纹      若干 arc/ellipse + fill/stroke，1 次 globalAlpha（none ⇒ 整层跳过）
//   第 4 层 体内亮区  1 次 setTransform + 1 次 drawImage + 1 次 globalCompositeOperation
//   第 5 层 尾巴      CONFIG.tail.segs = 3 次 drawImage（**段数不随体型变**）
//   第 7 层 毛尖碎边  1 次 setTransform + 1 次 drawImage + 1 次 globalCompositeOperation
// 合计每只 7 次 drawImage、24 段贝塞尔 —— 这两个常数就是性能判据的全部。

function drawGlowLayer(ctx, renderer, c, r, cx, cy, breathe) {
  const sprite = getGlowSprite(renderer, c.traits.hue);
  const gr = r * R.glowRadiusFactor * breathe;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = glowAlphaFor(c.traits.glow);
  ctx.drawImage(sprite.surface, cx - gr, cy - gr, gr * 2, gr * 2);
  ctx.restore();
}

// 第 2–4 层共用一个 clip 括号。
// 必须 clip：本体是一张**圆形** sprite，而身体是会形变的 24 点五角星软体。
// 不裁的话挤压、碰撞凹陷、生气时前端变尖在画面上完全看不出来（spec §5.1 整个软体模型白做）。
function drawBodyLayers(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr) {
  const t = c.traits;
  const pelt = renderer.getPeltSprite(t.hue, t.sat, t.lum);
  ctx.save();
  buildBodyPath(ctx, renderer, c, body, cx, cy, r);
  ctx.clip();
  ctx.globalAlpha = peltAlphaFor();         // 不透明：毛绒与凝胶最直接的区别（改动 #1）
  ctx.drawImage(pelt.surface, cx - r, cy - r, r * 2, r * 2);
  drawPatternLayer(ctx, c, pelt, cx, cy, r);
  drawInnerLightLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr);
  ctx.restore();
}

// 花纹四型（genes.PATTERNS 的 1–4：圆斑 / 环纹 / 云斑 / 星点）。
// ⚠️ 位置必须由 i/n 的**确定性函数**给出，绝不能用 rng：本层每帧都跑，
// 取随机数除了让花纹每帧重排（看起来在沸腾），还会消耗 world.rng 的序列
// ⇒ 同一个种子在开了渲染和没开渲染时跑出**不同的缸**。
// 这是表现层污染逻辑层的经典事故，由 tests/render-body.test.js 的"绘制一帧不向 rng 取数"守住。
const PATTERN_SPOTS = 6, PATTERN_RINGS = 3, PATTERN_CLOUDS = 4, PATTERN_STARS = 9;

function drawPatternLayer(ctx, c, pelt, cx, cy, r) {
  const t = c.traits;
  const alpha = patternAlphaFor(t.pattern);
  if (alpha <= 0) return;                    // none ⇒ 这一层整个不存在
  const density = 0.4 + 0.6 * clamp01(t.patternDensity);
  const mark = r * R.patternMarkFactor * density;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pelt.patternColor;         // 建 sprite 时算好的字符串，运行时零分配
  if (t.pattern === 'spots') {
    for (let i = 0; i < PATTERN_SPOTS; i++) {
      const a = (i / PATTERN_SPOTS) * TAU + 0.4;
      const rr = r * (0.30 + 0.28 * (((i * 37) % 11) / 11));
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mark, 0, TAU);
      ctx.fill();
    }
  } else if (t.pattern === 'rings') {
    ctx.lineWidth = Math.max(1, mark * 0.55);
    ctx.strokeStyle = pelt.patternColor;
    for (let i = 1; i <= PATTERN_RINGS; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * (0.28 * i + 0.08), 0, TAU);
      ctx.stroke();
    }
  } else if (t.pattern === 'clouds') {
    for (let i = 0; i < PATTERN_CLOUDS; i++) {
      const a = (i / PATTERN_CLOUDS) * TAU + 0.9;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * r * 0.36, cy + Math.sin(a) * r * 0.36,
        mark * 1.9, mark * 1.3, a, 0, TAU);
      ctx.fill();
    }
  } else {                                  // 'stars'：小而多
    for (let i = 0; i < PATTERN_STARS; i++) {
      const a = (i / PATTERN_STARS) * TAU * 2.3;   // 无理数倍角 ⇒ 不排成整齐一圈
      const rr = r * (0.18 + 0.55 * (((i * 53) % 13) / 13));
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, mark * 0.5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 第 4 层：透过毛看到的一片柔和亮区（旧"发光核"）。位置仍在体心。
// 用 setTransform 而不是 rotate + scale：facing 已经是单位向量，所以省掉一次 atan2，
// 而"沿朝向略拉长"这件事照做（squash 也一起进来，亮区跟着身体被挤压）。
// ⚠️ setTransform 是**替换**当前矩阵，不是叠加 —— main.js 每帧先 setTransform(dpr,…) 与
// drawCreature 自己的 clip 都在这个括号里。两件事都要知道：
//   · 不带 dpr ⇒ HiDPI 屏上亮区画到 1/dpr 的位置去（CSS 像素 vs 设备像素），桩看不见；
//   · clip 是在**设备空间**生效的，换 CTM 不会让它失效 —— 这正是"亮区被轮廓裁住、
//     读起来像毛里面的光而不是水里的光"的原因。
// 这条坑在桩里看不见（桩不记参数），但它是真实存在的错位，所以显式写出来。
function drawInnerLightLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr) {
  const sprite = renderer.getCoreSprite(coreColorFor(c.emotions));
  const cr = innerRadiusFor(r, breathe);
  const ax = cr * renderer.squashAlong * dpr;
  const ay = cr * renderer.squashPerp * dpr;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = innerAlphaFor(c.traits.glow, breathe);
  ctx.setTransform(ca * ax, sa * ax, -sa * ay, ca * ay, cx * dpr, cy * dpr);
  ctx.drawImage(sprite.surface, -1, -1, 2, 2);
  ctx.restore();
}

// 第 5 层：3 段链（spec §4.7.1）。贴图次数 = CONFIG.tail.segs，**不随体型增长**（spec §5.3）。
// 每段用本体的光晕 sprite（同一色相的柔和团）软描，根粗尖细。
const TAIL_ALPHA = 0.92;

function drawTailLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, viewport) {
  const nodes = body.tail.nodes;
  const n = nodes.length;
  if (n === 0) return;
  const sprite = getGlowSprite(renderer, c.traits.hue);
  const lift = tailLiftPx(body, r);
  const segPx = (body.tailWorldLen * viewport.scale * 0.5) / n;
  ctx.save();
  ctx.globalAlpha = TAIL_ALPHA;
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    const nx = cx + (nd.x * ca - nd.y * sa) * r;
    // 举高沿链递增（根部贴在身上，尖端抬起来）；spec 表里"竖直高举"的那一半
    const ny = cy + (nd.x * sa + nd.y * ca) * r - lift * ((i + 1) / n);
    const rr = segPx * R.tailSegFactor * (1 - R.tailTaper * i);
    ctx.drawImage(sprite.surface, nx - rr, ny - rr, rr * 2, rr * 2);
  }
  ctx.restore();
}

// 第 7 层：毛尖碎边。⚠️ 只此一次贴图 + 一次矩阵，**不重算毛的位置**（spec §4.7）。
// sprite 里的星形轮廓与身体静止轮廓同源于 body.js 的 starRadius，所以五个角对得上；
// 当前这帧的 squash 由 writeBodyScreen 量出来写进矩阵 —— 毛跟着身体一起被压扁，
// 而不是独立动（独立动就退化成 §4.3 已有的那圈光晕，等于白画一层）。
// 缩放推导：贴图里毛尖落在 unit×(1+lenRatio)，屏幕上要落在 r×(1+fluffLen)，
// 所以比例 s = r(1+fluffLen) / (unit(1+lenRatio))；于是碎边**内缘**在屏幕上等于
// fluffInnerRadius(r, fluffLen) ≤ r —— 内缘不许越过轮廓，否则就是那条光晕。
function drawFluffLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, dpr) {
  const sprite = getFluffSprite(renderer, body.fluffSprite);
  const s = fluffOuterRadius(r, body.fluffLen) / (sprite.unit * (1 + CONFIG.fluff.lenRatio));
  const ax = s * renderer.squashAlong * dpr;
  const ay = s * renderer.squashPerp * dpr;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;                    // 碎边的强度已经烧在 sprite 的 stroke alpha 里
  ctx.setTransform(ca * ax, sa * ax, -sa * ay, ca * ay, cx * dpr, cy * dpr);
  ctx.drawImage(sprite.surface, -sprite.half, -sprite.half, sprite.size, sprite.size);
  ctx.restore();
}

// ---------------------------------------------------------------- 第 6 层：眼睛 → 腮红
//
// spec §5.1 的层序是 5 尾巴 → **6 眼睛/腮红** → 7 毛尖碎边，所以这一层接在尾巴之后、
// 碎边之前，而且和尾巴一样在 clip **之外**：眼睛要能压在轮廓边缘上（星形两个角之间），
// 被轮廓裁掉一半就没人看得出它往哪儿看。
//
// ⚠️ 这一层的账单是**零 drawImage、零 clip、零 globalCompositeOperation、零新建 sprite**，
// 眼睛与腮红全走路径（每只固定 3 条眼路径 + 1 条腮红路径）。不是偷懒：
// B14 那三条"每只恰好 7 次贴图 / 每只只裁一次 / 混合模式写 3 次"的精确账单是
// spec §5.3 的机器证据，眼睛顺手加一张眼白 sprite 或一次 clip 就要改那三条守卫，
// 而"改了守卫"与"守住了约束"是两件事。眼白用扁平填充（不带渐变）正是这个决定的代价与取舍。
//
// ⚠️ 四参数与十行表的**全部计算**在 src/eyes.js（纯函数）。本文件只把它们画出来。
// 桩 ctx 记不到像素，所以"眯弧弯得够不够""星星眼像不像一只星""含泪高光看不看得见"
// 都在手工清单里；这里能断言的只有路径/贴图/深度的形状与次数。

const LID_OPEN_EPS = 0.02;      // 开合低于这个值就当闭着（整层跳过，省掉四条路径）
const LID_LINE_ALPHA = 0.5;     // 眼睑线的透明度：要读得出"有一条眼皮"，不能读成第二条瞳孔
const Pupil_SQUASH = 1;         // 瞳孔竖直半径与睁开高度的比例上限（不用 clip，靠几何裁）
const BLUSH_RIPPLE = 0.62;      // 腮红椭圆的高宽比（横着摊开的一团，不是圆点）

// 四角星的单位顶点（建模块时算一次，运行时只做旋转与缩放 ⇒ 每帧零三角函数分配）。
// 角数唯一来源是 CONFIG.eye.starPoints（spec §4.6 逐字"四角星"）。
const STAR_INNER = 0.38;        // 星的内尖半径 / 外尖半径（0.38 是"星"而不是"十字"的那个度）
const STAR_V = (() => {
  const n = CONFIG.eye.starPoints * 2;
  const out = new Float64Array(n * 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU - Math.PI / 2;      // -90° 起笔：第一个尖朝上
    const rad = (k % 2) === 0 ? 1 : STAR_INNER;
    out[k * 2] = Math.cos(a) * rad;
    out[k * 2 + 1] = Math.sin(a) * rad;
  }
  return out;
})();

// 玩家的手在这只生物**局部空间**的单位方向（x 沿 facing，y 沿垂直方向）。
// 只在手存在且近到 CONFIG.eye.handNearRadius 以内时才有值。
// ⚠️ 这是只读 world.playerHand；本函数**不写**世界状态（spec §4.6 末段那句
// "facing 会缓慢转向它"做不到，原因见 eyes.js 文件头的同一条 ⚠️）。
function fillHandOpts(renderer, c, ca, sa) {
  const opts = renderer.eyeOpts;
  const vec = renderer.handLocalVec;
  vec.x = 0;
  vec.y = 0;
  opts.handLocal = null;
  const hand = renderer.hand;
  if (hand && hand.pos) {
    const dx = hand.pos.x - c.pos.x;
    const dy = hand.pos.y - c.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0 && dist <= CONFIG.eye.handNearRadius) {
      vec.x = (dx * ca + dy * sa) / dist;
      vec.y = (dx * -sa + dy * ca) / dist;
      opts.handLocal = vec;
    }
  }
  return opts;
}

// 星形瞳孔：moveTo + (2×starPoints − 1) 次 lineTo + closePath。
// lineTo 的次数是**可测的**（tests/render-body.test.js 数得到），所以"四角"这件事
// 在自动化里留了一半证据；剩下那一半（它看起来像不像一只星）进手工清单。
function traceStarPupil(ctx, ex, ey, radius, spin) {
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const n = STAR_V.length / 2;
  for (let k = 0; k < n; k++) {
    const ux = STAR_V[k * 2];
    const uy = STAR_V[k * 2 + 1];
    const x = ex + (ux * cs - uy * sn) * radius;
    const y = ey + (ux * sn + uy * cs) * radius;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawEyeLayer(ctx, renderer, c, cx, cy, r, ca, sa) {
  const p = eyeParamsInto(renderer.eyeCache, c, renderer.time, fillHandOpts(renderer, c, ca, sa));
  renderer.eyeFacing.x = ca;
  renderer.eyeFacing.y = sa;
  const a = eyeAnchorsInto(renderer.eyeAnchor, p, r, renderer.eyeFacing);
  const blush = blushFor(c);
  const eyeR = a.eyeR;
  const openL = clamp01(p.lidOpenL - p.blink);
  const openR = clamp01(p.lidOpenR - p.blink);

  ctx.save();
  if (openL > LID_OPEN_EPS || openR > LID_OPEN_EPS) {
    // ---- 每只眼睛的几何：名义睁开半径 oR，被上眼睑压低 press、被下眼睑上抬 lift 各切一刀
    // （裁定 2 的两半就落在 press 与 lift 上：anger 只有 press，委屈只有 lift，害怕两个都是 0）
    const geom = renderer.eyeGeom;
    for (let i = 0; i < 2; i++) {
      const open = i === 0 ? openL : openR;
      const ex = i === 0 ? cx + a.lx : cx + a.rx;
      const ey = i === 0 ? cy + a.ly : cy + a.ry;
      const oR = eyeR * open;
      const top = -oR + eyeR * p.topLidPress;
      const bot = oR - eyeR * p.lowerLidRaise * Pupil_SQUASH;
      geom[i * 2] = ex;
      geom[i * 2 + 1] = ey + (top + bot) / 2;
      geom[4 + i * 2] = eyeR;                             // 水平半径
      geom[4 + i * 2 + 1] = Math.max(0, (bot - top) / 2); // 竖直半径（眼睛的真实开合）
    }

    // 1) 眼白：一条路径画两只（扁平时读作"眯着"，不靠 clip）
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = eyeWhiteColor();
    ctx.beginPath();
    ctx.ellipse(geom[0], geom[1], geom[4], geom[5], 0, 0, TAU);
    ctx.ellipse(geom[2], geom[3], geom[6], geom[7], 0, 0, TAU);
    ctx.fill();

    // 2) 瞳孔：幸福那一格画四角星，其余画椭圆。颜色只能来自 CONFIG.colors.pupil（#2D1240）。
    ctx.globalAlpha = 1;
    ctx.fillStyle = pupilColor();
    ctx.beginPath();
    for (let i = 0; i < 2; i++) {
      const pr = p.pupilSize * eyeR;
      const hh = geom[4 + i * 2 + 1];
      if (p.star > 0) {
        traceStarPupil(ctx, geom[i * 2], geom[i * 2 + 1], Math.min(pr * p.starScale, hh), p.starSpin);
      } else {
        ctx.ellipse(geom[i * 2], geom[i * 2 + 1], Math.min(pr, geom[4 + i * 2]),
          Math.min(pr, hh), 0, 0, TAU);
      }
    }
    ctx.fill();

    // 3) 瞳孔高光：常态在左上，委屈那一格被 highlightY 推到**下缘**（含泪感）。
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = eyeHighlightColor();
    ctx.beginPath();
    for (let i = 0; i < 2; i++) {
      const pr = p.pupilSize * eyeR;
      const hr = Math.max(0.6, pr * CONFIG.eye.highlightRadius);
      ctx.arc(geom[i * 2] + p.highlightX * pr, geom[i * 2 + 1] + p.highlightY * pr, hr, 0, TAU);
    }
    ctx.fill();

    // 4) 眼睑线：^^ 那一格画一道**上弯**的弧（圆心在眼睛下方），其余画上缘的一条浅弧。
    //    不用 quadraticCurveTo —— spec §5.3 与 B14 那条"贝塞尔段数只等于身体轮廓"的判据
    //    靠的是"毛一段都不走路径"，眼睛如果也去抢贝塞尔预算，那条断言就失去意义了。
    ctx.globalAlpha = LID_LINE_ALPHA;
    ctx.strokeStyle = pupilColor();
    ctx.lineWidth = Math.max(0.7, eyeR * 0.14);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const squinting = p.squintArc > 0.35;
    for (let i = 0; i < 2; i++) {
      const ex = geom[i * 2];
      const ey = geom[i * 2 + 1];
      if (squinting) {
        const rr = eyeR * (1 + p.squintArc * 0.6);
        ctx.arc(ex, ey + rr * 0.75, rr, Math.PI * 1.18, Math.PI * 1.82);
      } else {
        const h = Math.max(0.5, geom[4 + i * 2 + 1]);
        ctx.arc(ex, ey, h * 1.05, Math.PI * 1.08, Math.PI * 1.92);
      }
    }
    ctx.stroke();
  }
  ctx.restore();

  drawBlushLayer(ctx, renderer, c, blush, cx, cy, r, ca, sa);
}

// 腮红（spec §5.1 第 6 层的后半格；§4.5 的"卖萌"行要"腮红泛开"）。
// 位置在身体框架内沿 facing 略后、沿垂直方向左右各一团，再往屏幕下方压一点 ——
// 脸颊跟着身体转，但"红在眼睛下面"这件事不跟着转。
function drawBlushLayer(ctx, renderer, c, blush, cx, cy, r, ca, sa) {
  if (!(blush.alpha > 0)) return;
  const d = r * 2;
  const px = -sa;
  const py = ca;
  const bx = cx + ca * d * CONFIG.eye.blushAlong;
  const by = cy + sa * d * CONFIG.eye.blushAlong + d * CONFIG.eye.blushOffsetY * 0.5;
  const sep = d * blush.offsetPerp;
  const rr = d * blush.radius;
  ctx.save();
  ctx.globalAlpha = blush.alpha;
  ctx.fillStyle = blushColor();
  ctx.beginPath();
  ctx.ellipse(bx + px * sep, by + py * sep, rr, rr * BLUSH_RIPPLE, 0, 0, TAU);
  ctx.ellipse(bx - px * sep, by - py * sep, rr, rr * BLUSH_RIPPLE, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function drawCreature(ctx, renderer, c, body, viewport) {
  const cx = screenX(c.pos.x, viewport);
  const cy = screenY(c.pos.y, viewport);
  const r = radiusPx(c, viewport);
  // 太小不值得画；同时挡住 NaN（NaN > 0.5 为 false）与脏存档给出的非有限坐标
  if (!(r > 0.5) || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const facing = c.facing;
  const ca = Number.isFinite(facing.x) ? facing.x : 1;
  const sa = Number.isFinite(facing.y) ? facing.y : 0;
  const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
  const breathe = breatheOf(body);
  // 外层括号：B16 的 sick 变暗与死亡溶散 alpha 会乘在这一层
  ctx.save();
  drawGlowLayer(ctx, renderer, c, r, cx, cy, breathe);
  drawBodyLayers(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr);
  drawTailLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, viewport);
  drawEyeLayer(ctx, renderer, c, cx, cy, r, ca, sa);       // 第 6 层（B15）
  drawFluffLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, dpr);
  ctx.restore();
}

// ---------------------------------------------------------------- sprite 预渲染
//
// 这些函数只在 createRenderer 与首次命中缓存时被调用，**绝不在 draw 里调用**。
// tests/render-body.test.js 用注入的 makeCanvas 计数器守住"稳态 100 帧零新建"。

function buildGlowSprites(renderer) {
  const N = CONFIG.glowHueBuckets;
  const size = R.glowSpriteSize;
  renderer.glow.length = 0;
  for (let b = 0; b < N; b++) {
    const h = bucketHue(b, N);
    const made = renderer.makeCanvas(size, size);
    const g = made.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // 中心亮、边缘透明。sat/lum 取 decode 的中值：把两者也纳入分桶会让 sprite 从 32 爆到
    // 32×4×4，而光晕是模糊的大光斑，饱和度差异在这个尺度上看不出来。
    g.addColorStop(0, hsla(h, 0.70, 0.73, 0.95));
    g.addColorStop(0.25, hsla(h, 0.70, 0.70, 0.45));
    g.addColorStop(0.6, hsla(h, 0.70, 0.62, 0.12));
    g.addColorStop(1, hsla(h, 0.70, 0.60, 0));
    made.ctx.fillStyle = g;
    made.ctx.fillRect(0, 0, size, size);
    renderer.glow.push({ ctx: made.ctx, surface: made.surface, size });
  }
}

function buildPeltSprite(renderer, key) {
  const size = R.peltSpriteSize;
  // 桶号/档号**反推**回颜色：sprite 是按档预渲染的，所以同档内个体的 sat/lum 会被归到档中点
  // （hue 不受这个近似影响，它是分桶的主维度）。这是"预渲染换零分配"这笔交易里付掉的一项：
  // 不付的话每帧要 24 次 createRadialGradient（spec §5.3 明令禁止）。
  // 残余的同档内差异由第 3 层花纹与第 7 层碎边的亮度承担；观感进 B20 手工清单。
  const h = bucketHue(Math.floor(key / (PELT_TIERS * PELT_TIERS)), CONFIG.glowHueBuckets);
  const rest = key % (PELT_TIERS * PELT_TIERS);
  const s = tierMid(Math.floor(rest / PELT_TIERS));
  const l = tierMid(rest % PELT_TIERS);
  const made = renderer.makeCanvas(size, size);
  const g = made.ctx.createRadialGradient(
    size * 0.42, size * 0.38, size * 0.05,      // 圆心偏左上：光源在左上（朝向本身桩看不见，进手工清单）
    size * 0.5, size * 0.5, size * 0.5,
  );
  // alpha 全 1：不透明填充。这里的 alpha 只负责**明度分布**，整体透明度由 globalAlpha 施加。
  const stops = peltStopsFor(h, s, l);
  for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i].at, stops[i].color);
  made.ctx.fillStyle = g;
  made.ctx.fillRect(0, 0, size, size);
  return { ctx: made.ctx, surface: made.surface, size, key, patternColor: patternColorFor(h, s, l) };
}

function buildCoreSprite(renderer, color) {
  const size = 64;
  const made = renderer.makeCanvas(size, size);
  const g = made.ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // 中心白 → 情绪色 → 全透。⚠️ 边缘是**透明**而不是清晰截止：
  // 旧"发光核"那版中心白直接压 0.35 的情绪色，边界读起来就是一颗椭圆；
  // 现在要"透过毛看到的一片"，所以情绪色一直铺到 0.70、最后 30% 才淡到全透。
  // ⚠️ 这里的 '#FFFFFF' 与 'rgba(255,255,255,0)' 是**白**，不是体色：
  // 亮区读起来是"毛里面有光"而不是"这只颜色更亮"，靠的是白心 + 情绪色外圈这个层次。
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.30, color);
  g.addColorStop(0.70, color);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  made.ctx.fillStyle = g;
  made.ctx.fillRect(0, 0, size, size);
  return { ctx: made.ctx, surface: made.surface, size };
}

// 两张毛尖碎边：0 = 常态，1 = 炸开（spec §11 FLUFF_SPRITES = 2）。
// ⚠️ 一次性在这里画够（约 120 根短划，靠注入的 rng 抖），换来运行时的**每只一次贴图**。
// 每帧画这些短划 = 24 只 × 120 段 = 2880 段贝塞尔/帧，spec §4.7 称它"性能上的生死线"。
// 碎边的颜色是**浅粉白**（与 CONFIG.colors.mote 同一个 rgb，从它推导而不是再抄一份字面量），
// 不是体色：半透明的浅粉白叠在任何体色上都成立，于是毛边不需要按色相分档
// —— 这正是那条裁定换来的便宜（按"每根毛有自己的颜色"要做 32 色相桶 × 8 蓬松档 = 256 张）。
const FLUFF_RGB = (() => {
  const n = parseInt(CONFIG.colors.mote.slice(1), 16);
  return [String((n >> 16) & 255), String((n >> 8) & 255), String(n & 255)];
})();
const FLUFF_TIPS = 120;

function buildFluffSprites(renderer) {
  const size = R.fluffSpriteSize;
  const half = size / 2;
  // sprite 里的星形轮廓半径 unit：毛尖（unit × (1 + lenRatio)）恰好落在贴图边缘 half。
  // 于是绘制时把 outer = r(1+fluffLen) 映射到 half 附近，碎边就正好伸出 body.js 给的那个毛长。
  const unit = half / (1 + CONFIG.fluff.lenRatio);
  renderer.fluff.length = 0;
  for (let k = 0; k < CONFIG.fluff.sprites; k++) {
    const made = renderer.makeCanvas(size, size);
    const sctx = made.ctx;
    const burst = k === CONFIG.fluff.sprites - 1;    // 最后一档 = 炸开（anger）
    // ⚠️ 两档**共用同一个几何**（毛尖恰好落在贴图边缘）：炸开不是更长，而是更粗、更亮、
    // 更散、根部探得更深。要是把 tipR 也乘一个增益，毛尖会捅出贴图被裁掉一截，
    // 而运行时又按同一个 unit 反算缩放 —— 症状是"炸开时碎边凭空缺一圈"。
    const jit = burst ? 0.055 : 0.025;
    const dig = burst ? 0.70 : 0.82;                // 根部探进轮廓之内的比例
    sctx.lineCap = 'round';
    sctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < FLUFF_TIPS; i++) {
      const a = (i / FLUFF_TIPS) * TAU;
      const edge = starRadius(a);                    // 与 body.js 同源：五个角与内凹都贴得住
      const wobble = (renderer.rng.next() - 0.5) * jit;
      const baseR = unit * edge * dig;               // 根部探进轮廓之内（内缘不许越过轮廓）
      const tipR = unit * edge * (1 + CONFIG.fluff.lenRatio) * (1 + wobble);
      const ca = Math.cos(a), sa = Math.sin(a);
      sctx.beginPath();
      sctx.strokeStyle = `rgba(${FLUFF_RGB[0]},${FLUFF_RGB[1]},${FLUFF_RGB[2]},${(burst ? 0.34 : 0.22).toFixed(2)})`;
      sctx.lineWidth = burst ? 2.6 : 1.6;
      sctx.moveTo(half + ca * baseR, half + sa * baseR);
      // 一根毛一个二次贝塞尔：**建 sprite 时**画，运行时不再画
      sctx.quadraticCurveTo(
        half + Math.cos(a + 0.06) * (baseR + tipR) * 0.5,
        half + Math.sin(a + 0.06) * (baseR + tipR) * 0.5,
        half + ca * tipR, half + sa * tipR,
      );
      sctx.stroke();
    }
    sctx.globalCompositeOperation = 'source-over';
    renderer.fluff.push({ ctx: made.ctx, surface: made.surface, size, half, unit });
  }
}


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
  if (typeof opts.rng !== 'object' || opts.rng === null) {
    throw new TypeError('createRenderer: 需要注入 rng（碎边的抖动也只能从它来，不许用 Date.now 或下标凑）');
  }
  const renderer = {
    makeCanvas: makeOffscreen,
    rng: opts.rng,
    isMobile,
    viewport: opts.viewport,
    motes: createMotes(isMobile ? CONFIG.particles.mobile : CONFIG.particles.desktop, opts.rng),
    shafts: [],
    sediment: null,        // 预渲染的缸底 sprite（静态 ⇒ 只建一次）
    moteSprite: null,      // 预渲染的微粒 sprite
    glow: [],              // 第 1 层：光晕（CONFIG.glowHueBuckets 张，启动时一次建好）
    fluff: [],             // 第 7 层：毛尖碎边（CONFIG.fluff.sprites = 2 张，启动时一次建好）
    pelts: new Map(),      // 第 2 层：本体 sprite 缓存，键 = 色相桶 × 饱和档 × 明度档（惰性、有界）
    coreSprites: new Map(),// 第 4 层：体内亮区 sprite 缓存，键 = 情绪色字符串（最多 7 个）
    // 逐点屏幕坐标的复用数组（spec §5.3：运行时不分配对象）+ 同一次遍历量出的 squash。
    sx: new Float64Array(CONFIG.bodyPoints),
    sy: new Float64Array(CONFIG.bodyPoints),
    squashAlong: 1,
    squashPerp: 1,
    // ---- 第 6 层（B15）的复用容器：每帧每只都写这几个，一个对象都不新建（spec §5.3）----
    eyeCache: {},         // eyeParamsInto 的目标（键集由 eyes.js 第一次写入时定下）
    eyeAnchor: { lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 },
    eyeFacing: { x: 1, y: 0 },
    eyeOpts: { handLocal: null },
    handLocalVec: { x: 0, y: 0 },
    eyeGeom: new Float64Array(8),   // 两只眼的 [ex, ey] 与 [半宽, 半高]，一条数组装完
    hand: null,           // 每帧从 world.playerHand 读过来（**只读**，见 eyes.js 文件头那条 ⚠️）
    time: 0,
    getPeltSprite(hue, sat, lum) {
      const key = peltKey(hue, sat, lum);
      let sprite = renderer.pelts.get(key);
      if (sprite === undefined) {
        sprite = buildPeltSprite(renderer, key);
        renderer.pelts.set(key, sprite);
      }
      return sprite;
    },
    getCoreSprite(color) {
      // 键用颜色字符串本身（最多 7 个），不是情绪键 —— 查表结果本来就是颜色，
      // 用颜色当键可以让"两种情绪同色"自动合并，缓存更小。
      let sprite = renderer.coreSprites.get(color);
      if (sprite === undefined) {
        sprite = buildCoreSprite(renderer, color);
        renderer.coreSprites.set(color, sprite);
      }
      return sprite;
    },
    onResize(nextViewport, rng) {
      renderer.viewport = nextViewport;
      // 微粒**不重新分配**，只把越界的拉回缸内：重建 typed array 等于每次 resize
      // 都产生一次大块分配，而拖动窗口时会连续触发几十次 resize。
      const m = renderer.motes;
      for (let i = 0; i < m.n; i++) {
        if (m.y[i] > 1.05 || m.y[i] < -0.05) m.y[i] = rng.next();
      }
      // ⚠️ 只重建**依赖视口尺寸**的水体静态层。身体那几组 sprite 与视口无关
      //（尺寸变化靠 drawImage 的缩放与 setTransform 的矩阵），在 resize 里重建它们
      // 等于把"预渲染"改成"每次拖窗口都重画一遍" —— 而 resize 是会连续触发几十次的。
      buildStatics(renderer);
    },
    draw(ctx, world, bodies, viewport, dt) {
      renderer.time += dt;
      // 第 6 层要读手在哪（瞳孔朝向 + slow blink 的触发条件）。这是**只读**赋值：
      // world.playerHand 由 input 层写（sim.js 模块头明文的那唯一例外），这里只搬个引用。
      renderer.hand = world.playerHand;
      // 水体的摆动时钟挂在视口对象上（updateMotes 读 viewport.time）。
      // 同一个对象被 main.js 原地改写，所以这里写回去不会造成任何额外分配。
      viewport.time = renderer.time;
      updateMotes(renderer.motes, viewport, dt);
      drawWater(ctx, renderer, viewport);
      // 生物层（spec §5.1 的六层：B14 的第 1/2/3/4/5/7 + B15 的第 6）。
      // 层序有意义：生物在水体**之上**；B15 的眼睛接在 drawCreature 内部（clip 之外），
      // B16 的食物/卵接在**本循环之前**（它们在缸底/水中），B19 的气泡接在最后。
      const creatures = world.creatures;
      for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        const b = bodies && bodies.get ? bodies.get(c.id) : undefined;
        if (b !== undefined) drawCreature(ctx, renderer, c, b, viewport);
      }
    },
  };
  buildStatics(renderer);
  buildGlowSprites(renderer);
  buildFluffSprites(renderer);
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
