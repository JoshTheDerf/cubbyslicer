#!/usr/bin/env node
// Stage OrcaSlicer's texture displacement library into public/textures/displacement/ (not committed).
//
//   node scripts/stage-textures.mjs [orcaResourcesDir]
//
// Source: $ORCA_RESOURCES or ../slicers/orcaslicer-wasm/orca/resources (resources/textures/displacement:
// 44 8-bit greyscale PNGs, part of OrcaSlicer's AGPL-3.0 repository). Writes the PNGs as they are plus
// index.json, the list the Texture Displacement tool's library shows (desktop's shipped section, by name).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const res = resolve(process.argv[2] ?? process.env.ORCA_RESOURCES ?? join(repo, '../slicers/orcaslicer-wasm/orca/resources'));
const src = join(res, 'textures/displacement');
const dest = join(repo, 'public/textures/displacement');

if (!existsSync(src)) {
  console.error(`No texture library at ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// Desktop's order: by name (the file stem), compared bytewise (scan_dir).
const stem = (f) => f.replace(/\.png$/i, '');
const files = readdirSync(src).filter((f) => f.toLowerCase().endsWith('.png')).sort((a, b) => (stem(a) < stem(b) ? -1 : stem(a) > stem(b) ? 1 : 0));
for (const f of files) copyFileSync(join(src, f), join(dest, f));
const index = files.map((file) => ({ name: stem(file), file }));
writeFileSync(join(dest, 'index.json'), `${JSON.stringify({ format: 'orca-texture-library', version: 1, textures: index }, null, 1)}\n`);
console.log(`Staged ${files.length} textures into ${dest}`);
