<script setup lang="ts">
/**
 * The Plugins dialog (OrcaSlicer resources/web/dialog/PluginsDialog): search,
 * Refresh, "Install plugin" (from a file or a URL), the installed list
 * (Activate, Name, Plugin Version, Source, Status; sortable) and the detail
 * tabs Plugin Info, Description, Config, Permissions, Diagnostics. A second
 * tab explains the Orca Cloud hub (not reachable from a browser) and links to it.
 */
import { computed, ref, watch } from 'vue';
import AppDialog from '../../ui/AppDialog.vue';
import { toast } from '../../ui/toast';
import { confirmAction } from '../../app/shell/uiState';
import { pickFiles } from '../../app/shell/download';
import { pluginsDialogOpen } from '../state';
import { ensurePluginsReady } from '../index';
import {
  deletePlugin, failPlugin, fetchPackage, inspectPackage, installPackage, pluginState, reloadPlugin, revokePermission, runScriptCapability,
  scanCatalog, setCapabilityEnabled, setPluginEnabled, type InspectResult, type PluginRow,
} from '../manager/store';
import { runtimeState, PYODIDE_VERSION } from '../runtime/client';
import { reportScriptOutcome } from '../host/actions';
import { schemaHasPipelineKey, selectedPipelineNames, setPipelineSelected } from '../host/postProcess';
import { PERMISSION_BROWSER_NOTES } from '../manager/permissions';
import { CAPABILITY_TYPE_LABEL, type LoadedCapability, type PluginPermissions } from '../types';
import PluginConfigEditor from './PluginConfigEditor.vue';

const HUB_URL = 'https://cloud.orcaslicer.com/app/plugins/plugin-hub';
const TRUST = 'Plugins run Python code inside CubbySlicer in your browser. A plugin can read and change your projects, settings and printer connections stored in this browser, can change the G-code that is sent to your printer, and can contact websites you allow. Permission prompts help you see what a plugin does; they are not a sandbox. Install only plugins you trust, and check sliced results before printing. Plugin dependencies are downloaded from PyPI when the plugin first loads.';

void ensurePluginsReady();

const view = ref<'installed' | 'hub'>('installed');
const views = [{ label: 'Installed', value: 'installed', icon: 'i-lucide-puzzle' }, { label: 'Orca Cloud', value: 'hub', icon: 'i-lucide-cloud' }];

// ---- search + sort (plugin-search.js / plugin-sort.js) ----
const query = ref('');
const matchCase = ref(false);
const wholeWord = ref(false);
type SortField = 'name' | 'version' | 'source' | 'status';
const sort = ref<{ field: SortField; dir: 1 | -1 }>({ field: 'name', dir: 1 });

const STATUS_LABEL: Record<string, string> = { loaded: 'Activated', loading: 'Loading', error: 'Error', disabled: 'Inactive', unsupported: 'Not supported' };
const statusLabel = (r: PluginRow) => (r.status === 'loaded' && r.caps.length && r.caps.every((c) => !c.supported) ? 'Not supported' : STATUS_LABEL[r.status] ?? r.status);
const sourceLabel = (r: PluginRow) => ({ file: 'Local', url: 'URL', example: 'Example' } as Record<string, string>)[r.desc.state?.cubby?.source ?? ''] ?? 'Local';

function matches(r: PluginRow): boolean {
  const q = query.value.trim();
  if (!q) return true;
  const hay = [r.desc.name, r.desc.description, r.desc.author, r.desc.entryFile, ...r.caps.map((c) => c.name)].join('\n');
  const flags = matchCase.value ? 'u' : 'iu';
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(wholeWord.value ? `(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])` : esc, flags).test(hay);
}

const rows = computed(() => {
  const f = sort.value.field;
  const key = (r: PluginRow) => (f === 'name' ? r.desc.name : f === 'version' ? r.desc.version : f === 'source' ? sourceLabel(r) : statusLabel(r)).toLowerCase();
  return pluginState.rows.filter(matches).sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }) * sort.value.dir);
});
function sortBy(field: SortField): void { sort.value = { field, dir: sort.value.field === field ? (-sort.value.dir as 1 | -1) : 1 }; }

