param([int]$ApplicationPid, [ValidateSet('cancel', 'cancel_existing', 'save', 'cancel_open', 'cancel_open_existing', 'open')][string]$Scenario, [string]$TargetPath, [ValidateSet('json', 'lrc', 'chordpro', 'pdf', 'archive', 'media')][string]$Format = 'json')
$ErrorActionPreference = 'Stop'
$isImport = $Scenario -in @('cancel_open', 'cancel_open_existing', 'open')
$setFilename = $Scenario -in @('cancel_existing', 'save', 'cancel_open_existing', 'open')
if ($isImport -and $Format -notin @('archive', 'media')) { throw 'Native import format unavailable' }
if ($Format -eq 'media' -and !$isImport) { throw 'Native media Save unavailable' }
$extension = if ($Format -eq 'chordpro') { 'cho' } elseif ($Format -eq 'archive') { 'ocarchive' } else { $Format }
$expectedFilename = 'Open Chords.' + $extension
$expectedTitle = switch ($Format) { 'json' { 'Export Open Chords JSON' }; 'lrc' { 'Export LRC lyrics' }; 'chordpro' { 'Export ChordPro' }; 'pdf' { 'Export PDF lead sheet' }; 'archive' { 'Export Portable Project Archive' } }
if ($isImport) { $expectedTitle = if ($Format -eq 'media') { 'Open' } else { 'Import Portable Project Archive' } }
$maxWindows = 0
$maxElements = 0
$fileNames = 0
$actions = 0
$fallbackMisses = 0
$stage = 'setup'
[Console]::Error.WriteLine('Native Save driver stage: started')
$probeStarted = [DateTime]::UtcNow
$probeSeen = @{}
$probeCount = 0
$probeCycle = $false
$candidateSnapshotTaken = $false
$childSnapshotTaken = $false
function Write-NativeSaveProbe([string]$Name) {
  if (!$script:probeSeen.ContainsKey($Name) -or $script:probeCycle) {
    if ($script:probeCount -lt 96) {
      $elapsed = [int][Math]::Floor(([DateTime]::UtcNow - $script:probeStarted).TotalMilliseconds)
      [Console]::Error.WriteLine("Native Save driver probe: $Name duration_ms=$elapsed windows=$script:maxWindows elements=$script:maxElements filenames=$script:fileNames actions=$script:actions")
      $script:probeCount++
    }
    $script:probeSeen[$Name] = $true
  }
}

