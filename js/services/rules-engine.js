/**
 * A small evaluator for Firebase Realtime Database Security Rules.
 *
 * Why it exists: in demo mode (no Firebase) the application still enforces the
 * exact rules file that production uses, so permission tests done in the demo
 * are tests of the real rules. It is also used by the automated test suite.
 *
 * Supported: .read / .write / .validate, $wildcards, auth, now, root, data,
 * newData, child(), parent(), val(), exists(), hasChild(), hasChildren(),
 * isString(), isNumber(), isBoolean(), string helpers (length, contains,
 * beginsWith, endsWith, replace, toLowerCase, toUpperCase, matches(/re/)),
 * operators (=== !== == != < <= > >= && || ! + - * / %) and the ?: operator.
 * Any runtime type error makes the rule evaluate to false, as in Firebase.
 */

/* ------------------------------------------------------------------ tree helpers */
export const splitPath = (p) => String(p).split('/').filter(Boolean);
const isObj = (v) => v !== null && typeof v === 'object';

export function getIn(root, parts) {
  let cur = root;
  for (const k of parts) {
    if (!isObj(cur) || !(k in cur)) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

/** Remove nulls / empty objects (Firebase never stores them). */
export function clean(v) {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, c] of Object.entries(v)) {
    const cc = clean(c);
    if (cc !== null) out[k] = cc;
  }
  return Object.keys(out).length ? out : null;
}

/** Immutable set: returns a new root sharing untouched branches. */
export function setIn(root, parts, value) {
  if (!parts.length) return value;
  const [k, ...rest] = parts;
  const base = isObj(root) ? root : {};
  const child = setIn(base[k] ?? null, rest, value);
  const out = { ...base };
  if (child === null) delete out[k]; else out[k] = child;
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ snapshots */
class Snap {
  constructor(root, parts) { this.r = root; this.p = parts; }
  val() { return getIn(this.r, this.p); }
  child(path) {
    if (typeof path !== 'string') throw new TypeError('child() needs a string');
    return new Snap(this.r, this.p.concat(splitPath(path)));
  }
  parent() {
    if (!this.p.length) throw new TypeError('root has no parent');
    return new Snap(this.r, this.p.slice(0, -1));
  }
  exists() { return this.val() !== null; }
  hasChild(path) { return this.child(path).exists(); }
  hasChildren(list) {
    const v = this.val();
    if (!isObj(v)) return false;
    if (list === undefined) return Object.keys(v).length > 0;
    return list.every((k) => this.child(k).exists());
  }
  isString() { return typeof this.val() === 'string'; }
  isNumber() { return typeof this.val() === 'number'; }
  isBoolean() { return typeof this.val() === 'boolean'; }
}

/* ------------------------------------------------------------------ expression parser */
const OPS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '-', '*', '/', '%', '(', ')', '[', ']', '.', ',', '?', ':'];

function tokenize(src) {
  const out = [];
  let i = 0;
  const operandExpected = () => {
    const t = out[out.length - 1];
    return !t || (t.t === 'op' && t.v !== ')' && t.v !== ']');
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { j++; } s += src[j]; j++; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    if (c === '/' && operandExpected()) {
      let j = i + 1, body = '', inClass = false;
      while (j < src.length && (src[j] !== '/' || inClass)) {
        if (src[j] === '\\') { body += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        body += src[j]; j++;
      }
      j++; let flags = '';
      while (j < src.length && /[a-z]/.test(src[j])) { flags += src[j]; j++; }
      out.push({ t: 're', v: new RegExp(body, flags) }); i = j; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new SyntaxError(`Unexpected "${c}" at ${i} in rule: ${src}`);
    out.push({ t: 'op', v: op }); i += op.length;
  }
  return out;
}

const BIN = { '||': 1, '&&': 2, '===': 3, '!==': 3, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parse(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const eat = (v) => { if (!isOp(v)) throw new SyntaxError(`Expected "${v}" in rule: ${src}`); pos++; };

  function primary() {
    const t = toks[pos++];
    if (!t) throw new SyntaxError(`Unexpected end of rule: ${src}`);
    if (t.t === 'num' || t.t === 'str' || t.t === 're') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'var', n: t.v };
    }
    if (t.t === 'op' && t.v === '(') { const e = ternary(); eat(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      while (!isOp(']')) { items.push(ternary()); if (isOp(',')) pos++; }
      eat(']');
      return { k: 'arr', items };
    }
    throw new SyntaxError(`Unexpected token "${t.v}" in rule: ${src}`);
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (isOp('.')) {
        pos++;
        const name = toks[pos++].v;
        if (isOp('(')) {
          pos++;
          const args = [];
          while (!isOp(')')) { args.push(ternary()); if (isOp(',')) pos++; }
          eat(')');
          e = { k: 'call', o: e, n: name, args };
        } else e = { k: 'prop', o: e, n: name };
      } else if (isOp('[')) {
        pos++; const idx = ternary(); eat(']');
        e = { k: 'idx', o: e, i: idx };
      } else return e;
    }
  }
  function unary() {
    if (isOp('!')) { pos++; return { k: 'not', e: unary() }; }
    if (isOp('-')) { pos++; return { k: 'neg', e: unary() }; }
    return postfix();
  }
  function binary(minPrec) {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = t && t.t === 'op' ? BIN[t.v] : undefined;
      if (!prec || prec < minPrec) return left;
      pos++;
      const right = binary(prec + 1);
      left = { k: 'bin', op: t.v, l: left, r: right };
    }
  }
  function ternary() {
    const c = binary(1);
    if (!isOp('?')) return c;
    pos++; const a = ternary(); eat(':'); const b = ternary();
    return { k: 'tern', c, a, b };
  }
  const ast = ternary();
  if (pos < toks.length) throw new SyntaxError(`Unexpected "${toks[pos].v}" in rule: ${src}`);
  return ast;
}

