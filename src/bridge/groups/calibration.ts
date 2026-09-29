/**
 * Bridge tools: the Calibration menu (Orca calib_dlg + Plater::calib_*) and
 * the handy test models. Parameters default like the dialogs and are checked
 * by the same form builders. A calibration starts a new project: when the
 * plate has objects the app asks the user first, exactly like the menu.
 */
import { argNumber, argString, type BridgeTool } from '@cubby/shared/bridge';
import { activeEngine, resolvedConfig } from '../../app/state';
import { isOrcaFamily, type CalibParams } from '../../engine/types';
import { currentPresets, presetsSettled } from '../../presets/store';
import { asArray } from '../../presets/values';
import {
  corneringDefaults, corneringParams, paDefaults, paParams, rangeDefaults, rangeParams, SHAPING_DAMP_DEFAULTS, SHAPING_FREQ_DEFAULTS, shaperTypesFor,
  shapingDampParams, shapingFreqParams, tempFilamentOf, tempParams, tempRangeFor, type PAMethod,
} from '../../calibration/forms';
import { activeCalib } from '../../calibration/state';
import { objects } from '../../project/store';
import { oneOf } from '../logic';
import { bool, num, obj, objectBrief, oneOfS, str } from './util';

const TESTS = ['temp', 'flow', 'pa', 'retraction', 'volumetric', 'vfa', 'is_freq', 'is_damp', 'cornering', 'tolerance'] as const;
const HANDY = ['orca-cube', 'orca-sliced', 'tolerance', 'benchy', 'calicat', 'fdm-test', 'voron-cube', 'bunny', 'string-hell'] as const;
const FLOW = ['yolo', 'yolo_perfectionist', 'pass1', 'pass2'] as const;

export function calibrationTools(): BridgeTool[] {
  return [
    {
      name: 'calibrate',
      description:
        'Set up a calibration print from the Calibration menu (OrcaSlicer / Full Spectrum engines). It replaces the project: with objects on the plate the user confirms in the browser. Then slice. ' +
        'test: temp (start / end °C, default from the filament type), flow (type yolo | yolo_perfectionist | pass1 | pass2, pattern archimedeanchords | monotonic), ' +
        'pa (method pa_tower | pa_line | pa_pattern, bowden, start / end / step, printNumbers, accels / speeds comma lists for pa_pattern), ' +
        'retraction (mm), volumetric (mm³/s), vfa (mm/s) (start / end / step), is_freq (startX / endX / startY / endY Hz, damp, shaper, model 0 ringing | 1 fast), ' +
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
        shaper: str('Input shaper type (depends on the firmware; the error lists them).'), model: num('Test model 0 / 1 (cornering 0-2).'),
      }, ['test']),
      async run(args) {
        const test = oneOf(args.test, TESTS, 'test');
        await presetsSettled();
        const run = await import('../../calibration/run');
        if (test !== 'tolerance' && !isOrcaFamily(activeEngine.value)) throw new Error('Calibration prints need the OrcaSlicer or Full Spectrum engine (set_engine).');
        const n = (k: string, d: number) => argNumber(args, k, { optional: true }) ?? d;
        const facts = run.calibPrinterFacts();
        const shaperOf = () => {
          const list = shaperTypesFor(facts.flavor);
          return args.shaper === undefined ? list[0] : oneOf(args.shaper, list, 'shaper');
        };
        let params: CalibParams | string | null = null;
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
              const type = asArray(currentPresets.value.value('filament', 'filament_type', 0))[0] ?? asArray(cfg.filament_type)[0] ?? 'PLA';
              const d = tempRangeFor(tempFilamentOf(type));
              params = tempParams(n('start', d.start), n('end', d.end)); runner = run.calibTemp;
            } else if (test === 'pa') {
              const method = (args.method === undefined ? 'pa_tower' : oneOf(args.method, ['pa_tower', 'pa_line', 'pa_pattern'] as const, 'method')) as PAMethod;
              const bowden = typeof args.bowden === 'boolean' ? args.bowden : asArray(cfg.extruder_type)[0] === 'Bowden';
              const d = paDefaults(method, bowden);
              params = paParams({
                method, bowden, start: n('start', d.start), end: n('end', d.end), step: n('step', d.step),
                printNumbers: typeof args.printNumbers === 'boolean' ? args.printNumbers : d.printNumbers,
                accels: argString(args, 'accels', { optional: true }) ?? '', speeds: argString(args, 'speeds', { optional: true }) ?? '',
              });
              runner = run.calibPA;
            } else if (test === 'retraction' || test === 'volumetric' || test === 'vfa') {
              const mode = test === 'retraction' ? 'retraction_tower' : test === 'volumetric' ? 'vol_speed_tower' : 'vfa_tower';
              const d = rangeDefaults(mode);
              params = rangeParams(mode, n('start', d.start), n('end', d.end), n('step', d.step));
              runner = test === 'retraction' ? run.calibRetraction : test === 'volumetric' ? run.calibMaxVolSpeed : run.calibVFA;
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
