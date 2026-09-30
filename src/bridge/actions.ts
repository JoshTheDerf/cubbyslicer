/**
 * MCP bridge commands (Help menu, palette). The ids keep their old `claude.`
 * prefix: recent actions and key bindings are stored by id.
 */
import type { Action } from '../app/actions/types';
import { registerActions } from '../app/actions/registry';
import { bridge, bridgeState, openBridgeDialog } from './store';

export const bridgeActions: Action[] = [
  {
    id: 'claude.connect', title: 'Connect an AI agent…', icon: 'i-lucide-bot', category: 'Help',
    aliases: ['mcp', 'ai', 'agent', 'claude', 'codex', 'cursor', 'pair', 'automation'],
    run: () => openBridgeDialog(),
  },
  {
    id: 'claude.disconnect', title: 'Disconnect AI agent', icon: 'i-lucide-unplug', category: 'Help',
    aliases: ['mcp', 'ai', 'agent', 'claude', 'codex', 'cursor', 'unpair'],
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
