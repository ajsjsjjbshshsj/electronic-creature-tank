// 共享存档的**协议纯层**。`fetch` 的调用方仍然是 main.js —— §3.2 的机器化守卫规定
// 七个浏览器标识符只许出现在 main.js，所以这一层只做"状态码 + 响应体 → 四种归类"。
// 协议与控制方 2026-10-29 的两条拍定（局域网托管、409 + 让玩家选）见
// docs/superpowers/specs/2026-10-29-shared-save-lan-design.md。
export const SAVE_PATH = '/api/save';

// JSON 里的数字可能是 3、3.0、"3"。只认"能读成有限数"的，其余一律 null；
// 负数与小数一并截成整数 —— revision 是计数器，没有半格这种东西。
const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

function json(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

// HTTP 状态与响应体 → 四种之一。
//
// ⚠️ "200 但缺 doc" 必须是 error，不许读成"服务器上还没有缸"：读错的那一步之后，
// 第一次落盘就会把服务器上那一缸**覆盖成空缸**，而全程没有任何一处报错。
// 404 反过来不看 body —— 那是"服务器上确实没有档"，形状由我们自己的服务器定。
//
// `mode` 区分两条路：GET 的 200 **必须**带 doc（那是缸本身），
// PUT 的 200 只带 revision（那是一次回执）。两者共用一个函数是因为 404/409/error
// 的语义完全一样；分开解析会让"PUT 的 409 也要带版本号"那条判据有两份实现。
export function parseSaveResponse(status, text, mode = 'get') {
  const s = Number(status);
  if (s === 404) return { kind: 'none' };
  const body = json(text);
  if (s === 200) {
    const rev = body ? intOrNull(body.revision) : null;
    const needDoc = mode !== 'put';
    if (!body || rev === null || rev < 0 || (needDoc && (!body.doc || typeof body.doc !== 'object'))) {
      return { kind: 'error', reason: 'bad-save-response' };
    }
    return needDoc ? { kind: 'ok', revision: rev, doc: body.doc } : { kind: 'ok', revision: rev };
  }
  if (s === 409) {
    const rev = body ? intOrNull(body.revision) : null;
    if (rev === null || rev < 0) return { kind: 'error', reason: 'bad-conflict-response' };
    return { kind: 'conflict', revision: rev };
  }
  return { kind: 'error', reason: `status-${s}` };
}

// 服务器侧的语义单点（§7.5："`revision` 只由服务器递增"）。
// 磁盘上的 revision 坏了（负数/NaN/缺失）就从 1 重新起：给 0 会让下一次 409 判据永远相等。
export function nextRevision(base) {
  const n = intOrNull(base);
  return n === null || n < 0 ? 1 : n + 1;
}

// 两边都有档时挑哪一份。
//
// **不同就 ask**：远端更新就静默覆盖本地，是 §7.5 明令禁止的那件事；本地更新就静默
// 覆盖远端同样会丢一边的进度。所以只有"确实同一份"才走捷径。
// 判据只看 revision + savedAt，不逐字节比较 —— 内核的 RNG 不序列化（§7.3.1 第 5 条），
// 两份内容相同但重新序列化过一次的档不该被判成冲突，而 savedAt 是唯一的写入时标。
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
