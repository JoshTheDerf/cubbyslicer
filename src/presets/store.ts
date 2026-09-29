/**
 * Presets store — one independent state per engine (catalog, selection,
 * unsaved overrides, user presets). The active engine's resolved config is
 * written to `resolvedConfig` (debounced, only when it actually changed).
 *
 * Owns: `activeEngine`, `resolvedConfig` (src/app/state.ts).
 */
import { computed, reactive, ref, shallowRef, toRaw, watch, type Ref, type ShallowRef } from 'vue';
import { activeEngine, markSliceInputsChanged, resolvedConfig } from '../app/state';
import { evalCondition, getSchema, isEngineAvailable } from '../engine/client';
import type { ConfigOptionDef, ConfigSchema, ConfigValue, EngineId, FlatConfig } from '../engine/types';
import { readPresetFile } from './bundleImport';
import { filterCompatible, type ConditionEvaluator } from './compat';
import { flattenInheritsSync, infoMetaFrom, toPresetValues, type RawPreset } from './inherit';
import { lsGet, lsSet } from './kv';
import { profileBase } from './util';
import { OrcaCatalog } from './orca/catalog';
import { ORCA_COMPAT_PREFIX, orcaToPreflight } from './preflight/convert';
import { PreflightCatalog } from './preflight/catalog';
import { bedTypeOf, extruderCount, resolveConfig, schemaDefaults, shapeValues, tabOfScope } from './resolve';
import {
  DEFAULT_PRESET_ID, NON_ENGINE_KEYS, type BedAssets, type PresetCatalog, type PresetInfo, type PresetKind, type PresetValues,
} from './types';
import { toOrcaJson, UserPresetStore, type UserPreset } from './userPresets';
import { asArray, cloneValue, isVectorType, normalizeValue, parseDefault, valuesEqual } from './values';
import { isOrcaFamily } from '../engine/types';

export const ENGINES: readonly EngineId[] = ['orca', 'preflight', 'fullspectrum'];

/** Colours handed to newly added filament slots (first unused wins, like Orca's get_next_color_for_filament). */
export const FILAMENT_PALETTE: readonly string[] = [
  '#F2754E', '#2E86DE', '#27AE60', '#F1C40F', '#8E44AD', '#E74C3C', '#1ABC9C', '#FFFFFF', '#34495E', '#E67E22', '#FF6FB5', '#95A5A6',
];
export function nextFilamentColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.slice(0, 7).toUpperCase()));
  return FILAMENT_PALETTE.find((c) => !taken.has(c)) ?? FILAMENT_PALETTE[used.length % FILAMENT_PALETTE.length];
}

/** Printer selected on an engine's first run (no saved state). */
// OrcaSlicer's own default printer (PresetBundle::ORCA_DEFAULT_PRINTER_MODEL):
// a generic Klipper printer with a full process ladder + library filaments.
const FIRST_RUN_PRINTER: Partial<Record<EngineId, string>> = {
  orca: 'sys:Custom/MyKlipper 0.4 nozzle',
  // preFlight reads Orca's printer library (converted), so it starts on the same printer.
  preflight: 'sys:Custom/MyKlipper 0.4 nozzle',
  fullspectrum: 'sys:Snapmaker/Snapmaker U1 (0.4 nozzle)',
};

export interface Selection { printer: string; process: string; filaments: string[] }
export interface Overrides { printer: PresetValues; process: PresetValues; filaments: PresetValues[] }
export interface TabBases { printer: PresetValues; process: PresetValues; filaments: PresetValues[] }
export interface TabInfos { printer: PresetInfo; process: PresetInfo; filaments: PresetInfo[] }

export type SchemaSource = 'engine' | 'fixture' | 'none';

/** Persisted per-engine UI state (localStorage + project section). */
export interface PersistedEngineState {
  selection: Selection;
  overrides: Overrides;
  installedPrinters: string[];
  /** Project-level values outside the presets (plate type, filament colours). */
  project?: PresetValues;
}

const LS_KEY = (e: EngineId) => `cubby.presets.v1.${e}`;
const LS_ENGINE = 'cubby.presets.v1.activeEngine';

export function defaultInfo(kind: PresetKind, engine: EngineId): PresetInfo {
  const label = engine === 'orca' ? 'OrcaSlicer' : engine === 'fullspectrum' ? 'Full Spectrum' : 'preFlight';
  const noun = kind === 'printer' ? 'printer' : kind === 'process' ? 'process' : 'filament';
  return { id: DEFAULT_PRESET_ID, kind, name: `Default ${noun} (${label})`, source: 'default' };
}

