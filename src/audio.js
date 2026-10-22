// audio.js —— 程序化叫声（spec §5.4 的声音表 + §5.4.1 的落地裁定，2026-10-22 Task B18）。
//
// 分工与 body.js / eyes.js / bubble.js 完全同形：**算**的东西全在这个文件里，
// main.js 只做一件事 —— 注入那个 audio graph（Web Audio 的 AudioContext）。
// 拆的理由也一样，是可测性不是整洁：
//   · "音高随体型变（小只高、大只低）、音色随色相基因变"是一句**值**的断言，
//     只有纯函数能在 Node 里断言它（voiceFor 出来的是数，画不出也听不出）。
//   · "六声表每一行的频率区间 / 波形 / 时长 / 起音"同理。
//   · "冷却 + 阈值跨越"是行为断言，靠记录型桩的**参数值**与**次数**两条一起守。
// 一旦把这些混进 Web Audio 的调用点，就只剩"有几个节点被创建了"这种证据，
// 而把 600→900 写成 600→600 不会改变任何节点数（本项目在 B13/B16/B19a 反复栽过这一下）。
//
// 五条硬约束与它们在这一层的落点：
//
// 1. **一个浏览器全局都不许出现**。tests/constraints.test.js 全量扫 src/，只有 main.js 豁免。
//    所以本模块拿到的是一条 **duck-typed 的音频图**（形参 `graph`）：
//      { currentTime, destination, createOscillator(), createGain(),
//        createBiquadFilter()?, createBufferSource()?, createBuffer()?, sampleRate? }
//    `new AudioContext()` 只写在 main.js。回报是：整个叫声层在 Node 里可单测，
//    而桩能记下每一次 setValueAtTime 的**数值**（canvas 那套桩刻意只数次数，这里不行）。
// 2. **绝不写世界**（spec §7.2 / §9.2 第 7 条同一条界线）。只读 c.emotions / c.needs /
//    c.intent / c.begIgnored / c.memory，读数与冷却全存在**本模块自己那张 Map** 上。
//    由 tests/audio.test.js 的 JSON 快照断言逐字节守住。
// 3. **零 rng**（与 bubble.js 同一条纪律）。叫声的时序由事件与跨越决定，
//    "生气那一声的抖动速率"这类个体差异一律由 **id 派生的确定性函数**给出。
//    一旦引入抽样，同一个种子在两台设备上就会长出不同的缸（render.js 文件头的老纪律），
//    而且"关掉声音"与"开着声音"会改变模拟 —— 那是 §9.2 第 7 条那种对照的杀手。
// 4. **状态有上界**。每只个体的读数与冷却存在 entries 里，按**世界成员身份**回收
//    （镜像 body.js 的 reconcileBodies，不用 seen 标记：0.5× 下有空帧会误删全部状态）。
//    60 分钟的缸要过约 80 个个体，没有这一步就又是一次 world.events 那种无界增长。
//    发声槽同样有上界（CONFIG.audio.maxVoices），溢出**计数丢弃**（§7.7 禁止静默丢）。
// 5. **不漏节点**。每一个 createOscillator / createBufferSource 都排了 stop()，
//    每一个 createGain / createBiquadFilter 都会在发声槽释放时 disconnect()，
//    close() 把还剩的一并收走。created===disconnected 且 started===stopped 由测试逐帧核对。
//
// ⚠️ 两条通道**不许同步**（spec §5.4 那条 2026-10-20 修订，本 Task 的核心）：
//   叫是生理性的、不含词汇、永远发生；文字是选择性的、按 talk 稀疏发生。
//   `say` 事件只触发**出词前那记极短的「啾」**，它的频率/波形/增益**只由体型与色相推导**，
//   绝不读 ev.mood —— 读了就等于给台词配音，两条通道当场塌成一条。
//   这一条由 tests/audio.test.js 用"同一条 say 换个 mood，桩记下的参数逐字节相同"钉住。
//   反过来，任何 say 都不许触发六声表里的那六声（同文件另一条断言）。
//
// ⚠️ 冷却与发声槽用的是 **graph 时钟（真实秒）**，不是 world.time（模拟秒）：
//   倍速 4× 下跨越次数就是 4 倍，若按模拟秒算冷却，每秒的叫声数会跟着倍速线性上升，
//   而玩家的耳朵听的是真实秒。落地闷响另有一道**全局**间隔闸门（thudGapSec），
//   拦的是"24 只好动个体同时落在那一点上"这种机关枪。
//
// ⚠️ 本文件里不许出现小数 / 科学计数 / 多位整数字面量（先例：body.js、eyes.js，
//   由 tests/audio.test.js 的源码扫描钉住）。所有数在 CONFIG.audio。
import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';
import { begLevelOf } from './body.js';
import { affectionFor, PLAYER_ID } from './memory.js';

