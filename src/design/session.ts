/**
 * The Design tab's document, tied to the project.
 *
 * Source of truth: the project's `Metadata/orca_cad.bin` bytes (`getOrcaCadRecipe()`, the
 * passthrough accessor), which are saved with the project, kept by the autosave and captured in
 * every undo snapshot (history.ts slot "design"). The kernel holds an open document that mirrors
 * them: `kernelBytes` is the byte array it was opened from or last saved to. Whenever the project
 * bytes stop being `kernelBytes` (project load, undo / redo, a kernel reset) `reconcile()` reopens
 * the document from them — the kernel has its own undo, but one byte-level history keeps Ctrl+Z
 * one coherent list across Prepare and Design (see docs/DEVELOPMENT.md "Design tab").
 *
 * Every committed edit (`runEdit`) runs as one kernel job — the edit, `doc_save`, the scene, the
 * display meshes and, for linked plate objects, the plate meshes — then commits on the page in one
 * `mutate()`: new bytes + linked meshes, one undo step. An edit the kernel refuses (geometry
 * failure: the kernel rolled back) changes nothing and is reported on its feature.
 *
 * Nothing loads until `activateDesign()` (the Design tab opened, a commit, a bridge call).
 */
import { markRaw, reactive, shallowRef, watch } from 'vue';
import { getOrcaCadRecipe, projectPassthrough, setOrcaCadRecipe } from '../project/persistence/passthrough';
import { activeView } from '../app/state';
import { preferences } from '../app/preferences';
import { bed, objects, designLinks, mutate, projectLoads, registerSnapshotSlot, relinkDesignObjects, type DesignBodyMesh, type DesignRelink } from '../project/store';
import type { Vec3 } from '../project/math';
import { CadKernel, KernelError, KernelReset, WorkerBackend, type JobContext, type KernelBackend, type ResetReason } from './kernel/client';
import { decodeDisplayMeshes, decodePlateMeshes, type DisplayBody } from './kernel/mesh';
import {
  CAD_ERR, type DescribeScene, type DescribeTools, type DisplayMeshLayout, type DocOpenResult, type DocSaveResult, type MutationResult,
  type PlateMeshLayout, type SceneBody, type SceneFeature,
} from './kernel/types';
import { findFirstFailure } from './diagnose';
import { remapLink, resolveLink, type HistoryEdit } from './link';
import { clearDesignSelection, designUi } from './state';

// ---- kernel ------------------------------------------------------------------------

let makeBackend: () => KernelBackend = () => new WorkerBackend();
let kernel: CadKernel | null = null;

/** The kernel instance (created on first use; the module itself loads on the first job). */
export function designKernel(): CadKernel {
  if (!kernel) {
    kernel = new CadKernel(() => makeBackend());
    kernel.onReset(onKernelReset);
  }
  return kernel;
}

/** Tests: run the session on another backend (e.g. FakeKernel). Drops the current instance. */
export function setDesignBackend(factory: () => KernelBackend): void {
  kernel?.dispose();
  kernel = null;
  makeBackend = factory;
  resetSessionState();
  design.active = false;
}

// ---- state -------------------------------------------------------------------------

/**
 * - `idle`: nothing loaded (the tab was never opened);
 * - `opening`: the document is being opened / rebuilt;
 * - `open`: a document is open (possibly with no features: a new design);
 * - `unreadable`: the project's design could not be read (kept as opaque bytes);
 * - `closed`: opening was cancelled; `reopenDesign()` tries again;
 * - `failed`: the kernel could not start or keeps crashing.
 */
export type DesignPhase = 'idle' | 'opening' | 'open' | 'unreadable' | 'closed' | 'failed';
export type StatusKind = 'info' | 'ok' | 'warn' | 'error';

