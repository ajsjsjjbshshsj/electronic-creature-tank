import test from 'node:test';
import assert from 'node:assert/strict';
import { familyModelFor, layoutFamily } from '../src/family.js';

// 家谱只画**当前活着**的个体：内核 reapDead 会把死者移出 world，
// 跨代祖先不可恢复。这里钉的是"给定现在这缸，能诚实地画出什么"。

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
const W = (creatures) => ({ creatures });

const fixture = () => W([
  C({ id: 'c-c', name: 'C', mother: 'c-a', generation: 2, hue: 340,
    entries: [{ id: 'c-b', role: 'companion' }] }),
  C({ id: 'c-e', name: 'E', mother: 'gone', generation: 2, hue: 350 }),
  C({ id: 'c-a', name: 'A', offspring: ['c-b', 'c-c'], generation: 1, hue: 320 }),
  C({ id: 'c-d', name: 'D', mother: 'c-b', generation: 3, hue: 345 }),
  C({ id: 'c-b', name: 'B', mother: 'c-a', generation: 2, hue: 330,
    entries: [{ id: 'c-c', role: 'companion' }] }),
  C({ id: 'c-dead', name: '死者', mother: 'c-a', alive: false, stage: 'dead' }),
]);

test('家谱模型只含活着的个体，母亲缺失/已死时该节点成为悬空起点', () => {
  const world = fixture();
  const model = familyModelFor(world, 'c-c');
  assert.deepEqual(model.nodes.map((n) => n.id), ['c-a', 'c-b', 'c-d', 'c-c', 'c-e'],
    '顺序必须是根→子树的可复现 DFS，且死者不进图');
  assert.deepEqual(model.roots.map((n) => n.id), ['c-a', 'c-e']);
  const e = model.nodes.find((n) => n.id === 'c-e');
  assert.equal(e.motherId, null, '母亲已不在缸里 ⇒ 只保留悬空起点，不连向幽灵节点');
  const dead = model.nodes.find((n) => n.id === 'c-dead');
  assert.equal(dead, undefined, '死者不许留在树上');
  assert.equal(model.focusId, 'c-c');
});

test('深度沿活着的母亲链计算，兄弟节点共享同一个母节点与同胞组', () => {
  const model = familyModelFor(fixture(), null);
  const depth = Object.fromEntries(model.nodes.map((n) => [n.id, n.depth]));
  assert.deepEqual(depth, { 'c-a': 0, 'c-b': 1, 'c-d': 2, 'c-c': 1, 'c-e': 0 });
  assert.deepEqual(model.siblingGroups, [
    { motherId: 'c-a', ids: ['c-b', 'c-c'] },
  ], '同母的 B/C 是一组同胞；D 是 B 的孩子，不是 A 的直接孩子');
  assert.equal(model.focusId, null, '没给 focus 或 focus 不在缸里时不许伪造高亮');
  assert.equal(familyModelFor(fixture(), 'missing').focusId, null);
});

test('伙伴边只消费已有 role=companion 记录：双向记录合并成一条，死者不连', () => {
  const model = familyModelFor(fixture(), null);
  const pals = model.edges.filter((e) => e.kind === 'companion');
  assert.deepEqual(pals, [{ from: 'c-b', to: 'c-c', kind: 'companion' }],
    '双向的同伴记忆必须去重成一条无向边');
  const mothers = model.edges.filter((e) => e.kind === 'mother');
  assert.deepEqual(mothers, [
    { from: 'c-a', to: 'c-b', kind: 'mother' },
    { from: 'c-a', to: 'c-c', kind: 'mother' },
    { from: 'c-b', to: 'c-d', kind: 'mother' },
  ]);
});

test('自指/环状母亲关系不递归死循环，仍会被放到一个悬空根上', () => {
  const cycle = W([C({ id: 'c-loop', name: 'Loop', mother: 'c-loop' })]);
  const model = familyModelFor(cycle, 'c-loop');
  assert.equal(model.nodes.length, 1);
  assert.equal(model.nodes[0].depth, 0);
  assert.deepEqual(model.roots.map((n) => n.id), ['c-loop']);

  const two = W([
    C({ id: 'c-a', name: 'A', mother: 'c-b' }),
    C({ id: 'c-b', name: 'B', mother: 'c-a' }),
  ]);
  const pair = familyModelFor(two, null);
  assert.equal(pair.nodes.length, 2);
  assert.deepEqual(pair.nodes.map((n) => n.depth), [0, 1]);
});

test('家谱模型不写世界：同一份 world 生成前后逐字节相同', () => {
  const world = fixture();
  const before = JSON.stringify(world);
  familyModelFor(world, 'c-c');
  assert.equal(JSON.stringify(world), before);
});

test('名字里的编号按数值排序：泡泡·2 在 泡泡·10 之前', () => {
  const world = W([
    C({ id: 'c-10', name: '泡泡·10' }),
    C({ id: 'c-2', name: '泡泡·2' }),
    C({ id: 'c-1', name: '泡泡' }),
  ]);
  assert.deepEqual(familyModelFor(world, null).nodes.map((n) => n.name),
    ['泡泡', '泡泡·2', '泡泡·10']);
});

test('超长自定义名在布局里截到 9 字，并保留全名另存', () => {
  const long = '这是一个特别特别长的自定义名字';
  const layout = layoutFamily(familyModelFor(W([C({ id: 'c-long', name: long })]), 'c-long'));
  const n = layout.nodes[0];
  assert.equal(Array.from(n.label).length, 9);
  assert.ok(n.label.endsWith('…'));
  assert.equal(n.name, long, '全名仍留给 SVG title / aria-label');
});

test('布局把代际排成横向缩进、行按 DFS 稳定排列，边有有限坐标', () => {
  const model = familyModelFor(fixture(), 'c-c');
  const layout = layoutFamily(model);
  assert.equal(layout.nodes.length, 5);
  assert.ok(layout.width > 0 && layout.height > 0);
  const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
  for (const n of layout.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
    assert.ok(n.label.length <= 9, `标签必须截断到 9 字：${n.label}`);
  }
  assert.ok(byId['c-a'].y < byId['c-b'].y, '母亲行必须在孩子之前');
  assert.ok(byId['c-a'].x < byId['c-b'].x, '每深一代向右缩进');
  assert.ok(byId['c-b'].x < byId['c-d'].x);
  assert.equal(byId['c-c'].isFocus, true);
  const motherEdge = layout.edges.find((e) => e.kind === 'mother');
  assert.ok(/^M /.test(motherEdge.d), '亲代边必须有可绘制的路径');
  const pal = layout.edges.find((e) => e.kind === 'companion');
  assert.equal(pal.dashed, true, '伙伴边必须是虚线');
});

test('极深的家谱也被限制在可滚动宽度内，不产生 NaN 或负数尺寸', () => {
  const chain = [];
  for (let i = 0; i < 24; i++) {
    chain.push(C({
      id: `c-${i}`, name: `第${i}代`, generation: i + 1,
      mother: i === 0 ? null : `c-${i - 1}`,
    }));
  }
  const layout = layoutFamily(familyModelFor(W(chain), 'c-23'));
  for (const n of layout.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
    assert.ok(n.x >= 0 && n.y >= 0);
  }
  assert.ok(layout.width > 0 && layout.height > 0);
  assert.ok(layout.width < 1000, `24 代深链的布局宽度失控：${layout.width}`);
});

test('布局是纯函数：同一模型两次调用逐字段相同', () => {
  const model = familyModelFor(fixture(), 'c-c');
  assert.deepEqual(layoutFamily(model), layoutFamily(model));
});
