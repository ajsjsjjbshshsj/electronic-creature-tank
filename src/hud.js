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

function el(doc, tag, cls, parent) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
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

/** 雷达图：九个顶点落在单位圆上，按轴序连成闭合折线。坐标在 0..100 的方框里算。 */
function radarPoints(radar) {
  const n = radar.length || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;      // 第一个轴朝上
    const v = 8 + 42 * num(radar[i].v);
    out.push(`${(50 + Math.cos(a) * v).toFixed(1)},${(50 + Math.sin(a) * v).toFixed(1)}`);
  }
  return out.join(' ');
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
  const audioBlocked = !!(d.audioState && d.audioState.tried && d.audioState.ok === false);
  for (const s of CONFIG.timeScales) {
    const b = button(doc, controls, `${s}×`, 'hud-scale');
    b.addEventListener('click', () => api.pressScale(s));
  }
  const pauseBtn = button(doc, controls, '暂停', 'hud-pause');
  pauseBtn.addEventListener('click', () => api.pressPause());
  if (!audioBlocked) {
    const muteBtn = button(doc, controls, '静音', 'hud-mute');
    muteBtn.addEventListener('click', () => api.pressMute());
  }
  const gearBtn = button(doc, controls, '设置', 'hud-gear');
  gearBtn.addEventListener('click', () => api.setSettingsOpen(!state.settingsOpen));

  // ---- 底部食物条：键与 kind 逐字取自 CONFIG.food ----
  for (const kind of Object.keys(CONFIG.food)) {
    const b = button(doc, foodbar, FOOD_LABEL[kind] || kind, 'hud-feed');
    b.dataset.kind = kind;
    b.addEventListener('click', () => api.pressFeed(kind));
  }

  // ---- 信息卡：结构一次建好 ----
  const cardTitle = el(doc, 'h2', 'hud-card-title', card);
  const portrait = el(doc, 'img', 'hud-portrait', card);
  portrait.setAttribute('alt', '它的样子');
  const rowsBox = el(doc, 'div', 'hud-rows', card);
  const svg = el(doc, 'svg', 'hud-radar', card);
  svg.setAttribute('viewBox', '0 0 100 100');
  const poly = el(doc, 'polygon', 'hud-radar-shape', svg);
  const heart = el(doc, 'div', 'hud-heart', card);
  heart.setAttribute('role', 'img');
  const relBox = el(doc, 'div', 'hud-relations', card);
  const nameInput = textInput(doc, card, 'hud-name', '给它取名', H.nameMaxChars);
  const nameBtn = button(doc, card, '改名', 'hud-name-go');
  const tellInput = textInput(doc, card, 'hud-tell', '讲给它听', H.tellMaxChars);
  const tellBtn = button(doc, card, '说', 'hud-tell-go');

  const state = {
    card: null, settingsOpen: false, lastInputAt: 0, now: 0, _lastCardAt: -Infinity,
    frames: 0, cardRenders: 0, cardOpens: 0,
    feeds: 0, tells: 0, tellTruncated: 0, tellDropped: 0, renames: 0, rejectedNames: 0,
    endpointRejected: 0, settingsOpens: 0, settingsSaved: 0, clearArmed: false, _armedAt: 0,
  };
  let lastRows = '';
  let lastRel = '';

  function pulse(nowMs) {
    state.lastInputAt = Number.isFinite(nowMs) ? nowMs : state.now;
    root.classList.remove('is-dim');
  }

  function renderCard(c, world) {
    const built = cardFor(c, world);
    cardTitle.textContent = built.title;
    portrait.setAttribute('src', built.portrait);
    heart.style['--heart-fill'] = String(built.heart);
    heart.setAttribute('aria-label', '它对玩家的好感');
    poly.setAttribute('points', radarPoints(built.radar));
    const rowsKey = JSON.stringify(built.rows);
    if (rowsKey !== lastRows) {
      lastRows = rowsKey;
      rowsBox.children.length = 0;
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
      relBox.children.length = 0;
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
    const st = controller.saveState || {};
    const label = Object.hasOwn(SAVE_SOURCE_LABEL, st.source) ? SAVE_SOURCE_LABEL[st.source] : '未知来源';
    panel.saveRow.children[1].textContent =
      `${label} · ${st.bytes || 0}B · 已写 ${st.writes || 0} 次`;
    // 标签只写"已保存 / 未填"这两个**词**，绝不把 key 的内容放进任何节点。
    panel.keyRow.children[1].textContent = (draft.keyEntered || hasSavedKey()) ? '已保存（只存本机）' : '未填';
    panel.epRow.classList.toggle('is-bad', !!state.endpointRejected);
    panel.speechBtn.textContent = draft.speech ? '关闭文字层' : '打开文字层';
    panel.clearBtn.textContent = state.clearArmed ? '再按一次确认清空' : '清空存档';
    panel.clearBtn.classList.toggle('is-armed', !!state.clearArmed);
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
      controller.setMuted(!controller.getMuted());
      pulse();
    },
    pressFeed(kind) {
      if (!Object.hasOwn(CONFIG.food, kind)) throw new Error(`pressFeed: 没有这种食物 "${kind}"`);
      state.feeds += 1;
      if (d.onFeed) d.onFeed(kind);
      pulse();
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
      card.classList.toggle('is-open', !!creature);
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
      if (state.card && nowMs - state._lastCardAt >= H.cardRefreshMs) {
        state._lastCardAt = nowMs;
        renderCard(state.card, world);
      }
      root.classList.toggle('is-dim', nowMs - state.lastInputAt >= H.fadeIdleMs);
    },
    pulse,
    destroy() { root.remove(); },
  };

  // 这两个按钮要调 api，所以必须绑在 api 之后 —— 顺序是有意的，别顺手挪到上面去。
  nameBtn.addEventListener('click', () => api.rename(state.card, nameInput.value));
  tellBtn.addEventListener('click', () => api.tell());
  return api;
}
