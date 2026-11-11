/**
 * Zip helpers shared by the 3MF readers: one unzip per file opened, with entry
 * lookup the way Orca does it (case-insensitive, leading '/' and URL escapes
 * ignored).
 */
import { unzipSync, type Unzipped, type UnzipFileInfo } from 'fflate';
import { ImportError } from '../mesh';

export type Archive = Unzipped;

export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('/')) s = s.slice(1);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s;
}

/** The archive key of `path` (case-insensitive), if present. */
export function findEntry(files: Archive, path: string): string | undefined {
  const want = normPath(path).toLowerCase();
  if (files[want]) return want;
  return Object.keys(files).find((k) => k.toLowerCase() === want);
}

export function entryBytes(files: Archive, path: string): Uint8Array | undefined {
  const k = findEntry(files, path);
  return k === undefined ? undefined : files[k];
}

/** Unzip (optionally only the entries `filter` accepts); a broken zip is an ImportError. */
export function unzipArchive(data: ArrayBuffer | Uint8Array, filter?: (f: UnzipFileInfo) => boolean): Archive {
  try {
    return unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data), filter ? { filter } : undefined);
  } catch (e) {
    throw new ImportError(`Not a valid 3MF (zip) file: ${(e as Error).message}`);
  }
}