const selectedKey = ref<string | null>(null);
const selected = computed(() => pluginState.rows.find((r) => r.desc.pluginKey === selectedKey.value) ?? rows.value[0] ?? null);
watch(rows, (r) => { if (!selectedKey.value && r[0]) selectedKey.value = r[0].desc.pluginKey; }, { immediate: true });

const tab = ref('info');
const tabs = [
  { label: 'Plugin Info', value: 'info' }, { label: 'Description', value: 'description' }, { label: 'Config', value: 'config' },
  { label: 'Permissions', value: 'permissions' }, { label: 'Diagnostics', value: 'diagnostics' },
];

// ---- install ----
const pending = ref<InspectResult | null>(null);
const pendingSource = ref<'file' | 'url'>('file');
const pendingUrl = ref('');
const urlOpen = ref(false);
const urlText = ref('');
const busy = ref(false);

async function inspect(fileName: string, bytes: Uint8Array, source: 'file' | 'url', url = ''): Promise<void> {
  try {
    pending.value = await inspectPackage(fileName, bytes);
    pendingSource.value = source;
    pendingUrl.value = url;
  } catch (e) { toast.error("This isn't a plugin package CubbySlicer can install.", { detail: (e as Error).message }); }
}

async function installFromFile(): Promise<void> {
  const [f] = await pickFiles('.py,.whl', false);
  if (f) await inspect(f.name, new Uint8Array(await f.arrayBuffer()), 'file');
}

async function installFromUrl(): Promise<void> {
  busy.value = true;
  try {
    const { fileName, bytes } = await fetchPackage(urlText.value.trim());
    urlOpen.value = false;
    await inspect(fileName, bytes, 'url', urlText.value.trim());
  } catch (e) { toast.error("Couldn't download the plugin.", { detail: (e as Error).message }); }
  finally { busy.value = false; }
}

async function confirmInstall(): Promise<void> {
  const p = pending.value;
  if (!p) return;
  busy.value = true;
  try {
    await installPackage(p, pendingSource.value, pendingUrl.value || undefined);
    selectedKey.value = p.key;
    pending.value = null;
    const row = pluginState.rows.find((r) => r.desc.pluginKey === p.key);
    if (row?.status === 'error') toast.error(`${p.name} was installed but did not load.`, { detail: row.error });
    else toast.success(`${p.name} installed.`, { timeout: 2500 });
  } catch (e) { toast.error("Couldn't install the plugin.", { detail: (e as Error).message }); }
  finally { busy.value = false; }
}

const dragging = ref(false);
async function onDrop(e: DragEvent): Promise<void> {
  dragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) await inspect(f.name, new Uint8Array(await f.arrayBuffer()), 'file');
}

const installMenu = [[
  { label: 'Install from file…', icon: 'i-lucide-file-code', onSelect: () => { void installFromFile(); } },
  { label: 'Install from URL…', icon: 'i-lucide-link', onSelect: () => { urlOpen.value = true; } },
  { label: 'Browse plugins on Orca Cloud', icon: 'i-lucide-cloud', onSelect: () => { view.value = 'hub'; } },
]];

// ---- row actions ----
async function toggle(r: PluginRow, on: boolean): Promise<void> { await setPluginEnabled(r.desc.pluginKey, on); }
async function remove(r: PluginRow): Promise<void> {
  const ok = await confirmAction({ title: 'Delete plugin', message: `Delete ${r.desc.name}? Its configuration and stored data are kept.`, confirmLabel: 'Delete', danger: true, testId: 'plugin-delete' });
  if (!ok) return;
  await deletePlugin(r.desc.pluginKey);
  if (selectedKey.value === r.desc.pluginKey) selectedKey.value = null;
}
function rowMenu(r: PluginRow) {
  return [[
    { label: 'Reload', icon: 'i-lucide-refresh-cw', onSelect: () => { void reloadPlugin(r.desc.pluginKey); } },
    { label: 'Delete cache and reload', icon: 'i-lucide-brush-cleaning', onSelect: () => { void reloadPlugin(r.desc.pluginKey); } },
    { label: 'Copy sha256', icon: 'i-lucide-copy', disabled: !r.desc.state?.cubby?.sha256, onSelect: () => { void navigator.clipboard?.writeText(r.desc.state?.cubby?.sha256 ?? ''); } },
  ], [
    { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { void remove(r); } },
  ]];
}

