/**
 * The tool's Fast view (desktop GLGizmoTextureDisplacement Fast: the
 * "texture_displacement_shaded" shader). The active layer's painted patch on
 * the object's first model part is drawn over the base surface with its
 * relief shaded on, not built: the surface normal is tilted by the height
 * map's slope and a parallax march shades the point the displaced surface
 * would show (resources/shaders/140/texture_displacement_shaded.fs, ported
 * term for term for Triplanar / Cylindrical / Spherical). Every layer setting
 * is a uniform, so a slider updates the next frame; only the paint changes the
 * geometry. Lighting is the scene's (the material is a MeshStandardMaterial),
 * so it reads like the Normal view's real geometry next to it.
 */
import {
  ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, MeshStandardMaterial, MirroredRepeatWrapping, RedFormat,
  RepeatWrapping, UnsignedByteType, Vector3, type IUniform, type Matrix4,
} from 'three';
import type { TextureLayer } from '../project/types';
import { layerHeight, type HeightImage, type TextureAdjustments } from './image';
import { Projection, TileMethod, bool, enumInt, num, projectionOf } from './model';

export interface PatchFrame { center: Vector3; axis: Vector3 }

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D tdHeight;
uniform vec2 tdTexel;
uniform float tdDepth;
uniform float tdTiling;
uniform float tdAspect;
uniform float tdRotation;
uniform vec2 tdOffset;
uniform bool tdInvert;
uniform float tdMidlevel;
uniform vec3 tdAnchor;
uniform bool tdTile;
uniform bool tdMirrored;
uniform int tdProjection;
uniform vec3 tdPatchCenter;
uniform vec3 tdPatchAxis;
varying vec3 vTdWorld;

#define TD_STEPS 24

