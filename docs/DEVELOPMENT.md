# Development

Vue 3 + Nuxt UI 4 + three.js, built with Vite. Engines run in a Web Worker (`src/engine/`).

## Layout

```
src/
  app/          shell, actions (menus, palette, shortcuts), preferences, slice orchestration
  engine/       worker + client for the WASM engines (slice, cs_tool ops); capabilities.ts says what each engine can do
  project/      project types, import/export, persistence (3MF), primitives, plates helpers
    store/      the project store, split by concern (state, history, selection, objects, parts, plates, sliceInput, …); index.ts is the API
  plates/       per-plate settings and custom G-codes
  viewport/     three.js Prepare scene (bed, collision volumes, part styles)
  presets/      Orca / preFlight catalogs, inheritance, user presets, extruder variants (variants.ts, variantEdit.ts)
  settings/     schema-driven settings editor
    rules/      enable / show rules (Orca ConfigManipulation, generated + hand-ported); useRules.ts applies them to rows
  preview/      G-code parser and renderer
  paint/        painting tools (sessions run in the engine's TriangleSelector)
  tools/        cut, assembly, measure, text/SVG, boolean, simplify, brim ears, object colours
  layers/       variable layer height, height ranges
  calibration/  Orca calibration menu
  mixed/        Orca 2.5 mixed filaments (blends, gradients)
  plugins/      Orca Python plugins: manager/ (install, configs), runtime/ (Pyodide worker, `orca` shim), host/ (host API), ui/
  cloud/        CubbyCAD workspace storage
  localfs/      File System Access API files and folders
  printhost/    print host drivers, filament sync (filamentSync.ts)
  dialogs/      flushing volumes, bed shape, collision volumes, preset wizard, preferences, …
  ui/           AppDialog, dialogRequest, mobileDialog, toast, theme
  lib/          shared helpers: colour (parse / swatches), configValue (typed config reads), storage (safe Web Storage)
  cad/          CubbyCAD modelling: node trees on objects, frames, .cubby, shape panel
  design/       the Design tab (Orca 2.5 parametric CAD): kernel client + worker, document session, feature tree, commit to plate
  bridge/       MCP bridge tools for AI agents (see the cubby-mcp README)
docs/           ENGINE-CONTRACT.md, this file, user guide
scripts/        engine and asset staging; dev/ has the e2e, screenshot and extractor scripts
```

