/**
 * Vendor bed visuals (Orca machine model `bed_model` STL + `bed_texture`
 * SVG/PNG), loaded lazily: nothing is fetched until a printer that has them is
 * shown in the Prepare view, the STL parser is a separate chunk, and results
 * are cached per URL for the session. Failures resolve to null (the generic
 * plate stays).
 */
import { BufferGeometry, CanvasTexture, SRGBColorSpace, type Texture } from 'three';

const meshCache = new Map<string, Promise<BufferGeometry | null>>();
const textureCache = new Map<string, Promise<Texture | null>>();

export function loadBedMesh(url: string): Promise<BufferGeometry | null> {
  let p = meshCache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const [{ STLLoader }, rsp] = await Promise.all([import('three/examples/jsm/loaders/STLLoader.js'), fetch(url)]);
        if (!rsp.ok) return null;
        const geo = new STLLoader().parse(await rsp.arrayBuffer());
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        return geo;
      } catch { return null; }
    })();
    meshCache.set(url, p);
  }
  return p;
}

/** Texture for the plate, rasterised at up to `size` px on its long side (SVGs are vector). */
export function loadBedTexture(url: string, size = 2048): Promise<Texture | null> {
  let p = textureCache.get(url);
  if (!p) {
    p = new Promise<Texture | null>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        try {
          const w = img.naturalWidth || size, h = img.naturalHeight || size;
          const k = size / Math.max(w, h);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * k));
          canvas.height = Math.max(1, Math.round(h * k));
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const tex = new CanvasTexture(canvas);
          tex.colorSpace = SRGBColorSpace;
          tex.anisotropy = 4;
          resolve(tex);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    textureCache.set(url, p);
  }
  return p;
}
