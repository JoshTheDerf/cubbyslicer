/** "Export as .cubby": the CAD objects as a CubbyCAD scene file. */
import { toast } from '../ui';
import { objects, projectName, selectedIds } from '../project/store';
import { safeFileName, saveBytes } from '../app/shell/download';
import { cubbySceneOf } from './commands';

export const CUBBY_TYPES: FilePickerAcceptType[] = [{ description: 'CubbyCAD scene', accept: { 'application/json': ['.cubby'] } }];

export async function exportCubbyCmd(): Promise<void> {
  const sel = objects.value.filter((o) => selectedIds.value.includes(o.id) && o.cad);
  const list = sel.length ? sel : objects.value.filter((o) => o.cad);
  if (!list.length) { toast.info('Nothing to export: add a shape or import a .cubby file first.'); return; }
  const name = list.length === 1 ? list[0].name : projectName.value;
  const scene = cubbySceneOf(list, name);
  const skipped = (sel.length ? selectedIds.value.length : objects.value.length) - list.length;
  try {
    const ok = await saveBytes(new TextEncoder().encode(JSON.stringify(scene, null, 1)), `${safeFileName(name, 'model')}.cubby`, 'application/json', { types: CUBBY_TYPES, id: 'cubby-cad' });
    if (ok) toast.success(`Exported ${list.length === 1 ? name : `${list.length} objects`} for CubbyCAD.`, skipped > 0 ? { detail: `${skipped} plain mesh object${skipped === 1 ? ' was' : 's were'} left out (only CubbyCAD shapes export).` } : undefined);
  } catch (e) { toast.error("Couldn't export the .cubby file.", { detail: (e as Error)?.message }); }
}
