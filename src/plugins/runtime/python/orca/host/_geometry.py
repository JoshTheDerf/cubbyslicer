"""orca.host geometry value types: BoundingBox, Point, Polygon, ExPolygon.

Coordinates of Point / Polygon / ExPolygon are scaled int64 (coord_t), as in
Orca. Outside a slicing hook the polygon operations run in pure Python, with
pyclipper (Clipper 1, miter joins, miter limit 3 like Orca's ClipperUtils) for
offsets and booleans; results can differ slightly from Orca's modified Clipper.
"""
import math


def _np():
    try:
        import numpy
        return numpy
    except ImportError:
        raise ImportError('numpy is required to access geometry/mesh arrays; add dependencies = ["numpy"] to your plugin metadata')


def _cround(v):
    """C round(): half away from zero (libslic3r rounds rotated points with it)."""
    return int(math.floor(v + 0.5)) if v >= 0 else -int(math.floor(-v + 0.5))


def _hooked():
    """Inside a pipeline hook geometry ops run in the engine (libslic3r's Clipper, bit-identical to desktop)."""
    from . import _graph
    return _graph.in_hook()


def _clipper():
    try:
        import pyclipper
        return pyclipper
    except ImportError:
        raise RuntimeError("Polygon offsets and booleans need pyclipper, which is not loaded in this CubbySlicer build")


class BoundingBox:
    """Axis-aligned bounding box in millimetres"""
    __slots__ = ("_defined", "_min", "_max")

    def __init__(self, mn=None, mx=None):
        self._defined = mn is not None and mx is not None
        self._min = tuple(float(c) for c in mn) if self._defined else (0.0, 0.0, 0.0)
        self._max = tuple(float(c) for c in mx) if self._defined else (0.0, 0.0, 0.0)

    @classmethod
    def _from(cls, d):
        return cls(d["min"], d["max"]) if d else cls()

    defined = property(lambda s: s._defined)
    min = property(lambda s: s._min)
    max = property(lambda s: s._max)
    size = property(lambda s: tuple(b - a for a, b in zip(s._min, s._max)))
    center = property(lambda s: tuple((a + b) / 2 for a, b in zip(s._min, s._max)))
    radius = property(lambda s: 0.5 * math.sqrt(sum(c * c for c in s.size)))

    def __repr__(self):
        return f"orca.host.BoundingBox(min={self._min}, max={self._max})" if self._defined else "orca.host.BoundingBox()"


def _coord(v):
    if isinstance(v, bool) or not isinstance(v, (int,)) and not (hasattr(v, "__index__")):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        raise TypeError("incompatible coordinate: scaled coordinates are integers")
    return int(v)


class Point:
    def __init__(self, x, y):
        self._x = _coord(x)
        self._y = _coord(y)

    x = property(lambda s: s._x, lambda s, v: setattr(s, "_x", _coord(v)))
    y = property(lambda s: s._y, lambda s, v: setattr(s, "_y", _coord(v)))

    def __add__(self, o):
        return Point(self._x + o._x, self._y + o._y)

    def __sub__(self, o):
        return Point(self._x - o._x, self._y - o._y)

    def __mul__(self, s):
        return Point(int(self._x * s), int(self._y * s))

    def __eq__(self, o):
        return isinstance(o, Point) and self._x == o._x and self._y == o._y

    def __repr__(self):
        return f"orca.host.Point({self._x}, {self._y})"


def _area2(pts):
    a = 0
    n = len(pts)
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        a += p._x * q._y - q._x * p._y
    return a


def _contains(pts, pt):
    inside = False
    n = len(pts)
    x, y = pt._x, pt._y
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        if (a._y > y) != (b._y > y):
            xi = a._x + (y - a._y) * (b._x - a._x) / (b._y - a._y)
            if x < xi:
                inside = not inside
    return inside


def _dp(pts, tol, closed=True):
    if len(pts) < 3:
        return list(pts)
    seq = list(pts) + ([pts[0]] if closed else [])

    def rec(a, b):
        ax, ay, bx, by = seq[a]._x, seq[a]._y, seq[b]._x, seq[b]._y
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = seq[i]._x, seq[i]._y
            d = math.hypot(px - ax, py - ay) if L == 0 else abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best:
                best, idx = d, i
        if best > tol and idx >= 0:
            return rec(a, idx)[:-1] + rec(idx, b)
        return [seq[a], seq[b]]

    out = rec(0, len(seq) - 1)
    if closed:
        out = out[:-1]
    return [Point(p._x, p._y) for p in out]


