<script setup lang="ts">
/**
 * Orca CreatePresetsDialog: "Create printer" (vendor / model, nozzle, bed
 * size + origin, max height, based on a template printer) and "Create
 * filament" (vendor, type, serial, based on a system filament, for chosen
 * printers). Both are saved as user presets.
 */
import { computed, reactive, ref, watch } from 'vue';
import { mobileDialog } from '../../ui/mobileDialog';
import { currentPresets } from '../../presets/store';
import { DEFAULT_PRESET_ID, type PresetInfo, type PresetValues } from '../../presets/types';
import { PresetNameError } from '../../presets/userPresets';
import { asArray, cloneValue } from '../../presets/values';
import { schemaDefaults, tabOfScope } from '../../presets/resolve';
import { settingsUi } from '../../settings/uiState';
import { toast } from '../../ui';
import { dialogs } from '../state';
import { filamentOverrides, filamentPresetName, NOZZLES, printerOverrides, printerPresetName } from './createPreset';

const props = defineProps<{ kind: 'printer' | 'filament' }>();
const openKey = computed(() => (props.kind === 'printer' ? 'createPrinter' : 'createFilament') as 'createPrinter' | 'createFilament');
const open = computed({ get: () => dialogs[openKey.value], set: (v: boolean) => { dialogs[openKey.value] = v; } });

const p = computed(() => currentPresets.value);
const schema = computed(() => p.value.schema.value);
const error = ref<string | null>(null);
const busy = ref(false);
const nameTouched = ref(false);
const name = ref('');
const useNow = ref(true);
/** Phones: the bed origin fields start collapsed. */
const showOrigin = ref(false);

// ---- printer ---------------------------------------------------------------------------
const pf = reactive({ vendor: '', model: '', nozzle: '0.4', width: 220, depth: 220, originX: 0, originY: 0, height: 250, template: '' });
const vendors = ref<string[]>([]);
const models = ref<string[]>([]);
const templates = computed(() => p.value.printerInfos.value);

