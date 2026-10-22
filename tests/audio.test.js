import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { createCreature } from '../src/creature.js';
import { createRng } from '../src/rng.js';
import { adjust, PLAYER_ID } from '../src/memory.js';
import { boot } from '../src/main.js';
import {
  voiceFor, huePosition, idSeed, crossedUp, landingCrossed, hopPhase,
  callForEvent, planSound, cooldownReady, createAudio, CALL_KEYS, DETECTORS, referenceVoice,
} from '../src/audio.js';

// ==================================================================== 说明
//
// B18：spec §5.4 的程序化叫声。本文件守的四组硬要求，逐组对应下面各节：
//   · 六声表的**数**（600→900、400→200、90–140、下滑、碎裂、极轻）与音高随体型、
//     音色随色相那两条 headline（§5.4 的"每条血脉有自己的嗓音"）。
//   · 两条通道**不许同步**（§5.4 那条 2026-10-20 修订）：`say` 只许带出那记「啾」，
//     而「啾」的参数**只由体型与色相推导**，读一下 ev.mood 就当场作废。
//   · 状态有上界 + 节点不漏（§7.2 / §5.3 / §7.7）。
//   · main.js 是唯一有 AudioContext 的文件，且首帧手势之前不许创建它（§5.4 末段）。
//
// ⚠️⚠️ 桩与 canvas 那套（tests/render-*.test.js）**故意不一样**：这里必须记**数值**。
// 那三套桩刻意只记"哪个方法被调用、按什么顺序"，因为绘制的正确性判据是**调用序列**
// （层序、每只几次贴图），把参数记下来只会让每次视觉微调都变成脆断。
// 叫声层不是：本文件的核心断言全是**值**层面的 ——
//   · "音高随体型变"= 同一个 planSound 换一只小的，记下来的 frequency 读数必须更高。
//   · "600→900"= 那两个数本身。
//   · 「啾」与心情无关 = 换 mood 之后全部读数**逐字节相同**。
// 这三条**没有一条**能用"创建了几只振荡器"表达：把 900 改成 600、把音高因子写成常数、
// 把 ev.mood 乘进频率，节点数一个都不变（B16 的探针 P7 已经证明过这一类失败的形式）。
// 所以这里破例记值。**别把它"修回"成只数次数** —— 那等于把 B18 的全部判据删掉。
// 序列证据仍然留着（connect/disconnect 的顺序与计数），它守的是"不漏节点"那一条。

const AUD = CONFIG.audio;
const SRC = (name) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------- 记录型音频图桩

function makeParam(owner, name, g) {
  const p = {
    __param: true,
    owner,
    name,
    writes: [],
  };
  // 每个参数**自己留一份读数**，同时也进全局有序日志：
  // 前者给"这只总线被推到 0 了吗"这种单点问题用，后者给顺序与快照比对用。
  const push = (kind, v, t) => {
    p.writes.push({ kind, v, t });
    g.log.push({ op: 'param', node: owner, param: name, kind, v, t });
  };
  p.setValueAtTime = (v, t) => push('set', v, t);
  p.linearRampToValueAtTime = (v, t) => push('lin', v, t);
  p.exponentialRampToValueAtTime = (v, t) => push('exp', v, t);
  p.setTargetAtTime = (v, t) => push('target', v, t);
  p.cancelScheduledValues = (t) => push('cancel', null, t);
  return p;
}

function describeTarget(g, dest) {
  if (!dest) return 'null';
  if (dest === g.destination) return 'destination';
  if (dest.__param) return `param:${dest.owner.tag}#${dest.owner.nid}.${dest.name}`;
  if (dest.tag) return `node:${dest.tag}#${dest.nid}`;
  return 'unknown';
}

function createGraphStub(opts) {
  const o = opts || {};
  const g = {
    currentTime: 0,
    sampleRate: 44100,
    nodes: [],
    log: [],
    buffers: [],
    counts: { osc: 0, gain: 0, biquad: 0, source: 0 },
    destination: { tag: 'destination', nid: -1 },
    advance(dt) { g.currentTime += dt; },
    byTag(tag) { return g.nodes.filter((n) => n.tag === tag); },
    // 快照：**全部读数**，含参数值、start/stop 时刻、connect 目标。
    // 用它做"换个 mood 之后逐字节相同"这条纪律断言 —— 序列与值都在里面。
    snap() {
      return JSON.stringify({
        nodes: g.nodes.map((n) => ({
          tag: n.tag,
          nid: n.nid,
          type: n.type === undefined ? null : n.type,
          buffer: n.buffer === null || n.buffer === undefined ? null : `buf:${n.buffer.length}@${n.buffer.sampleRate}`,
          connects: n.connects.map((d) => describeTarget(g, d)),
          disconnects: n.disconnects,
          starts: n.starts.slice(),
          stops: n.stops.slice(),
        })),
        params: g.log.filter((e) => e.op === 'param')
          .map((e) => `${e.node.tag}#${e.node.nid}.${e.param}:${e.kind}(${round(e.v)},${round(e.t)})`),
      });
    },
    freqWrites(tag) {
      return g.log.filter((e) => e.op === 'param' && e.param === 'frequency'
        && (tag === undefined || e.node.tag === tag))
        .map((e) => ({ kind: e.kind, v: e.v, t: e.t, nid: e.node.nid }));
    },
  };
  let seq = 0;
  const add = (tag, node) => { node.tag = tag; node.nid = seq; seq += 1; g.nodes.push(node); return node; };
  const behavior = (n) => {
    n.connects = [];
    n.disconnects = 0;
    n.starts = [];
    n.stops = [];
    n.connect = (dest) => {
      n.connects.push(dest);
      g.log.push({ op: 'connect', node: n, dest });
      return dest;
    };
    n.disconnect = () => { n.disconnects += 1; g.log.push({ op: 'disconnect', node: n }); };
    return n;
  };
  g.createGain = () => {
    g.counts.gain += 1;
    const n = behavior({});
    n.gain = makeParam(n, 'gain', g);
    return add('gain', n);
  };
  g.createOscillator = () => {
    g.counts.osc += 1;
    const n = behavior({ type: 'sine' });
    n.frequency = makeParam(n, 'frequency', g);
    n.detune = makeParam(n, 'detune', g);
    n.start = (t) => { n.starts.push({ t }); };
    n.stop = (t) => { n.stops.push({ t }); };
    return add('osc', n);
  };
  if (o.noFilter !== true) {
    g.createBiquadFilter = () => {
      g.counts.biquad += 1;
      const n = behavior({ type: '' });
      n.frequency = makeParam(n, 'frequency', g);
      n.Q = makeParam(n, 'Q', g);
      n.gain = makeParam(n, 'gain', g);
      return add('filter', n);
    };
  }
  if (o.noNoise !== true) {
    g.createBuffer = (ch, len, rate) => {
      const buf = {
        numberOfChannels: ch, length: len, sampleRate: rate, data: [],
        getChannelData(i) {
          if (!buf.data[i]) buf.data[i] = new Float32Array(len);
          return buf.data[i];
        },
      };
      g.buffers.push(buf);
      return buf;
    };
    g.createBufferSource = () => {
      g.counts.source += 1;
      const n = behavior({ buffer: null });
      n.playbackRate = makeParam(n, 'playbackRate', g);
      n.start = (t, offset) => { n.starts.push({ t, offset: offset === undefined ? null : offset }); };
      n.stop = (t) => { n.stops.push({ t }); };
      return add('source', n);
    };
  }
  return g;
}

// 快照比对要把浮点尾巴固定住：同一次计算的两个副本必然逐位相同，
// 但"相同"这件事不该依赖 IEEE754 的巧合 —— 六位在断言里读得出来也更像人写的数。
function round(v) {
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return String(v);
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------- 造个体与假世界

const RNG = createRng(20261022);

// 真 creature（traits/needs/emotions/memory 全套），但 traits 的 size/hue **一律显式钉住**：
// createCreature 会从共享的 RNG 抽基因组，不钉住的话同一个 id 在两次 run 里长出不同的色相，
// "跑两遍读数必须逐字节相同"那条断言就会因为造个体的随机性而假红。
function creature(id, sizeGene, hueGene, overrides) {
  const c = createCreature({ id, rng: RNG, x: 0.4, y: 0.5 });
  c.traits.size = sizeGene === undefined ? 26 : sizeGene;
  c.traits.hue = hueGene === undefined ? CONFIG.hueRange[0] : hueGene;
  c.age = overrides && overrides.age !== undefined ? overrides.age : 600;
  c.stage = overrides && overrides.stage ? overrides.stage : 'adult';
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      if (k === 'age' || k === 'stage') continue;
      if (k === 'emotions') Object.assign(c.emotions, overrides[k]);
      else if (k === 'needs') Object.assign(c.needs, overrides[k]);
      else c[k] = overrides[k];
    }
  }
  return c;
}

const fakeWorld = (list) => ({ time: 0, creatures: list, events: [] });

const sayEvent = (id, mood, text) => ({ kind: 'say', id, text: text || '喵喵', tokens: ['喵喵'], mood });

