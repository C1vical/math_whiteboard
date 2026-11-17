import { create, parseDependencies, type MathNode } from 'mathjs';

// Only mathjs's parser is used (a small part of the library). Expressions are evaluated by the
// tree walker below, which knows nothing but numbers, + − × ÷ ^ and the whitelisted functions,
// so nothing a collaborator types can reach any other mathjs function.
const math = create({ parseDependencies }, { number: 'number', predictable: true });

/** A compiled expression: evaluates with the given scope (numbers and the allowed functions). */
interface EvalFunction { evaluate(scope: Record<string, unknown>): number }
type Scope = Record<string, unknown>;
type Eval = (s: Scope) => number;

const OPS: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  pow: (a, b) => Math.pow(a, b),
  mod: (a, b) => (b === 0 ? NaN : a - b * Math.floor(a / b)),
};

/** Node fields read by the compiler (the parts of mathjs's node classes it relies on). */
interface AnyNode {
  type: string; value?: unknown; name?: string; content?: AnyNode; fn?: AnyNode | string; args?: AnyNode[]; op?: string;
}

export type Relation = '=' | '<' | '<=' | '>' | '>=';

export interface CompiledExpr {
  id: string;
  kind: 'fn' | 'vline' | 'point' | 'implicit' | 'empty' | 'error';
  error?: string;
  rel?: Relation;
  /** y = fn(x) (kind 'fn'); NaN outside a domain restriction */
  fn?: (x: number) => number;
  /** x = value (kind 'vline') */
  value?: number;
  point?: [number, number];
  /** F(x, y) = 0 (kind 'implicit'); NaN outside a domain restriction */
  F?: (x: number, y: number) => number;
  /** a domain restriction `{ … }` (vertical lines and points use it directly) */
  mask?: (x: number, y: number) => boolean;
}

export interface GraphOptions {
  /** trig functions take and give degrees instead of radians */
  angle?: 'rad' | 'deg' | null;
}

export interface CompiledGraph {
  items: CompiledExpr[];
  /** free single-letter parameters that need sliders, in first-seen order */
  params: string[];
}

const BUILTIN_FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  sqrt: (x) => (x < 0 ? NaN : Math.sqrt(x)), cbrt: Math.cbrt, abs: Math.abs,
  ln: (x) => (x <= 0 ? NaN : Math.log(x)),
  log: (x) => (x <= 0 ? NaN : Math.log10(x)),
  log10: (x) => (x <= 0 ? NaN : Math.log10(x)),
  log2: (x) => (x <= 0 ? NaN : Math.log2(x)),
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
/** In degree mode the trig functions take degrees and the inverse ones answer in degrees. */
const DEGREE_FUNCS: Record<string, (x: number) => number> = {
  sin: (x) => Math.sin(x * D2R), cos: (x) => Math.cos(x * D2R), tan: (x) => Math.tan(x * D2R),
  sec: (x) => 1 / Math.cos(x * D2R), csc: (x) => 1 / Math.sin(x * D2R), cot: (x) => 1 / Math.tan(x * D2R),
  asin: (x) => Math.asin(x) * R2D, acos: (x) => Math.acos(x) * R2D, atan: (x) => Math.atan(x) * R2D,
  arcsin: (x) => Math.asin(x) * R2D, arccos: (x) => Math.acos(x) * R2D, arctan: (x) => Math.atan(x) * R2D,
};
// exact values where floating point would leave crumbs (sin 180° is 1.2e-16 otherwise)
for (const k of ['sin', 'cos', 'tan'] as const) {
  const f = DEGREE_FUNCS[k];
  DEGREE_FUNCS[k] = (x) => { const v = f(x); return Math.abs(v) < 1e-12 ? 0 : v; };
}
const ALLOWED_NODES = new Set(['ConstantNode', 'SymbolNode', 'OperatorNode', 'FunctionNode', 'ParenthesisNode']);

