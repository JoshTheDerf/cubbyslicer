<script setup lang="ts">
/** Name prompt / confirmation dialog (UModal). Parent validates and sets `error`. */
import { ref } from 'vue';

const props = defineProps<{
  title: string;
  message?: string;
  label?: string;
  initial?: string;
  error?: string | null;
  /** Buttons (last = primary). Without `label` it's a pure confirmation. */
  actions?: Array<{ id: string; text: string; danger?: boolean }>;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'submit', action: string, value: string): void }>();
const open = ref(true);
const value = ref(props.initial ?? '');
const acts = props.actions ?? [{ id: 'cancel', text: 'Cancel' }, { id: 'ok', text: 'OK' }];
function submit(id: string): void {
  if (id === 'cancel') { open.value = false; return; }
  emit('submit', id, value.value);
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="label !== undefined ? message : undefined" :ui="{ content: 'sm:max-w-md' }"
          @after:leave="emit('close')">
    <template #body>
      <p v-if="message && label === undefined" class="text-sm text-muted whitespace-pre-wrap">{{ message }}</p>
      <UFormField v-if="label !== undefined" :label="label" :error="error ?? undefined">
        <UInput v-model="value" autofocus spellcheck="false" class="w-full" @keydown.enter.prevent="submit(acts[acts.length - 1].id)" />
      </UFormField>
      <p v-else-if="error" class="mt-2 text-sm text-error">{{ error }}</p>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton v-for="(a, i) in acts" :key="a.id" :label="a.text"
                 :color="a.danger ? 'error' : i === acts.length - 1 ? 'primary' : 'neutral'" :variant="i === acts.length - 1 || a.danger ? 'solid' : 'ghost'"
                 @click="submit(a.id)" />
      </div>
    </template>
  </UModal>
</template>
