/**
 * preFlight catalog.
 *
 * v1.3.0 ships only `profiles/orca_system_profiles.json`: a flat Orca-format
 * bundle `{ "<key>": { type, inherits (by key), instantiation, ...orca keys } }`
 * with filament presets. Printer and print presets then come from the engine
 * defaults + user presets.
 *
 * Defensive about future staging (ENGINE-CONTRACT.md "Profiles"):
 *   - `profiles/_index.json` may list extra flat bundles (`*.json` entries) and/or
 *     Orca-style vendor ids (`<Vendor>.json` + `<Vendor>/…` tree) — the latter are
 *     served through an embedded OrcaCatalog.
 *   - bundle entries of any `type` (machine/printer, process/print, filament) are used.
 * Orca-keyed values are converted to preFlight keys (see ./convert.ts).
 *
 * `orcaLibraryBase` points the vendor tree at the Orca engine's staged profile
 * library (Bambu, Creality, Elegoo, Anycubic, … — ~130 vendors) instead of a
 * copy under preFlight's own profiles: the same files serve both engines and
 * every printer / process / filament is converted to preFlight keys on
 * resolve, as preFlight's own "Import Orca bundle" does.
 */
import type { ConfigSchema, EngineId } from '../../engine/types';
import { flattenInheritsSync, infoMetaFrom, toPresetValues, type RawPreset } from '../inherit';
import { OrcaCatalog } from '../orca/catalog';
import { kindFromJsonType, type BedAssets, type MachineModel, type PresetCatalog, type PresetInfo, type PresetKind, type PresetValues, type VendorInfo } from '../types';
import { encodePath, fetchJson, isRecord, profileBase, str, type JsonFetcher } from '../util';
import { orcaCompatValues, orcaToPreflight } from './convert';

export const DEFAULT_PREFLIGHT_BUNDLES = ['orca_system_profiles.json'];

interface Bundle { id: string; entries: Map<string, RawPreset> }

export interface PreflightCatalogOptions {
  engine?: EngineId;
  base?: string;
  fetcher?: JsonFetcher;
  /** Whether a key is defined by the preFlight schema (drives key conversion). */
  isNativeKey?: (key: string) => boolean;
  /** Whether a preFlight schema option is a per-extruder vector (G-code placeholder fix-up). */
  isVectorKey?: (key: string) => boolean;
  /** Orca profile tree (`<vendor>.json` + `<vendor>/…`) to expose as preFlight vendors. */
  orcaLibraryBase?: string;
  /** Orca's config schema: its defaults complete library presets before conversion. */
  orcaSchema?: () => Promise<ConfigSchema | null>;
}

const bundleId = (bundle: string, key: string) => `sys:${bundle}/${key}`;

export class PreflightCatalog implements PresetCatalog {
  readonly engine: EngineId;
  private readonly base: string;
  private readonly fetcher: JsonFetcher;
  private readonly isNative: (key: string) => boolean;
  private readonly isVector: ((key: string) => boolean) | undefined;
  private index: Promise<{ bundles: string[]; vendors: string[] }> | null = null;
  private bundles: Promise<Bundle[]> | null = null;
  private tree: OrcaCatalog | null = null;
  private readonly orcaLibraryBase: string | undefined;
  private readonly orcaSchema: (() => Promise<ConfigSchema | null>) | undefined;

  constructor(opts: PreflightCatalogOptions = {}) {
    this.engine = opts.engine ?? 'preflight';
    this.base = (opts.base ?? profileBase(this.engine)).replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetchJson;
    this.isNative = opts.isNativeKey ?? (() => true);
    this.isVector = opts.isVectorKey;
    this.orcaLibraryBase = opts.orcaLibraryBase?.replace(/\/$/, '');
    this.orcaSchema = opts.orcaSchema;
  }

  private loadIndex() {
    this.index ??= (async () => {
      const raw = await this.fetcher(`${this.base}/_index.json`);
      const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string')
        : isRecord(raw) && Array.isArray(raw.bundles) ? (raw.bundles as unknown[]).map(str) : [];
      // The default bundle is always staged; _index.json lists extras.
      const bundles = [...new Set([...DEFAULT_PREFLIGHT_BUNDLES, ...list.filter((x) => /\.json$/i.test(x))])];
      const vendors = list.filter((x) => !/\.json$/i.test(x));
      if (this.orcaLibraryBase) {
        // The Orca library has its own _index.json (vendor ids) and _bundles/.
        this.tree = new OrcaCatalog({ engine: this.engine, base: this.orcaLibraryBase, fetcher: this.fetcher });
      } else if (vendors.length) {
        const ids = vendors;
        this.tree = new OrcaCatalog({
          engine: this.engine, base: this.base,
          fetcher: (url) => (url.endsWith('/_index.json') ? Promise.resolve(ids) : this.fetcher(url)),
        });
      }
      return { bundles, vendors };
    })();
    return this.index;
  }

