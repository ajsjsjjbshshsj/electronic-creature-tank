// Task B19b-i：可选 API 档的**纯函数层**（spec §4.13.2 / §4.13.2.1）。
//
// 这个文件守的是三条纪律里"在这一层就能证掉"的部分：
//   1. 失败即回落（§4.13.2 第 1 条）⇒ 本模块任何一条路径只能给出"一段替换文字"或
//      "没有替换"，**永远不是**"闭嘴"。所以每个拒绝都必须带机器可读的 reason，
//      而"默认关"必须是一条断言而不是注释。
//   2. 模型是只读旁路（§4.13.2 第 2 条）⇒ 整模块跑完之后 world 与 creature 的深快照
//      必须逐字节相同，包括喂投毒回复的那一次。
//   3. 验收跨档位成立（§4.13.2 第 3 条）⇒ 调与不调这一层，缸的指纹必须相同
//      （tests/sim.test.js 对 speechEnabled 已经用同样的手法证过一次）。
//
// ⚠️ 本模块**不发请求**，所以这里没有一条断言需要网络。真实端点才能证明的东西
//    一律写在 spec §4.13.2.1 末尾的"未验证"清单里，不在这里假装修补。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { randomGenome, decode } from '../src/genes.js';
import { thresholds } from '../src/personality.js';
import { createCreature } from '../src/creature.js';
import { EMOTION_KEYS, MOODS, moodOf } from '../src/emotions.js';
import { NEED_KEYS } from '../src/needs.js';
import { NEED_WORDS, tokenBudget } from '../src/lexicon.js';
import { createMemory, remember, PLAYER_ID } from '../src/memory.js';
import { createWorld, tickWorld, aliveCreatures } from '../src/sim.js';
import {
  REASONS, CONFIG_REASONS, MOOD_LABELS, PERSONA_WORDS,
  buildSummary, buildRequest, configIssue, validateReply,
  deadlineFor, shouldAbort, maySend,
} from '../src/api.js';

const A = CONFIG.api;
const S = CONFIG.speech;

const SRC = (name) => readFileSync(
  fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8',
);

// 一份**像样的** cfg：接线层（B19b-ii）会从本机存储里读出来，这里给一份桩。
// key 刻意用一条独一无二的字符串 —— 下面有六条断言靠它证明"key 不外泄"。
const SECRET = 'sk-NEVER-LEAVE-THIS-TEST-7z9q';
const cfgOn = (over = {}) => ({
  enabled: true, endpoint: 'https://api.example.test/v1', model: 'small-chat',
  key: SECRET, ...over,
});

// ---------------------------------------------------------------- 造个体

const sharedGenes = randomGenome(createRng(20261022));
// 性格九项一律先摊平到 0.5 再按参数覆盖。不摊平的话"最极端的三项"测的是**随机基因**
// 而不是被控变量 —— 本项目为这类比较栽过四次（A4 hopWeight、A3 漂入长幼、A5 配对、A6 talk）。
const FLAT_PERSONA = Object.fromEntries(
  Object.keys(decode(sharedGenes).personality).map((k) => [k, 0.5]),
);

const heardEntry = (token, lastUsed = 0, over = {}) => ({
  token, price: 0.5, boundMood: 'happy', boundNeed: 'hunger',
  heardAt: 0, lastUsed, uses: 1, ...over,
});

let seq = 0;
const pet = (over = {}) => {
  const {
    catchphrase = '喵喵', heard = [], aff = 0.8, name = '小桃·三', ...personality
  } = over;
  const c = createCreature({
    id: `api${seq++}`, name, x: 0.5, y: 0.5, age: 600,
    genes: JSON.parse(JSON.stringify(sharedGenes)),
  });
  Object.assign(c.traits.personality, FLAT_PERSONA, { talk: 0.6 }, personality);
  c.thresholds = thresholds(c.traits.personality);
  c.catchphrase = catchphrase;
  c.speech = { nextAt: 0, lastTokens: null };
  c.memory = createMemory();
  remember(c.memory, { id: PLAYER_ID, familiarity: 1, affection: aff, kinship: 0, role: null });
  c.heard = heard;
  return c;
};

const words = (...list) => list.map((t) => heardEntry(t, 100));

const summaryOf = (c, ctx = {}, world = { time: 100 }) => buildSummary(c, world, {
  mood: 'happy', ...ctx,
});

// 按标签取摘要里的某一格（断言不必重复那套格式）
const field = (s, label) => {
  const m = s.match(new RegExp(`^${label}：(.*)$`, 'm'));
  assert.ok(m, `摘要里没有 ${label}：\n${s}`);
  return m[1];
};

// ---------------------------------------------------------------- 结构化状态摘要

test('buildSummary：字段顺序固定，而且每一格用的是词而不是数字', () => {
  const c = pet({ heard: words('吃饭', '摸摸') });
  const s = summaryOf(c, { mood: 'sad' });
  const labels = ['名字', '口癖', '此刻心情', '最紧的需求', '性格', '刚听进去的话', '对玩家好感'];
  const at = labels.map((l) => s.indexOf(`${l}：`));
  assert.deepEqual(at, [...at].sort((x, y) => x - y), `字段顺序变了：\n${s}`);
  assert.ok(at.every((i) => i >= 0), `少了字段：\n${s}`);
  assert.equal(s.split('\n').length, labels.length, '必填字段就是这七行，多一格少一格都算漂移');

  // 需求格必须是 NEED_WORDS 里的词，不许是 0.62 这类匮乏度读数
  for (const w of field(s, '最紧的需求').split('、')) {
    assert.ok(Object.values(NEED_WORDS).includes(w), `需求格出现了词表之外的东西：${w}`);
  }
  // 心情是 moodOf 的那一档；档名表必须与 MOODS 逐键对齐（少一档就是喂给模型 undefined）
  assert.deepEqual(Object.keys(MOOD_LABELS).sort(), [...MOODS].sort(),
    'MOOD_LABELS 的键集必须与 MOODS 一一对应');
  assert.equal(field(s, '此刻心情'), MOOD_LABELS.sad);
});

