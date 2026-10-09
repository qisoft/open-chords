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
  public static string Probe(uint expectedProcessId) {
    int visited = 0, owned = 0, expectedTitles = 0, saveAsTitles = 0, dialogs = 0;
    EnumWindowProc callback = (window, parameter) => {
      if (++visited > 256) return false;
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
      " save_as_titles=" + saveAsTitles + " dialogs=" + dialogs;
  }
  public static void Click(IntPtr window, uint expectedProcessId, int x, int y) {
    uint processId;
    if (GetWindowThreadProcessId(window, out processId) == 0 || processId != expectedProcessId ||
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
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationPid)
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
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  $maxWindows = [Math]::Max($maxWindows, $windows.Count)
  if ($windows.Count -gt 16) { throw 'window_bound' }
  Write-NativeSaveProbe 'windows_read'
  foreach ($window in $windows) {
    Write-NativeSaveProbe 'window_properties'
    if ($window.Current.Name -ne 'Export Open Chords JSON') { continue }
    Write-NativeSaveProbe 'elements_query'
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $maxElements = [Math]::Max($maxElements, $elements.Count)
    if ($elements.Count -gt 256) { throw 'element_bound' }
    Write-NativeSaveProbe 'controls_query'
    $fileName = $null
    $button = $null
    $buttonName = if ($Scenario -eq 'cancel') { 'Cancel' } else { 'Save' }
    foreach ($element in $elements) {
      if ($element.Current.IsOffscreen -or !$element.Current.IsEnabled) { continue }
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $element.Current.Name -eq 'File name:') {
        $fileNames++
        if ($null -ne $fileName) { throw 'filename_ambiguous' }
        $fileName = $element
      }
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.Name -eq $buttonName) {
        $actions++
        if ($null -ne $button) { throw 'action_ambiguous' }
        $button = $element
      }
    }
    Write-NativeSaveProbe 'controls_read'
    if ($null -eq $fileName -or $null -eq $button) { continue }
    $stage = 'default_filename'
    Write-NativeSaveProbe 'pattern'
    $value = $fileName.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
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
