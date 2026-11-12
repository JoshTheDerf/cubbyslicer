/**
 * Texture displacement mask painting (desktop GLGizmoTextureDisplacement, a
 * GLGizmoPainterBase): Brush (circle / sphere), Face and Connected area paint
 * or erase the active layer's mask on any model part of the object. Masks are
 * Orca TriangleSelectors with one state (ENFORCER = painted), run in the
 * engine's painting sessions (src/paint/session.ts, the same code the support
 * / seam / colour / fuzzy painting uses) and stored per part and slot as the
 * `paint_texture_N` strings desktop writes. A stroke is one undo step over
 * every part it touched.
 */
import { reactive } from 'vue';
import { BufferAttribute, BufferGeometry, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { PaintApplyArgs, PaintApplyKind } from '../engine/tools';
import type { PaintMap, ToolMesh } from '../engine/types';
import { getMeshTexture, getObject, setTextureMasks } from '../project/store';
import { BrushCursor } from '../paint/cursor';
import { applyToSession, closeSession, decodePaint, openSession, sessionPaint } from '../paint/session';
import { ToolOverlay, render } from '../tools/overlay';
import { installHandler, toolScene } from '../tools/state';
import type { ToolHandler, ToolPointerEvent } from '../viewport/scene';
import { textureParts, type TexturePart } from './bake';
import { maskFits } from './model';

type Mask = ReadonlyArray<readonly [number, string]>;

export type MaskTool = 'brush' | 'face' | 'area';

/** GLGizmoPainterBase limits: CursorRadiusMin / Max / Step, SmartFillAngleMin / Max / Step; defaults 1 mm, 30°. */
export const RADIUS_MIN = 0.4, RADIUS_MAX = 8, RADIUS_STEP = 0.2;
export const ANGLE_MIN = 0, ANGLE_MAX = 90, ANGLE_STEP = 1;

export const maskUi = reactive({
  tool: 'brush' as MaskTool,
  /** Brush cursor: Circle (everything under it, seen from the camera) or Sphere (a ball around the point). */
  cursor: 'circle' as 'circle' | 'sphere',
  radius: 1,
  angle: 30,
  /** Desktop's Paint / Erase toggle (m_erase_mode). */
  erase: false,
  busy: false,
  error: '',
});

/**
 * Whether a press paints (true) or erases: the right button does the opposite
 * of the Paint / Erase toggle, Shift always erases (handle_snapshot_action_name).
 */
export function pressPaints(button: number, shift: boolean, eraseMode: boolean): boolean {
  return !(shift || eraseMode !== (button === 2));
}

/** The engine operation of a tool: Face clicks single triangles, Connected area is the smart fill. */
export function toolKind(tool: MaskTool, cursor: 'circle' | 'sphere'): PaintApplyKind {
  return tool === 'face' ? 'pointer' : tool === 'area' ? 'fill' : cursor;
}

/** Ctrl / Alt + wheel: brush size (Brush) or smart fill angle (Connected area), desktop's steps and limits. */
export function wheelStep(tool: MaskTool, up: boolean): void {
  if (tool === 'brush') maskUi.radius = +Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, maskUi.radius + (up ? RADIUS_STEP : -RADIUS_STEP))).toFixed(2);
  else if (tool === 'area') maskUi.angle = Math.min(ANGLE_MAX, Math.max(ANGLE_MIN, maskUi.angle + (up ? ANGLE_STEP : -ANGLE_STEP)));
}

/** Desktop's tints: the active layer green, the other layers' paint neutral grey. */
const ACTIVE_TINT = { color: 0x29c95a, opacity: 0.45 }, OTHER_TINT = { color: 0x8c949a, opacity: 0.4 };

type Job = { kind: 'apply'; part: TexturePart; args: Omit<PaintApplyArgs, 'handle'> } | { kind: 'commit'; paints: boolean };

interface PartSession { handle: number; meshId: string; slot: number; from: Mask | undefined; touched: boolean }

export class TextureMaskPainter {
  private sessions = new Map<string, PartSession>();
  /** Live painted facets of the active slot per mesh (from the session), drawn instead of the stored mask. */
  private live = new Map<string, ToolMesh | null>();
  private decoded = new WeakMap<object, Promise<ToolMesh | null>>();
  private overlay = new ToolOverlay('texture-paint');
  private cursor = new BrushCursor();
  private inFlight: Promise<void> | null = null;
  /** Waiting work, in order. Brush moves queued behind a slow engine call merge into one segment. */
  private queue: Job[] = [];
  private stroke: { paints: boolean; button: number; prev: number[] | null; meshId: string | null } | null = null;
  private tintSeq = 0;
  private enabled = false;
  private disposed = false;

  constructor(private readonly objectId: () => string | null, private readonly slot: () => number) {}

  /** Paint while the tool is open and a layer is active. */
  setEnabled(on: boolean): void {
    if (on === this.enabled || this.disposed) return;
    this.enabled = on;
    const canvas = toolScene.value?.renderer.domElement;
    if (on) {
      installHandler(this.handler);
      canvas?.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    } else {
      installHandler(null);
      canvas?.removeEventListener('wheel', this.onWheel, { capture: true });
      const sc = toolScene.value;
      if (sc) this.cursor.place(sc, null, 0, false);
      this.stroke = null;
    }
  }

