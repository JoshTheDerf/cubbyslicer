/**
 * Port of OrcaSlicer's PEP 723 reader for single-file `.py` plugins
 * (PluginFsUtils.cpp read_python_plugin_metadata + parse_pep723_toml): the same
 * hand-written TOML subset, so a header Orca accepts is read the same way here.
 */

export interface Pep723Metadata {
  dependencies: string[];
  requiresPython: string;
  name: string;
  description: string;
  author: string;
  version: string;
}

/** Orca escapes ';' in display names (they go into ';'-delimited preset strings). */
export const sanitizePluginName = (name: string): string => name.replace(/;/g, '_');

const unquote = (v: string): string =>
  v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) ? v.slice(1, -1) : v;

/** One line of a TOML array; returns true when the array closes on it. */
function readArrayItems(line: string, items: string[]): boolean {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ']') return true;
    if (c === '#') return false;
    if (c === ' ' || c === '\t' || c === ',') { i++; continue; }
    let item = '';
    if (c === '"' || c === "'") {
      for (i++; i < line.length && line[i] !== c; i++) {
        if (c === '"' && line[i] === '\\' && i + 1 < line.length) i++;
        item += line[i];
      }
      i++;
    } else {
      let end = line.length;
      for (const ch of [' ', '\t', ',', ']', '#']) { const p = line.indexOf(ch, i); if (p >= 0 && p < end) end = p; }
      item = line.slice(i, end);
      i = end;
    }
    if (item) items.push(item);
  }
  return false;
}

/** parse_pep723_toml. Throws Error("PEP 723 metadata: unclosed dependencies array"). */
export function parsePep723Toml(toml: string): Pep723Metadata {
  const out: Pep723Metadata = { dependencies: [], requiresPython: '', name: '', description: '', author: '', version: '' };
  type Section = 'root' | 'plugin' | 'settings' | 'deps';
  let section: Section = 'root';
  for (const raw of toml.split('\n')) {
    const t = raw.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!t || t[0] === '#') continue;
    if (t[0] === '[') {
      section = t === '[tool.orcaslicer.plugin]' ? 'plugin' : t === '[tool.orcaslicer.plugin.settings]' ? 'settings' : 'root';
      continue;
    }
    if (section === 'deps') { if (readArrayItems(t, out.dependencies)) section = 'root'; continue; }
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).replace(/[ \t]+$/, '');
    const val = t.slice(eq + 1).replace(/^[ \t]+|[ \t]+$/g, '');
    if (section === 'root') {
      if (key === 'requires-python') out.requiresPython = unquote(val);
      else if (key === 'dependencies') {
        out.dependencies = [];
        const array = val[0] === '[';
        if (!readArrayItems(array ? val.slice(1) : val, out.dependencies) && array) section = 'deps';
      }
    } else if (section === 'plugin') {
      if (key === 'name') out.name = unquote(val);
      else if (key === 'description') out.description = unquote(val);
      else if (key === 'author') out.author = unquote(val);
      else if (key === 'version') out.version = unquote(val);
    }
  }
  if (section === 'deps') throw new Error('PEP 723 metadata: unclosed dependencies array');
  return out;
}

/** The `# /// script` … `# ///` block of a source file, as TOML text ('' when absent). */
export function extractPep723Block(source: string): string {
  let inBlock = false;
  let content = '';
  for (let line of source.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!inBlock) { if (line === '# /// script') inBlock = true; continue; }
    if (line === '# ///') { inBlock = false; continue; }
    if (line.length >= 2 && line[0] === '#' && (line[1] === ' ' || line[1] === '\t')) content += line.slice(2) + '\n';
    else if (line === '#') content += '\n';
  }
  return content;
}

/** read_python_plugin_metadata: identity fields + dependencies (all optional, as Orca). */
export function readPythonPluginMetadata(source: string): Pep723Metadata {
  const block = extractPep723Block(source);
  if (!block) return { dependencies: [], requiresPython: '', name: '', description: '', author: '', version: '' };
  let m: Pep723Metadata;
  try { m = parsePep723Toml(block); } catch (e) { throw new Error(`Failed to parse PEP 723 metadata: ${(e as Error).message}`); }
  return { ...m, name: m.name ? sanitizePluginName(m.name) : '' };
}
