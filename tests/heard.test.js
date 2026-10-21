// Task A7：听进去的话（spec §4.8.1）。
//
// 能力边界先说死，因为它决定这套实现值不值得信：规则引擎这一档做的是
// **记住并复现关键词**，不是理解语义。所以本文件里的断言全部是**行为级**的
// —— 计划 A7 的陷阱条：分词没有标准答案，测试只能钉行为，不能钉具体切法，
// 否则换一种分词策略就全红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { createCreature } from '../src/creature.js';
import { thresholds } from '../src/personality.js';
import { randomGenome, decode } from '../src/genes.js';
import { ensure, get, PLAYER_ID } from '../src/memory.js';
import { hear, recall, heardRetention, heardCap, HEARD_KEYS } from '../src/heard.js';
import { STOPWORDS, tokenize } from '../src/lexicon.js';
import { MOODS } from '../src/emotions.js';

const H = CONFIG.heard;

let uid = 0;
const creature = (over = {}) => {
  const genes = randomGenome(createRng(3400 + uid));
  const c = createCreature({ id: `h${uid++}`, name: '泡泡', x: 0.5, y: 0.5, age: 600, genes });
  Object.assign(c.traits.personality, { intellect: 0.5, curious: 0.5 }, over);
  c.thresholds = thresholds(c.traits.personality);
  return c;
};

// ---------------------------------------------------------------- 分词（只钉行为）

test('分词能切出实词：带标点、带空白、纯中文都至少有词出来', () => {
  // 刻意**不**断言"切成哪几个词"。分词是这个 Task 里唯一一处没有标准答案的实现，
  // 钉死切法等于把重构的门焊住（计划 A7 陷阱条）。
  assert.ok(tokenize('宝宝今天也要好好吃饭哦').length >= 1);
  assert.ok(tokenize('要 好好 吃饭').length >= 1);
  assert.ok(tokenize('吃饭！吃饭？今天。').length >= 1, '标点要当切分符');
  assert.deepEqual(tokenize(''), [], '空串要给出空数组，而不是 [""] 或 undefined');
  assert.deepEqual(tokenize('   '), [], '纯空白同上');
});

test('停用词不进入候选，且切出来的每个候选都是非空实词', () => {
  const toks = tokenize('今天也要好好吃饭哦');
  for (const t of toks) {
    assert.equal(typeof t, 'string');
    assert.ok(t.length >= 2, `候选太短不像词：${JSON.stringify(t)}`);
    assert.ok(!STOPWORDS.includes(t), `"${t}" 是停用词，不该进候选`);
    assert.equal(t, t.trim(), '候选两端不该留空白');
  }
});

// ---------------------------------------------------------------- hear

test('一次听进去的词数随 curious 上升（其余基因共用同一份）', () => {
  // 配对比较必须共用基因组，否则测的是随机基因 —— 本项目第五次踩这条，别再踩。
  const count = (curious) => {
    const c = creature({ curious });
    hear(c, '宝宝今天也要好好吃饭哦 要摸摸 怕怕 玩 开心', createRng(9), 0, { need: 'hunger' });
    return c.heard.length;
  };
  const quiet = count(0);
  const nosy = count(1);
  assert.ok(nosy > quiet, `好奇的应多听进去几个：${quiet} vs ${nosy}`);
  assert.ok(quiet >= 1, `前置条件：不好奇的也要听得进词，实测 ${quiet}`);
});

test('heardCap = 4 + round(intellect × 8)，傻的存 4 条、聪明的存 12 条', () => {
  assert.equal(heardCap({ heardCapacity: 4 }), 4);
  assert.equal(heardCap({ heardCapacity: 12 }), 12);
  assert.equal(heardCap({ heardCapacity: 7.5 }), 8, '容量取整后才用（存档里不该有小数容量）');
  const dim = creature({ intellect: 0 });
  const bright = creature({ intellect: 1 });
  assert.equal(dim.thresholds.heardCapacity, CONFIG.speech.heardBase);
  assert.equal(
    bright.thresholds.heardCapacity,
    CONFIG.speech.heardBase + CONFIG.speech.heardGain,
  );
  // 一直喂话，两边各自停在各自的上限
  for (let i = 0; i < 40; i++) {
    const text = `词${String(i).padStart(2, '0')} 吃饭 摸摸 玩耍 睡觉`;
    hear(dim, text, createRng(100 + i), i, { need: 'hunger' });
    hear(bright, text, createRng(100 + i), i, { need: 'hunger' });
  }
  assert.equal(dim.heard.length, 4, 'intellect=0 只能存 4 条');
  assert.equal(bright.heard.length, 12, 'intellect=1 能存 12 条');
});

