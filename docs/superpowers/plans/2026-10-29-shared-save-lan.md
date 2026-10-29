# 共享存档（局域网 + 409）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一个局域网里的多台设备共享一条缸：`server.ps1` 提供 `/api/save`，版本冲突返 409 由玩家选。

**Architecture:** 服务端加两条路由（GET/PUT + revision 比对 + 原子写），客户端加一层纯协议模块
（`src/remote.js`，`fetch` 仍在 `main.js`），存档层在 boot 时决定 backend（远端 / 本地），
HUD 只多一个角标与一条两按钮的冲突条。

**Tech Stack:** 原生 ES Modules、`node:test`、Windows PowerShell 5.1 的 `HttpListener`、`fetch`（Node 18+ 自带，浏览器原生）。

**Spec:** `docs/superpowers/specs/2026-10-29-shared-save-lan-design.md`（协议与控制方 2026-10-29 的两条拍定）

## Global Constraints

- 浏览器标识符（`document/window/canvas/requestAnimationFrame/AudioContext/fetch/localStorage`）
  **只许**出现在 `src/main.js`（`tests/constraints.test.js` 的 `BROWSER_MODULES` 扫描）。
- `CONFIG` 深冻结；新增可调数值一律进 `src/config.js`，并同步 `tests/config.test.js` 的
  节点数（68）、顶层键数（56）与键名清单。
- 运行时零分配、零 `setTimeout`/`setInterval`（§7.3.1 第 4 条）。
- **绝不静默丢失任何一边的进度**（§7.5 末句）：冲突只许 409 + 让玩家选。
- `save.json` 永不进版本库；API key 永不出现在任何存档里（§7.3.1 第 6 条）。

---

### Task 1: 协议纯层 `src/remote.js`

**Files:**
- Create: `src/remote.js`
- Test: `tests/remote.test.js`

**Interfaces:**
- Produces: `parseSaveResponse(status, text) → {kind:'ok',revision,doc} | {kind:'none'} | {kind:'conflict',revision} | {kind:'error',reason}`；
  `nextRevision(base) → number`；`decideBoot(local, remote) → 'use-remote'|'use-local'|'fresh'|'ask'`；
  `SAVE_PATH = '/api/save'`

- [ ] **Step 1: 写红测**（`tests/remote.test.js`）

```js
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
  // 200 但缺 doc / revision 不是整数 ⇒ error，不许当成"空缸"
  for (const body of ['{"revision":1}', '{"doc":{}}', '{bad json', '']) {
    assert.equal(parseSaveResponse(200, body).kind, 'error', `200 + ${body} 必须归 error`);
  }
  assert.equal(parseSaveResponse(500, 'boom').kind, 'error');
  assert.equal(parseSaveResponse(409, 'no-json').kind, 'error', '409 也要有可读的 revision');
  // 反向：404 不看 body（服务器给的 404 没有约定形状）
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
  // 同 revision 不同 savedAt ⇒ 不同内容（RNG 不序列化，逐字节比本来就不成立）
  assert.equal(decideBoot(local, { revision: 3, savedAt: '2026-10-29T10:05:00Z' }), 'ask');
  assert.equal(decideBoot(local, { revision: 4, savedAt: '2026-10-29T10:00:00Z' }), 'ask');
  // 缺口：本地比远端旧也一样要问 —— "远端更新就静默覆盖本地"正是 §7.5 禁止的那件事
  assert.equal(decideBoot({ revision: 2, savedAt: 'a' }, { revision: 7, savedAt: 'b' }), 'ask');
});

test('SAVE_PATH 是唯一的路由真相源', () => {
  assert.equal(SAVE_PATH, '/api/save');
});
```

- [ ] **Step 2: 跑红** — `node --test tests/remote.test.js` → 模块不存在。

- [ ] **Step 3: 实现 `src/remote.js`**

