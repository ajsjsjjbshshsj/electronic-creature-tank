// api.js —— 可选 API 档的**纯函数层**（spec §4.13.2 / §4.13.2.1，Task B19b-i 与 B19b-ii）。
//
// 分工与 src/bubble.js / src/eyes.js / src/audio.js 同一形状：**算**的东西全在这里，
// 而且这一层连浏览器能力都不需要 —— 它**一个请求都不发**。发请求、掐时间、把文字换进气泡
// 是接线层（B19b-ii，住在 main.js）的事，那个以 f-e-t-c-h 四个字母拼成的名字在 src/ 里
// 只许出现在 main.js（tests/constraints.test.js 逐字扫这个文件）。
// 拆的理由还是可测性：喂给模型什么、接受什么样的回复、什么时候算超时、一句话最多被按多久，
// 全是**值**，能在 Node 里逐条断言；混进绘制与网络路径之后就只剩"看起来能用"。
// B19b-ii 在末尾追加的**暂存队列**守同一条界线：它按住一句话的手里只有一个数字
// （那条 deadline），而那个数字由调用方逐帧喂进来 —— 所以这层照样零定时器、零能力。
//
// 这一层的核心裁定（spec §4.13.2.1 第 1 条）：**API 档是输出侧的旁路，不是开关。**
// 内核照旧决定"说不说、什么时候说"（自己的概率、冷却、speechRng），照旧发那条带着
// 规则档文案的 say 事件；本层只接手"已经要说的那一拍"，返回一段替换文字，或者
// 明确返回"没有替换"。**它没有资格让一只生物闭嘴。**
// 于是三条纪律变成结构性的而不是愿望：
//   1. 失败即回落（§4.13.2 第 1 条）⇒ 每一个出口都是"替换或不变"，不存在"不发"这条路。
//   2. 只读旁路（§4.13.2 第 2 条）⇒ 本模块**没有任何一处**写 world / creature / 任何入参，
//      也不消费随机数（连一个随机源形参都没有），产出只有一个字符串。
//      所以"开了 API 档世界就变了味"这类事故在这层不可能发生，
//      而 tests/api.test.js 里那条"真缸穿插调用之后指纹逐位相同"就是它的机器形式。
//   3. 跨档位验收（§4.13.2 第 3 条）⇒ 既然开关不改变世界，§9.2 第 7 条在两个档位下
//      就是同一条测试，不需要为 API 档再做一份。
//
// 还有一条**泄露侧**的纪律（spec §7.2 末，第 4 条）：key 由调用方传进来，
// 只准进 authorization 头这一个地方。本模块返回的**任何**诊断/拒绝对象都不许带上它 ——
// 诊断只报"哪个字段不对"，不报那个字段的值。CONFIG.api 里也没有 key 的位置。
//
// ⚠️ 本模块**不碰本机存储**（那是 main.js 的口子），不碰 DOM，不调 Math.random，
// 也不自取当前时间：时钟一律由调用方作为参数传进来（world.time / startMs / nowMs）。
// 否则同一个种子在两台设备上会给出不同的提示词，而 spec §7 明令避免这类漂移。
import { CONFIG } from './config.js';
import { MOODS } from './emotions.js';
import { NEED_KEYS } from './needs.js';
import { NEED_WORDS } from './lexicon.js';
import { heardRetention } from './heard.js';
import { affectionFor, PLAYER_ID } from './memory.js';

// 规则档的句式下限（spec §4.13.1「2–5 个 token」）。上限**不写第二份**：
// 它住在 CONFIG.speech.maxTokens，而每一只个体的实际上限由 lexicon.tokenBudget(talk) 给，
// 由调用方算好传进来 —— 这里再配一套预算就是把同一条纪律抄成两处（本项目清账的老题材）。
const MIN_TOKENS = 2;

// 机器可读的拒绝原因（接线层按它计数与提示，绝不按自然语言句子分支）。
export const REASONS = Object.freeze({
  SHAPE: 'bad-shape',                    // 形状就不是"一段话"
  EMPTY: 'empty',                        // 清洁之后什么都不剩
  TOO_LONG: 'too-long',                  // 超出 textMaxChars
  TOO_FEW_TOKENS: 'too-few-tokens',      // 低于规则档的 2 词下限
  TOO_MANY_TOKENS: 'too-many-tokens',    // 高于这只个体的 token 预算
  CATCHPHRASE_ONLY: 'catchphrase-only',  // 只是把口癖复读了一遍
});

// configIssue 的原因表：同样只报**字段名**，不报值（值可能就是 key）。
export const CONFIG_REASONS = Object.freeze({
  DISABLED: 'disabled',
  EMPTY_ENDPOINT: 'empty-endpoint',
  INSECURE_ENDPOINT: 'insecure-endpoint',   // spec §13.2 第 3 条：强制 https
  EMPTY_MODEL: 'empty-model',
  EMPTY_KEY: 'empty-key',
  BAD_TIMEOUT: 'bad-timeout',
  BAD_MAX_TOKENS: 'bad-max-tokens',
  BAD_TEMPERATURE: 'bad-temperature',
});

