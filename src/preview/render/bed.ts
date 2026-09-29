/**
 * Build plate for the preview: plate polygon, 10 mm grid (50 mm major),
 * outline, exclude areas and a small origin marker — theme colours read from
 * the CSS custom properties so it matches the rest of the app.
 */
import * as THREE from 'three';
import type { BedShape } from '../../app/state';

export interface BedColors { plate: string; grid: string; gridMajor: string; outline: string; exclude: string }

export function readBedColors(el: Element): BedColors {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    plate: v('--bg-2', '#1c2027'),
    grid: v('--line', '#2c323c'),
    gridMajor: v('--line-strong', '#3a414d'),
    outline: v('--fg-2', '#7d8591'),
    exclude: v('--danger', '#ef5b5b'),
  };
}

export function buildBed(bed: BedShape, colors: BedColors): THREE.Group {
  const g = new THREE.Group();
  g.name = 'preview-bed';

  const shape = new THREE.Shape(bed.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  const plate = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: colors.plate, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  );
  plate.position.z = -0.02;
  plate.renderOrder = -2;
  g.add(plate);

  const [x0, y0] = bed.min, [x1, y1] = bed.max;
  const minor: number[] = [], major: number[] = [];
  const step = 10;
  for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-6; x += step) {
    (Math.round(x) % 50 === 0 ? major : minor).push(x, y0, 0, x, y1, 0);
  }
  for (let y = Math.ceil(y0 / step) * step; y <= y1 + 1e-6; y += step) {
    (Math.round(y) % 50 === 0 ? major : minor).push(x0, y, 0, x1, y, 0);
  }
  const lines = (pts: number[], color: string) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthWrite: false }));
    l.position.z = -0.01;
    l.renderOrder = -1;
    return l;
  };
  if (minor.length) g.add(lines(minor, colors.grid));
  if (major.length) g.add(lines(major, colors.gridMajor));

  const outline: number[] = [];
  for (let i = 0; i < bed.polygon.length; i++) {
    const a = bed.polygon[i], b = bed.polygon[(i + 1) % bed.polygon.length];
    outline.push(a[0], a[1], 0, b[0], b[1], 0);
  }
  g.add(lines(outline, colors.outline));

  for (const area of bed.excludeAreas) {
    const s = new THREE.Shape(area.map(([x, y]) => new THREE.Vector2(x, y)));
    const m = new THREE.Mesh(
      new THREE.ShapeGeometry(s),
      new THREE.MeshBasicMaterial({ color: colors.exclude, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.position.z = -0.005;
    g.add(m);
  }

  // Origin marker: short X (red) / Y (green) ticks.
  const ax = new THREE.BufferGeometry();
  ax.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 12, 0], 3));
  ax.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 1, 0.4, 0.3, 1, 0.4], 3));
  const axes = new THREE.LineSegments(ax, new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false }));
  axes.position.set(bed.min[0], bed.min[1], 0);
  g.add(axes);
  return g;
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
