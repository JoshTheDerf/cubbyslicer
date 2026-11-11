<script setup lang="ts">
/**
 * Calibration menu dialogs (OrcaSlicer calib_dlg.cpp): temperature, flow ratio,
 * pressure advance, retraction, max flowrate, VFA, input shaping frequency /
 * damping and cornering. "OK" hands the Calib_Params to run.ts, which builds
 * the calibration project like Plater::calib_*.
 */
import { computed, reactive, ref, watch } from 'vue';
import type { CalibParams } from '../engine/types';
import { mobileDialog } from '../ui/mobileDialog';
import AppDialog from '../ui/AppDialog.vue';
import { resolvedConfig } from '../app/state';
import { confirmAction } from '../app/shell/uiState';
import { cfgString, SCALAR, valueAt } from '../lib/configValue';
import { currentPresets } from '../presets/store';
import { toast } from '../ui';
import {
  corneringDefaults, corneringParams, paDefaults, paMethodsFor, paParams, rangeDefaults, rangeParams, shaperTypesFor, shapingDampParams, shapingFreqParams,
  snapTemp, SHAPING_DAMP_DEFAULTS, SHAPING_FREQ_DEFAULTS,
  TEMP_FILAMENTS, tempFilamentOf, tempParams, tempRangeFor, vfaAdjust, type PAMethod, type TempFilament,
} from './forms';
import type { CalibRequest } from './plan';
import {
  calibCornering, calibFlowRate, calibInputShapingDamp, calibInputShapingFreq, calibMaxVolSpeed, calibPA, calibPrinterFacts, calibRetraction,
  calibTemp, calibVFA, compatibleLayerHeights, type FlowPass,
} from './run';
import { calibUi, installCalibrationState, type CalibDialogId } from './state';

installCalibrationState();

const TITLES: Record<CalibDialogId, string> = {
  temp: 'Temperature calibration', flow: 'Flow ratio calibration', pa: 'Pressure advance calibration', retraction: 'Retraction test',
  volumetric: 'Max volumetric speed test', vfa: 'VFA test', is_freq: 'Input shaping frequency test', is_damp: 'Input shaping damping test',
  cornering: 'Cornering test',
};
const WIKI: Record<CalibDialogId, string> = {
  temp: 'temp_calib', flow: 'flow_ratio_calib', pa: 'pressure_advance_calib', retraction: 'retraction_calib', volumetric: 'volumetric_speed_calib',
  vfa: 'vfa_calib', is_freq: 'input_shaping_calib', is_damp: 'input_shaping_calib', cornering: 'cornering_calib',
};

const open = computed({
  get: () => calibUi.open !== null,
  set: (v: boolean) => { if (!v && !calibUi.busy) calibUi.open = null; },
});
const id = ref<CalibDialogId>('temp');
watch(() => calibUi.open, (v) => { if (v) { id.value = v; reset(v); } });
const error = ref<string | null>(null);
const facts = ref(calibPrinterFacts());

// ---- models ---------------------------------------------------------------------------
const temp = reactive({ filament: 'PLA' as TempFilament, start: 230, end: 190, resize: true, model: 0 });
const flow = reactive({ type: 2 as 0 | 1 | 2 | 3, pattern: 'archimedeanchords' as FlowPass['pattern'] });
const pa = reactive({ method: 'pa_tower' as PAMethod, bowden: false, start: 0, end: 0.1, step: 0.002, printNumbers: false, accels: '', speeds: '' });
const range = reactive({ start: 0, end: 0, step: 0, resize: true, autoAdjust: true });
const isf = reactive({ ...SHAPING_FREQ_DEFAULTS, shaper: 'Default' });
const isd = reactive({ ...SHAPING_DAMP_DEFAULTS, shaper: 'Default' });
const corner = reactive({ model: 0, start: 1, end: 15 });