// 五档心情**给模型看的档名**，逐字取自 spec §4.5.1 那张表（愤怒/伤心/幸福/快乐/安静）。
// 这张表只做一件事：把 MOODS 的那个键翻成中文。它**不判档**（判档只有 emotions.moodOf 一处）、
// 也**不选词**（选词只有 lexicon.MOOD_WORDS 一处）。少一档的症状是摘要里出现 undefined，
// 而模型会把"undefined"当成一个词说出去 —— 所以键集对齐由测试钉住，不靠注释。
export const MOOD_LABELS = Object.freeze({
  anger: '愤怒', sad: '伤心', bliss: '幸福', happy: '快乐', calm: '安静',
});

// 性格 → 一句措辞。personality.js 只有 thresholds()（数值映射），**没有任何措辞函数**，
// 所以这三行只能在这里组一次；措辞一律从 spec §4.9 那张表的"调制效果"列压缩而来，
// 不新写人设、也不演性格（spec §4.9 那条"高冷要真的少说话，不是换一套更酷的词"）。
// ⚠️ 这些字符串**只进提示词**，永远不许被表现层拿去画信息卡（spec §6.3 的硬边界：
//    屏幕上不许出现替它陈述情绪与性格的字）。tests/api.test.js 里有一条扫描钉这一点。
// 键序即平局优先级（与性格基因表同序），保证"全 0.5"这种退化情形仍然确定。
export const PERSONA_WORDS = Object.freeze({
  bold: Object.freeze({ high: '胆子大', low: '胆小' }),
  clingy: Object.freeze({ high: '很黏人', low: '爱独处' }),
  irritable: Object.freeze({ high: '一点就炸', low: '脾气好' }),
  gluttonous: Object.freeze({ high: '贪吃', low: '对吃不上心' }),
  curious: Object.freeze({ high: '好奇爱探索', low: '对新东西冷淡' }),
  activity: Object.freeze({ high: '好动爱蹦', low: '不爱动' }),
  talk: Object.freeze({ high: '话痨', low: '高冷少说' }),
  intellect: Object.freeze({ high: '记得牢', low: '记不住词' }),
  broody: Object.freeze({ high: '常产卵', low: '不太产卵' }),
});

// https 前缀。写成正则而不是字符串常量还有一个好处：src/ 里不出现连续两个斜杠，
// 而 tests/constraints.test.js 那个剥注释的启发式正是在"字符串里的 //"上会多删一行。
const HTTPS_RE = /^https:/;
const COMPLETIONS = '/chat/completions';

// 控制字符（含 \n \r \t）与零宽字符一律换成空格而不是删掉：
// 删掉会把"开心\n幸福"粘成"开心幸福"，那是替它把两个词说成一个词。
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;

// 整对包裹的引号（模型最常见的"我把答案包起来了"）。只剥**一整对**、只剥一层，
// 句中引号是内容的一部分，不许顺手删 —— 那等于改它说过的话。
const WRAP_PAIRS = Object.freeze([
  ['“', '”'], ['"', '"'], ['「', '」'], ['『', '』'], ['`', '`'], ['\'', '\''],
]);

const finite = (v) => Number.isFinite(v);

// 夹到 n 个字符（含省略号），**结果长度 ≤ n**。每一格都用它，
// 于是摘要的长度是"由构造保证"的，而不是靠最后裁一刀。
const clip = (s, n) => {
  const t = String(s);
  if (n <= 0) return '';
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

// 两位小数：摘要里唯一的那个数（好感）必须是**读数**而不是 17 位浮点尾巴。
// 为什么不写成"很亲/生疏"这类词：词表里没有好感这一层，凭空造一张档位表就是第二个定义点，
// 而 affectionFor 已经是唯一来源 —— 保留它，只把精度夹住。
const round2 = (v) => Math.round((finite(v) ? v : 0) * 100) / 100;

const readNum = (v) => (finite(v) ? v : 0);

// 清洁 + 折叠空白 + 剥整对引号。suggestion 也走同一条，所以两处不会长出不一样。
const normalizeText = (s) => {
  let t = String(s).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  for (const [open, close] of WRAP_PAIRS) {
    if (t.length >= open.length + close.length
        && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length).trim();
      if (inner !== '') { t = inner; break; }
    }
  }
  return t;
};

// 匮乏度降序的 top-N（用的是 NEED_WORDS 那一层的词，不是数字）。
// 平局按 NEED_KEYS 的次序 —— 与 needs.mostUrgent 那条 hunger > energy > social > safety
// 的优先级**同一条式子**，否则摘要说"最紧的是困困"而内核说饿饿。
const topNeeds = (needs, n) => {
  const list = NEED_KEYS.map((k, i) => ({ k, i, v: readNum(needs && needs[k]) }));
  list.sort((a, b) => (b.v - a.v) || (a.i - b.i));
  return list.slice(0, Math.max(0, n)).map((x) => NEED_WORDS[x.k] || x.k);
};

// 当前最强的几条"听进去的话"。
// ⚠️ 排序用的是 heard.heardRetention（**已导出**的剩余强度），不是 heard.js 里那条
//    私有 strengthOf：把它的式子抄到这里就是第二个定义点，而改一处不会让另一处报警。
//    差别如实记在这里：淘汰用的强度额外乘了 (1 + uses)，所以本摘要的排序可能与
//    "它淘汰谁"略有出入 —— 摘要要的是"此刻还记得住什么"，那条 retention 就是它的读数。
const topHeard = (heard, nowSec, n) => {
  if (!Array.isArray(heard)) return [];
  const usable = [];
  for (let i = 0; i < heard.length; i++) {
    const e = heard[i];
    if (!e || typeof e.token !== 'string' || e.token === '') continue;
    if (!finite(e.lastUsed) || !finite(e.uses)) continue;   // 脏条目（旧档/手写）不参与
    usable.push({ token: e.token, i, r: readNum(heardRetention(e, nowSec)), u: e.uses });
  }
  usable.sort((a, b) => (b.r - a.r) || (b.u - a.u) || (a.i - b.i));
  const A = CONFIG.api;
  return usable.slice(0, Math.max(0, n)).map((x) => clip(x.token, A.wordMaxChars));
};

