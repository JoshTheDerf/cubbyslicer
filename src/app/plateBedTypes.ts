/**
 * Plater::normalize_bed_types (Orca 2.5): only Bambu printers and printers
 * with `support_multi_bed_types` let a plate override the bed type. When the
 * selected printer stops allowing it, the plates' overrides are reset (and
 * the user told); the plate dialog greys its bed type out meanwhile.
 */
import { watch } from 'vue';
import { currentPresets } from '../presets/store';
import { platesMayOverrideBedType } from '../project/plates';
import { clearPlateBedTypes } from '../project/store';
import { toast } from '../ui';

/** The selected printer lets plates choose their own bed type. */
export function printerMayOverrideBedType(): boolean {
  const p = currentPresets.value;
  return platesMayOverrideBedType({ vendor: p.infos.value.printer.vendor, config: { support_multi_bed_types: p.value('printer', 'support_multi_bed_types') } });
}

/** Reset plate bed types whenever the printer (or its setting) switches to a single bed type. Returns the stop handle. */
export function watchPlateBedTypes(): () => void {
  return watch(printerMayOverrideBedType, (may, before) => {
    if (may || !before) return;
    if (clearPlateBedTypes()) toast.info('Plate bed types reset', { detail: 'The selected printer does not support multiple bed types. Bed type overrides were reset to the global bed type.' });
  });
}
