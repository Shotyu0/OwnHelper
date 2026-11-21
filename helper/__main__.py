"""python -m helper [run|guardian|reader|check]

run       guardian + Korean reader in one process (default; what start.bat / autostart use)
guardian  guardian only
reader    Korean reader only (http://localhost:5057/reader)
check     test the Firebase connection and show what the guardian sees
"""
from __future__ import annotations

import json
import logging
import sys
import threading

from . import config


def _setup_logging() -> None:
    config.DATA_DIR.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(config.DATA_DIR / "helper.log", encoding="utf-8")]
        + ([logging.StreamHandler()] if sys.stdout else []))


def connect():
    """Firestore store for the configured user, or None with the reason logged."""
    c = config.section("cloud")
    sa = config.service_account_path()
    if not c.get("uid"):
        logging.error("config.toml [cloud] uid is empty — copy it from the web app's Settings page.")
        return None
    if not sa.exists():
        logging.error("Service account key not found at %s (see README, 'Firebase setup').", sa)
        return None
    from .cloud import FirestoreStore
    return FirestoreStore(c["uid"], str(sa))


def _fatal(msg: str) -> None:
    logging.error(msg)
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "Personal Helper", 0x10)
    except Exception:
        pass


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    _setup_logging()
    if cmd not in ("run", "guardian", "reader", "check"):
        print(__doc__)
        return
    store = connect()
    if cmd == "check":
        if not store:
            print("Not connected - see data/helper.log")
            return
        from .gaming.rules import Rules
        from .settings import with_defaults
        rules = Rules(store, with_defaults({k: v for k, v in (store.get("meta", "settings") or {}).items() if k != "id"}))
        print(json.dumps(rules.status(), indent=2, default=str))
        return
    if cmd == "reader":
        from .reader.server import run
        run(store)
        return
    if store is None:
        _fatal("Personal Helper can't reach Firebase, so the game guardian isn't running.\n\n"
               "Check config.toml [cloud] and the service account key (README → Firebase setup).")
        return
    from .guardian.app import main as guardian
    if cmd == "run":
        from .reader.server import run
        threading.Thread(target=run, args=(store,), daemon=True, name="reader").start()
    guardian(store)


if __name__ == "__main__":
    main()