try {
Write-NativeSaveProbe 'assemblies'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Write-NativeSaveProbe 'load_assembly'
$nativeAssembly = Join-Path $PSScriptRoot '../../build/test-support/windows-save-input.dll'
if (!(Test-Path -LiteralPath $nativeAssembly -PathType Leaf)) { throw 'input_assembly_unavailable' }
Add-Type -Path $nativeAssembly

[SaveNativeInput]::ConfigureFormat($Format, $isImport)
Write-NativeSaveProbe 'root'
Write-NativeSaveProbe 'ready'
$stage = 'discovery'
$nextProbe = [DateTime]::UtcNow
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$maxWindows = 0
$maxElements = 0
$fileNames = 0
$actions = 0
while ([DateTime]::UtcNow -lt $deadline) {
  if ($null -eq (Get-Process -Id $ApplicationPid -ErrorAction SilentlyContinue)) { throw 'application_exit' }
  $probeCycle = [DateTime]::UtcNow -ge $nextProbe
  if ($probeCycle) { $nextProbe = [DateTime]::UtcNow.AddSeconds(5) }
  if ($probeCycle) { [Console]::Error.WriteLine([SaveNativeInput]::Probe([uint32]$ApplicationPid)) }
  Write-NativeSaveProbe 'windows_query'
  $dialogHandle = [SaveNativeInput]::FindDialog([uint32]$ApplicationPid)
  $windows = @()
  if ($dialogHandle -ne [IntPtr]::Zero) {
    $windows = @([System.Windows.Automation.AutomationElement]::FromHandle($dialogHandle))
  }
  $maxWindows = [Math]::Max($maxWindows, $windows.Count)
  if ($windows.Count -gt 16) { throw 'window_bound' }
  Write-NativeSaveProbe 'windows_read'
  foreach ($window in $windows) {
    Write-NativeSaveProbe 'window_properties'
    if ($window.Current.Name -cne $expectedTitle) { continue }
    if (!$childSnapshotTaken) {
      [Console]::Error.WriteLine([SaveNativeInput]::ProbeChildren([IntPtr]$window.Current.NativeWindowHandle, [uint32]$ApplicationPid))
      $childSnapshotTaken = $true
    }
    Write-NativeSaveProbe 'elements_query'
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $maxElements = [Math]::Max($maxElements, $elements.Count)
    if ($elements.Count -gt 256) { throw 'element_bound' }
    Write-NativeSaveProbe 'controls_query'
    $fileName = $null
    $fileNameValue = $null
    $nativeFilenameHandle = [IntPtr]::Zero
    $button = $null
    $buttonName = if ($Scenario -eq 'open') { 'Open' } elseif ($Scenario -eq 'save') { 'Save' } else { 'Cancel' }
    $editTypes = 0
    $buttonTypes = 0
    $fileLabels = 0
    $actionLabels = 0
    $visibleEnabled = 0
    $eligibleFileLabels = 0
    $valuePatternFileLabels = 0
    $readOnlyFileLabels = 0
    $writableFileDescendants = 0
    $writableLabeledFiles = 0
    $eligibleActionLabels = 0
    $candidateCount = 0
    foreach ($element in $elements) {
      if ($probeCycle) {
        if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { $editTypes++ }
        if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { $buttonTypes++ }
        $fileLabelMatches = $element.Current.Name -eq 'File name:'
        $actionLabelMatches = $element.Current.Name -eq $buttonName
        if ($fileLabelMatches) { $fileLabels++ }
        if ($actionLabelMatches) { $actionLabels++ }
        if (!$element.Current.IsOffscreen -and $element.Current.IsEnabled) {
          $visibleEnabled++
          if ($fileLabelMatches) { $eligibleFileLabels++ }
          if ($actionLabelMatches) { $eligibleActionLabels++ }
        }
      }
      if (!$candidateSnapshotTaken) {
        $snapshotValue = $null
        $hasValue = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$snapshotValue)
        if ($hasValue -or $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
          $candidateCount++
          if ($candidateCount -le 64) {
            $identifier = $element.Current.AutomationId
            if ($identifier -notmatch '^[0-9]{1,6}$' -and $identifier -notin @('FileNameControlHost', 'FileNameControl')) { $identifier = 'none' }
            $nameKind = if ($element.Current.Name -eq 'File name:') { 'filename' } elseif ($element.Current.Name -ceq $expectedFilename) { 'default' } elseif ($element.Current.Name -eq 'File name') { 'filename_plain' } elseif ([string]::IsNullOrEmpty($element.Current.Name)) { 'empty' } else { 'other' }
            $valueKind = 'unsupported'
            $readOnly = 'none'
            if ($hasValue) {
              $readOnly = if ($snapshotValue.Current.IsReadOnly) { 'true' } else { 'false' }
              $valueKind = if ($snapshotValue.Current.Value -ceq $expectedFilename) { 'default' } elseif ([string]::IsNullOrEmpty($snapshotValue.Current.Value)) { 'empty' } else { 'other' }
            }
            $eligible = if (!$element.Current.IsOffscreen -and $element.Current.IsEnabled) { 'true' } else { 'false' }
            [Console]::Error.WriteLine("Native Save candidate probe: type=$($element.Current.ControlType.Id) id=$identifier name=$nameKind value=$valueKind readonly=$readOnly eligible=$eligible")
          }
        }
      }
      if ($element.Current.IsOffscreen -or !$element.Current.IsEnabled) { continue }
      if ($element.Current.Name -eq 'File name:') {
        $candidateValue = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$candidateValue)) {
          $valuePatternFileLabels++
          if ($candidateValue.Current.IsReadOnly) { $readOnlyFileLabels++ } else {
            $fileNames++
            if ($null -ne $fileName) { throw 'filename_ambiguous' }
            $fileName = $element
            $fileNameValue = $candidateValue
          }
        }
      }
      if ($probeCycle) {
        $observedValue = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$observedValue) -and !$observedValue.Current.IsReadOnly) {
          $label = $element.Current.LabeledBy
          if ($null -ne $label -and $label.Current.Name -eq 'File name:') { $writableLabeledFiles++ }
        }
        if ($element.Current.Name -eq 'File name:') {
          $children = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
          if ($children.Count -gt 256) { throw 'element_bound' }
          foreach ($child in $children) {
            if ($child.Current.IsOffscreen -or !$child.Current.IsEnabled) { continue }
            $childValue = $null
            if ($child.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$childValue) -and !$childValue.Current.IsReadOnly) { $writableFileDescendants++ }
          }
        }
      }
      if ($element.Current.Name -eq $buttonName) {
        $actions++
        if ($null -ne $button) { throw 'action_ambiguous' }
        $button = $element
      }
    }
    if ($null -eq $fileName) {
      $filenameHandle = [SaveNativeInput]::FindFilename([IntPtr]$window.Current.NativeWindowHandle, [uint32]$ApplicationPid)
      if ($filenameHandle -ne [IntPtr]::Zero) {
        $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($filenameHandle)
        $candidateValue = $null
        if ($candidate.Current.IsOffscreen -or !$candidate.Current.IsEnabled) { throw 'filename_unavailable' }
        if (!$candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$candidateValue) -or $candidateValue.Current.IsReadOnly) {
          $candidateValue = $null
          $nativeFilenameHandle = $filenameHandle
        }
        $fileNames++
        $fileName = $candidate
        $fileNameValue = $candidateValue
      } else {
        $fallbackMisses = [Math]::Min(999999, $fallbackMisses + 1)
      }
    }
    $candidateSnapshotTaken = $true
    if ($probeCycle) {
      [Console]::Error.WriteLine("Native Save control probe: edits=$editTypes buttons=$buttonTypes file_labels=$fileLabels action_labels=$actionLabels visible_enabled=$visibleEnabled eligible_file_labels=$eligibleFileLabels value_pattern_file_labels=$valuePatternFileLabels readonly_file_labels=$readOnlyFileLabels writable_file_descendants=$writableFileDescendants writable_labeled_files=$writableLabeledFiles eligible_action_labels=$eligibleActionLabels")
    }
    Write-NativeSaveProbe 'controls_read'
    if ($null -eq $fileName -or $null -eq $button) { continue }
    $stage = 'default_filename'
    Write-NativeSaveProbe 'pattern'
    $value = $fileNameValue
    Write-NativeSaveProbe 'value_read'
    $currentFilename = if ($nativeFilenameHandle -ne [IntPtr]::Zero) { [SaveNativeInput]::ReadFilename([IntPtr]$window.Current.NativeWindowHandle, $nativeFilenameHandle, [uint32]$ApplicationPid) } else { $value.Current.Value }
    $defaultKind = if ($currentFilename -ceq $expectedFilename) { 'expected' } elseif ($currentFilename -ceq 'Open Chords') { 'basename' } elseif ($currentFilename -ceq ('Open Chords..' + $extension)) { 'double_dot' } elseif ($currentFilename -ceq ($expectedFilename + '.' + $extension)) { 'double_extension' } elseif ([string]::IsNullOrEmpty($currentFilename)) { 'empty' } else { 'other' }
    [Console]::Error.WriteLine("Native Save default probe: value=$defaultKind")
    if (!$isImport -and $currentFilename -cne $expectedFilename) { throw 'default_filename_invalid' }
    if ($setFilename) {
      $stage = 'filename_set'
      if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw 'target_missing' }
      if ($null -ne $value -and $value.Current.IsReadOnly) { throw 'filename_readonly' }
      Write-NativeSaveProbe 'value_set'
      if ($nativeFilenameHandle -ne [IntPtr]::Zero) {
        [SaveNativeInput]::TypeFilename([IntPtr]$window.Current.NativeWindowHandle, $nativeFilenameHandle, [uint32]$ApplicationPid, $TargetPath)
        $inputDeadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
          $actualFilename = [SaveNativeInput]::ReadFilename([IntPtr]$window.Current.NativeWindowHandle, $nativeFilenameHandle, [uint32]$ApplicationPid)
          if ($actualFilename -ceq $TargetPath) { break }
          Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $inputDeadline)
      } else {
        $value.SetValue($TargetPath)
        $actualFilename = $value.Current.Value
      }
      if ($actualFilename -cne $TargetPath) { throw 'filename_not_set' }
    }
    $stage = 'native_input'
    Write-NativeSaveProbe 'native_input'
    $bounds = $button.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'action_bounds' }
    $dialogHandle = [IntPtr]$window.Current.NativeWindowHandle
    $actionHandle = [IntPtr]$button.Current.NativeWindowHandle
    [SaveNativeInput]::Click($dialogHandle, $actionHandle, [uint32]$ApplicationPid,
      [int][Math]::Floor($bounds.Left + $bounds.Width / 2), [int][Math]::Floor($bounds.Top + $bounds.Height / 2))
    Write-NativeSaveProbe 'action_clicked'
    [SaveNativeInput]::WaitForDismissal($dialogHandle, $actionHandle, $ApplicationPid)
    ConvertTo-Json -InputObject @{ action = $Scenario; filenameSet = $setFilename; nativeClick = $true; dialogDismissed = $true; defaultNameValid = (!$isImport) } -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw 'deadline'
} catch {
  # Only numeric discovery counters leave this process; UI names, paths and exceptions stay private.
  $failureCode = 'unknown'
  $failure = $_.Exception.Message
  if ($failure -in @('filename_unavailable', 'filename_pattern_unavailable', 'filename_ambiguous', 'default_filename_invalid', 'filename_readonly', 'filename_not_set', 'action_ambiguous', 'target_missing', 'action_bounds', 'deadline', 'window_bound', 'element_bound', 'input_assembly_unavailable')) { $failureCode = $failure }
  if ($null -ne $_.Exception.InnerException) {
    switch ($_.Exception.InnerException.Message) {
      'Native Save filename dialog unavailable' { $failureCode = 'filename_dialog_unavailable' }
      'Native Save filename discovery incomplete or ambiguous' { $failureCode = 'filename_scan_ambiguous' }
      'Native Save dialog could not receive input' { $failureCode = 'input_refused' }
      'Native Save input target unavailable' { $failureCode = 'input_target_unavailable' }
      'Native Save foreground refused' { $failureCode = 'input_foreground_refused' }
      'Native Save point root refused' { $failureCode = 'input_point_refused' }
      'Native Save dialog not dismissed' { $failureCode = 'dialog_not_dismissed' }
      'Native Save cursor move refused' { $failureCode = 'input_cursor_refused' }
      'Native Save click was not delivered' { $failureCode = 'input_not_delivered' }
      'Native Save filename target changed' { $failureCode = 'filename_target_changed' }
      'Native Save filename read unavailable' { $failureCode = 'filename_read_unavailable' }
      'Native Save input architecture unsupported' { $failureCode = 'input_architecture_unsupported' }
      'Native Save filename input bound' { $failureCode = 'filename_input_bound' }
      'Native Save filename bounds unavailable' { $failureCode = 'filename_bounds_unavailable' }
      'Native Save filename focus refused' { $failureCode = 'filename_focus_refused' }
      'Native Save filename input not delivered' { $failureCode = 'filename_input_not_delivered' }
    }
  }
  [Console]::Error.WriteLine("native_save_failed code=$failureCode stage=$stage windows=$maxWindows elements=$maxElements filenames=$fileNames actions=$actions fallback_misses=$fallbackMisses")
  exit 1
}
