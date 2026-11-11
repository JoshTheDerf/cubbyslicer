/**
 * HookChannel: the slicing-pipeline seam between an engine worker and the
 * plugin runtime worker (docs/ENGINE-CONTRACT.md "Plugin hooks").
 *
 * The engine calls `Module.csHook("pipeline", begin)` synchronously at each
 * step (hookClient.ts, in the engine worker). It writes BEGIN into this
 * buffer, wakes the runtime over a MessagePort and parks in `Atomics.wait`.
 * The runtime (worker/hookServer.ts) runs the selected capabilities; every
 * graph access becomes QUERY → the engine worker runs `cs_hook_query` on the
 * still-active Print → REPLY. DONE carries the result back to the engine.
 * The main thread only allocates the buffer per engine worker and sets CANCEL
 * when that worker is terminated (cancel / crash), which frees a runtime
 * waiting for a reply.
 *
 * Frames in the data window: BEGIN / DONE = UTF-8 JSON; QUERY / REPLY =
 * [u32 json length][json][u32 blob length][blob].
 */

export const HOOK_CTRL_BYTES = 64;
export const HOOK_WINDOW = 32 * 1024 * 1024;

/** Control word indices (Int32). */
export const HOOK = {
  STATE: 0,
  /** Hook sequence number. */
  SEQ: 1,
  /** Payload length in the data window. */
  LENGTH: 2,
  /** Set by the main thread when the engine worker is gone; ctx.cancelled() reads it too. */
  CANCEL: 3,
} as const;

export const HOOK_STATE = { IDLE: 0, BEGIN: 1, QUERY: 2, REPLY: 3, DONE: 4, RUNNING: 5 } as const;

/** Allocate a HookChannel (null without cross-origin isolation: slicing hooks then can't run). */
export function createHookChannel(): SharedArrayBuffer | null {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
      ? new SharedArrayBuffer(HOOK_CTRL_BYTES + HOOK_WINDOW) : null;
  } catch { return null; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class HookFrames {
  readonly ctrl: Int32Array;
  readonly data: Uint8Array;
  constructor(readonly sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, HOOK_CTRL_BYTES / 4);
    this.data = new Uint8Array(sab, HOOK_CTRL_BYTES);
  }

  writeText(text: string): void {
    const b = enc.encode(text);
    if (b.byteLength > this.data.byteLength) throw new Error(`hook message too large (${b.byteLength} bytes)`);
    this.data.set(b);
    Atomics.store(this.ctrl, HOOK.LENGTH, b.byteLength);
  }

  readText(): string {
    const n = Atomics.load(this.ctrl, HOOK.LENGTH);
    return dec.decode(this.data.slice(0, n));
  }

  /** [u32 json][json][u32 blob][blob]; false when it does not fit. */
  writePair(json: string, blob: Uint8Array | null): boolean {
    const j = enc.encode(json);
    const bl = blob?.byteLength ?? 0;
    const total = 8 + j.byteLength + bl;
    if (total > this.data.byteLength) return false;
    const dv = new DataView(this.sab, HOOK_CTRL_BYTES);
    dv.setUint32(0, j.byteLength, true);
    this.data.set(j, 4);
    dv.setUint32(4 + j.byteLength, bl, true);
    if (blob && bl) this.data.set(blob, 8 + j.byteLength);
    Atomics.store(this.ctrl, HOOK.LENGTH, total);
    return true;
  }

  readPair(): { json: string; blob: Uint8Array } {
    const dv = new DataView(this.sab, HOOK_CTRL_BYTES);
    const jl = dv.getUint32(0, true);
    const json = dec.decode(this.data.slice(4, 4 + jl));
    const bl = dv.getUint32(4 + jl, true);
    return { json, blob: this.data.slice(8 + jl, 8 + jl + bl) };
  }

  setState(s: number): void {
    Atomics.store(this.ctrl, HOOK.STATE, s);
    Atomics.notify(this.ctrl, HOOK.STATE);
  }

  get state(): number { return Atomics.load(this.ctrl, HOOK.STATE); }
  get cancelled(): boolean { return Atomics.load(this.ctrl, HOOK.CANCEL) !== 0; }
}
