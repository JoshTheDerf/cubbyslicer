/**
 * Model hand-off from the CubbyCAD editor (kept from the legacy app):
 *  - `?model=<url>` fetches models on startup (params: modelLink.ts);
 *  - an opener can `postMessage({ type: 'cubby-slicer:model', stl: ArrayBuffer, name })`;
 *  - we post `{ type: 'cubby-slicer:ready' }` to the opener once listening.
 *
 * Cross-origin isolation: this app is served with `Cross-Origin-Opener-Policy:
 * same-origin` (SharedArrayBuffer for the multi-threaded engine). Unless the
 * opener has the same COOP (+COEP), the browser puts us in a new browsing-
 * context group: `window.opener` is null here and the editor's window handle
 * reads as closed, so the postMessage path above silently stops working.
 * Same-origin fallback that survives COOP: open `/slicer/?handoff=<id>` and
 * talk over `BroadcastChannel(HANDOFF_CHANNEL)`:
 *   slicer → `{ type: 'cubby-slicer:ready', handoff: id }`
 *   editor → `{ type: 'cubby-slicer:model', handoff: id, stl, name, cad? }`
 * `cad` (newer editors) is a CubbyCAD node-tree payload (`@cubby/shared/cad`
 * CadTransferPayload): it opens as editable CubbyCAD objects, with the STL
 * as the fallback when it's missing or imports nothing.
 * The id pairs one editor tab with the slicer tab it opened (other open slicer
 * tabs ignore the message). The channel is same-origin only by construction.
 */
import { parseCadTransfer } from '@cubby/shared/cad';
import { toast } from '../../ui';
import { arrangeObjects, importBuffer, reportUnplaced } from './actions';
import { MODEL_LINK_PARAMS, parseModelLinkParams, resolveLinkName } from './modelLink';

export const HANDOFF_CHANNEL = 'cubby-slicer-handoff';

type HandoffMessage = { type?: unknown; stl?: unknown; name?: unknown; handoff?: unknown; cad?: unknown } | null;

/** Import a `cubby-slicer:model` payload; returns false if it isn't one. */
function acceptModel(d: HandoffMessage): boolean {
  if (!d || d.type !== 'cubby-slicer:model' || !d.stl) return false;
  let buf: ArrayBuffer | null = null;
  if (d.stl instanceof ArrayBuffer) buf = d.stl;
  else if (ArrayBuffer.isView(d.stl)) {
    const v = d.stl as ArrayBufferView;
    buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (!buf) return false;
  const name = typeof d.name === 'string' && d.name ? d.name : 'model.stl';
  void importHandoff(name, buf, d.cad);
  return true;
}

/** The node tree when the editor sent one and it imports, else the STL. */
async function importHandoff(name: string, stl: ArrayBuffer, cad: unknown): Promise<void> {
  if (cad) {
    try {
      const payload = parseCadTransfer(cad);
      const { importCadNodes } = await import('../../cad/commands');
      const label = payload.name?.trim() || name.replace(/\.stl$/i, '');
      const r = await importCadNodes(payload.nodes, { unit: payload.unit ?? 'mm', label: `Import ${label}` });
      if (r.ids.length) {
        if (r.warnings.length) toast.warn(`Opened ${label} from CubbyCAD with ${r.warnings.length === 1 ? 'a warning' : `${r.warnings.length} warnings`}.`, { detail: r.warnings.slice(0, 6).join('\n') });
        return;
      }
    } catch (e) {
      console.warn('[handoff] CubbyCAD nodes failed to import; using the STL', e);
    }
  }
  await importBuffer(name, stl);
}

/** `?model=` links: fetch and import in order, then arrange as `?arrange=` asks. */
async function openModelLinks(): Promise<void> {
  const { models, arrange, invalid } = parseModelLinkParams(new URLSearchParams(location.search), location.href);
  if (!models.length && !invalid.length) return;
  // One-off: a reload must not import the files again.
  const u = new URL(location.href);
  for (const p of MODEL_LINK_PARAMS) u.searchParams.delete(p);
  history.replaceState(history.state, '', u);
  for (const raw of invalid) toast.error("Couldn't load the linked model.", { detail: `${raw}\nOnly http(s) links are supported.` });
  // Arrange once after the last file, not per file.
  const perFile = arrange === 'default' ? undefined : false;
  let added = 0;
  for (const link of models) {
    try {
      const rsp = await fetch(link.url);
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
      const buf = await rsp.arrayBuffer();
      const name = resolveLinkName(link, { disposition: rsp.headers.get('content-disposition'), contentType: rsp.headers.get('content-type') }, new Uint8Array(buf, 0, Math.min(4, buf.byteLength)));
      added += (await importBuffer(name, buf, { autoArrange: perFile })).length;
    } catch (e) {
      toast.error("Couldn't load the linked model.", { detail: `${link.url}\n${(e as Error)?.message ?? ''}` });
    }
  }
  if (added && (arrange === 'all' || arrange === 'plate')) {
    const n = arrangeObjects(undefined, 6, arrange);
    if (n) reportUnplaced(n);
  }
}

export function startHandoff(): () => void {
  const onMessage = (ev: MessageEvent) => {
    const d = ev.data as HandoffMessage;
    if (!d || d.type !== 'cubby-slicer:model') return;
    // Only the window that opened us (or embeds us) may push models.
    if (ev.source !== window.opener && (window.parent === window || ev.source !== window.parent)) return;
    acceptModel(d);
  };
  window.addEventListener('message', onMessage);
  if (window.opener) {
    try { (window.opener as Window).postMessage({ type: 'cubby-slicer:ready' }, '*'); } catch { /* cross-origin opener gone */ }
  }

  // COOP-safe path (see header): only when the opener asked for it with ?handoff=<id>.
  const handoffId = new URLSearchParams(location.search).get('handoff');
  let channel: BroadcastChannel | null = null;
  if (handoffId && typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(HANDOFF_CHANNEL);
    channel.onmessage = (ev: MessageEvent) => {
      const d = ev.data as HandoffMessage;
      if (!d || d.handoff !== handoffId) return;
      if (acceptModel(d)) {
        // One model per hand-off; a reload of this tab must not wait for another.
        channel?.close();
        channel = null;
        const u = new URL(location.href);
        u.searchParams.delete('handoff');
        history.replaceState(history.state, '', u);
      }
    };
    channel.postMessage({ type: 'cubby-slicer:ready', handoff: handoffId });
  }

  void openModelLinks();
  return () => {
    window.removeEventListener('message', onMessage);
    channel?.close();
  };
}
