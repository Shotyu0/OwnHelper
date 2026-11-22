"""What ended an idle stretch: diagnostics for the AFK logic (logged to data/helper.log).

Windows' idle timer (GetLastInputInfo, used for AFK and desk nudges) says *that* there was keyboard/mouse input,
not *where it came from*. Raw Input does: each event carries the device it came from, or no device when software
sent it (SendInput: macro tools, remote desktop, etc.). This watcher is armed only after a few seconds without
input, so a game being played never pays for it. The first input after that is summarised for ~2 s (how many
events, how far the mouse moved, keys or not; never *which* keys), then it disarms.

A 1-count mouse move with nothing after it is sensor jitter; hundreds of events and a big move is a person.
"""
from __future__ import annotations

import ctypes
import logging
import re
import sys
import threading
import time
from ctypes import wintypes

log = logging.getLogger("guardian")

WM_TIMER, WM_INPUT, WM_APP_ARM = 0x0113, 0x00FF, 0x8001
RIDEV_REMOVE, RIDEV_INPUTSINK = 0x1, 0x100
RID_INPUT, RIDI_DEVICENAME = 0x10000003, 0x20000007
RIM_TYPEMOUSE, RIM_TYPEKEYBOARD = 0, 1
HWND_MESSAGE = -3
SUMMARY_S = 2.0          # watch this long after the first event, then summarise
LOG_AFTER_S = 60         # log stretches at least this idle (the guardian lowers it during a game session)


class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [("usUsagePage", wintypes.USHORT), ("usUsage", wintypes.USHORT),
                ("dwFlags", wintypes.DWORD), ("hwndTarget", wintypes.HWND)]


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [("dwType", wintypes.DWORD), ("dwSize", wintypes.DWORD),
                ("hDevice", wintypes.HANDLE), ("wParam", wintypes.WPARAM)]


class RAWMOUSE(ctypes.Structure):
    _fields_ = [("usFlags", wintypes.USHORT), ("_pad", wintypes.USHORT),
                ("usButtonFlags", wintypes.USHORT), ("usButtonData", wintypes.USHORT),
                ("ulRawButtons", wintypes.ULONG), ("lLastX", wintypes.LONG), ("lLastY", wintypes.LONG),
                ("ulExtraInformation", wintypes.ULONG)]


class RAWKEYBOARD(ctypes.Structure):
    _fields_ = [("MakeCode", wintypes.USHORT), ("Flags", wintypes.USHORT), ("Reserved", wintypes.USHORT),
                ("VKey", wintypes.USHORT), ("Message", wintypes.UINT), ("ExtraInformation", wintypes.ULONG)]


LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


def _user32():
    u = ctypes.WinDLL("user32", use_last_error=True)      # own instance: argtypes here don't leak elsewhere
    u.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.DefWindowProcW.restype = LRESULT
    u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                  ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                  wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
    u.CreateWindowExW.restype = wintypes.HWND
    u.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
    u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.GetRawInputData.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPVOID,
                                  ctypes.POINTER(wintypes.UINT), wintypes.UINT]
    u.GetRawInputData.restype = wintypes.UINT
    u.GetRawInputDeviceInfoW.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPVOID,
                                         ctypes.POINTER(wintypes.UINT)]
    u.GetRawInputDeviceInfoW.restype = wintypes.UINT
    u.RegisterRawInputDevices.argtypes = [ctypes.POINTER(RAWINPUTDEVICE), wintypes.UINT, wintypes.UINT]
    u.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, wintypes.LPVOID]
    u.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
    return u


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _idle_s() -> float:
    li = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO))
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li)):
        return 0.0
    return ((ctypes.windll.kernel32.GetTickCount() - li.dwTime) & 0xFFFFFFFF) / 1000.0


def device_label(path: str) -> str:
    """\\\\?\\HID#VID_046D&PID_C547&MI_01&Col01#... -> 'VID_046D&PID_C547 MI_01'"""
    m = re.search(r"VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:&MI_(\d+))?", path, re.I)
    if not m:
        return path.split("#")[1] if "#" in path else (path or "?")
    return f"VID_{m[1]}&PID_{m[2]}".upper() + (f" MI_{m[3]}" if m[3] else "")


