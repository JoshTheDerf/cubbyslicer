/**
 * Orca 2.5 IDEX/IQEX ("iXex") parallel printing: modes, bed zones, ghost and
 * carriage transforms. Pure (no Vue / three / store). Ports of
 * libslic3r/IMEXHelpers.cpp (`parse_imex_active_tools`,
 * `imex_primary_tool_for_mode`, `group_imex_active_tools_by_gantry`,
 * `imex_mode_kind`, `imex_plate_mode_choices`, `imex_head_transform`,
 * `imex_mirror_axis_for`), libslic3r/IMEXZones.cpp
 * (`compute_imex_zone_layout`), PartPlate::calc_imex_ghosts and
 * GCodeViewer::resolve_imex_marker_plan.
 *
 * The printer describes the hardware (`is_imex`, `imex_gantry_count`,
 * `imex_tools_per_gantry`, `imex_tool_layout`, clearances) and its modes
 * (`imex_mode_names` / `imex_mode_active_tools` "0:P,1:C,2:M,3:S" /
 * `imex_mode_gcodes`). Each plate picks a mode (`imex_parallel_mode` in the
 * plate config, absent = "primary"; the process preset's value is the
 * fallback). The engine slices T0's zone once; the other carriages copy or
 * mirror it.
 */
import type { ConfigValue, FlatConfig } from '../engine/types';
import { SCALAR, asList, cfgBool, cfgNumber, cfgString } from '../lib/configValue';

export const IMEX_PRIMARY_MODE = 'primary';

export type ImexRole = 'P' | 'C' | 'M' | 'S';
export type ImexModeKind = 'primary' | 'copy' | 'mirror' | 'custom';

/** XY rectangle, plate-local mm. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface ImexMode { index: number; name: string; activeTools: string; gcode: string }

export interface ImexZoneLayout {
  /** Physical T-index of the mode's Primary tool (-1 = no layout). */
  primaryHead: number;
  /** Head → its zone centre (Span heads have none; see Orca's note on aggregated X). */
  headZoneCenters: Map<number, [number, number]>;
  /** Where parts go (T0's zone). null = no zones on this plate. */
  primaryZone: Rect | null;
  copyZones: Rect[];
  mirrorZones: Rect[];
  /** Blocking carriage collision strips inside the primary zone. */
  collisionZones: Rect[];
  /** Advisory bands inside the strips (imex_carriage_margin > 0). */
  marginBands: Rect[];
}

const EMPTY = (): ImexZoneLayout => ({ primaryHead: -1, headZoneCenters: new Map(), primaryZone: null, copyZones: [], mirrorZones: [], collisionZones: [], marginBands: [] });

// ---- config ---------------------------------------------------------------------------

export function isImexPrinter(cfg: FlatConfig): boolean { return cfgBool(cfg, 'is_imex', SCALAR, false); }

interface Grid { cols: number; rows: number; flipX: boolean; flipY: boolean }

function grid(cfg: FlatConfig): Grid {
  const layout = cfgString(cfg, 'imex_tool_layout', SCALAR, 'front-left');
  return {
    cols: Math.max(1, Math.round(cfgNumber(cfg, 'imex_tools_per_gantry', SCALAR, 2)) || 1),
    rows: Math.max(1, Math.round(cfgNumber(cfg, 'imex_gantry_count', SCALAR, 1)) || 1),
    flipX: layout === 'front-right' || layout === 'rear-right',
    flipY: layout === 'rear-left' || layout === 'rear-right',
  };
}

/** The printer's mode table (Orca imex_mode_table), rows padded where a sibling list is short. */
export function imexModeTable(cfg: FlatConfig): ImexMode[] {
  const names = asList(cfg.imex_mode_names), tools = asList(cfg.imex_mode_active_tools), gcodes = asList(cfg.imex_mode_gcodes);
  return names.map((name, index) => ({ index, name, activeTools: tools[index] ?? '', gcode: gcodes[index] ?? '' }));
}

