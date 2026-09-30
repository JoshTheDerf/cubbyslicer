<script setup lang="ts">
/**
 * Plate object list (Orca's object list, shown by the settings sidebar in its
 * Process "Objects" mode via the `#objects` slot). Instances (objects sharing
 * a mesh) are grouped under a collapsible parent row. Click / Ctrl-click / Shift-click select; double-
 * click or F2 renames; right-click opens the object context menu.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  activePlate, getMesh, objectIssues, objectPlate, objects, overrideCount, plates, removePart, renameObject, renamePart, select,
  selectedIds, selectedPart, setActivePlate, setPartType, setPrintable, setVisible,
} from '../../project/store';
import { PART_TYPE_LABELS, type ObjectPart, type PartType } from '../../project/types';
import { plateLabel } from '../../project/plates';
import { ISSUE_LABELS } from '../../project/validate';
import type { ProjectObject } from '../../project/types';
import type { DropdownMenuItem } from '@nuxt/ui';
import { OBJECT_CONTEXT_MENU } from '../actions/layouts/menus';
import { menuItems, run, toNuxtItems } from './useActions';
import { revealObjectSettings, selectPlate } from './actions';
import { ui } from './uiState';
import { clickLayerRow, isLayerRowSelected, LAYER_ROW_ICONS, layerRowLabel, layerRowMenu, layerRowsOf, type LayerRow, type LayerRowKind } from '../../layers/objectList';
import { selectedRange } from '../../layers/store';
import { nodeIcon } from '../../cad/tree';
import type { LayerRange } from '../../project/types';

const collapsed = reactive(new Set<string>());
/** CubbyCAD shapes show their shape's icon (a hole: dashed); meshes a box. */
const objectIcon = (o: ProjectObject) => (o.cad ? (o.cad.node.contribution === 'subtract' ? 'i-lucide-circle-dashed' : nodeIcon(o.cad.node)) : 'i-lucide-box');
const anchor = ref<string | null>(null);
const listEl = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
// Projected when opened, after the row under the pointer has been selected.
const menuPart = ref<{ objectId: string; part: ObjectPart } | null>(null);
const menuLayer = ref<LayerRow | null>(null);
const menuNuxt = computed(() => {
  if (!menuOpen.value) return [];
  if (menuLayer.value) return layerRowMenu(menuLayer.value, revealObjectSettings);
  return menuPart.value ? partMenu(menuPart.value.objectId, menuPart.value.part) : toNuxtItems(menuItems(OBJECT_CONTEXT_MENU));
});

const PART_ICONS: Record<PartType, string> = {
  part: 'i-lucide-box', negative: 'i-lucide-box-select', modifier: 'i-lucide-sliders-horizontal',
  support_blocker: 'i-lucide-shield-off', support_enforcer: 'i-lucide-shield-plus',
};

/** Right-click on a part row: type, rename, settings, delete (Orca's part context menu). */
function partMenu(objectId: string, part: ObjectPart): DropdownMenuItem[][] {
  return [
    [{ label: 'Change type', icon: 'i-lucide-replace', children: [(Object.keys(PART_TYPE_LABELS) as PartType[]).map((t) => ({
      label: PART_TYPE_LABELS[t], icon: PART_ICONS[t], type: 'checkbox' as const, checked: part.type === t,
      onSelect: () => setPartType(objectId, part.id, t),
    }))] },
    { label: 'Rename', icon: 'i-lucide-text-cursor-input', onSelect: () => { renamingPart.value = part.id; } },
    { label: part.type === 'modifier' ? 'Modifier settings' : 'Part settings', icon: 'i-lucide-sliders-horizontal',
      onSelect: () => { pickPart(objectId, part.id); revealObjectSettings(); } }],
    [{ label: 'Delete part', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => removePart(objectId, part.id) }],
  ];
}

function pickPart(objectId: string, partId: string): void {
  select([objectId]);
  selectedPart.value = { objectId, partId };
  selectedRange.value = null;
}

interface Row {
  kind: 'object' | 'group' | 'plate' | 'part' | LayerRowKind;
  /** 'part' rows: the part. */
  part?: ObjectPart;
  /** 'range' rows: the height range. */
  range?: LayerRange;
  key: string;
  obj: ProjectObject;
  depth: number;
  count?: number;
  ids?: string[];
  /** 'plate' rows: plate index (-1 = objects on no plate). */
  plate?: number;
}