  /** The active slot / object changed: sessions are per slot, so they start over. */
  reset(): void {
    this.closeSessions();
    this.live.clear();
    void this.refreshTint();
  }

  dispose(): void {
    this.setEnabled(false);
    this.disposed = true;
    this.closeSessions();
    this.cursor.dispose();
    this.overlay.dispose();
  }

  private closeSessions(): void {
    this.queue = [];
    for (const s of this.sessions.values()) closeSession(s.handle);
    this.sessions.clear();
  }

  // ---- tint (desktop rebuild_paint_overlay / rebuild_other_paint_overlay) ------------------------

  private decode(part: TexturePart, mask: Mask): Promise<ToolMesh | null> {
    let p = this.decoded.get(mask);
    if (!p) {
      p = decodePaint({ positions: part.mesh.positions, indices: part.mesh.indices }, 'texture', mask as PaintMap)
        .then((r) => r.meshes[r.states.indexOf(1)] ?? null).catch(() => null);
      this.decoded.set(mask, p);
    }
    return p;
  }

  /** Rebuild the tint overlay from the stored masks (and the live strokes). */
  async refreshTint(): Promise<void> {
    const seq = ++this.tintSeq;
    const id = this.objectId(), o = id ? getObject(id) : undefined;
    const active = this.slot();
    const items: Array<{ part: TexturePart; mesh: ToolMesh; activeSlot: boolean }> = [];
    if (o) {
      for (const part of textureParts(o)) {
        const masks = getMeshTexture(part.mesh.id).masks ?? {};
        for (const [k, mask] of Object.entries(masks)) {
          const s = Number(k);
          if (s === active && this.live.has(part.mesh.id)) continue;
          if (!mask.length || !maskFits(mask, part.mesh.triangleCount)) continue;
          const m = await this.decode(part, mask);
          if (seq !== this.tintSeq || this.disposed) return;
          if (m) items.push({ part, mesh: m, activeSlot: s === active });
        }
        const lv = this.live.get(part.mesh.id);
        if (lv) items.push({ part, mesh: lv, activeSlot: true });
      }
    }
    if (seq !== this.tintSeq || this.disposed) return;
    this.overlay.attach();
    this.overlay.clear();
    for (const it of items) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(it.mesh.positions, 3));
      g.setIndex(new BufferAttribute(it.mesh.indices, 1));
      const t = it.activeSlot ? ACTIVE_TINT : OTHER_TINT;
      // Translucent, pulled toward the camera so it wins against the coincident surface, no depth
      // writes (render_paint_overlay). Where the preview's relief rises, the relief itself shows the paint.
      const mat = new MeshBasicMaterial({
        color: t.color, transparent: true, opacity: t.opacity, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const m = new Mesh(g, mat);
      m.matrixAutoUpdate = false;
      m.matrix.fromArray(it.part.matrix);
      m.renderOrder = 5;
      this.overlay.add(m);
    }
    render();
  }

  // ---- engine sessions ----------------------------------------------------------------------

  /** The part's session for the active slot, (re)opened when its mask changed outside it (undo, whole model, bridge). */
  private async session(part: TexturePart): Promise<PartSession | null> {
    const slot = this.slot();
    const mask = getMeshTexture(part.mesh.id).masks?.[String(slot)];
    const cur = this.sessions.get(part.mesh.id);
    if (cur && cur.slot === slot && cur.from === mask) return cur;
    if (cur) { closeSession(cur.handle); this.sessions.delete(part.mesh.id); }
    if (!maskFits(mask, part.mesh.triangleCount)) {
      maskUi.error = 'This layer’s paint on this part was recorded for a different mesh, so it can’t be edited. Erase whole model clears it.';
      return null;
    }
    const r = await openSession({ positions: part.mesh.positions, indices: part.mesh.indices }, 'texture', mask as PaintMap | undefined);
    if (this.disposed || this.slot() !== slot) { closeSession(r.handle); return null; }
    const s: PartSession = { handle: r.handle, meshId: part.mesh.id, slot, from: mask, touched: false };
    this.sessions.set(part.mesh.id, s);
    return s;
  }

