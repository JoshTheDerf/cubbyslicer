/**
 * Plugin-runtime side of the HookChannel (see ../hookChannel.ts). One channel
 * per engine worker; the main thread hands each over as it starts and closes
 * it when the worker goes away.
 *
 * On `hookBegin` the runtime takes the hook (RUNNING), runs the selected
 * capabilities (`_cubby_runtime.run_pipeline`), and answers DONE. Graph reads
 * and writes made meanwhile go out as QUERY and park here until the engine
 * worker writes REPLY. A cancelled slice (the engine worker terminated) sets
 * CANCEL, which turns the next query into HookCancelled in Python.
 */
import { HOOK, HOOK_STATE, HookFrames } from '../hookChannel';

interface Channel { id: number; frames: HookFrames; port: MessagePort }
const channels = new Map<number, Channel>();
let active: HookFrames | null = null;

export type RunPipeline = (beginJson: string) => string;
let run: RunPipeline | null = null;
let onLog: (level: 'info' | 'warn' | 'error', text: string) => void = () => {};

export function setPipelineRunner(fn: RunPipeline, log: typeof onLog): void { run = fn; onLog = log; }

export function attachHookChannel(id: number, sab: SharedArrayBuffer, port: MessagePort): void {
  const ch: Channel = { id, frames: new HookFrames(sab), port };
  channels.set(id, ch);
  port.onmessage = (e: MessageEvent) => { if (e.data?.t === 'hookBegin') handleBegin(ch); };
}

export function detachHookChannel(id: number): void {
  const ch = channels.get(id);
  if (!ch) return;
  ch.port.onmessage = null;
  ch.port.close();
  channels.delete(id);
}

function handleBegin(ch: Channel): void {
  const f = ch.frames;
  if (f.state !== HOOK_STATE.BEGIN) return;
  f.setState(HOOK_STATE.RUNNING);
  const begin = f.readText();
  let result = 'null';
  active = f;
  try {
    result = run ? run(begin) : JSON.stringify({ status: 'FatalError', capability: '', message: 'plugin runtime not ready' });
  } catch (e) {
    result = JSON.stringify({ status: 'Exception', capability: '', message: String((e as Error)?.message ?? e) });
    onLog('error', `slicing hook failed: ${result}`);
  } finally {
    active = null;
  }
  if (f.cancelled) return;
  f.writeText(result);
  f.setState(HOOK_STATE.DONE);
}

/** `_cubby_host.hookQuery(json, blob)`: one cs_hook_query round trip through the engine worker. */
export function hookQuery(json: string, blob: Uint8Array | null): { json?: string; blob?: Uint8Array; error?: string; cancelled?: boolean } {
  const f = active;
  if (!f) return { error: 'not inside a slicing pipeline hook' };
  if (f.cancelled) return { cancelled: true };
  if (!f.writePair(json, blob)) return { error: `graph write too large (${((blob?.byteLength ?? 0) / 1048576).toFixed(1)} MB); write fewer layers at a time` };
  f.setState(HOOK_STATE.QUERY);
  while (f.state === HOOK_STATE.QUERY) {
    if (f.cancelled) return { cancelled: true };
    Atomics.wait(f.ctrl, HOOK.STATE, HOOK_STATE.QUERY, 500);
  }
  if (f.state !== HOOK_STATE.REPLY) return { cancelled: true };
  const r = f.readPair();
  f.setState(HOOK_STATE.RUNNING);
  return { json: r.json, blob: r.blob };
}

export function hookCancelled(): boolean { return !!active?.cancelled; }
