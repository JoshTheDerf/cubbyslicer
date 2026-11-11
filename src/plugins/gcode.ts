/**
 * The one call export and send paths make: post-process a copy of the G-code
 * with the selected slicing-pipeline plugins (Step.psGCodePostProcess) before
 * it is written or uploaded. Costs nothing when no plugin is loaded.
 *
 *   const out = await gcodeForOutput(bytes, 'File', name);
 *   if (!out) return;          // a plugin failed; the error was shown
 *
 * `host`: "File" for downloads / files, else the print host's Orca type label
 * ("OctoPrint", "Klipper", …), as Orca passes `host_type`.
 */
import { pluginsActive } from './state';
import { toast } from '../ui/toast';

export async function gcodeForOutput(gcode: Uint8Array, host: string, outputName: string): Promise<Uint8Array | null> {
  if (!pluginsActive.value) return gcode;
  const { postProcessGcode } = await import('./host/postProcess');
  try {
    return await postProcessGcode(gcode, host, outputName);
  } catch (e) {
    const msg = (e as Error).message || 'Post-processing failed';
    const [title, ...rest] = msg.split('\n');
    toast.error(title, { detail: rest.join('\n').trim() || undefined, timeout: 15000 });
    return null;
  }
}
