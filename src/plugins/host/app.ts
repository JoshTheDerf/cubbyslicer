/**
 * `orca.host.app_info()`, `gl_info()` and the plater state.
 *
 * app_info keeps Orca's keys. `version` is the Orca engine version CubbySlicer
 * runs (the engine schema's), `build` names CubbySlicer, and the sign-in and
 * network-plugin fields are empty: there is no Orca / Bambu cloud account and
 * no Bambu network plugin in the browser.
 */
import { currentPresets } from '../../presets/store';
import { objects } from '../../project/store';
import { cloud, isCloudDirty } from '../../cloud/store';
import { isLocalDirty, local } from '../../localfs/store';

/** Unsaved changes: edits since the last save to a local file / CubbyCAD, or a non-empty project never saved. */
export function projectDirty(): boolean {
  if (isLocalDirty() || isCloudDirty()) return true;
  return !local.location && !cloud.location && objects.value.length > 0;
}

export function engineVersion(): string {
  return currentPresets.value.schema.value?.version || '2.5.0';
}

export function appInfo(): Record<string, unknown> {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US';
  return {
    version: engineVersion(),
    build: 'CubbySlicer (browser)',
    mode: 'editor',
    language: lang.replace('-', '_'),
    app_config_version: '',
    stealth_mode: false,
    is_signed_in: false,
    is_bambu_signed_in: false,
    network_plugin_version: '',
    network_plugin_error: '',
  };
}

let gl: Record<string, unknown> | null | undefined;

export function glInfo(): Record<string, unknown> | null {
  if (gl !== undefined) return gl;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgl2');
    if (!ctx) return (gl = null);
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    gl = {
      vendor: String(ctx.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : ctx.VENDOR)),
      renderer: String(ctx.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : ctx.RENDERER)),
      version: String(ctx.getParameter(ctx.VERSION)),
      glsl_version: String(ctx.getParameter(ctx.SHADING_LANGUAGE_VERSION)),
      core_profile: true,
    };
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { gl = null; }
  return gl;
}