// 性格三行：偏离 0.5 最多的先进。平局按 PERSONA_WORDS 的键序（确定，且与随机基因无关 ——
// 每只个体的性格本来就不同，这里不需要任何抽样）。
const topPersona = (personality, n) => {
  const keys = Object.keys(PERSONA_WORDS);
  const list = keys.map((k, i) => {
    const v = readNum(personality && personality[k]);
    return { k, i, v, d: Math.abs(v - 0.5) };
  });
  list.sort((a, b) => (b.d - a.d) || (a.i - b.i));
  return list.slice(0, Math.max(0, n))
    .map((x) => (x.v >= 0.5 ? PERSONA_WORDS[x.k].high : PERSONA_WORDS[x.k].low));
};

// ---------------------------------------------------------------- 摘要

// 结构化状态摘要（spec §4.13.2 逐字：喂给它的不是原始向量，而是结构化状态摘要）。
// **白名单投影**，不是转储：八格里每一格都点名要的东西，长度各自夹住，
// 六分量情绪向量一个都不进（那只生物不会说"我 joy 0.62"，spec §4.5.1 早就说过）。
// c / world / ctx 一律只读，返回一个字符串。
export function buildSummary(c, world, ctx) {
  const A = CONFIG.api;
  if (!c || typeof c !== 'object') {
    throw new TypeError('buildSummary: 需要 creature 对象（摘要的全部来源都在个体上）');
  }
  if (!world || !finite(world.time)) {
    throw new TypeError(
      `buildSummary: world.time 必须是有限模拟秒，收到 ${world && String(world.time)}。`
      + '时间只能由世界给（与气泡层同一条时钟）；这里不许自取当前时间，否则同一存档在'
      + '两台设备上会得到不同的提示词。',
    );
  }
  const mood = ctx && ctx.mood;
  if (!MOODS.includes(mood)) {
    throw new TypeError(
      `buildSummary: 未知心情 ${String(mood)}，必须是 MOODS 之一（${MOODS.join(' / ')}）。`
      + '心情只能由 emotions.moodOf 给出 —— 这里再判一套就有第二个定义点，'
      + '症状是"喂给模型的心情和它做出来的动作分家"。',
    );
  }
  const suggestion = ctx ? ctx.suggestion : undefined;
  if (suggestion !== undefined && suggestion !== null && typeof suggestion !== 'string') {
    throw new TypeError(`buildSummary: ctx.suggestion 给了就要是字符串，收到 ${typeof suggestion}`);
  }
  // 与 speech.js 检查 c.speech 同一条：缺了它就从"静默给 0 好感"变成"当场抛错"。
  // 前者会让模型把一只记得清清楚楚的生物当成陌生活物，而这不报错。
  if (!c.memory) {
    throw new TypeError('buildSummary: creature.memory 不存在（应由 createCreature 初始化，或读档时补全）');
  }

  const lines = [
    `名字：${clip(c.name === undefined || c.name === null ? '' : c.name, A.nameMaxChars)}`,
    `口癖：${clip(typeof c.catchphrase === 'string' ? c.catchphrase : '', A.wordMaxChars)}`,
    `此刻心情：${MOOD_LABELS[mood]}`,
    `最紧的需求：${topNeeds(c.needs, A.summaryNeedTop).join('、')}`,
    `性格：${topPersona(c.traits && c.traits.personality, A.personaLines).join('、')}`,
    `刚听进去的话：${topHeard(c.heard, world.time, A.summaryHeardTop).join('、')}`,
    `对玩家好感：${round2(affectionFor(c.memory, PLAYER_ID))}`,
  ];
  // 规则档那一句作为**建议**附上（spec §4.13.2.1 第 1 条：这一拍本来就已经要说这句话）。
  // 缺省不占位：占一个空格子会让模型以为"这次没有参考说法"，而那是它读不出来的差别。
  if (typeof suggestion === 'string' && suggestion.trim() !== '') {
    lines.push(`可以照着说：${clip(normalizeText(suggestion), A.suggestionMaxChars)}`);
  }
  // 逐格已经夹过，这一刀是给**改了别的旋钮的人**兜底的：摘要的预算只有一个定义点，
  // 就是 summaryMaxChars。必填字段都在前面，可选字段在后面，所以真裁到时先伤的是建议。
  return clip(lines.join('\n'), A.summaryMaxChars);
}

// ---------------------------------------------------------------- 配置诊断

const issue = (reason, field) => ({ reason, field });

