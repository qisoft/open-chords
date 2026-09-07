import json
import sys

from importlib.metadata import version
__version__ = version("montreal_forced_aligner")
from montreal_forced_aligner.models import AcousticModel
from kalpy.aligner import KalpyAligner
import pynini

if sys.argv[1:] != ["--probe"]:
    raise SystemExit(64)
print(json.dumps({"runtime": "mfa", "version": __version__, "kalpy": KalpyAligner.__name__, "fst": pynini.Fst().num_states()}))
