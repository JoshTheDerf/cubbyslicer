<script setup lang="ts">
/** Mounts the physical-printer dialogs and registers the printer.* actions. Mounted once from App.vue. */
import { onBeforeUnmount } from 'vue';
import PhysicalPrinterDialog from './PhysicalPrinterDialog.vue';
import PrintHostSendDialog from './PrintHostSendDialog.vue';
import { registerPrinthostActions } from './actions';

onBeforeUnmount(registerPrinthostActions());
</script>

<template>
  <PhysicalPrinterDialog />
  <PrintHostSendDialog />
</template>
