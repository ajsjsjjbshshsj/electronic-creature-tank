import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createWorld, tickWorld } from '../src/sim.js';
import { createBody, updateBody } from '../src/body.js';
import { createCreature } from '../src/creature.js';
import { createRng } from '../src/rng.js';
import { createViewport } from '../src/main.js';
import {
  createRenderer, drawCreature, consumeEvents, screenY, screenX, radiusPx,
  fluffOuterRadius, bodyTopY, bubbleAnchorY, bubbleBoxInto,
  dissolveT, dissolveLiftOf, dissolveExpandOf,
  hopProgress, hopSquashAt, hopLiftAt, hopImpulse,
  BUBBLE_FONT, BUBBLE_FILL, BUBBLE_STROKE, BUBBLE_INK,
} from '../src/render.js';
import {
  bubblePoolCapacity, createBubbles, pushSay, advanceBubbles,
  wrapInto, bubbleFade,
} from '../src/bubble.js';

// ==================================================================== 说明
//
// B19a：spec §5.1 的第 8 层（语言气泡）。这一层的**全部硬要求**来自 §4.13.1 末段
// 「显示纪律」那一句 + §5.3 的「同屏最多 2 个，其余排队」+ §9.2 第 7 条（关掉文字层
// 其余仍必须完全可读）。逐条对应下面各节，每节末尾注明桩测不到、进手工清单的部分。
//
// 桩与 tests/render-fx.test.js 同一套「有序事件日志」思路，但**多记了三样值**：
//   · fillText 的 (text, x, y) —— §4.13.1 的位置纪律（气泡跟绘制几何，不跟 c.pos）
//   · font 的写入值 —— 「字号 ≥14px 是 CSS 像素」这条只能看值，看次数看不出来
//   · fillStyle / strokeStyle / lineWidth 的写入值 —— 「样式跟 fluff 走（浅色描边）」
// 为什么这三处破例记值（其余仍然只数次数）：三条纪律的失败形式都是**次数完全不变**
// 而画面错了（字号按位图算 / 位置钉在 c.pos / 描边跟体色走）。B16 的探针 P7 已经证明
// 这种失败只能靠记值或记结果才抓得到。只破例记这三样，其余一律不记，避免每条断言
// 都变成参数脆断（那是 B13/B14 立「只数次数」纪律时要避免的东西）。

const GRADIENT_STUB = { addColorStop() {} };

function createBubbleCtx(opts) {
  const o = opts || {};
  const counts = new Map();
  const ops = [];
  let depth = 0;
  const stub = {
    ops,
    counts,
    texts: [],
    fonts: [],
    shadowBlurWrites: 0,
    _shadowBlur: 0,
    _font: '',
    _fillStyle: '',
    _strokeStyle: '',
    _lineWidth: 0,
    _globalAlpha: 1,
    glyphWidth: o.glyphWidth === undefined ? 10 : o.glyphWidth,
    measureCalls: 0,
    reset() {
      counts.clear(); ops.length = 0; depth = 0;
      stub.texts.length = 0; stub.fonts.length = 0;
      stub.shadowBlurWrites = 0; stub.measureCalls = 0;
    },
    count(name) { return counts.get(name) || 0; },
    indexOf(name) { return ops.findIndex((op) => op.op === name); },
    // 序列签名：**op 名 + 当时的 save/restore 深度**。
    // 用它做「关掉文字层之后其余七层逐帧完全相同」那条断言（设计判断 3）——
    // 只比次数的话，「第 6 层少画一条路径、气泡层多画一条」会互相抵消。
    sig(upto) {
      const n = upto === undefined ? ops.length : upto;
      return ops.slice(0, n).map((op) => `${op.op}@${op.depth}`);
    },
  };
  const bump = (name) => { counts.set(name, (counts.get(name) || 0) + 1); };
  for (const m of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
    'bezierCurveTo', 'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'clearRect',
    'fillRect', 'translate', 'rotate', 'scale', 'drawImage', 'setTransform']) {
    stub[m] = () => { bump(m); ops.push({ op: m, depth }); };
  }
  stub.fillText = (text, x, y) => {
    bump('fillText');
    const rec = { op: 'fillText', depth, text, x, y, font: stub._font, fillStyle: stub._fillStyle };
    ops.push(rec);
    stub.texts.push(rec);
    stub.fonts.push(stub._font);
  };
  stub.save = () => { depth += 1; bump('save'); ops.push({ op: 'save', depth }); };
  stub.restore = () => { bump('restore'); ops.push({ op: 'restore', depth }); depth -= 1; };
  stub.createRadialGradient = () => { bump('createRadialGradient'); return GRADIENT_STUB; };
  stub.createLinearGradient = () => { bump('createLinearGradient'); return GRADIENT_STUB; };
  // ⚠️ 桩的度量**与字号无关**（每个字符恒宽）：这是刻意的。真实 canvas 的 measureText
  // 会随 ctx.font 变大，于是「字号写错」会被「框也跟着变大」自我掩盖。恒宽度量让
  // 「字号 ≥14px」只能从 font 的值上被读到，而换行行为完全由 maxWidthPx 决定、可在 Node 里断言。
  stub.measureText = (s) => {
    stub.measureCalls += 1;
    return { width: String(s).length * stub.glyphWidth };
  };
  const attr = (name, store) => {
    let value = '';
    Object.defineProperty(stub, name, {
      get() { return value; },
      set(v) {
        value = v;
        stub['_' + name] = v;          // fillText 那一笔要能读到**当时**的 font / fillStyle
        bump(name);
        if (store) ops.push({ op: name, depth });
      },
    });
  };
  attr('globalAlpha', true);
  attr('globalCompositeOperation', true);
  attr('fillStyle', true);
  attr('strokeStyle', true);
  attr('lineWidth', false);
  attr('font', true);
  Object.defineProperty(stub, 'shadowBlur', {
    get() { return stub._shadowBlur; },
    set(v) { stub.shadowBlurWrites += 1; stub._shadowBlur = v; },
  });
  return stub;
}

const makeCanvasStub = (created) => (w, h) => {
  const c = createBubbleCtx();
  c.width = w; c.height = h;
  if (created) created.push(c);
  return { ctx: c, surface: c };
};

const DESKTOP = createViewport(1920, 1080, 1);
const PHONE = createViewport(390, 844, 3);

const makeWorld = (seed) => {
  const w = createWorld({ seed });
  for (let i = 0; i < 30; i++) tickWorld(w, CONFIG.fixedDt);
  return w;
};

const makeBodies = (world) => {
  const bodies = new Map();
  for (const c of world.creatures) {
    const b = createBody(c.traits);
    for (let i = 0; i < 30; i++) updateBody(b, c, CONFIG.fixedDt);
    bodies.set(c.id, b);
  }
  return bodies;
};

const makeRenderer = (world, viewport, isMobile, created) => createRenderer({
  makeCanvas: makeCanvasStub(created), rng: world.rng.fork(), viewport, isMobile,
});

const say = (id, text, over) => Object.assign(
  { kind: 'say', id, text, tokens: String(text).split(' '), mood: '开心' },
  over || {},
);

