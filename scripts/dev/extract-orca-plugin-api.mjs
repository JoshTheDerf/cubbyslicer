#!/usr/bin/env node
/**
 * Extract the Python API surface of OrcaSlicer's `orca` plugin module from its
 * pybind11 bindings (src/slic3r/plugin/**.cpp) into
 * src/plugins/runtime/python/orca-api.json. The shim conformance test
 * (src/plugins/runtime/shimApi.test.ts) compares CubbySlicer's `orca`
 * package against that snapshot, so an unmodified Orca plugin finds every
 * name it can find in OrcaSlicer.
 *
 *   node scripts/dev/extract-orca-plugin-api.mjs <orca source dir>
 *
 * Output shape: { version, modules: { "orca.host.ui": { functions: [...],
 * attributes: [...], classes: { UiWindow: [...members] }, enums: { NotificationLevel:
 * { values: [...], exported: true } }, submodules: [...] } } }.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const orcaDir = process.argv[2];
if (!orcaDir) { console.error('usage: extract-orca-plugin-api.mjs <orca source dir>'); process.exit(2); }
const pluginDir = join(orcaDir, 'src/slic3r/plugin');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../src/plugins/runtime/python/orca-api.json');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.cpp') ? [p] : [];
  });
}

/** Strip comments and replace string-literal contents with placeholders we can still read names from. */
function tokenize(src) {
  // Returns the source with comments removed; strings kept verbatim. Raw strings are collapsed to "".
  let o = '';
  for (let i = 0; i < src.length;) {
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { i = src.indexOf('*/', i + 2) + 2; continue; }
    const raw = /^R"([^(]*)\(/.exec(src.slice(i, i + 40));
    if (raw) { const end = src.indexOf(`)${raw[1]}"`, i); o += '""'; i = end + raw[1].length + 2; continue; }
    if (src[i] === '"' || (src[i] === "'" )) {
      const q = src[i]; let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      o += src.slice(i, j + 1); i = j + 1; continue;
    }
    o += src[i++];
  }
  return o;
}

/** End index (exclusive, at ';') of the statement starting at `start`, skipping nested (), {}, [] and strings. */
function statementEnd(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } i = j; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return i;
  }
  return s.length;
}

/** Index of the ')' closing a call whose '(' was already consumed (depth 1 at index 0). */
function closeParen(s) {
  let depth = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/** Top-level `.name("x"` calls in a chained statement (depth 0 relative to the chain). */
function chainCalls(stmt) {
  const calls = [];
  let depth = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < stmt.length && stmt[j] !== c) { if (stmt[j] === '\\') j++; j++; } i = j; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '.' && depth === 0) {
      const m = /^\.(\w+)\s*\(\s*(?:"([^"]*)"|(py::init))?/.exec(stmt.slice(i, i + 200));
      if (m) calls.push({ method: m[1], name: m[2] ?? (m[3] ? '__init__' : null) });
    }
  }
  return calls;
}

const modules = {};
const mod = (path) => (modules[path] ??= { functions: [], attributes: [], classes: {}, enums: {}, submodules: [] });
const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

for (const file of walk(pluginDir)) {
  const src = tokenize(readFileSync(file, 'utf8'));
  if (!/py::class_|py::enum_|\.def\(|def_submodule/.test(src)) continue;
  // Variable → module path. Function parameters named m / module are `orca`; host is `orca.host`.
  const vars = { m: 'orca', module: 'orca', host: 'orca.host' };
  const subRe = /auto\s+(\w+)\s*=\s*(\w+)\s*\.\s*def_submodule\s*\(\s*"(\w+)"/g;
  for (let r; (r = subRe.exec(src));) {
    const parent = vars[r[2]] ?? 'orca';
    vars[r[1]] = `${parent}.${r[3]}`;
    add(mod(parent).submodules, r[3]);
    mod(vars[r[1]]);
  }
  // Classes and enums.
  const clsRe = /py::(class_|enum_)\s*<([\s\S]*?)>\s*\(\s*(\w+)\s*,\s*"(\w+)"/g;
  for (let r; (r = clsRe.exec(src));) {
    const path = vars[r[3]];
    if (!path) continue;
    const end = statementEnd(src, r.index);
    const stmt = src.slice(r.index + r[0].length, end);
    const calls = chainCalls(stmt.slice(closeParen(stmt) + 1));
    if (r[1] === 'enum_') {
      const values = calls.filter((c) => c.method === 'value').map((c) => c.name);
      mod(path).enums[r[4]] = { values, exported: calls.some((c) => c.method === 'export_values') };
    } else {
      const members = mod(path).classes[r[4]] ??= [];
      for (const c of calls) if (c.name && /^def/.test(c.method)) add(members, c.name);
      // `auto layer = py::class_<…>(host, "Layer"); layer.def(…)…;`
      const before = src.slice(Math.max(0, r.index - 80), r.index);
      const assigned = /auto\s+(\w+)\s*=\s*$/.exec(before);
      if (assigned) {
        const chainRe = new RegExp(`(?:^|[;{}])\\s*${assigned[1]}\\s*\\.`, 'g');
        for (let q; (q = chainRe.exec(src));) {
          const at = src.indexOf(assigned[1], q.index);
          const stmtEnd = statementEnd(src, at);
          for (const c of chainCalls(src.slice(at + assigned[1].length, stmtEnd))) if (c.name && /^def/.test(c.method)) add(members, c.name);
        }
      }
    }
  }
  // Module functions and attributes: `<var>.def("name"` / `<var>.attr("NAME") =` at statement start.
  const fnRe = /(?:^|[;{}\n])\s*(\w+)\s*\.\s*def\s*\(\s*"(\w+)"/g;
  for (let r; (r = fnRe.exec(src));) if (vars[r[1]]) add(mod(vars[r[1]]).functions, r[2]);
  const attrRe = /(?:^|[;{}\n])\s*(\w+)\s*\.\s*attr\s*\(\s*"(\w+)"\s*\)\s*=/g;
  for (let r; (r = attrRe.exec(src));) if (vars[r[1]]) add(mod(vars[r[1]]).attributes, r[2]);
  void relative;
}

for (const m of Object.values(modules)) {
  m.functions.sort(); m.attributes.sort(); m.submodules.sort();
  m.classes = Object.fromEntries(Object.entries(m.classes).sort().map(([k, v]) => [k, v.sort()]));
  m.enums = Object.fromEntries(Object.entries(m.enums).sort());
}
const version = (() => { try { return /SoftFever_VERSION\s+"([^"]+)"/.exec(readFileSync(join(orcaDir, 'version.inc'), 'utf8'))?.[1] ?? '2.5.0'; } catch { return '2.5.0'; } })();
writeFileSync(out, JSON.stringify({ source: 'OrcaSlicer src/slic3r/plugin bindings', version, modules: Object.fromEntries(Object.entries(modules).sort()) }, null, 1) + '\n');
console.log(`wrote ${out}: ${Object.keys(modules).length} modules`);
