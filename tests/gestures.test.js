import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyPress, pickCreature, GESTURES } from '../src/gestures.js';
import { radiusPx } from '../src/render.js';
import { CONFIG } from '../src/config.js';

// 视口用**自己挑的数**而不是抄 createViewport 的输出：本模块只消费 width/height/scale 三个数，
// 而它们怎么来的由 render.test.js 钉。scale=4 是为了让"最小的个体"真的落在 minHitPx 之下
// （traits.size 是**世界单位**，genes.js:130 把表现型 0..1 映到 CONFIG.minSize..maxSize = 14..38）。
const VP = { width: 900, height: 620, scale: 4 };
const CX = 0.5 * VP.width, CY = 0.5 * VP.height;

// 一只**成体峰值**的个体：growthFactor 在 960s 到 1.00（creature.js:196-200），
// 所以 age 给够，sizeOf 就等于 traits.size，测试里的期望半径才能用 radiusPx 自己算。
const CRE = (id, size, o = {}) => ({
  id, pos: { x: 0.5, y: 0.5 }, traits: { size }, eggBoost: 0,
  age: 2000, stage: 'adult', alive: true, dying: 0, ...o,
});

test('GESTURES 是冻结的三档，且 classifyPress 只吐这三档', () => {
  assert.deepEqual([...GESTURES], ['tap', 'hold', 'swipe']);
  assert.ok(Object.isFrozen(GESTURES));
});

test('classifyPress：三档互斥且覆盖全域', () => {
  assert.equal(classifyPress({ heldMs: 90, movedPx: 3 }), 'tap');
  assert.equal(classifyPress({ heldMs: 900, movedPx: 3 }), 'hold');
  assert.equal(classifyPress({ heldMs: 90, movedPx: 80 }), 'swipe');
});

test('swipe 先于 hold 判：从食物条拖出来的那一把**两样都满足**', () => {
  // 顺序反了的症状不是报错，是"拖着食物经过一只个体时先弹出了改名框"。
  assert.equal(classifyPress({ heldMs: 900, movedPx: 220 }), 'swipe');
  assert.equal(classifyPress({ heldMs: 900, movedPx: CONFIG.hud.tapMaxPx + 1 }), 'swipe');
});

test('classifyPress：脏读数一律不抛，且落回三档之内', () => {
  // 手是浏览器给的，采样缺帧是常态；这里抛一个错，症状是"玩家按了一下，页面红了"。
  for (const bad of [NaN, -1, undefined, null, 'x', Infinity, {}]) {
    const r = classifyPress({ heldMs: bad, movedPx: bad });
    assert.ok(GESTURES.includes(r), `脏值 ${String(bad)} 给出了 ${r}`);
  }
  assert.ok(GESTURES.includes(classifyPress()));
  assert.ok(GESTURES.includes(classifyPress(null)));
});

test('阈值只有**一个**真相源：边界正好落在 CONFIG.hud 写的那两个数上', () => {
  // Task 3 把 gestures.js 自带的那份 DEFAULTS 收编进 CONFIG.hud 之后，
  // 这条测试的职责变了：不再测"能不能覆盖"，而是测"它真的读的是 CONFIG"。
  // 覆盖式测试会藏住"模块里另抄了一份"，边界式测试不会。
  const { tapMaxPx, holdMinMs } = CONFIG.hud;
  assert.equal(classifyPress({ heldMs: 100, movedPx: tapMaxPx }), 'tap');
  assert.equal(classifyPress({ heldMs: 100, movedPx: tapMaxPx + 0.1 }), 'swipe');
  assert.equal(classifyPress({ heldMs: holdMinMs - 1, movedPx: 0 }), 'tap');
  assert.equal(classifyPress({ heldMs: holdMinMs, movedPx: 0 }), 'hold');
});

test('pickCreature：命中边界**就是** radiusPx 给的那个半径（点得到的与看到的是同一个实现）', () => {
  // 这条替代计划里原本那条"静止 vs 形变半径"—— 读完 render.js:142 才发现 radiusPx
  // 只含 sizeOf（年龄），挤压走的是 ctx 变换而不是半径，所以那个差异根本不存在。
  // 真正会漂移的是**年龄与蛋加成**：不共用实现的话，幼体的可点范围会和画出来的对不上。
  const c = CRE('a', 26);
  const r = radiusPx(c, VP);
  assert.ok(r > 0, 'fixture 没配对：radiusPx 算出 0，那这条测试在空转');
  assert.equal(pickCreature([c], VP, CX + r * 0.9, CY).id, 'a');
  assert.equal(pickCreature([c], VP, CX + r * 1.15, CY), null);
});

