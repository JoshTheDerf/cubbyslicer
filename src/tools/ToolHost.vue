<script setup lang="ts">
/**
 * Mount point for the tools (inside the Prepare viewport): the active tool
 * panel plus the import dialogs (STEP deflection, OBJ colours). Esc closes
 * the active tool (the `tool.close` action, before the other Esc actions).
 */
import { defineAsyncComponent, onBeforeUnmount, watch } from 'vue';
import { activeView } from '../app/state';
import { closeTool, toolState } from './state';
import StepDialog from './step/StepDialog.vue';

const panels = {
  measure: defineAsyncComponent(() => import('./measure/MeasurePanel.vue')),
  text: defineAsyncComponent(() => import('./text/TextPanel.vue')),
  svg: defineAsyncComponent(() => import('./svg/SvgPanel.vue')),
  simplify: defineAsyncComponent(() => import('./simplify/SimplifyPanel.vue')),
  boolean: defineAsyncComponent(() => import('./boolean/BooleanPanel.vue')),
  brim: defineAsyncComponent(() => import('./brim/BrimPanel.vue')),
  cut: defineAsyncComponent(() => import('./cut/CutPanel.vue')),
  assembly: defineAsyncComponent(() => import('./assembly/AssemblyPanel.vue')),
  texture: defineAsyncComponent(() => import('../texture/TexturePanel.vue')),
};
const ObjColorDialog = defineAsyncComponent(() => import('./objcolor/ObjColorDialog.vue'));

onBeforeUnmount(closeTool);
// Tools belong to the Prepare view.
watch(activeView, (v) => { if (v !== 'prepare') closeTool(); });
</script>

<template>
  <component :is="panels[toolState.active]" v-if="toolState.active" :key="`${toolState.active}:${toolState.opened}`" />
  <StepDialog />
  <ObjColorDialog />
</template>