function makeAudio(creatures, opts) {
  const g = createGraphStub(opts);
  const a = createAudio({ graph: g });
  a.consume([], fakeWorld(creatures || []));        // 第一帧只建 entry，不发声
  g.log.length = 0; g.nodes.length = 0;             // 清零，下面的断言只看这一次之后发生的
  return { g, a };
}

// ======================================================== 〇、桩确实记的是值

test('桩记的是数值而不是次数：一记「啾」之后频率读数与包络都在快照里', () => {
  const c = creature('c-a', 26, 315);
  const { g, a } = makeAudio([c]);
  a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  const writes = g.freqWrites('osc');
  assert.ok(writes.length >= 2, `至少要有起值与滑到值，实测 ${writes.length}`);
  assert.equal(writes[0].kind, 'set');
  assert.ok(writes.some((w) => w.kind === 'lin'), '频率滑音必须是 lin 读数');
  // 反空转：若这个桩退化成只数次数，snap() 就不会含任何数字读数。
  assert.ok(g.snap().includes('('), 'snap 里必须看得见参数值');
});

// ======================================================== 一、嗓音：音高随体型、音色随色相

test('voiceFor：体型越小音高越高（全区间不增，中段严格递减）', () => {
  const hue = CONFIG.hueRange[0];
  const sizes = [CONFIG.minSize, 16, 20, 26, 32, CONFIG.maxSize];
  let prev = Infinity;
  for (const s of sizes) {
    const v = voiceFor(s, hue);
    assert.ok(v.pitch <= prev + 1e-12, `size ${s} 的音高比更大体型还高：${v.pitch} > ${prev}`);
    prev = v.pitch;
  }
  // 严格递减只在 clamp 之内成立；两端触顶/触底是**有意的**（否则刚孵化的 5.7 会叫到超声）。
  const mid = [16, 20, 26, 32].map((s) => voiceFor(s, hue).pitch);
  for (let i = 1; i < mid.length; i += 1) {
    assert.ok(mid[i] < mid[i - 1], `中段音高没随体型下降：${mid.join(' → ')}`);
  }
  assert.ok(voiceFor(CONFIG.minSize, hue).pitch > voiceFor(CONFIG.maxSize, hue).pitch,
    '最小与最大的两只必须听得出高低，否则这条 headline 等于没实现');
});

test('voiceFor：音高因子被 clamp 在 CONFIG 两端（极端幼体不许尖叫到超声）', () => {
  const hue = CONFIG.hueRange[0];
  assert.equal(voiceFor(1, hue).pitch, AUD.pitchMax, '小到极点也只到上限');
  assert.equal(voiceFor(1e6, hue).pitch, AUD.pitchMin);
  // 参考体型必须是 1.0 —— 表里那些 Hz 就是给这只定的。
  assert.equal(voiceFor(AUD.refSize, hue).pitch, 1);
  // 脏输入不许变 NaN（NaN 会让频率读数不可用，而 Web Audio 只是静默不响）
  assert.ok(Number.isFinite(voiceFor(NaN, hue).pitch));
  assert.ok(Number.isFinite(voiceFor(0, hue).pitch));
  assert.ok(Number.isFinite(voiceFor(undefined, undefined).pitch));
});

test('voiceFor：同一家族（同桶）一副嗓子，跨家族一定分家 —— 这就是"血脉听得出来"', () => {
  // 粉色区间 315°→25°（跨 0°），12 个桶 ⇒ 每桶约 5.8°。同桶的两个色相必须**完全相同**。
  const a = voiceFor(26, CONFIG.hueRange[0]);                    // 315°，桶 0
  const b = voiceFor(26, CONFIG.hueRange[0]);
  assert.deepEqual(a, b, '同色相同体型的嗓音必须逐字段相同');
  const step = 70 / AUD.hueBuckets;                              // 一桶的宽度
  const near = voiceFor(26, (CONFIG.hueRange[0] + step * 0.5 - 360 + 360) % 360);
  assert.equal(near.hueBucket, a.hueBucket, '桶内的色相应当落进同一桶');
  assert.equal(near.filterRatio, a.filterRatio, '同桶 ⇒ 同一副共鸣');
  assert.equal(near.overtoneRatio, a.overtoneRatio);
  // 跨桶的两只：两件音色量都必须不同
  const far = voiceFor(26, (CONFIG.hueRange[0] + step * (AUD.hueBuckets - 1) + step * 0.5) % 360);
  assert.notEqual(far.hueBucket, a.hueBucket);
  assert.notEqual(far.filterRatio, a.filterRatio);
  assert.notEqual(far.overtoneRatio, a.overtoneRatio, '不同色相 ⇒ 不同倍音比（血脉分家的读数）');
});

test('huePosition：区间两端是 0 与 1，跨 0° 那一段不许翻回另一端', () => {
  assert.equal(huePosition(CONFIG.hueRange[0]), 0);
  assert.equal(huePosition(CONFIG.hueRange[1]), 1);
  assert.equal(huePosition(0), 45 / 70, '0°（正红）在 315→25 这条弧上位置是 45/70');
  assert.ok(huePosition(180) >= 0 && huePosition(180) <= 1, '区间外的色相必须 clamp 而不是给负数');
});

test('idSeed：同一 id 永远同一个数，不同 id 分开，且一个随机数都不消费', () => {
  assert.equal(idSeed('c-7'), idSeed('c-7'));
  assert.notEqual(idSeed('c-7'), idSeed('c-8'));
  assert.ok(Number.isFinite(idSeed(undefined)) && idSeed(undefined) === idSeed(''));
  // 这条是"生气的抖动速率由 id 派生"的地基：它必须是个整数
  assert.equal(Math.floor(idSeed('c-7')), idSeed('c-7'));
});

test('crossedUp：只有上跨那一条算事件，滞留在阈值之上不算', () => {
  assert.equal(crossedUp(0.4, 0.5, 0.5), true);
  assert.equal(crossedUp(0.5, 0.6, 0.5), false, '已经在阈上又涨了一点 ⇒ 不是一件事');
  assert.equal(crossedUp(0.6, 0.4, 0.5), false, '下穿不算');
  // 坏读数一律按 0 处理（num() 的兜底）。两个方向都要有断言，因为这一条防的是两种不同的失效：
  //   · cur 是 NaN ⇒ 兜底成 0，永远跨不过去 ⇒ **不许响**（乱响比不响糟：那是在给一个坏个体配音）
  //   · prev 是 NaN ⇒ 兜底成 0，等价于"从零跨上去" ⇒ 允许响。真实的 entry 里 prev 永远由
  //     同一个 num() 兜底过，所以这一支不可达；留着断言是为了将来谁把兜底改成 -Infinity 时看得见。
  assert.equal(crossedUp(0, NaN, 0.5), false, '读数坏掉时**静默**，而不是乱响');
  assert.equal(crossedUp(NaN, 0.9, 0.5), true, '坏的上帧读数按 0 处理 ⇒ 与"从零跨上去"同一条路径');
});

test('landingCrossed：跳过落地点仍然恰好一次（4× 的判据形状）', () => {
  const land = CONFIG.render.hopLandAt;
  assert.equal(landingCrossed(land - 0.05, land + 0.05), true, '跨过 ⇒ 响');
  assert.equal(landingCrossed(0.3, 0.9), true, '大步跨过 ⇒ 响（相等判据在这里永远不响）');
  assert.equal(landingCrossed(land + 0.05, land + 0.1), false, '已在落地之后 ⇒ 不重复');
  assert.equal(landingCrossed(-1, 0.9), false, '上一帧不在 hop 里 ⇒ 那不是它跳的一次落地');
  assert.equal(landingCrossed(0.2, land), true, '落在点上（>=）算跨过');
});

test('hopPhase：只读 intent.kind/intentTime/intent.minDuration，非 hop 给 -1', () => {
  assert.equal(hopPhase({ intent: null }), -1);
  assert.equal(hopPhase({ intent: { kind: 'forage', minDuration: 1 }, intentTime: 0.5 }), -1);
  const c = { intent: { kind: 'hop', minDuration: 2 }, intentTime: 1 };
  assert.equal(hopPhase(c), 0.5, '时长必须读 intent.minDuration（内核那条随 activity 的公式），不在这里另抄');
  assert.equal(hopPhase({ intent: { kind: 'hop', minDuration: 1 }, intentTime: 9 }), 1, '超出窗口 clamp 在 1');
  assert.equal(hopPhase({ intent: { kind: 'hop', minDuration: 0 }, intentTime: 1 }), -1, '0 时长是脏值，不许除');
});

test('callForEvent：内核 11 种事件里只有 say / hatch / death 出声明声', () => {
  // §5.4.1 第 2 条的裁定：其余 kinds 的表里没有对应行，**不许凭空造音色**。
  const sounding = { say: 'chirp', hatch: 'hatch', death: 'death' };
  const silent = ['eat', 'laid', 'poke', 'dissolved', 'drift', 'emigrate', 'eggFailed', 'error'];
  for (const k of Object.keys(sounding)) assert.equal(callForEvent(k), sounding[k]);
  for (const k of silent) assert.equal(callForEvent(k), null, `${k} 不该有叫声`);
  assert.equal(callForEvent('unknown'), null);
  assert.equal(callForEvent(undefined), null);
});