export function findImexMode(cfg: FlatConfig, name: string): ImexMode | null {
  return imexModeTable(cfg).find((m) => m.name === name) ?? null;
}

/** The modes a plate can be set to, in the order its mode button cycles them (Orca imex_plate_mode_choices). */
export function imexPlateModeChoices(cfg: FlatConfig): string[] {
  const out = [IMEX_PRIMARY_MODE];
  for (const m of imexModeTable(cfg)) if (m.name && !out.includes(m.name)) out.push(m.name);
  return out;
}

const modeString = (v: ConfigValue | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** A plate's own mode ("primary" when unset). */
export function plateImexMode(plateCfg: Readonly<Record<string, ConfigValue>> | undefined): string {
  return modeString(plateCfg?.imex_parallel_mode) || IMEX_PRIMARY_MODE;
}

/** The mode a plate prints in: its own, else the process preset's (PartPlate::get_effective_imex_mode). '' when the printer isn't IDEX/IQEX. */
export function effectiveImexMode(cfg: FlatConfig, plateCfg: Readonly<Record<string, ConfigValue>> | undefined): string {
  if (!isImexPrinter(cfg)) return '';
  const own = plateImexMode(plateCfg);
  if (own !== IMEX_PRIMARY_MODE) return own;
  return modeString(cfg.imex_parallel_mode) || IMEX_PRIMARY_MODE;
}

/** A plate's `imex_head_filament_map` ("phys:slot,…", slots 1-based) → head → slot. */
export function parseImexHeadFilamentMap(s: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const tok of s.split(',')) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(tok);
    if (m && Number(m[2]) >= 1) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

/**
 * effective_physical_extruder_map: filament slot (0-based) → physical head. The printer's
 * `physical_extruder_map` when it has one entry per nozzle, else identity.
 */
export function effectivePhysicalExtruderMap(cfg: FlatConfig): number[] {
  const nozzles = Math.max(1, asList(cfg.nozzle_diameter).length);
  const explicit = asList(cfg.physical_extruder_map).map((v) => parseInt(v, 10));
  if (explicit.length === nozzles && explicit.every(Number.isFinite)) return explicit;
  return Array.from({ length: nozzles }, (_, i) => i);
}

/** first_filament_for_physical_head: the first slot (0-based) routed to `head`, -1 none. */
export function firstFilamentForHead(pem: readonly number[], head: number): number {
  if (!pem.length) return head === 0 ? 0 : -1;
  return pem.indexOf(head);
}

/** The slots (0-based) routed to a head (the picker's lanes). */
export function headLanes(pem: readonly number[], head: number): number[] {
  return pem.flatMap((p, i) => (p === head ? [i] : []));
}

/** resolve_filament_for_head: the plate's override when it names a routable slot, else the head's first slot (0-based, -1 none). */
export function resolveFilamentForHead(plateMap: ReadonlyMap<number, number>, pem: readonly number[], head: number): number {
  const own = plateMap.get(head);
  if (own !== undefined && own - 1 >= 0 && own - 1 < pem.length) return own - 1;
  return firstFilamentForHead(pem, head);
}

/**
 * The filament slot (1-based, 0 = none) a carriage prints with: the plate's
 * override, else the first filament routed to that head (`pem`, default identity:
 * filament N on head N−1). Slots past the project's filaments count as none.
 */
export function imexHeadFilament(head: number, plateCfg: Readonly<Record<string, ConfigValue>> | undefined, filamentCount: number,
                                 pem: readonly number[] = Array.from({ length: Math.max(1, filamentCount) }, (_, i) => i)): number {
  const slot = resolveFilamentForHead(parseImexHeadFilamentMap(modeString(plateCfg?.imex_head_filament_map)), pem, head);
  return slot >= 0 && slot < filamentCount ? slot + 1 : 0;
}

/** set_imex_head_filament_map's string ("phys:slot,…", heads ascending; '' = no overrides). */
export function formatImexHeadFilamentMap(m: ReadonlyMap<number, number>): string {
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([h, s]) => `${h}:${s}`).join(',');
}

