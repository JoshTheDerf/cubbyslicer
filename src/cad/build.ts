/**
 * Evaluating a CAD object's node tree into its mesh with the shared
 * evaluator (`@cubby/shared/cad`, manifold-3d loaded lazily and shared with
 * the mesh boolean tool). Results are cached by `hashCadNode`.
 *
 * Two paths share the cache:
 * - `warmCadMesh` (async) evaluates in a Web Worker (./eval.worker.ts), so a
 *   big tree never blocks the UI. Commands warm the tree first, then commit.
 * - `evaluateCadMesh` (sync) is what the store calls inside an undo step; it
 *   hits the warmed cache, else evaluates on the main thread (tests, no
 *   Worker, or a tree nobody warmed).
 */
import { ref } from 'vue';
import { cadSupport, evaluateCadNode, hashCadNode, type CadNode, type EvalIssue, type EvalResult, type ManifoldWasm } from './api';
import { loadManifold } from '../tools/boolean/boolean';

/** manifold-3d's module, as the shared code types it (a hand-written subset). */
type Wasm = ManifoldWasm;
let wasm: Wasm | null = null;

/** Load manifold-3d on the main thread once (idempotent). */
export async function ensureCadWasm(): Promise<Wasm> {
  wasm ??= (await loadManifold()) as unknown as Wasm;
  cadWasmLoaded.value = true;
  return wasm;
}
/** Reactive: the modelling engine is loaded (views that evaluate on demand re-run). */
export const cadWasmLoaded = ref(false);

export class CadEvalError extends Error { override name = 'CadEvalError'; }

export interface CadMeshResult { hash: string; positions: Float32Array; indices: Uint32Array; issues: EvalIssue[] }
type LocalMesh = { positions: Float32Array; indices: Uint32Array } | null;

const CACHE_MAX = 48;
const cache = new Map<string, CadMeshResult>();
const localCache = new Map<string, LocalMesh>();
function remember<V>(m: Map<string, V>, k: string, v: V): V {
  m.delete(k); m.set(k, v);
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value!);
  return v;
}

/** The tree as it is evaluated for display: a top-level hole renders as its solid (shown as a ghost, not printed). */
function displayRoot(node: CadNode): CadNode {
  if (node.contribution !== 'subtract') return node;
  const { contribution: _c, ...rest } = node;
  return rest as CadNode;
}

/** A node on its own, in its local frame (the gizmo proxy of a picked child). */
function localRoot(node: CadNode): CadNode {
  const { transform: _t, contribution: _c, hidden: _h, ...rest } = node;
  return rest as CadNode;
}

/** The root is a hole on its own: displayed as a ghost and left out of slicing, like CubbyCAD. */
export function isHoleObject(node: CadNode | undefined): boolean { return node?.contribution === 'subtract'; }

function toResult(hash: string, r: EvalResult): CadMeshResult {
  if (!r.mesh || !r.mesh.indices.length) {
    const why = r.issues.find((i) => i.reason !== 'csg-failed') ?? r.issues[0];
    throw new CadEvalError(why ? `Nothing to show: ${why.message}` : 'Nothing to show: every shape is hidden or a hole.');
  }
  return { hash, positions: r.mesh.positions, indices: r.mesh.indices, issues: r.issues };
}

/**
 * Evaluate a root node (its own transform excluded; the object's TRS places
 * it) in the slicer's Z-up frame, from the cache when it was warmed. Throws
 * CadEvalError when nothing can be built (everything hidden, or only
 * CubbyCAD-only content without a baked mesh).
 */
export function evaluateCadMesh(node: CadNode): CadMeshResult {
  const hash = hashCadNode(node);
  const hit = cache.get(hash);
  if (hit) return remember(cache, hash, hit);
  if (!wasm) throw new CadEvalError('The modelling engine is still loading.');
  return remember(cache, hash, toResult(hash, evaluateCadNode(wasm, displayRoot(node), { frame: 'zup' })));
}

// ---- the evaluation worker -----------------------------------------------------------------

interface WorkerReply { id: number; mesh?: { positions: Float32Array; indices: Uint32Array } | null; issues?: EvalIssue[]; error?: string }

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (r: EvalResult) => void; reject: (e: Error) => void }>();
const inflight = new Map<string, Promise<unknown>>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  try {
    worker = new Worker(new URL('./eval.worker.ts', import.meta.url), { type: 'module', name: 'cubby-cad' });
  } catch { return null; }
  worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
    const d = ev.data;
    const w = waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    if (d.error !== undefined) w.reject(new Error(d.error));
    else w.resolve({ mesh: d.mesh ?? null, issues: d.issues ?? [] });
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    // Fall back to the main thread for good.
    worker?.terminate();
    worker = null;
    for (const w of waiting.values()) w.reject(new Error('worker-failed'));
    waiting.clear();
  };
  return worker;
}

async function evaluateOffThread(node: CadNode, frame: 'zup' | 'render'): Promise<EvalResult> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<EvalResult>((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, node, frame });
      });
    } catch (e) {
      if ((e as Error).message !== 'worker-failed') throw e;
    }
  }
  const m = await ensureCadWasm();
  return evaluateCadNode(m, node, { frame });
}

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = inflight.get(key) as Promise<T> | undefined;
  if (p) return p;
  const q = fn().finally(() => inflight.delete(key));
  inflight.set(key, q);
  return q;
}

/**
 * Evaluate a root off the main thread and cache it, so the store's
 * synchronous `evaluateCadMesh` finds it. Same errors as `evaluateCadMesh`.
 */
export async function warmCadMesh(node: CadNode): Promise<CadMeshResult> {
  const hash = hashCadNode(node);
  const hit = cache.get(hash);
  if (hit) return hit;
  return once(`r:${hash}`, async () => remember(cache, hash, toResult(hash, await evaluateOffThread(displayRoot(node), 'zup'))));
}

/** Bumps when an off-thread local (proxy) mesh arrives, so views that asked re-read it. */
export const cadLocalMeshes = ref(0);

/**
 * One node's own geometry in its local render frame (its transform, hole flag
 * and visibility ignored): what the gizmo proxy shows for a picked child.
 * Returns the cached mesh, or null and evaluates it in the background
 * (`cadLocalMeshes` bumps when it lands).
 */
export function evaluateNodeLocal(node: CadNode): LocalMesh {
  const n = localRoot(node);
  const hash = hashCadNode(n);
  if (localCache.has(hash)) return localCache.get(hash)!;
  void once(`l:${hash}`, async () => {
    let out: LocalMesh = null;
    try {
      const r = await evaluateOffThread(n, 'render');
      out = r.mesh?.indices.length ? { positions: r.mesh.positions, indices: r.mesh.indices } : null;
    } catch { out = null; }
    remember(localCache, hash, out);
    cadLocalMeshes.value++;
  });
  return null;
}

/** Per-node support, for the tree's badges. */
export function supportIssues(node: CadNode): Map<string, EvalIssue> {
  return new Map(cadSupport(node).issues.map((i) => [i.nodeId, i]));
}
