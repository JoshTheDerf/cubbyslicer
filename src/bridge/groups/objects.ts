/**
 * Bridge tools: objects and parts. Everything goes through the project
 * store functions the object list, transform panel, toolbar and context
 * menus call, so each change is one undo step like the matching click.
 *
 * Frames: Z-up, mm. Object positions are bed coordinates of the object's
 * plate (footprint centre X / Y and bottom Z, like Orca's Position row).
 * Part positions are in the object's local frame (before the object's own
 * rotation and scale), as list_objects reports them.
 */
import { argNumber, argString, base64ToBytes, bytesToBase64, type BridgeTool } from '@cubby/shared/bridge';
import { activeView } from '../../app/state';
import { addModelPart, addPrimitivePart, autoOrientObjects, importBuffer } from '../../app/shell/actions';
import { runArrange } from '../../app/shell/arrange';
import {
  activePlate, centerObjects, clearPlate, dropToBed, duplicateObjects, getMesh, getObject, instancesOf, layOnFace,
  mirrorObjects, objectInfo, objectLocalBBox, objects, objectsOnPlate, plates, projectName, removeObjects, removePart, renameObject, renamePart,
  scaleToFit, select, selectedIds, selectedPart, setActivePlate, setColor, setInstanceCount, setObjectOverride, setPartTransform,
  setPartType, setPrintable, setTransforms, setVisible, splitToObjects, splitToParts, type TransformPatch,
} from '../../project/store';
import { mergeWorldInfo, partWorldInfo, worldInfo, type WorldInfo } from '../../project/geometry';
import { composeTRS, quatFromAxisAngle, quatFromEuler, quatMultiply, quatNormalize, type Quat, type Vec3 } from '../../project/math';
import { buildStl } from '../../project/export/stl';
import type { PrimitiveKind } from '../../project/primitives';
import { PART_TYPE_LABELS, type PartType, type ProjectObject } from '../../project/types';
import { currentPresets } from '../../presets/store';
import { mixedFilaments } from '../../mixed/store';
import { largestFaceNormal, oneOf, vec3 } from '../logic';
import {
  bedBox, bool, DEG, idsArg, num, obj, objectArg, objectDetail, oneOfS, partArg, plateArg, plateIndexOf, plateOrigin, r3, round, str, strList, vec3s,
} from './util';

const PART_TYPES = Object.keys(PART_TYPE_LABELS) as PartType[];
const SHAPES = ['box', 'cylinder', 'sphere', 'slab', 'file'] as const;
const OPS = ['drop_to_bed', 'center', 'mirror_x', 'mirror_y', 'mirror_z', 'scale_to_fit', 'split_to_objects', 'split_to_parts', 'auto_orient', 'lay_on_face', 'arrange'] as const;

/** World bbox of `o` if it had this placement (its mesh + model parts). */
function infoWith(o: ProjectObject, position: Vec3, rotation: Quat, scale: Vec3): WorldInfo | null {
  const mesh = getMesh(o.meshId);
  if (!mesh) return null;
  const t = { position, rotation, scale };
  let info = worldInfo(t, mesh);
  for (const p of o.parts ?? []) {
    if (p.type !== 'part') continue;
    const pm = getMesh(p.meshId);
    if (pm) info = mergeWorldInfo(info, partWorldInfo(t, p, pm));
  }
  return info;
}