// 为什么 buildRequest 返回了 null（§7.7「绝不静默」在这一层的落点）。
// ⚠️ 返回的对象**只许有 reason / field 两个键**，而 field 是字段**名**：
//    把值写进诊断就等于把 cfg.key 抄进日志与错误消息。tests/api.test.js 逐键断言这件事。
export function configIssue(cfg) {
  const A = CONFIG.api;
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (!c.enabled) return issue(CONFIG_REASONS.DISABLED, 'enabled');

  const endpoint = typeof c.endpoint === 'string' ? c.endpoint.trim() : '';
  if (endpoint === '') return issue(CONFIG_REASONS.EMPTY_ENDPOINT, 'endpoint');
  // 明文 http 会把 key 整条广播到局域网上（这台设备与服务器之间的任何人都能捡走），
  // 所以这不是"建议用 https"而是**不发**：回落规则档，缸照常说话。
  if (!HTTPS_RE.test(endpoint)) return issue(CONFIG_REASONS.INSECURE_ENDPOINT, 'endpoint');

  const model = typeof c.model === 'string' ? c.model.trim() : '';
  if (model === '') return issue(CONFIG_REASONS.EMPTY_MODEL, 'model');

  const key = typeof c.key === 'string' ? c.key.trim() : '';
  // 没有 key 就**根本不发**，而不是发一个必然 401 的请求：后者会让"填了 key 反而不说话"
  // 变成每次出词都要付一次往返延时（spec §4.13.2 第 1 条要防的就是这个形状）。
  if (key === '') return issue(CONFIG_REASONS.EMPTY_KEY, 'key');

  const timeoutMs = c.timeoutMs === undefined ? A.timeoutMs : c.timeoutMs;
  if (!finite(timeoutMs) || timeoutMs <= 0 || timeoutMs > A.timeoutMaxMs) {
    return issue(CONFIG_REASONS.BAD_TIMEOUT, 'timeoutMs');
  }
  const maxTokensOut = c.maxTokensOut === undefined ? A.maxTokensOut : c.maxTokensOut;
  if (!Number.isInteger(maxTokensOut) || maxTokensOut < 1 || maxTokensOut > A.maxTokensOutCap) {
    return issue(CONFIG_REASONS.BAD_MAX_TOKENS, 'maxTokensOut');
  }
  const temperature = c.temperature === undefined ? A.temperature : c.temperature;
  if (!finite(temperature) || temperature < 0 || temperature > A.temperatureMax) {
    return issue(CONFIG_REASONS.BAD_TEMPERATURE, 'temperature');
  }
  return null;
}

// OpenAI 兼容的 /chat/completions。三种写法都要得到同一个 URL：
// 基址、带尾斜杠的基址、已经拼好路径的基址（用户从 curl 示例里抄来的往往是最后一种）。
const completionsUrl = (endpoint) => {
  let base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith(COMPLETIONS)) base = base.slice(0, -COMPLETIONS.length).replace(/\/+$/, '');
  return `${base}${COMPLETIONS}`;
};

// 系统提示：那条句式纪律必须**写在提示里**。否则模型写一段散文是它的合理行为，
// 而我们只在事后拒掉它 —— 那是把约定单方向地藏在校验里，拒因会说谎。
const systemPrompt = () => {
  const max = CONFIG.speech.maxTokens;
  return [
    '你在替一只毛绒五角星小生物决定这一小句话怎么说。',
    `只输出 ${MIN_TOKENS} 到 ${max} 个词，词与词之间用一个空格隔开。`,
    '不要完整句子，不要标点，不要解释，不要引号，不要换行。',
    '你唯一的产出就是这段文字：你不能改变任何东西，也不要试图改变任何东西。',
    '下面那段摘要写着它此刻的心情、最紧的需求、性格、听进去的话与对玩家的好感。',
    '如果摘要最后有"可以照着说"，那是保底规则已经写好的说法，照抄或换个说法都可以。',
  ].join('\n');
};

// ---------------------------------------------------------------- 请求描述

// 返回的是**一段纯数据描述**：{ url, method, headers, body, timeoutMs }。
// 这里没有请求、没有中止控制器、没有定时器 —— 那些是接线层的事（它自己造那个控制器，
// 并用 deadlineFor / shouldAbort 决定什么时候掐）。
// 关闭 / 缺字段 ⇒ null，且**没有别的代码会继续往下走**（configIssue 是唯一的前置门）。
export function buildRequest(summary, cfg) {
  const bad = configIssue(cfg);
  if (bad) return null;
  const A = CONFIG.api;
  if (typeof summary !== 'string' || summary === '') {
    throw new TypeError(
      'buildRequest: summary 必须是非空字符串。传个体进来会被 JSON 转储成整份存档 ——'
      + '摘要只能由 buildSummary 投影出来（spec §4.13.2.1 第 3 条）。',
    );
  }
  const c = cfg;
  const model = c.model.trim();
  const key = c.key.trim();
  return {
    url: completionsUrl(c.endpoint),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // key 在这一个地方出现，且只在这里。它不进 body（body 会被写进日志与诊断）、
      // 不进 URL（URL 会被复制粘贴）、也不进任何返回值以外的通道。
      authorization: `Bearer ${key}`,
    },
    body: {
      model,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: summary },
      ],
      max_tokens: c.maxTokensOut === undefined ? A.maxTokensOut : c.maxTokensOut,
      temperature: c.temperature === undefined ? A.temperature : c.temperature,
      // 流式恒关，不是旋钮：那会把"最多 2 行"变成逐字喷泉（spec §4.13.1 显示纪律），
      // 而接线层没有任何办法在中途把已经喷出去的字收回来。
      stream: false,
    },
    timeoutMs: c.timeoutMs === undefined ? A.timeoutMs : c.timeoutMs,
  };
}

