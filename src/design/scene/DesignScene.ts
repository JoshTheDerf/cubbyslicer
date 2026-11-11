/**
 * The Design view's three.js scene: the design's bodies from the kernel's display meshes
 * (`get_mesh`), their B-rep edges, face / edge highlighting and picking by kernel ids, the
 * printer bed and Orca's reference planes. Camera, controls, lighting, the view cube and the
 * render-on-demand loop follow the Prepare scene (src/viewport/scene.ts): Z up, bed coordinates
 * (the design frame is the bed's), left = pick, middle = pan, right = orbit, wheel = zoom.
 *
 * Highlighting recolours vertices: the display mesh doesn't share vertices between faces, so a
 * face's colour never bleeds into its neighbours.
 */
import {
  AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, Group, HemisphereLight,
  LineBasicMaterial, LineSegments, MOUSE, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry,
  Quaternion, Raycaster, Scene, Sphere, TOUCH, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CameraProjection, type CameraType } from '@cubby/shared/camera';
import { setPickRayFromCamera } from '@cubby/shared/gizmo';
import type { BedShape } from '../../app/state';
import type { Vec3 } from '../../project/math';
import { buildBed, disposeObject3D } from '../../viewport/bed';
import { cappedPixelRatio, readGraphicsSettings } from '../../viewport/graphics';
import { readViewportTheme, tokenColor, type ViewportTheme } from '../../viewport/tokens';
import { ViewCube } from '../../viewport/viewCube';
import { SectionView, clipBy } from '../../viewport/viewEffects';
import type { ViewPreset } from '../../viewport/controller';
import type { DisplayBody } from '../kernel/mesh';

/** A polyline drawn with the depth test (`setDepthStrokes`): world points and a CSS colour token. */
export interface DepthStroke { pts: Vec3[]; color: string }

export interface DesignHit { body: number; face: number; point: Vector3; clientX: number; clientY: number }

export interface DesignSceneCallbacks {
  /** A click (no drag) with the left button; null = empty space. */
  onClick(hit: DesignHit | null, e: { shift: boolean; ctrl: boolean; clientX: number; clientY: number }): void;
  onHover?(hit: { body: number; face: number } | null): void;
  /** A right click without a drag (Orca's offer menu); null = empty space. */
  onContext?(hit: DesignHit | null, e: { clientX: number; clientY: number }): void;
  /** A double-click; return true when it was handled (otherwise it frames the body / everything). */
  onDbl?(e: { clientX: number; clientY: number }): boolean;
}

/** Pointer input while a sketch is open (left button / one finger; right-drag and two fingers still navigate). */
export interface SketchPointer { clientX: number; clientY: number; shift: boolean; ctrl: boolean; alt: boolean; touch: boolean }
export interface SketchInput {
  down(e: SketchPointer): void;
  move(e: SketchPointer, buttons: boolean): void;
  up(e: SketchPointer): void;
  dbl(e: SketchPointer): void;
  /** A right click without a drag (ends a chain, Orca's offer). */
  context(e: SketchPointer): void;
  /** A second finger landed / the pointer was lost: abandon the press. */
  cancel(): void;
  leave?(): void;
}

/**
 * What a click picks (and the hover shows): the normal pick cycle, or one kind while a
 * reference field is being picked (faces, edges, whole bodies).
 */
export type ScenePickMode = 'cycle' | 'face' | 'edge' | 'body';

/** A translucent body shape (Orca's preview ghost): plate-mesh layout, world mm. */
export interface GhostMesh { positions: Float32Array; indices: Uint32Array }

/** What is drawn highlighted. Face / edge ids are per body. */
export interface DesignHighlight {
  /** Whole bodies (body pick, the selected feature's bodies). */
  bodies: ReadonlySet<number>;
  faces: ReadonlyMap<number, ReadonlySet<number>>;
  edges: ReadonlyMap<number, ReadonlySet<number>>;
  /** References of the feature card being edited (drawn in the reference colour). */
  refBodies?: ReadonlySet<number>;
  refFaces?: ReadonlyMap<number, ReadonlySet<number>>;
  refEdges?: ReadonlyMap<number, ReadonlySet<number>>;
}

const EMPTY_HL: DesignHighlight = { bodies: new Set(), faces: new Map(), edges: new Map() };

interface BodyEntry {
  data: DisplayBody;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  edges: LineSegments;
  base: Color;
  /** Vertex indices of each face (lazy). */
  faceVerts: Map<number, Uint32Array> | null;
}

