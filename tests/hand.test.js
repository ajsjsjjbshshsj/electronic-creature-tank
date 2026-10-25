import test from 'node:test';
import assert from 'node:assert/strict';
import { handPoseInto } from '../src/hand.js';

// 手部几何与绘制分开：本文件只钉「指尖在哪、掌心往哪边展开、靠边怎么镜像、
// 什么时候 rocking」，不碰 ctx。绘制层由 tests/render-hand.test.js 钉。
//
// 期望值都是按设计手算的：短边 100 × 0.09 = 9，夹到最小 48；
// 掌心偏移 48 × 0.56 = 26.88、48 × 0.84 = 40.32。

const VP = (width, height) => ({ width, height, dpr: 1 });
const handAt = (x, y) => ({
  pos: { x, y }, speed: 0, down: true, appeared: false, grab: null,
});
const pose = () => ({
  active: false, petting: false,
  tipX: 0, tipY: 0, palmX: 0, palmY: 0,
  size: 0, dirX: 1, dirY: 1, rock: 0, contactRadius: 0,
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

test('指尖精确落在归一化指针上，普通按压的掌心在右下且不 rocking', () => {
  const out = pose();
  handPoseInto(out, handAt(0.25, 0.5), VP(400, 300), 0.5, false);
  assert.equal(out.active, true);
  assert.equal(out.tipX, 100);
  assert.equal(out.tipY, 150);
  assert.equal(out.size, 48, '短边 300 × 0.09 = 27，夹到最小 48');
  assert.equal(out.dirX, 1);
  assert.equal(out.dirY, 1);
  assert.ok(Math.abs(out.palmX - 126.88) < 1e-9, `掌心 x 实测 ${out.palmX}`);
  assert.ok(Math.abs(out.palmY - 190.32) < 1e-9, `掌心 y 实测 ${out.palmY}`);
  assert.equal(out.rock, 0, '没有抚摸成立时手腕不许自己摇');
  assert.equal(out.petting, false);
});

test('手的尺寸按视口短边增长，并夹在 48–76 CSS 像素', () => {
  const phone = pose();
  handPoseInto(phone, handAt(0.5, 0.5), VP(390, 844), 0, false);
  assert.equal(phone.size, 48);

  const mid = pose();
  handPoseInto(mid, handAt(0.5, 0.5), VP(700, 784), 0, false);
  assert.equal(mid.size, 63, '700 × 0.09 = 63：中段必须由 ratio 决定，不能只在两个夹取端成立');

  const desktop = pose();
  handPoseInto(desktop, handAt(0.5, 0.5), VP(1920, 1080), 0, false);
  assert.equal(desktop.size, 76);
});

test('靠边时两个轴各自镜像：手不跑出缸，指尖仍压在指针上', () => {
  const out = pose();
  const hand = handAt(0.95, 0.9);
  handPoseInto(out, hand, VP(200, 100), 0.5, false);
  assert.equal(out.tipX, 190);
  assert.equal(out.tipY, 90);
  assert.equal(out.dirX, -1, '右边缘没有掌心空间，应向左展开');
  assert.equal(out.dirY, -1, '下边缘没有掌心空间，应向上展开');
  assert.ok(out.palmX < out.tipX && out.palmY < out.tipY);
});

test('两个轴的镜像互相独立，掌缘本身也算空间', () => {
  const right = pose();
  handPoseInto(right, handAt(0.85, 0.2), VP(200, 100), 0, false);
  assert.equal(right.dirX, -1, '只有右边缘放不下');
  assert.equal(right.dirY, 1, '顶部仍有空间，不许跟着 x 一起翻转');
  assert.ok(right.palmX < right.tipX && right.palmY > right.tipY);

  const bottom = pose();
  handPoseInto(bottom, handAt(0.5, 0.8), VP(200, 100), 0, false);
  assert.equal(bottom.dirX, 1, '左/右仍有空间');
  assert.equal(bottom.dirY, -1, '只有下边缘放不下');
  assert.ok(bottom.palmX > bottom.tipX && bottom.palmY < bottom.tipY);

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
    handPoseInto(out, handAt(646 / 700, 0.4), vp, i * 0.25, true);
    dirs.push(out.dirX);
  }
  assert.deepEqual([...new Set(dirs)], [-1],
    `同一个指针位置在 2 秒内翻面 ${new Set(dirs).size} 种方向：${dirs.join(',')}`);
});

test('抚摸只摆动掌心：指尖不动、rock 非零，接触半径随手掌尺寸', () => {
  const neutral = pose();
  handPoseInto(neutral, handAt(0.5, 0.5), VP(400, 300), 0.5, false);
  const petted = pose();
  handPoseInto(petted, handAt(0.5, 0.5), VP(400, 300), 0.5, true);
  assert.equal(petted.petting, true);
  assert.equal(petted.tipX, neutral.tipX, 'rocking 只摆掌，不许让指尖离开接触点');
  assert.equal(petted.tipY, neutral.tipY);
  assert.notEqual(petted.rock, 0);
  assert.ok(Math.abs(petted.rock) <= 0.1, `摆动不得超过 0.1 rad，实测 ${petted.rock}`);
  assert.ok(petted.palmX !== neutral.palmX || petted.palmY !== neutral.palmY,
    '抚摸时掌心应当真的换了位置');
  assert.ok(petted.contactRadius > 0);
  assert.ok(Math.abs(petted.contactRadius - petted.size * 0.22) < 1e-9,
    `接触半径应为手掌尺寸的 0.22 倍，实测 ${petted.contactRadius}`);
});

test('handPoseInto 复用调用方给的输出对象，每帧不新建容器', () => {
  const out = pose();
  const first = handPoseInto(out, handAt(0.5, 0.5), VP(200, 100), 0, false);
  const second = handPoseInto(first, handAt(0.6, 0.6), VP(200, 100), 0, true);
  assert.equal(first, out);
  assert.equal(second, out);
});
