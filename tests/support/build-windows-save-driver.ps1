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
$bindingSource = Join-Path $PSScriptRoot 'installed-windows-replace-binding.cs'
Add-Type -Path @($source, $replacementSource, $bindingSource) -OutputAssembly $assembly -OutputType Library
Add-Type -Path $assembly
$foregroundChecks = [WindowsReplacementBinding]::VerifyForegroundWaitPolicy()
if ($foregroundChecks -ne 8) { throw 'Replacement foreground policy checks incomplete' }
Write-Host "Native Windows replacement foreground policy: checks=$foregroundChecks"
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
  $nodeCanonicalTarget = & node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $fixtureTarget
  if ($LASTEXITCODE -ne 0) { throw 'Native fixture canonicalization failed' }
  [WindowsReplacementContext]::VerifyFixture($nodeCanonicalTarget)
  foreach ($textFormat in @('lrc', 'chordpro')) {
    $textName = if ($textFormat -eq 'lrc') { 'Open Chords.lrc' } else { 'Open Chords.cho' }
    $textTarget = Join-Path $fixtureRoot $textName
    [IO.File]::WriteAllBytes($textTarget, [Text.Encoding]::UTF8.GetBytes('private existing Windows replacement target fixture'))
    [WindowsReplacementContext]::VerifyFixture($textTarget, $textFormat)
    $refused = $false
    try { [WindowsReplacementContext]::VerifyFixture($textTarget, 'json') } catch { $refused = $true }
    if (!$refused) { throw 'Replacement mismatched format was accepted' }
    Remove-Item -LiteralPath $textTarget
  }
  foreach ($unsupported in @('pdf', 'archive', 'media', 'unknown')) {
    $refused = $false
    try { [WindowsReplacementContext]::VerifyFixture($fixtureTarget, $unsupported) } catch { $refused = $true }
    if (!$refused) { throw 'Replacement unsupported format was accepted' }
  }
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
  Write-Host 'Native Windows replacement fixture gate: regular=passed node_canonical=passed text_formats=passed format_mismatch=refused unsupported=refused hardlink=refused changed=refused directory=refused'
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
