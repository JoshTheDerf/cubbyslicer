/**
 * Plug-in point for other feature areas (e.g. presets) to include their own
 * state in saved project files. Sections are opaque JSON-able blobs.
 */
export interface ProjectSection {
  save(): unknown;
  load(data: unknown): void;
  /** Called on "New project" (optional). */
  reset?(): void;
}

const sections = new Map<string, ProjectSection>();

export function registerProjectSection(name: string, section: ProjectSection): () => void {
  sections.set(name, section);
  return () => { if (sections.get(name) === section) sections.delete(name); };
}

export function saveSections(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, s] of sections) {
    try { out[name] = s.save(); } catch (e) { console.warn(`[project] section "${name}" failed to save`, e); }
  }
  return out;
}

export function loadSections(data: Record<string, unknown> | undefined): string[] {
  const failed: string[] = [];
  if (!data || typeof data !== 'object') return failed;
  for (const [name, s] of sections) {
    if (!(name in data)) continue;
    try { s.load(data[name]); } catch (e) { failed.push(name); console.warn(`[project] section "${name}" failed to load`, e); }
  }
  return failed;
}

export function resetSections(): void {
  for (const s of sections.values()) { try { s.reset?.(); } catch { /* ignore */ } }
}
