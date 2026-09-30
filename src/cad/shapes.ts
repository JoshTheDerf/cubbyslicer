/** The built-in CubbyCAD shapes the slicer offers (CubbyCAD's palette order). */
import { getSharedShape, paletteSharedShapes, type SharedShapeDef } from './api';

/** Palette shapes, minus CubbyCAD-only ones that need its editor (text, sketches, …). */
export function paletteShapes(): SharedShapeDef[] {
  return paletteSharedShapes().filter((s) => s.id !== 'mesh');
}

export function shapeLabel(id: string): string { return getSharedShape(id)?.label ?? id; }
