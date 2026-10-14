import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, randomGenome } from '../src/genes.js';
import { createRng } from '../src/rng.js';
import { createNeeds } from '../src/needs.js';
import {
  EMOTION_KEYS, EVENT_KINDS,
  createEmotions, computeTargets, update, applyEvent, dominant, secondary,
} from '../src/emotions.js';

const traits = (over = {}) => {
  const t = decode(randomGenome(createRng(1)));
  Object.assign(t.personality, over);
  return t;
};
const calmCtx = { pleasure: 0, provocation: 0, threat: 0, novelty: 0, canBreed: false };

test('情绪向量恰好六个分量，且不含 affection（spec 4.5 注意事项）', () => {
  assert.deepEqual(EMOTION_KEYS, ['joy', 'anger', 'fear', 'curiosity', 'sleepy', 'arousal']);
  assert.ok(!EMOTION_KEYS.includes('affection'), 'affection 属于 memory，不是情绪分量');
  const e = createEmotions();
  assert.deepEqual(Object.keys(e).sort(), [...EMOTION_KEYS].sort());
  for (const v of Object.values(e)) assert.equal(v, 0);
});

test('computeTargets 输出同样的六个键', () => {
  const t = computeTargets(createNeeds(), calmCtx, traits());
  assert.deepEqual(Object.keys(t).sort(), [...EMOTION_KEYS].sort());
  for (const v of Object.values(t)) assert.ok(v >= 0 && v <= 1);
});

test('极度饥饿推高 anger（饿到发脾气）', () => {
  const n = createNeeds();
  n.hunger = 0.9;
  assert.ok(computeTargets(n, calmCtx, traits()).anger > 0, '极饿应产生烦躁');
});

test('不饿时不会平白产生 anger', () => {
  const n = createNeeds();
  n.hunger = 0.1;
  assert.equal(computeTargets(n, calmCtx, traits()).anger, 0);
});

test('精力匮乏推高 sleepy', () => {
  const n = createNeeds();
  n.energy = 0.85;
  assert.ok(computeTargets(n, calmCtx, traits()).sleepy > 0.8);
});

test('安全感匮乏推高 fear', () => {
  const n = createNeeds();
  n.safety = 0.9;
  assert.ok(computeTargets(n, calmCtx, traits()).fear > 0.5);
});

test('threat 情境推高 fear', () => {
  const t = computeTargets(createNeeds(), { ...calmCtx, threat: 1 }, traits());
  assert.ok(t.fear > 0.2);
});

test('bold 高者面对同样威胁更不害怕', () => {
  const ctx = { ...calmCtx, threat: 1 };
  const n = createNeeds();
  n.safety = 0.5;
  const brave = computeTargets(n, ctx, traits({ bold: 1 }));
  const timid = computeTargets(n, ctx, traits({ bold: 0 }));
  assert.ok(brave.fear < timid.fear, `${brave.fear} 应小于 ${timid.fear}`);
});

test('pleasure 情境推高 joy', () => {
  const t = computeTargets(createNeeds(), { ...calmCtx, pleasure: 1 }, traits());
  assert.ok(t.joy > 0.5);
});

test('吃饱也贡献 joy', () => {
  const n = createNeeds();
  n.hunger = 0;
  assert.ok(computeTargets(n, calmCtx, traits()).joy > 0.2);
});

test('novelty 与好奇基因共同推高 curiosity', () => {
  const ctx = { ...calmCtx, novelty: 0.6 };
  const n = createNeeds();
  assert.ok(
    computeTargets(n, ctx, traits({ curious: 1 })).curiosity
    > computeTargets(n, ctx, traits({ curious: 0 })).curiosity,
  );
});

test('canBreed 为 false 时 arousal 恒为 0（幼体与老年不求偶）', () => {
  const n = createNeeds();
  n.hunger = 0;
  n.energy = 0;
  assert.equal(computeTargets(n, calmCtx, traits({ libido: 1 })).arousal, 0);
});

