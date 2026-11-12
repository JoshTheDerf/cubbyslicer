/**
 * Physical printer commands for the app action registry (menus, palette,
 * keyboard). Orca: Ctrl+Shift+G = "Print plate" (send to print host),
 * KBShortcutsDialog.cpp.
 */
import type { Action } from '../app/actions/types';
import type { AppContext } from '../app/actions/context';
import { describeError, openWebUi } from './send';
import { syncFilamentsFromPrinter } from './filamentSync';
import { toast } from '../ui';
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
  {
    id: 'printer.sync-filaments', title: 'Sync filaments from printer', icon: 'i-lucide-refresh-cw', category: 'Settings',
    aliases: ['ams', 'afc', 'happy hare', 'mmu', 'lanes', 'spools', 'filament slots', 'moonraker', 'cfs', 'creality'],
    description: 'Sets the filament slots from the printer’s lanes (AFC / Happy Hare / Qidi Box on Moonraker, a Creality K-series CFS on Creality Print): one slot per lane, with its colour and a matching preset.',
    when: () => physicalPrinter.value?.config.type === 'moonraker' || physicalPrinter.value?.config.type === 'crealityprint', run: syncFilaments,
  },
];

async function syncFilaments(): Promise<void> {
  try {
    const r = await syncFilamentsFromPrinter();
    toast.success(`Synced ${r.lanes.length} filament${r.lanes.length === 1 ? '' : 's'} from the printer.`, {
      detail: r.matched.map((m) => `T${m.lane}: ${m.preset ?? 'no matching preset (colour only)'}`).join('\n'),
    });
  } catch (e) {
    const d = describeError(e);
    toast.error(d.message, { detail: d.detail });
  }
}