// 在途闸门（spec §4.13.2 的"别把缸打成弹幕"那一侧）。纯计数，不记账：
// 谁在飞、什么时候落地是接线层的事，这里只回答"现在还能不能再塞一条"。
export function maySend(inFlight, cfg) {
  const A = CONFIG.api;
  if (!Number.isInteger(inFlight) || inFlight < 0) {
    throw new TypeError(`maySend: 在途数必须是非负整数，收到 ${String(inFlight)}`);
  }
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (!c.enabled) return false;                       // 默认关闭：一个请求都不发
  const max = c.maxInFlight === undefined ? A.maxInFlight : c.maxInFlight;
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(`maySend: maxInFlight 必须是非负整数，收到 ${String(max)}`);
  }
  return inFlight < max;
}

// ---------------------------------------------------------------- 回复校验

// 只接受很窄的几种形状，别的都是拒绝（带机器可读的原因）。
// 一条都不许"就地修好再收"：形状不对就是不对，猜它是哪种形状就等于把模型的输出
// 喂回内核 —— 那是 spec §4.13.2 第 2 条明令禁止的方向。
const extractContent = (raw) => {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const message = first.message;
  if (!message || typeof message !== 'object') return null;
  return typeof message.content === 'string' ? message.content : null;
};

const reject = (reason) => ({ ok: false, reason });

// 把"已经要说的那一拍"换一段措辞：返回 { ok: true, utterance } 或 { ok: false, reason }。
// utterance 的形状与 speech.maybeSay **逐字同形**（{ text, tokens } 且 text === tokens.join(' ')），
// 所以气泡层认不出这段话是谁给的 —— 那是"两档不可互换"这个 bug 类别的结构性免疫。
//
// 入参契约（budget / c）用**抛错**，内容不合法用**拒绝**：与 speech.js 把"非法心情"抛掉、
// 把"没什么可说"返回 null 是同一条分界。契约错了是接线层写错了，静默降级会把句长上限
// 悄悄漂移成"永远拒"或"永远收"。
export function validateReply(raw, budget, c) {
  const A = CONFIG.api;
  if (!Number.isInteger(budget) || budget < MIN_TOKENS || budget > CONFIG.speech.maxTokens) {
    throw new TypeError(
      `validateReply: budget 必须是 ${MIN_TOKENS} 到 ${CONFIG.speech.maxTokens} 的整数`
      + `（调用方传 lexicon.tokenBudget(talk)），收到 ${String(budget)}`,
    );
  }
  if (!c || typeof c !== 'object') {
    throw new TypeError(
      'validateReply: 需要 creature（口癖复读那条规则要用它的 catchphrase；'
      + '缺了就静默跳过那条规则，等于把它删掉）',
    );
  }
  const catchphrase = c.catchphrase;
  if (catchphrase !== null && catchphrase !== undefined && typeof catchphrase !== 'string') {
    throw new TypeError(`validateReply: creature.catchphrase 要嘛是字符串要嘛没有，收到 ${typeof catchphrase}`);
  }

  const content = extractContent(raw);
  if (content === null) return reject(REASONS.SHAPE);

  // 清洁：控制字符与换行换成空格（换行会把一行气泡撑成第三行，spec §4.13.1 不许），
  // 连续空白折叠，整对包裹引号剥掉。
  const text = normalizeText(content);
  if (text === '') return reject(REASONS.EMPTY);
  // 先比字符数再比 token 数：一段没空格的中文散文只有 1 个 token，
  // 只查 token 数就会让 400 字的东西以"too-few-tokens"的名义通过（拒因会说谎）。
  if (text.length > A.textMaxChars) return reject(REASONS.TOO_LONG);

  const tokens = text.split(' ');
  if (tokens.length < MIN_TOKENS) return reject(REASONS.TOO_FEW_TOKENS);
  if (tokens.length > budget) return reject(REASONS.TOO_MANY_TOKENS);
  // 把口癖复读三遍不是"说话"，那是回声。规则档对"同一句不连发"的做法是干脆闭嘴，
  // 这里对应地判"没有替换" —— 回落的那句仍然带着同一个口癖，但至少有内容。
  if (typeof catchphrase === 'string' && catchphrase.length > 0
      && tokens.every((t) => t === catchphrase)) {
    return reject(REASONS.CATCHPHRASE_ONLY);
  }
  return { ok: true, utterance: { text: tokens.join(' '), tokens } };
}

// ---------------------------------------------------------------- 超时决策

// 绝对截止时刻。接线层用它去掐（那个中止控制器归它，本模块连它的名字都不许出现）。
// 时钟回拨（now < start，跨设备/休眠唤醒都会给出来）时**以当前时刻重新起算**：
// 照抄 start + timeout 会把 deadline 留在过去，请求当场被判超时 ⇒ 每条都要回落，
// 症状恰好是 spec §4.13.2 第 1 条禁止的"填了 key 反而不说话了"。
export function deadlineFor(startMs, nowMs, timeoutMs) {
  if (!finite(startMs) || !finite(nowMs)) {
    throw new TypeError(
      `deadlineFor: startMs / nowMs 必须是有限毫秒数，收到 ${String(startMs)} / ${String(nowMs)}`,
    );
  }
  if (!finite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`deadlineFor: timeoutMs 必须是正数，收到 ${String(timeoutMs)}`);
  }
  return (nowMs < startMs ? nowMs : startMs) + timeoutMs;
}