test('canBreed 且状态良好时 arousal > 0', () => {
  const n = createNeeds();
  n.hunger = 0.05;
  n.energy = 0.05;
  const e = computeTargets(n, { ...calmCtx, canBreed: true }, traits({ libido: 0.8 }));
  assert.ok(e.arousal > 0.3, `arousal = ${e.arousal}`);
});

test('libido 基因推高 arousal', () => {
  const n = createNeeds();
  n.hunger = 0.05;
  n.energy = 0.05;
  const ctx = { ...calmCtx, canBreed: true };
  assert.ok(
    computeTargets(n, ctx, traits({ libido: 1 })).arousal
    > computeTargets(n, ctx, traits({ libido: 0 })).arousal,
  );
});

test('饥饿会压制 arousal（饿着肚子不想求偶）', () => {
  const ctx = { ...calmCtx, canBreed: true };
  const fed = createNeeds(); fed.hunger = 0.05; fed.energy = 0.05;
  const starved = createNeeds(); starved.hunger = 0.95; starved.energy = 0.05;
  const t = traits({ libido: 0.8 });
  assert.ok(
    computeTargets(fed, ctx, t).arousal > computeTargets(starved, ctx, t).arousal,
  );
});

test('update 单调趋近目标且不越过（无振荡）', () => {
  const e = createEmotions();
  const target = { ...createEmotions(), joy: 1 };
  let prev = 0;
  for (let i = 0; i < 600; i++) {
    update(e, target, 1 / 60);
    assert.ok(e.joy >= prev - 1e-12, `joy 非单调: ${prev} → ${e.joy}`);
    assert.ok(e.joy <= 1 + 1e-12, `joy 越过目标: ${e.joy}`);
    prev = e.joy;
  }
  assert.ok(e.joy > 0.999, `应几乎到达目标，实际 ${e.joy}`);
});

test('update 向下也单调（生气会慢慢平复）', () => {
  const e = createEmotions();
  e.anger = 0.9;
  const target = { ...createEmotions(), anger: 0 };
  let prev = 0.9;
  for (let i = 0; i < 600; i++) {
    update(e, target, 1 / 60);
    assert.ok(e.anger <= prev + 1e-12, `anger 非单调下降: ${prev} → ${e.anger}`);
    prev = e.anger;
  }
  assert.ok(e.anger < 0.001);
});

test('大 dt 不会导致振荡（min(1, inertia*dt) 的作用）', () => {
  const e = createEmotions();
  const target = { ...createEmotions(), joy: 0.6 };
  for (let i = 0; i < 50; i++) update(e, target, 5);   // 每步 5 秒，远超惯性时间常数
  assert.ok(Math.abs(e.joy - 0.6) < 1e-9, `应稳定在目标值，实际 ${e.joy}`);
});

test('并存向量互不清零（spec 8.1 的硬性要求）', () => {
  const e = createEmotions();
  e.fear = 0.7;
  e.curiosity = 0.4;
  // 目标：joy 升到 1，其余维持原值
  const target = {
    joy: 1, anger: e.anger, fear: e.fear,
    curiosity: e.curiosity, sleepy: e.sleepy, arousal: e.arousal,
  };
  for (let i = 0; i < 60; i++) update(e, target, 1 / 60);
  assert.ok(e.joy > 0.5, 'joy 应上升');
  assert.ok(Math.abs(e.fear - 0.7) < 1e-9, `fear 被误改: ${e.fear}`);
  assert.ok(Math.abs(e.curiosity - 0.4) < 1e-9, `curiosity 被误改: ${e.curiosity}`);
});

test('害怕与好奇可以同时存在（spec 4.5 的关键决定）', () => {
  const e = createEmotions();
  const target = { ...createEmotions(), fear: 0.7, curiosity: 0.4 };
  for (let i = 0; i < 300; i++) update(e, target, 1 / 60);
  assert.ok(e.fear > 0.6 && e.curiosity > 0.35, '两种情绪应并存');
  assert.equal(dominant(e), 'fear');
  assert.equal(secondary(e), 'curiosity');
});

test('applyEvent 立即生效，不被惯性平滑掉', () => {
  const e = createEmotions();
  applyEvent(e, 'startled');
  assert.ok(e.fear > 0.5, '被吓一跳应立刻害怕');
});

