"""CubbySlicer plugin runtime: loads Orca plugins into this interpreter and calls them.

Mirrors OrcaSlicer 2.5.0's plugin_loader::load / finalize_plugin_capture
(PluginLoader.cpp, PythonPluginBridge.cpp), the Script runtime (sync or async
execute, cancellation), the psGCodePostProcess dispatch (PostProcessor.cpp)
and the permission audit hook (PluginAuditManager.cpp), adapted to one
browser thread. Driven by the runtime worker (prw.worker.ts) through `api`.
"""
import asyncio
import importlib
import inspect
import json
import os
import shutil
import sys
import traceback
import zipfile

import orca
from orca import _bridge, _core
from orca.host import ui as _ui

try:
    import _cubby_host as _host
except ImportError:
    _host = None

DATA_DIR = "/orca/data"
PLUGINS_DIR = DATA_DIR + "/orca_plugins"
RESOURCES_DIR = "/orca/resources"
STDLIB_DIRS = (sys.prefix + "/lib", "/lib/python3.12", "/lib/python312.zip", "/usr/lib")


def _log(level, text, key=None):
    if _host is not None:
        _host.log(level, text, key or "")


def _exc_text(e):
    return f"{type(e).__name__}: {e}" if str(e) else type(e).__name__


# ---- loaded plugins ---------------------------------------------------------------------

class _Cap:
    __slots__ = ("inst", "type", "name", "enabled", "has_config_ui", "loaded", "textures", "texture_error")

    def __init__(self, inst, ctype, name):
        self.inst, self.type, self.name = inst, ctype, name
        self.enabled = True
        self.has_config_ui = False
        self.loaded = False
        self.textures = None
        self.texture_error = None


class _Plugin:
    def __init__(self, key, desc):
        self.key = key
        self.desc = desc
        self.caps = []
        self.modules = []
        self.paths = []
        self.grants = {}
        self.runs = {}


PLUGINS = {}


def _find(key, ctype, name, only_enabled=True):
    p = PLUGINS.get(key)
    if not p:
        return None
    for c in p.caps:
        if c.type == ctype and c.name == name and (c.enabled or not only_enabled):
            return c
    return None


class _scope:
    """Attribute host calls, config and audit events to one capability (ScopedPluginAuditContext)."""

    def __init__(self, key, ctype, name, scoped_root=None, config=None):
        self.v = (key, ctype, name)
        self.root = scoped_root
        self.config = config

    def __enter__(self):
        self.t1 = _bridge.CURRENT.set(self.v)
        self.t2 = _bridge.SCOPED_ROOT.set(self.root)
        self.t3 = _bridge.CONFIG_OVERRIDE.set((self.v,) + self.config if self.config else None)
        return self

    def __exit__(self, *exc):
        _bridge.CONFIG_OVERRIDE.reset(self.t3)
        _bridge.SCOPED_ROOT.reset(self.t2)
        _bridge.CURRENT.reset(self.t1)
        return False


def _caps_info(p):
    out = []
    for c in p.caps:
        d = {"pluginKey": p.key, "type": c.type, "name": c.name, "enabled": c.enabled, "hasConfigUi": c.has_config_ui,
             "supported": c.type != "printer-connection"}
        if c.textures is not None:
            d["textureFiles"] = c.textures
        if c.texture_error:
            d["textureError"] = c.texture_error
        out.append(d)
    return out


def _remove_module_tree(name):
    for m in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
        del sys.modules[m]


def _extract(whl, dest):
    if not os.path.isdir(dest):
        with zipfile.ZipFile(whl) as z:
            for n in z.namelist():
                target = os.path.normpath(os.path.join(dest, n))
                if not target.startswith(os.path.normpath(dest) + os.sep) and target != os.path.normpath(dest):
                    raise RuntimeError(f"Unsafe path in wheel: {n}")
            z.extractall(dest)
    return dest


