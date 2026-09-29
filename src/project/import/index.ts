/**
 * Page-side import API. Parsing runs in a Web Worker (parse.worker.ts); if
 * workers are unavailable it falls back to the main thread.
 */
import type { ParseResult } from '../types';
import { ImportError } from '../mesh';
import { ImportCancelled, askStepOptions, isStepName, parseStep } from './step';

export const MODEL_EXTENSIONS = ['.stl', '.obj', '.3mf', '.step', '.stp'];
export const MODEL_ACCEPT = '.stl,.obj,.3mf,.step,.stp,model/stl,model/3mf,model/step';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: ParseResult) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module', name: 'cubby-import' });
  } catch {
    return null;
  }
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: ParseResult; message?: string; user?: boolean }>) => {
    const d = ev.data;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok && d.result) p.resolve(d.result);
    else p.reject(d.user ? new ImportError(d.message ?? 'Import failed') : new Error(d.message ?? 'Import failed'));
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    const err = new Error(ev.message || 'Import worker crashed (the file may be too large for available memory).');
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

/** Parse a model file. `buffer` is transferred (detached) when a worker is used. */
export async function parseModelFile(name: string, buffer: ArrayBuffer): Promise<ParseResult> {
  // STEP: ask for the tessellation (Orca StepMeshDialog), then OpenCascade in its own lazy worker.
  if (isStepName(name)) {
    const opts = await askStepOptions(name);
    if (!opts) throw new ImportCancelled();
    return parseStep(name, buffer, opts);
  }
  const w = getWorker();
  if (!w) {
    const { parseModel } = await import('./parse');
    return parseModel(name, buffer);
  }
  const id = ++seq;
  return new Promise<ParseResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, name, buffer }, [buffer]);
  });
}

export function isModelFileName(name: string): boolean {
  const l = name.toLowerCase();
  return MODEL_EXTENSIONS.some((e) => l.endsWith(e));
}