test('applyEvent 幅度可被 scale 缩放', () => {
  const a = createEmotions();
  const b = createEmotions();
  applyEvent(a, 'petted');
  applyEvent(b, 'petted', 0.5);
  assert.ok(Math.abs(b.joy - a.joy * 0.5) < 1e-9);
});

test('applyEvent 的结果被 clamp 在 [0,1]', () => {
  const e = createEmotions();
  for (let i = 0; i < 50; i++) applyEvent(e, 'petted');
  assert.ok(e.joy <= 1);
  for (let i = 0; i < 50; i++) applyEvent(e, 'poked');
  for (const [k, v] of Object.entries(e)) assert.ok(v >= 0 && v <= 1, `${k} 越界: ${v}`);
});

test('applyEvent 可以让某分量下降（负冲击）', () => {
  const e = createEmotions();
  e.joy = 0.8;
  applyEvent(e, 'poked');       // poked 含 joy: -0.3
  assert.ok(e.joy < 0.8, 'joy 应被 poked 压低');
});

test('所有 EVENT_KINDS 都在 CONFIG 中有定义且不会抛错', () => {
  assert.deepEqual(
    [...EVENT_KINDS].sort(),
    ['bumped', 'death', 'fed', 'mated', 'petted', 'poked', 'rejected', 'startled'],
  );
  const e = createEmotions();
  for (const kind of EVENT_KINDS) {
    assert.doesNotThrow(() => applyEvent(e, kind), `${kind} 应可用`);
  }
});

test('未知事件名抛错（尽早暴露拼写错误）', () => {
  assert.throws(() => applyEvent(createEmotions(), 'tickled'), /未知情绪事件/);
});

test('dominant 返回最高分量，全 0 返回 null', () => {
  assert.equal(dominant(createEmotions()), null);
  const e = createEmotions();
  e.curiosity = 0.3;
  e.joy = 0.6;
  assert.equal(dominant(e), 'joy');
});

test('secondary 在次高值不足主导一半时返回 null（避免泄漏不成立的情绪）', () => {
  const e = createEmotions();
  e.joy = 0.8;
  e.fear = 0.3;
  assert.equal(secondary(e), null, '0.3 < 0.8/2 = 0.4，不应泄漏');
  e.fear = 0.5;
  assert.equal(secondary(e), 'fear');
});

test('secondary 在没有主导时返回 null', () => {
  assert.equal(secondary(createEmotions()), null);
});

test('secondary 不返回主导本身', () => {
  const e = createEmotions();
  e.joy = 0.9;
  e.fear = 0.8;
  assert.equal(dominant(e), 'joy');
  assert.equal(secondary(e), 'fear');
});

// ===========================================================================
// 以下为交付时**新增**的测试，不在 task-4-brief.md 的用例清单里。
// 每一条都对应一个已被指认的具体缺口，理由逐条写在测试内部注释与
// .superpowers/sdd/task-4-report.md 里，不是为了凑数：
//   1) 事件冲击幅度只有下界/范围断言，没有绝对量级 —— Task 3 的同型缺口
//      （速率表整体乘 13 倍全绿）刚被评审抓过；
//   2) brief 的「互不清零」只覆盖 update()，applyEvent() 重置整个向量
//      不会让任何一条既有用例失败；
//   3) inertia 这个速率常量只有区间约束（600 步后 > 0.999 之类），没有字面量；
//   4) computeTargets 的十三个内联系数全是方向性断言（A > B、> 0.2），
//      整体缩放不会变红；
//   5) update() 究竟改哪个入参没有被钉住（Task 10 会跨帧复用 targets）；
//   6) clamp01 会原样放过 NaN，需要一条长跑断言有限性。
// ===========================================================================

