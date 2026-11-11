/**
 * Keeps an open submenu of a Nuxt UI / Reka dropdown or context menu open while the pointer moves
 * over its own trigger.
 *
 * Reka UI 2.10 (Menu/MenuContentImpl) closes the active submenu whenever the parent menu's
 * highlighted item changes to anything but its trigger, comparing against
 * `activeSubmenuContext.value.trigger.value` — but `activeSubmenuContext` is a ref, so `.trigger`
 * comes back already unwrapped (the button) and `.value` is the button's empty `value` string: every
 * highlight change counts as "another item". Separately, MenuItemImpl's focus handler sets the
 * highlight to `event.currentTarget` after an `await nextTick()`, i.e. to null. So a single pointer
 * move onto a submenu trigger (highlight = trigger, then focus → null), the 100 ms open timer, then
 * any later move on that same trigger (highlight null → trigger) closes the submenu it just opened.
 * Playwright's hover does exactly that when it retries its move; a person sees the submenu flicker.
 *
 * MenuItemImpl ignores a pointermove whose default is prevented, so the guard prevents it on the
 * trigger of an open submenu, where there is nothing to change (the submenu is already open and its
 * trigger shown as such). Moves onto any other item still highlight it and close the submenu, as
 * they should.
 */

/** The trigger of an open submenu inside a menu's content: a pointer move here must not re-highlight it. */
export const OPEN_SUBMENU_TRIGGER = '[data-reka-menu-content] [aria-haspopup="menu"][data-state="open"]';

type Closest = { closest(selector: string): unknown };

/** True when a pointer move on `target` would (wrongly) close the submenu `target` opened. */
export function isOnOpenSubmenuTrigger(target: unknown): boolean {
  return !!target && typeof (target as Closest).closest === 'function' && !!(target as Closest).closest(OPEN_SUBMENU_TRIGGER);
}

/** The listener: capture phase, before Reka's handlers on the item. */
export function shieldOpenSubmenuTrigger(e: { target: unknown; preventDefault(): void }): void {
  if (isOnOpenSubmenuTrigger(e.target)) e.preventDefault();
}

/** Installs the guard on `doc` while a menu is mounted; returns the uninstaller. */
export function guardOpenSubmenus(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  doc.addEventListener('pointermove', shieldOpenSubmenuTrigger as EventListener, true);
  return () => doc.removeEventListener('pointermove', shieldOpenSubmenuTrigger as EventListener, true);
}
