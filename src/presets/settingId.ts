/**
 * Orca 2.5 `generate_preset_setting_id` (Preset.cpp; scripts/orca_profile_tool.py): the id a system
 * preset gets when its profile ships without a `setting_id` and it is instantiated
 * (PresetBundle::load_vendor_configs_from_json). uuid5(namespace, "<vendor>/<type>/<name>"), then the
 * low 16 base62 digits of the 128-bit value, most-significant first. A published 3MF identifies the
 * author's filament by it (the setting-id tier of the published candidate score).
 */
const NAMESPACE = 'c1f4d9e2-7a3b-5c8d-9e0f-1a2b3c4d5e6f';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Preset::get_type_string. */
export const SETTING_ID_TYPE = { filament: 'filament', process: 'process', printer: 'machine' } as const;

function uuidBytes(u: string): Uint8Array {
  const hex = u.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** boost name_generator_sha1 / Python uuid.uuid5: SHA-1(namespace ‖ name), version 5, RFC 4122 variant. */
async function uuid5(namespace: string, name: string): Promise<Uint8Array> {
  const ns = uuidBytes(namespace);
  const nb = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nb.length);
  buf.set(ns); buf.set(nb, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h;
}

export async function generatePresetSettingId(vendor: string, type: string, name: string): Promise<string> {
  if (!vendor || !name) return '';
  let n = 0n;
  for (const b of await uuid5(NAMESPACE, `${vendor}/${type}/${name}`)) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i++) { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; }
  return out;
}