// CONFIG.emotions.eventMagnitude 的字面量副本。**刻意不从 CONFIG 读取** ——
// 读 CONFIG 就是同义反复，常量改成什么断言都跟着变，永远通过（needs.test.js
// 的 PINNED_TRAITS 注释里写过同一条纪律）。
const MAGNITUDES = {
  poked:    { fear: 0.45, anger: 0.25, joy: -0.3 },
  petted:   { joy: 0.4, fear: -0.2 },
  fed:      { joy: 0.3 },
  bumped:   { anger: 0.35, fear: 0.1 },
  rejected: { anger: 0.3, joy: -0.35 },
  mated:    { joy: 0.6 },
  startled: { fear: 0.6 },
  death:    { fear: 0.25, joy: -0.4 },
};

test('八种事件冲击的幅度与正负号被硬编码字面量逐一钉住', () => {
  // 为什么必须有这一条：spec 8.1 对本模块的要求是「事件冲击幅度正确」，
  // 而 brief 的既有用例只给了**下界**（startled 后 fear > 0.5）、**比例**
  // （scale = 0.5 时恰好一半）与**范围**（clamp 在 [0,1]）。把 startled 的
  // 0.6 改成 0.55、把 petted 的 joy 0.4 改成 0.04、把 poked 的 anger 删掉，
  // 全都能通过。这些是纯粹的「手感」常量 —— 戳一下该有多吓人、摸一下该有多开心
  // —— 数量级写错不会让任何测试变红，只会让整个交互节奏悄悄变味。
  //
  // 起点选择是这条测试的全部难点：正冲击从 0.25 起步、负冲击从 0.75 起步，
  // 于是八个事件的所有分量都落在 (0,1) 的**严格内部**，clamp01 不参与运算，
  // 断言到的就是常量本身而不是被边界削平后的残值。这正是 needs.test.js 里
  // 「约 120 秒」那条测试当年犯的错（窗口越过 clamp，于是检验的是 clamp01）。
  // 下面的守卫趟会把「其实已经 clamp 了」当场暴露出来，而不是让量级断言给出
  // 一条误导性的失败。
  assert.deepEqual(
    Object.keys(MAGNITUDES).sort(), [...EVENT_KINDS].sort(),
    '每种事件都必须被字面量钉住；新增事件时请同步更新 MAGNITUDES',
  );

  for (const [kind, deltas] of Object.entries(MAGNITUDES)) {
    const e = createEmotions();
    const expected = {};
    for (const key of EMOTION_KEYS) {
      const d = deltas[key];
      // 未声明的分量播 0.5：这样「事件顺手改了不该改的分量」与
      // 「事件把整个向量重置了」都会露出来（见下面第二条断言）。
      const base = d === undefined ? 0.5 : (d >= 0 ? 0.25 : 0.75);
      e[key] = base;
      expected[key] = d === undefined ? base : base + d;
    }

    // 守卫趟：期望值必须严格在开区间内，否则量级断言会被 clamp 掩盖
    for (const [key, want] of Object.entries(expected)) {
      assert.ok(want > 0 && want < 1,
        `${kind}.${key} 的期望值 ${want} 触及 clamp —— 量级断言失去意义，`
        + '请调整 MAGNITUDES 的基准起点');
    }

    applyEvent(e, kind);

    // 量级趟：与字面量算出的期望逐一 exact 比对。
    // 用 assert.equal 而非容差是刻意且安全的：实现算的是 base + d * 1，
    // 而 d * 1 === d 逐位成立，两边是同一个 IEEE-754 表达式，故必然逐位相等。
    for (const key of EMOTION_KEYS) {
      assert.equal(e[key], expected[key],
        `${kind}.${key}: 实际 ${e[key]}，钉住的期望 ${expected[key]}`);
    }
    // 结构趟：事件不得给情绪对象添键。若 CONFIG 里某个分量名拼错
    // （例如 poked.feAR），实现会安静地写进一个野键，其值为
    // clamp01(undefined + d) = NaN，而真正的 fear 一动不动 ——
    // dominant() 的 > 比较会跳过 NaN，全程不报错。
    assert.deepEqual(Object.keys(e).sort(), [...EMOTION_KEYS].sort(),
      `${kind} 给情绪对象添加了额外键`);
  }
});

