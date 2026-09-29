<script setup lang="ts">
/**
 * Orca WipingDialog: flushing volume (mm³) for every filament pair (row =
 * from, column = to), the multiplier, Re-calculate from the filament colours,
 * one matrix per extruder on multi-nozzle printers.
 */
import { computed, ref, watch } from 'vue';
import { phone } from '../../app/shell/uiState';
import { preferences } from '../../app/preferences';
import { MAX_FLUSH_VOLUME } from './flushCalc';
import { autoMatrixFor, readFlush, writeFlush, type FlushState } from './flushStore';
import { dialogs } from '../state';

const state = ref<FlushState | null>(null);
const tab = ref('0');
watch(() => dialogs.flushing, (o) => { if (o) { state.value = readFlush(); tab.value = '0'; } });

const nozzle = computed(() => Number(tab.value));
const tabs = computed(() => (state.value && state.value.nozzles > 1
  ? Array.from({ length: state.value.nozzles }, (_, i) => ({ value: String(i), label: state.value!.nozzles === 2 ? (i === 0 ? 'Left extruder' : 'Right extruder') : `Extruder ${i + 1}` }))
  : []));
const matrix = computed(() => state.value?.matrices[nozzle.value] ?? []);
const multiplier = computed({
  get: () => state.value?.multipliers[nozzle.value] ?? 1,
  set: (v: number) => { if (state.value) state.value.multipliers[nozzle.value] = v; },
});
const outOfRange = computed(() => matrix.value.some((r, i) => r.some((v, j) => i !== j && (v < 0 || v > 700))));
const badMult = computed(() => multiplier.value < 0 || multiplier.value > 3);

function setCell(i: number, j: number, v: number | null): void {
  if (!state.value || v === null || !Number.isFinite(v)) return;
  state.value.matrices[nozzle.value][i][j] = Math.max(0, Math.min(MAX_FLUSH_VOLUME, Math.round(v)));
}
function recalc(): void {
  if (!state.value) return;
  state.value.matrices[nozzle.value] = autoMatrixFor(nozzle.value, state.value.colours);
}
function apply(): void {
  if (!state.value) return;
  const s = state.value;
  // Orca clamps each entry to max_flush_volume / multiplier.
  const m = s.matrices.map((mx, z) => mx.map((r) => r.map((v) => Math.max(0, Math.min(v, MAX_FLUSH_VOLUME / Math.max(0.01, s.multipliers[z] || 1))))));
  writeFlush({ matrices: m, multipliers: s.multipliers });
  dialogs.flushing = false;
}
const textOn = (hex: string) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#111' : '#fff';
};
</script>

<template>
  <UModal v-model:open="dialogs.flushing" title="Flushing volumes for filament change" :fullscreen="phone"
          :ui="{ content: 'sm:max-w-3xl', body: 'flex flex-col gap-3' }">
    <template #body>
      <template v-if="state">
        <UTabs v-if="tabs.length" v-model="tab" :items="tabs" :content="false" size="xs" />
        <p class="text-sm text-muted">Flushing volume (mm³) for each filament pair. Suggestion: flushing volume in range [0, 700].</p>
        <div class="fv__scroll">
          <table class="fv">
            <thead>
              <tr>
                <th class="fv__corner"><span>From ↓ &nbsp; To →</span></th>
                <th v-for="(c, j) in state.colours" :key="j">
                  <span class="fv__chip" :style="{ background: c, color: textOn(c) }">{{ j + 1 }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in matrix" :key="i">
                <th><span class="fv__chip" :style="{ background: state.colours[i], color: textOn(state.colours[i]) }">{{ i + 1 }}</span></th>
                <td v-for="(v, j) in row" :key="j">
                  <span v-if="i === j" class="fv__diag">—</span>
                  <UInputNumber v-else :model-value="v" :min="0" :max="MAX_FLUSH_VOLUME" :step="10" size="xs" :increment="false" :decrement="false"
                                :aria-label="`Flush from filament ${i + 1} to ${j + 1}`" class="fv__in" :color="v > 700 ? 'warning' : 'primary'" :highlight="v > 700"
                                @update:model-value="(x: number | null) => setCell(i, j, x)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="fv__row">
          <UFormField v-if="state.engine !== 'preflight'" label="Multiplier" :error="badMult ? 'The multiplier should be in range [0.00, 3.00].' : undefined" orientation="horizontal">
            <UInputNumber v-model="multiplier" :min="0" :max="3" :step="0.05" :format-options="{ maximumFractionDigits: 2 }" size="sm" class="w-28" />
          </UFormField>
          <span class="flex-1" />
          <UButton icon="i-lucide-refresh-cw" label="Re-calculate" variant="outline" size="sm" @click="recalc" />
        </div>
        <p v-if="state.engine !== 'preflight'" class="text-xs text-dimmed">Actual flushing volume = matrix value × multiplier.
          <template v-if="preferences.autoFlush !== 'off'">Volumes are re-calculated whenever filament colours{{ preferences.autoFlush === 'all' ? ' or filaments' : '' }} change (Preferences → Auto flush).</template>
        </p>
        <p v-if="outOfRange" class="text-xs text-warning">Some volumes are outside the suggested range.</p>
      </template>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="dialogs.flushing = false" />
        <UButton color="primary" label="OK" :disabled="badMult" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.fv__scroll { overflow: auto; max-height: min(60vh, 520px); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.fv { border-collapse: separate; border-spacing: 0; font-size: 12px; }
.fv th, .fv td { padding: 4px 6px; text-align: center; border-bottom: 1px solid var(--ui-border); }
.fv thead th { position: sticky; top: 0; background: var(--ui-bg-elevated); z-index: 1; }
.fv tbody th { position: sticky; left: 0; background: var(--ui-bg-elevated); }
.fv__corner { font-weight: 400; color: var(--ui-text-dimmed); white-space: nowrap; font-size: 11px; }
.fv__chip { display: inline-grid; place-items: center; min-width: 26px; height: 22px; padding: 0 4px; border-radius: 4px; font-weight: 600; border: 1px solid rgba(255, 255, 255, 0.25); }
.fv__in { width: 72px; }
.fv__in :deep(input) { text-align: right; font-variant-numeric: tabular-nums; }
.fv__diag { color: var(--ui-text-dimmed); display: inline-block; width: 72px; }
.fv__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
