// bubble.js —— 第 8 层语言气泡的**排队与文本**（spec §5.1 第 8 层 / §4.13.1 显示纪律 / §5.3）。
//
// 分工与 B15 的眼睛同一形状（src/eyes.js 那个先例）：**算**的东西全在这个文件里，
// render.js 只负责把它画出来。拆的理由不是整洁，是可测性 —— 「最多 2 行」「同屏最多 2 个」
// 「溢出丢最旧的」「3 秒淡出」这四条纪律全是**值**，能在 Node 里直接断言；
// 一旦混进绘制路径，就只剩桩的次数证据，而次数抓不到「把最旧的换成最新的」这种错。
//
// 五条硬约束与它们在这一层的落点：
//
// 1. **不写世界**（spec §7.2：表现层的身体状态一律不入档，唯一例外是 catchphrase）。
//    本模块只碰自己那份池子；池子挂在 renderer 上，每帧从 `say` 事件与经过的时间推导。
//    于是「关掉文字层 ⇒ 其余状态逐位不变」这条对照不需要在这里做什么特殊处理：
//    世界从来就不知道气泡存在。
//
// 2. **队列有上界**：容量 = `onscreenMax × bubbleQueueMul`（spec §4.13.1 只说了「其余排队」，
//    没说排多少）。没有上限的话，24 只 × 每 6–18 秒一句会让队列无界增长 ——
//    与 world.events 那个「必须每帧清空否则无界」的教训同源。
//    溢出时丢**排队者里最旧的那条**（正在显示的不被打断：中途撤字等于吞字），
//    并且 `dropped` 计数可断言。**静默丢是 §7.7 禁止的**。
//
// 3. **换行在「上场那一刻」做一次**，不是每帧重算。真实 measureText 是 Canvas 2D 里
//    相对贵的一步（§5.3 正是用它来给气泡定预算的），每帧重量等于把上界 2 条的意义抹掉。
//    代价如实记在这里：视口在一条气泡显示期间被拖动改宽，那两行不会立刻重新折行，
//    最多 3 秒后自然换掉。这是有意的取舍，不是漏的。
//
// 4. **时间用模拟秒**（renderer.time 那一份），与水体/溶散同一个时钟。用渲染帧时长的话
//    4× 倍速下台词会冻在原速，而缸在快进 —— B16 为溶散记过同一条账。
//
// 5. **随机性零消耗**。这里没有一处 rng：排队顺序由事件到达顺序决定，淡出由时间决定。
//    帧率相关的抽样会让同一个种子在两台设备上长出不同的缸（render.js 文件头的老纪律）。
//
// ⚠️ 池子的形状沿用 createBursts 那套「并列数组 + 有界」而不是对象数组，但**字符串只能
// 放在普通 Array 里**（typed array 装不了字符串）。槽位在 createBubbles 时一次建满，
// 运行中只改引用、不 push、不 splice、不 new ⇒ 稳态零分配。
//
// ⚠️ 字体测量能力由调用方注入（真实 canvas 的 ctx，或测试里的桩）。本模块不碰任何浏览器全局，
// 也不许出现那个以 f-e-t-c-h 开头的名字 —— 那是 B19b 的口子，规则档自己偷偷发请求就废了
// spec §4.13.2 那三条硬纪律。
import { CONFIG } from './config.js';

// 队列容量 = 同屏上限 × 排队倍率。两个数都从 CONFIG 读，所以「上界」这件事只有一个定义点。
export function bubblePoolCapacity() {
  const S = CONFIG.speech;
  const per = Math.max(1, Math.floor(S.onscreenMax));
  const mul = Math.max(1, Math.floor(S.bubbleQueueMul));
  return per * mul;
}