  private loadBundles(): Promise<Bundle[]> {
    this.bundles ??= (async () => {
      const { bundles } = await this.loadIndex();
      const out: Bundle[] = [];
      for (const b of bundles) {
        const raw = await this.fetcher(`${this.base}/${encodePath(b)}`);
        if (!isRecord(raw)) continue;
        const entries = new Map<string, RawPreset>();
        for (const [k, v] of Object.entries(raw)) if (isRecord(v)) entries.set(k, v);
        out.push({ id: b, entries });
      }
      return out;
    })();
    return this.bundles;
  }

  private async locate(id: string): Promise<{ bundle: Bundle; key: string; raw: RawPreset } | null> {
    if (!id.startsWith('sys:')) return null;
    for (const b of await this.loadBundles()) {
      const prefix = `sys:${b.id}/`;
      if (!id.startsWith(prefix)) continue;
      const key = id.slice(prefix.length);
      const raw = b.entries.get(key);
      return raw ? { bundle: b, key, raw } : null;
    }
    return null;
  }

  private async flatten(bundle: Bundle, key: string, raw: RawPreset): Promise<Record<string, unknown>> {
    const all = await this.loadBundles();
    const byName = (ref: string): RawPreset | null => {
      const own = bundle.entries.get(ref);
      if (own) return own;
      for (const b of all) {
        const e = b.entries.get(ref);
        if (e) return e;
        for (const v of b.entries.values()) if (v.name === ref) return v;
      }
      return null;
    };
    return flattenInheritsSync(raw, byName, key).values;
  }

  private kindOf(raw: RawPreset): PresetKind {
    return kindFromJsonType(raw.type) ?? 'filament';
  }

  async vendors(): Promise<VendorInfo[]> {
    await this.loadIndex();
    return this.tree ? this.tree.vendors() : [];
  }

  async models(vendorId: string): Promise<MachineModel[]> {
    await this.loadIndex();
    return this.tree ? this.tree.models(vendorId) : [];
  }

  async modelDefaultBedType(vendorId: string, model: string): Promise<string | null> {
    await this.loadIndex();
    return this.tree?.modelDefaultBedType ? this.tree.modelDefaultBedType(vendorId, model) : null;
  }

  async modelBedAssets(vendorId: string, model: string): Promise<BedAssets | null> {
    await this.loadIndex();
    return this.tree?.modelBedAssets ? this.tree.modelBedAssets(vendorId, model) : null;
  }

  async info(id: string, kind: PresetKind): Promise<PresetInfo | null> {
    const loc = await this.locate(id);
    if (!loc) { await this.loadIndex(); return this.tree ? this.tree.info(id, kind) : null; }
    if (this.kindOf(loc.raw) !== kind) return null;
    const values = await this.flatten(loc.bundle, loc.key, loc.raw);
    const name = str(loc.raw.name) || loc.key;
    return { id, kind, name, source: 'system', vendor: loc.bundle.id, ...infoMetaFrom(values, name, loc.raw) };
  }

  async candidates(kind: 'process' | 'filament', printer: PresetInfo | null): Promise<PresetInfo[]> {
    const out: PresetInfo[] = [];
    for (const b of await this.loadBundles()) {
      for (const [key, raw] of b.entries) {
        if (this.kindOf(raw) !== kind || str(raw.instantiation) === 'false') continue;
        const info = await this.info(bundleId(b.id, key), kind);
        if (info) out.push(info);
      }
    }
    await this.loadIndex();
    if (this.tree) {
      // preFlight's own (tuned) system filaments win over same-named library ones.
      const seen = new Set(out.map((p) => p.name));
      for (const p of await this.tree.candidates(kind, printer)) if (!seen.has(p.name)) out.push(p);
    }
    return out;
  }

  async resolve(id: string, kind: PresetKind): Promise<PresetValues | null> {
    const loc = await this.locate(id);
    if (!loc) {
      await this.loadIndex();
      const v = this.tree ? await this.tree.resolve(id, kind) : null;
      if (!v) return null;
      // A library preset only lists what differs from Orca's defaults; preFlight's
      // defaults differ (relative E, flavor, machine limits, …), so complete it
      // with Orca's own before converting — otherwise it isn't the same printer.
      const schema = this.orcaSchema ? await this.orcaSchema().catch(() => null) : null;
      return { ...orcaToPreflight(kind, v, this.isNative, this.isVector, schema), ...orcaCompatValues(kind, v, this.isNative, schema) };
    }
    const values = toPresetValues(await this.flatten(loc.bundle, loc.key, loc.raw));
    return orcaToPreflight(kind, values, this.isNative, this.isVector);
  }

  async findByName(kind: PresetKind, name: string): Promise<PresetInfo | null> {
    for (const b of await this.loadBundles()) {
      for (const [key, raw] of b.entries) {
        if ((raw.name === name || key === name) && this.kindOf(raw) === kind) return this.info(bundleId(b.id, key), kind);
      }
    }
    await this.loadIndex();
    return this.tree ? this.tree.findByName(kind, name) : null;
  }
}
