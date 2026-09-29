/**
 * Three.js G-code preview renderer: owns the WebGL renderer, camera,
 * OrbitControls, bed, chunked extrusion buffers and the tool-head marker.
 *
 * Renders on demand (only when something changed or the camera is damping).
 * GPU buffers for a new result are built incrementally, a time-budgeted
 * number of chunks per frame, so a multi-million-segment print never blocks
 * the UI thread for long. WebGL context loss is handled: rendering pauses and
 * everything re-uploads from the kept CPU arrays when the context returns.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BedShape } from '../../app/state';
import type { ParsedGcode } from '../parser/types';
import { parsedByteSize } from '../parser/types';
import { FEATURES } from '../parser/features';
import { buildBed, disposeObject, readBedColors } from './bed';
import { GcodeChunks, createSharedUniforms, DEFAULT_CHUNK_SIZE } from './chunks';
import type { SharedUniforms } from './chunks';
import { RAMP, schemeMeta, schemeRange } from './colors';
import type { ColorScheme, ValueRange } from './colors';

export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export interface RendererCallbacks {
  /** Chunk build progress (0..1). */
  onBuildProgress?(fraction: number): void;
  onContextLost?(lost: boolean): void;
}

export interface MemoryStats { cpuBytes: number; gpuBytes: number; chunks: number }

const setLin = (c: THREE.Color, hex: number) => c.setHex(hex, THREE.LinearSRGBColorSpace);

