/**
 * STEP tessellation worker: OpenCascade (occt-import-js wasm, ~7 MB) is
 * loaded here on the first STEP import only.
 */
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

interface Req { id: number; buffer: ArrayBuffer; params: Record<string, unknown> }
interface Occt { ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): unknown }

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Req>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let occt: Promise<Occt> | null = null;

ctx.onmessage = async (ev) => {
  const { id, buffer, params } = ev.data;
  try {
    occt ??= (occtimportjs as (o: unknown) => Promise<Occt>)({ locateFile: () => wasmUrl });
    const r = (await occt).ReadStepFile(new Uint8Array(buffer), params) as {
      success: boolean;
      meshes: Array<{ name?: string; attributes: { position: { array: number[] } }; index: { array: number[] } }>;
    };
    // Typed arrays so the reply can be transferred.
    const meshes = r.success ? r.meshes.map((m) => ({
      name: m.name,
      attributes: { position: { array: Float32Array.from(m.attributes.position.array) } },
      index: { array: Uint32Array.from(m.index.array) },
    })) : [];
    const transfer: Transferable[] = [];
    for (const m of meshes) transfer.push(m.attributes.position.array.buffer, m.index.array.buffer);
    ctx.postMessage({ id, ok: true, result: { success: r.success, meshes } }, transfer);
  } catch (e) {
    ctx.postMessage({ id, ok: false, message: (e as Error)?.message ?? String(e) });
  }
};
