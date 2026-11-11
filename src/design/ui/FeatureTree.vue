<script setup lang="ts">
/**
 * Orca's feature tree (DesignRowList): the pinned Origin / Bed rows, then one flat row per
 * feature — type icon, name (dimmed when suppressed, red when it fails), eye (suppress) and a
 * menu (rename, move, suppress, delete). Click selects; Ctrl/Cmd+click and Shift+click build a
 * multi-selection that suppresses, unsuppresses or deletes together (one rebuild, one undo
 * step) — the way to repair a design that doesn't rebuild.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { ContextMenuItem } from '@nuxt/ui';
import { deleteFeatures, moveFeature, renameFeature, selectFeature, setSuppressed } from '../commands';
import { FEATURE_ICONS } from '../fields';
import { design, editBlocker } from '../session';
import { beginSketch } from '../sketch/session';
import { designUi } from '../state';
import { toast } from '../../ui';

const editable = computed(() => !editBlocker());
const selected = computed(() => new Set(designUi.selected));
const multi = computed(() => designUi.selected.filter((i) => design.features[i]));
const conflicts = computed(() => new Map(design.mateConflicts.map((m) => [m.feature, m.reason])));
const report = (p: Promise<unknown>) => { p.catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); };

function errorOf(i: number): string {
  return design.featureErrors[i] || (design.failing?.index === i ? design.failing.error : '') || conflicts.value.get(i) || '';
}

function onRow(i: number, e: MouseEvent) {
  selectFeature(i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
}

const allSuppressed = computed(() => multi.value.length > 0 && multi.value.every((i) => !design.features[i].enabled));
function toggleSelection() { report(setSuppressed(multi.value, !allSuppressed.value)); }

function rowMenu(i: number): ContextMenuItem[][] {
  const f = design.features[i];
  const many = selected.value.has(i) && multi.value.length > 1 ? multi.value : [i];
  const off = many.every((k) => !design.features[k].enabled);
  return [
    [...(f.type === 'Sketch' ? [{ label: 'Edit sketch', icon: 'i-lucide-pen-tool', disabled: !editable.value || many.length > 1, onSelect: () => { void beginSketch({ feature: i }); } }] : []),
      { label: 'Rename', icon: 'i-lucide-text-cursor-input', kbds: ['f2'], disabled: !editable.value || many.length > 1, onSelect: () => startRename(i) },
      // Touch has no Ctrl+click: build a multi-selection from the menu.
      { label: selected.value.has(i) ? 'Remove from selection' : 'Add to selection', icon: selected.value.has(i) ? 'i-lucide-square-minus' : 'i-lucide-square-plus',
        onSelect: () => selectFeature(i, { toggle: true }) }],
    [
      { label: 'Move up', icon: 'i-lucide-arrow-up', disabled: !editable.value || i === 0 || many.length > 1, onSelect: () => report(moveFeature(i, -1)) },
      { label: 'Move down', icon: 'i-lucide-arrow-down', disabled: !editable.value || i === design.features.length - 1 || many.length > 1, onSelect: () => report(moveFeature(i, 1)) },
      { label: off ? (many.length > 1 ? `Unsuppress ${many.length} features` : 'Unsuppress') : (many.length > 1 ? `Suppress ${many.length} features` : 'Suppress'),
        icon: off ? 'i-lucide-eye' : 'i-lucide-eye-off', disabled: !editable.value, onSelect: () => report(setSuppressed(many, !off)) },
    ],
    [{ label: many.length > 1 ? `Delete ${many.length} features` : `Delete ${f.name}`, icon: 'i-lucide-trash-2', color: 'error' as const, kbds: ['delete'], disabled: !editable.value,
      onSelect: () => report(deleteFeatures(many)) }],
  ];
}

// ---- inline rename (F2 / menu) ----
const draft = ref('');
const renameEl = ref<{ inputRef?: HTMLInputElement } | null>(null);
function startRename(i: number) { designUi.renaming = i; }
/** Double-click: a Sketch opens in the sketcher (Orca: double-click a stroke edits the sketch), others rename. */
function onDbl(i: number) {
  if (design.features[i]?.type === 'Sketch' && editable.value) { void beginSketch({ feature: i }); return; }
  startRename(i);
}
watch(() => designUi.renaming, async (i) => {
  if (i === null) return;
  draft.value = design.features[i]?.name ?? '';
  await nextTick();
  renameEl.value?.inputRef?.select();
});
function commitRename() {
  const i = designUi.renaming;
  designUi.renaming = null;
  if (i !== null) report(renameFeature(i, draft.value));
}

