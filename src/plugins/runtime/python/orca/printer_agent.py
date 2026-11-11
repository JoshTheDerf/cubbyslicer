"""Printer Agent API

Printer-connection capabilities load in CubbySlicer and are listed in the
Plugins dialog as not supported: CubbySlicer has no device manager, so the
host never calls them (OrcaSlicer itself only does when "Use printer agents
instead of print hosts" is on).
"""
from ._core import PythonPluginBase, PluginType, _OrcaEnum, _pure


class FilamentSyncMode(_OrcaEnum):
    None_ = 0
    Subscription = 1
    Pull = 2


class CameraStreamMode(_OrcaEnum):
    None_ = 0
    HTTP = 1
    HTTPS = 2
    HTTP_SNAPSHOT = 3
    RTSP = 4


globals().update(FilamentSyncMode.__members__)
globals().update(CameraStreamMode.__members__)


class _Record:
    _FIELDS = {}

    def __init_subclass__(cls, **kw):
        super().__init_subclass__(**kw)
        for k, v in cls._FIELDS.items():
            setattr(cls, k, v)

    def __init__(self, *args, **kwargs):
        for k, v in self._FIELDS.items():
            setattr(self, k, v() if callable(v) else v)
        for k, v in zip(self._FIELDS, args):
            setattr(self, k, v)
        for k, v in kwargs.items():
            if k not in self._FIELDS:
                raise TypeError(f"{type(self).__name__}(): unexpected keyword argument {k!r}")
            setattr(self, k, v)

    def __repr__(self):
        return f"<orca.printer_agent.{type(self).__name__}>"


class AgentInfo(_Record):
    _FIELDS = {"id": "", "name": "", "version": "", "description": ""}


class DetectResult(_Record):
    _FIELDS = {"result_msg": "", "command": "", "dev_id": "", "model_id": "", "dev_name": "", "version": "",
               "bind_state": "", "connect_type": ""}


class PrintParams(_Record):
    _FIELDS = {
        "dev_id": "", "task_name": "", "project_name": "", "preset_name": "", "filename": "", "config_filename": "",
        "plate_index": 0, "ftp_folder": "", "ftp_file": "", "ftp_file_md5": "", "nozzle_mapping": "", "ams_mapping": "",
        "ams_mapping2": "", "ams_mapping_info": "", "nozzles_info": "", "connection_type": "", "comments": "",
        "origin_profile_id": 0, "stl_design_id": 0, "origin_model_id": "", "print_type": "", "dst_file": "",
        "dev_name": "", "dev_ip": "", "use_ssl_for_ftp": False, "use_ssl_for_mqtt": False, "username": "",
        "password": "", "task_bed_leveling": False, "task_flow_cali": False, "task_vibration_cali": False,
        "task_layer_inspect": False, "task_record_timelapse": False, "task_use_ams": False, "task_bed_type": "",
        "task_ext_change_assist": False, "try_emmc_print": False, "auto_bed_leveling": 0, "auto_flow_cali": 0,
        "auto_offset_cali": 0, "extra_options": "",
    }


class PrinterConnectionParams(_Record):
    _FIELDS = {"dev_id": "", "host": "", "port": 0, "username": "", "password": "", "use_ssl": False, "ca_file": ""}


def _agent_pure(name):
    def method(self, *args, **kwargs):
        _pure("IPrinterAgent", name)
    method.__name__ = name
    return method


def _agent_default(name, value):
    def method(self, *args, **kwargs):
        return value
    method.__name__ = name
    return method


class PrinterAgentBase(PythonPluginBase):
    """Implements OrcaSlicer's IPrinterAgent device protocol."""

    def get_type(self):
        return PluginType.PrinterConnection


for _name in ("get_agent_info", "connect_printer", "send_message", "send_message_to_printer", "start_discovery",
              "bind_detect", "get_user_selected_machine", "set_user_selected_machine", "start_send_gcode_to_sdcard",
              "start_local_print", "start_print", "start_local_print_with_record", "start_sdcard_print"):
    setattr(PrinterAgentBase, _name, _agent_pure(_name))
for _name, _value in (("disconnect_printer", -1), ("check_cert", -1), ("install_device_cert", None), ("ping_bind", -1),
                      ("bind", -1), ("unbind", -1), ("command_ams_calibrate", -1), ("command_ams_refresh_rfid", -1),
                      ("command_ams_select_tray", -1), ("command_auto_leveling", -1), ("command_axis_control", -1),
                      ("command_go_home", -1), ("command_set_bed", -1), ("command_set_nozzle", -1),
                      ("command_start_camera", -1), ("command_xyz_abs", -1), ("fetch_filament_info", -1),
                      ("get_camera_stream_mode", CameraStreamMode.None_), ("get_camera_url", ""),
                      ("get_filament_sync_mode", FilamentSyncMode.None_)):
    setattr(PrinterAgentBase, _name, _agent_default(_name, _value))
del _name, _value