The CubbyCAD modelling core (shapes, evaluator, tree ops, shape palette and params form), gizmo, grid snap, keyboard nudge, camera projection, view cube, undo history, action registry and bridge client come from [@cubby/shared](https://github.com/JoshTheDerf/cubby-shared), which CubbyCAD uses too. To change them alongside the slicer, clone it next to this repo and link it (run the link again after `npm install`):

```bash
git clone git@github.com:JoshTheDerf/cubby-shared.git ../cubby-shared
npm link ../cubby-shared
```

### CubbyCAD modelling (`src/cad/`)

The modelling core is `@cubby/shared/cad` (shapes, evaluator, tree ops, set_node rules, the baked-mesh codec and the cad_to_slicer transfer helpers) and `@cubby/shared/cad/ui` (shape palette, params form). CubbyCAD runs on the same code. `src/cad/api.ts` is the slicer's only import point for it.

- A `ProjectObject` with `cad: { node }` is a CubbyCAD object: the root is a primitive or a manifold group, verbatim CubbyCAD JSON. Trees are immutable and `markRaw`; edits build a new root (shared `updateNode` / `applyCadNodeSettings`) and call `setCadNode`, which re-evaluates the mesh (cached by `hashCadNode`) and swaps the object's `meshId`. That's one `SnapshotOperation`: the tree is part of the snapshot, and paint (keyed by mesh id) resets like any mesh-replacing tool. Tools that replace a mesh some other way (cut, split, simplify, mesh boolean) drop the tree.
- Frames: CubbyCAD node transforms are in the Three render frame (Y-up). An object's mesh is `evaluateCadNode(wasm, root, { frame: 'zup' })` without the root's own transform. The object's TRS M (bed, Z-up) places it: world = M · R · E, with R = `RENDER_TO_ZUP` and E the subtree in the render frame. The stored root has no transform; `.cubby` import turns a root transform T into M = R · T · R⁻¹ (around the plate centre), and export does the reverse. Grouping turns each object's TRS into its child transform the same way, relative to the selection's bottom centre (`src/cad/frames.ts`). A picked child is moved with the gizmo on a proxy in object TRS · R · ancestors · node transform (`PrepareScene.setActiveCadNode`).
- A root hole (`contribution: 'subtract'`) is evaluated as a solid for display, drawn as a ghost and left out of `getSliceObjects`.
- Evaluation: CubbyCAD's manifold-group semantics cost tens of ms for a small group and seconds for trees of dozens of parts, so commands evaluate in a worker first (`warmCadMesh`, `src/cad/eval.worker.ts`) and then commit synchronously from the cache. The store's own `evaluateCadMesh` falls back to the main thread (tests, no Worker). A commit rebuilds from the current tree when it changed while the worker ran (undo, another edit). Slider edits are debounced, skip values while a slow tree is rebuilding, and close as one undo step (`queueParam`). An undo or project load while a drag's value is still evaluating cancels it first, so one Ctrl+Z always gives the pre-drag shape (`setPendingEditGuard`).
- Persistence: project 3MFs write the trees to `Metadata/cubby_cad.json` (keyed by object id) and leave them out of `cubby_slicer.json`; the autosave keeps them inline. `.cubby` import / export is in `src/cad/cubby.ts`. CubbyCAD geometry is always mm (a scene's `unit` is display-only).
- Bridge: `src/bridge/groups/cad.ts` mirrors CubbyCAD's tool names and arguments.
- `node scripts/dev/e2e-cad.mjs <url>` checks the palette, a slider drag, holes, group / ungroup, the child gizmo, `.cubby` and the project round-trip in a real browser.

### Design tab (`src/design/`)

OrcaSlicer 2.5's experimental Design tab, on Orca's own CAD kernel (libslic3r/CAD + OpenCASCADE) compiled to a separate WASM module, `public/wasm/cad/` — API in [CAD-KERNEL-CONTRACT.md](CAD-KERNEL-CONTRACT.md). Preference "CAD feature (experimental)" shows the tab (on by default).

```
design/
  kernel/types.ts      contract types for the methods used (snake_case keys, as the kernel sends them)
  kernel/protocol.ts   page ↔ worker messages
  kernel/cad.worker.ts hosts cad.mjs: one instance, cad_call with bounds-checked heap copies, traps reported as fatal
  kernel/client.ts     CadKernel: lazy start + progress, serial job queue, busy state, cancel = terminate, reset listeners;
                       WorkerBackend (the app) / any KernelBackend
  kernel/fake.ts       FakeKernel: in-process stand-in with the same envelope and result shapes (unit tests)
  kernel/fakeSketch.ts its sketch session (toy solver, the contract's sketch_* shapes, undo snapshots)
  kernel/mesh.ts       display / plate mesh blob decoding
  session.ts           the document tied to the project (below), runEdit, diagnosis scheduling
  diagnose.ts          first failing feature (binary search over history prefixes on a scratch copy)
  commands.ts          select / rename / suppress / move / delete / parameters / variables / bodies / commit / Edit in Design
  link.ts              plate object ↔ body links: identity, resolve, remap through history edits, sanitize
  fields.ts            parameter editor layout per feature type, typed by describe_tools (ref rows: kind + body field)
  pick.ts              pick-driven references: one field picks at a time, kind-restricted clicks, rollback copy for existing features
  tools.ts             feature cards: rows (Orca's labels / defaults), prefill from the pick, CadFeature fields, plane / standard helpers
  create.ts            the open card, preview ghost, Confirm / Cancel, Orca's offer menu, Volume and area, Check interference
  primitives.ts        CubbyCAD shapes / node trees → kernel features (exact) or import_mesh (mesh-backed)
  io.ts                STEP import / export, mesh import (files, plate objects)
  shapeBodies.ts       thin command wrappers the CubbyCAD side calls (palette, Convert to Design body)
  bodyColor.ts         Orca's body Color (system colour picker)
  state.ts             UI state (selection, pick and its edge set, view toggles, section view)
  datums.ts            datum planes / coordinate systems / mates to draw (Orca's refresh_datum_planes / refresh_mate_connectors)
  actions.ts           action registry entries (scope 'design')
  viewport.ts          handle of the mounted Design viewport (fit, view, screenPoint, capture, sketchView)
  sketch/model.ts      sketch JSON types + 2D geometry (sampling, nearest points, arcs through points, B-splines, plane frames)
  sketch/infer.ts      Orca's snapping / inference (end > centre > origin > midpoint > on curve; H / V within 3°)
  sketch/shapes.ts     the drawing tools: click sequences → entities + shape constraints + dimension queue
  sketch/constraints.ts the 25 constraint types: catalog, local planner for vertex selections, guards, names, wire units
  sketch/session.ts    the session: begin / finish / cancel, undo journal, coalesced drags, constraints + conflict search, edit ops
  sketch/driver.ts     pointer / key driver (select, drag, band, drawing, dimension and edit tools)
  sketch/committed.ts  finished sketches in the view + hit-testing (pick a region / stroke)
  sketch/outline.ts    Text / SVG → rigid imported regions;  sketch/expr.ts inline values (expressions over variables)
  sketch/quotes.ts     Orca's live measurement labels (render_live_quotes): what each entity / grouped shape shows, dim_text, the typed edits
  sketch/actions.ts    sketcher commands (scope 'sketch')
  scene/DesignScene.ts three.js scene (Prepare's camera / controls / lights / view cube), face & edge highlight + picking by kernel ids,
                       the section view (Prepare's SectionView, horizontal, no cap)
  ui/                  DesignView (layout, toolbar, busy, status, states), DesignPanel, FeatureTree, FeatureEditor, FeatureCard,
                       RefField, PickBanner, OfferMenu, BodiesList, VariablesTable, DesignViewport, LinkedObjectCard (Prepare),
                       SketchToolbar, SketchPanel, SketchOverlay (the live sketch), SketchesLayer (finished sketches),
                       DatumsLayer (datum planes, coordinate systems)
```

- **Loading.** Nothing CAD-related loads until `activateDesign()` (the tab opening, a commit, a bridge `design_*` tool). The tab's components are an async chunk; the kernel (21 MB wasm, ~4.5 s of static constructors) starts on the first job, in its own Worker. Every call goes through `CadKernel.run(label, job)`: jobs never interleave, `status.busy` names the running one and the UI shows it with Cancel.
- **Source of truth: the bytes.** The project's `Metadata/orca_cad.bin` (`getOrcaCadRecipe()` / `setOrcaCadRecipe()`, `src/project/persistence/passthrough.ts`) is the document; the kernel's open document mirrors it. `session.reconcile()` reopens the kernel document whenever the project's bytes are not the ones it holds: a project load or reset, undo / redo, a kernel reset. An unchanged design saves byte for byte (the kernel returns the original bytes until an edit); a recipe newer than the kernel opens read-only and is saved back unchanged; one it can't read at all is kept as opaque bytes.
- **Edits** (`runEdit`): one job makes the kernel call, then `doc_save`, `describe_scene`, `get_mesh` and, for linked plate objects, `export_mesh`; the page then commits in **one `mutate()`**: the new bytes and the linked objects' meshes. A geometry failure is not an error: the kernel rolled back, nothing is committed, and the message is shown on the feature (`design.featureErrors`). An edit whose job finishes after the project's bytes moved (undo during the rebuild) is discarded and the kernel reopened.
- **Undo: one history.** The bytes ride in every undo snapshot (`registerSnapshotSlot('design', …)` in `src/project/store/history.ts`), so Ctrl+Z / Ctrl+Y walk one list across Prepare and Design: a design edit and the plate meshes it replaced undo together, and a Prepare step undoes from the Design tab like any other. The kernel's own undo stack is not used: restoring bytes costs the same full replay as `undo`, and a second stack would diverge from the plate. Restoring a design state reopens it (seconds; the linked meshes come back at once from the snapshot).
- **Progress / cancel.** The worker sets the kernel's `Module.cadProgress`: every replayed feature is posted to the page (`status.rebuild`: "Feature 12 of 34 — Fillet 3", then tessellation) and the busy pill shows it. On a cross-origin isolated page Cancel sets a `SharedArrayBuffer` flag the callback reads, so the kernel stops the rebuild and rolls back cleanly (`cancelled:true`; the document stays open, nothing is committed; a cancelled open shows "Opening was cancelled"); if it doesn't answer within 4 s, or without isolation, the Worker is terminated as before.
- **Cancel / crash / memory.** A hard cancel terminates the Worker; a trap kills the instance; the heap never shrinks, so the client recycles the instance past 2 GB between jobs. All three flush the queue and `onReset` reopens the last saved bytes (a cancelled *open* stays closed with "Open the design").
- **A design that doesn't rebuild** (Orca's golden fixtures; desktop Orca the same) opens with no bodies. The kernel (v1.1) names the failing feature (`failed_feature` on every rebuild result and in `describe_scene`, whose `rebuild_ok` is the state — `error` can be a rolled-back edit's message). `diagnose.ts` (log₂(n) prefix probes on a scratch copy) only runs against a v1.0 kernel that doesn't report it. `generation` is not bumped by rolled-back / cancelled calls or `set_variable {rebuilt:false}`: compare values. The Variables card shows `variable_values` / `variable_errors`. Every history edit is transactional, so while the design fails, suppress is sent with `force` (the toggle is kept even if a later feature still fails); several selected features suppress with one rebuild (`indices`).
- **Commit to Plate** (`addDesignObjects`, `src/project/store/designObjects.ts`): one object per visible body with faces not on the plate yet, at the body's place in the design (the design frame is the bed's) unless that clashes, with a link `ProjectObject.design = { sourceFeature, ordinal, body, origin }`. After every edit the link is resolved by source feature + rank (`link.ts`; move / delete remap it in the same step) and the object's mesh replaced when the body changed (new mesh id → paint resets; unchanged geometry keeps mesh and paint). Mesh-replacing tools (cut, split, simplify, mesh boolean, repairs) drop the link, as they drop a CubbyCAD tree. Links are saved in `cubby_slicer.json` with the object; desktop Orca sees plain objects.
- **Selection.** Feature rows (Ctrl / Shift for several), the Bodies list and the viewport share Orca's one-selection rule. Viewport clicks cycle body → face → edge on one spot; face / edge picks carry the `generation` they came from (stale ids are refused by the kernel). Orca's one exception is the edge set: with an edge picked, Shift / Ctrl+click toggles other edges of the same body (`DesignPick.more`, `toggleSetEdge`), and the Fillet card's prefill takes them all. Orca has no multi-face or multi-body viewport selection (its rubber band picks one body). A selected feature highlights the faces it made (`faces_made_by`, no replay since kernel v1.1).
- **References** (`pick.ts`, `ui/RefField.vue`): a reference row's Pick button makes it *the* picking field (`picking.spec`); the viewport then hovers and clicks only that kind (face / edge — nearest on screen, off the silhouette too — / body / point on a face), multi rows toggle ids on one body, Enter / Done finishes, Esc restores. Values are `{ body, ids, point?, generation }`. New features are appended last, so their references are picked on the current design and checked against `design.generation` on Confirm (and by the kernel, v1.2). An **existing** feature's references name its *input*: editing them opens a scratch copy of the saved bytes with that feature and every later one suppressed (one prefix replay, `picking.rollback`) and shows it instead of the design while the field picks.
- **Feature cards** (`tools.ts` → `ui/FeatureCard.vue`, state in `create.ts`): one card at a time (Orca). A tool declares its rows (number / bool / enum / vec3 / pick / plane / body / sketch / sketches / datum / standard), Orca's defaults (`init`, prefilled from `designUi.pick`), guards (`needs`, `validate`, `required` rows), derived updates (`changed`: a picked face latches the hole plane and X/Y, a cylinder snaps the thread standard, a sketch picks Join vs New body) and the CadFeature `fields` — the same object `feature_preview` and `add_feature` take, so preview and commit can't drift. A `plane` row resolves to a name, a datum frame, an axis frame or the picked face (`plane_of_face`, flipped inward for holes / threads; a cylinder gives its axis). Confirm is one `runEdit` (one undo step) and sends the `generation` its picks came from (kernel v1.2 refuses stale face / edge ids in `add_feature` / `set_feature` with -32010; the parameter editor sends the generation its draft was loaded at); a Shell that changes nothing, or a closed hollow, is refused by the kernel itself (v1.2), so the Shell card requires an open face. Preview runs debounced while `lastRebuildMs` < 2.5 s, otherwise behind a Preview button. Adding a card: a `CreateTool` in `CREATE_TOOLS` (it appears in the Feature menu, the palette and `design.add.<id>`; give it a key in `actions.ts`) and, if the offer should list it, a line in `offerItems`.
- **Offer menu** (`offerItems`, `ui/OfferMenu.vue`): right click without a drag (the scene reports it; right-drag still orbits) picks what is under the cursor and lists Orca's families for it, using `face_info` / `edge_info` for the surface / curve type.
- **Datums in the view** (`datums.ts` → `ui/DatumsLayer.vue`, an SVG layer projected every frame like SketchesLayer): enabled Plane features at Size U × V (80 when unset; Orca's purple, over the model), resolved CoordSys as Orca's face glyph (`faceGlyph`, `render_mate_face`: its tables, shaded facets in painter's order, drawn over the model) or, with `preferences.designConnectorFace` off or the roll undefined, its disc (22 px in the frame's XY, quadrant, amber when Face + direction has no edge; drawn by the scene with the depth test, `DesignScene.setDepthStrokes`, rebuilt before every frame), plus a billboarded +Z arrow over the model (blue + filled head when a Mate — or the open Mate card's B — moves it), dashed mate links. Datum axes aren't drawn (Orca draws none); nothing while a sketch is open. With the Plane card on Offset / Angle, a click that hits no body inside a datum plane sets `plane_base` (Orca's base pick; `datumBaseClick` in DesignViewport).
- **View and analysis** (Orca's DesignPanel reports, all on the status line, none an edit): Volume and area (`mass_properties`; offer ▸ Reference; mm³ / mm², two decimals, no density), Check interference (`check_interference`; the feature tree header and the offer on a body; worst three pairs), Section View (`designUi.section`, actions `design.section*`: X, F, PageUp / PageDown ±2 mm; DesignScene drives `viewport/viewEffects.ts`'s SectionView at an absolute height without its cap, and picking skips what it hides).
- **Bodies**: colour (`set_body color`), rename, delete (= `delete_feature` of the source feature, remapped like any delete), visibility (view only; hidden bodies aren't committed). **Commit modes** (`preferences.designCommitMode`, Orca's `design_commit_mode`): `assembly` (default) is one object with a part per body (`addDesignAssembly`; `ObjectPart.design` links, relinked like objects', saved with the part), `bodies` one object per body. A project without objects but with a design opens to the Design tab.
- **Geometry in and out** (`io.ts`): `import_step` (one Import feature per solid, renamed after the file), `import_mesh` (files and plate objects, world placement), `export_step`; the app's STEP options dialog has **Open in Design** (`StepOptions.toDesign`).
- **CubbyCAD** (`primitives.ts`): the shared shape palette adds bodies in the Design tab (`cad.add.<id>` / `cad.palette` act on the design there) and Prepare's **Convert to Design body** (`object.to-design`) converts a node-tree object where it sits. A shape is exact when the kernel has an equivalent at its scale (box, cylinder, cone, sphere, hemisphere, torus, tube, capsule, polygon / star prisms, wedge, roof, half cylinder, fillet shape; bevels = a kernel fillet of every edge): built in its CubbyCAD frame from `extrude` / `revolve` verbs or a Sketch with arcs (the palette's box, cylinder, cone, sphere and torus use the kernel's primitive verbs instead — one Import feature holding the exact B-rep, desktop-Orca readable but not parametric; a kernel without them (-32601) gets the Sketch + feature path), placed by the node's world matrix (render-frame transforms conjugated to Z-up as `src/cad/frames.ts` explains), scale folded into the dimensions. Manifold groups become `boolean`s (adds joined, then holes subtracted, nested groups recursively). Anything else (other shapes, SDF / loft groups, shear, mirrors, CubbyCAD-only nodes) goes in whole as CubbyCAD's mesh through `import_mesh`, and the result says which shape forced it. Multi-call conversions undo their own kernel steps when one is refused.
- **Bridge**: `src/bridge/groups/design.ts` — `design_describe_scene`, `design_get_feature`, `design_set_feature`, `design_set_feature_expr`, `design_set_variable`, `design_suppress_feature`, `design_rename_feature`, `design_move_feature`, `design_delete_feature`, `design_query_topology`; the McpControl verbs `design_fillet`, `_chamfer`, `_shell`, `_draft`, `_hole`, `_hole_styled`, `_hole_standard`, `_thread`, `_pattern`, `_mirror`, `_transform`, `_boolean`, `_cut`, `_split`, `_thicken`, `_delete_face`, `_plane_datum`, `_axis`, `_helix`, `_extrude`, `_revolve`, `_sweep`, `_loft`; `design_add_feature`, `design_feature_preview`; reads `design_face_info`, `_edge_info`, `_plane_of_face`, `_datums`, `_mass_properties`, `_thread_standards`, `_hole_standards`; bodies `design_set_body`, `design_delete_body`, `design_add_primitive`, `design_convert_object`; files `design_import_step`, `design_import_mesh`, `design_export_step`; `design_commit {mode}`, `design_cancel`.
- **Sketcher** (`sketch/`). A session is the kernel's (`sketch_begin` {plane | face | feature} … `sketch_commit`); the page keeps a copy of its entities / constraints / solve state (`sk`), re-read after every call. **One app undo step**: nothing reaches the project until Finish, whose `sketch_commit` is one `runEdit` (`EditOptions.sketch` passes the guard that blocks every other design edit while a sketch is open, `setSketchGuard`). Inside the session `undoOverride` (src/app/shell/commands/edit.ts) routes Ctrl+Z / Ctrl+Y and Edit ▸ Undo to the kernel's `sketch_undo` / `sketch_redo`; each journal entry is the number of kernel steps one gesture made (every successful mutating session call is one step, verified), so a drag or a fillet with its bookkeeping undoes at once. Calls are quiet jobs (~1–7 ms plus the worker hop); drags are coalesced latest-wins with one call in flight. After a kernel reset the next call re-creates the session from the page's copy (begin, add, constrain with `force`). Keys: the action scope `design` becomes `sketch` while a sketch is open (`setActionScopeRefiner`, dispatch.ts), with Orca's sketch key map (actions.ts).
  - **Drawing** (driver.ts + shapes.ts): every click snaps (infer.ts); the snap shown is the constraint the click adds (`anchorConstraints`), shape constraints come with the shape, and the batch goes in with `sketch_add {infer:false}` + one `sketch_constrain` (refused batches fall back one constraint at a time and report what was left out). Then Orca's draw-then-edit dimension queue opens in the inline editor (SketchOverlay). Composite shapes are entities + constraints, as in Orca (rectangles, slots, polygons with a construction circle, rounded rectangles). The arc slot is Orca's four arcs, closed, tangent at every joint and inner / outer concentric (6 DOF); pinning the caps' centres to a centre-line arc as well is singular at the slot's own geometry and the solver refuses it, so its Radius is a distance from the centre to the start cap's centre. A tool's `snapClick` says which clicks snap (Orca's `click_snaps`).
  - **Constraints**: with the Select tool a click on a badge deletes its constraint (Orca's `remove_constraint_near`; `badgeClick`), Shift+click selects it. Entity selections go through the kernel planner (`sketch_plan`); selections with vertices (an end, a centre, a Point) are planned locally with Orca's rules (constraints.ts). `guard()` refuses what would trap the kernel. A refused constraint is not added; the session probes which existing constraints it conflicts with (dimensions first: delete one, retry, undo both — kernel steps) and names them, with Replace / Keep both (`force`). **Wire units**: angle constraint values are radians in the kernel (`toWire` / `fromWire`).
  - **Kernel quirks handled openly** (see the report in the sketch slice handoff): trim / extend re-solve after moving an end, so a constraint on that end pulls it back and the call "succeeds" with nothing changed — the constraints on the moved end are deleted first (Orca's GUI bookkeeping); fillet / chamfer keep the corner Coincident and drag the lines back to the corner — the corner constraint goes first, and the second Tangent is added after.
  - **Live measurement labels** (quotes.ts, Orca's `render_live_quotes`): for the lone selected / dragged entity (`quotedEntity`; not under the edit / transform tools) — line Length + Angle, circle Radius, arc Radius + sweep, ellipse half-axes (+ sweep) — at Orca's offsets (label height 15 px in plane mm) in `--vp-sketch-quote`, skipping a kind a dimension already drives. Grouped shapes (`shapeGroups`: Orca's `rebuild_features_from_entities` over consecutive closed chains, plus the drawing tool's shape constraints) show the shape's labels from any member, and a selection that is all one shape is quoted. A click (`promoteQuote`): Length / Radius → a driving `distance` / `radius` at the current value (a shape label: its `dim`, the tool's own size dimension), then its editor; a shape's angle → `sketch_ops transform` of the members + construction helpers about Orca's pivot (H / V dropped first); angle / sweep / half-axes → an editor that rewrites the entity (`sketch_set_entity`; a line's H / V go first), one sketch undo entry.
  - **View**: SketchOverlay projects the live sketch through the 3D camera every frame (SVG geometry, HTML badges, dimension labels and the inline editor), coloured by state (tokens `--vp-sketch-*`). The scene routes left-button / one-finger input to the driver while a sketch is open (`setSketchInput`; right-drag and two fingers still navigate) and turns the camera to the plane with its Y axis up (`sketchView`; OrbitControls' cached up frame is updated). Finished sketches (committed.ts / SketchesLayer) are drawn when nothing consumes them yet, when selected, or while a card has a Sketch row; a click inside a profile (even-odd over the projected strokes) or on a stroke picks the sketch into that row, else selects it; double-click edits it. In a sketch with several closed regions the click also picks the region under it (`designUi.region`, Orca's loop pick: `regionLoops` / `regionAt` / `loopEntityIndices` in model.ts port `region_loops` / `region_at` / `selected_loop_entities`): the Extrude card then sends that region's entities (and its holes') with the sketch's plane and `sketch_ref` -1, Orca's `add_extrude_entities`.
  - **Text / SVG**: rigid `imported_regions` (outline.ts: the app's fonts, the browser's SVG geometry) written on Finish with `set_feature` in the same `runEdit`, placed by `import_offset` / `import_scale_x/y` (point × scale + offset). The overlay draws Orca's TransformArt box: the centre handle moves them, a corner scales X and Y apart about the opposite corner (`dragRegionHandle`). A sketch with regions extrudes only them, so they go in a sketch of their own. **On a face** (Orca's `import_on_face`): Text / SVG outside a sketch (`design.text` / `design.svg`, the flat-face offer) open a sketch on the picked flat face with the outlines centred on its centroid (`face_info`, projected into the session plane: `sk.onFace`), else on XY; Finish writes `import_on_face` / `import_face_body`, and the Extrude card's `changed` reads them back: Cut, Flip (inward), that body.
  - **Bridge**: `design_sketch_begin`, `_describe`, `_add` (entities, `rect`, or a drawing tool + points), `_constrain` (conflicts named), `_plan`, `_set_constraint`, `_delete_constraint`, `_delete`, `_construction`, `_drag`, `_offset`, `_mirror`, `_ops` (trim, extend, fillet, chamfer, array, polar, transform, use_edges), `_text`, `_svg`, `_undo`, `_redo`, `_commit`, `_cancel` — angles in degrees.
- `node scripts/dev/e2e-design.mjs <url>` runs the whole flow against the real kernel (Orca's failing golden fixture → repair → face pick → edit → commit → slice → undo / redo → save → reopen), then the creation flow (`FLOWS=golden,create,verify,sketch` selects): Volume and area, the section view, a Shift / Ctrl+click edge set into the Fillet card and Check interference on a box → a palette box → fillet picked edges → shell with a picked open face → hole on a picked face → circular pattern → boolean with a second body → commit as an assembly → slice → save → reopen → edit → STEP out and back in (and through Open in Design) → two coordinate systems on picked faces (Shift+C, the card's Pick) and a flipped Fastened Mate from the offer (both connectors drawn, B driven, the mate link; a datum plane drawn and picked as the Plane card's base) → Surface Extrude / Fill, Thicken Surface from the offer on a sheet, Surface Offset → one region of a sketch extruded alone (plate with its hole, then a separate circle); then the verification flow: cooperative Cancel of a 50-feature rebuild (progress, clean rollback, same instance) and the terminate fallback on a page without cross-origin isolation, the Thread card (M8 external on a cylinder, internal in a bore), the icon-only body Pick, a design-only project opening on the Design tab, an STL as a mesh body, and the Extrude / Revolve / Sweep / Loft cards on the golden fixture's sketches; then the sketch flow (e2e-design-sketch.mjs): a fully constrained L-bracket drawn and dimensioned with the mouse, an over-constraining dimension refused with what it conflicts with, sketch-level Ctrl+Z, Extrude from the offer, a hole sketched on the top face and cut through, a dimension edit the solid follows, save → reopen → re-edit, fillet / offset / trim / extend, the other drawing tools, an arc slot sized through its Radius / Width fields, a constraint badge (Shift+click selects, a click deletes, Ctrl+Z restores), a drag, the bridge's `design_sketch_*` tools, a text sketch and an SVG outline dragged and scaled into place, the live measurement labels (a line's Length → a dimension, its Angle typed, an arc's labels during a drag, its sweep and Radius), text on a box's picked face from the offer, centred, engraved by the Extrude it defaults to. `scripts/dev/e2e-bridge.mjs` ends with every `design_*` MCP tool once (`DESIGN=0` skips). The unit tests (`src/design/design.test.ts`, `src/design/create.test.ts`, `src/design/sketch/sketch.test.ts`) use `FakeKernel`.

Commands are declared once in `src/app/actions/families/` and laid out in `src/app/actions/layouts/`. `npm test` includes a lint that catches unregistered ids and conflicting key bindings. Every action is registered under a source (`app` for the built-ins, `builtinActions()`); runtime contributors such as plugins call `registerActions(list, { id: 'plugin:<key>', name })` and dispose the returned handle or call `unregisterSource(id)`. The registry refuses ids owned by another source and drops a contributed key binding that collides with a live one (the lint's rule, `src/app/actions/lint.ts`). Keys of an open tool panel go through the registry too (`useToolKeys` in `src/tools/state.ts`), not through window listeners. User commands live in `src/app/shell/commands/` (barrel: `src/app/shell/actions.ts`).

### Dialogs on phones

One convention covers every UModal / USlideover / UPopover (`src/ui/mobileDialog.ts`). New dialogs use `src/ui/AppDialog.vue` (the modal with this convention, a width and the standard Cancel / primary footer). A dialog that only shows or hides keeps its open flag in the `dialogs` record (`src/dialogs/state.ts`); one that answers a question uses `dialogRequest` (`src/ui/dialogRequest.ts`), like the app's single confirm dialog (`confirmAction` / `chooseAction` / `askConfirm` in `src/app/shell/uiState.ts`). "Phone" means ≤ 640 px wide or ≤ 500 px tall (landscape): the `phone:` Tailwind variant, `short:` for ≤ 500 px tall, and the `mobileDialog` / `shortScreen` refs.

- The `modal` / `slideover` / `popover` theme in `vite.config.ts` turns a modal into a bottom sheet sized to the visual viewport (`--vvh` / `--vvt` / `--vvb`, so it rides above the on-screen keyboard), or full screen with `:fullscreen="mobileDialog"`. Header and footer stay pinned and the body is the only scroll region. The only desktop change: a header with a close button keeps `pe-14` free, so titles and header actions (search, mode) never run under it.
- `src/style.css` makes controls inside dialogs at least 40 px and text inputs 16 px (no iOS focus zoom); long names and paths wrap in every dialog at every size. Landscape form dialogs opt into a two-column flow with `dlg-flow` / `dlg-span`.
- Re-lay out rather than scroll: stack columns, use tabs or a select for secondary sections, and give inherently long content (settings lists, file lists, the G-code editor) one scroll region. The same holds on desktop: a dialog with its own scrolling list makes the body a flex column (`flex flex-col overflow-hidden`) and lets the list shrink (`flex: 1 1 <basis>; min-height: 0`) instead of scrolling the body around it (setup wizard, add printer).
- `node scripts/dev/e2e-mobile-dialogs.mjs <url>` opens every dialog at 360×640, 390×844, 375×667 and 844×390 and at desktop 1440×900 and 1024×768 (`ONLY=` / `SIZES=` / `DESKTOP_SIZES=` narrow it down, `DESKTOP=0` skips desktop). At every size it checks page and dialog overflow, fit, nested scrolling and overlapping header controls; on phones also touch targets, input font size and the on-screen keyboard. It lists what scrolls and saves screenshots to `e2e-out/mobile-dialogs/`. A data grid that scrolls sideways by design (the object table) carries `data-audit-scroll-x`.

### Menus

Dropdowns and context menus are Nuxt UI's (`UDropdownMenu` / `UContextMenu`, Reka underneath). Reka UI 2.10 closes an open submenu when the pointer moves on its own trigger; `src/ui/submenuGuard.ts` works around it with one capture-phase `pointermove` listener installed at start (`main.ts`) for the whole app. It only prevents the default of a move whose target is inside the trigger of a submenu that is open (`[data-reka-menu-content] [aria-haspopup="menu"][data-state="open"]`), so menus without submenus, sliders, the viewports and drags never see it; components don't install their own. Its test fails if the install is dropped while the installed Reka still has the bug.

## Engines

Build the ports next to this repo, then stage them into `public/wasm/<engine>/`:

```sh
git clone https://github.com/JoshTheDerf/orcaslicer-wasm ../slicers/orcaslicer-wasm
git clone https://github.com/JoshTheDerf/preFlight-wasm ../slicers/preflight-wasm

# One toolchain for both ports (the build scripts pick up ../slicers/wasm-deps).
cp -r ../slicers/orcaslicer-wasm/toolchain ../slicers/wasm-deps
(cd ../slicers/wasm-deps && bash bootstrap.sh && bash build-deps.sh all && bash build-deps.sh preflight-extras)

(cd ../slicers/orcaslicer-wasm && bash scripts/build-wasm.sh)
(cd ../slicers/preflight-wasm && bash scripts/build-wasm.sh)

bash scripts/fetch-orca-wasm.sh
bash scripts/fetch-preflight-wasm.sh
node scripts/stage-calib.mjs        # calibration + handy models → public/calib/
node scripts/stage-pyodide.mjs      # Pyodide 0.27.8 (Orca Python plugins) → public/pyodide/, loaded only when a plugin is used
```

Optional multi-threaded Orca build: `WASM_THREADS=1 bash build-deps.sh all-mt` in the toolchain, then `WASM_THREADS=1 bash scripts/build-wasm.sh`. `fetch-orca-wasm.sh` stages it into `mt/` (`ORCA_SKIP_MT=1` skips it).

`stage-pyodide.mjs` copies the Pyodide core from `node_modules/pyodide` and downloads the default packages (checked against `pyodide-lock.json`). `PYODIDE_PACKAGES=numpy,shapely` picks the packages, `PYODIDE_ALL=1` stages all of them (~250 MB).

The ABI and job format are in [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md). Each port has its own node tests (`tests/`).

### Prepare view: Orca 2.5 view options, prime tower, belt purge prism

- **Prime tower** (`app/towerPreview.ts` → `viewport/towerLayer.ts`): every plate that prints a tower shows the engine's footprint estimate (`wipe_tower_footprint`) at its anchor, one slab per plate filament, brim from the first-layer outline. A left drag (one finger) moves it, clamped like desktop's `Selection::translate`; the drop is one undo step (snapshot slot `primeTower`). On every change the anchor is re-placed as `GLCanvas3D::reload_scene` does (`slice.ts placePlateTower`; geometry in `app/wipeTowerPlace.ts`, ports of `estimate_wipe_tower_polygon`, `nearest_clear_wipe_tower_anchor`, `move_box_inside_polygon` with Orca's own test cases). Arrange reserves the tower in the engine (from `wipe_tower_x/y`).
- **Belt purge prism** (`app/beltPurge.ts`): desktop's `ensure_belt_purge_tower` — a "Belt Purge Tower" object per belt plate printing 2+ filaments, created / resized / removed by the app outside the undo history (`syncDerivedObjects`).
- **View options** (`viewport/controller.ts` state, `viewport/viewEffects.ts`): X-Ray (desktop's `xray.fs` as a material hook), section view (one clipping plane shared by Prepare materials and the Preview shaders' `uSection`, stencil caps; `SectionViewControl.vue`, Alt + wheel), center of mass markers (`massProps.ts` / `massMarkers.ts`, details in `MassDetails.vue`), focus mode (`PlateLayer.focus`, camera follows the plate).
- **IDEX/IQEX**: the printer's Modes grid (`plates/imexModes.ts`, `ImexModesEditor.vue`, rendered by `SettingsGroups` for `imex_mode_names`); ghost copies show which filament a carriage prints and, with 2+ lanes on a head (`physical_extruder_map`), open the filament picker (`imex_head_filament_map`).

Code asks `engineCaps(engine)` (`src/engine/capabilities.ts`) what an engine can do (Orca config keys, calibration, mixed filaments, threads, flush keys) instead of comparing engine ids.

### Engine metadata

The settings layout, the enable / show rules and the G-code placeholder list are generated from the engine sources and checked in. After an engine upgrade, regenerate them:

```sh
node scripts/dev/extract-engine-meta.mjs --orca <OrcaSlicer checkout> --schema public/wasm/orca/schema.json
```

From OrcaSlicer it writes `src/settings/layout/orca.generated.ts` (Tab.cpp pages, groups, keys), `src/settings/rules/orca.generated.ts` (ConfigManipulation / `toggle_*` rules), `src/dialogs/gcode/placeholders.generated.ts` and the test schema `src/settings/__fixtures__/orca-schema.sample.json`. From a preFlight git checkout (`--preflight <dir>`, `--ref v1.3.0`) it writes `preflight-schema.sample.json`, `src/settings/layout/preflight.generated.ts` and `src/presets/preflight/orcaKeyMap.generated.ts`.

- `--orca` takes the checkout root or its `src/`. Use a tagged checkout, not the engine port's working tree; `--orca-ref <tag>` reads files with `git show` instead.
- `--schema` adds the keys of the staged engine's `schema.json`, which catches keys the source parser can't see (helper-defined options). At runtime the real `schema.json` always wins.
- `--only orca|preflight|materials` runs one part (`materials`: MaterialType.cpp's table → `src/settings/rules/materialTypes.generated.ts`); `--orca-version` overrides the version read from `version.inc`.

Orca's automatic value changes and their dialogs (`ConfigManipulation::update_print_fff_config`, the `Tab::on_value_change` handlers, the filament / printer checks: spiral vase, prime tower vs. smooth timelapse, firmware retraction, first layer fan reset, …) are hand-written checks in `src/settings/rules/autoChanges.ts`; `src/settings/applyAutoChanges.ts` runs them after every settings edit (`setWithCoupled`, per-object settings) and, for the update-time checks only, after a preset is picked (`afterPresetSelect`, as `Tab::load_current_preset` does), and asks through the app's confirm dialog with Orca's message and buttons. Their test checks every static message against the Orca 2.5.0 source when `../slicers/orcaslicer-wasm/orca` is there.

Then run `npm test`: the layout test (`src/settings/layout/build.test.ts`) fails on an Orca key that is neither placed nor listed in `ORCA_UNPLACED` (`src/settings/layout/orca.ts`).

`node scripts/dev/extract-orca-plugin-api.mjs <orca source dir>` snapshots the `orca` Python module's API (`src/plugins/runtime/python/orca-api.json`) for the plugin shim's conformance test.

## Tests

```sh
npm test               # vitest
npm run typecheck
npx playwright install chromium
node scripts/dev/e2e-slice.mjs http://localhost:5173/slicer/      # and the other e2e-*.mjs
node scripts/dev/screenshots.mjs http://localhost:5399/slicer/    # docs/screenshots/, from `npx vite preview --port 5399`
node scripts/dev/e2e-bridge.mjs http://localhost:5393/slicer/     # MCP bridge tools through a real MCP client (needs ../cubby-mcp built)
node scripts/dev/e2e-plugins.mjs http://localhost:5421/slicer/    # Orca Python plugins: installs Orca's unmodified sample plugins (scripts/dev/fixtures/orca-plugins/)
node scripts/dev/e2e-plugins-pipeline.mjs http://localhost:5421/slicer/   # slicing-pipeline hooks: Orca's slicing samples on both engine builds, G-code checked
node scripts/dev/e2e-plugins-phase3.mjs http://localhost:5421/slicer/     # preset writes, plugin pages (+ get_icon), export_3mf_copy, settings picker / gate, .whl, storage,
                                                                          # blocking waits fed by UI callbacks (Orca's Preset Update Demo)
node scripts/dev/e2e-orca25.mjs http://localhost:5461/slicer/     # Orca 2.5 on the real engine: variants (H2D/H2C), mixed filaments, paint 17+, precise seam, prime tower
                                                                  # (placement, drag, relocation, arrange), purge modes, IDEX/IQEX/belt (+ belt purge prism), every
                                                                  # calibration, 3MF through Orca's loader (THREADS=1: single-threaded)
```

`src/engine/orca25.engine.test.ts` runs the staged 2.5 engine in node (skipped when none is staged). Other agents' edits make Vite reload the page mid-run: for long e2e runs serve without HMR (`server: { hmr: false, watch: { ignored: ['**/*'] } }`) and restart the server after changing code.

The e2e scripts use `?cubby-debug`, which exposes `window.__cubbyProject`, `__cubbyActions`, `__cubbyPresets`, `__cubbyTools`, `__cubbyCad` and `__cubbyDesign`.

## Deploying

`dist/` is a static site for the `/slicer/` base path. The server needs to:

- serve `.wasm` as `application/wasm` and `.mjs` as `text/javascript`
- send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on `/slicer/*` (needed for the multi-threaded engine, harmless otherwise)
- fall back to `index.html` for unknown paths

CubbyCAD storage reads its endpoint from `/editor/config.json`, which has to be on the same origin (the Directus session cookie is shared with the editor). The API is described in `cad-project/docs/workspace-backend/http-contract.md`. Writes upload to `/files` with `storage=cubbycad`, then `POST /workspaces/:id/assets/file/finalize`.