float tdH(vec2 uv) {
  if (!tdTile && (uv.x < 0.0 || uv.x >= 1.0 || uv.y < 0.0 || uv.y >= 1.0)) return 0.0;
  return textureLod(tdHeight, uv, 0.0).r;
}
float tdSign(float n) { return n >= 0.0 ? 1.0 : -1.0; }
void tdCylFrame(out vec3 up, out vec3 right, out vec3 fwd) {
  up = length(tdPatchAxis) > 1e-8 ? normalize(tdPatchAxis) : vec3(0.0, 0.0, 1.0);
  vec3 arb = abs(up.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  right = normalize(cross(up, arb));
  fwd = normalize(cross(up, right));
}
vec2 tdRaw(vec3 p, vec3 n) {
  if (tdProjection == 1) {
    vec3 up, right, fwd; tdCylFrame(up, right, fwd);
    vec3 rel = p - tdPatchCenter;
    float x = dot(rel, right), y = dot(rel, fwd);
    return vec2(atan(y, x) * sqrt(x * x + y * y), -dot(rel, up));
  }
  if (tdProjection == 2) {
    vec3 rel = p - tdPatchCenter;
    float r = length(rel);
    if (r < 1e-8) return vec2(0.0);
    vec3 d = rel / r;
    return vec2(atan(d.y, d.x), -asin(clamp(d.z, -1.0, 1.0))) * r;
  }
  vec3 an = abs(n);
  if (an.x >= an.y && an.x >= an.z) return vec2(tdSign(n.x) * p.y, -p.z);
  if (an.y >= an.x && an.y >= an.z) return vec2(-tdSign(n.y) * p.x, -p.z);
  return vec2(tdSign(n.z) * p.x, -p.y);
}
void tdAxes(vec3 p, vec3 n, out vec3 t, out vec3 b, out vec2 upm) {
  upm = vec2(1.0);
  if (tdProjection == 1) {
    vec3 up, right, fwd; tdCylFrame(up, right, fwd);
    vec3 rel = p - tdPatchCenter;
    vec2 xy = vec2(dot(rel, right), dot(rel, fwd));
    float r = length(xy);
    t = r > 1e-6 ? (fwd * xy.x - right * xy.y) / r : right;
    b = -up;
    return;
  }
  if (tdProjection == 2) {
    vec3 rel = p - tdPatchCenter;
    float r = length(rel);
    vec3 d = r > 1e-8 ? rel / r : vec3(0.0, 0.0, 1.0);
    float c = length(d.xy);
    t = c > 1e-6 ? vec3(-d.y, d.x, 0.0) / c : vec3(1.0, 0.0, 0.0);
    b = -cross(d, t);
    upm = vec2(1.0 / max(c, 1e-3), 1.0);
    return;
  }
  vec3 an = abs(n);
  if (an.x >= an.y && an.x >= an.z) { t = vec3(0.0, tdSign(n.x), 0.0); b = vec3(0.0, 0.0, -1.0); }
  else if (an.y >= an.x && an.y >= an.z) { t = vec3(-tdSign(n.y), 0.0, 0.0); b = vec3(0.0, 0.0, -1.0); }
  else { t = vec3(tdSign(n.z), 0.0, 0.0); b = vec3(0.0, -1.0, 0.0); }
}
vec2 tdUv(vec3 p, vec3 n) {
  vec2 q = tdRaw(p, n) * (tdTiling > 1e-6 ? 1.0 / tdTiling : 1.0);
  float cs = cos(tdRotation), sn = sin(tdRotation);
  vec2 r = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  r.y *= tdAspect;
  return r + tdOffset;
}
vec3 tdNormal(vec3 n) {
  vec3 tex = vTdWorld - tdAnchor;
  vec3 t, b; vec2 upm;
  tdAxes(tex, n, t, b, upm);
  float amp = (tdInvert ? -1.0 : 1.0) * tdDepth;
  vec3 eye = cameraPosition - tdAnchor;
  vec3 v = normalize(eye - tex);
  float vn = dot(v, n);
  vec2 uv = tdUv(tex, n);
  float ha = amp * (0.0 - tdMidlevel), hb = amp * (1.0 - tdMidlevel);
  float hi = max(ha, hb), lo = min(ha, hb);
  float sweep = length(v - n * vn) * (hi - lo) / max(vn, 1e-4);
  if (vn > 0.05 && sweep > 0.5 * tdTiling * tdTexel.x) {
    float s = hi / vn, ds = (hi - lo) / (vn * float(TD_STEPS));
    vec2 pu = tdUv(tex + v * s, n);
    float pg = hi - amp * (tdH(pu) - tdMidlevel);
    for (int i = 0; i < TD_STEPS; ++i) {
      s -= ds;
      vec2 cu = tdUv(tex + v * s, n);
      float g = s * vn - amp * (tdH(cu) - tdMidlevel);
      if (g <= 0.0) { uv = mix(pu, cu, clamp(pg / max(pg - g, 1e-6), 0.0, 1.0)); break; }
      pu = cu; pg = g;
    }
  }
  float hL = tdH(uv - vec2(tdTexel.x, 0.0)), hR = tdH(uv + vec2(tdTexel.x, 0.0));
  float hD = tdH(uv - vec2(0.0, tdTexel.y)), hU = tdH(uv + vec2(0.0, tdTexel.y));
  vec2 dh = vec2((hR - hL) / (2.0 * tdTexel.x), (hU - hD) / (2.0 * tdTexel.y));
  float a = amp * (tdTiling > 1e-6 ? 1.0 / tdTiling : 1.0);
  float cs = cos(tdRotation), sn = sin(tdRotation);
  vec2 g = vec2(dh.x, dh.y * tdAspect);
  vec2 slope = a * vec2(g.x * cs + g.y * sn, -g.x * sn + g.y * cs) * upm;
  vec3 grad = slope.x * t + slope.y * b;
  grad -= n * dot(n, grad);
  return normalize(n - grad);
}
`;

/** Uniform values for a layer (pure; the shader's inputs). */
export function fastUniformValues(layer: TextureLayer, img: Pick<HeightImage, 'width' | 'height'>, anchor: readonly number[], frame: PatchFrame | null) {
  const proj = projectionOf(layer);
  return {
    tdTexel: [1 / img.width, 1 / img.height] as [number, number],
    tdDepth: num(layer.json, 'depth_mm', 0.4),
    tdTiling: num(layer.json, 'tiling_scale', 12.5),
    tdAspect: img.width / img.height,
    tdRotation: (num(layer.json, 'rotation_deg', 0) * Math.PI) / 180,
    tdOffset: offsetOf(layer),
    tdInvert: bool(layer.json, 'invert', false),
    tdMidlevel: num(layer.json, 'midlevel', 0),
    tdAnchor: [anchor[0], anchor[1], anchor[2]] as [number, number, number],
    tdTile: bool(layer.json, 'tile_enabled', true),
    tdMirrored: enumInt(layer.json, 'tile_method', TileMethod.Repeat) === TileMethod.MirroredRepeat,
    tdProjection: proj === Projection.Cylindrical ? 1 : proj === Projection.Spherical ? 2 : 0,
    tdPatchCenter: frame ? frame.center.toArray() : [0, 0, 0],
    tdPatchAxis: frame ? frame.axis.toArray() : [0, 0, 1],
  };
}

/** A layer's offset [u, v] (desktop's `offset`, uv units). */
export function offsetOf(layer: TextureLayer): [number, number] {
  const o = layer.json.offset;
  return Array.isArray(o) && typeof o[0] === 'number' && typeof o[1] === 'number' && Number.isFinite(o[0]) && Number.isFinite(o[1]) ? [o[0], o[1]] : [0, 0];
}

/** Whether a layer can be shown in the Fast view (desktop: its in-shader projections; LSCM / From view need per-vertex uv). */
export const fastViewable = (l: TextureLayer | undefined): boolean => !!l?.image?.length && projectionOf(l) <= Projection.Spherical;

export class FastViewMaterial extends MeshStandardMaterial {
  readonly tdUniforms: Record<string, IUniform> = {
    tdHeight: { value: null }, tdTexel: { value: [1, 1] }, tdDepth: { value: 0.4 }, tdTiling: { value: 12.5 }, tdAspect: { value: 1 },
    tdRotation: { value: 0 }, tdOffset: { value: [0, 0] }, tdInvert: { value: false }, tdMidlevel: { value: 0 }, tdAnchor: { value: new Vector3() },
    tdTile: { value: true }, tdMirrored: { value: false }, tdProjection: { value: 0 }, tdPatchCenter: { value: new Vector3() }, tdPatchAxis: { value: new Vector3(0, 0, 1) },
  };
  private tex: DataTexture | null = null;
  private texImage: HeightImage | null = null;

  constructor() {
    // Drawn over the coincident base surface: pulled toward the camera so it wins the depth test.
    super({ color: 0xc0c0c0, roughness: 0.75, metalness: 0.05, flatShading: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.tdUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTdWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvTdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            vec3 tdN = normalize(cross(dFdx(vTdWorld), dFdy(vTdWorld)));
            normal = normalize((viewMatrix * vec4(tdNormal(tdN), 0.0)).xyz);
          }`);
    };
    this.customProgramCacheKey = () => 'texture-displacement-fast';
  }

  /** Point the material at a layer (and the live adjustment, while the image panel is open). False without a decodable image. */
  setLayer(layer: TextureLayer, anchor: readonly number[], frame: PatchFrame | null, adjust?: TextureAdjustments | null): boolean {
    if (!layer.image?.length) return false;
    const img = layerHeight(layer.image, num(layer.json, 'smoothing', 0), adjust);
    if (!img) return false;
    if (img !== this.texImage) {
      this.tex?.dispose();
      // Rows top first, uv v = 0 on the first row: no flip (decode_height_texture's orientation).
      const t = new DataTexture(img.pixels, img.width, img.height, RedFormat, UnsignedByteType);
      t.flipY = false;
      t.unpackAlignment = 1;
      t.generateMipmaps = true;
      t.minFilter = LinearMipmapLinearFilter;
      t.magFilter = LinearFilter;
      t.needsUpdate = true;
      this.tex = t;
      this.texImage = img;
      this.tdUniforms.tdHeight.value = t;
    }
    const u = fastUniformValues(layer, img, anchor, frame);
    const wrap = !u.tdTile ? ClampToEdgeWrapping : u.tdMirrored ? MirroredRepeatWrapping : RepeatWrapping;
    if (this.tex && (this.tex.wrapS !== wrap || this.tex.wrapT !== wrap)) { this.tex.wrapS = this.tex.wrapT = wrap; this.tex.needsUpdate = true; }
    for (const [k, v] of Object.entries(u)) {
      const cur = this.tdUniforms[k];
      if (k === 'tdAnchor' || k === 'tdPatchCenter' || k === 'tdPatchAxis') (cur.value as Vector3).fromArray(v as number[]);
      else cur.value = v;
    }
    return true;
  }

  override dispose(): void {
    this.tex?.dispose();
    this.tex = null;
    this.texImage = null;
    super.dispose();
  }
}

