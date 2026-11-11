/**
 * Orca's handy models (2.5 MenuFactory::handy_models / load_handy_model) and
 * the tolerance test of the Calibration menu. These add to the current plate.
 */
import { activeView } from '../app/state';
import { confirmAction } from '../app/shell/uiState';
import { currentPresets } from '../presets/store';
import { toast } from '../ui';
import { calibAssetUrl } from './apply';

export interface HandyModel { id: string; label: string; files: string[]; arrange?: boolean; stringHell?: boolean }

export const HANDY_MODELS: HandyModel[] = [
  { id: 'orca-cube', label: 'Orca Cube', files: ['OrcaCube_v2.stl', 'OrcaPlug_v2.stl'], arrange: true },
  { id: 'orca-sliced', label: 'OrcaSliced Combo', files: ['OrcaSliced.3mf', 'OrcaCube_v2.stl', 'OrcaPlug_v2.stl'], arrange: true },
  { id: 'orca-badge', label: 'Orca Badge', files: ['OrcaBadge.3mf'] },
  { id: 'tolerance', label: 'Orca Tolerance Test', files: ['OrcaToleranceTest.stl'] },
  { id: 'benchy', label: '3DBenchy', files: ['3DBenchy.stl'] },
  { id: 'calicat', label: 'Cali Cat', files: ['calicat.stl'] },
  { id: 'fdm-test', label: 'Autodesk FDM Test', files: ['ksr_fdmtest_v4.stl'] },
  { id: 'voron-cube', label: 'Voron Cube', files: ['Voron_Design_Cube_v7.stl'] },
  { id: 'bunny', label: 'Stanford Bunny', files: ['Stanford_Bunny.stl'] },
  { id: 'string-hell', label: 'Orca String Hell', files: ['Orca_stringhell.stl'], stringHell: true },
];

/** Add a handy model to the current plate, like Orca's Add ▸ Handy models. */
export async function addHandyModel(id: string): Promise<boolean> {
  const m = HANDY_MODELS.find((h) => h.id === id);
  if (!m) return false;
  const { importBuffer } = await import('../app/shell/actions');
  const { runArrange } = await import('../app/shell/arrange');
  try {
    const added: string[] = [];
    for (const f of m.files) {
      const rsp = await fetch(calibAssetUrl(`handy/${f}`));
      if (!rsp.ok) throw new Error(`${f} is not available on this server (HTTP ${rsp.status}). Run scripts/stage-calib.mjs.`);
      added.push(...await importBuffer(f, await rsp.arrayBuffer()));
    }
    if (m.arrange && added.length) await runArrange('plate', { imported: added });
    activeView.value = 'prepare';
  } catch (e) {
    toast.error(`Couldn’t add ${m.label}.`, { detail: (e as Error)?.message ?? String(e) });
    return false;
  }
  // String Hell has embossed text on its top: Orca suggests a zero one-wall threshold.
  if (m.stringHell) {
    const p = currentPresets.value;
    const oneWall = String(p.value('process', 'only_one_wall_top') ?? '') === '1';
    const thr = parseFloat(String(p.value('process', 'min_width_top_surface') ?? '0'));
    if (oneWall && thr > 0) {
      const ok = await confirmAction({
        title: 'Suggestion',
        message: 'This model has text embossed on its top surface. For best results with “Only one wall on top surfaces”, set the one wall threshold (min_width_top_surface) to 0. Change it now?',
        confirmLabel: 'Change setting',
      });
      if (ok) p.setValue('process', 'min_width_top_surface', '0', 0);
    }
  }
  return true;
}

/** Calibration ▸ Orca Tolerance Test: the handy model, added to the current plate. */
export function addToleranceTest(): Promise<boolean> { return addHandyModel('tolerance'); }
