// Task A6：规则档语言层（spec §4.13.1）。
//
// 这一层的全部意义是"**性格与心情必须真的改变说出来的话**"。
// 如果缸里每只都在喵喵，性格系统就是装饰（spec §4.9 那条纪律原文就是这么写的）。
// 所以本文件里有相当一部分断言是**比值**而不是绝对值：
// 断言绝对值的话，任何人调一次 SPEECH_COOLDOWN 都会让全线变红，
// 而调比值不会 —— 比值才是"性格在做事"的证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { decode, randomGenome } from '../src/genes.js';
import { thresholds } from '../src/personality.js';
import { createCreature } from '../src/creature.js';
import { MOODS, moodOf } from '../src/emotions.js';
import { createMemory, remember, PLAYER_ID, adjust } from '../src/memory.js';
import {
  CATCHPHRASES, NEED_WORDS, MOOD_WORDS, MOOD_SALIENCE, PLAYER_WORD,
  catchphrasePool, tokenBudget,
} from '../src/lexicon.js';
import { assignCatchphrase, maybeSay } from '../src/speech.js';

const S = CONFIG.speech;

// ---------------------------------------------------------------- 造个体

// ⚠️ 基因只抽**一次**，两只共用同一份，只改性格里要测的那一项。
// 这是本项目第四次踩的坑（A4 的 hopWeight、A3 的漂入长幼、A5 的配对比较）：
// 每次 createCreature 都重抽随机基因，于是"两只之差"测的是随机基因而不是被控变量。
const sharedGenes = randomGenome(createRng(20261021));

let spSeq = 0;
// over 里的键**全部**当作性格项处理：talk / clingy / activity / …
// catchphrase 是唯一例外（它是个体字段，不是基因表现型）。
const speaker = (over = {}) => {
  const { catchphrase = null, ...personality } = over;
  const c = createCreature({
    id: `sp${spSeq++}`,
    name: '泡泡',
    x: 0.5, y: 0.5,
    age: 600,
    genes: JSON.parse(JSON.stringify(sharedGenes)),
  });
  Object.assign(c.traits.personality, { talk: 0.5 }, personality);
  c.thresholds = thresholds(c.traits.personality);
  c.speech = { nextAt: 0, lastTokens: null };
  c.catchphrase = catchphrase ?? assignCatchphrase(c, createRng(7));
  c.memory = createMemory();
  remember(c.memory, { id: PLAYER_ID, familiarity: 1, affection: 0.8, kinship: 0, role: null });
  return c;
};

// 一个"有话可说"的情境：难过又有需求，保证一定凑得出 ≥2 个 token。
const ctxOf = (mood = 'sad', over = {}) => ({
  mood, playerNear: true, other: null, ...over,
});

// 把一只个体放到某个心情档上：直接写情绪与需求，再由 moodOf 反推档位。
// 刻意**不**手造 moodOf 的输入表 —— 心情必须真的来自内核，否则这里测的是巧合。
const withMood = (mood, over = {}) => {
  const c = speaker(over.personality || {});
  const e = c.emotions;
  const n = c.needs;
  Object.assign(e, { joy: 0, anger: 0, fear: 0, curiosity: 0, sleepy: 0, arousal: 0 });
  Object.assign(n, { hunger: 0.02, energy: 0.02, social: 0.02, safety: 0.02 });
  if (mood === 'anger') e.anger = 0.8;
  if (mood === 'sad') n.social = 0.9;
  if (mood === 'bliss') {
    e.joy = 0.8;
    adjust(c.memory, PLAYER_ID, 1, 0);          // 把好感推到 0.6 以上
  }
  if (mood === 'happy') e.joy = 0.5;
  assert.equal(moodOf(c.emotions, c.needs, c.memory, { adversity: false }), mood,
    `前置条件：这个人设应判成 ${mood}`);
  return c;
};

// ---------------------------------------------------------------- 词表本身

