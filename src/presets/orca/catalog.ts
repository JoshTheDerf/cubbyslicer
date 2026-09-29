/**
 * OrcaSlicer vendor-tree catalog.
 *
 *   profiles/_index.json               ["BBL", "Creality", ...]      (vendor ids = file basenames)
 *   profiles/<Vendor>.json             { name, machine_model_list, machine_list, process_list, filament_list }
 *   profiles/<Vendor>/<sub_path>       one preset JSON ({type, name, inherits, instantiation, ...settings})
 *
 * Resolution mirrors PresetBundle::load_vendor_configs_from_json: `inherits`
 * names a preset of the same vendor and collection; filaments that don't find
 * their parent in the vendor fall back to the OrcaFilamentLibrary vendor
 * (PresetBundle::ORCA_FILAMENT_LIBRARY, loaded first as the base bundle).
 * Preset files are fetched lazily and cached per URL.
 */
import type { EngineId } from '../../engine/types';
import { flattenInherits, infoMetaFrom, toPresetValues, type RawPreset } from '../inherit';
import type { BedAssets, MachineModel, PresetCatalog, PresetInfo, PresetKind, PresetValues, VendorInfo } from '../types';
import { encodePath, fetchJson, isRecord, mapLimit, profileBase, str, type JsonFetcher } from '../util';

/** Orca's shared filament library vendor (PresetBundle::ORCA_FILAMENT_LIBRARY). */
export const ORCA_FILAMENT_LIBRARY = 'OrcaFilamentLibrary';

type ListKey = 'machine_list' | 'process_list' | 'filament_list';
const LIST_OF: Record<PresetKind, ListKey> = { printer: 'machine_list', process: 'process_list', filament: 'filament_list' };

interface VendorIndexEntry { name: string; sub_path: string }
interface VendorIndex {
  id: string;
  name: string;
  description?: string;
  machine_model_list: VendorIndexEntry[];
  machine_list: VendorIndexEntry[];
  process_list: VendorIndexEntry[];
  filament_list: VendorIndexEntry[];
  /** name → sub_path per list. */
  byName: Record<ListKey, Map<string, string>>;
}

export interface OrcaCatalogOptions {
  engine?: EngineId;
  /** URL prefix of the profile tree (default `<BASE_URL>wasm/orca/profiles`). */
  base?: string;
  fetcher?: JsonFetcher;
  /** Max parallel preset fetches. */
  concurrency?: number;
  /** Shared library vendor used as inheritance fallback for filaments. */
  libraryVendor?: string;
  /** Try `_bundles/<Vendor>.json` before per-file fetches (default true). */
  bundles?: boolean;
}

export function sysId(vendor: string, name: string): string { return `sys:${vendor}/${name}`; }
export function parseSysId(id: string): { vendor: string; name: string } | null {
  if (!id.startsWith('sys:')) return null;
  const rest = id.slice(4);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return { vendor: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

function entries(v: unknown): VendorIndexEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is VendorIndexEntry => isRecord(e) && typeof e.name === 'string' && typeof e.sub_path === 'string');
}

export class OrcaCatalog implements PresetCatalog {
  readonly engine: EngineId;
  private readonly base: string;
  private readonly fetcher: JsonFetcher;
  private readonly concurrency: number;
  private readonly library: string;
  private vendorIds: Promise<string[]> | null = null;
  private readonly vendorCache = new Map<string, Promise<VendorIndex | null>>();
  private readonly fileCache = new Map<string, Promise<RawPreset | null>>();
  private readonly bundleCache = new Map<string, Promise<Map<string, RawPreset> | null>>();
  private readonly useBundles: boolean;
  private readonly resolvedCache = new Map<string, Promise<{ values: Record<string, unknown>; leaf: RawPreset } | null>>();
  private readonly infoCache = new Map<string, Promise<PresetInfo | null>>();

  constructor(opts: OrcaCatalogOptions = {}) {
    this.engine = opts.engine ?? 'orca';
    this.base = (opts.base ?? profileBase(this.engine)).replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetchJson;
    this.concurrency = opts.concurrency ?? 12;
    this.library = opts.libraryVendor ?? ORCA_FILAMENT_LIBRARY;
    this.useBundles = opts.bundles ?? true;
  }

  // ---- vendor indexes ------------------------------------------------------

  private listVendorIds(): Promise<string[]> {
    this.vendorIds ??= (async () => {
      const raw = await this.fetcher(`${this.base}/_index.json`);
      if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
      if (isRecord(raw) && Array.isArray(raw.vendors)) return (raw.vendors as unknown[]).map((v) => (isRecord(v) ? str(v.id ?? v.name) : str(v))).filter(Boolean);
      return [];
    })();
    return this.vendorIds;
  }

