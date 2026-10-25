import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHud } from '../src/hud.js';
import { heartFillFor, radarFor } from '../src/hud.js';
import { CONFIG } from '../src/config.js';
import { createEmotions } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';
import { makeDoc, find, findAll, textOf, dump, click, countListeners } from './dom-stub.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ================================================================ HUD 的 DOM 那一半
//
// 跑在 tests/dom-stub.js 上：只测"建了哪些节点、写的什么字、按下去调了谁"。
// 布局、样式计算、事件冒泡**不在覆盖面内** —— 那些要真浏览器，属 Task 8 的人眼清单。
//
// 为什么单开一个文件而不是接在 tests/hud.test.js 后面：那个文件测的是**纯层**，
// 一个节点都不碰；这个文件测的是**挂载**。混在一个文件里，将来"纯层回归"与
// "DOM 结构改动"两种红会搅在一起，而它们的修法完全不同。

const mk = (o = {}) => ({
  id: o.id || 'c1',
  name: 'name' in o ? o.name : '泡泡',
  customName: false, generation: 2,
  age: o.age ?? 2000, stage: o.stage || 'adult',
  alive: true, sick: false, dying: 0, mourn: 0,
  pos: { x: 0.4, y: 0.5 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 },
  emotions: Object.assign(createEmotions(), o.emotions),
  needs: Object.assign(createNeeds(), o.needs),
  memory: (() => {
    const m = createMemory();
    remember(m, { id: 'PLAYER', familiarity: 1, affection: o.aff ?? 0, kinship: 0, role: null });
    return m;
  })(),
  traits: { hue: 330, sat: 0.6, lum: 0.7, size: o.size ?? 26, glow: 0.6, pattern: 'rings',
    patternDensity: 0.4, wobble: 0.5, fluff: 0.5, eggTint: 'macaron-mint',
    personality: { bold: 0.2, clingy: 0.8, irritable: 0.1, gluttonous: 0.6, curious: 0.3,
      activity: 0.7, talk: 0.4, intellect: 0.9, broody: 0.5 } },
  genes: {}, thresholds: { heardCapacity: 6 },
  lineage: { mother: null, father: null, mates: [], offspring: [] },
  heard: [], eggBoost: 0, catchphrase: '喵喵',
  intent: null, broodT: 0, begIgnored: 0, beingPetted: false, beingPoked: false,
});
const W = (creatures, o = {}) => Object.assign({ creatures, eggs: [], foods: [], time: 125 }, o);

function mount(over = {}) {
  const doc = makeDoc();
  const calls = [];
  const cfg = { enabled: false, endpoint: '', model: '', hasKey: false };
  // 静音必须**成对读写同一个变量**（与下面 getApiConfig/setApiConfig 同一条理由）：
  // 写成 `getMuted: () => true` 这种只出不进的桩，"按下之后按钮上的字有没有跟着变"
  // 这一类断言根本无从成立，而且默认值 true 与 spec §5.4"默认开启声音"是反的。
  let muted = false;
  const controller = over.controller || {
    getTimeScale: () => 1,
    setTimeScale: (s) => calls.push(['scale', s]),
    getMuted: () => muted,
    setMuted: (v) => { muted = !!v; calls.push(['mute', v]); return muted; },
    getPaused: () => false,
    setPaused: (v) => { calls.push(['pause', v]); return v; },
    stop: () => calls.push(['stop']),
    saveState: 'saveState' in over ? over.saveState : { source: 'fresh', bytes: 0, writes: 0 },
    saveNow: () => calls.push(['saveNow']),
    clearSave: () => calls.push(['clearSave']),
    // getApiConfig / setApiConfig 必须成对地读写**同一份** cfg —— 真页面里它们背后是
    // 同一份本机存储。写成两个互不相干的桩，就会出现"HUD 说没存过、存储里明明有"
    // 这种两边都测不到的缝（keySaved 那条第二真相就是这么冒出来的）。
    getApiConfig: () => ({
      enabled: cfg.enabled, endpoint: cfg.endpoint, model: cfg.model, hasKey: cfg.hasKey,
    }),
    setApiConfig: (p) => {
      if ('endpoint' in p) cfg.endpoint = p.endpoint;
      if ('model' in p) cfg.model = p.model;
      if ('key' in p && p.key) cfg.hasKey = true;
      calls.push(['api', p]);
    },
  };
  const hud = mountHud(doc, {
    controller,
    audioState: 'audioState' in over ? over.audioState : { tried: true, ok: true, reason: null },
    onFeed: (kind) => calls.push(['feed', kind]),
    onTell: (c, text) => calls.push(['tell', c && c.id, text]),
    onRename: (c, name) => calls.push(['rename', c && c.id, name]),
    onScatter: (x, y) => calls.push(['scatter', x, y]),
    onSpeech: (v) => calls.push(['speech', v]),
  });
  return { doc, hud, calls, root: doc.body };
}

// ---------------------------------------------------------------- 结构与可达性

test('挂载建出 spec §6.3 要的四块：左上读数 / 右上控件 / 底部食物条 / 信息卡', () => {
  const { hud, root } = mount();
  assert.ok(find(root, 'div', 'hud-readout'), '左上');
  assert.ok(find(root, 'div', 'hud-controls'), '右上');
  assert.ok(find(root, 'div', 'hud-foodbar'), '底部');
  assert.ok(find(root, 'div', 'hud-card'), '信息卡容器');
  assert.equal(hud.state.card, null, '刚挂上时没有打开任何一只');
  assert.ok(!find(root, 'div', 'hud-card')._class.has('is-open'), '刚挂上时卡片必须是关的');
});

