param([ValidateSet('name', 'path')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  if ([IntPtr]::Size -ne 8 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'runtime' }
  $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $clientPath = Join-Path $framework 'WPF/UIAutomationClient.dll'
  $typesPath = Join-Path $framework 'WPF/UIAutomationTypes.dll'
  $available = (Test-Path -LiteralPath $clientPath -PathType Leaf) -and (Test-Path -LiteralPath $typesPath -PathType Leaf)
  if (!$available) {
    @{ available = $false; identityMatches = $false; bytesMatch = $false; clientMs = 0; typesMs = 0; totalMs = 0 } | ConvertTo-Json -Compress
    exit 0
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  if ($Mode -eq 'name') { Add-Type -AssemblyName UIAutomationClient }
  else { [Reflection.Assembly]::LoadFrom($clientPath) | Out-Null }
  $clientMs = $timer.ElapsedMilliseconds
  if ($Mode -eq 'name') { Add-Type -AssemblyName UIAutomationTypes }
  else { [Reflection.Assembly]::LoadFrom($typesPath) | Out-Null }
  $totalMs = $timer.ElapsedMilliseconds
  $client = [System.Windows.Automation.AutomationElement].Assembly
  $types = [System.Windows.Automation.AutomationProperty].Assembly
  $identityMatches = $client.FullName -ceq [Reflection.AssemblyName]::GetAssemblyName($clientPath).FullName -and $types.FullName -ceq [Reflection.AssemblyName]::GetAssemblyName($typesPath).FullName
  $bytesMatch = (Get-FileHash -LiteralPath $client.Location).Hash -ceq (Get-FileHash -LiteralPath $clientPath).Hash -and (Get-FileHash -LiteralPath $types.Location).Hash -ceq (Get-FileHash -LiteralPath $typesPath).Hash
  @{ available = $true; identityMatches = [bool]$identityMatches; bytesMatch = [bool]$bytesMatch; clientMs = [int]$clientMs; typesMs = [int]($totalMs - $clientMs); totalMs = [int]$totalMs } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('Native UIAutomation load measurement unavailable')
  exit 1
}
