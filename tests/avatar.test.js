import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expressionFor, avatarSrc, preloadList, EXPRESSIONS } from '../src/avatar.js';
import { CONFIG } from '../src/config.js';
import { createEmotions } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// PLAYER 那条记忆必须走 remember() 而不是手塞对象：它对字段有校验，
// 手塞的假条目会让 affectionFor 读到 undefined，bliss 那一档永远判不出来（B20 就踩过这个）。
const mk = (o = {}) => ({
  id: 'c', alive: true, dying: 0, mourn: o.mourn ?? 0,
  emotions: Object.assign(createEmotions(), o.emotions),
  needs: Object.assign(createNeeds(), o.needs),
  memory: (() => {
    const m = createMemory();
    remember(m, { id: 'PLAYER', familiarity: 1, affection: o.aff ?? 0, kinship: 0, role: null });
    return m;
  })(),
});

// bliss 要三样齐全（emotions.js:201-209 那条判据）：joy≥0.6 + 四条 needs≤0.25 + 对玩家好感≥0.6。
// createNeeds 的默认值本来就全 ≤0.25，所以这里只补 joy 与好感。
const BLISS = { emotions: { joy: 0.8, arousal: 0.4 }, aff: 0.9 };

test('八张表情**各有生产者**：这张表里没有死条目，表外的名字也造不出来', () => {
  const cases = [
    { emotions: { anger: 0.9 } },
    { emotions: { joy: 0.1, fear: 0.6 } },
    BLISS,
    { emotions: { joy: 0.6 } },
    { emotions: { sleepy: 0.95 } },
    { emotions: { curiosity: 0.95 } },
    { emotions: { arousal: 0.95 } },
    { emotions: {} },
  ];
  const seen = cases.map((c) => expressionFor(mk(c)));
  assert.deepEqual([...new Set(seen)].sort(), Object.keys(CONFIG.avatar.file).sort(),
    '造得出来的表情必须**恰好**是表里那八个：少一个是死图，多一个是表里查不到的文件名');
});

test('我们的档名与素材的文件名**不同名**，映射逐条钉住', () => {
  // 这张表存在的全部理由：我们叫 anger / bliss，素材文件叫 angry / love。
  // 差一个字母不会报错，只会"生气的那只显示一张笑脸"。
  assert.equal(expressionFor(mk({ emotions: { anger: 0.9 } })), 'anger');
  assert.equal(expressionFor(mk(BLISS)), 'bliss');
  assert.equal(avatarSrc('anger'), 'assets/star_puff_angry.png');
  assert.equal(avatarSrc('bliss'), 'assets/star_puff_love.png');
  assert.equal(avatarSrc('curiosity'), 'assets/star_puff_surprised.png');
  assert.equal(avatarSrc('arousal'), 'assets/star_puff_wink.png');
});

test('moodOf 不区分的三档只能从 dominant(emotions) 来，且只在 calm 时才看它', () => {
  for (const [k, want] of [['sleepy', 'sleepy'], ['curiosity', 'curiosity'], ['arousal', 'arousal']]) {
    assert.equal(expressionFor(mk({ emotions: { [k]: 0.95 } })), want);
  }
  // calm 才看 dominant：happy 的那只即使 sleepy 更高也不许改成打哈欠的脸，
  // 那会把"心情档"这条已经定了的结论又推翻一次。
  assert.equal(expressionFor(mk({ emotions: { joy: 0.6, sleepy: 0.9 } })), 'happy');
});

test('calm 是唯一的兜底：情绪全 0 不许出 wink / surprised / sleepy', () => {
  assert.equal(expressionFor(mk({ emotions: {} })), 'calm');
  assert.equal(expressionFor(mk({ emotions: { joy: 0.2 } })), 'calm');
});

test('preloadList 恰好八条、不重复、不含 character.png 也不含图集', () => {
  const l = preloadList();
  assert.equal(l.length, 8);
  assert.equal(new Set(l).size, 8);
  // ⚠️ star_puff_character.png 与 star_puff_wink.png **md5 完全相同**（D-1 量到的，
  // 记在 .superpowers/sdd/progress.md 2026-10-23 那段）。加载它 = 白拉 315KB。
  assert.ok(!l.some((s) => s.includes('character')), '同一张图不许加载两次');
  assert.ok(!l.some((s) => s.includes('spritesheet')), '图集不进 HUD：单张 512 够用，切图反而要算 UV');
});

test('八个文件真的在盘上（表里打错一个字母就红）', () => {
  for (const src of preloadList()) {
    assert.ok(existsSync(join(HERE, '..', src)), `缺文件 ${src}`);
  }
});

test('avatarSrc 只吐 assets 下的 .png；未知表情名走兜底而不是抛', () => {
  for (const e of EXPRESSIONS) assert.match(avatarSrc(e), /^assets\/star_puff_[a-z]+\.png$/);
  assert.equal(avatarSrc('没有这个表情'), avatarSrc(CONFIG.avatar.fallback));
  assert.equal(avatarSrc(undefined), avatarSrc(CONFIG.avatar.fallback));
  assert.equal(avatarSrc('constructor'), avatarSrc(CONFIG.avatar.fallback),
    '原型链上的名字不许当成表里的键（Object.hasOwn 那道守卫的全部意义）');
});

test('脏输入一律出兜底脸，不抛：缺字段的存档个体也得有一张肖像', () => {
  // ⚠️ 最后那一条是**修正过的**：原来写的是 `{ emotions: createEmotions(), needs: createNeeds() }`，
  //    全 0 的 joy 让 moodOf 在 bliss 那一步之前就返回了 calm，**根本没走到 memory**，
  //    于是"去掉 !memory 守卫"这道探针活着回来了（TypeError 只在真实路径上才发生）。
  //    要打到 affectionFor 必须 joy≥0.6 且四条 needs 都≤0.25 —— 也就是真的走到 bliss 那一判。
  const joyHigh = Object.assign(createEmotions(), { joy: 0.9 });
  for (const c of [null, undefined, {}, { emotions: null }, { emotions: {}, needs: null },
    { emotions: joyHigh, needs: createNeeds() },
    { emotions: joyHigh, needs: createNeeds(), memory: null }]) {
    const e = expressionFor(c);
    assert.ok(EXPRESSIONS.includes(e), `${JSON.stringify(c || null)} 给出了 ${e}`);
  }
});

test('mourn > 0 算 adversity：那一张必须是 sad，即使 joy 很高', () => {
  // emotions.js:202 那条 sad 判据排在 happy 之前，肖像得跟着它，否则"刚死完妈却在笑"。
  const c = mk({ emotions: { joy: 0.9 }, aff: 0.2, mourn: 3 });
  assert.equal(expressionFor(c), 'sad');
});
