/**
 * Close a non-modal menu on any press outside it. Reka listens for outside
 * presses on the document, but the 3D view stops left-button presses in the
 * capture phase (box selection), so those never reach it.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';

export function closeOnOutsidePress(open: Ref<boolean>): void {
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (!t?.closest?.('[role="menu"]')) open.value = false;
  };
  const stop = () => window.removeEventListener('pointerdown', onDown, true);
  watch(open, (v) => { if (v) window.addEventListener('pointerdown', onDown, true); else stop(); });
  onBeforeUnmount(stop);
}