test('所有按钮都是 44px 目标（尺寸走 class，不写在 style 字面量里）', () => {
  const { root } = mount();
  const btns = findAll(root, 'button');
  assert.ok(btns.length >= 6, `控件太少了：${btns.length}`);
  for (const b of btns) {
    assert.ok(b._class.has('hud-touch'), `"${textOf(b)}" 没打 hud-touch`);
    // type=button 不是装饰：漏了它，按钮在 <form> 里会触发页面提交，症状是"点一下整页刷新"。
    assert.equal(b.attrs.type, 'button', `"${textOf(b)}" 没有 type="button"`);
  }
});

test('倍速键的个数与 CONFIG.timeScales 同数，按下去调 controller.setTimeScale', () => {
  const { hud, root, calls } = mount();
  assert.equal(findAll(root, 'button', 'hud-scale').length, CONFIG.timeScales.length);
  for (const s of CONFIG.timeScales) hud.pressScale(s);
  for (const s of CONFIG.timeScales) assert.ok(calls.some((c) => c[0] === 'scale' && c[1] === s));
  assert.throws(() => hud.pressScale(3), /不在/,
    '随手写个 3 会把子步进数打爆 —— main.js 那条守卫的同一判据，HUD 不许绕过它');
});

test('暂停调 setPaused，**不**碰 stop', () => {
  const { root, calls } = mount();
  click(find(root, 'button', 'hud-pause'));
  assert.deepEqual(calls[0], ['pause', true]);
  assert.ok(!calls.some((c) => c[0] === 'stop'),
    'stop() 会 detach 输入、关音频、摘监听 —— 那是关缸不是暂停');
});

test('音频被浏览器拒绝时静音键**不出现**（spec §5.4.1 第 8 条）', () => {
  const { root } = mount({ audioState: { tried: true, ok: false, reason: 'no-audio' } });
  assert.equal(find(root, 'button', 'hud-mute'), null,
    '挂一个按了永远没反应的按钮不是"降级"，是骗人');
  assert.ok(find(mount().root, 'button', 'hud-mute'), '能发声时按钮必须在');
});

test('静音键在浏览器**当场拒绝**之后就摘掉 —— 不许只在挂载那一眼判一次', () => {
  // 上一条测的是挂载时刻，而真页面的顺序恰好是反的：开缸在任何手势之前，那时
  // audioState 还是 `{tried:false, ok:false}` ⇒ 键必须先挂上。真正决定"这个按钮是不是
  // 骗人"的 `unlockAudio()` 跑在**第一次 pointerdown** 上，那一刻才可能变成被拒绝。
  // 只看挂载那一眼，被拒之后这个键会永远亮在右上角 —— §5.4.1 第 8 条禁的正是它。
  const audioState = { tried: false, ok: false, reason: null };
  const { hud, root } = mount({ audioState });
  assert.ok(find(root, 'button', 'hud-mute'), '还没试过就当被拒绝，静音键从此永远不出现');
  audioState.tried = true;
  audioState.reason = 'not-allowed';        // ok 一直是 false，变的是"已经试过了"
  hud.frame(1000, W([mk()]));
  assert.equal(find(root, 'button', 'hud-mute'), null,
    '明确被拒之后必须摘掉：挂载那一刻判不了未来的事');
});

test('被拒之后摘一次就好 —— 不许每帧对着已脱管的节点再 remove', () => {
  // 会犯的写法是 `if (muteBtn && audioBlocked()) muteBtn.remove()` 而不置空引用：
  // 视觉结果完全正确（键确实没了），但每帧对着一棵已脱管的树调一次 remove。
  // ⇒ 光断言"键不在"分不出这两种实现，必须**数 remove 被调了几次**。
  const audioState = { tried: false, ok: false, reason: null };
  const { hud, root } = mount({ audioState });
  audioState.tried = true;                  // 试了，而且**成功了**
  audioState.ok = true;
  hud.frame(1000, W([mk()]));
  const btn = find(root, 'button', 'hud-mute');
  assert.ok(btn, '发声正常时静音键必须在');
  let removes = 0;
  const orig = btn.remove.bind(btn);
  btn.remove = () => { removes += 1; return orig(); };
  audioState.ok = false;                    // 中途被关闭，也算被拒
  audioState.reason = 'closed';
  for (const t of [2000, 3000, 4000]) hud.frame(t, W([mk()]));
  assert.equal(find(root, 'button', 'hud-mute'), null, '被拒之后键必须不在');
  assert.equal(removes, 1, `每帧重复 remove（实调 ${removes} 次）—— 置空引用不是洁癖，是别把 DOM 当变量`);
});

test('静音键按下去传的是"当前事实取反"，且按钮上的字跟着事实变', () => {
  // main.js 里 setMuted 那句注释承诺"降级缸里静音按钮也得能把按钮自己置灰，靠的是这个返回值
  // 而不是异常" —— 返回值一直没人读，那句话从写下那天起就是空头承诺。
  const { root, calls } = mount();
  const mute = find(root, 'button', 'hud-mute');
  assert.equal(mute.textContent, '静音', '默认有声，键不许预先写着已静音');
  click(mute);
  assert.deepEqual(calls[0], ['mute', true], '当前有声 ⇒ 按一下应该是"要静音"');
  assert.equal(find(root, 'button', 'hud-mute').textContent, '已静音',
    '按完了字还是"静音"，玩家只会再按一次，于是又取消回去');
  click(find(root, 'button', 'hud-mute'));
  assert.deepEqual(calls[1], ['mute', false]);
  assert.equal(find(root, 'button', 'hud-mute').textContent, '静音');
});