const AUD = CONFIG.audio;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (Number.isFinite(v) ? v : 0);
// 兜底读数：脏存档 / 单测传了个半空对象时按 0 算，绝不让 NaN 进比较式
// （NaN 与任何数比较都是 false ⇒ 不兜底的话跨越判据会**静默永不成立**）。
const read = (obj, key) => num(obj && obj[key]);

// 八种发声。前六个是 spec §5.4 表里那六行，后两个是计划 2 的增量（§5.4.1 第 5 条）：
// thud = hop 落地那记闷响，chirp = 出词前那记「啾」。
export const CALL_KEYS = Object.freeze([
  'joy', 'beg', 'anger', 'sleepy', 'hatch', 'death', 'thud', 'chirp',
]);

// 内核事件 → 叫声。**只有这三条**：eat / laid / poke / dissolved / drift / emigrate /
// eggFailed / error 一律不出声（spec §5.4 表里没有它们，§5.4.1 第 2 条记了裁定）。
// poke 尤其**不**单列一记：戳会把 anger 推过 CONFIG.mood.angerMin，
// 生气那一声明天然把它接走了 —— 再配一个"被戳音效"就是给同一个动作发两个信号。
const EVENT_CALL = Object.freeze({ say: 'chirp', hatch: 'hatch', death: 'death' });
export function callForEvent(kind) {
  const k = kind === undefined || kind === null ? '' : String(kind);
  return Object.prototype.hasOwnProperty.call(EVENT_CALL, k) ? EVENT_CALL[k] : null;
}

// ---------------------------------------------------------------- 嗓音（纯函数）

// id → 一个确定性整数。**不是**哈希器（那要写多位常数），只是一个把字符位置摊开的加权和：
// 用途只有两个 —— 生气那记抖动的速率偏移、噪声层读共享 buffer 的偏移。
// 同一条 id 永远得到同一个数，而它一个随机数都不消费。
export function idSeed(id) {
  const s = String(id === undefined || id === null ? '' : id);
  let acc = 0;
  for (let i = 0; i < s.length; i += 1) acc += s.charCodeAt(i) * (i + 2);
  return acc;
}

// 色相在粉色区间里的**归一位置**：315° → 0，25° → 1（跨 0° 的弧，解码式与 genes.decode 同一条）。
// 区间只有一处定义（CONFIG.hueRange），与遗传层不会分家；圈周也只有一个定义点。
export function huePosition(hue) {
  const turn = AUD.hueTurn;
  const start = CONFIG.hueRange[0];
  const span = (CONFIG.hueRange[1] - start + turn) % turn;   // 315→25 = 70
  if (!(span > 0)) return 0;
  return clamp(((num(hue) - start + turn) % turn) / span, 0, 1);
}

// 个体嗓音：**音高随体型、音色随色相**。
// pitch 是倍率（表里那些 Hz 乘它）；音色两件都由色相决定 ——
//   filterRatio    低通中心相对基频的倍数（这一系"亮"还是"暗"）
//   overtoneRatio  倍音那只振荡器的频率比（2.02 vs 2.97 这种"略偏的八度"产生拍频，
//                  它就是"这家的孩子听起来是一家的"那个东西）
// 两件都**相对基频**而不是绝对 Hz：绝对低通会把音高与音色互相抵消
// （小只的高音碰上暗桶那一档的中心，被砍掉的就不是泛音而是基频本身），
// 那既不是 spec 那条承诺，也听不出血脉。
// 分桶（hueBuckets）才是"血脉"这件事的实现依据：同一家族的两个孩子色相相近 ⇒ **同一桶 ⇒
// 同一副嗓子**；跨家族则一定换桶。连续插值做不到"分得开又认得出"，只有量化可以。
export function voiceFor(size, hue) {
  const s = Number.isFinite(size) && size > 0 ? size : AUD.refSize;
  // 双曲而不是线性：声学上"体腔小 ⇒ 共鸣高"近似 1/尺寸，且它在小体型一侧自然变陡，
  // 正是刚孵化那批最需要听得出"这是幼体"的地方。两端 clamp 拦住极端值。
  const pitch = clamp(AUD.refSize / s, AUD.pitchMin, AUD.pitchMax);
  const buckets = Math.max(1, Math.floor(AUD.hueBuckets));
  const pos = huePosition(hue);
  const bucket = Math.min(buckets - 1, Math.floor(pos * buckets));
  const center = buckets <= 1 ? 0 : bucket / (buckets - 1);
  return {
    size: s,
    pitch,
    huePos: pos,
    hueBucket: bucket,
    filterRatio: AUD.filterRatioMin + (AUD.filterRatioMax - AUD.filterRatioMin) * center,
    filterQ: AUD.filterQ,
    overtoneRatio: AUD.overtoneRatioMin + (AUD.overtoneRatioMax - AUD.overtoneRatioMin) * center,
    overtoneGain: AUD.overtoneMix,
  };
}

