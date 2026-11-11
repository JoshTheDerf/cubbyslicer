/**
 * Which feature makes a document fail? The kernel reports only the rebuild's message (Orca's
 * `recompute()` stops at the first failing feature and leaves no bodies). The replay is
 * sequential, so "the history up to feature k rebuilds" is monotone in k: a binary search over
 * prefixes finds the first failing feature in log2(n) probes. Each probe opens a scratch copy
 * of the saved bytes and force-suppresses every enabled feature after k (one rebuild); probes
 * stop at the failure, so they cost no more than replaying the history up to it.
 *
 * Runs as a preemptible background job: it gives way ('yielded') when an edit is queued.
 */
import type { JobContext } from './kernel/client';
import type { DocOpenResult, MutationResult, SceneFeature } from './kernel/types';

export interface FirstFailure { index: number; error: string }

/** null: the saved bytes rebuild (nothing to find); 'yielded': another job came first. */
export async function findFirstFailure(c: JobContext, bytes: Uint8Array, features: readonly SceneFeature[]): Promise<FirstFailure | null | 'yielded'> {
  const enabled = features.filter((f) => f.enabled).map((f) => f.index);
  if (!enabled.length) return null;
  const probe = async (k: number): Promise<{ ok: boolean; error: string }> => {
    const { result: o } = await c.call<DocOpenResult>('doc_open', {}, bytes);
    try {
      const later = enabled.filter((i) => i > k);
      if (!later.length) return { ok: o.ok, error: o.error };
      const { result: r } = await c.call<MutationResult>('suppress_feature', { doc: o.doc, indices: later, suppressed: true, force: true });
      return { ok: r.ok, error: r.error ?? '' };
    } finally {
      await c.call('doc_close', { doc: o.doc }).catch(() => {});
    }
  };
  // Invariant: the prefix ending at enabled[hi] fails; the one ending before enabled[lo] rebuilds.
  let lo = 0, hi = enabled.length - 1;
  let error = '';
  const full = await probe(enabled[hi]);
  if (full.ok) return null;
  error = full.error;
  while (lo < hi) {
    if (c.yieldRequested()) return 'yielded';
    const mid = (lo + hi) >> 1;
    const r = await probe(enabled[mid]);
    if (r.ok) lo = mid + 1; else { hi = mid; error = r.error; }
  }
  return { index: enabled[lo], error };
}
