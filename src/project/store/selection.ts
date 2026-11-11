/**
 * Selection: the selected objects, the picked part, and the rules that keep
 * them consistent with the project (UI state, not undoable).
 */
import { computed, watch } from 'vue';
import { objectPlate } from './derived';
import { activePlate, getObject, objects, selectedIds, selectedPart, targets } from './state';

export function select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
  if (mode === 'replace') { selectedIds.value = [...new Set(ids)]; return; }
  const cur = new Set(selectedIds.value);
  for (const id of ids) {
    if (mode === 'toggle' && cur.has(id)) cur.delete(id); else cur.add(id);
  }
  selectedIds.value = [...cur];
}
export function selectAll(): void { selectedIds.value = objects.value.map((o) => o.id); }
export function clearSelection(): void { if (selectedIds.value.length) selectedIds.value = []; }

export const selectedObjects = computed(() => targets());
export const primarySelection = computed(() => {
  const id = selectedIds.value.at(-1);
  return id ? getObject(id) ?? null : null;
});

/** Drop selected ids whose objects are gone (after an edit, undo or redo). */
export function pruneSelection(): void {
  const ids = new Set(objects.value.map((o) => o.id));
  const next = selectedIds.value.filter((id) => ids.has(id));
  if (next.length !== selectedIds.value.length) selectedIds.value = next;
}

// A picked part only stays picked while its object is the single selection and the part exists.
watch([selectedIds, objects], () => {
  const sp = selectedPart.value;
  if (!sp) return;
  const o = selectedIds.value.length === 1 && selectedIds.value[0] === sp.objectId ? getObject(sp.objectId) : undefined;
  if (!o?.parts?.some((p) => p.id === sp.partId)) selectedPart.value = null;
}, { deep: false });

// Orca: selecting an object makes its plate the current one.
watch(() => selectedIds.value.at(-1), (id) => {
  const p = id ? objectPlate.value.get(id) : undefined;
  if (p !== undefined && p >= 0 && p !== activePlate.value) activePlate.value = p;
});
