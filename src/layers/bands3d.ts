/**
 * Layer-height bands on the object in the Prepare view while the layer editor
 * is open (Orca renders the edited object with its layer-height texture and
 * the Z cursor band). An overlay mesh sharing the object's transform is drawn
 * over it with a shader that colours each layer by its height (alternating
 * shade per layer) and highlights the editor's cursor band.
 */
import {
  BufferAttribute, BufferGeometry, DataTexture, DoubleSide, LinearFilter, Mesh, NearestFilter, RGBAFormat, ShaderMaterial,
  type Scene, UnsignedByteType,
} from 'three';
import { watch, type WatchStopHandle } from 'vue';
import { resolvedConfig } from '../app/state';
import { getMesh, objectInfo, objects } from '../project/store';
import { rampColor } from '../preview/render/colors';
import { editObject, layersUi, liveProfile, paramsFor, profileOf } from './store';
import { generateLayers, type SlicingParams } from './profile';

const TEX = 4096;

const vert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const frag = /* glsl */ `
uniform sampler2D uTex;
uniform float uZ0;
uniform float uHeight;
uniform float uCursor;
uniform float uBand;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float t = clamp((vWorld.z - uZ0) / max(uHeight, 1e-4), 0.0, 1.0);
  vec3 c = texture2D(uTex, vec2(t, 0.5)).rgb;
  float light = 0.45 + 0.55 * abs(dot(n, normalize(vec3(0.3, -0.5, 0.8))));
  c *= light;
  if (uCursor >= 0.0) {
    float d = abs(vWorld.z - uZ0 - uCursor);
    if (d < 0.5 * uBand) c = mix(c, vec3(1.0), 0.35 * (0.5 + 0.5 * cos(6.2831853 * d / uBand)));
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** RGBA texels along Z: colour by layer height, alternating shade per layer (Orca's layer texture). */
export function bandTexels(p: SlicingParams, layers: number[], texels = TEX): Uint8Array {
  const out = new Uint8Array(texels * 4);
  const span = Math.max(1e-6, p.maxLayerHeight - p.minLayerHeight);
  let li = 0;
  for (let i = 0; i < texels; i++) {
    const z = ((i + 0.5) / texels) * p.objectHeight;
    while (li + 3 < layers.length && layers[li + 1] <= z) li += 2;
    const h = layers.length >= 2 ? layers[li + 1] - layers[li] : p.layerHeight;
    const c = rampColor((h - p.minLayerHeight) / span);
    const shade = (li / 2) % 2 ? 0.82 : 1;
    out[i * 4] = ((c >> 16) & 255) * shade;
    out[i * 4 + 1] = ((c >> 8) & 255) * shade;
    out[i * 4 + 2] = (c & 255) * shade;
    out[i * 4 + 3] = 255;
  }
  return out;
}

interface SceneLike { scene: Scene; requestRender(): void }

/** Attach the overlay to a Prepare scene. Returns a disposer. */
export function attachLayerBands(host: SceneLike): () => void {
  const tex = new DataTexture(new Uint8Array(TEX * 4), TEX, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = LinearFilter;
  const mat = new ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, side: DoubleSide,
    uniforms: { uTex: { value: tex }, uZ0: { value: 0 }, uHeight: { value: 1 }, uCursor: { value: -1 }, uBand: { value: 2 } },
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  let mesh: Mesh | null = null;
  let meshId = '';

  const clear = () => {
    if (mesh) { host.scene.remove(mesh); mesh.geometry.dispose(); mesh = null; meshId = ''; }
  };

  const update = () => {
    const o = editObject.value;
    if (!layersUi.editing || !layersUi.showBands || !o || !o.visible) { if (mesh) { clear(); host.requestRender(); } return; }
    const md = getMesh(o.meshId);
    const info = objectInfo.value.get(o.id);
    if (!md || !info) { clear(); host.requestRender(); return; }
    if (meshId !== md.id) {
      clear();
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(md.positions, 3));
      geo.setIndex(new BufferAttribute(md.indices, 1));
      mesh = new Mesh(geo, mat);
      mesh.renderOrder = 2;
      mesh.raycast = () => {};
      meshId = md.id;
      host.scene.add(mesh);
    }
    const m = mesh!;
    m.position.set(o.position[0], o.position[1], o.position[2]);
    m.quaternion.set(o.rotation[0], o.rotation[1], o.rotation[2], o.rotation[3]);
    m.scale.set(o.scale[0], o.scale[1], o.scale[2]);
    const p = paramsFor(o);
    const live = liveProfile.value?.id === o.id ? liveProfile.value.profile : null;
    const prof = live ?? profileOf(o, p);
    (tex.image.data as Uint8Array).set(bandTexels(p, generateLayers(p, prof)));
    tex.needsUpdate = true;
    mat.uniforms.uZ0.value = info.min[2];
    mat.uniforms.uHeight.value = p.objectHeight;
    cursor();
  };
  const cursor = () => {
    mat.uniforms.uCursor.value = layersUi.cursorZ ?? -1;
    mat.uniforms.uBand.value = layersUi.bandWidth;
    host.requestRender();
  };

  const stops: WatchStopHandle[] = [
    watch([editObject, () => layersUi.editing, () => layersUi.showBands, liveProfile, resolvedConfig, objectInfo], update),
    watch([() => layersUi.cursorZ, () => layersUi.bandWidth], () => { if (mesh) cursor(); }),
    watch(objects, update, { deep: true }),
  ];
  update();

  return () => {
    stops.forEach((s) => s());
    clear();
    mat.dispose();
    tex.dispose();
  };
}