/** Normalises friendly input: unicode operators, |x| → abs(x). */
export function preprocess(src: string): string {
  let s = src
    .replace(/[−–—]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/')
    .replace(/π/g, 'pi').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/√/g, 'sqrt')
    .replace(/\*\*/g, '^');
  if (s.includes('|')) {
    let out = '';
    let depth = 0;
    let prev = '';
    for (const ch of s) {
      if (ch === '|') {
        const opening = depth === 0 || prev === '' || /[+\-*/^(,=<>|]/.test(prev);
        if (opening && !(prev === '|' && out.endsWith(')'))) { out += 'abs('; depth++; }
        else { out += ')'; depth = Math.max(0, depth - 1); }
      } else out += ch;
      if (ch !== ' ') prev = ch;
    }
    s = out;
  }
  return s;
}

interface Parsed {
  code: EvalFunction;
  symbols: string[]; // free symbols (not constants / known functions)
  calls: string[]; // function names called
}

function parseExpr(src: string, userFuncs: Set<string>): Parsed {
  const root = math.parse(src) as unknown as MathNode & AnyNode;
  const symbols = new Set<string>();
  const calls = new Set<string>();
  let nodes = 0;
  const symbol = (name: string): Eval => {
    if (name in CONSTANTS) { const v = CONSTANTS[name]; return () => v; }
    symbols.add(name);
    return (s) => { const v = s[name]; return typeof v === 'number' ? v : NaN; };
  };
  const compile = (n: AnyNode): Eval => {
    if (++nodes > 2000) throw new Error('Expression is too long');
    if (!ALLOWED_NODES.has(n.type)) throw new Error('Unsupported syntax');
    switch (n.type) {
      case 'ConstantNode': {
        if (typeof n.value !== 'number') throw new Error('Unsupported value');
        const v = n.value;
        return () => v;
      }
      case 'SymbolNode': return symbol(n.name!);
      case 'ParenthesisNode': return compile(n.content!);
      case 'OperatorNode': {
        const args = (n.args ?? []).map(compile);
        const fn = n.fn as string;
        if (args.length === 1 && fn === 'unaryMinus') { const [a] = args; return (s) => -a(s); }
        if (args.length === 1 && fn === 'unaryPlus') return args[0];
        const op = OPS[fn];
        if (!op || args.length !== 2) throw new Error(`"${n.op ?? fn}" is not supported`);
        const [a, b] = args;
        return (s) => op(a(s), b(s));
      }
      case 'FunctionNode': {
        const f = n.fn as AnyNode;
        if (f?.type !== 'SymbolNode') throw new Error('Unsupported syntax');
        const name = f.name!;
        const argNodes = n.args ?? [];
        if (!(name in BUILTIN_FUNCS) && !userFuncs.has(name)) {
          // x(x+1), a(x-2) … are implicit multiplication, not function calls
          if (argNodes.length !== 1) throw new Error(`Unknown function "${name}"`);
          const a = symbol(name), b = compile(argNodes[0]);
          return (s) => a(s) * b(s);
        }
        calls.add(name);
        const args = argNodes.map(compile);
        return (s) => {
          const fn = s[name];
          if (typeof fn !== 'function') return NaN;
          const v = (fn as (...a: number[]) => unknown)(...args.map((a) => a(s)));
          return typeof v === 'number' ? v : NaN;
        };
      }
    }
    throw new Error('Unsupported syntax');
  };
  const run = compile(root);
  return { code: { evaluate: (s) => run(s) }, symbols: [...symbols], calls: [...calls] };
}

function splitRelation(s: string): { lhs: string; rel: Relation; rhs: string } | null {
  const m = /(<=|>=|=<|=>|=|<|>)/.exec(s);
  if (!m) return null;
  const rel = (m[1] === '=<' ? '<=' : m[1] === '=>' ? '>=' : m[1]) as Relation;
  const rhs = s.slice(m.index + m[1].length);
  if (/[=<>]/.test(rhs)) throw new Error('Only one =, < or > is allowed');
  return { lhs: s.slice(0, m.index).trim(), rel, rhs: rhs.trim() };
}

function splitPoint(s: string): [string, string] | null {
  if (!s.startsWith('(') || !s.endsWith(')')) return null;
  let depth = 0, comma = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0 && i < s.length - 1) return null; }
    else if (ch === ',' && depth === 1) { if (comma >= 0) return null; comma = i; }
  }
  if (comma < 0) return null;
  return [s.slice(1, comma).trim(), s.slice(comma + 1, -1).trim()];
}

const flip = (r: Relation): Relation => (r === '<' ? '>' : r === '<=' ? '>=' : r === '>' ? '<' : r === '>=' ? '<=' : '=');
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** Splits a trailing domain restriction off: `y = x^2 {x > 0}` → ['y = x^2', 'x > 0']. */
export function splitRestriction(s: string): { body: string; cond: string | null } {
  const m = /^(.*?)\{([^{}]*)\}\s*$/.exec(s);
  if (!m) {
    if (/[{}]/.test(s)) throw new Error('Put a restriction in braces at the end, like {x > 0}');
    return { body: s, cond: null };
  }
  if (/[{}]/.test(m[1])) throw new Error('Only one restriction in braces is allowed');
  if (!m[2].trim()) throw new Error('The braces are empty');
  return { body: m[1].trim(), cond: m[2].trim() };
}

const REL_SPLIT = /(<=|>=|=<|=>|<|>)/;

/**
 * Compiles a graph's expression list. Never throws: bad input becomes an item of
 * kind 'error' with a human-readable message.
 */
