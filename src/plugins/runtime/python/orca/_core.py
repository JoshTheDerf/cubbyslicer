"""The `orca` top level: enums, result types, the capability root and registration.

Names, signatures and error messages follow OrcaSlicer 2.5.0's pybind11 module
(src/slic3r/plugin/PythonPluginBridge.cpp bind_python_api).
"""
import enum
import json

from . import _bridge


class _OrcaEnum(enum.IntEnum):
    """pybind11 enum look-alike: int-valued, str() = 'Type.Member'."""

    def __str__(self):
        return f"{type(self).__name__}.{self.name}"

    def __repr__(self):
        return f"<{type(self).__name__}.{self.name}: {int(self)}>"


class PluginType(_OrcaEnum):
    """Available plugin capability groups"""
    PrinterConnection = 0
    Pages = 1
    Analysis = 2
    Importer = 3
    Exporter = 4
    Visualization = 5
    Script = 6
    SlicingPipeline = 7
    ResourceTexture = 8
    Unknown = 9


TYPE_STRINGS = {
    PluginType.PrinterConnection: "printer-connection", PluginType.Pages: "pages", PluginType.Analysis: "analysis",
    PluginType.Importer: "importer", PluginType.Exporter: "exporter", PluginType.Visualization: "visualization",
    PluginType.Script: "script", PluginType.SlicingPipeline: "slicing-pipeline",
    PluginType.ResourceTexture: "resource-texture", PluginType.Unknown: "unknown",
}
TYPE_DISPLAY = {
    PluginType.PrinterConnection: "Printer connection", PluginType.Pages: "Pages", PluginType.Analysis: "Analysis",
    PluginType.Importer: "Importer", PluginType.Exporter: "Exporter", PluginType.Visualization: "Visualization",
    PluginType.Script: "Script", PluginType.SlicingPipeline: "Slicing Pipeline",
    PluginType.ResourceTexture: "Resource Texture", PluginType.Unknown: "Unknown",
}


class PluginResult(_OrcaEnum):
    """Execution summary code"""
    Success = 0
    Skipped = 1
    RecoverableError = 2
    FatalError = 3


class LifecycleEvent(_OrcaEnum):
    """Application lifecycle moment passed to on_lifecycle_event"""
    NewProject = 0
    ProjectOpened = 1
    ProjectBeforeSave = 2
    ProjectAfterSave = 3
    ProjectClosed = 4
    ProjectDirtyChanged = 5
    SliceStarted = 6
    SliceGeometryFinished = 7
    GCodeExportStarted = 8
    GCodeExportFinished = 9
    SlicingJobComplete = 10
    ObjectAdded = 11
    ObjectDeleted = 12
    ObjectTransformed = 13
    ObjectChanged = 14
    ObjectRenamed = 15
    PlateCreated = 16
    PlateDeleted = 17
    PlateSelected = 18
    PlateRenamed = 19
    PresetSelected = 20
    PresetSaved = 21
    PrintStateChanged = 22
    DeviceOnline = 23
    DeviceOffline = 24
    DeviceDiscovered = 25
    DeviceSelected = 26
    UploadStarted = 27
    UploadFinished = 28
    PrintJobStarted = 29
    PrintJobFinished = 30
    SendJobStarted = 31
    SendJobFinished = 32


class LifecycleEvtCode(_OrcaEnum):
    """Outcome code accompanying a LifecycleEventContext"""
    Ok = 0
    Error = 1
    Warn = 2


class LifecycleEventContext:
    """Payload accompanying a LifecycleEvent"""
    __slots__ = ("_name", "_code", "_msg", "_id", "_previous_name", "_device_id", "_job_id", "_source", "_index", "_dirty")

    def __init__(self):
        self._name = ""
        self._code = LifecycleEvtCode.Ok
        self._msg = ""
        self._id = 0
        self._previous_name = ""
        self._device_id = ""
        self._job_id = ""
        self._source = ""
        self._index = -1
        self._dirty = False

    name = property(lambda s: s._name)
    code = property(lambda s: s._code)
    msg = property(lambda s: s._msg)
    id = property(lambda s: s._id)
    previous_name = property(lambda s: s._previous_name)
    device_id = property(lambda s: s._device_id)
    job_id = property(lambda s: s._job_id)
    source = property(lambda s: s._source)
    index = property(lambda s: s._index)
    dirty = property(lambda s: s._dirty)

    @classmethod
    def _from(cls, d):
        c = cls()
        for k in ("name", "msg", "previous_name", "device_id", "job_id", "source"):
            if isinstance(d.get(k), str):
                setattr(c, "_" + k, d[k])
        if isinstance(d.get("id"), int):
            c._id = d["id"]
        if isinstance(d.get("index"), int):
            c._index = d["index"]
        if isinstance(d.get("dirty"), bool):
            c._dirty = d["dirty"]
        if d.get("code") in LifecycleEvtCode.__members__:
            c._code = LifecycleEvtCode[d["code"]]
        return c


