# User guide

Cubby Slicer works like OrcaSlicer, with the same menus, tools and shortcuts (press `?` for the list, Ctrl+K for the command palette). This page only covers what's different in the browser version.

## Engines

Pick OrcaSlicer, preFlight or Full Spectrum at the top of the Printer section. Each engine keeps its own presets. The accent colour shows which engine is active: green for Orca, orange for preFlight, fuchsia for Full Spectrum.

Calibration prints and brim ears need an Orca-based engine (OrcaSlicer or Full Spectrum).

## Moving objects

The transform gizmo is CubbyCAD's: move, rotate and scale handles on one gizmo (G). M, R and S limit it to one of them, and pressing the same key again brings back the full gizmo. View ▸ Grid snap sets the step for drags and arrow-key nudges; K switches between perspective and orthographic.

## Modelling with CubbyCAD shapes

The slicer has CubbyCAD's basic modelling: built-in shapes, holes and groups. It edits CubbyCAD's own node tree, so a `.cubby` file (or a model sent from CubbyCAD with `cad_to_slicer`) opens here as editable shapes, and goes back to CubbyCAD the same way.

- Add a shape: the shapes button on the plate toolbar (or Object ▸ Add shape) opens CubbyCAD's palette: box, sphere, cylinder, cone, torus, tube, star and the rest. Each one lands on the plate as a new object.
- The Shape panel (top right, when a shape object is selected) shows its node tree and the picked node's settings: its parameters (drag a slider or type a value; a drag is one undo step), Hole, and Colour. Double-click a row to rename it. The row buttons toggle hole, hide, lock and delete.
- Holes: Object ▸ Make hole (or the Hole switch) makes a shape cut instead of add. A hole on its own shows as a grey ghost and isn't printed.
- Group: select two or more objects and use Object ▸ Group. The objects become one manifold group, where solids join and holes cut, like a Sharp group in CubbyCAD. Plain meshes (STL, 3MF, …) can join a group too, so you can drill a hole through an imported model. Object ▸ Ungroup splits a group back into objects, in place.
- Pick a node in the tree and the transform gizmo moves, rotates or scales just that node inside its object. Pick the top row to move the whole object again.
- Delete with a node picked deletes that node only.
- Parameter changes rebuild the object's mesh, which clears its painting (supports, seams, colours, fuzzy skin), as other tools that change a mesh do.

Group and ungroup have no keys here: CubbyCAD's Ctrl+G and Ctrl+Shift+G are Orca's Export G-code and Print plate, and its H (hide) and L (lock) are fuzzy-skin and support painting. They are in the Object menu, the right-click menu and the command palette.

Not supported: CubbyCAD's blended (SDF), loft and skin groups, sculpting, script parts, text, sketches and modifier stacks. A tree that has them still opens. Those nodes are listed with a badge and kept untouched in saved projects and `.cubby` exports. When CubbyCAD sends them (cad_to_slicer) it bakes each one into a mesh, which you can move, hide, recolour, group and cut with like any part; its shape stays editable only in CubbyCAD. Without a baked mesh, a node that can't be shown is left out of the object, and a top-level node that is nothing but such content is skipped with a warning.

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

## Mixed filaments (Full Spectrum)

Needs two or more filaments. Filament ▸ Mixed filaments lists the blends the engine creates for every filament pair, plus your own. Each mixed filament gets a filament number after the physical ones, and you use it like any other filament (object filament, object table, colour painting).

Click a mixed filament (or + Mix) to edit it:

- Blend: two or more filaments with a share for each.
- Gradient: colours ordered bottom to top. With two colours, set the first filament's share at the bottom and at the top. With three or more, set each colour's position, the midpoints between them, and an optional solid width.
- Pattern: filament numbers per layer, for example `1122` (`[10]` for two digits, commas for separate wall groups).
- Advanced: whole-layer cycle cadence, Local-Z sublayer cap, and surface bias per filament (negative expands, positive recesses).

Colour mixing settings (under the list) hold the global options: Local-Z minimum sublayer height, subdividing every mix, full domain, first layer, gradient Local-Z height, middle filament window, and surface bias. Keep layer heights around 0.08 to 0.12 mm and use translucent filaments for the best blends.

## Model hand-off

The [CubbyCAD editor](https://cubbycad.com/editor) sends the current model with File ▸ Open Slicer. Other apps can do the same:

- `?model=<url>` loads a model on startup (the URL must allow CORS).
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
- manage Full Spectrum mixed filaments;
- slice, read the results per plate and per line type, set the preview layers and colours, take screenshots of Prepare and Preview, and export G-code, 3MF or STL;
- open and save projects in CubbyCAD, and set up and use a print host;
- run any command from the menus (the same list as the command palette).

Most changes can be undone with Ctrl+Z like your own. Some actions ask you here first: uploading and printing, changing or removing the print host, and deleting a preset. Tick "Allow without asking until I disconnect" if you don't want to confirm each one. Actions that would throw away your work show the app's usual prompt: a new project, opening a project over the plate, deleting a plate with objects on it, starting a calibration, and replacing a file in CubbyCAD.

Chrome's Local Network Access: on `https://cubbycad.com` the browser asks once whether the site may reach devices on your local network. Allow it. If you blocked it, reopen the padlock ▸ Site settings ▸ Local network access. Firefox allows `127.0.0.1` from https pages. Safari may block it; use Chrome, Edge or Firefox.

## Multi-threading

The multi-threaded Orca engine needs a cross-origin isolated page. Force a thread count with `localStorage.setItem('cubby-slicer:engine-threads', 'N')` (`'1'` for single-threaded, `'0'` or unset for automatic).
