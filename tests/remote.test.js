import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSaveResponse, nextRevision, decideBoot, SAVE_PATH } from '../src/remote.js';

test('parseSaveResponse：四种归类，别的一律 error', () => {
  const doc = { version: 2, creatures: [] };
  assert.deepEqual(parseSaveResponse(200, JSON.stringify({ revision: 3, doc })),
    { kind: 'ok', revision: 3, doc });
  assert.deepEqual(parseSaveResponse(404, ''), { kind: 'none' });
  assert.deepEqual(parseSaveResponse(409, JSON.stringify({ revision: 9 })),
    { kind: 'conflict', revision: 9 });
  // 200 但缺 doc / revision 不是整数 ⇒ error。读成"空缸"的症状是下一次落盘
  // **把服务器上那一缸覆盖成空缸**，而且没有任何一处报错。
  for (const body of ['{"revision":1}', '{"doc":{}}', '{bad json', '']) {
    assert.equal(parseSaveResponse(200, body).kind, 'error', `200 + ${body} 必须归 error`);
  }
  assert.equal(parseSaveResponse(500, 'boom').kind, 'error');
  assert.equal(parseSaveResponse(409, 'no-json').kind, 'error', '409 也要有可读的 revision');
  // 404 要分两种，**不能合成一种**：
  // · 空 body = 我们自己的服务器（"还没有档"）；
  // · 非空 body = 静态托管的 404（GitHub Pages 给的是一整页 HTML）⇒ 纯静态部署。
  // 合成一种的症状：Pages 上每次打开都挂「本地存档（服务器不可达）」，看起来像坏了。
  assert.deepEqual(parseSaveResponse(404, ''), { kind: 'none' });
  assert.deepEqual(parseSaveResponse(404, '   '), { kind: 'none' });
  assert.deepEqual(parseSaveResponse(404, '<!DOCTYPE html><h1>404</h1>'),
    { kind: 'static', reason: 'static-host' });
  // PUT 的回执只有 revision、没有 doc —— 用 GET 的规矩去读它就会把一次成功的保存
  // 判成 error，然后降级写本机（远端模式下"两份真相"就是这么来的）。
  assert.deepEqual(parseSaveResponse(200, '{"revision":6}', 'put'), { kind: 'ok', revision: 6 });
  assert.equal(parseSaveResponse(200, '{"doc":{}}', 'put').kind, 'error', 'PUT 回执没 revision 仍是 error');
});

test('nextRevision 只加一，负数与脏值一律从 1 起', () => {
  assert.equal(nextRevision(0), 1);
  assert.equal(nextRevision(41), 42);
  assert.equal(nextRevision(-5), 1, '磁盘上的 revision 坏了就从 1 重新起，不给负数');
  assert.equal(nextRevision(Number.NaN), 1);
  assert.equal(nextRevision(undefined), 1);
  assert.equal(nextRevision('7'), 8, '能被 Number 认出来的字符串照样算（服务器读 JSON 的常态）');
});

test('decideBoot：相同用远端、只有一边用那一边、两边都有且不同必须 ask', () => {
  const local = { revision: 3, savedAt: '2026-10-29T10:00:00Z' };
  assert.equal(decideBoot(local, { revision: 3, savedAt: '2026-10-29T10:00:00Z' }), 'use-remote');
  assert.equal(decideBoot(null, { revision: 3, savedAt: 'x' }), 'use-remote');
  assert.equal(decideBoot(local, null), 'use-local');
  assert.equal(decideBoot(null, null), 'fresh');
  // 同 revision 不同 savedAt ⇒ 内容不同（RNG 不序列化，逐字节比本来就不成立）
  assert.equal(decideBoot(local, { revision: 3, savedAt: '2026-10-29T10:05:00Z' }), 'ask');
  assert.equal(decideBoot(local, { revision: 4, savedAt: '2026-10-29T10:00:00Z' }), 'ask');
  // 本地比远端旧也一样要问："远端更新就静默覆盖本地"正是 §7.5 禁止的那件事
  assert.equal(decideBoot({ revision: 2, savedAt: 'a' }, { revision: 7, savedAt: 'b' }), 'ask');
});

test('SAVE_PATH 是唯一的路由真相源', () => {
  assert.equal(SAVE_PATH, '/api/save');
});
