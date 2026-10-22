import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createEmotions, moodOf } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember, PLAYER_ID, affectionFor } from '../src/memory.js';
import { blinkInterval, starRadius } from '../src/body.js';
import {
  eyeParamsFor, eyeParamsInto, eyeAnchorsFor, eyeAnchorsInto,
  blushFor, eyeWidthOf, pupilColor, eyeWhiteColor, blushColor,
} from '../src/eyes.js';

// ===========================================================================
// B15 —— 眼睛（spec §5.1 的第 6 层，spec §4.6 那张十行表）
//
// 这一层**为什么值得写四十条测试**：spec §4.6 说"眼睛是可爱最大的杠杆"，而那张
// 十行表是本物种"看起来是活的"的全部来源。它极易在改别的东西时被顺手弄坏
// （把 joyLid 从 0.30 改成 0.80，开心就不再眯眼了，画面只是"没那么可爱"，
// 没有任何一处会报错）。旧计划把这套映射塞进 render.js，于是只能用桩数调用次数，
// 表里的数值一条都断言不到。本 Task 把它做成 eyes.js 的**纯函数**，
// 数值本身从此可测 —— 这是本文件存在的全部理由。
//
// 诚实边界（与 tests/render-body.test.js 同一套纪律）：
//   桩 ctx 记调用次数与顺序，不记参数值/颜色/像素。所以"眯弧弯得够不够""星星眼
//   是不是真的像一只星""含泪高光在屏上看不看得见"都在手工清单里，本文件不假装能测。
//   本文件测的是**驱动那些画法的数**：lidOpen、lowerLidRaise、pupilSize、starPoints、
//   highlightY、blinkPeriod。数对了，画法才有对错可言。
// ===========================================================================

const E = CONFIG.eye;

// ---------------------------------------------------------------- 夹具
//
// 每个分量都显式给值（借 tests/emotions.test.js 的 blissful() 构造法）：
// 默认 createEmotions() 全 0，任何"某分量恰好等于阈值"的用例都会被别的分量
// 的默认值影响，显式给死才让断言只归因于这一项。
const emo = (over = {}) => Object.assign(createEmotions(), over);
const nee = (over = {}) => Object.assign(createNeeds(), over);
const mem = (affection) => {
  const m = createMemory();
  remember(m, { id: PLAYER_ID, familiarity: 1, affection, kinship: 0, role: null });
  return m;
};

const mk = (o = {}) => ({
  id: o.id === undefined ? 'c-eyes-0' : o.id,
  alive: o.alive === undefined ? true : o.alive,
  dying: o.dying === undefined ? 0 : o.dying,
  mourn: o.mourn === undefined ? 0 : o.mourn,
  intent: o.intent === undefined ? null : o.intent,
  facing: o.facing === undefined ? { x: 1, y: 0 } : o.facing,
  pos: { x: 0.5, y: 0.5 },
  vel: { x: 0, y: 0 },
  emotions: emo(o.emotions),
  needs: nee(o.needs),
  memory: mem(o.aff === undefined ? 0 : o.aff),
  traits: { hue: 330, sat: 0.6, lum: 0.7, wobble: 0.5, glow: 0.6, personality: { activity: o.activity === undefined ? 0.5 : o.activity } },
  thresholds: { angerDuration: 4 },
});

const eye = (o, t = 0, opts) => eyeParamsFor(mk(o), t, opts);
const neutral = () => eye({});

// 一行"什么都好、但对玩家没好感"的人设：joy 拉满也只该是 快乐（^^），不该是 幸福。
const delighted = (over = {}) => eye(Object.assign({ emotions: { joy: 1 }, aff: 0.2 }, over));
// 幸福：joy 高 + 四条需求全低（createNeeds 的出生值本来就全 ≤ blissNeedMax）+ 好感高
const blissful = (over = {}) => mk(Object.assign({ emotions: { joy: 0.75, arousal: 0.4 }, aff: 0.8 }, over));
// 委屈：由 social 一支触发伤心，fear 恒为 0 —— 这样"委屈"与"害怕"的差别不会被污染
const aggrieved = (over = {}) => eye(Object.assign({ needs: { social: 0.85 } }, over));
// 害怕：joy 0.3 让它不落到 伤心 那一档（spec §4.5.1 的 joy < 0.25 门），mood 是 calm
const scared = (over = {}) => eye(Object.assign({ emotions: { fear: 0.95, joy: 0.3 } }, over));

// ============================================================ 四参数与模块契约

test('四参数齐全且连续（spec §4.6："用四个连续参数驱动，不用预设表情"）', () => {
  const p = neutral();
  for (const key of ['pupilSize', 'lidOpen', 'eyeSpacing', 'eyeOffset']) {
    assert.ok(Number.isFinite(p[key]), `${key} 必须是有限数，实测 ${p[key]}`);
  }
  assert.ok(p.pupilSize > 0 && p.pupilSize < 1, '瞳孔大小是 0–1 的连续量，不是档位');
  assert.ok(p.lidOpen > 0 && p.lidOpen <= 1, '眼睑开合是 0–1 的连续量');
  // 连续性判据：joy 从 0 爬到 1 的过程中 lidOpen 必须**逐步**变化，
  // 不许在某个阈值处跳一档（那正是"预设表情"，spec 明文不用）。
  const seen = new Set();
  let prev = neutral().lidOpen;
  for (let j = 0.05; j <= 1.0001; j += 0.05) {
    const v = eye({ emotions: { joy: j, anger: 0.2, fear: 0.1 } }).lidOpen;
    assert.ok(Math.abs(v - prev) <= 0.08, `joy=${j} 处 lidOpen 跳变了 ${prev.toFixed(3)} → ${v.toFixed(3)}`);
    seen.add(v.toFixed(6));
    prev = v;
  }
  assert.ok(seen.size > 8, `20 档 joy 只产出 ${seen.size} 个不同的 lidOpen —— 那不是连续参数`);
});

test('中性态：全开、瞳孔中等、不前后偏移、间距取基准', () => {
  const p = neutral();
  assert.ok(p.lidOpen >= 0.95, `中性应当睁着眼：${p.lidOpen}`);
  assert.ok(p.pupilSize > 0.3 && p.pupilSize < 0.7, `中性瞳孔应当中等：${p.pupilSize}`);
  assert.equal(p.eyeOffset, 0, '中性不前后偏移');
  assert.ok(Math.abs(p.eyeSpacing - E.spacing) < 1e-12, `中性间距应当是基准 ${E.spacing}`);
});

test('十行表里 spec §4.6 **逐字给出**的那七个数是钉死的字面量，不是"跟着 CONFIG 走"的相对断言', () => {
  // 为什么这条必须存在：下面那些行的行为断言写成 |实测 − CONFIG.eye.xxx| < tol 的形式，
  // 它们钉的是"eyes.js 有没有照 CONFIG 算"，而不是"CONFIG 里的数是不是 spec 那个数"。
  // 有人把 happyLid 从 0.30 改成 0.95（开心不再眯眼）时，只有这一条会红。
  // 变异探针 (a) 的全部价值就在这条上。
  assert.equal(CONFIG.eye.happyLid, 0.30, 'spec 逐字："眯成两道上弯弧 ^^，lidOpen ≈ 0.3"');
  assert.equal(CONFIG.eye.sadLid, 0.55, 'spec 逐字："lidOpen ≈ 0.55 但下眼睑上抬"');
  assert.equal(CONFIG.eye.blissPupil, 0.80, 'spec 逐字："pupilSize ≈ 0.8"');
  assert.equal(CONFIG.eye.angerPupil, 0.25, 'spec 逐字："pupilSize ≈ 0.25"');
  assert.equal(CONFIG.eye.fearPupil, 0.15, 'spec 逐字："pupilSize ≈ 0.15"');
  assert.equal(CONFIG.eye.begPupil, 0.95, 'spec 逐字："瞳孔放到最大 ≈ 0.95（婴儿式）"');
  assert.equal(CONFIG.eye.starPoints, 4, 'spec 逐字："瞳孔画成四角星"');
  // 裁定 4 的那条公式里，只有 base 与 activity 地板是 spec 给的
  assert.equal(CONFIG.blink.intervalBase, 4.0, 'spec §11 BLINK_INTERVAL_BASE = 4.0');
  assert.equal(CONFIG.blink.activityFloor, 0.4, 'spec §4.6 第 4 条：base / (0.4 + activity)');
});

