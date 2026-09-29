/**
 * Shared behaviour of the text and SVG tools (Orca GLGizmoEmboss /
 * GLGizmoSVG): pick what to edit (an existing emboss volume) or create a new
 * one — as a part, negative part or modifier placed on a clicked surface, or
 * as a new object on the plate — then rebuild the mesh live as parameters
 * change (one undo step per burst of edits).
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';
import { Plane, Vector3 } from 'three';
import {
  addToolObject, addToolPart, getObject, objects, replaceVolumeMesh, select, selectedIds, selectedPart, setPartTransform, setTransforms,
} from '../project/store';
import type { EmbossMeta, PartType } from '../project/types';
import type { ToolPointerEvent } from '../viewport/scene';
import { toast } from '../ui';
import type { MeshArrays } from './geom/extrude';
import { COLORS, ToolOverlay, polyline, render } from './overlay';
import { meshSizeXY, partPlacement, previewRect } from './placement';
import { installHandler, toolScene, toolState } from './state';

export type EmbossPlace = PartType | 'object';

const stableKey = (o: object) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
export interface EmbossTarget { objectId: string; partId: string | null }

export const PLACE_OPTIONS: Array<{ value: EmbossPlace; label: string }> = [
  { value: 'part', label: 'Part (emboss)' },
  { value: 'negative', label: 'Negative part (engrave)' },
  { value: 'modifier', label: 'Modifier' },
  { value: 'object', label: 'New object' },
];

/** The emboss source of a volume, if it is of `kind`. */
export function embossOf(t: EmbossTarget, kind: EmbossMeta['kind']): EmbossMeta | null {
  const o = getObject(t.objectId);
  if (!o) return null;
  const e = t.partId ? o.parts?.find((p) => p.id === t.partId)?.emboss : o.emboss;
  return e?.kind === kind ? e : null;
}

/** An emboss volume of `kind` the user has selected (object list part pick, or a selected emboss object). */
export function selectedEmbossTarget(kind: EmbossMeta['kind']): EmbossTarget | null {
  const req = toolState.request;
  if (req?.objectId) {
    const t = { objectId: req.objectId, partId: req.partId ?? null };
    if (embossOf(t, kind)) return t;
  }
  const sp = selectedPart.value;
  if (sp && embossOf({ objectId: sp.objectId, partId: sp.partId }, kind)) return { objectId: sp.objectId, partId: sp.partId };
  if (selectedIds.value.length === 1) {
    const t = { objectId: selectedIds.value[0], partId: null };
    if (embossOf(t, kind)) return t;
  }
  return null;
}