// ======================================================== 二、六声表 + 两条增量

test('开心：两声短促上滑正弦，参考体型上逐字等于 spec 的 600→900Hz', () => {
  const v = voiceFor(AUD.refSize, CONFIG.hueRange[0]);
  const p = planSound('joy', v, 10, 0);
  assert.equal(p.parts.length, AUD.joy.reps, 'spec 逐字"两声"');
  for (const part of p.parts) {
    assert.equal(part.wave, 'sine', 'spec 逐字"正弦"');
    assert.equal(round(part.from), 600);
    assert.equal(round(part.to), 900);
    assert.ok(part.to > part.from, '必须是**上滑**');
    assert.ok(part.dur <= 0.12, `短促：单声 ${part.dur}s 太长了`);
  }
  assert.ok(p.parts[1].start > p.parts[0].start + p.parts[0].dur, '两声之间要有缝，否则是一个滑音不是两声');
});

test('卖萌：快速下滑 400→200 + 一点气泡噪声', () => {
  const p = planSound('beg', voiceFor(AUD.refSize, 315), 0, 3);
  const tone = p.parts.filter((x) => x.kind === 'osc');
  assert.equal(tone[0].from, 400);
  assert.equal(tone[0].to, 200);
  assert.ok(tone[0].to < tone[0].from, 'spec 逐字"下滑"');
  const noise = p.parts.filter((x) => x.kind === 'noise');
  assert.equal(noise.length, AUD.beg.noiseCount, '"一点气泡噪声"必须是噪声层，不是又一只振荡器');
  assert.ok(noise[0].peak < tone[0].peak, '噪声是从属层，不能盖过那一声明');
});

test('生气：低沉 90–140Hz 带轻微抖动，抖动速率由 id 派生而不是随机数', () => {
  const p = planSound('anger', voiceFor(AUD.refSize, 315), 0, 5);
  const tone = p.parts[0];
  assert.ok(tone.from <= 140 && tone.from >= 90, `起音 ${tone.from} 必须落在 spec 的 90–140 区间里`);
  assert.ok(tone.to <= 140 && tone.to >= 90, `滑到 ${tone.to} 同上`);
  assert.ok(p.filter.hz > tone.from, '这一行的低通中心必须在基频之上，否则砍掉的就是基频本身（变成音量而非音色）');
  assert.ok(p.lfo, '"轻微抖动"必须是频率调制');
  assert.ok(p.lfo.depthHz > 0 && p.lfo.rate > 0);
  // 确定性：同 seed 两次完全一致；不同 seed 的抖动速率不同 ⇒ 每只的呼噜节奏不一样
  assert.deepEqual(planSound('anger', voiceFor(26, 315), 0, 5), p);
  assert.notEqual(planSound('anger', voiceFor(26, 315), 0, 6).lfo.rate, p.lfo.rate);
  // 它是全表最低的一档音区（除了落地那记）
  const others = ['joy', 'beg', 'sleepy', 'hatch', 'death', 'chirp']
    .map((k) => planSound(k, voiceFor(26, 315), 0, 1).parts[0].from);
  assert.ok(Math.min(...others) > tone.from, `生气必须比谁都低：${tone.from} vs ${Math.min(...others)}`);
});

test('困倦：长、缓降、柔和起音', () => {
  const p = planSound('sleepy', voiceFor(26, 315), 0, 1);
  const tone = p.parts[0];
  assert.ok(tone.to < tone.from, 'spec 逐字"下滑"');
  const longRows = ['joy', 'beg', 'chirp', 'thud'].map((k) => planSound(k, voiceFor(26, 315), 0, 1).total);
  assert.ok(tone.dur > Math.max(...longRows), `"长缓慢"：${tone.dur} 必须明显长于其它各行`);
  assert.ok(tone.attack / tone.dur > 0.2, `柔和起音：attack 要占音长的可观一段，实测 ${tone.attack / tone.dur}`);
});

test('孵化：细碎裂声 + 一个上扬小音', () => {
  const p = planSound('hatch', voiceFor(26, 315), 0, 2);
  const tone = p.parts[0];
  assert.ok(tone.to > tone.from, '上扬');
  const noise = p.parts.filter((x) => x.kind === 'noise');
  assert.ok(noise.length >= 3, `"细致"必须是多个短段，实测 ${noise.length}`);
  for (const n of noise) assert.ok(n.dur < tone.dur / 3, `每一段都要**细**：${n.dur}`);
});

test('死亡：极轻的下滑音，几乎听不见', () => {
  const p = planSound('death', voiceFor(26, 315), 0, 1);
  const tone = p.parts[0];
  assert.ok(tone.to < tone.from, '下滑');
  const peaks = CALL_KEYS.map((k) => planSound(k, voiceFor(26, 315), 0, 1).parts[0].peak);
  assert.equal(tone.peak, Math.min(...peaks), `peak 必须是全表最低一档：${tone.peak} vs ${Math.min(...peaks)}`);
});

test('落地闷响（计划 2 增量）：低音、极短，且音高只打折一半', () => {
  const small = voiceFor(CONFIG.minSize, 315);
  const big = voiceFor(CONFIG.maxSize, 315);
  const ps = planSound('thud', small, 0, 1);
  const pb = planSound('thud', big, 0, 1);
  assert.equal(AUD.thud.pitchMix, 0.5, '闷响的基频已经贴地，全额乘音高会把大只推到次声（见 CONFIG 那段注释）');
  assert.ok(ps.parts[0].from > pb.parts[0].from, '小的落地仍要更高');
  assert.ok(pb.parts[0].to >= 40, `落地不许掉进次声：${pb.parts[0].to}Hz`);
  assert.ok(ps.total < AUD.sleepy.noteSec, '闷响必须极短，否则是"嗯——"不是"咚"');
});

test('出词前那记「啾」（计划 2 增量）：全表最短的一记', () => {
  const p = planSound('chirp', voiceFor(26, 315), 0, 1);
  for (const k of CALL_KEYS) {
    if (k === 'chirp') continue;
    assert.ok(p.total <= planSound(k, voiceFor(26, 315), 0, 1).total,
      `「啾」必须是最短的（spec 逐字"极短"）：${p.total} vs ${k}`);
  }
  assert.ok(p.parts[0].to > p.parts[0].from, '啾是往上挑的一记');
});

test('每一行的频率都乘了体型因子 —— 表里的数是**参考体型**那一只的', () => {
  // 这条就是 §5.4 那句 headline 的实现证据：把音高因子写成常数会在这里红。
  const small = voiceFor(CONFIG.minSize, 315);
  const big = voiceFor(CONFIG.maxSize, 315);
  assert.ok(small.pitch > 1 && big.pitch < 1);
  for (const k of CALL_KEYS) {
    const ps = planSound(k, small, 0, 1).parts[0];
    const pb = planSound(k, big, 0, 1).parts[0];
    assert.ok(ps.from > pb.from, `${k}：小的起音不比大的高 ⇒ 音高没随体型走`);
    assert.ok(ps.to > pb.to, `${k}：小的滑到点不比大的高 ⇒ 同上`);
    // 全额那几行必须**正好**是倍率之比（打折的只有落地闷响）
    const mix = AUD[k].pitchMix;
    if (mix === 1) {
      const expect = (1 + (small.pitch - 1) * mix) / (1 + (big.pitch - 1) * mix);
      assert.ok(Math.abs(ps.from / pb.from - expect) < 1e-9, `${k} 的音高倍率不对`);
    }
  }
});

test('音色两件都相对基频：换体型时低通中心与倍音跟着走，换色相时它们分家', () => {
  const a = planSound('joy', voiceFor(14, 315), 0, 1);
  const b = planSound('joy', voiceFor(38, 315), 0, 1);
  assert.ok(a.filter.hz > b.filter.hz, '同一系的两只：小的滤波器中心也更高（相对基频）');
  assert.ok(Math.abs(a.filter.hz / a.parts[0].to - b.filter.hz / b.parts[0].to) < 1e-9,
    '中心/基频 的比必须只由色相决定');
  const c = planSound('joy', voiceFor(26, CONFIG.hueRange[1]), 0, 1);
  assert.notEqual(c.overtone.ratio, a.overtone.ratio, '不同色相 ⇒ 不同倍音比（血脉分家）');
  assert.ok(c.overtone.peak < a.parts[0].peak, '倍音是从属共鸣，不许与主声同响');
});

test('planSound 零随机数：同一入参跑两次 deepEqual；未知叫声名抛错', () => {
  const v = voiceFor(21, 340);
  assert.deepEqual(planSound('hatch', v, 3.25, 17), planSound('hatch', v, 3.25, 17));
  assert.throws(() => planSound('nope', v, 0, 0), /未知叫声/);
  // 没有 voice 时用参考嗓音，不许 NaN
  const p = planSound('joy', null, 0, 0);
  assert.ok(Number.isFinite(p.parts[0].from) && Number.isFinite(p.filter.hz));
});

