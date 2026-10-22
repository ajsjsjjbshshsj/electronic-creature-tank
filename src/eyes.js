// eyes.js —— 眼睛四参数与 spec §4.6 那张十行表。**纯函数模块**。
//
// 为什么单独立一个文件而不是写进 render.js（旧计划 Task 6 是写在 render.js 里的）：
// 这一层的全部内容都是"给定情绪 / 心情 / 性格 → 眼睛该是什么样"的映射，
// 是这个项目最值得断言的纯数学。塞进 render.js 就只能靠记录型桩数调用次数，
// 表里的每一个数值都断言不到 —— 把 happyLid 从 0.30 改成 0.80 会让"开心"不再眯眼，
// 画面只是"没那么可爱"，没有任何一条测试会红。做成纯函数之后，
// 那张表的每一行都由 tests/eyes.test.js 钉住，而 render.js 只负责把它们画出来。
//
// 三条边界（每条都有测试钉着，不是注释里的愿望）：
//
// 1. **不碰浏览器 API**：七个全局标识符一个都不许出现（tests/constraints.test.js 全量扫 src/）。
//    本模块连 ctx 都不需要 —— 它返回数，不画图。
// 2. **不读 world**：世界状态只能由参数进来（creature / 手在局部空间的方向）。
//    表现层唯一的写入例外是 world.playerHand，而那是 input 层的事，与眼睛无关。
// 3. **心情每帧现算，绝不写回**：moodOf 是纯函数，本模块调它、用它的返回值选那一格，
//    但 creature 上不会长出 `c.mood` 这个字段（spec §4.5.1："谁都不许把它当状态写回去，
//    那是刚被否决过的互斥状态机"）。由 tests/eyes.test.js 的键集快照守住。
//
// ⚠️ 2026-10-20 的四条新增裁定在本文件里的落点：
//   裁定 1（快乐 ^^ 与 幸福 星星眼 分家）→ `mood === 'happy'` 与 `mood === 'bliss'` 两支，
//          星星眼只认 moodOf 的 bliss 档，**不看 joy 自己**。稀有才是奖赏。
//   裁定 2（委屈眼是独立形态，不是 fear 的复用）→ sad 那一支写 lowerLidRaise / sadHighlightY，
//          而 fear 由 fear **分量**连续驱动，写 eyeSize 收缩 + 小瞳孔。两者没有任何一个读数共用。
//   裁定 3（瞳孔仍然 #2D1240）→ pupilColor() 只是 CONFIG.colors.pupil 的别名，画的那一侧只能拿到它。
//   裁定 4（眨眼频率是性格的读出通道）→ blinkPeriod 取 body.js 的 blinkInterval(activity)，
//          **不在这里重抄那条公式**（有两个定义点就会分家）。
//
// ⚠️ "玩家手指在附近时 facing 会缓慢转向它"（spec §4.6 末段）**没有在这里实现**：
// facing 是内核状态，只在 behavior.moveToward 里被更新，而表现层不许写世界状态。
// 本模块能实现的只有那半句读得到的部分 —— 瞳孔朝手偏移（lookX / lookY）与 slow blink。
import { CONFIG } from './config.js';
import { moodOf, createEmotions } from './emotions.js';
import { createNeeds } from './needs.js';
import { createMemory, affectionFor, PLAYER_ID } from './memory.js';
import { blinkInterval, starRadius } from './body.js';

const E = CONFIG.eye;
const TAU = Math.PI * 2;

// 三个兜底实例只在"入参残缺"（脏存档 / 单测传了个空对象）时被用到，
// 建在模块顶层 ⇒ 正常运行路径上一次分配都没有（spec §5.3）。
const FALLBACK_EMOTIONS = createEmotions();
const FALLBACK_NEEDS = createNeeds();
const FALLBACK_MEMORY = createMemory();
const NO_OPTS = {};
const NO_CREATURE = {};
// moodOf 的第四个参数需要一个对象。它是**只读**入参（tests/emotions.test.js 钉着
// "moodOf 不修改任何入参"），所以复用一个模块级对象、每次写 adversity 再调用，
// 比每帧 new 一个字面量便宜且不改变结果。
const MOOD_CTX = { adversity: false };