function emptyOverrides(): Overrides { return { printer: {}, process: {}, filaments: [{}] }; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function loadFixture(engine: EngineId): Promise<ConfigSchema | null> {
  try {
    const m = isOrcaFamily(engine)
      ? await import('../settings/__fixtures__/orca-schema.sample.json')
      : await import('../settings/__fixtures__/preflight-schema.sample.json');
    return (m.default ?? m) as unknown as ConfigSchema;
  } catch { return null; }
}

/** Engine schema: build-time schema.json / engine describe; dev fixture fallback. */
export async function loadSchema(engine: EngineId): Promise<{ schema: ConfigSchema | null; source: SchemaSource }> {
  try {
    const s = await withTimeout(getSchema(engine), 60_000);
    if (s && s.options && Object.keys(s.options).length) return { schema: s, source: 'engine' };
  } catch { /* fall back */ }
  const f = await loadFixture(engine);
  return f ? { schema: f, source: 'fixture' } : { schema: null, source: 'none' };
}

/**
 * Engine condition evaluation with a timeout; after repeated timeouts the
 * engine is considered unable to evaluate for this session (→ null = compatible),
 * so a broken / still-loading worker can't stall preset lists.
 */
export function guardedEvaluator(inner: ConditionEvaluator, timeoutMs = 8000): ConditionEvaluator {
  let failures = 0;
  return async (expr, cfg) => {
    if (failures >= 2) return null;
    try {
      const r = await withTimeout(inner(expr, cfg), timeoutMs);
      failures = 0;
      return r;
    } catch {
      failures++;
      return null;
    }
  };
}

export interface ImportReport { imported: UserPreset[]; warnings: string[] }

export interface EnginePresetsOptions {
  catalog?: PresetCatalog;
  schema?: ConfigSchema | null;
  users?: UserPresetStore;
  evaluate?: ConditionEvaluator | null;
  /** Skip localStorage (tests). */
  persist?: boolean;
}

export class EnginePresets {
  readonly schema: ShallowRef<ConfigSchema | null> = shallowRef(null);
  readonly schemaSource = ref<SchemaSource>('none');
  catalog!: PresetCatalog;
  users!: UserPresetStore;
  readonly selection: Selection = reactive({ printer: DEFAULT_PRESET_ID, process: DEFAULT_PRESET_ID, filaments: [DEFAULT_PRESET_ID] });
  readonly overrides: Overrides = reactive(emptyOverrides());
  readonly installedPrinters: Ref<string[]> = ref([]);
  /**
   * Project-level values that belong to no preset, like Orca's plate type
   * (`curr_bed_type`) and the per-slot `filament_colour` list ('' = preset colour).
   * Editing them never marks a preset as modified.
   */
  readonly project: PresetValues = reactive({});
  /** Default plate type of the selected printer's machine model (Orca model JSON), when known. */
  readonly modelBedType = ref<string | null>(null);
  /** The selected system printer model's bed mesh / texture URLs (Orca bed_model / bed_texture). */
  readonly bedAssets: ShallowRef<BedAssets | null> = shallowRef(null);
  /** Orca's schema (preFlight only): plate types for printers from the Orca library. */
  readonly orcaSchema: ShallowRef<ConfigSchema | null> = shallowRef(null);
  readonly bases: ShallowRef<TabBases> = shallowRef({ printer: {}, process: {}, filaments: [{}] });
  readonly infos: ShallowRef<TabInfos>;
  readonly compatible: ShallowRef<{ process: PresetInfo[]; filament: PresetInfo[] }> = shallowRef({ process: [], filament: [] });
  readonly printerInfos: ShallowRef<PresetInfo[]> = shallowRef([]);
  readonly loading = ref(0);
  readonly error = ref<string | null>(null);
  readonly ready: Promise<void>;
  private seq = 0;
  private evaluate: ConditionEvaluator | null = null;
  private readonly persist: boolean;

  constructor(readonly engine: EngineId, opts: EnginePresetsOptions = {}) {
    this.persist = opts.persist ?? true;
    this.infos = shallowRef({ printer: defaultInfo('printer', engine), process: defaultInfo('process', engine), filaments: [defaultInfo('filament', engine)] });
    this.ready = this.init(opts);
  }

  private async init(opts: EnginePresetsOptions): Promise<void> {
    this.loading.value++;
    try {
      if (opts.schema !== undefined) { this.schema.value = opts.schema; this.schemaSource.value = opts.schema ? 'engine' : 'none'; }
      else { const s = await loadSchema(this.engine); this.schema.value = s.schema; this.schemaSource.value = s.source; }
      if (this.engine === 'preflight' && !opts.catalog) this.orcaSchema.value = await getSchema('orca').catch(() => null);
      const native = (k: string) => !this.schema.value || k in this.schema.value.options;
      const vector = (k: string) => { const d = this.schema.value?.options[k]; return !!d && isVectorType(d.type); };
      this.catalog = opts.catalog ?? (isOrcaFamily(this.engine) ? new OrcaCatalog({ engine: this.engine })
        : new PreflightCatalog({
          isNativeKey: native, isVectorKey: vector, orcaLibraryBase: profileBase('orca'),
          orcaSchema: () => getSchema('orca'),
        }));
      this.users = opts.users ?? new UserPresetStore(this.engine);
      if (opts.evaluate !== undefined) this.evaluate = opts.evaluate;
      else {
        const engine = this.engine;
        this.evaluate = (await isEngineAvailable(engine).catch(() => false)) ? guardedEvaluator((expr, cfg) => evalCondition(engine, expr, cfg)) : null;
      }
      await this.users.ready;
      let hadSavedState = false;
      if (this.persist) {
        const saved = lsGet<PersistedEngineState>(LS_KEY(this.engine));
        hadSavedState = !!saved;
        if (saved) this.applyPersisted(saved);
        watch(() => [this.selection, this.overrides, this.installedPrinters.value, this.project], () => this.schedulePersist(), { deep: true });
      }
      await this.refreshPrinterList();
      await this.refresh({ keepSelection: true });
      // First visit: start on a real, valid generic printer (like Orca's own
      // first-run wizard) instead of bare engine defaults, which Orca rejects
      // (relative E without "G92 E0" in layer_gcode).
      const firstRun = FIRST_RUN_PRINTER[this.engine];
      if (this.persist && firstRun && !hadSavedState && this.installedPrinters.value.length === 0) {
        try {
          await this.installPrinter(firstRun);
          await this.selectPrinter(firstRun);
        } catch { /* catalog unavailable: stay on defaults */ }
      }
    } catch (e) {
      this.error.value = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading.value--;
    }
  }

  // ---- persistence ------------------------------------------------------------

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistTimer = null; lsSet(LS_KEY(this.engine), this.snapshot()); }, 300);
  }

  snapshot(): PersistedEngineState {
    const sel = toRaw(this.selection), ov = toRaw(this.overrides);
    return JSON.parse(JSON.stringify({ selection: sel, overrides: ov, installedPrinters: this.installedPrinters.value, project: toRaw(this.project) }));
  }

  private applyPersisted(s: Partial<PersistedEngineState>): void {
    if (s.selection) {
      this.selection.printer = s.selection.printer || DEFAULT_PRESET_ID;
      this.selection.process = s.selection.process || DEFAULT_PRESET_ID;
      this.selection.filaments = Array.isArray(s.selection.filaments) && s.selection.filaments.length ? s.selection.filaments.slice() : [DEFAULT_PRESET_ID];
    }
    if (s.overrides) {
      this.overrides.printer = { ...(s.overrides.printer ?? {}) };
      this.overrides.process = { ...(s.overrides.process ?? {}) };
      this.overrides.filaments = (s.overrides.filaments ?? [{}]).map((f) => ({ ...(f ?? {}) }));
    }
    if (Array.isArray(s.installedPrinters)) this.installedPrinters.value = s.installedPrinters.filter((x) => typeof x === 'string');
    if (s.project && typeof s.project === 'object') {
      for (const k of Object.keys(this.project)) delete this.project[k];
      Object.assign(this.project, JSON.parse(JSON.stringify(s.project)));
    }
  }

  /** Load state from a project file; re-resolves. */
  async load(s: Partial<PersistedEngineState>): Promise<void> {
    await this.ready;
    this.applyPersisted(s);
    for (const id of s.installedPrinters ?? []) if (!this.installedPrinters.value.includes(id)) this.installedPrinters.value.push(id);
    if (s.selection?.printer?.startsWith('sys:') && !this.installedPrinters.value.includes(s.selection.printer)) this.installedPrinters.value.push(s.selection.printer);
    await this.refreshPrinterList();
    await this.refresh({ keepSelection: true });
  }

  // ---- preset lookup ----------------------------------------------------------

  private shape(values: Record<string, unknown>): PresetValues {
    return shapeValues(this.schema.value, values);
  }

  private userInfo(p: UserPreset, parent: PresetInfo | null, merged: Record<string, unknown>): PresetInfo {
    const meta = infoMetaFrom(merged, p.name);
    const own = p.values;
    const ownCompat = 'compatible_printers' in own || 'compatible_printers_condition' in own;
    return {
      ...meta,
      id: p.id, kind: p.kind, name: p.name, source: 'user', parentId: p.parentId, vendor: parent?.vendor,
      compatiblePrinters: ownCompat ? meta.compatiblePrinters : parent?.compatiblePrinters,
      compatiblePrintersCondition: ownCompat ? meta.compatiblePrintersCondition : parent?.compatiblePrintersCondition,
      excludedPrinters: parent?.excludedPrinters,
    };
  }

  /** Resolve any preset id to (info, schema-shaped values). */
  async resolvePreset(kind: PresetKind, id: string): Promise<{ info: PresetInfo; values: PresetValues } | null> {
    if (id === DEFAULT_PRESET_ID) return { info: defaultInfo(kind, this.engine), values: {} };
    if (id.startsWith('user:')) {
      const p = this.users.get(id);
      if (!p || p.kind !== kind) return null;
      const parent = p.parentId ? await this.catalog.info(p.parentId, kind) : null;
      const parentValues = p.parentId ? (await this.catalog.resolve(p.parentId, kind)) ?? {} : {};
      const merged = { ...parentValues, ...p.values };
      return { info: this.userInfo(p, parent, merged), values: this.shape(merged) };
    }
    const info = await this.catalog.info(id, kind);
    if (!info) return null;
    const values = await this.catalog.resolve(id, kind);
    return { info, values: this.shape(values ?? {}) };
  }

  /** Re-list the printer presets (installed system printers + user printers). */
  async refreshPrinterList(): Promise<void> {
    const out: PresetInfo[] = [defaultInfo('printer', this.engine)];
    for (const id of this.installedPrinters.value) {
      const i = await this.catalog.info(id, 'printer').catch(() => null);
      if (i) out.push(i);
    }
    for (const u of this.users.byKind('printer')) {
      const r = await this.resolvePreset('printer', u.id);
      if (r) out.push(r.info);
    }
    this.printerInfos.value = out;
  }

  private async userCandidates(kind: 'process' | 'filament'): Promise<PresetInfo[]> {
    const out: PresetInfo[] = [];
    for (const u of this.users.byKind(kind)) {
      const r = await this.resolvePreset(kind, u.id);
      if (r) out.push(r.info);
    }
    return out;
  }

  // ---- refresh pipeline ---------------------------------------------------------

  /** Full-tab values (defaults ← preset ← overrides) as flat config, for condition evaluation. */
  tabConfig(kind: PresetKind, index = 0, bases = this.bases.value): FlatConfig {
    const schema = this.schema.value;
    const out: FlatConfig = {};
    if (schema) {
      const d = schemaDefaults(schema);
      for (const [k, v] of Object.entries(d)) if (tabOfScope(schema.options[k]?.scope) === kind) out[k] = cloneValue(v);
    }
    const base = kind === 'filament' ? bases.filaments[index] ?? {} : bases[kind];
    const ov = kind === 'filament' ? this.overrides.filaments[index] ?? {} : this.overrides[kind];
    for (const [k, v] of Object.entries(base)) out[k] = cloneValue(v);
    for (const [k, v] of Object.entries(toRaw(ov))) out[k] = cloneValue(v);
    return out;
  }

  /** Keep a valid current selection; otherwise preferred names, then the first system preset. */
  private pick(list: PresetInfo[], current: string, preferredNames: (string | undefined)[]): string {
    if (current === DEFAULT_PRESET_ID || list.some((p) => p.id === current)) return current;
    for (const n of preferredNames) {
      if (!n) continue;
      const hit = list.find((p) => p.name === n);
      if (hit) return hit.id;
    }
    return list.find((p) => p.source === 'system')?.id ?? list.find((p) => p.source === 'user')?.id ?? DEFAULT_PRESET_ID;
  }

  /**
   * Re-resolve printer → compatible processes → process → compatible
   * filaments → filaments. Invalid / incompatible selections are replaced
   * (printer default profiles first). Stale runs are dropped.
   */
  refresh(_opts: { keepSelection?: boolean } = {}): Promise<void> {
    const run = this.runRefresh();
    this.latestRefresh = run;
    // Resolve only once the newest pipeline run has landed (older runs bail out as stale).
    return run.then(async () => {
      let cur: Promise<void>;
      do { cur = this.latestRefresh; await cur; } while (cur !== this.latestRefresh);
    });
  }

  private latestRefresh: Promise<void> = Promise.resolve();

  private async runRefresh(): Promise<void> {
    const seq = ++this.seq;
    const stale = () => seq !== this.seq;
    this.loading.value++;
    try {
      const printer = (await this.resolvePreset('printer', this.selection.printer)) ?? (await this.resolvePreset('printer', DEFAULT_PRESET_ID))!;
      if (stale()) return;
      if (printer.info.id !== this.selection.printer) this.selection.printer = printer.info.id;
      const bases: TabBases = { printer: printer.values, process: {}, filaments: [] };
      const printerCfg = this.tabConfig('printer', 0, bases);
      const parentName = printer.info.parentId ? (await this.catalog.info(printer.info.parentId, 'printer'))?.name : undefined;
      const sysPrinter = printer.info.source === 'system' ? printer.info
        : printer.info.parentId ? await this.catalog.info(printer.info.parentId, 'printer') : null;

      // processes (filament candidates load in parallel)
      const filSys = this.catalog.candidates('filament', sysPrinter);
      filSys.catch(() => { /* surfaced below */ });
      const procCands = [defaultInfo('process', this.engine), ...(await this.catalog.candidates('process', sysPrinter)), ...(await this.userCandidates('process'))];
      if (stale()) return;
      const ctxBase = { printerName: printer.info.name, printerParentName: parentName, printerConfig: printerCfg, evaluate: this.evaluate };
      const procs = await filterCompatible(procCands, ctxBase);
      if (stale()) return;
      const procId = this.pick(procs, this.selection.process, [printer.info.defaultProcess]);
      const proc = (await this.resolvePreset('process', procId)) ?? (await this.resolvePreset('process', DEFAULT_PRESET_ID))!;
      if (stale()) return;
      if (this.selection.process !== proc.info.id) this.selection.process = proc.info.id;
      bases.process = proc.values;

      // filaments
      const filCands = [defaultInfo('filament', this.engine), ...(await filSys), ...(await this.userCandidates('filament'))];
      if (stale()) return;
      const fils = await filterCompatible(filCands, { ...ctxBase, printName: proc.info.name, printConfig: this.tabConfig('process', 0, bases) });
      if (stale()) return;
      const n = this.slotCount(printerCfg);
      const sel = this.selection.filaments.slice(0, n);
      while (sel.length < n) sel.push(sel[sel.length - 1] ?? DEFAULT_PRESET_ID);
      const defaults = printer.info.defaultFilaments ?? [];
      const filInfos: PresetInfo[] = [];
      for (let i = 0; i < n; i++) {
        const id = this.pick(fils, sel[i], [defaults[i], defaults[0]]);
        const r = (await this.resolvePreset('filament', id)) ?? (await this.resolvePreset('filament', DEFAULT_PRESET_ID))!;
        if (stale()) return;
        sel[i] = r.info.id;
        filInfos.push(r.info);
        bases.filaments.push(r.values);
      }
      if (sel.join('\n') !== this.selection.filaments.join('\n')) this.selection.filaments = sel;
      while (this.overrides.filaments.length < n) this.overrides.filaments.push({});
      if (this.overrides.filaments.length > n) this.overrides.filaments.splice(n);

      const modelBed = sysPrinter?.vendor && sysPrinter.printerModel && this.catalog.modelDefaultBedType
        ? await this.catalog.modelDefaultBedType(sysPrinter.vendor, sysPrinter.printerModel).catch(() => null) : null;
      // URLs only — the viewport fetches the mesh / texture itself, lazily.
      const bedAssets = sysPrinter?.vendor && sysPrinter.printerModel && this.catalog.modelBedAssets
        ? await this.catalog.modelBedAssets(sysPrinter.vendor, sysPrinter.printerModel).catch(() => null) : null;
      if (stale()) return;

      this.modelBedType.value = modelBed;
      this.bedAssets.value = bedAssets;
      this.compatible.value = { process: procs, filament: fils };
      this.infos.value = { printer: printer.info, process: proc.info, filaments: filInfos };
      this.bases.value = bases;
      this.error.value = null;
    } catch (e) {
      if (!stale()) this.error.value = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading.value--;
    }
  }

  /** Filament slots: extruder count; single-extruder MM printers may have more. */
  private slotCount(printerCfg: FlatConfig): number {
    const n = extruderCount(printerCfg);
    const semm = printerCfg.single_extruder_multi_material;
    const isSemm = (Array.isArray(semm) ? semm[0] : semm) === '1';
    return isSemm ? Math.max(n, this.selection.filaments.length) : n;
  }

  // ---- selection ------------------------------------------------------------

  async selectPrinter(id: string, opts: { keepOverrides?: boolean } = {}): Promise<void> {
    if (!opts.keepOverrides) this.overrides.printer = {};
    if (id.startsWith('sys:') && !this.installedPrinters.value.includes(id)) {
      this.installedPrinters.value = [...this.installedPrinters.value, id];
      await this.refreshPrinterList();
    }
    this.selection.printer = id;
    // Orca selects the printer's default process / filaments when switching printers.
    const r = await this.resolvePreset('printer', id);
    if (r) {
      const sys = r.info.source === 'system' ? r.info : r.info.parentId ? await this.catalog.info(r.info.parentId, 'printer') : null;
      // Warm both candidate lists in parallel (hundreds of small preset files).
      await Promise.all([this.catalog.candidates('process', sys), this.catalog.candidates('filament', sys)]);
      if (r.info.defaultProcess) {
        const hit = await this.findVisible('process', r.info.defaultProcess, r.info)
          ?? await this.findVisibleLoose('process', r.info.defaultProcess, r.info);
        if (hit) this.selection.process = hit;
      }
      const dfl = r.info.defaultFilaments ?? [];
      if (dfl.length) {
        const sel = this.selection.filaments.slice();
        for (let i = 0; i < sel.length; i++) {
          const hit = await this.findVisible('filament', dfl[i] ?? dfl[0], r.info);
          if (hit) sel[i] = hit;
        }
        this.selection.filaments = sel;
      }
    }
    await this.refresh({ keepSelection: true });
  }

  /**
   * Vendor profiles sometimes misspell their default (Snapmaker U1: "0.20 Standard @…"
   * for "0.20mm Standard @…"): match ignoring "mm" / spacing / case, else the
   * first compatible "Standard" preset, else the first compatible one.
   */
  private async findVisibleLoose(kind: 'process' | 'filament', name: string, printer: PresetInfo): Promise<string | null> {
    const sys = printer.source === 'system' ? printer : printer.parentId ? await this.catalog.info(printer.parentId, 'printer') : null;
    const c = await this.catalog.candidates(kind, sys);
    if (!c.length) return null;
    const norm = (x: string) => x.toLowerCase().replace(/mm\b/g, '').replace(/\s+/g, '');
    const want = norm(name);
    return (c.find((p) => norm(p.name) === want) ?? c.find((p) => /standard/i.test(p.name) && /0\.2\d?mm/.test(p.name)) ?? c.find((p) => /standard/i.test(p.name)) ?? c[0]).id;
  }

  private async findVisible(kind: 'process' | 'filament', name: string, printer: PresetInfo): Promise<string | null> {
    const sys = printer.source === 'system' ? printer : printer.parentId ? await this.catalog.info(printer.parentId, 'printer') : null;
    const c = await this.catalog.candidates(kind, sys);
    return c.find((p) => p.name === name)?.id ?? null;
  }

  async selectProcess(id: string, opts: { keepOverrides?: boolean } = {}): Promise<void> {
    if (!opts.keepOverrides) this.overrides.process = {};
    this.selection.process = id;
    await this.refresh({ keepSelection: true });
  }

  async selectFilament(index: number, id: string, opts: { keepOverrides?: boolean } = {}): Promise<void> {
    if (!opts.keepOverrides) this.overrides.filaments[index] = {};
    // Like Orca, a newly picked filament shows its own default colour.
    if (!opts.keepOverrides && id !== this.selection.filaments[index]) this.setFilamentColour(index, '');
    const sel = this.selection.filaments.slice();
    sel[index] = id;
    this.selection.filaments = sel;
    await this.refresh({ keepSelection: true });
  }

  /** Single-extruder multi-material: add / remove filament slots. */
  async setFilamentCount(n: number): Promise<void> {
    const count = Math.max(1, Math.min(64, Math.floor(n)));
    const prev = this.selection.filaments.length;
    const sel = this.selection.filaments.slice(0, count);
    while (sel.length < count) sel.push(sel[sel.length - 1] ?? DEFAULT_PRESET_ID);
    this.selection.filaments = sel;
    while (this.overrides.filaments.length < count) this.overrides.filaments.push({});
    this.overrides.filaments.splice(count);
    const colours = this.colourList(count);
    for (let i = prev; i < count; i++) colours[i] = nextFilamentColour(colours.slice(0, i).map((c, j) => c || this.filamentColour(j)));
    this.project.filament_colour = colours;
    await this.refresh({ keepSelection: true });
  }

  /** Remove filament slot `index` (Orca's per-row delete), keeping the other slots' presets, edits and colours. */
  async removeFilament(index: number): Promise<void> {
    const n = this.selection.filaments.length;
    if (n <= 1 || index < 0 || index >= n) return;
    const colours = this.colourList(n);
    colours.splice(index, 1);
    this.project.filament_colour = colours;
    this.selection.filaments = this.selection.filaments.filter((_, i) => i !== index);
    this.overrides.filaments.splice(index, 1);
    await this.refresh({ keepSelection: true });
  }

  // ---- project-level values (no preset) ----------------------------------------------

  private colourList(n: number): string[] {
    const cur = asArray(this.project.filament_colour);
    return Array.from({ length: n }, (_, i) => cur[i] ?? '');
  }

  /** Display colour of filament slot `index`: the project's choice, else the preset's (default_)filament_colour. */
  filamentColour(index: number): string {
    const own = asArray(this.project.filament_colour)[index];
    if (own) return own;
    const base = this.bases.value.filaments[index] ?? {};
    const pick = (k: string) => asArray(this.value('filament', k, index))[0];
    return ('filament_colour' in base ? pick('filament_colour') : '') || pick('default_filament_colour') || pick('filament_colour') || '#F2754E';
  }

  /** Set slot `index`'s colour ('' = back to the preset's colour). Doesn't modify the preset. */
  setFilamentColour(index: number, colour: string): void {
    const list = this.colourList(Math.max(this.selection.filaments.length, index + 1));
    list[index] = colour;
    if (list.every((c) => !c)) delete this.project.filament_colour;
    else this.project.filament_colour = list;
  }

  /**
   * The schema carrying the plate type option: the engine's own (Orca), or —
   * for preFlight running a printer converted from the Orca library (it has
   * `orca:*` values) — Orca's, sent to the engine as a placeholder variable.
   */
  private bedSchema(): ConfigSchema | null {
    if (this.schema.value?.options.curr_bed_type) return this.schema.value;
    if (this.engine !== 'preflight' || !this.orcaSchema.value?.options.curr_bed_type) return null;
    return Object.keys(this.bases.value.printer).some((k) => k.startsWith(ORCA_COMPAT_PREFIX)) ? this.orcaSchema.value : null;
  }

  /** The plate type option definition when this printer has plate types. */
  bedTypeDef(): ConfigOptionDef | null { return this.bedSchema()?.options.curr_bed_type ?? null; }

  /** Printer default_bed_type (native, or carried as an Orca compat value). */
  printerDefaultBedType(): string {
    return asArray(this.value('printer', 'default_bed_type'))[0] || asArray(this.value('printer', ORCA_COMPAT_PREFIX + 'default_bed_type'))[0] || '';
  }

  /** Orca plate type (`curr_bed_type`): project choice, else the printer's default_bed_type, else the schema default. */
  bedType(): string | null {
    const schema = this.bedSchema();
    const def = schema?.options.curr_bed_type;
    if (!def) return null;
    const own = this.project.curr_bed_type;
    if (typeof own === 'string' && own) return own;
    return bedTypeOf(schema, this.printerDefaultBedType()) ?? bedTypeOf(schema, this.modelBedType.value ?? '') ?? def.default;
  }

  private projectForResolve(): PresetValues {
    const project = toRaw(this.project);
    const bed = this.bedType();
    if (!bed) return project;
    if (this.schema.value?.options.curr_bed_type) return { ...project, curr_bed_type: bed };
    const { curr_bed_type: _, ...rest } = project;
    return { ...rest, [ORCA_COMPAT_PREFIX + 'curr_bed_type']: bed };
  }

  setBedType(v: string | null): void {
    if (v) this.project.curr_bed_type = v;
    else delete this.project.curr_bed_type;
  }

  async installPrinter(id: string): Promise<void> {
    if (!this.installedPrinters.value.includes(id)) this.installedPrinters.value = [...this.installedPrinters.value, id];
    await this.refreshPrinterList();
  }

  async uninstallPrinter(id: string): Promise<void> {
    this.installedPrinters.value = this.installedPrinters.value.filter((x) => x !== id);
    if (this.selection.printer === id) await this.selectPrinter(DEFAULT_PRESET_ID);
    await this.refreshPrinterList();
  }

  // ---- values / overrides -------------------------------------------------------

  private overrideBag(kind: PresetKind, index = 0): PresetValues {
    if (kind !== 'filament') return this.overrides[kind];
    while (this.overrides.filaments.length <= index) this.overrides.filaments.push({});
    return this.overrides.filaments[index];
  }

  /** Preset value of a key (defaults ← preset), without unsaved edits. */
  presetValue(kind: PresetKind, key: string, index = 0): ConfigValue | undefined {
    const b = this.bases.value;
    const base = kind === 'filament' ? b.filaments[index] ?? {} : b[kind];
    if (key in base) return base[key];
    const def = this.schema.value?.options[key];
    return def ? parseDefault(def) : undefined;
  }

  /** Effective tab value (preset ← unsaved override). Reactive per key. */
  value(kind: PresetKind, key: string, index = 0): ConfigValue | undefined {
    const ov = kind === 'filament' ? this.overrides.filaments[index] : this.overrides[kind];
    if (ov && key in ov) return ov[key];
    return this.presetValue(kind, key, index);
  }

  isModified(kind: PresetKind, key: string, index = 0): boolean {
    const ov = kind === 'filament' ? this.overrides.filaments[index] : this.overrides[kind];
    return !!ov && key in ov;
  }

  setValue(kind: PresetKind, key: string, value: ConfigValue | undefined, index = 0): void {
    const bag = this.overrideBag(kind, index);
    if (value === undefined) delete bag[key];
    else {
      const v = normalizeValue(this.schema.value?.options[key], value);
      if (valuesEqual(v, this.presetValue(kind, key, index))) delete bag[key];
      else bag[key] = v;
    }
    this.afterEdit(kind, key);
  }

  revert(kind: PresetKind, key: string, index = 0): void { delete this.overrideBag(kind, index)[key]; this.afterEdit(kind, key); }

  /** Keys whose change alters the filament slot count or compatibility → re-run the pipeline. */
  private static readonly STRUCTURAL_EDIT = new Set(['nozzle_diameter', 'single_extruder_multi_material']);
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private afterEdit(kind: PresetKind, key: string): void {
    if (kind !== 'printer' || !EnginePresets.STRUCTURAL_EDIT.has(key)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, 250);
  }

  revertAll(kind: PresetKind, index = 0): void {
    const hadStructural = kind === 'printer' && Object.keys(this.overrides.printer).some((k) => EnginePresets.STRUCTURAL_EDIT.has(k));
    if (kind === 'filament') this.overrides.filaments[index] = {};
    else this.overrides[kind] = {};
    if (hadStructural) this.afterEdit('printer', 'nozzle_diameter');
  }

  /** Resize every per-extruder printer vector to `n` extruders (repeating the last element). */
  setExtruderCount(n: number, perExtruderKeys: Iterable<string>): void {
    const count = Math.max(1, Math.min(16, Math.floor(n)));
    const schema = this.schema.value;
    for (const key of new Set([...perExtruderKeys, 'nozzle_diameter', 'extruder_colour', 'extruder_offset', 'default_filament_profile'])) {
      const def = schema?.options[key];
      if (schema && (!def || def.scope !== 'machine' || !isVectorType(def.type))) continue;
      const cur = asArray(this.value('printer', key));
      if (!cur.length) continue;
      const next = cur.slice(0, count);
      while (next.length < count) next.push(next[next.length - 1]);
      this.setValue('printer', key, next);
    }
  }

  dirtyCount(kind: PresetKind, index = 0): number {
    const ov = kind === 'filament' ? this.overrides.filaments[index] : this.overrides[kind];
    return ov ? Object.keys(ov).length : 0;
  }

  /** Whether the user set this key (unsaved edit or a selected user preset's own value). */
  userTouched(key: string): boolean {
    if (key in this.overrides.printer || key in this.overrides.process || this.overrides.filaments.some((f) => key in f)) return true;
    const inf = this.infos.value;
    for (const i of [inf.printer, inf.process, ...inf.filaments]) {
      if (i.source !== 'user') continue;
      const u = this.users.get(i.id);
      if (u && key in u.values) return true;
    }
    return false;
  }

  selectedId(kind: PresetKind, index = 0): string {
    return kind === 'filament' ? this.selection.filaments[index] ?? DEFAULT_PRESET_ID : this.selection[kind];
  }

  selectedInfo(kind: PresetKind, index = 0): PresetInfo {
    const i = this.infos.value;
    return kind === 'filament' ? i.filaments[index] ?? defaultInfo('filament', this.engine) : i[kind];
  }

  // ---- resolution -------------------------------------------------------------

  resolve(): FlatConfig {
    const b = this.bases.value;
    const inf = this.infos.value;
    return resolveConfig({
      schema: this.schema.value,
      printer: b.printer,
      process: b.process,
      filaments: b.filaments,
      overrides: { printer: toRaw(this.overrides.printer), process: toRaw(this.overrides.process), filaments: toRaw(this.overrides.filaments).map((f) => toRaw(f)) },
      names: {
        printer: inf.printer.source === 'default' ? '' : inf.printer.name,
        process: inf.process.source === 'default' ? '' : inf.process.name,
        filaments: inf.filaments.map((f) => (f.source === 'default' ? '' : f.name)),
      },
      // The plate type falls back to the printer / machine model default (bedType()).
      project: this.projectForResolve(),
    });
  }

  // ---- user preset operations -----------------------------------------------------

  /** Values of the current tab (preset + overrides), restricted to the tab's keys. */
  private currentTabValues(kind: PresetKind, index = 0): PresetValues {
    const b = this.bases.value;
    const base = kind === 'filament' ? b.filaments[index] ?? {} : b[kind];
    const out: PresetValues = {};
    for (const [k, v] of Object.entries(base)) out[k] = cloneValue(v);
    for (const [k, v] of Object.entries(toRaw(this.overrideBag(kind, index)))) out[k] = cloneValue(v);
    return out;
  }

  /** System parent for saving: the system preset itself, or a user preset's parent. */
  private async parentFor(kind: PresetKind, index = 0): Promise<{ id?: string; name?: string; values: PresetValues }> {
    const info = this.selectedInfo(kind, index);
    const parentId = info.source === 'system' ? info.id : info.source === 'user' ? info.parentId : undefined;
    if (!parentId) return { values: {} };
    const r = await this.resolvePreset(kind, parentId);
    return { id: parentId, name: r?.info.name, values: r?.values ?? {} };
  }

  private diffAgainst(values: PresetValues, parent: PresetValues, hasParent: boolean): PresetValues {
    if (!hasParent) return values;
    const out: PresetValues = {};
    for (const [k, v] of Object.entries(values)) if (!valuesEqual(v, parent[k])) out[k] = v;
    return out;
  }

  /** Save unsaved edits into the selected user preset. Returns false for system/default presets (use saveAs). */
  async save(kind: PresetKind, index = 0): Promise<boolean> {
    const info = this.selectedInfo(kind, index);
    if (info.source !== 'user') return false;
    const parent = await this.parentFor(kind, index);
    const values = this.diffAgainst(this.currentTabValues(kind, index), parent.values, !!parent.id);
    this.users.update(info.id, { values });
    this.revertAll(kind, index);
    await this.refresh({ keepSelection: true });
    return true;
  }

  /** Save the current tab (preset + edits) as a new user preset and select it. */
  async saveAs(kind: PresetKind, name: string, index = 0): Promise<UserPreset> {
    const parent = await this.parentFor(kind, index);
    const values = this.diffAgainst(this.currentTabValues(kind, index), parent.values, !!parent.id);
    const p = this.users.create({ kind, name, parentId: parent.id, inherits: parent.name, values });
    this.revertAll(kind, index);
    if (kind === 'printer') this.selection.printer = p.id;
    else if (kind === 'process') this.selection.process = p.id;
    else { const sel = this.selection.filaments.slice(); sel[index] = p.id; this.selection.filaments = sel; }
    await this.refreshPrinterList();
    await this.refresh({ keepSelection: true });
    return p;
  }

  async renamePreset(id: string, name: string): Promise<UserPreset> {
    const p = this.users.rename(id, name);
    await this.refreshPrinterList();
    await this.refresh();
    return p;
  }

  async deletePreset(id: string): Promise<void> {
    const p = this.users.get(id);
    if (!p) return;
    this.users.remove(id);
    const fallback = p.parentId ?? DEFAULT_PRESET_ID;
    if (this.selection.printer === id) this.selection.printer = fallback;
    if (this.selection.process === id) this.selection.process = fallback;
    this.selection.filaments = this.selection.filaments.map((f) => (f === id ? fallback : f));
    await this.refreshPrinterList();
    await this.refresh({ keepSelection: true });
  }

  /**
   * Orca preset JSON of the selected preset of a tab (+ unsaved edits).
   * `flatten`: full values instead of the diff against the system parent.
   */
  async exportPreset(kind: PresetKind, index = 0, flatten = false): Promise<{ filename: string; json: Record<string, unknown> }> {
    const info = this.selectedInfo(kind, index);
    const parent = await this.parentFor(kind, index);
    const current = this.currentTabValues(kind, index);
    let values: PresetValues;
    if (flatten || !parent.id) {
      values = {};
      const cfg = this.tabConfig(kind, index);
      for (const [k, v] of Object.entries(cfg)) if (!NON_ENGINE_KEYS.has(k) || k.startsWith('compatible_')) values[k] = v;
      for (const [k, v] of Object.entries(current)) values[k] = v;
    } else {
      values = this.diffAgainst(current, parent.values, true);
    }
    const name = info.source === 'default' ? `My ${kind}` : info.name;
    const json = toOrcaJson(kind, name, values, flatten ? undefined : parent.name);
    return { filename: `${name.replace(/[^\w.@ -]+/g, '_')}.json`, json };
  }

  /** Import preset files (JSON / zip bundles) as user presets. */
  async importFiles(files: Array<{ name: string; data: Uint8Array }>): Promise<ImportReport> {
    const warnings: string[] = [];
    const raws: Array<{ kind: PresetKind; name: string; raw: RawPreset }> = [];
    for (const f of files) {
      const r = await readPresetFile(f.name, f.data);
      warnings.push(...r.warnings);
      raws.push(...r.presets);
    }
    const imported: UserPreset[] = [];
    const byName = new Map(raws.map((r) => [`${r.kind}|${r.name}`, r.raw]));
    for (const r of raws) {
      if (r.raw.instantiation === 'false') continue; // templates only serve as parents
      try {
        // Flatten against other presets from the same import first.
        const flat = flattenInheritsSync(r.raw, (ref) => byName.get(`${r.kind}|${ref}`), r.name);
        const lastRef = flat.missing;
        let parent: PresetInfo | null = null;
        if (lastRef) parent = await this.catalog.findByName(r.kind, lastRef);
        if (lastRef && !parent) warnings.push(`${r.name}: parent "${lastRef}" not found — imported as a standalone preset`);
        let values = toPresetValues(flat.values);
        if (this.engine === 'preflight') {
          const schema = this.schema.value;
          values = orcaToPreflight(r.kind, values, (k) => !schema || k in schema.options,
            (k) => { const d = schema?.options[k]; return !!d && isVectorType(d.type); });
        }
        let own = this.shape(values);
        if (!parent) {
          // Standalone: keep only keys that belong to this tab.
          const schema = this.schema.value;
          if (schema) own = Object.fromEntries(Object.entries(own).filter(([k]) => tabOfScope(schema.options[k]?.scope) === r.kind || k.startsWith('compatible_')));
        }
        const name = this.users.uniqueName(r.kind, r.name);
        imported.push(this.users.create({ kind: r.kind, name, parentId: parent?.id, inherits: parent?.name, values: own }));
      } catch (e) {
        warnings.push(`${r.name}: ${(e as Error).message}`);
      }
    }
    await this.refreshPrinterList();
    await this.refresh({ keepSelection: true });
    return { imported, warnings };
  }
}

