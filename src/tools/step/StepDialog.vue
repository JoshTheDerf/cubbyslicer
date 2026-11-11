<script setup lang="ts">
/**
 * STEP import options (Orca StepMeshDialog): linear / angular deflection and
 * "split compound and compsolid into multiple objects". Remembered locally.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { STEP_DEFAULTS, STEP_LIMITS, setStepOptionsProvider, type StepOptions } from '../../project/import/step';
import { readJson, writeJson } from '../../lib/storage';
import AppDialog from '../../ui/AppDialog.vue';
import { preferences } from '../../app/preferences';

const LS_KEY = 'cubby-slicer:step-import';
const load = (): StepOptions => ({ ...STEP_DEFAULTS, ...readJson<Partial<StepOptions>>(LS_KEY) });

const req = shallowRef<{ name: string; resolve: (o: StepOptions | null) => void } | null>(null);
const opts = ref<StepOptions>(load());
const open = computed({ get: () => !!req.value, set: (v: boolean) => { if (!v) answer(false); } });

const linOk = computed(() => opts.value.linearDeflection > STEP_LIMITS.linear[0] - 1e-9 && opts.value.linearDeflection <= STEP_LIMITS.linear[1] + 1e-9);
const angOk = computed(() => opts.value.angularDeflection > STEP_LIMITS.angular[0] - 1e-9 && opts.value.angularDeflection <= STEP_LIMITS.angular[1] + 1e-9);

function answer(ok: boolean): void {
  const r = req.value;
  req.value = null;
  if (ok) writeJson(LS_KEY, opts.value);
  r?.resolve(ok ? { ...opts.value } : null);
}
function answerDesign(): void {
  const r = req.value;
  req.value = null;
  r?.resolve({ ...opts.value, toDesign: true });
}
function resetDefaults(): void { opts.value = { ...STEP_DEFAULTS }; }

onMounted(() => setStepOptionsProvider((name) => new Promise((resolve) => {
  req.value?.resolve(null);
  opts.value = load();
  req.value = { name, resolve };
})));
onBeforeUnmount(() => setStepOptionsProvider(null));
</script>

<template>
  <AppDialog v-model:open="open" title="STEP import" :description="req ? `Tessellation settings for ${req.name}` : ''" size="md">
      <div class="dlg-flow flex flex-col gap-4">
        <p class="dlg-span text-xs text-muted">Smaller linear and angular deflections result in higher-quality meshes but increase the processing time.</p>
        <UFormField label="Linear deflection" :error="linOk ? undefined : `Enter a value between ${STEP_LIMITS.linear[0]} and ${STEP_LIMITS.linear[1]}`" hint="mm">
          <UInputNumber :step-snapping="false" v-model="opts.linearDeflection" :min="STEP_LIMITS.linear[0]" :max="STEP_LIMITS.linear[1]" :step="0.001"
                        :format-options="{ maximumFractionDigits: 4 }" class="w-40" aria-label="Linear deflection (mm)" />
        </UFormField>
        <UFormField label="Angle deflection" :error="angOk ? undefined : `Enter a value between ${STEP_LIMITS.angular[0]} and ${STEP_LIMITS.angular[1]}`" hint="rad">
          <UInputNumber :step-snapping="false" v-model="opts.angularDeflection" :min="STEP_LIMITS.angular[0]" :max="STEP_LIMITS.angular[1]" :step="0.01"
                        :format-options="{ maximumFractionDigits: 3 }" class="w-40" aria-label="Angle deflection (radians)" />
        </UFormField>
        <UCheckbox v-model="opts.split" class="dlg-span" label="Split compound and compsolid into multiple objects" />
      </div>
    <template #footer>
      <div class="flex gap-2 w-full">
        <UButton variant="ghost" label="Defaults" @click="resetDefaults" />
        <span class="flex-1" />
        <UButton variant="ghost" label="Cancel" @click="answer(false)" />
        <UTooltip v-if="preferences.designTab" text="Open the solids as exact bodies in the Design tab (faces and edges you can fillet, shell, drill…), then commit them to the plate">
          <UButton color="neutral" variant="outline" icon="i-lucide-pencil-ruler" label="Open in Design" data-testid="step-open-in-design" @click="answerDesign" />
        </UTooltip>
        <UButton color="primary" label="Import" :disabled="!linOk || !angOk" autofocus @click="answer(true)" />
      </div>
    </template>
  </AppDialog>
</template>
