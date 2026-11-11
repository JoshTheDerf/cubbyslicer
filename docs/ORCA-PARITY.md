# Parity with OrcaSlicer 2.5.0

What CubbySlicer does not yet do, or does differently, compared with desktop OrcaSlicer 2.5.0.
Everything not listed here is meant to behave as desktop does; if it doesn't, that is a bug.

## Not possible in a browser

- **Orca Cloud plugin hub.** Its API only accepts requests from `cloud.orcaslicer.com` and needs an Orca login. Plugins install from a file or URL; the hub tab links out.
- **Plugins:** subprocesses, raw sockets, OS threads, arbitrary filesystem access, printer-connection (agent) plugins. Dependencies must be pure Python or shipped with Pyodide.
- **Bambu device tab, printer agents, filament sync from a connected Bambu printer** ("Smart filament assign", rack contents reported by the printer).
- **Printers that don't allow cross-origin requests** (for example UltiMaker, which is http-only) need a proxy; the printer setup help shows one.

## Not done

### Slicer
- **Texture Displacement** tool and texture painting. Projects that contain texture layers keep them through open and save. The engine can bake geometry (`cs_tool texture_displacement`); the colour output and the UI are not built.
- **Import of textured / coloured models** (glTF, GLB, FBX) and the Import Model dialog. Work in progress is parked in the engine port: `orcaslicer-wasm/docs/TEXTURE-IMPORT-NOTES.md`.
- **`.gcode.3mf` export** leaves some `slice_info.config` values as desktop writes them when it has no data, because the engine doesn't report them yet: first-layer time, toolpath-outside flag, slice warnings, per-plate filament grouping on multi-nozzle printers (H2D / H2C), layer filament and change sequences, mixed filaments used, and `plate_N.json` first-layer bounding boxes. Single-nozzle printers are exact.
- **Preview:** centre-of-mass markers (needs per-object masses from the engine's G-code processor); order-independent transparency for translucent filaments (a simple blended pass is used).
- **Print hosts:** Moonraker Happy Hare object fallback and Creality CFS mapping; Qidi Box slot contents.
- **Published 3MFs:** a "full" published filament lands as unsaved edits on its slot (desktop creates a project-only preset); the setting-id scoring tier and mixed-slot colours are missing.
- **Automatic value changes** run on edits and on preset selection, but not when a project is opened or when the MCP bridge or a plugin changes a setting.
- **Speed Dial:** Ctrl+K opens the palette here (it is Clone in Orca); the two Speed Dial preferences are not wired; settings rows have no wiki links.
- **Mixed filaments:** Orca's lab-measured colours come from the engine; before the engine has loaded, swatches use the computed pigment blend.

### Design tab (experimental)
- **Sketcher:** arc slot; splitting a curve (trim that removes the middle); dragging text / SVG outlines into place (they are positioned by typing X / Y); click-to-delete constraint badges; live measurement labels; snapping to body edges while drawing; per-entity free / constrained colouring; live expressions on constraint values.
- **Features:** surface features, coordinate systems, mates, pattern along a curve, extruding one chosen region of a sketch with several, text / SVG on faces.
- **View and analysis:** section view, mass properties, interference check; Shift+click multi-select outside a feature card.
- **Primitive bodies** (box, cylinder, cone, sphere, torus) are fixed-size, not parametric.
- **Closed hollow shell** (no open face) is refused: Orca's own result for it is not a hollow body.
- **Internal threads** follow Orca's behaviour, including its failure when the bore equals the thread's minor diameter.

### Plugins
- Blocking waits that keep UI callbacks running (Orca's Preset Update Demo).
- Page tab icons; real dock-panel docking (panels float).
- Resource-texture plugins have nothing to feed until Texture Displacement exists.
- The plugin worker runs on the app's origin with dangerous globals removed. Moving it to its own origin is a deployment change that has not been made.

## Deliberate differences

- **Calibration:** where a filament's max volumetric speed or a machine speed limit is unset, Orca computes a speed of 0, which the engine refuses; CubbySlicer keeps the profile's speed.
- **Height ranges:** settings the engine doesn't know are kept and written back (desktop drops them).
- **Filament renumbering:** two desktop slips are not copied (a part's renumbered support filament written onto its object; a stray custom G-code entry on replace).
- **Section view and focus mode** controls sit in CubbySlicer's own toolbars.

## Verification debts

- The CAD kernel's golden numbers come from its own WASM build; no native OrcaSlicer was available to compare against.
- Third-party STEP files have not been tested in the Design tab.
- Sketch mirror, move / rotate / scale and the two array operations were checked against the kernel but not through the UI.
- Plugins and the Design tab have been run in Chromium only.
