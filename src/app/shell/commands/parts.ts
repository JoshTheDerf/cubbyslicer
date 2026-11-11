/** Instances, split, and adding parts / modifiers (generic shapes or model files) to an object. */
import { toast } from '../../../ui';
import { MODEL_ACCEPT, parseModelFile } from '../../../project/import';
import { addPart, getMesh, objects, removeInstance, selectedIds, splitToObjects, splitToParts } from '../../../project/store';
import { reactive, watch } from 'vue';
import { PRIMITIVE_LABELS, primitiveFor, primitiveOfSize, type PrimitiveKind } from '../../../project/primitives';
import { dialogRequest } from '../../../ui/dialogRequest';
import { readJson, writeJson } from '../../../lib/storage';
import { preferences } from '../../preferences';
import { PART_TYPE_LABELS, PRECISE_SEAM_LABELS, type PartType, type PreciseSeamType } from '../../../project/types';
import { pickFiles } from '../download';
import { withBusy } from '../uiState';
import { revealObjectSettings } from './edit';

export function removeInstanceSel(): void { if (selectedIds.value.length) removeInstance(); }

export function splitSelectionToParts(): void {
  if (!selectedIds.value.length) return;
  const n = splitToParts();
  if (!n) toast.info('Nothing to split: the selection is a single connected piece.');
  else toast.success(`Split into ${n + 1} parts.`, { timeout: 2200 });
}

/**
 * Orca "Add part / negative part / modifier / support blocker / enforcer":
 * a generic shape sized from the object, or a model file, placed at the
 * object's centre (in its local frame).
 */
/** What the add-part menus add: a part type, or an Orca 2.5 precise seam (a seam modifier, Seam: center first). */
export type SubObjectType = PartType | 'precise_seam';

export async function addSubObject(sub: SubObjectType, source: PrimitiveKind | 'file'): Promise<void> {
  const type: PartType = sub === 'precise_seam' ? 'modifier' : sub;
  const seamType: PreciseSeamType | undefined = sub === 'precise_seam' ? 'precise_seam_center' : undefined;
  const id = selectedIds.value.length === 1 ? selectedIds.value[0] : null;
  if (!id || !objects.value.some((x) => x.id === id)) { toast.info('Select one object first.'); return; }
  if (source !== 'file') {
    const c = meshCentre(id);
    if (!c) return;
    const suggested = primitiveOptions.sizes[source] ?? suggestedPrimitiveSize(source, c.size);
    const size = preferences.askPrimitiveSize ? await primitiveSizeDialog.ask({ kind: source, type, size: suggested }) : suggested;
    if (!size) return;
    addPrimitivePart(id, type, source, { size, seamType });
    if (type === 'modifier' && !seamType) revealObjectSettings();
    return;
  }
  const [f] = await pickFiles(MODEL_ACCEPT, false);
  if (!f) return;
  try {
    const pid = await withBusy(`Loading ${f.name}…`, async () => addModelPart(id, type, f.name, await f.arrayBuffer(), { seamType }));
    if (!pid) { toast.error(`No geometry in ${f.name}.`); return; }
    if (type === 'modifier' && !seamType) revealObjectSettings();
  } catch (e) {
    toast.error(`Couldn’t load ${f.name}.`, { detail: (e as Error)?.message });
  }
}

// ---- primitive size (Orca 2.5 "Choose a primitive's size when adding it") ----------------

type Size3 = [number, number, number];
const PRIM_KEY = 'cubby-slicer:primitive-options';

function loadPrimitiveOptions(): { sizes: Partial<Record<PrimitiveKind, Size3>> } {
  const v = readJson<{ sizes?: Record<string, unknown> }>(PRIM_KEY) ?? {};
  const sizes: Partial<Record<PrimitiveKind, Size3>> = {};
  for (const k of Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]) {
    const s = v.sizes?.[k];
    if (Array.isArray(s) && s.length === 3 && s.every((x) => typeof x === 'number' && x > 0)) sizes[k] = s as Size3;
  }
  return { sizes };
}

/**
 * The sizes saved with "Save these settings as default", per browser. Whether
 * the dialog shows at all is the `askPrimitiveSize` preference (Orca:
 * Preferences > Control > Behavior).
 */
