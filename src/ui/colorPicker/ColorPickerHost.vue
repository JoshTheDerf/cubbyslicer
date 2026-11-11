<script setup lang="ts">
/**
 * Where the colour picker opens: a popover under its swatch on desktop, Orca's "Color Picker" dialog
 * as a bottom sheet on phones (src/ui/mobileDialog.ts), where a popover under a sidebar swatch has
 * no room. `#trigger` is the swatch button, the default slot the picker.
 */
import { mobileDialog } from '../mobileDialog';

const open = defineModel<boolean>('open', { required: true });
</script>

<template>
  <UPopover v-if="!mobileDialog" v-model:open="open" :content="{ side: 'bottom', align: 'start' }">
    <slot name="trigger" />
    <template #content><slot /></template>
  </UPopover>
  <template v-else>
    <span class="contents" @click="open = true"><slot name="trigger" /></span>
    <UModal v-model:open="open" title="Color Picker" :ui="{ body: 'p-0 sm:p-0' }">
      <template #body><slot /></template>
    </UModal>
  </template>
</template>
