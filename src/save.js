// save.js —— 存档的**版本与迁移**（spec §7.2，Task A8）。
//
// 这个文件只做**纯数据变换**：不读 localStorage、不发请求、不碰任何浏览器 API。
// I/O 属于 src/main.js（架构守卫 tests/constraints.test.js 会把这里拦下来），
// 而"旧档读进来该长成什么样"这件事必须在 Node 里可测 —— 它一旦错就是静默的，
// 症状要等玩家关掉电脑重开才发现。
//
// ⚠️ 迁移最容易做错、且**完全没有症状**的一处：新增的基因位点若取默认值，
// 所有旧个体瞬间性格趋同 —— 缸看起来照常运行，只是"每只都不一样"这件事悄悄消失了。
// 所以位点一律用 rng(seed + id) **派生**：可复现（同一份旧档迁移两次逐位相同），
// 又互相不同。下面 tests/save.test.js 的第 2、3 条就是为了这一件事存在的。
import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { ALL_GENES, randomGenome, phenotype, eggTintBucket, decode } from './genes.js';
import { thresholds } from './personality.js';
import { ROLES } from './memory.js';
import { CATCHPHRASES } from './lexicon.js';

export const SAVE_VERSION = 2;

// FNV-1a 32 位：把个体 id 混进世界种子。
// 为什么不用现成的字符串哈希库 —— 零依赖是硬约束；为什么不用 seed + 序号 ——
// 序号依赖数组顺序，而 v1 的数组顺序与 v2 未必一致（读档后新增的个体会插队）。
// id 是稳定的，所以"同一只生物在两次迁移里拿到同一组新位点"这件事不靠运气。
function idSeed(worldSeed, id) {
  let h = 0x811C9DC5;
  const s = String(id);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ (worldSeed >>> 0)) >>> 0;
}

// 补齐一只生物：返回**新对象**（不改调用方传进来的存档，否则迁移失败时原档已被污染）。
function migrateCreature(c, worldSeed) {
  if (c === null || typeof c !== 'object') {
    throw new TypeError(`migrate: creatures 里出现 ${String(c)}，每条必须是对象`);
  }
  if (typeof c.id !== 'string' || c.id === '') {
    throw new TypeError(`migrate: 个体缺 id（收到 ${JSON.stringify(c.id)}），无法为它派生新位点`);
  }
  const genes = { ...(c.genes || {}) };
  const missing = ALL_GENES.filter((name) => !Object.hasOwn(genes, name));
  if (missing.length) {
    // 用**派生**而不是默认值（文件头那条）。整份基因组一次性抽好，
    // 再按位点名取值 —— 抽的顺序固定，所以结果与"缺了哪几个位点"无关，可复现。
    const drawn = randomGenome(createRng(idSeed(worldSeed, c.id)));
    for (const name of missing) genes[name] = drawn[name];
  }
  // 派生态一律**重建**而不是从旧档读：存档的真相只有 genes，
  // traits / thresholds 是 decode 与性格映射的纯函数结果（spec §7.2 的反面推论：
  // 存它们等于存两份会各自漂移的东西）。不重建的话症状是读档第一 tick 就抛
  // "Cannot read properties of undefined (reading 'size')" —— 这一条是实测踩到的。
  // 只 decode 一次：两处各 decode 一遍的话，将来谁改了参数就会让 traits 与 thresholds 分家。
  const decoded = decode(genes);
  const out = {
    ...c,
    genes,
    traits: decoded,
    thresholds: thresholds(decoded.personality),
    // 语言层（v1 完全没有这一层）
    catchphrase: c.catchphrase || createRng(idSeed(worldSeed, `${c.id}#phrase`)).pick(CATCHPHRASE_POOL),
    heard: Array.isArray(c.heard) ? c.heard.map((e) => ({ ...e })) : [],
    // 关系记忆：存档里是**裸数组**（spec §7.2），运行时是 `{ entries: [...] }`。
    // 两种形状都接受，输出统一成运行时形状。这里不转换的症状是
    // 第一 tick 的 refreshKinMemory 抛 "memory.entries is not iterable" —— 至少它是响的；
    // 更糟的是有人会在调用方各写一次兼容，于是"存档形状"就有两份定义了。
    memory: normalizeMemory(c.memory),
    // 孤雌制下的历史事实：v1 的 father 可能非 null，**原样保留**，不改成 null。
    // 它记录的是"这个存档曾经有过交配"，删掉它等于伪造历史（而家谱图上那一支会突然悬空）。
  };
  if (!Array.isArray(out.lineage?.mates)) {
    out.lineage = { ...(out.lineage || {}), mates: out.lineage?.mates ?? [], offspring: out.lineage?.offspring ?? [] };
  }
  if (!Number.isFinite(out.eggBoost)) out.eggBoost = 0;   // v1 没这个字段，undefined 会让 sizeOf 变 NaN
  if (!Number.isFinite(out.broodT)) out.broodT = 0;
  if (!Number.isFinite(out.begIgnored)) out.begIgnored = 0;
  if (!out.speech) out.speech = { nextAt: 0, lastTokens: null };
  return out;
}

