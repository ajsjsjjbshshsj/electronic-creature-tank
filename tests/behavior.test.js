import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { createCreature } from '../src/creature.js';
import { PLAYER_ID, adjust } from '../src/memory.js';
import { INTENTS, MIN_DURATION, decide, scoreAll, begEscalation } from '../src/behavior.js';
import { thresholds } from '../src/personality.js';

let uid = 0;
const mk = (over = {}) => {
  const c = createCreature({
    id: `c${uid++}`, name: 'X', x: 0.5, y: 0.5, age: 600, rng: createRng(500 + uid),
  });
  return Object.assign(c, over);
};

// 一个"什么都没发生"的空场景：没有食物、没有邻居、没有玩家
const emptySenses = (over = {}) => ({
  foods: [], neighbors: [], threats: [], playerHand: null,
    broodScore: 0, population: 4, populationCap: 24, atPopulationCap: false, ...over,
});

const food = (id = 'f1', x = 0.6, y = 0.6, kind = 'algae') => ({
  id, kind, pos: { x, y }, dist: Math.hypot(x - 0.5, y - 0.5),
});

const neighbor = (id, x, y, size, anger = 0) => ({
  id, pos: { x, y }, dist: Math.hypot(x - 0.5, y - 0.5),
  size, stage: 'adult', alive: true, anger,
});

test('INTENTS 覆盖 spec 4.10 的候选集', () => {
  for (const kind of ['forage', 'eat', 'rest', 'socialize', 'brood', 'explore', 'flee', 'beg', 'protest', 'fight', 'mourn', 'idle']) {
    assert.ok(INTENTS.includes(kind), `缺少候选行为 ${kind}`);
  }
});

test('decide 总是返回一个合法 Intent', () => {
  const c = mk();
  const intent = decide(c, emptySenses(), createRng(1));
  assert.ok(intent && typeof intent === 'object');
  assert.ok(INTENTS.includes(intent.kind), `非法 kind: ${intent.kind}`);
  assert.ok(typeof intent.minDuration === 'number' && intent.minDuration > 0);
});

test('Intent 只在需要时携带 targetId / targetPos', () => {
  const c = mk();
  c.needs.hunger = 0.95;
  const intent = decide(c, emptySenses({ foods: [food()] }), createRng(2));
  assert.equal(intent.kind, 'forage');
  assert.equal(intent.targetId, 'f1');
  assert.deepEqual(intent.targetPos, { x: 0.6, y: 0.6 });
});

test('极度饥饿且场上有食物时必选 forage（spec 8.1）', () => {
  for (let i = 0; i < 100; i++) {
    const c = mk();
    c.needs.hunger = 0.98;
    c.emotions.fear = 0;
    const intent = decide(c, emptySenses({ foods: [food('f', 0.5 + i / 1000, 0.6)] }), createRng(i));
    assert.equal(intent.kind, 'forage', `第 ${i} 次种子下未选觅食: ${intent.kind}`);
  }
});

test('极度饥饿但场上没有食物时退化为 explore（找吃的）', () => {
  const c = mk();
  c.needs.hunger = 0.98;
  const intent = decide(c, emptySenses(), createRng(3));
  assert.ok(['explore', 'idle'].includes(intent.kind), `应去探索找食物，实际 ${intent.kind}`);
});

test('forage 选的是最近的食物', () => {
  const c = mk();
  c.needs.hunger = 0.98;
  const senses = emptySenses({
    foods: [food('far', 0.95, 0.95), food('near', 0.52, 0.52), food('mid', 0.7, 0.7)],
  });
  // 重新按 dist 排序（sim 会排好，这里模拟）
  senses.foods.sort((a, b) => a.dist - b.dist);
  assert.equal(decide(c, senses, createRng(4)).targetId, 'near');
});

test('fear 极高且有威胁时选 flee（逃避优先于觅食）', () => {
  const c = mk();
  c.needs.hunger = 0.98;
  c.emotions.fear = 0.95;
  const senses = emptySenses({
    foods: [food()],
    threats: [{ id: 'bully', pos: { x: 0.55, y: 0.5 }, dist: 0.05 }],
  });
  assert.equal(decide(c, senses, createRng(5)).kind, 'flee');
});

test('flee 携带逃离目标位置，且方向远离威胁', () => {
  const c = mk();
  c.emotions.fear = 0.95;
  const threatPos = { x: 0.7, y: 0.5 };
  const senses = emptySenses({ threats: [{ id: 'bully', pos: threatPos, dist: 0.2 }] });
  const intent = decide(c, senses, createRng(6));
  assert.equal(intent.kind, 'flee');
  assert.ok(intent.targetPos, 'flee 必须有目标位置');
  // 逃离方向应使得到威胁的距离变大
  const dBefore = Math.hypot(c.pos.x - threatPos.x, c.pos.y - threatPos.y);
  const dAfter = Math.hypot(intent.targetPos.x - threatPos.x, intent.targetPos.y - threatPos.y);
  assert.ok(dAfter > dBefore, `${dBefore} → ${dAfter} 应在远离`);
});

test('逃离目标不会跑出缸外（clamp 到 [0,1]²）', () => {
  const c = mk();
  c.pos = { x: 0.98, y: 0.98 };
  c.emotions.fear = 0.95;
  const senses = emptySenses({ threats: [{ id: 'b', pos: { x: 0.9, y: 0.9 }, dist: 0.11 }] });
  const intent = decide(c, senses, createRng(7));
  assert.ok(intent.targetPos.x >= 0 && intent.targetPos.x <= 1);
  assert.ok(intent.targetPos.y >= 0 && intent.targetPos.y <= 1);
});

test('精力耗尽时选 rest', () => {
  const c = mk();
  c.needs.energy = 0.98;
  c.needs.hunger = 0.1;
  c.emotions.fear = 0;
  assert.equal(decide(c, emptySenses(), createRng(8)).kind, 'rest');
});

test('困倦压过觅食：又累又饿但更累时选 rest', () => {
  const c = mk();
  c.needs.energy = 0.99;
  c.needs.hunger = 0.6;
  assert.equal(decide(c, emptySenses({ foods: [food()] }), createRng(9)).kind, 'rest');
});

test('社交匮乏且有邻居时选 socialize', () => {
  const c = mk();
  c.needs.social = 0.9;
  c.needs.hunger = 0.1;
  c.needs.energy = 0.1;
  const senses = emptySenses({
    neighbors: [{ id: 'n1', pos: { x: 0.6, y: 0.5 }, dist: 0.1, size: 26, stage: 'adult', alive: true, anger: 0 }],
  });
  const intent = decide(c, senses, createRng(10));
  assert.equal(intent.kind, 'socialize');
  assert.equal(intent.targetId, 'n1');
});

test('社交匮乏但没有邻居时不选 socialize（无对象）', () => {
  const c = mk();
  c.needs.social = 0.95;
  const intent = decide(c, emptySenses(), createRng(11));
  assert.notEqual(intent.kind, 'socialize');
});

test('憋够时间且 arousal 高时选 brood（孤雌，无需对象）', () => {
  const c = mk();
  c.emotions.arousal = 0.9;
  c.needs.hunger = 0.1;
  c.needs.energy = 0.1;
  c.needs.social = 0.1;
  const intent = decide(c, emptySenses({ broodScore: 1.5 }), createRng(12));
  assert.equal(intent.kind, 'brood');
  // brood 没有 targetId：它不走向任何对象，就在原地孵。
  assert.equal(intent.targetId, undefined, 'brood 不该带目标个体');
});