class PluginContext:
    """Context shared with plugin entry points"""
    orca_version = ""

    def __init__(self):
        self.orca_version = ""


class ExecutionResult:
    """Structured execution outcome"""
    status = PluginResult.Success
    message = ""
    data = ""

    def __init__(self, *args):
        if len(args) == 0:
            self.status, self.message, self.data = PluginResult.Success, "", ""
        elif len(args) == 3:
            status, message, data = args
            if not isinstance(status, PluginResult) or not isinstance(message, str) or not isinstance(data, str):
                raise TypeError("__init__(): incompatible constructor arguments. The following argument types are supported:\n"
                                "    1. orca.ExecutionResult()\n"
                                "    2. orca.ExecutionResult(arg0: orca.PluginResult, arg1: str, arg2: str)")
            self.status, self.message, self.data = status, message, data
        else:
            raise TypeError("__init__(): incompatible constructor arguments. The following argument types are supported:\n"
                            "    1. orca.ExecutionResult()\n"
                            "    2. orca.ExecutionResult(arg0: orca.PluginResult, arg1: str, arg2: str)")

    @staticmethod
    def success(message="", data=""):
        return ExecutionResult(PluginResult.Success, str(message), str(data))

    @staticmethod
    def skipped(message=""):
        return ExecutionResult(PluginResult.Skipped, str(message), "")

    @staticmethod
    def failure(status, message, data=""):
        return ExecutionResult(status, str(message), str(data))

    def __repr__(self):
        return f"<orca.ExecutionResult status={self.status} message={self.message!r}>"


def _pure(cls_name, method):
    raise RuntimeError(f'Tried to call pure virtual function "{cls_name}::{method}"')


def _identity(self, api):
    ident = getattr(self, "_orca_identity", None)
    if not ident:
        raise RuntimeError(f"{api}() is only available on a capability loaded by the plugin host")
    return ident


class PythonPluginBase:
    """The capability root every capability base derives from."""

    def __init__(self):
        pass

    def get_name(self):
        _pure("PluginCapabilityInterface", "get_name")

    def get_type(self):
        return PluginType.Unknown

    def on_load(self):
        pass

    def on_unload(self):
        pass

    def on_lifecycle_event(self, event, ctx):
        """Override to react to an application lifecycle moment (LifecycleEvent) and its
        LifecycleEventContext payload. Available on every capability type."""
        pass

    def has_config_ui(self):
        """Override to return True to replace the host's default JSON editor with your own HTML UI."""
        return False

    def get_config_ui(self):
        """Override to return the custom configuration UI as an HTML string."""
        return ""

    def get_default_config(self):
        """Override to return the config "Restore defaults" writes back, as a dict. Calling it returns a JSON string."""
        return "{}"

    def get_config(self):
        """Return this capability's stored config as a JSON string ("{}" if never saved)."""
        cfg, _ = _bridge.capability_config(_identity(self, "get_config"))
        return cfg

    def get_config_version(self):
        """Return the plugin version that last wrote this capability's config ('' if never saved)."""
        _, version = _bridge.capability_config(_identity(self, "get_config_version"))
        return version

    def save_config(self, config):
        """Persist this capability's config, given as a JSON string. Returns False if it is not valid JSON."""
        if not isinstance(config, str):
            raise TypeError("save_config(): incompatible function arguments. The following argument types are supported:\n"
                            "    1. (self: orca.PythonPluginBase, config: str) -> bool")
        ident = _identity(self, "save_config")
        try:
            value = json.loads(config)
        except ValueError:
            return False
        _bridge.CONFIGS[ident] = (json.dumps(value), _bridge.CONFIGS.get(ident, ("{}", ""))[1])
        _bridge.post("config.save", type=ident[1], name=ident[2], config=value)
        return True


class base:
    """Plugin package marker: decorate exactly one subclass with @orca.plugin."""

    def __init__(self):
        pass

    def register_capabilities(self):
        _pure("PyPluginPackage", "register_capabilities")


