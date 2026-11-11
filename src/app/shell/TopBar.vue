<script setup lang="ts">
/**
 * Orca's title / menu bar: brand + menus + quick buttons (save, undo, redo)
 * on the left, the Design | Prepare | Preview switch centred, and the slice controls
 * (progress, "Slice plate", "Export G-code") at the far right.
 */
import { computed } from 'vue';
import SliceBar from '../SliceBar.vue';
import { activeView } from '../state';
import { historyState, projectName } from '../../project/store';
import MenuBar from './MenuBar.vue';
import BrandMark from './BrandMark.vue';
import { bindingTokensOf, run } from './useActions';
import { compact, phone, sidebarOpen } from './uiState';
import { cloud, isCloudDirty } from '../../cloud/store';
import { isLocalDirty, local } from '../../localfs/store';
import { cloudOpenDialog } from '../../cloud/commands';
import BridgeChip from '../../bridge/BridgeChip.vue';
import { activePluginPage, pluginPages } from '../../plugins/state';
import { preferences } from '../preferences';

/** Plugin page tabs shown before the rest go into "More" (Orca's "Visible plugin pages"). */
const VISIBLE_PAGES = 3;
const views = computed(() => [
  // Orca 2.5's Design tab (experimental, src/design): first, as in Orca's tab order.
  ...(preferences.designTab ? [{ value: 'design', label: 'Design', icon: 'i-lucide-pencil-ruler', ...(compact.value ? {} : { badge: { label: 'Exp', color: 'warning' as const, variant: 'subtle' as const, size: 'sm' as const } }), 'aria-label': 'Design (experimental)', 'data-testid': 'tab-design' }] : []),
  { value: 'prepare', label: 'Prepare', icon: 'i-lucide-box' },
  { value: 'preview', label: 'Preview', icon: 'i-lucide-layers' },
  // Orca 2.5 plugin pages (Pages capabilities), beside Prepare / Preview.
  ...pluginPages.value.slice(0, VISIBLE_PAGES).map((t) => ({ value: `page:${t.key}`, label: t.name, icon: 'i-lucide-panels-top-left' })),
]);
const morePages = computed(() => [pluginPages.value.slice(VISIBLE_PAGES).map((t) => ({
  label: t.name, icon: 'i-lucide-panels-top-left', onSelect: () => { activePluginPage.value = t.key; },
}))]);
// Narrow screens: icon-only view switch.
const viewItems = computed(() => (phone.value ? views.value.map((v) => ({ ...v, label: '' , 'aria-label': v.label })) : views.value));
const view = computed({
  get: () => (activePluginPage.value ? `page:${activePluginPage.value}` : activeView.value),
  set: (v: string | number) => {
    const s = String(v);
    if (s.startsWith('page:')) { activePluginPage.value = s.slice(5); return; }
    activePluginPage.value = null;
    activeView.value = s === 'preview' ? 'preview' : s === 'design' ? 'design' : 'prepare';
  },
});

// Where the project lives in CubbyCAD (click: open another file there).
const cloudLabel = computed(() => cloud.location ? `${cloud.location.workspaceName} / ${cloud.location.path}` : '');
const cloudDirty = computed(() => isCloudDirty());
const localLabel = computed(() => (local.location ? (local.location.folder ? `${local.location.folder} / ${local.location.name}` : local.location.name) : ''));
const localDirty = computed(() => isLocalDirty());

function onName(e: Event) {
  const el = e.target as HTMLInputElement;
  projectName.value = el.value.trim() || 'Untitled project';
  el.value = projectName.value;
}
</script>

