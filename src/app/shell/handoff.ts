/**
 * Model hand-off from the CubbyCAD editor (kept from the legacy app):
 *  - `?model=<url>` fetches a model on startup;
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
 *   editor → `{ type: 'cubby-slicer:model', handoff: id, stl, name }`
 * The id pairs one editor tab with the slicer tab it opened (other open slicer
 * tabs ignore the message). The channel is same-origin only by construction.
 */
import { toast } from '../../ui';
import { importBuffer } from './actions';

export const HANDOFF_CHANNEL = 'cubby-slicer-handoff';

type HandoffMessage = { type?: unknown; stl?: unknown; name?: unknown; handoff?: unknown } | null;

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
  void importBuffer(typeof d.name === 'string' && d.name ? d.name : 'model.stl', buf);
  return true;
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

  const url = new URLSearchParams(location.search).get('model');
  if (url) {
    void (async () => {
      try {
        const rsp = await fetch(url);
        if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
        const buf = await rsp.arrayBuffer();
        const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'model.stl');
        await importBuffer(name, buf);
      } catch (e) {
        toast.error("Couldn't load the linked model.", { detail: `${url}\n${(e as Error)?.message ?? ''}` });
      }
    })();
  }
  return () => {
    window.removeEventListener('message', onMessage);
    channel?.close();
  };
}