export const primitiveOptions = reactive(loadPrimitiveOptions());
watch(primitiveOptions, (o) => { writeJson(PRIM_KEY, o); }, { deep: true });

export interface PrimitiveSizeRequest { kind: PrimitiveKind; type: PartType; size: Size3 }
/** The size dialog (ShellDialogs.vue): answers the bounding box in mm, or null (cancelled). */
export const primitiveSizeDialog = dialogRequest<PrimitiveSizeRequest, Size3 | null>(null);

/** The size the menu used before 2.5: a cube / cylinder / sphere half the object's smallest side; a slab under the whole object. */
export function suggestedPrimitiveSize(kind: PrimitiveKind, objectSize: Size3): Size3 {
  const m = primitiveFor(kind, objectSize).positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m[i + k]); hi[k] = Math.max(hi[k], m[i + k]); }
  return [0, 1, 2].map((k) => Math.round((hi[k] - lo[k]) * 100) / 100) as Size3;
}

/** Centre of an object's own mesh bbox (object-local frame). */
function meshCentre(objectId: string): { center: [number, number, number]; size: [number, number, number]; min: [number, number, number] } | null {
  const o = objects.value.find((x) => x.id === objectId);
  const mesh = o ? getMesh(o.meshId) : undefined;
  if (!mesh) return null;
  const b = mesh.bbox;
  return {
    center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    min: [b.min[0], b.min[1], b.min[2]],
  };
}

/**
 * Add a generic shape to an object (Orca load_generic_subobject). Without
 * `size` it is sized from the object like the menu does; without `at` it sits
 * in the object's middle (a slab on its bottom). `at` / `size` are mm in the
 * object's local frame. Returns the part id.
 */
export function addPrimitivePart(objectId: string, type: PartType, source: PrimitiveKind,
  opts: { size?: [number, number, number]; at?: [number, number, number]; name?: string; seamType?: PreciseSeamType } = {}): string | null {
  const c = meshCentre(objectId);
  if (!c) return null;
  const shape = opts.size ? primitiveOfSize(source, opts.size) : primitiveFor(source, c.size);
  // A slab sits on the bottom of the object (a layer-range modifier); the rest in its middle.
  const slabH = opts.size ? opts.size[2] : Math.max(0.5, Math.min(5, c.size[2] * 0.1));
  const at = opts.at ?? (source === 'slab' ? [c.center[0], c.center[1], c.min[2] + slabH / 2] as [number, number, number] : c.center);
  const label = opts.seamType ? PRECISE_SEAM_LABELS[opts.seamType] : PART_TYPE_LABELS[type];
  return addPart(objectId, type, opts.name ?? `${label} ${PRIMITIVE_LABELS[source].toLowerCase()}`, shape.positions, shape.indices, at, opts.seamType);
}

/** Add a model file's geometry (every mesh in it merged, centred on its own bbox) as a part. Returns the part id, null when the file has no geometry. */
export async function addModelPart(objectId: string, type: PartType, fileName: string, buffer: ArrayBuffer,
  opts: { at?: [number, number, number]; name?: string; seamType?: PreciseSeamType } = {}): Promise<string | null> {
  const c = meshCentre(objectId);
  if (!c) return null;
  const res = await parseModelFile(fileName, buffer);
  if (!res.objects.length) return null;
  let nv = 0, nt = 0;
  for (const p of res.objects) { nv += p.positions.length; nt += p.indices.length; }
  const pos = new Float32Array(nv), idx = new Uint32Array(nt);
  let vo = 0, io = 0;
  for (const p of res.objects) {
    pos.set(p.positions, vo);
    for (let i = 0; i < p.indices.length; i++) idx[io + i] = p.indices[i] + vo / 3;
    vo += p.positions.length; io += p.indices.length;
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  const m = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= m[0]; pos[i + 1] -= m[1]; pos[i + 2] -= m[2]; }
  return addPart(objectId, type, opts.name ?? fileName.replace(/\.[a-z0-9]+$/i, ''), pos, idx, opts.at ?? c.center, opts.seamType);
}

export function splitSelectionToObjects(): void {
  if (!selectedIds.value.length) return;
  const n = splitToObjects();
  if (!n) toast.info('Nothing to split: the selection is a single connected piece.');
  else toast.success(`Split into ${n} objects.`, { timeout: 2200 });
}
