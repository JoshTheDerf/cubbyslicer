# CAD kernel contract (`cad.mjs` / `cad.wasm`)

> **Status: v1.2, built and tested (2026-11-10).** Every method below is implemented and was called
> at least once under WebAssembly (`tests/cad-test.mjs`: 212 checks, `tests/cad-smoke.mjs`: 80
> checks, all passing); what is verified, what is only smoke-tested and what fails is listed under
> [Verification](#verification-under-webassembly). Measured sizes and timings:
> [Performance](#performance-measured). Anything marked **(not implemented)** is not.
> v1.1 (additive): `failed_feature` / `failed_feature_name` / `replayed_from` / `cancelled` on every
> rebuild result, `faces_made_by` without a replay, `set_variable {rebuilt}`, `describe_scene`
> `variable_values` / `variable_errors` / `rebuild_ok`, `suppress_feature.kept` always, -32031 for
> non-recipes, `Module.cadProgress` progress + cancel, the replay cache, rollback without a replay.
> v1.2 (additive): a Shell that changes nothing, leaves a sheet, or is a closed hollow is refused
> (`ok:false`, rolled back; see [Shell](#shell-refusals-v12)); `add_feature` / `set_feature` check
> `generation` when their `fields` carry face / edge ids (-32010); primitive verbs `box`, `cylinder`,
> `cone`, `sphere`, `torus` (one Import feature each); Import B-reps saved without tessellation;
> sketch fixes: constraint entity kinds checked (-32602, never a trap), angle values in degrees on
> the wire, `sketch_constrain` names the conflicting set, Orca's fillet / chamfer / trim / extend
> constraint handling, `ellipse_arc` ends derived, an empty sketch is not committed.

The Design tab's B-rep kernel: OrcaSlicer 2.5.0's own `libslic3r/CAD` (CadDocument, GeometryEngine,
SketchEngine, SolveSpace `libslvs` solver, inference, thread tables) on OpenCASCADE 8.0.1, compiled to
a **separate** WebAssembly module so the slicer engine stays OCCT-free and Prepare/Preview users never
download it. Orca's design files (`Metadata/orca_cad.bin`) reference OCCT face/edge **enumeration
ordinals**, so only this kernel reopens them faithfully.

Source: `orcaslicer-wasm/bridge/cad_bridge.cpp`, built by `orcaslicer-wasm/scripts/build-cad.sh`
(CMake option `ORCA_WASM_CAD`, build dir `build-cad/`). Tests: `orcaslicer-wasm/tests/cad-*.mjs`;
timings: `orcaslicer-wasm/tests/cad-perf.mjs`.

Orca's CAD sources get one small CAD-only patch, `orcaslicer-wasm/patches/orca-cad.patch` (applied
by `build-cad.sh`; it touches only `libslic3r/CAD/CadDocument.{hpp,cpp}`, which the slicer engine
never compiles): a replay observer called around every feature of `recompute()` (progress,
cancellation, the replay record and cache below), `failed_feature` (which feature the last
`recompute()` failed on), `faces_made_by` from a recorded replay, and public access to the
variable evaluator. Feature geometry code is unchanged.

## Build invariants

Same as [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md#build-invariants-memory-safety): every object
(OCCT included) is compiled `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`, single-threaded (no
`-pthread`), no `-sEMULATE_FUNCTION_POINTER_CASTS`, no stub header shadowing a linked library.
OCCT's own CMake adds `-fexceptions -fPIC` for every non-MSVC compiler; the toolchain strips both
(`toolchain/build-deps.sh occt`). OCCT is also built **without `OCC_CONVERT_SIGNALS`** (its
default on non-MSVC compilers): that mode makes every `OCC_CATCH_SIGNALS` call `setjmp()` inside a
C++ `try`, which this LLVM's WebAssembly backend miscompiles (legacy EH: an invalid `br_table` in
`ShapeUpgrade_ShapeDivide::Perform` and `ShapeCustom_BSplineRestriction::ConvertSurface`, rejected by
V8 and wasm-opt; exnref EH: the compiler crashes in CFGStackify). WebAssembly has no signals to
convert anyway, so OCCT behaves as its MSVC build (exceptions are thrown directly) and matches the
consumers, which never define it. The OCCT build validates every object with `wasm-validate`.
OCCT's thread pool is pinned to the calling thread at start-up (`OSD_ThreadPool::DefaultPool(1)`),
so BRepMesh/BOP "parallel" loops run inline.

Link: `-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=64MB
-sMALLOC=dlmalloc -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sFILESYSTEM=1`
(MEMFS only; STEP goes through `/tmp`), `-O3`.

## Artifacts

Staged into `public/wasm/cad/` by `scripts/fetch-cad-wasm.sh`:

```
cad.mjs        ES module factory (default export, EXPORT_NAME OrcaCadModule)
cad.wasm
version.json   output of cad_version()
```

Load lazily (only when the Design tab or a B-rep STEP import is used), in a dedicated Worker.
`cad.wasm` is 20.8 MB raw, 6.6 MB gzip -9, 4.6 MB brotli -11 (serve it pre-compressed);
`cad.mjs` 69 KB. Pass `print`/`printErr` to the factory: OCCT's STEP writer logs transfer
statistics to stdout.

## C ABI

```c
// {"module":"orca-cad","orca":"2.5.0","occt":"8.0.1","abi":1,"recipeVersion":6,"build":"release"}
const char* cad_version(void);                       // NUL-terminated, static

// One dispatcher. method: UTF-8 name (not NUL-terminated). req: JSON object (params).
// blob: optional input bytes (recipe, STEP file, mesh), described by the method.
// Always produces out_json (unless out_json == NULL); out_blob only when the method returns bytes.
// rc 0 = ok, 1 = error (out_json carries it). Free both outputs with cad_free.
int  cad_call(const char* method, int method_len,
              const char* req_json, int req_len,
              const uint8_t* blob, int blob_len,
              char** out_json, int* out_json_len,
              uint8_t** out_blob, int* out_blob_len);

void cad_free(void* p);
```

Output envelope:

```jsonc
{ "ok": true,  "result": { … } }                                   // rc 0
{ "ok": false, "error": { "code": -32000, "message": "…" } }        // rc 1
```

The heap can exceed 2 GB: treat pointers from `_malloc` / out-params as unsigned (`>>> 0`).

### Error codes

| code | meaning |
|---|---|
| -32601 | unknown method |
| -32602 | invalid params (missing/ill-typed argument, index out of range) |
| -32000 | handler failure (OCCT exception `OCCT: …`, std::exception) |
| -32010 | stale ids: the request's `generation` ≠ the document's current `generation` |
| -32020 | document is read-only (recipe newer than this kernel, see "Recipe") |
| -32021 | no such document handle |
| -32022 | sketch session state (none open / one already open) |
| -32030 | recipe could not be read at all (a damaged or too old design file) |
| -32031 | not a design file at all (the bytes do not start like a recipe: format number outside 1–1000, or a feature count the size cannot hold) |

**Geometry failures are not errors.** A mutating method whose rebuild fails returns rc 0 with
`result.ok = false` and `result.error = "<kernel message>"`, and the document is **rolled back** to its
state before the call (Orca's checkpoint → add → recompute → undo-on-failure). This mirrors McpControl.
The rollback puts back the state kept aside before the call (bodies, meshes, `generation`), without
replaying the history again: after a rolled-back call `generation` is **unchanged** and the ids handed
out before it are still valid.

Every mutating result (the build verbs, `add_feature`, `set_feature`, `suppress_feature`,
`move_feature`, `delete_feature`, `set_variable`, `set_feature_expr`, `set_document`, `sketch_commit`,
`import_*`) also carries:

| field | meaning |
|---|---|
| `failed_feature` | index of the feature the call's rebuild failed on (its replay threw, its expression binding failed, or it destroyed its body); **-1** when the rebuild succeeded or failed outside any one feature (a variable that does not evaluate, nothing solid to build, an empty tessellation, a refusal before any rebuild). The index is in the history **as attempted**: for a rolled-back `add_*` / build verb it can be the new feature's index, which no longer exists after the rollback; for a rolled-back `move_feature` it is in the moved order |
| `failed_feature_name` | that feature's name (`""` with -1) |
| `replayed_from` | first feature the call's rebuild actually replayed (the ones before it came from the replay cache, see "Rebuilds"); = the feature count when everything came from the cache; -1 when the call did not rebuild |
| `cancelled` | the host cancelled the rebuild through `cadProgress` (then `ok:false`, `error:"rebuild cancelled"`, rolled back) |

Only the **first** failure is known: features after a failing one depend on it and are not replayed,
so a list of independent failures cannot be had without one replay per candidate.

#### Shell refusals (v1.2)

Orca's Shell (`BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin`) checks only `IsDone()` and a
non-null result, and OCCT reports both — so Orca 2.5.0 itself reports success — in two cases where
nothing was hollowed:

* **The open face borders fillets / blends** OCCT cannot offset (e.g. a box whose open face's own
  edges are filleted, or a side face next to filleted edges): the body comes back **unchanged**.
* **No open face (`shell_face` -1, "closed hollow")**: `BRepOffset_MakeOffset` builds the wall only
  when faces are removed, so the result is the inward offset alone — a smaller *filled* solid (a
  20×20×10 box at 1.5 mm → a 17×17×7 solid, volume 2023) or, around fillets, a sheet with no solid
  (`mass_properties` → `is_solid:false`, volume 0). The measurement is right; the shape is wrong.

When the call **adds or edits** a Shell (`shell`, `add_feature`, `set_feature`), the kernel compares
the body right before and right after that feature in the replay record (no extra replay) and
refuses the edit like any failed one (`ok:false`, rolled back, `failed_feature` = the Shell) when the
body is unchanged (same face count and volume), when the result has no solid, or when a closed
hollow gives a solid without an inner shell. Messages start "the shell changed nothing", "the shell
produced a sheet with no solid", "a closed hollow (no open face) is not supported". Fixing the
closed hollow would change Orca's feature geometry — desktop Orca would rebuild the same recipe to
a different body (and face ids) — so it is refused rather than fixed. Opening a recipe that
already contains such a Shell rebuilds it as Orca does (no refusal). A solid with a real cavity
(e.g. a `boolean` subtract of an enclosed body) measures outer minus cavity (golden test).

## Concepts

### Documents

Documents live inside the module between calls, addressed by an integer handle `doc` returned by
`doc_new` / `doc_open`. Several can be open. `doc_close` frees one. A module instance that traps
(`RuntimeError`) has lost all its documents: the host must keep the latest `doc_save` bytes and reopen.

### Ids

| id | meaning | lifetime |
|---|---|---|
| feature index | position in the history (`features[]`) | until a history edit (delete/move) shifts it |
| body index | position in the rebuilt body list | until a rebuild changes the body list |
| face id | ordinal of the face in `TopExp_Explorer(body, FACE)` of **that body** | one `generation` |
| edge id | 0-based index in `TopExp::MapShapes(body, EDGE)` of **that body** | one `generation` |
| datum plane ordinal | `0` XY, `1` XZ, `2` YZ, `3+N` = Nth enabled Plane feature | until planes are added/removed |
| sketch entity / constraint index | position in the sketch's `entities` / `entity_constraints` | until that sketch changes |

These are exactly the numbers Orca stores in the recipe (`dressup_edges`, `shell_face`, `draft_face`,
`up_to_face`, …), re-resolved by ordinal on every rebuild — so they are **the** way to reference
topology, and they are stable across save/reopen as long as the history above them is unchanged
(the kernel is deterministic). `generation` (Orca's `topo_generation`) increases on every rebuild;
every method that takes a face/edge id accepts an optional `generation` and refuses a mismatch
with -32010. Always pass it from the mesh/topology you picked on. `add_feature` / `set_feature`
(v1.2) check it only when `fields` sets a face / edge id field (`up_to_face`, `extrude_src_face`,
`dressup_edge(s)`, `shell_face`, `draft_face`, `plane_face(2)`, `plane_edge(2)`, `bool_target_face`,
`bool_tool_face`, `axis_face`, `axis_edge`, `coordsys_face`, `coordsys_edge`, `thicken_face`,
`cut_face`, `project_edges`, `project_face`, `delete_faces`) to an id ≥ 0 or a non-empty list;
other edits ignore it, and requests without `generation` are not checked. For `set_feature` of an
existing feature the ids name its *input* geometry: pass the document's `generation` at the time
the ids were read (it changes whenever anything rebuilds). (A call that is rolled back or
does not need a rebuild leaves `generation` unchanged.)

### Units and frames

Millimetres; feature angles in **degrees**; sketch entity angles (`start_angle`, `end_angle`,
`rotation`) in **radians**. World frame = Orca's (Z up, bed plane XY). The default XY/XZ/YZ sketch
planes pass through the document's `modeling_origin` (Orca uses the bed centre). Note Orca's XZ
plane has normal **+Y** (not x×y = −Y), kept for file compatibility.

### Planes (`plane` argument)

Either a name `"XY" | "XZ" | "YZ"` (through `modeling_origin`, like McpControl) or a full frame
`{ "origin":[x,y,z], "normal":[x,y,z], "x_axis":[x,y,z], "y_axis":[x,y,z] }` (e.g. from
`plane_of_face` or `datums`).

## Feature JSON

A feature is Orca's `CadFeature` "fat struct": **every** field exists on every feature; each type
reads only its own. JSON keys are the C++ member names verbatim (also the names `set_feature_expr`
binds). `get_feature` returns all of them; `add_feature` / `set_feature` take any subset.

Enumerations are strings (integers are accepted too):

| field | values (ordinal order — the wire format) |
|---|---|
| `type` | Sketch, Extrude, Fillet, Chamfer, Hole, Thread, Shell, Revolve, Sweep, Pattern, Plane, Loft, Draft, Import, Boolean, Cut, Mirror, Axis, CoordSys, Helix, Transform, Thicken, Project, DeleteFace, Rib, SurfaceExtrude, SurfaceRevolve, ThickenSurface, SurfaceOffset, SurfaceLoft, SurfaceFill, Mate |
| `shape` | Rectangle, Circle |
| `mode` | New, Add, Cut, Intersect |
| `extrude_end` | Blind, Symmetric, TwoSided, ThroughAll, UpToFace, UpToVertex |
| `face_group` | Top, Bottom, Lateral, All |
| `plane_type` | Offset, Angle, Midplane, Tangent, TwoEdges, Coincident |
| `axis_type` | TwoPoints, FaceNormal, CylinderCenterline, PlaneIntersection, AlongEdge |
| `coordsys_type` | PointWorld, FaceAndDirection |

Value types: `Vec2d` → `[x,y]`, `Vec3d` → `[x,y,z]`, `plane` → plane frame object, `profile` →
`{points:[[x,y]…], closed}`, `constraints` (legacy profile constraints) → `[{type,a,b,c,d,value}]`,
`entities` / `entity_constraints` → see Sketch JSON, `imported_regions` →
`[region[loop[[x,y]…]…]…]` (loop 0 outer, others holes), `expr` → `{field: "expression"}`,
`loft_profile_refs` / `dressup_edges` / `project_edges` / `delete_faces` → int arrays.

`imported_solid` (the Import feature's embedded B-rep) is not inlined: `get_feature` reports
`brep_bytes` (length of its BRep text); `get_feature {include_brep:true}` adds `brep` (string).

Field reference by type (defaults in brackets; see `CadDocument.hpp:40-372` for semantics):

* **common**: `type`, `name`, `enabled` [true] (false = suppressed), `expr`, `target_body` [-1 = last body].
* **Sketch**: `plane`, `entities`, `entity_constraints`, `imported_regions`, `import_offset`,
  `import_scale_x/y` [1], `import_on_face`, `import_face_body`, `text_string`, `text_font`,
  `text_height`; legacy `shape`, `width` [20], `height` [20], `radius` [10], `profile`, `constraints`.
* **Extrude**: `sketch_ref`, `distance` [10], `extrude_end`, `distance2`, `taper_deg`, `flip`, `mode`,
  `up_to_face`, `up_to_point`, `extrude_src_face` (push/pull a face; `sketch_ref` -1), `symmetric` (legacy, unused by rebuild).
* **Fillet / Chamfer**: `dressup_size` [1], `dressup_edges` (edge ids), `dressup_edge` (first of them), `face_group` (when no edges).
* **Hole**: `plane`, `hole_x`, `hole_y`, `hole_diameter` [5], `hole_depth` [10], `hole_through` [true],
  `hole_style` (0 simple, 1 counterbore, 2 countersink), `hole_cbore_diameter`, `hole_cbore_depth`,
  `hole_csink_diameter`, `hole_csink_angle` [90], `hole_standard` (label only).
* **Thread**: `plane` (axis = normal), `thread_x/y`, `thread_radius` [5], `thread_pitch` [2],
  `thread_height` [10], `thread_depth` [1], `thread_internal`, `thread_major_nominal` (true for new threads).
* **Shell**: `shell_thickness` [2], `shell_face` [-1 = closed hollow: refused when added / edited, see [Shell refusals](#shell-refusals-v12)].
* **Draft**: `draft_face`, `draft_angle` [5].
* **Revolve**: `sketch_ref`, `revolve_angle` [360], `revolve_axis` (0 plane X, 1 plane Y), `revolve_axis_entity` [-1], `flip`, `mode`.
* **Sweep**: `sketch_ref` (profile), `sweep_path_ref` (Sketch or Helix), `mode`.
* **Loft**: `loft_profile_refs`, `loft_ruled`, `mode`.
* **Pattern**: `plane`, `pattern_circular`, `pattern_count` [3], `pattern_spacing` [20], `pattern_dir`,
  `pattern_angle` [360], `pattern_inclusive`, `pattern_curve_sketch` / `pattern_curve_entity` (along a curve).
* **Plane**: `plane_type`, `plane_base` (datum ordinal), `plane_offset` [20], `plane_angle_tilt`, `plane_axis`,
  `plane_face_body`, `plane_face`, `plane_face2_body`, `plane_face2`, `plane_edge_body`, `plane_edge`,
  `plane_edge2_body`, `plane_edge2`, `plane_u_size` [60], `plane_v_size` [60].
* **Import**: (embedded B-rep), `mode` New.
* **Boolean**: `mode` (Add/Cut/Intersect), `target_body`, `bool_tool_body`, `bool_keep_tool`, `bool_tolerance`, `bool_target_face`, `bool_tool_face`.
* **Cut**: `plane`, `cut_offset`, `cut_flip`, `cut_keep_upper` [true], `cut_keep_lower`, `cut_face_body`, `cut_face`.
* **Mirror**: `plane`, `mode` (New/Add), `mirror_keep_original` [true].
* **Axis**: `axis_type`, `axis_p1`, `axis_p2`, `axis_body`, `axis_face`, `axis_edge`, `axis_plane_a`, `axis_plane_b`.
* **CoordSys**: `coordsys_type`, `coordsys_point`, `coordsys_body`, `coordsys_face`, `coordsys_edge`, `coordsys_x_hint`, `coordsys_face_kind`, `coordsys_face_edges`.
* **Helix**: `plane`, `helix_radius` [10], `helix_pitch` [5], `helix_height` [20], `helix_left_handed`, `helix_taper_deg`.
* **Transform**: `xf_translate`, `xf_axis`, `xf_pivot`, `xf_angle_deg`, `xf_copy`.
* **Thicken**: `thicken_face`, `thicken_thickness` [2], `thicken_flip`.
* **Project**: `plane`, `project_source_body`, `project_edges`, `project_face` (entities regenerated on rebuild).
* **DeleteFace**: `delete_faces`.
* **Rib**: `rib_sketch_ref`, `rib_entity`, `rib_thickness` [2], `rib_depth` [10].
* **SurfaceExtrude / SurfaceRevolve / SurfaceLoft / SurfaceFill**: `sketch_ref`, `distance`, `revolve_angle`, `revolve_axis`, `loft_profile_refs`, `loft_ruled`.
* **ThickenSurface / SurfaceOffset**: `target_body`, `thicken_thickness`, `thicken_flip`.
* **Mate**: `mate_kind` (0 Fastened, 1 Planar, 2 Revolute, 3 Slider, 4 Cylindrical), `mate_cs_a`, `mate_cs_b`, `mate_offset`, `mate_angle`, `mate_flip`.

## Sketch JSON

Entity (`SketchEntity`), all fields always emitted:

```jsonc
{ "type": "line" | "arc" | "circle" | "point" | "ellipse" | "ellipse_arc" | "spline",
  "p0": [x,y], "p1": [x,y], "center": [x,y], "radius": r,
  "start_angle": rad, "end_angle": rad, "construction": false,
  "rminor": b, "rotation": rad, "ctrl": [[x,y]…] }
```

Meaning per type: line `p0→p1`; arc `center,radius,start_angle→end_angle` with `p0/p1` its ends;
circle `center,radius` (`p0` = centre); point `p0`; ellipse `center, radius` (semi-major),
`rminor`, `rotation`; ellipse_arc adds angles + `p0/p1`; spline = B-spline poles `ctrl` (`p0/p1` =
first/last pole). On input McpControl's shorthands are accepted: `{type:"point", p:[x,y]}`,
`centre` for `center`, and for arcs (v1.2: and elliptical arcs, from centre / radii / rotation /
parametric angles) `p0/p1` are derived from centre/radius/angles. `bspline` and
`ellipseArc` are accepted as type aliases.

Constraint (`SketchEntityConstraintDef`):

```jsonc
{ "type": "coincident", "ea": 0, "ra": "p0", "eb": 1, "rb": "p1", "value": 0, "ec": -1, "rc": "p0" }
```

`type` ∈ fix, coincident, horizontal, vertical, distance, lock_x, lock_y, equal_length, parallel,
perpendicular, concentric, tangent, midpoint, symmetric, angle (**degrees** on the wire, v1.2: every
method that takes or returns a constraint value — `sketch_constrain`, `sketch_describe`,
`sketch_set_constraint`, `sketch_set_value`, `sketch_plan`, the `entity_constraints` feature field;
the model and the recipe store radians, as Orca's solver reads them; v1.1 passed radians through),
radius, diameter,
point_on_line, point_on_object, equal_radius, collinear, distance_x, distance_y, symmetric_about_y,
symmetric_about_x (the slicer engine's lowerCamel spellings are accepted). Roles `p0 | p1 | center`.
`ea/eb/ec` = entity index, `-1` unused, `-2` sketch origin, `-3` sketch X axis, `-4` sketch Y axis.

Entity kinds (v1.2; libslvs asserts — the module traps — on several mismatches, and Orca's solver
checks only that the handles exist): radius / diameter need a circle or an arc; equal_radius two of
them; tangent a line or round entity on each side and at least one round one (two lines are
refused); concentric two circles / arcs / ellipses; equal_length / parallel / perpendicular / angle /
collinear two lines (or the sketch axes); point_on_line / midpoint a line as `eb`; symmetric a line
as `ec`. A request that breaks this is refused with -32602 naming the constraint; a stored one (a
recipe, or an entity changed by `sketch_set_entity`) is left out of the solve and reported in
`skipped`.

Solve result: `{ "solve_ok": bool, "dof": n, "result": SLVS_RESULT_*, "bad": [constraint idx],
"skipped": [constraint idx] }` (`dof` −1 when unknown). Loop report:
`{ "closed_loops": [{entities:[…], holes:[loop idx], closed, area, defect, defect_at?}],
"open_ends": [[x,y]…], "defects": [[x,y]…], "buildable": bool }`.

## Mesh blob layout

Methods that return meshes put all arrays in `out_blob` and describe them in JSON. Every array
starts at a 4-byte-aligned byte offset; lengths are element counts.

`get_mesh` / `regenerate {mesh:true}` / `feature_preview` — **display mesh**, per body:

```jsonc
"meshes": [{
  "body": 0,
  "faces": F,                                  // face count of the body (face ids 0..F-1)
  "positions": {"offset": o, "count": 3*V},   // Float32 xyz, world mm
  "normals":   {"offset": o, "count": 3*V},   // Float32, per vertex, smooth within a face
  "indices":   {"offset": o, "count": 3*T},   // Uint32, CCW = outward
  "triFace":   {"offset": o, "count": T},     // Int32: face id of each triangle
  "edgeIds":   {"offset": o, "count": E},     // Int32: edge id of each polyline
  "edgeStarts":{"offset": o, "count": E+1},   // Uint32: polyline k = points [edgeStarts[k], edgeStarts[k+1])
  "edgePoints":{"offset": o, "count": 3*P},   // Float32 xyz
  "edges": E,                                  // edge count (= edgeIds.count; only with edges)
  "edgeFlags": [{"edge": id, "seam": bool, "degenerate": bool}]   // only the flagged edges (only with edges)
}]
```

`edges`, `edgeIds`, `edgeStarts`, `edgePoints`, `edgeFlags` are present only when edges were
requested (`edges:true`, the default). A body with a null shape is skipped (no entry); a body with
zero faces has an entry with empty arrays.

Vertices are **not shared between faces** (crisp normals at B-rep edges; a face's triangles share
vertices). Edge polylines are every edge of the body once, including seam and degenerate edges
flagged in JSON (`edgeFlags`: `seam`, `degenerate`) so the UI can skip them when drawing but still
pick by id.

`export_mesh` — **plate mesh** (Orca's Commit to Plate tessellation: deflection 0.003 mm / 0.5 rad,
vertices welded, degenerate triangles dropped), per body: `positions` (Float32 xyz, shared),
`indices` (Uint32), `triFace` (Int32).

## Recipe (`Metadata/orca_cad.bin`)

Orca's cereal-binary recipe, versions 4–6 read, version 6 written (format in
`notes`/`CadDocument.cpp:4421-4628`). Behaviour:

* **Unchanged documents save byte-for-byte.** `doc_save` returns the exact bytes `doc_open` received
  until the document is mutated (`dirty`). Opening and saving a project never rewrites its design.
* **Import B-reps are saved without tessellation** (v1.2). A rebuild adopts an Import feature's
  B-rep as the body itself, so the display tessellation lands on its faces and Orca's
  `BRepTools::Write` would save it too (a Ø20 sphere: 2 MB). The kernel's writer saves a copy without
  it (topology copied in order, geometry shared): the same faces and ids read back, in Orca too.
  `doc_save {writer:"orca"}` still returns Orca's own bytes. So that a reopened design tessellates
  exactly as the session that made it, `import_step`, `import_mesh` and the primitive verbs store the
  B-rep as a save → reopen gives it back (written without tessellation and read again; idempotent):
  plate meshes of Import bodies are byte-identical after save → reopen (tested), so linked plate
  objects keep their mesh and paint. A recipe saved with Orca's tessellation (desktop Orca, kernel
  v1.1) is re-tessellated once after the first v1.2 save and reopen.
* **Unknown bytes are kept.** Bytes a newer Orca appended to a feature frame (fields after
  `revolve_axis_entity`), to the variables / body-name / extras blocks, or after the last block are
  re-emitted unchanged on save after edits (per-feature tails follow their feature through
  reorder/delete).
* **Newer format → read-only.** A recipe with version > 6 opens `read_only: true` (displayed by
  reading it with the v6 framing when possible); every mutating method fails with -32020 and
  `doc_save` returns the original bytes.
* v1–v3 are refused (Orca's message) with -32030; the bytes should be kept by the host as opaque.
* Bytes that are not a recipe at all (another file, random data) are refused with **-32031**
  "not a Design-tab recipe (Metadata/orca_cad.bin): …" before Orca's reader sees them (checked: format
  number 1–1000, feature count that fits the size). A recipe whose header is plausible but whose body
  is damaged still gives -32030.
* **A recipe can open with a failing rebuild** (`doc_open` → `ok:false`, `error`, `failed_feature`,
  no bodies), exactly as in Orca: `recompute()` replays the whole history and stops at the first failing feature, and
  a failed replay leaves no bodies (there is no partial result or rollback marker). Orca's own
  golden fixtures (`cad_recipe_v4/v5.bin`, a serialisation-coverage tree) are such documents
  ("fillet radius too large for this geometry"). Because every history edit is transactional
  (rolled back if the rebuild still fails), such a document cannot be repaired one suppression at
  a time when several features fail: use `suppress_feature {indices:[…]}` (one rebuild) or
  `{force:true}`.

## Methods

Every method takes `doc` (except the stateless ones). Mutating methods return the McpControl result
shape plus `generation`, and fail with -32020 on a read-only document.
"McpControl" = same name and argument names as Orca's `src/slic3r/GUI/CAD/McpControl.cpp`.

### Module

| method | params | result |
|---|---|---|
| `describe_tools` | – | `{ module, methods:[name…], feature_types:[…], fields:[{name, type, enum?}], bindable_fields:[…], id_lifetime }` |
| `thread_standards` | – | `{ threads:[{name, major_diameter, pitch, series, depth, minor_diameter, internal_depth}] }` |
| `hole_standards` | – | `{ holes:[{designation, clearance, cbore_diameter, cbore_depth, csink_diameter}] }` |
| `step_to_mesh` | blob = STEP bytes, `{linear_deflection?=0.003, angular_deflection?=0.5}` | stateless: `{ solids:n, meshes:[plate-mesh layout] }` + blob |

### Document lifecycle

| method | params | result |
|---|---|---|
| `doc_new` | `{modeling_origin?:[x,y,z], auto_close_loops?:true, replay_cache?:true}` | `{doc, generation}` |
| `doc_open` | blob = recipe bytes, `{modeling_origin?, replay_cache?:true}` (`modeling_origin` used only when the recipe has none) | `{doc, version, read_only, read_only_reason?, ok, error, failed_feature, failed_feature_name, cancelled, features, bodies, generation, ms, unknown:{feature_tail_bytes, block_tail_bytes, trailing_bytes}}` (`ok` = the rebuild succeeded; the document is open either way — also when the rebuild was `cancelled`: then it has no bodies until a `regenerate`; `ms` = kernel time of the load + rebuild; `failed_feature`: see "Geometry failures") |
| `doc_save` | `{doc, canonical?:false, writer?}` | blob = recipe; `{bytes, version, verbatim}` (`verbatim` = the original bytes were returned; `canonical:true` forces re-serialisation; `writer:"orca"` returns Orca's own `serialize_recipe()`, which drops unknown bytes — for tests) |
| `doc_close` | `{doc}` | `{}` |
| `doc_list` | – | `{docs:[{doc, features, dirty, read_only}]}` |
| `describe_scene` | `{doc}` | McpControl: `{modeling_origin, features:[{index,type,name,enabled}], bodies:[{index,name,user_name,has_color,color?,source_feature,bbox?,center?,is_solid,face_count?,edge_count?}], error, generation}` + `{read_only, dirty, can_undo, can_redo, variables, variable_values, variable_errors, mate_conflicts:[{feature,reason}], auto_close_loops, sketch_open, rebuild_ms, rebuild_ok, failed_feature, failed_feature_name, replay_cache}` — see below |
| `set_document` | `{doc, modeling_origin?, auto_close_loops?, replay_cache?}` | rebuild result (`replay_cache:false` also drops the cache) |
| `undo` / `redo` | `{doc}` | `{ok, can_undo, can_redo, generation, error, rebuild_ok, failed_feature, failed_feature_name, replayed_from, cancelled}` (`failed_feature` here describes the state undone/redone to; a cancelled undo/redo changes nothing: `ok:false, cancelled:true`) |

`describe_scene` fields beyond McpControl's:

* bodies: `face_count` / `edge_count` = number of face / edge ids of the body (TopExp_Explorer faces,
  TopExp::MapShapes edges); absent only for a body with a null shape. `bbox` / `center` are absent for
  a null or empty (0-face) body.
* `variables` = `{name: expression}`; `variable_values` = `{name: number}` for every variable that
  evaluates; `variable_errors` = `{name: message}` for every one that does not (it, or a variable it
  uses, is unknown, cyclic or malformed). Each variable is evaluated on its own (Orca's evaluator on
  the variables it reaches), so one bad variable does not hide the others' values.
* `rebuild_ok` = the current history rebuilt; when false, `failed_feature` / `failed_feature_name`
  name the feature it fails on (-1/"" = not one feature). `error` keeps Orca's meaning: the last
  rebuild error, which after a rolled-back edit is that edit's error even though the document is back
  in its (rebuilding) state — use `rebuild_ok` for the state.
* `rebuild_ms` = kernel time of the last rebuild; `replay_cache` = whether the document uses the
  replay cache.

Undo/redo: Orca's own model (snapshot of features + variables per user action, cap 200), extended to
also carry body names/colours and unknown tails. Every successful mutating call is one step; a
rolled-back call adds none. An open sketch session is not part of it (its own `sketch_undo`).

### Features (generic — CubbySlicer additions)

| method | params | result |
|---|---|---|
| `list_features` | `{doc, full?:false}` | `{features:[{index,type,name,enabled, …all fields when full}]}` |
| `get_feature` | `{doc, index, include_brep?}` | `{feature:{…all fields…}, brep_bytes}` |
| `add_feature` | `{doc, type, name?, fields:{…}, generation?}` | `{ok, index, bodies, error, generation}` (appended; rolled back on failure; `generation` checked when `fields` has face / edge ids, -32010) |
| `set_feature` | `{doc, index, fields:{…}, generation?}` | `{ok, bodies, error, generation}` — transactional edit of any field except `type`; feature refs must point at earlier features; `generation` as for `add_feature` |
| `rename_feature` | `{doc, index, name}` | `{ok}` |
| `suppress_feature` | `{doc, index, suppressed, force?:false}` or `{doc, indices:[…], suppressed, force?:false}` | `{ok, kept, index \| indices, enabled (index form), bodies, error, generation, failed_feature, …}` (Orca `set_feature_enabled`: transactional, keeps body/datum refs). `ok` = the rebuild succeeded; `kept` (always present) = the toggle is in the document now: `ok:true, kept:true` applied; `ok:false, kept:false` refused and rolled back; `ok:false, kept:true` forced through a failing rebuild (then `failed_feature` names where the kept state fails). **CubbySlicer:** `force` keeps the toggle even when the rebuild still fails (never after a cancelled rebuild); `indices` toggles several features with one rebuild and one undo step (rolled back on failure unless `force`). Both apply the flag directly, without Orca's body-reference re-pointing (exact for features that do not add or remove bodies; meant for repairing a document that does not rebuild). |
| `move_feature` | `{doc, index, to}` or `{doc, index, delta}` | `{ok, index, bodies, error, generation}` (Orca `move_feature`, step by step; refuses a consumer above its input) |
| `delete_feature` | `{doc, index}` | `{ok, removed:[indices], bodies, error, generation}` (deleting a Sketch cascades to its consumers) |
| `feature_preview` | `{doc, type, fields}` | `{ok, error, meshes}` + blob: **plate-mesh layout** (positions + indices, no triFace) of every body with the candidate applied, not added to the history (Orca `preview`, the translucent ghost) |
| `faces_made_by` | `{doc, index, replay?:false}` | `{faces:[[body, face]…], generation, replayed}` — Orca's answer (faces on the boundary right after the feature and not right before it), computed from the record of the rebuild that produced the current bodies: **no replay** (`replayed:false`). Only without a complete record of the current history (it does not rebuild) does it fall back to Orca's scratch replay up to the feature (`replayed:true`; `replay:true` forces that, for tests). Faces only: Orca attributes no edges. |
| `regenerate` | `{doc, linear_deflection?, angular_deflection?, mesh?:true, edges?:true, bodies?, full?:false}` | `{ok, error, generation, bodies:[…], mate_conflicts, ms, failed_feature, failed_feature_name, replayed_from, cancelled}` + display meshes when `mesh` (deflections persist on the document for later rebuilds; not saved in the recipe; default 0.003 mm / 0.5 rad = Orca). A rebuild of the history through the replay cache (changed deflections replay everything); `full:true` replays everything regardless. To fetch meshes of the current state use `get_mesh`, which does not rebuild. A cancelled regenerate leaves the document as it was. Allowed on read-only documents. |

### Variables and expressions (McpControl)

| method | params | result |
|---|---|---|
| `set_variable` | `{doc, name, expr}` (empty `expr` deletes) | `{ok, name, error, generation, rebuilt, failed_feature, …}` — `rebuilt:false` when no feature expression reads the variable (directly or through other variables; disabled features count, since bound values are saved), the document currently rebuilds and every variable still evaluates: the change is kept (undo step, `dirty`) without a rebuild and `generation` is unchanged. Otherwise it rebuilds (through the replay cache: from the first feature whose bound values changed). A variable that does not evaluate is refused even when unused (Orca fails the whole rebuild on it). |
| `set_feature_expr` | `{doc, feature, field, expr}` (empty clears; `field` must be in `describe_tools.bindable_fields`) | `{ok, feature, field, error, generation}` |

Expressions: `+ - * /`, unary minus, parentheses, `sqrt abs sin cos tan min max deg rad`, `pi`;
**trig in degrees**; variables may reference each other (cycles are an error). A failing
expression fails the rebuild (rolled back like any other edit).

### Build verbs (McpControl, same arguments and results)

All create features (appended to the history) and rebuild; on a geometry failure the document is
rolled back and the result is `ok:false` with the kernel's `error`. Every one accepts `name`.
`plane` accepts the plane-object form everywhere (McpControl: only XY/XZ/YZ). `body` = target body
index (default -1 = last body). Methods taking face/edge ids accept `generation`. Every result also
carries `{ok, bodies (count), error, generation}`.

| method | params (defaults) | result extra |
|---|---|---|
| `extrude` | McpControl: `width`=20, `height`=20 (rectangle) or `profile:[[x,y]…]` (closed polygon), `plane`=XY, `distance`=10 (>0), `boolean` new\|union\|subtract\|intersect, `end` blind\|symmetric\|two_sided\|through_all\|up_to_face, `distance2`, `up_to_face`, `taper` (deg), `flip`. **+ CubbySlicer:** `sketch` (extrude this existing Sketch feature instead of creating one), `face` (push/pull this face of `body`; no sketch), `end:"up_to_vertex"` + `up_to_point:[x,y,z]`, `body` | `sketch_index, extrude_index, end` |
| `revolve` | McpControl: `width`=20, `height`=10 or `profile`, `angle`=360, `axis` 0\|1, `flip`, `plane`, `boolean`. **+** `sketch`, `axis_entity` (a Line of the sketch), `body` | `sketch_index, revolve_index` |
| `fillet` / `chamfer` | McpControl: `edge` (id or array: one feature, all ids on `body`), `radius` / `distance`=1, `body`. **+** `face_group` Top\|Bottom\|Lateral\|All instead of `edge` | `fillet_index` / `chamfer_index, body` |
| `hole` | McpControl: `diameter`=5, `depth`=10, `through`=false, `x`,`y` (plane frame), `plane`. **+** `body` | `hole_index` |
| `hole_styled` | McpControl: + `style` 0\|1 counterbore\|2 countersink, `cbore_diameter`, `cbore_depth`, `csink_diameter`, `csink_angle`=90, `standard`; `through`=true | `hole_index` |
| `hole_standard` | McpControl: `designation` (`hole_standards`), `style`, `through`=true, `depth`, `x`, `y`, `plane` | `hole_index` |
| `thread` | **CubbySlicer** (Orca has no verb): `designation` (`thread_standards`, fills pitch/depth) or `diameter` / `radius` (major, nominal), `pitch`, `depth` (default 0.6134·pitch, internal: tapped depth), `height`=10, `internal`=false, `x`,`y`, `plane` (axis = normal), `body` | `thread_index` |
| `boolean` | McpControl: `op` union\|subtract\|intersect (=subtract), `target`=0, `tool`=1, `keep_tool`, `tolerance`. **+** `target_face`, `tool_face` (face weld) | `boolean_index` |
| `pattern` | McpControl: `circular`, `count`=3, `spacing`=10, `dir` 0\|1, `angle`=360, `plane`, `body` | `pattern_index` |
| `pattern_on_curve` | McpControl: `count`, `sketch`, `entity`, `body` | `pattern_index` |
| `shell` | McpControl: `thickness`=1, `face`=-1 (closed hollow), `body`. **v1.2:** a no-op / sheet / closed-hollow result is `ok:false` ([Shell refusals](#shell-refusals-v12)) | `shell_index` |
| `draft` | McpControl: `face`, `angle`=5, `body` | `draft_index` |
| `mirror` | McpControl: `plane`=XZ, `mode` new\|add, `keep_original`=true, `body` | `mirror_index` |
| `transform` | McpControl: `body`, `dx,dy,dz`, `axis_x,axis_y,axis_z`=(0,0,1), `pivot_x/y/z`, `angle`, `copy` | `transform_index` |
| `thicken` | McpControl: `body`, `face`, `thickness`=2, `flip` | `thicken_index` |
| `split` | McpControl: `body`, `face_body`=-1, `face`, `keep_upper`=true, `keep_lower`=true | `split_index` |
| `cut` | **CubbySlicer** (Orca's plane Cut card): `plane`, `offset`, `flip`, `keep_upper`=true, `keep_lower`, `body` | `cut_index` |
| `rib` | McpControl: `sketch`, `entity`, `thickness`=2, `depth`=10, `body` | `rib_index` |
| `delete_face` | McpControl: `body`, `faces:[…]` | `feature_index` |
| `project` | McpControl: `source_body`, `face`, `edges:[…]`, `plane` | `project_index` |
| `bridge` | McpControl: `sketch`, `ent_a`, `end_a`=1, `ent_b`, `end_b`=0 | `sketch_index, entity_index` |
| `axis` | McpControl: `type` two_points\|face_normal\|cylinder\|plane_intersection\|along_edge, `p1`, `p2`, `body`, `face`, `edge`, `plane_a`, `plane_b` | `axis_index` |
| `coordsys` | McpControl: `type` point_world\|face_and_direction, `point`, `body`, `face`, `edge`, `x_hint` | `coordsys_index` |
| `helix` | McpControl: `radius`=10, `pitch`=5, `height`=20, `left_handed`, `taper_deg`, `plane` | `helix_index` |
| `mate` | McpControl: `kind` 0..4, `cs_a`, `cs_b`, `offset`, `angle`, `flip` | `mate_index` |
| `mate_options` | `{doc, cs_a, cs_b}` (read-only) | `{options:[{kind, viable, reason}] }` |
| `sweep` | **CubbySlicer**: `profile` (Sketch), `path` (Sketch or Helix; the `design_sweep` bridge tool takes it as `sweep_path`, since cubby-mcp keeps `path` for itself), `boolean`, `body` | `sweep_index` |
| `loft` | **CubbySlicer**: `profiles:[sketch…]`, `ruled`, `boolean`, `body` | `loft_index` |
| `plane_datum` | **CubbySlicer**: `base` (datum ordinal), `offset`=20, `angle`, `axis`, `fields` (any Plane field, e.g. `plane_type` + face refs) | `plane_index` |
| `surface_extrude` / `surface_revolve` / `surface_fill` | McpControl: `sketch`, `distance` / `angle`,`axis` | `feature_index` |
| `surface_loft` | McpControl: `profiles`, `ruled` | `feature_index` |
| `thicken_surface` / `surface_offset` | McpControl: `body`, `thickness`,`flip` / `offset` | `feature_index` |
| `box` / `cylinder` / `cone` / `sphere` / `torus` | **CubbySlicer v1.2** (Orca has no primitive feature): `plane`=XY (name or frame), `x`,`y` (plane frame), `z` (along the normal), `name`; box `width` (plane X)=20, `depth`=20, `height`=20 (along the normal), centred on the point, base on the plane; cylinder `radius`=10, `height`=20; cone `radius1` (base)=10, `radius2` (top)=0, `height`=20 (radii ≥ 0, not both 0, not equal); sphere `radius`=10 (centre at +radius: resting on the plane); torus `major_radius`=10, `minor_radius`=2.5 (< major; centre at +minor). CubbyCAD's shape frame. | `primitive_index, body` — **one Import feature** holding the exact B-rep (`BRepPrimAPI_Make*`): saved as BRep text in `orca_cad.bin` like an imported STEP solid and read back by Orca 2.5.0's own recipe code (tested: Orca's `serialize_recipe` / `deserialize_recipe` round trip in the kernel; desktop Orca runs that code on the same OCCT 8.0.1 — not run here). **Not parametric**: the dimensions are baked into the B-rep (no field edits them; delete and add again, or use Sketch + Extrude / Revolve for an editable shape). Bad dimensions → -32602 |
| `import_step` | blob = STEP file (McpControl takes a `path`) | `imported, first_feature` (one Import feature per solid) |
| `import_mesh` | blob = mesh, `{positions:{offset,count}, indices:{offset,count}}` (Float32 xyz / Uint32), `tolerance`=0.01, `merge_angle_deg`=5 (McpControl takes a `path`) | McpControl conversion report (`watertight`, `is_solid`, `faces_final`, …) |

Any feature type, with every field, can also be created with `add_feature` (that is how a UI
should create Sweep/Loft/Plane/… with full control) and edited afterwards with `set_feature`.

### Bodies

| method | params | result |
|---|---|---|
| `set_body` | `{doc, body, name?, color?:[r,g,b,a]}` (`null` clears) | `{ok}` (saved in the recipe) |
| `export_mesh` | `{doc, bodies?:[i…], linear_deflection?, angular_deflection?}` | plate-mesh layout + blob |
| `export_step` | `{doc, bodies?:[i…]}` | blob = STEP (AP214, native B-rep) `{bytes}` |
| `get_mesh` | `{doc, bodies?, edges?:true}` | display-mesh layout + blob |

### Queries (read-only)

| method | params | result |
|---|---|---|
| `query_topology` | `{doc, body=0}` | McpControl `{body, face_count, edge_count, faces:[{id,centroid,normal,kind,surface,radius?,axis?,internal?}], edges:[{id,length,p0,p1,kind,radius?,center?}], generation}` — `kind` planar\|cylindrical\|other (McpControl calls every non-cylinder "planar"), `surface` = exact OCCT surface type |
| `face_info` | `{doc, body, face, generation?}` | `{id, surface: plane/cylinder/cone/sphere/torus/bspline/…, area, centroid, normal, plane?:{plane frame}, cylinder?, edges:[ids], bbox}` |
| `edge_info` | `{doc, body, edge, generation?}` | `{id, curve: line/circle/ellipse/bspline/…, length, p0, p1, circle?, faces:[ids], polyline}` |
| `plane_of_face` | `{doc, body, face, generation?}` | `{ok, plane, error?}` (sketch-on-face frame; planar faces only) |
| `datums` | `{doc}` | `{base_planes:[{name:"XY"\|"XZ"\|"YZ", plane}], planes:[{name, plane}] (Plane features), axes:[{name, origin, direction, error}], coordsys:[{name, origin, x, y, error}]}` |
| `body_touching_sketch` | `{doc, sketch}` | `{body}` |
| `measure` | McpControl `{doc, body=0, a, b, generation?}`; `a`/`b` = `{face}` \| `{edge}` \| `{point:[x,y,z]}` | `{distance, point_a, point_b, angle_deg?}` (face → centroid + normal, edge → mid sample + chord direction; centroid distance, not minimum distance) |
| `mass_properties` | McpControl `{doc, body=0}` | `{volume, surface_area, center_of_mass, inertia, is_solid, valid}` |
| `slice_body` | McpControl `{doc, body=0, plane:"XY"\|"XZ"\|"YZ", offset}` (world planes through the world origin, not `modeling_origin`) | `{body, plane, offset, segment_count, contour_count, closed_count, contours:[{closed, points:[[x,y,z]…]}]}` |
| `check_interference` | McpControl `{doc, min_volume}` | `{ok, count, interferences}` |
| `validate_against` | McpControl `{doc, body, reference:{body} }` (or blob STEP with `reference:{step:true}`) | deviation report |

### Sketch sessions

One open sketch per document (as in Orca). The session holds `entities` + `entity_constraints`
and a selection; it is written into the document only by `sketch_commit`.

| method | params | result |
|---|---|---|
| `sketch_begin` | McpControl `{doc, plane}`; or `{doc, feature}` = edit an existing Sketch; or `{doc, face:{body, face}, generation?}` = on a planar face | session state (as `sketch_describe`) |
| `sketch_commit` | `{doc, name?, fields?}` | `{ok, features, sketch_index, fields_applied, error, generation}` (new Sketch feature, or transactional edit of the edited one). v1.2: `fields` = other Sketch fields set in the same rebuild (not `type` / `entities` / `entity_constraints` / `plane`, which come from the session), e.g. a Text / SVG sketch's `imported_regions`, `import_offset`, `text_*`; a session with no entities and no `imported_regions` is refused (-32602), as desktop Orca ("Sketch empty — nothing committed"); an existing Sketch feature with no entities (Orca's legacy `shape` sketches, e.g. the golden fixture's) still extrudes its legacy rectangle / circle, as in Orca |
| `sketch_cancel` | `{doc}` | `{ok}` |
| `sketch_add` | McpControl: `{entities:[…]}` \| one entity via `type` \| `rect:[x0,y0,x1,y1]`; + `infer?:true` | `{ok, first_index, added, entities (count), constraints (count), dof, solve…}` (auto Coincident/H/V like Orca's scripted add) |
| `sketch_select` | McpControl `{entities:[…]}` | `{ok, selected, any}` |
| `sketch_delete` | McpControl `{entities?}` | `{ok, removed, entities}` (constraints on removed entities dropped, others re-indexed) |
| `sketch_construction` | McpControl `{entities?}` | `{ok, changed}` |
| `sketch_offset` / `sketch_mirror` | McpControl: `{entities?, distance}` / `{entities?, axis_a:[x,y]=[0,0], axis_b:[x,y]=[0,1]}` (mirror line through two points) | `{ok, first_index, added, dof}` |
| `sketch_describe` | `{doc}` | McpControl `{entities, constraints, dof, solve_ok, selection, …loop report}` — `constraints` here is the full **array** (Orca returns a count) |
| `sketch_validate` / `sketch_heal` | McpControl | `{…, loop report}` |
| `sketch_set_value` | McpControl `{value}` (dimension of the selection) | `{ok, kind, before, value, dof, solve_ok, …}` |
| `sketch_constrain` | CubbySlicer `{constraint}` / `{constraints:[…]}` / the constraint's fields inline; `force?` (keep even if unsolvable) | `{ok, index (first added), added, entities, constraints, solve…}`; a batch that makes the sketch unsolvable is **not** added: `{ok:false, error, bad, conflicts, solver_bad, dof, …}` — v1.2: `conflicts` = every existing constraint whose removal lets the batch solve (found by the kernel, one trial solve each, up to 200 constraints), `bad` = `conflicts` + the new constraints' would-be indices, `solver_bad` = SolveSpace's own list (often only the newest) |
| `sketch_plan` | CubbySlicer `{type, entities:[e0,e1,e2?]}` | `{kind: apply\|ask_value\|reject, reason, constraints, prefill}` (Orca `plan_entity_constraint`: what a constraint button would do with that selection) |
| `sketch_set_constraint` | `{index, value}` (edit a dimension) | `{ok, entities, constraints, solve…}`; unsatisfiable → `{ok:false, bad}` and nothing changes |
| `sketch_delete_constraint` | `{index}` | same |
| `sketch_set_entity` | `{index, entity}` | same |
| `sketch_drag` | `{entity, role, to:[x,y]}` | same (Orca's drag solve: the other end of a dragged line stays put) |
| `sketch_solve` | `{}` | same + loop report |
| `sketch_infer` | `{entity, angle_tol?, length_tol?}` | `{constraints}` Orca's inference suggestions (not added) |
| `sketch_ops` | `{op:"fillet"\|"chamfer", a, b, radius\|distance}`, `{op:"trim"\|"extend", entity, pick:[x,y]}`, `{op:"array", entities?, count, step:[dx,dy], angle_step, pivot}`, `{op:"transform", entities?, move, angle, scale, pivot, copy?}` | `{ok, first_index?, released?, bound?, entities, constraints, solve…}` (SketchEngine's 2D ops; fillet/chamfer between two lines only, as Orca). v1.2, as Orca's `DesignSketchTool::confirm_op`: fillet / chamfer trim both legs, drop the corner Coincident and each leg's own length (`released`), and bind the new arc / segment with two Coincidents plus, for a fillet, two Tangents (falling back to one, then none, when they do not solve; `bound` = how many were added); trim / extend drop every constraint on the subject, as Orca's `apply_live_trim` (`released`) — v1.1 left them, so the solve pulled the cut end back |
| `sketch_undo` / `sketch_redo` | – | session-local undo of entity/constraint edits |

Every successful session edit returns `solve_ok`/`dof`/`bad`/`skipped`; `dof` is −1 while the
sketch has no constraints (nothing solved). The selection (`sketch_select`) drives
`sketch_set_value`, `sketch_delete`, `sketch_construction`, `sketch_offset`, `sketch_mirror` when
they get no `entities`. `sketch_add` infers like Orca's scripted add: exactly coincident endpoints
→ Coincident, exactly axis-aligned lines → Horizontal/Vertical, and (≤ 16 entities) exactly-true
relations; `infer:false` turns it off.

## Threading, memory, long operations

* Single-threaded. Every call runs to completion on the calling thread; run the module in a
  **dedicated Worker** (never on the page thread). Rebuilds of large designs, fillets, shells and
  STEP import can take seconds; threads tens of seconds (see Performance).
* **Rebuilds.** Every history-changing call rebuilds through Orca's `recompute()`: the parametric
  pass (variables → bound fields), then the features in order, then the finishing passes (datum
  references, connector fingerprints) and tessellation of every body at the document's deflection.
  Without the cache below its cost is the cost of the whole design, not of the edited feature (one
  slow feature — a thread, a pattern of a threaded body — makes every later edit slow). Show a busy
  state for any mutation; queue edits instead of sending them per keystroke.
* **Replay cache (CubbySlicer).** Every rebuild is recorded per feature (its state before and after
  its replay and the body list around it; shape handles). A later rebuild compares each feature's
  state (its recipe bytes after the parametric pass, plus the pending body-reference state; the
  Import B-rep by identity) with the recorded ones; if features `0..k-1` are byte-identical and none of
  them reads a feature at or after `k` (`sketch_ref`, `sweep_path_ref`, `loft_profile_refs`,
  `pattern_curve_sketch`, `rib_sketch_ref`, `mate_cs_a/b`), their replay would repeat exactly, so they
  are put back to their recorded results and the loop starts at `k` from a **copy** of the recorded
  body list (topology copied, geometry shared, no triangulation — the same inputs a full replay would
  hand feature `k`). The finishing passes and the tessellation always run. Inputs outside the features
  (`auto_close_loops`, `modeling_origin`, both deflections) must match too. The last 4 rebuilds are
  kept (sharing their common prefixes); `replayed_from` in every result says where the replay started.
  Consequences: editing feature `k` costs the replay of `k..end` plus tessellation; undo/redo and
  rollbacks land on a recorded state and replay nothing; `regenerate` without changes replays
  nothing. It does **not** help the first rebuild after `doc_open`, nor the edit after a
  `move_feature` / `delete_feature` / single-index `suppress_feature` (Orca marks every body reference
  for re-pointing, which changes every feature's state) and the edit after that one: those replay the
  whole history. Results are identical to a full replay (the tests compare every face and edge, by id,
  and the volumes); `regenerate {full:true}` or `replay_cache:false` (`doc_new` / `doc_open` /
  `set_document`) turn it off. Memory: the recorded intermediate B-reps stay alive (see Performance).
* **Progress.** Set `Module.cadProgress = (featureIndex, featureCount, name, cancellable) => bool` on
  the module instance (the object the factory resolves to). It is called synchronously, on the
  module's thread, before every feature that is actually replayed (`name` = the feature's name), and
  once with `featureIndex == featureCount` (`name` `""`) when the features are done and the finishing
  passes + tessellation start. Features taken from the replay cache are not reported. A throwing
  callback is ignored.
* **Cancellation.** Returning a truthy value from `cadProgress` cancels the rebuild when `cancellable`
  is true. It is asked only between features (and before tessellation): one long feature (a thread:
  seconds to tens of seconds) runs to its end first, so a host's "clean cancel or terminate after N s"
  fallback can fire during it. The call then returns `ok:false, cancelled:true, error:"rebuild cancelled"`,
  `failed_feature:-1`, and the document is exactly as before the call (same history, bodies and
  `generation`; no undo step): a mutation is rolled back, `regenerate` / `undo` / `redo` change
  nothing; `doc_open` still opens the document, with no bodies (call `regenerate` later). Only the
  first rebuild of a call is cancellable: once it fails or is cancelled, any rebuild the call still
  makes restores the previous state (Orca's own history edits — single-index `suppress_feature`,
  `move_feature`, `delete_feature` — restore by replaying, through the cache) and is reported with
  `cancellable:false`, its return value ignored. The module is single-threaded and the callback runs
  inside the call, so the Worker cannot receive a `postMessage` meanwhile: the callback must decide
  from what it can read synchronously (a time budget, a `SharedArrayBuffer` flag set by the page if
  the app is cross-origin isolated, …). Terminating the Worker remains the hard stop (all documents
  are lost with it; keep the last `doc_save` bytes on the host and reopen).
* Start-up: instantiating the module takes ~4.5 s in Node on this host, almost all of it static
  constructors of libslic3r (`PrintConfigDef` and the preset tables, pulled in through
  `TriangleMesh`/`ClipperUtils`; the slicer engine pays the same, 6.8 s). Start the Worker early
  (e.g. when the Design tab is first hovered or the app is idle), not on the first click.
* Memory grows on demand up to 4 GB and never shrinks; close documents you no longer show. A trap
  (`RuntimeError`, e.g. out of memory or stack) poisons the instance: recreate it.
* Ids: face/edge ids are re-resolved by ordinal on every rebuild; they were verified identical
  (same surface type and centroid per id) after save → reopen, for the from-scratch design and
  for the fixtures. `generation` changes on every rebuild, including a reopen and a rebuild served
  from the replay cache — never keep ids from a previous generation; re-read `query_topology`/`get_mesh`
  and pass `generation` back. A rolled-back or cancelled call and `set_variable {rebuilt:false}` keep
  the generation (nothing was rebuilt): compare `generation` values rather than assuming a change.
* The display mesh at Orca's 0.003 mm deflection is large (the repaired fixture: 2.4 MB of
  display-mesh blob for 6 bodies; one M8 thread body: 23 k triangles). Fetch `edges:false` or a
  subset of `bodies` when only part of the view changed.

## Verification under WebAssembly

`node tests/cad-test.mjs build-cad` (212 checks, ~7 min on this host; golden numbers in
`tests/cad-golden.json`, `--update` rewrites them) and `node tests/cad-smoke.mjs build-cad`
(80 checks, ~1 min). All pass. Golden numbers were produced by this build: they catch regressions,
not drift from a native Orca 2.5.0 build (none was available to compare against).

**Verified (results asserted):**

* Recipe I/O: v3 refused with Orca's message; v4 (flat) and v5 (framed) open with 34 features;
  unchanged documents save byte-for-byte; the bridge's writer equals Orca's `serialize_recipe()`;
  v6 re-serialisation is stable; every v5 frame is a byte prefix of its v6 frame; unknown feature /
  block / trailing bytes survive edits; v7 opens read-only, refuses edits (-32020), saves its
  original bytes; an Import feature holding the OCCT 7.6 BRep fixture loads (24 faces, Pappus volume
  to 1e-4) and round-trips through the recipe.
* Orca's golden fixture rebuild: fails as in Orca ("fillet radius too large for this geometry").
  With features 2 Fillet, 3 Chamfer, 5 Draft, 6 Shell and 29 Project suppressed (each fails on the
  tree's own geometry once the earlier ones are gone) the other 29 rebuild: Hole, internal Thread,
  plane Cut, linear Pattern, Plane datum, Revolve, Sweep, ruled Loft, Boolean cut, symmetric Extrude,
  Mirror, Axis, CoordSys, Helix, Transform, Thicken, split Cut, Mate → 6 bodies, golden volumes and
  face/edge counts; every face has display triangles; plate meshes are watertight (one body: 47 of
  112 k edges open after welding); the edited document saves as v6 and reopens to the same bodies
  and face ids. One body ends with **0 faces** (the tree's own GoldenSplit keeps an empty side once
  body indices have shifted): Orca rejects only a *null* shape, so an empty body is a legal result —
  the UI must cope with a body whose mesh is empty.
* A design from scratch: sketch (rectangle with inferred coincident/H/V, dimensions through
  `sketch_set_value`, `distance_x/y` to the origin → dof 0, a conflicting dimension refused with its
  index, `sketch_plan`) → extrude → fillet 4 edges → shell (top open) → second body → linear pattern
  → boolean union → Ø5 through hole → M6 counterbore (`hole_standard`) → M8 external thread on a
  cylinder; variable + expression drive a distance; `faces_made_by`, `face_info`, `edge_info`;
  `get_mesh` triangles cover all 39 faces; plate mesh watertight with mesh volume = B-rep volume;
  save → reopen: identical face and edge ids and geometry; the sketch's width dimension edited
  60 → 70 and regenerated (volume 10025.3 → 11345.3 mm³); undo / redo; suppress; refused move;
  sketch delete cascades and undoes; stale `generation` refused (-32010); STEP export → import gives
  the same volume and 39 faces; `step_to_mesh` watertight; `feature_preview`; `slice_body`; `datums`.
* Smoke (`cad-smoke.mjs`, every other method once; volume asserted for revolve and import_mesh):
  chamfer, hole_styled (counterbore, countersink), plane_of_face, measure, draft, mirror, transform,
  set_body, check_interference, validate_against, cut, thicken, delete_face, split, project, axis,
  coordsys, mate_options, helix, plane_datum, set_document, doc_list, revolve, sweep, loft,
  surface_extrude / offset / revolve / loft / fill, thicken_surface, body_touching_sketch, rib,
  pattern_on_curve, bridge, import_mesh, and the sketch session verbs (infer, select, construction,
  offset, mirror, set_entity, drag, solve, delete_constraint, ops fillet / array / transform / trim,
  undo, redo, delete, validate, heal, cancel); -32022 without a session; unknown handle refused.
  These calls return without error and (unless noted) build; their geometry is not checked.
  `mate` between two `point_world` connectors is refused ("mate_cs_b has no associated body", as
  Orca); the golden fixture's Mate (GoldenMate, between its CS_MateA/CS_MateB connectors) rebuilds.

* v1.1 additions (cad-test): `doc_open` / `describe_scene` name the fixture's failing feature (2
  `Fillet_Lat35`), a forced suppress names the next one (29 `GoldenProject`), a failing build verb names
  its own (rolled-back) feature and leaves `generation` and every face/edge unchanged; `suppress_feature.kept`
  in all five cases (applied, batch, refused, batch refused, forced); `faces_made_by` from the record =
  Orca's scratch replay for all 13 features of the design and features 1, 7 of the fixture; `set_variable`
  unused → `rebuilt:false`, same generation; used → rebuild from feature 1; an unused variable that does
  not evaluate is still refused; `variable_values`; `cadProgress` call sequence; cancel of a regenerate,
  an edit, an Orca transactional suppress (its restore runs uncancellable) and a `doc_open`, each
  leaving the document unchanged (topology signature compared); non-recipe bytes → -32031. Replay cache:
  on the repaired fixture an edit of feature 33 replays from 33 and its topology (every face's surface
  type, centroid and normal, every edge's end points, by id, and every volume) is **identical** to a
  following `regenerate {full:true}`; undo returns from the cache to the identical pre-edit topology;
  the golden volumes/face/edge counts that follow are computed on that cached state; on the design an
  edit of feature 9 replays from 9 and equals the full replay; a document after cached rebuilds saves
  the same canonical recipe as its reopened copy.

* v1.2 additions (cad-test): a 30 mm box whose side face 5 has its own edges filleted: `shell` on it,
  `add_feature Shell` and a `set_feature` of a good Shell to that face → `ok:false` "the shell changed
  nothing", rolled back (feature count, volume, `generation`, `failed_feature` = the Shell); the same
  box shelled open at its filleted top hollows it (golden volume); `shell {face:-1}` on a plain box
  (closed hollow) and on a filleted one (sheet) → `ok:false`; a box with an enclosed cavity
  (boolean subtract) measures 20·20·10 − 17·17·7 = 1977 (golden); `add_feature` / `set_feature` with
  ids and a stale `generation` → -32010, without ids or without `generation` → accepted, an ill-typed
  one → -32602; `box`, `cylinder`, `cone`, `sphere`, `torus`: one Import feature each, analytic
  volumes (golden), face counts, base on the plane, one undo step, a box on XZ grows along +Y; the
  five round-trip through the kernel's writer (11.8 KB) and through Orca's own `serialize_recipe` →
  `deserialize_recipe` (4.0 MB: Orca's writer keeps the tessellation) with the same faces, edges
  and volumes; a cone with equal radii → -32602; the plate meshes of primitives and of an imported
  STEP body are byte-identical after save → reopen. Sketch (K1–K8 of the sketcher slice): ten
  kind-mismatched constraints (radius / diameter / equal_radius on lines, tangent / concentric
  between lines, parallel / angle / equal_length with circles, a radius on the X axis) → -32602 with
  no trap; a circle turned into a line under its radius constraint solves without it (`skipped`);
  angle 60 / `sketch_set_constraint` 30 / `sketch_set_value` 45 give those angles in degrees and read
  back in degrees; fillet r2 at a constrained rectangle corner → legs (0,0)–(18,0) and (20,2)–(20,10),
  arc r 2 at (18,2), two tangents, corner coincident gone; trim of a line fixed at both ends drops
  its constraints and cuts it; a refused distance names the distance it conflicts with; ellipse_arc
  ends derived; an empty `sketch_commit` → -32602, one with only `fields.imported_regions` commits and
  extrudes (200 mm³).

**Not verified / known limits:** `sketch_ops extend` (the smoke pick found no intersection); `thicken_surface` refuses a non-planar (L-shaped) sheet
("cannot cap the sheet rim", Orca's own limit; a planar sheet works); text/SVG regions (host
side); `import_step` of third-party STEP files (only round trips of the kernel's own export);
`validate_against` with a STEP reference; the debug build (`BUILD_VARIANT=debug`, SAFE_HEAP) was
not built or run.

## Performance (measured)

Node 24, this host (6 shared cores, load 10–14 during the runs: expect better on a quiet machine).

| what | measured |
|---|---|
| `cad.wasm` | v1.2: 21 817 938 B raw, 6 919 078 B gzip -9, 4 790 432 B brotli -11 (v1.1: 21 788 778 / 6 912 245 / 4 781 165); `cad.mjs` 70 KB (20 KB gzip) |
| `WebAssembly.compile` / factory (instantiate + static constructors) | 0.3 s / 4.1–4.5 s |
| fixture v4 / v5 `doc_open` (rebuild fails at feature 2) | 0.3–1.9 s |
| fixture, 29 features rebuilt (`regenerate {full:true}`) | 37–46 s (internal Thread ≈ 30 s of it, Pattern of the threaded body ≈ 9 s) |
| repaired fixture (`tests/cad-perf.mjs`), before → after v1.1 | finding the failing feature: binary search over prefixes 209 s → 0 (in the `doc_open` / mutation result; the same search through the cache: 55 s) · `faces_made_by 21` 30 s → 30 ms (all 34 features: 360 s → 6.7 s) · `set_variable` of an unused variable 37 s → 8 ms · edit of the last feature (33) 58 s → 5.2 s · undo / redo 60 s → 5.0 / 5.3 s · `regenerate` without changes 37 s → 5.0 s · a failing edit (27) 112 s → 23 ms (fails in the resumed replay; rollback without a replay) |
| what a cached rebuild still costs | the replay from the first changed feature plus tessellation of every body (≈ 5 s on the repaired fixture, its thread body dominates); on the design an edit of feature 9 replays the M8 thread (feature 12) again: 5.8 s vs 6.1 s full |
| from scratch, each add (v1.1: replays only the new feature, the rest from the cache, then tessellates) | extrude 7 ms, fillet 0.13 s, shell 0.25 s, pattern 0.2 s, boolean 0.25 s, hole 0.33 s, M8 thread on a cylinder 6.4 s |
| thread on a 48-gon prism instead of a cylinder | 67 s even at 0.05 mm deflection — faceted bodies make the helical boolean far slower |
| reopen of the 13-feature design | 7 s |
| `export_step` / `import_step` (39-face body) | 0.4 s / 1.2 s |
| wasm memory | 128 MB initial; 154 MB after both fixtures, 184 MB peak in cad-test, 319 MB in cad-smoke (unchanged with the replay record and cache) |

## Differences from McpControl

* Transport: `cad_call(method, params, blob)` instead of JSON-RPC over a Unix socket; one document
  handle `doc` per call; files travel as blobs (`import_step`, `import_mesh`, `export_step`,
  `validate_against {reference:{step:true}}`) instead of paths.
* Errors: same codes (-32601/-32602/-32000/-32010) plus -32020..-32030 for documents; there is no
  busy guard (-32002) — the module has no GUI state, the host serialises calls.
* Sketch verbs act on the module's own session (no GUI tool modes, `pending`, `editing`, `tool`);
  `sketch_describe.constraints` is the full array, not a count.
* `list_verbs` / `run_verb` / `describe_tools` (Orca's hand-written descriptor) are GUI vocabulary
  and not provided; `describe_tools` here lists methods and the feature field schema.
* Added: generic `add_feature` / `get_feature` / `set_feature` / `rename_feature` / `suppress_feature`
  / `move_feature` / `delete_feature`, `thread`, `cut`, `sweep`, `loft`, `plane_datum`, all
  `sketch_*` constraint / dimension / drag methods, meshes with ids, recipe I/O, undo/redo,
  `face_info` / `edge_info` / `plane_of_face` / `datums` / `faces_made_by`, and a non-transactional
  `suppress_feature {force}` / `{indices}` for repairing documents that do not rebuild; v1.1: the
  failing feature in every rebuild result, rebuild progress / cancellation (`Module.cadProgress`), the
  replay cache, evaluated variables, `set_variable` without a rebuild when nothing reads the variable.

## Unsupported / differences from desktop Orca

* No GUI-only behaviour: offer menu (`list_verbs`/`run_verb`), gizmos, Esc ladder, draw-then-dimension
  queue, sketch tools (rectangle/slot/polygon gestures are composed by the UI from entities).
* Text and SVG are vectorised by the host (or the slicer engine's `cs_tool` `sketch` op) and passed as
  `imported_regions`; FreeType/nanosvg are not in this module.
* No multithreaded build (BRepMesh/booleans run single-threaded).
