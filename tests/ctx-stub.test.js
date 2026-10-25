import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGradient, assertGradient, assertEllipse, assertColorStop } from './ctx-stub.js';

// 这道栅栏自己的判据。为什么必须单独有：栅栏的作用是"下一个人在渲染层算出 NaN 时撞红"，
// 而今天它一条断言都不挡（实测 1108 条全绿）。**没人测的栅栏会烂** —— 与 §9.4 那条
// "注释承诺的返回值没有消费者"（F-9）同一种死法：看起来有防线，其实没有。
//
// 每一条"该抛"都对应 2026-10-25 在真页面里逐项试过的一种输入（结果记在 ctx-stub.js 文件头），
// 每一条"不该抛"都对应渲染层今天真的会喂进去的形状 —— 少了后半截，
// 这道栅栏会在下一次改颜色表时把一缸正常绘制拦死。

const throws = (fn) => {
  try { fn(); return false; } catch (e) { return e.constructor.name; }
};

test('渐变：负半径与 NaN 坐标抛，渲染层今天用的那两种形状不抛', () => {
  assert.ok(throws(() => assertGradient('createRadial', 10, 10, -1, 20, 20, 20)),
    'createRadialGradient 负半径在真浏览器抛 DOMException');
  assert.ok(throws(() => assertGradient('createLinear', NaN, 0, 10, 10)),
    'createLinearGradient 的 NaN 坐标在真浏览器抛 TypeError');
  assert.ok(throws(() => assertGradient('createRadial', 10, 10, 0, 20, 20, undefined)),
    'undefined 半径同样不是有限数');
  // 渲染层的真实形状：贴图球（r0 是 size 的一小截）与遮罩（两端同心）
  assertGradient('createRadial', 26.9, 24.3, 3.2, 32, 32, 32);
  assertGradient('createLinear', 0, 0, 0, 784);
});

test('色标：位置越界与 NaN 抛，0..1 端点与带百分号的 hsl 不抛', () => {
  assert.ok(throws(() => assertColorStop(1.2, '#fff')), '位置越界在真浏览器抛 DOMException');
  assert.ok(throws(() => assertColorStop(NaN, '#fff')), 'NaN 位置抛 TypeError');
  assert.ok(throws(() => assertColorStop(0, 'hsla(NaN, 70%, 70%, 1)')),
    '颜色串里带 NaN 在真浏览器是 SyntaxError ⇒ DOMException');
  assert.ok(throws(() => assertColorStop(0, 'rgba(255,255,255,NaN)')));
  assert.ok(throws(() => assertColorStop(0, undefined)));
  assertColorStop(0, '#FFFFFF');
  assertColorStop(0.30, 'rgba(255, 255, 255, 0.86)');
  assertColorStop(1, 'hsla(340, 70%, 73%, 0.95)');
  assertColorStop(0.45, 'rgba(23,10,34,0)');
});

test('ellipse：负半径抛，贴图球那种正半径不抛', () => {
  assert.ok(throws(() => assertEllipse(-3, 2)), '真浏览器在这里抛 DOMException');
  assert.ok(throws(() => assertEllipse(3, NaN)));
  assertEllipse(12.4, 8.1);
});

test('makeGradient 返回的那一份真的会抛（不是 `{ addColorStop() {} }` 复活）', () => {
  const g = makeGradient();
  assert.equal(typeof g.addColorStop, 'function');
  assert.ok(throws(() => g.addColorStop(0, 'rgba(0,0,0,NaN)')));
  g.addColorStop(0.5, '#ffb3d1');
});