// 参考体型（spec §5.4 表里那些 Hz 所指的那一只）的嗓音 —— 找不到个体时的兜底。
export function referenceVoice() {
  return voiceFor(AUD.refSize, CONFIG.hueRange[0]);
}

// 音高因子按那一行的 pitchMix **打折**：只有低沉那一类（落地闷响）打折，
// 因为它的基频已经贴地，全额乘 0.55 会掉到手机扬声器发不出来的区间。
function applyPitch(voice, mix) {
  return 1 + (num(voice.pitch) - 1) * num(mix);
}

// ---------------------------------------------------------------- 发声计划（纯函数）

// 跨越判据的**唯一原语**：上一帧在阈值下、这一帧到了阈上。
// 为什么是"跨越"而不是"在阈上"：情绪是持续量，joy 到了 0.6 会停留几十秒，
// 按"在阈上"发就是每帧一声、几十秒 1800 声 —— 那既不是叫声也不是声音，是噪音。
// 双参数而不是读 world：让这一条能在 Node 里被直接断言（探针 7 打的就是这里）。
export function crossedUp(prev, cur, threshold) {
  return num(prev) < threshold && num(cur) >= threshold;
}

// 六条探测器 = spec §5.4 表里那四行"情绪性"叫声在这套内核下的**唯一**落地方式：
// 内核没有情绪事件（world.events 的 kinds 是 eat / laid / say / poke / death / dissolved /
// drift / emigrate / eggFailed / hatch / error，一条心情都没有），所以"该不该叫"只能
// 读现量、判跨越。每条给出 read(c)（**只读**个体）、prev(e)/set(e,v)（存在本模块自己的
// entry 上，绝不长在个体身上）、min()（阈值）。
// joy 与 anger 读 CONFIG.mood 那两个数 —— 与 body.js 读 CONFIG.behavior.begEscalate
// 同一条纪律：阈值只许一处定义，否则语言层说"它开心了"而叫声层不同意。
// begLevel 是离散三档，但"上跨阈值 1"与连续量**完全同形**，所以不需要特例；
// 1→2 不再发声，那是"它已经在求关注了"，不是一个新事件。
export const DETECTORS = Object.freeze([
  Object.freeze({ name: 'joy', call: 'joy', min: () => CONFIG.mood.happyJoyMin,
    read: (c) => read(c.emotions, 'joy'), prev: (e) => e.joy, set: (e, v) => { e.joy = v; } }),
  Object.freeze({ name: 'anger', call: 'anger', min: () => CONFIG.mood.angerMin,
    read: (c) => read(c.emotions, 'anger'), prev: (e) => e.anger, set: (e, v) => { e.anger = v; } }),
  Object.freeze({ name: 'sleepy', call: 'sleepy', min: () => AUD.sleepyMin,
    read: (c) => read(c.emotions, 'sleepy'), prev: (e) => e.sleepy, set: (e, v) => { e.sleepy = v; } }),
  Object.freeze({ name: 'tired', call: 'sleepy', min: () => AUD.tiredMin,
    read: (c) => read(c.needs, 'energy'), prev: (e) => e.energy, set: (e, v) => { e.energy = v; } }),
  Object.freeze({ name: 'coo', call: 'beg', min: () => AUD.affectionMin,
    read: (c) => affectionFor(c.memory, PLAYER_ID), prev: (e) => e.affection,
    set: (e, v) => { e.affection = v; } }),
  Object.freeze({ name: 'begLevel', call: 'beg', min: () => 1,
    read: (c) => begLevelOf(c), prev: (e) => e.begLevel, set: (e, v) => { e.begLevel = v; } }),
]);

// hop 落地那一点：**必须**用跨越而不是相等 —— 4× 倍速下一帧推进四个子步，
// 进度可以正好跳过 hopLandAt（0.68 → 0.75），按相等判就永远不响。
// 这条与 render.js 的 hopProgress 是同一份读数（intent.kind / intentTime / intent.minDuration），
// 但**不 import render.js**：那是绘制层，叫声层依赖它会让两个不相干的东西耦在一起。
// 时长口径读同一个 CONFIG.render.hopLandAt，所以不会分家。
export function hopPhase(c) {
  const intent = c && c.intent;
  if (!intent || intent.kind !== 'hop') return -1;
  const dur = num(intent.minDuration);
  if (!(dur > 0)) return -1;
  return clamp(num(c.intentTime) / dur, 0, 1);
}