test('词表四个导出集合都被冻结，且冻结这件事本身被钉住', () => {
  // 摘掉 Object.freeze 不会让任何内容断言变红 —— 与 PATTERNS / INTENTS / MOODS 同一条纪律。
  // 这里被就地改坏的症状很具体：MOOD_WORDS 少一档 → 那一档沉默；
  // NEED_WORDS 的键名被改 → 需求词查不到（而 mostUrgent 返回的正是那四个键）。
  for (const [name, obj] of [
    ['CATCHPHRASES', CATCHPHRASES], ['NEED_WORDS', NEED_WORDS],
    ['MOOD_WORDS', MOOD_WORDS], ['MOOD_SALIENCE', MOOD_SALIENCE],
  ]) {
    assert.ok(Object.isFrozen(obj), `${name} 应被冻结`);
    assert.throws(() => { obj.__probe__ = 1; }, TypeError, `${name} 加键应抛 TypeError`);
    assert.throws(() => { obj.hunger = '__probe__'; }, TypeError, `${name} 改值应抛 TypeError`);
  }
  for (const pool of Object.values(CATCHPHRASES)) {
    assert.ok(Object.isFrozen(pool), '每个口癖候选集都应被冻结');
    assert.throws(() => pool.push('__probe__'), TypeError, 'push 应抛 TypeError');
  }
});

test('需求词恰好覆盖四条匮乏度，情绪词恰好覆盖五档心情', () => {
  // 这两条是**键集对齐**检查，不是内容检查：speech 用 needs 的键和 MOODS 的值查表，
  // 键集漂移的症状是"某一档永远沉默"，而且不报错。
  assert.deepEqual(Object.keys(NEED_WORDS).sort(), ['energy', 'hunger', 'safety', 'social']);
  assert.deepEqual(Object.keys(MOOD_WORDS).sort(), [...MOODS].sort());
  assert.deepEqual(Object.keys(MOOD_SALIENCE).sort(), [...MOODS].sort());
});

test('高冷的候选集里只有"哼"，活泼爱撒娇的才有萌系词（spec §4.13.1 表格）', () => {
  assert.deepEqual([...catchphrasePool(0.05, 0.05)], [...CATCHPHRASES.aloof]);
  assert.equal(CATCHPHRASES.aloof.length, 1, '候选集只有一个词，所以最安静的个体也会哼');
  assert.ok(catchphrasePool(0.95, 0.95).length >= 4, '候选集由 talk × clingy 定');
  // 两侧都钉：乘积过门槛的走萌系，没过就走中性 —— 只测一侧的话把门槛写反也能过。
  assert.ok(catchphrasePool(1, 1).includes('喵喵'), '萌系候选集必须含 spec 点名的喵喵');
  assert.ok(!catchphrasePool(0, 0).includes('喵喵'), '高冷候选集不得含萌系词');
});

test('token 预算由 talk 定：高冷 2 个、话痨到上限，且都不超过 maxTokens', () => {
  assert.equal(tokenBudget(0), 2);
  assert.equal(tokenBudget(1), S.tokensBase + S.tokensGain);
  assert.ok(tokenBudget(1) <= S.maxTokens, '预算不得越过 spec 的硬上限');
  assert.ok(tokenBudget(0.1) < tokenBudget(0.9), '话痨的句子要更长（这是"宽度由性格定"的意思）');
});

// ---------------------------------------------------------------- 出词判定

test('同状态 + 同 rng → 出词完全相同（spec 8.1 的可复现要求）', () => {
  const a = speaker({});
  const b = speaker({});
  for (let i = 0; i < 20; i++) {
    const ua = maybeSay(a, ctxOf('sad'), createRng(1000 + i), i * 20);
    const ub = maybeSay(b, ctxOf('sad'), createRng(1000 + i), i * 20);
    assert.deepEqual(ub, ua, `第 ${i} 次出词与种子序列不一致`);
  }
});

