/** Claude Code bridge commands (Help menu, palette). */
import type { Action } from '../app/actions/types';
import { registerActions } from '../app/actions/registry';
import { bridge, bridgeState, openBridgeDialog } from './store';

export const bridgeActions: Action[] = [
  {
    id: 'claude.connect', title: 'Connect to Claude Code…', icon: 'i-lucide-bot', category: 'Help',
    aliases: ['mcp', 'ai', 'agent', 'claude', 'pair', 'automation'],
    run: () => openBridgeDialog(),
  },
  {
    id: 'claude.disconnect', title: 'Disconnect Claude Code', icon: 'i-lucide-unplug', category: 'Help',
    aliases: ['mcp', 'claude', 'unpair'],
    when: () => bridgeState.value.status === 'connected' || bridgeState.value.status === 'connecting',
    run: () => bridge.disconnect(),
  },
];

let dispose: (() => void) | null = null;
/** Register with the app registry (idempotent). */
export function registerBridgeActions(): () => void {
  if (!dispose) dispose = registerActions(bridgeActions);
  return () => { dispose?.(); dispose = null; };
}
