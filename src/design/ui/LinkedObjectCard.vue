<script setup lang="ts">
/**
 * Prepare: the card for a plate object committed from the design (the Design twin of the
 * CubbyCAD shape panel). The object is generated: its source is a body of the project's design,
 * so the card leads there ("Edit in Design") and says what follows from the link.
 */
import { computed } from 'vue';
import { getObject, selectedIds } from '../../project/store';
import { editInDesign, unlinkObjects } from '../commands';
import { resolveLink } from '../link';
import { design } from '../session';

const obj = computed(() => (selectedIds.value.length === 1 ? getObject(selectedIds.value[0]) : undefined));
const link = computed(() => obj.value?.design ?? obj.value?.parts?.find((p) => p.design)?.design ?? null);
/** An assembly commit: the object's own mesh and its parts each follow a body. */
const assembly = computed(() => (obj.value?.parts ?? []).filter((p) => p.design).length + (obj.value?.design ? 1 : 0));
const loaded = computed(() => design.phase === 'open');
const body = computed(() => (link.value && loaded.value ? resolveLink(link.value, design.bodies) : -1));
const source = computed(() => (link.value && loaded.value ? design.features[link.value.sourceFeature]?.name : undefined));
</script>

<template>
  <section v-if="obj && link" class="lo" aria-label="Design body" data-testid="design-linked-card">
    <header class="lo__head">
      <UIcon name="i-lucide-pencil-ruler" class="lo__icon" />
      <span class="lo__title">{{ assembly > 1 ? 'Design assembly' : 'Design body' }}</span>
      <span class="lo__sub">{{ obj.name }}</span>
    </header>
    <p class="lo__text">
      <template v-if="assembly > 1">An assembly of {{ assembly }} design bodies (a part per body).</template>
      <template v-else-if="loaded && body >= 0">Body {{ body + 1 }}<template v-if="source">, made by <strong>{{ source }}</strong></template>.</template>
      <template v-else-if="loaded">Its body isn’t in the design right now (suppressed or failing); the mesh stays as it was.</template>
      <template v-else>Committed from this project’s design.</template>
      Edits in the Design tab replace this mesh (painting is reset); cut, split or simplify unlink it.
    </p>
    <div class="lo__actions">
      <UButton size="xs" color="primary" variant="soft" icon="i-lucide-pencil-ruler" label="Edit in Design" @click="editInDesign(obj.id)" />
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-unlink" label="Unlink" @click="unlinkObjects([obj.id])" />
    </div>
  </section>
</template>

<style scoped>
.lo {
  width: 280px; max-width: calc(100vw - 24px); display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px;
  background: color-mix(in srgb, var(--bg-1) 94%, transparent); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.lo__head { display: flex; align-items: center; gap: 6px; min-height: 22px; }
.lo__icon { width: 15px; height: 15px; color: var(--ui-primary); flex: none; }
.lo__title { font: 600 var(--fs-sm) var(--font); color: var(--fg-0); }
.lo__sub { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lo__text { margin: 0; font-size: var(--fs-sm); line-height: 1.4; color: var(--fg-1); }
.lo__actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
