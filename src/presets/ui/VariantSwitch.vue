<script setup lang="ts">
/**
 * The switch at the top of a settings page whose rows hold one value per
 * extruder variant (Orca 2.5 Tab: extruder switch on process / printer tabs,
 * variant switch on filament tabs, and the sync button that copies the
 * edited nozzle's changes to the other one). Picking a tag changes which
 * column every per-variant row shows and edits (presets/variantEdit.ts).
 */
import { computed } from 'vue';
import { currentPresets, variantEdit } from '../store';
import type { PresetKind } from '../types';
import { toast } from '../../ui/toast';

const props = defineProps<{ kind: PresetKind; index?: number }>();
const p = computed(() => currentPresets.value);
const tags = computed(() => p.value.variantTags(props.kind, props.index ?? 0));

const selected = computed(() => {
  if (props.kind !== 'filament') return Math.min(variantEdit.extruder, Math.max(0, tags.value.length - 1));
  const col = variantEdit.filamentColumn;
  if (col >= 0 && col < tags.value.length) return col;
  // The column the filament prints with (its extruder's flow type).
  const el = p.value.variantElement('filament', 'filament_extruder_variant', props.index ?? 0);
  return el ?? 0;
});
function pick(v: number): void {
  if (props.kind === 'filament') variantEdit.filamentColumn = v;
  else variantEdit.extruder = v;
}
const canSync = computed(() => props.kind !== 'filament' && tags.value.length === 2);
function sync(): void {
  const n = p.value.syncVariantColumns(props.kind as 'process' | 'printer');
  const other = tags.value[1 - selected.value]?.label ?? 'the other nozzle';
  if (n) toast.success(`Copied ${n} change${n > 1 ? 's' : ''} to ${other}`);
  else toast.info(`Nothing to copy: no changes on ${tags.value[selected.value]?.label ?? 'this nozzle'}`);
}
</script>

<template>
  <div v-if="tags.length > 1" class="vs" role="radiogroup" :aria-label="kind === 'filament' ? 'Nozzle variant' : 'Extruder'">
    <UTooltip text="Settings marked per nozzle hold one value for each extruder and nozzle flow type. Pick which one you edit.">
      <UIcon name="i-lucide-git-fork" class="vs__icon" />
    </UTooltip>
    <div class="vs__tags">
      <UButton v-for="t in tags" :key="t.value" size="xs" role="radio" :aria-checked="selected === t.value" :title="t.title"
               :variant="selected === t.value ? 'soft' : 'ghost'" :color="selected === t.value ? 'primary' : 'neutral'" @click="pick(t.value)">
        {{ t.label }}<span v-if="t.modified" class="vs__mod" aria-label="modified" />
      </UButton>
    </div>
    <UButton v-if="canSync" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" :title="`Copy the changes on ${tags[selected]?.label} to the other nozzle with the same flow type`"
             aria-label="Sync to the other nozzle" @click="sync" />
  </div>
</template>

<style scoped>
.vs { display: flex; align-items: center; gap: 6px; padding: 4px 4px 6px; border-bottom: 1px solid var(--ui-border); }
.vs__icon { width: 16px; height: 16px; color: var(--ui-primary); flex: none; }
.vs__tags { display: flex; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0; }
.vs__mod { width: 6px; height: 6px; border-radius: 50%; background: var(--modified); margin-left: 4px; display: inline-block; }
</style>
