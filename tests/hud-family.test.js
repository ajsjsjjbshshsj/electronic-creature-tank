import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHud } from '../src/hud.js';
import { makeDoc, find, findAll, click, textOf, countListeners, SVG_NS, HTML_NS } from './dom-stub.js';

const C = (o) => ({
  id: o.id,
  name: o.name || o.id,
  alive: o.alive !== false,
  stage: o.stage || 'adult',
  generation: o.generation || 1,
  traits: { hue: o.hue ?? 330 },
  lineage: { mother: o.mother ?? null, offspring: o.offspring || [] },
  memory: { entries: o.entries || [] },
});
const WORLD = {
  time: 125, foods: [], eggs: [], speechEnabled: true,
  creatures: [
    C({ id: 'c-a', name: 'A', offspring: ['c-b', 'c-c'], hue: 320 }),
    C({ id: 'c-b', name: 'B', mother: 'c-a', generation: 2, hue: 330,
      entries: [{ id: 'c-c', role: 'companion' }] }),
    C({ id: 'c-c', name: 'C', mother: 'c-a', generation: 2, hue: 340,
      entries: [{ id: 'c-b', role: 'companion' }] }),
    C({ id: 'c-d', name: '外来者', mother: 'gone', generation: 2, hue: 350 }),
    C({ id: 'c-dead', name: '死者', alive: false, stage: 'dead' }),
  ],
};

function mount() {
  const doc = makeDoc();
  const controller = {
    getTimeScale: () => 1, setTimeScale() {}, getMuted: () => false,
    setMuted: (v) => !!v, getPaused: () => false, setPaused: (v) => !!v,
    stop() {}, saveState: { source: 'fresh', bytes: 0, writes: 0 }, saveNow() {},
    clearSave() {}, getApiConfig: () => ({ enabled: false, endpoint: '', model: '', hasKey: false }),
    setApiConfig() {},
  };
  const hud = mountHud(doc, {
    controller, audioState: { tried: true, ok: true, reason: null },
    carryInside: () => true,
  });
  return { doc, hud, root: doc.body };
}

function openWithFocus(focusId) {
  const { doc, hud, root } = mount();
  hud.frame(0, WORLD);
  hud.setFamilyOpen(true, focusId);
  return { doc, hud, root, family: find(root, 'div', 'hud-family') };
}

test('挂载后有家谱入口与一个默认关闭的 dialog', () => {
  const { root, hud } = mount();
  const btn = find(root, 'button', 'hud-family-btn');
  assert.ok(btn, '右上角必须有家谱入口');
  assert.equal(textOf(btn), '家谱');
  const family = find(root, 'div', 'hud-family');
  assert.ok(family, '家谱容器必须一次建好');
  assert.equal(family.attrs.role, 'dialog');
  assert.equal(family.attrs['aria-modal'], 'true');
  assert.ok(!family._class.has('is-open'), '默认必须关着');
  assert.equal(hud.state.familyOpen, false);
  assert.equal(btn.attrs['aria-expanded'], 'false');
});

test('从家谱按钮进入时，焦点落在当前信息卡这只身上', () => {
  const { hud, root } = mount();
  hud.frame(0, WORLD);
  hud.state.card = WORLD.creatures[1];  // 模拟 setCard 之后的状态；本用例只测入口路径
  click(find(root, 'button', 'hud-family-btn'));
  assert.equal(hud.state.familyOpen, true);
  assert.equal(hud.state.familyFocusId, 'c-b');
});

test('打开家谱画出活着的节点、母亲边、悬空根与虚线伙伴边', () => {
  const { doc, hud, root, family } = openWithFocus('c-c');
  assert.equal(hud.state.familyOpen, true);
  assert.ok(family._class.has('is-open'));
  assert.equal(find(root, 'button', 'hud-family-btn').attrs['aria-expanded'], 'true');
  const svg = find(family, 'svg', 'hud-family-tree');
  assert.equal(svg.namespaceURI, SVG_NS, '家谱必须是 SVG，不是 HTMLUnknownElement');
  assert.equal(family.namespaceURI, HTML_NS);
  const nodes = findAll(family, 'g', 'hud-family-node');
  assert.deepEqual(nodes.map((n) => n.dataset.id), ['c-a', 'c-b', 'c-c', 'c-d'],
    '死者不进树，漂入/失母者作为根排在后面');
  for (const n of nodes) assert.equal(n.namespaceURI, SVG_NS);
  const dots = findAll(family, 'circle', 'hud-family-dot');
  assert.equal(dots.length, 4);
  assert.equal(new Set(dots.map((d) => d.attrs.fill)).size, 4, '圆点色相必须来自个体且各不相同');
  const labels = findAll(family, 'text', 'hud-family-label').map((t) => textOf(t));
  assert.deepEqual(labels, ['A', 'B', 'C', '外来者']);
  assert.equal(nodes.filter((n) => n._class.has('is-root')).length, 2, '两个悬空起点');
  assert.equal(nodes.filter((n) => n._class.has('is-focus')).length, 1, '焦点只能有一个');
  assert.equal(nodes.find((n) => n.dataset.id === 'c-c')._class.has('is-focus'), true);
  const edges = findAll(family, 'path', 'hud-family-edge');
  assert.equal(edges.filter((e) => e._class.has('is-mother')).length, 2);
  const pals = edges.filter((e) => e._class.has('is-companion'));
  assert.equal(pals.length, 1, '双向伙伴记忆只能画一条虚线');
  assert.equal(pals[0].attrs['stroke-dasharray'], '4 4');
  assert.ok(textOf(family).includes('同母 = 同胞'), '同胞关系必须有一条可读的图例');
  assert.ok(doc.createdNS.includes('svg') && doc.createdNS.includes('path'));
});