/** Instance groups (objects sharing a mesh) → rows at `depth`. */
function objectRows(list: ProjectObject[], depth: number, scope: string): Row[] {
  const groups = new Map<string, ProjectObject[]>();
  for (const o of list) {
    const g = groups.get(o.meshId);
    if (g) g.push(o); else groups.set(o.meshId, [o]);
  }
  const out: Row[] = [];
  const withParts = (o: ProjectObject, d: number) => {
    out.push({ kind: 'object', key: o.id, obj: o, depth: d });
    for (const p of o.parts ?? []) out.push({ kind: 'part', key: `${o.id}/${p.id}`, obj: o, part: p, depth: d + 1 });
    out.push(...layerRowsOf(o, d + 1, collapsed));
  };
  for (const [meshId, members] of groups) {
    if (members.length === 1) { withParts(members[0], depth); continue; }
    const gkey = `${scope}:${meshId}`;
    out.push({ kind: 'group', key: `g:${gkey}`, obj: members[0], depth, count: members.length, ids: members.map((o) => o.id) });
    if (!collapsed.has(gkey)) for (const o of members) withParts(o, depth + 1);
  }
  return out;
}

// With several plates (or objects off every plate), objects are listed under their plate like Orca's list.
const byPlate = computed(() => plates.value.length > 1 || [...objectPlate.value.values()].some((p) => p < 0));
const rows = computed<Row[]>(() => {
  if (!byPlate.value) return objectRows(objects.value, 0, 'all');
  const lists = new Map<number, ProjectObject[]>();
  for (const o of objects.value) {
    const p = objectPlate.value.get(o.id) ?? -1;
    const l = lists.get(p);
    if (l) l.push(o); else lists.set(p, [o]);
  }
  const out: Row[] = [];
  const order = [...plates.value.keys(), ...(lists.has(-1) ? [-1] : [])];
  for (const p of order) {
    const list = lists.get(p) ?? [];
    const key = `p:${p}`;
    out.push({ kind: 'plate', key, obj: list[0] ?? objects.value[0], depth: 0, plate: p, count: list.length, ids: list.map((o) => o.id) });
    if (!collapsed.has(key)) out.push(...objectRows(list, 1, key));
  }
  return out;
});

const flatIds = computed(() => rows.value.filter((r) => r.kind === 'object').map((r) => r.obj.id));
const sel = computed(() => new Set(selectedIds.value));

function issuesOf(id: string): string {
  const l = objectIssues.value.get(id);
  return l ? l.map((i) => ISSUE_LABELS[i]).join('\n') : '';
}
const blocking = (id: string) => !!objectIssues.value.get(id)?.some((i) => i !== 'overlap');

function clickRow(r: Row, e: MouseEvent) {
  if (ui.renamingId || renamingPart.value) return;
  if (r.kind === 'part') { pickPart(r.obj.id, r.part!.id); return; }
  if (selectedPart.value) selectedPart.value = null;
  if (r.kind === 'layers' || r.kind === 'range' || r.kind === 'vlh') { clickLayerRow(r as LayerRow); return; }
  if (selectedRange.value) selectedRange.value = null;
  if (r.kind === 'plate') {
    if (r.plate! >= 0) selectPlate(r.plate!);
    if (e.ctrlKey || e.metaKey) select(r.ids!, 'add');
    return;
  }
  if (r.kind === 'group') {
    select(r.ids!, e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    return;
  }
  const id = r.obj.id;
  if (e.shiftKey && anchor.value) {
    const a = flatIds.value.indexOf(anchor.value), b = flatIds.value.indexOf(id);
    if (a >= 0 && b >= 0) { select(flatIds.value.slice(Math.min(a, b), Math.max(a, b) + 1), e.ctrlKey || e.metaKey ? 'add' : 'replace'); return; }
  }
  select([id], e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
  anchor.value = id;
}

/** Right-click: select the row (UContextMenu then opens at the pointer). */
function selectForMenu(r: Row) {
  menuPart.value = r.kind === 'part' ? { objectId: r.obj.id, part: r.part! } : null;
  menuLayer.value = r.kind === 'layers' || r.kind === 'range' || r.kind === 'vlh' ? (r as LayerRow) : null;
  if (menuLayer.value) { if (r.kind === 'range') clickLayerRow(r as LayerRow); else if (!sel.value.has(r.obj.id)) select([r.obj.id]); return; }
  if (r.kind === 'part') { pickPart(r.obj.id, r.part!.id); return; }
  if (r.kind === 'plate') { if (r.plate! >= 0) setActivePlate(r.plate!); if (r.ids!.length) select(r.ids!); }
  else if (r.kind === 'group') select(r.ids!);
  else if (!sel.value.has(r.obj.id)) select([r.obj.id]);
}

function onKey(e: KeyboardEvent) {
  if (ui.renamingId) return;
  const ids = flatIds.value;
  if (!ids.length) return;
  const cur = selectedIds.value.at(-1);
  const i = cur ? ids.indexOf(cur) : -1;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    select([n], e.shiftKey ? 'add' : 'replace');
    anchor.value = n;
  }
}

// ---- rename ----
const renamingPart = ref<string | null>(null);
const partDraft = ref('');
watch(renamingPart, async (id) => {
  if (!id) return;
  partDraft.value = rows.value.find((r) => r.part?.id === id)?.part?.name ?? '';
  await nextTick();
  const input = listEl.value?.querySelector<HTMLInputElement>('.ol__rename input');
  input?.focus(); input?.select();
});
function commitPartRename(objectId: string) {
  const id = renamingPart.value;
  renamingPart.value = null;
  if (id && partDraft.value.trim()) renamePart(objectId, id, partDraft.value);
  listEl.value?.focus();
}
const draft = ref('');
watch(() => ui.renamingId, async (id) => {
  if (!id) return;
  draft.value = objects.value.find((o) => o.id === id)?.name ?? '';
  await nextTick();
  const input = listEl.value?.querySelector<HTMLInputElement>('.ol__rename input');
  input?.focus();
  input?.select();
});
function commitRename() {
  const id = ui.renamingId;
  ui.renamingId = null;
  if (id && draft.value.trim()) renameObject(id, draft.value);
  listEl.value?.focus();
}
function cancelRename() { ui.renamingId = null; listEl.value?.focus(); }

/** Collapse key of a group / plate row. */
const foldKey = (r: Row) => (r.kind === 'group' ? r.key.slice(2) : r.key);
function toggleGroup(key: string) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
}

