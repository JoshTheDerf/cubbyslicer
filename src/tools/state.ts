/**
 * Tool state shared by the tool actions, panels and the 3D scene bridge:
 * which Orca gizmo-style tool is open (measure / text / SVG / simplify /
 * boolean / brim ears) and the live PrepareScene the tools draw into.
 */
import { Vector3 } from 'three';
import { reactive, shallowRef } from 'vue';
import type { PrepareScene, ToolHandler } from '../viewport/scene';

export type ToolId = 'measure' | 'text' | 'svg' | 'simplify' | 'boolean' | 'brim' | 'cut' | 'assembly';

export const TOOL_TITLES: Record<ToolId, string> = {
  measure: 'Measure',
  text: 'Text',
  svg: 'SVG',
  simplify: 'Simplify',
  boolean: 'Mesh boolean',
  brim: 'Brim ears',
  cut: 'Cut',
  assembly: 'Assembly view',
};

export const toolState = reactive({
  active: null as ToolId | null,
  /** Tool-specific open request payload (e.g. the part to edit, or 'new object'). */
  request: null as null | { objectId?: string; partId?: string | null; newObject?: boolean; svgFile?: { name: string; text: string } },
  /** Bumped every time a tool is (re)opened so panels can reset. */
  opened: 0,
});

export const toolScene = shallowRef<PrepareScene | null>(null);

/** PrepareViewport registers its scene here. */
export function bindToolScene(s: PrepareScene | null): void {
  toolScene.value = s;
}

/** The painting / cut tools (src/paint) close when one of ours opens; loaded lazily if present. */
const paintModules = import.meta.glob<{ closePaintAndCut?: () => void }>('../paint/controller.ts');
function closePaintAndCut(): void {
  for (const load of Object.values(paintModules)) {
    void load().then((m) => {
      m.closePaintAndCut?.();
      // Their close may have removed the scene handler: put ours back.
      if (toolState.active && current) toolScene.value?.setToolHandler(current);
    }).catch(() => { /* optional module */ });
  }
}

let current: ToolHandler | null = null;

export function openTool(id: ToolId, request: typeof toolState.request = null): void {
  closePaintAndCut();
  toolState.request = request;
  toolState.active = id;
  toolState.opened++;
}

export function closeTool(): void {
  const had = !!toolState.active || !!current;
  toolState.active = null;
  toolState.request = null;
  // Only clear the scene handler if it is ours (painting / cut install their own).
  if (had && current) toolScene.value?.setToolHandler(null);
  current = null;
}

export function toggleTool(id: ToolId): void {
  if (toolState.active === id) closeTool(); else openTool(id);
}

/** Install a handler on the live scene (re-installed if the scene is recreated). */
export function installHandler(h: ToolHandler | null): void {
  if (!h && !current) return;
  current = h;
  toolScene.value?.setToolHandler(h);
}

// Dev / e2e hook (same gate as window.__cubbyProject in main.ts).
if (typeof window !== 'undefined' && (import.meta.env.DEV || new URLSearchParams(location.search).has('cubby-debug'))) {
  Object.assign(window, {
    __cubbyTools: {
      toolState, openTool, closeTool,
      /** World point → client coordinates in the Prepare view. */
      project(x: number, y: number, z: number): [number, number] | null {
        const s = toolScene.value;
        if (!s) return null;
        const cam = s.camera;
        cam.updateMatrixWorld();
        const v = new Vector3(x, y, z).project(cam);
        const r = s.renderer.domElement.getBoundingClientRect();
        return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
      },
    },
  });
}
