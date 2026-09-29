<script setup lang="ts">
/**
 * Orca-style menu bar (File / Edit / View / Object / Slice / Help): one
 * UDropdownMenu per MENU_BAR entry, projected from the action registry when
 * opened (labels, ✓ state, gates and kbd chips come from the actions). While
 * one menu is open, hovering another trigger switches to it, like a desktop
 * menu bar.
 */
import { computed, ref } from 'vue';
import { MENU_BAR } from '../actions/layouts/menus';
import { menuItems, toNuxtItems } from './useActions';

defineProps<{ collapsed?: boolean }>();
const openId = ref<string | null>(null);

// Only the open menu is projected (menus read the whole registry).
const items = computed(() => {
  const def = MENU_BAR.find((m) => m.id === openId.value);
  return def ? toNuxtItems(menuItems(def.layout)) : [];
});

// Narrow windows: one "menu" button with each menu as a submenu.
const allOpen = ref(false);
const all = computed(() => (allOpen.value
  ? [MENU_BAR.map((m) => ({ label: m.label, children: toNuxtItems(menuItems(m.layout)) }))]
  : []));

function setOpen(id: string, v: boolean) {
  if (v) openId.value = id;
  else if (openId.value === id) openId.value = null;
}
function hover(id: string) { if (openId.value && openId.value !== id) openId.value = id; }
// Switching menus: don't hand focus back to the old trigger (that would dismiss the new menu).
function onCloseAutoFocus(e: Event) { if (openId.value) e.preventDefault(); }
</script>

<template>
  <UDropdownMenu v-if="collapsed" v-model:open="allOpen" :items="all" :content="{ align: 'start' }" :ui="{ content: 'min-w-48' }">
    <UButton icon="i-lucide-menu" color="neutral" variant="ghost" size="sm" aria-label="Menu" />
  </UDropdownMenu>
  <nav v-else class="flex items-center gap-px" aria-label="Main menu">
    <UDropdownMenu v-for="m in MENU_BAR" :key="m.id" :open="openId === m.id" :items="openId === m.id ? items : []" :modal="false"
                   :content="{ align: 'start', sideOffset: 2, onCloseAutoFocus }" :ui="{ content: 'min-w-56' }" @update:open="setOpen(m.id, $event)">
      <UButton :label="m.label" color="neutral" variant="ghost" size="sm" :data-menu="m.id"
               class="h-7 px-2 font-medium text-toned data-[state=open]:bg-elevated data-[state=open]:text-highlighted"
               @pointerenter="hover(m.id)" />
    </UDropdownMenu>
  </nav>
</template>