const num = (v) => (Number.isFinite(v) ? v : 0);
const c01 = (v) => {
  const x = num(v);
  return x < 0 ? 0 : x > 1 ? 1 : x;
};
const clamp11 = (v) => {
  const x = num(v);
  return x < -1 ? -1 : x > 1 ? 1 : x;
};
const clampRange = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// -0 会在 assert.equal（Object.is 语义）下与 0 判成不同，而下面那些
// `x * 0` 的乘法在情绪分量为 0 时**恰好**产出 -0（负常数 × 0）。统一抹成 +0。
const pos0 = (v) => (v === 0 ? 0 : v);
const fract = (v) => v - Math.floor(v);

// 眨眼相位由 id 哈希推出：**不用随机数**（全局纪律），也不用下标（同一只生物在
// 数组里换位置就会突然换相位）。质数取模保证相位落在 [0,1)。
// 全缸同时眨一次眼的画面是"一群机械玩具"，这条就是防它。
function phaseOf(id) {
  if (typeof id !== 'string' || id.length === 0) return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h + id.charCodeAt(i) * (i + 1)) % E.phaseModulus;
  }
  return h / E.phaseModulus;
}

// ---------------------------------------------------------------- 四参数 + 十行表

// opts：
//   intentKind  覆盖 c.intent.kind（真实调用不必给，render.js 让函数自己读）
//   handLocal   { x, y }：玩家的手在这只生物**局部空间**的单位方向
//               （x 沿 facing，y 沿垂直方向）。手不在或太远 ⇒ null。
export function eyeParamsFor(c, t, opts) {
  return computeEyes({}, c, t, opts);
}

// 零分配变体：把结果写进调用方复用的对象。render.js 每帧每只都走这条路（spec §5.3）。
// ⚠️ 两个入口共用 computeEyes，**不许**各写一套计算 —— 否则测的就不是跑的。
export function eyeParamsInto(out, c, t, opts) {
  return computeEyes(out, c, t, opts);
}

