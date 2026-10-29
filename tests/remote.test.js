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
  // 404 不看 body：服务器给的 404 没有约定形状
  assert.deepEqual(parseSaveResponse(404, 'whatever'), { kind: 'none' });
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
