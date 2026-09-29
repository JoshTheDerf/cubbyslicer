<script setup lang="ts">
import { bindingOf, run } from './useActions';
import { touch } from './uiState';
</script>

<template>
  <div class="es">
    <div class="es__card">
      <svg class="es__art" viewBox="0 0 96 72" aria-hidden="true">
        <path d="M48 6l30 17v26L48 66 18 49V23z" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M18 23l30 17 30-17M48 40v26" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M22 44.5l26 15 26-15M22 38l26 15 26-15M22 31.5l26 15 26-15" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" opacity="0.85" />
      </svg>
      <h2 class="text-base font-semibold text-highlighted mb-1.5">{{ touch ? 'Add a model to start' : 'Drop models here to start' }}</h2>
      <p class="text-sm text-toned">STL, OBJ, STEP and 3MF files, including OrcaSlicer and Bambu Studio projects.{{ touch ? '' : ' You can drop several at once.' }}</p>
      <div class="flex flex-wrap justify-center gap-2 mt-4 mb-3">
        <UButton color="primary" icon="i-lucide-file-input" label="Import model…" @click="run('file.import')" />
        <UButton color="neutral" variant="ghost" icon="i-lucide-folder-open" label="Open project…" @click="run('file.open')" />
      </div>
      <p v-if="!touch" class="text-xs text-dimmed">{{ bindingOf('file.import') }} imports a model. {{ bindingOf('help.palette') }} finds any command.</p>
    </div>
  </div>
</template>

<style scoped>
.es { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; pointer-events: none; padding: 24px; }
.es__card {
  pointer-events: auto; width: min(400px, 100%); padding: 24px 24px 18px; text-align: center;
  background: color-mix(in srgb, var(--bg-1) 88%, transparent);
  border: 1px dashed var(--line-strong); border-radius: 12px; backdrop-filter: blur(4px);
}
.es__art { width: 96px; height: 72px; margin: 0 auto 10px; }
</style>
