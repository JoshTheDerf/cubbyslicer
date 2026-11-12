<script setup lang="ts">
/** A clicked center of mass marker's details, beside the marker (desktop CenterOfMass::render_details). Esc closes it. */
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { markerDetails, MARKER_RADII, type MassMarker } from './massProps';

const props = defineProps<{ marker: MassMarker; x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();
const d = computed(() => markerDetails(props.marker));
const style = computed(() => ({ left: `${props.x + 2 * MARKER_RADII[props.marker.kind]}px`, top: `${props.y}px` }));
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); emit('close'); } };
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="com" :style="style" role="dialog" :aria-label="d.title" data-testid="mass-details">
    <div class="com__head">
      <strong>{{ d.title }}</strong>
      <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Close" @click="emit('close')" />
    </div>
    <p v-if="d.note" class="com__note">{{ d.note }}</p>
    <table>
      <tbody>
        <tr v-for="[k, v] in d.rows" :key="k"><th>{{ k }}</th><td>{{ v }}</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.com {
  position: fixed; z-index: calc(var(--z-toolbar) + 3); transform: translateY(-50%); pointer-events: auto;
  padding: 6px 10px 8px; border-radius: 8px; background: color-mix(in srgb, var(--bg-1) 96%, transparent);
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.3); font-size: var(--fs-sm); max-width: calc(100vw - 16px);
}
.com__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; color: var(--fg-0); }
.com__note { margin: 0 0 4px; color: var(--fg-1); }
.com th { text-align: left; font-weight: 500; color: var(--ui-primary); padding: 2px 12px 2px 0; white-space: nowrap; }
.com td { color: var(--fg-0); white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
