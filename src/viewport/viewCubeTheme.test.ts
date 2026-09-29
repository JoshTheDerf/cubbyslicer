/**
 * Ported from cad-project's viewCubeTheme.unit.test.ts: the dark cube must not
 * be a white block, every face keeps a readable label, and (slicer-specific)
 * the labels match the Z-up bed convention (front = -Y).
 */
import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { VIEW_CUBE_FACES, Z_UP_FACE_LABELS, viewCubeThemeOptions } from './viewCubeTheme';

const lum = (c: unknown) => {
  const k = new Color(c as string);
  return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
};

describe('viewCubeThemeOptions', () => {
  it('dark mode gives every face a dark fill with a light label', () => {
    const o = viewCubeThemeOptions(true);
    for (const f of VIEW_CUBE_FACES) {
      expect(lum(o[f]!.color), f).toBeLessThan(0.1);
      expect(lum(o[f]!.labelColor), f).toBeGreaterThan(0.6);
      expect(lum(o[f]!.hover!.labelColor), `${f} hover`).toBeGreaterThan(0.6);
    }
    expect(lum(o.edges!.color)).toBeLessThan(0.2);
    expect(lum(o.corners!.color)).toBeLessThan(0.2);
    expect(lum(o.background!.color)).toBeLessThan(0.1);
  });

  it('light mode keeps a light cube with dark labels', () => {
    const o = viewCubeThemeOptions(false);
    for (const f of VIEW_CUBE_FACES) {
      expect(lum(o[f]!.color), f).toBeGreaterThan(0.8);
      expect(lum(o[f]!.labelColor), f).toBeLessThan(0.1);
    }
  });

  it('labels faces for the Z-up bed: +Z top, -Y front, +X right', () => {
    const o = viewCubeThemeOptions(true);
    expect(o.z!.label).toBe('Top');
    expect(o.nz!.label).toBe('Bottom');
    expect(o.ny!.label).toBe('Front');
    expect(o.y!.label).toBe('Back');
    expect(o.x!.label).toBe('Right');
    expect(o.nx!.label).toBe('Left');
    expect(new Set(Object.values(Z_UP_FACE_LABELS)).size).toBe(6);
  });
});
