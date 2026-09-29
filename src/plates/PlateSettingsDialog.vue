<script setup lang="ts">
/**
 * Orca PlateSettingsDialog: per-plate name, bed (plate) type, print sequence,
 * spiral vase and the first / other layers filament sequence. "Same as
 * global" leaves a key out of the plate's config; the rest override the
 * resolved config when the plate is sliced (see plates/store.ts).
 */
import { computed, ref, watch } from 'vue';
import { activeEngine, resolvedConfig } from '../app/state';
import { getSchema } from '../engine/client';
import type { ConfigSchema, ConfigValue } from '../engine/types';
import { plates, renamePlate } from '../project/store';
import { plateLabel } from '../project/plates';
import { hexCss, toolColorsFromConfig } from '../preview/render/colors';
import { phone } from '../app/shell/uiState';
import { setPlateConfig } from './store';
import { plateUi } from './ui';

/** Orca MAX_LAYER_VALUE ("End"). */
const END_LAYER = 2147483646;

const open = computed({ get: () => plateUi.settingsFor !== null, set: (v: boolean) => { if (!v) plateUi.settingsFor = null; } });
const idx = computed(() => plateUi.settingsFor ?? 0);

const schema = ref<ConfigSchema | null>(null);
watch([activeEngine, open], async ([e, o]) => { if (o) schema.value = await getSchema(e).catch(() => null); }, { immediate: true });
const has = (k: string) => !!schema.value?.options[k];

// Engine key variants: Orca print_sequence / spiral_mode, preFlight complete_objects / spiral_vase.
const seqKey = computed(() => (has('print_sequence') ? 'print_sequence' : has('complete_objects') ? 'complete_objects' : null));
const spiralKey = computed(() => (has('spiral_mode') ? 'spiral_mode' : has('spiral_vase') ? 'spiral_vase' : null));

const filamentCount = computed(() => {
  const v = resolvedConfig.value.filament_colour ?? resolvedConfig.value.extruder_colour;
  return Math.max(1, Array.isArray(v) ? v.length : String(v ?? '').split(/[;,]/).filter(Boolean).length || 1);
});
const colors = computed(() => toolColorsFromConfig(resolvedConfig.value));

// ---- form state ------------------------------------------------------------------------
const name = ref('');
const G = 'global';
const bedType = ref(G);
const printSeq = ref(G);
const spiral = ref(G);
const firstChoice = ref<'auto' | 'custom'>('auto');
const firstOrder = ref<number[]>([]);
const otherChoice = ref<'auto' | 'custom'>('auto');
const otherSeqs = ref<Array<{ begin: number; end: number | null; order: number[] }>>([]);

const defaultOrder = () => Array.from({ length: filamentCount.value }, (_, i) => i + 1);
const ints = (v: ConfigValue | undefined) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n));

watch(open, (o) => {
  if (!o) return;
  const p = plates.value[idx.value];
  const c = p?.config ?? {};
  name.value = p?.name ?? '';
  bedType.value = typeof c.curr_bed_type === 'string' ? c.curr_bed_type : G;
  const ps = c.print_sequence ?? (c.complete_objects !== undefined ? (c.complete_objects === '1' ? 'by object' : 'by layer') : '');
  printSeq.value = typeof ps === 'string' && ps ? ps : G;
  const sp = c.spiral_mode ?? c.spiral_vase;
  spiral.value = sp === '1' ? 'on' : sp === '0' ? 'off' : G;
  const fo = ints(c.first_layer_print_sequence);
  firstChoice.value = fo.length && !(fo.length === 1 && fo[0] === 0) ? 'custom' : 'auto';
  firstOrder.value = firstChoice.value === 'custom' ? fo : defaultOrder();
  const flat = ints(c.other_layers_print_sequence), n = parseInt(String(c.other_layers_print_sequence_nums ?? '0'), 10) || 0;
  const seqs: typeof otherSeqs.value = [];
  if (n > 0 && flat.length % n === 0) {
    const per = flat.length / n;
    for (let i = 0; i < n; i++) {
      const item = flat.slice(i * per, (i + 1) * per);
      seqs.push({ begin: item[0], end: item[1] >= END_LAYER ? null : item[1], order: item.slice(2) });
    }
  }
  otherChoice.value = seqs.length ? 'custom' : 'auto';
  otherSeqs.value = seqs.length ? seqs : [{ begin: 2, end: null, order: defaultOrder() }];
});

const bedItems = computed(() => {
  const d = schema.value?.options.curr_bed_type;
  return [{ label: 'Same as global plate type', value: G }, ...(d?.enumValues ?? []).map((v, i) => ({ label: d?.enumLabels?.[i] || v, value: v }))];
});
const seqItems = [{ label: 'Same as global print sequence', value: G }, { label: 'By layer', value: 'by layer' }, { label: 'By object', value: 'by object' }];
const spiralItems = [{ label: 'Same as global', value: G }, { label: 'Enable', value: 'on' }, { label: 'Disable', value: 'off' }];
const choiceItems = [{ label: 'Auto', value: 'auto' }, { label: 'Customize', value: 'custom' }];

