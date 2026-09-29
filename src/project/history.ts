/**
 * Snapshot-based undo/redo. Project objects are small (transforms, names,
 * overrides) so each entry stores a full copy of the object list; meshes are
 * referenced by id and kept alive by the store while any entry refers to them.
 */
export interface HistoryEntry<S> { label: string; before: S; after: S }

export class History<S> {
  private undoStack: Array<HistoryEntry<S>> = [];
  private redoStack: Array<HistoryEntry<S>> = [];
  constructor(public maxEntries = 100) {}

  push(entry: HistoryEntry<S>): void {
    this.undoStack.push(entry);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.maxEntries) this.undoStack.shift();
  }

  undo(): HistoryEntry<S> | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    return e;
  }

  redo(): HistoryEntry<S> | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(e);
    return e;
  }

  /** Replace the newest entry's `after` (coalescing rapid edits). False if there's nothing to merge into. */
  mergeIntoTop(after: S): boolean {
    const top = this.undoStack.at(-1);
    if (!top || this.redoStack.length) return false;
    top.after = after;
    return true;
  }

  /** Drop the oldest undo entry (memory pressure). */
  dropOldest(): boolean { return this.undoStack.shift() !== undefined; }

  clear(): void { this.undoStack.length = 0; this.redoStack.length = 0; }

  get undoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }
  get size(): number { return this.undoStack.length + this.redoStack.length; }

  /** Every snapshot currently held. */
  *snapshots(): Iterable<S> {
    for (const e of this.undoStack) { yield e.before; yield e.after; }
    for (const e of this.redoStack) { yield e.before; yield e.after; }
  }
}
