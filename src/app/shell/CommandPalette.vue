<script setup lang="ts">
/**
 * Command palette (Ctrl/⌘+K, Ctrl/⌘+Shift+P): UCommandPalette in a UModal.
 * Items come from the registry's palette projection; ranking + recents are
 * ours (src/app/actions/project/palette.ts), so the component's Fuse filter
 * is bypassed (`ignoreFilter`) and it just renders the ranked groups.
 * A query also lists matching settings (process, filament, printer); picking
 * one jumps to it.
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
import { currentPresets } from '../../presets/store';
import { buildSearchIndex, searchSettings } from '../../settings/search';
import { jumpToSetting, settingsLayout } from '../../settings/useLayout';
import { panelRequest } from '../../settings/uiState';

const TAB_LABEL = { process: 'Process', filament: 'Filament', printer: 'Printer' } as const;
const TAB_ICON = { process: 'i-lucide-layers', filament: 'i-lucide-disc', printer: 'i-lucide-printer' } as const;
const SETTINGS_SHOWN = 8;
const settingsIndex = computed(() => {
  const s = currentPresets.value.schema.value;
  return ui.paletteOpen && s && settingsLayout.value ? buildSearchIndex(s, settingsLayout.value) : [];
});

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
    suffix: [withCategory ? it.category : '', it.current ? 'current' : ''].filter(Boolean).join(' · ') || undefined,
    icon: it.icon ?? 'i-lucide-terminal',
    kbds: it.kbds,
    onSelect: () => { void choose(it); },
  };
}

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
  const q = search.value.trim();
  if (q) {
    const out: CommandPaletteGroup<CommandPaletteItem>[] = [];
    const cmds = rankPalette(all.value, q, recentActionIds.value);
    if (cmds.length) out.push({ id: 'results', label: 'Commands', ignoreFilter: true, items: cmds.map((i) => toItem(i, true)) });
    const hits = q.length >= 2 ? searchSettings(settingsIndex.value, q, SETTINGS_SHOWN + 1) : [];
    if (hits.length) {
      out.push({
        id: 'settings', label: 'Settings', ignoreFilter: true,
        items: hits.slice(0, SETTINGS_SHOWN).map((h) => ({
          id: `setting:${h.key}`, label: h.label, icon: TAB_ICON[h.tab],
          suffix: `${TAB_LABEL[h.tab]} › ${h.pageTitle}${h.groupTitle ? ` › ${h.groupTitle}` : ''}`,
          onSelect: () => { ui.paletteOpen = false; void nextTick(() => jumpToSetting(h.key)); },
        })),
      });
      if (hits.length > SETTINGS_SHOWN) {
        out.at(-1)!.items!.push({
          id: 'settings:all', label: `Search all settings for “${q}”`, icon: 'i-lucide-search',
          onSelect: () => { ui.paletteOpen = false; panelRequest.searchTerm = q; panelRequest.focusSearch++; },
        });
      }
    }
    return out;
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
      <UCommandPalette v-model:search-term="search" :groups="groups" placeholder="Search commands and settings…" close autofocus
                       :ui="{ root: 'h-[min(460px,72vh)]', itemLabelSuffix: 'text-dimmed text-xs' }"
                       :empty="`No commands or settings match “${search}”.`" @update:open="(v: boolean) => (ui.paletteOpen = v)" />
    </template>
  </UModal>
</template>
