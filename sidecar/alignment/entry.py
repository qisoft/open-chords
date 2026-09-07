"""Fixed release-owned probe and contained Alignment worker entry points."""
import json
import os
import sys
from pathlib import Path

if sys.argv[1:] == ["--probe"]:
    from importlib.metadata import version
    from kalpy.aligner import KalpyAligner
    import pynini
    print(json.dumps({"runtime": "mfa", "version": version("montreal_forced_aligner"), "kalpy": KalpyAligner.__name__, "fst": pynini.Fst().num_states()}))
elif len(sys.argv) == 3 and sys.argv[1] == "--align":
    if getattr(sys, "frozen", False) and Path(sys.executable).stem != "open-chords-alignment-worker":
        raise SystemExit(64)
    os.chdir(sys.argv[2])
    for key in ["HOME", "USERPROFILE", "MFA_ROOT_DIR", "TMPDIR", "TMP", "TEMP", "NUMBA_CACHE_DIR", "MPLCONFIGDIR"]:
        os.environ[key] = str(Path.cwd() / "temporary")
    Path("temporary").mkdir(exist_ok=True)
    for key in ["OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"]:
        os.environ[key] = "1"
    os.environ["NUMBA_DISABLE_JIT"] = "1"
    try:
        from session import serve
        serve()
    except Exception:
        # No exception messages, paths, media or Reference Lyrics enter diagnostics.
        sys.stderr.write("Open Chords Alignment worker failed safely\n")
        raise SystemExit(70) from None
else:
    raise SystemExit(64)
