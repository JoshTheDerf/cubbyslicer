/**
 * Plate thumbnails, as OrcaSlicer makes them:
 *  - G-code: the sizes / formats in the printer's `thumbnails` setting,
 *    rendered once per slice and written into the header (every export,
 *    Export all, cloud / local-folder saves and print-host uploads use the
 *    result's G-code, so they all carry them);
 *  - project 3MF: Metadata/plate_N.png (512², + plate_N_small.png 128²),
 *    plate_no_light_N.png, top_N.png and pick_N.png for every plate.
 */
import { engineTool } from '../../engine/client';
import type { EngineId, FlatConfig, SliceObjectInput, SliceResult, SliceWarning } from '../../engine/types';
import { activeEngine } from '../../app/state';
import { filamentColourOf } from '../../mixed/store';
import { maxStateFor } from '../../paint/state';
import { asArray } from '../../presets/values';
import { bed, getSliceObjects, plates } from '../store';
import { base64, colpicSize, encodeBttTft, encodeColPic, encodePng, encodeQoi, type RgbaImage } from './encode';
import {
  engineWritesGcodeThumbnails, formatThumbnailBlocks, hasGcodeThumbnails, spliceThumbnails, thumbnailSpecs,
  type EncodedThumbnail, type ThumbnailSpec,
} from './gcode';
import { downscale, prepareThumbScene, type ThumbScene, type ThumbVolume } from './render';

export { thumbnailSpecs } from './gcode';

const extruderOf = (cfg: FlatConfig | undefined, fallback: number) => Number(asArray(cfg?.extruder)[0]) || fallback;

/** Colour painting as sub-meshes per filament (the engine's TriangleSelector decodes Orca's paint strings). */
async function paintPatches(positions: Float32Array, indices: Uint32Array, map: NonNullable<SliceObjectInput['paint']>['color']): Promise<ThumbVolume['paint']> {
  if (!map?.length) return undefined;
  try {
    const engine: EngineId = activeEngine.value === 'fullspectrum' ? 'fullspectrum' : 'orca';
    const r = await engineTool<{ handle: number; states: number[] }>('paint_open', { paint: map, maxState: maxStateFor('color') }, [{ positions, indices }], engine);
    void engineTool('paint_close', { handle: r.result.handle }, [], engine).catch(() => {});
    return r.result.states.flatMap((st, i) => {
      const m = r.meshes[i];
      return st > 0 && m?.indices.length ? [{ positions: m.positions, indices: m.indices, color: filamentColourOf(st), extruder: st }] : [];
    });
  } catch {
    return undefined; // engine unavailable: plain filament colour
  }
}

/**
 * The thumbnail scene of a plate's slice input (printable objects, model parts
 * only: Orca leaves modifiers / negative volumes / blockers out).
 */
export async function thumbSceneFor(objects: SliceObjectInput[], pickIdOf: (objectId: string) => number = () => 0): Promise<ThumbScene> {
  const volumes: ThumbVolume[] = [];
  for (const o of objects) {
    const ext = extruderOf(o.config, 1);
    const pickId = pickIdOf(o.id);
    volumes.push({
      positions: o.positions, indices: o.indices, transform: o.transform, color: filamentColourOf(ext), extruder: ext, pickId,
      paint: await paintPatches(o.positions, o.indices, o.paint?.color),
    });
    for (const p of o.parts ?? []) {
      if (p.type !== 'part') continue;
      const pe = extruderOf(p.config, ext);
      volumes.push({
        positions: p.positions, indices: p.indices, transform: p.transform, color: filamentColourOf(pe), extruder: pe, pickId,
        paint: await paintPatches(p.positions, p.indices, p.paint?.color),
      });
    }
  }
  const b = bed.value;
  return { volumes, plate: { min: [b.min[0], b.min[1], 0], max: [b.max[0], b.max[1], b.maxHeight > 0 ? b.maxHeight : 250] } };
}

