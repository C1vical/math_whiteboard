import { all, create, type EvalFunction, type MathNode } from 'mathjs';

const math = create(all, { predictable: true });

export type Relation = '=' | '<' | '<=' | '>' | '>=';

export interface CompiledExpr {
  id: string;
  kind: 'fn' | 'vline' | 'point' | 'empty' | 'error';
  error?: string;
  rel?: Relation;
  /** y = fn(x) (kind 'fn') */
  fn?: (x: number) => number;
  /** x = value (kind 'vline') */
  value?: number;
  point?: [number, number];
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
  let node: MathNode = math.parse(src);
  // x(x+1), a(x-2) … are implicit multiplication, not function calls
  node = node.transform((n: MathNode) => {
    const fnNode = n as unknown as { isFunctionNode?: boolean; fn?: { isSymbolNode?: boolean; name?: string }; args?: MathNode[] };
    if (fnNode.isFunctionNode && fnNode.fn?.isSymbolNode && fnNode.args?.length === 1) {
      const name = fnNode.fn.name!;
      if (!(name in BUILTIN_FUNCS) && !userFuncs.has(name)) {
        return new math.OperatorNode('*', 'multiply', [new math.SymbolNode(name), fnNode.args[0]], true);
      }
    }
    return n;
  });
  const symbols = new Set<string>();
  const calls = new Set<string>();
  node.traverse((n: MathNode, _path: string, parent: MathNode) => {
    if (!ALLOWED_NODES.has(n.type)) throw new Error('Unsupported syntax');
    if (n.type === 'SymbolNode') {
      const name = (n as unknown as { name: string }).name;
      const p = parent as unknown as { isFunctionNode?: boolean; fn?: unknown } | null;
      if (p && p.isFunctionNode && p.fn === n) {
        if (!(name in BUILTIN_FUNCS) && !userFuncs.has(name)) throw new Error(`Unknown function "${name}"`);
        calls.add(name);
      } else if (!(name in CONSTANTS)) symbols.add(name);
    }
    if (n.type === 'ConstantNode' && typeof (n as unknown as { value: unknown }).value !== 'number') throw new Error('Unsupported value');
  });
  return { code: node.compile(), symbols: [...symbols], calls: [...calls] };
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

/**
 * Compiles a graph's expression list. Never throws: bad input becomes an item of
 * kind 'error' with a human-readable message.
 */
export function compileGraph(exprs: { id: string; text: string }[], sliderValues: Record<string, number> = {}): CompiledGraph {
  const params: string[] = [];
  const userFuncs = new Set<string>();
  const cleaned = exprs.map((e) => preprocess(e.text).trim());

  // pass 1: collect function-definition names so they can be used anywhere
  const defRe = /^([A-Za-z][A-Za-z0-9]*)\s*\(\s*([A-Za-z])\s*\)\s*=(?!=)/;
  for (const s of cleaned) {
    const m = defRe.exec(s);
    if (m && m[1] !== 'y' && m[1] !== 'x' && !(m[1] in BUILTIN_FUNCS) && !(m[1] in CONSTANTS)) userFuncs.add(m[1]);
  }

  const scope: Record<string, unknown> = { ...CONSTANTS, ...BUILTIN_FUNCS };
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

  // pass 2: definitions first (so later/earlier expressions can call them)
  const defs = new Map<number, { name: string; fn: (x: number) => number }>();
  const errors = new Map<number, string>();
  cleaned.forEach((s, i) => {
    const m = defRe.exec(s);
    if (!m || !userFuncs.has(m[1])) return;
    try {
      const body = s.slice(m[0].length).trim();
      if (!body) throw new Error('Missing right-hand side');
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

  const items: CompiledExpr[] = cleaned.map((s, i): CompiledExpr => {
    const id = exprs[i].id;
    if (!s) return { id, kind: 'empty' };
    if (errors.has(i)) return { id, kind: 'error', error: errors.get(i) };
    const def = defs.get(i);
    if (def) return { id, kind: 'fn', rel: '=', fn: def.fn };
    try {
      const pt = splitPoint(s);
      if (pt && !/[=<>]/.test(s)) {
        const a = parseExpr(pt[0], userFuncs), b = parseExpr(pt[1], userFuncs);
        useParams(a.symbols, []); useParams(b.symbols, []);
        const p: [number, number] = [evalWith(a.code, {}), evalWith(b.code, {})];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('Point is not a number');
        return { id, kind: 'point', point: p };
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
        else throw new Error('Use y = …, x = …, f(x) = … or a point (a, b)');
      }
      const parsed = parseExpr(body, userFuncs);
      if (vertical) {
        useParams(parsed.symbols, []);
        const value = evalWith(parsed.code, {});
        if (!Number.isFinite(value)) throw new Error('x = … must be a number');
        return { id, kind: 'vline', rel, value };
      }
      useParams(parsed.symbols, ['x']);
      return { id, kind: 'fn', rel, fn: (x: number) => evalWith(parsed.code, { x }) };
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

/** A "nice" step (1, 2 or 5 × 10^k) giving roughly `target` divisions over `range`. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

export function formatTick(v: number, step: number): string {
  if (Math.abs(v) < step / 1e6) return '0';
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

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
