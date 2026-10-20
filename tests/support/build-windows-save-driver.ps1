$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8 -or $PSVersionTable.PSEdition -ne 'Desktop') {
  throw 'Native Save driver requires Windows PowerShell x64'
}
$started = [Diagnostics.Stopwatch]::StartNew()
$source = Join-Path $PSScriptRoot 'installed-save-windows-input.cs'
$outputRoot = Join-Path $PSScriptRoot '../../build/test-support'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$assembly = Join-Path $outputRoot 'windows-save-input.dll'
if (Test-Path -LiteralPath $assembly) { Remove-Item -LiteralPath $assembly -Force }
Add-Type -Path $source -OutputAssembly $assembly -OutputType Library
Add-Type -Path $assembly
foreach ($format in @('json', 'lrc', 'chordpro', 'pdf', 'archive', 'media')) {
  [SaveNativeInput]::ConfigureFormat($format, $format -eq 'media')
}
Write-Host "Native Windows Save driver build: formats=6 duration_ms=$([Math]::Min(999999, $started.ElapsedMilliseconds))"
