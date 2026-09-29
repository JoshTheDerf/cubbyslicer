<script setup lang="ts">
/**
 * Command palette (Ctrl/⌘+K, Ctrl/⌘+Shift+P): UCommandPalette in a UModal.
 * Items come from the registry's palette projection; ranking + recents are
 * ours (src/app/actions/project/palette.ts), so the component's Fuse filter
 * is bypassed (`ignoreFilter`) and it just renders the ranked groups.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui';
import { getActionContext } from '../actions/context';
import { recentActionIds, recordRecent } from '../actions/recent';
import { actionsRevision, getAllActions } from '../actions/registry';
import { runAction } from '../actions/run';
import { projectPalette, rankPalette, sectionPalette, type PaletteItem } from '../actions/project/palette';
import { platform } from './useActions';
import { ui } from './uiState';

const search = ref('');
watch(() => ui.paletteOpen, (v) => { if (v) search.value = ''; });

const all = computed<PaletteItem[]>(() => {
  void actionsRevision.value;
  if (!ui.paletteOpen) return [];
  const ctx = getActionContext();
  return ctx ? projectPalette(getAllActions(), ctx, platform) : [];
});

function toItem(it: PaletteItem, withCategory: boolean): CommandPaletteItem {
  return {
    id: it.id,
    label: it.label,
    suffix: withCategory ? it.category : undefined,
    icon: it.icon ?? 'i-lucide-terminal',
    kbds: it.kbds,
    onSelect: () => { void choose(it); },
  };
}

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
  const q = search.value.trim();
  if (q) {
    return [{ id: 'results', label: '', ignoreFilter: true, items: rankPalette(all.value, q, recentActionIds.value).map((i) => toItem(i, true)) }];
  }
  return sectionPalette(all.value, recentActionIds.value).map((s) => ({
    id: s.id, label: s.label, ignoreFilter: true, items: s.items.map((i) => toItem(i, false)),
  }));
});

async function choose(it: PaletteItem) {
  ui.paletteOpen = false;
  recordRecent(it.id);
  await nextTick();
  const ctx = getActionContext();
  if (ctx) void runAction(it.action, ctx);
}
</script>

<template>
  <UModal v-model:open="ui.paletteOpen" title="Command palette" description="Search and run any command"
          :ui="{ content: 'max-w-xl sm:top-[12vh] sm:translate-y-0' }">
    <template #content>
      <UCommandPalette v-model:search-term="search" :groups="groups" placeholder="Type a command…" close autofocus
                       :ui="{ root: 'h-[min(460px,72vh)]', itemLabelSuffix: 'text-dimmed text-xs' }"
                       :empty="`No commands match “${search}”.`" @update:open="(v: boolean) => (ui.paletteOpen = v)" />
    </template>
  </UModal>
</template>