test('eyes.js 里不出现 CONFIG.eye 之外的第二份眼睛数值：十行表只能有一处定义', () => {
  const src = stripComments(readFileSync(fileURLToPath(new URL('../src/eyes.js', import.meta.url)), 'utf8'));
  assert.ok(!/\bCONFIG\.mood\.\w+\s*[<>]=?/.test(src),
    'eyes.js 自己拿 CONFIG.mood 的阈值比大小 —— 那是第二个心情定义点（星星眼的稀有性会从两处漂移）');
  assert.ok(/CONFIG\.mood\.happyJoyMin/.test(src),
    '快乐那一格的眯弧幅度需要 happyJoyMin 作为起点，但它只能读阈值、不能判档');
  assert.ok(/moodOf\(/.test(src), '眼睛层必须调 moodOf，而不是自己判心情');
});

test('十行表每一格都真的被 eyes.js 写进返回值（防"某一行整个没实现却全绿"）', () => {
  const p = eyeParamsFor(mk({ emotions: { joy: 1 } }), 0);
  const keys = Object.keys(p).sort();
  for (const need of ['pupilSize', 'lidOpen', 'eyeSpacing', 'eyeOffset', 'lidOpenL', 'lidOpenR',
    'topLidPress', 'lowerLidRaise', 'highlightY', 'star', 'starPoints', 'starSpin', 'starScale',
    'eyeSize', 'squintArc', 'blink', 'blinkPeriod', 'lookX', 'lookY', 'mood']) {
    assert.ok(keys.includes(need), `返回值里缺 ${need} —— 那一格没有输出口，等于没实现`);
  }
});

test('眼睛直径比例从 CONFIG.eyeWidthRatio 读，而它就是 spec §4.6 的 28%', () => {
  // 这条是"不许写字面量"的执行形式：函数返回值必须**就是**那个常量本身。
  assert.equal(eyeWidthOf(), CONFIG.eyeWidthRatio);
  assert.equal(CONFIG.eyeWidthRatio, 0.28, 'spec §4.6 逐字："眼睛大而圆，占身体宽度约 28%"');
});

test('瞳孔用深紫 #2D1240，不用纯黑（spec §4.6 第 3 条新增裁定）', () => {
  assert.equal(pupilColor(), CONFIG.colors.pupil);
  assert.equal(CONFIG.colors.pupil, '#2D1240', '裁定 3：照片里那只"黑眼睛"仍然用 #2D1240 画');
  assert.notEqual(pupilColor().toUpperCase(), '#000000');
  assert.ok(!/^#000(000)?$/i.test(pupilColor()), '纯黑在粉色身体上显得空洞');
  assert.equal(eyeWhiteColor(), CONFIG.colors.eyeWhite);
  assert.equal(blushColor(), CONFIG.colors.blush, '腮红色必须与内核预留的 #FF6B9D 同源');
});

test('eyeParamsFor 是纯函数：同输入同输出，且不改任何入参、不把心情写回 creature', () => {
  const c = mk({ emotions: { joy: 0.7, arousal: 0.3 }, aff: 0.8, mourn: 0 });
  const keysBefore = Object.keys(c).sort().join(',');
  const a = eyeParamsFor(c, 3.5);
  const b = eyeParamsFor(c, 3.5);
  assert.deepEqual(a, b, '同输入必须同输出（随机性一律走注入，眼睛层没有随机源）');
  assert.equal(Object.keys(c).sort().join(','), keysBefore,
    'creature 长出了新键 —— 心情只能每帧现算，不许当状态写回去（spec §4.5.1）');
  assert.equal(c.mood, undefined, 'spec §4.5.1 明文："谁都不许把它当状态写回去，那是刚被否决过的互斥状态机"');
  assert.equal(c.emotions.joy, 0.7);
  assert.equal(affectionFor(c.memory, PLAYER_ID), 0.8, '表现层不得写记忆（写记忆是内核 tickCreature 的职责）');
  assert.equal(Object.values(c.needs).join(','), Object.values(createNeeds()).join(','));
});

test('眼睛参数不读 world：eyes.js 里没有 world 标识符、不 import sim.js，情境只能从 opts 进来', () => {
  const src = stripComments(readFileSync(fileURLToPath(new URL('../src/eyes.js', import.meta.url)), 'utf8'));
  assert.ok(!/\bworld\b/.test(src), 'eyes.js 出现了 world —— 世界状态不该是表现层的输入');
  assert.ok(!/from '\.\/sim\.js'/.test(src), 'eyes.js 不得 import sim.js');
  assert.ok(!/\bsim\b/.test(src));
  // 手的方向由 opts 注入（真实调用时 render.js 从 world.playerHand 算出来再传进来）
  const p = eye({}, 0, { handLocal: { x: 1, y: 0 } });
  assert.ok(p.lookX !== 0 || p.lookY !== 0, '喂了手的方向就必须有瞳孔朝向，否则 opts 这条路是死的');
});

test('eyes.js 源码里没有数值字面量（照 body.js / moodOf 的先例：十行表的数全在 CONFIG.eye）', () => {
  const src = stripComments(readFileSync(fileURLToPath(new URL('../src/eyes.js', import.meta.url)), 'utf8'));
  const decimals = src.match(/(?<![\w$.])\d*\.\d+/g);
  assert.equal(decimals, null, `eyes.js 里出现小数字面量（${decimals && decimals.join(' ')}）—— 请搬进 CONFIG.eye`);
  const sci = src.match(/(?<![\w$.])\d+[eE][-+]?\d+/g);
  assert.equal(sci, null, `eyes.js 里出现科学计数法字面量（${sci && sci.join(' ')}）`);
  const multi = src.match(/(?<![\w$.])\d{2,}(?![\w$])/g);
  assert.equal(multi, null, `eyes.js 里出现多位整数字面量（${multi && multi.join(' ')}）`);
  // 反向防空转：同一条正则在 config.js 里必须数得出来
  assert.ok(stripComments(readFileSync(fileURLToPath(new URL('../src/config.js', import.meta.url)), 'utf8'))
    .match(/(?<![\w$.])\d{2,}(?![\w$])/g), '防空转：扫描器不是摆设');
});

test('eyes.js 不引用任何浏览器 API、不调用 Math.random()（全局纪律在本模块的形式）', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/eyes.js', import.meta.url)), 'utf8');
  const src = stripComments(raw);
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame', 'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `eyes.js 引用了 ${name}`);
  }
  assert.ok(!/Math\.random\s*\(/.test(src), 'eyes.js 不得调用 Math.random()');
  assert.ok(!/'\.\/main\.js'/.test(raw) && !/"\.\/main\.js"/.test(raw), 'eyes.js 不得 import main.js');
});