// Keep the selected row in view (selection from the viewport / Edit in Design).
const listEl = ref<HTMLElement | null>(null);
watch(() => designUi.selected.at(-1), async (i) => {
  if (i === undefined) return;
  await nextTick();
  listEl.value?.querySelector<HTMLElement>(`[data-feature="${i}"]`)?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <section class="ft" aria-label="Feature tree">
    <header class="ds-head">
      <span class="ds-head__title">Feature tree</span>
      <span class="ds-head__count">{{ design.features.length }}</span>
      <span class="flex-1" />
      <template v-if="multi.length > 1">
        <UTooltip :text="allSuppressed ? 'Unsuppress the selected features (one rebuild)' : 'Suppress the selected features (one rebuild)'">
          <UButton size="xs" color="neutral" variant="ghost" :icon="allSuppressed ? 'i-lucide-eye' : 'i-lucide-eye-off'" :label="String(multi.length)"
                   :disabled="!editable" :aria-label="allSuppressed ? `Unsuppress ${multi.length} features` : `Suppress ${multi.length} features`"
                   data-testid="design-suppress-selected" @click="toggleSelection" />
        </UTooltip>
        <UTooltip text="Delete the selected features">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="!editable" :aria-label="`Delete ${multi.length} features`" @click="report(deleteFeatures(multi))" />
        </UTooltip>
      </template>
      <template v-else-if="multi.length === 1">
        <UTooltip text="Move up" :kbds="['alt', 'arrowup']">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-up" aria-label="Move up" :disabled="!editable || multi[0] === 0" @click="report(moveFeature(multi[0], -1))" />
        </UTooltip>
        <UTooltip text="Move down" :kbds="['alt', 'arrowdown']">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-down" aria-label="Move down" :disabled="!editable || multi[0] === design.features.length - 1" @click="report(moveFeature(multi[0], 1))" />
        </UTooltip>
      </template>
    </header>

    <ul ref="listEl" class="ft__list" role="listbox" aria-multiselectable="true" aria-label="Features">
      <li class="ft__row ft__row--pinned">
        <UIcon name="i-lucide-axis-3d" class="ft__icon" />
        <span class="ft__name">Origin</span>
        <UButton :icon="designUi.showOrigin ? 'i-lucide-eye' : 'i-lucide-eye-off'" size="xs" variant="ghost" color="neutral" class="ft__eye"
                 :aria-label="designUi.showOrigin ? 'Hide the origin planes' : 'Show the origin planes'" :aria-pressed="designUi.showOrigin"
                 @click="designUi.showOrigin = !designUi.showOrigin" />
      </li>
      <li class="ft__row ft__row--pinned">
        <UIcon name="i-lucide-grid-2x2" class="ft__icon" />
        <span class="ft__name">Bed</span>
        <UButton :icon="designUi.showBed ? 'i-lucide-eye' : 'i-lucide-eye-off'" size="xs" variant="ghost" color="neutral" class="ft__eye"
                 :aria-label="designUi.showBed ? 'Hide the bed' : 'Show the bed'" :aria-pressed="designUi.showBed" @click="designUi.showBed = !designUi.showBed" />
      </li>
      <UContextMenu v-for="f in design.features" :key="f.index" :items="rowMenu(f.index)">
        <li class="ft__row" :class="{ 'ft__row--sel': selected.has(f.index), 'ft__row--off': !f.enabled, 'ft__row--err': !!errorOf(f.index) }"
            :data-feature="f.index" role="option" :aria-selected="selected.has(f.index)" tabindex="-1" data-own-menu
            @click="onRow(f.index, $event)" @dblclick="onDbl(f.index)">
          <UIcon :name="FEATURE_ICONS[f.type] ?? 'i-lucide-box'" class="ft__icon" />
          <UInput v-if="designUi.renaming === f.index" ref="renameEl" v-model="draft" size="xs" class="ft__rename" aria-label="Feature name"
                  @keydown.enter.prevent="commitRename" @keydown.esc.prevent.stop="designUi.renaming = null" @blur="commitRename" @click.stop />
          <span v-else class="ft__name" :title="`${f.name} · ${f.type}${f.enabled ? '' : ' (suppressed)'}`">{{ f.name }}</span>
          <UTooltip v-if="errorOf(f.index)" :text="errorOf(f.index)">
            <UIcon name="i-lucide-triangle-alert" class="ft__erricon" :aria-label="`Fails: ${errorOf(f.index)}`" />
          </UTooltip>
          <UButton :icon="f.enabled ? 'i-lucide-eye' : 'i-lucide-eye-off'" size="xs" variant="ghost" color="neutral" class="ft__eye"
                   :class="{ 'ft__eye--off': !f.enabled }" :disabled="!editable" :aria-label="f.enabled ? `Suppress ${f.name}` : `Unsuppress ${f.name}`"
                   :aria-pressed="!f.enabled" @click.stop="report(setSuppressed([f.index], f.enabled))" />
          <UDropdownMenu :items="rowMenu(f.index)" :content="{ align: 'end' }">
            <UButton icon="i-lucide-ellipsis" size="xs" variant="ghost" color="neutral" class="ft__more" :aria-label="`More for ${f.name}`" @click.stop />
          </UDropdownMenu>
        </li>
      </UContextMenu>
    </ul>
  </section>
</template>

<style scoped>
.ft { display: flex; flex-direction: column; min-height: 0; }
.ft__list { list-style: none; margin: 0; padding: 2px 0; overflow: auto; min-height: 0; flex: 1 1 auto; }
.ft__row {
  display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 2px 0 8px; border-radius: var(--radius-sm);
  font-size: var(--fs-md); color: var(--fg-0); cursor: default; outline: none;
}
.ft__row:hover { background: var(--bg-2); }
.ft__row--sel { background: color-mix(in srgb, var(--ui-primary) 18%, transparent); }
.ft__row--sel:hover { background: color-mix(in srgb, var(--ui-primary) 24%, transparent); }
.ft__row--pinned { color: var(--fg-1); }
.ft__row--pinned + .ft__row:not(.ft__row--pinned) { margin-top: 3px; }
.ft__row--off .ft__name, .ft__row--off .ft__icon { opacity: 0.45; }
.ft__row--err .ft__name { color: var(--danger); }
.ft__icon { width: 15px; height: 15px; flex: none; color: var(--fg-1); }
.ft__row--sel .ft__icon { color: var(--ui-primary); }
.ft__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft__rename { flex: 1; min-width: 0; }
.ft__erricon { width: 14px; height: 14px; flex: none; color: var(--danger); }
.ft__eye, .ft__more { opacity: 0.4; }
.ft__eye--off { opacity: 0.9; color: var(--warn); }
.ft__row:hover .ft__eye, .ft__row:hover .ft__more, .ft__row--sel .ft__eye, .ft__row--sel .ft__more, .ft__row--pinned .ft__eye { opacity: 1; }
@media (pointer: coarse) { .ft__row { min-height: 40px; } .ft__eye, .ft__more { opacity: 1; } }
</style>
