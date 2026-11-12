<script setup lang="ts">
/**
 * One plugin window or dock panel (orca.host.ui.create_window /
 * create_dock_panel): a sandboxed iframe with Orca's window.orca bridge, in a
 * frame whose title names the plugin. Modal windows sit over a backdrop; other
 * windows float, movable and resizable. A dock panel is docked beside the
 * viewport (drawn over its placeholder in PluginDockArea.vue, ../dockLayout.ts)
 * or floats; dragging its caption floats it, dropping it on an edge of the
 * viewport docks it there, and its menu does both. On phones it is a bottom sheet.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import { buildWindowDocument, themeSnapshot } from './pluginDocument';
import { closeWindow, messageRequest, permissionRequest, pluginUi, uiEvent, type PluginWindow } from '../host/ui';
import {
  DOCK_SIDES, dockRoot, dockSheets, dockSlots, dockTabActive, dockTick, panes, savePane, setPaneDock, setPaneFloat, type DockSide,
} from '../dockLayout';
import { dialogs } from '../../dialogs/state';
import { confirmAction } from '../../app/shell/uiState';
import { rowOf } from '../manager/store';

const props = defineProps<{ win: PluginWindow }>();
const frame = ref<HTMLIFrameElement | null>(null);
const loaded = ref(false);

const origins = computed(() => rowOf(props.win.pluginKey)?.desc.state?.permissions.network_http ?? []);
const srcdoc = buildWindowDocument(props.win.html, { origins: origins.value });

const vw = () => (typeof window !== 'undefined' ? window.innerWidth : 1280);
const vh = () => (typeof window !== 'undefined' ? window.innerHeight : 800);
const size = ref({ w: Math.min(props.win.width, vw() - 24), h: Math.min(props.win.height + 36, vh() - 24) });
const pos = ref(initialPos());

/** The dock panel's place (null for a window). */
const pane = computed(() => (props.win.kind === 'dock' ? panes[props.win.handle] ?? null : null));
type Mode = 'window' | 'docked' | 'float' | 'sheet';
const mode = computed<Mode>(() => (!pane.value ? 'window' : dockSheets.value ? 'sheet' : pane.value.dock === 'float' ? 'float' : 'docked'));
const shown = computed(() => props.win.visible && (props.win.kind !== 'dock' || dockTabActive.value));

function initialPos(side?: string) {
  const w = Math.min(props.win.width, vw() - 24), h = Math.min(props.win.height + 36, vh() - 24);
  if (props.win.kind === 'dock') {
    const d = side ?? props.win.dock;
    if (d === 'left') return { x: 12, y: 64 };
    if (d === 'bottom') return { x: Math.max(12, (vw() - w) / 2), y: Math.max(12, vh() - h - 12) };
    return { x: Math.max(12, vw() - w - 12), y: 64 };
  }
  const n = pluginUi.windows.filter((x) => x.kind === 'window').length - 1;
  return { x: Math.max(12, (vw() - w) / 2 + n * 24), y: Math.max(12, (vh() - h) / 2 + n * 24) };
}

// A floating dock panel's frame lives in its pane (remembered); the first time it floats, it
// opens at its side, at the size the plugin asked for (Orca: FloatingSize).
// Floating again (menu, reload, Reset), it comes back whole on screen.
watch(mode, (m) => {
  if (m !== 'float' || !pane.value) return;
  const f = pane.value.float;
  if (!f) {
    const p = initialPos(pane.value.side);
    setPaneFloat(props.win.handle, { x: p.x, y: p.y, w: size.value.w, h: size.value.h });
    return;
  }
  const w = Math.min(f.w, vw() - 16), h = Math.min(f.h, vh() - 16);
  const x = Math.min(Math.max(f.x, 8), vw() - w - 8), y = Math.min(Math.max(f.y, 8), vh() - h - 8);
  if (x !== f.x || y !== f.y || w !== f.w || h !== f.h) setPaneFloat(props.win.handle, { x, y, w, h });
}, { immediate: true });
const floatPos = computed(() => (pane.value?.float ? { x: pane.value.float.x, y: pane.value.float.y } : pos.value));
const floatSize = computed(() => (pane.value?.float ? { w: pane.value.float.w, h: pane.value.float.h } : size.value));