test('冷却期内不出词，且冷却时长就是 thresholds.speechCooldown', () => {
  const c = speaker({ talk: 0.5 });
  c.needs.hunger = 0.9;                     // 把 salience 抬起来，好让"能出词"这件事不靠运气
  const cooldown = c.thresholds.speechCooldown;
  // 出词有抽样门，所以"到点确实说了"必须扫种子找一次成功，而不是赌一个种子。
  let spoke = null;
  for (let s = 0; s < 300 && !spoke; s++) {
    const trial = structuredClone(c);
    const u = maybeSay(trial, ctxOf('sad'), createRng(s), 100);
    if (u) spoke = { trial, u };
  }
  assert.ok(spoke, '前置条件：到点时必须说得出话，否则下面全是不等式空转');
  assert.equal(spoke.trial.speech.nextAt, 100 + cooldown, '下一次的最早时刻只由 speechCooldown 决定');
  // 冷却期内换**任何** rng 都不该出词 —— 这才是"门在抽样之前"的意思：
  // 它既挡住了说话，也挡住了随机数消耗（文件头第 3 条：语言层不得独占世界 rng 流）。
  for (let s = 0; s < 50; s++) {
    assert.equal(maybeSay(spoke.trial, ctxOf('sad'), createRng(s), 100 + cooldown - 1e-6), null,
      `冷却期内第 ${s} 个种子仍出了词`);
  }
  let later = null;
  for (let s = 0; s < 300 && !later; s++) {
    later = maybeSay(structuredClone(spoke.trial), ctxOf('sad'), createRng(s), 100 + cooldown);
  }
  assert.ok(later, '冷却到期后必须能再说');
});

test('同一句不连发（回声比沉默更难闻）', () => {
  // 只留一个心情词一个需求词的极简人设，让"只能重复刚才那句"成为唯一可能。
  const c = speaker({ talk: 0.9 });
  const r = createRng(21);
  let said = 0;
  let echo = 0;
  let prev = null;
  for (let t = 0; t < 4000; t += c.thresholds.speechCooldown) {
    const u = maybeSay(c, ctxOf('anger'), r, t);
    if (!u) continue;
    said += 1;
    if (prev && u.tokens.join(' ') === prev) echo += 1;
    prev = u.tokens.join(' ');
  }
  assert.ok(said >= 10, `前置条件：这一路要出够多句才谈得上连发，实测 ${said}`);
  assert.equal(echo, 0, `出现了 ${echo} 次相邻同句`);
});

test('句长落在 [2, maxTokens]，绝不生成完整长句', () => {
  const r = createRng(31);
  for (const mood of MOODS) {
    for (const talk of [0.05, 0.5, 0.95]) {
      const c = withMood(mood, { personality: { talk } });
      for (let t = 0; t < 3000; t += 40) {
        const u = maybeSay(c, ctxOf(mood), r, t);
        if (!u) continue;
        assert.ok(u.tokens.length >= 2, `句长不足 2：${u.text}`);
        assert.ok(u.tokens.length <= S.maxTokens, `句长越上限：${u.text}`);
        assert.equal(u.text, u.tokens.join(' '), 'text 必须就是 tokens 的拼接');
      }
    }
  }
});

test('talk=0.1 与 talk=0.9 各跑 1200 模拟秒，出词数之比 ≥ 3（断言比值，不断言绝对值）', () => {
  // 计划 A6 的陷阱条：断言绝对值的话，任何人调一次 COOLDOWN 都会全线变红。
  // 比值才是"性格在做事"的证据，而且它对整体调参免疫。
  const run = (talk) => {
    const c = speaker({ talk });
    const r = createRng(77);
    let n = 0;
    for (let t = 0; t <= 1200; t += 1) if (maybeSay(c, ctxOf('sad'), r, t)) n += 1;
    return { n, cooldown: c.thresholds.speechCooldown };
  };
  const quiet = run(0.1);
  const talky = run(0.9);
  assert.ok(talky.n >= 5, `前置条件：话痨 1200 秒至少要说 5 句，实测 ${talky.n}`);
  assert.ok(quiet.n >= 1, `前置条件：高冷也得偶尔开口，实测 ${quiet.n}`);
  const ratio = talky.n / quiet.n;
  assert.ok(ratio >= 3, `出词数之比只有 ${ratio.toFixed(2)}（${quiet.n} vs ${talky.n}），性格没在做事`);
});

