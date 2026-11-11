import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markRaw, ref } from 'vue';
import { guardOpenSubmenus, isOnOpenSubmenuTrigger, OPEN_SUBMENU_TRIGGER, shieldOpenSubmenuTrigger } from './submenuGuard';

/** A stand-in element whose ancestors match `matches` (only the guard's selector is asked). */
const el = (matches: boolean) => ({ closest: (s: string) => (s === OPEN_SUBMENU_TRIGGER && matches ? {} : null) });
const move = (target: unknown) => { let prevented = false; shieldOpenSubmenuTrigger({ target, preventDefault: () => { prevented = true; } }); return prevented; };

describe('submenu guard (Reka closes an open submenu on a move over its own trigger)', () => {
  it('the bug it works around: Reka compares the highlight with an auto-unwrapped trigger ref', () => {
    // MenuContentImpl: activeSubmenuContext.value = { onOpenChange, trigger: subContext.trigger }, then
    // `el !== activeSubmenuContext.value.trigger.value` — `.trigger` is unwrapped by the reactive ref.
    const button = markRaw({ tagName: 'BUTTON', value: '' }); // Vue never proxies a DOM element either
    const active = ref<{ trigger: unknown } | undefined>();
    active.value = { trigger: ref(button) };
    const trigger = active.value.trigger as { value?: unknown };
    expect(trigger).toBe(button);
    expect(trigger.value).toBe('');
    expect(button !== trigger.value).toBe(true); // the trigger itself counts as "another item"
  });

  it('prevents a pointer move on the trigger of an open submenu, nothing else', () => {
    expect(move(el(true))).toBe(true);
    expect(move(el(false))).toBe(false);
    expect(move(null)).toBe(false);
    expect(move({})).toBe(false); // a non-element target (window, text)
    expect(isOnOpenSubmenuTrigger(el(true))).toBe(true);
  });

  it('selector: an open submenu trigger inside menu content only', () => {
    expect(OPEN_SUBMENU_TRIGGER).toBe('[data-reka-menu-content] [aria-haspopup="menu"][data-state="open"]');
  });

  it('installs a capture listener while the menu is mounted and removes the same one', () => {
    const calls: string[] = [];
    let added: unknown;
    const doc = {
      addEventListener: (t: string, f: unknown, c: unknown) => { calls.push(`add ${t} ${c}`); added = f; },
      removeEventListener: (t: string, f: unknown, c: unknown) => { calls.push(`remove ${t} ${c} ${f === added}`); },
    };
    const off = guardOpenSubmenus(doc as unknown as Document);
    off();
    expect(calls).toEqual(['add pointermove true', 'remove pointermove true true']);
  });

  it('the offer menu keeps the guard while the installed Reka still has the comparison', () => {
    const reka = readFileSync(resolve(process.cwd(), 'node_modules/reka-ui/dist/Menu/MenuContentImpl.js'), 'utf8');
    const offer = readFileSync(resolve(process.cwd(), 'src/design/ui/OfferMenu.vue'), 'utf8');
    if (reka.includes('el !== activeSubmenuContext.value.trigger.value')) {
      expect(offer).toMatch(/guardOpenSubmenus\(\)/);
      expect(offer).toMatch(/unguard\(\)/);
    }
  });
});