// ---- module-level registry --------------------------------------------------------

const engines = new Map<EngineId, EnginePresets>();

/** Per-engine preset state (created lazily). */
export function presetsFor(engine: EngineId): EnginePresets {
  let s = engines.get(engine);
  if (!s) { s = new EnginePresets(engine); engines.set(engine, s); }
  return s;
}

/** Test hook: install a pre-built engine state. */
export function _setEnginePresets(engine: EngineId, s: EnginePresets | null): void {
  if (s) engines.set(engine, s); else engines.delete(engine);
}

/** Currently active engine's preset state. */
export const currentPresets = computed(() => presetsFor(activeEngine.value));

export function setActiveEngine(engine: EngineId): void {
  if (activeEngine.value === engine) return;
  activeEngine.value = engine;
  lsSet(LS_ENGINE, engine);
}

let started = false;

/**
 * Start writing `resolvedConfig` for the active engine. Idempotent; called by
 * the settings panel on mount and safe to call from the shell at startup.
 */
let flushNow: (() => void) | null = null;

export function startPresets(): void {
  if (started) return;
  started = true;
  const saved = lsGet<EngineId>(LS_ENGINE);
  if (saved && ENGINES.includes(saved)) activeEngine.value = saved;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const s = presetsFor(activeEngine.value);
    if (!s.schema.value && s.loading.value) return;
    const cfg = s.resolve();
    const prev = resolvedConfig.value;
    if (!sameConfig(prev, cfg)) {
      resolvedConfig.value = cfg;
      markSliceInputsChanged();
    }
  };
  flushNow = flush;
  watch(
    () => {
      const s = presetsFor(activeEngine.value);
      return [activeEngine.value, s.bases.value, s.infos.value, s.schema.value, s.overrides, s.project, s.modelBedType.value, s.orcaSchema.value];
    },
    () => { if (timer) clearTimeout(timer); timer = setTimeout(flush, 120); },
    { deep: true, immediate: true },
  );
}

