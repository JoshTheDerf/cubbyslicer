"""The live slicing graph inside a pipeline hook (ctx.print / ctx.object).

OrcaSlicer binds the C++ objects directly (PluginHostSlicing.cpp): every
object is a reference into the Print, and in-place edits change it. Here each
object is a proxy that reads through `cs_hook_query` (the engine is parked
inside the hook) and keeps a local copy:

- reads are fetched once per hook and cached (per container);
- in-place edits (Surface fields, surface.expolygon / its contour, holes and
  points, ExPolygon.translate / rotate / scale, Layer.lslices() items) are found
  by comparing each fetched item with what was read, and written back with
  `surface.patch` / `layer.set_lslices` before anything that could observe them
  (make_slices(), a mutator of the same collection) and when execute() returns;
- container mutators (set / append / clear / set_type) go to the engine at once
  and drop the cached items, so earlier references stop being part of the
  graph, like Orca's std::vector invalidation rule.

Everything here is valid only during execute(ctx), as in Orca.
"""
import json
from array import array

from .. import _bridge
from .._core import _OrcaEnum
from ._geometry import ExPolygon, Polygon, Point, BoundingBox, _np

_NOT_IN_HOOK = ("The slicing graph is only available inside a slicing pipeline hook "
                "(ctx.print / ctx.object during execute(ctx))")


class SurfaceType(_OrcaEnum):
    stTop = 0
    stBottom = 1
    stBottomBridge = 2
    stInternalAfterExternalBridge = 3
    stInternal = 4
    stInternalSolid = 5
    stInternalBridge = 6
    stSecondInternalBridge = 7
    stInternalVoid = 8
    stPerimeter = 9
    stCount = 10


# ---- per-hook state --------------------------------------------------------------------

class _Hook:
    def __init__(self, begin):
        self.begin = begin
        self.collections = []   # SurfaceCollection proxies read in this hook (for write-back)
        self.layers = []        # Layer proxies whose lslices() was read
        self.objects = {}
        self.print = Print(self)
        self.alive = True


_HOOK = None


def begin_hook(begin):
    global _HOOK
    _HOOK = _Hook(begin)
    return _HOOK


def end_hook():
    global _HOOK
    if _HOOK is not None:
        _HOOK.alive = False
    _HOOK = None


def _hook(h=None):
    h = h or _HOOK
    if h is None or not h.alive or _HOOK is not h:
        raise RuntimeError(_NOT_IN_HOOK)
    return h


def flush_all():
    h = _HOOK
    if h is None:
        return
    ops, blob = [], bytearray()
    for c in h.collections:
        c._collect_patches(ops, blob)
    for layer in h.layers:
        layer._collect_lslices(ops, blob)
    if ops:
        _query(ops, bytes(blob))


def _query(ops, blob=b""):
    reply, out = _bridge.hook_query(json.dumps({"batch": ops}), blob)
    if not reply.get("ok"):
        raise RuntimeError(f"Slicing graph query failed: {reply.get('error')}")
    return reply["results"], out


def _q1(op, blob=b""):
    results, out = _query([op], blob)
    return results[0], out


# ---- (de)serialization ------------------------------------------------------------------

def _ints(out, offset, count):
    a = array("q")
    a.frombytes(out[offset:offset + 8 * count])
    return a


def _decode_expolygon(j, out, offset):
    """(ExPolygon, next offset)."""
    n = j["contourLen"]
    pts = _ints(out, offset, 2 * n)
    offset += 16 * n
    ex = ExPolygon.__new__(ExPolygon)
    ex._contour = Polygon._of(zip(pts[0::2], pts[1::2]))
    ex._holes = []
    for hl in j.get("holeLens", []):
        hp = _ints(out, offset, 2 * hl)
        offset += 16 * hl
        ex._holes.append(Polygon._of(zip(hp[0::2], hp[1::2])))
    return ex, offset


def _decode_expolygons(items, out, offset):
    res = []
    for j in items:
        ex, offset = _decode_expolygon(j, out, offset)
        res.append(ex)
    return res


def _encode_expolygon(ex, blob):
    """Append the points, return the JSON shape."""
    flat = array("q")
    ex._contour._sync()
    for h in ex._holes:
        h._sync()
    for p in ex._contour._pts:
        flat.append(p._x)
        flat.append(p._y)
    holes = []
    for h in ex._holes:
        for p in h._pts:
            flat.append(p._x)
            flat.append(p._y)
        holes.append(len(h._pts))
    blob.extend(flat.tobytes())
    return {"contourLen": len(ex._contour._pts), "holeLens": holes}