```js
// 共享存档的**协议纯层**。`fetch` 的调用方仍然是 main.js（§3.2 的机器化守卫）。
// 设计与控制方 2026-10-29 的两条拍定见 docs/superpowers/specs/2026-10-29-shared-save-lan-design.md。
export const SAVE_PATH = '/api/save';

const intOrNull = (v) => (Number.isInteger(v) ? v : (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : null));

function json(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

// HTTP 状态与响应体 → 四种之一。别的一律 error：把"200 但缺 doc"读成空缸，
// 症状是**下一次落盘把服务器上那一缸覆盖成空缸**，而且没有任何一处报错。
export function parseSaveResponse(status, text) {
  const s = Number(status);
  if (s === 404) return { kind: 'none' };
  const body = json(text);
  if (s === 200) {
    const rev = body ? intOrNull(body.revision) : null;
    if (!body || rev === null || rev < 0 || !body.doc || typeof body.doc !== 'object') {
      return { kind: 'error', reason: 'bad-save-response' };
    }
    return { kind: 'ok', revision: rev, doc: body.doc };
  }
  if (s === 409) {
    const rev = body ? intOrNull(body.revision) : null;
    if (rev === null || rev < 0) return { kind: 'error', reason: 'bad-conflict-response' };
    return { kind: 'conflict', revision: rev };
  }
  return { kind: 'error', reason: `status-${s}` };
}

// 服务器侧的语义单点：磁盘上的 revision 只由服务器 +1（§7.5 原文）。
export function nextRevision(base) {
  const n = intOrNull(base);
  return n === null || n < 0 ? 1 : n + 1;
}

// 两边都有档时挑哪一份。**不同就 ask**：远端更新就静默覆盖本地是 §7.5 明令禁止的，
// 而本地更新就静默覆盖远端同样会丢一边的进度。判据只看 revision + savedAt：
// 内核的 RNG 不序列化（§7.3.1 第 5 条），逐字节比对本来就不该期待相同。
export function decideBoot(local, remote) {
  const hasLocal = !!local && Number.isFinite(Number(local.revision));
  const hasRemote = !!remote && Number.isFinite(Number(remote.revision));
  if (!hasLocal && !hasRemote) return 'fresh';
  if (!hasLocal) return 'use-remote';
  if (!hasRemote) return 'use-local';
  const same = Number(local.revision) === Number(remote.revision)
    && String(local.savedAt) === String(remote.savedAt);
  return same ? 'use-remote' : 'ask';
}
```

- [ ] **Step 4: 跑绿** — `node --test tests/remote.test.js`。

- [ ] **Step 5: 提交** — `git commit -m "feat: 共享存档的协议纯层（四种归类 + revision 归属 + 启动仲裁）"`

---

### Task 2: 服务端 `/api/save`

**Files:**
- Modify: `server.ps1`（路由分支 + 两个函数）
- Modify: `.gitignore`
- Create: `tests/save-server.mjs`（**手动**验收脚本，名字不匹配 node runner 的模式）

**Interfaces:**
- Produces: `GET /api/save` → 200 `{revision, doc}` / 404；`PUT /api/save` `{baseRevision, doc}` → 200 `{revision}` / 409 `{revision}`

- [ ] **Step 1: 写验收脚本（先于实现，跑起来必须红）**

`tests/save-server.mjs`：起 `server.ps1 -Port 8127 -NoBrowser`（子进程），用 Node 的 `fetch` 打四件事：
① GET 无档 → 404；② PUT base 0 → 200 且 revision 1；③ 再 PUT 带旧 base 0 → 409 且
磁盘文件**字节数不变**；④ PUT 带对版本 → 200 revision 2；最后杀掉子进程并删掉 `save.json`。

- [ ] **Step 2: 实现**

`server.ps1` 在静态分支之前插入：