export class PreviewRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private uniforms: SharedUniforms = createSharedUniforms();
  private bedGroup: THREE.Group | null = null;
  private bed: BedShape | null = null;
  private chunks: GcodeChunks | null = null;
  private data: ParsedGcode | null = null;
  private toolhead: THREE.Group;
  private raf = 0;
  private buildRaf = 0;
  private dirty = true;
  private disposed = false;
  private contextLost = false;
  private ro: ResizeObserver;
  private travelOn = false;
  private markersOn = false;
  private scheme: ColorScheme = 'feature';
  private range: ValueRange = { min: 0, max: 1 };
  private buildResolve: (() => void) | null = null;

  constructor(private host: HTMLElement, private cb: RendererCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const bg = getComputedStyle(host).getPropertyValue('--bg-0').trim() || '#0d0f12';
    this.renderer.setClearColor(new THREE.Color(bg), 1);
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.outline = 'none';
    canvas.tabIndex = -1;
    host.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(110, -200, 180);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2));
    this.toolhead = makeToolhead(getComputedStyle(host).getPropertyValue('--accent').trim() || '#19c37d');
    this.toolhead.visible = false;
    this.scene.add(this.toolhead);

    // Feature palette + ramp (linear-space values = raw sRGB hex, shader outputs as-is).
    for (const f of FEATURES) setLin(this.uniforms.uFeatColor.value[f.id], f.color);
    RAMP.forEach((hex, i) => setLin(this.uniforms.uRamp.value[i], hex));

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  // ---- lifecycle ----------------------------------------------------------

  private onLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    this.cb.onContextLost?.(true);
  };

  private onRestored = () => {
    this.contextLost = false;
    this.cb.onContextLost?.(false);
    this.requestRender();
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.buildRaf);
    this.ro.disconnect();
    this.controls.dispose();
    this.clearData();
    if (this.bedGroup) { disposeObject(this.bedGroup); this.bedGroup = null; }
    disposeObject(this.toolhead);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const v = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(v);
    this.uniforms.uViewport.value.copy(v);
    this.uniforms.uPointPx.value = 7 * this.renderer.getPixelRatio();
    this.uniforms.uMinPx.value = 0.55 * this.renderer.getPixelRatio();
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (this.disposed) return;
    const moving = this.controls.update();
    if (this.dirty || moving) {
      this.dirty = false;
      if (!this.contextLost) this.renderNow();
    }
    if (moving) this.requestRender();
  };

  private renderNow(): void {
    // Keep depth precision reasonable for close-ups and whole-bed views.
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.02, d * 0.004);
    const far = Math.max(2000, d * 40);
    if (Math.abs(this.camera.near - near) > near * 0.05 || this.camera.far !== far) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.uniforms.uNear.value = this.camera.near;
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.afterRender) fn();
  }

  private afterRender = new Set<() => void>();
  /** Run `fn` after every scene render (overlays such as the view cube draw here). */
  addAfterRender(fn: () => void): () => void {
    this.afterRender.add(fn);
    this.requestRender();
    return () => { this.afterRender.delete(fn); this.requestRender(); };
  }

  // ---- content ---------------------------------------------------------------

  setBed(bed: BedShape): void {
    this.bed = bed;
    if (this.bedGroup) { this.scene.remove(this.bedGroup); disposeObject(this.bedGroup); }
    this.bedGroup = buildBed(bed, readBedColors(this.host));
    this.scene.add(this.bedGroup);
    if (!this.data) this.fit();
    this.requestRender();
  }

  private clearData(): void {
    cancelAnimationFrame(this.buildRaf);
    this.buildRaf = 0;
    if (this.chunks) {
      this.scene.remove(this.chunks.group);
      this.chunks.dispose();
      this.chunks = null;
    }
    this.data = null;
    this.buildResolve?.();
    this.buildResolve = null;
  }

  /**
   * Replace the displayed G-code. Resolves when all chunks are on the GPU
   * (chunks appear progressively before that).
   */
  setData(data: ParsedGcode | null, chunkSize = DEFAULT_CHUNK_SIZE): Promise<void> {
    this.clearData();
    this.toolhead.visible = false;
    if (!data) { this.requestRender(); return Promise.resolve(); }
    this.data = data;
    const chunks = new GcodeChunks(data, this.uniforms, chunkSize);
    this.chunks = chunks;
    chunks.setScheme(this.scheme, schemeMeta(this.scheme).numeric);
    if (schemeMeta(this.scheme).numeric) this.updateRange();
    chunks.setTravelVisible(this.travelOn);
    chunks.setMarkersVisible(this.markersOn);
    chunks.setRange(this.uniforms.uRangeMin.value, this.uniforms.uRangeMax.value);
    this.scene.add(chunks.group);
    return new Promise<void>((resolve) => {
      this.buildResolve = resolve;
      const step = () => {
        this.buildRaf = 0;
        if (this.chunks !== chunks) return;
        const t0 = performance.now();
        let more = true;
        // ≥1 chunk per frame, more while under ~10 ms.
        do { more = chunks.buildNext(); } while (more && performance.now() - t0 < 10);
        this.cb.onBuildProgress?.(chunks.builtChunks / Math.max(1, chunks.totalChunks));
        this.requestRender();
        if (more) this.buildRaf = requestAnimationFrame(step);
        else {
          this.buildResolve = null;
          if (import.meta.env.DEV) {
            const m = this.memoryStats();
            console.debug(`[preview] ${data.segmentCount.toLocaleString()} segments in ${m.chunks} chunks — CPU ≈ ${(m.cpuBytes / 1048576).toFixed(1)} MiB, GPU ≈ ${(m.gpuBytes / 1048576).toFixed(1)} MiB`);
          }
          resolve();
        }
      };
      if (data.segmentCount === 0) { this.buildResolve = null; resolve(); return; }
      this.buildRaf = requestAnimationFrame(step);
    });
  }

  /** Dev/bench: render synchronously and wait for the GPU (readPixels); returns ms. */
  benchFrame(): number {
    const t0 = performance.now();
    this.renderNow();
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
  }

  memoryStats(): MemoryStats {
    return {
      cpuBytes: this.data ? parsedByteSize(this.data) : 0,
      gpuBytes: this.chunks?.gpuBytes() ?? 0,
      chunks: this.chunks?.builtChunks ?? 0,
    };
  }

  // ---- display state -----------------------------------------------------

  /** Inclusive global segment range to show; `topStart` = first segment of the top layer. */
  setRange(min: number, max: number, topStart = min): void {
    this.uniforms.uRangeMin.value = min;
    this.uniforms.uRangeMax.value = max;
    this.uniforms.uTopStart.value = topStart;
    this.chunks?.setRange(min, max);
    this.requestRender();
  }

  /** Darken everything below the top layer (0 = off, 0.6 = strong). */
  setDimBelow(amount: number): void {
    this.uniforms.uDimBelow.value = amount;
    this.requestRender();
  }

  setFeatureVisibility(visible: readonly boolean[]): void {
    const a = this.uniforms.uFeatVis.value;
    for (let i = 0; i < a.length; i++) a[i] = visible[i] === false ? 0 : 1;
    this.requestRender();
  }

  setToolColors(colors: readonly number[]): void {
    colors.slice(0, 16).forEach((c, i) => setLin(this.uniforms.uToolColor.value[i], c));
    this.requestRender();
  }

  /** Switch colour scheme; returns the numeric range (for the legend). */
  setScheme(scheme: ColorScheme): ValueRange {
    this.scheme = scheme;
    const meta = schemeMeta(scheme);
    this.uniforms.uScheme.value = scheme === 'feature' ? 0 : scheme === 'tool' ? 1 : 2;
    if (meta.numeric) this.updateRange();
    this.chunks?.setScheme(scheme, meta.numeric);
    this.requestRender();
    return this.range;
  }

  private updateRange(): void {
    this.range = this.data ? schemeRange(this.data, this.scheme) : { min: 0, max: 1 };
    let { min, max } = this.range;
    if (max - min < 1e-6) { min -= 0.5; max += 0.5; }
    this.uniforms.uVMin.value = min;
    this.uniforms.uVMax.value = max;
  }

  setTravelVisible(on: boolean): void {
    this.travelOn = on;
    this.chunks?.setTravelVisible(on);
    this.requestRender();
  }

  /** Marker visibility: retract, unretract (deretract) and seams. */
  setMarkers(retracts: boolean, seams: boolean, unretracts = retracts): void {
    const v = this.uniforms.uKindVis.value;
    v[0] = retracts ? 1 : 0; v[1] = unretracts ? 1 : 0; v[2] = seams ? 1 : 0;
    this.markersOn = retracts || unretracts || seams;
    this.chunks?.setMarkersVisible(this.markersOn);
    this.requestRender();
  }

  private toolheadEnabled = true;
  private toolheadSeg = -1;

  /** Orca "Tool marker" option. */
  setToolheadEnabled(on: boolean): void {
    this.toolheadEnabled = on;
    this.setToolhead(this.toolheadSeg);
  }

  /** Put the tool-head marker at the end of segment `seg` (-1 hides it). */
  setToolhead(seg: number): void {
    const d = this.data;
    this.toolheadSeg = seg;
    if (!d || seg < 0 || seg >= d.segmentCount || !this.toolheadEnabled) { this.toolhead.visible = false; this.requestRender(); return; }
    const i = (seg + 1) * 3;
    this.toolhead.position.set(d.points[i], d.points[i + 1], d.points[i + 2]);
    this.toolhead.visible = true;
    this.requestRender();
  }

  // ---- camera ----------------------------------------------------------------

  private bounds(): THREE.Box3 {
    const d = this.data;
    if (d && d.stats.extrusionCount > 0) {
      return new THREE.Box3(new THREE.Vector3(...d.stats.min), new THREE.Vector3(...d.stats.max));
    }
    const b = this.bed;
    if (b) return new THREE.Box3(new THREE.Vector3(b.min[0], b.min[1], 0), new THREE.Vector3(b.max[0], b.max[1], 10));
    return new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(220, 220, 10));
  }

  private lastPreset: ViewPreset = 'iso';

  view(preset: ViewPreset, box = this.bounds()): void {
    this.lastPreset = preset;
    const dirs: Record<ViewPreset, [number, number, number]> = {
      iso: [0.55, -1, 0.85],
      top: [0, -0.0001, 1],
      bottom: [0, 0.0001, -1],
      front: [0, -1, 0.0001],
      back: [0, 1, 0.0001],
      left: [-1, 0, 0.0001],
      right: [1, 0, 0.0001],
    };
    const dir = new THREE.Vector3(...dirs[preset]).normalize();
    const center = box.getCenter(new THREE.Vector3());
    // Tight fit: distance along `dir` so every box corner is inside the frustum.
    const fwd = dir.clone().negate();
    const upHint = Math.abs(fwd.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(fwd, upHint).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanX = tanY * this.camera.aspect;
    let dist = 10;
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const z = c.dot(fwd); // + = beyond centre
      dist = Math.max(dist, -z + Math.abs(c.dot(right)) / tanX, -z + Math.abs(c.dot(up)) / tanY);
    }
    dist *= 1.12;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Frame the print (or the bed when empty) keeping the current view direction preset. */
  fit(): void { this.view(this.lastPreset); }
}

function makeToolhead(color: string): THREE.Group {
  const g = new THREE.Group();
  g.name = 'toolhead';
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(1.2, 4, 20),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5, transparent: true, opacity: 0.85 }),
  );
  cone.rotation.x = -Math.PI / 2; // tip down (−Z)
  cone.position.z = 2.2;
  g.add(cone);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 0.9, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  ring.renderOrder = 10;
  g.add(ring);
  return g;
}
