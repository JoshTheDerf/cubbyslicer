/** Minimal KeyboardEvent stand-in for node tests. */
export function key(k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}) {
  const e = {
    key: k,
    code: mods.code ?? '',
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    defaultPrevented: false,
    isComposing: false,
    prevented: false,
    stopped: false,
    preventDefault() { e.prevented = true; e.defaultPrevented = true; },
    stopPropagation() { e.stopped = true; },
  };
  return e as typeof e & KeyboardEvent;
}
