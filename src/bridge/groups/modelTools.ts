/**
 * Bridge tools for the model tools in src/tools: cut (plane / dovetail,
 * connectors), mesh boolean, simplify, text and SVG emboss, brim ears and
 * the assembly view. They call the same functions as the tool panels; each
 * result is one undo step.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { Vector3 } from 'three';
import { activePlate, addToolObject, addToolPart, getMesh, getObject, objectInfo, replaceVolumeMesh, setBrimPoints, setObjectOverride } from '../../project/store';
import { composeTRS } from '../../project/math';
import type { PartType, SvgEmboss, TextEmboss } from '../../project/types';
import { crossSection, defaultSettings, performCut, validate, type CutSettings } from '../../tools/cut/cut';
import { BOOLEAN_LABELS, type BooleanOp } from '../../tools/boolean/boolean';
import { runMeshBoolean, type BooleanVolume } from '../../tools/boolean/run';
import { DETAIL_LEVELS, simplifyMesh, targetFromRatio } from '../../tools/simplify/simplify';
import { DEFAULT_TEXT, buildTextMesh, textName } from '../../tools/text/textMesh';
import { FONT_FAMILIES } from '../../tools/text/fonts';
import { MAX_SVG_BYTES, buildSvgMesh, parseSvg, svgDisplayName } from '../../tools/svg/svgMesh';
import { partPlacement } from '../../tools/placement';
import { volumeMesh } from '../../tools/overlay';
import { EAR_DEFAULTS } from '../../tools/brim/brimEars';
import { autoEars, defaultEarDiameter, earToLocal, firstLayer } from '../../tools/brim/objectEars';
import { assemblyUi } from '../../tools/assembly/assembly';
import { closeTool, openTool, toolState } from '../../tools/state';
import { resolvedConfig } from '../../app/state';
import { oneOf, raycastMesh, vec3 } from '../logic';
import { bool, num, obj, objectArg, objectDetail, oneOfS, partArg, plateIndexOf, plateOrigin, round, str, vec3s } from './util';

const FACES = ['top', 'bottom', 'front', 'back', 'left', 'right'] as const;
const FACE_DIR: Record<(typeof FACES)[number], [number, number, number]> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
};
const PLACES = ['object', 'part', 'negative', 'modifier'] as const;
const FONTS = FONT_FAMILIES.map((f) => f.id);

/** Where an emboss goes on an object: a face (ray cast onto its surface from outside) or an explicit point + normal (bed coordinates). */
function surfaceSpot(objectId: string, args: Record<string, unknown>): { point: Vector3; normal: Vector3 } {
  const o = getObject(objectId)!;
  const [ox, oy] = plateOrigin(plateIndexOf(objectId));
  const p = vec3(args.point, 'point');
  if (p) {
    const n = vec3(args.normal, 'normal') ?? [0, 0, 1];
    return { point: new Vector3(p[0] + ox, p[1] + oy, p[2]), normal: new Vector3(...n).normalize() };
  }
  const face = args.face === undefined ? 'top' : oneOf(args.face, FACES, 'face');
  const info = objectInfo.value.get(objectId);
  const mesh = getMesh(o.meshId);
  if (!info || !mesh) throw new Error(`${o.name} has no mesh.`);
  const d = FACE_DIR[face];
  const c = [0, 1, 2].map((k) => (info.min[k] + info.max[k]) / 2);
  const span = Math.max(...[0, 1, 2].map((k) => info.max[k] - info.min[k])) + 10;
  const origin: [number, number, number] = [c[0] + d[0] * span, c[1] + d[1] * span, c[2] + d[2] * span];
  const hit = raycastMesh(mesh.positions, mesh.indices, composeTRS(o.position, o.rotation, o.scale), origin, [-d[0], -d[1], -d[2]]);
  if (!hit) throw new Error(`Nothing of ${o.name} is under the ${face} face centre: pass point + normal instead.`);
  return { point: new Vector3(...hit.point), normal: new Vector3(...hit.normal) };
}

type EmbossParams = TextEmboss | SvgEmboss;

