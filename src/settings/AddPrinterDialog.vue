<script setup lang="ts">
/** "Add / remove printers" dialog (AppDialog) around the shared printer browser. */
import { ref } from 'vue';
import type { EnginePresets } from '../presets/store';
import PrinterBrowser from './PrinterBrowser.vue';
import AppDialog from '../ui/AppDialog.vue';

defineProps<{ presets: EnginePresets }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const open = ref(true);
</script>

<template>
  <AppDialog v-model:open="open" title="Add / remove printers" description="Add printers to your list, or pick one to use now." size="5xl" fullscreen
             body-class="flex flex-col overflow-hidden" @after:leave="emit('close')">
    <PrinterBrowser :presets="presets" @use="open = false" />
  </AppDialog>
</template>
