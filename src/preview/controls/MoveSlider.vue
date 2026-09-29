<template>
  <!-- Orca horizontal (sequential) slider: moves within the top layer. -->
  <div class="ms" :class="{ disabled: max < 0 }" data-testid="preview-move-slider">
    <UFieldGroup size="xs">
      <UTooltip :text="playing ? 'Pause' : 'Play moves'">
        <UButton
          :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
          :color="playing ? 'primary' : 'neutral'"
          variant="soft"
          :aria-label="playing ? 'Pause' : 'Play moves'"
          data-testid="preview-play"
          @click="togglePlay"
        />
      </UTooltip>
      <UTooltip text="First move of layer">
        <UButton icon="i-lucide-chevrons-left" variant="soft" aria-label="First move" @click="stop(); set(0)" />
      </UTooltip>
      <UTooltip text="Previous move" :kbds="['←']">
        <UButton icon="i-lucide-chevron-left" variant="soft" aria-label="Previous move" @click="stop(); set(value - 1)" />
      </UTooltip>
    </UFieldGroup>

    <div
      ref="track"
      class="ms-track"
      role="slider"
      tabindex="0"
      aria-label="Move in layer"
      :aria-valuemin="0"
      :aria-valuemax="max"
      :aria-valuenow="value"
      @pointerdown="onDown"
      @keydown="onKey"
      @wheel.prevent="set(value + (($event.deltaY < 0) ? 1 : -1) * ($event.shiftKey ? 10 : 1))"
    >
      <div class="ms-groove" />
      <div class="ms-fill" :style="{ width: pct }" />
      <div class="ms-handle" :style="{ left: pct }" />
      <!-- Orca shows the current G-code line in a popup above the thumb -->
      <div v-if="$slots.popup && max >= 0" class="ms-popup" :style="popupStyle" data-testid="preview-move-popup">
        <slot name="popup" />
      </div>
    </div>

    <UFieldGroup size="xs">
      <UTooltip text="Next move" :kbds="['→']">
        <UButton icon="i-lucide-chevron-right" variant="soft" aria-label="Next move" @click="stop(); set(value + 1)" />
      </UTooltip>
      <UTooltip text="Last move of layer">
        <UButton icon="i-lucide-chevrons-right" variant="soft" aria-label="Last move" @click="stop(); set(max)" />
      </UTooltip>
    </UFieldGroup>
    <span class="ms-count" data-testid="preview-move-count">{{ max < 0 ? '–' : `${(value + 1).toLocaleString()} / ${(max + 1).toLocaleString()}` }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  /** Last move index (count - 1); -1 when the layer has no moves. */
  max: number;
  value: number;
}>();
const emit = defineEmits<{ 'update:value': [number] }>();

const track = ref<HTMLDivElement | null>(null);
const playing = ref(false);
let raf = 0;

const frac = computed(() => (props.max <= 0 ? 1 : props.value / props.max));
const pct = computed(() => `${frac.value * 100}%`);
/** Keep the popup inside the track: anchor left/centre/right by thumb position. */
const popupStyle = computed(() => {
  const f = frac.value;
  const shift = f < 0.15 ? '0%' : f > 0.85 ? '-100%' : '-50%';
  return { left: pct.value, transform: `translateX(${shift})` };
});

function set(v: number) {
  emit('update:value', Math.max(0, Math.min(props.max, Math.round(v))));
}

function valueAt(clientX: number): number {
  const el = track.value;
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * props.max;
}

function onDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  el.focus();
  stop();
  set(valueAt(e.clientX));
  const move = (ev: PointerEvent) => set(valueAt(ev.clientX));
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function onKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 1;
  let handled = true;
  if (e.key === 'ArrowRight') set(props.value + step);
  else if (e.key === 'ArrowLeft') set(props.value - step);
  else if (e.key === 'Home') set(0);
  else if (e.key === 'End') set(props.max);
  else if (e.key === ' ') togglePlay();
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function stop() {
  playing.value = false;
  cancelAnimationFrame(raf);
  raf = 0;
}

function togglePlay() {
  if (playing.value) { stop(); return; }
  if (props.max < 0) return;
  playing.value = true;
  let v = props.value >= props.max ? 0 : props.value;
  let last = performance.now();
  // ~ whole layer in 4 s, at least 30 moves/s
  const rate = Math.max(30, (props.max + 1) / 4);
  const tick = (now: number) => {
    if (!playing.value) return;
    v += ((now - last) / 1000) * rate;
    last = now;
    if (v >= props.max) { set(props.max); stop(); return; }
    set(v);
    raf = requestAnimationFrame(tick);
  };
  set(v);
  raf = requestAnimationFrame(tick);
}

watch(() => props.max, stop);
onBeforeUnmount(stop);
defineExpose({ stop, playing });
</script>

<style scoped>
.ms {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  user-select: none;
}
.ms.disabled { opacity: 0.4; pointer-events: none; }
.ms-track {
  position: relative;
  flex: 1;
  height: 24px;
  margin: 0 8px;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.ms-groove, .ms-fill {
  position: absolute;
  left: 0;
  top: 50%;
  height: 4px;
  transform: translateY(-50%);
  border-radius: 2px;
}
.ms-groove { right: 0; background: var(--ui-bg-accented); }
.ms-fill { background: var(--ui-primary); }
.ms-handle {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 2px solid var(--ui-primary);
  background: var(--ui-bg);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
}
.ms-track:focus-visible .ms-handle { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.ms-popup {
  position: absolute;
  bottom: calc(100% + 8px);
  max-width: min(640px, 100%);
  padding: 3px 8px;
  border: 1px solid var(--ui-border-accented);
  border-radius: calc(var(--ui-radius) * 0.75);
  background: var(--ui-bg-elevated);
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.4);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
}
.ms-count {
  min-width: 96px;
  text-align: right;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
}
</style>
