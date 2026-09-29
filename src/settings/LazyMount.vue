<script setup lang="ts">
/**
 * Mounts its slot only once it scrolls near the viewport (then keeps it),
 * reserving `estimate` px until then. Keeps settings pages with ~100 Nuxt UI
 * rows fast to switch to; `eager` forces mounting (e.g. for a search jump).
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ estimate: number; eager?: boolean }>();
const el = ref<HTMLElement | null>(null);
const shown = ref(!!props.eager);
let io: IntersectionObserver | null = null;
watch(() => props.eager, (e) => { if (e) show(); });
function show(): void { shown.value = true; io?.disconnect(); io = null; }
onMounted(() => {
  if (shown.value || typeof IntersectionObserver === 'undefined') { show(); return; }
  io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) show(); }, { rootMargin: '600px 0px' });
  if (el.value) io.observe(el.value);
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <div ref="el" :style="shown ? undefined : { height: `${estimate}px` }"><slot v-if="shown" /></div>
</template>
