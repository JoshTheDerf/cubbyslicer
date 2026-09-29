/**
 * Action registry: the declarative command record.
 *
 * Mirrors cad-project/src/actions/types.ts. An Action is declared ONCE and
 * projected onto every surface: the top menu bar, the command palette, the
 * floating plate toolbar, context menus, the keyboard dispatcher and the
 * shortcuts help dialog. `when` / `state` / `run` / `dynamicTitle` read the
 * single reactive `AppContext`, so families stay pure data modules.
 */
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

/** Declarative key binding: the single source for display chips and dispatch matching. */
export interface KeyBinding {
  /** Lower-cased `event.key`, e.g. 'z', 'delete', 'escape', '?'. */
  key?: string;
  /** `event.code` (layout independent, e.g. 'Numpad1'). Takes precedence over `key`. */
  code?: string;
  /** Ctrl on Windows/Linux, ⌘ on macOS. */
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Defaults to 'global'. */
  scope?: ActionScope;
  /** Verbatim display chips (overrides the derived tokens). */
  displayTokens?: string[];
  /** Tooltip/help chip only; the dispatcher ignores it. */
  displayOnly?: boolean;
  /**
   * By default a matching key is preventDefault'ed even when the action is
   * gated off (so e.g. Ctrl+S never opens the browser's save dialog). Keys
   * that have an important native meaning (Tab, Escape) set this so they fall
   * through to the browser / focused widget when the action isn't available.
   */
  passThroughWhenUnavailable?: boolean;
  /**
   * Keyboard only: dispatch just while focus is idle (body / the viewport
   * canvas) and no text is selected, so e.g. Ctrl+C / arrows / Tab keep their
   * native meaning inside panels. Menus and the palette ignore this gate.
   * Implies `passThroughWhenUnavailable` when focus isn't idle.
   */
  whenFocusIdle?: boolean;
}

export type ActionState = 'on' | 'off' | 'active' | undefined;

export interface Action {
  /** Namespaced, stable, unique. e.g. 'object.mirror.x', 'slice.run'. */
  id: string;
  /** Human label (sentence case). */
  title: string;
  /** Nuxt UI icon name (lucide via @iconify-json/lucide), e.g. 'i-lucide-save'. */
  icon?: string;
  category: ActionCategory;
  /** Extra search terms for the palette. */
  aliases?: string[];
  binding?: KeyBinding;
  /** Availability. Pure, synchronous and cheap (called inside computeds and on every keypress). */
  when?: (ctx: AppContext) => boolean;
  /** Toggle / active state: ✓ in menus, highlighted toolbar button, "Turn on/off" in the palette. */
  state?: (ctx: AppContext) => ActionState;
  /** Label swaps ("Hide" / "Show"). Menus keep `title` + ✓ when `state` is set. */
  dynamicTitle?: (ctx: AppContext) => string;
  dynamicIcon?: (ctx: AppContext) => string;
  /** Side effect. May be async. */
  run: (ctx: AppContext) => void | Promise<void>;
  /** Hide from the shortcuts help dialog (still in the palette unless `paletteHidden`). */
  hidden?: boolean;
  /** Exclude from the command palette (e.g. binding twins like Ctrl+Y redo). */
  paletteHidden?: boolean;
  /** Visual tone on the toolbar. */
  tone?: 'default' | 'danger';
}