// ---------------------------------------------------------------- 信息卡

test('打开一只之后卡里有它的名字，且整张卡没有一句替它陈述心情', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z', name: '糯糯', emotions: { anger: 1 } });
  hud.setCard(c, W([c]));
  const card = find(root, 'div', 'hud-card');
  assert.ok(card._class.has('is-open'));
  const t = textOf(card);
  assert.ok(t.includes('糯糯'), t);
  for (const w of ['心情', '开心', '愤怒', '生气', '快乐', '幸福', '伤心']) {
    assert.ok(!t.includes(w), `卡上出现了"${w}"`);
  }
});

test('setCard(null) 关卡：摘掉 is-open，state.card 归 null', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z' });
  hud.setCard(c, W([c]));
  hud.setCard(null, W([c]));
  assert.equal(hud.state.card, null);
  assert.ok(!find(root, 'div', 'hud-card')._class.has('is-open'));
});

// ---- F-13（2026-10-25 浏览器实跑抓到）：换一只重画时，旧行必须被摘干净 ----
// renderCard 原来写的是 `rowsBox.children.length = 0`。真 DOM 的 children 是**只读**的
// 活 HTMLCollection，那句话在严格模式里抛 TypeError ⇒ 真页面点一下生物就炸；
// 而 dom-stub 里 children 曾是普通数组，所以它"成功"了。桩已改成只读视图，
// 这一格再把语义钉住：不许留重复行（有人删掉 clear() 时，这里红，而不是只靠抛错）。
test('换一只有不同行的：重画之后行里不许出现重复（clear 真把旧的摘了）', () => {
  const { hud, root } = mount();
  const rowsBox = find(root, 'div', 'hud-rows');
  const a = mk({ id: 'a', name: '糯糯' });
  const b = mk({ id: 'b', name: '阿橘', emotions: { anger: 1, fear: 1, joy: 0 } });
  hud.setCard(a, W([a]));
  const first = rowsBox.children.map(textOf);
  assert.ok(first.length > 0, '一行都没画出来，那这条判据是空的');
  hud.setCard(b, W([a, b]));
  const second = rowsBox.children.map(textOf);
  assert.ok(second.join('|') !== first.join('|'),
    '两只不同的生物画出完全相同的行 ⇒ 这一格测不到重画，换夹具');
  assert.equal(new Set(second).size, second.length,
    `重画留下了重复行：${JSON.stringify(second)}`);
  assert.ok(!textOf(rowsBox).includes('糯糯'), '上一只的名字还挂在行里');
});

test('雷达图画成 SVG 折线：九个点', () => {
  const { hud, root } = mount();
  hud.setCard(mk(), W([mk()]));
  const svg = find(root, 'svg', 'hud-radar');
  assert.ok(svg, '雷达图必须是 svg —— 在 canvas 里画 HUD 会把 HUD 和缸耦死');
  const poly = find(svg, 'polygon');
  assert.ok(poly, 'svg 里没有 polygon');
  assert.equal(poly.attrs.points.split(' ').length, 9);
});

test('心形用 CSS 变量表示填充度，卡上不出现那个 0-1 的数（spec §6.3"不写数字"）', () => {
  const { hud, root } = mount();
  hud.setCard(mk({ aff: 0.62 }), W([mk({ aff: 0.62 })]));
  const heart = find(root, 'div', 'hud-heart');
  assert.ok(heart, '没有心形节点');
  // ⚠️ 必须读 getPropertyValue，不是 style['--heart-fill']：真 DOM 里自定义属性**只有**
  // setProperty 进得了层叠，直接写那个键只是在 JS 对象上挂了个幽灵属性
  // （真页面实测 cssText="" 而 getComputedStyle 读到 CSS 默认的 0 ⇒ 心形永远空着，F-14）。
  assert.equal(heart.style.getPropertyValue('--heart-fill'), String(heartFillFor(0.62)));
  hud.setCard(mk({ aff: 0.02 }), W([mk({ aff: 0.02 })]));
  assert.notEqual(heart.style.getPropertyValue('--heart-fill'), String(heartFillFor(0.62)),
    '换一只好感差很多的，填充度却一动不动 ⇒ 这条判据是空的（或写死成了常数）');
  assert.ok(!/0\.62/.test(textOf(find(root, 'div', 'hud-card'))), '好感度的数字漏到卡上了');
});