export function compileGraph(exprs: { id: string; text: string }[], sliderValues: Record<string, number> = {}, opts: GraphOptions = {}): CompiledGraph {
  const params: string[] = [];
  const userFuncs = new Set<string>();
  const cleaned = exprs.map((e) => preprocess(e.text).trim());

  // pass 1: collect function-definition names so they can be used anywhere
  const defRe = /^([A-Za-z][A-Za-z0-9]*)\s*\(\s*([A-Za-z])\s*\)\s*=(?!=)/;
  for (const s of cleaned) {
    const m = defRe.exec(s);
    if (m && m[1] !== 'y' && m[1] !== 'x' && !(m[1] in BUILTIN_FUNCS) && !(m[1] in CONSTANTS)) userFuncs.add(m[1]);
  }

  const scope: Record<string, unknown> = { ...CONSTANTS, ...BUILTIN_FUNCS, ...(opts.angle === 'deg' ? DEGREE_FUNCS : {}) };
  const useParams = (symbols: string[], bound: string[]) => {
    for (const sym of symbols) {
      if (bound.includes(sym)) continue;
      if (sym === 'x' || sym === 'y') throw new Error(`"${sym}" is not allowed here`);
      if (sym.length !== 1) throw new Error(`Unknown name "${sym}"`);
      if (!params.includes(sym)) params.push(sym);
      if (!(sym in scope) || typeof scope[sym] !== 'function') scope[sym] = sliderValues[sym] ?? 1;
    }
  };
  const evalWith = (code: EvalFunction, extra: Record<string, number>): number => {
    try { return num(code.evaluate({ ...scope, ...extra })); } catch { return NaN; }
  };

  /** `{ -1 <= x <= 3, y > 0 }` → a test of (x, y). Bounds may use sliders. */
  const compileRestriction = (cond: string): ((x: number, y: number) => boolean) => {
    const tests: ((x: number, y: number) => boolean)[] = [];
    for (const part of cond.split(/[,;]/)) {
      const bits = part.split(REL_SPLIT).map((b) => b.trim());
      if (bits.length < 3 || bits.length % 2 === 0) throw new Error('Write a restriction like {x > 0} or {-1 <= x <= 3}');
      const sides = bits.filter((_, i) => i % 2 === 0).map((b) => {
        if (!b) throw new Error('Incomplete restriction');
        const p = parseExpr(b, userFuncs);
        useParams(p.symbols, ['x', 'y']);
        return p.code;
      });
      for (let i = 1; i < bits.length; i += 2) {
        const op = bits[i] === '=<' ? '<=' : bits[i] === '=>' ? '>=' : bits[i];
        const a = sides[(i - 1) / 2], b = sides[(i + 1) / 2];
        tests.push((x, y) => {
          const va = evalWith(a, { x, y }), vb = evalWith(b, { x, y });
          const tol = 1e-9 * (1 + Math.abs(va) + Math.abs(vb));
          switch (op) {
            case '<': return va < vb;
            case '>': return va > vb;
            case '<=': return va <= vb + tol;
            default: return va >= vb - tol;
          }
        });
      }
    }
    return (x, y) => tests.every((t) => t(x, y));
  };

  // pass 2: definitions first (so later/earlier expressions can call them)
  const defs = new Map<number, { name: string; fn: (x: number) => number }>();
  const errors = new Map<number, string>();
  cleaned.forEach((s, i) => {
    const m = defRe.exec(s);
    if (!m || !userFuncs.has(m[1])) return;
    try {
      const body = s.slice(m[0].length).trim();
      if (!body) throw new Error('Missing right-hand side');
      if (/[{}]/.test(body)) throw new Error('Restrict where it is drawn instead: y = f(x) {x > 0}');
      const parsed = parseExpr(body, userFuncs);
      useParams(parsed.symbols, [m[2]]);
      let depth = 0;
      const fn = (v: number): number => {
        if (depth > 40) return NaN;
        depth++;
        try { return evalWith(parsed.code, { [m[2]]: v }); } finally { depth--; }
      };
      scope[m[1]] = fn;
      defs.set(i, { name: m[1], fn });
    } catch (err) {
      errors.set(i, (err as Error).message);
    }
  });

  const items: CompiledExpr[] = cleaned.map((src, i): CompiledExpr => {
    const id = exprs[i].id;
    if (!src) return { id, kind: 'empty' };
    if (errors.has(i)) return { id, kind: 'error', error: errors.get(i) };
    const def = defs.get(i);
    if (def) return { id, kind: 'fn', rel: '=', fn: def.fn };
    try {
      const { body: s, cond } = splitRestriction(src);
      if (!s) throw new Error('Incomplete expression');
      const mask = cond ? compileRestriction(cond) : undefined;
      const pt = splitPoint(s);
      if (pt && !/[=<>]/.test(s)) {
        const a = parseExpr(pt[0], userFuncs), b = parseExpr(pt[1], userFuncs);
        useParams(a.symbols, []); useParams(b.symbols, []);
        const p: [number, number] = [evalWith(a.code, {}), evalWith(b.code, {})];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('Point is not a number');
        return { id, kind: 'point', point: p, mask };
      }
      let rel: Relation = '=';
      let body = s;
      let vertical = false;
      const parts = splitRelation(s);
      if (parts) {
        if (!parts.lhs || !parts.rhs) throw new Error('Incomplete expression');
        if (parts.lhs === 'y') { rel = parts.rel; body = parts.rhs; }
        else if (parts.rhs === 'y') { rel = flip(parts.rel); body = parts.lhs; }
        else if (parts.lhs === 'x') { rel = parts.rel; body = parts.rhs; vertical = true; }
        else if (parts.rhs === 'x') { rel = flip(parts.rel); body = parts.lhs; vertical = true; }
        else {
          // an implicit relation such as x^2 + y^2 = 25, drawn by contouring F(x, y) = 0
          const l = parseExpr(parts.lhs, userFuncs), r = parseExpr(parts.rhs, userFuncs);
          const syms = [...l.symbols, ...r.symbols];
          if (!syms.includes('x') && !syms.includes('y')) throw new Error('There is no x or y in this');
          if (parts.rel !== '=') throw new Error('For shading, put y alone on one side: y > …');
          useParams(l.symbols, ['x', 'y']); useParams(r.symbols, ['x', 'y']);
          const F = (x: number, y: number) => evalWith(l.code, { x, y }) - evalWith(r.code, { x, y });
          return { id, kind: 'implicit', rel: '=', F: mask ? (x, y) => (mask(x, y) ? F(x, y) : NaN) : F, mask };
        }
      }
      const parsed = parseExpr(body, userFuncs);
      if (vertical) {
        useParams(parsed.symbols, []);
        const value = evalWith(parsed.code, {});
        if (!Number.isFinite(value)) throw new Error('x = … must be a number');
        return { id, kind: 'vline', rel, value, mask };
      }
      useParams(parsed.symbols, ['x']);
      const f = (x: number) => evalWith(parsed.code, { x });
      return { id, kind: 'fn', rel, fn: mask ? (x) => { const y = f(x); return mask(x, y) ? y : NaN; } : f, mask };
    } catch (err) {
      const msg = (err as Error).message || 'Invalid expression';
      return { id, kind: 'error', error: msg.length > 80 ? 'Invalid expression' : msg };
    }
  });

  return { items, params };
}