export const design = reactive({
  /** The kernel is wanted (Design tab opened, a design commit, a bridge call). */
  active: false,
  phase: 'idle' as DesignPhase,
  /** Why the phase is unreadable / failed / closed. */
  phaseMessage: '',
  version: 0,
  readOnly: false,
  readOnlyReason: '',
  /** The last rebuild succeeded (a document that doesn't rebuild has no bodies). */
  ok: true,
  error: '',
  generation: 0,
  features: [] as SceneFeature[],
  bodies: [] as SceneBody[],
  variables: {} as Record<string, string>,
  /** Evaluated variable values / errors (kernel v1.1; empty with an older kernel). */
  variableValues: {} as Record<string, number>,
  variableErrors: {} as Record<string, string>,
  modelingOrigin: [0, 0, 0] as Vec3,
  mateConflicts: [] as Array<{ feature: number; reason: string }>,
  /** Kernel time of the last full replay (open / edit), ms. */
  lastRebuildMs: 0,
  /** The first feature the rebuild fails at (found by diagnose.ts), or null. */
  failing: null as null | { index: number; error: string },
  diagnosing: false,
  /** The last refused edit per feature index (cleared by the next successful edit of it). */
  featureErrors: {} as Record<number, string>,
  /** The status line over the viewport (Orca's set_status). */
  status: null as null | { kind: StatusKind; text: string },
  /** describe_tools: the field schema (types, enums, bindable fields). */
  tools: null as DescribeTools | null,
});

/** Display meshes per body index (get_mesh), replaced on every rebuild. */
export const displayBodies = shallowRef<readonly DisplayBody[]>([]);

/** The bytes the open kernel document mirrors (identity); undefined = no document. */
let kernelBytes: Uint8Array | null | undefined;
/** The bytes an open job queued for, so the watcher doesn't queue twice. */
let pendingOpen: Uint8Array | null | undefined;
let docHandle: number | null = null;
let runningKind: 'open' | 'edit' | 'diagnose' | 'read' | null = null;
let crashStreak = 0;

export function setStatus(kind: StatusKind, text: string): void { design.status = { kind, text }; }

function resetSessionState(): void {
  kernelBytes = undefined; pendingOpen = undefined; docHandle = null; runningKind = null; crashStreak = 0;
  Object.assign(design, {
    phase: 'idle', phaseMessage: '', version: 0, readOnly: false, readOnlyReason: '', ok: true, error: '', generation: 0,
    features: [], bodies: [], variables: {}, variableValues: {}, variableErrors: {}, modelingOrigin: [0, 0, 0], mateConflicts: [], lastRebuildMs: 0, failing: null,
    diagnosing: false, featureErrors: {}, status: null, tools: null,
  });
  displayBodies.value = [];
}

/** Does the project carry a design (even one we can't read)? */
export function projectHasDesign(): boolean { return !!getOrcaCadRecipe(); }

/** The kernel's open document handle (for commands and the bridge). */
export function currentDoc(): number | null { return docHandle; }

/** Bed centre: Orca's modeling origin for new designs. */
function bedCentre(): Vec3 {
  const b = bed.value;
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
}

// ---- lifecycle -----------------------------------------------------------------------

/** Want the kernel: open the project's design (or a new empty one). Idempotent. */
export function activateDesign(): void {
  design.active = true;
  reconcile();
}

/** Open the document again after a cancelled open or a failure. */
export function reopenDesign(): void {
  kernelBytes = undefined; pendingOpen = undefined;
  activateDesign();
}

/** Make the kernel document match the project's bytes (queued; no-op when it already does). */
export function reconcile(): void {
  if (!design.active) return;
  const bytes = getOrcaCadRecipe();
  if (bytes === kernelBytes && docHandle !== null) return;
  if (pendingOpen !== undefined && bytes === pendingOpen) return;
  if (design.phase === 'unreadable' && bytes === kernelBytes) return;
  pendingOpen = bytes;
  void openJob(bytes);
}

