"""CubbySlicer plugin runtime (private): blocking waits that keep UI callbacks running.

On desktop OrcaSlicer a Script runs on its own worker thread, and its UI callbacks (on_message,
on_close, ...) run on the wx UI thread. A Script may therefore park in queue.Queue.get(),
threading.Event.wait() or time.sleep() until a callback hands it work (sandboxes/
orca_preset_update_demo.py does). Pyodide has one thread: such a wait would never return.

So every blocking wait built on threading.Condition (queue.Queue get / put / join, Event.wait,
Semaphore, Barrier, Condition.wait / wait_for) and time.sleep() deliver the pending UI callbacks
while they wait, through the runtime's CallbackChannel (src/plugins/runtime/hostChannel.ts). A
callback runs in a fresh context (no capability scope or pipeline-hook flag of the waiting code).

Without cross-origin isolation there is no CallbackChannel: a wait with a timeout waits as before
(nothing can arrive), and a wait without one raises a RuntimeError instead of hanging the runtime.
"""
import _thread
import contextvars
import json
import threading
import time

try:
    import _cubby_host as _host
except ImportError:  # unit tests outside the worker
    _host = None

from orca import _bridge

NOT_ISOLATED = ("This plugin waits for its own window (a blocking queue / event / condition wait), which needs "
                "CubbySlicer to run cross-origin isolated (SharedArrayBuffer), and this page is not.")

_orig_cond_wait = threading.Condition.wait
_orig_sleep = time.sleep
_dispatch = None   # set by install(): callable(message dict)
_SLICE = 0.1       # longest single wait, so KeyboardInterrupt and timeouts stay responsive


_isolated = False  # set by install(): the runtime has a CallbackChannel


def _channel():
    """True when callbacks can be pumped here (isolated page, not inside a slicing pipeline hook)."""
    return _isolated and not _bridge.IN_PIPELINE_HOOK.get()


def pump(timeout):
    """Wait up to `timeout` seconds (None: one slice) for UI callbacks and run them. True if any ran."""
    ms = int(max(0.0, min(_SLICE if timeout is None else timeout, _SLICE)) * 1000)
    text = _host.waitCallbacks(ms)
    if not text:
        return False
    for msg in json.loads(text):
        contextvars.Context().run(_dispatch, msg)
    return True


def _cond_wait(self, timeout=None):
    """threading.Condition.wait that runs UI callbacks while it waits (see the module docstring)."""
    if not _channel():
        if timeout is None and _host is not None:
            if not self._is_owned():
                raise RuntimeError("cannot wait on un-acquired lock")
            raise RuntimeError("A blocking wait without a timeout never returns inside a slicing pipeline hook"
                               if _isolated else NOT_ISOLATED)
        return _orig_cond_wait(self, timeout)
    if not self._is_owned():
        raise RuntimeError("cannot wait on un-acquired lock")
    waiter = _thread.allocate_lock()
    waiter.acquire()
    self._waiters.append(waiter)
    saved_state = self._release_save()
    gotit = False
    try:
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        while True:
            if waiter.acquire(False):   # notify() released it (from a callback)
                gotit = True
                break
            remaining = None
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
            pump(remaining)
        return gotit
    finally:
        self._acquire_restore(saved_state)
        if not gotit:
            try:
                self._waiters.remove(waiter)
            except ValueError:
                pass


def _sleep(secs):
    """time.sleep that runs UI callbacks while it sleeps."""
    if secs < 0:
        raise ValueError("sleep length must be non-negative")
    if not secs or not _channel():
        return _orig_sleep(secs)
    deadline = time.monotonic() + secs
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        pump(remaining)


def install(dispatch):
    """Patch the waits. `dispatch(msg)` runs one CallbackChannel message (uiEvent / pageMessage)."""
    global _dispatch, _isolated
    _dispatch = dispatch
    wait = getattr(_host, "waitCallbacks", None) if _host is not None else None
    _isolated = wait is not None and wait(0) is not None   # nothing is queued at boot
    threading.Condition.wait = _cond_wait
    time.sleep = _sleep
