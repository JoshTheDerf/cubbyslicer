<script setup lang="ts">
/** Bed shape editor (UModal) for point-list options (printable_area, bed_shape, bed_exclude_area). */
import { computed, ref } from 'vue';
import { formatNumber, parsePoint, serializePoint } from '../../presets/values';

const props = defineProps<{ title: string; points: string[]; allowEmpty?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'apply', v: string[]): void }>();
const open = ref(true);

type Pt = [number, number];
const initial: Pt[] = props.points.map((p) => parsePoint(p)).filter((p): p is Pt => !!p);

function detectRect(pts: Pt[]): { x: number; y: number; w: number; h: number } | null {
  if (pts.length !== 4) return null;
  const xs = [...new Set(pts.map((p) => p[0]))], ys = [...new Set(pts.map((p) => p[1]))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function detectCircle(pts: Pt[]): { cx: number; cy: number; d: number } | null {
  if (pts.length < 16) return null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const r = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  return r.every((x) => Math.abs(x - avg) < avg * 0.01) ? { cx, cy, d: avg * 2 } : null;
}

const rect0 = detectRect(initial);
const circ0 = rect0 ? null : detectCircle(initial);
type Mode = 'rect' | 'circle' | 'custom';
const mode = ref<Mode>(rect0 || (!initial.length && !props.allowEmpty) ? 'rect' : circ0 ? 'circle' : 'custom');
const rect = ref(rect0 ?? { x: 0, y: 0, w: 220, h: 220 });
const circ = ref(circ0 ?? { cx: 0, cy: 0, d: 200 });
const custom = ref(initial.map(serializePoint).join('\n'));
const modeItems = [
  { label: 'Rectangle', value: 'rect', icon: 'i-lucide-square' },
  { label: 'Circle', value: 'circle', icon: 'i-lucide-circle' },
  { label: 'Custom', value: 'custom', icon: 'i-lucide-pentagon' },
];

const pts = computed<Pt[]>(() => {
  if (mode.value === 'rect') {
    const { x, y, w, h } = rect.value;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  if (mode.value === 'circle') {
    const { cx, cy, d } = circ.value;
    const n = 64;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [Math.round((cx + (d / 2) * Math.cos(a)) * 1000) / 1000, Math.round((cy + (d / 2) * Math.sin(a)) * 1000) / 1000] as Pt;
    });
  }
  return custom.value.split(/[\n,;]+/).map((s) => parsePoint(s)).filter((p): p is Pt => !!p);
});
const invalid = computed(() => mode.value === 'custom' && custom.value.split(/[\n,;]+/).some((s) => s.trim() && !parsePoint(s)));
const tooFew = computed(() => pts.value.length > 0 && pts.value.length < 3);

const view = computed(() => {
  const all = pts.value.length ? pts.value : [[0, 0], [100, 100]] as Pt[];
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 + 1;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad, maxY, minY };
});
const poly = computed(() => pts.value.map((p) => `${p[0]},${view.value.maxY + view.value.minY - p[1]}`).join(' '));

function apply(): void {
  if (invalid.value || tooFew.value) return;
  emit('apply', pts.value.map(serializePoint));
  open.value = false;
}
function clear(): void { emit('apply', []); open.value = false; }
const fmt = formatNumber;
const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
</script>

<template>
  <UModal v-model:open="open" :title="title" description="Shape of the printable area, in millimetres." :ui="{ content: 'sm:max-w-xl' }" @after:leave="emit('close')">
    <template #body>
      <UTabs v-model="mode" :items="modeItems" :content="false" size="xs" class="mb-3" />
      <div class="grid grid-cols-[1fr_180px] items-start gap-4">
        <div class="flex flex-col gap-2">
          <template v-if="mode === 'rect'">
            <UFormField label="Width (X)" orientation="horizontal" size="xs"><UInputNumber :model-value="rect.w" :min="0" size="xs" class="w-28" @update:model-value="(v: number | null) => (rect.w = num(v))" /></UFormField>
            <UFormField label="Depth (Y)" orientation="horizontal" size="xs"><UInputNumber :model-value="rect.h" :min="0" size="xs" class="w-28" @update:model-value="(v: number | null) => (rect.h = num(v))" /></UFormField>
            <UFormField label="Origin X" orientation="horizontal" size="xs"><UInputNumber :model-value="rect.x" size="xs" class="w-28" @update:model-value="(v: number | null) => (rect.x = num(v))" /></UFormField>
            <UFormField label="Origin Y" orientation="horizontal" size="xs"><UInputNumber :model-value="rect.y" size="xs" class="w-28" @update:model-value="(v: number | null) => (rect.y = num(v))" /></UFormField>
          </template>
          <template v-else-if="mode === 'circle'">
            <UFormField label="Diameter" orientation="horizontal" size="xs"><UInputNumber :model-value="circ.d" :min="0" size="xs" class="w-28" @update:model-value="(v: number | null) => (circ.d = num(v))" /></UFormField>
            <UFormField label="Center X" orientation="horizontal" size="xs"><UInputNumber :model-value="circ.cx" size="xs" class="w-28" @update:model-value="(v: number | null) => (circ.cx = num(v))" /></UFormField>
            <UFormField label="Center Y" orientation="horizontal" size="xs"><UInputNumber :model-value="circ.cy" size="xs" class="w-28" @update:model-value="(v: number | null) => (circ.cy = num(v))" /></UFormField>
          </template>
          <UFormField v-else label="Points (one &quot;XxY&quot; per line)" size="xs" :error="invalid ? 'Some lines are not valid points.' : undefined">
            <UTextarea v-model="custom" :rows="10" spellcheck="false" class="w-full" :ui="{ base: 'font-mono text-xs' }" />
          </UFormField>
          <p v-if="tooFew" class="text-xs text-error">A shape needs at least 3 points.</p>
        </div>
        <svg class="preview" :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`" preserveAspectRatio="xMidYMid meet" aria-label="Shape preview">
          <polygon v-if="pts.length >= 3" :points="poly" />
          <text :x="view.x + view.w * 0.02" :y="view.y + view.h * 0.08" :font-size="view.w * 0.05">{{ pts.length }} pts</text>
          <text v-if="pts.length" :x="view.x + view.w * 0.02" :y="view.y + view.h * 0.97" :font-size="view.w * 0.045">
            {{ fmt(Math.min(...pts.map((p) => p[0]))) }},{{ fmt(Math.min(...pts.map((p) => p[1]))) }} → {{ fmt(Math.max(...pts.map((p) => p[0]))) }},{{ fmt(Math.max(...pts.map((p) => p[1]))) }}
          </text>
        </svg>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="allowEmpty" variant="ghost" color="error" label="Clear" @click="clear" />
        <UButton variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" label="Apply" :disabled="invalid || tooFew" @click="apply" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.preview { width: 180px; height: 180px; background: var(--ui-bg-muted); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
.preview polygon { fill: color-mix(in srgb, var(--ui-primary) 25%, transparent); stroke: var(--ui-primary); stroke-width: 0.6%; vector-effect: non-scaling-stroke; }
.preview text { fill: var(--ui-text-dimmed); }
</style>
