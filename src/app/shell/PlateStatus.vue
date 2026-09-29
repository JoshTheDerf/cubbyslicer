<script setup lang="ts">
/** Bottom-left plate summary: object/triangle counts and placement problems. */
import { computed } from 'vue';
import { objectIssues, objects, plateStats } from '../../project/store';

const summary = computed(() => {
  let outside = 0, height = 0, exclude = 0, overlap = 0;
  for (const l of objectIssues.value.values()) {
    if (l.includes('outside')) outside++;
    if (l.includes('height')) height++;
    if (l.includes('exclude')) exclude++;
    if (l.includes('overlap')) overlap++;
  }
  const s: Array<{ text: string; blocking: boolean }> = [];
  const n = (k: number, what: string) => `${k} object${k > 1 ? 's' : ''} ${what}`;
  if (outside) s.push({ text: n(outside, 'outside the plate'), blocking: true });
  if (height) s.push({ text: n(height, 'too tall'), blocking: true });
  if (exclude) s.push({ text: n(exclude, 'in an excluded area'), blocking: true });
  if (overlap) s.push({ text: n(overlap, 'overlapping'), blocking: false });
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
    <UBadge v-for="s in summary" :key="s.text" :color="s.blocking ? 'warning' : 'neutral'" variant="subtle" size="sm"
            icon="i-lucide-triangle-alert" :label="s.text" class="font-normal" />
  </div>
</template>
