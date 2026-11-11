/**
 * The prime tower in Prepare (desktop GLCanvas3D::reload_scene →
 * GLVolumeCollection::load_wipe_tower_preview): for every plate that prints a
 * tower, its estimated footprint (engine `wipe_tower_footprint`, the numbers
 * the slice validates against) at the plate's anchor, re-placed the way
 * desktop does on every reload (slice.ts `placePlateTower`). The viewport draws
 * `towerViews` and lets the tower be dragged (`moveTower`, one undo step).
 *
 * Not drawn, as on desktop: belt printers (their purge prism is a real object),
 * a by-object plate with more than one object, a plate without objects.
 */
import { shallowRef, watch } from 'vue';
import { activeEngine, resolvedConfig } from './state';
import { engineCaps } from '../engine/types';
import { mutate, plates, plateSliceSignature, registerSnapshotSlot } from '../project/store';
import { currentPresets } from '../presets/store';
import { asList } from '../lib/configValue';
import { filamentColourOf } from '../mixed/store';
import { isBeltPrinter } from '../viewport/belt';
import { plateFilaments, setAnchor } from './wipeTower';
import { placePlateTower } from './slice';
import type { P2 } from './wipeTowerPlace';

export interface TowerView {
  plate: number;
  /** Anchor (body min corner before rotation), plate-local mm. */
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  brim: number;
  /** wipe_tower_rotation_angle, degrees about the anchor. */
  rotation: number;
  /** Tower-local first-layer outline, brim excluded, unrotated. */
  outline: P2[];
  /** Tower-local, rotated, brim included (what the drag keeps on the bed). */
  footprint: P2[];
  /** The printable area the tower must stay in (plate-local). */
  printableArea: P2[][];
  /** The plate's filament colours (one body slab each, desktop's order). */
  colours: string[];
}

export const towerViews = shallowRef<TowerView[]>([]);

let seq = 0;
/** Refresh passes started / finished (e2e diagnostics). */
export const towerDebug = { runs: 0, done: 0, last: '' };
let timer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  const run = ++seq;
  towerDebug.runs++;
  const cfg = resolvedConfig.value;
  if (!engineCaps(activeEngine.value).orcaConfig || isBeltPrinter(cfg)) { towerViews.value = []; return; }
  const out: TowerView[] = [];
  for (let i = 0; i < plates.value.length; i++) {
    const placed = await placePlateTower(i);
    towerDebug.last = placed ? 'placed' : 'none';
    if (run !== seq) return;
    if (!placed) continue;
    const r = placed.result;
    out.push({
      plate: i, x: r.placement.x, y: r.placement.y, width: r.width, depth: r.depth, height: r.height || 0.1, brim: r.brim,
      rotation: r.rotation, outline: r.outline, footprint: r.footprint, printableArea: r.printableArea,
      colours: plateFilaments(placed.job).map((f) => filamentColourOf(f)),
    });
  }
  if (run === seq) { towerViews.value = out; towerDebug.done++; }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void refresh(); }, 250);
}

let started = false;
/** Start following the project (once, from the Prepare viewport). */
export function startTowerPreview(): void {
  if (started) return;
  started = true;
  watch([resolvedConfig, activeEngine, () => plates.value.map((_, i) => plateSliceSignature(i)).join('\n'),
    () => currentPresets.value.filamentColours().join()], schedule, { immediate: true });
}

/** Drop the tower of `plate` at a new anchor (one undo step, like desktop's move). */
export function moveTower(plate: number, x: number, y: number): void {
  const p = currentPresets.value;
  mutate('Move prime tower', () => {
    p.project.wipe_tower_x = setAnchor(asList(resolvedConfig.value.wipe_tower_x), plate, x);
    p.project.wipe_tower_y = setAnchor(asList(resolvedConfig.value.wipe_tower_y), plate, y);
  });
  // Show the drop at once; the next refresh confirms (or re-places) it.
  towerViews.value = towerViews.value.map((t) => (t.plate === plate ? { ...t, x, y } : t));
}

// Undo / redo put the tower back with the rest of the project.
const anchors = () => {
  const p = currentPresets.value.project;
  return `${asList(p.wipe_tower_x).join(',')}|${asList(p.wipe_tower_y).join(',')}`;
};
registerSnapshotSlot<string>('primeTower', {
  capture: anchors,
  restore: (v) => {
    if (anchors() === v) return;
    const [xs, ys] = v.split('|').map((s) => (s ? s.split(',') : []));
    const p = currentPresets.value.project;
    if (xs.length) p.wipe_tower_x = xs; else delete p.wipe_tower_x;
    if (ys.length) p.wipe_tower_y = ys; else delete p.wipe_tower_y;
  },
});
