/**
 * OrcaSlicer settings layout: the generated Tab.cpp table plus small fixes
 * for constructs the extractor can't see (loop-built groups).
 */
import { orcaGenerated } from './orca.generated';
import { patchLayout } from './patch';
import type { EngineLayoutSource } from './types';

export const orcaLayout: EngineLayoutSource = patchLayout(orcaGenerated, [
  // TabPrinter::build_kinematics_page builds "Speed limitation" from a local
  // `speed_axes` vector declared before the group — move those keys there.
  {
    tab: 'machine', page: 'Motion ability', group: 'Speed limitation', before: 'Acceleration limitation',
    keys: ['machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e'],
  },
  { tab: 'machine', page: 'Motion ability', group: 'Advanced', keys: ['machine_min_extruding_rate', 'machine_min_travel_rate'] },
  { tab: 'filament', page: 'Setting Overrides', group: 'Retraction', keys: ['filament_retraction_length'], atStart: true },
  { tab: 'machine', page: 'Basic information', group: 'Advanced', keys: ['thumbnails_format'], after: 'thumbnails' },
]);
