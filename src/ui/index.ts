/**
 * The app's UI is Nuxt UI (registered in main.ts, <UApp> in App.vue). What's
 * left here is the design-token sheet (theme.css, also bridged onto Nuxt UI's
 * --ui-* variables) and the global toast adapter.
 */
export { toast, pushToast, dismissToast, bindToaster, type ToastKind, type ToastOptions, type Toaster } from './toast';