// ---------- sampling ----------

/**
 * Samples y = f(x) into polylines (flat x,y arrays in graph coordinates).
 * Paths are broken at domain gaps and at discontinuities/asymptotes, so tan(x)
 * or 1/x never get a vertical connecting line.
 */
export function sampleFunction(f: (x: number) => number, xMin: number, xMax: number, yMin: number, yMax: number, n = 400): number[][] {
  const paths: number[][] = [];
  if (!(xMax > xMin) || !(yMax > yMin)) return paths;
  const yRange = yMax - yMin;
  const lo = yMin - yRange * 4, hi = yMax + yRange * 4;
  const clamp = (y: number) => (y < lo ? lo : y > hi ? hi : y);
  const ok = (y: number) => Number.isFinite(y);
  const dx = (xMax - xMin) / n;
  let cur: number[] = [];
  const end = () => { if (cur.length >= 4) paths.push(cur); cur = []; };

  // last finite x between a defined point and an undefined one
  const domainEdge = (xOk: number, xBad: number): [number, number] => {
    let yOk = f(xOk);
    for (let k = 0; k < 24; k++) {
      const xm = (xOk + xBad) / 2, ym = f(xm);
      if (ok(ym)) { xOk = xm; yOk = ym; } else xBad = xm;
    }
    return [xOk, yOk];
  };

  /** true when f jumps (or blows up) somewhere inside [x1, x2] */
  const findBreak = (x1: number, y1: number, x2: number, y2: number): [number, number, number, number] | null => {
    const jump0 = Math.abs(y2 - y1);
    if (jump0 < yRange / 60) return null;
    let a = x1, ya = y1, b = x2, yb = y2;
    for (let k = 0; k < 16; k++) {
      const m = (a + b) / 2, ym = f(m);
      if (!ok(ym)) return [a, ya, b, yb];
      if (Math.abs(ym - ya) >= Math.abs(yb - ym)) { b = m; yb = ym; } else { a = m; ya = ym; }
    }
    // a continuous function's change shrinks with the interval; a jump's does not
    return Math.abs(yb - ya) > jump0 * 0.25 ? [a, ya, b, yb] : null;
  };

  const refine = (x1: number, y1: number, x2: number, y2: number, depth: number) => {
    if (depth > 0) {
      const xm = (x1 + x2) / 2, ym = f(xm);
      if (ok(ym)) {
        const visible = Math.max(y1, y2, ym) >= yMin - yRange && Math.min(y1, y2, ym) <= yMax + yRange;
        if (visible && Math.abs(ym - (y1 + y2) / 2) > yRange / 700) {
          refine(x1, y1, xm, ym, depth - 1);
          refine(xm, ym, x2, y2, depth - 1);
          return;
        }
      }
    }
    cur.push(x2, clamp(y2));
  };

  let px = xMin, py = f(px);
  if (ok(py)) cur.push(px, clamp(py));
  for (let i = 1; i <= n; i++) {
    const x = i === n ? xMax : xMin + i * dx;
    const y = f(x);
    if (ok(py) && ok(y)) {
      const br = findBreak(px, py, x, y);
      if (br) {
        // run each branch right up to the break, then start a new path
        if (br[0] > px) cur.push(br[0], clamp(br[1]));
        end();
        if (br[2] < x) cur.push(br[2], clamp(br[3]));
        cur.push(x, clamp(y));
      } else refine(px, py, x, y, 5);
    } else if (ok(py) && !ok(y)) {
      const [ex, ey] = domainEdge(px, x);
      if (ex !== px) cur.push(ex, clamp(ey));
      end();
    } else if (!ok(py) && ok(y)) {
      end();
      const [ex, ey] = domainEdge(x, px);
      if (ex !== x) cur.push(ex, clamp(ey));
      cur.push(x, clamp(y));
    }
    px = x; py = y;
  }
  end();
  return paths;
}