export function createBubbles(cap) {
  const n = Math.max(1, Math.floor(cap));
  const lines = Math.max(1, Math.floor(CONFIG.speech.bubbleMaxLines));
  const lineText = [];
  const lineWidth = [];
  for (let i = 0; i < n; i++) {
    lineText.push(new Array(lines).fill(''));
    lineWidth.push(new Array(lines).fill(0));
  }
  return {
    n, count: 0,
    id: new Array(n).fill(''),
    text: new Array(n).fill(''),
    // token 数组**按引用存**：speech.js 每次组装都给一份新数组，之后没人改它
    // （c.speech.lastTokens 与事件里那条是同一份，但内核只读不写）。
    tokens: new Array(n).fill(null),
    bornAt: new Float64Array(n),          // 这条say 到达的模拟秒（排队等待 = shownAt − bornAt）
    shownAt: new Float64Array(n).fill(-1),  // −1 = 还在排队；>=0 = 正在显示的那一秒开始
    lineCount: new Uint8Array(n),
    boxW: new Float64Array(n),
    lines: lineText,
    widths: lineWidth,
    // 换行用的复用容器（每帧最多 2 次 promote，一次分配都没有）
    wrap: { lines: new Array(lines).fill(''), widths: new Array(lines).fill(0), count: 0, used: 0, clipped: 0 },
    // ---- 六个读数：每一条气泡的去向都必须可断言，没有一条是静默消失的 ----
    accepted: 0,      // 进过池子的条数
    rejected: 0,      // 事件形状不对、压根没进池子（脏存档/未来字段，不抛）
    dropped: 0,       // 队列满时被丢掉的那几条（**丢最旧的**）
    superseded: 0,    // 同一只又说了新的一句，旧的那条让位
    expired: 0,       // 自然淡完被收走的
    shown: 0,         // 上过场的（含排队之后才上场的）
    clipped: 0,       // 因为两行装不下而被截掉的词数
    lastWait: 0,      // 最近一次提升的排队等待秒数
  };
}

// 池子是**从 0 开始的稠密数组**，不是环形：`removeAt` 把后面的活口往前挤（最多 8 格，
// 线性搬移比维护一个洞便宜得多），所以「第 rel 条」的下标就是 rel。
// 这里曾经有一个**永不前进**的 `head` 假装它是环形 —— 删掉，因为那个假象会让搬移逻辑
// 看起来可以绕回尾部，而 `removeAt` 的稠密不变量恰恰不允许。

// 把一整个槽位搬过去（引用赋值，不新建任何东西）。
function copySlot(b, src, dst) {
  b.id[dst] = b.id[src];
  b.text[dst] = b.text[src];
  b.tokens[dst] = b.tokens[src];
  b.bornAt[dst] = b.bornAt[src];
  b.shownAt[dst] = b.shownAt[src];
  b.lineCount[dst] = b.lineCount[src];
  b.boxW[dst] = b.boxW[src];
  const ls = b.lines[dst], ss = b.lines[src];
  const ws = b.widths[dst], sw = b.widths[src];
  for (let k = 0; k < ls.length; k++) { ls[k] = ss[k]; ws[k] = sw[k]; }
}

// 删掉相对位置 rel 那一条，后面的往前挤。池子最多 8 格，所以这条线性搬移比维护
// 一个「洞」便宜得多，而且 FIFO 顺序是这套东西唯一的语义（「先说的先上场」）。
function removeAt(b, rel) {
  for (let k = rel; k < b.count - 1; k++) copySlot(b, k + 1, k);
  b.count -= 1;
}

const visibleCount = (b) => Math.min(Math.max(1, Math.floor(CONFIG.speech.onscreenMax)), b.count);

// 溢出时该撤哪一条：**排队者里最旧的那条**。正在显示的不被打断 ——
// 中途撤字等于把说到一半的话吞掉，而那正是这一层要传达的东西反面。
// （全池都在显示 only happens 当 onscreenMax ≥ 容量，CONFIG 的 bubbleQueueMul ≥ 2 拦住了；
//  留这一支是为了配置被改坏时也不许无界增长，而不是让它悄悄回来。）
function evictOverflow(b) {
  for (let rel = 0; rel < b.count; rel++) {
    if (b.shownAt[rel] < 0) { removeAt(b, rel); b.dropped += 1; return; }
  }
  removeAt(b, 0);
  b.dropped += 1;
}

