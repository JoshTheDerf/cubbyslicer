/** Object properties: name, visibility, printable, colour and per-object setting overrides. */
import type { ConfigValue } from '../../engine/types';
import { cadData } from './clone';
import { mutate } from './history';
import { EMPTY_OVERRIDES, getObject, targets } from './state';

export function renameObject(id: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  mutate('Rename', () => { const o = getObject(id); if (o) o.name = n; }, { slice: false });
}

export function setVisible(ids: string[], visible: boolean): void {
  mutate(visible ? 'Show' : 'Hide', () => { for (const o of targets(ids)) o.visible = visible; }, { slice: false });
}

export function setPrintable(ids: string[], printable: boolean): void {
  mutate(printable ? 'Mark printable' : 'Mark not printable', () => { for (const o of targets(ids)) o.printable = printable; });
}

export function setColor(ids: string[], color: string): void {
  mutate('Change colour', () => {
    for (const o of targets(ids)) {
      o.color = color;
      // A CAD object's colour is its root node's material colour.
      if (o.cad && /^#[0-9a-f]{6}$/i.test(color)) o.cad = cadData({ ...o.cad.node, material: { ...(o.cad.node.material ?? {}), color: color.toLowerCase() } });
    }
  }, { slice: false });
}

/** Reactive override record for an object (read-only view; use setObjectOverride to change). */
export function getObjectOverrides(id: string): Readonly<Record<string, ConfigValue>> {
  return getObject(id)?.overrides ?? EMPTY_OVERRIDES;
}

/** Set (or clear with `undefined`) one per-object override. Undoable; rapid edits coalesce. */
export function setObjectOverride(id: string, key: string, value: ConfigValue | undefined): void {
  mutate(value === undefined ? 'Reset object setting' : 'Change object setting', () => {
    const o = getObject(id);
    if (!o) return;
    if (value === undefined) delete o.overrides[key];
    else o.overrides[key] = Array.isArray(value) ? [...value] : value;
  }, { mergeKey: `ovr:${id}:${key}` });
}

/** Replace all overrides of an object at once. */
export function setObjectOverrides(id: string, values: Record<string, ConfigValue>): void {
  mutate('Change object settings', () => {
    const o = getObject(id);
    if (o) o.overrides = { ...values };
  });
}

export function overrideCount(id: string): number {
  return Object.keys(getObject(id)?.overrides ?? {}).length;
}
