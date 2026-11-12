/**
 * The staged OrcaSlicer 2.5 engine (public/wasm/orca), driven through the
 * worker's own packing (pack.ts / heap.ts) in node: the job and tool shapes
 * the app sends for 2.5 features. Skipped when no 2.5 engine is staged.
 * Slow (loads a 14 MB module): one instance for the file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BRIDGE_ABI } from './capabilities';
import type { MixedPreviewResult, MixedValidateResult, RepairMeshResult, ResolveVariantsResult, WipeTowerFootprintResult } from './tools';
import type { FlatConfig, SliceJob, SliceObjectInput, SliceReport, ToolMesh } from './types';
import { allocWords, callJson, copyOut, decodeJson, safeFree, u32, writeIn, type EngineModule } from './worker/heap';
import { packJob, packTool, unpackMeshes } from './worker/pack';
import { encodeTexturePng } from '../texture/png';

const DIR = resolve(__dirname, '../../public/wasm/orca');
const version = existsSync(join(DIR, 'version.json')) ? JSON.parse(readFileSync(join(DIR, 'version.json'), 'utf8')) as { version: string; bridge: number } : null;
const staged = !!version && /^2\.5\./.test(version.version) && existsSync(join(DIR, 'slicer.wasm'));

type Mod = EngineModule;
let mod: Mod;

function tool<T>(op: string, args: unknown, meshes: ToolMesh[] = []): T {
  const { json, blob } = packTool(op, args, meshes);
  const r = callJson(mod, [json, blob], true, (a) => mod._cs_tool!(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]));
  const reply = r.json as { ok: boolean; error?: string; result: T };
  if (!reply?.ok) throw new Error(reply?.error ?? `${op} failed`);
  return reply.result;
}

/** A tool call that also returns the reply's meshes. */
function toolMeshes<T>(op: string, args: unknown, meshes: ToolMesh[] = []): { result: T; meshes: ToolMesh[] } {
  const { json, blob } = packTool(op, args, meshes);
  const r = callJson(mod, [json, blob], true, (a) => mod._cs_tool!(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]));
  const reply = r.json as { ok: boolean; error?: string; result: T; meshes?: unknown };
  if (!reply?.ok) throw new Error(reply?.error ?? `${op} failed`);
  return { result: reply.result, meshes: unpackMeshes(reply.meshes, r.blob) };
}

function slice(job: SliceJob): { rc: number; gcode: string; report: SliceReport } {
  const { json, blob } = packJob(job);
  const jp = writeIn(mod, json), bp = writeIn(mod, blob), outs = allocWords(mod, 4);
  try {
    const rc = mod._cs_slice(jp, json.byteLength, bp, blob.byteLength, outs, outs + 4, outs + 8, outs + 12);
    const g = u32(mod, outs), r = u32(mod, outs + 8);
    const gcode = g ? new TextDecoder().decode(copyOut(mod, g, u32(mod, outs + 4))) : '';
    const report = decodeJson(copyOut(mod, r, u32(mod, outs + 12))) as SliceReport;
    safeFree(mod, g, true); safeFree(mod, r, true);
    return { rc, gcode, report };
  } finally { safeFree(mod, outs); safeFree(mod, jp); safeFree(mod, bp); }
}

/** Where each outer-wall block starts extruding (x, y, z). */
function seamStarts(gcode: string): number[][] {
  const pts: number[][] = []; let x = 0, y = 0, z = 0, outer = false, started = false;
  for (const l of gcode.split('\n')) {
    const f = /^;\s*(?:TYPE|FEATURE):\s*(.*)$/.exec(l);
    if (f) { outer = /^Outer wall/i.test(f[1]); started = false; continue; }
    if (!/^G[0123] /.test(l)) continue;
    const e = / E(-?[\d.]+)/.exec(l);
    if (outer && !started && e && +e[1] > 0) { pts.push([x, y, z]); started = true; }
    const mx = / X(-?[\d.]+)/.exec(l), my = / Y(-?[\d.]+)/.exec(l), mz = / Z(-?[\d.]+)/.exec(l);
    if (mx) x = +mx[1]; if (my) y = +my[1]; if (mz) z = +mz[1];
  }
  return pts;
}

