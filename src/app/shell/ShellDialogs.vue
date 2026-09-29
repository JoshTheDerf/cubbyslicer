<script setup lang="ts">
/** Shortcuts help, about/source, set-number-of-instances and confirm dialogs. */
import { computed, ref, watch } from 'vue';
import { getObject, instancesOf, selectedIds, setInstanceCount } from '../../project/store';
import { CATEGORY_ORDER } from '../actions/project/palette';
import { formatBindingTokens } from '../actions/formatBinding';
import { actionsRevision, getAllActions } from '../actions/registry';
import { platform } from './useActions';
import { confirmRequest, ui } from './uiState';

interface Row { label: string; keys: string[]; note?: string }

/** Every bound, non-hidden action from the registry, grouped by category, plus mouse gestures. */
const groups = computed<Array<[string, Row[]]>>(() => {
  void actionsRevision.value;
  if (!ui.shortcutsOpen) return [];
  const m = new Map<string, Row[]>();
  for (const a of getAllActions()) {
    if (a.hidden || !a.binding) continue;
    const keys = formatBindingTokens(a.binding, platform);
    if (!keys.length) continue;
    const note = a.binding.scope === 'prepare' ? 'Prepare' : a.binding.scope === 'preview' ? 'Preview' : undefined;
    const row = { label: a.title, keys, note };
    const l = m.get(a.category);
    if (l) l.push(row); else m.set(a.category, [row]);
  }
  const ordered = [...m.entries()].sort(([a], [b]) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  ordered.push(['Mouse', [
    { label: 'Select / add to selection', keys: ['Click', 'Ctrl+click'] },
    { label: 'Box select', keys: ['Drag on empty space'] },
    { label: 'Rotate view', keys: ['Right drag'] },
    { label: 'Pan view', keys: ['Middle drag'] },
    { label: 'Zoom view', keys: ['Wheel'] },
    { label: 'Look from a side', keys: ['Click view cube'] },
    { label: 'Snap while transforming', keys: ['Hold Shift'] },
    { label: 'Object menu', keys: ['Right click'] },
  ]]);
  return ordered;
});

// Orca "Set number of instances": the total for each selected object's instance group.
const instTarget = computed(() => {
  const id = selectedIds.value.at(-1);
  const o = id ? getObject(id) : undefined;
  return o ? { name: o.name, current: instancesOf(o.id).length } : null;
});
const count = ref<number | null>(1);
watch(() => ui.instancesOpen, (v) => { if (v) count.value = Math.max(2, instTarget.value?.current ?? 1); });
function applyInstances() {
  ui.instancesOpen = false;
  setInstanceCount(selectedIds.value.slice(), Math.max(1, Math.min(500, Math.round(count.value ?? 1))));
}

const confirmOpen = computed({
  get: () => !!confirmRequest.value,
  set: (v: boolean) => { if (!v) answer(false); },
});
function answer(ok: boolean | 'alt') {
  const r = confirmRequest.value;
  confirmRequest.value = null;
  r?.resolve(ok);
}

const sourceUrl = (import.meta.env.VITE_SOURCE_URL as string | undefined) || '';
const version = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';
</script>

<template>
  <UModal v-model:open="ui.shortcutsOpen" title="Keyboard shortcuts" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <div class="sc">
        <section v-for="[g, list] in groups" :key="g">
          <h3>{{ g }}</h3>
          <dl>
            <template v-for="r in list" :key="r.label">
              <dt>{{ r.label }}<span v-if="r.note" class="sc__note">{{ r.note }}</span></dt>
              <dd><UKbd v-for="k in r.keys" :key="k" :value="k" size="sm" /></dd>
            </template>
          </dl>
        </section>
      </div>
    </template>
  </UModal>

  <UModal v-model:open="ui.aboutOpen" title="Cubby Slicer source and licence" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <div class="about text-sm">
        <p>
          Cubby Slicer is free software under the GNU Affero General Public License v3.0 or later.
          Because it runs over a network, you are entitled to its complete corresponding source.
        </p>
        <p v-if="sourceUrl">Source for this build: <ULink :href="sourceUrl" target="_blank" rel="noopener" class="text-info">{{ sourceUrl }}</ULink></p>
        <p v-else>Source for this build is available from the operator of this site on request.</p>
        <h3>Bundled slicing engines (AGPL-3.0)</h3>
        <ul>
          <li><ULink href="https://github.com/SoftFever/OrcaSlicer" target="_blank" rel="noopener" class="text-info">OrcaSlicer</ULink></li>
          <li><ULink href="https://github.com/oozebot/preFlight" target="_blank" rel="noopener" class="text-info">preFlight</ULink>, derived from
            <ULink href="https://github.com/prusa3d/PrusaSlicer" target="_blank" rel="noopener" class="text-info">PrusaSlicer</ULink></li>
        </ul>
        <p v-if="version" class="about__meta">Version {{ version }}</p>
      </div>
    </template>
  </UModal>

  <UModal v-model:open="ui.instancesOpen" title="Set number of instances" :ui="{ content: 'sm:max-w-sm' }">
    <template #body>
      <p class="text-sm text-toned mb-3">
        <template v-if="selectedIds.length > 1">Each of the {{ selectedIds.length }} selected objects will have this many instances on the plate.</template>
        <template v-else-if="instTarget"><strong class="text-highlighted">{{ instTarget.name }}</strong> has {{ instTarget.current }} instance{{ instTarget.current === 1 ? '' : 's' }}.</template>
        New instances are arranged next to the others (spilling onto the next plate when full) and share geometry, so they use almost no extra memory.
      </p>
      <UFormField label="Instances">
        <UInputNumber v-model="count" :min="1" :max="500" :step="1" aria-label="Number of instances" class="w-40" autofocus @keydown.enter="applyInstances" />
      </UFormField>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="ui.instancesOpen = false" />
        <UButton color="primary" :disabled="!selectedIds.length" label="Apply" @click="applyInstances" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="confirmOpen" :title="confirmRequest?.title ?? ''" :description="confirmRequest?.message" :ui="{ content: 'sm:max-w-md' }">
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="answer(false)" />
        <UButton v-if="confirmRequest?.altLabel" color="neutral" variant="outline" :label="confirmRequest.altLabel" @click="answer('alt')" />
        <UButton :color="confirmRequest?.danger ? 'error' : 'primary'" :label="confirmRequest?.confirmLabel" autofocus @click="answer(true)" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.sc { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 28px; }
.sc h3, .about h3 { margin: 12px 0 6px; font: 600 var(--fs-sm) var(--font); color: var(--fg-0); }
.sc section:first-child h3, .sc section:nth-child(2) h3 { margin-top: 0; }
.sc dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }
.sc dt { color: var(--fg-1); font-size: var(--fs-sm); }
.sc dd { margin: 0; text-align: right; display: flex; gap: 3px; justify-content: flex-end; flex-wrap: wrap; }
.sc__note { margin-left: 6px; font-size: var(--fs-xs); color: var(--fg-2); }
.about p { margin: 0 0 10px; }
.about ul { margin: 0; padding-left: 18px; list-style: disc; }
.about__meta { margin-top: 12px !important; font-size: var(--fs-xs); color: var(--fg-2); }
@media (max-width: 640px) { .sc { grid-template-columns: 1fr; } }
</style>