// ---- active tools ----------------------------------------------------------------------

/** "0:P,1:C,2:M" → [[0,'P'],[1,'C'],[2,'M']]. A bare index is Copy here (see imexPrimaryTool); unknown suffixes are Copy. */
export function parseImexActiveTools(s: string): Array<[number, ImexRole]> {
  const out: Array<[number, ImexRole]> = [];
  for (const raw of s.split(',')) {
    const tok = raw.replace(/\s+/g, '');
    if (!tok) continue;
    const k = tok.indexOf(':');
    const idx = parseInt(k < 0 ? tok : tok.slice(0, k), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= 64) continue;
    const suf = k < 0 ? '' : tok.slice(k + 1);
    out.push([idx, suf === 'P' || suf === 'M' || suf === 'S' ? suf : 'C']);
  }
  return out;
}

/** The Primary tool: the first `:P` token, else the first bare index (legacy), else -1. */
export function imexPrimaryTool(s: string): number {
  let firstBare = -1;
  for (const raw of s.split(',')) {
    const tok = raw.replace(/\s+/g, '');
    if (!tok) continue;
    const k = tok.indexOf(':');
    const idx = parseInt(k < 0 ? tok : tok.slice(0, k), 10);
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (k < 0) { if (firstBare < 0) firstBare = idx; continue; }
    if (tok.slice(k + 1) === 'P') return idx;
  }
  return firstBare;
}

/** What a mode does, as the plate's mode icon shows it. */
export function imexModeKind(activeTools: string): ImexModeKind {
  const primary = imexPrimaryTool(activeTools);
  const roles = new Set<ImexRole>();
  for (const [i, r] of parseImexActiveTools(activeTools)) if (i !== primary && r !== 'P') roles.add(r);
  if (!roles.size) return 'primary';
  if (roles.has('S')) return 'custom';
  return roles.has('M') ? 'mirror' : 'copy';
}

interface GantryGroup { gantry: number; tools: Array<[number, ImexRole]>; rep: number; repRole: ImexRole; aggregate: boolean }

/** Orca group_imex_active_tools_by_gantry. */
function groupByGantry(activeTools: string, tpg0: number): { primaryGantry: number; groups: GantryGroup[] } {
  const tpg = Math.max(1, tpg0);
  const primary = imexPrimaryTool(activeTools);
  if (primary < 0) return { primaryGantry: -1, groups: [] };
  const primaryGantry = Math.floor(primary / tpg), primaryCol = primary % tpg;
  const byGantry = new Map<number, Array<[number, ImexRole]>>();
  let span = false;
  for (const t of parseImexActiveTools(activeTools)) {
    const g = Math.floor(t[0] / tpg);
    if (!byGantry.has(g)) byGantry.set(g, []);
    byGantry.get(g)!.push(t);
    if (g === primaryGantry && t[1] === 'S') span = true;
  }
  const groups = [...byGantry.keys()].sort((a, b) => a - b).map((g): GantryGroup => {
    const tools = byGantry.get(g)!;
    const pick = tools.find((t) => t[0] === g * tpg + primaryCol) ?? tools.reduce((a, b) => (b[0] < a[0] ? b : a));
    const sameRole = tools.every((t) => t[1] === pick[1]);
    return { gantry: g, tools, rep: pick[0], repRole: pick[1], aggregate: span && g !== primaryGantry && tools.length >= 2 && sameRole };
  });
  return { primaryGantry, groups };
}

// ---- zones -------------------------------------------------------------------------------

