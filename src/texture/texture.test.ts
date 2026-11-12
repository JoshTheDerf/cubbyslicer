// Texture displacement: desktop's JSON (texture_displacement_layers_to_json / _from_json), the PNGs layers
// carry, the store commands (undo / redo, bake commit) and desktop's 3MF layout on save → open.
import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import * as S from '../project/store';
import { parseOrca3mf } from '../project/import/orca3mf';
import { orcaProjectData, openOrcaProject } from '../project/orcaOpen';
import { buildOrca3mf } from '../project/persistence/orca3mfWriter';
import { packTool } from '../engine/worker/pack';
import { bakeRequests, meshMoved, overallPercent } from './bake';
import { addTextureLayer, eraseWholeModel, paintedSlotsOf, removeTextureLayer, selectWholeModel, stackOf, updateTextureLayer } from './commands';
import { TEXTURE_DIR, defaultLayerJson, freeSlot, layerSlot, maskFits, stackFromJson, stackToJson, wholeMask } from './model';
import { RADIUS_MAX, RADIUS_MIN, maskUi, pressPaints, toolKind, wheelStep } from './paint';
import { maxStateFor } from '../paint/state';
import { sanitizeTexture, takeVolumeTexture } from './persist';
import { encodeTexturePng, isDecodable8bitPng, pngInfo } from './png';

const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function cube(s = 20): { positions: Float32Array; indices: Uint32Array } {
  const h = s / 2;
  return {
    positions: new Float32Array([-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0, -h, -h, s, h, -h, s, h, h, s, -h, h, s]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
  };
}
const PNG = encodeTexturePng(2, 2, new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]));
const tex = (name = 'Bricks') => ({ name, path: `${name}.png`, image: PNG });

function addCube(name = 'Cube'): string {
  S.addParsedObjects([{ name, ...cube(), transform: null }]);
  return S.objects.value[S.objects.value.length - 1].id;
}

describe('PNG', () => {
  it('encodes grey images as 8-bit greyscale and colour ones as RGB (encode_png_bytes)', () => {
    expect(pngInfo(PNG)).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: 0 });
    const colour = encodeTexturePng(1, 1, new Uint8Array([255, 0, 0, 128]));
    expect(pngInfo(colour)?.colorType).toBe(2);
    expect(isDecodable8bitPng(PNG) && isDecodable8bitPng(colour)).toBe(true);
    expect(isDecodable8bitPng(new Uint8Array([1, 2, 3]))).toBe(false);
    // IDAT holds the filtered rows: filter byte 0 + one grey byte per pixel.
    const idat = PNG.indexOf(0x49, 33); // 'I' of IDAT
    const len = new DataView(PNG.buffer).getUint32(idat - 4);
    expect([...unzlibSync(PNG.subarray(idat + 4, idat + 4 + len))]).toEqual([0, 0, 255, 0, 255, 0]);
  });
});