/** Where the docked panel is drawn: over its placeholder in the dock area. */
const dockRect = ref({ x: 0, y: 0, w: 0, h: 0 });
function measure(): void {
  const el = dockSlots[props.win.handle];
  if (mode.value !== 'docked' || !el) return;
  const r = el.getBoundingClientRect();
  dockRect.value = { x: r.left, y: r.top, w: r.width, h: r.height };
}
watch([dockTick, () => dockSlots[props.win.handle], mode, () => pane.value?.size, shown], measure, { flush: 'post', immediate: true });

function deliver(): void {
  const cw = frame.value?.contentWindow;
  if (!cw || !loaded.value) return;
  // Queued payloads sit in reactive state: post plain JSON (what Orca's bridge carries anyway).
  for (const data of props.win.queue.splice(0)) cw.postMessage({ __orca: 'dispatch', data: JSON.parse(JSON.stringify(data ?? null)) }, '*');
}
watch(() => props.win.seq, deliver);

function onLoad(): void { loaded.value = true; deliver(); }

function onMessage(e: MessageEvent): void {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as { __orca?: string; data?: unknown };
  if (!m || typeof m !== 'object') return;
  if (m.__orca === 'message') uiEvent(props.win.handle, 'message', m.data);
  else if (m.__orca === 'submit') closeWindow(props.win.handle, { submit: m.data ?? null });
  else if (m.__orca === 'close') closeWindow(props.win.handle);
  else if (m.__orca === 'open' && typeof m.data === 'string' && /^https?:/i.test(m.data)) {
    const url = m.data;
    void confirmAction({ title: 'Open link?', message: `${props.win.pluginName} wants to open ${url} in a new tab.`, confirmLabel: 'Open' })
      .then((ok) => { if (ok) window.open(url, '_blank', 'noopener,noreferrer'); });
  }
}

let themeObs: MutationObserver | null = null;
onMounted(() => {
  window.addEventListener('message', onMessage);
  themeObs = new MutationObserver(() => frame.value?.contentWindow?.postMessage({ __orca: 'theme', theme: themeSnapshot() }, '*'));
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});
onBeforeUnmount(() => { window.removeEventListener('message', onMessage); themeObs?.disconnect(); });

function raise(): void { props.win.z = ++pluginUi.topZ; }

let drag: { x: number; y: number; px: number; py: number; mode: 'move' | 'size' | 'undock' } | null = null;
/** While a floating dock panel moves: the dock its drop would dock it on (an edge of the area beside the viewport). */
const hint = ref<DockSide | null>(null);
const HINT_EDGE = 48;

function startDrag(e: PointerEvent, how: 'move' | 'size'): void {
  if (e.button !== 0 || mode.value === 'sheet') return;
  raise();
  const p = floatPos.value, z = floatSize.value;
  if (mode.value === 'docked') {
    if (how !== 'move') return;
    drag = { x: e.clientX, y: e.clientY, px: e.clientX - dockRect.value.x, py: e.clientY - dockRect.value.y, mode: 'undock' };
  } else drag = { x: e.clientX, y: e.clientY, px: how === 'move' ? p.x : z.w, py: how === 'move' ? p.y : z.h, mode: how };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}