async function placeEmboss(args: Record<string, unknown>, params: EmbossParams, mesh: { positions: Float32Array; indices: Uint32Array }, name: string, noun: string) {
  const place = args.place === undefined ? (args.objectId !== undefined ? 'part' : 'object') : oneOf(args.place, PLACES, 'place');
  if (place === 'object') {
    const pos = args.position;
    let world: [number, number, number] | undefined;
    if (pos !== undefined) {
      if (!Array.isArray(pos) || pos.length < 2 || !pos.every((v) => typeof v === 'number')) throw new Error('position must be [x, y] (bed coordinates).');
      const [ox, oy] = plateOrigin(activePlate.value);
      world = [pos[0] + ox, pos[1] + oy, 0];
    }
    const id = addToolObject(name, mesh, { emboss: params, position: world, label: `Add ${noun}` });
    return { objectId: id, object: objectDetail(id) };
  }
  const o = objectArg(args);
  const spot = surfaceSpot(o.id, args);
  const pl = partPlacement(o.id, spot.point, spot.normal, place as PartType, params.depth);
  if (!pl) throw new Error('Couldn’t place it on the object.');
  const pid = addToolPart(o.id, place as PartType, name, mesh, pl, params);
  if (!pid) throw new Error('Couldn’t add the part.');
  return { objectId: o.id, partId: pid, object: objectDetail(o.id) };
}

const EMBOSS_PLACE_ARGS = {
  place: oneOfS(PLACES, 'object (new object on the active plate, default without objectId), part (emboss, default with objectId), negative (engrave) or modifier.'),
  objectId: str('Object to put it on (place part / negative / modifier).'),
  face: oneOfS(FACES, 'Which side of the object (default top); it is projected onto the surface.'),
  point: vec3s('Instead of face: a surface point (bed coordinates).'), normal: vec3s('With point: the surface normal.'),
  position: { type: 'array', items: { type: 'number' }, description: 'place object: [x, y] on the active plate (default: next to what is there).' },
};

function textParams(base: TextEmboss, args: Record<string, unknown>): TextEmboss {
  const p: TextEmboss = { ...base };
  const text = argString(args, 'text', { optional: true });
  if (text !== undefined) p.text = text;
  if (args.font !== undefined) p.font = oneOf(args.font, FONTS, 'font');
  if (typeof args.bold === 'boolean') p.bold = args.bold;
  if (typeof args.italic === 'boolean') p.italic = args.italic;
  if (args.align !== undefined) p.align = oneOf(args.align, ['left', 'center', 'right'] as const, 'align');
  for (const [k, lo, hi] of [['size', 0.5, 1000], ['depth', 0.05, 500], ['letterSpacing', -50, 50], ['lineSpacing', -50, 50]] as const) {
    const v = argNumber(args, k, { optional: true });
    if (v === undefined) continue;
    if (v < lo || v > hi) throw new Error(`${k} must be ${lo}-${hi} mm.`);
    p[k] = v;
  }
  if (!p.text.trim()) throw new Error('text must not be empty.');
  return p;
}

const TEXT_ARGS = {
  text: str('The text (\\n for new lines).'), font: oneOfS(FONTS, 'Font (default noto-sans).'), bold: bool('Bold.'), italic: bool('Italic.'),
  size: num('Letter height mm (default 10).'), depth: num('Emboss depth mm (default 1.5).'), letterSpacing: num('Extra letter gap mm.'), lineSpacing: num('Extra line gap mm.'),
  align: oneOfS(['left', 'center', 'right'], 'Alignment (default center).'),
};