def _encode_expolygons(exs, blob):
    return [_encode_expolygon(_as_expolygon(e), blob) for e in exs]


def _as_expolygon(e):
    if isinstance(e, ExPolygon):
        return e
    raise ValueError("expected orca.host.ExPolygon")


def _geom_sig(ex):
    if ex is None:
        return None
    ex._contour._sync()
    for h in ex._holes:
        h._sync()
    return (tuple((p._x, p._y) for p in ex._contour._pts),
            tuple(tuple((p._x, p._y) for p in h._pts) for h in ex._holes))


def engine_geom(op, a, b=None, **params):
    """libslic3r's own Clipper op through the engine (bit-identical to desktop)."""
    blob = bytearray()
    req = {"op": op, "blobOffset": 0, "a": _encode_expolygons(a, blob), **params}
    if b is not None:
        req["b"] = _encode_expolygons(b, blob)
    r, out = _q1(req, bytes(blob))
    if "polygonLens" in r:
        off, polys = r["blobOffset"], []
        for n in r["polygonLens"]:
            pts = _ints(out, off, 2 * n)
            off += 16 * n
            polys.append(Polygon._of(zip(pts[0::2], pts[1::2])))
        return polys
    return _decode_expolygons(r["expolygons"], out, r["blobOffset"])


def in_hook():
    return _HOOK is not None and _bridge.IN_PIPELINE_HOOK.get()


# ---- Surface / SurfaceCollection ------------------------------------------------------------

class Surface:
    surface_type = SurfaceType.stInternal
    expolygon = None
    thickness = -1.0
    thickness_layers = 1
    bridge_angle = -1.0
    extra_perimeters = 0

    def __init__(self, surface_type, expolygon=None):
        self.surface_type = SurfaceType(int(surface_type))
        self.expolygon = expolygon if expolygon is not None else ExPolygon.__new__(ExPolygon)
        if expolygon is None:
            self.expolygon._contour = Polygon()
            self.expolygon._holes = []
        self.thickness = -1.0
        self.thickness_layers = 1
        self.bridge_angle = -1.0
        self.extra_perimeters = 0

    def __setattr__(self, name, value):
        if name == "surface_type":
            value = SurfaceType(int(value))
        elif name == "expolygon" and value is not None and not isinstance(value, ExPolygon):
            raise TypeError("expolygon must be an orca.host.ExPolygon")
        object.__setattr__(self, name, value)

    def _sig(self):
        return (int(self.surface_type), float(self.thickness), int(self.thickness_layers), float(self.bridge_angle),
                int(self.extra_perimeters), _geom_sig(self.expolygon))

    def _json(self, blob):
        j = _encode_expolygon(self.expolygon, blob)
        j.update(type=int(self.surface_type), thickness=float(self.thickness), thickness_layers=int(self.thickness_layers),
                 bridge_angle=float(self.bridge_angle), extra_perimeters=int(self.extra_perimeters))
        return j

    def area(self):
        return self.expolygon.area() if self.expolygon is not None else 0.0

    def is_top(self):
        return self.surface_type == SurfaceType.stTop

    def is_bottom(self):
        return self.surface_type in (SurfaceType.stBottom, SurfaceType.stBottomBridge)

    def is_bridge(self):
        return self.surface_type in (SurfaceType.stBottomBridge, SurfaceType.stInternalBridge, SurfaceType.stSecondInternalBridge)

    def is_internal(self):
        return self.surface_type in (SurfaceType.stInternal, SurfaceType.stInternalBridge, SurfaceType.stInternalSolid,
                                     SurfaceType.stInternalVoid, SurfaceType.stSecondInternalBridge,
                                     SurfaceType.stInternalAfterExternalBridge)

    def is_external(self):
        return self.is_top() or self.is_bottom()

    def is_solid(self):
        return self.surface_type in (SurfaceType.stTop, SurfaceType.stBottom, SurfaceType.stBottomBridge,
                                     SurfaceType.stInternalSolid, SurfaceType.stInternalBridge,
                                     SurfaceType.stSecondInternalBridge, SurfaceType.stInternalAfterExternalBridge)

    def __repr__(self):
        return f"<orca.host.Surface {self.surface_type}>"


