/**
 * One engine's preset state: catalog, selection, unsaved overrides, user
 * presets and project-level values, and the refresh pipeline that resolves
 * printer → compatible processes → process → compatible filaments.
 *
 * Concerns live in their own modules; this class keeps the state and
 * delegates (the method names are the public API used across the app):
 *   schemaLoad      schema + condition evaluator
 *   persistence     localStorage, cross-tab sync, snapshots
 *   filamentSlots   physical / mixed slots, colours, nozzle flow types, purge mode
 *   filamentRefs    renumbering object / part / paint / plate references
 *   variantEdit     per-variant (extruder / nozzle flow) editing
 *   userPresetOps   save / export / import
 */
import { clampFilamentIndexKeys } from './filamentRefs';
import { reactive, ref, shallowRef, toRaw, type Ref, type ShallowRef } from 'vue';
import { evalCondition, getSchema, isEngineAvailable } from '../engine/client';
import { engineCaps } from '../engine/capabilities';
import type { ConfigOptionDef, ConfigSchema, ConfigValue, EngineId, FlatConfig } from '../engine/types';
import { SCALAR, valueAt, asList } from '../lib/configValue';
import type { FilamentColour } from '../lib/colour';
import { withMixedSlots, type MixedDef, type MixedFilament } from '../mixed/model';
import { fitFlushMatrix } from '../dialogs/flush/flushCalc';
import { filterCompatible, type ConditionEvaluator } from './compat';
import * as slots from './filamentSlots';
import { infoMetaFrom } from './inherit';
import { OrcaCatalog } from './orca/catalog';
import { applyPersisted, persistChanges, readSaved, snapshot, type PersistedEngineState } from './persistence';
import { ORCA_COMPAT_PREFIX } from './preflight/convert';
import { PreflightCatalog } from './preflight/catalog';
import { bedTypeOf, extruderCount, resolveConfig, schemaDefaults, shapeValues, tabOfScope } from './resolve';
import { guardedEvaluator, loadSchema, type SchemaSource } from './schemaLoad';
import { DEFAULT_PRESET_ID, type BedAssets, type PresetCatalog, type PresetInfo, type PresetKind, type PresetValues } from './types';
import * as ops from './userPresetOps';
import { UserPresetStore, type UserPreset } from './userPresets';
import { profileBase } from './util';
import { cloneValue, isVectorType, normalizeValue, parseDefault, valuesEqual } from './values';
import * as vedit from './variantEdit';
import { finishNozzleMaps } from './nozzleMaps';
import { applyChildOverParent, normalizeVariantLengths } from './variants';

export interface Selection { printer: string; process: string; filaments: string[] }
export interface Overrides { printer: PresetValues; process: PresetValues; filaments: PresetValues[] }
export interface TabBases { printer: PresetValues; process: PresetValues; filaments: PresetValues[] }
export interface TabInfos { printer: PresetInfo; process: PresetInfo; filaments: PresetInfo[] }

export function defaultInfo(kind: PresetKind, engine: EngineId): PresetInfo {
  const label = engineCaps(engine).label;
  const noun = kind === 'printer' ? 'printer' : kind === 'process' ? 'process' : 'filament';
  return { id: DEFAULT_PRESET_ID, kind, name: `Default ${noun} (${label})`, source: 'default' };
}