  vendor(id: string): Promise<VendorIndex | null> {
    let p = this.vendorCache.get(id);
    if (!p) {
      p = (async () => {
        const raw = await this.fetcher(`${this.base}/${encodePath(id)}.json`);
        if (!isRecord(raw)) return null;
        const v: VendorIndex = {
          id,
          name: str(raw.name) || id,
          description: str(raw.description) || undefined,
          machine_model_list: entries(raw.machine_model_list),
          machine_list: entries(raw.machine_list),
          process_list: entries(raw.process_list),
          filament_list: entries(raw.filament_list),
          byName: { machine_list: new Map(), process_list: new Map(), filament_list: new Map() },
        };
        for (const k of ['machine_list', 'process_list', 'filament_list'] as const) {
          for (const e of v[k]) if (!v.byName[k].has(e.name)) v.byName[k].set(e.name, e.sub_path);
        }
        return v;
      })();
      this.vendorCache.set(id, p);
    }
    return p;
  }

  /**
   * Optional per-vendor bundle `profiles/_bundles/<Vendor>.json` ({ sub_path: preset JSON }),
   * written by scripts/dev/build-profile-bundles.mjs at staging time: one request per vendor
   * instead of hundreds. Missing bundle → per-file fetches.
   */
  private bundle(vendor: string): Promise<Map<string, RawPreset> | null> {
    let p = this.bundleCache.get(vendor);
    if (!p) {
      p = this.fetcher(`${this.base}/_bundles/${encodePath(vendor)}.json`).then((raw) => {
        if (!isRecord(raw)) return null;
        const m = new Map<string, RawPreset>();
        for (const [k, v] of Object.entries(raw)) if (isRecord(v)) m.set(k, v);
        return m;
      });
      this.bundleCache.set(vendor, p);
    }
    return p;
  }

  private async file(vendor: string, subPath: string): Promise<RawPreset | null> {
    if (this.useBundles) {
      const b = await this.bundle(vendor);
      const hit = b?.get(subPath);
      if (hit) return hit;
    }
    const url = `${this.base}/${encodePath(vendor)}/${encodePath(subPath)}`;
    let p = this.fileCache.get(url);
    if (!p) {
      p = this.fetcher(url).then((r) => (isRecord(r) ? r : null));
      this.fileCache.set(url, p);
    }
    return p;
  }

  private async raw(vendor: string, kind: PresetKind, name: string): Promise<RawPreset | null> {
    const v = await this.vendor(vendor);
    const sub = v?.byName[LIST_OF[kind]].get(name);
    return sub ? this.file(vendor, sub) : null;
  }

  /** Locate an inherits parent: same vendor/collection, then the filament library. */
  private async parent(vendor: string, kind: PresetKind, ref: string): Promise<{ vendor: string; raw: RawPreset } | null> {
    const own = await this.raw(vendor, kind, ref);
    if (own) return { vendor, raw: own };
    if (kind === 'filament' && vendor !== this.library) {
      const lib = await this.raw(this.library, kind, ref);
      if (lib) return { vendor: this.library, raw: lib };
    }
    return null;
  }

  private resolveRaw(id: string, kind: PresetKind): Promise<{ values: Record<string, unknown>; leaf: RawPreset } | null> {
    const key = `${kind}|${id}`;
    let p = this.resolvedCache.get(key);
    if (!p) {
      p = (async () => {
        const sid = parseSysId(id);
        if (!sid) return null;
        const leaf = await this.raw(sid.vendor, kind, sid.name);
        if (!leaf) return null;
        let curVendor = sid.vendor;
        const res = await flattenInherits(leaf, async (ref) => {
          const found = await this.parent(curVendor, kind, ref);
          if (found) curVendor = found.vendor;
          return found?.raw ?? null;
        }, sid.name);
        return { values: res.values, leaf };
      })();
      this.resolvedCache.set(key, p);
    }
    return p;
  }

  // ---- PresetCatalog -------------------------------------------------------

