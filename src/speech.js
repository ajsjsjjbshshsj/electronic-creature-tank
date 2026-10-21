// speech.js —— 规则档语言层：**什么时候说、说哪几个词**（spec §4.13.1）。
//
// 词表在 lexicon.js，这个文件只有时机与组装。分界线是：
// 改 lexicon 会改变"这只宠物给人的气质"，改本文件只会改变"它多话/寡话"。
//
// 三条边界，每条都有测试钉着（不是注释里的愿望）：
//
// 1. **只读世界。** maybeSay 永远不碰 needs / emotions / memory / pos / intent。
//    这是 spec §4.13.2 第 2 条给 API 档定的纪律（"模型不许因为输出改世界"），
//    规则档同样适用 —— 说话不该让它更饱、更开心或更记得你。
//    唯一被写的是 `c.speech` 自己（冷却与上一句），那是语言层的私有状态。
//
// 2. **心情不许自己判。** ctx.mood 必须是 emotions.moodOf 给的，非法值直接抛错。
//    心情是连续内核与离散词表之间的**唯一桥梁**（spec §4.5.1），
//    如果这里再写一套 if 就有第二个定义点，症状是"说的话和做出来的动作分家"，
//    而且两处都不报错 —— 那正是本项目反复抓的静默失败。
//
// 3. **随机性只经由传入的 rng，且用量有界。** 冷却没到期时**一次随机数都不抽**，
//    所以全缸的抽数上限是「个体数 ÷ 冷却秒数」而不是「个体数 × 60」。
//    这一条不是洁癖：世界只有一个 `world.rng`，如果每帧都抽，语言层会**独占整条随机流**，
//    于是所有既有行为（觅食、产卵、漂入）的取值全部平移，"固定种子可复现"虽然仍成立
//    但整个世界的节奏会莫名变味，而且极难归因到"我加了个说话模块"。
//
// CONFIG.speech.enabled = false 时**立刻返回 null 且不写任何字段** ——
// 这是 spec §9.2 第 7 条（关掉文字层，身体语言仍必须完全可读）的机器可查形式。
import { CONFIG } from './config.js';
import { MOODS } from './emotions.js';
import { mostUrgent } from './needs.js';
import { affectionFor, PLAYER_ID } from './memory.js';
import {
  MOOD_WORDS, MOOD_SALIENCE, NEED_WORDS, PLAYER_WORD,
  catchphrasePool, tokenBudget,
} from './lexicon.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 口癖在**出生时**抽定一次并固化进个体（spec §4.13.1：终身稳定）。
// 已抽定时直接返回原值、**不消费随机数** —— 否则读档重建会把整条 rng 流平移，
// 而"同一个存档在不同设备打开长得不一样"是 spec §7 明令避免的。
export function assignCatchphrase(c, rng) {
  if (c.catchphrase) return c.catchphrase;
  const p = c.traits.personality;
  const word = rng.pick(catchphrasePool(p.talk, p.clingy));
  c.catchphrase = word;
  return word;
}

