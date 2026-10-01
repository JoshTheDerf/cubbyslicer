/**
 * Open/closed state of the Orca tool dialogs mounted by DialogsHost.vue
 * (flushing volumes, filament grouping, object table, create printer /
 * filament, export preset bundle, bed shape, preferences, arrange options). Plain reactive
 * state so action families can open them without importing components.
 */
import { reactive } from 'vue';

export type DialogId = 'flushing' | 'filamentMap' | 'objectTable' | 'createPrinter' | 'createFilament' | 'exportBundle' | 'bedShape' | 'preferences' | 'arrange';

export const dialogs = reactive<Record<DialogId, boolean>>({
  flushing: false,
  filamentMap: false,
  objectTable: false,
  createPrinter: false,
  createFilament: false,
  exportBundle: false,
  bedShape: false,
  preferences: false,
  arrange: false,
});

export function openDialog(id: DialogId): void { dialogs[id] = true; }
export function closeDialog(id: DialogId): void { dialogs[id] = false; }
export function anyDialogOpen(): boolean { return Object.values(dialogs).some(Boolean); }
