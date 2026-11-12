/**
 * Orca 2.5 view options for the Prepare scene:
 *
 * - X-Ray (GLCanvas3D::_render_xray_volumes + xray.fs): every surface a thin
 *   translucent layer of its own colour, denser the more edge-on it is seen,
 *   both faces drawn, no depth writes.
 * - Section view (GLCanvas3D::_get_section_view_plane / _render_section_view_caps):
 *   a plane facing the camera it was aimed from sweeps the objects' bounding
 *   sphere from the camera side (ratio 0) to the far side (1) and cuts away
 *   everything in front of it; the cut faces are capped in dark grey.
 * - Center of mass markers (GLCanvas3D::CenterOfMass::render): two-tone balls
 *   of constant screen size, seen through the objects.
 */
import {
  BackSide, Box3, Color, DecrementWrapStencilOp, DoubleSide, FrontSide, Group, IncrementWrapStencilOp, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, NotEqualStencilFunc, Plane, PlaneGeometry, SphereGeometry, Vector3, AlwaysStencilFunc, ReplaceStencilOp,
  BufferGeometry, Float32BufferAttribute, SRGBColorSpace, type Camera, type Material, type MeshStandardMaterial,
} from 'three';
import { MARKER_RADII, centerOf, type MassMarker } from './massProps';

// ---- X-Ray -----------------------------------------------------------------------------------

/** Shared by every object material: 1 while X-Ray is on. */
export const XRAY = { value: 0 };

/** Desktop's xray.fs constants. */
const EDGE_FALLOFF = '2.0', FACE_DENSITY = '0.12', EDGE_DENSITY = '0.65';

