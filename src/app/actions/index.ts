/**
 * Public API of the action system. Other areas contribute commands with
 * `registerActions([...])` (see registry.ts for an example) and read the
 * live context with `getActionContext()`.
 */
export type { Action, ActionCategory, ActionScope, ActionState, KeyBinding } from './types';
export type { AppContext, ActionDispatch } from './context';
export { getActionContext } from './context';
export { registerActions, getAction, getAllActions, actionsRevision } from './registry';
export { formatBinding, formatBindingTokens, detectPlatform } from './formatBinding';
export { runAction } from './run';
export { getActionScope } from './dispatch';