test('出词的概率随"有多想说"上升：很饿的比什么都不缺的说得多', () => {
  // 这一条守住抽样门的**内容相关性**：若那道门只是无条件抛硬币，
  // "需求决定说不说"就只剩选词，出不出词反倒是装饰。
  // ⚠️ 两边都用 calm 档：sad/anger 自己就带 0.6 的 salience 底，
  //    饿与不饿只差 0.3 → 概率之比只有 1.4，测不出东西（第一版就在这里误报"门没在用"）。
  //    calm 的 salience 只有 0.05，需求才是唯一驱动 —— 归因干净。
  const run = (hunger) => {
    const c = speaker({ talk: 0.5 });
    for (const k of Object.keys(c.needs)) c.needs[k] = 0.02;
    c.needs.hunger = hunger;
    const r = createRng(88);
    let n = 0;
    for (let t = 0; t <= 1200; t += 1) if (maybeSay(c, ctxOf('calm'), r, t)) n += 1;
    return n;
  };
  const full = run(0.02);
  const starving = run(0.95);
  assert.ok(starving > full, `饿的要更爱说：${full} vs ${starving}`);
  assert.ok(starving >= full * 2, `差距太小（${full} vs ${starving}），抽样门没在用需求`);
});

test('关掉文字层 → 恒返回 null，且不修改 creature 任何字段', () => {
  // 这条是 spec §9.2 第 7 条的**机器可查形式**：关掉文字层之后身体语言必须仍然完全可读，
  // 而语言层做不到这一点的最坏方式是"关掉之后仍在改状态"（悄悄刷 nextAt、悄悄攒历史）。
  // 所以断言的是快照，不是"返回值是 null"那么轻。
  //
  // 开关走 ctx.speechEnabled 而不是改 CONFIG —— CONFIG 是深冻结的常量表（这是对的），
  // 运行时开关属于设置页/存档，本来就该由调用方传进来。
  // 两条路径都要测：默认值仍必须来自 CONFIG.speech.enabled，
  // 否则"把 CONFIG 里那个键删掉"不会有任何症状。
  const c = speaker({ talk: 0.9 });
  c.needs.hunger = 0.95;
  const before = structuredClone({
    speech: c.speech, needs: c.needs, emotions: c.emotions,
    memory: c.memory, pos: c.pos, intent: c.intent, catchphrase: c.catchphrase,
  });
  for (let t = 0; t <= 600; t += 1) {
    assert.equal(
      maybeSay(c, ctxOf('anger', { speechEnabled: false }), createRng(t), t), null,
      `${t}s 时关掉文字层仍应沉默`,
    );
  }
  assert.deepEqual({
    speech: c.speech, needs: c.needs, emotions: c.emotions,
    memory: c.memory, pos: c.pos, intent: c.intent, catchphrase: c.catchphrase,
  }, before, '关闭时 creature 必须逐字段不变');

  // 反向：同一批调用在**开着**时必须出得了词，否则上面那条"恒 null"是恒真断言。
  let opened = 0;
  const c2 = speaker({ talk: 0.9 });
  c2.needs.hunger = 0.95;
  for (let t = 0; t <= 600; t += 1) if (maybeSay(c2, ctxOf('anger'), createRng(t), t)) opened += 1;
  assert.ok(opened > 0, `开着文字层却一句都没说（${opened}）：上面的关闭断言就成了恒真`);
});

