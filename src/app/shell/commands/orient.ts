/** Auto Orient (OrcaSlicer AutoOrienter in the engine worker). */
import { toast, dismissToast } from '../../../ui';
import { activePlate, getMesh, objectIssues, objects, objectsOnPlate, plates, selectedIds, setTransforms } from '../../../project/store';
import { orientObjects } from '../../../project/orient';
import { autoOrient as engineAutoOrient } from '../../../engine/client';
import { ui } from '../uiState';
import { runArrange } from '../arrange';

let orientAbort: AbortController | null = null;

/**
 * Orca's "Orient" button / Q: orient the selection, or every object when
 * nothing is selected ('all' = Shift+Q). One undo step; objects are dropped to
 * the bed afterwards and placement problems are reported.
 */
export async function autoOrientObjects(scope: 'auto' | 'all'): Promise<void> {
  if (ui.orienting) return;
  // Orca: Q orients the selection (or the plate when nothing is selected), Shift+Q the active plate; locked plates are skipped.
  const plateIds = () => (plates.value[activePlate.value]?.locked ? [] : objectsOnPlate(activePlate.value).map((o) => o.id));
  const ids = scope === 'all' || !selectedIds.value.length ? plateIds() : selectedIds.value.slice();
  const targets = objects.value.filter((o) => ids.includes(o.id) && o.visible);
  if (!targets.length) { toast.info('Nothing to orient.'); return; }
  ui.orienting = true;
  orientAbort = new AbortController();
  const progressId = 'auto-orient';
  const many = targets.length > 1;
  if (!many) ui.busy = `Orienting ${targets[0].name}…`;
  try {
    const res = await orientObjects(targets, getMesh, engineAutoOrient, {
      signal: orientAbort.signal,
      onProgress: (p) => {
        if (!many || p.done >= p.total) return;
        toast.info(`Auto orienting ${p.done + 1} of ${p.total}…`, {
          id: progressId, timeout: 0, detail: p.name,
          action: { label: 'Stop', run: () => orientAbort?.abort() },
        });
      },
    });
    if (many) dismissToast(progressId);
    if (res.rotations.length) {
      setTransforms(res.rotations.map((r) => ({ id: r.id, rotation: r.rotation })), res.rotations.length === 1 ? 'Auto orient' : `Auto orient ${res.rotations.length} objects`, { drop: true });
    }
    const unsupported = res.failed.length > 0 && res.failed.every((f) => /not support|unsupported|unknown (message|request)|cs_orient/i.test(f.error));
    if (unsupported) {
      toast.error('Auto orient isn’t available.', { detail: 'This build of the Orca engine doesn’t include the orienter. Update the engine files and reload.' });
      return;
    }
    if (res.failed.length) {
      toast.error(`Couldn’t orient ${res.failed.length === 1 ? res.failed[0].name : `${res.failed.length} objects`}.`, {
        detail: res.failed.slice(0, 6).map((f) => `${f.name}: ${f.error}`).join('\n'),
      });
    }
    const outside = res.rotations.filter((r) => objectIssues.value.get(r.id)?.some((i) => i !== 'overlap')).length;
    if (outside) {
      toast.warn(`${outside === 1 ? '1 object no longer fits' : `${outside} objects no longer fit`} on the plate after orienting.`, {
        detail: 'Arrange the plate (A) or scale the object down.',
        action: { label: 'Arrange', run: () => { void runArrange('all'); } },
      });
    } else if (res.cancelled) {
      toast.info(`Stopped. Oriented ${res.rotations.length} of ${targets.length} objects.`);
    } else if (!res.failed.length) {
      const n = res.rotations.length;
      toast.success(n ? `Oriented ${n === 1 ? targets.find((t) => t.id === res.rotations[0].id)?.name ?? 'object' : `${n} objects`}.`
        : `${targets.length === 1 ? 'Already' : 'All objects are already'} in the best orientation.`, { timeout: 2200 });
    }
  } finally {
    ui.orienting = false;
    ui.busy = null;
    orientAbort = null;
  }
}
