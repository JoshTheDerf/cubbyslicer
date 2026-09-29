import type { Action } from '../types';

export function helpActions(): Action[] {
  return [
    { id: 'help.palette', title: 'Command palette', icon: 'i-lucide-search', category: 'Help', aliases: ['commands', 'search', 'find action'],
      binding: { key: 'k', ctrlOrMeta: true }, paletteHidden: true, run: (c) => c.dispatch.openPalette() },
    { id: 'help.palette-alt', title: 'Command palette', icon: 'i-lucide-search', category: 'Help', hidden: true, paletteHidden: true,
      binding: { key: 'p', ctrlOrMeta: true, shift: true }, run: (c) => c.dispatch.openPalette() },
    { id: 'help.shortcuts', title: 'Keyboard shortcuts', icon: 'i-lucide-keyboard', category: 'Help', aliases: ['keys', 'hotkeys', 'help'],
      binding: { key: '?' }, run: (c) => c.dispatch.openShortcuts() },
    { id: 'help.about', title: 'Source and licence', icon: 'i-lucide-code-xml', category: 'Help', aliases: ['agpl', 'about', 'license', 'github'],
      run: (c) => c.dispatch.openAbout() },
  ];
}
