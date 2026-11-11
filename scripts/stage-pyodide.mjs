#!/usr/bin/env node
/**
 * Stage the Pyodide runtime for Orca Python plugins into public/pyodide/<version>/
 * (not committed; served from the app's own origin, the page is COEP require-corp).
 *
 *   node scripts/stage-pyodide.mjs            # core + the default packages
 *   PYODIDE_PACKAGES=numpy,shapely node scripts/stage-pyodide.mjs
 *   PYODIDE_ALL=1 node scripts/stage-pyodide.mjs   # every package in the distribution (~250 MB)
 *
 * Core files come from the `pyodide` npm package (exact version pinned in
 * package.json). Distribution packages (micropip and what plugins import) are
 * downloaded once from the Pyodide release on jsDelivr and checked against the
 * sha256 in pyodide-lock.json; already-staged files that match are kept.
 *
 * Nothing Pyodide-related loads in the app until a plugin is enabled or the
 * Plugins dialog needs it (src/plugins/runtime/client.ts).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules/pyodide');
if (!existsSync(join(pkgDir, 'package.json'))) { console.error('error: node_modules/pyodide missing (npm install)'); process.exit(1); }
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const dest = join(root, 'public/pyodide', version);
mkdirSync(dest, { recursive: true });

const CORE = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
for (const f of CORE) copyFileSync(join(pkgDir, f), join(dest, f));

const lock = JSON.parse(readFileSync(join(pkgDir, 'pyodide-lock.json'), 'utf8'));
// micropip installs plugin dependencies; numpy is what the Orca samples use (Inspector,
// optional paths of the slicing samples); pyclipper backs geometry outside slicing hooks.
const DEFAULT = ['micropip', 'numpy', 'pyclipper'];
const wanted = process.env.PYODIDE_ALL ? Object.keys(lock.packages)
  : [...new Set([...DEFAULT, ...(process.env.PYODIDE_PACKAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean)])];

const all = new Set();
const visit = (name) => {
  const p = lock.packages[name];
  if (!p) { console.error(`error: ${name} is not in Pyodide ${version}'s distribution`); process.exit(1); }
  if (all.has(name)) return;
  all.add(name);
  for (const d of p.depends) visit(d);
};
wanted.forEach(visit);

const base = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
let fetched = 0, kept = 0, bytes = 0;
for (const name of [...all].sort()) {
  const { file_name: file, sha256: sum } = lock.packages[name];
  const target = join(dest, file);
  if (existsSync(target) && sha256(readFileSync(target)) === sum) { kept++; bytes += readFileSync(target).length; continue; }
  const res = await fetch(base + file);
  if (!res.ok) { console.error(`error: ${base + file}: HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== sum) { console.error(`error: ${file}: sha256 mismatch`); process.exit(1); }
  writeFileSync(target, buf);
  fetched++; bytes += buf.length;
}
writeFileSync(join(dest, 'staged.json'), JSON.stringify({ version, packages: [...all].sort() }, null, 1) + '\n');
console.log(`staged Pyodide ${version} → public/pyodide/${version}/ (${CORE.length} core files, ${all.size} packages: ${fetched} downloaded, ${kept} kept, ${(bytes / 1048576).toFixed(1)} MB of packages)`);
