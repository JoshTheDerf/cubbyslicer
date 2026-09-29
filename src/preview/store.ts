/**
 * Preview view state, module-level so the action registry (src/preview/
 * actions.ts) can drive the preview without reaching into the component.
 * PreviewView owns parsing/rendering and syncs the renderer from these refs.
 */
import { ref, shallowRef } from 'vue';
import type { ParsedGcode } from './parser/types';
import type { ColorScheme } from './render/colors';
import type { ViewPreset } from './render/PreviewRenderer';
import { DEFAULT_LEGEND_OPTIONS } from './summary';
import type { LegendOptions } from './summary';
import { FEATURE_COUNT } from './parser/features';

/** Parsed G-code currently shown (null while parsing / no slice). */
export const previewData = shallowRef<ParsedGcode | null>(null);
/** Bottom / top visible layer (0-based, inclusive). */
export const layerLo = ref(0);
export const layerHi = ref(0);
/** Move index within the top layer (0 … moves-1). */
export const moveIndex = ref(0);
export const colorScheme = ref<ColorScheme>('feature');
export const previewOptions = ref<LegendOptions>({ ...DEFAULT_LEGEND_OPTIONS });
/** Orca's one-layer mode: only the top layer is shown (lo follows hi). */
export const singleLayer = ref(false);
export const featureVisible = ref<boolean[]>(Array.from({ length: FEATURE_COUNT }, () => true));
export const showGcodeViewer = ref(false);
// Phones start with the legend collapsed (expanded it covers the whole view).
export const legendCollapsed = ref(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 640px)').matches);

export type CameraCommand = { kind: 'view'; preset: ViewPreset } | { kind: 'fit' };
const cameraListeners = new Set<(c: CameraCommand) => void>();
export function onCameraCommand(fn: (c: CameraCommand) => void): () => void {
  cameraListeners.add(fn);
  return () => cameraListeners.delete(fn);
}
export function cameraCommand(c: CameraCommand): void {
  cameraListeners.forEach((fn) => fn(c));
}

export function layerCount(): number { return previewData.value?.layerCount ?? 0; }

export function layerMoveCount(layer = layerHi.value): number {
  const p = previewData.value;
  if (!p || layer < 0 || layer >= p.layerCount) return 0;
  return p.layerStart[layer + 1] - p.layerStart[layer];
}

/** Set the top layer (clamped to [lo, last]); the move resets to the layer end. */
export function setTopLayer(h: number): void {
  const n = layerCount();
  if (!n) return;
  const lo = singleLayer.value ? 0 : layerLo.value;
  layerHi.value = Math.max(lo, Math.min(n - 1, Math.round(h)));
  if (singleLayer.value) layerLo.value = layerHi.value;
  moveIndex.value = Math.max(0, layerMoveCount() - 1);
}

export function stepLayer(delta: number): void { setTopLayer(layerHi.value + delta); }

export function stepMove(delta: number): void {
  const n = layerMoveCount();
  if (!n) return;
  moveIndex.value = Math.max(0, Math.min(n - 1, moveIndex.value + delta));
}

export function toggleOption(k: keyof LegendOptions): void {
  previewOptions.value = { ...previewOptions.value, [k]: !previewOptions.value[k] };
}

/** Toggle one-layer mode (Orca: show only the current layer). */
export function setSingleLayer(on: boolean): void {
  singleLayer.value = on;
  if (on) layerLo.value = layerHi.value;
  else layerLo.value = 0;
}
