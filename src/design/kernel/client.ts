/**
 * Page-side client of the CAD kernel (docs/CAD-KERNEL-CONTRACT.md).
 *
 * - Lazy: nothing is fetched until the first job (the Design tab opening, or a design being
 *   committed / regenerated). `warmUp()` starts the instance early (hovering the tab).
 * - One module instance in one Worker (`cad.worker.ts`). Calls are serialised through a job
 *   queue: a job is an async function making several calls (edit → save → mesh) that no other
 *   job interleaves with. `status.busy` names the running job.
 * - Cancel = terminate the Worker (the kernel can't be interrupted). Every document in it is
 *   lost: the queue is flushed with `KernelReset` and `onReset` listeners (the design session)
 *   reopen from the last saved bytes. A trap (`RuntimeError`) does the same ('crash'), and so
 *   does a memory recycle once the heap (which never shrinks) passes `RECYCLE_HEAP_BYTES`.
 * - The backend is pluggable: `WorkerBackend` in the app, `FakeKernel` (fake.ts) in tests.
 */
import { reactive } from 'vue';
import type { CadEnvelope, FromWorker, RawReply, StartProgress, ToWorker } from './protocol';
import { CAD_KERNEL_ABI, type CadKernelVersion } from './types';

/** A kernel method failed (rc 1): the envelope's code and message. */
export class KernelError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(message);
    this.name = 'KernelError';
  }
}

export type ResetReason = 'cancel' | 'crash' | 'recycle';

/** The job lost its kernel instance (cancelled, crashed or recycled) before it finished. */
export class KernelReset extends Error {
  constructor(readonly reason: ResetReason) {
    super(reason === 'cancel' ? 'Cancelled.' : reason === 'crash' ? 'The CAD kernel crashed.' : 'The CAD kernel was restarted.');
    this.name = 'KernelReset';
  }
}

export interface KernelBackend {
  /** Load and instantiate the module; `onFatal` fires if the instance dies later (trap, worker error). */
  start(onProgress: (p: StartProgress) => void, onFatal: (message: string) => void): Promise<{ version: CadKernelVersion; heapBytes: number }>;
  call(method: string, params: unknown, blob: Uint8Array | null): Promise<RawReply>;
  terminate(): void;
  /** Ask the running rebuild to stop cleanly (kernel `cadProgress`); false when the backend can't. */
  requestCancel?(on: boolean): boolean;
  /** Per-feature rebuild progress of the running call. */
  onRebuild?: (p: RebuildProgress) => void;
}

export interface RebuildProgress { index: number; count: number; name: string }

export interface CallResult<T> { result: T; blob: Uint8Array | null }
export type KernelCall = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, blob?: Uint8Array | null) => Promise<CallResult<T>>;

export interface JobContext {
  call: KernelCall;
  /** A (non-quiet) job is waiting: a preemptible job (a background search) should stop at its next step. */
  yieldRequested(): boolean;
}

export interface JobOptions {
  /** Offer Cancel while it runs (terminates the instance). */
  cancellable?: boolean;
  /** Not shown as busy (quick reads). */
  quiet?: boolean;
}

export type KernelPhase = 'off' | 'starting' | 'ready' | 'failed';

/** Recycle the instance once its (never-shrinking) heap passes this, between jobs. */
export const RECYCLE_HEAP_BYTES = 2048 * 1024 * 1024;

interface Job { label: string; fn: (c: JobContext) => Promise<unknown>; opts: JobOptions; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class CadKernel {
  readonly status = reactive({
    phase: 'off' as KernelPhase,
    progress: null as StartProgress | null,
    error: '',
    version: null as CadKernelVersion | null,
    /** The running job (null = idle, or a quiet job). `cancelling`: a clean cancel was asked for. */
    busy: null as null | { label: string; since: number; cancellable: boolean; cancelling?: boolean },
    /** The feature the running rebuild is replaying (kernel progress), or null. */
    rebuild: null as RebuildProgress | null,
    /** Jobs waiting behind the running one. */
    queued: 0,
    heapBytes: 0,
    /** Instances lost so far (cancel / crash / recycle). */
    resets: 0,
  });

  private backend: KernelBackend | null = null;
  private startP: Promise<void> | null = null;
  private epoch = 0;
  private queue: Job[] = [];
  private running: Job | null = null;
  private resetListeners = new Set<(r: ResetReason) => void>();