test('pickCreature：命中半径有下限，最小的那些也点得到', () => {
  // 幼体屏上半径可以小到 3px（render.js:120 的 SIZE_LO = 14×0.22），
  // 不夹下限的话"点按单只开信息卡"对最小的那些等于没做。
  const small = CRE('s', 14, { age: 10, stage: 'hatchling' });
  const r = radiusPx(small, VP);
  assert.ok(r < CONFIG.hud.minHitPx,
    `fixture 要的是"屏上半径小于下限"，实算 ${r.toFixed(2)} vs 下限 ${CONFIG.hud.minHitPx}`);
  const edge = CX + CONFIG.hud.minHitPx;
  assert.equal(pickCreature([small], VP, edge - 1, CY).id, 's',
    '下限之内必须点得到（真实半径早就过了）');
  assert.equal(pickCreature([small], VP, edge + 1, CY), null,
    '下限之外就是外 —— 夹的是下限，不是无限大');
});

test('pickCreature：重叠时取**屏上最近**的那只，数组顺序不许影响结果', () => {
  const a = CRE('a', 30, { pos: { x: 0.5, y: 0.5 } });
  const b = CRE('b', 30, { pos: { x: 0.53, y: 0.5 } });
  const px = 0.53 * VP.width;
  assert.equal(pickCreature([a, b], VP, px, CY).id, 'b');
  assert.equal(pickCreature([b, a], VP, px, CY).id, 'b');
});

test('pickCreature：溶散中与已死的个体不许被点到', () => {
  // 死亡溶散期间 alive 已经 false 而 creatures 里还在（B16），点它会开一张空卡。
  const dying = CRE('d', 26, { alive: false, dying: 0.4 });
  const gone = CRE('g', 26, { stage: 'dead', alive: false });
  assert.equal(pickCreature([dying, gone], VP, CX, CY), null);
});

test('pickCreature：空数组 / 空视口 / 非有限坐标一律 null，不抛', () => {
  assert.equal(pickCreature([], VP, 1, 1), null);
  assert.equal(pickCreature([CRE('a', 26)], { width: 0, height: 0, scale: 0 }, 0, 0), null);
  assert.equal(pickCreature([CRE('a', 26)], VP, NaN, 3), null);
  assert.equal(pickCreature([null, undefined, {}, CRE('a', 26)], VP, CX, CY).id, 'a',
    '数组里混进脏项也不许把整次点选废掉');
});

test('pickCreature：缺 pos 的个体跳过（脏存档不许传染成 NaN 比较）', () => {
  assert.equal(pickCreature([CRE('a', 26, { pos: null })], VP, CX, CY), null);
});

test('阈值确实读 CONFIG.hud：一条源码守卫（探针证不到的那一半）', () => {
  // 为什么需要这条：变异探针的用法是"改坏代码看测试红不红"，但把 CONFIG.hud.tapMaxPx
  // 换成字面量 12 **不会有任何行为差别**（它现在就是 12），六道探针全都不会红。
  // 而"两处数字要同步改"这个隐患恰恰就藏在这种"现在恰好相等"里。
  // 所以这里不比行为，比**接线**：源码必须引用那三个名字，且不许再自带一份 DEFAULTS。
  const src = readFileSync(fileURLToPath(new URL('../src/gestures.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  for (const k of ['CONFIG.hud.tapMaxPx', 'CONFIG.hud.holdMinMs', 'CONFIG.hud.minHitPx']) {
    assert.ok(src.includes(k), `gestures.js 不再读 ${k} —— 它大概被换成了字面量`);
  }
  assert.ok(!/DEFAULTS/.test(src),
    '又长出一份兜底常量表了：那等于回到"两处真相"，Task 3 收编它的意义就没了');
  assert.ok(!/\b12\b|\b500\b|\b22\b/.test(src),
    '源码里出现了疑似阈值的裸数字：阈值只有一个地方能写，就是 CONFIG.hud');
});
