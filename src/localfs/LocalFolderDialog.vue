<script setup lang="ts">
/**
 * Local folders (File System Access API): folders the user approved (kept
 * across visits; access is re-confirmed when needed), their projects / models,
 * and recent local files. Modes: open a file, save the project into a folder,
 * export G-code / 3MF into a folder.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { phone } from '../app/shell/uiState';
import { confirmAction } from '../app/shell/uiState';
import { toast } from '../ui';
import { isModelFileName } from '../project/import';
import { PROJECT_EXT } from '../project/persistence/projectFile';
import { exportPayload, suggestedProjectName } from '../cloud/commands';
import {
  addFolder, deleteInFolder, ensurePermission, existsInFolder, folderAccessSupported, forget, listFolder, loadSaved, local,
  type FolderEntry, type SavedHandle,
} from './store';
import { exportInFolder, folderDialog, openLocalHandle, openRecent, saveProjectInFolder } from './commands';

const open = computed({ get: () => !!folderDialog.value, set: (v: boolean) => { if (!v) folderDialog.value = null; } });
const mode = computed(() => folderDialog.value?.mode ?? 'open');
const exportKind = computed(() => folderDialog.value?.exportKind ?? 'gcode');
const title = computed(() => mode.value === 'open' ? 'Open from a local folder' : mode.value === 'save' ? 'Save project to a local folder'
  : `Export ${exportKind.value === 'gcode' ? 'G-code' : '3MF'} to a local folder`);
const ext = computed(() => mode.value === 'save' ? PROJECT_EXT : exportKind.value === 'gcode' ? '.gcode' : '.3mf');

const tab = ref<'folders' | 'recent'>('folders');
const root = shallowRef<SavedHandle<FileSystemDirectoryHandle> | null>(null);
/** Directory stack below the root (for breadcrumbs / up). */
const stack = shallowRef<FileSystemDirectoryHandle[]>([]);
const entries = shallowRef<FolderEntry[]>([]);
const loading = ref(false);
const needsGrant = ref(false);
const name = ref('');
const busy = ref(false);

