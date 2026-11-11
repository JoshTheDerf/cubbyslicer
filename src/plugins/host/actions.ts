/**
 * Plugin commands in the command palette (OrcaSlicer's Speed Dial:
 * ActionRegistry.cpp PluginScriptAction). Each loaded, enabled Script
 * capability becomes an action titled with the capability name, owned by
 * `plugin:<key>`; they are re-registered whenever plugins change and removed
 * with the plugin. Plugins get no key bindings, menus or toolbar buttons, as
 * in Orca 2.5. A run says "Script plugin started." and reports the outcome
 * when it finishes; a cancellation is silent.
 */
import { registerActions, type Action } from '../../app/actions';
import { toast } from '../../ui/toast';
import type { ScriptCompletion } from '../types';
import { onPluginsChange, pluginState, runScriptCapability } from '../manager/store';

const registrations = new Map<string, () => void>();

/** Orca script_outcome_to_action_result. */
export function reportScriptOutcome(c: ScriptCompletion, name: string): void {
  if (c.cancelled) return;
  if (c.error) { toast.error(c.error, { detail: name }); return; }
  const r = c.result;
  if (!r) return;
  if (r.status === 'RecoverableError' || r.status === 'FatalError') { toast.error(r.message || 'Script plugin failed.', { detail: name }); return; }
  const skipped = r.status === 'Skipped';
  const msg = r.message || (skipped ? 'Script plugin skipped.' : 'Script plugin finished.');
  (skipped ? toast.info : toast.success)(msg, { detail: name });
}

function sync(): void {
  const live = new Set<string>();
  for (const row of pluginState.rows) {
    const key = row.desc.pluginKey;
    const scripts = row.status === 'loaded' ? row.caps.filter((c) => c.type === 'script' && c.enabled) : [];
    registrations.get(key)?.();
    registrations.delete(key);
    if (!scripts.length) continue;
    live.add(key);
    const actions: Action[] = scripts.map((c) => ({
      id: `plugin.script.${key}.${c.name}`,
      title: c.name,
      icon: 'i-lucide-puzzle',
      category: 'Plugins',
      aliases: [row.desc.name, 'plugin', 'script'],
      description: `Runs the Script capability of the ${row.desc.name} plugin.`,
      run: () => {
        toast.info('Script plugin started.', { detail: c.name, timeout: 2000 });
        void runScriptCapability(c).then((done) => reportScriptOutcome(done, c.name));
      },
    }));
    const dispose = registerActions(actions, { id: `plugin:${key}`, name: row.desc.name });
    registrations.set(key, dispose);
  }
  for (const [key, d] of registrations) if (!live.has(key)) { d(); registrations.delete(key); }
}

let installed = false;
export function installPluginActions(): void {
  if (installed) return;
  installed = true;
  onPluginsChange(sync);
  sync();
}
