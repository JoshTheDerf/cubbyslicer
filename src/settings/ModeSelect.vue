<script setup lang="ts">
/** Compact Simple / Advanced / Expert switch (Orca's "Advanced" toggle, with our three modes). */
import { computed } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { MODE_LABELS, MODES } from './useLayout';
import { settingsUi } from './uiState';

const DESCRIPTIONS = { simple: 'Essential settings only', advanced: 'Most settings (Orca "Advanced")', expert: 'Every setting' } as const;
const items = computed<DropdownMenuItem[]>(() => MODES.map((m) => ({
  label: MODE_LABELS[m], description: DESCRIPTIONS[m], type: 'checkbox' as const, checked: settingsUi.mode === m,
  onUpdateChecked: () => { settingsUi.mode = m; },
})));
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }" size="sm">
    <UButton size="xs" variant="ghost" trailing-icon="i-lucide-chevron-down" :label="MODE_LABELS[settingsUi.mode]"
             :color="settingsUi.mode === 'simple' ? 'neutral' : 'primary'" aria-label="Settings mode" title="Which settings to show" class="mode-select" />
  </UDropdownMenu>
</template>
