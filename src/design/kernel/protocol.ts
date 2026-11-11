/**
 * Messages between the page (client.ts) and the CAD kernel worker (cad.worker.ts).
 * Blobs travel as transferables; the worker never keeps a reference to what it sent.
 */
import type { CadKernelVersion } from './types';

/** The kernel's output envelope (contract "C ABI"). */
export interface CadEnvelope { ok: boolean; result?: unknown; error?: { code: number; message: string } }

export interface RawReply {
  /** cad_call's return code: 0 ok, 1 error (the envelope says which). */
  rc: number;
  envelope: CadEnvelope;
  blob: Uint8Array | null;
  /** The module's linear memory after the call (it only grows). */
  heapBytes: number;
}

/** Start-up stages: fetching cad.wasm (with byte progress), compiling, running the static constructors. */
export type StartStage = 'download' | 'compile' | 'init';
export interface StartProgress { stage: StartStage; loaded: number; total: number }

export type ToWorker =
  /** `cancel`: Int32Array view [0] ≠ 0 = cancel the running rebuild (Module.cadProgress); null without cross-origin isolation. */
  | { type: 'init'; base: string; cancel: SharedArrayBuffer | null }
  | { type: 'call'; id: number; method: string; params: unknown; blob: Uint8Array | null };

export type FromWorker =
  | { type: 'progress'; progress: StartProgress }
  | { type: 'ready'; version: CadKernelVersion; heapBytes: number }
  /** Module.cadProgress: feature `index` of `count` is being replayed (index == count: tessellating). */
  | { type: 'rebuild'; index: number; count: number; name: string }
  | { type: 'reply'; id: number; reply: RawReply }
  /** The instance is unusable (load failure, trap): the client terminates this worker. */
  | { type: 'fatal'; id?: number; message: string; trap: boolean };
