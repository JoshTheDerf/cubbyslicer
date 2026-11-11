# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

CubbySlicer (one word, like CubbyCAD; never "Cubby Slicer") is a browser 3D-printing slicer, live at cubbycad.com/slicer. Vue 3 + Nuxt UI 4 + three.js + TypeScript, built with Vite. The UI follows OrcaSlicer; the slicing engines are OrcaSlicer 2.5.0 and preFlight 1.3.0 compiled to WebAssembly, run in a Web Worker. It is the companion slicer of the CubbyCAD editor. AGPL-3.0-or-later.

## Commands

```bash
npm install
npm run dev          # http://localhost:5173/slicer/
npm test             # vitest run (includes the action-registry and settings-layout lints)
npm run typecheck    # vue-tsc -b
npm run build        # typecheck + vite build → dist/ (base /slicer/)
```

Engines, calibration models and Pyodide are staged into `public/` by `scripts/` and are not committed. Engine builds, the e2e scripts (`scripts/dev/e2e-*.mjs`, run against a dev server with `?cubby-debug`), screenshots and the engine-metadata extractor are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Where things are

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): the `src/` layout, engines, metadata extraction, tests, deploying.
- [docs/ENGINE-CONTRACT.md](docs/ENGINE-CONTRACT.md): the C ABI and job format the engine ports implement.
- [docs/USER-GUIDE.md](docs/USER-GUIDE.md): user-facing behaviour.
- Modelling core, gizmo, undo history, action registry and bridge client come from `@cubby/shared` (`npm link ../cubby-shared` to work on it).

## Conventions

- **Commands** are actions declared once in `src/app/actions/families/` and placed in menus / toolbars by `src/app/actions/layouts/`. Menus, the command palette, shortcuts and the MCP bridge all run them. The registry lint (in `npm test`) fails on unregistered ids and conflicting key bindings. Don't add window key listeners; tool panels use `useToolKeys`.
- **Dialogs**: new dialogs use `src/ui/AppDialog.vue`. Open / closed state for show-or-hide dialogs lives in the `dialogs` record (`src/dialogs/state.ts`); a dialog that answers a question uses `dialogRequest` (`src/ui/dialogRequest.ts`). Follow the phone rules in DEVELOPMENT.md ("Dialogs on phones").
- **Engines**: ask `engineCaps(engine)` (`src/engine/capabilities.ts`) what an engine can do; don't compare engine ids.
- **Config values** are engine-native strings or string vectors, and many Orca 2.5 keys are per extruder variant. Read them with `src/lib/configValue.ts` (`valueAt`, `asList`, `cfgString`, the variant helpers), not `[0]`.
- **Settings**: controls come from the engine's `schema.json`; page layout and enable / show rules come from generated tables (`src/settings/layout/*.generated.ts`, `src/settings/rules/orca.generated.ts`) plus hand patches (`orca.ts` next to each). Regenerate the tables with `scripts/dev/extract-engine-meta.mjs`; don't hand-edit them. `src/settings/useRules.ts` applies the rules to rows.
- **Project state** lives in `src/project/store/` (import `project/store`). Change it only through store commands; each runs in `mutate()`, which is one undo step and marks the slice stale.
- **Shared helpers** are in `src/lib/` (colour parsing and swatches, config reads, safe `localStorage` via `storage.ts`).
- **Mixed filaments** are OrcaSlicer 2.5's native colour mixing (`src/mixed/`). The Full Spectrum engine is gone.
- **Agents**: `src/bridge/` exposes the app to AI agents through cubby-mcp. Keep its tools and descriptions in step when you change a feature they cover.

## Gotchas

- Projects are OrcaSlicer 3MF files; desktop Orca and Bambu Studio must still open what we write. Data we don't model is carried through (`src/project/persistence/passthrough.ts`); don't drop it.
- The page is cross-origin isolated (COOP / COEP). The multi-threaded engine and plugin host reads depend on it, and every fetched resource must allow it.
- Stored state uses `cubby-slicer:` / `cubby.` keys in `localStorage`; go through `src/lib/storage.ts`, which survives blocked storage.
- Orca 2.5 allows 32 filament slots (colour painting included), and slots after the physical filaments are mixed filaments: a filament number isn't always a physical filament index.