  constructor(private readonly makeBackend: () => KernelBackend, private readonly recycleBytes = RECYCLE_HEAP_BYTES) {}

  /** Start the instance now (idempotent); failures surface on the next job. */
  warmUp(): void { void this.ensureStarted().catch(() => {}); }

  get idle(): boolean { return !this.running && !this.queue.length; }

  /** Run `fn` with exclusive use of the kernel, after every job queued before it. */
  run<T>(label: string, fn: (c: JobContext) => Promise<T>, opts: JobOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, fn, opts, resolve: resolve as (v: unknown) => void, reject });
      this.status.queued = this.queue.length;
      this.pump();
    });
  }

  /**
   * Cancel the running job if it allows it. With kernel progress (cross-origin isolated), the
   * rebuild stops cleanly and rolls back (the document stays open); if it doesn't answer within
   * `hardAfterMs` (a step that can't be interrupted), or without it, the instance is terminated
   * (every document is reopened by the listeners).
   */
  cancel(hardAfterMs = 4000): boolean {
    const job = this.running;
    if (!job?.opts.cancellable) return false;
    if (this.status.busy?.cancelling || !this.backend?.requestCancel?.(true)) { this.reset('cancel'); return true; }
    if (this.status.busy) this.status.busy = { ...this.status.busy, cancelling: true };
    setTimeout(() => { if (this.running === job) this.reset('cancel'); }, hardAfterMs);
    return true;
  }

  /** Listen for a lost instance (after the queue was flushed). Returns the unsubscriber. */
  onReset(fn: (r: ResetReason) => void): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  /** Terminate the instance for good (tests, page teardown). */
  dispose(): void { this.reset('cancel', false); }

  private ensureStarted(): Promise<void> {
    if (this.startP) return this.startP;
    const epoch = this.epoch;
    this.status.phase = 'starting';
    this.status.error = '';
    this.status.progress = null;
    const b = this.makeBackend();
    this.backend = b;
    b.onRebuild = (p) => { if (epoch === this.epoch && this.running) this.status.rebuild = p.index >= p.count ? { ...p, name: '' } : p; };
    this.startP = b.start(
      (p) => { if (epoch === this.epoch) this.status.progress = p; },
      () => { if (epoch === this.epoch) this.reset('crash'); },
    ).then(({ version, heapBytes }) => {
      if (version.abi !== CAD_KERNEL_ABI) throw new Error(`This CAD kernel speaks ABI ${version.abi}; the app needs ${CAD_KERNEL_ABI}. Update the staged module (scripts/fetch-cad-wasm.sh).`);
      if (epoch !== this.epoch) return;
      this.status.phase = 'ready';
      this.status.version = version;
      this.status.heapBytes = heapBytes;
      this.status.progress = null;
    }, (e: unknown) => { throw e; });
    this.startP.catch((e: unknown) => {
      if (epoch !== this.epoch) return;
      this.status.phase = 'failed';
      this.status.error = e instanceof Error ? e.message : String(e);
      b.terminate();
      this.backend = null;
      this.startP = null; // the next job retries
    });
    return this.startP;
  }

  private pump(): void {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.running = job;
    this.status.queued = this.queue.length;
    if (!job.opts.quiet) this.status.busy = { label: job.label, since: Date.now(), cancellable: !!job.opts.cancellable };
    this.status.rebuild = null;
    this.backend?.requestCancel?.(false);
    const epoch = this.epoch;
    const call: KernelCall = async <T>(method: string, params: Record<string, unknown> = {}, blob: Uint8Array | null = null) => {
      if (epoch !== this.epoch || !this.backend) throw new KernelReset('cancel');
      const r = await this.backend.call(method, params, blob);
      if (epoch !== this.epoch) throw new KernelReset('cancel');
      this.status.heapBytes = r.heapBytes;
      const env: CadEnvelope = r.envelope;
      if (r.rc !== 0 || !env.ok) throw new KernelError(method, env.error?.code ?? -32000, env.error?.message ?? `${method} failed`);
      return { result: env.result as T, blob: r.blob };
    };
    const ctx: JobContext = { call, yieldRequested: () => this.queue.some((j) => !j.opts.quiet) };
    void (async () => {
      try {
        await this.ensureStarted();
        if (epoch !== this.epoch) throw new KernelReset('cancel');
        job.resolve(await job.fn(ctx));
      } catch (e) {
        job.reject(e);
      } finally {
        if (this.running === job) {
          this.running = null;
          this.status.busy = null;
          this.status.rebuild = null;
          this.backend?.requestCancel?.(false);
          if (!this.queue.length && this.status.heapBytes > this.recycleBytes && this.status.phase === 'ready') this.reset('recycle');
          this.pump();
        }
      }
    })();
  }

  private reset(reason: ResetReason, notify = true): void {
    this.epoch++;
    this.backend?.terminate();
    this.backend = null;
    this.startP = null;
    this.status.phase = 'off';
    this.status.busy = null;
    this.status.heapBytes = 0;
    this.status.resets++;
    const err = new KernelReset(reason);
    const running = this.running;
    this.running = null;
    running?.reject(err);
    const queued = this.queue.splice(0);
    this.status.queued = 0;
    for (const j of queued) j.reject(err);
    if (notify) for (const fn of this.resetListeners) { try { fn(reason); } catch (e) { console.error('[design] reset listener', e); } }
  }
}

