/**
 * The built-in action table. Registration ORDER is the dispatcher's first-match
 * tie-breaker: the open tool's keys (Esc = close it, Delete = its selection)
 * come before slice (Esc = cancel), which comes before edit (Esc = clear
 * selection, Delete = delete objects).
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
import { cadActions } from '../../cad/actions';
import { designActions } from '../../design/actions';
import { sketchActions } from '../../design/sketch/actions';
import { toolKeyActions } from './families/toolKeys';
import { previewActions } from '../../preview/actions';
import { settingsActions } from '../../settings/actions';
import { printhostActions } from '../../printhost/actions';
import { bridgeActions } from '../../bridge/actions';
import { pluginsActions } from '../../plugins/actions';

export function buildActions(): Action[] {
  return [
    ...toolKeyActions(),
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
    ...cadActions(),
    ...designActions(),
    ...sketchActions(),
    ...calibrationActions(),
  ];
}

/**
 * Everything the app registers at boot (src/app/shell/actionContext.ts): the
 * core table plus every area's commands, so the palette and shortcuts help
 * list them before the lazily mounted panels exist. The registry lint covers
 * exactly this list.
 */
export function builtinActions(): Action[] {
  return [
    ...buildActions(),
    ...previewActions,
    // settings/actions.ts mirrors the Action shape with `ctx: unknown`.
    ...settingsActions,
    ...printhostActions,
    ...bridgeActions,
    ...pluginsActions,
  ];
}
