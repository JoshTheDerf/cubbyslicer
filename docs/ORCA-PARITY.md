# Parity with OrcaSlicer 2.5.0

What CubbySlicer does not yet do, or does differently, compared with desktop OrcaSlicer 2.5.0.
Everything not listed here is meant to behave as desktop does; if it doesn't, that is a bug.

## Not possible in a browser

- **Orca Cloud plugin hub.** Its API only accepts requests from `cloud.orcaslicer.com` and needs an Orca login. Plugins install from a file or URL; the hub tab links out.
- **Plugins:** subprocesses, raw sockets, OS threads, arbitrary filesystem access, printer-connection (agent) plugins. Dependencies must be pure Python or shipped with Pyodide.
- **Bambu device tab, printer agents, filament sync from a connected Bambu printer** ("Smart filament assign", rack contents reported by the printer).
- **Printers that don't allow cross-origin requests** (for example UltiMaker, which is http-only) need a proxy; the printer setup help shows one.
- **Printer WebSockets from https://cubbycad.com.** A page served over HTTPS may not open a `ws://` socket to a LAN printer: Chrome refuses it outright (`SecurityError`, even for a private IP and with Local Network Access allowed, which only exempts `fetch`; checked in Chromium 147), and Firefox and Safari block it too. Creality Print's port-9999 socket (reading the CFS for Sync filaments and the send dialog's mapping, starting a print) and Elegoo's port-3030 socket therefore work only through a `wss://` proxy entered as the printer's WebSocket URL.

## Not done

### Slicer
- **Texture Displacement** tool and texture painting. Projects that contain texture layers keep them through open and save. The engine can bake geometry (`cs_tool texture_displacement`); the colour output and the UI are not built.
- **Import of textured / coloured models** (glTF, GLB, FBX) and the Import Model dialog. Work in progress is parked in the engine port: `orcaslicer-wasm/docs/TEXTURE-IMPORT-NOTES.md`.
- **`.gcode.3mf` export** leaves some `slice_info.config` values as desktop writes them when it has no data, because the engine doesn't report them yet: first-layer time, toolpath-outside flag, slice warnings, per-plate filament grouping on multi-nozzle printers (H2D / H2C), layer filament and change sequences, mixed filaments used, and `plate_N.json` first-layer bounding boxes. Single-nozzle printers are exact.
- **Preview:** centre-of-mass markers (needs per-object masses from the engine's G-code processor). Translucent filaments use desktop's order-independent transparency, its opacity by the path through the extrusion and its cut at the joints, but the cut is in screen space (the toolpaths here are screen-space capsules, not desktop's boxes), so where two segments of very different widths meet the seam can differ slightly from desktop. Without half-float render targets (some phones) the preview falls back to a single blended pass, as desktop's OpenGL ES build does.
- **Mixed filaments:** Orca's lab-measured colours come from the engine; before the engine has loaded, swatches use the computed pigment blend.

### Design tab (experimental)
- **Closed hollow shell** (no open face) is refused: Orca's own result for it is not a hollow body.
- **Internal threads** follow Orca's behaviour, including its failure when the bore equals the thread's minor diameter.

### Plugins
- Resource-texture plugins have nothing to feed until Texture Displacement exists.
- The plugin worker runs on the app's origin with dangerous globals removed. Moving it to its own origin is a deployment change that has not been made.

## Deliberate differences

- **Speed Dial:** Ctrl+K and Ctrl+Shift+P also open the command palette (Ctrl+K is Clone in Orca); "Open the Speed Dial from the keyboard" turns off only Space, Orca's Speed Dial key.
- **Published 3MFs:** a filament published in full becomes a standalone user preset (desktop makes it a preset that lives only inside the project); CubbySlicer has no project-only presets and also keeps a desktop project's embedded presets as user presets.
- **MCP bridge and automatic value changes:** where desktop asks (spiral vase, layer height limits, prime tower, …), the bridge takes desktop's suggestion (Yes / OK) without a dialog and reports it in the tool result. A project opened through the bridge asks in the browser, as an opened project does on desktop.
- **Calibration:** where a filament's max volumetric speed or a machine speed limit is unset, Orca computes a speed of 0, which the engine refuses; CubbySlicer keeps the profile's speed.
- **Height ranges:** settings the engine doesn't know are kept and written back (desktop drops them).
- **Filament renumbering:** two desktop slips are not copied (a part's renumbered support filament written onto its object; a stray custom G-code entry on replace).
- **Section view and focus mode** controls sit in CubbySlicer's own toolbars.
- **Plugin dock panels:** a panel docked left gets its own column between the sidebar and the 3D view (desktop stacks it in the sidebar's column). Panels can be docked left, right or bottom (desktop's drag also reaches the top dock). The layout is saved on every change rather than when the app closes. On phones a dock panel is a bottom sheet.
- **Extruding one region of a sketch** (Orca's loop pick) happens only when the sketch has more than one closed region; with a single profile the Extrude keeps following the sketch (Orca copies the loop into the Extrude whenever one was clicked).
- **Text / SVG on a face** are in the offer of a picked flat face (and the command palette); Orca lists its Text / SVG verbs only in sketch mode, where they land on the sketch's plane, which here is still the case inside an open sketch.
- **Sketch shape labels:** Orca records each drawn shape as a group while drawing and edits its sizes geometrically (`set_slot`, `set_rounded_rect`…). This sketcher keeps shapes as entities and constraints, so it recognises them as Orca does for a re-opened sketch (`rebuild_features_from_entities`) and also requires the constraints the drawing tool gave the shape; a size label becomes the driving dimension the tool's own size fields use, and an angle label turns the shape with its construction geometry. An oblique rectangle's angle label is clickable (Orca reaches it only through the draw-then-edit fields).
- **Coordinate system card:** Orca's "Body" filter (others go see-through while picking) is not there; the card refuses Face + direction without a face (Orca adds it and reports "face not found").

## Verification debts

- The CAD kernel's golden numbers come from its own WASM build; no native OrcaSlicer was available to compare against.
- Third-party STEP files have not been tested in the Design tab.
- Sketch mirror, move / rotate / scale and the two array operations were checked against the kernel but not through the UI.
- Plugins and the Design tab have been run in Chromium only.
- Print-host filament sources and mappings with no hardware here (Happy Hare `mmu` gates, a Creality Hi's CFS `box` object, the Qidi Box slots and filament dictionary, the Creality K-series CFS slot query, its Sync filaments preset scoring and colour-mapped print start) are tested only against replies shaped after OrcaSlicer's parsing code, never against a real printer.
