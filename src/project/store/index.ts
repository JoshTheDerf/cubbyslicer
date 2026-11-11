/**
 * Project store: the plates, their objects, meshes, selection and undo/redo.
 * Import it as `project/store`; this barrel is the public API (about 60
 * importers, plus `window.__cubbyProject` for e2e scripts). The modules
 * behind it are internal: add new exports here deliberately.
 *
 * Conventions:
 * - State is module refs (`objects`, `plates`, `selectedIds`, …). Read them
 *   freely; change them only through the commands below.
 * - Every command that changes the project runs inside `mutate(label, fn)`:
 *   one undo step, coalesced by `mergeKey`, closed early by `endGesture()`.
 *   It bumps `projectRevision` (autosave) and, unless `{ slice: false }`,
 *   marks the slice inputs changed.
 * - Meshes are `markRaw` typed arrays in a registry, shared by instances and
 *   by undo snapshots; paint is keyed by mesh id. A command that replaces a
 *   mesh adds a new one with `addMesh`; unreferenced meshes are collected.
 * - Commands taking `ids` default to the selection.
 *
 * Modules (src/project/store/):
 *   state        reactive state, mesh registry, lookups
 *   clone        deep copies for snapshots / clipboard
 *   history      mutate, undo / redo, mesh collection
 *   derived      world bbox / footprint, plate membership, plate problems
 *   selection    selection commands + consistency watchers
 *   placement    drop, fit checks, packing new objects, plate-grid relayout
 *   objects      add / remove / duplicate / instances / clipboard / clear
 *   plates       plate commands
 *   parts        part (volume) commands
 *   pieces       split to objects / parts, cut results
 *   transforms   move / rotate / scale / mirror / orient
 *   properties   name, visibility, printable, colour, setting overrides
 *   paint        painted facets per mesh
 *   sliceInput   slice-job objects, plate slice signature
 *   arrangeIO    Orca arrange (engine) inputs + applying its result
 *   serialize    whole-project load / reset, serialised views
 *   toolObjects  commits from src/tools (emboss, simplify, boolean, brim ears)
 *   cadObjects   CubbyCAD tree objects, group / ungroup
 *   designObjects  Design tab bodies committed to the plate (live-linked objects)
 */

/** Other areas plug their state into project files through this (see persistence/sections.ts). */
export { registerProjectSection, type ProjectSection } from '../persistence/sections';

// ---- state (read; change through the commands) ----
export {
  objects, selectedIds, selectedPart, projectName, projectRevision, meshRevision, projectLoads,
  bed, plates, activePlate, plateBedOf, meshPaint,
  uid, getObject, getMesh, addMesh, liveMeshes,
} from './state';

// ---- undo ----
export { mutate, endGesture, undo, redo, historyState, registerSnapshotSlot, type SnapshotSlot } from './history';

// ---- derived ----
export {
  objectInfo, objectPlate, plateOf, objectsOnPlate, objectIssues, plateStats, objectLocalBBox,
} from './derived';

// ---- selection ----
export { select, selectAll, clearSelection, selectedObjects, primarySelection } from './selection';

// ---- objects ----
export {
  addParsedObjects, removeObjects, duplicateObjects, instancesOf, setInstanceCount, removeInstance,
  copyObjects, pasteObjects, clearPlate, clearAll,
  type AddOptions, type ObjectClipboard,
} from './objects';

// ---- plates ----
export { setActivePlate, addPlate, deletePlate, renamePlate, setPlateLocked, moveObjectsToPlate, clearPlateBedTypes } from './plates';

// ---- parts ----
export { addPart, removePart, setPartTransform, setPartType, setPreciseSeamType, renamePart, setPartOverride, getPartOverrides } from './parts';
export { splitToObjects, splitToParts, replaceWithPieces, type PieceVolume, type ObjectPiece } from './pieces';

// ---- transforms ----
export {
  translateObjects, setTransforms, dropToBed, centerObjects, mirrorObjects, rotateObjects, layOnFace, scaleToFit,
  type TransformPatch,
} from './transforms';

// ---- properties + overrides ----
export {
  renameObject, setVisible, setPrintable, setColor,
  getObjectOverrides, setObjectOverride, setObjectOverrides, overrideCount,
} from './properties';

// ---- paint ----
export { getMeshPaint, setMeshPaint } from './paint';

// ---- engine inputs ----
export { getSliceObjects, plateSliceSignature } from './sliceInput';
export {
  arrangeInputs, applyArrange,
  type ArrangeOutcome, type ArrangeInputs, type ArrangeInputItem, type ArrangeInputPlate,
} from './arrangeIO';

// ---- persistence ----
export {
  loadProjectData, resetProject, serializeObjects, serializePaint, serializePlates, type ProjectData,
} from './serialize';

// ---- tools ----
export { addToolObject, addToolPart, replaceVolumeMesh, commitBoolean, setBrimPoints, commitMeshRepairs, syncDerivedObjects, type MeshRepair } from './toolObjects';

// ---- Design tab (src/design) ----
export { addDesignObjects, addDesignAssembly, designLinks, relinkDesignObjects, designObjects, type DesignBodyMesh, type DesignRelink } from './designObjects';

// ---- CubbyCAD ----
export {
  addCadObjects, setCadNode, groupObjects, planGroup, planUngroup, ungroupObject,
  type CadObjectInput, type UngroupPlan,
} from './cadObjects';