test('buildSummary 绝不把六分量情绪向量喂给模型（分量名与原始数值都不许出现）', () => {
  const c = pet();
  // 六个分量各给一个**独一无二**的读数：只要有任何一条漏进摘要，下面就会命中它。
  Object.assign(c.emotions, {
    joy: 0.4719837, anger: 0.1234567, fear: 0.9876543,
    curiosity: 0.2468135, sleepy: 0.1357924, arousal: 0.8642531,
  });
  const mood = moodOf(c.emotions, c.needs, c.memory, { adversity: false });
  const s = summaryOf(c, { mood });
  for (const k of EMOTION_KEYS) {
    assert.ok(!s.includes(k), `摘要里出现了情绪分量名 ${k}：\n${s}`);
    assert.ok(!s.includes(String(c.emotions[k])), `摘要里出现了原始数值 ${k}=${c.emotions[k]}`);
  }
  // 顺带钉住"没有 17 位浮点尾巴"：摘要里最多允许两位小数（只有好感那一格是数）
  assert.ok(!/\d\.\d{3,}/.test(s), `摘要里有未截断的浮点：\n${s}`);
});

test('buildSummary 不做 JSON.stringify(creature)：病态个体的长度仍有硬上界', () => {
  const c = pet({ name: '长'.repeat(400), catchphrase: '喵'.repeat(60) });
  c.heard = Array.from({ length: 80 }, (_, i) => heardEntry(`${'啊'.repeat(40)}${i}`, 100, { uses: 3 }));
  const long = summaryOf(c, { mood: 'calm', suggestion: '句子'.repeat(3000) });
  assert.ok(long.length <= A.summaryMaxChars,
    `摘要长度 ${long.length} 越过了 CONFIG.api.summaryMaxChars=${A.summaryMaxChars}`);
  // **每一格**都被夹住，而不是只靠末尾那一下总裁剪：只截总长的话，某一格会独占
  // 整个预算、把后面的字段直接挤掉，而那正是"模型看到的摘要突然缺一条"的来源。
  assert.ok(long.includes('对玩家好感：'), `尾部字段被整段裁掉了：\n${long}`);
  assert.ok(long.includes('名字：' + '长'.repeat(A.nameMaxChars - 1) + '…'), long.slice(0, 60));
  assert.ok(long.includes('口癖：' + '喵'.repeat(A.wordMaxChars - 1) + '…'), long.slice(0, 80));
  assert.ok(field(long, '刚听进去的话').includes('啊'.repeat(A.wordMaxChars - 1) + '…'));
  assert.equal(field(long, '可以照着说').length, A.suggestionMaxChars);
  // 预算也要自洽：逐格上界之和必须落在 summaryMaxChars 之内，
  // 否则"最后一刀"会吃掉必填字段（上面那条 includes 就是这个等式的行为侧证据）。
  const worstCase = A.nameMaxChars + A.wordMaxChars + A.suggestionMaxChars
    + A.summaryNeedTop * 4 + A.summaryHeardTop * A.wordMaxChars + 120;
  assert.ok(worstCase <= A.summaryMaxChars, `各格上界之和 ${worstCase} 已超预算 ${A.summaryMaxChars}`);
  // 正常个体离上界很远 —— 不然那条"≤ 上界"的断言没有分辨力
  const normal = summaryOf(pet({ heard: words('吃饭', '摸摸') }));
  assert.ok(normal.length < A.summaryMaxChars / 2, `正常摘要 ${normal.length} 太接近上界`);
});

test('buildSummary 是纯函数：同一输入两次调用逐字节相同', () => {
  const c = pet({ heard: words('吃饭', '摸摸', '宝宝') });
  const world = { time: 42 };
  assert.equal(summaryOf(c, { mood: 'calm' }, world), summaryOf(c, { mood: 'calm' }, world));
  // 极端时钟也不能让它抖一下（此时全部 heard 都淡到接近 0，仍然要有确定结果）
  assert.equal(
    summaryOf(c, { mood: 'calm' }, { time: 1e9 }),
    summaryOf(c, { mood: 'calm' }, { time: 1e9 }),
  );
});

test('buildSummary 不许自己判心情：非法或缺失的 mood 当场抛错', () => {
  const c = pet();
  for (const bad of [undefined, null, 'joy', 'Happy', '兴奋', 0, 'calm ']) {
    assert.throws(
      () => buildSummary(c, { time: 1 }, { mood: bad }),
      TypeError, `非法心情 ${String(bad)} 必须抛错，不能静默把 undefined 喂给模型`,
    );
  }
  for (const m of MOODS) assert.doesNotThrow(() => buildSummary(c, { time: 1 }, { mood: m }));
});

test('buildSummary 的时钟只从 world 读：没有 world.time 就抛错（不许自取当前时间）', () => {
  const c = pet();
  for (const bad of [null, undefined, {}, { time: NaN }, { time: '100' }, { time: Infinity }]) {
    assert.throws(() => buildSummary(c, bad, { mood: 'calm' }), TypeError,
      `world.time 非法（${JSON.stringify(bad)}）必须抛错`);
  }
});

