"""Plugin resource texture API"""
from ._core import PythonPluginBase, PluginType, _pure


class ResourceTexturePluginCapabilityBase(PythonPluginBase):
    """A folder of textures for Texture Displacement (listed in CubbySlicer; it has no Texture Displacement yet)."""

    def get_type(self):
        return PluginType.ResourceTexture

    def get_texture_dir(self):
        _pure("ResourceTexturePluginCapability", "get_texture_dir")
