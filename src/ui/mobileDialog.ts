/**
 * The app's one mobile dialog convention (see also the `phone:` Tailwind variant
 * in style.css and the `modal` / `slideover` theme in vite.config.ts).
 *
 * On a phone (≤ 640 px wide, or ≤ 500 px tall: landscape) every UModal is a
 * bottom sheet sized to the visual viewport, or full screen when the dialog asks
 * for it with `:fullscreen="mobileDialog"`. Header and footer stay pinned; only
 * the body scrolls. Touch targets grow to 40 px and inputs to 16 px (no iOS zoom).
 *
 * The visual viewport is published as CSS variables so the sheet follows the
 * on-screen keyboard (iOS Safari shrinks only the visual viewport, and Android
 * Chrome does too unless the page opts into `interactive-widget`):
 *   --vvh  visual viewport height           (fallback 100dvh)
 *   --vvt  its offset from the layout top    (fallback 0)
 *   --vvb  its offset from the layout bottom (fallback 0)
 */
import { ref, type Ref } from 'vue';

/** Keep in sync with `@custom-variant phone` in style.css. */
export const MOBILE_DIALOG_QUERY = '(max-width: 640px), (max-height: 500px)';

const queries = new Map<string, Ref<boolean>>();
/** A shared ref tracking a media query (one listener per query, app lifetime). */
export function mediaQuery(query: string): Ref<boolean> {
  let r = queries.get(query);
  if (!r) {
    const mq = typeof matchMedia !== 'undefined' ? matchMedia(query) : null;
    const m = ref(!!mq?.matches);
    mq?.addEventListener('change', (e) => { m.value = e.matches; });
    queries.set(query, r = m);
  }
  return r;
}

/** Dialogs use the phone layout (bottom sheet / full screen, stacked columns). */
export const mobileDialog = mediaQuery(MOBILE_DIALOG_QUERY);
/** Landscape phone: short but wide (dialogs lay out side by side to save height). */
export const shortScreen = mediaQuery('(max-height: 500px) and (min-width: 560px)');

let installed = false;
/** Publish --vvh / --vvt / --vvb on <html>, tracking the visual viewport. */
export function installViewportVars(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  let frame = 0;
  const update = () => {
    frame = 0;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    root.setProperty('--vvh', `${Math.round(h)}px`);
    root.setProperty('--vvt', `${Math.round(top)}px`);
    root.setProperty('--vvb', `${Math.max(0, Math.round(window.innerHeight - h - top))}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  update();
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
}
