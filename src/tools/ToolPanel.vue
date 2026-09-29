<script setup lang="ts">
/** Floating tool panel frame (Orca's gizmo ImGui window): title, close, body. Bottom sheet on phones. */
import { ref } from 'vue';
import { phone } from '../app/shell/uiState';

defineProps<{ title: string; icon?: string }>();
const emit = defineEmits<{ close: [] }>();
const collapsed = ref(false);
</script>

<template>
  <section class="tpn" :class="{ 'tpn--phone': phone }" :aria-label="title" @pointerdown.stop @keydown.stop>
    <header class="tpn__head">
      <UIcon v-if="icon" :name="icon" class="size-4 text-primary shrink-0" />
      <h2 class="tpn__title">{{ title }}</h2>
      <UButton :icon="collapsed ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" color="neutral" variant="ghost" size="xs"
               :aria-label="collapsed ? 'Expand panel' : 'Collapse panel'" :aria-expanded="!collapsed" @click="collapsed = !collapsed" />
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="Close tool" @click="emit('close')" />
    </header>
    <div v-show="!collapsed" class="tpn__body">
      <slot />
    </div>
    <footer v-if="$slots.footer && !collapsed" class="tpn__foot"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.tpn {
  position: absolute; top: 58px; left: 10px; z-index: calc(var(--z-toolbar) + 1);
  width: 310px; max-width: calc(100% - 20px); max-height: calc(100% - 180px);
  display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--bg-1) 96%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
  font-size: var(--fs-sm); color: var(--fg-0);
}
.tpn__head { display: flex; align-items: center; gap: 6px; padding: 6px 6px 4px 10px; border-bottom: 1px solid var(--line); }
.tpn__title { flex: 1; min-width: 0; margin: 0; font: 600 var(--fs-sm) var(--font); }
.tpn__body { padding: 8px 10px 10px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.tpn__foot { display: flex; gap: 6px; justify-content: flex-end; padding: 8px 10px; border-top: 1px solid var(--line); flex-wrap: wrap; }
/* Phone: a bottom sheet above the plater toolbar. */
.tpn--phone {
  top: auto; left: 8px; right: 8px; width: auto; max-width: none;
  bottom: calc(60px + env(safe-area-inset-bottom)); max-height: 46%;
}
</style>
