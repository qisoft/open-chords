function volumeQuery(root: string) {
  if (root.length !== 2 || !/^[A-Za-z]:$/.test(root))
    throw new Error("Windows volume root unavailable");
  return `$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${root}'"; if ($null -eq $drive) { exit 2 }; [Console]::Out.Write($drive.DriveType)`;
}

function modulePreparation(mode: "explicit" | "automatic") {
  return mode === "automatic"
    ? ""
    : "$ErrorActionPreference = 'Stop'; Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1')) -ErrorAction Stop; ";
}

export function windowsLocalVolumeCommand(
  root: string,
  moduleImport: "explicit" | "automatic" = "explicit",
) {
  return modulePreparation(moduleImport) + volumeQuery(root);
}

// CI-only measurement keeps the classifier query and module preparation shared.
export function windowsLocalVolumeMeasurementCommand(
  root: string,
  moduleImport: "explicit" | "automatic",
) {
  return (
    "$volumeScriptClock = [Diagnostics.Stopwatch]::StartNew(); " +
    modulePreparation(moduleImport) +
    "$volumeImportMs = $volumeScriptClock.ElapsedMilliseconds; " +
    "$volumeQueryClock = [Diagnostics.Stopwatch]::StartNew(); " +
    volumeQuery(root) +
    "; $volumeQueryMs = $volumeQueryClock.ElapsedMilliseconds; " +
    "$volumeScriptMs = $volumeScriptClock.ElapsedMilliseconds; " +
    '[Console]::Out.Write("|{0}|{1}|{2}", $volumeImportMs, $volumeQueryMs, $volumeScriptMs)'
  );
}