test('applyEvent 不清零并存的其他情绪（事件冲击也必须尊重「并存」）', () => {
  // brief 的「并存向量互不清零」只走 update()：它构造目标向量后循环 update，
  // 全程没有调用 applyEvent。因此**若 applyEvent 的实现是先重置整个向量再叠加
  // 增量**（e = createEmotions() 然后写 deltas），那条测试照样全绿 ——
  // 既有的其余事件用例也拦不住：startled 后只断言 fear > 0.5（重置后是 0.6，过）、
  // poked 后只断言 joy < 0.8（重置后是 0，过）、scale 用例两边一起重置（过）、
  // clamp 用例只查范围（过）。
  //
  // 这正是本任务最承重的不变量的另一半：spec 4.5 要的「害怕 0.7 + 好奇 0.4，
  // 即想靠近又不敢」必须能在**挨了一吓之后**依然成立，否则表现层读到的
  // secondary 会在每次事件后闪回 null，「害怕地缩着却还是往前探了一点」
  // 这个读得懂的身体语言就被抹掉了。
  const e = createEmotions();
  e.fear = 0.1;
  e.curiosity = 0.4;
  e.joy = 0.3;              // 刻意低于 curiosity，好让 secondary 仍指向 curiosity
  applyEvent(e, 'startled');          // startled 只声明 fear: 0.6
  assert.ok(Math.abs(e.fear - 0.7) < 1e-12, `fear = ${e.fear}，期望 0.1 + 0.6`);
  assert.equal(e.curiosity, 0.4, 'curiosity 被事件清零了 —— 并存向量失效');
  assert.equal(e.joy, 0.3, 'joy 被事件清零了 —— 并存向量失效');
  assert.equal(dominant(e), 'fear');
  assert.equal(secondary(e), 'curiosity', '0.4 >= 0.7/2，次要情绪应当仍然泄漏得出来');
});

test('惯性系数被字面量钉住：单步趋近比例恰为 inertia × dt（inertia = 1.6）', () => {
  // brief 里 inertia 只被**区间**约束：600 步后要 > 0.999（下界）、
  // 60 步后要 > 0.5（下界）、大 dt 要不振荡（只检验 min(1,·) 饱和）。
  // 把 1.6 改成 1.6×13 = 20.8 或改成 0.16，这些用例全绿 —— 而 inertia 决定的是
  // 「生气会持续一阵再慢慢平复」里的那个"一阵"到底有多长：1.6/s 的时间常数约
  // 0.63s，20.8/s 就变成瞬间切换（情绪读起来像状态机），0.16/s 则是十几秒的
  // 黏滞（挨了戳半天没反应）。这是与 Task 3 的衰减速率完全同型的常量，
  // 按同一条纪律钉住。
  //
  // 短时程 + 未截断：dt = 1/60 使 inertia × dt = 0.0267 远小于 1，min(1,·)
  // 不起作用；从 0 出发、目标 1，单步后 e.joy 就等于 k 本身，字面量可肉眼复核。
  const e = createEmotions();
  const target = { ...createEmotions(), joy: 1 };
  update(e, target, 1 / 60);
  assert.ok(Math.abs(e.joy - 1.6 / 60) < 1e-12,
    `单步 joy = ${e.joy}，钉住的期望 1.6/60 = ${1.6 / 60}`);
  // 其余五个分量必须纹丝不动（目标为 0，当前为 0）
  for (const key of EMOTION_KEYS) {
    if (key !== 'joy') assert.equal(e[key], 0, `${key} 被无关的趋近改动了`);
  }
});

