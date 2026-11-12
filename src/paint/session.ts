/**
 * Engine painting sessions (Orca TriangleSelector in the worker, cs_tool
 * paint_*): the one place that opens, uses and closes them. The paint tool
 * keeps a session open across strokes; the bridge, thumbnails and colour
 * overlays use one-shot sessions.
 */
import { engineTool } from '../engine/client';
import type { PaintMap, ToolMesh } from '../engine/types';
import type { PaintApplyArgs } from '../engine/tools';
import { maxStateFor, type PaintTarget } from './state';

export interface PaintFacets {
  /** Painted state of each output mesh. */
  states: number[];
  /** One mesh of the painted facets per state (mesh frame). */
  meshes: ToolMesh[];
}

export interface PaintSession extends PaintFacets { handle: number }

/** Open a session over a mesh's current paint of `layer`. */
export async function openSession(mesh: ToolMesh, layer: PaintTarget, paint: PaintMap | undefined): Promise<PaintSession> {
  const r = await engineTool('paint_open', { paint: paint ?? [], maxState: maxStateFor(layer) }, [mesh]);
  return { handle: r.result.handle, states: r.result.states, meshes: r.meshes };
}

/** One brush / fill operation; returns the session's facets afterwards. */
export async function applyToSession(handle: number, op: Omit<PaintApplyArgs, 'handle'>): Promise<PaintFacets> {
  const r = await engineTool('paint_apply', { handle, ...op });
  return { states: r.result.states, meshes: r.meshes };
}

/** The session's paint as Orca paint strings. */
export async function sessionPaint(handle: number): Promise<PaintMap> {
  return (await engineTool('paint_get', { handle })).result.paint;
}

/** Close a session (fire and forget: a dead worker took it with it). */
export function closeSession(handle: number): void {
  void engineTool('paint_close', { handle }).catch(() => {});
}

/** Paint strings → painted facets per state (a one-shot session). */
export async function decodePaint(mesh: ToolMesh, layer: PaintTarget, paint: PaintMap): Promise<PaintFacets> {
  const s = await openSession(mesh, layer, paint);
  closeSession(s.handle);
  return { states: s.states, meshes: s.meshes };
}

/** Apply one operation to `paint` in a one-shot session; returns the new paint strings. */
export async function paintWith(mesh: ToolMesh, layer: PaintTarget, paint: PaintMap | undefined, op: Omit<PaintApplyArgs, 'handle'>): Promise<PaintMap> {
  const s = await openSession(mesh, layer, paint);
  try {
    await applyToSession(s.handle, op);
    return await sessionPaint(s.handle);
  } finally {
    closeSession(s.handle);
  }
}
