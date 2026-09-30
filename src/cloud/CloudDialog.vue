<script setup lang="ts">
/**
 * CubbyCAD files: sign in (shared with the editor), pick a workspace, then
 * open a project / model, save the project, or export G-code / 3MF into it.
 * Driven by `cloudDialog` (store.ts); the plate work is in commands.ts.
 */
import { computed, ref, watch } from 'vue';
import { mobileDialog } from '../ui/mobileDialog';
import { confirmAction } from '../app/shell/uiState';
import { toast } from '../ui';
import {
  CloudAuthError, authProviders, deleteFile, isSafePath, listFiles, loginWithPassword, logout, providerLoginUrl,
  type CloudFile, type CloudProvider,
} from './api';
import { cloud, cloudDialog, refreshUser, refreshWorkspaces } from './store';
import { exportTo, isOpenableCloudFile, openCloudFile, saveProjectTo } from './commands';

const open = computed({
  get: () => !!cloudDialog.value,
  set: (v: boolean) => { if (!v) cloudDialog.value = null; },
});
const mode = computed(() => cloudDialog.value?.mode ?? 'open');
const exportKind = computed(() => cloudDialog.value?.exportKind ?? 'gcode');
const title = computed(() => mode.value === 'open' ? 'Open from CubbyCAD'
  : mode.value === 'save' ? 'Save project to CubbyCAD'
    : `Export ${exportKind.value === 'gcode' ? 'G-code' : '3MF'} to CubbyCAD`);

const loading = ref(false);
const error = ref<string | null>(null);
const providers = ref<CloudProvider[]>([]);
const email = ref('');
const password = ref('');
const signingIn = ref(false);

const wsId = ref<string | null>(null);
const files = ref<CloudFile[]>([]);
const filesLoading = ref(false);
const folder = ref('');
const name = ref('');
const filter = ref('');
const busy = ref(false);
/** Signed out: Open can still browse public workspaces; Save / export (or "Sign in") shows the form. */
const wantSignIn = ref(false);
const showSignIn = computed(() => !cloud.user && (mode.value !== 'open' || wantSignIn.value || !cloud.workspaces.length));

const workspace = computed(() => cloud.workspaces.find((w) => w.id === wsId.value) ?? null);
const wsItems = computed(() => cloud.workspaces.map((w) => ({ value: w.id, label: w.writable ? w.name : `${w.name} (read-only)` })));

/** Extension the current mode writes (save / export). */
const ext = computed(() => mode.value === 'save' ? '.3mf' : exportKind.value === 'gcode' ? '.gcode' : '.3mf');

function relevant(f: CloudFile): boolean {
  const p = f.path.toLowerCase();
  if (mode.value === 'open') return isOpenableCloudFile(p);
  return p.endsWith(ext.value);
}

