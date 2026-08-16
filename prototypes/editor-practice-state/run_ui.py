#!/usr/bin/env python3
"""Serve and open the throwaway visual editor/practice prototype."""

from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path
import threading
import webbrowser


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-open", action="store_true", help="do not open the browser automatically")
    args = parser.parse_args()

    ui_directory = Path(__file__).resolve().parent / "ui"
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ui_directory)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    url = f"http://127.0.0.1:{server.server_port}/?variant=C"

    print("PROTOTYPE — editor/practice visual review")
    print(url)
    print("Press Ctrl+C to stop.")
    if not args.no_open:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
