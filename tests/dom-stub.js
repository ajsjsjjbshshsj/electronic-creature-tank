// 够小的 DOM 节点桩。计划 3 Task 4。
//
// **故意不做**的：布局、样式计算、事件冒泡、选择器引擎、属性 diff。
// 有了那些就变成"在 Node 里重写一个浏览器"，而本文件要测的只有三件事：
//   ① HUD 建了哪些节点、挂在谁下面；
//   ② 节点上写的是**什么字**（§13.2 第 4 条那条边界最终落在字上）；
//   ③ 按下去调了谁的什么。
//
// 为什么不复用现有四个渲染测试里那份 ctx 桩：那是"只数调用次数"的桩，
// DOM 这边要的是**树**（要能在里面找节点、读文本）。它们测的不是同一种东西。
// 现有那四份各抄一份的历史不在本文件的账上 —— 那是渲染层的，动它属于另一次改动。

export function makeNode(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    attrs: {},
    style: {},
    dataset: {},
    _text: '',
    _class: new Set(),
    listeners: {},
    _value: '',
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parent = null;
      return child;
    },
    remove() { if (node.parent) node.parent.removeChild(node); },
    addEventListener(type, fn) { (node.listeners[type] || (node.listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = node.listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(node.attrs, k) ? node.attrs[k] : null; },
    focus() { doc.__focused = node; },
    blur() { if (doc.__focused === node) doc.__focused = null; },
    get value() { return node._value; },
    set value(v) { node._value = v == null ? '' : String(v); },
    get className() { return [...node._class].join(' '); },
    set className(v) { node._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return node._text; },
    set textContent(v) { node._text = v == null ? '' : String(v); node.children.length = 0; },
  };
  node.classList = {
    add: (...c) => c.forEach((x) => node._class.add(x)),
    remove: (...c) => c.forEach((x) => node._class.delete(x)),
    toggle: (c, on) => {
      const want = on === undefined ? !node._class.has(c) : !!on;
      if (want) node._class.add(c); else node._class.delete(c);
      return want;
    },
    contains: (c) => node._class.has(c),
  };
  return node;
}

export function makeDoc() {
  const doc = {
    created: [], body: null, __focused: null,
    createElement(tag) { const n = makeNode(tag, doc); doc.created.push(n.tagName); return n; },
    createTextNode(t) {
      return { tagName: '#text', children: [], attrs: {}, style: {}, dataset: {},
        _class: new Set(), listeners: {}, _text: String(t) };
    },
    getElementById(id) { return doc.__byId[id] || null; },
    addEventListener() {}, removeEventListener() {},
    __byId: {},
  };
  doc.body = makeNode('body', doc);
  return doc;
}

/** 深度优先找第一个"标签名对、且（可选）class 含 want"的节点。 */
export function find(node, tagName, want) {
  const tag = String(tagName).toUpperCase();
  for (const c of node.children || []) {
    if (c.tagName === tag && (!want || c._class.has(want))) return c;
    const deep = find(c, tagName, want);
    if (deep) return deep;
  }
  return null;
}

export function findAll(node, tagName, want, out = []) {
  const tag = String(tagName).toUpperCase();
  for (const c of node.children || []) {
    if (c.tagName === tag && (!want || c._class.has(want))) out.push(c);
    findAll(c, tagName, want, out);
  }
  return out;
}

/** 整棵子树的文字（含 input 的 value）。 */
export function textOf(node) {
  let s = node._text || '';
  if (typeof node._value === 'string') s += node._value;
  for (const c of node.children || []) s += textOf(c);
  return s;
}

/**
 * 整棵子树的可序列化内容：标签 + class + 属性 + style + dataset + 文字 + value。
 * 搜"有没有泄漏某个串"必须用它而不是 textOf —— key 泄漏最可能的形状是被写进
 * `value` 属性或某个 `data-*`，那都不在 textContent 里。
 */
export function dump(node) {
  const bits = [node.tagName, node.className, node._text, node._value];
  for (const k of Object.keys(node.attrs || {})) bits.push(k, node.attrs[k]);
  for (const k of Object.keys(node.style || {})) bits.push(k, node.style[k]);
  for (const k of Object.keys(node.dataset || {})) bits.push(k, node.dataset[k]);
  for (const c of node.children || []) bits.push(dump(c));
  return bits.join(' ');
}

/** 点一下：只派发给这个节点自己（本桩不做冒泡，HUD 的按钮都是直接绑的）。 */
export function click(node) {
  for (const fn of (node.listeners.click || []).slice()) fn({ preventDefault() {}, target: node });
}

/** 数整棵树上的监听器总数：destroy() 之后必须是 0。 */
export function countListeners(node) {
  let n = 0;
  for (const k of Object.keys(node.listeners || {})) n += node.listeners[k].length;
  for (const c of node.children || []) n += countListeners(c);
  return n;
}
