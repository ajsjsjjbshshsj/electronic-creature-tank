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
// ⚠️ B16（2026-10-21）之后，本文件的交付面是：水体（B13）+ 生物八层里的 1–7 层（B14/B15）
// + **缸底与水中的场景层**：食物、卵、溶散微粒（B16）。仍然只剩第 8 层语言气泡（B19）。
// 溶散 / sick / 哀悼 / hop 的竖向偏移全部是**每帧从 creature 读数重算的纯函数**
// （dissolveT / dimFactorFor / hopProgress + 三条曲线）， creature 上一个字段都不写 ——
// spec §7.2 那句"表现层的身体状态一律不入档"由 tests/render-fx.test.js 的快照断言守住。
//
// ⚠️ 桩 ctx 只数调用次数（因此"高光朝向"这类只能进手工清单）。
// 本文件里凡属于"只有真实渲染才看得出来"的东西 —— 渐变的朝向、颜色的观感、
// 光束够不够柔、沉积带厚不厚 —— 都由 tests/visual-checklist 手工核对，
// 这里刻意不写假装能测的断言。

import { CONFIG } from './config.js';
import { renderSizeOf, starRadius } from './body.js';
import { handPoseInto } from './hand.js';
import { dominant } from './emotions.js';
// 卵要显示它**将来**的色相（spec §4.11"壳内透出轮廓"），所以这里要解码一次基因组；
// 孵化时长则**必须**问内核要（breeding.eggDuration），因为"快孵化时脉动加快"这件事
// 的唯一权威是那条 eggSize → 时长 的映射，在表现层重抄一遍就会分家。
import { decode } from './genes.js';
import { eggDuration } from './breeding.js';
// 第 6 层（B15）：四参数与十行表的**计算全在 eyes.js**（纯函数、Node 里全测），
// 本文件只负责把它们画出来 —— 这是本 Task 的架构裁定，不是顺手拆分。
import {
  eyeParamsInto, eyeAnchorsInto, blushFor,
  pupilColor, eyeWhiteColor, eyeHighlightColor, blushColor,
} from './eyes.js';
// 第 8 层（B19a）：排队、折行、淡出曲线的**全部算术**在 src/bubble.js（纯函数、Node 里全测），
// 本文件只做事件入口与绘制。分工与上面 eyes.js 那条完全同形，理由也一样：
// 「同屏最多 2 个」「溢出丢最旧的」「最多 2 行」是**值**层面的判据，混进绘制路径就只剩次数证据。
import {
  bubblePoolCapacity, createBubbles, pushSay, advanceBubbles, bubbleFade,
} from './bubble.js';

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

// ---------------------------------------------------------------- 纯函数（B16）
//
// 溶散 / sick / 哀悼 / 蹦跳竖向偏移 / 卵 / 食物的**全部算术**都写在这一节。
// 三个理由让它们必须是纯函数而不是绘制代码里的顺手几行：
//   1. 记录型桩 ctx 记不到参数值，所以"亮度乘了多少""抬升了多少像素"这类必须在
//      Node 里断言的东西**只能**靠纯函数拿到证据（桩那一侧只有次数与顺序）。
//   2. spec §7.2："表现层的身体状态一律不入档" ⇒ 这些量必须是每帧重算的确定性函数，
//      而不是存在 creature / renderer 上的计时器。写成纯函数是这件事**结构上**的证明：
//      没有地方可以存。旧计划 Task 7 的变异探针 (b) 说的就是这份回报。
//   3. 返回值一律是**标量**而不是对象：drawCreature 每只每帧都要用其中四五个，
//      返回字面量就是 spec §5.3 禁止的运行时分配（screenX/screenY 同例）。
// 于是 drawCreature 只干一件事：把标量填进 renderer.fx 那个复用容器（见下）。

const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

// globalAlpha 的**唯一**写入点。B16 的 sick 变暗与死亡溶散 alpha 全部乘在这一处，
// 所以"变暗会不会漏掉某一层"这件事不需要逐层断言 —— 结构上漏不掉，
// 由 tests/render-fx.test.js 的一条源码扫描（赋值点恰好一处）守住。
// ⚠️ 为什么不能"在最外层 save 里写一次 globalAlpha"就完事：
// Canvas 的 globalAlpha **不是嵌套相乘**的，层内任何一次赋值都会**覆盖**外层那个值，
// 而第 2 层本体**必须**显式写 alpha=1（"毛绒不透明"那条证据就走在那一层）。
// 所以变暗只能乘进每一次写入。
// NaN 落到 0（不是"忽略赋值"）：脏值若写成 NaN，Canvas 会**保留上一只**的亮度，
// 症状是"这只生物顶着隔壁的透明度"且全程不报错。
const ga = (ctx, value, k) => {
  ctx.globalAlpha = Math.min(1, Math.max(0, Number.isFinite(value * k) ? value * k : 0));
};

// ---- 死亡溶散（spec §4.11："停止运动 → 光慢慢熄灭 → 身体溶散成微粒上升消散"）----
//
// ⚠️ 时长**直接读 c.dying**，绝不自建时钟：reapDead 就是按 `dying >= dissolveDuration`
// 把个体从 creatures 里 splice 掉的（sim.js）。两套时钟必然漂移，症状是
// "动画播到一半生物突然消失"或"生物没了但动画还在原地播"。
export function dissolveT(c) {
  if (c.alive) return 0;
  return clamp01(c.dying / CONFIG.dissolveDuration);
}
// 身体：平方衰减 ⇒ 末尾"化掉"而不是线性淡出（淡出读起来像"关灯"，不像"溶进水里"）。
export function dissolveAlphaOf(t) {
  const k = 1 - clamp01(t);
  return Math.pow(k, R.dissolveAlphaPow);
}
// 光晕：幂**更大** ⇒ 同一条进度上比身体更暗 ⇒ spec 那句话里"光先熄灭、身体后散"的顺序。
export function dissolveGlowOf(t) {
  const k = 1 - clamp01(t);
  return Math.pow(k, R.dissolveGlowPow);
}
export function dissolveExpandOf(t) {
  return 1 + (R.dissolveExpand - 1) * clamp01(t);      // 散开，不是缩没
}
export function dissolveLiftOf(t) {
  return R.dissolveLift * clamp01(t);                  // 逐渐上浮（"溶进水里"）
}

// ---- 亮度乘数：sick 与哀悼都会让生物变暗，但**幅度不同** ----
// sick 是故障（sim.js 点名要求"变暗、静止"，好让问题对用户可见，spec §7.7"绝不静默"），
// 哀悼是情绪（spec §4.11"停顿、变暗一小会儿"），不该看起来像坏了。
// ⚠️ 尸体那一侧**返回 1**：它的 alpha 归 dissolveAlphaOf 管，两头相乘就成了双倍暗。
export function dimFactorFor(c) {
  if (!c.alive) return 1;
  if (c.sick) return R.sickDim;
  const left = Number.isFinite(c.mourn) && c.mourn > 0 ? c.mourn : 0;
  if (left === 0) return 1;
  const k = clamp01(left / CONFIG.mournDuration);      // 剩余时间 ⇒ 线性回到正常，不到点突然变亮
  return 1 - (1 - R.mournDim) * k;
}

// sick 的**去饱和**。⚠️ 不用 ctx.filter = 'saturate(…)'：它在部分移动端浏览器上不支持或
// 极慢，而 spec §5.3 的性能预算是按手机算的。这里的做法是把饱和度落到**已有的**低饱和档
// sprite 上（本体 sprite 本来就按色相桶 × 饱和档 × 明度档分档缓存），
// 于是"掉色"这件事一次贴图都不多花、一张离屏画布都不新建。
// 色相**一个数字都不动**：spec §5.1 那条"不跨色相"的纪律在这里同样成立。
export function sickDesaturate(sat) {
  return clamp01(sat) * (1 - R.sickDesat);
}

// ---- 蹦跳（spec §4.7.2 跳起那半句 + §4.7 的 squash & overshoot）----
//
// 身体模型是 2D 的（body.points 在 facing 对齐的平面上，"上下"由渲染层决定），
// 所以"跳起来"需要一条**屏幕竖向偏移**。它不是世界状态：内核只有 intent.kind 与 intentTime
// 两个读数，竖向轨迹必须由它们**推导**，每帧重算、不入档（spec §7.2）。
// ⚠️ 轨迹时长读 `intent.minDuration`，不在这里重抄 spec 的 0.6/(0.3+activity)：
// 时长是内核的量（B16b 已把它从常数 0.84s 改成随 activity 的公式）。
// 当初那句"跟着读数走，将来内核改掉这条公式时本文件一行都不用动"兑现了 ——
// B16b 改内核时 render.js 的**代码**确实零改动，只有这段注释需要更新。
// 反过来，在这里各算一遍时长才会出事：那才是"两套时长"。
export function hopProgress(c) {
  const intent = c.intent;
  if (!intent || intent.kind !== 'hop') return 0;
  const dur = intent.minDuration;
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  const t = Number.isFinite(c.intentTime) ? c.intentTime : 0;
  return clamp01(t / dur);
}