function applyScene(s: DescribeScene): void {
  design.features = s.features;
  design.bodies = s.bodies;
  design.variables = { ...s.variables };
  design.modelingOrigin = [...s.modeling_origin] as Vec3;
  design.mateConflicts = s.mate_conflicts ?? [];
  design.variableValues = { ...(s.variable_values ?? {}) };
  design.variableErrors = { ...(s.variable_errors ?? {}) };
  design.generation = s.generation;
  // v1.1: rebuild_ok is the state; `error` can be a rolled-back edit's message.
  design.ok = s.rebuild_ok ?? !s.error;
  design.error = design.ok ? '' : s.error ?? '';
  design.readOnly = s.read_only;
  if (design.ok) design.failing = null;
  else if (typeof s.failed_feature === 'number' && s.failed_feature >= 0 && s.failed_feature < s.features.length) design.failing = { index: s.failed_feature, error: s.error || 'the rebuild fails here' };
  // Picks name ids of one generation; feature indices beyond the list are gone.
  designUi.pick = null;
  designUi.selected = designUi.selected.filter((i) => i < s.features.length);
  designUi.hiddenBodies = designUi.hiddenBodies.filter((i) => i < s.bodies.length);
}

async function readScene(c: JobContext, doc: number): Promise<{ scene: DescribeScene; meshes: DisplayBody[] }> {
  const { result: scene } = await c.call<DescribeScene>('describe_scene', { doc });
  const m = await c.call<{ meshes: DisplayMeshLayout[] }>('get_mesh', { doc });
  return { scene, meshes: decodeDisplayMeshes(m.result.meshes, m.blob) };
}

function openJob(bytes: Uint8Array | null): Promise<void> {
  const k = designKernel();
  design.phase = 'opening';
  return k.run(bytes ? 'Opening the design' : 'Starting the Design tab', async (c) => {
    runningKind = 'open';
    if (!design.tools) design.tools = markRaw((await c.call<DescribeTools>('describe_tools')).result);
    if (docHandle !== null) { const d = docHandle; docHandle = null; await c.call('doc_close', { doc: d }).catch(() => {}); }
    let open: DocOpenResult | null = null;
    if (bytes) {
      try {
        open = (await c.call<DocOpenResult>('doc_open', { modeling_origin: bedCentre() }, bytes)).result;
      } catch (e) {
        if (e instanceof KernelError && (e.code === CAD_ERR.unreadable || e.code === CAD_ERR.notRecipe || e.code === CAD_ERR.invalidParams)) return { unreadable: e.message };
        throw e;
      }
      docHandle = open.doc;
    } else {
      docHandle = (await c.call<{ doc: number }>('doc_new', { modeling_origin: bedCentre() })).result.doc;
    }
    const read = await readScene(c, docHandle);
    return { open, ...read };
  }, { cancellable: true }).then((r) => {
    if (pendingOpen === bytes) pendingOpen = undefined;
    crashStreak = 0;
    if ('unreadable' in r) {
      kernelBytes = bytes;
      design.phase = 'unreadable';
      design.phaseMessage = r.unreadable ?? '';
      design.features = []; design.bodies = []; displayBodies.value = [];
      return;
    }
    kernelBytes = bytes;
    if (r.open?.cancelled) {
      // A clean cancel (kernel progress): the document is open without bodies; reopen replays it.
      design.phase = 'closed';
      design.phaseMessage = 'Opening the design was cancelled.';
      design.features = []; design.bodies = []; displayBodies.value = [];
      kernelBytes = undefined;
      return;
    }
    design.phase = 'open';
    design.phaseMessage = '';
    design.version = r.open?.version ?? 6;
    design.readOnlyReason = r.open?.read_only_reason ?? '';
    design.lastRebuildMs = r.open?.ms ?? 0;
    design.featureErrors = {};
    applyScene(r.scene);
    displayBodies.value = markRaw(r.meshes);
    if (r.open && !r.open.ok) {
      setStatus('error', `This design doesn't rebuild: ${r.open.error}`);
      if (design.failing) setStatus('error', `“${design.features[design.failing.index]?.name ?? r.open.failed_feature_name}” fails: ${design.failing.error}. Suppress it (or edit it) to rebuild the design.`);
      else if (r.open.failed_feature === undefined) scheduleDiagnose(); // kernel v1.0: search for it
    } else if (design.readOnly) setStatus('warn', `Read-only: ${design.readOnlyReason || 'saved with a newer version of the Design tab'}.`);
    else design.status = null;
    // The project moved on while this opened (undo, another load): open that instead.
    reconcile();
  }, (e: unknown) => {
    if (pendingOpen === bytes) pendingOpen = undefined;
    if (e instanceof KernelReset) return; // onKernelReset decides
    design.phase = 'failed';
    design.phaseMessage = e instanceof Error ? e.message : String(e);
  }).finally(() => { runningKind = null; });
}

