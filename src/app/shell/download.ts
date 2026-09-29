/** Trigger a browser download for bytes. */
export function downloadBytes(bytes: Uint8Array | ArrayBuffer | Blob, name: string, type = 'application/octet-stream'): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function safeFileName(s: string, fallback = 'plate'): string {
  const n = s.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').slice(0, 80);
  return n || fallback;
}

/** Open a native file picker. Resolves with the chosen files (empty on cancel). */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let done = false;
    const finish = (f: File[]) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Save bytes: the native save dialog (File System Access API) where the
 * browser has it, else a download. Resolves false when the user cancels.
 */
export async function saveBytes(bytes: Uint8Array | ArrayBuffer | Blob, name: string, type: string,
  opts: { types: FilePickerAcceptType[]; id: string }): Promise<boolean> {
  const { fsAccessSupported, pickSave, writeHandle } = await import('../../localfs/store');
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
  if (!fsAccessSupported) { downloadBytes(blob, name, type); return true; }
  const h = await pickSave(name, opts.types, opts.id);
  if (!h) return false;
  await writeHandle(h, blob);
  return true;
}