def _surface_from(j, ex):
    s = Surface.__new__(Surface)
    object.__setattr__(s, "surface_type", SurfaceType(int(j.get("type", 4))))
    object.__setattr__(s, "expolygon", ex)
    object.__setattr__(s, "thickness", float(j.get("thickness", -1.0)))
    object.__setattr__(s, "thickness_layers", int(j.get("thickness_layers", 1)))
    object.__setattr__(s, "bridge_angle", float(j.get("bridge_angle", -1.0)))
    object.__setattr__(s, "extra_perimeters", int(j.get("extra_perimeters", 0)))
    return s


class SurfaceCollection:
    def __init__(self, region, which):
        self._region = region
        self._which = which
        self._items = None
        self._orig = None

    def _addr(self):
        r = self._region
        return {"objectId": r._layer._obj._id, "layer": r._layer._index, "region": r._index, "which": self._which}

    def _load(self):
        h = _hook(self._region._layer._obj._hook)
        if self._items is None:
            r, out = _q1({"op": "layer.surfaces", **self._addr()})
            off = r["blobOffset"]
            items = []
            for j in r["surfaces"]:
                ex, off = _decode_expolygon(j, out, off)
                items.append(_surface_from(j, ex))
            self._items = items
            self._orig = [s._sig() for s in items]
            if self not in h.collections:
                h.collections.append(self)
        return self._items

    def _collect_patches(self, ops, blob):
        if self._items is None:
            return
        for i, s in enumerate(self._items):
            sig = s._sig()
            if sig == self._orig[i]:
                continue
            if s.expolygon is None:
                raise ValueError("Surface.expolygon must be an ExPolygon")
            start = len(blob)
            fields = s._json(blob)
            ex = {"contourLen": fields.pop("contourLen"), "holeLens": fields.pop("holeLens")}
            ops.append({"op": "surface.patch", **self._addr(), "index": i, "blobOffset": start, "expolygon": ex, **fields})
            self._orig[i] = sig

    def _flush(self):
        ops, blob = [], bytearray()
        self._collect_patches(ops, blob)
        if ops:
            _query(ops, bytes(blob))

    def _drop(self):
        self._items = None
        self._orig = None

    @property
    def surfaces(self):
        """Live list of Surface refs; edit them in place."""
        return list(self._load())

    def size(self):
        return len(self._load())

    def empty(self):
        return not self._load()

    def has(self, surface_type):
        t = int(surface_type)
        return any(int(s.surface_type) == t for s in self._load())

    def filter_by_type(self, surface_type):
        t = int(surface_type)
        return [s for s in self._load() if int(s.surface_type) == t]

    def _write(self, op, arg, surface_type=None):
        _hook(self._region._layer._obj._hook)
        blob = bytearray()
        req = {"op": op, **self._addr(), "blobOffset": 0}
        if surface_type is None:
            items = list(arg)
            if items and isinstance(items[0], Surface) or not items:
                req["surfaces"] = [s._json(blob) for s in items]
            else:
                raise TypeError(f"{op.split('.')[1]}(): pass a list of Surface, or (expolygons, surface_type)")
        else:
            req["type"] = int(SurfaceType(int(surface_type)))
            req["expolygons"] = _encode_expolygons(list(arg), blob)
        _q1(req, bytes(blob))
        self._drop()

    def set(self, arg, surface_type=None):
        """set(expolygons, surface_type) or set(surfaces): replace the collection."""
        self._drop()   # the replaced surfaces' pending edits are discarded, as in Orca
        self._write("surfaces.set", arg, surface_type)

    def append(self, expolygons, surface_type=None):
        """append(expolygons, surface_type) or append(surfaces)."""
        self._flush()
        self._write("surfaces.append", expolygons, surface_type)

    def clear(self):
        _hook(self._region._layer._obj._hook)
        self._drop()
        _q1({"op": "surfaces.clear", **self._addr()})

    def set_type(self, surface_type):
        self._flush()
        _q1({"op": "surfaces.set_type", **self._addr(), "type": int(SurfaceType(int(surface_type)))})
        self._drop()


# ---- extrusions (read-only) -----------------------------------------------------------------------

class ExtrusionEntity:
    def __init__(self, j):
        self._role = j.get("role", "")

    @property
    def role(self):
        return self._role


class ExtrusionPath(ExtrusionEntity):
    def __init__(self, j, out, offset):
        super().__init__(j)
        self._n = j.get("n", 0)
        self._raw = out[offset:offset + 24 * self._n]
        self._width = j.get("width", 0.0)
        self._height = j.get("height", 0.0)
        self._mm3 = j.get("mm3_per_mm", 0.0)

    width = property(lambda s: s._width)
    height = property(lambda s: s._height)
    mm3_per_mm = property(lambda s: s._mm3)

    def points(self):
        """Read-only (N, 3) int64 ndarray of scaled path points. Requires numpy."""
        np = _np()
        a = np.frombuffer(self._raw, dtype=np.int64).reshape(-1, 3)
        a.flags.writeable = False
        return a


