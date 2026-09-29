import { describe, expect, it } from 'vitest';
import { ShapePath } from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { meshFromOutline, outlineFromPaths } from './svgMesh';
import { isClosedManifold, signedVolume } from '../geom/meshUtil';
import { weldVertices } from '../../project/mesh';

function squareWithHole(): ShapePath {
  const sp = new ShapePath();
  // SVG coordinates (y down): 0..100 square, 25..75 hole (opposite winding).
  sp.moveTo(0, 0); sp.lineTo(100, 0); sp.lineTo(100, 100); sp.lineTo(0, 100); sp.lineTo(0, 0);
  sp.moveTo(25, 25); sp.lineTo(25, 75); sp.lineTo(75, 75); sp.lineTo(75, 25); sp.lineTo(25, 25);
  return sp;
}

describe('svg emboss mesh', () => {
  it('extrudes a fill with a hole into a closed solid of the requested width', () => {
    const o = outlineFromPaths([{ shapePath: squareWithHole(), fill: true, stroke: false, style: { fill: '#000', fillRule: 'nonzero' } }]);
    expect(o.width).toBeCloseTo(100);
    const m = meshFromOutline(o, 20, 2)!;
    const w = weldVertices(m.positions, m.indices);
    expect(isClosedManifold(w.indices)).toBe(true);
    // 20x20 minus 10x10 hole, 2 mm deep
    expect(signedVolume(w.positions, w.indices)).toBeCloseTo((400 - 100) * 2, 3);
  });

  it('outlines strokes into solids', () => {
    const sp = new ShapePath();
    sp.moveTo(0, 0); sp.lineTo(50, 0);
    const style = SVGLoader.getStrokeStyle(4, '#000', 'miter', 'butt', 4);
    const o = outlineFromPaths([{ shapePath: sp, fill: false, stroke: true, style: style as unknown as Record<string, unknown> }]);
    expect(o.strokeContours.length).toBe(1);
    // y is flipped like the fills (SVG y down → y up)
    const ys = o.strokeContours[0].map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2, 3);
    const m = meshFromOutline(o, 50, 1)!;
    const w = weldVertices(m.positions, m.indices);
    expect(isClosedManifold(w.indices)).toBe(true);
    expect(signedVolume(w.positions, w.indices)).toBeCloseTo(50 * 4, 0);
  });

  it('reports an empty drawing', () => {
    const o = outlineFromPaths([]);
    expect(o.warnings.length).toBe(1);
    expect(meshFromOutline(o, 10, 1)).toBeNull();
  });
});
