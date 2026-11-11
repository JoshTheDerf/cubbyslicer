"""Private: the link between the `orca` shim and CubbySlicer's plugin runtime worker.

Not part of OrcaSlicer's API. Plugins must not import it; nothing here is a
security boundary (see src/plugins/README in the Plugins dialog's trust note).
"""
import contextvars
import json

try:  # registered by the runtime worker (pyodide.registerJsModule) before any plugin loads
    import _cubby_host as _host
except ImportError:  # unit tests outside the worker
    _host = None

# (plugin_key, capability_type, capability_name) of the capability call in progress. Import and
# register_capabilities() run without one, like Orca's unattributed load phase.
CURRENT = contextvars.ContextVar("orca_capability", default=None)
# A config snapshot that overrides the pushed cache for this call (post-process uses the export's).
CONFIG_OVERRIDE = contextvars.ContextVar("orca_config_override", default=None)
# Extra allowed filesystem root for this call (the G-code folder at psGCodePostProcess).
SCOPED_ROOT = contextvars.ContextVar("orca_scoped_root", default=None)
# True while a slicing-pipeline geometry hook runs (orca.host.ui is refused there).
IN_PIPELINE_HOOK = contextvars.ContextVar("orca_in_pipeline_hook", default=False)

# Effective capability configs pushed by the host: {(key, type, name): (config_json_str, version)}
CONFIGS = {}

_EXC = {"RuntimeError": RuntimeError, "ValueError": ValueError, "IndexError": IndexError,
        "TypeError": TypeError, "KeyError": KeyError, "PermissionError": PermissionError,
        "NotImplementedError": NotImplementedError}


def current():
    return CURRENT.get()


def _attribution():
    cur = CURRENT.get()
    return (cur[0], cur[2]) if cur else ("", "")


def _json_default(value):
    # Orca's py_to_json falls back to str() for unknown types (numpy scalars included).
    try:
        import numpy  # noqa: F401  (only if already loaded)
        if hasattr(value, "item"):
            return value.item()
        if hasattr(value, "tolist"):
            return value.tolist()
    except Exception:
        pass
    return str(value)


def dumps(value):
    return json.dumps(value, default=_json_default)


def call(method, **args):
    """A synchronous host call (blocks the runtime until the app answers). Returns (json, blobs)."""
    if _host is None:
        raise RuntimeError("OrcaSlicer host is not available")
    key, cap = _attribution()
    res = _host.call(method, dumps(args), key, cap)
    err = getattr(res, "error", None)
    if err is not None:
        raise _EXC.get(err.type, RuntimeError)(err.message)
    data = json.loads(res.json) if res.json else None
    blobs = [bytes(b.to_py()) for b in res.blobs] if getattr(res, "blobs", None) else []
    return data, blobs


def post(method, **args):
    """A fire-and-forget host request (works without cross-origin isolation)."""
    if _host is None:
        return
    key, cap = _attribution()
    _host.post(method, dumps(args), key, cap)


def capability_config(identity):
    """(config_json_str, plugin_version) of a capability: the call's snapshot, else the pushed effective config."""
    override = CONFIG_OVERRIDE.get()
    if override is not None and override[0] == identity:
        return override[1], override[2]
    return CONFIGS.get(identity, ("{}", ""))


# ---- slicing-pipeline hooks (graph queries go to the engine through the HookChannel) ----

class HookCancelled(BaseException):
    """The slice was cancelled while a pipeline hook ran (raised out of a graph query)."""


def hook_query(request_json, blob=b""):
    """One cs_hook_query round trip: (reply dict, out blob bytes). Only valid inside a pipeline hook."""
    if _host is None or not IN_PIPELINE_HOOK.get():
        raise RuntimeError("The slicing graph is only available inside a slicing pipeline hook (ctx.print / ctx.object)")
    res = _host.hookQuery(request_json, blob)
    if getattr(res, "cancelled", False):
        raise HookCancelled()
    err = getattr(res, "error", None)
    if err is not None:
        raise RuntimeError(str(err))
    out = res.blob.to_bytes() if getattr(res, "blob", None) is not None else b""
    return json.loads(res.json), out


def hook_cancelled():
    return bool(_host is not None and _host.hookCancelled())