// 收到一条 say。返回 1 = 进了队列，0 = 形状不对被拒（有读数，不静默）。
export function pushSay(b, ev, nowSec) {
  if (!ev || typeof ev.id !== 'string' || ev.id === ''
    || typeof ev.text !== 'string' || ev.text === '') {
    b.rejected += 1;
    return 0;
  }
  const tk = Array.isArray(ev.tokens) && ev.tokens.length > 0 ? ev.tokens : ev.text.split(' ');
  const born = Number.isFinite(nowSec) ? nowSec : 0;
  // 同一只只留最新那句：让它自己的旧台词与新台词并排挂在屏上是 bug 不是特性
  // （症状是「它同时说了两件事」，而 24 只的缸里这种碰撞天天发生）。
  for (let rel = 0; rel < b.count; rel++) {
    if (b.id[rel] === ev.id) { removeAt(b, rel); b.superseded += 1; break; }
  }
  if (b.count >= b.n) evictOverflow(b);
  const idx = b.count;
  b.id[idx] = ev.id;
  b.text[idx] = ev.text;
  b.tokens[idx] = tk;
  b.bornAt[idx] = born;
  b.shownAt[idx] = -1;
  b.lineCount[idx] = 0;
  b.boxW[idx] = 0;
  const ls = b.lines[idx];
  const ws = b.widths[idx];
  for (let k = 0; k < ls.length; k++) { ls[k] = ''; ws[k] = 0; }
  b.count += 1;
  b.accepted += 1;
  return 1;
}

// 把池子里前 onscreenMax 条压成「正在显示」，其余继续排队。返回同屏条数（可断言的读数）。
//
// 顺序很重要：先收走淡完的，再提升 —— 反过来的话同屏会出现 3 条（旧的一条还在淡、
// 新的一批已经顶上），而那正是 spec 说「弹幕是这个项目最该避免的东西」的那一幕。
export function advanceBubbles(b, nowSec, maxWidthPx, measure) {
  const S = CONFIG.speech;
  const now = Number.isFinite(nowSec) ? nowSec : 0;
  const ttl = S.bubbleTtl > 0 ? S.bubbleTtl : 1;
  // ① 收走淡完的。只有已经在显示的那几条会到期：排队者还没开始说话，不该先老。
  let removed = 0;
  for (let rel = 0; rel < b.count; rel++) {
    const src = rel;
    if (b.shownAt[src] >= 0 && now - b.shownAt[src] >= ttl) {
      b.expired += 1;
      removed += 1;
      continue;                       // 这一格不搬：它会被后面那条活口覆盖掉
    }
    if (removed > 0) copySlot(b, src, rel - removed);
  }
  b.count -= removed;
  // ② 提升队头，并**在这一刻**量字折行（此后的每一帧只读缓存，见文件头第 3 条）。
  const vis = visibleCount(b);
  for (let rel = 0; rel < vis; rel++) {
    const idx = rel;
    if (b.shownAt[idx] >= 0) continue;
    b.shownAt[idx] = now;
    b.lastWait = now - b.bornAt[idx];
    b.shown += 1;
    const out = b.wrap;
    wrapInto(out, b.tokens[idx], maxWidthPx, measure, b.lines[idx].length);
    const n = out.count;
    if (out.clipped > 0) b.clipped += out.clipped;
    const ls = b.lines[idx];
    const ws = b.widths[idx];
    let wmax = 0;
    for (let k = 0; k < n; k++) { ls[k] = out.lines[k]; ws[k] = out.widths[k]; if (out.widths[k] > wmax) wmax = out.widths[k]; }
    b.lineCount[idx] = n;
    b.boxW[idx] = wmax + 2 * S.bubblePadding;
  }
  return vis;
}

