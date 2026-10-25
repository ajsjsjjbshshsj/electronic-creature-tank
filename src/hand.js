// 玩家的手：把归一化指针换算成一只可见手掌的几何。
//
// 本模块只做算术，不碰 ctx / DOM，也不碰世界状态。输入全由调用方给：
// world.playerHand 是输入层的读数，petting 是 renderer 从既有 c.beingPetted 汇总的
// 只读布尔 —— 这里不重新判断速度、接触半径或有没有被拎住。
//
// 坐标系是 CSS 像素：指尖精确落在指针上；掌心在右上方（手从上方落到头上），靠边时
// 两个轴各自镜像。抚摸时只绕指尖摆动掌心（rock），所以接触点不会滑开。

import { CONFIG } from './config.js';

const H = CONFIG.hand;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 原地写入 out，返回同一个对象：渲染器每帧复用它（spec §5.3 运行时不分配对象）。
export function handPoseInto(out, hand, viewport, time, petting) {
  out.active = false;
  out.petting = petting === true;
  out.tipX = 0;
  out.tipY = 0;
  out.palmX = 0;
  out.palmY = 0;
  out.size = 0;
  out.dirX = 1;
  out.dirY = 1;
  out.rock = 0;
  out.contactRadius = 0;
  out.contactPulse = 0;

  if (!hand || !hand.pos) return out;
  if (!finite(hand.pos.x) || !finite(hand.pos.y)) return out;
  if (!viewport || !finite(viewport.width) || !finite(viewport.height)) return out;
  const w = viewport.width;
  const h = viewport.height;
  if (w <= 0 || h <= 0) return out;

  const short = Math.min(w, h);
  const size = clamp(short * H.viewportRatio, H.minPx, H.maxPx);
  const tipX = clamp(hand.pos.x, 0, 1) * w;
  const tipY = clamp(hand.pos.y, 0, 1) * h;

  // 抚摸的 rocking 只改掌心相对指尖的偏移向量。相位来自 renderer.petTime
  // （本次抚摸累计的模拟秒，从 0 渐入），不取随机数：同一帧在任何设备上算出的手形相同。
  const t = finite(time) ? time : 0;
  const rock = out.petting ? Math.sin(t * H.rockRate) * H.rockAngle : 0;
  const cs = Math.cos(rock);
  const sn = Math.sin(rock);
  const bx = H.offsetX * size;
  const by = H.offsetY * size;            // 负值：掌在头上方
  const ox = bx * cs - by * sn;
  const oy = bx * sn + by * cs;

  // 掌缘也算进镜像边界。reach 用未旋转的偏移模长作为保守上界，而不是当下这一帧的
  // ox/oy —— 否则指针停在阈值附近时，手腕每摆一下都会让整只手翻到另一边。
  // x 优先向右；y 优先向上（摸头），顶部放不下时才翻到接触点下方。
  const extent = H.palmRadius * size;
  const reach = Math.hypot(bx, by);
  const dirX = tipX + reach + extent > w ? -1 : 1;
  const dirY = tipY - reach - extent < 0 ? -1 : 1;

  out.active = true;
  out.tipX = tipX;
  out.tipY = tipY;
  out.palmX = tipX + dirX * ox;
  out.palmY = tipY + dirY * oy;
  out.size = size;
  out.dirX = dirX;
  out.dirY = dirY;
  out.rock = rock;
  out.contactRadius = out.petting ? size * H.contactRadius : 0;
  out.contactPulse = out.petting
    ? (1 - Math.cos(t * H.contactPulseRate)) * 0.5
    : 0;
  return out;
}
