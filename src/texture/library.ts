/**
 * The texture library (desktop TextureLibrary.cpp): OrcaSlicer's shipped
 * height maps, staged into public/textures/displacement by
 * scripts/stage-textures.mjs, in desktop's order (by name). Images are
 * fetched when first used and kept, so layers share one buffer per texture.
 * Imported images are converted the way desktop imports them (png.ts).
 */
import { encodeTexturePng } from './png';

export interface LibraryTexture { name: string; url: string }

const base = () => `${import.meta.env.BASE_URL}textures/displacement/`;
let index: Promise<LibraryTexture[]> | null = null;
const images = new Map<string, Promise<Uint8Array>>();

/** The shipped textures (empty when the library isn't staged). */
export function textureLibrary(): Promise<LibraryTexture[]> {
  index ??= fetch(`${base()}index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { textures?: Array<{ name?: unknown; file?: unknown }> } | null) => (j?.textures ?? [])
      .filter((t): t is { name: string; file: string } => typeof t.name === 'string' && typeof t.file === 'string' && !/[/\\]/.test(t.file))
      .map((t) => ({ name: t.name, url: `${base()}${encodeURIComponent(t.file)}` })))
    .catch(() => []);
  void index.then((l) => { if (!l.length) index = null; });
  return index;
}

/** A library texture's PNG bytes (shared; never mutate). */
export function libraryImage(t: LibraryTexture): Promise<Uint8Array> {
  let p = images.get(t.url);
  if (!p) {
    p = fetch(t.url).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => images.delete(t.url));
    images.set(t.url, p);
  }
  return p;
}

/**
 * An image file as a layer texture (import_texture_to_library): decoded and
 * re-encoded as an 8-bit grey PNG, or RGB when it has colour. Name = file stem.
 */
export async function importTextureFile(file: Blob & { name?: string }): Promise<{ name: string; image: Uint8Array }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('Could not load the selected image.');
  }
  try {
    const { width, height } = bmp;
    if (!width || !height) throw new Error('The selected image is empty.');
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not load the selected image.');
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { name: (file.name ?? 'Texture').replace(/\.[^.]+$/, '') || 'Texture', image: encodeTexturePng(width, height, data) };
  } finally {
    bmp.close();
  }
}
