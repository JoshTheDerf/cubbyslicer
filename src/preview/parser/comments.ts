/**
 * Comment tags the preview reacts to, by dialect. The per-move hot tags
 * (`;WIDTH:`, `;HEIGHT:`, `;Z:`, `;WIPE_*`) have byte fast paths in parse.ts;
 * everything else arrives here as a trimmed string without the `;`.
 *
 * OrcaSlicer writes two dialects (`GCodeProcessor::Reserved_Tags` for Bambu
 * printers, `Reserved_Tags_compatible` for the rest):
 *   BBL:    `; FEATURE: Outer wall`, `; CHANGE_LAYER`, `; Z_HEIGHT: 0.2`, `; LAYER_HEIGHT: 0.2`, `; LINE_WIDTH: 0.42`
 *   others: `;TYPE:Outer wall`, `;LAYER_CHANGE`, `;Z:0.2`, `;HEIGHT:0.2`, `;WIDTH:0.42`
 * PrusaSlicer / preFlight use the second set; Cura `;LAYER:n` and `;TYPE:WALL-OUTER`.
 *
 * New in Orca 2.5 (`GCodeProcessor.cpp`, v2.4.2 → v2.5.0):
 *   - `; SKIPPABLE_START` / `; SKIPPABLE_END` / `; SKIPTYPE: <type>`: time-lapse and other
 *     skippable sections (time stamps only; nothing to draw).
 *   - `; MACHINE_START_GCODE_END` / `; MACHINE_END_GCODE_START`: bracket the printer's
 *     start / end G-code. After the end marker Orca drops dwells from the estimate
 *     (post-print filtration / cool-down), and so does this parser.
 *   - `; NOZZLE_CHANGE_START …` / `; NOZZLE_CHANGE_END …` / `; CP_TOOLCHANGE_WIPE …`: nozzle
 *     rack (H2C) usage blocks; payload only matters to Orca's nozzle time model.
 *   - `;Z:` is read for layer Z on belt printers too (it always was here).
 *   - `; belt_slice_rotation_angle = <deg>` outside the config block: the file was sliced
 *     for a belt printer, tilted by that angle (`GCodeProcessorResult::belt_tilt_angle`).
 *   - `;VT<n>[ H<nozzle>]`: the first filament ("virtual tool"), as `T<n>`; `M1020 S<n>` and
 *     `T<n> H<nozzle>` carry a nozzle id the preview ignores.
 * Feature role names did not change (`ExtrusionEntity::role_to_string`), see ./features.ts.
 */

export const Tag = {
  None: 0,
  /** Feature role; value = role name. */
  Role: 1,
  LayerChange: 2,
  /** Layer print Z; value = number. */
  LayerZ: 3,
  /** Layer height; value = number. */
  Height: 4,
  /** Line width; value = number. */
  Width: 5,
  /** `COLOR_CHANGE,T<e>,#rrggbb`; value = whole tag. */
  ColorChange: 6,
  WipeStart: 7,
  WipeEnd: 8,
  ConfigStart: 9,
  ConfigEnd: 10,
  MachineStartEnd: 11,
  MachineEndStart: 12,
  /** `;VT<n>`; value = the filament number. */
  VirtualTool: 13,
  /** A known tag with nothing for the preview to do. */
  Ignored: 14,
} as const;
export type TagId = (typeof Tag)[keyof typeof Tag];

/** Payload of the last matched tag (valid until the next `matchTag`). */
export let tagValue = '';

/** Tags with a payload, longest prefixes first where they overlap. */
const PREFIXED: ReadonlyArray<[string, TagId]> = [
  ['TYPE:', Tag.Role],
  ['FEATURE:', Tag.Role],
  ['LAYER:', Tag.LayerChange],
  ['Z_HEIGHT:', Tag.LayerZ],
  ['LAYER_HEIGHT:', Tag.Height],
  ['LINE_WIDTH:', Tag.Width],
  ['WIDTH:', Tag.Width],
  ['HEIGHT:', Tag.Height],
  ['COLOR_CHANGE', Tag.ColorChange],
  // Orca 2.5 payload tags (matched with starts_with in GCodeProcessor).
  ['SKIPTYPE:', Tag.Ignored],
  ['NOZZLE_CHANGE_START', Tag.Ignored],
  ['NOZZLE_CHANGE_END', Tag.Ignored],
  ['CP_TOOLCHANGE_WIPE', Tag.Ignored],
  ['PA_CHANGE:', Tag.Ignored],
  ['EXTERNAL_PURGE', Tag.Ignored],
  ['MANUAL_TOOL_CHANGE', Tag.Ignored],
  ['start printing object', Tag.Ignored],
  ['stop printing object', Tag.Ignored],
];

const WHOLE = new Map<string, TagId>([
  ['LAYER_CHANGE', Tag.LayerChange],
  ['CHANGE_LAYER', Tag.LayerChange],
  ['WIPE_START', Tag.WipeStart],
  ['WIPE_END', Tag.WipeEnd],
  ['CONFIG_BLOCK_START', Tag.ConfigStart],
  ['CONFIG_BLOCK_END', Tag.ConfigEnd],
  ['MACHINE_START_GCODE_END', Tag.MachineStartEnd],
  ['MACHINE_END_GCODE_START', Tag.MachineEndStart],
  ['SKIPPABLE_START', Tag.Ignored],
  ['SKIPPABLE_END', Tag.Ignored],
  ['WIPE_TOWER_START', Tag.Ignored],
  ['WIPE_TOWER_END', Tag.Ignored],
  ['FLUSH_START', Tag.Ignored],
  ['FLUSH_END', Tag.Ignored],
  ['VFLUSH_START', Tag.Ignored],
  ['VFLUSH_END', Tag.Ignored],
  ['PAUSE_PRINT', Tag.Ignored],
  ['PAUSE_PRINTING', Tag.Ignored],
  ['CUSTOM_GCODE', Tag.Ignored],
  ['HEADER_BLOCK_START', Tag.Ignored],
  ['HEADER_BLOCK_END', Tag.Ignored],
  ['EXECUTABLE_BLOCK_START', Tag.Ignored],
  ['EXECUTABLE_BLOCK_END', Tag.Ignored],
]);

/** Classify a trimmed comment (no leading `;`). Sets `tagValue` for payload tags. */
export function matchTag(s: string): TagId {
  const whole = WHOLE.get(s);
  if (whole !== undefined) { tagValue = ''; return whole; }
  for (const [prefix, id] of PREFIXED) {
    if (s.startsWith(prefix)) {
      tagValue = id === Tag.ColorChange ? s : s.slice(prefix.length).trim();
      return id;
    }
  }
  // ;VT<n>[ H<nozzle>]
  if (s.charCodeAt(0) === 86 /* V */ && s.charCodeAt(1) === 84 /* T */) {
    const m = /^VT(\d+)/.exec(s);
    if (m) { tagValue = m[1]; return Tag.VirtualTool; }
  }
  tagValue = '';
  return Tag.None;
}
