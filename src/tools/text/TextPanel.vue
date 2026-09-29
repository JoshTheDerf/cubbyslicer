<script setup lang="ts">
/**
 * Text tool (Orca GLGizmoEmboss / GLGizmoText, key T): add embossed or
 * engraved text to an object's surface (part / negative part / modifier) or
 * as a new object; edit it later by picking it and pressing T again.
 */
import { computed, ref } from 'vue';
import type { TextEmboss } from '../../project/types';
import { touch } from '../../app/shell/uiState';
import ToolPanel from '../ToolPanel.vue';
import { closeTool } from '../state';
import { PLACE_OPTIONS, useEmbossEditor } from '../emboss';
import { FONT_FAMILIES, familyOf } from './fonts';
import { DEFAULT_TEXT, buildTextMesh, textName } from './textMesh';

const params = ref<TextEmboss>({ ...DEFAULT_TEXT });
const ed = useEmbossEditor({ kind: 'text', params, build: buildTextMesh, name: (p) => textName(p.text), noun: 'text' });
const { target, place, busy, error, previewSize } = ed;

const fontItems = FONT_FAMILIES.map((f) => ({ label: f.label, value: f.id }));
const fam = computed(() => familyOf(params.value.font));
const hasBold = computed(() => !!fam.value.files.bold);
const placeItems = computed(() => PLACE_OPTIONS.filter((o) => o.value === 'object' || !!ed.hostObject()));
const ALIGN = [
  { value: 'left', icon: 'i-lucide-align-left', label: 'Align left' },
  { value: 'center', icon: 'i-lucide-align-center', label: 'Centre' },
  { value: 'right', icon: 'i-lucide-align-right', label: 'Align right' },
] as const;
const hint = computed(() => {
  const verb = touch.value ? 'Tap' : 'Click';
  if (target.value) return target.value.partId ? `${verb} elsewhere on the object to move the text.` : `${verb} on the plate to move the text object.`;
  return place.value === 'object' ? `${verb} “Add” or a spot on the plate to create a text object.` : `${verb} on the object’s surface to place the text.`;
});
</script>

<template>
  <ToolPanel :title="target ? 'Edit text' : 'Add text'" icon="i-lucide-type" @close="closeTool()">
    <p class="text-xs text-muted">{{ hint }}</p>
    <UTextarea v-model="params.text" :rows="2" autoresize :maxrows="6" placeholder="Text" aria-label="Text" class="w-full" autofocus />
    <div class="tx__grid">
      <span class="tx__lbl">Font</span>
      <USelect v-model="params.font" :items="fontItems" size="sm" class="w-full" aria-label="Font" />
      <span class="tx__lbl">Style</span>
      <div class="flex gap-3 items-center">
        <UCheckbox v-model="params.bold" label="Bold" size="sm" :disabled="!hasBold" />
        <UCheckbox v-model="params.italic" label="Italic" size="sm" />
        <UFieldGroup size="sm" class="ml-auto">
          <UTooltip v-for="a in ALIGN" :key="a.value" :text="a.label">
            <UButton :icon="a.icon" :variant="params.align === a.value ? 'soft' : 'ghost'" :color="params.align === a.value ? 'primary' : 'neutral'"
                     :aria-label="a.label" :aria-pressed="params.align === a.value" @click="params.align = a.value" />
          </UTooltip>
        </UFieldGroup>
      </div>
      <span class="tx__lbl">Height</span>
      <UInputNumber v-model="params.size" :min="0.5" :max="1000" :step="0.5" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Text height (mm)" />
      <span class="tx__lbl">Depth</span>
      <UInputNumber v-model="params.depth" :min="0.05" :max="500" :step="0.1" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Emboss depth (mm)" />
      <span class="tx__lbl">Letter gap</span>
      <UInputNumber v-model="params.letterSpacing" :min="-50" :max="50" :step="0.1" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Letter spacing (mm)" />
      <span class="tx__lbl">Line gap</span>
      <UInputNumber v-model="params.lineSpacing" :min="-50" :max="50" :step="0.1" size="sm" :format-options="{ maximumFractionDigits: 2 }" aria-label="Line spacing (mm)" />
      <template v-if="!target">
        <span class="tx__lbl">Add as</span>
        <USelect v-model="place" :items="placeItems" size="sm" class="w-full" aria-label="Add as" />
      </template>
    </div>
    <p class="text-xs text-dimmed">All sizes in mm.<template v-if="previewSize[0] > 0"> Text block {{ previewSize[0].toFixed(1) }} × {{ previewSize[1].toFixed(1) }} mm.</template></p>
    <p v-if="error" class="text-xs text-error">{{ error }}</p>
    <template #footer>
      <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-4 animate-spin text-primary self-center mr-auto" />
      <UButton v-if="target" size="sm" variant="ghost" icon="i-lucide-plus" label="New text" @click="ed.newOne()" />
      <UButton v-else size="sm" color="primary" icon="i-lucide-plus" :label="place === 'object' ? 'Add' : 'Add on top'" :disabled="!params.text.trim()" @click="ed.placeOnSelected()" />
      <UButton v-if="target" size="sm" color="primary" label="Done" @click="closeTool()" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.tx__grid { display: grid; grid-template-columns: 76px 1fr; gap: 6px 8px; align-items: center; }
.tx__lbl { font-size: var(--fs-xs); color: var(--fg-1); }
</style>
