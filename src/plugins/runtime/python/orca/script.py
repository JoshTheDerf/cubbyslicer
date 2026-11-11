"""Script Plugins API"""
from ._core import PythonPluginBase, PluginType, _pure


class ScriptPluginCapabilityBase(PythonPluginBase):
    """A runnable script: Speed Dial / command palette entry and the Plugins dialog's Run button.

    execute() may be `def` or `async def` and must return an orca.ExecutionResult."""

    def get_type(self):
        return PluginType.Script

    def execute(self):
        _pure("ScriptPluginCapability", "execute")
