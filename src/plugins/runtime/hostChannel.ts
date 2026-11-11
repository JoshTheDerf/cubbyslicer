/**
 * HostChannel: synchronous host calls from the plugin runtime worker.
 *
 * OrcaSlicer's host API blocks the calling plugin thread while the UI thread
 * answers. Here the runtime posts `{t:'hostCall'}` to the main thread and
 * parks in `Atomics.wait` on this SharedArrayBuffer; the main thread runs the
 * (possibly async) handler and writes the reply into the buffer, in chunks of
 * WINDOW bytes (the runtime asks for the next chunk with `{t:'hostChunk'}`).
 * The main thread never blocks.
 *
 * Layout: Int32 control words [0, 64) then the data window.
 * Reply bytes: [u32 header length][header JSON {json?, error?, blobs: [lengths]}][blob 0][blob 1]…
 */

export const CTRL_BYTES = 64;
export const WINDOW = 1 << 20;
export const STATE = 0, CALL = 1, TOTAL = 2, OFFSET = 3, CHUNK = 4;

export function createHostChannel(): SharedArrayBuffer | null {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
      ? new SharedArrayBuffer(CTRL_BYTES + WINDOW) : null;
  } catch { return null; }
}

export interface ReplyPayload {
  json?: unknown;
  error?: { type: string; message: string };
  blobs?: Uint8Array[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeReply(r: ReplyPayload): Uint8Array {
  const blobs = r.blobs ?? [];
  const header = enc.encode(JSON.stringify({ json: r.json === undefined ? null : JSON.stringify(r.json), error: r.error, blobs: blobs.map((b) => b.byteLength) }));
  const total = 4 + header.byteLength + blobs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let off = 4 + header.byteLength;
  for (const b of blobs) { out.set(b, off); off += b.byteLength; }
  return out;
}

export interface DecodedReply { json: string | null; error?: { type: string; message: string }; blobs: Uint8Array[] }

export function decodeReply(bytes: Uint8Array): DecodedReply {
  const hl = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const h = JSON.parse(dec.decode(bytes.subarray(4, 4 + hl))) as { json: string | null; error?: { type: string; message: string }; blobs: number[] };
  const blobs: Uint8Array[] = [];
  let off = 4 + hl;
  for (const n of h.blobs) { blobs.push(bytes.slice(off, off + n)); off += n; }
  return { json: h.json, error: h.error, blobs };
}

/** Main-thread side: writes replies chunk by chunk. */
export class HostChannelServer {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private pending: { id: number; bytes: Uint8Array; off: number } | null = null;

  constructor(sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, CTRL_BYTES / 4);
    this.data = new Uint8Array(sab, CTRL_BYTES);
  }

  reply(callId: number, payload: ReplyPayload): void {
    this.pending = { id: callId, bytes: encodeReply(payload), off: 0 };
    this.writeChunk();
  }

  nextChunk(callId: number): void {
    if (this.pending?.id === callId) this.writeChunk();
  }

  private writeChunk(): void {
    const p = this.pending!;
    const n = Math.min(this.data.byteLength, p.bytes.byteLength - p.off);
    this.data.set(p.bytes.subarray(p.off, p.off + n));
    Atomics.store(this.ctrl, CALL, p.id);
    Atomics.store(this.ctrl, TOTAL, p.bytes.byteLength);
    Atomics.store(this.ctrl, OFFSET, p.off);
    Atomics.store(this.ctrl, CHUNK, n);
    p.off += n;
    if (p.off >= p.bytes.byteLength) this.pending = null;
    Atomics.store(this.ctrl, STATE, 1);
    Atomics.notify(this.ctrl, STATE);
  }
}

/** Runtime-worker side: post the call, park, collect the chunks. */
export class HostChannelClient {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private seq = 0;

  constructor(sab: SharedArrayBuffer, private send: (msg: unknown) => void) {
    this.ctrl = new Int32Array(sab, 0, CTRL_BYTES / 4);
    this.data = new Uint8Array(sab, CTRL_BYTES);
  }