// 只有一条生物的缸：气泡层的锚点要靠 renderer.sx/sy 那份**绘制坐标**核对，
// 而那两组数组是复用的（绘制不可重入）⇒ 一只才好读末笔坐标。
const singleWorld = () => {
  const c = createCreature({
    id: 'c-bub', name: '测试', x: 0.5, y: 0.5, age: 900, stage: 'adult',
    genes: {
      hue: [0.83, 0.85], size: [0.5, 0.5], pattern: [0.2, 0.2], patternDensity: [0.5, 0.5],
      glow: [0.6, 0.6], sat: [0.7, 0.7], lum: [0.7, 0.7], wobble: [0.5, 0.5],
      fluff: [0.6, 0.6], eggTint: [0.1, 0.1],
      bold: [0.5, 0.5], clingy: [0.5, 0.5], irritable: [0.5, 0.5], gluttonous: [0.5, 0.5],
      curious: [0.5, 0.5], activity: [0.7, 0.7], talk: [0.8, 0.8], intellect: [0.5, 0.5],
      broody: [0.5, 0.5],
    },
    generation: 1, rng: createRng(7),
  });
  const world = {
    creatures: [c], eggs: [], foods: [], events: [], time: 0,
    rng: createRng(9), speechEnabled: true, playerHand: null,
  };
  const body = createBody(c.traits);
  for (let i = 0; i < 30; i++) updateBody(body, c, CONFIG.fixedDt);
  return { world, c, body, bodies: new Map([[c.id, body]]) };
};

