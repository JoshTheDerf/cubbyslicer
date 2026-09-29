#!/usr/bin/env node
/**
 * Pack each Orca-style vendor tree into one JSON per vendor so the browser
 * catalog needs one request per vendor instead of one per preset file:
 *
 *   <profiles>/_bundles/<Vendor>.json   { "<sub_path>": <preset JSON>, ... }
 *
 * Covers every sub_path listed in <Vendor>.json (machine_model_list,
 * machine_list, process_list, filament_list). The catalog falls back to
 * per-file fetches when a bundle (or an entry) is missing, so this is purely
 * an optimisation — run it after staging profiles:
 *
 *   node scripts/dev/build-profile-bundles.mjs public/wasm/orca/profiles
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'public/wasm/orca/profiles');
const indexPath = join(dir, '_index.json');
if (!existsSync(indexPath)) { console.error(`no _index.json in ${dir}`); process.exit(1); }
const ids = JSON.parse(readFileSync(indexPath, 'utf8')).filter((x) => typeof x === 'string' && !x.endsWith('.json'));
const out = join(dir, '_bundles');
mkdirSync(out, { recursive: true });
let total = 0;
for (const id of ids) {
  const vpath = join(dir, `${id}.json`);
  if (!existsSync(vpath)) continue;
  const vendor = JSON.parse(readFileSync(vpath, 'utf8'));
  const bundle = {};
  for (const list of ['machine_model_list', 'machine_list', 'process_list', 'filament_list']) {
    for (const e of vendor[list] ?? []) {
      if (!e || typeof e.sub_path !== 'string' || e.sub_path in bundle) continue;
      const f = join(dir, id, e.sub_path);
      if (!existsSync(f)) continue;
      try { bundle[e.sub_path] = JSON.parse(readFileSync(f, 'utf8')); } catch { console.warn(`skip invalid ${f}`); }
    }
  }
  writeFileSync(join(out, `${id}.json`), JSON.stringify(bundle));
  total += Object.keys(bundle).length;
}
console.log(`bundled ${total} presets from ${ids.length} vendors into ${out}`);
