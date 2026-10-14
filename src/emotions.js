// emotions.js —— 六分量并存情绪向量：惯性趋近目标 + 事件即时冲击。
//
// 模块级契约（Task 10 的 sim 是主要消费者，动这个文件之前先读）：
// update() 与 applyEvent() 都**原地修改**传入的 emotions 对象并**返回 undefined**，
// 与 src/needs.js 的 mutator 形状一致。所以调用方必须写：
//
//   update(c.emotions, targets, dt);            // ✅ emotions 被就地推进
//   c.emotions = update(c.emotions, targets, dt);  // ❌ c.emotions 变成 undefined
//
// 但 targets 是**只读**入参，update 绝不碰它 —— Task 10 会跨帧复用同一个目标向量，
// 若目标跟着当前值一起漂移，情绪就永远追不上也永远不平复，且全程不报错。
// computeTargets() / dominant() / secondary() 是纯读函数：createEmotions() 与
// computeTargets() 各自产生新对象，其余两个只返回值，都不修改入参。
//
// 关键设计（spec 4.5）：六个分量**可以并存**。这不是一个状态机的六个状态，
// 而是一只生物同时"害怕 0.7 + 好奇 0.4"—— 想靠近又不敢。因此任何一处
// "进入某个情绪就把其他分量清零"的写法都是把本模块的设计前提推翻：
// 表现层靠 dominant() 决定主表现、靠 secondary() 决定泄漏出来的那一层，
// 清零会让 secondary 在每次事件后闪回 null，"害怕地缩着却还是微微往前探了一点"
// 这个读得懂的身体语言就消失了。
//
// 注意 affection（依恋/卖萌）**不在**这里：它是 memory 里针对特定对象的
// 关系性数值（"依恋谁"是关于一段关系的，不是关于当下状态的），见 spec 4.5。
import { CONFIG } from './config.js';

// 恰好六个分量。affection 不在这里 —— 它是 memory 的关系性数值（spec 4.5）。
export const EMOTION_KEYS = ['joy', 'anger', 'fear', 'curiosity', 'sleepy', 'arousal'];
export const EVENT_KINDS = Object.keys(CONFIG.emotions.eventMagnitude);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createEmotions() {
  const e = {};
  for (const k of EMOTION_KEYS) e[k] = 0;
  return e;
}

// 由需求与情境推导"情绪应该趋向哪里"。
// ctx: { pleasure, provocation, threat, novelty, canBreed }
//
// arousal 由 canBreed 一票门控：亚成体与老年个体不该有求偶欲。
// canBreed 的判定在 creature.canBreed（看阶段与年龄），本模块只负责"给了就能算"。
export function computeTargets(needs, ctx, traits) {
  const p = traits.personality;
  const satisfied = 1 - needs.hunger;
  return {
    joy: clamp01(satisfied * 0.35 + ctx.pleasure * 0.65),
    // 烦躁主要来自被招惹；极饿时额外叠一层"饿到发脾气"
    anger: clamp01(
      ctx.provocation * (0.55 + p.irritable * 0.45) + (needs.hunger > 0.7 ? 0.2 : 0),
    ),
    // bold 高 → 同样威胁下更不害怕
    fear: clamp01(needs.safety * 0.7 + ctx.threat * (0.5 - p.bold * 0.25)),
    curiosity: clamp01(ctx.novelty * 0.6 + p.curious * 0.4),
    sleepy: clamp01(needs.energy),
    arousal: ctx.canBreed
      ? clamp01(satisfied * 0.45 + (1 - needs.energy) * 0.3 + p.libido * 0.25)
      : 0,
  };
}

// 一阶指数趋近：e += (target - e) * min(1, inertia * dt)
//
// min(1, ...) 是关键：没有它，dt 过大时步长系数会超过 1，
// 情绪会在目标值两侧来回振荡而不是收敛。这也让"大 dt 一次算完"
// 与"小 dt 分多步算"给出同样的稳定结果。
export function update(emotions, targets, dt) {
  const k = Math.min(1, CONFIG.emotions.inertia * dt);
  for (const key of EMOTION_KEYS) {
    emotions[key] = clamp01(emotions[key] + (targets[key] - emotions[key]) * k);
  }
}

// 事件冲击：立即生效，绕过惯性。
// 这才有"被戳一下瞬间炸毛"的手感；若走惯性，冲击会被平滑得毫无反应。
//
// 只写 deltas 里声明的分量，其余分量原样保留 —— 事件冲击同样必须尊重"并存"：
// 一只"害怕 0.7 + 好奇 0.4"的生物挨一吓之后，那份好奇不该被抹掉。
export function applyEvent(emotions, kind, scale = 1) {
  const deltas = CONFIG.emotions.eventMagnitude[kind];
  if (!deltas) throw new Error(`未知情绪事件: ${kind}`);
  for (const [key, delta] of Object.entries(deltas)) {
    emotions[key] = clamp01(emotions[key] + delta * scale);
  }
}

export function dominant(emotions) {
  let best = null;
  let bestV = 0;
  for (const k of EMOTION_KEYS) {
    if (emotions[k] > bestV) { bestV = emotions[k]; best = k; }
  }
  return best;
}

// 次要情绪只有在"够强"时才算存在，否则表现层会泄漏出一个实际上
// 并不成立的情绪（joy 0.8 + fear 0.05 不该看起来又开心又害怕）。
// 阈值取主导值的一半 —— 这是"害怕地缩着却还是往前探了一点"能成立的边界。
export function secondary(emotions) {
  const first = dominant(emotions);
  if (first === null) return null;
  const firstV = emotions[first];
  let best = null;
  let bestV = 0;
  for (const k of EMOTION_KEYS) {
    if (k !== first && emotions[k] > bestV) { bestV = emotions[k]; best = k; }
  }
  return bestV >= firstV * 0.5 ? best : null;
}
