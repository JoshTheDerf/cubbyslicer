<script setup lang="ts">
/** "Add / remove printers" dialog (UModal) around the shared printer browser. */
import { ref } from 'vue';
import type { EnginePresets } from '../presets/store';
import PrinterBrowser from './PrinterBrowser.vue';
import { mobileDialog } from '../ui/mobileDialog';

defineProps<{ presets: EnginePresets }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const open = ref(true);
</script>

<template>
  <UModal v-model:open="open" title="Add / remove printers" description="Add printers to your list, or pick one to use now." :fullscreen="mobileDialog"
          :ui="{ content: 'sm:max-w-5xl', body: 'flex flex-col overflow-hidden' }" @after:leave="emit('close')">
    <template #body>
      <PrinterBrowser :presets="presets" @use="open = false" />
    </template>
  </UModal>
</template>
