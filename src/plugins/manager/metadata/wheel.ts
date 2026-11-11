/**
 * Port of OrcaSlicer's wheel plugin reader (PluginFsUtils.cpp
 * read_wheel_plugin_metadata): one .dist-info with METADATA / WHEEL / RECORD,
 * Name + Version required, entry package from Import-Name, an unambiguous
 * top_level.txt, or the normalized Name.
 *
 * Platform tags: Orca accepts `-none-any` or its own ABI + OS. In the browser
 * that means `-none-any` or a Pyodide build of this interpreter
 * (`cp312-cp312-pyodide_2024_0_wasm32`).
 */
import { unzipSync, strFromU8 } from 'fflate';
import { sanitizePluginName } from './pep723';

export const PYODIDE_ABI_TAG = 'cp312';
export const PYODIDE_PLATFORM = 'pyodide_2024_0_wasm32';

export interface WheelMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  requiresPython: string;
  dependencies: string[];
  entryPackage: string;
}

/** normalize_package_name: '-' and '.' → '_', lower case. */
export const normalizePackageName = (name: string): string => name.replace(/[-.]/g, '_').toLowerCase();

/** parse_metadata_rfc822 (headers only, continuation lines joined with '\n'). */
export function parseCoreMetadata(content: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let header = '', value = '';
  const flush = () => { if (header) (out[header.toLowerCase()] ??= []).push(value); header = ''; value = ''; };
  for (let line of content.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line && !header) continue;
    if (!line) { flush(); break; }
    if (line[0] === ' ' || line[0] === '\t') { if (value) value += '\n'; value += line.replace(/^[ \t]+/, ''); continue; }
    flush();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    header = line.slice(0, colon);
    value = line.slice(colon + 1).replace(/^[ \t]+/, '');
  }
  flush();
  return out;
}

const text = (files: Record<string, Uint8Array>, path: string): string => {
  const f = files[path];
  if (!f) throw new Error(`Wheel does not contain ${path}`);
  return strFromU8(f);
};

export function readWheelMetadata(bytes: Uint8Array): WheelMetadata {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch (e) { throw new Error(`Failed to open wheel as zip: ${(e as Error).message}`); }
  let distInfo = '';
  for (const raw of Object.keys(files)) {
    const name = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    const pos = name.indexOf('.dist-info');
    if (pos < 0) continue;
    let candidate: string;
    if (pos + 10 === name.length) candidate = name + '/';
    else if (name[pos + 10] === '/') candidate = name.slice(0, pos + 11);
    else continue;
    if (distInfo && candidate !== distInfo) throw new Error(`Wheel contains multiple .dist-info directories: ${distInfo} and ${candidate}`);
    distInfo = candidate;
  }
  if (!distInfo) throw new Error('Wheel does not contain a .dist-info directory');
  const meta = parseCoreMetadata(text(files, distInfo + 'METADATA'));
  const first = (k: string) => meta[k]?.[meta[k].length - 1] ?? '';
  const name = first('name'), version = first('version');
  if (!name) throw new Error('Wheel METADATA missing required Name field');
  if (!version) throw new Error('Wheel METADATA missing required Version field');
  const wheel = text(files, distInfo + 'WHEEL');
  if (!wheel.includes('Wheel-Version:')) throw new Error('Wheel WHEEL file missing Wheel-Version header');
  const tags = wheel.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.startsWith('Tag:')).map((l) => l.slice(4).trim());
  if (tags.length && !tags.some((t) => t.includes('-none-any') || (t.startsWith(PYODIDE_ABI_TAG) && t.includes(PYODIDE_PLATFORM)))) {
    throw new Error(`Wheel is incompatible with this platform. Tags: ${tags.join(', ')}; expected ABI: ${PYODIDE_ABI_TAG} (${PYODIDE_PLATFORM})`);
  }
  const record = text(files, distInfo + 'RECORD');
  if (!record) throw new Error('Wheel RECORD file is empty');
  let topLevel = '';
  const tl = files[distInfo + 'top_level.txt'];
  if (tl) {
    const names = strFromU8(tl).split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
    if (names.length === 1) topLevel = names[0];
  }
  return {
    name: sanitizePluginName(name), version,
    description: first('summary'), author: first('author'), requiresPython: first('requires-python'),
    dependencies: meta['requires-dist'] ?? [],
    entryPackage: first('import-name') || topLevel || normalizePackageName(name),
  };
}

/** Whether a wheel file name is installable here (pure Python or built for this Pyodide). */
export function wheelFileCompatible(fileName: string): boolean {
  const stem = fileName.replace(/\.whl$/i, '');
  return /-none-any$/.test(stem) || stem.endsWith(`-${PYODIDE_PLATFORM}`);
}
