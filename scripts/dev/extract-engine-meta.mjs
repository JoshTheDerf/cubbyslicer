#!/usr/bin/env node
/**
 * Dev-only extractor for engine metadata the settings UI needs before the
 * engine builds publish `public/wasm/<engine>/schema.json`.
 *
 * Parses the C++ sources of both engines and writes:
 *   src/settings/__fixtures__/orca-schema.sample.json       (Schema JSON shape, ENGINE-CONTRACT.md)
 *   src/settings/__fixtures__/preflight-schema.sample.json
 *   src/settings/layout/orca.generated.ts                    (Tab.cpp pages → groups → keys)
 *   src/settings/layout/preflight.generated.ts
 *   src/presets/preflight/orcaKeyMap.generated.ts            (OrcaKeyMapping.cpp tables)
 *
 * The schema fixtures are only a fallback / test fixture. At runtime the real
 * `schema.json` produced by `cs_describe_config` always wins.
 *
 * Usage:
 *   node scripts/dev/extract-engine-meta.mjs [--orca <orca src dir>] [--preflight <preflight git dir>] [--ref v1.3.0]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const ORCA = arg('--orca', '/server/thederf/slicers/orcaslicer-wasm/orca/src');
const PF_GIT = arg('--preflight', '/server/thederf/slicers/preflight');
const PF_REF = arg('--ref', 'v1.3.0');

const orcaFile = (p) => readFileSync(resolve(ORCA, p), 'utf8');
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
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } continue; }
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
      if (type) return '';
      return '';
  }
}

function splitTop(s) {
  const out = []; let depth = 0; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '{' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === '}' || c === ']' || c === '>') depth--;
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
    if (lits.length) def[key] = lits.join('');
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

function extractSchema(src, { overrideKeys, axisDefaults, prefixForOverride }) {
  const code = stripComments(src);
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

const OPTION_CALL = /(append_single_option_line|get_option|create_line_with_widget|append_option_line|Option\s*\(\s*def\s*,|add_option_line)\s*\(?/;

function extractLayout(tabSrc, fnNames, schemaKeys) {
  const code = stripComments(tabSrc);
  const pages = [];
  for (const fn of fnNames) {
    const re = new RegExp(`\\n[\\w:<>*& ]*\\b${fn.replace(/::/g, '::')}\\s*\\([^)]*\\)\\s*(?:const\\s*)?\\{`);
    const m = re.exec(code);
    if (!m) { console.warn(`layout: function ${fn} not found`); continue; }
    const body = balanced(code, m.index + m[0].length - 1);
    let page = null, group = null;
    const seen = new Set(pages.flatMap((p) => p.groups.flatMap((g) => g.keys)));
    const push = (key) => {
      if (!schemaKeys.has(key) || !group) return;
      if (group.keys.includes(key)) return;
      if (!page.extruder && seen.has(key)) return;
      group.keys.push(key); seen.add(key);
    };
    for (const line of body.split('\n')) {
      let mm;
      if ((mm = /add_options_page\(\s*(?:_?L\(\s*)?(?:"([^"]+)"|(\w+))/.exec(line))) {
        const extruder = !mm[1];
        const title = mm[1] ?? 'Extruder';
        page = pages.find((p) => p.title === title) ?? null;
        if (!page) { page = { title, extruder, groups: [] }; pages.push(page); }
        group = null;
        continue;
      }
      if (!page) continue;
      if ((mm = /new_optgroup\w*\(\s*(?:_?L\(\s*)?(?:"([^"]*)"|(\w+))?/.exec(line))) {
        const title = mm[1] ?? '';
        group = page.groups.find((g) => g.title === title) ?? null;
        if (!group) { group = { title, keys: [] }; page.groups.push(group); }
        continue;
      }
      const isCall = OPTION_CALL.test(line);
      const bare = /^\s*"[a-z][a-z0-9_]*"\s*,?\s*$/.test(line) || /^\s*(?:"[a-z][a-z0-9_]*"\s*,\s*)+"[a-z][a-z0-9_]*"?\s*,?\s*$/.test(line);
      if (!isCall && !bare) continue;
      // "machine_max_acceleration_" + axis  → expand over x/y/z/e
      for (const pm of line.matchAll(/"([a-z][a-z0-9_]*_)"\s*\+\s*\w+/g)) for (const a of ['x', 'y', 'z', 'e']) push(pm[1] + a);
      for (const km of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) push(km[1]);
    }
  }
  return pages.map((p) => ({ ...p, groups: p.groups.filter((g) => g.keys.length) })).filter((p) => p.groups.length);
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
  for (const k of Object.keys(CONSTANTS)) delete CONSTANTS[k];
  try { loadConstants([orcaFile('libslic3r/PrintConfigConstants.hpp'), orcaFile('libslic3r/PrintConfig.hpp'), orcaFile('libslic3r/libslic3r.h')]); } catch { /* optional */ }
  const pc = orcaFile('libslic3r/PrintConfig.cpp');
  const hpp = stripComments(orcaFile('libslic3r/PrintConfig.hpp'));
  const preset = stripComments(orcaFile('libslic3r/Preset.cpp'));
  const overrideKeys = stringListNamed(stripComments(pc), 'filament_extruder_override_keys');
  const options = extractSchema(pc, {
    overrideKeys, axisDefaults: orcaAxisDefaults,
    prefixForOverride: (k) => k.replace(/^filament_/, ''),
  });
  const extruderKeys = stringListNamed(stripComments(pc), 'm_extruder_option_keys');
  const objectKeys = new Set([...classMembers(hpp, 'PrintObjectConfig'), ...classMembers(hpp, 'PrintRegionConfig')]);
  assignScopes(options, {
    print: stringListNamed(preset, 's_Preset_print_options'),
    filament: [...stringListNamed(preset, 's_Preset_filament_options'), ...overrideKeys],
    machine: [...stringListNamed(preset, 's_Preset_printer_options'), ...stringListNamed(preset, 's_Preset_machine_limits_options'), ...extruderKeys],
    objectKeys,
  });
  const schema = { engine: 'orca', version: '2.4.2', options };
  writeJson('src/settings/__fixtures__/orca-schema.sample.json', schema);

  const keys = new Set(Object.keys(options));
  const tab = orcaFile('slic3r/GUI/Tab.cpp');
  const layout = {
    print: extractLayout(tab, ['TabPrint::build'], keys),
    filament: extractLayout(tab, ['TabFilament::build', 'TabFilament::add_filament_overrides_page'], keys),
    machine: extractLayout(tab, ['TabPrinter::build_fff', 'TabPrinter::build_kinematics_page', 'TabPrinter::build_unregular_pages'], keys),
  };
  writeText('src/settings/layout/orca.generated.ts', emitLayoutTs('orca', layout, 'OrcaSlicer v2.4.2 src/slic3r/GUI/Tab.cpp'));
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

buildOrca();
try { buildPreflight(); } catch (e) { console.warn(`preflight extraction failed: ${e.message}`); }
