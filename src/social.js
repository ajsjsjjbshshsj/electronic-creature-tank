// 社交同步的纯层：谁能同步、同步到什么程度、计时怎么推进。
// spec §4.12 第 6 条把原「求偶仪式」里最动人的那半画面（脉动同步）搬到了 socialize 上，
// 这一层就是它的判据与计时；接线在 sim.js 的 tickSocial，设计文档是
// docs/superpowers/specs/2026-10-27-social-bond-sync-design.md（六条裁定都在那里）。
//
// 本模块**只碰三个字段**（c.bondId / c.bondSync / c.bondTotal），都是瞬时态、不入档
// （save.js 的 CREATURE_SKIP_FIELDS）。关系事实住在 memory 里（role:'companion'），不在这里。
//
// 为什么单独一个模块而不是塞进 sim.js：门控有五个条件，而调参时唯一想知道的是
// "这一次是哪一条挡住了"。塞进 O(n²) 的世界循环里，就没法在 Node 里单独断言任何一条。
import { CONFIG } from './config.js';
import { affectionFor } from './memory.js';

const S = CONFIG.social;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// NaN 兜底：脏存档/半空对象读出来是 NaN，而 NaN 与任何数比较都是 false ⇒
// 不兜底的话门控会**静默永不成立**（症状是"它们从来不社交"，且没有一处报错）。
const num = (v) => (Number.isFinite(v) ? v : 0);

// 单只这一侧的四条：活着、没病、没被拎着、正在社交；再加"吃饱"那个读数门。
//
// ⚠️ 这里**没有**"开心"那道门，尽管设计文档 v1 写过一条。主 spec §4.12 第 6 条的原文是
// "两只**吃饱且互相好感**的个体会自发同步脉动"，没有"开心"；而实测（2026-10-27、seed 20261022、
// 20 分钟）把 happyJoyMin = 0.45 加进来之后，pairEligible 的可及性从 2.88% 掉到 **0.038%**
// —— 缸里两只**同时**开心的机会中位数 joy 只有 0.247（p90 = 0.407）。
// 症状是 60 分钟一次同步都不发生（0 记铃、0 对伙伴），而且没有任何一处报错。
// 裁定：回到 spec 原文的两条读数门 —— 吃饱、互相好感。设计文档已同步改写。
function readySelf(c) {
  if (!c || c.alive !== true || c.sick || c.held) return false;
  if (!c.intent || c.intent.kind !== 'socialize') return false;
  return (1 - num(c.needs && c.needs.hunger)) >= S.fedMin;
}

// 唯一的门控点：五个条件全成立才算"凑在一起"。
//
// 第三条（**互相**是对方的目标）不是恒真，别把它当成摆设：behavior.decide 给 socialize
// 挂的是 senses.neighbors[0].id，两只最近的个体常常正好互指，但"A 追 B、B 追 C"
// 在拥挤的缸里同样常见。少了这条，一列排队的星星会被判成一对对在同步。
export function pairEligible(a, b, dist) {
  if (!a || !b || a === b || a.id === b.id) return false;
  if (!readySelf(a) || !readySelf(b)) return false;
  if (a.intent.targetId !== b.id || b.intent.targetId !== a.id) return false;
  // 距离必须是**有限非负**数才算"凑在一起"：NaN 会被兜底成 0，
  // 而 0 <= pairDist 成立 ⇒ 位置损坏的两只会被判成贴在一起（症状是"隔空同步"）。
  if (!Number.isFinite(dist) || dist < 0 || dist > S.pairDist) return false;
  return affectionFor(a.memory, b.id) >= S.affMin
      && affectionFor(b.memory, a.id) >= S.affMin;
}

// 同步度读数 ∈ [0,1]，无伙伴恒 0。
// 这就是 spec §5.4.1 第 2 条当年记为"做不到"时缺的那样东西：那记小铃需要一个
// **内核对"两只同步到什么程度"的读数**，而不是一句"它们靠得很近"。
export function syncDegree(c) {
  if (!c || c.bondId === null || c.bondId === undefined) return 0;
  return clamp01(num(c.bondSync) / S.syncSeconds);
}

// "长期凑在一起"到了没有。判据是**真的一起同步了多久**，不是熟悉度过没过某个阈值 ——
// 清单 §17.3 明写"不能用熟悉度阈值临时发明社交关系"，那正是这条要避开的形状。
export function companionReady(c) {
  return !!c && c.bondId !== null && c.bondId !== undefined
    && num(c.bondTotal) >= S.totalSeconds;
}

// 推进一只的同步计时。**原地改**，不分配（返回值那两个键是固定的，调用点每 tick 都要过）。
//
// crossed 是上升沿（prev < 1 且现在 >= 1）—— 与 audio.js 的 crossedUp 同一个理由：
// 按"在阈上"判的话 degree 封顶在 1 之后每 tick 都成立，那记铃就成了持续音。
//
// breakDecay > 1 是承重的：它让"中断"退得比"累积"快，于是**断续**贴在一起永远攒不满
// 一程同步。若两者同速，一只每隔几秒路过另一只的星星也会响铃。
export function bondStep(c, partnerId, eligible, dt) {
  const prev = syncDegree(c);
  if (eligible) {
    // 换伙伴 = 新的一段关系：episode 与长期计数都从 0 起（bondTotal 是"与这一只"的累计）。
    if (c.bondId !== partnerId) { c.bondId = partnerId; c.bondSync = 0; c.bondTotal = 0; }
    // 封顶在 syncSeconds：不封顶的话跑一夜之后 bondSync 是四位数而 degree 早就是 1，
    // 白占精度，还让"退到 0"要退几个小时。
    c.bondSync = Math.min(S.syncSeconds, num(c.bondSync) + dt);
    c.bondTotal = num(c.bondTotal) + dt;
  } else {
    c.bondSync = Math.max(0, num(c.bondSync) - S.breakDecay * dt);
    if (c.bondSync === 0) c.bondId = null;
    // 长期计数按指数淡（与 memory.decay 同一种淡法）：分开久了就不算"长期凑在一起"。
    c.bondTotal = num(c.bondTotal) * Math.exp(-S.totalDecay * dt);
  }
  const degree = syncDegree(c);
  return { degree, crossed: prev < 1 && degree >= 1 };
}
