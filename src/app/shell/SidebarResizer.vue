<script setup lang="ts">
/** Drag handle on the sidebar's right edge (keyboard: ←/→, Home resets). */
import { onBeforeUnmount, ref } from 'vue';
import { layout, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './uiState';

const dragging = ref(false);
let startX = 0, startW = 0;
const clamp = (w: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)));

function move(e: PointerEvent) { layout.sidebarWidth = clamp(startW + e.clientX - startX); }
function up() {
  dragging.value = false;
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
}
function down(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  startX = e.clientX; startW = layout.sidebarWidth;
  dragging.value = true;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function key(e: KeyboardEvent) {
  const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
  if (d) { e.preventDefault(); layout.sidebarWidth = clamp(layout.sidebarWidth + d); }
  else if (e.key === 'Home') { e.preventDefault(); layout.sidebarWidth = SIDEBAR_DEFAULT; }
}
onBeforeUnmount(up);
</script>

<template>
  <div class="rz" :class="{ 'rz--on': dragging }" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
       :aria-valuenow="layout.sidebarWidth" :aria-valuemin="SIDEBAR_MIN" :aria-valuemax="SIDEBAR_MAX" tabindex="0"
       @pointerdown="down" @keydown="key" @dblclick="layout.sidebarWidth = SIDEBAR_DEFAULT" />
</template>

<style scoped>
.rz { position: relative; flex: none; width: 5px; margin: 0 -3px 0 -2px; z-index: var(--z-drawer); cursor: col-resize; touch-action: none; }
.rz::after { content: ''; position: absolute; inset: 0 2px; transition: background 0.12s; }
.rz:hover::after, .rz--on::after, .rz:focus-visible::after { background: var(--accent); }
.rz:focus-visible { outline: none; }
</style>
