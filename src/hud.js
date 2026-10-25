// HUD 的视图模型。计划 3 Task 3。**纯**：只读 world / creature，产出字符串与数字，不碰 DOM。
// DOM 那一半在 Task 4 追加到本文件末尾，它拿 `doc` 是**形参注入**的（与 render.js 的 ctx、
// audio.js 的 graph、input.js 的监听目标同一条路子）—— 于是本文件不出现 document/window，
// tests/constraints.test.js 的纯度守卫照旧覆盖它。
//
// 这个文件存在的意义不是"把字排好看"，是**守住一条边界**：
// 信息卡是照料者的观察记录，不是它在对你说话（spec §6.3 / §13.2 第 4 条）。
// 所以这里**没有一行**读 moodOf —— 唯一读它的是肖像，而肖像是它的脸，
// 属于 spec 明文许可的那条正面通道（"心情只能从它自己的身体和它自己选择的词里读出来"）。
import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';
import { affectionFor, PLAYER_ID } from './memory.js';
import { expressionFor, avatarSrc, preloadList } from './avatar.js';
// 端点判据只有一份：configIssue 与设置页共用，否则会出现"设置页说能存、档位却拒发请求"。
import { endpointIssue } from './api.js';
import { familyModelFor, layoutFamily } from './family.js';

const H = CONFIG.hud;
const DASH = '—';

// 九维性格的轴名。顺序 = spec §4.1 那张表的顺序，**也是雷达图的顶点顺序**，
// 换序等于换图，所以它是一份要显式改的清单而不是 Object.keys 的副产品。
const PERSONALITY_AXES = Object.freeze([
  ['bold', '大胆'], ['clingy', '黏人'], ['irritable', '暴躁'], ['gluttonous', '贪吃'],
  ['curious', '好奇'], ['activity', '好动'], ['talk', '话多'], ['intellect', '聪明'],
  ['broody', '恋巢'],
]);

// 阶段与蛋色的中文表。**键集必须与内核那边同一份**，所以有测试逐键比对
// （tests/hud.test.js 的"八个蛋色都有名字"那条）—— 少一个的症状不是报错，
// 而是卡上直接吐出 'macaron-lilac' 这种玩家读不懂的英文键。
const STAGE_LABEL = Object.freeze({
  hatchling: '幼体', juvenile: '亚成体', adult: '成体', elder: '老年', dead: '已故',
});
const EGG_TINT_LABEL = Object.freeze({
  'macaron-pink': '马卡龙粉', 'macaron-blue': '马卡龙蓝', 'macaron-mint': '马卡龙薄荷',
  'macaron-lilac': '马卡龙丁香', 'macaron-cream': '马卡龙奶油', 'macaron-peach': '马卡龙蜜桃',
  white: '奶白', black: '炭黑',
});

const num = (v) => (Number.isFinite(v) ? v : 0);
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const hasOwn = (o, k) => Object.hasOwn(o, k);

/**
 * 秒 → 人话。四段刻度，**分/时的低位补零**：不补的话时间在跳秒时整行宽度抖动，
 * 而这一行每 250ms 重排一次（H.cardRefreshMs）。
 */
export function formatAge(sec) {
  if (!Number.isFinite(sec) || sec < 0) return DASH;
  const s = Math.floor(sec);
  if (s < 60) return `${s}秒`;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}天${pad2(Math.floor((s % 86400) / 3600))}时`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${pad2(s % 60)}秒`;
  return `${Math.floor(m / 60)}时${pad2(m % 60)}分`;
}

/** 左上那两块读数 + 右上时间。**不数溶散中的那一只**（它已经不算种群）。 */
export function readoutFor(world) {
  const cs = (world && world.creatures) || [];
  let alive = 0;
  for (const c of cs) if (c && c.alive !== false && c.stage !== 'dead') alive += 1;
  return {
    population: alive,
    foods: ((world && world.foods) || []).length,
    eggs: ((world && world.eggs) || []).length,
    // 传**原值**而不是 num()：缺 time 的脏 world 要出「—」，而不是骗人说"0秒"。
    timeLabel: formatAge(world && world.time),
  };
}

