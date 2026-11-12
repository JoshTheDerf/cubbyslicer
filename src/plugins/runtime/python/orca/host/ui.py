"""Host UI: message boxes and interactive HTML windows, rendered by CubbySlicer.

Windows and dock panels are sandboxed iframes with the same window.orca bridge
as OrcaSlicer (postMessage / submit / close / onMessage). A dock panel docks
beside the 3D view as in OrcaSlicer (on phones it is a bottom sheet). Callbacks
(on_message, on_submit, on_close, on_click) run on the plugin runtime's event
loop between other plugin code, not concurrently with it, and also while plugin code
waits in queue.Queue.get(), Event.wait(), time.sleep() and the like (_cubby_wait.py).
"""
import itertools

from .. import _bridge
from .._core import _OrcaEnum

PD_CAN_ABORT = 0x0001
PD_APP_MODAL = 0x0002
PD_AUTO_HIDE = 0x0004
PD_ELAPSED_TIME = 0x0008
PD_ESTIMATED_TIME = 0x0010
PD_REMAINING_TIME = 0x0040
PD_CAN_SKIP = 0x0080
WINDOW_MODELESS = 0
WINDOW_MODAL = 1

_ids = itertools.count(1)
# handle id -> {"kind", "open", "cb": {event: callable}, "scope": CURRENT value, "cancelled", "visible"}
_HANDLES = {}


def _guard():
    if _bridge.IN_PIPELINE_HOOK.get():
        raise RuntimeError("orca.host.ui must not be called from a slicing pipeline hook")


def _new(kind, callbacks):
    hid = next(_ids)
    _HANDLES[hid] = {"kind": kind, "open": True, "cb": {k: v for k, v in callbacks.items() if v is not None},
                     "scope": _bridge.current(), "cancelled": False}
    return hid


def _dispatch(hid, event, data):
    """Called by the runtime for a UI event from the app. Returns the callback result."""
    h = _HANDLES.get(hid)
    if h is None:
        return None
    if event in ("close", "submit"):
        if not h["open"]:
            return None
        h["open"] = False
    if event == "cancel":
        h["cancelled"] = True
        return None
    cb = h["cb"].get({"message": "on_message", "submit": "on_submit", "close": "on_close", "click": "on_click"}[event])
    if event in ("close", "submit"):
        # fire once; drop every callback afterwards
        h["cb"] = {}
    if cb is None:
        return None
    return cb() if event in ("close", "click") else cb(data)


def message(text, title="OrcaSlicer", buttons="ok", icon="info"):
    """Show a modal message box; returns the clicked button id ("ok"/"cancel"/"yes"/"no").
    buttons: "ok"|"ok_cancel"|"yes_no"|"yes_no_cancel"; icon: "info"|"warning"|"error"|"question"."""
    _guard()
    result, _ = _bridge.call("ui.message", text=str(text), title=str(title), buttons=str(buttons), icon=str(icon))
    return result


class UiWindow:
    """Handle to a plugin HTML window or modal dialog created by create_window()."""

    def __init__(self, hid):
        self._id = hid

    @property
    def id(self):
        return self._id

    def post(self, data):
        """Send a payload to the page (delivered to window.orca.onMessage handlers)."""
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.post", handle=self._id, data=data)

    def close(self):
        """Close the window (fires on_close)."""
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.close", handle=self._id)

    def is_open(self):
        """Return True while the window is open."""
        return bool(_HANDLES.get(self._id, {}).get("open"))


def create_window(html, title="OrcaSlicer", width=820, height=600, on_message=None, on_close=None,
                  style=WINDOW_MODELESS, on_submit=None):
    """Open a persistent HTML window or modal dialog and return a UiWindow. style is WINDOW_MODELESS or
    WINDOW_MODAL. on_message(data) is called when the page posts; on_submit(data) when the page submits."""
    _guard()
    hid = _new("window", {"on_message": on_message, "on_close": on_close, "on_submit": on_submit})
    _bridge.post("ui.createWindow", handle=hid, html=str(html), title=str(title), width=int(width), height=int(height),
                 modal=bool(int(style) & WINDOW_MODAL))
    return UiWindow(hid)


class UiDockPanel:
    """Handle to a dockable plugin HTML panel created by create_dock_panel()."""

    def __init__(self, hid):
        self._id = hid

    @property
    def id(self):
        return self._id

    def post(self, data):
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.post", handle=self._id, data=data)

    def show(self):
        """Show the panel again after hide()."""
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.show", handle=self._id, visible=True)

    def hide(self):
        """Hide the panel without closing it."""
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.show", handle=self._id, visible=False)

    def close(self):
        """Close the panel (fires on_close)."""
        if _HANDLES.get(self._id, {}).get("open"):
            _bridge.post("ui.close", handle=self._id)

    def is_open(self):
        """Return True until the panel is closed; a hidden panel is still open."""
        return bool(_HANDLES.get(self._id, {}).get("open"))


