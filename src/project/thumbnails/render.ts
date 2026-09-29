/**
 * Offscreen plate thumbnails the way OrcaSlicer renders them
 * (GLCanvas3D::render_thumbnail_internal + the "thumbnail" / "flat" shaders):
 *
 *  - iso: Camera::set_default_orientation (zenith 45°, azimuth 45°, from the
 *    front-left), orthographic, zoomed to the printable volumes' box
 *    (+1% x/y, +2% z, margin 1.025);
 *  - top: straight down on the plate's build volume, zoomed to fit the plate;
 *  - lighting: Orca's two directional lights in camera space (top + front,
 *    ambient 0.3, emission 0.1, top specular), transparent background;
 *  - 'flat' is Orca's ban_light pass (plate_no_light_N.png: flat colour,
 *    alpha = 255 - (extruder - 1)), 'pick' its picking pass (pick_N.png: flat
 *    colour encoding the instance's identify_id, no multisampling).
 *
 * One small WebGL renderer is created on first use and kept; each render goes
 * into a render target that is read back.
 */
import {
  BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Mesh, OrthographicCamera, Scene, ShaderMaterial, Vector3, Vector4,
  WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { RgbaImage } from './encode';

export interface ThumbVolume {
  positions: Float32Array;
  indices: Uint32Array;
  /** Column-major 4x4 mesh-local → bed transform (mm, Z up). */
  transform: number[];
  /** #RRGGBB filament colour. */
  color: string;
  /** 1-based extruder (no-light alpha). */
  extruder: number;
  /** identify_id for the pick image. */
  pickId: number;
  /** Colour-painted facets (engine sub-meshes in the same mesh-local frame). */
  paint?: Array<{ positions: Float32Array; indices: Uint32Array; color: string; extruder: number }>;
}

export interface ThumbScene {
  volumes: ThumbVolume[];
  /** The plate's build volume in bed coordinates (top view framing). */
  plate: { min: [number, number, number]; max: [number, number, number] };
}

export type ThumbView = 'iso' | 'top';
export type ThumbMode = 'lit' | 'flat' | 'pick';

const VERT = /* glsl */ `
varying vec3 vViewPos;
varying float vWorldZ;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldZ = world.z;
  vec4 view = viewMatrix * world;
  vViewPos = view.xyz;
  gl_Position = projectionMatrix * view;
}`;

// Orca resources/shaders/140/thumbnail.{vs,fs}. Face normals from screen-space
// derivatives: Orca's GLModel carries per-face normals, so the result is the same
// (and independent of triangle winding / mirrored transforms).
const FRAG = /* glsl */ `
#define INTENSITY_CORRECTION 0.6
const vec3 LIGHT_TOP_DIR = vec3(-0.4574957, 0.4574957, 0.7624929);
#define LIGHT_TOP_DIFFUSE (0.8 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SPECULAR (0.125 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SHININESS 20.0
const vec3 LIGHT_FRONT_DIR = vec3(0.6985074, 0.1397015, 0.6985074);
#define LIGHT_FRONT_DIFFUSE (0.3 * INTENSITY_CORRECTION)
#define INTENSITY_AMBIENT 0.3
uniform vec4 uColor;
uniform bool uFlat;
varying vec3 vViewPos;
varying float vWorldZ;
void main() {
  if (vWorldZ < 0.0) discard;
  if (uFlat) { gl_FragColor = uColor; return; }
  vec3 normal = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  float NdotL = max(dot(normal, LIGHT_TOP_DIR), 0.0);
  float diffuse = INTENSITY_AMBIENT + NdotL * LIGHT_TOP_DIFFUSE;
  float specular = LIGHT_TOP_SPECULAR * pow(max(dot(-normalize(vViewPos), reflect(-LIGHT_TOP_DIR, normal)), 0.0), LIGHT_TOP_SHININESS);
  diffuse += max(dot(normal, LIGHT_FRONT_DIR), 0.0) * LIGHT_FRONT_DIFFUSE;
  gl_FragColor = vec4(vec3(specular) + uColor.rgb * (diffuse + 0.1), uColor.a);
}`;

let renderer: WebGLRenderer | null = null;
let unavailable = false;

function getRenderer(): WebGLRenderer | null {
  if (renderer || unavailable) return renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    canvas.addEventListener('webglcontextlost', () => { renderer?.dispose(); renderer = null; });
  } catch {
    unavailable = true;
    renderer = null;
  }
  return renderer;
}

