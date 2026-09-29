<script setup lang="ts">
/**
 * SVG tool (Orca GLGizmoSVG): emboss an SVG's fills and strokes as a part,
 * negative part, modifier or new object; width / depth stay editable.
 */
import { computed, onMounted, ref } from 'vue';
import type { SvgEmboss } from '../../project/types';
import { touch } from '../../app/shell/uiState';
import { pickFiles } from '../../app/shell/download';
import { toast } from '../../ui';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, toolState } from '../state';
import { PLACE_OPTIONS, useEmbossEditor } from '../emboss';
import { MAX_SVG_BYTES, buildSvgMesh, parseSvg, svgDisplayName } from './svgMesh';

const params = ref<SvgEmboss>({ kind: 'svg', svg: '', name: '', width: 30, depth: 2 });
const natural = ref<[number, number] | null>(null);
const ed = useEmbossEditor({
  kind: 'svg', params, build: (p) => buildSvgMesh(p), name: (p) => svgDisplayName(p.name), noun: 'SVG', ready: () => !!params.value.svg,
});
const { target, place, busy, error, previewSize } = ed;
const placeItems = computed(() => PLACE_OPTIONS.filter((o) => o.value === 'object' || !!ed.hostObject()));
const aspect = computed(() => (natural.value && natural.value[0] > 0 ? natural.value[1] / natural.value[0] : 1));

function measureNatural(svg: string): void {
  try { const o = parseSvg(svg); natural.value = o.width > 0 ? [o.width, o.height] : null; } catch { natural.value = null; }
}

async function loadText(name: string, text: string): Promise<void> {
  if (text.length > MAX_SVG_BYTES) { toast.error(`${name} is too large (max 1 MB).`); return; }
  let o;
  try { o = parseSvg(text); } catch (e) { toast.error(`Couldn't read ${name}.`, { detail: (e as Error)?.message }); return; }
  if (!(o.width > 0)) { toast.warn(`${name} has no filled or stroked shapes to emboss.`); return; }
  natural.value = [o.width, o.height];
  // SVG user units are CSS px (96 dpi) → mm; keep it within a printable range.
  const mm = (o.width * 25.4) / 96;
  params.value = { ...params.value, svg: text, name, width: Math.round(Math.max(5, Math.min(150, mm)) * 10) / 10 };
  if (o.warnings.length) toast.warn(o.warnings.join('\n'));
}

async function choose(): Promise<void> {
  const [f] = await pickFiles('.svg,image/svg+xml', false);
  if (!f) return;
  await loadText(f.name, await f.text());
}

onMounted(() => {
  const req = toolState.request?.svgFile;
  if (req) void loadText(req.name, req.text);
  else if (params.value.svg) measureNatural(params.value.svg);
  else if (!target.value) void choose();
});

const hint = computed(() => {
  const verb = touch.value ? 'Tap' : 'Click';
  if (!params.value.svg) return 'Choose an SVG file to emboss.';
  if (target.value) return target.value.partId ? `${verb} elsewhere on the object to move the SVG.` : `${verb} on the plate to move the object.`;
  return place.value === 'object' ? `${verb} “Add” or a spot on the plate.` : `${verb} on the object’s surface to place the SVG.`;
});
</script>

<template>
  <ToolPanel :title="target ? 'Edit SVG' : 'Add SVG'" icon="i-lucide-shapes" @close="closeTool()">
    <p class="text-xs text-muted">{{ hint }}</p>
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-file-image" class="size-4 text-dimmed shrink-0" />
      <span class="flex-1 min-w-0 truncate text-sm">{{ params.name || 'No file' }}</span>
      <UButton size="sm" variant="soft" :label="params.svg ? 'Replace…' : 'Choose SVG…'" @click="choose" />
    </div>
    <div class="sv__grid">
      <span class="sv__lbl">Width</span>
      <UInputNumber v-model="params.width" :min="0.5" :max="5000" :step="1" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Width (mm)" />
      <span class="sv__lbl">Height</span>
      <span class="text-sm text-muted font-mono">{{ (params.width * aspect).toFixed(2) }}</span>
      <span class="sv__lbl">Depth</span>
      <UInputNumber v-model="params.depth" :min="0.05" :max="500" :step="0.1" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Depth (mm)" />
      <template v-if="!target">
        <span class="sv__lbl">Add as</span>
        <USelect v-model="place" :items="placeItems" size="sm" class="w-full" aria-label="Add as" />
      </template>
    </div>
    <p class="text-xs text-dimmed">All sizes in mm.<template v-if="previewSize[0] > 0"> Shape {{ previewSize[0].toFixed(1) }} × {{ previewSize[1].toFixed(1) }} mm.</template></p>
    <p v-if="error && params.svg" class="text-xs text-error">{{ error }}</p>
    <template #footer>
      <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin text-primary self-center mr-auto" />
      <UButton v-if="target" size="sm" variant="ghost" icon="i-lucide-plus" label="New SVG" @click="ed.newOne()" />
      <UButton v-else size="sm" color="primary" icon="i-lucide-plus" :label="place === 'object' ? 'Add' : 'Add on top'" :disabled="!params.svg" @click="ed.placeOnSelected()" />
      <UButton v-if="target" size="sm" color="primary" label="Done" @click="closeTool()" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.sv__grid { display: grid; grid-template-columns: 76px 1fr; gap: 6px 8px; align-items: center; }
.sv__lbl { font-size: var(--fs-xs); color: var(--fg-1); }
</style>
