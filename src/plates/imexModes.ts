/**
 * The IDEX/IQEX Modes grid of the printer settings (Orca 2.5
 * GUI/IMEXModesCtrl): one row per parallel mode (`imex_mode_names` /
 * `imex_mode_active_tools` / `imex_mode_gcodes`), the built-in Primary row
 * first and fixed, each row a tile per tool head whose role cycles
 * Inactive → Copy → Mirror → Span (Span only on a multi-gantry printer, on the
 * Primary's gantry) → Inactive. Pure model: the Vue editor renders it.
 */
import { IMEX_PRIMARY_MODE, imexPrimaryTool, parseImexActiveTools, type ImexRole } from './imex';

export interface ModeRow {
  primary: boolean;
  name: string;
  /** Every tool's role, including tools off the current grid (kept on save). Absent = Inactive. */
  roles: Map<number, ImexRole>;
  gcode: string;
  /** The name the row was loaded with (a plate set from the saved preset holds it). */
  origName: string;
}

export interface Grid { cols: number; rows: number; /** 0 front-left, 1 front-right, 2 rear-left, 3 rear-right (T0's corner). */ layout: number }

export const IMEX_LAYOUTS = ['front-left', 'front-right', 'rear-left', 'rear-right'];

/** kImexRoleTable order (the tiles cycle in it). */
const ROLE_ORDER: ImexRole[] = ['P', 'C', 'M', 'S'];

/** role_style: tile colour + legend label. */
export const ROLE_STYLE: Record<ImexRole | 'off', { bg: string; label: string }> = {
  off: { bg: 'rgb(90 90 90)', label: 'Inactive' },
  P: { bg: 'rgb(50 160 50)', label: 'Primary' },
  C: { bg: 'rgb(60 120 210)', label: 'Copy' },
  M: { bg: 'rgb(210 130 20)', label: 'Mirror' },
  S: { bg: 'rgb(180 180 40)', label: 'Span' },
};

/** role_hint */
export const ROLE_HINT: Record<ImexRole, string> = {
  P: 'Drives every sliced path. Always tool 0 — use Tool 0 Position above to choose which corner of the bed it occupies. It cannot be moved from the grid.',
  C: 'Follows the Primary at the firmware level, printing the same paths offset into its own zone.',
  M: 'Follows the Primary at the firmware level, printing the same paths reflected across the boundary between the two zones.',
  S: 'Marks a tool on the Primary’s gantry as its multicolor partner. Required to allow multi-color printing in paired-gantry modes.',
};

/** roles_for_mode: the string's roles with the mode's primary promoted. */
export function rolesForMode(activeTools: string): Map<number, ImexRole> {
  const roles = new Map<number, ImexRole>();
  for (const [i, r] of parseImexActiveTools(activeTools)) roles.set(i, r);
  const p = imexPrimaryTool(activeTools);
  if (p >= 0 && roles.has(p)) roles.set(p, 'P');
  return roles;
}

/** active_tools_string: "idx:R,…" in tool order. */
export function activeToolsString(roles: Map<number, ImexRole>): string {
  return [...roles.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => `${i}:${r}`).join(',');
}

/** load_from_config: Primary first (its saved entry, if any), then the other modes in order. */
export function loadRows(names: readonly string[], tools: readonly string[], gcodes: readonly string[]): ModeRow[] {
  const row = (name: string, t: string, g: string, primary: boolean): ModeRow => {
    const roles = rolesForMode(t);
    if (!roles.size) roles.set(0, 'P'); // default T0 → Primary when no assignment is stored
    return { primary, name: primary ? IMEX_PRIMARY_MODE : name, roles, gcode: g, origName: primary ? IMEX_PRIMARY_MODE : name };
  };
  const pi = names.indexOf(IMEX_PRIMARY_MODE);
  const out = [row(IMEX_PRIMARY_MODE, pi >= 0 ? tools[pi] ?? '' : '', pi >= 0 ? gcodes[pi] ?? '' : '', true)];
  names.forEach((n, i) => { if (i !== pi) out.push(row(n || uniqueModeName(out), tools[i] ?? '', gcodes[i] ?? '', false)); });
  return out;
}

/** get_mode_data: the three option lists, one entry per row. */
export function modeData(rows: readonly ModeRow[]): { names: string[]; tools: string[]; gcodes: string[] } {
  const names: string[] = [];
  for (const r of rows) names.push(r.primary ? IMEX_PRIMARY_MODE : r.name || uniqueModeName(rows, names));
  return { names, tools: rows.map((r) => activeToolsString(r.roles)), gcodes: rows.map((r) => r.gcode) };
}

