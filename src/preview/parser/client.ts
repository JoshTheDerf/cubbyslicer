/**
 * Main-thread entry to the G-code parser. Runs the parse in a module worker
 * (bytes are copied and the copy transferred, so the caller keeps its
 * Uint8Array for the text viewer); falls back to an in-thread parse where
 * Workers are unavailable (tests / SSR).
 */
import { parseGcode } from './parse';
import type { ParseOptions, ParsedGcode, ParserRequest, ParserResponse } from './types';

export interface ParseHandle {
  promise: Promise<ParsedGcode>;
  /** Abort: terminates the worker; the promise rejects with an AbortError. */
  cancel(): void;
}

let nextId = 1;

export function parseGcodeAsync(
  bytes: Uint8Array,
  options: ParseOptions = {},
  onProgress?: (done: number, total: number) => void,
): ParseHandle {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    const promise = new Promise<ParsedGcode>((resolve, reject) => {
      setTimeout(() => {
        if (cancelled) { reject(new DOMException('Parse cancelled', 'AbortError')); return; }
        try { resolve(parseGcode(bytes, options, onProgress)); } catch (e) { reject(e); }
      }, 0);
    });
    return { promise, cancel: () => { cancelled = true; } };
  }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'gcode-parser' });
  const id = nextId++;
  let settle: { reject(e: unknown): void } | null = null;
  const promise = new Promise<ParsedGcode>((resolve, reject) => {
    settle = { reject };
    worker.onmessage = (ev: MessageEvent<ParserResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.done, m.total);
      else if (m.type === 'result') { worker.terminate(); settle = null; resolve(m.data); }
      else { worker.terminate(); settle = null; reject(new Error(m.message)); }
    };
    worker.onerror = (ev) => {
      worker.terminate(); settle = null;
      reject(new Error(ev.message || 'G-code parser worker failed'));
    };
  });
  // Copy so the caller's buffer stays usable; transfer the copy (no second clone).
  const copy = bytes.slice();
  const req: ParserRequest = { type: 'parse', id, bytes: copy, options };
  worker.postMessage(req, [copy.buffer]);
  return {
    promise,
    cancel() {
      if (!settle) return;
      worker.terminate();
      const s = settle; settle = null;
      s.reject(new DOMException('Parse cancelled', 'AbortError'));
    },
  };
}