// 出词。返回 { text, tokens } 或 null（这一轮没什么可说）。
export function maybeSay(c, ctx, rng, nowSec) {
  const S = CONFIG.speech;
  // 开关：默认取 CONFIG.speech.enabled，但允许调用方按次覆盖 ——
  // 计划 3 的设置页要在**运行时**关文字层，而 CONFIG 是深冻结的（这是对的，
  // 它是常量表不是状态表），所以覆盖必须走 ctx 而不是改 CONFIG。
  // spec §9.2 第 7 条要的正是"关掉之后身体语言仍完全可读"，这条路径必须能在测试里演练。
  const enabled = ctx && ctx.speechEnabled !== undefined ? ctx.speechEnabled : S.enabled;
  if (!enabled) return null;

  // 入参校验放在冷却判定**之前**：非法心情必须当场炸，而不是"这次恰好没到冷却点所以没报"，
  // 那种时好时坏的失败比稳定失败更难查（与 emotions.applyEvent 拒绝原型键同理）。
  if (!Number.isFinite(nowSec)) {
    throw new TypeError(`maybeSay: nowSec 必须是有限秒数，收到 ${String(nowSec)}`);
  }
  const mood = ctx && ctx.mood;
  if (!MOODS.includes(mood)) {
    throw new TypeError(
      `maybeSay: 未知心情 ${String(mood)}，必须是 MOODS 之一（${MOODS.join(' / ')}）。`
      + '心情只能由 emotions.moodOf 给出 —— 这里不许自己再判一套，否则说的话和动作会分家。',
    );
  }
  if (!c.speech) {
    throw new TypeError('maybeSay: creature.speech 不存在（应由 createCreature 初始化，或读档时补全）');
  }

  if (nowSec < c.speech.nextAt) return null;      // 冷却没到：不抽随机数、不写状态

  // 到点就一定推进，无论这一轮最终有没有说出口。
  // 为什么不能只在"说了"之后推进：那样没通过抽样的个体会**每一帧**重抽，
  // 语言层立刻变成随机数的黑洞（见文件头第 3 条）。
  c.speech.nextAt = nowSec + c.thresholds.speechCooldown;

  const talk = c.traits.personality.talk;
  const needKey = mostUrgent(c.needs);
  const needU = c.needs[needKey];
  // 有多想说 = 需求紧迫度与心情强度取大者。
  // 用 max 而不是相加：相加会让"又饿又开心"比"饿到不行"更爱说话，
  // 而饿到不行的个体该说的是饿饿，不是开心。
  const salience = Math.max(needU, MOOD_SALIENCE[mood]);
  // talk 进**两个**地方（间隔与意愿），这是 spec §4.9 那条"高冷必须真的少说话"的实现形状：
  // 只改间隔的话，talk=0.1 的个体在 20 分钟里说 8 句、talk=0.9 的说 20 句（比值 2.5），
  // 乘上意愿项之后比值才拉到 5 上下 —— 用户能一眼看出差别。
  const will = clamp01((S.sayBase + S.sayGain * salience) * (S.talkFloor + (1 - S.talkFloor) * talk));
  if (!rng.chance(will)) return null;

  const budget = tokenBudget(talk);
  // 三个称呼/修饰位各自独立抽样，顺序照 spec 的句式模板：[口癖]? [称呼]? [状态词] [诉求词]?
  const wantAddr = !!ctx.playerNear
    && affectionFor(c.memory, PLAYER_ID) >= S.addressAffMin
    && rng.chance(S.addressChance);
  const wantCp = !!c.catchphrase && rng.chance(S.catchphraseChance);
  const wantOther = !!ctx.other && rng.chance(S.otherNameChance);
  const needWord = needU >= S.needSpeakMin ? NEED_WORDS[needKey] : null;

  const assemble = (moodWord) => {
    // 必填的永远是心情词 —— 它是那座桥的直接读出。需求词只在真的紧时才加。
    const must = needWord ? [moodWord, needWord] : [moodWord];
    const prefix = [];
    if (wantCp) prefix.push(c.catchphrase);
    if (wantAddr) prefix.push(PLAYER_WORD);
    if (wantOther) prefix.push(ctx.other.name);
    // 超预算就砍修饰，绝不砍心情与需求：宁少说一句口癖，不少说"它此刻的感受"。
    const room = Math.max(0, budget - must.length);
    return [...prefix.slice(0, room), ...must];
  };

  let tokens = assemble(rng.pick(MOOD_WORDS[mood]));
  const sameAsLast = (tk) => c.speech.lastTokens !== null
    && tk.length === c.speech.lastTokens.length
    && tk.every((w, i) => w === c.speech.lastTokens[i]);

  // 同一句不连发：重抽一次心情词，还是撞车就干脆闭嘴 —— 回声比沉默难闻。
  // 抽数仍有界：这一支最多再两次（一个词 + 一次判定），不随缸大小增长。
  if (MOOD_WORDS[mood].length > 1 && sameAsLast(tokens)) tokens = assemble(rng.pick(MOOD_WORDS[mood]));
  if (sameAsLast(tokens)) return null;

  // spec §4.13.1 硬约束：2–5 个 token，绝不生成完整长句。
  // 凑不到两个词就是"真的没什么可说"（安静又满足的个体走的就是这条路）。
  if (tokens.length < 2 || tokens.length > S.maxTokens) return null;

  c.speech.lastTokens = tokens;
  return { text: tokens.join(' '), tokens };
}
