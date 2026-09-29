<script setup lang="ts">
/**
 * Searchable, grouped preset combo (USelectMenu): user presets first, then
 * system presets grouped by vendor (printers) or filament vendor (filaments),
 * engine defaults last — like Orca's PresetComboBoxes.
 */
import { computed } from 'vue';
import type { PresetInfo } from '../../presets/types';

const props = defineProps<{
  items: PresetInfo[];
  value: string;
  current: PresetInfo;
  groupBy?: 'vendor' | 'filament' | 'none';
  modified?: number;
  loading?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();
const open = defineModel<boolean>('open', { default: false });

interface Item { id: string; label: string; tag?: string; vendor?: string; source: string; type?: 'label' }

const grouped = computed<Item[][]>(() => {
  const out: Item[][] = [];
  const toItem = (p: PresetInfo): Item => ({
    id: p.id, label: p.name, source: p.source,
    tag: props.groupBy === 'filament' ? p.filamentType : undefined,
    vendor: `${p.filamentVendor ?? ''} ${p.vendor ?? ''} ${p.printerModel ?? ''}`.trim(),
  });
  const head = (label: string): Item => ({ id: `__h:${label}`, label, source: '', type: 'label' });
  const user = props.items.filter((p) => p.source === 'user');
  const sys = props.items.filter((p) => p.source === 'system');
  const dflt = props.items.filter((p) => p.source === 'default');
  if (user.length) out.push([head('User presets'), ...user.map(toItem)]);
  const by = new Map<string, PresetInfo[]>();
  for (const p of sys) {
    const g = props.groupBy === 'filament' ? (p.filamentVendor || (p.fromLibrary ? 'Generic' : p.vendor) || 'Other')
      : props.groupBy === 'vendor' ? (p.vendor || 'System') : 'System presets';
    let l = by.get(g);
    if (!l) by.set(g, (l = []));
    l.push(p);
  }
  const keys = [...by.keys()].sort((a, b) => (a === 'Generic' ? -1 : b === 'Generic' ? 1 : a.localeCompare(b)));
  for (const k of keys) {
    const list = by.get(k)!;
    if (props.groupBy === 'filament') list.sort((a, b) => (a.filamentType ?? '').localeCompare(b.filamentType ?? '') || a.name.localeCompare(b.name));
    out.push([head(k), ...list.map(toItem)]);
  }
  if (dflt.length) out.push([head('Engine defaults'), ...dflt.map(toItem)]);
  return out;
});
const count = computed(() => props.items.length);

function onUpdate(id: unknown): void {
  if (typeof id === 'string' && id && !id.startsWith('__h:') && id !== props.value) emit('select', id);
}
</script>

<template>
  <USelectMenu v-model:open="open" :model-value="value" :items="grouped" value-key="id" :filter-fields="['label', 'tag', 'vendor']"
               :search-input="{ placeholder: 'Search presets…', icon: 'i-lucide-search' }" :virtualize="count > 160 ? { estimateSize: 30 } : false"
               :loading="loading" size="sm" class="ps min-w-0 flex-1" :aria-label="ariaLabel"
               :ui="{ content: 'min-w-72' }" @update:model-value="onUpdate">
    <template #default>
      <span class="ps__name" :class="{ 'ps__name--user': current.source === 'user', 'ps__name--dflt': current.source === 'default' }">{{ current.name }}</span>
      <span v-if="modified" class="ps__mod" :title="`${modified} unsaved change${modified > 1 ? 's' : ''}`">● {{ modified }}</span>
    </template>
    <template #item-label="{ item }">
      <span class="truncate" :class="{ 'text-info': (item as Item).source === 'user' }">{{ (item as Item).label }}</span>
    </template>
    <template #item-trailing="{ item }">
      <UBadge v-if="(item as Item).tag" size="sm" variant="outline" color="neutral" :label="(item as Item).tag" />
    </template>
    <template #empty>{{ loading ? 'Loading…' : 'No matching presets' }}</template>
    <template v-if="$slots.footer" #content-bottom>
      <div class="border-t border-default p-1"><slot name="footer" :close="() => (open = false)" /></div>
    </template>
  </USelectMenu>
</template>

<style scoped>
.ps__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.ps__name--user { color: var(--ui-info); }
.ps__name--dflt { color: var(--ui-text-muted); font-style: italic; }
.ps__mod { color: var(--modified); font-size: 11px; flex: none; margin-left: 4px; }
</style>
