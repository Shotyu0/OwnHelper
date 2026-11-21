"""PC-side settings from config.toml (cloud connection, guardian app lists, reader port).

Everything you'd change day to day (schedule, Korean, gaming limits) lives in the web app's Settings page.
"""
from __future__ import annotations

import os
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.toml"
DATA_DIR = Path(os.environ.get("PERSONALHELPER_DATA", ROOT / "data"))

_DEFAULTS = {
    "cloud": {"uid": "", "service_account": "data/service-account.json", "web_url": ""},
    "reader": {"port": 5057},
    "guardian": {"allow_apps": ["Wallpaper Engine"], "allow_exes": [], "extra_game_exes": []},
}

_cache: dict | None = None


def load() -> dict:
    global _cache
    if _cache is None:
        cfg = {k: dict(v) for k, v in _DEFAULTS.items()}
        if CONFIG_PATH.exists():
            with open(CONFIG_PATH, "rb") as f:
                for section, values in tomllib.load(f).items():
                    cfg.setdefault(section, {}).update(values)
        _cache = cfg
    return _cache


def section(name: str) -> dict:
    return load()[name]


def service_account_path() -> Path:
    p = Path(section("cloud")["service_account"])
    return p if p.is_absolute() else ROOT / p
