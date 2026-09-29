/**
 * KeyBinding → display string + kbd-chip tokens (mirrors
 * cad-project/src/actions/formatBinding.ts), with macOS glyphs.
 */
import type { KeyBinding } from './types';

export type Platform = 'mac' | 'other';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p) ? 'mac' : 'other';
}

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  delete: 'Del',
  backspace: 'Backspace',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

function codeLabel(code: string): string {
  const m = code.match(/^([A-Za-z]+?)(\d+)$/);
  return m ? `${m[1]} ${m[2]}` : code;
}

function keyLabel(key: string): string {
  const l = key.toLowerCase();
  if (KEY_LABELS[l]) return KEY_LABELS[l];
  if (key.length === 1) return key.toUpperCase();
  return key.length > 1 ? key[0].toUpperCase() + key.slice(1) : key;
}

/** Ordered chips, e.g. ['Ctrl', 'Shift', 'Z'] or ['⌘', '⇧', 'Z']. */
export function formatBindingTokens(b: KeyBinding | undefined, platform: Platform = detectPlatform()): string[] {
  if (!b) return [];
  if (b.displayTokens) return b.displayTokens;
  const base = b.code ? codeLabel(b.code) : b.key ? keyLabel(b.key) : '';
  if (!base) return [];
  const mac = platform === 'mac';
  const t: string[] = [];
  if (b.ctrlOrMeta) t.push(mac ? '⌘' : 'Ctrl');
  if (b.alt) t.push(mac ? '⌥' : 'Alt');
  if (b.shift) t.push(mac ? '⇧' : 'Shift');
  t.push(base);
  return t;
}

/** Display string, e.g. 'Ctrl+Shift+Z' (mac: '⌘⇧Z'). Empty for keyless bindings. */
export function formatBinding(b: KeyBinding | undefined, platform: Platform = detectPlatform()): string {
  const t = formatBindingTokens(b, platform);
  return platform === 'mac' ? t.join('') : t.join('+');
}
