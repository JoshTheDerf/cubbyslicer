<script setup lang="ts">
/**
 * The Design tab's side panel (Orca's dockable sidebar, top to bottom): document notices
 * (read-only, doesn't rebuild), the selected feature's parameters, the feature tree, bodies and
 * variables. On phones the sections are tabs (one at a time) instead of one long scroll.
 */
import { computed } from 'vue';
import { run } from '../../app/shell/useActions';
import { setSuppressed } from '../commands';
import { design, projectHasDesign } from '../session';
import { designUi, editedFeature } from '../state';
import FeatureTree from './FeatureTree.vue';
import FeatureEditor from './FeatureEditor.vue';
import FeatureCard from './FeatureCard.vue';
import { card } from '../create';
import SketchPanel from './SketchPanel.vue';
import { sk } from '../sketch/session';
import BodiesList from './BodiesList.vue';
import VariablesTable from './VariablesTable.vue';
import { toast } from '../../ui';
import { touch } from '../../app/shell/uiState';

const props = defineProps<{ phone?: boolean }>();

const failingName = computed(() => (design.failing ? design.features[design.failing.index]?.name ?? `feature ${design.failing.index + 1}` : ''));
const menu = computed(() => [[
  { label: 'Add shape…', icon: 'i-lucide-shapes', disabled: design.phase !== 'open' || design.readOnly, onSelect: () => run('cad.palette') },
  { label: 'Import STEP…', icon: 'i-lucide-file-input', disabled: design.readOnly, onSelect: () => run('design.import-step') },
  { label: 'Import mesh…', icon: 'i-lucide-box', disabled: design.readOnly, onSelect: () => run('design.import-mesh') },
  { label: 'Export STEP…', icon: 'i-lucide-file-output', disabled: !design.bodies.some((b) => b.face_count > 0), onSelect: () => run('design.export-step') },
], [
  { label: 'Clear design…', icon: 'i-lucide-eraser', color: 'error' as const, disabled: !projectHasDesign() || design.readOnly, onSelect: () => run('design.clear') },
]]);
const sections = [
  { value: 'features', label: 'Features' },
  { value: 'bodies', label: 'Bodies' },
  { value: 'variables', label: 'Variables' },
];
const show = (s: 'features' | 'bodies' | 'variables') => !props.phone || designUi.phoneSection === s;
function suppressFailing() {
  if (design.failing) setSuppressed([design.failing.index], true).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
}
</script>

<template>
  <div class="dp" :class="{ 'dp--phone': phone }">
    <header v-if="!phone" class="dp__head">
      <UIcon name="i-lucide-pencil-ruler" class="dp__logo" />
      <span class="dp__title">Design</span>
      <UBadge label="Experimental" color="warning" variant="subtle" size="sm" />
      <span class="flex-1" />
      <UDropdownMenu :items="menu" :content="{ align: 'end' }">
        <UButton icon="i-lucide-ellipsis-vertical" size="xs" color="neutral" variant="ghost" aria-label="Design menu" />
      </UDropdownMenu>
    </header>

    <div v-if="design.phase === 'open' && design.readOnly" class="dp__notice dp__notice--warn" role="status">
      <UIcon name="i-lucide-lock" class="size-4 flex-none" />
      <p><strong>Read-only.</strong> This design was {{ design.readOnlyReason || 'saved with a newer version of the Design tab' }}. It is shown and saved back unchanged.</p>
    </div>
    <div v-else-if="design.phase === 'open' && !design.ok" class="dp__notice dp__notice--err" role="alert" data-testid="design-failing">
      <UIcon name="i-lucide-triangle-alert" class="size-4 flex-none" />
      <div class="min-w-0">
        <p><strong>This design doesn’t rebuild</strong> — {{ design.error }}.</p>
        <p v-if="design.failing">
          The first feature that fails is <strong>{{ failingName }}</strong>. Suppress it, or select every failing feature
          ({{ touch ? '⋯ ▸ Add to selection' : 'Ctrl+click' }}) and suppress them together.
        </p>
        <p v-else-if="design.diagnosing" class="dp__muted"><UIcon name="i-lucide-loader-circle" class="size-3 animate-spin align-[-1px]" /> Finding the failing feature…</p>
        <UButton v-if="design.failing" size="xs" color="error" variant="soft" icon="i-lucide-eye-off" :label="`Suppress ${failingName}`" class="mt-1.5" @click="suppressFailing" />
      </div>
    </div>

    <UTabs v-if="phone" v-model="designUi.phoneSection" :items="sections" :content="false" size="sm" color="neutral" class="dp__tabs" />

    <div class="dp__body">
      <SketchPanel v-if="show('features') && sk.open" class="dp__card" />
      <FeatureCard v-else-if="show('features') && card.tool" class="dp__card" />
      <FeatureEditor v-else-if="show('features') && editedFeature() !== null" class="dp__card" />
      <FeatureTree v-if="show('features')" class="dp__tree" />
      <BodiesList v-if="show('bodies')" class="dp__sec" />
      <p v-if="phone && show('bodies') && !design.bodies.length" class="dp__muted dp__pad">No bodies.</p>
      <VariablesTable v-if="show('variables')" class="dp__sec" />
    </div>
  </div>
</template>

<style scoped>
.dp { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1); }
.dp__head { display: flex; align-items: center; gap: 8px; height: 40px; flex: none; padding: 0 6px 0 12px; border-bottom: 1px solid var(--line); }
.dp__logo { width: 16px; height: 16px; color: var(--ui-primary); }
.dp__title { font: 600 var(--fs-lg) var(--font); color: var(--fg-0); }
.dp__notice { display: flex; gap: 8px; margin: 8px 8px 0; padding: 8px 10px; border-radius: var(--radius); font-size: var(--fs-sm); line-height: 1.4; color: var(--fg-0); }
.dp__notice p { margin: 0; overflow-wrap: anywhere; }
.dp__notice p + p { margin-top: 4px; }
.dp__notice--warn { background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
.dp__notice--warn > :first-child { color: var(--warn); }
.dp__notice--err { background: color-mix(in srgb, var(--danger) 12%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); }
.dp__notice--err > :first-child { color: var(--danger); margin-top: 1px; }
.dp__muted { color: var(--fg-2); font-size: var(--fs-sm); }
.dp__pad { padding: 8px 12px; margin: 0; }
.dp__tabs { padding: 6px 8px 0; flex: none; }
.dp__body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 8px 6px 12px; }
.dp__card { flex: none; margin: 0 2px; }
.dp__tree { flex: 0 1 auto; min-height: 120px; }
.dp__sec { flex: none; }
.dp :deep(.ds-head) { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 0 2px 0 8px; }
.dp :deep(.ds-head__title) { font: 600 var(--fs-xs) var(--font); letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-1); }
.dp :deep(.ds-head__count) { font-size: var(--fs-xs); color: var(--fg-2); }
</style>