async function jpeg(img: RgbaImage): Promise<Uint8Array> {
  // libjpeg quality 85 on RGB (alpha dropped → black background, as Orca's WASM/IJG path).
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const rgb = new Uint8ClampedArray(img.pixels.length);
  for (let i = 0; i < img.pixels.length; i += 4) { rgb[i] = img.pixels[i]; rgb[i + 1] = img.pixels[i + 1]; rgb[i + 2] = img.pixels[i + 2]; rgb[i + 3] = 255; }
  ctx.putImageData(new ImageData(rgb, img.width, img.height), 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('JPEG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodeFor(spec: ThumbnailSpec, render: (w: number, h: number) => RgbaImage | null): Promise<EncodedThumbnail | null> {
  const [w, h] = spec.format === 'COLPIC' ? colpicSize(spec.width, spec.height) : [spec.width, spec.height];
  const img = render(w, h);
  if (!img) return null;
  const base = { spec, width: img.width, height: img.height };
  switch (spec.format) {
    case 'PNG': return { ...base, bytes: encodePng(img) };
    case 'JPG': return { ...base, bytes: await jpeg(img) };
    case 'QOI': return { ...base, bytes: encodeQoi(img) };
    case 'BTT_TFT': return { ...base, text: encodeBttTft(img) };
    case 'COLPIC': { const text = encodeColPic(img); return text ? { ...base, text } : null; }
  }
}

/**
 * The slice result with the printer profile's G-code thumbnails written into
 * its header, as the desktop engine's GCode::do_export would with a thumbnail
 * callback. Never fails the slice: problems become a warning.
 */
export async function withGcodeThumbnails(result: SliceResult, config: FlatConfig, objects: SliceObjectInput[]): Promise<SliceResult> {
  const engine = result.engine;
  const warn = (message: string): SliceResult => ({
    ...result, report: { ...result.report, warnings: [...result.report.warnings, { code: 'thumbnails', message } satisfies SliceWarning] },
  });
  try {
    if (!engineWritesGcodeThumbnails(config, engine)) return result;
    const { specs, errors } = thumbnailSpecs(config, engine);
    const bad = errors.length ? `Some G-code thumbnail entries are invalid${specs.length ? ' and were skipped' : ''}: "${asArray(config.thumbnails).join(',')}"` : '';
    if (!specs.length || hasGcodeThumbnails(result.gcode)) return bad ? warn(bad) : result;
    const prepared = prepareThumbScene(await thumbSceneFor(objects));
    try {
      const list: EncodedThumbnail[] = [];
      for (const s of specs) {
        const e = await encodeFor(s, (w, h) => prepared.render(w, h, 'iso', 'lit'));
        if (e) list.push(e);
      }
      if (!list.length) return bad ? warn(bad) : result;
      const out = { ...result, gcode: spliceThumbnails(result.gcode, formatThumbnailBlocks(list, engine, base64), engine) };
      return bad ? { ...out, report: warn(bad).report } : out;
    } finally {
      prepared.dispose();
    }
  } catch (e) {
    console.warn('G-code thumbnails failed', e);
    return warn(`Couldn't add G-code thumbnails: ${(e as Error)?.message ?? e}`);
  }
}

// ---- project 3MF ------------------------------------------------------------

export const PLATE_THUMBNAIL_SIZE = 512;
export const PLATE_THUMBNAIL_SMALL = 128;

export interface PlateImages {
  /** Metadata/plate_N.png */ plate: Uint8Array;
  /** Metadata/plate_N_small.png */ small: Uint8Array;
  /** Metadata/plate_no_light_N.png */ noLight: Uint8Array;
  /** Metadata/top_N.png */ top: Uint8Array;
  /** Metadata/pick_N.png */ pick: Uint8Array;
}

const transparent = (w: number, h: number): RgbaImage => ({ width: w, height: h, pixels: new Uint8Array(w * h * 4) });

/**
 * Orca's per-plate project images (Plater::export_3mf → bbs_3mf.cpp), for
 * every plate (an empty plate gets transparent ones, as in Orca).
 * `identifyIdOf` gives the instance's identify_id for the pick image.
 * Returns [] when WebGL is unavailable.
 */
export async function renderPlateImages(identifyIdOf: (objectId: string) => number): Promise<PlateImages[]> {
  const S = PLATE_THUMBNAIL_SIZE;
  const out: PlateImages[] = [];
  for (let i = 0; i < plates.value.length; i++) {
    const objs = getSliceObjects(i);
    const prepared = prepareThumbScene(await thumbSceneFor(objs, identifyIdOf));
    try {
      const render = (view: 'iso' | 'top', mode: 'lit' | 'flat' | 'pick') => (objs.length ? prepared.render(S, S, view, mode) : transparent(S, S));
      const iso = render('iso', 'lit');
      if (!iso) return []; // no WebGL
      out.push({
        plate: encodePng(iso),
        small: encodePng(downscale(iso, PLATE_THUMBNAIL_SMALL, PLATE_THUMBNAIL_SMALL)),
        noLight: encodePng(render('iso', 'flat') ?? transparent(S, S)),
        top: encodePng(render('top', 'lit') ?? transparent(S, S)),
        pick: encodePng(render('top', 'pick') ?? transparent(S, S)),
      });
    } finally {
      prepared.dispose();
    }
  }
  return out;
}