/**
 * Orca compute_imex_zone_layout: the zones of one plate. `bed` is the plate's
 * XY extents (plate-local). Empty (primaryZone null) when the printer isn't
 * IDEX/IQEX, the mode is Primary / unknown / toolless, or the grid is 1×1.
 */
export function computeImexZoneLayout(cfg: FlatConfig, mode: string, bed: { min: [number, number]; max: [number, number] }): ImexZoneLayout {
  const out = EMPTY();
  if (!isImexPrinter(cfg) || !mode || mode === IMEX_PRIMARY_MODE) return out;
  const g = grid(cfg);
  if (g.cols === 1 && g.rows === 1) return out;
  const phys = (idx: number): [number, number] => {
    const c = idx % g.cols, r = Math.floor(idx / g.cols);
    return [g.flipX ? g.cols - 1 - c : c, g.flipY ? g.rows - 1 - r : r];
  };
  const tools = findImexMode(cfg, mode)?.activeTools ?? '';
  const n = g.rows * g.cols;
  const roles = new Map<number, ImexRole>();
  const primary = imexPrimaryTool(tools);
  if (primary >= 0 && primary < n) roles.set(primary, 'P');
  for (const [i, r] of parseImexActiveTools(tools)) {
    if (i < 0 || i >= n || i === primary) continue;
    if (r === 'C' || r === 'M') roles.set(i, r);
  }
  if (!roles.size || !roles.has(primary)) return out;
  out.primaryHead = primary;
  const [priCol, priRow] = phys(primary);

  const grouping = groupByGantry(tools, g.cols);
  const groupOf = new Map(grouping.groups.map((x) => [x.gantry, x]));
  const key = (c: number, r: number) => `${c},${r}`;
  const copyCells = new Map<string, [number, number]>(), mirrorCells = new Map<string, [number, number]>();
  for (const [idx, role] of roles) {
    if (role === 'P') continue;
    const grp = groupOf.get(Math.floor(idx / g.cols));
    let cell: [number, number];
    if (grp?.aggregate) {
      if (idx !== grp.rep) continue;
      cell = [priCol, phys(idx)[1]]; // pinned to the primary's column
    } else cell = phys(idx);
    (role === 'C' ? copyCells : mirrorCells).set(key(...cell), cell);
  }
  const secondary = [...copyCells.values(), ...mirrorCells.values()];

  const { min: [xMin, yMin], max: [xMax, yMax] } = bed;
  const activeCols = [...new Set([...roles.keys()].map((i) => phys(i)[0]))].sort((a, b) => a - b);
  const activeRows = [...new Set([...roles.keys()].map((i) => phys(i)[1]))].sort((a, b) => a - b);
  const colZone = new Map(activeCols.map((c, k) => [c, k])), rowZone = new Map(activeRows.map((r, k) => [r, k]));
  const ck = (c: number) => colZone.get(c) ?? 0, rk = (r: number) => rowZone.get(r) ?? 0;
  const zw = (xMax - xMin) / Math.max(1, activeCols.length), zh = (yMax - yMin) / Math.max(1, activeRows.length);
  const priK = [ck(priCol), rk(priRow)];

  for (const idx of roles.keys()) {
    const [c, r] = phys(idx);
    out.headZoneCenters.set(idx, [xMin + (ck(c) + 0.5) * zw, yMin + (rk(r) + 0.5) * zh]);
  }
  const rowSep = secondary.some(([, r]) => r !== priRow), colSep = secondary.some(([c]) => c !== priCol);
  const boxes = (cells: Iterable<[number, number]>): Rect[] => {
    const list = [...cells];
    if (rowSep && !colSep) {
      return [...new Set(list.map(([, r]) => r))].sort((a, b) => a - b).map((r) => ({ x0: xMin, y0: yMin + rk(r) * zh, x1: xMax, y1: yMin + (rk(r) + 1) * zh }));
    }
    if (colSep && !rowSep) {
      return [...new Set(list.map(([c]) => c))].sort((a, b) => a - b).map((c) => ({ x0: xMin + ck(c) * zw, y0: yMin, x1: xMin + (ck(c) + 1) * zw, y1: yMax }));
    }
    return list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([c, r]) => ({ x0: xMin + ck(c) * zw, y0: yMin + rk(r) * zh, x1: xMin + (ck(c) + 1) * zw, y1: yMin + (rk(r) + 1) * zh }));
  };
  out.copyZones = boxes(copyCells.values());
  out.mirrorZones = boxes(mirrorCells.values());

  const pz: Rect = {
    x0: colSep ? xMin + priK[0] * zw : xMin, x1: colSep ? xMin + (priK[0] + 1) * zw : xMax,
    y0: rowSep ? yMin + priK[1] * zh : yMin, y1: rowSep ? yMin + (priK[1] + 1) * zh : yMax,
  };
  out.primaryZone = pz;

  const cw = cfgNumber(cfg, 'imex_nozzle_clearance_x', SCALAR, 30) || 0;
  const ch = cfgNumber(cfg, 'imex_nozzle_clearance_y', SCALAR, 30) || 0;
  const margin = cfgNumber(cfg, 'imex_carriage_margin', SCALAR, 0) || 0;
  let right = false, left = false, top = false, bottom = false;
  for (const [sc, sr] of mirrorCells.values()) {
    const zc = colZone.get(sc), zr = rowZone.get(sr);
    if (zc === undefined || zr === undefined) continue;
    if (zr === priK[1] && zc === priK[0] + 1) right = true;
    if (zr === priK[1] && zc === priK[0] - 1) left = true;
    if (zr === priK[1] + 1 && sc === priCol) top = true;
    if (zr === priK[1] - 1 && sc === priCol) bottom = true;
  }
  const strip = (r: Rect) => out.collisionZones.push(r);
  const band = (r: Rect) => { if (margin > 0) out.marginBands.push(r); };
  if (cw > 0) {
    if (right) { const b = xMin + (priK[0] + 1) * zw, i = b - cw; strip({ x0: i, x1: b, y0: pz.y0, y1: pz.y1 }); band({ x0: i - margin, x1: i, y0: pz.y0, y1: pz.y1 }); }
    if (left) { const b = xMin + priK[0] * zw, i = b + cw; strip({ x0: b, x1: i, y0: pz.y0, y1: pz.y1 }); band({ x0: i, x1: i + margin, y0: pz.y0, y1: pz.y1 }); }
  }
  if (ch > 0) {
    if (top) { const b = yMin + (priK[1] + 1) * zh, i = b - ch; strip({ x0: pz.x0, x1: pz.x1, y0: i, y1: b }); band({ x0: pz.x0, x1: pz.x1, y0: i - margin, y1: i }); }
    if (bottom) { const b = yMin + priK[1] * zh, i = b + ch; strip({ x0: pz.x0, x1: pz.x1, y0: b, y1: i }); band({ x0: pz.x0, x1: pz.x1, y0: i, y1: i + margin }); }
  }
  return out;
}

