"""Host application API

CubbySlicer answers these from its project and preset stores. Readers return
snapshots taken when called (Orca hands out live references); call the
accessor again to see later changes. Calls that need the app synchronously
require the page to be cross-origin isolated; without it they raise
RuntimeError saying so.
"""
import struct as _struct

from .. import _bridge
from .._core import _OrcaEnum
from ._geometry import BoundingBox, Point, Polygon, ExPolygon, _np  # noqa: F401
from ._slicing import (  # noqa: F401
    SurfaceType, Surface, SurfaceCollection, ExtrusionEntity, ExtrusionPath, ExtrusionLoop, ExtrusionMultiPath,
    ExtrusionEntityCollection, PrintRegion, LayerRegion, Layer, PrintObject, Print,
)

globals().update(SurfaceType.__members__)


class ModelVolumeType(_OrcaEnum):
    Invalid = -1
    ModelPart = 0
    NegativeVolume = 1
    ParameterModifier = 2
    SupportBlocker = 3
    SupportEnforcer = 4
    PreciseSeamCenter = 5
    PreciseSeamLeft = 6
    PreciseSeamRight = 7
    PreciseSeamEnforced = 8
    PreciseSeamBlocked = 9
    PreciseSeamNeutral = 10


class PresetType(_OrcaEnum):
    Invalid = 0
    Print = 1
    SlaPrint = 2
    Filament = 3
    SlaMaterial = 4
    Printer = 5
    PhysicalPrinter = 6
    Plate = 7
    Model = 8


def _matrix(m16):
    np = _np()
    return np.array(m16, dtype=np.float64).reshape(4, 4)


def _vec3(v):
    return (float(v[0]), float(v[1]), float(v[2]))


class _Painted:
    def is_fdm_support_painted(self):
        return bool(self._d.get("painted", {}).get("support"))

    def is_seam_painted(self):
        return bool(self._d.get("painted", {}).get("seam"))

    def is_mm_painted(self):
        return bool(self._d.get("painted", {}).get("mm"))

    def is_fuzzy_skin_painted(self):
        return bool(self._d.get("painted", {}).get("fuzzy"))


class TriangleMesh:
    """An immutable mesh snapshot in local mm."""

    def __init__(self, info, positions, indices):
        self._info = info
        self._pos = positions   # bytes, float32 x 3 per vertex
        self._idx = indices     # bytes, int32 x 3 per triangle

    def vertex_count(self):
        return self._info["vertex_count"]

    def triangle_count(self):
        return self._info["triangle_count"]

    def facets_count(self):
        return self._info["triangle_count"]

    def is_empty(self):
        return self._info["triangle_count"] == 0

    def vertices(self):
        """Read-only (N, 3) float32 ndarray of vertex positions (local mm). Requires numpy."""
        np = _np()
        a = np.frombuffer(self._pos, dtype=np.float32).reshape(-1, 3)
        a.flags.writeable = False
        return a

    def triangles(self):
        """Read-only (M, 3) int32 ndarray of triangle vertex indices. Requires numpy."""
        np = _np()
        a = np.frombuffer(self._idx, dtype=np.int32).reshape(-1, 3)
        a.flags.writeable = False
        return a

    def face_normals(self):
        """Per-triangle normalized normals as an (M, 3) float32 ndarray (copy). Requires numpy."""
        np = _np()
        V = self.vertices().astype(np.float64)
        T = self.triangles()
        n = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
        L = np.linalg.norm(n, axis=1)
        L[L == 0] = 1.0
        return (n / L[:, None]).astype(np.float32)

    def vertex(self, index):
        if not 0 <= index < self.vertex_count():
            raise IndexError("vertex index out of range")
        return _struct.unpack_from("<3f", self._pos, index * 12)

    def triangle(self, index):
        if not 0 <= index < self.triangle_count():
            raise IndexError("triangle index out of range")
        return _struct.unpack_from("<3i", self._idx, index * 12)

    def volume(self):
        return float(self._info["volume"])

    def bounding_box(self):
        return BoundingBox._from(self._info.get("bbox"))

    def is_manifold(self):
        return bool(self._info["manifold"])