async function refresh(): Promise<void> { await scanCatalog(); toast.success('Plugin list refreshed.', { timeout: 1500 }); }

// ---- capabilities ----
const running = ref(new Set<string>());
async function run(r: PluginRow, c: LoadedCapability): Promise<void> {
  const k = `${c.pluginKey}/${c.name}`;
  running.value.add(k);
  try {
    const done = await runScriptCapability(c);
    // Orca PluginsDialog::run_script_plugin_capability: a failure records the error and unloads the plugin.
    if (!done.cancelled && (done.error || done.result?.status === 'RecoverableError' || done.result?.status === 'FatalError')) {
      await failPlugin(r.desc.pluginKey, done.error || done.result?.message || 'Script plugin failed.');
    }
    reportScriptOutcome(done, c.name);
  } finally { running.value.delete(k); }
}

const pipelineNames = computed(() => { void pluginState.configRevision; return selectedPipelineNames(); });
const pipelineFromSchema = computed(() => schemaHasPipelineKey());

const configCap = ref<string>('');
const configCaps = computed(() => selected.value?.caps ?? []);
const currentConfigCap = computed(() => configCaps.value.find((c) => `${c.type}/${c.name}` === configCap.value) ?? configCaps.value[0] ?? null);
watch(selected, () => { configCap.value = ''; });

// ---- permissions ----
const PERM_GROUPS: Array<{ key: keyof PluginPermissions; label: string; note: string }> = [
  { key: 'fs_read', label: 'Read files', note: PERMISSION_BROWSER_NOTES.fs },
  { key: 'fs_readwrite', label: 'Read and write files', note: PERMISSION_BROWSER_NOTES.fs },
  { key: 'network_http', label: 'Network access', note: PERMISSION_BROWSER_NOTES.network_http },
  { key: 'network_socket', label: 'Network sockets', note: PERMISSION_BROWSER_NOTES.network_socket },
  { key: 'process', label: 'Start programs', note: PERMISSION_BROWSER_NOTES.process },
  { key: 'events', label: 'Audit events', note: 'Individual audited operations without a target.' },
];
const perms = computed(() => selected.value?.desc.state?.permissions ?? null);

const logs = computed(() => pluginState.logs.filter((l) => !selected.value || l.pluginKey === selected.value.desc.pluginKey || (!l.pluginKey && l.level !== 'debug')).slice(-200));
const fmtTime = (t: number) => new Date(t).toLocaleTimeString();
</script>

