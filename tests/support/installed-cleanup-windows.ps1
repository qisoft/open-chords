param([int]$ApplicationPid, [string]$Scenario)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CleanupNativeInput {
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
  public static void Click(IntPtr window, uint expectedProcessId, int x, int y) {
    uint processId;
    if (GetWindowThreadProcessId(window, out processId) == 0 || processId != expectedProcessId ||
        !IsWindowVisible(window) || !IsWindowEnabled(window))
      throw new InvalidOperationException("Native cleanup input target unavailable");
    SetForegroundWindow(window);
    if (GetForegroundWindow() != window ||
        GetAncestor(WindowFromPoint(new Point { x = x, y = y }), 2) != window || !SetCursorPos(x, y))
      throw new InvalidOperationException("Native cleanup dialog could not receive input");
    var inputs = new[] {
      new Input { type = 0, mouse = new MouseInput { flags = 0x0002 } },
      new Input { type = 0, mouse = new MouseInput { flags = 0x0004 } }
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("Native cleanup click was not delivered");
  }
}
'@
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
$events = [System.Collections.Generic.List[object]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($null -eq (Get-Process -Id $ApplicationPid -ErrorAction SilentlyContinue)) {
    ConvertTo-Json -InputObject @($events.ToArray()) -Compress
    exit 0
  }
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $category = $null
    foreach ($key in $labels.Keys) {
      foreach ($element in $elements) {
        if ($element.Current.Name -eq $labels[$key]) { $category = $key; break }
      }
      if ($null -ne $category) { break }
    }
    if ($null -eq $category) { continue }
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
      if ($element.Current.Name -eq $buttonName) {
        if (!$element.Current.IsOffscreen -and $element.Current.IsEnabled) {
          if ($null -ne $button) { throw 'Native cleanup action label was ambiguous' }
          $button = $element
        }
      }
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
    $events.Add(@{ category = $category; checked = ($selectModels -or $confirmFinal); action = $buttonName })
    $seen[$identity] = $true
    $bounds = $button.Current.BoundingRectangle
    if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) {
      throw 'Native cleanup action has no visible bounds'
    }
    [CleanupNativeInput]::Click(
      [IntPtr]$window.Current.NativeWindowHandle,
      [uint32]$ApplicationPid,
      [int][Math]::Floor($bounds.Left + $bounds.Width / 2),
      [int][Math]::Floor($bounds.Top + $bounds.Height / 2)
    )
  }
  Start-Sleep -Milliseconds 100
}
throw 'Installed cleanup native dialog driver timed out'