def create_dock_panel(html, title="OrcaSlicer", width=320, height=480, on_message=None, on_close=None, dock="right"):
    """Open an HTML panel docked beside the 3D view and return a UiDockPanel. dock is "left",
    "right", "bottom" or "float", and width / height are in CSS pixels (the dock's width, the bottom
    dock's height, the floating size). The user can move, float and resize the panel, and a panel
    opened again comes back where it was left. It shows on the Prepare and Preview tabs."""
    _guard()
    if dock not in ("left", "right", "bottom", "float"):
        raise ValueError('dock must be "left", "right", "bottom" or "float"')
    hid = _new("dock", {"on_message": on_message, "on_close": on_close})
    _bridge.post("ui.createDock", handle=hid, html=str(html), title=str(title), width=int(width), height=int(height), dock=dock)
    return UiDockPanel(hid)


class ProgressDialog:
    """Handle to a progress dialog."""

    def __init__(self, title, message, maximum=100, style=PD_APP_MODAL | PD_AUTO_HIDE):
        _guard()
        self._id = _new("progress", {})
        self._max = int(maximum)
        self._style = int(style)
        _bridge.post("ui.progressCreate", handle=self._id, title=str(title), message=str(message),
                     maximum=self._max, style=self._style)

    @property
    def id(self):
        return self._id

    def _alive(self):
        h = _HANDLES.get(self._id)
        return bool(h and h["open"] and not h["cancelled"])

    def _sync(self, method, **args):
        # With the HostChannel the app answers whether the user cancelled; without it, the last known state.
        try:
            ok, _ = _bridge.call(method, handle=self._id, **args)
            if not ok:
                _HANDLES.get(self._id, {})["cancelled"] = True
            return bool(ok)
        except RuntimeError:
            _bridge.post(method, handle=self._id, **args)
            return self._alive()

    def pulse(self, message=""):
        """Pulse the dialog gauge; returns False if the dialog is closed or cancelled."""
        if not self._alive():
            return False
        return self._sync("ui.progressPulse", message=str(message))

    def update(self, value, message=""):
        """Set the dialog progress value; returns False if the dialog is closed or cancelled."""
        if not self._alive():
            return False
        ok = self._sync("ui.progressUpdate", value=int(value), message=str(message))
        if int(value) >= self._max and self._style & PD_AUTO_HIDE:
            h = _HANDLES.get(self._id)
            if h:
                h["open"] = False
        return ok

    def start_pulse(self, interval_ms=100, message=""):
        """Start periodic pulsing."""
        if self._alive():
            _bridge.post("ui.progressStartPulse", handle=self._id, interval_ms=int(interval_ms), message=str(message))

    def stop_pulse(self):
        """Stop periodic pulsing."""
        if self._alive():
            _bridge.post("ui.progressStopPulse", handle=self._id)

    def close(self):
        """Close the progress dialog."""
        h = _HANDLES.get(self._id)
        if h and h["open"]:
            h["open"] = False
            _bridge.post("ui.progressClose", handle=self._id)

    def is_open(self):
        """Return True while this progress dialog is registered."""
        return bool(_HANDLES.get(self._id, {}).get("open"))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def create_progress_dialog(title, message, maximum=100, style=PD_APP_MODAL | PD_AUTO_HIDE):
    """Create a progress dialog and return a ProgressDialog handle."""
    return ProgressDialog(title, message, maximum, style)


class NotificationLevel(_OrcaEnum):
    ProgressBarNotificationLevel = 1
    HintNotificationLevel = 2
    RegularNotificationLevel = 3
    PrintInfoNotificationLevel = 4
    PrintInfoShortNotificationLevel = 5
    ImportantNotificationLevel = 6
    WarningNotificationLevel = 7
    SeriousWarningNotificationLevel = 8
    ErrorNotificationLevel = 9


globals().update(NotificationLevel.__members__)


def push_notification(notification_level, text, hyper_text="", on_click=None):
    """Push a notification. hyper_text is an action label; on_click() is called when it is clicked
    and may return True to close the notification."""
    _guard()
    level = NotificationLevel(notification_level)
    hid = _new("notification", {"on_click": on_click})
    _bridge.post("ui.notify", handle=hid, level=level.name, text=str(text), hyper_text=str(hyper_text),
                 clickable=on_click is not None)
