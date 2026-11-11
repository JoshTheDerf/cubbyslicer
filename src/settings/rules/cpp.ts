/**
 * A tiny evaluator for the C++ conditions in Orca's toggle code
 * (`config->opt_int("wall_loops") > 0 && !is_belt_printer`), so the rules
 * run from the extracted source text instead of a hand translation.
 *
 * Supported: config reads on `$self` / `$printer` / `$project` (opt_bool,
 * opt_int, opt_float, opt_string, opt_enum, *_nullable, has, option(k)
 * ->value / get_abs_value / get_at / size), enum constants, locals, helper
 * calls, `[](T p) { return …; }` lambdas, ! && || == != < <= > >= ?:, unary
 * minus, numbers and strings. Anything else throws a CppError, which the
 * rules test turns into "port this by hand".
 */
import type { ConfigValue } from '../../engine/types';
import { asList, toBool, toNumber, valueAt } from '../../lib/configValue';
import type { ConfigScopeRef } from './types';

export class CppError extends Error {}

export type CppValue = string | number | boolean | CppFn | ConfigRef | OptionRef;
export interface CppFn { fn: (...args: CppValue[]) => CppValue }
interface ConfigRef { config: ConfigScopeRef }
interface OptionRef { option: string; config: ConfigScopeRef }

export interface CppEnv {
  /** Raw config value. */
  read(scope: ConfigScopeRef, key: string): ConfigValue | undefined;
  /** An identifier (local, builtin, enum constant, helper); undefined when unknown. */
  ident(name: string): CppValue | undefined;
}

/** Receivers → `$self.` / `$printer.` / `$project.`; strip template arguments the evaluator doesn't need. */
export function normalizeCpp(src: string): string {
  return src
    .replace(/wxGetApp\(\)\.preset_bundle->/g, 'preset_bundle->')
    .replace(/m_preset_bundle->/g, 'preset_bundle->')
    .replace(/\bpreset_bundle->(is_bbl_vendor|get_printer_extruder_count)\(\)/g, '$1()')
    .replace(/preset_bundle->printers\.get_edited_preset\(\)\.config\./g, '$printer.')
    .replace(/\b(?:printer_cfg|printer_config)\./g, '$printer.')
    .replace(/\bproj_cfg\./g, '$project.')
    .replace(/\bm_config->/g, '$self.')
    .replace(/\bconfig->/g, '$self.')
    .replace(/\b(option|opt_enum)<(?:[^<>()]|<[^<>()]*>)*>\s*\(/g, '$1(')
    .replace(/->/g, '.');
}

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++]; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(?:e-?\d+)?[fFuUlL]*/.exec(src.slice(i));
    if (num && /\d/.test(c === '.' ? src[i + 1] ?? '' : c)) { out.push({ t: 'num', v: parseFloat(num[1]) }); i += num[0].length; continue; }
    const id = /^\$?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(&&|\|\||==|!=|<=|>=|[!<>()[\]{},.;?:+\-*])/.exec(src.slice(i));
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    throw new CppError(`unexpected "${c}" in ${src}`);
  }
  return out;
}

type Node =
  | { k: 'lit'; v: string | number | boolean }
  | { k: 'id'; v: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'tern'; c: Node; a: Node; b: Node }
  | { k: 'call'; f: Node; args: Node[] }
  | { k: 'member'; o: Node; name: string }
  | { k: 'lambda'; param: string; body: Node };

const BIN: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6 };

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new CppError(`expected "${v}" in ${src}`); p++; };

  function primary(): Node {
    const t = toks[p++];
    if (!t) throw new CppError(`unexpected end of ${src}`);
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      return { k: 'id', v: t.v };
    }
    if (t.v === '(') { const e = expr(); expect(')'); return e; }
    if (t.v === '[') {
      // [](Type name) { return expr; }
      while (!isOp(']')) p++;
      p++;
      expect('(');
      const names: string[] = [];
      while (!isOp(')')) { const x = toks[p++]; if (x.t === 'id') names.push(x.v); }
      p++;
      expect('{');
      const kw = toks[p++];
      if (kw?.t !== 'id' || kw.v !== 'return') throw new CppError(`lambda without return in ${src}`);
      const body = expr();
      if (isOp(';')) p++;
      expect('}');
      return { k: 'lambda', param: names[names.length - 1] ?? '', body };
    }
    throw new CppError(`unexpected "${t.v}" in ${src}`);
  }
  function postfix(): Node {
    let n = primary();
    for (;;) {
      if (isOp('.')) { p++; const t = toks[p++]; if (t?.t !== 'id') throw new CppError(`member name expected in ${src}`); n = { k: 'member', o: n, name: t.v }; continue; }
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        while (!isOp(')')) { args.push(expr()); if (isOp(',')) p++; }
        p++;
        n = { k: 'call', f: n, args };
        continue;
      }
      return n;
    }
  }
  function unary(): Node {
    if (isOp('!')) { p++; return { k: 'un', op: '!', a: unary() }; }
    if (isOp('-')) { p++; return { k: 'un', op: '-', a: unary() }; }
    return postfix();
  }
  function binary(min: number): Node {
    let a = unary();
    for (;;) {
      const t = peek();
      const prec = t?.t === 'op' ? BIN[t.v] : undefined;
      if (prec === undefined || prec < min) return a;
      p++;
      a = { k: 'bin', op: String(t!.v), a, b: binary(prec + 1) };
    }
  }
  function expr(): Node {
    const c = binary(1);
    if (isOp('?')) { p++; const a = expr(); expect(':'); const b = expr(); return { k: 'tern', c, a, b }; }
    return c;
  }
  const n = expr();
  if (p !== toks.length) throw new CppError(`trailing "${toks[p].v}" in ${src}`);
  return n;
}

