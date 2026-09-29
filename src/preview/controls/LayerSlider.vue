<template>
  <!-- Orca DoubleSliderForLayers: vertical, right edge, labels left of the thumbs. -->
  <div class="ls" :class="{ disabled: count <= 0 }" data-testid="preview-layer-slider">
    <UTooltip text="Next layer" :kbds="['↑']" :content="{ side: 'left' }">
      <UButton size="xs" variant="ghost" icon="i-lucide-chevron-up" aria-label="Next layer" :disabled="hi >= count - 1" @click="setHandle('hi', hi + 1)" />
    </UTooltip>
    <div class="ls-max" :title="`${count} layers`">{{ count }}</div>

    <div class="ls-rail" @wheel.prevent="onWheel">
      <div
        ref="track"
        class="ls-track"
        @pointerdown="onTrackDown"
        @pointermove="onHover"
        @pointerleave="hover = null"
      >
        <div class="ls-groove" />
        <div class="ls-fill" :style="{ bottom: pct(lo), top: `calc(100% - ${pct(hi)})` }" />
        <button
          class="ls-handle"
          :style="{ bottom: pct(hi) }"
          aria-label="Top layer"
          role="slider"
          aria-orientation="vertical"
          :aria-valuemin="0"
          :aria-valuemax="count - 1"
          :aria-valuenow="hi"
          :aria-valuetext="`Layer ${hi + 1}, Z ${fmtZ(hi)} mm`"
          data-testid="preview-layer-hi"
          @pointerdown.stop="startDrag($event, 'hi')"
          @keydown="onKey($event, 'hi')"
          @contextmenu.prevent.stop="canEdit && emit('menu', { x: $event.clientX, y: $event.clientY, layer: hi })"
        />
        <button
          v-if="!single"
          class="ls-handle ls-handle-lo"
          :style="{ bottom: pct(lo) }"
          aria-label="Bottom layer"
          role="slider"
          aria-orientation="vertical"
          :aria-valuemin="0"
          :aria-valuemax="count - 1"
          :aria-valuenow="lo"
          :aria-valuetext="`Layer ${lo + 1}, Z ${fmtZ(lo)} mm`"
          data-testid="preview-layer-lo"
          @pointerdown.stop="startDrag($event, 'lo')"
          @keydown="onKey($event, 'lo')"
        />
        <!-- Orca IMSlider ticks: colour changes / pauses / custom G-code -->
        <button
          v-for="t in ticks ?? []"
          :key="`${t.layer}:${t.item.type}`"
          type="button"
          class="ls-tick"
          :class="`ls-tick--${t.item.type}`"
          :style="{ bottom: pct(t.layer), '--tick': t.color }"
          :title="t.title"
          :aria-label="t.title"
          data-testid="preview-layer-tick"
          @pointerdown.stop
          @click.stop="setHandle('hi', t.layer)"
          @contextmenu.prevent.stop="emit('menu', { x: $event.clientX, y: $event.clientY, layer: t.layer })"
        />
        <UTooltip v-if="canEdit && hi > 0" :text="plusTitle" :content="{ side: 'right' }">
          <button
            type="button"
            class="ls-plus"
            :class="{ 'ls-plus--on': tickAtHi }"
            :style="{ bottom: pct(hi) }"
            :aria-label="plusTitle"
            data-testid="preview-layer-plus"
            @pointerdown.stop
            @click.stop="tickAtHi ? emit('menu', { x: $event.clientX, y: $event.clientY, layer: hi }) : emit('add', { x: $event.clientX, y: $event.clientY, layer: hi })"
          >
            <UIcon :name="tickAtHi ? 'i-lucide-pencil' : 'i-lucide-plus'" class="size-2.5" />
          </button>
        </UTooltip>
        <!-- thumb labels (layer number + print Z) -->
        <div class="ls-label ls-label-hi" :style="{ bottom: pct(hi) }" data-testid="preview-layer-label">
          <span class="ls-num">{{ hi + 1 }}</span>
          <span class="ls-z">{{ fmtZ(hi) }}</span>
        </div>
        <div v-if="!single && lo > 0 && hi - lo > 1" class="ls-label ls-label-lo" :style="{ bottom: pct(lo) }">
          <span class="ls-num">{{ lo + 1 }}</span>
          <span class="ls-z">{{ fmtZ(lo) }}</span>
        </div>
        <!-- Orca: hovering the rail previews the layer under the cursor -->
        <div v-if="hover !== null && hover !== hi && hover !== lo" class="ls-label ls-label-hover" :style="{ bottom: pct(hover) }">
          <span class="ls-num">{{ hover + 1 }}</span>
          <span class="ls-z">{{ fmtZ(hover) }}</span>
        </div>
      </div>
    </div>

    <div class="ls-max">1</div>
    <UTooltip text="Previous layer" :kbds="['↓']" :content="{ side: 'left' }">
      <UButton size="xs" variant="ghost" icon="i-lucide-chevron-down" aria-label="Previous layer" :disabled="hi <= (single ? 0 : lo)" @click="setHandle('hi', hi - 1)" />
    </UTooltip>
    <UTooltip :text="single ? 'Showing one layer — show all layers below' : 'Show only the current layer'" :content="{ side: 'left' }">
      <UButton
        size="xs"
        :variant="single ? 'soft' : 'ghost'"
        :color="single ? 'primary' : 'neutral'"
        :icon="single ? 'i-lucide-square' : 'i-lucide-layers'"
        :aria-pressed="single"
        aria-label="One layer mode"
        data-testid="preview-single-layer"
        @click="single = !single"
      />
    </UTooltip>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SliderTick } from '../customGcode';