test('broodScore 为 0 时绝不选 brood（上限压制与未憋够的后果传导到行为）', () => {
  // 0 分来自两种情况：没憋够（readiness=0），或 canBreed 不成立（亚成体/老年/死者）。
  // 这里测的是行为层的契约——分数为 0 就不该胜出，与它为什么是 0 无关。
  for (let i = 0; i < 50; i++) {
    const c = mk();
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.1;
    c.needs.energy = 0.1;
    assert.notEqual(decide(c, emptySenses({ broodScore: 0 }), createRng(i)).kind, 'brood');
  }
});

test('broodScore 越高越可能被选中', () => {
  // 分差必须跨在 idle(0.12) 两侧，否则这条会退化成饱和区的空断言
  // （原求偶版测试的注释里记着同一个坑：arousal 取高了就两组全胜、断言反而变红）。
  // brood 分 = broodScore × CONFIG.behavior.broodUrgency(1.5)：
  //   1.0 → 1.5 压倒 idle；0.05 → 0.075 输给 idle ⇒ 200 次里一边倒、一边零。
  const countWith = (score, seedBase) => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const c = mk();
      c.emotions.arousal = 0.05;
      c.needs.social = 0.4;
      const senses = emptySenses({ broodScore: score });
      if (decide(c, senses, createRng(seedBase + i)).kind === 'brood') n++;
    }
    return n;
  };
  const hi = countWith(1.0, 1000), lo = countWith(0.05, 1000);
  assert.ok(hi > lo, `高分应更常被选中：hi=${hi} lo=${lo}`);
  assert.ok(lo === 0, `低分那组应一次都不赢（说明断言不在饱和区）：lo=${lo}`);
});
test('对玩家好感高且手在附近时选 beg（卖萌）', () => {
  const c = mk();
  adjust(c.memory, PLAYER_ID, 0.8, 0.9);
  c.thresholds.playerApproach = 0.7;
  c.emotions.joy = 0.5;
  c.needs.hunger = 0.2;
  const senses = emptySenses({
    playerHand: { pos: { x: 0.55, y: 0.5 }, dist: 0.05, speed: 0.01 },
  });
  const intent = decide(c, senses, createRng(13));
  assert.equal(intent.kind, 'beg');
});

test('对玩家好感为负时不会选 beg（它躲你，不讨好你）', () => {
  for (let i = 0; i < 50; i++) {
    const c = mk();
    adjust(c.memory, PLAYER_ID, -0.9, 0.9);
    c.thresholds.playerApproach = -0.3;
    const senses = emptySenses({
      playerHand: { pos: { x: 0.55, y: 0.5 }, dist: 0.05, speed: 0.01 },
    });
    assert.notEqual(decide(c, senses, createRng(i)).kind, 'beg');
  }
});

test('只认识你、还没喜欢上你时也可能卖萌（familiarity 单独开门）', () => {
  // 这条守的是 beg 的可达性：内核里 affection 只有 beg 自己会累积，
  // 若 beg 只认 affection，它就永远不可能第一次发生。
  const c = mk();
  adjust(c.memory, PLAYER_ID, 0, 0.6);      // 好感 0，但已经认识你了
  c.thresholds.playerApproach = 0.8;
  c.emotions.joy = 0.4;
  c.needs.hunger = 0.2;
  const senses = emptySenses({
    playerHand: { pos: { x: 0.55, y: 0.5 }, dist: 0.05, speed: 0.01 },
  });
  assert.equal(decide(c, senses, createRng(20)).kind, 'beg');
});

test('既不认识也不喜欢时不会卖萌（门槛没有被无条件打开）', () => {
  for (let i = 0; i < 50; i++) {
    const c = mk();
    c.thresholds.playerApproach = 0.9;      // 性格再黏人也不行
    c.emotions.joy = 0.6;
    c.needs.hunger = 0.2;
    const senses = emptySenses({
      playerHand: { pos: { x: 0.55, y: 0.5 }, dist: 0.05, speed: 0.01 },
    });
    assert.notEqual(decide(c, senses, createRng(i)).kind, 'beg');
  }
});

test('playerApproach 为负且手靠近时选 flee（怕你的手）', () => {
  const c = mk();
  c.thresholds.playerApproach = -0.3;
  c.emotions.fear = 0.6;
  adjust(c.memory, PLAYER_ID, -0.9, 0.9);
  const senses = emptySenses({
    playerHand: { pos: { x: 0.52, y: 0.5 }, dist: 0.02, speed: 0.4 },
  });
  assert.equal(decide(c, senses, createRng(14)).kind, 'flee');
});

test('被招惹（anger 高）且肇事者在附近时选 protest 或 fight', () => {
  const c = mk();
  c.traits.size = 26;                 // 显式钉住：体型门槛是 traits.size（基因 14~38）
  c.emotions.anger = 0.9;
  c.thresholds.angerThreshold = 0.2;
  c.emotions.fear = 0;
  const senses = emptySenses({
    neighbors: [{ id: 'rival', pos: { x: 0.55, y: 0.5 }, dist: 0.05, size: 26, stage: 'adult', alive: true, anger: 0.5 }],
    provokerId: 'rival',
  });
  const intent = decide(c, senses, createRng(15));
  assert.ok(['protest', 'fight'].includes(intent.kind), `应抗议或争斗，实际 ${intent.kind}`);
});

test('对方明显更大时选 protest 而非 fight（打得过才打）', () => {
  const c = mk();
  c.traits.size = 20;
  c.emotions.anger = 0.9;
  c.emotions.fear = 0.3;      // 刻意留在主分支的 fear < 0.35 内：他要打，只是打不过
  const senses = emptySenses({
    neighbors: [{ id: 'big', pos: { x: 0.55, y: 0.5 }, dist: 0.05, size: 38, stage: 'adult', alive: true, anger: 0.5 }],
    provokerId: 'big',
  });
  const intent = decide(c, senses, createRng(16));
  assert.notEqual(intent.kind, 'fight', '面对两倍体型的对手不该硬拼');
  // 并且真的退到 protest（而不是退到"什么都不做"）——
  // 否则这条用例只证明了"没打"，没证明体型门槛把它导流到了 protest。
  assert.equal(intent.kind, 'protest', `打不过时应收敛到 protest，实际 ${intent.kind}`);
});

test('mourn > 0 时选 mourn（哀悼压过其他日常行为）', () => {
  const c = mk();
  c.mourn = 4;
  c.needs.hunger = 0.6;
  const intent = decide(c, emptySenses({ foods: [food()] }), createRng(17));
  assert.equal(intent.kind, 'mourn');
});

test('mourn 不压过 flee（哀悼时也会逃命）', () => {
  const c = mk();
  c.mourn = 4;
  c.emotions.fear = 0.95;
  const senses = emptySenses({ threats: [{ id: 'b', pos: { x: 0.55, y: 0.5 }, dist: 0.05 }] });
  assert.equal(decide(c, senses, createRng(18)).kind, 'flee');
});

test('一切平静时选 idle 或 explore，不会卡住', () => {
  const c = mk();
  c.needs.hunger = 0.1;
  c.needs.energy = 0.1;
  c.needs.social = 0.1;
  c.emotions.fear = 0;
  const kinds = new Set();
  for (let i = 0; i < 100; i++) kinds.add(decide(c, emptySenses(), createRng(i)).kind);
  assert.ok(kinds.size > 0);
  for (const k of kinds) assert.ok(['idle', 'explore', 'socialize'].includes(k), `平静时不该 ${k}`);
});