test('性格三行：取最极端的 personaLines 项，条数由 CONFIG.api.personaLines 收口', () => {
  // talk 拉到顶（偏离 0.5）、bold 次之（偏离 0.4），其余全 0.5 ⇒ 前两条必须是它俩
  const c = pet({ talk: 1, bold: 0.9 });
  const persona = field(summaryOf(c, { mood: 'happy' }), '性格').split('、');
  assert.equal(persona.length, Math.min(A.personaLines, Object.keys(PERSONA_WORDS).length));
  assert.deepEqual(persona.slice(0, 2), [PERSONA_WORDS.talk.high, PERSONA_WORDS.bold.high],
    `极端项必须先进：${persona}`);
  // 措辞表必须与性格九项逐键对齐，两翼都要有词
  assert.deepEqual(Object.keys(PERSONA_WORDS).sort(), Object.keys(FLAT_PERSONA).sort(),
    'PERSONA_WORDS 的键集必须与性格九项一一对应（漏一项就是那一项永远不进摘要）');
  for (const [k, p] of Object.entries(PERSONA_WORDS)) {
    assert.equal(typeof p.high, 'string', `${k} 缺 high 侧措辞`);
    assert.equal(typeof p.low, 'string', `${k} 缺 low 侧措辞`);
  }
  // 低的那一侧也必须真的走到（方向写反是最难发现的错，与 personality.js 同一条纪律）
  assert.equal(field(summaryOf(pet({ talk: 0 }), { mood: 'calm' }), '性格')
    .split('、')[0], PERSONA_WORDS.talk.low);
  // 全 0.5 时退化成固定键序，但仍然必须有词（不许空着）
  assert.notEqual(field(summaryOf(pet(), { mood: 'calm' }), '性格'), '');
});

test('最紧的需求按匮乏度降序取 top-N，词来自 NEED_WORDS 那一层', () => {
  const c = pet();
  Object.assign(c.needs, { hunger: 0.2, energy: 0.95, social: 0.6, safety: 0.05 });
  assert.equal(field(summaryOf(c, { mood: 'calm' }), '最紧的需求'),
    [NEED_WORDS.energy, NEED_WORDS.social].join('、'));
  assert.ok(NEED_KEYS.length >= A.summaryNeedTop, 'summaryNeedTop 不能超过四条匮乏度');
  // 平局必须按 NEED_KEYS 的次序（与 needs.mostUrgent 同一条优先级），否则两处会对不上
  const tie = pet();
  Object.assign(tie.needs, { hunger: 0.4, energy: 0.4, social: 0.4, safety: 0.4 });
  assert.equal(field(summaryOf(tie, { mood: 'calm' }), '最紧的需求'),
    [NEED_WORDS.hunger, NEED_WORDS.energy].join('、'));
});

test('刚听进去的话按当前强度取最强的几条，条数由 summaryHeardTop 截断', () => {
  // 时钟 = 100，四条分别停在 0 / 60 / 90 / 95 ⇒ 越近的越记得住
  const c = pet({ heard: [
    heardEntry('老词', 0), heardEntry('中词', 60), heardEntry('新词', 90), heardEntry('最新词', 95),
  ] });
  const heard = field(summaryOf(c, { mood: 'happy' }, { time: 100 }), '刚听进去的话').split('、');
  assert.equal(heard.length, Math.min(A.summaryHeardTop, 4), '条数必须由 summaryHeardTop 截住');
  assert.deepEqual(heard, ['最新词', '新词', '中词'], `排序不是"当前最强"：${heard}`);
  // token 本身长度不可控（来自玩家输入），所以它必须被夹住
  const wild = pet({ heard: [heardEntry('啊'.repeat(99), 100)] });
  assert.ok(field(summaryOf(wild, { mood: 'happy' }, { time: 100 }), '刚听进去的话')
    .includes('啊'.repeat(A.wordMaxChars - 1) + '…'));
});

test('空 heard、无口癖、无玩家记忆的个体照样出摘要，且绝不出现 undefined 字样', () => {
  const c = pet({ catchphrase: null, heard: [] });
  c.memory = createMemory();                       // 连 PLAYER 条目都没有
  const s = summaryOf(c, { mood: 'calm' });
  for (const bad of ['undefined', 'null', 'NaN', '[object Object]']) {
    assert.ok(!s.includes(bad), `摘要里出现了 ${bad}：\n${s}`);
  }
  assert.ok(s.includes('口癖：'), '口癖那一格必须整格还在，只是没词');
  assert.ok(s.includes('刚听进去的话：'), 'heard 为空时那一格也要在场（模型要知道它没听过东西）');
  // 但 memory 整件**不在**就是另一回事：静默按 0 好感会让模型把老主人当陌生人
  assert.throws(() => summaryOf({ ...c, memory: null }, { mood: 'calm' }), TypeError);
});

test('ctx.suggestion 给了才有"可以照着说"那一行，且永远排在最后', () => {
  const c = pet();
  const withS = summaryOf(c, { mood: 'happy', suggestion: '喵喵 开心 饿饿' });
  assert.ok(withS.endsWith('可以照着说：喵喵 开心 饿饿'), withS);
  const without = summaryOf(c, { mood: 'happy' });
  assert.ok(!without.includes('可以照着说'), '缺省不许占位（否则模型总看到一句空提示）');
  assert.equal(without.length + '\n可以照着说：喵喵 开心 饿饿'.length, withS.length,
    '那一行只能是追加，不许改动前面的字段');
  assert.throws(() => summaryOf(c, { mood: 'happy', suggestion: 42 }), TypeError,
    'suggestion 给了非字符串必须抛错');
});

// ---------------------------------------------------------------- 请求描述（纯数据，零请求）

