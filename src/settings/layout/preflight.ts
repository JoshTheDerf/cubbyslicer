/** preFlight settings layout: generated from preFlight's Tab.cpp (PrusaSlicer-style pages). */
import { preflightGenerated } from './preflight.generated';
import { patchLayout } from './patch';
import type { EngineLayoutSource } from './types';

export const preflightLayout: EngineLayoutSource = patchLayout(preflightGenerated, [
  { tab: 'machine', page: 'Extruder', group: '', rename: 'General' },
]);