const props = defineProps<{
  /** Number of layers. */
  count: number;
  /** Bottom visible layer (0-based). */
  lo: number;
  /** Top visible layer (0-based). */
  hi: number;
  /** Z per layer (mm) for labels. */
  zs?: ArrayLike<number> | null;
  /** Custom G-code markers (Orca IMSlider ticks). */
  ticks?: SliderTick[];
  /** Show the "+" button / right-click menus for custom G-codes. */
  canEdit?: boolean;
}>();
const emit = defineEmits<{
  'update:lo': [number]; 'update:hi': [number];
  /** "+" at the top thumb: add a colour change (or filament change) on `layer`. */
  add: [{ x: number; y: number; layer: number }];
  /** Right-click on the thumb / a tick: add / edit menu for `layer`. */
  menu: [{ x: number; y: number; layer: number }];
}>();
const tickAtHi = computed(() => (props.ticks ?? []).some((t) => t.layer === props.hi));
const plusTitle = computed(() => (tickAtHi.value ? 'Edit the custom G-code on this layer' : 'Add color change (right-click the thumb for more)'));
/** One-layer mode: a single thumb, the bottom follows the top. */
const single = defineModel<boolean>('single', { default: false });

const track = ref<HTMLDivElement | null>(null);
const hover = ref<number | null>(null);

function pct(v: number): string {
  if (props.count <= 1) return '0%';
  return `${(v / (props.count - 1)) * 100}%`;
}

function fmtZ(i: number): string {
  const z = props.zs?.[i];
  return z === undefined ? '' : z.toFixed(2);
}

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

function setHandle(which: 'lo' | 'hi', v: number) {
  const max = Math.max(0, props.count - 1);
  if (which === 'hi') {
    const h = clamp(Math.round(v), single.value ? 0 : props.lo, max);
    emit('update:hi', h);
    if (single.value) emit('update:lo', h);
  } else emit('update:lo', clamp(Math.round(v), 0, props.hi));
}

function valueAt(clientY: number): number {
  const el = track.value;
  if (!el || props.count <= 1) return 0;
  const r = el.getBoundingClientRect();
  const f = 1 - (clientY - r.top) / Math.max(1, r.height);
  return clamp(f, 0, 1) * (props.count - 1);
}