class ExtrusionLoop(ExtrusionEntity):
    def __init__(self, j, paths):
        super().__init__(j)
        self._paths = paths

    @property
    def paths(self):
        return list(self._paths)


class ExtrusionMultiPath(ExtrusionLoop):
    pass


class ExtrusionEntityCollection(ExtrusionEntity):
    def __init__(self, j, entities):
        super().__init__(j)
        self._entities = entities

    def size(self):
        return len(self._entities)

    @property
    def entities(self):
        return list(self._entities)

    def flatten_paths(self):
        out = []

        def walk(e):
            if isinstance(e, ExtrusionPath):
                out.append(e)
            elif isinstance(e, ExtrusionEntityCollection):
                for c in e._entities:
                    walk(c)
            elif isinstance(e, ExtrusionLoop):
                out.extend(e._paths)
        walk(self)
        return out


def _build_extrusion(j, out, cursor):
    kind = j.get("kind")
    if kind == "path":
        p = ExtrusionPath(j, out, cursor[0])
        cursor[0] += 24 * p._n
        return p
    if kind in ("loop", "multipath"):
        paths = [_build_extrusion(c, out, cursor) for c in j.get("children", [])]
        return (ExtrusionLoop if kind == "loop" else ExtrusionMultiPath)(j, paths)
    if kind == "collection":
        return ExtrusionEntityCollection(j, [_build_extrusion(c, out, cursor) for c in j.get("children", [])])
    return ExtrusionEntity(j)


# ---- graph -----------------------------------------------------------------------------------------

class PrintRegion:
    def __init__(self, lr):
        self._lr = lr

    def config_keys(self):
        r, _ = _q1({"op": "region.config_keys", **self._lr._addr()})
        return r["keys"]

    def config_value(self, key):
        r, _ = _q1({"op": "region.config_value", **self._lr._addr(), "key": str(key)})
        return r["value"]


class LayerRegion:
    def __init__(self, layer, index):
        self._layer = layer
        self._index = index
        self._slices = SurfaceCollection(self, "slices")
        self._fill = SurfaceCollection(self, "fill_surfaces")
        self._ext = {}

    def _addr(self):
        return {"objectId": self._layer._obj._id, "layer": self._layer._index, "region": self._index}

    @property
    def slices(self):
        """Sliced, typed surfaces (SurfaceCollection). Edit in place, or replace with set()."""
        return self._slices

    @property
    def fill_surfaces(self):
        return self._fill

    def _extrusions(self, which):
        if which not in self._ext:
            r, out = _q1({"op": "layer.extrusions", **self._addr(), "which": which})
            self._ext[which] = _build_extrusion(r["tree"], out, [r["blobOffset"]])
        return self._ext[which]

    @property
    def perimeters(self):
        return self._extrusions("perimeters")

    @property
    def fills(self):
        return self._extrusions("fills")

    def layer(self):
        return self._layer

    def region(self):
        return PrintRegion(self)

    def config_value(self, key):
        return PrintRegion(self).config_value(key)


class Layer:
    def __init__(self, obj, index, d, support=False):
        self._obj = obj
        self._index = index
        self._support = support
        self._print_z = float(d["print_z"])
        self._slice_z = float(d["slice_z"])
        self._height = float(d["height"])
        self._regions = [LayerRegion(self, i) for i in range(int(d.get("regionCount", 0)))]
        self._lslices = None
        self._lslices_orig = None
        self.__upper = None
        self.__lower = None

    print_z = property(lambda s: s._print_z)
    slice_z = property(lambda s: s._slice_z)
    height = property(lambda s: s._height)
    upper_layer = property(lambda s: s.__upper)
    lower_layer = property(lambda s: s.__lower)

    def _link(self, lower, upper):
        self.__lower = lower
        self.__upper = upper

    def regions(self):
        return list(self._regions)

    def _addr(self):
        a = {"objectId": self._obj._id, "layer": self._index}
        if self._support:
            a["support"] = True
        return a

    def lslices(self):
        """The layer's merged islands as live ExPolygons (edits are written back)."""
        h = _hook(self._obj._hook)
        if self._lslices is None:
            r, out = _q1({"op": "layer.lslices", **self._addr()})
            self._lslices = _decode_expolygons(r["expolygons"], out, r["blobOffset"])
            self._lslices_orig = [_geom_sig(e) for e in self._lslices]
            if self not in h.layers:
                h.layers.append(self)
        return list(self._lslices)

    def _collect_lslices(self, ops, blob):
        if self._lslices is None:
            return
        if [_geom_sig(e) for e in self._lslices] == self._lslices_orig:
            return
        start = len(blob)
        ops.append({"op": "layer.set_lslices", **self._addr(), "blobOffset": start,
                    "expolygons": _encode_expolygons(self._lslices, blob)})
        self._lslices_orig = [_geom_sig(e) for e in self._lslices]

    def make_slices(self):
        """Re-derive lslices (and their bounding boxes) from the region slices."""
        _hook(self._obj._hook)
        ops, blob = [], bytearray()
        for r in self._regions:
            r._slices._collect_patches(ops, blob)
            r._fill._collect_patches(ops, blob)
        ops.append({"op": "layer.make_slices", **self._addr()})
        _query(ops, bytes(blob))
        self._lslices = None
        self._lslices_orig = None