test('heard 不挤占关系记忆的 12 条配额（记得你说的话 ≠ 记得你）', () => {
  const c = creature({});
  ensure(c.memory, PLAYER_ID);
  for (let i = 0; i < CONFIG.memoryCapacity; i++) ensure(c.memory, `x${i}`);
  assert.ok(c.memory.entries.length <= CONFIG.memoryCapacity, '前置条件：关系记忆应已到上限');
  const before = c.memory.entries.map((e) => e.id).sort();
  for (let i = 0; i < 20; i++) hear(c, `吃饭 睡觉 打豆豆 ${i}`, createRng(i), i, { need: 'hunger' });
  assert.deepEqual(c.memory.entries.map((e) => e.id).sort(), before,
    'hear 之后关系记忆必须一条不少、一条不多');
  assert.ok(get(c.memory, PLAYER_ID), '玩家那条绝不能被对话挤掉');
  assert.ok(c.heard.length > 0, '前置条件：对话确实被存下来了');
});

test('每条 heard 恰好六个键，重复听到同一个词只加 uses 不新增条目', () => {
  const c = creature({});
  hear(c, '吃饭', createRng(1), 10, { need: 'hunger' });
  const n1 = c.heard.length;
  hear(c, '吃饭', createRng(2), 20, { need: 'hunger' });
  assert.equal(c.heard.length, n1, '同一个词不该存两份');
  const e = c.heard.find((x) => x.token === '吃饭');
  if (e) {
    assert.equal(e.uses, 2, 'uses 记的是"听到几次"（反复说的记得牢）');
    assert.deepEqual(Object.keys(e).sort(), [...HEARD_KEYS].sort(), '条目形状必须稳定（存档契约）');
    assert.equal(e.heardAt, 10, 'heardAt 是**第一次**听到的时刻');
  } else {
    // 分词不保证"吃饭"两字一定成为候选（这是行为级测试的代价），
    // 那就用实际存下来的那个词来做同样的断言。
    assert.ok(c.heard.length >= 1, '前置条件：总得存下点什么');
    assert.equal(c.heard[0].uses, 2);
    assert.deepEqual(Object.keys(c.heard[0]).sort(), [...HEARD_KEYS].sort());
  }
});

test('词的价格由听到时的心情定：骂它的时刻听到的词是负价，开心时听到的是正价', () => {
  const c1 = creature({});
  hear(c1, '打豆豆', createRng(3), 0, { mood: 'anger', need: 'safety' });
  const c2 = creature({});
  hear(c2, '打豆豆', createRng(3), 0, { mood: 'bliss', need: 'safety' });
  const p = (c) => (c.heard.find((e) => e.token === '打豆豆') || c.heard[0]).price;
  assert.ok(p(c1) < 0, `anger 时听到的词该是负价，实测 ${p(c1)}`);
  assert.ok(p(c2) > 0, `bliss 时听到的词该是正价，实测 ${p(c2)}`);
});

test('同 seed 下 hear 结果可复现（候选挑选用的随机数必须来自注入的 rng）', () => {
  const a = creature({});
  const b = creature({});
  const text = '宝宝今天也要好好吃饭哦 要摸摸 怕怕 玩 开心 睡觉';
  hear(a, text, createRng(42), 0, { mood: 'happy', need: 'hunger' });
  hear(b, text, createRng(42), 0, { mood: 'happy', need: 'hunger' });
  assert.deepEqual(a.heard, b.heard);
  // 反向：不同 seed 应能给出**不同**的挑选结果，否则说明 rng 根本没被用。
  // 扫 8 个种子而不是赌一对：候选数与取数接近时单对种子有真实概率恰好相同，
  // 那是"用一条 1/2 概率的断言冒充判据"。
  let sawDifference = false;
  for (let k = 0; k < 8; k++) {
    const c = creature({ intellect: 1, curious: 1 });
    hear(c, text, createRng(50 + k), 0, { mood: 'happy', need: 'hunger' });
    const d = creature({ intellect: 1, curious: 1 });
    hear(d, text, createRng(500 + k), 0, { mood: 'happy', need: 'hunger' });
    if (JSON.stringify(c.heard.map((e) => e.token)) !== JSON.stringify(d.heard.map((e) => e.token))) {
      sawDifference = true;
    }
  }
  assert.ok(sawDifference, '八对种子给出的挑选结果全部相同 ⇒ hear 没有真的用注入的 rng');
});

