<script setup lang="ts">
/**
 * STEP import options (Orca StepMeshDialog): linear / angular deflection and
 * "split compound and compsolid into multiple objects". Remembered locally.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { STEP_DEFAULTS, STEP_LIMITS, setStepOptionsProvider, type StepOptions } from '../../project/import/step';

const LS_KEY = 'cubby-slicer:step-import';
function load(): StepOptions {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') as Partial<StepOptions> | null;
    if (p) return { ...STEP_DEFAULTS, ...p };
  } catch { /* defaults */ }
  return { ...STEP_DEFAULTS };
}

const req = shallowRef<{ name: string; resolve: (o: StepOptions | null) => void } | null>(null);
const opts = ref<StepOptions>(load());
const open = computed({ get: () => !!req.value, set: (v: boolean) => { if (!v) answer(false); } });

const linOk = computed(() => opts.value.linearDeflection > STEP_LIMITS.linear[0] - 1e-9 && opts.value.linearDeflection <= STEP_LIMITS.linear[1] + 1e-9);
const angOk = computed(() => opts.value.angularDeflection > STEP_LIMITS.angular[0] - 1e-9 && opts.value.angularDeflection <= STEP_LIMITS.angular[1] + 1e-9);

function answer(ok: boolean): void {
  const r = req.value;
  req.value = null;
  if (ok) { try { localStorage.setItem(LS_KEY, JSON.stringify(opts.value)); } catch { /* ignore */ } }
  r?.resolve(ok ? { ...opts.value } : null);
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
  <UModal v-model:open="open" title="STEP import" :description="req ? `Tessellation settings for ${req.name}` : ''" :ui="{ content: 'sm:max-w-md' }">
    <template #body>
      <div class="dlg-flow flex flex-col gap-4">
        <p class="dlg-span text-xs text-muted">Smaller linear and angular deflections result in higher-quality meshes but increase the processing time.</p>
        <UFormField label="Linear deflection" :error="linOk ? undefined : `Enter a value between ${STEP_LIMITS.linear[0]} and ${STEP_LIMITS.linear[1]}`" hint="mm">
          <UInputNumber v-model="opts.linearDeflection" :min="STEP_LIMITS.linear[0]" :max="STEP_LIMITS.linear[1]" :step="0.001"
                        :format-options="{ maximumFractionDigits: 4 }" class="w-40" aria-label="Linear deflection (mm)" />
        </UFormField>
        <UFormField label="Angle deflection" :error="angOk ? undefined : `Enter a value between ${STEP_LIMITS.angular[0]} and ${STEP_LIMITS.angular[1]}`" hint="rad">
          <UInputNumber v-model="opts.angularDeflection" :min="STEP_LIMITS.angular[0]" :max="STEP_LIMITS.angular[1]" :step="0.01"
                        :format-options="{ maximumFractionDigits: 3 }" class="w-40" aria-label="Angle deflection (radians)" />
        </UFormField>
        <UCheckbox v-model="opts.split" class="dlg-span" label="Split compound and compsolid into multiple objects" />
      </div>
    </template>
    <template #footer>
      <div class="flex gap-2 w-full">
        <UButton variant="ghost" label="Defaults" @click="resetDefaults" />
        <span class="flex-1" />
        <UButton variant="ghost" label="Cancel" @click="answer(false)" />
        <UButton color="primary" label="Import" :disabled="!linOk || !angOk" autofocus @click="answer(true)" />
      </div>
    </template>
  </UModal>
</template>
