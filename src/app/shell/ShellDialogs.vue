<script setup lang="ts">
/** Shortcuts help, about/source, set number of instances, primitive size and the app's confirm dialog. */
import { computed, reactive, ref, watch } from 'vue';
import { getObject, instancesOf, selectedIds, setInstanceCount } from '../../project/store';
import { CATEGORY_ORDER } from '../actions/project/palette';
import { formatBindingTokens } from '../actions/formatBinding';
import { actionsRevision, getAllActions } from '../actions/registry';
import { platform } from './useActions';
import { confirmDialog } from './uiState';
import { primitiveOptions, primitiveSizeDialog } from './commands/parts';
import { dialogs } from '../../dialogs/state';
import { preferences } from '../preferences';
import AppDialog from '../../ui/AppDialog.vue';
import { PRIMITIVE_LABELS } from '../../project/primitives';
import { PART_TYPE_LABELS } from '../../project/types';

interface Row { label: string; keys: string[]; note?: string }

/** Every bound, non-hidden action from the registry, grouped by category, plus mouse gestures. */
const groups = computed<Array<[string, Row[]]>>(() => {
  void actionsRevision.value;
  if (!dialogs.shortcuts) return [];
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
/** Filter by command name, group or key ("ctrl", "shift+d"). */
const scFilter = ref('');
watch(() => dialogs.shortcuts, (o) => { if (o) scFilter.value = ''; });
const shownGroups = computed(() => {
  const q = scFilter.value.trim().toLowerCase();
  if (!q) return groups.value;
  const out: Array<[string, Row[]]> = [];
  for (const [g, list] of groups.value) {
    const rows = g.toLowerCase().includes(q) ? list
      : list.filter((r) => r.label.toLowerCase().includes(q) || r.keys.join('+').toLowerCase().includes(q.replace(/\s+/g, '')) || r.note?.toLowerCase().includes(q));
    if (rows.length) out.push([g, rows]);
  }
  return out;
});

// Orca "Set number of instances": the total for each selected object's instance group.
const instTarget = computed(() => {
  const id = selectedIds.value.at(-1);
  const o = id ? getObject(id) : undefined;
  return o ? { name: o.name, current: instancesOf(o.id).length } : null;
});
const count = ref<number | null>(1);
watch(() => dialogs.instances, (v) => { if (v) count.value = Math.max(2, instTarget.value?.current ?? 1); });
function applyInstances() {
  dialogs.instances = false;
  setInstanceCount(selectedIds.value.slice(), Math.max(1, Math.min(500, Math.round(count.value ?? 1))));
}

// The confirm dialog (confirmAction / chooseAction / askConfirm, and the AI agent's print confirms).
const confirmReq = confirmDialog.current;
const checked = ref(false);
watch(confirmReq, () => { checked.value = false; });
const answer = (choice: 'confirm' | 'alt' | null) => confirmDialog.answer({ choice, checked: checked.value });

// Orca 2.5 primitive size dialog: the bounding box of the shape to add.
const primReq = primitiveSizeDialog.current;
const prim = reactive({ size: [10, 10, 10] as [number, number, number], uniform: true, saveDefault: false, dontAsk: false });
watch(primReq, (r) => { if (r) Object.assign(prim, { size: [...r.size], uniform: true, saveDefault: false, dontAsk: false }); });
/** Fields per shape: round shapes take a diameter (X = Y), a sphere one value. */
const primFields = computed<Array<{ label: string; axes: number[] }>>(() => {
  switch (primReq.value?.kind) {
    case 'cylinder': return [{ label: 'Diameter', axes: [0, 1] }, { label: 'Height', axes: [2] }];
    case 'sphere': return [{ label: 'Diameter', axes: [0, 1, 2] }];
    default: return [{ label: 'X', axes: [0] }, { label: 'Y', axes: [1] }, { label: 'Z', axes: [2] }];
  }
});
function setPrimSize(axes: number[], v: number | null): void {
  if (v == null || !(v > 0)) return;
  const old = prim.size[axes[0]];
  const k = old > 0 ? v / old : 1;
  prim.size = prim.size.map((x, i) => (axes.includes(i) ? v : prim.uniform ? Math.round(x * k * 100) / 100 : x)) as [number, number, number];
}
function addPrimitive(): void {
  const r = primReq.value;
  if (!r) return;
  if (prim.saveDefault) primitiveOptions.sizes[r.kind] = [...prim.size];
  if (prim.dontAsk) preferences.askPrimitiveSize = false;
  primitiveSizeDialog.answer([...prim.size]);
}

const sourceUrl = (import.meta.env.VITE_SOURCE_URL as string | undefined) || '';
const version = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';
</script>

<template>
  <AppDialog v-model:open="dialogs.shortcuts" title="Keyboard shortcuts" size="3xl">
    <UInput v-model="scFilter" icon="i-lucide-search" size="sm" placeholder="Find a command or key…" spellcheck="false" autofocus
            aria-label="Find a shortcut" class="mb-3 w-full sm:w-72" />
    <!-- A steady height, so the dialog doesn't jump while the list narrows. -->
    <div class="sc__body">
      <p v-if="!shownGroups.length" class="text-sm text-dimmed">No shortcut matches “{{ scFilter }}”.</p>
      <div class="sc">
        <section v-for="[g, list] in shownGroups" :key="g">
          <h3>{{ g }}</h3>
          <dl>
            <template v-for="r in list" :key="r.label">
              <dt>{{ r.label }}<span v-if="r.note" class="sc__note">{{ r.note }}</span></dt>
              <dd><UKbd v-for="k in r.keys" :key="k" :value="k" size="sm" /></dd>
            </template>
          </dl>
        </section>
      </div>
    </div>
  </AppDialog>

  <AppDialog v-model:open="dialogs.about" title="CubbySlicer source and licence" size="lg">
    <div class="about text-sm">
      <p>
        CubbySlicer is free software under the GNU Affero General Public License v3.0 or later.
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
  </AppDialog>

  <AppDialog v-model:open="dialogs.instances" title="Set number of instances" size="sm"
             confirm-label="Apply" :confirm-disabled="!selectedIds.length" @confirm="applyInstances">
    <p class="text-sm text-toned mb-3">
      <template v-if="selectedIds.length > 1">Each of the {{ selectedIds.length }} selected objects will have this many instances on the plate.</template>
      <template v-else-if="instTarget"><strong class="text-highlighted">{{ instTarget.name }}</strong> has {{ instTarget.current }} instance{{ instTarget.current === 1 ? '' : 's' }}.</template>
      New instances are arranged next to the others (spilling onto the next plate when full) and share geometry, so they use almost no extra memory.
    </p>
    <UFormField label="Instances">
      <UInputNumber v-model="count" :min="1" :max="500" :step="1" aria-label="Number of instances" class="w-40" autofocus @keydown.enter="applyInstances" />
    </UFormField>
  </AppDialog>

  <AppDialog v-model:open="primitiveSizeDialog.open.value" size="sm"
             :title="primReq ? `${PART_TYPE_LABELS[primReq.type]}: ${PRIMITIVE_LABELS[primReq.kind].toLowerCase()}` : ''"
             description="Size of the shape, in mm." confirm-label="Add" @confirm="addPrimitive">
    <div class="prim">
      <UFormField v-for="f in primFields" :key="f.label" :label="f.label">
        <UInputNumber :model-value="prim.size[f.axes[0]]" :min="0.01" :max="10000" :step="1" :step-snapping="false"
                      :format-options="{ maximumFractionDigits: 2 }" :aria-label="`${f.label} (mm)`" class="w-full"
                      @update:model-value="(v: number | null) => setPrimSize(f.axes, v)" @keydown.enter="addPrimitive" />
      </UFormField>
    </div>
    <div class="mt-3 flex flex-col gap-2">
      <UCheckbox v-if="primFields.length > 1" v-model="prim.uniform" label="Uniform scale" />
      <UCheckbox v-model="prim.saveDefault" label="Save these settings as default" />
      <UCheckbox v-model="prim.dontAsk" label="Don’t show again" description="Bring it back with “Show options when adding a primitive” in the command palette." />
    </div>
  </AppDialog>

  <AppDialog v-model:open="confirmDialog.open.value" :title="confirmReq?.title ?? ''" :description="confirmReq?.message" size="md" on-top
             :dismissible="confirmReq?.dismissible !== false" :confirm-label="confirmReq?.confirmLabel" :confirm-color="confirmReq?.danger ? 'error' : 'primary'"
             :cancel-label="confirmReq?.cancelLabel ?? 'Cancel'"
             confirm-autofocus :test-id="confirmReq?.testId" @confirm="answer('confirm')" @cancel="answer(null)">
    <template v-if="confirmReq?.checkLabel" #default>
      <UCheckbox v-model="checked" :label="confirmReq.checkLabel" :data-testid="confirmReq.testId ? `${confirmReq.testId}-always` : undefined" />
    </template>
    <template v-if="confirmReq?.altLabel" #footer-end>
      <UButton color="neutral" variant="outline" :label="confirmReq.altLabel" @click="answer('alt')" />
    </template>
  </AppDialog>
</template>

<style scoped>
.sc__body { min-height: min(560px, 60vh); }
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
.prim { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; }
@media (max-width: 640px) { .sc { grid-template-columns: 1fr; } }
</style>
