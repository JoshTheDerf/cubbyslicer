<script setup lang="ts">
/**
 * Orca's horizontal plater toolbar centred over the 3D view, projected from
 * the action registry (PLATE_TOOLBAR). Tooltips show the action's shortcut.
 */
import { PLATE_TOOLBAR } from '../actions/layouts/toolbar';
import { useToolbar } from './useActions';

const groups = useToolbar(PLATE_TOOLBAR);
</script>

<template>
  <div class="tb" role="toolbar" aria-label="Plate tools">
    <template v-for="(g, gi) in groups" :key="gi">
      <USeparator v-if="gi" orientation="vertical" class="h-6 mx-1" />
      <UTooltip v-for="t in g" :key="t.id" :text="t.label" :kbds="t.kbds" :content="{ side: 'bottom', sideOffset: 6 }">
        <UButton :icon="t.icon" :aria-label="t.label" :aria-pressed="t.active || undefined" :disabled="t.disabled"
                 :color="t.active ? 'primary' : t.tone === 'danger' ? 'error' : 'neutral'" :variant="t.active ? 'soft' : 'ghost'"
                 size="md" class="size-9 justify-center" :data-action="t.id" @click="t.run()" />
      </UTooltip>
    </template>
  </div>
</template>

<style scoped>
.tb {
  display: flex; align-items: center; gap: 2px; padding: 3px; max-width: 100%; overflow-x: auto; scrollbar-width: none;
  background: color-mix(in srgb, var(--bg-1) 92%, transparent);
  border: 1px solid var(--line); border-radius: calc(var(--radius) + 2px);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.tb::-webkit-scrollbar { display: none; }
.tb > * { flex: none; }
.tb :deep(button[data-action]:not([aria-pressed]):not(:disabled)) { color: var(--fg-1); }
</style>
