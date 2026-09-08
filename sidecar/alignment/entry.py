"""Fixed release-owned probe and contained Alignment worker entry points."""
import json
import os
import sys
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1].startswith("--contained-workspace="):
    workspace = sys.argv.pop(1).split("=", 1)[1]
    if len(sys.argv) != 3 or sys.argv[1] != "--align" or not Path(workspace).is_absolute() or Path(workspace) != Path(sys.argv[2]):
        raise SystemExit(64)

if sys.argv[1:] == ["--probe"]:
    from importlib.metadata import version
    from kalpy.aligner import KalpyAligner
    import pynini
    print(json.dumps({"runtime": "mfa", "version": version("montreal_forced_aligner"), "kalpy": KalpyAligner.__name__, "fst": pynini.Fst().num_states()}))
elif len(sys.argv) == 3 and sys.argv[1] == "--align":
    if getattr(sys, "frozen", False) and Path(sys.executable).stem != "open-chords-alignment-worker":
        raise SystemExit(64)
    scope = "bootstrap"
    try:
        os.chdir(sys.argv[2])
        for key in ["HOME", "USERPROFILE", "MFA_ROOT_DIR", "TMPDIR", "TMP", "TEMP", "NUMBA_CACHE_DIR", "MPLCONFIGDIR"]:
            os.environ[key] = str(Path.cwd() / "temporary")
        Path("temporary").mkdir(exist_ok=True)
        for key in ["OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"]:
            os.environ[key] = "1"
        os.environ["NUMBA_DISABLE_JIT"] = "1"
        from session import serve
        scope = "session"
        serve()
    except Exception as error:
        # No exception messages, paths, media or Reference Lyrics enter diagnostics.
        kind = "permission" if isinstance(error, PermissionError) else "missing_file" if isinstance(error, FileNotFoundError) else "import" if isinstance(error, ImportError) else "os" if isinstance(error, OSError) else "value" if isinstance(error, ValueError) else "internal"
        sys.stderr.write(f"Open Chords Alignment worker failed safely: alignment_{scope}_{kind}\n")
        raise SystemExit(70) from None
else:
    raise SystemExit(64)