  call(msg: Record<string, unknown>): DecodedReply {
    const id = ++this.seq;
    Atomics.store(this.ctrl, STATE, 0);
    this.send({ ...msg, t: 'hostCall', callId: id });
    let buf: Uint8Array | null = null;
    for (;;) {
      while (Atomics.load(this.ctrl, STATE) === 0) Atomics.wait(this.ctrl, STATE, 0, 5000);
      if (Atomics.load(this.ctrl, CALL) !== id) { Atomics.store(this.ctrl, STATE, 0); continue; }
      const total = Atomics.load(this.ctrl, TOTAL), off = Atomics.load(this.ctrl, OFFSET), n = Atomics.load(this.ctrl, CHUNK);
      buf ??= new Uint8Array(total);
      buf.set(this.data.subarray(0, n), off);
      if (off + n >= total) break;
      Atomics.store(this.ctrl, STATE, 0);
      this.send({ t: 'hostChunk', callId: id });
    }
    Atomics.store(this.ctrl, STATE, 0);
    return decodeReply(buf);
  }
}

/*
 * CallbackChannel: UI callbacks (uiEvent / pageMessage) for a runtime that may be blocked.
 *
 * On desktop Orca a plugin's UI callbacks run on the UI thread while its Script worker waits in
 * queue.Queue.get() / Event.wait() / time.sleep(). Here Python is single-threaded, so a blocked
 * runtime never sees a posted message. The main thread therefore puts callbacks into this one-slot
 * mailbox (a batch of JSON messages) and posts a `{t:'callbacks'}` nudge: an idle runtime drains the
 * slot on the nudge, a blocked one drains it from its wait (`Atomics.wait` on STATE, see
 * _cubby_wait.py). The runtime answers `{t:'callbacksTaken'}` and the main thread writes the next
 * batch. The main thread never blocks.
 *
 * Layout: Int32 control words [0, 64) (CB_STATE 0 empty / 1 full, CB_LEN bytes) then the data window.
 */
export const CB_STATE = 0, CB_LEN = 1;

export function createCallbackChannel(): SharedArrayBuffer | null {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
      ? new SharedArrayBuffer(CTRL_BYTES + WINDOW) : null;
  } catch { return null; }
}

/** Main-thread side: queues callbacks and writes them into the slot whenever it is empty. */
export class CallbackChannelServer {
  private ctrl: Int32Array;
  private data: Uint8Array;
  private pending: string[] = [];

  /** `nudge` posts `{t:'callbacks'}`; `direct` posts a message too big for the window as is. */
  constructor(sab: SharedArrayBuffer, private nudge: () => void, private direct: (msg: unknown) => void) {
    this.ctrl = new Int32Array(sab, 0, CTRL_BYTES / 4);
    this.data = new Uint8Array(sab, CTRL_BYTES);
  }

  push(msg: unknown): void {
    this.pending.push(JSON.stringify(msg));
    this.flush();
  }

  /** Write the next batch if the runtime has taken the last one (called again on `callbacksTaken`). */
  flush(): void {
    if (!this.pending.length || Atomics.load(this.ctrl, CB_STATE) !== 0) return;
    let n = 0, size = 2;
    for (const s of this.pending) {
      const len = enc.encode(s).byteLength + 1;
      if (size + len > this.data.byteLength) break;
      size += len; n++;
    }
    if (!n) {   // one message larger than the window: ordinary postMessage (needs an idle runtime)
      this.direct(JSON.parse(this.pending.shift()!));
      this.flush();
      return;
    }
    const bytes = enc.encode(`[${this.pending.splice(0, n).join(',')}]`);
    this.data.set(bytes);
    Atomics.store(this.ctrl, CB_LEN, bytes.byteLength);
    Atomics.store(this.ctrl, CB_STATE, 1);
    Atomics.notify(this.ctrl, CB_STATE);
    this.nudge();
  }
}

/** Runtime-worker side: take the batch in the slot, or wait for one. */
export class CallbackChannelClient {
  private ctrl: Int32Array;
  private data: Uint8Array;

  constructor(sab: SharedArrayBuffer, private taken: () => void) {
    this.ctrl = new Int32Array(sab, 0, CTRL_BYTES / 4);
    this.data = new Uint8Array(sab, CTRL_BYTES);
  }

  /** The messages in the slot (emptying it), or null. */
  take(): unknown[] | null {
    if (Atomics.load(this.ctrl, CB_STATE) !== 1) return null;
    const n = Atomics.load(this.ctrl, CB_LEN);
    const text = dec.decode(this.data.slice(0, n));
    Atomics.store(this.ctrl, CB_STATE, 0);
    this.taken();
    return JSON.parse(text) as unknown[];
  }

  /** Block up to `ms` for a batch, then take it (null on timeout). */
  wait(ms: number): unknown[] | null {
    if (ms > 0 && Atomics.load(this.ctrl, CB_STATE) === 0) Atomics.wait(this.ctrl, CB_STATE, 0, ms);
    return this.take();
  }
}