function box(sx: number, sy: number, sz: number): ToolMesh {
  return {
    positions: new Float32Array([0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
  };
}
/** Engine defaults + what Print::validate asks of them (relative E needs a G92 E0 per layer). */
const BASE: FlatConfig = { layer_change_gcode: 'G92 E0' };
const at = (x: number, y: number, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe.skipIf(!staged)('OrcaSlicer 2.5 engine (staged)', () => {
  beforeAll(async () => {
    const { default: factory } = await import(/* @vite-ignore */ pathToFileURL(join(DIR, 'slicer.mjs')).href);
    mod = await factory({ wasmBinary: readFileSync(join(DIR, 'slicer.wasm')), locateFile: (f: string) => join(DIR, f), print: () => {}, printErr: () => {}, csProgress: () => {} });
  }, 120_000);

  it('speaks this app\'s bridge ABI', () => {
    expect(version!.bridge).toBeGreaterThanOrEqual(BRIDGE_ABI.min);
    expect(version!.bridge).toBeLessThanOrEqual(BRIDGE_ABI.max);
  });

  it('resolve_variants: the active variant column per extruder', () => {
    const config: FlatConfig = {
      nozzle_diameter: ['0.4'], extruder_type: ['Direct Drive'], nozzle_volume_type: ['High Flow'],
      extruder_variant_list: ['Direct Drive Standard,Direct Drive High Flow'],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], printer_extruder_id: ['1', '1'],
      print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'], print_extruder_id: ['1', '1'], outer_wall_speed: ['200', '500'],
    };
    const r = tool<ResolveVariantsResult>('resolve_variants', { config });
    expect(r.resolvedBy).toBe('print_apply');
    expect(r.extruderCount).toBe(1);
    expect(r.print.outer_wall_speed).toEqual(['500']);
  });

  it('mixed_filament preview / validate return what the typed helpers read', () => {
    const p = tool<MixedPreviewResult>('mixed_filament', { action: 'preview', colors: ['#FF0000', '#0000FF'], components: [1, 2], ratios: [50, 50] });
    expect(p.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(p.measured === null || /^#[0-9A-F]{6}$/i.test(p.measured)).toBe(true);
    const v = tool<MixedValidateResult>('mixed_filament', { action: 'validate', config: { filament_is_mixed: ['0', '0', '1'], filament_mixed_components: ['', '', '1'], filament_mixed_sublayer_ratios: ['', '', '1'] } });
    expect(Object.keys(v.errors)).toContain('filament_mixed_components');
  });

  it('slices a precise seam part, reports lifecycle events', () => {
    const cube = box(20, 20, 10), seam = box(4, 4, 14);
    const obj: SliceObjectInput = {
      id: 'o1', name: 'cube', ...cube, transform: at(90, 90),
      parts: [{ id: 'p1', name: 'seam', type: 'precise_seam_center', ...seam, transform: at(108, 98, -2), config: {} }],
    };
    const r = slice({ engine: 'orca', config: BASE, objects: [obj] });
    expect(r.report.error).toBeNull();
    expect(r.rc).toBe(0);
    expect(r.report.events?.map((e) => e.event)).toEqual(expect.arrayContaining(['SliceStarted', 'GCodeExportFinished']));
    // The cube spans x 90..110, y 90..110: every outer wall starts at the middle of the +X face.
    const starts = seamStarts(r.gcode).filter((p) => p[2] > 1 && p[2] < 9);
    expect(starts.length).toBeGreaterThan(10);
    for (const [x, y] of starts) expect(Math.hypot(x - 110, y - 100)).toBeLessThan(1.5);
    const plain = slice({ engine: 'orca', config: BASE, objects: [{ ...obj, parts: undefined }] });
    expect(seamStarts(plain.gcode).filter((p) => p[2] > 1 && p[2] < 9).some(([x, y]) => Math.hypot(x - 110, y - 100) > 3)).toBe(true);
  }, 300_000);

  it('accepts the 2.5 calibration parameters (VFA layer height, nozzle-based resize)', () => {
    const r = slice({
      engine: 'orca', config: BASE, objects: [{ id: 'o1', name: 'tower', ...box(20, 20, 5), transform: at(90, 90) }],
      options: { calib: { mode: 'vfa_tower', start: 40, end: 60, step: 10, vfaLayerHeight: 0.3, nozzleBasedResize: true } },
    });
    expect(r.report.error).toBeNull();
    expect(r.rc).toBe(0);
  }, 300_000);

  it('wipe_tower_footprint: the tower size and desktop\'s placement, moved onto the bed', () => {
    const config: FlatConfig = { ...BASE, filament_colour: ['#FF0000', '#0000FF'], filament_diameter: ['1.75', '1.75'], enable_prime_tower: '1', wipe_tower_x: ['15'], wipe_tower_y: ['250'] };
    const r = tool<WipeTowerFootprintResult>('wipe_tower_footprint', { config, filaments: [1, 2], maxHeight: 20, layerHeight: 0.2 });
    expect(r.printed).toBe(true);
    expect(r.width).toBeGreaterThan(0);
    expect(r.depth).toBeGreaterThan(0);
    expect(r.footprint.length).toBeGreaterThanOrEqual(3);
    // The default bed is 200 mm deep: y 250 is off it, so the anchor moves in and then fits.
    expect(r.placement.moved).toBe(true);
    expect(r.placement.fits).toBe(true);
    expect(r.placement.y + r.depth).toBeLessThanOrEqual(200);
    expect(r.defaultPosition.fits).toBe(true);
    const one = tool<WipeTowerFootprintResult>('wipe_tower_footprint', { config, filaments: [1], maxHeight: 20 });
    expect(one.printed).toBe(false);
  });

  it('repair_mesh: fills a hole, keeps paint, leaves a clean solid alone', () => {
    const closed = box(20, 20, 10);
    const ok = tool<RepairMeshResult>('repair_mesh', { keepPainting: true }, [closed]);
    expect(ok.repaired).toBe(true);
    expect(ok.modified).toBe(false);
    // Drop the top face (two triangles): an open box.
    const open: ToolMesh = { positions: closed.positions, indices: new Uint32Array([...closed.indices.slice(0, 6), ...closed.indices.slice(12)]) };
    const r = tool<RepairMeshResult>('repair_mesh', { paint: { color: [[0, '8']] }, keepPainting: true }, [open]);
    expect(r.error).toBeNull();
    expect(r.repaired).toBe(true);
    expect(r.modified).toBe(true);
    expect(r.stats.filledHoles).toBeGreaterThan(0);
    expect(r.triangles).toBeGreaterThanOrEqual(12);
    expect(r.paint?.color?.length).toBeGreaterThan(0);
  });

  it('texture displacement: a brush-painted mask (one-state TriangleSelector) limits the relief to the painted area', () => {
    const cube = box(20, 20, 20);
    // Texture mask painting: a session with one state, a sphere of 4 mm on the top face (triangles 2, 3 are z = 20).
    const { handle } = tool<{ handle: number }>('paint_open', { paint: [], maxState: 1 }, [cube]);
    tool('paint_apply', { handle, kind: 'sphere', facet: 2, point: [10, 10, 20], camera: [10, 10, 200], state: 1, radius: 4, trafo: at(0, 0) });
    const { paint } = tool<{ paint: Array<[number, string]> }>('paint_get', { handle });
    tool('paint_close', { handle });
    expect(paint.length).toBeGreaterThan(0);
    expect(paint.every(([t]) => t === 2 || t === 3)).toBe(true);
    expect(paint.some(([, h]) => h !== '4')).toBe(true); // split triangles, not whole ones
    // A noisy height map so the relief is non-zero almost everywhere.
    const n = 64, rgba = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) { const v = 128 + Math.round(127 * Math.sin(i * 0.37) * Math.cos(i * 0.11)); rgba.set([v, v, v, 255], i * 4); }
    const r = toolMeshes<{ triangles: number }>('texture_displacement', {
      layers: { version: 1, options: { pipeline_v2: true, v2_max_triangles_k: 0, v2_refine_mm: 0.5 }, layers: [{ slot: 0, depth_mm: 1, tiling_scale: 8 }] },
      images: { 0: encodeTexturePng(n, n, rgba) }, paint: { 0: paint }, transform: at(0, 0), anchor: [10, 10, 0], restingDrop: 0,
    }, [cube]);
    const p = r.meshes[0].positions;
    let raised = 0, maxZ = 0, farthest = 0, outside = 0;
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
      if (x < -1e-3 || x > 20.001 || y < -1e-3 || y > 20.001 || z < -1e-3) outside++;
      if (z > 20.01) { raised++; maxZ = Math.max(maxZ, z); farthest = Math.max(farthest, Math.hypot(x - 10, y - 10)); }
    }
    expect(raised).toBeGreaterThan(10);
    expect(maxZ).toBeGreaterThan(20.2);
    expect(farthest).toBeLessThan(5); // the 4 mm sphere plus a refinement edge
    expect(outside).toBe(0); // sides and bottom untouched
  }, 120_000);
});