export function landingCrossed(prevPhase, phase) {
  const land = CONFIG.render.hopLandAt;
  return num(prevPhase) >= 0 && prevPhase < land && phase >= land;
}

// 一次发声的**完整描述**：什么时候、几个声部、每个声部的频率区间与包络、滤波器、抖动 LFO。
// 这里只产数，不碰任何节点 —— 于是"600→900 变成了 600→600"这种错在 Node 里就红。
export function planSound(key, voice, atSec, seed) {
  const spec = AUD[key];
  if (!spec) throw new Error(`planSound: 未知叫声「${String(key)}」，必须是 ${CALL_KEYS.join('/')} 之一`);
  const v = voice || referenceVoice();
  const at = num(atSec);
  const s = Math.floor(num(seed));
  const pitch = applyPitch(v, spec.pitchMix);
  const parts = [];
  const reps = Math.max(1, Math.floor(num(spec.reps) || 1));
  const note = num(spec.noteSec);
  const gap = num(spec.gapSec);
  for (let i = 0; i < reps; i += 1) {
    parts.push({
      kind: 'osc',
      wave: spec.wave,
      from: num(spec.fromHz) * pitch,
      to: num(spec.toHz) * pitch,
      start: i * (note + gap),
      dur: note,
      // attack 必须不超过音长：否则包络的"起音"会跑到释音段之后，
      // 症状是短促那一类（开心两声、啾）听起来又小又慢。
      attack: Math.min(num(spec.attack), note),
      peak: num(spec.peak),
    });
  }
  // 噪声层（卖萌的"一点气泡噪声"、孵化的"细碎裂声"）。共用一块确定性 buffer，
  // 每段只改起点与偏移 —— 于是它既不是"又一只振荡器"也不是随机数。
  const noiseCount = Math.max(0, Math.floor(num(spec.noiseCount)));
  for (let i = 0; i < noiseCount; i += 1) {
    const dur = num(spec.noiseDur);
    parts.push({
      kind: 'noise',
      start: num(spec.noiseGap) > 0 ? i * (dur + num(spec.noiseGap)) : i * AUD.noiseStepSec,
      dur,
      attack: dur / 4,
      peak: num(spec.noisePeak),
      // 偏移由 i 与 id 派生（同一个个体每次碎裂的纹理一致 ⇒ 听起来是同一副嗓子）
      offset: ((i + s) % Math.max(1, noiseCount)) * AUD.noiseStepSec,
      rate: 1,
    });
  }
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const end = parts[i].start + parts[i].dur;
    if (end > total) total = end;
  }
  // "轻微抖动"：一只 LFO 调制主振荡的 frequency。速率的每只差异由 id 派生，零随机数。
  let lfo = null;
  const lfoRate = num(spec.lfoRateBase);
  if (lfoRate > 0) {
    const mod = Math.max(1, Math.floor(AUD.lfoSeedModulus));
    const off = (s % mod) - (mod - 1) / 2;
    lfo = {
      rate: lfoRate * (1 + off * AUD.lfoSeedSpread),
      depthHz: num(spec.lfoDepthHz) * pitch,
      target: 0,           // 调制 parts[0] 那一个主振荡器
      span: total,
    };
  }
  // 音色两件：低通中心与倍音比都**相对基频**（见 voiceFor 那条），所以音高一动它们跟着动，
  // 不会出现"小只的高音被暗桶砍成闷响"这种音色与音高互相抵消的情况。
  const head = parts[0];
  const headTop = head.from > head.to ? head.from : head.to;
  const overtone = {
    ratio: num(v.overtoneRatio),
    from: head.from * num(v.overtoneRatio),
    to: head.to * num(v.overtoneRatio),
    peak: head.peak * num(v.overtoneGain),
    start: head.start,
    dur: head.dur,
    attack: head.attack,
  };
  return {
    key,
    at,
    total,
    end: at + total + AUD.releaseSec,
    parts,
    lfo,
    overtone,
    filter: { hz: headTop * num(v.filterRatio), q: num(v.filterQ) },
    seed: s,
  };
}

