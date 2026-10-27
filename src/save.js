// save.js —— 存档的**版本、迁移与序列化**（spec §7.2，Task A8；序列化 Task C-1）。
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
//
// C-1（2026-10-22）补上 `serialize` —— 它是 `migrate` 的**逆运算**，因此同样是纯变换：
// 给一份世界，还一份能 JSON.stringify 的裸对象，一个浏览器 API 都不碰。
// 把"挑哪些字段"这件事写在这里而不是 main.js 里，理由与上面那条同构：
// 那份清单若住在接线层，它就永远不会在 Node 里被测到，而它错了的症状是
// "存进去的缸读回来缺一样东西"（要等玩家重开才发现）。落盘时机、配额、隔离区
// 才是 main.js 的事（spec §7.2.1 R-1/R-3）。
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
  // 社交同步的进度**不跨读档延续**（CREATURE_SKIP_FIELDS 那一条），所以这里无条件重置，
  // 而不是"缺了才补"：读回来必须是干净的 null/0，否则 bondSync 带着旧进度进 body.js 的
  // 相位插值，症状是"读档第一帧就接着上次响铃"（若是 undefined 则是 NaN，星星不跳了）。
  out.bondId = null;
  out.bondSync = 0;
  out.bondTotal = 0;
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
  // 基因是这张档里**唯一会走进颜色串的数**。记忆里的 NaN 只是"它好像不认识我了"，
  // 基因里的 NaN 会穿过 decode 变成 hue=NaN，再拼成 'hsla(NaN, 70%, 73%, 0.95)' 喂给
  // addColorStop —— 真浏览器在那里当场抛，于是读档之后每一帧都飞（F-17，2026-10-25 实测）。
  // migrate() 只补**缺的键**：键在而值畸形（短数组、裸数、字符串）它照单收下，
  // 所以这道检查必须跟在 migrate 后面，而不是并进它里面（与上面记忆那条同一个位置）。
  const genes = (c && c.genes) || {};
  for (const name of ALL_GENES) {
    const pair = genes[name];
    if (!Array.isArray(pair) || pair.length !== 2
      || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) {
      throw new TypeError(
        `assertCreatureShape: ${c.id} 的基因 ${name} 不是"两个有限数"（收到 ${JSON.stringify(pair)}）`
        + ' —— 它经 decode 会变成 NaN 色相，而真浏览器在 addColorStop 上当场抛',
      );
    }
  }
  return true;
}

// ================================================================ 写盘侧（Task C-1）

// 个体的**派生态与瞬时态**：这两类一律不入档，读回来由 migrate 重建或由内核重算。
//
// · traits / thresholds —— 存档的真相只有 genes，这两样是 decode 与性格映射的纯函数结果。
//   存它们等于存两份会各自漂移的东西（本文件头与 spec §7.2 的反面推论），
//   而漂移的症状是"这只的生物钟与它的基因说的不是同一套阈值"，全程静默。
//   migrate() 里那一行 `traits: decoded` 就是这张清单存在的理由：**两边必须成对**。
// · speech —— 语言层的私有状态（下一次最早开口时刻 + 上一句防连发）。读档后从 0 起，
//   代价是"读档后可能立刻再说一句"，比"存一份 lastTokens 让它永远不许重复那句话"小。
// · intent / intentTime / moving / resting —— 决策层的当前意图。意图里带着**食物 id 与
//   目标个体 id**，而那些编号住在模块级计数器上（breeding.js 的 eggSeq、sim.js 的 foodSeq），
//   新进程里它们指的是别的东西 —— 存它等于让玩家看到"它在追一份不存在的光藻"。
//   读回来第一个 tick 就重新决策，代价只有一帧。
// · beingPetted / beingPoked —— 抚摸与戳的**上升沿**寄存器（creature.js 里那两条注释）。
//   存它们会让读档的第一帧把一次早已结束的手指当成"正在被摸"，joy 平白加一笔。
// · bondId / bondSync / bondTotal —— 社交同步的**此刻进度**（与谁、同步了几秒）。
//   关系本身在 memory 里（role:'companion'），那一份照常入档。存进度的症状是
//   "读档第一帧就接着上次的进度响铃"，而那一记铃应当是它们这一次聊得来的结果。
//   ⚠️ 与 broodT 一样，跳过之后**必须在 migrateCreature 里补默认值**：
//   bondSync 要参与 body.js 的相位插值算术，undefined 会变 NaN（星星不跳了，不抛错）。
export const CREATURE_SKIP_FIELDS = Object.freeze([
  'traits', 'thresholds', 'speech',
  'intent', 'intentTime', 'moving', 'resting',
  'beingPetted', 'beingPoked', 'held',
  'bondId', 'bondSync', 'bondTotal',
]);

