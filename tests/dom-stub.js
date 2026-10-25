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

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * style 的桩。**故意**让"直接写一个 `--x` 键"与 `setProperty('--x', v)` 走两条路：
 * 真 DOM 里只有后者进得了层叠，前者只是在 JS 对象上挂个幽灵属性（F-14 就是这么静默的）。
 * 所以判据必须读 getPropertyValue —— 写错方式的话它拿到空串，红。
 */
function makeStyle() {
  const vars = {};
  return {
    _vars: vars,
    setProperty(k, v) { vars[k] = String(v); },
    getPropertyValue(k) { return Object.hasOwn(vars, k) ? vars[k] : ''; },
    removeProperty(k) { const old = vars[k]; delete vars[k]; return old === undefined ? '' : old; },
  };
}

export function makeNode(tag, doc, ns) {
  // 子节点的真身。对外只经 `children` 这个**只读**视图暴露 ——
  // 真 DOM 的 `children` 是活的 HTMLCollection，`node.children.length = 0` 在严格模式里
  // 抛 TypeError；而本文件原先直接放一个普通数组出去，于是 hud.js 里那句话"成功"了，
  // 真页面一点开信息卡就炸（清单 §12 的 F-13）。桩不许替平台撒谎。
  const kids = [];
  const namespaceURI = ns || HTML_NS;
  const isSvg = namespaceURI === SVG_NS;
  const node = {
    tagName: String(tag).toUpperCase(),
    namespaceURI,
    get children() { return Object.freeze(kids.slice()); },
    parent: null,
    attrs: {},
    style: makeStyle(),
    dataset: {},
    _text: '',
    _class: new Set(),
    listeners: {},
    _value: '',
    appendChild(child) { child.parent = node; kids.push(child); return child; },
    removeChild(child) {
      const i = kids.indexOf(child);
      if (i >= 0) kids.splice(i, 1);
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
    setAttribute(k, v) {
      // 真 DOM 里 `class` 属性与 className / classList 是同一份东西，桩必须同步，
      // 否则 SVG 那条只能走 setAttribute('class', …) 的路就找不到节点了。
      if (k === 'class') { node._class = new Set(String(v).split(/\s+/).filter(Boolean)); return; }
      node.attrs[k] = String(v);
    },
    getAttribute(k) {
      if (k === 'class') return node._class.size ? [...node._class].join(' ') : null;
      return Object.hasOwn(node.attrs, k) ? node.attrs[k] : null;
    },
    removeAttribute(k) {
      if (k === 'class') { node._class.clear(); return; }
      delete node.attrs[k];
    },
    focus() { doc.__focused = node; },
    blur() { if (doc.__focused === node) doc.__focused = null; },
    get value() { return node._value; },
    set value(v) { node._value = v == null ? '' : String(v); },
    get className() { return [...node._class].join(' '); },
    set className(v) {
      if (isSvg) {
        // 真 DOM：SVGElement.className 是**只读**的 SVGAnimatedString，严格模式里赋值抛错。
        // 走 setAttribute('class', …) 那条路 —— 而这条只在真浏览器里才通，正是 F-15 的后半。
        throw new TypeError(
          'SVGElement.className 是只读的（真 DOM 同）：SVG 元素请用 setAttribute("class", …)');
      }
      node._class = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    get textContent() { return node._text; },
    set textContent(v) { node._text = v == null ? '' : String(v); kids.length = 0; },
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
    created: [], createdNS: [], body: null, __focused: null,
    // 文档级监听器要**记得住**：拖拽投食那套临时监听（pointermove / pointerup /
    // pointercancel 挂在 doc 上）唯一的证据就是"挂了几次、摘了几次"，
    // 空实现会让"泄漏一个监听器"这件事在测试里彻底隐形。
    listeners: {},
    // 用 `this` 而不是闭包里的 `doc`：真 DOM 的方法脱离接收者调用会抛
    // "Illegal invocation"，写成闭包捕获就等于又替平台撒一次谎（§12.11 那一族）。
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = this.listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    emit(type, ev) { for (const fn of (doc.listeners[type] || []).slice()) fn(ev); },
    docListenerCount(type) { return (doc.listeners[type] || []).length; },
    // 真文档有它；main.js 的"松手时手指底下是不是缸"就靠它。默认谁都不命中，
    // 需要命中的测试自己改 __hitAt（与 __focused 同一个路子）。
    elementFromPoint(x, y) { return doc.__hitAt ? doc.__hitAt(x, y) : null; },
    __hitAt: null,
    createElement(tag) { const n = makeNode(tag, doc); doc.created.push(n.tagName); return n; },
    // 真 DOM 里 SVG 只能这么造：`createElement('svg')` 给的是 HTMLUnknownElement（F-15）。
    createElementNS(ns, tag) {
      const n = makeNode(tag, doc, ns);
      doc.created.push(n.tagName);
      doc.createdNS.push(tag);
      return n;
    },
    createTextNode(t) {
      return { tagName: '#text', children: [], attrs: {}, style: {}, dataset: {},
        _class: new Set(), listeners: {}, _text: String(t) };
    },
    getElementById(id) { return doc.__byId[id] || null; },
    __byId: {},
  };
  Object.defineProperty(doc, 'activeElement', {
    get() { return doc.__focused || doc.body; },
  });
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
  // style 那边只摊 `_vars`（setProperty 写进去的那些）与直接挂上去的自有键；
  // 方法本身不许进字符串 —— 搜"有没有泄漏某个串"时函数源码是噪音。
  const styleBits = [];
  const st = node.style || {};
  for (const k of Object.keys(st._vars || {})) styleBits.push(k, st._vars[k]);
  for (const k of Object.keys(st)) {
    if (k === '_vars' || typeof st[k] === 'function') continue;
    styleBits.push(k, st[k]);
  }
  const bits = [node.tagName, node.className, node._text, node._value, styleBits.join(' ')];
  for (const k of Object.keys(node.attrs || {})) bits.push(k, node.attrs[k]);
  for (const k of Object.keys(node.dataset || {})) bits.push(k, node.dataset[k]);
  for (const c of node.children || []) bits.push(dump(c));
  return bits.join(' ');
}

/** 点一下：只派发给这个节点自己（本桩不做冒泡，HUD 的按钮都是直接绑的）。 */
export function click(node) {
  for (const fn of (node.listeners.click || []).slice()) fn({ preventDefault() {}, target: node });
}

/** 派发任意事件类型（拖拽那一路要 pointerdown / pointermove / pointerup / pointercancel）。 */
export function fire(node, type, ev) {
  const e = Object.assign({ preventDefault() {}, target: node, type }, ev || {});
  for (const fn of (node.listeners[type] || []).slice()) fn(e);
  return e;
}

/** 数整棵树上的监听器总数：destroy() 之后必须是 0。 */
export function countListeners(node) {
  let n = 0;
  for (const k of Object.keys(node.listeners || {})) n += node.listeners[k].length;
  for (const c of node.children || []) n += countListeners(c);
  return n;
}