function computeEyes(out, creature, t, opts) {
  const c = creature || NO_CREATURE;
  const o = opts || NO_OPTS;
  const emo = c.emotions || FALLBACK_EMOTIONS;
  const needs = c.needs || FALLBACK_NEEDS;
  const memory = c.memory || FALLBACK_MEMORY;

  const joy = c01(emo.joy);
  const anger = c01(emo.anger);
  const fear = c01(emo.fear);
  const curiosity = c01(emo.curiosity);
  const sleepy = c01(emo.sleepy);
  const arousal = c01(emo.arousal);
  const aff = c01(affectionFor(memory, PLAYER_ID));
  const intentKind = o.intentKind !== undefined
    ? o.intentKind
    : (c.intent ? c.intent.kind : null);
  const handLocal = o.handLocal || null;

  // 心情每帧现算（纯函数）。⚠️ 不写回 creature。
  MOOD_CTX.adversity = num(c.mourn) > 0;
  const mood = moodOf(emo, needs, memory, MOOD_CTX);
  const G = E.leakGain;

  // ---- 分量层：六个连续分量对四参数的贡献（spec §4.5："情绪可以并存"）
  //
  // 这里**加权叠加**而不是"取主导情绪的整行"：一只生物可以同时害怕 0.7 + 好奇 0.4，
  // 取整行会让表情在 dominant() 翻转的那一帧跳变，而叠加是连续的。
  //
  // ⚠️ 瞳孔用的是**逐格向该格的名义值收敛**（`pupil += (目标 − pupil) × 分量`），
  // 不是"目标减中性再乘分量"的加法形式。差别在能不能钉住 spec 逐字的那几个数：
  // 加法下 fear=1 时 joy 的 0.06 还留在瞳孔上，实测就成了 0.22 而不是 spec 的 ≈0.15；
  // 收敛形式在某个分量取满时**恰好**落在它那一格的读数上，而中间值仍然连续。
  let p = E.neutralPupil;
  p += (E.happyPupil - p) * joy;
  p += (E.angerPupil - p) * anger;
  p += (E.fearPupil - p) * fear;
  p += (E.curiosityPupil - p) * curiosity;
  p += E.arousalPupil * arousal;              // 兴奋：叠加层，不属于任何一格的名义值
  const compPupil = p;
  const compLid = 1 - (1 - E.sleepyLid) * sleepy - (1 - E.angerLid) * anger;
  const compSpacing = E.spacing + E.angerSpacing * anger;
  const compOffset = E.fearOffset * fear + E.curiosityOffset * curiosity;
  const compTopLid = E.angerTopLid * anger;
  const compSize = 1 - E.fearShrink * fear;
  const compAsym = E.curiosityAsym * curiosity;

  let pupil = compPupil;
  let lid = compLid;
  let spacing = compSpacing;
  let offset = compOffset;
  let topLid = compTopLid;
  let lowerLid = 0;
  let size = compSize;
  let asym = compAsym;
  let hlX = E.highlightX;
  let hlY = E.highlightY;
  let offsetY = 0;
  let star = 0;
  let squint = 0;

  // ---- 十行表：三格由**心情档**决定（裁定 1 与裁定 2 的主场），
  //      anger / fear / curiosity / sleepy 四格由**情绪分量**连续决定
  //      （它们的名义值在分量取满 1 时恰好等于 spec 逐字给的数），
  //      卖萌由 intent 决定，信任由 手 + 好感 决定，死亡由 alive 决定。
  if (mood === 'sad') {
    // 委屈眼：下眼睑上抬 + 含泪高光。**不是**上眼睑下垂，也**不是**害怕的收缩瞪圆。
    pupil = E.sadPupil + (compPupil - E.neutralPupil) * G;
    lid = E.sadLid + (compLid - 1) * G;
    spacing = E.spacing + E.sadSpacing + (compSpacing - E.spacing) * G;
    offset = E.sadOffset + compOffset * G;
    lowerLid = E.sadLowerLid;
    topLid = 0;
    hlY = E.sadHighlightY;
    size = 1 + (compSize - 1) * G;
    asym = compAsym * G;
  } else if (mood === 'bliss') {
    // 星星眼：四角星瞳孔，随 arousal 轻微旋转与缩放。
    // ⚠️ 判据只有这一个：moodOf 的 bliss 档（joy 高 + 四条需求全低 + 对玩家好感高）。
    //    谁若在这里改成 `joy > CONFIG.mood.happyJoyMin`，星星眼就从奖赏变成常态，
    //    tests/eyes.test.js 那 48 个人设的对照断言会当场红。
    star = 1;
    pupil = E.blissPupil + (compPupil - E.neutralPupil) * G;
    lid = E.blissLid + (compLid - 1) * G;
    spacing = E.spacing + (compSpacing - E.spacing) * G;
    offset = compOffset * G;
    topLid = compTopLid * G;
    lowerLid = 0;
    size = 1 + (compSize - 1) * G;
    asym = compAsym * G;
    hlY = E.highlightY;
  } else if (mood === 'happy') {
    // ^^ 眯弧：开合从"睁着"连续眯到 happyLid，跨过 happyJoyMin 不会跳一档。
    const band = 1 - CONFIG.mood.happyJoyMin;
    squint = c01((joy - CONFIG.mood.happyJoyMin) / band);
    pupil = compPupil;
    lid = 1 - (1 - E.happyLid) * squint + (compLid - 1) * G;
    spacing = compSpacing;
    offset = compOffset;
    topLid = compTopLid;
    size = compSize;
    asym = compAsym;
  }
  // calm / anger 落到这里：分量层算出来的就是最终值（anger 那一格本来就在里面）。

  // 卖萌（spec §4.6 表里"卖萌"那一行；触发条件在 behavior.begScore 里，不在这里重判）
  if (intentKind === 'beg') {
    pupil = E.begPupil;
    if (lid < E.begLid) lid = E.begLid;
    offsetY = -E.begLiftY;
    squint = 0;
  }

  // 死亡（spec §4.6 最后一行）：lidOpen → 0，而且要"缓缓"。
  // 优先级最高：卖萌 / 幸福 / 好奇都不许让已经断了气的眼睛还睁着。
  const alive = !!c.alive;
  let blink = 0;
  if (!alive) {
    const close = c01(num(c.dying) / E.deathCloseSeconds);
    lid *= 1 - close;
    lowerLid = 0;
    topLid = 0;
    squint = 0;
    star = 0;
    offsetY = 0;
    // 左右不对称也一并归零：否则一只好奇的尸体在 lidOpen 已经到 0 之后，
    // lidOpenL = lid + asym/2 仍然 > 0，画的那一侧"闭眼"就闭不彻底
    // （tests/render-body.test.js 那条"闭眼时整层跳过"就是这么抓到的）。
    asym = 0;
  }

  // ---- 眨眼：频率是性格的读出通道（裁定 4，公式只在 body.js 里有一份）
  const personality = c.traits ? c.traits.personality : null;
  const activity = c01(personality ? personality.activity : 0);
  let period = blinkInterval(activity);
  period *= 1 + (E.sleepyBlinkStretch - 1) * sleepy;
  const trustLook = handLocal !== null && aff >= E.trustAffectionMin;
  if (trustLook) period *= E.trustBlinkStretch;      // 猫的 slow blink：更慢的一次
  if (!(period > 0)) period = 1;                     // 脏值兜底：0 周期会让下面的除法出 Infinity
  const phase = phaseOf(c.id);
  const time = num(t);
  if (alive) {
    // 三角波而不是正弦：眨眼要"快闭快开、中间不停顿"，正弦波看起来像在持续抽搐。
    const u = fract(time / period + phase);
    const half = E.blinkWaveFrac / 2;
    if (u < half) blink = u / half;
    else if (u < E.blinkWaveFrac) blink = 1 - (u - half) / half;
  }

  // ---- 瞳孔朝手偏移（spec §4.6 "看着玩家的手"里**表现层做得到**的那半句）
  let lookX = 0;
  let lookY = 0;
  if (handLocal) {
    const trustGain = E.lookTrustMin + (1 - E.lookTrustMin) * aff;
    lookX = clamp11(handLocal.x) * E.lookMax * trustGain;
    lookY = clamp11(handLocal.y) * E.lookMax * trustGain;
  }

  // ---- 星星眼的旋转与缩放：arousal 是振幅，时间是相位。两者都必须"轻微"。
  const sway = Math.sin(TAU * (time / E.starSpinPeriod) + phase * TAU);
  const starSpin = star * E.starSpinMax * arousal * sway;
  const starScale = 1 + star * E.starScaleMax * arousal * ((1 + sway) / 2);

  out.pupilSize = clampRange(pupil, E.pupilMin, E.pupilMax);
  out.lidOpen = pos0(c01(lid));
  out.lidOpenL = c01(lid + asym / 2);
  out.lidOpenR = c01(lid - asym / 2);
  out.eyeSpacing = pos0(spacing > 0 ? spacing : 0);
  out.eyeOffset = pos0(offset);
  out.eyeOffsetY = pos0(offsetY);
  out.topLidPress = c01(topLid);
  out.lowerLidRaise = c01(lowerLid);
  out.highlightX = hlX;
  out.highlightY = hlY;
  out.star = star;
  out.starPoints = E.starPoints;
  out.starSpin = pos0(starSpin);
  out.starScale = starScale;
  out.eyeSize = size < E.eyeSizeMin ? E.eyeSizeMin : size;
  out.squintArc = pos0(c01(squint));
  out.blink = pos0(c01(blink));
  out.blinkPeriod = period;
  out.phase = phase;
  out.lookX = pos0(lookX);
  out.lookY = pos0(lookY);
  out.mood = mood;
  return out;
}

