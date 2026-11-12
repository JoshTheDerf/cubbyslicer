<script setup lang="ts">
/**
 * One side's plugin dock (left / right of the viewport, or below it): a splitter, and one
 * placeholder per docked panel, stacked along the dock as wxAUI stacks the panes of one dock.
 * The panels themselves (PluginWindowFrame.vue) are drawn over the placeholders, so moving a
 * panel between docks never reloads its page.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { DOCK_MIN, dockSlots, dockedOn, observeDockLayout, panes, setDockSize, type DockSide } from '../dockLayout';

const props = defineProps<{ side: DockSide }>();
const handles = computed(() => dockedOn(props.side));
const size = computed(() => panes[handles.value[0]]?.size ?? 320);
const vertical = props.side !== 'bottom';

const root = ref<HTMLElement | null>(null);
let unobserve = () => {};
onMounted(() => { if (root.value) unobserve = observeDockLayout(root.value); });
onBeforeUnmount(() => unobserve());

function slotRef(h: number, el: unknown): void {
  if (el instanceof HTMLElement) dockSlots[h] = el;
  else if (dockSlots[h] && !dockSlots[h].isConnected) delete dockSlots[h];
}

/** The dock may take up to 60% of the area beside it. */
function clamp(v: number): number {
  const area = root.value?.parentElement?.getBoundingClientRect();
  const max = Math.max(DOCK_MIN, 0.6 * (vertical ? area?.width ?? window.innerWidth : area?.height ?? window.innerHeight));
  return Math.min(max, Math.max(DOCK_MIN, v));
}

const dragging = ref(false);
let start = 0, startSize = 0;
const sign = props.side === 'left' ? 1 : -1;
function down(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  start = vertical ? e.clientX : e.clientY;
  startSize = size.value;
  dragging.value = true;
  // Captured: the pointer stays ours over the plugin's iframe.
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent): void {
  if (!dragging.value) return;
  setDockSize(props.side, clamp(startSize + sign * ((vertical ? e.clientX : e.clientY) - start)), false);
}
function up(): void {
  if (!dragging.value) return;
  dragging.value = false;
  setDockSize(props.side, size.value);
}
function key(e: KeyboardEvent): void {
  const grow = props.side === 'left' ? 'ArrowRight' : props.side === 'right' ? 'ArrowLeft' : 'ArrowUp';
  const shrink = props.side === 'left' ? 'ArrowLeft' : props.side === 'right' ? 'ArrowRight' : 'ArrowDown';
  const d = e.key === grow ? 16 : e.key === shrink ? -16 : 0;
  if (d) { e.preventDefault(); setDockSize(props.side, clamp(size.value + d)); }
}
</script>

<template>
  <div ref="root" class="dk" :class="`dk--${side}`" :style="vertical ? { width: `${size}px` } : { height: `${size}px` }"
       :data-testid="`plugin-dock-${side}`">
    <div class="dk__split" :class="{ 'dk__split--on': dragging }" role="separator" :aria-orientation="vertical ? 'vertical' : 'horizontal'"
         :aria-label="`Resize the ${side} plugin dock`" :aria-valuenow="size" :aria-valuemin="DOCK_MIN" tabindex="0"
         :data-testid="`plugin-dock-${side}-splitter`"
         @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key" />
    <div class="dk__slots">
      <div v-for="h in handles" :key="h" :ref="(el) => slotRef(h, el)" class="dk__slot" :data-dock-slot="h" />
    </div>
  </div>
</template>

<style scoped>
.dk { position: relative; flex: none; display: flex; min-width: 0; min-height: 0; background: var(--bg-1); }
.dk--left { flex-direction: row-reverse; border-right: 1px solid var(--line); }
.dk--right { flex-direction: row; border-left: 1px solid var(--line); }
.dk--bottom { flex-direction: column; border-top: 1px solid var(--line); }
.dk__slots { flex: 1; min-width: 0; min-height: 0; display: flex; }
.dk--left .dk__slots, .dk--right .dk__slots { flex-direction: column; }
.dk__slot { flex: 1 1 0; min-width: 0; min-height: 0; }
.dk__slot + .dk__slot { border-top: 1px solid var(--line); }
.dk--bottom .dk__slot + .dk__slot { border-top: 0; border-left: 1px solid var(--line); }
/* The sash on the edge facing the viewport: the dock's own strip, which the panels drawn over the slots never cover. */
.dk__split { flex: none; position: relative; touch-action: none; }
.dk--left .dk__split, .dk--right .dk__split { width: 5px; cursor: col-resize; }
.dk--bottom .dk__split { height: 5px; cursor: row-resize; }
.dk__split::after { content: ''; position: absolute; inset: 0; transition: background 0.12s; }
.dk__split:hover::after, .dk__split--on::after, .dk__split:focus-visible::after { background: var(--accent); }
.dk__split:focus-visible { outline: none; }
</style>
