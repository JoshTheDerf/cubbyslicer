<script setup lang="ts">
/**
 * First-run setup (UModal + UStepper): Printer → Filament → Ready.
 * Shown automatically on a user's first visit (SettingsPanel, SETUP_DONE_KEY)
 * and reopenable via the `settings.setup` action (Help menu / palette).
 */
import { computed, ref, watch } from 'vue';
import type { StepperItem } from '@nuxt/ui';
import { ENGINE_LABELS } from '../engine/client';
import type { EngineId } from '../engine/types';
import { ENGINES, presetsFor, setActiveEngine } from '../presets/store';
import type { PresetInfo } from '../presets/types';
import { activeEngine } from '../app/state';
import { mobileDialog, shortScreen } from '../ui/mobileDialog';
import PrinterBrowser from './PrinterBrowser.vue';

const emit = defineEmits<{ (e: 'close', completed: boolean): void }>();
const open = ref(true);
let completed = false;
function close(done: boolean): void { completed = done; open.value = false; }

const STEPS = ['printer', 'filament', 'done'] as const;
type Step = typeof STEPS[number];
const stepItems: StepperItem[] = [
  { value: 'printer', title: 'Printer', description: 'Your machine', icon: 'i-lucide-printer' },
  { value: 'filament', title: 'Filament', description: 'What you print with', icon: 'i-lucide-disc' },
  { value: 'done', title: 'Ready', description: 'Start slicing', icon: 'i-lucide-check' },
];
const step = ref<Step>('printer');
/** Landscape phones hide the stepper: the title carries the step instead. */
const dialogTitle = computed(() => {
  if (!shortScreen.value) return 'Set up your printer';
  const i = stepItems.findIndex((s) => s.value === step.value);
  return `Set up your printer · ${i + 1}/${stepItems.length} ${stepItems[i]?.title ?? ''}`;
});
const engine = computed<EngineId>(() => activeEngine.value);
const p = computed(() => presetsFor(engine.value));
const busy = ref(false);
const engineItems = ENGINES.map((e) => ({ label: ENGINE_LABELS[e], value: e }));

function chooseEngine(e: unknown): void { if (typeof e === 'string' && e !== engine.value) setActiveEngine(e as EngineId); }

const printerName = computed(() => p.value.infos.value.printer.name);
const hasCatalogPrinters = ref(true);
watch(p, async (s) => {
  await s.ready;
  hasCatalogPrinters.value = (await s.catalog.vendors().catch(() => [])).length > 0;
}, { immediate: true });

async function onPrinterPicked(): Promise<void> {
  busy.value = true;
  try { await p.value.ready; } finally { busy.value = false; }
  step.value = 'filament';
}

