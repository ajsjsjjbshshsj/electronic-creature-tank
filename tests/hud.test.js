import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readoutFor, formatAge, cardFor, relationRowsFor, radarFor, heartFillFor, sizeTier,
  saveBadgeFor, conflictNoticeFor,
} from '../src/hud.js';
import { CONFIG } from '../src/config.js';
import { createEmotions } from '../src/emotions.js';
import { sizeOf } from '../src/creature.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';
import { mountHud } from '../src/hud.js';
import { makeDoc, find, findAll, textOf, dump, click, countListeners } from './dom-stub.js';

// ---------------------------------------------------------------- 这个文件在守什么
//
// HUD 是玩家与这缸之间**唯一**的文字通道，而 spec §13.2 第 4 条给这条通道划了一条硬边界：
// 信息卡是你这个照料者的观察记录，**不是它在对你说话**。所以本文件最要紧的一条不是
// "某行有没有字"，而是那条**行为级**判据：只差情绪的两只个体，卡上的行必须逐字节相同。
// grep 级判据（"不许出现心情名词"）挡得住「它现在心情：开心」，挡不住「它看起来有点烦」——
// 后者一个名词都没有，但同样是游戏在替它陈述。

const mk = (o = {}) => ({
  id: o.id || 'c1',
  name: 'name' in o ? o.name : '泡泡',
  customName: o.customName ?? false,
  generation: o.generation ?? 2,
  age: o.age ?? 200,
  stage: o.stage || 'adult',
  alive: true, sick: false, dying: 0, mourn: o.mourn ?? 0,
  pos: { x: 0.4, y: 0.5 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 },
  emotions: Object.assign(createEmotions(), o.emotions),
  needs: Object.assign(createNeeds(), o.needs),
  memory: (() => {
    const m = createMemory();
    remember(m, { id: 'PLAYER', familiarity: 1, affection: o.aff ?? 0, kinship: 0, role: null });
    for (const e of (o.known || [])) remember(m, e);
    return m;
  })(),
  // traits.size 是**世界单位**（genes.js:130 把表现型 0..1 映到 CONFIG.minSize..maxSize = 14..38），
  // 不是 0..1。计划里那版按 0..1 定的档位阈值是错的，这里按世界单位来。
  traits: {
    hue: o.hue ?? 330, sat: 0.6, lum: 0.7, size: o.size ?? 26, glow: 0.6,
    pattern: o.pattern ?? 'rings', patternDensity: 0.4, wobble: 0.5, fluff: 0.5,
    eggTint: o.eggTint ?? 'macaron-mint',
    personality: { bold: 0.2, clingy: 0.8, irritable: 0.1, gluttonous: 0.6, curious: 0.3,
      activity: 0.7, talk: 0.4, intellect: 0.9, broody: 0.5 },
  },
  genes: {}, thresholds: { heardCapacity: 6 },
  lineage: { mother: o.mother ?? null, father: null, mates: [], offspring: o.offspring ?? [] },
  heard: o.heard ?? [], eggBoost: o.eggBoost ?? 0, catchphrase: '喵喵',
  intent: null, intentTime: 0, resting: false, moving: false,
  broodT: 0, beingPetted: false, beingPoked: false, begIgnored: 0,
  speech: { nextAt: 0, lastTokens: null },
});
const W = (creatures, o = {}) => Object.assign({
  creatures, eggs: [], foods: [], time: 125, populationCap: 24,
}, o);
const row = (card, label) => card.rows.find((r) => r.label === label);

// ---------------------------------------------------------------- 硬边界