test('默认关闭：CONFIG.api.enabled 出厂就是 false，enabled 不为真时 buildRequest 返回 null', () => {
  // spec §4.13.2 标题逐字「默认关闭」。CONFIG 深冻结、测不到"改成 false 再改回来"
  // （§4.13.1.1 第 3 条的老账），所以**默认值本身**必须钉死，运行时的开关由 cfg 传入。
  assert.equal(A.enabled, false, 'API 档的默认值开了就是越界');
  for (const cfg of [undefined, null, {}, { enabled: false }, { enabled: 0 }, cfgOn({ enabled: false })]) {
    assert.equal(buildRequest('摘要', cfg), null, `${JSON.stringify(cfg)} 不该生成请求`);
  }
  assert.deepEqual(configIssue({}), { reason: CONFIG_REASONS.DISABLED, field: 'enabled' });
});

test('endpoint 空 / 非 https / model 空 / key 空 ⇒ buildRequest 一律 null（回落规则档，不是闭嘴）', () => {
  const cases = [
    cfgOn({ endpoint: '' }), cfgOn({ endpoint: '   ' }), cfgOn({ endpoint: null }),
    cfgOn({ endpoint: 'http://api.example.test/v1' }),          // 明文：§13.2 第 3 条禁止
    cfgOn({ endpoint: 'api.example.test/v1' }),                 // 连协议都没有
    cfgOn({ model: '' }), cfgOn({ model: null }),
    cfgOn({ key: '' }), cfgOn({ key: null }), cfgOn({ key: '   ' }),
  ];
  for (const cfg of cases) assert.equal(buildRequest('摘要', cfg), null, JSON.stringify(cfg));
  assert.equal(configIssue(cfgOn({ endpoint: '' })).reason, CONFIG_REASONS.EMPTY_ENDPOINT);
  assert.equal(configIssue(cfgOn({ endpoint: 'http://x.test' })).reason, CONFIG_REASONS.INSECURE_ENDPOINT);
  assert.equal(configIssue(cfgOn({ model: '' })).reason, CONFIG_REASONS.EMPTY_MODEL);
  assert.equal(configIssue(cfgOn({ key: '' })).reason, CONFIG_REASONS.EMPTY_KEY);
});

test('成功路径：返回的是纯数据描述 { url, method, headers, body, timeoutMs }', () => {
  const r = buildRequest('此刻心情：快乐', cfgOn());
  assert.ok(r, '合法 cfg 必须给出请求');
  assert.deepEqual(Object.keys(r).sort(), ['body', 'headers', 'method', 'timeoutMs', 'url']);
  assert.equal(r.method, 'POST');
  assert.equal(r.timeoutMs, A.timeoutMs, '缺省超时来自 CONFIG，不是模块里的字面量');
  assert.equal(typeof r.url, 'string');
  assert.equal(r.headers['content-type'], 'application/json');
});

