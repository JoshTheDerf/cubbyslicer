<script setup lang="ts">
/**
 * Simplify model (Orca GLGizmoSimplify): reduce the triangle count of the
 * selected object (or the picked part) by detail level or ratio, preview
 * the result as a wireframe, apply as one undo step.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from 'three';
import { getObject, objects, replaceVolumeMesh, selectedIds, selectedPart } from '../../project/store';
import { toast } from '../../ui';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, toolScene } from '../state';
import { COLORS, ToolOverlay, render, volumeMatrix, volumeMesh } from '../overlay';
import { DETAIL_LEVELS, simplifyMesh, targetFromRatio, type SimplifyResult } from './simplify';

const target = computed(() => {
  const sp = selectedPart.value;
  if (sp) return { objectId: sp.objectId, partId: sp.partId as string | null };
  return selectedIds.value.length === 1 ? { objectId: selectedIds.value[0], partId: null as string | null } : null;
});
const mesh = computed(() => (target.value ? volumeMesh(target.value.objectId, target.value.partId) : undefined));
const label = computed(() => {
  const t = target.value;
  if (!t) return '';
  const o = getObject(t.objectId);
  return t.partId ? o?.parts?.find((p) => p.id === t.partId)?.name ?? 'Part' : o?.name ?? 'Object';
});

const mode = ref<'level' | 'ratio'>('level');
const level = ref('medium');
const ratioPct = ref(50);
const ratio = computed(() => (mode.value === 'level' ? DETAIL_LEVELS.find((l) => l.id === level.value)?.ratio ?? 0.25 : ratioPct.value / 100));
const tris = computed(() => mesh.value?.triangleCount ?? 0);
const targetTris = computed(() => targetFromRatio(tris.value, ratio.value));
const result = shallowRef<SimplifyResult | null>(null);
const busy = ref(false);
const overlay = new ToolOverlay('simplify');
let token = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function drawPreview(): void {
  overlay.attach();
  overlay.clear();
  const r = result.value, t = target.value;
  const m = t ? volumeMatrix(t.objectId, t.partId) : null;
  if (r && m) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(r.positions, 3));
    g.setIndex(new BufferAttribute(r.indices, 1));
    const wire = new Mesh(g, new MeshBasicMaterial({ color: COLORS.preview, wireframe: true, transparent: true, opacity: 0.7, depthTest: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    wire.matrixAutoUpdate = false;
    wire.matrix.fromArray(m);
    wire.renderOrder = 24;
    overlay.add(wire);
  }
  render();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 250);
}

async function run(): Promise<void> {
  timer = null;
  const m = mesh.value;
  if (!m) { result.value = null; drawPreview(); return; }
  const my = ++token;
  busy.value = true;
  try {
    const r = await simplifyMesh(m.positions, m.indices, targetTris.value);
    if (my === token) { result.value = r; drawPreview(); }
  } catch (e) {
    if (my === token) toast.error('Couldn’t simplify the mesh.', { detail: (e as Error)?.message });
  } finally {
    if (my === token) busy.value = false;
  }
}

function apply(): void {
  const r = result.value, t = target.value;
  if (!r || !t || r.indices.length >= (mesh.value?.indices.length ?? 0)) return;
  replaceVolumeMesh(t.objectId, t.partId, { positions: r.positions, indices: r.indices }, { label: 'Simplify model', emboss: null });
  toast.success(`Simplified ${label.value} to ${(r.indices.length / 3).toLocaleString()} triangles.`, { timeout: 2400 });
  closeTool();
}

watch([() => mesh.value?.id, targetTris], schedule);
watch(toolScene, drawPreview);
watch(objects, drawPreview, { deep: true });
onMounted(schedule);
onBeforeUnmount(() => { if (timer) clearTimeout(timer); token++; overlay.dispose(); });
const levelItems = DETAIL_LEVELS.map((l) => ({ label: l.label, value: l.id }));
</script>

<template>
  <ToolPanel title="Simplify model" icon="i-lucide-triangle" @close="closeTool()">
    <template v-if="mesh">
      <p class="text-xs text-muted truncate">{{ label }} · {{ tris.toLocaleString() }} triangles</p>
      <UFieldGroup size="sm" class="w-full">
        <UButton class="flex-1 justify-center" :variant="mode === 'level' ? 'soft' : 'ghost'" :color="mode === 'level' ? 'primary' : 'neutral'" label="Detail level" @click="mode = 'level'" />
        <UButton class="flex-1 justify-center" :variant="mode === 'ratio' ? 'soft' : 'ghost'" :color="mode === 'ratio' ? 'primary' : 'neutral'" label="Decimate ratio" @click="mode = 'ratio'" />
      </UFieldGroup>
      <USelect v-if="mode === 'level'" v-model="level" :items="levelItems" size="sm" class="w-full" aria-label="Detail level" />
      <div v-else class="flex items-center gap-3">
        <USlider v-model="ratioPct" :min="1" :max="100" :step="1" size="sm" class="flex-1" aria-label="Ratio" />
        <span class="w-12 text-right font-mono text-sm">{{ ratioPct }}%</span>
      </div>
      <dl class="sm__res">
        <dt>Target</dt><dd>{{ targetTris.toLocaleString() }}</dd>
        <dt>Result</dt>
        <dd>
          <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-3.5 animate-spin text-primary align-middle" />
          <template v-else-if="result">{{ (result.indices.length / 3).toLocaleString() }}</template>
          <template v-else>—</template>
        </dd>
      </dl>
      <p class="text-xs text-dimmed">The wireframe shows the simplified mesh. Instances share the result.</p>
    </template>
    <p v-else class="text-sm text-muted">Select one object (or pick a part in the object list) to simplify.</p>
    <template #footer>
      <UButton size="sm" variant="ghost" label="Cancel" @click="closeTool()" />
      <UButton size="sm" color="primary" label="Apply" :disabled="!result || busy || !mesh" @click="apply" />
    </template>
  </ToolPanel>
</template>

<style scoped>
.sm__res { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; padding: 6px 8px; background: var(--bg-2); border-radius: var(--radius); }
.sm__res dt { color: var(--fg-1); }
.sm__res dd { margin: 0; text-align: right; font-family: var(--font-mono, monospace); }
</style>