class Polygon:
    _view = None   # the array as_array() handed out, if any

    def __init__(self):
        self._pts = []

    @classmethod
    def _of(cls, coords):
        p = cls()
        p._pts = [Point(int(x), int(y)) for x, y in coords]
        return p

    def _coords(self):
        self._sync()
        return [(p._x, p._y) for p in self._pts]

    def size(self):
        return len(self._pts)

    def is_valid(self):
        return len(self._pts) >= 3

    def is_counter_clockwise(self):
        return _area2(self._pts) > 0

    def is_clockwise(self):
        return not self.is_counter_clockwise()

    def make_counter_clockwise(self):
        """Reorient to CCW in place. Returns True if it reversed the winding."""
        if not self.is_counter_clockwise():
            self._pts.reverse()
            return True
        return False

    def make_clockwise(self):
        if self.is_counter_clockwise():
            self._pts.reverse()
            return True
        return False

    def area(self):
        return _area2(self._pts) / 2.0

    def centroid(self):
        a = _area2(self._pts)
        if a == 0:
            return Point(0, 0)
        cx = cy = 0
        n = len(self._pts)
        for i in range(n):
            p, q = self._pts[i], self._pts[(i + 1) % n]
            c = p._x * q._y - q._x * p._y
            cx += (p._x + q._x) * c
            cy += (p._y + q._y) * c
        return Point(int(cx / (3 * a)), int(cy / (3 * a)))

    def contains(self, point):
        return _contains(self._pts, point)

    def translate(self, x, y):
        # MultiPoint::translate(double, double): coord_t() truncation.
        self._sync()
        dx, dy = int(x), int(y)
        for p in self._pts:
            p._x += dx
            p._y += dy

    def rotate(self, angle, center=None):
        # MultiPoint::rotate (libslic3r): C round(), about the origin or `center`.
        self._sync()
        c, s = math.cos(angle), math.sin(angle)
        ox, oy = (center._x, center._y) if center is not None else (0, 0)
        for p in self._pts:
            dx, dy = p._x - ox, p._y - oy
            p._x = _cround(float(ox) + c * dx - s * dy)
            p._y = _cround(float(oy) + c * dy + s * dx)

    def _sync(self):
        """Pick up edits made through as_array() (count-preserving, as Orca allows)."""
        v = getattr(self, "_view", None)
        if v is not None and v.shape[0] == len(self._pts):
            for p, (x, y) in zip(self._pts, v.tolist()):
                p._x, p._y = int(x), int(y)

    def douglas_peucker(self, tolerance):
        self._sync()
        if _hooked():
            from . import _graph
            ex = ExPolygon.__new__(ExPolygon)
            ex._contour, ex._holes = self, []
            r = _graph.engine_geom("geom.douglas_peucker", [ex], tolerance=float(tolerance))
            self._pts = r[0]._contour._pts if r else []
            return
        self._pts = _dp(self._pts, tolerance)

    def simplify(self, tolerance):
        """Return simplified geometry as a list of Polygon (may split into several)."""
        self._sync()
        if _hooked():
            from . import _graph
            ex = ExPolygon.__new__(ExPolygon)
            ex._contour, ex._holes = self, []
            return [e._contour for e in _graph.engine_geom("geom.simplify", [ex], tolerance=float(tolerance))]
        p = Polygon()
        p._pts = _dp(self._pts, tolerance)
        return [p] if p.is_valid() else []

    def offset(self, delta):
        """Clipper offset by `delta` scaled units (negative shrinks). Returns [Polygon]."""
        self._sync()
        if _hooked():
            from . import _graph
            ex = ExPolygon.__new__(ExPolygon)
            ex._contour, ex._holes = self, []
            return _graph.engine_geom("geom.offset", [ex], delta=float(int(delta)))
        pc = _clipper()
        o = pc.PyclipperOffset(3.0)
        o.AddPath(self._coords(), pc.JT_MITER, pc.ET_CLOSEDPOLYGON)
        return [Polygon._of(r) for r in o.Execute(float(delta))]

    @property
    def points(self):
        """Vertices as live Point refs (editing one edits this polygon)."""
        self._sync()
        self._view = None
        return list(self._pts)

    def append(self, point):
        self._pts.append(point)

    def as_array(self):
        """Vertices as a writable int64 (N,2) numpy array (scaled coords). Count-preserving edits to it
        are written back into this polygon (CubbySlicer keeps a copy, not a view into engine memory).
        Requires numpy."""
        np = _np()
        self._sync()
        self._view = np.array([(p._x, p._y) for p in self._pts], dtype=np.int64).reshape(-1, 2)
        return self._view

    def set_points(self, points):
        self._pts = _parse_polygon(points, "Polygon.set_points")._pts

    def __repr__(self):
        return f"<orca.host.Polygon {len(self._pts)} points>"


def _parse_polygon(h, who):
    if isinstance(h, Polygon):
        p = Polygon()
        h._sync()
        p._pts = [Point(q._x, q._y) for q in h._pts]
        return p
    np = _np()
    if not isinstance(h, np.ndarray):
        raise ValueError(f"{who}: each contour/hole must be an (N,2) int64 ndarray")
    if h.dtype.kind != "i" or h.itemsize != 8:
        raise ValueError(f"{who}: polygon coordinates must be int64 (scaled coords)")
    if h.ndim != 2 or h.shape[1] != 2:
        raise ValueError(f"{who}: each polygon array must have shape (N,2)")
    if h.shape[0] < 3:
        raise ValueError(f"{who}: a polygon needs at least 3 points")
    return Polygon._of(h.tolist())