test('信息卡**永远不许替它陈述心情**（spec §13.2 第 4 条，行为级而不是 grep 级）', () => {
  // ① 文字侧：五档心情的名字与常见说法都不许出现在行或标题里。
  const BANNED = ['心情', '开心', '快乐', '幸福', '伤心', '愤怒', '生气', '安静', '卖萌',
    'anger', 'sad', 'bliss', 'happy', 'calm'];
  for (const c of [mk({ emotions: { anger: 0.95 } }), mk({ emotions: { joy: 0.95 } }),
    mk({ emotions: { joy: 0.8, arousal: 0.4 }, aff: 0.9 }), mk({ emotions: { sleepy: 0.9 } })]) {
    const card = cardFor(c, W([c]));
    const text = JSON.stringify(card.rows) + JSON.stringify(card.title);
    for (const w of BANNED) assert.ok(!text.includes(w), `卡上出现了"${w}" = 游戏在替它陈述心情`);
  }
  // ② 更强的那条：两只**只差情绪**的个体，rows 必须逐字节相同。
  //    这条封的是"哪天有人加一行『它看起来有点烦』" —— 那行的字里不含任何心情名词，
  //    判据 ① 抓不到，但它随情绪变 ⇒ 这条抓到。
  const p = mk({ id: 'x' });
  const q = mk({ id: 'x', emotions: { joy: 1, anger: 0.9, fear: 1, sleepy: 1, curiosity: 1, arousal: 1 } });
  assert.deepEqual(cardFor(p, W([p])).rows, cardFor(q, W([q])).rows,
    'rows 随情绪变了：HUD 在陈述心情');
  // ③ 而**肖像允许**随情绪变 —— 那是它的脸。§6.3 那条边界禁的是"字"，
  //    明文的正面通道正是"它自己的身体（§4.5/§4.6/§4.7）与它自己选择说出的词"。
  assert.notEqual(cardFor(p, W([p])).portrait, cardFor(q, W([q])).portrait);
});

// ---------------------------------------------------------------- 行的集合与内容

test('cardFor 的行集合逐字取自 spec §6.3，一条不许少、一条不许多', () => {
  const labels = cardFor(mk(), W([mk()])).rows.map((r) => r.label);
  assert.deepEqual(labels, ['名字', '年龄', '阶段', '体型', '母亲', '孩子', '蛋', '记住的词']);
});

test('孤雌制：没有"父亲"这一行（不是"父亲：—"）；漂入的个体母亲是「—」', () => {
  const born = mk({ mother: 'm1' });
  const world = W([born, mk({ id: 'm1', name: '团团' })]);
  assert.equal(row(cardFor(born, world), '母亲').value, '团团');
  const text = JSON.stringify(cardFor(born, world).rows);
  assert.ok(!text.includes('父亲'), '孤雌制下这一行**不存在**（spec §4.8：father 不再写入）');
  assert.equal(row(cardFor(mk({ mother: null }), W([mk()])), '母亲').value, '—',
    '漂入进来的没有母亲节点 —— 这是好事，玩家一眼看出"这支是外来的"');
});

test('阶段那一行是中文档名，不是 stage 那个英文键', () => {
  assert.equal(row(cardFor(mk({ stage: 'hatchling' }), W([mk()])), '阶段').value, '幼体');
  assert.equal(row(cardFor(mk({ stage: 'elder' }), W([mk()])), '阶段').value, '老年');
  assert.equal(row(cardFor(mk({ stage: '没有这一档' }), W([mk()])), '阶段').value, '—');
});

test('体型写档位词，不写那个世界单位数字，也不写 0-1 的表现型', () => {
  // 档位 = [minSize, maxSize] 的三等分（hud.js 的 sizeTier）：
  //   小 [14,22) · 中 [22,30) · 大 [30,38]。把三条边界钉死，改等分数就会红。
  assert.equal(sizeTier(14), '小');
  assert.equal(sizeTier(21.9), '小');
  assert.equal(sizeTier(22), '中');
  assert.equal(sizeTier(26), '中', '基因中位数 26 必须读成"中"，不是"大"');
  assert.equal(sizeTier(29.9), '中');
  assert.equal(sizeTier(30), '大');
  assert.equal(sizeTier(38), '大');
  assert.equal(sizeTier(-5), '小', '幼体的 sizeOf 会低于 minSize，档位不许算成负数下标');
  assert.equal(sizeTier(NaN), '小', 'NaN 走 num() 的 0，落在最左边一档而不是 undefined');
  const v = row(cardFor(mk({ size: 34, age: 1000 }), W([mk()])), '体型').value;
  assert.equal(v, '大');
  assert.ok(!/\d/.test(v), `体型那一行漏出了数字：${v}`);
});