```powershell
# ---- /api/save（共享存档，2026-10-29）----
# 协议与安全边界见 docs/superpowers/specs/2026-10-29-shared-save-lan-design.md：
# 没有认证、只适合家庭局域网；revision 只由**服务器**递增（§7.5 原文）。
$SavePath = Join-Path $Root 'save.json'
$SaveTmp  = Join-Path $Root 'save.json.tmp'

function Read-SaveDoc {
  if (-not (Test-Path -LiteralPath $SavePath)) { return $null }
  $raw = [IO.File]::ReadAllText($SavePath, [Text.Encoding]::UTF8)
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Write-Json($ctx, [int]$status, $obj) {
  $text = if ($null -eq $obj) { '' } else { $obj | ConvertTo-Json -Depth 40 -Compress }
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
```

处理段（在 `if ($path -eq '/api/save') { ... return }` 里）：

- `GET`：`$doc = Read-SaveDoc`；`$null -eq $doc` → `Write-Json $ctx 404 $null`；否则
  `Write-Json $ctx 200 @{ revision = [int]$doc.revision; doc = $doc }`。
- `PUT`：读 body（`[IO.StreamReader]::new($ctx.Request.InputStream, $UTF8).ReadToEnd()`），
  `ConvertFrom-Json` 失败 → 400；`$base = [int]$body.baseRevision`；
  `$cur = if ($null -eq $doc) { 0 } else { [int]$doc.revision }`；
  `$base -ne $cur` → `Write-Json $ctx 409 @{ revision = $cur }` **且一个字节都不写**；
  否则 `$body.doc.revision = $cur + 1`，`ConvertTo-Json -Depth 40 | Set-Content -Encoding UTF8 $SaveTmp`，
  `Move-Item -LiteralPath $SaveTmp -Destination $SavePath -Force`，`Write-Json $ctx 200 @{ revision = $cur + 1 }`。
- 其它 `/api/*` → 404（不留暗门）。

`.gitignore` 加：

```
save.json
save.json.tmp
```

- [ ] **Step 3: 跑验收** — `node tests/save-server.mjs` → 四项全过。

- [ ] **Step 4: 提交** — `git commit -m "feat(server): /api/save 的 GET/PUT 与 409 仲裁（原子写）"`

---

### Task 3: `main.js` 的远端接线

**Files:**
- Modify: `src/main.js`（`attachSaveTier` 的 boot 与 write；注入 `options.fetch`）
- Test: `tests/save-remote.test.js`（用 `boot({ fetch: stub, storage: stub })`）

**Interfaces:**
- Consumes: `parseSaveResponse / nextRevision / decideBoot / SAVE_PATH`
- Produces: `saveState.backend ('local'|'remote')`、`saveState.revision`、`saveState.fallbackReason`、
  `saveState.conflict ({remoteRevision}|null)`、`controller.resolveConflict('take-theirs'|'force-mine')`

- [ ] **Step 1: 写红测**（关键四条）

1. 远端 200 + 本地无档 ⇒ `saveState.backend === 'remote'`，世界来自远端（名字对得上）。
2. 远端网络错 ⇒ `backend === 'local'`、`fallbackReason !== null`、世界照常跑。
3. 409 ⇒ `conflict.remoteRevision` 等于响应里的数，且此后**再不发 PUT**（fetch 桩数调用次数）。
4. `force-mine` ⇒ 用冲突的 revision 再 PUT 一次且带 `baseRevision = remoteRevision`；
   `take-theirs` ⇒ 再 GET 并用它 restore（世界里的名字换成远端那份）。

- [ ] **Step 2: 实现**

`attachSaveTier` 里加：

```js
  const remote = { backend: 'local', revision: 0, fallbackReason: null, conflict: null, fetcher: options.fetch, inflight: false };
```

- boot 阶段（在 `const doc = load();` 之前）：
```js
  // 远端优先：这条路失败（网络/超时/5xx）就退回本机档并在 HUD 挂"本地存档"（§7.6）。
  // 同步 fetch 只在 Node 测试里出现；浏览器里 main.js 用 async 初始化再启动循环（见 bootTail）。
```
⚠️ 现实约束：`attachSaveTier` 是同步的，而 `fetch` 是异步的。所以远端探测放在 `boot()` 里
**启动循环之前**的一个 async 初始化函数里，`attachSaveTier` 只接受"已经拿到的远端 doc + revision"：

