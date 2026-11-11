<script setup lang="ts">
/** Mounts the physical-printer dialogs. Mounted once from App.vue. */
import PhysicalPrinterDialog from './PhysicalPrinterDialog.vue';
import PrintHostSendDialog from './PrintHostSendDialog.vue';
</script>

<template>
  <PhysicalPrinterDialog />
  <PrintHostSendDialog />
</template>
