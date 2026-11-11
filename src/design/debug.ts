/**
 * `window.__cubbyDesign` (dev, or `?cubby-debug`): the Design tab's session, commands and UI
 * state for browser automation (scripts/dev/e2e-design.mjs).
 */
export { design, displayBodies, designKernel, designReady, activateDesign, reopenDesign, currentDoc, readDesign, runEdit } from './session';
export * from './commands';
export { designUi } from './state';
export { designViewport } from './viewport';
export { card, openCard, cancelCard, confirmCard, setCardValue, runPreview, ghost, offerItems } from './create';
export { picking } from './pick';
export { addPrimitiveBody, convertObjectToBody, exactBuild } from './primitives';
export { importStepToDesign, importMeshToDesign, importObjectMesh, exportStepBytes } from './io';
export * as sketch from './sketch/session';
export { live as sketchLive, setTool as setSketchTool } from './sketch/driver';
