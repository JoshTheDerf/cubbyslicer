<script setup lang="ts">
/**
 * Orca's PhysicalPrinterDialog: host type, address, credentials, Test,
 * per-host setup hints. Bound to the selected printer preset; stored in this
 * browser only.
 */
import { computed, reactive, ref, watch } from 'vue';
import { emptyConfig, normalizeConfig } from './config';
import { HOSTS, OTHER_UNSUPPORTED, hostMeta } from './registry';
import { describeError, openWebUi, testConnection } from './send';
import { boundPrinter, hostContext, physicalPrinter, printhostUi, removePhysicalPrinter, savePhysicalPrinter } from './store';
import { browserEnv, lnaAddressSpace } from './transport';
import type { PhysicalPrinterConfig } from './types';
import { webUiUrl } from './url';
import { mobileDialog, shortScreen } from '../ui/mobileDialog';

const draft = reactive<PhysicalPrinterConfig>(emptyConfig());
const test = ref<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string; detail?: string }>({ state: 'idle' });
const showPassword = ref(false);
/** Phones: the connection form and the setup help are two tabs. */
const tab = ref<'conn' | 'help'>('conn');
const conn = computed(() => !mobileDialog.value || tab.value === 'conn');
const help = computed(() => !mobileDialog.value || tab.value === 'help');
const printers = ref<string[] | null>(null);
const printersBusy = ref(false);
let testAbort: AbortController | null = null;

watch(() => printhostUi.setupOpen, (open) => {
  if (!open) { testAbort?.abort(); return; }
  Object.assign(draft, physicalPrinter.value ? normalizeConfig(physicalPrinter.value.config) : emptyConfig());
  test.value = { state: 'idle' };
  printers.value = null;
  showPassword.value = false;
});
watch(() => [draft.type, draft.host], () => { if (test.value.state !== 'running') test.value = { state: 'idle' }; });

const meta = computed(() => hostMeta(draft.type));
const origin = typeof location !== 'undefined' ? location.origin : 'https://cubbycad.com';
const typeItems = computed(() => [
  HOSTS.filter((h) => h.support !== 'none').map((h) => ({ value: h.type, label: h.support === 'upload' ? `${h.label} (upload only)` : h.label })),
  HOSTS.filter((h) => h.support === 'none').map((h) => ({ value: h.type, label: `${h.label} — not available in a browser`, disabled: true })),
]);
const unsupported = computed(() => [
  ...HOSTS.filter((h) => h.support === 'none').map((h) => ({ label: h.label, note: h.note ?? '' })),
  ...OTHER_UNSUPPORTED,
]);
const canPrint = computed(() => meta.value?.canPrint({ printerModel: boundPrinter.value.model, variant: draft.variant }) ?? false);
const hints = computed(() => meta.value?.hints(origin) ?? []);

/** HTTPS page → http:// printer: mixed content unless Chrome's Local Network Access applies. */
const insecure = computed(() => {
  const h = draft.host.trim();
  return typeof location !== 'undefined' && location.protocol === 'https:' && !!h && !/^https:\/\//i.test(h);
});
const lna = lnaAddressSpace();
const webUi = computed(() => webUiUrl(draft.host, draft.webUi));
const valid = computed(() => !!draft.host.trim() && meta.value?.support !== 'none');
const existing = computed(() => physicalPrinter.value);

async function runTest() {
  testAbort?.abort();
  testAbort = new AbortController();
  test.value = { state: 'running' };
  try {
    const r = await testConnection(normalizeConfig(draft), testAbort.signal);
    test.value = { state: 'ok', message: r.message, detail: r.detail };
  } catch (e) {
    const d = describeError(e);
    test.value = { state: 'error', message: d.message, detail: d.detail };
  }
}

async function browsePrinters() {
  const m = meta.value;
  if (!m?.driver?.listPrinters) return;
  printersBusy.value = true;
  try {
    printers.value = await m.driver.listPrinters(hostContext(normalizeConfig(draft)), browserEnv());
    if (printers.value.length === 1) draft.printer = printers.value[0];
  } catch (e) {
    const d = describeError(e);
    test.value = { state: 'error', message: d.message, detail: d.detail };
  } finally { printersBusy.value = false; }
}

