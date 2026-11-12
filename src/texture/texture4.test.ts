// Texture displacement, pieces 4 and 7: layer reorder, placement offset, the user's texture library,
// image adjustments (apply_texture_adjustments) and the Fast view's inputs.
import { strFromU8, unzipSync } from 'fflate';
import { Matrix4, Vector2, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import * as S from '../project/store';
import { openOrcaProject } from '../project/orcaOpen';
import { buildOrca3mf } from '../project/persistence/orca3mfWriter';
import { memoryKv } from '../presets/kv';
import { addTextureLayer, moveTextureLayer, reorderedSlots, saveAdjustedCopy, selectWholeModel, stackOf, updateTextureLayer } from './commands';
import { fastUniformValues, fastViewable, offsetOf, patchFrame } from './fastView';
import {
  IDENTITY_ADJUST, adjustmentBlurRadius, applyTextureAdjustments, decodePng, downscaleHeight, encodeHeightPng, layerHeight, smoothHeightPixels, smoothingRadius,
} from './image';
import { layerSlot, orderedLayers, withFields } from './model';
import { boxAxes, draggedOffset, handleCenter, paintAnchor, planePoint, projectPlanar } from './placement';
import { encodePng, encodeTexturePng } from './png';
import { loadUserTextures, removeUserTexture, saveUserTexture, setUserTextureKv, sortByRecent, touchUserTexture, uniqueName, userTextures } from './userLibrary';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
function cube(s = 20) {
  const h = s / 2;
  return {
    positions: new Float32Array([-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0, -h, -h, s, h, -h, s, h, h, s, -h, h, s]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
  };
}
const grey = (w: number, h: number, f: (x: number, y: number) => number) => {
  const p = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = f(x, y);
  return p;
};
const PNG = encodePng(4, 4, grey(4, 4, (x, y) => (x + y) * 30), 1);

describe('image decode / filters', () => {
  it('decodes what layers carry: grey, RGB (height = luminance), every PNG filter', () => {
    const g = decodePng(PNG)!;
    expect([g.width, g.height, [...g.pixels]]).toEqual([4, 4, [...grey(4, 4, (x, y) => (x + y) * 30)]]);
    expect(g.rgb).toBeUndefined();
    const c = decodePng(encodeTexturePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255])))!;
    expect([...c.rgb!]).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...c.pixels]).toEqual([Math.round(0.299 * 255), Math.round(0.114 * 255)]);
    expect(decodePng(encodeHeightPng(c))).toEqual(c);
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('Smoothing: a continuous-radius wrapping box blur; a flat image stays flat, the mean is kept', () => {
    const flat = new Uint8Array(64).fill(77);
    smoothHeightPixels(flat, 8, 8, 2.5);
    expect(flat.every((v) => v === 77)).toBe(true);
    const stripes = grey(16, 16, (x) => (x % 2 ? 255 : 0));
    smoothHeightPixels(stripes, 16, 16, 1);
    expect(Math.max(...stripes) - Math.min(...stripes)).toBeLessThan(80);
    expect(smoothingRadius(1, 1024, 1024)).toBe(48);
    expect(smoothingRadius(0.5, 200, 100)).toBe(2.5);
    expect(adjustmentBlurRadius(1, 1024, 512)).toBe(25.6);
  });

  it('adjustments: brightness lifts toward the ends, contrast pivots on mid-grey, hue leaves grey alone, colour height follows', () => {
    const src = decodePng(PNG)!;
    expect(applyTextureAdjustments(src, IDENTITY_ADJUST)).toEqual(src);
    const white = applyTextureAdjustments(src, { ...IDENTITY_ADJUST, brightness: 1 });
    expect(white.pixels.every((v) => v === 255)).toBe(true);
    const black = applyTextureAdjustments(src, { ...IDENTITY_ADJUST, brightness: -1 });
    expect(black.pixels.every((v) => v === 0)).toBe(true);
    const flat = applyTextureAdjustments(src, { ...IDENTITY_ADJUST, contrast: -1 });
    expect(flat.pixels.every((v) => v === 128)).toBe(true);
    const hard = applyTextureAdjustments(src, { ...IDENTITY_ADJUST, contrast: 1 });
    expect(hard.pixels.every((v) => v === 0 || v === 255)).toBe(true);
    expect(applyTextureAdjustments(src, { ...IDENTITY_ADJUST, hue_deg: 90 }).pixels).toEqual(src.pixels);
    const red = decodePng(encodeTexturePng(1, 1, new Uint8Array([200, 30, 30, 255])))!;
    const turned = applyTextureAdjustments(red, { ...IDENTITY_ADJUST, hue_deg: 120 });
    expect(turned.rgb![1]).toBeGreaterThan(turned.rgb![0]); // red → green
    expect(turned.pixels[0]).toBe(Math.round(0.299 * turned.rgb![0] + 0.587 * turned.rgb![1] + 0.114 * turned.rgb![2]));
    expect(src.pixels).toEqual(decodePng(PNG)!.pixels); // the source is left alone
  });

  it('downscale box-filters to the panel size; layerHeight is cached per image and settings', () => {
    const big = { width: 8, height: 4, pixels: grey(8, 4, (x) => (x < 4 ? 0 : 200)) };
    const s = downscaleHeight(big, 4);
    expect([s.width, s.height, [...s.pixels]]).toEqual([4, 2, [0, 0, 200, 200, 0, 0, 200, 200]]);
    expect(downscaleHeight(big, 16)).toBe(big);
    const a = layerHeight(PNG, 0), b = layerHeight(PNG, 0);
    expect(a).toBe(b);
    expect(layerHeight(PNG, 0.5)).not.toBe(a);
    expect(layerHeight(PNG, 0, { ...IDENTITY_ADJUST, brightness: 1 })!.pixels.every((v) => v === 255)).toBe(true);
  });
});