/* ------------------------------------------------------------------ evaluator */
const num = (v) => { if (typeof v !== 'number') throw new TypeError('number expected'); return v; };
const STR_METHODS = {
  contains: (s, a) => s.includes(a), beginsWith: (s, a) => s.startsWith(a), endsWith: (s, a) => s.endsWith(a),
  replace: (s, a, b) => s.split(a).join(b), toLowerCase: (s) => s.toLowerCase(), toUpperCase: (s) => s.toUpperCase(),
  matches: (s, re) => re.test(s),
};

function ev(n, ctx) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'arr': return n.items.map((x) => ev(x, ctx));
    case 'var':
      if (!(n.n in ctx)) throw new ReferenceError(`unknown variable ${n.n}`);
      return ctx[n.n];
    case 'not': return !ev(n.e, ctx);
    case 'neg': return -num(ev(n.e, ctx));
    case 'tern': return ev(n.c, ctx) ? ev(n.a, ctx) : ev(n.b, ctx);
    case 'prop': {
      const o = ev(n.o, ctx);
      if (o === null || o === undefined) throw new TypeError(`property ${n.n} of null`);
      if (typeof o === 'string' && n.n === 'length') return o.length;
      const v = o[n.n];
      return v === undefined ? null : v;
    }
    case 'idx': {
      const o = ev(n.o, ctx);
      if (o === null || o === undefined) throw new TypeError('index of null');
      const v = o[ev(n.i, ctx)];
      return v === undefined ? null : v;
    }
    case 'call': {
      const o = ev(n.o, ctx);
      const args = n.args.map((a) => ev(a, ctx));
      if (o instanceof Snap) {
        if (typeof o[n.n] !== 'function') throw new TypeError(`no method ${n.n}`);
        return o[n.n](...args);
      }
      if (typeof o === 'string' && STR_METHODS[n.n]) return STR_METHODS[n.n](o, ...args);
      throw new TypeError(`cannot call ${n.n}`);
    }
    case 'bin': {
      if (n.op === '&&') return ev(n.l, ctx) && ev(n.r, ctx);
      if (n.op === '||') return ev(n.l, ctx) || ev(n.r, ctx);
      const l = ev(n.l, ctx), r = ev(n.r, ctx);
      switch (n.op) {
        case '===': case '==': return l === r;
        case '!==': case '!=': return l !== r;
        case '+':
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          return num(l) + num(r);
        case '-': return num(l) - num(r);
        case '*': return num(l) * num(r);
        case '/': return num(l) / num(r);
        case '%': return num(l) % num(r);
        default: {
          if (typeof l !== typeof r || (typeof l !== 'number' && typeof l !== 'string')) throw new TypeError('cannot compare');
          return n.op === '<' ? l < r : n.op === '<=' ? l <= r : n.op === '>' ? l > r : l >= r;
        }
      }
    }
    default: throw new Error('bad node');
  }
}

