# Frozen analysis sidecar and canonical decode

Issue [#34](https://github.com/qisoft/open-chords/issues/34) establishes the real Python analysis-sidecar package and canonical decode boundary. It extends the protocol/lifecycle proof from issue #50; native OS containment remains owned by issue #49.

## Runtime boundary

Electron main starts exactly one manifest-verified executable by absolute path, with `shell: false`, an empty environment, and the Job Workspace as its working directory. The sidecar has no listener, network operation, PATH lookup, user configuration, plugin loading, or shell behavior. It reads and writes only length-prefixed JSON frames on stdin/stdout. Diagnostics never enter stdout; decode failures become bounded, redacted protocol errors.

The fixed Job Workspace layout is:

```text
input/source-media
artifacts/canonical.wav
artifacts/decode-manifest.json
```

Large audio remains file-backed. A successful protocol result carries only the relative manifest path, byte size, and SHA-256. The manifest then identifies the staged input and canonical WAV by relative descriptor and records the exact tool hashes, tool version lines, canonical configuration hash, sample format, sample rate, channel count, and integer sample count.

The runtime validates `runtime-manifest.json` before its handshake. Every regular file is size/hash-identified. PyInstaller's internal relative symlinks are target-identified and must resolve within the one-folder root. Extra, missing, changed, or escaping entries fail closed before analysis.

## Canonical profile

The v1 canonical output is mono, signed 16-bit little-endian PCM WAV at 48 kHz. FFmpeg maps the first audio stream, removes metadata, uses one worker thread, enables bit-exact format/codec flags, and writes atomically through a partial file. Project Time is the resulting integer sample-frame coordinate; downstream stages do not decode or resample again.

FFprobe is limited to the first audio stream and a small named JSON field set. Both tools have a 1 MiB probe budget, five-second analyze budget, 30-second process deadline, and 64 KiB stdout/stderr capture ceiling. Tool stderr is never forwarded to the protocol or persisted.

## Reviewed native build

`tools/build-ffmpeg.sh` downloads FFmpeg 8.1.2 from the official HTTPS release URL and refuses any archive except SHA-256 `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`. The committed configuration disables network, auto-detected libraries, devices, hardware acceleration, all protocols by default, GPL/nonfree/version-3 features, assembly, and unrelated encoders/muxers. It enables only:

- file and pipe protocols;
- WAV, MP3, FLAC, Ogg, Matroska, and MOV demuxers;
- the declared PCM, AAC, ALAC, FLAC, MP3, Opus, and Vorbis audio decoders;
- PCM16 WAV output and the canonical audio format/resample/pan filters.

The resulting license is LGPL-2.1-or-later. `sidecar/native/ffmpeg-build.json` is the machine-readable source/configuration authority.

`tools/build-analysis-sidecar.py` freezes the stdlib-only Python entry point with exact PyInstaller build dependencies, copies only the project-built `ffmpeg` and `ffprobe`, records observed versions, copies CPython/PyInstaller/FFmpeg license texts, and writes the final full-folder runtime manifest. Forge copies this one-folder directory outside ASAR under `Resources/open-chords-analysis`.

For a local macOS arm64 package, build the native runtime before Forge:

```sh
tools/build-ffmpeg.sh darwin-arm64 build/native
python3 -m venv .venv
.venv/bin/python -m pip install -r sidecar/requirements-build.txt
.venv/bin/python tools/build-analysis-sidecar.py \
  --build-id local \
  --native-root build/native/darwin-arm64 \
  --output-root dist/analysis-sidecar \
  --platform-profile darwin-arm64
pnpm test:frozen-sidecar
pnpm make -- --arch=arm64
pnpm test:packaged
```

## Native gates

CI builds on macOS arm64 and Windows x64 using native runners; PyInstaller is not used as a cross-compiler. Each profile:

1. verifies and builds the pinned FFmpeg source;
2. assembles the one-folder Python runtime;
3. decodes the same fixture twice through the framed child-process seam with an empty environment and compares manifests;
4. creates the Forge ZIP;
5. extracts and starts the installed application, which performs a real manifest-verified decode and reaps the sidecar.

These gates prove packaging, deterministic canonical data within each declared platform profile, protocol-only stdout, exact-tool launch, and independence from installed Python, Conda, Homebrew, FFmpeg, and compilers. They do not claim hostile process-tree containment; the production launcher remains fail-closed until issue #49 supplies and proves the platform backends.