function emptyOverrides(): Overrides { return { printer: {}, process: {}, filaments: [{}] }; }

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
   * (`curr_bed_type`), the per-slot `filament_colour` list ('' = preset colour),
   * each extruder's `nozzle_volume_type`, `prime_volume_mode`, `filament_map`.
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
  /** `ready` has resolved: `snapshot()` is the real state, not the constructor defaults. */
  isReady = false;
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
      if (engineCaps(this.engine).orcaCompat && !opts.catalog) this.orcaSchema.value = await getSchema('orca').catch(() => null);
      const native = (k: string) => !this.schema.value || k in this.schema.value.options;
      const vector = (k: string) => { const d = this.schema.value?.options[k]; return !!d && isVectorType(d.type); };
      this.catalog = opts.catalog ?? (engineCaps(this.engine).orcaConfig ? new OrcaCatalog({ engine: this.engine })
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
        const saved = readSaved(this.engine);
        hadSavedState = !!saved;
        if (saved) applyPersisted(this, saved);
        persistChanges(this);
      }
      await this.refreshPrinterList();
      await this.refresh({ keepSelection: true });
      // First visit: start on a real, valid generic printer (like Orca's own
      // first-run wizard) instead of bare engine defaults, which Orca rejects
      // (relative E without "G92 E0" in layer_gcode).
      const firstRun = engineCaps(this.engine).firstRunPrinter;
      if (this.persist && firstRun && !hadSavedState && this.installedPrinters.value.length === 0) {
        try {
          await this.installPrinter(firstRun);
          await this.selectPrinter(firstRun);
        } catch { /* catalog unavailable: stay on defaults */ }
      }
    } catch (e) {
      this.error.value = e instanceof Error ? e.message : String(e);
    } finally {
      this.isReady = true;
      this.loading.value--;
    }
  }

  // ---- persistence ------------------------------------------------------------

  snapshot(): PersistedEngineState { return snapshot(this); }

  /** Load state from a project file; re-resolves. */
  async load(s: Partial<PersistedEngineState>): Promise<void> {
    await this.ready;
    // The installed-printer list is shared by all tabs: add to it, never drop from it.
    const installed = this.installedPrinters.value.slice();
    applyPersisted(this, s);
    for (const id of installed) if (!this.installedPrinters.value.includes(id)) this.installedPrinters.value.push(id);
    if (s.selection?.printer?.startsWith('sys:') && !this.installedPrinters.value.includes(s.selection.printer)) this.installedPrinters.value.push(s.selection.printer);
    await this.refreshPrinterList();
    await this.refresh({ keepSelection: true });
  }

  // ---- preset lookup ----------------------------------------------------------

  /** Schema-shaped values (unknown keys dropped, enums checked). */
  shape(values: Record<string, unknown>): PresetValues {
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
      filamentId: parent?.filamentId,
    };
  }

  /**
   * Resolve any preset id to (info, schema-shaped values). Per-variant vectors
   * are sized to the preset's variant columns; a user preset is laid over its
   * parent column by column (variants.ts).
   */
  async resolvePreset(kind: PresetKind, id: string): Promise<{ info: PresetInfo; values: PresetValues } | null> {
    if (id === DEFAULT_PRESET_ID) return { info: defaultInfo(kind, this.engine), values: {} };
    const schema = this.schema.value;
    if (id.startsWith('user:')) {
      const p = this.users.get(id);
      if (!p || p.kind !== kind) return null;
      const parent = p.parentId ? await this.catalog.info(p.parentId, kind) : null;
      const parentValues = p.parentId ? normalizeVariantLengths(this.shape((await this.catalog.resolve(p.parentId, kind)) ?? {}), schema) : {};
      const merged = applyChildOverParent(parentValues, this.shape(p.values), schema, kind);
      return { info: this.userInfo(p, parent, merged), values: normalizeVariantLengths(merged, schema) };
    }
    const info = await this.catalog.info(id, kind);
    if (!info) return null;
    const values = await this.catalog.resolve(info.id, kind);
    return { info, values: normalizeVariantLengths(this.shape(values ?? {}), schema) };
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
      if (sel.join('\n') !== this.selection.filaments.join('\n')) {
        // Mixed slots follow the physical ones: keep them at the tail of the project lists.
        const colours = slots.colourList(this, n), defs = slots.mixedDefs(this);
        this.selection.filaments = sel;
        if (defs.length) slots.layoutSlots(this, colours, defs);
      }
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

  /**
   * Filament slots: the selected ones, at least one per extruder. Desktop pads the list up to
   * PresetBundle::min_filament_count and never trims it (update_multi_material_filament_presets), so a
   * printer without single_extruder_multi_material keeps extra filaments too.
   */
  private slotCount(printerCfg: FlatConfig): number {
    return Math.max(extruderCount(printerCfg), this.selection.filaments.length);
  }

  // ---- selection ------------------------------------------------------------

  async selectPrinter(id: string, opts: { keepOverrides?: boolean } = {}): Promise<void> {
    if (!opts.keepOverrides) this.overrides.printer = {};
    if (id.startsWith('sys:') && !this.installedPrinters.value.includes(id)) {
      this.installedPrinters.value = [...this.installedPrinters.value, id];
      await this.refreshPrinterList();
    }
    if (id !== this.selection.printer) {
      // A new printer starts on its own nozzle flow types (Orca resets nozzle_volume_type to the printer defaults).
      delete this.project.nozzle_volume_type;
      delete this.project.filament_volume_map;
      // …and a freshly seeded nozzle rack (seedExtruderNozzleStats on printer load).
      delete this.project.extruder_nozzle_stats;
      delete this.project.filament_nozzle_map;
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

  /** A compatible candidate by name, following `renamed_from` (a printer's default may name a preset renamed since). */
  private async findVisible(kind: 'process' | 'filament', name: string, printer: PresetInfo): Promise<string | null> {
    const sys = printer.source === 'system' ? printer : printer.parentId ? await this.catalog.info(printer.parentId, 'printer') : null;
    const c = await this.catalog.candidates(kind, sys);
    const hit = c.find((p) => p.name === name);
    if (hit) return hit.id;
    const renamed = await this.catalog.findByName(kind, name, sys?.vendor).catch(() => null);
    return renamed && c.some((p) => p.id === renamed.id) ? renamed.id : null;
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

  // ---- filament slots (filamentSlots.ts) -----------------------------------------------

  setFilamentCount(n: number): Promise<void> { return slots.setFilamentCount(this, n); }
  removeFilament(index: number): Promise<void> { return slots.removeFilament(this, index); }
  mixedSupported(): boolean { return slots.mixedSupported(this); }
  mixedDefs(): MixedDef[] { return slots.mixedDefs(this); }
  mixedFilaments(): MixedFilament[] { return slots.mixedFilaments(this); }
  filamentSlotCount(): number { return slots.filamentSlotCount(this); }
  setMixed(defs: MixedDef[]): number | null { return slots.setMixed(this, defs); }
  /** Remove mixed filament number `id`, renumbering references to the later slots. */
  removeMixed(id: number): void { slots.removeMixed(this, id); }
  /** Display colour of filament slot `index` (physical: project choice, else preset colour; mixed: the blend). */
  filamentColour(index: number): string { return slots.filamentColour(this, index); }
  /** Display colour of every filament slot, physical then mixed. */
  filamentColours(): string[] { return slots.filamentColours(this); }
  /** Display colours of the physical slots. */
  physicalColours(): string[] { return slots.physicalColourList(this); }
  setFilamentColour(index: number, colour: string): void { slots.setFilamentColour(this, index, colour); }
  /** Every colour of a physical slot and whether they blend (Orca 2.5 multi-colour / gradient filaments). */
  filamentColourSpec(index: number): FilamentColour { return slots.filamentColourSpec(this, index); }
  setFilamentColourSpec(index: number, fc: FilamentColour | null): void { slots.setFilamentColourSpec(this, index, fc); }
  extruders() { return slots.extruders(this); }
  nozzleVolumeTypes(): string[] { return slots.nozzleVolumeTypes(this); }
  setNozzleVolumeType(extruder: number, type: string): void { slots.setNozzleVolumeType(this, extruder, type); }
  /** The selected printer's machine model `model_id` (vendor catalogs only). */
  async printerModelId(): Promise<string | undefined> {
    const i = this.infos.value.printer;
    if (!i.vendor || !i.printerModel || !this.catalog.modelId) return undefined;
    return (await this.catalog.modelId(i.vendor, i.printerModel).catch(() => null)) ?? undefined;
  }
  /** Nozzle rack per extruder (`extruder_nozzle_stats`), null without a rack. */
  nozzleStats(): string[] | null { return slots.nozzleStats(this); }
  setNozzleCount(extruder: number, type: string, count: number): void { slots.setNozzleCount(this, extruder, type, count); }
  setNozzleCounts(extruder: number, counts: Record<string, number>): boolean { return slots.setNozzleCounts(this, extruder, counts); }
  purgeModes() { return slots.purgeModes(this); }
  purgeMode() { return slots.purgeMode(this); }

  // ---- plate type -----------------------------------------------------------------------

  /**
   * The schema carrying the plate type option: the engine's own (Orca), or —
   * for preFlight running a printer converted from the Orca library (it has
   * `orca:*` values) — Orca's, sent to the engine as a placeholder variable.
   */
  private bedSchema(): ConfigSchema | null {
    if (this.schema.value?.options.curr_bed_type) return this.schema.value;
    if (!engineCaps(this.engine).orcaCompat || !this.orcaSchema.value?.options.curr_bed_type) return null;
    return Object.keys(this.bases.value.printer).some((k) => k.startsWith(ORCA_COMPAT_PREFIX)) ? this.orcaSchema.value : null;
  }

  /** The plate type option definition when this printer has plate types. */
  bedTypeDef(): ConfigOptionDef | null { return this.bedSchema()?.options.curr_bed_type ?? null; }

  /** Printer default_bed_type (native, or carried as an Orca compat value). */
  printerDefaultBedType(): string {
    return valueAt(this.value('printer', 'default_bed_type'), SCALAR) || valueAt(this.value('printer', ORCA_COMPAT_PREFIX + 'default_bed_type'), SCALAR) || '';
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

  /** The unsaved-edit bag of a tab. */
  overrideBag(kind: PresetKind, index = 0): PresetValues {
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

  /** The key has an unsaved edit; with `element`, that element of a vector differs from the preset. */
  isModified(kind: PresetKind, key: string, index = 0, element?: number): boolean {
    const ov = kind === 'filament' ? this.overrides.filaments[index] : this.overrides[kind];
    if (!ov || !(key in ov)) return false;
    return element === undefined || vedit.elementModified(this, kind, key, index, element);
  }

  /**
   * Set a tab value. A single value for a per-variant key whose preset has
   * several columns applies to every column.
   */
  setValue(kind: PresetKind, key: string, value: ConfigValue | undefined, index = 0): void {
    const bag = this.overrideBag(kind, index);
    if (value === undefined) delete bag[key];
    else {
      const v = vedit.spreadSingleValue(this, kind, key, normalizeValue(this.schema.value?.options[key], value), index);
      if (valuesEqual(v, this.presetValue(kind, key, index))) delete bag[key];
      else bag[key] = v;
    }
    this.afterEdit(kind, key);
  }

  revert(kind: PresetKind, key: string, index = 0): void { delete this.overrideBag(kind, index)[key]; this.afterEdit(kind, key); }

  // ---- per-variant editing (variantEdit.ts) ----

  /** Element of `key` the editor shows (the edited extruder's / filament's variant column); undefined = not per-variant. */
  variantElement(kind: PresetKind, key: string, index = 0, extruder?: number): number | undefined {
    return vedit.variantElement(this, kind, key, index, extruder);
  }
  setVariantElement(kind: PresetKind, key: string, index: number, element: number, v: string): void { vedit.setVariantElement(this, kind, key, index, element, v); }
  /** The full-width vector of a per-variant key with one element replaced (for callers that set it themselves). */
  variantVector(kind: PresetKind, key: string, index: number, element: number, v: string): string[] { return vedit.withElement(this, kind, key, index, element, v); }
  revertVariantElement(kind: PresetKind, key: string, index: number, element: number): void { vedit.revertVariantElement(this, kind, key, index, element); }
  variantTags(kind: PresetKind, index = 0) { return vedit.variantTags(this, kind, index); }
  syncVariantColumns(kind: 'process' | 'printer', from?: number): number { return vedit.syncVariantColumns(this, kind, from); }

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
      const cur = asList(this.value('printer', key));
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

  /**
   * Project values for the slice config: physical slots' own colours (mixed
   * slots are finished in resolve()), the plate type, each extruder's nozzle
   * flow type and the purge mode the printer can honour.
   */
  private projectForResolve(): PresetValues {
    const raw = toRaw(this.project);
    const project: PresetValues = { ...raw };
    const colours = slots.colourList(this, this.selection.filaments.length).map(slots.colourEntry);
    if (colours.some((c) => c.colour)) project.filament_colour = colours.map((c) => c.colour); else delete project.filament_colour;
    if (colours.some((c) => c.multi || c.type)) {
      project.filament_multi_colour = colours.map((c) => c.multi);
      project.filament_colour_type = colours.map((c) => c.type);
    } else for (const k of slots.COLOUR_SIDE_KEYS) delete project[k];
    const schema = this.schema.value;
    if (schema?.options.nozzle_volume_type) project.nozzle_volume_type = this.nozzleVolumeTypes();
    const stats = this.nozzleStats();
    if (stats) project.extruder_nozzle_stats = stats; else delete project.extruder_nozzle_stats;
    if (schema?.options.prime_volume_mode && raw.prime_volume_mode !== undefined) project.prime_volume_mode = this.purgeMode();
    const bed = this.bedType();
    if (!bed) return project;
    if (schema?.options.curr_bed_type) return { ...project, curr_bed_type: bed };
    const { curr_bed_type: _, ...rest } = project;
    return { ...rest, [ORCA_COMPAT_PREFIX + 'curr_bed_type']: bed };
  }

  resolve(): FlatConfig {
    const b = this.bases.value;
    const inf = this.infos.value;
    // A mixed slot is a filament slot with a copy of its first component's preset (Plater create_mixed_filament_from_result).
    const mixed = this.mixedFilaments();
    const last = Math.max(0, b.filaments.length - 1);
    const src = mixed.map((m) => Math.min(last, Math.max(0, (m.components[0] ?? 1) - 1)));
    const withMixed = <T>(phys: T[]): T[] => [...phys, ...src.map((i) => phys[i])];
    const ovs = toRaw(this.overrides.filaments).map((f) => toRaw(f));
    const cfg = resolveConfig({
      schema: this.schema.value,
      printer: b.printer,
      process: b.process,
      filaments: withMixed(b.filaments),
      overrides: { printer: toRaw(this.overrides.printer), process: toRaw(this.overrides.process), filaments: withMixed(ovs.map((f) => f ?? {})) },
      names: {
        printer: inf.printer.source === 'default' ? '' : inf.printer.name,
        process: inf.process.source === 'default' ? '' : inf.process.name,
        filaments: withMixed(inf.filaments.map((f) => (f.source === 'default' ? '' : f.name))),
      },
      // The plate type falls back to the printer / machine model default (bedType()).
      project: this.projectForResolve(),
    });
    const caps = engineCaps(this.engine);
    const nozzles = asList(cfg.nozzle_diameter).length;
    // The engine refuses a flush matrix that isn't (physical filaments)² × nozzles, and a project
    // without its own matrix (new / cleared) would send the default one: keep it sized (PresetBundle).
    const mk = caps.flush.matrix;
    if (caps.orcaConfig && b.filaments.length) {
      const flat = cfg[mk] === undefined ? [] : asList(cfg[mk]).map(Number);
      const fit = fitFlushMatrix(flat, b.filaments.length, nozzles);
      if (fit !== flat) cfg[mk] = fit.map((v) => String(v));
    }
    // filament_ids: each filament preset's filament_id (vendor start G-code tests it, e.g. Bambu A2L).
    if (this.schema.value?.options.filament_ids) cfg.filament_ids = withMixed(inf.filaments.map((f) => f.filamentId ?? ''));
    const out = withMixedSlots(cfg, b.filaments.length, mixed, caps.orcaConfig ? mk : null, nozzles);
    // PresetBundle::full_fff_config: filament numbers past the last slot are clamped / reset.
    if (caps.orcaConfig) clampFilamentIndexKeys(out, b.filaments.length + mixed.length);
    // filament_volume_map / filament_nozzle_map / flush_multiplier / rack sized as the engine requires.
    const schema = this.schema.value;
    return caps.orcaConfig && schema ? finishNozzleMaps(out, schema) : out;
  }

  // ---- user preset operations (userPresetOps.ts) -----------------------------------------------

  save(kind: PresetKind, index = 0): Promise<boolean> { return ops.save(this, kind, index); }
  saveAs(kind: PresetKind, name: string, index = 0): Promise<UserPreset> { return ops.saveAs(this, kind, name, index); }
  renamePreset(id: string, name: string): Promise<UserPreset> { return ops.renamePreset(this, id, name); }
  deletePreset(id: string): Promise<void> { return ops.deletePreset(this, id, DEFAULT_PRESET_ID); }
  exportPreset(kind: PresetKind, index = 0, flatten = false): Promise<{ filename: string; json: Record<string, unknown> }> {
    return ops.exportPreset(this, kind, index, flatten);
  }
  importFiles(files: Array<{ name: string; data: Uint8Array }>): Promise<ops.ImportReport> { return ops.importFiles(this, files); }
}
