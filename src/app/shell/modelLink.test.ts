import { describe, expect, it } from 'vitest';
import { dispositionName, parseArrange, parseModelLinkParams, parseRotate, parseSpacing, resolveLinkName } from './modelLink';

const BASE = 'https://cubbycad.com/slicer/';
const q = (s: string) => new URLSearchParams(s);
const none = { disposition: null, contentType: null };
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const BIN = new Uint8Array([0x73, 0x6f, 0x6c, 0x69]);

describe('parseArrange', () => {
  it('maps modes', () => {
    expect(parseArrange(null)).toBe('default');
    for (const v of ['', '1', 'true', 'all', 'ALL']) expect(parseArrange(v)).toBe('all');
    expect(parseArrange('plate')).toBe('plate');
    for (const v of ['0', 'false', 'off']) expect(parseArrange(v)).toBe('off');
    expect(parseArrange('sideways')).toBe('default');
  });
});

describe('parseModelLinkParams', () => {
  it('pairs names with models in order and rejects non-http links', () => {
    const r = parseModelLinkParams(q(`model=${encodeURIComponent('https://x.com/a.stl')}&model=javascript:alert(1)&model=${encodeURIComponent('https://x.com/dl?id=2')}&name=a.stl&name=&name=../b.3mf&arrange=plate`), BASE);
    expect(r.models).toEqual([
      { url: 'https://x.com/a.stl', name: 'a.stl' },
      { url: 'https://x.com/dl?id=2', name: 'b.3mf' },
    ]);
    expect(r.invalid).toEqual(['javascript:alert(1)']);
    expect(r.arrange).toBe('plate');
  });
  it('resolves relative links against the page', () => {
    expect(parseModelLinkParams(q('model=/files/a.3mf'), BASE).models[0].url).toBe('https://cubbycad.com/files/a.3mf');
  });
});

describe('resolveLinkName', () => {
  it('prefers name, then Content-Disposition, then the URL path', () => {
    expect(resolveLinkName({ url: 'https://x.com/p.stl', name: 'n.3mf' }, none, BIN)).toBe('n.3mf');
    expect(resolveLinkName({ url: 'https://x.com/dl?id=1', name: null }, { disposition: 'attachment; filename="Bracket v2.3mf"', contentType: null }, ZIP)).toBe('Bracket v2.3mf');
    expect(resolveLinkName({ url: 'https://x.com/My%20Part.3mf?sig=abc', name: null }, none, ZIP)).toBe('My Part.3mf');
  });
  it('sniffs 3MF from type or zip bytes when no name has an extension', () => {
    expect(resolveLinkName({ url: 'https://x.com/dl', name: null }, { disposition: null, contentType: 'model/3mf' }, BIN)).toBe('dl.3mf');
    expect(resolveLinkName({ url: 'https://x.com/dl', name: null }, { disposition: null, contentType: 'application/octet-stream' }, ZIP)).toBe('dl.3mf');
    expect(resolveLinkName({ url: 'https://x.com/', name: null }, none, BIN)).toBe('model.stl');
  });
  it('reads RFC 5987 filenames', () => {
    expect(dispositionName("attachment; filename*=UTF-8''caf%C3%A9.3mf")).toBe('café.3mf');
    expect(dispositionName('inline')).toBeNull();
  });
});

describe('arrange options', () => {
  it('spacing: mm or auto, default auto', () => {
    expect(parseSpacing(null)).toBe(0);
    expect(parseSpacing('auto')).toBe(0);
    expect(parseSpacing('12.5')).toBe(12.5);
    expect(parseSpacing('8mm')).toBe(8);
    expect(parseSpacing('-1')).toBeNull();
    expect(parseSpacing('wide')).toBeNull();
  });
  it('rotate: on unless turned off', () => {
    expect(parseRotate(null)).toBe(true);
    expect(parseRotate('1')).toBe(true);
    expect(parseRotate('0')).toBe(false);
    expect(parseRotate('false')).toBe(false);
    expect(parseRotate('maybe')).toBeNull();
  });
  it('links default to auto spacing with rotation, and report bad values', () => {
    expect(parseModelLinkParams(q('model=https://x.com/a.stl&arrange=all'), BASE).options).toEqual({ distance: 0, enableRotation: true });
    const r = parseModelLinkParams(q('model=https://x.com/a.stl&arrange=plate&spacing=10&rotate=0'), BASE);
    expect(r.options).toEqual({ distance: 10, enableRotation: false });
    const bad = parseModelLinkParams(q('model=https://x.com/a.stl&spacing=wide&rotate=maybe'), BASE);
    expect(bad.options).toEqual({ distance: 0, enableRotation: true });
    expect(bad.warnings).toHaveLength(2);
  });
});