// ---------------------------------------------------------------- 选词

test('需求词就是最紧的那一条需求（spec §4.13.1 表格第二层）', () => {
  for (const key of Object.keys(NEED_WORDS)) {
    const c = speaker({ talk: 0.9 });
    for (const k of Object.keys(c.needs)) c.needs[k] = 0.02;
    c.needs[key] = 0.95;
    const seen = [];
    const r = createRng(101);
    for (let t = 0; t <= 4000; t += c.thresholds.speechCooldown) {
      const u = maybeSay(c, ctxOf('anger'), r, t);
      if (u) seen.push(u.tokens);
    }
    assert.ok(seen.length >= 5, `前置条件：${key} 这一路要出够多句`);
    for (const tokens of seen) {
      assert.ok(tokens.includes(NEED_WORDS[key]), `${key} 最紧时应说"${NEED_WORDS[key]}"，实际 ${tokens.join(' ')}`);
    }
  }
});

test('心情档决定情绪词层选词：只有 bliss 才可能出"幸福"类词', () => {
  const wordsOf = (mood) => {
    const c = withMood(mood);
    const out = new Set();
    const r = createRng(202);
    for (let t = 0; t <= 6000; t += c.thresholds.speechCooldown) {
      const u = maybeSay(c, { mood, playerNear: true, other: null }, r, t);
      if (u) for (const w of u.tokens) out.add(w);
    }
    return out;
  };
  const bliss = wordsOf('bliss');
  const happy = wordsOf('happy');
  const anger = wordsOf('anger');
  for (const w of MOOD_WORDS.bliss) assert.ok(bliss.has(w), `bliss 一路应能说出"${w}"`);
  // 反向：别的档**绝不**能说这个词 —— 这才是"心情决定选词"，不是"词表里都有而已"
  for (const w of MOOD_WORDS.bliss) {
    assert.ok(!happy.has(w), `happy 说出了 bliss 专属的"${w}"`);
    assert.ok(!anger.has(w), `anger 说出了 bliss 专属的"${w}"`);
  }
  for (const w of MOOD_WORDS.anger) assert.ok(anger.has(w), `anger 一路应能说出"${w}"`);
});

test('每只个体都有自己的口癖，且终身不变', () => {
  const c = speaker({ talk: 0.9, clingy: 0.9 });
  const first = c.catchphrase;
  assert.ok(first, '前置条件：出生时应已抽定口癖');
  const r = createRng(303);
  for (let t = 0; t <= 4000; t += 20) maybeSay(c, ctxOf('sad'), r, t);
  assert.equal(c.catchphrase, first, '出词过程不得改口癖');
  assert.equal(assignCatchphrase(c, createRng(999)), first, '已抽定的个体再分配必须原样返回（且不消费随机数）');
});

test('口癖由 talk × clingy 的候选集抽定，同一父 rng 分叉两次结果一致', () => {
  const a = assignCatchphrase({ catchphrase: null, traits: { personality: { talk: 0.9, clingy: 0.9 } } }, createRng(5).fork());
  const b = assignCatchphrase({ catchphrase: null, traits: { personality: { talk: 0.9, clingy: 0.9 } } }, createRng(5).fork());
  assert.equal(a, b, '同种子下 fork 必须给同一个口癖（可复现）');
  assert.ok(CATCHPHRASES.cute.includes(a), '活泼爱撒娇的应从萌系候选集取');
  const aloof = assignCatchphrase({ catchphrase: null, traits: { personality: { talk: 0.05, clingy: 0.05 } } }, createRng(5).fork());
  assert.equal(aloof, '哼', '高冷只有"哼"可挑');
});