test('curiosity 高时更常选 explore', () => {
  // `0.2 + curious*0.6` 里的 0.2 是**基线**，必须小于 idle 的 0.12 才能让
  // "不探索"这一侧真的存在。0.2 那点好奇心配上 exploreRadius 的下限 0.4，
  // explore = 0.2 × (0.4 + r) 对**所有** r ≥ 0.2 都 ≥ 0.12（r 最低时 0.2×0.6=0.12，
  // 恰好在 idle 之上）—— 于是非好奇组 300 次全部选 explore，`300 > 300` 为假，
  // 断言在测量一个饱和区，两个方向都没有鉴别力。
  // 基线取 0.05 时：好奇组 explore = 0.65 × (0.4 + r) 远高于 0.12（实测 300/300），
  // 非好奇组 explore = 0.05 × (0.4 + r) 低于 0.12（实测 0/300）—— 两侧都真的有鉴别力。
  // 另外一个佐证：真实 tick 流程里平静场景的 curiosity 目标值是 0.06（novelty 0.1
  // ⇒ clamp01(0.1×0.6 + curious×0.4)，curious=0 时），远小于 0.2。
  const count = (curious, seedBase, radius) => {
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const c = mk();
      c.needs.hunger = 0.2; c.needs.energy = 0.2; c.needs.social = 0.2;
      // ⚠️ 写 `c.traits.personality.curious` 是**无效的**：thresholds 在 createCreature
      // 时就由 personality 快照好了（src/creature.js:54），之后再改 traits 不会
      // 影响 `c.thresholds`。所以要让探索半径这条路径真的被测到，
      // 必须直接写 `c.thresholds.exploreRadius`。
      // 原先只写 traits 的那版，把 behavior 里的 `c.thresholds.exploreRadius`
      // 换成任意常量都不会让任何测试变红 —— 半径来自好奇基因这个说法当时是**没有测试支撑**的。
      c.traits.personality.curious = curious;              // 保留：说明"基因"这一侧的意图
      c.thresholds.exploreRadius = radius;                 // 真正生效的那一处
      c.emotions.curiosity = 0.05 + curious * 0.6;
      if (decide(c, emptySenses(), createRng(seedBase + i)).kind === 'explore') n++;
    }
    return n;
  };
  const high = count(1, 2000, 0.85);
  const low = count(0, 2000, 0.25);
  assert.ok(high > low, `好奇者应更常探索，实际 ${high} vs ${low}`);
  // 两侧都要真的有鉴别力：只断言 `high > low` 会被"两组都探索"或"两组都不探索"蒙混
  assert.equal(low, 0, `不好奇就不该探索，实际探索了 ${low}/300 次`);
  assert.equal(high, 300, `好奇者应几乎总在探索，实际只有 ${high}/300`);
  // 半径路径本身必须承重：直接比较 **explore 的效用分**随半径的变化。
  // 不能拿"决策次数"来测：好奇心拉满时 explore 无论半径多少都压倒 idle(0.12)，
  // 两组都是 300/300 —— 那样的断言会恒假（我第一版就是这么写错的）。
  // 分数层面才看得到依赖：若 behavior 不再读 thresholds.exploreRadius，三者会相等。
  const scoreAt = (radius) => {
    const c = mk();
    c.needs.hunger = 0.2; c.needs.energy = 0.2; c.needs.social = 0.2;
    c.thresholds.exploreRadius = radius;
    c.emotions.curiosity = 0.65;
    return scoreAll(c, emptySenses()).explore;
  };
  const sBig = scoreAt(0.85);
  const sMid = scoreAt(0.5);
  const sSmall = scoreAt(0.25);
  assert.ok(sBig > sMid && sMid > sSmall,
    `explore 的分数应随探索半径严格上升：0.85→${sBig}，0.5→${sMid}，0.25→${sSmall}`);
  assert.ok(sBig > 0, '半径路径必须让 explore 得到正分');
});

test('explore 的目标点位移随 exploreRadius 缩放（半径也用于选点，不只用于打分）', () => {
  // exploreRadius 有**两处**用途：一是 explore 的效用分 `(0.4 + t.exploreRadius)`，
  // 二是挑探索目标点时的位移幅度 `rng.range(-1,1) * c.thresholds.exploreRadius`。
  // 上面那条只覆盖了打分那一路 —— 把**选点**那一路换成常量时，40 条测试原本全绿，
  // 于是"半径越大越敢跑远"这件事没有任何测试守着（实测：把选点处的
  // `c.thresholds.exploreRadius` 换成 0.5，全套仍然 40/40）。
  const targetAt = (radius, seed) => {
    const c = mk();
    c.needs.hunger = 0.2; c.needs.energy = 0.2; c.needs.social = 0.2;
    c.emotions.curiosity = 0.9;                       // 确保 explore 胜出
    c.thresholds.exploreRadius = radius;
    const it = decide(c, emptySenses(), createRng(seed));
    assert.equal(it.kind, 'explore', `前置条件：应选 explore，实际 ${it.kind}`);
    return Math.hypot(it.targetPos.x - c.pos.x, it.targetPos.y - c.pos.y);
  };
  // 半径为 0 时目标点必须落在原点上（位移恒为 0）—— 这条对任何种子都成立
  for (let s = 1; s <= 20; s++) {
    assert.ok(targetAt(0, s) < 1e-12, `半径 0 时不该移动（种子 ${s}）`);
  }
  // 半径变大时，位移的**最大值**应随之变大（取多个种子的最大值，避开单次抽样的偶然）
  const maxDisp = (radius) => {
    let m = 0;
    for (let s = 1; s <= 60; s++) m = Math.max(m, targetAt(radius, s));
    return m;
  };
  const small = maxDisp(0.05);
  const big = maxDisp(0.3);
  assert.ok(big > small, `半径 0.3 的最大位移应大于 0.05 的：${big} vs ${small}`);
  assert.ok(small > 0, '半径 0.05 也该真的移动一点（否则 multiply 丢了）');
  // 位移不得超过 radius×√2（两轴各自最多 radius），否则就是没乘半径或乘错了东西
  assert.ok(big <= 0.3 * Math.SQRT2 + 1e-9, `位移不得超过 radius×√2：${big}`);
});

