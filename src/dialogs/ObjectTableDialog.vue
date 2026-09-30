<script setup lang="ts">
import { filamentColourOf, mixedEnabled, mixedFilaments } from '../mixed/store';
/**
 * Orca ObjectTableDialog (GUI_ObjectTable.cpp): every object × the common
 * per-object settings (plate, name, printable, filament, layer height, walls,
 * infill density, support, brim type, outer wall speed). Cells show the
 * effective value; per-object overrides are highlighted and revertible.
 * Editing a cell of a ticked row applies the value to every ticked row.
 * Writes go through the settings project adapter (undoable).
 */
import { computed, ref, watch } from 'vue';
import type { ConfigOptionDef, ConfigValue } from '../engine/types';
import { mobileDialog } from '../ui/mobileDialog';
import { currentPresets } from '../presets/store';
import { asArray, normalizeValue, valuesEqual } from '../presets/values';
import { objects, plateOf, renameObject, select, setPrintable } from '../project/store';
import { getObjectOverrides, setObjectOverride } from '../settings/projectAdapter';
import ScalarControl from '../settings/controls/ScalarControl.vue';
import { dialogs } from './state';

const p = computed(() => currentPresets.value);
const schema = computed(() => p.value.schema.value);

/** Orca's columns (col_layer_height … col_speed_perimeter), with preFlight's equivalents. */
const COLUMN_KEYS: string[][] = [
  ['layer_height'], ['wall_loops', 'perimeters'], ['top_shell_layers', 'top_solid_layers'], ['bottom_shell_layers', 'bottom_solid_layers'],
  ['sparse_infill_density', 'fill_density'], ['enable_support', 'support_material'], ['brim_type'], ['outer_wall_speed', 'external_perimeter_speed'],
];
const columns = computed(() => {
  const s = schema.value;
  if (!s) return [] as Array<{ key: string; def: ConfigOptionDef; label: string }>;
  return COLUMN_KEYS.map((alts) => alts.find((k) => s.options[k])).filter((k): k is string => !!k)
    .map((key) => ({ key, def: s.options[key], label: shortLabel(key, s.options[key]) }));
});
function shortLabel(key: string, d: ConfigOptionDef): string {
  const map: Record<string, string> = {
    outer_wall_speed: 'Outer wall speed', external_perimeter_speed: 'Outer wall speed', top_shell_layers: 'Top layers', top_solid_layers: 'Top layers',
    bottom_shell_layers: 'Bottom layers', bottom_solid_layers: 'Bottom layers', sparse_infill_density: 'Infill density', fill_density: 'Infill density',
    enable_support: 'Support', support_material: 'Support',
  };
  return map[key] ?? d.label ?? key;
}
const filamentCol = computed(() => !!schema.value?.options.extruder && p.value.selection.filaments.length > 1);
const filamentItems = computed(() => [
  ...p.value.selection.filaments.map((_, i) => ({ value: String(i + 1), label: `${i + 1}`, chip: { color: 'neutral' as const }, colour: p.value.filamentColour(i) })),
  ...(mixedEnabled.value ? mixedFilaments.value.map((m) => ({ value: String(m.id), label: `${m.id} (mix)`, chip: { color: 'neutral' as const }, colour: m.color })) : []),
]);

const ticked = ref<Set<string>>(new Set());
const filter = ref('');
watch(() => dialogs.objectTable, (o) => { if (o) { ticked.value = new Set(); filter.value = ''; } });

const rows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return objects.value.filter((o) => !q || o.name.toLowerCase().includes(q))
    .map((o) => ({ o, plate: plateOf(o.id) + 1, ov: getObjectOverrides(o.id) }))
    .sort((a, b) => a.plate - b.plate);
});
const allTicked = computed(() => rows.value.length > 0 && rows.value.every((r) => ticked.value.has(r.o.id)));
function tickAll(v: boolean): void { ticked.value = v ? new Set(rows.value.map((r) => r.o.id)) : new Set(); }
function tick(id: string, v: boolean): void { const s = new Set(ticked.value); if (v) s.add(id); else s.delete(id); ticked.value = s; }
/** The rows an edit applies to: all ticked rows when the edited row is ticked. */
const targets = (id: string) => (ticked.value.has(id) ? [...ticked.value] : [id]);

const globalValue = (key: string): string => {
  const v = p.value.value('process', key);
  return (Array.isArray(v) ? v[0] : v) ?? schema.value?.options[key]?.default ?? '';
};
const cellValue = (ov: Readonly<Record<string, ConfigValue>>, key: string): string => {
  const v = ov[key];
  return v === undefined ? globalValue(key) : Array.isArray(v) ? v[0] ?? '' : v;
};

