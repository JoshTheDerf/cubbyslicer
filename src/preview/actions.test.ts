import { describe, expect, it } from 'vitest';
import { parseGcode } from './parser/parse';
import prusa from './__fixtures__/prusa-style.gcode?raw';
import { previewActions, registerPreviewActions } from './actions';
import { activeView } from '../app/state';
import { getAction } from '../app/actions/registry';
import type { AppContext } from '../app/actions/context';

const CTX = {} as AppContext;
import { colorScheme, layerHi, layerLo, moveIndex, previewData, previewOptions, setTopLayer, singleLayer } from './store';

const act = (id: string) => {
  const a = previewActions.find((x) => x.id === id);
  if (!a) throw new Error(`missing ${id}`);
  return a;
};

describe('preview actions', () => {
  it('ids are unique and bindings do not collide', () => {
    const ids = new Set(previewActions.map((a) => a.id));
    expect(ids.size).toBe(previewActions.length);
    const keys = previewActions.filter((a) => a.binding).map((a) => JSON.stringify(a.binding));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are gated to the preview view', () => {
    activeView.value = 'prepare';
    previewData.value = parseGcode(new TextEncoder().encode(prusa));
    expect(act('preview.layer.up').when!(CTX)).toBe(false);
    expect(act('preview.toggle.travel').when!(CTX)).toBe(false);
    activeView.value = 'preview';
    expect(act('preview.layer.up').when!(CTX)).toBe(true);
  });

  it('step layers and moves', () => {
    activeView.value = 'preview';
    const p = parseGcode(new TextEncoder().encode(prusa));
    previewData.value = p;
    layerLo.value = 0;
    setTopLayer(p.layerCount - 1);
    act('preview.layer.down').run(CTX);
    expect(layerHi.value).toBe(p.layerCount - 2);
    expect(moveIndex.value).toBe(p.layerStart[layerHi.value + 1] - p.layerStart[layerHi.value] - 1);
    act('preview.layer.up10').run(CTX);
    expect(layerHi.value).toBe(p.layerCount - 1);
    act('preview.layer.first').run(CTX);
    expect(layerHi.value).toBe(0);
    act('preview.move.layerEnd').run(CTX);
    const end = moveIndex.value;
    act('preview.move.prev').run(CTX);
    expect(moveIndex.value).toBe(end - 1);
    act('preview.move.prev10').run(CTX);
    expect(moveIndex.value).toBe(Math.max(0, end - 11));
  });

  it('toggles and scheme state', () => {
    activeView.value = 'preview';
    const t = act('preview.toggle.travel');
    const before = previewOptions.value.travel;
    t.run(CTX);
    expect(previewOptions.value.travel).toBe(!before);
    expect(t.state!(CTX)).toBe(!before ? 'on' : 'off');
    act('preview.scheme.speed').run(CTX);
    expect(colorScheme.value).toBe('speed');
    expect(act('preview.scheme.speed').state!(CTX)).toBe('active');
    expect(act('preview.scheme.feature').state!(CTX)).toBeUndefined();
  });

  it('one-layer mode keeps the bottom layer on the top layer', () => {
    activeView.value = 'preview';
    const p = parseGcode(new TextEncoder().encode(prusa));
    previewData.value = p;
    layerLo.value = 0;
    setTopLayer(p.layerCount - 1);
    const t = act('preview.toggle.singleLayer');
    t.run(CTX);
    expect(singleLayer.value).toBe(true);
    expect(t.state!(CTX)).toBe('on');
    expect(layerLo.value).toBe(layerHi.value);
    act('preview.layer.down').run(CTX);
    expect(layerHi.value).toBe(p.layerCount - 2);
    expect(layerLo.value).toBe(layerHi.value);
    t.run(CTX);
    expect(singleLayer.value).toBe(false);
    expect(layerLo.value).toBe(0);
  });

  it('toggles the Orca options', () => {
    activeView.value = 'preview';
    for (const [id, k] of [['preview.toggle.wipe', 'wipe'], ['preview.toggle.unretracts', 'unretracts'], ['preview.toggle.toolMarker', 'toolMarker']] as const) {
      const before = previewOptions.value[k];
      act(id).run(CTX);
      expect(previewOptions.value[k]).toBe(!before);
    }
  });

  it('registers with the app registry, scoped to preview', () => {
    const dispose = registerPreviewActions();
    expect(getAction('preview.layer.up')?.binding).toEqual({ key: 'arrowup', scope: 'preview' });
    expect(previewActions.every((a) => !a.binding || a.binding.scope === 'preview')).toBe(true);
    dispose();
    expect(getAction('preview.layer.up')).toBeUndefined();
  });
});
