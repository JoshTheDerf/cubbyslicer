/**
 * Claude Code bridge: this tab's connection to the local cubby-mcp server
 * (see @cubby/shared/bridge and the cubby-mcp package). Off until the user connects
 * from Help → Connect to Claude Code or opens the app with `?claude`.
 * The tool handlers (./tools.ts) load on first connect.
 */
import { reactive, shallowRef } from 'vue';
import { BridgeClient, type BridgeState, type ConfirmRequest } from '@cubby/shared/bridge';

type PendingConfirm = ConfirmRequest & { resolve: (r: { ok: boolean; always: boolean }) => void };

export const bridgeUi = reactive({
  open: false,
  /** Code to prefill (from `?claude=CODE`). */
  prefill: '',
  confirm: null as PendingConfirm | null,
});

export const bridge = new BridgeClient({
  app: 'slicer',
  appName: 'Cubby Slicer',
  tools: () => import('./tools').then((m) => m.slicerTools()),
  confirm: (req) => new Promise((resolve) => {
    bridgeUi.confirm?.resolve({ ok: false, always: false });
    bridgeUi.confirm = { ...req, resolve };
  }),
});

export const bridgeState = shallowRef<BridgeState>(bridge.state);
bridge.subscribe((s) => { bridgeState.value = s; });

export function openBridgeDialog(prefill = ''): void {
  bridgeUi.prefill = prefill;
  bridgeUi.open = true;
}

export function answerConfirm(ok: boolean, always = false): void {
  const c = bridgeUi.confirm;
  bridgeUi.confirm = null;
  c?.resolve({ ok, always });
}

let started = false;
/** Startup: `?claude[=CODE]` opens the dialog; otherwise reconnect only if the user opted in before. */
export function startBridge(): void {
  if (started || typeof location === 'undefined') return;
  started = true;
  const q = new URLSearchParams(location.search);
  if (q.has('claude')) {
    openBridgeDialog(q.get('claude') ?? '');
    const u = new URL(location.href);
    u.searchParams.delete('claude');
    history.replaceState(history.state, '', u);
    return;
  }
  bridge.resume();
}
