import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHud } from '../src/hud.js';
import { heartFillFor } from '../src/hud.js';
import { CONFIG } from '../src/config.js';
import { createEmotions } from '../src/emotions.js';
import { createNeeds } from '../src/needs.js';
import { createMemory, remember } from '../src/memory.js';
import { makeDoc, find, findAll, textOf, dump, click, countListeners } from './dom-stub.js';

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
  const controller = over.controller || {
    getTimeScale: () => 1,
    setTimeScale: (s) => calls.push(['scale', s]),
    getMuted: () => true,
    setMuted: (v) => calls.push(['mute', v]),
    getPaused: () => false,
    setPaused: (v) => { calls.push(['pause', v]); return v; },
    stop: () => calls.push(['stop']),
    saveState: { source: 'fresh', bytes: 0, writes: 0 },
    saveNow: () => calls.push(['saveNow']),
    clearSave: () => calls.push(['clearSave']),
    getApiConfig: () => ({ enabled: false, endpoint: '', model: '', hasKey: false }),
    setApiConfig: (p) => calls.push(['api', p]),
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

test('静音键按下去传的是"当前事实取反"，不是写死 true', () => {
  const { root, calls } = mount();
  click(find(root, 'button', 'hud-mute'));
  assert.deepEqual(calls[0], ['mute', false], '当前是静音 ⇒ 按一下应该取消静音');
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
  assert.equal(heart.style['--heart-fill'], String(heartFillFor(0.62)));
  assert.ok(!/0\.62/.test(textOf(find(root, 'div', 'hud-card'))), '好感度的数字漏到卡上了');
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
