// 手势分类与点选。计划 3 Task 1。
//
// 为什么单独立一个文件而不是塞进 input.js：input.js 有"零 import"的守卫
// （tests/input.test.js:198），而这里要点半径 —— 那个算法住在 render.js 的 radiusPx。
// 拆开比给 input.js 开一条依赖口子便宜。
//
// spec §6.1 那张表里"点按单只 → 信息卡 / 长按单只 → 取名 / 拖拽食物条 → 投食 /
// 长按缸内 → 撒食"这四条，**判定**全在这里；**效果**全在 main.js（表现层不许写世界，
// 除了 world.playerHand 那一个字段 —— 见全局约束第 6 条）。
import { CONFIG } from './config.js';
import { radiusPx } from './render.js';

export const GESTURES = Object.freeze(['tap', 'hold', 'swipe']);

const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/**
 * 一次"按下到抬起"算哪一档。
 * heldMs 抬起时刻 − 起始时刻；movedPx 抬起时累计的最大位移（CSS 像素）。
 *
 * 阈值读 CONFIG.hud —— **不在这里再写一份 DEFAULTS**。
 * Task 1 落地时这里自带三个兜底数（那时 CONFIG.hud 还不存在），Task 3 把它收编了：
 * 两处数字要同步改的隐患从结构上消失，改 CONFIG 就是改行为，由 tests/config.test.js 钉数值、
 * 本文件的边界测试钉行为。
 */
export function classifyPress(p) {
  const held = num(p && p.heldMs, -1);
  const moved = num(p && p.movedPx, -1);
  // swipe 先判，赢的是**语义**而不是优先级：从食物条拖出来那一把一定同时满足 hold，
  // 反过来（先判 hold）会让"拖着食物经过一只个体"先弹出改名框。
  if (moved > CONFIG.hud.tapMaxPx) return 'swipe';
  if (held >= CONFIG.hud.holdMinMs) return 'hold';
  return 'tap';
}

/**
 * 屏幕坐标点到哪一只。xPx / yPx 是 CSS 像素（与 viewport.width/height 同一单位）。
 * 返回 creatures 里那个对象本身（不是副本），找不到返回 null。
 */
export function pickCreature(creatures, viewport, xPx, yPx) {
  if (!Array.isArray(creatures) || creatures.length === 0) return null;
  const w = num(viewport && viewport.width, 0);
  const h = num(viewport && viewport.height, 0);
  const scale = num(viewport && viewport.scale, 0);
  const x = num(xPx, NaN);
  const y = num(yPx, NaN);
  if (!(w > 0) || !(h > 0) || !(scale > 0)) return null;
  // 这里**不**判 x/y 是不是有限数：变异探针 P7 证明那条守卫是白写的 —— NaN 减什么都得 NaN，
  // 而 `NaN <= r` 恒为 false，脏坐标会在下面那个比较里被自然吸收掉，走不到"命中"。
  // 留着它只会让下一个人以为 NaN 需要特判。行为由 tests 那条「非有限坐标一律 null」钉着。
  const minHit = CONFIG.hud.minHitPx;
  let best = null;
  let bestD = Infinity;
  for (const c of creatures) {
    if (!c || !c.pos || c.alive === false || c.stage === 'dead') continue;
    const cx = num(c.pos.x, NaN) * w;
    const cy = num(c.pos.y, NaN) * h;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const d = Math.hypot(x - cx, y - cy);
    // 半径走 render.js 的 radiusPx —— **共用实现**是这条的本意：
    // 它含年龄（growthFactor）与蛋加成，自己另算一份的话，幼体的可点范围
    // 会和画出来的对不上，而"点不到我想点的那只"是玩家最先注意到的错。
    // 再夹一个下限：幼体屏上半径可以小到 3px（render.js:120 的 SIZE_LO），
    // 不夹就等于"点按开信息卡"对最小的那些没做。
    const r = Math.max(num(radiusPx(c, viewport), 0), minHit);
    if (d <= r && d < bestD) { best = c; bestD = d; }
  }
  return best;
}
