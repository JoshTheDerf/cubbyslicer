<script setup lang="ts">
/** Printer catalog browser: vendors → models → nozzle variants. Emits `use` with the chosen preset id. */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import type { EnginePresets } from '../presets/store';
import type { MachineModel, VendorInfo } from '../presets/types';
import { mobileDialog } from '../ui/mobileDialog';

const props = defineProps<{ presets: EnginePresets }>();
const emit = defineEmits<{ (e: 'use', id: string): void }>();

const vendors = shallowRef<VendorInfo[]>([]);
const models = shallowRef<MachineModel[]>([]);
const vendor = ref<string | null>(null);
const model = ref<string | null>(null);
const loadingVendors = ref(true);
const loadingModels = ref(false);
const q = ref('');
const qm = ref('');

onMounted(async () => {
  try { vendors.value = await props.presets.catalog.vendors(); } finally { loadingVendors.value = false; }
  if (vendors.value.length && !vendor.value) {
    const cur = props.presets.infos.value.printer.vendor;
    vendor.value = vendors.value.find((v) => v.id === cur)?.id ?? vendors.value[0].id;
  }
});

let token = 0;
watch(vendor, async (v) => {
  model.value = null;
  models.value = [];
  if (!v) return;
  const t = ++token;
  loadingModels.value = true;
  try {
    const m = await props.presets.catalog.models(v);
    if (t === token) models.value = m;
  } finally { if (t === token) loadingModels.value = false; }
});

const vendorList = computed(() => {
  const s = q.value.trim().toLowerCase();
  return s ? vendors.value.filter((v) => v.name.toLowerCase().includes(s)) : vendors.value;
});
const modelList = computed(() => {
  const s = qm.value.trim().toLowerCase();
  return s ? models.value.filter((m) => m.name.toLowerCase().includes(s)) : models.value;
});
const selectedModel = computed(() => models.value.find((m) => m.name === model.value) ?? null);
const installed = computed(() => new Set(props.presets.installedPrinters.value));
const installedCount = (m: MachineModel) => m.variants.filter((v) => installed.value.has(v.preset.id)).length;

async function add(id: string, select: boolean): Promise<void> {
  if (select) { await props.presets.selectPrinter(id); emit('use', id); }
  else await props.presets.installPrinter(id);
}
async function remove(id: string): Promise<void> { await props.presets.uninstallPrinter(id); }
// Phones: vendor picker + one scrolling model grid; picking a model shows its variants in its place.
const vendorItems = computed(() => vendors.value.map((v) => ({ value: v.id, label: v.name })));

const hideImg = (ev: Event) => { (ev.target as HTMLElement).style.visibility = 'hidden'; };
</script>