class PrintObject:
    def __init__(self, hook, oid):
        self._hook = hook
        self._id = int(oid)
        self._info = None
        self._layers = None
        self._support = None

    def _i(self):
        _hook(self._hook)
        if self._info is None:
            self._info, _ = _q1({"op": "object.info", "objectId": self._id})
        return self._info

    def id(self):
        return self._id

    def _load_layers(self, support):
        r, _ = _q1({"op": "object.layers", "objectId": self._id, "support": bool(support)})
        layers = [Layer(self, i, d, support) for i, d in enumerate(r["layers"])]
        for i, l in enumerate(layers):
            l._link(layers[i - 1] if i > 0 else None, layers[i + 1] if i + 1 < len(layers) else None)
        return layers

    def layers(self):
        _hook(self._hook)
        if self._layers is None:
            self._layers = self._load_layers(False)
        return list(self._layers)

    def support_layers(self):
        _hook(self._hook)
        if self._support is None:
            self._support = self._load_layers(True)
        return list(self._support)

    def model_object(self):
        mid = self._i().get("modelObject")
        for o in self._hook.print.model().objects():
            if o.id() == mid:
                return o
        return None

    def bounding_box(self):
        """(min_x, min_y, max_x, max_y) in scaled coordinates."""
        return tuple(int(v) for v in self._i()["bbox"])

    def trafo(self):
        """4x4 float64 ndarray. Requires numpy."""
        np = _np()
        return np.array(self._i()["trafo"], dtype=np.float64).reshape(4, 4).T.copy()

    def config_keys(self):
        r, _ = _q1({"op": "object.config_keys", "objectId": self._id})
        return r["keys"]

    def config_value(self, key):
        r, _ = _q1({"op": "object.config_value", "objectId": self._id, "key": str(key)})
        return r["value"]


class Print:
    def __init__(self, hook):
        self._hook = hook
        self._model = None

    def _obj(self, oid):
        h = _hook(self._hook)
        o = h.objects.get(int(oid))
        if o is None:
            o = h.objects[int(oid)] = PrintObject(h, oid)
        return o

    def objects(self):
        r, _ = _q1({"op": "print.info"})
        return [self._obj(i) for i in r["objectIds"]]

    def model(self):
        """The Print's model snapshot (not orca.host.model(), the live project)."""
        _hook(self._hook)
        if self._model is None:
            from . import _engine_model
            r, _ = _q1({"op": "model.objects"})
            self._model = _engine_model(r["objects"])
        return self._model

    def config_keys(self):
        r, _ = _q1({"op": "print.config_keys"})
        return r["keys"]

    def config_value(self, key):
        r, _ = _q1({"op": "print.config_value", "key": str(key)})
        return r["value"]

    def canceled(self):
        if _bridge.hook_cancelled():
            return True
        r, _ = _q1({"op": "print.info"})
        return bool(r["canceled"])


def engine_mesh(object_index, volume_index):
    r, out = _q1({"op": "model.mesh", "object": int(object_index), "volume": int(volume_index)})
    return r, out


__all__ = ["SurfaceType", "Surface", "SurfaceCollection", "ExtrusionEntity", "ExtrusionPath", "ExtrusionLoop",
           "ExtrusionMultiPath", "ExtrusionEntityCollection", "PrintRegion", "LayerRegion", "Layer", "PrintObject",
           "Print", "BoundingBox", "Point"]
