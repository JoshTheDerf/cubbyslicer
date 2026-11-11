/**
 * Public API of the action system. Built-ins are registered at boot
 * (buildActions.ts `builtinActions`); runtime contributors (plugins) add and
 * remove theirs with `registerActions(list, source)` / the returned disposer /
 * `unregisterSource(id)` (see registry.ts). Everything reads the live context
 * with `getActionContext()`.
 */
export type { Action, ActionCategory, ActionScope, ActionState, KeyBinding } from './types';
export type { AppContext, ActionDispatch } from './context';
export { getActionContext } from './context';
export { registerActions, unregisterSource, getAction, getAllActions, getActionSource, actionsRevision, APP_SOURCE, type ActionSource, type ActionRegistration } from './registry';
export { formatBinding, formatBindingTokens, detectPlatform } from './formatBinding';
export { runAction } from './run';
export { getActionScope } from './dispatch';
