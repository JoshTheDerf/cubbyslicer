<script setup lang="ts">
/** Bottom-left plate summary: object/triangle counts and placement problems (click one to select those objects). */
import { computed } from 'vue';
import { objectIssues, objects, plateStats, select } from '../../project/store';

const KINDS = [
  { issue: 'outside', what: 'outside the plate', blocking: true },
  { issue: 'height', what: 'too tall', blocking: true },
  { issue: 'exclude', what: 'in an excluded area', blocking: true },
  { issue: 'overlap', what: 'overlapping', blocking: false },
] as const;

const summary = computed(() => {
  const s: Array<{ text: string; blocking: boolean; ids: string[] }> = [];
  for (const k of KINDS) {
    const ids = [...objectIssues.value].filter(([, l]) => l.includes(k.issue)).map(([id]) => id);
    if (ids.length) s.push({ text: `${ids.length} object${ids.length > 1 ? 's' : ''} ${k.what}`, blocking: k.blocking, ids });
  }
  return s;
});
const tris = computed(() => {
  const t = plateStats.value.triangles;
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${Math.round(t / 1e3)}k` : String(t);
});
</script>

<template>
  <div v-if="objects.length" class="flex flex-wrap items-center gap-1.5 pointer-events-none">
    <UBadge color="neutral" variant="subtle" size="sm" class="bg-default/80 text-muted font-normal">
      {{ objects.length }} object{{ objects.length > 1 ? 's' : '' }}, {{ tris }} triangles
    </UBadge>
    <UButton v-for="s in summary" :key="s.text" :color="s.blocking ? 'warning' : 'neutral'" variant="subtle" size="xs"
             icon="i-lucide-triangle-alert" :label="s.text" class="pointer-events-auto font-normal"
             :title="`Select ${s.ids.length > 1 ? 'them' : 'it'}`" @click="select(s.ids)" />
  </div>
</template>
