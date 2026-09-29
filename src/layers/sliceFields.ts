/**
 * Object → engine job fields for variable layer height and height range
 * modifiers (SliceObjectInput.layerHeightProfile / layerRanges). Pure.
 */
import type { ConfigValue, FlatConfig, SliceObjectInput } from '../engine/types';
import type { ProjectObject } from '../project/types';
import { fitProfileToHeight, slicingParams } from './profile';

function cfg(ov: Record<string, ConfigValue>): FlatConfig {
  return Object.fromEntries(Object.entries(ov).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
}

/**
 * `height` = the object's current printed height (mm). A profile made before
 * the object was rescaled is stretched to it (Orca would regenerate it).
 */
export function layerSliceFields(o: ProjectObject, height: number, config?: FlatConfig): Pick<SliceObjectInput, 'layerHeightProfile' | 'layerRanges'> {
  const out: Pick<SliceObjectInput, 'layerHeightProfile' | 'layerRanges'> = {};
  if (o.layerHeightProfile && o.layerHeightProfile.length >= 4) {
    // Orca only uses a profile whose last z is the object's height and whose first h is the
    // first layer height (else it silently slices uniform layers): stretch it to the height,
    // and follow a first layer height changed since the profile was made.
    const prof = fitProfileToHeight(o.layerHeightProfile, height);
    if (config) {
      const first = slicingParams(config, o.overrides, height).firstLayerHeight;
      const old = prof[1];
      if (Math.abs(old - first) > 1e-6) {
        prof[1] = first;
        if (prof.length > 4 && Math.abs(prof[2] - old) < 1e-4 && Math.abs(prof[3] - old) < 1e-6) { prof[2] = first; prof[3] = first; }
      }
    }
    out.layerHeightProfile = prof;
  }
  const ranges = (o.layerRanges ?? []).filter((r) => r.max > r.min + 1e-4);
  if (ranges.length) {
    out.layerRanges = ranges.slice().sort((a, b) => a.min - b.min || a.max - b.max)
      .map((r) => ({ min: r.min, max: r.max, config: cfg(r.overrides) }));
  }
  return out;
}
