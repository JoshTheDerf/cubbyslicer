"""Plugin page API"""
from . import _bridge
from ._core import PythonPluginBase, PluginType, _pure


class PagesPluginCapabilityBase(PythonPluginBase):
    """A main-window page beside Prepare / Preview (its HTML comes from get_ui())."""

    def get_type(self):
        return PluginType.Pages

    def get_ui(self):
        _pure("PagesPluginCapability", "get_ui")

    def get_icon(self):
        return ""

    def on_message(self, data):
        pass

    def post_message(self, data):
        """Send a JSON-compatible value to the page's window.orca.onMessage handlers."""
        ident = getattr(self, "_orca_identity", None)
        if ident:
            _bridge.post("page.post", name=ident[2], data=data)
