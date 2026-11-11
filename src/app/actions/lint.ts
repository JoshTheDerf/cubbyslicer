/**
 * Key-binding conflict rules, shared by the registry lint test (static
 * table) and `registerActions` (runtime contributions such as plugins).
 * Two dispatching bindings conflict when they are the same key + modifiers in
 * overlapping scopes (`global` overlaps everything).
 */
import type { Action } from './types';

/** Same key, mutually exclusive `when` gates; the first registered wins. Keys are `earlier|later` ids. */
export const INTENTIONAL_OVERLAPS = new Set([
  // Esc: close the shape palette > close the open tool > cancel a running slice > close a paint tool
  // > cancel lay-on-face picking > clear selection.
  ...pairs(['tool.palette.close', 'tool.close', 'slice.cancel', 'paint.close', 'object.lay-on-face.cancel', 'edit.select-none']),
  // Design view (src/design): close the right-click offer menu > cancel a running slice > cancel a long
  // rebuild > stop picking a reference > close the open feature card > clear the design selection.
  ...pairs(['design.offer.close', 'slice.cancel', 'design.cancel', 'design.pick.cancel', 'design.card.cancel', 'design.sketch.plane-cancel', 'design.select-none']),
  // Sketcher (scope 'sketch'): a running slice first, then Orca's Esc ladder inside the sketch.
  'slice.cancel|design.sketch.escape',
  // F2 in the Design view: rename the selected feature, else the picked body.
  'design.feature.rename|design.body.rename',
  // Delete / Backspace: delete the open tool's selection (cut connectors, brim ears) before the objects.
  'tool.delete-selected|edit.delete',
  'tool.delete-selected-backspace|edit.delete-backspace',
]);

function pairs(order: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) out.push(`${order[i]}|${order[j]}`);
  return out;
}

/** Whether an action's binding reaches the dispatcher. */
export function dispatches(a: Action): boolean {
  return !!a.binding && !a.binding.displayOnly && !!(a.binding.key || a.binding.code);
}

export function bindingSignature(a: Action): string {
  const b = a.binding!;
  return `${b.code ?? b.key?.toLowerCase()}|${!!b.ctrlOrMeta}|${!!b.shift}|${!!b.alt}`;
}

export function scopesOverlap(x: Action, y: Action): boolean {
  const sx = x.binding!.scope ?? 'global', sy = y.binding!.scope ?? 'global';
  return sx === 'global' || sy === 'global' || sx === sy;
}

/** The first of `others` whose binding conflicts with `a`'s (allowlisted pairs excepted). */
export function findBindingConflict(a: Action, others: readonly Action[]): Action | undefined {
  if (!dispatches(a)) return undefined;
  const sig = bindingSignature(a);
  return others.find((o) => o.id !== a.id && dispatches(o) && bindingSignature(o) === sig && scopesOverlap(a, o)
    && !INTENTIONAL_OVERLAPS.has(`${o.id}|${a.id}`) && !INTENTIONAL_OVERLAPS.has(`${a.id}|${o.id}`));
}

/** Every conflicting pair in a table, in registration order. */
export function bindingConflicts(actions: readonly Action[]): Array<[Action, Action]> {
  const out: Array<[Action, Action]> = [];
  for (let i = 0; i < actions.length; i++) {
    const c = findBindingConflict(actions[i], actions.slice(i + 1));
    if (c) out.push([actions[i], c]);
  }
  return out;
}
