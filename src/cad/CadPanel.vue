<script setup lang="ts">
/**
 * The CubbyCAD shape panel for the selected CAD object (floating card, top
 * right of the Prepare view): its node tree — pick, rename, hide, lock, hole,
 * delete — and the picked node's settings (name, hole, colour, the shape's
 * parameters from its schema). A picked child is moved with the gizmo in its
 * own frame. CubbyCAD-only nodes are listed with a badge and stay read-only.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { getSharedShape, isCadGroup, isCadPrimitive, type CadNode } from './api';
import {
  cadNode, cadObject, cadSupportOf, cadUi, commitParams, deleteNode, editNode, pickNode, queueParam,
} from './commands';
import { nodeIcon, nodeKindLabel, nodeName } from './tree';
import { ShapeParamsForm } from './ui';
import { renameObject } from '../project/store';

const obj = cadObject;
const root = computed(() => obj.value?.cad?.node ?? null);
const support = computed(() => (obj.value ? cadSupportOf(obj.value) : new Map()));
const collapsed = reactive(new Set<string>());

interface Row { node: CadNode; depth: number; isRoot: boolean; hasChildren: boolean }
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const r = root.value;
  if (!r) return out;
  const visit = (n: CadNode, depth: number) => {
    const kids = isCadGroup(n) ? n.children : [];
    out.push({ node: n, depth, isRoot: n === r, hasChildren: kids.length > 0 });
    if (!collapsed.has(n.id)) for (const c of kids) visit(c, depth + 1);
  };
  visit(r, 0);
  return out;
});

const current = cadNode;
const isRootSel = computed(() => !!current.value && current.value === root.value);
const sup = (n: CadNode) => support.value.get(n.id) ?? { editable: true };
const editable = computed(() => !!current.value && sup(current.value).editable && !current.value.locked);
const shape = computed(() => (current.value && isCadPrimitive(current.value) ? getSharedShape(current.value.geometry.type) : undefined));
const params = computed(() => (current.value && isCadPrimitive(current.value) ? (current.value.geometry.params ?? {}) : {}));
const colour = computed(() => {
  const c = current.value?.material?.color;
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#9aa3ad';
});

function pick(n: CadNode) { if (obj.value) pickNode(obj.value.id, n === root.value ? null : n.id); }
function edit(n: CadNode, args: Omit<Parameters<typeof editNode>[1], 'id'>, label: string) { if (obj.value) void editNode(obj.value.id, { id: n.id, ...args }, label); }
/** Params form edits: live while a slider drags (debounced, one undo step per drag). */
function onParams(u: { params: Record<string, unknown> }) {
  const o = obj.value, n = current.value;
  if (!o || !n) return;
  for (const [k, v] of Object.entries(u.params)) queueParam(o.id, n.id, k, v);
}

// ---- rename ----
const renaming = ref<string | null>(null);
const draft = ref('');
const listEl = ref<HTMLElement | null>(null);
async function startRename(n: CadNode) {
  renaming.value = n.id;
  draft.value = nodeName(n);
  await nextTick();
  const i = listEl.value?.querySelector<HTMLInputElement>('.cp__rename input');
  i?.focus(); i?.select();
}
function commitRename(n: CadNode) {
  const v = draft.value.trim();
  renaming.value = null;
  if (!v || !obj.value || v === nodeName(n)) return;
  if (n === root.value) renameObject(obj.value.id, v);
  edit(n, { name: v }, 'Rename shape');
}
watch(() => obj.value?.id, () => { renaming.value = null; });
</script>