export { formatTick, niceStep } from './ticks';

/** y-window that fits the visible curves over [xMin, xMax]; null when nothing to fit. */
export function fitYRange(compiled: CompiledGraph, visible: Set<string>, xMin: number, xMax: number): [number, number] | null {
  const ys: number[] = [];
  for (const it of compiled.items) {
    if (!visible.has(it.id)) continue;
    if (it.kind === 'fn' && it.fn) {
      for (let i = 0; i <= 300; i++) {
        const y = it.fn(xMin + ((xMax - xMin) * i) / 300);
        if (Number.isFinite(y)) ys.push(y);
      }
    } else if (it.kind === 'point' && it.point) ys.push(it.point[1]);
  }
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  // trim extreme outliers (asymptotes) so one blow-up does not flatten everything
  const trim = ys.length > 50 ? Math.floor(ys.length * 0.03) : 0;
  let lo = ys[trim], hi = ys[ys.length - 1 - trim];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

export const DEFAULT_SLIDER = { min: -10, max: 10, step: 0.1, value: 1 };

// ---------- animated sliders ----------

/** One sweep from min to max takes this long; the play button bounces back and forth. */
export const SLIDER_SWEEP_MS = 4000;

export interface SliderPlay { t0: number; v0: number; dir: 1 | -1 }

/**
 * A slider's value at time `now` (server clock). A playing slider is a pure function of time,
 * so every screen shows the same value without a stream of updates.
 */
export function sliderValueAt(sl: { min: number; max: number; value: number; step?: number; play?: SliderPlay | null }, now: number): number {
  const p = sl.play;
  const span = sl.max - sl.min;
  if (!p || !(span > 0)) return sl.value;
  const start = Math.max(0, Math.min(1, (p.v0 - sl.min) / span));
  const s = start + (p.dir * Math.max(0, now - p.t0)) / SLIDER_SWEEP_MS;
  const u = ((s % 2) + 2) % 2;
  return sl.min + (u <= 1 ? u : 2 - u) * span;
}

/** Direction a playing slider is moving at `now` (for pausing and resuming where it was). */
export function sliderDirAt(sl: { min: number; max: number; step?: number; play?: SliderPlay | null }, now: number): 1 | -1 {
  const p = sl.play;
  const span = sl.max - sl.min;
  if (!p || !(span > 0)) return 1;
  const start = Math.max(0, Math.min(1, (p.v0 - sl.min) / span));
  const s = start + (p.dir * Math.max(0, now - p.t0)) / SLIDER_SWEEP_MS;
  return ((s % 2) + 2) % 2 <= 1 ? 1 : -1;
}

// ---------- implicit relations: contouring ----------

/**
 * Traces F(x, y) = 0 over the window with marching squares and returns polylines
 * (flat x,y arrays). A sign change through a pole (F jumps from +big to −big, as across
 * x = 0 in 1/x = y) is not a crossing and is dropped, so no stray segments appear.
 */
export function contourImplicit(F: (x: number, y: number) => number, xMin: number, xMax: number, yMin: number, yMax: number, nx = 160, ny = 120): number[][] {
  if (!(xMax > xMin) || !(yMax > yMin)) return [];
  nx = Math.max(4, Math.min(600, Math.round(nx)));
  ny = Math.max(4, Math.min(600, Math.round(ny)));
  const dx = (xMax - xMin) / nx, dy = (yMax - yMin) / ny;
  const v = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    let f: number;
    try { f = F(xMin + i * dx, yMin + j * dy); } catch { f = NaN; }
    v[j * (nx + 1) + i] = Number.isFinite(f) ? f : NaN;
  }
  const at = (i: number, j: number) => v[j * (nx + 1) + i];

  // a crossing on the edge between two grid points, or null when there is none (or it is a pole)
  const crossings = new Map<string, [number, number] | null>();
  const crossing = (key: string, x1: number, y1: number, a: number, x2: number, y2: number, b: number): [number, number] | null => {
    let c = crossings.get(key);
    if (c !== undefined) return c;
    c = null;
    // 0 counts as positive, so a curve through a grid point gives each cell 0, 2 or 4 crossings
    if (Number.isFinite(a) && Number.isFinite(b) && (a < 0) !== (b < 0)) {
      // Bisect along the edge. At a true root the values on both sides shrink towards 0; across a
      // pole (or a jump) they stay large or become undefined, and that is not a crossing.
      let lo = 0, hi = 1, flo = a, fhi = b;
      for (let k = 0; k < 30; k++) {
        const m = (lo + hi) / 2;
        let fm: number;
        try { fm = F(x1 + (x2 - x1) * m, y1 + (y2 - y1) * m); } catch { fm = NaN; }
        if (!Number.isFinite(fm)) { flo = NaN; break; }
        if ((fm < 0) === (flo < 0)) { lo = m; flo = fm; } else { hi = m; fhi = fm; }
      }
      if (Number.isFinite(flo) && Math.max(Math.abs(flo), Math.abs(fhi)) <= 1e-6 * (1 + Math.max(Math.abs(a), Math.abs(b)))) {
        const t = (lo + hi) / 2;
        c = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      }
    }
    crossings.set(key, c);
    return c;
  };

  // segments keyed by the cell edges they join, so they can be chained into polylines
  const segs: { a: string; b: string; pa: [number, number]; pb: [number, number] }[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x0 = xMin + i * dx, x1 = x0 + dx, y0 = yMin + j * dy, y1 = y0 + dy;
    const f00 = at(i, j), f10 = at(i + 1, j), f01 = at(i, j + 1), f11 = at(i + 1, j + 1);
    if (!(Number.isFinite(f00) && Number.isFinite(f10) && Number.isFinite(f01) && Number.isFinite(f11))) continue;
    const pts: { k: string; p: [number, number] }[] = [];
    const e = (k: string, p: [number, number] | null) => { if (p) pts.push({ k, p }); };
    e(`h${i},${j}`, crossing(`h${i},${j}`, x0, y0, f00, x1, y0, f10));
    e(`v${i + 1},${j}`, crossing(`v${i + 1},${j}`, x1, y0, f10, x1, y1, f11));
    e(`h${i},${j + 1}`, crossing(`h${i},${j + 1}`, x0, y1, f01, x1, y1, f11));
    e(`v${i},${j}`, crossing(`v${i},${j}`, x0, y0, f00, x0, y1, f01));
    if (pts.length === 2) segs.push({ a: pts[0].k, b: pts[1].k, pa: pts[0].p, pb: pts[1].p });
    else if (pts.length === 4) {
      // saddle: the value at the centre decides which corners are connected
      let c: number;
      try { c = F(x0 + dx / 2, y0 + dy / 2); } catch { c = NaN; }
      const sameAs00 = Number.isFinite(c) && (c < 0) === (f00 < 0);
      const [b0, r, t, l] = pts;
      if (sameAs00) { segs.push({ a: b0.k, b: r.k, pa: b0.p, pb: r.p }); segs.push({ a: t.k, b: l.k, pa: t.p, pb: l.p }); }
      else { segs.push({ a: b0.k, b: l.k, pa: b0.p, pb: l.p }); segs.push({ a: r.k, b: t.k, pa: r.p, pb: t.p }); }
    }
  }

  // chain segments that share an edge crossing
  const byKey = new Map<string, number[]>();
  segs.forEach((g, n) => {
    for (const k of [g.a, g.b]) { const l = byKey.get(k); if (l) l.push(n); else byKey.set(k, [n]); }
  });
  const used = new Uint8Array(segs.length);
  const out: number[][] = [];
  const walk = (from: string, line: number[], front: boolean) => {
    let key = from;
    for (;;) {
      const next = (byKey.get(key) ?? []).find((n) => !used[n]);
      if (next === undefined) return;
      used[next] = 1;
      const g = segs[next];
      const [k, p] = g.a === key ? [g.b, g.pb] : [g.a, g.pa];
      if (front) line.unshift(p[0], p[1]); else line.push(p[0], p[1]);
      key = k;
    }
  };
  segs.forEach((g, n) => {
    if (used[n]) return;
    used[n] = 1;
    const line = [g.pa[0], g.pa[1], g.pb[0], g.pb[1]];
    walk(g.b, line, false);
    walk(g.a, line, true);
    out.push(line);
  });
  return out;
}

