# Model Store and MFA language-pack lifecycle

Implementation issue: [Implement the Model Store and MFA language-pack lifecycle](https://github.com/qisoft/open-chords/issues/57).

Base: merged lyrics discovery implementation, `503329cf8e95d4f8163790c2350413bf2ec8b69b`.

## Scope and authority

Implement the exact optional English and Russian alignment packs from the normative specification and artifact inventory. Main owns installation, verification, publication, inventory, removal, and network policy. Model data is global and immutable; exact versions coexist. Existing results remain valid when dependencies are removed.

MFA/Kaldi is executable release code, separate from Model Store data. Measure a self-contained runtime on both supported native targets before deciding base-sidecar versus first-install runtime placement. Do not substitute a system installation, report wheel size as runtime size, or claim alignment quality from an installation smoke test.

## Confirmed test seams

The user confirmed these three seams on 2026-09-06. Tests are restricted to these public boundaries.

1. Public main-owned Model Store lifecycle: inspect the fixed EN/RU offerings, install an exact pack, cancel, reopen, resolve exact dependencies, preview removal impact, and remove. Use real temporary storage and deterministic external HTTP fixtures. Cover interrupted/quarantined installs, hash and archive validation, bounded extraction, runtime compatibility, atomic publication, coexistence, and no silent substitution.
2. Named desktop capabilities and user-visible flow: display source, notices, separate model/runtime transfer and installed sizes; explicitly install/cancel/remove; enforce shared persistent Offline Mode in main; report affected Projects and unavailable exact reanalysis without changing committed results. Exercise the real store/library/gateway and renderer flow, with external transfers controlled at their boundary.
3. Installed macOS arm64 and Windows x64 artifacts: verify release manifests and notices, measure complete runtime footprint, prove executable dependency closure without system MFA, and exercise installation/reopen/removal through the packaged boundary. Keep runtime probes separate from Alignment Jobs, which belong to the next issue.

## Implementation order

First refresh the existing artifact/runtime evidence and identify the target-specific packaging path. Then proceed one red-to-green vertical slice at a time: exact install and reopen; rejection/cancellation and recovery; dependency/removal reporting; typed IPC and UI; native packaged validation. Add tests only at the confirmed seams.

## Completion evidence

Record final-head local validation, native CI, artifact/runtime measurements, and resolved review findings in the pull request and issue. Keep the issue open until its implementation is merged. If native runtime feasibility prevents an acceptance gate, record the concrete blocker rather than representing a partial Model Store as complete.
