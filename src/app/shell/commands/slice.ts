/** Slicing commands: slice / cancel / export G-code through the bound slice controller (src/app/slice.ts). */
import { toast } from '../../../ui';
import { folderAccessSupported } from '../../../localfs/store';
import type { SliceControllerLike } from '../external';

let slicer: SliceControllerLike | null = null;
export function bindSliceController(c: SliceControllerLike | null): void { slicer = c; }

export async function exportGcode(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try {
    const ok = await slicer.exportGcode();
    if (ok === false) toast.info('Slice the plate before exporting G-code.');
  } catch (e) { toast.error("Couldn't export G-code.", { detail: (e as Error)?.message }); }
}

export async function sliceNow(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try { await slicer.slice(); } catch (e) { toast.error('Slicing failed.', { detail: (e as Error)?.message }); }
}

export async function sliceAllNow(): Promise<void> {
  if (!slicer) { toast.info('Slicing is not available yet.'); return; }
  try { await slicer.sliceAll(); } catch (e) { toast.error('Slicing failed.', { detail: (e as Error)?.message }); }
}

export function exportAllGcode(): void {
  if (!slicer) return;
  const n = slicer.exportAllGcode();
  if (!n) toast.info('Slice the plates before exporting G-code.');
  // With folder access the folder dialog reports the result itself.
  else if (!(folderAccessSupported && n > 1)) toast.success(`Exported G-code for ${n} plate${n === 1 ? '' : 's'}.`, { timeout: 2200 });
}

/** Orca "Export plate sliced file" (`all` false) / "Export all sliced file": the .gcode.3mf. */
export function exportSlicedFile(all: boolean): void {
  if (!slicer) return;
  if (!slicer.exportSlicedFile(all)) toast.info(all ? 'Slice the plates before exporting the sliced file.' : 'Slice the plate before exporting the sliced file.');
}

export function cancelSlice(): void { slicer?.cancel(); }