// ---------- points of interest ----------

export type PoiKind = 'xint' | 'yint' | 'turn' | 'cross';
export interface Poi { x: number; y: number; kind: PoiKind }

const MAX_POIS = 80;

/** Roots of g on [a, b]: sign changes on a grid, refined by bisection; jumps are not roots. */
export function findRoots(g: (x: number) => number, a: number, b: number, n = 600): number[] {
  const out: number[] = [];
  if (!(b > a)) return out;
  const h = (b - a) / n;
  let px = a, py = g(a);
  for (let i = 1; i <= n; i++) {
    const x = i === n ? b : a + i * h, y = g(x);
    if (Number.isFinite(py) && Number.isFinite(y)) {
      if (py === 0) out.push(px);
      else if ((py < 0) !== (y < 0) && y !== 0) {
        let lo = px, hi = x, flo = py;
        for (let k = 0; k < 64; k++) {
          const m = (lo + hi) / 2, fm = g(m);
          if (!Number.isFinite(fm)) { lo = NaN; break; }
          if ((fm < 0) === (flo < 0)) { lo = m; flo = fm; } else hi = m;
        }
        const r = (lo + hi) / 2, fr = g(r);
        // across an asymptote the values near the "root" are huge, not zero
        if (Number.isFinite(r) && Number.isFinite(fr) && Math.abs(fr) <= 1e-6 * (1 + Math.abs(py) + Math.abs(y))) out.push(r);
      }
    }
    px = x; py = y;
  }
  if (Number.isFinite(py) && py === 0 && out[out.length - 1] !== px) out.push(px);
  return out;
}

