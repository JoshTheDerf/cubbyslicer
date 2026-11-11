/**
 * The action registry: one live list of every command, in registration order
 * (the keyboard dispatcher's first-match tie-breaker). `actionsRevision` bumps
 * on every change so projected surfaces (menus, palette, toolbar, shortcuts
 * help) recompute.
 *
 * Every registration has a source, the owner tag of what contributed it:
 * `app` for the built-in table, an area (`preview`, `settings`, …) or, at
 * runtime, a plugin (`plugin:<key>`). Built-ins are registered once at boot
 * (./builtins.ts) and gated with `when`. Runtime contributors add and remove
 * whole sets:
 *
 *   const dispose = registerActions([{ id: 'plugin.hello.run', title: 'Say hello',
 *     category: 'Hello', description: 'Prints a greeting.', run: () => greet() }],
 *     { id: 'plugin:hello', name: 'Hello plugin' });
 *   …
 *   dispose();                      // or unregisterSource('plugin:hello')
 *
 * Rules (checked here, so a plugin can't break the app's own commands):
 *  - an id owned by another source is refused (the rest of the batch still registers);
 *  - registering an id again from the same source replaces it in place (upsert);
 *  - a binding that would collide with a live one in an overlapping scope is
 *    dropped (the action stays, reachable from the palette) — see ./lint.ts.
 * Refusals are reported through `console.warn` and the returned handle.
 */
import { ref } from 'vue';
import { findBindingConflict } from './lint';
import type { Action } from './types';

/** Who contributed an action. `id` is the owner tag; `name` is shown next to plugin commands in the palette. */
export interface ActionSource {
  id: string;
  name?: string;
}

/** The built-in table's source. */
export const APP_SOURCE: ActionSource = { id: 'app', name: 'CubbySlicer' };

/** A disposer that also reports what the registration did. */
export interface ActionRegistration {
  (): void;
  /** Ids now registered by this call. */
  readonly ids: readonly string[];
  /** Ids refused (owned by another source, or malformed). */
  readonly refused: readonly string[];
  /** Ids registered without their key binding (it collided with a live one). */
  readonly unbound: readonly string[];
}

interface Entry { action: Action; source: ActionSource }

const registry = new Map<string, Entry>();

export const actionsRevision = ref(0);
const changed = () => { actionsRevision.value++; };

function wellFormed(a: Action): boolean {
  return !!a && typeof a.id === 'string' && !!a.id && typeof a.title === 'string' && !!a.title && typeof a.run === 'function';
}

/**
 * Register a batch under `source` (default: the app). Returns a disposer that
 * removes exactly the actions this call registered, if they are still the
 * live ones (a later upsert from the same source takes them over).
 */
export function registerActions(list: readonly Action[], source: ActionSource | string = APP_SOURCE): ActionRegistration {
  const src: ActionSource = typeof source === 'string' ? { id: source } : source;
  const ids: string[] = [], refused: string[] = [], unbound: string[] = [];
  const mine: Action[] = [];
  for (const raw of list) {
    if (!wellFormed(raw)) { refused.push(raw?.id ?? '(no id)'); continue; }
    const prev = registry.get(raw.id);
    if (prev && prev.source.id !== src.id) { refused.push(raw.id); continue; }
    let a = raw;
    if (src.id !== APP_SOURCE.id && a.binding) {
      const others = [...registry.values()].filter((e) => e.action.id !== a.id).map((e) => e.action);
      if (findBindingConflict(a, others)) { a = { ...a, binding: undefined }; unbound.push(a.id); }
    }
    registry.set(a.id, { action: a, source: src });
    mine.push(a);
    ids.push(a.id);
  }
  if (refused.length) console.warn(`[actions] ${src.id}: refused ${refused.join(', ')} (id taken by another source or malformed)`);
  if (unbound.length) console.warn(`[actions] ${src.id}: dropped the key binding of ${unbound.join(', ')} (it collides with an existing one)`);
  if (mine.length) changed();
  const dispose = (() => {
    let any = false;
    for (const a of mine) if (registry.get(a.id)?.action === a) { registry.delete(a.id); any = true; }
    mine.length = 0;
    if (any) changed();
  }) as ActionRegistration;
  return Object.assign(dispose, { ids, refused, unbound });
}

/** Remove every action a source registered. Returns how many were removed. */
export function unregisterSource(sourceId: string): number {
  let n = 0;
  for (const [id, e] of registry) if (e.source.id === sourceId) { registry.delete(id); n++; }
  if (n) changed();
  return n;
}

export function getAction(id: string): Action | undefined { return registry.get(id)?.action; }

/** Live snapshot in registration order. */
export function getAllActions(): Action[] { return [...registry.values()].map((e) => e.action); }

/** The source that registered an action. */
export function getActionSource(id: string): ActionSource | undefined { return registry.get(id)?.source; }

/** Test / hot-reload escape hatch. */
export function clearActions(): void { registry.clear(); changed(); }