const cache = new Map<string, Node>();
/** Parse (cached) a C++ expression; throws CppError on unsupported syntax. */
export function parseCpp(src: string): Node {
  let n = cache.get(src);
  if (!n) { n = parse(normalizeCpp(src)); cache.set(src, n); }
  return n;
}

const isObj = (v: CppValue): v is CppFn | ConfigRef | OptionRef => typeof v === 'object';
export function truthy(v: CppValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return true; // a std::string in a boolean context doesn't compile; treat as set
  throw new CppError('object used as a condition');
}
const toNum = (v: CppValue): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? toNumber(v, NaN) : NaN);

function readOption(env: CppEnv, scope: ConfigScopeRef, key: string, method: string, idx: number): CppValue {
  const raw = env.read(scope, key);
  const el = valueAt(raw, idx) ?? '';
  switch (method) {
    case 'opt_bool': case 'opt_bool_nullable': return toBool(el);
    case 'opt_int': case 'opt_float': case 'opt_float_nullable': return toNumber(el, NaN);
    case 'opt_string': case 'opt_enum': return el;
    default: throw new CppError(`unsupported config method ${method}`);
  }
}

function evalNode(n: Node, env: CppEnv, scope: Map<string, CppValue>): CppValue {
  switch (n.k) {
    case 'lit': return n.v;
    case 'id': {
      if (scope.has(n.v)) return scope.get(n.v)!;
      if (n.v === '$self' || n.v === '$printer' || n.v === '$project') return { config: n.v.slice(1) as ConfigScopeRef };
      const v = env.ident(n.v);
      if (v === undefined) throw new CppError(`unknown identifier ${n.v}`);
      return v;
    }
    case 'un': {
      const a = evalNode(n.a, env, scope);
      return n.op === '!' ? !truthy(a) : -toNum(a);
    }
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.a, env, scope)) && truthy(evalNode(n.b, env, scope));
      if (n.op === '||') return truthy(evalNode(n.a, env, scope)) || truthy(evalNode(n.b, env, scope));
      const a = evalNode(n.a, env, scope), b = evalNode(n.b, env, scope);
      if (n.op === '==' || n.op === '!=') {
        const eq = typeof a === 'string' || typeof b === 'string' ? String(a) === String(b) : toNum(a) === toNum(b);
        return n.op === '==' ? eq : !eq;
      }
      const x = toNum(a), y = toNum(b);
      switch (n.op) {
        case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y;
        case '+': return x + y; case '-': return x - y; case '*': return x * y;
      }
      throw new CppError(`operator ${n.op}`);
    }
    case 'tern': return truthy(evalNode(n.c, env, scope)) ? evalNode(n.a, env, scope) : evalNode(n.b, env, scope);
    case 'lambda': return { fn: (arg: CppValue) => evalNode(n.body, env, new Map([...scope, [n.param, arg]])) };
    case 'member': {
      const o = evalNode(n.o, env, scope);
      if (isObj(o) && 'option' in o && n.name === 'value') {
        const raw = env.read(o.config, o.option);
        const el = valueAt(raw, 0) ?? '';
        const asNum = toNumber(el, NaN);
        return Number.isNaN(asNum) ? el : asNum;
      }
      throw new CppError(`member .${n.name}`);
    }
    case 'call': {
      const args = n.args.map((a) => evalNode(a, env, scope));
      if (n.f.k === 'member') {
        const o = evalNode(n.f.o, env, scope);
        const m = n.f.name;
        if (isObj(o) && 'config' in o && !('option' in o)) {
          const key = String(args[0]);
          if (m === 'has') return env.read(o.config, key) !== undefined;
          if (m === 'option') return { option: key, config: o.config };
          return readOption(env, o.config, key, m, args.length > 1 ? toNum(args[1]) : 0);
        }
        if (isObj(o) && 'option' in o) {
          const raw = env.read(o.config, o.option);
          if (m === 'size') return asList(raw).length;
          if (m === 'get_at') return toNumber(valueAt(raw, toNum(args[0])), NaN);
          if (m === 'get_abs_value') {
            const s = valueAt(raw, 0) ?? '';
            const v = toNumber(s, NaN);
            return s.trim().endsWith('%') ? (v / 100) * toNum(args[0]) : v;
          }
        }
        throw new CppError(`method .${m}()`);
      }
      const f = evalNode(n.f, env, scope);
      if (!isObj(f) || !('fn' in f)) throw new CppError('call of a non-function');
      return f.fn(...args);
    }
  }
}

/** Evaluate a C++ expression (text from the generated rules). */
export function evalCpp(src: string, env: CppEnv, vars?: Record<string, CppValue>): CppValue {
  return evalNode(parseCpp(src), env, new Map(Object.entries(vars ?? {})));
}