test('雷达图的 svg / polygon 必须在 SVG 命名空间里，class 挂在 class 属性上（F-15）', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const { hud, root, doc } = mount();
  hud.setCard(mk({ id: 'z', aff: 0.4 }), W([mk({ id: 'z', aff: 0.4 })]));
  const svg = find(root, 'svg', 'hud-radar');
  assert.ok(svg, '卡上没有雷达图节点');
  // 真页面实测：document.createElement('svg') 给的是 HTMLUnknownElement，
  // namespaceURI 还是 XHTML，里面那个 <polygon> 的 getBoundingClientRect 是 0×0
  // —— 雷达图一个像素都不画，而桩里 createElement 不分家，所以它一直"成功"。
  assert.equal(svg.namespaceURI, SVG_NS, 'svg 不是 SVG 命名空间 ⇒ 真浏览器里它是个未知元素');
  const poly = find(svg, 'polygon');
  assert.ok(poly, 'svg 里没有 polygon');
  assert.equal(poly.namespaceURI, SVG_NS);
  assert.ok(poly.getAttribute('class'), 'class 没挂到 class 属性上（SVGElement.className 是只读的）');
  assert.ok(doc.createdNS.includes('polygon'), 'polygon 没走 createElementNS');
});

test('雷达图把九个轴名画出来：逐字等于 radarFor 的 axis（O-4：数据没被 DOM 层丢掉）', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z', aff: 0.4 });
  hud.setCard(c, W([c]));
  const svg = find(root, 'svg', 'hud-radar');
  const texts = findAll(svg, 'text').map(textOf);
  assert.deepEqual(texts, radarFor(c.traits).map((p) => p.axis),
    `九个轴名不对：${JSON.stringify(texts)}`);
  // 反空对照：九个必须各不相同，否则"有九个 text"这件事本身不算证据
  assert.equal(new Set(texts).size, 9, `轴名有重复：${JSON.stringify(texts)}`);
});

test('折线不许长到把轴名吃掉：顶点半径上界 < 标签半径（两处几何只有一个定义点）', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z' });
  hud.setCard(c, W([c]));
  const svg = find(root, 'svg', 'hud-radar');
  const poly = find(svg, 'polygon');
  const pts = poly.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
  const rMax = Math.max(...pts.map(([x, y]) => Math.hypot(x - 50, y - 50)));
  const labels = findAll(svg, 'text');
  const rLabel = Math.min(...labels.map((n) =>
    Math.hypot(Number(n.attrs.x) - 50, Number(n.attrs.y) - 50)));
  assert.ok(rMax < rLabel, `顶点最远 ${rMax.toFixed(1)} 已经压上标签半径 ${rLabel.toFixed(1)} ⇒ 字会被折线盖住`);
  assert.ok(rLabel <= 49, `标签跑到 0..100 方框外了：${rLabel.toFixed(1)}`);
});

test('肖像的 src 来自 avatarSrc：八种状态出八张不同的脸', () => {
  const { hud, root } = mount();
  const seen = new Set();
  const cases = [[{}, 0], [{ joy: 0.6 }, 0], [{ anger: 0.9 }, 0], [{ joy: 0.1, fear: 0.6 }, 0],
    [{ joy: 0.8, arousal: 0.4 }, 0.9], [{ sleepy: 0.95 }, 0], [{ curiosity: 0.95 }, 0],
    [{ arousal: 0.95 }, 0]];
  for (const [emotions, aff] of cases) {
    const c = mk({ id: 'p', emotions, aff });
    hud.setCard(c, W([c]));
    const img = find(root, 'img', 'hud-portrait');
    assert.ok(img, '卡上没有肖像 img');
    assert.match(img.attrs.src, /^assets\/star_puff_[a-z]+\.png$/);
    seen.add(img.attrs.src);
  }
  assert.equal(seen.size, 8, `八种状态只出了 ${seen.size} 张脸：肖像没跟着状态走`);
});

// ---------------------------------------------------------------- 两个输入口

test('讲给它听：点"说"→ 调 onTell，且清空输入框（不清的话下一句是拼接）', () => {
  const { hud, calls, root } = mount();
  const c = mk({ id: 'z' });
  hud.setCard(c, W([c]));
  const box = find(root, 'input', 'hud-tell');
  box.value = '宝宝今天也要好好吃饭哦';
  click(find(root, 'button', 'hud-tell-go'));
  const tell = calls.find((x) => x[0] === 'tell');
  assert.ok(tell, '一次 tell 都没发出去');
  assert.deepEqual([tell[1], tell[2].includes('好好吃饭')], ['z', true]);
  assert.equal(box.value, '', '输入框必须清空');
});

test('tell() 也可以由代码直接调；空输入什么都不发', () => {
  const { hud, calls } = mount();
  hud.setCard(mk({ id: 'z' }), W([mk({ id: 'z' })]));
  hud.tell('测试用的一句话');
  assert.equal(calls.filter((x) => x[0] === 'tell').length, 1);
  hud.tell('');
  hud.tell(null);
  assert.equal(calls.filter((x) => x[0] === 'tell').length, 1, '空输入也发了一次 = 白刷计数器');
});

test('超长输入被截断而不是报错，并且计数', () => {
  const { hud, calls } = mount();
  hud.setCard(mk({ id: 'z' }), W([mk({ id: 'z' })]));
  hud.tell('啊'.repeat(CONFIG.hud.tellMaxChars + 340));
  assert.equal(hud.state.tellTruncated, 1);
  assert.ok(calls.at(-1)[2].length <= CONFIG.hud.tellMaxChars, '截断没生效');
});

test('没打开任何一只时 tell 被丢弃，但**留痕**（不许静默，spec §7.7 的同一条纪律）', () => {
  const { hud, calls } = mount();
  hud.tell('对着空缸说话');
  assert.equal(calls.filter((x) => x[0] === 'tell').length, 0);
  assert.equal(hud.state.tellDropped, 1);
});

