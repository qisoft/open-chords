param([int]$ApplicationPid, [ValidateSet('cancel', 'save')][string]$Scenario, [string]$TargetPath)
$ErrorActionPreference = 'Stop'
$maxWindows = 0
$maxElements = 0
$fileNames = 0
$actions = 0
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
Write-NativeSaveProbe 'compile'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SaveNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  private struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct MouseInput {
    public int dx, dy;
    public uint mouseData, flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Input {
    public uint type;
    public MouseInput mouse;
  }
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
  private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  public static string ProbeChildren(IntPtr dialog, uint expectedProcessId) {
    if (!OwnedByApplication(dialog, expectedProcessId) || !IsWindowVisible(dialog))
      throw new InvalidOperationException("Native Save child probe target unavailable");
    int visited = 0;
    var output = new StringBuilder();
    EnumWindowProc callback = (window, parameter) => {
      if (++visited > 128) return false;
      if (GetAncestor(window, 2) != dialog) return true;
      var kind = new StringBuilder(64);
      var text = new StringBuilder(256);
      GetClassName(window, kind, kind.Capacity);
      UIntPtr textResult;
      bool textRead = SendMessageTimeout(window, 0x000D, (UIntPtr)(uint)text.Capacity, text, 2, 50, out textResult) != IntPtr.Zero;
      string category = kind.ToString() == "Edit" ? "edit" : kind.ToString() == "ComboBox" ? "combo" : kind.ToString() == "Static" ? "static" : "other";
      string value = !textRead ? "unavailable" : text.ToString() == "Open Chords.json" ? "default" : text.Length == 0 ? "empty" : "other";
      int id = GetDlgCtrlID(window);
      if (id < -1 || id > 999999) id = -1;
      output.AppendLine("Native Save child probe: id=" + id + " class=" + category + " text=" + value + " eligible=" +
        (IsWindowVisible(window) && IsWindowEnabled(window) ? "true" : "false"));
      return true;
    };
    EnumChildWindows(dialog, callback, IntPtr.Zero);
    output.Append("Native Save child scan: visited=" + Math.Min(visited, 129) + " truncated=" + (visited > 128 ? "true" : "false"));
    return output.ToString();
  }
  public static string Probe(uint expectedProcessId) {
    int visited = 0, owned = 0, expectedTitles = 0, saveAsTitles = 0, dialogs = 0;
    bool truncated = false;
    EnumWindowProc callback = (window, parameter) => {
      if (++visited > 256) { truncated = true; return false; }
      uint processId, ownerProcessId;
      GetWindowThreadProcessId(window, out processId);
      GetWindowThreadProcessId(GetWindow(window, 4), out ownerProcessId);
      if (!IsWindowVisible(window) || (processId != expectedProcessId && ownerProcessId != expectedProcessId)) return true;
      owned++;
      var title = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      if (title.ToString() == "Export Open Chords JSON") expectedTitles++;
      if (title.ToString() == "Save As") saveAsTitles++;
      var kind = new StringBuilder(64);
      GetClassName(window, kind, kind.Capacity);
      if (kind.ToString() == "#32770") dialogs++;
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    return "Native Save window probe: owned=" + owned + " expected_titles=" + expectedTitles +
      " save_as_titles=" + saveAsTitles + " dialogs=" + dialogs +
      " truncated=" + (truncated ? "true" : "false");
  }
  private static bool OwnedByApplication(IntPtr window, uint expectedProcessId) {
    uint processId, ownerProcessId;
    GetWindowThreadProcessId(window, out processId);
    GetWindowThreadProcessId(GetWindow(window, 4), out ownerProcessId);
    return processId == expectedProcessId || ownerProcessId == expectedProcessId;
  }
  public static IntPtr FindDialog(uint expectedProcessId) {
    int visited = 0, matches = 0;
    bool truncated = false;
    IntPtr result = IntPtr.Zero;
    EnumWindowProc callback = (window, parameter) => {
      if (++visited > 256) { truncated = true; return false; }
      if (!IsWindowVisible(window) || !IsWindowEnabled(window) || !OwnedByApplication(window, expectedProcessId)) return true;
      var title = new StringBuilder(256);
      var kind = new StringBuilder(64);
      GetWindowText(window, title, title.Capacity);
      GetClassName(window, kind, kind.Capacity);
      if (title.ToString() == "Export Open Chords JSON" && kind.ToString() == "#32770") {
        matches++;
        result = window;
      }
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    if (truncated || matches > 1) throw new InvalidOperationException("Native Save dialog discovery incomplete or ambiguous");
    return result;
  }
  public static IntPtr FindFilename(IntPtr dialog, uint expectedProcessId) {
    if (!OwnedByApplication(dialog, expectedProcessId) || !IsWindowVisible(dialog) || !IsWindowEnabled(dialog))
      throw new InvalidOperationException("Native Save filename dialog unavailable");
    int visited = 0, matches = 0;
    bool truncated = false;
    IntPtr result = IntPtr.Zero;
    EnumWindowProc callback = (window, parameter) => {
      if (++visited > 128) { truncated = true; return false; }
      if (GetAncestor(window, 2) != dialog || !IsWindowVisible(window) || !IsWindowEnabled(window) || GetDlgCtrlID(window) != 1001) return true;
      var kind = new StringBuilder(64);
      GetClassName(window, kind, kind.Capacity);
      if (kind.ToString() != "Edit") return true;
      matches++;
      result = window;
      return true;
    };
    EnumChildWindows(dialog, callback, IntPtr.Zero);
    if (truncated || matches > 1) throw new InvalidOperationException("Native Save filename discovery incomplete or ambiguous");
    return result;
  }
  public static void Click(IntPtr window, uint expectedProcessId, int x, int y) {
    if (!OwnedByApplication(window, expectedProcessId) ||
        !IsWindowVisible(window) || !IsWindowEnabled(window))
      throw new InvalidOperationException("Native Save input target unavailable");
    SetForegroundWindow(window);
    if (GetForegroundWindow() != window ||
        GetAncestor(WindowFromPoint(new Point { x = x, y = y }), 2) != window || !SetCursorPos(x, y))
      throw new InvalidOperationException("Native Save dialog could not receive input");
    var inputs = new[] {
      new Input { type = 0, mouse = new MouseInput { flags = 0x0002 } },
      new Input { type = 0, mouse = new MouseInput { flags = 0x0004 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("Native Save click was not delivered");
  }
}
'@

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
    if ($window.Current.Name -ne 'Export Open Chords JSON') { continue }
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
    $button = $null
    $buttonName = if ($Scenario -eq 'cancel') { 'Cancel' } else { 'Save' }
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
            $nameKind = if ($element.Current.Name -eq 'File name:') { 'filename' } elseif ($element.Current.Name -eq 'Open Chords.json') { 'default' } elseif ($element.Current.Name -eq 'File name') { 'filename_plain' } elseif ([string]::IsNullOrEmpty($element.Current.Name)) { 'empty' } else { 'other' }
            $valueKind = 'unsupported'
            $readOnly = 'none'
            if ($hasValue) {
              $readOnly = if ($snapshotValue.Current.IsReadOnly) { 'true' } else { 'false' }
              $valueKind = if ($snapshotValue.Current.Value -eq 'Open Chords.json') { 'default' } elseif ([string]::IsNullOrEmpty($snapshotValue.Current.Value)) { 'empty' } else { 'other' }
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
        if (!$candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$candidateValue) -or $candidateValue.Current.IsReadOnly) { throw 'filename_pattern_unavailable' }
        $fileNames++
        $fileName = $candidate
        $fileNameValue = $candidateValue
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
    if ($value.Current.Value -ne 'Open Chords.json') { throw 'default_filename_invalid' }
    if ($Scenario -eq 'save') {
      $stage = 'filename_set'
      if ([string]::IsNullOrWhiteSpace($TargetPath)) { throw 'target_missing' }
      if ($value.Current.IsReadOnly) { throw 'filename_readonly' }
      Write-NativeSaveProbe 'value_set'
      $value.SetValue($TargetPath)
      if ($value.Current.Value -ne $TargetPath) { throw 'filename_not_set' }
    }
    $stage = 'native_input'
    Write-NativeSaveProbe 'native_input'
    $bounds = $button.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'action_bounds' }
    [SaveNativeInput]::Click([IntPtr]$window.Current.NativeWindowHandle, [uint32]$ApplicationPid,
      [int][Math]::Floor($bounds.Left + $bounds.Width / 2), [int][Math]::Floor($bounds.Top + $bounds.Height / 2))
    Write-NativeSaveProbe 'action_clicked'
    ConvertTo-Json -InputObject @{ action = $Scenario; filenameSet = ($Scenario -eq 'save'); nativeClick = $true; defaultNameValid = $true } -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
throw 'deadline'
} catch {
  # Only numeric discovery counters leave this process; UI names, paths and exceptions stay private.
  [Console]::Error.WriteLine("native_save_failed stage=$stage windows=$maxWindows elements=$maxElements filenames=$fileNames actions=$actions")
  exit 1
}
