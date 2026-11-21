"""Preview the web app locally:  .venv\\Scripts\\python scripts\\serve.py [folder] [port]

Python's built-in server takes MIME types from the Windows registry, which often says .js is text/plain;
browsers refuse to run modules served that way. This sets the types explicitly.
"""
import functools
import http.server
import sys
from pathlib import Path

TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
         ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
         ".html": "text/html; charset=utf-8"}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}


if __name__ == "__main__":
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "web"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
    print(f"Serving {folder} at http://127.0.0.1:{port}/")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(folder))).serve_forever()
