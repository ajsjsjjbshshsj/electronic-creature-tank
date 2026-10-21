// heard.js —— 听进去的话（spec §4.8.1，Task A7）。
//
// 能力边界先说死，因为它决定这套实现值不值得信：规则引擎这一档做的是
// **记住并复现关键词**，不是理解语义。它能做到"你说过吃饭，它饿的时候会提"，
// 不能区分"今天"和"明天"、不能回答问题、不能把两个词组合出新意思。
// 那些是可选 API 档的事（§4.13.2），不许在这里假装做到。
//
// 为什么是**独立模块**而不是并进 memory.js（这是对计划的一处偏离，理由写在这里）：
// memory.js 是一组严格的**五键关系条目**契约 —— remember() 逐键校验有限性、
// decay 按 role/kinship 分两条速率、prune 按 familiarity 淘汰、玩家那条豁免。
// 而 heard 是另一种记录：七个键、按 uses 分两条半衰期、按 strength 淘汰、没有"角色"。
// 两种记录塞进同一个模块，decay/prune 就得开始判"这是哪种条目" ——
// 那正是本项目抓过的"一份代码同时伺候两套契约"的成因。
// 关系与对话各管各的，共享的只有"指数淡忘"这一条数学。
//
// 两条边界（都有测试钉着）：
//   1. 只写 c.heard，绝不碰 needs / emotions / memory / behavior —— 与 speech.js 同一界。
//      这条是 spec §4.13.2 第 2 条（"语言不许改世界"）在规则档里的等价保证。
//   2. heard **不占**关系记忆的 12 条配额 —— "记得你说的话"和"记得你"是两回事，
//      混在一个池子里，热闹缸里的对话会把玩家本人挤掉。
import { CONFIG } from './config.js';
import { NEED_KEYS } from './needs.js';
import { tokenize, WORD_POOL } from './lexicon.js';

// 条目的七个键 —— **存档契约**，形状变了迁移就得跟着改（spec §7.2）。
// ⚠️ 比 spec 原先写的六个键多一个 boundNeed：spec §4.8.1 的例子（"存了吃饭，
// 在它 hunger 高时说出来"）要求把词与**当时的需求**绑在一起，只存 boundMood 做不到
// —— 心情是 sad 不等于那条匮乏是饿。已回头把 spec 的键表改成七个。
export const HEARD_KEYS = Object.freeze(
  ['token', 'price', 'boundMood', 'boundNeed', 'heardAt', 'lastUsed', 'uses'],
);

const LN2 = Math.log(2);

// 总条数上限 = 4 + round(intellect × 8)（spec §4.8.1：傻的存 4 条、聪明的存 12 条）。
// 数值来自 personality.thresholds().heardCapacity —— A1/A2 加了这个旋钮但**一直没有消费者**，
// 本轮它就是消费者（"无生产者的旋钮"要撤，反过来"有旋钮没消费者"也一样要补）。
export function heardCap(t) {
  return Math.round(t.heardCapacity);
}

// 半衰期：反复听到（uses ≥ strongUses）的词加倍 —— "被反复说的词记得牢"。
// 写成乘法而不是再配一条独立速率：uses 与时间这两个因素不会因调参而分家。
function halfLifeOf(e) {
  const H = CONFIG.heard;
  return e.uses >= H.strongUses ? H.halfLife * H.strongFactor : H.halfLife;
}

// 剩余强度 ∈ (0,1]，随时间指数下降且**与时间步长严格无关**
// （用 exp 而不是 (1 − rate·dt)，同 memory.decay：否则 120Hz 的手机会比 60Hz 忘得快）。
// 读 lastUsed 而不是 heardAt：目前只有 hear 会写 lastUsed —— 复述不算"又听到一次"，
// 否则"反复听到才记得牢"会被自己的复述刷成永生。
export function heardRetention(e, nowSec) {
  const age = Math.max(0, nowSec - e.lastUsed);
  return Math.exp(-LN2 * age / halfLifeOf(e));
}

// 淘汰用的强度 = (1 + uses) × 剩余强度。
// ⚠️ 不能只比剩余强度：刚听到的词此刻强度是 1.0，而反复说过六次的老词是 0.99，
// 于是"新词永远挤掉老朋友"，"反复说的记得牢"这句话会在淘汰这一步被自己推翻
// —— 第一版实测就栽在这里。
function strengthOf(e, nowSec) {
  return (1 + e.uses) * heardRetention(e, nowSec);
}

// 从候选里挑这一次真正听进去的几个：数量随 curious 上升。
// 排序键是**长度**（长一点更像词、信息量更大），等长时用 rng 打乱 ——
// 于是"同一句话在不同时刻听进去的词并不完全相同"，这是它像生物而不像字典的地方。
function selectCandidates(tokens, curious, rng) {
  const H = CONFIG.heard;
  const uniq = [];
  for (const t of tokens) if (!uniq.includes(t)) uniq.push(t);
  if (!uniq.length) return [];
  const n = Math.max(1, Math.round(H.takeBase + curious * H.takeGain));
  if (uniq.length <= n) return uniq;
  // 等长组内部用 rng 决定先后；跨组仍按长度降序（这样"数量随 curious 上升"是干净的因果）
  const decorated = uniq.map((t, i) => ({ t, i, key: -t.length + rng.next() * 0.5 }));
  decorated.sort((a, b) => (a.key - b.key) || (a.i - b.i));
  return decorated.slice(0, n).map((x) => x.t);
}