test('hear 拒绝非字符串输入，而不是静默存下 "undefined"', () => {
  const c = creature({});
  assert.throws(() => hear(c, null, createRng(1), 0), /文本/);
  assert.throws(() => hear(c, 123, createRng(1), 0), /文本/);
  assert.throws(() => hear(c, '吃饭', createRng(1), Number.NaN), /nowSec/);
  assert.throws(() => hear(c, '吃饭', createRng(1), 0, { mood: 'nope' }), /心情/);
  // need 也必须有默认值检查：默认 'hunger' 的症状是「它总在饿的时候提起任何词」，
  // 听起来还算合理，比抛错难查十倍。
  assert.throws(() => hear(c, '吃饭', createRng(1), 0, { mood: 'calm' }), /need/);
  assert.throws(() => hear(c, '吃饭', createRng(1), 0, { mood: 'calm', need: 'pride' }), /need/);
  assert.equal(c.heard.length, 0, '抛错路径不得留下半成品条目');
});

// ---------------------------------------------------------------- 淡忘

test('uses 高的半衰期是普通的两倍（反复说的词记得牢）', () => {
  const now = 1000;
  const weak = { token: 'a', price: 0, boundMood: 'calm', heardAt: 0, lastUsed: 0, uses: 1 };
  const strong = { token: 'a', price: 0, boundMood: 'calm', heardAt: 0, lastUsed: 0, uses: H.strongUses };
  const half = (e) => {
    // 用Retention 反解半衰期：强度掉到一半的时刻
    let t = 0;
    const start = heardRetention(e, 0);
    while (t < 1e6 && heardRetention(e, t) > start / 2) t += 1;
    return t;
  };
  assert.ok(heardRetention(weak, 0) > 0, '前置条件：起点必须有强度');
  const a = half(weak);
  const b = half(strong);
  assert.ok(Math.abs(b / a - H.strongFactor) < 0.05,
    `半衰期之比应为 ${H.strongFactor}，实测 ${(b / a).toFixed(3)}（${a} vs ${b}）`);
});

test('淡忘是单调收缩且与步长无关（沿用 memory.decay 那条数学）', () => {
  const e = { token: 'a', price: 0.5, boundMood: 'happy', heardAt: 0, lastUsed: 0, uses: 1 };
  const coarse = heardRetention(e, 200);
  let fine = 1;
  for (let i = 0; i < 2000; i++) fine = heardRetention(e, (i + 1) * 0.1);
  assert.ok(Math.abs(fine - coarse) < 1e-9, `步长无关性破了：${fine} vs ${coarse}`);
  assert.ok(heardRetention(e, 50) < heardRetention(e, 10), '强度必须随时间单调下降');
  assert.ok(heardRetention(e, 1e9) >= 0, '不会掉成负数');
});

test('装不下时淘汰的是"最淡的"，不是"最老的"', () => {
  const c = creature({ intellect: 0, curious: 1 });   // 容量 4、每次最多听 5 个
  // 前三个词反复听到（记得牢），第四个只听过一次
  for (let i = 0; i < 6; i++) {
    hear(c, '吃饭 睡觉 摸摸 玩哦', createRng(i), i, { need: 'hunger' });
  }
  hear(c, '打豆豆', createRng(99), 10, { need: 'hunger' });
  assert.equal(c.heard.length, 4, '前置条件：应已顶满容量');
  const kept = c.heard.map((e) => e.token);
  assert.ok(kept.includes('吃饭') && kept.includes('睡觉'), `反复听的要留下：${kept.join('/')}`);
  assert.ok(!kept.includes('打豆豆'), `新来的孤词该被挤掉：${kept.join('/')}`);
});

// ---------------------------------------------------------------- recall

test('相关情境才冒出来：存了跟"饿"绑定的词，hunger 低时不返回它', () => {
  const c = creature({ intellect: 1 });
  c.needs.hunger = 0.9;                          // 听到时最紧的是饿
  hear(c, '吃饭', createRng(5), 0, { mood: 'sad', need: 'hunger' });
  assert.ok(c.heard.length >= 1, '前置条件：词得存进去');
  const token = c.heard[0].token;
  const hit = recall(c, { need: 'hunger', mood: 'sad' }, 0, createRng(1));
  assert.ok(hit, '饿的时候应该冒出那个词');
  assert.equal(hit.token, token);
  c.needs.hunger = 0.01;
  assert.equal(recall(c, { need: 'safety', mood: 'calm' }, 0, createRng(2)), null,
    '情境不相干时不该硬塞（否则"个性化反馈"就成了随机插词）');
});

