/**
 * Object list integration for height range modifiers + variable layer height
 * (Orca GUI_ObjectList: the "Layers" item with its height ranges under an
 * object, and the "Variable layer height" info item). ObjectList renders the
 * rows; this module owns their icons, labels, click and context menus.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import { select, selectedPart } from '../project/store';
import type { LayerRange, ProjectObject } from '../project/types';
import {
  addLayerRange, hasCustomProfile, layersUi, removeAllLayerRanges, removeLayerRange, resetLayerProfile, selectedRange,
} from './store';

export type LayerRowKind = 'layers' | 'range' | 'vlh';

export interface LayerRow { kind: LayerRowKind; key: string; obj: ProjectObject; depth: number; range?: LayerRange; count?: number }

export const LAYER_ROW_ICONS: Record<LayerRowKind, string> = {
  layers: 'i-lucide-layers', range: 'i-lucide-between-horizontal-start', vlh: 'i-lucide-layers-3',
};

/** Rows under object `o` at depth `d` (`collapsed` = folded "Layers" keys). */
export function layerRowsOf(o: ProjectObject, d: number, collapsed: Set<string>): LayerRow[] {
  const out: LayerRow[] = [];
  if (o.layerRanges?.length) {
    const key = `L:${o.id}`;
    out.push({ kind: 'layers', key, obj: o, depth: d, count: o.layerRanges.length });
    if (!collapsed.has(key)) {
      for (const r of o.layerRanges.slice().sort((a, b) => a.min - b.min)) out.push({ kind: 'range', key: `${o.id}/r/${r.id}`, obj: o, range: r, depth: d + 1 });
    }
  }
  if (hasCustomProfile(o)) out.push({ kind: 'vlh', key: `${o.id}/vlh`, obj: o, depth: d });
  return out;
}

export function layerRowLabel(r: LayerRow): string {
  if (r.kind === 'layers') return 'Layers';
  if (r.kind === 'vlh') return 'Variable layer height';
  return `${fmt(r.range!.min)} – ${fmt(r.range!.max)} mm`;
}
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function pickRange(objectId: string, rangeId: string): void {
  select([objectId]);
  selectedPart.value = null;
  selectedRange.value = { objectId, rangeId };
}

/** Click on a layer row. Returns true when handled. */
export function clickLayerRow(r: LayerRow): void {
  if (r.kind === 'range') { pickRange(r.obj.id, r.range!.id); return; }
  selectedRange.value = null;
  select([r.obj.id]);
  if (r.kind === 'vlh') layersUi.editing = true;
}

export function isLayerRowSelected(r: LayerRow): boolean {
  return r.kind === 'range' && selectedRange.value?.rangeId === r.range!.id;
}

/** Right-click menus (Orca: layer root → add range / delete all; range → add after / delete; info item → edit / reset). */
export function layerRowMenu(r: LayerRow, reveal: () => void): DropdownMenuItem[][] {
  const id = r.obj.id;
  const add = () => { const rid = addLayerRange(id); if (rid) { pickRange(id, rid); reveal(); } };
  if (r.kind === 'vlh') {
    return [[
      { label: 'Edit variable layer height', icon: 'i-lucide-layers-3', onSelect: () => { select([id]); layersUi.editing = true; } },
      { label: 'Reset variable layer height', icon: 'i-lucide-rotate-ccw', color: 'error', onSelect: () => resetLayerProfile(id) },
    ]];
  }
  if (r.kind === 'layers') {
    return [
      [{ label: 'Add height range', icon: 'i-lucide-plus', onSelect: add }],
      [{ label: 'Delete all height ranges', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeAllLayerRanges(id) }],
    ];
  }
  return [
    [{ label: 'Range settings', icon: 'i-lucide-sliders-horizontal', onSelect: () => { pickRange(id, r.range!.id); reveal(); } },
      { label: 'Add range after', icon: 'i-lucide-plus', onSelect: add }],
    [{ label: 'Delete height range', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removeLayerRange(id, r.range!.id) }],
  ];
}
