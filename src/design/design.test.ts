import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import * as S from '../project/store';
import { resolvedConfig } from '../app/state';
import { getOrcaCadRecipe, setOrcaCadRecipe } from '../project/persistence/passthrough';
import { sanitizeObjects } from '../project/persistence/format';
import { CadKernel, KernelReset } from './kernel/client';
import { FakeKernel, FAIL_SIZE } from './kernel/fake';
import { design, designKernel, designReady, displayBodies, setDesignBackend } from './session';
import * as C from './commands';
import { remapFeature, remapLink, resolveLink, sanitizeDesignLink } from './link';
import { editorFields } from './fields';
import { designUi } from './state';
import type { FeatureJson, SceneBody } from './kernel/types';

let fake: FakeKernel;
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await nextTick(); await designReady(); }
}
/** Load a project carrying `recipe` as its design (as an opener does: load, then the passthrough). */
async function openProject(recipe: Uint8Array | null): Promise<void> {
  S.resetProject();
  setOrcaCadRecipe(recipe);
  await settle();
}
const recipe3 = () => FakeKernel.recipe([
  { type: 'Sketch', name: 'Sketch 1' },
  { type: 'Extrude', name: 'Extrude 1', distance: 10, width: 20, height: 10, sketch_ref: 0 },
  { type: 'Fillet', name: 'Fillet 1', dressup_size: 1 },
]);

beforeEach(async () => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  fake = new FakeKernel();
  setDesignBackend(() => fake);
  S.resetProject();
  await nextTick();
});

describe('kernel client', () => {
  it('runs jobs one at a time, in order', async () => {
    const k = new CadKernel(() => new FakeKernel());
    const log: string[] = [];
    const a = k.run('a', async (c) => { log.push('a1'); await c.call('doc_new'); log.push('a2'); });
    const b = k.run('b', async () => { log.push('b'); });
    await Promise.all([a, b]);
    expect(log).toEqual(['a1', 'a2', 'b']);
    expect(k.status.phase).toBe('ready');
  });

  it('cancel terminates the instance, flushes the queue and tells listeners', async () => {
    const f = new FakeKernel();
    f.delayMs = 20;
    const k = new CadKernel(() => f);
    const resets: string[] = [];
    k.onReset((r) => resets.push(r));
    const slow = k.run('slow', async (c) => { await c.call('doc_new'); await c.call('doc_new'); }, { cancellable: true });
    const queued = k.run('queued', async () => 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(k.status.busy?.label).toBe('slow');
    expect(k.cancel()).toBe(true);
    await expect(slow).rejects.toBeInstanceOf(KernelReset);
    await expect(queued).rejects.toBeInstanceOf(KernelReset);
    expect(resets).toEqual(['cancel']);
    // The next job starts a fresh instance.
    await expect(k.run('again', async (c) => (await c.call<{ doc: number }>('doc_new')).result.doc)).resolves.toBeGreaterThan(0);
  });

  it('a trap is a crash: the job fails and the instance restarts', async () => {
    const f = new FakeKernel();
    const k = new CadKernel(() => f);
    const resets: string[] = [];
    k.onReset((r) => resets.push(r));
    f.trapOn = 'doc_new';
    // The fake throws from call(); the worker backend reports it as fatal → reset('crash').
    await expect(k.run('x', async (c) => c.call('doc_new'))).rejects.toThrow();
  });
});

describe('document lifecycle', () => {
  it('stays unloaded until the Design tab asks for it', async () => {
    setOrcaCadRecipe(recipe3());
    await nextTick();
    expect(design.phase).toBe('idle');
    expect(fake.calls).toEqual([]);
  });

  it('opens the project’s design, and a new empty one without', async () => {
    await openProject(recipe3());
    expect(design.phase).toBe('open');
    expect(design.features.map((f) => f.name)).toEqual(['Sketch 1', 'Extrude 1', 'Fillet 1']);
    expect(design.bodies).toHaveLength(1);
    expect(displayBodies.value[0].triFace.length).toBe(12);
    await openProject(null);
    expect(design.phase).toBe('open');
    expect(design.features).toEqual([]);
    expect(getOrcaCadRecipe()).toBeNull(); // an empty design isn't written into the project
  });

  it('opening and saving an unchanged design keeps its bytes', async () => {
    const r = recipe3();
    await openProject(r);
    expect(getOrcaCadRecipe()).toBe(r);
  });

  it('an unreadable design is kept as opaque bytes', async () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    await openProject(junk);
    expect(design.phase).toBe('unreadable');
    expect(getOrcaCadRecipe()).toBe(junk);
  });

  it('a newer recipe opens read-only and refuses edits', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Extrude', distance: 5 }], { version: 7 }));
    expect(design.readOnly).toBe(true);
    await expect(C.setFeatureParams(0, { distance: 6 })).rejects.toThrow(/read-only/);
  });

  it('a project reset clears the design', async () => {
    await openProject(recipe3());
    S.resetProject();
    await settle();
    expect(design.features).toEqual([]);
  });
});