test('attack 永远不超过音长（短促那两行不许听起来又小又慢）', () => {
  for (const k of CALL_KEYS) {
    const p = planSound(k, referenceVoice(), 0, 1);
    for (const part of p.parts) {
      assert.ok(part.attack <= part.dur, `${k} 的起音比音长还长：${part.attack} > ${part.dur}`);
      assert.ok(part.peak > 0 && part.peak <= 1, `${k} 的 peak 不是可用增益`);
    }
  }
});

// ======================================================== 三、调度：两条通道的纪律

test('「啾」与心情**无关**：同一条 say 换 mood，桩记下的读数逐字节相同', () => {
  // 这是本 Task 的核心一条（spec §5.4 的 2026-10-20 修订）。
  // 判据形状刻意是"逐字节相同"而不是"某些数不同"：配音一旦进来，改的是频率、
  // 增益、时长里的**任意一个**，所以整份读数快照必须参与比对。
  const moods = ['happy', 'anger', 'sad', 'bliss', 'calm', undefined, null];
  const base = creature('c-chirp', 22, 330);
  const runs = moods.map((mood) => {
    const g = createGraphStub({});
    const a = createAudio({ graph: g });
    a.consume([], fakeWorld([base]));                 // 建 entry，不发声
    g.snap();                                         // 取基线（总线那一笔不参与？见下面 strip）
    a.consume([sayEvent(base.id, mood, '喵喵')], fakeWorld([base]));
    return { snap: g.snap(), params: g.freqWrites().map((w) => `${w.kind}:${round(w.v)}@${round(w.t)}`) };
  });
  for (let i = 1; i < runs.length; i += 1) {
    assert.equal(runs[i].snap, runs[0].snap, `mood=${moods[i]} 改变了发声读数 ⇒ 两条通道塌成一条`);
    assert.deepEqual(runs[i].params, runs[0].params);
  }
  // 反空转：这一串确实发出了声音
  assert.ok(runs[0].params.length > 0, '一条都没记到读数 ⇒ 上面那条比的是两个空字符串');
});

test('「啾」随体型变：两只不同大小的 say，频率读数必须不同（§9.2 第 8 条）', () => {
  const small = creature('c-small', CONFIG.minSize, 315);
  const big = creature('c-big', CONFIG.maxSize, 315);
  const as = makeAudio([small, big]);
  const bs = makeAudio([small, big]);
  as.a.consume([sayEvent(small.id, 'calm')], fakeWorld([small]));
  bs.a.consume([sayEvent(big.id, 'calm')], fakeWorld([big]));
  const f = as.g.freqWrites('osc');
  const s = bs.g.freqWrites('osc');
  assert.ok(f.length > 0 && s.length > 0);
  assert.ok(f[0].v > s[0].v, `小的那记啾必须更高：${f[0].v} vs ${s[0].v}`);
});

test('say 事件绝不触发六声表里的那六声（不许给台词配音）', () => {
  const c = creature('c-say', 26, 315);
  const { a, g } = makeAudio([c]);
  for (const mood of ['happy', 'bliss', 'anger', 'sad']) {
    // ⚠️ 这句 advance **不是装饰**：啾有一条全局闸门（下面几条测试钉它），同一秒里连喂四条
    // 只会响一记。这条测试的判据是"六声表一声都不许响"，为了让四条都真的上过场，
    // 就把时钟推到闸门之外 —— 否则 chirp=1 会被误读成"配音失败了"。
    g.advance(AUD.chirpGapSec + 0.01);
    a.consume([sayEvent(c.id, mood)], fakeWorld([c]));
  }
  assert.equal(a.stats.calls.joy, 0, '说了"开心"不许放开心那一声明');
  assert.equal(a.stats.calls.anger, 0);
  assert.equal(a.stats.calls.beg, 0);
  assert.equal(a.stats.calls.sleepy, 0);
  assert.equal(a.stats.calls.chirp, 4, '四条 say ⇒ 四记啾');
});

// ---- 「啾」的全局闸门（2026-10-22 实测之后补的，理由见 spec §5.4.1 第 5 条）----
// 实测数出来的，不是估的：跑 60 分钟一缸（seed 20261022、cap 24）出词 2755 句，
// **最坏的单秒有 5 句**、最坏的三秒滑窗 8 句 ⇒ 倍速 4× 下换算是 **20 记啾/真实秒**。
// 单音长只有 0.045s，二十记挤在一秒里就是嗡嗡一片，而那一记的职责本是"这声音是它自己发的"。
// 事件通道不过每只的冷却（冷却是给跨越那六声用的），所以这一条必须有**全局**闸门 ——
// 与闷响的 thudGapSec 同一个理由：拦的是"多只同时"，不是"同一只太快"。

test('同一秒里连喂 5 条 say 只响一记啾，其余**计数**丢弃（不静默）', () => {
  const c = creature('c-burst', 26, 315);
  const { a } = makeAudio([c]);
  const before = a.stats.calls.chirp;
  let droppedBefore = a.stats.chirpDropped;
  for (let i = 0; i < 5; i += 1) a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  assert.equal(a.stats.calls.chirp, before + 1, '闸门之内只许响一记');
  assert.equal(a.stats.chirpDropped, droppedBefore + 4, '被挤掉的四记必须有读数：§7.7 禁止静默丢');
});

test('闸门走的是 graph 秒（真实秒），不是模拟秒：倍速再快也拦得住', () => {
  const c = creature('c-gate', 26, 315);
  const { a, g } = makeAudio([c]);
  a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  const first = a.stats.calls.chirp;
  // 差一点点：仍然拦得住（边界不是"下一帧就放行"）
  g.advance(AUD.chirpGapSec * 0.5);
  a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  assert.equal(a.stats.calls.chirp, first, '只走了半个闸门就放行 ⇒ 闸门形同虚设');
  g.advance(AUD.chirpGapSec);
  a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  assert.equal(a.stats.calls.chirp, first + 1, '闸门过了还不响 ⇒ 这条通道被彻底掐死');
});

test('稀缺那两声（hatch / death）不被装饰声的闸门挤掉', () => {
  // 闸门只管啾。若把 hatch/death 也关进去，症状是"卵孵出来了却没有任何声音"，
  // 而死亡那一声的稀缺性正是 spec 要的东西 —— 它不该被一缸话痨挤掉。
  const c = creature('c-mix', 26, 315);
  const { a } = makeAudio([c]);
  a.consume([sayEvent(c.id, 'calm')], fakeWorld([c]));
  const chirps = a.stats.calls.chirp;
  a.consume([
    { kind: 'say', id: c.id, text: '喵', tokens: ['喵'], mood: 'calm' },
    { kind: 'hatch', id: c.id },
    { kind: 'death', id: c.id },
  ], fakeWorld([c]));
  assert.equal(a.stats.calls.chirp, chirps, '同一秒里的第二记啾必须被闸门拦住');
  assert.equal(a.stats.calls.hatch, 1, 'hatch 必须照样响');
  assert.equal(a.stats.calls.death, 1, 'death 必须照样响');
});

test('hatch 与 death 事件各响对应那一声明；找不到个体也要响（不静默）', () => {
  const c = creature('c-h', 26, 315);
  const { a } = makeAudio([c]);
  a.consume([{ kind: 'hatch', id: c.id }], fakeWorld([c]));
  assert.equal(a.stats.calls.hatch, 1);
  a.consume([{ kind: 'death', id: c.id }], fakeWorld([c]));
  assert.equal(a.stats.calls.death, 1);
  const before = a.stats.played;
  // 事件里的个体已经不在这个世界里（迟到的死亡事件）：仍要响，用参考嗓音
  a.consume([{ kind: 'death', id: 'ghost' }], fakeWorld([c]));
  assert.equal(a.stats.played, before + 1, '找不到个体就静默返回 = §7.7 禁止的那类丢失');
});

test('joy 跨过阈值只在**那一帧**响；此后滞留在阈上 60 帧不再响', () => {
  // 探针 7 打的就是这条：把跨越写成"在阈上"，这里立刻红。
  const c = creature('c-joy', 26, 315);
  const { a } = makeAudio([c]);
  c.emotions.joy = CONFIG.mood.happyJoyMin + 0.05;
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.calls.joy, 1, '跨过那一帧必须响');
  for (let i = 0; i < 60; i += 1) {
    c.emotions.joy = CONFIG.mood.happyJoyMin + 0.05 + i * 0.001;
    a.consume([], fakeWorld([c]));
  }
  assert.equal(a.stats.calls.joy, 1, `滞留在阈上时又响了 ${a.stats.calls.joy - 1} 次`);
});

