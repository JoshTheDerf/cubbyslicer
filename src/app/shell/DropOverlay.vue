<script setup lang="ts">
/** Window-wide drag-and-drop target. Shows while files are dragged over the page. */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { importFiles } from './actions';

const active = ref(false);
let depth = 0;

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

function enter(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); depth++; active.value = true; }
function over(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }
function leave(e: DragEvent) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) active.value = false; }
function drop(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  active.value = false;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void importFiles(files);
}

onMounted(() => {
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
});
onBeforeUnmount(() => {
  window.removeEventListener('dragenter', enter);
  window.removeEventListener('dragover', over);
  window.removeEventListener('dragleave', leave);
  window.removeEventListener('drop', drop);
});
</script>

<template>
  <Transition name="drop">
    <div v-if="active" class="drop" aria-hidden="true">
      <div class="drop__frame">
        <UIcon name="i-lucide-file-input" class="size-8 text-primary" />
        <span>Drop to add to the plate</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.drop { position: fixed; inset: 0; z-index: var(--z-dialog); padding: 16px; background: var(--overlay); pointer-events: none; }
.drop__frame {
  height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px;
  border: 2px dashed var(--accent); border-radius: 14px; color: var(--fg-0); font: 600 var(--fs-lg) var(--font);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.drop-enter-active, .drop-leave-active { transition: opacity 0.12s; }
.drop-enter-from, .drop-leave-to { opacity: 0; }
</style>
