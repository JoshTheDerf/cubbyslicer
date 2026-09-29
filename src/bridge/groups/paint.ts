/**
 * Bridge tool: scriptable painting (Orca's support / seam / colour / fuzzy
 * skin painting). The brush-like modes run in the engine's TriangleSelector,
 * the same session code the paint tool uses; whole-object and by-direction
 * fills set per-triangle states. Each call is one undo step on the mesh's
 * paint (instances share it).
 */
import { argNumber, type BridgeTool } from '@cubby/shared/bridge';
import { Matrix4, Vector3 } from 'three';
import { activeEngine, resolvedConfig } from '../../app/state';
import { engineTool } from '../../engine/client';
import { isOrcaFamily, type PaintLayer, type PaintMap, type ToolMesh } from '../../engine/types';
import { getMesh, getMeshPaint, objectInfo, setMeshPaint } from '../../project/store';
import { composeTRS } from '../../project/math';
import { closePaint, paintEngine } from '../../paint/controller';
import { maxStateFor, paintUi, PAINT_TITLES } from '../../paint/state';
import { currentPresets } from '../../presets/store';
import { mixedFilaments } from '../../mixed/store';
import { mergePaint, nearestTriangle, oneOf, trianglesFacing, vec3 } from '../logic';
import { bool, num, obj, objectArg, oneOfS, plateIndexOf, plateOrigin, str, vec3s } from './util';

const LAYERS = ['support', 'seam', 'color', 'fuzzy'] as const;
const MODES = ['fill', 'clear', 'height', 'sphere', 'smart_fill', 'bucket', 'facing'] as const;
const LABELS: Record<PaintLayer, string> = { support: 'Paint supports', seam: 'Paint seam', color: 'Paint color', fuzzy: 'Paint fuzzy skin' };

async function statesToPaint(mesh: ToolMesh, tris: number[], state: number): Promise<PaintMap> {
  if (!tris.length) return [];
  return (await engineTool<{ paint: PaintMap }>('paint_from_states', { states: tris.map((t) => [t, state]) }, [mesh], paintEngine())).result.paint;
}

/** One brush operation in an engine painting session over the current paint. */
async function sessionApply(mesh: ToolMesh, layer: PaintLayer, current: PaintMap | undefined, apply: Record<string, unknown>): Promise<PaintMap> {
  const eng = paintEngine();
  const open = await engineTool<{ handle: number }>('paint_open', { paint: current ?? [], maxState: maxStateFor(layer) }, [mesh], eng);
  const handle = open.result.handle;
  try {
    await engineTool('paint_apply', { handle, ...apply }, [], eng);
    return (await engineTool<{ paint: PaintMap }>('paint_get', { handle }, [], eng)).result.paint;
  } finally {
    void engineTool('paint_close', { handle }, [], eng).catch(() => {});
  }
}