/** 好感 −1..1 → 心形的填充度 0..1。脏值取"空心"：它没被认识过，不是半心。 */
export function heartFillFor(affection) {
  const a = Number.isFinite(affection) ? affection : -1;
  const k = (a + 1) / 2;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

export function radarFor(traits) {
  const p = (traits && traits.personality) || {};
  return PERSONALITY_AXES.map(([k, axis]) => ({ axis, v: num(p[k]) }));
}

/**
 * 体型档位。**输入是 sizeOf(c)（世界单位，含年龄与蛋加成）而不是 traits.size** ——
 * 用 traits.size 的话幼体会显示"中"，而它在画面上就是比同窝的小。
 * 档位按 [minSize, maxSize] 三等分：中位数 26 落在"中"，这是玩家读到最自然的那个数。
 */
export function sizeTier(px) {
  const lo = CONFIG.minSize;
  const span = CONFIG.maxSize - lo;
  if (!(span > 0)) return '中';
  const k = Math.floor(((num(px) - lo) / span) * 3);
  return k <= 0 ? '小' : k === 1 ? '中' : '大';
}

function byId(world, id) {
  if (!id || !world || !Array.isArray(world.creatures)) return null;
  for (const c of world.creatures) if (c && c.id === id) return c;
  return null;
}
const nameOf = (c) => ((c && c.name) || DASH);
const joinNames = (list) => (list.length ? list.slice(0, H.cardWordsMax).join('、') : DASH);

/**
 * 关系四行。spec §6.3 的家谱树属计划 4，这四行是**同一批数据的另一种画法**，
 * 它满足 §9.2 第 2 条（"你能看出两只之间的关系"）。
 */
export function relationRowsFor(c, world) {
  const lineage = (c && c.lineage) || {};
  const kids = (Array.isArray(lineage.offspring) ? lineage.offspring : [])
    .map((id) => byId(world, id)).filter(Boolean).map(nameOf);
  // **同胞没有内核访问器**：只有 lineage.mother，和 memory 里 role==='sibling' 那半截
  // （registerKinship 只在同窝孵化那一刻写，跨代就没了）。所以这里扫 world ——
  // 表现层**读**内核合法，写才不合法（全局约束第 6 条）。
  const motherId = lineage.mother;
  const sibs = motherId && Array.isArray(world && world.creatures)
    ? world.creatures
      .filter((x) => x && x !== c && x.lineage && x.lineage.mother === motherId
        && x.alive !== false && x.stage !== 'dead')
      .map(nameOf)
    : [];
  const pals = (((c && c.memory) || {}).entries || [])
    .filter((e) => e && e.role === 'companion')
    .map((e) => nameOf(byId(world, e.id)))
    .filter((n) => n !== DASH);
  return [
    { label: '母亲', value: nameOf(byId(world, motherId)) },
    { label: '孩子', value: joinNames(kids) },
    { label: '同胞', value: joinNames(sibs) },
    { label: '同伴', value: joinNames(pals) },
  ];
}

function heardWords(c) {
  const list = Array.isArray(c && c.heard) ? c.heard : [];
  // 排序键用 uses 而不是 heard.js 那个 strengthOf：后者要 nowSec 与半衰期，
  // 一行字里塞进时间衰减的读数会让"刚学的词"和"学了三年的词"在卡上不分彼此，
  // 而这一行的用途是"让玩家看见它记住了哪些词"，不是"预测它下一句说什么"。
  return list.slice()
    .sort((a, b) => num(b && b.uses) - num(a && a.uses) || num(a && a.heardAt) - num(b && b.heardAt))
    .map((e) => (e && typeof e.token === 'string' ? e.token : ''))
    .filter((t) => t.length > 0)
    .slice(0, H.cardWordsMax);
}

function eggRow(c) {
  const tint = c && c.traits && c.traits.eggTint;
  const color = tint && hasOwn(EGG_TINT_LABEL, tint) ? EGG_TINT_LABEL[tint] : DASH;
  const boost = num(c && c.eggBoost);
  const size = boost > 0.08 ? '大蛋' : boost < -0.08 ? '小蛋' : '中蛋';
  return `${color} · ${size}`;
}

/**
 * 信息卡的全部内容。**rows 里没有任何一项随情绪变** —— 那是 §13.2 第 4 条的落点，
 * 由 tests/hud.test.js 用"只差情绪的两只个体 rows 逐字节相同"这条行为判据钉住。
 */
export function cardFor(c, world) {
  const words = heardWords(c);
  const offspringCount = Array.isArray(c && c.lineage && c.lineage.offspring)
    ? c.lineage.offspring.length : 0;
  const stage = c && c.stage;
  return {
    title: (c && c.name) || '未命名',
    rows: [
      { label: '名字', value: (c && c.name) || '未命名' },
      { label: '年龄', value: formatAge(c && c.age) },
      { label: '阶段', value: hasOwn(STAGE_LABEL, stage) ? STAGE_LABEL[stage] : DASH },
      { label: '体型', value: sizeTier(c ? sizeOf(c) : 0) },
      relationRowsFor(c, world)[0],                 // 只要"母亲"那一条；其余三条在关系区
      { label: '孩子', value: `${offspringCount} 只` },
      { label: '蛋', value: eggRow(c) },
      { label: '记住的词', value: words.length ? words.join('、') : DASH },
    ],
    radar: radarFor(c && c.traits),
    heart: heartFillFor(affectionFor((c && c.memory) || { entries: [] }, PLAYER_ID)),
    portrait: avatarSrc(expressionFor(c)),
  };
}

// ================================================================ DOM 那一半（Task 4）
//
// `doc` 是**形参**（与 render.js 的 ctx、audio.js 的 graph、input.js 的监听目标同一条路子），
// 所以本文件仍然不含 document / window 那七个名字，仍然在纯度守卫的覆盖范围内。
//
// 结构上只有一条规则：**挂载时建好全部节点，之后只改文字与属性，不再增删节点**
// （卡上的行列表是唯一例外，它整块重建，且只在内容真的变了时）。理由不是好看：
// 每帧 new 节点会把 DOM 变成 GC 压力源，而"找不到刚才那个输入框"这类 bug
// 只在节点被换掉之后才会出现。

const TOUCH = 'hud-touch';
// 三种食物的中文名（spec §6.2）。**键集必须与 CONFIG.food 同一份** ——
// 少一个的症状不是报错，而是投食条上凭空少一个按钮，所以 tests/hud-dom.test.js 逐键比对。
const FOOD_LABEL = Object.freeze({ algae: '光藻', nectar: '蜜珠', crystal: '冰晶' });

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(doc, tag, cls, parent) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

// SVG 元素**必须**走 createElementNS：`document.createElement('svg')` 造出来的是
// HTMLUnknownElement（namespaceURI 还是 XHTML），里面那个 <polygon> 的
// getBoundingClientRect 是 0×0 —— 雷达图一个像素都不画，而桩里 createElement
// 不分家，所以它一直"成功"（清单 §12 的 F-15）。
// 第二处坑：SVGElement.className 是**只读**的 SVGAnimatedString，所以这里只能
// 挂 `class` 属性（真 DOM 与 classList 是同一份东西）。
function svgEl(doc, tag, cls, parent) {
  const n = doc.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute('class', cls);
  if (parent) parent.appendChild(n);
  return n;
}
function button(doc, parent, text, cls) {
  const b = el(doc, 'button', `${TOUCH} ${cls}`, parent);
  b.setAttribute('type', 'button');            // 漏了它，按钮在 <form> 里会提交页面
  b.textContent = text;
  return b;
}
function textInput(doc, parent, cls, ariaLabel, maxChars) {
  const i = el(doc, 'input', `${TOUCH} ${cls}`, parent);
  i.setAttribute('type', 'text');
  i.setAttribute('enterkeyhint', cls === 'hud-tell' ? 'send' : 'done');
  i.setAttribute('maxlength', String(maxChars));
  i.setAttribute('aria-label', ariaLabel);
  return i;
}

/**
 * 雷达图：九个顶点落在同一个角度表上，按轴序连成闭合折线，坐标在 0..100 的方框里算。
 * 折线上界与轴名半径只有**这一个定义点** —— 各自写一遍的话，改一处就会出现
 * "折线长到把字盖住"（那条判据在 tests/hud-dom.test.js）。
 */
const RADAR_R_MIN = 8;      // v=0 时也不缩成一个点
const RADAR_R_POLY = 38;    // v=1 时的顶点半径
const RADAR_R_LABEL = 46;   // 轴名所在半径
function radarAngle(i, n) { return (i / n) * Math.PI * 2 - Math.PI / 2; }   // 第一个轴朝上

function radarPoints(radar) {
  const n = radar.length || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = radarAngle(i, n);
    const v = RADAR_R_MIN + (RADAR_R_POLY - RADAR_R_MIN) * num(radar[i].v);
    out.push(`${(50 + Math.cos(a) * v).toFixed(1)},${(50 + Math.sin(a) * v).toFixed(1)}`);
  }
  return out.join(' ');
}

