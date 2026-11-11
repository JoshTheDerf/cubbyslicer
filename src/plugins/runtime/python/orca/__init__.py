"""OrcaSlicer plugin API.

CubbySlicer's implementation of OrcaSlicer 2.5.0's embedded `orca` module for
the browser (Pyodide). Unmodified Orca plugins import it as they would in
OrcaSlicer; what the browser cannot do raises a clear exception.
"""
from ._core import (  # noqa: F401
    PluginType, PluginResult, LifecycleEvent, LifecycleEvtCode, LifecycleEventContext, PluginContext,
    ExecutionResult, PythonPluginBase, base, plugin, register_capability, request_permissions,
)

# pybind11 export_values(): enum members are also module attributes.
for _enum in (PluginType, PluginResult, LifecycleEvent, LifecycleEvtCode):
    globals().update(_enum.__members__)
del _enum

from . import script, slicing, pages, resource_texture, printer_agent, host  # noqa: E402,F401