// ---- ghosts / carriages ------------------------------------------------------------------

/** 2D affine map of a head: p' = (sx·x + tx, sy·y + ty). sx / sy = −1 mirror that axis. */
export interface HeadTransform { head: number; role: 'C' | 'M'; sx: 1 | -1; sy: 1 | -1; tx: number; ty: number }

/**
 * Where every other carriage prints what T0 prints (PartPlate::calc_imex_ghosts
 * with imex_head_transform): one transform per Copy / Mirror head, skipping
 * Span heads and non-representatives of aggregated gantries. Empty with
 * `imex_firmware_managed_zones` (the firmware places the copies).
 */
export function imexHeadTransforms(cfg: FlatConfig, mode: string, layout: ImexZoneLayout, bed: { min: [number, number]; max: [number, number] }): HeadTransform[] {
  if (layout.primaryHead < 0 || cfgBool(cfg, 'imex_firmware_managed_zones', SCALAR, false)) return [];
  const tools = findImexMode(cfg, mode)?.activeTools ?? '';
  const tpg = grid(cfg).cols;
  const grouping = groupByGantry(tools, tpg);
  const groupOf = (h: number) => grouping.groups.find((x) => x.gantry === Math.floor(h / tpg));
  const p = layout.primaryHead;
  const center = (h: number) => layout.headZoneCenters.get(h) ?? [0, 0];
  const bedCx = (bed.min[0] + bed.max[0]) / 2;
  const out: HeadTransform[] = [];
  for (const [h, role] of parseImexActiveTools(tools)) {
    if (h === p || role === 'S' || role === 'P' || h >= 16) continue;
    const grp = groupOf(h);
    if (grp?.aggregate && h !== grp.rep) continue;
    let pc = center(p), tc = center(h);
    if (grp?.aggregate) { pc = [bedCx, pc[1]]; tc = [bedCx, tc[1]]; }
    const off: [number, number] = [tc[0] - pc[0], tc[1] - pc[1]];
    if (role === 'C') { out.push({ head: h, role, sx: 1, sy: 1, tx: off[0], ty: off[1] }); continue; }
    if (off[0] * off[0] + off[1] * off[1] < 1e-12) continue;
    const sameGantry = Math.floor(h / tpg) === Math.floor(p / tpg);
    out.push(sameGantry
      ? { head: h, role, sx: -1, sy: 1, tx: 2 * pc[0] + off[0], ty: off[1] }
      : { head: h, role, sx: 1, sy: -1, tx: off[0], ty: 2 * pc[1] + off[1] });
  }
  return out;
}