export function paintTools(): BridgeTool[] {
  return [
    {
      name: 'paint',
      description:
        'Paint an object’s surface. layer: support (enforcers / blockers), seam (enforce / block seam), color (a filament per area, multi-material), fuzzy (fuzzy skin areas). ' +
        'mode: fill (whole object), clear (remove this layer’s paint), height (a band zMin–zMax mm above the object’s bottom), sphere (within `radius` mm of `point`), ' +
        'smart_fill (the flat-ish region around `point`, faces within `angle`°), bucket (color only: the connected same-colour region at `point`), ' +
        'facing (faces whose normal is within `angle`° of `direction`, e.g. [0, 0, -1] + 45 = overhangs, [0, 0, 1] = tops). ' +
        'State: support / seam use enforce (default) or block; color uses filament (1-based, mixed filaments included); erase: true removes paint in the area instead. ' +
        'Points are bed coordinates (mm) of the object’s plate. Painted support enforcers only print with supports on (the result says so).',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({
        objectId: str('Object id.'), layer: oneOfS(LAYERS, 'Paint layer.'), mode: oneOfS(MODES, 'How to pick the area.'),
        state: oneOfS(['enforce', 'block'], 'support / seam: default enforce.'), filament: num('color: filament number (default 1).'), erase: bool('Remove paint in the area.'),
        zMin: num('height: band bottom, mm above the object’s bottom.'), zMax: num('height: band top.'),
        point: vec3s('sphere / smart_fill / bucket: a point on or near the surface (bed coordinates).'), radius: num('sphere: mm (default 5).'),
        angle: num('smart_fill / bucket / facing: degrees (default 30; facing 45).'), direction: vec3s('facing: world direction, e.g. [0, 0, -1].'),
      }, ['objectId', 'layer', 'mode']),
      async run(args) {
        const o = objectArg(args);
        const layer = oneOf(args.layer, LAYERS, 'layer');
        const mode = oneOf(args.mode, MODES, 'mode');
        const mesh = getMesh(o.meshId);
        if (!mesh) throw new Error(`${o.name} has no mesh.`);
        if (mode === 'bucket' && layer !== 'color') throw new Error('bucket works on the color layer only (use smart_fill).');
        // An open paint tool holds its own session of this layer: close it so it doesn't overwrite this change.
        if (paintUi.layer) await closePaint();
        let state: number;
        if (args.erase === true) state = 0;
        else if (layer === 'color') {
          const n = currentPresets.value.selection.filaments.length + mixedFilaments.value.length;
          const f = argNumber(args, 'filament', { optional: true }) ?? 1;
          if (!Number.isInteger(f) || f < 1 || f > Math.min(n, maxStateFor('color'))) throw new Error(`filament must be 1-${Math.min(n, maxStateFor('color'))} (set_filaments adds slots).`);
          state = f;
        } else if (layer === 'fuzzy') state = 1;
        else state = args.state === undefined ? 1 : oneOf(args.state, ['enforce', 'block'] as const, 'state') === 'block' ? 2 : 1;

        const tm: ToolMesh = { positions: mesh.positions, indices: mesh.indices };
        const m = composeTRS(o.position, o.rotation, o.scale);
        const inv = new Matrix4().fromArray(m).invert();
        const [ox, oy] = plateOrigin(plateIndexOf(o.id));
        const current = getMeshPaint(o.meshId)[layer];
        const worldPoint = () => {
          const p = vec3(args.point, 'point');
          if (!p) throw new Error(`mode "${mode}" needs point [x, y, z] (bed coordinates).`);
          return [p[0] + ox, p[1] + oy, p[2]] as [number, number, number];
        };
        const seedAt = (wp: [number, number, number]) => {
          const hit = nearestTriangle(mesh.positions, mesh.indices, m, wp);
          if (!hit) throw new Error(`${o.name} has no triangles.`);
          // The brush centre goes on the surface (the closest point), in the mesh's frame.
          const local = new Vector3(...hit.point).applyMatrix4(inv).toArray();
          return { facet: hit.tri, point: local, distance: hit.distance };
        };
        const cam = new Vector3(0, 0, 10_000).applyMatrix4(inv).toArray();
        const angle = argNumber(args, 'angle', { optional: true });
        let next: PaintMap;
        let note: string | undefined;
        switch (mode) {
          case 'clear': next = []; break;
          case 'fill': {
            const all = Array.from({ length: mesh.triangleCount }, (_, t) => t);
            next = state === 0 ? [] : await statesToPaint(tm, all, state);
            break;
          }
          case 'facing': {
            const dir = vec3(args.direction, 'direction');
            if (!dir) throw new Error('mode "facing" needs direction [x, y, z].');
            const tris = trianglesFacing(mesh.positions, mesh.indices, m, dir, angle ?? 45);
            next = state === 0 ? mergePaint(current, [], tris) : mergePaint(current, await statesToPaint(tm, tris, state));
            note = `${tris.length} of ${mesh.triangleCount} faces matched.`;
            break;
          }
          case 'height': {
            const zMin = argNumber(args, 'zMin'), zMax = argNumber(args, 'zMax');
            if (!(zMax! > zMin!)) throw new Error('zMax must be above zMin.');
            const bottom = objectInfo.value.get(o.id)?.min[2] ?? 0;
            next = await sessionApply(tm, layer, current, { kind: 'height', facet: 0, point: [0, 0, 0], camera: cam, radius: zMax! - zMin!, zWorld: bottom + zMin!, trafo: m, state });
            break;
          }
          case 'sphere': {
            const s = seedAt(worldPoint());
            const radius = argNumber(args, 'radius', { optional: true }) ?? 5;
            if (!(radius > 0 && radius <= 500)) throw new Error('radius must be 0-500 mm.');
            if (s.distance > 1) note = `The point is ${s.distance.toFixed(1)} mm off the surface; the sphere was centred on the closest surface point.`;
            next = await sessionApply(tm, layer, current, { kind: 'sphere', facet: s.facet, point: s.point, camera: cam, radius, trafo: m, state });
            break;
          }
          case 'smart_fill': case 'bucket': {
            const s = seedAt(worldPoint());
            next = await sessionApply(tm, layer, current, { kind: mode === 'bucket' ? 'bucket' : 'fill', facet: s.facet, point: s.point, camera: cam, angle: angle ?? 30, trafo: m, state });
            break;
          }
        }
        setMeshPaint(o.meshId, layer, next.length ? next : null, mode === 'clear' || state === 0 ? 'Erase painting' : LABELS[layer]);
        const painted = getMeshPaint(o.meshId)[layer]?.length ?? 0;
        let hint: string | undefined;
        if (layer === 'support' && painted) {
          const key = isOrcaFamily(activeEngine.value) ? 'enable_support' : 'support_material';
          const v = o.overrides[key] ?? resolvedConfig.value[key];
          const on = (Array.isArray(v) ? v[0] : v) === '1';
          if (!on) hint = `Supports are off, so painted enforcers won’t print. Turn them on with set_settings { "${key}": true } (objectId for this object only).`;
        }
        return { data: { ok: true, layer: PAINT_TITLES[layer], paintedTriangles: painted, note, hint } };
      },
    },
  ];
}