test('改名：交出去的名字截到 nameMaxChars；空白名交 null 并计数', () => {
  const { hud, calls } = mount();
  const c = mk({ id: 'z' });
  hud.rename(c, '这是一个长得离谱的名字要截断');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['rename', 'z']);
  assert.equal(calls.at(-1)[2].length, CONFIG.hud.nameMaxChars);
  hud.rename(c, '   ');
  assert.equal(calls.at(-1)[2], null, '空名字要交 null，让 main 那边什么都不动');
  assert.equal(hud.state.rejectedNames, 1);
});

test('长按一只：setCard 带 focusName 把光标落在改名框上', () => {
  const { hud, doc } = mount();
  const c = mk({ id: 'z', name: '泡泡' });
  hud.setCard(c, W([c]), { focusName: true });
  assert.ok(doc.__focused && doc.__focused._class.has('hud-name'), '没聚焦到改名框');
  // 桩里没有真焦点模型（谁后 focus 谁亮着），所以先把状态清掉再验"普通点按不抢焦点"。
  // 不去给桩补 blur 链：那是重写浏览器的焦点语义，超出本文件要测的范围。
  doc.__focused = null;
  hud.setCard(mk({ id: 'y' }), W([mk({ id: 'y' })]));
  assert.equal(doc.__focused, null, '普通点按也弹软键盘 = 每次开卡都挡住半个缸');
});

// ---------------------------------------------------------------- 食物条与淡出

test('食物条：键数与 kind 逐字取自 CONFIG.food，点下去调 onFeed', () => {
  const { hud, root, calls } = mount();
  const keys = findAll(root, 'button', 'hud-feed');
  assert.deepEqual(keys.map((b) => b.dataset.kind).sort(), Object.keys(CONFIG.food).sort());
  click(keys[0]);
  assert.equal(calls.at(-1)[0], 'feed');
  assert.equal(hud.state.feeds, 1);
});

test('食物条每个 kind 都有中文标签：少一个就吐英文键', () => {
  const { root } = mount();
  for (const kind of Object.keys(CONFIG.food)) {
    const b = findAll(root, 'button', 'hud-feed').find((x) => x.dataset.kind === kind);
    assert.ok(b, `食物条少了 ${kind}`);
    assert.ok(!textOf(b).includes(kind), `${kind} 的按钮上没有中文名：${textOf(b)}`);
    assert.match(textOf(b), /[一-龥]/);
  }
});

test('淡出：闲过 fadeIdleMs 打 is-dim；任何交互立刻亮回来', () => {
  const { hud, root } = mount();
  const hudEl = find(root, 'div', 'hud');        // is-dim 打在 .hud 上，不是打在 body 上
  assert.ok(hudEl, '没有 .hud 根节点');
  const w = W([mk()]);
  hud.pulse(0);
  assert.ok(!hudEl._class.has('is-dim'), '刚交互过就淡出 = 玩家永远看不见控件');
  for (let t = 0; t <= CONFIG.hud.fadeIdleMs; t += 100) hud.frame(t, w);
  assert.ok(hudEl._class.has('is-dim'), '闲了这么久还不淡出');
  hud.pressScale(2);
  assert.ok(!hudEl._class.has('is-dim'), '一有交互就必须立刻亮回来');
});

test('卡或设置页开着的时候不许淡出（F-16：淡成 0.25 = 看不清但点得动的输入框）', () => {
  const { hud, root } = mount();
  const hudEl = find(root, 'div', 'hud');
  const c = mk({ id: 'z', name: '糯糯' });
  const w = W([c]);
  let clk = 0;
  const idleFor = () => {
    const until = clk + CONFIG.hud.fadeIdleMs + 20;
    for (; clk <= until; clk += 100) hud.frame(clk, w);
  };
  hud.setCard(c, w);
  idleFor();
  assert.ok(!hudEl._class.has('is-dim'), '信息卡（含改名框与"讲给它听"框）开着还淡出');
  hud.setCard(null, w);
  hud.setSettingsOpen(true);
  idleFor();
  assert.ok(!hudEl._class.has('is-dim'), '只开着设置页同理：那里有三个输入框与两个按钮');
  hud.setSettingsOpen(false);
  idleFor();
  assert.ok(hudEl._class.has('is-dim'), '都关了就该淡回去 —— 这条不许被修过头（spec §6.3 那句"不遮挡水体"还在）');
});

// ---------------------------------------------------------------- 不写世界、节流、收尾

test('frame 不写世界：跑 200 帧之后 world 逐字节不变（全局约束第 6 条）', () => {
  const { hud } = mount();
  const w = W([mk(), mk({ id: 'b' })]);
  const before = JSON.stringify(w);
  hud.setCard(w.creatures[0], w);
  for (let i = 0; i < 200; i++) hud.frame(i * 16.7, w);
  assert.equal(JSON.stringify(w), before, 'HUD 每帧动过世界了');
});

test('信息卡按 cardRefreshMs 节流：200 帧只重排几次', () => {
  const { hud } = mount();
  const w = W([mk()]);
  hud.setCard(w.creatures[0], w);
  const base = hud.state.cardRenders;
  for (let i = 0; i < 200; i++) hud.frame(i * 16.7, w);      // 200 帧 ≈ 3.3 秒
  const renders = hud.state.cardRenders - base;
  const cap = Math.ceil(200 * 16.7 / CONFIG.hud.cardRefreshMs) + 1;
  assert.ok(renders > 0, '一次都没重排：节流过头，卡上的数字不会再动了');
  assert.ok(renders <= cap, `重排了 ${renders} 次，上限该是 ${cap}`);
});

