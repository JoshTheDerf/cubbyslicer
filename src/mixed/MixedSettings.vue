<script setup lang="ts">
/**
 * Full Spectrum colour mixing settings (Print Settings ▸ Multimaterial ▸
 * Color Mixing): Local-Z subdivision, gradient cadence, layer cadence and
 * surface options. Labels / tooltips / ranges come from the engine schema.
 */
import { computed } from 'vue';
import { currentPresets } from '../presets/store';
import { MIXED_SETTING_GROUPS, mixedSetting, setMixedSetting } from './store';

const schema = computed(() => currentPresets.value.schema.value?.options ?? {});
const groups = computed(() => MIXED_SETTING_GROUPS.map((g) => ({ ...g, keys: g.keys.filter((k) => schema.value[k]) })).filter((g) => g.keys.length));

const isBool = (k: string) => schema.value[k]?.type === 'bool';
const isPercent = (k: string) => schema.value[k]?.type === 'percent';
const num = (k: string) => parseFloat(mixedSetting(k)) || 0;
const on = (k: string) => ['1', 'true'].includes(mixedSetting(k));
function setNum(k: string, v: unknown): void {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  setMixedSetting(k, isPercent(k) ? `${n}%` : String(n));
}
const step = (k: string) => (schema.value[k]?.type === 'int' ? 1 : isPercent(k) ? 1 : 0.01);
</script>

<template>
  <div class="ms">
    <section v-for="g in groups" :key="g.title" class="ms__grp">
      <h4 class="ms__title">{{ g.title }}</h4>
      <div v-for="k in g.keys" :key="k" class="ms__row" :title="schema[k].tooltip">
        <template v-if="isBool(k)">
          <UCheckbox :model-value="on(k)" :label="schema[k].label" size="sm" @update:model-value="(v: unknown) => setMixedSetting(k, v ? '1' : '0')" />
        </template>
        <template v-else>
          <span class="ms__lbl">{{ schema[k].label }}</span>
          <UInputNumber :model-value="num(k)" :min="schema[k].min ?? undefined" :max="schema[k].max ?? undefined" :step="step(k)" size="xs" class="w-28"
                        :format-options="{ maximumFractionDigits: 3 }" :aria-label="schema[k].label" @update:model-value="(v: unknown) => setNum(k, v)" />
          <span class="ms__unit">{{ isPercent(k) ? '%' : schema[k].sidetext }}</span>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ms { display: flex; flex-direction: column; gap: 8px; }
.ms__grp { display: flex; flex-direction: column; gap: 4px; }
.ms__title { margin: 0; font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-2); }
.ms__row { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.ms__lbl { flex: 1; min-width: 0; font-size: var(--fs-xs); color: var(--fg-1); }
.ms__unit { width: 22px; font-size: var(--fs-xs); color: var(--fg-2); }
</style>