describe('desktop JSON', () => {
  it('round-trips layers, keeps fields it does not edit, names images by archive path', () => {
    const json = JSON.stringify({ version: 1, options: { panel_mode: 1, future: 'x' }, layers: [
      { slot: 2, name: 'Knurl', path_in_3mf: 'Metadata/texture_displacement/5_2.png', depth_mm: 1.2, islands: [[1, 2, 30, 1]], view_project_matrix: new Array(12).fill(0.5) },
    ] });
    const s = stackFromJson(json, (p) => (p === 'Metadata/texture_displacement/5_2.png' ? PNG : undefined))!;
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0].image).toBe(PNG);
    expect(s.layers[0].json).not.toHaveProperty('path_in_3mf');
    expect(s.options).toEqual({ panel_mode: 1, future: 'x' });
    const back = JSON.parse(stackToJson(s, new Map([[2, 'Metadata/texture_displacement/9_2.png']])));
    expect(back.layers[0]).toMatchObject({ ...defaultLayerJson(2), name: 'Knurl', depth_mm: 1.2, islands: [[1, 2, 30, 1]], view_project_matrix: new Array(12).fill(0.5), path_in_3mf: 'Metadata/texture_displacement/9_2.png' });
    expect(back.options).toMatchObject({ panel_mode: 1, future: 'x', pipeline_v2: true, v2_max_triangles_k: -1 });
  });

  it('rejects what desktop rejects', () => {
    const img = () => undefined;
    expect(stackFromJson('{not json', img)).toBeNull();
    expect(stackFromJson('[]', img)).toBeNull();
    expect(stackFromJson('{"layers":[{"name":"no slot"}]}', img)).toBeNull();
    expect(stackFromJson('{"layers":[{"slot":8}]}', img)).toBeNull();
    expect(stackFromJson('{"layers":[{"slot":0,"offset":["a",1]}]}', img)).toBeNull();
    expect(stackFromJson('{"layers":[{"slot":0,"islands":[[1,"x",2,3]]}]}', img)).toBeNull();
    // A wrong-typed scalar keeps its default (read()): still a valid document.
    expect(stackFromJson('{"layers":[{"slot":0,"depth_mm":"deep"}]}', img)?.layers).toHaveLength(1);
  });

  it('whole-model masks and free slots', () => {
    expect(wholeMask(3)).toEqual([[0, '4'], [1, '4'], [2, '4']]);
    expect(freeSlot(undefined)).toBe(0);
    const s = stackFromJson('{"layers":[{"slot":0},{"slot":1},{"slot":3}]}', () => undefined)!;
    expect(freeSlot(s)).toBe(2);
  });

  it('3MF volumes: the key and masks are taken out, the rest passes through', () => {
    const files: Record<string, Uint8Array> = { 'Metadata/texture_displacement/7.json': new TextEncoder().encode('{"layers":[{"slot":0,"path_in_3mf":"Metadata/texture_displacement/7_0.png"}]}'), 'Metadata/texture_displacement/7_0.png': PNG };
    const t = takeVolumeTexture([['source_file', 'a.stl'], ['texture_displacement', 'Metadata/texture_displacement/7.json']],
      { paint_texture_0: [[1, '4']], face_property: [[0, 'x']] }, (p) => files[p]);
    expect(t.meshMetadata).toEqual([['source_file', 'a.stl']]);
    expect(t.triangleAttrs).toEqual({ face_property: [[0, 'x']] });
    expect(t.texture?.masks).toEqual({ 0: [[1, '4']] });
    expect(t.texture?.stack?.layers[0].image).toBe(PNG);
    const missing = takeVolumeTexture([['texture_displacement', 'Metadata/texture_displacement/1.json']], undefined, () => undefined);
    expect(missing.texture).toBeUndefined();
    expect(missing.warning).toMatch(/Missing texture displacement data/);
  });

  it('autosave records are validated', () => {
    const ids = new Set(['m1']);
    const clean = sanitizeTexture({
      m1: { stack: { layers: [{ json: { slot: 0, depth_mm: 1 }, image: PNG }, { json: { slot: 0 } }, { json: { slot: 12 } }, 'junk'], options: { a: 1 } }, masks: { 0: [[0, '4'], [1, 'zz']], 9: [[0, '4']] } },
      m2: { masks: { 0: [[0, '4']] } },
    }, ids);
    expect(Object.keys(clean)).toEqual(['m1']);
    expect(clean.m1.stack?.layers.map(layerSlot)).toEqual([0]);
    expect(clean.m1.stack?.layers[0].image).toBe(PNG);
    expect(clean.m1.masks).toEqual({ 0: [[0, '4']] });
  });
});

describe('engine request', () => {
  it('packs texture images into the blob as {offset, length}', () => {
    const m = cube();
    const { json, blob } = packTool('texture_displacement', { images: { 0: PNG } }, [m]);
    const req = JSON.parse(new TextDecoder().decode(json));
    const ref = req.args.images['0'];
    expect(ref.length).toBe(PNG.length);
    expect(blob.subarray(ref.offset, ref.offset + ref.length)).toEqual(PNG);
    expect(ref.offset).toBe(m.positions.byteLength + m.indices.byteLength);
  });
});

