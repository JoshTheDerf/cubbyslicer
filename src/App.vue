<script setup lang="ts">
/**
 * Cubby Slicer shell, laid out like OrcaSlicer's main window:
 *  - top: menu/title bar, Prepare | Preview switch, slice controls (TopBar);
 *  - left: the sidebar (printer / filament / process settings, rendered by
 *    the settings area) with our object list in its `#objects` slot;
 *    resizable, a slide-over drawer below 1100px;
 *  - rest: the 3D canvas with Orca's centred toolbar, the view cube, the
 *    object manipulation panel (bottom-left) and notifications (bottom-right).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { activeEngine } from './app/state';
import { useToast } from '@nuxt/ui/composables';
import TopBar from './app/shell/TopBar.vue';
import ObjectList from './app/shell/ObjectList.vue';
import PlateToolbar from './app/shell/PlateToolbar.vue';
import PlateStatus from './app/shell/PlateStatus.vue';
import PlateBar from './app/shell/PlateBar.vue';
import PaintPanel from './paint/PaintPanel.vue';
import EmptyState from './app/shell/EmptyState.vue';
import ToolHost from './tools/ToolHost.vue';
import DropOverlay from './app/shell/DropOverlay.vue';
import ShellDialogs from './app/shell/ShellDialogs.vue';
import LayerHeightPanel from './layers/LayerHeightPanel.vue';
import PlateSettingsDialog from './plates/PlateSettingsDialog.vue';
import { layersUi } from './layers/store';
import PrintHostDialogs from './printhost/PrintHostDialogs.vue';
import DialogsHost from './dialogs/DialogsHost.vue';
import CloudDialog from './cloud/CloudDialog.vue';
import LocalFolderDialog from './localfs/LocalFolderDialog.vue';
import { cloudSaveAsDialog, openCloudDeepLink } from './cloud/commands';
import { cloudDialog } from './cloud/store';
import CommandPalette from './app/shell/CommandPalette.vue';
import AnchoredMenu from './app/shell/AnchoredMenu.vue';
import SidebarResizer from './app/shell/SidebarResizer.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import { PreviewView } from './app/shell/external';
import { bindSliceController } from './app/shell/actions';
import { useActionSystem } from './app/shell/actionContext';
import { installSliceNotices } from './app/shell/sliceNotices';
import { menuItems, toNuxtItems } from './app/shell/useActions';
import { OBJECT_CONTEXT_MENU, PLATE_CONTEXT_MENU } from './app/actions/layouts/menus';
import { startHandoff } from './app/shell/handoff';
import { compact, drawerOpen, layout, narrow, phone, sidebarOpen, ui } from './app/shell/uiState';
import { useSliceController } from './app/slice';
import { activeView } from './app/state';
import PrepareViewport from './viewport/PrepareViewport.vue';
import TransformPanel from './viewport/TransformPanel.vue';
import { objects, plates } from './project/store';
import { enableAutosave, restoreAutosave } from './project/persistence/autosave';
import { bindToaster, toast, type Toaster } from './ui';

bindToaster(useToast() as unknown as Toaster);
onBeforeUnmount(() => bindToaster(null));

const slicer = useSliceController();
bindSliceController(slicer);
useActionSystem(slicer);
onBeforeUnmount(installSliceNotices(slicer));

// ---- responsive ----
const mq = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 1100px)') : null;
const mqPhone = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 640px)') : null;
const mqNarrow = typeof matchMedia !== 'undefined' ? matchMedia('(max-width: 1366px)') : null;
const onMq = () => {
  compact.value = !!mq?.matches;
  phone.value = !!mqPhone?.matches;
  narrow.value = !!mqNarrow?.matches;
  if (!compact.value) drawerOpen.value = false;
};
onMq();
mq?.addEventListener('change', onMq);
mqPhone?.addEventListener('change', onMq);
mqNarrow?.addEventListener('change', onMq);
onBeforeUnmount(() => { mq?.removeEventListener('change', onMq); mqPhone?.removeEventListener('change', onMq); mqNarrow?.removeEventListener('change', onMq); });

const showSidebar = computed(() => !compact.value && sidebarOpen());

// ---- preview mounts lazily, then stays alive ----
const previewMounted = ref(activeView.value === 'preview');
watch(activeView, (v) => { if (v === 'preview') previewMounted.value = true; });

// ---- reveal per-object settings: open the sidebar, go to Prepare ----
watch(() => ui.revealObjectSettings, () => {
  if (compact.value) drawerOpen.value = true; else layout.sidebarCollapsed = false;
  activeView.value = 'prepare';
});

// ---- viewport context menu ----
const vpMenu = ref({ open: false, x: 0, y: 0, object: false });
const vpItems = computed(() => (vpMenu.value.open ? toNuxtItems(menuItems(vpMenu.value.object ? OBJECT_CONTEXT_MENU : PLATE_CONTEXT_MENU)) : []));
function onViewportMenu(id: string | null, x: number, y: number) {
  vpMenu.value = { open: true, x, y, object: !!id };
}

// The app owns right-click everywhere. On Windows `contextmenu` fires on mouse
// UP — after the scene has already opened our menu, whose modal layer makes
// <body> the event target — so a canvas-only preventDefault misses it and the
// browser's menu opens on top of ours. Text fields keep the native menu
// (copy / paste / spellcheck). Regions wrapped in a UContextMenu are marked
// `data-own-menu`: reka's trigger only opens if the event isn't prevented yet
// (and prevents it itself).
function suppressNativeMenu(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-own-menu]')) return;
  e.preventDefault();
}
window.addEventListener('contextmenu', suppressNativeMenu, true);
onBeforeUnmount(() => window.removeEventListener('contextmenu', suppressNativeMenu, true));

// Toasts sit above the Preview's bottom move slider.
const toaster = computed(() => ({
  position: 'bottom-right' as const,
  max: 4,
  ui: { viewport: activeView.value === 'preview' ? 'bottom-24 right-16' : 'bottom-4 right-4' },
}));

// UI accent follows the engine: Orca green, preFlight orange (theme.css [data-engine]).
watch(activeEngine, (e) => { document.documentElement.dataset.engine = e; }, { immediate: true });

// ---- startup ----
let stopHandoff: (() => void) | null = null;
onMounted(async () => {
  const q = new URLSearchParams(location.search);
  const cloudLink = q.has('workspace') && q.has('path');
  const handoff = q.has('model') || q.has('handoff') || !!window.opener || cloudLink;
  if (!handoff) {
    const n = await restoreAutosave();
    if (n) toast.info(`Restored your last plate (${n} object${n > 1 ? 's' : ''}).`);
  }
  enableAutosave();
  stopHandoff = startHandoff();
  // ?workspace=&path= opens a CubbyCAD file; ?cloud=open|save reopens the files dialog after SSO sign-in.
  if (cloudLink) void openCloudDeepLink();
  const back = q.get('cloud');
  if (back === 'open' || back === 'save') {
    const u = new URL(location.href); u.searchParams.delete('cloud'); history.replaceState(history.state, '', u);
    if (back === 'open') cloudDialog.value = { mode: 'open' }; else cloudSaveAsDialog();
  }
});
onBeforeUnmount(() => stopHandoff?.());
</script>

<template>
  <UApp :toaster="toaster" :tooltip="{ delayDuration: 350 }">
    <div class="app" :class="{ 'app--compact': compact, 'app--phone': phone }">
      <TopBar />

      <div class="main">
        <!-- Orca's sidebar: printer / filament / process (+ objects) -->
        <aside v-if="!compact" v-show="showSidebar" class="side" :style="{ width: `${layout.sidebarWidth}px` }" aria-label="Settings and objects">
          <SettingsPanel>
            <template #objects><ObjectList /></template>
          </SettingsPanel>
        </aside>
        <SidebarResizer v-if="showSidebar" />

        <!-- Canvas -->
        <main class="center">
          <PrepareViewport v-show="activeView === 'prepare'" class="center__vp" @contextmenu="onViewportMenu">
            <div class="ov ov--top"><PlateToolbar /></div>
            <div class="ov ov--bl">
              <TransformPanel />
              <PlateStatus v-if="!phone" />
            </div>
            <div class="ov ov--bc"><PlateBar /></div>
            <div class="ov ov--tl"><PaintPanel /></div>
            <EmptyState v-if="!objects.length" />
            <ToolHost />
            <div v-if="layersUi.editing" class="ov ov--lh"><LayerHeightPanel /></div>
          </PrepareViewport>
          <div v-if="previewMounted" v-show="activeView === 'preview'" class="center__preview">
            <component :is="PreviewView" />
            <div v-if="plates.length > 1" class="ov ov--pv"><PlateBar compact /></div>
          </div>
          <Transition name="fade">
            <div v-if="ui.busy" class="busy" role="status">
              <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin text-primary" />{{ ui.busy }}
            </div>
          </Transition>
        </main>
      </div>

      <!-- Compact: the sidebar is a slide-over drawer -->
      <USlideover v-if="compact" v-model:open="drawerOpen" side="left" title="Settings" :ui="{ content: phone ? 'max-w-full w-full' : 'max-w-[min(420px,92vw)]', body: 'p-0 sm:p-0' }">
        <template #body>
          <SettingsPanel>
            <template #objects><ObjectList /></template>
          </SettingsPanel>
        </template>
      </USlideover>

      <AnchoredMenu v-model:open="vpMenu.open" :x="vpMenu.x" :y="vpMenu.y" :items="vpItems" />
      <ShellDialogs />
      <PlateSettingsDialog />
      <PrintHostDialogs />
      <DialogsHost />
      <CloudDialog />
      <LocalFolderDialog />
      <CommandPalette />
      <DropOverlay />
    </div>
  </UApp>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; min-width: 0; background: var(--bg-0); color: var(--fg-0); }
.main { position: relative; flex: 1; min-height: 0; display: flex; }

.side { flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--bg-1); border-right: 1px solid var(--line); overflow: hidden; }

.center { position: relative; flex: 1; min-width: 0; min-height: 0; }
.center__vp, .center__preview { position: absolute; inset: 0; }
.ov { position: absolute; z-index: var(--z-toolbar); pointer-events: none; }
.ov > * { pointer-events: auto; }
.ov--top { top: 10px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 140px); }
.ov--bl { left: 10px; bottom: 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.ov--bl > :last-child { pointer-events: none; }
.ov--tl { top: 64px; left: 10px; }
.ov--bc { bottom: 10px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 560px); min-width: 0; }
.ov--pv { top: 10px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 520px); }
.ov--lh { top: 118px; right: 10px; bottom: 56px; display: flex; flex-direction: column; justify-content: flex-start; }
@media (max-width: 1100px) { .ov--lh { bottom: 108px; } }
@media (max-width: 1100px) { .ov--bc { left: auto; right: 10px; transform: none; max-width: calc(100% - 20px); bottom: 64px; } }
/* Phone: the plater toolbar moves to the bottom (thumb reach) and scrolls sideways;
   the plate bar sits above it; the transform panel stays collapsed until opened. */
.app--phone .ov--top { top: auto; bottom: calc(8px + env(safe-area-inset-bottom)); max-width: calc(100% - 16px); }
.app--phone .ov--bc { right: 8px; left: 8px; bottom: calc(64px + env(safe-area-inset-bottom)); max-width: none; display: flex; justify-content: flex-end; }
.app--phone .ov--bl { left: 8px; bottom: calc(112px + env(safe-area-inset-bottom)); max-width: calc(100% - 16px); }
.app--phone .ov--tl { top: 8px; left: 8px; right: 8px; }
.app--phone .ov--pv { top: 8px; left: 8px; transform: none; max-width: calc(100% - 96px); }
.app--phone .ov--lh { top: auto; left: 8px; right: 8px; bottom: calc(60px + env(safe-area-inset-bottom)); height: min(62vh, 520px); z-index: calc(var(--z-toolbar) + 1); }

.busy {
  position: absolute; top: 60px; left: 50%; transform: translateX(-50%); z-index: var(--z-toolbar);
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  font-size: var(--fs-sm); color: var(--fg-0);
  background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 16px; box-shadow: var(--shadow);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
