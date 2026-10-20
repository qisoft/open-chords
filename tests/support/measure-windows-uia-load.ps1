param([ValidateSet('name', 'path')][string]$Mode)
$whole = [Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference = 'Stop'
try {
  if ([IntPtr]::Size -ne 8 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'runtime' }
  $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $runtimeMs = [int]$whole.ElapsedMilliseconds
  $clientPath = Join-Path $framework 'WPF/UIAutomationClient.dll'
  $typesPath = Join-Path $framework 'WPF/UIAutomationTypes.dll'
  $pathMs = [int]$whole.ElapsedMilliseconds - $runtimeMs
  $available = (Test-Path -LiteralPath $clientPath -PathType Leaf) -and (Test-Path -LiteralPath $typesPath -PathType Leaf)
  $availabilityMs = [int]$whole.ElapsedMilliseconds - $runtimeMs - $pathMs
  if (!$available) {
    @{ available = $false; identityMatches = $false; bytesMatch = $false; runtimeMs = $runtimeMs; pathMs = $pathMs; availabilityMs = $availabilityMs; verificationMs = 0; clientMs = 0; typesMs = 0; totalMs = 0 } | ConvertTo-Json -Compress
    exit 0
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  if ($Mode -eq 'name') { Add-Type -AssemblyName UIAutomationClient }
  else { [Reflection.Assembly]::LoadFrom($clientPath) | Out-Null }
  $clientMs = $timer.ElapsedMilliseconds
  if ($Mode -eq 'name') { Add-Type -AssemblyName UIAutomationTypes }
  else { [Reflection.Assembly]::LoadFrom($typesPath) | Out-Null }
  $totalMs = $timer.ElapsedMilliseconds
  $verificationStarted = $whole.ElapsedMilliseconds
  $client = [System.Windows.Automation.AutomationElement].Assembly
  $types = [System.Windows.Automation.AutomationProperty].Assembly
  $identityMatches = $client.FullName -ceq [Reflection.AssemblyName]::GetAssemblyName($clientPath).FullName -and $types.FullName -ceq [Reflection.AssemblyName]::GetAssemblyName($typesPath).FullName
  $bytesMatch = (Get-FileHash -LiteralPath $client.Location).Hash -ceq (Get-FileHash -LiteralPath $clientPath).Hash -and (Get-FileHash -LiteralPath $types.Location).Hash -ceq (Get-FileHash -LiteralPath $typesPath).Hash
  $verificationMs = [int]($whole.ElapsedMilliseconds - $verificationStarted)
  @{ runtimeMs = $runtimeMs; pathMs = $pathMs; availabilityMs = $availabilityMs; verificationMs = $verificationMs; available = $true; identityMatches = [bool]$identityMatches; bytesMatch = [bool]$bytesMatch; clientMs = [int]$clientMs; typesMs = [int]($totalMs - $clientMs); totalMs = [int]$totalMs } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('Native UIAutomation load measurement unavailable')
  exit 1
}