function placeFloat(x: number, y: number, w: number, h: number, save = false): void {
  if (pane.value) setPaneFloat(props.win.handle, { x, y, w, h }, save);
  else { pos.value = { x, y }; size.value = { w, h }; }
}
function dockHint(e: PointerEvent): DockSide | null {
  const r = pane.value && dockRoot.value?.getBoundingClientRect();
  if (!r || e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) return null;
  if (e.clientX - r.left < HINT_EDGE) return 'left';
  if (r.right - e.clientX < HINT_EDGE) return 'right';
  if (r.bottom - e.clientY < HINT_EDGE) return 'bottom';
  return null;
}
function onDrag(e: PointerEvent): void {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.mode === 'undock') {
    // wxAUI: dragging a docked pane's caption floats it under the pointer.
    if (Math.hypot(dx, dy) < 8 || !pane.value) return;
    // At its last floating size, else the size the plugin asked for (Orca: FloatingSize).
    const f = pane.value.float, w = f?.w ?? size.value.w, h = f?.h ?? size.value.h;
    const gx = Math.min(drag.px, w - 40);
    setPaneDock(props.win.handle, 'float', { x: e.clientX - gx, y: e.clientY - Math.min(drag.py, 18), w, h });
    drag = { x: e.clientX, y: e.clientY, px: e.clientX - gx, py: e.clientY - Math.min(drag.py, 18), mode: 'move' };
    return;
  }
  const z = floatSize.value, p = floatPos.value;
  if (drag.mode === 'move') {
    placeFloat(Math.min(Math.max(drag.px + dx, -z.w + 80), vw() - 80), Math.min(Math.max(drag.py + dy, 0), vh() - 40), z.w, z.h);
    hint.value = dockHint(e);
  } else placeFloat(p.x, p.y, Math.max(240, drag.px + dx), Math.max(140, drag.py + dy));
}
function endDrag(): void {
  if (!drag) return;
  drag = null;
  if (hint.value) setPaneDock(props.win.handle, hint.value);
  else if (pane.value) savePane(props.win.handle);
  hint.value = null;
}

/** The area a drop would dock the panel in, drawn while it moves. */
const hintStyle = computed(() => {
  const r = hint.value && dockRoot.value?.getBoundingClientRect();
  if (!r || !hint.value) return null;
  const s = Math.min(pane.value?.size ?? 320, (hint.value === 'bottom' ? r.height : r.width) * 0.6);
  if (hint.value === 'left') return { left: `${r.left}px`, top: `${r.top}px`, width: `${s}px`, height: `${r.height}px` };
  if (hint.value === 'right') return { left: `${r.right - s}px`, top: `${r.top}px`, width: `${s}px`, height: `${r.height}px` };
  return { left: `${r.left}px`, top: `${r.bottom - s}px`, width: `${r.width}px`, height: `${s}px` };
});

const SIDE_LABEL: Record<DockSide, string> = { left: 'Dock left', right: 'Dock right', bottom: 'Dock bottom' };
const SIDE_ICON: Record<DockSide, string> = { left: 'i-lucide-panel-left', right: 'i-lucide-panel-right', bottom: 'i-lucide-panel-bottom' };
const dockMenu = computed<DropdownMenuItem[]>(() => [
  ...DOCK_SIDES.map((d) => ({
    label: SIDE_LABEL[d], icon: SIDE_ICON[d], type: 'checkbox' as const, checked: pane.value?.dock === d,
    onSelect: () => setPaneDock(props.win.handle, d),
  })),
  { label: 'Float', icon: 'i-lucide-picture-in-picture-2', type: 'checkbox' as const, checked: pane.value?.dock === 'float',
    onSelect: () => setPaneDock(props.win.handle, 'float') },
]);

/**
 * Over the Plugins dialog (a plugin run from it opens on top, as in Orca) unless the plugin's
 * own message box / progress / permission prompt is up: then document order puts that on top.
 */
const zBase = computed(() => (dialogs.plugins && !messageRequest.current.value && !permissionRequest.current.value && !pluginUi.progress.length ? 50 : null));
/** Stacking among plugin windows (last raised on top), kept inside 50–59 so the app's confirm (60) stays above. */
const rank = computed(() => [...pluginUi.windows].sort((a, b) => a.z - b.z).indexOf(props.win));
/** Otherwise above the docked panels (20) and the dock splitters, below drawers, menus and dialogs. */
const zWin = computed(() => String((zBase.value ?? 21) + Math.min(zBase.value === null ? 8 : 9, Math.max(0, rank.value))));

const style = computed(() => {
  if (props.win.modal) return { width: `${size.value.w}px`, height: `${size.value.h}px` };
  if (mode.value === 'sheet') return {};
  if (mode.value === 'docked') {
    // Over the Plugins dialog while it is up (Orca's is modeless), else part of the window layout.
    const r = dockRect.value;
    return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, zIndex: zBase.value === null ? undefined : zWin.value };
  }
  const p = floatPos.value, z = floatSize.value;
  return { left: `${p.x}px`, top: `${p.y}px`, width: `${z.w}px`, height: `${z.h}px`, zIndex: zWin.value };
});
</script>