// 世界的**运行时容器**：这些不是"状态"，而是状态赖以计算的机器，存下来必然失真。
// · rng / speechRng —— 闭包里的私有序列，JSON.stringify 出来是 `{}`。
//   这正是 spec §7.2.1 R-5 那条"存档是**状态的延续，不是随机流的延续**"的成因：
//   没有任何一条路径能把这两条流写进去，所以"存→读→跑 N tick"不可能与"连跑"逐位相同。
// · grid —— 由 creatures 就地重建的空间索引（sim.js 的 rebuildGrid），存一份 Map 只会多一个真相。
// · events —— 一次性事件队列，表现层每帧清空（sim.js 模块头第 2 条）。它是流水不是状态。
// · nameFor —— 函数。函数进不了 JSON，而"存一个函数名再按名查表"要再造一张注册表。
// · playerHand —— 玩家的手此刻在哪，属于输入层的读数，不属于世界（§7.2：表现层不入档）。
// · creatures / eggs / foods / stats —— 这四个**也在跳过之列**，但它们的原因和上面五个不同：
//   它们在存档**顶层**各有一份（§7.2 那份形状）。世界对象里再写一遍就是同一口缸存两处，
//   一份被 migrate 修过、另一份没有 —— 读回来时谁说了算？而体积直接翻倍（实测满缸 160KB 那一档）。
export const WORLD_SKIP_FIELDS = Object.freeze([
  'rng', 'speechRng', 'grid', 'events', 'nameFor', 'playerHand',
  'creatures', 'eggs', 'foods', 'stats',
]);

// 深拷贝一份纯数据（对象/数组递归；函数与 undefined 丢掉）。第二个参数只在**本层**生效。
//
// 为什么必须是拷贝而不是 `...c`：serialize 的返回值会被调用方**留一会儿**
// （main.js 先拿它算字节数、再 stringify，而这两步之间世界还在被 tick 推进）。
// 浅拷贝会让 doc.creatures[0].pos 与活体共享同一个 {x,y} —— 于是"这一份存档"在
// 它被写出去之前就可能被下一帧改写，症状是**偶发的**"存档里半个坐标来自未来时刻"。
// 那种 bug 只在 4× 倍速 + 恰好落盘的时机下出现，没有任何 profile 会指向这里。
//
// 为什么不用 structuredClone：它能用（Node 与浏览器都有），但**不认识函数** ——
// 遇到 `nameFor` 会当场 DataCloneError。宁可自己写一遍可控的递归，
// 也不要一个"看起来更专业"的调用替我决定报错长什么样。
function snapshot(value, skip) {
  if (Array.isArray(value)) return value.map((v) => snapshot(v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (skip && skip.includes(k)) continue;
      const v = value[k];
      // 函数与 undefined 在这一层就地消失：JSON 本来也表达不了它们，
      // 而"悄悄写出一份少了这两个键的档"比"当场炸"更难查 —— 所以这里宁可直接不写。
      if (typeof v === 'function' || v === undefined) continue;
      out[k] = snapshot(v);
    }
    return out;
  }
  return typeof value === 'function' ? undefined : value;
}

// 一份世界 → 一份裸对象。⚠️ 本函数**不读时钟**：Date.now() 在纯函数里就是第二个
// Math.random()（constraints.test.js 拦的是后者，但同一条"不可复现"的精神在这里成立）。
// savedAt 由调用方（main.js）作为 meta 传入，于是"同一份世界 + 同一份 meta ⇒ 逐位相同"
// 可以在 Node 里被 deepEqual 钉死，而落盘那一刻的真实时间戳仍然留在存档里给人看。
//
// §7.4 明写"恢复时不补算流逝时间"，所以 savedAt 目前只是证据，不参与任何运算。
export function serialize(world, meta) {
  if (world === null || typeof world !== 'object' || !Array.isArray(world.creatures)) {
    throw new TypeError('serialize: 需要一个带 creatures 数组的世界，'
      + `收到 ${world === null ? 'null' : typeof world}`);
  }
  const m = meta || {};
  const w = snapshot(world, WORLD_SKIP_FIELDS);
  // timeScale 是**页面入口**的节奏读数（main.js 的 state.timeScale），不是世界字段，
  // 所以内核给的快照里没有它。§7.2 把它列在 world 那一段 ⇒ 由调用方经 meta 传进来补上，
  // 消费方也是页面入口（restoreWorld 刻意不读它：倍速不归内核管）。
  if (Number.isFinite(m.timeScale)) w.timeScale = m.timeScale;
  return {
    version: SAVE_VERSION,
    // revision 属于服务器（spec §7.5：客户端从不自行计算它）。计划 2R 没有服务器，
    // 所以这里恒写 0 —— 写 0 而不是省略，是为了让 §7.5 那套比对将来接上服务器时
    // 不需要先猜"这个键缺失代表什么"。
    revision: Number.isInteger(m.revision) ? m.revision : 0,
    savedAt: typeof m.savedAt === 'string' ? m.savedAt : null,
    // 顶层四个键（world / creatures / eggs / foods）+ stats 就是 §7.2 那份形状。
    // ⚠️ 键名以**运行时形状**为准：§7.2 的草图写作 `food`、卵的 `mother`/`x`/`y`，
    // 而内核里是 `foods` / `motherId` / `pos:{x,y}`。两处各叫各的迟早漂移，
    // 所以裁定"以代码为准、spec 的草图跟着改"（记在 §7.2.1）。
    world: w,
    creatures: world.creatures.map((c) => snapshot(c, CREATURE_SKIP_FIELDS)),
    // 卵与食物没有需要重建的派生态（eggSize / eggTint 的缺由 migrate 兜），整份拷贝。
    eggs: snapshot(Array.isArray(world.eggs) ? world.eggs : []),
    foods: snapshot(Array.isArray(world.foods) ? world.foods : []),
    stats: snapshot(world.stats || {}),
  };
}