describe('edits and undo', () => {
  it('a parameter edit is one undo step; undo / redo reopen the bytes', async () => {
    const r0 = recipe3();
    await openProject(r0);
    const out = await C.setFeatureParams(1, { distance: 25 });
    expect(out.ok).toBe(true);
    const r1 = getOrcaCadRecipe();
    expect(r1).not.toBe(r0);
    expect(design.bodies[0].bbox!.max[2]).toBe(25);
    expect(S.historyState.value.undo).toBe('Edit Extrude 1');
    S.undo();
    await settle();
    expect(getOrcaCadRecipe()).toBe(r0);
    expect(design.bodies[0].bbox!.max[2]).toBe(10);
    S.redo();
    await settle();
    expect(getOrcaCadRecipe()).toBe(r1);
    expect(design.bodies[0].bbox!.max[2]).toBe(25);
  });

  it('a refused edit changes nothing and is shown on its feature', async () => {
    await openProject(recipe3());
    const before = getOrcaCadRecipe();
    const r = await C.setFeatureParams(2, { dressup_size: FAIL_SIZE + 5 });
    expect(r.ok).toBe(false);
    expect(design.featureErrors[2]).toMatch(/too large/);
    expect(getOrcaCadRecipe()).toBe(before);
    expect(S.historyState.value.undo).toBeNull();
  });

  it('expressions and variables', async () => {
    await openProject(recipe3());
    expect((await C.setVariable('h', '12')).ok).toBe(true);
    expect((await C.setFeatureParams(1, {}, { distance: 'h*2' })).ok).toBe(true);
    expect(design.bodies[0].bbox!.max[2]).toBe(24);
    expect(design.variables).toEqual({ h: '12' });
    await expect(C.setVariable('bad name', '1')).rejects.toThrow(/letter/);
  });

  it('rename, reorder and delete', async () => {
    await openProject(recipe3());
    await C.renameFeature(2, 'Round');
    expect(design.features[2].name).toBe('Round');
    // A fillet above the body it rounds is refused (the kernel rolls back): shown on the feature.
    const r = await C.moveFeature(2, -1);
    expect(r.ok).toBe(false);
    expect(design.features[2].name).toBe('Round');
    expect(design.featureErrors[2]).toMatch(/needs a body/);
    await openProject(FakeKernel.recipe([{ type: 'Extrude', name: 'A' }, { type: 'Extrude', name: 'B' }, { type: 'Extrude', name: 'C' }]));
    designUi.selected = [2];
    expect((await C.moveFeature(2, -1)).ok).toBe(true);
    expect(design.features.map((f) => f.name)).toEqual(['A', 'C', 'B']);
    expect(designUi.selected).toEqual([1]);
    await C.deleteFeature(0);
    expect(design.features.map((f) => f.name)).toEqual(['C', 'B']);
    expect(designUi.selected).toEqual([0]);
  });

  it('a failing document: diagnosis finds the feature, force-suppress repairs it', async () => {
    await openProject(FakeKernel.recipe([
      { type: 'Sketch' }, { type: 'Extrude', distance: 10 },
      { type: 'Fillet', name: 'Too big', dressup_size: 50 }, { type: 'Chamfer', name: 'Also big', dressup_size: 40 },
      { type: 'Extrude', name: 'Second', distance: 5 },
    ]));
    expect(design.ok).toBe(false);
    expect(design.bodies).toEqual([]);
    await settle();
    expect(design.failing?.index).toBe(2);
    // One at a time can't repair it (feature 3 fails too) — force keeps the toggle.
    await C.setSuppressed([2], true);
    await settle();
    expect(design.features[2].enabled).toBe(false);
    expect(design.ok).toBe(false);
    expect(design.failing?.index).toBe(3);
    S.undo();
    await settle();
    expect(design.features[2].enabled).toBe(true);
    // Both at once: one rebuild, one undo step.
    await C.setSuppressed([2, 3], true, { force: true });
    expect(design.ok).toBe(true);
    expect(design.bodies).toHaveLength(2);
    expect(S.historyState.value.undo).toBe('Suppress 2 features');
  });

  it('an edit queued before an undo is refused', async () => {
    await openProject(recipe3());
    await C.setFeatureParams(1, { distance: 20 });
    const pending = C.setFeatureParams(1, { distance: 30 });
    S.undo();
    await expect(pending).rejects.toThrow(/changed while this edit was waiting/);
    await settle();
    expect(design.bodies[0].bbox!.max[2]).toBe(10);
  });

  it('an edit that finishes after an undo is discarded', async () => {
    await openProject(recipe3());
    await C.setFeatureParams(1, { distance: 20 });
    fake.delayMs = 5;
    const pending = C.setFeatureParams(1, { distance: 30 });
    await new Promise((r) => setTimeout(r, 2));
    S.undo(); // restores the original bytes while the kernel works on 20 → 30
    const r = await pending;
    expect(r.error).toBe('superseded');
    await settle();
    expect(design.bodies[0].bbox!.max[2]).toBe(10);
  });
});

