import test from 'node:test';
import assert from 'node:assert/strict';
import { handPoseInto } from '../src/hand.js';

// 手部几何与绘制分开：本文件只钉「指尖在哪、掌心从哪边落下、靠边怎么镜像、
// 抚摸时手腕与接触圈怎么动」，不碰 ctx。绘制层由 tests/render-hand.test.js 钉。
//
// 期望值都是按设计手算的：短边 300 × 0.07 = 21，夹到最小 40；
// 掌心偏移 40 × 0.18 = 7.2（向右）、40 × 0.48 = 19.2（向上）。

const VP = (width, height) => ({ width, height, dpr: 1 });
const handAt = (x, y) => ({
  pos: { x, y }, speed: 0, down: true, appeared: false, grab: null,
});
const pose = () => ({
  active: false, petting: false,
  tipX: 0, tipY: 0, palmX: 0, palmY: 0,
  size: 0, dirX: 1, dirY: 1, rock: 0, contactRadius: 0, contactPulse: 0,
});

test('没有手、坐标非有限数或视口为空时，手部几何保持 inactive', () => {
  const out = pose();
  assert.equal(handPoseInto(out, null, VP(200, 100), 0, false), out);
  assert.equal(out.active, false);

  handPoseInto(out, handAt(NaN, 0.5), VP(200, 100), 0, false);
  assert.equal(out.active, false, 'NaN 坐标若被画出去，真浏览器会废掉整帧');

  handPoseInto(out, handAt(0.5, Infinity), VP(200, 100), 0, false);
  assert.equal(out.active, false);

  handPoseInto(out, handAt(0.5, 0.5), VP(0, 100), 0, false);
  assert.equal(out.active, false, '隐藏页面的零视口不许算出负半径或 NaN');
});

test('指尖精确落在归一化指针上，手从上方落下且不 rocking', () => {
  const out = pose();
  handPoseInto(out, handAt(0.25, 0.5), VP(400, 300), 0.5, false);
  assert.equal(out.active, true);
  assert.equal(out.tipX, 100);
  assert.equal(out.tipY, 150);
  assert.equal(out.size, 40, '短边 300 × 0.07 = 21，夹到最小 40');
  assert.equal(out.dirX, 1);
  assert.equal(out.dirY, 1);
  assert.ok(Math.abs(out.palmX - 107.2) < 1e-9, `掌心 x 实测 ${out.palmX}`);
  assert.ok(Math.abs(out.palmY - 130.8) < 1e-9, `掌心 y 实测 ${out.palmY}`);
  assert.ok(out.palmY < out.tipY, '摸头时掌心必须落在接触点上方，而不是从右下方戳上来');
  assert.equal(out.rock, 0, '没有抚摸成立时手腕不许自己摇');
  assert.equal(out.contactPulse, 0);
  assert.equal(out.petting, false);
});

test('手的尺寸按视口短边增长，并夹在 40–56 CSS 像素', () => {
  const phone = pose();
  handPoseInto(phone, handAt(0.5, 0.5), VP(390, 844), 0, false);
  assert.equal(phone.size, 40);

  const mid = pose();
  handPoseInto(mid, handAt(0.5, 0.5), VP(700, 784), 0, false);
  assert.ok(Math.abs(mid.size - 49) < 1e-9,
    `700 × 0.07 = 49：中段必须由 ratio 决定，不能只靠夹取端（实测 ${mid.size}）`);

  const desktop = pose();
  handPoseInto(desktop, handAt(0.5, 0.5), VP(1920, 1080), 0, false);
  assert.equal(desktop.size, 56);
});

test('靠边时两个轴各自镜像：手不跑出缸，指尖仍压在指针上', () => {
  const out = pose();
  const hand = handAt(0.95, 0.05);
  handPoseInto(out, hand, VP(200, 100), 0.5, false);
  assert.equal(out.tipX, 190);
  assert.equal(out.tipY, 5);
  assert.equal(out.dirX, -1, '右边缘没有掌心空间，应向左展开');
  assert.equal(out.dirY, -1, '顶部没有掌心空间，应翻到接触点下方');
  assert.ok(out.palmX < out.tipX && out.palmY > out.tipY);
});