// 到点就算超时（`>=` 而不是 `>`）：用 `>` 的话存在"deadline 恰好等于 now 且时钟不走"
// 那一格，请求会被判永不超时并一直挂着。
export function shouldAbort(nowMs, deadlineMs) {
  if (!finite(nowMs) || !finite(deadlineMs)) {
    throw new TypeError(
      `shouldAbort: 两个时刻都必须是有限毫秒数，收到 ${String(nowMs)} / ${String(deadlineMs)}`,
    );
  }
  return nowMs >= deadlineMs;
}

// ================================================================ 暂存队列（B19b-ii）
//
// 为什么这一半住在 api.js 而不是 main.js：它的语义（先进先出、有上界、到期先出、
// 每个出口都有计数）全是**值**，在 Node 里能逐条断言；混进 f-e-t-c-h 与绘制路径之后就只剩
// "看起来会冒泡"。与 bubble.js / eyes.js / audio.js 的拆法同一条理由。
//
// 这一层的形状由 spec §4.13.2.1 第 7 条（B19b-ii 落定的那一条）决定：
// **有界的按住，不是事后换字。** 内核发出的那条 say 事件被这里接管住（不再当帧转发给
// 消费方），最多多等 `CONFIG.api.apiHoldMs` 毫秒，然后**无论手上是什么文案都交出去**。
// 于是"最多延后 apiHoldMs"是结构性质，而"让它闭嘴"这条通路在这层根本不存在：
// 队列的每一个出口都交出一句话，差别只在那句话是模型写的还是规则档写的。
//
// ⚠️ 这里**没有任何定时器**（s-e-t-t-i-m-e-o-u-t 那一家族的两个名字一个都不许出现）。
// 超时机制就是帧循环里的 `duePending` 一趟扫描 —— 于是 stop() 之后没有定时器要收拾，
// 也不可能出现"某个回调在缸停之后把字塞进气泡池"。时钟由调用方逐帧传进来。
//
// ⚠️ 槽位存的是**内核那一条事件对象本身的引用**，队列自己不造事件对象（稳态零分配）。
// 接管期间文案可以改写在那个对象上（`resolvePending`），改写发生在它被交出去之前 ——
// 交出去之后世界与队列都不再引用它，所以不会撞到后来那一拍。
// 被换掉的是 `text` / `tokens` 两个字段，`c.speech.lastTokens` 指的是另一个数组，不受影响。

// pushPending 的结果原因（接线层按它计数，绝不按自然语言分支）。
export const PUSH_REASONS = Object.freeze({
  OK: 'ok',                    // 老老实实进了一个空槽
  BAD_SHAPE: 'bad-shape',      // 事件形状不对 ⇒ 没接管；调用方必须照旧把它转发（不许吞）
  SUPERSEDED: 'superseded',    // 同一只又开口，旧的那拍让位（旧的那拍**交出去**，不是丢掉）
  OVER_CAP: 'over-cap',        // 队列满了，挤掉最早到期的一条（同样是交出去，不是丢掉）
});

// 一拍的四种去路。每一条都必须留下一个读数（§7.7 不许静默）。
export const RELEASE_WHY = Object.freeze({
  DUE: 'due',                        // 到点，没有回复 ⇒ 规则文案
  RESOLVED: 'resolved',              // 回复落地（模型文案或"没有替换"）
  SUPERSEDED: 'superseded',          // 被同一只的新句顶掉 ⇒ 当场交付
  OVER_CAP: 'over-cap',              // 被容量挤掉 ⇒ 当场交付
});
// ⚠️ 表里只有"确实交出去了"的这四种去路。停缸收走记在 `p.dropped`、交付缓冲区满记在
// `p.giveOverflow` 与 `p.stuck`，它们都**不是**交付 —— 给一句没能说话的句子配一个
// release 的 why，等于把 `released === replaced + fellBack` 那条守恒式拿去撑数。

const SLOT_FREE = 0;
const SLOT_USED = 1;

// 容量由调用方定（接线层取气泡队列容量：按住的话数永远不该超过显示层装得下的条数）。
export function createPending(cap) {
  const n = Math.max(1, Math.floor(finite(cap) ? cap : 1));
  return {
    n, count: 0,
    used: new Uint8Array(n),
    // 槽位里存的是那条 say 事件的引用；下面四个数组只是**读数**（断言与诊断用），
    // 其中 text/tokens 两个会在模型回复落地时被改写回那个对象上。
    ev: new Array(n).fill(null),
    id: new Array(n).fill(''),
    text: new Array(n).fill(''),
    tokens: new Array(n).fill(null),
    mood: new Array(n).fill(''),
    deadlineMs: new Float64Array(n),
    // 代号：每次占用槽位都要新号。迟到的回复只能对上号才能写字，
    // 对不上就是"那一拍早就走了" ⇒ 丢弃并计数（决策 F 的后半段）。
    token: new Float64Array(n),
    seq: 0,
    changed: new Uint8Array(n),      // 1 = 这一拍最终交出去的是模型文案
    // ---- 两个复用容器（长度有界，运行中只写不 push）----
    due: new Array(n).fill(-1), dueCount: 0,
    give: new Array(n + 1).fill(null), giveIdx: new Array(n + 1).fill(-1), giveCount: 0,
    // ---- 诊断读数 ----
    lastIdx: -1, lastToken: 0, lastReason: '',
    // ---- 计数器：每一个出口都有名字 ----
    accepted: 0, rejected: 0, superseded: 0, overCap: 0, expired: 0,
    resolved: 0, refused: 0, released: 0, replaced: 0, fellBack: 0,
    late: 0, dropped: 0, droppedStaged: 0, giveOverflow: 0, stuck: 0, notTaken: 0, peak: 0,
  };
}

