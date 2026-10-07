# Unsigned release packaging

Issue [#46](https://github.com/qisoft/open-chords/issues/46) turns the native Forge ZIP into a release: a manifest of the installed tree, an SBOM, third-party notices, checksums, and GitHub artifact attestations. It does not add publisher signing, notarization, an installer framework, or an update channel. User-facing installation steps live in [Install an Open Chords release](../distribution/installing.md).

## Distributable

Both official targets ship the Forge `MakerZIP` output. Installing means extracting the ZIP.

- macOS arm64 ships `Open Chords.app`, ad-hoc signed by the existing `osxSign` configuration.
- Windows x64 ships a portable folder with `Open Chords.exe` at the root.

The pipeline does not use Squirrel.Windows, because it installs `Update.exe` and assumes an update feed. It does not use MSIX, because the Forge maker is experimental. A DMG or MSI adds a maker without changing what is proven, so v1 does not use one.

## Pipeline

The native CI job runs these steps after `pnpm make`:

1. `node tools/release/cli.ts stage` copies the Forge ZIP to `out/release/assets/open-chords-<version>-<target>.zip`. It extracts the ZIP to `out/release/scan/<target>/installed` and `app.asar` to `out/release/scan/<target>/app-asar`. It then writes `open-chords-<version>-<target>.release-manifest.json` and appends a size table to the job summary.
2. Syft `v1.52.0`, installed by `anchore/sbom-action/download-syft`, scans `out/release/scan/<target>`. It writes `.spdx.json` and `.cdx.json`. Syft scans the extracted install, so the SBOM lists what ships: the pruned `node_modules` inside `app.asar`, the Python distributions inside the frozen runtimes, and the binaries Syft can classify. It does not read the lockfile.
3. `pnpm test:packaged` runs `tests/packaged/release-manifest.spec.ts` and the existing installed proofs against the staged manifest.
4. The job uploads `out/release/assets/` as `release-assets-<target>`.

`.github/workflows/release.yml` runs on `workflow_dispatch` and on `v*` tags. It calls `ci.yml` through `workflow_call`, so a release is built by the same jobs that test it. Then it runs these steps:

1. `node tools/release/cli.ts checksums release` writes `SHA256SUMS` over the merged assets. It fails if a manifest disagrees with the bytes or hash of its ZIP.
2. `actions/attest@v4` records SLSA build provenance for every line of `SHA256SUMS`, plus one SBOM attestation that binds each ZIP to its SPDX document. `actions/attest-build-provenance@v4` is now a wrapper over `actions/attest`, and its README directs new workflows to `actions/attest`.
3. `gh attestation verify` checks each ZIP against the repository.
4. `node tools/release/cli.ts release-notes release` writes `RELEASE-NOTES.md` from the manifests.
5. On a tag that matches `v<package.json version>`, the `publish` job creates a draft GitHub Release. A maintainer publishes it by hand.

## Release manifest

`tools/release/release-manifest.ts` owns the schema. `distribution` accepts only `publisherSigning: "none"`, `notarization: "none"`, and `automaticUpdates: "none"`. A macOS executable must be ad-hoc or unsigned with a null team identifier. A manifest that claims anything else cannot be written.

`installed` is what `observeInstalledRelease` reads from an extracted tree:

| Field | Source |
|---|---|
| `entries` | Every file (size, SHA-256, executable bit) and symlink (target) under the extraction root. |
| `identity` | `package.json` inside the installed `app.asar`, and on macOS `CFBundleIdentifier`. |
| `fuses` | The decoded Electron fuse wire of the installed main executable. |
| `trustAnchors` | The four installed runtime manifests. Observation fails unless the installed `dist/main/main.cjs` contains each hash. |
| `executables` on macOS | Every `MH_EXECUTE` Mach-O file with its `codesign` signature kind and entitlements. |
| `executables` on Windows | Every `.exe` with its Authenticode directory state and the PE AppContainer image bit. |

`containment.evidence` is the exact evidence object the product's native broker accepts on that platform. The installed sidecar proof prints the evidence from its first contained launch, and `tests/packaged/security.spec.ts` requires it to equal the manifest.

`sizes` is derived from `entries` and the ZIP. `downloadBytes` is the ZIP size, `installedBytes` is the sum of logical file sizes, and `components` splits the tree by the prefix table in `tools/release/components.ts`. Allocated disk usage depends on the file system and is not recorded. Do not copy these numbers into documentation. Link the release manifest or the release notes.

## Notices

The Forge `packageAfterPrune` hook writes `Resources/notices` before signing. It holds the repository `LICENSE`, the Electron and Chromium licenses from `node_modules/electron/dist`, and `JAVASCRIPT-PACKAGES.txt`. The hook generates that file from the pruned production `node_modules` that goes into `app.asar`, and it fails if a shipped package has no license file. `README.txt` indexes the notice folders that the frozen runtime builds already package.

## What CI proves

The native jobs run on GitHub-hosted `macos-15` arm64 and `windows-2025` x64 runners. They extract the release ZIP into a temporary folder and prove these properties:

- A second extraction of the release ZIP matches every hash, symlink, fuse, trust anchor, entitlement, and PE fact in the manifest.
- The installed app runs contained local-file analysis and publishes Revisions with an empty environment. That covers no `PATH`, no Python, and no FFmpeg lookup. The frozen-runtime builds also reject any Mach-O or PE import outside the operating system or the packaged tree.
- `codesign --verify --strict` accepts the app and the XPC service. `xcrun stapler validate` finds no notarization ticket. No Open Chords executable has an Authenticode signature.
- The main bundle does not reference `autoUpdater`, and no update machinery ships.

CI does not prove behavior on a clean consumer machine:

- The runners have Homebrew, Python, Conda, compilers, and FFmpeg on disk. An empty environment removes lookup by name, but an import by absolute path would still resolve there. The build-time import-closure gates are the evidence against that, not an absence on disk.
- The ZIP never passes through a browser. It has no `com.apple.quarantine` attribute and no Mark of the Web, so Gatekeeper, **Open Anyway**, App Translocation, SmartScreen, and Smart App Control never run.
- Windows Server 2025 is a build profile. It is not Windows 11, the official Windows target.
- The runner accounts are administrators.

The first acceptance gate of #46 needs a person to download each release ZIP on a clean macOS 15 Apple Silicon machine and a clean Windows 11 x64 machine, follow [the installation guide](../distribution/installing.md), and analyze a local file.