/** The kernel's artefacts: `public/wasm/cad/` (staged by scripts/fetch-cad-wasm.sh). */
export function cadArtifactBase(): string {
  return new URL(`${import.meta.env.BASE_URL}wasm/cad/`, location.href).href;
}

/** The real backend: cad.worker.ts in a module Worker. */
export class WorkerBackend implements KernelBackend {
  private worker: Worker | null = null;
  private seq = 0;
  /** Shared cancel flag (cross-origin isolated pages only). */
  private cancelFlag: Int32Array | null = null;
  onRebuild?: (p: RebuildProgress) => void;
  private pending = new Map<number, { resolve: (r: RawReply) => void; reject: (e: unknown) => void }>();

  constructor(private readonly base = cadArtifactBase()) {}

  start(onProgress: (p: StartProgress) => void, onFatal: (message: string) => void): Promise<{ version: CadKernelVersion; heapBytes: number }> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module', name: 'cubby-cad-kernel' });
      this.worker = w;
      let ready = false;
      const fail = (message: string, trap: boolean) => {
        const err = trap ? new KernelReset('crash') : new Error(message);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!ready) reject(new Error(message)); else onFatal(message);
      };
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress(m.progress);
        else if (m.type === 'rebuild') this.onRebuild?.({ index: m.index, count: m.count, name: m.name });
        else if (m.type === 'ready') { ready = true; resolve({ version: m.version, heapBytes: m.heapBytes }); }
        else if (m.type === 'reply') { const p = this.pending.get(m.id); this.pending.delete(m.id); p?.resolve(m.reply); }
        else if (m.type === 'fatal') { console.error('[design] CAD kernel:', m.message); fail(m.message, m.trap); }
      };
      w.onerror = (ev) => { ev.preventDefault(); fail(ev.message || 'The CAD kernel worker failed to start.', ready); };
      let sab: SharedArrayBuffer | null = null;
      try { if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') sab = new SharedArrayBuffer(4); } catch { sab = null; }
      this.cancelFlag = sab ? new Int32Array(sab) : null;
      w.postMessage({ type: 'init', base: this.base, cancel: sab } satisfies ToWorker);
    });
  }

  call(method: string, params: unknown, blob: Uint8Array | null): Promise<RawReply> {
    const w = this.worker;
    if (!w) return Promise.reject(new KernelReset('cancel'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Copy: the caller keeps its bytes (they are the undo snapshot), the copy is transferred.
      const b = blob ? blob.slice() : null;
      // Params are JSON for the kernel anyway; this also unwraps Vue proxies (not cloneable).
      w.postMessage({ type: 'call', id, method, params: params === undefined ? undefined : JSON.parse(JSON.stringify(params)), blob: b } satisfies ToWorker, b ? [b.buffer] : []);
    });
  }

  requestCancel(on: boolean): boolean {
    if (!this.cancelFlag) return false;
    Atomics.store(this.cancelFlag, 0, on ? 1 : 0);
    return true;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new KernelReset('cancel'));
    this.pending.clear();
  }
}