describe('commit to plate (live link)', () => {
  it('commits bodies as linked objects that follow edits; undo restores both', async () => {
    await openProject(recipe3());
    const ids = await C.commitToPlate({ switchView: false });
    expect(ids).toHaveLength(1);
    const o = S.getObject(ids[0])!;
    expect(o.design).toMatchObject({ sourceFeature: 1, ordinal: 0, body: 0 });
    const m0 = o.meshId;
    expect(S.getMesh(m0)!.bbox.max[2] - S.getMesh(m0)!.bbox.min[2]).toBeCloseTo(10);
    // A rename doesn't touch the mesh.
    await C.renameFeature(0, 'Profile');
    expect(S.getObject(ids[0])!.meshId).toBe(m0);
    // A geometry edit replaces it, in the same undo step as the design.
    await C.setFeatureParams(1, { distance: 30 });
    const m1 = S.getObject(ids[0])!.meshId;
    expect(m1).not.toBe(m0);
    expect(S.getMesh(m1)!.bbox.max[2] - S.getMesh(m1)!.bbox.min[2]).toBeCloseTo(30);
    expect(S.objectInfo.value.get(ids[0])!.min[2]).toBeCloseTo(0);
    S.undo();
    await settle();
    expect(S.getObject(ids[0])!.meshId).toBe(m0);
    // Committing again doesn't duplicate.
    expect(await C.commitToPlate({ switchView: false })).toEqual(ids);
  });

  it('an edit that doesn’t change a body keeps its mesh (and paint)', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Extrude', name: 'A', distance: 10 }, { type: 'Extrude', name: 'B', distance: 5 }]));
    const ids = await C.commitToPlate({ switchView: false, mode: 'bodies' });
    expect(ids).toHaveLength(2);
    const [a, b] = ids.map((id) => S.getObject(id)!.meshId);
    await C.setFeatureParams(1, { distance: 8 });
    expect(S.getObject(ids[0])!.meshId).toBe(a);
    expect(S.getObject(ids[1])!.meshId).not.toBe(b);
  });

  it('deleting the source feature drops the link; the mesh stays', async () => {
    await openProject(FakeKernel.recipe([{ type: 'Extrude', name: 'A' }, { type: 'Extrude', name: 'B' }]));
    const ids = await C.commitToPlate({ switchView: false, mode: 'bodies' });
    await C.deleteFeature(0);
    expect(S.getObject(ids[0])!.design).toBeUndefined();
    expect(S.getObject(ids[1])!.design).toMatchObject({ sourceFeature: 0 });
  });

  it('a mesh-replacing tool drops the link, like a CubbyCAD tree', async () => {
    await openProject(recipe3());
    const [id] = await C.commitToPlate({ switchView: false });
    const m = S.getMesh(S.getObject(id)!.meshId)!;
    S.replaceWithPieces(id, [{ name: 'piece', volumes: [{ name: 'piece', type: 'part', positions: m.positions.slice(), indices: m.indices.slice() }] }]);
    expect(S.objects.value.every((o) => !o.design)).toBe(true);
  });

  it('links survive the project file and refuse junk', () => {
    const l = { sourceFeature: 3, ordinal: 1, body: 4, origin: [1, 2, 3] };
    expect(sanitizeDesignLink(l)).toEqual(l);
    expect(sanitizeDesignLink({ sourceFeature: -1 })).toBeUndefined();
    const objs = sanitizeObjects([{ id: 'o1', meshId: 'm1', design: l, position: [0, 0, 0] }], new Set(['m1']));
    expect(objs[0].design).toEqual(l);
  });
});

