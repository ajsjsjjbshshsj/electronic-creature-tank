import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHud } from '../src/hud.js';
import { makeDoc, find, findAll, click, textOf, countListeners } from './dom-stub.js';

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
});

test('打开家谱画出活着的节点、母亲边、悬空根与虚线伙伴边', () => {
  const { hud, family } = openWithFocus('c-c');
  assert.equal(hud.state.familyOpen, true);
  assert.ok(family._class.has('is-open'));
  const nodes = findAll(family, 'g', 'hud-family-node');
  assert.deepEqual(nodes.map((n) => n.dataset.id), ['c-a', 'c-b', 'c-c', 'c-d'],
    '死者不进树，漂入/失母者作为根排在后面');
  assert.equal(findAll(family, 'circle', 'hud-family-dot').length, 4);
  assert.equal(nodes.filter((n) => n._class.has('is-root')).length, 2, '两个悬空起点');
  assert.equal(nodes.filter((n) => n._class.has('is-focus')).length, 1, '焦点只能有一个');
  assert.equal(nodes.find((n) => n.dataset.id === 'c-c')._class.has('is-focus'), true);
  const edges = findAll(family, 'path', 'hud-family-edge');
  assert.equal(edges.filter((e) => e._class.has('is-mother')).length, 2);
  const pals = edges.filter((e) => e._class.has('is-companion'));
  assert.equal(pals.length, 1, '双向伙伴记忆只能画一条虚线');
  assert.equal(pals[0].attrs['stroke-dasharray'], '4 4');
  assert.ok(textOf(family).includes('同母相邻'), '同胞关系必须有一条可读的图例');
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
  assert.ok(textOf(family).includes('还没有个体'));
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