/** '#RRGGBB' → linear 0..1 floats as Orca uses them (no colour management). */
function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x888888;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** adjust_color_for_rendering(): near-black filaments are lifted to 0.2 grey. */
function adjust([r, g, b]: [number, number, number]): [number, number, number] {
  const T = 0.2;
  return r < T && g < T && b < T ? [T, T, T] : [r, g, b];
}

function material(color: Vector4, flat: boolean, overlay: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uColor: { value: color }, uFlat: { value: flat } },
    side: DoubleSide,
    polygonOffset: true, polygonOffsetFactor: overlay ? -2 : 1, polygonOffsetUnits: overlay ? -2 : 1,
  });
}

/** Geometry is uploaded once per prepared scene and shared by its renders. */
export interface PreparedThumbScene {
  scene: ThumbScene;
  render(width: number, height: number, view: ThumbView, mode: ThumbMode): RgbaImage | null;
  dispose(): void;
}

export function prepareThumbScene(scene: ThumbScene): PreparedThumbScene {
  const geos: BufferGeometry[] = [];
  const mk = (positions: Float32Array, indices: Uint32Array) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setIndex(new BufferAttribute(indices, 1));
    geos.push(g);
    return g;
  };
  const vols = scene.volumes.map((v) => {
    const m = new Matrix4().fromArray(v.transform);
    return { v, m, geo: mk(v.positions, v.indices), paint: (v.paint ?? []).map((p) => ({ p, geo: mk(p.positions, p.indices) })) };
  });

  // volumes_box: union of GLVolume::transformed_bounding_box() — each volume's
  // local box with its corners transformed (looser than the mesh for rotated parts).
  const bmin = new Vector3(Infinity, Infinity, Infinity), bmax = new Vector3(-Infinity, -Infinity, -Infinity);
  const tmp = new Vector3();
  for (const { v, m } of vols) {
    const p = v.positions;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) { const c = p[i + k]; if (c < lo[k]) lo[k] = c; if (c > hi[k]) hi[k] = c; }
    }
    if (!(lo[0] <= hi[0])) continue;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
      tmp.set(x, y, z).applyMatrix4(m);
      bmin.min(tmp); bmax.max(tmp);
    }
  }

  function render(width: number, height: number, view: ThumbView, mode: ThumbMode): RgbaImage | null {
    const r = getRenderer();
    if (!r || !vols.length || !Number.isFinite(bmin.x)) return null;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const s = new Scene();
    const mats: ShaderMaterial[] = [];
    const flat = mode !== 'lit';
    for (const { v, m, geo, paint } of vols) {
      let c: Vector4;
      if (mode === 'pick') {
        const id = v.pickId >>> 0;
        c = new Vector4((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, 1);
      } else {
        const [cr, cg, cb] = adjust(rgb(v.color));
        c = new Vector4(cr, cg, cb, mode === 'flat' ? (255 - (v.extruder - 1)) / 255 : 1);
      }
      const mat = material(c, flat, false);
      mats.push(mat);
      const mesh = new Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      s.add(mesh);
      if (mode === 'pick') continue;
      for (const { p, geo: pg } of paint) {
        const [pr, pgc, pb] = adjust(rgb(p.color));
        const pm = material(new Vector4(pr, pgc, pb, mode === 'flat' ? (255 - (p.extruder - 1)) / 255 : 1), flat, true);
        mats.push(pm);
        const pmesh = new Mesh(pg, pm);
        pmesh.matrixAutoUpdate = false;
        pmesh.matrix.copy(m);
        pmesh.renderOrder = 1;
        s.add(pmesh);
      }
    }
    s.updateMatrixWorld(true);

    const cam = new OrthographicCamera();
    if (view === 'iso') {
      // volumes_box, grown like Orca's (1% each side in x/y, 2% in z; min z = -eps).
      const lo = bmin.clone(), hi = bmax.clone();
      lo.z = -1e-4;
      const dx = hi.x - lo.x, dy = hi.y - lo.y, dz = hi.z - lo.z;
      lo.x -= dx * 0.01; hi.x += dx * 0.01; lo.y -= dy * 0.01; hi.y += dy * 0.01; lo.z -= dz * 0.02; hi.z += dz * 0.02;
      const center = lo.clone().add(hi).multiplyScalar(0.5);
      const back = new Vector3(-0.5, -0.5, Math.SQRT1_2); // camera side of the target
      const right = new Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0);
      const up = new Vector3().crossVectors(back, right).normalize();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) {
        tmp.set(x - center.x, y - center.y, z - center.z);
        const px = tmp.dot(right), py = tmp.dot(up);
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const ex = (maxX - minX) * 1.025, ey = (maxY - minY) * 1.025;
      if (!(ex > 0) || !(ey > 0)) return null;
      const zoom = Math.min(w / ex, h / ey);
      const diag = hi.distanceTo(lo);
      const dist = Math.max(1000, diag * 2); // Camera::DefaultDistance
      cam.position.copy(center).addScaledVector(back, dist);
      cam.up.copy(up);
      cam.lookAt(center);
      setFrustum(cam, w / (2 * zoom), h / (2 * zoom), dist - diag - 1, dist + diag + 1);
    } else {
      const { min, max } = scene.plate;
      const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
      const dist = Math.max(max[2] - min[2], bmax.z + 1, 1);
      const zoom = Math.min(w / (max[0] - min[0]), h / (max[1] - min[1]));
      cam.position.set(cx, cy, dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(cx, cy, 0);
      setFrustum(cam, w / (2 * zoom), h / (2 * zoom), 0.01, dist + Math.max(1, -bmin.z) + 1);
    }

    const samples = mode === 'pick' ? 0 : 4;
    const rt = new WebGLRenderTarget(w, h, { samples, depthBuffer: true });
    try {
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(s, cam);
      r.setRenderTarget(null);
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      // GL rows are bottom-up: flip to image order.
      const pixels = new Uint8Array(w * h * 4);
      const row = w * 4;
      for (let y = 0; y < h; y++) pixels.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      return { width: w, height: h, pixels };
    } finally {
      rt.dispose();
      for (const m of mats) m.dispose();
    }
  }

  return {
    scene,
    render,
    dispose() { for (const g of geos) g.dispose(); },
  };
}

function setFrustum(cam: OrthographicCamera, hw: number, hh: number, near: number, far: number): void {
  cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
  cam.near = Math.max(0.01, near); cam.far = Math.max(cam.near + 1, far);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

/** Box-average downscale (bbs_3mf.cpp plate_N_small.png: integer steps, top-left aligned). */
export function downscale(img: RgbaImage, w: number, h: number): RgbaImage {
  const sw = Math.max(1, Math.floor(img.width / w)), sh = Math.max(1, Math.floor(img.height / h));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const acc = [0, 0, 0, 0];
    for (let m = 0; m < sh; m++) for (let n = 0; n < sw; n++) {
      const sy = Math.min(img.height - 1, y * sh + m), sx = Math.min(img.width - 1, x * sw + n);
      const i = (sy * img.width + sx) * 4;
      acc[0] += img.pixels[i]; acc[1] += img.pixels[i + 1]; acc[2] += img.pixels[i + 2]; acc[3] += img.pixels[i + 3];
    }
    const o = (y * w + x) * 4;
    for (let k = 0; k < 4; k++) out[o + k] = Math.min(255, Math.floor(acc[k] / (sw * sh)));
  }
  return { width: w, height: h, pixels: out };
}
