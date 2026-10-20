export function windowsLocalVolumeCommand(
  root: string,
  moduleImport: "explicit" | "automatic" = "explicit",
) {
  if (root.length !== 2 || !/^[A-Za-z]:$/.test(root))
    throw new Error("Windows volume root unavailable");
  const query = `$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${root}'"; if ($null -eq $drive) { exit 2 }; [Console]::Out.Write($drive.DriveType)`;
  return moduleImport === "automatic"
    ? query
    : "$ErrorActionPreference = 'Stop'; Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1')) -ErrorAction Stop; " +
        query;
}
