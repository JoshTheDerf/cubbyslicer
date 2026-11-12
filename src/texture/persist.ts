/**
 * Texture displacement in project files: desktop's 3MF layout (bbs_3mf.cpp
 * add_texture_displacement / _apply_texture_displacement) read into a
 * MeshTexture and written back, plus validation of autosaved records.
 */
import type { MeshTexture, TextureLayer, TextureStack } from '../project/types';
import { MASK_ATTR_RE, MAX_TEXTURE_LAYERS, TEXTURE_DIR, TEXTURE_KEY, layerSlot, maskAttr, stackFromJson, stackToJson } from './model';

type Pairs = Array<[string, string]>;
type Attrs = Record<string, Array<[number, string]>>;

export const isTextureFile = (path: string) => path.toLowerCase().startsWith(TEXTURE_DIR.toLowerCase());

/**
 * A volume as read from a 3MF → its texture data. The `texture_displacement`
 * metadata key and the `paint_texture_N` attributes are taken out (the rest
 * stays passthrough). Desktop drops a stack whose JSON is missing or
 * malformed with an error; so do we (`warning`).
 */
export function takeVolumeTexture(meshMetadata: Pairs | undefined, triangleAttrs: Attrs | undefined, file: (path: string) => Uint8Array | undefined): {
  texture?: MeshTexture; meshMetadata: Pairs; triangleAttrs?: Attrs; warning?: string;
} {
  let stack: TextureStack | undefined;
  let warning: string | undefined;
  const rest: Pairs = [];
  for (const [k, v] of meshMetadata ?? []) {
    if (k !== TEXTURE_KEY) { rest.push([k, v]); continue; }
    const bytes = file(v);
    if (!bytes) { warning = `Missing texture displacement data: ${v}`; continue; }
    const s = stackFromJson(new TextDecoder().decode(bytes), file);
    if (!s) { warning = `Malformed texture displacement data: ${v}`; continue; }
    if (s.layers.length) stack = s;
  }
  const masks: Record<string, Array<[number, string]>> = {};
  let attrs: Attrs | undefined;
  for (const [name, list] of Object.entries(triangleAttrs ?? {})) {
    const m = MASK_ATTR_RE.exec(name);
    if (m) { if (list.length) masks[m[1]] = list; } else (attrs ??= {})[name] = list;
  }
  const texture: MeshTexture | undefined = stack || Object.keys(masks).length
    ? Object.freeze({ ...(stack ? { stack } : {}), ...(Object.keys(masks).length ? { masks: Object.freeze(masks) } : {}) })
    : undefined;
  return { texture, meshMetadata: rest, triangleAttrs: attrs, ...(warning ? { warning } : {}) };
}

/**
 * Archive entries + the volume metadata value for one written volume (`id`:
 * its id in the file). Images are stored (PNG is compressed already).
 */
export function textureFiles(stack: TextureStack, id: number): { files: Record<string, Uint8Array>; jsonPath: string } {
  const files: Record<string, Uint8Array> = {};
  const paths = new Map<number, string>();
  for (const l of stack.layers) {
    if (!l.image?.length) continue;
    const p = `${TEXTURE_DIR}${id}_${layerSlot(l)}.png`;
    files[p] = l.image;
    paths.set(layerSlot(l), p);
  }
  const jsonPath = `${TEXTURE_DIR}${id}.json`;
  files[jsonPath] = new TextEncoder().encode(stackToJson(stack, paths));
  return { files, jsonPath };
}

/** Per-triangle mask attributes of a mesh, for the model file. */
export function maskAttrs(t: MeshTexture | undefined): Array<[string, ReadonlyArray<readonly [number, string]>]> {
  return Object.entries(t?.masks ?? {}).map(([slot, m]) => [maskAttr(Number(slot)), m]);
}

// ---- autosave / project JSON records ---------------------------------------------

const HEX = /^[0-9A-Fa-f]+$/;
function cleanMask(raw: unknown): Array<[number, string]> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is [number, string] => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && e[0] >= 0
    && typeof e[1] === 'string' && e[1].length > 0 && e[1].length < 1 << 20 && HEX.test(e[1]));
}

/** Validate untrusted stored texture records (autosave): { meshId: { stack?: {layers:[{json, image}], options}, masks? } }. */
export function sanitizeTexture(raw: unknown, meshIds: Set<string>): Record<string, MeshTexture> {
  const out: Record<string, MeshTexture> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!meshIds.has(id) || !rec || typeof rec !== 'object') continue;
    const r = rec as Record<string, unknown>;
    let stack: TextureStack | undefined;
    const s = r.stack as Record<string, unknown> | undefined;
    if (s && typeof s === 'object' && Array.isArray(s.layers)) {
      const seen = new Set<number>();
      const layers: TextureLayer[] = [];
      for (const l of s.layers.slice(0, MAX_TEXTURE_LAYERS)) {
        const json = (l as Record<string, unknown>)?.json;
        const image = (l as Record<string, unknown>)?.image;
        if (!json || typeof json !== 'object' || Array.isArray(json)) continue;
        const layer: TextureLayer = Object.freeze({ json: Object.freeze({ ...(json as Record<string, unknown>) }), image: image instanceof Uint8Array ? image : null });
        const slot = layerSlot(layer);
        if (slot < 0 || slot >= MAX_TEXTURE_LAYERS || seen.has(slot)) continue;
        seen.add(slot);
        layers.push(layer);
      }
      const options = s.options && typeof s.options === 'object' && !Array.isArray(s.options) ? { ...(s.options as Record<string, unknown>) } : {};
      if (layers.length) stack = Object.freeze({ layers: Object.freeze(layers), options: Object.freeze(options) });
    }
    const masks: Record<string, Array<[number, string]>> = {};
    if (r.masks && typeof r.masks === 'object') {
      for (const [slot, m] of Object.entries(r.masks as Record<string, unknown>)) {
        if (!/^[0-7]$/.test(slot)) continue;
        const c = cleanMask(m);
        if (c.length) masks[slot] = c;
      }
    }
    if (stack || Object.keys(masks).length) out[id] = Object.freeze({ ...(stack ? { stack } : {}), ...(Object.keys(masks).length ? { masks: Object.freeze(masks) } : {}) });
  }
  return out;
}
