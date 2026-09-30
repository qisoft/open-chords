# Installing Open Chords

Open Chords ships as unsigned community builds on GitHub Releases. The builds are not notarized by Apple and not signed with a Windows publisher certificate. Open Chords never updates itself. To update, download a newer release and replace the old application.

Each release has one ZIP archive per supported platform:

| Platform | Archive |
| --- | --- |
| macOS 15 or later on Apple Silicon | `open-chords-<version>-macos-arm64.zip` |
| Windows 11 x64 | `open-chords-<version>-windows-x64.zip` |

The archive contains everything that analysis needs. Do not install Python, FFmpeg, or other system packages. The release notes list the measured download and installed sizes for each archive.

## Verify the download

Download `SHA256SUMS` from the same release and put it in the folder that contains the archive.

On macOS, open Terminal in that folder and run:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

The line for your archive must end with `OK`.

On Windows, open PowerShell in that folder and run:

```powershell
Get-FileHash .\open-chords-<version>-windows-x64.zip -Algorithm SHA256
```

The `Hash` value must equal the hexadecimal value on the matching line of `SHA256SUMS`. PowerShell prints it in uppercase, which is equivalent.

To confirm that GitHub Actions in this repository built the archive, install the [GitHub CLI](https://cli.github.com/) and run:

```sh
gh attestation verify <archive> --repo qisoft/open-chords
```

## Install on macOS

1. Double-click the archive in Finder. Finder extracts `Open Chords.app`.
2. Move `Open Chords.app` to the Applications folder.
3. Open `Open Chords.app`. macOS reports that it cannot verify the developer and does not open it. Click **Done**.
4. Open **System Settings** > **Privacy & Security**.
5. In the **Security** section, find the message about Open Chords and click **Open Anyway**.
6. Confirm with your password or Touch ID, then click **Open Anyway** again.

macOS remembers this decision for this copy of the application. You must repeat these steps after you install a new release.

## Install on Windows

1. Right-click the archive in File Explorer and select **Extract All**.
2. Choose a short destination folder, for example `C:\Apps\Open Chords`. Some bundled runtime files have long paths, and a deep destination folder can exceed the Windows path length limit.
3. Open `Open Chords.exe` in the extracted folder.
4. Microsoft Defender SmartScreen can show **Windows protected your PC**, because the build has no publisher signature and little download reputation. Click **More info**, confirm that the application name is `Open Chords.exe`, then click **Run anyway**.

Keep all extracted files together. Open Chords checks its bundled runtimes at startup and refuses to analyze if a file is missing or changed.

## Uninstall

Delete `Open Chords.app` on macOS or the extracted folder on Windows. Your Projects, settings, caches, and installed packs stay in your user data folder.
