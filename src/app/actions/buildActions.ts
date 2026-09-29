/**
 * The pure action table. Registration ORDER is the dispatcher's first-match
 * tie-breaker: slice (Esc = cancel) comes before edit (Esc = clear selection).
 */
import type { Action } from './types';
import { fileActions } from './families/file';
import { cloudActions } from './families/cloud';
import { localFileActions } from './families/local';
import { sliceActions } from './families/slice';
import { editActions } from './families/edit';
import { objectActions } from './families/object';
import { plateActions } from './families/plate';
import { viewActions } from './families/view';
import { helpActions } from './families/help';
import { layerActions } from './families/layers';
import { toolActions } from '../../tools/actions';
import { calibrationActions } from './families/calibration';
import { paintActions } from './families/paint';

export function buildActions(): Action[] {
  return [
    ...fileActions(),
    ...cloudActions(),
    ...localFileActions(),
    ...sliceActions(),
    // Before edit: Esc closes an open paint tool before clearing the selection.
    ...paintActions(),
    ...editActions(),
    ...objectActions(),
    ...plateActions(),
    ...viewActions(),
    ...helpActions(),
    ...layerActions(),
    ...toolActions(),
    ...calibrationActions(),
  ];
}