/** 轴名的落点与对齐方式。字压在几何半径上，基线居中交给 CSS 的 dominant-baseline。 */
function radarLabelSpot(i, n) {
  const a = radarAngle(i, n);
  const cx = Math.cos(a);
  return {
    x: +(50 + cx * RADAR_R_LABEL).toFixed(1),
    y: +(50 + Math.sin(a) * RADAR_R_LABEL).toFixed(1),
    anchor: cx > 0.3 ? 'start' : cx < -0.3 ? 'end' : 'middle',
  };
}

export function mountHud(doc, deps) {
  const d = deps || {};
  const controller = d.controller;
  const root = el(doc, 'div', 'hud', doc.body);

  // ---- 四块（spec §6.3：左上读数 / 右上控件 / 底部食物条 / 信息卡）----
  const readout = el(doc, 'div', 'hud-readout', root);
  const rPop = el(doc, 'span', 'hud-num', readout);
  el(doc, 'span', 'hud-sep', readout).textContent = ' · ';
  const rFood = el(doc, 'span', 'hud-num', readout);
  el(doc, 'span', 'hud-sep', readout).textContent = ' · ';
  const rEgg = el(doc, 'span', 'hud-num', readout);
  el(doc, 'span', 'hud-sep', readout).textContent = ' · ';
  const rTime = el(doc, 'span', 'hud-time', readout);

  const controls = el(doc, 'div', 'hud-controls', root);
  const foodbar = el(doc, 'div', 'hud-foodbar', root);
  const card = el(doc, 'div', 'hud-card', root);

  // ---- 右上：倍速 / 暂停 / 静音 / 设置 ----
  // 音频被浏览器**明确拒绝**时才不挂静音键（spec §5.4.1 第 8 条）：一个按了永远没反应的
  // 按钮不是"降级"，是骗人。
  // ⚠️ 必须同时判 tried：开缸那一刻 audioState 还是 `{tried:false, ok:false}`（AudioContext
  // 要等第一次真实手势才创建），那时 ok 也是 false —— 只看 ok 会让静音键**永远不出现**，
  // 直到玩家按下第一下才补上，而那正是按钮该在的地方。
  // 这是个**谓词**不是常量：真页面的顺序是"先挂载、后第一次手势"，被拒这件事发生在挂载之后，
  // 只在挂载时判一眼会让骗人按钮永远留在右上角。
  const audioBlocked = () => !!(d.audioState && d.audioState.tried && d.audioState.ok === false);
  for (const s of CONFIG.timeScales) {
    const b = button(doc, controls, `${s}×`, 'hud-scale');
    b.addEventListener('click', () => api.pressScale(s));
  }
  const pauseBtn = button(doc, controls, '暂停', 'hud-pause');
  pauseBtn.addEventListener('click', () => api.pressPause());
  let muteBtn = null;
  if (!audioBlocked()) {
    muteBtn = button(doc, controls, '静音', 'hud-mute');
    muteBtn.addEventListener('click', () => api.pressMute());
  }
  const familyBtn = button(doc, controls, '家谱', 'hud-family-btn');
  familyBtn.addEventListener('click', () => api.setFamilyOpen(!state.familyOpen,
    state.card ? state.card.id : undefined));
  const gearBtn = button(doc, controls, '设置', 'hud-gear');
  gearBtn.addEventListener('click', () => api.setSettingsOpen(!state.settingsOpen));

  // ---- 底部食物条：键与 kind 逐字取自 CONFIG.food ----
  for (const kind of Object.keys(CONFIG.food)) {
    const b = button(doc, foodbar, FOOD_LABEL[kind] || kind, 'hud-feed');
    b.dataset.kind = kind;
    b.addEventListener('click', () => api.pressFeed(kind));
    // 拖拽投食（spec §6.1 表第一行）。按下与点按**共存**：原地按下抬起之后真浏览器还会
    // 补一个 click，那一发照旧走 pressFeed 落中央；拖进缸里松手才是精确放置。
    b.addEventListener('pointerdown', (ev) => api.beginCarry(kind, ev));
  }
  // 托着的那一颗。用 DOM 不用 canvas：它是 HUD 的东西，而且不该占渲染帧。
  const carryEl = el(doc, 'div', 'hud-carry', root);

  // ---- 信息卡：结构一次建好 ----
  const cardTitle = el(doc, 'h2', 'hud-card-title', card);
  const portrait = el(doc, 'img', 'hud-portrait', card);
  portrait.setAttribute('alt', '它的样子');
  const rowsBox = el(doc, 'div', 'hud-rows', card);
  const svg = svgEl(doc, 'svg', 'hud-radar', card);
  // 方框比几何(0..100)左右各宽 25 / 上下各宽 12 —— 轴名要落在 r=46 的圈上，
  // 右侧那两个横着往外长 16 个单位，而 .hud-card 是 overflow-y:auto（那会把 visible
  // 的 overflow-x 算成 auto ⇒ 一根横向滚动条），所以只能靠 viewBox 让位置，不能靠溢出。
  svg.setAttribute('viewBox', '-25 -12 150 124');
  const poly = svgEl(doc, 'polygon', 'hud-radar-shape', svg);
  // 轴名。`radarFor` 一直带着九个中文名，是 DOM 层只取了 `v` 把它们丢了 ⇒
  // 玩家看到的是一坨读不出"哪一维高"的折线（清单 §6.5 的 O-4）。
  // 名字是**类别名不是数值**，所以这既不碰 §6.3 那句"好感度不写数字"，
  // 也不碰 §13.2 第 4 条"不许替它陈述心情"（九轴是性格基因，与 moodOf 那五档无关）。
  PERSONALITY_AXES.forEach(([, axis], i) => {
    const spot = radarLabelSpot(i, PERSONALITY_AXES.length);
    const label = svgEl(doc, 'text', null, svg);
    label.setAttribute('x', spot.x);
    label.setAttribute('y', spot.y);
    label.setAttribute('text-anchor', spot.anchor);
    label.textContent = axis;
  });
  const heart = el(doc, 'div', 'hud-heart', card);
  heart.setAttribute('role', 'img');
  const relBox = el(doc, 'div', 'hud-relations', card);
  const nameInput = textInput(doc, card, 'hud-name', '给它取名', H.nameMaxChars);
  const nameBtn = button(doc, card, '改名', 'hud-name-go');
  const tellInput = textInput(doc, card, 'hud-tell', '讲给它听', H.tellMaxChars);
  const tellBtn = button(doc, card, '说', 'hud-tell-go');

  // ---- 家谱（spec §6.3）----
  // 与信息卡分开的一层：桌面是右侧栏、手机是全屏（CSS 断点负责）。
  // 它只读最近一帧的 world；节点/边/坐标全部由 family.js 的纯函数给出。
  const family = el(doc, 'div', 'hud-family', root);
  family.setAttribute('role', 'dialog');
  family.setAttribute('aria-modal', 'true');
  family.setAttribute('aria-label', '家谱');
  const familyHead = el(doc, 'div', 'hud-family-head', family);
  el(doc, 'h2', 'hud-family-title', familyHead).textContent = '家谱';
  const familyClose = button(doc, familyHead, '关闭', 'hud-family-close');
  const familyLegend = el(doc, 'div', 'hud-family-legend', family);
  familyLegend.textContent = '同母相邻 = 同胞 · 实线 = 母亲 → 孩子 · 虚线 = 伙伴 · 空心点 = 起点无母亲记录 · 只画当前活着的个体';
  const familyScroll = el(doc, 'div', 'hud-family-scroll', family);
  const familyEmpty = el(doc, 'p', 'hud-family-empty', familyScroll);
  familyEmpty.textContent = '缸里还没有个体';
  const familySvg = svgEl(doc, 'svg', 'hud-family-tree', familyScroll);

  const state = {
    card: null, settingsOpen: false, familyOpen: false,
    familyFocusId: null, familyNodes: 0, familyOpens: 0, _lastFamilyAt: -Infinity,
    lastInputAt: 0, now: 0, _lastCardAt: -Infinity,
    frames: 0, cardRenders: 0, cardOpens: 0, saveLineWrites: 0,
    feeds: 0, tells: 0, tellTruncated: 0, tellDropped: 0, renames: 0, rejectedNames: 0,
    endpointRejected: 0, settingsOpens: 0, settingsSaved: 0, clearArmed: false, _armedAt: 0,
    // 拖拽投食那三笔账：成了几次、撤回几次、当前托着哪一颗（null = 没托）。
    carry: { kind: null, x: 0, y: 0, inside: false }, carries: 0, carryCancelled: 0,
  };
  let lastRows = '';
  let lastRel = '';
  let latestWorld = controller.world || null;

  function pulse(nowMs) {
    state.lastInputAt = Number.isFinite(nowMs) ? nowMs : state.now;
    root.classList.remove('is-dim');
  }

  // 整张卡的可见性是**两个来源的或**：选中了某只生物，或者设置页开着。
  // 以前只有 setCard 写 is-open，于是"没点过任何生物就按设置"会拿到一个
  // state.settingsOpen=true、六个输入框都在 DOM 里、而 display:none 的面板
  // —— 桩里没有 CSS，这条 1093 个判据一条都看不见（清单 §12 的 F-12）。
  function syncCard() {
    // 家谱是覆盖层：它开着时把卡暂时收起，两层叠着会让读的人以为那是同一张面板。
    // 关掉家谱后卡原样回来（state.card 没动）。
    card.classList.toggle('is-open', !state.familyOpen && (!!state.card || state.settingsOpen));
    // 只有设置、没有生物时，卡里那些生物专属的行（肖像 / 雷达 / 心形 / 改名框）
    // 没有一份内容属于当前这"一张"，CSS 按这个类把它们整段藏掉。
    card.classList.toggle('is-settings', !state.card && state.settingsOpen);
  }

  // 清空一个节点的子节点。**不能**写成 `node.children.length = 0`：真 DOM 的
  // `children` 是只读的活 HTMLCollection，那句话在严格模式（ES 模块默认）里当场抛
  // TypeError，而桩里它是个普通数组 ⇒ 1093 条判据全绿、真页面一点就炸（清单 §12 的 F-13）。
  function clear(node) {
    for (const old of [...node.children]) node.removeChild(old);
  }

  // ---- 家谱 ----
  // 画的是"当前活着的个体"的母系森林。死人已经被内核移出 world，所以这里不装出
  // 一条能追到更早祖先的线；没有母亲的节点就是悬空起点。
  let familyKeyOn = false;
  function onFamilyKey(ev) {
    if (ev && ev.key === 'Escape') {
      if (ev.preventDefault) ev.preventDefault();
      api.setFamilyOpen(false);
    }
  }
  function detachFamilyKey() {
    if (!familyKeyOn) return;
    doc.removeEventListener('keydown', onFamilyKey);
    familyKeyOn = false;
  }
  function attachFamilyKey() {
    if (familyKeyOn) return;
    doc.addEventListener('keydown', onFamilyKey);
    familyKeyOn = true;
  }

  function renderFamily(world) {
    const model = familyModelFor(world, state.familyFocusId);
    state.familyFocusId = model.focusId;
    state.familyNodes = model.nodes.length;
    clear(familySvg);
    familyEmpty.classList.toggle('is-hidden', model.nodes.length > 0);
    familySvg.classList.toggle('is-hidden', model.nodes.length === 0);
    if (model.nodes.length === 0) {
      familySvg.removeAttribute('viewBox');
      state._lastFamilyAt = state.now;
      return;
    }
    const layout = layoutFamily(model);
    familySvg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    familySvg.setAttribute('width', String(layout.width));
    familySvg.setAttribute('height', String(layout.height));
    // 边先画，节点后画：线不许压在名字上。
    for (const e of layout.edges) {
      const path = svgEl(doc, 'path',
        `hud-family-edge ${e.kind === 'mother' ? 'is-mother' : 'is-companion'}`, familySvg);
      path.setAttribute('d', e.d);
      if (e.dashed) path.setAttribute('stroke-dasharray', '4 4');
    }
    for (const n of layout.nodes) {
      const cls = ['hud-family-node'];
      if (n.isFocus) cls.push('is-focus');
      if (n.isRoot) cls.push('is-root');
      const g = svgEl(doc, 'g', cls.join(' '), familySvg);
      g.dataset.id = n.id;
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', n.name);
      // 44px 的可点区：圆点本身只有 10px，直接拿它当触控目标是骗人的。
      const hit = svgEl(doc, 'rect', 'hud-fam-hit', g);
      hit.setAttribute('x', String(n.x - 10));
      hit.setAttribute('y', String(n.y - 22));
      hit.setAttribute('width', String(Math.min(layout.width - n.x, 150)));
      hit.setAttribute('height', '44');
      hit.setAttribute('rx', '10');
      const dot = svgEl(doc, 'circle', 'hud-family-dot', g);
      dot.setAttribute('cx', String(n.x));
      dot.setAttribute('cy', String(n.y));
      dot.setAttribute('r', String(n.r));
      dot.setAttribute('fill', `hsl(${n.hue} 70% 72%)`);
      const label = svgEl(doc, 'text', 'hud-family-label', g);
      label.setAttribute('x', String(n.x + 12));
      label.setAttribute('y', String(n.y));
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = n.label;
      const choose = () => api.setFamilyFocus(n.id);
      g.addEventListener('click', choose);
      g.addEventListener('keydown', (ev) => {
        if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
          if (ev.preventDefault) ev.preventDefault();
          choose();
        }
      });
    }
    familyScroll.scrollTop = Math.max(0, layout.focusY - 120);
    state._lastFamilyAt = state.now;
  }

  // ---- 拖拽投食（spec §6.1 表第一行）----
  // 三条边界写死在这里：
  // ① hud 只上报**像素**，"在不在缸内"问调用方（注入的 carryInside 谓词）—— HUD 不许知道
  //    canvas 语义，那条由 tests/hud-dom.test.js 的源码判据钉住；
  // ② 按下不等于投出去：只有拖到缸里松手才调 onCarryDrop，撤回也计数读得到
  //    （与 main.js 的 grabState.suppressed 同一条纪律）；
  // ③ 临时监听器挂几套摘几套。挂在 doc 上而不是按钮上 —— 手指一移出按钮，
  //    绑在按钮上的 pointerup 就永远等不到，那颗食物会悬在玩家指尖上。
  // 刻意**不跟 pointerId**：多指属 spec §10 范围外，跟了就是第二套输入模型。
  const px = (v, keep) => (Number.isFinite(v) ? v : keep);

  function carryPaint() {
    carryEl.classList.toggle('is-carrying', !!state.carry.kind);
    carryEl.classList.toggle('is-outside', !!state.carry.kind && !state.carry.inside);
    carryEl.style.setProperty('left', `${state.carry.x}px`);
    carryEl.style.setProperty('top', `${state.carry.y}px`);
    carryEl.textContent = state.carry.kind ? (FOOD_LABEL[state.carry.kind] || state.carry.kind) : '';
  }

  function attachCarry(on) {
    // 刻意把六个调用写全，不写成 `const f = on ? doc.addEventListener : doc.removeEventListener`
    // 再 `f(...)`：那样方法脱离了 doc，真 DOM 当场抛 "Illegal invocation"（桩里 this 没用上，
    // 所以它照收 —— 这一族的第三次，见清单 §12.11）。
    if (on) {
      doc.addEventListener('pointermove', carryMove);
      doc.addEventListener('pointerup', carryUp);
      doc.addEventListener('pointercancel', carryCancel);
    } else {
      doc.removeEventListener('pointermove', carryMove);
      doc.removeEventListener('pointerup', carryUp);
      doc.removeEventListener('pointercancel', carryCancel);
    }
  }

  function carryMove(ev) {
    if (!state.carry.kind) return;
    state.carry.x = px(ev && ev.clientX, state.carry.x);
    state.carry.y = px(ev && ev.clientY, state.carry.y);
    state.carry.inside = !!(d.carryInside && d.carryInside(state.carry.x, state.carry.y));
    carryPaint();
  }

  function carryEnd(ev, cancelled) {
    const kind = state.carry.kind;
    attachCarry(false);
    state.carry.kind = null;
    if (kind) {
      if (cancelled) state.carryCancelled += 1;
      else {
        state.carry.x = px(ev && ev.clientX, state.carry.x);
        state.carry.y = px(ev && ev.clientY, state.carry.y);
        // 松手点要**重新问一次**，不能信最后一次 move：手指可以在两次采样之间滑出缸外。
        state.carry.inside = !!(d.carryInside && d.carryInside(state.carry.x, state.carry.y));
        if (state.carry.inside) {
          state.carries += 1;
          if (d.onCarryDrop) d.onCarryDrop(kind, state.carry.x, state.carry.y);
        } else state.carryCancelled += 1;
      }
    }
    carryPaint();
    pulse();
  }

  const carryUp = (ev) => carryEnd(ev, false);
  const carryCancel = () => carryEnd(null, true);

  function renderCard(c, world) {
    const built = cardFor(c, world);
    cardTitle.textContent = built.title;
    portrait.setAttribute('src', built.portrait);
    // 自定义属性只有 setProperty 进得了层叠：`style['--x'] = v` 在真浏览器里静默无效
    // （cssText 是空的，getComputedStyle 读到 CSS 里那句 `--heart-fill: 0`），
    // 于是心形永远空着而没有任何一处报错 —— 桩里 style 是个普通对象，所以它"成功"了（F-14）。
    heart.style.setProperty('--heart-fill', String(built.heart));
    heart.setAttribute('aria-label', '它对玩家的好感');
    poly.setAttribute('points', radarPoints(built.radar));
    const rowsKey = JSON.stringify(built.rows);
    if (rowsKey !== lastRows) {
      lastRows = rowsKey;
      clear(rowsBox);
      for (const r of built.rows) {
        const line = el(doc, 'div', 'hud-row', rowsBox);
        el(doc, 'span', 'hud-row-label', line).textContent = r.label;
        el(doc, 'span', 'hud-row-value', line).textContent = r.value;
      }
    }
    const rel = relationRowsFor(c, world);
    const relKey = JSON.stringify(rel);
    if (relKey !== lastRel) {
      lastRel = relKey;
      clear(relBox);
      for (const r of rel) {
        const line = el(doc, 'div', 'hud-rel', relBox);
        el(doc, 'span', 'hud-rel-label', line).textContent = r.label;
        el(doc, 'span', 'hud-rel-value', line).textContent = r.value;
      }
    }
    state.cardRenders += 1;
  }

  // ---- 设置页（Task 6）----
  // 草稿只活在这里，**从不写进任何节点的 value**（key 那一栏尤其：填进去、保存、清空，
  // 之后页面上只剩"已保存"三个字）。这也是为什么整个面板是**开时建、关时拆**：
  // 少一处"key 可能被读到的地方"，就少一处将来有人加个 console.log 就破掉的地方。
  const draft = { endpoint: '', model: '', key: '', keyEntered: false, speech: true };
  // "存过 key 没有"只有一个真相源：controller.getApiConfig().hasKey（它背后就是那份本机存储）。
  // 曾经这里另存了一份 draft.keySaved，结果"重开设置页"时它被 getApiConfig 覆盖，
  // 于是明明存过却显示"未填" —— 两份真相必有一天互相打脸，这次是它先露出来。
  const hasSavedKey = () => !!(controller.getApiConfig && controller.getApiConfig().hasKey);
  let panel = null;
  const SAVE_SOURCE_LABEL = Object.freeze({
    fresh: '本机新档', restored: '读回本机档', 'corrupt-moved': '旧档读不懂，已留证据',
    unreadable: '存储不可用（只玩不存）',
  });

  function buildPanel() {
    const box = el(doc, 'div', 'hud-settings', card);
    const cfg = controller.getApiConfig ? controller.getApiConfig() : {};
    draft.endpoint = String(cfg.endpoint || '');
    draft.model = String(cfg.model || '');
    draft.key = '';
    // draft.speech 不在这儿猜：它由 frame(world) 从 world.speechEnabled 同步过来。
    // 设置页自己存一份"文字层开没开"就是第二份真相，而它会与读档后的世界不一致。
    const rowOf = (cls, label) => {
      const row = el(doc, 'div', `hud-set ${cls}`, box);
      el(doc, 'span', 'hud-set-label', row).textContent = label;
      return row;
    };
    const epRow = rowOf('hud-set-endpoint', '端点');
    const epBox = textInput(doc, epRow, 'hud-set-endpoint-input', 'OpenAI 兼容端点', 200);
    epBox.value = draft.endpoint;
    const mdRow = rowOf('hud-set-model', '模型');
    const mdBox = textInput(doc, mdRow, 'hud-set-model-input', '模型名', 80);
    mdBox.value = draft.model;
    const keyRow = rowOf('hud-set-key', '密钥');
    // 状态字与输入框是两个节点：往 <input> 上写 textContent 在真浏览器里什么都不发生，
    // 于是"已保存"这三个字会静默消失 —— 桩里却会"成功"，这种差异必须靠结构避开。
    el(doc, 'span', 'hud-set-value', keyRow).textContent = '未填';
    const keyBox = el(doc, 'input', `${TOUCH} hud-set-key`, keyRow);
    keyBox.setAttribute('type', 'password');          // 只写：值从不回填
    keyBox.setAttribute('aria-label', 'API 密钥（只存本机）');
    keyBox.value = '';
    const saveRow = rowOf('hud-set-save', '存档');
    el(doc, 'span', 'hud-set-value', saveRow).textContent = '未知来源';
    const dangerRow = rowOf('hud-set-danger', '危险动作');
    const speechRow = rowOf('hud-set-speech', '文字层');
    const speechBtn = button(doc, speechRow, '关闭文字层', 'hud-speech-toggle');
    speechBtn.addEventListener('click', () => api.setSpeech(!draft.speech));
    const saveNowBtn = button(doc, dangerRow, '立即落盘', 'hud-save-now');
    saveNowBtn.addEventListener('click', () => api.pressSaveNow());
    const clearBtn = button(doc, dangerRow, '清空存档', 'hud-clear-save');
    clearBtn.addEventListener('click', () => api.pressClear());
    const applyBtn = button(doc, box, '保存设置', 'hud-apply');
    applyBtn.addEventListener('click', () => api.saveSettings());
    panel = { box, epBox, mdBox, keyBox, keyRow, epRow, saveRow, clearBtn, speechBtn };
    paintPanel();
  }

  function paintPanel() {
    if (!panel) return;
    paintSaveLine();
    // 标签只写"已保存 / 未填"这两个**词**，绝不把 key 的内容放进任何节点。
    panel.keyRow.children[1].textContent = (draft.keyEntered || hasSavedKey()) ? '已保存（只存本机）' : '未填';
    panel.epRow.classList.toggle('is-bad', !!state.endpointRejected);
    panel.speechBtn.textContent = draft.speech ? '关闭文字层' : '打开文字层';
    panel.clearBtn.textContent = state.clearArmed ? '再按一次确认清空' : '清空存档';
    panel.clearBtn.classList.toggle('is-armed', !!state.clearArmed);
  }

  // 落盘那一行**骑帧**（F-10）：面板开着的时候 `save.frame()` 每 30 模拟秒还会真的再落一次盘，
  // 而 paintPanel 只在开面板与控件交互时调 —— 于是那一行停在开面板那一刻。
  // 缓存挂在 `panel` 自己身上而不是 state 上：`buildPanel()` 每次换一具新 span，
  // 跨面板复用一个旧串的症状是新面板永远显示"未知来源"。
  function paintSaveLine() {
    if (!panel) return;
    const st = controller.saveState || {};
    const label = Object.hasOwn(SAVE_SOURCE_LABEL, st.source) ? SAVE_SOURCE_LABEL[st.source] : '未知来源';
    const line = `${label} · ${st.bytes || 0}B · 已写 ${st.writes || 0} 次`;
    if (panel._saveLine === line) return;          // 值变了才写（与左上那四条读数同一套纪律）
    panel._saveLine = line;
    state.saveLineWrites += 1;
    panel.saveRow.children[1].textContent = line;
  }

  const api = {
    root, state,
    // README 那句"load images once, do not instantiate Image during frame rendering"的落点：
    // 本模块只交出 URL，真正 new Image 的那一步在 main.js（它才许碰浏览器全局）。
    preload: preloadList(),
    pressScale(s) {
      if (!CONFIG.timeScales.includes(s)) {
        throw new Error(`pressScale: ${s} 不在 CONFIG.timeScales [${CONFIG.timeScales.join(', ')}] 里`);
      }
      controller.setTimeScale(s);              // 缺这个方法时**就让它抛**：那是接线没接上，不是用户输入
      pulse();
    },
    pressPause() {
      const next = !controller.getPaused();
      controller.setPaused(next);
      pauseBtn.textContent = next ? '继续' : '暂停';
      pulse();
    },
    pressMute() {
      // 读返回值而不是自己记账：main.js 那边"没有音频时返回当前事实而不是抛"的契约
      // 存在的唯一理由就是这里（那句注释写了很久，消费者一直缺席）。
      const muted = controller.setMuted(!controller.getMuted());
      if (muteBtn) muteBtn.textContent = muted ? '已静音' : '静音';
      pulse();
    },
    pressFeed(kind) {
      if (!Object.hasOwn(CONFIG.food, kind)) throw new Error(`pressFeed: 没有这种食物 "${kind}"`);
      state.feeds += 1;
      if (d.onFeed) d.onFeed(kind);
      pulse();
    },
    beginCarry(kind, ev) {
      if (!Object.hasOwn(CONFIG.food, kind)) throw new Error(`beginCarry: 没有这种食物 "${kind}"`);
      if (state.carry.kind) return;        // 第二根手指不算第二次携带（多指属 §10 范围外）
      state.carry.kind = kind;
      attachCarry(true);
      carryMove(ev);                       // 按下处就在食物条上 ⇒ inside 当场算成 false
      carryPaint();
    },
    tell(text) {
      // `text == null` 而不是 `=== undefined`：传 null 时 String(null) 会得到字面量
      // "null" 那句话，症状是玩家什么都没讲，它记住了一个词："null"。
      const raw = text == null ? tellInput.value : String(text);
      tellInput.value = '';                    // 先清：不管后面发不发，输入框都不许留残句
      if (!raw) return;
      if (!state.card) { state.tellDropped += 1; return; }
      const cut = raw.length > H.tellMaxChars;
      if (cut) state.tellTruncated += 1;
      state.tells += 1;
      if (d.onTell) d.onTell(state.card, cut ? raw.slice(0, H.tellMaxChars) : raw);
      pulse();
    },
    tellValue() { return tellInput.value; },
    rename(creature, name) {
      const v = String(name == null ? '' : name).trim().slice(0, H.nameMaxChars);
      state.renames += 1;
      if (!v) {
        state.rejectedNames += 1;
        if (d.onRename) d.onRename(creature, null);
        pulse();
        return;
      }
      if (d.onRename) d.onRename(creature, v);
      pulse();
    },
    setCard(creature, world, opts) {
      state.card = creature || null;
      if (creature) { state.cardOpens += 1; renderCard(creature, world); }
      syncCard();
      if (creature && opts && opts.focusName) {
        nameInput.value = String(creature.name || '');
        nameInput.focus();                     // 长按那一路一步到位，省掉"先点开卡再点名字"
      }
      pulse();
    },
    setSettingsOpen(open) {
      const want = !!open;
      if (want === state.settingsOpen) return;
      state.settingsOpen = want;
      if (want) { state.settingsOpens += 1; buildPanel(); }
      else if (panel) { panel.box.remove(); panel = null; }   // 关了就**拆掉**：key 框少活一会儿
      syncCard();
      pulse();
    },
    setFamilyOpen(open, focusId) {
      const want = !!open;
      if (want === state.familyOpen) {
        if (want && focusId !== undefined) {
          state.familyFocusId = focusId;
          renderFamily(latestWorld);
        }
        return;
      }
      state.familyOpen = want;
      if (want) {
        state.familyOpens += 1;
        if (focusId !== undefined) state.familyFocusId = focusId;
        else if (state.card) state.familyFocusId = state.card.id;
        family.classList.add('is-open');
        attachFamilyKey();
        renderFamily(latestWorld);
        familyClose.focus();
      } else {
        family.classList.remove('is-open');
        detachFamilyKey();
        familyBtn.focus();
      }
      syncCard();
      pulse();
    },
    setFamilyFocus(id) {
      if (!id) return;
      state.familyFocusId = id;
      if (state.familyOpen) renderFamily(latestWorld);
      pulse();
    },
    setEndpoint(v) { draft.endpoint = String(v == null ? '' : v); state.endpointRejected = 0; paintPanel(); },
    setModel(v) { draft.model = String(v == null ? '' : v); paintPanel(); },
    // 只写：值进 draft 之后**从不回填**到任何节点，保存完立刻清空输入框。
    setKey(v) {
      draft.key = String(v == null ? '' : v);
      draft.keyEntered = draft.key.length > 0;
      if (panel) panel.keyBox.value = '';
      paintPanel();
    },
    setSpeech(on) {
      draft.speech = !!on;
      state.speechToggles = (state.speechToggles || 0) + 1;
      if (d.onSpeech) d.onSpeech(draft.speech);
      paintPanel();
      pulse();
    },
    saveSettings() {
      const bad = endpointIssue(draft.endpoint);
      // 只有 **insecure** 才拦。空端点不拦：玩家完全可能先填 key、下次再填端点，
      // 拦下来等于不让人分两次填表；而档位那边 configIssue 会照旧拒发请求，
      // 所以"存了但没开"是安全状态，不需要在 UI 上再禁一次。
      // 明文 http 不一样：那份配置一旦落下，每次开缸都会把 key 往局域网上广播一次。
      if (bad === 'insecure') {
        state.endpointRejected += 1;
        paintPanel();
        pulse();
        return false;
      }
      const ep = draft.endpoint.trim();
      const md = draft.model.trim();
      const patch = {
        // 三样齐了才真的打开档位。只填了 key 就 enabled:true，症状是"我什么都没开，
        // 它却开始往外发请求"（或者反过来：每次出词都白付一次被拒的往返）。
        enabled: !!(ep && md && (draft.keyEntered || hasSavedKey())),
        endpoint: ep, model: md,
      };
      // 没填 key 就**不交这个键**：交空串会把已存的 key 覆盖掉（main.js 那边照单全收）。
      if (draft.key) patch.key = draft.key;
      draft.key = '';
      draft.keyEntered = false;
      if (panel) panel.keyBox.value = '';
      state.settingsSaved += 1;
      if (controller.setApiConfig) controller.setApiConfig(patch);
      paintPanel();
      pulse();
      return true;
    },
    pressSaveNow() {
      state.saveNowPressed = (state.saveNowPressed || 0) + 1;
      if (controller.saveNow) controller.saveNow();
      paintPanel();
      pulse();
    },
    // 清空存档是**不可逆**的（一缸的世代没了），所以要按两次，而且确认态会自己过期。
    pressClear() {
      if (!state.clearArmed) {
        state.clearArmed = true;
        state._armedAt = state.now;
        state.clearArms = (state.clearArms || 0) + 1;
        paintPanel();
        pulse();
        return;
      }
      state.clearArmed = false;
      state.clears = (state.clears || 0) + 1;
      if (controller.clearSave) controller.clearSave();
      paintPanel();
      pulse();
    },
    frame(nowMs, world) {
      state.frames += 1;
      state.now = nowMs;
      if (world) latestWorld = world;
      // 第一次真实手势可能就在这一帧之前把 AudioContext 拒了 —— 那时才轮到此键退休。
      if (muteBtn && audioBlocked()) { muteBtn.remove(); muteBtn = null; }
      if (world && typeof world.speechEnabled === 'boolean') draft.speech = world.speechEnabled;
      // 确认态自己收回：armed 的按钮一直亮着，等于下一次随手一按就把一缸清了。
      if (state.clearArmed && nowMs - state._armedAt >= H.confirmArmedMs) {
        state.clearArmed = false;
        paintPanel();
      }
      const r = readoutFor(world);
      // 只在值变了的时候写：textContent 赋值在真浏览器里会换掉文本节点，
      // 每帧无条件写三次等于把 DOM 当变量用。
      if (rPop.textContent !== String(r.population)) rPop.textContent = String(r.population);
      if (rFood.textContent !== String(r.foods)) rFood.textContent = String(r.foods);
      if (rEgg.textContent !== String(r.eggs)) rEgg.textContent = String(r.eggs);
      if (rTime.textContent !== r.timeLabel) rTime.textContent = r.timeLabel;
      // 落盘那一行同样骑帧（F-10）。面板没开时 `paintSaveLine` 第一行就 return，
      // 所以"不开设置页 ⇒ 零额外 DOM 写"这条与上面那四条读数的"值变了才写"是同一套。
      paintSaveLine();
      if (state.card && nowMs - state._lastCardAt >= H.cardRefreshMs) {
        state._lastCardAt = nowMs;
        renderCard(state.card, world);
      }
      if (state.familyOpen && nowMs - state._lastFamilyAt >= H.cardRefreshMs) {
        renderFamily(latestWorld);
      }
      // 淡出淡的是" chrome "，不是玩家正在读的那张表：卡或设置页开着的时候不许淡。
      // 真页面实测（F-16）—— 卡片开着、98 秒没动手，`.hud` 挂上 is-dim ⇒ 整块 opacity .25，
      // 而它照样吃点击（elementFromPoint 命中的是卡里的肖像）：一屏"看不清但点得动"的表单。
      // spec §6.3 那句"不遮挡水体"仍然成立 —— 面板本来就挡着水，淡不淡都一样。
      const panelOpen = !!state.card || state.settingsOpen || state.familyOpen;
      root.classList.toggle('is-dim', !panelOpen && nowMs - state.lastInputAt >= H.fadeIdleMs);
    },
    pulse,
    // 换缸/停缸时正托着也要就地收手：那三个监听器挂在 doc 上，不在这棵子树里，
    // root.remove() 带不走它们 —— 漏一次就是"下一次开缸，随便哪儿一滑都投食"。
    destroy() {
      attachCarry(false);
      detachFamilyKey();
      root.remove();
    },
  };

  // 这几个按钮要调 api，所以必须绑在 api 之后 —— 顺序是有意的，别顺手挪到上面去。
  nameBtn.addEventListener('click', () => api.rename(state.card, nameInput.value));
  tellBtn.addEventListener('click', () => api.tell());
  familyClose.addEventListener('click', () => api.setFamilyOpen(false));
  return api;
}
