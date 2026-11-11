/**
 * MCP bridge: this tab's connection to the local cubby-mcp server
 * (see @cubby/shared/bridge and the cubby-mcp package), which any AI agent with
 * the server added can drive. Off until the user connects from
 * Help → Connect an AI agent or opens the app with `?mcp` (`?claude` is the old name).
 * The tool handlers (./tools.ts) load on first connect.
 */
import { reactive, shallowRef } from 'vue';
import { BridgeClient, type BridgeState } from '@cubby/shared/bridge';
import { openDialog } from '../dialogs/state';
import { askConfirm } from '../app/shell/uiState';

export const bridgeUi = reactive({
  /** Code to prefill (from `?mcp=CODE`). */
  prefill: '',
});

export const bridge = new BridgeClient({
  app: 'slicer',
  appName: 'CubbySlicer',
  tools: () => import('./tools').then((m) => m.slicerTools()),
  // The agent's printer tools wait on the app's confirm dialog, with a "don't ask again" box.
  confirm: async (req) => {
    const a = await askConfirm({
      title: req.title, message: req.message, confirmLabel: req.confirmLabel ?? 'Allow',
      checkLabel: 'Allow without asking until I disconnect', dismissible: false, testId: 'bridge-confirm',
    });
    return { ok: a.choice === 'confirm', always: a.choice === 'confirm' && a.checked };
  },
});

export const bridgeState = shallowRef<BridgeState>(bridge.state);
bridge.subscribe((s) => { bridgeState.value = s; });

export function openBridgeDialog(prefill = ''): void {
  bridgeUi.prefill = prefill;
  openDialog('bridge');
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