export function modelToolTools(): BridgeTool[] {
  return [
    {
      name: 'cut',
      description:
        'Cut an object with a plane (Orca Cut tool). The plane goes through `height` mm above the object’s bottom (default half) or `point` (bed coordinates), tilted by rotX / rotY degrees (about world X then Y). ' +
        'mode plane (default) or groove (dovetail: groove { depth, width, flapsAngle, angle }). keep: both | upper | lower; upper / lower: keep | place (on the cut face) | flip; keepAsParts: keep both halves as parts of one object. ' +
        'connectors (plane mode): list of { u, v } mm on the plane from its centre (untilted: world X / Y offsets), with connectorType plug | dowel | snap, connectorShape circle | square | hexagon | triangle, connectorStyle prism | frustum, connectorSize (diameter) and connectorDepth mm. Returns the new objects.',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({
        objectId: str('Object id.'), height: num('Plane height above the object’s bottom, mm.'), point: vec3s('Plane point (bed coordinates).'),
        rotX: num('Tilt about X, degrees.'), rotY: num('Tilt about Y, degrees.'), mode: oneOfS(['plane', 'groove'], 'Default plane.'),
        keep: oneOfS(['both', 'upper', 'lower'], 'Default both.'), upper: oneOfS(['keep', 'place', 'flip'], 'Default place.'), lower: oneOfS(['keep', 'place', 'flip'], 'Default keep.'),
        keepAsParts: bool('One object with both halves as parts.'),
        connectors: { type: 'array', items: obj({ u: num('mm'), v: num('mm') }, ['u', 'v']), description: 'Connector positions on the plane.' },
        connectorType: oneOfS(['plug', 'dowel', 'snap'], 'Default plug.'), connectorShape: oneOfS(['circle', 'square', 'hexagon', 'triangle'], 'Default circle.'),
        connectorStyle: oneOfS(['prism', 'frustum'], 'Default prism.'), connectorSize: num('Diameter mm.'), connectorDepth: num('Depth mm.'),
        radiusTolerance: num('%'), heightTolerance: num('%'),
        groove: obj({ depth: num('mm'), width: num('mm'), flapsAngle: num('degrees'), angle: num('degrees') }),
      }, ['objectId']),
      async run(args) {
        const o = objectArg(args);
        const info = objectInfo.value.get(o.id);
        if (!info) throw new Error(`${o.name} has no mesh.`);
        const h = info.max[2] - info.min[2];
        const center: [number, number, number] = [(info.min[0] + info.max[0]) / 2, (info.min[1] + info.max[1]) / 2, info.min[2] + h / 2];
        const p = vec3(args.point, 'point');
        if (p) { const [ox, oy] = plateOrigin(plateIndexOf(o.id)); center[0] = p[0] + ox; center[1] = p[1] + oy; center[2] = p[2]; }
        const height = argNumber(args, 'height', { optional: true });
        if (height !== undefined) {
          if (!(height > 0 && height < h)) throw new Error(`height must be between 0 and ${round(h)} mm (the object’s height).`);
          center[2] = info.min[2] + height;
        }
        const s: CutSettings = defaultSettings(center, h);
        s.rotX = argNumber(args, 'rotX', { optional: true }) ?? 0;
        s.rotY = argNumber(args, 'rotY', { optional: true }) ?? 0;
        if (args.mode !== undefined) s.mode = oneOf(args.mode, ['plane', 'groove'] as const, 'mode');
        const keep = args.keep === undefined ? 'both' : oneOf(args.keep, ['both', 'upper', 'lower'] as const, 'keep');
        s.keepUpper = keep !== 'lower'; s.keepLower = keep !== 'upper';
        if (args.upper !== undefined) s.upper = oneOf(args.upper, ['keep', 'place', 'flip'] as const, 'upper');
        if (args.lower !== undefined) s.lower = oneOf(args.lower, ['keep', 'place', 'flip'] as const, 'lower');
        s.keepAsParts = args.keepAsParts === true;
        if (args.connectorType !== undefined) s.connectorType = oneOf(args.connectorType, ['plug', 'dowel', 'snap'] as const, 'connectorType');
        if (args.connectorShape !== undefined) s.connectorShape = oneOf(args.connectorShape, ['circle', 'square', 'hexagon', 'triangle'] as const, 'connectorShape');
        if (args.connectorStyle !== undefined) s.connectorStyle = oneOf(args.connectorStyle, ['prism', 'frustum'] as const, 'connectorStyle');
        s.connectorSize = argNumber(args, 'connectorSize', { optional: true }) ?? s.connectorSize;
        s.connectorDepth = argNumber(args, 'connectorDepth', { optional: true }) ?? s.connectorDepth;
        s.radiusTolerance = argNumber(args, 'radiusTolerance', { optional: true }) ?? s.radiusTolerance;
        s.heightTolerance = argNumber(args, 'heightTolerance', { optional: true }) ?? s.heightTolerance;
        if (!(s.connectorSize > 0 && s.connectorDepth > 0)) throw new Error('connectorSize and connectorDepth must be > 0.');
        if (Array.isArray(args.connectors)) {
          s.connectors = args.connectors.map((c, i) => {
            const k = c as { u?: unknown; v?: unknown };
            if (typeof k.u !== 'number' || typeof k.v !== 'number') throw new Error(`connectors[${i}] must be { u, v } (mm).`);
            return { u: k.u, v: k.v, radius: s.connectorSize / 2, height: s.connectorDepth };
          });
        }
        if (args.groove && typeof args.groove === 'object') {
          const g = args.groove as Record<string, unknown>;
          for (const k of ['depth', 'width', 'flapsAngle', 'angle'] as const) if (typeof g[k] === 'number') s.groove[k] = g[k] as number;
        }
        const loops = crossSection(o.id, s);
        const check = validate(s, loops);
        if (!check.ok) {
          const pts = loops.filter((l) => !l.hole).flatMap((l) => l.pts);
          const span = pts.length ? ` The cut surface spans u ${round(Math.min(...pts.map((q) => q[0])))}…${round(Math.max(...pts.map((q) => q[0])))}, v ${round(Math.min(...pts.map((q) => q[1])))}…${round(Math.max(...pts.map((q) => q[1])))} mm (it may have holes).` : '';
          throw new Error((check.reason ?? 'The cut isn’t valid.') + span);
        }
        if (toolState.active === 'cut') closeTool();
        const ids = await performCut(o.id, s);
        return { data: { ok: true, created: ids.map((id) => objectDetail(id)) } };
      },
    },

    {
      name: 'mesh_boolean',
      description:
        'Mesh boolean (Orca Mesh boolean): op union | difference | intersection of `source` with `tools`. Each volume is { objectId, partId? } (partId: a part or negative part of that object; ' +
        'without it the object’s own mesh). The result replaces the source; tool volumes are deleted unless deleteInput is false.',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({
        op: oneOfS(['union', 'difference', 'intersection'], 'Operation.'),
        source: obj({ objectId: str('Object id.'), partId: str('Part id.') }, ['objectId']),
        tools: { type: 'array', items: obj({ objectId: str('Object id.'), partId: str('Part id.') }, ['objectId']), description: 'Tool volumes.' },
        deleteInput: bool('Delete the tool volumes (default true).'),
      }, ['op', 'source', 'tools']),
      async run(args) {
        const op = oneOf(args.op, ['union', 'difference', 'intersection'] as const, 'op') as BooleanOp;
        const vol = (v: unknown, what: string): BooleanVolume => {
          if (!v || typeof v !== 'object') throw new Error(`${what} must be { objectId, partId? }.`);
          const r = v as Record<string, unknown>;
          const o = objectArg(r);
          if (r.partId === undefined) return { objectId: o.id, partId: null };
          const p = partArg(o, r.partId);
          if (p.type !== 'part' && p.type !== 'negative') throw new Error(`Part ${p.id} is a ${p.type}: only parts and negative parts take part in a boolean.`);
          return { objectId: o.id, partId: p.id };
        };
        const src = vol(args.source, 'source');
        if (!Array.isArray(args.tools) || !args.tools.length) throw new Error('tools must list at least one volume.');
        const tools = args.tools.map((t, i) => vol(t, `tools[${i}]`));
        if (tools.some((t) => t.objectId === src.objectId && t.partId === src.partId)) throw new Error('A tool can’t be the source itself.');
        await runMeshBoolean(op, src, tools, args.deleteInput !== false);
        return { data: { ok: true, op: BOOLEAN_LABELS[op], object: objectDetail(src.objectId) } };
      },
    },

    {
      name: 'simplify',
      description: `Simplify an object’s (or a part’s) mesh (Orca Simplify): level ${DETAIL_LEVELS.map((l) => `${l.id} (${Math.round(l.ratio * 100)} %)`).join(', ')}, or ratio 0-1, or a target triangle count. Text / SVG sources are dropped (the mesh no longer matches).`,
      timeoutMs: 5 * 60_000,
      inputSchema: obj({
        objectId: str('Object id.'), partId: str('Part id (default the object’s own mesh).'),
        level: oneOfS(DETAIL_LEVELS.map((l) => l.id), 'Detail level.'), ratio: num('Share of triangles to keep, 0-1.'), triangles: num('Target triangle count.'),
      }, ['objectId']),
      async run(args) {
        const o = objectArg(args);
        const partId = args.partId === undefined ? null : partArg(o, args.partId).id;
        const m = volumeMesh(o.id, partId);
        if (!m) throw new Error('That volume has no mesh.');
        const tri = m.indices.length / 3;
        let target: number;
        const t = argNumber(args, 'triangles', { optional: true });
        const ratio = argNumber(args, 'ratio', { optional: true });
        if (t !== undefined) { if (!(t >= 4)) throw new Error('triangles must be at least 4.'); target = Math.min(tri, Math.round(t)); }
        else if (ratio !== undefined) { if (!(ratio > 0 && ratio <= 1)) throw new Error('ratio must be in (0, 1].'); target = targetFromRatio(tri, ratio); }
        else target = targetFromRatio(tri, DETAIL_LEVELS.find((l) => l.id === (args.level === undefined ? 'medium' : oneOf(args.level, DETAIL_LEVELS.map((x) => x.id), 'level')))!.ratio);
        const r = await simplifyMesh(m.positions, m.indices, target);
        const after = r.indices.length / 3;
        if (after >= tri) return { data: { ok: false, error: `Nothing to remove: the mesh stays at ${tri} triangles.` } };
        replaceVolumeMesh(o.id, partId, { positions: r.positions, indices: r.indices }, { label: 'Simplify model', emboss: null });
        return { data: { ok: true, before: tri, after, error: round(r.error, 5) } };
      },
    },

    {
      name: 'add_text',
      description: 'Add embossed text (Orca Text tool): as a new object on the active plate, or on an object’s surface as a part (raised), negative part (engraved) or modifier. The text reads along +X of the surface, up = world +Z (or +Y on flat faces). Sizes in mm.',
      timeoutMs: 120_000,
      inputSchema: obj({ ...TEXT_ARGS, ...EMBOSS_PLACE_ARGS }, ['text']),
      async run(args) {
        const p = textParams({ ...DEFAULT_TEXT }, args);
        const mesh = await buildTextMesh(p);
        if (!mesh) throw new Error('Nothing to emboss (the text has no visible glyphs).');
        return { data: { ok: true, ...(await placeEmboss(args, p, mesh, textName(p.text), 'text')) } };
      },
    },

    {
      name: 'add_svg',
      description: 'Emboss an SVG (Orca SVG tool): filled and stroked shapes become a volume `width` mm wide (height keeps the aspect), `depth` mm deep. Placement like add_text. Give the SVG source as text.',
      timeoutMs: 120_000,
      inputSchema: obj({
        svg: str('SVG source.'), name: str('Name (default "SVG").'), width: num('Width mm (default the SVG’s size at 96 dpi, 5-150).'), depth: num('Depth mm (default 2).'),
        ...EMBOSS_PLACE_ARGS,
      }, ['svg']),
      async run(args) {
        const svg = argString(args, 'svg')!;
        if (svg.length > MAX_SVG_BYTES) throw new Error(`The SVG is larger than ${MAX_SVG_BYTES / 1024} KB.`);
        const outline = parseSvg(svg);
        if (!(outline.width > 0)) throw new Error('The SVG has no filled or stroked shapes to emboss.');
        const width = argNumber(args, 'width', { optional: true }) ?? Math.round(Math.max(5, Math.min(150, (outline.width * 25.4) / 96)) * 10) / 10;
        const depth = argNumber(args, 'depth', { optional: true }) ?? 2;
        if (!(width > 0 && width <= 5000) || !(depth > 0 && depth <= 500)) throw new Error('width must be 0-5000 mm and depth 0-500 mm.');
        const name = argString(args, 'name', { optional: true }) ?? 'SVG';
        const p: SvgEmboss = { kind: 'svg', svg, name: /\.svg$/i.test(name) ? name : `${name}.svg`, width, depth };
        const mesh = buildSvgMesh(p);
        if (!mesh) throw new Error('The SVG produced no geometry.');
        return { data: { ok: true, warnings: outline.warnings.length ? outline.warnings : undefined, ...(await placeEmboss(args, p, mesh, svgDisplayName(p.name), 'SVG')) } };
      },
    },

    {
      name: 'edit_emboss',
      description: 'Change a text or SVG volume made by add_text / add_svg (or the app’s tools): the object itself (text objects) or a part (partId). Text: any add_text parameter; SVG: width, depth or a new svg.',
      timeoutMs: 120_000,
      inputSchema: obj({ objectId: str('Object id.'), partId: str('Part id (list_objects shows emboss sources).'), ...TEXT_ARGS, svg: str('New SVG source.'), width: num('SVG width mm.') }, ['objectId']),
      async run(args) {
        const o = objectArg(args);
        const partId = args.partId === undefined ? null : partArg(o, args.partId).id;
        const cur = partId ? o.parts!.find((x) => x.id === partId)!.emboss : o.emboss;
        if (!cur) throw new Error(`${partId ? 'That part' : o.name} has no text or SVG source to edit.`);
        if (cur.kind === 'text') {
          const p = textParams(cur, args);
          const mesh = await buildTextMesh(p);
          if (!mesh) throw new Error('Nothing to emboss.');
          replaceVolumeMesh(o.id, partId, mesh, { label: 'Edit text', emboss: p, name: textName(p.text) });
        } else {
          const p: SvgEmboss = { ...cur };
          const svg = argString(args, 'svg', { optional: true });
          if (svg !== undefined) p.svg = svg;
          p.width = argNumber(args, 'width', { optional: true }) ?? p.width;
          p.depth = argNumber(args, 'depth', { optional: true }) ?? p.depth;
          const mesh = buildSvgMesh(p);
          if (!mesh) throw new Error('The SVG produced no geometry.');
          replaceVolumeMesh(o.id, partId, mesh, { label: 'Edit SVG', emboss: p });
        }
        return { data: { ok: true, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'brim_ears',
      description:
        'Brim ears (Orca Brim ears tool): op auto (add ears at the sharp corners of the first layer: maxAngle degrees, detectionRadius mm), add (points [[x, y], …] in bed coordinates on the outline), clear, list. ' +
        'diameter: ear size mm (default from the nozzle). Ears only print with brim type "painted": setPainted: true sets it on the object.',
      inputSchema: obj({
        objectId: str('Object id.'), op: oneOfS(['auto', 'add', 'clear', 'list'], 'What to do.'),
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'add: [[x, y], …] bed coordinates.' },
        diameter: num('Ear diameter mm.'), maxAngle: num(`auto: max corner angle (default ${EAR_DEFAULTS.maxAngle}).`), detectionRadius: num(`auto: mm (default ${EAR_DEFAULTS.detectionRadius}).`),
        setPainted: bool('Also set brim_type "painted" on the object.'),
      }, ['objectId', 'op']),
      run(args) {
        const o = objectArg(args);
        const op = oneOf(args.op, ['auto', 'add', 'clear', 'list'] as const, 'op');
        const diameter = argNumber(args, 'diameter', { optional: true }) ?? defaultEarDiameter();
        if (!(diameter >= 1 && diameter <= 50)) throw new Error('diameter must be 1-50 mm.');
        const cur = o.brimPoints ?? [];
        if (op === 'clear') setBrimPoints(o.id, [], 'Delete all brim ears');
        else if (op === 'auto') {
          const add = autoEars(o.id, { detectionRadius: argNumber(args, 'detectionRadius', { optional: true }) ?? EAR_DEFAULTS.detectionRadius, maxAngle: argNumber(args, 'maxAngle', { optional: true }) ?? EAR_DEFAULTS.maxAngle, diameter });
          if (add.length) setBrimPoints(o.id, [...cur, ...add], 'Auto generate brim ear');
        } else if (op === 'add') {
          const pts = args.points;
          if (!Array.isArray(pts) || !pts.length) throw new Error('points must be [[x, y], …] (bed coordinates).');
          const l = firstLayer(o.id);
          if (!l) throw new Error(`${o.name} has no mesh.`);
          const [ox, oy] = plateOrigin(plateIndexOf(o.id));
          const add = pts.map((q, i) => {
            if (!Array.isArray(q) || q.length < 2 || typeof q[0] !== 'number' || typeof q[1] !== 'number') throw new Error(`points[${i}] must be [x, y].`);
            const pos = earToLocal(o.id, q[0] + ox, q[1] + oy, l.bottom);
            if (!pos) throw new Error(`${o.name} has no placement.`);
            return { pos, radius: diameter / 2 };
          });
          setBrimPoints(o.id, [...cur, ...add], 'Add brim ear');
        }
        if (args.setPainted === true) setObjectOverride(o.id, 'brim_type', 'painted');
        const now = getObject(o.id)!;
        const brim = now.overrides.brim_type ?? resolvedConfig.value.brim_type;
        return {
          data: {
            ok: true, ears: now.brimPoints?.length ?? 0, brimType: brim,
            hint: (now.brimPoints?.length ?? 0) > 0 && (Array.isArray(brim) ? brim[0] : brim) !== 'painted' ? 'Ears only print with brim type "painted" (setPainted: true).' : undefined,
          },
        };
      },
    },

    {
      name: 'assembly_view',
      description: 'Show or hide the assembly view (cut pieces at their assembled pose, pushed apart by `explosion` 1-3). Display only; capture_viewport shows it.',
      inputSchema: obj({ on: bool('Show (default true).'), explosion: num('1 = assembled … 3.') }),
      run(args) {
        const on = args.on !== false;
        const e = argNumber(args, 'explosion', { optional: true });
        if (e !== undefined) { if (!(e >= 1 && e <= 3)) throw new Error('explosion must be 1-3.'); }
        if (on && toolState.active !== 'assembly') openTool('assembly');
        if (!on && toolState.active === 'assembly') closeTool();
        if (e !== undefined) assemblyUi.explosion = e;
        return { data: { ok: true, on: toolState.active === 'assembly', explosion: assemblyUi.explosion } };
      },
    },
  ];
}