def fmt_idle(s: float) -> str:
    s = int(s)
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


class Presence:
    """When you were last really at the PC, for AFK and the set prompt's countdown.

    Windows' idle timer resets on any input, including fake input from programs: AION 2 sends a zero-move mouse
    event every 50 s while it runs (seen 2026-11-22), so the timer never got past 50 s and AFK never triggered.
    A person at the PC makes input at several moments in a row; a keep-awake event (or a bumped mouse) is one
    moment. So an input counts only when another comes within PAIR_S of it. Sampled from the idle timer every half
    second; Raw Input can't do this job, since a game running as administrator hides it from us while in front.
    """
    PAIR_S = 4.0     # two separate inputs this close together: you
    SAME_S = 0.3     # closer than this is one moment (a click's down+up, sampling jitter)

    def __init__(self, now: float, idle: float):
        self.seen = self.real = now - idle    # newest input instant seen / newest that counts

    def sample(self, now: float, idle: float) -> None:
        last = now - idle
        if last <= self.seen + self.SAME_S:
            return
        if last - self.seen <= self.PAIR_S:
            self.real = last
        self.seen = last

    def idle(self, now: float) -> float:
        return max(0.0, now - self.real)


class Burst:
    """Input seen in the first SUMMARY_S after an idle stretch."""

    def __init__(self):
        self.mouse = self.move = self.buttons = self.keys = self.media = self.injected = 0
        self.devices: dict[str, int] = {}

    def add(self, kind: str, device: str | None, move: int = 0, buttons: bool = False, media: bool = False):
        self.devices[device or "software"] = self.devices.get(device or "software", 0) + 1
        self.injected += device is None
        if kind == "mouse":
            self.mouse += 1
            self.move += move
            self.buttons += buttons
        else:
            self.keys += 1
            self.media += media

    def text(self) -> str:
        parts = []
        if self.mouse:
            parts.append(f"mouse ×{self.mouse} (moved {self.move}" + (f", {self.buttons} click/wheel" if self.buttons else "") + ")")
        if self.keys:
            parts.append(f"key events ×{self.keys}" + (f" ({self.media} media/volume)" if self.media else ""))
        devs = ", ".join(f"{d} ×{n}" for d, n in sorted(self.devices.items(), key=lambda x: -x[1]))
        return f"{'; '.join(parts) or 'nothing'} from {devs}" + (" [software-sent]" if self.injected else "")


