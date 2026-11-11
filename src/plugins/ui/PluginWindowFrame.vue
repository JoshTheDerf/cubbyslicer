<script setup lang="ts">
/**
 * One plugin window or dock panel (orca.host.ui.create_window /
 * create_dock_panel): a sandboxed iframe with Orca's window.orca bridge, in a
 * movable, resizable frame whose title names the plugin. Modal windows sit
 * over a backdrop; dock panels open floating at their dock side.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildWindowDocument, themeSnapshot } from './pluginDocument';
import { closeWindow, messageRequest, permissionRequest, pluginUi, uiEvent, type PluginWindow } from '../host/ui';
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

function initialPos() {
  const w = Math.min(props.win.width, vw() - 24), h = Math.min(props.win.height + 36, vh() - 24);
  if (props.win.kind === 'dock') {
    const d = props.win.dock;
    if (d === 'left') return { x: 12, y: 64 };
    if (d === 'bottom') return { x: Math.max(12, (vw() - w) / 2), y: Math.max(12, vh() - h - 12) };
    return { x: Math.max(12, vw() - w - 12), y: 64 };
  }
  const n = pluginUi.windows.filter((x) => x.kind === 'window').length - 1;
  return { x: Math.max(12, (vw() - w) / 2 + n * 24), y: Math.max(12, (vh() - h) / 2 + n * 24) };
}

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

let drag: { x: number; y: number; px: number; py: number; mode: 'move' | 'size' } | null = null;
function startDrag(e: PointerEvent, mode: 'move' | 'size'): void {
  if (e.button !== 0) return;
  raise();
  drag = { x: e.clientX, y: e.clientY, px: mode === 'move' ? pos.value.x : size.value.w, py: mode === 'move' ? pos.value.y : size.value.h, mode };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}
function onDrag(e: PointerEvent): void {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.mode === 'move') pos.value = { x: Math.min(Math.max(drag.px + dx, -size.value.w + 80), vw() - 80), y: Math.min(Math.max(drag.py + dy, 0), vh() - 40) };
  else size.value = { w: Math.max(240, drag.px + dx), h: Math.max(140, drag.py + dy) };
}
function endDrag(): void { drag = null; }

/**
 * Over the Plugins dialog (a plugin run from it opens on top, as in Orca) unless the plugin's
 * own message box / progress / permission prompt is up: then document order puts that on top.
 */
const zBase = computed(() => (dialogs.plugins && !messageRequest.current.value && !permissionRequest.current.value && !pluginUi.progress.length ? 50 : null));
/** Stacking among plugin windows (last raised on top), kept inside 50–59 so the app's confirm (60) stays above. */
const rank = computed(() => [...pluginUi.windows].sort((a, b) => a.z - b.z).indexOf(props.win));
const zWin = computed(() => (zBase.value === null ? 'auto' : String(zBase.value + Math.min(9, Math.max(0, rank.value)))));

const style = computed(() => props.win.modal
  ? { width: `${size.value.w}px`, height: `${size.value.h}px` }
  : { left: `${pos.value.x}px`, top: `${pos.value.y}px`, width: `${size.value.w}px`, height: `${size.value.h}px`, zIndex: zWin.value });
</script>

<template>
  <!-- On body, above app modals: a plugin run from the Plugins dialog opens its window over it (as in Orca). -->
  <Teleport to="body">
  <div v-show="win.visible" :class="win.modal ? 'pw-backdrop' : 'pw-float-layer'" :style="win.modal ? { zIndex: zWin } : undefined">
    <section class="pw" :class="{ 'pw--modal': win.modal }" :style="style" role="dialog" :aria-modal="win.modal || undefined"
             :aria-label="`${win.title} — ${win.pluginName}`" data-testid="plugin-window" :data-plugin="win.pluginKey" @pointerdown="raise">
      <header class="pw__bar" @pointerdown="!win.modal && startDrag($event, 'move')" @pointermove="onDrag" @pointerup="endDrag">
        <UIcon name="i-lucide-puzzle" class="size-4 shrink-0 text-dimmed" />
        <span class="pw__title">{{ win.title }}</span>
        <span class="pw__plugin">{{ win.pluginName }}</span>
        <UButton icon="i-lucide-x" variant="ghost" size="xs" color="neutral" aria-label="Close" data-testid="plugin-window-close"
                 @pointerdown.stop @click="closeWindow(win.handle)" />
      </header>
      <iframe ref="frame" class="pw__frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="srcdoc"
              :title="win.title" @load="onLoad" />
      <div v-if="!win.modal" class="pw__grip" @pointerdown="startDrag($event, 'size')" @pointermove="onDrag" @pointerup="endDrag" />
    </section>
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
</style>
