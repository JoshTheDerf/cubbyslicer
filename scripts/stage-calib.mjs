#!/usr/bin/env node
// Stage OrcaSlicer's calibration models into public/calib/ (not committed).
//
//   node scripts/stage-calib.mjs [orcaResourcesDir]
//
// Source: $ORCA_RESOURCES or ../slicers/orcaslicer-wasm/orca/resources.
// Orca ships most test models as Draco-compressed meshes (.drc); the browser
// fetches them lazily, so they are decoded here (three.js's Draco decoder, pure
// JS) and written as binary STL. The flow-rate 3MF projects are copied as-is
// (their object names carry the flow offsets Orca reads back).
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const src = resolve(process.argv[2] ?? process.env.ORCA_RESOURCES ?? join(repo, '../slicers/orcaslicer-wasm/orca/resources'));
const dest = join(repo, 'public/calib');

/** [source path under resources/, destination path under public/calib/] */
const DRC = [
  ['calib/temperature_tower/temperature_tower.drc', 'temperature_tower/temperature_tower.stl'],
  ['calib/volumetric_speed/SpeedTestStructure.drc', 'volumetric_speed/SpeedTestStructure.stl'],
  ['calib/retraction/retraction_tower.drc', 'retraction/retraction_tower.stl'],
  ['calib/vfa/vfa.drc', 'vfa/vfa.stl'],
  ['calib/input_shaping/ringing_tower.drc', 'input_shaping/ringing_tower.stl'],
  ['calib/input_shaping/fast_tower_test.drc', 'input_shaping/fast_tower_test.stl'],
  ['calib/cornering/SCV-V2.drc', 'cornering/SCV-V2.stl'],
  ['calib/pressure_advance/pressure_advance_test.drc', 'pressure_advance/pressure_advance_test.stl'],
  ['calib/pressure_advance/tower_with_seam.drc', 'pressure_advance/tower_with_seam.stl'],
  ['handy_models/OrcaToleranceTest.drc', 'handy/OrcaToleranceTest.stl'],
  // Orca's "Add handy model" set (GUI_Factories.cpp append_submenu_add_handy_model).
  ['handy_models/OrcaCube_v2.drc', 'handy/OrcaCube_v2.stl'],
  ['handy_models/OrcaPlug_v2.drc', 'handy/OrcaPlug_v2.stl'],
  ['handy_models/3DBenchy.drc', 'handy/3DBenchy.stl'],
  ['handy_models/calicat.drc', 'handy/calicat.stl'],
  ['handy_models/ksr_fdmtest_v4.drc', 'handy/ksr_fdmtest_v4.stl'],
  ['handy_models/Voron_Design_Cube_v7.drc', 'handy/Voron_Design_Cube_v7.stl'],
  ['handy_models/Stanford_Bunny.drc', 'handy/Stanford_Bunny.stl'],
  ['handy_models/Orca_stringhell.drc', 'handy/Orca_stringhell.stl'],
];
const COPY = [
  ['calib/filament_flow/flowrate-test-pass1.3mf', 'filament_flow/flowrate-test-pass1.3mf'],
  ['calib/filament_flow/flowrate-test-pass2.3mf', 'filament_flow/flowrate-test-pass2.3mf'],
  ['calib/filament_flow/Orca-LinearFlow.3mf', 'filament_flow/Orca-LinearFlow.3mf'],
  ['calib/filament_flow/Orca-LinearFlow_fine.3mf', 'filament_flow/Orca-LinearFlow_fine.3mf'],
  ['handy_models/OrcaSliced.3mf', 'handy/OrcaSliced.3mf'],
];

if (!existsSync(src)) { console.error(`error: ${src} not found (set ORCA_RESOURCES)`); process.exit(1); }

// The decoder is a classic (non-module) script; evaluate it in a function scope.
const decoderSrc = readFileSync(join(repo, 'node_modules/three/examples/jsm/libs/draco/draco_decoder.js'), 'utf8');
const decoderPath = join(repo, 'node_modules/three/examples/jsm/libs/draco/draco_decoder.js');
const DracoDecoderModule = new Function('require', '__dirname', '__filename', `${decoderSrc}\nreturn DracoDecoderModule;`)(
  createRequire(import.meta.url), dirname(decoderPath), decoderPath);
const draco = await DracoDecoderModule({});

function decodeDrc(buf) {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength), buf.byteLength);
  const type = decoder.GetEncodedGeometryType(buffer);
  if (type !== draco.TRIANGULAR_MESH) throw new Error('not a triangular mesh');
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok() || mesh.ptr === 0) throw new Error(`decode failed: ${status.error_msg()}`);
  const nv = mesh.num_points(), nf = mesh.num_faces();
  const posAttr = decoder.GetAttribute(mesh, decoder.GetAttributeId(mesh, draco.POSITION));
  const arr = new draco.DracoFloat32Array();
  decoder.GetAttributeFloatForAllPoints(mesh, posAttr, arr);
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) positions[i] = arr.GetValue(i);
  const face = new draco.DracoInt32Array();
  const indices = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    decoder.GetFaceFromMesh(mesh, f, face);
    indices[f * 3] = face.GetValue(0); indices[f * 3 + 1] = face.GetValue(1); indices[f * 3 + 2] = face.GetValue(2);
  }
  for (const o of [arr, face, mesh, buffer, decoder]) draco.destroy(o);
  return { positions, indices };
}

function binaryStl({ positions, indices }, name) {
  const nf = indices.length / 3;
  const out = Buffer.alloc(84 + nf * 50);
  out.write(`cubby-slicer ${name}`.slice(0, 79), 0, 'ascii');
  out.writeUInt32LE(nf, 80);
  for (let f = 0; f < nf; f++) {
    const o = 84 + f * 50;
    const p = [0, 1, 2].map((k) => indices[f * 3 + k] * 3);
    const ax = positions[p[1]] - positions[p[0]], ay = positions[p[1] + 1] - positions[p[0] + 1], az = positions[p[1] + 2] - positions[p[0] + 2];
    const bx = positions[p[2]] - positions[p[0]], by = positions[p[2] + 1] - positions[p[0] + 1], bz = positions[p[2] + 2] - positions[p[0] + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    out.writeFloatLE(nx, o); out.writeFloatLE(ny, o + 4); out.writeFloatLE(nz, o + 8);
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) out.writeFloatLE(positions[p[k] + j], o + 12 + k * 12 + j * 4);
  }
  return out;
}

let n = 0;
for (const [from, to] of DRC) {
  const file = join(src, from);
  if (!existsSync(file)) { console.warn(`skip (missing): ${from}`); continue; }
  const mesh = decodeDrc(readFileSync(file));
  const target = join(dest, to);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, binaryStl(mesh, to));
  console.log(`${to}  ${mesh.indices.length / 3} triangles`);
  n++;
}
for (const [from, to] of COPY) {
  const file = join(src, from);
  if (!existsSync(file)) { console.warn(`skip (missing): ${from}`); continue; }
  const target = join(dest, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  console.log(`${to}  ${statSync(target).size} bytes`);
  n++;
}
writeFileSync(join(dest, 'README.txt'), 'OrcaSlicer calibration models (AGPL-3.0), staged by scripts/stage-calib.mjs. Do not edit.\n');
console.log(`staged ${n} files into ${dest}`);
