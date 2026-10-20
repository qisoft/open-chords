# Resolve the same inbox cmdlet modules without searching the module-name path.
try {
  foreach ($pickerModuleName in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management')) {
    $pickerModuleManifest = [IO.Path]::Combine($PSHOME, 'Modules', $pickerModuleName, ($pickerModuleName + '.psd1'))
    Import-Module -Name $pickerModuleManifest -ErrorAction Stop
  }
} catch {
  throw 'input_modules_unavailable'
}