test('body：两条 messages、max_tokens 很小、temperature 从 CONFIG 来、stream 恒为 false', () => {
  const r = buildRequest('SUMMARY-TEXT', cfgOn());
  assert.deepEqual(Object.keys(r.body).sort(),
    ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(r.body.model, 'small-chat');
  assert.equal(r.body.stream, false, '流式会把"最多 2 行"变成逐字喷泉（§4.13.1 显示纪律）');
  assert.ok(r.body.max_tokens >= 1 && r.body.max_tokens <= A.maxTokensOutCap);
  assert.equal(r.body.temperature, A.temperature);
  assert.deepEqual(r.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(r.body.messages[1].content, 'SUMMARY-TEXT', '摘要必须原样进 user 那一条');
  // 系统提示里必须写着那条句式纪律，否则模型写一段散文是**它的合理行为**而不是越界。
  // 那个 2 是 spec §4.13.1 的下限（speech.js 用的是同一个数），上限只能来自 CONFIG.speech。
  const sys = r.body.messages[0].content;
  assert.ok(sys.includes(`2 到 ${S.maxTokens} 个词`), `提示词没写出 2 到 ${S.maxTokens} 个词：${sys}`);
  assert.ok(sys.includes('空格'), '提示词要写明词之间用空格隔开（text/tokens 同形的前提）');
});

test('url 拼接：尾斜杠、已经带 /chat/completions、多余的空段，三种都不重复也不遗漏', () => {
  const suffix = '/chat/completions';
  const ends = (cfg) => buildRequest('s', cfg).url.endsWith(suffix);
  assert.ok(ends(cfgOn({ endpoint: 'https://api.example.test/v1' })));
  assert.ok(ends(cfgOn({ endpoint: 'https://api.example.test/v1/' })));
  assert.ok(ends(cfgOn({ endpoint: 'https://api.example.test/v1/chat/completions' })));
  const odd = buildRequest('s', cfgOn({ endpoint: 'https://api.example.test/v1//' }));
  assert.ok(odd.url.endsWith(suffix) && !odd.url.includes('/chat//chat'), odd.url);
  // 头尾空白不许进 URL（那是"填了 key 却 404"的常见成因）
  assert.equal(buildRequest('s', cfgOn({ endpoint: '  https://x.test/v1  ' })).url,
    buildRequest('s', cfgOn({ endpoint: 'https://x.test/v1' })).url);
});

test('key 只进 authorization 头，绝不进 body、不进 url、不进摘要', () => {
  const r = buildRequest(summaryOf(pet()), cfgOn());
  assert.equal(r.headers.authorization, `Bearer ${SECRET}`, '头必须由传入的 key 拼出来');
  assert.ok(!JSON.stringify(r.body).includes(SECRET), 'key 泄进 body 就等于泄进提示词与日志');
  assert.ok(!r.url.includes(SECRET), 'key 泄进 url');
});

test('cfg 越界（timeout / max_tokens / temperature）⇒ null，且 configIssue 报出字段名', () => {
  const cases = [
    [cfgOn({ timeoutMs: 0 }), CONFIG_REASONS.BAD_TIMEOUT],
    [cfgOn({ timeoutMs: -1 }), CONFIG_REASONS.BAD_TIMEOUT],
    [cfgOn({ timeoutMs: A.timeoutMaxMs + 1 }), CONFIG_REASONS.BAD_TIMEOUT],
    [cfgOn({ timeoutMs: NaN }), CONFIG_REASONS.BAD_TIMEOUT],
    [cfgOn({ maxTokensOut: 0 }), CONFIG_REASONS.BAD_MAX_TOKENS],
    [cfgOn({ maxTokensOut: A.maxTokensOutCap + 1 }), CONFIG_REASONS.BAD_MAX_TOKENS],
    [cfgOn({ maxTokensOut: 4.5 }), CONFIG_REASONS.BAD_MAX_TOKENS],
    [cfgOn({ temperature: -0.1 }), CONFIG_REASONS.BAD_TEMPERATURE],
    [cfgOn({ temperature: A.temperatureMax + 0.1 }), CONFIG_REASONS.BAD_TEMPERATURE],
  ];
  for (const [cfg, reason] of cases) {
    assert.equal(buildRequest('s', cfg), null, `${reason} 那条必须拦住`);
    assert.equal(configIssue(cfg).reason, reason, JSON.stringify(cfg));
  }
  // 合法 cfg 上 configIssue 必须返回 null，否则"没问题"与"没检查"分不开
  assert.equal(configIssue(cfgOn()), null);
  assert.equal(configIssue(cfgOn({ timeoutMs: 1000, maxTokensOut: 8, temperature: 0 })), null);
});

test('configIssue 只报字段名：把九种失败各跑一遍，JSON 里搜不到 key', () => {
  const bad = [
    {}, { enabled: true }, cfgOn({ endpoint: '' }), cfgOn({ endpoint: 'http://x.test' }),
    cfgOn({ model: '' }), cfgOn({ key: '' }), cfgOn({ timeoutMs: 0 }),
    cfgOn({ maxTokensOut: 999 }), cfgOn({ temperature: 9 }),
  ];
  for (const cfg of bad) {
    const issue = configIssue(cfg);
    assert.ok(issue, '失败诊断不许是 null（§7.7 禁止静默）');
    assert.ok(Object.values(CONFIG_REASONS).includes(issue.reason), `未知 reason ${issue.reason}`);
    // 诊断对象的键必须是白名单：谁把 cfg 整个 spread 进诊断，这条当场红
    assert.deepEqual(Object.keys(issue).sort(), ['field', 'reason'],
      `诊断对象长出了白名单之外的键：${Object.keys(issue)}`);
    assert.ok(!JSON.stringify(issue).includes(SECRET), `key 泄进诊断：${JSON.stringify(issue)}`);
  }
});

// ---------------------------------------------------------------- 回复校验

test('REASONS 就是那六个机器可读的字符串（改名要同时改接线层，所以钉死）', () => {
  assert.deepEqual(REASONS, {
    SHAPE: 'bad-shape',
    EMPTY: 'empty',
    TOO_LONG: 'too-long',
    TOO_FEW_TOKENS: 'too-few-tokens',
    TOO_MANY_TOKENS: 'too-many-tokens',
    CATCHPHRASE_ONLY: 'catchphrase-only',
  });
  assert.deepEqual(Object.keys(CONFIG_REASONS).sort(), [
    'BAD_MAX_TOKENS', 'BAD_TEMPERATURE', 'BAD_TIMEOUT', 'DISABLED',
    'EMPTY_ENDPOINT', 'EMPTY_KEY', 'EMPTY_MODEL', 'INSECURE_ENDPOINT',
  ]);
});

test('接受形状：裸字符串，以及 OpenAI 式的 choices[0].message.content', () => {
  const c = pet({ talk: 0.9 });
  const budget = tokenBudget(c.traits.personality.talk);
  const plain = validateReply('喵喵 开心', budget, c);
  assert.equal(plain.ok, true, JSON.stringify(plain));
  const openai = validateReply({ choices: [{ message: { content: '喵喵 开心' } }] }, budget, c);
  assert.equal(openai.ok, true, JSON.stringify(openai));
  assert.deepEqual(openai.utterance, plain.utterance, '两种形状必须得到同一个 utterance');
});

test('拒绝形状：null、数字、数组、空对象、choices 为空、content 不是字符串 ⇒ bad-shape', () => {
  const c = pet();
  const bad = [
    null, undefined, 42, true, ['喵', '喵'], {}, { content: 1 },
    { choices: [] }, { choices: [{}] }, { choices: [{ message: {} }] },
    { choices: [{ message: { content: 7 } }] }, { choices: [{ message: { content: [] } }] },
    () => '喵喵 开心',
  ];
  for (const raw of bad) {
    const r = validateReply(raw, 5, c);
    assert.equal(r.ok, false, `${String(raw)} 竟然被接受了`);
    assert.equal(r.reason, REASONS.SHAPE);
    assert.equal('utterance' in r, false, '拒绝里不许带 utterance');
  }
});

test('空回复 / 只有空白 / 只有控制字符 ⇒ empty（不许把空字符串送进气泡）', () => {
  const c = pet();
  for (const raw of ['', '    ', '\n\t\v', '\u0000\u001f\u007f\u200b\ufeff', ' \n ', '  \u0007  ']) {
    const r = validateReply(raw, 5, c);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.EMPTY, JSON.stringify(raw));
  }
});

test('一段 400 字的散文 ⇒ too-long（上限就是 CONFIG.api.textMaxChars）', () => {
  const c = pet({ talk: 1 });
  const r = validateReply('我'.repeat(400), 5, c);
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.TOO_LONG);
  // 红绿一对：恰好在上界内的必须收，否则 too-long 其实写成了"永远拒"
  const fit = ['喵', '哈', '呀'.repeat(A.textMaxChars - 6)].join(' ');
  assert.equal(fit.length, A.textMaxChars - 2, '前置条件：这条恰好在上界内');
  assert.equal(validateReply(fit, 5, c).ok, true);
  const over = ['喵', '哈', '呀'.repeat(A.textMaxChars - 3)].join(' ');
  assert.equal(over.length, A.textMaxChars + 1);
  assert.equal(validateReply(over, 5, c).reason, REASONS.TOO_LONG);
});