// 贪心折行：按 **token** 断行，绝不在词中间切（「要模/摸」不是中文换行，是坏掉的 UI）。
// 装进 out 并返回行数 —— 返回新对象就是每帧一次分配（spec §5.3）。
//
// 两条不许咬人的规则：
//   · 单条 token 本身就超宽 ⇒ 让它独占一行、宁可撑到上限也不吞字（少说一个字比超框严重）。
//   · 行数用完还剩词 ⇒ 截掉，但 `clipped` 计数（静默截词与静默丢气泡是同一类失败）。
export function wrapInto(out, tokens, maxWidthPx, measure, maxLines) {
  const m = measureFn(measure);
  const lim = Math.max(1, Math.min(Math.floor(maxLines || 1), out.lines.length));
  for (let i = 0; i < out.lines.length; i++) { out.lines[i] = ''; out.widths[i] = 0; }
  out.count = 0; out.used = 0; out.clipped = 0;
  const cap = Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? maxWidthPx : Infinity;
  const list = Array.isArray(tokens) ? tokens : [];
  let li = 0;
  let cur = '';
  let curW = 0;
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const t = typeof list[i] === 'string' ? list[i] : '';
    if (t === '') continue;                       // 空 token 不占位（内核不会给，桩会给）
    if (cur === '') { cur = t; curW = m(t); used = i + 1; continue; }
    const trial = cur + ' ' + t;
    const w = m(trial);
    if (w <= cap) { cur = trial; curW = w; used = i + 1; }
    else {
      if (li + 1 >= lim) {
        // 行数用完：把**已经攒好的这一行**落地，再截掉后面的。
        // 早退时必须先写 lines[li]，否则 count 声称有 lim 行、最后一行却是空的
        // ——桩里看不见空白行，而 count 会被下游拿去做框高（每行都算一份 bubbleFontPx），
        // 症状是「气泡有两行高但只有一行字」，同时静默吞掉一整行词。
        out.lines[li] = cur;
        out.widths[li] = curW;
        out.count = lim;
        out.used = used;
        out.clipped = list.length - used;
        return out;
      }
      out.lines[li] = cur;
      out.widths[li] = curW;
      li += 1;
      cur = t;
      curW = m(t);
      used = i + 1;
    }
  }
  if (cur !== '') {
    out.lines[li] = cur;
    out.widths[li] = curW;
    li += 1;
  }
  out.count = li;
  out.used = used;
  return out;
}

// 字体测量能力**必须**由注入提供：本模块不知道真实字体的度量表，
// 也不许在这里凑一个「一个汉字 = 14px」的假数（那会让换行与屏上不一致）。
function measureFn(measure) {
  if (typeof measure === 'function') return measure;
  if (measure && typeof measure.measureText === 'function') {
    return (s) => {
      const r = measure.measureText(s);
      return r && Number.isFinite(r.width) ? r.width : String(s).length;
    };
  }
  throw new TypeError('wrapInto: 需要注入字体测量 measure（函数，或带 measureText 的对象）');
}

// 淡出曲线：前 `bubbleFadeHold` 段满亮（字要先读得完），之后线性淡到 0。
// 不做「弹入放大」那种额外动画：§5.3 的预算与「装饰让位于身体语言」的裁定都不支持它。
export function bubbleFade(age, ttl, holdFrac) {
  const S = CONFIG.speech;
  const T = Number.isFinite(ttl) && ttl > 0 ? ttl : (S.bubbleTtl > 0 ? S.bubbleTtl : 1);
  const a = Number.isFinite(age) ? age / T : 1;
  if (a <= 0) return 1;
  if (a >= 1) return 0;
  let h = Number.isFinite(holdFrac) ? holdFrac : S.bubbleFadeHold;
  if (h < 0) h = 0;
  if (h > 0.9) h = 0.9;
  if (a <= h) return 1;
  return 1 - (a - h) / (1 - h);
}