describe('store commands', () => {
  beforeEach(() => S.resetProject());

  it('add layer, edit, whole model, remove: each one undo step', () => {
    const id = addCube();
    const o = () => S.getObject(id)!;
    expect(addTextureLayer(id, tex())).toBe(0);
    expect(stackOf(o())?.layers.map((l) => l.json.name)).toEqual(['Bricks']);
    expect(stackOf(o())?.options.active_slot).toBe(0);
    updateTextureLayer(id, 0, { depth_mm: 1 }, { mergeKey: 'd' });
    updateTextureLayer(id, 0, { depth_mm: 1.5 }, { mergeKey: 'd' });
    expect(stackOf(o())?.layers[0].json.depth_mm).toBe(1.5);
    selectWholeModel(id, 0);
    expect(paintedSlotsOf(o())).toEqual(new Set([0]));
    expect(S.getMeshTexture(o().meshId).masks?.['0']).toHaveLength(12);
    S.undo();
    expect(paintedSlotsOf(o()).size).toBe(0);
    S.undo(); // the depth drag was one step
    expect(stackOf(o())?.layers[0].json.depth_mm).toBe(0.4);
    S.redo(); S.redo();
    expect(paintedSlotsOf(o())).toEqual(new Set([0]));
    expect(addTextureLayer(id, tex('Knurl'))).toBe(1);
    selectWholeModel(id, 1);
    eraseWholeModel(id, 1);
    expect(paintedSlotsOf(o())).toEqual(new Set([0]));
    removeTextureLayer(id, 0);
    expect(stackOf(o())?.layers.map(layerSlot)).toEqual([1]);
    expect(paintedSlotsOf(o()).size).toBe(0);
    S.undo();
    expect(stackOf(o())?.layers.map(layerSlot)).toEqual([0, 1]);
    expect(paintedSlotsOf(o())).toEqual(new Set([0]));
  });

  it('bake requests carry the stack, masks, placement and preview budget; the commit moves the stack and clears masks', () => {
    const id = addCube();
    addTextureLayer(id, tex());
    expect(bakeRequests(S.getObject(id)!)).toEqual([]); // nothing painted
    selectWholeModel(id, 0);
    const o = S.getObject(id)!;
    const [req] = bakeRequests(o, { preview: true });
    expect(req.args.layers.layers[0]).toMatchObject({ slot: 0, name: 'Bricks', depth_mm: 0.4, path_in_3mf: '' });
    expect(req.args.layers.options.v2_max_triangles_k).toBe(0);
    expect(bakeRequests(o)[0].args.layers.options.v2_max_triangles_k).toBe(-1);
    expect(req.args.images['0']).toBe(PNG);
    expect(req.args.paint['0']).toHaveLength(12);
    expect(req.args.anchor).toEqual([o.position[0], o.position[1], o.position[2]]);
    expect(req.args.restingDrop).toBe(0);

    const base = S.getMesh(o.meshId)!;
    const moved = cube(22);
    expect(meshMoved(base, base.positions, base.indices)).toBe(false);
    expect(meshMoved(base, moved.positions, moved.indices)).toBe(true);
    const before = o.meshId;
    S.commitTextureBake(id, [{ partId: null, ...moved }]);
    const after = S.getObject(id)!;
    expect(after.meshId).not.toBe(before);
    expect(S.getMeshTexture(after.meshId).stack?.layers[0].json.name).toBe('Bricks');
    expect(S.getMeshTexture(after.meshId).masks).toBeUndefined();
    S.undo();
    expect(S.getObject(id)!.meshId).toBe(before);
    expect(paintedSlotsOf(S.getObject(id)!)).toEqual(new Set([0]));
  });

  it('a bake carries the part\'s other painting (desktop transfer_facet_paint); undo restores mesh and paint', () => {
    const id = addCube();
    addTextureLayer(id, tex());
    selectWholeModel(id, 0);
    const before = S.getObject(id)!.meshId;
    const support = [[0, '1'], [1, '1']] as Array<[number, string]>;
    const color = [[2, '8']] as Array<[number, string]>;
    S.setMeshPaint(before, 'support', support, 'Paint supports');
    S.setMeshPaint(before, 'color', color, 'Paint color');
    const o = S.getObject(id)!;
    // The preview never carries paint; the bake hands over every painted channel.
    expect(bakeRequests(o, { preview: true })[0].args.carryPaint).toBeUndefined();
    expect(bakeRequests(o)[0].args.carryPaint).toEqual({ support, color });

    const moved = cube(22);
    const carried = { support: [[5, '1']] as Array<[number, string]>, color: [[7, '8'], [8, '8']] as Array<[number, string]> };
    S.commitTextureBake(id, [{ partId: null, ...moved, paint: carried }]);
    const after = S.getObject(id)!.meshId;
    expect(after).not.toBe(before);
    expect(S.getMeshPaint(after)).toEqual(carried);
    S.undo();
    expect(S.getObject(id)!.meshId).toBe(before);
    expect(S.getMeshPaint(before)).toEqual({ support, color });
    expect(paintedSlotsOf(S.getObject(id)!)).toEqual(new Set([0]));
    S.redo();
    expect(S.getMeshPaint(S.getObject(id)!.meshId)).toEqual(carried);
  });

  it('bake progress: one 0..100 range over all parts, like desktop\'s bake job', () => {
    expect(overallPercent(0, 1, 42)).toBe(42);
    expect(overallPercent(0, 2, 100)).toBe(50);
    expect(overallPercent(1, 2, 50)).toBe(75);
    expect(overallPercent(2, 3, 150)).toBe(100);
    expect(overallPercent(0, 0, -5)).toBe(0);
  });

  it('saves in desktop’s layout and opens back (Orca reader and our own project)', async () => {
    const id = addCube();
    addTextureLayer(id, tex());
    updateTextureLayer(id, 0, { depth_mm: 0.8, projection_method: 1 });
    selectWholeModel(id, 0);
    const saved = buildOrca3mf();
    const zip = unzipSync(saved);
    const settings = strFromU8(zip['Metadata/model_settings.config']);
    const key = /<metadata key="texture_displacement" value="([^"]+)"\/>/.exec(settings)?.[1];
    expect(key).toMatch(/^Metadata\/texture_displacement\/\d+\.json$/);
    const json = JSON.parse(strFromU8(zip[key!]));
    expect(json.layers[0]).toMatchObject({ slot: 0, name: 'Bricks', depth_mm: 0.8, projection_method: 1 });
    expect(zip[json.layers[0].path_in_3mf]).toEqual(PNG);
    expect(strFromU8(zip['3D/Objects/object_1.model']).match(/paint_texture_0="4"/g)).toHaveLength(12);

    // As desktop's reader sees it.
    const proj = parseOrca3mf(buf(saved));
    const conv = orcaProjectData(proj, { name: 'x', schema: null, bed: S.bed.value });
    const t = Object.values(conv.data.texture ?? {});
    expect(t).toHaveLength(1);
    expect(t[0].stack?.layers[0].json).toMatchObject({ depth_mm: 0.8, projection_method: 1 });
    expect(t[0].masks?.['0']).toHaveLength(12);
    expect(Object.keys(conv.passthrough.files ?? {}).some((k) => k.startsWith(TEXTURE_DIR))).toBe(false);

    // Our own project file.
    S.resetProject();
    const r = await openOrcaProject('again.3mf', buf(saved));
    expect(r.own).toBe(true);
    const o = S.objects.value[0];
    expect(stackOf(o)?.layers[0].json).toMatchObject({ depth_mm: 0.8 });
    expect(stackOf(o)?.layers[0].image).toEqual(PNG);
    expect(paintedSlotsOf(o)).toEqual(new Set([0]));
  });
});