// 最早到期的那个槽位（并列时取代号最小的 ⇒ 同刻按入队先后，确定且无随机）。
function oldestIdx(p) {
  let best = -1;
  for (let k = 0; k < p.n; k++) {
    if (p.used[k] !== SLOT_USED) continue;
    if (best < 0
        || p.deadlineMs[k] < p.deadlineMs[best]
        || (p.deadlineMs[k] === p.deadlineMs[best] && p.token[k] < p.token[best])) best = k;
  }
  return best;
}

// 第一个空槽（下标升序 ⇒ 槽位复用顺序确定，测试可以照着写）。
function freeSlot(p) {
  for (let k = 0; k < p.n; k++) if (p.used[k] === SLOT_FREE) return k;
  return -1;
}

// 这只生物现在手上有没有一句还按着的话。**导出**是因为"同一只不许叠加"这条规矩
// 需要调用方在 push 之前就能看见它（顶位的那条要当场交出去，而交付是接线层的事）。
export function findPending(p, id) {
  if (typeof id !== 'string' || id === '') return -1;
  for (let k = 0; k < p.n; k++) if (p.used[k] === SLOT_USED && p.id[k] === id) return k;
  return -1;
}

// 把第 idx 拍交出去。返回 1 = 进了交付缓冲区，0 = 缓冲区满（留在槽里、标成已到期）。
function handOff(p, idx, why) {
  if (p.giveCount >= p.give.length) {
    // 这条**不该被走到**（缓冲区比槽位还多一格，而调用方每推一条就抽干一次）。
    // 真走到了也只许多计数不许吞字：把 deadline 压到过去，下一帧的 duePending 一定捡起来。
    p.giveOverflow += 1;
    p.stuck += 1;
    p.deadlineMs[idx] = -1;
    return 0;
  }
  const ev = p.ev[idx];
  p.released += 1;
  if (p.changed[idx] === 1) p.replaced += 1;
  else p.fellBack += 1;
  if (why === RELEASE_WHY.DUE) p.expired += 1;
  p.give[p.giveCount] = ev;
  p.giveIdx[p.giveCount] = idx;
  p.giveCount += 1;
  p.used[idx] = SLOT_FREE;
  p.ev[idx] = null;
  p.id[idx] = '';
  p.text[idx] = '';
  p.tokens[idx] = null;
  p.mood[idx] = '';
  p.changed[idx] = 0;
  p.count -= 1;
  return 1;
}

// 接管一条已经要说出口的一句话。
// 返回 1 = 这一拍归队列交付；返回 0 = **队列没收它**，调用方必须当场原样交付那一句
// （两种没收：形状不对 `bad-shape`，以及腾不出位 `over-cap` —— 都不许让那句话消失）。
// ⚠️ 满的时候不拒收新的那条就先挤掉**最早到期**的那条并把它交出去：
// 队列的语义是"按住等一句替换文案"，被按住的代价该由等得最久的那条先付，
// 而它付的方式是"当场把规则档那句说出来"，不是"消失"。
export function pushPending(p, ev, deadlineMs) {
  if (!ev || typeof ev.id !== 'string' || ev.id === ''
      || typeof ev.text !== 'string' || ev.text === '') {
    p.rejected += 1;
    p.lastIdx = -1;
    p.lastReason = PUSH_REASONS.BAD_SHAPE;
    return 0;
  }
  // 腾位之前先看交付缓冲区放不放得下：放不下的话宁可**不收这一拍**（调用方原样交付），
  // 也绝不在这里覆盖掉一个还没交出去的句子 —— 那才是真的吞字。
  // 一次 push 最多需要腾两个位（同 id 让位 + 容量挤出），所以 give 的长度 n+1 在
  // "调用方每推一条就抽干一次"的契约下永远够用；契约被违反时走这条拒收分支，有读数。
  const dup = findPending(p, ev.id);
  const free = freeSlot(p);
  const need = (dup >= 0 ? 1 : 0) + (dup < 0 && free < 0 ? 1 : 0);
  if (need > p.give.length - p.giveCount) {
    p.notTaken += 1;
    p.lastIdx = -1;
    p.lastReason = PUSH_REASONS.OVER_CAP;
    return 0;
  }
  let why = PUSH_REASONS.OK;
  // 同一只只留最新那句（与 bubble.js 的 pushSay 同一条规矩：话痨不许把队列摞起来）。
  // 顶掉的那条**当场交出**它当下手上的文案 —— 让位不等于闭嘴。
  if (dup >= 0) {
    handOff(p, dup, RELEASE_WHY.SUPERSEDED);
    p.superseded += 1;
    why = PUSH_REASONS.SUPERSEDED;
  }
  let idx = freeSlot(p);
  if (idx < 0) {
    idx = oldestIdx(p);                // 上面那一轮顶位没腾出槽，就挤掉最早到期的那条
    handOff(p, idx, RELEASE_WHY.OVER_CAP);
    p.overCap += 1;
    why = PUSH_REASONS.OVER_CAP;
  }
  p.used[idx] = SLOT_USED;
  p.ev[idx] = ev;
  p.id[idx] = ev.id;
  p.text[idx] = ev.text;
  p.tokens[idx] = Array.isArray(ev.tokens) && ev.tokens.length > 0 ? ev.tokens : ev.text.split(' ');
  p.mood[idx] = typeof ev.mood === 'string' ? ev.mood : '';
  // 脏 deadline（旧档/时钟漂移）当成"已经到期"：宁可不按住，也绝不把一句话永远按着。
  p.deadlineMs[idx] = finite(deadlineMs) ? deadlineMs : -1;
  p.token[idx] = ++p.seq;
  p.changed[idx] = 0;
  p.count += 1;
  p.accepted += 1;
  if (p.count > p.peak) p.peak = p.count;
  p.lastIdx = idx;
  p.lastToken = p.token[idx];
  p.lastReason = why;
  return 1;
}

