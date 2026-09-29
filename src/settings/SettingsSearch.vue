<script setup lang="ts">
/** Global settings search (UModal + UCommandPalette) across process, filament and printer settings. */
import { computed, ref, watch } from 'vue';
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui';
import { currentPresets } from '../presets/store';
import { buildSearchIndex, searchSettings } from './search';
import { jumpToSetting, settingsLayout } from './useLayout';

const open = defineModel<boolean>('open', { default: false });
const term = ref('');
watch(open, (o) => { if (o) term.value = ''; });

const TAB_LABEL = { process: 'Process', filament: 'Filament', printer: 'Printer' } as const;
const TAB_ICON = { process: 'i-lucide-layers', filament: 'i-lucide-disc', printer: 'i-lucide-printer' } as const;
const index = computed(() => {
  const s = currentPresets.value.schema.value;
  return s && settingsLayout.value && open.value ? buildSearchIndex(s, settingsLayout.value) : [];
});

interface Hit extends CommandPaletteItem { key: string }
const groups = computed<CommandPaletteGroup<Hit>[]>(() => {
  const hits = searchSettings(index.value, term.value, 60);
  return [{
    id: 'settings', label: term.value.trim() ? `${hits.length === 60 ? '60+' : hits.length} matching settings` : undefined, ignoreFilter: true,
    items: hits.map((h) => ({
      key: h.key, label: h.label, icon: TAB_ICON[h.tab],
      suffix: `${TAB_LABEL[h.tab]} › ${h.pageTitle}${h.groupTitle ? ` › ${h.groupTitle}` : ''}`,
    })),
  }];
});

async function onSelect(item: unknown): Promise<void> {
  const k = (item as Hit | null)?.key;
  if (!k) return;
  open.value = false;
  await jumpToSetting(k);
}
</script>

<template>
  <UModal v-model:open="open" title="Search settings" :ui="{ content: 'sm:max-w-xl' }">
    <template #content>
      <UCommandPalette v-model:search-term="term" :groups="groups" placeholder="Search settings by name, key or description…" close autofocus
                       class="h-[440px]" @update:open="(v: boolean) => (open = v)" @update:model-value="onSelect">
        <template #empty>
          <div class="p-4 text-center text-sm text-muted">{{ term.trim() ? `No settings match “${term}”` : 'Type to search every printer, filament and process setting.' }}</div>
        </template>
      </UCommandPalette>
    </template>
  </UModal>
</template>