class ModelVolume(_Painted):
    def __init__(self, d):
        self._d = d

    def id(self):
        return self._d["id"]

    name = property(lambda s: s._d["name"])

    def type(self):
        return ModelVolumeType[self._d["type"]]

    def is_model_part(self):
        return self._d["type"] == "ModelPart"

    def is_modifier(self):
        return self._d["type"] == "ParameterModifier"

    def is_negative_volume(self):
        return self._d["type"] == "NegativeVolume"

    def is_support_enforcer(self):
        return self._d["type"] == "SupportEnforcer"

    def is_support_blocker(self):
        return self._d["type"] == "SupportBlocker"

    def is_support_modifier(self):
        return self._d["type"] in ("SupportBlocker", "SupportEnforcer")

    def is_precise_seam(self):
        return self._d["type"].startswith("PreciseSeam")

    def is_precise_seam_strong(self):
        return self._d["type"] in ("PreciseSeamEnforced", "PreciseSeamBlocked")

    def is_precise_seam_weak(self):
        return self._d["type"] in ("PreciseSeamCenter", "PreciseSeamLeft", "PreciseSeamRight", "PreciseSeamNeutral")

    def extruder_id(self):
        return self._d["extruder"]

    def offset(self):
        return _vec3(self._d["offset"])

    def rotation(self):
        return _vec3(self._d["rotation"])

    def scaling_factor(self):
        return _vec3(self._d["scale"])

    def mirror(self):
        return _vec3(self._d["mirror"])

    def matrix(self):
        """Volume-to-object 4x4 float64 affine matrix (copy). Requires numpy."""
        return _matrix(self._d["matrix"])

    def facets_count(self):
        return self._d["facets"]

    def volume(self):
        return float(self._d["volume"])

    def bounding_box(self):
        return BoundingBox._from(self._d.get("bbox"))

    def is_manifold(self):
        return bool(self._d["manifold"])

    def mesh(self):
        """Return the volume's TriangleMesh (local coordinates) for vertex/triangle access."""
        info, blobs = _bridge.call("model.mesh", mesh=self._d["mesh"])
        return TriangleMesh(info, blobs[0], blobs[1])

    def mesh_errors_count(self):
        return 0

    def config_keys(self):
        return list(self._d.get("config", {}).keys())

    def config_value(self, key):
        return self._d.get("config", {}).get(key)


class ModelInstance:
    def __init__(self, d, obj):
        self._d = d
        self._obj = obj

    def id(self):
        return self._d["id"]

    printable = property(lambda s: bool(s._d["printable"]))

    def is_printable(self):
        return bool(self._d["is_printable"])

    def offset(self):
        return _vec3(self._d["offset"])

    def rotation(self):
        return _vec3(self._d["rotation"])

    def scaling_factor(self):
        return _vec3(self._d["scale"])

    def mirror(self):
        return _vec3(self._d["mirror"])

    def matrix(self):
        """Object-to-world 4x4 float64 affine matrix (copy). Requires numpy."""
        return _matrix(self._d["matrix"])

    def is_left_handed(self):
        return bool(self._d["left_handed"])

    def is_assemble_initialized(self):
        return bool(self._d["assemble"]["initialized"])

    def assemble_offset(self):
        return _vec3(self._d["assemble"]["offset"])

    def assemble_rotation(self):
        return _vec3(self._d["assemble"]["rotation"])

    def assemble_matrix(self):
        """Assemble-view 4x4 float64 affine matrix (copy). Requires numpy."""
        return _matrix(self._d["assemble"]["matrix"])

    def offset_to_assembly(self):
        return _vec3(self._d["offset_to_assembly"])

    def bounding_box(self):
        return BoundingBox._from(self._d.get("bbox"))