test('第一条 DETECTOR 就能落地：六条探测器逐个穿过阈值，各落到正确的那一声明', () => {
  // 表驱动：将来谁加一条探测器 / 改一行映射，这里跟着红（不是靠六条硬写的用例）。
  const probes = {
    joy: (c, on) => { c.emotions.joy = on ? CONFIG.mood.happyJoyMin : 0; },
    anger: (c, on) => { c.emotions.anger = on ? CONFIG.mood.angerMin : 0; },
    sleepy: (c, on) => { c.emotions.sleepy = on ? AUD.sleepyMin : 0; },
    tired: (c, on) => { c.needs.energy = on ? AUD.tiredMin : 0; },
    coo: (c, on) => { adjust(c.memory, PLAYER_ID, on ? AUD.affectionMin : 0); },
    begLevel: (c, on) => { c.begIgnored = on ? CONFIG.behavior.begEscalate.hopAfter : 0; },
  };
  for (const d of DETECTORS) {
    const probe = probes[d.name];
    assert.ok(probe, `探测器 ${d.name} 没有对应的用例 —— 加了一条没人验证的探测器`);
    const c = creature(`c-${d.name}`, 26, 315);
    const { a } = makeAudio([c]);
    probe(c, true);
    a.consume([], fakeWorld([c]));
    assert.ok(a.stats.calls[d.call] >= 1,
      `${d.name} 穿过阈值之后没有放出 ${d.call} 那一声`);
  }
  assert.equal(DETECTORS.length, 6, '六条探测器：快乐/生气/困倦(情绪)/困倦(疲劳)/撒娇(好感)/撒娇(升级档)');
});

test('冷却：阈值沿线上下来回穿过时，同一只同一声明在 cooldownSec 内至多一次', () => {
  const c = creature('c-flap', 26, 315);
  const { g, a } = makeAudio([c]);
  const T = CONFIG.mood.happyJoyMin;
  // 30 轮抖动，每轮跨一次阈值 ⇒ 30 次"事件"，但真实时间只走了 30/60 = 0.5 秒
  for (let i = 0; i < 30; i += 1) {
    c.emotions.joy = i % 2 === 0 ? T + 0.02 : T - 0.02;
    g.advance(1 / 60);
    a.consume([], fakeWorld([c]));
  }
  assert.equal(a.stats.calls.joy, 1, `抖动把冷却穿破了：响了 ${a.stats.calls.joy} 次`);
  assert.ok(a.stats.cooldownSkips > 0, '被冷却挡掉的那些必须**计数**，不许静默');
  // 冷却过去之后同一只可以再响一次
  g.advance(AUD.cooldownSec + 0.1);
  c.emotions.joy = T - 0.02;
  a.consume([], fakeWorld([c]));
  c.emotions.joy = T + 0.02;
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.calls.joy, 2, '冷却到期后跨越必须能再响');
});

test('cooldownReady：从没响过（-Infinity）算就绪 —— 否则开缸头几秒的叫声会被静默吃掉', () => {
  assert.equal(cooldownReady(Number.NEGATIVE_INFINITY, 0.1), true);
  assert.equal(cooldownReady(0, 0.1), true);
  assert.equal(cooldownReady(1, 1 + AUD.cooldownSec), true);
  assert.equal(cooldownReady(1, 1 + AUD.cooldownSec - 0.001), false);
});

test('第一眼不尖叫：个体刚进场的**那一帧**不发声（那只是"第一次看见它"）', () => {
  const c = creature('c-new', 26, 315);
  c.emotions.joy = 1;                       // 一进场就已经很高兴
  c.emotions.anger = 1;
  c.needs.energy = 1;
  const { a } = makeAudio([]);
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.played, 0, '新建 entry 那一帧必须只记读数，不发声');
  assert.deepEqual(a.entryIds(), [c.id], '但它的读数快照必须已经落下');
  // 下一帧起，真正的**变化**才有权发声
  c.needs.hunger = 0;
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.played, 0, '读数没变 ⇒ 不响');
});

test('4× 跳过落地点仍然只响一记闷响（跨越而不是相等）', () => {
  const c = creature('c-hop', 26, 315);
  c.intent = { kind: 'hop', minDuration: 0.6 };
  const { g, a } = makeAudio([c]);
  const land = CONFIG.render.hopLandAt;
  // 4× 一帧推进 4/60 秒 ⇒ 进度步长 = (4/60)/0.6 ≈ 0.111，必然跨过 0.72 而不落在点上
  let fired = 0;
  const seen = [];
  for (let i = 0; i <= 12; i += 1) {
    c.intentTime = Math.min(0.6, i * (4 / 60));
    seen.push(round(hopPhase(c)));
    const before = a.stats.calls.thud;
    g.advance(1 / 60);
    a.consume([], fakeWorld([c]));
    if (a.stats.calls.thud > before) fired += 1;
  }
  assert.ok(seen.includes(land) === false, '前置条件：这一串读数**跳过**了落地点本身');
  assert.equal(fired, 1, `跨过落地点应当恰好一记，实测 ${fired}`);
  // 同一跳不再重复
  c.intentTime = 0.6;
  g.advance(2);
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.calls.thud, 1);
});

test('闷响的全局闸门：24 只同帧落地只漏出一记，其余进 thudDropped（防机关枪）', () => {
  const list = [];
  for (let i = 0; i < CONFIG.populationCap.desktop; i += 1) {
    const c = creature(`c-t${i}`, 26, 315);
    c.intent = { kind: 'hop', minDuration: 0.6 };
    c.intentTime = 0.6 * (CONFIG.render.hopLandAt - 0.05);
    list.push(c);
  }
  const { g, a } = makeAudio(list);
  for (const c of list) c.intentTime = 0.6 * (CONFIG.render.hopLandAt + 0.05);
  g.advance(1 / 60);
  a.consume([], fakeWorld(list));
  assert.equal(a.stats.calls.thud, 1, `同帧 24 次落地必须只出一记，实测 ${a.stats.calls.thud}`);
  assert.equal(a.stats.thudDropped, list.length - 1, '被挡掉的那些要计数，不许静默');
  // 过了全局间隔之后，下一轮落地又能出声
  g.advance(AUD.thudGapSec + 0.01);
  for (const c of list) { c.intent = null; c.intentTime = 0; }
  a.consume([], fakeWorld(list));
  for (const c of list) { c.intent = { kind: 'hop', minDuration: 0.6 }; c.intentTime = 0.1; }
  a.consume([], fakeWorld(list));
  for (const c of list) c.intentTime = 0.6 * (CONFIG.render.hopLandAt + 0.05);
  g.advance(AUD.thudGapSec + 0.01);
  a.consume([], fakeWorld(list));
  assert.ok(a.stats.calls.thud >= 2, '全局闸门到期后必须放行');
});

test('发声上限：超过 maxVoices 的那些被丢并**计数**（静默丢是 §7.7 禁止的）', () => {
  const list = [];
  for (let i = 0; i < AUD.maxVoices + 4; i += 1) list.push(creature(`c-v${i}`, 26, 315));
  const { a } = makeAudio(list);
  // ⚠️ 造压用的是 **hatch**，不是 say：「啾」有一条全局闸门（上面那几条测试钉它），
  // 同帧十条 say 只会响一记，那样的话这条测试测的是闸门而不是上限。
  // hatch / death 不受闸门管（稀缺声不许被装饰声挤掉，理由见那几条测试），
  // 而且时钟不前进 ⇒ 前面排进去的槽都还占着，正好把池子顶满。
  const events = list.map((c) => ({ kind: 'hatch', id: c.id }));
  a.consume(events, fakeWorld(list));
  assert.equal(a.stats.played, AUD.maxVoices, `只许排程 ${AUD.maxVoices} 声`);
  assert.equal(a.stats.dropped, events.length - AUD.maxVoices, '溢出必须进计数');
  // 槽位释放之后，新的能进去
  const g2 = createGraphStub({});
  const b = createAudio({ graph: g2 });
  b.consume([sayEvent('c-x')], fakeWorld([]));
  assert.equal(b.stats.played, 1);
  g2.advance(2);
  b.consume([sayEvent('c-y')], fakeWorld([]));
  assert.equal(b.stats.played, 2, '发声结束必须把槽位还回来');
});

test('节点不漏：跑完一场之后 created == disconnected + 总线，started == stopped', () => {
  const list = [];
  for (let i = 0; i < 3; i += 1) list.push(creature(`c-l${i}`, 20 + i * 6, 315 + i * 10));
  const { g, a } = makeAudio(list);
  // 六声明 + 闷响 + 啾，每种都走一遍
  const c = list[0];
  for (let i = 0; i < 20; i += 1) {
    a.consume([{ kind: 'say', id: c.id }, { kind: 'hatch', id: c.id }, { kind: 'death', id: c.id }],
      fakeWorld(list));
    list[1].emotions.anger = 0.9;
    list[2].emotions.sleepy = 0.9;
    g.advance(3);                     // 让槽位释放出来，好让后面几声排得进去
    a.consume([], fakeWorld(list));
  }
  const src = g.counts.osc + g.counts.source;
  assert.ok(src > 0, '一条都没创建 ⇒ 整条断言在空转');
  assert.ok(a.stats.played > 3, '前置条件：这一串确实排进了好几声');
  // 每个被 start 的源都被 stop（连 LFO 与倍音一起）
  assert.equal(a.stats.started, src, '创建的源必须全部 start');
  assert.equal(a.stats.stopped, a.stats.started, 'start 与 stop 必须等量');
  for (const n of g.nodes.filter((x) => x.starts.length > 0)) {
    assert.equal(n.stops.length, 1, `${n.tag}#${n.nid} 被 start 但没被 stop —— 那就是永久占着一只振荡器`);
    assert.equal(n.starts.length, 1);
  }
  // 时间走到最后，所有槽位释放 ⇒ 除总线外全部 disconnect
  g.advance(60);
  a.consume([], fakeWorld(list));
  assert.equal(a.stats.disconnected, a.stats.created - 1,
    '唯一的常驻节点必须是那条总线');
  assert.ok(g.nodes.every((n) => n.nid === 0 || n.disconnects >= 0));
  a.close();
  assert.equal(a.stats.disconnected, a.stats.created, 'close 之后一个节点都不许留着');
  const byTag = (t) => g.nodes.filter((n) => n.tag === t);
  assert.ok(byTag('filter').length > 0 && byTag('source').length > 0 && byTag('osc').length > 0,
    '前置条件：滤波/噪声/振荡三类节点都出现过');
  for (const n of g.nodes) assert.equal(n.disconnects, 1, `${n.tag}#${n.nid} disconnect 了 ${n.disconnects} 次`);
});

