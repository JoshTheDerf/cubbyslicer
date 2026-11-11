/**
 * Bridge tools: the Calibration menu (Orca calib_dlg + Plater::calib_*) and
 * the handy test models. Parameters default like the dialogs and are checked
 * by the same form builders. A calibration starts a new project: when the
 * plate has objects the app asks the user first, exactly like the menu.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { activeEngine, resolvedConfig } from '../../app/state';
import { calibrationUnavailable } from '../../engine/capabilities';
import type { CalibParams } from '../../engine/types';
import type { CalibRequest } from '../../calibration/plan';
import { currentPresets, presetsSettled } from '../../presets/store';
import { asList, cfgString, SCALAR } from '../../lib/configValue';
import { HANDY_MODELS } from '../../calibration/handyModels';
import {
  corneringDefaults, corneringParams, paDefaults, paParams, rangeDefaults, rangeParams, SHAPING_DAMP_DEFAULTS, SHAPING_FREQ_DEFAULTS, shaperTypesFor,
  paMethodsFor, shapingDampParams, shapingFreqParams, tempFilamentOf, tempParams, tempRangeFor, vfaAdjust, type PAMethod,
} from '../../calibration/forms';
import { activeCalib } from '../../calibration/state';
import { objects } from '../../project/store';
import { oneOf } from '../logic';
import { bool, num, obj, objectBrief, oneOfS, str } from './util';

const TESTS = ['temp', 'flow', 'pa', 'retraction', 'volumetric', 'vfa', 'is_freq', 'is_damp', 'cornering', 'tolerance'] as const;
const HANDY = HANDY_MODELS.map((m) => m.id);
const FLOW = ['yolo', 'yolo_perfectionist', 'pass1', 'pass2'] as const;

export function calibrationTools(): BridgeTool[] {
  return [
    {
      name: 'calibrate',
      description:
        'Set up a calibration print from the Calibration menu (OrcaSlicer engine). It replaces the project: with objects on the plate the user confirms in the browser. Then slice. ' +
        'test: temp (start / end °C, default from the filament type), flow (type yolo | yolo_perfectionist | pass1 | pass2, pattern archimedeanchords | monotonic), ' +
        'temp also takes resize (auto-scale for the nozzle, default true) and on belt printers model 0 standard | 1 overhang. ' +
        'pa (method pa_tower | pa_line | pa_pattern — belt printers: pa_tower only, bowden, start / end / step, printNumbers, accels / speeds comma lists for pa_pattern), ' +
        'retraction (mm), volumetric (mm³/s), vfa (mm/s) (start / end / step; vfa also resize and autoAdjust (default true): when the end speed exceeds the filament’s max volumetric speed the layer height and, if needed, the end speed are lowered, as the dialog does — reported in warning), is_freq (startX / endX / startY / endY Hz, damp, shaper, model 0 ringing | 1 fast), ' +
        'is_damp (freqX / freqY Hz, start / end 0-1, shaper, model), cornering (start / end: jerk mm/s or junction deviation mm, model 0-2), tolerance (Orca tolerance test model). ' +
        'The test’s suggested settings become unsaved preset edits, like in the app.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({
        test: oneOfS(TESTS, 'Calibration.'),
        start: num('Range start.'), end: num('Range end.'), step: num('Range step.'),
        type: oneOfS(FLOW, 'flow: which test (default yolo).'), pattern: oneOfS(['archimedeanchords', 'monotonic'], 'flow: top pattern.'),
        method: oneOfS(['pa_tower', 'pa_line', 'pa_pattern'], 'pa: method (default pa_tower).'), bowden: bool('pa: Bowden extruder.'), printNumbers: bool('pa_line: print numbers.'),
        accels: str('pa_pattern: accelerations, e.g. "1000,3000".'), speeds: str('pa_pattern: speeds, e.g. "100,200".'),
        startX: num('Hz'), endX: num('Hz'), startY: num('Hz'), endY: num('Hz'), damp: num('0-1'), freqX: num('Hz'), freqY: num('Hz'),
        shaper: str('Input shaper type (depends on the firmware; the error lists them).'), model: num('Test model 0 / 1 (cornering 0-2; temp on belt printers 0 standard | 1 overhang).'),
        resize: bool('temp / vfa: auto-scale for the nozzle (default true).'), autoAdjust: bool('vfa: auto-adjust to the filament’s max volumetric speed (default true; needs resize).'),
      }, ['test']),
      async run(args) {
        const test = oneOf(args.test, TESTS, 'test');
        await presetsSettled();
        const run = await import('../../calibration/run');
        const unavailable = test === 'tolerance' ? null : calibrationUnavailable(activeEngine.value);
        if (unavailable) throw new Error(`${unavailable} (set_engine)`);
        const n = (k: string, d: number) => argNumber(args, k, { optional: true }) ?? d;
        const b = (k: string, d: boolean) => (typeof args[k] === 'boolean' ? args[k] as boolean : d);
        const facts = run.calibPrinterFacts();
        const shaperOf = () => {
          const list = shaperTypesFor(facts.flavor);
          return args.shaper === undefined ? list[0] : oneOf(args.shaper, list, 'shaper');
        };
        let params: CalibRequest | string | null = null;
        let runner: ((p: CalibParams) => Promise<boolean>) | null = null;
        let warning: string | undefined;
        let ok: boolean;
        switch (test) {
          case 'tolerance': ok = await run.addToleranceTest(); break;
          case 'flow': {
            const t = args.type === undefined ? 'yolo' : oneOf(args.type, FLOW, 'type');
            const pattern = args.pattern === undefined ? 'archimedeanchords' : oneOf(args.pattern, ['archimedeanchords', 'monotonic'] as const, 'pattern');
            ok = await run.calibFlowRate({ linear: t.startsWith('yolo'), pass: t === 'pass2' || t === 'yolo_perfectionist' ? 2 : 1, pattern });
            break;
          }
          default: {
            const cfg = resolvedConfig.value;
            if (test === 'temp') {
              const type = asList(currentPresets.value.value('filament', 'filament_type', 0))[0] ?? cfgString(cfg, 'filament_type', SCALAR, 'PLA');
              const d = tempRangeFor(tempFilamentOf(type));
              const model = facts.belt ? n('model', 0) : 0;
              if (model !== 0 && model !== 1) throw new Error('model must be 0 (standard) or 1 (overhang).');
              params = tempParams(n('start', d.start), n('end', d.end), b('resize', true), model); runner = run.calibTemp;
            } else if (test === 'pa') {
              const method: PAMethod = args.method === undefined ? 'pa_tower' : oneOf(args.method, paMethodsFor(facts.belt), 'method');
              const bowden = typeof args.bowden === 'boolean' ? args.bowden : cfgString(cfg, 'extruder_type', SCALAR) === 'Bowden';
              const d = paDefaults(method, bowden);
              params = paParams({
                method, bowden, start: n('start', d.start), end: n('end', d.end), step: n('step', d.step),
                printNumbers: typeof args.printNumbers === 'boolean' ? args.printNumbers : d.printNumbers,
                accels: argString(args, 'accels', { optional: true }) ?? '', speeds: argString(args, 'speeds', { optional: true }) ?? '',
              });
              runner = run.calibPA;
            } else if (test === 'vfa') {
              const d = rangeDefaults('vfa_tower');
              const r = rangeParams('vfa_tower', n('start', d.start), n('end', d.end), n('step', d.step));
              if (typeof r === 'string') throw new Error(r);
              const resize = b('resize', true);
              const adj = await vfaAdjust(r, resize, b('autoAdjust', true), { nozzle: facts.nozzle, lineWidth: facts.vfa.wallLineWidth, ...facts.vfa }, run.compatibleLayerHeights);
              // No one to ask: apply the dialog's adjustment and report its message.
              if (adj.kind !== 'ok') warning = adj.message;
              params = { ...r, nozzleBasedResize: resize, vfaLayerHeight: adj.kind === 'reduced' || adj.kind === 'lower-end' ? adj.layerHeight : 0, ...(adj.kind === 'lower-end' ? { end: adj.end } : {}) };
              runner = run.calibVFA;
            } else if (test === 'retraction' || test === 'volumetric') {
              const mode = test === 'retraction' ? 'retraction_tower' : 'vol_speed_tower';
              const d = rangeDefaults(mode);
              params = rangeParams(mode, n('start', d.start), n('end', d.end), n('step', d.step));
              runner = test === 'retraction' ? run.calibRetraction : run.calibMaxVolSpeed;
            } else if (test === 'is_freq') {
              const d = SHAPING_FREQ_DEFAULTS;
              params = shapingFreqParams({ model: n('model', d.model) === 1 ? 1 : 0, shaper: shaperOf(), startX: n('startX', d.startX), endX: n('endX', d.endX), startY: n('startY', d.startY), endY: n('endY', d.endY), damp: n('damp', d.damp) }, facts.flavor === 'reprapfirmware');
              runner = run.calibInputShapingFreq;
            } else if (test === 'is_damp') {
              const d = SHAPING_DAMP_DEFAULTS;
              params = shapingDampParams({ model: n('model', d.model) === 1 ? 1 : 0, shaper: shaperOf(), freqX: n('freqX', d.freqX), freqY: n('freqY', d.freqY), start: n('start', d.start), end: n('end', d.end) }, facts.flavor === 'reprapfirmware');
              runner = run.calibInputShapingDamp;
            } else {
              const d = corneringDefaults(facts.junctionDeviation);
              const model = n('model', 0);
              if (![0, 1, 2].includes(model)) throw new Error('model must be 0, 1 or 2.');
              const r = corneringParams(n('start', d.start), n('end', d.end), model, facts.junctionDeviation);
              if (typeof r === 'string') params = r; else { params = r.params; warning = r.warning; }
              runner = run.calibCornering;
            }
            if (typeof params === 'string') throw new Error(params);
            ok = await runner!(params!);
          }
        }
        if (!ok) return { data: { ok: false, error: 'Not started: the user cancelled, or the setup failed (see the app’s notification).' } };
        return { data: { ok: true, test, calibration: activeCalib.value, warning, objects: objects.value.map((o) => objectBrief(o.id)), next: 'Slice with slice, then print or export.' } };
      },
    },

    {
      name: 'add_test_model',
      description: `Add a handy test model to the active plate (Add ▸ Handy models): ${HANDY.join(', ')}.`,
      timeoutMs: 120_000,
      inputSchema: obj({ id: oneOfS(HANDY, 'Model.') }, ['id']),
      async run(args) {
        const id = oneOf(args.id, HANDY, 'id');
        const before = new Set(objects.value.map((o) => o.id));
        const run = await import('../../calibration/run');
        if (!(await run.addHandyModel(id))) throw new Error(`Couldn’t add ${id} (see the app’s notification).`);
        return { data: { ok: true, added: objects.value.filter((o) => !before.has(o.id)).map((o) => objectBrief(o.id)) } };
      },
    },
  ];
}
