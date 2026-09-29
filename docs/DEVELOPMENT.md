# Development

Vue 3 + Nuxt UI 4 + three.js, built with Vite. Engines run in a Web Worker (`src/engine/`).

## Layout

```
src/
  app/          shell, actions (menus, palette, shortcuts), slice orchestration
  engine/       worker + client for the WASM engines (slice, cs_tool ops)
  project/      project store, undo, plates, import/export, persistence
  viewport/     three.js Prepare scene
  presets/      Orca / preFlight catalogs, inheritance, user presets
  settings/     schema-driven settings editor
  preview/      G-code parser and renderer
  paint/        painting tools (sessions run in the engine's TriangleSelector)
  tools/        cut, assembly, measure, text/SVG, boolean, simplify, brim ears
  layers/       variable layer height, height ranges
  calibration/  Orca calibration menu
  mixed/        Full Spectrum mixed filaments
  cloud/        CubbyCAD workspace storage
  localfs/      File System Access API files and folders
  printhost/    print host drivers
  dialogs/      flushing volumes, bed shape, preset wizard, preferences, …
  bridge/       Claude Code bridge tools (see the cubby-mcp README)
docs/           ENGINE-CONTRACT.md, this file, user guide
scripts/        engine staging; dev/ has e2e and screenshot scripts
```

The gizmo, grid snap, keyboard nudge, camera projection, view cube, undo history, action registry and bridge client come from [@cubby/shared](https://github.com/JoshTheDerf/cubby-shared), which CubbyCAD uses too. To change them alongside the slicer, clone it next to this repo and link it (run the link again after `npm install`):

```bash
git clone git@github.com:JoshTheDerf/cubby-shared.git ../cubby-shared
npm link ../cubby-shared
```

Commands are declared once in `src/app/actions/families/` and laid out in `src/app/actions/layouts/`. `npm test` includes a lint that catches unregistered ids and conflicting key bindings.

## Engines

Build the ports next to this repo, then stage them into `public/wasm/<engine>/`:

```sh
git clone https://github.com/JoshTheDerf/orcaslicer-wasm ../slicers/orcaslicer-wasm
git clone https://github.com/JoshTheDerf/preFlight-wasm ../slicers/preflight-wasm

# One toolchain for both ports (the build scripts pick up ../slicers/wasm-deps).
cp -r ../slicers/orcaslicer-wasm/toolchain ../slicers/wasm-deps
(cd ../slicers/wasm-deps && bash bootstrap.sh && bash build-deps.sh all && bash build-deps.sh preflight-extras)

(cd ../slicers/orcaslicer-wasm && bash scripts/build-wasm.sh && bash scripts/build-fullspectrum.sh)
(cd ../slicers/preflight-wasm && bash scripts/build-wasm.sh)

bash scripts/fetch-orca-wasm.sh
bash scripts/fetch-fullspectrum-wasm.sh
bash scripts/fetch-preflight-wasm.sh
node scripts/stage-calib.mjs        # calibration + handy models → public/calib/
```

Optional multi-threaded Orca build: `WASM_THREADS=1 bash build-deps.sh all-mt` in the toolchain, then `WASM_THREADS=1 bash scripts/build-wasm.sh`. `fetch-orca-wasm.sh` stages it into `mt/` (`ORCA_SKIP_MT=1` skips it).

The ABI and job format are in [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md). Each port has its own node tests (`tests/`).

## Tests

```sh
npm test               # vitest
npm run typecheck
npx playwright install chromium
node scripts/dev/e2e-slice.mjs http://localhost:5173/slicer/      # and the other e2e-*.mjs
node scripts/dev/screenshots.mjs http://localhost:5399/slicer/    # docs/screenshots/, from `npx vite preview --port 5399`
node scripts/dev/e2e-bridge.mjs http://localhost:5393/slicer/     # Claude Code bridge tools through a real MCP client (needs ../cubby-mcp built)
```

The e2e scripts use `?cubby-debug`, which exposes `window.__cubbyProject`, `__cubbyActions`, `__cubbyPresets` and `__cubbyTools`.

## Deploying

`dist/` is a static site for the `/slicer/` base path. The server needs to:

- serve `.wasm` as `application/wasm` and `.mjs` as `text/javascript`
- send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on `/slicer/*` (needed for the multi-threaded engine, harmless otherwise)
- fall back to `index.html` for unknown paths

CubbyCAD storage reads its endpoint from `/editor/config.json`, which has to be on the same origin (the Directus session cookie is shared with the editor). The API is described in `cad-project/docs/workspace-backend/http-contract.md`. Writes upload to `/files` with `storage=cubbycad`, then `POST /workspaces/:id/assets/file/finalize`.