class InputWatch:
    def __init__(self):
        self.hwnd = None
        self.armed = False             # waiting for the first input of a new burst
        self.idle_start = 0.0          # wall time of the last input before this idle stretch
        self.log_after = LOG_AFTER_S   # seconds idle worth a log line
        self.last: dict | None = None  # {"at", "idle", "text"} of the last summarised burst
        self._burst: Burst | None = None
        self._burst_at = 0.0
        self._names: dict[int, str] = {}
        self._u = None
        self._proc = None

    def start(self) -> None:
        if sys.platform == "win32":
            threading.Thread(target=self._run, daemon=True, name="input-watch").start()

    def arm(self, idle_seconds: float) -> None:
        """Called on the guardian's tick while there's been no input for a while."""
        if self.hwnd and not self.armed and self._burst is None:
            self.armed, self.idle_start = True, time.time() - idle_seconds
            self._u.PostMessageW(self.hwnd, WM_APP_ARM, 0, 0)

    # ---------------------------------------------------------------- input thread
    def _run(self) -> None:
        try:
            u = self._u = _user32()
            self._proc = WNDPROC(self._wndproc)
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.GetModuleHandleW.restype = wintypes.HMODULE
            hinst = k32.GetModuleHandleW(None)
            wc = WNDCLASSW(lpfnWndProc=self._proc, hInstance=hinst, lpszClassName="PersonalHelperInputWatch")
            u.RegisterClassW(ctypes.byref(wc))
            hwnd = u.CreateWindowExW(0, wc.lpszClassName, "", 0, 0, 0, 0, 0, HWND_MESSAGE, None, hinst, None)
            if not hwnd:
                log.warning("Input watch unavailable (window error %d)", ctypes.get_last_error())
                return
            self.hwnd = hwnd
            msg = wintypes.MSG()
            while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                u.DispatchMessageW(ctypes.byref(msg))
        except Exception:
            log.exception("input watch failed")

    def _register(self, on: bool) -> bool:
        flags, target = (RIDEV_INPUTSINK, self.hwnd) if on else (RIDEV_REMOVE, None)
        devs = (RAWINPUTDEVICE * 2)(RAWINPUTDEVICE(1, 2, flags, target), RAWINPUTDEVICE(1, 6, flags, target))
        return bool(self._u.RegisterRawInputDevices(devs, 2, ctypes.sizeof(RAWINPUTDEVICE)))

    def _wndproc(self, hwnd, msg, wp, lp):
        try:
            if msg == WM_APP_ARM:
                if _idle_s() < 1.0:                   # input came before we were listening: skip this stretch
                    self.armed = False
                elif not self._register(True):
                    self.armed = False
                    log.warning("Input watch: RegisterRawInputDevices failed (%d)", ctypes.get_last_error())
            elif msg == WM_INPUT and (self.armed or self._burst is not None):
                self._on_input(lp)
            elif msg == WM_TIMER:
                self._u.KillTimer(hwnd, 1)
                self._finish()
        except Exception:
            log.exception("input watch event failed")
        return self._u.DefWindowProcW(hwnd, msg, wp, lp)

    def _on_input(self, lp) -> None:
        u, hsize = self._u, ctypes.sizeof(RAWINPUTHEADER)
        size = wintypes.UINT(0)
        u.GetRawInputData(lp, RID_INPUT, None, ctypes.byref(size), hsize)
        buf = ctypes.create_string_buffer(max(size.value, 1))
        if u.GetRawInputData(lp, RID_INPUT, buf, ctypes.byref(size), hsize) == 0xFFFFFFFF:
            return
        hdr = RAWINPUTHEADER.from_buffer(buf)
        if hdr.dwType not in (RIM_TYPEMOUSE, RIM_TYPEKEYBOARD):
            return
        if self._burst is None:                       # first input after the idle stretch
            self.armed = False
            self._burst, self._burst_at = Burst(), time.time()
            u.SetTimer(self.hwnd, 1, int(SUMMARY_S * 1000), None)
        dev = self._device(hdr.hDevice) if hdr.hDevice else None
        if hdr.dwType == RIM_TYPEMOUSE:
            m = RAWMOUSE.from_buffer(buf, hsize)
            self._burst.add("mouse", dev, abs(m.lLastX) + abs(m.lLastY), bool(m.usButtonFlags))
        else:
            k = RAWKEYBOARD.from_buffer(buf, hsize)
            self._burst.add("key", dev, media=0xA6 <= k.VKey <= 0xB7)

    def _finish(self) -> None:
        b, at = self._burst, self._burst_at
        self._register(False)
        self._burst = None
        if b is None:
            return
        idle = at - self.idle_start
        self.last = {"at": at, "idle": idle, "text": b.text()}
        if idle >= self.log_after:
            log.info("Input at %s after %s idle: %s", time.strftime("%H:%M:%S", time.localtime(at)),
                     fmt_idle(idle), b.text())

    def _device(self, h) -> str:
        key = int(h)
        if key not in self._names:
            n = wintypes.UINT(0)
            self._u.GetRawInputDeviceInfoW(h, RIDI_DEVICENAME, None, ctypes.byref(n))
            buf = ctypes.create_unicode_buffer(max(n.value, 1) + 1)
            self._u.GetRawInputDeviceInfoW(h, RIDI_DEVICENAME, buf, ctypes.byref(n))
            self._names[key] = device_label(buf.value)
        return self._names[key]
