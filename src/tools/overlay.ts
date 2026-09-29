/**
 * three.js overlay helpers for the tools: a group living in the Prepare
 * scene with always-on-top points, lines, arcs, discs and triangle
 * highlights, plus world/mesh matrix helpers.
 */
import {
  BufferGeometry, CircleGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineSegments, Matrix4,
  Mesh, MeshBasicMaterial, Object3D, SphereGeometry, Vector3,
} from 'three';
import { composeTRS, type Quat, type Vec3 } from '../project/math';
import { getMesh, getObject } from '../project/store';
import type { MeshData } from '../project/types';
import { toolScene } from './state';

export const COLORS = {
  hover: 0x00c2ff,
  first: 0xff8a00,
  second: 0x3ddc84,
  dim: 0xffffff,
  warn: 0xef5b5b,
  ear: 0x37b24d,
  earSelected: 0xffd43b,
  preview: 0xa0e0ff,
};

function disposeTree(o: Object3D): void {
  o.traverse((x) => {
    const m = x as Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as { dispose?: () => void } | Array<{ dispose?: () => void }> | undefined;
    if (Array.isArray(mat)) mat.forEach((q) => q.dispose?.()); else mat?.dispose?.();
  });
}

export class ToolOverlay {
  readonly group = new Group();
  constructor(name: string) {
    this.group.name = `tool-${name}`;
    this.group.renderOrder = 20;
    toolScene.value?.scene.add(this.group);
  }
  /** Re-attach after the scene was recreated. */
  attach(): void {
    const s = toolScene.value?.scene;
    if (s && this.group.parent !== s) s.add(this.group);
  }
  clear(): void {
    for (const c of [...this.group.children]) { this.group.remove(c); disposeTree(c); }
  }
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    render();
  }
  add<T extends Object3D>(o: T): T { this.group.add(o); return o; }
}

export function render(): void { toolScene.value?.requestRender(); }

/** World size of one screen pixel at `p` (perspective or orthographic view). */
export function worldPerPixel(p: Vector3): number {
  return toolScene.value?.worldPerPixel(p) ?? 0.1;
}

const onTop = { depthTest: false, depthWrite: false, transparent: true };

export function pointMarker(p: Vec3 | Vector3, color: number, px = 5): Mesh {
  const v = p instanceof Vector3 ? p : new Vector3(...p);
  const m = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color, ...onTop }));
  m.position.copy(v);
  m.scale.setScalar(worldPerPixel(v) * px);
  m.renderOrder = 30;
  return m;
}

export function lineSegments(points: Array<Vec3 | Vector3>, color: number, opacity = 1): LineSegments {
  const arr: number[] = [];
  for (const p of points) { const v = p instanceof Vector3 ? p : new Vector3(...p); arr.push(v.x, v.y, v.z); }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(arr, 3));
  const l = new LineSegments(g, new LineBasicMaterial({ color, opacity, ...onTop }));
  l.renderOrder = 29;
  return l;
}

export function polyline(points: Array<Vec3 | Vector3>, color: number, closed = false): Line {
  const arr: number[] = [];
  const pts = closed ? [...points, points[0]] : points;
  for (const p of pts) { const v = p instanceof Vector3 ? p : new Vector3(...p); arr.push(v.x, v.y, v.z); }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(arr, 3));
  const l = new Line(g, new LineBasicMaterial({ color, ...onTop }));
  l.renderOrder = 29;
  return l;
}

/** Circle (polyline) with centre c, normal n, radius r. */
export function circleLine(c: Vec3, n: Vec3, r: number, color: number, segs = 64): Line {
  const nn = new Vector3(...n).normalize();
  const u = new Vector3().crossVectors(nn, Math.abs(nn.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
  const v = new Vector3().crossVectors(nn, u);
  const pts: Vector3[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(new Vector3(...c).addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r));
  }
  return polyline(pts, color, true);
}

/** Arc from direction a to direction b (unit vectors) around centre c. */
export function arcLine(c: Vec3, a: Vec3, b: Vec3, r: number, color: number): Line {
  const va = new Vector3(...a).normalize(), vb = new Vector3(...b).normalize();
  const ang = va.angleTo(vb);
  const axis = new Vector3().crossVectors(va, vb);
  if (axis.lengthSq() < 1e-12) axis.set(0, 0, 1);
  axis.normalize();
  const n = Math.max(8, Math.ceil((ang / Math.PI) * 48));
  const pts: Vector3[] = [];
  for (let i = 0; i <= n; i++) pts.push(va.clone().applyAxisAngle(axis, (ang * i) / n).multiplyScalar(r).add(new Vector3(...c)));
  return polyline(pts, color);
}

/** Triangles of a mesh (by index) as a translucent highlight, in the mesh's frame. */
export function triHighlight(mesh: MeshData, tris: number[], color: number, opacity = 0.45): Mesh {
  const pos = new Float32Array(tris.length * 9);
  let k = 0;
  for (const t of tris) {
    for (let j = 0; j < 3; j++) {
      const v = mesh.indices[t * 3 + j] * 3;
      pos[k++] = mesh.positions[v]; pos[k++] = mesh.positions[v + 1]; pos[k++] = mesh.positions[v + 2];
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const m = new Mesh(g, new MeshBasicMaterial({ color, opacity, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, transparent: true, depthWrite: false }));
  m.renderOrder = 25;
  return m;
}

export function disc(c: Vector3, r: number, color: number, opacity = 0.6): Mesh {
  const m = new Mesh(new CircleGeometry(r, 40), new MeshBasicMaterial({ color: new Color(color), opacity, transparent: true, side: DoubleSide, depthWrite: false }));
  m.position.copy(c);
  m.renderOrder = 26;
  return m;
}

// ---- matrices -------------------------------------------------------------------

/** Column-major mesh-local → world matrix of an object's own mesh or one of its parts. */
export function volumeMatrix(objectId: string, partId: string | null): number[] | null {
  const o = getObject(objectId);
  if (!o) return null;
  const om = composeTRS([...o.position] as Vec3, [...o.rotation] as Quat, [...o.scale] as Vec3);
  if (!partId) return om;
  const p = o.parts?.find((x) => x.id === partId);
  if (!p) return null;
  return new Matrix4().fromArray(om).multiply(new Matrix4().fromArray(composeTRS([...p.position] as Vec3, [...p.rotation] as Quat, [...p.scale] as Vec3))).toArray();
}

export function volumeMesh(objectId: string, partId: string | null): MeshData | undefined {
  const o = getObject(objectId);
  if (!o) return undefined;
  if (!partId) return getMesh(o.meshId);
  const p = o.parts?.find((x) => x.id === partId);
  return p ? getMesh(p.meshId) : undefined;
}
