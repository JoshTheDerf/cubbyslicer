/**
 * The open / closed state of the app's show-and-hide dialogs, in one record:
 * the shell's (command palette, shortcuts, about, instances), the Orca tool
 * dialogs mounted by DialogsHost.vue (flushing volumes, filament grouping,
 * object table, create printer / filament, export preset bundle, bed shape,
 * preferences, arrange options), the AI agent dialog and the physical printer
 * setup / send dialogs. Plain reactive state,
 * so action families and the bridge open them without importing components,
 * and the keyboard dispatcher knows when one is open.
 *
 * Dialogs that answer a question (confirm, primitive size, STEP options) use
 * `dialogRequest` (src/ui/dialogRequest.ts) instead.
 */
import { reactive } from 'vue';

export type DialogId =
  | 'palette' | 'shortcuts' | 'about' | 'instances' | 'bridge'
  | 'flushing' | 'filamentMap' | 'objectTable' | 'createPrinter' | 'createFilament' | 'exportBundle' | 'bedShape' | 'preferences' | 'arrange'
  | 'plugins' | 'physicalPrinter' | 'printhostSend';

export const dialogs = reactive<Record<DialogId, boolean>>({
  palette: false,
  shortcuts: false,
  about: false,
  instances: false,
  bridge: false,
  flushing: false,
  filamentMap: false,
  objectTable: false,
  createPrinter: false,
  createFilament: false,
  exportBundle: false,
  bedShape: false,
  preferences: false,
  arrange: false,
  plugins: false,
  physicalPrinter: false,
  printhostSend: false,
});

export function openDialog(id: DialogId): void { dialogs[id] = true; }
export function closeDialog(id: DialogId): void { dialogs[id] = false; }
export function anyDialogOpen(): boolean { return Object.values(dialogs).some(Boolean); }