test('固定种子下决策完全可复现（spec 8.1）', () => {
  const build = () => {
    const c = mk();
    c.needs.hunger = 0.6;
    c.needs.social = 0.4;
    c.emotions.curiosity = 0.5;
    return c;
  };
  const senses = emptySenses({
    foods: [food()],
    neighbors: [{ id: 'n', pos: { x: 0.6, y: 0.5 }, dist: 0.1, size: 26, stage: 'adult', alive: true, anger: 0 }],
  });
  // 第二个场景：需求都很低，只剩下 idle(0.12) 与 explore 竞争。
  // 它存在的唯一理由是让 explore **真的赢下一些种子** —— 见下面那条复合断言。
  const calm = mk();
  calm.needs.hunger = 0.1;
  calm.needs.energy = 0.1;
  calm.needs.social = 0.1;
  calm.emotions.curiosity = 0.5;
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    // 第一个场景每次都用 build() 新建（原样的复制），再把 calm 也复核一遍
    const a = decide(build(), senses, createRng(777 + i));
    const b = decide(build(), senses, createRng(777 + i));
    assert.deepEqual(a, b, `种子 ${777 + i} 下决策不可复现`);
    const c1 = decide(calm, emptySenses(), createRng(777 + i));
    const c2 = decide(calm, emptySenses(), createRng(777 + i));
    assert.deepEqual(c1, c2, `平静场景在种子 ${777 + i} 下决策不可复现`);
    seen.add(a.kind);
    seen.add(c1.kind);
  }
  // 复合断言：deepEqual 只有在**目标位置也被比较**时才真的能抓到
  // "同种子不同结果"。若这批状态里全是 decision 不依赖 rng 的意图
  // （forage / eat / brood / protest…），那么 a 与 b 的 kind 必然相同，
  // 连一个把噪声换成模块级计数器的实现都能通过 —— 实测过。
  // 所以要求这套场景里必须出现**至少一个带随机目标位置**的意图
  // （explore 用 rng.range 挑目标点），否则这条用例是在空转。
  assert.ok(seen.has('explore'),
    `这套场景必须能让 explore 胜出（它才真正消费 rng），实际只出现 ${[...seen]}`);
});

test('随机扰动确实存在（同状态不同种子会给出不同选择，避免机械感）', () => {
  const kinds = new Set();
  for (let i = 0; i < 200; i++) {
    const c = mk();
    c.needs.hunger = 0.45;      // 中等：几个候选势均力敌
    c.needs.social = 0.4;
    c.needs.energy = 0.35;
    c.emotions.curiosity = 0.4;
    kinds.add(decide(c, emptySenses({ foods: [food()] }), createRng(i)).kind);
  }
  assert.ok(kinds.size >= 2, `势均力敌时应有分歧，实际只出现 ${[...kinds]}`);
});

test('扰动幅度有限：压倒性需求不会被随机翻盘', () => {
  for (let i = 0; i < 300; i++) {
    const c = mk();
    c.needs.hunger = 0.99;
    c.emotions.fear = 0;
    assert.equal(
      decide(c, emptySenses({ foods: [food()] }), createRng(i)).kind,
      'forage',
      `种子 ${i} 下极度饥饿竟没去觅食`,
    );
  }
});

test('scoreAll 返回所有候选的分数且非负', () => {
  const c = mk();
  c.needs.hunger = 0.5;
  const scores = scoreAll(c, emptySenses({ foods: [food()] }));
  assert.deepEqual(Object.keys(scores).sort(), [...INTENTS].sort());
  for (const [k, v] of Object.entries(scores)) {
    assert.ok(typeof v === 'number' && Number.isFinite(v), `${k} 非法分数: ${v}`);
    assert.ok(v >= 0, `${k} 分数为负: ${v}`);
  }
});

test('scoreAll 是纯函数（不修改 creature，也不修改 senses）', () => {
  const c = mk();
  c.needs.hunger = 0.5;
  const senses = emptySenses({
    foods: [food()],
    neighbors: [neighbor('n', 0.6, 0.5, 26)],
    broodScore: 1.2,
  });
  const beforeC = JSON.stringify({
    needs: c.needs, emotions: c.emotions, intent: c.intent,
    pos: c.pos, thresholds: c.thresholds,
  });
  // 整只生物的完整快照。只比对 needs/emotions/intent/pos 会漏掉
  // mourn / age / resting / memory / lineage 这些字段 —— 一个"顺手把
  // c.mourn 减了 1"或"往 c.memory 里塞了一条"的实现照样能通过。
  const beforeWhole = JSON.stringify(c);
  const beforeS = JSON.stringify(senses);
  scoreAll(c, senses);
  decide(c, senses, createRng(1));
  assert.equal(JSON.stringify({
    needs: c.needs, emotions: c.emotions, intent: c.intent,
    pos: c.pos, thresholds: c.thresholds,
  }), beforeC, 'decide / scoreAll 不得修改 creature 状态');
  assert.equal(JSON.stringify(c), beforeWhole, 'decide / scoreAll 不得修改 creature 的**任何**字段');
  assert.equal(JSON.stringify(senses), beforeS, 'decide / scoreAll 不得修改 senses（只读契约）');
});

test('意图都被锁定足够久，不会每帧重新决策（flee 是唯一豁免）', () => {
  const c = mk();
  const seen = new Set();
  for (const senses of [
    emptySenses(),
    emptySenses({ foods: [food()] }),
    emptySenses({ threats: [{ id: 'b', pos: { x: 0.55, y: 0.5 }, dist: 0.05 }] }),
  ]) {
    for (let i = 0; i < 30; i++) {
      c.emotions.fear = senses.threats.length ? 0.95 : 0;
      const intent = decide(c, senses, createRng(i));
      seen.add(intent.kind);
      if (intent.kind === 'flee') continue;   // 逃命的短锁定由下一条测试单独守
      assert.ok(
        intent.minDuration >= CONFIG.behavior.minIntentDuration * 0.8,
        `${intent.kind} 的 minDuration 过短: ${intent.minDuration}`,
      );
      assert.ok(
        intent.minDuration <= CONFIG.behavior.minIntentDuration * 4,
        `${intent.kind} 的 minDuration 过长，会把生物锁死在一个行为上: ${intent.minDuration}`,
      );
    }
  }
  assert.ok(seen.size >= 2, `这套场景应能触发多种意图，实际只有 ${[...seen]}`);
});

test('flee 的 minDuration 较短（逃命要能随时改向）', () => {
  const c = mk();
  c.emotions.fear = 0.95;
  const senses = emptySenses({ threats: [{ id: 'b', pos: { x: 0.55, y: 0.5 }, dist: 0.05 }] });
  const intent = decide(c, senses, createRng(1));
  assert.equal(intent.kind, 'flee');
  assert.ok(intent.minDuration <= CONFIG.behavior.minIntentDuration,
    `flee 不该被锁定太久: ${intent.minDuration}`);
});

test('贴着食物且饿时选 eat（eat 不是不可达的候选）', () => {
  // ⚠️ 本 Task 原先**没有任何**一条断言 eat 会被选中：`food()` 被塞进很多用例，
  // 但那些用例断言的是别的东西（flee / rest / beg / scoreAll 键集）。
  // 于是 `eat` 的分数被改成恒 0、或门槛从 0.035 收紧到 0.034，
  // 全套测试照样绿 —— 而 spec 4.10 明列「进食」为候选行为，
  // Task 10 的 `case 'eat'` 分支（含 fed 情绪事件与冰晶的 calm 路径）会整体变成死代码。
  // 这里直接钉住"够近 + 够饿 ⇒ 选中 eat"。
  const c = mk();
  c.needs.hunger = 0.9;
  // 距离刻意取 0.01：**贴着食物**，远在 0.035 半径内，是真实觅食抵达后的情形。
  const senses = emptySenses({ foods: [food('f', 0.5 + 0.01, 0.5)] });   // dist = 0.01 < 0.035
  assert.equal(decide(c, senses, createRng(30)).kind, 'eat');
  // 半径本身也要被钉住：把 EAT_DIST 收紧到 0.034 时上面那条**仍然是绿的**
  // （0.01 远在 0.034 内）—— 实测过，这就是本 Task 原先那种"看起来有覆盖、
  // 其实对阈值毫无鉴别力"的真空。所以再补一条贴着**门槛**的：dist 0.034 < 0.035。
  const edge = mk();
  edge.needs.hunger = 0.9;
  assert.equal(decide(edge, emptySenses({ foods: [food('f', 0.5 + 0.034, 0.5)] }), createRng(33)).kind,
    'eat', 'dist = 0.034 仍在 0.035 半径内，应选 eat');
  // 反向：同样的距离但**不饿**时不该选 eat（门槛里的 hunger > 0.05 那半边也要生效）
  const full = mk();
  full.needs.hunger = 0.02;
  assert.notEqual(decide(full, senses, createRng(31)).kind, 'eat');
  // 再反向：很饿但**够不着**时不该选 eat
  const far = mk();
  far.needs.hunger = 0.9;
  const farSenses = emptySenses({ foods: [food('f', 0.6, 0.5)] });       // dist = 0.1 > 0.035
  assert.notEqual(decide(far, farSenses, createRng(32)).kind, 'eat');
});

