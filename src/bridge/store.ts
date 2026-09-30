/**
 * MCP bridge: this tab's connection to the local cubby-mcp server
 * (see @cubby/shared/bridge and the cubby-mcp package), which any AI agent with
 * the server added can drive. Off until the user connects from
 * Help → Connect an AI agent or opens the app with `?mcp` (`?claude` is the old name).
 * The tool handlers (./tools.ts) load on first connect.
 */
import { reactive, shallowRef } from 'vue';
import { BridgeClient, type BridgeState, type ConfirmRequest } from '@cubby/shared/bridge';

type PendingConfirm = ConfirmRequest & { resolve: (r: { ok: boolean; always: boolean }) => void };

export const bridgeUi = reactive({
  open: false,
  /** Code to prefill (from `?mcp=CODE`). */
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
/** URL params that open the connect dialog (`?claude` is the old name, kept so existing links work). */
const PAIR_PARAMS = ['mcp', 'claude'];

/** Startup: `?mcp[=CODE]` opens the dialog; otherwise reconnect only if the user opted in before. */
export function startBridge(): void {
  if (started || typeof location === 'undefined') return;
  started = true;
  const q = new URLSearchParams(location.search);
  const param = PAIR_PARAMS.find((p) => q.has(p));
  if (param) {
    openBridgeDialog(q.get(param) ?? '');
    const u = new URL(location.href);
    for (const p of PAIR_PARAMS) u.searchParams.delete(p);
    history.replaceState(history.state, '', u);
    return;
  }
  bridge.resume();
}