export interface CarriageBox { head: number; sx: 1 | -1; sy: 1 | -1; tx: number; ty: number; boxX: number; boxY: number }

/**
 * The preview's carriages (GCodeViewer::resolve_imex_marker_plan): the primary
 * (identity) and each Copy / Mirror head, with the side of the toolhead box
 * (`boxX` / `boxY` are the box's min-corner offsets from the nozzle; the box is
 * imex_nozzle_clearance_x × _y).
 */
export function imexCarriages(cfg: FlatConfig, mode: string, layout: ImexZoneLayout, bed: { min: [number, number]; max: [number, number] }): { size: [number, number]; carriages: CarriageBox[] } | null {
  if (layout.primaryHead < 0 || cfgBool(cfg, 'imex_firmware_managed_zones', SCALAR, false)) return null;
  const heads = imexHeadTransforms(cfg, mode, layout, bed);
  if (!heads.length) return null;
  const wx = cfgNumber(cfg, 'imex_nozzle_clearance_x', SCALAR, 30) || 0, wy = cfgNumber(cfg, 'imex_nozzle_clearance_y', SCALAR, 30) || 0;
  const centers = [...layout.headZoneCenters.values()];
  const zone0 = centers.length ? [Math.min(...centers.map((c) => c[0])), Math.min(...centers.map((c) => c[1]))] : [(bed.min[0] + bed.max[0]) / 2, (bed.min[1] + bed.max[1]) / 2];
  const pc = layout.headZoneCenters.get(layout.primaryHead) ?? zone0;
  // A carriage's centre: where the primary's zone centre lands under its transform.
  const secCenter = (t: HeadTransform): [number, number] => [t.sx * pc[0] + t.tx, t.sy * pc[1] + t.ty];
  let pbx = pc[0] <= zone0[0] ? 0 : -wx, pby = -wy;
  for (const t of heads) {
    const sc = secCenter(t);
    if (sc[0] > pc[0] + 1e-6) pbx = 0; else if (sc[0] < pc[0] - 1e-6) pbx = -wx;
    if (sc[1] > pc[1] + 1e-6) pby = 0; else if (sc[1] < pc[1] - 1e-6) pby = -wy;
  }
  const carriages: CarriageBox[] = [{ head: layout.primaryHead, sx: 1, sy: 1, tx: 0, ty: 0, boxX: pbx, boxY: pby }];
  for (const t of heads) {
    const sc = secCenter(t);
    const mirrorX = t.sx < 0;
    const boxX = mirrorX ? (sc[0] > pc[0] + 1e-6 ? -wx : sc[0] < pc[0] - 1e-6 ? 0 : pbx) : pbx;
    const boxY = sc[1] > pc[1] + 1e-6 ? -wy : sc[1] < pc[1] - 1e-6 ? 0 : pby;
    carriages.push({ head: t.head, sx: t.sx, sy: t.sy, tx: t.tx, ty: t.ty, boxX, boxY });
  }
  return { size: [wx, wy], carriages };
}

