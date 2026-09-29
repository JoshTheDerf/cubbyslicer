/**
 * Custom bed texture (SVG / PNG) and bed model (STL) chosen in the Bed shape
 * dialog (Orca `bed_custom_texture` / `bed_custom_model`). The files live in
 * IndexedDB as data URLs; the printer option holds a reference
 * `cubby-asset:<id>/<file name>`. `effectiveBedAssets` merges them over the
 * vendor model's assets for the viewport (scene.setBedAssets, loaded lazily
 * by viewport/bedAssets.ts like the vendor ones).
 */
import { shallowRef, watch, type ShallowRef } from 'vue';
import { openKv } from '../../presets/kv';
import { currentPresets } from '../../presets/store';
import type { BedAssets } from '../../presets/types';
import { uuid } from '../../presets/util';

const PREFIX = 'bedasset:';
export const ASSET_SCHEME = 'cubby-asset:';

export interface StoredAsset { name: string; type: string; dataUrl: string }

export function assetRef(id: string, name: string): string { return `${ASSET_SCHEME}${id}/${name}`; }
export function parseAssetRef(v: string): { id: string; name: string } | null {
  if (!v.startsWith(ASSET_SCHEME)) return null;
  const rest = v.slice(ASSET_SCHEME.length);
  const i = rest.indexOf('/');
  return i > 0 ? { id: rest.slice(0, i), name: rest.slice(i + 1) } : { id: rest, name: '' };
}
/** File name shown for an option value (reference or a plain path from an imported Orca preset). */
export function assetLabel(v: string): string {
  const r = parseAssetRef(v);
  return r ? r.name || 'custom file' : v.split(/[\\/]/).pop() ?? v;
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** Store a picked file; returns the option value referencing it. */
export async function storeBedAsset(file: File): Promise<string> {
  const id = uuid();
  const kv = await openKv();
  const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : /\.png$/i.test(file.name) ? 'image/png' : /\.stl$/i.test(file.name) ? 'model/stl' : 'application/octet-stream');
  await kv.set(`${PREFIX}${id}`, { name: file.name, type, dataUrl: await fileToDataUrl(file) } satisfies StoredAsset);
  return assetRef(id, file.name);
}

export async function loadBedAsset(id: string): Promise<StoredAsset | null> {
  const kv = await openKv();
  const rows = await kv.getAll(`${PREFIX}${id}`);
  const hit = rows.find(([k]) => k === `${PREFIX}${id}`)?.[1] as StoredAsset | undefined;
  return hit && typeof hit.dataUrl === 'string' ? hit : null;
}

const urlCache = new Map<string, Promise<string | null>>();
/** Object URL for a stored asset reference (cached per session); null when missing. */
export function bedAssetUrl(ref: string): Promise<string | null> {
  const r = parseAssetRef(ref);
  if (!r) return Promise.resolve(null);
  let p = urlCache.get(r.id);
  if (!p) {
    p = loadBedAsset(r.id).then(async (a) => {
      if (!a) return null;
      const blob = await (await fetch(a.dataUrl)).blob();
      return URL.createObjectURL(new Blob([blob], { type: a.type }));
    }).catch(() => null);
    urlCache.set(r.id, p);
  }
  return p;
}

const single = (v: unknown) => String(Array.isArray(v) ? v[0] ?? '' : v ?? '');

let effective: ShallowRef<BedAssets | null> | null = null;
/**
 * The bed assets the viewport should show: the printer's custom texture /
 * model (when set and stored in this browser) over the vendor model's.
 */
export function useEffectiveBedAssets(): ShallowRef<BedAssets | null> {
  if (effective) return effective;
  const out = shallowRef<BedAssets | null>(null);
  effective = out;
  let seq = 0;
  watch(
    () => {
      const p = currentPresets.value;
      return [p.bedAssets.value, single(p.value('printer', 'bed_custom_texture')), single(p.value('printer', 'bed_custom_model'))] as const;
    },
    async ([vendor, tex, model]) => {
      const my = ++seq;
      const [texUrl, modelUrl] = await Promise.all([tex ? bedAssetUrl(tex) : null, model ? bedAssetUrl(model) : null]);
      if (my !== seq) return;
      const merged: BedAssets = { ...(vendor ?? {}) };
      if (texUrl) merged.texture = texUrl;
      if (modelUrl) merged.model = modelUrl;
      out.value = merged.model || merged.texture ? merged : null;
    },
    { immediate: true },
  );
  return out;
}
