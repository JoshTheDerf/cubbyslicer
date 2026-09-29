/**
 * Slicer tools for the Claude Code bridge, grouped by area (./groups). Each
 * tool goes through the same store functions and commands the UI uses, so a
 * call behaves like the matching click, lands in undo history where the UI's
 * does, and shows the same prompts (printer uploads, print host changes,
 * deleting presets, replacing files, starting over).
 *
 * The cubby-mcp server exposes each tool as `slicer_<name>`.
 */
import type { BridgeTool } from '@cubby/shared/bridge';
import { coreTools } from './groups/core';
import { presetTools } from './groups/presets';
import { settingsTools } from './groups/settings';
import { objectTools } from './groups/objects';
import { plateTools } from './groups/plates';
import { paintTools } from './groups/paint';
import { layerTools } from './groups/layers';
import { modelToolTools } from './groups/modelTools';
import { calibrationTools } from './groups/calibration';
import { mixedTools } from './groups/mixed';
import { sliceTools } from './groups/slice';
import { fileTools } from './groups/files';
import { printHostTools } from './groups/printhost';

export function slicerTools(): BridgeTool[] {
  return [
    ...coreTools(),
    ...presetTools(),
    ...settingsTools(),
    ...objectTools(),
    ...plateTools(),
    ...paintTools(),
    ...layerTools(),
    ...modelToolTools(),
    ...calibrationTools(),
    ...mixedTools(),
    ...sliceTools(),
    ...fileTools(),
    ...printHostTools(),
  ];
}