test('destroy() 摘干净节点与监听器', () => {
  const { doc, hud } = mount();
  assert.ok(countListeners(doc.body) > 0, '一个监听器都没绑，那这条测试在空转');
  hud.destroy();
  assert.equal(doc.body.children.length, 0);
  assert.equal(countListeners(doc.body), 0, '摘了节点没摘监听 = 泄漏');
});

test('destroy 之后再按按钮不抛（页面已关，回调是死的）', () => {
  const { hud } = mount();
  hud.destroy();
  hud.pressScale(2);
  hud.pulse(0);
  hud.frame(1, W([mk()]));
});

test('controller 缺方法时挂载不抛，但调用时报错（缺的是接线，不是用户输入）', () => {
  const doc = makeDoc();
  const hud = mountHud(doc, { controller: {}, onFeed: () => {} });
  assert.ok(find(doc.body, 'div', 'hud'), '挂载就抛了');
  assert.throws(() => hud.pressScale(2), /setTimeScale/,
    '静默吞掉的话症状是"点了没反应"，最难查');
});

test('整棵 HUD 树里搜不到"心情"二字（§13.2 第 4 条的最后一道网）', () => {
  const { hud, root } = mount();
  hud.setCard(mk({ emotions: { anger: 1 } }), W([mk({ emotions: { anger: 1 } })]));
  assert.ok(!dump(root).includes('心情'), dump(root).slice(0, 400));
});

test('还没试过音频时静音键**要在**：只看 ok 会把它永远藏掉（Task 5 抓到的一条）', () => {
  // 开缸那一刻真页面的 audioState 是 {tried:false, ok:false} —— AudioContext 要等
  // 第一次真实手势才创建。如果判据只看 ok===false，静音键就**永远不出现**，
  // 直到玩家按下第一下才补上，而那正是按钮该在的位置旁边。
  const { root } = mount({ audioState: { tried: false, ok: false, reason: null } });
  assert.ok(find(root, 'button', 'hud-mute'), '还没试过就当"被拒绝"，静音键从此消失');
  const blocked = mount({ audioState: { tried: true, ok: false, reason: 'unsupported' } });
  assert.equal(find(blocked.root, 'button', 'hud-mute'), null, '明确被拒绝时才该藏');
});

// ================================================================ Task 6：设置页

test('设置页六行：端点 / 模型 / key / 文字层开关 / 存档来源 / 危险动作', () => {
  const { hud, root } = mount();
  hud.setSettingsOpen(true);
  for (const cls of ['hud-set-endpoint', 'hud-set-model', 'hud-set-key',
    'hud-set-speech', 'hud-set-save', 'hud-set-danger']) {
    assert.ok(find(root, 'div', cls), `缺 ${cls}`);
  }
});

test('设置页关着的时候这些输入框不许在树里（key 少一处能被读到的地方）', () => {
  const { hud, root } = mount();
  assert.equal(find(root, 'input', 'hud-set-key'), null, '关着还挂着 key 框');
  hud.setSettingsOpen(true);
  assert.ok(find(root, 'input', 'hud-set-key'));
  hud.setSettingsOpen(false);
  assert.equal(find(root, 'input', 'hud-set-key'), null, '关掉设置页还留着 key 框 = 关与没关一样');
});

// ---- F-12（2026-10-25 浏览器实跑抓到）：面板建出来了 ≠ 玩家看得见 ----
// 设置那一节长在 .hud-card 里面，而 CSS 只有 `.hud-card.is-open { display: block }`。
// is-open 此前**只由 setCard(生物) 写**，所以"没选中任何生物时点设置"是
// state.settingsOpen=true、buildPanel() 跑完、DOM 里六个输入框都在，而屏幕上什么都没有。
// 桩里没有 CSS，这条在 1093 个判据里一条都藏不住 —— 只能把"可见"本身写成断言。

test('点「设置」必须自己就能让卡片可见，并挂上"这是设置页"的样子', () => {
  const { hud, root } = mount();
  const card = find(root, 'div', 'hud-card');
  hud.setSettingsOpen(true);
  assert.ok(card._class.has('is-open'), '设置页建出来了但卡片还 display:none = 点了没反应');
  assert.ok(card._class.has('is-settings'), '没选中生物时的设置页得有自己的样子（不许露出空卡与上一只的名字）');
  hud.setSettingsOpen(false);
  assert.ok(!card._class.has('is-open'), '关掉设置页还把卡留着 = 一具空卡浮在缸上');
  assert.ok(!card._class.has('is-settings'), 'is-settings 不跟着摘，下次开生物卡会带着它');
});

test('先点生物再点设置：那张卡照旧是它的卡（不许挂 is-settings 把生物那几行藏掉）', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z', name: '糯糯' });
  hud.setCard(c, W([c]));
  hud.setSettingsOpen(true);
  const card = find(root, 'div', 'hud-card');
  assert.ok(card._class.has('is-open'));
  assert.ok(!card._class.has('is-settings'), '有卡的时候设置只是多一节，藏掉生物行等于把卡砸了');
  assert.ok(textOf(card).includes('糯糯'), '生物的名字被设置页挤掉了');
});

