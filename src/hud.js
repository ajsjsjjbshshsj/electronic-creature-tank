// HUD 的视图模型。计划 3 Task 3。**纯**：只读 world / creature，产出字符串与数字，不碰 DOM。
// DOM 那一半在 Task 4 追加到本文件末尾，它拿 `doc` 是**形参注入**的（与 render.js 的 ctx、
// audio.js 的 graph、input.js 的监听目标同一条路子）—— 于是本文件不出现 document/window，
// tests/constraints.test.js 的纯度守卫照旧覆盖它。
//
// 这个文件存在的意义不是"把字排好看"，是**守住一条边界**：
// 信息卡是照料者的观察记录，不是它在对你说话（spec §6.3 / §13.2 第 4 条）。
// 所以这里**没有一行**读 moodOf —— 唯一读它的是肖像，而肖像是它的脸，
// 属于 spec 明文许可的那条正面通道（"心情只能从它自己的身体和它自己选择的词里读出来"）。
import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';
import { affectionFor, PLAYER_ID } from './memory.js';
import { expressionFor, avatarSrc } from './avatar.js';

const H = CONFIG.hud;
const DASH = '—';

// 九维性格的轴名。顺序 = spec §4.1 那张表的顺序，**也是雷达图的顶点顺序**，
// 换序等于换图，所以它是一份要显式改的清单而不是 Object.keys 的副产品。
const PERSONALITY_AXES = Object.freeze([
  ['bold', '大胆'], ['clingy', '黏人'], ['irritable', '暴躁'], ['gluttonous', '贪吃'],
  ['curious', '好奇'], ['activity', '好动'], ['talk', '话多'], ['intellect', '聪明'],
  ['broody', '恋巢'],
]);

// 阶段与蛋色的中文表。**键集必须与内核那边同一份**，所以有测试逐键比对
// （tests/hud.test.js 的"八个蛋色都有名字"那条）—— 少一个的症状不是报错，
// 而是卡上直接吐出 'macaron-lilac' 这种玩家读不懂的英文键。
const STAGE_LABEL = Object.freeze({
  hatchling: '幼体', juvenile: '亚成体', adult: '成体', elder: '老年', dead: '已故',
});
const EGG_TINT_LABEL = Object.freeze({
  'macaron-pink': '马卡龙粉', 'macaron-blue': '马卡龙蓝', 'macaron-mint': '马卡龙薄荷',
  'macaron-lilac': '马卡龙丁香', 'macaron-cream': '马卡龙奶油', 'macaron-peach': '马卡龙蜜桃',
  white: '奶白', black: '炭黑',
});

const num = (v) => (Number.isFinite(v) ? v : 0);
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const hasOwn = (o, k) => Object.hasOwn(o, k);

/**
 * 秒 → 人话。四段刻度，**分/时的低位补零**：不补的话时间在跳秒时整行宽度抖动，
 * 而这一行每 250ms 重排一次（H.cardRefreshMs）。
 */
export function formatAge(sec) {
  if (!Number.isFinite(sec) || sec < 0) return DASH;
  const s = Math.floor(sec);
  if (s < 60) return `${s}秒`;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}天${pad2(Math.floor((s % 86400) / 3600))}时`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${pad2(s % 60)}秒`;
  return `${Math.floor(m / 60)}时${pad2(m % 60)}分`;
}

/** 左上那两块读数 + 右上时间。**不数溶散中的那一只**（它已经不算种群）。 */
export function readoutFor(world) {
  const cs = (world && world.creatures) || [];
  let alive = 0;
  for (const c of cs) if (c && c.alive !== false && c.stage !== 'dead') alive += 1;
  return {
    population: alive,
    foods: ((world && world.foods) || []).length,
    eggs: ((world && world.eggs) || []).length,
    // 传**原值**而不是 num()：缺 time 的脏 world 要出「—」，而不是骗人说"0秒"。
    timeLabel: formatAge(world && world.time),
  };
}