test('computeTargets 的黄金向量：六个分量的全部内联系数被一次钉住', () => {
  // brief 对 computeTargets 的断言全是**方向性**的：joy > 0.5、anger > 0、
  // brave.fear < timid.fear、arousal > 0.3。方向对量级毫无约束力 ——
  // joy 的 0.35/0.65 写成 0.035/0.065、fear 的 0.7 写成 7（靠 clamp 洗回 1）、
  // curiosity 的 p.curious * 0.4 整项删掉，上述断言一条都不会变红。
  // 这一条用完全显式、可手算的输入把六个输出全部写死，于是十三个系数
  // 同时受到绝对约束。
  //
  // 输入刻意不走 decode(randomGenome(...))：那条路径的 personality 由 rng 决定，
  // 期望值无法手算（needs.test.js 的 neutralTraits 注释里写过同一条理由）。
  // 这里只给 computeTargets 实际读取的字段。
  const CASES = [
    {
      name: '六路输入全开',
      needs: { hunger: 0.3, energy: 0.4, social: 0.5, safety: 0.6 },
      ctx: { pleasure: 0.2, provocation: 0.8, threat: 0.5, novelty: 0.7, canBreed: true },
      personality: { bold: 0.9, clingy: 0.1, irritable: 0.2, gluttonous: 0.3, curious: 0.4, libido: 0.6 },
      expect: {
        joy: 0.375,        // satisfied 0.7 × 0.35 + pleasure 0.2 × 0.65 = 0.245 + 0.13
        anger: 0.512,      // provocation 0.8 × (0.55 + irritable 0.2 × 0.45) = 0.8 × 0.64
        fear: 0.5575,      // safety 0.6 × 0.7 + threat 0.5 × (0.5 − bold 0.9 × 0.25) = 0.42 + 0.1375
        curiosity: 0.58,   // novelty 0.7 × 0.6 + curious 0.4 × 0.4 = 0.42 + 0.16
        sleepy: 0.4,       // 直接就是 energy 匮乏度
        arousal: 0.645,    // 0.7 × 0.45 + (1 − 0.4) × 0.3 + libido 0.6 × 0.25 = 0.315 + 0.18 + 0.15
      },
    },
    {
      name: '极饿触发 anger 附加项；canBreed = false 一票门控 arousal',
      needs: { hunger: 0.8, energy: 0, social: 0, safety: 0 },
      ctx: { pleasure: 0, provocation: 0, threat: 0, novelty: 0, canBreed: false },
      personality: { bold: 0.5, clingy: 0.5, irritable: 1, gluttonous: 0.5, curious: 0, libido: 1 },
      expect: {
        joy: 0.07,         // satisfied 0.2 × 0.35
        anger: 0.2,        // provocation 0 使整项归零，只剩「饿到发脾气」的固定 0.2
        fear: 0, curiosity: 0, sleepy: 0,
        arousal: 0,        // libido 拉满也必须是 0：门控优先于基因
      },
    },
    {
      name: 'hunger 恰为 0.7 时不触发附加项（阈值是严格 >）',
      needs: { hunger: 0.7, energy: 0, social: 0, safety: 0 },
      ctx: { pleasure: 0, provocation: 0, threat: 0, novelty: 0, canBreed: false },
      personality: { bold: 0.5, clingy: 0.5, irritable: 0, gluttonous: 0.5, curious: 0, libido: 0 },
      expect: {
        joy: 0.105,        // satisfied 0.3 × 0.35
        anger: 0,          // 0.7 > 0.7 为假 ⇒ 无附加项
        fear: 0, curiosity: 0, sleepy: 0, arousal: 0,
      },
    },
  ];

  // 守卫：第一组的六个期望值必须严格在开区间内，否则 clamp01 会掩盖系数错误。
  // 后两组刻意含 0（门控与阈值分支的期望就是 0），故只守卫第一组。
  for (const [k, v] of Object.entries(CASES[0].expect)) {
    assert.ok(v > 0 && v < 1, `黄金向量 ${k} = ${v} 触及 clamp，量级断言会被掩盖`);
  }

  for (const c of CASES) {
    const t = computeTargets(c.needs, c.ctx, { personality: c.personality });
    assert.deepEqual(Object.keys(t).sort(), [...EMOTION_KEYS].sort(), c.name);
    for (const [k, want] of Object.entries(c.expect)) {
      // 1e-12 容差只吸收 IEEE-754 的最后一两位（例如 1 − 0.7 = 0.30000000000000004），
      // 远小于任何有意义的系数改动。
      assert.ok(Math.abs(t[k] - want) < 1e-12,
        `${c.name} / ${k}: 实际 ${t[k]}，钉住的期望 ${want}`);
    }
  }
});

