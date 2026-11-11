"""Local preset bundle operations (not available in CubbySlicer: there is no local bundle folder)."""

_MSG = "Local preset bundles are not available in CubbySlicer"


def list_ids():
    raise RuntimeError(_MSG)


def reload_local(bundle_id):
    raise RuntimeError(_MSG)
