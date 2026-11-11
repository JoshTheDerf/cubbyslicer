/**
 * The CubbyCAD ↔ Design bridge for menus and the palette: thin command wrappers (toasts, view
 * switches) around primitives.ts / io.ts, kept small so the CubbyCAD side imports them without
 * pulling the Design tab in until one runs.
 */
import { activeView } from '../app/state';
import { toast } from '../ui';
import { shapeLabel, paletteShapes } from '../cad/shapes';

/** Palette shapes that come in as meshes (no exact kernel equivalent at their default size). */
export function meshOnlyShapes(): string[] {
  const exact = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'tube', 'capsule', 'halfSphere', 'halfCylinder', 'polygon', 'wedge', 'roof', 'extrudeStar', 'fillet']);
  return paletteShapes().filter((s) => !exact.has(s.id)).map((s) => s.label.toLowerCase());
}

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

/** Palette / "Add shape" in the Design tab: a body. */
export function addShapeToDesignCmd(shapeId: string): void {
  void import('./primitives').then(({ addPrimitiveBody }) => addPrimitiveBody(shapeId)).then((r) => {
    if (!r.ok) toast.error(`${shapeLabel(shapeId)}: ${r.error || 'the kernel refused it'}`);
    else if (!r.exact) toast.info(`${shapeLabel(shapeId)} came in as a mesh body`, { detail: r.reason });
  }, fail);
}

/** "Convert to Design body" for a CubbyCAD object on the plate. */
export function convertToDesignCmd(objectId: string): void {
  activeView.value = 'design';
  void import('./primitives').then(({ convertObjectToBody }) => convertObjectToBody(objectId)).then((r) => {
    if (!r.ok) { toast.error(`Couldn’t convert: ${r.error || 'the kernel refused it'}`); return; }
    if (!r.exact) toast.info('Converted as a mesh body', { detail: r.reason });
    else toast.success(`Converted exactly: ${r.shapes.length} shape${r.shapes.length === 1 ? '' : 's'} rebuilt on the CAD kernel.`, { detail: 'Commit to Plate brings it back as an object that follows your design edits.' });
  }, fail);
}

/** "Import as a mesh body" for any plate object (meshes, imports). */
export function meshToDesignCmd(objectId: string): void {
  activeView.value = 'design';
  void import('./io').then(({ importObjectMesh }) => importObjectMesh(objectId)).then((r) => {
    if (!r.ok) toast.error(`Couldn’t import: ${r.error || 'the kernel refused it'}`);
    else if (!r.watertight) toast.warn('Imported, but the mesh is not watertight: the body may not be a closed solid.');
  }, fail);
}