function save() {
  savePhysicalPrinter(normalizeConfig(draft));
  printhostUi.setupOpen = false;
}
function remove() {
  removePhysicalPrinter();
  printhostUi.setupOpen = false;
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
}
</script>

<template>
  <UModal v-model:open="printhostUi.setupOpen" title="Physical printer" :description="shortScreen ? undefined : `Send G-code from Cubby Slicer to “${boundPrinter.name}” over the network.`"
          :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div class="pp dlg-flow space-y-4 text-sm phone:space-y-3">
        <UTabs v-if="mobileDialog" class="dlg-span" v-model="tab" :items="[{ value: 'conn', label: 'Connection' }, { value: 'help', label: hints.length ? 'Setup help •' : 'Help' }]" :content="false" size="sm" />
        <UFormField v-show="conn" label="Host type">
          <USelect v-model="draft.type" :items="typeItems" value-key="value" class="w-full" aria-label="Host type" />
        </UFormField>

        <p v-if="meta?.note" v-show="help" class="dlg-span text-xs text-muted">{{ meta.note }}</p>

        <UFormField v-show="conn" label="Hostname, IP or URL" required>
          <UInput v-model="draft.host" :placeholder="meta?.hostPlaceholder" class="w-full" autocomplete="off" spellcheck="false" aria-label="Hostname, IP or URL" />
        </UFormField>

        <UFormField v-if="meta?.serial" v-show="conn" label="Serial number">
          <UInput v-model="draft.serial" class="w-full" autocomplete="off" spellcheck="false" />
        </UFormField>

        <UFormField v-if="meta?.authTypes" v-show="conn" label="Authorization">
          <UTabs v-model="draft.authType" :items="[{ value: 'key', label: 'API key' }, { value: 'user', label: 'HTTP digest' }]" :content="false" size="xs" class="w-64" />
        </UFormField>

        <UFormField v-if="meta?.apiKeyLabel && !(meta.authTypes && draft.authType === 'user')" v-show="conn" :label="meta.apiKeyLabel">
          <UInput v-model="draft.apiKey" :type="showPassword ? 'text' : 'password'" :placeholder="meta.apiKeyPlaceholder" class="w-full" autocomplete="off" spellcheck="false">
            <template #trailing>
              <UButton :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" variant="link" size="xs" color="neutral" :aria-label="showPassword ? 'Hide' : 'Show'" @click="showPassword = !showPassword" />
            </template>
          </UInput>
        </UFormField>

        <div v-if="meta?.authTypes && draft.authType === 'user'" v-show="conn" class="grid grid-cols-2 gap-3">
          <UFormField label="User"><UInput v-model="draft.user" class="w-full" autocomplete="off" /></UFormField>
          <UFormField label="Password"><UInput v-model="draft.password" type="password" class="w-full" autocomplete="off" /></UFormField>
        </div>

        <UFormField v-if="meta?.printerSlug" v-show="conn" label="Printer" hint="Repetier printer slug">
          <div class="flex gap-2">
            <UInput v-if="!printers?.length" v-model="draft.printer" placeholder="Leave empty if the server has one printer" class="flex-1" spellcheck="false" />
            <USelect v-else v-model="draft.printer" :items="printers" class="flex-1" aria-label="Printer" />
            <UButton icon="i-lucide-refresh-cw" label="Browse" variant="outline" :loading="printersBusy" :disabled="!draft.host.trim()" @click="browsePrinters" />
          </div>
        </UFormField>

        <UFormField v-if="meta?.variants" v-show="conn" label="Printer model">
          <USelect :model-value="draft.variant || 'auto'" :items="meta.variants" value-key="value" class="w-full" aria-label="Printer model"
                   @update:model-value="(v: string) => { draft.variant = v === 'auto' ? '' : v; }" />
        </UFormField>

        <UFormField v-if="meta?.wsUrl" v-show="conn" label="WebSocket URL" hint="Optional — for proxies / remote access">
          <UInput v-model="draft.wsUrl" :placeholder="meta.wsUrl" class="w-full" spellcheck="false" />
        </UFormField>

        <UFormField v-show="conn" label="Device UI" hint="Optional">
          <UInput v-model="draft.webUi" placeholder="Same as the host address" class="w-full" spellcheck="false" />
        </UFormField>

        <div v-show="conn" class="dlg-span flex items-center gap-2 flex-wrap">
          <UButton icon="i-lucide-plug-zap" label="Test" variant="outline" :loading="test.state === 'running'" :disabled="!valid" @click="runTest" />
          <UButton v-if="webUi" icon="i-lucide-external-link" label="Open web UI" variant="ghost" @click="openWebUi(normalizeConfig(draft))" />
          <UBadge v-if="meta" :color="meta.support === 'full' && canPrint ? 'success' : meta.support === 'none' ? 'error' : 'warning'" variant="subtle"
                  :label="meta.support === 'none' ? 'Not available in a browser' : canPrint ? 'Upload & print' : 'Upload only'" />
        </div>

        <UAlert v-if="test.state === 'ok'" v-show="conn" class="dlg-span" color="success" variant="subtle" icon="i-lucide-circle-check" :title="test.message" :description="test.detail" />
        <UAlert v-else-if="test.state === 'error'" v-show="conn" class="dlg-span" color="error" variant="subtle" icon="i-lucide-circle-x" :title="test.message"
                :description="test.detail" :ui="{ description: 'whitespace-pre-line' }" />

        <UAlert v-if="insecure" v-show="conn" class="dlg-span" color="warning" variant="subtle" icon="i-lucide-shield-alert" title="Plain http:// printer from an HTTPS page"
                :ui="{ description: 'whitespace-pre-line' }"
                :description="lna
                  ? 'Your browser supports Local Network Access: allow “Access other devices on your local network” when it asks (padlock → Site settings to change it later). This only works for addresses on your local network.'
                  : 'This browser blocks http:// requests from HTTPS pages (mixed content). Use an https:// address for the printer (e.g. via a reverse proxy), or Chrome/Edge, which can reach local-network printers after a permission prompt.'" />

        <section v-if="hints.length" v-show="help" class="pp__hints dlg-span">
          <h4>Set up the printer for this site</h4>
          <div v-for="(h, i) in hints" :key="i" class="pp__hint">
            <p>{{ h.text }}</p>
            <div v-if="h.code" class="pp__code">
              <pre>{{ h.code }}</pre>
              <UButton icon="i-lucide-copy" size="xs" variant="ghost" aria-label="Copy" class="pp__copy" @click="copy(h.code)" />
            </div>
          </div>
        </section>

        <details v-show="help" class="pp__more dlg-span">
          <summary>Hosts that can’t work in a browser</summary>
          <ul>
            <li v-for="u in unsupported" :key="u.label"><b>{{ u.label }}</b> — {{ u.note }}</li>
          </ul>
        </details>

        <p v-show="help" class="dlg-span text-xs text-dimmed flex items-start gap-1.5">
          <UIcon name="i-lucide-lock" class="size-3.5 mt-0.5 flex-none" />
          <span>Settings and credentials are stored only in this browser (localStorage), for the “{{ boundPrinter.name }}” preset. They are sent only to the printer address above.</span>
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-between gap-2 w-full">
        <UButton v-if="existing" color="error" variant="ghost" icon="i-lucide-trash-2" label="Remove" @click="remove" />
        <span v-else />
        <div class="flex gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="printhostUi.setupOpen = false" />
          <UButton color="primary" label="Save" :disabled="!valid" @click="save" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.pp__hints { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-2); }
.pp__hints h4 { margin: 0 0 6px; font: 600 var(--fs-sm) var(--font); color: var(--fg-0); }
.pp__hint + .pp__hint { margin-top: 8px; }
.pp__hint p { margin: 0 0 4px; color: var(--fg-1); }
.pp__code { position: relative; }
.pp__code pre { margin: 0; padding: 8px 32px 8px 10px; font: var(--fs-xs) / 1.45 ui-monospace, monospace; color: var(--fg-0); background: var(--bg-0); border-radius: var(--radius-sm); overflow-x: auto; white-space: pre; }
@media (max-width: 640px), (max-height: 500px) {
  .pp__code pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; }
}
.pp__copy { position: absolute; top: 4px; right: 4px; }
.pp__more summary { cursor: pointer; color: var(--fg-1); font-size: var(--fs-sm); }
.pp__more ul { margin: 6px 0 0; padding-left: 18px; list-style: disc; color: var(--fg-2); font-size: var(--fs-xs); }
.pp__more li + li { margin-top: 4px; }
</style>