test('scoreAll 的数值量级被字面量钉住（urgency 权重不是"只要 > 0"就行）', () => {
  // 原有的 `assert.ok(v >= 0)` 是**死断言**：scoreAll 的每个分支都是
  // clamp / Math.max(…, 0) 的乘积或非负字面量，它永远为真。
  // 于是没有任何一条测试钉住过任何 urgency 权重 —— 把 seekFoodUrgency 从 1.6
  // 改成 0.1、或把 idle 的 0.12 改成 0，全套测试照样绿，而生物会变成一缸只会发呆的果冻。
  // （同类问题见 Task 3 的"没有测试钉住任何速率量级"。）
  const c = mk();
  // 把 curiosity 钉成字面量，这样下面的期望值可以手算出来，而不是复读 trait。
  c.traits.personality.curious = 0;
  c.needs.hunger = 0.5;      // 高于普遍阈值：gluttonous 0.5 ⇒ hungerTrigger = 0.55-0.15 = 0.40

  // 空场景下只有 idle 有分：字面量 0.12（兜底基础分）
  assert.equal(scoreAll(c, emptySenses()).idle, 0.12);

  // 饥饿 0.5 且**高于**触发阈值：0.5 × seekFoodUrgency(1.6) × (1 + 0×0.2) = 0.8
  assert.equal(scoreAll(c, emptySenses({ foods: [food()] })).forage, 0.8);
  // 饥饿恰好等于触发阈值时**不**启动（条件是严格大于）—— 这半边也钉住，
  // 否则"贪吃者更早动身"完全可以退化成"永远动身"。
  const atTrigger = mk();
  atTrigger.traits.personality.curious = 0;
  atTrigger.needs.hunger = atTrigger.thresholds.hungerTrigger;
  assert.equal(scoreAll(atTrigger, emptySenses({ foods: [food()] })).forage, 0);
  // 刚好越过阈值一点就必须有分（浮点舍入会被这条抓住，而不是被上面那条掩盖）
  const justOver = mk();
  justOver.traits.personality.curious = 0;
  justOver.needs.hunger = justOver.thresholds.hungerTrigger + 1e-9;
  assert.ok(scoreAll(justOver, emptySenses({ foods: [food()] })).forage > 0);

  // curiosity 的贡献是 **+20%**，不是"某些正数"：
  //   0.6 × seekFoodUrgency 1.6 × (1 + 0.6 × 0.2) = 0.96 × 1.12 = 1.0752
  // 把 0.2 改成 0.4 会得到 0.96 × 1.24 = 1.1904，当场变红。
  //
  // 这里用 1e-12 容差而不是严格相等：1.0752 在二进制里不可精确表示，
  // 实测浮点结果是 1.0752000000000002（差 2.16e-16），严格相等会误报。
  // 容差刻意取到比上一条断言（idle/forage 恰好可精确表示、用 assert.equal）
  // 宽、但远小于"把 0.2 改成 0.4"造成的 0.1152 偏差 —— 松到能掩盖改动的容差
  // 在本项目是要被复查抓的，所以写清这个数量级差。
  const curious = mk();
  curious.traits.personality.curious = 1;
  curious.emotions.curiosity = 0.6;
  curious.needs.hunger = 0.6;
  const forageCurious = scoreAll(curious, emptySenses({ foods: [food()] })).forage;
  assert.ok(Math.abs(forageCurious - 1.0752) < 1e-12,
    `curiosity 的 +20% 贡献应给出 1.0752，实际 ${forageCurious}`);});

test('中等愤怒 + 低恐惧 + 与肇事者近距离时真的会选 fight（fight 不是不可达的候选）', () => {
  // 原有的两条 protest/fight 用例都抓不住 fight 的不可达：
  //   一条接受 ['protest','fight'] 两个答案（protest 分支单独也能让它通过），
  //   另一条只断言 notEqual(kind,'fight')。
  // 于是把 fight 的分支改成恒 0、或把体型门槛收紧到 0.1，两条都仍然是绿的，
  // 而 Task 10 的 `case 'fight'`（贴上去、stopDist 0.03）会整体变成死代码。
  //
  // 这里选的是 brief 公式里 fight **严格胜过** protest 的那一段：两者都取
  //   protest = anger × 1.2 × (1 - fear)
  //   fight   = anger × fightUrgency(1.1) × (1 - 0.2×playerApproach)
  // 愤怒相同、系数相同，所以只比 1.1×(1-0.2p) 与 1.2×(1-f)：
  //   p = -0.5（显著避开玩家的手）、f = 0.3 ⇒ 1.21 vs 0.84，fight 高 44.05%，
  //   高于扰动带来的最大倍率 1.12/0.88 = 1.2727 —— **对全部 500 个种子**成立。
  //   （p = -0.3 时比值降到 1.2 —— 低于 1.2727，实测种子 13 处 protest 会翻盘。
  //     这个"差一点"的边界正是这条用例必须跑满 500 个种子的原因。）
  // fight 的 12 个候选里其余全部为 0（无食物/手/威胁、arousal 0、
  // curiosity 钉 0、energy 0.1、social 0），所以没有任何一项能靠扰动翻盘。
  //
  // ⚠️ `traits.size` 必须显式钉住：它是基因（CONFIG.minSize 14 ~ maxSize 38），
  // 而体型门槛是 `provoker.size <= c.traits.size × 1.25`。对手 22 需要己方
  // traits.size ≥ 17.6 —— 实测 500 个基因组里有 29 个低于这条线（minSize 那侧
  // 的个体会被判成"打不过"），那条断言会在**随机体型**上偶发变红。
  for (let seed = 0; seed < 500; seed++) {
    const c = mk();
    c.traits.size = 26;                   // 与对手 22 的比值 0.846 ≤ 1.25 ⇒ 打得过
    c.traits.personality.curious = 0;
    c.thresholds.playerApproach = -0.5;   // 显著避开玩家的手 ⇒ fight 的乘子最大
    c.thresholds.angerThreshold = 0.2;
    c.needs.hunger = 0.1;
    c.needs.energy = 0.1;
    c.needs.social = 0;
    c.emotions.anger = 0.9;      // 超过 angerThreshold+0.15，两侧都开门
    c.emotions.fear = 0.3;       // < 0.35 ⇒ 敢打
    c.emotions.arousal = 0;
    const senses = emptySenses({
      neighbors: [neighbor('rival', 0.55, 0.5, 22)],   // 22 ≤ 26×1.25 ⇒ 打得过
      provokerId: 'rival',
    });
    const intent = decide(c, senses, createRng(seed));
    assert.equal(intent.kind, 'fight', `种子 ${seed} 下应选 fight，实际 ${intent.kind}`);
    assert.equal(intent.targetId, 'rival', 'fight 必须带上肇事者 id');
  }
});

