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

// 一阶（前向欧拉）趋近：e += (target - e) * min(1, inertia * dt)
//
// min(1, ...) 的作用是**防过冲与振荡**：没有它，dt 过大时步长系数会超过 1，
// 情绪会在目标值两侧来回摆动甚至发散。有了它，k 被夹在 [0,1]，
// 于是 e 永远是"旧值"与"目标值"的凸组合，一步之内到位且绝不越界。
// 这条性质有测试（'大 dt 不会导致振荡'）。
//
// ⚠️ 但这**不等于**"大 dt 一次算完"与"小 dt 分多步算"结果相同 —— 两者并不等价，
// 不要把它当成 src/needs.js 那种步长无关性来理解。前向欧拉的 k 与 dt 成正比，
// 而真正的指数趋近需要 k = 1 - exp(-inertia * dt)。实测（inertia = 1.6，
// 从 0 趋近 1，推进 1 模拟秒）：
//
//     60 步 × dt=1/60  →  0.8024
//      1 步 × dt=1    →  1.0000      （k 被 min 夹到 1，一步跳到目标）
//
// 所以本模块**刻意没有**"结果与时间步长无关"的测试，也不该有：那样一条测试
// 在当前公式下永远不可能通过，写出来只会是一条被迫放宽到毫无约束力的假断言。
// （计划 spec 追溯表把该测试列给了 Task 4，这一条已作为计划缺陷上报，见 task-4-report.md。）
//
// 为什么这不是 bug：Task 10 的 tickWorld(world, dt) 只是把 dt 透传下来，
// 真正的固定步长累加器在计划 2 的 main.js 里（计划 line 5688 明确：
// "Task 10 由计划 2 的 main.js 实现"），它把 dt 钉死在 CONFIG.fixedDt = 1/60。
// dt 恒定 ⇒ 结果确定可复现，这正是本项目要的性质。
//
// ⚠️ 给计划 2 的 main.js 的硬性要求：**timeScales（0.5/1/2/4）必须用"子步进"实现**，
// 即每帧跑 N 个 fixedDt 子步，绝不能改成把 dt 放大。若把 dt 放大到 4/60，
// 情绪推进会变成 0.8158 而非 0.8024（约 1.7% 偏差），4× 快进下的生物
// 会与 1× 下表现得不同 —— 而 needs.decay 是线性速率，不会有这个问题，
// 所以这个偏差只会出现在情绪层，格外难查。
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
//
// 用 Object.hasOwn 而不是 `!deltas` 判空：CONFIG.emotions.eventMagnitude 是普通对象字面量，
// 它的原型链上有 constructor / toString / valueOf / hasOwnProperty 等键，
// 那些键取出来都是真值，于是 `if (!deltas)` 拦不住它们 ——
// applyEvent(e, 'toString') 会静默地什么都不做（Object.entries(函数) 是空数组），
// 而本模块的契约是"未知事件必须抛错"。Task 9 的 behavior.js 会用意图名来派发事件，
// 一个拼错的字符串正好可能撞上这些原型键，届时无声无息、极难排查。
// 这与 src/rng.js 里 pick([]) 改为抛错、needs.mostUrgent 不返回 undefined 是同一类决定：
// 契约要覆盖全部输入，而不是只覆盖"看起来合理"的输入。
export function applyEvent(emotions, kind, scale = 1) {
  const deltas = Object.hasOwn(CONFIG.emotions.eventMagnitude, kind)
    ? CONFIG.emotions.eventMagnitude[kind]
    : undefined;
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