function onKernelReset(reason: ResetReason): void {
  const wasOpening = runningKind === 'open';
  docHandle = null;
  kernelBytes = undefined;
  pendingOpen = undefined;
  runningKind = null;
  design.tools = null;
  design.diagnosing = false;
  if (reason === 'crash') crashStreak++;
  if (reason === 'cancel' && wasOpening) {
    design.phase = 'closed';
    design.phaseMessage = 'Opening the design was cancelled.';
    return;
  }
  if (crashStreak >= 2) {
    design.phase = 'failed';
    design.phaseMessage = 'The CAD kernel crashed twice while opening this design.';
    return;
  }
  if (reason === 'cancel') setStatus('info', 'Cancelled. The design is back to its last saved state.');
  else if (reason === 'crash') setStatus('warn', 'The CAD kernel crashed and was restarted from the last saved design.');
  reconcile();
}

// Project bytes changed (load, undo / redo, autosave restore): follow them.
watch(() => projectPassthrough.value, () => reconcile());
// A whole new project: drop the selection, the per-feature errors and the status. A project
// that is only a design (no meshes on any plate) opens straight to the Design tab.
watch(projectLoads, () => {
  // The opener sets the design bytes right after the objects: look once it has.
  const toDesign = () => { if (preferences.designTab && projectHasDesign() && !objects.value.length && activeView.value === 'prepare') activeView.value = 'design'; };
  toDesign();
  setTimeout(toDesign, 0);
  clearDesignSelection();
  designUi.hiddenBodies = [];
  design.featureErrors = {};
  design.failing = null;
  design.status = null;
});

// Undo / redo restore the document bytes with the objects (one history for Prepare and Design).
registerSnapshotSlot<Uint8Array | null>('design', {
  capture: () => getOrcaCadRecipe(),
  restore: (v) => { if (getOrcaCadRecipe() !== v) setOrcaCadRecipe(v); },
});

// ---- diagnosis (which feature fails) ----------------------------------------------------

let diagnoseQueued = false;
function scheduleDiagnose(): void {
  const bytes = kernelBytes;
  if (!bytes || diagnoseQueued || design.ok) return;
  diagnoseQueued = true;
  let yielded = false;
  const features = design.features.slice();
  design.diagnosing = true;
  void designKernel().run('Finding the failing feature', async (c) => {
    runningKind = 'diagnose';
    return findFirstFailure(c, bytes, features);
  }, { cancellable: false, quiet: true }).then((f) => {
    if (f === 'yielded') { yielded = true; return; }
    if (kernelBytes !== bytes || design.ok) return;
    if (f) {
      design.failing = f;
      const name = design.features[f.index]?.name ?? `feature ${f.index + 1}`;
      setStatus('error', `“${name}” fails: ${f.error}. Suppress it (or edit it) to rebuild the design.`);
    }
  }, () => {}).finally(() => {
    diagnoseQueued = false;
    design.diagnosing = false;
    runningKind = null;
    // Pre-empted by an edit: go again after it (the edit may have fixed it, or scheduled its own).
    if (yielded && kernelBytes === bytes && !design.ok && !design.failing) scheduleDiagnose();
  });
}

// ---- edits -----------------------------------------------------------------------------

export class DesignEditError extends Error { constructor(m: string) { super(m); this.name = 'DesignEditError'; } }

