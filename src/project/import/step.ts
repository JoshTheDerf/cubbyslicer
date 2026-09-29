/**
 * STEP import (Orca StepMeshDialog + Format/STEP.cpp): OpenCascade via
 * occt-import-js (lazy wasm, run in its own worker), tessellated with the
 * user's linear / angular deflection. Solids either merge into one object or
 * (Orca "Split compound and compsolid into multiple objects") become one
 * object each.
 */
import type { ParseResult, ParsedObject } from '../types';
import { ImportError, recenter, weldVertices } from '../mesh';

export interface StepOptions {
  /** Absolute linear deflection, mm (Orca: 0.001 … 0.1, default 0.003). */
  linearDeflection: number;
  /** Angular deflection, radians (Orca: 0.01 … 1, default 0.5). */
  angularDeflection: number;
  /** One object per solid instead of one merged object. */
  split: boolean;
}

export const STEP_DEFAULTS: StepOptions = { linearDeflection: 0.003, angularDeflection: 0.5, split: false };
export const STEP_LIMITS = { linear: [0.001, 0.1] as const, angular: [0.01, 1] as const };

export function isStepName(name: string): boolean { return /\.(step|stp)$/i.test(name); }

/** The subset of occt-import-js's result we use. */
export interface OcctResult {
  success: boolean;
  meshes: Array<{ name?: string; attributes: { position: { array: ArrayLike<number> } }; index: { array: ArrayLike<number> } }>;
}

/** Page-side hook: asks the user for deflections (StepMeshDialog). null = cancelled. */
let optionsProvider: ((fileName: string) => Promise<StepOptions | null>) | null = null;
export function setStepOptionsProvider(p: typeof optionsProvider): void { optionsProvider = p; }
export async function askStepOptions(fileName: string): Promise<StepOptions | null> {
  return optionsProvider ? optionsProvider(fileName) : { ...STEP_DEFAULTS };
}

export class ImportCancelled extends Error { override name = 'AbortError'; constructor() { super('Import cancelled.'); } }

export function stepBaseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).replace(/\.(step|stp)$/i, '') || 'Object';
}

/** occt result → parsed objects (welded, recentred like the other formats). */
export function occtToParsed(res: OcctResult, fileName: string, split: boolean): ParseResult {
  if (!res.success) throw new ImportError(`${fileName}: OpenCascade couldn't read this STEP file.`);
  const warnings: string[] = [];
  const parts = res.meshes.map((m, i) => ({
    name: m.name?.trim() || `${stepBaseName(fileName)}_${i + 1}`,
    positions: Float32Array.from(m.attributes.position.array),
    indices: Uint32Array.from(m.index.array),
  })).filter((m) => m.indices.length >= 3);
  if (!parts.length) throw new ImportError(`${fileName}: the STEP file has no solids or surfaces.`);
  let groups: Array<{ name: string; positions: Float32Array; indices: Uint32Array }>;
  if (split || parts.length === 1) groups = parts.length === 1 ? [{ ...parts[0], name: stepBaseName(fileName) }] : parts;
  else {
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.positions.length; ni += p.indices.length; }
    const positions = new Float32Array(nv), indices = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
      positions.set(p.positions, vo);
      for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo / 3;
      vo += p.positions.length; io += p.indices.length;
    }
    groups = [{ name: stepBaseName(fileName), positions, indices }];
  }
  const objects: ParsedObject[] = [];
  for (const g of groups) {
    const w = weldVertices(g.positions, g.indices);
    if (!w.indices.length) { warnings.push(`${g.name}: no valid triangles; skipped.`); continue; }
    if (w.dropped) warnings.push(`${g.name}: removed ${w.dropped} degenerate triangle(s).`);
    const c = recenter(w.positions);
    // Keep the solids' relative placement when split: translate back to where they were.
    const transform = split && groups.length > 1 ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1] : null;
    objects.push({ name: g.name, positions: w.positions, indices: w.indices, transform });
  }
  if (!objects.length) throw new ImportError(`${fileName}: no usable geometry.`);
  return { objects, warnings };
}

let worker: Worker | null = null;
let seq = 0;

/** Tessellate a STEP file off the main thread. */
export async function parseStep(name: string, buffer: ArrayBuffer, opts: StepOptions): Promise<ParseResult> {
  worker ??= new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module', name: 'cubby-step' });
  const w = worker;
  const id = ++seq;
  const res = await new Promise<OcctResult>((resolve, reject) => {
    const onMsg = (ev: MessageEvent<{ id: number; ok: boolean; result?: OcctResult; message?: string }>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      if (ev.data.ok && ev.data.result) resolve(ev.data.result);
      else reject(new ImportError(`${name}: ${ev.data.message ?? 'STEP import failed.'}`));
    };
    const onErr = (ev: ErrorEvent) => {
      ev.preventDefault();
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      w.terminate();
      worker = null;
      reject(new ImportError(`${name}: the STEP importer crashed (the model may be too complex for the deflection chosen).`));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, buffer, params: { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: opts.linearDeflection, angularDeflection: opts.angularDeflection } }, [buffer]);
  });
  return occtToParsed(res, name, opts.split);
}
