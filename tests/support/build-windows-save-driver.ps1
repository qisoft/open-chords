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
$replacementSource = Join-Path $PSScriptRoot 'installed-windows-replace-context.cs'
Add-Type -Path @($source, $replacementSource) -OutputAssembly $assembly -OutputType Library
Add-Type -Path $assembly
foreach ($format in @('json', 'lrc', 'chordpro', 'pdf', 'archive', 'media')) {
  [SaveNativeInput]::ConfigureFormat($format, $format -eq 'media')
}
Write-Host "Native Windows Save driver build: formats=6 duration_ms=$([Math]::Min(999999, $started.ElapsedMilliseconds))"
# Exercise the new handle-based fixture gate in CI without any native UI action.
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('oc-replacement-fixture-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$fixtureTarget = Join-Path $fixtureRoot 'Open Chords.json'
try {
  [IO.File]::WriteAllBytes($fixtureTarget, [Text.Encoding]::UTF8.GetBytes('private existing Windows replacement target fixture'))
  [WindowsReplacementContext]::VerifyFixture($fixtureTarget)
  $link = Join-Path $fixtureRoot 'linked.json'
  New-Item -ItemType HardLink -Path $link -Target $fixtureTarget | Out-Null
  $refused = $false
  try { [WindowsReplacementContext]::VerifyFixture($fixtureTarget) } catch { $refused = $true }
  if (!$refused) { throw 'Replacement hardlink fixture was accepted' }
  Remove-Item -LiteralPath $link
  [IO.File]::WriteAllBytes($fixtureTarget, [Text.Encoding]::UTF8.GetBytes('different fixture bytes'))
  $refused = $false
  try { [WindowsReplacementContext]::VerifyFixture($fixtureTarget) } catch { $refused = $true }
  if (!$refused) { throw 'Replacement changed fixture was accepted' }
  Remove-Item -LiteralPath $fixtureTarget
  New-Item -ItemType Directory -Path $fixtureTarget | Out-Null
  $refused = $false
  try { [WindowsReplacementContext]::VerifyFixture($fixtureTarget) } catch { $refused = $true }
  if (!$refused) { throw 'Replacement directory fixture was accepted' }
  Write-Host 'Native Windows replacement fixture gate: regular=passed hardlink=refused changed=refused directory=refused'
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
