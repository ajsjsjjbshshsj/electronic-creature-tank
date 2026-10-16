import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';

// ---- 黄金值钉桩 ----
// 上面/下面那些测试全是性质型的（落在 [0,1)、分布均匀、同种子同序列……），
// 而性质在算法被改错时往往依然成立：把 mulberry32 的增量 0x6D2B79F5 换成别的奇数、
// 或者把输出位移 (t >>> 14) 改成 (t >>> 13)，十二条性质测试可以一条不红，
// 但项目里每一条随机流都已经悄悄变了 —— 固定种子的"可复现"复现出的是另一个世界。
// 这一组字面量就是用来堵这个口子的。
//
// 下列数值全部由参考实现实际跑出后原样抄录（全精度，可直接 round-trip 回同一个 double），
// 不是手算的、也不是近似值。若有意更换算法或调整常数，必须重新采集这一组数字并
// 在提交说明里写明"随机流已变更"；不要为了让测试变绿而就地改小某个期望值。
test('黄金值：seed 12345 的前三次 next()', () => {
  const r = createRng(12345);
  assert.equal(r.next(), 0.9797282677609473);
  assert.equal(r.next(), 0.3067522644996643);
  assert.equal(r.next(), 0.484205421525985);
});

test('黄金值：gaussian() 的首次抽取与缓存的第二个值', () => {
  const r = createRng(12345);
  // Box-Muller 一次产两个：第一个用 cos、第二个（spare）用 sin。
  // 两个都钉住，才能抓到 sin/cos 被写反这类只改配对、不改分布的错误。
  assert.equal(r.gaussian(), -0.07064807449259204);
  assert.equal(r.gaussian(), 0.18965467748679948);
});

test('黄金值：range() 与 int()', () => {
  assert.equal(createRng(12345).range(10, 20), 19.797282677609473);
  assert.equal(createRng(12345).int(1, 6), 6);
});

test('黄金值：fork() 子流的首次抽取', () => {
  // 钉住混合器 0x85EBCA6B 与异或顺序 —— 改了它们，所有派生子流都会整体平移。
  assert.equal(createRng(12345).fork().next(), 0.2607023874297738);
});

test('同种子产生完全相同的序列', () => {
  const a = createRng(12345);
  const b = createRng(12345);
  for (let i = 0; i < 200; i++) assert.equal(a.next(), b.next());
});

test('不同种子产生不同序列', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('next 落在 [0,1)', () => {
  const r = createRng(7);
  for (let i = 0; i < 5000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `越界: ${v}`);
  }
});

test('分布大致均匀（10 个桶各约 10%）', () => {
  const r = createRng(99);
  const buckets = new Array(10).fill(0);
  const N = 60000;
  for (let i = 0; i < N; i++) buckets[Math.floor(r.next() * 10)]++;
  for (const c of buckets) {
    assert.ok(Math.abs(c / N - 0.1) < 0.01, `桶偏差过大: ${c / N}`);
  }
});

test('range 尊重边界', () => {
  const r = createRng(3);
  for (let i = 0; i < 1000; i++) {
    const v = r.range(-5, 5);
    assert.ok(v >= -5 && v < 5);
  }
});

test('int 含两端且为整数', () => {
  const r = createRng(4);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(1, 3);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 3);
    seen.add(v);
  }
  // 数值比较器不可省：默认 sort() 按字符串排，[1,2,3] 恰好是个位数才"看起来对"，
  // 换成 int(1,12) 就会排出 [1,10,11,12,2,...] 而测试仍然通过。
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3], '1..3 三个值都应出现');
});

test('gaussian 均值接近 0、标准差接近 1', () => {
  const r = createRng(5);
  const N = 40000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const g = r.gaussian();
    sum += g;
    sumSq += g * g;
  }
  const mean = sum / N;
  const sd = Math.sqrt(sumSq / N - mean * mean);
  assert.ok(Math.abs(mean) < 0.03, `均值偏离: ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.05, `标准差偏离: ${sd}`);
});

test('chance(1) 恒真、chance(0) 恒假', () => {
  const r = createRng(6);
  for (let i = 0; i < 100; i++) {
    assert.equal(r.chance(1), true);
    assert.equal(r.chance(0), false);
  }
});

test('pick 只返回数组内的元素', () => {
  const r = createRng(8);
  const arr = ['a', 'b', 'c'];
  for (let i = 0; i < 500; i++) assert.ok(arr.includes(r.pick(arr)));
});

test('pick([]) 大声抛错，而不是静默返回 undefined', () => {
  // 旧实现是 arr[Math.floor(next() * 0)] === arr[0] === undefined：
  // 后续 Task 会从"可能合法为空"的候选集里 pick（食物、求偶对象），
  // 静默的 undefined 会在离病因很远的地方才炸开。
  const r = createRng(8);
  assert.throws(() => r.pick([]), /空数组/, '空数组必须抛带说明的 Error');

  // 抛错发生在抽取之前：失败的 pick 不得推动随机流，
  // 否则"同种子同序列"会因为一次无效调用而整体错位。
  const afterThrow = createRng(8);
  assert.throws(() => afterThrow.pick([]), Error);
  assert.equal(afterThrow.next(), createRng(8).next(),
    'pick([]) 抛错时不应消费随机数 —— 流必须保持未动');
});

test('fork 产生独立且可复现的子流', () => {
  const a = createRng(42);
  const b = createRng(42);
  const fa = a.fork();
  const fb = b.fork();
  for (let i = 0; i < 50; i++) assert.equal(fa.next(), fb.next());
  // 父流在 fork 之后继续消费，两个父流仍须一致
  assert.equal(a.next(), b.next());
});

test('fork 出的子流与父流后续序列不同（真的独立）', () => {
  const parent = createRng(42);
  const child = parent.fork();
  const p = parent.next();
  const c = child.next();
  assert.notEqual(p, c);
});

test('seed 0 不会退化成全零序列', () => {
  const r = createRng(0);
  const vals = new Set(Array.from({ length: 100 }, () => r.next()));
  assert.ok(vals.size > 90, `种子 0 应仍产生多样输出，实际 ${vals.size} 个不同值`);
});