describe('reorder (move_texture_layer)', () => {
  beforeEach(() => S.resetProject());

  it('an insertion index counting the moved layer; layers in between shift by one', () => {
    expect([...reorderedSlots([0, 1, 2], 2, 0)]).toEqual([[2, 0], [0, 1], [1, 2]]);
    expect([...reorderedSlots([0, 1, 2], 0, 3)]).toEqual([[1, 0], [2, 1], [0, 2]]);
    expect([...reorderedSlots([0, 2], 0, 2)]).toEqual([[2, 0], [0, 2]]);
    expect(reorderedSlots([0, 1], 0, 1).size).toBe(0); // "after itself"
    expect(reorderedSlots([0, 1], 5, 0).size).toBe(0);
  });

  it('slots, masks on every part and the active slot move together; one undo step; saved in desktop\'s layout', async () => {
    S.addParsedObjects([{ name: 'Cube', ...cube(), transform: null }]);
    const id = S.objects.value[0].id;
    const o = () => S.getObject(id)!;
    addTextureLayer(id, { name: 'A', path: 'A.png', image: PNG });
    addTextureLayer(id, { name: 'B', path: 'B.png', image: PNG });
    selectWholeModel(id, 0); // A painted, B not
    const map = moveTextureLayer(id, 1, 0); // B to the base
    expect([...map]).toEqual([[1, 0], [0, 1]]);
    const names = () => orderedLayers(stackOf(o())).map((l) => [layerSlot(l), l.json.name]);
    expect(names()).toEqual([[0, 'B'], [1, 'A']]);
    expect(Object.keys(S.getMeshTexture(o().meshId).masks ?? {})).toEqual(['1']); // A's paint went with it
    expect(stackOf(o())?.options.active_slot).toBe(0); // B was active
    const bytes = buildOrca3mf();
    const zip = unzipSync(bytes);
    const json = JSON.parse(strFromU8(zip[Object.keys(zip).find((k) => /texture_displacement\/\d+\.json$/.test(k))!]));
    expect(json.layers.map((l: { slot: number; name: string }) => [l.slot, l.name]).sort()).toEqual([[0, 'B'], [1, 'A']]);
    expect(strFromU8(zip['3D/Objects/object_1.model'])).toMatch(/paint_texture_1="4"/);
    S.undo();
    expect(names()).toEqual([[0, 'A'], [1, 'B']]);
    expect(Object.keys(S.getMeshTexture(o().meshId).masks ?? {})).toEqual(['0']);
    S.resetProject();
    await openOrcaProject('r.3mf', buf(bytes));
    expect(orderedLayers(stackOf(S.objects.value[0])).map((l) => l.json.name)).toEqual(['B', 'A']);
  });
});