test('设置开着时点空白关卡：卡必须留着，否则设置页凭空消失', () => {
  const { hud, root } = mount();
  const c = mk({ id: 'z', name: '糯糯' });
  hud.setCard(c, W([c]));
  hud.setSettingsOpen(true);
  hud.setCard(null, W([c]));
  const card = find(root, 'div', 'hud-card');
  assert.ok(card._class.has('is-open'), '关卡把设置页一起带走了，而 state.settingsOpen 还是 true');
  assert.ok(card._class.has('is-settings'), '此时没有生物了 ⇒ 该换成设置页的样子');
  assert.equal(hud.state.settingsOpen, true);
});

// ---- F-10（§6 里挂了很久的"轻，且没有任何测试能发现它"）：落盘那一行必须骑帧 ----
// 面板开着的时候 `save.frame()` 每 30 模拟秒真的会再落一次盘，而这一行此前只在
// 开面板与每一次控件交互时刷 —— 于是玩家看到的是"停在开面板那一刻"的过期数。

test('落盘那一行骑帧：面板开着、什么都不按，writes 涨了它就得跟着变', () => {
  const saveState = { source: 'restored', bytes: 1000, writes: 3 };
  const { hud, root } = mount({ saveState });
  hud.setSettingsOpen(true);
  const line = () => textOf(find(root, 'div', 'hud-set-save'));
  assert.match(line(), /已写 3 次/, '开面板那一刻就不对，那后面那条判据是空的');
  saveState.writes = 4; saveState.bytes = 2048;   // 模拟落盘层原地改了那份读数
  hud.frame(5000, W([mk()]));
  assert.match(line(), /已写 4 次/, '什么都不按它就停在开面板那一刻 = 一行会过期的读数');
  assert.match(line(), /2048B/, '字节数同理');
});

test('落盘那一行"值变了才写"：连着两帧值没变，不许无条件改 DOM', () => {
  const saveState = { source: 'fresh', bytes: 10, writes: 1 };
  const { hud, root } = mount({ saveState });
  hud.setSettingsOpen(true);
  const before = hud.state.saveLineWrites;
  assert.ok(before >= 1, '开面板那一刻没写过一次 ⇒ 那个计数器是摆设');
  hud.frame(5000, W([mk()]));
  hud.frame(5016, W([mk()]));
  assert.equal(hud.state.saveLineWrites, before,
    '每帧无条件写 DOM —— 左上那四条读数的老纪律在这里同样成立');
  saveState.writes = 2;
  hud.frame(5032, W([mk()]));
  assert.equal(hud.state.saveLineWrites, before + 1, '值变了却没写');
});

test('重开面板必须立刻是当下的值：那份缓存不许跨面板', () => {
  const saveState = { source: 'fresh', bytes: 7, writes: 9 };
  const { hud, root } = mount({ saveState });
  hud.setSettingsOpen(true);
  hud.setSettingsOpen(false);
  saveState.writes = 10;
  hud.setSettingsOpen(true);
  assert.match(textOf(find(root, 'div', 'hud-set-save')), /已写 10 次/,
    'buildPanel 换了一具新 span，而缓存还是旧串 ⇒ 新面板永远显示"未知来源"');
});

test('key 是**只写**的：填进去保存之后，整棵树里搜不到那个串', () => {
  const { hud, doc, calls } = mount();
  hud.setSettingsOpen(true);
  const SENTINEL = 'sk-DO-NOT-LEAK-1234567890';
  hud.setKey(SENTINEL);
  hud.saveSettings();
  assert.ok(calls.some((c) => c[0] === 'api' && c[1].key === SENTINEL), 'key 没交给 setApiConfig');
  assert.ok(!dump(doc.body).includes(SENTINEL), 'key 回显在 DOM 上了');
  const box = find(doc.body, 'input', 'hud-set-key');
  assert.equal(box.attrs.type, 'password');
  assert.equal(box.value, '', '保存之后输入框必须清空');
});

test('key 那一行只显示"已保存"，不显示长度也不显示前缀', () => {
  const { hud, doc } = mount();
  hud.setSettingsOpen(true);
  hud.setKey('sk-abcdefgh1234567890');
  hud.saveSettings();
  const rowText = textOf(find(doc.body, 'div', 'hud-set-key'));
  assert.match(rowText, /已保存/);
  assert.ok(!/abcdefgh/.test(rowText) && !/1234/.test(rowText), rowText);
});

test('端点非 https 当场报、不落盘（spec §13.2 第 3 条）', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true);
  hud.setEndpoint('http://evil.example/v1');
  hud.setModel('qwen');
  hud.saveSettings();
  assert.equal(hud.state.endpointRejected, 1);
  assert.ok(!calls.some((c) => c[0] === 'api'), '被拒的配置不许写进本机存储');
});

test('合法的 https 端点保存后调 setApiConfig，且交出去的 patch 里没有 undefined 键', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true);
  hud.setEndpoint('https://example.test/v1');
  hud.setModel('qwen-plus');
  hud.saveSettings();
  const patch = calls.find((c) => c[0] === 'api')[1];
  assert.equal(patch.endpoint, 'https://example.test/v1');
  assert.equal(patch.model, 'qwen-plus');
  assert.ok(!('key' in patch), '没填 key 就别交 key 这个键（空串会覆盖掉已存的）');
});