test('需求只为效用评分提供紧迫度，绝不一票否决（spec 4.4）', () => {
  // spec 4.4 与 Global Constraints 都写明：最匮乏的需求不得否决其他行为。
  // 一个"饥饿过高就把别的候选全部归零"的实现会通过上面所有用例
  // （那些用例看的是饥饿时**确实**选了觅食），所以这条单独守。
  //
  // 场景必须让"非最匮乏需求"的候选有能力胜出，否则这条用例是空转：
  // 饿到 1.0 时 forage 是唯一有分的候选（2.58），无论 veto 与否都必然选它 ——
  // 实测过：把 forage 在 hunger > 0.99 时归零，10 个种子里仍全部是 forage 或 idle。
  // 所以这里放**三个**需求都拉满、且有食物 + 三个邻居的场面：
  // forage(2.58) / rest(2.52) / socialize(1.33) 势均力敌，任何一处被"否决"
  // 都会让结果分布立刻塌缩。
  const senses = emptySenses({
    foods: [food()],
    neighbors: [
      { id: 'n1', pos: { x: 0.6, y: 0.5 }, dist: 0.1, size: 26, stage: 'adult', alive: true, anger: 0 },
      { id: 'n2', pos: { x: 0.4, y: 0.5 }, dist: 0.1, size: 26, stage: 'adult', alive: true, anger: 0 },
      { id: 'n3', pos: { x: 0.5, y: 0.6 }, dist: 0.1, size: 26, stage: 'adult', alive: true, anger: 0 },
    ],
  });
  const kinds = new Set();
  for (let seed = 0; seed < 200; seed++) {
    const c = mk();
    c.needs.hunger = 1;
    c.needs.energy = 1;
    c.needs.social = 1;
    c.needs.safety = 1;
    kinds.add(decide(c, senses, createRng(seed)).kind);
  }
  // 至少两个候选能胜出，且必须包含"非最匮乏需求"对应的那一个 ——
  // 证明其他候选没有被归零
  assert.ok(kinds.size >= 2, `三条需求拉满时仍应有多个候选竞争，实际只有 ${[...kinds]}`);
  assert.ok([...kinds].some((k) => k !== 'forage'),
    `需求不该把其他候选全部否决，实际只出现 ${[...kinds]}`);
  // 只看"有没有非 forage"是不够的：实测过，一个"饥饿 > 0.99 时把 forage 归零"
  // 的 veto 实现仍然能通过上面两条（rest/socialize 顶上来了，kinds 依然 ≥ 2）。
  // 真正的判据是**每个势均力敌的候选都必须能赢** —— forage 自己也一样。
  // 三个候选的分数都在 1.3~2.6 之间，扰动 ±12% 足以让每个都拿到一些种子。
  assert.ok(kinds.has('forage'), `最匮乏的需求对应的行为也必须能被选中，实际只有 ${[...kinds]}`);
  assert.ok(kinds.has('rest'), `休息必须能竞争过觅食，实际只有 ${[...kinds]}`);
});

test('INTENTS 被冻结，且冻结这件事本身被钉住', () => {
  // 只断言内容是不够的：deepEqual 比的是内容与原型、**不是可变性**，
  // 所以摘掉 Object.freeze 不会让任何内容断言变红，之后一次就地改写也无人察觉。
  // （Task 2 的 PATTERNS 就是这样被 .reverse() 静默重排、害得整缸花纹错位的。）
  assert.ok(Object.isFrozen(INTENTS), 'INTENTS 应被冻结');
  assert.throws(() => INTENTS.push('__probe__'), TypeError, 'push 应抛 TypeError');
  assert.throws(() => INTENTS.reverse(), TypeError, 'reverse 应抛 TypeError');
  assert.throws(() => { INTENTS[0] = '__probe__'; }, TypeError, '下标赋值应抛 TypeError');
  // 反向确认：冻结只挡写，不挡读与展开（decide / scoreAll 靠遍历它工作）
  assert.equal([...INTENTS].length, 13);
  assert.deepEqual([...INTENTS], ['forage', 'eat', 'rest', 'socialize', 'brood', 'explore',
    'flee', 'beg', 'hop', 'protest', 'fight', 'mourn', 'idle']);
});

test('每个意图都恰好有一个分数，且键集与 INTENTS 一致（不多不少）', () => {
  // 原测试是 `deepEqual(Object.keys(scores).sort(), [...INTENTS].sort())` ——
  // 它只能抓"少了一个"，抓不到"多了一个但同时也加进了 INTENTS"，
  // 因为那句话的两边会被同一次编辑改掉。
  // Task 6 的字段集就是按"不多不少"钉的，这里同理：把字面量**写在测试里**。
  const c = mk();
  const scores = scoreAll(c, emptySenses({ foods: [food()] }));
  assert.deepEqual(Object.keys(scores).sort(),
    ['beg', 'brood', 'eat', 'explore', 'fight', 'flee',
      'forage', 'hop', 'idle', 'mourn', 'protest', 'rest', 'socialize']);
  assert.equal(Object.keys(scores).length, 13, '恰好 13 个候选，与 INTENTS 一一对应');
  // 每个值都必须是有限数：`Number.isFinite` 必须在范围断言**之前**，
  // 否则 NaN 会被 `NaN >= 0` 为假而误报成"越界"，诊断信息就丢了。
  for (const [k, v] of Object.entries(scores)) {
    assert.ok(Number.isFinite(v), `${k} 非有限数: ${v}`);
    assert.ok(v >= 0, `${k} 应为非负: ${v}`);
  }
  // 每个意图的 minDuration 都必须有限（新加候选若忘了写 MIN_DURATION 会在这里现形）
  // ⚠️ hop 不在表里，见下面那条"为什么 hop 刻意不在 MIN_DURATION 里"。
  for (const kind of INTENTS) {
    if (kind === 'hop') continue;
    assert.ok(Number.isFinite(MIN_DURATION[kind]), `${kind} 缺少 minDuration`);
  }
  // MIN_DURATION 与 INTENTS 必须一一对应（键集相等，不多不少），且它也被冻结
  assert.deepEqual(Object.keys(MIN_DURATION).sort(),
    [...INTENTS].filter((k) => k !== 'hop').sort());
  assert.ok(Object.isFrozen(MIN_DURATION), 'MIN_DURATION 应被冻结');
  assert.throws(() => { MIN_DURATION.eat = 0; }, TypeError, '改锁定时长应抛 TypeError');
  // ⚠️ 每个条目的**量级**必须用硬编码字面量钉住（M = CONFIG.behavior.minIntentDuration = 1.2）。
  // 上面那些 `>= M*0.8` / `<= M*4` 是从 CONFIG 反算的**恒真式**，什么错都抓不到：
  // 实测把 `protest: M` 改成 `M * 50`、`brood: M * 2.0` 改成 `M * 1.0`、
  // `flee: M * 0.4` 改成 `M * 0.01`，40 条测试全部照过。
  // 那正是本 Task 在 scoreAll 上刚修掉的同一类缺陷（"没有测试约束量级，整体错 13 倍也能过"），
  // 只是发生在第二张表上 —— 60 秒的 protest 锁会静默上线。
  // 用容差而不是 assert.equal：`M * 3.3` 在二进制下是 3.9599999999999995，写 3.96 会不等。
  const eq = (k, want, note) => assert.ok(Math.abs(MIN_DURATION[k] - want) < 1e-12,
    `${k} 应为 ${want}（${note}），实际 ${MIN_DURATION[k]}`);
  eq('forage', 1.5, 'M×1.25');
  eq('eat', 1.2, 'M');
  eq('rest', 3.0, 'M×2.5');
  eq('socialize', 2.04, 'M×1.7');
  eq('brood', 2.4, 'M×2.0 —— 中等：孵一窝不是仪式，做完就该起身');
  eq('explore', 2.04, 'M×1.7');
  eq('flee', 0.48, 'M×0.4 —— 刻意最短，逃命要能随时改向');
  eq('beg', 1.5, 'M×1.25');
  // hop 刻意**不在**这张表里（spec §4.7.2 的时长是 0.6/(0.3+activity)，随性格变）。
  // 它若留在表里就是一个永不消费 yet 有限的条目 —— 无消费者的旋钮要撤。
  eq('protest', 1.2, 'M');
  eq('fight', 1.02, 'M×0.85 —— 略短于基准，打斗是短促爆发');
  eq('mourn', 2.04, 'M×1.7');
  eq('idle', 1.5, 'M×1.25');
  // 关系也要钉住（只钉绝对值会漏掉"整体缩放"这类错误被字面量抓住、但关系反了的写法）
  assert.ok(MIN_DURATION.flee < MIN_DURATION.eat, 'flee 必须短于基准');
  // 原来的"court 必须最长（3.3×）"随求偶制删除。brood 刻意只给 2.0×：
  // 孵卵不该像仪式那样把整只锁住，它更该在被打断时起身跑掉。
  assert.ok(MIN_DURATION.brood > MIN_DURATION.flee, '孵卵必须比逃命长（逃命要能随时改向）');
  assert.ok(MIN_DURATION.brood < MIN_DURATION.rest, '孵卵必须比睡觉短');
  assert.ok(MIN_DURATION.fight < MIN_DURATION.protest, 'fight 必须短于 protest');
});