def _texture_files(root, rel):
    """Validate a ResourceTexture folder (inside the plugin root, ≤ 64 png/jpg/jpeg/bmp)."""
    d = os.path.realpath(os.path.join(root, rel)) if not os.path.isabs(rel) else os.path.realpath(rel)
    if not (d == os.path.realpath(root) or d.startswith(os.path.realpath(root) + os.sep)):
        raise RuntimeError("Texture directory must be inside the plugin folder")
    if not os.path.isdir(d):
        raise RuntimeError(f"Texture directory does not exist: {rel}")
    files = sorted(f for f in os.listdir(d) if f.lower().endswith((".png", ".jpg", ".jpeg", ".bmp"))
                   and os.path.isfile(os.path.join(d, f)))
    return files[:64]


async def load(desc_json, enable_json, grants_json, skip_deps):
    """plugin_loader::load. Returns the loaded capability list (JSON) or raises with Orca's messages."""
    desc = json.loads(desc_json)
    enable = dict(json.loads(enable_json))
    key = desc["pluginKey"]
    if key in PLUGINS:
        unload(key)
    p = _Plugin(key, desc)
    p.grants = json.loads(grants_json)
    root = f"{PLUGINS_DIR}/{desc['root']}"
    entry = f"{root}/{desc['entryFile']}"

    # 3. dependencies
    deps = [d for d in desc.get("dependencies", []) if d.strip()]
    if deps and not skip_deps:
        for d in deps:
            if d.split(";")[0].strip().lower().replace("_", "-").split("[")[0].rstrip("<>=!~ 0123456789.,").strip() == "orca":
                raise RuntimeError("Failed to install plugin dependencies: a dependency named 'orca' would replace the plugin API")
        try:
            await _install_deps(deps)
        except Exception as e:
            raise RuntimeError(f"Failed to install plugin dependencies: {e}")

    # 4.-5. capture + vendored wheels + import
    _core._begin_capture(key)
    try:
        for f in sorted(os.listdir(root)):
            if f.endswith(".whl") and f"{root}/{f}" != entry:
                try:
                    dep = _extract(f"{root}/{f}", f"{root}/__whl_extracted__/{f[:-4]}")
                except Exception as e:
                    raise RuntimeError(f"Failed to extract plugin .whl dependency {root}/{f}: {e}")
                sys.path.insert(0, dep)
                p.paths.append(dep)
        if desc["kind"] == "whl":
            pkg = desc.get("entryPackage") or ""
            d = _extract(entry, f"{root}/__whl_extracted__/{pkg}")
            module_name = pkg
        else:
            d = root
            module_name = desc["entryFile"][:-3]
        sys.path.insert(0, d)
        p.paths.append(d)
        _remove_module_tree(module_name)
        try:
            importlib.invalidate_caches()
            importlib.import_module(module_name)
        except BaseException as e:
            raise RuntimeError(f"Failed to load plugin module: {_exc_text(e)}") from e
        p.modules.append(module_name)
    except BaseException:
        _core._cancel_capture(key)
        _drop_paths(p)
        raise

    # 6. finalize_plugin_capture
    try:
        classes, requested = _core._run_registration(key)
    except BaseException as e:
        _drop_paths(p)
        raise RuntimeError(f"Plugin registration failed: {_exc_text(e)}") from e

    if requested and any(requested[k] for k in ("fs_read", "fs_readwrite", "network_http", "network_socket", "process", "threading")):
        answer = await _host.requestPermissions(key, json.dumps(requested))
        answer = json.loads(answer)
        if not answer.get("granted"):
            _drop_paths(p)
            raise RuntimeError("Plugin permission request denied")
        p.grants = answer.get("grants") or p.grants

    if not classes:
        _drop_paths(p)
        raise RuntimeError("Plugin module did not register any capabilities")

    seen = set()
    try:
        for cls in classes:
            inst = cls()
            if not isinstance(inst, orca.PythonPluginBase):
                raise RuntimeError("Registered capability must inherit from a PluginCapability base")
            name = inst.get_name()
            if not isinstance(name, str):
                raise RuntimeError("get_name() must return a str")
            if ";" in name:
                raise RuntimeError(f"Capability name must not contain ';': {name}")
            ptype = inst.get_type()
            ctype = _core.TYPE_STRINGS.get(ptype, "unknown")
            if (ctype, name) in seen:
                raise RuntimeError(f"Plugin declares duplicate capability '{name}' for type {_core.TYPE_DISPLAY.get(ptype, 'Unknown')}")
            seen.add((ctype, name))
            inst._orca_identity = (key, ctype, name)
            c = _Cap(inst, ctype, name)
            c.enabled = bool(enable.get(name, True))
            try:
                c.has_config_ui = bool(inst.has_config_ui())
            except Exception:
                c.has_config_ui = False
            if ctype == "resource-texture":
                try:
                    with _scope(key, ctype, name):
                        c.textures = _texture_files(root, str(inst.get_texture_dir()))
                except Exception as e:
                    c.texture_error = _exc_text(e)
            p.caps.append(c)
    except BaseException as e:
        _drop_paths(p)
        msg = str(e) if isinstance(e, RuntimeError) else f"Plugin capability materialization failed: {_exc_text(e)}"
        raise RuntimeError(msg) from e

    PLUGINS[key] = p
    # 9. on_load
    for c in p.caps:
        try:
            with _scope(key, c.type, c.name):
                c.inst.on_load()
            c.loaded = True
        except BaseException as e:
            unload(key)
            raise RuntimeError(f"Plugin on_load failed: {_exc_text(e)}") from e
    return json.dumps(_caps_info(p))