// ---- filament step -------------------------------------------------------------
const slot = ref(0);
const slots = computed(() => p.value.selection.filaments.length);
const q = ref('');
const type = ref<string | null>(null);
const filaments = computed<PresetInfo[]>(() => p.value.compatible.value.filament);
const types = computed(() => {
  const counts = new Map<string, number>();
  for (const f of filaments.value) if (f.filamentType) counts.set(f.filamentType, (counts.get(f.filamentType) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 12);
});
const groups = computed(() => {
  const s = q.value.trim().toLowerCase();
  const out = new Map<string, PresetInfo[]>();
  for (const f of filaments.value) {
    if (type.value && f.filamentType !== type.value) continue;
    if (s && !`${f.name} ${f.filamentVendor ?? ''} ${f.filamentType ?? ''}`.toLowerCase().includes(s)) continue;
    const g = f.filamentVendor || f.vendor || 'Generic';
    if (!out.has(g)) out.set(g, []);
    out.get(g)!.push(f);
  }
  // Generic first, then alphabetical.
  return [...out.entries()].sort(([a], [b]) => (a === 'Generic' ? -1 : b === 'Generic' ? 1 : a.localeCompare(b)));
});
const selectedFilament = (i: number) => p.value.selectedId('filament', i);
async function pickFilament(id: string): Promise<void> {
  await p.value.selectFilament(slot.value, id);
  if (slot.value < slots.value - 1) slot.value++;
}
function onStep(v: unknown): void {
  // Only allow going back (or to steps already reached).
  const target = STEPS.indexOf(v as Step);
  if (target >= 0 && target <= STEPS.indexOf(step.value)) step.value = STEPS[target];
}
</script>

<template>
  <UModal v-model:open="open" :title="dialogTitle" :description="mobileDialog ? undefined : 'Pick your printer and filament — you can change them any time in the sidebar.'"
          :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-5xl', body: 'flex flex-col gap-3 phone:gap-2 phone:overflow-hidden' }" @after:leave="emit('close', completed)">
    <template #body>
      <!-- Landscape phones: the step shows in the title instead of the stepper. -->
      <UStepper v-if="!shortScreen" :model-value="step" :items="stepItems" size="sm" class="setup-steps" :ui="mobileDialog ? { description: 'hidden', title: 'text-xs' } : undefined" @update:model-value="onStep" />

      <section v-if="step === 'printer'" class="pane">
        <div class="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span>Slicing engine</span>
          <UTabs :model-value="engine" :items="engineItems" :content="false" size="xs" @update:model-value="chooseEngine" />
          <span v-if="shortScreen" class="ms-auto min-w-0 truncate">Current: <strong class="text-highlighted">{{ printerName }}</strong></span>
          <template v-if="!mobileDialog">
            <small v-if="engine === 'orca'" class="text-dimmed">Large printer library (Bambu, Prusa, Creality, Voron, …).</small>
            <small v-else-if="engine === 'fullspectrum'" class="text-dimmed">Snapmaker Orca fork: mixed filaments blend colours by alternating thin layers (Snapmaker U1 and other multi-tool printers).</small>
            <small v-else class="text-dimmed">PrusaSlicer-based. Uses OrcaSlicer's printer library, converted to preFlight settings.</small>
          </template>
        </div>
        <p v-if="!shortScreen" class="text-sm text-muted">Current printer: <strong class="text-highlighted">{{ printerName }}</strong></p>
        <PrinterBrowser v-if="hasCatalogPrinters" :key="engine" :presets="p" @use="onPrinterPicked" />
        <UAlert v-else color="neutral" variant="subtle" icon="i-lucide-info"
                :title="`${ENGINE_LABELS[engine]} has no bundled printer profiles.`"
                description="Continue with the default printer and adjust bed size, nozzle and start G-code in Printer settings (then “Save as…”), or import an Orca/Bambu printer preset."
                :actions="[{ label: 'Continue', color: 'primary', onClick: () => { step = 'filament'; } }]" />
      </section>

      <section v-else-if="step === 'filament'" class="pane">
        <p class="text-sm text-muted">Filaments compatible with <strong class="text-highlighted">{{ printerName }}</strong><span v-if="busy"> — loading…</span></p>
        <div v-if="slots > 1" class="flex flex-wrap gap-1.5">
          <UButton v-for="i in slots" :key="i" size="xs" :variant="slot === i - 1 ? 'soft' : 'outline'" :color="slot === i - 1 ? 'primary' : 'neutral'"
                   :label="`Extruder ${i}: ${p.infos.value.filaments[i - 1]?.name ?? '—'}`" @click="slot = i - 1" />
        </div>
        <div v-if="mobileDialog" class="flex min-w-0 items-center gap-1.5">
          <UInput v-model="q" size="sm" icon="i-lucide-search" placeholder="Search filaments…" spellcheck="false" class="min-w-0 flex-1" />
          <USelect :model-value="type ?? 'all'" :items="[{ value: 'all', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))]" value-key="value" size="sm"
                   class="w-32" aria-label="Filament type" @update:model-value="(v: string) => { type = v === 'all' ? null : v; }" />
        </div>
        <div v-else class="flex flex-wrap items-center gap-1.5">
          <UInput v-model="q" size="sm" icon="i-lucide-search" placeholder="Search filaments…" spellcheck="false" class="w-60" />
          <UButton size="xs" :variant="type === null ? 'soft' : 'ghost'" :color="type === null ? 'primary' : 'neutral'" label="All" @click="type = null" />
          <UButton v-for="t in types" :key="t" size="xs" :variant="type === t ? 'soft' : 'ghost'" :color="type === t ? 'primary' : 'neutral'" :label="t"
                   @click="type = type === t ? null : t" />
        </div>
        <div class="flist">
          <div v-if="!filaments.length" class="text-sm text-dimmed">No compatible filament presets — the default filament will be used.</div>
          <div v-for="[g, list] in groups" :key="g" class="fgroup">
            <h5>{{ g }}</h5>
            <button v-for="f in list" :key="f.id" type="button" class="fil" :class="{ on: selectedFilament(slot) === f.id }" @click="pickFilament(f.id)">
              <span class="ft">{{ f.filamentType ?? '' }}</span>{{ f.alias ?? f.name }}
            </button>
          </div>
        </div>
      </section>

      <section v-else class="pane">
        <h4 class="text-base font-semibold text-highlighted">You're set.</h4>
        <dl class="summary">
          <dt>Engine</dt><dd>{{ ENGINE_LABELS[engine] }}</dd>
          <dt>Printer</dt><dd>{{ p.infos.value.printer.name }}</dd>
          <dt>Process</dt><dd>{{ p.infos.value.process.name }}</dd>
          <template v-for="(f, i) in p.infos.value.filaments" :key="i">
            <dt>{{ slots > 1 ? `Filament ${i + 1}` : 'Filament' }}</dt>
            <dd class="flex items-center gap-2"><span class="inline-block size-3 rounded-sm" :style="{ background: p.filamentColour(i) }" />{{ f.name }}</dd>
          </template>
        </dl>
        <p class="text-sm text-dimmed">Drop a model on the plate (or use File → Import) and press <UKbd>Slice plate</UKbd>.
          You can change any of this later in the sidebar, or rerun this setup from Help.</p>
      </section>
    </template>

    <template #footer>
      <div class="flex w-full items-center gap-2">
        <UButton variant="ghost" class="shrink-0" :label="step === 'done' ? 'Close' : mobileDialog ? 'Skip' : 'Skip setup'" @click="close(step === 'done')" />
        <span class="flex-1" />
        <UButton v-if="step !== 'printer'" variant="outline" class="shrink-0" :label="mobileDialog ? undefined : 'Back'" aria-label="Back" icon="i-lucide-arrow-left" @click="step = step === 'done' ? 'filament' : 'printer'" />
        <UButton v-if="step === 'printer'" color="primary" class="min-w-0" :label="`Keep ${printerName} →`" :title="`Keep ${printerName}`" @click="step = 'filament'" />
        <UButton v-else-if="step === 'filament'" color="primary" label="Next →" @click="step = 'done'" />
        <UButton v-else color="primary" label="Start slicing" icon="i-lucide-play" @click="close(true)" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
@media (max-width: 640px), (max-height: 500px) {
  .pane { flex: 1; gap: 8px; }
  .flist { flex: 1; height: auto; min-height: 0; overflow-x: hidden; overscroll-behavior: contain; }
  .summary dd { overflow-wrap: anywhere; min-width: 0; }
}
.flist { height: 50vh; min-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.fgroup { display: flex; flex-wrap: wrap; gap: 6px; }
.fgroup h5 { flex-basis: 100%; margin: 0 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ui-text-dimmed); }
.fil {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--ui-radius); border: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); cursor: pointer; font-size: 12px;
}
.fil:hover { border-color: var(--ui-border-accented); }
.fil.on { border-color: var(--ui-primary); box-shadow: inset 0 0 0 1px var(--ui-primary); }
.ft { font-family: var(--mono); font-size: 11px; color: var(--ui-text-dimmed); }
.summary { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: 13px; }
.summary dt { color: var(--ui-text-dimmed); }
.summary dd { margin: 0; }
</style>