<template>
  <div class="pb" :class="{ 'pb--phone': mobileDialog }">
    <UAlert v-if="!loadingVendors && !vendors.length" color="neutral" variant="subtle" icon="i-lucide-info" title="This engine ships no printer profiles."
            description="Use the engine default printer and adjust it in Printer settings, then “Save as…”, or import an Orca/Bambu printer preset or bundle." />
    <template v-else-if="mobileDialog">
      <div class="pb__bar">
        <USelectMenu v-model="vendor" :items="vendorItems" value-key="value" size="sm" icon="i-lucide-factory" placeholder="Vendor…"
                     :loading="loadingVendors" :search-input="{ placeholder: 'Search vendors…' }" class="min-w-0 flex-1" aria-label="Vendor" />
        <UInput v-if="!selectedModel" v-model="qm" size="sm" icon="i-lucide-search" placeholder="Model…" spellcheck="false" class="min-w-0 flex-1" aria-label="Search models" />
      </div>
      <div v-if="selectedModel" class="pb__scroll">
        <div class="mb-1 flex min-w-0 items-center gap-2">
          <UButton size="sm" variant="ghost" icon="i-lucide-arrow-left" aria-label="Back to models" @click="model = null" />
          <h4 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted">{{ selectedModel.name }}</h4>
        </div>
          <div v-for="v in selectedModel.variants" :key="v.preset.id" class="variant">
            <div class="variant__name">
              <strong>{{ v.variant }} mm nozzle</strong>
              <small>{{ v.preset.name }}</small>
            </div>
            <UButton v-if="installed.has(v.preset.id)" size="xs" variant="outline" color="neutral" label="Remove" title="Remove from printer list" @click="remove(v.preset.id)" />
            <UButton v-else size="xs" variant="outline" label="Add" title="Add to the printer list" @click="add(v.preset.id, false)" />
            <UButton size="xs" color="primary" label="Use" @click="add(v.preset.id, true)" />
          </div>
      </div>
      <div v-else class="pb__scroll pb__grid">
          <div v-if="loadingModels" class="pb__muted">Loading models…</div>
          <button v-for="m in modelList" :key="m.name" type="button" class="card" :class="{ on: m.name === model }" @click="model = m.name">
            <UBadge v-if="installedCount(m)" class="card__badge" size="sm" color="primary" variant="solid" :label="String(installedCount(m))" title="Nozzle variants in your printer list" />
            <img v-if="m.coverUrl" :src="m.coverUrl" alt="" loading="lazy" @error="hideImg" />
            <span>{{ m.name }}</span>
          </button>
          <div v-if="!loadingModels && vendor && !modelList.length" class="pb__muted">No models</div>
      </div>
    </template>
    <div v-else class="pb__cols">
      <section class="pb__col">
        <UInput v-model="q" size="sm" icon="i-lucide-search" placeholder="Vendor…" spellcheck="false" class="mb-1.5" />
        <div class="pb__scroll">
          <div v-if="loadingVendors" class="pb__muted">Loading vendors…</div>
          <UButton v-for="v in vendorList" :key="v.id" block size="sm" :variant="v.id === vendor ? 'soft' : 'ghost'" :color="v.id === vendor ? 'primary' : 'neutral'"
                   class="justify-start" :label="v.name" @click="vendor = v.id" />
        </div>
      </section>
      <section class="pb__col">
        <UInput v-model="qm" size="sm" icon="i-lucide-search" placeholder="Model…" spellcheck="false" class="mb-1.5" />
        <div class="pb__scroll pb__grid">
          <div v-if="loadingModels" class="pb__muted">Loading models…</div>
          <button v-for="m in modelList" :key="m.name" type="button" class="card" :class="{ on: m.name === model }" @click="model = m.name">
            <UBadge v-if="installedCount(m)" class="card__badge" size="sm" color="primary" variant="solid" :label="String(installedCount(m))" title="Nozzle variants in your printer list" />
            <img v-if="m.coverUrl" :src="m.coverUrl" alt="" loading="lazy" @error="hideImg" />
            <span>{{ m.name }}</span>
          </button>
          <div v-if="!loadingModels && vendor && !modelList.length" class="pb__muted">No models</div>
        </div>
      </section>
      <section class="pb__col pb__variants">
        <template v-if="selectedModel">
          <h4 class="mb-2 text-sm font-semibold text-highlighted">{{ selectedModel.name }}</h4>
          <div v-for="v in selectedModel.variants" :key="v.preset.id" class="variant">
            <div class="variant__name">
              <strong>{{ v.variant }} mm nozzle</strong>
              <small>{{ v.preset.name }}</small>
            </div>
            <UButton v-if="installed.has(v.preset.id)" size="xs" variant="outline" color="neutral" label="Remove" title="Remove from printer list" @click="remove(v.preset.id)" />
            <UButton v-else size="xs" variant="outline" label="Add" title="Add to the printer list" @click="add(v.preset.id, false)" />
            <UButton size="xs" color="primary" label="Use" @click="add(v.preset.id, true)" />
          </div>
        </template>
        <p v-else class="pb__muted">Pick a model to see its nozzle variants.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pb { min-height: 0; }
.pb__cols { display: grid; grid-template-columns: 180px 1fr 250px; gap: 12px; height: 58vh; min-height: 320px; }
.pb__col { display: flex; flex-direction: column; min-height: 0; }
.pb__scroll { overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 1px; }
.pb__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; align-content: start; }
.card {
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius); color: var(--ui-text-toned); cursor: pointer; font-size: 11px; text-align: center;
}
.card:hover { border-color: var(--ui-border-accented); }
.card img { width: 96px; height: 96px; object-fit: contain; }
.card.on { border-color: var(--ui-primary); color: var(--ui-text-highlighted); box-shadow: inset 0 0 0 1px var(--ui-primary); }
.card__badge { position: absolute; top: 4px; right: 4px; }
.variant { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--ui-border); }
.variant__name { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 12px; }
.variant__name small { color: var(--ui-text-dimmed); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pb--phone { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.pb__bar { flex: none; display: flex; gap: 6px; min-width: 0; }
.pb--phone .pb__scroll { overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
.pb--phone .pb__grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
.pb--phone .card img { width: 72px; height: 72px; }
.pb--phone .variant__name small { white-space: normal; overflow-wrap: anywhere; }
.pb__muted { color: var(--ui-text-dimmed); font-size: 12px; padding: 4px; }
</style>
