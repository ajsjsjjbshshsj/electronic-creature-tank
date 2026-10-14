import { CONFIG } from './config.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const KEYS = ['hunger', 'energy', 'social', 'safety'];

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

  // 精力：休息时恢复；否则按是否移动分档消耗
  const energyRate = ctx.resting
    ? CONFIG.needs.energyRateRest
    : (ctx.moving ? CONFIG.needs.energyRateActive : CONFIG.needs.energyRateIdle);
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

export function comfort(needs, amount = CONFIG.needs.startleAmount) {
  needs.safety = clamp01(needs.safety - amount);
}

export function rest(needs, dt) {
  needs.energy = clamp01(needs.energy + CONFIG.needs.energyRateRest * dt);
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
