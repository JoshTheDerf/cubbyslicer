/**
 * Lifecycle events raised from CubbySlicer's own state (OrcaSlicer fires them
 * from Plater / PartPlate / Tab). Delivered to every loaded, enabled
 * capability's on_lifecycle_event on the runtime's loop.
 *
 * Emitted: ObjectAdded, ObjectDeleted, ObjectRenamed, PlateCreated,
 * PlateDeleted, PlateSelected, PresetSelected. Not emitted in this pass:
 * project open / save events, device / print-job events (no device manager).
 * Slice and G-code export events come from the engine's report (fireEngineEvents).
 */
import { watch } from 'vue';
import { activePlate, objects, plates } from '../../project/store';
import { currentPresets } from '../../presets/store';
import { send, runtimeState } from '../runtime/client';
import { loadedCapabilities } from '../manager/store';
import type { LifecycleCtx } from '../types';

function fire(event: string, ctx: LifecycleCtx = {}): void {
  if (runtimeState.value.phase !== 'ready' || !loadedCapabilities().length) return;
  send({ t: 'lifecycle', event, ctx });
}

/** The engine's lifecycle events of a slice (SliceStarted, …, report.events), delivered once it returns. */
export function fireEngineEvents(events: ReadonlyArray<{ event: string; ctx?: Record<string, unknown> }> | undefined): void {
  for (const e of events ?? []) fire(e.event, (e.ctx ?? {}) as LifecycleCtx);
}

let stop: (() => void) | null = null;

export function installLifecycleEvents(): void {
  if (stop) return;
  const names = new Map<string, string>();
  const stops = [
    watch(() => objects.value.map((o) => [o.id, o.name] as const), (now) => {
      const seen = new Set<string>();
      now.forEach(([id, name], index) => {
        seen.add(id);
        const prev = names.get(id);
        if (prev === undefined) fire('ObjectAdded', { name, index });
        else if (prev !== name) fire('ObjectRenamed', { name, previous_name: prev, index });
        names.set(id, name);
      });
      for (const [id, name] of [...names]) if (!seen.has(id)) { fire('ObjectDeleted', { name }); names.delete(id); }
    }, { immediate: true }),
    watch(() => plates.value.length, (n, o) => {
      if (o === undefined) return;
      if (n > o) fire('PlateCreated', { index: n - 1 });
      else if (n < o) fire('PlateDeleted', { index: n });
    }),
    watch(activePlate, (i) => fire('PlateSelected', { index: i })),
    watch(() => {
      const s = currentPresets.value;
      return [s.selectedInfo('printer').name, s.selectedInfo('process').name, ...s.infos.value.filaments.map((f) => f.name)].join('\u0000');
    }, (now, prev) => {
      if (prev === undefined) return;
      const [a, b] = [now.split('\u0000'), prev.split('\u0000')];
      a.forEach((name, i) => { if (name !== b[i]) fire('PresetSelected', { name, previous_name: b[i] ?? '', index: i < 2 ? -1 : i - 2, source: i === 0 ? 'printer' : i === 1 ? 'process' : 'filament' }); });
    }),
  ];
  stop = () => stops.forEach((s) => s());
}
