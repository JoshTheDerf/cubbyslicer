<template>
  <aside class="lg" :class="{ collapsed }" data-testid="preview-legend">
    <!-- Orca: colour-scheme combo heads the legend -->
    <header class="lg-head">
      <USelect
        :model-value="scheme"
        :items="schemeItems"
        size="sm"
        class="flex-1"
        :ui="{ content: 'max-h-[min(22rem,var(--reka-select-content-available-height,22rem))]' }"
        aria-label="Colour scheme"
        data-testid="preview-scheme"
        @update:model-value="emit('update:scheme', $event as ColorScheme)"
        :content="{ onCloseAutoFocus: onSchemeCloseFocus }"
      />
      <UTooltip :text="collapsed ? 'Expand legend' : 'Collapse legend'" :kbds="['L']">
        <UButton
          size="sm"
          variant="ghost"
          :icon="collapsed ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
          :aria-label="collapsed ? 'Expand legend' : 'Collapse legend'"
          @click="collapsed = !collapsed"
        />
      </UTooltip>
    </header>

    <div v-show="!collapsed" class="lg-body">
      <!-- line type table -->
      <div v-if="scheme === 'feature'" :class="{ 'no-usage': !hasUsage }">
        <div class="lg-grid lg-th">
          <span class="col-span-2">Line Type</span>
          <span class="text-right">Time</span>
          <span class="text-right">%</span>
          <span v-if="hasUsage" class="text-right">Usage</span>
          <span class="sr-only">Display</span>
        </div>
        <div
          v-for="f in features"
          :key="f.id"
          class="lg-grid lg-feature"
          :class="{ off: !featureVisible[f.id] }"
          role="checkbox"
          tabindex="0"
          :aria-checked="featureVisible[f.id]"
          :title="`${featureVisible[f.id] ? 'Hide' : 'Show'} ${f.label}`"
          @click="emit('toggleFeature', f.id)"
          @keydown.enter.space.prevent.stop="emit('toggleFeature', f.id)"
        >
          <i class="lg-swatch" :style="{ background: hexCss(f.color) }" />
          <span class="lg-name">{{ f.label }}</span>
          <span class="lg-num">{{ formatDuration(f.time) }}</span>
          <span class="lg-num">{{ f.percent.toFixed(1) }}%</span>
          <span v-if="hasUsage" class="lg-num" :title="usageTitle(f)">{{ usageText(f) }}</span>
          <UIcon :name="featureVisible[f.id] ? 'i-lucide-eye' : 'i-lucide-eye-off'" class="lg-eye" />
        </div>
        <div class="flex gap-1 pt-1">
          <UButton size="xs" variant="link" color="neutral" label="Show all" class="px-1" @click="emit('setAllFeatures', true)" />
          <UButton size="xs" variant="link" color="neutral" label="Hide all" class="px-1" @click="emit('setAllFeatures', false)" />
        </div>
      </div>

      <!-- filament / tool -->
      <template v-else-if="scheme === 'tool'">
        <div class="lg-tools lg-th">
          <span class="col-span-2">Filament</span>
          <span class="text-right">Length</span>
          <span class="text-right">Weight</span>
        </div>
        <div v-for="t in toolRows" :key="t.index" class="lg-tools">
          <i class="lg-swatch" :style="{ background: hexCss(toolColors[t.index] ?? 0x999999) }" />
          <span class="lg-name">Filament {{ t.index + 1 }}</span>
          <span class="lg-num">{{ fmtM(t.mm) }}</span>
          <span class="lg-num">{{ t.g !== null ? `${t.g.toFixed(1)} g` : '–' }}</span>
        </div>
        <div v-if="!toolRows.length" class="text-muted py-1">No extrusion.</div>
        <div v-for="(c, i) in colorChanges ?? []" :key="`cc${i}`" class="lg-tools" data-testid="preview-color-change-row">
          <i class="lg-swatch" :style="{ background: hexCss(c) }" />
          <span class="lg-name col-span-3">Color change {{ i + 1 }}</span>
        </div>
      </template>

      <!-- numeric: Orca-style stepped range list, max at the top -->
      <template v-else>
        <div class="lg-th pb-1">{{ rangeTitle }}</div>
        <div class="lg-range" data-testid="preview-range">
          <div v-for="(s, i) in rangeSteps" :key="i" class="lg-range-row">
            <i class="lg-swatch" :style="{ background: s.color }" />
            <span class="lg-num text-left">{{ s.label }}</span>
          </div>
        </div>
      </template>

      <!-- Options -->
      <USeparator class="my-2" />
      <div class="lg-th pb-1">Options</div>
      <div class="lg-options">
        <UCheckbox
          v-for="o in OPTION_ROWS"
          :key="o.key"
          size="sm"
          :model-value="options[o.key]"
          :ui="{ root: 'items-center', label: 'text-default' }"
          :data-testid="`preview-opt-${o.key}`"
          @update:model-value="setOpt(o.key, $event === true)"
        >
          <template #label>
            <span class="inline-flex items-center gap-1.5">
              <i v-if="o.color !== null" class="lg-swatch lg-swatch-sm" :style="{ background: hexCss(o.color) }" />
              <UIcon v-else :name="o.icon!" class="size-3 text-muted" />
              {{ o.label }}
            </span>
          </template>
        </UCheckbox>
      </div>

      <!-- Summary (Orca "Total Estimation") -->
      <USeparator class="my-2" />
      <div class="lg-th pb-1">{{ scheme === 'feature' ? 'Total Estimation' : 'Time Estimation' }}</div>
      <dl class="lg-stats" data-testid="preview-summary">
        <template v-if="summary.totalMm > 0">
          <dt>Total filament</dt>
          <dd>{{ fmtM(summary.totalMm) }}<template v-if="summary.totalG !== null"> · {{ summary.totalG.toFixed(2) }} g</template></dd>
        </template>
        <template v-if="summary.tools.length > 1">
          <template v-for="t in summary.tools" :key="t.index">
            <dt class="pl-2">Filament {{ t.index + 1 }}</dt>
            <dd>{{ fmtM(t.mm) }}<template v-if="t.g !== null"> · {{ t.g.toFixed(1) }} g</template></dd>
          </template>
        </template>
        <template v-if="summary.totalCost">
          <dt>Cost</dt><dd>{{ summary.totalCost.toFixed(2) }}</dd>
        </template>
        <dt>Layers</dt><dd>{{ summary.layers }}</dd>
        <dt>Max height</dt><dd>{{ summary.maxZ.toFixed(2) }} mm</dd>
        <template v-if="layerTime !== null">
          <dt>Layer {{ currentLayer + 1 }} time</dt><dd>{{ formatDuration(layerTime) }}</dd>
        </template>
        <dt class="font-medium text-highlighted">Total time</dt>
        <dd class="font-medium text-highlighted">
          <UTooltip :text="timeTitle">
            <span>{{ formatDuration(summary.timeSec) }}</span>
          </UTooltip>
          <UBadge v-if="summary.timeSource === 'estimate'" size="sm" variant="subtle" color="warning" label="est." class="ml-1" />
        </dd>
      </dl>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RAMP, SCHEMES, hexCss, rampColor, schemeMeta } from './render/colors';
