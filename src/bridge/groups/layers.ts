/**
 * Bridge tools: variable layer height (Orca's layer editing: adaptive,
 * smooth, reset, or explicit bands / profiles), height range modifiers and
 * custom G-code per layer (the preview slider's colour change / filament
 * change / pause / custom G-code ticks). All undoable through the stores.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { activeEngine } from '../../app/state';
import { getSchema } from '../../engine/client';
import type { ConfigValue, CustomGcodeItem } from '../../engine/types';
import { getObject } from '../../project/store';
import {
  addLayerRange, getRange, hasCustomProfile, layersUi, objectHeight, paramsFor, profileOf, rangeBoundsError, removeAllLayerRanges,
  removeLayerRange, resetLayerProfile, runAdaptive, runSmooth, setLayerProfile, setLayerRangeBounds, setRangeOverride,
} from '../../layers/store';
import { generateLayers, profileFromRanges, sanitizeProfile } from '../../layers/profile';
import { addCustomGcode, clearCustomGcodes, nextChangeColor, plateCustomGcodes, removeCustomGcode } from '../../plates/store';
import { activePlate } from '../../project/store';
import { previewData } from '../../preview/store';
import { tickTitle, zOfLayer } from '../../preview/customGcode';
import { currentPresets, presetsSettled } from '../../presets/store';
import { mixedFilaments } from '../../mixed/store';
import { nearestLayer, oneOf, profileSummary } from '../logic';
import { parseSetting } from './settings';
import { num, obj, objectArg, oneOfS, plateArg, round, str } from './util';

const VLH_MODES = ['adaptive', 'smooth', 'reset', 'bands', 'profile'] as const;
const RANGE_OPS = ['add', 'update', 'remove', 'clear'] as const;
const GCODE_OPS = ['add', 'remove', 'clear', 'list'] as const;
const GCODE_TYPES = ['color_change', 'tool_change', 'pause', 'custom', 'template'] as const;

function layerInfo(id: string) {
  const o = getObject(id)!;
  const p = paramsFor(o);
  const profile = profileOf(o, p);
  const layers = generateLayers(p, profile);
  return {
    objectId: id, height: round(objectHeight(id)), custom: hasCustomProfile(o),
    limits: { layerHeight: p.layerHeight, firstLayer: p.firstLayerHeight, min: round(p.minLayerHeight, 3), max: round(p.maxLayerHeight, 3) },
    profile: profile.map((v) => round(v, 4)), summary: profileSummary(profile), layers: layers.length,
  };
}

async function applySettings(objectId: string, rangeId: string, settings: unknown): Promise<Record<string, string>> {
  const rejected: Record<string, string> = {};
  if (settings === undefined) return rejected;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object.');
  await presetsSettled();
  const schema = currentPresets.value.schema.value;
  for (const [k, raw] of Object.entries(settings as Record<string, unknown>)) {
    const def = schema?.options[k];
    if (!def) { rejected[k] = 'unknown key (see find_settings)'; continue; }
    if (def.scope !== 'print' && k !== 'extruder') { rejected[k] = 'only process settings and "extruder" go on a height range'; continue; }
    if (raw === null) { setRangeOverride(objectId, rangeId, k, undefined); continue; }
    const r = parseSetting(def, raw);
    if ('error' in r) { rejected[k] = r.error; continue; }
    setRangeOverride(objectId, rangeId, k, r.value as ConfigValue);
  }
  return rejected;
}

export function layerTools(): BridgeTool[] {
  return [
    {
      name: 'get_layer_heights',
      description: 'An object’s layer heights: its variable layer height profile [z0, h0, z1, h1, …] (z mm from the object’s bottom, h = layer height there; or the uniform / height-range profile when it has none), the limits and the layer count.',
      inputSchema: obj({ objectId: str('Object id.') }, ['objectId']),
      run(args) { return { data: layerInfo(objectArg(args).id) }; },
    },

    {
      name: 'set_layer_heights',
      description:
        'Variable layer height for one object. mode: adaptive (Orca’s adaptive, `quality` 0 = fine … 1 = coarse, default 0.5), smooth (`radius` 1-10, `keepMin`), reset (uniform again), ' +
        'bands (list of { min, max, height } mm from the object’s bottom; the rest keeps the normal layer height), or profile ([z0, h0, z1, h1, …]). Heights are clamped to the printer’s min / max layer height.',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({
        objectId: str('Object id.'), mode: oneOfS(VLH_MODES, 'What to do.'),
        quality: num('adaptive: 0-1.'), radius: num('smooth: 1-10.'), keepMin: { type: 'boolean', description: 'smooth: keep minimum heights.' },
        bands: { type: 'array', items: obj({ min: num('mm'), max: num('mm'), height: num('Layer height mm.') }, ['min', 'max', 'height']), description: 'bands mode.' },
        profile: { type: 'array', items: { type: 'number' }, description: 'profile mode: [z0, h0, z1, h1, …].' },
      }, ['objectId', 'mode']),
      async run(args) {
        const o = objectArg(args);
        const mode = oneOf(args.mode, VLH_MODES, 'mode');
        if (layersUi.busy) throw new Error('The layer editor is busy (adaptive / smooth running). Try again in a moment.');
        const p = paramsFor(o);
        const clamp = (h: number) => Math.max(p.minLayerHeight, Math.min(p.maxLayerHeight, h));
        let clamped = false;
        switch (mode) {
          case 'adaptive': {
            const q = argNumber(args, 'quality', { optional: true }) ?? 0.5;
            if (!(q >= 0 && q <= 1)) throw new Error('quality must be 0-1.');
            await runAdaptive(o.id, q);
            break;
          }
          case 'smooth': {
            const r = argNumber(args, 'radius', { optional: true }) ?? 5;
            if (!(r >= 1 && r <= 10)) throw new Error('radius must be 1-10.');
            await runSmooth(o.id, Math.round(r), args.keepMin === true);
            break;
          }
          case 'reset': resetLayerProfile(o.id); break;
          case 'bands': {
            const bands = args.bands;
            if (!Array.isArray(bands) || !bands.length) throw new Error('bands must be a list of { min, max, height }.');
            const ranges = bands.map((b, i) => {
              const r = b as { min?: unknown; max?: unknown; height?: unknown };
              if (typeof r.min !== 'number' || typeof r.max !== 'number' || typeof r.height !== 'number' || !(r.max > r.min) || r.min < 0 || !(r.height > 0)) {
                throw new Error(`bands[${i}] must be { min, max, height } with 0 ≤ min < max and height > 0.`);
              }
              const h = clamp(r.height);
              if (h !== r.height) clamped = true;
              return { min: r.min, max: r.max, layerHeight: h };
            });
            setLayerProfile(o.id, profileFromRanges(p, ranges));
            break;
          }
          case 'profile': {
            const prof = sanitizeProfile(args.profile);
            if (!prof.length) throw new Error('profile must be [z0, h0, z1, h1, …] with z rising from 0 and heights > 0 (at least two points).');
            const c = prof.map((v, i) => (i % 2 ? clamp(v) : v));
            clamped = c.some((v, i) => v !== prof[i]);
            setLayerProfile(o.id, c);
            break;
          }
        }
        return { data: { ok: true, ...layerInfo(o.id), note: clamped ? `Some heights were clamped to ${round(p.minLayerHeight, 3)}-${round(p.maxLayerHeight, 3)} mm.` : undefined } };
      },
    },

    {
      name: 'height_range',
      description:
        'Height range modifiers (Orca "Height range Modifier": settings for a Z range of an object). op: add (new range; `min` / `max` mm from the object’s bottom, default after the last one), ' +
        'update (`rangeId`: new bounds and / or settings), remove (`rangeId`), clear (all). settings: process setting key → value (null resets), e.g. { "layer_height": 0.12, "sparse_infill_density": "40%" }; also settable with set_settings (objectId + rangeId).',
      inputSchema: obj({
        objectId: str('Object id.'), op: oneOfS(RANGE_OPS, 'What to do.'), rangeId: str('Range id (list_objects heightRanges).'),
        min: num('Bottom, mm from the object’s bottom.'), max: num('Top, mm.'), settings: { type: 'object', description: 'Key → value.' },
      }, ['objectId', 'op']),
      async run(args) {
        const o = objectArg(args);
        const op = oneOf(args.op, RANGE_OPS, 'op');
        const min = argNumber(args, 'min', { optional: true }), max = argNumber(args, 'max', { optional: true });
        let rid: string | undefined;
        let rejected: Record<string, string> = {};
        if (op === 'clear') removeAllLayerRanges(o.id);
        else if (op === 'add') {
          if (min !== undefined && max !== undefined) {
            const err = rangeBoundsError(o, '', min, max);
            if (err) throw new Error(err);
          }
          rid = addLayerRange(o.id) ?? undefined;
          if (!rid) throw new Error('No room for another range above the last one; pass min / max, or update an existing range.');
          if (min !== undefined || max !== undefined) {
            const r = getRange(o.id, rid)!;
            if (!setLayerRangeBounds(o.id, rid, min ?? r.min, max ?? r.max)) {
              removeLayerRange(o.id, rid);
              throw new Error(rangeBoundsError(getObject(o.id)!, rid, min ?? r.min, max ?? r.max) ?? 'Invalid bounds.');
            }
          }
          rejected = await applySettings(o.id, rid, args.settings);
        } else {
          rid = argString(args, 'rangeId')!;
          const r = getRange(o.id, rid);
          if (!r) throw new Error(`No height range "${rid}" on ${o.name}. Ranges: ${(o.layerRanges ?? []).map((x) => `${x.id} (${x.min}–${x.max})`).join(', ') || 'none'}.`);
          if (op === 'remove') removeLayerRange(o.id, rid);
          else {
            if (min !== undefined || max !== undefined) {
              const err = rangeBoundsError(o, rid, min ?? r.min, max ?? r.max);
              if (err) throw new Error(err);
              setLayerRangeBounds(o.id, rid, min ?? r.min, max ?? r.max);
            }
            rejected = await applySettings(o.id, rid, args.settings);
          }
        }
        const now = getObject(o.id)!;
        return { data: { ok: !Object.keys(rejected).length, rangeId: rid, rejected: Object.keys(rejected).length ? rejected : undefined, ranges: (now.layerRanges ?? []).map((x) => ({ id: x.id, min: x.min, max: x.max, overrides: x.overrides })) } };
      },
    },

    {
      name: 'custom_gcode',
      description:
        'Custom G-code at a layer of a plate (the preview slider’s ticks): op add | remove | clear | list. Give `z` (print Z, mm) or `layer` (1-based, from the plate’s last slice when it is the active plate). ' +
        'type: color_change (engines with M600: preFlight, Full Spectrum; `color` "#RRGGBB"), tool_change (switch to `filament`; OrcaSlicer changes colour this way), pause (`message`), custom (`gcode`), template (the printer’s template_custom_gcode). ' +
        'Changes mark the plate’s slice out of date.',
      inputSchema: obj({
        op: oneOfS(GCODE_OPS, 'What to do.'), plate: num('Plate (1-based, default active).'), z: num('Print Z mm.'), layer: num('Layer number (1-based).'),
        type: oneOfS(GCODE_TYPES, 'For add.'), color: str('color_change: "#RRGGBB" (default: the next palette colour).'), filament: num('tool_change / color_change: filament (1-based).'),
        message: str('pause: message.'), gcode: str('custom: G-code text.'),
      }, ['op']),
      async run(args) {
        const op = oneOf(args.op, GCODE_OPS, 'op');
        const plate = plateArg(args) ?? activePlate.value;
        const list = () => plateCustomGcodes(plate).map((g) => ({ ...g, title: tickTitle(g) }));
        if (op === 'list') return { data: { plate: plate + 1, items: list() } };
        if (op === 'clear') { clearCustomGcodes(plate); return { data: { ok: true, plate: plate + 1, items: list() } }; }
        const pd = plate === activePlate.value ? previewData.value : null;
        let z = argNumber(args, 'z', { optional: true });
        const layer = argNumber(args, 'layer', { optional: true });
        if (layer !== undefined) {
          if (!pd) throw new Error('`layer` needs the plate’s preview: make it the active plate, slice it, then retry (or pass z in mm).');
          if (!Number.isInteger(layer) || layer < 1 || layer > pd.layerCount) throw new Error(`layer must be 1-${pd.layerCount}.`);
          z = zOfLayer(pd.layerZ, layer - 1);
        } else if (z !== undefined && pd) {
          const i = nearestLayer(pd.layerZ, z);
          if (i !== null) z = zOfLayer(pd.layerZ, i);
        }
        if (z === undefined) throw new Error('Pass z (print Z, mm) or layer.');
        if (op === 'remove') {
          // The item nearest the given z (within 0.1 mm, or on the same layer).
          const want = argNumber(args, 'z', { optional: true }) ?? z;
          const items = plateCustomGcodes(plate);
          const hit = items.find((g) => Math.abs(g.z - want) < 0.1) ?? items.find((g) => Math.abs(g.z - z!) < 1e-4);
          if (!hit) throw new Error(`No custom G-code at z ${want} on plate ${plate + 1}. Items at z: ${items.map((g) => g.z).join(', ') || 'none'}.`);
          removeCustomGcode(plate, hit.z);
          return { data: { ok: true, plate: plate + 1, items: list() } };
        }
        const type = oneOf(args.type, GCODE_TYPES, 'type');
        const nFil = currentPresets.value.selection.filaments.length + mixedFilaments.value.length;
        const f = argNumber(args, 'filament', { optional: true });
        if (f !== undefined && (!Number.isInteger(f) || f < 1 || f > nFil)) throw new Error(`filament must be 1-${nFil}.`);
        const item: CustomGcodeItem = { z, type };
        if (type === 'color_change') {
          const schema = await getSchema(activeEngine.value).catch(() => null);
          if (schema && !schema.options.color_change_gcode) throw new Error('This engine (OrcaSlicer) changes colour by switching filament: use type "tool_change" with filament N (set_filaments adds a slot).');
          const c = argString(args, 'color', { optional: true });
          if (c && !/^#[0-9a-f]{6}$/i.test(c)) throw new Error('color must be "#RRGGBB".');
          item.color = c ?? nextChangeColor(plateCustomGcodes(plate));
          item.extruder = f ?? 1;
        } else if (type === 'tool_change') {
          if (f === undefined) throw new Error('tool_change needs filament (the filament to switch to).');
          if (nFil < 2) throw new Error('A filament change needs at least 2 filaments (set_filaments count 2).');
          item.extruder = f;
        } else if (type === 'pause') item.extra = argString(args, 'message', { optional: true }) ?? '';
        else if (type === 'custom') {
          const g = argString(args, 'gcode', { optional: true });
          if (!g?.trim()) throw new Error('custom needs gcode.');
          item.extra = g;
        }
        if (!addCustomGcode(plate, item)) throw new Error(`There is already a different custom G-code at z ${z}. Remove it first (op "remove").`);
        return { data: { ok: true, plate: plate + 1, z, items: list() } };
      },
    },
  ];
}
