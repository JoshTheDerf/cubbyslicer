"""Slicing pipeline API (research/experimental)."""
import contextvars

from ._core import PythonPluginBase, PluginType, _OrcaEnum, _pure


class Step(_OrcaEnum):
    posSlice = 0
    posPerimeters = 1
    posEstimateCurledExtrusions = 2
    posPrepareInfill = 3
    posInfill = 4
    posIroning = 5
    posContouring = 6
    posSupportMaterial = 7
    posDetectOverhangsForLift = 8
    posSimplifyPath = 9
    psWipeTower = 10
    psSkirtBrim = 11
    psGCodePostProcess = 12


globals().update(Step.__members__)

# The engine's live SCALING_FACTOR (1e-6, or 1e-5 for beds over 2147 mm); set per hook.
SCALING_FACTOR = contextvars.ContextVar("orca_scaling_factor", default=1e-6)


def unscale(coord):
    """Convert a scaled integer coordinate to millimeters (reads the live SCALING_FACTOR)."""
    return float(int(coord)) * SCALING_FACTOR.get()


class SlicingPipelineContext:
    """What a slicing-pipeline capability gets at each step."""

    def __init__(self, step, orca_version="", gcode_path="", host="", output_name="", print=None, object=None,
                 config=None, cancelled=None):
        self._step = step
        self._orca_version = orca_version
        self._gcode_path = gcode_path
        self._host = host
        self._output_name = output_name
        self._print = print
        self._object = object
        self._config = config or {}
        self._cancelled = cancelled

    orca_version = property(lambda s: s._orca_version)
    step = property(lambda s: s._step)
    gcode_path = property(lambda s: s._gcode_path, doc="Path to the working G-code file, set ONLY at Step.psGCodePostProcess.")
    host = property(lambda s: s._host, doc='Target host at Step.psGCodePostProcess ("File", "OctoPrint", ...); empty otherwise.')
    output_name = property(lambda s: s._output_name, doc="Final output G-code name at Step.psGCodePostProcess; empty otherwise.")
    print = property(lambda s: s._print, doc="The orca.host.Print being sliced, or None (always None at psGCodePostProcess).")
    object = property(lambda s: s._object, doc="orca.host.PrintObject for object-scoped steps, or None.")

    def config_value(self, key):
        """Serialized value of a resolved (full) print config option for this slice, or None if absent."""
        if self._print is not None:
            return self._print.config_value(key)
        v = self._config.get(key)
        return v if isinstance(v, str) else None

    def cancelled(self):
        return bool(self._cancelled()) if self._cancelled else False


class SlicingPipelineCapabilityBase(PythonPluginBase):
    """execute(self, ctx) runs at every slicing step the preset selects this capability for
    (sync only). Filter on ctx.step."""

    def get_type(self):
        return PluginType.SlicingPipeline

    def execute(self, ctx):
        _pure("SlicingPipelinePluginCapability", "execute")