const cache = new Map();
function evaluate(expr, ctx) {
  if (expr === true || expr === false) return expr;
  let ast = cache.get(expr);
  if (!ast) { ast = parse(expr); cache.set(expr, ast); }
  try { return ev(ast, ctx) === true; } catch { return false; }
}

/** Parse every expression once; throws on a syntax error (used as a rules linter). */
export function lintRules(node, path = '') {
  let count = 0;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('.')) { if (typeof v === 'string') { parse(v); count++; } } else count += lintRules(v, `${path}/${k}`);
  }
  return count;
}

/* ------------------------------------------------------------------ rule evaluation */
function childRule(node, key, vars) {
  if (!node) return null;
  if (Object.prototype.hasOwnProperty.call(node, key) && !key.startsWith('.') && !key.startsWith('$')) return node[key];
  const wild = Object.keys(node).find((k) => k.startsWith('$'));
  if (wild) { vars[wild] = key; return node[wild]; }
  return null;
}

export class RulesEngine {
  constructor(rulesJson) { this.rules = rulesJson.rules || rulesJson; }

  canRead(root, auth, path, now = Date.now()) {
    const parts = splitPath(path);
    let node = this.rules;
    const vars = {};
    for (let i = 0; i <= parts.length; i++) {
      if (!node) return false;
      if (node['.read'] !== undefined) {
        const ctx = { auth, now, root: new Snap(root, []), data: new Snap(root, parts.slice(0, i)), ...vars };
        if (evaluate(node['.read'], ctx)) return true;
      }
      if (i < parts.length) node = childRule(node, parts[i], vars);
    }
    return false;
  }

  /**
   * Check an atomic multi-path update. `updates` is { '/a/b': value|null }.
   * Returns { ok: true, root } with the new tree, or { ok: false, path, reason }.
   */
  checkUpdate(root, auth, updates, now = Date.now()) {
    let next = root;
    const entries = Object.entries(updates).map(([p, v]) => [splitPath(p), clean(v)]);
    for (const [parts, v] of entries) next = setIn(next, parts, v);
    const rootSnap = new Snap(root, []);
    for (const [parts] of entries) {
      const chain = [{ node: this.rules, vars: {} }];
      for (const key of parts) {
        const last = chain[chain.length - 1];
        const vars = { ...last.vars };
        chain.push({ node: childRule(last.node, key, vars), vars });
      }
      const ctxAt = (i) => ({ auth, now, root: rootSnap, data: new Snap(root, parts.slice(0, i)), newData: new Snap(next, parts.slice(0, i)), ...chain[i].vars });
      // .write — any rule from the root down to the written path may grant it
      let granted = false;
      for (let i = 0; i < chain.length && !granted; i++) {
        const n = chain[i].node;
        if (n && n['.write'] !== undefined && evaluate(n['.write'], ctxAt(i))) granted = true;
      }
      if (!granted) return { ok: false, path: '/' + parts.join('/'), reason: 'write denied' };
      // .validate — every ancestor that still exists, the node itself and all written descendants
      for (let i = 0; i < chain.length; i++) {
        const n = chain[i].node;
        if (!n || n['.validate'] === undefined) continue;
        const ctx = ctxAt(i);
        if (!ctx.newData.exists()) continue;
        if (!evaluate(n['.validate'], ctx)) return { ok: false, path: '/' + parts.slice(0, i).join('/'), reason: 'validation failed', rule: n['.validate'] };
      }
      const last = chain[chain.length - 1];
      const bad = this._validateBelow(last.node, last.vars, root, next, parts, auth, now, rootSnap);
      if (bad) return { ok: false, ...bad };
    }
    return { ok: true, root: next };
  }

  _validateBelow(node, vars, root, next, parts, auth, now, rootSnap) {
    const value = getIn(next, parts);
    if (!node || !isObj(value)) return null;
    for (const key of Object.keys(value)) {
      const v2 = { ...vars };
      const child = childRule(node, key, v2);
      if (!child) continue;
      const p2 = parts.concat(key);
      if (child['.validate'] !== undefined) {
        const ctx = { auth, now, root: rootSnap, data: new Snap(root, p2), newData: new Snap(next, p2), ...v2 };
        if (!evaluate(child['.validate'], ctx)) return { path: '/' + p2.join('/'), reason: 'validation failed', rule: child['.validate'] };
      }
      const bad = this._validateBelow(child, v2, root, next, p2, auth, now, rootSnap);
      if (bad) return bad;
    }
    return null;
  }
}