import type { ColorScheme, ValueRange } from './render/colors';
import { FEATURES, Feature } from './parser/features';
import { formatDuration } from './summary';
import type { FeatureRow, LegendOptions, Summary, ToolRow } from './summary';

const props = defineProps<{
  scheme: ColorScheme;
  features: FeatureRow[];
  featureVisible: boolean[];
  toolRows: ToolRow[];
  toolColors: number[];
  /** Colours after each colour change (Orca colour print). */
  colorChanges?: number[];
  range: ValueRange | null;
  summary: Summary;
  options: LegendOptions;
  currentLayer: number;
  layerTime: number | null;
}>();
const emit = defineEmits<{
  'update:scheme': [ColorScheme];
  toggleFeature: [number];
  setAllFeatures: [boolean];
  'update:options': [LegendOptions];
}>();

const collapsed = defineModel<boolean>('collapsed', { default: false });
const meta = computed(() => schemeMeta(props.scheme));

const schemeItems = SCHEMES.map((s) => ({ label: s.label, value: s.id }));

type OptionRow = { key: keyof LegendOptions; label: string; color: number | null; icon?: string };
const OPTION_ROWS: OptionRow[] = [
  { key: 'travel', label: 'Travel', color: FEATURES[Feature.Travel].color },
  { key: 'wipe', label: 'Wipe', color: FEATURES[Feature.Wipe].color },
  { key: 'retracts', label: 'Retract', color: FEATURES[Feature.Retract].color },
  { key: 'unretracts', label: 'Unretract', color: FEATURES[Feature.Unretract].color },
  { key: 'seams', label: 'Seams', color: FEATURES[Feature.Seam].color },
  { key: 'toolMarker', label: 'Tool marker', color: null, icon: 'i-lucide-map-pin' },
  { key: 'dimBelow', label: 'Dim layers below top', color: null, icon: 'i-lucide-layers' },
];

