/**
 * Action registry singleton (@cubby/shared/actions, shared with CubbyCAD).
 *
 * Actions are always registered and gated with `when` — surfaces never add or
 * remove commands at runtime. Other areas contribute with:
 *
 *   import { registerActions } from '@/app/actions';
 *   const dispose = registerActions([{ id: 'preview.layer.up', title: 'Next layer',
 *     category: 'Preview', binding: { key: 'arrowup', scope: 'preview' },
 *     when: () => hasSlice.value, run: () => layerUp() }]);
 *
 * `actionsRevision` bumps on every change so projected surfaces recompute.
 */
import { ref } from 'vue';
import { createActionRegistry } from '@cubby/shared/actions';
import type { Action } from './types';

export const actionsRevision = ref(0);

export const { registerActions, getAction, getAllActions, clearActions } = createActionRegistry<Action>(() => { actionsRevision.value++; });