def _drop_paths(p):
    for d in p.paths:
        while d in sys.path:
            sys.path.remove(d)


async def _install_deps(deps):
    import micropip
    _host.setTrusted(True)
    try:
        await micropip.install(deps, keep_going=True)
    finally:
        _host.setTrusted(False)


def unload(key):
    """plugin unload: cancel script runs, on_unload() every capability that got on_load(), release the module."""
    p = PLUGINS.pop(key, None)
    if not p:
        return
    for task in list(p.runs.values()):
        task.cancel()
    for c in p.caps:
        if c.loaded:
            try:
                with _scope(key, c.type, c.name):
                    c.inst.on_unload()
            except BaseException as e:
                _log("warn", f"Plugin on_unload failed: {_exc_text(e)}", key)
    # Windows of the plugin go away silently (no on_close), as PluginHostUi::close_windows_for_plugin.
    for hid, h in list(_ui._HANDLES.items()):
        if h["scope"] and h["scope"][0] == key:
            if h["open"]:
                _bridge.post("ui.close", handle=hid, silent=True)
            del _ui._HANDLES[hid]
    for m in p.modules:
        _remove_module_tree(m)
    _drop_paths(p)
    for ident in [i for i in _bridge.CONFIGS if i[0] == key]:
        del _bridge.CONFIGS[ident]


def set_enabled(key, ctype, name, enabled):
    c = _find(key, ctype, name, only_enabled=False)
    if c:
        c.enabled = bool(enabled)


def set_grants(key, grants_json):
    p = PLUGINS.get(key)
    if p:
        p.grants = json.loads(grants_json)


def set_configs(entries_json):
    """The host pushes effective configs: [[key, type, name, config_json, version], ...] (replaces all)."""
    _bridge.CONFIGS.clear()
    for key, ctype, name, cfg, version in json.loads(entries_json):
        _bridge.CONFIGS[(key, ctype, name)] = (cfg, version)


def config_ui(key, ctype, name):
    c = _find(key, ctype, name, only_enabled=False)
    if not c:
        raise RuntimeError("Capability is not loaded")
    with _scope(key, ctype, name):
        html = c.inst.get_config_ui() if c.has_config_ui else ""
    return html if isinstance(html, str) else ""


def page_ui(key, ctype, name):
    """PluginPage::page_html: get_ui() once per show (an exception means no page)."""
    c = _find(key, "pages", name)
    if not c:
        raise RuntimeError("Page capability is not loaded")
    with _scope(key, "pages", name):
        html = c.inst.get_ui()
    if not isinstance(html, str):
        raise TypeError("get_ui() must return a str")
    return html


def page_message(key, name, data_json):
    """The page posted (window.orca.postMessage): on_message(data), exceptions logged."""
    c = _find(key, "pages", name)
    if not c:
        return
    try:
        with _scope(key, "pages", name):
            r = c.inst.on_message(json.loads(data_json) if data_json else None)
            if inspect.iscoroutine(r):
                asyncio.ensure_future(r)
    except BaseException as e:
        _log("error", f"on_message raised: {''.join(traceback.format_exception(e))}", key)