// ==================== 2026-10-20 Task A4：蹦跳 hop ====================

test('hop 的分数随 activity 上升（方向断言）', () => {
  const mkC = (activity) => {
    const c = mk();
    c.emotions.joy = 0.8; c.needs.energy = 0.2;
    c.thresholds.hopWeight = 0.4 + activity * 1.2;   // 与 personality.thresholds 同式
    return c;
  };
  const quiet = scoreAll(mkC(0), emptySenses()).hop;
  const lively = scoreAll(mkC(1), emptySenses()).hop;
  assert.ok(lively > quiet, `好动的 hop 分应更高：${quiet} vs ${lively}`);
});

test('累了就不跳：energy 是唯一变量时 hop 从正分塌到 0', () => {
  // 这条测的是"累了会休息"必须是**涌现**的 —— 公式里没有任何一处写死
  // "energy > X 就不许跳"，只有 (1 − energy) 这个乘子。
  const c = mk();
  c.emotions.joy = 0.9;
  c.thresholds.hopWeight = 1.6;
  assert.ok(scoreAll(c, emptySenses()).hop > 0, '前置条件：精力充沛时必须给分');
  c.needs.energy = 0.75;                       // 只改这一项
  assert.equal(scoreAll(c, emptySenses()).hop, 0, '累到 energy ≥ 0.7 时必须退出竞争');
});

test('joy 低时 hop 不给分（不高兴就不蹦）', () => {
  const c = mk();
  c.needs.energy = 0.05;
  c.thresholds.hopWeight = 1.6;
  c.emotions.joy = 0.2;
  assert.equal(scoreAll(c, emptySenses()).hop, 0);
});

// ---------------------------------------------------------------- 求关注升级链（spec §4.10，Task A4 尾）
//
// "最喜欢主人，想要主人的关注，会做一些自己认为可以吸引主人注意的事"落在这里。
// 它**不是一个新意图**：beg / hop / protest 是同一个动机的三档强度。
// 做成独立 attract 意图的话，beg 与 attract 会在效用评分里互相竞争，
// 出现"它一边卖萌一边生气"的分裂表现。

const ESC = CONFIG.behavior.begEscalate;
const BU = CONFIG.behavior.begUrgency;

// 手在**看得见但摸不到**的距离上：dist 大于 sim 的抚摸门（perceiveRadius×0.5 = 0.14），
// 又小于感知门（perceiveRadius×1.5）。这一档就是"它冲你晃了晃手，但没真的碰你"。
const nearHand = (over = {}) => emptySenses({
  playerHand: { pos: { x: 0.65, y: 0.5 }, dist: 0.15, speed: 0.01 }, ...over,
});

// 一只高兴、不累、正在闹脾气的个体。joy / energy 显式设死，
// 因为 hop 的门是 joy > 0.25 && energy < 0.7，而这两项默认值随机基因的干扰会盖过升级。
const ignored = (begIgnored) => {
  const c = mk({ begIgnored });
  c.emotions.joy = 0.6;
  c.needs.energy = 0.1;
  // ⚠️ hopWeight 必须钉死：mk() 每次调用都重抽一份随机基因，
  // 而 hop 的基分里有它 —— 不钉住的话"s1 − s0"测的是两只不同个体的差异，
  // 不是升级加成。这是本项目第四次踩同一个坑（前三次都在算 std / 配对比较时）。
  c.thresholds.hopWeight = 1.0;
  return c;
};

test('升级到第一级给 hop 的加成 = begEscalate.hopBonus × begUrgency（公式与常数双重钉住）', () => {
  // 基分写成**表达式**而不是字面量 0.81：1.0 × (0.3+0.6) × (1−0.1) 在二进制下是
  // 0.8099999999999999，写 0.81 会不等（personality.test.js 那组为同样的尾巴改用 1e-12 容差；
  // 这里不用容差，因为容差正是"藏错的地方"—— 改成与实现同序的表达式，断言就是精确的）。
  const HOP_BASE = 1.0 * (0.3 + 0.6) * (1 - 0.1);
  const base = scoreAll(ignored(0), nearHand()).hop;
  assert.equal(base, HOP_BASE, '前置条件：基分只能由钉住的 hopWeight/joy/energy 决定');
  const lvl1 = scoreAll(ignored(ESC.hopAfter), nearHand()).hop;
  assert.equal(lvl1, base + ESC.hopBonus * BU, '升级 = 在基分上加上那个**乘**出来的加成');
  assert.equal(ESC.hopBonus * BU, 1.75, '加成必须是 0.25 × 7.0（config.test.js 同步钉这四个数）');
  assert.ok(lvl1 > base, '升级后 hop 的分必须真的变高');
});

test('第二级不再给 hop 加成（出口是替换不是叠加，否则它越被冷落越开心）', () => {
  const lvl2 = scoreAll(ignored(ESC.protestAfter), nearHand());
  assert.equal(lvl2.hop, 1.0 * (0.3 + 0.6) * (1 - 0.1), '到第二级 hop 该退回基分：它已经不打算讨关注了');
  assert.ok(lvl2.protest > lvl2.hop, '第二级必须由 protest 赢过 hop');
});

