/**
 * Calibration menu (Orca's "Calibration" top menu) and the tool dialogs:
 * flushing volumes, filament grouping, object table, create printer /
 * filament, export preset bundle, bed shape and preferences.
 */
import type { Action } from '../types';
import { activeEngine } from '../../state';
import { calibUi, type CalibDialogId } from '../../../calibration/state';
import { openDialog } from '../../../dialogs/state';
import { filamentCount, isMultiNozzle } from '../../../dialogs/gates';
import { isOrcaFamily } from '../../../engine/types';

/** Orca's handy models (kept in sync with calibration/run.ts HANDY_MODELS; ids only here so the table stays pure). */
export const HANDY_MODEL_IDS: Array<[string, string]> = [
  ['orca-cube', 'Orca Cube'], ['orca-sliced', 'OrcaSliced Combo'], ['tolerance', 'Orca Tolerance Test'], ['benchy', '3DBenchy'],
  ['calicat', 'Cali Cat'], ['fdm-test', 'Autodesk FDM Test'], ['voron-cube', 'Voron Cube'], ['bunny', 'Stanford Bunny'], ['string-hell', 'Orca String Hell'],
];

const orca = () => isOrcaFamily(activeEngine.value);
const calib = (id: CalibDialogId) => () => { calibUi.open = id; };

export function calibrationActions(): Action[] {
  return [
    // ---- Calibration (Orca MainFrame calibration menu) ----
    { id: 'calib.temp', title: 'Temperature…', icon: 'i-lucide-thermometer', category: 'Calibration', aliases: ['temperature tower', 'temp tower', 'calibrate'],
      when: orca, run: calib('temp') },
    { id: 'calib.flow', title: 'Flow ratio…', icon: 'i-lucide-waves', category: 'Calibration', aliases: ['flow rate', 'extrusion multiplier', 'yolo', 'pass 1', 'pass 2'],
      when: orca, run: calib('flow') },
    { id: 'calib.pa', title: 'Pressure advance…', icon: 'i-lucide-gauge', category: 'Calibration', aliases: ['linear advance', 'pa tower', 'pa line', 'pa pattern', 'k factor'],
      when: orca, run: calib('pa') },
    { id: 'calib.retraction', title: 'Retraction…', icon: 'i-lucide-arrow-up-from-line', category: 'Calibration', aliases: ['retraction tower', 'stringing'],
      when: orca, run: calib('retraction') },
    { id: 'calib.volumetric', title: 'Max flowrate…', icon: 'i-lucide-chevrons-up', category: 'Calibration', aliases: ['max volumetric speed', 'volumetric speed tower', 'mvs'],
      when: orca, run: calib('volumetric') },
    { id: 'calib.vfa', title: 'VFA…', icon: 'i-lucide-audio-waveform', category: 'Calibration', aliases: ['vertical fine artifacts', 'speed tower'],
      when: orca, run: calib('vfa') },
    { id: 'calib.cornering', title: 'Cornering…', icon: 'i-lucide-corner-down-right', category: 'Calibration', aliases: ['jerk', 'junction deviation', 'square corner velocity'],
      when: orca, run: calib('cornering') },
    { id: 'calib.is-freq', title: 'Input shaping frequency…', icon: 'i-lucide-activity', category: 'Calibration', aliases: ['input shaper', 'resonance', 'ringing'],
      when: orca, run: calib('is_freq') },
    { id: 'calib.is-damp', title: 'Input shaping damping / zeta factor…', icon: 'i-lucide-activity', category: 'Calibration', aliases: ['input shaper', 'damping ratio', 'zeta'],
      when: orca, run: calib('is_damp') },
    { id: 'calib.tolerance', title: 'Orca tolerance test', icon: 'i-lucide-ruler', category: 'Calibration', aliases: ['tolerance', 'fit test', 'handy model'],
      run: async () => { await (await import('../../../calibration/run')).addToleranceTest(); } },
    ...HANDY_MODEL_IDS.map(([id, label]): Action => ({
      id: `handy.${id}`, title: label, icon: 'i-lucide-box', category: 'Add', aliases: ['handy model', 'test model', 'sample'],
      run: async () => { await (await import('../../../calibration/run')).addHandyModel(id); },
    })),
    { id: 'calib.guide', title: 'Calibration guide', icon: 'i-lucide-book-open', category: 'Calibration', aliases: ['wiki', 'help'],
      run: () => { window.open('https://www.orcaslicer.com/wiki/calibration_guide', '_blank', 'noopener'); } },

    // ---- Tool dialogs ----
    { id: 'filament.flushing', title: 'Flushing volumes…', icon: 'i-lucide-droplets', category: 'Settings', aliases: ['purge volumes', 'wipe tower', 'flush matrix', 'multi material'],
      when: () => filamentCount() > 1, run: () => openDialog('flushing') },
    { id: 'filament.grouping', title: 'Filament grouping…', icon: 'i-lucide-split', category: 'Settings', aliases: ['filament map', 'left nozzle', 'right nozzle', 'h2d', 'dual nozzle'],
      when: () => isMultiNozzle(), run: () => openDialog('filamentMap') },
    { id: 'object.table', title: 'Object table…', icon: 'i-lucide-table', category: 'Object', aliases: ['batch edit', 'object settings', 'spreadsheet'],
      when: (c) => c.objectCount > 0, run: () => openDialog('objectTable') },
    { id: 'presets.create-printer', title: 'Create printer…', icon: 'i-lucide-printer', category: 'Settings', aliases: ['custom printer', 'new printer', 'add printer'],
      run: () => openDialog('createPrinter') },
    { id: 'presets.create-filament', title: 'Create filament…', icon: 'i-lucide-disc', category: 'Settings', aliases: ['custom filament', 'new filament'],
      run: () => openDialog('createFilament') },
    { id: 'presets.export-bundle', title: 'Export preset bundle…', icon: 'i-lucide-package', category: 'Export', aliases: ['orca_printer', 'orca_filament', 'export presets', 'backup presets'],
      run: () => openDialog('exportBundle') },
    { id: 'printer.bed-shape', title: 'Bed shape…', icon: 'i-lucide-square-dashed', category: 'Settings', aliases: ['printable area', 'bed size', 'bed texture', 'bed model', 'origin'],
      run: () => openDialog('bedShape') },
    { id: 'app.preferences', title: 'Preferences…', icon: 'i-lucide-settings', category: 'Settings', aliases: ['options', 'units', 'camera', 'zoom', 'inches'],
      binding: { key: ',', ctrlOrMeta: true }, run: () => openDialog('preferences') },
  ];
}