// spec §4.7.2 逐字：跳起冲量 = base × (0.5 + activity) ⇒ 好动的跳得高。
// 这是 CONFIG.hop.impulseBase 的**第一个消费者**（内核只用它决策，不用它算轨迹）。
export function hopImpulse(activity) {
  return CONFIG.hop.impulseBase * (0.5 + clamp01(activity));
}

// 抬升量（**身体半径的倍数**，所以与视口无关、可单测）。
// 抛物线 4q(1−q)：起跳 0 → 滞空顶点在窗口中点 → 落地归零；落地之后保持 0（人已经在地上）。
export function hopLiftAt(p, impulse) {
  const k = clamp01(p);
  const land = R.hopLandAt;
  if (k >= land) return 0;
  const q = k / land;
  return impulse * R.hopLiftRatio * 4 * q * (1 - q);
}

// 竖向尺度：滞空拉长（>1）→ 落地**压扁**（<1）→ 过冲**超过**原尺寸一点点 → 收敛回 1。
// 落地那一刻压到底是有意的：spec §5.1 那句"蹦跳落地（§4.7.2 的一次性冲量 → 竖向压扁 +
// 过冲回弹）"说的就是一冲量，不是缓慢下压。过冲项与压扁共用一条 cos × (1−q)² 包络，
// 所以"过冲量必然小于压扁量"（spec §4.7："超过原尺寸**一点点**再收敛"）是结构性的，
// 不需要第二个旋钮去拦。
export function hopSquashAt(p) {
  const k = clamp01(p);
  const land = R.hopLandAt;
  if (k <= 0 || k >= 1) return 1;                     // 起跳前与恢复后都是恒等
  if (k < land) return 1 + (R.hopStretchAir - 1) * Math.sin(Math.PI * (k / land));
  const q = (k - land) / (1 - land);
  const left = 1 - q;
  return 1 - (1 - R.hopSquashMin) * Math.cos(q * TAU) * left * left;
}

// ---- 卵（spec §4.11 的"缸底微光脉动 / 快孵化时脉动加快 / 壳内透出轮廓"）----
//
// ⚠️ 卵的时间轴只有 `egg.age` 一条（breeding.tickEgg 对所有卵都推进它，不论可否孵化）。
// 不可孵化的卵**不另起倒计时**：它走的仍是这条 age，只是被读成"光慢慢熄灭"。
export function eggGlowFor(egg) {
  if (egg.viable) return 1;                            // 可孵化的卵一直亮着，直到孵化
  const t = Number.isFinite(egg.age) && egg.age > 0 ? egg.age : 0;
  const k = clamp01(t / R.eggFailFadeTime);
  const left = 1 - k;
  // 平方：先快后慢，像光在熄灭而不是一路调暗。残光不归零 —— 彻底消失的话玩家
  // 只会以为"根本没产卵"，那又变回一条**静默的禁令**（spec §4.12 第 6 条要避免的就是它）。
  return R.eggFailMinGlow + (1 - R.eggFailMinGlow) * left * left;
}

// 孵化进度（时长问内核要，不重抄公式）。
function eggProgress(egg) {
  const dur = eggDuration(egg);
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  const age = Number.isFinite(egg.age) && egg.age > 0 ? egg.age : 0;
  return clamp01(age / dur);
}

// "壳内透出轮廓"那一项：后段才出现，且线性推到 1。
// 它同时被当成脉动加快的系数（spec §4.11"快孵化时脉动加快"）⇒ 一个读数两处用，不留第二个旋钮。
export function eggShellRevealFor(egg) {
  const p = eggProgress(egg);
  if (p <= R.eggRevealAt) return 0;
  return clamp01((p - R.eggRevealAt) / (1 - R.eggRevealAt));
}

// 蛋的屏幕半径：直接读 eggSize（0.6–1.4 的相对值），所以"喂得好，蛋就大"这件事
// 在画面上成立（spec §4.11 明说这条因果比数值本身重要）。
// 走 viewport.scale 而不是 viewport.width：蛋是**世界里的东西**，
// 与生物同一条换算（spec §3.4-2），否则手机上蛋会跟着视口宽度而不是短边缩。
export function eggRadiusPx(egg, viewport) {
  const { min, max } = CONFIG.eggSize;
  const s = Number.isFinite(egg.eggSize) ? egg.eggSize : (min + max) / 2;
  return R.eggRadius * s * viewport.scale * 0.5;
}

// 蛋色：名字（遗传位点给的八色之一）→ 色值。**键集与 CONFIG.eggTint.colors 同一份**，
// 由 tests/render-fx.test.js 逐键比对；未知名字退回第一色而不是 undefined
// （undefined 会让 fillStyle 静默保持上一颗卵的颜色 —— 症状是"同窝有两颗颜色一样"）。
export function eggTintHex(name) {
  const tints = CONFIG.colors.eggTints;
  return Object.hasOwn(tints, name) ? tints[name] : tints[CONFIG.eggTint.colors[0]];
}

// ---- 食物（spec §6.2 的三种外观）----
export function foodColorFor(kind) {
  // 原型键名（'toString' / 'valueOf'）经原型链解析成 truthy 的函数，
  // 所以这里用 hasOwn 而不是 `CONFIG.colors[kind] || 藻色`（sim.spawnFood 记过同一个坑）。
  return Object.hasOwn(CONFIG.colors, kind) && kind !== 'eggTints'
    ? CONFIG.colors[kind] : CONFIG.colors.algae;
}
export function foodRadiusPx(food, viewport) {
  const a = clamp01(Number.isFinite(food.amount) ? food.amount : 1);
  // 下限 1px：吃到只剩一点的食物仍然要看得见（看不见＝"它凭空少了"，又是一条静默）。
  return Math.max(1, R.foodRadius * (0.6 + 0.4 * a) * viewport.scale * 0.5);
}


// ---------------------------------------------------------------- 颜色与 alpha 的纯函数
//
// 这一节是 B14 唯一能把"颜色语义"钉进自动化的地方：桩 ctx 记不到参数，
// 所以凡是必须被证明的东西（本体不透明、色相不跨、花纹压到 0.35）都写成**返回字符串/数字的
// 纯函数**，由建 sprite 的与绘制的那一侧唯一地调用它们。测试打的是同一个实现，不是旁证。

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
// ⚠️ B16 的变暗**不乘在这里**（那会毁掉上面这条证据，也会被 clip 之内的花纹与亮区覆盖）：
// 它乘在 ga() 那一个唯一写入点的第三个参数上，所以"本体不透明"与"这只 sick 了"两件事
// 各有一条自己的机器证据。
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
//
// 第七个参数 squashV 是 **B16 蹦跳那条屏幕竖向尺度**（spec §4.7.2 落地那半句）。
// 三个必须写清楚的理由：
//   · 它乘在**屏幕轴**上，不是 facing 局部轴上：身体怎么扭是 body.js 的事（那部分由
//     writeBodyScreen 量出来进 squashAlong/squashPerp），而"跳起来压扁"是全局竖向的，
//     与朝向无关 —— 所以量出的 squash 仍然只反映身体自身的形变，**不掺**这一项。
//   · 横向同时按 **1/squashV** 补偿：spec §4.7 的 squash & stretch 要体积守恒，
//     只压竖向会让它在落地那一刻凭空变小（tests/render-fx.test.js 逐点断言这一对倍数）。
//   · 默认 1 ⇒ B14/B15 已有的那些坐标断言一个数字都没改（它传六个参数）。
export function writeBodyScreen(renderer, body, cx, cy, r, facing, squashV) {
  const vy = Number.isFinite(squashV) && squashV > 0 ? squashV : 1;
  const hx = 1 / vy;                       // 体积守恒的横向补偿
  const ca = facing.x, sa = facing.y;
  const pts = body.points;
  const sx = renderer.sx, sy = renderer.sy;
  let along = 0, perp = 0, restAlong = 0, restPerp = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const la = p.x * ca - p.y * sa;
    const lp = p.x * sa + p.y * ca;
    sx[i] = cx + la * r * hx;
    sy[i] = cy + lp * r * vy;
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
  // 第七参是那一只**当前**的蹦跳竖向尺度（renderer.fx 的复用容器，见 drawCreature）。
  writeBodyScreen(renderer, body, cx, cy, r, c.facing, renderer.fx.squashV);
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
  // 溶散那一侧走 fx.glow（幂更高 ⇒ 光比身体先熄灭，spec §4.11 那句话的顺序），
  // sick / 哀悼那一侧与 fx.alpha 同值（变暗是整只一起暗，没有"光先灭"这一说）。
  ga(ctx, glowAlphaFor(c.traits.glow), renderer.fx.glow);
  ctx.drawImage(sprite.surface, cx - gr, cy - gr, gr * 2, gr * 2);
  ctx.restore();
}

