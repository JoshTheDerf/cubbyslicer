<script setup lang="ts">
/**
 * Orca EditGCodeDialog: a large G-code editor with a searchable tree of
 * built-in placeholders on the side. Double-click (or the + button) inserts
 * the selected placeholder at the cursor, `{key}` / `{key[]}` (bare inside an
 * existing brace), with the cursor placed in the vector brackets.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { mobileDialog } from '../../ui/mobileDialog';
import { currentPresets } from '../../presets/store';
import { settingsLayout } from '../../settings/useLayout';
import { filterTree, insertionText, insideBraces, placeholderTree, type PlaceholderGroup, type PlaceholderItem } from './placeholders';

const props = defineProps<{ open: boolean; title: string; optKey: string; value: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void; (e: 'apply', v: string): void }>();

const draft = ref(props.value);
const search = ref('');
const selected = ref<PlaceholderItem | null>(null);
const collapsed = ref<Set<string>>(new Set());
const ta = ref<HTMLTextAreaElement | null>(null);
const showTree = ref(true);

watch(() => props.open, (o) => {
  if (!o) return;
  draft.value = props.value;
  search.value = '';
  selected.value = null;
  showTree.value = !mobileDialog.value;
  // Orca expands only the "Specific for …" group by default.
  collapsed.value = new Set(tree.value.map((g) => g.id).filter((id) => id !== 'specific'));
  for (const g of tree.value) for (const s of g.groups ?? []) { collapsed.value.add(s.id); for (const t of s.groups ?? []) collapsed.value.add(t.id); }
  // Phones: no autofocus (the keyboard would cover half the editor before the user asked for it).
  if (!mobileDialog.value) void nextTick(() => ta.value?.focus());
});

const tree = computed<PlaceholderGroup[]>(() => placeholderTree(props.optKey, currentPresets.value.schema.value, settingsLayout.value));
const shown = computed(() => filterTree(tree.value, search.value));
const searching = computed(() => !!search.value.trim());
const lines = computed(() => draft.value.split('\n').length);

function toggle(id: string): void {
  const s = new Set(collapsed.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  collapsed.value = s;
}
const isOpen = (id: string) => searching.value || !collapsed.value.has(id);

function insert(item = selected.value): void {
  if (!item || props.disabled) return;
  const el = ta.value;
  const start = el?.selectionStart ?? draft.value.length, end = el?.selectionEnd ?? start;
  const atEnd = start === draft.value.length && draft.value.length > 0 && !draft.value.endsWith('\n');
  const text = (atEnd ? '\n' : '') + insertionText(item, insideBraces(draft.value, start));
  draft.value = draft.value.slice(0, start) + text + draft.value.slice(end);
  if (mobileDialog.value) showTree.value = false; // phones show the placeholders instead of the editor
  const caret = start + text.length - (item.vector ? (text.endsWith('}') ? 2 : 1) : 0);
  void nextTick(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = caret; } });
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Tab' && !ev.shiftKey) {
    ev.preventDefault();
    const el = ev.target as HTMLTextAreaElement;
    const s = el.selectionStart, e = el.selectionEnd;
    draft.value = `${draft.value.slice(0, s)}  ${draft.value.slice(e)}`;
    void nextTick(() => { el.selectionStart = el.selectionEnd = s + 2; });
  }
}
function close(): void { emit('update:open', false); }
function apply(): void { emit('apply', draft.value); close(); }
</script>

<template>
  <UModal :open="open" :title="`Edit custom G-code (${optKey})`" :description="title" :dismissible="false" :fullscreen="mobileDialog"
          :ui="{ content: 'sm:max-w-6xl', body: 'p-0 sm:p-0 phone:p-0 phone:flex phone:flex-col phone:overflow-hidden' }" @update:open="(o: boolean) => { if (!o) close(); }">
    <template #body>
      <!-- Phones: the editor and the placeholder list take turns (one scroll region at a time). -->
      <UTabs v-if="mobileDialog" :model-value="showTree ? 'tree' : 'code'" :items="[{ value: 'code', label: `G-code (${lines} line${lines === 1 ? '' : 's'})` }, { value: 'tree', label: 'Placeholders' }]"
             :content="false" size="sm" class="ge__tabs" @update:model-value="(v: string | number) => { showTree = v === 'tree'; }" />
      <div class="ge" :class="{ 'ge--notree': !showTree, 'ge--phone': mobileDialog }">
        <aside v-show="showTree" class="ge__side">
          <p class="ge__hint">Built-in placeholders (double-click to add to the G-code)</p>
          <UInput v-model="search" icon="i-lucide-search" placeholder="Search G-code placeholders" size="sm" class="w-full" autocomplete="off" />
          <div class="ge__tree" role="tree" aria-label="Placeholders">
            <template v-for="g in shown" :key="g.id">
              <button type="button" class="ge__grp" role="treeitem" :aria-expanded="isOpen(g.id)" @click="toggle(g.id)">
                <UIcon :name="isOpen(g.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
                <UIcon :name="g.icon" class="size-4 text-primary" /><span>{{ g.title }}</span>
              </button>
              <div v-if="isOpen(g.id)" class="ge__kids">
                <template v-for="s in g.groups ?? []" :key="s.id">
                  <button type="button" class="ge__grp ge__grp--sub" role="treeitem" :aria-expanded="isOpen(s.id)" @click="toggle(s.id)">
                    <UIcon :name="isOpen(s.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
                    <UIcon :name="s.icon" class="size-3.5 text-muted" /><span>{{ s.title }}</span>
                  </button>
                  <div v-if="isOpen(s.id)" class="ge__kids">
                    <template v-for="t in s.groups ?? []" :key="t.id">
                      <button type="button" class="ge__grp ge__grp--sub" role="treeitem" :aria-expanded="isOpen(t.id)" @click="toggle(t.id)">
                        <UIcon :name="isOpen(t.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
                        <span>{{ t.title }}</span>
                      </button>
                      <div v-if="isOpen(t.id)" class="ge__kids">
                        <button v-for="it in t.items" :key="it.key" type="button" class="ge__item" :class="{ on: selected?.key === it.key }" role="treeitem"
                                :title="it.label" @click="selected = it" @dblclick="insert(it)">{{ it.vector ? `${it.key}[]` : it.key }}</button>
                      </div>
                    </template>
                    <button v-for="it in s.items" :key="it.key" type="button" class="ge__item" :class="{ on: selected?.key === it.key }" role="treeitem"
                            :title="it.label" @click="selected = it" @dblclick="insert(it)">{{ it.vector ? `${it.key}[]` : it.key }}</button>
                  </div>
                </template>
                <button v-for="it in g.items" :key="it.key" type="button" class="ge__item" :class="{ on: selected?.key === it.key }" role="treeitem"
                        :title="it.label" @click="selected = it" @dblclick="insert(it)">{{ it.vector ? `${it.key}[]` : it.key }}</button>
              </div>
            </template>
            <p v-if="!shown.length" class="ge__none">No placeholder matches “{{ search }}”.</p>
          </div>
          <div class="ge__desc">
            <template v-if="selected">
              <div class="flex items-center gap-2">
                <strong class="min-w-0 flex-1 truncate">{{ selected.label }}</strong>
                <UButton size="xs" icon="i-lucide-plus" label="Insert" :disabled="disabled" @click="insert()" />
              </div>
              <code>{{ selected.vector ? `${selected.key}[]` : selected.key }}</code>
              <p>{{ selected.tooltip || 'No description.' }}</p>
            </template>
            <p v-else class="text-dimmed">Select a placeholder to see its description.</p>
          </div>
        </aside>
        <div v-show="!mobileDialog || !showTree" class="ge__main">
          <div v-if="!mobileDialog" class="ge__bar">
            <UButton size="xs" variant="ghost" :icon="showTree ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'" :label="showTree ? 'Hide placeholders' : 'Placeholders'" @click="showTree = !showTree" />
            <span class="flex-1" />
            <span class="text-xs text-dimmed">{{ lines }} line{{ lines === 1 ? '' : 's' }}</span>
          </div>
          <textarea ref="ta" v-model="draft" class="ge__ta" spellcheck="false" :wrap="mobileDialog ? 'soft' : 'off'" :disabled="disabled" :aria-label="title" @keydown="onKey" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="close" />
        <UButton color="primary" label="Apply" :disabled="disabled" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.ge { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: min(70vh, 720px); }
.ge--notree { grid-template-columns: minmax(0, 1fr); }
.ge__side { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-right: 1px solid var(--ui-border); min-height: 0; }
.ge__hint { margin: 0; font-size: 11px; color: var(--ui-text-muted); }
.ge__tree { flex: 1; min-height: 0; overflow: auto; font-size: 12px; }
.ge__grp, .ge__item {
  display: flex; align-items: center; gap: 5px; width: 100%; padding: 3px 4px; border: 0; background: none; text-align: left;
  color: var(--ui-text-toned); cursor: pointer; border-radius: 4px;
}
.ge__grp { font-weight: 600; color: var(--ui-text-highlighted); }
.ge__grp--sub { font-weight: 500; color: var(--ui-text-toned); }
.ge__grp:hover, .ge__item:hover { background: var(--ui-bg-elevated); }
.ge__kids { padding-left: 14px; }
.ge__item { font-family: var(--mono); font-size: 11px; padding-left: 22px; }
.ge__item.on { background: color-mix(in srgb, var(--ui-primary) 18%, transparent); color: var(--ui-text-highlighted); }
.ge__none { color: var(--ui-text-dimmed); padding: 8px 4px; margin: 0; }
.ge__desc { border-top: 1px solid var(--ui-border); padding-top: 6px; font-size: 12px; max-height: 30%; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.ge__desc code { font-family: var(--mono); font-size: 11px; color: var(--ui-primary); }
.ge__desc p { margin: 0; color: var(--ui-text-muted); white-space: pre-wrap; }
.ge__main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ge__bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--ui-border); }
.ge__ta {
  flex: 1; min-height: 0; width: 100%; resize: none; border: 0; outline: none; padding: 10px 12px; background: var(--ui-bg);
  color: var(--ui-text); font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre; tab-size: 2;
}
.ge__tabs { flex: none; padding: 6px 12px 0; }
.ge--phone { flex: 1; min-height: 0; height: auto; display: flex; flex-direction: column; }
.ge--phone .ge__side { flex: 1; border-right: 0; }
.ge--phone .ge__main { flex: 1; }
.ge--phone .ge__ta { font-size: 16px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; }
.ge--phone .ge__item { font-size: 13px; }
.ge--phone .ge__desc { flex: none; max-height: none; overflow: visible; }
.ge--phone .ge__desc p { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
</style>
