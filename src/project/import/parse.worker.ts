/**
 * Model parsing worker. Receives a file buffer (transferred), returns welded
 * meshes with their buffers transferred back — no copies, no JSON geometry.
 */
import { parseModel } from './parse';

export interface ParseRequest { id: number; name: string; buffer: ArrayBuffer }

// Typed view of the worker global (the app tsconfig uses the DOM lib, not webworker).
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<ParseRequest>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<ParseRequest>) => {
  const { id, name, buffer } = ev.data;
  try {
    const result = parseModel(name, buffer);
    const transfer: Transferable[] = [];
    for (const o of result.objects) transfer.push(o.positions.buffer, o.indices.buffer);
    ctx.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    const err = e as Error;
    ctx.postMessage({ id, ok: false, message: err?.message ?? String(e), user: err?.name === 'ImportError' });
  }
};