// ---------------------------------------------------------------- 几何（仍是纯数学）

export function eyeAnchorsFor(p, r, facing) {
  return computeAnchors({ lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 }, p, r, facing);
}

export function eyeAnchorsInto(out, p, r, facing) {
  return computeAnchors(out, p, r, facing);
}

// spec §4.6 的坐标定义：眼睛长在 facing 那一侧，沿**垂直于 facing** 的方向左右分开，
// 所有"前 / 后"都是沿 facing 的偏移。返回的是**相对体心的位移**（CSS 像素），
// 画的那一侧只负责加上 cx / cy —— 基向量的换算留在这里才测得到（见 tests/eyes.test.js）。
// F-2（B20 真像素确认）：把一只眼**沿"体心 → 眼心"这条射线**收回星形轮廓之内，返回缩放系数 k。
//
// 为什么要有这道兜底：表情修正项是在**facing 相对坐标**里加的，而轮廓半径是角的
// **非单调**函数（36° 内凹 0.62、72° 又是臂尖 1.0）。于是"动一个常量就把某只眼推到臂外面"
// 是这套加法的固有性质 —— 扫遍 (forward × spacing × sadSpacing) 的 105 个组合，
// 能同时满足"不出界 + 两眼不相碰 + 后移不越过中心线"的是 **0 个**。常量只能挑到"现在不出界"，
// 挑不出"以后也出不了界"。
//
// 但它**只是安全网，不是常规路径**：k 在真实表情集合上必须恒等于 1（下面那条断言钉着），
// 因为径向缩放会同时动两个轴，一旦 binding 就破坏 spec §4.6 的坐标契约
// （"eyeSpacing 只动垂直轴 / eyeOffset 只动沿 facing 轴" —— tests/eyes.test.js 有两条测它）。
// 角度必须在 **facing 相对系**里算（星臂与 facing 是绑死的，本体点也用同一个 facing 旋转），
// 在屏上算会在 facing 一转之后用错角度。
// 只收不推（k ≤ 1）：修正项的**方向**全部保留，被抹掉的只有"出界"这一种后果。
// 返回系数而不是改坐标，是为了让调用点零分配（本函数每帧每只都跑，spec §5.3）。
function fitK(u, v, eyeR, r) {
  const dist = Math.hypot(u, v);
  if (!(dist > 0)) return 1;                  // 与体心重合：方向未定义，原地不动
  const limit = starRadius(Math.atan2(v, u)) * r - eyeR - E.fitMargin * r;
  return limit >= dist ? 1 : Math.max(0, limit) / dist;
}