test('体型跟着 sizeOf 走 ⇒ 幼体一律"小"，成体期蛋的影响完全消失（§9.2 第 11 条的观察窗口）', () => {
  const smallEgg = mk({ id: 'a', age: 30, stage: 'hatchling', size: 26, eggBoost: -0.2 });
  const bigEgg = mk({ id: 'b', age: 30, stage: 'hatchling', size: 26, eggBoost: 0.2 });
  // 幼体期两只的**真实体型**确实差一截（这就是 §9.2 第 11 条要"并排站"看得到的东西），
  // 但档位词分不出来 —— 档位是三等分，不是差异表。这条断言写清楚这个限度，
  // 免得下一个人以为卡上会告诉他哪只是大蛋孵的（那行是"蛋"，不是"体型"）。
  assert.ok(sizeOf(bigEgg) > sizeOf(smallEgg) * 1.2,
    `fixture 没造出差异：${sizeOf(smallEgg).toFixed(2)} vs ${sizeOf(bigEgg).toFixed(2)}`);
  assert.equal(row(cardFor(smallEgg, W([smallEgg])), '体型').value, '小');
  assert.equal(row(cardFor(bigEgg, W([bigEgg])), '体型').value, '小');
  // 成体期：eggBoost 的 (1−g) 权重归零 ⇒ 两只同档。**必须显式给一个成体年龄**，
  // 沿用默认的 age 200 会两只都是幼体，断言 trivially 成立（Task 2 的 M5 就是这么骗过我的）。
  // 也不用 age 2000：那时 g 已经掉到 0.88（老年收缩），34×0.88 = 29.92 恰好压在 30 那条档界下沿，
  // 测的就成了档位边界有多脆而不是蛋的影响消失了。1000 是峰值（960 之后一点点）。
  const adultBig = mk({ id: 'a', age: 1000, size: 34, eggBoost: 0.2 });
  const adultSmall = mk({ id: 'b', age: 1000, size: 34, eggBoost: -0.2 });
  assert.equal(row(cardFor(adultBig, W([adultBig])), '体型').value, '大',
    '成体先要真的落到"大"这一档，否则下面那句"两只同档"是空的');
  assert.equal(row(cardFor(adultBig, W([adultBig])), '体型').value,
    row(cardFor(adultSmall, W([adultSmall])), '体型').value);
});

test('蛋那一行：色名是中文，且八个蛋色**每一个**都有名字（少一个就吐英文键）', () => {
  const v = row(cardFor(mk({ eggTint: 'macaron-mint' }), W([mk()])), '蛋').value;
  assert.ok(v.includes('薄荷'), v);
  assert.ok(!/macaron/.test(v), `蛋色漏出了英文键：${v}`);
  for (const tint of Object.keys(CONFIG.colors.eggTints)) {
    const one = row(cardFor(mk({ eggTint: tint }), W([mk()])), '蛋').value;
    assert.ok(!one.includes(tint), `蛋色 ${tint} 没有中文名，直接吐了键名`);
    // 只判"不含键名"是不够的：查不到的键会走 DASH 分支，那也不含键名，测试会假绿。
    // 所以还要它**含中文**并且**各不相同**。
    assert.match(one, /[一-龥]/, `蛋色 ${tint} 的中文名没出来：${one}`);
  }
  const names = new Set(Object.keys(CONFIG.colors.eggTints)
    .map((t) => row(cardFor(mk({ eggTint: t }), W([mk()])), '蛋').value));
  assert.equal(names.size, Object.keys(CONFIG.colors.eggTints).length, '两个蛋色撞了同一个名字');
});

test('记住的词：按 uses 排，最多 CONFIG.hud.cardWordsMax 个，没有就「—」', () => {
  assert.equal(row(cardFor(mk({ heard: [] }), W([mk()])), '记住的词').value, '—');
  const heard = [...Array(9)].map((_, i) => ({
    token: `词${i}`, price: 0.5, boundMood: 'calm', boundNeed: 'hunger',
    heardAt: i, lastUsed: i, uses: i + 1,
  }));
  const v = row(cardFor(mk({ heard }), W([mk()])), '记住的词').value;
  assert.equal(v.split('、').length, CONFIG.hud.cardWordsMax);
  assert.ok(v.includes('词8'), 'uses 最多的那个必须在最前');
  assert.ok(!v.includes('词0'), 'uses 最少的那个必须被挤掉');
});

test('记住的词不许带引号或方括号：那是 JSON 泄漏，不是给人看的', () => {
  const heard = [{ token: '吃饭', price: 0.5, boundMood: 'calm', boundNeed: 'hunger',
    heardAt: 1, lastUsed: 1, uses: 3 }];
  const v = row(cardFor(mk({ heard }), W([mk()])), '记住的词').value;
  assert.equal(v, '吃饭');
});