// 第 2–4 层共用一个 clip 括号。
// 必须 clip：本体是一张**圆形** sprite，而身体是会形变的 24 点五角星软体。
// 不裁的话挤压、碰撞凹陷、生气时前端变尖在画面上完全看不出来（spec §5.1 整个软体模型白做）。
// ⚠️ 蹦跳的竖向压扁就藏在这个 clip 里：轮廓路径（buildBodyPath）已经按 fx.squashV 压过，
// 而本体 sprite 本身是一张不缩放的圆图 —— 于是"压扁"这件事由轮廓裁出来，
// 一次贴图都不多花（这正是 B14 那次 clip 决定的第二笔回报）。
function drawBodyLayers(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr) {
  const t = c.traits;
  // sick 的去饱和：不换 sprite 张数、不加滤镜，只把饱和度落到**已有的**低饱和档上。
  const sat = c.sick ? sickDesaturate(t.sat) : t.sat;
  const pelt = renderer.getPeltSprite(t.hue, sat, t.lum);
  ctx.save();
  buildBodyPath(ctx, renderer, c, body, cx, cy, r);
  ctx.clip();
  ga(ctx, peltAlphaFor(), renderer.fx.alpha);   // 不透明：毛绒与凝胶最直接的区别（改动 #1）
  ctx.drawImage(pelt.surface, cx - r, cy - r, r * 2, r * 2);
  drawPatternLayer(ctx, c, pelt, cx, cy, r, renderer.fx.alpha);
  drawInnerLightLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr);
  ctx.restore();
}

// 花纹四型（genes.PATTERNS 的 1–4：圆斑 / 环纹 / 云斑 / 星点）。
// ⚠️ 位置必须由 i/n 的**确定性函数**给出，绝不能用 rng：本层每帧都跑，
// 取随机数除了让花纹每帧重排（看起来在沸腾），还会消耗 world.rng 的序列
// ⇒ 同一个种子在开了渲染和没开渲染时跑出**不同的缸**。
// 这是表现层污染逻辑层的经典事故，由 tests/render-body.test.js 的"绘制一帧不向 rng 取数"守住。
const PATTERN_SPOTS = 6, PATTERN_RINGS = 3, PATTERN_CLOUDS = 4, PATTERN_STARS = 9;

function drawPatternLayer(ctx, c, pelt, cx, cy, r, k) {
  const t = c.traits;
  const alpha = patternAlphaFor(t.pattern);
  if (alpha <= 0) return;                    // none ⇒ 这一层整个不存在
  const density = 0.4 + 0.6 * clamp01(t.patternDensity);
  const mark = r * R.patternMarkFactor * density;
  ctx.save();
  ga(ctx, alpha, k);
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
//
// ⚠️ 第二个乘进来的是 **fx.squashV / fx.stretchH**（B16 蹦跳的屏幕竖向压扁 + 横向补偿）。
// setTransform(a,b,c,d,e,f) 的 b/d 是**输出 y** 那一行、a/c 是输出 x 那一行，
// 所以"绕体心做屏幕竖向缩放"就是给 b/d 乘 vy、给 a/c 乘 hx —— 不需要 atan2、不需要额外一次
// save/restore、也**不重算毛的位置**（spec §4.7："毛必须跟着形变走……一次 drawImage +
// setTransform，极便宜"）。原点 e/f 不乘：压扁是绕身体中心发生的。
function drawInnerLightLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr) {
  const sprite = renderer.getCoreSprite(coreColorFor(c.emotions));
  const cr = innerRadiusFor(r, breathe);
  const ax = cr * renderer.squashAlong * dpr;
  const ay = cr * renderer.squashPerp * dpr;
  const fx = renderer.fx;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ga(ctx, innerAlphaFor(c.traits.glow, breathe), fx.alpha);
  ctx.setTransform(fx.stretchH * ca * ax, fx.squashV * sa * ax,
    -fx.stretchH * sa * ay, fx.squashV * ca * ay, cx * dpr, cy * dpr);
  ctx.drawImage(sprite.surface, -1, -1, 2, 2);
  ctx.restore();
}

// 第 5 层：3 段链（spec §4.7.1）。贴图次数 = CONFIG.tail.segs，**不随体型增长**（spec §5.3）。
// 每段用本体的光晕 sprite（同一色相的柔和团）软描，根粗尖细。
const TAIL_ALPHA = 0.92;

// 把"每段画多大、段间隔多远"从绘制路径里剥出来（同 eyes.js 的 anchor、bubble.js 的 wrap 一条路子）：
// §8.2 那条"尾巴读不读得成**一条**"是相邻圆盘的**重叠**判据，是一个**值**，
// 混在 drawImage 那三笔里就只剩"贴了 3 次图"这种证据，而次数抓不到"三段之间各留一道缝"。
// 写进调用方给的复用数组（out.radii / out.spacing），因为这条每帧每只都跑 —— spec §5.3 零分配。
export function tailSegInto(out, body, r, viewport) {
  const n = body.tail.nodes.length;
  const segPx = (body.tailWorldLen * viewport.scale * 0.5) / n;
  out.count = n;
  out.spacing = segPx * 2;                    // 链是绷直时相邻节点的真实间距
  for (let i = 0; i < n; i++) {
    out.radii[i] = segPx * R.tailSegFactor * (1 - R.tailTaper * i);
  }
  return out;
}

function drawTailLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, viewport) {
  const nodes = body.tail.nodes;
  const n = nodes.length;
  if (n === 0) return;
  const sprite = getGlowSprite(renderer, c.traits.hue);
  const lift = tailLiftPx(body, r);
  const seg = tailSegInto(renderer.tailSeg, body, r, viewport);
  ctx.save();
  ga(ctx, TAIL_ALPHA, renderer.fx.alpha);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    const nx = cx + (nd.x * ca - nd.y * sa) * r;
    // 举高沿链递增（根部贴在身上，尖端抬起来）；spec 表里"竖直高举"的那一半
    const ny = cy + (nd.x * sa + nd.y * ca) * r - lift * ((i + 1) / n);
    const rr = seg.radii[i];
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
  const fx = renderer.fx;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ga(ctx, 1, fx.alpha);                   // 碎边的强度已经烧在 sprite 的 stroke alpha 里
  // ⚠️ 与体内亮区同一对乘数：蹦跳压扁时**毛跟着一起压**（spec §4.7"毛必须跟着形变走，
  // 而不是重新计算毛的位置"；独立动的碎边会退化成 §4.3 那圈已有的光晕，等于白画一层）。
  ctx.setTransform(fx.stretchH * ca * ax, fx.squashV * sa * ax,
    -fx.stretchH * sa * ay, fx.squashV * ca * ay, cx * dpr, cy * dpr);
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
  // 第 6 层的四次 alpha 写入共用**同一个** dim 系数（B16：sick / 哀悼 / 溶散都会连眼睛一起暗）。
  // 起个名字而不是每次现取：那四条赋值必须与眼睛那一层的其余三次同批生效，
  // 漏掉任何一次都会得到"身体暗了但眼白仍然 0.96"那种发光眼。
  const EYE_K = renderer.fx.alpha;
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
    ga(ctx, 0.96, EYE_K);
    ctx.fillStyle = eyeWhiteColor();
    ctx.beginPath();
    ctx.ellipse(geom[0], geom[1], geom[4], geom[5], 0, 0, TAU);
    ctx.ellipse(geom[2], geom[3], geom[6], geom[7], 0, 0, TAU);
    ctx.fill();

    // 2) 瞳孔：幸福那一格画四角星，其余画椭圆。颜色只能来自 CONFIG.colors.pupil（#2D1240）。
    ga(ctx, 1, EYE_K);
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
    ga(ctx, 0.85, EYE_K);
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
    ga(ctx, LID_LINE_ALPHA, EYE_K);
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
  ga(ctx, blush.alpha, renderer.fx.alpha);
  ctx.fillStyle = blushColor();
  ctx.beginPath();
  ctx.ellipse(bx + px * sep, by + py * sep, rr, rr * BLUSH_RIPPLE, 0, 0, TAU);
  ctx.ellipse(bx - px * sep, by - py * sep, rr, rr * BLUSH_RIPPLE, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function drawCreature(ctx, renderer, c, body, viewport) {
  const cx = screenX(c.pos.x, viewport);
  const worldCy = screenY(c.pos.y, viewport);
  const worldR = radiusPx(c, viewport);
  // 太小不值得画；同时挡住 NaN（NaN > 0.5 为 false）与脏存档给出的非有限坐标
  if (!(worldR > 0.5) || !Number.isFinite(cx) || !Number.isFinite(worldCy)) return;
  const facing = c.facing;
  const ca = Number.isFinite(facing.x) ? facing.x : 1;
  const sa = Number.isFinite(facing.y) ? facing.y : 0;
  const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
  const breathe = breatheOf(body);

  // ---- B16：把三个纯函数组的读数搬进每帧复用的容器（spec §5.3 零分配）----
  //
  // ⚠️ 这一段**只写 renderer.fx，一个字都不写 c**。
  // 溶散进度读 c.dying、变暗读 c.sick/c.mourn、蹦跳竖向偏移读 c.intent + c.intentTime ——
  // 全是内核**已经在产出**的读数，表现层不自建任何计时器、也不回填任何结果：
  // spec §7.2 明文"表现层的身体状态（控制点相位、尾巴角度、毛边 sprite 选择、当前气泡）
  // 一律不入档"，而"每帧重算的确定性函数"是唯一能保证这一点的写法
  // （由 tests/render-fx.test.js 的 creature 快照断言守住）。
  const fx = renderer.fx;
  const t = dissolveT(c);
  const dying = t > 0;
  const dim = dimFactorFor(c);
  fx.alpha = dying ? dissolveAlphaOf(t) : dim;
  fx.glow = dying ? dissolveGlowOf(t) : dim;
  fx.expand = dying ? dissolveExpandOf(t) : 1;
  fx.rise = dying ? dissolveLiftOf(t) * viewport.height : 0;
  const p = hopProgress(c);
  fx.squashV = hopSquashAt(p);
  fx.stretchH = 1 / fx.squashV;            // 体积守恒的横向补偿（spec §4.7）
  const activity = c.traits && c.traits.personality ? c.traits.personality.activity : 0;
  fx.lift = hopLiftAt(p, hopImpulse(activity)) * worldR;

  // 竖向偏移与溶散上浮都只改**绘制用的几何**，不改 c.pos（世界状态）。
  const cy = worldCy - fx.lift - fx.rise;
  const r = worldR * fx.expand;
  // 外层括号：漏一次 restore 会把 'lighter' 与 alpha 污染给后面所有层
  ctx.save();
  drawGlowLayer(ctx, renderer, c, r, cx, cy, breathe);
  drawBodyLayers(ctx, renderer, c, body, cx, cy, r, ca, sa, breathe, dpr);
  drawTailLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, viewport);
  drawEyeLayer(ctx, renderer, c, cx, cy, r, ca, sa);       // 第 6 层（B15）
  drawFluffLayer(ctx, renderer, c, body, cx, cy, r, ca, sa, dpr);
  ctx.restore();
}

// ---------------------------------------------------------------- 溶散微粒（对象池）
//
// spec §4.11 的死亡那一行最后半句："身体溶散成**微粒**上升消散"。
// B14 立下的三条上界里最硬的一条是"稳态 200 帧新建 0 张离屏画布"，所以这一层的
// 每一颗粒都贴**同一张**微粒 sprite（renderer.moteSprite，水体那 120 颗用的就是它）
// 并靠 drawImage 的目标尺寸缩放 —— 为每颗粒建一张 canvas 就是那条贝塞尔毛的另一种写法。
//
// ⚠️ 池是**并列 typed array**，不是对象数组（架构决定 6 / spec §5.3"微粒与事件用对象池"）。
// ⚠️ 粒子抖动**不向 rng 取数**：事件在帧边界被消费，帧率是设备相关的，
// 于是"从 rng 抽每颗粒的速度"会让同一个种子在两台设备上长出不同的缸
// —— 那是表现层污染逻辑层那一类事故（render-body.test.js 有一条专项守卫）。
// 改成从环形游标自身的确定性哈希推出来：**仍然可复现**（全局纪律第 2 条），
// 因为它是纯函数而不是随机数；同种子同事件序列在两台设备上逐位相同，
// 由 tests/render-fx.test.js 的"两台设备"那条断言核对每一个数组。
export function createBursts(n) {
  return {
    n, cursor: 0, live: 0,
    x: new Float64Array(n), y: new Float64Array(n),
    vx: new Float64Array(n), vy: new Float64Array(n),
    life: new Float64Array(n), maxLife: new Float64Array(n),
    r: new Float64Array(n),
    color: new Uint8Array(n),          // 颜色用**索引**，不用字符串（字符串会分配）
  };
}

// 四档颜色全部是 CONFIG.colors 里的既有字符串：拼一个新 rgba 就是每帧一次分配。
const BURST_COLORS = [CONFIG.colors.mote, CONFIG.colors.sakura, CONFIG.colors.peach, CONFIG.colors.rose];

// 爆发一批粒子。**环形写入**：池满就覆盖最老的那几颗，永不扩容 ⇒ 永不分配。
// 池容量（CONFIG.render.burstPool = 240）刻意小于"同帧 24 只全死"的 336 ——
// 死亡是老死/病死的稀疏事件，为它预留满员槽位是浪费；覆盖最老粒子在视觉上无感。
export function burst(renderer, x, y, colorIdx, count) {
  const b = renderer.bursts;
  const idx = ((colorIdx % BURST_COLORS.length) + BURST_COLORS.length) % BURST_COLORS.length;
  for (let i = 0; i < count; i++) {
    const k = b.cursor;
    b.cursor = (k + 1) % b.n;
    // 角度按**序号**均分（一圈均匀的散开），游标只当扰动项，避免每次爆发的角度完全重合。
    const a = (i / count) * TAU + k * 0.7;
    const sp = 0.05 + 0.11 * ((k * 37) % 13) / 13;
    // ⚠️ live 的增减必须在**覆盖之前**判：写成"赋值后再看 life 是否 ≤ 0"永远是 false，
    // 于是计数一路停在 0 —— 症状是粒子系统全灭而画面上什么都没有、也不报错。
    // 只有覆盖掉一个**死槽**才算新增；覆盖活口不增长（池满时反复爆发不许把计数推成天量）。
    if (b.life[k] <= 0) b.live += 1;
    b.x[k] = x; b.y[k] = y;
    b.vx[k] = Math.cos(a) * sp;
    b.vy[k] = Math.sin(a) * sp;
    b.maxLife[k] = 0.9 + 0.5 * ((k * 53) % 11) / 11;
    b.life[k] = b.maxLife[k];
    b.r[k] = 1.2 + 1.8 * ((k * 29) % 7) / 7;
    b.color[k] = idx;
    // live 只在"覆盖的是一个已经死掉的槽位"时才增长：池满时反复爆发不许把计数推成天量。
    if (b.life[k] <= 0) b.live += 1;
  }
}

// 就地积分。dt 必须是**模拟**秒（main.js 喂的那一个），不是渲染帧时长 ——
// 与水体同一个理由：4× 倍速下溶散也得跟着快，不许冻在原速。
export function updateBursts(b, dt) {
  let n = 0;
  for (let i = 0; i < b.n; i++) {
    if (b.life[i] <= 0) continue;
    b.life[i] -= dt;
    if (b.life[i] <= 0) continue;
    b.x[i] += b.vx[i] * dt;
    b.y[i] += b.vy[i] * dt;
    b.vy[i] -= 0.02 * dt;              // 轻微上浮（屏幕 y 向下为正 ⇒ 减 vy 才是往上）
    b.vx[i] *= 1 - 1.6 * dt;           // 阻尼：散开之后要停下来，不是越飞越快
    b.vy[i] *= 1 - 1.6 * dt;
    n += 1;
  }
  b.live = n;                          // live 是**重算**出来的，不是累加的（防漂移）
}

export function drawBursts(ctx, renderer, viewport) {
  const b = renderer.bursts;
  if (b.live === 0) return;
  const src = renderer.moteSprite.surface;   // ⚠️ 同一张 sprite，缩放靠目标尺寸
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < b.n; i++) {
    if (b.life[i] <= 0) continue;
    const k = b.life[i] / b.maxLife[i];
    ga(ctx, k * k * 0.8, 1);
    const d = b.r[i] * viewport.scale * 0.5 * (0.5 + k);
    ctx.drawImage(src, screenX(b.x[i], viewport) - d, screenY(b.y[i], viewport) - d, d * 2, d * 2);
  }
  ctx.restore();
}

