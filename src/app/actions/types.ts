/**
 * Action registry: the declarative command record.
 *
 * Shared with CubbyCAD through @cubby/shared/actions. An Action is declared ONCE and
 * projected onto every surface: the top menu bar, the command palette, the
 * floating plate toolbar, context menus, the keyboard dispatcher and the
 * shortcuts help dialog. `when` / `state` / `run` / `dynamicTitle` read the
 * single reactive `AppContext`, so families stay pure data modules.
 */
import type { ActionBase, ActionState, KeyBinding as SharedKeyBinding } from '@cubby/shared/actions';
import type { AppContext } from './context';

export type ActionCategory =
  | 'File' | 'Edit' | 'View' | 'Object' | 'Arrange' | 'Slice' | 'Export' | 'Preview' | 'Settings' | 'Help'
  // Other areas may introduce their own categories.
  | (string & {});

/**
 * Keyboard activation scope. `global` works everywhere; `prepare` / `preview`
 * only while that centre view is active (the dispatcher's active scope follows
 * `activeView`).
 */
export type ActionScope = 'global' | 'prepare' | 'preview';

/** Declarative key binding (shared with CubbyCAD, see @cubby/shared/actions). */
export type KeyBinding = SharedKeyBinding<ActionScope>;

export type { ActionState };

export interface Action extends ActionBase<AppContext, ActionCategory, ActionScope> {
  /** Exclude from the command palette (e.g. binding twins like Ctrl+Y redo). */
  paletteHidden?: boolean;
  /** Visual tone on the toolbar. */
  tone?: 'default' | 'danger';
}
