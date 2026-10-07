param([int]$ApplicationPid, [string]$Scenario)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationPid)
$labels = @{
  projects = 'Projects, revisions, Library Trash and Source records (irreplaceable)'
  models = 'Installed language packs and models (can be downloaded again)'
  offline_media = 'Offline Media Cache (offline playback copies will be lost)'
  settings = 'Settings and completed acquisition history'
  application_state = 'Application caches, logs and browser state'
  final = 'Permanently delete the selected data?'
  result = 'Selected cleanup completed'
}
$seen = @{}
$probe = @{ windows = 0; elements = 0; checkboxes = 0; buttons = 0; recognized = 0; actions = 0 }
$events = [System.Collections.Generic.List[object]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($null -eq (Get-Process -Id $ApplicationPid -ErrorAction SilentlyContinue)) {
    ConvertTo-Json -InputObject @($events.ToArray()) -Compress
    exit 0
  }
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  $probe.windows = [Math]::Max($probe.windows, $windows.Count)
  foreach ($window in $windows) {
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $probe.elements = [Math]::Max($probe.elements, $elements.Count)
    $checkboxCount = 0
    $buttonCount = 0
    foreach ($element in $elements) {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox) { $checkboxCount++ }
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $buttonCount++ }
    }
    $probe.checkboxes = [Math]::Max($probe.checkboxes, $checkboxCount)
    $probe.buttons = [Math]::Max($probe.buttons, $buttonCount)
    $category = $null
    foreach ($key in $labels.Keys) {
      foreach ($element in $elements) {
        if ($element.Current.Name -eq $labels[$key]) { $category = $key; break }
      }
      if ($null -ne $category) { break }
    }
    if ($null -eq $category) { continue }
    $probe.recognized++
    $identity = ($window.GetRuntimeId() -join '-') + ':' + $category
    if ($seen.ContainsKey($identity)) { continue }
    $checkbox = $null
    $button = $null
    $selectModels = $category -eq 'models' -and $Scenario -ne 'unchecked'
    $confirmFinal = $category -eq 'final' -and $Scenario -eq 'confirm-models'
    $buttonName = if ($category -eq 'result') { 'Close' } elseif ($category -eq 'final') {
      if ($confirmFinal) { 'Permanently delete' } else { 'Cancel' }
    } elseif ($category -eq 'models') { 'Select for deletion' } else { 'Preserve category' }
    foreach ($element in $elements) {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox) { $checkbox = $element }
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.Name -eq $buttonName) { $button = $element }
    }
    if ($null -eq $button) { continue }
    if ($category -ne 'result') {
      if ($null -eq $checkbox) { throw 'Native confirmation checkbox unavailable' }
      $toggle = $checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { throw 'Native confirmation was not unchecked by default' }
      if ($selectModels -or $confirmFinal) {
        $toggle.Toggle()
        if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { throw 'Native confirmation did not toggle' }
      }
    }
    $probe.actions++
    [Console]::Error.WriteLine("Native cleanup probe: action=$category")
    $events.Add(@{ category = $category; checked = ($selectModels -or $confirmFinal); action = $buttonName })
    $seen[$identity] = $true
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  Start-Sleep -Milliseconds 100
}
[Console]::Error.WriteLine("Native cleanup probe: " + (ConvertTo-Json -InputObject $probe -Compress))
throw 'Installed cleanup native dialog driver timed out'