const cwd = computed(() => stack.value[stack.value.length - 1] ?? root.value?.handle ?? null);
const relevant = (n: string) => {
  const l = n.toLowerCase();
  return mode.value === 'open' ? l.endsWith(PROJECT_EXT) || isModelFileName(l) : l.endsWith(ext.value);
};
const rows = computed(() => entries.value.filter((e) => e.kind === 'directory' || relevant(e.name)));
const target = computed(() => { let n = name.value.trim(); if (n && !n.toLowerCase().endsWith(ext.value)) n += ext.value; return n; });
const validName = computed(() => !!target.value && !/[\\/:*?"<>|]/.test(target.value));

watch(open, async (o) => {
  if (!o) return;
  await loadSaved();
  tab.value = mode.value === 'open' && !local.folders.length && local.recent.length ? 'recent' : 'folders';
  const sug = folderDialog.value?.suggestedName ?? (mode.value === 'save' ? suggestedProjectName() : exportPayload(exportKind.value)?.name ?? '');
  name.value = sug;
  if (!root.value && local.folders.length) await choose(local.folders[0]);
  else if (root.value) await refresh();
});

async function choose(f: SavedHandle<FileSystemDirectoryHandle>): Promise<void> {
  root.value = f; stack.value = []; await refresh();
}
async function refresh(): Promise<void> {
  const dir = cwd.value;
  entries.value = [];
  if (!dir) return;
  loading.value = true;
  needsGrant.value = false;
  try {
    if (dir.queryPermission && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') { needsGrant.value = true; return; }
    entries.value = await listFolder(dir);
  } catch (e) { toast.error(`Couldn't read ${dir.name}.`, { detail: (e as Error)?.message }); } finally { loading.value = false; }
}
/** Browsers ask again after a restart; this runs from the click (user gesture). */
async function grant(): Promise<void> {
  const dir = cwd.value;
  if (!dir) return;
  if (await ensurePermission(dir, 'readwrite')) await refresh();
  else toast.warn(`Access to ${dir.name} was not granted.`);
}
async function add(): Promise<void> {
  try { const f = await addFolder(); if (f) await choose(f); } catch (e) { toast.error("Couldn't add the folder.", { detail: (e as Error)?.message }); }
}
async function removeFolder(f: SavedHandle<FileSystemDirectoryHandle>): Promise<void> {
  await forget('folders', f.key);
  if (root.value?.key === f.key) { root.value = local.folders[0] ?? null; stack.value = []; await refresh(); }
}
async function enter(e: FolderEntry): Promise<void> {
  if (e.kind === 'directory') { stack.value = [...stack.value, e.handle as FileSystemDirectoryHandle]; await refresh(); return; }
  if (mode.value === 'open') {
    folderDialog.value = null;
    await openLocalHandle(e.handle as FileSystemFileHandle, cwd.value?.name);
  } else name.value = e.name;
}
async function up(i: number): Promise<void> { stack.value = stack.value.slice(0, i); await refresh(); }

async function commit(): Promise<void> {
  const dir = cwd.value;
  if (!dir || !validName.value) return;
  if (await existsInFolder(dir, target.value)) {
    const ok = await confirmAction({ title: `Replace ${target.value}?`, message: `A file with this name already exists in ${dir.name}.`, confirmLabel: 'Replace', danger: true });
    if (!ok) return;
  }
  busy.value = true;
  try {
    let ok: boolean;
    if (mode.value === 'save') ok = await saveProjectInFolder(dir, target.value);
    else {
      const p = exportPayload(exportKind.value);
      if (!p) { toast.info(exportKind.value === 'gcode' ? 'Slice the plate before exporting G-code.' : 'The plate is empty.'); return; }
      ok = await exportInFolder(dir, target.value, p.blob);
    }
    if (ok) folderDialog.value = null;
  } finally { busy.value = false; }
}
async function del(e: FolderEntry): Promise<void> {
  const dir = cwd.value;
  if (!dir || e.kind !== 'file') return;
  if (!(await confirmAction({ title: `Delete ${e.name}?`, message: `The file is removed from ${dir.name} on this computer.`, confirmLabel: 'Delete', danger: true }))) return;
  try { await deleteInFolder(dir, e.name); await refresh(); } catch (err) { toast.error(`Couldn't delete ${e.name}.`, { detail: (err as Error)?.message }); }
}
async function pickRecent(r: SavedHandle<FileSystemFileHandle>): Promise<void> { folderDialog.value = null; await openRecent(r); }

const size = (n?: number) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const when = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const icon = (e: FolderEntry) => e.kind === 'directory' ? 'i-lucide-folder' : e.name.toLowerCase().endsWith(PROJECT_EXT) ? 'i-lucide-layers' : e.name.toLowerCase().endsWith('.gcode') ? 'i-lucide-file-code' : 'i-lucide-box';
</script>

<template>
  <UModal v-model:open="open" :title="title" :fullscreen="phone" :ui="{ content: 'sm:max-w-3xl', body: 'flex flex-col gap-3' }">
    <template #body>
      <p v-if="!folderAccessSupported" class="text-sm text-muted">This browser can't open local folders (the File System Access API is available in Chrome, Edge and other Chromium browsers). Use Open / Import instead.</p>
      <template v-else>
        <UTabs v-if="mode === 'open'" v-model="tab" :items="[{ value: 'folders', label: 'Folders' }, { value: 'recent', label: `Recent (${local.recent.length})` }]" :content="false" size="xs" />
        <div v-if="tab === 'recent' && mode === 'open'" class="lf__list">
          <p v-if="!local.recent.length" class="lf__empty">Files you open or save here appear in this list.</p>
          <div v-for="r in local.recent" :key="r.key" class="lf__row" role="option" tabindex="0" @click="pickRecent(r)" @keydown.enter="pickRecent(r)">
            <UIcon name="i-lucide-history" class="lf__icon" />
            <span class="lf__name">{{ r.name }}</span>
            <span class="lf__meta">{{ when(r.addedAt) }}</span>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Forget ${r.name}`" class="lf__del" @click.stop="forget('recent', r.key)" />
          </div>
        </div>
        <div v-else class="lf">
          <aside class="lf__side" aria-label="Approved folders">
            <button v-for="f in local.folders" :key="f.key" type="button" class="lf__folder" :class="{ on: root?.key === f.key }" @click="choose(f)">
              <UIcon name="i-lucide-folder-open" class="size-4 shrink-0" /><span class="truncate">{{ f.name }}</span>
              <UIcon name="i-lucide-x" class="lf__fx" role="button" :aria-label="`Remove ${f.name}`" @click.stop="removeFolder(f)" />
            </button>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-folder-plus" label="Add folder…" block @click="add" />
            <p class="lf__hint">Folders you add here stay available on this browser. The files never leave your computer.</p>
          </aside>
          <div class="lf__main">
            <nav v-if="root" class="lf__crumbs" aria-label="Folder">
              <button type="button" @click="up(0)">{{ root.name }}</button>
              <template v-for="(d, i) in stack" :key="i"><span>/</span><button type="button" @click="up(i + 1)">{{ d.name }}</button></template>
              <span class="flex-1" />
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Refresh" @click="refresh" />
            </nav>
            <div class="lf__list">
              <p v-if="!root" class="lf__empty">Add a folder to browse its projects and models.</p>
              <div v-else-if="needsGrant" class="lf__empty">
                <p>Allow access to “{{ cwd?.name }}” for this session.</p>
                <UButton size="sm" color="primary" icon="i-lucide-unlock" label="Allow access" @click="grant" />
              </div>
              <p v-else-if="loading" class="lf__empty">Reading…</p>
              <p v-else-if="!rows.length" class="lf__empty">{{ mode === 'open' ? 'No projects or models here.' : `No ${ext} files here yet.` }}</p>
              <div v-for="e in rows" v-else :key="e.name" class="lf__row" role="option" tabindex="0" :class="{ on: e.kind === 'file' && e.name === target }"
                   @click="enter(e)" @keydown.enter="enter(e)">
                <UIcon :name="icon(e)" class="lf__icon" />
                <span class="lf__name">{{ e.name }}</span>
                <span class="lf__meta">{{ e.kind === 'file' ? `${size(e.size)} ${when(e.modified)}` : '' }}</span>
                <UButton v-if="e.kind === 'file'" size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="`Delete ${e.name}`" class="lf__del" @click.stop="del(e)" />
              </div>
            </div>
            <UInput v-if="mode !== 'open' && root && !needsGrant" v-model="name" :placeholder="`name${ext}`" aria-label="File name" @keydown.enter="commit" />
          </div>
        </div>
      </template>
    </template>
    <template v-if="mode !== 'open' && folderAccessSupported" #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" :label="mode === 'save' ? 'Save' : 'Export'" :loading="busy" :disabled="!cwd || needsGrant || !validName" @click="commit" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.lf { display: grid; grid-template-columns: 200px 1fr; gap: 12px; min-height: 300px; }
@media (max-width: 640px) { .lf { grid-template-columns: 1fr; } }
.lf__side { display: flex; flex-direction: column; gap: 4px; }
.lf__folder { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: var(--radius-sm); font-size: 13px; color: var(--fg-1); text-align: left; }
.lf__folder:hover { background: var(--bg-3); }
.lf__folder.on { background: color-mix(in srgb, var(--ui-primary) 14%, transparent); color: var(--fg-0); }
.lf__fx { margin-left: auto; opacity: 0; width: 14px; height: 14px; }
.lf__folder:hover .lf__fx { opacity: 0.7; }
.lf__hint { font-size: 11px; color: var(--fg-2); margin-top: 4px; }
.lf__main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lf__crumbs { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ui-text-muted); }
.lf__crumbs button:hover { color: var(--ui-primary); }
.lf__list { border: 1px solid var(--ui-border); border-radius: var(--radius); min-height: 220px; max-height: min(50vh, 420px); overflow: auto; }
.lf__row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px; border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 50%, transparent); }
.lf__row:hover, .lf__row:focus-visible { background: var(--ui-bg-elevated); outline: none; }
.lf__row.on { background: color-mix(in srgb, var(--ui-primary) 14%, transparent); }
.lf__icon { width: 16px; height: 16px; flex: none; color: var(--ui-text-muted); }
.lf__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lf__meta { font-size: 11px; color: var(--ui-text-dimmed); white-space: nowrap; }
.lf__del { opacity: 0; }
.lf__row:hover .lf__del { opacity: 1; }
.lf__empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; text-align: center; font-size: 13px; color: var(--ui-text-muted); }
</style>