describe('placement (Adjust placement)', () => {
  it('box axes are project_planar\'s axes', () => {
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.3, 0.9, 0.1]]) {
      const nv = new Vector3(...n);
      const { u, v } = boxAxes(nv);
      const p = new Vector3(1.5, -2, 3.25);
      expect(projectPlanar(p, nv).toArray()).toEqual([p.dot(u), p.dot(v)]);
      expect(u.clone().cross(v).dot(nv)).toBeLessThan(0); // (right, down, into) is right-handed
    }
  });

  it('the handle follows the cursor: dragging by delta moves the handle by delta, at any rotation and aspect', () => {
    const anchor = { point: new Vector3(0, 0, 20), normal: new Vector3(0, 0, 1), size: 34.6 };
    for (const [rot, aspect, tiling] of [[0, 1, 12.5], [30, 1, 5], [90, 2, 12.5], [217, 0.5, 3]]) {
      const delta = new Vector2(3, -1.25);
      const off = draggedOffset([0.1, -0.2], delta, tiling, rot, aspect, 'pan');
      const before = handleCenter(anchor, [0.1, -0.2], tiling, rot, aspect);
      const after = handleCenter(anchor, off, tiling, rot, aspect);
      const moved = projectPlanar(after, anchor.normal).sub(projectPlanar(before, anchor.normal));
      expect(moved.x).toBeCloseTo(delta.x, 5);
      expect(moved.y).toBeCloseTo(delta.y, 5);
    }
    expect(handleCenter(anchor, [0, 0], 12.5, 45, 1).distanceTo(planePoint(anchor))).toBeLessThan(1e-9);
    const u = draggedOffset([0, 0], new Vector2(2, 5), 10, 0, 1, 'u');
    expect(u[0]).toBeCloseTo(-0.2);
    expect(u[1]).toBeCloseTo(0);
  });

  it('anchors on the painted facets: centroid of the triangles, area-weighted normal, in world', () => {
    const c = cube();
    const top = new Uint32Array([4, 5, 6, 4, 6, 7]);
    const a = paintAnchor(c.positions, top, new Matrix4().makeTranslation(100, 50, 0), 34.6)!;
    expect(a.point.toArray().map((v) => +v.toFixed(4))).toEqual([100, 50, 20]);
    expect(a.normal.toArray()).toEqual([0, 0, 1]);
    expect(paintAnchor(c.positions, new Uint32Array(0), new Matrix4(), 1)).toBeNull();
  });
});