/**
 * texture_displacement_patch_frame for Cylindrical / Spherical, in the
 * texture frame (world minus the anchor): the centre is the mean of the
 * patch's triangle corners, the axis the world axis least aligned with the
 * patch's average normal (desktop sums vertex normals per corner; the face
 * normals of the corners' triangles stand in for them here).
 */
export function patchFrame(positions: Float32Array, indices: Uint32Array, toWorld: Matrix4, anchor: readonly number[]): PatchFrame {
  const e = toWorld.elements;
  const P = (i: number, out: Vector3) => out.set(
    e[0] * positions[i * 3] + e[4] * positions[i * 3 + 1] + e[8] * positions[i * 3 + 2] + e[12] - anchor[0],
    e[1] * positions[i * 3] + e[5] * positions[i * 3 + 1] + e[9] * positions[i * 3 + 2] + e[13] - anchor[1],
    e[2] * positions[i * 3] + e[6] * positions[i * 3 + 1] + e[10] * positions[i * 3 + 2] + e[14] - anchor[2]);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  const center = new Vector3(), normal = new Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    P(indices[t], a); P(indices[t + 1], b); P(indices[t + 2], c);
    normal.add(ab.subVectors(b, a).cross(ac.subVectors(c, a)));
    center.add(a).add(b).add(c);
  }
  if (!indices.length) return { center, axis: new Vector3(0, 0, 1) };
  center.multiplyScalar(1 / indices.length);
  const n = normal.lengthSq() > 1e-16 ? normal.normalize() : new Vector3(0, 0, 1);
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const axis = ax <= ay && ax <= az ? new Vector3(1, 0, 0) : ay <= ax && ay <= az ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  return { center, axis };
}
