/**
 * Wiki links on settings rows (Orca OptionsGroup::get_url): a row whose Tab.cpp line has a
 * `label_path` links its label to https://www.orcaslicer.com/wiki/<path>; the Speed Dial's
 * "Wiki (F1)" on a setting opens the same page (ActionRegistry: help_url = get_url(wiki_path)).
 * The paths come from ./layout/orcaWiki.generated.ts. Orca 2.5's get_url lower-cases the
 * anchor into a local it then doesn't use, so the path goes into the URL as written.
 */
import type { EngineId } from '../engine/types';
import { orcaWikiPaths } from './layout/orcaWiki.generated';

export const ORCA_WIKI_BASE = 'https://www.orcaslicer.com/wiki/';

/** Per engine: wiki base and key → path (preFlight's Tab has no Orca wiki paths). */
const WIKIS: Partial<Record<EngineId, { base: string; paths: Record<string, string> }>> = {
  orca: { base: ORCA_WIKI_BASE, paths: orcaWikiPaths },
};

/** The wiki page of a setting row, or undefined (no path, or an engine without one). */
export function settingWikiUrl(engine: EngineId, key: string): string | undefined {
  const w = WIKIS[engine];
  const path = w && Object.hasOwn(w.paths, key) ? w.paths[key] : undefined;
  return path ? `${w!.base}${path}` : undefined;
}