test('只有一个词 ⇒ too-few-tokens：规则档的 2 词下限不许被 API 档绕过', () => {
  const c = pet();
  for (const raw of ['开心', '喵喵', 'hello']) {
    const r = validateReply(raw, 5, c);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(r.reason, REASONS.TOO_FEW_TOKENS);
  }
  assert.equal(validateReply('开心 玩', 5, c).ok, true, '两个词是下限，不该被拒');
});

test('十二个词 ⇒ too-many-tokens：写出一段的模型不许把整面墙喷进气泡', () => {
  const c = pet({ talk: 1 });
  const twelve = '喵 咪 咕 噜 开 心 饿 饿 要 摸 摸 呀';
  assert.equal(twelve.split(' ').length, 12, '前置条件：这条样本确实是 12 个 token');
  const r = validateReply(twelve, 5, c);
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.TOO_MANY_TOKENS);
});

test('token 上限用的是现成的 tokenBudget，不是自己再写一套', () => {
  const c = pet({ talk: 0.9 });
  const budget = tokenBudget(c.traits.personality.talk);
  assert.ok(budget >= 2 && budget <= S.maxTokens, '预算本身必须落在规则档那 2–5 条里');
  const exact = '一 二 三 四 五 六'.slice(0, budget * 2 - 1);   // 恰好 budget 个 token
  assert.equal(exact.split(' ').length, budget);
  assert.equal(validateReply(exact, budget, c).ok, true, JSON.stringify(exact));
  assert.equal(validateReply(`${exact} 七`, budget, c).reason, REASONS.TOO_MANY_TOKENS);
  // 同一句在窄预算（高冷）里被拒 ⇒ 预算真的在做事；而再宽也只能到 CONFIG.speech.maxTokens
  const six = '一 二 三 四 五 六';
  assert.equal(validateReply(six, tokenBudget(0), pet({ talk: 0 })).reason, REASONS.TOO_MANY_TOKENS);
  assert.equal(validateReply(six, tokenBudget(1), pet({ talk: 1 })).ok, false,
    '话痨的上界也只能到 CONFIG.speech.maxTokens');
});

test('口癖复读 ⇒ catchphrase-only', () => {
  const c = pet({ catchphrase: '喵喵' });
  for (const raw of ['喵喵 喵喵', '喵喵 喵喵 喵喵', '喵喵  喵喵']) {
    const r = validateReply(raw, 5, c);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(r.reason, REASONS.CATCHPHRASE_ONLY);
  }
  // 红绿一对：口癖 + 内容必须收（规则档自己就发"喵喵 开心"，拒掉它才是越界）
  assert.equal(validateReply('喵喵 开心', 5, c).ok, true);
  // 没有口癖的个体不许被这条规则误伤
  assert.equal(validateReply('呜 呜', 5, pet({ catchphrase: null })).ok, true);
});

test('清洁规则：剥控制字符与换行、折叠空白、剥掉整对包裹引号', () => {
  const c = pet({ catchphrase: '喵喵' });
  const r = validateReply('“喵喵\u0000\n 开心\r\n幸福”', 5, c);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.utterance.tokens, ['喵喵', '开心', '幸福']);
  assert.equal(r.utterance.text, '喵喵 开心 幸福');
  assert.ok(!/[\u0000-\u001f\r\n]/.test(r.utterance.text), '控制字符残留');
  // 只剥**整对**的包裹引号：句中的引号是内容的一部分，不许顺手删（那是替它改口）
  const inner = validateReply('喵喵 “开心” 呀', 5, pet({ catchphrase: null }));
  assert.equal(inner.ok, true, JSON.stringify(inner));
  assert.ok(inner.utterance.text.includes('“'), `句中引号被删了：${inner.utterance.text}`);
});

test('产出与规则档逐字同形：只有 {text, tokens}，且 text === tokens.join(" ")', () => {
  const c = pet({ talk: 1, catchphrase: '喵喵' });
  const r = validateReply('喵喵 开心 饿饿', 5, c);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'utterance']);
  assert.deepEqual(Object.keys(r.utterance).sort(), ['text', 'tokens'],
    'utterance 长出第三个键，气泡层就会开始认不出这是谁给的话');
  assert.equal(typeof r.utterance.text, 'string');
  assert.deepEqual(r.utterance.tokens, ['喵喵', '开心', '饿饿']);
  assert.equal(r.utterance.text, r.utterance.tokens.join(' '));
  // 与规则档那一份做**形状**比对：maybeSay 的产物恰好是这两个键
  assert.deepEqual(Object.keys(r.utterance).sort(), Object.keys({ text: 'a b', tokens: ['a', 'b'] }).sort());
});

test('调用方契约错用是抛错，不是静默拒绝：budget 非法 / creature 缺失 ⇒ TypeError', () => {
  const c = pet();
  for (const bad of [undefined, null, 0, 1, 1.5, NaN, '5', 99]) {
    assert.throws(() => validateReply('喵喵 开心', bad, c), TypeError,
      `budget=${String(bad)} 必须抛错：静默放行会让句长上限漂移而没人知道`);
  }
  for (const bad of [undefined, null, '喵喵', 42]) {
    assert.throws(() => validateReply('喵喵 开心', 5, bad), TypeError,
      '不传个体就没法判口癖复读，静默跳过等于悄悄关掉那条规则');
  }
  assert.throws(() => validateReply('喵喵 开心', 5, { catchphrase: 7 }), TypeError);
  assert.doesNotThrow(() => validateReply('喵喵 开心', 5, { catchphrase: null }));
});