// ---- placement check -----------------------------------------------------------------

const overlaps = (r: Rect, min: readonly number[], max: readonly number[]) =>
  min[0] < r.x1 && max[0] > r.x0 && min[1] < r.y1 && max[1] > r.y0;

/** Does a footprint polygon overlap a rectangle (SAT on the rectangle's axes and the polygon's edges)? */
function hullMeetsRect(hull: ReadonlyArray<readonly [number, number]>, r: Rect): boolean {
  if (!hull.length) return false;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [x, y] of hull) { if (x < mnx) mnx = x; if (y < mny) mny = y; if (x > mxx) mxx = x; if (y > mxy) mxy = y; }
  if (!overlaps(r, [mnx, mny], [mxx, mxy])) return false;
  const corners: Array<[number, number]> = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const nx = hull[i][1] - hull[j][1], ny = hull[j][0] - hull[i][0];
    if (!nx && !ny) continue;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of hull) { const d = x * nx + y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const [x, y] of corners) { const d = x * nx + y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false;
  }
  return true;
}

/**
 * Orca PartPlate::check_outside's IMEX part: a footprint (plate-local) that
 * reaches into another carriage's zone or a collision strip can't print.
 */
export function imexZoneViolation(layout: ImexZoneLayout, hull: ReadonlyArray<readonly [number, number]>): boolean {
  if (!layout.primaryZone) return false;
  return [...layout.copyZones, ...layout.mirrorZones, ...layout.collisionZones].some((r) => hullMeetsRect(hull, r));
}

// ---- palette (PartPlate::render_imex_zones) ------------------------------------------------

export interface ImexTheme { copy: [string, number]; mirror: [string, number]; danger: [string, number]; margin: [string, number] }

const THEMES: Record<string, ImexTheme> = {
  standard: { copy: ['#56b4e9', 0.22], mirror: ['#e69f00', 0.22], danger: ['#d91a1a', 0.4], margin: ['#4ce633', 0.2] },
  deuteranopia: { copy: ['#0072b2', 0.5], mirror: ['#f0e442', 0.5], danger: ['#331acc', 0.65], margin: ['#cc79a7', 0.45] },
  tritanopia: { copy: ['#d55e00', 0.5], mirror: ['#cc79a7', 0.5], danger: ['#d91a1a', 0.55], margin: ['#00b399', 0.45] },
  high_contrast: { copy: ['#0099ff', 0.65], mirror: ['#ff9900', 0.65], danger: ['#ff0000', 0.75], margin: ['#00ff33', 0.6] },
};

/** Zone colours (`imex_viz_theme`): [css colour, opacity]. */
export function imexTheme(cfg: FlatConfig): ImexTheme {
  return THEMES[cfgString(cfg, 'imex_viz_theme', SCALAR, 'standard')] ?? THEMES.standard;
}

/** Carriage colours for the preview markers and toolhead boxes (GCodeViewer s_carriage_colors; primary first). */
export const CARRIAGE_COLOURS = ['#ffffff', '#f0e442', '#d55e00', '#cc79a7'];