// ---- filament --------------------------------------------------------------------------
const ff = reactive({ vendor: '', type: 'PLA', serial: '', base: '', printers: [] as string[], slot: 0 });
const types = computed(() => schema.value?.options.filament_type?.enumValues ?? ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC']);
const baseItems = computed(() => {
  const all = p.value.compatible.value.filament.filter((f) => f.source !== 'default');
  const ofType = all.filter((f) => !ff.type || f.filamentType === ff.type);
  return (ofType.length ? ofType : all).map((f) => ({ value: f.id, label: f.name }));
});
const filamentVendors = computed(() => [...new Set(p.value.compatible.value.filament.map((f) => f.filamentVendor).filter((v): v is string => !!v))].sort());
const printerChoices = computed(() => p.value.printerInfos.value.filter((i) => i.source !== 'default'));

watch(open, async (o) => {
  if (!o) return;
  error.value = null; busy.value = false; nameTouched.value = false; useNow.value = true;
  if (props.kind === 'printer') {
    const cur = p.value.infos.value.printer;
    pf.template = cur.id;
    pf.vendor = ''; pf.model = '';
    pf.nozzle = asArray(p.value.value('printer', 'nozzle_diameter'))[0] ?? '0.4';
    const area = asArray(p.value.value('printer', schema.value?.options.printable_area ? 'printable_area' : 'bed_shape'));
    const pts = area.map((s) => s.split('x').map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
    if (pts.length >= 3) {
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      pf.width = Math.max(...xs) - Math.min(...xs); pf.depth = Math.max(...ys) - Math.min(...ys);
      pf.originX = -Math.min(...xs); pf.originY = -Math.min(...ys);
    }
    pf.height = Number(asArray(p.value.value('printer', schema.value?.options.printable_height ? 'printable_height' : 'max_print_height'))[0]) || 250;
    vendors.value = (await p.value.catalog.vendors().catch(() => [])).map((v) => v.name).sort();
  } else {
    const slot = settingsUi.filamentSlot ?? 0;
    ff.slot = slot;
    ff.vendor = ''; ff.serial = '';
    ff.type = asArray(p.value.value('filament', 'filament_type', slot))[0] ?? 'PLA';
    ff.base = p.value.selectedInfo('filament', slot).source === 'system' ? p.value.selectedId('filament', slot) : baseItems.value[0]?.value ?? '';
    ff.printers = [p.value.infos.value.printer.name].filter((n) => p.value.infos.value.printer.source !== 'default' && !!n);
  }
  name.value = autoName();
});
watch(() => pf.vendor, async (v) => {
  const vendor = (await p.value.catalog.vendors().catch(() => [])).find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
  models.value = vendor ? (await p.value.catalog.models(vendor.id).catch(() => [])).map((m) => m.name) : [];
});
watch(() => ff.type, () => { if (!baseItems.value.some((b) => b.value === ff.base)) ff.base = baseItems.value[0]?.value ?? ''; });
function autoName(): string { return props.kind === 'printer' ? printerPresetName(pf) : filamentPresetName(ff); }
watch(() => [pf.vendor, pf.model, pf.nozzle, ff.vendor, ff.type, ff.serial], () => { if (!nameTouched.value) name.value = autoName(); });

function togglePrinter(n: string, v: boolean): void { ff.printers = v ? [...new Set([...ff.printers, n])] : ff.printers.filter((x) => x !== n); }

/** Template values for a new preset: parent id/name + own values (diff for system parents, full otherwise). */
async function templateFor(kind: 'printer' | 'filament', id: string): Promise<{ parentId?: string; inherits?: string; values: PresetValues; info: PresetInfo | null }> {
  const pr = p.value;
  if (!id || id === DEFAULT_PRESET_ID) {
    const values: PresetValues = {};
    const s = schema.value;
    if (s) for (const [k, v] of Object.entries(schemaDefaults(s))) if (tabOfScope(s.options[k]?.scope) === kind) values[k] = cloneValue(v);
    return { values, info: null };
  }
  const r = await pr.resolvePreset(kind, id);
  if (!r) throw new Error('The template preset is not available.');
  if (r.info.source === 'system') return { parentId: r.info.id, inherits: r.info.name, values: {}, info: r.info };
  const u = pr.users.get(id);
  return { parentId: u?.parentId, inherits: u?.inherits, values: { ...(u?.values ?? {}) }, info: r.info };
}

async function create(): Promise<void> {
  error.value = null;
  const pr = p.value;
  busy.value = true;
  try {
    const n = name.value.trim();
    if (props.kind === 'printer') {
      if (!(pf.width > 0 && pf.depth > 0 && pf.height > 0)) throw new PresetNameError('Enter a positive bed size and printable height.');
      const t = await templateFor('printer', pf.template);
      const tplNozzles = asArray((await pr.resolvePreset('printer', pf.template || DEFAULT_PRESET_ID))?.values.nozzle_diameter ?? ['0.4']);
      const values = { ...t.values, ...printerOverrides(pf, schema.value, tplNozzles) };
      const created = pr.users.create({ kind: 'printer', name: n, parentId: t.parentId, inherits: t.inherits, values });
      await pr.refreshPrinterList();
      if (useNow.value) await pr.selectPrinter(created.id);
      toast.success(`Created printer “${created.name}”.`);
    } else {
      if (!ff.base) throw new PresetNameError('Choose a filament to base the new one on.');
      const t = await templateFor('filament', ff.base);
      const baseValues = (await pr.resolvePreset('filament', ff.base))?.values ?? {};
      const values = { ...t.values, ...filamentOverrides(ff, schema.value, baseValues) };
      const created = pr.users.create({ kind: 'filament', name: n, parentId: t.parentId, inherits: t.inherits, values });
      await pr.refresh();
      if (useNow.value) await pr.selectFilament(ff.slot, created.id);
      toast.success(`Created filament “${created.name}”.`);
    }
    open.value = false;
  } catch (e) {
    error.value = e instanceof PresetNameError ? e.message : `Couldn’t create the preset: ${(e as Error)?.message ?? e}`;
  } finally {
    busy.value = false;
  }
}
const num = (v: number | null | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nozzleItems = NOZZLES.map((n) => ({ value: n, label: `${n} mm` }));
const templateItems = computed(() => templates.value.map((t) => ({ value: t.id, label: t.name, description: t.source === 'user' ? 'user preset' : t.vendor })));
</script>

<template>
  <UModal v-model:open="open" :title="kind === 'printer' ? 'Create printer' : 'Create filament'" :fullscreen="mobileDialog" :dismissible="!busy"
          :description="mobileDialog ? undefined : kind === 'printer' ? 'A custom printer saved as a user preset, based on a template printer.' : 'A custom filament saved as a user preset, based on an existing filament.'"
          :ui="{ content: 'sm:max-w-xl' }">
    <template #body>
      <div class="cp">
      <template v-if="kind === 'printer'">
        <div class="cp__grid2">
          <UFormField label="Vendor" required>
            <UInput v-model="pf.vendor" list="cp-vendors" placeholder="e.g. Voron or My Workshop" size="sm" class="w-full" />
            <datalist id="cp-vendors"><option v-for="v in vendors" :key="v" :value="v" /></datalist>
          </UFormField>
          <UFormField label="Model" required>
            <UInput v-model="pf.model" list="cp-models" placeholder="e.g. 2.4 R2" size="sm" class="w-full" />
            <datalist id="cp-models"><option v-for="m in models" :key="m" :value="m" /></datalist>
          </UFormField>
        </div>
        <div class="cp__grid3 cp__grid3--2">
          <UFormField label="Nozzle diameter"><USelect v-model="pf.nozzle" :items="nozzleItems" value-key="value" size="sm" class="w-full" /></UFormField>
          <UFormField label="Printable height" hint="mm"><UInputNumber :model-value="pf.height" :min="1" size="sm" @update:model-value="(v: number | null) => (pf.height = num(v, 250))" /></UFormField>
        </div>
        <div class="cp__grid4">
          <UFormField label="Bed width" hint="mm"><UInputNumber :model-value="pf.width" :min="1" size="sm" @update:model-value="(v: number | null) => (pf.width = num(v, 220))" /></UFormField>
          <UFormField label="Bed depth" hint="mm"><UInputNumber :model-value="pf.depth" :min="1" size="sm" @update:model-value="(v: number | null) => (pf.depth = num(v, 220))" /></UFormField>
          <template v-if="!mobileDialog || showOrigin">
            <UFormField label="Origin X" hint="mm"><UInputNumber :model-value="pf.originX" size="sm" @update:model-value="(v: number | null) => (pf.originX = num(v))" /></UFormField>
            <UFormField label="Origin Y" hint="mm"><UInputNumber :model-value="pf.originY" size="sm" @update:model-value="(v: number | null) => (pf.originY = num(v))" /></UFormField>
          </template>
        </div>
        <UButton v-if="mobileDialog && !showOrigin" size="xs" variant="link" color="neutral" icon="i-lucide-chevron-right" class="-my-1 self-start"
                 :label="`Bed origin (${pf.originX}, ${pf.originY})`" @click="showOrigin = true" />
        <p v-if="!mobileDialog || showOrigin" class="cp__full text-xs text-dimmed -mt-1">Rectangular bed. The origin is where X0 Y0 is, measured from the front-left corner (e.g. half the size for a centre origin). Use Bed shape… for round or custom beds.</p>
        <UFormField label="Based on" :description="mobileDialog ? undefined : 'G-code, speeds, limits and other settings are copied from this printer; its processes and filaments stay compatible.'">
          <USelectMenu v-model="pf.template" :items="templateItems" value-key="value" size="sm" class="w-full" />
        </UFormField>
      </template>

      <template v-else>
        <div class="cp__grid3 cp__grid3--f">
          <UFormField label="Vendor" required>
            <UInput v-model="ff.vendor" list="cf-vendors" placeholder="e.g. Acme" size="sm" class="w-full" />
            <datalist id="cf-vendors"><option v-for="v in filamentVendors" :key="v" :value="v" /></datalist>
          </UFormField>
          <UFormField label="Type"><USelectMenu v-model="ff.type" :items="types" size="sm" class="w-full" /></UFormField>
          <UFormField label="Serial" hint="optional"><UInput v-model="ff.serial" placeholder="e.g. Silk" size="sm" class="w-full" /></UFormField>
        </div>
        <UFormField label="Based on" :description="mobileDialog ? undefined : 'Temperatures, cooling, flow and the other filament settings are copied from this filament.'">
          <USelectMenu v-model="ff.base" :items="baseItems" value-key="value" size="sm" class="w-full" placeholder="Choose a filament" />
        </UFormField>
        <UFormField v-if="mobileDialog" label="Printers" hint="none = every printer">
          <USelectMenu v-model="ff.printers" :items="printerChoices.map((pi) => pi.name)" multiple size="sm" class="w-full" placeholder="Every printer"
                       :search-input="{ placeholder: 'Search printers…' }" aria-label="Printers" />
        </UFormField>
        <UFormField v-else label="Printers" description="The filament is offered for these printers (none ticked = every printer).">
          <div class="cp__printers">
            <label v-for="pi in printerChoices" :key="pi.id" class="cp__printer">
              <UCheckbox :model-value="ff.printers.includes(pi.name)" @update:model-value="(v: boolean | 'indeterminate') => togglePrinter(pi.name, v === true)" />
              <span class="truncate">{{ pi.name }}</span>
            </label>
            <p v-if="!printerChoices.length" class="text-xs text-dimmed">No printers installed yet.</p>
          </div>
        </UFormField>
      </template>

      <UFormField label="Preset name">
        <UInput v-model="name" size="sm" class="w-full" spellcheck="false" @input="nameTouched = true" />
      </UFormField>
      <UCheckbox v-if="!mobileDialog" v-model="useNow" :label="kind === 'printer' ? 'Use this printer now' : `Use it for filament ${ff.slot + 1}`" />
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="error" class="cp__full" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UCheckbox v-if="mobileDialog" v-model="useNow" :label="kind === 'printer' ? 'Use now' : `Use for filament ${ff.slot + 1}`" class="me-auto min-w-0" />
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton color="primary" label="Create" :loading="busy" :disabled="!name.trim()" @click="create" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 12px; }
@media (max-width: 640px), (max-height: 500px) { .cp { gap: 8px; } }
.cp__grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.cp__grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.cp__grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.cp__printers { max-height: 180px; overflow: auto; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); padding: 4px; }
.cp__printer { display: flex; align-items: center; gap: 8px; padding: 3px 4px; font-size: 13px; cursor: pointer; }
@media (max-width: 640px), (max-height: 500px) {
  .cp__grid2, .cp__grid3, .cp__grid4 { gap: 8px; }
  .cp__grid3 { grid-template-columns: 1fr; }
  .cp__grid3--2, .cp__grid4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cp__grid3--f { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cp__grid3--f > :first-child { grid-column: 1 / -1; }
}
/* Landscape phones: the fields flow in two columns so the form fits without scrolling. */
@media (max-height: 500px) and (min-width: 560px) {
  .cp { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 8px 12px; }
  .cp__full, .cp__grid3--f, .cp__grid4:has(> :nth-child(3)) { grid-column: 1 / -1; }
  .cp__grid4:has(> :nth-child(3)), .cp__grid3--f { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .cp__grid3--f > :first-child { grid-column: span 2; }
  .cp > button { align-self: center; }
}
</style>