  async vendors(): Promise<VendorInfo[]> {
    const ids = await this.listVendorIds();
    const all = await mapLimit(ids, this.concurrency, (id) => this.vendor(id));
    return all
      .filter((v): v is VendorIndex => !!v && v.machine_list.length > 0 && v.id !== this.library)
      .map((v) => ({ id: v.id, name: v.name, description: v.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async models(vendorId: string): Promise<MachineModel[]> {
    const v = await this.vendor(vendorId);
    if (!v) return [];
    const printers = await mapLimit(v.machine_list, this.concurrency, async (e) => {
      const leaf = await this.file(vendorId, e.sub_path);
      if (!leaf || str(leaf.instantiation) === 'false') return null;
      return this.info(sysId(vendorId, e.name), 'printer');
    });
    const models = await mapLimit(v.machine_model_list, this.concurrency, async (e) => {
      const raw = await this.file(vendorId, e.sub_path);
      const name = str(raw?.name) || e.name;
      return {
        vendor: vendorId,
        name,
        nozzles: str(raw?.nozzle_diameter).split(';').map((s) => s.trim()).filter(Boolean),
        family: str(raw?.family) || undefined,
        coverUrl: `${this.base}/${encodePath(vendorId)}/${encodePath(`${name}_cover.png`)}`,
        variants: [],
      } as MachineModel;
    });
    const byModel = new Map(models.map((m) => [m.name, m]));
    for (const p of printers) {
      if (!p) continue;
      const modelName = p.printerModel ?? p.name;
      let m = byModel.get(modelName);
      if (!m) { m = { vendor: vendorId, name: modelName, nozzles: [], variants: [] }; byModel.set(modelName, m); models.push(m); }
      m.variants.push({ preset: p, variant: p.printerVariant ?? p.name });
    }
    for (const m of models) m.variants.sort((a, b) => Number(a.variant) - Number(b.variant) || a.variant.localeCompare(b.variant));
    return models.filter((m) => m.variants.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  }

  async modelDefaultBedType(vendorId: string, model: string): Promise<string | null> {
    const v = await this.vendor(vendorId);
    const e = v?.machine_model_list.find((m) => m.name === model);
    if (!e) return null;
    const raw = await this.file(vendorId, e.sub_path);
    return str(raw?.default_bed_type) || null;
  }

  async modelBedAssets(vendorId: string, model: string): Promise<BedAssets | null> {
    const v = await this.vendor(vendorId);
    const e = v?.machine_model_list.find((m) => m.name === model);
    if (!e) return null;
    const raw = await this.file(vendorId, e.sub_path);
    const url = (f: string) => `${this.base}/${encodePath(vendorId)}/${encodePath(f)}`;
    const m = str(raw?.bed_model), t = str(raw?.bed_texture);
    const out: BedAssets = {};
    if (/\.stl$/i.test(m) && !/[\\/]/.test(m)) out.model = url(m);
    if (/\.(svg|png)$/i.test(t) && !/[\\/]/.test(t)) out.texture = url(t);
    return out.model || out.texture ? out : null;
  }

  info(id: string, kind: PresetKind): Promise<PresetInfo | null> {
    const key = `${kind}|${id}`;
    let p = this.infoCache.get(key);
    if (!p) {
      p = (async () => {
        const sid = parseSysId(id);
        if (!sid) return null;
        const r = await this.resolveRaw(id, kind);
        if (!r) return null;
        return {
          id, kind, name: sid.name, source: 'system', vendor: sid.vendor,
          fromLibrary: sid.vendor === this.library,
          ...infoMetaFrom(r.values, sid.name, r.leaf),
        } as PresetInfo;
      })();
      this.infoCache.set(key, p);
    }
    return p;
  }

  async candidates(kind: 'process' | 'filament', printer: PresetInfo | null): Promise<PresetInfo[]> {
    const vendorId = printer?.vendor;
    const load = async (vid: string): Promise<PresetInfo[]> => {
      const v = await this.vendor(vid);
      if (!v) return [];
      const infos = await mapLimit(v[LIST_OF[kind]], this.concurrency, async (e) => {
        const leaf = await this.file(vid, e.sub_path);
        if (!leaf || str(leaf.instantiation) === 'false') return null;
        return this.info(sysId(vid, e.name), kind);
      });
      return infos.filter((x): x is PresetInfo => !!x);
    };
    const own = vendorId && vendorId !== this.library ? await load(vendorId) : [];
    if (kind !== 'filament') return own;
    const lib = await load(this.library);
    // PresetCollection::update_library_profile_excluded_from: a library preset with
    // empty compatible_printers is hidden for printers that a same-alias vendor preset targets.
    const byAlias = new Map<string, Set<string>>();
    for (const p of own) {
      if (!p.alias || !p.compatiblePrinters?.length) continue;
      let s = byAlias.get(p.alias);
      if (!s) byAlias.set(p.alias, (s = new Set()));
      for (const n of p.compatiblePrinters) s.add(n);
    }
    const libOut = lib.map((p) => {
      const ex = p.alias && !p.compatiblePrinters?.length ? byAlias.get(p.alias) : undefined;
      return ex ? { ...p, excludedPrinters: [...ex] } : p;
    });
    return [...own, ...libOut];
  }

  async resolve(id: string, kind: PresetKind): Promise<PresetValues | null> {
    const r = await this.resolveRaw(id, kind);
    return r ? toPresetValues(r.values) : null;
  }

  async findByName(kind: PresetKind, name: string, vendorHint?: string): Promise<PresetInfo | null> {
    const tryVendor = async (vid: string) => {
      const v = await this.vendor(vid);
      return v?.byName[LIST_OF[kind]].has(name) ? this.info(sysId(vid, name), kind) : null;
    };
    if (vendorHint) { const r = await tryVendor(vendorHint); if (r) return r; }
    if (kind === 'filament') { const r = await tryVendor(this.library); if (r) return r; }
    const ids = await this.listVendorIds();
    const idx = await mapLimit(ids, this.concurrency, (id) => this.vendor(id));
    for (const v of idx) if (v?.byName[LIST_OF[kind]].has(name)) return this.info(sysId(v.id, name), kind);
    return null;
  }

  /** Raw leaf JSON (unflattened) — for export "as system file". */
  async rawLeaf(id: string, kind: PresetKind): Promise<RawPreset | null> {
    const sid = parseSysId(id);
    return sid ? this.raw(sid.vendor, kind, sid.name) : null;
  }

}