def default_config(key, ctype, name):
    c = _find(key, ctype, name, only_enabled=False)
    if not c:
        raise RuntimeError("Capability is not loaded")
    with _scope(key, ctype, name):
        v = c.inst.get_default_config()
    if isinstance(v, str):
        v = json.loads(v) if v.strip() else {}
    return json.dumps(v)


# ---- Script -------------------------------------------------------------------------------

def _result_json(r):
    if not isinstance(r, orca.ExecutionResult):
        raise TypeError(f"Unable to cast Python instance of type {type(r)} to C++ type 'ExecutionResult'")
    return {"status": r.status.name if isinstance(r.status, orca.PluginResult) else str(r.status),
            "message": str(r.message), "data": str(r.data)}


async def run_script(run_id, key, name):
    """Run a Script capability. Returns {result|error|cancelled} as JSON (ScriptCompletion)."""
    c = _find(key, "script", name)
    if not c:
        return json.dumps({"cancelled": False, "error": ""})
    p = PLUGINS[key]
    try:
        with _scope(key, "script", name):
            r = c.inst.execute()
            if inspect.iscoroutine(r):
                task = asyncio.ensure_future(r)
                p.runs[run_id] = task
                try:
                    r = await task
                finally:
                    p.runs.pop(run_id, None)
        return json.dumps({"cancelled": False, "result": _result_json(r)})
    except asyncio.CancelledError:
        return json.dumps({"cancelled": True})
    except KeyboardInterrupt:
        return json.dumps({"cancelled": True})
    except BaseException as e:
        _log("error", "".join(traceback.format_exception(e)), key)
        return json.dumps({"cancelled": False, "error": _exc_text(e)})


def cancel_scripts(key):
    p = PLUGINS.get(key)
    if p:
        for task in list(p.runs.values()):
            task.cancel()


# ---- UI events and lifecycle --------------------------------------------------------------

def ui_event(hid, kind, data_json):
    h = _ui._HANDLES.get(hid)
    if not h:
        return
    data = json.loads(data_json) if data_json else None
    scope = h["scope"]
    try:
        if scope:
            with _scope(*scope):
                r = _ui._dispatch(hid, kind, data)
        else:
            r = _ui._dispatch(hid, kind, data)
        if kind == "click" and r is True:
            _bridge.post("ui.close", handle=hid)
        if inspect.iscoroutine(r):
            asyncio.ensure_future(r)
    except BaseException as e:
        _log("error", f"orca.host.ui on_{kind} handler raised: {''.join(traceback.format_exception(e))}", scope[0] if scope else None)


def lifecycle(event, ctx_json):
    """Broadcast to every loaded, enabled capability; exceptions are logged and swallowed."""
    ev = orca.LifecycleEvent[event]
    ctx = orca.LifecycleEventContext._from(json.loads(ctx_json))
    for p in list(PLUGINS.values()):
        for c in p.caps:
            if not c.enabled:
                continue
            try:
                with _scope(p.key, c.type, c.name):
                    c.inst.on_lifecycle_event(ev, ctx)
            except BaseException as e:
                _log("error", f"on_lifecycle_event({event}) raised: {_exc_text(e)}", p.key)


# ---- psGCodePostProcess ---------------------------------------------------------------------

_pp_seq = 0


class PostProcessError(Exception):
    pass


