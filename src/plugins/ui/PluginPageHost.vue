<script setup lang="ts">
/**
 * The centre area while a plugin page tab is active (Orca's plugin page tabs
 * beside Prepare / Preview). Each page's HTML comes from get_ui() the first time
 * its tab is shown and the page then stays alive (switching tabs keeps its state,
 * as a wx page does); it runs in a sandboxed iframe with Orca's page bridge.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { activePluginPage, pluginPages } from '../state';
import { pageId, pageInbox } from '../host/pages';
import { request, send } from '../runtime/client';
import { rowOf } from '../manager/store';
import { buildPageDocument, themeSnapshot } from './pluginDocument';
import { confirmAction } from '../../app/shell/uiState';

const docs = reactive(new Map<string, { srcdoc?: string; error?: string }>());
const frames = new Map<string, HTMLIFrameElement>();
const loaded = reactive(new Set<string>());
const shown = computed(() => pluginPages.value.filter((t) => docs.has(t.key)));
const busy = ref(false);

async function open(key: string | null): Promise<void> {
  if (!key || docs.has(key)) return;
  const t = pluginPages.value.find((x) => x.key === key);
  if (!t) return;
  busy.value = true;
  try {
    const r = await request<{ ok: boolean; value?: unknown; error?: string }>((reqId) => ({ t: 'pageUi', reqId, id: pageId(t) }));
    const origins = rowOf(t.pluginKey)?.desc.state?.permissions.network_http ?? [];
    docs.set(key, r.ok ? { srcdoc: buildPageDocument(String(r.value ?? ''), { origins }) } : { error: r.error ?? 'get_ui() failed' });
  } finally { busy.value = false; }
}
watch(activePluginPage, (k) => { void open(k); }, { immediate: true });

function deliver(key: string): void {
  const f = frames.get(key);
  const q = pageInbox.get(key);
  if (!f?.contentWindow || !loaded.has(key) || !q?.length) return;
  for (const data of q.splice(0)) f.contentWindow.postMessage({ __orca: 'dispatch', data: JSON.parse(JSON.stringify(data ?? null)) }, '*');
}
watch(() => [...pageInbox.entries()].map(([k, q]) => `${k}:${q.length}`).join('|'), () => { for (const k of pageInbox.keys()) deliver(k); });

function onLoad(key: string): void { loaded.add(key); deliver(key); }
function setFrame(key: string, el: unknown): void { if (el) frames.set(key, el as HTMLIFrameElement); else frames.delete(key); }

function onMessage(e: MessageEvent): void {
  for (const [key, f] of frames) {
    if (e.source !== f.contentWindow) continue;
    const m = e.data as { __orca?: string; data?: unknown };
    const t = pluginPages.value.find((x) => x.key === key);
    if (!t || !m || typeof m !== 'object') return;
    if (m.__orca === 'message') send({ t: 'pageMessage', id: pageId(t), data: m.data ?? null });
    else if (m.__orca === 'open' && typeof m.data === 'string' && /^https?:/i.test(m.data)) {
      const url = m.data;
      void confirmAction({ title: 'Open link?', message: `${t.pluginName} wants to open ${url} in a new tab.`, confirmLabel: 'Open' })
        .then((ok) => { if (ok) window.open(url, '_blank', 'noopener,noreferrer'); });
    }
    return;
  }
}
let obs: MutationObserver | null = null;
onMounted(() => {
  window.addEventListener('message', onMessage);
  obs = new MutationObserver(() => { for (const f of frames.values()) f.contentWindow?.postMessage({ __orca: 'theme', theme: themeSnapshot() }, '*'); });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});
onBeforeUnmount(() => { window.removeEventListener('message', onMessage); obs?.disconnect(); });
</script>

<template>
  <div v-show="activePluginPage" class="pg" data-testid="plugin-page-host">
    <template v-for="t in shown" :key="t.key">
      <div v-show="activePluginPage === t.key" class="pg__page" :data-testid="`plugin-page-${t.name}`">
        <p v-if="docs.get(t.key)?.error" class="pg__err">The page of {{ t.pluginName }} failed to load: {{ docs.get(t.key)?.error }}</p>
        <iframe v-else :ref="(el) => setFrame(t.key, el)" class="pg__frame" sandbox="allow-scripts" referrerpolicy="no-referrer"
                :srcdoc="docs.get(t.key)?.srcdoc" :title="t.name" @load="onLoad(t.key)" />
      </div>
    </template>
    <p v-if="busy" class="pg__err">Loading the page…</p>
  </div>
</template>

<style scoped>
.pg { position: absolute; inset: 0; background: var(--ui-bg); z-index: 5; }
.pg__page, .pg__frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.pg__err { padding: 16px; color: var(--ui-text-muted); font-size: 13px; }
</style>