test('愤怒那一声明的三类振荡器（主声/倍音/抖动）全部被 stop 并被收走', () => {
  const c = creature('c-ang', 26, 315);
  const { g, a } = makeAudio([c]);
  c.emotions.anger = CONFIG.mood.angerMin + 0.01;
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.calls.anger, 1);
  const osc = g.byTag('osc');
  assert.ok(osc.length >= 3, `主声 + 倍音 + 抖动 = 至少三只，实测 ${osc.length}`);
  // 抖动的形状：恰好一只节点把输出接到**频率参数**上（那是深度增益），而它的上游恰好一只振荡器
  const toParam = g.nodes.filter((n) => n.connects.some((d) => d && d.__param && d.name === 'frequency'));
  assert.equal(toParam.length, 1, '必须恰好一只节点的输出接到基频参数上（那只"抖动"的深度增益）');
  assert.equal(toParam[0].tag, 'gain');
  const lfo = osc.filter((n) => n.connects.length === 1 && n.connects[0] === toParam[0]);
  assert.equal(lfo.length, 1, '必须恰好一只慢振荡器送给那只深度增益');
  assert.equal(toParam[0].gain.writes.length, 1, '深度是一次 setValueAtTime，不是包络');
  for (const n of osc) {
    assert.equal(n.starts.length, 1, `振荡器 ${n.nid} 没被 start 或启动了两次`);
    assert.equal(n.stops.length, 1, `振荡器 ${n.nid} 没被 stop —— 那就是一只永久振荡器`);
  }
  assert.equal(a.stats.started, a.stats.stopped);
  g.advance(5);
  a.consume([], fakeWorld([c]));
  assert.equal(a.stats.disconnected, a.stats.created - 1, '除常驻总线外全部收走');
  assert.equal(g.nodes.every((n) => n.disconnects === 1), true);
});

test('状态有上界：300 轮出生/死亡之后 entries 只跟在场数走，回收在涨', () => {
  // 这条是本项目被 world.events 咬过之后立的规矩：不回收就是每小时攒下几千条。
  const living = [];
  const { g, a } = makeAudio(living);
  for (let gen = 0; gen < 300; gen += 1) {
    living.length = 0;
    for (let i = 0; i < 5; i += 1) {
      const c = creature(`g${gen}-${i}`, 20 + i, 315 + i);
      c.emotions.joy = 0.1;
      living.push(c);
    }
    g.advance(1 / 60);
    a.consume([], fakeWorld(living));
  }
  assert.ok(a.stats.reclaimed >= 295, `每代五只全换代 ⇒ 必须回收约 295 条，实测 ${a.stats.reclaimed}`);
  assert.equal(a.entryIds().length, 5, `留在表里的必须只是在场的五只，实测 ${a.entryIds().length}`);
  assert.ok(a.stats.entriesMax <= 10, `水位线不该超过在场数一点点，实测 ${a.stats.entriesMax}`);
  // 只存标量，不存 creature 引用：否则一个死掉的个体被表现层拽着不释放
  const sample = a.entryIds();
  assert.ok(sample.length === 5 && sample.every((id) => typeof id === 'string'));
});

test('同帧一死一生也必须回收（size 恰好相等时"要不要扫"的快捷条件是 bug）', () => {
  const oldOne = creature('c-old', 26, 315);
  const world = { creatures: [oldOne], events: [] };
  const g = createGraphStub({});
  const a = createAudio({ graph: g });
  a.consume([], fakeWorld([oldOne]));
  assert.equal(a.entryIds().length, 1);
  const newOne = creature('c-new', 26, 315);
  world.creatures = [newOne];                    // 一只走了一只来了，总数不变
  g.advance(1 / 60);
  a.consume([], world);
  assert.deepEqual(a.entryIds(), ['c-new'], '僵尸条目还留在表里');
  assert.equal(a.stats.reclaimed, 1);
});

test('不写世界：跑完一整套叫声之后 world 逐字节不变（spec §7.2 / §9.2 第 7 条）', () => {
  const list = [];
  for (let i = 0; i < 4; i += 1) {
    const c = creature(`c-w${i}`, 20 + i * 5, 315 + i * 12);
    c.intent = { kind: 'hop', minDuration: 0.6 };
    list.push(c);
  }
  const world = fakeWorld(list);
  const events = [];
  for (let i = 0; i < 200; i += 1) {
    const c = list[i % list.length];
    c.emotions.joy = (i % 7) / 6;
    c.emotions.anger = (i % 5) / 4;
    c.emotions.sleepy = (i % 3) / 2;
    c.needs.energy = (i % 11) / 10;
    c.intentTime = (i % 9) * 0.07;
    c.begIgnored = (i % 4) * 3;
    if (i % 5 === 0) events.push({ kind: 'say', id: c.id, text: '喵喵', tokens: ['喵喵'], mood: 'happy' });
    if (i % 17 === 0) events.push({ kind: 'death', id: c.id });
  }
  const before = JSON.stringify(world);
  const g = createGraphStub({});
  const a = createAudio({ graph: g });
  let cursor = 0;
  for (let i = 0; i < 200; i += 1) {
    g.advance(1 / 60);
    const slice = events.slice(cursor, cursor + 10);
    cursor += 10;
    a.consume(slice, world);
  }
  assert.equal(JSON.stringify(world), before, '叫了一百多声而世界一个字都没变 —— 变了就是入了档');
  assert.ok(a.stats.played > 0, '前置条件：这一串确实发出了声音');
  for (const c of list) {
    for (const banned of ['voice', 'audio', 'lastCall', 'calls', 'sounded']) {
      assert.ok(!(banned in c), `个体身上长出了叫声字段 ${banned}`);
    }
    assert.ok(!('audio' in world), '世界上不许长音频字段');
  }
});

test('静音：setMuted(true) 之后不再创建任何节点，解除后恢复', () => {
  const c = creature('c-mute', 26, 315);
  const { g, a } = makeAudio([c]);
  assert.equal(a.getMuted(), false, 'spec §5.4：默认开启');
  a.setMuted(true);
  assert.equal(a.getMuted(), true);
  const created = g.nodes.length;
  const snapBefore = g.snap();
  a.consume([sayEvent(c.id, 'happy'), { kind: 'hatch', id: c.id }], fakeWorld([c]));
  c.emotions.joy = CONFIG.mood.happyJoyMin + 0.1;
  g.advance(1 / 60);
  a.consume([], fakeWorld([c]));
  assert.equal(g.nodes.length, created, '静音期间一个节点都不许多建（这才是真的没声音）');
  assert.equal(g.snap(), snapBefore);
  assert.equal(a.stats.played, 0);
  a.setMuted(false);
  g.advance(AUD.cooldownSec + 1);
  c.emotions.joy = CONFIG.mood.happyJoyMin - 0.1;
  a.consume([], fakeWorld([c]));
  c.emotions.joy = CONFIG.mood.happyJoyMin + 0.1;
  a.consume([], fakeWorld([c]));
  assert.ok(a.stats.played > 0, '解除静音之后必须能重新发声');
});

test('close 之后 consume 不再工作，剩余节点全部收走', () => {
  const c = creature('c-close', 26, 315);
  const { g, a } = makeAudio([c]);
  a.consume([sayEvent(c.id)], fakeWorld([c]));
  assert.ok(a.stats.played > 0);
  assert.equal(a.close(), true);
  assert.equal(a.close(), false, 'close 必须幂等');
  assert.equal(a.stats.disconnected, a.stats.created);
  const before = a.stats.played;
  a.consume([sayEvent(c.id), { kind: 'death', id: c.id }], fakeWorld([c]));
  assert.equal(a.stats.played, before, 'close 之后不许再排任何声');
  assert.equal(a.isClosed(), true);
});