test('title：有名字用名字，缺字段的存档不许显示"undefined"', () => {
  assert.equal(cardFor(mk({ name: '泡泡·三' }), W([mk()])).title, '泡泡·三');
  assert.equal(cardFor(mk({ name: undefined }), W([mk()])).title, '未命名');
  // customName 在这里**不参与**显示：卡上就是它此刻叫什么。它的消费者在 Task 6
  // （同窝去重不许覆盖玩家取的名），不在显示层 —— 没有消费者的字段不许在这层偷用。
});

// ---------------------------------------------------------------- 关系四行

test('relationRowsFor：四行（母亲 / 孩子 / 同胞 / 同伴），每行都是名字而不是 id', () => {
  const mom = mk({ id: 'm1', name: '团团' });
  const sib = mk({ id: 's1', name: '软软', mother: 'm1' });
  const kid = mk({ id: 'k1', name: '朵朵' });
  const pal = mk({ id: 'p1', name: '蜜桃' });
  const me = mk({ id: 'me', name: '泡泡', mother: 'm1', offspring: ['k1'],
    known: [{ id: 'p1', familiarity: 1, affection: 0.7, kinship: 0, role: 'companion' }] });
  const world = W([mom, sib, kid, pal, me]);
  const by = Object.fromEntries(relationRowsFor(me, world).map((r) => [r.label, r.value]));
  assert.deepEqual(Object.keys(by), ['母亲', '孩子', '同胞', '同伴']);
  assert.equal(by['母亲'], '团团');
  assert.equal(by['孩子'], '朵朵');
  assert.equal(by['同胞'], '软软', '同胞没有内核访问器，得扫 world（这是表现层**读**内核，合法）');
  assert.equal(by['同伴'], '蜜桃');
  assert.ok(!JSON.stringify(by).includes('m1') && !JSON.stringify(by).includes('"me"'),
    '行里出现 id = 玩家看到一串没人能读的编号');
});

test('同胞扫描把自己排除；已死的同胞不再列出（它已经在溶散了）', () => {
  const solo = mk({ id: 'z', name: '独', mother: 'm1' });
  assert.equal(relationRowsFor(solo, W([solo])).find((r) => r.label === '同胞').value, '—');
  const other = mk({ id: 'o', name: '另', mother: 'm1' });
  assert.equal(relationRowsFor(solo, W([solo, other])).find((r) => r.label === '同胞').value, '另');
  const dead = mk({ id: 'o', name: '另', mother: 'm1', stage: 'dead', alive: false });
  assert.equal(relationRowsFor(solo, W([solo, dead])).find((r) => r.label === '同胞').value, '—');
});

test('孩子那一行：offspring 里的 id 已经查不到个体时写「—」而不是 undefined', () => {
  const mom = mk({ id: 'm', name: '妈', offspring: ['gone'] });
  assert.equal(relationRowsFor(mom, W([mom])).find((r) => r.label === '孩子').value, '—',
    '孩子死掉并被摘出 creatures 之后，行里不许出现 undefined');
});

test('脏 world / 脏 creature 一律不抛：缺 lineage、缺 memory、creatures 不是数组都要出得来', () => {
  for (const c of [null, undefined, {}, { id: 'x', name: 'x' }]) {
    for (const w of [null, undefined, {}, { creatures: null }, { creatures: [] }]) {
      const rows = relationRowsFor(c, w);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => typeof r.value === 'string' && r.value.length > 0));
    }
  }
});

// ---------------------------------------------------------------- 雷达 / 心形 / 读数 / 年龄

test('radarFor：九维性格一个不多一个不少，轴名是中文，值都在 0..1', () => {
  const pts = radarFor(mk().traits);
  assert.deepEqual(pts.map((p) => p.axis),
    ['大胆', '黏人', '暴躁', '贪吃', '好奇', '好动', '话多', '聪明', '恋巢']);
  assert.equal(pts.length, 9);
  for (const p of pts) assert.ok(p.v >= 0 && p.v <= 1);
  assert.equal(pts.find((p) => p.axis === '黏人').v, 0.8);
});

test('radarFor：缺 personality 的个体出九条 0，而不是抛或短一截', () => {
  assert.equal(radarFor({}).length, 9);
  assert.ok(radarFor(null).every((p) => p.v === 0));
});