# ---- discovery (set by the runtime loader around import + register_capabilities) ----

_active_key = ""
_pending_package = {}
_pending_capabilities = {}
_pending_permissions = {}


def _begin_capture(key):
    global _active_key
    _pending_package.pop(key, None)
    _pending_capabilities.pop(key, None)
    _pending_permissions.pop(key, None)
    _active_key = key


def _cancel_capture(key):
    global _active_key
    _pending_package.pop(key, None)
    _pending_capabilities.pop(key, None)
    _pending_permissions.pop(key, None)
    if _active_key == key:
        _active_key = ""


def _run_registration(key):
    """Phase 1 of finalize_plugin_capture: instantiate the package, register_capabilities().
    Returns (classes, requested_permissions_dict_or_None). Raises with Orca's messages."""
    global _active_key
    cls = _pending_package.pop(key, None)
    if cls is None:
        _cancel_capture(key)
        raise RuntimeError("Plugin did not register a package class; decorate it with @orca.plugin")
    try:
        package = cls()
        package.register_capabilities()
    except BaseException:
        _cancel_capture(key)
        raise
    perms = _pending_permissions.pop(key, None)
    classes = _pending_capabilities.pop(key, [])
    if _active_key == key:
        _active_key = ""
    return classes, perms


def register_capability(plugin_cls):
    """Register a PluginCapability subclass while OrcaSlicer loads your module."""
    if not _active_key:
        raise ValueError("register_capability() called outside plugin discovery context")
    if not (isinstance(plugin_cls, type) and issubclass(plugin_cls, PythonPluginBase)):
        raise ValueError("Registered class must inherit from a PluginCapability base")
    _pending_capabilities.setdefault(_active_key, []).append(plugin_cls)


def _normalize_network_url(url):
    i = url.find("://")
    if i <= 0:
        return ""
    scheme = url[:i].lower()
    if scheme not in ("http", "https"):
        return ""
    rest = url[i + 3:]
    for sep in "/?#":
        j = rest.find(sep)
        if j >= 0:
            rest = rest[:j]
    if "@" in rest:
        rest = rest[rest.rfind("@") + 1:]
    if rest.startswith("["):
        host = rest[: rest.find("]") + 1]
    else:
        host = rest.split(":")[0]
    host = host.lower()
    return f"{scheme}://{host}" if host and host != "[]" else ""


def request_permissions(fs_read=[], fs_readwrite=[], network_http=[], network_socket=[], process=[],
                        threading=False, network=[]):
    """Request permissions while OrcaSlicer loads your module."""
    if not _active_key:
        raise ValueError("request_permissions() called outside plugin discovery context")
    buckets = {"fs_read": fs_read, "fs_readwrite": fs_readwrite, "network_http": network_http,
               "network_socket": network_socket, "process": process}
    for name, targets in buckets.items():
        if isinstance(targets, str) or not all(isinstance(t, str) for t in targets):
            raise TypeError("request_permissions(): incompatible function arguments")
        for t in targets:
            if not t:
                raise ValueError(f"request_permissions({name}=...) does not accept empty values")
    normalized = []
    for url in network:
        n = _normalize_network_url(url)
        if not n:
            raise ValueError("request_permissions(network=...) requires an http:// or https:// URL with a host")
        if n not in normalized:
            normalized.append(n)
    req = _pending_permissions.setdefault(_active_key, {
        "fs_read": [], "fs_readwrite": [], "network_http": [], "network_socket": [], "process": [],
        "threading": False, "events": [], "full_access": False})

    def add(bucket, targets):
        for t in targets:
            if t not in req[bucket]:
                req[bucket].append(t)

    add("fs_read", fs_read)
    add("fs_readwrite", fs_readwrite)
    add("network_http", network_http)
    add("network_http", normalized)
    add("network_socket", network_socket)
    add("process", process)
    if threading:
        req["threading"] = True


def plugin(cls):
    """Mark the single plugin package class (the orca.base subclass) for this file."""
    if not _active_key:
        raise ValueError("@orca.plugin used outside plugin discovery context")
    if not isinstance(cls, type):
        raise ValueError("@orca.plugin must decorate a class")
    if not issubclass(cls, base):
        raise ValueError("@orca.plugin must decorate a subclass of orca.base")
    if _active_key in _pending_package:
        raise ValueError("multiple @orca.plugin classes registered; exactly one is allowed per plugin")
    _pending_package[_active_key] = cls
    return cls