/** unique_mode_name: "<base> 2", "<base> 3", … not used by any row (or `alsoTaken`). */
export function uniqueModeName(rows: readonly ModeRow[], alsoTaken: readonly string[] = [], base = 'mode'): string {
  for (let n = 2; ; n++) {
    const c = `${base} ${n}`;
    if (!alsoTaken.includes(c) && !rows.some((r) => !r.primary && r.name === c)) return c;
  }
}

/**
 * fix_row_name (on leaving the name field): an empty name, "primary" (any case) or one
 * another row uses is replaced ("copy 2" taken becomes "copy 3"). Returns the fixed name, or null when fine.
 */
export function fixRowName(rows: readonly ModeRow[], index: number): string | null {
  const r = rows[index];
  if (!r || r.primary) return null;
  const name = r.name;
  const reserved = name.toLowerCase() === IMEX_PRIMARY_MODE;
  const taken = rows.some((o, i) => i !== index && !o.primary && o.name === name);
  if (name && !reserved && !taken) return null;
  const others = rows.filter((_, i) => i !== index);
  let base = name;
  const m = /^(.*\S) (\d+)$/.exec(base);
  if (m) base = m[1];
  return !name || reserved ? uniqueModeName(others) : uniqueModeName(others, [], base);
}

/** The grid's tiles, top row (rear gantry) first, as desktop lays them out for the T0 corner. */
export function gridTiles(g: Grid): number[][] {
  const flipX = g.layout === 1 || g.layout === 3, flipY = g.layout === 2 || g.layout === 3;
  const out: number[][] = [];
  for (let row = g.rows - 1; row >= 0; row--) {
    const line: number[] = [];
    for (let col = 0; col < g.cols; col++) {
      const rr = flipY ? g.rows - 1 - row : row, rc = flipX ? g.cols - 1 - col : col;
      line.push(rr * g.cols + rc);
    }
    out.push(line);
  }
  return out;
}

/** role_offered: Span only on a printer with a second gantry. */
export function roleOffered(role: ImexRole, g: Grid): boolean { return role !== 'S' || g.rows >= 2; }

/**
 * next_tile_role: the role after `current` in kImexRoleTable order that this tile may take
 * (one Primary per mode; Span only on the Primary's gantry); past the end → Inactive (null).
 */
export function nextTileRole(row: ModeRow, tool: number, g: Grid): ImexRole | null {
  const current = row.roles.get(tool) ?? null;
  let primaryGantry = -1, otherPrimary = false;
  for (const [i, r] of row.roles) if (r === 'P') { primaryGantry = Math.floor(i / g.cols); if (i !== tool) otherPrimary = true; }
  const allowed = (r: ImexRole) => roleOffered(r, g) && (r === 'P' ? !otherPrimary : r === 'S' ? primaryGantry >= 0 && Math.floor(tool / g.cols) === primaryGantry : true);
  const start = current ? ROLE_ORDER.indexOf(current) + 1 : 0;
  for (let i = start; i < ROLE_ORDER.length; i++) if (allowed(ROLE_ORDER[i])) return ROLE_ORDER[i];
  return null;
}

/** suggested_mode_names: the conventional names this tool grid can express, minus the ones in use. */
export function suggestedModeNames(rows: readonly ModeRow[], g: Grid, skip = -1): string[] {
  const pool = ['copy', 'mirror'];
  if (g.cols * g.rows >= 4) pool.push('iq-copy', 'iq-mirror');
  if (g.cols >= 2 && g.rows >= 2) pool.push('mc-copy', 'mc-mirror');
  return pool.filter((c) => !rows.some((r, i) => i !== skip && !r.primary && r.name === c));
}

/** remove_row: the names plates may still hold for the removed row (its loaded and current names), minus names a surviving row carries. */
export function removedNames(rows: readonly ModeRow[], index: number): string[] {
  const r = rows[index];
  if (!r || r.primary) return [];
  const names = [...new Set([r.origName, r.name].filter(Boolean))];
  const rest = rows.filter((_, i) => i !== index);
  return names.filter((n) => !rest.some((o) => (o.primary ? n === IMEX_PRIMARY_MODE : o.name === n)));
}
