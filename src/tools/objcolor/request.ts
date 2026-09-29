/**
 * Hand-off from the model import to the OBJ colour dialog (Orca shows
 * ObjColorDialog right after loading an OBJ with colours).
 */
import { shallowRef } from 'vue';
import type { ParsedObject } from '../../project/types';
import { parseMtl } from './objColor';

export interface ObjColorItem {
  objectId: string;
  name: string;
  faceGroups: NonNullable<ParsedObject['faceGroups']>;
}

export const objColorRequest = shallowRef<{ item: ObjColorItem; resolve: () => void } | null>(null);

/** MTL files dropped / picked together with OBJs: material name → colour. */
const companion = new Map<string, string>();
export function addCompanionMtl(text: string): void {
  for (const [k, v] of parseMtl(text)) companion.set(k, v);
}
export function companionColour(material: string): string | undefined { return companion.get(material); }

/** After an import: offer the colour → filament mapping for every object that has face colours. */
export async function offerObjColors(parsed: ParsedObject[], ids: string[]): Promise<void> {
  for (let i = 0; i < parsed.length && i < ids.length; i++) {
    const fg = parsed[i].faceGroups;
    if (!fg || !fg.groups.length) continue;
    // Fill material colours from companion MTL files.
    const groups = fg.groups.map((g) => ({ ...g, color: g.color ?? companionColour(g.name) ?? null }));
    await new Promise<void>((resolve) => {
      objColorRequest.value?.resolve();
      objColorRequest.value = { item: { objectId: ids[i], name: parsed[i].name, faceGroups: { tri: fg.tri, groups } }, resolve };
    });
  }
}