const reprap = computed(() => facts.value.flavor === 'reprapfirmware');
const shaperItems = computed(() => shaperTypesFor(facts.value.flavor).map((v) => ({ value: v, label: v })));
const cornerDef = computed(() => corneringDefaults(facts.value.junctionDeviation));

function reset(which: CalibDialogId): void {
  error.value = null;
  facts.value = calibPrinterFacts();
  const cfg = resolvedConfig.value;
  if (which === 'temp') {
    const type = valueAt(currentPresets.value.value('filament', 'filament_type', 0), SCALAR) ?? cfgString(cfg, 'filament_type', SCALAR, 'PLA');
    temp.filament = tempFilamentOf(type);
    Object.assign(temp, tempRangeFor(temp.filament));
  } else if (which === 'pa') {
    pa.bowden = cfgString(cfg, 'extruder_type', SCALAR) === 'Bowden';
    pa.accels = ''; pa.speeds = '';
    if (facts.value.belt) pa.method = 'pa_tower';
    Object.assign(pa, paDefaults(pa.method, pa.bowden));
  } else if (which === 'retraction') Object.assign(range, rangeDefaults('retraction_tower'));
  else if (which === 'volumetric') Object.assign(range, rangeDefaults('vol_speed_tower'));
  else if (which === 'vfa') Object.assign(range, rangeDefaults('vfa_tower'));
  else if (which === 'is_freq') { isf.shaper = shaperTypesFor(facts.value.flavor)[0]; }
  else if (which === 'is_damp') { isd.shaper = shaperTypesFor(facts.value.flavor)[0]; }
  else if (which === 'cornering') Object.assign(corner, { start: cornerDef.value.start, end: cornerDef.value.end });
}
watch(() => temp.filament, (f) => Object.assign(temp, tempRangeFor(f)));
watch(() => [pa.method, pa.bowden], () => Object.assign(pa, paDefaults(pa.method, pa.bowden)));

const tempItems = TEMP_FILAMENTS.map((f) => ({ value: f, label: f }));
const flowItems = [
  { value: 0, label: 'Pass 1 (coarse)', description: 'Nine blocks from −20 % to +20 % flow.' },
  { value: 1, label: 'Pass 2 (fine)', description: 'Ten blocks from 0 % to −9 % after pass 1.' },
  { value: 2, label: 'YOLO (recommended)', description: 'One print, ±0.05 flow ratio in 0.01 steps.' },
  { value: 3, label: 'YOLO (perfectionist)', description: '±0.035 flow ratio in 0.005 steps.' },
];
const patternItems = [{ value: 'archimedeanchords', label: 'Archimedean chords' }, { value: 'monotonic', label: 'Monotonic' }];
const METHOD_LABELS: Record<PAMethod, string> = { pa_tower: 'PA tower', pa_line: 'PA line', pa_pattern: 'PA pattern' };
const methodItems = computed(() => paMethodsFor(facts.value.belt).map((m) => ({ value: m, label: METHOD_LABELS[m] })));
const beltTempModels = [{ value: 0, label: 'Standard' }, { value: 1, label: 'Overhang' }];
const extruderItems = [{ value: false, label: 'Direct drive' }, { value: true, label: 'Bowden' }];
const towerItems = [{ value: 0, label: 'Ringing tower' }, { value: 1, label: 'Fast tower' }];
const cornerModels = [{ value: 0, label: 'Ringing tower' }, { value: 1, label: 'Fast tower' }, { value: 2, label: 'SCV-V2' }];

const rangeMeta = computed(() => {
  if (id.value === 'retraction') return { unit: 'mm', start: 'Start retraction length', end: 'End retraction length', step: 0.1 };
  if (id.value === 'volumetric') return { unit: 'mm³/s', start: 'Start volumetric speed', end: 'End volumetric speed', step: 0.5 };
  return { unit: 'mm/s', start: 'Start speed', end: 'End speed', step: 1 };
});

