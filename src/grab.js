// 拎着玩的纯函数层：抓的几何、跟随的数学、反应的系数。
//
// 为什么单开一个文件而不是塞进 sim.js：这三件事**没有世界也能算**，
// 而 sim.js 的测试夹具要拖住一只个体跑好几个 tick 才能问到同一个问题。
// 拆出来之后"过冲不许反向"这类数学性质直接在 Node 里量（tests/grab.test.js）。
//
// 边界：本文件不 import render.js —— 半径口径必须与内核 inContact 同一把尺（见 bodyRadius），
// 用 radiusPx 的话"摸得到但拎不起"会随视口漂移。不碰浏览器对象，不用 Math.random。
import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 世界归一化半径。刻意与 sim.js 的 inContact 写成同一个表达式（sizeOf/1000）——
// 两处各写一遍就会随视口漂移，"擦到毛边算摸、移出多远算拎"必须是同一把尺上的两个刻度。
export function bodyRadius(c) {
  return num(sizeOf(c), 0) / 1000;
}

/**
 * 手是否已经把这只"带离"了身体（spec 2026-10-24 §3 的位移判据）。
 * 只在**还没拎住**时用来判成立；一旦成立，调用方（main.js）负责粘住到抬起为止。
 */
export function pulledOut({ handDist, r } = {}) {
  const d = num(handDist, -1);
  const rr = num(r, -1);
  if (!(d >= 0) || !(rr > 0)) return false;
  return d > rr * CONFIG.grab.pullOutRatio;
}

/**
 * 被拎的那只朝手位走**临界阻尼追随**一步（spec 2026-10-24 §4 / R-6）。
 *
 * 为什么不复用 sim.js 的 moveToward：那条把速率钳在 CONFIG.motion.baseSpeed × speedFactor，
 * 于是手快拖时身体追不上 —— 症状就是"一拖就脱手"，而这件功能卖的就是"拎得起来"。
 * 这里的 vel 是**真实位移率**，所以松手即惯性：不需要另写一个"投掷"公式，
 * 也就不引入第二个可能与追随打架的真相。
 *
 * a = ω²(target − pos) − 2ω·v，ω = √k ⇒ 临界阻尼，理论上零过冲。
 * 半隐式（先更新速度再用新速度更新位置）：显式欧拉在 k=140、dt=1/60 下发散，
 * 那条"一次 1/60 ≈ 两次 1/120"的测试会直接红。
 */
export function heldStep({ pos, vel, target, dt, k } = {}) {
  const d = num(dt, 0);
  const kk = Math.max(0, num(k, 0));
  const px = num(pos && pos.x, 0), py = num(pos && pos.y, 0);
  const vx0 = num(vel && vel.x, 0), vy0 = num(vel && vel.y, 0);
  const tx = num(target && target.x, px), ty = num(target && target.y, py);
  if (!(d > 0)) return { x: px, y: py, vx: vx0, vy: vy0 };
  const w = Math.sqrt(kk);
  const ax = w * w * (tx - px) - 2 * w * vx0;
  const ay = w * w * (ty - py) - 2 * w * vy0;
  const vx = vx0 + ax * d;
  const vy = vy0 + ay * d;
  return { x: px + vx * d, y: py + vy * d, vx, vy };
}

/**
 * 被拎起来的反应方向：性格 × 好感（spec 2026-10-24 §5 / R-2）。
 * affection 由调用方读好传进来 —— 本模块因此不 import memory.js。
 *
 * ⚠️ 这里是三条 [0,1] 信号的**归一化加权平均**，不是三项直接相加（原式执行时改的）：
 * 直接相加时默认个体（三项都 0.5）算出 0.825，等于"出厂就偏享受"；
 * 而 clingy / irritable / affection 全 0 时算出 0，等于"出厂一被拎就被吓"。
 * 归一化之后默认恰好落在 0.5 中位，两个极端要靠满配的基因才推得动。
 * `irritable` 取反参与平均（易怒 = 不享受），所以它前面是加号而不是减号 —— 别改回去。
 */
export function enjoyOf(c, affection) {
  const p = (c && c.traits && c.traits.personality) || {};
  const w = CONFIG.grab.w;
  const sum = w.clingy + w.affection + w.irritable;
  if (!(sum > 0)) return 0.5;
  return clamp01((num(p.clingy, 0.5) * w.clingy
    + num(affection, 0) * w.affection
    + (1 - num(p.irritable, 0.5)) * w.irritable) / sum);
}

/**
 * 被拎着期间每个 tick 的反应**增量**（调用方负责加与钳位，这样"不该买的没买"能逐字段断言）。
 *
 * ⚠️ 同一 tick **只走一个方向**：play 与 rough 里必有一个是 0。
 * 原来写成"joy 乘 e、anger 乘 (1−e)"的混合式，症状是抗拒的那只摇得越快 joy 也涨得越多
 * —— 一只又哭又笑的星绒绒。以 enjoy 的中位 0.5 为界切成两段，读起来才是两种个体。
 *
 * familiarity **不在** shake 的门里：拎在手里不动仍然是在理它（spec §5 把"认识"与"喜欢"
 * 分成两条通道，只有"喜欢"需要享受才买）。写在这里而不是让调用方补 —— 两处各补一次就会漏一次。
 */
export function carryEffects({ enjoy, speed, dt } = {}) {
  const e = clamp01(num(enjoy, 0.5));
  const d = Math.max(0, num(dt, 0));
  const over = num(speed, 0) - CONFIG.grab.shakeSpeedFloor;
  const shake = over > 0 ? CONFIG.grab.shakePerSecond * over * d : 0;
  const play = Math.max(0, 2 * e - 1);        // 明显享受 ⇒ 摇是玩闹
  const rough = Math.max(0, 1 - 2 * e);       // 明显抗拒 ⇒ 同样的摇是不适
  return {
    joy: shake * play,
    anger: shake * rough,
    fear: shake * rough,
    affection: play > 0 ? CONFIG.grab.affectionRate * d : 0,
    familiarity: CONFIG.grab.familiarityRate * d,
  };
}