/**
 * Wait until the active engine's presets have finished loading (first-run
 * printer install, catalog, schema) and `resolvedConfig` reflects them, so a
 * slice started straight after page load uses the selected printer.
 */
export async function presetsSettled(timeoutMs = 60_000): Promise<void> {
  startPresets();
  const s = presetsFor(activeEngine.value);
  const deadline = Date.now() + timeoutMs;
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, timeoutMs))]);
  while (s.loading.value > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  flushNow?.();
}

function sameConfig(a: FlatConfig, b: FlatConfig): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!valuesEqual(a[k], b[k])) return false;
  return true;
}

// ---- project section -------------------------------------------------------------------

export interface PresetsProjectData {
  version: 1;
  activeEngine: EngineId;
  engines: Partial<Record<EngineId, PersistedEngineState>>;
}

/** Project file section `presets` (selection + unsaved overrides per engine). */
export const presetsProjectSection = {
  save(): PresetsProjectData {
    const out: PresetsProjectData = { version: 1, activeEngine: activeEngine.value, engines: {} };
    for (const [id, s] of engines) out.engines[id] = s.snapshot();
    return out;
  },
  async load(data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null) return;
    const d = data as Partial<PresetsProjectData>;
    if (d.engines) {
      for (const e of ENGINES) {
        const st = d.engines[e];
        if (st) await presetsFor(e).load(st);
      }
    }
    if (d.activeEngine && ENGINES.includes(d.activeEngine)) setActiveEngine(d.activeEngine);
  },
};
