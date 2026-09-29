/**
 * Bridge tools: plates (Orca's plate list). Add / delete (the app's confirm
 * when objects would go with it), rename, lock, plate settings, the active
 * plate, moving objects between plates and arranging.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { addPlateCmd, deletePlateCmd, reportUnplaced, selectPlate } from '../../app/shell/actions';
import { useSliceController } from '../../app/slice';
import type { ConfigValue } from '../../engine/types';
import { activePlate, arrangeObjects, moveObjectsToPlate, objects, objectsOnPlate, plates, renamePlate, setPlateLocked } from '../../project/store';
import { MAX_PLATES, plateLabel } from '../../project/plates';
import { PLATE_KEYS, plateConfig, setPlateConfig } from '../../plates/store';
import { currentPresets, presetsSettled } from '../../presets/store';
import { oneOf } from '../logic';
import { parseSetting } from './settings';
import { bool, idsArg, num, obj, objectDetail, oneOfS, plateArg, plateIndexOf, str, strList } from './util';

function plateRows() {
  const states = useSliceController().plateStates.value;
  return plates.value.map((p, i) => ({
    plate: i + 1, name: plateLabel(p, i), locked: p.locked, active: i === activePlate.value,
    objects: objectsOnPlate(i).map((o) => o.id), slice: states[i] ?? 'none',
    settings: p.config, customGcodes: p.customGcodes,
  }));
}

export function plateTools(): BridgeTool[] {
  return [
    {
      name: 'list_plates',
      description: `Plates (1-based): name, locked, active, object ids, slice state (none / stale / done), plate settings (${PLATE_KEYS.join(', ')}) and custom G-codes.`,
      inputSchema: obj({}),
      run() { return { data: { activePlate: activePlate.value + 1, max: MAX_PLATES, plates: plateRows() } }; },
    },

    {
      name: 'add_plate',
      description: 'Add an empty plate at the end; it becomes the active plate (new imports land on it).',
      inputSchema: obj({ name: str('Optional name.') }),
      run(args) {
        const before = plates.value.length;
        addPlateCmd();
        if (plates.value.length === before) throw new Error(`That’s the maximum of ${MAX_PLATES} plates.`);
        const name = argString(args, 'name', { optional: true });
        if (name) renamePlate(activePlate.value, name);
        return { data: { ok: true, plate: activePlate.value + 1, plates: plateRows() } };
      },
    },

    {
      name: 'delete_plate',
      description: 'Delete a plate. When objects are on it the app asks the user first (they are deleted with the plate; undo brings them back). At least one plate stays.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ plate: num('Plate number (1-based).') }, ['plate']),
      async run(args) {
        const i = plateArg(args)!;
        if (plates.value.length <= 1) throw new Error('The last plate can’t be deleted.');
        const n = plates.value.length;
        await deletePlateCmd(i);
        if (plates.value.length === n) return { data: { ok: false, error: 'The user declined.' } };
        return { data: { ok: true, plates: plateRows() } };
      },
    },

    {
      name: 'update_plate',
      description:
        'Change a plate: name, locked (skipped by arrange all / orient all), active (make it the plate that is sliced, previewed and receives imports), ' +
        `and settings (replaces the plate’s own settings; keys: ${PLATE_KEYS.join(', ')}; e.g. { "curr_bed_type": "Textured PEI Plate", "print_sequence": "by object", "spiral_mode": true }). Omitted keys follow the global settings.`,
      inputSchema: obj({
        plate: num('Plate number (1-based).'), name: str('New name ("" = "Plate N").'), locked: bool('Lock / unlock.'), active: bool('Make active.'),
        settings: { type: 'object', description: 'Plate setting key → value; {} clears them.' },
      }, ['plate']),
      async run(args) {
        const i = plateArg(args)!;
        const name = argString(args, 'name', { optional: true });
        if (name !== undefined) renamePlate(i, name);
        if (typeof args.locked === 'boolean') setPlateLocked(i, args.locked);
        const rejected: Record<string, string> = {};
        if (args.settings !== undefined) {
          const s = args.settings as Record<string, unknown>;
          if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('settings must be an object.');
          await presetsSettled();
          const schema = currentPresets.value.schema.value;
          const next: Record<string, ConfigValue> = {};
          for (const [k, raw] of Object.entries(s)) {
            if (!(PLATE_KEYS as readonly string[]).includes(k)) { rejected[k] = `not a plate setting (${PLATE_KEYS.join(', ')})`; continue; }
            if (raw === null) continue;
            const def = schema?.options[k];
            if (!def) { rejected[k] = 'not used by this engine'; continue; }
            const r = parseSetting(def, raw);
            if ('error' in r) { rejected[k] = r.error; continue; }
            next[k] = r.value;
          }
          if (!Object.keys(rejected).length) setPlateConfig(i, next);
        }
        if (args.active === true) selectPlate(i);
        return { data: { ok: !Object.keys(rejected).length, rejected: Object.keys(rejected).length ? rejected : undefined, plate: plateRows()[i], settings: plateConfig(i) } };
      },
    },

    {
      name: 'move_to_plate',
      description: 'Move objects to another plate, keeping their spot on the bed when it is free, else arranging them there. That plate becomes active.',
      inputSchema: obj({ ids: strList('Object ids.'), plate: num('Target plate (1-based).') }, ['ids', 'plate']),
      run(args) {
        const ids = idsArg(args);
        const i = plateArg(args)!;
        moveObjectsToPlate(ids, i);
        return { data: { ok: true, objects: ids.map((id) => ({ id, plate: plateIndexOf(id) + 1 })), activePlate: activePlate.value + 1 } };
      },
    },

    {
      name: 'arrange',
      description: 'Arrange like the Arrange buttons: scope "plate" (the active plate, or `plate`), "all" (every unlocked plate; what doesn’t fit spills onto new plates) or `ids` (those objects on the active plate around the rest).',
      inputSchema: obj({
        scope: oneOfS(['plate', 'all'], 'Default "plate".'), plate: num('Plate for scope "plate" (1-based).'), ids: strList('Only these objects.'),
        spacing: num('Gap in mm (default 6).'), allPlates: bool('Older form of scope "all".'),
      }),
      run(args) {
        const spacing = argNumber(args, 'spacing', { optional: true }) ?? 6;
        if (!(spacing >= 0 && spacing <= 100)) throw new Error('spacing must be 0-100 mm.');
        const scope = args.allPlates === true ? 'all' : args.scope === undefined ? 'plate' : oneOf(args.scope, ['plate', 'all'] as const, 'scope');
        const plate = plateArg(args);
        if (plate !== undefined) selectPlate(plate);
        const ids = args.ids !== undefined ? idsArg(args) : undefined;
        const unplaced = arrangeObjects(ids, spacing, ids ? 'plate' : scope);
        if (unplaced) reportUnplaced(unplaced);
        return { data: { ok: true, unplaced, plates: plates.value.length, objects: objects.value.map((o) => ({ ...objectDetail(o.id), parts: undefined })) } };
      },
    },
  ];
}
