# Install an Open Chords release

Open Chords v1 releases are unsigned community builds. They are not notarized by Apple, not signed with an Apple Developer ID or a Windows publisher certificate, and they never update themselves. Your operating system warns you before the first launch. This guide shows how to check that a download is the one GitHub Actions built, then how to get past the warning on each platform.

Each release on the [GitHub Releases page](https://github.com/qisoft/open-chords/releases) has these files for each target:

| File | Contents |
|---|---|
| `open-chords-<version>-macos-arm64.zip` | The application for macOS 15 or later on Apple Silicon. |
| `open-chords-<version>-windows-x64.zip` | The application for Windows 11 x64. |
| `*.release-manifest.json` | The hash of every installed file, the Electron fuses, the macOS entitlements, the Windows executable facts, and the measured sizes. |
| `*.spdx.json`, `*.cdx.json` | The software bill of materials in SPDX and CycloneDX format. |
| `SHA256SUMS` | The SHA-256 checksum of every release file. |

The release notes list the measured download, installed, and per-component sizes for each target. The build pipeline writes these numbers. Nobody types them by hand.

You do not need Python, Conda, Homebrew, FFmpeg, a compiler, or any other package manager. Every runtime that local-file analysis needs is inside the ZIP.

## Verify the download

Do this before you override any operating-system warning.

1. Download the ZIP for your platform and `SHA256SUMS` into the same folder.
2. Compute the checksum of the ZIP.
   - On macOS, run `shasum -a 256 open-chords-<version>-macos-arm64.zip`.
   - On Windows, run `Get-FileHash .\open-chords-<version>-windows-x64.zip -Algorithm SHA256` in PowerShell.
3. Compare the result with the line for that file in `SHA256SUMS`. PowerShell prints uppercase hex and `SHA256SUMS` uses lowercase. The digits must be the same.
4. If you have the [GitHub CLI](https://cli.github.com/), verify the build provenance:

   ```sh
   gh attestation verify open-chords-<version>-macos-arm64.zip --repo qisoft/open-chords
   ```

   The command succeeds only if a GitHub Actions workflow in `qisoft/open-chords` built exactly this file. A second attestation binds the SPDX bill of materials to the same ZIP.

If a checksum or attestation does not match, delete the file and do not open it.

## Install on macOS

1. Double-click the ZIP to extract `Open Chords.app`. Safari can extract it for you after the download.
2. Drag `Open Chords.app` into the `Applications` folder. If you run it from `Downloads`, macOS starts it from a temporary read-only copy.
3. Double-click `Open Chords.app`. macOS says that it cannot verify the app and does not open it. Click **Done**.
4. Open the Apple menu, choose **System Settings**, then click **Privacy & Security** in the sidebar.
5. In the **Security** section, find the message about Open Chords and click **Open Anyway**. The button is available for about an hour after you try to open the app.
6. Enter your login password and click **OK**.

macOS saves this copy of Open Chords as an exception, and later launches open normally. Each new release is a new copy, so you repeat these steps after you update. On macOS 15, Control-clicking the app and choosing **Open** no longer skips this check.

## Install on Windows

1. Right-click the downloaded ZIP and choose **Properties**. If the **General** tab shows an **Unblock** checkbox, you can select it and click **OK**. This removes the downloaded-from-the-internet mark before you extract. If you skip this step, Windows shows a warning at the first launch instead.
2. Right-click the ZIP, choose **Extract All**, and extract it to a short path, for example `C:\Apps\Open Chords`. The analysis and alignment runtimes contain deep folders, and a long destination path can exceed the Windows path length limit during extraction. The release manifest records the longest path inside the ZIP as `sizes.longestPathCharacters`.
3. Open the folder and double-click `Open Chords.exe`.
4. If Microsoft Defender SmartScreen shows **Windows protected your PC**, click **More info**, check that the app name is `Open Chords.exe`, and click **Run anyway**. SmartScreen warns about any download without established reputation, and an unsigned build has no publisher reputation.

If **Smart App Control** is on, Windows blocks unsigned apps and offers no per-app exception, so Open Chords cannot run. You can turn Smart App Control off in **Windows Security** under **App & browser control**. That choice is yours. Open Chords does not require or recommend it.

The Windows build has no installer, no Start menu entry, and no entry in the list of installed apps.

Keep all extracted files together. Open Chords verifies its bundled runtimes before analysis and refuses to analyze if a file is missing or changed.

## Uninstall

Delete `Open Chords.app` on macOS or the extracted folder on Windows. Your Projects, settings, caches, and installed language packs stay in your user data folder.

## Updates

Open Chords never checks for, downloads, or installs updates in the background. To update, download the new release, verify it, and replace the old application.

## Third-party notices

Every installed application contains a `notices` folder. It holds the Open Chords license, the Electron and Chromium licenses, the license text of every shipped JavaScript package, and an index of the notice folders inside each bundled runtime.

- On macOS, the folder is `Open Chords.app/Contents/Resources/notices`.
- On Windows, the folder is `resources\notices` in the extracted folder.

## Check for updates from the application

Open **Updates**, then choose **Check for updates**. Opening the dialog only reads local status. The explicit check makes one credential-free request to `api.github.com/repos/qisoft/open-chords/releases/latest`, with redirects refused, a 15-second deadline and a 1 MiB response limit. No published release, incomplete platform assets, missing checksums, malformed metadata and a failed check have distinct visible outcomes. There is no background polling or automatic retry.

The dialog shows your installed version, the latest published release tag/date, plain-text release notes, the archive for your native platform, its size, and a SHA-256 digest when GitHub supplies one. A missing digest is shown as missing, never inferred. The release page contains `SHA256SUMS`; compare the actual download with those checksums and verify its build attestation using the instructions above. Metadata alone is not download verification, and the dialog does not claim that a latest published version is necessarily newer than a custom installed build.

**Cancel update check**, closing the dialog, replacing the renderer or quitting cancels an active request. Enabling Offline Mode cancels it too and prevents update checks or opening external instructions/release pages. In Offline Mode the local status and controls remain available. The application never downloads or installs an update, restarts, or changes installed models; **Open release on GitHub** and **Open verification instructions** open a fixed repository page only after an explicit click.

Project recovery is available from **Project recovery** in the application. Inspect the preserved revisions, select a backup, and confirm that exact revision before restoring it. A successful restore publishes a new revision and preserves history. Read-only or damaged Projects are reported without silently rewriting them. OS application removal continues to preserve user data.


## Explicit data cleanup

Quit Open Chords first. Before removing the application, start its dedicated cleanup mode:

```sh
# macOS (adjust the application path if needed)
"/Applications/Open Chords.app/Contents/MacOS/Open Chords" --open-chords-cleanup
```

```powershell
# Windows (adjust the extracted application path if needed)
& "C:\Apps\Open Chords\Open Chords.exe" --open-chords-cleanup
```

This mode opens no Project Library, renderer, analysis/alignment/acquisition workers or update/model services. It refuses to run alongside another Open Chords instance. It displays native confirmation dialogs for five separate categories: Projects and preserved revisions/Library Trash/Source records; installed models/language packs; Offline Media Cache; settings/completed acquisition history; and application caches/logs/browser state. Every dialog enumerates the concrete locations. The default action preserves the category. Selecting deletion requires both the deletion button and an unchecked-by-default category confirmation. A final confirmation lists all selected categories and requires a second explicit checkbox before any deletion. Cancel at the final step to preserve everything.

Back up Projects as Portable Project Archives before selecting the irreplaceable Project category. Model artifacts can be downloaded again; removing offline copies can make offline playback unavailable. Deleting settings resets Offline Mode to its fresh-install default on the next normal launch. Cleanup does not download replacements or restart the application.

Only the enumerated locations are deleted. The default Library copy and a recorded relocated active Library are inspected. Original Source media, exports, archives and older Library copies outside those locations remain. Unknown files and Library root directories remain and are reported; Open Chords does not recursively delete the whole user data folder. Unrecorded previous relocation copies require separate manual inspection. An external Library containing unexpected files, symlinks/special files, changed inventory, oversized inventory, pending exports/relocation, or unrecovered native-workspace journals blocks cleanup. Open normally to recover interrupted work, quit, then inspect and confirm again.

Deletion claims each selected location under a unique adjacent name before removal, stops on the first failure, and reports removed and failed locations. Already removed locations cannot be undone; a failed claim may remain at its reported `.open-chords-cleanup-*` path. There is no automatic retry. Preserve or inspect that path manually before a new attempt. Removing the application is a separate step.

Module tests cover category isolation, final cancellation, stale inventories, relocation, unknown/external file preservation, symlink refusal and interrupted work. Native CI exercises the cold-start entry point with a controlled dialog adapter; this is not evidence of consumer uninstall behavior, native dialog keyboard/screen-reader usability or an installed cleanup interaction. Those #51/#46/#48 gates remain open until their native evidence is recorded.
