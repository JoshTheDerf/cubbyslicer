#!/usr/bin/env node
/**
 * Dev-only extractor for engine metadata the settings UI needs and the engine
 * builds don't publish.
 *
 * From an OrcaSlicer source tree it writes:
 *   src/settings/__fixtures__/orca-schema.sample.json   (Schema JSON shape, ENGINE-CONTRACT.md; test fixture / fallback only)
 *   src/settings/layout/orca.generated.ts                (Tab.cpp pages → groups → keys)
 *   src/settings/rules/orca.generated.ts                 (ConfigManipulation / Tab toggle_* calls: enable / show rules)
 *   src/dialogs/gcode/placeholders.generated.ts          (G-code placeholder catalogue: PrintConfig.cpp *ConfigDef classes)
 * and from a preFlight git checkout:
 *   src/settings/__fixtures__/preflight-schema.sample.json
 *   src/settings/layout/preflight.generated.ts
 *   src/presets/preflight/orcaKeyMap.generated.ts        (OrcaKeyMapping.cpp tables)
 *
 * At runtime the real `schema.json` produced by `cs_describe_config` always wins.
 *
 * Usage:
 *   node scripts/dev/extract-engine-meta.mjs [--orca <OrcaSlicer checkout>] [--orca-ref <git ref>] [--orca-version 2.5.0]
 *                                            [--schema <engine schema.json>] [--preflight <preflight git dir>] [--ref v1.3.0]
 *                                            [--only orca|preflight]
 *
 * `--orca` is the checkout root (or its src/). It defaults to the reference tree of the
 * 2.5.0 upgrade when that exists; never point it at the engine port's live working tree.
 * With `--orca-ref` files are read with `git show <ref>:src/…` instead of the working tree.
 * `--schema` adds the keys of a real engine schema.json to the set the layout may reference
 * (keys defined in ways the schema extractor can't see).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

const ORCA_REFERENCE = '/tmp/claude-1000/-server-thederf-cubby-slicer/4027ee31-2060-4d01-9d24-351965a18832/scratchpad/orca-2.5.0';
const ORCA_ARG = arg('--orca', existsSync(ORCA_REFERENCE) ? ORCA_REFERENCE : null);
const ORCA_REF = arg('--orca-ref', null);
const ORCA_VERSION_ARG = arg('--orca-version', null);
const SCHEMA_JSON = arg('--schema', null);
const PF_GIT = arg('--preflight', '/server/thederf/slicers/preflight');
const PF_REF = arg('--ref', 'v1.3.0');
const ONLY = arg('--only', null);

/** Orca checkout root (accepts either the root or its src/). */
function orcaRoot() {
  if (!ORCA_ARG) throw new Error('No OrcaSlicer source: pass --orca <checkout>.');
  const r = resolve(ORCA_ARG);
  if (ORCA_REF) return r.replace(/\/src\/?$/, '');
  return existsSync(resolve(r, 'src/libslic3r')) ? r : resolve(r, '..');
}
const orcaFile = (p) => {
  if (ORCA_REF) return execFileSync('git', ['-C', orcaRoot(), 'show', `${ORCA_REF}:src/${p}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  return readFileSync(resolve(orcaRoot(), 'src', p), 'utf8');
};
const orcaRootFile = (p) => {
  try {
    if (ORCA_REF) return execFileSync('git', ['-C', orcaRoot(), 'show', `${ORCA_REF}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return readFileSync(resolve(orcaRoot(), p), 'utf8');
  } catch { return ''; }
};
function orcaVersion() {
  if (ORCA_VERSION_ARG) return ORCA_VERSION_ARG;
  const m = /SoftFever_VERSION\s+"?([\d.]+)/.exec(orcaRootFile('version.inc'));
  if (m) return m[1];
  if (ORCA_REF) return ORCA_REF.replace(/^v/, '');
  return '2.5.0';
}
const pfFile = (p) => execFileSync('git', ['-C', PF_GIT, 'show', `${PF_REF}:src/${p}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });

// ---------------------------------------------------------------------------
// C++ lexing helpers
// ---------------------------------------------------------------------------

/** Strip // and /* comments while keeping string literals intact. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === '\'') {
      const q = c; let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j; continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e + 2); out += chunk.replace(/[^\n]/g, ''); i = e + 1; continue; }
    out += c;
  }
  return out;
}

/** Drop `#if 0 … #endif` blocks (keeps the `#else` branch). */
function stripIfZero(src) {
  const lines = src.split('\n');
  const out = [];
  const stack = []; // true = skipping
  for (const line of lines) {
    const t = line.trim();
    if (/^#\s*if\b/.test(t)) { stack.push(/^#\s*if\s+0\b/.test(t) ? 'zero' : 'other'); out.push(''); continue; }
    if (/^#\s*else\b/.test(t) && stack.length) { const top = stack[stack.length - 1]; stack[stack.length - 1] = top === 'zero' ? 'zero-else' : top === 'other' ? 'other-else' : top; out.push(''); continue; }
    if (/^#\s*endif\b/.test(t) && stack.length) { stack.pop(); out.push(''); continue; }
    const skipping = stack.some((s) => s === 'zero' || s === 'other-else');
    out.push(skipping ? '' : line);
  }
  return out.join('\n');
}

function unescapeC(s) {
  return s.replace(/\\(n|t|r|"|'|\\|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/g, (_, e) => {
    if (e === 'n') return '\n'; if (e === 't') return '\t'; if (e === 'r') return '\r';
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return e;
  });
}

/** Concatenate every string literal in an expression (handles L("a" "b"), u8"x"). */
function literals(expr) {
  const out = [];
  const re = /(?:u8|L|u|U)?"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(expr))) out.push(unescapeC(m[1]));
  return out;
}
const joined = (expr) => literals(expr).join('');
/** A translated label: L("a" "b") → "ab"; L_CONTEXT("X", "Axis") → "X" (the second literal is the context). */
function labelOf(expr) {
  const ctx = /\b_?L_CONTEXT\s*\(/.exec(expr);
  if (ctx) return literals(splitTop(balanced(expr, ctx.index + ctx[0].length - 1))[0] ?? '').join('');
  return joined(expr);
}

/** Split a code region into top-level statements (by ';' outside strings / brackets). */
function statements(src) {
  const out = []; let depth = 0; let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === '\'') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) { out.push(src.slice(start, i).trim()); start = i + 1; depth = 0; }
  }
  if (src.slice(start).trim()) out.push(src.slice(start).trim());
  return out;
}

/** Contents of the balanced {...} or (...) starting at src[idx]. */
function balanced(src, idx) {
  const open = src[idx], close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === '\'') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(idx + 1, i); }
  }
  return src.slice(idx + 1);
}

/** All quoted identifiers inside a named initializer list: `NAME ... = { "a", "b" }` or `NAME{...}`. */
function stringListNamed(src, name) {
  const re = new RegExp(`${name}\\s*(?:=\\s*)?\\{`);
  const m = re.exec(src);
  if (!m) return [];
  const body = balanced(src, m.index + m[0].length - 1);
  return literals(body);
}

/** Body of `<qualified name>(…) [const] {` in a source file (comments stripped), or null. */
function functionBody(code, name) {
  const re = new RegExp(`\\n[\\w:<>*&, ]*\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + m[0].length - 1);
    const params = balanced(code, open);
    let i = open + params.length + 2;
    const rest = code.slice(i, i + 200);
    const head = /^\s*(?:const\s*)?(?:override\s*)?\{/.exec(rest);
    if (!head) continue;
    i += head[0].length - 1;
    return balanced(code, i);
  }
  return null;
}

/** Expand simple function-like macros (`#define NAME(A, B) body`) defined in the source. */
function expandMacros(code) {
  const defs = [...code.matchAll(/#define\s+(\w+)\(([^)]*)\)[ \t]*(.*)/g)].map((m) => ({ name: m[1], params: m[2].split(',').map((s) => s.trim()), body: m[3] }));
  let out = code;
  for (const d of defs) {
    const re = new RegExp(`\\b${d.name}\\s*\\(`, 'g');
    let res = ''; let last = 0; let m;
    while ((m = re.exec(out))) {
      const lineStart = out.lastIndexOf('\n', m.index) + 1;
      if (/^\s*#define/.test(out.slice(lineStart, m.index + 1))) continue;
      const open = m.index + m[0].length - 1;
      const inner = balanced(out, open);
      const argv = splitTop(inner);
      let body = d.body;
      d.params.forEach((p, i) => { body = body.replace(new RegExp(`\\b${p}\\b`, 'g'), argv[i] ?? ''); });
      res += out.slice(last, m.index) + body;
      last = open + inner.length + 2;
      re.lastIndex = last;
    }
    out = res + out.slice(last);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema extraction
// ---------------------------------------------------------------------------

const TYPE_MAP = {
  coFloat: 'float', coFloats: 'floats', coInt: 'int', coInts: 'ints', coString: 'string', coStrings: 'strings',
  coPercent: 'percent', coPercents: 'percents', coFloatOrPercent: 'floatOrPercent', coFloatsOrPercents: 'floatsOrPercents',
  coPoint: 'point', coPoints: 'points', coPoint3: 'point3', coBool: 'bool', coBools: 'bools', coEnum: 'enum',
  coEnums: 'strings', coNone: 'none', coPointsGroups: 'string', coIntsGroups: 'string',
};
const MODE_MAP = { comSimple: 'simple', comAdvanced: 'advanced', comExpert: 'expert', comDevelop: 'expert' };

function parseEnumMaps(src) {
  const maps = {};
  const re = /static\s+(?:const\s+)?t_config_enum_values\s+s_keys_map_(\w+)\s*(?:=\s*)?\{/g;
  let m;
  while ((m = re.exec(src))) {
    const body = balanced(src, m.index + m[0].length - 1);
    const map = {};
    for (const e of body.matchAll(/\{\s*"([^"]*)"\s*,\s*(?:int\s*\(\s*)?([\w:]+)\s*\)?\s*\}/g)) { const c = e[2].split('::').pop(); if (!(c in map)) map[c] = e[1]; }
    maps[m[1]] = map;
  }
  return maps;
}

/** C++ string vector serialization (escape_strings_cstyle). */
function escapeStrings(strs) {
  return strs.map((s) => {
    const quote = (strs.length === 1 && s === '') || /[ ;\t\\"\r\n]/.test(s);
    return quote ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"` : s;
  }).join(';');
}

/** #define NAME <number> constants (PrintConfigConstants.hpp etc.), filled by main. */
const CONSTANTS = {};
function num(s) {
  const c = s.trim();
  if (CONSTANTS[c] !== undefined) return CONSTANTS[c];
  const t = c.replace(/\.f?$|f$/i, '').replace(/^\+/, '');
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(t)) return String(Number(t));
  if (t === 'true') return '1'; if (t === 'false') return '0';
  return null;
}

/** Serialize a `new ConfigOptionX(...)` default expression. */
function serializeDefault(expr, type, enumMaps, localVectors) {
  const m = /new\s+ConfigOption(\w+?)(?:Nullable)?\s*(<\s*([\w:]+)\s*>)?\s*([({])([\s\S]*)$/.exec(expr);
  if (!m) return '';
  const kind = m[1]; const enumType = m[3]; const body = balanced(m[4] + m[5], 0);
  const items = splitTop(body);
  const vec = (fn) => {
    // Floats(axis.max_feedrate) style — resolved by caller-provided table.
    if (items.length === 1 && localVectors && localVectors[items[0].trim()]) return localVectors[items[0].trim()].join(',');
    // Floats({1, 2}) / Floats{1,2} / Floats(3, 0.4) (count, value)
    let parts = items;
    if (parts.length === 1 && /^\{/.test(parts[0].trim())) parts = splitTop(balanced(parts[0].trim(), 0));
    if (m[4] === '(' && parts.length === 2 && /^\d+$/.test(parts[0].trim()) && !/^\{/.test(body.trim()) && kind !== 'Points') {
      const v = fn(parts[1]); return Array(Number(parts[0])).fill(v).join(',');
    }
    return parts.filter((p) => p.trim()).map(fn).join(',');
  };
  const pctOf = (p) => { const n = num(p) ?? '0'; return `${n}%`; };
  const foOf = (p) => {
    const inner = /FloatOrPercent\s*\(([^)]*)\)/.exec(p);
    const parts = splitTop(inner ? inner[1] : p.replace(/^\{|\}$/g, ''));
    const v = num(parts[0] ?? '0') ?? '0';
    return /true/.test(parts[1] ?? '') ? `${v}%` : v;
  };
  const pointOf = (p) => {
    const inner = /Vec2d\s*\(([^)]*)\)/.exec(p) || /\{([^}]*)\}/.exec(p);
    const parts = inner ? splitTop(inner[1]) : splitTop(p);
    return `${num(parts[0] ?? '0') ?? 0}x${num(parts[1] ?? '0') ?? 0}`;
  };
  const enumOf = (p) => {
    const c = p.trim().replace(/^\(\s*\w+\s*\)\s*/, '').replace(/^int\s*\((.*)\)$/, '$1').split('::').pop();
    const map = enumType ? enumMaps[enumType.split('::').pop()] : null;
    if (map && map[c]) return map[c];
    for (const mm of Object.values(enumMaps)) if (mm[c]) return mm[c];
    return c;
  };
  switch (kind) {
    case 'Float': case 'Int': return num(items[0] ?? '0') ?? '0';
    case 'Floats': case 'Ints': return vec((p) => num(p) ?? '0');
    case 'Bool': return /true|1/.test(items[0] ?? '') ? '1' : '0';
    case 'Bools': return vec((p) => (/true|1/.test(p) ? '1' : '0'));
    case 'Percent': return pctOf(items[0] ?? '0');
    case 'Percents': return vec(pctOf);
    case 'FloatOrPercent': return foOf(body);
    case 'FloatsOrPercents': return vec(foOf);
    case 'String': return joined(items[0] ?? '');
    case 'Strings': {
      let parts = items; if (parts.length === 1 && /^\{/.test(parts[0].trim())) parts = splitTop(balanced(parts[0].trim(), 0));
      return escapeStrings(parts.filter((p) => p.trim()).map(joined));
    }
    case 'Point': return pointOf(body);
    case 'Point3': { const inner = /Vec3d\s*\(([^)]*)\)/.exec(body); const p = splitTop(inner ? inner[1] : body); return p.map((x) => num(x) ?? '0').join(','); }
    case 'Points': {
      if (/^\s*Points\s*\{/.test(body) || /^\s*\{/.test(body)) { const b = body.trim(); const s = b.indexOf('{'); return splitTop(balanced(b, s)).filter((x) => x.trim()).map(pointOf).join(','); }
      return items.filter((p) => p.trim() && /Vec2d|\{/.test(p)).map(pointOf).join(',');
    }
    case 'Enum': return enumOf(items[0] ?? '');
    case 'EnumsGeneric': { let parts = items; if (parts.length === 1 && /^\{/.test(parts[0].trim())) parts = splitTop(balanced(parts[0].trim(), 0)); return parts.filter((p) => p.trim()).map((p) => num(p) ?? enumOf(p)).join(','); }
    default:
      return '';
  }
}

function splitTop(s) {
  const out = []; let depth = 0; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '\'') { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '<' && /[\w:]$/.test(s.slice(0, i)) && /^\s*[\w:]+\s*>/.test(s.slice(i + 1))) depth++; // template args
    else if (c === '>' && depth > 0 && /[\w:\s]$/.test(s.slice(0, i)) && s.slice(0, i).lastIndexOf('<') > s.slice(0, i).lastIndexOf('>')) depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x, i, a) => x !== '' || a.length > 1);
}

function applyStmt(def, st, ctx) {
  let m;
  const rhs = (s) => s.slice(s.indexOf('=') + 1).trim();
  if ((m = /^def->(label|full_label|category|tooltip|sidetext)\s*=/.exec(st))) {
    const key = m[1] === 'full_label' ? 'fullLabel' : m[1];
    const v = rhs(st);
    if (/^it_opt->second\./.test(v)) return; // copied later
    const lits = literals(v);
    if (lits.length) def[key] = key === 'label' || key === 'fullLabel' ? labelOf(v) : lits.join('');
    else if (/boost::format/.test(v)) def[key] = '';
    return;
  }
  if ((m = /^def->mode\s*=\s*(\w+)/.exec(st))) { def.mode = MODE_MAP[m[1]] ?? 'advanced'; return; }
  if ((m = /^def->(min|max)\s*=\s*(.+)$/s.exec(st))) {
    const n = num(m[2].replace(/\(\s*(?:double|float|int)\s*\)/, ''));
    if (n !== null) def[m[1]] = Number(n);
    return;
  }
  if ((m = /^def->(multiline|full_width|readonly|nullable)\s*=\s*(\w+)/.exec(st))) {
    def[m[1] === 'full_width' ? 'fullWidth' : m[1]] = m[2] === 'true'; return;
  }
  if ((m = /^def->gui_type\s*=\s*ConfigOptionDef::GUIType::(\w+)/.exec(st))) { def.guiType = m[1]; return; }
  if ((m = /^def->enum_def\s*=.*\bdef_(\w+)->enum_def/.exec(st))) { def.__enumFrom = m[1]; return; }
  if ((m = /^def->enum_keys_map\s*=\s*&?\s*ConfigOptionEnum<\s*(\w+)\s*>/.exec(st))) { def.__enumType = m[1]; return; }
  if ((m = /^def->enum_values\.(?:push_back|emplace_back)\((.*)\)$/s.exec(st))) { (def.enumValues ??= []).push(joined(m[1])); return; }
  if ((m = /^def->enum_labels\.(?:push_back|emplace_back)\((.*)\)$/s.exec(st))) { (def.enumLabels ??= []).push(joined(m[1])); return; }
  if ((m = /^def->enum_(values|labels)\s*=\s*(.*)$/s.exec(st))) {
    const lits = literals(m[2]); if (lits.length) def[m[1] === 'values' ? 'enumValues' : 'enumLabels'] = lits; return;
  }
  if ((m = /^def->set_enum(?:_values|_labels)?\s*(<[^>]*>)?\s*\(([\s\S]*)\)$/.exec(st))) {
    const which = /^def->set_enum_labels/.test(st) ? 'labels' : /^def->set_enum_values/.test(st) ? 'values' : 'enum';
    let body = m[2];
    const gt = /ConfigOptionDef::GUIType::(\w+)\s*,/.exec(body);
    if (gt) { def.guiType = gt[1]; body = body.slice(gt.index + gt[0].length); }
    const pairs = [...body.matchAll(/\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*((?:_?L|_u8L)\s*\(\s*)?"((?:[^"\\]|\\.)*)"\s*\)?\s*\}/g)];
    if (pairs.length) {
      def.enumValues = pairs.map((p) => unescapeC(p[1]));
      def.enumLabels = pairs.map((p) => unescapeC(p[3]));
    } else {
      const lits = literals(body);
      if (which === 'labels') def.enumLabels = lits; else def.enumValues = lits;
      if (which === 'enum') def.enumLabels = lits.slice();
    }
    return;
  }
  if ((m = /^def->set_default_value\(([\s\S]*)\)$/.exec(st))) {
    def.default = serializeDefault(m[1], def.type, ctx.enumMaps, ctx.localVectors);
  }
}

function blankDef(type, nullable) {
  return {
    type, label: '', fullLabel: '', category: '', tooltip: '', sidetext: '', mode: 'simple',
    min: null, max: null, default: '', multiline: false, fullWidth: false, readonly: false, nullable, guiType: '', scope: 'other',
  };
}

/**
 * Inline keys that are defined indirectly, so the `this->add("key", …)` scan sees them:
 * - helper lambdas `auto add_x = [this](const char *key, …) { auto def = this->add(key, coEnum); … }`
 *   called as `add_x("key", L("Label"), …)` (Orca 2.5 `add_belt_remap`);
 * - `for (const char* key : {"a", "b"}) { def = this->add(key, coX); … }` loops.
 * The `filament_extruder_override_keys` loop (`add_nullable(opt_key, it_opt->second.type)`) is handled separately.
 */
function inlineIndirectDefs(code) {
  let out = code;
  // Helper lambdas.
  for (const m of [...code.matchAll(/auto\s+(\w+)\s*=\s*\[[^\]]*\]\s*\(/g)]) {
    const name = m[1];
    const pOpen = m.index + m[0].length - 1;
    const params = balanced(code, pOpen);
    const bOpen = code.indexOf('{', pOpen + params.length + 1);
    const body = balanced(code, bOpen);
    if (!/this->add(?:_nullable)?\(\s*\w+\s*,/.test(body)) continue;
    const pnames = splitTop(params).map((p) => /(\w+)\s*$/.exec(p)?.[1] ?? '');
    const calls = [];
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let c;
    while ((c = re.exec(out))) {
      if (c.index > 0 && /[\w.>]/.test(out[c.index - 1])) continue;
      const inner = balanced(out, c.index + c[0].length - 1);
      const argv = splitTop(inner);
      if (!/^"/.test(argv[0] ?? '')) continue; // the definition itself
      let expanded = body;
      pnames.forEach((p, i) => { if (p) expanded = expanded.replace(new RegExp(`(?<![\\w.>])${p}\\b`, 'g'), argv[i] ?? ''); });
      expanded = expanded.replace(/auto\s+def\s*=/, 'def =');
      calls.push({ start: c.index, end: c.index + c[0].length + inner.length + 1, text: `${expanded}\n` });
    }
    for (const cl of calls.reverse()) out = out.slice(0, cl.start) + cl.text + out.slice(cl.end);
  }
  // for (const char* key : { "a", "b" }) { … this->add(key, …) … }
  out = out.replace(/for\s*\(\s*(?:const\s+)?(?:char\s*\*|auto\s*&?|std::string\s*&?)\s*(\w+)\s*:\s*\{([^}]*)\}\s*\)\s*\{/g, (all, v, list, off) => {
    const bodyOpen = off + all.length - 1;
    const body = balanced(out, bodyOpen);
    if (!new RegExp(`this->add(?:_nullable)?\\(\\s*${v}\\s*,`).test(body) || /it_opt/.test(body)) return all;
    const keys = literals(list);
    return `{ /*__loop:${keys.length}:${v}:${keys.join(',')}*/`;
  });
  // Expand the loop markers left above: duplicate the loop body per key.
  for (;;) {
    const m = /\{ \/\*__loop:(\d+):(\w+):([^*]*)\*\//.exec(out);
    if (!m) break;
    const body = balanced(out, m.index);
    const inner = body.slice(m[0].length - 1);
    const keys = m[3].split(',');
    const expanded = keys.map((k) => inner.replace(new RegExp(`\\b${m[2]}\\b`, 'g'), `"${k}"`)).join('\n');
    out = out.slice(0, m.index) + `{${expanded}}` + out.slice(m.index + body.length + 2);
  }
  return out;
}

function extractSchema(src, { overrideKeys, axisDefaults, prefixForOverride }) {
  const code = inlineIndirectDefs(expandMacros(stripComments(src)));
  const enumMaps = parseEnumMaps(code);
  const options = {};
  // Every `def = this->add(...)` starts a block; the block runs to the next one.
  const re = /def\s*=\s*this->add(_nullable)?\(\s*("([\w]+)"|"(\w+)"\s*\+\s*axis\.name)\s*,\s*(co\w+)\s*\)\s*;/g;
  const hits = [...code.matchAll(re)];
  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h];
    const end = h + 1 < hits.length ? hits[h + 1].index : Math.min(code.length, hit.index + 20000);
    let block = code.slice(hit.index + hit[0].length, end);
    // stop at a function boundary
    const fnEnd = block.search(/\n\}\s*\n/);
    if (fnEnd >= 0) block = block.slice(0, fnEnd);
    const type = TYPE_MAP[hit[5]] ?? 'none';
    const keys = hit[3] ? [hit[3]] : ['x', 'y', 'z', 'e'].map((a) => hit[4] + a);
    for (const key of keys) {
      const def = blankDef(type, !!hit[1]);
      const axis = key.slice(-1).toUpperCase();
      const localVectors = axisDefaults ? axisDefaults(key) : null;
      for (const st of statements(block)) applyStmt(def, st, { enumMaps, localVectors });
      if (!hit[3]) {
        for (const f of ['label', 'fullLabel', 'tooltip']) def[f] = def[f].replace(/%1%/g, axis);
        def.fullLabel ||= `${hit[4].replace(/^machine_max_/, 'Maximum ').replace(/_$/, '').replace(/_/g, ' ')} ${axis}`;
        def.tooltip ||= `${def.fullLabel}`;
      }
      if (def.__enumType && !(def.enumValues?.length) && enumMaps[def.__enumType]) def.enumValues = [...new Set(Object.values(enumMaps[def.__enumType]))];
      delete def.__enumType;
      if (def.__enumFrom && options[def.__enumFrom]) { def.enumValues = options[def.__enumFrom].enumValues?.slice(); def.enumLabels = options[def.__enumFrom].enumLabels?.slice(); }
      delete def.__enumFrom;
      if (!def.fullLabel) def.fullLabel = def.label;
      if (!def.label) def.label = def.fullLabel;
      if (def.enumValues && !def.enumLabels) def.enumLabels = def.enumValues.slice();
      if (def.type === 'enum' && !def.enumValues) def.enumValues = [];
      if (!options[key]) options[key] = def;
    }
  }
  // filament_* nullable overrides of extruder options
  for (const k of overrideKeys) {
    const raw = prefixForOverride(k);
    const base = options[raw];
    if (!base) continue;
    const d = { ...base, nullable: true };
    if (options[k]) { Object.assign(options[k], { ...d, ...pick(options[k], ['type']) }); }
    else options[k] = d;
  }
  return options;
}
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function classMembers(hpp, className) {
  const re = new RegExp(`PRINT_CONFIG_CLASS_(?:DERIVED_)?DEFINE\\w*\\(\\s*${className}\\s*,`);
  const m = re.exec(hpp);
  if (!m) return [];
  const body = balanced(hpp, m.index + m[0].indexOf('('));
  return [...body.matchAll(/\(\(\s*[\w<>:,\s]+?,\s*(\w+)\s*\)\)/g)].map((x) => x[1]);
}

function assignScopes(options, { print, filament, machine, objectKeys }) {
  for (const k of machine) if (options[k]) options[k].scope = 'machine';
  for (const k of filament) if (options[k]) options[k].scope = 'filament';
  for (const k of print) if (options[k]) options[k].scope = objectKeys.has(k) ? 'object' : 'print';
}

// ---------------------------------------------------------------------------
// Tab.cpp layout extraction
// ---------------------------------------------------------------------------

/**
 * Named string lists a loop can iterate: local `std::vector<std::string> NAME{…}` /
 * `NAME = {…}` in the function, and functions returning `{ { "key", "icon" }, … }`
 * tables (Orca 2.5 `publishable_printer_retraction_options()`), first literal per row.
 */
function namedLists(body, tables) {
  const lists = { ...tables };
  for (const m of body.matchAll(/std::vector<std::string>\s+(\w+)\s*(?:=\s*)?\{/g)) lists[m[1]] = literals(balanced(body, m.index + m[0].length - 1));
  return lists;
}
function tableFunctions(code) {
  const out = {};
  for (const m of code.matchAll(/\n[\w:<>&*\s]+?\b(\w+)\s*\(\s*\)\s*\{/g)) {
    const body = balanced(code, m.index + m[0].length - 1);
    const t = /=\s*\{([\s\S]*)\}\s*;/.exec(body);
    if (!t) continue;
    const rows = [...t[1].matchAll(/\{\s*"([a-z][a-z0-9_]*)"/g)].map((r) => r[1]);
    if (rows.length) out[`${m[1]}()`] = rows;
  }
  return out;
}

const OPTION_CALL = /(append_single_option_line|get_option|create_line_with_widget|append_option_line|Option\s*\(\s*def\s*,|add_option_line)\s*\(?/;

/**
 * Pages → groups → keys of the given Tab.cpp build functions.
 * - optgroups are tracked per variable (`auto belt_og = page->new_optgroup(…)`), so keys appended
 *   to an earlier group after another group was created land in the right one;
 * - a page is per-extruder when its option lines take the extruder index (`…, extruder_idx)`),
 *   or (PrusaSlicer style) its title is not a literal;
 * - keys come from string literals on option lines, and from loops over a named list / table
 *   function (`for (… opt : publishable_printer_retraction_options()) og->append_single_option_line(opt.key, …)`).
 */
function extractLayout(tabSrc, fnNames, schemaKeys, tables = {}) {
  const code = stripIfZero(stripComments(tabSrc));
  const pages = [];
  for (const fn of fnNames) {
    const body = functionBody(code, fn);
    if (body === null) { console.warn(`layout: function ${fn} not found`); continue; }
    const lists = namedLists(body, tables);
    // The list declarations themselves are not option lines (their keys are placed where the loop runs).
    const lines = body.replace(/(std::vector<std::string>\s+\w+\s*(?:=\s*)?)\{([^}]*)\}/g, (_, head, list) => `${head}{${list.replace(/[^\n]/g, '')}}`).split('\n');
    let page = null;
    const groupVars = {};
    let currentVar = null;
    let loop = null; // { v, values, depth }
    const seen = new Set(pages.flatMap((p) => p.groups.flatMap((g) => g.keys)));
    const push = (group, key) => {
      if (!schemaKeys.has(key) || !group) return;
      if (group.keys.includes(key)) return;
      if (!page.extruder && seen.has(key)) return;
      group.keys.push(key); seen.add(key);
    };
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      let mm;
      if ((mm = /add_options_page\(\s*(?:_?L\(\s*)?(?:"([^"]+)"|(\w+))/.exec(line))) {
        const title = mm[1] ?? 'Extruder';
        page = pages.find((p) => p.title === title) ?? null;
        if (!page) { page = { title, extruder: !mm[1], groups: [] }; pages.push(page); }
        for (const k of Object.keys(groupVars)) delete groupVars[k];
        currentVar = null;
        continue;
      }
      if (!page) continue;
      if ((mm = /(?:(\w+)\s*=\s*)?\w+->new_optgroup\w*\(\s*(?:_?L\(\s*)?(?:"([^"]*)"|(\w+))?/.exec(line))) {
        const title = mm[2] ?? '';
        let group = page.groups.find((g) => g.title === title) ?? null;
        if (!group) { group = { title, keys: [] }; page.groups.push(group); }
        const v = mm[1] ?? 'optgroup';
        groupVars[v] = group;
        currentVar = v;
        continue;
      }
      // for (… v : NAME) / for (… v : table()) / for (… v : { "a", "b", … }) — the list may span lines.
      if ((mm = /\bfor\s*\(.*?(?<![:\w])(\w+)\s*:(?!:)\s*(\{)?/.exec(line))) {
        if (mm[2]) {
          let text = line.slice(line.indexOf('{', mm.index));
          while (!/\}\s*\)/.test(text) && li + 1 < lines.length) text += `\n${lines[++li]}`;
          loop = { v: mm[1], values: literals(text.slice(0, text.search(/\}\s*\)/))) };
          line = text.slice(text.search(/\}\s*\)/)).replace(/^\}\s*\)/, '');
        } else {
          const named = /:\s*([\w:]+(?:\(\))?)\s*\)/.exec(line);
          if (named && lists[named[1]]) loop = { v: mm[1], values: lists[named[1]] };
          continue;
        }
      }
      // A key from the active loop variable: `opt.key`, `speed_axis`, `"machine_max_acceleration_" + axis`,
      // `append_retraction_option(retraction_optgroup, opt_key, …)`.
      if (loop && new RegExp(`(?:[(,]\\s*${loop.v}(?:\\.key)?\\s*[,)]|\\+\\s*${loop.v}\\b)`).test(line)) {
        const target = /(\w+)(?:\.get\(\))?\s*->\s*\w+\(/.exec(line)?.[1] ?? /\w+\(\s*(\w+)\s*,/.exec(line)?.[1];
        const group = groupVars[target] ?? groupVars[currentVar];
        const prefix = new RegExp(`"([a-z][a-z0-9_]*_)"\\s*\\+\\s*${loop.v}\\b`).exec(line);
        for (const v of loop.values) push(group, prefix ? prefix[1] + v : v);
        loop = null;
        continue;
      }
      const isCall = OPTION_CALL.test(line);
      const bare = /^\s*"[a-z][a-z0-9_]*"\s*,?\s*$/.test(line) || /^\s*(?:"[a-z][a-z0-9_]*"\s*,\s*)+"[a-z][a-z0-9_]*"?\s*,?\s*$/.test(line);
      if (!isCall && !bare) continue;
      if (isCall && /\bextruder_idx\b/.test(line)) page.extruder = true;
      const target = /(\w+)(?:\.get\(\))?\s*->\s*(?:append_single_option_line|get_option|append_line|append_option_line)\b/.exec(line)?.[1]
        ?? /(?:create_line_with_widget|append_option_line)\(\s*(\w+)/.exec(line)?.[1]
        ?? currentVar;
      const group = groupVars[target] ?? groupVars[currentVar];
      for (const pm of line.matchAll(/"([a-z][a-z0-9_]*_)"\s*\+\s*\w+/g)) for (const a of ['x', 'y', 'z', 'e']) push(group, pm[1] + a);
      for (const km of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) push(group, km[1]);
    }
  }
  return pages.map((p) => ({ ...p, groups: p.groups.filter((g) => g.keys.length) })).filter((p) => p.groups.length);
}

/**
 * Each option row's wiki page (Orca `Line::label_path`, the path after https://www.orcaslicer.com/wiki/
 * that OptionsGroup::get_url builds and the row's label links to). Sources, in Tab.cpp's build functions:
 * `append_single_option_line("key" | option | loopVar, "path")`, `create_line_with_widget(og, "key", "path", …)`,
 * TabPrinter `append_option_line(og, "key" | loopVar | "prefix_" + loopVar, "path")`, and a multi-option
 * `Line` whose `label_path` is set (every option appended to it: `get_option("key")`, an `Option` variable,
 * `Option{ def, "key" }`). Rows without a path (no second argument, "") have no link, as on desktop.
 */
function extractWikiPaths(tabSrc, fnNames, schemaKeys, tables = {}) {
  const code = stripIfZero(stripComments(tabSrc));
  const out = {};
  const set = (k, path) => { if (path && schemaKeys.has(k) && !(k in out)) out[k] = path; };
  for (const fn of fnNames) {
    const body = functionBody(code, fn);
    if (body === null) { console.warn(`wiki: function ${fn} not found`); continue; }
    const lists = namedLists(body, tables);
    const optVar = {};
    const linePath = {};
    const lineKeys = {};
    let loop = null;
    for (const raw of body.split(';')) {
      const st = raw.replace(/\s+/g, ' ');
      let m;
      // for (… v : NAME) / for (… v : { "a", … }): active for the next option call that uses `v`.
      if ((m = /\bfor\s*\(\s*[^;()]*?(?<![:\w])(\w+)\s*:(?!:)\s*(\{[^}]*\}|[\w:]+(?:\(\))?)\s*\)/.exec(st))) {
        loop = { v: m[1], values: m[2].startsWith('{') ? literals(m[2]) : lists[m[2]] ?? [] };
      }
      const keysOf = (arg) => {
        const a = arg.trim();
        let k;
        if ((k = /^"([a-z][a-z0-9_]*)"$/.exec(a))) return [k[1]];
        if ((k = /^"([a-z][a-z0-9_]*_)"\s*\+\s*(\w+)$/.exec(a)) && loop?.v === k[2]) return loop.values.map((v) => k[1] + v);
        if ((k = /^(\w+)(?:\.key)?$/.exec(a))) {
          if (loop?.v === k[1]) return loop.values;
          if (optVar[k[1]]) return [optVar[k[1]]];
        }
        return [];
      };
      // Option variables: `Option option = og->get_option("key", …)` / `option = og->get_option("key")`.
      for (const om of st.matchAll(/(\w+)\s*=\s*\w+(?:\.get\(\))?\s*->\s*get_option\(\s*"([a-z][a-z0-9_]*)"/g)) optVar[om[1]] = om[2];
      // A new Line (`Line line = {…}`, `line = {…}`, `auto line = Line{…}`, `line = og->create_single_option_line(…)`).
      if ((m = /(?:^|[\s{}])(\w+)\s*=\s*(?:Line\s*)?\{|(?:^|[\s{}])Line\s+(\w+)\s*\{|(?:^|[\s{}])(\w+)\s*=\s*\w+->create_single_option_line/.exec(st))) {
        const v = m[1] ?? m[2] ?? m[3];
        delete linePath[v]; lineKeys[v] = [];
      }
      if ((m = /(\w+)\.label_path\s*=\s*"([^"]*)"/.exec(st))) {
        linePath[m[1]] = m[2];
        for (const k of lineKeys[m[1]] ?? []) set(k, m[2]);
      }
      if ((m = /(\w+)\.append_option\((.*)\)\s*$/.exec(st))) {
        const a = m[2];
        const k = /get_option\(\s*"([a-z][a-z0-9_]*)"/.exec(a)?.[1] ?? /Option\s*\{[^,]*,\s*"([a-z][a-z0-9_]*)"/.exec(a)?.[1] ?? optVar[a.trim()];
        if (k) { (lineKeys[m[1]] ??= []).push(k); set(k, linePath[m[1]]); }
      }
      if ((m = /append_single_option_line\(\s*([^,()]+?)\s*,\s*"([^"]*)"/.exec(st))) for (const k of keysOf(m[1])) set(k, m[2]);
      if ((m = /create_line_with_widget\([^,]+,\s*"([a-z][a-z0-9_]*)"\s*,\s*"([^"]*)"/.exec(st))) set(m[1], m[2]);
      if ((m = /(?<![\w.>])append_option_line\(\s*\w+\s*,\s*([^,]+?)\s*,\s*"([^"]*)"/.exec(st))) for (const k of keysOf(m[1])) set(k, m[2]);
    }
  }
  return out;
}

function emitLayoutTs(name, tabs, sourceNote) {
  return `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from ${sourceNote} — do not edit by hand;
 * tweak ./${name}.ts (overrides/ordering) instead and re-run the script to refresh.
 */
import type { EngineLayoutSource } from './types';

export const ${name.replace(/[^a-z]/gi, '')}Generated: EngineLayoutSource = ${JSON.stringify(tabs, null, 2)};
`;
}

// ---------------------------------------------------------------------------
// Enable / show rules: ConfigManipulation::toggle_print_fff_options, Tab*::toggle_options
// ---------------------------------------------------------------------------

const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

/** A reason / label expression: literal, a named wxString, or a ternary of those. */
function parseText(expr, names) {
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  // top-level ternary
  let depth = 0, q = -1, colon = -1;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === '"') { i++; while (i < e.length && e[i] !== '"') { if (e[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?' && q < 0) q = i;
    else if (depth === 0 && c === ':' && q >= 0 && e[i + 1] !== ':' && e[i - 1] !== ':') { colon = i; break; }
  }
  if (q >= 0 && colon > q) return { if: norm(e.slice(0, q)), then: parseText(e.slice(q + 1, colon), names), else: parseText(e.slice(colon + 1), names) };
  if (/^\w+$/.test(e)) {
    if (names[e] !== undefined) return names[e];
    throw new Error(`rules: unknown text name ${e}`);
  }
  if (/^(?:_L|L|_u8L|_)\s*\(/.test(e) || /^"/.test(e)) return literals(e).join('');
  if (e === '{}' || e === '') return '';
  throw new Error(`rules: unsupported text expression ${e}`);
}

/**
 * Walk a C++ function body and collect its toggle calls in order, with the `if` guards that
 * enclose them, plus the local variables they read (initialiser text, for drift checks).
 */
function extractToggles(body) {
  const toggles = [];
  const locals = {};
  const texts = {}; // wxString name → text
  const lists = {}; // std::vector<std::string> name → keys
  const PAGE_GUARD = /^!?m_active_page->title\(\)\s*[!=]=\s*(?:_?L\()?"[^"]*"\)?$/;
  const cleanGuard = (g) => {
    const terms = splitBool(g, '&&').filter((t) => !PAGE_GUARD.test(norm(t)) && norm(t) !== 'm_extruders_count > 0');
    return terms.length ? norm(terms.join(' && ')) : null;
  };

  function splitBool(s, op) {
    const out = []; let depth = 0; let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && s.startsWith(op, i)) { out.push(s.slice(start, i)); start = i + op.length; i += op.length - 1; }
    }
    out.push(s.slice(start));
    return out.map((x) => x.trim());
  }

  function statement(st, guards, loopVar, loopKey) {
    let m;
    const subst = (s) => (loopVar ? s.replace(new RegExp(`\\b${loopVar}\\b`, 'g'), '$key') : s);
    if ((m = /^(?:\w+\.)?(toggle_field|toggle_line|toggle_option|set_option_label)\s*\(([\s\S]*)\)$/.exec(st))) {
      const argv = splitTop(m[2]);
      const keyArg = argv[0];
      const key = loopVar && keyArg === loopVar ? loopKey : literals(keyArg)[0];
      if (!key) throw new Error(`rules: no key in ${st}`);
      if (m[1] === 'set_option_label') {
        toggles.push({ kind: 'label', key, ...(guards.length ? { guards } : {}), text: parseText(subst(argv[1]), texts) });
        return;
      }
      const kind = m[1] === 'toggle_line' ? 'show' : 'enable';
      const idx = argv[2] ?? '-1';
      const entry = { kind, key, when: norm(subst(argv[1])) };
      if (guards.length) entry.guards = guards;
      if (/variant_index/.test(idx)) entry.perVariant = true;
      if (argv[3] !== undefined) {
        const r = parseText(argv[3], texts);
        if (r !== '') entry.reason = r;
      }
      toggles.push(entry);
      return;
    }
    // const wxString name = _L("…") / ternary
    if ((m = /^(?:const\s+)?wxString\s+(\w+)\s*=\s*([\s\S]+)$/.exec(st))) { texts[m[1]] = parseText(m[2], texts); return; }
    // std::vector<std::string> name = {…} / name = {…}
    if ((m = /^(?:(?:const\s+)?std::vector<std::string>\s+)?(\w+)\s*=?\s*\{([\s\S]*)\}$/.exec(st)) && (/std::vector/.test(st) || lists[m[1]] !== undefined)) {
      lists[m[1]] = literals(m[2]); return;
    }
    if (/^\w+\.resize\(0\)$/.test(st)) return;
    // Local scalar declarations / reassignments (the rule conditions read them).
    // (First declaration wins: a later one is a shadowing local in an unrelated block.)
    if ((m = /^(?:const\s+)?(?:bool|int|double|float|auto|size_t|unsigned int|std::string|[A-Z]\w*(?:::\w+)?)\s*[&*]?\s+(\w+)\s*=\s*([\s\S]+)$/.exec(st))) {
      if (locals[m[1]] === undefined) locals[m[1]] = norm(m[2]);
      return;
    }
    if ((m = /^(?:const\s+)?(?:bool|int|double|float)\s+(\w+)$/.exec(st))) { locals[m[1]] = ''; return; }
    if ((m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(st)) && locals[m[1]] !== undefined) { locals[m[1]] = `${locals[m[1]]} ; = ${norm(m[2])}`; }
  }

  function walk(src, guards, loopVar, loopKey) {
    let i = 0;
    const n = src.length;
    const skipWs = () => { while (i < n && /\s/.test(src[i])) i++; };
    while (i < n) {
      skipWs();
      if (i >= n) break;
      const rest = src.slice(i);
      let m;
      if (src[i] === '{') { const b = balanced(src, i); walk(b, guards, loopVar, loopKey); i += b.length + 2; continue; }
      if ((m = /^if\s*\(/.exec(rest))) {
        const open = i + m[0].length - 1;
        const cond = balanced(src, open);
        i = open + cond.length + 2;
        const thenStart = i;
        i = skipStatement(src, i);
        const thenSrc = src.slice(thenStart, i);
        const g = cleanGuard(cond);
        walk(thenSrc, g ? [...guards, g] : guards, loopVar, loopKey);
        const save = i; skipWs();
        if (/^else\b/.test(src.slice(i))) {
          i += 4;
          const elseStart = i;
          i = skipStatement(src, i);
          walk(src.slice(elseStart, i), g ? [...guards, `!(${g})`] : guards, loopVar, loopKey);
        } else i = save;
        continue;
      }
      if ((m = /^for\s*\(/.exec(rest))) {
        const open = i + m[0].length - 1;
        const head = balanced(src, open);
        i = open + head.length + 2;
        const bodyStart = i;
        i = skipStatement(src, i);
        const loopBody = src.slice(bodyStart, i);
        const h = /(\w+)\s*:\s*([\s\S]+)$/.exec(head);
        if (!h) continue;
        const listExpr = h[2].trim();
        const keys = listExpr.startsWith('{') ? literals(listExpr) : lists[listExpr];
        if (!keys) continue; // a loop over something else (values, extruders): no toggles of ours
        for (const k of keys) walk(loopBody, guards, h[1], k);
        continue;
      }
      const end = skipStatement(src, i);
      const st = src.slice(i, end).trim().replace(/;$/, '').trim();
      i = end;
      if (st) statement(st, guards, loopVar, loopKey);
    }
  }

  function skipStatement(src, i) {
    const n = src.length;
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === '{') return i + balanced(src, i).length + 2;
    const rest = src.slice(i);
    if (/^(if|for|while)\s*\(/.test(rest)) {
      const open = src.indexOf('(', i);
      let j = open + balanced(src, open).length + 2;
      j = skipStatement(src, j);
      const k = j; let t = k; while (t < n && /\s/.test(src[t])) t++;
      if (/^if/.test(rest) && /^else\b/.test(src.slice(t))) return skipStatement(src, t + 4);
      return j;
    }
    let depth = 0;
    for (let j = i; j < n; j++) {
      const c = src[j];
      if (c === '"' || c === '\'') { const q = c; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) return j + 1;
    }
    return n;
  }

  walk(body, [], null, null);
  return { toggles, locals };
}

function extractRules(tabSrc, cmSrc) {
  const tab = stripIfZero(stripComments(tabSrc));
  const cm = stripIfZero(stripComments(cmSrc));
  const out = {};
  const parts = {
    print: [functionBody(cm, 'ConfigManipulation::toggle_print_fff_options'), functionBody(tab, 'TabPrint::toggle_options')],
    printer: [functionBody(tab, 'TabPrinter::toggle_options')],
    filament: [functionBody(tab, 'TabFilament::toggle_options')],
  };
  for (const [family, bodies] of Object.entries(parts)) {
    const toggles = []; const locals = {};
    for (const b of bodies) {
      if (b === null) { console.warn(`rules: a ${family} toggle function was not found`); continue; }
      const r = extractToggles(b);
      toggles.push(...r.toggles);
      for (const [k, v] of Object.entries(r.locals)) if (locals[k] === undefined) locals[k] = v;
    }
    // Only locals a condition can read.
    const used = new Set();
    const texts = toggles.flatMap((t) => [t.when ?? '', ...(t.guards ?? []), ...textConds(t.reason), ...textConds(t.text)]);
    // (Identifiers used as a receiver — `printer_cfg.opt_bool(…)` — are configs, not values.)
    const scan = (s) => { for (const m of s.matchAll(/\b([a-zA-Z_]\w*)\b(?!\s*(?:\.|->))/g)) { const id = m[1]; if (locals[id] !== undefined && !used.has(id)) { used.add(id); scan(locals[id]); } } };
    texts.forEach(scan);
    out[family] = { toggles, locals: Object.fromEntries(Object.entries(locals).filter(([k]) => used.has(k)).sort(([a], [b]) => a.localeCompare(b))) };
  }
  return out;
}

/**
 * Enum constants the rule conditions compare against (`InfillPattern::ipGyroid`, `btNoBrim`), mapped to
 * the config value strings through PrintConfig.cpp's s_keys_map_* tables.
 */
function ruleEnums(rules, enumMaps) {
  const out = {};
  const texts = Object.values(rules).flatMap((r) => [...Object.values(r.locals), ...r.toggles.flatMap((t) => [t.when ?? '', ...(t.guards ?? []), ...textConds(t.reason), ...textConds(t.text)])]);
  const lookup = (name) => {
    const parts = name.split('::');
    const c = parts.pop();
    if (parts.length && enumMaps[parts[parts.length - 1]]?.[c] !== undefined) return enumMaps[parts[parts.length - 1]][c];
    const hits = Object.values(enumMaps).filter((mm) => mm[c] !== undefined).map((mm) => mm[c]);
    if (!hits.length) return undefined;
    if (new Set(hits).size > 1 && !parts.length) throw new Error(`rules: ambiguous enum constant ${name}`);
    return hits[0];
  };
  for (const t of texts) {
    for (const m of t.matchAll(/\b(?:[A-Z]\w*::)?(?:[a-z]{1,4}[A-Z0-9]\w*|[A-Z]\w*)\b/g)) {
      const name = m[0];
      if (out[name] !== undefined || !/::|^[a-z]/.test(name)) continue;
      const v = lookup(name);
      if (v !== undefined) out[name] = v;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
const textConds = (t) => (t && typeof t === 'object' ? [t.if, ...textConds(t.then), ...textConds(t.else)] : []);

// ---------------------------------------------------------------------------
// G-code placeholders (EditGCodeDialog::init_params_list)
// ---------------------------------------------------------------------------

const PLACEHOLDER_CLASSES = [
  ['readOnlyStates', 'ReadOnlySlicingStatesConfigDef'],
  ['readWriteStates', 'ReadWriteSlicingStatesConfigDef'],
  ['otherStates', 'OtherSlicingStatesConfigDef'],
  ['statistics', 'PrintStatisticsConfigDef'],
  ['objects', 'ObjectsInfoConfigDef'],
  ['dimensions', 'DimensionsConfigDef'],
  ['temperatures', 'TemperaturesConfigDef'],
  ['timestamps', 'TimestampsConfigDef'],
  ['presets', 'OtherPresetsConfigDef'],
  ['specific', 'CustomGcodeSpecificConfigDef'],
];
const VECTOR_TYPES = new Set(['floats', 'ints', 'strings', 'bools', 'percents', 'floatsOrPercents', 'points']);

function extractPlaceholders(pcSrc) {
  const code = expandMacros(stripComments(pcSrc));
  const groups = {};
  for (const [id, cls] of PLACEHOLDER_CLASSES) {
    const body = functionBody(code, `${cls}::${cls}`);
    if (body === null) { console.warn(`placeholders: ${cls} not found`); groups[id] = []; continue; }
    const opts = extractSchema(`\n${body}\n`, { overrideKeys: [], axisDefaults: null, prefixForOverride: (k) => k });
    groups[id] = Object.entries(opts).map(([key, d]) => [key, VECTOR_TYPES.has(d.type), d.label || d.fullLabel || key, d.tooltip]);
  }
  const mapM = /s_CustomGcodeSpecificPlaceholders\s*\{/.exec(code);
  const specificFor = {};
  if (mapM) {
    const body = balanced(code, mapM.index + mapM[0].length - 1);
    for (const row of body.matchAll(/\{\s*"(\w+)"\s*,\s*\{([^}]*)\}\s*\}/g)) specificFor[row[1]] = literals(row[2]);
  }
  return { groups, specificFor };
}

// ---------------------------------------------------------------------------
// preFlight OrcaKeyMapping.cpp
// ---------------------------------------------------------------------------

function extractKeyMap(src) {
  const code = stripComments(src);
  const out = {};
  for (const [fn, type] of [['build_printer_mappings', 'machine'], ['build_filament_mappings', 'filament'], ['build_process_mappings', 'process']]) {
    const m = new RegExp(`OrcaKeyMapper::${fn}\\s*\\(\\s*\\)\\s*\\{`).exec(code);
    if (!m) continue;
    const body = balanced(code, m.index + m[0].length - 1);
    const map = {};
    for (const e of body.matchAll(/\b(DIRECT|RENAMED|XFORM|ORCA_ONLY|SKIP)\s*\(([^)]*)\)/g)) {
      const lits = literals(e[2]);
      const orcaKey = lits[0];
      if (!orcaKey || map[orcaKey]) continue;
      if (e[1] === 'DIRECT') map[orcaKey] = { to: orcaKey };
      else if (e[1] === 'RENAMED') map[orcaKey] = { to: lits[1] };
      else if (e[1] === 'XFORM') { const fnm = /,\s*(\w+)\s*$/.exec(e[2]); map[orcaKey] = { to: lits[1], transform: fnm && fnm[1] !== 'nullptr' ? fnm[1] : undefined }; }
      else if (e[1] === 'ORCA_ONLY') map[orcaKey] = { to: null };
      else map[orcaKey] = { to: null, skip: true };
    }
    out[type] = map;
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function writeJson(rel, obj) {
  const p = resolve(repo, rel); mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 1) + '\n');
  console.log(`wrote ${rel} (${Object.keys(obj.options ?? obj).length} entries)`);
}
function writeText(rel, text) { const p = resolve(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); console.log(`wrote ${rel}`); }

function orcaAxisDefaults(key) {
  const t = {
    x: { speed: [500, 200], acc: [1000, 1000], jerk: [10, 10] },
    y: { speed: [500, 200], acc: [1000, 1000], jerk: [10, 10] },
    z: { speed: [12, 12], acc: [500, 200], jerk: [0.2, 0.4] },
    e: { speed: [120, 120], acc: [5000, 5000], jerk: [2.5, 2.5] },
  };
  const a = t[key.slice(-1)]; if (!a) return null;
  return { 'axis.max_feedrate': a.speed.map(String), 'axis.max_acceleration': a.acc.map(String), 'axis.max_jerk': a.jerk.map(String) };
}

function loadConstants(texts) {
  for (const t of texts) for (const m of t.matchAll(/#define\s+([A-Z_][A-Z0-9_]*)\s+(-?[\d.]+)f?\b/g)) CONSTANTS[m[1]] = String(Number(m[2]));
}

function buildOrca() {
  const version = orcaVersion();
  const note = `OrcaSlicer ${version}${ORCA_REF ? ` (${ORCA_REF})` : ''}`;
  for (const k of Object.keys(CONSTANTS)) delete CONSTANTS[k];
  try { loadConstants([orcaFile('libslic3r/PrintConfigConstants.hpp'), orcaFile('libslic3r/PrintConfig.hpp'), orcaFile('libslic3r/libslic3r.h')]); } catch { /* optional */ }
  const pc = orcaFile('libslic3r/PrintConfig.cpp');
  const hpp = stripComments(orcaFile('libslic3r/PrintConfig.hpp'));
  const preset = stripComments(orcaFile('libslic3r/Preset.cpp'));
  // Only PrintConfigDef, like cs_describe_config: the CLI / slicing-state / placeholder ConfigDefs
  // further down are not preset options.
  const pcCode = stripComments(pc);
  const cliStart = pcCode.search(/\nCLIActionsConfigDef::CLIActionsConfigDef\(\)/);
  const overrideKeys = stringListNamed(pcCode, 'filament_extruder_override_keys');
  const options = extractSchema(cliStart > 0 ? pcCode.slice(0, cliStart) : pcCode, {
    overrideKeys, axisDefaults: orcaAxisDefaults,
    prefixForOverride: (k) => k.replace(/^filament_/, ''),
  });
  const extruderKeys = stringListNamed(pcCode, 'm_extruder_option_keys');
  const objectKeys = new Set([...classMembers(hpp, 'PrintObjectConfig'), ...classMembers(hpp, 'PrintRegionConfig')]);
  assignScopes(options, {
    print: stringListNamed(preset, 's_Preset_print_options'),
    filament: [...stringListNamed(preset, 's_Preset_filament_options'), ...overrideKeys],
    machine: [...stringListNamed(preset, 's_Preset_printer_options'), ...stringListNamed(preset, 's_Preset_machine_limits_options'), ...extruderKeys],
    objectKeys,
  });
  writeJson('src/settings/__fixtures__/orca-schema.sample.json', { engine: 'orca', version, options });

  const keys = new Set(Object.keys(options));
  if (SCHEMA_JSON) for (const k of Object.keys(JSON.parse(readFileSync(SCHEMA_JSON, 'utf8')).options ?? {})) keys.add(k);
  const tab = orcaFile('slic3r/GUI/Tab.cpp');
  let tables = {};
  try { tables = tableFunctions(stripComments(orcaFile('libslic3r/PublishSettings.cpp'))); } catch { /* pre-2.5 */ }
  const layout = {
    print: extractLayout(tab, ['TabPrint::build'], keys, tables),
    filament: extractLayout(tab, ['TabFilament::build', 'TabFilament::add_filament_overrides_page'], keys, tables),
    machine: extractLayout(tab, ['TabPrinter::build_fff', 'TabPrinter::build_kinematics_page', 'TabPrinter::build_unregular_pages'], keys, tables),
  };
  writeText('src/settings/layout/orca.generated.ts', emitLayoutTs('orca', layout, `${note} src/slic3r/GUI/Tab.cpp`));

  const wiki = {
    ...extractWikiPaths(tab, ['TabPrint::build'], keys, tables),
    ...extractWikiPaths(tab, ['TabFilament::build', 'TabFilament::add_filament_overrides_page'], keys, tables),
    ...extractWikiPaths(tab, ['TabPrinter::build_fff', 'TabPrinter::build_kinematics_page', 'TabPrinter::build_unregular_pages'], keys, tables),
  };
  writeText('src/settings/layout/orcaWiki.generated.ts', `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from ${note} src/slic3r/GUI/Tab.cpp — do not edit.
 * Option key → its row's wiki path (Line::label_path); the row label links to
 * https://www.orcaslicer.com/wiki/<path> (OptionsGroup::get_url). Keys without a path have no link.
 */
export const orcaWikiPaths: Record<string, string> = ${JSON.stringify(Object.fromEntries(Object.entries(wiki).sort(([a], [b]) => a.localeCompare(b))), null, 1)};
`);

  const rules = extractRules(tab, orcaFile('slic3r/GUI/ConfigManipulation.cpp'));
  rules.enums = ruleEnums(rules, parseEnumMaps(pcCode));
  writeText('src/settings/rules/orca.generated.ts', `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from ${note} src/slic3r/GUI/ConfigManipulation.cpp
 * (toggle_print_fff_options) and Tab.cpp (TabPrint / TabPrinter / TabFilament ::toggle_options) — do not edit.
 *
 * Every toggle_field / toggle_option (\`enable\`), toggle_line (\`show\`) and set_option_label (\`label\`) call in
 * source order, loops expanded per key (\`$key\` in a condition is the loop's key), with the \`if\` guards around
 * it. \`when\` / \`guards\` are the C++ conditions verbatim (whitespace collapsed): ./orca.ts ports each one, and
 * ./rules.test.ts fails when a condition or a local it reads has no port or its C++ text changed.
 */
import type { RulesSource } from './types';

export const orcaRulesGenerated: RulesSource = ${JSON.stringify(rules, null, 2)};
`);

  const ph = extractPlaceholders(pc);
  writeText('src/dialogs/gcode/placeholders.generated.ts', `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from ${note} src/libslic3r/PrintConfig.cpp — do not edit.
 * The *ConfigDef classes EditGCodeDialog lists (slicing states, statistics, objects, dimensions,
 * temperatures, timestamps, presets, G-code specific) as [key, vector, label, tooltip], and
 * s_CustomGcodeSpecificPlaceholders (which specific placeholders each G-code option gets).
 */
export type PlaceholderDef = [key: string, vector: boolean, label: string, tooltip: string];
export const orcaPlaceholderGroups: Record<${PLACEHOLDER_CLASSES.map(([id]) => `'${id}'`).join(' | ')}, PlaceholderDef[]> = ${JSON.stringify(ph.groups, null, 1)};
export const orcaSpecificPlaceholders: Record<string, string[]> = ${JSON.stringify(ph.specificFor, null, 1)};
`);
}

/**
 * MaterialType.cpp's table (name, nozzle min / max, chamber min / max, …) and its defaults, for the
 * filament checks ConfigManipulation runs (recommended nozzle / chamber temperature ranges).
 */
function buildOrcaMaterials() {
  const version = orcaVersion();
  const src = stripComments(orcaFile('libslic3r/MaterialType.cpp'));
  const rows = [...src.matchAll(/\{\s*"([^"]+)"\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,/g)]
    .map((m) => [m[1], +m[2], +m[3], +m[4], +m[5]]);
  const c = (name) => { const m = new RegExp(`${name}\\s*=\\s*(-?[\\d.]+)`).exec(src); return m ? +m[1] : undefined; };
  if (!rows.length) throw new Error('MaterialType.cpp: no table rows found');
  writeText('src/settings/rules/materialTypes.generated.ts', `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from OrcaSlicer ${version}${ORCA_REF ? ` (${ORCA_REF})` : ''} src/libslic3r/MaterialType.cpp — do not edit.
 * [filament type, nozzle min °C, nozzle max °C, chamber min °C, chamber max °C]; lookups are by exact name.
 */
export const MATERIAL_DEFAULTS = { minTemp: ${c('DEFAULT_MIN_TEMP')}, maxTemp: ${c('DEFAULT_MAX_TEMP')}, chamberMin: ${c('DEFAULT_CHAMBER_MIN_TEMP')}, chamberMax: ${c('DEFAULT_CHAMBER_MAX_TEMP')} };
export const MATERIAL_TYPES: Array<[string, number, number, number, number]> = ${JSON.stringify(rows)};
`);
}

function buildPreflight() {
  for (const k of Object.keys(CONSTANTS)) delete CONSTANTS[k];
  for (const f of ['libslic3r/PrintConfigConstants.hpp', 'libslic3r/PrintConfig.hpp', 'libslic3r/libslic3r.h']) { try { loadConstants([pfFile(f)]); } catch { /* optional */ } }
  const pc = pfFile('libslic3r/PrintConfig.cpp');
  const hpp = stripComments(pfFile('libslic3r/PrintConfig.hpp'));
  const preset = stripComments(pfFile('libslic3r/Preset.cpp'));
  const pcCode = stripComments(pc);
  // filament_<key> nullable overrides: `for (const char *opt_key : { ... })` loops that add "filament_" + opt_key.
  const overrideKeys = [];
  for (const m of pcCode.matchAll(/for\s*\(\s*const\s+char\s*\*\s*opt_key\s*:\s*\{/g)) {
    const list = balanced(pcCode, m.index + m[0].length - 1);
    const after = pcCode.slice(m.index, m.index + list.length + 600);
    if (/add_nullable\(\s*std::string\("filament_"\)\s*\+\s*opt_key/.test(after)) overrideKeys.push(...literals(list).map((k) => `filament_${k}`));
  }
  const options = extractSchema(pc, {
    overrideKeys,
    axisDefaults: (key) => {
      const d = orcaAxisDefaults(key); if (!d) return null;
      return d;
    },
    prefixForOverride: (k) => k.replace(/^filament_/, ''),
  });
  const extruderKeys = stringListNamed(pcCode, 'm_extruder_option_keys');
  const objectKeys = new Set([...classMembers(hpp, 'PrintObjectConfig'), ...classMembers(hpp, 'PrintRegionConfig')]);
  assignScopes(options, {
    print: stringListNamed(preset, 's_Preset_print_options'),
    filament: [...stringListNamed(preset, 's_Preset_filament_options'), ...overrideKeys],
    machine: [...stringListNamed(preset, 's_Preset_printer_options'), ...stringListNamed(preset, 's_Preset_machine_limits_options'), ...extruderKeys],
    objectKeys,
  });
  writeJson('src/settings/__fixtures__/preflight-schema.sample.json', { engine: 'preflight', version: PF_REF.replace(/^v/, ''), options });

  const keys = new Set(Object.keys(options));
  const tab = pfFile('slic3r/GUI/Tab.cpp');
  const layout = {
    print: extractLayout(tab, ['TabPrint::build'], keys),
    filament: extractLayout(tab, ['TabFilament::build', 'TabFilament::add_filament_overrides_page'], keys),
    machine: extractLayout(tab, ['TabPrinter::build_fff', 'TabPrinter::build_kinematics_page', 'TabPrinter::build_extruder_pages', 'TabPrinter::build_unregular_pages'], keys),
  };
  writeText('src/settings/layout/preflight.generated.ts', emitLayoutTs('preflight', layout, `preFlight ${PF_REF} src/slic3r/GUI/Tab.cpp`));

  const km = extractKeyMap(pfFile('libslic3r/OrcaKeyMapping.cpp'));
  writeText('src/presets/preflight/orcaKeyMap.generated.ts', `/**
 * GENERATED by scripts/dev/extract-engine-meta.mjs from preFlight ${PF_REF} src/libslic3r/OrcaKeyMapping.cpp.
 * Orca preset key → preFlight key. \`to: null\` = Orca-only / ignored (dropped on import).
 */
export interface OrcaKeyMapEntry { to: string | null; transform?: string; skip?: boolean }
export const orcaKeyMapGenerated: Record<'machine' | 'filament' | 'process', Record<string, OrcaKeyMapEntry>> = ${JSON.stringify(km, null, 1)};
`);
}

if (ONLY === 'materials') buildOrcaMaterials();
else if (ONLY !== 'preflight') { buildOrca(); buildOrcaMaterials(); }
if (ONLY !== 'orca' && ONLY !== 'materials') { try { buildPreflight(); } catch (e) { console.warn(`preflight extraction failed: ${e.message}`); } }
