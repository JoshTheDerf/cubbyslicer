/**
 * Plate object ↔ design body links (`ProjectObject.design`).
 *
 * Body indices change whenever a rebuild changes the body list (a suppressed feature, a new
 * body earlier in the history), so a link names its body the way Orca re-points body
 * references (CadDocument "renumber"): the feature that made it plus its rank among that
 * feature's bodies. Feature indices shift on history edits (move / delete); the commands that
 * make them remap every link in the same undo step (`remapLinks`).
 *
 * Links ride in the object (undo snapshots, clipboard, autosave, Metadata/cubby_slicer.json).
 * Desktop Orca drops them: it sees the committed meshes as plain objects, as Orca itself makes them.
 */
import type { Vec3 } from '../project/math';
import type { DesignLink } from '../project/types';
import type { SceneBody } from './kernel/types';

export type { DesignLink };

/** The identity of body `index` in `bodies`. */
export function bodyIdentity(bodies: readonly SceneBody[], index: number): { sourceFeature: number; ordinal: number } {
  const b = bodies[index];
  if (!b) return { sourceFeature: -1, ordinal: 0 };
  let ordinal = 0;
  for (let i = 0; i < index; i++) if (bodies[i].source_feature === b.source_feature) ordinal++;
  return { sourceFeature: b.source_feature, ordinal };
}

/** The body a link points at now (-1: none — its feature is suppressed or makes fewer bodies). */
export function resolveLink(link: DesignLink, bodies: readonly SceneBody[]): number {
  let ordinal = 0;
  for (const b of bodies) {
    if (b.source_feature !== link.sourceFeature) continue;
    if (ordinal++ === link.ordinal) return b.index;
  }
  return -1;
}

export function makeLink(bodies: readonly SceneBody[], index: number, origin: Vec3): DesignLink {
  return Object.freeze({ ...bodyIdentity(bodies, index), body: index, origin: [...origin] as Vec3 });
}

/** A history edit, for remapping feature indices. */
export type HistoryEdit =
  | { kind: 'move'; from: number; to: number }
  | { kind: 'delete'; removed: readonly number[] };

/** Where feature `i` is after `edit` (-1: deleted). */
export function remapFeature(i: number, edit: HistoryEdit): number {
  if (i < 0) return i;
  if (edit.kind === 'move') {
    const { from, to } = edit;
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (to < from && i >= to && i < from) return i + 1;
    return i;
  }
  if (edit.removed.includes(i)) return -1;
  return i - edit.removed.filter((r) => r < i).length;
}

/** The link after a history edit (null: the feature that made its body was deleted). */
export function remapLink(link: DesignLink, edit: HistoryEdit): DesignLink | null {
  const f = remapFeature(link.sourceFeature, edit);
  if (f < 0) return null;
  return f === link.sourceFeature ? link : Object.freeze({ ...link, sourceFeature: f });
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Validate an untrusted stored link (project file / autosave); undefined when unusable. */
export function sanitizeDesignLink(raw: unknown): DesignLink | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const sourceFeature = num(o.sourceFeature, -1), ordinal = num(o.ordinal, -1), body = num(o.body, -1);
  if (!Number.isInteger(sourceFeature) || sourceFeature < 0 || !Number.isInteger(ordinal) || ordinal < 0) return undefined;
  const or = Array.isArray(o.origin) ? o.origin : [];
  return Object.freeze({ sourceFeature, ordinal, body: Number.isInteger(body) ? body : -1, origin: [num(or[0], 0), num(or[1], 0), num(or[2], 0)] as Vec3 });
}