function move(list: number[], i: number, d: -1 | 1): void {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

const layerError = computed(() => {
  if (otherChoice.value !== 'custom') return '';
  for (const s of otherSeqs.value) {
    if (!(s.begin >= 2)) return 'Please input layer value (>= 2).';
    if (s.end !== null && !(s.end >= s.begin)) return 'The end layer must not be below the start layer.';
  }
  return '';
});

function save(): void {
  const i = idx.value;
  if (name.value !== (plates.value[i]?.name ?? '')) renamePlate(i, name.value);
  const cfg: Record<string, ConfigValue> = {};
  if (bedType.value !== G && has('curr_bed_type')) cfg.curr_bed_type = bedType.value;
  if (printSeq.value !== G && seqKey.value) cfg[seqKey.value] = seqKey.value === 'print_sequence' ? printSeq.value : printSeq.value === 'by object' ? '1' : '0';
  if (spiral.value !== G && spiralKey.value) cfg[spiralKey.value] = spiral.value === 'on' ? '1' : '0';
  if (filamentCount.value > 1 && has('first_layer_print_sequence') && firstChoice.value === 'custom') {
    cfg.first_layer_print_sequence = firstOrder.value.map(String);
  }
  if (filamentCount.value > 1 && has('other_layers_print_sequence') && otherChoice.value === 'custom' && otherSeqs.value.length) {
    const sorted = otherSeqs.value.slice().sort((a, b) => a.begin - b.begin);
    cfg.other_layers_print_sequence = sorted.flatMap((s) => [s.begin, s.end ?? END_LAYER, ...s.order]).map(String);
    cfg.other_layers_print_sequence_nums = String(sorted.length);
  }
  setPlateConfig(i, cfg);
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :title="`${plateLabel(plates[idx], idx)} settings`" description="Override printing options for this plate only."
          :fullscreen="phone" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <form class="ps" data-testid="plate-settings" @submit.prevent="save">
        <label class="ps__row"><span>Plate name</span>
          <UInput v-model="name" :placeholder="`Plate ${idx + 1}`" maxlength="80" size="sm" class="ps__ctl" /></label>
        <label v-if="has('curr_bed_type')" class="ps__row"><span>Bed type</span>
          <USelect v-model="bedType" :items="bedItems" size="sm" class="ps__ctl" data-testid="plate-bed-type" /></label>
        <label v-if="seqKey" class="ps__row"><span>Print sequence</span>
          <USelect v-model="printSeq" :items="seqItems" size="sm" class="ps__ctl" data-testid="plate-print-seq" /></label>
        <label v-if="spiralKey" class="ps__row"><span>Spiral vase</span>
          <USelect v-model="spiral" :items="spiralItems" size="sm" class="ps__ctl" /></label>

        <template v-if="filamentCount > 1 && has('first_layer_print_sequence')">
          <label class="ps__row"><span>First layer filament sequence</span>
            <USelect v-model="firstChoice" :items="choiceItems" size="sm" class="ps__ctl" /></label>
          <ol v-if="firstChoice === 'custom'" class="ps__order" aria-label="First layer filament order">
            <li v-for="(f, i) in firstOrder" :key="f">
              <i class="ps__sw" :style="{ background: hexCss(colors[f - 1] ?? 0x999999) }" />{{ f }}
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-left" :disabled="i === 0" :aria-label="`Move filament ${f} earlier`" @click="move(firstOrder, i, -1)" />
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-right" :disabled="i === firstOrder.length - 1" :aria-label="`Move filament ${f} later`" @click="move(firstOrder, i, 1)" />
            </li>
          </ol>
        </template>

        <template v-if="filamentCount > 1 && has('other_layers_print_sequence')">
          <label class="ps__row"><span>Other layer filament sequence</span>
            <USelect v-model="otherChoice" :items="choiceItems" size="sm" class="ps__ctl" /></label>
          <div v-if="otherChoice === 'custom'" class="ps__seqs">
            <div v-for="(s, k) in otherSeqs" :key="k" class="ps__seq">
              <div class="ps__range">
                <span>Layer</span>
                <UInputNumber v-model="s.begin" :min="2" size="xs" class="w-24" />
                <span>to</span>
                <UInputNumber v-if="s.end !== null" v-model="s.end" :min="s.begin" size="xs" class="w-24" />
                <UButton size="xs" variant="soft" color="neutral" :label="s.end === null ? 'End' : 'Set End'" @click="s.end = s.end === null ? s.begin : null" />
                <UButton v-if="otherSeqs.length > 1" size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" aria-label="Remove layer range" @click="otherSeqs.splice(k, 1)" />
              </div>
              <ol class="ps__order">
                <li v-for="(f, i) in s.order" :key="f">
                  <i class="ps__sw" :style="{ background: hexCss(colors[f - 1] ?? 0x999999) }" />{{ f }}
                  <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-left" :disabled="i === 0" :aria-label="`Move filament ${f} earlier`" @click="move(s.order, i, -1)" />
                  <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-right" :disabled="i === s.order.length - 1" :aria-label="`Move filament ${f} later`" @click="move(s.order, i, 1)" />
                </li>
              </ol>
            </div>
            <UButton size="xs" variant="outline" color="neutral" icon="i-lucide-plus" label="Add layer range"
                     @click="otherSeqs.push({ begin: (otherSeqs.at(-1)?.end ?? otherSeqs.at(-1)?.begin ?? 1) + 1, end: null, order: defaultOrder() })" />
          </div>
        </template>
        <p v-if="layerError" class="ps__err">{{ layerError }}</p>
        <p v-if="schema && !has('curr_bed_type') && !seqKey && !spiralKey" class="ps__hint">This engine has no per-plate options.</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" label="OK" :disabled="!!layerError" data-testid="plate-settings-ok" @click="save" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.ps { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.ps__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ps__row > span { color: var(--ui-text); }
.ps__ctl { width: min(240px, 58%); }
.ps__order { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.ps__order li { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 6px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); font-variant-numeric: tabular-nums; }
.ps__sw { width: 12px; height: 12px; border-radius: 3px; margin-right: 4px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.3); }
.ps__seqs { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.ps__seq { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); width: 100%; }
.ps__range { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--ui-text-muted); }
.ps__err { margin: 0; color: var(--ui-error); font-size: 12px; }
.ps__hint { margin: 0; color: var(--ui-text-dimmed); font-size: 12px; }
</style>
