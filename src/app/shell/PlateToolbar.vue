<script setup lang="ts">
/**
 * Orca's horizontal plater toolbar centred over the 3D view, projected from
 * the action registry (PLATE_TOOLBAR). Tooltips show the action's shortcut.
 * Menu entries (Paint) open a dropdown; groups that don't fit the view fold,
 * from the end, into a "More tools" menu.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { PLATE_TOOLBAR } from '../actions/layouts/toolbar';
import type { ToolEntry, ToolGroupEntry } from '../actions/project/toolbar';
import { useToolbar } from './useActions';

/** Horizontal room the toolbar leaves free in the view (px). */
const props = withDefaults(defineProps<{ reserve?: number }>(), { reserve: 220 });

const groups = useToolbar(PLATE_TOOLBAR);

// Fixed metrics (size-9 buttons, 2px gaps, separator with mx-1, 3px padding + border).
const BTN = 36, GAP = 2, SEP = 9 + 2 * GAP, FRAME = 8, SEG_PAD = 4;
const groupWidth = (g: ToolGroupEntry) => g.items.length * BTN + (g.items.length - 1) * GAP + (g.segmented ? SEG_PAD : 0);

const root = ref<HTMLElement | null>(null);
const avail = ref(Infinity);
let ro: ResizeObserver | null = null;
onMounted(() => {
  const host = root.value?.parentElement?.offsetParent as HTMLElement | null;
  if (!host) return;
  ro = new ResizeObserver(() => { avail.value = host.clientWidth - props.reserve; });
  ro.observe(host);
});
onBeforeUnmount(() => ro?.disconnect());

const fit = computed(() => {
  const gs = groups.value;
  let w = FRAME - SEP;
  for (let k = 0; k < gs.length; k++) {
    w += SEP + groupWidth(gs[k]);
    const rest = k < gs.length - 1 ? SEP + BTN : 0;
    if (w + rest > avail.value) return Math.max(1, k);
  }
  return gs.length;
});
const shown = computed(() => groups.value.slice(0, fit.value));
const folded = computed(() => groups.value.slice(fit.value));
const foldedActive = computed(() => folded.value.some((g) => g.items.some((t) => t.active)));

const color = (t: ToolEntry) => (t.active ? 'primary' : t.tone === 'danger' && !t.disabled ? 'error' : 'neutral');

function menuItem(t: ToolEntry): DropdownMenuItem {
  if (t.children) return { label: t.label, icon: t.icon, disabled: t.disabled, children: [t.children.map(menuItem)] };
  return {
    label: t.label, icon: t.icon, kbds: t.kbds, disabled: t.disabled, type: 'checkbox', checked: t.active,
    color: t.tone === 'danger' ? 'error' : undefined, onSelect: () => t.run(),
  };
}
const foldedItems = computed<DropdownMenuItem[][]>(() =>
  folded.value.map((g) => [{ type: 'label', label: g.label }, ...g.items.map(menuItem)]));
</script>

<template>
  <div ref="root" class="tb" role="toolbar" aria-label="Plate tools">
    <template v-for="(g, gi) in shown" :key="g.label">
      <USeparator v-if="gi" orientation="vertical" class="h-6 mx-1" />
      <div class="tb__g" :class="{ 'tb__g--seg': g.segmented }" role="group" :aria-label="g.label">
        <template v-for="t in g.items" :key="t.id">
          <UDropdownMenu v-if="t.children" :items="[t.children.map(menuItem)]" :content="{ side: 'bottom', sideOffset: 6 }">
            <UTooltip :text="t.label" :content="{ side: 'bottom', sideOffset: 6 }">
              <UButton :icon="t.icon" :aria-label="t.label" :aria-pressed="t.active || undefined" :disabled="t.disabled"
                       :color="color(t)" :variant="t.active ? 'soft' : 'ghost'" size="md" class="size-9 justify-center tb__menu"
                       :data-action="t.id" />
            </UTooltip>
          </UDropdownMenu>
          <UTooltip v-else :text="t.label" :kbds="t.kbds" :content="{ side: 'bottom', sideOffset: 6 }">
            <UButton :icon="t.icon" :aria-label="t.label" :aria-pressed="t.active || undefined" :disabled="t.disabled"
                     :color="color(t)" :variant="t.active ? 'soft' : 'ghost'"
                     size="md" class="size-9 justify-center" :data-action="t.id" @click="t.run()" />
          </UTooltip>
        </template>
      </div>
    </template>
    <template v-if="folded.length">
      <USeparator orientation="vertical" class="h-6 mx-1" />
      <UDropdownMenu :items="foldedItems" :content="{ side: 'bottom', align: 'end', sideOffset: 6 }">
        <UTooltip text="More tools" :content="{ side: 'bottom', sideOffset: 6 }">
          <UButton icon="i-lucide-ellipsis" aria-label="More tools" :aria-pressed="foldedActive || undefined"
                   :color="foldedActive ? 'primary' : 'neutral'" :variant="foldedActive ? 'soft' : 'ghost'"
                   size="md" class="size-9 justify-center" data-action="toolbar.more" />
        </UTooltip>
      </UDropdownMenu>
    </template>
  </div>
</template>

<style scoped>
.tb {
  display: flex; align-items: center; gap: 2px; padding: 3px; max-width: 100%;
  background: color-mix(in srgb, var(--bg-1) 92%, transparent);
  border: 1px solid var(--line); border-radius: calc(var(--radius) + 2px);
  box-shadow: var(--shadow); backdrop-filter: blur(6px);
}
.tb > * { flex: none; }
.tb__g { display: flex; align-items: center; gap: 2px; }
/* Transform modes: one segmented control (only one gizmo is open at a time). */
.tb__g--seg { padding: 2px; margin: -2px 0; background: var(--bg-2); border-radius: var(--radius); }
/* Menu buttons get a corner caret so they read as "opens a list". */
.tb__menu { position: relative; }
.tb__menu::after {
  content: ''; position: absolute; right: 4px; bottom: 4px;
  border: 3px solid transparent; border-right-color: currentColor; border-bottom-color: currentColor; opacity: .7;
}
.tb :deep(button[data-action]:not([aria-pressed]):not(:disabled)) { color: var(--fg-1); }
</style>
