// mulberry32：32 位状态、无依赖、快，周期足够本项目使用。
// 全部随机性必须经由本模块，绝不在其他模块调用 Math.random()，
// 否则"固定种子下决策可重现"这条测试要求就无法成立。
export function createRng(seed) {
  let s = (seed >>> 0) || 0x9E3779B9;   // 种子 0 会让 mulberry32 退化，换成黄金比例常数

  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller：每两个均匀数产出一个标准正态数。
  // 缓存第二个以免浪费 —— 变异需要大量高斯采样。
  let spare = null;
  const gaussian = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };

  return {
    next,
    gaussian,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // 派生独立子流：让"某只生物的行为随机"与"世界的食物随机"互不干扰，
    // 同时保持整体可复现。
    fork: () => createRng((s ^ Math.imul((next() * 0xFFFFFFFF) >>> 0, 0x85EBCA6B)) >>> 0),
  };
}