/** Local maxima and minima of f on [a, b]. */
export function findTurningPoints(f: (x: number) => number, a: number, b: number, n = 600): [number, number][] {
  const out: [number, number][] = [];
  if (!(b > a)) return out;
  const h = (b - a) / n;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= n; i++) { xs.push(i === n ? b : a + i * h); ys.push(f(xs[i])); }
  for (let i = 1; i < n; i++) {
    const y0 = ys[i - 1], y1 = ys[i], y2 = ys[i + 1];
    if (!(Number.isFinite(y0) && Number.isFinite(y1) && Number.isFinite(y2))) continue;
    const max = y1 > y0 && y1 >= y2, min = y1 < y0 && y1 <= y2;
    if (!max && !min) continue;
    if (y1 === y2) continue; // a plateau is not a turning point
    // golden-section search inside [x(i-1), x(i+1)]
    const sign = max ? -1 : 1;
    let lo = xs[i - 1], hi = xs[i + 1];
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    let fc = sign * f(c), fd = sign * f(d);
    for (let k = 0; k < 60; k++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = sign * f(c); }
      else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = sign * f(d); }
    }
    const x = (lo + hi) / 2, y = f(x);
    // a sharp corner from a jump (e.g. floor) is not a turning point: the neighbours must be close
    const scale = Math.abs(y0 - y1) + Math.abs(y2 - y1);
    if (Number.isFinite(y) && Math.abs(y - y1) <= scale + 1e-9) out.push([x, y]);
  }
  return out;
}

/**
 * x- and y-intercepts, turning points and intersections of the visible curves inside the
 * window. Display only: nothing here becomes part of the board.
 */