test('注入的图少了滤波与噪声能力：降级但**记账**，不抛错也不静默', () => {
  const c = creature('c-min', 26, 315);
  const g = createGraphStub({ noFilter: true, noNoise: true });
  const a = createAudio({ graph: g });
  a.consume([], fakeWorld([c]));
  a.consume([sayEvent(c.id)], fakeWorld([c]));                 // 啾没有噪声层，仍要响
  c.emotions.joy = CONFIG.mood.happyJoyMin + 0.1;
  g.advance(1);
  a.consume([], fakeWorld([c]));
  c.emotions.anger = 0;
  g.advance(AUD.cooldownSec + 1);
  a.consume([], fakeWorld([c]));
  c.emotions.anger = CONFIG.mood.angerMin + 0.1;
  g.advance(AUD.cooldownSec + 1);
  a.consume([], fakeWorld([c]));                                // 愤怒那一声明带碎裂？没有，但它有 LFO
  assert.ok(a.stats.filterSkipped > 0, '没有滤波器时必须记一笔"这缸的音色没跟着色相走"');
  assert.equal(a.stats.played > 0, true, '缺能力不许让整个叫声层停摆');
  assert.equal(a.stats.started, a.stats.stopped);
  g.advance(30);
  a.consume([], fakeWorld([c]));
  a.close();
  assert.equal(a.stats.disconnected, a.stats.created, '缺能力的降级不许顺便漏节点');
});

test('createAudio 的入参门：graph 缺失/形状不对一律构造时抛（绝不在帧路径上抛）', () => {
  assert.throws(() => createAudio(), /需要注入/);
  assert.throws(() => createAudio({ graph: {} }), /createOscillator/);
  assert.throws(() => createAudio({ graph: { createOscillator() {}, createGain() {} } }), /destination/);
  const g = createGraphStub({});
  const a = createAudio({ graph: g, muted: true, masterGain: 0.1 });
  assert.equal(a.getMuted(), true, 'muted 的初始值要能被注入（计划 3 的设置页靠它）');
  assert.equal(a.maxVoices, AUD.maxVoices, '不注入时用 CONFIG 那一档');
  a.consume([sayEvent('c-x')], fakeWorld([]));
  assert.equal(a.stats.played, 0, '开局就静音 ⇒ 一声都不许排');
});

test('同一段世界跑两遍，桩读数字节相同（零 rng 的直接后果，也是可复现性的机器证据）', () => {
  const build = () => {
    const list = [];
    for (let i = 0; i < 3; i += 1) list.push(creature(`c-r${i}`, 20 + i * 8, 315 + i * 20));
    return list;
  };
  const run = () => {
    const list = build();
    const g = createGraphStub({});
    const a = createAudio({ graph: g });
    for (let i = 0; i < 40; i += 1) {
      list[0].emotions.joy = (i % 3) * 0.3;
      list[1].needs.energy = (i % 5) * 0.2;
      list[2].begIgnored = (i % 3) * 4;
      g.advance(1 / 60);
      a.consume(i % 9 === 0 ? [sayEvent(list[2].id, 'calm')] : [], fakeWorld(list));
    }
    return g.snap() + '|' + JSON.stringify(a.stats);
  };
  assert.equal(run(), run());
});

// ======================================================== 四、纯度与 CONFIG 纪律