// 事件与跨越两条通道共用的这条"该不该响"的判据：**跨越 → 冷却**。
// 冷却用 graph 秒（见文件头那条 ⚠️）。存的是**上次发声的时刻**，
// 所以 -Infinity（从没响过）必须算"就绪" —— 这条不能走 num()：
// num(-Infinity) 是 0，会把开缸头几秒的所有叫声静默吃掉。
export function cooldownReady(lastAt, nowSec) {
  if (!(lastAt > 0)) return true;
  return nowSec - lastAt >= AUD.cooldownSec;
}

// ---------------------------------------------------------------- 接线（需要注入 graph）

// 注入形状校验。**只在构造时抛**：consume 里再抛会让主循环整帧崩掉（spec §7.7 反对的就是它）。
function assertGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new Error('createAudio: 需要注入一个音频图（{ currentTime, destination, createOscillator, createGain }）');
  }
  for (const fn of ['createOscillator', 'createGain']) {
    if (typeof graph[fn] !== 'function') throw new Error(`createAudio: 注入的音频图没有 ${fn}()`);
  }
  if (!graph.destination) throw new Error('createAudio: 注入的音频图没有 destination');
}

// 一块**确定性**噪声 buffer：三个互不成周期的整数倍正弦相加（sin 的自变量是整数下标 × 小素数，
// 所以序列不会精确重复，听起来才像"碎裂"而不像"蜂鸣"）。
// 不用随机数（文件头第 3 条）—— 于是"孵化那记碎裂"在同一台设备上永远一样，
// 而"关掉声音"与"开着声音"两种跑法消费到的随机数序列一个字节都不差。
function fillNoise(data) {
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.sin(i * 3) + Math.sin(i * 5) + Math.sin(i * 7)) / 3;
  }
}

