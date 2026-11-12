# Engine contract

The C ABI and job format every engine port implements (`orca`, `preflight`), so `src/engine/` doesn't care which engine it's talking to. The ports and their toolchain are listed in [DEVELOPMENT.md](DEVELOPMENT.md#engines).

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
  are not linked at all (OpenVDB, OpenCV, OCCT, Assimp, Draco, CURL, OpenSSL,
  Python). Orca replaces the few sources that need them with failing stubs
  (`orcaslicer-wasm/wasm/stubs/`) rather than shimming their headers; OCCT's
  real *headers* (no code) are on the path for the CAD sketch sources only.
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
// {"engine":"orca","version":"2.5.0","bridge":1,"build":"release"}  (NUL-terminated, static)
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
//   mixed_filament        (orca) mixed-filament helpers: preview / recommend / validate / curve / expand
//   resolve_variants      (orca) per-extruder values of the extruder-variant vectors
//   wipe_tower_footprint  (orca) prime tower size + desktop placement for a plate (see "Prime tower")
//   repair_mesh           (orca) desktop "Fix model" / "Fix All" (CGAL repair_mesh, see "Mesh repair")
//   texture_displacement  (orca) bake Orca 2.5 texture displacement into a mesh
//   sketch                (orca) Design-tab sketch solver / inference / text + SVG import
//   inspect_3mf           OrcaSlicer's own 3MF loader on a project file (checks). Result:
//     {isOrca, isBbl, hasOrcaTag, objects:[{name, autoDrop, config, instances,
//     layerHeightProfile, layerRanges, volumes:[{name, type, triangles, paint, transform,
//     config, textureDisplacement?:{layers (texture_displacement_layers_to_json),
//     images:[{slot, name, pathIn3mf, imageBytes, painted}]}}]}], plates, customGcodes,
//     cadRecipe:{present, bytes} (Metadata/orca_cad.bin), settings, config}
//   arrange               (orca) OrcaSlicer's ArrangeJob (Arrange all / plate / selection). The
//     request also carries the slice-job "config" and "objects" (same packing
//     as cs_slice; transforms plate-local for objects on a plate) next to
//     args {mode, currentPlate, plates:[{locked, seq, toolChanges, imexMode}],
//     items:[{plate, printable, selected}] (parallel to objects),
//     settings:{distance (0 = auto), enableRotation, alignToYAxis,
//     allowMultiMaterials, avoidCaliRegion}, bbl}. Result: {items:[{moved,
//     plate, x, y (mesh origin, plate-local), dRot (about Z)}], plates,
//     unplaced, warnings, order, seqPrint, imex?}. IDEX/IQEX and belt printers:
//     see "Arrange". See the bridge comment.
int  cs_tool(const char* req_json, int req_len, const uint8_t* blob, int blob_len,
             char** out_json, int* out_len, uint8_t** out_blob, int* out_blob_len);

void cs_free(void* p);

// OPTIONAL (orca): re-entrant slice-graph access for plugin hooks. Valid ONLY while
// Module.csHook("pipeline", ...) is on the stack (returns -1 otherwise). Same buffer
// conventions as cs_tool. See "Plugin hooks".
int  cs_hook_query(const char* req_json, int req_len, const uint8_t* blob, int blob_len,
                   char** out_json, int* out_json_len, uint8_t** out_blob, int* out_blob_len);
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
                                   //   (orca 2.5) precise_seam_center | precise_seam_left | precise_seam_right
                                   //   | precise_seam_enforced | precise_seam_blocked | precise_seam_neutral
                                   //   (Precise Seam modifiers; Orca's own 3MF type names; "config" applies as volume config)
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
                                   // (2.5 adds "vfaLayerHeight" (0 = nozzle/2) and "nozzleBasedResize" (default true))
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
    "maxZ": 24.0,
    "sliceInfo": { ... },          // orca only, see below
    "mass": { ... }                // orca only, see below
  },
  "timings": { "processMs": 0, "exportMs": 0 },
  "substitutions": ["key: bad -> default", ...],  // config values the engine had to substitute
  "events": [{ "event": "SliceStarted", "ctx": { "name", "code", "msg", "id", ... } }]  // orca: libslic3r lifecycle events
}
```

Warning codes: `slicing`, `validate`, `conflict`, `unprintable_area`, `plugin`
(a slicing-pipeline capability's non-empty result message).

`stats.sliceInfo` (orca): what desktop's sliced 3MF takes from the slice
besides the statistics (`PartPlateList::store_to_3mf_structure`,
`PlateData::parse_filament_info`, `Plater::priv::generate_first_layer_bbox`).
Filament numbers are 0-based unless noted.

```jsonc
{
  "firstLayerTime": 23.7,          // GCodeProcessorResult::initial_layer_time (s, a float)
  "toolpathOutside": false,
  "labelObjectEnabled": true,      // GCode m_enable_exclude_object
  "supportUsed": false,            // Print::is_support_used
  "warnings": [{ "level": 1, "msg": "not_generate_timelapse", "errorCode": "10014001", "params": [] }],
                                   // GCodeProcessor::update_slice_warnings
  "limitFilamentMaps": [0, 2],     // per filament, a bit mask of extruders it can't use
  "layerFilaments": [{ "filaments": [0, 1], "ranges": [[0, 29]] }],  // the result's hash-map order
  "filamentChangeSequence": [0, 1, 0], "nozzleChangeSequence": [0, 1, 0], "optimalAssignment": [0, 1],
  "mixedFilaments": [{ "id": 4, "type": "PLA", "color": "#808080", "components": "1,2" }],  // id 1-based
  "nozzleGrouping": {              // the LayeredNozzleGroupResult, when the slice made one
    "dynamic": false,
    "filaments": [{ "id": 0, "groupIds": [0], "diameter": 0.4, "volumeType": "Standard" }],
    "usedNozzles": [{ "id": 0, "extruderId": 0, "diameter": "0.4", "volumeType": "Standard" }]
  },
  "firstLayerBBox": {              // plate-local; floats as the engine has them
    "firstExtruder": 0, "bedType": "Textured PEI Plate", "firstLayerTime": 23.7, "nozzleDiameter": 0.4,
    "bboxAll": [x0, y0, x1, y1],
    "objects": [{ "id": 426, "bbox": [x0, y0, x1, y1], "area": 400, "layerHeight": 0.2, "name": "cube" },
                { "id": null, "wipeTower": true, "bbox": [...], "area": ..., "layerHeight": ..., "name": "wipe_tower" }]
  }
}
```

`stats.mass` (orca): the G-code processor's masses for the Preview's centre of
mass markers (`GCodeProcessorResult` plate_mass / object_masses / body_masses /
support_masses). Each is `{ "layers", "box", "beltBox", "assembly", "name"?,
"instance"? }`: `layers` holds, per layer id, what is printed up to that layer,
flat as `[mass mg, volume mm³, moment x y z, second x² y² z², cross xy xz yz]`
× layers; boxes are `[min x y z, max x y z]` or null.

```jsonc
{ "plate": { ... }, "objects": [ ... ], "bodies": [ ... ], "supports": [ ... ] }
```

### Schema JSON (`cs_describe_config`)

```jsonc
{
  "engine": "orca", "version": "2.5.0",
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
      "guiType": "",               // "", "color", "slider", "select_open", "f_enum_open", "i_enum_open", "legend", "one_string",
                                   //   (orca 2.5) "plugin_picker", "plugin_config", "printer_agent_select"
      "scope": "print",            // print|filament|machine|object|other  (preset tab the key belongs to)
      "variant": "print",          // orca 2.5, only on extruder-variant vectors: print|printer|filament
      "variantStride": 2,          //   only on printer keys with 2 values per variant (normal/silent limits)
      "pluginType": "slicing-pipeline"  // orca 2.5, only on plugin-backed keys (plugin_picker)
    }
  }
}
```

## Extruder variants (orca 2.5)

Orca 2.5 profiles give ~150 keys one value **per extruder variant** instead of
one per extruder (speeds, accelerations, jerks, retraction, volumetric limits,
…). Those keys carry `"variant"` in the schema. A variant is an extruder type +
nozzle volume type, spelled like `"Direct Drive High Flow"`.

What the host sends (the shape desktop Orca's `PresetBundle::full_config(false)`
produces; values exactly as the resolved presets have them):

* print + printer variant vectors **full width**, plus the keys that name each
  column: `print_extruder_variant` / `print_extruder_id` (print) and
  `printer_extruder_variant` / `printer_extruder_id` (printer; `variantStride: 2`
  keys have two values per column).
* the selectors of the active variant, per extruder: `extruder_type`
  (`Direct Drive` | `Bowden`), `nozzle_volume_type` (`Standard` | `High Flow` |
  `TPU High Flow` | `E3D High Flow` | `Extra High Flow` | `Hybrid`), plus the
  printer's `extruder_variant_list` (and `extruder_nozzle_stats` when the
  profile has it). `nozzle_volume_type` defaults to `Standard` per extruder.
* filament variant vectors: **each filament's own vector, concatenated in
  filament order**, with `filament_extruder_variant` concatenated the same way
  and `filament_self_index` (1-based filament number of every element). When
  `filament_self_index` is missing or the wrong length and every filament has
  the same number of variants, the bridge fills it in.
* **Presets resolved like desktop**: a system preset's value set is its resolved
  `inherits` parent, then each preset named in its **`include`** (a string or an
  array; resolved the same way), then its own keys
  (`PresetBundle::load_vendor_configs_from_json`). Most BBL filaments
  (`… @BBL H2C/H2D/X1C/P2S/…`) get their variant names *only* from an include
  (`fdm_filament_template_direct_dual`, `…_dual_e3d`, `…_direct_bowden_e3d`, …),
  and many BBL printers get their start/end/change-filament G-code from
  `"… template machine_start_gcode"` includes. A filament's variant vectors are
  then sized to its `filament_extruder_variant` count: padded with the first
  value, trimmed past it (`extend_default_config_length`). The bridge rejects a
  filament variant vector whose length is none of: `filament_extruder_variant`'s,
  the filament count (pre-2.5 one-per-filament), 1 (not sent) — error
  `<key> has N values but filament_extruder_variant names M variant column(s) …
  flattened without their \`include\` templates …`. (Without the include, every
  filament after the first silently read its neighbour's columns.)
* `filament_map` (1-based extruder per filament; default all 1).
* `filament_volume_map` (ints, one per filament: the nozzle volume type each
  filament asks for, `NozzleVolumeType` numbers 0 Standard, 1 High Flow,
  2 Hybrid = "any", 3 TPU High Flow, 5 E3D High Flow, 6 Extra High Flow).
  Desktop always sends it: the plate's own map, else each filament's extruder's
  `nozzle_volume_type` (`get_default_nozzle_volume_types_for_filaments`). When the
  job omits it the bridge fills that default on a multi-extruder printer (all
  Standard on one extruder); a map sent with the wrong length on a
  multi-extruder printer is an error.

### Nozzle racks and Hybrid extruders (H2C, A2L: `extruder_max_nozzle_count` > 1)

Desktop's path from the GUI to `Print::apply` for a printer whose extruder
carries several nozzles:

* `extruder_nozzle_stats` (strings, **one per extruder**): the physical
  nozzles of each extruder as `"<type>#<count>"` joined by `|`, type names as in
  `nozzle_volume_type` (`"Standard#3|High Flow#3"`); `""` = that extruder's
  `extruder_max_nozzle_count` nozzles of its `nozzle_volume_type`. Desktop seeds
  it on every printer load (`seedExtruderNozzleStats`: each extruder
  `extruder_max_nozzle_count` × its type, a Hybrid extruder starting all
  Standard) and changes it from "Set the physical nozzle count…" or device
  sync. It is session state: saved presets never carry it, so the host keeps it.
* `nozzle_volume_type` `Hybrid` means "a mix": the per-type split comes **only**
  from `extruder_nozzle_stats`. Without it the grouping sees one "Hybrid"
  nozzle, writes `filament_volume_map` back as 2 and every filament on that
  extruder resolves to its Standard column. The bridge therefore rejects a
  Hybrid extruder without per-type counts, a malformed token, a stats list
  whose length is not the extruder count, and more nozzles than
  `extruder_max_nozzle_count`.
* `filament_map_mode` `Manual`: `filament_map` fixes each filament's extruder,
  `filament_volume_map` its nozzle type (2 = any); the engine picks the
  physical nozzle and writes `filament_nozzle_map` (0-based index into the
  nozzle list: extruders in order, each extruder's nozzles by type in
  `NozzleVolumeType` order). A request the rack cannot satisfy fails with
  `Group error in manual mode. Please check nozzle count or regroup.`
* `filament_map_mode` `Nozzle Manual`: the host also sends `filament_nozzle_map`
  (one per filament; equal ids = same nozzle) and a concrete
  `filament_volume_map` (no 2), and `extruder_nozzle_stats` must list every
  extruder (`"Standard#1"` for a single-nozzle one). The bridge rejects missing
  or mis-sized maps.
* `Auto For Flush` / `Auto For Match`: the engine chooses and writes back all
  three maps.

The G-code config block shows the written-back `filament_map`,
`filament_volume_map`, `filament_nozzle_map` and each filament's resolved
variant. Example (Bambu Lab H2C 0.4, PLA Basic ×3): `filament_map_mode Manual`,
`filament_map [1,2,2]`, `nozzle_volume_type [Standard, Hybrid]`,
`filament_volume_map [0,0,1]`, `extruder_nozzle_stats ["Standard#1",
"Standard#3|High Flow#3"]` (+ `flush_multiplier` with one value per extruder
and `flush_volumes_matrix` of n²×that many values) → `filament_volume_map =
0,0,1`, `filament_nozzle_map = 0,1,4`, filament 3 on `"Direct Drive High Flow"`
(`filament_max_volumetric_speed = 25,25,40`).

What the engine resolves: `Print::apply` picks each extruder's element (and each
filament's, via `filament_self_index` + `filament_map`) when the printer has
several extruders or its `extruder_variant_list` lists several variants, exactly
like desktop. A single-extruder, single-variant printer whose print/printer
presets still carry several variant columns is resolved by the bridge itself
with the same `update_values_to_printer_extruders`. The G-code's config block
shows the resolved values. `cs_tool` `resolve_variants` returns them without
slicing: `args {config}` → `{extruderCount, differentExtruders, resolvedBy:
"print_apply"|"bridge"|"none", print:{key:[per extruder]}, printer:{…},
filament:{key:[per filament]}}`. It applies the same validation as `cs_slice`
and resolves each filament from the `filament_volume_map` sent (the static
assignment; with `Hybrid` = 2 a filament shows its first column until a slice's
grouping picks a nozzle).

## Mixed filaments (orca 2.5)

A mixed filament is a **virtual filament slot** realized from 2+ physical
filaments, either by splitting each layer into sub-layers
(`enable_mixed_color_sublayer` = 1, print key; a Z gradient prints only with it
on) or by alternating whole layers. The schema has the keys below (hosts can
show mixing UI when `filament_is_mixed` is present). The job carries mixes as
**plain config**, exactly as desktop writes `project_settings.config`:

* every per-filament vector covers **all slots: physical first, mixed at the
  tail** (desktop gives a mixed slot its first component's filament preset;
  `filament_colour` = the mix colour);
* `flush_volumes_matrix` over all slots (n² per nozzle), **zero rows/columns**
  for mixed slots;
* the per-slot mix description:

| key | type | value per slot (physical slots: `0` / `""`) |
|---|---|---|
| `filament_is_mixed` | bools | `1` for a mixed slot |
| `filament_mixed_components` | strings | 1-based physical filaments, `"1,3"` |
| `filament_mixed_sublayer_ratios` | strings | fractions summing to 1, 4 decimals, `"0.7000,0.3000"` |
| `filament_mixed_gradient` | bools | Z gradient on |
| `filament_mixed_gradient_range` | strings | first component's start,end ratio, `"0.1000,0.9000"` (kept within 0.1..0.9) |
| `filament_mixed_gradient_curve` | strings | optional curve `"x,y[,mIn,mOut]\|…"`, `""` = linear range |
| `filament_mixed_gradient_per_part` | bools | gradient per part instead of per assembly |

Objects, parts (`extruder`, `wall_filament`, …) and colour paint (`paint.color`
states, up to 32) reference a mixed slot by its 1-based number like any
filament; tool changes go to its physical components. The engine validates the
mix with Orca's `validate_mixed_filament_params` (a bad mix fails the slice
with `mixed filament: …`).

