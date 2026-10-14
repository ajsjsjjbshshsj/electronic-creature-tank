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
//
// 两个数组都冻结：它们会被 Task 9 / Task 10 导入，而一次意外的就地
// .sort() / .push() / .reverse() 会静默改变分量集合或 dominant() 的平局顺序
// （严格 > 配 bestV=0 起手 ⇒ 平局取数组中靠前者）。这与 src/config.js 深冻结
// 共享常量、src/genes.js 冻结四个导出基因数组是同一条纪律。
// 实测冻结前 push / sort 都静默成功，冻结后都抛 TypeError。
export const EMOTION_KEYS = Object.freeze(
  ['joy', 'anger', 'fear', 'curiosity', 'sleepy', 'arousal'],
);
export const EVENT_KINDS = Object.freeze(Object.keys(CONFIG.emotions.eventMagnitude));

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
//     60 步 × dt=1/60  →  0.802441      （k 线性形式）
//     60 步 × dt=1/60  →  0.798103      （k 指数形式，差 0.54%）
//      1 步 × dt=1    →  1.000000      （k 被 min 夹到 1，一步跳到目标）
//
// 所以本模块**刻意没有**"结果与时间步长无关"的测试，也不该有：那样一条测试
// 在当前公式下永远不可能通过，写出来只会是一条被迫放宽到毫无约束力的假断言。
// 取而代之的是一条**特征化测试**（'update 的步长非等价性被如实钉住'），
// 它断言的是这个不等价本身，并把幅度量化 —— 改公式会让它变红，
// 提醒改动者同步这里的所有数字。
//
// 前向欧拉不是疏漏而是 brief 逐字指定的形式，改成指数形式属于计划级决定。
// 它之所以安全：dt 在运行时恒为 CONFIG.fixedDt = 1/60，dt 恒定 ⇒ 结果确定可复现。
// 固定步长累加器与倍速（timeScales）的实现要求记在计划里，不在这里 ——
// 源码注释不是跨计划交接的载体，它会腐烂且没有任何东西能强制它。
export function update(emotions, targets, dt) {
  const k = Math.min(1, CONFIG.emotions.inertia * dt);
  for (const key of EMOTION_KEYS) {
    // 防御性 clamp，在当前所有调用路径上**不可达**：两个操作数恒在 [0,1]
    // （createEmotions 给 0，computeTargets 的六个输出各自过了 clamp01），
    // k 又被 min 夹在 [0,1]，凸组合不可能越界。删掉它测试依然全绿 ——
    // 这是刻意的，我们不为不可达分支伪造测试。
    // 对比：applyEvent 里那个 clamp 是**承重**的（事件冲击可以叠加越界），
    // 删掉它会有两条测试变红。这个不对称值得写下来，否则下一个人
    // 要么误以为它有保护，要么在没有依据的情况下把它删掉。
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
  // 先判自有属性再取一次值：Object.hasOwn 排除了原型链上的
  // constructor / toString / valueOf / hasOwnProperty 等键（它们取出来是真值，
  // `!deltas` 拦不住，会让 applyEvent 静默地什么都不做而不抛错）。
  // 不再保留 `!deltas` 兜底：hasOwn 为真时取到的必然是配置里写的对象，
  // 而"自有属性但值为 null"是 CONFIG 自身的配置错误，不该被报成"未知情绪事件"。
  if (!Object.hasOwn(CONFIG.emotions.eventMagnitude, kind)) {
    throw new Error(`未知情绪事件: ${kind}`);
  }
  const deltas = CONFIG.emotions.eventMagnitude[kind];
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
