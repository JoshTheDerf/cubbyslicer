/**
 * Integration seams with the other areas.
 *
 *   src/settings/SettingsPanel.vue  → Orca sidebar (left). The shell passes the
 *                                     object list in its `#objects` slot.
 *   src/preview/PreviewView.vue     → centre, Preview tab (lazy chunk).
 *   src/app/slice.ts                → useSliceController(): top-bar slice
 *                                     controls, Ctrl+R / Ctrl+G, notifications.
 */
import { defineAsyncComponent, defineComponent, h } from 'vue';
import { useSliceController } from '../slice';

export type SliceControllerLike = ReturnType<typeof useSliceController>;

const fallback = (label: string) => defineComponent({
  name: 'ShellPlaceholder',
  setup: () => () => h('div', { class: 'shell-placeholder' }, label),
});

export const PreviewView = defineAsyncComponent({
  loader: () => import('../../preview/PreviewView.vue'),
  errorComponent: fallback('The preview failed to load. Reload the page to try again.'),
  delay: 120,
  loadingComponent: fallback(''),
});
