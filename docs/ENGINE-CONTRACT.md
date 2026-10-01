# Engine contract

The C ABI and job format every engine port implements (`orca`, `preflight`, `fullspectrum`), so `src/engine/` doesn't care which engine it's talking to. The ports and their toolchain are listed in [DEVELOPMENT.md](DEVELOPMENT.md#engines).

## Build invariants (memory safety)

Every object file in an engine build (deps included) uses the same model:

* `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` (native Wasm EH; no JS-emulated
  exceptions, no `DISABLE_EXCEPTION_CATCHING`).
* single-threaded: no `-pthread`, Boost `threading=single`, TBB replaced by the
  sequential shim only.
  **Exception: the optional multi-threaded variant** (`<base>mt/`, Orca only):
  EVERY object compiled with `-pthread` (deps from the toolchain's `install-mt`:
  Boost `threading=multi` + Boost.Thread, real oneTBB, thread-safe MPFR); no
  shim for a linked library; never mixed with single-threaded objects. See
  "Multi-threaded engines" below.
* **No** `-sEMULATE_FUNCTION_POINTER_CASTS`. A signature mismatch is a real bug:
  fix the source.
* **No** replacement global `operator new/delete` in the bridge.
* **No** stub headers that shadow a real library that is also linked (layout /
  ODR mismatches corrupt memory). Stubs are allowed only for libraries that
  are not linked at all (OpenVDB, OpenCV, OCCT, CURL, OpenSSL).
* Link: `-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=64MB
  -sMALLOC=mimalloc|dlmalloc -sABORTING_MALLOC=0 -sSTACK_OVERFLOW_CHECK=1
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node`.
  Heap >2 GB means pointers must be treated as **unsigned** in JS (`>>> 0`).
* Debug variant (`BUILD_VARIANT=debug`): `-sASSERTIONS=2 -sSAFE_HEAP=1
  -sSTACK_OVERFLOW_CHECK=2 -g2`. The engine test suite must pass under it.

## Artifacts

Staged into `public/wasm/<engine>/` by `scripts/fetch-<engine>-wasm.sh`:

```
slicer.mjs        ES module factory (default export)
slicer.wasm
schema.json       output of cs_describe_config (generated at build time)
version.json      output of cs_version
profiles/...      engine's vendor profiles (see below)
```

## C ABI

All strings are UTF-8, NOT NUL-terminated unless stated. All out-buffers are
allocated by the engine with `malloc` and released with `cs_free`.

```c
// {"engine":"orca","version":"2.4.2","bridge":1,"build":"release"}  (NUL-terminated, static)
const char* cs_version(void);

// Full config schema as JSON (see "Schema"). rc 0 = ok.
int  cs_describe_config(char** out_json, int* out_len);

// Slice a job. rc 0 = ok, anything else = failure; the report is ALWAYS
// produced (when out_report != NULL) and carries the error message.
int  cs_slice(const char* job_json, int job_len,
              const uint8_t* blob, int blob_len,
              uint8_t** out_gcode, int* out_gcode_len,
              char** out_report, int* out_report_len);

// Evaluate a preset compatibility condition (PrusaSlicer/Orca
// `compatible_printers_condition` / `compatible_prints_condition`) against a
// flattened config. Returns 1 = true, 0 = false, <0 = parse/eval error.
int  cs_eval_condition(const char* expr, int expr_len,
                       const char* config_json, int config_len);

// OPTIONAL (orca only): Auto Orient one object (OrcaSlicer's AutoOrienter).
// Input: a job with exactly one object whose transform is its current
// rotation*scale. Output JSON: {"ok","error","rotation":[row-major 3x3 to
// PRE-multiply onto the object's rotation],"axis":[x,y,z],"angle":rad}.
int  cs_orient(const char* job_json, int job_len, const uint8_t* blob, int blob_len,
               char** out_json, int* out_len);

// OPTIONAL (orca only): interactive model tools, one dispatcher. Request JSON
// {"op", "args"} + a blob of meshes (the same vertex/index layout as cs_slice,
// described by args); output JSON {"ok","error","result","meshes":[{vertexOffset,
// vertexCount,indexOffset,triangleCount}]} + an output mesh blob. Ops:
//   paint_open / paint_apply / paint_get / paint_close  TriangleSelector painting
//     sessions (circle, sphere, pointer, height, smart fill, bucket, clear)
//   paint_from_states     per-triangle states → paint strings (OBJ colours)
//   layer_profile_adaptive / layer_profile_smooth   variable layer height
//   cut                   Orca Cut: plane or groove, connectors (plug/dowel/snap)
//   mixed_filaments       (fullspectrum) list / add / edit / remove mixed filaments; see bridge comment
//   inspect_3mf           OrcaSlicer's own 3MF loader on a project file (checks)
//   arrange               (orca) OrcaSlicer's ArrangeJob (Arrange all / plate / selection). The
//     request also carries the slice-job "config" and "objects" (same packing
//     as cs_slice; transforms plate-local for objects on a plate) next to
//     args {mode, currentPlate, plates:[{locked, seq, toolChanges}],
//     items:[{plate, printable, selected}] (parallel to objects),
//     settings:{distance (0 = auto), enableRotation, alignToYAxis,
//     allowMultiMaterials, avoidCaliRegion}, bbl}. Result: {items:[{moved,
//     plate, x, y (mesh origin, plate-local), dRot (about Z)}], plates,
//     unplaced, warnings, order, seqPrint}. See the bridge comment.
int  cs_tool(const char* req_json, int req_len, const uint8_t* blob, int blob_len,
             char** out_json, int* out_len, uint8_t** out_blob, int* out_blob_len);

void cs_free(void* p);
```

Progress: the bridge calls the JS import `Module.csProgress(percent:number,
message:string)` (via `EM_JS`) from the print status callback. Percent is
0–100 across the whole job (process + export).

### Job JSON

```jsonc
{
  "config": {                      // flattened, FULLY resolved config
    "layer_height": "0.2",         // engine-native serialized value
    "nozzle_diameter": ["0.4"],    // arrays allowed for vector options (joined natively)
    "wall_loops": 3,               // numbers/bools accepted, stringified
    ...
  },
  "objects": [
    {
      "name": "Benchy",
      "vertexOffset": 0,           // byte offset into blob, 4-aligned: float32 xyz
      "vertexCount": 1234,
      "indexOffset": 14808,        // byte offset into blob, 4-aligned: uint32 triples
      "triangleCount": 2000,
      "transform": [16 numbers],   // column-major 4x4, mm, bed coordinates (Z up, bed origin)
      "config": { "wall_loops": "5" },  // optional per-object overrides
      "parts": [                   // optional extra volumes of this object
        {
          "name": "Modifier box",
          "type": "modifier",      // part | negative | modifier | support_blocker | support_enforcer
          "vertexOffset": 32000, "vertexCount": 8, "indexOffset": 32096, "triangleCount": 12,
          "transform": [16 numbers],   // mesh-local → bed (already includes the object's transform)
          "config": { "sparse_infill_density": "100%" },  // per-volume overrides
          "paint": { ... }             // model parts only: as the object's "paint"
        }
      ],
      "paint": {                   // optional painted facets of the object's own mesh:
        "support": [[12, "4"]],    //   [triangle index, 3MF TriangleSelector hex string];
        "seam": [], "color": [], "fuzzy": []  // indices address the input triangles
      },
      "layerHeightProfile": [0, 0.2, 10, 0.2, 10.1, 0.1, 20, 0.1],  // optional [z, h, ...] from the object's bottom
      "layerRanges": [             // optional height range modifiers (z from the object's bottom)
        { "min": 10, "max": 20, "config": { "layer_height": "0.1" } }  // layer_height defaults to the print's
      ],
      "brimPoints": [{ "pos": [x, y, z], "radius": 2.5 }]  // optional (orca): brim ears, mesh-local
    }
  ],
  "options": {
    "validate": true,              // run Print::validate(); errors abort, warnings reported
    "dropToBed": true,             // translate objects so min Z = 0 (default true)
    "placeholderVars": {           // optional extra G-code placeholder variables (preFlight running
      "flush_temperatures": { "type": "ints", "value": ["220"] }   // converted Orca profiles)
    },
    "customGcodes": [              // optional plate custom G-code at print_z (preview layer slider)
      { "z": 10.2, "type": "color_change", "extruder": 1, "color": "#00FF00" },  // | pause | custom | tool_change | template
      { "z": 15, "type": "pause", "extra": "message" }
    ],
    "calib": { "mode": "pa_tower", "start": 0, "end": 0.1, "step": 0.002 }  // optional (orca): Calib_Params
  }
}
```

Indices must already be wound outward for the given transform: the host
flips the winding of mirroring transforms (det < 0); engines don't re-flip.
Several entries may point at the same blob range (instances share a mesh).

`placeholderVars` types are schema option types (`bool`, `int`, `float`,
`percent`, `string`, `enum`, vector forms). An engine registers a variable
only when it neither defines nor aliases it (or aliases it with a different
scalar/vector shape).

Paint strings, layer profiles and ranges follow the engines' own rules: a
profile is used only when it spans the object (Orca also requires its first
height to equal the initial layer height), overlapping ranges are skipped, and
malformed paint entries are ignored. OrcaSlicer turns a single-extruder
`color_change` into a filament change (no M600); preFlight emits
`color_change_gcode`.

The bridge **bounds-checks** every offset/count against `blob_len` and every
index against `vertexCount` before touching memory, and rejects NaN/Inf
coordinates. Invalid input yields rc != 0 with a report, never a trap.

### Report JSON

```jsonc
{
  "ok": true,
  "error": null,                   // string when ok=false
  "warnings": [ { "code": "...", "message": "..." } ],
  "stats": {
    "printTimeSec": 3600.5,        // normal mode estimate
    "filamentMm": [1234.5],        // per extruder
    "filamentCm3": [2.9],
    "filamentG": [3.6],
    "filamentCost": [0.08],
    "layers": 120,
    "maxZ": 24.0
  },
  "timings": { "processMs": 0, "exportMs": 0 },
  "substitutions": ["key: bad -> default", ...]   // config values the engine had to substitute
}
```

### Schema JSON (`cs_describe_config`)

```jsonc
{
  "engine": "orca", "version": "2.4.2",
  "options": {
    "layer_height": {
      "type": "float",             // bool|int|float|percent|floatOrPercent|string|enum|point|point3
                                   //   + plural forms: bools|ints|floats|percents|floatsOrPercents|strings|points
      "label": "Layer height", "fullLabel": "Layer height",
      "category": "Quality", "tooltip": "...", "sidetext": "mm",
      "mode": "simple",            // simple|advanced|expert
      "min": 0, "max": null,       // null when unbounded
      "default": "0.2",            // engine-native serialized
      "enumValues": ["..."], "enumLabels": ["..."],   // enum / open-enum only
      "multiline": false, "fullWidth": false, "readonly": false, "nullable": false,
      "guiType": "",               // "", "color", "slider", "select_open", "f_enum_open", "i_enum_open", "legend", "one_string"
      "scope": "print"             // print|filament|machine|object|other  (preset tab the key belongs to)
    }
  }
}
```

## Multi-threaded engines (`<base>mt/`)

An engine may ship an Emscripten-pthreads build next to the single-threaded
one (`mt/slicer.{mjs,wasm,data}`, same version + bridge ABI; schema/profiles
are shared). Additional exports:

* `int cs_slice_start(<cs_slice args>, int32_t* state)` runs `cs_slice` on a
  dedicated engine pthread and returns immediately (0 = started, -1 = not
  started → call `cs_slice`). When done, `state[1]` = the return code and
  `state[0]` flips 0 → 1 with a futex wake. The host waits with
  `Atomics.waitAsync` / polling and must **not block** its event loop meanwhile:
  Emscripten can only start a pthread requested by another pthread (TBB
  workers) when the main runtime thread returns to its event loop. Plain
  `cs_slice` / `cs_orient` on the main runtime thread still work, serially.
* `int cs_thread_count()` returns the number of threads a slice uses (pthread pool size).
* JS: `Module.csThreads` (optional override), `Module.csSyncHeap()` (refresh
  `HEAP*` after another thread grew memory, so call it before every heap read),
  `Module.csTerminateThreads()` (kill the instance's Workers).

Requires a cross-origin-isolated page (`Cross-Origin-Opener-Policy:
same-origin` + `Cross-Origin-Embedder-Policy: require-corp`).

## Worker protocol (`src/engine/`)

The page never touches engine memory. `EngineClient` owns a dedicated Worker
per engine; the worker compiles `slicer.wasm` once (`WebAssembly.compile`) and
**instantiates a fresh module for every slice**, so heap fragmentation, global
state and any trap from one slice cannot leak into the next. Cancel = terminate
the worker (it is recreated lazily).

When the page is cross-origin isolated and `mt/` loads, the worker uses the
multi-threaded build instead and keeps **one** instance for all requests (an
instance owns one pthread Worker per core; spinning that pool up costs
hundreds of ms). Requests are serialised, every allocation is freed, the
instance is recycled once its heap exceeds 1.5 GB, and a trap on any engine
thread is reported as `fatal` so the client terminates the worker (and with
it the nested pthread Workers). If the MT build fails to load or start, the
worker falls back to the single-threaded build.

```ts
// page -> worker
{ type: 'slice', id, job: SliceJob }            // meshes as transferable ArrayBuffers
{ type: 'describe', id }
{ type: 'evalCondition', id, expr, config }
// worker -> page
{ type: 'progress', id, percent, message }
{ type: 'result', id, gcode: ArrayBuffer, report: SliceReport }
{ type: 'error', id, message, report?, fatal }  // fatal = instance trapped (RuntimeError)
```

See `src/engine/types.ts` for the TypeScript types.

## Profiles

* **orca**: vendor tree `profiles/<Vendor>.json` + `profiles/<Vendor>/{machine,process,filament}/*.json`
  and `profiles/_index.json` (vendor ids). JSON values are native Orca strings /
  string arrays; inheritance by `inherits` (name), compatibility via
  `compatible_printers` (+ optional `compatible_printers_condition`).
* **preflight**: preFlight v1.3.0 ships **no printer or print presets** (no
  PrusaSlicer-style vendor INI bundles; its GUI creates printers via a wizard /
  imports Orca configs). The only bundled file is
  `resources/profiles/orca_system_profiles.json`, staged as
  `profiles/orca_system_profiles.json`: a flat JSON object `{ "<preset name>":
  { "type": "filament", "instantiation": "true"|"false", "inherits": "<preset
  name>", ...keys } }` of Orca **system filament** presets (`fdm_filament_*`
  bases + `Generic * @System` leaves), with `inherits` resolved by key within the
  same file and `compatible_printers` on leaves. The keys and values are
  **OrcaSlicer-native** (e.g. `filament_flow_ratio`, `fan_max_speed`,
  `hot_plate_temp`, vectors as string arrays, `"nil"` for unset nullable
  values). preFlight uses the file only to resolve inheritance when importing
  Orca profiles (`OrcaConfigImporter`), so the web app must map them to
  preFlight/PrusaSlicer keys (e.g. `filament_flow_ratio` → `extrusion_multiplier`;
  the full table is `src/libslic3r/OrcaKeyMapping.cpp` in preFlight)
  or ignore unknown ones; `cs_slice` reports unknown keys as an
  `unknown_options` warning. `profiles/_index.json` is
  `{"engine":"preflight","format":"orca-flat","bundles":["orca_system_profiles.json"]}`;
  any extra bundle must be listed there. Printer/print presets must come from
  the app (schema defaults from `schema.json` are preFlight's built-in
  defaults: 200×200 bed, 0.4 nozzle).
