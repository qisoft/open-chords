# Open Chords v1 model artifact inventory

> Resolution research for issue [#22](https://github.com/qisoft/open-chords/issues/22). Sources and remote artifacts were checked on 2026-08-17. Byte counts and SHA-256 values below were measured from the linked official artifacts; MiB means bytes / 1,048,576. This is an engineering inventory, not legal advice.

## Decision

Open Chords v1 does **not** need a generic model downloader.

- The default decode and musical-analysis path — FFmpeg, librosa, Open Chords DSP/decoders, and the selected classical Essentia algorithms — contains **0 bytes of model data**. These are executable/runtime dependencies, not `Model Artifact`s.
- Reference-lyrics alignment is optional. Offer exactly two independently installable MFA language packs: English and Russian. Installing both downloads **210,109,660 bytes (200.38 MiB)** and stores **228,695,918 logical bytes (218.10 MiB)** after acoustic archives are extracted.
- Do not bundle MFA language packs in the application installer. Download one only after the user chooses lyrics alignment for that language, showing the exact transfer and installed sizes below.
- BeatNet, Chordino, All-In-One, and BTC remain benchmark-only or excluded. Their artifacts must not appear in the v1 Model Store or delivery UI.
- The MFA/Kaldi execution environment and platform FFmpeg/Essentia binaries are part of the analysis sidecar, not model packs. Their installed footprint is target- and build-dependent and must be measured from the eventual frozen macOS arm64, Windows x64, and Linux x64 packages. Adding their dependency sizes to the model numbers would be misleading.

## Shipping inventory

| Capability | Pin and official source | License | Download | Measured installed model data | Disposition |
|---|---|---:|---:|---:|---|
| Canonical decode | FFmpeg **8.1.2** source [`ffmpeg-8.1.2.tar.xz`](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz), with [detached signature](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc) | Build-dependent LGPL/GPL outcome; [official legal page](https://ffmpeg.org/legal.html) | Source: 11,710,924 B (11.17 MiB) | **0 B models**; source expands to 88,182,651 logical B, but final binaries depend on target and configure flags | Build and bundle one reviewed binary per target; never download as a model |
| DSP baseline | librosa **0.11.0**, [PyPI wheel](https://files.pythonhosted.org/packages/b5/ba/c63c5786dfee4c3417094c4b00966e61e4a63efecee22cb7b4c0387dda83/librosa-0.11.0-py3-none-any.whl) and [release metadata](https://pypi.org/pypi/librosa/0.11.0/json) | ISC | Wheel: 260,749 B | **0 B models**; NumPy/SciPy/Numba and native transitive dependencies are runtime | Bundle in sidecar; no model download |
| Open Chords DSP/decoders | Exact Open Chords release commit | AGPL-3.0 | In application source/binary | **0 B models** | Bundle in sidecar |
| Classical comparison backend | Essentia **2.1b6.dev1438**, [PyPI release metadata](https://pypi.org/pypi/essentia/2.1b6.dev1438/json) | AGPL-3.0; [official licensing](https://essentia.upf.edu/licensing_information.html) | macOS 15 arm64 CPython 3.14 wheel: 20,494,034 B; Linux x64: 14,104,978 B; no Windows wheel in this release | **0 B models** for `RhythmExtractor2013`, `KeyExtractor`, `ChordsDetection`, and `ChordsDetectionBeats`; neural Essentia models are a separate product surface | Optional bundled backend only after Windows build and benchmark pass; never fetch ML models |

FFmpeg's measured archive SHA-256 is `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`; verify the upstream signature in release automation as well. The librosa wheel's publisher-provided SHA-256 is `0b6415c4fd68bff4c29288abe67c6d80b587e0e1e2cfb0aad23e4559504a7fa1`. Context7 confirms that the selected librosa APIs are classical beat/chroma/recurrence routines, and that the selected Essentia algorithms are standard HPCP/template/rhythm algorithms rather than its separately downloadable TensorFlow model catalog.

### MFA language packs

The cards identify both acoustic models as GMM-HMM/MFCC models, version 3.1.0, licensed CC BY 4.0 and intended for forced alignment. They were trained primarily on read speech and warn that divergent audio may align poorly: that caveat is material for singing. See the official [English acoustic model card](https://mfa-models.readthedocs.io/en/latest/acoustic/English/English%20MFA%20acoustic%20model%20v3_1_0.html), [Russian acoustic model card](https://mfa-models.readthedocs.io/en/latest/acoustic/Russian/Russian%20MFA%20acoustic%20model%20v3_1_0.html), [English dictionary card](https://mfa-models.readthedocs.io/en/latest/dictionary/English/English%20MFA%20dictionary%20v3_1_0.html), and [Russian dictionary card](https://mfa-models.readthedocs.io/en/latest/dictionary/Russian/Russian%20MFA%20dictionary%20v3_1_0.html).

| Pack/artifact | Official immutable release | License | Download bytes | Extracted/logical bytes | SHA-256 |
|---|---|---:|---:|---:|---|
| English acoustic `english_mfa` v3.1.0 | [`english_mfa.zip`](https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-english_mfa-v3.1.0/english_mfa.zip), [release](https://github.com/MontrealCorpusTools/mfa-models/releases/tag/acoustic-english_mfa-v3.1.0) | CC BY 4.0 | 92,170,811 | 101,466,972 | `2c08bd4f82c3943dd57ac09aeac99dbce17a1e1bfe9fd932c8d95cd13d971068` |
| English dictionary `english_mfa` v3.1.0 | [`english_mfa.dict`](https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_mfa-v3.1.0/english_mfa.dict), [release](https://github.com/MontrealCorpusTools/mfa-models/releases/tag/dictionary-english_mfa-v3.1.0) | CC BY 4.0 | 1,078,195 | 1,078,195 | `975bf9c7791535c5aec57995e0bd2b77eb7ca364d1d974c2134e07bb0f16b079` |
| **English pack total** | Above pair | CC BY 4.0 | **93,249,006 (88.93 MiB)** | **102,545,167 (97.79 MiB)** | Manifest hashes both files |
| Russian acoustic `russian_mfa` v3.1.0 | [`russian_mfa.zip`](https://github.com/MontrealCorpusTools/mfa-models/releases/download/acoustic-russian_mfa-v3.1.0/russian_mfa.zip), [release](https://github.com/MontrealCorpusTools/mfa-models/releases/tag/acoustic-russian_mfa-v3.1.0) | CC BY 4.0 | 91,909,566 | 101,199,663 | `bf2cdc58f3ce2cd15ee2ef1f33a56f3c901b28707b3c3fd896129050c03b3bf4` |
| Russian dictionary `russian_mfa` v3.1.0 | [`russian_mfa.dict`](https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-russian_mfa-v3.1.0/russian_mfa.dict), [release](https://github.com/MontrealCorpusTools/mfa-models/releases/tag/dictionary-russian_mfa-v3.1.0) | CC BY 4.0 | 24,951,088 | 24,951,088 | `f225655b9d835b73fbf510baf8283b78c5cf2d3303306005f733854670ff707f` |
| **Russian pack total** | Above pair | CC BY 4.0 | **116,860,654 (111.45 MiB)** | **126,150,751 (120.31 MiB)** | Manifest hashes both files |
| **Both languages** | Four files above | CC BY 4.0 | **210,109,660 (200.38 MiB)** | **228,695,918 (218.10 MiB)** | Manifest hashes all files |

`mfa model download acoustic english_mfa` and its equivalents are convenience commands, but Open Chords should download these exact release assets itself into the content-addressed Model Store, verify SHA-256, then extract atomically. This avoids an unversioned “latest” lookup; MFA documents both the [model-download command](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/models/index.html) and a `--version` option.

The aligner is a separate runtime. MFA **3.4.1** itself is MIT and its [PyPI wheel](https://files.pythonhosted.org/packages/ff/ab/9a4ff08ebc4803f2946fb247fcc252ac0051ae5ae84a0d82b81e46501bee/montreal_forced_aligner-3.4.1-py3-none-any.whl) is only 443,331 B (`de2e6cc7d607cf8807e8f8263a32e970a7d4ff4fffbb5fe055a6eb5539587964`). That number does **not** include the separately installed Kaldi/OpenFst/Pynini/SQL/database, scientific-Python, and executable dependencies described by the [official installation guide](https://montreal-forced-aligner.readthedocs.io/en/latest/installation.html). The release decision must use measured frozen-sidecar sizes, not the tiny Python wheel as a proxy.

## Benchmark-only and excluded artifacts

These measurements prevent future packaging discussions from mistaking a small checkpoint for a small usable runtime.

| Candidate | Exact artifact inventory | License/provenance result | v1 disposition |
|---|---|---|---|
| BeatNet | Pin [commit `81cedd4`](https://github.com/mjhydri/BeatNet/commit/81cedd4beeb7235262db80969a0c9ce9a48a0ed4). Runtime uses three files: [`model_1_weights.pt`](https://raw.githubusercontent.com/mjhydri/BeatNet/81cedd4beeb7235262db80969a0c9ce9a48a0ed4/src/BeatNet/models/model_1_weights.pt), `model_2_weights.pt`, `model_3_weights.pt`; each 1,612,179 B, total **4,836,537 B (4.61 MiB)**. SHA-256: `619091bc…aca84`, `5878a18c…02d58`, `0c52a074…989ca`. | Repository declares CC BY 4.0, but provides no per-checkpoint model cards/license/provenance manifest. Runtime also requires PyTorch and madmom; the official code uses madmom's DBN processor but its own weights. | Benchmark only; not packageable as a release Model Artifact until the checkpoint grant and provenance are explicit |
| Chordino / NNLS Chroma | Weight-free: **0 B model data**. Official [v1.1 source](https://github.com/c4dm/nnls-chroma/tree/v1.1) archive measured 231,153 B, SHA-256 `8603532b9278e5b46d444105e4d754e58bd7423c237946b0a73f867e8f45171a`; 368,396 logical B extracted. | The official repository includes GPL-2.0 `COPYING`; Chordino is a Vamp plugin and needs a compatible host/runtime. It has user-editable chord profiles, not learned weights. | Useful benchmark; possible bundled GPL component only after a concrete cross-platform host/build decision, never a model download |
| All-In-One | Loader fetches one 1,400,571 B Harmonix fold by default, or eight folds totaling **11,204,568 B (10.69 MiB)**, from the official [Hugging Face repository](https://huggingface.co/taejunkim/allinone/tree/379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19). It also invokes Demucs `htdemucs`: official checkpoint [`955717e8-8726e21a.th`](https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th), 84,141,911 B (80.24 MiB). Thus model data is at least **81.58 MiB** for one fold or **90.93 MiB** for the ensemble, before caches/runtime. | All-In-One/HF card say MIT, but the HF “model card” contains only the license field and no training/provenance detail. The pipeline requires PyTorch, NATTEN, madmom, and learned source separation. | Exclude: conflicts with v1's no-source-separation architecture and carries a large runtime |
| BTC-ISMIR19 | Pin [commit `2682317`](https://github.com/jayg996/BTC-ISMIR19/commit/2682317be668032e6e4b269ded36adaa2ad57df0). Official repository contains [`btc_model.pt`](https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/2682317be668032e6e4b269ded36adaa2ad57df0/test/btc_model.pt), 12,154,754 B, SHA-256 `71c2c5db17e8c43b8a9a9da5db36ef2d667158c07a214eba16344c154c00bf54`, and [`btc_model_large_voca.pt`](https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/2682317be668032e6e4b269ded36adaa2ad57df0/test/btc_model_large_voca.pt), 12,229,576 B, SHA-256 `1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51`. | Code repository is MIT, but its [README](https://github.com/jayg996/BTC-ISMIR19#data) says training audio was gathered from online music providers and omitted for copyright; neither checkpoint has a separate model card or explicit weight redistribution grant. | Exclude from release; a file being publicly downloadable is not a sufficient Model Artifact contract |

Full BeatNet SHA-256 values, in model-number order:

- `model_1_weights.pt`: `619091bc317ca3e83b45591d46f6de3d5a41588bcb39fe9fe7be30cffa6aca84`
- `model_2_weights.pt`: `5878a18c079fa0b0139879b14ed2b5b7595faef8c3d16210aed141fd00fa2d58`
- `model_3_weights.pt`: `0c52a074ea38e8cb4a760ecfa3747c9cf91a1e3cd19f238eed80b0de763989ca`

The All-In-One model loader and exact filenames are in its [official source](https://github.com/mir-aidj/all-in-one/blob/18e78903c0365147a2c5d4e5e57ebf88cb7d800e/src/allin1/models/loaders.py); Demucs' [official remote manifest](https://github.com/facebookresearch/demucs/blob/main/demucs/remote/files.txt) maps `htdemucs` to that checkpoint. All-In-One's own checkpoint hashes are exposed by the Hugging Face API and must be copied into a benchmark manifest if that lane is implemented; they are not v1 delivery inputs.

## Product and implementation consequences

1. The initial application install can perform automatic chord/beat/key/section baselines without a model-download prompt.
2. “Install English lyrics alignment” must show **88.93 MiB download / 97.79 MiB installed**; Russian must show **111.45 MiB / 120.31 MiB**. The UI must also state that alignment is best-effort for singing and reference lyrics are required.
3. Each MFA pack manifest records both artifact URLs, version `3.1.0`, SHA-256, CC BY 4.0 attribution/model-card URLs, logical installed bytes, compatible runtime range, and install timestamp. A newer model never substitutes silently.
4. Runtime download policy is a different decision from model delivery. Prefer bundling a measured frozen sidecar; if the sidecar remains optional, disclose its target-specific size separately from the language pack.
5. No candidate checkpoint becomes available through a hidden “advanced” toggle. BeatNet/BTC need a separate rights decision; All-In-One violates scope; Chordino needs a host/build decision. Benchmark tooling may fetch them only through explicit development manifests.

## Measurement method

- GitHub release asset byte counts were checked against the GitHub Releases API, then all four MFA files were downloaded from the immutable release URLs.
- SHA-256 was computed over downloaded bytes. Both acoustic ZIPs passed `unzip -t`.
- “Installed” acoustic size is the sum of logical file lengths after extraction (10 files per acoustic archive); dictionary files are already uncompressed. APFS allocation size was not used because it varies by filesystem and clone/compression behavior.
- PyPI sizes and publisher SHA-256 values come from the official version JSON endpoints. Hugging Face sizes/hashes come from its official model API. Runtime-package sizes are deliberately not extrapolated from source archives or package-manager metadata.

## Context7 verification

Context7 was available and used with resolved official documentation IDs for MFA, librosa, and Essentia. It confirmed the separate MFA acoustic-model/dictionary download workflow; librosa's weight-free beat/chroma/recurrence APIs; and the distinction between Essentia's classical algorithms used here and its separately downloadable TensorFlow model catalog. Durable primary-source links are embedded above.
