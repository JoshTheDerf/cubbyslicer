<script setup lang="ts">
/**
 * A reference row (faces, edges, a body, a point on a face): what it holds, a Pick toggle that
 * puts the viewport in this field's pick mode (Orca's [Pick Face A] buttons), and Clear.
 * Multi-pick rows list their ids as chips; clicking a chip removes it.
 */
import { computed } from 'vue';
import { finishPick, picking, pickText, startPick, type PickHit, type PickKind, type PickValue } from '../pick';

const props = defineProps<{
  /** Unique per owner + row: `card:edges`, `editor:shell_face`. */
  pickKey: string;
  kind: PickKind;
  label: string;
  prompt: string;
  value: PickValue | null;
  disabled?: boolean;
  /** Existing feature: pick on the design as it was before this feature. */
  rollbackBefore?: number;
  accept?: (hit: PickHit) => string | null | Promise<string | null>;
  /** Shown instead of "(none)" when empty (e.g. "(all faces — closed hollow)"). */
  emptyText?: string;
  /** Icon-only Pick button, no value text (next to a select that shows the value). */
  compact?: boolean;
}>();
const emit = defineEmits<{ (e: 'update', v: PickValue | null): void }>();

const active = computed(() => picking.spec?.key === props.pickKey);
const shown = computed(() => (active.value ? picking.value : props.value));
const multi = computed(() => props.kind === 'faces' || props.kind === 'edges');
const text = computed(() => (!shown.value?.ids.length && props.kind !== 'body' && props.emptyText ? props.emptyText : pickText(shown.value, props.kind)));

function toggle() {
  if (active.value) { finishPick(); return; }
  startPick({ key: props.pickKey, kind: props.kind, label: props.label, prompt: props.prompt, accept: props.accept }, props.value, (v) => emit('update', v),
    props.rollbackBefore !== undefined ? { rollbackBefore: props.rollbackBefore } : {});
}
function clear() {
  if (active.value) { picking.value = null; }
  emit('update', null);
}
function dropId(id: number) {
  const v = shown.value;
  if (!v) return;
  const next = { ...v, ids: v.ids.filter((x) => x !== id) };
  if (active.value) picking.value = next;
  emit('update', next.ids.length ? next : null);
}
</script>

<template>
  <div class="rf" :class="{ 'rf--active': active }" :data-pick="pickKey">
    <div class="rf__row">
      <span v-if="!compact" class="rf__text" :class="{ 'rf__text--empty': !shown?.ids.length && kind !== 'body' }">{{ text }}</span>
      <UTooltip :text="active ? 'Done picking (Enter)' : prompt">
        <UButton size="xs" :color="active ? 'primary' : 'neutral'" :variant="active ? 'solid' : 'soft'" :icon="active ? 'i-lucide-check' : 'i-lucide-mouse-pointer-click'"
                 :label="compact ? undefined : active ? 'Done' : 'Pick'" :disabled="disabled" :aria-pressed="active" :aria-label="`${active ? 'Done picking' : 'Pick'} ${label}`" data-testid="ref-pick" @click="toggle" />
      </UTooltip>
      <UButton v-if="shown?.ids.length && kind !== 'body' && !active" size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Clear ${label}`" :disabled="disabled" @click="clear" />
    </div>
    <div v-if="multi && shown && shown.ids.length > 1" class="rf__chips">
      <button v-for="id in shown.ids" :key="id" type="button" class="rf__chip" :disabled="disabled" :aria-label="`Remove ${kind === 'faces' ? 'face' : 'edge'} ${id}`" @click="dropId(id)">
        {{ kind === 'faces' ? 'F' : 'E' }}{{ id }}<UIcon name="i-lucide-x" class="size-3" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.rf { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; border-radius: var(--radius-sm); }
.rf--active { outline: 1px solid color-mix(in srgb, var(--vp-cad-ref, #f2a33a) 70%, transparent); outline-offset: 3px; }
.rf__row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.rf__text { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rf__text--empty { color: var(--fg-2); }
.rf__cancel { flex: none; }
.rf__chips { display: flex; flex-wrap: wrap; gap: 3px; }
.rf__chip {
  display: inline-flex; align-items: center; gap: 2px; padding: 0 4px 0 6px; height: 20px; border-radius: 10px; font: var(--fs-xs) var(--mono); color: var(--fg-0); cursor: pointer;
  background: color-mix(in srgb, var(--vp-cad-ref, #f2a33a) 22%, transparent); border: 1px solid color-mix(in srgb, var(--vp-cad-ref, #f2a33a) 50%, transparent);
}
.rf__chip:hover { background: color-mix(in srgb, var(--danger) 25%, transparent); }
@media (pointer: coarse) { .rf__chip { height: 28px; } }
</style>