def post_process(caps_json, gcode, host, output_name, full_config_json):
    """Run the selected slicing-pipeline capabilities at Step.psGCodePostProcess on a working copy.
    Returns the processed bytes. Raises PostProcessError with OrcaSlicer's messages."""
    global _pp_seq
    _pp_seq += 1
    folder = f"/orca/tmp/pp/{_pp_seq}"
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/{os.path.basename(output_name) or 'output.gcode'}"
    if hasattr(gcode, "to_bytes"):
        gcode = gcode.to_bytes()
    with open(path, "wb") as f:
        f.write(gcode)
    os.environ["SLIC3R_PP_OUTPUT_NAME"] = output_name
    full = json.loads(full_config_json)
    version = getattr(orca, "_ORCA_VERSION", "2.5.0")
    try:
        for entry in json.loads(caps_json):
            key, name = entry["id"]["pluginKey"], entry["id"]["name"]
            c = _find(key, "slicing-pipeline", name)
            if not c:
                continue  # execute_capabilities_from_refs skips what it cannot resolve
            ctx = orca.slicing.SlicingPipelineContext(orca.slicing.Step.psGCodePostProcess, orca_version=version,
                                                      gcode_path=path, host=host, output_name=output_name, config=full)
            try:
                with _scope(key, "slicing-pipeline", name, scoped_root=folder,
                            config=(json.dumps(entry.get("config", {})), entry.get("configVersion", ""))):
                    r = c.inst.execute(ctx)
                    if inspect.iscoroutine(r):
                        r.close()
                        raise TypeError("Unable to cast Python instance of type <class 'coroutine'> to C++ type 'ExecutionResult'")
                    res = _result_json(r)
            except BaseException as e:
                _log("error", "".join(traceback.format_exception(e)), key)
                raise PostProcessError(f"Post-processing plugin {name} raised an exception.\nError: {_exc_text(e)}")
            if res["status"] in ("RecoverableError", "FatalError"):
                raise PostProcessError(f"Post-processing plugin {name} failed.\nError: {res['message']}")
            if res["message"]:
                _log("info", f"Post-processing plugin {name}: {res['message']}", key)
            if not os.path.exists(path):
                raise PostProcessError(
                    f"Post-processing plugin {name} failed.\n\nThe post-processing plugin is expected to modify the G-code "
                    f"file {path} in place, but the G-code file was deleted.\nPlease check the plugin implementation.\n")
        with open(path, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


# ---- slicing-pipeline hooks (the 12 in-slicer steps) ------------------------------------------

def _resolve_pipeline(name, manifest):
    """PluginHooks.cpp: a capability name, resolved through the "plugins" manifest
    ("<name or plugin_key>;<cloud uuid>;<capability>") when it names one, else any loaded one."""
    refs = [m.split(";") for m in manifest if isinstance(m, str) and m.count(";") >= 2]
    wanted = [r[0] for r in refs if r[2] == name]
    for p in PLUGINS.values():
        if wanted and p.key not in wanted and p.desc.get("name") not in wanted:
            continue
        c = _find(p.key, "slicing-pipeline", name)
        if c is not None:
            return p, c
    return None, None


def run_pipeline(begin_json):
    """One engine hook: run the selected capabilities at this step, in order. Returns the result
    JSON for Module.csHook ({status, capability, message}) or "null" (success, nothing to say)."""
    from orca.host import _graph
    import orca.slicing as slicing
    b = json.loads(begin_json)
    try:
        step = slicing.Step[b["step"]]
    except KeyError:
        return json.dumps({"status": "Exception", "capability": "", "message": f"unknown step {b.get('step')!r}"})
    messages = []
    for name in b.get("capabilities") or []:
        p, c = _resolve_pipeline(name, b.get("plugins") or [])
        if c is None:
            continue  # execute_capabilities_from_refs skips what it cannot resolve
        hook = _graph.begin_hook(b)
        t_hook = _bridge.IN_PIPELINE_HOOK.set(True)
        t_sf = slicing.SCALING_FACTOR.set(float(b.get("scalingFactor") or 1e-6))
        try:
            obj = hook.print._obj(b["objectId"]) if b.get("objectId") is not None else None
            ctx = slicing.SlicingPipelineContext(step, orca_version=str(b.get("orcaVersion", "")), print=hook.print, object=obj,
                                                 cancelled=_bridge.hook_cancelled)
            with _scope(p.key, "slicing-pipeline", name):
                r = c.inst.execute(ctx)
                if inspect.iscoroutine(r):
                    r.close()
                    raise TypeError("Unable to cast Python instance of type <class 'coroutine'> to C++ type 'ExecutionResult'")
                res = _result_json(r)
                _graph.flush_all()   # in-place edits reach the engine before the hook returns
        except (KeyboardInterrupt, _bridge.HookCancelled):
            return json.dumps({"status": "Cancelled", "capability": name, "message": ""})
        except BaseException as e:
            _log("error", f"[{b['step']}] " + "".join(traceback.format_exception(e)), p.key)
            return json.dumps({"status": "Exception", "capability": name, "message": _exc_text(e)})
        finally:
            slicing.SCALING_FACTOR.reset(t_sf)
            _bridge.IN_PIPELINE_HOOK.reset(t_hook)
            _graph.end_hook()
        if res["status"] == "FatalError":
            return json.dumps({"status": "FatalError", "capability": name, "message": res["message"]})
        if res["message"]:
            _log("info", f"{name} [{b['step']}]: {res['message']}", p.key)
            messages.append((name, res["message"]))
    if not messages:
        return "null"
    return json.dumps({"status": "Success", "capability": ", ".join(n for n, _ in messages),
                       "message": " | ".join(m for _, m in messages)})


def safe_run_pipeline(begin_json):
    try:
        return run_pipeline(begin_json)
    except BaseException as e:
        return json.dumps({"status": "Exception", "capability": "", "message": _exc_text(e)})


# ---- the audit hook (PluginAuditManager) ------------------------------------------------------

_CATEGORIES = {}
for _n in ("glob.glob", "glob.glob/2", "os.fwalk", "os.getxattr", "os.listdir", "os.listdrives", "os.listmounts",
           "os.listvolumes", "os.listxattr", "os.scandir", "os.walk", "pathlib.Path.glob", "pathlib.Path.rglob"):
    _CATEGORIES[_n] = "FsRead"
for _n in ("os.chflags", "os.chmod", "os.chown", "os.removexattr", "os.rename", "os.setxattr", "os.truncate", "os.utime",
           "shutil.chown", "shutil.copymode", "shutil.copystat", "shutil.copyfile", "shutil.copytree",
           "shutil.make_archive", "shutil.move", "shutil.unpack_archive"):
    _CATEGORIES[_n] = "FsReadWrite"
for _n in ("os.link", "os.mkdir", "os.symlink", "tempfile.mkdtemp", "tempfile.mkstemp"):
    _CATEGORIES[_n] = "FsCreate"
for _n in ("os.remove", "os.rmdir", "shutil.rmtree"):
    _CATEGORIES[_n] = "FsDelete"
for _n in ("http.client.connect", "http.client.send", "urllib.Request"):
    _CATEGORIES[_n] = "Http"
for _n in ("socket.__new__", "socket.bind", "socket.connect", "socket.getaddrinfo", "socket.gethostbyaddr",
           "socket.gethostbyname", "socket.gethostname", "socket.getnameinfo", "socket.getservbyname",
           "socket.getservbyport", "socket.sendmsg", "socket.sendto"):
    _CATEGORIES[_n] = "Socket"
for _n in ("os.fork", "os.forkpty", "os.posix_spawn", "os.spawn", "os.system", "os.startfile", "os.startfile/2",
           "pty.spawn", "subprocess.Popen", "_posixsubprocess.fork_exec"):
    _CATEGORIES[_n] = "ProcessCreate"
_CATEGORIES["os.exec"] = "ProcessReplace"
_CATEGORIES["_thread.start_new_thread"] = "Threading"
del _n

_KEYWORDS = ("secret", "secrets", "cert", "certs", "certificate", "certificates", "conf", "config")
_in_audit = False


def _denied_path(path):
    base = os.path.basename(path)
    if base.startswith(".install_state.json"):
        return True
    scope = path[len(DATA_DIR):] if path == DATA_DIR or path.startswith(DATA_DIR + "/") else path
    for comp in scope.split("/"):
        lc = comp.lower()
        if not lc:
            continue
        if lc in _KEYWORDS or lc.endswith((".conf", ".ini")):
            return True
    return False


def _under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def _grant_matches(grants, path):
    for g in grants:
        if g.endswith("/*"):
            if _under(path, g[:-2] or "/"):
                return True
        elif g == path:
            return True
    return False


def _deny(event, reason, target, category, persistable, key, cap):
    if _host is not None:
        _host.permissionDenied(key, cap, category, event, target, persistable,
                               f'Plugin attempted audited operation "{event}" without permission'
                               + (f": {reason}" if reason else "") + (f": {target}" if target else ""))
    raise PermissionError(f'Plugin attempted audited operation "{event}" without permission'
                          + (f": {reason}" if reason else "") + (f": {target}" if target else ""))


def _check_fs(event, path, write, category, key, cap, grants):
    if not isinstance(path, (str, bytes, os.PathLike)):
        return
    path = os.path.abspath(os.fsdecode(path))
    if _denied_path(path):
        _deny(event, "the path is protected", path, category, False, key, cap)
    if _under(path, DATA_DIR) or (_under(path, "/tmp")):
        return
    root = _bridge.SCOPED_ROOT.get()
    if root and _under(path, root):
        return
    if not write and (_under(path, RESOURCES_DIR) or any(_under(path, d) for d in STDLIB_DIRS)
                      or _under(path, "/dev") or _under(path, "/proc")):
        return
    if grants.get("full_access"):
        return
    if _grant_matches(grants.get("fs_readwrite", []), path) or (not write and _grant_matches(grants.get("fs_read", []), path)):
        return
    _deny(event, "", path, category, category in ("FsRead", "FsReadWrite"), key, cap)


def _audit(event, args):
    global _in_audit
    if _in_audit:
        return
    cur = _bridge.CURRENT.get()
    if cur is None:
        return
    if event == "open":
        category = "Open"
    else:
        category = _CATEGORIES.get(event)
        if category is None:
            return
    _in_audit = True
    try:
        key, _ctype, cap = cur
        p = PLUGINS.get(key)
        grants = p.grants if p else {}
        if category == "Threading":
            raise RuntimeError("Threads are not available in CubbySlicer's browser Python runtime; use async def execute")
        if category in ("ProcessCreate", "ProcessReplace"):
            _deny(event, "starting programs is not possible in the browser", "", category, False, key, cap)
        if category == "Socket":
            _deny(event, "raw sockets are not available in the browser", str(args[0]) if args else "", category, False, key, cap)
        if category == "Http":
            # Real requests go through the network gate (fetch / XMLHttpRequest); this only attributes urllib.
            return
        if category == "Open":
            path, mode, flags = (list(args) + [None, None, 0])[:3]
            write = bool(mode and any(ch in mode for ch in "wax+")) or bool(isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            _check_fs(event, path, write, "FsReadWrite" if write else "FsRead", key, cap, grants)
            return
        if category == "FsRead":
            _check_fs(event, args[0] if args else ".", False, category, key, cap, grants)
            return
        targets = [a for a in args[:2] if isinstance(a, (str, bytes, os.PathLike))] if category == "FsReadWrite" else args[:1]
        for t in targets:
            _check_fs(event, t, True, category, key, cap, grants)
    finally:
        _in_audit = False


def install():
    os.makedirs(PLUGINS_DIR + "/plugin_data", exist_ok=True)
    os.makedirs(RESOURCES_DIR, exist_ok=True)
    os.makedirs("/orca/tmp", exist_ok=True)
    sys.addaudithook(_audit)


# ---- entry points for the worker: errors come back as data, not exceptions ------------------

async def safe_load(desc_json, enable_json, grants_json, skip_deps):
    try:
        return json.dumps({"ok": True, "caps": json.loads(await load(desc_json, enable_json, grants_json, skip_deps))})
    except BaseException as e:
        tb = "".join(traceback.format_exception(e))
        return json.dumps({"ok": False, "error": str(e) if isinstance(e, RuntimeError) else _exc_text(e), "traceback": tb})


def safe_post_process(caps_json, gcode, host, output_name, full_config_json):
    try:
        return post_process(caps_json, gcode, host, output_name, full_config_json), ""
    except PostProcessError as e:
        return None, str(e)
    except BaseException as e:
        return None, _exc_text(e)


def safe_call(fn, *args):
    try:
        return json.dumps({"ok": True, "value": fn(*args)})
    except BaseException as e:
        return json.dumps({"ok": False, "error": str(e) if isinstance(e, RuntimeError) else _exc_text(e)})