```js
export async function primeRemote(options) → { kind, revision, doc, reason }
```
- `options.fetch` 缺省 → `globalThis.fetch`（`main.js` 唯一允许碰的地方）；
- `AbortSignal.timeout(1500)`（Node 18+ 与浏览器都支持）；
- 任何抛错 → `{ kind: 'error', reason }`。

`boot()` 变成：`const bootRemote = await primeRemote(options)`（boot 本来就返回 controller，
把它改成 async 会破坏所有调用点 —— 所以改成：`boot()` 仍同步返回 controller，
远端探测通过 `controller.ready` 这个 Promise 暴露，主循环在第一拍之前 `await` 它）。
**更简单的做法**：`boot()` 接受可选的 `options.remote`（已探测结果），`bootstrap()`（index.html 里的入口）
负责 `await primeRemote()` 再 `boot({ remote })`。本轮采用后者：`main.js` 导出 `primeRemote`，
`bootstrap` 在 `boot` 之前调用它，`boot` 保持同步（现有 60+ 条 boot 测试一条都不用改）。

- write 阶段：
```js
  const pushRemote = (text, baseRevision) => { ... fetch(SAVE_PATH, { method:'PUT', body: JSON.stringify({ baseRevision, doc: JSON.parse(text) }) }) ... }
```
  - 成功后 `remote.revision = r`、`saveState.revision = r`；
  - 409 → `remote.conflict = { remoteRevision }`、`saveState.blocked = 'conflict'`，**不再发**（`inflight` + `conflict` 双闸）；
  - 网络错 → `remote.backend = 'local'`、`fallbackReason = reason`、把当前 text 写进 `localStorage` 主键。

- `controller.resolveConflict(choice)` 与 `controller.remoteState` 挂出来。

- [ ] **Step 3: 跑绿** + 全套（现有 `tests/save.test.js` 的 boot 测试必须一条都不改地通过）。

- [ ] **Step 4: 提交** — `git commit -m "feat: main 的远端存档接线（探测、PUT、409 冻结与两份选择）"`

---

### Task 4: HUD 角标与冲突条

**Files:**
- Modify: `src/hud.js`（视图模型 `saveBadgeFor(saveState)` + DOM 挂载）
- Modify: `css/…`（角标与冲突条的样式）
- Test: `tests/hud.test.js`、`tests/hud-dom.test.js`

- 判据：全新设备（`backend:'local'` 且 `fallbackReason === null`）**不挂**角标；
  降级时挂"本地存档"；冲突时出现两个按钮、文案含"另一台设备"；两个按钮各有 `aria-label`；
  点"接管"调用 `resolveConflict('force-mine')`、点"加载它的版本"调用 `('take-theirs')`。

---

### Task 5: 验收、文档回写、PR

- `node --test tests/` 全绿（记总数）；`node tests/save-server.mjs` 四项过；
- 真页面尝试（拿不到就照旧如实记）；
- 回写：主 spec §7.5/§7.6 标"局域网档已落地（2026-10-29）"+ 安全边界；清单新增一节；
  `progress.md` 追加；本计划末尾补「执行日志」；
- PR + `--merge` 合并 + 在 main 上复跑。

## Self-Review

**Spec coverage**：设计 §1.1/§1.2 → T2；§1.3 原子写 → T2；§1.4 安全边界 → T5 文档；
§2.1 纯层 → T1；§2.2 接线 → T3；§2.3 HUD → T4；§4 五条判据 → T1（1）、T2（2）、T3（3、4）、T4（5）。
**Placeholder scan**：T3 的 `pushRemote` 与 `primeRemote` 给了签名与行为，实现细节在落地时补全
（这一层与 `attachApiTier` 同形，照抄它的 fetch/错误分支）；T4 的 DOM 结构在落地时按 `dom-stub` 的既有形状写。
