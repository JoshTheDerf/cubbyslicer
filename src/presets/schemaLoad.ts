/**
 * Loading an engine's config schema (engine describe / staged schema.json,
 * dev fixture fallback) and guarding its condition evaluator.
 */
import { getSchema } from '../engine/client';
import { engineCaps } from '../engine/capabilities';
import type { ConfigSchema, EngineId } from '../engine/types';
import type { ConditionEvaluator } from './compat';

export type SchemaSource = 'engine' | 'fixture' | 'none';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function loadFixture(engine: EngineId): Promise<ConfigSchema | null> {
  try {
    const m = engineCaps(engine).orcaConfig
      ? await import('../settings/__fixtures__/orca-schema.sample.json')
      : await import('../settings/__fixtures__/preflight-schema.sample.json');
    return (m.default ?? m) as unknown as ConfigSchema;
  } catch { return null; }
}

/** Engine schema: build-time schema.json / engine describe; dev fixture fallback. */
export async function loadSchema(engine: EngineId): Promise<{ schema: ConfigSchema | null; source: SchemaSource }> {
  try {
    const s = await withTimeout(getSchema(engine), 60_000);
    if (s && s.options && Object.keys(s.options).length) return { schema: s, source: 'engine' };
  } catch { /* fall back */ }
  const f = await loadFixture(engine);
  return f ? { schema: f, source: 'fixture' } : { schema: null, source: 'none' };
}

/**
 * Engine condition evaluation with a timeout; after repeated timeouts the
 * engine is considered unable to evaluate for this session (→ null = compatible),
 * so a broken / still-loading worker can't stall preset lists.
 */
export function guardedEvaluator(inner: ConditionEvaluator, timeoutMs = 8000): ConditionEvaluator {
  let failures = 0;
  return async (expr, cfg) => {
    if (failures >= 2) return null;
    try {
      const r = await withTimeout(inner(expr, cfg), timeoutMs);
      failures = 0;
      return r;
    } catch {
      failures++;
      return null;
    }
  };
}
