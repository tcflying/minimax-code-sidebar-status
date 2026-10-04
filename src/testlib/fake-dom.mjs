// mmx-status :: testlib/fake-dom.mjs
//
// A DOM small enough to run the REAL injected code against, and faithful in the
// handful of behaviours the page script actually depends on. It exists because
// source-level regex assertions proved worthless here: a suite of 127 regex
// checks only looks for strings in the source, so emptying the move loop or
// dropping the dot removal from dispose() left every assertion green -- the
// pattern was still there, the behaviour was not. Every new test in this
// directory therefore slices the shipped code out of lib/page-script.mjs and
// runs it.
//
// What is modelled, and why each one matters:
//   - children / firstElementChild / insertBefore / remove: the reorder loop
//     and the summary bar are nothing but reordering.
//   - isConnected: the "to top" click handler refuses to act on a row the host
//     has already unmounted, and dispose() only restores rows still on screen.
//   - textContent aggregates descendants, like the real thing: the truncation
//     button's label lives in a nested <span>.
//   - node.click() dispatches isTrusted=false, exactly like a browser, and the
//     tests have to ask for a trusted click explicitly. Two separate code paths
//     (the pinned-more memory, the new menu item) depend on that difference.
//   - attribute selectors, .class, #id and comma lists: that is all the page
//     script ever asks for.

let nextId = 0;

function parseSimple(sel) {
  // One compound selector: tag#id.class[attr][attr="v"]...
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([.#]?[\w-]+)|(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel)) !== null) {
    const tok = m[0];
    if (tok[0] === '.') out.classes.push(tok.slice(1));
    else if (tok[0] === '#') out.id = tok.slice(1);
    else if (tok[0] === '[') {
      const body = tok.slice(1, -1);
      const mOp = /^([\w-]+)\s*([*^$~]?=)\s*["']?([^\]"']*)["']?$/.exec(body);
      if (!mOp) {
        out.attrs.push([body.trim(), null]);
        continue;
      }
      out.attrs.push([mOp[1], { op: mOp[2], value: mOp[3] }]);
    } else out.tag = tok.toUpperCase();
  }
  return out;
}

function parseSelector(sel) {
  return String(sel)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseSimple);
}

function matchesSimple(node, s) {
  if (node.nodeType !== 1) return false;
  if (s.tag && node.tagName !== s.tag) return false;
  if (s.id && node.getAttribute('id') !== s.id) return false;
  for (const c of s.classes) {
    if (String(node.getAttribute('class') || '').split(/\s+/).indexOf(c) < 0) return false;
  }
  for (const [k, v] of s.attrs) {
    const actual = node.getAttribute(k);
    if (v === null) {
      if (actual === null) return false;
      continue;
    }
    if (actual === null) return false;
    if (v.op === '=' && actual !== v.value) return false;
    if (v.op === '*=' && actual.indexOf(v.value) < 0) return false;
    if (v.op === '^=' && actual.indexOf(v.value) !== 0) return false;
    if (v.op === '$=' && actual.slice(-v.value.length) !== v.value) return false;
    if (v.op === '~=' && actual.split(/\s+/).indexOf(v.value) < 0) return false;
  }
  return true;
}

export function matches(node, sel) {
  return parseSelector(sel).some((s) => matchesSimple(node, s));
}

class FakeNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attrs = {};
    this.style = {};
    this.cssText = '';
    this._text = '';
    this._listeners = new Map();
    this._uid = ++nextId;
  }

  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.childNodes;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  get isConnected() {
    let n = this;
    while (n) {
      if (n.__detached) return false;
      if (n.__isRoot) return true;
      n = n.parentElement;
    }
    return false;
  }
  // className / id are the idom-visible aliases of the class / id attributes;
  // the injected code assigns both directly when it builds a node.
  get className() {
    return String(this.getAttribute('class') || '');
  }
  set className(v) {
    this.setAttribute('class', v);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get textContent() {
    let out = this._text;
    for (const c of this.childNodes) out += c.nodeType === 3 ? c.data : c.textContent;
    return out;
  }
  set textContent(v) {
    for (const c of this.childNodes) c.__detached = true;
    this.childNodes = [];
    this._text = String(v);
    this.__w = (this.__w || 0) + 1;
  }
  get classList() {
    const self = this;
    return {
      contains(c) {
        return String(self.getAttribute('class') || '').split(/\s+/).indexOf(c) >= 0;
      },
    };
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
    // A REAL setAttribute queues a mutation record even when the value is
    // identical, and so does a textContent assignment even when the text is
    // unchanged. Counting only the ones that "changed" would have made a
    // repaint loop look perfectly quiet -- and a repaint loop is exactly what a
    // childList observer on our own subtree turns into.
    this.__w = (this.__w || 0) + 1;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }

  appendChild(c) {
    if (c.parentElement) c.parentElement.removeChild ? c.parentElement.removeChild(c) : c.parentElement.childNodes.splice(c.parentElement.childNodes.indexOf(c), 1);
    c.parentElement = this;
    c.__detached = false;
    this.childNodes.push(c);
    this.__w = (this.__w || 0) + 1;
    return c;
  }
  insertBefore(node, ref) {
    if (ref === node) return node;
    if (node.parentElement) {
      const sibs = node.parentElement.childNodes;
      const at = sibs.indexOf(node);
      if (at >= 0) sibs.splice(at, 1);
    }
    node.parentElement = this;
    node.__detached = false;
    if (!ref) {
      this.childNodes.push(node);
      return node;
    }
    const i = this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentElement = null;
    node.__detached = true;
    this.__w = (this.__w || 0) + 1;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.removeChild(this);
  }

  contains(other) {
    let n = other;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }
  matches(sel) {
    return matches(this, sel);
  }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  descendants() {
    const out = [];
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      out.push(c);
      out.push(...c.descendants());
    }
    return out;
  }
  querySelectorAll(sel) {
    const parts = parseSelector(sel);
    return this.descendants().filter((n) => parts.some((s) => matchesSimple(n, s)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 100, height: 30, right: 100, bottom: 30 };
  }
  getClientRects() {
    // display:none is inherited: a hidden ANCESTOR gives its descendants no
    // client rects, which is the whole reason getClientRects is a visibility
    // test at all. Modelling only the node itself would let a hidden overlay
    // report its own children as visible, and every visibility assertion built
    // on top of it would be measuring the fake instead of the behaviour.
    for (let n = this; n; n = n.parentElement) {
      if (n.__hidden) return [];
    }
    return [this.getBoundingClientRect()];
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type) {
    return (this._listeners.get(type) || []).length;
  }
  // Dispatches with isTrusted=false, like a programmatic el.click().
  click() {
    this.dispatch('click', { isTrusted: false });
  }
  // Propagation, not just delivery: a listener that calls stopPropagation()
  // really does cut the ancestors off. Without this, "we called
  // stopPropagation" was only ever a flag on a spy -- the row's own handler
  // would have fired anyway and the assertion would have passed for a product
  // that had stopped nothing at all.
  dispatch(type, ev = {}) {
    const event = {
      type,
      isTrusted: !!ev.isTrusted,
      target: ev.target || this,
      defaultPrevented: false,
      cancelBubble: false,
      ...ev,
    };
    if (typeof event.stopPropagation !== 'function') {
      event.stopPropagation = function () { this.cancelBubble = true; };
    }
    if (typeof event.preventDefault !== 'function') {
      event.preventDefault = function () { this.defaultPrevented = true; };
    }
    let n = this;
    while (n) {
      for (const fn of (n._listeners.get(type) || []).slice()) fn(event);
      if (event.cancelBubble) break;
      n = n.parentElement;
    }
    return event;
  }
}

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
}

export function makeDom() {
  const root = new FakeNode('body');
  root.__isRoot = true;
  const head = new FakeNode('head');
  root.appendChild(head);
  const document = {
    body: root,
    head,
    createElement: (t) => new FakeNode(t),
    // Namespaced elements: the lock button builds its glyph as real SVG through
    // createElementNS + setAttribute, with no innerHTML anywhere. The namespace
    // itself carries no behaviour we depend on, so the node is the same shape;
    // what matters is that the page uses the NS API and that a test can walk
    // down to the <path>.
    createElementNS: (ns, t) => { const n = new FakeNode(t); n.namespaceURI = ns; return n; },
    createTextNode: (t) => new FakeText(t),
    getElementById(id) {
      return root.descendants().find((n) => n.getAttribute('id') === id) || null;
    },
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  };
  return {
    document,
    root,
    head,
    getElementById: (id) => document.getElementById(id),
    querySelector: (sel) => document.querySelector(sel),
    querySelectorAll: (sel) => document.querySelectorAll(sel),
    FakeNode,
    FakeText,
    el: (t, a, c) => build(t, a, c),
  };
}

function build(tag, attrs = {}, children = []) {
  const n = new FakeNode(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n._text = String(v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? new FakeText(c) : c);
  }
  return n;
}

export { FakeNode as FakeElement };

/**
 * How many DOM writes a node has taken, counting the ones that wrote the value
 * it already had. This is the offline stand-in for a MutationObserver: the real
 * one cannot tell a no-op repaint from a real one either, and that blindness is
 * the property under test.
 */
export function writesOf(node) { return node && node.__w ? node.__w : 0; }

/** Attach a fake React fiber to a node, the way React does with __reactFiber$. */
export function attachFiber(node, fiber) {
  Object.defineProperty(node, '__reactFiber$test', {
    value: fiber,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return fiber;
}

/** Build a linked hook chain out of memoizedState pairs: [[fn,deps], ...]. */
export function hookChain(entries) {
  const nodes = entries.map((ms) => ({ memoizedState: ms, next: null }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].next = nodes[i + 1];
  return nodes.length ? nodes[0] : null;
}

export function fiber({ props = null, hooks = null, parent = null, tag = 0, name = '' } = {}) {
  const f = {
    tag,
    type: name || null,
    memoizedProps: props,
    memoizedState: hooks,
    return: parent,
    alternate: null,
  };
  return f;
}
