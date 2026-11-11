<script setup lang="ts">
/**
 * Over the viewport while a reference row picks: which row, what it holds, Done / Clear /
 * Cancel — and, for an existing feature, that the view shows the design as it was before it
 * (its references name that geometry).
 */
import { computed } from 'vue';
import { bindingTokensOf } from '../../app/shell/useActions';
import { cancelPick, clearPick, finishPick, picking, pickText } from '../pick';

const spec = computed(() => picking.spec);
const multi = computed(() => spec.value?.kind === 'faces' || spec.value?.kind === 'edges');
</script>

<template>
  <div v-if="spec" class="pb" role="status" data-testid="design-pick-banner">
    <UIcon :name="picking.rollingBack ? 'i-lucide-loader-circle' : 'i-lucide-mouse-pointer-click'" class="pb__icon" :class="{ 'animate-spin': picking.rollingBack }" />
    <div class="pb__text">
      <span class="pb__title">{{ spec.label }}: <strong>{{ pickText(picking.value, spec.kind) }}</strong></span>
      <span class="pb__sub">
        <template v-if="picking.rollingBack">Rolling the design back to before this feature…</template>
        <template v-else-if="picking.rollbackError">{{ picking.rollbackError }}</template>
        <template v-else-if="picking.rollback">Showing the design before {{ picking.rollback.name }} — its references name that geometry. </template>
        <template v-if="!picking.rollingBack">{{ spec.prompt }}{{ multi ? '; click one again to remove it' : '' }}.</template>
      </span>
    </div>
    <UButton v-if="picking.value?.ids.length" size="xs" color="neutral" variant="ghost" label="Clear" @click="clearPick()" />
    <UButton size="xs" color="neutral" variant="soft" label="Cancel" :kbds="bindingTokensOf('design.pick.cancel')" @click="cancelPick()" />
    <UButton size="xs" color="primary" label="Done" :kbds="bindingTokensOf('design.pick.done')" data-testid="design-pick-done" @click="finishPick()" />
  </div>
</template>

<style scoped>
.pb {
  position: absolute; z-index: var(--z-toolbar); top: 58px; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100% - 24px);
  display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; font-size: var(--fs-sm); color: var(--fg-0);
  background: color-mix(in srgb, var(--bg-1) 94%, transparent); border: 1px solid color-mix(in srgb, var(--vp-cad-ref, #f2a33a) 65%, transparent);
  border-radius: 12px; box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.pb__icon { width: 16px; height: 16px; color: var(--vp-cad-ref, #f2a33a); flex: none; }
.pb__text { display: flex; flex-direction: column; min-width: 0; }
.pb__title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb__sub { font-size: var(--fs-xs); color: var(--fg-2); overflow-wrap: anywhere; }
.pb--low { top: 108px; }
:global(.dv--phone) .pb { top: 8px; }
:global(.dv--phone) .pb.pb--low { top: 56px; }
</style>
