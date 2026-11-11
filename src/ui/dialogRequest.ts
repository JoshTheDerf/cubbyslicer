/**
 * Dialogs that answer a question (confirm, choose, enter a size): the caller
 * awaits `ask(request)`; the mounted dialog renders `current` and calls
 * `answer(…)`. Closing the dialog any other way (Esc, the close button, a
 * newer request) answers `cancelled`. Plain show / hide dialogs use the
 * `dialogs` record in src/dialogs/state.ts instead.
 */
import { computed, shallowRef, type ShallowRef, type WritableComputedRef } from 'vue';

export interface DialogRequest<Req, Ans> {
  /** The pending request (with its resolver), or null. */
  current: ShallowRef<(Req & { resolve: (a: Ans) => void }) | null>;
  ask(req: Req): Promise<Ans>;
  answer(a: Ans): void;
  /** `v-model:open` for the dialog: setting false answers `cancelled`. */
  open: WritableComputedRef<boolean>;
}

export function dialogRequest<Req extends object, Ans>(cancelled: Ans): DialogRequest<Req, Ans> {
  type Pending = Req & { resolve: (a: Ans) => void };
  const current: ShallowRef<Pending | null> = shallowRef(null);
  function answer(a: Ans): void {
    const r = current.value;
    current.value = null;
    r?.resolve(a);
  }
  function ask(req: Req): Promise<Ans> {
    answer(cancelled);
    return new Promise((resolve) => { current.value = { ...req, resolve } as Pending; });
  }
  const open = computed({ get: () => !!current.value, set: (v: boolean) => { if (!v) answer(cancelled); } });
  return { current, ask, answer, open };
}
