"""Find running Steam games, close them politely, and kill them if they won't close."""
from __future__ import annotations

import ctypes
import os
import re
import time
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path

import psutil

# Folders under steamapps/common that are tools, not games.
EXCLUDED_DIRS = {"steamworks shared", "steam controller configs", "steamvr"}


@dataclass
class GameProc:
    pid: int
    exe_name: str
    appid: str | None
    title: str


def _steam_root() -> Path | None:
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            p, _ = winreg.QueryValueEx(k, "SteamPath")
            if p and Path(p).exists():
                return Path(p)
    except OSError:
        pass
    for p in (r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"):
        if Path(p).exists():
            return Path(p)
    return None


class SteamLibrary:
    def __init__(self):
        self.commons: list[str] = []            # normcased .../steamapps/common
        self.apps: dict[str, tuple[str, str]] = {}  # normcased installdir path -> (appid, name)
        self.refreshed = 0.0

    def refresh(self) -> None:
        root = _steam_root()
        libs: list[Path] = []
        if root:
            libs.append(root)
            vdf = root / "steamapps" / "libraryfolders.vdf"
            if vdf.exists():
                text = vdf.read_text(encoding="utf-8", errors="replace")
                for m in re.finditer(r'"path"\s+"([^"]+)"', text):
                    libs.append(Path(m.group(1).replace("\\\\", "\\")))
        commons, apps = [], {}
        for lib in {os.path.normcase(str(p)): p for p in libs}.values():
            steamapps = lib / "steamapps"
            common = steamapps / "common"
            if not common.exists():
                continue
            commons.append(os.path.normcase(str(common)))
            for acf in steamapps.glob("appmanifest_*.acf"):
                try:
                    t = acf.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                appid = re.search(r'"appid"\s+"(\d+)"', t)
                name = re.search(r'"name"\s+"([^"]*)"', t)
                inst = re.search(r'"installdir"\s+"([^"]*)"', t)
                if appid and inst:
                    apps[os.path.normcase(str(common / inst.group(1)))] = (
                        appid.group(1), name.group(1) if name else inst.group(1))
        self.commons, self.apps, self.refreshed = commons, apps, time.time()

    def match(self, exe: str) -> tuple[str | None, str] | None:
        """If exe lives inside a Steam game folder, return (appid, game name)."""
        e = os.path.normcase(exe)
        for common in self.commons:
            if e.startswith(common + os.sep):
                top = e[len(common) + 1:].split(os.sep, 1)[0]
                if top in EXCLUDED_DIRS:
                    return None
                return self.apps.get(os.path.join(common, top), (None, top))
        return None


def find_games(lib: SteamLibrary, allow: set[str], extra: set[str],
               allow_apps: set[str] = frozenset()) -> list[GameProc]:
    """allow = exe names to ignore; allow_apps = Steam app names or ids to ignore (all lowercase)."""
    me = os.getpid()
    out = []
    for p in psutil.process_iter(["pid", "name", "exe"]):
        info = p.info
        name = (info.get("name") or "").lower()
        if info["pid"] == me or not name or name in allow:
            continue
        if name in extra:
            out.append(GameProc(info["pid"], name, None, info["name"]))
            continue
        exe = info.get("exe")
        if not exe:
            continue
        m = lib.match(exe)
        if m and m[1].lower() not in allow_apps and (m[0] or "") not in allow_apps:
            out.append(GameProc(info["pid"], name, m[0], m[1]))
    return out


# --------------------------------------------------------------------------- closing
_user32 = ctypes.windll.user32 if os.name == "nt" else None
WM_CLOSE = 0x0010
_EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM) if os.name == "nt" else None


def close_windows(pids: set[int]) -> int:
    """Ask the game's windows to close (like clicking X), so it can save/exit cleanly."""
    if not _user32 or not pids:
        return 0
    sent = 0

    def cb(hwnd, _):
        nonlocal sent
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and _user32.IsWindowVisible(hwnd):
            _user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
            sent += 1
        return True

    _user32.EnumWindows(_EnumProc(cb), 0)
    return sent


def kill(pids: set[int]) -> list[int]:
    """Force-kill. Returns pids that could not be killed (e.g. game runs as administrator)."""
    failed = []
    for pid in pids:
        try:
            psutil.Process(pid).kill()
        except psutil.NoSuchProcess:
            pass
        except psutil.AccessDenied:
            failed.append(pid)
    return failed


def relaunch(appid: str | None) -> None:
    if appid:
        os.startfile(f"steam://rungameid/{appid}")