test('ctx.mood 非法时抛错，而不是自己现算心情', () => {
  // 心情必须有**唯一**定义点（moodOf）。speech 里再写一套 if 就是第二个定义点，
  // 症状是"说的话和做出来的动作分家"，而两处都不会报错。
  const c = speaker({});
  assert.throws(() => maybeSay(c, ctxOf('ecstatic'), createRng(1), 0), /心情/);
  assert.throws(() => maybeSay(c, { mood: undefined }, createRng(1), 0), /心情/);
  assert.throws(() => maybeSay(c, ctxOf('sad'), createRng(1), Number.NaN), /nowSec/);
});

test('高冷的句子更短：talk 决定候选词宽度这件事必须可观察', () => {
  // 探针 P6 抓出来的空洞：把修饰项的预算裁剪删掉之后，"句长 ≤ maxTokens" 那条**仍然全绿**，
  // 因为 5 个 token 的硬上限本来就够用 —— 也就是说那句上限断言根本没在测 talk。
  // spec §4.13.1「talk 决定出词间隔与候选词宽度」里的**宽度**这一半必须单独钉：
  // 高冷的正确实现是"少说"（更少、更短），不是"换一套更酷的词"。
  const mean = (talk) => {
    const c = speaker({ talk });
    c.needs.hunger = 0.9;                    // 两边都给同一条紧需求，让 must 的长度对齐
    const r = createRng(909);
    let n = 0;
    let sum = 0;
    for (let t = 0; t <= 20000; t += 1) {
      const u = maybeSay(c, ctxOf('sad'), r, t);
      if (u) { n += 1; sum += u.tokens.length; }
    }
    assert.ok(n >= 5, `前置条件：talk=${talk} 这一路要说够多句才谈得上平均，实测 ${n}`);
    return sum / n;
  };
  const quiet = mean(0.1);
  const loud = mean(0.9);
  assert.ok(loud > quiet, `话痨的句子应更长：${quiet.toFixed(2)} vs ${loud.toFixed(2)}`);
  assert.ok(loud - quiet >= 1, `宽度差距太小（${quiet.toFixed(2)} vs ${loud.toFixed(2)}），预算没在按 talk 收缩`);
});

test('什么都不缺且心情安静时出词率极低', () => {
  // 这条测的是 salience 那一道门真的在做事。
  // 原先我把它写成"6000 秒里一句都不说"，那是**错的断言**：
  // calm + 什么都不缺时 salience 只有一点点，但出词概率不是 0（spec 要的是"少说"，
  // 不是"变雕像"），所以偶尔冒出一句"…… 啵"是正确行为。
  // 断言绝对沉默会让实现被迫把 calm 的概率写成 0 —— 那是拿测试教错人。
  const count = (mood, needy) => {
    const c = speaker({ talk: 0.5 });
    for (const k of Object.keys(c.needs)) c.needs[k] = needy ? 0.9 : 0.02;
    const r = createRng(404);
    let n = 0;
    for (let t = 0; t <= 6000; t += 30) if (maybeSay(c, ctxOf(mood), r, t)) n += 1;
    return n;
  };
  const calm = count('calm', false);
  const upset = count('sad', true);
  assert.ok(upset >= 10, `前置条件：有情绪又难受的个体要说出够多句，实测 ${upset}`);
  assert.ok(upset >= calm * 3, `安静满足的 (${calm}) 与难受的 (${upset}) 差距不足 3 倍`);
});

test('有同伴在场时会叫对方的名字，没有时不会（称呼层由 memory 与情境给）', () => {
  // ⚠️ 两次跑必须用**两只**个体。第一版共用同一只，于是 a 每说完一句就把 nextAt 推进，
  // 同一时刻的 b 必然落在冷却期内 —— alone 那侧一句都没有，`!alone.some(...)` 就成了
  // 恒真的空断言（"从没说过"和"没机会说"完全混掉了）。
  const gather = (ctxOver) => {
    const c = speaker({ talk: 0.9 });
    const out = [];
    const r = createRng(501);              // 同一串随机数，只差 ctx.other
    for (let t = 0; t <= 8000; t += c.thresholds.speechCooldown) {
      const u = maybeSay(c, ctxOf('anger', ctxOver), r, t);
      if (u) out.push(u.tokens);
    }
    return out;
  };
  const withOther = gather({ other: { id: 'o1', name: '软软' } });
  const alone = gather({});
  assert.ok(withOther.length >= 5 && alone.length >= 5,
    `前置条件：两边都要出够多句（${withOther.length}/${alone.length}）`);
  assert.ok(withOther.some((tk) => tk.includes('软软')), '有对象时应出现过对方的名字');
  assert.ok(!alone.some((tk) => tk.includes('软软')), '没人时不该冒出对方的名字');
});