function startDrag(e: PointerEvent, which: 'lo' | 'hi') {
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  target.focus();
  hover.value = null;
  const move = (ev: PointerEvent) => setHandle(which, valueAt(ev.clientY));
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

function onTrackDown(e: PointerEvent) {
  const v = valueAt(e.clientY);
  const which = single.value || Math.abs(v - props.hi) <= Math.abs(v - props.lo) || v > props.hi ? 'hi' : 'lo';
  setHandle(which, v);
  // keep dragging the chosen thumb
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => setHandle(which, valueAt(ev.clientY));
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function onHover(e: PointerEvent) {
  if (e.buttons) { hover.value = null; return; }
  hover.value = props.count > 0 ? Math.round(valueAt(e.clientY)) : null;
}

function onKey(e: KeyboardEvent, which: 'lo' | 'hi') {
  const step = e.shiftKey ? 10 : 1;
  const cur = which === 'hi' ? props.hi : props.lo;
  let handled = true;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setHandle(which, cur + step);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setHandle(which, cur - step);
  else if (e.key === 'PageUp') setHandle(which, cur + 10);
  else if (e.key === 'PageDown') setHandle(which, cur - 10);
  else if (e.key === 'Home') setHandle(which, which === 'hi' && !single.value ? props.lo : 0);
  else if (e.key === 'End') setHandle(which, which === 'hi' ? props.count - 1 : props.hi);
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function onWheel(e: WheelEvent) {
  const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
  setHandle('hi', props.hi + step);
}
</script>

<style scoped>
.ls {
  width: 40px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  user-select: none;
  touch-action: none;
}
.ls.disabled { opacity: 0.4; pointer-events: none; }
.ls-max { font-family: var(--mono, ui-monospace, monospace); font-size: 10px; color: var(--ui-text-dimmed); line-height: 12px; }
.ls-rail { flex: 1; min-height: 60px; width: 100%; display: flex; justify-content: center; padding: 10px 0; }
.ls-track { position: relative; width: 20px; height: 100%; cursor: pointer; }
.ls-groove, .ls-fill {
  position: absolute;
  left: 50%;
  width: 4px;
  transform: translateX(-50%);
  border-radius: 2px;
}
.ls-groove { top: 0; bottom: 0; background: var(--ui-bg-accented); }
.ls-fill { background: var(--ui-primary); }
.ls-handle {
  position: absolute;
  left: 50%;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  transform: translate(-50%, 50%);
  border-radius: 50%;
  border: 2px solid var(--ui-primary);
  background: var(--ui-bg);
  cursor: grab;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
  z-index: 1;
}
.ls-handle:active { cursor: grabbing; }
.ls-handle:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.ls-handle-lo { width: 12px; height: 12px; background: var(--ui-bg-elevated); }
.ls-tick {
  position: absolute;
  left: calc(50% - 9px);
  width: 18px;
  height: 4px;
  margin: 0;
  padding: 0;
  transform: translateY(50%);
  border: 0;
  border-radius: 2px;
  background: var(--tick);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.45);
  cursor: pointer;
  z-index: 2;
}
.ls-tick--pause, .ls-tick--custom, .ls-tick--template { height: 3px; width: 14px; left: calc(50% - 7px); }
.ls-tick:hover { transform: translateY(50%) scale(1.25); }
.ls-plus {
  position: absolute;
  left: calc(50% + 11px);
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 0;
  transform: translateY(50%);
  border-radius: 50%;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
  cursor: pointer;
  z-index: 3;
}
.ls-plus:hover, .ls-plus--on { border-color: var(--ui-primary); color: var(--ui-primary); }
.ls-label {
  position: absolute;
  right: 26px;
  transform: translateY(50%);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 2px 6px;
  border-radius: calc(var(--ui-radius) * 0.75);
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border-accented);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
}
.ls-label-hi { border-color: color-mix(in srgb, var(--ui-primary) 60%, var(--ui-border)); }
.ls-label-hover { opacity: 0.85; background: var(--ui-bg); z-index: 2; }
.ls-num { color: var(--ui-text-highlighted); font-weight: 600; }
.ls-z { color: var(--ui-text-muted); }
</style>
