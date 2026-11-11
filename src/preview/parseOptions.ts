/** G-code parser options from the resolved config (filament diameter, accelerations for the time estimate). */
import type { FlatConfig } from '../engine/types';
import type { ParseOptions } from './parser/types';
import { filamentVariantValue, toNumber, valueAt, variantColumn, variantSelector, variantValue } from '../lib/configValue';

export function parseOptionsFrom(cfg: FlatConfig): ParseOptions {
  const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : undefined);
  // Orca 2.5: process accelerations are per-variant vectors; read extruder 1's.
  const print = (k: string) => positive(toNumber(variantValue(cfg, k, 'print', 0)));
  // Machine limits come in normal / silent pairs per variant (stride 2): extruder 1's normal mode.
  const limitCol = Math.max(0, variantColumn(cfg, 'printer', variantSelector(cfg, 0), 2));
  const machine = (k: string) => positive(toNumber(valueAt(cfg[k], limitCol)));
  return {
    // Filament 1's value (its variant column when the filament has several).
    filamentDiameter: positive(toNumber(filamentVariantValue(cfg, 'filament_diameter', 0))),
    acceleration: print('default_acceleration') ?? machine('machine_max_acceleration_extruding'),
    travelAcceleration: print('travel_acceleration') ?? machine('machine_max_acceleration_travel'),
  };
}