export interface EditOptions {
  /** The feature the edit is about: a refusal is shown on it. */
  feature?: number;
  /** The edit can change geometry (rebuild + meshes). False for renames. */
  geometry?: boolean;
  /** A history edit, for remapping links and the selection (from the result). */
  history?: (r: MutationResult) => HistoryEdit | null;
  /** Status line text on success. */
  done?: string | ((r: MutationResult) => string);
  /** The sketch session's own commit (passes the open-sketch guard). */
  sketch?: boolean;
}

export interface EditOutcome { ok: boolean; error: string; result: MutationResult | null }

let sketchGuard: (() => string | null) | null = null;
/** The sketch session blocks other design edits while it is open (sketch/session.ts). */
export function setSketchGuard(fn: (() => string | null) | null): void { sketchGuard = fn; }

/** Refuse edits the document can't take (read-only, not open, a sketch open). */
export function editBlocker(o: { sketch?: boolean } = {}): string | null {
  if (design.phase !== 'open') return design.phase === 'opening' ? 'The design is still opening.' : 'No design is open.';
  if (design.readOnly) return `This design is read-only (${design.readOnlyReason || 'saved with a newer version of the Design tab'}).`;
  if (!o.sketch) { const g = sketchGuard?.(); if (g) return g; }
  return null;
}

/**
 * Run one committed edit: `op` makes the kernel call(s) on the open document; on success the
 * new bytes, the scene, display meshes and linked plate meshes are committed as one undo step.
 */
export function runEdit(label: string, op: (c: JobContext, doc: number) => Promise<MutationResult>, o: EditOptions = {}): Promise<EditOutcome> {
  const blocked = editBlocker({ sketch: o.sketch });
  if (blocked) return Promise.reject(new DesignEditError(blocked));
  const geometry = o.geometry ?? true;
  const k = designKernel();
  let base: Uint8Array | null | undefined;
  return k.run(label, async (c) => {
    runningKind = 'edit';
    base = getOrcaCadRecipe();
    if (docHandle === null || kernelBytes !== base) throw new DesignEditError('The design changed while this edit was waiting. Try again.');
    const doc = docHandle;
    const t0 = performance.now();
    const r = await op(c, doc);
    const ms = performance.now() - t0;
    if (r.cancelled || (!r.ok && !r.kept)) return { r, ms, changed: null };
    const save = await c.call<DocSaveResult>('doc_save', { doc });
    const bytes = save.blob ?? new Uint8Array(0);
    const read = geometry ? await readScene(c, doc) : { scene: (await c.call<DescribeScene>('describe_scene', { doc })).result, meshes: null };
    // Linked plate objects follow: resolve their links against the new body list.
    const edit = o.history?.(r) ?? null;
    const links = designLinks().map((x) => x.link);
    const plate = new Map<number, DesignBodyMesh>();
    if (geometry && links.length && read.scene.bodies.length) {
      const want = new Set<number>();
      for (const l of links) {
        const m = edit ? remapLink(l, edit) : l;
        const b = m ? resolveLink(m, read.scene.bodies) : -1;
        if (b >= 0 && read.scene.bodies[b].face_count > 0) want.add(b);
      }
      if (want.size) {
        const ex = await c.call<{ meshes: PlateMeshLayout[] }>('export_mesh', { doc, bodies: [...want] });
        for (const pm of decodePlateMeshes(ex.result.meshes, ex.blob)) if (pm.indices.length) plate.set(pm.body, pm);
      }
    }
    return { r, ms, changed: { bytes, read, edit, plate } };
  }, { cancellable: geometry }).then(({ r, ms, changed }) => {
    if (r.cancelled) {
      setStatus('info', `Cancelled “${label}” — the design is as it was.`);
      return { ok: false, error: 'cancelled', result: r };
    }
    if (o.feature !== undefined) {
      const fe = { ...design.featureErrors };
      if (r.ok) delete fe[o.feature]; else fe[o.feature] = r.error || 'The edit was refused.';
      design.featureErrors = fe;
    }
    if (geometry && (r.ok || r.kept)) design.lastRebuildMs = ms;
    if (!changed) {
      setStatus('error', `Edit refused: ${r.error || 'the design would not rebuild'}. Nothing changed.`);
      return { ok: false, error: r.error ?? '', result: r };
    }
    if (getOrcaCadRecipe() !== base) {
      // Undo / a project load happened while the kernel worked: the kernel now holds an edit of a
      // state the project left. Drop it and reopen what the project has.
      kernelBytes = changed.bytes;
      reconcile();
      setStatus('warn', `“${label}” was discarded: the design changed while it was rebuilding.`);
      return { ok: false, error: 'superseded', result: r };
    }
    const { bytes, read, edit, plate } = changed;
    kernelBytes = bytes;
    let meshesChanged = 0;
    mutate(label, () => {
      setOrcaCadRecipe(bytes);
      meshesChanged = relinkDesignObjects((link): DesignRelink => {
        const m = edit ? remapLink(link, edit) : link;
        if (!m) return { link: null };
        const b = resolveLink(m, read.scene.bodies);
        const mesh = b >= 0 ? plate.get(b) : undefined;
        if (!mesh) return m === link ? undefined : { link: m };
        return { link: m.body === b ? m : Object.freeze({ ...m, body: b }), mesh };
      });
    }, { slice: meshesChanged > 0 || plate.size > 0 });
    if (edit) remapSelection(edit);
    applyScene(read.scene);
    if (read.meshes) displayBodies.value = markRaw(read.meshes);
    if (!design.ok) {
      setStatus('error', `${label}: the design still doesn't rebuild (${design.error}).`);
      if (read.scene.failed_feature === undefined) { design.failing = null; scheduleDiagnose(); } // kernel v1.0: search for it
    } else {
      const d = typeof o.done === 'function' ? o.done(r) : o.done;
      setStatus('ok', `${d ?? label}${meshesChanged ? ` — ${meshesChanged} plate object${meshesChanged > 1 ? 's' : ''} updated` : ''}.`);
    }
    return { ok: r.ok, error: r.error ?? '', result: r };
  }).finally(() => { runningKind = null; });
}