interface Row { kind: 'dir' | 'file'; name: string; path: string; file?: CloudFile }
/** One folder level of the (flat) asset list, folders first. */
const rows = computed<Row[]>(() => {
  const pre = folder.value ? `${folder.value}/` : '';
  const q = filter.value.trim().toLowerCase();
  const dirs = new Set<string>();
  const out: Row[] = [];
  for (const f of files.value) {
    if (!f.path.startsWith(pre)) continue;
    const rest = f.path.slice(pre.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      // Only list folders that contain something relevant.
      if (relevant(f)) dirs.add(rest.slice(0, slash));
      continue;
    }
    if (!relevant(f)) continue;
    if (q && !rest.toLowerCase().includes(q)) continue;
    out.push({ kind: 'file', name: rest, path: f.path, file: f });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const d = [...dirs].sort().filter((x) => !q || x.toLowerCase().includes(q)).map((x): Row => ({ kind: 'dir', name: x, path: `${pre}${x}` }));
  return [...d, ...out];
});
const crumbs = computed(() => folder.value ? folder.value.split('/') : []);

const targetPath = computed(() => {
  let n = name.value.trim();
  if (!n) return '';
  if (!n.toLowerCase().endsWith(ext.value)) n += ext.value;
  return folder.value ? `${folder.value}/${n}` : n;
});
const targetValid = computed(() => !!targetPath.value && isSafePath(targetPath.value));
const exists = computed(() => files.value.some((f) => f.path === targetPath.value));

async function init(): Promise<void> {
  error.value = null;
  loading.value = true;
  try {
    wantSignIn.value = false;
    const user = await refreshUser();
    if (!user) providers.value = await authProviders();
    if (!user && mode.value !== 'open') return;
    await refreshWorkspaces();
    const want = cloud.location?.workspaceId;
    const prev = wsId.value;
    wsId.value = cloud.workspaces.find((w) => w.id === want)?.id
      ?? cloud.workspaces.find((w) => w.writable || mode.value === 'open')?.id
      ?? cloud.workspaces[0]?.id ?? null;
    // Save / export: start in the cloud file's folder with the suggested name.
    const sug = cloudDialog.value?.suggestedName ?? '';
    const cut = sug.lastIndexOf('/');
    if (mode.value !== 'open') {
      folder.value = cut >= 0 && want === wsId.value ? sug.slice(0, cut) : (cloud.location && want === wsId.value ? cloud.location.path.split('/').slice(0, -1).join('/') : '');
      name.value = cut >= 0 ? sug.slice(cut + 1) : sug;
    } else folder.value = '';
    filter.value = '';
    if (wsId.value === prev) void loadFiles(); // the watch only fires on a change
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  } finally { loading.value = false; }
}

async function loadFiles(): Promise<void> {
  files.value = [];
  if (!wsId.value) return;
  filesLoading.value = true;
  try { files.value = await listFiles(wsId.value); } catch (e) {
    if (e instanceof CloudAuthError) { cloud.user = null; providers.value = await authProviders(); }
    else error.value = (e as Error)?.message ?? String(e);
  } finally { filesLoading.value = false; }
}

watch(open, (o) => { if (o) void init(); });
watch(wsId, () => { if (open.value) { if (mode.value === 'open') folder.value = ''; void loadFiles(); } });

async function sso(p: CloudProvider): Promise<void> {
  // Full-page redirect; the ?cloud=<mode> flag reopens this dialog on return.
  const u = new URL(location.href);
  u.searchParams.set('cloud', mode.value === 'open' ? 'open' : 'save');
  location.href = await providerLoginUrl(p.name, u.href);
}

async function signIn(): Promise<void> {
  if (!email.value || !password.value) return;
  signingIn.value = true; error.value = null;
  try {
    await loginWithPassword(email.value.trim(), password.value);
    password.value = '';
    await init();
  } catch (e) { error.value = (e as Error)?.message ?? String(e); } finally { signingIn.value = false; }
}

async function signOut(): Promise<void> {
  await logout();
  cloud.user = null; cloud.workspaces = []; files.value = []; wsId.value = null;
  await init(); // Open falls back to the public workspaces
}

async function pick(r: Row): Promise<void> {
  if (r.kind === 'dir') { folder.value = r.path; return; }
  if (mode.value === 'open') {
    if (!wsId.value) return;
    busy.value = true;
    const ws = wsId.value, wsName = workspace.value?.name;
    cloudDialog.value = null;
    try { await openCloudFile(ws, r.path, wsName); } finally { busy.value = false; }
  } else {
    name.value = r.name;
  }
}

async function commit(): Promise<void> {
  if (!wsId.value || !targetValid.value) return;
  if (workspace.value && !workspace.value.writable) { toast.error('This workspace is read-only.'); return; }
  if (exists.value && !(cloud.location && cloud.location.workspaceId === wsId.value && cloud.location.path === targetPath.value && mode.value === 'save')) {
    const ok = await confirmAction({ title: `Replace ${targetPath.value.split('/').pop()}?`, message: 'A file with this name already exists in this folder. Saving replaces it.', confirmLabel: 'Replace', danger: true });
    if (!ok) return;
  }
  busy.value = true;
  try {
    const ok = mode.value === 'save'
      ? await saveProjectTo(wsId.value, targetPath.value, workspace.value?.name)
      : await exportTo(exportKind.value, wsId.value, targetPath.value);
    if (ok) cloudDialog.value = null;
  } finally { busy.value = false; }
}

async function remove(r: Row): Promise<void> {
  if (!wsId.value || r.kind !== 'file') return;
  const ok = await confirmAction({ title: `Delete ${r.name}?`, message: 'The file is removed from the workspace for everyone.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await deleteFile(wsId.value, r.path);
    files.value = files.value.filter((f) => f.path !== r.path);
    if (cloud.location?.workspaceId === wsId.value && cloud.location.path === r.path) cloud.location = null;
  } catch (e) { toast.error(`Couldn't delete ${r.name}.`, { detail: (e as Error)?.message }); }
}

function newFolder(): void {
  const n = window.prompt('Folder name');
  const clean = n?.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) return;
  const p = folder.value ? `${folder.value}/${clean}` : clean;
  if (!isSafePath(p)) { toast.error('That folder name is not valid.'); return; }
  folder.value = p; // folders exist once a file is saved into them
}

function size(n?: number): string {
  if (n == null) return '';
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
function when(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function iconFor(r: Row): string {
  if (r.kind === 'dir') return 'i-lucide-folder';
  const p = r.name.toLowerCase();
  if (p.endsWith('.gcode')) return 'i-lucide-file-code';
  return 'i-lucide-box';
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :fullscreen="mobileDialog" :ui="{ content: 'sm:max-w-2xl', body: 'flex flex-col gap-3' }">
    <template #body>
      <div v-if="loading" class="cd__center"><UIcon name="i-lucide-loader-circle" class="animate-spin size-5" /> Connecting to CubbyCAD…</div>

      <!-- Sign in (the session is shared with the CubbyCAD editor) -->
      <div v-else-if="showSignIn" class="cd__signin">
        <p class="text-sm text-muted">Sign in to CubbyCAD to open and save files in your workspaces.</p>
        <div v-if="providers.length" class="flex flex-col gap-2">
          <UButton v-for="p in providers" :key="p.name" block color="neutral" variant="outline" :icon="p.name === 'google' ? 'i-lucide-chrome' : 'i-lucide-log-in'"
                   :label="`Continue with ${p.label.charAt(0).toUpperCase()}${p.label.slice(1)}`" @click="sso(p)" />
          <USeparator label="or" />
        </div>
        <form class="flex flex-col gap-2" @submit.prevent="signIn">
          <UInput v-model="email" type="email" placeholder="Email" autocomplete="username" />
          <UInput v-model="password" type="password" placeholder="Password" autocomplete="current-password" />
          <UButton type="submit" block color="primary" label="Sign in" :loading="signingIn" :disabled="!email || !password" />
        </form>
        <p v-if="error" class="cd__err">{{ error }}</p>
        <UButton v-if="mode === 'open' && cloud.workspaces.length" variant="link" color="neutral" size="xs" label="Browse public workspaces instead" @click="wantSignIn = false" />
      </div>

      <template v-else>
        <div class="cd__bar">
          <USelect v-model="wsId" :items="wsItems" placeholder="Workspace" class="min-w-48 flex-1 phone:min-w-0" aria-label="Workspace" />
          <UInput v-model="filter" icon="i-lucide-search" placeholder="Filter" size="sm" class="w-36 phone:w-28" aria-label="Filter files" />
          <UDropdownMenu v-if="cloud.user" :items="[[{ label: cloud.user.email || cloud.user.name, type: 'label' }], [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }]]">
            <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-user-round" :aria-label="`Signed in as ${cloud.user.name}`" />
          </UDropdownMenu>
          <UButton v-else color="neutral" variant="outline" size="sm" icon="i-lucide-log-in" label="Sign in" @click="wantSignIn = true" />
        </div>
        <p v-if="!cloud.user" class="text-xs text-muted">Showing public workspaces. Sign in to see and save to your own.</p>
        <p v-if="!cloud.workspaces.length" class="text-sm text-muted">You have no workspaces yet. Create one in the CubbyCAD editor.</p>
        <template v-else>
          <nav class="cd__crumbs" aria-label="Folder">
            <button type="button" @click="folder = ''">{{ workspace?.name ?? 'Workspace' }}</button>
            <template v-for="(c, i) in crumbs" :key="i">
              <span>/</span><button type="button" @click="folder = crumbs.slice(0, i + 1).join('/')">{{ c }}</button>
            </template>
            <span class="flex-1" />
            <UButton v-if="mode !== 'open'" size="xs" color="neutral" variant="ghost" icon="i-lucide-folder-plus" label="New folder" @click="newFolder" />
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Refresh" @click="loadFiles" />
          </nav>
          <div class="cd__list" role="listbox" :aria-busy="filesLoading">
            <div v-if="filesLoading" class="cd__center"><UIcon name="i-lucide-loader-circle" class="animate-spin size-4" /> Loading files…</div>
            <p v-else-if="!rows.length" class="cd__empty">
              {{ mode === 'open' ? 'No projects or models here. Supported: 3MF (including Orca projects), STL, OBJ, STEP.' : `No ${ext} files here yet.` }}
            </p>
            <div v-for="r in rows" v-else :key="r.path" class="cd__row" role="option" :aria-selected="r.kind === 'file' && r.path === targetPath"
                 :class="{ on: r.kind === 'file' && r.path === targetPath }" tabindex="0" @click="pick(r)" @keydown.enter="pick(r)"
                 @dblclick="mode !== 'open' && r.kind === 'file' ? commit() : undefined">
              <UIcon :name="iconFor(r)" class="cd__icon" />
              <span class="cd__name">{{ r.name }}</span>
              <span class="cd__meta">{{ r.kind === 'file' ? `${size(r.file?.size)} ${when(r.file?.modifiedAt)}` : '' }}</span>
              <UButton v-if="r.kind === 'file' && workspace?.writable" size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2"
                       :aria-label="`Delete ${r.name}`" class="cd__del" @click.stop="remove(r)" />
            </div>
          </div>
          <div v-if="mode !== 'open'" class="cd__save">
            <UInput v-model="name" :placeholder="`name${ext}`" class="flex-1" aria-label="File name" @keydown.enter="commit" />
          </div>
          <p v-if="mode !== 'open' && name && !targetValid" class="cd__err">That file name is not valid.</p>
          <p v-if="workspace && !workspace.writable && mode !== 'open'" class="cd__err">This workspace is read-only.</p>
        </template>
        <p v-if="error" class="cd__err">{{ error }}</p>
      </template>
    </template>
    <template v-if="cloud.user && mode !== 'open' && !loading" #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton color="primary" :label="exists ? 'Replace' : mode === 'save' ? 'Save' : 'Export'" :loading="busy"
                 :disabled="!wsId || !targetValid || (workspace ? !workspace.writable : true)" @click="commit" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.cd__center { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 24px; color: var(--ui-text-muted); font-size: 13px; }
.cd__signin { display: flex; flex-direction: column; gap: 12px; max-width: 360px; margin: 0 auto; width: 100%; padding: 8px 0; }
.cd__bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cd__crumbs { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--ui-text-muted); min-height: 28px; }
.cd__crumbs button { color: var(--ui-text-toned); }
.cd__crumbs button:hover { color: var(--ui-primary); }
.cd__list { border: 1px solid var(--ui-border); border-radius: var(--radius); min-height: 200px; max-height: min(50vh, 420px); overflow: auto; }
.cd__row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 13px; border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 50%, transparent); }
.cd__row:hover, .cd__row:focus-visible { background: var(--ui-bg-elevated); outline: none; }
.cd__row.on { background: color-mix(in srgb, var(--ui-primary) 14%, transparent); }
.cd__icon { width: 16px; height: 16px; flex: none; color: var(--ui-text-muted); }
.cd__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd__meta { font-size: 11px; color: var(--ui-text-dimmed); white-space: nowrap; }
.cd__del { opacity: 0; }
.cd__row:hover .cd__del, .cd__row:focus-within .cd__del { opacity: 1; }
@media (hover: none) { .cd__del { opacity: 1; } .cd__meta { display: none; } }
.cd__empty { padding: 24px; text-align: center; font-size: 13px; color: var(--ui-text-muted); }
.cd__save { display: flex; gap: 8px; }
.cd__crumbs { min-width: 0; }
.cd__crumbs > button { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Phones: the file list fills the space between the bar and the name field (the one scroll region). */
@media (max-width: 640px), (max-height: 500px) {
  .cd__bar { flex-wrap: nowrap; }
  .cd__list { flex: 1 1 0; min-height: 96px; max-height: none; overscroll-behavior: contain; }
  .cd__row { min-height: 44px; }
  .cd__crumbs > span:not(.flex-1) { flex: none; }
}
.cd__err { font-size: 12px; color: var(--ui-error); }
</style>