export function findPOIs(compiled: CompiledGraph, visible: Set<string>, xMin: number, xMax: number, yMin: number, yMax: number): Poi[] {
  if (!(xMax > xMin) || !(yMax > yMin)) return [];
  const out: Poi[] = [];
  const inWin = (x: number, y: number) => x >= xMin && x <= xMax && y >= yMin && y <= yMax;
  const add = (x: number, y: number, kind: PoiKind) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !inWin(x, y)) return;
    const ex = (xMax - xMin) * 1e-4, ey = (yMax - yMin) * 1e-4;
    if (Math.abs(x) < ex * 1e-3) x = 0;
    if (Math.abs(y) < ey * 1e-3) y = 0;
    if (out.some((p) => Math.abs(p.x - x) < ex && Math.abs(p.y - y) < ey)) return;
    out.push({ x, y, kind });
  };
  const items = compiled.items.filter((it) => visible.has(it.id));
  const fns = items.filter((it) => it.kind === 'fn' && it.fn).map((it) => it.fn!);
  const vlines = items.filter((it) => it.kind === 'vline' && it.value !== undefined);
  const implicits = items.filter((it) => it.kind === 'implicit' && it.F).map((it) => it.F!);
  const yTol = (yMax - yMin) * 1e-9;

  for (const f of fns) {
    if (xMin <= 0 && xMax >= 0) add(0, f(0), 'yint');
    for (const r of findRoots(f, xMin, xMax)) add(r, 0, 'xint');
    for (const [x, y] of findTurningPoints(f, xMin, xMax)) add(x, y, Math.abs(y) <= yTol ? 'xint' : 'turn');
  }
  for (let i = 0; i < fns.length; i++) for (let j = i + 1; j < fns.length; j++) {
    const f = fns[i], g = fns[j];
    for (const r of findRoots((x) => f(x) - g(x), xMin, xMax)) add(r, f(r), 'cross');
  }
  for (const vl of vlines) {
    const c = vl.value!;
    if (!vl.mask || vl.mask(c, 0)) add(c, 0, 'xint');
    for (const f of fns) add(c, f(c), 'cross');
  }
  for (const F of implicits) {
    for (const r of findRoots((x) => F(x, 0), xMin, xMax)) add(r, 0, 'xint');
    for (const r of findRoots((y) => F(0, y), yMin, yMax)) add(0, r, 'yint');
    for (const f of fns) for (const r of findRoots((x) => F(x, f(x)), xMin, xMax)) add(r, f(r), 'cross');
  }
  // the most useful ones first if there are too many to show
  const rank: Record<PoiKind, number> = { cross: 0, xint: 1, yint: 1, turn: 2 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return out.slice(0, MAX_POIS);
}

/**
 * The point on a visible curve nearest to (gx, gy), within the tolerances (graph units),
 * or null. Used when the selected graph is tapped.
 */
export function nearestCurvePoint(compiled: CompiledGraph, visible: Set<string>, gx: number, gy: number, tolX: number, tolY: number, implicitPaths?: Map<string, number[][]>): { x: number; y: number; id: string } | null {
  let best: { x: number; y: number; id: string; d: number } | null = null;
  const consider = (x: number, y: number, id: string) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const d = Math.hypot((x - gx) / tolX, (y - gy) / tolY);
    if (d <= 1 && (!best || d < best.d)) best = { x, y, id, d };
  };
  for (const it of compiled.items) {
    if (!visible.has(it.id)) continue;
    if (it.kind === 'fn' && it.fn) {
      for (let k = -40; k <= 40; k++) { const x = gx + (k / 40) * tolX; consider(x, it.fn(x), it.id); }
      // settle on the closest x exactly
      const b = best as { x: number; id: string } | null;
      if (b && b.id === it.id) {
        let lo = b.x - tolX / 40, hi = b.x + tolX / 40;
        const dist = (x: number) => Math.hypot((x - gx) / tolX, (it.fn!(x) - gy) / tolY);
        for (let k = 0; k < 40; k++) {
          const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
          if (dist(m1) < dist(m2)) hi = m2; else lo = m1;
        }
        consider((lo + hi) / 2, it.fn((lo + hi) / 2), it.id);
      }
    } else if (it.kind === 'vline' && it.value !== undefined) {
      if (!it.mask || it.mask(it.value, gy)) consider(it.value, gy, it.id);
    } else if (it.kind === 'point' && it.point) {
      consider(it.point[0], it.point[1], it.id);
    } else if (it.kind === 'implicit') {
      for (const path of implicitPaths?.get(it.id) ?? []) {
        for (let i = 2; i < path.length; i += 2) {
          const ax = path[i - 2], ay = path[i - 1], bx = path[i], by = path[i + 1];
          // closest point on the segment, in tolerance-scaled space
          const ux = (bx - ax) / tolX, uy = (by - ay) / tolY;
          const l2 = ux * ux + uy * uy;
          let t = l2 ? (((gx - ax) / tolX) * ux + ((gy - ay) / tolY) * uy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          consider(ax + (bx - ax) * t, ay + (by - ay) * t, it.id);
        }
      }
    }
  }
  return best ? { x: (best as { x: number }).x, y: (best as { y: number }).y, id: (best as { id: string }).id } : null;
}

/** Coordinates for a label: up to 3 decimals, no trailing zeros, −0 shown as 0. */
export function formatCoord(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r).replace('-', '−');
}
