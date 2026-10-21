// lexicon.js —— 规则档语言层的**词表**（spec §4.13.1）。
//
// 这个文件只有数据与两条"哪些词可用"的选择规则，没有任何出词时机逻辑 ——
// 时机在 speech.js。分开是因为本文件是**会被玩家看见的东西**，
// 改一个词就改变整个缸的气质；而时机是概率与冷却，改了不会让人觉得"换了一只宠物"。
//
// 三个集合都冻结，纪律与 PATTERNS / INTENTS / MOODS 同源：它们被 speech.js 与表现层
// 共同 import，一次就地 `.push()` / 改值会静默改变选词结果（症状是"某档永远沉默"），
// 而**摘掉 Object.freeze 不会让任何内容断言变红**，所以冻结本身由测试钉住。
//
// ⚠️ 词表内容属 spec §12「待实现时决定的细节」授权范围（按观感定，无需再确认），
// 但**键集不是**：NEED_WORDS 的四个键必须与 needs.js 的四条匮乏度一一对应，
// MOOD_WORDS / MOOD_SALIENCE 的五个键必须与 emotions.js 的 MOODS 一一对应。
// 对齐由 tests/speech.test.js 断言 —— 漂移的后果是某一档悄悄查不到词而沉默。
import { CONFIG } from './config.js';

// 口癖：活泼爱撒娇的才有萌系词，高冷的候选集里只有"哼"。
// spec 点名要"喵喵 / 咩咩"这类，所以 cute 集合必须含它（测试钉住，防止整组换血时丢掉用户要的东西）。
export const CATCHPHRASES = Object.freeze({
  cute: Object.freeze(['喵喵', '咩咩', '啵啵', '呜喵', '咕咕']),
  middle: Object.freeze(['呜', '嗯', '啵', '哈']),
  aloof: Object.freeze(['哼']),
});

// 需求词：四条匮乏度里最紧的那一条（与 needs.js 的键同名，由测试对齐）。
export const NEED_WORDS = Object.freeze({
  hunger: '饿饿',
  energy: '困困',
  social: '要摸摸',
  safety: '怕怕',
});

// 情绪词：按心情档分池。calm 只有一个"……"，所以安静又满足的个体常常凑不出句子 ——
// 沉默是设计，不是缺实现（spec §4.13.1：高冷的正确实现方式是"少说"）。
export const MOOD_WORDS = Object.freeze({
  anger: Object.freeze(['气气', '坏']),
  sad: Object.freeze(['呜呜', '伤心']),
  bliss: Object.freeze(['幸福', '好开心']),
  happy: Object.freeze(['开心', '玩']),
  calm: Object.freeze(['……']),
});

// "有多想说"：心情档给的基础强度，与需求紧迫度取大者后进抽样门。
// calm 刻意只有 0.05（而不是 0）：留一点点余地，免得安静满足的个体在长会话里
// 变成完全不动的雕像 —— 那反而读不出心情。真正的门是下面的 token 下限（凑不出两句就沉默）。
export const MOOD_SALIENCE = Object.freeze({
  anger: 0.7, sad: 0.6, bliss: 0.8, happy: 0.55, calm: 0.05,
});

export const PLAYER_WORD = '主人';

// ---- 听进去的话：分词的停用表与切分（spec §4.8.1，Task A7）----
//
// 停用词表按"整词等于它"来筛，不按子串 —— 中文没有词边界，子串匹配会把
// "也要好好吃饭" 里正常的一部分误杀。所以表里只放**独立成词时几乎不承载信息**的东西。
// 刻意保守：宁可留下几个虚词当"实词"，也不要因为表太长把有信息的词切掉 ——
// 前者只是略啰嗦，后者是"它好像什么都没记住"。
export const STOPWORDS = Object.freeze([
  '今天', '明天', '昨天', '一下', '一个', '这个', '那个', '我们', '你们', '他们',
  '什么', '怎么', '为什么', '因为', '所以', '但是', '可以', '这样', '那样',
  '还有', '就是', '不是', '没有', '知道', '觉得',
]);

const SEPARATORS = /[，。！？；：、,.\u2026\uFF0E\uFF1F\s"'（）()【】\[\]~—\-]+/;

// 中文切词：按标点/空白先切段，段内取 2–3 gram（2 字优先，因为中文实词绝大多数是双字），
// 再丢停用词与单字。这是**够用的启发式**，不是分词器：
// 计划 A7 的陷阱条说得很清楚 —— 测试只能钉行为，不能钉具体切法，否则换个策略就全红。
export function tokenize(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const out = [];
  const push = (w) => {
    const t = w.trim();
    if (t.length < 2) return;                    // 单字几乎总是虚词或噪声
    if (STOPWORDS.includes(t)) return;
    if (!out.includes(t)) out.push(t);
  };
  for (const raw of text.split(SEPARATORS)) {
    const seg = raw.trim();
    if (!seg) continue;
    if (seg.length <= 3) { push(seg); continue; }
    // 长段：滑窗取 gram，先 3 字后 2 字（长的更像词，也少切出半截虚词）
    for (let i = 0; i + 3 <= seg.length; i += 1) push(seg.slice(i, i + 3));
    for (let i = 0; i + 2 <= seg.length; i += 1) push(seg.slice(i, i + 2));
  }
  return out;
}

// 说错词时的替换池：同一张词表里的另一个词。
// ⚠️ 这是"近邻"在规则档里能做到的**全部** —— 它按"同属一张表"选，不按语义相似选。
// 导出为扁平数组并冻结：heard.js 直接 filter/pick，一次就地改动会全局影响说错词的结果。
export const WORD_POOL = Object.freeze([
  ...Object.values(NEED_WORDS),
  ...MOOD_WORDS.anger, ...MOOD_WORDS.sad, ...MOOD_WORDS.bliss,
  ...MOOD_WORDS.happy, ...MOOD_WORDS.calm,
]);

// 候选集由 talk × clingy 定（spec §4.13.1 表格第一层）。
// 用**乘积**而不是相加：相加会让"高冷但不黏人"和"活泼但不黏人"落进同一个池子，
// 而这两个词族的气质差别恰恰在黏不黏人上；乘积要求两者都高才拿到萌系词。
export function catchphrasePool(talk, clingy) {
  const S = CONFIG.speech;
  const s = talk * clingy;
  if (s >= S.cutePoolFloor) return CATCHPHRASES.cute;
  if (s >= S.middlePoolFloor) return CATCHPHRASES.middle;
  return CATCHPHRASES.aloof;
}

// 候选词宽度也由性格定（spec §4.13.1：「talk 决定出词间隔与候选词宽度」）。
// 高冷 2 个 token，话痨到 CONFIG.speech.maxTokens 为止 —— 上限由测试钉住不得越界。
export function tokenBudget(talk) {
  const S = CONFIG.speech;
  return Math.min(S.maxTokens, S.tokensBase + Math.round(talk * S.tokensGain));
}
