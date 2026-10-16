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
    // 从数组里等概率取一个元素。
    // 空数组必须抛错：Math.floor(next() * 0) 恒为 0，于是 arr[0] 会安静地给出
    // undefined，同时还白白消费一次抽取。后续 Task 会从"可能合法为空"的候选集
    // 里 pick（食物、求偶对象），一个静默的 undefined 会在离病因很远的地方才炸。
    // 与本模块既有的失败哲学一致 —— createRng 宁可换常数也不肯退回不可复现的随机源。
    pick: (arr) => {
      if (arr.length === 0) {
        throw new Error('pick() 收到空数组：候选集为空时请由调用方显式处理，不要依赖 undefined');
      }
      return arr[Math.floor(next() * arr.length)];
    },
    chance: (p) => next() < p,
    // 派生子流：用父流当前状态 s 与一次抽取混合出一个新种子，使整体仍然可复现。
    //
    // 但它给的不是密码学意义上的"互不干扰"，别把它当独立随机源看待：
    // mulberry32 的状态更新是 s += 0x6D2B79F5（一个奇数），加法在 mod 2^32 下可逆，
    // 所以任何种子都在同一条 2^32 长的环上行走，只是起始相位不同。
    // 也就是说，同一个父流 fork 出的两个子流会输出同一条环状序列的两个不同偏移 ——
    // 只要抽得够久，它们必然会撞上彼此的值。
    //
    // 为什么这在本项目里不成问题：0x85EBCA6B 这个乘法混合器把种子打散得足够均匀，
    // 两个子流的期望相位差在 2^31 次抽取量级。一个缸从生成到寿终也就跑几万次抽取，
    // 与 2^31 相差四个数量级以上，实际消费不到环的可见部分。
    // 结论：可复现、实践中足够错开；需要真正独立的流请换算法，不要靠 fork。
    fork: () => createRng((s ^ Math.imul((next() * 0xFFFFFFFF) >>> 0, 0x85EBCA6B)) >>> 0),
  };
}