<template>
  <header class="top" :class="{ 'top--phone': phone, 'top--compact': compact }">
    <div class="top__left">
      <UTooltip :text="sidebarOpen() ? 'Hide sidebar' : 'Show sidebar'" :kbds="bindingTokensOf('view.panel.sidebar')">
        <UButton :icon="sidebarOpen() ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'" color="neutral" variant="ghost" size="sm"
                 :aria-label="sidebarOpen() ? 'Hide sidebar' : 'Show sidebar'" :aria-pressed="sidebarOpen()" @click="run('view.panel.sidebar')" />
      </UTooltip>
      <div v-if="!phone" class="brand" aria-label="CubbySlicer">
        <BrandMark class="brand__mark" />
        <span class="brand__name">CubbySlicer</span>
      </div>
      <MenuBar :collapsed="compact" />
      <USeparator v-if="!phone" orientation="vertical" class="h-5 mx-1" />
      <UTooltip v-if="!phone" text="Save project" :kbds="bindingTokensOf('file.save')">
        <UButton icon="i-lucide-save" color="neutral" variant="ghost" size="sm" aria-label="Save project" @click="run('file.save')" />
      </UTooltip>
      <UTooltip v-if="!phone" :text="historyState.undo ? `Undo ${historyState.undo.toLowerCase()}` : 'Undo'" :kbds="bindingTokensOf('edit.undo')">
        <UButton icon="i-lucide-undo-2" color="neutral" variant="ghost" size="sm" aria-label="Undo" :disabled="!historyState.undo" @click="run('edit.undo')" />
      </UTooltip>
      <UTooltip v-if="!phone" :text="historyState.redo ? `Redo ${historyState.redo.toLowerCase()}` : 'Redo'" :kbds="bindingTokensOf('edit.redo')">
        <UButton icon="i-lucide-redo-2" color="neutral" variant="ghost" size="sm" aria-label="Redo" :disabled="!historyState.redo" @click="run('edit.redo')" />
      </UTooltip>
    </div>

    <div class="top__center">
      <!-- Manual activation: focus coming back to a tab (closing the palette, a dialog) must not switch views. -->
      <UTabs v-model="view" :items="viewItems" :content="false" size="sm" variant="pill" color="neutral" activation-mode="manual"
             :ui="{ list: 'bg-elevated/60 p-0.5', indicator: 'bg-accented', trigger: `${phone ? 'px-3' : compact ? 'px-3' : 'px-5'} data-[state=active]:text-highlighted` }" aria-label="View" />
      <UDropdownMenu v-if="morePages[0].length" :items="morePages">
        <UButton icon="i-lucide-chevron-down" color="neutral" variant="ghost" size="sm" aria-label="More plugin pages" />
      </UDropdownMenu>
    </div>

    <div class="top__right">
      <UTooltip v-if="cloud.location && !phone" :text="cloudDirty ? `${cloudLabel} (unsaved changes)` : `Saved in CubbyCAD: ${cloudLabel}`" :kbds="cloudDirty ? bindingTokensOf('file.save') : undefined">
        <UButton :icon="cloudDirty ? 'i-lucide-cloud-alert' : 'i-lucide-cloud-check'" color="neutral" variant="ghost" size="sm"
                 :class="{ 'top__cloud--dirty': cloudDirty }" :aria-label="cloudDirty ? 'Unsaved changes: save to CubbyCAD' : 'Open from CubbyCAD'"
                 @click="cloudDirty ? run('file.save') : cloudOpenDialog()" />
      </UTooltip>
      <UTooltip v-if="local.location && !phone" :text="localDirty ? `${localLabel} (unsaved changes)` : `Saved on this computer: ${localLabel}`" :kbds="localDirty ? bindingTokensOf('file.save') : undefined">
        <UButton :icon="localDirty ? 'i-lucide-hard-drive-download' : 'i-lucide-hard-drive'" color="neutral" variant="ghost" size="sm"
                 :class="{ 'top__cloud--dirty': localDirty }" :aria-label="localDirty ? 'Unsaved changes: save to the local file' : `Local file ${localLabel}`"
                 @click="run('file.save')" />
      </UTooltip>
      <input v-if="!phone" class="top__name" :value="projectName" aria-label="Project name" :title="`${projectName} (click to rename)`" spellcheck="false" maxlength="80"
             @change="onName" @keydown.enter="($event.target as HTMLInputElement).blur()" />
      <BridgeChip />
      <UTooltip v-if="!phone" text="Search commands" :kbds="bindingTokensOf('help.palette')">
        <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="sm" aria-label="Search commands" @click="run('help.palette')" />
      </UTooltip>
      <USeparator v-if="!phone" orientation="vertical" class="h-5 mx-1" />
      <SliceBar />
    </div>
  </header>
</template>

<style scoped>
.top {
  height: var(--topbar-h); flex: none;
  /* The view switch stays centred while the left side fits; when it doesn't (menus at ~1100–1400 px), the
     left keeps its full width and the switch moves right instead of covering redo. */
  display: grid; grid-template-columns: minmax(max-content, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px;
  padding: 0 8px; background: var(--bg-1); border-bottom: 1px solid var(--line);
}
.top__left, .top__right { display: flex; align-items: center; gap: 2px; min-width: 0; }
.top__right { justify-content: flex-end; }
.brand { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 2px; color: var(--fg-0); }
.brand__mark { width: 20px; height: 20px; flex: none; }
.brand__name { font: 600 var(--fs-lg) / 1 var(--font); letter-spacing: -0.01em; white-space: nowrap; }
.top__name {
  /* The one flexible item on the right: it gives way first, so the slice / print controls never spill off the page. */
  flex: 0 1 160px; width: 160px; min-width: 60px; height: 26px; padding: 0 8px;
  font: var(--fs-md) var(--font); color: var(--fg-1); text-align: right;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); text-overflow: ellipsis;
}
.top__cloud--dirty { color: var(--warn); }
.top__name:hover { border-color: var(--line); }
.top__name:focus { outline: none; color: var(--fg-0); text-align: left; border-color: var(--info); background: var(--bg-2); }
/* Phone: no centred grid — left tools, view switch, slice controls in one row that never overflows. */
.top--phone { display: flex; gap: 4px; padding: 0 4px; padding-top: env(safe-area-inset-top); height: calc(var(--topbar-h) + env(safe-area-inset-top)); }
.top--phone .top__left { flex: none; }
.top--phone .top__center { flex: 1; display: flex; justify-content: center; min-width: 0; }
.top--phone .top__right { flex: none; }
.top--compact { gap: 6px; }
@media (max-width: 1500px) { .brand__name { display: none; } }
</style>