// 关系记忆的两种形状收敛成一个：存档里是裸数组，运行时是 `{ entries }`。
function normalizeMemory(m) {
  if (Array.isArray(m)) return { entries: m.map((e) => ({ ...e })) };
  if (m && Array.isArray(m.entries)) return { entries: m.entries.map((e) => ({ ...e })) };
  return { entries: [] };
}

// 口癖的旧档补值：直接从 lexicon 的三档候选集合并里取，**不在这里再列一份词表** ——
// 两处各写一遍迟早漂移，而漂移的症状是"读档后的口癖在游戏里根本抽不到"。
// 按 id 派生（不是随机）：同一份旧档迁移两次，每只的口癖必须一样。
const CATCHPHRASE_POOL = Object.freeze([
  ...CATCHPHRASES.cute, ...CATCHPHRASES.middle, ...CATCHPHRASES.aloof,
]);

export function migrate(doc) {
  if (doc === null || typeof doc !== 'object') {
    throw new TypeError(`migrate: 存档必须是对象，收到 ${doc === null ? 'null' : typeof doc}`);
  }
  const version = Number.isFinite(doc.version) ? doc.version : 1;
  if (version > SAVE_VERSION) {
    // 比"静默截断到一个不认识的形状"更好的选择是当场说清楚：这是**新**程序写的档，
    // 老程序读它属于未定义行为（spec §7.7 的"绝不静默"）。
    throw new RangeError(`migrate: 存档版本 ${version} 比本程序支持的 ${SAVE_VERSION} 新，请更新程序而不是强行降级`);
  }
  const worldSeed = Number.isFinite(doc.world && doc.world.seed) ? doc.world.seed : 0;
  if (!Array.isArray(doc.creatures)) {
    throw new TypeError('migrate: 存档缺 creatures 数组');
  }
  const creatures = doc.creatures.map((c) => migrateCreature(c, worldSeed));

  // 卵：v1 的卵没有 eggSize / eggTint，缺了会让 hatch 算出 NaN 的 eggBoost，
  // 于是那只生物在画面上直接消失（sizeOf 返回 NaN）。同样按 id 派生。
  const eggs = (Array.isArray(doc.eggs) ? doc.eggs : []).map((e) => {
    if (e === null || typeof e !== 'object') throw new TypeError(`migrate: eggs 里出现 ${String(e)}`);
    const r = createRng(idSeed(worldSeed, `egg:${e.id}`));
    const { min, max } = CONFIG.eggSize;
    const out = { ...e };
    if (!Number.isFinite(out.eggSize)) out.eggSize = r.range(min, max);
    if (typeof out.eggTint !== 'string') {
      out.eggTint = eggTintBucket(phenotype('eggTint', randomGenome(r).eggTint));
    }
    if (typeof out.viable !== 'boolean') out.viable = true;
    return out;
  });

  const world = { ...(doc.world || {}) };
  // 漂入时钟：v1 没有。给"从现在起一个间隔后漂入"而不是 0 ——
  // 填 0 会让读档的第一个 tick 立刻漂入，玩家平白多收到一位客人。
  if (!Number.isFinite(world.nextDriftAt)) world.nextDriftAt = world.time + CONFIG.drift.interval;
  if (!Number.isFinite(world.driftInterval)) world.driftInterval = CONFIG.drift.interval;

  const stats = { driftIns: 0, emigrations: 0, said: 0, ...(doc.stats || {}) };

  return { ...doc, version: SAVE_VERSION, world, creatures, eggs, stats };
}

// 读档后的形状自检：把 memory.remember() 已经守了的那条纪律（五键且有限）
// 在**入口**再守一遍，并对 ROLES 做成员检查。
// 为什么必须有：remember() 只在写条目时校验，而读档路径是直接把数组塞进 creature.memory，
// 绕过了那道门。缺字段的后果全程静默（undefined → NaN → 存盘变 null → 好感归零）。
export function assertCreatureShape(c) {
  if (!c.memory || !Array.isArray(c.memory.entries)) {
    throw new TypeError(
      `assertCreatureShape: ${c.id} 的 memory 不是 { entries: [] } 形状`
      + '（读档路径必须先过 migrate —— 存档里是裸数组，运行时是包一层的对象）',
    );
  }
  for (const e of c.memory.entries) {
    for (const k of ['familiarity', 'affection', 'kinship']) {
      if (!Number.isFinite(e[k])) {
        throw new TypeError(
          `assertCreatureShape: ${c.id} 的记忆条目 ${e.id} 的 ${k} 不是有限数（收到 ${String(e[k])}）`
          + '—— 存档缺这个字段会先在运算里变 NaN，再被 JSON 洗成 null，最后表现为"它好像不认识我了"',
        );
      }
    }
    if (e.role !== null && !ROLES.includes(e.role)) {
      throw new TypeError(`assertCreatureShape: ${c.id} 的记忆条目 ${e.id} 的 role "${String(e.role)}" 不在 ROLES 里`);
    }
  }
  return true;
}