test('eyeParamsInto 与 eyeParamsFor 共用同一套计算，且前者零分配', () => {
  const c = mk({ emotions: { joy: 0.6, fear: 0.2 }, aff: 0.7, intent: { kind: 'beg' } });
  const out = { pupilSize: 0, lidOpen: 0 };
  const first = eyeParamsInto(out, c, 1.25, { handLocal: { x: 0.4, y: 0.6 } });
  assert.equal(first, out, 'eyeParamsInto 必须写进传入的对象（每帧新建就是 spec §5.3 禁止的运行时分配）');
  assert.deepEqual(eyeParamsInto(out, c, 1.25), eyeParamsFor(c, 1.25),
    '两个入口必须是同一份实现；分成两份就是"测的与跑的不是同一个函数"');
  for (const k of Object.keys(eyeParamsFor(c, 1.25))) {
    assert.ok(k in first, `零分配变体漏了键 ${k}`);
  }
});

test('脏输入不传染 NaN：缺 emotions / needs / memory / traits 也不抛，输出全是有限数', () => {
  // 症状必须是响的而不是静默的：一个 NaN 的 lidOpen 会让整只生物的眼睛消失且不报错。
  const p = eyeParamsFor({}, 0);
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} 是 ${v}`);
  }
  const q = eyeParamsFor(mk({}), NaN);
  assert.ok(Number.isFinite(q.lidOpen) && Number.isFinite(q.blink), 't 是 NaN 时 blink 必须退回 0 而不是 NaN');
  const r = eyeParamsFor(mk({ emotions: { joy: NaN } }), 1);
  assert.ok(Number.isFinite(r.lidOpen) && Number.isFinite(r.pupilSize));
});

// ================================================== 十行表 · 第 1 行 joy 快乐 = ^^

test('joy 快乐：眯成两道上弯弧，lidOpen ≈ 0.30（spec §4.6 逐字给的值）', () => {
  const p = delighted();
  assert.ok(Math.abs(p.lidOpen - E.happyLid) < 0.06,
    `开心的 lidOpen 应当约 ${E.happyLid}（spec 逐字 "lidOpen ≈ 0.3"），实测 ${p.lidOpen.toFixed(3)}`);
  assert.equal(p.mood, 'happy', '前置条件：这个人设判成快乐而不是别的档');
  assert.ok(p.squintArc > 0.6, `要画成 ^^ 就需要"上弯弧"这个读数：${p.squintArc}`);
  assert.ok(p.pupilSize > neutral().pupilSize, '开心时瞳孔应当比中性放大');
  assert.equal(p.star, 0, '快乐不是星星眼（裁定 1：两者分家）');
});

test('joy 的眯法是连续的：joy 越高 lidOpen 越小，且 squintArc 单调上升', () => {
  let prevLid = neutral().lidOpen;
  let prevArc = eye({ emotions: { joy: 0.01 } }).squintArc;
  for (let j = 0.5; j <= 1.0001; j += 0.1) {
    const p = eye({ emotions: { joy: j } });
    assert.ok(p.lidOpen <= prevLid + 1e-9, `joy=${j} 时 lidOpen 应当不回升`);
    assert.ok(p.squintArc >= prevArc - 1e-9, `joy=${j} 时 ^^ 弧度应当不减弱`);
    prevLid = p.lidOpen; prevArc = p.squintArc;
  }
});

// ============================================ 十行表 · 第 2 行 幸福 = 星星眼（稀有）

test('幸福 = 星星眼：pupilSize ≈ 0.80、四角星、要 moodOf 判成 bliss 才出', () => {
  const c = blissful();
  assert.equal(moodOf(c.emotions, c.needs, c.memory, { adversity: c.mourn > 0 }), 'bliss');
  const p = eyeParamsFor(c, 0);
  assert.equal(p.mood, 'bliss');
  assert.ok(p.star > 0, '幸福必须是星星眼');
  assert.ok(Math.abs(p.pupilSize - E.blissPupil) < 0.06,
    `spec 逐字 "pupilSize ≈ 0.8"，实测 ${p.pupilSize.toFixed(3)}`);
  assert.equal(p.starPoints, 4, 'spec 逐字："瞳孔画成**四角星**"');
  assert.equal(p.starPoints, E.starPoints, '角数只能来自 CONFIG.eye.starPoints');
  assert.ok(p.squintArc === 0, '星星眼要睁着才看得见，不能同时是 ^^');
  assert.ok(p.lidOpen > 0.7, `星星眼得露出来：lidOpen=${p.lidOpen}`);
});

test('星星眼随 arousal 轻微旋转与缩放（spec §4.6 那一格的最后半句）', () => {
  const lo = mk({ emotions: { joy: 0.75, arousal: 0 }, aff: 0.8 });
  const hi = mk({ emotions: { joy: 0.75, arousal: 1 }, aff: 0.8 });
  // 扫一个时间窗：arousal 必须真的改变振幅，而"轻微"必须有上界。
  // 不逐点比对而是扫，是因为旋转量是 sin 函数，某一个瞬间恰好为零不是 bug 也不是判据。
  let maxLo = 0, maxHi = 0;
  const scaleHi = new Set();
  const scaleLo = new Set();
  let spinChanges = 0;
  let prevSpin = null;
  for (let i = 0; i < 64; i++) {
    const t = i * 0.11;
    const a = eyeParamsFor(lo, t);
    const b = eyeParamsFor(hi, t);
    maxLo = Math.max(maxLo, Math.abs(a.starSpin));
    maxHi = Math.max(maxHi, Math.abs(b.starSpin));
    scaleLo.add(a.starScale.toFixed(6));
    scaleHi.add(b.starScale.toFixed(6));
    if (prevSpin !== null && Math.abs(b.starSpin - prevSpin) > 1e-9) spinChanges += 1;
    prevSpin = b.starSpin;
    assert.ok(Math.abs(b.starSpin) <= E.starSpinMax + 1e-12, `旋转量超出"轻微"：${b.starSpin}`);
    assert.ok(b.starScale >= 1 - E.starScaleMax && b.starScale <= 1 + E.starScaleMax,
      `缩放超出"轻微"的范围：${b.starScale}`);
  }
  assert.ok(maxHi > maxLo, `arousal 必须驱动旋转/缩放的振幅：${maxLo} → ${maxHi}`);
  assert.equal(maxLo, 0, 'arousal 为零时星不许自己转');
  assert.ok(scaleHi.size > 4, `星要随时间真的在缩放在转，实测只有 ${scaleHi.size} 个取值`);
  assert.ok(scaleLo.size === 1, '没有 arousal 时缩放应当钉在 1');
  assert.ok(spinChanges > 8, `旋转必须随时间连续推进，只变了 ${spinChanges} 次`);
});

test('裁定 1：星星眼的稀有性 —— joy 拉满但缺任何一条幸福判据都不许出星星', () => {
  const M = CONFIG.mood;
  // 四条"joy 已经过 快乐 线"的人设，各自缺 bliss 的一条腿
  const nearMisses = [
    ['对玩家没好感', { emotions: { joy: 1 }, aff: M.blissAffMin - 0.01 }],
    ['有一条需求没过', { emotions: { joy: 1 }, aff: 0.9, needs: { hunger: M.blissNeedMax + 0.2 } }],
    ['刚看过同伴死', { emotions: { joy: 1 }, aff: 0.9, mourn: 3 }],
    ['joy 差一点点', { emotions: { joy: M.blissJoyMin - 0.01, arousal: 0.5 }, aff: 0.9 }],
    ['正在生气（愤怒排在幸福前面）', { emotions: { joy: 1, anger: 0.9 }, aff: 0.9 }],
  ];
  for (const [why, over] of nearMisses) {
    const p = eye(over);
    assert.equal(p.star, 0, `${why}：星星眼不该出现（mood=${p.mood}）`);
    assert.notEqual(p.mood, 'bliss', `${why}：moodOf 也没判成 bliss，两侧必须一致`);
  }
  // 而"什么都不缺 + 依恋玩家"确实出星星 —— 上面的断言不是因为阈值永远够不到
  const got = eye({ emotions: { joy: 0.8, arousal: 0.4 }, aff: 0.9 });
  assert.ok(got.star > 0, '前置条件没搭好：这个人在 spec 的判据下就是幸福');
});

test('星星眼只认 moodOf 这一个定义点：40 个人设逐一断言 star>0 ⇔ moodOf==="bliss"', () => {
  // 这条防的是"表现层自己再写一套 if"（spec §4.5.1：桥只能有一座）。
  // 有人把眼睛层改成 `if (joy > 0.45) star = 1` 的话，本条立刻红，而单看上一条抓不住。
  const joys = [0.2, 0.45, 0.55, 0.62, 0.8, 1];
  const affs = [0, 0.3, 0.61, 0.9];
  const hunger = [0, 0.3];
  let blissCount = 0, total = 0;
  for (const joy of joys) for (const aff of affs) for (const h of hunger) {
    const c = mk({ emotions: { joy }, aff, needs: { hunger: h } });
    const p = eyeParamsFor(c, 0);
    const mood = moodOf(c.emotions, c.needs, c.memory, { adversity: false });
    total += 1;
    if (mood === 'bliss') blissCount += 1;
    assert.equal(p.star > 0, mood === 'bliss', `joy=${joy} aff=${aff} hunger=${h}：眼睛与内核分家了（mood=${mood}）`);
    assert.equal(p.mood, mood);
  }
  assert.ok(blissCount * 2 < total,
    `${blissCount}/${total} 个人设出星星眼 —— 稀有才是奖赏，常态化的星星眼等于没有`);
});

// ================================ 十行表 · 第 3 行 伤心 = 委屈眼（裁定 2 的主场）

test('伤心 = 委屈眼：lidOpen ≈ 0.55 而**下眼睑上抬**、上眼睑不垂（spec 逐字）', () => {
  const p = aggrieved();
  assert.equal(p.mood, 'sad', '前置条件：moodOf 判成伤心');
  assert.ok(Math.abs(p.lidOpen - E.sadLid) < 0.06,
    `spec 逐字 "lidOpen ≈ 0.55"，实测 ${p.lidOpen.toFixed(3)}`);
  assert.ok(p.lowerLidRaise > 0.25, `下眼睑必须上抬（含泪的委屈感全靠它）：${p.lowerLidRaise}`);
  assert.equal(p.topLidPress, 0,
    'spec 逐字："**不是上眼睑下垂**" —— 委屈的眼皮只从下面抬，不许从上面压');
});

test('委屈眼：eyeSpacing 外扩、瞳孔放大且整只后移、高光偏到下缘', () => {
  const p = aggrieved();
  const n = neutral();
  assert.ok(p.eyeSpacing > n.eyeSpacing, `eyeSpacing 必须外扩：${n.eyeSpacing} → ${p.eyeSpacing}`);
  assert.ok(p.pupilSize > n.pupilSize, `瞳孔必须放大：${n.pupilSize} → ${p.pupilSize}`);
  assert.ok(p.eyeOffset < 0, `整只后移（沿 facing 的负偏移）：${p.eyeOffset}`);
  assert.ok(p.highlightY > 0, `高光必须偏到眼睛**下缘**（+y 是屏幕向下）才有含泪感：${p.highlightY}`);
  assert.ok(n.highlightY < 0, '常态高光在**上**缘，与含泪那档必须是两个方向');
});

test('裁定 2：委屈眼 ≠ 害怕 —— 两者被断言**不相同**，不许共用一行', () => {
  const sad = aggrieved();
  const fear = scared();
  assert.equal(fear.mood, 'calm', '前置条件：害怕这一格由 fear 分量驱动，moodOf 并没有判成伤心');
  assert.notDeepEqual(sad, fear);
  // 六个读数至少四项不同（共用一行的话这一条立刻红）
  const keys = ['lidOpen', 'pupilSize', 'eyeSpacing', 'eyeOffset', 'lowerLidRaise', 'topLidPress', 'highlightY', 'eyeSize'];
  const diff = keys.filter((k) => Math.abs(sad[k] - fear[k]) > 1e-6);
  assert.ok(diff.length >= 4, `委屈与害怕只有 ${diff.length} 项不同（${diff.join(',')}），那是同一行的两种写法`);
  // 各自的形状必须对得上 spec 的两句话
  assert.ok(fear.pupilSize < sad.pupilSize, '害怕瞳孔缩到 0.15，委屈瞳孔放大 —— 方向相反');
  assert.ok(fear.lidOpen > sad.lidOpen, '害怕"瞪到最大"，委屈"0.55 半睁"');
  assert.ok(fear.lowerLidRaise === 0, '害怕**没有**下眼睑上抬，那是委屈的形状');
  assert.ok(sad.lowerLidRaise > 0 && fear.eyeSize < sad.eyeSize,
    '害怕是整只收缩，委屈是下眼睑上抬 + 含泪高光');
});

test('害怕归害怕、伤心归伤心：joy 低 + fear 高（moodOf 判成伤心）时画的是委屈而不是瞪圆', () => {
  // 这条是"错的归因"的可执行形式：一只因为怕而 sad 的生物，脸上仍然该是含泪的委屈。
  const p = eye({ emotions: { fear: 0.6, joy: 0.1 } });
  assert.equal(p.mood, 'sad');
  assert.ok(p.lowerLidRaise > 0.2, `mood 是伤心就必须走委屈那一格：${p.lowerLidRaise}`);
  assert.ok(p.pupilSize > 0.4, `不该出现害怕的小瞳孔：${p.pupilSize}`);
  assert.ok(p.highlightY > 0, '含泪高光仍然要在下缘');
});

// ======================================= 十行表 · 第 4/5 行 anger 与 fear

test('anger：瞪圆但上眼睑压低，pupilSize ≈ 0.25，eyeSpacing 内收', () => {
  const p = eye({ emotions: { anger: 1 } });
  const n = neutral();
  assert.ok(Math.abs(p.pupilSize - E.angerPupil) < 0.06,
    `spec 逐字 "pupilSize ≈ 0.25"，实测 ${p.pupilSize.toFixed(3)}`);
  assert.ok(p.topLidPress > 0.25, `上眼睑必须压低（瞪圆≠全开）：${p.topLidPress}`);
  assert.ok(p.eyeSpacing < n.eyeSpacing, `生气时两眼必须内收：${n.eyeSpacing} → ${p.eyeSpacing}`);
  assert.ok(p.lidOpen > 0.7, `anger 是"瞪圆"，不许眯起来：${p.lidOpen}`);
  assert.equal(p.mood, 'anger');
});

test('fear：瞪到最大，pupilSize ≈ 0.15，eyeOffset 沿 facing 后移，整只收缩', () => {
  const p = scared();
  assert.ok(Math.abs(p.pupilSize - E.fearPupil) < 0.05,
    `spec 逐字 "pupilSize ≈ 0.15"，实测 ${p.pupilSize.toFixed(3)}`);
  assert.ok(p.lidOpen >= 0.95, `害怕要瞪到最大：${p.lidOpen}`);
  assert.ok(p.eyeOffset < 0, `害怕时眼睛整只后移：${p.eyeOffset}`);
  assert.ok(p.eyeSize < 1, `害怕是"整只收缩"：${p.eyeSize}`);
  assert.equal(p.lowerLidRaise, 0, '害怕不许有委屈的下眼睑（裁定 2）');
});

test('fear 的收缩不许把瞳孔挤成负数，也压不过 pupilMin', () => {
  const p = eye({ emotions: { fear: 1, anger: 1, sleepy: 1 } });
  assert.ok(p.pupilSize >= E.pupilMin, `瞳孔半径比不得低于 pupilMin：${p.pupilSize}`);
  assert.ok(p.eyeSize > 0.2, `收缩到 ${p.eyeSize} 时眼睛会在屏幕上塌成 0（drawImage/路径退化）`);
  assert.ok(Number.isFinite(p.eyeSpacing) && p.eyeSpacing > 0, `内收过头会让两眼交叉：${p.eyeSpacing}`);
});

// ========================================== 十行表 · 第 6 行 curiosity 不对称

test('curiosity：一只眼睁大一只微眯（左右两个独立的 lidOpen）', () => {
  const p = eye({ emotions: { curiosity: 1 } });
  assert.ok(Number.isFinite(p.lidOpenL) && Number.isFinite(p.lidOpenR),
    '"一只眼睁大一只微眯"需要左右两个独立的开合值，否则无从表达');
  assert.ok(Math.abs(p.lidOpenL - p.lidOpenR) > 0.2,
    `两眼开合差必须明显：${p.lidOpenL.toFixed(3)} vs ${p.lidOpenR.toFixed(3)}`);
  assert.ok(p.eyeOffset > 0, `好奇时前倾（沿 facing 正偏移）：${p.eyeOffset}`);
  assert.ok(p.pupilSize > neutral().pupilSize, 'spec："瞳孔放大"');
  const half = eye({ emotions: { curiosity: 0.5 } });
  assert.ok(Math.abs(half.lidOpenL - half.lidOpenR) > 0.05, 'curiosity=0.5 时不对称应当减半但不消失');
});

// ============================================ 十行表 · 第 7 行 sleepy 半闭慢眨

test('sleepy：半闭，且眨眼极缓慢（周期被拉长而不是频率提高）', () => {
  const p = eye({ emotions: { sleepy: 1 } });
  assert.ok(Math.abs(p.lidOpen - E.sleepyLid) < 0.08, `困倦应当半闭：实测 ${p.lidOpen.toFixed(3)}`);
  assert.ok(p.blinkPeriod > blinkInterval(0.5) * 1.5,
    `困倦的眨眼周期必须比常规**更长**（极缓慢）：${p.blinkPeriod.toFixed(2)} vs ${blinkInterval(0.5).toFixed(2)}`);
  const slow = sampleBlink(mk({ emotions: { sleepy: 1 } }), null);
  const normal = sampleBlink(mk({}), null);
  assert.equal(slow.count, 2, '两个周期应当眨两次');
  assert.ok(slow.peak > 0.9, `困倦时那一次眨眼必须真的闭到底：${slow.peak}`);
  assert.ok(slow.halfSeconds > normal.halfSeconds,
    `"极缓慢地眨"是绝对时长变长：${slow.halfSeconds.toFixed(3)}s vs ${normal.halfSeconds.toFixed(3)}s`);
});

// ================================================ 十行表 · 第 8 行 卖萌

test('卖萌（intent.kind === "beg"）：瞳孔放到最大 0.95（婴儿式）+ 微微上望', () => {
  const p = eye({}, 0, { intentKind: 'beg' });
  const viaIntent = eye({ intent: { kind: 'beg' } });
  assert.ok(Math.abs(p.pupilSize - E.begPupil) < 1e-9, `spec 逐字 "≈ 0.95"，实测 ${p.pupilSize.toFixed(3)}`);
  assert.equal(p.pupilSize, viaIntent.pupilSize, 'opts 注入与读 c.intent 必须同值（两条路都要通）');
  assert.ok(p.pupilSize > neutral().pupilSize, '婴儿式：瞳孔必须比中性大得多');
  assert.ok(p.eyeOffsetY < 0, `向上垂直偏移（屏幕 y 向下为正 ⇒ 上望是负值）：${p.eyeOffsetY}`);
  assert.ok(p.lidOpen > 0.85, `卖萌要睁大眼睛，不许被别的格子压成半闭：${p.lidOpen}`);
});

test('卖萌与困倦同时成立时仍然是卖萌脸（内核的 beg 意图优先于 sleepy 分量）', () => {
  const p = eye({ emotions: { sleepy: 1 } }, 0, { intentKind: 'beg' });
  assert.ok(p.pupilSize > 0.85, `困倦把卖萌的瞳孔压掉的话，spec §9.2 第 1 条"能看到卖萌"就落空了：${p.pupilSize}`);
  assert.ok(p.eyeOffsetY < 0);
});

// ==================================== 十行表 · 第 9 行 信任玩家 = 猫的 slow blink

test('信任玩家：手在附近且好感高时，眨眼被放慢成一次 slow blink', () => {
  const hand = { handLocal: { x: 0.6, y: -0.2 } };
  const loved = eye({ aff: 0.9 }, 0.2, hand);
  const stranger = eye({ aff: 0 }, 0.2, hand);
  const noHand = eye({ aff: 0.9 }, 0.2);
  assert.equal(loved.mood, stranger.mood, '两侧只该差在好感上');
  assert.ok(loved.blinkPeriod > noHand.blinkPeriod * 1.2,
    `慢眨的周期必须比常规长（"缓慢眨一次眼"）：${loved.blinkPeriod.toFixed(2)} vs ${noHand.blinkPeriod.toFixed(2)}`);
  assert.ok(Math.abs(stranger.blinkPeriod - noHand.blinkPeriod) < 1e-12,
    '好感不够就不该有 slow blink，否则"信任"这一格是白写的');
  // 一个周期内**恰好眨一次**（两个周期采样 ⇒ 两次），且慢：闭合窗占的秒数明显更长
  const slowClose = sampleBlink(mk({ aff: 0.9 }), hand);
  const fastClose = sampleBlink(mk({ aff: 0.9 }), null);
  assert.equal(slowClose.count, 2,
    `两个周期必须恰好眨两次 —— slow blink 是"缓慢眨**一次**眼"，不是连眨：实测 ${slowClose.count}`);
  assert.ok(slowClose.halfSeconds > fastClose.halfSeconds,
    `slow blink 的闭眼时长必须比常规长：${slowClose.halfSeconds.toFixed(3)}s vs ${fastClose.halfSeconds.toFixed(3)}s`);
});

test('瞳孔朝玩家的手偏移，且好感低时偏得少（spec §4.6 的"看着玩家的手"的读数部分）', () => {
  const right = { handLocal: { x: 0.5, y: 0 } };
  const loved = eye({ aff: 0.9 }, 0, right);
  const shy = eye({ aff: 0 }, 0, right);
  assert.ok(Math.abs(loved.lookX) > Math.abs(shy.lookX) * 1.5,
    `好感高应当更主动地看手：${loved.lookX.toFixed(3)} vs ${shy.lookX.toFixed(3)}`);
  assert.ok(Math.abs(loved.lookX) <= E.lookMax + 1e-12, `偏移量必须有上界：${loved.lookX}`);
  const none = eye({ aff: 0.9 }, 0, { handLocal: null });
  assert.equal(none.lookX, 0, '手不在时必须回正，否则眼睛会永久斜视');
  assert.equal(none.lookY, 0);
  const behind = eye({ aff: 0.9 }, 0, { handLocal: { x: -1, y: 0 } });
  assert.ok(behind.lookX < 0, '手在身后时瞳孔该往后看（它在看，不是被钉死在前）');
});

// ======================================================= 十行表 · 第 10 行 死亡

test('死亡：眼睛缓缓闭合，lidOpen → 0（spec §4.6 逐字）', () => {
  const justGone = eye({ alive: false, dying: 0, emotions: { joy: 1 } });
  const mid = eye({ alive: false, dying: E.deathCloseSeconds / 2, emotions: { joy: 1 } });
  const shut = eye({ alive: false, dying: E.deathCloseSeconds, emotions: { joy: 1 } });
  assert.ok(justGone.lidOpen > 0.2, `刚断气时眼睛还是睁的，才有"缓缓"可谈：${justGone.lidOpen}`);
  assert.ok(mid.lidOpen < justGone.lidOpen, '闭合必须单调推进');
  assert.equal(shut.lidOpen, 0, '到了闭合秒数就必须精确归零（"缓缓"不等于"永远不闭上"）');
  assert.equal(shut.star, 0, '死了不许还有星星眼');
  assert.equal(shut.squintArc, 0);
  assert.ok(justGone.lidOpen > mid.lidOpen * 1.0001, '闭合过程不许一步到位');
});

test('死亡这一行压过其它一切：卖萌 / 幸福 / 好奇都不能让死掉的眼睛睁开', () => {
  for (const over of [
    { intent: { kind: 'beg' } },
    { emotions: { joy: 1, arousal: 0.5 }, aff: 0.9 },
    { emotions: { curiosity: 1 } },
    { emotions: { fear: 1 } },
  ]) {
    const p = eyeParamsFor(mk(Object.assign({ alive: false, dying: E.deathCloseSeconds * 2 }, over)), 1);
    assert.equal(p.lidOpen, 0, `lidOpen 应当归零，实测 ${p.lidOpen}`);
    // 左右两只都必须归零：画的那一侧是按 lidOpenL/R 决定"要不要画这一层"的，
    // 好奇那格的不对称若不清零，尸体的左眼会留一条 0.048 的缝（真实踩过的坑）。
    assert.equal(p.lidOpenL, 0, `左眼也必须闭上：${p.lidOpenL}`);
    assert.equal(p.lidOpenR, 0, `右眼也必须闭上：${p.lidOpenR}`);
  }
});

// ============================ 裁定 4：眨眼频率成为性格的读出通道（读 body.js 的公式）

test('blinkInterval 只能来自 body.js：同 activity 时周期逐位相等，且 eyes.js 不自己抄公式', () => {
  for (const activity of [0, 0.25, 0.5, 0.75, 1]) {
    const p = eye({ activity });
    assert.ok(Math.abs(p.blinkPeriod - blinkInterval(activity)) < 1e-12,
      `activity=${activity}：眼睛层的眨眼周期应当等于 body.js 的 blinkInterval，实测 ${p.blinkPeriod} vs ${blinkInterval(activity)}`);
  }
  const src = stripComments(readFileSync(fileURLToPath(new URL('../src/eyes.js', import.meta.url)), 'utf8'));
  assert.ok(/from '\.\/body\.js'/.test(src), 'eyes.js 必须 import body.js 的 blinkInterval');
  assert.ok(!/CONFIG\.blink\./.test(src),
    'eyes.js 自己算了一遍 blink 公式 —— 那条公式有两个定义点就会分家（spec §4.6 第 4 条与 §4.7.2 同源）');
});

test('好动的眨眼勤、安静的半天一次：周期随 activity 单调缩短（性格的读出通道）', () => {
  const lazy = eye({ activity: 0 });
  const busy = eye({ activity: 1 });
  assert.ok(busy.blinkPeriod < lazy.blinkPeriod,
    `activity 1 的眨眼间隔必须短于 activity 0：${busy.blinkPeriod} vs ${lazy.blinkPeriod}`);
  assert.ok(busy.blinkPeriod > 0 && Number.isFinite(busy.blinkPeriod), '分母有地板，不许除出 0 或 Infinity');
  // 脏存档给的 activity 越界不许让周期倒着走
  assert.equal(eye({ activity: 9 }).blinkPeriod, busy.blinkPeriod);
});

test('两只生物的眨眼相位不同（否则全缸在同一帧一起眨，像一群机械玩具）', () => {
  const a = eye({ id: 'c-eyes-a' }, 2.0);
  const b = eye({ id: 'c-eyes-b' }, 2.0);
  const phaseOf = (p) => p.phase;
  assert.notEqual(phaseOf(a), phaseOf(b), '同一时刻两只生物该处在眨眼周期的不同位置');
  // 而相位必须是**确定**的：同一个 id 两次调用给同一个相位
  assert.equal(eye({ id: 'c-eyes-a' }, 2.0).phase, a.phase);
  assert.equal(eye({ id: 'c-eyes-a' }, 5.0).phase, a.phase, '相位只能由 id 决定，不许掺时间');
});

// =============================================== 几何：眼睛长在 facing 那一侧

test('眼睛在 facing 一侧、沿垂直于 facing 的方向左右分开（spec §4.6 的坐标定义）', () => {
  const p = neutral();
  const a = eyeAnchorsFor(p, 26, { x: 1, y: 0 });
  // facing = +x：两只眼睛的 x 必须为正（在前半侧），且 y 一正一负（沿垂直方向分开）
  assert.ok(a.lx > 0 && a.rx > 0, `眼睛必须长在 facing 一侧：${a.lx}, ${a.rx}`);
  assert.ok(Math.abs(a.lx - a.rx) < 1e-9, '左右两眼沿 facing 的分量必须相同');
  assert.ok(a.ly * a.ry < 0, `两眼必须分布在 facing 的两侧：${a.ly} vs ${a.ry}`);
  assert.ok(Math.abs(a.ly - a.ry) > 1, '左右分开要有可见的距离');
  // 换朝向：分开的轴跟着转 —— 证明没有把"左右"写死成屏幕 x
  const up = eyeAnchorsFor(p, 26, { x: 0, y: 1 });
  assert.ok(Math.abs(up.ly - up.ry) < 1e-9, 'facing 朝上时两眼该在同一个 y 上');
  assert.ok(up.lx * up.rx < 0, 'facing 朝上时左右分开落到屏幕 x 轴上');
});

test('单只眼睛直径 = 体直径 × CONFIG.eyeWidthRatio（28% 这件事的可测形式）', () => {
  const r = 30;
  const a = eyeAnchorsFor(neutral(), r, { x: 1, y: 0 });
  assert.ok(Math.abs(a.eyeR - r * CONFIG.eyeWidthRatio) < 1e-12,
    `眼半径应当是 ${r * CONFIG.eyeWidthRatio}，实测 ${a.eyeR}`);
  const fear = eyeAnchorsFor(scared(), r, { x: 1, y: 0 });
  assert.ok(fear.eyeR < a.eyeR, '害怕的"整只收缩"要真的把眼睛缩小');
  assert.ok(fear.eyeR > 0, `收缩后的半径必须还是正数：${fear.eyeR}`);
});

test('eyeSpacing / eyeOffset 各自只动该动的那个轴', () => {
  // ⚠️ 0.55 而不是原来的 0.7：F-2 之后眼睛多了一道**径向兜底**（fitK），超出合法范围的
  // spacing 会被沿射线收回，而"收回"必然同时动两个轴 —— 于是"只动一个轴"这条契约的
  // **成立范围是合法参数区间**，不是全体实数。这里探的是合法区间内的上界（表情集合里
  // 最大的是委屈 0.42+0.04 = 0.46），下面另有一条测越界之后发生什么。
  // 改这个数不是放宽判据：契约本身一个字没动，动的是探针落在哪一段。
  const wide = eyeAnchorsFor(Object.assign({}, neutral(), { eyeSpacing: 0.55 }), 26, { x: 1, y: 0 });
  const base = eyeAnchorsFor(neutral(), 26, { x: 1, y: 0 });
  assert.ok(Math.abs(wide.ly) > Math.abs(base.ly), 'eyeSpacing 变大 ⇒ 沿垂直方向分得更开');
  assert.ok(Math.abs(wide.lx - base.lx) < 1e-9, 'eyeSpacing 不许沿 facing 方向挪眼睛');
  const back = eyeAnchorsFor(Object.assign({}, neutral(), { eyeOffset: -0.10 }), 26, { x: 1, y: 0 });
  // ⚠️ 探针从 -0.2 降到 -0.10：那是 F-2 之后**合法区间**的最大后移（就是 sadOffset 本身）。
  // 断言没变（"后移不许越过中心线"），变的只是探针落在哪一段 —— 而这条断言现在同时
  // 反过来约束 CONFIG.eye.forward：forward×2 必须大于最大后移量，否则眼睛会跑到后脑勺。
  assert.ok(back.lx < base.lx, 'eyeOffset 为负 ⇒ 沿 facing 后移');
  assert.ok(back.lx > 0, `后移也不许把眼睛移到中心线的另一侧（那就成了后脑勺）：${back.lx}`);
  const beg = eyeAnchorsFor(eye({ intent: { kind: 'beg' } }), 26, { x: 1, y: 0 });
  assert.ok(beg.ly < base.ly && beg.ry < base.ry, '卖萌的上望是两只眼睛一起往屏幕上方移');
});

test('越界的 spacing 被径向收回而不是把眼甩出本体（F-2 兜底与坐标契约的分工）', () => {
  const r = 26;
  const facing = { x: 1, y: 0 };
  const base = eyeAnchorsFor(neutral(), r, facing);
  const wild = eyeAnchorsFor(Object.assign({}, neutral(), { eyeSpacing: 0.9 }), r, facing);
  const dist = Math.hypot(wild.lx, wild.ly);
  const outline = starRadius(Math.atan2(wild.ly, wild.lx)) * r;
  assert.ok(dist + wild.eyeR <= outline,
    `越界 spacing 也必须把眼盘留在本体内：${(dist + wild.eyeR).toFixed(2)} > ${outline.toFixed(2)}`);
  assert.ok(Math.abs(wild.lx) > Math.abs(base.lx) * 0.5,
    '收回是沿射线的等比缩，facing 方向不该被抹掉（否则脸塌成正中）');
  // 兜底之外还有一条正向的：基准 forward 必须容得下**最大那次后移**，
  // 否则不用兜底出场，眼睛就已经跑到中心线后面去了（= 后脑勺）。
  const maxBackward = Math.max(-CONFIG.eye.sadOffset, -CONFIG.eye.fearOffset);
  assert.ok(CONFIG.eye.forward * 2 > maxBackward,
    `forward×2(${(CONFIG.eye.forward * 2).toFixed(2)}) 必须大于最大后移量(${maxBackward.toFixed(2)})，`
    + '否则那格表情把眼睛挪到脸后面去了');
});

test('eyeAnchorsInto 写进复用对象且与 eyeAnchorsFor 同值（spec §5.3 零分配）', () => {
  const out = { lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 };
  const p = neutral();
  assert.equal(eyeAnchorsInto(out, p, 26, { x: 1, y: 0 }), out);
  assert.deepEqual(out, eyeAnchorsFor(p, 26, { x: 1, y: 0 }));
});

// ---------------------------------------------------------------- F-2：眼盘不许长在本体之外
//
// B20 在**真像素**里量到 8/8 只的眼盘有 9.3–12.4% 落在星形轮廓之外（另有一条像素侧独立
// 印证：6/8 只的其中一只眼外缘 alpha 只有 4–119，而眼心恒 255）。根因不在常量大小，
// 在**方向**：`facing` 那个方向本身就是一根星臂的尖（body.js 的 starRadius(0) = outerRatio），
// 而锚点是"沿 facing 前移 + 垂直分开"，于是两只眼正好落在臂的斜面上 ——
// 那里轮廓正在从内凹的 0.62 往外 1.0 爬，眼盘就探出去了。
//
// 这条把"眼睛长在身体里"写成几何而不是截图：每只眼的圆盘（圆心距 + 眼半径）必须整个落在
// **该方位上真实的星轮廓之内**，并留 ≥ 0.02r 的余量 —— 软体每帧都在抖、跳一下还要 squash，
// 零余量等于"有时候在外面"。九种表情/姿态各测一遍：`eyeSpacing` / `eyeOffset` 那几条
// 修正项（委屈外扩后移、害怕后移、好奇前倾、生气内收）都是把眼睛往边界推的操作。
const F2_R = 40;
const F2_MARGIN = 0.02;                       // × 体半径：留给软体抖动的余量

const eyeDiscsInsideBody = (label, p) => {
  const a = eyeAnchorsInto({ lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 }, p, F2_R, { x: 1, y: 0 });
  const pair = [[a.lx, a.ly, '左'], [a.rx, a.ry, '右']];
  for (const [x, y, which] of pair) {
    const dist = Math.hypot(x, y);
    const outline = starRadius(Math.atan2(y, x)) * F2_R;
    assert.ok(dist + a.eyeR <= outline - F2_MARGIN * F2_R,
      `${label} 的${which}眼飘在本体之外（F-2）：圆心距 ${dist.toFixed(2)} + 眼半径 ${a.eyeR.toFixed(2)}`
      + ` = ${(dist + a.eyeR).toFixed(2)}，而该方位的星轮廓只有 ${outline.toFixed(2)}`
      + `（角 ${(Math.atan2(y, x) * 180 / Math.PI).toFixed(1)}°）`);
  }
  // 同一条测试顺手钉"两只眼不许叠在一起"：把眼睛收回中央团块时，最容易修成斗鸡眼。
  const sep2 = Math.hypot(a.lx - a.rx, a.ly - a.ry);
  assert.ok(sep2 >= a.eyeR * 2,
    `${label} 的两只眼互相重叠（F-2 的反向失败）：圆心距 ${sep2.toFixed(2)} < 两倍眼半径 ${(a.eyeR * 2).toFixed(2)}`);
};

test('眼盘必须整个落在星形本体的轮廓之内（F-2，B20 真像素确认）', () => {
  const cases = [
    ['基准', neutral()],
    ['快乐 ^^', delighted()],
    ['幸福 星星眼', eye({ emotions: { joy: 0.75, arousal: 0.4 }, aff: 0.8 })],
    ['委屈', aggrieved()],
    ['害怕', scared()],
    ['生气', eye({ emotions: { anger: 1 } })],
    ['卖萌', eye({ intent: { kind: 'beg' } })],
    ['困倦', eye({ emotions: { sleepy: 1 } })],
    ['好奇前倾', eye({ emotions: { curiosity: 1 } })],
  ];
  for (const [label, p] of cases) eyeDiscsInsideBody(label, p);
});

// 上面两条测的是"当前这十个表情刚好不出界"。但真正的判据应该是**构造上成立**：
// 表情修正项（委屈外扩、害怕后移、好奇前倾…）是在一个**不随星形旋转**的直角坐标里加的，
// 而轮廓半径是角的非单调函数（36° 是内凹 0.62、72° 又是臂尖 1.0）——
// 于是"改一个常量就把某只眼推到臂外面"是这套加法的固有性质，靠挑常量**永远挑不完**。
// 这条把要求写成：不管修正项被填成什么，眼盘都必须在轮廓之内。
test('修正项被填成任何值，眼盘都必须在轮廓之内（F-2 的构造性版本）', () => {
  const r = 40;
  const facing = { x: 1, y: 0 };
  const wild = [
    ['好奇前倾拉满', { eyeSpacing: 0.42, eyeOffset: 0.60, eyeOffsetY: 0, eyeSize: 1 }],
    ['委屈外扩拉满', { eyeSpacing: 0.95, eyeOffset: -0.40, eyeOffsetY: 0, eyeSize: 1 }],
    ['大眼 + 前倾', { eyeSpacing: 0.50, eyeOffset: 0.30, eyeOffsetY: 0.20, eyeSize: 1 }],
    ['卖萌上望', { eyeSpacing: 0.42, eyeOffset: 0.10, eyeOffsetY: -0.30, eyeSize: 1 }],
    ['害怕后移收缩', { eyeSpacing: 0.42, eyeOffset: -0.55, eyeOffsetY: 0, eyeSize: 0.45 }],
  ];
  for (const [label, p] of wild) {
    const a = eyeAnchorsInto({ lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 }, p, r, facing);
    for (const [x, y, which] of [[a.lx, a.ly, '左'], [a.rx, a.ry, '右']]) {
      const dist = Math.hypot(x, y);
      const outline = starRadius(Math.atan2(y, x)) * r;
      assert.ok(dist + a.eyeR <= outline,
        `${label}：${which}眼出界（F-2）${(dist + a.eyeR).toFixed(2)} > ${outline.toFixed(2)}`);
    }
  }
});

// 上面那条只测了 facing = +x 的一只眼。角度是这套几何里唯一的"陷阱变量"
// （轮廓半径是角的函数，而 facing 与星臂的相对朝向恒定），所以再换 facing 扫一圈：
// 换朝向时眼睛与星臂是**一起转**的（render.js 用同一个 facing 旋转本体点与锚点），
// 因此这一条测的是"实现没有偷偷只用 x 分量"。
test('换任意 facing 朝向，眼盘仍然整个在本体内（F-2 的旋转不变性）', () => {
  for (let k = 0; k < 12; k++) {
    const ang = k * Math.PI / 6;
    const facing = { x: Math.cos(ang), y: Math.sin(ang) };
    const a = eyeAnchorsInto({ lx: 0, ly: 0, rx: 0, ry: 0, eyeR: 0 }, neutral(), F2_R, facing);
    for (const [x, y] of [[a.lx, a.ly], [a.rx, a.ry]]) {
      // 锚点是相对体心的位移；本体点在同一帧里也被同一个 facing 旋转，
      // 所以"眼在身体的哪个方位"与 facing 无关 —— 把绝对角减去 facing 角才是该查的那个角。
      const local = Math.atan2(y, x) - ang;
      const dist = Math.hypot(x, y);
      const outline = starRadius(local) * F2_R;
      assert.ok(dist + a.eyeR <= outline - F2_MARGIN * F2_R,
        `facing ${Math.round(ang * 180 / Math.PI)}° 时眼盘出界：${(dist + a.eyeR).toFixed(2)} > ${outline.toFixed(2)}`);
    }
  }
});

// ==================================================== 腮红（第 6 层的后半格）

test('腮红随 joy 变浓，卖萌那一档最浓，且有上限（spec §4.5 "卖萌"行："腮红泛开"）', () => {
  const n = blushFor(mk({}));
  const j = blushFor(mk({ emotions: { joy: 1 } }));
  const beg = blushFor(mk({ intent: { kind: 'beg' } }));
  assert.ok(j.alpha > n.alpha, `开心时腮红必须更明显：${n.alpha} → ${j.alpha}`);
  assert.ok(beg.alpha > j.alpha, `卖萌必须最明显（spec §4.5 的卖萌行）：${j.alpha} → ${beg.alpha}`);
  for (const b of [n, j, beg]) {
    assert.ok(b.alpha > 0 && b.alpha <= E.blushMax, `腮红 alpha 必须有界：${b.alpha}`);
    assert.ok(b.radius > 0 && b.offsetPerp > 0, '没有半径或位置的腮红等于没画');
  }
  assert.equal(blushFor(mk({ alive: false, dying: 2 })).alpha, 0, '尸体不该泛腮红');
});

// ============================================== 泄漏：次要情绪不许被抹掉

test('次要情绪会泄漏：委屈的同时还留着一点好奇的前倾', () => {
  // spec §4.5："表现由主导情绪决定，但次要情绪会泄漏出来"。
  // 十行表若被实现成"取主导那一行、其余整行清零"，这一条就会红。
  const sadOnly = aggrieved();
  const sadPlus = eye({ needs: { social: 0.85 }, emotions: { curiosity: 0.5 } });
  assert.equal(sadPlus.mood, 'sad', '前置条件：主导仍是伤心');
  assert.ok(sadPlus.eyeOffset > sadOnly.eyeOffset,
    `好奇的前倾该泄漏进委屈眼里：${sadOnly.eyeOffset} → ${sadPlus.eyeOffset}`);
  assert.ok(sadPlus.lowerLidRaise > 0.2, '但委屈的形状本身不许被好奇抹掉');
});

test('arousal 让瞳孔放大，但不改变十行表任何一格的**名义值**（它是叠加层）', () => {
  const calm = eye({ emotions: { fear: 1 } });
  const hot = eye({ emotions: { fear: 1, arousal: 1 } });
  assert.ok(hot.pupilSize >= calm.pupilSize, '兴奋让瞳孔放大（spec §4.5 的 arousal 行）');
  assert.ok(hot.pupilSize <= CONFIG.eye.pupilMax, `放大不许越过 pupilMax：${hot.pupilSize}`);
  assert.equal(hot.lidOpen, calm.lidOpen, 'arousal 不该把"瞪到最大"变成别的开合');
});

// ------------------------------------------------------------------ 工具

function sampleBlink(c, opts) {
  // 沿**两个完整周期**采样 blink 读数：数"闭上再睁开"发生了几次，并量第一个闭合窗的时长。
  // 周期与相位都由 eyeParamsFor 自己给，所以这里测的是实现，不是测试自己另算的公式。
  // 为什么要两个周期：眨眼窗可能正好跨过 t=0 的采样边界，单周期采样会把一个窗数成两个。
  const p0 = eyeParamsFor(c, 0, opts);
  const period = p0.blinkPeriod;
  const N = 480;
  const dt = (2 * period) / N;
  let count = 0;
  let above = false;
  let inFirstRun = false;
  let runStart = -1, runEnd = -1;
  let peak = 0;
  for (let i = 0; i <= N; i++) {
    const b = eyeParamsFor(c, i * dt, opts).blink;
    assert.ok(b >= 0 && b <= 1, `blink 必须在 0–1，实测 ${b}`);
    if (b > peak) peak = b;
    const closed = b > 0.5;
    if (closed && !above) {
      count += 1; above = true;
      if (count === 1) { inFirstRun = true; runStart = i; }
    }
    if (closed && inFirstRun) runEnd = i;
    if (!closed) { above = false; inFirstRun = false; }
  }
  assert.ok(count >= 1, '两个周期里一次都没眨 —— blink 波形是死的');
  return { count, peak, halfSeconds: runEnd >= 0 ? (runEnd - runStart) * dt : 0 };
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