function remapSelection(edit: HistoryEdit): void {
  const map = (i: number) => {
    if (edit.kind === 'delete') return edit.removed.includes(i) ? -1 : i - edit.removed.filter((r) => r < i).length;
    if (i === edit.from) return edit.to;
    if (edit.from < edit.to && i > edit.from && i <= edit.to) return i - 1;
    if (edit.to < edit.from && i >= edit.to && i < edit.from) return i + 1;
    return i;
  };
  designUi.selected = designUi.selected.map(map).filter((i) => i >= 0);
  const fe: Record<number, string> = {};
  for (const [k, v] of Object.entries(design.featureErrors)) { const j = map(Number(k)); if (j >= 0) fe[j] = v; }
  design.featureErrors = fe;
}

/** A read-only kernel job on the open document (quiet unless `label`). */
export function readDesign<T>(fn: (c: JobContext, doc: number) => Promise<T>, label?: string): Promise<T> {
  return designKernel().run(label ?? 'Reading the design', async (c) => {
    if (docHandle === null) throw new DesignEditError('No design is open.');
    return fn(c, docHandle);
  }, { quiet: !label });
}

/** Resolves once the open / reconcile queued so far has run (bridge tools, tests). */
export async function designReady(): Promise<void> {
  activateDesign();
  // Two passes: an open that ends by reconciling may queue one more.
  for (let i = 0; i < 3; i++) {
    await designKernel().run('Waiting for the design', async () => {}, { quiet: true }).catch(() => {});
    if (design.phase !== 'opening' && pendingOpen === undefined) break;
  }
  // A failing design is diagnosed right after it opens: wait for that too (it queues before this).
  if (design.diagnosing) await designKernel().run('Waiting for the diagnosis', async () => {}, { quiet: true }).catch(() => {});
}