export function createAudio(opts) {
  const o = opts || {};
  const graph = o.graph;
  assertGraph(graph);
  const master = Number.isFinite(o.masterGain) ? o.masterGain : AUD.masterGain;
  const maxVoices = Math.max(1, Math.floor(Number.isFinite(o.maxVoices) ? o.maxVoices : AUD.maxVoices));

  const entries = new Map();     // id → 该只的读数与冷却（**按世界成员身份回收**）
  const voices = [];             // 发声槽：{ end, nodes }
  const stats = {
    frames: 0, events: 0, played: 0, dropped: 0, thudDropped: 0, chirpDropped: 0,
    created: 0, started: 0, stopped: 0, disconnected: 0,
    reclaimed: 0, entries: 0, entriesMax: 0,
    silentEvents: 0, mutedSkips: 0, filterSkipped: 0, noiseSkipped: 0,
    cooldownSkips: 0, buffers: 0, closed: 0,
    calls: {},                   // 每种叫声明了几次（固定形状：CALL_KEYS，不会长新键）
  };
  for (let i = 0; i < CALL_KEYS.length; i += 1) stats.calls[CALL_KEYS[i]] = 0;

  let muted = !!o.muted;
  let closed = false;
  let lastThudAt = Number.NEGATIVE_INFINITY;
  // 「啾」的全局闸门时刻。理由与量出来的数都写在 CONFIG.audio.chirpGapSec 那一行旁边：
  // 事件通道**不过**每只的冷却（那条是给跨越那六声用的），所以一缸话痨在 4× 下会把
  // 这记"这声音是它自己发的"的前导音打成一梭子 —— 那既不是前导音也不是声音，是嗡嗡。
  let lastChirpAt = Number.NEGATIVE_INFINITY;
  let noise = null;              // 一块、终身复用（容量由 CONFIG.audio.noiseBufferSec 定）

  // 主输出：一个常驻 gain 节点。静音走它 + 不再排程**两条**，
  // 因为已经排进队列的振荡器不会因 muted=true 而消失。
  const bus = graph.createGain();
  bus.gain.setValueAtTime(muted ? 0 : master, 0);
  bus.connect(graph.destination);
  stats.created += 1;

  const now = () => num(graph.currentTime);
  const at = () => now() + AUD.lookaheadSec;

  function noiseBuffer() {
    if (noise) return noise;
    if (typeof graph.createBuffer !== 'function') return null;
    const rate = num(graph.sampleRate) > 0 ? num(graph.sampleRate) : AUD.fallbackSampleRate;
    // 长度必须盖过**最大偏移 + 最长一段**：偏移读过了头，Web Audio 不报错、直接播静音，
    // 症状是"细碎裂声只剩前两下"。
    const len = Math.max(1, Math.ceil(rate * AUD.noiseBufferSec));
    const buf = graph.createBuffer(1, len, rate);
    if (buf && typeof buf.getChannelData === 'function') {
      fillNoise(buf.getChannelData(0));
    }
    noise = buf;
    stats.buffers += 1;
    return noise;
  }

  function releaseVoice(v) {
    for (let i = 0; i < v.nodes.length; i += 1) {
      v.nodes[i].disconnect();
      stats.disconnected += 1;
    }
    v.nodes.length = 0;
  }

  // 槽位回收：按 graph 时钟判，不按帧数（同一段声音在不同帧率下必须等长）。
  function prune(t) {
    for (let i = voices.length - 1; i >= 0; i -= 1) {
      if (voices[i].end <= t) {
        releaseVoice(voices[i]);
        voices.splice(i, 1);
      }
    }
  }

  // 把一个 plan 落到节点上。**每个创建的节点都进 nodes 列表**，槽位释放时统一 disconnect。
  function schedule(plan) {
    if (closed) return false;
    if (muted) { stats.mutedSkips += 1; return false; }
    const t = now();
    prune(t);
    if (voices.length >= maxVoices) {
      // 溢出必须**计数**：静默丢是 §7.7 明确禁止的，而"听不见"没有任何症状可观察。
      stats.dropped += 1;
      return false;
    }
    const nodes = [];
    const mainOscs = [];
    const base = plan.at;
    const mk = (name) => {
      const n = graph[name]();
      nodes.push(n);
      stats.created += 1;
      return n;
    };

    // 音色这一层（低通）。注入的图没有 createBiquadFilter 时**降级但记账**：
    // 少一层滤波不报错，可"这缸的音色没跟着色相走"这件事必须看得见（§7.7）。
    let tail = bus;
    if (typeof graph.createBiquadFilter === 'function') {
      const f = mk('createBiquadFilter');
      f.type = 'lowpass';
      f.frequency.setValueAtTime(plan.filter.hz, base);
      f.Q.setValueAtTime(plan.filter.q, base);
      f.connect(bus);
      tail = f;
    } else {
      stats.filterSkipped += 1;
    }

    // 一条音量包络：silence → peak（起音段）→ silence（释音段）。
    // 终点用 CONFIG 里那个极小值而不是真 0：exponentialRamp 到 0 会当场抛，
    // 而"到 0 之后再 setValueAtTime"读起来是一记咔哒。
    const envelope = (g, t0, tEnd, peak, attack) => {
      g.gain.setValueAtTime(AUD.silenceGain, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.linearRampToValueAtTime(AUD.silenceGain, tEnd);
    };

    // 一只振荡器 + 它的包络增益 + 排好的 start/stop。返回那只振荡器，好让 LFO 接上去。
    // **每个从这里出去的节点都在 nodes 里**，槽位释放时统一 disconnect —— 漏一个就是漏一只。
    const tone = (p, t0) => {
      const t1 = t0 + p.dur;
      const tEnd = t1 + AUD.releaseSec;
      const osc = mk('createOscillator');
      osc.type = p.wave;
      osc.frequency.setValueAtTime(p.from, t0);
      osc.frequency.linearRampToValueAtTime(p.to, t1);
      const g = mk('createGain');
      envelope(g, t0, tEnd, p.peak, p.attack);
      osc.connect(g);
      g.connect(tail);
      osc.start(t0);
      osc.stop(tEnd);
      stats.started += 1;
      stats.stopped += 1;
      return osc;
    };

    for (let i = 0; i < plan.parts.length; i += 1) {
      const p = plan.parts[i];
      const t0 = base + p.start;
      if (p.kind === 'osc') { mainOscs.push(tone(p, t0)); continue; }
      // 噪声层：共享那块确定性 buffer，每段只改起点与读取偏移。
      // 注入的图没有 createBufferSource 时**记账着降级**，绝不当"没有这层"糊过去。
      const buf = noiseBuffer();
      if (!buf || typeof graph.createBufferSource !== 'function') { stats.noiseSkipped += 1; continue; }
      const tEnd = t0 + p.dur + AUD.releaseSec;
      const src = mk('createBufferSource');
      src.buffer = buf;
      src.playbackRate.setValueAtTime(p.rate, t0);
      const g = mk('createGain');
      envelope(g, t0, tEnd, p.peak, p.attack);
      src.connect(g);
      g.connect(tail);
      // 缓冲源比振荡器多一个"从 buffer 的哪儿开始读"。分开写而不是靠 undefined 占位：
      // 真实 OscillatorNode.start 的第二个参数**不存在**，混着写桩会记下一次假读数。
      src.start(t0, p.offset);
      src.stop(tEnd);
      stats.started += 1;
      stats.stopped += 1;
    }

    // 倍音：一只正弦挂在**色相推导出的那个偏离八度的比**上。
    // 它是"每条血脉有自己的嗓音"里唯一在正弦上也成立的机制（低通对正弦只是音量），
    // 拍频随桶变化 ⇒ 两家孩子的嗓子听得出不一样，而不看屏幕也能认出是哪一家的。
    const ov = plan.overtone;
    if (ov) tone({ wave: 'sine', from: ov.from, to: ov.to, dur: ov.dur,
      attack: ov.attack, peak: ov.peak }, base + ov.start);

    // 抖动：一只慢振荡器 + 一个深度增益，接到主振荡的 **frequency 参数**上。
    // 它同样被 stop、同样被 disconnect —— 漏掉它的症状是每声"生气"留一只永久振荡器。
    if (plan.lfo && mainOscs.length > 0 && mainOscs[plan.lfo.target]) {
      const l = plan.lfo;
      const osc = mk('createOscillator');
      osc.type = 'sine';
      osc.frequency.setValueAtTime(l.rate, base);
      const depth = mk('createGain');
      depth.gain.setValueAtTime(l.depthHz, base);
      osc.connect(depth);
      depth.connect(mainOscs[l.target].frequency);
      osc.start(base);
      osc.stop(base + l.span + AUD.releaseSec);
      stats.started += 1;
      stats.stopped += 1;
    }

    voices.push({ end: plan.end, nodes });
    stats.played += 1;
    stats.calls[plan.key] += 1;
    return true;
  }

  // 排一次声。**冷却时刻在这里记，而不是在 schedule 里**：
  // 被发声上限挤掉的那一次也算"响过了"，否则一只被挤掉的个体会在下一帧立刻重试，
  // 上限就变成了"每帧都尝试、每帧都丢"的空转。症状听不出来，但 stats.dropped 会一直涨。
  // 嗓音（voiceOf）在这里才算，而不是每帧算：它 new 一个对象，放在帧路径上就是
  // 24 只 × 60 帧 = 每秒 1440 次分配（spec §5.3 运行时零分配）。叫声是稀疏事件。
  function playCall(key, c, seed, entry) {
    const t = now();
    if (entry) entry.last[key] = t;
    if (key === 'thud') lastThudAt = t;
    const ok = schedule(planSound(key, voiceOf(c), at(), seed));
    if (ok && entry) entry.played[key] += 1;
    return ok;
  }

  const findCreature = (world, id) => {
    const cs = world && world.creatures;
    if (!cs) return null;
    for (let i = 0; i < cs.length; i += 1) if (cs[i].id === id) return cs[i];
    return null;
  };

  function voiceOf(c) {
    const size = c && c.traits ? sizeOf(c) : AUD.refSize;
    const hue = c && c.traits ? read(c.traits, 'hue') : CONFIG.hueRange[0];
    return voiceFor(size, hue);
  }

  // 每只一份、固定形状的私有状态。**只存标量**，不存 creature 引用：
  // 留住引用就等于把一个已经死掉的个体挂在表现层，那是另一种漏。
  function newEntry(c) {
    const e = {
      joy: read(c.emotions, 'joy'),
      anger: read(c.emotions, 'anger'),
      sleepy: read(c.emotions, 'sleepy'),
      energy: read(c.needs, 'energy'),
      affection: affectionFor(c.memory, PLAYER_ID),
      begLevel: begLevelOf(c),
      hopPhase: hopPhase(c),
      last: {},
      played: {},
    };
    for (let i = 0; i < CALL_KEYS.length; i += 1) {
      e.last[CALL_KEYS[i]] = Number.NEGATIVE_INFINITY;
      e.played[CALL_KEYS[i]] = 0;
    }
    return e;
  }

  // 跨越检测：把 DETECTORS 那六条读一遍，与上一帧比，命中就排一次声。
  // 第一眼（新建 entry）不发任何声也不发闷响 —— 否则一开缸 24 只同时尖叫，
  // 而那件事不是"发生了什么"，只是"表现层第一次看见这只"。
  //
  // 同帧多条命中只响**第一条**（顺序就是 DETECTORS 的顺序：快乐 → 生气 → 困倦 → 撒娇）。
  // 理由不是省事：两只叠在一起同类声在耳朵里是一坨，而"它又开心又困"这种自相矛盾
  // 正好是 spec §4.5.1 里 moodOf 不许写成互斥状态机的那个东西 —— 声带上必须裁决一次。
  function detect(c, e, seed) {
    const t = now();
    let fired = null;
    for (let i = 0; i < DETECTORS.length; i += 1) {
      const d = DETECTORS[i];
      const cur = d.read(c);
      if (fired === null && crossedUp(d.prev(e), cur, d.min())) fired = d.call;
      d.set(e, cur);
    }
    if (fired !== null) {
      if (cooldownReady(e.last[fired], t)) playCall(fired, c, seed, e);
      else stats.cooldownSkips += 1;
    }

    // 落地那记闷响：跨 CONFIG.render.hopLandAt 那一点。它自带两道闸门 ——
    // 每只一次（thudPerSec，同一跳不许重复报）+ **全局**一次（thudGapSec，防机关枪）。
    // 全局那道是 spec §9.2 第 8 条"靠闷响密度听出哪只最活泼"的前提：
    // 没有它，24 只好动个体在 4× 下会把闷响打成一梭子，密度信息当场淹没在噪音里。
    const phase = hopPhase(c);
    if (landingCrossed(e.hopPhase, phase)) {
      if (t - e.last.thud >= AUD.thudPerSec && t - lastThudAt >= AUD.thudGapSec) {
        playCall('thud', c, seed, e);
      } else {
        stats.thudDropped += 1;
      }
    }
    e.hopPhase = phase;
  }

  const consume = (events, world) => {
    if (closed) return 0;
    stats.frames += 1;
    prune(now());
    let made = 0;
    // 1) 事件通道。清空由 main.js 负责（同一批事件 renderer 也要读，谁先清空谁抢走）。
    if (Array.isArray(events)) {
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        if (!ev) continue;
        stats.events += 1;
        const key = callForEvent(ev.kind);
        if (!key) { stats.silentEvents += 1; continue; }
        // 「啾」这条通道上**只允许**读体型与色相：ev.mood / ev.text / ev.tokens 一概不碰。
        // 碰了就是给台词配音，spec §5.4 那条"两条通道不许同步"当场作废。
        // 找不到个体（迟到的死亡事件之类）也要响，用参考嗓音 —— 静默是 §7.7 禁止的。
        if (key === 'chirp') {
          // 闸门只管装饰声。**不**管 hatch / death：那两声是稀缺的、语义重的，
          // 把它们关进同一个闸门的症状是"卵孵出来了却一声不响"。
          const t = now();
          if (t - lastChirpAt < AUD.chirpGapSec) { stats.chirpDropped += 1; continue; }
          lastChirpAt = t;        // 与 thud 同一口径：占坑在排程之前，静音期间也不留积压
        }
        if (schedule(planSound(key, voiceOf(findCreature(world, ev.id)), at(), idSeed(ev.id)))) made += 1;
      }
    }
    // 2) 跨越通道 + 3) 按成员身份回收。
    const cs = world && world.creatures;
    if (Array.isArray(cs)) {
      for (let i = 0; i < cs.length; i += 1) {
        const c = cs[i];
        let e = entries.get(c.id);
        if (!e) {
          entries.set(c.id, newEntry(c));
          continue;
        }
        detect(c, e, idSeed(c.id));
      }
      // 镜像 body.js 的 reconcileBodies：**按世界成员身份**判，不用 seen 标记。
      // 标记法在 0.5× 的空帧里会把全部条目误删，下一帧再全部重建 ⇒ 所有个体
      // 都变成"第一次看见"，于是一开嗓就永远不响（静默失效，且没有一条报错）。
      // 这里也**不**加"entries.size > cs.length 才扫"这种快捷条件：同一帧里
      // 一只死掉、一只孵化是常态（size 恰好相等），那样写会留下一条永不回收的僵尸条目。
      entries.forEach((e, id) => {
        let found = false;
        for (let i = 0; i < cs.length; i += 1) if (cs[i].id === id) { found = true; break; }
        if (!found) { entries.delete(id); stats.reclaimed += 1; }
      });
      stats.entries = entries.size;
      if (entries.size > stats.entriesMax) stats.entriesMax = entries.size;
    }
    return made;
  };

  const setMuted = (value) => {
    muted = !!value;
    if (closed) return muted;
    // 已排进队列的振荡器不会因 muted 而消失，所以总线一起走零。
    bus.gain.setValueAtTime(muted ? 0 : master, now());
    return muted;
  };

  const close = () => {
    if (closed) return false;
    closed = true;
    for (let i = 0; i < voices.length; i += 1) releaseVoice(voices[i]);
    voices.length = 0;
    bus.disconnect();
    stats.disconnected += 1;
    entries.clear();
    stats.closed = 1;
    return true;
  };

  return {
    consume,
    setMuted,
    getMuted: () => muted,
    close,
    stats,
    // 取证用：只读的形状检查，不暴露可写的内部结构。
    graph,
    isClosed: () => closed,
    voiceCount: () => voices.length,
    entryIds: () => Array.from(entries.keys()),
    maxVoices,
  };
}