describe('links and fields', () => {
  const bodies = [{ index: 0, source_feature: 1 }, { index: 1, source_feature: 4 }, { index: 2, source_feature: 4 }] as SceneBody[];
  it('resolves a body by source feature and ordinal', () => {
    expect(resolveLink({ sourceFeature: 4, ordinal: 1, body: 9, origin: [0, 0, 0] }, bodies)).toBe(2);
    expect(resolveLink({ sourceFeature: 2, ordinal: 0, body: 0, origin: [0, 0, 0] }, bodies)).toBe(-1);
  });
  it('remaps feature indices through moves and deletes', () => {
    expect(remapFeature(3, { kind: 'move', from: 3, to: 1 })).toBe(1);
    expect(remapFeature(1, { kind: 'move', from: 3, to: 1 })).toBe(2);
    expect(remapFeature(5, { kind: 'delete', removed: [0, 2] })).toBe(3);
    expect(remapLink({ sourceFeature: 2, ordinal: 0, body: 0, origin: [0, 0, 0] }, { kind: 'delete', removed: [2] })).toBeNull();
  });
  it('builds editor rows from the kernel schema', () => {
    const f = { type: 'Extrude', name: 'E', enabled: true, expr: {}, sketch_ref: 0, distance: 10, extrude_end: 'Blind', distance2: 0, taper_deg: 0, mode: 'New', flip: false, target_body: -1 } as FeatureJson;
    const schema = [
      { name: 'sketch_ref', type: 'int' }, { name: 'distance', type: 'number' }, { name: 'distance2', type: 'number' }, { name: 'taper_deg', type: 'number' },
      { name: 'extrude_end', type: 'enum', enum: ['Blind', 'TwoSided'] }, { name: 'mode', type: 'enum', enum: ['New', 'Add'] }, { name: 'flip', type: 'bool' }, { name: 'target_body', type: 'int' },
    ];
    const rows = editorFields(f, schema, ['distance']);
    expect(rows.map((r) => `${r.key}:${r.kind}`)).toEqual(['sketch_ref:ref', 'distance:number', 'extrude_end:enum', 'taper_deg:number', 'mode:enum', 'flip:bool', 'target_body:ref']);
    expect(rows.find((r) => r.key === 'distance')!.bindable).toBe(true);
    expect(rows.find((r) => r.key === 'mode')!.choices![1].label).toBe('Join');
    expect(editorFields({ ...f, extrude_end: 'TwoSided' }, schema, []).some((r) => r.key === 'distance2')).toBe(true);
  });
});

describe('kernel reset recovery', () => {
  it('a cancelled edit reopens the last saved bytes', async () => {
    await openProject(recipe3());
    await C.setFeatureParams(1, { distance: 20 });
    const saved = getOrcaCadRecipe();
    fake.delayMs = 30;
    const p = C.setFeatureParams(1, { distance: 40 });
    await new Promise((r) => setTimeout(r, 10));
    designKernel().cancel();
    await expect(p).rejects.toBeInstanceOf(KernelReset);
    fake.delayMs = 0;
    await settle();
    expect(getOrcaCadRecipe()).toBe(saved);
    expect(design.phase).toBe('open');
    expect(design.bodies[0].bbox!.max[2]).toBe(20);
  });
});