test('heartFillFor：好感 −1..1 线性映到 0..1，脏值取"空心"', () => {
  assert.equal(heartFillFor(1), 1);
  assert.equal(heartFillFor(-1), 0);
  assert.equal(heartFillFor(0), 0.5);
  assert.equal(heartFillFor(9), 1);
  assert.equal(heartFillFor(NaN), 0, 'NaN 会让 CSS 宽度整个失效，必须吃掉');
  assert.equal(heartFillFor(undefined), 0, '没被认识过 = 空心，不是半心');
});

test('cardFor.heart 读的是对 PLAYER 的好感，不是对同伴的好感', () => {
  const c = mk({ aff: 0.4, known: [{ id: 'p1', familiarity: 1, affection: 1, kinship: 0, role: 'companion' }] });
  assert.equal(cardFor(c, W([c])).heart, heartFillFor(0.4));
});

test('readoutFor：左上那两个数 + 右上时间', () => {
  const w = W([mk(), mk({ id: 'b' })], { eggs: [{ id: 'e1' }, { id: 'e2' }], foods: [{ id: 'f1' }] });
  assert.deepEqual(readoutFor(w), { population: 2, foods: 1, eggs: 2, timeLabel: '2分05秒' });
});

test('readoutFor 不数溶散中的那一只（它已经不算种群了）', () => {
  const w = W([mk(), mk({ id: 'd', alive: false, dying: 0.3, stage: 'dead' })]);
  assert.equal(readoutFor(w).population, 1);
});

test('readoutFor：脏 world 一律给零而不是抛', () => {
  for (const w of [null, undefined, {}, { creatures: null }]) {
    assert.deepEqual(readoutFor(w), { population: 0, foods: 0, eggs: 0, timeLabel: '—' });
  }
});

test('formatAge：四段刻度，秒位补零（不补的话时间在跳秒时宽度抖动）', () => {
  assert.equal(formatAge(0), '0秒');
  assert.equal(formatAge(59), '59秒');
  assert.equal(formatAge(60), '1分00秒');
  assert.equal(formatAge(65), '1分05秒');
  assert.equal(formatAge(3600), '1时00分');
  assert.equal(formatAge(86400 * 3 + 3600 * 5), '3天05时');
  assert.equal(formatAge(NaN), '—');
  assert.equal(formatAge(-1), '—');
});

// ---- 共享存档的两条读数（§7.5/§7.6，2026-10-29）----

test('saveBadgeFor：全新设备不挂角标，只有**降级**过才挂', () => {
  // 全新设备：backend 是 local，但没有降级过 —— 挂"本地存档"等于告诉玩家共享坏了，
  // 而实际上他只是还没开服务器。
  assert.equal(saveBadgeFor({ backend: 'local', fallbackReason: null }).show, false);
  assert.equal(saveBadgeFor({ backend: 'remote', fallbackReason: null }).show, false);
  // 真降级：两种原因各自的文案
  const down = saveBadgeFor({ backend: 'local', fallbackReason: 'ECONNREFUSED' });
  assert.equal(down.show, true);
  assert.match(down.label, /本地存档/);
  assert.match(down.label, /服务器不可达/);
  const conf = saveBadgeFor({ backend: 'local', fallbackReason: 'conflict' });
  assert.match(conf.label, /冲突/, '冲突降级的角标要说出"冲突"而不是"不可达"');
  // 脏入参不许抛
  assert.equal(saveBadgeFor(null).show, false);
  assert.equal(saveBadgeFor(undefined).show, false);
});

test('conflictNoticeFor：§7.5 原文的两个选项，两个都要有 aria', () => {
  assert.equal(conflictNoticeFor({ conflict: null }).show, false);
  const n = conflictNoticeFor({ conflict: { remoteRevision: 9 } });
  assert.equal(n.show, true);
  assert.match(n.text, /另一台设备/);
  assert.match(n.text, /9/, '要把对面的版本号念出来，不然玩家没法判断哪边更新');
  assert.deepEqual(n.actions.map((a) => a.id).sort(), ['force-mine', 'take-theirs']);
  assert.deepEqual(n.actions.map((a) => a.label), ['加载它的版本', '接管'], '两个按钮的文案就是 §7.5 的两个选项');
  for (const a of n.actions) assert.ok(a.aria && a.aria.length > a.label.length, `${a.id} 的 aria 要带上下文`);
  // 反向：不带 revision 的脏冲突也不许抛出 NaN
  assert.equal(conflictNoticeFor({ conflict: {} }).show, true);
  assert.match(conflictNoticeFor({ conflict: {} }).text, /0/);
});