function revealSettings(id: string) { select([id]); revealObjectSettings(); }

const tris = (o: ProjectObject) => (getMesh(o.meshId)?.triangleCount ?? 0).toLocaleString();

// Keep the selected row in view when selection changes from the viewport.
onMounted(() => { ui.objectListMounts++; });
onBeforeUnmount(() => { ui.objectListMounts--; });

watch(selectedIds, async (ids) => {
  await nextTick();
  const id = ids.at(-1);
  if (!id) return;
  listEl.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <section class="ol" data-object-list>
    <header class="ol__head">
      <h2>Objects</h2>
      <UBadge v-if="objects.length" color="neutral" variant="subtle" size="sm" :label="String(objects.length)" />
      <span class="ol__spacer" />
      <UTooltip text="Import model" :kbds="['Ctrl', 'I']">
        <UButton icon="i-lucide-file-input" color="neutral" variant="ghost" size="xs" aria-label="Import model…" @click="run('file.import')" />
      </UTooltip>
    </header>

    <div v-if="!objects.length" class="ol__empty">
      <p>Nothing on the plate yet.</p>
      <UButton size="xs" icon="i-lucide-file-input" label="Import model…" color="neutral" variant="outline" @click="run('file.import')" />
    </div>

    <UContextMenu v-else v-model:open="menuOpen" :items="menuNuxt" :ui="{ content: 'min-w-52' }">
      <div ref="listEl" class="ol__list" data-own-menu role="listbox" aria-label="Plate objects" aria-multiselectable="true" tabindex="0" @keydown="onKey">
        <div v-for="r in rows" :key="r.key" class="ol__row"
             :class="{
               'ol__row--sel': r.kind === 'range' ? isLayerRowSelected(r as LayerRow) : r.kind === 'part' ? selectedPart?.partId === r.part!.id
                 : r.kind === 'object' ? sel.has(r.obj.id) && !(selectedPart && selectedPart.objectId === r.obj.id) && !(selectedRange && selectedRange.objectId === r.obj.id) : r.kind === 'group' && r.ids!.every((i) => sel.has(i)),
               'ol__row--part': r.kind === 'part',
               'ol__row--group': r.kind === 'group',
               'ol__row--plate': r.kind === 'plate',
               'ol__row--active': r.kind === 'plate' && r.plate === activePlate,
               'ol__row--hidden': r.kind === 'object' && !r.obj.visible,
               'ol__row--noprint': r.kind === 'object' && !r.obj.printable,
             }"
             :style="{ paddingLeft: `${6 + r.depth * 18}px` }"
             :data-id="r.kind === 'object' ? r.obj.id : undefined"
             role="option" :aria-selected="r.kind === 'object' ? sel.has(r.obj.id) : undefined"
             @click="clickRow(r, $event)" @dblclick="r.kind === 'object' && (ui.renamingId = r.obj.id)"
             @contextmenu="selectForMenu(r)">
          <button v-if="r.kind === 'group' || r.kind === 'plate' || r.kind === 'layers'" type="button" class="ol__twist" :aria-label="collapsed.has(foldKey(r)) ? 'Expand' : 'Collapse'"
                  @click.stop="toggleGroup(foldKey(r))">
            <UIcon :name="collapsed.has(foldKey(r)) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" class="size-3" />
          </button>
          <UIcon :name="r.kind in LAYER_ROW_ICONS ? LAYER_ROW_ICONS[r.kind as LayerRowKind] : r.kind === 'plate' ? (r.plate! < 0 ? 'i-lucide-square-dashed' : 'i-lucide-square') : r.kind === 'group' ? 'i-lucide-boxes' : r.kind === 'part' ? PART_ICONS[r.part!.type] : objectIcon(r.obj)"
                 class="ol__icon size-3.5" :class="r.kind === 'part' ? `ol__icon--${r.part!.type}` : ''" />
          <template v-if="r.kind === 'part'">
            <UInput v-if="renamingPart === r.part!.id" v-model="partDraft" class="ol__rename flex-1 min-w-0" size="xs" :maxlength="200"
                    @click.stop @keydown.enter.prevent="commitPartRename(r.obj.id)" @keydown.esc.prevent.stop="renamingPart = null" @blur="commitPartRename(r.obj.id)" />
            <span v-else class="ol__name" :title="`${PART_TYPE_LABELS[r.part!.type]}: ${r.part!.name}`" @dblclick.stop="renamingPart = r.part!.id">{{ r.part!.name }}</span>
            <UTooltip v-if="Object.keys(r.part!.overrides).length" :text="`${Object.keys(r.part!.overrides).length} setting${Object.keys(r.part!.overrides).length > 1 ? 's' : ''}`">
              <UButton icon="i-lucide-sliders-horizontal" :label="String(Object.keys(r.part!.overrides).length)" color="warning" variant="soft" size="xs"
                       class="h-5 px-1.5 rounded-full" aria-label="Part settings" @click.stop="pickPart(r.obj.id, r.part!.id); revealObjectSettings()" />
            </UTooltip>
          </template>
          <template v-else-if="r.kind === 'layers' || r.kind === 'range' || r.kind === 'vlh'">
            <span class="ol__name ol__name--layer">{{ layerRowLabel(r as LayerRow) }}<span v-if="r.kind === 'layers'" class="ol__mult">{{ r.count }}</span></span>
            <UTooltip v-if="r.kind === 'range' && Object.keys(r.range!.overrides).length" :text="`${Object.keys(r.range!.overrides).length} setting${Object.keys(r.range!.overrides).length > 1 ? 's' : ''}`">
              <UButton icon="i-lucide-sliders-horizontal" :label="String(Object.keys(r.range!.overrides).length)" color="warning" variant="soft" size="xs"
                       class="h-5 px-1.5 rounded-full" aria-label="Range settings" @click.stop="clickLayerRow(r as LayerRow); revealObjectSettings()" />
            </UTooltip>
          </template>
          <template v-else-if="r.kind === 'plate'">
            <span class="ol__name">{{ r.plate! < 0 ? 'Outside the plates' : plateLabel(plates[r.plate!], r.plate!) }}
              <span class="ol__mult">{{ r.count }}</span></span>
            <UIcon v-if="r.plate! >= 0 && plates[r.plate!]?.locked" name="i-lucide-lock" class="size-3 text-dimmed" />
          </template>

          <template v-else>
          <UInput v-if="r.kind === 'object' && ui.renamingId === r.obj.id" v-model="draft" class="ol__rename flex-1 min-w-0" size="xs" :maxlength="200"
                  @click.stop @keydown.enter.prevent="commitRename" @keydown.esc.prevent.stop="cancelRename" @blur="commitRename" />
          <span v-else class="ol__name" :title="r.kind === 'object' ? `${r.obj.name} (${tris(r.obj)} triangles)` : r.obj.name">
            {{ r.obj.name.replace(/ \(\d+\)$/, r.kind === 'group' ? '' : '$&') }}
            <span v-if="r.kind === 'group'" class="ol__mult">×{{ r.count }}</span>
          </span>
          </template>

          <template v-if="r.kind === 'object'">
            <UTooltip v-if="objectIssues.get(r.obj.id)" :text="issuesOf(r.obj.id)">
              <UIcon name="i-lucide-triangle-alert" class="size-3.5" :class="blocking(r.obj.id) ? 'text-warning' : 'text-dimmed'" />
            </UTooltip>
            <UTooltip v-if="overrideCount(r.obj.id)" :text="`${overrideCount(r.obj.id)} per-object setting${overrideCount(r.obj.id) > 1 ? 's' : ''}`">
              <UButton icon="i-lucide-sliders-horizontal" :label="String(overrideCount(r.obj.id))" color="warning" variant="soft" size="xs"
                       class="h-5 px-1.5 rounded-full" aria-label="Per-object settings" @click.stop="revealSettings(r.obj.id)" />
            </UTooltip>
            <UTooltip :text="r.obj.visible ? 'Hide' : 'Show'">
              <UButton class="ol__tog" :class="{ 'ol__tog--off': !r.obj.visible }" :icon="r.obj.visible ? 'i-lucide-eye' : 'i-lucide-eye-off'"
                       color="neutral" variant="ghost" size="xs" :aria-label="r.obj.visible ? 'Hide' : 'Show'"
                       @click.stop="setVisible([r.obj.id], !r.obj.visible)" />
            </UTooltip>
            <UTooltip :text="r.obj.printable ? 'Printable (click to skip when slicing)' : 'Not printed (click to include)'" :kbds="['V']">
              <UButton class="ol__tog" :class="{ 'ol__tog--off': !r.obj.printable }" :icon="r.obj.printable ? 'i-lucide-printer' : 'i-lucide-ban'"
                       color="neutral" variant="ghost" size="xs" :aria-label="r.obj.printable ? 'Printable' : 'Not printed'"
                       @click.stop="setPrintable([r.obj.id], !r.obj.printable)" />
            </UTooltip>
          </template>
        </div>
      </div>
    </UContextMenu>
  </section>
</template>

<style scoped>
.ol { display: flex; flex-direction: column; min-height: 0; }
.ol__head { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 6px 0 10px; flex: none; }
.ol__head h2 { margin: 0; font: 600 var(--fs-md) var(--font); color: var(--fg-0); }
.ol__spacer { flex: 1; }
.ol__empty { padding: 4px 10px 12px; color: var(--fg-2); font-size: var(--fs-sm); }
.ol__empty p { margin: 0 0 8px; }
.ol__row--plate { font-weight: 600; color: var(--ui-text-highlighted); }
.ol__row--part { font-size: 0.95em; }
.ol__name--layer { font-size: 0.95em; }
.ol__icon--modifier { color: #f5c542; }
.ol__icon--negative { color: #8a8f98; }
.ol__icon--support_blocker { color: #ef5b5b; }
.ol__icon--support_enforcer { color: #4ea1ff; }
.ol__row--active .ol__icon { color: var(--ui-primary); }
.ol__list { flex: 1; min-height: 0; max-height: 40vh; overflow: auto; padding: 0 4px 6px; outline: none; }
.ol__list:focus-visible { box-shadow: inset var(--focus-ring); }
.ol__row {
  position: relative; display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 2px;
  border-radius: var(--radius-sm); color: var(--fg-1); cursor: default; font-size: var(--fs-md);
}
.ol__row:hover { background: var(--bg-2); }
.ol__row--sel { background: var(--accent-soft); color: var(--fg-0); }
.ol__row--sel:hover { background: var(--accent-soft); }
.ol__row--sel::before { content: ''; position: absolute; left: 0; top: 5px; bottom: 5px; width: 2px; border-radius: 1px; background: var(--accent); }
.ol__row--hidden .ol__name, .ol__row--noprint .ol__name { color: var(--fg-2); }
.ol__row--noprint .ol__name { text-decoration: line-through; text-decoration-color: var(--fg-2); }
.ol__twist { display: grid; place-items: center; width: 14px; height: 18px; margin-left: -4px; padding: 0; background: none; border: 0; color: var(--fg-2); cursor: pointer; }
.ol__icon { color: var(--fg-2); flex: none; }
.ol__row--sel .ol__icon { color: var(--accent); }
.ol__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol__mult { color: var(--fg-2); font-size: var(--fs-sm); margin-left: 2px; }
.ol__tog { opacity: 0; }
.ol__row:hover .ol__tog, .ol__row--sel .ol__tog, .ol__tog--off, .ol__tog:focus-visible { opacity: 1; }
.ol__tog--off { color: var(--fg-2); }
@media (hover: none) { .ol__tog { opacity: 1; } }
</style>