test('update 只改 emotions，不改 targets（Task 10 会跨帧复用同一个目标向量）', () => {
  // src/needs.js 的模块头把「哪个入参被原地修改」写成了承重契约，因为写错
  // 的失败方式是静默的（c.needs = decay(...) 会把 needs 变成 undefined）。
  // 本模块的 update 是同一形状：原地改第一个入参、返回 undefined。
  // 但第二个入参 targets **不能**被碰 —— Task 10 的典型写法是每帧或每若干帧
  // 算一次目标向量、然后反复 update 趋近它；若 update 顺手写了 targets，
  // 目标会跟着当前值一起漂移，情绪永远追不上也永远不平复，而且没有任何一处报错。
  const targets = { ...createEmotions(), joy: 0.8, fear: 0.3 };
  const snapshot = { ...targets };
  const e = createEmotions();
  for (let i = 0; i < 120; i++) assert.equal(update(e, targets, 1 / 60), undefined);
  assert.deepEqual(targets, snapshot, 'targets 被 update 改动了');
  // 这半条断言只是**防空转**：确认 update 真的动了 emotions，否则上面那条
  // "targets 没变" 会因为 update 根本没执行而恒真。收敛精度不在这里管 ——
  // 120 步后残差是 (1 − 1.6/60)^120 ≈ 3.9%，精确趋近由那两条 600 步用例负责。
  assert.ok(e.joy > 0.5 && e.joy < 0.8, `joy 应已朝 0.8 推进且未越过，实际 ${e.joy}`);
  assert.ok(e.fear > 0.2 && e.fear < 0.3, `fear 应已朝 0.3 推进且未越过，实际 ${e.fear}`);
});

test('长时间混沌驱动后六个分量仍是有限的 [0,1] 数', () => {
  // clamp01 写成 v < 0 ? 0 : v > 1 ? 1 : v，两个比较对 NaN 都是 false，
  // 于是 NaN 会**原样穿过** clamp。一个 NaN 分量不会抛错、不会越界，
  // 只是从此在 dominant()/secondary() 的 > 比较里恒为 false ——
  // 那个分量在表现层永久失去发言权，且全程静默。这与 needs.js 的隐患同型。
  //
  // 按 Task 3 的纪律，这里**不在 60Hz 热路径里加逐帧有限性守卫**（那是白付的
  // 开销），而是用一条长跑测试把「两个 mutator 交替作用数千步之后仍然干净」
  // 这个整体不变量钉住：needs → computeTargets → update → 偶发 applyEvent，
  // 输入全部由固定种子的 rng 驱动，因此可复现。
  //
  // 说实话：在当前实现下这条断言抓不到 NaN（要产生 NaN 得先有实现层面的回归）。
  // 它的价值有两处：一是**报错措辞**（有限性排在范围之前，否则 NaN 会被报成
  // "越界"，诊断信息就丢了 —— 见 needs.test.js 的同款注释）；二是范围断言
  // 确实有探测能力，去掉 applyEvent 里的 clamp01 会让 joy 在五分钟内涨到十几，
  // 当场变红。
  const rng = createRng(0xE7E5);
  const t = decode(randomGenome(rng));
  const needs = createNeeds();
  const e = createEmotions();
  const STEPS = 60 * 60 * 5;                       // 5 分钟模拟时间
  for (let i = 0; i < STEPS; i++) {
    needs.hunger = rng.next();
    needs.energy = rng.next();
    needs.social = rng.next();
    needs.safety = rng.next();
    const ctx = {
      pleasure: rng.next(), provocation: rng.next(), threat: rng.next(),
      novelty: rng.next(), canBreed: rng.chance(0.5),
    };
    update(e, computeTargets(needs, ctx, t), 1 / 60);
    if (rng.chance(0.1)) applyEvent(e, rng.pick(EVENT_KINDS), rng.next());
    for (const [k, v] of Object.entries(e)) {
      assert.ok(Number.isFinite(v), `${k} 在第 ${i} 步变成非有限数: ${v}`);
      assert.ok(v >= 0 && v <= 1, `${k} 在第 ${i} 步越界: ${v}`);
    }
  }
  assert.deepEqual(Object.keys(e).sort(), [...EMOTION_KEYS].sort(), '长跑后键集被改动');
});