`cs_tool` `mixed_filament` exposes desktop's dialog logic (`args.action`):
`preview {colors, components, ratios}` → `{color, measured}` (`color`: Orca's
pigment blend, which already prefers the lab-measured table; `measured`: the
table's entry or null); `recommend {target:"#hex", mode:"filaments"|"cmyw"|"rybw",
filaments:[{color,name,type,mixed}], materialType}` → `{valid, mode, color,
components:[{filament, color, baseColor, ratio}]}`; `validate {config}` →
`{errors:{key:message}}`; `curve {curve, samples}` → `{serialized, points,
samples:[[t, ratio]]}`; `expand {config, mixedFilaments:[{components, ratios
(weights), color?, gradient?:{enabled, range, curve, perPart}}]}` → `{slots,
config:{changed keys}}` (desktop's add-mixed-filament expansion of every
per-filament key, for hosts that don't build it themselves).

## Texture displacement (orca 2.5)

Desktop bakes texture displacement into the volume's mesh **before** slicing;
the slicer itself sees an ordinary mesh. Hosts call `cs_tool`
`texture_displacement`: `meshes[0]` = the volume's base mesh (mesh-local),
`args {layers: <Orca's texture_displacement_layers_to_json text or object>,
images: {"<slot>": {offset, length}} (PNG bytes in the request blob),
paint: {"<slot>": [[triangle, hex], …]} (the layer's paint mask), transform?: [16]
mesh→world, anchor?: [x,y,z], restingDrop?: mm}` → `meshes[0]` = baked mesh,
`result {triangles, budgetLimited}`. Then slice that mesh. Not available: the
bake's colour output (`color_enabled` layers; it needs the GUI's palette
quantizer).

## Prime tower (orca)

`cs_tool` `wipe_tower_footprint` is desktop's pre-slice tower estimate
(`PartPlate::estimate_wipe_tower_footprint` → libslic3r
`estimate_wipe_tower_footprint`, the same numbers `Print::validate` checks) plus
its placement rules, so a host can keep the tower on the bed and inside every
extruder's printable area. All in the plate frame the job uses; the anchor
(`wipe_tower_x/y`) is the tower body's min corner before rotation.

```jsonc
args: {
  "config": { … },             // the job config (cs_slice shape, same validation)
  "filaments": [1, 2],          // filaments the plate prints: objects, parts, colour paint, support /
                                //   interface filaments, tool-change custom G-code (PartPlate::get_extruders(true));
                                //   default: every filament. wipe_tower_filament is added like desktop.
  "minFilaments": 0,            // floor (desktop's initial placement and arrange use 2)
  "maxHeight": 30,              // tallest object on the plate, mm (drives the stability depth and the auto brim)
  "layerHeight": 0.2,           // thinnest layer on the plate (default config layer_height)
  "objects": 1,                 // printed objects (only by-object sequence reads it)
  "plate": 0,                   // index into wipe_tower_x / wipe_tower_y
  "position": [x, y],           // anchor to place (default wipe_tower_x/y[plate])
  "printerModelId": "N9"        // optional vendor model_id; only "N9" changes desktop's default Y
}
result: {
  "printed": true,              // prime_tower_is_printed (enable_prime_tower, >1 filament / smooth timelapse / …)
  "towerType": "Type1"|"Type2", "width", "depth", "height", "brim" (resolved; auto -1 → by height),
  "coneMargin",                 // Type2 cone bulge past the body box, mm
  "rotation",                   // wipe_tower_rotation_angle
  "filaments": [1, 2],          // the ids the estimate used
  "outline":  [[x,y]…],         // tower-local first-layer outline, brim excluded, unrotated
  "footprint": [[x,y]…],        // tower-local, rotated, brim included: what must fit
  "printableArea": [[[x,y]…]…], // printable_area, or the intersection of every extruder_printable_area
  "placement": { "x", "y", "moved", "fits" },   // desktop's clamp of `position`, then moved inside printableArea
  "defaultPosition": { "x", "y", "fits" }       // PartPlateList::set_default_wipe_tower_pos_for_plate
}
```

`placement` = `estimate_wipe_tower_polygon`'s clamp (a position within the
1 mm validity margin stays; one more than 5 mm out is re-placed with the 15 mm
comfort margin) followed, when the footprint still crosses an extruder's area,
by `WipeTower::move_box_inside_polygon` against `printableArea` (desktop only
does that last step for the default position and otherwise fails validation
with "Prime tower is partially outside the printable area"). It does not
search around objects (desktop's relocation needs the plate's object hulls).
`fits` = the footprint at that anchor lies inside `printableArea`, i.e.
`Print::validate` accepts it. Write `placement.x/y` back to
`wipe_tower_x/y[plate]`.

## Mesh repair (orca)

Desktop 2.5's "Fix model" (object list) and "Fix All" / "Fix All Plates" (plate
menu) use libslic3r's CGAL `repair_mesh` on every platform
(`ObjectList::fix_through_cgal` → `ModelVolume::repair`); there is no Netfabb
step. It welds vertices, drops degenerate / duplicate faces, orients shells
consistently, fills holes, removes self-intersections and drops shells that do
not form a solid. `cs_tool` `repair_mesh`, one volume per call:

```jsonc
meshes[0]: the volume's mesh (any frame)
args: { "paint": { "support"|"seam"|"color"|"fuzzy": [[triangle, hex]…] },  // optional
        "keepPainting": true }                                             // desktop's keep_painting
→ meshes[0]: the repaired mesh (the input when unchanged or when the repair failed)
  result: { "repaired": bool, "modified": bool, "error": string|null, "triangles", "vertices",
            "stats": { "weldedVertices", "removedTriangles", "reversedShells", "filledHoles",
                       "removedShells", "selfIntersections" },
            "paint": { … }   // re-projected onto the new triangles; omitted when nothing is painted
          }
```

`repaired: false` = no solid could be built (desktop lists the object under
"failed to repair" with `error`); `modified: false` = it already was a closed,
consistently oriented, self-intersection-free mesh. Fix All = one call per
model part of every object on the plate; then drop the object to the bed.

## Arrange: IDEX/IQEX and belt printers (orca 2.5)

**IDEX/IQEX** (`is_imex` printers). Each plate may carry its own parallel mode,
the plate config's `imex_parallel_mode`; a plate without one (or `"primary"`)
uses the process preset's `imex_parallel_mode` (`PartPlate::get_effective_imex_mode`).
Send it per plate as `plates[i].imexMode` (`""` = none of its own) and keep the
process value in `config`. In a Copy / Mirror mode the arrange keeps the parts
inside the first head's zone (`compute_imex_zone_layout`) and out of its
carriage collision strips (`imex_nozzle_clearance_x/_y` + brim), as desktop's
`ImexArranger`: when every plate (and any plate the arrange adds, which gets
the process mode) has the same zone it becomes the bed; otherwise each
parallel-mode plate is fenced and re-packed inside its zone. A part that cannot
fit its zone comes back unplaced. `result.imex = true` when any plate had a
zone. `cs_slice` does **not** check the zones: desktop's plater refuses to
slice beforehand (`PartPlate::imex_placement_violation`: "Cannot slice: an
object overlaps an area reserved for IDEX/IQEX parallel printing …"), so a host
must do the same check (parts and prime tower outside the primary zone or in a
collision strip). The slice job carries the plate's effective mode as
`imex_parallel_mode` in its config.

**Belt printers** (`belt_printer` = 1). As desktop's `init_arrange_params`:
parts pack in belt order from the start of the belt (`belt_slice_rotation` x:
the belt runs along Y, packing starts at the top-left; y: along X), tilted by
`belt_slice_rotation_angle`. No classic prime tower is reserved; instead the
belt purge prism's strip along the far lateral edge (when the parts use more
than one filament and `enable_belt_purge_tower`) and a brim-wide strip along
every bed edge (`brim_width + brim_object_gap + extra_brim_width − 1`, none
for `no_brim`) stay free. The purge prism object itself (object config
`belt_purge_tower_object` = 1) is neither moved nor packed around; it comes
back `moved: false`.

## Plugin hooks (orca 2.5)

Orca 2.5's slicing-pipeline plugins run at 12 points inside `Print::process()`:
`posSlice, posPerimeters, posEstimateCurledExtrusions, posPrepareInfill,
posInfill, posIroning, posContouring, posSupportMaterial,
posDetectOverhangsForLift, posSimplifyPath, psWipeTower, psSkirtBrim` (only for
steps recomputed in this pass). They are active only while the config's
`slicing_pipeline_plugin` (strings: capability names, in run order) is
non-empty **and** the host defined `Module.csHook`; otherwise nothing changes.
`psGCodePostProcess` is not an engine step: the host runs it on its copy of the
G-code at export time.

**Dispatch.** At each step the engine calls, synchronously,

```ts
Module.csHook(kind: "pipeline", begin: string /* JSON */, blob: null):
  { status: "Success"|"Skipped"|"RecoverableError"|"FatalError"|"Exception"|"Cancelled",
    capability?: string, message?: string } | string /* same, JSON */ | null | undefined
// begin = { step, stepIndex, objectId: <ObjectBase id>|null, objectIndex|null,
//           scalingFactor, orcaVersion, capabilities: [...slicing_pipeline_plugin],
//           plugins: [...config "plugins" manifest] }
```

It runs on the thread that owns `Module` (the main runtime thread; the pthreads
build proxies it there with `emscripten_proxy_sync` while the slicing thread
parks), so it may block (`Atomics.wait`) until a plugin worker answers.
`null`/`undefined` = success. Results map like desktop's `PluginHooks.cpp`:
`Cancelled` → the slice is cancelled; `FatalError`/`Exception` (or a thrown JS
error) → the slice fails with `Slicing pipeline plugin '<capability>' error:
<message>`; anything else continues, a non-empty `message` becomes a `plugin`
warning. Heartbeats while waiting go through `Module.csProgress` as usual.

**Graph access.** While `csHook` is on the stack the host calls the export
`cs_hook_query` (plain synchronous re-entry, no Asyncify) as often as it needs.
Request: one op object, or `{"batch": [ops]}` (stops at the first failing op).
Response: `{ok, error, results: [{blobOffset, ...}]}` + one output blob;
`blobOffset` is the byte offset of that op's data in it. Write ops read their
geometry from the request blob at the op's `blobOffset` (bytes, default 0), so
a read/geometry result can be fed straight back (pass its blob and offsets).
All coordinates are **little-endian int64 scaled** (× `scalingFactor` = mm).
An expolygon is `{contourLen, holeLens:[...]}` + its points packed in order
(contour, then each hole) as x,y pairs; a surface adds `type` (SurfaceType int:
0 stTop, 1 stBottom, 2 stBottomBridge, 3 stInternalAfterExternalBridge,
4 stInternal, 5 stInternalSolid, 6 stInternalBridge, 7 stSecondInternalBridge,
8 stInternalVoid, 9 stPerimeter), `thickness`, `thickness_layers`,
`bridge_angle`, `extra_perimeters`. Addressing: `objectId` (ObjectBase id),
`layer` (index; `support: true` = support layer), `region` (index), `which`.

| op | args | result |
|---|---|---|
| `print.info` | | `objectIds, canceled, scalingFactor, step, objectId` |
| `print.config_value` / `print.config_keys` | `key` | `value` (serialized or null) / `keys` (full print config) |
| `object.info` | `objectId` | `id, bbox [minx,miny,maxx,maxy] (scaled), trafo[16] (PrintObject::trafo(), 4×4 **column-major** like job transforms: translation at 12–14), layerCount, supportLayerCount, modelObject` |
| `object.config_value` / `object.config_keys` | `objectId, key` | `value` / `keys` |
| `region.config_value` / `region.config_keys` | `objectId, layer, region, key` | `value` / `keys` |
| `object.layers` | `objectId, support?` | `layers: [{print_z, slice_z, height, regionCount}]` |
| `layer.surfaces` | `objectId, layer, region, which: slices\|fill_surfaces` | `surfaces: [surface]` + points |
| `layer.lslices` | `objectId, layer, support?` | `expolygons` + points |
| `layer.support_islands` | `objectId, layer` (support layer) | `expolygons` + points |
| `layer.extrusions` | `objectId, layer, region, which: perimeters\|fills\|thin_fills\|support_fills, flat?` | `tree: {kind: collection\|loop\|multipath\|path\|entity, role, width, height, mm3_per_mm, n, children}` or `paths: [path]` (`flat`); path points x,y,z (read-only) |
| `model.objects` | | the Print's model snapshot: `objects: [{id, name, volumes:[{id, name, type, vertexCount, triangleCount, matrix}], instances:[matrix]}]` |
| `model.mesh` | `object, volume` (indices) | `vertexOffset, vertexCount, indexOffset, triangleCount` (float32 xyz / int32 triples) |
| `surfaces.set` / `surfaces.append` | `objectId, layer, region, which`, `surfaces:[surface]` or `{type, expolygons}` | |
| `surfaces.clear` / `surfaces.set_type` | `…, which` (+ `type`) | |
| `surface.patch` | `…, which, index`, any of `type, thickness, thickness_layers, bridge_angle, extra_perimeters, expolygon` | |
| `layer.set_lslices` | `objectId, layer, expolygons` | refreshes `lslices_bboxes` |
| `layer.make_slices` | `objectId, layer` | re-derives lslices from the region slices |
| `geom.offset_ex` / `geom.offset` | `a: expolygons, delta` (scaled) | `expolygons` / `polygonLens` (contours only) |
| `geom.union_ex` / `geom.diff_ex` / `geom.intersection_ex` | `a, b` | `expolygons` |
| `geom.simplify` / `geom.douglas_peucker` | `a, tolerance` | `expolygons` |

Geometry ops are libslic3r's own Clipper (jtMiter, miter limit 3), so results
match desktop bit for bit. Edits follow desktop semantics: editing `slices` at
`posSlice` or `fill_surfaces` at `posPrepareInfill` cascades into later steps;
edits after a step's output was generated do not regenerate it.

**Lifecycle events** (`SliceStarted`, `SliceGeometryFinished`,
`GCodeExportStarted`, `GCodeExportFinished`) are recorded into `report.events`
(never called into JS during the slice); the host dispatches them afterwards.

## Design-tab sketches (orca 2.5)

The Design tab's B-rep kernel (CadDocument, GeometryEngine, SketchEngine) needs
OpenCASCADE and is not in the engine. Its OCCT-free parts are, through
`cs_tool` `sketch` (`args.action`): `solve {entities, constraints, drag?}`
(SolveSpace, as desktop) → `{entities, ok, dof, result, bad, skipped}`;
`infer {entities, newEntity}` → `{constraints}`; `snap {entities, query, tol}`;
`axis {anchor, tip}`; `text {text, sizeMm, font:{offset,length}}` and
`svg {svg, scale}` → `{regions: [[loop [[x,y]…]…]…]}`. Entity / constraint
JSON: see the comment above `op_sketch` in `orcaslicer-wasm/bridge/cs_bridge.cpp`.

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
