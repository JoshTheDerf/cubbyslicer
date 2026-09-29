/** Central invocation used by every surface (menus, palette, toolbar, keyboard). */
import type { AppContext } from './context';
import type { Action } from './types';

let onError: ((a: Action, e: unknown) => void) | null = null;
export function setActionErrorHandler(fn: ((a: Action, e: unknown) => void) | null): void { onError = fn; }

export async function runAction(a: Action, ctx: AppContext): Promise<void> {
  if (a.when && a.when(ctx) === false) return;
  try {
    await a.run(ctx);
  } catch (e) {
    if (onError) onError(a, e); else console.error(`[actions] ${a.id} failed`, e);
  }
}