<template>
  <!-- On body, above app modals: a plugin run from the Plugins dialog opens its window over it (as in Orca). -->
  <Teleport to="body">
  <div v-show="shown" :class="win.modal ? 'pw-backdrop' : 'pw-float-layer'" :style="win.modal ? { zIndex: zWin } : undefined">
    <section class="pw" :class="{ 'pw--modal': win.modal, 'pw--docked': mode === 'docked', 'pw--sheet': mode === 'sheet' }" :style="style"
             :role="mode === 'docked' ? 'region' : 'dialog'" :aria-modal="win.modal || undefined"
             :aria-label="`${win.title} — ${win.pluginName}`" data-testid="plugin-window" :data-plugin="win.pluginKey"
             :data-dock="pane ? (mode === 'sheet' ? 'sheet' : pane.dock) : undefined" @pointerdown="raise">
      <header class="pw__bar" @pointerdown="!win.modal && startDrag($event, 'move')" @pointermove="onDrag" @pointerup="endDrag" @pointercancel="endDrag">
        <UIcon name="i-lucide-puzzle" class="size-4 shrink-0 text-dimmed" />
        <span class="pw__title">{{ win.title }}</span>
        <span class="pw__plugin">{{ win.pluginName }}</span>
        <UDropdownMenu v-if="pane && mode !== 'sheet'" :items="dockMenu" :content="{ align: 'end' }">
          <UButton icon="i-lucide-app-window" variant="ghost" size="xs" color="neutral" aria-label="Dock or float" data-testid="plugin-window-dock"
                   @pointerdown.stop />
        </UDropdownMenu>
        <UButton icon="i-lucide-x" variant="ghost" size="xs" color="neutral" aria-label="Close" data-testid="plugin-window-close"
                 @pointerdown.stop @click="closeWindow(win.handle)" />
      </header>
      <iframe ref="frame" class="pw__frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="srcdoc"
              :title="win.title" @load="onLoad" />
      <div v-if="!win.modal && (mode === 'window' || mode === 'float')" class="pw__grip" @pointerdown="startDrag($event, 'size')" @pointermove="onDrag" @pointerup="endDrag" />
    </section>
    <div v-if="hintStyle" class="pw-hint" :style="hintStyle" data-testid="plugin-dock-hint" />
  </div>
  </Teleport>
</template>

<style scoped>
.pw-float-layer { position: fixed; inset: 0; pointer-events: none; }
.pw-float-layer .pw { pointer-events: auto; position: fixed; }
.pw-backdrop { pointer-events: auto; position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: flex; align-items: center; justify-content: center; }
.pw { display: flex; flex-direction: column; background: var(--ui-bg); border: 1px solid var(--ui-border); border-radius: 8px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45); overflow: hidden; max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
.pw__bar { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-elevated); cursor: move; user-select: none; touch-action: none; min-height: 36px; }
.pw--modal .pw__bar { cursor: default; }
.pw__title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pw__plugin { font-size: 12px; color: var(--ui-text-dimmed); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.pw__frame { flex: 1; width: 100%; border: 0; background: var(--ui-bg); }
.pw__grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; }
.pw { position: relative; }
.pw-float-layer .pw { position: fixed; }
/* Docked: part of the window layout, under menus, drawers and dialogs (the dock's splitter is above it). */
.pw--docked { z-index: 20; border: 0; border-radius: 0; box-shadow: none; max-width: none; max-height: none; }
.pw--docked .pw__bar { cursor: grab; }
/* Phones: a bottom sheet over the viewport. */
.pw--sheet { left: 0; right: 0; bottom: 0; width: auto; height: min(60dvh, 520px); max-width: none; z-index: 30;
  border-radius: 12px 12px 0 0; border-width: 1px 0 0; padding-bottom: env(safe-area-inset-bottom); }
.pw--sheet .pw__bar { cursor: default; }
.pw-hint { position: fixed; pointer-events: none; z-index: 59; background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 2px solid var(--accent); border-radius: 4px; }
</style>