class ModelObject(_Painted):
    def __init__(self, d):
        self._d = d
        self._instances = [ModelInstance(i, self) for i in d["instances"]]
        self._volumes = [ModelVolume(v) for v in d["volumes"]]

    def id(self):
        return self._d["id"]

    name = property(lambda s: s._d["name"])
    module_name = property(lambda s: s._d.get("module_name", ""))
    input_file = property(lambda s: s._d.get("input_file", ""))
    printable = property(lambda s: bool(s._d["printable"]))

    def instance_count(self):
        return len(self._instances)

    def volume_count(self):
        return len(self._volumes)

    def instances(self):
        return list(self._instances)

    def instance(self, index):
        if not 0 <= index < len(self._instances):
            raise IndexError("instance index out of range")
        return self._instances[index]

    def volumes(self):
        return list(self._volumes)

    def volume(self, index):
        if not 0 <= index < len(self._volumes):
            raise IndexError("volume index out of range")
        return self._volumes[index]

    def bounding_box(self):
        return BoundingBox._from(self._d.get("bbox"))

    def raw_mesh_bounding_box(self):
        return BoundingBox._from(self._d.get("raw_bbox"))

    def min_z(self):
        return float(self._d["min_z"])

    def max_z(self):
        return float(self._d["max_z"])

    def facets_count(self):
        return self._d["facets"]

    def parts_count(self):
        return self._d["parts"]

    def materials_count(self):
        return self._d["materials"]

    def mesh_errors_count(self):
        return 0

    def is_multiparts(self):
        return self._d["parts"] > 1

    def is_cut(self):
        return bool(self._d.get("cut"))

    def has_custom_layering(self):
        return bool(self._d.get("custom_layering"))

    def config_keys(self):
        return list(self._d.get("config", {}).keys())

    def config_value(self, key):
        return self._d.get("config", {}).get(key)


class Model(_Painted):
    def __init__(self, d):
        self._d = d
        self._objects = [ModelObject(o) for o in d["objects"]]

    def id(self):
        return self._d["id"]

    def object_count(self):
        return len(self._objects)

    def object(self, index):
        if not 0 <= index < len(self._objects):
            raise IndexError("model object index out of range")
        return self._objects[index]

    def objects(self):
        return list(self._objects)

    def bounding_box(self):
        return BoundingBox._from(self._d.get("bbox"))

    def bounding_box_approx(self):
        return BoundingBox._from(self._d.get("bbox_approx"))

    def max_z(self):
        return float(self._d["max_z"])

    def material_count(self):
        return self._d["material_count"]

    def current_plate_index(self):
        return self._d["plate_index"]

    def designer(self):
        return ""

    def design_id(self):
        return ""


class Plater:
    def __init__(self, d):
        self._d = d

    def model(self):
        return model()

    def is_project_dirty(self):
        return bool(self._d["project_dirty"])

    def is_presets_dirty(self):
        return bool(self._d["presets_dirty"])

    def inside_snapshot_capture(self):
        return False

    def project_path(self):
        return self._d.get("project_path", "")

    def export_3mf_copy(self, path):
        """Write the current project, unsaved changes included, to path as a 3MF copy."""
        path = str(path)
        if not path.lower().endswith(".3mf"):
            raise ValueError("export_3mf_copy() needs a path ending in .3mf")
        # Raise the audit event open(path, "w") raises, as Orca does before writing from C++:
        # same deny list, grants and prompt as writing the file itself.
        import sys
        sys.audit("open", path, "w", 0)
        _, blobs = _bridge.call("plater.export3mf")
        import os
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "wb") as f:
            f.write(blobs[0])


# ---- presets --------------------------------------------------------------------------

class Preset:
    def __init__(self, d, collection):
        self._d = d
        self._coll = collection
        self._config = None

    type = property(lambda s: PresetType[s._d["type"]])
    name = property(lambda s: s._d["name"])
    alias = property(lambda s: s._d.get("alias", ""))
    file = property(lambda s: s._d.get("file", ""))
    is_default = property(lambda s: bool(s._d.get("is_default")))
    is_external = property(lambda s: bool(s._d.get("is_external")))
    is_system = property(lambda s: bool(s._d.get("is_system")))
    is_visible = property(lambda s: bool(s._d.get("is_visible", True)))
    is_dirty = property(lambda s: bool(s._d.get("is_dirty")))
    is_compatible = property(lambda s: bool(s._d.get("is_compatible", True)))
    is_project_embedded = property(lambda s: False)
    bundle_id = property(lambda s: s._d.get("bundle_id", ""))

    def is_user(self):
        return not self.is_default and not self.is_system

    def is_from_bundle(self):
        return bool(self.bundle_id)

    def label(self, no_alias=False):
        name = self.name if no_alias or not self.alias else self.alias
        return ("*" if self.is_dirty else "") + name

    def _cfg(self):
        if self._config is None:
            self._config, _ = _bridge.call("presets.preset", collection=self._coll, name=self._d["name"],
                                           edited=bool(self._d.get("edited")))
        return self._config

    def config_keys(self):
        return list(self._cfg().keys())

    def config_value(self, key):
        return self._cfg().get(key)


