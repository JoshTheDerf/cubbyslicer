/**
 * Desktop's solid_bodies (libslic3r/ConnectedBodies.cpp) for the centre of mass of an assembly: the union of
 * an object's model parts less its negative volumes, split into connected bodies, each part weighing its
 * filament's density — where parts overlap, the later one counts (it prints there). Modifiers and support
 * blockers / enforcers don't count.
 *
 * Desktop slices the assembly into 500 slabs and unites the slices of each slab; here the same union /
 * difference / connected bodies are computed exactly with manifold-3d (what the slabs approximate). A part
 * that isn't a closed mesh can't take part: the caller falls back to summing the parts as solids.
 */
import { loadManifold } from '../tools/boolean/boolean';

/** A part in the object's own frame: triangles, local transform (column-major 4×4), density. */
export interface BodyInput { positions: ArrayLike<number>; indices: ArrayLike<number>; transform: readonly number[]; density: number; negative: boolean }

/** One piece of a body printed by one part (the density it weighs). */
export interface BodyPiece { positions: Float32Array; indices: Uint32Array; density: number }
/** A connected body: the pieces it is made of, in the object's frame. */
export interface SolidBodyMesh { pieces: BodyPiece[] }

type Manifold = { add(o: Manifold): Manifold; subtract(o: Manifold): Manifold; intersect(o: Manifold): Manifold; decompose(): Manifold[];
  getMesh(): { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }; volume(): number; isEmpty(): boolean;
  boundingBox(): { min: number[]; max: number[] }; status(): string; delete(): void };

function transformed(positions: ArrayLike<number>, t: readonly number[]): Float32Array {
  const n = positions.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    out[3 * i] = t[0] * x + t[4] * y + t[8] * z + t[12];
    out[3 * i + 1] = t[1] * x + t[5] * y + t[9] * z + t[13];
    out[3 * i + 2] = t[2] * x + t[6] * y + t[10] * z + t[14];
  }
  return out;
}

function meshOf(m: Manifold): { positions: Float32Array; indices: Uint32Array } {
  const g = m.getMesh();
  const np = g.numProp, n = g.vertProperties.length / np, positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[v * 3 + k] = g.vertProperties[v * np + k];
  return { positions, indices: new Uint32Array(g.triVerts) };
}

const boxesOverlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
  [0, 1, 2].every((k) => a.min[k] <= b.max[k] + 1e-6 && b.min[k] <= a.max[k] + 1e-6);

/**
 * The connected bodies of the assembly, or null when a part isn't a closed mesh (or manifold-3d can't load).
 * Parts are in desktop's volume order (the object's own mesh first).
 */
export async function solidBodies(parts: readonly BodyInput[]): Promise<SolidBodyMesh[] | null> {
  let m: Awaited<ReturnType<typeof loadManifold>>;
  try { m = await loadManifold(); } catch { return null; }
  const made: Manifold[] = [];
  const keep = <T extends Manifold>(x: T): T => { made.push(x); return x; };
  try {
    const solids: Array<{ man: Manifold; density: number }> = [];
    const negatives: Manifold[] = [];
    for (const p of parts) {
      const mesh = new m.Mesh({ numProp: 3, vertProperties: transformed(p.positions, p.transform), triVerts: new Uint32Array(Array.from(p.indices)) });
      mesh.merge();
      let man: Manifold;
      try { man = keep(new m.Manifold(mesh) as unknown as Manifold); } catch { return null; }
      if (man.status() !== 'NoError') return null;
      if (p.negative) negatives.push(man); else solids.push({ man, density: p.density });
    }
    if (!solids.length) return [];
    const cut = negatives.length ? keep(m.Manifold.union(negatives as never) as unknown as Manifold) : null;
    let all = keep(m.Manifold.union(solids.map((s) => s.man) as never) as unknown as Manifold);
    if (cut) all = keep(all.subtract(cut));
    const bodies = all.decompose().map(keep).filter((b) => !b.isEmpty() && b.volume() > 0);
    const out: SolidBodyMesh[] = bodies.map(() => ({ pieces: [] }));
    const uniform = solids.every((s) => s.density === solids[0].density);
    if (uniform) {
      bodies.forEach((b, i) => out[i].pieces.push({ ...meshOf(b), density: solids[0].density }));
      return out;
    }
    // A later part prints where it overlaps an earlier one: each part's own region, latest first.
    const boxes = bodies.map((b) => b.boundingBox());
    let later: Manifold | null = cut;
    for (let i = solids.length - 1; i >= 0; i--) {
      const own = later ? keep(solids[i].man.subtract(later)) : solids[i].man;
      for (const piece of own.decompose().map(keep)) {
        if (piece.isEmpty() || !(piece.volume() > 0)) continue;
        const pb = piece.boundingBox();
        const candidates = boxes.map((b, k) => (boxesOverlap(b, pb) ? k : -1)).filter((k) => k >= 0);
        let body = candidates.length === 1 ? candidates[0] : -1;
        for (const k of candidates) {
          if (body >= 0) break;
          const x = keep(piece.intersect(bodies[k]));
          if (x.volume() > 1e-9) body = k;
        }
        if (body >= 0) out[body].pieces.push({ ...meshOf(piece), density: solids[i].density });
      }
      later = later ? keep(later.add(solids[i].man)) : solids[i].man;
    }
    return out;
  } catch {
    return null;
  } finally {
    for (const x of made) { try { x.delete(); } catch { /* freed */ } }
  }
}
