<script setup lang="ts">
/**
 * A Nuxt UI dropdown opened at a screen point: the viewport's right-click menu.
 * (UContextMenu opens on the native `contextmenu` event, which fires on
 * right-button DOWN on Linux/macOS — i.e. at the start of an orbit drag. The
 * scene reports a right *click* without drag instead, so we anchor a dropdown
 * to that point.)
 */
import type { DropdownMenuItem } from '@nuxt/ui';

defineProps<{ x: number; y: number; items: DropdownMenuItem[][] }>();
const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <UDropdownMenu v-model:open="open" :items="items" :content="{ align: 'start', side: 'bottom', sideOffset: 0 }" :ui="{ content: 'min-w-52' }">
    <span class="fixed size-px pointer-events-none" :style="{ left: `${x}px`, top: `${y}px` }" aria-hidden="true" />
  </UDropdownMenu>
</template>