function computeAnchors(out, p, r, facing) {
  const d = r * 2;
  const fx = facing && Number.isFinite(facing.x) ? facing.x : 1;
  const fy = facing && Number.isFinite(facing.y) ? facing.y : 0;
  const size = p.eyeSize < E.eyeSizeMin ? E.eyeSizeMin : p.eyeSize;
  // 单只眼睛的直径 = 体直径 × CONFIG.eyeWidthRatio（spec §4.6 "约占身体宽度的 28%"）
  out.eyeR = d * CONFIG.eyeWidthRatio * size / 2;
  const fwd = E.forward * d + num(p.eyeOffset) * r;
  const sep = num(p.eyeSpacing) * d / 2;
  const px = -fy;
  const py = fx;
  const lift = num(p.eyeOffsetY) * r;
  // 屏空间的"上望"折进 facing 相对系：world 偏移 (0, lift) 在该系里是 (lift·fy, lift·fx)。
  const lu = fwd + lift * fy;
  const lv = -sep + lift * fx;
  const ru = fwd + lift * fy;
  const rv = sep + lift * fx;
  const kl = fitK(lu, lv, out.eyeR, r);
  const kr = fitK(ru, rv, out.eyeR, r);
  out.lx = pos0(fx * lu * kl + px * lv * kl);
  out.ly = pos0(fy * lu * kl + py * lv * kl);
  out.rx = pos0(fx * ru * kr + px * rv * kr);
  out.ry = pos0(fy * ru * kr + py * rv * kr);
  return out;
}

// ---------------------------------------------------------------- 腮红（第 6 层的后半格）

export function blushFor(creature) {
  const c = creature || NO_CREATURE;
  const emo = c.emotions || FALLBACK_EMOTIONS;
  if (!c.alive) return { alpha: 0, radius: 0, offsetPerp: 0, offsetAlong: 0, offsetY: 0 };
  const intentKind = c.intent ? c.intent.kind : null;
  let alpha = E.blushAlpha + E.blushJoyBoost * c01(emo.joy);
  if (intentKind === 'beg') alpha += E.blushBegBoost;
  if (alpha > E.blushMax) alpha = E.blushMax;
  return {
    alpha,
    radius: E.blushRadius,
    offsetPerp: E.blushOffsetX,
    offsetAlong: E.blushAlong,
    offsetY: E.blushOffsetY,
  };
}

// ---------------------------------------------------------------- 取色与取比例的别名
//
// 画的那一侧（render.js）只能通过这些函数拿到颜色与比例 —— 它们看着多余，
// 但有了这一层，"瞳孔不许写纯黑""眼睛比例不许写死 0.28"才是可以被断言的事，
// 而不是靠评审记住。返回值**必须**就是 CONFIG 里那个常量本身。
export function pupilColor() { return CONFIG.colors.pupil; }
export function eyeWhiteColor() { return CONFIG.colors.eyeWhite; }
export function eyeHighlightColor() { return CONFIG.colors.eyeHighlight; }
export function blushColor() { return CONFIG.colors.blush; }
export function eyeWidthOf() { return CONFIG.eyeWidthRatio; }
