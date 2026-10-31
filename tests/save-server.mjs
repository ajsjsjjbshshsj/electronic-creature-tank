// /api/save 的**手动**验收脚本（文件名不匹配 node runner 的模式，所以不进 `node --test`）。
//
// 它真的起一个 server.ps1 子进程、用 HTTP 打四件事 —— 这是唯一能证明"服务器那一侧
// 的 409 与原子写真的成立"的证据：纯层测试只证明客户端怎么理解响应，不证明服务器怎么给。
//
// 跑法：node tests/save-server.mjs
// 它会在仓库根目录写一份 save.json（验收结束后删掉；那份文件本来就在 .gitignore 里）。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8127;
const base = `http://localhost:${port}`;
const savePath = path.join(root, 'save.json');
const tmpPath = path.join(root, 'save.json.tmp');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/index.html`);
      if (r.ok) return true;
    } catch (err) { /* 还没起来 */ }
    await wait(250);
  }
  return false;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const docOf = (tag) => ({ version: 2, savedAt: tag, world: { seed: 1 }, creatures: [], eggs: [], foods: [] });

const srv = spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'server.ps1'), '-Port', String(port), '-NoBrowser',
], { cwd: root, stdio: 'ignore', windowsHide: true });

try {
  if (!(await waitUp())) throw new Error('服务器没起来');
  if (existsSync(savePath)) rmSync(savePath);

  // ① 没有档 → 404
  let r = await fetch(`${base}/api/save`);
  check('GET 无档 → 404', r.status === 404, `status=${r.status}`);

  // ② 首次 PUT（base 0）→ 200 revision 1
  r = await fetch(`${base}/api/save`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 0, doc: docOf('first') }),
  });
  let body = await r.json();
  check('PUT base 0 → 200 revision 1', r.status === 200 && body.revision === 1,
    `status=${r.status} revision=${body && body.revision}`);
  const bytesAfterFirst = readFileSync(savePath).length;
  check('磁盘上出现了 save.json', existsSync(savePath), `${bytesAfterFirst} 字节`);

  // ③ 带**旧**版本 → 409，且磁盘一个字节没变
  r = await fetch(`${base}/api/save`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 0, doc: docOf('stale') }),
  });
  body = await r.json();
  check('PUT 旧版本 → 409 且带回磁盘版本',
    r.status === 409 && body.revision === 1, `status=${r.status} revision=${body && body.revision}`);
  const after = readFileSync(savePath);
  check('409 之后磁盘字节数不变', after.length === bytesAfterFirst, `${after.length} vs ${bytesAfterFirst}`);
  check('409 的那份 doc 没落盘', !after.toString('utf8').includes('stale'), '磁盘里没有 "stale"');

  // ④ 带对版本 → 200 revision 2，且 revision 由服务器盖章
  r = await fetch(`${base}/api/save`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 1, doc: { ...docOf('second'), revision: 999 } }),
  });
  body = await r.json();
  check('PUT 正确版本 → 200 revision 2', r.status === 200 && body.revision === 2,
    `status=${r.status} revision=${body && body.revision}`);
  const disk = JSON.parse(readFileSync(savePath, 'utf8'));
  check('服务器盖的 revision 覆盖了客户端送来的 999', disk.revision === 2, `disk=${disk.revision}`);

  // ⑤ GET 读回的就是那一份
  r = await fetch(`${base}/api/save`);
  body = await r.json();
  check('GET 读回 200 + revision 2 + 正确的 doc',
    r.status === 200 && body.revision === 2 && body.doc.savedAt === 'second',
    `savedAt=${body && body.doc && body.doc.savedAt}`);

  // ⑥ 原子写：成功后 tmp 不残留
  check('成功后没有 save.json.tmp 残留', !existsSync(tmpPath));

  // ⑦ 其它 /api/* → 404
  r = await fetch(`${base}/api/whatever`);
  check('未知 /api/* → 404', r.status === 404, `status=${r.status}`);

  // ⑧ 静态文件仍然正常（加路由不能把老功能撞坏）
  r = await fetch(`${base}/src/remote.js`);
  check('静态文件仍然可读', r.status === 200 && (await r.text()).includes('SAVE_PATH'));

  // ⑨ 坏 body → 400，且不写盘
  r = await fetch(`${base}/api/save`, { method: 'PUT', body: '{oops' });
  check('PUT 坏 JSON → 400', r.status === 400, `status=${r.status}`);

  // ⑩ DELETE → 200，之后再 GET 是 404（清档的远端一半）
  r = await fetch(`${base}/api/save`, { method: 'DELETE' });
  check('DELETE → 200', r.status === 200, `status=${r.status}`);
  r = await fetch(`${base}/api/save`);
  check('DELETE 之后 GET → 404', r.status === 404, `status=${r.status}`);
  check('DELETE 之后磁盘文件也没了', !existsSync(savePath));
  // 幂等：本来就没有时再删一次也是 200
  r = await fetch(`${base}/api/save`, { method: 'DELETE' });
  check('DELETE 幂等（没有档也 200）', r.status === 200, `status=${r.status}`);
} finally {
  srv.kill();
  await wait(300);
  for (const f of [savePath, tmpPath]) { try { if (existsSync(f)) rmSync(f); } catch (err) { /* ignore */ } }
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