  private schedule(job: Job): void {
    const last = this.queue[this.queue.length - 1];
    if (job.kind === 'apply' && last?.kind === 'apply' && last.part.mesh.id === job.part.mesh.id && last.args.kind === job.args.kind
        && last.args.state === job.args.state && last.args.prev && job.args.prev) {
      job.args.prev = last.args.prev; // one segment from where the merged move started
      this.queue[this.queue.length - 1] = job;
    } else this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.inFlight) return;
    const job = this.queue.shift();
    if (!job) { maskUi.busy = false; return; }
    maskUi.busy = true;
    const run = job.kind === 'apply' ? this.apply(job.part, job.args) : this.commit(job.paints);
    this.inFlight = run.catch((e) => { maskUi.error = (e as Error)?.message ?? String(e); }).finally(() => {
      this.inFlight = null;
      this.pump();
    });
  }

  /** One brush operation on the hit part. */
  private async apply(part: TexturePart, op: Omit<PaintApplyArgs, 'handle'>): Promise<void> {
    const s = await this.session(part);
    if (!s) return;
    const r = await applyToSession(s.handle, op);
    if (this.sessions.get(part.mesh.id) !== s) return;
    s.touched = true;
    this.live.set(part.mesh.id, r.meshes[r.states.indexOf(1)] ?? null);
    await this.refreshTint();
  }

  /** Stroke end: every touched part's mask written as one undo step. */
  private async commit(paints: boolean): Promise<void> {
    const id = this.objectId(), o = id ? getObject(id) : undefined;
    const slot = this.slot();
    const touched = [...this.sessions.values()].filter((s) => s.touched && s.slot === slot);
    if (!o || !touched.length) return;
    const parts = new Set(textureParts(o).map((p) => p.mesh.id));
    const changes: Array<{ meshId: string; slot: number; mask: PaintMap | null }> = [];
    for (const s of touched) {
      s.touched = false;
      if (!parts.has(s.meshId)) continue;
      const paint = await sessionPaint(s.handle);
      changes.push({ meshId: s.meshId, slot, mask: paint.length ? paint : null });
    }
    if (!changes.length) return;
    setTextureMasks(changes, paints ? 'Paint texture displacement' : 'Erase texture displacement paint');
    for (const c of changes) {
      const s = this.sessions.get(c.meshId);
      if (s) s.from = getMeshTexture(c.meshId).masks?.[String(slot)];
      this.live.delete(c.meshId);
    }
    await this.refreshTint();
  }

  // ---- pointer --------------------------------------------------------------------------------

  private partAt(e: ToolPointerEvent): TexturePart | null {
    const id = this.objectId(), o = id ? getObject(id) : undefined;
    if (!o || !e.hit || e.hit.objectId !== o.id) return null;
    return textureParts(o).find((p) => p.partId === e.hit!.partId) ?? null;
  }

  private args(e: ToolPointerEvent, paints: boolean): Omit<PaintApplyArgs, 'handle'> & { point: number[] } {
    const hit = e.hit!;
    hit.object.updateMatrixWorld(true);
    const mw = hit.object.matrixWorld;
    const inv = new Matrix4().copy(mw).invert();
    const sc = toolScene.value!;
    return {
      kind: toolKind(maskUi.tool, maskUi.cursor), facet: hit.faceIndex,
      point: hit.point.clone().applyMatrix4(inv).toArray(), camera: sc.camera.position.clone().applyMatrix4(inv).toArray(),
      state: paints ? 1 : 0, radius: maskUi.radius, angle: maskUi.angle, trafo: mw.elements.slice(),
    };
  }

  private placeCursor(e: ToolPointerEvent): void {
    const sc = toolScene.value;
    if (!sc) return;
    const on = maskUi.tool === 'brush' && !!this.partAt(e);
    const n = e.hit?.normal ?? new Vector3(0, 0, 1);
    this.cursor.place(sc, e.hit ? { ...e.hit, normal: n } : null, maskUi.radius, on);
  }

  readonly handler: ToolHandler = {
    strokes: true,
    hideGizmo: true,
    cursor: 'crosshair',
    onPointer: (e) => {
      if (e.kind === 'hover' || e.kind === 'leave') { this.placeCursor(e); return false; }
      if (e.kind === 'down') {
        this.placeCursor(e);
        const part = this.partAt(e);
        if (!part || this.slot() < 0) return false; // not on a model part of the object: the camera orbits
        maskUi.error = '';
        const paints = pressPaints(e.button ?? 0, e.shift, maskUi.erase);
        const args = this.args(e, paints);
        this.stroke = { paints, button: e.button ?? 0, prev: args.point, meshId: part.mesh.id };
        this.schedule({ kind: 'apply', part, args });
        return true;
      }
      if (e.kind === 'drag') {
        this.placeCursor(e);
        const st = this.stroke;
        if (!st || maskUi.tool === 'area') return true; // Connected area fills once per click
        const part = this.partAt(e);
        if (!part) { st.prev = null; return true; }
        const args = this.args(e, st.paints);
        // The brush paints the segment since the last point (on the same part).
        if (maskUi.tool === 'brush' && st.prev && st.meshId === part.mesh.id) args.prev = st.prev;
        st.prev = args.point;
        st.meshId = part.mesh.id;
        this.schedule({ kind: 'apply', part, args });
        return true;
      }
      if (e.kind === 'up') {
        const st = this.stroke;
        this.stroke = null;
        if (st) this.schedule({ kind: 'commit', paints: st.paints });
        return true;
      }
      return e.kind === 'click' || e.kind === 'context';
    },
  };

  private onWheel = (ev: WheelEvent): void => {
    if (!(ev.ctrlKey || ev.altKey) || maskUi.tool === 'face') return;
    ev.preventDefault();
    ev.stopPropagation();
    wheelStep(maskUi.tool, ev.deltaY < 0);
  };
}
