/**
 * Physical printer commands for the app action registry (menus, palette,
 * keyboard). Orca: Ctrl+Shift+G = "Print plate" (send to print host),
 * KBShortcutsDialog.cpp.
 */
import type { Action } from '../app/actions/types';
import type { AppContext } from '../app/actions/context';
import { registerActions } from '../app/actions/registry';
import { openWebUi } from './send';
import { hostReady, openPhysicalPrinterDialog, openSendDialog, physicalPrinter, printhostUi } from './store';

const canSend = (c: AppContext) => c.slice.available && c.slice.hasResult && !c.slice.busy && hostReady.value && !printhostUi.uploading;

export const printhostActions: Action[] = [
  {
    id: 'printer.print', title: 'Print plate on printer…', icon: 'i-lucide-printer', category: 'Export',
    aliases: ['send to print', 'upload and print', 'octoprint', 'klipper', 'moonraker', 'prusalink', 'duet', 'print host'],
    binding: { key: 'g', ctrlOrMeta: true, shift: true }, when: canSend, run: () => openSendDialog('print'),
  },
  {
    id: 'printer.send', title: 'Send G-code to printer…', icon: 'i-lucide-send', category: 'Export',
    aliases: ['upload gcode', 'print host', 'physical printer', 'octoprint', 'klipper'],
    when: canSend, run: () => openSendDialog('upload'),
  },
  {
    id: 'printer.setup', title: 'Physical printer…', icon: 'i-lucide-router', category: 'Settings',
    aliases: ['print host', 'connect printer', 'octoprint', 'moonraker', 'klipper', 'prusalink', 'duet', 'repetier', 'network printer', 'device'],
    run: () => openPhysicalPrinterDialog(),
  },
  {
    id: 'printer.webui', title: 'Open printer web UI', icon: 'i-lucide-external-link', category: 'Settings',
    aliases: ['device', 'mainsail', 'fluidd', 'octoprint', 'dashboard'],
    when: () => !!physicalPrinter.value, run: () => openWebUi(),
  },
];

let dispose: (() => void) | null = null;
/** Register with the app registry (idempotent). */
export function registerPrinthostActions(): () => void {
  if (!dispose) dispose = registerActions(printhostActions);
  return () => { dispose?.(); dispose = null; };
}