// world.events 是内核与表现层之间**唯一**的通信通道（计划 1 原文）。
//
// ⚠️ 本函数**不清空** events：清空由 main.js 每帧做一次（`world.events.length = 0`）。
// 分成两个职责是为了让 audio（B18）也能消费同一批事件 —— 谁先清空谁就把事件
// 从另一个人手里抢走了。
//
// ⚠️ 未知事件种类一律**不抛**：内核以后会加事件（B18/B19 各要加几种），
// 表现层因为一条没见过的 kind 而白屏，违反 spec §7.7"绝不让整个世界崩溃"。
export function consumeEvents(renderer, events) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    switch (ev.kind) {
      case 'death':                              // sim.js:754
        burst(renderer, ev.pos.x, ev.pos.y, 0, R.dissolveParticles);
        break;
      case 'hatch':                              // sim.js:935
        burst(renderer, ev.pos.x, ev.pos.y, 1, 10);
        break;
      case 'eggFailed':                          // sim.js:879 / 919
        burst(renderer, ev.pos.x, ev.pos.y, 3, 5);
        break;
      case 'say':                                // sim.js:627 —— 第 8 层气泡（B19a）
        // 只有 kind/id/text/tokens/mood 五个字段被用；mood **不**参与气泡样式
        // （spec §4.13.1 说样式跟 fluff 走，而「跟着心情变色」会把文字通道又变成
        //  身体通道的复读机，那正是 §9.2 第 7 条要防的）。所以这里刻意不读它。
        // ⚠️ 关掉文字层时**连队列都不进**：不然静音期间攒下的旧句子会在重新打开的
        // 那一帧一次性喷出来 —— 那是弹幕，而弹幕是这个项目最该避免的东西。
        if (renderer.speechEnabled) pushSay(renderer.bubbles, ev, renderer.time);
        break;
      // 以下六种在**这一层**没有对应的画面，各有各的理由（不是漏掉）：
      case 'laid':                               // 没有 pos（只有 id 与枚数）；卵本身就画在缸底
      case 'dissolved':                          // 个体已被 splice，溶散动画早播完了
      case 'emigrate':                           // 漂走不是死亡（不记 deaths、不发 death）
      case 'drift':                              // 漂入的是**卵**，由 drawEggs 画；事件里没 pos
      case 'eat':                                // 进食的读出通道是需求条与情绪，不是粒子
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- 卵（spec §4.11 / §4.12 第 6 条）

// 卵的光晕用它**将来**的色相（它自己的 genes，不是母亲的），"壳内透出轮廓"讲的正是这件事。
// ⚠️ 不缓存 decode 结果（旧计划 Task 7 用了一个 Map 并配一段清理代码）：
// 一次 decode 是 19 次算术，比一次 Map 查找加上"每帧比对全部卵的 id 集合"那条清理路径
// 更便宜，而且那个缓存会随卵的消失泄漏。脏/缺基因退回**粉色区间的中位**（350°），
// 不是退回随机色：那枚卵仍然读起来是"缸里的一枚蛋"，而不是一个彩色气球。
const EGG_FALLBACK_HUE = (() => {
  const [start, end] = CONFIG.hueRange;
  return (start + ((end - start + 360) % 360) / 2) % 360;
})();

export function eggHueOf(egg) {
  const genes = egg && egg.genes;
  if (!genes) return EGG_FALLBACK_HUE;
  try {
    const hue = decode(genes).hue;
    return Number.isFinite(hue) ? hue : EGG_FALLBACK_HUE;
  } catch {
    return EGG_FALLBACK_HUE;      // 存档迁移到一半的基因形状：亮区退回区间中位，不许白屏
  }
}

function drawEggShell(ctx, egg, x, y, rr) {
  // 壳是一枚竖着的椭圆（不是正圆）：圆蛋在任何位置都读成"气泡"，
  // 竖椭圆加上下缘那点透光才像"躺在沉积物里的一枚蛋"。
  ctx.beginPath();
  ctx.ellipse(x, y, rr * 0.82, rr, 0, 0, TAU);
  ctx.fill();
}

function drawEggsInner(ctx, renderer, egg, viewport) {
  const glow = eggGlowFor(egg);
  const reveal = eggShellRevealFor(egg);          // 0 直到孵化后段（spec"壳内透出轮廓"）
  const x = screenX(egg.pos.x, viewport);
  const y = screenY(egg.pos.y, viewport);
  // 脉动加快：reveal 从 0 走到 1，频率跟着从 2.2 抬到 4.8。
  // ⚠️ 用 renderer.time 当相位**在这里是允许的**（一枚卵没有第二方需要同相），
  // 而求偶/呼吸那一类"两方必须同相"的场合绝不允许 —— 旧计划栽的那一跤在后者，
  // B14 的呼吸也已经换成读 body.phase（见 breatheOf）。
  const pulse = 1 + R.eggGlowPulse * Math.sin(renderer.time * (2.2 + 2.6 * reveal) + x * 0.02)
    * (egg.viable ? 1 : glow);
  const rr = eggRadiusPx(egg, viewport) * pulse;
  const sprite = getGlowSprite(renderer, eggHueOf(egg));
  // ① 缸底那一团光（spec §4.11 卵那一格："缸底微光脉动"）。
  //    不可孵化的卵这一团就是被 eggGlowFor 慢慢熄灭的那一个。
  // ⚠️ 混合模式**每段都显式设**，不设"进循环时设一次"：上一枚卵的蛋壳是 source-over 画的，
  // 留着它去贴下一枚卵的光晕，第二枚开始就没有那团光了。
  ctx.globalCompositeOperation = 'lighter';
  ga(ctx, glow * 0.85, 1);
  ctx.drawImage(sprite.surface, x - rr * 2.2, y - rr * 2.2, rr * 4.4, rr * 4.4);
  // ② 壳内透出轮廓：同一张光晕 sprite 缩到壳内，亮度跟着 reveal 抬起来。
  //     这是这一层**唯一**可能被跳过的那次贴图 ⇒ 桩数得出 1 次与 2 次的差别。
  if (reveal > 0) {
    ga(ctx, reveal * 0.55, 1);
    ctx.drawImage(sprite.surface, x - rr * 0.7, y - rr * 0.7, rr * 1.4, rr * 1.4);
  }
  // ③ 蛋壳本体（八色蛋色在这里，spec §4.1 / §4.12 第 5 条）。
  //    ⚠️ fillStyle 走的是**取表**（eggTintHex），不在这里拼颜色字符串（spec §5.3 禁分配）。
  ctx.globalCompositeOperation = 'source-over';
  ga(ctx, 0.35 + 0.55 * glow, 1);
  ctx.fillStyle = eggTintHex(egg.eggTint);
  drawEggShell(ctx, egg, x, y, rr);
}

/**
 * F-5（计划 3 Task 7）：把卵的**下沿**埋进沉积带。
 *
 * 为什么要有这一层：B20 量过，卵的**位置本来就是对的**（卵心 y≈0.926，沉积带上沿在 0.915），
 * 问题是层序 —— 沉积带画在卵之前，所以卵的下沿永远不被任何东西遮住，画面上就是
 * "一颗颗蛋浮在带子前面"。加一层同色矩形盖住下沿，才读成"蛋陷进沙里"。
 *
 * 三条实现约束，每条都对应一种症状：
 *  · **逐颗**遮，不画整条横贯缸底的矩形：低处那颗会被整块埋掉，"看不见缸里有卵"
 *    比"蛋浮在沙上"更糟；每块遮罩只盖到自己那颗的下沿为止，也不遮住更深的另一颗。
 *  · **只用矩形**（fillRect）：本文件里 arc 归食物、ellipse 归卵、clip 归本体，
 *    那条"arc 早于 ellipse 早于 clip"的层序断言数的是这三者的**次数**，
 *    遮罩要是敢用圆弧，那条断言就以"卵层多了弧线"的方式红，而它正是我们要保的东西。
 *  · 颜色取 CONFIG.colors.sediment，**不新造一个数**：不一样就在缸底画出一条看得见的接缝。
 *  · 整颗都在带上方的卵**跳过**：那会在开阔水里画一块沙色矩形。
 */
export function drawEggMask(ctx, world, viewport) {
  const eggs = world && world.eggs;
  if (!Array.isArray(eggs) || eggs.length === 0) return;
  const h = viewport.height;
  const bandTop = h * (1 - CONFIG.render.sedimentHeight);
  ctx.save();
  ctx.fillStyle = CONFIG.colors.sediment;
  for (const egg of eggs) {
    if (!egg || !egg.pos) continue;
    const r = eggRadiusPx(egg, viewport);
    const cx = screenX(egg.pos.x, viewport);
    const cy = screenY(egg.pos.y, viewport);
    if (cy + r <= bandTop) continue;                 // 悬在沙子之上，不遮
    const y0 = Math.max(bandTop, cy);
    ctx.fillRect(cx - r - 1, y0, (r + 1) * 2, (cy + r + 1) - y0);
  }
  ctx.restore();
}

export function drawEggs(ctx, renderer, world, viewport) {
  const eggs = world.eggs;
  if (!eggs || eggs.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < eggs.length; i++) drawEggsInner(ctx, renderer, eggs[i], viewport);
  ctx.restore();
}

// ---------------------------------------------------------------- 食物（spec §6.2 的三种外观）
//
// ⚠️ 这一层**一次贴图都不花**：微粒 sprite 是粉色的（CONFIG.colors.mote），
// 拿它去贴食物就等于把 spec §6.2 明文"避开粉色系"的那三种颜色又染回粉色。
// 三条形状各走各的图元，这也是记录型桩**唯一**能看出"三种外观互不相同"的地方：
//   光藻 = 一簇 arc（青绿微粒）
//   蜜珠 = 一个 ellipse 加一颗 arc 高光（琥珀金珠）
//   冰晶 = moveTo + 五条 lineTo + closePath + stroke（淡蓝结晶的直棱）

const FOOD_ALGAE_MOTES = 4;      // 一簇几颗：太少读成"一个点"，太多就成一团雾
const FOOD_CRYSTAL_FACETS = 6;   // 晶面数：六边形是"结晶"，五边形读成"石头"

function drawFoodAlgae(ctx, x, y, rr) {
  ctx.beginPath();
  for (let i = 0; i < FOOD_ALGAE_MOTES; i++) {
    const a = (i / FOOD_ALGAE_MOTES) * TAU + 0.4;
    const spread = rr * 1.5;
    ctx.arc(x + Math.cos(a) * spread, y + Math.sin(a) * spread, rr * 0.5, 0, TAU);
  }
  ctx.fill();
}

function drawFoodNectar(ctx, x, y, rr) {
  ctx.beginPath();
  ctx.ellipse(x, y, rr, rr * 1.12, 0, 0, TAU);     // 珠子本身（竖着略鼓，像一滴蜜）
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - rr * 0.32, y - rr * 0.36, rr * 0.3, 0, TAU);   // 那一点高光
  ctx.fill();
}