const hasUsage = computed(() => props.features.some((f) => f.filamentMm !== null));

const rangeTitle = computed(() => (meta.value.unit ? `${meta.value.label} (${meta.value.unit})` : meta.value.label));

/** Orca lists the range as discrete colour steps, highest value first. */
const rangeSteps = computed(() => {
  const r = props.range ?? { min: 0, max: 1 };
  const flat = r.max - r.min < 1e-6;
  const n = flat ? 1 : RAMP.length;
  const out: Array<{ color: string; label: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push({ color: hexCss(rampColor(t)), label: (r.min + (r.max - r.min) * t).toFixed(meta.value.digits) });
  }
  return out;
});

const timeTitle = computed(() =>
  props.summary.timeSource === 'engine' ? 'From the slicing engine'
    : props.summary.timeSource === 'file' ? 'From the G-code header'
      : 'Estimated by the preview (no engine estimate available)');

function usageText(f: FeatureRow): string {
  if (f.filamentG !== null) return `${f.filamentG.toFixed(f.filamentG < 10 ? 2 : 1)} g`;
  return f.filamentMm !== null ? fmtM(f.filamentMm) : '';
}
function usageTitle(f: FeatureRow): string {
  const parts = [f.filamentMm !== null ? fmtM(f.filamentMm) : '', f.filamentG !== null ? `${f.filamentG.toFixed(2)} g` : ''];
  return parts.filter(Boolean).join(' · ');
}

function fmtM(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(0)} mm`;
}

/**
 * Hand the keyboard back to the viewport once the scheme menu closes: reka
 * would refocus the trigger, which swallows ↑/↓ layer stepping (and reopens
 * the menu on arrow keys).
 */
function onSchemeCloseFocus(e: Event) {
  e.preventDefault();
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest('.lg')) el.blur();
}

function setOpt(k: keyof LegendOptions, v: boolean) {
  emit('update:options', { ...props.options, [k]: v });
}
</script>

<style scoped>
.lg {
  width: 324px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  font-size: 12px;
  color: var(--ui-text);
  overflow: hidden;
}
.lg-head { display: flex; gap: 4px; align-items: center; padding: 6px; border-bottom: 1px solid var(--ui-border); }
.lg.collapsed .lg-head { border-bottom: none; }
.lg-body { overflow-y: auto; padding: 6px 8px 10px; }
.lg-th {
  color: var(--ui-text-muted);
  font-size: 11px;
  font-weight: 600;
}
.lg-grid {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 54px 42px 50px 14px;
  align-items: center;
  column-gap: 6px;
  min-height: 22px;
  padding: 0 4px;
}
.no-usage .lg-grid { grid-template-columns: 14px minmax(0, 1fr) 54px 42px 14px; }
.lg-grid.lg-th { min-height: 18px; }
.lg-feature { cursor: pointer; border-radius: calc(var(--ui-radius) * 0.75); outline: none; }
.lg-feature:hover { background: var(--ui-bg-elevated); }
.lg-feature:focus-visible { box-shadow: inset 0 0 0 1px var(--ui-primary); }
.lg-feature.off { opacity: 0.45; }
.lg-feature.off .lg-name { text-decoration: line-through; }
.lg-eye { width: 14px; height: 14px; color: var(--ui-text-muted); }
.lg-feature.off .lg-eye { color: var(--ui-text-dimmed); }
.lg-name { color: var(--ui-text-highlighted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lg-swatch { flex: none; width: 12px; height: 12px; border-radius: 2px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35); display: inline-block; }
.lg-swatch-sm { width: 10px; height: 10px; }
.lg-num { text-align: right; font-family: var(--mono, ui-monospace, monospace); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--ui-text); white-space: nowrap; }
.lg-tools {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 64px 56px;
  align-items: center;
  column-gap: 6px;
  min-height: 22px;
  padding: 0 4px;
}
.lg-range { display: flex; flex-direction: column; gap: 1px; padding: 0 4px; }
.lg-range-row { display: flex; align-items: center; gap: 8px; min-height: 17px; }
.lg-range-row .lg-swatch { width: 22px; height: 14px; }
.lg-options { display: flex; flex-direction: column; gap: 3px; padding: 0 4px; }
.lg-stats { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; padding: 0 4px; }
.lg-stats dt { color: var(--ui-text-muted); }
.lg-stats dd { margin: 0; text-align: right; color: var(--ui-text-highlighted); font-family: var(--mono, ui-monospace, monospace); font-size: 11px; line-height: 18px; font-variant-numeric: tabular-nums; }
</style>
