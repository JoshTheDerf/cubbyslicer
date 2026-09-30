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