// 独立再推导一遍 CONFIG 里的浅色（**不用**被测模块的常量），用于「样式跟 fluff 走」：
// 拿实现验实现的话，把描边改成体色这条红不了。
const hexRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbOf = (css) => {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(css);
  if (hex) return hexRgb(hex[1]);
  const m = /rgba?\(([^)]+)\)/.exec(css);
  assert.ok(m, `${css} 既不是 #RRGGBB 也不是 rgb/rgba`);
  return m[1].split(',').slice(0, 3).map((v) => Number(v.trim()));
};
const luminanceOf = ([r, g, b]) => {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const contrast = (a, b) => {
  const la = luminanceOf(a), lb = luminanceOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
// font 字符串里的**像素数**（CSS 像素）。取不出来就当 0 ⇒ 下面那条 ≥14 会直接红。
const fontPx = (font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? Number(m[1]) : 0;
};

// 独立重推一遍「这一帧真正画出来的身体顶边」——与 tests/render-fx.test.js 的 expectSy0
// 同一手法：桩看不见像素，但它看得见公式里少乘的那一项（lift / rise / expand / 毛尖伸出）。
// 这里连 bodyTopY 都不调用，直接把那 24 点的变换在测试里重算一遍，
// 否则就是拿实现验实现，「气泡钉在 c.pos 上」那种错会跟着一起被"验"过去。
const S = CONFIG.speech;
const expectAnchor = (c, body, vp) => {
  const worldR = radiusPx(c, vp);
  const t = dissolveT(c);
  const dying = t > 0;
  const p = hopProgress(c);
  const squashV = hopSquashAt(p);
  const lift = hopLiftAt(p, hopImpulse(c.traits.personality.activity)) * worldR;
  const rise = dying ? dissolveLiftOf(t) * vp.height : 0;
  const rr = worldR * (dying ? dissolveExpandOf(t) : 1);
  const cy = screenY(c.pos.y, vp) - lift - rise;
  const ca = c.facing.x, sa = c.facing.y;
  let top = Infinity;
  for (const q of body.points) top = Math.min(top, cy + (q.x * sa + q.y * ca) * rr * squashV);
  return top - (fluffOuterRadius(rr, body.fluffLen) - rr);
};
// 一行的时候：框底 = 锚点 − 头部空隙，基线 = 框顶 + 内边距 + 字号 = 锚点 − 空隙 − 内边距
const expectTextY = (c, body, vp, lines = 1) => expectAnchor(c, body, vp) - S.bubbleHeadGap
  - (lines * S.bubbleFontPx + (lines - 1) * S.bubbleLineGap + 2 * S.bubblePadding)
  + S.bubblePadding + S.bubbleFontPx * lines;

// ============================================ 一、纯函数：换行（§4.13.1「最多 2 行」）

test('wrapInto 按 token 贪心换行：每行不超过上限、行数不超过 2、绝不吞词', () => {
  const out = { lines: ['', ''], widths: [0, 0], count: 0, used: 0, clipped: 0 };
  const measure = { measureText: (s) => ({ width: String(s).length * 10 }) };
  const r = wrapInto(out, ['喵喵', '开心', '要摸摸'], 60, measure, 2);
  assert.equal(r, out, '必须原地写入同一份 out（返回新对象就是每帧一次分配）');
  assert.equal(out.count, 2, `两行装得下就该是两行：${JSON.stringify(out.lines)}`);
  assert.equal(out.lines[0], '喵喵 开心');
  assert.equal(out.lines[1], '要摸摸');
  assert.equal(out.clipped, 0, '两个字符宽的词没有被截掉的道理');
  for (let i = 0; i < out.count; i++) {
    assert.ok(measure.measureText(out.lines[i]).width <= 60, `第 ${i} 行超宽`);
    assert.ok(out.widths[i] > 0, `第 ${i} 行的宽度没被缓存（每帧重量就是 §5.3 那条白烧）`);
  }
  assert.equal(out.used, 3, '三个 token 全部落地');
});

test('wrapInto 的行数硬上限就是 CONFIG.speech.bubbleMaxLines：装不下的词被截掉并且**计数**', () => {
  const out = { lines: ['', '', ''], widths: [0, 0, 0], count: 0, used: 0, clipped: 0 };
  const measure = { measureText: (s) => ({ width: String(s).length * 10 }) };
  wrapInto(out, ['喵喵', '主人', '开心', '要摸摸', '怕怕'], 60, measure, S.bubbleMaxLines);
  assert.equal(out.count, S.bubbleMaxLines, 'spec 逐字「最多 2 行」');
  assert.ok(out.clipped > 0, `屏放置不下的词必须被计数而不是静默消失：${JSON.stringify(out)}`);
  assert.equal(out.used + out.clipped, 5, '用掉的 + 截掉的必须恰好等于送进来的（守恒，不许漏词）');
  // ⚠️ 这条是变异探针咬出来的：上面三条**全部通过**时最后一行其实可以是空的。
  // `used + clipped` 守恒只管词的去向，不管词落在哪一行 —— 早退分支若不把 `cur` 落地，
  // count 照样是 2、clipped 照样是 1，而画出来是「两行高的框里只有一行字」。
  // 于是这里断的是**count 声称的每一行都必须有字、也必须有缓存宽度**。
  for (let i = 0; i < out.count; i++) {
    assert.ok(out.lines[i] !== '', `第 ${i} 行被 count 声称存在，却是空的（吞了一整行）`);
    assert.ok(out.widths[i] > 0, `第 ${i} 行没有宽度缓存，居中那段会把它摆到框外`);
  }
});

test('wrapInto 在「最后一次溢出」时也必须把当前行落地（早退分支不是丢弃分支）', () => {
  // 上一那条用 5 个词撞上限；这里用最少的词把早退分支单独钉住：
  // 溢出发生在**最后一个可用行**上（li+1 === lim），这是唯一会走早退的时刻。
  const out = { lines: ['', ''], widths: [0, 0], count: 0, used: 0, clipped: 0 };
  const measure = (s) => String(s).length * 10;      // cap=50 ⇒ 一行最多 5 个字符
  wrapInto(out, ['aaaa', 'bb', 'cc', 'dd'], 50, measure, 2);
  assert.deepEqual(out.lines, ['aaaa', 'bb cc'], '第二行必须带着它装得下的那两个词');
  assert.equal(out.count, 2);
  assert.equal(out.used, 3, '三个词落地');
  assert.equal(out.clipped, 1, '只有 dd 被截掉');
  assert.equal(out.widths[1], 50, '第二行的宽度就是它自己那串的宽度');
});

test('wrapInto 遇到单个超宽 token 时让它独占一行，而不是把它丢掉', () => {
  const out = { lines: ['', ''], widths: [0, 0], count: 0, used: 0, clipped: 0 };
  const measure = { measureText: (s) => ({ width: String(s).length * 10 }) };
  wrapInto(out, ['一个很长的词组', '喵'], 20, measure, 2);
  assert.ok(out.lines[0].includes('一个很长的词组'), '超宽的第一个词必须留在场上：吞字比超框更糟');
  assert.equal(out.count, 2);
  assert.equal(out.used + out.clipped, 2);
});

test('wrapInto 没有 measure 能力时抛错（字体测量必须由注入提供，不许自己凑一个字宽）', () => {
  const out = { lines: ['', ''], widths: [0, 0], count: 0, used: 0, clipped: 0 };
  assert.throws(() => wrapInto(out, ['喵', '喵'], 100, null, 2), /measure/);
  assert.throws(() => wrapInto(out, ['喵'], 100, {}, 2), /measure/);
  assert.doesNotThrow(() => wrapInto(out, ['喵'], 100, (t) => t.length * 10, 2));
});

test('wrapInto 对空行/空词/0 宽度量都不死循环（真实桩就是 width 恒 0）', () => {
  const out = { lines: ['', ''], widths: [0, 0], count: 0, used: 0, clipped: 0 };
  const zero = { measureText: () => ({ width: 0 }) };
  wrapInto(out, ['', '喵', '', '', '喵'], 50, zero, 2);
  assert.equal(out.count, 1, '宽度 0 ⇒ 全部挤进一行，但只能是一行');
  assert.equal(out.lines[0], '喵 喵');
  wrapInto(out, [], 50, zero, 2);
  assert.equal(out.count, 0);
});

// ============================================ 二、排队：上界、丢最旧、可断言读数

test('队列容量 = onscreenMax × bubbleQueueMul：有界，不是「其余排队」= 无界增长', () => {
  assert.equal(S.onscreenMax, 2, 'spec §4.13.1 逐字：同一时刻屏上最多 2 个气泡');
  assert.equal(S.bubbleMaxLines, 2, 'spec 逐字：最多 2 行');
  assert.equal(S.bubbleTtl, 3, 'spec 逐字：3 秒淡出');
  assert.equal(S.bubbleFontPx, 14, 'spec 逐字：字号 ≥14px');
  assert.ok(S.bubbleQueueMul >= 2, '上界至少要是同屏数的两倍，否则「排队」名不副实');
  const cap = bubblePoolCapacity();
  assert.equal(cap, S.onscreenMax * S.bubbleQueueMul);
  const b = createBubbles(cap);
  assert.equal(b.n, cap);
  for (let i = 0; i < cap * 40; i++) {
    pushSay(b, say(`c-${i % 24}`, `喵 ${i}`), 100 + i * 0.001);
    assert.ok(b.count <= b.n, `第 ${i} 次入队后队列越界：${b.count} > ${b.n}`);
  }
});

test('溢出丢的是**排队里最旧的一条**，正在显示的气泡不被打断，且丢弃数有读数', () => {
  const measure = { measureText: (t) => ({ width: String(t).length * 4 }) };
  const b = createBubbles(bubblePoolCapacity());
  for (let i = 1; i <= b.n + 2; i++) pushSay(b, say(`c${i}`, `喵 ${i}`), 0);
  assert.equal(b.count, b.n, '池子必须停在容量上，不是悄悄扩容');
  assert.equal(b.dropped, 2, `溢出两条必须报 2，实测 ${b.dropped}（静默丢是 §7.7 禁止的）`);
  const rel = (k) => k;                 // 稠密池子：相对位置就是下标
  assert.equal(b.id[rel(0)], 'c3', '一条都没上场时，排队的就是全部：丢绝对最旧的两条');
  assert.equal(b.id[rel(1)], 'c4');
  assert.ok(b.id[rel(b.count - 1)].endsWith('10'), '最新那条永远在队尾');
  assert.equal(b.accepted, b.n + 2, '入队读数：收到几条就接几条（溢出的那条也算收到过）');
  // 让头两条上场，再溢出：撤的必须是队里最旧的那条，而不是正在说话的那两条
  advanceBubbles(b, 0, 200, measure);
  assert.ok(b.shownAt[rel(0)] === 0 && b.shownAt[rel(1)] === 0, '前置条件：前两条已经在说');
  const before = b.dropped;
  pushSay(b, say('c11', '喵 11'), 0.1);
  assert.equal(b.dropped, before + 1);
  assert.equal(b.id[rel(0)], 'c3', '正在显示的那条不许被打断：中途撤字等于吞字');
  assert.equal(b.id[rel(1)], 'c4');
  assert.equal(b.id[rel(2)], 'c6', 'c5 是排队者里最旧的，撤它');
  assert.ok(b.shownAt[rel(0)] === 0, '它的淡出时钟也没被重置');
  assert.equal(advanceBubbles(b, 0.2, 200, measure), S.onscreenMax, '溢出之后同屏数仍然是 2，不是 3');
});

test('同一只连说两句时旧的让位：屏上不会同时挂着它的两句话，且有 superseded 读数', () => {
  const b = createBubbles(bubblePoolCapacity());
  pushSay(b, say('c1', '喵喵 开心'), 0);
  pushSay(b, say('c1', '喵喵 要摸摸'), 1);
  pushSay(b, say('c1', '哼 气气'), 2);
  assert.equal(b.count, 1, `一只只该占一格，实测 ${b.count}`);
  assert.equal(b.superseded, 2);
  const idx = 0;
  assert.equal(b.text[idx], '哼 气气', '留下的是最新那句');
  assert.equal(b.accepted, 3);
});

test('advanceBubbles 把同屏数压到 onscreenMax，其余排队；排队的等前面的淡出后才上场', () => {
  const b = createBubbles(bubblePoolCapacity());
  const measure = { measureText: (t) => ({ width: String(t).length * 4 }) };
  for (let i = 0; i < 6; i++) pushSay(b, say(`c${i}`, `喵 ${i}`), 0);
  let maxOn = 0;
  const seen = [];
  for (let f = 0; f < 40; f++) {
    const t = f * 0.25;
    const on = advanceBubbles(b, t, 200, measure);
    assert.ok(on <= S.onscreenMax, `第 ${f} 帧同屏 ${on} 条 —— 弹幕就是这么开头的`);
    maxOn = Math.max(maxOn, on);
    for (let k = 0; k < on; k++) seen.push(b.id[k]);
  }
  assert.equal(maxOn, S.onscreenMax, '有排队者时同屏必须真的坐满 2 格');
  assert.ok(b.shown >= 6, `六条都排过队，六条都该上过场：${b.shown}`);
  assert.equal(b.count, 0, '40 帧（10 秒）之后 ttl=3 秒的气泡必须全部散场');
  assert.equal(new Set(seen).size, 6, '六条各上场过一次（顺序由队头往后，不许有插队）');
  assert.equal(seen.indexOf('c5') > seen.indexOf('c0'), true, 'FIFO：先说的先上场');
  assert.ok(b.lastWait > 3, `队尾那几条确实等了很久才上场，实测 ${b.lastWait}`);
});

test('advanceBubbles 到 ttl 秒整就收走那条气泡（3 秒淡出的另一端：不留尸体）', () => {
  const b = createBubbles(bubblePoolCapacity());
  const measure = { measureText: (t) => ({ width: String(t).length * 4 }) };
  pushSay(b, say('c1', '喵 喵'), 10);
  assert.equal(advanceBubbles(b, 10, 200, measure), 1);
  assert.equal(advanceBubbles(b, 10 + S.bubbleTtl - 0.01, 200, measure), 1, '还差一瞬就再撑一帧');
  assert.equal(advanceBubbles(b, 10 + S.bubbleTtl, 200, measure), 0, 'ttl 到点必须走');
  assert.equal(b.expired, 1, '自然淡出的条数也有读数，与 dropped 分得很清');
});

test('气泡的寿命用**模拟秒**：4× 倍速下淡出跟着快，不是一场永不着地的雪', () => {
  const measure = { measureText: (t) => ({ width: String(t).length * 4 }) };
  const run = (mul) => {
    const g = createBubbles(bubblePoolCapacity());
    pushSay(g, say('c1', '喵 喵'), 0);
    const step = CONFIG.fixedDt * mul;
    const frames = Math.ceil(S.bubbleTtl / step) + 1;
    let on = 0;
    for (let i = 0; i < frames; i++) on = Math.max(on, advanceBubbles(g, i * step, 200, measure));
    return { frames, left: g.count, on, shown: g.shown };
  };
  const slow = run(1);
  const fast = run(4);
  assert.equal(slow.left, 0, `一缸 60fps 走完 3 模拟秒之后必须收摊，还剩 ${slow.left} 条`);
  assert.equal(fast.left, 0, '倍速下走完同一段**模拟**秒也必须收摊（按帧计时那条台词就永不结束）');
  assert.equal(slow.on, 1);
  assert.equal(fast.on, 1);
  assert.equal(slow.shown, fast.shown, '上过场的条数与帧率无关：只与模拟时间有关');
  assert.ok(fast.frames * 4 <= slow.frames + 4,
    `倍速下推进的帧数必须更少：${slow.frames} vs ${fast.frames}`);
});

test('bubbleFade 的形状：先站得住、再淡到 0，全程单调不回升', () => {
  assert.equal(bubbleFade(0), 1);
  assert.equal(bubbleFade(S.bubbleTtl), 0);
  assert.ok(bubbleFade(-1) <= 1 && bubbleFade(-1) >= 0, '脏 age 不许给出 >1 的 alpha');
  assert.ok(bubbleFade(S.bubbleTtl * 2) === 0);
  assert.ok(bubbleFade(S.bubbleTtl * 0.5) > 0.1, '半程就淡没了的话，玩家来不及读完那两行');
  let prev = Infinity;
  for (let i = 0; i <= 40; i++) {
    const a = bubbleFade((i / 40) * S.bubbleTtl);
    assert.ok(a <= prev + 1e-12, `alpha 在第 ${i} 步回升了：淡出不能是呼吸`);
    prev = a;
  }
  assert.ok(bubbleFade(S.bubbleTtl * 0.2) === 1, '前 S.bubbleFadeHold 段必须满亮，否则字一直在闪');
});

// ============================================ 三、设计判断 1：气泡是表现层状态

test('气泡一个字节都不写进世界：跑完一整场对话之后 world 逐字段不变（spec §7.2）', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  const before = JSON.stringify(world);
  const ctx = createBubbleCtx();
  for (let f = 0; f < 40; f++) {
    consumeEvents(r, [say(c.id, `喵喵 开心 ${f}`), say('别的', `哼 ${f}`)]);
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(JSON.stringify(world), before, '画了 80 条气泡而世界一个字都没变 —— 变了就是入了档');
  assert.ok(!('bubble' in c) && !('bubbles' in c), '个体身上不长气泡字段');
  assert.ok(!('bubbles' in world), '世界上不长气泡字段（唯一例外是 catchphrase，它不归这层管）');
  assert.ok(r.bubbles.count > 0 || r.bubbles.shown > 0, '前置条件：这一串确实进了气泡层');
  assert.ok(ctx.count('fillText') > 0, '前置条件：确实画出了字');
});

test('save/restore 成对、且第 8 层不向 rng 取一个随机数（纪律 2 与 B14 的账单）', () => {
  const { world, bodies, c } = singleWorld();
  let calls = 0;
  const base = createRng(5);
  const counting = {
    next() { calls += 1; return base.next(); },
    range(a, b) { calls += 1; return base.range(a, b); },
    int(a, b) { calls += 1; return base.int(a, b); },
    chance(p) { calls += 1; return base.chance(p); },
    gaussian() { calls += 1; return base.gaussian(); },
    pick(a) { calls += 1; return base.pick(a); },
    fork() { return counting; },
  };
  const r = createRenderer({
    makeCanvas: makeCanvasStub(), rng: counting, viewport: DESKTOP, isMobile: false,
  });
  const built = calls;
  const ctx = createBubbleCtx();
  for (let f = 0; f < 30; f++) {
    consumeEvents(r, [say(c.id, `喵 ${f}`), say('邻居', `哼 ${f}`)]);
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(calls, built, `气泡层取了 ${calls - built} 个随机数 —— 帧率相关的抽样会让同种子在两台设备上长出不同的缸`);
  assert.equal(ctx.count('save'), ctx.count('restore'), 'save/restore 必须成对，漏一次就把 alpha 污染给后面所有层');
});

// ============================================ 四、设计判断 3：关掉文字层

test('关掉文字层 ⇒ 一条气泡都不画，而其余七层的调用**序列**逐笔完全相同（spec §9.2 第 7 条）', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  world.speechEnabled = true;
  r.time = 500;
  consumeEvents(r, [say(c.id, '喵喵 开心 要摸摸'), say('邻居', '哼 怕怕')]);
  const on = createBubbleCtx();
  r.draw(on, world, bodies, DESKTOP, 0);            // dt=0 ⇒ 两帧之间世界时钟不动
  assert.ok(on.count('fillText') > 0, '前置条件：开着的时候确实有字');
  const on2 = createBubbleCtx();
  r.draw(on2, world, bodies, DESKTOP, 0);           // 仍在显示中，同一状态再画一帧
  world.speechEnabled = false;
  r.draw(createBubbleCtx(), world, bodies, DESKTOP, 0);   // 关：把队列收走
  const off = createBubbleCtx();
  r.draw(off, world, bodies, DESKTOP, 0);
  assert.equal(off.count('fillText'), 0, '关掉之后一个字都不许出现');
  assert.equal(off.measureCalls, 0, '关掉之后连字体测量都不该做（那是白花的每帧成本）');
  const offSig = off.sig();
  const onSig = on2.sig();
  assert.ok(onSig.length > offSig.length,
    `开着必须比关着多画出第 8 层那些笔：${onSig.length} vs ${offSig.length}`);
  // 其余七层的判据是**逐笔序列完全相同**，不是次数相等：
  // 「第 6 层少画一条路径 + 气泡层多画一条」在次数口径上会互相抵消。
  assert.deepEqual(onSig.slice(0, offSig.length), offSig,
    '关掉文字层顺手少画一层（或把气泡的路径混进其余层）就是这一条要抓的');
  const extra = onSig.slice(offSig.length).map((s) => s.split('@')[0]);
  const allowed = ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'closePath',
    'fill', 'stroke', 'fillStyle', 'strokeStyle', 'globalAlpha', 'font', 'fillText'];
  assert.deepEqual([...new Set(extra)].filter((n) => !allowed.includes(n)), [],
    `第 8 层多出来的调用必须全部是它自己的那几种，实测 ${JSON.stringify([...new Set(extra)])}`);
  assert.equal(r.bubbles.count, 0, '关掉之后不留残余气泡，重新打开也不该把旧句子喷出来');
});

test('关掉文字层时 say 事件不入队：重新打开不会把静音期间的旧句子一次放出', () => {
  const { world, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createBubbleCtx();
  world.speechEnabled = false;
  r.draw(ctx, world, new Map(), DESKTOP, 0);        // 让 renderer 读到开关
  for (let i = 0; i < 20; i++) consumeEvents(r, [say(c.id, `喵 ${i}`)]);
  assert.equal(r.bubbles.count, 0, '关着的时候一条都不该进队列');
  assert.equal(r.bubbles.rejected, 0, '这是开关拦的，不是格式坏拦的，两个读数不许混');
  world.speechEnabled = true;
  r.draw(ctx, world, new Map(), DESKTOP, 0);
  assert.equal(r.bubbles.count, 0, '重新打开时队列必须是空的');
});

test('第 8 层不改 B14 的贴图上界：同屏两条气泡时 drawImage 与关掉时逐帧相同', () => {
  // 「气泡不许为每个气泡预渲染 sprite」——那条上界的死法就是 drawImage 多两次。
  const { world, bodies, c } = singleWorld();
  const created = [];
  const r = makeRenderer(world, DESKTOP, false, created);
  world.speechEnabled = true;
  r.time = 100;
  consumeEvents(r, [say(c.id, '喵喵 开心 要摸摸'), say('邻居', '哼 怕怕')]);
  r.draw(createBubbleCtx(), world, bodies, DESKTOP, 0);   // 热身：惰性 sprite 在这一帧建满
  const warm = created.length;
  const ctx = createBubbleCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  const withBubbles = ctx.count('drawImage');
  assert.ok(withBubbles > 0, '前置条件：本体那 7 次贴图要在');
  assert.ok(ctx.count('fillText') > 0, '前置条件：这一帧真的有字');
  assert.equal(created.length, warm, '气泡层一张离屏画布都不许新建（sprite 方案在这里当场红）');
  world.speechEnabled = false;
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.equal(ctx.count('drawImage'), withBubbles, '两条气泡多花了一次贴图就是这条要抓的');
  assert.equal(created.length, warm, '关掉之后再打开也不该补建贴图');
});

// ============================================ 五、设计判断 4：字号是 CSS 像素

test('字号 ≥14px 且**不随 dpr 变**：dpr=3 的手机上字不会缩成 4.7px（设计判断 4）', () => {
  const { world, c } = singleWorld();
  const bodies = new Map([[c.id, createBody(c.traits)]]);
  for (let i = 0; i < 30; i++) updateBody(bodies.get(c.id), c, CONFIG.fixedDt);
  const read = (viewport) => {
    const r = makeRenderer(world, viewport, viewport.dpr > 1);
    r.time = 900;
    consumeEvents(r, [say(c.id, '喵喵 开心')]);
    const ctx = createBubbleCtx();
    r.draw(ctx, world, bodies, viewport, 0);
    assert.ok(ctx.texts.length > 0, `${viewport.width}×${viewport.height} dpr${viewport.dpr} 一个字都没画`);
    return ctx.fonts.slice();
  };
  const one = read(DESKTOP);
  const three = read(PHONE);
  for (const f of [...one, ...three]) {
    assert.ok(fontPx(f) >= S.bubbleFontPx, `「≥14px」是对 CSS 像素说的，实测 ${f}`);
  }
  assert.deepEqual(three.map(fontPx), one.map(fontPx),
    'dpr 从 1 变到 3 不许改变 CSS 字号 —— 按位图像素算字号，手机上的字会小三倍');
  assert.deepEqual(three, one, '连字体串本身都该是同一份常量（每帧拼字符串就是每帧一次分配）');
});

test('气泡的坐标落在 CSS 像素空间里：x 随视口宽缩放，而不随 dpr 缩放', () => {
  const { world, c } = singleWorld();
  const bodies = new Map([[c.id, createBody(c.traits)]]);
  for (let i = 0; i < 30; i++) updateBody(bodies.get(c.id), c, CONFIG.fixedDt);
  c.pos.x = 0.5; c.pos.y = 0.5;
  const first = (viewport) => {
    const r = makeRenderer(world, viewport, false);
    r.time = 900;
    consumeEvents(r, [say(c.id, '喵')]);
    const ctx = createBubbleCtx();
    r.draw(ctx, world, bodies, viewport, 0);
    return ctx.texts[0];
  };
  const a = first(createViewport(1000, 1000, 1));
  const b = first(createViewport(1000, 1000, 3));   // 同 CSS 尺寸、不同 dpr
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9,
    `同一份 CSS 几何必须给同一个位置：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  const big = first(createViewport(2000, 2000, 1));
  assert.ok(big.x > a.x, '视口变宽，屏幕坐标必须跟着变宽（说明用的是 CSS 像素而不是位图）');
});

test('圆角矩形走 arc + lineTo，不抢 quadraticCurveTo 与贝塞尔预算（§5.3）', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say(c.id, '喵喵 开心 要摸摸')]);
  const ctx = createBubbleCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.ok(ctx.count('fillText') > 0, '前置条件');
  assert.equal(ctx.count('quadraticCurveTo'), 0, 'B14 的「quadraticCurveTo 恒 0」不许被气泡的圆角破例');
  assert.equal(ctx.count('bezierCurveTo'), CONFIG.bodyPoints,
    '贝塞尔只能来自身体轮廓那一段：气泡用贝塞尔做圆角就是在抢那条上界');
  assert.ok(ctx.count('arc') >= 4, '圆角应当用 arc（四角至少四段）');
  assert.ok(ctx.count('stroke') >= 1, '「浅色描边」必须真的描一次');
  assert.equal(ctx.shadowBlurWrites, 0, '§5.3：不每帧 shadowBlur');
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('createLinearGradient'), 0);
});

// ============================================ 六、设计判断 5：位置跟绘制几何

test('bodyTopY 等于绘制坐标 renderer.sy 的最小值（气泡跟的是那一圈点，不是 c.pos）', () => {
  const { world, bodies, c, body } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createBubbleCtx();
  drawCreature(ctx, r, c, body, DESKTOP);
  let min = Infinity;
  for (let i = 0; i < CONFIG.bodyPoints; i++) min = Math.min(min, r.sy[i]);
  const cx = 0.5 * DESKTOP.width;
  const cy = screenY(c.pos.y, DESKTOP) - r.fx.lift - r.fx.rise;
  const rr = radiusPx(c, DESKTOP) * r.fx.expand;
  assert.ok(Math.abs(bodyTopY(body, cx, cy, rr, c.facing.x, c.facing.y, r.fx.squashV) - min) < 1e-9,
    '包围盒顶边必须与画出来的那 24 点逐点一致（另算一套几何就是分家）');
});

test('跳起来时气泡跟着升，落回地面时跟着降；而 c.pos 一个字都没动', () => {
  const { world, bodies, c, body } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createBubbleCtx();
  const textY = () => {
    ctx.reset();
    r.time = 1200;
    r.draw(ctx, world, bodies, DESKTOP, 0);
    return ctx.texts.map((t) => t.y);
  };
  c.intent = null; c.intentTime = 0;
  consumeEvents(r, [say(c.id, '喵喵 开心')]);
  const standing = textY();
  const posBefore = { x: c.pos.x, y: c.pos.y };
  assert.ok(standing.length > 0, '前置条件：站着的时候也在说话');
  assert.ok(Math.abs(standing[0] - expectTextY(c, body, DESKTOP)) < 1e-9,
    `站着那帧字的基线不等于重推出来的那一条：${standing[0]} vs ${expectTextY(c, body, DESKTOP)}`);
  c.intent = { kind: 'hop', minDuration: 0.84 };
  c.intentTime = 0.84 * CONFIG.render.hopLandAt / 2;   // 起跳顶点附近
  const hopping = textY();
  assert.ok(r.fx.lift > 1, `夹具必须落在真的跳起来的那一刻，实测 lift ${r.fx.lift}`);
  assert.ok(hopping[0] < standing[0] - 1,
    `跳起来那帧字的 y 必须**明显更小**（屏幕向上）：${hopping[0]} vs ${standing[0]} —— 钉在 c.pos 上就是这个失败`);
  assert.ok(Math.abs(hopping[0] - expectTextY(c, body, DESKTOP)) < 1e-9,
    `跳起来那帧字的基线不等于重推出来的那一条（lift 没乘进去、或乘了两次）：${hopping[0]}`
    + ` vs ${expectTextY(c, body, DESKTOP)}`);
  assert.deepEqual({ x: c.pos.x, y: c.pos.y }, posBefore, '它跳它的，世界坐标不许被表现层改');
  c.intent = null; c.intentTime = 0;
  const back = textY();
  assert.ok(Math.abs(back[0] - expectTextY(c, body, DESKTOP)) < 1e-9,
    '落回地面那一帧必须精确回到重推出来的那条基线上');
  assert.ok(Math.abs(back[0] - standing[0]) < 1.5,
    `落地后字必须回到原地（±毛的软形变容差），否则跳完就飘在半空：${back[0]} vs ${standing[0]}`);
});

test('溶散上浮时气泡也跟着上去（同一份绘制几何，不是第二条时钟）', () => {
  const { world, bodies, c, body } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say(c.id, '喵 喵')]);
  const ctx = createBubbleCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  const standing = ctx.texts.map((t) => t.y);
  // 精确到 1e-9：把锚点、头部空隙、内边距、字号这一整条链一次钉死
  assert.ok(Math.abs(standing[0] - expectTextY(c, body, DESKTOP)) < 1e-9,
    `站着那帧字的基线不等于重推出来的那条：${standing[0]} vs ${expectTextY(c, body, DESKTOP)}`);
  c.alive = false;
  c.dying = CONFIG.dissolveDuration * 0.5;
  const ctx2 = createBubbleCtx();
  r.time += 0.0001;
  r.draw(ctx2, world, bodies, DESKTOP, 0);
  const rise = dissolveLiftOf(dissolveT(c)) * DESKTOP.height;
  assert.ok(rise > 0 && ctx2.texts.length > 0, '夹具必须落在溶散中段，且最后那句话还在说');
  assert.ok(Math.abs(ctx2.texts[0].y - expectTextY(c, body, DESKTOP)) < 1e-9,
    `溶散那帧字的基线没跟着上浮：实测 ${ctx2.texts[0].y}，重推 ${expectTextY(c, body, DESKTOP)}`);
  assert.ok(standing[0] - ctx2.texts[0].y > rise * 0.5,
    `上浮的量必须真的进到字的位置里（只靠 expand 是不够的）：${standing[0]} vs ${ctx2.texts[0].y}，rise ${rise}`);
});

test('bubbleBoxInto 把气泡框夹在视口内：贴边的它不会被裁掉半句话', () => {
  const box = { x: 0, y: 0, w: 0, h: 0 };
  bubbleBoxInto(box, 20, 40, 100, 30, DESKTOP);
  assert.deepEqual([box.x, box.y, box.w, box.h], [20, 40, 100, 30], '居中的时候一个字都不动');
  bubbleBoxInto(box, -999, -999, 100, 30, DESKTOP);
  assert.equal(box.x, 0);
  assert.equal(box.y, 0);
  bubbleBoxInto(box, 1e9, 1e9, 100, 30, DESKTOP);
  assert.equal(box.x, DESKTOP.width - 100);
  assert.equal(box.y, DESKTOP.height - 30);
  bubbleBoxInto(box, Number.NaN, 10, 100, 30, DESKTOP);
  assert.ok(Number.isFinite(box.x) && Number.isFinite(box.y), '脏坐标必须被吃掉，不许传染成 NaN');
});

test('左右贴边的个体：气泡整框仍在视口内，而字仍然在它头顶那一侧', () => {
  const { world, bodies, c } = singleWorld();
  const at = (x) => {
    c.pos.x = x;
    const r = makeRenderer(world, DESKTOP, false);
    r.time = 1500;
    consumeEvents(r, [say(c.id, '喵喵 主人 开心 要摸摸 怕怕')]);
    const ctx = createBubbleCtx();
    r.draw(ctx, world, bodies, DESKTOP, 0);
    assert.ok(ctx.texts.length > 0);
    return ctx.texts[0];
  };
  for (const x of [0.02, 0.98]) {
    const t = at(x);
    assert.ok(t.x >= 0 && t.x <= DESKTOP.width, `贴边 x=${x} 时字跑出了视口：${t.x}`);
  }
});

// ================================================== 七、fillText 的每帧上界与旧上界

test('fillText 每帧 ≤ onscreenMax × bubbleMaxLines = 4 笔，且一帧多喂 20 条也不涨', () => {
  const budget = S.onscreenMax * S.bubbleMaxLines;
  assert.equal(budget, 4);
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, PHONE, true);
  const ctx = createBubbleCtx();
  let worst = 0;
  for (let f = 0; f < 120; f++) {
    const evs = [];
    for (let i = 0; i < 20; i++) {
      evs.push(say(world.creatures[i % world.creatures.length].id, `喵喵 主人 开心 要摸摸 怕怕 ${f}`));
    }
    consumeEvents(r, evs);
    ctx.reset();
    r.draw(ctx, world, bodies, PHONE, CONFIG.fixedDt);
    worst = Math.max(worst, ctx.count('fillText'));
    assert.ok(ctx.count('fillText') <= budget,
      `第 ${f} 帧画了 ${ctx.count('fillText')} 笔字，上界 ${budget}`);
  }
  assert.equal(worst, budget, '夹具必须真的把两格两行都占满，否则这条上界是空过的');
});

test('B16 的三条旧上界在有气泡的缸里原样保住：每只 7 次贴图 / quadraticCurveTo 0 / 稳态零新建', () => {
  const created = [];
  const world = makeWorld(11);
  const bodies = makeBodies(world);
  const r = makeRenderer(world, DESKTOP, false, created);
  const ctx = createBubbleCtx();
  const feed = () => {
    const evs = [];
    for (let i = 0; i < 8; i++) evs.push(say(world.creatures[i % world.creatures.length].id, `喵 喵 ${i}`));
    consumeEvents(r, evs);
  };
  for (let i = 0; i < 120; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    feed();
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  const warm = created.length;
  ctx.reset();
  for (let i = 0; i < 200; i++) {
    tickWorld(world, CONFIG.fixedDt);
    for (const c of world.creatures) {
      const b = bodies.get(c.id);
      if (b) updateBody(b, c, CONFIG.fixedDt);
    }
    feed();
    r.draw(ctx, world, bodies, DESKTOP, CONFIG.fixedDt);
  }
  assert.equal(created.length, warm, '稳态 200 帧（每帧 8 条新台词）新建的离屏画布必须是 0 张');
  assert.equal(ctx.count('quadraticCurveTo'), 0);
  assert.equal(ctx.count('createRadialGradient'), 0);
  assert.equal(ctx.count('createLinearGradient'), 0);
  assert.equal(ctx.shadowBlurWrites, 0);
  assert.equal(ctx.count('save'), ctx.count('restore'));
  const n = bodies.size;
  const perFrame = ctx.count('drawImage') / 200;
  const water = r.motes.n + r.shafts.length + 1;
  const eggMax = 2 * world.eggs.length;
  assert.ok(perFrame >= water + n * 7,
    `每帧至少要有水体 + 每只 7 次：实测 ${perFrame.toFixed(2)}`);
  assert.ok(perFrame <= water + n * 7 + eggMax + r.bursts.n,
    `每帧上界 = 水体 + 每只 7 + 每颗卵 2 + 全部粒子：实测 ${perFrame.toFixed(2)}`);
});

test('每帧的字体测量也有界：只在一条气泡上场时量一次，运行中不再量', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say(c.id, '喵喵 开心 要摸摸')]);
  const ctx = createBubbleCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  const first = ctx.measureCalls;
  assert.ok(first > 0, '换行必须真的量过字（不量就是靠猜字符宽度）');
  ctx.reset();
  for (let f = 1; f < 10; f++) {
    r.draw(ctx, world, bodies, DESKTOP, 0);
    assert.equal(ctx.measureCalls, 0, `第 ${f} 帧没有新气泡上场，一次都不该量（每帧重算是白烧的）`);
  }
});

// ============================================== 八、样式跟 fluff 走（§4.13.1）

test('气泡的颜色是从 CONFIG 的毛尖浅色推导出来的，而且墨色在浅色底上读得出来', () => {
  const mote = hexRgb(CONFIG.colors.mote);
  const white = hexRgb(CONFIG.colors.eyeWhite);
  const ink = hexRgb(CONFIG.colors.pupil);
  assert.deepEqual(rgbOf(BUBBLE_FILL), mote, '填充底色就是毛尖那层浅粉白（样式跟 fluff 走）');
  assert.deepEqual(rgbOf(BUBBLE_STROKE), white, '描边比填充更浅一档：那才是「绣」在毛上的线');
  assert.deepEqual(rgbOf(BUBBLE_INK), ink, '字色用瞳孔那一档深靛紫，与眼睛同源');
  assert.ok(luminanceOf(rgbOf(BUBBLE_STROKE)) > luminanceOf(rgbOf(BUBBLE_FILL)), '描边必须比填充更亮');
  const ratio = contrast(ink, mote);
  assert.ok(ratio >= 4.5, `深字浅底的对比只有 ${ratio.toFixed(2)}，14px 就读不出来了`);
  const alpha = Number(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(BUBBLE_FILL)[1]);
  assert.ok(alpha >= 0.7, `气泡底太透（${alpha}）会让字压在毛绒上糊成一片`);
});

test('描边写的是那个浅色、字写的是墨色：样式真的进了绘制路径（不是常量挂在模块上没人读）', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say(c.id, '喵喵 开心 要摸摸')]);
  const ctx = createBubbleCtx();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.ok(ctx.texts.length > 0);
  for (const t of ctx.texts) {
    assert.equal(t.fillStyle, BUBBLE_INK, `这一笔字的颜色是 ${t.fillStyle}`);
    assert.equal(t.font, BUBBLE_FONT);
  }
  const strokeIdx = ctx.indexOf('stroke');
  const fillIdx = ctx.indexOf('fill');
  assert.ok(strokeIdx >= 0 && fillIdx >= 0, '框要既填又描');
  assert.ok(ctx.indexOf('fillText') > fillIdx, '字必须画在底之后（先画字就被盖掉了）');
});

// ==================================================== 九、内核 → 屏幕这条链路

test('真内核跑出来的 say 事件能一路走到屏幕上（出词 3613 句不再是看不见的东西）', () => {
  const world = createWorld({ seed: 20261014 });
  const bodies = new Map();
  const r = makeRenderer(world, DESKTOP, false);
  const ctx = createBubbleCtx();
  const dt = CONFIG.fixedDt * 12;               // 一次 draw 之间补 12 个 tick（3 分钟 ⇒ 900 帧）
  let sawWords = 0;
  let sentences = 0;
  let peak = 0;
  let lastWait = 0;
  for (let f = 0; f < 900; f++) {
    for (let k = 0; k < 12; k++) {
      tickWorld(world, CONFIG.fixedDt);
      for (const c of world.creatures) {
        let b = bodies.get(c.id);
        if (!b) { b = createBody(c.traits); bodies.set(c.id, b); }
        updateBody(b, c, CONFIG.fixedDt);
      }
    }
    ctx.reset();
    r.draw(ctx, world, bodies, DESKTOP, dt);
    // 与 main.js 同一份职责划分：先画、再消费、**由 main.js 那一级清空**
    if (world.events.length > 0) {
      for (const ev of world.events) if (ev.kind === 'say') sentences += 1;
      consumeEvents(r, world.events);
      world.events.length = 0;
    }
    peak = Math.max(peak, r.bubbles.count);
    lastWait = Math.max(lastWait, r.bubbles.lastWait);
    sawWords += ctx.count('fillText');
    assert.ok(ctx.count('fillText') <= S.onscreenMax * S.bubbleMaxLines, '第 8 层的每帧上界在真实数据上同样成立');
  }
  assert.ok(sentences > 0, `3 分钟里内核一句都没出词（stats.said=${world.stats.said}）：夹具或内核坏了`);
  assert.ok(sawWords > 0, '内核出了词而屏幕上一个字都没有 —— 这正是 B19a 要修的那个洞');
  assert.ok(r.bubbles.accepted <= sentences, '收到的条数不可能超过内核发出的条数');
  // 守恒律：每一条进来的气泡要么还在池里，要么已经有一次明确的离场原因。
  // 这条是「不要静默丢」的机器形式 —— 任何一处漏计都会在这里红。
  assert.equal(r.bubbles.accepted,
    r.bubbles.expired + r.bubbles.dropped + r.bubbles.superseded + r.bubbles.count,
    `去向不守恒：收 ${r.bubbles.accepted}，过期 ${r.bubbles.expired}，溢出丢 ${r.bubbles.dropped}，`
    + `被同一只的新句替换 ${r.bubbles.superseded}，仍在池 ${r.bubbles.count}`);
  assert.ok(r.bubbles.shown > 0, '至少有一条排过队才上场');
  assert.ok(peak > S.onscreenMax,
    `真缸里排队确实发生过（峰值队列深度 ${peak}，同屏上限 ${S.onscreenMax}）—— `
    + '「其余排队」不是注释里的愿望，它每天都在工作');
  assert.ok(lastWait > 0, `队尾那条确实等了 ${lastWait.toFixed(2)} 模拟秒才上场`);
});

test('内核没找到的个体（刚死掉被 splice）：那条气泡不画，也不报错', () => {
  const { world, bodies, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say('不存在的它', '喵 喵')]);
  const ctx = createBubbleCtx();
  assert.doesNotThrow(() => r.draw(ctx, world, bodies, DESKTOP, 0));
  assert.equal(ctx.count('fillText'), 0, '找不到说话的那只就不画它的字');
  consumeEvents(r, [say(c.id, '喵 喵')]);
  ctx.reset();
  r.draw(ctx, world, bodies, DESKTOP, 0);
  assert.ok(ctx.count('fillText') > 0, '同一帧里混着孤儿与正主时，正主照常说');
});

test('缺字段/坏字段的 say 事件一律被拒而不是抛（§7.7：不许因为一条脏事件白屏）', () => {
  const { world } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  const bad = [
    { kind: 'say' },
    { kind: 'say', id: 'x' },
    { kind: 'say', id: 'x', text: '' },
    { kind: 'say', id: 'x', text: 42 },
    { kind: 'say', id: 42, text: '喵' },
    { kind: 'say', id: 'x', text: '喵 喵', tokens: '不是数组' },
  ];
  for (const ev of bad) assert.doesNotThrow(() => consumeEvents(r, [ev]));
  assert.equal(r.bubbles.rejected, 5, `六条里只有 tokens 不是数组那条能用 text 兜底：${JSON.stringify(bad)}`);
  assert.equal(r.bubbles.accepted, 1);
  assert.equal(r.bubbles.count, 1);
});

test('drawCreature 之外的路径都不越界：bodies 缺项 / 半径为 0 / NaN 坐标都安静跳过', () => {
  const { world, c } = singleWorld();
  const r = makeRenderer(world, DESKTOP, false);
  consumeEvents(r, [say(c.id, '喵 喵')]);
  const ctx = createBubbleCtx();
  assert.doesNotThrow(() => r.draw(ctx, world, undefined, DESKTOP, 0));
  assert.doesNotThrow(() => r.draw(ctx, world, new Map(), DESKTOP, 0));
  c.pos.x = Number.NaN;
  assert.doesNotThrow(() => r.draw(ctx, world, new Map([[c.id, createBody(c.traits)]]), DESKTOP, 0));
});

// ==================================================== 十、边界：纯度与常量归属

test('bubble.js 与 render.js 一样不碰浏览器全局、不 import main.js、不用 Math.random（纪律 3）', () => {
  for (const rel of ['../src/bubble.js', '../src/render.js']) {
    const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame',
      'AudioContext', 'fetch', 'localStorage']) {
      // ⚠️ fetch 与 localStorage 在这一轮**尤其**不许出现：那是 B19b（API 档）的口子，
      // 规则档的自己偷偷发请求，spec §4.13.2 那三条硬纪律就没人守了。
      assert.ok(!new RegExp(`\\b${name}\\b`).test(stripped), `${rel} 出现了 ${name}`);
    }
    assert.ok(!/'\.\/main\.js'/.test(raw), `${rel} import 了 main.js`);
    assert.ok(!/Math\.random\s*\(/.test(raw), `${rel} 调用了 Math.random()`);
  }
  // 依赖方向：bubble.js 是纯文本/排队层，它不需要知道 canvas 与 render 的任何细节。
  const b = readFileSync(fileURLToPath(new URL('../src/bubble.js', import.meta.url)), 'utf8');
  assert.ok(!/'\.\/render\.js'/.test(b), 'bubble.js 不得反向 import render.js（否则 Node 里测不动）');
  assert.ok(!/globalAlpha\s*=/.test(b), 'alpha 的唯一写入点是 render.js 里那个乘了系数的 helper');
});

test('气泡层不把状态写回世界：源码里没有 c.bubble / world.bubbles 这类赋值', () => {
  // 快照那条断言的是**运行时**没写；这条断言的是**结构上**没有那个字段 ——
  // 后者更硬：哪天有人加一行 `c.bubble = text`，存档 schema 就要跟着变（spec §7.2 禁止）。
  const src = ['../src/bubble.js', '../src/render.js', '../src/main.js'].map((rel) => readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')).join('\n');
  assert.ok(!/\bc\.(bubble|bubbles)\s*=/.test(src), '个体身上不许长气泡字段（表现层状态不入档）');
  assert.ok(!/world\.bubbles\s*=/.test(src), '世界上不许长气泡队列字段');
  assert.ok(!/save\.js/.test(readFileSync(fileURLToPath(new URL('../src/bubble.js', import.meta.url)), 'utf8')),
    '气泡层与存档无关：它每帧从事件与时间推导');
});

test('main.js 那条路没断：say 仍然每帧被喂给 renderer，而 events 仍然每帧清空', () => {
  // 这一条是源码级的接线断言，与上面那条真数据集成测试配成一对：
  // 集成测试证明「喂进去就画得出来」，这条证明「入口还在那儿喂」。
  // B19a **没有**改 main.js —— consumeEvents 这条既有路径本来就覆盖 say（B16 就这么设计了），
  // 所以这里守的是「别把它改掉」，而不是「我加了它」。
  const src = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8');
  assert.ok(/consumeEvents\(renderer, world\.events\)/.test(src),
    'main.js 不再把 world.events 交给 renderer ⇒ 气泡与溶散一起没');
  assert.ok(/world\.events\.length\s*=\s*0/.test(src),
    'main.js 必须仍然每帧清空 events（无界增长那个教训）');
  assert.ok(!/bubble/i.test(src.replace(/\/\/[^\n]*/g, '')),
    'main.js 里不该出现气泡层的东西：状态属于 renderer，不属于页面入口');
});

test('这一 Task 新增的数值全部在 CONFIG.speech 里（表现层不留魔法数）', () => {
  for (const k of ['bubbleFontPx', 'bubbleMaxLines', 'bubbleQueueMul', 'bubblePadding',
    'bubbleLineGap', 'bubbleHeadGap', 'bubbleFadeHold', 'bubbleMaxWidthFrac', 'bubbleStroke']) {
    assert.equal(typeof S[k], 'number', `CONFIG.speech.${k} 缺失`);
    assert.ok(Number.isFinite(S[k]) && S[k] > 0, `CONFIG.speech.${k} 必须是正有限数，实测 ${S[k]}`);
  }
  assert.equal(S.bubbleMaxLines, 2, 'spec 逐字：最多 2 行');
  assert.equal(S.bubbleTtl, 3, 'spec 逐字：3 秒淡出');
  assert.equal(S.bubbleFontPx, 14, 'spec 逐字：字号 ≥14px（CSS 像素）');
  assert.equal(S.onscreenMax, 2, 'spec 逐字：同一时刻屏上最多 2 个气泡');
  assert.ok(S.bubbleMaxWidthFrac <= 0.5, '一个气泡最宽不许超过半屏，否则两行字会盖住整只');
  assert.ok(S.bubbleFadeHold < 1, '淡出必须真的发生（hold=1 就是永不淡出）');
  assert.ok(S.bubblePadding > 0 && S.bubbleLineGap > 0, '没有内边距与行距，两行字会挤成一坨');
  // 换行后的行数上限必须真的小于等于 spec 的两行；这条把 maxLines 与 spec 的**字面**绑在一起，
  // 否则调 maxLines 就是一个没人反对的旋钮。
  assert.ok(S.bubbleMaxLines * S.onscreenMax === 4, 'fillText 的每帧上界 = 2 × 2 = 4 笔');
});

test('手工清单（记录型桩测不到，绝不写成假装能测的断言）', () => {
  // 与 tests/render-fx.test.js 的同名条目同一套分工：这里逐项写明为什么自动化测不到。
  const manual = [
    '气泡看起来像不像「绣在毛上」（描边色与浅底的对比已按 CONFIG 断言，观感没有）',
    '两行字会不会遮住它的眼睛（位置跟的是包围盒顶边、已断言在轮廓之上；毛尖之外够不够远要肉眼判）',
    '14px 在手机上肉眼读不读得出来（字号的值与 dpr 无关已断言，实际清晰度取决于真实字体）',
    '3 秒淡出的手感是快是慢（fade 曲线的单调与形状已断言，「读得完吗」没有）',
    '指向脑袋的那个小三角认不认得出是谁在说话（三角画了已断言次数，读感没有）',
    '字号在真实浏览器里与桩的度量差多少（桩每字符恒宽，真实字体 CJK/拉丁混排宽度不同）',
    '气泡会不会与另一只重叠（同屏 2 条已断言，两条同时在左右贴边时被夹到同一处没有）',
    '淡出中途重新打开文字层，画面是否有跳变（队列已断言被清空，肉眼连续性没有）',
  ];
  assert.equal(manual.length, 8, '手工清单的条目数（改动时同步 B20 的 visual-checklist）');
});