describe('My textures', () => {
  beforeEach(() => { setUserTextureKv(memoryKv()); globalThis.localStorage?.clear(); });

  it('desktop\'s unique names and recently-used order', () => {
    expect(uniqueName('Stone', [])).toBe('Stone');
    expect(uniqueName('Stone', ['stone', 'Stone (2)'])).toBe('Stone (3)');
    expect(uniqueName('  ', [])).toBe('texture');
    const t = (id: string, name: string) => ({ id, name, image: PNG });
    expect(sortByRecent([t('a', 'Zed'), t('b', 'Alpha'), t('c', 'Mid')], ['c']).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('save, reload from storage, reuse first, delete', async () => {
    const a = await saveUserTexture('Bark', PNG);
    const b = await saveUserTexture('Bark', PNG);
    expect([a.name, b.name]).toEqual(['Bark', 'Bark (2)']);
    expect(userTextures.value.map((x) => x.name)).toEqual(['Bark (2)', 'Bark']);
    touchUserTexture(a.id);
    expect(userTextures.value.map((x) => x.name)).toEqual(['Bark', 'Bark (2)']);
    // A fresh load (another session) reads the bytes back.
    const kvKeep = memoryKv();
    setUserTextureKv(kvKeep);
    await saveUserTexture('Kept', PNG);
    setUserTextureKv(kvKeep);
    const again = await loadUserTextures();
    expect(again.map((x) => x.name)).toEqual(['Kept']);
    expect(again[0].image).toEqual(PNG);
    await removeUserTexture(again[0].id);
    expect(userTextures.value).toEqual([]);
    setUserTextureKv(kvKeep);
    expect(await loadUserTextures()).toEqual([]);
  });

  it('Save as copy: the adjusted image goes to My textures and onto the layer; the 3MF stores only the image', async () => {
    S.resetProject();
    S.addParsedObjects([{ name: 'Cube', ...cube(), transform: null }]);
    const id = S.objects.value[0].id;
    addTextureLayer(id, { name: 'Bricks', path: 'Bricks.png', image: PNG });
    expect(await saveAdjustedCopy(id, 0, IDENTITY_ADJUST)).toBeNull();
    const saved = (await saveAdjustedCopy(id, 0, { ...IDENTITY_ADJUST, brightness: 1 }))!;
    expect(saved.name).toBe('Bricks');
    const l = stackOf(S.getObject(id)!)!.layers[0];
    expect(l.json.name).toBe('Bricks');
    expect(decodePng(l.image!)!.pixels.every((v) => v === 255)).toBe(true);
    expect(userTextures.value[0].id).toBe(saved.id);
    const zip = unzipSync(buildOrca3mf());
    const json = JSON.parse(strFromU8(zip[Object.keys(zip).find((k) => /texture_displacement\/\d+\.json$/.test(k))!]));
    expect(Object.keys(json.layers[0])).not.toContain('preview_adjust');
    expect(decodePng(zip[json.layers[0].path_in_3mf])!.pixels.every((v) => v === 255)).toBe(true);
    S.undo();
    expect(stackOf(S.getObject(id)!)!.layers[0].image).toEqual(PNG);
  });
});

describe('Fast view inputs', () => {
  it('uniforms mirror the layer (desktop render_shaded_preview_mesh)', () => {
    S.resetProject();
    S.addParsedObjects([{ name: 'Cube', ...cube(), transform: null }]);
    const id = S.objects.value[0].id;
    addTextureLayer(id, { name: 'A', path: 'A.png', image: PNG });
    updateTextureLayer(id, 0, { depth_mm: 0.8, tiling_scale: 5, rotation_deg: 90, offset: [0.25, -0.5], invert: true, midlevel: 0.5, tile_method: 1, projection_method: 1 });
    const l = stackOf(S.getObject(id)!)!.layers[0];
    const u = fastUniformValues(l, { width: 1024, height: 512 }, [1, 2, 3], null);
    expect(u).toMatchObject({ tdDepth: 0.8, tdTiling: 5, tdAspect: 2, tdOffset: [0.25, -0.5], tdInvert: true, tdMidlevel: 0.5, tdMirrored: true, tdProjection: 1, tdAnchor: [1, 2, 3], tdTile: true });
    expect(u.tdRotation).toBeCloseTo(Math.PI / 2);
    expect(u.tdTexel).toEqual([1 / 1024, 1 / 512]);
    expect(offsetOf(withFields(l, { offset: 'x' }))).toEqual([0, 0]);
    expect(fastViewable(l)).toBe(true);
    expect(fastViewable(withFields(l, { projection_method: 3 }))).toBe(false);
    expect(fastViewable(withFields(l, {}, null))).toBe(false);
  });

  it('patch frame: corner mean, and the world axis least aligned with the average normal', () => {
    const c = cube();
    const side = new Uint32Array([1, 2, 6, 1, 6, 5]); // +X face
    const f = patchFrame(c.positions, side, new Matrix4(), [0, 0, 0]);
    expect(f.center.x).toBeCloseTo(10);
    expect(f.axis.toArray()).toEqual([0, 1, 0]);
  });
});