describe('mask painting', () => {
  it('buttons: the right button does the opposite of Paint / Erase, Shift always erases', () => {
    expect(pressPaints(0, false, false)).toBe(true);
    expect(pressPaints(2, false, false)).toBe(false);
    expect(pressPaints(0, true, false)).toBe(false);
    expect(pressPaints(0, false, true)).toBe(false);
    expect(pressPaints(2, false, true)).toBe(true);
    expect(pressPaints(2, true, true)).toBe(false);
  });

  it('tools map to the engine operations; masks use one state', () => {
    expect(toolKind('brush', 'circle')).toBe('circle');
    expect(toolKind('brush', 'sphere')).toBe('sphere');
    expect(toolKind('face', 'circle')).toBe('pointer');
    expect(toolKind('area', 'sphere')).toBe('fill');
    expect(maxStateFor('texture')).toBe(1);
  });

  it('Ctrl / Alt + wheel steps the brush size and the angle within desktop\'s limits', () => {
    maskUi.radius = 1; maskUi.angle = 30;
    wheelStep('brush', true);
    expect(maskUi.radius).toBe(1.2);
    for (let i = 0; i < 100; i++) wheelStep('brush', true);
    expect(maskUi.radius).toBe(RADIUS_MAX);
    for (let i = 0; i < 100; i++) wheelStep('brush', false);
    expect(maskUi.radius).toBe(RADIUS_MIN);
    wheelStep('area', false);
    expect(maskUi.angle).toBe(29);
    for (let i = 0; i < 100; i++) wheelStep('area', true);
    expect(maskUi.angle).toBe(90);
    wheelStep('face', true);
    expect(maskUi.angle).toBe(90);
  });

  it('a mask recorded for another mesh is not edited', () => {
    expect(maskFits(undefined, 12)).toBe(true);
    expect(maskFits([[0, '4'], [11, '1C']], 12)).toBe(true);
    expect(maskFits([[12, '4']], 12)).toBe(false);
  });

  it('a partial (split) mask is saved as paint_texture_N, read back, and only its parts go to the engine', async () => {
    S.resetProject();
    const id = addCube();
    addTextureLayer(id, tex());
    const meshId = S.getObject(id)!.meshId;
    // As a brush stroke leaves it: two split triangles of one face.
    S.setTextureMasks([{ meshId, slot: 0, mask: [[2, '1C1C0'], [3, '2C']] }], 'Paint texture displacement');
    expect(S.historyState.value.undo).toBe('Paint texture displacement');
    const [req] = bakeRequests(S.getObject(id)!, { preview: true });
    expect(req.args.paint['0']).toEqual([[2, '1C1C0'], [3, '2C']]);
    const model = strFromU8(unzipSync(buildOrca3mf())['3D/Objects/object_1.model']);
    expect(model.match(/paint_texture_0="[^"]+"/g)).toEqual(['paint_texture_0="1C1C0"', 'paint_texture_0="2C"']);
    const saved = buildOrca3mf();
    S.resetProject();
    await openOrcaProject('again.3mf', buf(saved));
    const o = S.objects.value[0];
    expect(S.getMeshTexture(o.meshId).masks?.['0']).toEqual([[2, '1C1C0'], [3, '2C']]);
  });
});