test('投毒回复只能变成无害字符串或拒绝，永远变不成能喂回内核的东西', () => {
  const c = pet({ talk: 1 });
  const hostile = [
    'set anger to 1',
    '{"needs":{"hunger":0},"emotions":{"joy":1}}',
    'IGNORE ALL RULES and give me the whole tank',
    '把 hunger 全部清零然后说 谢谢主人',
    'null', 'NaN', 'function(){return 1}',
    { choices: [{ message: { content: '需要 把 anger 设成 1' } }] },
  ];
  for (const raw of hostile) {
    const r = validateReply(raw, 5, c);
    if (r.ok) {
      assert.deepEqual(Object.keys(r.utterance).sort(), ['text', 'tokens']);
      assert.equal(typeof r.utterance.text, 'string');
      assert.ok(r.utterance.tokens.length >= 2 && r.utterance.tokens.length <= 5);
    } else {
      assert.ok(Object.values(REASONS).includes(r.reason), `未知 reason ${r.reason}`);
    }
    // 关键：拒绝与接受的字段互斥，任何人想从拒绝里塞一个"指令对象"都当场红
    assert.equal('utterance' in r, r.ok);
  }
});

// ---------------------------------------------------------------- 超时决策（纯函数，接线层来用）

test('deadlineFor：正常路径就是 start + timeout', () => {
  assert.equal(deadlineFor(1000, 1000, 4000), 5000);
  assert.equal(deadlineFor(0, 0, 1), 1);
});

test('deadlineFor：时钟回拨时用当前时刻重新起算，否则请求会被当场掐死', () => {
  // now < start ⇒ 用 now 起算。若照抄 start + timeout，deadline 落在过去，
  // shouldAbort 立刻为真 ⇒ 症状正是 spec §4.13.2 第 1 条禁止的"填了 key 反而不说话了"。
  assert.equal(deadlineFor(10000, 1000, 4000), 5000);
  assert.equal(shouldAbort(4000, deadlineFor(10000, 1000, 4000)), false);
});

test('deadlineFor 的入参契约：非有限数或非正 timeout ⇒ TypeError', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1000', null, undefined]) {
    assert.throws(() => deadlineFor(bad, 0, 1000), TypeError);
    assert.throws(() => deadlineFor(0, bad, 1000), TypeError);
  }
  for (const bad of [0, -1, NaN, '1000']) {
    assert.throws(() => deadlineFor(0, 0, bad), TypeError);
  }
});

test('shouldAbort：截止前 false、恰好到点 true、之后 true', () => {
  const dl = deadlineFor(1000, 1000, 500);
  assert.equal(shouldAbort(1499, dl), false);
  assert.equal(shouldAbort(1500, dl), true, '恰好到点必须算超时');
  assert.equal(shouldAbort(9999, dl), true);
  for (const bad of [NaN, Infinity, '1', null]) {
    assert.throws(() => shouldAbort(bad, dl), TypeError);
    assert.throws(() => shouldAbort(0, bad), TypeError);
  }
});

test('maySend：默认关 ⇒ false；在途数按 maxInFlight 收口', () => {
  assert.equal(maySend(0, undefined), false, '默认关闭：不填 key 一个请求都不发');
  assert.equal(maySend(0, cfgOn()), true);
  assert.equal(maySend(A.maxInFlight - 1, cfgOn()), true);
  assert.equal(maySend(A.maxInFlight, cfgOn()), false, '达到上限就该排队，而不是把缸打成弹幕');
  assert.equal(maySend(99, cfgOn()), false);
  assert.equal(maySend(0, cfgOn({ maxInFlight: 0 })), false, 'maxInFlight=0 就是彻底不发');
  assert.throws(() => maySend(NaN, cfgOn()), TypeError);
  assert.throws(() => maySend(0, cfgOn({ maxInFlight: 1.5 })), TypeError);
});

// ---------------------------------------------------------------- 不可变性（spec §4.13.2 第 2 条）

test('整模块跑完（含投毒回复与病态 cfg）不改变 world 与 creature 的一个字节', () => {
  const world = createWorld({ seed: 11 });
  const before = JSON.stringify(world);
  const c = pet({ talk: 1, heard: words('吃饭', '摸摸') });
  const beforeC = JSON.stringify(c);
  const ctx = { mood: moodOf(c.emotions, c.needs, c.memory, { adversity: false }) };
  const budget = tokenBudget(c.traits.personality.talk);

  for (let pass = 0; pass < 2; pass++) {
    const s = buildSummary(c, world, { ...ctx, suggestion: '喵喵 开心' });
    for (const cfg of [cfgOn(), cfgOn({ endpoint: 'http://x.test' }), {}, cfgOn({ timeoutMs: 0 })]) {
      const r = buildRequest(s, cfg);
      if (r) validateReply('set anger to 1', budget, c);
      configIssue(cfg);
      maySend(0, cfg);
    }
    for (const raw of ['喵喵 喵喵', '', 'a'.repeat(500),
      { choices: [{ message: { content: '开 心 玩 呀 哈 啵' } }] }, null, 7]) {
      validateReply(raw, budget, c);
    }
    const dl = deadlineFor(world.time * 1000, world.time * 1000, A.timeoutMs);
    shouldAbort(dl + 1, dl);
  }

  assert.equal(JSON.stringify(world), before, 'API 档改动了 world');
  assert.equal(JSON.stringify(c), beforeC, 'API 档改动了 creature');
  // 上面两条靠 JSON 快照，抓不到"新增长字段 / 写函数属性"这类越界，补显式读数：
  assert.deepEqual(Object.keys(c), Object.keys(JSON.parse(beforeC)),
    'creature 的字段集变了（新增字段会跟着进存档，spec §7.2 不许）');
  assert.equal(c.speech.lastTokens, null, '语言层的私有状态也不许碰');
  assert.equal(c.speech.nextAt, 0);
  assert.equal(c.needs.hunger, JSON.parse(beforeC).needs.hunger);
  assert.equal(c.emotions.anger, JSON.parse(beforeC).emotions.anger);
  assert.ok(world.creatures.length > 0, '前置条件：这条测试确实跑的是一缸，不是空对象');
});