<template>
  <AppDialog v-model:open="pluginsDialogOpen" title="Plugins" size="3xl" fullscreen body-class="flex min-h-0 flex-col gap-3 p-0! overflow-hidden">
      <div class="pd" :class="{ 'pd--drag': dragging }" data-testid="plugins-dialog"
           @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
        <UTabs v-model="view" :items="views" :content="false" size="sm" class="px-4 pt-3" />
        <div v-if="view === 'hub'" class="flex flex-col gap-3 px-4 pb-4 text-sm">
          <p>OrcaSlicer's plugin hub lives on Orca Cloud. CubbySlicer can't browse or subscribe from your browser: the Orca Cloud service only accepts requests from its own website and needs an Orca Cloud sign-in, which works in the OrcaSlicer desktop app only.</p>
          <p>To use a plugin from the hub: open it on Orca Cloud, download its <code>.py</code> or <code>.whl</code> file, then use <b>Install plugin ▸ Install from file</b> here (or drop the file onto this dialog).</p>
          <div><UButton :to="HUB_URL" target="_blank" icon="i-lucide-external-link" label="Open the Orca Cloud plugin hub" color="primary" /></div>
        </div>
        <template v-else>
          <UAlert color="warning" variant="subtle" icon="i-lucide-shield-alert" :description="TRUST" class="mx-4" :ui="{ description: 'text-xs' }" data-testid="plugins-trust" />
          <div class="flex flex-wrap items-center gap-2 px-4">
            <UInput v-model="query" icon="i-lucide-search" placeholder="Search plugins" size="sm" class="min-w-40 flex-1" aria-label="Search plugins">
              <template #trailing>
                <UButton size="xs" :variant="matchCase ? 'soft' : 'ghost'" label="Aa" title="Match case" aria-label="Match case" @click="matchCase = !matchCase" />
                <UButton size="xs" :variant="wholeWord ? 'soft' : 'ghost'" label="ab" title="Match whole word" aria-label="Match whole word" class="underline" @click="wholeWord = !wholeWord" />
              </template>
            </UInput>
            <UButton size="sm" variant="outline" icon="i-lucide-refresh-cw" label="Refresh" @click="refresh" />
            <UButtonGroup size="sm">
              <UButton color="primary" icon="i-lucide-plus" label="Install plugin" data-testid="plugins-install" @click="installFromFile" />
              <UDropdownMenu :items="installMenu"><UButton color="primary" icon="i-lucide-chevron-down" aria-label="More install options" data-testid="plugins-install-menu" /></UDropdownMenu>
            </UButtonGroup>
          </div>
          <p class="px-4 text-xs text-dimmed" data-testid="plugins-runtime">
            <template v-if="runtimeState.phase === 'off'">Python runtime not started (Pyodide {{ PYODIDE_VERSION }}, Python 3.12; starts when a plugin is enabled).</template>
            <template v-else-if="runtimeState.phase === 'booting'">Starting the Python runtime…</template>
            <template v-else-if="runtimeState.phase === 'ready'">Python {{ runtimeState.pythonVersion }} (Pyodide {{ PYODIDE_VERSION }}) started in {{ ((runtimeState.bootMs ?? 0) / 1000).toFixed(1) }} s.</template>
            <template v-else>The Python runtime failed to start: {{ runtimeState.error }}</template>
            <template v-if="!runtimeState.isolated && runtimeState.phase !== 'off'"> This page is not cross-origin isolated: plugin windows, notifications and G-code post-processing work; reading the project or presets and message boxes do not.</template>
          </p>

          <div class="pd__main">
            <div class="pd__list" role="table" aria-label="Installed plugins">
              <div class="pd__row pd__head" role="row">
                <span role="columnheader">Activate</span>
                <button v-for="[f, l] in ([['name', 'Name'], ['version', 'Plugin Version'], ['source', 'Source'], ['status', 'Status']] as const)" :key="f" type="button"
                        role="columnheader" class="pd__sort" @click="sortBy(f)">{{ l }}<UIcon v-if="sort.field === f" :name="sort.dir > 0 ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3" /></button>
                <span />
              </div>
              <div v-if="!rows.length" class="p-4 text-sm text-dimmed">
                {{ pluginState.rows.length ? 'No plugin matches the search.' : 'No plugins installed. Install a .py or .whl plugin file, or drop one here.' }}
              </div>
              <div v-for="r in rows" :key="r.desc.pluginKey" class="pd__row" role="row" :class="{ 'pd__row--sel': selected?.desc.pluginKey === r.desc.pluginKey }"
                   :data-testid="`plugin-row-${r.desc.pluginKey}`" @click="selectedKey = r.desc.pluginKey">
                <span role="cell" @click.stop><USwitch :model-value="!!r.desc.state?.enabled" :disabled="!r.desc.metadataValid" size="sm" :aria-label="`Activate ${r.desc.name}`"
                                                       :data-testid="`plugin-toggle-${r.desc.pluginKey}`" @update:model-value="(v: boolean) => toggle(r, v)" /></span>
                <span role="cell" class="truncate font-medium">{{ r.desc.name }}</span>
                <span role="cell" class="truncate">{{ r.desc.version || '—' }}</span>
                <span role="cell">{{ sourceLabel(r) }}</span>
                <span role="cell" :class="`pd__st pd__st--${r.status}`" :data-testid="`plugin-status-${r.desc.pluginKey}`">{{ statusLabel(r) }}</span>
                <span role="cell" @click.stop><UDropdownMenu :items="rowMenu(r)"><UButton icon="i-lucide-ellipsis" variant="ghost" size="xs" aria-label="Plugin actions" /></UDropdownMenu></span>
              </div>
            </div>

            <div v-if="selected" class="pd__detail">
              <UTabs v-model="tab" :items="tabs" :content="false" size="xs" variant="link" class="w-full" />
              <div class="pd__panel">
                <template v-if="tab === 'info'">
                  <dl class="pd__kv">
                    <dt>Name</dt><dd>{{ selected.desc.name }}</dd>
                    <dt>Author</dt><dd>{{ selected.desc.author || '—' }}</dd>
                    <dt>Version</dt><dd>{{ selected.desc.version || '—' }}</dd>
                    <dt>Source</dt><dd>{{ sourceLabel(selected) }}<span v-if="selected.desc.state?.cubby?.url" class="break-all text-dimmed"> · {{ selected.desc.state.cubby.url }}</span></dd>
                    <dt>File</dt><dd class="break-all">{{ selected.desc.entryFile || selected.desc.root }}</dd>
                    <dt>sha256</dt><dd class="break-all font-mono text-xs">{{ selected.desc.state?.cubby?.sha256 || '—' }}</dd>
                    <dt>Dependencies</dt><dd>{{ selected.desc.dependencies.join(', ') || 'none' }}</dd>
                    <dt>Status</dt><dd>{{ statusLabel(selected) }}<span v-if="selected.loadMs" class="text-dimmed"> · loaded in {{ selected.loadMs }} ms</span></dd>
                  </dl>
                  <p v-if="selected.error" class="text-sm text-error whitespace-pre-line" data-testid="plugin-error">{{ selected.error }}</p>
                  <h4 class="pd__h">Capabilities</h4>
                  <p v-if="!selected.caps.length" class="text-sm text-dimmed">{{ selected.status === 'loaded' ? 'None.' : 'Activate the plugin to load its capabilities.' }}</p>
                  <div v-for="c in selected.caps" :key="`${c.type}/${c.name}`" class="pd__cap" :data-testid="`plugin-cap-${c.name}`">
                    <USwitch :model-value="c.enabled" size="sm" :aria-label="`Enable ${c.name}`" @update:model-value="(v: boolean) => setCapabilityEnabled(c, v)" />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium">{{ c.name }}</p>
                      <p class="text-xs text-dimmed">
                        {{ CAPABILITY_TYPE_LABEL[c.type] }}
                        <template v-if="c.type === 'printer-connection'"> · not supported in CubbySlicer (no device manager)</template>
                        <template v-else-if="c.type === 'pages'"> · page tabs are not shown in CubbySlicer yet</template>
                        <template v-else-if="c.type === 'resource-texture'"> · {{ c.textureError ?? `${c.textureFiles?.length ?? 0} textures (CubbySlicer has no Texture Displacement yet)` }}</template>
                        <template v-else-if="c.type === 'slicing-pipeline'"> · runs at G-code export and send; in-slicer steps are not wired yet</template>
                      </p>
                    </div>
                    <UCheckbox v-if="c.type === 'slicing-pipeline'" :model-value="pipelineNames.includes(c.name)" :disabled="!c.enabled"
                               :label="pipelineFromSchema ? 'In process preset' : 'Use when exporting'" :data-testid="`plugin-pipeline-${c.name}`"
                               @update:model-value="(v: boolean | 'indeterminate') => setPipelineSelected(c.name, v === true)" />
                    <UButton v-if="c.type === 'script'" size="xs" color="primary" icon="i-lucide-play" label="Run" :disabled="!c.enabled || selected.status !== 'loaded'"
                             :loading="running.has(`${c.pluginKey}/${c.name}`)" :data-testid="`plugin-run-${c.name}`" @click="run(selected, c)" />
                  </div>
                  <p v-if="selected.caps.some((c) => c.type === 'slicing-pipeline') && !pipelineFromSchema" class="text-xs text-dimmed">
                    This engine build has no <code>slicing_pipeline_plugin</code> setting yet, so CubbySlicer keeps the selection itself.
                  </p>
                </template>
                <p v-else-if="tab === 'description'" class="whitespace-pre-line text-sm">{{ selected.desc.description || 'No description.' }}</p>
                <template v-else-if="tab === 'config'">
                  <p v-if="!configCaps.length" class="text-sm text-dimmed">Activate the plugin to configure its capabilities.</p>
                  <template v-else>
                    <USelect v-if="configCaps.length > 1" v-model="configCap" :items="configCaps.map((c) => ({ label: `${c.name} (${CAPABILITY_TYPE_LABEL[c.type]})`, value: `${c.type}/${c.name}` }))"
                             size="sm" class="w-full" placeholder="Capability" />
                    <PluginConfigEditor v-if="currentConfigCap" :key="`${selected.desc.pluginKey}/${currentConfigCap.type}/${currentConfigCap.name}`" :cap="currentConfigCap"
                                        :plugin-version="selected.desc.version" />
                  </template>
                </template>
                <template v-else-if="tab === 'permissions'">
                  <p class="text-xs text-dimmed">Grants are kept in the plugin's .install_state.json, as in OrcaSlicer. Reinstalling the plugin clears them.</p>
                  <div v-if="perms?.full_access" class="flex items-center gap-2 text-sm text-warning">
                    Full access is on.<UButton size="xs" variant="outline" label="Turn off" @click="revokePermission(selected.desc.pluginKey, 'full_access')" />
                  </div>
                  <div v-for="g in PERM_GROUPS" :key="g.key" class="pd__perm">
                    <p class="text-sm font-medium">{{ g.label }}</p>
                    <p class="text-xs text-dimmed">{{ g.note }}</p>
                    <p v-if="!(perms?.[g.key] as string[] | undefined)?.length" class="text-xs text-dimmed">None granted.</p>
                    <div v-for="t in (perms?.[g.key] as string[] | undefined) ?? []" :key="t" class="flex items-center gap-2 text-xs">
                      <span class="flex-1 break-all font-mono">{{ t }}</span>
                      <UButton size="xs" variant="ghost" icon="i-lucide-x" :aria-label="`Revoke ${t}`" @click="revokePermission(selected.desc.pluginKey, g.key, t)" />
                    </div>
                  </div>
                  <div class="pd__perm">
                    <p class="text-sm font-medium">Threads</p>
                    <p class="text-xs text-dimmed">{{ PERMISSION_BROWSER_NOTES.threading }} {{ perms?.threading ? 'Granted.' : 'Not granted.' }}</p>
                  </div>
                </template>
                <template v-else>
                  <pre v-if="selected.traceback" class="pd__log text-error" data-testid="plugin-traceback">{{ selected.traceback }}</pre>
                  <div class="pd__log" data-testid="plugin-log">
                    <div v-for="(l, i) in logs" :key="i" :class="l.level === 'error' ? 'text-error' : l.level === 'warn' ? 'text-warning' : ''">
                      <span class="text-dimmed">{{ fmtTime(l.at) }}</span> {{ l.text }}
                    </div>
                    <p v-if="!logs.length" class="text-dimmed">Nothing logged yet.</p>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>

        <div v-if="pending" class="pd__sheet" data-testid="plugin-install-sheet">
          <div class="pd__sheet-card">
            <h3 class="text-base font-semibold">Install {{ pending.name }}?</h3>
            <dl class="pd__kv">
              <dt>File</dt><dd class="break-all">{{ pending.fileName }}</dd>
              <dt>Version</dt><dd>{{ pending.version || '—' }}</dd>
              <dt>Author</dt><dd>{{ pending.author || '—' }}</dd>
              <dt>Dependencies</dt><dd>{{ pending.dependencies.join(', ') || 'none' }}</dd>
              <dt>sha256</dt><dd class="break-all font-mono text-xs">{{ pending.sha256 }}</dd>
            </dl>
            <p v-if="pending.description" class="text-sm">{{ pending.description }}</p>
            <UAlert v-if="pending.exists" color="warning" variant="subtle" icon="i-lucide-replace" description="A plugin with this file name is installed. Installing replaces it and clears its permissions." />
            <p class="text-xs text-dimmed">{{ TRUST }}</p>
            <div class="flex justify-end gap-2">
              <UButton label="Cancel" variant="outline" @click="pending = null" />
              <UButton :label="pending.exists ? 'Replace' : 'Install'" color="primary" :loading="busy" data-testid="plugin-install-confirm" @click="confirmInstall" />
            </div>
          </div>
        </div>

        <div v-if="urlOpen" class="pd__sheet">
          <div class="pd__sheet-card">
            <h3 class="text-base font-semibold">Install from URL</h3>
            <UInput v-model="urlText" placeholder="https://…/my_plugin.py" class="w-full" aria-label="Plugin URL" data-testid="plugin-url" @keydown.enter="installFromUrl" />
            <p class="text-xs text-dimmed">A link to a .py or .whl file. The site must allow downloads from other web pages (CORS); raw GitHub and gist links do.</p>
            <div class="flex justify-end gap-2">
              <UButton label="Cancel" variant="outline" @click="urlOpen = false" />
              <UButton label="Download" color="primary" :loading="busy" :disabled="!urlText.trim()" @click="installFromUrl" />
            </div>
          </div>
        </div>
      </div>
  </AppDialog>
