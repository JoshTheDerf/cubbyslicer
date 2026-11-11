"""Preset operations

orca.host.preset.process / .printer / .filament edit the preset the matching
settings tab edits now (PluginHostPresets.cpp). begin_update() binds a target
(selecting another preset through CubbySlicer's normal flow, which asks about
unsaved edits), set() stages serialized values, commit() validates them all
and applies all or none. Nothing is saved to disk: the preset becomes dirty,
as when the user edits it.
"""
from ... import _bridge
from . import bundles  # noqa: F401

_COMMITTED = "This preset transaction has already been committed; start a new begin_update()"


def _ptype(name):
    from .. import PresetType
    return PresetType[name]


class PresetUpdateResult:
    type = None
    target_name = ""
    selection_changed = False
    slot_number = -1
    slot_assignment_changed = False
    shared_slots = ()
    keys = ()
    dirty = False
    category = ""

    def __init__(self, d=None):
        d = d or {}
        self.type = _ptype(d["type"]) if d.get("type") else None
        self.target_name = d.get("target_name", "")
        self.selection_changed = bool(d.get("selection_changed"))
        self.slot_number = int(d.get("slot_number", -1))
        self.slot_assignment_changed = bool(d.get("slot_assignment_changed"))
        self.shared_slots = list(d.get("shared_slots", []))
        self.keys = list(d.get("keys", []))
        self.dirty = bool(d.get("dirty"))
        self.category = d.get("category", "")

    def __repr__(self):
        return (f"<orca.host.preset.PresetUpdateResult target={self.target_name!r} keys={self.keys!r} "
                f"dirty={self.dirty}>")


class PresetTransaction:
    """A staged update of one bound preset (begin_update() → set() … → commit())."""

    def __init__(self, bound):
        self._b = bound
        self._staged = []
        self._keys = set()
        self._committed = False

    type = property(lambda s: _ptype(s._b["type"]))
    target_name = property(lambda s: s._b["target_name"])
    selection_changed = property(lambda s: bool(s._b["selection_changed"]))
    slot_number = property(lambda s: int(s._b["slot_number"]))
    category = property(lambda s: s._b["category"])
    staged_keys = property(lambda s: [k for k, _ in s._staged])

    def set(self, key, value):
        """Stage `value` (the setting's serialized string form) for `key`."""
        if not isinstance(key, str) or not isinstance(value, str):
            raise TypeError("set(): incompatible function arguments. The following argument types are supported:\n"
                            "    1. (self: orca.host.preset.PresetTransaction, key: str, value: str) -> None")
        if self._committed:
            raise RuntimeError(_COMMITTED)
        if not key:
            raise ValueError("A setting key is required")
        if key in self._keys:
            raise ValueError(f'Setting "{key}" is already staged in this transaction; '
                             "conflicting duplicate writes to one setting are rejected")
        self._keys.add(key)
        self._staged.append((key, value))

    def commit(self):
        if self._committed:
            raise RuntimeError(_COMMITTED)
        d, _ = _bridge.call("presets.commit", category=self._b["type"], target_id=self._b["target_id"],
                            target_name=self._b["target_name"], slot_number=self._b["slot_number"],
                            selection_changed=self._b["selection_changed"], staged=[list(kv) for kv in self._staged])
        self._committed = True
        return PresetUpdateResult(d)


class PresetEditor:
    """Handle to a category of currently edited preset."""

    def __init__(self, type_name):
        self._type = type_name

    @property
    def type(self):
        return _ptype(self._type)

    def begin_update(self, *args, **kwargs):
        first = args[0] if args else kwargs.get("slot_number", kwargs.get("preset_name"))
        is_slot = isinstance(first, int) and not isinstance(first, bool)
        if self._type == "Filament" and not is_slot:
            raise ValueError('begin_update on the filament editor takes (slot_number, preset_name=""); '
                             'use orca.host.preset.filament.begin_update(slot_number, ...)')
        if self._type != "Filament" and is_slot:
            raise ValueError('The slot_number form of begin_update() is only available on orca.host.preset.filament; '
                             'call begin_update(preset_name="") on this editor')
        if self._type == "Filament":
            slot = args[0] if args else kwargs.get("slot_number")
            name = args[1] if len(args) > 1 else kwargs.get("preset_name", "")
        else:
            slot = None
            name = args[0] if args else kwargs.get("preset_name", "")
        if not isinstance(name, str):
            raise TypeError("begin_update(): preset_name must be a str")
        d, _ = _bridge.call("presets.beginUpdate", category=self._type, preset_name=name, slot=slot)
        return PresetTransaction(d)

    def update(self, *args):
        """update(key, value), or filament.update(slot_number, key, value): begin_update + set + commit."""
        if self._type != "Filament" and len(args) == 3:
            raise ValueError("The slot_number form of update() is only available on orca.host.preset.filament; "
                             "call update(key, value) on this editor")
        if self._type == "Filament":
            if len(args) != 3:
                raise TypeError("update(): filament takes (slot_number, key, value)")
            tx = self.begin_update(args[0])
            tx.set(args[1], args[2])
        else:
            if len(args) != 2:
                raise TypeError("update(): takes (key, value)")
            tx = self.begin_update()
            tx.set(args[0], args[1])
        tx.commit()


process = PresetEditor("Print")
printer = PresetEditor("Printer")
filament = PresetEditor("Filament")