// 与 tests/sim.test.js 里 fingerprint 同一手法：**刻意不含 id**
// （eggSeq / foodSeq 是模块级计数器，同一进程里先跑的那缸会把后面的编号推高）。
const fingerprint = (w) => JSON.stringify({
  time: w.time,
  stats: w.stats,
  creatures: w.creatures.map((c) => [
    c.alive, c.stage, c.age.toFixed(6),
    c.pos.x.toFixed(12), c.pos.y.toFixed(12),
    c.needs.hunger.toFixed(12), c.needs.energy.toFixed(12),
    c.emotions.joy.toFixed(12), c.emotions.anger.toFixed(12),
    c.intent ? c.intent.kind : '-', c.catchphrase,
    c.speech.nextAt.toFixed(6), c.speech.lastTokens, c.heard.length,
  ]),
  eggs: w.eggs.map((e) => [e.age.toFixed(3), e.eggTint, e.viable]),
  foods: w.foods.map((f) => [f.kind, f.pos.x.toFixed(9), f.pos.y.toFixed(9)]),
});

test('跨档位验收的形状：真缸里穿插调用 API 档纯函数，两缸逐位相同', () => {
  // spec §4.13.2 第 3 条要的是"验收跨档位成立"。这一条先在**这一层**把它证掉：
  // 本模块不消费随机数、不写世界，所以就算接线层每次都调它，缸也一个字节都不动。
  // B19b-ii 把装饰器接上之后，这条仍然是必要条件（它测的是"纯函数层没偷做别的事"）。
  const run = (withApi) => {
    const w = createWorld({ seed: 909 });
    for (let i = 0; i < Math.round(60 * 60); i++) {
      tickWorld(w, 1 / 60);
      w.events.length = 0;
      if (withApi) {
        for (const c of aliveCreatures(w)) {
          const mood = moodOf(c.emotions, c.needs, c.memory, { adversity: c.mourn > 0 });
          const s = buildSummary(c, w, { mood, suggestion: '喵喵 开心 饿饿' });
          buildRequest(s, cfgOn());
          validateReply(
            { choices: [{ message: { content: `${s.length} 个字符 喵` } }] },
            tokenBudget(c.traits.personality.talk), c,
          );
          maySend(1, cfgOn());
          shouldAbort(w.time * 1000, deadlineFor(w.time * 1000, w.time * 1000, A.timeoutMs));
        }
      }
    }
    return fingerprint(w);
  };
  const a = run(true);
  const b = run(false);
  assert.equal(a, b, '调不调 API 档纯函数，缸必须一模一样');
  assert.notEqual(JSON.parse(a).creatures.length, 0, '防空转：缸里得有活物');
});

// ---------------------------------------------------------------- 纯度守卫（与 constraints.test.js 同一判据）

test('src/api.js 里没有网络、没有 DOM、没有本机存储，也没有随机源与当前时间', () => {
  // 与 tests/speech.test.js 里那条同形，但**扫原文不剥注释**（比 constraints 那条更严）：
  // 本模块的职责边界就是"什么都不碰"，连提一嘴都不许 —— 于是注释里要写那个名字时
  // 一律写成 f-e-t-c-h（src/bubble.js 文件头的先例）。
  const body = SRC('api.js');
  for (const banned of ['fetch', 'document', 'window', 'canvas', 'AudioContext',
    'localStorage', 'requestAnimationFrame', 'AbortController', 'XMLHttpRequest', 'Headers']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(body), `api.js 出现了 ${banned}`);
  }
  assert.ok(!/Math\.random\s*\(/.test(body), 'api.js 不得调用 Math.random()');
  // 本模块必须是**输入的函数**：连一个随机源形参都不许有（与 spec §4.13.1.1 第 1 条同界）
  assert.ok(!/\brng\b/.test(body), 'api.js 里不许出现随机源：它一旦抽样就不再是纯函数');
  assert.ok(!/Date\.now|new Date|performance\s*\./.test(body),
    'api.js 不许自取当前时间：时钟只能由调用方传进来（deadlineFor 的参数）');
  assert.ok(!body.includes('./main.js'), 'api.js 不得 import 浏览器模块');
});

test('性格三行只进提示词，不进信息卡：render.js 与 bubble.js 都不 import api.js', () => {
  // spec §6.3 那条硬边界：屏幕上永远不许出现替它陈述情绪/性格的字。
  // 这些措辞是**喂给模型的**，一旦有人顺手拿去画信息卡，那条边界就破了。
  for (const name of ['render.js', 'bubble.js', 'speech.js', 'sim.js']) {
    assert.ok(!SRC(name).includes('./api.js'), `${name} 不得 import api.js`);
  }
  const phrases = Object.values(PERSONA_WORDS).flatMap((p) => [p.high, p.low]);
  const render = SRC('render.js');
  for (const p of phrases) assert.ok(!render.includes(p), `render.js 里出现了性格措辞 ${p}`);
});