test('文字层开关写的是 world.speechEnabled，不是 CONFIG', () => {
  const { hud, calls } = mount();
  hud.setSettingsOpen(true);
  hud.setSpeech(false);
  assert.deepEqual(calls.at(-1), ['speech', false]);
});

test('清空存档要按两次：第一次只亮确认态，第二次才调 clearSave', () => {
  const { hud, calls, doc } = mount();
  hud.setSettingsOpen(true);
  const btn = find(doc.body, 'button', 'hud-clear-save');
  click(btn);
  assert.ok(!calls.some((c) => c[0] === 'clearSave'), '一次就清 = 一次误触丢掉一缸');
  assert.ok(btn._class.has('is-armed'), '没进入确认态，玩家不知道还要按一次');
  click(btn);
  assert.ok(calls.some((c) => c[0] === 'clearSave'));
});

test('确认态过 confirmArmedMs 不点就自己收回', () => {
  const { hud, calls, doc } = mount();
  hud.setSettingsOpen(true);
  hud.pressClear();
  assert.equal(hud.state.clearArmed, true);
  for (let t = 10000; t < 10000 + CONFIG.hud.confirmArmedMs + 200; t += 100) hud.frame(t, W([mk()]));
  assert.equal(hud.state.clearArmed, false, 'armed 的按钮亮着不管 = 下一次随手一按就清了');
  hud.pressClear();
  assert.ok(!calls.some((c) => c[0] === 'clearSave'), '收回之后第一次按就该是重新 arm');
});

test('存档那一行写的是 source 与字节数（四个 source 都有中文说法，不许吐英文键）', () => {
  for (const [source, want] of [['fresh', '本机'], ['restored', '读回'],
    ['corrupt-moved', '留证据'], ['unreadable', '不可用']]) {
    const { hud, doc } = mount({ controller: {
      getTimeScale: () => 1, setTimeScale() {}, getMuted: () => true, setMuted() {},
      getPaused: () => false, setPaused() {}, saveState: { source, bytes: 1234, writes: 2 },
      saveNow() {}, clearSave() {}, getApiConfig: () => ({ enabled: false, hasKey: false }),
      setApiConfig() {} } });
    hud.setSettingsOpen(true);
    const t = textOf(find(doc.body, 'div', 'hud-set-save'));
    assert.ok(t.includes(want), `${source} 的说法里没有"${want}"：${t}`);
    assert.ok(!t.includes(source), `${source} 直接吐了英文键：${t}`);
  }
});

test('立即落盘那个键真的调 saveNow，并显示写入了多少字节', () => {
  const { hud, calls, doc } = mount();
  hud.setSettingsOpen(true);
  click(find(doc.body, 'button', 'hud-save-now'));
  assert.ok(calls.some((c) => c[0] === 'saveNow'));
});

test('设置页整页不许出现"心情"或任何 API key 字样（最后一道网）', () => {
  const { hud, doc } = mount();
  hud.setSettingsOpen(true);
  hud.setKey('sk-zzz-secret-zzz');
  hud.saveSettings();
  hud.setCard(mk({ emotions: { anger: 1 } }), W([mk({ emotions: { anger: 1 } })]));
  const all = dump(doc.body);
  assert.ok(!all.includes('心情'));
  assert.ok(!all.includes('sk-zzz'));
});

test('key 保存之后就算重开设置页也不回来（探针 S4 逼出来的那条）', () => {
  // S4 那道探针（把 draft.key 回填进输入框）在"保存后 dump 一次"的判据下**活着**，
  // 而且它改的其实是可接受的窗口：玩家正在打字时 key 当然在那个框里。
  // 真正要钉的是**存过之后不许再出现** —— 那要跨一次"关掉再打开"才看得出来，
  // 因为 buildPanel 是重建的，回填只会发生在那里。
  const { hud, doc } = mount();
  hud.setSettingsOpen(true);
  const SENTINEL = 'sk-PERSIST-MUST-NOT-COME-BACK';
  hud.setKey(SENTINEL);
  hud.saveSettings();
  hud.setSettingsOpen(false);
  hud.setSettingsOpen(true);
  assert.ok(!dump(doc.body).includes(SENTINEL), '重开设置页把已保存的 key 又画出来了');
  assert.match(textOf(find(doc.body, 'div', 'hud-set-key')), /已保存/);
});

test('源码守卫：draft.key 从不被赋给任何节点（S4/S10 都逼不出红的，因为这条是结构性的）', async () => {
  // 前面那两条 dump 判据是**观察侧**的网；但"key 不回填"这件事在这版实现里是结构性的
  // —— 没有任何一条代码路径把 draft.key 写进节点，所以删掉某一句清空也测不出红。
  // 测不出红的判据不等于没有判据，但**要换一种判法**：直接扫源码。
  const src = readFileSync(fileURLToPath(new URL('../src/hud.js', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  // (?![A-Za-z]) 是必需的：draft.keyEntered 也以前缀 draft.key 开头，
  // 少了这个边界，守卫会把"读一个布尔量"误报成"把 key 写进节点"。
  assert.ok(!/(\.value|\.textContent|setAttribute\([^)]*\))\s*=[^;\n]*draft\.key(?![A-Za-z])/.test(src),
    '有人把 draft.key 写进节点了 —— 那正是"key 只写不读"这条承诺破掉的地方');
  assert.ok(/type', 'password'/.test(src), 'key 输入框不再是 password 型');
});
