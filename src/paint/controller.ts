/**
 * Painting controller: one engine painting session (Orca TriangleSelector in
 * the worker, see engine cs_tool paint_*) for the painted object's mesh, the
 * 3D tool handler that turns pointer strokes into brush operations, and the
 * painted-facet overlays drawn on the object.
 *
 * Paint is stored per mesh in the project store (meshPaint); each finished
 * stroke is one undo step. Color painting stays visible outside the tool, like
 * Orca's plater; support / seam / fuzzy only while their tool is open.
 */
import { watch } from 'vue';
import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, Vector3,
} from 'three';
import { engineTool } from '../engine/client';
import type { EngineId, PaintLayer, PaintMap, ToolMesh } from '../engine/types';
import { currentPresets } from '../presets/store';
import {
  getMesh, getMeshPaint, getObject, meshPaint, objects, selectedIds, setMeshPaint, setObjectOverride,
} from '../project/store';
import { activeEngine, resolvedConfig } from '../app/state';
import { filamentColourOf, mixedFilaments } from '../mixed/store';
import { closeTool, toolScene } from '../tools/state';
import type { ToolHandler, ToolPointerEvent } from '../viewport/scene';
import { toast } from '../ui';
import { maxStateFor, paintUi, stateFor } from './state';
import { isOrcaFamily } from '../engine/types';

/** Orca TriangleSelectorGUI colours: enforcers blue, blockers red. */
const ENFORCER = 0x7878ff, BLOCKER = 0xff7070, FUZZY = 0xffa040;

interface Session { handle: number; objectId: string; meshId: string; layer: PaintLayer }
let session: Session | null = null;
/** One brush request in flight; drags coalesce into the next one. */
let inFlight: Promise<void> | null = null;
let pending: (() => Promise<void>) | null = null;
let stroke: { button: number; shift: boolean; prev: [number, number, number] | null; changed: boolean } | null = null;
let cursor: Mesh | null = null;

function scene() { return toolScene.value; }

/**
 * Painting runs in an Orca-family engine's TriangleSelector: Full Spectrum's
 * own when it is active (its states go to 255, for mixed filaments), else Orca.
 */
function paintEngine(): EngineId { return activeEngine.value === 'fullspectrum' ? 'fullspectrum' : 'orca'; }
function paintTool<T>(op: string, args: unknown, meshes: ToolMesh[] = []) { return engineTool<T>(op, args, meshes, paintEngine()); }
// A session lives in one engine: switching engines closes it.
watch(activeEngine, () => { if (paintUi.layer) void closePaint(); });

function toolMesh(meshId: string): ToolMesh | null {
  const m = getMesh(meshId);
  return m ? { positions: m.positions, indices: m.indices } : null;
}

function stateColor(layer: PaintLayer, state: number): number {
  if (layer === 'color') {
    const c = filamentColourOf(state); // physical or Full Spectrum mixed filament
    return parseInt((c || '#888888').replace('#', '').slice(0, 6), 16) || 0x888888;
  }
  if (layer === 'fuzzy') return FUZZY;
  return state === 2 ? BLOCKER : ENFORCER;
}