def _as_ex_list(paths_tree):
    """pyclipper PolyTree → [ExPolygon]."""
    out = []

    def walk(node):
        for child in node.Childs:
            if not child.IsHole:
                ex = ExPolygon.__new__(ExPolygon)
                ex._contour = Polygon._of(child.Contour)
                ex._contour.make_counter_clockwise()
                ex._holes = []
                for h in child.Childs:
                    hp = Polygon._of(h.Contour)
                    hp.make_clockwise()
                    ex._holes.append(hp)
                    walk(h)
                out.append(ex)
    walk(paths_tree)
    return out


class ExPolygon:
    def __init__(self, contour, holes=None):
        self._contour = _parse_polygon(contour, "ExPolygon.contour")
        self._holes = []
        if holes is not None:
            if isinstance(holes, (str, bytes)) or not hasattr(holes, "__iter__"):
                raise ValueError("ExPolygon: holes must be a list of Polygon or (N,2) ndarrays")
            for h in holes:
                hp = _parse_polygon(h, "ExPolygon.hole")
                hp.make_clockwise()
                self._holes.append(hp)
        self._contour.make_counter_clockwise()

    def _paths(self):
        return [self._contour._coords()] + [h._coords() for h in self._holes]

    @property
    def contour(self):
        return self._contour

    @contour.setter
    def contour(self, v):
        self._contour = _parse_polygon(v, "ExPolygon.contour")

    @property
    def holes(self):
        return list(self._holes)

    def set_holes(self, holes):
        if isinstance(holes, (str, bytes)) or not hasattr(holes, "__iter__"):
            raise ValueError("set_holes: expected a list of Polygon or (N,2) ndarrays")
        new = []
        for h in holes:
            hp = _parse_polygon(h, "ExPolygon.set_holes")
            hp.make_clockwise()
            new.append(hp)
        self._holes = new

    def translate(self, x, y):
        self._contour.translate(x, y)
        for h in self._holes:
            h.translate(x, y)

    def rotate(self, angle, center=None):
        self._contour.rotate(angle, center)
        for h in self._holes:
            h.rotate(angle, center)

    def scale(self, factor):
        # Point::operator*=(double): coord_t() truncation.
        for poly in [self._contour] + self._holes:
            poly._sync()
            for p in poly._pts:
                p._x = int(p._x * factor)
                p._y = int(p._y * factor)

    def douglas_peucker(self, tolerance):
        if _hooked():
            from . import _graph
            r = _graph.engine_geom("geom.douglas_peucker", [self], tolerance=float(tolerance))
            if r:
                self._contour, self._holes = r[0]._contour, r[0]._holes
            return
        self._contour.douglas_peucker(tolerance)
        for h in self._holes:
            h.douglas_peucker(tolerance)

    def area(self):
        return self._contour.area() + sum(h.area() for h in self._holes)

    def is_valid(self):
        return self._contour.is_valid() and self._contour.is_counter_clockwise() and all(h.is_valid() and h.is_clockwise() for h in self._holes)

    def contains(self, point):
        return self._contour.contains(point) and not any(h.contains(point) for h in self._holes)

    def num_contours(self):
        return 1 + len(self._holes)

    def simplify(self, tolerance):
        if _hooked():
            from . import _graph
            return _graph.engine_geom("geom.simplify", [self], tolerance=float(tolerance))
        c = ExPolygon.__new__(ExPolygon)
        c._contour = Polygon()
        c._contour._pts = _dp(self._contour._pts, tolerance)
        c._holes = []
        for h in self._holes:
            hp = Polygon()
            hp._pts = _dp(h._pts, tolerance)
            if hp.is_valid():
                c._holes.append(hp)
        return [c] if c._contour.is_valid() else []

    def offset(self, delta):
        """Clipper offset by `delta` scaled units (negative shrinks). Returns [ExPolygon]."""
        if _hooked():
            from . import _graph
            return _graph.engine_geom("geom.offset_ex", [self], delta=float(int(delta)))
        pc = _clipper()
        o = pc.PyclipperOffset(3.0)
        o.AddPaths(self._paths(), pc.JT_MITER, pc.ET_CLOSEDPOLYGON)
        return _as_ex_list(o.Execute2(float(delta)))

    def _bool(self, other, op):
        if _hooked():
            from . import _graph
            return _graph.engine_geom({"union": "geom.union_ex", "diff": "geom.diff_ex", "inter": "geom.intersection_ex"}[op], [self], [other])
        pc = _clipper()
        c = pc.Pyclipper()
        c.AddPaths(self._paths(), pc.PT_SUBJECT, True)
        c.AddPaths(other._paths(), pc.PT_CLIP if op != "union" else pc.PT_SUBJECT, True)
        kind = {"union": pc.CT_UNION, "diff": pc.CT_DIFFERENCE, "inter": pc.CT_INTERSECTION}[op]
        return _as_ex_list(c.Execute2(kind, pc.PFT_NONZERO, pc.PFT_NONZERO))

    def union_ex(self, other):
        return self._bool(other, "union")

    def diff_ex(self, other):
        return self._bool(other, "diff")

    def intersection_ex(self, other):
        return self._bool(other, "inter")

    def __repr__(self):
        return f"<orca.host.ExPolygon {self._contour.size()} points, {len(self._holes)} holes>"
