/** G-code parser options from the resolved config (filament diameter, accelerations for the time estimate). */
import type { FlatConfig } from '../engine/types';
import type { ParseOptions } from './parser/types';

export function parseOptionsFrom(cfg: FlatConfig): ParseOptions {
  const num = (k: string) => {
    const v = cfg[k];
    const s = Array.isArray(v) ? v[0] : v;
    const n = s === undefined ? NaN : parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    filamentDiameter: num('filament_diameter'),
    acceleration: num('default_acceleration') ?? num('machine_max_acceleration_extruding'),
    travelAcceleration: num('travel_acceleration') ?? num('machine_max_acceleration_travel'),
  };
}