test('INTENTS 恰好 13 项且含 hop（spec §4.10 的换血把这条算术写死了）', () => {
  // 12 → 13 的推导：删 court（孤雌没有受者）、加 hop 与 brood。
  // spec 早先写过"仍是 13 项"却只算了 −court +hop，漏了 +brood，是 298ddee 修掉的自己的算术错。
  assert.equal(INTENTS.length, 13);
  assert.equal(new Set(INTENTS).size, 13, '不得有重复项');
  for (const kind of ['hop', 'brood']) assert.ok(INTENTS.includes(kind), `缺少 ${kind}`);
  assert.ok(!INTENTS.includes('court'), 'court 应随孤雌制删除');
});

test('第二级才打开 protest 的保底分，而且必须手还在场', () => {
  // 没人在场就不该"背过身生闷气"：那是一只对着空气闹脾气的生物，读起来是坏的。
  assert.equal(scoreAll(ignored(ESC.hopAfter), nearHand()).protest, 0, '第一级还不是抗议');
  assert.equal(scoreAll(ignored(ESC.protestAfter), nearHand()).protest, 1.75);
  assert.equal(scoreAll(ignored(ESC.protestAfter), nearHand()).protest, ESC.protestFloor * BU);
  assert.equal(
    scoreAll(ignored(ESC.protestAfter), emptySenses()).protest, 0,
    '手不在场时第二级不得给出抗议保底分',
  );
});

test('升级判档的四个边界由 CONFIG 的秒数钉住（含两端）', () => {
  const lvl = (s) => begEscalation(mk({ begIgnored: s })).level;
  assert.equal(lvl(0), 0);
  assert.equal(lvl(ESC.hopAfter - 1e-9), 0, '差一点点还不算升级');
  assert.equal(lvl(ESC.hopAfter), 1, '恰好到点就算（>= 而非 >）');
  assert.equal(lvl(ESC.protestAfter - 1e-9), 1);
  assert.equal(lvl(ESC.protestAfter), 2);
  assert.equal(lvl(1e6), 2, '再久也不会冒出第三档');
});

test('累了会休息压过闹脾气：energy ≥ 0.7 时升级加成打不开 hop 的门', () => {
  // 探针敏感性：把 hop 的门控从 `(joy > .25 && energy < 0.7)` 改成
  // 无条件加加成，这条立刻变红 —— 那才是真正在测的东西。
  const c = ignored(ESC.protestAfter);
  c.needs.energy = 0.9;                       // 只改这一项
  assert.equal(scoreAll(c, nearHand()).hop, 0, '累到极点也不该蹦，哪怕它很想要关注');
});

test('begEscalation 的两个加成必须由 CONFIG 常数**相乘**得出（防硬编码）', () => {
  // ⚠️ 这条是**探针逼出来的**：第一版只断言源码里出现 "begEscalate" 与 "begUrgency"
  // 两个词，于是把 `E.hopBonus * U` 改成字面量 `1.75` 之后 386 条全绿 ——
  // 因为函数头那两行 `const E = CONFIG.behavior.begEscalate` 自己就把关键词满足了。
  // 关键词在不在源码里 ≠ 常数有没有被读。所以这里钉的是**乘法形状**本身。
  const src = begEscalation.toString();
  assert.match(src, /hopBonus\s*\*\s*U/, 'hop 加成必须是 hopBonus × begUrgency 的形状');
  assert.match(src, /protestFloor\s*\*\s*U/, 'protest 保底必须是 protestFloor × begUrgency 的形状');
  // 反向确认：这两个旋钮此刻确实等于 config.test.js 钉的那四个数（否则上两条正则
  // 匹配的是一个"值已经错掉"的表达式）。
  assert.equal(ESC.hopBonus * BU, 1.75);
  assert.equal(ESC.protestFloor * BU, 1.75);
});

test('升级到第二级时 protest 会拿到目标点：背对手，而不是贴上去', () => {
  const c = ignored(ESC.protestAfter);
  const intent = decide(c, nearHand(), createRng(7));
  assert.equal(intent.kind, 'protest', `应选抗议，实际 ${intent.kind}`);
  assert.ok(intent.targetPos, '升级来的抗议必须带目标点，否则 executeIntent 立刻作废意图');
  // 背对手 = 目标点在"远离手"的一侧：它在 0.5，手在 0.65，目标必须 ≤ 0.5
  assert.ok(intent.targetPos.x < c.pos.x, `应往手的反方向去：${intent.targetPos.x} vs ${c.pos.x}`);
});

test('第一级的 hop 会把目标点设成手的位置，平时的 hop 没有目标点', () => {
  const calm = decide(ignored(0), nearHand(), createRng(8));
  const escalated = decide(ignored(ESC.hopAfter), nearHand(), createRng(9));
  if (calm.kind === 'hop') {
    assert.equal(calm.targetPos, undefined, '没升级时 hop 是原地蹦，不该追手');
  }
  assert.equal(escalated.kind, 'hop', `升级后应跳到手跟前，实际 ${escalated.kind}`);
  assert.deepEqual(escalated.targetPos, { x: 0.65, y: 0.5 });
});

test('decide 给 hop 的 minDuration 来自 thresholds.hopMinDuration，且随 activity 缩短', () => {
  // 这条守的是**接线**：personality 里那个公式算对了、但 decide 仍然发常数 0.84 的话，
  // 上面所有纯函数测试照过，而"好动的跳得勤"在真实缸里根本不会发生。
  const mkHop = (activity) => {
    const c = mk();
    c.traits.personality.activity = activity;
    c.thresholds = thresholds(c.traits.personality);
    c.emotions.joy = 0.95;
    c.thresholds.hopWeight = 40;          // 让 hop 一定胜出，排除"没选上 hop"的干扰
    c.needs.energy = 0.1;
    return c;
  };
  const calm = decide(mkHop(0), emptySenses(), createRng(5));
  const lively = decide(mkHop(1), emptySenses(), createRng(5));
  assert.equal(calm.kind, 'hop', '前置条件：必须真选中 hop');
  assert.equal(lively.kind, 'hop', '前置条件：必须真选中 hop');
  assert.equal(calm.minDuration, 2.0, 'activity=0 ⇒ 0.6/0.3 = 2.0 秒');
  assert.equal(lively.minDuration, CONFIG.hop.minDurationBase / 1.3, 'activity=1 ⇒ 0.6/1.3');
  assert.ok(lively.minDuration < calm.minDuration, '好动的每次锁定必须更短');
});

test('MIN_DURATION 里没有 hop：它的时长是性格量，不能住在共享常数表里', () => {
  // 记的是**理由**，不是巧合：spec §4.7.2 给的是 0.6/(0.3+activity)。
  // 把它塞进 MIN_DURATION 会有两种坏法 ——
  //   ① 留一个"基准值"当摆设，实际由别处算 ⇒ 无消费者的旋钮（本项目撤过多次）；
  //   ② 让 decide 去查表 ⇒ 所有个体同一个锁定节奏 ⇒ "好动的跳得勤"直接失效。
  assert.ok(!('hop' in MIN_DURATION), 'hop 不该在 MIN_DURATION 里');
  assert.ok(Number.isFinite(thresholds({
    bold: 0.5, clingy: 0.5, irritable: 0.5, gluttonous: 0.5, curious: 0.5, broody: 0.5,
    activity: 0.5, talk: 0.5, intellect: 0.5,
  }).hopMinDuration));
});