function setCell(id: string, key: string, raw: string): void {
  const def = schema.value?.options[key];
  const value = normalizeValue(def, raw);
  const global = key === 'extruder' ? '1' : globalValue(key);
  for (const t of targets(id)) {
    const same = valuesEqual(value, normalizeValue(def, global));
    setObjectOverride(t, key, same ? undefined : value);
  }
}
function revert(id: string, key: string): void { for (const t of targets(id)) setObjectOverride(t, key, undefined); }
function setFilament(id: string, v: string): void { for (const t of targets(id)) setObjectOverride(t, 'extruder', v === '1' ? undefined : v); }
function setRowPrintable(id: string, v: boolean): void { setPrintable(targets(id), v); }
const filamentOf = (ov: Readonly<Record<string, ConfigValue>>) => asArray(ov.extruder)[0] || '1';
function locate(id: string): void { select([id]); }
</script>

<template>
  <UModal v-model:open="dialogs.objectTable" title="Object table" :description="mobileDialog ? undefined : 'Per-object settings of every object. Tick rows to edit them together.'"
          :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-[min(1200px,96vw)]', body: 'flex flex-col gap-2 phone:overflow-hidden' }">
    <template #body>
      <div class="flex items-center gap-2">
        <UCheckbox v-if="mobileDialog" :model-value="allTicked" aria-label="Tick all" @update:model-value="(v: boolean | 'indeterminate') => tickAll(v === true)" />
        <UInput v-model="filter" icon="i-lucide-search" placeholder="Filter objects" size="sm" class="w-60 phone:w-auto phone:min-w-0 phone:flex-1" />
        <span class="flex-1 phone:hidden" />
        <span class="text-xs text-dimmed phone:max-w-[40%] phone:text-right">{{ ticked.size ? `${ticked.size} ticked · edits apply to all ticked rows` : mobileDialog ? `${rows.length} object${rows.length === 1 ? '' : 's'} · tick to edit together` : `${rows.length} object${rows.length === 1 ? '' : 's'}` }}</span>
      </div>
      <!-- Phones: one card per object (fields stacked), in the dialog's one scroll region. -->
      <div v-if="mobileDialog" class="otc">
        <div v-for="r in rows" :key="r.o.id" class="otc__card" :class="{ on: ticked.has(r.o.id) }">
          <div class="otc__head">
            <UCheckbox :model-value="ticked.has(r.o.id)" :aria-label="`Tick ${r.o.name}`" @update:model-value="(v: boolean | 'indeterminate') => tick(r.o.id, v === true)" />
            <UInput :model-value="r.o.name" size="sm" class="min-w-0 flex-1" :aria-label="`Name of ${r.o.name}`"
                    @change="(e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== r.o.name) renameObject(r.o.id, v); }" />
            <UButton size="sm" variant="ghost" icon="i-lucide-crosshair" square :aria-label="`Select ${r.o.name}`" @click="locate(r.o.id)" />
          </div>
          <div class="otc__fields">
            <span class="otc__lbl">Plate</span><span class="text-sm text-muted">{{ r.plate > 0 ? r.plate : '—' }}</span>
            <span class="otc__lbl">Printable</span>
            <UCheckbox :model-value="r.o.printable" :aria-label="`${r.o.name} printable`" @update:model-value="(v: boolean | 'indeterminate') => setRowPrintable(r.o.id, v === true)" />
            <template v-if="filamentCol">
              <span class="otc__lbl">Filament</span>
              <USelect :model-value="filamentOf(r.ov)" :items="filamentItems" value-key="value" size="sm" class="w-24" :aria-label="`${r.o.name} filament`"
                       @update:model-value="(v: unknown) => setFilament(r.o.id, String(v))">
                <template #leading><span class="ot__swatch" :style="{ background: filamentColourOf(Number(filamentOf(r.ov))) }" /></template>
              </USelect>
            </template>
            <template v-for="c in columns" :key="c.key">
              <span class="otc__lbl" :title="c.def.tooltip">{{ c.label }}<small v-if="c.def.sidetext"> ({{ c.def.sidetext }})</small></span>
              <div class="ot__cell" :class="{ 'ot__cell--mod': c.key in r.ov }">
                <ScalarControl :def="c.def" :opt-key="`otc-${r.o.id}-${c.key}`" :model-value="cellValue(r.ov, c.key)" compact :aria-label="`${r.o.name} ${c.label}`"
                               @update:model-value="(v: string) => setCell(r.o.id, c.key, v)" />
                <UButton v-if="c.key in r.ov" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square :aria-label="`Revert ${c.label}`"
                         @click="revert(r.o.id, c.key)" />
                <span v-else class="otc__global" :title="`Global: ${globalValue(c.key)}`">{{ globalValue(c.key) }}</span>
              </div>
            </template>
          </div>
        </div>
        <p v-if="!rows.length" class="ot__empty">No objects.</p>
      </div>
      <div v-else class="ot__scroll">
        <table class="ot">
          <thead>
            <tr>
              <th class="ot__tick"><UCheckbox :model-value="allTicked" aria-label="Tick all" @update:model-value="(v: boolean | 'indeterminate') => tickAll(v === true)" /></th>
              <th>Plate</th>
              <th class="ot__name">Name</th>
              <th>Printable</th>
              <th v-if="filamentCol">Filament</th>
              <th v-for="c in columns" :key="c.key" :title="c.def.tooltip">{{ c.label }}<small v-if="c.def.sidetext"> ({{ c.def.sidetext }})</small></th>
            </tr>
            <tr class="ot__global">
              <td /><td /><td class="ot__name">Global (process)</td><td /><td v-if="filamentCol" />
              <td v-for="c in columns" :key="c.key">{{ globalValue(c.key) }}</td>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.o.id" :class="{ on: ticked.has(r.o.id) }">
              <td class="ot__tick"><UCheckbox :model-value="ticked.has(r.o.id)" :aria-label="`Tick ${r.o.name}`" @update:model-value="(v: boolean | 'indeterminate') => tick(r.o.id, v === true)" /></td>
              <td class="ot__num">{{ r.plate > 0 ? r.plate : '—' }}</td>
              <td class="ot__name">
                <div class="flex items-center gap-1">
                  <UInput :model-value="r.o.name" size="xs" class="min-w-0 flex-1" :aria-label="`Name of ${r.o.name}`"
                          @change="(e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== r.o.name) renameObject(r.o.id, v); }" />
                  <UButton size="xs" variant="ghost" icon="i-lucide-crosshair" square :aria-label="`Select ${r.o.name}`" title="Select in the plater" @click="locate(r.o.id)" />
                </div>
              </td>
              <td class="text-center"><UCheckbox :model-value="r.o.printable" :aria-label="`${r.o.name} printable`" @update:model-value="(v: boolean | 'indeterminate') => setRowPrintable(r.o.id, v === true)" /></td>
              <td v-if="filamentCol">
                <USelect :model-value="filamentOf(r.ov)" :items="filamentItems" value-key="value" size="xs" class="w-20" :aria-label="`${r.o.name} filament`"
                         @update:model-value="(v: unknown) => setFilament(r.o.id, String(v))">
                  <template #leading><span class="ot__swatch" :style="{ background: filamentColourOf(Number(filamentOf(r.ov))) }" /></template>
                </USelect>
              </td>
              <td v-for="c in columns" :key="c.key" :class="{ 'ot__cell--mod': c.key in r.ov }">
                <div class="ot__cell">
                  <ScalarControl :def="c.def" :opt-key="`ot-${r.o.id}-${c.key}`" :model-value="cellValue(r.ov, c.key)" compact :aria-label="`${r.o.name} ${c.label}`"
                                 @update:model-value="(v: string) => setCell(r.o.id, c.key, v)" />
                  <UButton v-if="c.key in r.ov" size="xs" variant="ghost" color="warning" icon="i-lucide-undo-2" square :aria-label="`Revert ${c.label}`"
                           title="Use the global value" @click="revert(r.o.id, c.key)" />
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length"><td :colspan="5 + columns.length" class="ot__empty">No objects.</td></tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end"><UButton color="primary" label="Close" @click="dialogs.objectTable = false" /></div>
    </template>
  </UModal>
