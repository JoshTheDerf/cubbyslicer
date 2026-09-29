<script setup lang="ts">
/**
 * Assembly View panel (Orca's assembly canvas): explosion ratio, return.
 * The viewport shows the assembled poses while this tool is open.
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { objects } from '../../project/store';
import { fitBed } from '../../viewport/controller';
import ToolPanel from '../ToolPanel.vue';
import { closeTool, installHandler, toolScene } from '../state';
import { assemblyUi } from './assembly';

const assembled = computed(() => objects.value.filter((o) => o.assembly).length);
// Display only: no transform gizmo, clicks still select.
const handler = { onPointer: () => false, hideGizmo: true };
watch(toolScene, () => installHandler(handler));
onMounted(() => { installHandler(handler); fitBed(); });
onBeforeUnmount(() => { installHandler(null); assemblyUi.explosion = 1; });
</script>

<template>
  <ToolPanel title="Assembly view" icon="i-lucide-boxes" @close="closeTool()">
    <p class="text-xs text-muted">
      Objects are shown where they sit in the assembled model<template v-if="assembled">: {{ assembled }} cut piece{{ assembled === 1 ? '' : 's' }} back together</template>. Editing is off in this view.
    </p>
    <div class="flex items-center gap-2">
      <span class="text-xs text-muted whitespace-nowrap">Explosion ratio</span>
      <USlider v-model="assemblyUi.explosion" :min="1" :max="3" :step="0.01" size="sm" class="flex-1" aria-label="Explosion ratio" />
      <span class="text-xs tabular-nums w-10 text-right">{{ assemblyUi.explosion.toFixed(2) }}</span>
    </div>
    <template #footer>
      <UButton size="sm" color="primary" icon="i-lucide-undo-2" label="Return to plate" @click="closeTool()" />
    </template>
  </ToolPanel>
</template>
