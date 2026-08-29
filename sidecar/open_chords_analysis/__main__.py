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
    if not relative.parts:
        return "sidecar_runtime_root_permission_denied"
    if relative.as_posix() == "runtime-manifest.json":
        return "sidecar_runtime_manifest_permission_denied"
    if relative.parts[:1] == ("tools",):
        return "sidecar_runtime_tool_permission_denied"
    return "sidecar_runtime_file_permission_denied"


def main(
    *,
    workspace: Path | None = None,
    windows_runtime_is_current_directory: bool = False,
) -> None:
    freeze_support()

    import sys
    try:
        from .protocol import serve_one_session
        from .runtime_manifest import RuntimeManifestPermissionError, load_frozen_runtime

        if not getattr(sys, "frozen", False):
            raise RuntimeError("source entry point is disabled")
        runtime_root = Path(sys.executable).absolute().parent
        try:
            runtime = load_frozen_runtime(
                runtime_root,
                windows_runtime_is_current_directory=windows_runtime_is_current_directory,
            )
        except RuntimeManifestPermissionError as error:
            permission_codes = {
                "entry_content": "sidecar_runtime_entry_content_permission_denied",
                "entry_metadata": "sidecar_runtime_entry_metadata_permission_denied",
                "inventory": "sidecar_runtime_inventory_permission_denied",
                "manifest": "sidecar_runtime_manifest_permission_denied",
                "root": "sidecar_runtime_root_permission_denied",
            }
            sys.stderr.write(
                "Open Chords analysis sidecar failed safely: "
                f"{permission_codes.get(error.stage, 'sidecar_runtime_file_permission_denied')}\n"
            )
            raise SystemExit(2) from None
        except PermissionError as error:
            sys.stderr.write(
                "Open Chords analysis sidecar failed safely: "
                f"{_runtime_permission_failure_code(error, runtime_root)}\n"
            )
            raise SystemExit(2) from None
        serve_one_session(sys.stdin.buffer, sys.stdout.buffer, workspace or Path.cwd(), runtime)
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
