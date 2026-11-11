/**
 * Orca's INI reader (ConfigBase::load_from_ini / load_from_ini_string, which
 * use boost::property_tree::read_ini): one "key = value" per line, both sides
 * trimmed, ';' and '#' start comment lines, "[section]" keys are not
 * top-level options (Orca ignores them). A line without '=', an empty key or a
 * duplicate key makes the whole text unreadable (read_ini throws): null.
 */
export function readOrcaIni(text: string): Record<string, string> | null {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  let section: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    if (line[0] === '[') {
      const end = line.indexOf(']');
      if (end < 0) return null;
      section = line.slice(1, end).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) return null;
    const key = line.slice(0, eq).trim();
    if (!key) return null;
    const scoped = section === null ? key : `[${section}]${key}`;
    if (seen.has(scoped)) return null;
    seen.add(scoped);
    if (section === null) out[key] = line.slice(eq + 1).trim();
  }
  return { ...out };
}
