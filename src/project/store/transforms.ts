/** Moving, rotating, scaling and mirroring objects (gizmo, numeric panel, orient commands). */
import { quatFromAxisAngle, quatFromUnitVectors, quatMultiply, quatNormalize, type Quat, type Vec3 } from '../math';
import { objectWorldInfo, plateOfInfo, plateOfLive } from './derived';
import { mutate } from './history';
import { dropObj, rectOf } from './placement';
import { activePlate, getObject, plateBedOf, selectedIds, targets } from './state';

/** Move objects by a bed-space delta (arrow-key nudges coalesce into one undo step). */
export function translateObjects(delta: Vec3, ids = selectedIds.value.slice()): void {
  mutate('Move', () => {
    for (const o of targets(ids)) o.position = [o.position[0] + delta[0], o.position[1] + delta[1], o.position[2] + delta[2]];
  }, { mergeKey: `nudge:${ids.join(',')}` });
}

export interface TransformPatch { id: string; position?: Vec3; rotation?: Quat; scale?: Vec3 }

/**
 * Apply transforms (gizmo drag end, numeric panel). Rotation/scale changes
 * keep the object on the bed; pure moves keep Z as given.
 */
export function setTransforms(patches: TransformPatch[], label = 'Move', opts: { drop?: boolean; mergeKey?: string } = {}): void {
  mutate(label, () => {
    for (const p of patches) {
      const o = getObject(p.id);
      if (!o) continue;
      const rs = !!(p.rotation || p.scale);
      if (p.position) o.position = [...p.position] as Vec3;
      if (p.rotation) o.rotation = quatNormalize(p.rotation);
      if (p.scale) o.scale = p.scale.map((s) => (Math.abs(s) < 1e-4 ? Math.sign(s || 1) * 1e-4 : s)) as Vec3;
      if (opts.drop ?? rs) dropObj(o);
    }
  }, { mergeKey: opts.mergeKey });
}

export function dropToBed(ids = selectedIds.value.slice()): void {
  mutate('Drop to bed', () => { for (const o of targets(ids)) dropObj(o); });
}

/** Centre the selection (as a group) on the bed. */
export function centerObjects(ids = selectedIds.value.slice()): void {
  const ts = targets(ids);
  if (!ts.length) return;
  mutate('Center', () => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of ts) {
      const r = rectOf(o);
      if (!r) continue;
      minX = Math.min(minX, r.minX); minY = Math.min(minY, r.minY);
      maxX = Math.max(maxX, r.maxX); maxY = Math.max(maxY, r.maxY);
    }
    if (!Number.isFinite(minX)) return;
    const p0 = plateOfLive(ts[0]);
    const b = plateBedOf(p0 >= 0 ? p0 : activePlate.value);
    const dx = (b.min[0] + b.max[0]) / 2 - (minX + maxX) / 2;
    const dy = (b.min[1] + b.max[1]) / 2 - (minY + maxY) / 2;
    for (const o of ts) o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2]];
  });
}

/** Mirror along a world axis, in place. */
export function mirrorObjects(axis: 0 | 1 | 2, ids = selectedIds.value.slice()): void {
  mutate(`Mirror ${'XYZ'[axis]}`, () => {
    for (const o of targets(ids)) {
      // F·R·S = (F·R·F)·(F·S): conjugated rotation + negated scale component.
      const q = o.rotation;
      const nq: Quat = axis === 0 ? [q[0], -q[1], -q[2], q[3]] : axis === 1 ? [-q[0], q[1], -q[2], q[3]] : [-q[0], -q[1], q[2], q[3]];
      const s = [...o.scale] as Vec3;
      s[axis] = -s[axis];
      o.rotation = nq;
      o.scale = s;
      dropObj(o);
    }
  });
}

/** Rotate about a world axis by `deg` degrees (about each object's origin). */
export function rotateObjects(axis: Vec3, deg: number, ids = selectedIds.value.slice()): void {
  const dq = quatFromAxisAngle(axis, (deg * Math.PI) / 180);
  mutate('Rotate', () => {
    for (const o of targets(ids)) { o.rotation = quatNormalize(quatMultiply(dq, o.rotation)); dropObj(o); }
  });
}

/** Rotate so the face with world-space normal `n` faces the bed. */
export function layOnFace(id: string, n: Vec3): void {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 0)) return;
  const dq = quatFromUnitVectors([n[0] / l, n[1] / l, n[2] / l], [0, 0, -1]);
  mutate('Lay on face', () => {
    const o = getObject(id);
    if (!o) return;
    o.rotation = quatNormalize(quatMultiply(dq, o.rotation));
    dropObj(o);
  });
}

/** Uniformly scale each target to the largest size fitting the build volume, then centre it. */
export function scaleToFit(ids = selectedIds.value.slice()): void {
  mutate('Scale to fit', () => {
    for (const o of targets(ids)) {
      const i = objectWorldInfo(o);
      if (!i) continue;
      const p = plateOfInfo(i);
      const b = plateBedOf(p >= 0 ? p : activePlate.value);
      const sx = i.max[0] - i.min[0], sy = i.max[1] - i.min[1], sz = i.max[2] - i.min[2];
      let f = Math.min(((b.max[0] - b.min[0]) * 0.98) / (sx || 1), ((b.max[1] - b.min[1]) * 0.98) / (sy || 1));
      if (b.maxHeight > 0) f = Math.min(f, (b.maxHeight * 0.98) / (sz || 1));
      if (!Number.isFinite(f) || f <= 0) continue;
      o.scale = o.scale.map((s) => s * f) as Vec3;
      dropObj(o);
      const j = objectWorldInfo(o)!;
      o.position = [
        o.position[0] + (b.min[0] + b.max[0]) / 2 - (j.min[0] + j.max[0]) / 2,
        o.position[1] + (b.min[1] + b.max[1]) / 2 - (j.min[1] + j.max[1]) / 2,
        o.position[2],
      ];
    }
  });
}