</template>

<style scoped>
.pd { position: relative; display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; padding-bottom: 12px; }
.pd--drag { outline: 2px dashed var(--ui-primary); outline-offset: -6px; }
.pd__main { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; padding: 0 16px; }
.pd__list { flex: 0 1 auto; max-height: 40%; min-height: 96px; overflow: auto; border: 1px solid var(--ui-border); border-radius: 6px; }
.pd__row { display: grid; grid-template-columns: 64px minmax(0, 2fr) minmax(0, 1fr) 72px 96px 36px; align-items: center; gap: 8px; padding: 4px 8px; font-size: 13px; cursor: pointer; border-bottom: 1px solid var(--ui-border); }
.pd__row:last-child { border-bottom: 0; }
.pd__row--sel { background: var(--ui-bg-elevated); }
.pd__head { position: sticky; top: 0; background: var(--ui-bg); font-size: 12px; color: var(--ui-text-muted); cursor: default; z-index: 1; }
.pd__sort { display: inline-flex; align-items: center; gap: 2px; text-align: left; }
.pd__st--loaded { color: var(--ui-success); }
.pd__st--error { color: var(--ui-error); }
.pd__st--loading { color: var(--ui-info); }
.pd__detail { display: flex; flex-direction: column; min-height: 0; flex: 1 1 260px; border: 1px solid var(--ui-border); border-radius: 6px; }
.pd__panel { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; overflow: auto; min-height: 0; flex: 1; }
.pd__kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 13px; }
.pd__kv dt { color: var(--ui-text-muted); }
.pd__h { font-size: 12px; font-weight: 600; color: var(--ui-text-muted); text-transform: uppercase; letter-spacing: .04em; margin-top: 4px; }
.pd__cap { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--ui-border); flex-wrap: wrap; }
.pd__perm { border-top: 1px solid var(--ui-border); padding-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.pd__log { font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--ui-border); border-radius: 6px; padding: 6px 8px; max-height: 320px; overflow: auto; }
.pd__sheet { position: absolute; inset: 0; background: rgb(0 0 0 / 0.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 5; }
.pd__sheet-card { background: var(--ui-bg); border: 1px solid var(--ui-border); border-radius: 8px; padding: 16px; width: min(560px, 100%); max-height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
@media (max-width: 640px) {
  .pd__row { grid-template-columns: 52px minmax(0, 1fr) 72px 36px; }
  .pd__row > :nth-child(3), .pd__row > :nth-child(4) { display: none; }
  .pd__list { max-height: 45%; }
}
</style>
