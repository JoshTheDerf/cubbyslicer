"""Plugin host API"""
import os

from .. import _bridge

DATA_DIR = "/orca/data/orca_plugins/plugin_data"


def storage():
    """Return the private storage folder of the current plugin (persistent, in the browser's storage)."""
    cur = _bridge.current()
    if not cur:
        raise RuntimeError("plugin.storage() must be called from a plugin callback")
    path = f"{DATA_DIR}/{cur[0]}"
    os.makedirs(path, exist_ok=True)
    return path
