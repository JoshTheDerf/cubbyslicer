import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

// Cross-origin isolation (SharedArrayBuffer) for the multi-threaded engine
// build. Production sends the same two headers from Caddy for /slicer/*.
// require-corp: every subresource is same-origin or sends CORP/CORS (Google
// Fonts does: `Cross-Origin-Resource-Policy: cross-origin`).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Standalone slicer app. Built to a `/slicer/` base path so the reverse proxy
// can serve it at cubbycad.com/slicer (mirrors the editor's `/editor/` base).
//
// This app carries the AGPL-3.0 slicer engines (CuraEngine / OrcaSlicer /
// PrusaSlicer WASM) that were extracted out of the closed-source editor
// bundle. See LICENSE + README.md.
export default defineConfig({
  base: '/slicer/',
  plugins: [
    vue(),
    // Nuxt UI (same setup as ../cad-project). Dark-only app: the `dark` class
    // is set on <html> in index.html, so Nuxt UI's colour-mode plugin is off.
    ui({
      colorMode: false,
      router: false, // single-page app, no vue-router
      // CubbyCAD's shared shape components (@cubby/shared/cad/ui) use Nuxt UI components by name.
      scanPackages: ['@cubby/shared'],
      // Bundle the icons we use (scanned from source, resolved from the
      // installed @iconify-json/lucide) instead of fetching them from the
      // Iconify API at runtime: works offline, no icon pop-in.
      // Action icons live in .ts families, so scan .ts as well as .vue.
      // Shape icons come from CubbyCAD's shared shape registry (@cubby/shared/cad).
      icon: { clientBundle: { scan: { globInclude: ['src/**/*.{vue,ts}', 'node_modules/@cubby/shared/src/cad/**/*.{vue,ts}'] } } },
      ui: {
        colors: { primary: 'green', neutral: 'zinc' },
        button: { defaultVariants: { color: 'neutral' } },
        select: { slots: { content: 'min-w-(--reka-select-trigger-width) w-max max-w-[min(90vw,28rem)]' } },
        selectMenu: { slots: { content: 'min-w-(--reka-combobox-trigger-width) w-max max-w-[min(90vw,28rem)]' } },
        inputMenu: { slots: { content: 'min-w-(--reka-combobox-trigger-width) w-max max-w-[min(90vw,28rem)]' } },
        // The mobile dialog convention (src/ui/mobileDialog.ts, `phone:` = ≤ 640 px wide or
        // ≤ 500 px tall): a modal is a bottom sheet in the visual viewport (it follows the
        // on-screen keyboard), or full screen with `:fullscreen="mobileDialog"`. Header and
        // footer stay pinned, the body is the one scroll region. Desktop is untouched.
        modal: {
          slots: {
            content: 'phone:ps-[env(safe-area-inset-left)] phone:pe-[env(safe-area-inset-right)]',
            // Compact header: the 40 px close button sits in the corner, titles wrap before it.
            header: 'phone:py-3 phone:ps-4 phone:pe-14 phone:min-h-14 short:py-1.5 short:min-h-12',
            close: 'phone:top-2 phone:end-2 short:top-1 short:end-2',
            footer: 'phone:px-4 phone:py-3 phone:pb-[max(0.75rem,env(safe-area-inset-bottom))] short:py-2 short:pb-[max(0.5rem,env(safe-area-inset-bottom))]',
            body: 'phone:min-h-0 phone:p-4 phone:last:pb-[max(1rem,env(safe-area-inset-bottom))]',
          },
          compoundVariants: [
            { scrollable: false, fullscreen: false, class: { content: 'phone:top-auto! phone:bottom-[var(--vvb,0px)]! phone:left-0! phone:translate-x-0! phone:translate-y-0! phone:w-full! phone:max-w-none! phone:rounded-b-none phone:max-h-[calc(var(--vvh,100dvh)-0.75rem)]! phone:data-[state=open]:animate-[slide-in-from-bottom_200ms_var(--ease-out)] phone:data-[state=closed]:animate-[slide-out-to-bottom_200ms_var(--ease-out)]' } },
            { fullscreen: true, class: { content: 'phone:top-[var(--vvt,0px)]! phone:bottom-auto! phone:left-0! phone:h-[var(--vvh,100dvh)]! phone:w-full! phone:max-w-none! phone:max-h-none! phone:rounded-none!', header: 'phone:pt-[max(1rem,env(safe-area-inset-top))]' } },
          ],
        },
        popover: { slots: { content: 'phone:max-w-[calc(100vw-1rem)] phone:max-h-[min(var(--reka-popover-content-available-height,100dvh),calc(var(--vvh,100dvh)-1rem))] phone:overflow-y-auto' } },
        slideover: {
          compoundVariants: [
            { side: 'left', inset: false, class: { content: 'phone:top-[var(--vvt,0px)] phone:bottom-auto phone:h-[var(--vvh,100dvh)]' } },
            { side: 'right', inset: false, class: { content: 'phone:top-[var(--vvt,0px)] phone:bottom-auto phone:h-[var(--vvh,100dvh)]' } },
          ],
        },
      },
    }),
  ],
  // @cubby/shared is a linked source package (file:../cubby-shared): resolve
  // its three / vue / view-cube / Nuxt UI imports from this app, so there is one copy of each.
  resolve: { dedupe: ['three', 'vue', 'three-viewport-gizmo', '@nuxt/ui', 'manifold-3d'] },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    // Build outputs, staged engines and e2e artefacts churn during builds/tests.
    watch: { ignored: ['**/dist/**', '**/dist-*/**', '**/public/wasm/**', '**/e2e-out/**'] },
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
})