const n = (v: number | null | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** VFA_Test_Dlg::on_start: keep the end speed within the filament's max volumetric speed (null: the user backed out). */
async function vfaWithAutoAdjust(p: CalibParams): Promise<CalibRequest | null> {
  const f = facts.value;
  const req: CalibRequest = { ...p, nozzleBasedResize: range.resize, vfaLayerHeight: 0 };
  const d = await vfaAdjust(p, range.resize, range.autoAdjust, { nozzle: f.nozzle, lineWidth: f.vfa.wallLineWidth, ...f.vfa }, compatibleLayerHeights);
  if (d.kind === 'ok') return req;
  if (d.kind === 'reduced') { toast.info(d.message); return { ...req, vfaLayerHeight: d.layerHeight }; }
  const ok = await confirmAction({ title: 'VFA test', message: d.message, confirmLabel: 'Continue' });
  if (!ok) return null;
  return d.kind === 'lower-end' ? { ...req, end: d.end, vfaLayerHeight: d.layerHeight } : req;
}

async function start(): Promise<void> {
  error.value = null;
  let params: CalibParams | string | null = null;
  let runner: ((p: CalibParams) => Promise<boolean>) | null = null;
  switch (id.value) {
    case 'temp': params = tempParams(temp.start, temp.end, temp.resize, facts.value.belt ? temp.model : 0); runner = calibTemp; break;
    case 'pa': params = paParams({ ...pa }); runner = calibPA; break;
    case 'retraction': params = rangeParams('retraction_tower', range.start, range.end, range.step); runner = calibRetraction; break;
    case 'volumetric': params = rangeParams('vol_speed_tower', range.start, range.end, range.step); runner = calibMaxVolSpeed; break;
    case 'vfa': {
      const r = rangeParams('vfa_tower', range.start, range.end, range.step);
      if (typeof r === 'string') { error.value = r; return; }
      const adjusted = await vfaWithAutoAdjust(r);
      if (!adjusted) return;
      params = adjusted; runner = calibVFA; break;
    }
    case 'is_freq': params = shapingFreqParams({ ...isf }, reprap.value); runner = calibInputShapingFreq; break;
    case 'is_damp': params = shapingDampParams({ ...isd }, reprap.value); runner = calibInputShapingDamp; break;
    case 'cornering': {
      const r = corneringParams(corner.start, corner.end, corner.model, facts.value.junctionDeviation);
      if (typeof r === 'string') { error.value = r; return; }
      if (r.warning) toast.warn(r.warning);
      params = r.params; runner = calibCornering; break;
    }
    case 'flow': break;
  }
  if (typeof params === 'string') { error.value = params; return; }
  calibUi.busy = true;
  try {
    const ok = id.value === 'flow'
      ? await calibFlowRate({ linear: flow.type >= 2, pass: ((flow.type % 2) + 1) as 1 | 2, pattern: flow.pattern })
      : await runner!(params!);
    if (ok) calibUi.open = null;
  } finally {
    calibUi.busy = false;
  }
}
</script>

<template>
  <AppDialog v-model:open="open" :title="TITLES[id]" size="lg" fullscreen :dismissible="!calibUi.busy" body-class="flex flex-col gap-4 dlg-flow"
             confirm-label="OK" :confirm-loading="calibUi.busy" test-id="calib" @confirm="start">
      <!-- Temperature -->
      <template v-if="id === 'temp'">
        <UFormField label="Filament type">
          <URadioGroup v-model="temp.filament" :items="tempItems" orientation="horizontal" :variant="mobileDialog ? 'card' : 'table'" size="xs" class="cd__wrap" :ui="{ fieldset: 'phone:gap-1.5', item: 'phone:px-2.5 phone:py-0' }" />
        </UFormField>
        <div class="cd__grid">
          <UFormField label="Start temp" hint="°C"><UInputNumber :step-snapping="false" :model-value="temp.start" :min="155" :max="500" :step="5" size="sm" @update:model-value="(v: number | null) => (temp.start = snapTemp(n(v, 230)))" /></UFormField>
          <UFormField label="End temp" hint="°C"><UInputNumber :step-snapping="false" :model-value="temp.end" :min="155" :max="500" :step="5" size="sm" @update:model-value="(v: number | null) => (temp.end = snapTemp(n(v, 190)))" /></UFormField>
          <UFormField label="Temp step" hint="°C"><UInputNumber :model-value="5" disabled size="sm" /></UFormField>
        </div>
        <UCheckbox v-model="temp.resize" label="Auto-scale for nozzle" class="dlg-span"
                   description="The model is designed for a 0.4 mm nozzle at 0.2 mm layers. Scaling (recommended) resizes it to your nozzle and sets a matching layer height; turn it off to print the reference model as-is." />
        <UFormField v-if="facts.belt" label="Test model" class="dlg-span">
          <URadioGroup v-model="temp.model" :items="beltTempModels" orientation="horizontal" size="sm" />
        </UFormField>
        <p class="cd__note dlg-span">
          <template v-if="facts.belt && temp.model === 1">Prints Orca’s pre-numbered overhang samples along the belt (available for 230–190, 240–210, 250–230, 270–230, 280–240 and 320–280 °C).</template>
          <template v-else-if="facts.belt">Prints one tower block per temperature, spaced along the belt.</template>
          <template v-else>Prints a tower of 10 mm blocks, one per temperature, from the start temperature at the bottom down to the end temperature at the top.</template>
        </p>
      </template>

      <!-- Flow ratio -->
      <template v-else-if="id === 'flow'">
        <UFormField label="Calibration test type">
          <URadioGroup v-model="flow.type" :items="flowItems" variant="list" size="sm" />
        </UFormField>
        <UFormField label="Top surface pattern">
          <USelect v-model="flow.pattern" :items="patternItems" value-key="value" size="sm" class="w-56" />
        </UFormField>
        <p class="cd__note">Uses the flow ratio of the first filament ({{ valueAt(currentPresets.value('filament', 'filament_flow_ratio', 0), SCALAR) ?? '1' }}). After printing, pick the smoothest top surface and update the filament’s flow ratio.</p>
      </template>

      <!-- Pressure advance -->
      <template v-else-if="id === 'pa'">
        <div class="cd__row">
          <UFormField label="Extruder type">
            <URadioGroup v-model="pa.bowden" :items="extruderItems" orientation="horizontal" size="sm" />
          </UFormField>
          <UFormField label="Method">
            <URadioGroup v-model="pa.method" :items="methodItems" orientation="horizontal" size="sm" />
          </UFormField>
          <p v-if="facts.belt" class="cd__note">PA line and PA pattern aren’t enabled on belt printers yet.</p>
        </div>
        <div class="cd__grid">
          <UFormField label="Start PA"><UInputNumber :step-snapping="false" :model-value="pa.start" :min="0" :step="0.001" :format-options="{ maximumFractionDigits: 4 }" size="sm" @update:model-value="(v: number | null) => (pa.start = n(v))" /></UFormField>
          <UFormField label="End PA"><UInputNumber :step-snapping="false" :model-value="pa.end" :min="0" :step="0.001" :format-options="{ maximumFractionDigits: 4 }" size="sm" @update:model-value="(v: number | null) => (pa.end = n(v))" /></UFormField>
          <UFormField label="PA step"><UInputNumber :step-snapping="false" :model-value="pa.step" :min="0.001" :step="0.001" :format-options="{ maximumFractionDigits: 4 }" size="sm" @update:model-value="(v: number | null) => (pa.step = n(v))" /></UFormField>
        </div>
        <UCheckbox v-model="pa.printNumbers" label="Print numbers" :disabled="pa.method !== 'pa_line'" />
        <div v-if="pa.method === 'pa_pattern'" class="cd__grid2">
          <UFormField label="Accelerations" hint="mm/s²" description="Comma-separated list of printing accelerations">
            <UInput v-model="pa.accels" placeholder="e.g. 1000, 5000" size="sm" class="w-full" />
          </UFormField>
          <UFormField label="Speeds" hint="mm/s" description="Comma-separated list of printing speeds">
            <UInput v-model="pa.speeds" placeholder="e.g. 100, 200" size="sm" class="w-full" />
          </UFormField>
        </div>
      </template>

      <!-- Retraction / max flowrate / VFA -->
      <template v-else-if="id === 'retraction' || id === 'volumetric' || id === 'vfa'">
        <div class="cd__grid">
          <UFormField :label="rangeMeta.start" :hint="rangeMeta.unit"><UInputNumber :step-snapping="false" :model-value="range.start" :step="rangeMeta.step" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (range.start = n(v))" /></UFormField>
          <UFormField :label="rangeMeta.end" :hint="rangeMeta.unit"><UInputNumber :step-snapping="false" :model-value="range.end" :step="rangeMeta.step" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (range.end = n(v))" /></UFormField>
          <UFormField label="Step" :hint="rangeMeta.unit"><UInputNumber :step-snapping="false" :model-value="range.step" :step="rangeMeta.step" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (range.step = n(v))" /></UFormField>
        </div>
        <p v-if="id === 'volumetric'" class="cd__note">Prints a vase-mode wall whose speed rises with height. The filament’s max volumetric speed is raised to 200 mm³/s for the test.</p>
        <p v-else-if="id === 'retraction'" class="cd__note">The retraction length increases by one step per millimetre of tower height.</p>
        <template v-else>
          <div class="flex flex-col gap-2 dlg-span">
            <UCheckbox v-model="range.resize" label="Auto-scale for nozzle"
                       description="Resizes the 0.4 mm / 0.2 mm reference model to your nozzle, 25 layers per speed band." />
            <UCheckbox v-model="range.autoAdjust" label="Auto-adjust to max volumetric speed" :disabled="!range.resize"
                       description="If the end speed exceeds what the filament’s max volumetric speed allows, lower the layer height to one of this printer’s profiles (or, failing that, the end speed)." />
          </div>
          <p class="cd__note">Prints a vase-mode tower in bands of 25 layers, one speed per band, to reveal vertical fine artifacts.</p>
        </template>
      </template>

      <!-- Input shaping: frequency -->
      <template v-else-if="id === 'is_freq'">
        <div class="cd__row">
          <UFormField label="Test model"><URadioGroup v-model="isf.model" :items="towerItems" size="sm" /></UFormField>
          <UFormField label="Input shaper type" :description="facts.flavor === 'marlin2' ? 'Marlin ≥ 2.1.2' : facts.flavor === 'klipper' ? 'Klipper ≥ 0.9.0' : reprap ? 'RepRapFirmware ≥ 3.4.0' : 'Check your firmware supports it.'">
            <USelect v-model="isf.shaper" :items="shaperItems" value-key="value" size="sm" class="w-40" />
          </UFormField>
        </div>
        <div class="cd__grid2">
          <UFormField :label="reprap ? 'Frequency start / end' : 'X start / end'" hint="Hz">
            <div class="cd__pair">
              <UInputNumber :model-value="isf.startX" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isf.startX = n(v))" />
              <UInputNumber :model-value="isf.endX" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isf.endX = n(v))" />
            </div>
          </UFormField>
          <UFormField v-if="!reprap" label="Y start / end" hint="Hz">
            <div class="cd__pair">
              <UInputNumber :model-value="isf.startY" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isf.startY = n(v))" />
              <UInputNumber :model-value="isf.endY" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isf.endY = n(v))" />
            </div>
          </UFormField>
        </div>
        <UFormField label="Damp" description="Recommended: 0 — uses the printer’s default or saved value.">
          <UInputNumber :step-snapping="false" :model-value="isf.damp" :min="0" :max="1" :step="0.01" :format-options="{ maximumFractionDigits: 3 }" size="sm" class="w-32" @update:model-value="(v: number | null) => (isf.damp = n(v))" />
        </UFormField>
      </template>

      <!-- Input shaping: damping -->
      <template v-else-if="id === 'is_damp'">
        <div class="cd__row">
          <UFormField label="Test model"><URadioGroup v-model="isd.model" :items="towerItems" size="sm" /></UFormField>
          <UFormField label="Input shaper type"><USelect v-model="isd.shaper" :items="shaperItems" value-key="value" size="sm" class="w-40" /></UFormField>
        </div>
        <div class="cd__grid2">
          <UFormField :label="reprap ? 'Frequency' : 'Frequency X / Y'" hint="Hz">
            <div class="cd__pair">
              <UInputNumber :model-value="isd.freqX" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isd.freqX = n(v))" />
              <UInputNumber v-if="!reprap" :model-value="isd.freqY" :min="0" :max="500" size="sm" @update:model-value="(v: number | null) => (isd.freqY = n(v))" />
            </div>
          </UFormField>
          <UFormField label="Damp start / end">
            <div class="cd__pair">
              <UInputNumber :step-snapping="false" :model-value="isd.start" :min="0" :max="1" :step="0.01" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (isd.start = n(v))" />
              <UInputNumber :step-snapping="false" :model-value="isd.end" :min="0" :max="1" :step="0.01" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (isd.end = n(v))" />
            </div>
          </UFormField>
        </div>
        <p class="cd__note">Use the frequencies found with the frequency test.</p>
      </template>

      <!-- Cornering -->
      <template v-else-if="id === 'cornering'">
        <UFormField label="Test model"><URadioGroup v-model="corner.model" :items="cornerModels" orientation="horizontal" size="sm" /></UFormField>
        <div class="cd__grid2">
          <UFormField label="Start" :hint="cornerDef.unit"><UInputNumber :step-snapping="false" :model-value="corner.start" :min="0" :step="facts.junctionDeviation ? 0.005 : 0.5" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (corner.start = n(v))" /></UFormField>
          <UFormField label="End" :hint="cornerDef.unit"><UInputNumber :step-snapping="false" :model-value="corner.end" :min="0" :step="facts.junctionDeviation ? 0.005 : 0.5" :format-options="{ maximumFractionDigits: 3 }" size="sm" @update:model-value="(v: number | null) => (corner.end = n(v))" /></UFormField>
        </div>
        <p class="cd__note">
          Lower values give sharper corners but slower speeds.
          <template v-if="facts.flavor === 'marlin2'">{{ facts.junctionDeviation ? 'Marlin 2 junction deviation detected: to test classic jerk, set “Maximum junction deviation” to 0.' : 'Marlin 2 classic jerk detected: to test junction deviation, set “Maximum junction deviation” above 0.' }}</template>
          <template v-else-if="reprap">RepRap detected: jerk in mm/s (converted to mm/min where needed).</template>
        </p>
      </template>

      <UAlert v-if="error" class="dlg-span" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />
    <template #footer-start>
      <UButton :href="`https://www.orcaslicer.com/wiki/${WIKI[id]}`" target="_blank" rel="noopener" variant="link" color="info" icon="i-lucide-book-open" label="Wiki guide" />
    </template>
  </AppDialog>
</template>

<style scoped>
.cd__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.cd__grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.cd__row { display: flex; flex-wrap: wrap; gap: 16px 32px; }
.cd__pair { display: flex; gap: 6px; }
.cd__pair > * { min-width: 0; flex: 1; }
.cd__note { margin: 0; font-size: 12px; color: var(--ui-text-muted); }
.cd__wrap :deep([data-slot='fieldset']) { flex-wrap: wrap; }
@media (max-width: 640px) {
  .cd__grid, .cd__grid2 { grid-template-columns: 1fr 1fr; }
}
</style>