class PresetCollection:
    def __init__(self, key, d):
        self._key = key
        self._d = d
        self._presets = [Preset(p, key) for p in d["presets"]]

    def size(self):
        return len(self._presets)

    def _find(self, name):
        for p in self._presets:
            if p.name == name:
                return p
        return None

    def get_selected_preset(self):
        return self._find(self._d["selected"]) or (self._presets[0] if self._presets else None)

    selected_preset = get_selected_preset

    def get_selected_preset_name(self):
        return self._d["selected"]

    selected_preset_name = get_selected_preset_name

    def get_edited_preset(self):
        sel = self.get_selected_preset()
        if sel is None:
            return None
        e = dict(sel._d)
        e["edited"] = True
        e["is_dirty"] = bool(self._d.get("dirty"))
        return Preset(e, self._key)

    edited_preset = get_edited_preset

    def preset(self, index):
        if not 0 <= index < len(self._presets):
            raise IndexError("preset index out of range")
        return self._presets[index]

    def find_preset(self, name):
        # PresetCollection::find_preset (real=false): the selected preset comes back as its edited copy.
        if name == self._d["selected"] and self._find(name) is not None:
            return self.get_edited_preset()
        return self._find(name)

    def preset_names(self):
        return [p.name for p in self._presets]


class PresetBundle:
    def __init__(self, d):
        self._d = d
        self._colls = {k: PresetCollection(k, v) for k, v in d["collections"].items()}
        self._full = None

    prints = property(lambda s: s._colls["prints"])
    printers = property(lambda s: s._colls["printers"])
    filaments = property(lambda s: s._colls["filaments"])
    sla_prints = property(lambda s: s._colls["sla_prints"])
    sla_materials = property(lambda s: s._colls["sla_materials"])

    def current_process_preset(self):
        return self.prints.get_edited_preset()

    def current_print_preset(self):
        return self.prints.get_edited_preset()

    def current_printer_preset(self):
        return self.printers.get_edited_preset()

    def current_filament_preset_names(self):
        return list(self._d["filament_names"])

    def current_filament_presets(self):
        return [self.filaments.find_preset(name) for name in self._d["filament_names"]]

    def _full_config(self):
        if self._full is None:
            self._full, _ = _bridge.call("presets.fullKeys")
        return self._full

    def full_config_keys(self):
        return list(self._full_config().keys())

    def full_config_value(self, key):
        return self._full_config().get(key)


# ---- module functions -------------------------------------------------------------------

_VOLUME_TYPES = {int(t): t.name for t in ModelVolumeType}


class _EngineVolume(ModelVolume):
    """A volume of the Print's model snapshot (inside a pipeline hook); mesh() reads the engine."""

    def mesh(self):
        from . import _graph
        r, out = _graph.engine_mesh(self._d["object_index"], self._d["volume_index"])
        pos = out[r["vertexOffset"]:r["vertexOffset"] + 12 * r["vertexCount"]]
        idx = out[r["indexOffset"]:r["indexOffset"] + 12 * r["triangleCount"]]
        return TriangleMesh(_mesh_stats(pos, idx, r["vertexCount"], r["triangleCount"]), pos, idx)


def _mesh_stats(pos, idx, nv, nt):
    """volume / bbox / manifold of a raw mesh (local mm), as TriangleMesh.stats()."""
    import array as _array
    v = _array.array("f"); v.frombytes(pos)
    t = _array.array("i"); t.frombytes(idx)
    if nv:
        xs, ys, zs = v[0::3], v[1::3], v[2::3]
        bbox = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}
    else:
        bbox = None
    vol = 0.0
    edges = {}
    for i in range(0, len(t), 3):
        a, b, c = t[i] * 3, t[i + 1] * 3, t[i + 2] * 3
        vol += (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c])
                + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6.0
        for u, w in ((t[i], t[i + 1]), (t[i + 1], t[i + 2]), (t[i + 2], t[i])):
            k = (u, w) if u < w else (w, u)
            edges[k] = edges.get(k, 0) + 1
    return {"vertex_count": nv, "triangle_count": nt, "volume": abs(vol), "bbox": bbox,
            "manifold": bool(edges) and all(n == 2 for n in edges.values())}


