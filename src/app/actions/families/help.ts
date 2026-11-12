import { preferences } from '../../preferences';
import type { Action } from '../types';

export function helpActions(): Action[] {
  return [
    { id: 'help.palette', title: 'Command palette', icon: 'i-lucide-search', category: 'Help', aliases: ['commands', 'search', 'find action', 'speed dial'],
      binding: { key: 'k', ctrlOrMeta: true }, paletteHidden: true, run: (c) => c.dispatch.openPalette() },
    { id: 'help.palette-alt', title: 'Command palette', icon: 'i-lucide-search', category: 'Help', hidden: true, paletteHidden: true,
      binding: { key: 'p', ctrlOrMeta: true, shift: true }, run: (c) => c.dispatch.openPalette() },
    // Orca 2.5 Speed Dial: Space opens it anywhere but in a text field (here: while focus is idle,
    // so Space still presses a focused button), unless the "Open the Speed Dial from the keyboard"
    // preference is off (MainFrame: Shortcut::SpeedDial checks enable_speed_dial).
    { id: 'help.palette-space', title: 'Command palette', icon: 'i-lucide-search', category: 'Help', paletteHidden: true, when: () => preferences.speedDial,
      binding: { key: ' ', whenFocusIdle: true, passThroughWhenUnavailable: true }, run: (c) => c.dispatch.openPalette() },
    { id: 'help.shortcuts', title: 'Keyboard shortcuts', icon: 'i-lucide-keyboard', category: 'Help', aliases: ['keys', 'hotkeys', 'help'],
      binding: { key: '?' }, run: (c) => c.dispatch.openShortcuts() },
    { id: 'help.about', title: 'Source and licence', icon: 'i-lucide-code-xml', category: 'Help', aliases: ['agpl', 'about', 'license', 'github'],
      run: (c) => c.dispatch.openAbout() },
  ];
}
