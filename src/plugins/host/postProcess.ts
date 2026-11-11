/**
 * Step.psGCodePostProcess at export and send (OrcaSlicer PostProcessor.cpp
 * run_post_process_plugins): the slicing-pipeline capabilities the process
 * preset selects run, in list order, on a working copy of the G-code, after
 * the thumbnails are in it. The preview is not affected. It runs again on
 * every export / upload, like Orca (no caching).
 *
 * Selection: the process option `slicing_pipeline_plugin` (Orca 2.5 schema).
 * Engine builds whose schema lacks it (the 2.4.2 engine) keep the same list in
 * CubbySlicer's own storage, edited from the Plugins dialog, until the 2.5
 * engine ships the key.
 */
import type { CapabilityId } from '../types';
import { capabilityConfig, loadedCapabilities, log, pluginState } from '../manager/store';
import { request, runtimeState } from '../runtime/client';
import { fullConfig } from './presets';

export { PIPELINE_KEY, fallbackSelection, schemaHasPipelineKey, selectedPipelineNames, setPipelineSelected } from './pipelineSelection';
import { selectedPipelineNames } from './pipelineSelection';

/** The capabilities that will run: selected names resolved against loaded, enabled ones (unresolved are skipped). */
export function postProcessCapabilities(): CapabilityId[] {
  const loaded = loadedCapabilities('slicing-pipeline');
  const out: CapabilityId[] = [];
  for (const name of selectedPipelineNames()) {
    const c = loaded.find((x) => x.name === name);
    if (c) out.push({ pluginKey: c.pluginKey, type: c.type, name: c.name });
  }
  return out;
}

export function postProcessActive(): boolean {
  return pluginState.scanned && postProcessCapabilities().length > 0;
}

export class PostProcessError extends Error {}

/**
 * Run post-processing on a copy of `gcode`. `host` is Orca's target label ("File",
 * "OctoPrint", …); `outputName` the final file name. Returns the input unchanged when
 * nothing is selected. Throws PostProcessError with Orca's message on failure.
 */
export async function postProcessGcode(gcode: Uint8Array, host: string, outputName: string): Promise<Uint8Array> {
  const caps = postProcessCapabilities();
  if (!caps.length) return gcode;
  if (runtimeState.value.phase !== 'ready') throw new PostProcessError('The plugin runtime is not running.');
  const copy = gcode.slice().buffer;
  const t0 = performance.now();
  const r = await request<{ t: 'reply'; ok: boolean; error?: string; gcode?: ArrayBuffer }>((reqId) => ({
    t: 'postProcess', reqId, gcode: copy, host, outputName, fullConfig: fullConfig(),
    caps: caps.map((id) => { const e = capabilityConfig(id); return { id, config: e.config, configVersion: e.storedPluginVersion }; }),
  }), [copy]);
  if (!r.ok || !r.gcode) {
    log('error', r.error ?? 'Post-processing failed', caps[0]?.pluginKey);
    throw new PostProcessError(r.error ?? 'Post-processing failed');
  }
  log('info', `Post-processed ${outputName} for ${host} with ${caps.map((c) => c.name).join(', ')} in ${Math.round(performance.now() - t0)} ms`);
  return new Uint8Array(r.gcode);
}