/** 好感 −1..1 → 心形的填充度 0..1。脏值取"空心"：它没被认识过，不是半心。 */
export function heartFillFor(affection) {
  const a = Number.isFinite(affection) ? affection : -1;
  const k = (a + 1) / 2;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

export function radarFor(traits) {
  const p = (traits && traits.personality) || {};
  return PERSONALITY_AXES.map(([k, axis]) => ({ axis, v: num(p[k]) }));
}

/**
 * 体型档位。**输入是 sizeOf(c)（世界单位，含年龄与蛋加成）而不是 traits.size** ——
 * 用 traits.size 的话幼体会显示"中"，而它在画面上就是比同窝的小。
 * 档位按 [minSize, maxSize] 三等分：中位数 26 落在"中"，这是玩家读到最自然的那个数。
 */
export function sizeTier(px) {
  const lo = CONFIG.minSize;
  const span = CONFIG.maxSize - lo;
  if (!(span > 0)) return '中';
  const k = Math.floor(((num(px) - lo) / span) * 3);
  return k <= 0 ? '小' : k === 1 ? '中' : '大';
}

function byId(world, id) {
  if (!id || !world || !Array.isArray(world.creatures)) return null;
  for (const c of world.creatures) if (c && c.id === id) return c;
  return null;
}
const nameOf = (c) => ((c && c.name) || DASH);
const joinNames = (list) => (list.length ? list.slice(0, H.cardWordsMax).join('、') : DASH);

/**
 * 关系四行。spec §6.3 的家谱树属计划 4，这四行是**同一批数据的另一种画法**，
 * 它满足 §9.2 第 2 条（"你能看出两只之间的关系"）。
 */
export function relationRowsFor(c, world) {
  const lineage = (c && c.lineage) || {};
  const kids = (Array.isArray(lineage.offspring) ? lineage.offspring : [])
    .map((id) => byId(world, id)).filter(Boolean).map(nameOf);
  // **同胞没有内核访问器**：只有 lineage.mother，和 memory 里 role==='sibling' 那半截
  // （registerKinship 只在同窝孵化那一刻写，跨代就没了）。所以这里扫 world ——
  // 表现层**读**内核合法，写才不合法（全局约束第 6 条）。
  const motherId = lineage.mother;
  const sibs = motherId && Array.isArray(world && world.creatures)
    ? world.creatures
      .filter((x) => x && x !== c && x.lineage && x.lineage.mother === motherId
        && x.alive !== false && x.stage !== 'dead')
      .map(nameOf)
    : [];
  const pals = (((c && c.memory) || {}).entries || [])
    .filter((e) => e && e.role === 'companion')
    .map((e) => nameOf(byId(world, e.id)))
    .filter((n) => n !== DASH);
  return [
    { label: '母亲', value: nameOf(byId(world, motherId)) },
    { label: '孩子', value: joinNames(kids) },
    { label: '同胞', value: joinNames(sibs) },
    { label: '同伴', value: joinNames(pals) },
  ];
}

function heardWords(c) {
  const list = Array.isArray(c && c.heard) ? c.heard : [];
  // 排序键用 uses 而不是 heard.js 那个 strengthOf：后者要 nowSec 与半衰期，
  // 一行字里塞进时间衰减的读数会让"刚学的词"和"学了三年的词"在卡上不分彼此，
  // 而这一行的用途是"让玩家看见它记住了哪些词"，不是"预测它下一句说什么"。
  return list.slice()
    .sort((a, b) => num(b && b.uses) - num(a && a.uses) || num(a && a.heardAt) - num(b && b.heardAt))
    .map((e) => (e && typeof e.token === 'string' ? e.token : ''))
    .filter((t) => t.length > 0)
    .slice(0, H.cardWordsMax);
}

function eggRow(c) {
  const tint = c && c.traits && c.traits.eggTint;
  const color = tint && hasOwn(EGG_TINT_LABEL, tint) ? EGG_TINT_LABEL[tint] : DASH;
  const boost = num(c && c.eggBoost);
  const size = boost > 0.08 ? '大蛋' : boost < -0.08 ? '小蛋' : '中蛋';
  return `${color} · ${size}`;
}

/**
 * 信息卡的全部内容。**rows 里没有任何一项随情绪变** —— 那是 §13.2 第 4 条的落点，
 * 由 tests/hud.test.js 用"只差情绪的两只个体 rows 逐字节相同"这条行为判据钉住。
 */
export function cardFor(c, world) {
  const words = heardWords(c);
  const offspringCount = Array.isArray(c && c.lineage && c.lineage.offspring)
    ? c.lineage.offspring.length : 0;
  const stage = c && c.stage;
  return {
    title: (c && c.name) || '未命名',
    rows: [
      { label: '名字', value: (c && c.name) || '未命名' },
      { label: '年龄', value: formatAge(c && c.age) },
      { label: '阶段', value: hasOwn(STAGE_LABEL, stage) ? STAGE_LABEL[stage] : DASH },
      { label: '体型', value: sizeTier(c ? sizeOf(c) : 0) },
      relationRowsFor(c, world)[0],                 // 只要"母亲"那一条；其余三条在关系区
      { label: '孩子', value: `${offspringCount} 只` },
      { label: '蛋', value: eggRow(c) },
      { label: '记住的词', value: words.length ? words.join('、') : DASH },
    ],
    radar: radarFor(c && c.traits),
    heart: heartFillFor(affectionFor((c && c.memory) || { entries: [] }, PLAYER_ID)),
    portrait: avatarSrc(expressionFor(c)),
  };
}