// 听见了玩家说的话。返回本次真正存下/更新的条目数（给输入层与诊断用）。
//
// opts.mood：**听到时的心情**，它给这个词定价（spec §4.8.1：你常叫的名字它会回头，
// 你拿来骂过的词它会躲）。缺省按 calm ⇒ 零价，既不奖励也不惩罚。
// opts.need：听到时最紧的那条需求（调用方用 needs.mostUrgent 给），
//            它就是日后把这个词想起来的线索。缺省 'hunger' 而不是 undefined：
//            条目恒有这一个键，读档与校验才不会遇到"有的记录有这个键有的没有"。
export function hear(c, text, rng, nowSec, opts) {
  if (typeof text !== 'string') {
    throw new TypeError(`hear: 文本必须是字符串，收到 ${typeof text}（静默收下会在存档里变成 null）`);
  }
  if (!Number.isFinite(nowSec)) {
    throw new TypeError(`hear: nowSec 必须是有限秒数，收到 ${String(nowSec)}`);
  }
  const mood = (opts && opts.mood) || 'calm';
  if (!Object.hasOwn(CONFIG.heard.moodPrice, mood)) {
    // 用 Object.hasOwn 而不是真值判断：moodPrice 是朴素对象字面量，
    // 'constructor' / 'toString' 取出来是 truthy 的函数，会让拼错的档位
    // 静默把一个函数当价格存下去（JSON 再洗成 null）。
    throw new TypeError(`hear: 未知心情 ${String(mood)}，价格表里没有这一档`);
  }
  if (!Array.isArray(c.heard)) {
    throw new TypeError('hear: creature.heard 不存在（应由 createCreature 初始化，或读档时补空数组）');
  }

  const H = CONFIG.heard;
  const taken = selectCandidates(tokenize(text), c.traits.personality.curious, rng);
  if (!taken.length) return 0;
  // opts.need **必填**：它就是日后把这个词想起来的线索。
  // 刻意不给默认值 —— 默认 'hunger' 的症状是「它总在饿的时候提起任何词」，
  // 一个听起来还算合理的错，比直接抛错难查十倍（与 memory.remember 校验五键同一条纪律）。
  const boundNeed = opts && opts.need;
  if (!NEED_KEYS.includes(boundNeed)) {
    throw new TypeError(
      `hear: opts.need 必须是四条匮乏度之一（${NEED_KEYS.join(' / ')}），收到 ${String(boundNeed)}`,
    );
  }
  const price = H.moodPrice[mood];

  let changed = 0;
  for (const token of taken) {
    let e = null;
    for (const x of c.heard) if (x.token === token) { e = x; break; }
    if (e) {
      // 反复听到：加 uses、把 lastUsed 推到此刻。
      // price / boundMood / heardAt **一律不动** —— spec 明写"第一次听到时的心情定价"。
      // 覆盖的话，你事后夸它几句就能把骂过的词洗白，而那不是设计。
      e.uses += 1;
      e.lastUsed = nowSec;
    } else {
      c.heard.push({
        token, price, boundMood: mood, boundNeed, heardAt: nowSec, lastUsed: nowSec, uses: 1,
      });
      changed += 1;
    }
  }
  // 超容量淘汰最弱的。新来的此刻强度最高，不会被自己挤掉。
  while (c.heard.length > heardCap(c.thresholds)) {
    let victim = null;
    for (const x of c.heard) {
      if (victim === null || strengthOf(x, nowSec) < strengthOf(victim, nowSec)) victim = x;
    }
    if (!victim) break;
    c.heard.splice(c.heard.indexOf(victim), 1);
  }
  return taken.length;
}

// 冒出一个相关的词，或 null（"它此刻不该提这个"也是结果）。
//
// 相关性 = 听到时绑定的那条需求，与**现在**最紧的需求对上。
// 这是规则档能做到的"情境联想"的全部形状：不查语义、不建索引，只保留当时的处境。
// rng 是必需参数：说错词的概率由它抽样，缺省会让"有的特别聪明有的特别傻"静默消失
// —— 抛错比那条差异悄悄不见要好（与 emotions.applyEvent 拒绝原型键同一类决定）。
export function recall(c, ctx, nowSec, rng) {
  if (!rng || typeof rng.chance !== 'function') {
    throw new TypeError('recall: 必须传入 rng（智力差异靠它抽样，缺省会静默变成"人人都说得准"）');
  }
  const H = CONFIG.heard;
  if (!ctx || ctx.need === undefined || ctx.need === null) {
    throw new TypeError('recall: ctx.need 必须给出（词就是绑在这条需求上存进去的）');
  }
  let best = null;
  let bestScore = -1;
  for (const e of c.heard) {
    if (e.boundNeed !== ctx.need) continue;
    if (e.price <= H.suppressBelow) continue;          // 被骂过的词，它自己不再提
    const retention = heardRetention(e, nowSec);
    if (retention < H.retainMin) continue;             // 淡过头了，遗忘是真的
    // 同一处境里存下的东西更容易被想起：心情对上给一个 boost，对不上仍按剩余强度参与。
    const score = retention * (e.boundMood === ctx.mood ? 1 + H.moodBoost : 1);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (!best) return null;

  // 智力必须是**看得见的**：intellect 低 → 按 misspeakChance 换成同一张词表里的另一个词。
  // ⚠️ "近邻"在规则档里只能实现成"同一张词表里的另一个词"，不是语义相近 ——
  // 语义相近是 API 档的事，这里不许假装做到。
  const chance = c.thresholds.misspeakChance;
  if (chance > 0 && rng.chance(chance)) {
    const pool = WORD_POOL.filter((w) => w !== best.token);
    // 反向确认：池子只剩一个词时宁可原样说，也不要返回 undefined 让表现层画出"undefined"。
    if (pool.length > 0) return { token: rng.pick(pool), price: best.price, misspoke: true };
  }
  return { token: best.token, price: best.price, misspoke: false };
}
