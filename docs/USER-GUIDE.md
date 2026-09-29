# User guide

Cubby Slicer works like OrcaSlicer, with the same menus, tools and shortcuts (press `?` for the list, Ctrl+K for the command palette). This page only covers what's different in the browser version.

## Engines

Pick OrcaSlicer, preFlight or Full Spectrum at the top of the Printer section. Each engine keeps its own presets. The accent colour shows which engine is active: green for Orca, orange for preFlight, fuchsia for Full Spectrum.

Calibration prints and brim ears need an Orca-based engine (OrcaSlicer or Full Spectrum).

## Moving objects

The transform gizmo is CubbyCAD's: move, rotate and scale handles on one gizmo (G). M, R and S limit it to one of them, and pressing the same key again brings back the full gizmo. View ▸ Grid snap sets the step for drags and arrow-key nudges; K switches between perspective and orthographic.

## Files

Projects are 3MF files in OrcaSlicer's project format, so desktop OrcaSlicer and Bambu Studio open them with their plates, parts, painting and settings. Opening an Orca or Bambu project 3MF works the other way round. Sliced 3MFs show each plate's G-code in the preview until you re-slice.

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

## Claude Code

Claude Code can drive the slicer (and the CubbyCAD editor) through cubby-mcp, a small MCP server that runs on your computer. Nothing leaves your machine: the tab connects to `ws://127.0.0.1:18711`, and cubbycad.com has no server side for this.

1. Add the server once: `claude mcp add --scope user cubby -- npx -y cubby-mcp`. (Until it's on npm, run `npm install` in a cubby-mcp checkout and use `node <checkout>/dist/cli.js` in place of `npx -y cubby-mcp`.)
2. In Claude Code, ask for the pairing code (Claude reads it with `cubby_status`).
3. Here, Help ▸ Connect to Claude Code, paste the code, Connect. Or open `/slicer/?claude=<code>`, which fills it in.

The code works once. The tab keeps a token for this site, so later connections only need Connect. Tick "Reconnect when this page loads" to skip that too; Disconnect turns it off again, and Forget pairing drops the token. The top bar shows a robot icon while Claude is connected.

Claude can list and pick printer, process and filament presets, import models (from CubbyCAD with `cad_to_slicer`, a file on your computer or a URL), arrange, change settings, slice, export G-code or 3MF, and set up and use a print host. Uploading and printing always ask you here first. Tick "Allow without asking until I disconnect" if you don't want to confirm each one.

Chrome's Local Network Access: on `https://cubbycad.com` the browser asks once whether the site may reach devices on your local network. Allow it. If you blocked it, reopen the padlock ▸ Site settings ▸ Local network access. Firefox allows `127.0.0.1` from https pages. Safari may block it; use Chrome, Edge or Firefox.

## Multi-threading

The multi-threaded Orca engine needs a cross-origin isolated page. Force a thread count with `localStorage.setItem('cubby-slicer:engine-threads', 'N')` (`'1'` for single-threaded, `'0'` or unset for automatic).
