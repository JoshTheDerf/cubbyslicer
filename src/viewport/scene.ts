/**
 * The Prepare scene: bed, objects, selection/hover, orbit camera, transform
 * gizmo, box select and lay-on-face picking. Framework-agnostic — the Vue
 * wrapper (PrepareViewport.vue) feeds it data and receives callbacks.
 *
 * Rendering is on demand (no idle loop). Geometries are shared per mesh id
 * (instances) and ref-counted; everything is disposed on removal.
 */
import {
  AmbientLight, Box3, MOUSE, BufferAttribute, BufferGeometry, CircleGeometry, Color, DirectionalLight, DoubleSide,
  Float32BufferAttribute, Group, HemisphereLight, LineBasicMaterial, LineSegments, Matrix3, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PerspectiveCamera, Plane, Raycaster, Scene, Sphere, Vector2, Vector3, WebGLRenderer,
  type Intersection, type Ray,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { BedShape } from '../app/state';
import type { Quat, Vec3 } from '../project/math';
import type { MeshData, ProjectObject } from '../project/types';
import { buildBed, buildBedExtras, disposeObject3D, plateLabelSprite } from './bed';
import { plateBed, plateIndexAt } from '../project/plates';
import { loadBedMesh, loadBedTexture } from './bedAssets';
import type { BedAssets } from '../presets/types';
import type { GizmoMode, ViewPreset } from './controller';
import { readViewportTheme, type ViewportTheme } from './tokens';
import { ViewCube } from './viewCube';

export interface SceneItem {
  obj: ProjectObject;
  mesh: MeshData;
  /** Blocking plate issue (outside / too tall / exclude) → warning colour. */
  warn: boolean;
  /** Meshes of the object's parts, by mesh id. */
  partMeshes?: Map<string, MeshData>;
}

/** Orca-like colours for non-model volumes (translucent). */
const PART_COLORS: Record<string, number> = {
  negative: 0x8a8f98,
  modifier: 0xf5c542,
  support_blocker: 0xef5b5b,
  support_enforcer: 0x4ea1ff,
};

export interface TransformResult { id: string; position: Vec3; rotation: Quat; scale: Vec3 }

export interface SceneCallbacks {
  onPick(id: string | null, mode: 'replace' | 'toggle'): void;
  onBoxSelect(ids: string[], additive: boolean): void;
  onBoxRect(rect: { x: number; y: number; w: number; h: number } | null): void;
  onTransformEnd(results: TransformResult[], mode: GizmoMode): void;
  onLayOnFace(id: string, worldNormal: Vec3): void;
  onContextMenu(id: string | null, clientX: number, clientY: number): void;
  onHover(id: string | null): void;
  /** A click on empty space over plate `index` (multi-plate: makes it active). */
  onPlateClick?(index: number): void;
  /** Gizmo drag of a single part ended: its new transform in the object's frame. */
  onPartTransformEnd?(objectId: string, partId: string, t: { position: Vec3; rotation: Quat; scale: Vec3 }, mode: GizmoMode): void;
}

/** A surface hit handed to an interactive tool (src/tools: measure, text placement, brim ears, …). */
export interface ToolHit { objectId: string; partId: string | null; point: Vector3; normal: Vector3; faceIndex: number; object: Mesh }
export interface ToolPointerEvent {
  /**
   * 'down' / 'drag' / 'up' are only sent to tools with `strokes: true`
   * (painting): 'down' returning true captures the pointer — the camera
   * doesn't orbit, and 'drag' events follow until 'up'.
   */
  kind: 'hover' | 'click' | 'context' | 'leave' | 'down' | 'drag' | 'up';
  /** Mouse button of down/drag/up/click/context (0 left, 2 right). */
  button?: number;
  hit: ToolHit | null;
  ray: Ray;
  clientX: number; clientY: number;
  shift: boolean; ctrl: boolean; alt: boolean;
  pointerType: string;
}
/** An interactive tool: receives picks; returning true consumes the click (no selection change / context menu). */
export interface ToolHandler {
  onPointer(e: ToolPointerEvent): boolean;
  /** Hide the transform gizmo while the tool is active. */
  hideGizmo?: boolean;
  cursor?: string;
  /** Receive down/drag/up (press-and-drag strokes, e.g. painting). */
  strokes?: boolean;
}

interface PartEntry { key: string; meshId: string; mesh: Mesh }

interface Entry {
  id: string;
  meshId: string;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  triangles: number;
  /** Child meshes for the object's parts (object-local transforms). */
  parts: PartEntry[];
}

const HOVER_FULL_RAYCAST_MAX_TRIS = 400_000;

export class PrepareScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.5, 50000);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private theme: ViewportTheme;
  private bedGroup: Group | null = null;
  private bed: BedShape | null = null;
  private longPress: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly touches = new Set<number>();
  private plateCount = 1;
  /** The user has orbited / zoomed: stop auto-framing on resize. */
  private userCamera = false;
  private activePlate = 0;
  private bedAssets: BedAssets | null = null;
  private bedExtrasToken = 0;
  private objectsGroup = new Group();
  private entries = new Map<string, Entry>();
  private geometries = new Map<string, { geo: BufferGeometry; refs: number }>();
  private selected = new Set<string>();
  private hovered: string | null = null;
  private selectionBox: LineSegments;
  private pivot = new Object3D();
  private dragStart: {
    pivotInv: Matrix4;
    items: Array<{ entry: Entry; matrix: Matrix4 }>;
    /** Dragging one part of an object: its world matrix at drag start + the object's inverse world matrix. */
    part?: { objectId: string; partId: string; mesh: Mesh; world: Matrix4; parentInv: Matrix4 };
  } | null = null;
  /** Part picked in the object list: the gizmo manipulates it instead of the whole object. */
  private activePart: { objectId: string; partId: string } | null = null;
  private mode: GizmoMode = 'translate';
  private layOnFace = false;
  private faceMarker: Mesh;
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private frame = 0;
  private ro: ResizeObserver;
  private disposed = false;
  private down: { x: number; y: number; button: number; shift: boolean; ctrl: boolean; box: boolean } | null = null;
  private hoverPending: PointerEvent | null = null;
  private anim: { from: Vector3; to: Vector3; tFrom: Vector3; tTo: Vector3; start: number; dur: number } | null = null;
  private width = 1;
  private items: SceneItem[] = [];
  private pixelRatioCap: number;
  private cleanup: Array<() => void> = [];
  private viewCube: ViewCube | null = null;
  private wasVisible = false;
  /** Active interactive tool (see ToolHandler). */
  private tool: ToolHandler | null = null;
  private toolStroke: { pointerId: number; button: number } | null = null;

  constructor(private container: HTMLElement, private cb: SceneCallbacks) {
    this.theme = readViewportTheme();
    const gfx = readGraphicsSettings();
    this.pixelRatioCap = gfx.pixelRatioCap;
    this.renderer = new WebGLRenderer({ antialias: gfx.antialias, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.classList.add('vp-canvas');
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.scene.add(this.camera);

    // Lighting matches the CubbyCAD editor (cad-project/src/core/Scene.ts
    // setupLights), converted from its Y-up world to our Z-up bed space.
    this.scene.add(new AmbientLight(0xffffff, 0.8));
    const hemi = new HemisphereLight(0xffffff, 0xe8eef5, 0.6);
    hemi.position.set(0, 0, 200);
    this.scene.add(hemi);
    const key = new DirectionalLight(0xffffff, 1.0);
    key.position.set(100, -100, 150);
    const fill = new DirectionalLight(0xffffff, 0.4);
    fill.position.set(-120, 60, 80);
    this.scene.add(key, fill);

    this.scene.add(this.objectsGroup);

    // Selection bracket box (world AABB corners).
    this.selectionBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: this.theme.selected, depthTest: false, transparent: true, opacity: 0.9 }));
    this.selectionBox.renderOrder = 10;
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    // Lay-on-face marker.
    this.faceMarker = new Mesh(new CircleGeometry(1, 40),
      new MeshBasicMaterial({ color: this.theme.selected, transparent: true, opacity: 0.55, depthTest: false, side: DoubleSide }));
    this.faceMarker.renderOrder = 11;
    this.faceMarker.visible = false;
    this.scene.add(this.faceMarker);

    // Controls
    const dom = this.renderer.domElement;
    this.orbit = new OrbitControls(this.camera, dom);
    // Same mouse mapping as the CAD editor: left = select / marquee,
    // middle = pan, right = orbit, wheel = zoom.
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.25;
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    this.orbit.screenSpacePanning = true;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI; // allow looking from below
    this.orbit.addEventListener('change', () => this.requestRender());
    this.orbit.addEventListener('start', () => { this.userCamera = true; });

    this.gizmo = new TransformControls(this.camera, dom);
    this.gizmo.setSize(0.85);
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.pivot);
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !(e as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('mouseDown', () => this.beginDrag());
    this.gizmo.addEventListener('objectChange', () => this.applyDrag());
    this.gizmo.addEventListener('mouseUp', () => this.endDrag());

    // Pointer handling — capture phase on the container so box-select can pre-empt orbit.
    const onDownCapture = (e: PointerEvent) => this.onPointerDownCapture(e);
    const onMove = (e: PointerEvent) => this.onPointerMove(e);
    const onUp = (e: PointerEvent) => this.onPointerUp(e);
    const onCtx = (e: MouseEvent) => { e.preventDefault(); };
    const onLeave = (e: PointerEvent) => { this.setHover(null); this.tool?.onPointer(this.toolEvent('leave', e)); };
    const onDbl = (e: MouseEvent) => { const hit = this.pick(e.clientX, e.clientY); if (hit) this.fitSelection(); };
    const onKey = (e: KeyboardEvent) => this.setSnapping(e.shiftKey);
    container.addEventListener('pointerdown', onDownCapture, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    const onCancel = (e: PointerEvent) => { this.touches.delete(e.pointerId); this.cancelLongPress(); };
    window.addEventListener('pointercancel', onCancel);
    dom.addEventListener('contextmenu', onCtx);
    dom.addEventListener('pointerleave', onLeave);
    dom.addEventListener('dblclick', onDbl);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    this.cleanup.push(() => {
      container.removeEventListener('pointerdown', onDownCapture, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('contextmenu', onCtx);
      dom.removeEventListener('pointerleave', onLeave);
      dom.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    });

    // Orca-style view cube (top-right). Optional: a failure here must not take the plater down.
    try {
      // Smaller cube on phones (it shares the corner with the view).
      const small = container.clientWidth > 0 && container.clientWidth < 700;
      this.viewCube = new ViewCube({
        renderer: this.renderer, camera: this.camera, controls: this.orbit, container,
        requestRender: () => this.requestRender(),
        ...(small ? { gizmo: { size: 72, offset: { top: 8, right: 8 } } } : {}),
      });
    } catch (e) { console.warn('[viewport] view cube unavailable', e); }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.camera.position.set(-150, -250, 250);
    this.orbit.target.set(110, 110, 0);
    this.orbit.update();
  }

  // ---- lifecycle ----------------------------------------------------------

  private pixelRatio(): number {
    const dr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    return this.pixelRatioCap === 0 ? Math.min(dr, 3) : Math.min(dr, this.pixelRatioCap);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelLongPress();
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    for (const c of this.cleanup) c();
    this.viewCube?.dispose();
    this.viewCube = null;
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    for (const e of this.entries.values()) e.mesh.material.dispose();
    for (const g of this.geometries.values()) g.geo.dispose();
    this.entries.clear();
    this.geometries.clear();
    if (this.bedGroup) disposeObject3D(this.bedGroup);
    this.selectionBox.geometry.dispose();
    (this.selectionBox.material as LineBasicMaterial).dispose();
    this.faceMarker.geometry.dispose();
    (this.faceMarker.material as MeshBasicMaterial).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 1 || h < 1) return;
    this.width = w;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    const aspectChanged = Math.abs(this.camera.aspect - w / h) > 0.01;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCube?.update();
    // Until the user moves the camera, keep the plate framed (first layout,
    // rotating a phone, opening/closing the sidebar).
    if (aspectChanged && !this.userCamera && this.bed) this.setView('iso', false);
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.frame = 0;
    if (this.disposed) return;
    let again = false;
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.start) / this.anim.dur);
      const k = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.anim.from, this.anim.to, k);
      this.orbit.target.lerpVectors(this.anim.tFrom, this.anim.tTo, k);
      if (t >= 1) this.anim = null; else again = true;
    }
    if (this.orbit.update()) again = true;
    if (this.hoverPending) { const e = this.hoverPending; this.hoverPending = null; this.updateHover(e); }
    // Hidden (e.g. Preview tab or collapsed): skip drawing, but stay ready.
    const visible = this.container.offsetParent !== null && this.width > 1;
    if (visible) {
      // The cube caches DOM rects; after a display:none round trip it must be rebuilt.
      if (!this.wasVisible) this.viewCube?.update({ rebuild: true });
      this.updateCameraPlanes();
      this.renderer.render(this.scene, this.camera);
      this.viewCube?.render();
    }
    this.wasVisible = visible;
    if (again) this.requestRender();
  }

  private updateCameraPlanes(): void {
    const d = this.camera.position.distanceTo(this.orbit.target);
    const near = Math.max(0.1, d / 500), far = Math.max(5000, d * 20);
    if (Math.abs(this.camera.near - near) > near * 0.2 || this.camera.far !== far) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---- bed ------------------------------------------------------------------

  /** Re-read the accent tokens (the UI accent follows the engine: green Orca, orange preFlight). */
  refreshAccent(): void {
    const t = readViewportTheme();
    this.theme.selected.copy(t.selected);
    (this.selectionBox.material as LineBasicMaterial).color.copy(t.selected);
    (this.faceMarker.material as MeshBasicMaterial).color.copy(t.selected);
    for (const e of this.entries.values()) this.styleEntry(e);
    this.requestRender();
  }

  setBed(bed: BedShape): void { this.setPlates(bed, this.plateCount, this.activePlate); }

  /**
   * Plates (see project/plates.ts): `count` copies of the bed laid out in
   * Orca's grid; the active one is drawn normally, the others dimmed.
   * Callers refit the camera (fitBed) when the user picks a plate explicitly.
   */
  setPlates(bed: BedShape, count: number, active: number): void {
    const first = !this.bed;
    const same = this.bed === bed && count === this.plateCount;
    this.bed = bed;
    this.plateCount = Math.max(1, count);
    this.activePlate = Math.min(Math.max(0, active), this.plateCount - 1);
    if (!same || !this.bedGroup) {
      if (this.bedGroup) { this.scene.remove(this.bedGroup); disposeObject3D(this.bedGroup); }
      const g = new Group();
      g.name = 'plates';
      for (let i = 0; i < this.plateCount; i++) {
        const pg = buildBed(plateBed(bed, i, this.plateCount), this.theme);
        pg.userData.plate = i;
        if (this.plateCount > 1) pg.add(plateLabelSprite(plateBed(bed, i, this.plateCount), i, this.theme));
        g.add(pg);
      }
      this.bedGroup = g;
      this.scene.add(g);
      void this.refreshBedExtras();
    }
    this.styleActivePlate();
    if (first) this.setView('iso', false);
    this.requestRender();
  }

  /** Dim every plate but the active one (materials are per plate group). */
  private styleActivePlate(): void {
    this.bedGroup?.children.forEach((pg) => {
      const on = pg.userData.plate === this.activePlate || this.plateCount === 1;
      pg.traverse((o) => {
        const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
        if (!mat || Array.isArray(mat)) return;
        const base = (mat.userData.base ??= { opacity: mat.opacity, transparent: mat.transparent }) as { opacity: number; transparent: boolean };
        const transparent = on ? base.transparent : true;
        const opacity = on ? base.opacity : base.opacity * 0.4;
        if (mat.transparent !== transparent || mat.opacity !== opacity) {
          mat.transparent = transparent; mat.opacity = opacity; mat.needsUpdate = true;
        }
      });
    });
  }

  /** Plate index under a screen point (ray ∩ bed plane), or -1. */
  plateAt(clientX: number, clientY: number): number {
    if (!this.bed) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3());
    return hit ? plateIndexAt(hit.x, hit.y, this.plateCount, this.bed) : -1;
  }

  /** The printer model's bed mesh / texture (lazy; see bedAssets.ts). null = generic plate only. */
  setBedAssets(assets: BedAssets | null): void {
    if (assets?.model === this.bedAssets?.model && assets?.texture === this.bedAssets?.texture) return;
    this.bedAssets = assets;
    void this.refreshBedExtras();
  }

  private async refreshBedExtras(): Promise<void> {
    const token = ++this.bedExtrasToken;
    const a = this.bedAssets;
    const [mesh, tex] = await Promise.all([
      a?.model ? loadBedMesh(a.model) : null,
      a?.texture ? loadBedTexture(a.texture) : null,
    ]);
    if (token !== this.bedExtrasToken || this.disposed || !this.bed) return;
    // The vendor mesh replaces the flat plate (grid, edge and axes stay on top),
    // on every plate; extras live inside each plate group so dimming applies.
    this.bedGroup?.children.forEach((pg) => {
      const i = pg.userData.plate as number;
      pg.traverse((o) => { if (o.name === 'plate') o.visible = !mesh; });
      const old = pg.getObjectByName('bed-extras') as Group | undefined;
      if (old) { old.removeFromParent(); disposeObject3D(old); }
      if (mesh || tex) pg.add(buildBedExtras(plateBed(this.bed!, i, this.plateCount), this.theme, mesh, tex));
    });
    this.styleActivePlate();
    this.requestRender();
  }

  // ---- objects --------------------------------------------------------------

  private acquireGeometry(m: MeshData): BufferGeometry {
    let g = this.geometries.get(m.id);
    if (!g) {
      const geo = new BufferGeometry();
      // Shares the store's typed arrays — no copy on the JS side.
      geo.setAttribute('position', new BufferAttribute(m.positions, 3));
      geo.setIndex(new BufferAttribute(m.indices, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      g = { geo, refs: 0 };
      this.geometries.set(m.id, g);
    }
    g.refs++;
    return g.geo;
  }

  private releaseGeometry(meshId: string): void {
    const g = this.geometries.get(meshId);
    if (!g) return;
    if (--g.refs <= 0) { g.geo.dispose(); this.geometries.delete(meshId); }
  }

  /** Reconcile three objects with the project. Cheap when nothing structural changed. */
  sync(items: SceneItem[], selected: Iterable<string>): void {
    this.items = items;
    this.selected = new Set(selected);
    const seen = new Set<string>();
    for (const it of items) {
      const { obj } = it;
      seen.add(obj.id);
      let e = this.entries.get(obj.id);
      if (e && e.meshId !== obj.meshId) { this.removeEntry(e); e = undefined; }
      if (!e) {
        const mat = new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new Mesh(this.acquireGeometry(it.mesh), mat);
        mesh.userData.objectId = obj.id;
        e = { id: obj.id, meshId: obj.meshId, mesh, triangles: it.mesh.triangleCount, parts: [] };
        this.entries.set(obj.id, e);
        this.objectsGroup.add(mesh);
        for (const ov of this.objectOverlays.get(obj.id)?.values() ?? []) mesh.add(ov);
      }
      if (!this.dragStart) {
        e.mesh.position.set(obj.position[0], obj.position[1], obj.position[2]);
        e.mesh.quaternion.set(obj.rotation[0], obj.rotation[1], obj.rotation[2], obj.rotation[3]);
        e.mesh.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
      }
      e.mesh.visible = obj.visible;
      this.syncParts(e, it);
      this.styleEntry(e, it);
    }
    for (const e of [...this.entries.values()]) if (!seen.has(e.id)) this.removeEntry(e);
    if (this.hovered && !this.entries.has(this.hovered)) this.hovered = null;
    if (!this.dragStart) this.updateGizmo();
    this.updateSelectionBox();
    this.requestRender();
  }

  /** Child meshes for parts: model parts share the object's material, other volume types are translucent. */
  private syncParts(e: Entry, it: SceneItem): void {
    const parts = it.obj.parts ?? [];
    const keys = parts.map((p) => `${p.id}|${p.meshId}|${p.type}`);
    if (keys.join() !== e.parts.map((p) => p.key).join()) {
      for (const pe of e.parts) this.disposePart(e, pe);
      e.parts = [];
      parts.forEach((p, i) => {
        const md = it.partMeshes?.get(p.meshId);
        if (!md) return;
        const mat = p.type === 'part' ? e.mesh.material : new MeshStandardMaterial({
          color: PART_COLORS[p.type] ?? 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, roughness: 1, metalness: 0,
          flatShading: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        const m = new Mesh(this.acquireGeometry(md), mat);
        m.userData.objectId = e.id;
        m.userData.partId = p.id;
        m.renderOrder = p.type === 'part' ? 0 : 1;
        e.mesh.add(m);
        e.parts.push({ key: keys[i], meshId: p.meshId, mesh: m });
        e.triangles += md.triangleCount;
      });
    }
    parts.forEach((p, i) => {
      const m = e.parts[i]?.mesh;
      if (!m || this.dragStart?.part?.mesh === m) return;
      m.position.set(p.position[0], p.position[1], p.position[2]);
      m.quaternion.set(p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]);
      m.scale.set(p.scale[0], p.scale[1], p.scale[2]);
    });
  }

  private disposePart(e: Entry, pe: PartEntry): void {
    e.mesh.remove(pe.mesh);
    if (pe.mesh.material !== e.mesh.material) (pe.mesh.material as MeshStandardMaterial).dispose();
    const g = this.geometries.get(pe.meshId);
    if (g) e.triangles -= (g.geo.index?.count ?? 0) / 3;
    this.releaseGeometry(pe.meshId);
  }

  private styleEntry(e: Entry, it?: SceneItem): void {
    const item = it ?? this.items.find((x) => x.obj.id === e.id);
    if (!item) return;
    const mat = e.mesh.material;
    const base = item.warn ? this.theme.warn : item.obj.color ? safeColor(item.obj.color, this.theme.object) : this.theme.object;
    mat.color.copy(base);
    const sel = this.selected.has(e.id), hov = this.hovered === e.id;
    if (sel) mat.emissive.copy(this.theme.selected).multiplyScalar(0.3);
    else if (hov) mat.emissive.copy(this.theme.hover).multiplyScalar(0.2);
    else mat.emissive.setRGB(0, 0, 0);
    const ghost = !item.obj.printable;
    if (mat.transparent !== ghost) { mat.transparent = ghost; mat.needsUpdate = true; }
    mat.opacity = ghost ? 0.4 : 1;
    mat.depthWrite = !ghost;
  }

  private removeEntry(e: Entry): void {
    if (this.gizmo.object && this.dragStart?.items.some((i) => i.entry === e)) { this.gizmo.detach(); this.dragStart = null; }
    for (const pe of e.parts) this.disposePart(e, pe);
    this.objectsGroup.remove(e.mesh);
    e.mesh.material.dispose();
    this.releaseGeometry(e.meshId);
    this.entries.delete(e.id);
  }

  private selectedEntries(): Entry[] {
    return [...this.selected].map((id) => this.entries.get(id)).filter((e): e is Entry => !!e && e.mesh.visible);
  }

  private worldBoxOf(entries: Entry[]): Box3 | null {
    if (!entries.length) return null;
    const box = new Box3();
    for (const e of entries) {
      e.mesh.updateMatrixWorld();
      const b = new Box3().setFromObject(e.mesh, e.triangles < 200_000);
      box.union(b);
    }
    return box.isEmpty() ? null : box;
  }

  private updateSelectionBox(): void {
    const box = this.worldBoxOf(this.selectedEntries());
    if (!box) { this.selectionBox.visible = false; return; }
    const { min: a, max: b } = box;
    const size = new Vector3().subVectors(b, a);
    const l = (k: number) => Math.min(size.getComponent(k) * 0.25, 12);
    const pts: number[] = [];
    for (const x of [a.x, b.x]) for (const y of [a.y, b.y]) for (const z of [a.z, b.z]) {
      const sx = x === a.x ? 1 : -1, sy = y === a.y ? 1 : -1, sz = z === a.z ? 1 : -1;
      pts.push(x, y, z, x + sx * l(0), y, z, x, y, z, x, y + sy * l(1), z, x, y, z, x, y, z + sz * l(2));
    }
    this.selectionBox.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    this.selectionBox.geometry = g;
    this.selectionBox.visible = true;
  }

  // ---- gizmo ------------------------------------------------------------------

  setGizmoMode(mode: GizmoMode): void {
    this.mode = mode;
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' ? 'local' : 'world');
    this.gizmo.showZ = mode !== 'translate';
    this.updateGizmo();
    this.requestRender();
  }

  setLayOnFace(on: boolean): void {
    this.layOnFace = on;
    this.faceMarker.visible = false;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.updateGizmo();
    this.requestRender();
  }

  private setSnapping(on: boolean): void {
    this.gizmo.setTranslationSnap(on ? 5 : null);
    this.gizmo.setRotationSnap(on ? Math.PI / 12 : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  /** Mesh of the active part, when it belongs to the single selected object. */
  private activePartMesh(): Mesh | null {
    const ap = this.activePart;
    if (!ap || this.selected.size !== 1 || !this.selected.has(ap.objectId)) return null;
    return this.entries.get(ap.objectId)?.parts.find((p) => p.mesh.userData.partId === ap.partId)?.mesh ?? null;
  }

  setActivePart(p: { objectId: string; partId: string } | null): void {
    this.activePart = p;
    if (!this.dragStart) this.updateGizmo();
    this.requestRender();
  }

  private updateGizmo(): void {
    const sel = this.selectedEntries();
    if (!sel.length || this.layOnFace || this.tool?.hideGizmo) { if (this.gizmo.object) this.gizmo.detach(); return; }
    const pm = this.activePartMesh();
    if (pm) {
      pm.updateMatrixWorld(true);
      pm.matrixWorld.decompose(this.pivot.position, this.pivot.quaternion, this.pivot.scale);
    } else if (sel.length === 1) {
      const m = sel[0].mesh;
      this.pivot.position.copy(m.position);
      this.pivot.quaternion.copy(m.quaternion);
      this.pivot.scale.copy(m.scale);
    } else {
      const box = this.worldBoxOf(sel)!;
      box.getCenter(this.pivot.position);
      this.pivot.position.z = box.min.z;
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
    }
    this.pivot.updateMatrixWorld(true);
    if (this.gizmo.object !== this.pivot) this.gizmo.attach(this.pivot);
  }

  private beginDrag(): void {
    this.pivot.updateMatrix();
    const pm = this.activePartMesh();
    if (pm && this.activePart) {
      pm.updateMatrixWorld(true);
      this.dragStart = {
        pivotInv: this.pivot.matrix.clone().invert(), items: [],
        part: { ...this.activePart, mesh: pm, world: pm.matrixWorld.clone(), parentInv: pm.parent!.matrixWorld.clone().invert() },
      };
      return;
    }
    this.dragStart = {
      pivotInv: this.pivot.matrix.clone().invert(),
      items: this.selectedEntries().map((entry) => { entry.mesh.updateMatrix(); return { entry, matrix: entry.mesh.matrix.clone() }; }),
    };
  }

  private applyDrag(): void {
    if (!this.dragStart) return;
    this.pivot.updateMatrix();
    const delta = this.pivot.matrix.clone().multiply(this.dragStart.pivotInv);
    const part = this.dragStart.part;
    if (part) {
      // world' = delta · world, back into the object's frame.
      part.parentInv.clone().multiply(delta.clone().multiply(part.world)).decompose(part.mesh.position, part.mesh.quaternion, part.mesh.scale);
      this.updateSelectionBox();
      return;
    }
    for (const { entry, matrix } of this.dragStart.items) {
      const m = delta.clone().multiply(matrix);
      m.decompose(entry.mesh.position, entry.mesh.quaternion, entry.mesh.scale);
    }
    this.updateSelectionBox();
  }

  private endDrag(): void {
    const ds = this.dragStart;
    if (!ds) return;
    this.dragStart = null;
    if (ds.part) {
      const m = ds.part.mesh;
      this.cb.onPartTransformEnd?.(ds.part.objectId, ds.part.partId, {
        position: [m.position.x, m.position.y, m.position.z],
        rotation: [m.quaternion.x, m.quaternion.y, m.quaternion.z, m.quaternion.w],
        scale: [m.scale.x, m.scale.y, m.scale.z],
      }, this.mode);
      return;
    }
    const results: TransformResult[] = ds.items.map(({ entry }) => {
      const m = entry.mesh;
      return {
        id: entry.id,
        position: [m.position.x, m.position.y, m.position.z],
        rotation: [m.quaternion.x, m.quaternion.y, m.quaternion.z, m.quaternion.w],
        scale: [m.scale.x, m.scale.y, m.scale.z],
      };
    });
    this.cb.onTransformEnd(results, this.mode);
  }

  // ---- picking ------------------------------------------------------------------

  private setNdc(clientX: number, clientY: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private visibleMeshes(): Mesh[] {
    return [...this.entries.values()].filter((e) => e.mesh.visible).map((e) => e.mesh);
  }

  pick(clientX: number, clientY: number): Intersection | null {
    this.setNdc(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.visibleMeshes(), true);
    return hits[0] ?? null;
  }

  /** Cheap hover pick: exact for small meshes, bounding box for huge ones. */
  private pickCheap(clientX: number, clientY: number): string | null {
    this.setNdc(clientX, clientY);
    let best: { id: string; d: number } | null = null;
    const tmp = new Vector3();
    for (const e of this.entries.values()) {
      if (!e.mesh.visible) continue;
      if (e.triangles <= HOVER_FULL_RAYCAST_MAX_TRIS) {
        const h = this.raycaster.intersectObject(e.mesh, false)[0];
        if (h && (!best || h.distance < best.d)) best = { id: e.id, d: h.distance };
      } else {
        const box = new Box3().setFromObject(e.mesh, false);
        const p = this.raycaster.ray.intersectBox(box, tmp);
        if (p) { const d = p.distanceTo(this.raycaster.ray.origin); if (!best || d < best.d) best = { id: e.id, d }; }
      }
    }
    return best?.id ?? null;
  }

  private setHover(id: string | null): void {
    if (this.hovered === id) return;
    const prev = this.hovered;
    this.hovered = id;
    for (const x of [prev, id]) { const e = x ? this.entries.get(x) : null; if (e) this.styleEntry(e); }
    this.cb.onHover(id);
    this.requestRender();
  }

  private onPointerDownCapture(e: PointerEvent): void {
    if (e.target !== this.renderer.domElement) return;
    this.cancelLongPress();
    // Only the left button drives the gizmo; a right click over a handle still opens the object menu.
    const overGizmo = e.button === 0 && !!this.gizmo.object && this.gizmo.axis !== null;
    const touch = e.pointerType === 'touch';
    this.touches.add(e.pointerId);
    // Touch: one finger orbits (OrbitControls), so no box selection; a long
    // press opens the object / plate menu (the touch equivalent of right-click).
    // Stroke tools (painting): a press they accept captures the pointer.
    if (this.tool?.strokes && !overGizmo && (e.button === 0 || e.button === 2) && this.touches.size === 1) {
      const ev = this.toolEvent('down', e);
      ev.button = e.button;
      if (this.tool.onPointer(ev)) {
        e.stopPropagation();
        e.preventDefault();
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.toolStroke = { pointerId: e.pointerId, button: e.button };
        this.down = null;
        return;
      }
    }
    const startBox = !touch && e.button === 0 && !overGizmo && !this.layOnFace && !this.tool && !this.pick(e.clientX, e.clientY);
    if (touch && !overGizmo && this.touches.size === 1) {
      const x = e.clientX, y = e.clientY;
      this.longPress = {
        x, y,
        timer: setTimeout(() => {
          this.longPress = null;
          this.down = null; // swallow the tap that ends this press
          const hit = this.pick(x, y);
          this.cb.onContextMenu((hit?.object.userData.objectId as string | undefined) ?? null, x, y);
        }, 550),
      };
    }
    this.down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, box: startBox };
    if (startBox) {
      e.stopPropagation();
      e.preventDefault();
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
    if (overGizmo) this.down = null; // gizmo owns this gesture
  }

  private cancelLongPress(): void {
    if (this.longPress) { clearTimeout(this.longPress.timer); this.longPress = null; }
  }

  private onPointerMove(e: PointerEvent): void {
    const lp = this.longPress;
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) this.cancelLongPress();
    if (this.toolStroke && this.tool && e.pointerId === this.toolStroke.pointerId) {
      const ev = this.toolEvent('drag', e);
      ev.button = this.toolStroke.button;
      this.tool.onPointer(ev);
      return;
    }
    const d = this.down;
    if (d?.box) {
      const r = this.container.getBoundingClientRect();
      const x0 = Math.min(d.x, e.clientX) - r.left, y0 = Math.min(d.y, e.clientY) - r.top;
      this.cb.onBoxRect({ x: x0, y: y0, w: Math.abs(e.clientX - d.x), h: Math.abs(e.clientY - d.y) });
      return;
    }
    if (e.target !== this.renderer.domElement || this.gizmo.dragging || (e.buttons & 3)) return;
    this.hoverPending = e;
    this.requestRender();
  }

  private updateHover(e: PointerEvent): void {
    if (this.tool) { this.tool.onPointer(this.toolEvent('hover', e)); return; }
    if (this.layOnFace) {
      const hit = this.pick(e.clientX, e.clientY);
      if (hit?.face) {
        const n = this.worldNormal(hit);
        const s = hit.object as Mesh;
        const radius = Math.max(2, (s.geometry.boundingSphere?.radius ?? 10) * Math.max(...s.scale.toArray().map(Math.abs)) * 0.18);
        this.faceMarker.position.copy(hit.point).addScaledVector(n, 0.05);
        this.faceMarker.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), n);
        this.faceMarker.scale.setScalar(radius);
        this.faceMarker.visible = true;
        this.setHover(s.userData.objectId as string);
      } else {
        this.faceMarker.visible = false;
        this.setHover(null);
      }
      return;
    }
    this.setHover(this.pickCheap(e.clientX, e.clientY));
  }

  private worldNormal(hit: Intersection): Vector3 {
    const nm = new Matrix3().getNormalMatrix(hit.object.matrixWorld);
    return hit.face!.normal.clone().applyMatrix3(nm).normalize();
  }

  private onPointerUp(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    this.cancelLongPress();
    if (this.toolStroke && e.pointerId === this.toolStroke.pointerId) {
      const ev = this.toolEvent('up', e);
      ev.button = this.toolStroke.button;
      this.toolStroke = null;
      try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.tool?.onPointer(ev);
      return;
    }
    const d = this.down;
    this.down = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4;
    if (d.box) {
      this.cb.onBoxRect(null);
      try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) this.cb.onBoxSelect(this.idsInRect(d.x, d.y, e.clientX, e.clientY), d.shift || d.ctrl);
      else if (!d.shift && !d.ctrl) {
        this.cb.onPick(null, 'replace');
        const p = this.plateCount > 1 ? this.plateAt(e.clientX, e.clientY) : -1;
        if (p >= 0 && p !== this.activePlate) this.cb.onPlateClick?.(p);
      }
      return;
    }
    if (moved) return;
    if (this.tool && (d.button === 0 || d.button === 2) && this.tool.onPointer(this.toolEvent(d.button === 0 ? 'click' : 'context', e))) return;
    if (d.button === 2) {
      const hit = this.pick(e.clientX, e.clientY);
      const id = (hit?.object.userData.objectId as string | undefined) ?? null;
      this.cb.onContextMenu(id, e.clientX, e.clientY);
      return;
    }
    if (d.button !== 0) return;
    const hit = this.pick(e.clientX, e.clientY);
    const id = (hit?.object.userData.objectId as string | undefined) ?? null;
    if (!id && !this.layOnFace && this.plateCount > 1) {
      const p = this.plateAt(e.clientX, e.clientY);
      if (p >= 0 && p !== this.activePlate) this.cb.onPlateClick?.(p);
    }
    if (this.layOnFace) {
      if (hit && id) this.cb.onLayOnFace(id, this.worldNormal(hit).toArray() as Vec3);
      return;
    }
    this.cb.onPick(id, d.shift || d.ctrl ? 'toggle' : 'replace');
  }

  // ---- per-object overlays (painted facets, …) -----------------------------------

  private objectOverlays = new Map<string, Map<string, Object3D>>();

  /**
   * Attach `obj` to an object in its mesh-local frame (it follows the object's
   * transform), under `key`; null removes it. Survives scene re-syncs.
   */
  setObjectOverlay(objectId: string, key: string, obj: Object3D | null): void {
    let m = this.objectOverlays.get(objectId);
    const old = m?.get(key);
    if (old) { old.removeFromParent(); disposeOverlay(old); m!.delete(key); }
    if (obj) {
      if (!m) this.objectOverlays.set(objectId, (m = new Map()));
      m.set(key, obj);
      obj.userData.overlay = true;
      this.entries.get(objectId)?.mesh.add(obj);
    }
    if (m && !m.size) this.objectOverlays.delete(objectId);
    this.requestRender();
  }

  /** World matrix of an object's mesh-local frame (null if not in the scene). */
  objectMatrixWorld(objectId: string): Matrix4 | null {
    const e = this.entries.get(objectId);
    if (!e) return null;
    e.mesh.updateMatrixWorld(true);
    return e.mesh.matrixWorld.clone();
  }

  // ---- interactive tools (src/tools) ------------------------------------------

  /** Install / remove the active tool. Tools draw into their own groups added to `scene`. */
  setToolHandler(h: ToolHandler | null): void {
    this.tool = h;
    this.toolStroke = null;
    this.renderer.domElement.style.cursor = h ? (h.cursor ?? 'crosshair') : this.layOnFace ? 'crosshair' : '';
    if (!this.dragStart) this.updateGizmo();
    this.requestRender();
  }

  private toolEvent(kind: ToolPointerEvent['kind'], e: PointerEvent): ToolPointerEvent {
    const h = kind === 'leave' ? null : this.pick(e.clientX, e.clientY);
    if (kind === 'leave') this.setNdc(e.clientX, e.clientY);
    const obj = h?.object as Mesh | undefined;
    const hit: ToolHit | null = h && obj && h.face ? {
      objectId: obj.userData.objectId as string, partId: (obj.userData.partId as string | undefined) ?? null,
      point: h.point.clone(), normal: this.worldNormal(h), faceIndex: h.faceIndex ?? h.face.a, object: obj,
    } : null;
    return {
      kind, hit, ray: this.raycaster.ray.clone(), clientX: e.clientX, clientY: e.clientY,
      shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, pointerType: e.pointerType,
    };
  }

  /** Objects whose projected bbox centre lies in the screen rect. */
  private idsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const out: string[] = [];
    const c = new Vector3();
    for (const e of this.entries.values()) {
      if (!e.mesh.visible) continue;
      new Box3().setFromObject(e.mesh, false).getCenter(c);
      c.project(this.camera);
      const sx = r.left + ((c.x + 1) / 2) * r.width, sy = r.top + ((1 - c.y) / 2) * r.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY && c.z < 1) out.push(e.id);
    }
    return out;
  }

  // ---- camera ------------------------------------------------------------------

  private viewDir(p: ViewPreset): Vector3 {
    switch (p) {
      case 'top': return new Vector3(0, -0.0001, 1);
      case 'bottom': return new Vector3(0, -0.0001, -1);
      case 'front': return new Vector3(0, -1, 0.0001);
      case 'back': return new Vector3(0, 1, 0.0001);
      case 'left': return new Vector3(-1, 0, 0.0001);
      case 'right': return new Vector3(1, 0, 0.0001);
      default: return new Vector3(-0.55, -1, 0.85).normalize();
    }
  }

  private bedBox(): Box3 {
    const b = this.bed ? plateBed(this.bed, this.activePlate, this.plateCount) : null;
    if (!b) return new Box3(new Vector3(0, 0, 0), new Vector3(220, 220, 0));
    return new Box3(new Vector3(b.min[0], b.min[1], 0), new Vector3(b.max[0], b.max[1], Math.min(b.maxHeight || 0, 40)));
  }

  private fitBox(box: Box3, dir?: Vector3, animate = true): void {
    const sphere = box.getBoundingSphere(new Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    const fovMin = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = Math.max(sphere.radius, 5) / Math.sin(fovMin / 2) * 1.08;
    const d = (dir ?? this.camera.position.clone().sub(this.orbit.target).normalize()).clone();
    const to = sphere.center.clone().addScaledVector(d, dist);
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      this.anim = null;
      this.camera.position.copy(to);
      this.orbit.target.copy(sphere.center);
    } else {
      this.anim = { from: this.camera.position.clone(), to, tFrom: this.orbit.target.clone(), tTo: sphere.center.clone(), start: performance.now(), dur: 260 };
    }
    this.requestRender();
  }

  setView(p: ViewPreset, animate = true): void {
    const sel = this.worldBoxOf(this.selectedEntries());
    this.fitBox(p === 'iso' || !sel ? this.bedBox() : this.bedBox().union(sel), this.viewDir(p), animate);
  }

  fitSelection(): void {
    const box = this.worldBoxOf(this.selectedEntries()) ?? this.worldBoxOf([...this.entries.values()].filter((e) => e.mesh.visible));
    if (box) this.fitBox(box); else this.fitBed();
  }

  fitBed(): void { this.fitBox(this.bedBox()); }

  /** Dolly toward (+1) / away from (-1) the orbit target (Orca's I / O). */
  zoom(dir: 1 | -1): void {
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const len = offset.length();
    const next = Math.min(20000, Math.max(5, len * (dir > 0 ? 0.8 : 1.25)));
    const to = this.orbit.target.clone().addScaledVector(offset.normalize(), next);
    const t = this.orbit.target.clone();
    this.anim = { from: this.camera.position.clone(), to, tFrom: t, tTo: t.clone(), start: performance.now(), dur: 160 };
    this.requestRender();
  }
}

/** Graphics prefs shared with the CubbyCAD editor (same origin → same localStorage key). */
function readGraphicsSettings(): { pixelRatioCap: number; antialias: boolean } {
  const out = { pixelRatioCap: 2, antialias: true };
  try {
    const raw = localStorage.getItem('cad-graphics');
    if (!raw) return out;
    const p = JSON.parse(raw) as { pixelRatioCap?: unknown; antialias?: unknown };
    if (p.pixelRatioCap === 0 || p.pixelRatioCap === 1 || p.pixelRatioCap === 1.5 || p.pixelRatioCap === 2) out.pixelRatioCap = p.pixelRatioCap;
    if (typeof p.antialias === 'boolean') out.antialias = p.antialias;
  } catch { /* defaults */ }
  return out;
}

function safeColor(s: string, fallback: Color): Color {
  try { return new Color().setStyle(s); } catch { return fallback; }
}


function disposeOverlay(o: Object3D): void {
  o.traverse((c) => {
    const m = c as Mesh;
    if (!c.userData.sharedGeometry) m.geometry?.dispose();
    const mat = m.material as MeshBasicMaterial | MeshBasicMaterial[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
  });
}