export class DesignScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly projection = new CameraProjection({
    perspectiveCamera: new PerspectiveCamera(35, 1, 0.5, 50000),
    orthographic: { near: -50000, far: 50000 },
    onChange: (cam) => { this.viewCube?.setCamera(cam); this.requestRender(); },
  });
  readonly orbit: OrbitControls;
  private theme: ViewportTheme;
  private bodiesGroup = new Group();
  private bodies = new Map<number, BodyEntry>();
  private bedGroup: Group | null = null;
  private bedShape: BedShape | null = null;
  private originGroup: Group | null = null;
  private edgeOverlay: LineSegments2 | null = null;
  private refEdgeOverlay: LineSegments2 | null = null;
  private hoverEdgeOverlay: LineSegments2 | null = null;
  private edgeMaterial: LineMaterial;
  private refEdgeMaterial: LineMaterial;
  private hoverEdgeMaterial: LineMaterial;
  private pickMode: ScenePickMode = 'cycle';
  private hoverEdge: { body: number; edge: number } | null = null;
  private ghostGroup: Group | null = null;
  private highlight: DesignHighlight = EMPTY_HL;
  private hover: { body: number; face: number } | null = null;
  private hidden = new Set<number>();
  private viewCube: ViewCube | null = null;
  private raycaster = new Raycaster();
  private ro: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private width = 1;
  private wasVisible = false;
  private userCamera = false;
  private framedOnce = false;
  private down: { x: number; y: number; button: number; shift: boolean; ctrl: boolean } | null = null;
  private hoverPending: PointerEvent | null = null;
  private anim: { from: Vector3; to: Vector3; tFrom: Vector3; tTo: Vector3; start: number; dur: number; zFrom?: number; zTo?: number } | null = null;
  private cleanup: Array<() => void> = [];
  private sketchInput: SketchInput | null = null;
  private sketchDown = false;
  private touchIds = new Set<number>();
  private viewListeners = new Set<() => void>();
  private savedCamera: { pos: Vector3; target: Vector3; up: Vector3 } | null = null;
  private colSelected: Color;
  private colHover: Color;
  private colFeature: Color;
  private colEdge: Color;
  private colRef: Color;
  /** Orca's Design section view: Prepare's clipping plane, held horizontal at `sectionCut.z` (no cap: Orca's only hides). */
  private section = new SectionView();
  /** Strokes drawn with the depth test (Orca's connector disc), rebuilt before every frame. */
  private depthStrokes: { fn: () => DepthStroke[]; obj: LineSegments<BufferGeometry, LineBasicMaterial> } | null = null;
  private sectionCut: { z: number; upper: boolean } | null = null;

  constructor(private container: HTMLElement, private cb: DesignSceneCallbacks) {
    this.theme = readViewportTheme();
    this.colSelected = this.theme.selected.clone();
    this.colHover = this.theme.hover.clone();
    this.colFeature = this.theme.selected.clone();
    this.colEdge = tokenColor('--vp-cad-edge', '#1b2027');
    this.colRef = tokenColor('--vp-cad-ref', '#f2a33a');
    const gfx = readGraphicsSettings();
    this.renderer = new WebGLRenderer({ antialias: gfx.antialias, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(cappedPixelRatio(gfx.pixelRatioCap));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.classList.add('vp-canvas');
    this.renderer.domElement.dataset.designCanvas = '';
    container.appendChild(this.renderer.domElement);

    this.projection.perspective.up.set(0, 0, 1);
    this.projection.orthographic.up.set(0, 0, 1);
    this.scene.add(this.projection.perspective, this.projection.orthographic);
    // Prepare's lighting (CubbyCAD's setupLights in bed space).
    this.scene.add(new AmbientLight(0xffffff, 0.8));
    const hemi = new HemisphereLight(0xffffff, 0xe8eef5, 0.6);
    hemi.position.set(0, 0, 200);
    const key = new DirectionalLight(0xffffff, 1.0);
    key.position.set(100, -100, 150);
    const fill = new DirectionalLight(0xffffff, 0.4);
    fill.position.set(-120, 60, 80);
    this.scene.add(hemi, key, fill, this.bodiesGroup);

    this.edgeMaterial = new LineMaterial({ color: this.colSelected.getHex(), linewidth: 3, worldUnits: false, depthTest: false, transparent: true });
    this.refEdgeMaterial = new LineMaterial({ color: this.colRef.getHex(), linewidth: 4, worldUnits: false, depthTest: false, transparent: true });
    this.hoverEdgeMaterial = new LineMaterial({ color: this.colHover.getHex(), linewidth: 4, worldUnits: false, depthTest: false, transparent: true, opacity: 0.9 });
    for (const m of [this.edgeMaterial, this.refEdgeMaterial, this.hoverEdgeMaterial]) clipBy(m, this.section);

    const dom = this.renderer.domElement;
    this.orbit = new OrbitControls(this.camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.25;
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    this.orbit.screenSpacePanning = true;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI;
    this.orbit.addEventListener('change', () => this.requestRender());
    this.orbit.addEventListener('start', () => { this.userCamera = true; });

    const sp = (e: PointerEvent | MouseEvent): SketchPointer => ({ clientX: e.clientX, clientY: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, touch: 'pointerType' in e && e.pointerType === 'touch' });
    const onDown = (e: PointerEvent) => {
      if (e.target !== dom) return;
      if (e.pointerType === 'touch') this.touchIds.add(e.pointerId);
      const si = this.sketchInput;
      if (si && this.touchIds.size > 1) { if (this.sketchDown) { this.sketchDown = false; si.cancel(); } this.down = null; return; }
      this.down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      if (si && e.button === 0) { this.sketchDown = true; try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ } si.down(sp(e)); }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.touchIds.delete(e.pointerId);
      const si = this.sketchInput;
      if (si) {
        const d = this.down;
        this.down = null;
        if (this.sketchDown && e.button === 0) { this.sketchDown = false; si.up(sp(e)); return; }
        if (d && d.button === 2 && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4) si.context(sp(e));
        return;
      }
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      if (d.button === 2) { this.cb.onContext?.(this.pickAt(e.clientX, e.clientY), { clientX: e.clientX, clientY: e.clientY }); return; }
      if (d.button !== 0) return;
      this.cb.onClick(this.pickAt(e.clientX, e.clientY), { shift: d.shift, ctrl: d.ctrl, clientX: e.clientX, clientY: e.clientY });
    };
    const onMove = (e: PointerEvent) => {
      const si = this.sketchInput;
      if (si) {
        if (this.sketchDown) si.move(sp(e), true);
        else if (e.target === dom && !(e.buttons & 7) && e.pointerType !== 'touch') si.move(sp(e), false);
        return;
      }
      if (e.target !== dom || (e.buttons & 7)) return;
      this.hoverPending = e;
      this.requestRender();
    };
    const onLeave = () => { if (this.sketchInput) { this.sketchInput.leave?.(); return; } this.setHover(null); };
    const onCancel = (e: PointerEvent) => { this.touchIds.delete(e.pointerId); if (this.sketchDown) { this.sketchDown = false; this.sketchInput?.cancel(); } };
    const onDbl = (e: MouseEvent) => { if (this.sketchInput) { this.sketchInput.dbl(sp(e)); return; } if (this.cb.onDbl?.({ clientX: e.clientX, clientY: e.clientY })) return; const h = this.pickAt(e.clientX, e.clientY); if (h) this.fitBodies([h.body]); else this.fitAll(); };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    dom.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerleave', onLeave);
    dom.addEventListener('pointercancel', onCancel);
    dom.addEventListener('dblclick', onDbl);
    dom.addEventListener('contextmenu', onCtx);
    this.cleanup.push(() => {
      dom.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('dblclick', onDbl);
      dom.removeEventListener('contextmenu', onCtx);
    });

    try {
      const small = container.clientWidth > 0 && container.clientWidth < 700;
      this.viewCube = new ViewCube({
        renderer: this.renderer, camera: this.camera, controls: this.orbit, container,
        requestRender: () => this.requestRender(),
        ...(small ? { gizmo: { size: 72, offset: { top: 8, right: 8 } } } : {}),
      });
    } catch (e) { console.warn('[design] view cube unavailable', e); }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.camera.position.set(-150, -250, 250);
    this.orbit.target.set(0, 0, 0);
    this.orbit.update();
    this.resize();
  }

  get camera(): PerspectiveCamera | OrthographicCamera { return this.projection.camera; }
  get cameraType(): CameraType { return this.projection.type; }

  setCameraType(t: CameraType): void {
    if (t === this.projection.type) return;
    this.anim = null;
    this.projection.setType(t, { controls: this.orbit });
  }

  dispose(): void {
    this.setDepthStrokes(null);
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    for (const c of this.cleanup) c();
    this.viewCube?.dispose();
    this.orbit.dispose();
    this.clearBodies();
    if (this.bedGroup) disposeObject3D(this.bedGroup);
    if (this.originGroup) disposeObject3D(this.originGroup);
    this.edgeOverlay?.geometry.dispose();
    this.edgeMaterial.dispose();
    this.section.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- render loop (on demand) ------------------------------------------------------

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => this.render());
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 1 || h < 1) return;
    this.width = w;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.edgeMaterial.resolution.set(w, h);
    this.refEdgeMaterial.resolution.set(w, h);
    this.hoverEdgeMaterial.resolution.set(w, h);
    this.projection.resize(w, h);
    this.viewCube?.update();
    if (!this.userCamera) this.fitAll(false);
    this.requestRender();
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
      if (this.anim.zTo !== undefined && this.camera instanceof OrthographicCamera) {
        this.camera.zoom = this.anim.zFrom! + (this.anim.zTo - this.anim.zFrom!) * k;
        this.camera.updateProjectionMatrix();
      }
      if (t >= 1) this.anim = null; else again = true;
    }
    if (this.orbit.update()) again = true;
    if (this.hoverPending) { const e = this.hoverPending; this.hoverPending = null; this.updateHover(e.clientX, e.clientY); }
    const visible = this.container.offsetParent !== null && this.width > 1;
    if (visible) {
      if (!this.wasVisible) { this.viewCube?.update({ rebuild: true }); this.resize(); }
      this.updateCameraPlanes();
      if (this.depthStrokes) { this.camera.updateMatrixWorld(); this.buildDepthStrokes(); }
      this.renderer.render(this.scene, this.camera);
      this.viewCube?.render();
      for (const fn of this.viewListeners) fn();
    }
    this.wasVisible = visible;
    if (again) this.requestRender();
  }

  private updateCameraPlanes(): void {
    if (!(this.camera instanceof PerspectiveCamera)) return;
    const d = this.camera.position.distanceTo(this.orbit.target);
    const near = Math.max(0.05, d / 1000), far = Math.max(5000, d * 20);
    if (Math.abs(this.camera.near - near) > near * 0.2 || this.camera.far !== far) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---- content --------------------------------------------------------------------------

  private clearBodies(): void {
    for (const e of this.bodies.values()) {
      e.mesh.geometry.dispose(); e.mesh.material.dispose();
      e.edges.geometry.dispose(); (e.edges.material as LineBasicMaterial).dispose();
    }
    this.bodies.clear();
    this.bodiesGroup.clear();
  }

  /** Show these bodies (replaces the previous set). `colors[body]` overrides the default body colour. */
  setBodies(list: readonly DisplayBody[], colors: ReadonlyMap<number, Color>): void {
    this.clearBodies();
    const fallback = tokenColor('--vp-cad-body', '#a9b4c2');
    for (const d of list) {
      if (!d.indices.length) continue; // a body without faces: nothing to draw
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(d.positions, 3));
      g.setAttribute('normal', new BufferAttribute(d.normals, 3));
      g.setIndex(new BufferAttribute(d.indices, 1));
      const base = (colors.get(d.body) ?? fallback).clone();
      const col = new Float32Array(d.positions.length);
      for (let i = 0; i < col.length; i += 3) { col[i] = base.r; col[i + 1] = base.g; col[i + 2] = base.b; }
      g.setAttribute('color', new BufferAttribute(col, 3));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      clipBy(mat, this.section);
      const mesh = new Mesh(g, mat);
      mesh.userData.body = d.body;
      // Edge polylines → segments (seams and degenerate edges are pickable but not drawn).
      const seg: number[] = [];
      for (let k = 0; k < d.edgeIds.length; k++) {
        if (d.hiddenEdges.has(d.edgeIds[k])) continue;
        for (let p = d.edgeStarts[k]; p + 1 < d.edgeStarts[k + 1]; p++) {
          seg.push(d.edgePoints[3 * p], d.edgePoints[3 * p + 1], d.edgePoints[3 * p + 2], d.edgePoints[3 * p + 3], d.edgePoints[3 * p + 4], d.edgePoints[3 * p + 5]);
        }
      }
      const eg = new BufferGeometry();
      eg.setAttribute('position', new Float32BufferAttribute(seg, 3));
      const edges = new LineSegments(eg, new LineBasicMaterial({ color: this.colEdge, transparent: true, opacity: 0.85, clippingPlanes: this.section.planes }));
      edges.renderOrder = 1;
      const entry: BodyEntry = { data: d, mesh, edges, base, faceVerts: null };
      this.bodies.set(d.body, entry);
      const grp = new Group();
      grp.add(mesh, edges);
      grp.visible = !this.hidden.has(d.body);
      grp.userData.body = d.body;
      this.bodiesGroup.add(grp);
    }
    this.applyColours();
    this.updateEdgeOverlay();
    this.applySection();
    if (!this.framedOnce && this.bodies.size) { this.framedOnce = true; if (!this.userCamera) this.fitAll(false); }
    this.requestRender();
  }

  setHidden(hidden: Iterable<number>): void {
    this.hidden = new Set(hidden);
    for (const g of this.bodiesGroup.children) g.visible = !this.hidden.has(g.userData.body as number);
    this.requestRender();
  }

  setHighlight(h: DesignHighlight): void {
    this.highlight = h;
    this.applyColours();
    this.updateEdgeOverlay();
    this.requestRender();
  }

  private setHover(h: { body: number; face: number } | null): void {
    if (h?.body === this.hover?.body && h?.face === this.hover?.face) return;
    this.hover = h;
    this.renderer.domElement.style.cursor = h || this.hoverEdge ? 'pointer' : '';
    this.applyColours();
    this.cb.onHover?.(h);
    this.requestRender();
  }

  /** Hover for the current pick mode: a face (cycle / face), the nearest edge, or the whole body. */
  private updateHover(clientX: number, clientY: number): void {
    if (this.pickMode === 'edge') {
      const e = this.pickEdgeAt(clientX, clientY, 14);
      if (e?.body !== this.hoverEdge?.body || e?.edge !== this.hoverEdge?.edge) {
        this.hoverEdge = e;
        this.updateHoverEdge();
      }
      this.setHover(null);
      this.renderer.domElement.style.cursor = e ? 'pointer' : '';
      return;
    }
    if (this.hoverEdge) { this.hoverEdge = null; this.updateHoverEdge(); }
    const h = this.pickAt(clientX, clientY);
    this.setHover(h ? { body: h.body, face: this.pickMode === 'body' ? -1 : h.face } : null);
  }

  /** What a click picks and the hover shows (reference fields set it while picking). */
  setPickMode(m: ScenePickMode): void {
    if (m === this.pickMode) return;
    this.pickMode = m;
    this.hoverEdge = null;
    this.updateHoverEdge();
    this.hover = null;
    this.applyColours();
    this.requestRender();
  }

  /** Orca's preview ghost: the candidate feature's result, translucent over the bodies (null clears). */
  setGhost(list: readonly GhostMesh[] | null): void {
    if (this.ghostGroup) { this.scene.remove(this.ghostGroup); disposeObject3D(this.ghostGroup); this.ghostGroup = null; }
    if (list?.length) {
      const g = new Group();
      const mat = new MeshStandardMaterial({ color: this.colRef, transparent: true, opacity: 0.38, roughness: 0.6, metalness: 0, side: DoubleSide, depthWrite: false, clippingPlanes: this.section.planes });
      for (const m of list) {
        if (!m.indices.length) continue;
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(m.positions, 3));
        geo.setIndex(new BufferAttribute(m.indices, 1));
        geo.computeVertexNormals();
        const mesh = new Mesh(geo, mat);
        mesh.renderOrder = 3;
        g.add(mesh);
      }
      this.ghostGroup = g;
      this.scene.add(g);
      // The ghost replaces the look of the bodies it previews: dim them.
      for (const e of this.bodies.values()) { e.mesh.material.transparent = true; e.mesh.material.opacity = 0.35; e.mesh.material.depthWrite = false; }
    } else {
      for (const e of this.bodies.values()) { e.mesh.material.transparent = false; e.mesh.material.opacity = 1; e.mesh.material.depthWrite = true; }
    }
    this.requestRender();
  }

  private segmentsOf(sel: ReadonlyMap<number, ReadonlySet<number>>): number[] {
    const pts: number[] = [];
    for (const [b, ids] of sel) {
      const e = this.bodies.get(b);
      if (!e || this.hidden.has(b)) continue;
      const d = e.data;
      for (let k = 0; k < d.edgeIds.length; k++) {
        if (!ids.has(d.edgeIds[k])) continue;
        for (let p = d.edgeStarts[k]; p + 1 < d.edgeStarts[k + 1]; p++) for (let q = 0; q < 6; q++) pts.push(d.edgePoints[3 * p + q]);
      }
    }
    return pts;
  }

  private overlay(old: LineSegments2 | null, pts: number[], mat: LineMaterial, order: number): LineSegments2 | null {
    if (old) { this.scene.remove(old); old.geometry.dispose(); }
    if (!pts.length) return null;
    const g = new LineSegmentsGeometry();
    g.setPositions(pts);
    const o = new LineSegments2(g, mat);
    o.renderOrder = order;
    this.scene.add(o);
    return o;
  }

  private updateHoverEdge(): void {
    const h = this.hoverEdge;
    this.hoverEdgeOverlay = this.overlay(this.hoverEdgeOverlay, h ? this.segmentsOf(new Map([[h.body, new Set([h.edge])]])) : [], this.hoverEdgeMaterial, 6);
    this.requestRender();
  }

  private faceVerts(e: BodyEntry): Map<number, Uint32Array> {
    if (e.faceVerts) return e.faceVerts;
    const lists = new Map<number, Set<number>>();
    const { indices, triFace } = e.data;
    for (let t = 0; t < triFace.length; t++) {
      let s = lists.get(triFace[t]);
      if (!s) { s = new Set(); lists.set(triFace[t], s); }
      s.add(indices[3 * t]); s.add(indices[3 * t + 1]); s.add(indices[3 * t + 2]);
    }
    e.faceVerts = new Map([...lists].map(([f, s]) => [f, Uint32Array.from(s)]));
    return e.faceVerts;
  }

  /** Recolour every body from scratch (cheap enough: one pass over the vertex colours). */
  private applyColours(): void {
    const tmp = new Color();
    for (const [b, e] of this.bodies) {
      const attr = e.mesh.geometry.getAttribute('color') as BufferAttribute;
      const col = attr.array as Float32Array;
      const whole = this.highlight.bodies.has(b);
      const ref = this.highlight.refBodies?.has(b);
      const c0 = ref ? tmp.copy(e.base).lerp(this.colRef, 0.55) : whole ? tmp.copy(e.base).lerp(this.colFeature, 0.45)
        : this.hover?.body === b && this.hover.face < 0 ? tmp.copy(e.base).lerp(this.colHover, 0.3) : e.base;
      for (let i = 0; i < col.length; i += 3) { col[i] = c0.r; col[i + 1] = c0.g; col[i + 2] = c0.b; }
      const paint = (face: number, c: Color) => {
        const vs = this.faceVerts(e).get(face);
        if (vs) for (const v of vs) { col[3 * v] = c.r; col[3 * v + 1] = c.g; col[3 * v + 2] = c.b; }
      };
      if (this.hover?.body === b) paint(this.hover.face, new Color().copy(c0).lerp(this.colHover, 0.35));
      for (const f of this.highlight.faces.get(b) ?? []) paint(f, this.colSelected);
      for (const f of this.highlight.refFaces?.get(b) ?? []) paint(f, this.colRef);
      attr.needsUpdate = true;
    }
  }

  private updateEdgeOverlay(): void {
    this.edgeOverlay = this.overlay(this.edgeOverlay, this.segmentsOf(this.highlight.edges), this.edgeMaterial, 5);
    this.refEdgeOverlay = this.overlay(this.refEdgeOverlay, this.highlight.refEdges ? this.segmentsOf(this.highlight.refEdges) : [], this.refEdgeMaterial, 5);
    if (this.hoverEdge) this.updateHoverEdge();
  }

  // ---- section view --------------------------------------------------------------------------

  /** Every body's box (hidden ones too: Orca's model bounding box). */
  private bodiesBox(): Box3 {
    const box = new Box3();
    for (const e of this.bodies.values()) if (e.mesh.geometry.boundingBox) box.union(e.mesh.geometry.boundingBox);
    return box;
  }

  /** The model's mid-height, where Orca's section starts (DesignCanvas::model_mid_z; 0 with no bodies). */
  modelMidZ(): number {
    const box = this.bodiesBox();
    return box.isEmpty() ? 0 : (box.min.z + box.max.z) / 2;
  }

  /**
   * Orca's Design section view (DesignCanvas::set_section_plane): hide everything above `z`, or
   * below it with `upper`; null shows it all. It only hides geometry — no cap, nothing changes.
   */
  setSection(cut: { z: number; upper: boolean } | null): void {
    this.sectionCut = cut;
    this.applySection();
  }

  /** Point Prepare's SectionView (a ratio over the content's sphere) at the absolute height. */
  private applySection(): void {
    const cut = this.sectionCut, box = this.bodiesBox();
    if (!cut || box.isEmpty()) this.section.update(0, null, null);
    else {
      const cz = (box.min.z + box.max.z) / 2, r = Math.max(1e-3, box.getSize(new Vector3()).length() / 2);
      // SectionView cuts away n·p > n·c + r − 2r·ratio: n = +Z keeps what is below z, −Z what is above.
      const ratio = cut.upper ? (r - cz + cut.z) / (2 * r) : (r + cz - cut.z) / (2 * r);
      this.section.update(ratio, new Vector3(0, 0, cut.upper ? -1 : 1), box);
    }
    this.requestRender();
  }

  /** The printer bed (Orca's pinned "Bed" row). */
  setBed(bed: BedShape | null, show: boolean): void {
    if (bed !== this.bedShape) {
      if (this.bedGroup) { this.scene.remove(this.bedGroup); disposeObject3D(this.bedGroup); this.bedGroup = null; }
      this.bedShape = bed;
      if (bed) { this.bedGroup = buildBed(bed, this.theme); this.scene.add(this.bedGroup); }
    }
    if (this.bedGroup) this.bedGroup.visible = show;
    this.requestRender();
  }

  /** Orca's reference planes XY / XZ / YZ at the modeling origin (the pinned "Origin" row). */
  setOrigin(origin: Vec3, show: boolean, size = 60): void {
    if (this.originGroup) { this.scene.remove(this.originGroup); disposeObject3D(this.originGroup); this.originGroup = null; }
    if (!show) { this.requestRender(); return; }
    const g = new Group();
    const plane = (color: Color, rot: (m: Mesh) => void) => {
      const m = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false }));
      rot(m);
      const edge = new LineSegments(new BufferGeometry().setFromPoints([
        new Vector3(-size / 2, -size / 2, 0), new Vector3(size / 2, -size / 2, 0), new Vector3(size / 2, -size / 2, 0), new Vector3(size / 2, size / 2, 0),
        new Vector3(size / 2, size / 2, 0), new Vector3(-size / 2, size / 2, 0), new Vector3(-size / 2, size / 2, 0), new Vector3(-size / 2, -size / 2, 0),
      ]), new LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
      m.add(edge);
      g.add(m);
    };
    plane(this.theme.axisZ, () => {});                                   // XY: normal +Z
    plane(this.theme.axisY, (m) => { m.rotation.x = Math.PI / 2; });    // XZ: normal ±Y
    plane(this.theme.axisX, (m) => { m.rotation.y = Math.PI / 2; });    // YZ: normal +X
    g.position.set(origin[0], origin[1], origin[2]);
    this.originGroup = g;
    this.scene.add(g);
    this.requestRender();
  }

  // ---- picking ----------------------------------------------------------------------------

  pickAt(clientX: number, clientY: number): DesignHit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    setPickRayFromCamera(this.raycaster, new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const meshes = [...this.bodies.values()].filter((e) => !this.hidden.has(e.data.body)).map((e) => e.mesh);
    // What the section view hides can't be clicked: the first hit on the kept part.
    const hit = this.raycaster.intersectObjects(meshes, false).find((h) => !this.section.clips(h.point));
    if (!hit || hit.faceIndex == null) return null;
    const b = hit.object.userData.body as number;
    const e = this.bodies.get(b)!;
    return { body: b, face: e.data.triFace[hit.faceIndex], point: hit.point.clone(), clientX, clientY };
  }

  /** The edge of `body` nearest the cursor on screen, within `maxPx` (null: none). */
  nearestEdge(body: number, clientX: number, clientY: number, maxPx = 10): number | null {
    const e = this.bodies.get(body);
    if (!e) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const d = e.data;
    const a = new Vector3(), b2 = new Vector3();
    const toScreen = (v: Vector3) => { v.project(this.camera); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height, v.z] as const; };
    let best: number | null = null, bestD = maxPx;
    for (let k = 0; k < d.edgeIds.length; k++) {
      for (let p = d.edgeStarts[k]; p + 1 < d.edgeStarts[k + 1]; p++) {
        if (this.section.clips(a.set(d.edgePoints[3 * p], d.edgePoints[3 * p + 1], d.edgePoints[3 * p + 2]))
          && this.section.clips(b2.set(d.edgePoints[3 * p + 3], d.edgePoints[3 * p + 4], d.edgePoints[3 * p + 5]))) continue;
        const [x0, y0, z0] = toScreen(a.set(d.edgePoints[3 * p], d.edgePoints[3 * p + 1], d.edgePoints[3 * p + 2]));
        const [x1, y1, z1] = toScreen(b2.set(d.edgePoints[3 * p + 3], d.edgePoints[3 * p + 4], d.edgePoints[3 * p + 5]));
        if (z0 > 1 || z1 > 1) continue;
        const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
        const dist = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
        if (dist < bestD) { bestD = dist; best = d.edgeIds[k]; }
      }
    }
    return best;
  }

  /** The edge nearest the cursor: on the body under it first, else on any visible body (null: none within `maxPx`). */
  pickEdgeAt(clientX: number, clientY: number, maxPx = 14): { body: number; edge: number } | null {
    const hit = this.pickAt(clientX, clientY);
    if (hit) {
      const e = this.nearestEdge(hit.body, clientX, clientY, maxPx);
      if (e !== null) return { body: hit.body, edge: e };
    }
    for (const b of this.bodies.keys()) {
      if (this.hidden.has(b) || b === hit?.body) continue;
      const e = this.nearestEdge(b, clientX, clientY, hit ? maxPx / 2 : maxPx);
      if (e !== null) return { body: b, edge: e };
    }
    return null;
  }

  /**
   * World-space polylines drawn WITH the depth test, so the model hides them (Orca's mate-connector
   * disc and quadrant, `render_mate_connectors`). `fn` runs before every frame with the camera of
   * that frame, so screen-constant sizes follow it; null removes them.
   */
  setDepthStrokes(fn: (() => DepthStroke[]) | null): void {
    if (this.depthStrokes) { this.scene.remove(this.depthStrokes.obj); this.depthStrokes.obj.geometry.dispose(); this.depthStrokes.obj.material.dispose(); this.depthStrokes = null; }
    if (fn) {
      const obj = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, depthTest: true, depthWrite: false }));
      obj.frustumCulled = false;
      obj.renderOrder = 2;
      this.scene.add(obj);
      this.depthStrokes = { fn, obj };
    }
    this.requestRender();
  }

  private buildDepthStrokes(): void {
    const d = this.depthStrokes!;
    const pos: number[] = [], col: number[] = [];
    const colors = new Map<string, Color>();
    for (const st of d.fn()) {
      let c = colors.get(st.color);
      if (!c) { c = tokenColor(st.color); colors.set(st.color, c); }
      for (let i = 0; i + 1 < st.pts.length; i++) {
        pos.push(...st.pts[i], ...st.pts[i + 1]);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const g = d.obj.geometry;
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
  }

  /** Where a design point is on screen (client px), or null when behind the camera. */
  screenPoint(p: Vec3): [number, number] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new Vector3(p[0], p[1], p[2]).project(this.camera);
    if (v.z > 1) return null;
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  // ---- sketch -------------------------------------------------------------------------------

  /** Route left-button / one-finger input to the sketcher (null: back to picking). */
  setSketchInput(si: SketchInput | null): void {
    this.sketchInput = si;
    this.sketchDown = false;
    // One finger draws while sketching; two fingers still pan and zoom.
    this.orbit.touches = { ONE: si ? (null as unknown as TOUCH) : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
    if (si) this.setHover(null);
    this.requestRender();
  }

  /** Called after every rendered frame (camera moves, resizes): overlays re-project. */
  onView(fn: () => void): () => void { this.viewListeners.add(fn); return () => this.viewListeners.delete(fn); }

  /** Container-relative px of a design point, and its depth (z > 1: behind the camera). */
  project(p: readonly [number, number, number]): [number, number, number] {
    const v = new Vector3(p[0], p[1], p[2]).project(this.camera);
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.renderer.domElement.clientHeight, v.z];
  }

  /** Where the pointer ray meets a plane frame, in the frame's 2D coordinates (null: parallel / behind). */
  planePoint(clientX: number, clientY: number, f: { origin: Vec3; x_axis: Vec3; y_axis: Vec3 }): [number, number] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    setPickRayFromCamera(this.raycaster, new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const o = new Vector3(...f.origin), xa = new Vector3(...f.x_axis), ya = new Vector3(...f.y_axis);
    const n = xa.clone().cross(ya).normalize();
    const ray = this.raycaster.ray;
    const den = ray.direction.dot(n);
    if (Math.abs(den) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / den;
    if (t < 0 && this.camera instanceof PerspectiveCamera) return null;
    const hit = ray.origin.clone().addScaledVector(ray.direction, t).sub(o);
    return [hit.dot(xa), hit.dot(ya)];
  }

  /**
   * Look straight at a sketch plane (Orca: the camera aligns to the plane, N again later), its
   * Y axis up; `box` (world mm) is framed, else 120 mm around the plane origin. The camera before
   * the first call is kept and restored by `endSketchView()`.
   */
  sketchView(f: { origin: Vec3; x_axis: Vec3; y_axis: Vec3 }, box?: Box3 | null): void {
    if (!this.savedCamera) this.savedCamera = { pos: this.camera.position.clone(), target: this.orbit.target.clone(), up: this.camera.up.clone() };
    const xa = new Vector3(...f.x_axis), ya = new Vector3(...f.y_axis);
    const n = xa.clone().cross(ya).normalize();
    this.setUp(ya);
    const b = box && !box.isEmpty() ? box.clone() : new Box3().setFromCenterAndSize(new Vector3(...f.origin), new Vector3(120, 120, 120));
    this.userCamera = true;
    this.fitBox(b, n);
  }

  /** Leave the sketch view: Z up again, the camera as it was before the sketch. */
  endSketchView(): void {
    const s = this.savedCamera;
    this.savedCamera = null;
    this.setUp(new Vector3(0, 0, 1));
    if (s) this.anim = { from: this.camera.position.clone(), to: s.pos, tFrom: this.orbit.target.clone(), tTo: s.target, start: performance.now(), dur: 260 };
    this.requestRender();
  }

  private setUp(up: Vector3): void {
    const u = up.clone().normalize();
    this.projection.perspective.up.copy(u);
    this.projection.orthographic.up.copy(u);
    // OrbitControls caches the up frame at construction; follow the new one.
    const oc = this.orbit as unknown as { _quat?: Quaternion; _quatInverse?: Quaternion };
    if (oc._quat && oc._quatInverse) { oc._quat.setFromUnitVectors(u, new Vector3(0, 1, 0)); oc._quatInverse.copy(oc._quat).invert(); }
    this.viewCube?.update({ rebuild: true });
  }

  // ---- camera -------------------------------------------------------------------------------

  private contentBox(bodies?: readonly number[]): Box3 {
    const box = new Box3();
    for (const [b, e] of this.bodies) {
      if (this.hidden.has(b) || (bodies && !bodies.includes(b))) continue;
      const bb = e.mesh.geometry.boundingBox;
      if (bb) box.union(bb);
    }
    if (box.isEmpty()) {
      const bed = this.bedShape;
      if (bed) box.set(new Vector3(bed.min[0], bed.min[1], 0), new Vector3(bed.max[0], bed.max[1], 20));
      else box.set(new Vector3(-50, -50, 0), new Vector3(50, 50, 20));
    }
    return box;
  }

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

  private fitBox(box: Box3, dir?: Vector3, animate = true): void {
    const sphere = box.getBoundingSphere(new Sphere());
    const pc = this.projection.perspective;
    const fov = (pc.fov * Math.PI) / 180;
    const fovMin = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * pc.aspect));
    const dist = Math.max(sphere.radius, 5) / Math.sin(fovMin / 2) * 1.1;
    const d = (dir ?? this.camera.position.clone().sub(this.orbit.target).normalize()).clone();
    const to = sphere.center.clone().addScaledVector(d, dist);
    const cam = this.camera;
    const zoom = cam instanceof OrthographicCamera ? this.projection.fitZoom(Math.max(sphere.radius, 5)) : undefined;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      this.anim = null;
      cam.position.copy(to);
      this.orbit.target.copy(sphere.center);
      if (zoom !== undefined) { cam.zoom = zoom; cam.updateProjectionMatrix(); }
    } else {
      this.anim = { from: cam.position.clone(), to, tFrom: this.orbit.target.clone(), tTo: sphere.center.clone(), start: performance.now(), dur: 260, ...(zoom !== undefined ? { zFrom: cam.zoom, zTo: zoom } : {}) };
    }
    this.requestRender();
  }

  /** Frame every visible body (Orca's Home = iso + fit). */
  fitAll(animate = true): void { this.fitBox(this.contentBox(), animate ? undefined : this.viewDir('iso'), animate); }
  fitBodies(bodies: readonly number[]): void { this.fitBox(this.contentBox(bodies)); }
  setView(p: ViewPreset): void { this.userCamera = true; this.fitBox(this.contentBox(), this.viewDir(p)); }

  zoom(dir: 1 | -1): void {
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const next = Math.min(20000, Math.max(2, offset.length() * (dir > 0 ? 0.8 : 1.25)));
    const to = this.orbit.target.clone().addScaledVector(offset.normalize(), next);
    const t = this.orbit.target.clone();
    this.anim = { from: this.camera.position.clone(), to, tFrom: t, tTo: t.clone(), start: performance.now(), dur: 160 };
    this.requestRender();
  }
}
