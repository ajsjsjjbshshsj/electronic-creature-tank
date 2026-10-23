// HUD 肖像层的映射。计划 3 Task 2。**纯**：只读 CONFIG 与两个已存在的派生函数，
// 不碰 DOM、不碰 Image —— 加载图片那一步在 main.js（Task 5），本文件只交出 URL。
//
// 为什么要单独立一个模块而不是在 hud.js 里就地写 if 链：
// 这张"我们的档名 ↔ 素材的文件名"对照表是全项目**唯一**一处两边名字不同的地方
// （anger/angry、bliss/love、curiosity/surprised、arousal/wink）。
// 名字对错了不报错，症状是"生气的那只显示一张笑脸" —— 它需要自己的测试文件。
import { CONFIG } from './config.js';
import { moodOf, dominant } from './emotions.js';

const A = CONFIG.avatar;

// 复用的 ctx 容器（spec §5.3：每帧每只都跑的东西不许分配）。
// 只读不写回：心情是**只读派生量**，不是第二个状态（emotions.js 那条 §4.5 的裁定）。
const CTX = { adversity: false };

/** 八个表情名（= CONFIG.avatar.file 的键）。导出是为了让测试能拿它当全集，而不是再抄一遍字面量。 */
export const EXPRESSIONS = Object.freeze(Object.keys(A.file));

/**
 * 这一只现在是什么脸色。返回的是**我们**的名字（`EXPRESSIONS` 里那八个），
 * 文件名要再过一道 avatarSrc()。
 *
 * 两跳的次序是裁定的结果，不是随手写的：
 *  ① 先看 moodOf 那五档 —— 它是"连续内核与离散词表之间唯一的桥"（spec §4.5.1），
 *     脸色当然跟着它；
 *  ② 只有落在 calm 时才看 dominant() —— moodOf 不区分困、好奇、兴奋，而素材有这三张脸。
 *     **反过来不行**：happy 的那只即使 sleepy 分量更高也不许换成打哈欠的脸，
 *     那等于把①已经定了的结论又推翻一次。
 */
export function expressionFor(c) {
  const emotions = c && c.emotions;
  const needs = c && c.needs;
  const memory = c && c.memory;
  // 三个都判：moodOf 会走到 affectionFor(memory, …)，memory 缺字段的话那里会抛，
  // 而"存档里少一个键的个体"是 C-1 已经见过的那类脏数据 —— 一张呆板的脸也比一屏红字好。
  if (!emotions || !needs || !memory) return A.fallback;
  CTX.adversity = !!(c.mourn && c.mourn > 0);
  const mood = moodOf(emotions, needs, memory, CTX);
  if (mood !== 'calm') return mood;
  const d = dominant(emotions);
  // 只认这三张有脸谱的；joy / anger / fear 走到这里说明 moodOf 已经判过它们不是主导档了。
  return d === 'sleepy' || d === 'curiosity' || d === 'arousal' ? d : A.fallback;
}

export function avatarSrc(expr) {
  // Object.hasOwn 而不是 in：`avatarSrc('constructor')` 用 in 会命中原型，
  // 然后拼出一个 'assets/[object Object]' 这种查都查不出来的 URL。
  const name = Object.hasOwn(A.file, expr) ? expr : A.fallback;
  return `${A.dir}/${A.file[name]}`;
}

/**
 * 开缸时要**一次性**加载的那八张。README.txt 那句
 * "Load images once; do not instantiate Image during frame rendering" 就是这个清单的存在理由：
 * 信息卡每开一次就 new 一张 Image 的话，手机上翻三只个体就开始重复拉同一批图。
 */
export function preloadList() {
  return EXPRESSIONS.map((k) => `${A.dir}/${A.file[k]}`);
}
