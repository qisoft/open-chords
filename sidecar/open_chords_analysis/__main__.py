"""Frozen executable entry point."""

from __future__ import annotations

from multiprocessing import freeze_support
from pathlib import Path


def _runtime_permission_failure_code(error: PermissionError, runtime_root: Path) -> str:
    try:
        denied_path = Path(error.filename).resolve(strict=False)
        relative = denied_path.relative_to(runtime_root)
    except (OSError, TypeError, ValueError):
        return "sidecar_runtime_root_permission_denied"
    if relative.as_posix() == "runtime-manifest.json":
        return "sidecar_runtime_manifest_permission_denied"
    if relative.parts[:1] == ("tools",):
        return "sidecar_runtime_tool_permission_denied"
    return "sidecar_runtime_file_permission_denied"


def main() -> None:
    freeze_support()

    import sys
    try:
        from .protocol import serve_one_session
        from .runtime_manifest import load_frozen_runtime

        if not getattr(sys, "frozen", False):
            raise RuntimeError("source entry point is disabled")
        runtime_root = Path(sys.executable).resolve().parent
        try:
            runtime = load_frozen_runtime(runtime_root)
        except PermissionError as error:
            sys.stderr.write(
                "Open Chords analysis sidecar failed safely: "
                f"{_runtime_permission_failure_code(error, runtime_root)}\n"
            )
            raise SystemExit(2) from None
        serve_one_session(sys.stdin.buffer, sys.stdout.buffer, Path.cwd(), runtime)
    except Exception as error:
        if isinstance(error, PermissionError):
            failure_code = "sidecar_session_permission_denied"
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
