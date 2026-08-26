#!/usr/bin/env python3

"""SnowFlake Windows desktop launcher.

The application keeps the existing HTTP/API implementation, but binds it to a
random loopback port and renders it inside an embedded WebView2 window.
"""

import argparse
import ctypes
import json
import os
import sys
import threading
import traceback
import urllib.request
from pathlib import Path

import snowflake as sf


APP_NAME = "SnowFlake"
MUTEX_NAME = "Local\\SnowFlakeDesktop-8F879174-27DD-4E26-8AF5-07F096B6E22B"
_MUTEX_HANDLE = None


def executable_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def app_state_dir():
    """Keep the launcher state beside the EXE for portable deployments."""
    return executable_dir()


def acquire_single_instance():
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    kernel32 = ctypes.windll.kernel32
    _MUTEX_HANDLE = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not _MUTEX_HANDLE:
        return False
    return kernel32.GetLastError() != 183


def message_box(message, title=APP_NAME, error=False):
    if os.name == "nt":
        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, str(message), str(title), flags)
    else:
        print("%s: %s" % (title, message), file=sys.stderr)


def database_state_path():
    return app_state_dir() / ".snowflake-desktop.json"


def load_database_directory():
    try:
        value = json.loads(database_state_path().read_text(encoding="utf-8"))
        configured = value.get("database_directory")
        if configured:
            return Path(configured).expanduser().resolve()
        # Migrate the short-lived V2.2.2 configuration format in place.
        legacy = value.get("database")
        return Path(legacy).expanduser().resolve().parent if legacy else None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def save_database_directory(directory):
    try:
        state_path = database_state_path()
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(
            {"database_directory": str(Path(directory).resolve())}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        os.replace(temporary, state_path)
        return True
    except OSError:
        return False


def is_sqlite_database(path):
    try:
        with Path(path).open("rb") as handle:
            return handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def resolve_paths(args):
    runtime_dir = executable_dir()
    if args.db:
        database = Path(args.db).expanduser().resolve()
    else:
        database_dir = load_database_directory() or runtime_dir
        database = database_dir / "snowflake.db"
    database = Path(database).expanduser().resolve()
    runtime_dir.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    return runtime_dir, database


def switch_database_directory(directory):
    database_dir = Path(directory).expanduser().resolve()
    database_dir.mkdir(parents=True, exist_ok=True)
    database = database_dir / "snowflake.db"
    if database.exists() and not is_sqlite_database(database):
        raise ValueError("所选目录中的 snowflake.db 不是有效的 SQLite 数据库")
    with sf.WRITE_LOCK:
        if database.exists():
            sf.init_database(str(database))
        else:
            sf.configure_database(str(database))
    if not save_database_directory(database_dir):
        raise OSError("无法在 EXE 所在目录保存数据库目录配置")
    return {"ok": True, "directory": str(database_dir), "database": str(database),
            "exists": database.exists()}


def load_window_state(path):
    defaults = {"width": 1280, "height": 820, "x": None, "y": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        defaults["width"] = max(900, min(3840, int(value.get("width", defaults["width"]))))
        defaults["height"] = max(640, min(2160, int(value.get("height", defaults["height"]))))
        if value.get("x") is not None:
            defaults["x"] = int(value["x"])
        if value.get("y") is not None:
            defaults["y"] = int(value["y"])
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return defaults


def save_window_state(path, window):
    try:
        value = {
            "width": int(window.width), "height": int(window.height),
            "x": int(window.x), "y": int(window.y),
        }
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    except (AttributeError, OSError, TypeError, ValueError):
        pass


class DesktopApi:
    def __init__(self, runtime_dir, database):
        self.runtime_dir = Path(runtime_dir)
        self.database = Path(database)
        self.window = None

    def open_data_folder(self):
        if os.name == "nt":
            os.startfile(str(self.database.parent))
            return True
        return False

    def choose_database_directory(self):
        if self.window is None:
            raise RuntimeError("桌面窗口尚未就绪")
        selected = self.window.create_file_dialog(20, directory=str(self.database.parent))
        if not selected:
            return None
        directory = selected[0] if isinstance(selected, (list, tuple)) else selected
        result = switch_database_directory(directory)
        self.database = Path(result["database"])
        return result

    def app_info(self):
        return {"version": sf.APP_VERSION, "database": str(self.database),
                "data_dir": str(self.runtime_dir)}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="SnowFlake 桌面创作工作台")
    parser.add_argument("--db", help="使用指定的 SQLite 数据库")
    parser.add_argument("--portable", action="store_true", help="兼容参数（桌面版默认已使用 EXE 目录）")
    parser.add_argument("--debug", action="store_true", help="启用桌面窗口调试模式")
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def run_desktop(args):
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("缺少桌面运行组件 pywebview，请先执行桌面版构建脚本。") from exc

    runtime_dir, database = resolve_paths(args)
    log_path = runtime_dir / "snowflake-desktop.log"
    sf.DESKTOP_MODE = True
    sf.RUNTIME_DIR = str(runtime_dir)
    if database.exists():
        if not is_sqlite_database(database):
            raise RuntimeError("当前 snowflake.db 不是有效的 SQLite 数据库")
        sf.init_database(str(database))
    else:
        sf.configure_database(str(database))
    sf.load_runtime_settings()
    server = sf.create_http_server("127.0.0.1", 0)
    server_thread = threading.Thread(target=server.serve_forever, name="SnowFlakeHTTP", daemon=True)
    server_thread.start()

    state_path = runtime_dir / "window.json"
    state = load_window_state(state_path)
    api = DesktopApi(runtime_dir, database)
    url = "http://127.0.0.1:%d/" % sf.PORT
    # WebView2 may suspend rendering for a window placed far off-screen, so the
    # hidden build check uses a small on-screen position and closes immediately.
    window_x = 40 if args.smoke_test else state["x"]
    window_y = 40 if args.smoke_test else state["y"]
    window = webview.create_window(
        "SnowFlake · 雪花写作法工作台", url=url, js_api=api,
        width=state["width"], height=state["height"], x=window_x, y=window_y,
        min_size=(900, 640), background_color="#f4f8f2",
    )
    api.window = window

    def on_closing(*_):
        save_window_state(state_path, window)

    window.events.closing += on_closing

    smoke_timer = None
    if args.smoke_test:
        with urllib.request.urlopen(url, timeout=10) as response:
            home_page = response.read().decode("utf-8")
        with urllib.request.urlopen(url + "api/config", timeout=10) as response:
            config = json.loads(response.read().decode("utf-8"))
        if "app.js" not in home_page or "flow.js" not in home_page:
            raise RuntimeError("桌面静态资源验证失败")
        if not config.get("desktop") or config.get("app_version") != sf.APP_VERSION:
            raise RuntimeError("桌面服务配置验证失败")
        # The build runner cannot observe GUI lifecycle events reliably. Keeping
        # WebView2 alive for five seconds still catches backend/import failures.
        smoke_timer = threading.Timer(5, lambda: os._exit(0))
        smoke_timer.daemon = True
        smoke_timer.start()

    try:
        webview.start(debug=args.debug, gui="edgechromium", private_mode=False,
                      storage_path=str(runtime_dir / "webview"))
    except Exception:
        log_path.write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        if smoke_timer:
            smoke_timer.cancel()
        server.shutdown()
        server.server_close()
    return database


def main(argv=None):
    if not acquire_single_instance():
        message_box("SnowFlake 已经在运行。", error=False)
        return 0
    args = parse_args(argv)
    try:
        run_desktop(args)
        return 0
    except Exception as exc:
        if args.smoke_test:
            print("SnowFlake smoke test failed: %s" % exc, file=sys.stderr)
        else:
            message_box("SnowFlake 启动失败：\n\n%s" % exc, error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