test('负价的词它自己不再提，正价的会提（"躲"在规则档里的形状）', () => {
  const c = creature({ intellect: 1 });
  c.needs.social = 0.9;
  hear(c, '抱抱', createRng(6), 0, { mood: 'sad', need: 'social' });
  const e = c.heard[0];
  assert.ok(e, '前置条件：要存得下词');
  e.price = -0.8;
  assert.equal(recall(c, { need: 'social', mood: 'sad' }, 0, createRng(3)), null,
    '被你骂过的词它不会再自己提起');
  e.price = 0.8;
  assert.ok(recall(c, { need: 'social', mood: 'sad' }, 0, createRng(4)), '正价的词会冒出来');
});

test('intellect=0 时复述有 25% 概率说错词，intellect=1 时为 0', () => {
  const trial = (intellect, seedLoops) => {
    const c = creature({ intellect });
    c.needs.hunger = 0.9;
    hear(c, '吃饭', createRng(7), 0, { mood: 'sad', need: 'hunger' });
    const stored = c.heard[0];
    if (!stored) return null;
    let wrong = 0;
    for (let s = 0; s < seedLoops; s++) {
      const r = recall(c, { need: 'hunger', mood: 'sad' }, 0, createRng(1000 + s));
      if (r && r.token !== stored.token) wrong += 1;
    }
    return { wrong, stored: stored.token };
  };
  const bright = trial(1, 400);
  assert.ok(bright, '前置条件：得先存下词');
  assert.equal(bright.wrong, 0, `聪明的不可能说错，实测错 ${bright.wrong} 次`);
  const dim = trial(0, 400);
  assert.ok(dim, '前置条件：得先存下词');
  // 25% 是 misspeakMax（intellect=0 时 misspeakChance 恰好取到它）。
  // 400 次抽样在 p=0.25 下的标准差约 8.7，容到 3 个标准差 ⇒ [37, 163]。
  assert.ok(dim.wrong >= 37 && dim.wrong <= 163,
    `intellect=0 的说错次数应约在 100/400，实测 ${dim.wrong}`);
});

test('recall 是纯读的：不改 heard、不记 lastUsed', () => {
  // 这一条守的是 A6 定下的边界 —— 语言层不许改世界状态。
  // 若 recall 顺手把 uses 加上去，"反复听到才记得牢"就会被自己的复述刷成永生，
  // 而那是 spec §4.8.1 没有规定的机制。
  const c = creature({ intellect: 1 });
  c.needs.hunger = 0.9;
  hear(c, '吃饭', createRng(8), 0, { mood: 'sad', need: 'hunger' });
  const before = structuredClone(c.heard);
  for (let s = 0; s < 50; s++) recall(c, { need: 'hunger', mood: 'sad' }, 0, createRng(s));
  assert.deepEqual(c.heard, before);
});

test('strength 掉到地板以下就不再冒出来（遗忘是真的）', () => {
  const c = creature({ intellect: 1 });
  c.needs.hunger = 0.9;
  hear(c, '吃饭', createRng(9), 0, { mood: 'sad', need: 'hunger' });
  assert.ok(recall(c, { need: 'hunger', mood: 'sad' }, 0, createRng(1)), '前置条件：当时能冒出来');
  const muchLater = H.halfLife * 40;
  assert.equal(recall(c, { need: 'hunger', mood: 'sad' }, muchLater, createRng(1)), null,
    '四十个半衰期之后该彻底忘了');
});

test('MOODS 的每一档都有对应的价格符号，且 calm 是零价', () => {
  // 价格表若少一档，hear 在那一档会静默拿到 undefined 并写进存档
  // （undefined 存盘变 null，读回 null × 衰减 = 0）—— 正是 memory.js 文件头列过的那类静默失败。
  for (const mood of MOODS) {
    assert.ok(Number.isFinite(CONFIG.heard.moodPrice[mood]), `${mood} 档缺价格`);
  }
  assert.equal(CONFIG.heard.moodPrice.calm, 0, '安静时听到的是中性词');
  assert.ok(CONFIG.heard.moodPrice.anger < 0 && CONFIG.heard.moodPrice.sad < 0);
  assert.ok(CONFIG.heard.moodPrice.bliss > 0 && CONFIG.heard.moodPrice.happy > 0);
});
