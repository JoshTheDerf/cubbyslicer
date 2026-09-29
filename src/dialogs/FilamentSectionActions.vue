<script setup lang="ts">
/**
 * Buttons in the sidebar's Filament section header, like Orca's Sidebar:
 * "Flushing volumes" when more than one filament is loaded, and filament
 * grouping for multi-nozzle printers.
 */
import { computed } from 'vue';
import { compact } from '../app/shell/uiState';
import { filamentCount, isMultiNozzle } from './gates';
import { openDialog } from './state';

const showFlush = computed(() => filamentCount() > 1);
const showMap = computed(() => isMultiNozzle());
</script>

<template>
  <UButton v-if="showMap" size="xs" variant="ghost" icon="i-lucide-split" :square="compact" :label="compact ? undefined : 'Grouping'"
           aria-label="Filament grouping" title="Filament grouping (left / right nozzle)" @click="openDialog('filamentMap')" />
  <UButton v-if="showFlush" size="xs" variant="ghost" icon="i-lucide-droplets" :square="compact" :label="compact ? undefined : 'Flushing volumes'"
           aria-label="Flushing volumes" title="Flushing volumes for filament change" @click="openDialog('flushing')" />
</template>