test('点一个节点只改焦点并重画，不关掉家谱', () => {
  const { hud, family } = openWithFocus('c-c');
  const nodeB = findAll(family, 'g', 'hud-family-node').find((n) => n.dataset.id === 'c-b');
  click(nodeB);
  assert.equal(hud.state.familyFocusId, 'c-b');
  const nodes = findAll(family, 'g', 'hud-family-node');
  assert.equal(nodes.find((n) => n.dataset.id === 'c-b')._class.has('is-focus'), true);
  assert.equal(nodes.find((n) => n.dataset.id === 'c-c')._class.has('is-focus'), false);
  assert.ok(family._class.has('is-open'));
});

test('家谱头部有“信息卡”按钮：空缸隐藏，有节点时可用', () => {
  const { hud, root } = mount();
  hud.frame(0, { creatures: [], foods: [], eggs: [], time: 0 });
  hud.setFamilyOpen(true);
  const family = find(root, 'div', 'hud-family');
  const btn = find(family, 'button', 'hud-family-card');
  assert.ok(btn, '家谱头部必须有信息卡入口');
  assert.equal(textOf(btn), '信息卡');
  assert.ok(btn._class.has('is-hidden'), '空缸时按钮必须藏起来，不能是个按了没反应的按钮');

  hud.setFamilyOpen(false);
  hud.frame(1, WORLD);
  hud.setFamilyOpen(true, 'c-b');
  assert.ok(!btn._class.has('is-hidden'), '有节点时必须能按');
});

test('点信息卡把当前焦点个体交给卡并收起家谱，且不写世界', () => {
  const { doc, hud, root, family } = openWithFocus('c-b');
  const before = JSON.stringify(WORLD);
  const card = find(root, 'div', 'hud-card');
  assert.ok(!card._class.has('is-open'), '前置：家谱开着时卡要让位');
  click(find(family, 'button', 'hud-family-card'));
  assert.equal(hud.state.familyOpen, false, '打开信息卡后家谱必须收起');
  assert.ok(!family._class.has('is-open'));
  assert.equal(find(root, 'button', 'hud-family-btn').attrs['aria-expanded'], 'false');
  assert.equal(hud.state.card, WORLD.creatures[1], '卡必须指向当前焦点个体');
  assert.ok(card._class.has('is-open'), '卡必须真的打开');
  assert.ok(textOf(find(card, 'h2', 'hud-card-title')).includes('B'));
  assert.equal(doc.activeElement, card, '键盘焦点必须跟到卡里，不能留在已收起的家谱上');
  assert.equal(JSON.stringify(WORLD), before, '打开卡不许写世界');
});

test('先换焦点再点信息卡，打开的是新焦点；空缸点它什么都不发生', () => {
  const { hud, family } = openWithFocus('c-c');
  const nodeB = findAll(family, 'g', 'hud-family-node').find((n) => n.dataset.id === 'c-b');
  click(nodeB);
  click(find(family, 'button', 'hud-family-card'));
  assert.equal(hud.state.card, WORLD.creatures[1], '换过焦点之后打开的必须是新焦点');

  const empty = mount();
  empty.hud.frame(0, { creatures: [], foods: [], eggs: [], time: 0 });
  empty.hud.setFamilyOpen(true);
  const emptyFamily = find(empty.root, 'div', 'hud-family');
  click(find(emptyFamily, 'button', 'hud-family-card'));
  assert.equal(empty.hud.state.card, null, '空缸不许凭空造一张卡');
  assert.equal(empty.hud.state.familyOpen, true, '空缸点它必须保持原样');
});

