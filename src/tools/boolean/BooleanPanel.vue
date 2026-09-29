<script setup lang="ts">
/**
 * Mesh boolean (Orca GLGizmoMeshBoolean, key B): union / difference /
 * intersection between the parts of one object, or between selected
 * objects. The result replaces the source volume; tools are deleted unless
 * "Delete input" is off. One undo step.
 */
import { computed, ref, watch } from 'vue';
import { getObject, selectedIds } from '../../project/store';
import { PART_TYPE_LABELS } from '../../project/types';
import { toast } from '../../ui';
import ToolPanel from '../ToolPanel.vue';
import { closeTool } from '../state';
import { BOOLEAN_LABELS, type BooleanOp } from './boolean';
import { runMeshBoolean } from './run';

interface Vol { key: string; objectId: string; partId: string | null; label: string }

const volumes = computed<Vol[]>(() => {
  const ids = selectedIds.value;
  if (ids.length === 1) {
    const o = getObject(ids[0]);
    if (!o) return [];
    const parts = (o.parts ?? []).filter((p) => p.type === 'part' || p.type === 'negative');
    if (!parts.length) return [];
    return [
      { key: `${o.id}:`, objectId: o.id, partId: null, label: o.name },
      ...parts.map((p) => ({ key: `${o.id}:${p.id}`, objectId: o.id, partId: p.id, label: `${p.name} (${PART_TYPE_LABELS[p.type].toLowerCase()})` })),
    ];
  }
  return ids.map((id) => getObject(id)).filter((o) => !!o).map((o) => ({ key: `${o!.id}:`, objectId: o!.id, partId: null, label: o!.name }));
});
const betweenObjects = computed(() => selectedIds.value.length > 1);
const partsIgnored = computed(() => betweenObjects.value && selectedIds.value.some((id) => (getObject(id)?.parts?.length ?? 0) > 0));

const op = ref<BooleanOp>('difference');
const source = ref('');
const tools = ref<string[]>([]);
const deleteInput = ref(true);
const busy = ref(false);

watch(volumes, (v) => {
  const keys = v.map((x) => x.key);
  if (!keys.includes(source.value)) source.value = keys[0] ?? '';
  tools.value = keys.filter((k) => k !== source.value);
}, { immediate: true });
watch(source, (s) => { tools.value = volumes.value.map((v) => v.key).filter((k) => k !== s); });

const sourceItems = computed(() => volumes.value.map((v) => ({ label: v.label, value: v.key })));
const toolVols = computed(() => volumes.value.filter((v) => v.key !== source.value));
function toggleTool(k: string, on: boolean) { tools.value = on ? [...new Set([...tools.value, k])] : tools.value.filter((x) => x !== k); }

async function run(): Promise<void> {
  const src = volumes.value.find((v) => v.key === source.value);
  const tv = volumes.value.filter((v) => tools.value.includes(v.key));
  if (!src || !tv.length) return;
  busy.value = true;
  try {
    await runMeshBoolean(op.value, src, tv, deleteInput.value);
    toast.success(`${BOOLEAN_LABELS[op.value]} done.`, { timeout: 2000 });
  } catch (e) {
    toast.error('Mesh boolean failed.', { detail: (e as Error)?.message });
  } finally {
    busy.value = false;
  }
}

const OPS: Array<{ value: BooleanOp; icon: string }> = [
  { value: 'union', icon: 'i-lucide-squares-unite' },
  { value: 'difference', icon: 'i-lucide-squares-subtract' },
  { value: 'intersection', icon: 'i-lucide-squares-intersect' },
];
</script>

<template>
  <ToolPanel title="Mesh boolean" icon="i-lucide-squares-subtract" @close="closeTool()">
    <template v-if="volumes.length >= 2">
      <UFieldGroup size="sm" class="w-full">
        <UButton v-for="o in OPS" :key="o.value" class="flex-1 justify-center" :icon="o.icon" :label="BOOLEAN_LABELS[o.value]"
                 :variant="op === o.value ? 'soft' : 'ghost'" :color="op === o.value ? 'primary' : 'neutral'" :aria-pressed="op === o.value" @click="op = o.value" />
      </UFieldGroup>
      <UFormField :label="op === 'difference' ? 'Subtract from' : 'Source'" size="sm">
        <USelect v-model="source" :items="sourceItems" size="sm" class="w-full" />
      </UFormField>
      <UFormField :label="op === 'difference' ? 'Subtract' : op === 'union' ? 'Add' : 'Intersect with'" size="sm">
        <div class="flex flex-col gap-1.5">
          <UCheckbox v-for="t in toolVols" :key="t.key" :model-value="tools.includes(t.key)" :label="t.label" size="sm"
                     @update:model-value="toggleTool(t.key, !!$event)" />
        </div>
      </UFormField>
      <UCheckbox v-model="deleteInput" label="Delete input" size="sm" />
      <p v-if="partsIgnored" class="text-xs text-dimmed">Between objects only their own meshes are combined; their parts are kept.</p>
    </template>
    <p v-else class="text-sm text-muted">
      Select two or more objects, or one object with parts (add a part or split to parts), to combine them.
    </p>
    <template #footer>
      <UButton size="sm" variant="ghost" label="Close" @click="closeTool()" />
      <UButton size="sm" color="primary" :loading="busy" :label="BOOLEAN_LABELS[op]" :disabled="volumes.length < 2 || !tools.length || busy" @click="run" />
    </template>
  </ToolPanel>
</template>