/** Teach a (flat-shaded) MeshStandardMaterial the X-Ray look, switched by XRAY. */
export function installXray(mat: MeshStandardMaterial): void {
  if (mat.userData.xray) return;
  mat.userData.xray = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uXray = XRAY;
    shader.fragmentShader = `uniform float uXray;\n${shader.fragmentShader}`.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if (uXray > 0.5) {
    vec3 xn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    float facing = abs(dot(xn, normalize(vViewPosition)));
    float density = mix(${EDGE_DENSITY}, ${FACE_DENSITY}, pow(facing, ${EDGE_FALLOFF}));
    gl_FragColor = vec4(diffuseColor.rgb + totalEmissiveRadiance, density * opacity);
  }`);
  };
  mat.customProgramCacheKey = () => 'cubby-xray';
}

/** The render state X-Ray needs on top of the material's own (transparent, both faces, no depth writes). */
export function applyXrayState(mat: MeshStandardMaterial, on: boolean, base: { transparent: boolean; depthWrite: boolean; side?: typeof FrontSide | typeof DoubleSide }): void {
  const transparent = on || base.transparent;
  if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
  mat.depthWrite = on ? false : base.depthWrite;
  mat.side = on ? DoubleSide : base.side ?? FrontSide;
}

// ---- section view ----------------------------------------------------------------------------

/** No clipping (desktop's ClipsNothing): far beyond any bed. */
const CLIPS_NOTHING = 1e9;

export class SectionView {
  /** Shared by every clipped material; three keeps points where normal·p + constant ≥ 0. */
  readonly plane = new Plane(new Vector3(0, 0, -1), CLIPS_NOTHING);
  readonly planes = [this.plane];
  readonly caps = new Group();
  private active = false;
  private readonly stencilBack: MeshBasicMaterial;
  private readonly stencilFront: MeshBasicMaterial;
  private readonly cap: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly stencilMeshes = new Map<Mesh, Mesh[]>();

  constructor() {
    const stencil = (side: typeof BackSide | typeof FrontSide, op: typeof IncrementWrapStencilOp | typeof DecrementWrapStencilOp) => new MeshBasicMaterial({
      depthWrite: false, depthTest: false, colorWrite: false, side, clippingPlanes: this.planes,
      stencilWrite: true, stencilFunc: AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
    });
    this.stencilBack = stencil(BackSide, IncrementWrapStencilOp);
    this.stencilFront = stencil(FrontSide, DecrementWrapStencilOp);
    // Desktop's cut colour (render_cut({0.25, 0.25, 0.25, 1})).
    this.cap = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      color: new Color().setRGB(0.25, 0.25, 0.25, SRGBColorSpace), stencilWrite: true, stencilRef: 0, stencilFunc: NotEqualStencilFunc,
      stencilFail: ReplaceStencilOp, stencilZFail: ReplaceStencilOp, stencilZPass: ReplaceStencilOp, side: DoubleSide,
    }));
    this.cap.renderOrder = -1;
    this.cap.visible = false;
    this.cap.raycast = () => {};
    this.caps.add(this.cap);
    this.caps.name = 'section-view';
  }

  get isActive(): boolean { return this.active; }

  /**
   * Place the plane: `normal` faces the camera it was aimed from, `ratio` 0..1 sweeps
   * the bounding sphere of `box` from that side; 0 (or no box) switches the cut off.
   */
  update(ratio: number, normal: Vector3 | null, box: Box3 | null): void {
    this.active = ratio > 0 && !!normal && !!box && !box.isEmpty();
    if (!this.active) {
      this.plane.set(new Vector3(0, 0, -1), CLIPS_NOTHING);
      this.cap.visible = false;
      return;
    }
    const c = box!.getCenter(new Vector3());
    const r = box!.getSize(new Vector3()).length() / 2;
    const n = normal!.clone().normalize();
    // Clipped where n·p > n·c + r − 2r·ratio.
    const offset = n.dot(c) + r - 2 * r * ratio;
    this.plane.set(n.clone().negate(), offset);
    // The cap: a square on the plane, big enough to cover the cut.
    this.cap.visible = true;
    this.cap.position.copy(c).addScaledVector(n, offset - n.dot(c));
    this.cap.lookAt(this.cap.position.clone().add(n));
    this.cap.scale.setScalar(4 * r + 10);
  }

  /** Stencil writers for the cap under `mesh` (its geometry, its transform); idempotent. */
  attach(mesh: Mesh): void {
    if (this.stencilMeshes.has(mesh)) return;
    const pair = [new Mesh(mesh.geometry, this.stencilBack), new Mesh(mesh.geometry, this.stencilFront)];
    for (const m of pair) { m.renderOrder = -2; m.raycast = () => {}; m.userData.sectionStencil = true; mesh.add(m); }
    this.stencilMeshes.set(mesh, pair);
  }

  detach(mesh: Mesh): void {
    const pair = this.stencilMeshes.get(mesh);
    if (!pair) return;
    for (const m of pair) mesh.remove(m);
    this.stencilMeshes.delete(mesh);
  }

  /** Keep stencil writers on exactly `meshes` (none while the cut is off). */
  syncMeshes(meshes: Iterable<Mesh>): void {
    const want = new Set(this.active ? meshes : []);
    for (const m of [...this.stencilMeshes.keys()]) if (!want.has(m)) this.detach(m);
    for (const m of want) this.attach(m);
  }

  /** Desktop's ClippingPlane::is_point_clipped. */
  clips(p: Vector3): boolean { return this.active && this.plane.distanceToPoint(p) < 0; }

  dispose(): void {
    this.syncMeshes([]);
    this.stencilBack.dispose();
    this.stencilFront.dispose();
    this.cap.geometry.dispose();
    this.cap.material.dispose();
  }
}

/** Clip a material by the section plane (always the same array: no recompiles when it moves). */
export function clipBy(mat: Material, sv: SectionView): void {
  if (mat.clippingPlanes !== sv.planes) { mat.clippingPlanes = sv.planes; mat.needsUpdate = true; }
}

// ---- center of mass markers ------------------------------------------------------------------

/** Desktop's colours per kind: [octants with x·y·z > 0, the others]. */
const rgb = (r: number, g: number, b: number) => new Color().setRGB(r, g, b, SRGBColorSpace);
const MARKER_COLOURS: Record<MassMarker['kind'], [Color, Color]> = {
  plate: [rgb(0.1, 0.1, 0.1), rgb(1, 1, 1)],
  object: [rgb(0x5a / 255, 0x9b / 255, 0xd4 / 255), rgb(1, 1, 1)],
  support: [rgb(0, 0.6, 0), rgb(0.1, 0.1, 0.1)],
  body: [rgb(0.7, 0, 0), rgb(1, 1, 0)],
};

/** A unit sphere split into the octants where x·y·z > 0 and the others (desktop's m_octants). */
function octantGeometries(): [BufferGeometry, BufferGeometry] {
  const s = new SphereGeometry(1, 32, 32).toNonIndexed();
  const pos = s.getAttribute('position'), nor = s.getAttribute('normal');
  const out: [number[], number[]][] = [[[], []], [[], []]];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(i + k); cy += pos.getY(i + k); cz += pos.getZ(i + k); }
    const o = out[cx * cy * cz > 0 ? 0 : 1];
    for (let k = 0; k < 3; k++) {
      o[0].push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      o[1].push(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k));
    }
  }
  s.dispose();
  return out.map(([p, n]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new Float32BufferAttribute(n, 3));
    return g;
  }) as [BufferGeometry, BufferGeometry];
}

export class MassMarkerLayer {
  readonly group = new Group();
  private markers: MassMarker[] = [];
  private balls: Group[] = [];
  private geos: [BufferGeometry, BufferGeometry] | null = null;
  private mats = new Map<string, MeshLambertMaterial>();

  constructor() { this.group.name = 'center-of-mass'; }

  set(markers: MassMarker[]): void {
    this.markers = markers;
    for (const b of this.balls) this.group.remove(b);
    this.balls = [];
    if (!markers.length) return;
    this.geos ??= octantGeometries();
    for (const m of markers) {
      const g = new Group();
      const alpha = m.alpha ?? 1;
      MARKER_COLOURS[m.kind].forEach((c, i) => {
        const key = `${m.kind}${i}${alpha}`;
        let mat = this.mats.get(key);
        if (!mat) { mat = new MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.1, depthTest: false, depthWrite: false, transparent: true, opacity: alpha }); this.mats.set(key, mat); }
        const mesh = new Mesh(this.geos![i], mat);
        mesh.raycast = () => {};
        // Preview: what is printed so far over the finished print, then the smaller kinds over the larger.
        mesh.renderOrder = 20 + 4 * (m.stage ?? 0) + (['plate', 'object', 'support', 'body'].indexOf(m.kind));
        g.add(mesh);
      });
      g.position.fromArray(centerOf(m.sum));
      this.balls.push(g);
      this.group.add(g);
    }
  }

  /** Keep the balls at their on-screen radius; hide the ones the section view cuts away. */
  update(worldPerPixel: (p: Vector3) => number, clipped: (p: Vector3) => boolean): void {
    this.balls.forEach((b, i) => {
      b.visible = !clipped(b.position);
      b.scale.setScalar(MARKER_RADII[this.markers[i].kind] * worldPerPixel(b.position));
    });
  }

  /**
   * The marker under a screen point (CenterOfMass::on_left_down: smaller kinds over larger
   * ones), from screen positions + radii in px.
   */
  pick(project: (p: Vector3) => { x: number; y: number }, x: number, y: number): number | null {
    for (const stage of [1, 0]) {
      for (const kind of ['body', 'support', 'object', 'plate'] as const) {
        for (let i = 0; i < this.markers.length; i++) {
          if (this.markers[i].kind !== kind || (this.markers[i].stage ?? 0) !== stage || !this.balls[i]?.visible) continue;
          const s = project(this.balls[i].position);
          if (Math.hypot(s.x - x, s.y - y) <= MARKER_RADII[kind]) return i;
        }
      }
    }
    return null;
  }

  marker(i: number): MassMarker | undefined { return this.markers[i]; }
  position(i: number): Vector3 | undefined { return this.balls[i]?.position; }
  get count(): number { return this.balls.length; }

  dispose(): void {
    this.set([]);
    this.geos?.forEach((g) => g.dispose());
    for (const m of this.mats.values()) m.dispose();
  }
}

export type { Camera };