test('关闭按钮与 Escape 都能关家谱，且 Escape 监听只在打开期间存在', () => {
  const { doc, hud, family, root } = openWithFocus('c-c');
  assert.equal(doc.docListenerCount('keydown'), 1);
  click(find(family, 'button', 'hud-family-close'));
  assert.equal(hud.state.familyOpen, false);
  assert.ok(!family._class.has('is-open'));
  assert.equal(doc.docListenerCount('keydown'), 0, '关掉后必须摘掉 Escape 监听');

  click(find(root, 'button', 'hud-family-btn'));
  assert.equal(hud.state.familyOpen, true);
  assert.equal(doc.docListenerCount('keydown'), 1);
  doc.emit('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(hud.state.familyOpen, false);
  assert.equal(doc.docListenerCount('keydown'), 0);
});

test('内容不变时 frame 不重建：滚动位置与键盘焦点都保住；数据变化时也恢复', () => {
  const { doc, hud, family } = openWithFocus('c-b');
  const scroll = find(family, 'div', 'hud-family-scroll');
  scroll.scrollTop = 180;
  const nodeB = findAll(family, 'g', 'hud-family-node').find((n) => n.dataset.id === 'c-b');
  nodeB.focus();
  assert.equal(doc.activeElement, nodeB);

  hud.frame(300, WORLD);                    // 同内容刷新：不得清空 SVG
  const sameB = findAll(family, 'g', 'hud-family-node').find((n) => n.dataset.id === 'c-b');
  assert.equal(sameB, nodeB, '同内容刷新不许换掉 <g>（换掉就把键盘位置扔了）');
  assert.equal(scroll.scrollTop, 180, '同内容刷新不许把滚动位置拉回焦点');
  assert.equal(doc.activeElement, nodeB);

  const born = C({ id: 'c-new', name: '新孩子', mother: 'c-a', generation: 2 });
  hud.frame(600, { ...WORLD, creatures: WORLD.creatures.concat([born]) });
  const after = findAll(family, 'g', 'hud-family-node').find((n) => n.dataset.id === 'c-b');
  assert.ok(after, '数据变化后重建，原节点还在');
  assert.notEqual(after, nodeB, '数据真变时必须重建');
  assert.equal(scroll.scrollTop, 180, '重建也不能把滚动位置重置');
  assert.equal(doc.activeElement.dataset.id, 'c-b', '重建后焦点必须回到同一个个体');
});

test('打开家谱先收起信息卡/设置页，关闭后原样恢复', () => {
  const { hud, root } = mount();
  hud.frame(0, WORLD);
  hud.setSettingsOpen(true);
  const card = find(root, 'div', 'hud-card');
  assert.ok(card._class.has('is-open'), '前置条件：设置页已经把卡打开');
  hud.setFamilyOpen(true);
  assert.ok(!card._class.has('is-open'), '家谱盖上来时卡必须让位');
  hud.setFamilyOpen(false);
  assert.ok(card._class.has('is-open'), '关家谱后卡要回来');
  hud.setSettingsOpen(false);
});

test('家谱开着时打开设置，会先退出家谱，避免设置页藏在它下面', () => {
  const { hud, family } = openWithFocus('c-b');
  hud.setSettingsOpen(true);
  assert.equal(hud.state.familyOpen, false);
  assert.equal(hud.state.settingsOpen, true);
  assert.ok(!family._class.has('is-open'));
  hud.setSettingsOpen(false);
});

test('家谱开关和节点点击都不写世界；destroy 摘掉 Escape 监听', () => {
  const { doc, hud } = mount();
  const before = JSON.stringify(WORLD);
  hud.frame(0, WORLD);
  hud.setFamilyOpen(true, 'c-b');
  hud.setFamilyFocus('c-a');
  assert.equal(JSON.stringify(WORLD), before);
  assert.equal(doc.docListenerCount('keydown'), 1);
  hud.destroy();
  assert.equal(doc.docListenerCount('keydown'), 0);
  assert.equal(countListeners(doc.body), 0, 'destroy 之后整棵 HUD 不许留下监听器');
});

test('空缸打开家谱显示空态，不抛也不造幽灵节点', () => {
  const { hud, root } = mount();
  const family = find(root, 'div', 'hud-family');
  hud.frame(0, { creatures: [], foods: [], eggs: [], time: 0 });
  hud.setFamilyOpen(true);
  assert.equal(hud.state.familyOpen, true);
  assert.equal(findAll(family, 'g', 'hud-family-node').length, 0);
  assert.ok(textOf(family).includes('没有活着的个体'));
});

test('frame 刷新家谱以反映出生/死亡，但关闭时不重建', () => {
  const { hud, family } = openWithFocus(null);
  const born = C({ id: 'c-new', name: ' newborn', mother: 'c-a', generation: 2 });
  const next = { ...WORLD, creatures: WORLD.creatures.concat([born]) };
  hud.frame(2000, next);
  assert.equal(findAll(family, 'g', 'hud-family-node').length, 5);
  hud.setFamilyOpen(false);
  const later = { ...next, creatures: next.creatures.slice(0, 2) };
  hud.frame(4000, later);
  assert.equal(findAll(family, 'g', 'hud-family-node').length, 5,
    '关闭时刷新不许花 DOM 成本（保留上一次快照，重开时才重建）');
});
