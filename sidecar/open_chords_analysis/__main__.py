"""Frozen executable entry point."""

from __future__ import annotations

from multiprocessing import freeze_support


def main() -> None:
    freeze_support()

    import sys
    from pathlib import Path

    try:
        from .protocol import serve_one_session
        from .runtime_manifest import load_frozen_runtime

        if not getattr(sys, "frozen", False):
            raise RuntimeError("source entry point is disabled")
        runtime_root = Path(sys.executable).resolve().parent
        runtime = load_frozen_runtime(runtime_root)
        serve_one_session(sys.stdin.buffer, sys.stdout.buffer, Path.cwd(), runtime)
    except Exception:
        sys.stderr.write("Open Chords analysis sidecar failed safely\n")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