// 到期的是哪些：写进 p.due（到期先、同刻入队先），返回条数。调用方随后逐条 releasePending。
// 这就是超时机制本身 —— 没有别的地方在掐表。
export function duePending(p, nowMs) {
  p.dueCount = 0;
  for (let k = 0; k < p.n; k++) {
    if (p.used[k] !== SLOT_USED) continue;
    if (!shouldAbort(nowMs, p.deadlineMs[k])) continue;
    // 插入排序（槽位上限是个位数，且这里零分配）：保证"等得最久的先出去"。
    let i = p.dueCount;
    while (i > 0) {
      const prev = p.due[i - 1];
      if (p.deadlineMs[prev] < p.deadlineMs[k]) break;
      if (p.deadlineMs[prev] === p.deadlineMs[k] && p.token[prev] <= p.token[k]) break;
      p.due[i] = prev;
      i -= 1;
    }
    p.due[i] = k;
    p.dueCount += 1;
  }
  return p.dueCount;
}

// 把第 idx 拍交付出去（到期那一支）。手上有什么就交什么：模型文案换过就交模型文案。
export function releasePending(p, idx) {
  if (!(idx >= 0 && idx < p.n) || p.used[idx] !== SLOT_USED) return 0;
  return handOff(p, idx, RELEASE_WHY.DUE);
}

// 一次请求的落地。utterance 是 validateReply 通过时那份 { text, tokens }，其它一律 null。
// token 是接线层在 pushPending 之后拿到的代号：对不上 ⇒ 那一拍早就交付过了 ⇒ **丢弃并计数**，
// 绝不把迟到的文案塞进后来那一句话里（决策 F）。
export function resolvePending(p, idx, utterance, nowMs, token) {
  if (!(idx >= 0 && idx < p.n) || p.used[idx] !== SLOT_USED) { p.late += 1; return 0; }
  if (token !== undefined && token !== null && p.token[idx] !== token) { p.late += 1; return 0; }
  if (utterance && typeof utterance.text === 'string' && utterance.text !== ''
      && Array.isArray(utterance.tokens) && utterance.tokens.length > 0) {
    const ev = p.ev[idx];
    // 改写的是**尚未交出去**的那个对象；c.speech.lastTokens 指向另一个数组，碰不到。
    if (ev) { ev.text = utterance.text; ev.tokens = utterance.tokens; }
    p.text[idx] = utterance.text;
    p.tokens[idx] = utterance.tokens;
    p.changed[idx] = 1;
    p.resolved += 1;
  } else {
    p.refused += 1;
  }
  p.deadlineMs[idx] = finite(nowMs) ? nowMs : -1;   // 已经落地，不必再按到原定的点
  return handOff(p, idx, RELEASE_WHY.RESOLVED);
}

// 缸停了：队列里还按着的话**不再交付**（屏幕上什么都不画了，交付也没有去处），但必须留读数。
// 这是全队列唯一一条"没有交出一句话"的去路，而它不是让生物闭嘴 —— 是整个应用停了。
// 已经进了交付缓冲区、还没来得及被取走的那几条也一样收走，另记一个 `droppedStaged`：
// 真实场景是"回复恰好在最后一帧之后落地"，那一份文案同样消失，同样不许静默。
export function dropAllPending(p) {
  let n = 0;
  for (let k = 0; k < p.n; k++) {
    if (p.used[k] !== SLOT_USED) continue;
    p.used[k] = SLOT_FREE;
    p.ev[k] = null;
    p.id[k] = '';
    p.text[k] = '';
    p.tokens[k] = null;
    p.mood[k] = '';
    p.changed[k] = 0;
    n += 1;
  }
  p.count = 0;
  p.dropped += n;
  // 已经 handOff（记过 released）但还没来得及被取走的那几条：它们同样不会出现在屏幕上。
  // 另记一个读数而不是并进 dropped —— 守恒式 `accepted == released + count + dropped`
  // 靠 released 覆盖它们，把两处混记会让那条式子再也对不上。
  p.droppedStaged += p.giveCount;
  p.giveCount = 0;
  return n;
}

// 交付缓冲区里的那几条：接线层逐帧读 give/giveIdx，然后 clearGive(p)。
export function clearGive(p) {
  for (let i = 0; i < p.giveCount; i++) { p.give[i] = null; p.giveIdx[i] = -1; }
  p.giveCount = 0;
  return 0;
}