<template>
  <section v-if="obj && root" class="cp" aria-label="Shape">
    <header class="cp__head">
      <UButton :icon="cadUi.panelOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" color="neutral" variant="ghost" size="xs"
               :aria-expanded="cadUi.panelOpen" aria-label="Toggle shape panel" @click="cadUi.panelOpen = !cadUi.panelOpen" />
      <UIcon name="i-lucide-shapes" class="size-4 text-muted" />
      <span class="cp__title">Shape</span>
      <span class="cp__sub" :title="obj.name">{{ obj.name }}</span>
    </header>

    <div v-show="cadUi.panelOpen" class="cp__body">
      <ul ref="listEl" class="cp__tree" role="tree" aria-label="Shape tree">
        <li v-for="r in rows" :key="r.node.id" role="treeitem" :aria-selected="current?.id === r.node.id" :aria-expanded="r.hasChildren ? !collapsed.has(r.node.id) : undefined"
            class="cp__row" :class="{ 'cp__row--sel': current?.id === r.node.id, 'cp__row--off': r.node.hidden, 'cp__row--ro': !sup(r.node).editable }"
            :style="{ paddingLeft: `${4 + r.depth * 14}px` }" @click="pick(r.node)" @dblclick="startRename(r.node)">
          <button v-if="r.hasChildren" type="button" class="cp__twisty" :aria-label="collapsed.has(r.node.id) ? 'Expand' : 'Collapse'"
                  @click.stop="collapsed.has(r.node.id) ? collapsed.delete(r.node.id) : collapsed.add(r.node.id)">
            <UIcon :name="collapsed.has(r.node.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" class="size-3" />
          </button>
          <span v-else class="cp__twisty" />
          <UIcon :name="nodeIcon(r.node)" class="size-3.5 shrink-0" :class="r.node.contribution === 'subtract' ? 'text-dimmed' : 'text-muted'" />
          <UInput v-if="renaming === r.node.id" v-model="draft" size="xs" class="cp__rename" aria-label="Shape name"
                  @keydown.enter.prevent="commitRename(r.node)" @keydown.esc.prevent="renaming = null" @blur="commitRename(r.node)" @click.stop />
          <span v-else class="cp__name" :title="`${nodeName(r.node)} · ${nodeKindLabel(r.node)}`">{{ nodeName(r.node) }}</span>
          <UTooltip v-if="(!sup(r.node).editable || sup(r.node).baked) && sup(r.node).reason" :text="sup(r.node).reason">
            <UBadge :label="sup(r.node).baked ? 'Baked' : 'CAD only'" color="warning" variant="subtle" size="sm" class="cp__badge" />
          </UTooltip>
          <span class="cp__tools">
            <UTooltip v-if="!r.isRoot || r.node.contribution === 'subtract'" :text="r.node.contribution === 'subtract' ? 'Hole (click for solid)' : 'Solid (click for hole)'">
              <UButton :icon="r.node.contribution === 'subtract' ? 'i-lucide-circle-dashed' : 'i-lucide-circle'" size="xs" variant="ghost" color="neutral"
                       :disabled="!sup(r.node).editable || r.node.locked" :aria-label="r.node.contribution === 'subtract' ? 'Make solid' : 'Make hole'"
                       :class="{ 'cp__on': r.node.contribution === 'subtract' }"
                       @click.stop="edit(r.node, { hole: r.node.contribution !== 'subtract' }, r.node.contribution === 'subtract' ? 'Make solid' : 'Make hole')" />
            </UTooltip>
            <UButton v-if="!r.isRoot" :icon="r.node.hidden ? 'i-lucide-eye-off' : 'i-lucide-eye'" size="xs" variant="ghost" color="neutral"
                     :disabled="!sup(r.node).editable" :aria-label="r.node.hidden ? 'Show' : 'Hide'" :class="{ 'cp__on': r.node.hidden }"
                     @click.stop="edit(r.node, { hidden: !r.node.hidden }, r.node.hidden ? 'Show shape' : 'Hide shape')" />
            <UButton :icon="r.node.locked ? 'i-lucide-lock' : 'i-lucide-lock-open'" size="xs" variant="ghost" color="neutral"
                     :disabled="!sup(r.node).editable" :aria-label="r.node.locked ? 'Unlock' : 'Lock'" :class="{ 'cp__on': r.node.locked }"
                     @click.stop="edit(r.node, { locked: !r.node.locked }, r.node.locked ? 'Unlock shape' : 'Lock shape')" />
            <UButton v-if="!r.isRoot" icon="i-lucide-trash-2" size="xs" variant="ghost" color="neutral" :disabled="!!r.node.locked" aria-label="Delete"
                     @click.stop="obj && deleteNode(obj.id, r.node.id)" />
          </span>
        </li>
      </ul>

      <div v-if="current" class="cp__props">
        <div class="cp__kind">
          <UIcon :name="nodeIcon(current)" class="size-4 text-muted" />
          <span>{{ nodeKindLabel(current) }}</span>
          <span v-if="isCadGroup(current)" class="text-dimmed">· {{ current.children.length }} part{{ current.children.length === 1 ? '' : 's' }}, sharp (manifold)</span>
          <span v-if="!isRootSel" class="text-dimmed">· move it with the gizmo</span>
        </div>
        <p v-if="!sup(current).editable || sup(current).baked" class="cp__note">{{ sup(current).reason }}</p>
        <p v-if="current.locked" class="cp__note">Locked. Unlock it to edit.</p>
        <template v-if="sup(current).editable && !current.locked">
          <div class="cp__line">
            <USwitch :model-value="current.contribution === 'subtract'" size="xs" label="Hole" :disabled="!editable"
                     @update:model-value="edit(current, { hole: $event }, $event ? 'Make hole' : 'Make solid')" />
            <label class="cp__colour">
              <span class="text-muted">Colour</span>
              <input type="color" :value="colour" :disabled="!editable" aria-label="Shape colour"
                     @change="edit(current, { color: ($event.target as HTMLInputElement).value }, 'Change colour')">
            </label>
          </div>
          <p v-if="isRootSel && current.contribution === 'subtract'" class="cp__note">A hole on its own isn’t printed. Group it with a solid to cut it out.</p>
          <ShapeParamsForm v-if="shape?.schema" :schema="shape.schema" :params="params" size="xs"
                           @update="onParams" @pointerup="commitParams()" @keyup.enter="commitParams()" />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cp {
  width: 300px; max-width: calc(100vw - 24px); max-height: calc(100vh - 220px); display: flex; flex-direction: column; padding: 4px 8px 8px;
  background: color-mix(in srgb, var(--bg-1) 94%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.cp__head { display: flex; align-items: center; gap: 6px; min-height: 28px; }
.cp__title { font: 600 var(--fs-sm) var(--font); color: var(--fg-0); }
.cp__sub { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--fg-2, var(--fg-1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__body { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; }
.cp__tree { list-style: none; margin: 0; padding: 2px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); max-height: 240px; overflow: auto; }
.cp__row { display: flex; align-items: center; gap: 4px; min-height: 26px; padding-right: 2px; border-radius: 4px; cursor: default; font-size: var(--fs-sm); color: var(--fg-0); }
.cp__row:hover { background: var(--bg-2); }
.cp__row--sel { background: color-mix(in srgb, var(--ui-primary) 18%, transparent); }
.cp__row--off .cp__name { opacity: 0.5; }
.cp__row--ro .cp__name { font-style: italic; }
.cp__twisty { width: 14px; display: inline-grid; place-items: center; color: var(--fg-1); background: none; border: 0; padding: 0; cursor: pointer; }
.cp__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__rename { flex: 1; min-width: 0; }
.cp__badge { flex: none; }
.cp__tools { display: flex; gap: 0; opacity: 0.35; }
.cp__row:hover .cp__tools, .cp__row--sel .cp__tools, .cp__tools:focus-within { opacity: 1; }
.cp__on { color: var(--ui-primary); }
.cp__props { display: flex; flex-direction: column; gap: 8px; }
.cp__kind { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--fg-0); flex-wrap: wrap; }
.cp__line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cp__colour { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
.cp__colour input { width: 28px; height: 22px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: none; cursor: pointer; }
.cp__note { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.35; }
</style>
