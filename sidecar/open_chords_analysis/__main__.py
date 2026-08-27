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
    except Exception as error:
        if isinstance(error, PermissionError):
            failure_code = "sidecar_permission_denied"
        elif isinstance(error, FileNotFoundError):
            failure_code = "sidecar_file_not_found"
        elif isinstance(error, BrokenPipeError):
            failure_code = "sidecar_broken_pipe"
        elif error.__class__.__name__ == "ProtocolError":
            failure_code = "sidecar_protocol_error"
        elif isinstance(error, OSError):
            failure_code = "sidecar_os_error"
        elif isinstance(error, RuntimeError):
            failure_code = "sidecar_runtime_error"
        elif isinstance(error, ValueError):
            failure_code = "sidecar_value_error"
        else:
            failure_code = "sidecar_internal_error"
        sys.stderr.write(f"Open Chords analysis sidecar failed safely: {failure_code}\n")
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