const AXIS: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** One transform_objects item → a store patch (new position / rotation / scale). */
function patchFor(o: ProjectObject, it: Record<string, unknown>): TransformPatch {
  let rotation = [...o.rotation] as Quat, scale = [...o.scale] as Vec3;
  const rot = vec3(it.rotation, 'rotation');
  if (rot) rotation = quatFromEuler(rot[0] / DEG, rot[1] / DEG, rot[2] / DEG);
  if (it.rotateBy !== undefined) {
    const rb = it.rotateBy as { axis?: unknown; degrees?: unknown };
    const axis = typeof rb?.axis === 'string' ? AXIS[rb.axis.toLowerCase()] : vec3(rb?.axis, 'rotateBy.axis');
    if (!axis || typeof rb.degrees !== 'number' || !Number.isFinite(rb.degrees)) throw new Error('rotateBy must be { axis: "x" | "y" | "z" | [x, y, z], degrees: number }.');
    rotation = quatNormalize(quatMultiply(quatFromAxisAngle(axis, (rb.degrees * Math.PI) / 180), rotation));
  }
  const sign = (i: number) => Math.sign(o.scale[i]) || 1;
  if (typeof it.scale === 'number') {
    if (!(it.scale > 0)) throw new Error('scale must be > 0 (1 = 100 %).');
    scale = [0, 1, 2].map((i) => sign(i) * (it.scale as number)) as Vec3;
  } else if (it.scale !== undefined) {
    const s = vec3(it.scale, 'scale')!;
    if (s.some((v) => !(v > 0))) throw new Error('scale factors must be > 0 (1 = 100 %; mirror with object_op).');
    scale = s.map((v, i) => sign(i) * v) as Vec3;
  }
  if (it.size !== undefined) {
    const sz = it.size;
    if (!Array.isArray(sz) || sz.length !== 3) throw new Error('size must be [x, y, z] in mm (null keeps an axis; with uniform: true one value scales all).');
    // The object's own axes, like the Size row (its mesh + model parts, unscaled).
    const lb = objectLocalBBox(o);
    if (!lb) throw new Error(`${o.name} has no mesh.`);
    const ext = [0, 1, 2].map((k) => lb.max[k] - lb.min[k]);
    const f = sz.map((v, k) => (typeof v === 'number' && v > 0 && ext[k] > 0 ? v / ext[k] : null));
    if (it.uniform === true) {
      const k = f.findIndex((x) => x !== null);
      if (k < 0) throw new Error('size needs at least one positive value.');
      scale = [0, 1, 2].map((i) => sign(i) * (f[k] as number)) as Vec3;
    } else scale = scale.map((v, i) => (f[i] === null ? v : sign(i) * (f[i] as number))) as Vec3;
  }
  const rs = it.rotation !== undefined || it.rotateBy !== undefined || it.scale !== undefined || it.size !== undefined;
  let position = [...o.position] as Vec3;
  const before = infoWith(o, position, o.rotation, o.scale);
  const after = infoWith(o, position, rotation, scale);
  if (!before || !after) throw new Error(`${o.name} has no mesh.`);
  // Rotating / scaling keeps the object on the bed (like the gizmo); the footprint centre stays put.
  if (rs) {
    const cx = (before.min[0] + before.max[0]) / 2 - (after.min[0] + after.max[0]) / 2;
    const cy = (before.min[1] + before.max[1]) / 2 - (after.min[1] + after.max[1]) / 2;
    position = [position[0] + cx, position[1] + cy, position[2] - after.min[2]];
  }
  const cur = infoWith(o, position, rotation, scale)!;
  const pos = it.position;
  if (pos !== undefined) {
    if (!Array.isArray(pos) || (pos.length !== 2 && pos.length !== 3) || !pos.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('position must be [x, y] or [x, y, z] (mm, bed coordinates).');
    const plate = typeof it.plate === 'number' ? it.plate - 1 : Math.max(0, plateIndexOf(o.id));
    if (plate < 0 || plate >= plates.value.length) throw new Error(`plate must be 1-${plates.value.length}.`);
    const [ox, oy] = plateOrigin(plate);
    position = [
      position[0] + pos[0] + ox - (cur.min[0] + cur.max[0]) / 2,
      position[1] + pos[1] + oy - (cur.min[1] + cur.max[1]) / 2,
      pos.length === 3 ? position[2] + (pos[2] as number) - cur.min[2] : position[2],
    ];
  }
  const mv = vec3(it.move, 'move');
  if (mv) position = [position[0] + mv[0], position[1] + mv[1], position[2] + mv[2]];
  return { id: o.id, position, rotation, scale };
}

function filamentCount(): number { return currentPresets.value.selection.filaments.length + mixedFilaments.value.length; }

export function objectTools(): BridgeTool[] {
  return [
    {
      name: 'list_objects',
      description:
        'Objects with full detail: id, plate, position (footprint centre X/Y + bottom Z, bed coordinates of its plate, mm), bbox, size, rotation (XYZ Euler, degrees), scale, ' +
        'visible / printable, colour, filament, instances, issues, per-object overrides, parts (id, type, local position / rotation / scale, overrides), height ranges, ' +
        'variable layer height, paint layers, brim ears and text / SVG sources.',
      inputSchema: obj({ plate: num('Only this plate (1-based).'), ids: strList('Only these object ids.') }),
      run(args) {
        const plate = plateArg(args);
        let list = objects.value;
        if (plate !== undefined) list = list.filter((o) => plateIndexOf(o.id) === plate);
        if (args.ids !== undefined) { const ids = new Set(idsArg(args)); list = list.filter((o) => ids.has(o.id)); }
        return { data: { count: list.length, selected: selectedIds.value, objects: list.map((o) => objectDetail(o.id)) } };
      },
    },

    {
      name: 'select_objects',
      description: 'Set the selection (what run_action commands, painting and the tools act on). mode: replace (default), add, toggle. Empty ids clears it. partId picks one part of a single selected object, like clicking it in the object list.',
      inputSchema: obj({ ids: strList('Object ids.'), mode: oneOfS(['replace', 'add', 'toggle'], 'Default replace.'), partId: str('Pick this part of the (single) object.') }, ['ids']),
      run(args) {
        const list = Array.isArray(args.ids) ? args.ids : [];
        const ids = list.length ? idsArg(args) : [];
        const mode = args.mode === undefined ? 'replace' : oneOf(args.mode, ['replace', 'add', 'toggle'] as const, 'mode');
        select(ids, mode);
        if (args.partId !== undefined) {
          if (selectedIds.value.length !== 1) throw new Error('partId needs exactly one selected object.');
          const o = getObject(selectedIds.value[0])!;
          selectedPart.value = { objectId: o.id, partId: partArg(o, args.partId).id };
        }
        return { data: { ok: true, selected: selectedIds.value, part: selectedPart.value ?? undefined, activePlate: activePlate.value + 1 } };
      },
    },

    {
      name: 'transform_objects',
      description:
        'Move, rotate and scale objects in one undo step. Per item: position [x, y] or [x, y, z] (footprint centre / bottom, bed coordinates of the object’s plate or `plate`), ' +
        'move [dx, dy, dz] (mm), rotation [x, y, z] (absolute XYZ Euler degrees), rotateBy { axis: "x"|"y"|"z"|[x,y,z], degrees } (about the world axis), ' +
        'scale (a factor, or [sx, sy, sz]; 1 = 100 %), size [x, y, z] mm along the object’s own axes (null keeps an axis; uniform: true scales all from the first value). ' +
        'Rotating or scaling keeps the object on the bed and its footprint centre in place.',
      inputSchema: obj({
        items: {
          type: 'array', description: 'One entry per object.',
          items: obj({
            id: str('Object id.'), position: { type: 'array', items: { type: 'number' }, description: '[x, y] or [x, y, z].' }, plate: num('Plate for position (1-based).'),
            move: vec3s('Delta mm.'), rotation: vec3s('XYZ Euler degrees.'), rotateBy: { type: 'object', description: '{ axis, degrees }' },
            scale: { type: ['number', 'array'], description: 'Factor or [sx, sy, sz].' }, size: { type: 'array', description: '[x, y, z] mm.' }, uniform: bool('With size.'),
          }, ['id']),
        },
      }, ['items']),
      run(args) {
        const items = args.items;
        if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty list.');
        const patches = items.map((it, i) => {
          if (!it || typeof it !== 'object') throw new Error(`items[${i}] must be an object.`);
          const o = objectArg(it as Record<string, unknown>, 'id');
          return patchFor(o, it as Record<string, unknown>);
        });
        setTransforms(patches, patches.length === 1 ? 'Move' : `Move ${patches.length} objects`, { drop: false });
        return { data: { ok: true, objects: patches.map((p) => objectDetail(p.id)) } };
      },
    },

    {
      name: 'object_op',
      description:
        'Object commands on ids: drop_to_bed, center (as a group on its plate), mirror_x / mirror_y / mirror_z, scale_to_fit (largest size that fits the build volume), ' +
        'split_to_objects / split_to_parts (by connected pieces), auto_orient (engine auto orient), lay_on_face (one object: `normal` [x, y, z] world face normal to put down, default its largest flat face), ' +
        'arrange (these objects on the active plate around the others).',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ op: oneOfS(OPS, 'Command.'), ids: strList('Object ids.'), normal: vec3s('lay_on_face: world normal of the face to put on the bed.') }, ['op', 'ids']),
      async run(args) {
        const op = oneOf(args.op, OPS, 'op');
        const ids = idsArg(args);
        const before = new Map(ids.map((id) => [id, JSON.stringify(getObject(id)?.rotation)]));
        let extra: Record<string, unknown> = {};
        switch (op) {
          case 'drop_to_bed': dropToBed(ids); break;
          case 'center': centerObjects(ids); break;
          case 'mirror_x': mirrorObjects(0, ids); break;
          case 'mirror_y': mirrorObjects(1, ids); break;
          case 'mirror_z': mirrorObjects(2, ids); break;
          case 'scale_to_fit': scaleToFit(ids); break;
          case 'split_to_objects': {
            const n = splitToObjects(ids);
            if (!n) throw new Error('Nothing to split: each object is a single connected piece.');
            extra = { created: selectedIds.value.slice() };
            break;
          }
          case 'split_to_parts': {
            const n = splitToParts(ids);
            if (!n) throw new Error('Nothing to split: each object is a single connected piece.');
            extra = { partsAdded: n };
            break;
          }
          case 'auto_orient': {
            select(ids);
            await autoOrientObjects('auto');
            extra = { changed: ids.filter((id) => before.get(id) !== JSON.stringify(getObject(id)?.rotation)) };
            break;
          }
          case 'lay_on_face': {
            if (ids.length !== 1) throw new Error('lay_on_face takes one object.');
            const o = getObject(ids[0])!;
            let n = vec3(args.normal, 'normal');
            if (!n) {
              const m = getMesh(o.meshId);
              n = m ? largestFaceNormal(m.positions, m.indices, composeTRS(o.position, o.rotation, o.scale)) : null;
              if (!n) throw new Error(`${o.name} has no flat face to lay on.`);
            }
            layOnFace(o.id, n);
            extra = { normal: r3(n, 4) };
            break;
          }
          case 'arrange': {
            const unplaced = (await runArrange('selection', { ids }))?.unplaced ?? 0;
            extra = { unplaced };
            break;
          }
        }
        const live = (extra.created as string[] | undefined) ?? ids.filter((id) => getObject(id));
        return { data: { ok: true, op, ...extra, objects: live.map((id) => objectDetail(id)) } };
      },
    },

    {
      name: 'duplicate_objects',
      description: 'Add `count` instances of each object (copies sharing the mesh, paint and settings, like Orca’s "+"), placed next to it; they spill onto new plates when the plate is full.',
      inputSchema: obj({ ids: strList('Object ids.'), count: num('Copies per object (default 1, max 100).') }, ['ids']),
      run(args) {
        const ids = idsArg(args);
        const count = Math.floor(argNumber(args, 'count', { optional: true }) ?? 1);
        if (count < 1 || count > 100) throw new Error('count must be 1-100.');
        const created = duplicateObjects(ids, count);
        return { data: { ok: true, created: created.map((id) => objectDetail(id)) } };
      },
    },

    {
      name: 'set_instances',
      description: 'Make each object’s instance group exactly `count` strong (Orca "Set number of instances"): adds copies next to them or removes the newest extra ones.',
      inputSchema: obj({ ids: strList('Object ids.'), count: num('Instances in total (1-500).') }, ['ids', 'count']),
      run(args) {
        const ids = idsArg(args);
        const count = argNumber(args, 'count')!;
        if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('count must be a whole number from 1 to 500.');
        setInstanceCount(ids, count);
        const live = ids.filter((id) => getObject(id));
        return { data: { ok: true, groups: live.map((id) => ({ id, instances: instancesOf(id).map((x) => x.id) })) } };
      },
    },

    {
      name: 'update_objects',
      description:
        'Change object properties: name (one object), visible, printable (false = not sliced), color (CSS "#rrggbb" for the 3D view, "" = default) and filament ' +
        '(1-based filament / extruder the object prints with; Full Spectrum mixed filaments follow the physical ones). Each property is one undo step.',
      inputSchema: obj({
        ids: strList('Object ids.'), name: str('New name (one object).'), visible: bool('Show / hide.'), printable: bool('Print / skip.'),
        color: str('"#rrggbb" or "".'), filament: num('Filament number.'),
      }, ['ids']),
      run(args) {
        const ids = idsArg(args);
        const name = argString(args, 'name', { optional: true });
        if (name !== undefined) {
          if (ids.length !== 1) throw new Error('name needs exactly one object id.');
          if (!name.trim()) throw new Error('name must not be empty.');
          renameObject(ids[0], name);
        }
        if (typeof args.visible === 'boolean') setVisible(ids, args.visible);
        if (typeof args.printable === 'boolean') setPrintable(ids, args.printable);
        const color = argString(args, 'color', { optional: true });
        if (color !== undefined) {
          if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('color must be "#rrggbb" or "".');
          setColor(ids, color);
        }
        const f = argNumber(args, 'filament', { optional: true });
        if (f !== undefined) {
          const n = filamentCount();
          if (!Number.isInteger(f) || f < 1 || f > n) throw new Error(`filament must be 1-${n} (set_filaments adds slots).`);
          for (const id of ids) setObjectOverride(id, 'extruder', f === 1 ? undefined : String(f));
        }
        return { data: { ok: true, objects: ids.map((id) => objectDetail(id)) } };
      },
    },

    {
      name: 'remove_objects',
      description: 'Delete objects by id, or every object on the active plate (or `plate`) with all: true.',
      inputSchema: obj({ ids: strList('Object ids.'), all: bool('Every object on the plate.'), plate: num('With all: this plate (1-based).') }),
      run(args) {
        if (args.all === true) {
          const i = plateArg(args) ?? activePlate.value;
          const n = objectsOnPlate(i).length;
          clearPlate(i);
          return { data: { ok: true, removed: n, plate: i + 1 } };
        }
        const ids = idsArg(args);
        removeObjects(ids);
        return { data: { ok: true, removed: ids.length } };
      },
    },

    {
      name: 'import_model',
      description: 'Add a model (STL, 3MF, OBJ, STEP) to the active plate (or `plate`). Give a local path or URL (through cubby-mcp), or name + dataBase64. cad_to_slicer calls this for you. An OrcaSlicer project 3MF opens as a project (use open_project).',
      fileInput: true,
      timeoutMs: 300_000,
      inputSchema: obj({
        name: str('File name with extension, e.g. "bracket.stl".'),
        dataBase64: str('File bytes, base64.'),
        plate: num('Plate to add to (1-based, default the active plate).'),
        replacePlate: bool('Clear that plate first (default false).'),
        arrange: bool('Arrange the plate afterwards (default true).'),
      }, ['name', 'dataBase64']),
      async run(args) {
        const name = argString(args, 'name')!;
        const bytes = base64ToBytes(argString(args, 'dataBase64')!);
        const plate = plateArg(args);
        if (plate !== undefined) setActivePlate(plate);
        if (args.replacePlate === true) clearPlate(activePlate.value);
        const ids = await importBuffer(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        if (!ids.length) throw new Error(`Couldn’t import ${name} (see the app’s notification for details).`);
        let unplaced = 0;
        if (args.arrange !== false) unplaced = (await runArrange('plate', { imported: ids }))?.unplaced ?? 0;
        return { data: { ok: true, imported: ids.filter((id) => getObject(id)).map((id) => objectDetail(id)), unplaced: unplaced || undefined } };
      },
    },

    {
      name: 'export_stl',
      description: 'Save objects as one binary STL (Z-up, bed coordinates): `ids`, or the printable objects of the active plate (or `plate`). cubby-mcp writes it to savePath.',
      fileOutput: true,
      inputSchema: obj({ ids: strList('Object ids.'), plate: num('Plate (1-based).') }),
      run(args) {
        const list = args.ids !== undefined ? idsArg(args).map((id) => getObject(id)!) : objectsOnPlate(plateArg(args) ?? activePlate.value).filter((o) => o.printable);
        if (!list.length) throw new Error('Nothing to export: the plate is empty.');
        const stem = (list.length === 1 ? list[0].name : projectName.value || 'plate').replace(/[^\w.-]+/g, '_');
        return { data: { ok: true, objects: list.length }, file: { name: `${stem}.stl`, mimeType: 'model/stl', base64: bytesToBase64(buildStl(list, getMesh)) } };
      },
    },

    {
      name: 'add_part',
      description:
        'Add a volume to an object: type part | negative | modifier | support_blocker | support_enforcer, shape box | cylinder | sphere | slab, or "file" with a model file (path / url through cubby-mcp, or dataBase64 + name). ' +
        'size [x, y, z] mm (default: sized from the object like the app); position [x, y, z] in the object’s local frame (default its centre; a slab sits on its bottom). ' +
        'Give a modifier its settings with set_settings (objectId + partId).',
      fileInput: true,
      timeoutMs: 300_000,
      inputSchema: obj({
        objectId: str('Object id.'), type: oneOfS(PART_TYPES, 'Volume type.'), shape: oneOfS(SHAPES, 'Shape, or "file".'),
        size: vec3s('Bounding box mm.'), position: vec3s('Object-local centre mm.'), rotation: vec3s('XYZ Euler degrees.'), partName: str('Name.'),
        name: str('File name (shape "file").'), dataBase64: str('File bytes (shape "file").'),
      }, ['objectId', 'type', 'shape']),
      async run(args) {
        const o = objectArg(args);
        const type = oneOf(args.type, PART_TYPES, 'type');
        const shape = oneOf(args.shape, SHAPES, 'shape');
        const size = vec3(args.size, 'size');
        if (size && size.some((v) => !(v > 0))) throw new Error('size values must be > 0.');
        const at = vec3(args.position, 'position') ?? undefined;
        const partName = argString(args, 'partName', { optional: true });
        let pid: string | null;
        if (shape === 'file') {
          const name = argString(args, 'name', { optional: true }), data = argString(args, 'dataBase64', { optional: true });
          if (!name || !data) throw new Error('shape "file" needs a file: pass path or url (through cubby-mcp), or name + dataBase64.');
          const bytes = base64ToBytes(data);
          pid = await addModelPart(o.id, type, name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { at, name: partName });
          if (!pid) throw new Error(`No geometry in ${name}.`);
        } else {
          pid = addPrimitivePart(o.id, type, shape as PrimitiveKind, { size: size ?? undefined, at, name: partName });
        }
        if (!pid) throw new Error('Couldn’t add the part.');
        const rot = vec3(args.rotation, 'rotation');
        if (rot) setPartTransform(o.id, pid, { rotation: quatFromEuler(rot[0] / DEG, rot[1] / DEG, rot[2] / DEG) }, 'Rotate part');
        activeView.value = 'prepare';
        return { data: { ok: true, partId: pid, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'update_part',
      description: 'Change a part: name, type (part | negative | modifier | support_blocker | support_enforcer), position [x, y, z] (object-local mm), rotation [x, y, z] (XYZ Euler degrees), scale (factor or [sx, sy, sz]).',
      inputSchema: obj({
        objectId: str('Object id.'), partId: str('Part id (list_objects).'), name: str('New name.'), type: oneOfS(PART_TYPES, 'New type.'),
        position: vec3s('Object-local mm.'), rotation: vec3s('XYZ Euler degrees.'), scale: { type: ['number', 'array'], description: 'Factor or [sx, sy, sz].' },
      }, ['objectId', 'partId']),
      run(args) {
        const o = objectArg(args);
        const p = partArg(o, args.partId);
        const name = argString(args, 'name', { optional: true });
        if (name !== undefined) renamePart(o.id, p.id, name);
        if (args.type !== undefined) setPartType(o.id, p.id, oneOf(args.type, PART_TYPES, 'type'));
        const position = vec3(args.position, 'position') ?? undefined;
        const r = vec3(args.rotation, 'rotation');
        const rotation = r ? quatFromEuler(r[0] / DEG, r[1] / DEG, r[2] / DEG) : undefined;
        let scale: Vec3 | undefined;
        if (typeof args.scale === 'number') { if (!(args.scale > 0)) throw new Error('scale must be > 0.'); scale = [args.scale, args.scale, args.scale]; }
        else if (args.scale !== undefined) { scale = vec3(args.scale, 'scale')!; if (scale.some((v) => v === 0)) throw new Error('scale factors must not be 0.'); }
        if (position || rotation || scale) setPartTransform(o.id, p.id, { position, rotation, scale }, 'Move part');
        return { data: { ok: true, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'remove_part',
      description: 'Delete a part / modifier / negative part / support blocker or enforcer from an object.',
      inputSchema: obj({ objectId: str('Object id.'), partId: str('Part id.') }, ['objectId', 'partId']),
      run(args) {
        const o = objectArg(args);
        const p = partArg(o, args.partId);
        removePart(o.id, p.id);
        return { data: { ok: true, object: objectDetail(o.id) } };
      },
    },

    {
      name: 'measure',
      description:
        'Measure (mm): with ids, each object’s size and bounding box, and for two objects the centre distance and the gap between their boxes per axis (negative = overlap). ' +
        'With points [[x,y,z],[x,y,z]] (bed coordinates), their distance and delta.',
      inputSchema: obj({ ids: strList('One or two object ids.'), points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Two points.' } }),
      run(args) {
        const out: Record<string, unknown> = {};
        if (args.points !== undefined) {
          const pts = args.points as unknown[];
          if (!Array.isArray(pts) || pts.length !== 2) throw new Error('points must be two [x, y, z] points.');
          const a = vec3(pts[0], 'points[0]')!, b = vec3(pts[1], 'points[1]')!;
          const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          out.points = { distance: round(Math.hypot(d[0], d[1], d[2]), 3), delta: r3(d, 3) };
        }
        if (args.ids !== undefined) {
          const ids = idsArg(args);
          if (ids.length > 2) throw new Error('measure takes one or two object ids.');
          const boxes = ids.map((id) => ({ id, name: getObject(id)!.name, box: bedBox(id)!, world: objectInfo.value.get(id)! }));
          out.objects = boxes.map((b) => ({ id: b.id, name: b.name, size: b.box.max.map((v, i) => round(v - b.box.min[i])), min: r3(b.box.min), max: r3(b.box.max) }));
          if (boxes.length === 2) {
            const [a, b] = boxes.map((x) => x.world);
            const ca = [0, 1, 2].map((k) => (a.min[k] + a.max[k]) / 2), cb = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
            const gap = [0, 1, 2].map((k) => round(Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k])));
            out.between = { centreDistance: round(Math.hypot(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]), 3), centreDelta: r3([0, 1, 2].map((k) => cb[k] - ca[k]), 3), gap, overlapping: gap.every((g) => g < 0) };
          }
        }
        if (!Object.keys(out).length) throw new Error('Pass ids (one or two objects) or points (two points).');
        return { data: out };
      },
    },
  ];
}