test('称呼层用"主人"，且只有玩家在场时才出现（spec §4.13.1 第三层）', () => {
  // 同上：两只个体、同一串随机数，只差 playerNear。
  const gather = (playerNear) => {
    const c = speaker({ talk: 0.9 });
    const out = [];
    const r = createRng(502);
    for (let t = 0; t <= 8000; t += c.thresholds.speechCooldown) {
      const u = maybeSay(c, { mood: 'sad', playerNear, other: null }, r, t);
      if (u) out.push(u.tokens);
    }
    return out;
  };
  const near = gather(true);
  const far = gather(false);
  assert.ok(near.length >= 5 && far.length >= 5,
    `前置条件：两边都要出够多句（${near.length}/${far.length}），否则"没叫过"是空断言`);
  assert.ok(near.some((tk) => tk.includes(PLAYER_WORD)), '玩家在场时应叫过"主人"');
  assert.ok(!far.some((tk) => tk.includes(PLAYER_WORD)), '玩家不在场时不该叫"主人"');
});

// ---------------------------------------------------------------- 架构守卫

test('speech.js 与 lexicon.js 确实在 constraints 的扫描清单里，且没有禁用标识符', () => {
  // 这条是 spec §4.13.2 第 2 条"模型是只读旁路"的**第一道**防线：
  // 规则档里如果有人图省事直接 fetch 一个端点，整个语言层就依赖网络了，
  // 而 start.bat 十年后仍能打开的是规则档（spec §1 原则 5）。
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  for (const expected of ['speech.js', 'lexicon.js']) {
    assert.ok(files.includes(expected), `${expected} 不存在，扫描清单里没有它`);
  }
  for (const name of ['speech.js', 'lexicon.js']) {
    const body = readFileSync(join(SRC, name), 'utf8');
    for (const banned of ['fetch', 'document', 'window', 'canvas', 'AudioContext', 'localStorage', 'requestAnimationFrame']) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(body), `${name} 引用了浏览器 API ${banned}`);
    }
    assert.ok(!/Math\.random\s*\(/.test(body), `${name} 不得调用 Math.random()`);
    assert.ok(relative(ROOT, join(SRC, name)), name);
  }
});

test('maybeSay 不碰 needs / emotions / memory（语言层只读世界状态）', () => {
  // spec §4.13.2 第 2 条对 API 档写死了"不许因为输出改世界"，规则档**同一条**必须成立：
  // 说话不该让它更饱、更开心或更记得你。这条把边界钉在测试里，而不是只写在注释里。
  const c = speaker({ talk: 0.9 });
  const before = {
    needs: structuredClone(c.needs),
    emotions: structuredClone(c.emotions),
    memory: structuredClone(c.memory),
    pos: structuredClone(c.pos),
    intent: c.intent,
  };
  const r = createRng(606);
  for (let t = 0; t <= 4000; t += 20) maybeSay(c, ctxOf('sad', { other: { id: 'o', name: '软软' } }), r, t);
  assert.deepEqual(c.needs, before.needs);
  assert.deepEqual(c.emotions, before.emotions);
  assert.deepEqual(c.memory, before.memory);
  assert.deepEqual(c.pos, before.pos);
  assert.equal(c.intent, before.intent);
});