export function useEmbossEditor<T extends EmbossMeta>(opts: {
  kind: T['kind'];
  params: Ref<T>;
  build: (p: T) => Promise<MeshArrays | null> | MeshArrays | null;
  name: (p: T) => string;
  /** Label for undo entries, e.g. "text". */
  noun: string;
  /** Whether params are ready to build (e.g. an SVG was loaded). */
  ready?: () => boolean;
}) {
  const target = ref<EmbossTarget | null>(null);
  const place = ref<EmbossPlace>('part');
  const busy = ref(false);
  const error = ref<string | null>(null);
  const previewSize = shallowRef<[number, number]>([0, 0]);
  const hover = shallowRef<{ point: Vector3; normal: Vector3 } | null>(null);
  const overlay = new ToolOverlay(`emboss-${opts.kind}`);
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applying = false;

  function hostObject(): string | null {
    return selectedIds.value.length === 1 ? selectedIds.value[0] : null;
  }

  function resolveTarget(): void {
    const t = selectedEmbossTarget(opts.kind);
    target.value = t;
    if (t) {
      const e = embossOf(t, opts.kind) as T;
      applying = true;
      opts.params.value = { ...e };
      queueMicrotask(() => { applying = false; });
    } else {
      place.value = toolState.request?.newObject || !hostObject() ? 'object' : 'part';
    }
  }

  async function buildMesh(): Promise<MeshArrays | null> {
    if (opts.ready && !opts.ready()) return null;
    try {
      const m = await opts.build({ ...opts.params.value });
      error.value = m ? null : 'Nothing to emboss.';
      return m;
    } catch (e) {
      error.value = (e as Error)?.message ?? String(e);
      return null;
    }
  }

  /** Rebuild after a parameter change (debounced). */
  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const my = ++token;
      busy.value = true;
      const m = await buildMesh();
      busy.value = false;
      if (my !== token || !m) return;
      previewSize.value = meshSizeXY(m.positions);
      const t = target.value;
      const cur = t ? embossOf(t, opts.kind) : null;
      if (t && cur && stableKey(cur) !== stableKey(opts.params.value)) {
        replaceVolumeMesh(t.objectId, t.partId, m, {
          label: `Edit ${opts.noun}`, emboss: { ...opts.params.value }, mergeKey: `emboss:${t.objectId}:${t.partId ?? ''}`, name: opts.name(opts.params.value),
        });
      }
      drawHover();
    }, 180);
  }

  async function createAt(e: { objectId: string; point: Vector3; normal: Vector3 } | { bedPoint: Vector3 } | null): Promise<void> {
    const m = await buildMesh();
    if (!m) { if (error.value) toast.warn(error.value); return; }
    const p = { ...opts.params.value };
    const name = opts.name(p);
    if (place.value === 'object' || !e || 'bedPoint' in e) {
      const pos = e && 'bedPoint' in e ? [e.bedPoint.x, e.bedPoint.y, 0] as [number, number, number] : undefined;
      const id = addToolObject(name, m, { emboss: p, position: pos, label: `Add ${opts.noun}` });
      target.value = { objectId: id, partId: null };
      return;
    }
    const type = place.value as PartType;
    const pl = partPlacement(e.objectId, e.point, e.normal, type, 'depth' in p ? p.depth : 1);
    if (!pl) return;
    const pid = addToolPart(e.objectId, type, name, m, pl, p);
    if (pid) {
      target.value = { objectId: e.objectId, partId: pid };
      select([e.objectId]);
      selectedPart.value = { objectId: e.objectId, partId: pid };
    }
  }

  /** Orca-style fallback placement: the top of the selected object's bounding box. */
  async function placeOnSelected(): Promise<void> {
    const id = hostObject();
    const o = id ? getObject(id) : null;
    const s = toolScene.value;
    if (!o || !s) { await createAt(null); return; }
    // Ray straight down onto the object's top from above its centre.
    const box = (await import('../project/store')).objectInfo.value.get(o.id);
    if (!box) return;
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
    await createAt({ objectId: o.id, point: new Vector3(cx, cy, box.max[2]), normal: new Vector3(0, 0, 1) });
  }

  function moveTo(point: Vector3, normal: Vector3): void {
    const t = target.value;
    if (!t?.partId) return;
    const o = getObject(t.objectId);
    const part = o?.parts?.find((p) => p.id === t.partId);
    if (!part) return;
    const p = opts.params.value;
    const pl = partPlacement(t.objectId, point, normal, part.type, 'depth' in p ? p.depth : 1);
    if (pl) setPartTransform(t.objectId, t.partId, pl, `Move ${opts.noun}`);
  }

  function bedPointOf(e: ToolPointerEvent): Vector3 | null {
    const v = e.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3());
    return v ?? null;
  }

  function onPointer(e: ToolPointerEvent): boolean {
    const editing = !!target.value;
    if (e.kind === 'hover' || e.kind === 'leave') {
      const h = e.kind === 'hover' && e.hit && !(editing && e.hit.objectId !== target.value?.objectId) ? { point: e.hit.point, normal: e.hit.normal } : null;
      // Don't preview on the emboss volume itself.
      hover.value = h && !(editing && e.hit?.partId && e.hit.partId === target.value?.partId) ? h : null;
      drawHover();
      return true;
    }
    if (e.kind !== 'click') return false;
    if (editing) {
      const t = target.value!;
      if (t.partId && e.hit && e.hit.objectId === t.objectId && e.hit.partId !== t.partId) moveTo(e.hit.point, e.hit.normal);
      else if (!t.partId && !e.hit) {
        const bp = bedPointOf(e);
        const o = getObject(t.objectId);
        if (bp && o) setTransforms([{ id: o.id, position: [bp.x, bp.y, o.position[2]] }], `Move ${opts.noun}`);
      }
      return true;
    }
    if (opts.ready && !opts.ready()) return true;
    if (place.value === 'object') { const bp = e.hit ? null : bedPointOf(e); void createAt(bp ? { bedPoint: bp } : null); return true; }
    if (e.hit) void createAt({ objectId: e.hit.objectId, point: e.hit.point, normal: e.hit.normal });
    else toast.info(`Click on an object's surface to place the ${opts.noun}.`, { timeout: 2200 });
    return true;
  }

  function drawHover(): void {
    overlay.attach();
    overlay.clear();
    const h = hover.value;
    const [w, hh] = previewSize.value;
    const creatingPart = !target.value && place.value !== 'object';
    const movingPart = !!target.value?.partId;
    if (h && w > 0 && (creatingPart || movingPart)) overlay.add(polyline(previewRect(h.point, h.normal, w, hh), COLORS.preview, true));
    render();
  }

  function newOne(): void {
    target.value = null;
    selectedPart.value = null;
    place.value = hostObject() ? 'part' : 'object';
    drawHover();
  }

  watch(() => ({ ...opts.params.value }), () => { if (!applying) schedule(); }, { deep: true });
  watch(place, drawHover);
  // The target vanished (undo, delete): back to "create".
  watch(objects, () => { const t = target.value; if (t && !embossOf(t, opts.kind)) target.value = null; }, { deep: true });
  watch(() => toolState.opened, resolveTarget);
  watch(toolScene, () => installHandler({ onPointer, hideGizmo: true, cursor: 'crosshair' }));

  onMounted(() => {
    resolveTarget();
    installHandler({ onPointer, hideGizmo: true, cursor: 'crosshair' });
    schedule();
  });
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    installHandler(null);
    overlay.dispose();
  });

  return { target, place, busy, error, previewSize, placeOnSelected, createAt, newOne, hostObject };
}
