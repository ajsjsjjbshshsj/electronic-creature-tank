// family.js —— 家谱的纯视图模型与布局。
//
// 只读 world：节点只含**当前还活着**的个体。内核 reapDead 会把死者移出 creatures，
// 所以跨代祖先不可恢复；母亲不在缸里时，这一支诚实地画成悬空起点，不连向幽灵节点。
// 同胞由"同一个活着的母亲"表达；伙伴边只消费已有 memory.role === 'companion' 记录，
// 本函数不发明新的社交判定，也不写世界。

const ROW_GAP = 44;
const INDENT_X = 34;
const PAD = 18;
const LABEL_WIDTH = 116;
const DOT_RADIUS = 5;
const MAX_LABEL_CHARS = 9;

const text = (v) => (typeof v === 'string' && v.length > 0 ? v : '');
const finite = (v) => (typeof v === 'number' && Number.isFinite(v));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nodeKey = (n) => `${n.name}\u0000${n.id}`;
const alive = (c) => c && c.alive !== false && c.stage !== 'dead';

function truncateLabel(name) {
  const chars = Array.from(name);
  if (chars.length <= MAX_LABEL_CHARS) return name;
  return `${chars.slice(0, MAX_LABEL_CHARS - 1).join('')}…`;
}

export function familyModelFor(world, focusId) {
  const creatures = ((world && world.creatures) || []).filter(alive);
  const byId = new Map();
  for (const c of creatures) byId.set(c.id, c);

  const nodes = creatures.map((c) => {
    const mother = c.lineage && c.lineage.mother;
    const motherId = mother && mother !== c.id && byId.has(mother) ? mother : null;
    return {
      id: c.id,
      name: text(c.name) || c.id,
      hue: c.traits && finite(c.traits.hue) ? c.traits.hue : 330,
      generation: finite(c.generation) ? c.generation : 1,
      stage: text(c.stage),
      motherId,
      depth: 0,
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    if (!n.motherId) continue;
    if (!children.has(n.motherId)) children.set(n.motherId, []);
    children.get(n.motherId).push(n);
  }
  for (const group of children.values()) group.sort((a, b) => byText(nodeKey(a), nodeKey(b)));

  const roots = nodes.filter((n) => !n.motherId)
    .sort((a, b) => byText(nodeKey(a), nodeKey(b)));
  const ordered = [];
  const placed = new Set();
  const stack = new Set();
  const visit = (n, depth) => {
    if (placed.has(n.id)) return;
    n.depth = depth;
    placed.add(n.id);
    stack.add(n.id);
    ordered.push(n);
    for (const child of children.get(n.id) || []) {
      if (!stack.has(child.id)) visit(child, depth + 1);
    }
    stack.delete(n.id);
  };
  for (const root of roots) visit(root, 0);
  // 环状/残缺数据里可能没有根：把剩下的按确定顺序补成根，绝不递归死循环。
  for (const n of nodes.slice().sort((a, b) => byText(nodeKey(a), nodeKey(b)))) {
    if (!placed.has(n.id)) visit(n, 0);
  }

  const siblingGroups = [];
  for (const [motherId, group] of children) {
    if (group.length < 2) continue;
    siblingGroups.push({
      motherId,
      ids: group.map((n) => n.id).sort(byText),
    });
  }
  siblingGroups.sort((a, b) => byText(a.motherId, b.motherId));

  const edges = [];
  for (const n of nodes) {
    if (n.motherId) edges.push({ from: n.motherId, to: n.id, kind: 'mother' });
  }
  edges.sort((a, b) => byText(`${a.from}\u0000${a.to}`, `${b.from}\u0000${b.to}`));

  const seenPals = new Set();
  for (const c of creatures) {
    const entries = (c.memory && Array.isArray(c.memory.entries)) ? c.memory.entries : [];
    for (const e of entries) {
      if (!e || e.role !== 'companion' || !byId.has(e.id) || e.id === c.id) continue;
      const pair = [c.id, e.id].sort(byText);
      const key = `${pair[0]}\u0000${pair[1]}`;
      if (seenPals.has(key)) continue;
      seenPals.add(key);
      edges.push({ from: pair[0], to: pair[1], kind: 'companion' });
    }
  }
  edges.sort((a, b) => byText(
    `${a.kind}\u0000${a.from}\u0000${a.to}`,
    `${b.kind}\u0000${b.from}\u0000${b.to}`,
  ));

  return {
    nodes: ordered,
    edges,
    roots,
    siblingGroups,
    focusId: focusId && nodeById.has(focusId) ? focusId : null,
  };
}

export function layoutFamily(model) {
  const nodes = model.nodes.map((n, i) => ({
    id: n.id,
    name: n.name,
    label: truncateLabel(n.name),
    hue: n.hue,
    depth: n.depth,
    x: PAD + n.depth * INDENT_X,
    y: PAD + i * ROW_GAP + ROW_GAP / 2,
    r: DOT_RADIUS,
    isFocus: model.focusId === n.id,
    isRoot: n.motherId === null,
  }));
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const edges = model.edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return null;
    if (e.kind === 'mother') {
      const branchX = a.x + INDENT_X * 0.5;
      return {
        from: e.from,
        to: e.to,
        kind: e.kind,
        dashed: false,
        d: `M ${a.x + a.r} ${a.y} H ${branchX} V ${b.y} H ${b.x - b.r}`,
      };
    }
    const bend = Math.max(20, INDENT_X);
    return {
      from: e.from,
      to: e.to,
      kind: e.kind,
      dashed: true,
      d: `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`,
    };
  }).filter(Boolean);

  let maxDepth = 0;
  for (const n of nodes) maxDepth = Math.max(maxDepth, n.depth);
  const width = Math.max(220, PAD * 2 + maxDepth * INDENT_X + LABEL_WIDTH);
  const height = Math.max(ROW_GAP + PAD * 2, PAD * 2 + Math.max(1, nodes.length) * ROW_GAP);
  return {
    nodes,
    edges,
    width,
    height,
    focusId: model.focusId,
    focusY: model.focusId && pos.has(model.focusId) ? pos.get(model.focusId).y : 0,
  };
}
