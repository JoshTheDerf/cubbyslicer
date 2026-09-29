/**
 * The one keyboard dispatcher (mirrors cad-project/src/actions/dispatch.ts).
 *
 *  - Text inputs: skipped, except Ctrl/⌘ + Z / Y / S / O / I / K / E / G / P, which
 *    should work even while typing. (Z/Y inside a field is the field's own
 *    undo, so those two are only taken when the focused element isn't editable.)
 *  - Modals: while a dialog is open only Ctrl/⌘ combos marked global dispatch.
 *  - Scope: a binding's scope must be 'global' or equal the active scope
 *    (which follows the Prepare / Preview tab).
 *  - Strict modifiers: an unspecified modifier must NOT be held (so bare 'r'
 *    doesn't swallow Ctrl+R). Single non-alphanumeric keys ('?') ignore Shift.
 *  - preventDefault on any match, even if gated off — unless the binding opts
 *    into `passThroughWhenUnavailable` (Tab, Escape), or is `whenFocusIdle`
 *    and focus is in a panel (Ctrl+C, arrows, Shift+Tab keep their native use).
 *  - First registered match that passes its gates wins.
 */
import type { AppContext } from './context';
import type { Action, ActionScope } from './types';
import { runAction } from './run';

let activeScope: ActionScope = 'prepare';
export function setActionScope(s: ActionScope): void { activeScope = s; }
export function getActionScope(): ActionScope { return activeScope; }

export function isTextInputFocused(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    const t = el.type.toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'range', 'color', 'file'].includes(t);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

const TYPING_SAFE = new Set(['s', 'o', 'i', 'k', 'e', 'g', 'p']);

function scopeAllows(s: ActionScope | undefined): boolean {
  return !s || s === 'global' || s === activeScope;
}

export function actionMatchesKey(a: Action, e: KeyboardEvent): boolean {
  const b = a.binding;
  if (!b || b.displayOnly) return false;
  if (b.code) { if (b.code !== e.code) return false; }
  else {
    if (!b.key) return false;
    if (b.key.toLowerCase() !== e.key.toLowerCase()) return false;
  }
  if ((b.ctrlOrMeta ?? false) !== (e.ctrlKey || e.metaKey)) return false;
  const keyEncodesShift = !b.code && !!b.key && b.key.length === 1 && !/[a-z0-9]/i.test(b.key);
  if (!keyEncodesShift && (b.shift ?? false) !== e.shiftKey) return false;
  if ((b.alt ?? false) !== e.altKey) return false;
  return true;
}

export interface DispatchOptions { textInputFocused?: boolean }

/** Route a keydown to the first matching, available action. Returns true if one ran. */
export async function dispatchActionKey(e: KeyboardEvent, actions: Action[], ctx: AppContext, opts: DispatchOptions = {}): Promise<boolean> {
  if (e.defaultPrevented || e.isComposing) return false;
  const mod = e.ctrlKey || e.metaKey;
  const typing = opts.textInputFocused ?? isTextInputFocused();
  if (typing && !(mod && TYPING_SAFE.has(e.key.toLowerCase()))) return false;
  if (ctx.modalOpen && !mod) return false;

  let runnable: Action | null = null;
  let matched: Action | null = null;
  for (const a of actions) {
    if (!actionMatchesKey(a, e)) continue;
    matched ??= a;
    if (!scopeAllows(a.binding?.scope)) continue;
    if (ctx.modalOpen && a.binding?.scope && a.binding.scope !== 'global') continue;
    if (a.binding?.whenFocusIdle && !ctx.focusIdle) continue;
    if (a.when && a.when(ctx) === false) continue;
    runnable = a;
    break;
  }
  if (!matched) return false;
  if (!runnable && (matched.binding?.passThroughWhenUnavailable || (matched.binding?.whenFocusIdle && !ctx.focusIdle))) return false;
  e.preventDefault();
  e.stopPropagation();
  if (!runnable) return false;
  await runAction(runnable, ctx);
  return true;
}

let listener: ((e: KeyboardEvent) => void) | null = null;

/** Install the global keydown listener (idempotent). */
export function installActionKeyListener(getActions: () => Action[], getContext: () => AppContext | null): void {
  if (listener) return;
  listener = (e: KeyboardEvent) => {
    const ctx = getContext();
    if (ctx) void dispatchActionKey(e, getActions(), ctx);
  };
  window.addEventListener('keydown', listener);
}

export function uninstallActionKeyListener(): void {
  if (listener) window.removeEventListener('keydown', listener);
  listener = null;
}