function drawFoodCrystal(ctx, x, y, rr) {
  ctx.beginPath();
  for (let i = 0; i < FOOD_CRYSTAL_FACETS; i++) {
    const a = (i / FOOD_CRYSTAL_FACETS) * TAU - Math.PI / 2;   // 一个尖朝上
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.lineWidth = Math.max(0.8, rr * 0.24);
  ctx.stroke();
}

export function drawFoods(ctx, renderer, world, viewport) {
  const foods = world.foods;
  if (!foods || foods.length === 0) return;
  ctx.save();
  ga(ctx, 0.92, 1);
  for (let i = 0; i < foods.length; i++) {
    const f = foods[i];
    const pos = f.pos;
    if (!pos) continue;
    const x = screenX(pos.x, viewport);
    const y = screenY(pos.y, viewport);
    const rr = foodRadiusPx(f, viewport);
    const color = foodColorFor(f.kind);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (f.kind === 'crystal') drawFoodCrystal(ctx, x, y, rr);
    else if (f.kind === 'nectar') drawFoodNectar(ctx, x, y, rr);
    else drawFoodAlgae(ctx, x, y, rr);           // 未知种类按光藻画（颜色也已退回藻色）
  }
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
// 描边那一档比碎边更浅（同样是 CONFIG 里的既有颜色，从它推导而不是再抄一份字面量）。
const EYE_WHITE_RGB = (() => {
  const n = parseInt(CONFIG.colors.eyeWhite.slice(1), 16);
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


// ---------------------------------------------------------------- 第 8 层：语言气泡（B19a）
//
// spec §5.1 的层序里它在最上面（第 8 层），§4.13.1 那句「显示纪律」是它唯一的需求来源：
//   浮在头顶 / 最多 2 行 / 字号 ≥14px / 3 秒淡出 / 样式跟 fluff 走（浅色描边，像绣在毛上）/
//   同一时刻屏上最多 2 个，其余排队。
// **排队、折行、淡出曲线全部在 src/bubble.js（纯函数，Node 里直接断值）**，本文件只做两件事：
// 把事件送进池子（consumeEvents）、把池子里那两条画出来。分工与 B15 的 eyes.js 同形。
//
// ⚠️ 四条账单，每条都有测试钉着：
//   · `fillText` 每帧 ≤ onscreenMax × bubbleMaxLines = **4 笔**（超出就是弹幕）。
//   · **零 `drawImage`、零新建 sprite**：给每条气泡预渲染一张贴图会动 B14 立的「每只每帧恰好
//     7 次贴图」上界，而那三条是 spec §5.3 的机器证据。文本走 measureText + 路径 + fillText。
//   · **零 `quadraticCurveTo`**、贝塞尔只来自身体轮廓那一段 ⇒ 圆角用 `arc` 画。
//   · **不写世界一个字节**：`c.bubble` / `world.bubbles` 都不存在（spec §7.2 明文，
//     唯一例外是 catchphrase，它不归这层管）。状态在 renderer.bubbles 那份池子里，
//     每帧从 say 事件与 renderer.time 推导。
//
// ⚠️ 颜色常量**必须**在 FLUFF_RGB 之后定义（模块求值顺序，TDZ）：样式跟 fluff 走的字面实现
// 就是「气泡底与毛尖碎边取同一个浅色」，所以在同一个文件里推导、不再抄一份十六进制。

const BUBBLE_S = CONFIG.speech;
// 字号是 **CSS 像素**：main.js 每帧先把上下文缩放到 dpr，所以绘制坐标与字号
// 都已经在 CSS 空间里。写成模块常量而不是每次拼字符串，同时钉住了两件事：
// 每帧零分配，以及 dpr 永远进不了字号（手机上 14px 被乘成 4.7px 那种错法在这里做不到）。
export const BUBBLE_FONT = `${BUBBLE_S.bubbleFontPx}px "PingFang SC", "Hiragino Sans GB", `
  + '"Microsoft YaHei", system-ui, sans-serif';
export const BUBBLE_FILL = `rgba(${FLUFF_RGB[0]}, ${FLUFF_RGB[1]}, ${FLUFF_RGB[2]}, 0.86)`;
export const BUBBLE_STROKE = `rgba(${EYE_WHITE_RGB[0]}, ${EYE_WHITE_RGB[1]}, ${EYE_WHITE_RGB[2]}, 0.95)`;
// 墨色取瞳孔那一档深靛紫（与眼睛同源）：浅底深字才读得完那两行。
export const BUBBLE_INK = (() => {
  const n = parseInt(CONFIG.colors.pupil.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 1)`;
})();

// 身体包围盒的**顶边**（屏幕 CSS 像素）。与 writeBodyScreen 用同一条变换公式
// （sy = cy + (p.x·sin + p.y·cos) · r · squashV），所以它就是画出来的那一圈点的最高点。
// 为什么不复用 renderer.sx/sy 里那份现成的坐标：那是**逐只覆盖**的复用数组（绘制不可重入），
// 生物循环走完之后里面只剩最后一只。重算是这里唯一的选择，而代价是有界的：
// 每帧最多 2 条气泡 × 24 点 = 48 次算术，零分配。
export function bodyTopY(body, cx, cy, r, ca, sa, squashV) {
  const vy = Number.isFinite(squashV) && squashV > 0 ? squashV : 1;
  const pts = body.points;
  let top = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const y = cy + (p.x * sa + p.y * ca) * r * vy;
    if (Number.isFinite(y) && y < top) top = y;
  }
  return Number.isFinite(top) ? top : cy;
}

// 气泡底边（毛尖之上）的锚点 y。
//
// ⚠️ 这是设计判断 5 的全部：位置跟的是**绘制几何**，不是 c.pos。B16 之后身体会竖向抬升
// （跳）与上浮（溶散），钉在 c.pos 上的气泡会留在原地 —— 症状是「它跳起来了，话掉在地上」。
// 这里的 lift / rise / expand / squashV 与 drawCreature 走**同一组纯函数**，
// 所以它不是第二条时钟、也不是第二套公式，只是把那些公式对这一只重跑一遍。
export function bubbleAnchorY(renderer, c, body, viewport) {
  const worldR = radiusPx(c, viewport);
  if (!(worldR > 0.5)) return Number.NaN;
  const cx = screenX(c.pos.x, viewport);
  const worldCy = screenY(c.pos.y, viewport);
  if (!Number.isFinite(cx) || !Number.isFinite(worldCy)) return Number.NaN;
  const t = dissolveT(c);
  const dying = t > 0;
  const p = hopProgress(c);
  const squashV = hopSquashAt(p);
  const activity = c.traits && c.traits.personality ? c.traits.personality.activity : 0;
  const lift = hopLiftAt(p, hopImpulse(activity)) * worldR;
  const rise = dying ? dissolveLiftOf(t) * viewport.height : 0;
  const r = worldR * (dying ? dissolveExpandOf(t) : 1);
  const cy = worldCy - lift - rise;
  const ca = Number.isFinite(c.facing.x) ? c.facing.x : 1;
  const sa = Number.isFinite(c.facing.y) ? c.facing.y : 0;
  // 毛尖还要伸出 body.points 之外（碎边 sprite 的半径），不然第一行字会压在毛上。
  return bodyTopY(body, cx, cy, r, ca, sa, squashV) - (fluffOuterRadius(r, body.fluffLen) - r);
}

// 把气泡框夹回视口内（原地写 out，返回新对象就是每帧一次分配）。
// 贴边的个体不该被裁掉半句话 —— 而「裁掉」在桩里看不见，所以这条只能断值，不断像素。
export function bubbleBoxInto(out, x, y, w, h, viewport) {
  const ww = Number.isFinite(w) && w > 0 ? w : 0;
  const hh = Number.isFinite(h) && h > 0 ? h : 0;
  let bx = Number.isFinite(x) ? x : 0;
  let by = Number.isFinite(y) ? y : 0;
  if (bx + ww > viewport.width) bx = viewport.width - ww;
  if (bx < 0) bx = 0;
  if (by + hh > viewport.height) by = viewport.height - hh;
  if (by < 0) by = 0;
  out.x = bx;
  out.y = by;
  out.w = ww;
  out.h = hh;
  return out;
}

// 圆角矩形：四条直边 + 四个 `arc`。**不用** quadraticCurveTo（B14 那条「恒 0」的上界）
// 也不用 ctx.roundRect（老 Safari 没有，而 spec §7.7 要求这条路在手机上照样成立）。
function traceBubbleBox(ctx, x, y, w, h, rad) {
  const rr = Math.max(0, Math.min(rad, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI * 0.5, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI * 0.5);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI * 0.5, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

const findCreature = (creatures, id) => {
  for (let i = 0; i < creatures.length; i++) if (creatures[i].id === id) return creatures[i];
  return null;
};

// 第 8 层，画在**所有东西之后**（spec §5.1：气泡是最上面那一层）。
// 关掉文字层时这一层直接收摊：一条都不画、一个字都不量，其余七层逐笔不变 ——
// 那是 spec §9.2 第 7 条在这一层的落点，由 tests/render-bubble.test.js 的序列前缀断言守住。
function drawBubbleLayer(ctx, renderer, world, bodies, viewport) {
  const b = renderer.bubbles;
  if (!renderer.speechEnabled) { b.count = 0; return; }
  if (b.count === 0) return;
  const S = CONFIG.speech;
  // 文本框的可用宽度：视口宽的一个比例，减掉左右内边距。按视口而不是按像素写死，
  // 是为了让手机上那句「两行」真的还能是两行（而不是被裁成一行的半截）。
  const textW = Math.max(S.bubbleFontPx, viewport.width * S.bubbleMaxWidthFrac - 2 * S.bubblePadding);
  const on = advanceBubbles(b, renderer.time, textW, ctx);
  const box = renderer.bubbleRect;
  const lineH = S.bubbleFontPx + S.bubbleLineGap;
  for (let rel = 0; rel < on; rel++) {
    const idx = rel;                    // 稠密池子：第 rel 条就在第 rel 格（见 bubble.js 头）
    const c = findCreature(world.creatures, b.id[idx]);
    // 说话的那只已经不在了（刚被 splice 掉）：这句不画，剩下的活由 TTL 收尸，不抛。
    if (c === null || !bodies || !bodies.get) continue;
    const body = bodies.get(c.id);
    if (!body) continue;
    const lines = b.lineCount[idx];
    if (lines <= 0) continue;
    const anchor = bubbleAnchorY(renderer, c, body, viewport);
    if (!Number.isFinite(anchor)) continue;
    const alpha = bubbleFade(renderer.time - b.shownAt[idx]);
    if (!(alpha > 0)) continue;
    const cx = screenX(c.pos.x, viewport);
    const bw = b.boxW[idx];
    const bh = lines * S.bubbleFontPx + (lines - 1) * S.bubbleLineGap + 2 * S.bubblePadding;
    // 框底落在毛尖之上，中间那一段空隙由一个小三角填掉：两条气泡同时挂在一缸头上时，
    // 「这句是谁说的」必须靠几何而不是靠猜。
    const bottom = anchor - S.bubbleHeadGap;
    bubbleBoxInto(box, cx - bw * 0.5, bottom - bh, bw, bh, viewport);
    const rad = S.bubblePadding;
    ctx.save();
    ctx.fillStyle = BUBBLE_FILL;
    ctx.strokeStyle = BUBBLE_STROKE;
    ctx.lineWidth = S.bubbleStroke;
    ctx.font = BUBBLE_FONT;
    ga(ctx, alpha, 1);
    traceBubbleBox(ctx, box.x, box.y, box.w, box.h, rad);
    ctx.fill();
    ctx.stroke();
    // 指向脑袋的那三笔：三角尖正好落在毛尖上（anchor），底边贴在框底。
    const tx = Math.min(Math.max(cx, box.x + rad), box.x + box.w - rad);
    ctx.beginPath();
    ctx.moveTo(tx - S.bubbleHeadGap * 0.6, bottom);
    ctx.lineTo(tx, anchor);
    ctx.lineTo(tx + S.bubbleHeadGap * 0.6, bottom);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = BUBBLE_INK;
    const ws = b.widths[idx];
    const ls = b.lines[idx];
    const baseline0 = box.y + S.bubblePadding + S.bubbleFontPx;
    for (let k = 0; k < lines; k++) {
      const t = ls[k];
      if (t === '') continue;
      // 每行自己居中，不用 textAlign：桩与老浏览器的 textAlign 支持不一致，而这里是三次减法。
      ctx.fillText(t, box.x + (box.w - ws[k]) * 0.5, baseline0 + k * lineH);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- 玩家的手

// 一根带描边的毛绒胶囊（先粗后细两笔，不建 Path2D、不分配对象）。
function plushCapsule(ctx, ax, ay, bx, by, radius, strokeWidth) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineWidth = radius * 2 + strokeWidth * 2;
  ctx.strokeStyle = CONFIG.colors.handShade;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineWidth = radius * 2;
  ctx.strokeStyle = CONFIG.colors.handSkin;
  ctx.stroke();
}

// 画在生物与溶散粒子之上、语言气泡之下：手是玩家伸进缸里的实体，
// 但它不该盖住「它说了什么」。几何全在 hand.js 的 handPoseInto 里（Node 里单测），
// 本函数只负责路径。整层零贴图、零渐变、零随机数、零每帧新对象。
export function drawHandLayer(ctx, renderer, viewport) {
  const H = CONFIG.hand;
  const pose = handPoseInto(renderer.handPose, renderer.hand, viewport,
    renderer.petTime, renderer.petting);
  if (!pose.active) return pose;

  ctx.save();
  // 接触光先画：它属于指尖下方的水面，不该压在手掌上。
  // 抚摸时两圈半径随 contactPulse 向外展开并淡出——这是"手在动"的第二个读秒通道。
  if (pose.petting) {
    const pulse = pose.contactPulse;
    ga(ctx, H.contactAlpha * (1 - pulse * 0.35), 1);
    ctx.strokeStyle = CONFIG.colors.sakura;
    ctx.lineWidth = H.contactLineWidth;
    ctx.beginPath();
    ctx.arc(pose.tipX, pose.tipY, pose.contactRadius * (0.90 + pulse * 0.35), 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pose.tipX, pose.tipY, pose.contactRadius * (1.35 + pulse * 0.55), 0, TAU);
    ctx.stroke();
  }

  ctx.translate(pose.tipX, pose.tipY);
  ctx.scale(pose.dirX, pose.dirY);
  ctx.rotate(pose.rock);
  ga(ctx, H.alpha, 1);
  ctx.fillStyle = CONFIG.colors.handSkin;
  ctx.strokeStyle = CONFIG.colors.handShade;
  ctx.lineWidth = H.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 短手腕先垫在掌后：手是从屏幕外伸进来的，不是一颗悬空的圆。
  const fingerR = H.fingerRadius * pose.size;
  plushCapsule(ctx,
    H.offsetX * pose.size, (H.offsetY + 0.06) * pose.size,
    (H.offsetX + 0.05) * pose.size, (H.offsetY - 0.30) * pose.size,
    fingerR * 2.5, H.strokeWidth);

  // 四根短指从宽掌的下缘垂到接触点；第一根终点精确落在局部 (0,0)，也就是指针。
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const bx = (H.offsetX - 0.16 + t * 0.48) * pose.size;
    const by = (H.offsetY + 0.22 + t * 0.01) * pose.size;
    const tx = (H.offsetX - 0.18 + t * H.fingerSpread) * pose.size;
    const ty = (t * H.fingerDrop) * pose.size;
    plushCapsule(ctx, bx, by, tx, ty, fingerR, H.strokeWidth);
  }
  // 拇指朝左下岔开；它让"这是一只手"在 40px 下也读得出来。
  plushCapsule(ctx,
    (H.offsetX - 0.02) * pose.size, (H.offsetY + 0.08) * pose.size,
    (H.offsetX - 0.54) * pose.size, (H.offsetY + 0.18) * pose.size,
    fingerR * 1.2, H.strokeWidth);

  // 手掌：掌缘落在 pose.palm 推出来的方位；镜像与 rocking 都由上面的变换承担。
  ctx.beginPath();
  ctx.ellipse(H.offsetX * pose.size, H.offsetY * pose.size,
    H.palmWidth * pose.size, H.palmHeight * pose.size, 0, 0, TAU);
  ctx.fillStyle = CONFIG.colors.handSkin;
  ctx.fill();
  ctx.lineWidth = H.strokeWidth;
  ctx.strokeStyle = CONFIG.colors.handShade;
  ctx.stroke();

  // 掌背两道很浅的折线：只是让肉色块有"手背"的方向，不参与任何判定。
  ga(ctx, 0.24, 1);
  ctx.strokeStyle = CONFIG.colors.handShade;
  ctx.lineWidth = H.strokeWidth * 0.8;
  ctx.beginPath();
  ctx.moveTo((H.offsetX - 0.12) * pose.size, (H.offsetY + 0.12) * pose.size);
  ctx.quadraticCurveTo(
    H.offsetX * pose.size, (H.offsetY + 0.20) * pose.size,
    (H.offsetX + 0.14) * pose.size, (H.offsetY + 0.10) * pose.size);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo((H.offsetX - 0.06) * pose.size, (H.offsetY - 0.04) * pose.size);
  ctx.quadraticCurveTo(
    (H.offsetX + 0.05) * pose.size, (H.offsetY + 0.02) * pose.size,
    (H.offsetX + 0.16) * pose.size, (H.offsetY - 0.06) * pose.size);
  ctx.stroke();
  ctx.restore();
  return pose;
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
    petting: false,       // 本帧是否有任何一只 c.beingPetted（只读汇总，手部层用它决定接触光）
    petTime: 0,           // 从本次抚摸开始累计的模拟秒；rocking 从 0 渐入，不从全局相位跳进来
    handPose: {           // 手部几何的复用容器（零分配；字段由 handPoseInto 写满）
      active: false, petting: false, tipX: 0, tipY: 0, palmX: 0, palmY: 0,
      size: 0, dirX: 1, dirY: 1, rock: 0, contactRadius: 0, contactPulse: 0,
    },
    // ---- B16 的每帧复用容器：drawCreature 逐只写它，各层从这里读（**零分配**，spec §5.3）----
    // ⚠️ 它是**绘制参数**，不是状态：里面没有任何计时器，所有读数都是 drawCreature 开头
    // 那一组纯函数（dissolveT / dimFactorFor / hopProgress …）对**当前这一只**的输出。
    // 所以"绘制不可重入"那条老纪律同样适用于它（文件头），且 creature 上不长任何字段。
    fx: {
      alpha: 1,           // 整只的亮度乘数：溶散 alpha，或 sick/哀悼的 dim（两者互斥，见 dimFactorFor）
      glow: 1,            // 第 1 层光晕单独的乘数（溶散时**光比身体先熄灭**）
      expand: 1,          // 溶散的体型倍数（>1：散开，不是缩没）
      lift: 0,            // 蹦跳的屏幕竖向抬升（**CSS 像素**，已乘身体半径）
      rise: 0,            // 溶散的上浮（视口高度 fraction × viewport.height）
      squashV: 1,         // 蹦跳的屏幕竖向尺度（落地 <1、滞空 >1）
      stretchH: 1,        // 它的横向补偿 = 1/squashV（体积守恒）
    },
    bursts: createBursts(CONFIG.render.burstPool),   // 溶散/孵化/卵失败的对象池（环形写入，永不扩容）
    // ---- 第 8 层（B19a）：语言气泡的池子。⚠️ 它是**表现层状态**，不在 world / creature 上 ----
    // spec §7.2 明文「表现层的身体状态（…当前气泡）一律不入档」，而把它挂在这里
    // 就是那条话的实现形状：每帧从 say 事件与 renderer.time 推导，关页面就什么都不剩。
    // 容量在创建时一次定死（onscreenMax × bubbleQueueMul），运行中只改槽位、永不扩容。
    bubbles: createBubbles(bubblePoolCapacity()),
    bubbleRect: { x: 0, y: 0, w: 0, h: 0 },   // 每帧复用的气泡框矩形（bubbleBoxInto 的写入目标）
    // 第 5 层尾巴的段几何复用槽（tailSegInto 的写入目标）。每帧每只都算一次，
    // 所以它必须是常驻的一份而不是每次 new —— spec §5.3 运行时零分配。
    tailSeg: { count: 0, spacing: 0, radii: [0, 0, 0, 0, 0, 0] },
    speechEnabled: true,       // 每帧从 world.speechEnabled 搬过来（**只读**，同 renderer.hand）
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
      // 第 8 层要读文字层开没开（spec §9.2 第 7 条）。同样是**只读**赋值：
      // 开关是 world.speechEnabled 这个运行时状态（§4.13.1.1 第 3 条：CONFIG 只是默认值），
      // 表现层不许为了「关掉之后什么都不画」而去改 CONFIG 或往世界里写任何东西。
      renderer.speechEnabled = world.speechEnabled !== false;
      // 水体的摆动时钟挂在视口对象上（updateMotes 读 viewport.time）。
      // 同一个对象被 main.js 原地改写，所以这里写回去不会造成任何额外分配。
      viewport.time = renderer.time;
      updateMotes(renderer.motes, viewport, dt);
      // 溶散粒子与水体同一个 dt（**模拟**秒，main.js 喂的那一个）：
      // 4× 倍速下动画也得跟着快，否则"溶散"在快进里变成一场永不结束的雪。
      updateBursts(renderer.bursts, dt);
      drawWater(ctx, renderer, viewport);
      // B16 的场景层：食物与卵在**缸底与水中**，所以画在生物之下（旧计划 Task 7 同序）。
      // 顺序在这里是可数的：本文件里只有食物用 arc、只有卵用 ellipse、只有本体 clip，
      // 由 tests/render-fx.test.js 的"arc 早于 ellipse 早于 clip"守住。
      drawFoods(ctx, renderer, world, viewport);
      drawEggs(ctx, renderer, world, viewport);
      // F-5：卵之后立刻补一层同色遮罩，把每颗的下沿埋进沙里。
      // 位置是判据：必须在卵之后（否则盖不住）、在生物之前（否则把个体也埋了）——
      // 两条都由 tests/render-fx.test.js 钉着。
      drawEggMask(ctx, world, viewport);
      // 生物层（spec §5.1 的六层：B14 的第 1/2/3/4/5/7 + B15 的第 6）。
      // 层序有意义：生物在水体**之上**；B15 的眼睛接在 drawCreature 内部（clip 之外），
      // B19 的气泡接在最后。手部层只汇总本帧的 beingPetted，不另判速度或接触。
      const creatures = world.creatures;
      renderer.petting = false;
      for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        if (c.beingPetted) renderer.petting = true;
        const b = bodies && bodies.get ? bodies.get(c.id) : undefined;
        if (b !== undefined) drawCreature(ctx, renderer, c, b, viewport);
      }
      renderer.petTime = renderer.petting && renderer.hand ? renderer.petTime + dt : 0;
      // 溶散/孵化的微粒在生物**之上**：它们是叠加光效，不是水里的实物
      // （微粒在身体下面画会被毛绒不透明的本体整个盖掉，等于没有那场散开）。
      drawBursts(ctx, renderer, viewport);
      // 玩家的手：在生物与粒子之上，但在语言气泡之下。
      drawHandLayer(ctx, renderer, viewport);
      // 第 8 层（spec §5.1）：语言气泡在**所有东西之上**，而它是本帧最后一段调用。
      // 这个位置是有判据的：tests/render-bubble.test.js 拿「关掉文字层之后的调用序列
      // 必须是开启那份序列的前缀」来断言其余七层逐笔不变 —— 气泡插在中间那条就废了。
      drawBubbleLayer(ctx, renderer, world, bodies, viewport);
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
  ga(ctx, R.shaftAlpha, 1);
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
    ga(ctx, m.a[i], 1);
    ctx.drawImage(src, screenX(m.x[i], viewport) - d, screenY(m.y[i], viewport) - d, d * 2, d * 2);
  }
  ctx.restore();
}
