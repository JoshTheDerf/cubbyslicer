/**
 * Action registry singleton (mirrors cad-project/src/actions/registry.ts).
 *
 * Actions are always registered and gated with `when` — surfaces never add or
 * remove commands at runtime. Other areas contribute with:
 *
 *   import { registerActions } from '@/app/actions';
 *   const dispose = registerActions([{ id: 'preview.layer.up', title: 'Next layer',
 *     category: 'Preview', binding: { key: 'arrowup', scope: 'preview' },
 *     when: () => hasSlice.value, run: () => layerUp() }]);
 *
 * `actionsRevision` bumps on every change so projected surfaces recompute.
 */
import { ref } from 'vue';
import type { Action } from './types';

const registry = new Map<string, Action>();
export const actionsRevision = ref(0);

/** Register a batch. Returns a disposer removing exactly these (if still live). */
export function registerActions(list: Action[]): () => void {
  for (const a of list) {
    if (registry.has(a.id)) console.warn(`[actions] overwriting existing action "${a.id}"`);
    registry.set(a.id, a);
  }
  actionsRevision.value++;
  return () => {
    let changed = false;
    for (const a of list) if (registry.get(a.id) === a) { registry.delete(a.id); changed = true; }
    if (changed) actionsRevision.value++;
  };
}

export function getAction(id: string): Action | undefined { return registry.get(id); }

/** Live snapshot in registration order (the dispatcher's first-match tie-breaker). */
export function getAllActions(): Action[] { return Array.from(registry.values()); }

/** Test / hot-reload escape hatch. */
export function clearActions(): void { registry.clear(); actionsRevision.value++; }
