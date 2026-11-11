# User guide

CubbySlicer works like OrcaSlicer, with the same menus, tools and shortcuts (press `?` for the list, Ctrl+K for the command palette). This page only covers what's different in the browser version.

## Engines

Pick OrcaSlicer (2.5.0) or preFlight at the top of the Printer section. Each engine keeps its own presets. The accent colour shows which engine is active: green for Orca, orange for preFlight.

Calibration prints, brim ears and mixed filaments need OrcaSlicer. The Full Spectrum engine has been removed: OrcaSlicer 2.5 mixes colours itself (see [Mixed filaments](#mixed-filaments)).

## First-run setup

On your first visit (at any window size, including phones), a short setup asks for your printer, then your filament.

- **Printer:** pick a vendor and model, then Use next to your nozzle size (0.4 mm, the usual one, is marked "common"). Add puts a printer in your printer list without switching to it.
- **Filament:** the list shows filaments made for that printer, with the current one named at the top.
- **The last step** sums up your choices. Import model… opens a file straight away.

To rerun the setup, use Help ▸ Printer & filament setup… or the command palette.

## Top bar

From left to right, the top bar has:

- the sidebar toggle;
- the menus (a ☰ menu in a narrow window);
- save, undo and redo;
- the Prepare / Preview switch;
- the project name (click it to rename);
- command search;
- the slice controls.

After slicing, the bar shows the print time (and weight on wide screens). The slice button turns into "Sliced" and Export G-code becomes the main button. On a phone the bar keeps only the sidebar and menu buttons, the view switch and the slice controls.

File ▸ Export plate sliced file and Export all sliced file save the sliced plates as a `.gcode.3mf`, the file Bambu Lab printers take (G-code with plate thumbnails, print time, weight and filaments); for Bambu Lab printers and printers with "Support 3MF as gcode" they are also in the slice button's menu.

When a setting has an invalid value, the slice controls show "N settings to fix" and slicing is blocked. Click it for the list, and click a setting there to go to it. When slicing fails, click "Slicing failed" for the reason, with Copy and Try again.

## Preferences

Ctrl+, (⌘, on a Mac) opens Preferences. Its sections are General, Slicing, Behaviour, Camera and "Clear my choice on…". "Show options when adding a primitive" decides whether adding a box, cylinder, sphere or slab part asks for its size first (the size dialog's "Don't show again" turns it off). A preference you've changed gets a ↶ button that puts back its default. "Reset all to defaults" resets everything, and the toast it shows has an Undo. "Clear my choice on…" lists what the app remembers between visits, such as the first-run setup and folded panels, each with its own Clear button. Everything is saved in this browser.

## Command palette (Speed Dial)

Space (when no text field has focus), Ctrl+K or Ctrl+Shift+P (⌘K, ⌘⇧P on a Mac) opens the command palette, CubbySlicer's version of OrcaSlicer 2.5's Speed Dial.

- **Empty search:** it lists your pinned commands, your recent commands, then every command by menu.
- **Pins:** Ctrl+B (⌘B) pins or unpins the highlighted command, up to 10. While the palette is open, Alt+1 … Alt+9 and Alt+0 (Option on a Mac) run pinned commands 1 to 10. Right-click a pinned command to unpin it.
- **Footer:** it describes the highlighted command or setting. F1 opens its OrcaSlicer wiki page when it has one.
- **Typing:** it lists matching commands, then matching settings with where each one lives (for example "Process › Strength › Infill"). Pick a setting to go straight to it, highlighted. When more settings match than fit, "Search all settings" opens the full settings search with what you typed.
- **Toggles:** they say what choosing them will do ("Hide travel moves", "Turn off dim layers below top"). The selected option of a set, such as the settings mode or the camera, is marked "current".

Help → Keyboard shortcuts lists every shortcut; type in its search box to find one by name or by key ("ctrl+d").

## Plate toolbar

Orca's tools, grouped by task: add, edit, place (arrange, auto orient, lay on face), transform, modify (cut, mesh boolean, text), print adjustments (painting, variable layer height, brim ears) and measure. The four paint tools share the brush button's menu; L, P, N and H still open them directly. In a narrow window the groups that don't fit move into the ⋯ menu at the end.

## Plates

The plate bar (bottom centre) has a tab per plate. Each tab shows its object count, a warning if something on it won't print as placed, a lock, a settings icon if it has plate settings, and its slice state. Click a tab to go to that plate, double-click it to rename it, or use the arrow keys when a tab has focus. The active tab's ⌃ button, or a right-click on any tab, opens that plate's menu, which lists only what applies: slice, export its G-code once sliced, arrange, auto orient, select its objects, move the selection there, rename, lock, plate settings and delete. With more tabs than fit, the bar scrolls and keeps the active plate and the + button in view. Bottom left, the plate summary counts objects that are outside the plate, too tall, in an excluded area or overlapping; click one of those to select the objects it counts.

## Preview

After slicing, Preview shows the G-code: the legend (top left), the layer slider (right) and the move slider (bottom).

- The legend's colour scheme menu picks what the colours mean. With Line type, click a row to hide or show that line type.
- The Show and Total Estimation parts of the legend fold on their own, and the legend remembers how you left them. Folded, Show counts how many options are on and Total Estimation gives the time, weight and layer count.
- L folds the whole legend down to its scheme menu and the same one-line total. Click that line to open the legend again.
- The move slider steps through the moves in the top layer. The G-code line above it follows the slider and stays inside the bar on a phone.
- With the Filament colour scheme, translucent filaments (an alpha value in the filament colour, `#RRGGBBAA`) are drawn see-through. The legend's Show list has a "Translucent filaments" switch for this when a filament is translucent.
- G opens the G-code viewer and F fits the print. The keyboard button lists the other shortcuts.

## Settings sidebar

The sidebar runs top to bottom: Printer (engine, printer preset, plate type), Filament, Objects and Process. Click a section's header to fold it; folded sections show what they hold, such as the printer name. Under Process, the Global / Per object switch picks between the plate-wide process preset and the selected object's own settings. Per object shows how many objects have their own settings. Long setting labels wrap onto a second line instead of being cut off, and in a narrow sidebar the page tabs tighten so every label still fits. Drag the sidebar's edge to resize it, and double-click the edge to reset its width.

Filament swatches show what the filament colour holds: a checkerboard behind translucent colours, and bands or a gradient for multi-colour filaments. Clicking a filament's swatch opens OrcaSlicer 2.5's colour picker: a hue / lightness field with a saturation slider, hex, opacity, HSL and RGB fields, Solid or Gradient (up to seven colours: click a stop to edit it, − / + remove or add one), the original colour, the star button that saves the colour to the 16 favourites, and the palette panel (Basic Colors, Orca Palette, RAL Classic, Gradients, with a search). A segmented multi-colour filament opens as its first colour and stays as it is unless you pick another. Colour settings use the same picker without opacity and gradients.

Settings follow OrcaSlicer's rules: a setting that doesn't apply with the current values is greyed out or hidden, and its tooltip says why ("Disabled: …"). A search jump to a hidden setting shows it dimmed with the reason.

### Nozzles and variants

Printers with more than one extruder or more than one nozzle flow type (Standard, High Flow, …) get a line per nozzle under the printer preset: its flow type, and on multi-extruder printers its diameter. The flow type picks the profile values for it. On an extruder with a nozzle rack, Hybrid lets each filament pick its own flow type in the Filament section's Grouping dialog, and the rack line under it sets how many nozzles of each type the rack holds (the pencil opens OrcaSlicer's "Set nozzle count"). In Grouping ▸ Custom the nozzle titles show those counts; a grouping that needs a flow type the rack has no nozzle of is refused with OrcaSlicer's message and a link to set the count, and "Set the physical nozzle count..." asks for each rack. A project saved with Nozzle Manual grouping opens on the Custom page, as in OrcaSlicer (OK there saves it as Custom).

Some process, printer and filament settings hold one value per extruder and flow type (a split icon after the label). Their settings pages then have a switch at the top that picks which one you edit (a dot marks one with changes). On process and printer pages with two nozzles, the copy button next to it copies the edited nozzle's changes to the other one.

## Printer and filament settings

The edit button next to the printer or a filament opens its settings dialog: the preset picker at the top, the pages on the left and the page's settings on the right. A dot marks pages with changes. Once you change something, a Changed page appears at the top of the list. It shows every setting that differs from the preset, grouped by page and section. Revert a setting there with its ↶ button, or keep the changes with the preset's save button. The page closes itself when nothing is left on it. On a phone the pages, including Changed, are in the page menu under the preset.

Printer settings ▸ Basic information ▸ Printable space ▸ Toolhead collision volumes has an edit button that opens the collision volume editor: prisms the toolhead must not enter, each an outline on the bed (one `XxY` point per line) with an optional Z range, drawn over the bed outline. They add to the excluded bed area. Ctrl+Shift+K (Show all collision volumes, in the command palette) draws them on the plate.

## Objects list

The Objects list in the sidebar shows every object, under its plate when there is more than one plate. Instances of the same model share a row you can fold, and an object's parts, modifiers and height ranges fold under it (← and → fold the selected object). Click, Ctrl-click and Shift-click select. ↑ and ↓ move the selection, and Home and End jump to the first and last object. Double-click (or F2) renames an object, part or plate. Right-click an object for the object menu, a part for its type and settings, or a plate row for the same plate menu as the plate bar. Plate rows warn when something on the plate won't print as placed. With two or more objects, the filter button narrows the list by name, and Escape clears it.

### Precise seams

Object ▸ Add part or modifier ▸ Add precise seam (also in an object's right-click menu) adds a seam modifier: a box, cylinder, sphere, slab or a loaded model, drawn in the seam type's colour. It starts as "Seam: center". Right-click it in the Objects list ▸ Precise Seam Type picks center, left, right, enforced, blocked or neutral, and Change type ▸ Precise Seam turns a modifier into a seam or back. Precise seams are saved in the project the way OrcaSlicer 2.5 saves them, so desktop Orca opens them as seams. This version of the slicer slices them as plain modifiers with no settings, so they don't move the seam yet.

## Moving objects

The transform gizmo is CubbyCAD's: move, rotate and scale handles on one gizmo (G). M, R and S limit it to one of them, and pressing the same key again brings back the full gizmo. The Object manipulation panel (bottom left) types exact values. Each row ends in its own button: drop to bed, reset rotation, reset scale, and the link that keeps scale and size proportional. With several objects selected it edits them as one group, like Orca's world coordinates: position and size are the group's, and rotation and scale turn or scale the whole group about its centre (always uniformly), then read 0° and 100% again. Collapsed, it shows the selection's size.

View ▸ Grid snap sets the step for drags and arrow-key nudges; K switches between perspective and orthographic.

## Arranging

Arrange (A), Arrange plate (Shift+A) and Arrange selection run OrcaSlicer's own arrange in the Orca engine, whichever engine you slice with. Plate ▸ Arrange options… has Orca's arrange settings: spacing (0 means auto, so each object keeps its brim or support margin), auto rotate, multiple materials on one plate, align to the Y axis and, on Bambu Lab printers that scan the first layer, avoiding the extrusion calibration region. As in Orca, spacing and auto rotate are kept separately for printing by layer and by object. The options are saved in this browser.

With preFlight, Orca's arrange gets your bed shape but uses Orca's defaults for skirt, support and clearance.

## Calibration

The Calibration menu has OrcaSlicer 2.5's tests. Each dialog links to its wiki guide. Starting a test starts a new project, and asks before discarding the current one.

- **Temperature:** "Auto-scale for nozzle" (on by default) resizes the 0.4 mm / 0.2 mm reference tower to your nozzle and sets a matching layer height. Turn it off to print the reference model as it is. On a belt printer you also pick the test model: Standard (one block per temperature along the belt) or Overhang (Orca's pre-numbered overhang samples, for 230–190, 240–210, 250–230, 270–230, 280–240 and 320–280 °C).
- **VFA:** "Auto-scale for nozzle" works the same way, with 25 layers per speed band. "Auto-adjust to max volumetric speed" checks the end speed against the filament's max volumetric speed. If it's too fast, the test lowers the layer height to one of the printer's profiles, or failing that offers a lower end speed. Without auto-adjust, it asks whether to continue anyway.
- **Pressure advance:** belt printers have the PA tower only.
- Calibration ▸ Handy models adds Orca's test models, including the Orca Badge.

## Modelling with CubbyCAD shapes

The slicer has CubbyCAD's basic modelling: built-in shapes, holes and groups. It edits CubbyCAD's own node tree, so a `.cubby` file (or a model sent from CubbyCAD with `cad_to_slicer`) opens here as editable shapes, and goes back to CubbyCAD the same way.

- Add a shape: the shapes button on the plate toolbar (or Object ▸ Add shape) opens CubbyCAD's palette: box, sphere, cylinder, cone, torus, tube, star and the rest. Each one lands on the plate as a new object.
- The Shape panel (top right, when a shape object is selected) shows its node tree and the picked node's settings: its parameters (drag a slider or type a value; a drag is one undo step), Hole, and Colour. Double-click a row to rename it. The row buttons toggle hole, hide, lock and delete.
- Holes: Object ▸ Shape modelling ▸ Make hole (or the Hole switch) makes a shape cut instead of add. A hole on its own shows as a grey ghost and isn't printed.
- Group: select two or more objects and use Object ▸ Shape modelling ▸ Group. The objects become one manifold group, where solids join and holes cut, like a Sharp group in CubbyCAD. Plain meshes (STL, 3MF, …) can join a group too, so you can drill a hole through an imported model. Object ▸ Ungroup splits a group back into objects, in place.
- Pick a node in the tree and the transform gizmo moves, rotates or scales just that node inside its object. Pick the top row to move the whole object again.
- Delete with a node picked deletes that node only.
- Parameter changes rebuild the object's mesh, which clears its painting (supports, seams, colours, fuzzy skin), as other tools that change a mesh do.

Group and ungroup have no keys here: CubbyCAD's Ctrl+G and Ctrl+Shift+G are Orca's Export G-code and Print plate, and its H (hide) and L (lock) are fuzzy-skin and support painting. They are in the Object menu, the right-click menu and the command palette.

Not supported: CubbyCAD's blended (SDF), loft and skin groups, sculpting, script parts, text, sketches and modifier stacks. A tree that has them still opens. Those nodes are listed with a badge and kept untouched in saved projects and `.cubby` exports. When CubbyCAD sends them (cad_to_slicer) it bakes each one into a mesh, which you can move, hide, recolour, group and cut with like any part; its shape stays editable only in CubbyCAD. Without a baked mesh, a node that can't be shown is left out of the object, and a top-level node that is nothing but such content is skipped with a warning.

## Design tab (experimental)

The Design tab is OrcaSlicer 2.5's parametric CAD, running Orca's own modelling kernel in the browser. A project saved by OrcaSlicer 2.5 with a design opens here editable, and saves back in Orca's format: desktop Orca opens it again. Turn the tab off with Preferences ▸ CAD feature (experimental).

- The kernel loads the first time you open the tab (about 5 MB to download when the server compresses it, a few seconds to start). Every edit rebuilds the whole history, which takes from milliseconds to a minute on large designs (threads are the slowest). While it works, the busy pill says so; **Cancel** (or Esc) stops it and puts the design back to its last saved state.
- **Feature tree**: every feature of the history, in order. Click to select (Ctrl+click or Shift+click for several), double-click or F2 to rename, the eye to suppress, Alt+↑ / Alt+↓ to reorder, Delete to delete (deleting a sketch also deletes the features made from it). The Origin and Bed rows show the reference planes and the printer bed.
- **Parameters**: the selected feature's values. Change them and press Apply (or Enter): one rebuild, one undo step. The fx button drives a value with an expression of the Variables (`+ − × ÷`, `sqrt`, `sin`… in degrees). If the kernel refuses an edit (for example "fillet radius too large"), nothing changes and the message stays on the feature.
- **A design that doesn't rebuild** shows no bodies and names the first feature that fails. Suppress it, or select every failing feature and suppress them together.
- **Bodies**: the swatch sets a body's colour, the eye hides it from the view (hidden bodies aren't committed), the frame zooms to it, the bin deletes it (it removes the feature the body was made from; Ctrl+Z brings it back), double-click or F2 renames it. Right-click a body for everything that applies to it. A body without faces is listed as empty and isn't sent to the plate.
- **3D view**: click a body to select it; click the same spot again for the face, again for the nearest edge. With an edge selected, **Shift+click** (or Ctrl+click) another edge of the same body to add it, or one already selected to drop it; Fillet / Chamfer (Shift+F, or the offer) then rounds them all. Middle-drag pans, right-drag orbits, Home fits the design. **Right-click** (without dragging) opens Orca's offer menu for what is under the cursor (Esc closes it and keeps the selection): for a flat face Hole, Shell, Push/pull, Thicken, Fillet / Chamfer of its edges, Draft, patterns, Mirror, a datum Plane, Volume and area, Delete Face…; for a cylinder Thread and a circular pattern about its axis; for an edge Fillet and Chamfer; for a body Shell, Cut, patterns, Move, Boolean, Interference, Rename, Color, Delete.
- **Section view**: the toolbar's section button (or X) hides the half of the model above a horizontal plane at its mid-height, to see inside. PageUp / PageDown move the plane 2 mm, F (or the flip button next to it) shows the other half, X again turns it off. What is hidden can't be clicked.
- **Measuring**: right-click a body ▸ Reference ▸ **Volume and area** puts the body's volume (mm³) and surface area (mm²) on the status line (a surface body has an area and no volume). The **Check interference** button in the feature tree's header (or right-click a body ▸ Reference ▸ Interference) lists the pairs of bodies that overlap, worst first, with the volume they share; bodies that only touch don't count. Neither changes the design.
- **Adding features**: the toolbar's **Feature** menu, the offer menu, the command palette or Orca's keys (all Shift+letter in the Design view): Fillet / Chamfer (Shift+F), Draft (Shift+D), Shell (Shift+K), Delete Face, Hole (Shift+H) with counterbore / countersink and the M3–M10 / UNC clearance standards, Thread (Shift+T) with the ISO / UNC / UNF table, Pattern linear / circular (Shift+N), Mirror (Shift+Z), Transform (Shift+Y), Boolean join / subtract / intersect (Shift+B), Cut by a plane or a face (Shift+X), Thicken, Push / pull a face, datum Plane (Shift+P), Axis (Shift+A), Coordinate system (Shift+C) and Helix, Mate, the **Surface** cards (Surface Extrude Shift+G, Surface Revolve Shift+J, Surface Loft Shift+O, Surface Fill Shift+Q, Surface Offset Shift+U, Thicken Surface Shift+V), and, on sketches, Extrude (Shift+E), Revolve (Shift+R), Sweep (Shift+W) and Loft (Shift+L) — with a Sketch row open, click inside a finished sketch's profile (or on its outline) to pick it. A card opens at the top of the panel with Orca's fields and defaults, prefilled from what you picked. Reference rows (edges, faces, bodies) have a **Pick** button: the view then only picks that kind (an orange banner says what), clicks add or remove edges and faces, Enter or Done finishes, Esc puts it back. With a card open, a click in the view feeds its first reference row directly (Fillet: click edges). On designs that rebuild quickly the result shows as an orange ghost while you change values; on slow ones press Preview. **OK** adds the feature (one rebuild, one undo step); if the kernel refuses, the card stays open with its message. Shell needs a face to leave open: the kernel refuses a closed hollow, and a shell that would change nothing (an open face whose edges are filleted).
- **Assemblies**: a **Coordinate system** is a world point (with the world axes) or, once you pick a face, Face + direction: its origin is the face's centre, Z the face normal, X along a picked edge (else the face's first edge). **Mate** (Feature menu, or right-click a flat face ▸ Transform ▸ Mate) moves the body of coordinate system B onto A: Fastened, Planar, Revolute, Slider or Cylindrical, with an offset (Plane distance / Axial position), an angle, and Flip to oppose the Z axes (face to face). It needs two coordinate systems, and B must be on a body. Datum planes are drawn in the view as translucent rectangles of their Size U × V, and coordinate systems as Orca's small face, lying in their own XY plane with its muzzle standing along Z, plus a Z arrow (blue for the one a Mate moves, a dashed line joining mated pairs). The face is drawn over the model. Preferences ▸ *Draw mate connectors as a face* (shown while the CAD feature is on) switches to the conventional disc with the X / Y quadrant, which the model hides when it is behind it. A coordinate system whose X direction could not be derived (no edge picked) is always drawn as the disc, with an amber quadrant. Datum axes are not drawn (as in Orca). Suppressed datums and those that don't resolve are not drawn, and none are while a sketch is open. With the Plane card's Offset or Angle open, click a datum plane (where no body is in the way) to make it the base.
- **Surfaces**: Surface Extrude, Revolve, Loft and Fill make sheet bodies (no volume) from sketches; Surface Offset moves a sheet's skin by a signed distance; Thicken Surface turns a flat sheet into a solid. Right-click a sheet body for Thicken Surface and Surface Offset.
- **One region of a sketch**: in a sketch with several closed regions (a plate outline and a separate circle, say), click inside one of them: it is shaded, and Extrude (Shift+E) builds only that region, with any loops inside it as holes ("Only the picked region" on the card; untick it for the whole sketch). The other regions stay free for other features.
- **Editing references** of an existing feature (its edges, faces, bodies) works the same way from the parameters: the view shows the design as it was *before* that feature while you pick, because that is the geometry its references name.
- **Shapes**: the toolbar's **Shape** button (the same CubbyCAD palette as Prepare's Add shape) adds a body. Boxes, cylinders, spheres, cones, tori, tubes, capsules, hemispheres, half cylinders, polygon / star prisms, wedges, roofs and the fillet shape become exact bodies (their faces and edges can be filleted, shelled and drilled; a box, cylinder, cone, sphere or torus is one history entry whose size is fixed — delete it and add it again to change it); the others (pyramid, paraboloid, icosahedron, star, heart, diamond) come in as mesh bodies. In Prepare, **Convert to Design body** (Object menu, or the pencil on the shape panel) does the same for a CubbyCAD object on the plate, groups and holes included, where it sits; **Import as a mesh body** brings any other object in as a mesh body.
- **STEP and meshes**: ⋯ ▸ Import STEP… opens the solids of a STEP file as exact bodies; Import mesh… brings an STL / OBJ / 3MF in as a mesh body; Export STEP… saves the visible bodies. File ▸ Import of a STEP file also offers **Open in Design** in its options dialog. A project with only a design (nothing on the plate) opens straight to the Design tab.
- **Commit to Plate** sends every visible body to the plate. By default (Orca's) they become **one assembly object** with a part per body, keeping their positions; the arrow next to the button switches to **separate bodies** (one object each). Ctrl+Alt+P commits. The objects stay linked: after a design edit their meshes are replaced (which resets painting, like every tool that changes a mesh). The object card in Prepare has **Edit in Design** and **Unlink**; cutting, splitting or simplifying an object unlinks it. Desktop Orca sees linked objects as plain meshes.
- **Sketches**: the toolbar's **Sketch** button (Shift+S) sketches on the flat face you picked, or asks where: Top (XY), Front (XZ), Right (YZ), a datum plane, or click a flat face. The view turns to face the plane (N turns it back after orbiting). Double-click a sketch in the feature tree (or its **Edit sketch** button) to change it. A sketch is one undo step when you **Finish** it (Enter, or ✓); **Cancel** discards it. While it is open, Ctrl+Z / Ctrl+Y undo and redo inside the sketch, and other design edits wait.
  - **Drawing** (Orca's keys): Line L (and Polyline: click the first point to close, Enter / right-click / double-click ends), rectangles R (corner; centre, 3-point and rounded in its menu), circles C (centre; 2- and 3-point), arcs A (3-point; tangent and centre-point), slot S (and arc slot in its menu: click the centre, the start and the end of the centre line, then the width), polygon G (3–64 sides, inscribed / circumscribed), ellipse E and elliptical arc, spline B, point P. Clicks snap to ends, centres, the origin, midpoints and curves (the orange hint says which), lines within 3° snap horizontal / vertical — and each snap becomes a constraint (coincident, midpoint, on curve, horizontal / vertical). Hold Shift to place freely. On a touch screen, press and drag to draw a two-click shape; two fingers pan and zoom. After a line, rectangle, circle or slot lands, its size field opens (an arc slot asks for its Radius, then its Width): type the value (or an expression with the design's variables, `w / 2`), Enter applies, Tab moves to the next, Esc keeps it as drawn. Q makes the selection (or new entities) construction geometry (dashed, left out of the profile).
  - **Constraints and dimensions**: Dimension (D): click a line for its length, a circle / arc for the diameter / radius, two points for their distance, a point then a line for the distance to the line. **Constrain** (K) applies Orca's 20 constraints (horizontal, vertical, parallel, perpendicular, coincident, equal, collinear, concentric, tangent, midpoint, symmetric, angle, radius, diameter, fix, horizontal / vertical distance…) to the selection; click an end or a centre to select that point. Geometry is blue while it can still move, white when fully constrained, red where constraints conflict; the toolbar says how many degrees of freedom are left. Drag a point or a curve to move what the constraints allow. Click a dimension to change it. A selected line (or one you drag) shows its length and angle in green, a circle its radius, an arc its radius and sweep, an ellipse its two half-axes. A rectangle, slot, polygon, rounded rectangle or arc slot shows the shape's own labels whichever of its edges you select: Width and Height (and the angle of an oblique rectangle), a slot's length, width and angle, a polygon's side and orientation, a rounded rectangle's width, height and corner radius, an arc slot's radius and width. Click a length or radius label to make it a dimension and type its value; click an angle or half-axis label to type a new value directly (a shape's angle turns the whole shape). A shape is recognised while it keeps the constraints its drawing tool gave it; delete those and its edges show their own labels. With the Select tool a click on a constraint's badge deletes that constraint (Ctrl+Z brings it back); Shift+click a badge, or click its row in the panel, to select it — Delete removes the selection. A constraint that would over-constrain the sketch is refused with what it conflicts with: **Replace** that one, **Keep both** (over-constrained, shown red), or dismiss.
  - **Editing**: Trim T (click the part to cut away, up to the nearest crossing), Extend X, Fillet F and Chamfer H (click a corner of two lines), Offset O (a chain; negative goes to the other side), Mirror M (select, then click the mirror line), Move, Rotate, Scale, linear and polar arrays, Use edges (project body edges into the sketch, fixed). Text… and Import SVG… put rigid outlines in a sketch of their own (they extrude as they are): drag the handle in their middle to move them, a corner handle to scale them (the opposite corner stays), or type the position in the panel. With a flat face picked, **Text** and **SVG** in the right-click menu (or Text… / Import SVG… in the command palette) put the outlines on that face, centred on it; the Extrude offered after Finish then defaults to a Cut into that body, inward, ready to engrave. With no face picked they go on the Top plane.
  - **Finish** offers Extrude and Revolve on the new sketch.
- **Undo** is one list for the whole project: Ctrl+Z in either tab steps back through design edits and plate changes in the order you made them.
- A design saved by a newer Orca opens read-only and is kept unchanged.

## Files

Projects are 3MF files in OrcaSlicer's project format, so desktop OrcaSlicer and Bambu Studio open them with their plates, parts, painting and settings. Opening an Orca or Bambu project 3MF works the other way round. Sliced 3MFs show each plate's G-code in the preview until you re-slice.

Project files keep CubbyCAD shapes editable: the node trees are stored in the 3MF next to the meshes (in `Metadata/cubby_cad.json`), so reopening the project restores them. Desktop Orca just sees the meshes.

File ▸ Import opens `.cubby` files (CubbyCAD scenes): one object per top-level node, laid out as in CubbyCAD around the plate centre. File ▸ Export as .cubby (CubbyCAD) writes the selected shape objects (or all of them) as a scene CubbyCAD opens. Plain mesh objects are left out of it.

Ctrl+O, Ctrl+I and Ctrl+S use the browser's native file dialogs where the File System Access API exists (Chrome, Edge and other Chromium browsers).

- Ctrl+S saves back to the file you opened. The first time, it asks where to save. Ctrl+Alt+S saves as.
- Exports (G-code, 3MF, STL) ask where to save. Export all plates asks for a folder.
- File ▸ Local folders ▸ Open from local folder: add folders once and browse their projects and models. The folders and your recent files are remembered in this browser, and access is re-confirmed after a restart.

Other browsers fall back to uploads and downloads.

### CubbyCAD

File ▸ CubbyCAD opens and saves files in your CubbyCAD workspaces, using the editor's sign-in. Once a project is open from a workspace, Ctrl+S saves it back there. Signed out, you can still open files from public workspaces.

`?workspace=<id>&path=<file>` opens a workspace file on load.

The top bar shows where the project is saved (cloud or disk icon, amber when there are unsaved changes).

## Print hosts

Printer ▸ ⋯ ▸ Physical printer… sets up OctoPrint, Moonraker, PrusaLink, Duet, Repetier, Creality, Elegoo, FlashForge or a plain upload URL. The printer has to allow CORS from `https://cubbycad.com` (the dialog shows the setting for each host type). On an HTTPS page, plain `http://` printers only work in Chrome with Local Network Access (allow the prompt the first time).

UltiMaker printers (UltiMaker 3 / S5) are supported too: every upload starts printing, and the login is an ID / key the printer issues. Request it in the dialog, approve it on the printer's screen, then Test.

Each physical printer has a name and the printer presets it prints. Several printers can share a preset: for two identical printers, set up the first, then use Print ▸ ⌄ ▸ Add another printer… and enter the second one's address. When the selected preset has more than one printer, the Print button names the one it sends to, and its menu and the send dialog switch between them. Each tab remembers its own choice, so two tabs can drive two printers. A new tab starts on the printer you used last.

### Sync filaments from printer

On a Moonraker printer with a filament changer, "Sync filaments from printer" (command palette, or Sync filaments in the Physical printer dialog) sets the filament slots from the printer: one slot per lane, the lane's colour, and the preset with the lane's filament ID, else the generic preset for its material. As in OrcaSlicer, the lanes come from the first of these that reports any: the lanes AFC and recent Happy Hare publish in Moonraker, an older Happy Hare MMU's gates, or the Creality CFS of a Creality Hi. On a Qidi printer it reads the Qidi Box instead: each loaded slot's material, colour and the matching Qidi filament preset. The toast lists what each lane got; a lane with no matching preset keeps only its colour.

### Qidi Box and Creality CFS when printing

On a Qidi printer with a Box, Upload & Print lets you pick the Box slot each filament loads from; the list shows what each slot holds (material and colour), read from the printer when the dialog opens. On a Creality K-series printer that can take a CFS (K1 / K2 family), the send dialog reads the printer's slots and offers a filament mapping, prefilled as OrcaSlicer does (same material and colour on the CFS first, then same material, then the external spool), plus an Enable self-test option. Mapping a filament to the external spool prints the whole job from it. With no CFS connected, or no answer, the print uses the external spool.

## Several tabs

Each tab has its own plate and its own printer, filament and process selection, including unsaved preset edits. Reloading a tab brings back that tab's plate. A new tab opens the most recent plate from a tab you closed, so closing the browser by accident loses nothing. Duplicating a tab copies its plate.

Your user presets, the installed printer list and the physical printers are shared: saving a preset in one tab shows it in the others straight away.

## Mixed filaments

OrcaSlicer 2.5 mixes colours by printing two or three filaments in thin sub-layers (or alternating layers). With two or more filaments in the Filament section, "Add mixed filament" appears under them. Each mixed filament gets a filament number after the physical ones (up to 32 in all), and you use it like any other filament: object or part filament, the object table, height ranges and colour painting.

The editor:

- Select Mixed Materials: two or three filaments of the same type (+ Add Material / - Delete Material), each with a share of at least 10 %. Effect Preview shows the resulting colour.
- Ratio: for two filaments, drag along the blend bar; for three, drag the dot inside the triangle (each corner is one filament). Click a percentage to type it.
- Gradient Effect (two filaments): the direction (which filament is at the bottom) and the curve of each filament's share over the model height. Click the line to add a point and drag it, drag points to move them, right-click a point to delete it (long press on a touch screen), click the other filament's line to edit that one. With the curve focused, arrow keys move the selected point (Shift: 10 %), Delete removes it. Switching the direction mirrors the curve. "Enable per-part gradient effect" gives each part of an assembly the whole gradient. Curves from desktop OrcaSlicer projects are kept exactly until you change them.
- Mixing recommendations: one-click blends of your filaments (pairs 50/50, triples 25/25/50).

The list shows each mix's number and swatch (a ramp for a gradient) with its filaments; click one to edit it, × removes it. A warning marks a mix that lost a filament or mixes filament types. The process setting Quality ▸ Layer height ▸ Mixed color sublayer switches between sub-layers and alternating whole layers.

## Plugins

File ▸ Plugins… installs and runs OrcaSlicer 2.5 Python plugins, unmodified, in the browser (Python runs on Pyodide, which loads only once a plugin is enabled or the dialog needs it).

- Install plugin takes a `.py` or `.whl` file (or drop it on the dialog), or a URL. The Orca Cloud tab links to the plugin hub: download a plugin's file there, then install it here.
- Each plugin has a switch, and so has each of its capabilities. Script capabilities have a Run button and appear in the command palette. G-code post-processing capabilities run when you export or upload G-code; the preview keeps the original.
- Plugins ask before using permissions such as network access; the dialog lists what each plugin was allowed, with a revoke button.
- Slicing-pipeline capabilities run inside the slice, at the steps Orca hooks them. Page capabilities add their own tab next to Prepare and Preview (it opens on click or Enter), with the page's own icon when the plugin gives one (an SVG or PNG file).
- A plugin's Python dependencies are installed when it loads, from Pyodide's packages or pure-Python wheels. Packages with native code that Pyodide doesn't ship can't be installed.
- Enabled plugins load again on the next visit. Installed plugins are stored in this browser.

**Only install plugins you trust.** A plugin runs Python code inside CubbySlicer: it can read and change your projects, settings and printer connections stored in this browser, and change the G-code that is sent or exported. The permission prompts limit network access, but not what a plugin does with your data.

What doesn't work in a browser:
- Starting programs (`subprocess`, `os.system`), raw sockets and threads. A plugin that tries gets an error that says so; a granted permission for them is kept but can't be used. A plugin that waits for its own window (a script that sits in a queue until you click Apply or Close) works, as long as the page is cross-origin isolated, as cubbycad.com is.
- Network access only reaches sites that allow browser requests (CORS), even with permission.
- Printer-connection capabilities (Orca's printer agents) load but are listed as not supported: CubbySlicer has print hosts, not a device manager.
- The Orca plugin hub can't be browsed or subscribed to from here; download a plugin's file and install it.

## Model hand-off

The [CubbyCAD editor](https://cubbycad.com/editor) sends the current model with File ▸ Open Slicer. Other apps can do the same:

- `?model=<url>` loads a model or 3MF project on startup. The link must be an absolute http(s) URL, URL-encoded, and its server must allow CORS. Repeat `model` to load several files in order. Optional params:
  - `name=<file>` names the file when the link's path doesn't (for example `/download?id=42` or a signed URL). The Nth `name` goes with the Nth `model`. Without it, the name comes from `Content-Disposition` (if the server exposes it), then the URL path, then `Content-Type` or a zip signature (3MF).
  - `arrange=all` (or `1`) arranges every unlocked plate once everything has loaded, `arrange=plate` arranges only the active plate, and `arrange=0` skips Preferences ▸ Auto arrange plate after import. Arranging replaces the plate layout saved in a 3MF project.
  - `spacing=<mm>` and `rotate=1|0` set that arrange's options. Spacing defaults to `auto` (Orca's 0: each object keeps its brim or support margin) and auto rotate defaults to on. Links don't use your saved Arrange options, so they lay out the same for everyone.

  For example: `/slicer/?model=https%3A%2F%2Fapi.example.com%2Fdownload%3Fid%3D42&name=bracket.3mf&arrange=all&spacing=5`. These params are removed from the address bar once the files have loaded.
- Open `/slicer/?handoff=<id>`, wait for `{ type: 'cubby-slicer:ready', handoff: id }` on `BroadcastChannel('cubby-slicer-handoff')`, then post `{ type: 'cubby-slicer:model', handoff: id, stl, name }` (same origin only). This works across the slicer's cross-origin isolation, which the older `window.opener` `postMessage` path doesn't.

## AI agents (MCP)

An AI agent can drive the slicer (and the CubbyCAD editor) through cubby-mcp, a small MCP server that runs on your computer. Any MCP client works: Claude Code, Codex CLI, Cursor, Windsurf, Claude Desktop and others. Nothing leaves your machine: the tab connects to `ws://127.0.0.1:18711`, and cubbycad.com has no server side for this.

1. Add the server to your agent once. It is a stdio server started with `npx -y cubby-mcp`. For example:
   - Claude Code: `claude mcp add --scope user cubby -- npx -y cubby-mcp`
   - Codex CLI: `codex mcp add cubby -- npx -y cubby-mcp`
   - Clients with an `mcpServers` config (Cursor, Windsurf, Claude Desktop, …): `{ "mcpServers": { "cubby": { "command": "npx", "args": ["-y", "cubby-mcp"] } } }`

   The connect dialog shows the same examples with a copy button.
2. Ask your agent for the pairing code (it reads it with `cubby_status`).
3. Here, Help ▸ Connect an AI agent, paste the code, Connect. Or open `/slicer/?mcp=<code>`, which fills it in (`?claude=<code>` still works).

The code works once. The tab keeps a token for this site, so later connections only need Connect. Tick "Reconnect when this page loads" to skip that too; Disconnect turns it off again, and Forget pairing drops the token. The top bar shows a robot icon while the agent is connected.

The agent can do what you can do in the app:

- switch engines, pick and compare presets, set filament slots and colours, save, rename and delete your own presets, and run the setup steps;
- change any setting, for the whole print or for one object, part, height range or plate;
- import models (from CubbyCAD with `cad_to_slicer`, a file on your computer or a URL), move, rotate, scale, mirror, orient, split, copy and rename them, and add parts, modifiers, negative parts and support blockers or enforcers;
- model with CubbyCAD shapes: add primitives, change their parameters, make holes, group and ungroup, and move, hide, lock or delete nodes in a shape's tree. The tools have the same names and arguments as the CubbyCAD ones (`slicer_add_primitive` / `cad_add_primitive`, `set_node`, `transform_node`, `group`, …), so an agent drives both apps the same way;
- add, rename, lock and set up plates, and move objects between them;
- paint supports, seams, colours and fuzzy skin (whole objects, height bands, around a point, fill regions, or faces pointing one way);
- set variable layer heights, height range modifiers, and filament changes, pauses or custom G-code at a layer;
- cut, combine (mesh boolean), simplify, add text or SVG, measure, add brim ears, and set up calibration prints and test models;
- add, edit and remove mixed filaments;
- slice, read the results per plate and per line type, set the preview layers and colours, take screenshots of Prepare and Preview, and export G-code, 3MF or STL;
- open and save projects in CubbyCAD, and set up and use a print host;
- run any command from the menus (the same list as the command palette).

Most changes can be undone with Ctrl+Z like your own. Some actions ask you here first: uploading and printing, changing or removing the print host, and deleting a preset. Tick "Allow without asking until I disconnect" if you don't want to confirm each one. Actions that would throw away your work show the app's usual prompt: a new project, opening a project over the plate, deleting a plate with objects on it, starting a calibration, and replacing a file in CubbyCAD.

Chrome's Local Network Access: on `https://cubbycad.com` the browser asks once whether the site may reach devices on your local network. Allow it. If you blocked it, reopen the padlock ▸ Site settings ▸ Local network access. Firefox allows `127.0.0.1` from https pages. Safari may block it; use Chrome, Edge or Firefox.

## Multi-threading

The multi-threaded Orca engine needs a cross-origin isolated page. Preferences ▸ Slicing threads sets how many threads it uses: Automatic, single-threaded, or a fixed count. Fewer threads keep the page more responsive while slicing. The next slice uses the new setting. The setting is stored as `cubby-slicer:engine-threads` in localStorage (`'1'` for single-threaded, `'0'` or unset for automatic).
