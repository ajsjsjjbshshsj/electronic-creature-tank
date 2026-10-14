import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';

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
  assert.deepEqual([...seen].sort(), [1, 2, 3], '1..3 三个值都应出现');
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