def _decompose(m16):
    """Column-major 4x4 → (offset, rotation XYZ rad, |scale|, mirror, row-major 16)."""
    import math
    rm = [m16[c * 4 + r] for r in range(4) for c in range(4)]
    cols = [[m16[c * 4 + r] for r in range(3)] for c in range(3)]
    sc = [math.sqrt(sum(x * x for x in col)) for col in cols]
    det = (cols[0][0] * (cols[1][1] * cols[2][2] - cols[2][1] * cols[1][2]) - cols[1][0] * (cols[0][1] * cols[2][2] - cols[2][1] * cols[0][2])
           + cols[2][0] * (cols[0][1] * cols[1][2] - cols[1][1] * cols[0][2]))
    mirror = [-1.0 if det < 0 and i == 0 else 1.0 for i in range(3)]
    r = [[cols[c][rr] / (sc[c] * mirror[c] or 1.0) for c in range(3)] for rr in range(3)]
    sy = -r[2][0]
    rot = [math.atan2(r[2][1], r[2][2]), math.asin(max(-1.0, min(1.0, sy))), math.atan2(r[1][0], r[0][0])]
    return [m16[12], m16[13], m16[14]], rot, sc, mirror, rm


def _engine_model(objects):
    """orca.host.Model over the Print's snapshot (model.objects); meshes come from the engine."""
    objs = []
    for oi, o in enumerate(objects):
        vols = []
        for vi, vd in enumerate(o.get("volumes", [])):
            off, rot, sc, mi, rm = _decompose(vd["matrix"])
            vols.append({"id": vd["id"], "name": vd.get("name", ""), "type": _VOLUME_TYPES.get(int(vd.get("type", 0)), "ModelPart"),
                         "extruder": -1, "offset": off, "rotation": rot, "scale": sc, "mirror": mi, "matrix": rm,
                         "facets": vd.get("triangleCount", 0), "volume": 0.0, "manifold": False, "bbox": None,
                         "painted": {}, "config": {}, "object_index": oi, "volume_index": vi})
        insts = []
        for ii, m in enumerate(o.get("instances", [])):
            off, rot, sc, mi, rm = _decompose(m)
            insts.append({"id": ii, "printable": True, "is_printable": True, "offset": off, "rotation": rot, "scale": sc,
                          "mirror": mi, "matrix": rm, "left_handed": mi[0] < 0, "bbox": None,
                          "assemble": {"initialized": False, "offset": off, "rotation": rot, "matrix": rm},
                          "offset_to_assembly": [0, 0, 0]})
        objs.append({"id": o["id"], "name": o.get("name", ""), "module_name": "", "input_file": "", "printable": True,
                     "min_z": 0.0, "max_z": 0.0, "bbox": None, "raw_bbox": None, "facets": sum(v["facets"] for v in vols),
                     "parts": sum(1 for v in vols if v["type"] == "ModelPart"), "materials": 0, "painted": {}, "config": {},
                     "instances": insts, "volumes": vols})
    m = Model({"id": 0, "plate_index": 0, "material_count": 0, "painted": {}, "bbox": None, "bbox_approx": None,
               "max_z": 0.0, "objects": objs})
    for o in m._objects:
        o._volumes = [_EngineVolume(v._d) for v in o._volumes]
    return m


def plater():
    d, _ = _bridge.call("plater.state")
    return Plater(d)


def model():
    d, _ = _bridge.call("model.snapshot")
    return Model(d)


def preset_bundle():
    d, _ = _bridge.call("presets.bundle")
    return PresetBundle(d)


def app_info():
    """The running app: version, build, mode, language, app_config_version, stealth_mode, is_signed_in,
    is_bambu_signed_in, network_plugin_version and network_plugin_error."""
    d, _ = _bridge.call("app.info")
    return d


def gl_info():
    """OpenGL vendor, renderer, version, glsl_version and core_profile of the 3D view; None before it has been created."""
    d, _ = _bridge.call("app.glInfo")
    return d


def selected_printer():
    """The printer selected in the device list; CubbySlicer has none (print hosts are not in it), so None."""
    return None


from . import plugin, preset, ui  # noqa: E402,F401