</template>

<style scoped>
.ot__scroll { overflow: auto; max-height: min(66vh, 700px); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.ot { border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 100%; }
.ot th, .ot td { padding: 3px 6px; border-bottom: 1px solid var(--ui-border); white-space: nowrap; vertical-align: middle; }
.ot thead th { position: sticky; top: 0; z-index: 2; background: var(--ui-bg-elevated); text-align: left; font-weight: 600; color: var(--ui-text-highlighted); }
.ot thead th small { font-weight: 400; color: var(--ui-text-dimmed); }
.ot__global td { position: sticky; top: 27px; z-index: 2; background: var(--ui-bg-muted); color: var(--ui-text-dimmed); font-style: italic; }
.ot__tick { width: 30px; position: sticky; left: 0; background: var(--ui-bg); z-index: 1; }
.ot thead .ot__tick { z-index: 3; background: var(--ui-bg-elevated); }
.ot__name { min-width: 180px; }
.ot__num { text-align: center; color: var(--ui-text-muted); }
.ot tbody tr.on td { background: color-mix(in srgb, var(--ui-primary) 8%, transparent); }
.ot__cell { display: flex; align-items: center; gap: 2px; min-width: 110px; }
.ot__cell--mod :deep(input), .ot__cell--mod :deep(button[role='combobox']) { color: var(--modified); }
.ot__swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.3); display: inline-block; }
.otc { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; }
.otc__card { border: 1px solid var(--ui-border); border-radius: var(--ui-radius); padding: 4px 10px 8px; }
.otc__card.on { background: color-mix(in srgb, var(--ui-primary) 8%, transparent); }
.otc__head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.otc__fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: center; gap: 2px 10px; font-size: 13px; }
.otc__lbl { color: var(--ui-text-muted); min-width: 0; overflow-wrap: anywhere; }
.otc__lbl small { color: var(--ui-text-dimmed); }
.otc .ot__cell { min-width: 0; }
.otc .ot__cell > :first-child { min-width: 0; flex: 1; }
.otc__global { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ui-text-dimmed); font-style: italic; }
@media (min-width: 700px) {
  .otc__fields { grid-template-columns: repeat(2, minmax(0, 0.8fr) minmax(0, 1.2fr)); }
}
.ot__empty { text-align: center; color: var(--ui-text-dimmed); padding: 16px; }
</style>
