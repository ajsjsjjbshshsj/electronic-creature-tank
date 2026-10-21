// needs.js —— 四条匮乏度（deprivation）随时间的线性积分，受基因性状调制。
//
// 模块级契约（Task 10 的 sim 是主要消费者，动这个文件之前先读）：
// 所有 mutator —— decay / feed / startle / comfort —— 都**原地修改**传入的 needs 对象，
// 并且**返回 undefined**。它们不返回新对象，也不复制。所以调用方必须写：
//
//   decay(c.needs, dt, c.traits, ctx);        // ✅ needs 被就地推进
//   c.needs = decay(c.needs, dt, c.traits, ctx);   // ❌ c.needs 变成 undefined
//
// 只有 createNeeds() 会产生新对象；mostUrgent() 是纯读函数，不修改入参。
//
// 精力匮乏的恢复没有单独入口：休息时把 ctx.resting 置真交给 decay，
// decay 会走 CONFIG.needs.energyRateRest 这条负速率分支。
import { CONFIG } from './config.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 从 createNeeds() 派生，而不是再抄一份键名。
// 早先这里是独立的字面量数组，靠注释提醒"两处一起改"—— 但注释挡不住漂移，
// 而漏改的后果是静默的：KEYS 少一条，mostUrgent() 就永远不会返回那条需求，
// 不报错、不抛异常，只是那条需求在行为评分里失去发言权。
// 派生之后这个失败模式在结构上不可能发生。
//
// 顺序即 mostUrgent() 的平局优先级（全零时返回第一个键 'hunger'），
// 而对象字面量的键序就是插入序，故 hunger > energy > social > safety：
// 饿死优先于累死、累死优先于孤独、孤独优先于不安。这条优先级被测试钉住。
const KEYS = Object.keys(createNeeds());

// 对外暴露同一份键表（不是再抄一遍字面量）：lexicon.NEED_WORDS 的键与 heard 的 boundNeed
// 都要按它校验。两处各列一份迟早漂移，而漏掉一条需求的症状是
// 「那条需求永远不被说出口、也永远想不起来」—— 不报错，只是少一档。
export const NEED_KEYS = Object.freeze(KEYS);

// 初值刻意不是全 0：新孵化的幼体带一点饥饿，好让它立刻开始觅食，
// 玩家不必干等两分钟才看到第一个行为。
export function createNeeds() {
  return { hunger: 0.15, energy: 0.1, social: 0.1, safety: 0 };
}

// 所有速率都是"每秒线性变化"，因此结果与时间步长严格无关（除非触发 clamp）。
// 这是 spec 3.4 第 1 条"固定步长积分"能在需求层成立的前提。
// ctx: { moving: boolean, resting: boolean, companions: number }
export function decay(needs, dt, traits, ctx) {
  const p = traits.personality;

  // 饥饿：体型越大、越贪吃，消耗越快
  const sizeFactor = 0.7 + (traits.size / CONFIG.maxSize) * 0.6;
  const gluttonFactor = 0.7 + p.gluttonous * 0.6;
  needs.hunger = clamp01(
    needs.hunger + CONFIG.needs.hungerRate * sizeFactor * gluttonFactor * dt,
  );

  // 精力：休息时恢复；否则按是否移动分档消耗。
  // 恢复的唯一入口就是这里的 ctx.resting 分支（energyRateRest 是负速率）——
  // 不要再另开一个 rest() 之类的快捷函数，那会让"只调它"冻结另外三条需求、
  // "两个都调"把精力恢复跑成 2 倍速。
  // 好动的个体把精力掉得更快（ctx.drainFactor 来自 thresholds.energyDrainFactor，默认 1.2）。
  // 休息那一支**不乘** —— 恢复速率是"睡着有多快"，与性格好动与否无关，乘上去会让话痨/好动者反而睡得更慢。
  const drain = ctx.drainFactor === undefined ? 1 : ctx.drainFactor;
  const energyRate = ctx.resting
    ? CONFIG.needs.energyRateRest
    : (ctx.moving ? CONFIG.needs.energyRateActive * drain : CONFIG.needs.energyRateIdle * drain);
  needs.energy = clamp01(needs.energy + energyRate * dt);

  // 社交：有同伴在场则大幅抑制匮乏
  const clingyFactor = 0.6 + p.clingy * 0.8;
  const relief = ctx.companions > 0 ? (1 - CONFIG.needs.socialRelief) : 1;
  needs.social = clamp01(
    needs.social + CONFIG.needs.socialRate * clingyFactor * relief * dt,
  );

  // 安全感：只随时间自然恢复；冲击走 startle()，安抚走 comfort()
  const boldFactor = 0.5 + p.bold;
  needs.safety = clamp01(needs.safety - CONFIG.needs.safetyRecover * boldFactor * dt);
}

export function feed(needs, amount = CONFIG.needs.feedAmount) {
  needs.hunger = clamp01(needs.hunger - amount);
}

export function startle(needs, amount = CONFIG.needs.startleAmount) {
  needs.safety = clamp01(needs.safety + amount);
}

// 默认份量刻意复用 startleAmount，不另设 comfortAmount：
// 设计意图是"一次安抚恰好抵消一次惊吓"—— 玩家温柔地摸一下，
// 应当正好抹平刚才戳一下造成的不安，两者是同一件事的正反面。
//
// 因此改 startleAmount 会**同时**改变这两个方向：想让戳更吓人，
// 就会让摸也更有效。这不是疏忽，是耦合得有意的；若要打破这种对称，
// 需要同时改这里、改 spec 的交互章节、并补一条钉住两者比例的测试。
export function comfort(needs, amount = CONFIG.needs.startleAmount) {
  needs.safety = clamp01(needs.safety - amount);
}

// 返回最匮乏的一条。全零时返回 'hunger' 作为稳定默认值，
// 避免调用方拿到 undefined 然后在 switch 里静默落空。
//
// 注意（spec 4.4）：mostUrgent 只是给 behavior 的一个提示信号，
// 它不直接决定行为，也没有一票否决权。
export function mostUrgent(needs) {
  let best = 'hunger';
  let bestV = needs.hunger;
  for (const k of KEYS) {
    if (needs[k] > bestV) { bestV = needs[k]; best = k; }
  }
  return best;
}
