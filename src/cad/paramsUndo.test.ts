import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as S from '../project/store';
import { resolvedConfig } from '../app/state';
import { createPrimitiveNode, type CadNode } from './api';

// The worker evaluation (warmCadMesh) waits for the test to release it: an undo can arrive
// while a slider's last value is still being evaluated.
const gate = vi.hoisted(() => ({ held: false, waiting: [] as (() => void)[] }));
vi.mock('./build', async (orig) => {
  const m = await orig<typeof import('./build')>();
  return {
    ...m,
    warmCadMesh: async (node: CadNode) => {
      if (gate.held) await new Promise<void>((r) => gate.waiting.push(r));
      return m.warmCadMesh(node);
    },
  };
});
const C = await import('./commands');
const { ensureCadWasm } = await import('./build');

const box = (w: number) => createPrimitiveNode('box', { params: { width: w, depth: 20, height: 20 } }) as CadNode;
const width = (id: string) => (S.getObject(id)!.cad!.node as unknown as { geometry: { params: { width: number } } }).geometry.params.width;
const release = async () => {
  gate.held = false;
  for (const r of gate.waiting.splice(0)) r();
  await vi.waitFor(() => expect(C.paramsIdle()).toBe(true));
  await new Promise((r) => setTimeout(r, 20)); // anything late would have landed by now
};

beforeAll(async () => { await ensureCadWasm(); });
beforeEach(() => {
  resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250' };
  S.resetProject();
  gate.held = false;
});

describe('slider drag + undo race', () => {
  it('undo while the drag’s only value is evaluating drops it and keeps the step before', async () => {
    const [id] = S.addCadObjects([{ node: box(20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    C.queueParam(id, nid, 'width', 40); // previous step: width 20 → 40
    C.commitParams();
    await vi.waitFor(() => expect(C.paramsIdle()).toBe(true));
    expect(width(id)).toBe(40);

    gate.held = true;
    for (const w of [44, 48, 52]) C.queueParam(id, nid, 'width', w);
    C.commitParams();
    expect(gate.waiting.length).toBe(1); // evaluation outstanding
    expect(S.undo()).toBe('Change shape');
    expect(width(id)).toBe(40);
    await release();
    expect(width(id)).toBe(40); // no late commit
    expect(S.historyState.value.undo).toBe('Change shape'); // the 20 → 40 step is still there
    S.undo();
    expect(width(id)).toBe(20);
  });

  it('undo while the drag’s last value is evaluating takes back the whole drag', async () => {
    const [id] = S.addCadObjects([{ node: box(20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    C.queueParam(id, nid, 'width', 30); // mid-drag value, recorded
    await vi.waitFor(() => expect(width(id)).toBe(30));
    await vi.waitFor(() => expect(C.paramsIdle()).toBe(true));

    gate.held = true;
    C.queueParam(id, nid, 'width', 36, true); // release: the final value is evaluating
    expect(gate.waiting.length).toBe(1);
    S.undo();
    expect(width(id)).toBe(20);
    await release();
    expect(width(id)).toBe(20);
    expect(S.historyState.value.undo).toBe('Add Box');
    expect(S.historyState.value.redo).toBe('Change shape');
  });

  it('redo while an edit is evaluating is refused and the edit lands', async () => {
    const [id] = S.addCadObjects([{ node: box(20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    gate.held = true;
    C.queueParam(id, nid, 'width', 25, true);
    expect(S.redo()).toBeNull();
    await release();
    expect(width(id)).toBe(25);
  });

  it('a project load cancels a pending edit', async () => {
    const [id] = S.addCadObjects([{ node: box(20) }]);
    const nid = S.getObject(id)!.cad!.node.id;
    gate.held = true;
    C.queueParam(id, nid, 'width', 25, true);
    S.resetProject();
    await release();
    expect(S.objects.value).toHaveLength(0);
    expect(S.historyState.value.undo).toBeNull();
  });
});