/** Painted facets (engine meshes, one per state) as an overlay group in the object's mesh frame. */
function overlayGroup(layer: PaintLayer, states: number[], meshes: ToolMesh[]): Group {
  const g = new Group();
  g.name = `paint-${layer}`;
  states.forEach((st, i) => {
    const m = meshes[i];
    if (!m) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(m.positions, 3));
    geo.setIndex(new BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    const mat = new MeshStandardMaterial({
      color: stateColor(layer, st), roughness: 0.9, metalness: 0, flatShading: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    g.add(new Mesh(geo, mat));
  });
  return g;
}

function showOverlay(objectId: string, layer: PaintLayer, states: number[], meshes: ToolMesh[]): void {
  scene()?.setObjectOverlay(objectId, `paint-${layer}`, states.length ? overlayGroup(layer, states, meshes) : null);
}

// ---- engine calls ------------------------------------------------------------------

async function apply(args: Record<string, unknown>): Promise<boolean> {
  if (!session) return false;
  const s = session;
  const r = await paintTool<{ states: number[] }>('paint_apply', { handle: s.handle, ...args });
  if (session !== s) return false;
  showOverlay(s.objectId, s.layer, r.result.states, r.meshes);
  // Other instances of the mesh show the same paint.
  for (const o of objects.value) if (o.meshId === s.meshId && o.id !== s.objectId) showOverlay(o.id, s.layer, r.result.states, r.meshes);
  return true;
}

function schedule(job: () => Promise<void>): void {
  if (inFlight) { pending = job; return; }
  inFlight = job().catch((e) => { paintUi.error = (e as Error)?.message ?? String(e); }).finally(() => {
    inFlight = null;
    const next = pending;
    pending = null;
    if (next) schedule(next);
  });
}

async function commitStroke(): Promise<void> {
  if (!session) return;
  const s = session;
  const r = await paintTool<{ paint: PaintMap }>('paint_get', { handle: s.handle });
  if (session !== s) return;
  const labels: Record<PaintLayer, string> = { support: 'Paint supports', seam: 'Paint seam', color: 'Paint color', fuzzy: 'Paint fuzzy skin' };
  setMeshPaint(s.meshId, s.layer, r.result.paint, labels[s.layer]);
  lastPaintRef.set(`${s.meshId}|${s.layer}`, getMeshPaint(s.meshId)[s.layer]);
}

// ---- pointer handling ---------------------------------------------------------------

function brushArgs(e: ToolPointerEvent, state: number): Record<string, unknown> | null {
  const s = session, sc = scene();
  if (!s || !sc || !e.hit || e.hit.objectId !== s.objectId || e.hit.partId) return null;
  const mw = sc.objectMatrixWorld(s.objectId);
  if (!mw) return null;
  const inv = mw.clone().invert();
  const local = e.hit.point.clone().applyMatrix4(inv);
  const cam = sc.camera.position.clone().applyMatrix4(inv);
  const tool = paintUi.tool;
  const args: Record<string, unknown> = {
    kind: tool, facet: e.hit.faceIndex, point: local.toArray(), camera: cam.toArray(), state,
    radius: tool === 'height' ? paintUi.height : paintUi.radius, trafo: mw.elements.slice(),
    angle: paintUi.angle, zWorld: e.hit.point.z,
    overhang: s.layer === 'support' && paintUi.onOverhangsOnly ? paintUi.overhang : 0,
  };
  return args;
}

function placeCursor(e: ToolPointerEvent): void {
  const sc = scene();
  if (!sc) return;
  const onTarget = !!e.hit && e.hit.objectId === session?.objectId && !e.hit.partId;
  const brush = paintUi.tool === 'circle' || paintUi.tool === 'sphere';
  if (!cursor) {
    cursor = new Mesh(new RingGeometry(0.92, 1, 48), new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
    cursor.renderOrder = 10;
    sc.scene.add(cursor);
  }
  cursor.visible = onTarget && brush;
  if (onTarget && brush && e.hit) {
    cursor.position.copy(e.hit.point).addScaledVector(e.hit.normal, 0.05);
    cursor.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), e.hit.normal);
    cursor.scale.setScalar(paintUi.radius);
  }
  sc.requestRender();
}

const handler: ToolHandler = {
  strokes: true,
  hideGizmo: true,
  cursor: 'crosshair',
  onPointer(e) {
    if (!session) return false;
    if (e.kind === 'hover' || e.kind === 'leave') { placeCursor(e); return false; }
    if (e.kind === 'down') {
      placeCursor(e);
      const state = stateFor(session.layer, e.button ?? 0, e.shift);
      const args = brushArgs(e, state);
      if (!args) return false; // not on the painted object: let the camera orbit
      stroke = { button: e.button ?? 0, shift: e.shift, prev: args.point as [number, number, number], changed: true };
      schedule(async () => { await apply(args); });
      return true;
    }
    if (e.kind === 'drag') {
      placeCursor(e);
      if (!stroke) return true;
      const continuous = paintUi.tool === 'circle' || paintUi.tool === 'sphere' || paintUi.tool === 'height' || paintUi.tool === 'pointer';
      if (!continuous) return true;
      const args = brushArgs(e, stateFor(session.layer, stroke.button, stroke.shift));
      if (!args) { stroke.prev = null; return true; }
      if (stroke.prev && (paintUi.tool === 'circle' || paintUi.tool === 'sphere')) args.prev = stroke.prev;
      stroke.prev = args.point as [number, number, number];
      stroke.changed = true;
      schedule(async () => { await apply(args); });
      return true;
    }
    if (e.kind === 'up') {
      const had = stroke?.changed;
      stroke = null;
      if (had) schedule(commitStroke);
      return true;
    }
    return e.kind === 'click' || e.kind === 'context';
  },
};

// Alt + wheel: brush size (Orca).
function onWheel(ev: WheelEvent): void {
  if (!session || !ev.altKey) return;
  ev.preventDefault();
  ev.stopPropagation();
  const f = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
  if (paintUi.tool === 'height') paintUi.height = Math.min(50, Math.max(0.1, +(paintUi.height * f).toFixed(2)));
  else paintUi.radius = Math.min(40, Math.max(0.2, +(paintUi.radius * f).toFixed(2)));
}

// ---- open / close ---------------------------------------------------------------------

/** Remember what each open session last wrote, so the persistent color overlay knows it's current. */
const lastPaintRef = new Map<string, unknown>();

export async function openPaint(layer: PaintLayer): Promise<void> {
  const id = selectedIds.value.length ? selectedIds.value[selectedIds.value.length - 1] : objects.value.length === 1 ? objects.value[0].id : null;
  const o = id ? getObject(id) : undefined;
  if (!o) { toast.info('Select an object to paint.'); return; }
  await closePaint();
  closeTool();
  const mesh = toolMesh(o.meshId);
  if (!mesh) return;
  paintUi.layer = layer;
  paintUi.objectId = o.id;
  paintUi.error = null;
  paintUi.busy = true;
  if (layer === 'color' && paintUi.filament > Math.max(1, currentPresets.value.selection.filaments.length)) paintUi.filament = 1;
  try {
    const r = await paintTool<{ handle: number; states: number[] }>('paint_open', {
      paint: getMeshPaint(o.meshId)[layer] ?? [], maxState: maxStateFor(layer),
    }, [mesh]);
    if (paintUi.layer !== layer || paintUi.objectId !== o.id) { void paintTool('paint_close', { handle: r.result.handle }); return; }
    session = { handle: r.result.handle, objectId: o.id, meshId: o.meshId, layer };
    showOverlay(o.id, layer, r.result.states, r.meshes);
    scene()?.setToolHandler(handler);
    scene()?.renderer.domElement.addEventListener('wheel', onWheel, { capture: true, passive: false });
  } catch (e) {
    paintUi.layer = null;
    paintUi.objectId = null;
    toast.error('Painting isn’t available.', { detail: (e as Error)?.message });
  } finally {
    paintUi.busy = false;
  }
}

export async function closePaint(): Promise<void> {
  const s = session;
  session = null;
  stroke = null;
  pending = null;
  if (inFlight) await inFlight.catch(() => {});
  paintUi.layer = null;
  paintUi.objectId = null;
  const sc = scene();
  sc?.renderer.domElement.removeEventListener('wheel', onWheel, { capture: true });
  if (cursor) { cursor.removeFromParent(); cursor.geometry.dispose(); (cursor.material as MeshBasicMaterial).dispose(); cursor = null; }
  if (s) {
    void paintTool('paint_close', { handle: s.handle }).catch(() => {});
    if (s.layer !== 'color') for (const o of objects.value) if (o.meshId === s.meshId) sc?.setObjectOverlay(o.id, `paint-${s.layer}`, null);
    sc?.setToolHandler(null);
    refreshColorOverlays(true);
    if (s.layer === 'support') suggestEnableSupport(s.meshId);
  }
}

/**
 * Orca: painted enforcers only print when supports are on (the "(manual)"
 * support types use nothing but the enforcers). Offer to turn them on.
 */
function suggestEnableSupport(meshId: string): void {
  if (!getMeshPaint(meshId).support?.length) return;
  const key = isOrcaFamily(activeEngine.value) ? 'enable_support' : 'support_material';
  const on = (v: unknown) => { const x = Array.isArray(v) ? v[0] : v; return x === true || x === 1 || x === '1' || x === 'true'; };
  const owners = objects.value.filter((o) => o.meshId === meshId);
  const off = owners.filter((o) => !on(o.overrides[key] ?? resolvedConfig.value[key]));
  if (!off.length) return;
  toast.warn('Supports are off, so painted enforcers won’t print.', {
    detail: 'Turn supports on for this object to use the painted areas.',
    action: { label: 'Enable supports', run: () => { for (const o of off) setObjectOverride(o.id, key, '1'); } },
    timeout: 8000,
  });
}

export async function togglePaint(layer: PaintLayer): Promise<void> {
  if (paintUi.layer === layer) await closePaint(); else await openPaint(layer);
}

/** "Erase all" for the current layer on the painted object's mesh. */
export async function eraseAllPaint(): Promise<void> {
  if (!session) return;
  const s = session;
  await apply({ kind: 'clear' });
  if (session !== s) return;
  setMeshPaint(s.meshId, s.layer, null, 'Erase painting');
}

// ---- persistent color overlays (outside the color tool) ------------------------------

const colorShown = new Map<string, { ref: unknown; colors: string }>();
let refreshing = false;

/** Keep every object's color painting drawn (re-computed when its paint or the filament colours change). */
function refreshColorOverlays(force = false): void {
  if (refreshing) return;
  refreshing = true;
  void (async () => {
    try {
      const sc = scene();
      if (!sc) return;
      const colors = [...currentPresets.value.selection.filaments.map((_, i) => currentPresets.value.filamentColour(i)), ...mixedFilaments.value.map((m) => m.color)].join(',');
      const byMesh = new Map<string, string[]>();
      for (const o of objects.value) { const l = byMesh.get(o.meshId); if (l) l.push(o.id); else byMesh.set(o.meshId, [o.id]); }
      for (const [meshId, ids] of byMesh) {
        if (session?.layer === 'color' && session.meshId === meshId) continue; // the open session draws it
        const map = getMeshPaint(meshId).color;
        const key = meshId;
        const prev = colorShown.get(key);
        if (!map?.length) {
          if (prev) { for (const id of ids) sc.setObjectOverlay(id, 'paint-color', null); colorShown.delete(key); }
          continue;
        }
        if (!force && prev && prev.ref === map && prev.colors === colors) continue;
        const mesh = toolMesh(meshId);
        if (!mesh) continue;
        const r = await paintTool<{ handle: number; states: number[] }>('paint_open', { paint: map, maxState: maxStateFor('color') }, [mesh]);
        void paintTool('paint_close', { handle: r.result.handle }).catch(() => {});
        for (const id of ids) showOverlay(id, 'color', r.result.states, r.meshes);
        colorShown.set(key, { ref: map, colors });
      }
    } catch { /* engine unavailable: no overlays */ } finally {
      refreshing = false;
    }
  })();
}

let installed = false;
/** Start watching the project for color paint (call once from the viewport). */
export function installPaintOverlays(): void {
  if (installed) return;
  installed = true;
  watch([meshPaint, () => objects.value.map((o) => `${o.id}:${o.meshId}`).join(), () => currentPresets.value.selection.filaments.map((_, i) => currentPresets.value.filamentColour(i)).join(), mixedFilaments, toolScene],
    () => refreshColorOverlays(), { immediate: true });
  // The painted object went away (deleted / undone): end the session.
  watch(objects, () => { if (session && !getObject(session.objectId)) void closePaint(); });
}

/** Close painting (other tools call this before opening). */
export function closePaintAndCut(): void { void closePaint(); }