test('两个轴的镜像互相独立，掌缘本身也算空间', () => {
  const right = pose();
  handPoseInto(right, handAt(0.85, 0.5), VP(200, 200), 0, false);
  assert.equal(right.dirX, -1, '只有右边缘放不下');
  assert.equal(right.dirY, 1, '顶部仍有空间，不许跟着 x 一起翻转');
  assert.ok(right.palmX < right.tipX && right.palmY < right.tipY);

  const top = pose();
  handPoseInto(top, handAt(0.5, 0.1), VP(200, 200), 0, false);
  assert.equal(top.dirX, 1, '左/右仍有空间');
  assert.equal(top.dirY, -1, '只有顶部放不下');
  assert.ok(top.palmX > top.tipX && top.palmY > top.tipY);

  const edge = pose();
  handPoseInto(edge, handAt(0.8, 0.5), VP(200, 200), 0, false);
  const extent = edge.size * 0.34;
  assert.equal(edge.dirX, -1, '掌心中心还放得下，但掌缘放不下 ⇒ 必须翻');
  assert.equal(edge.dirY, 1);
  assert.ok(edge.palmX - extent >= 0 && edge.palmY - extent >= 0, '镜像后掌缘必须留在视口内');
});

test('抚摸的 rocking 不让边缘手的镜像来回翻面', () => {
  const vp = VP(700, 784);
  const dirs = [];
  for (let i = 0; i < 8; i++) {
    const out = pose();
    handPoseInto(out, handAt(665 / 700, 0.5), vp, i * 0.25, true);
    dirs.push(out.dirX);
  }
  assert.deepEqual([...new Set(dirs)], [-1],
    `同一个指针位置在 2 秒内翻面 ${new Set(dirs).size} 种方向：${dirs.join(',')}`);
});

test('抚摸只摆动掌心：指尖不动、rock 与接触脉冲都随时间变化', () => {
  const neutral = pose();
  handPoseInto(neutral, handAt(0.5, 0.5), VP(400, 300), 0.5, false);
  const petted = pose();
  handPoseInto(petted, handAt(0.5, 0.5), VP(400, 300), 0.5, true);
  assert.equal(petted.petting, true);
  assert.equal(petted.tipX, neutral.tipX, 'rocking 只摆掌，不许让指尖离开接触点');
  assert.equal(petted.tipY, neutral.tipY);
  assert.notEqual(petted.rock, 0);
  assert.ok(Math.abs(petted.rock) <= 0.28, `摆动不得超过 0.28 rad，实测 ${petted.rock}`);
  assert.ok(petted.palmX !== neutral.palmX || petted.palmY !== neutral.palmY,
    '抚摸时掌心应当真的换了位置');
  assert.ok(petted.contactRadius > 0);
  assert.ok(Math.abs(petted.contactRadius - petted.size * 0.24) < 1e-9,
    `接触半径应为手掌尺寸的 0.24 倍，实测 ${petted.contactRadius}`);
  assert.ok(petted.contactPulse > 0 && petted.contactPulse <= 1,
    `抚摸时接触圈必须有脉动，实测 ${petted.contactPulse}`);
});

test('接触圈脉动从接触起点展开，普通按压保持 0', () => {
  const pulses = [];
  for (let i = 0; i < 6; i++) {
    const out = pose();
    handPoseInto(out, handAt(0.5, 0.5), VP(400, 300), i * 0.18, true);
    pulses.push(out.contactPulse);
  }
  assert.ok(pulses[0] === 0, `抚摸计时归零时接触圈应从 0 开始，实测 ${pulses[0]}`);
  assert.ok(pulses.some((v) => v > 0.5), `约 1 秒内必须出现明显展开：${pulses.join(',')}`);
  assert.ok(Math.max(...pulses) - Math.min(...pulses) > 0.5, '脉动幅度太小就读不出在摸');
  const neutral = pose();
  handPoseInto(neutral, handAt(0.5, 0.5), VP(400, 300), 1.2, false);
  assert.equal(neutral.contactPulse, 0, '不抚摸时接触圈不许自己动');
});

test('handPoseInto 复用调用方给的输出对象，每帧不新建容器', () => {
  const out = pose();
  const first = handPoseInto(out, handAt(0.5, 0.5), VP(200, 100), 0, false);
  const second = handPoseInto(first, handAt(0.6, 0.6), VP(200, 100), 0, true);
  assert.equal(first, out);
  assert.equal(second, out);
});