test('audio.js 源码里没有数值字面量（照 body.js / eyes.js 的先例：数全在 CONFIG.audio）', () => {
  const code = codeOf('audio.js');
  const decimals = code.match(/(?<![\w.])(\d+\.\d+|\.\d+)/g);
  assert.equal(decimals, null, `audio.js 里出现小数字面量（${decimals && decimals.join(' ')}）—— 请搬进 CONFIG.audio`);
  const sci = code.match(/(\d+\.?\d*)e[+-]?\d+/gi);
  assert.equal(sci, null, `audio.js 里出现科学计数法字面量（${sci && sci.join(' ')}）`);
  const multi = code.match(/(?<![\w.:"'`-])(\d{2,})(?![\w.])/g);
  assert.equal(multi, null, `audio.js 里出现多位整数字面量（${multi && multi.join(' ')}）`);
});

test('audio.js 一个浏览器全局都不出现，也不 import main.js（依赖注入这条不许松）', () => {
  const body = SRC('audio.js');
  const code = codeOf('audio.js');
  for (const name of ['document', 'window', 'canvas', 'requestAnimationFrame',
    'AudioContext', 'fetch', 'localStorage']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `audio.js 的代码里出现了 ${name} —— 那会让它掉出纯度守卫`);
  }
  assert.ok(!/'\.\/main\.js'/.test(body) && !/"\.\/main\.js"/.test(body), 'audio.js 不得 import main.js');
  // 零随机数：不许 import rng，也不许调随机源
  assert.ok(!/'\.\/rng\.js'/.test(body), 'audio.js 不得 import rng.js（叫声不许消费随机数）');
  assert.ok(!/Math\.random/.test(code), 'audio.js 不许调用 Math.random');
});

test('audio.js 只 import 既有模块，且复用的是 sizeOf / begLevelOf / affectionFor（不重抄）', () => {
  const body = SRC('audio.js');
  for (const mod of ['config.js', 'creature.js', 'body.js', 'memory.js']) {
    assert.ok(body.includes(`'./${mod}'`), `audio.js 应当 import ./${mod}`);
  }
  // 这三处**必须**借现成的导出：自己重抄一遍就会有两个定义点分家的老问题
  assert.ok(/import \{ sizeOf \} from '\.\/creature\.js'/.test(body));
  assert.ok(/begLevelOf[^']*\} from '\.\/body\.js'/.test(body));
  assert.ok(/affectionFor/.test(body) && /PLAYER_ID/.test(body));
  // 反向：不许自己实现求关注档位（那是 body.js 的判据）
  const code = body.replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/begEscalate\.hopAfter\s*[<>=]/.test(code), 'audio.js 不许重抄 begEscalate 的比较式');
});

// ======================================================== 五、main.js 接线

test('main.js 每帧都喂 audio.consume（它不在 events.length>0 的守卫里 —— 第二通道要每帧巡检）', () => {
  const src = SRC('main.js');
  assert.ok(/from '\.\/audio\.js'/.test(src), 'main.js 没有 import audio.js');
  assert.ok(/audio\.consume\(world\.events, world\)/.test(src), 'audio.consume(events, world) 没接上');
  assert.ok(/world\.events\.length = 0/.test(src), '清空仍必须由 main.js 做（renderer 与 audio 读同一批事件）');
  // 取出 `if (world.events.length > 0) { ... }` 那一整块（大括号配对，先例见 tests/body.test.js
  // 那条「updateBodies 必须在子步循环里」），要求它**含** consumeEvents 而**不含** audio.consume。
  const m = src.match(/if\s*\(world\.events\.length > 0\)\s*\{/);
  assert.ok(m, 'main.js 里找不到事件守卫 if (world.events.length > 0)');
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, '事件守卫的块没能配对闭合');
  const block = src.slice(start, end + 1);
  assert.ok(block.includes('consumeEvents(renderer'), '渲染层仍要在事件守卫之内（它只读事件）');
  assert.ok(!block.includes('audio.consume'),
    'audio.consume 被放进了"只有事件才走"的块里 ⇒ 跨越那条通道在有事件的帧之外永不巡检，'
    + '症状是一缸哑巴而不报任何错（B17c 抓过的同一类"调用点没接到"）');
  // 而且必须排在清空**之前**（否则它拿到的是空数组）
  assert.ok(src.indexOf('audio.consume') < src.indexOf('world.events.length = 0'),
    '清空必须在两个消费方之后');
});

// 剥注释后的源码（与 tests/constraints.test.js 同一套启发式）：
// 这里做**正向**扫描（"这个构造名只许出现在 main.js"），而注释里讨论那个名字是合法的、
// 也是本仓库写明纪律的必要手段 —— 不剥注释的扫描会把散文当违规（constraints 第一天就红过）。
const codeOf = (name) => SRC(name)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

test('main.js 是唯一出现 AudioContext 的文件，且创建点挂在首次手势上（懒启动）', () => {
  const src = SRC('main.js');
  // ① 正面确认"确实有人创建上下文"。constraints.test.js 从反面拦（别的文件出现这个名字就红），
  //    而"谁都不创建"那一侧只有这里能拦 —— 那种缸照常跑、画面照常、就是永远没声音，
  //    且 audio.js 的全部单测照样全绿（它靠注入，本来就不需要有人 new）。
  for (const pure of ['audio.js', 'render.js', 'input.js', 'body.js', 'eyes.js', 'bubble.js', 'sim.js']) {
    assert.ok(!/AudioContext/.test(codeOf(pure)), `${pure} 的代码里出现了那个构造名 —— 它掉出纯度守卫了`);
  }
  assert.ok(/window\.AudioContext/.test(src) && /window\.webkitAudioContext/.test(src),
    'main.js 必须自己读那个构造器（含 iOS 早年那个带前缀的名字）');
  assert.ok(/createAudio\(\{/.test(src), 'boot 里没有 createAudio 调用 ⇒ 叫声层根本没接上');
  // ② 创建点必须在这条链上：makeContext（唯一 new 的地方）← unlockAudio ← pointerdown 监听。
  //    任一环节断了，症状都是"桌面也听不见 / 手机永远听不见"而**没有任何一条测试会红**
  //    —— 因为 audio.js 靠注入，本来就不需要有人真的 new。
  const ctorAt = src.indexOf('new Ctor()');
  const makeAt = src.indexOf('const makeContext');
  const unlockAt = src.indexOf('const unlockAudio');
  const bootAt = src.indexOf('export function boot');
  assert.ok(makeAt > bootAt && ctorAt > makeAt && ctorAt < unlockAt,
    'new 上下文必须发生在 makeContext 之内、而 makeContext 必须定义在 unlockAudio 之前');
  assert.ok(/const unlockAudio[\s\S]{0,900}makeContext\(\)/.test(src),
    'unlockAudio 必须真的调用那个工厂');
  assert.ok(unlockAt > bootAt, '这条路径必须定义在 boot 里（它要闭包拿 canvasEl）');
  // ③ 那条路径必须真的被接上手势，且是**每帧巡检之外**独立的一条监听
  assert.match(src, /addEventListener\(\s*'pointerdown'\s*,\s*unlockAudio\s*\)/,
    'pointerdown → unlockAudio 这条接线没写上：手机首点仍不会有声音');
  assert.ok(/resume\(\)/.test(src.slice(unlockAt, unlockAt + 1200)), '手势里必须调 resume()（spec §5.4 末段）');
});

// ---- boot 的三条真实形状：懒创建 / 降级 / 静音 API ----

function withBrowserGlobals(fn) {
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window,
    requestAnimationFrame: g.requestAnimationFrame, cancelAnimationFrame: g.cancelAnimationFrame,
  };
  const raf = [];
  const target = {
    clientWidth: 1280, clientHeight: 720, width: 0, height: 0,
    listeners: new Map(),
    addEventListener(type, fn2) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn2);
    },
    removeEventListener(type, fn2) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const k = arr.indexOf(fn2);
      if (k >= 0) arr.splice(k, 1);
    },
    setPointerCapture() {},
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {},
      drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      arc() {}, ellipse() {}, rect() {}, fill() {}, stroke() {}, fillRect() {}, clip() {},
      quadraticCurveTo() {}, bezierCurveTo() {}, translate() {}, rotate() {}, scale() {},
      measureText: (s) => ({ width: String(s).length * 10 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
    emit(type, ev) {
      const arr = (this.listeners.get(type) || []).slice();
      for (const f of arr) f(ev);
    },
  };
  g.document = { createElement: () => target };
  g.window = {
    devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  g.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  g.cancelAnimationFrame = () => {};
  try {
    return fn({ target, raf, window: g.window });
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
}

const pointer = (x, y) => ({ pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true });

test('boot：按下之前一次都没创建音频图；首次 pointerdown 才创建，并且真的被喂了事件', () => {
  withBrowserGlobals(({ target, raf, window }) => {
    const g = createGraphStub({});
    let made = 0;
    window.AudioContext = function FakeAudioContext() { made += 1; return g; };
    const controller = boot({
      canvas: target, seed: 20261022,
      renderer: { draw() {}, onResize() {} },
    });
    try {
      const step = () => raf[raf.length - 1];
      step()(0);
      step()(16.7);
      assert.equal(made, 0, '开缸就 new AudioContext 会被手机浏览器拒绝（spec §5.4 末段）');
      assert.equal(controller.audio, null, '按下之前没有音频可播');
      assert.equal(controller.audioState.tried, false);

      target.emit('pointerdown', pointer(600, 300));
      assert.equal(made, 1, '首次手势必须创建一次');
      assert.equal(controller.audioState.ok, true, `音频必须可用，实测 reason=${controller.audioState.reason}`);
      assert.ok(controller.audio, 'controller 要把 audio 暴露出来（计划 3 的静音按钮靠它）');
      target.emit('pointerdown', pointer(601, 301));
      assert.equal(made, 1, '只创建一次（每次按下都 new 一遍会把手势变成一堆上下文）');

      // 事件真的被喂进 audio.consume
      const c = controller.world.creatures[0];
      const before = controller.audio.stats.frames;
      controller.world.events.push({ kind: 'say', id: c.id, text: '喵喵', tokens: ['喵喵'], mood: 'calm' });
      step()(33.4);
      assert.ok(controller.audio.stats.frames > before, 'step() 必须每帧喂 audio.consume');
      assert.ok(controller.audio.stats.events >= 1, '那条 say 必须真的到了 audio.consume 手上');
      assert.equal(controller.world.events.length, 0, '清空仍由 main.js 做');
    } finally {
      controller.stop();
    }
  });
});

test('boot：工厂抛错时降级 —— 缸照常跑、原因可读、不重复尝试', () => {
  withBrowserGlobals(({ target, raf, window }) => {
    let tries = 0;
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warns.push(args.join(' ')); };
    window.AudioContext = function Boom() { tries += 1; throw new Error('NotAllowedError'); };
    const controller = boot({ canvas: target, seed: 20261023, renderer: { draw() {}, onResize() {} } });
    try {
      const step = () => raf[raf.length - 1];
      target.emit('pointerdown', pointer(300, 300));
      const t0 = controller.world.time;
      for (let i = 1; i <= 10; i += 1) step()(i * 16.7);
      assert.ok(controller.world.time > t0, '音频坏了不许拖累模拟：缸必须照常推进');
      assert.equal(controller.audio, null);
      assert.equal(controller.audioState.ok, false);
      assert.match(String(controller.audioState.reason), /NotAllowedError/, '降级必须可读（§7.7 不许静默）');
      target.emit('pointerup', pointer(300, 300));
      target.emit('pointerdown', pointer(320, 320));
      for (let i = 11; i <= 20; i += 1) step()(i * 16.7);
      assert.equal(tries, 1, '失败之后不许每次按下都重跑一遍构造器');
      assert.equal(warns.length, 1, `console 只许打印一次，实测 ${warns.length} 次`);
    } finally {
      console.warn = origWarn;
      controller.stop();
    }
  });
});

test('boot：本浏览器没有 AudioContext 时是"不支持"，可读、只打印一次、不每帧刷', () => {
  withBrowserGlobals(({ target, raf, window }) => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
    const origWarn = console.warn;
    let warns = 0;
    console.warn = () => { warns += 1; };
    const controller = boot({ canvas: target, seed: 20261024, renderer: { draw() {}, onResize() {} } });
    try {
      target.emit('pointerdown', pointer(400, 400));
      const step = () => raf[raf.length - 1];
      for (let i = 1; i <= 30; i += 1) step()(i * 16.7);
      assert.equal(controller.audioState.ok, false);
      assert.equal(controller.audioState.reason, 'unsupported');
      assert.equal(controller.audioState.tried, true, '不支持也是一次性的判定，不许每帧再判');
      assert.equal(controller.audio, null);
      assert.equal(warns, 1, `降级要看得见（§7.7 不许静默），但每帧一次就是刷屏：实测 ${warns}`);
    } finally {
      console.warn = origWarn;
      controller.stop();
    }
  });
});

test('boot：控制器与模块级都拿得到静音；stop 会 close 音频图', () => {
  withBrowserGlobals(({ target, raf, window }) => {
    const g = createGraphStub({});
    window.AudioContext = function Fake() { return g; };
    const controller = boot({ canvas: target, seed: 20261025, renderer: { draw() {}, onResize() {} } });
    try {
      target.emit('pointerdown', pointer(500, 500));
      assert.equal(controller.getMuted(), false, '默认开（spec §5.4）');
      controller.setMuted(true);
      assert.equal(controller.getMuted(), true);
      // 总线是 createAudio 建的第一只节点
      assert.equal(g.nodes[0].gain.writes.some((w) => w.v === 0), true, '静音必须把总线推到 0');
      controller.setMuted(false);
      assert.equal(controller.getMuted(), false);
      const step = () => raf[raf.length - 1];
      for (let i = 1; i <= 6; i += 1) step()(i * 16.7);
      assert.ok(controller.audio.stats.frames > 0, '懒创建之后每帧都要被喂到');
    } finally {
      controller.stop();
    }
    assert.equal(controller.audio.isClosed(), true,
      'stop 之后音频图必须 close（否则离开页面会留一屏振荡器在响）');
    assert.equal(g.nodes.every((n) => n.disconnects === 1), true, 'close 必须把所有节点都收走');
  });
});

test('boot：注入的 audio 替身收到 consume(events, world)，main.js 不改 world.events 的归属', () => {
  withBrowserGlobals(({ target, raf, window }) => {
    const seen = [];
    const fake = {
      consume(events, world) { seen.push([events.length, world.creatures.length]); },
      close() {},
    };
    window.AudioContext = function Fake() { return createGraphStub({}); };
    const controller = boot({ canvas: target, seed: 20261026, audio: fake, renderer: { draw() {}, onResize() {} } });
    try {
      const c = controller.world.creatures[0];
      controller.world.events.push({ kind: 'say', id: c.id, text: '喵', tokens: ['喵'], mood: 'calm' });
      raf[raf.length - 1](0);
      assert.ok(seen.length >= 1, '注入的 audio 必须被喂到');
      assert.deepEqual(seen[0], [1, controller.world.creatures.length]);
      assert.equal(controller.audio, fake, '注入优先于懒创建：已有 audio 时不许再 new 一个上下文');
    } finally {
      controller.stop();
    }
  });
});
