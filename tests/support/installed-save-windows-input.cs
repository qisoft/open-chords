using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SaveNativeInput {
  private static string ExpectedFilename = "Open Chords.json";
  private static string ExpectedTitle = "Export Open Chords JSON";
  private static int ExpectedFilenameId = 1001;
  public static void ConfigureFormat(string format, bool import) {
    ExpectedFilenameId = import ? 1148 : 1001;
    switch (format) {
      case "json": ExpectedFilename = "Open Chords.json"; ExpectedTitle = "Export Open Chords JSON"; break;
      case "lrc": ExpectedFilename = "Open Chords.lrc"; ExpectedTitle = "Export LRC lyrics"; break;
      case "chordpro": ExpectedFilename = "Open Chords.cho"; ExpectedTitle = "Export ChordPro"; break;
      case "pdf": ExpectedFilename = "Open Chords.pdf"; ExpectedTitle = "Export PDF lead sheet"; break;
      case "media": ExpectedFilename = "Open Chords.wav"; ExpectedTitle = "Open"; break;
      case "archive": ExpectedFilename = "Open Chords.ocarchive"; ExpectedTitle = "Export Portable Project Archive"; break;
      default: throw new InvalidOperationException("Native Save format unavailable");
    }
    if (import) {
      if (format != "archive" && format != "media") throw new InvalidOperationException("Native import format unavailable");
      ExpectedTitle = format == "media" ? "Open" : "Import Portable Project Archive";
    }
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct MouseInput {
    public int dx, dy;
    public uint mouseData, flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct KeyboardInput { public ushort key, scan; public uint flags, time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  private struct Input {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MouseInput mouse;
    [FieldOffset(8)] public KeyboardInput keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)]
  private struct GuiInfo {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public Rect caretRect;
  }
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr window);
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
      string value = !textRead ? "unavailable" : text.ToString() == ExpectedFilename ? "default" : text.Length == 0 ? "empty" : "other";
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
      if (title.ToString() == ExpectedTitle) expectedTitles++;
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
      if (title.ToString() == ExpectedTitle && kind.ToString() == "#32770") {
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
      if (GetAncestor(window, 2) != dialog || !IsWindowVisible(window) || !IsWindowEnabled(window) || GetDlgCtrlID(window) != ExpectedFilenameId) return true;
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
  private static void RequireFilename(IntPtr dialog, IntPtr field, uint processId) {
    if (field == IntPtr.Zero || FindFilename(dialog, processId) != field)
      throw new InvalidOperationException("Native Save filename target changed");
  }
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr ReadFilenameText(IntPtr window, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("kernel32.dll", EntryPoint = "SetLastError", ExactSpelling = true)]
  private static extern void ClearFilenameReadError(uint code);
  public static bool FilenameReady(IntPtr dialog, IntPtr field, uint processId, int budgetMs) {
    if (budgetMs < 1 || budgetMs > 50) throw new InvalidOperationException("Native Save filename readiness unavailable");
    RequireFilename(dialog, field, processId);
    uint owner;
    uint thread = GetWindowThreadProcessId(field, out owner);
    var info = new GuiInfo { size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
    if (owner != processId || thread == 0 || GetForegroundWindow() != dialog ||
        !GetGUIThreadInfo(thread, ref info) || info.active != dialog || info.focus != field)
      throw new InvalidOperationException("Native Save filename readiness unavailable");
    UIntPtr result;
    return SendMessageTimeout(field, 0, UIntPtr.Zero, IntPtr.Zero, 2, (uint)budgetMs, out result) != IntPtr.Zero;
  }
  public static string ReadFilename(IntPtr dialog, IntPtr field, uint processId) {
    RequireFilename(dialog, field, processId);
    var text = new StringBuilder(4096);
    UIntPtr result;
    var readStarted = System.Diagnostics.Stopwatch.StartNew();
    // SendMessageTimeout may return zero without setting an error. Clear it first,
    // then capture the P/Invoke error immediately, before any diagnostic reads.
    ClearFilenameReadError(0);
    bool completed = ReadFilenameText(field, 0x000D, (UIntPtr)(uint)text.Capacity, text, 2, 250, out result) != IntPtr.Zero;
    int readError = Marshal.GetLastWin32Error();
    long readDurationMs = readStarted.ElapsedMilliseconds;
    if (!completed || result.ToUInt64() >= 4095) {
      uint dialogPid, fieldPid;
      GetWindowThreadProcessId(dialog, out dialogPid);
      GetWindowThreadProcessId(field, out fieldPid);
      Console.Error.WriteLine("Native Save filename error probe: error_code=" + Math.Min(999999, Math.Max(0, readError)) +
        " dialog_pid_match=" + (dialogPid == processId).ToString().ToLowerInvariant() +
        " field_pid_match=" + (fieldPid == processId).ToString().ToLowerInvariant() +
        " field_id_match=" + (GetDlgCtrlID(field) == ExpectedFilenameId).ToString().ToLowerInvariant() +
        " foreground_dialog=" + (GetForegroundWindow() == dialog).ToString().ToLowerInvariant());
      Console.Error.WriteLine("Native Save filename read probe: completed=" + completed.ToString().ToLowerInvariant() +
        " length_bound=" + (completed ? (result.ToUInt64() >= 4095).ToString().ToLowerInvariant() : "unknown") +
        " duration_ms=" + Math.Min(999999, readDurationMs) +
        " dialog_exists=" + IsWindow(dialog).ToString().ToLowerInvariant() +
        " field_exists=" + IsWindow(field).ToString().ToLowerInvariant() +
        " field_child=" + IsChild(dialog, field).ToString().ToLowerInvariant());
      try {
        ProbeInputTarget(dialog, field, processId, "filename_read_failure");
        Console.Error.WriteLine("Native Save filename response probe: dialog_responsive=" + Responsive(dialog) +
          " field_responsive=" + Responsive(field));
      }
      catch { Console.Error.WriteLine("Native Save filename thread probe: unavailable"); }
      throw new InvalidOperationException("Native Save filename read unavailable");
    }
    return text.ToString();
  }
  public static void TypeFilename(IntPtr dialog, IntPtr field, uint processId, string target) {
    RequireFilename(dialog, field, processId);
    if (IntPtr.Size != 8) throw new InvalidOperationException("Native Save input architecture unsupported");
    if (String.IsNullOrEmpty(target) || target.Length > 1024)
      throw new InvalidOperationException("Native Save filename input bound");
    Rect bounds;
    if (!GetWindowRect(field, out bounds) || bounds.right <= bounds.left || bounds.bottom <= bounds.top)
      throw new InvalidOperationException("Native Save filename bounds unavailable");
    Click(dialog, field, processId, bounds.left + (bounds.right - bounds.left) / 2, bounds.top + (bounds.bottom - bounds.top) / 2);
    uint owner;
    uint thread = GetWindowThreadProcessId(field, out owner);
    bool focused = false;
    var focusWait = System.Diagnostics.Stopwatch.StartNew();
    do {
      var info = new GuiInfo { size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
      if (GetForegroundWindow() == dialog && GetGUIThreadInfo(thread, ref info) && info.focus == field) { focused = true; break; }
      System.Threading.Thread.Sleep(20);
    } while (focusWait.ElapsedMilliseconds < 1000);
    if (!focused) throw new InvalidOperationException("Native Save filename focus refused");
    RequireFilename(dialog, field, processId);
    var inputs = new Input[4 + target.Length * 2];
    inputs[0] = new Input { type = 1, keyboard = new KeyboardInput { key = 0x11 } };
    inputs[1] = new Input { type = 1, keyboard = new KeyboardInput { key = 0x41 } };
    inputs[2] = new Input { type = 1, keyboard = new KeyboardInput { key = 0x41, flags = 2 } };
    inputs[3] = new Input { type = 1, keyboard = new KeyboardInput { key = 0x11, flags = 2 } };
    for (int i = 0; i < target.Length; i++) {
      inputs[4 + i * 2] = new Input { type = 1, keyboard = new KeyboardInput { scan = target[i], flags = 4 } };
      inputs[5 + i * 2] = new Input { type = 1, keyboard = new KeyboardInput { scan = target[i], flags = 6 } };
    }
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
      throw new InvalidOperationException("Native Save filename input not delivered");
  }
  public static void Click(IntPtr window, IntPtr control, uint expectedProcessId, int x, int y) {
    if (!OwnedByApplication(window, expectedProcessId) ||
        !IsWindowVisible(window) || !IsWindowEnabled(window))
      throw new InvalidOperationException("Native Save input target unavailable");
    SetForegroundWindow(window);
    var activation = System.Diagnostics.Stopwatch.StartNew();
    while (activation.ElapsedMilliseconds < 1000) {
      if (!OwnedByApplication(window, expectedProcessId) || !IsWindowVisible(window) || !IsWindowEnabled(window))
        throw new InvalidOperationException("Native Save input target unavailable");
      if (GetForegroundWindow() == window && GetAncestor(WindowFromPoint(new Point { x = x, y = y }), 2) == window)
        break;
      System.Threading.Thread.Sleep(20);
    }
    if (GetForegroundWindow() != window)
      throw new InvalidOperationException("Native Save foreground refused");
    var pointRoot = GetAncestor(WindowFromPoint(new Point { x = x, y = y }), 2);
    if (pointRoot != window) {
      Rect dialogBounds;
      bool inside = GetWindowRect(window, out dialogBounds) && x >= dialogBounds.left && x < dialogBounds.right && y >= dialogBounds.top && y < dialogBounds.bottom;
      string hit = pointRoot == IntPtr.Zero ? "none" : OwnedByApplication(pointRoot, expectedProcessId) ? "owned_other" : "foreign";
      int awareness = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
      Console.Error.WriteLine("Native Save point probe: inside_dialog=" + inside.ToString().ToLowerInvariant() + " hit=" + hit + " awareness=" + awareness);
      throw new InvalidOperationException("Native Save point root refused");
    }
    if (!SetCursorPos(x, y))
      throw new InvalidOperationException("Native Save cursor move refused");
    var clickedControl = WindowFromPoint(new Point { x = x, y = y });
    Point cursor;
    bool cursorMatches = GetCursorPos(out cursor) && cursor.x == x && cursor.y == y;
    bool known = control != IntPtr.Zero && IsWindow(control);
    Console.Error.WriteLine("Native Save click probe: control_known=" + known.ToString().ToLowerInvariant() +
      " hit_control=" + (known && clickedControl == control).ToString().ToLowerInvariant() +
      " hit_child=" + (known && IsChild(control, clickedControl)).ToString().ToLowerInvariant() +
      " cursor_match=" + cursorMatches.ToString().ToLowerInvariant());
    LastClickPoint = new Point { x = x, y = y };
    ProbePointer(window, control, expectedProcessId, "before_input");
    ProbeForeground(window, expectedProcessId, "before_input");
    var inputs = new[] {
      new Input { type = 0, mouse = new MouseInput { flags = 0x0002 } },
      new Input { type = 0, mouse = new MouseInput { flags = 0x0004 } }
    };
    LastClick = System.Diagnostics.Stopwatch.StartNew();
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
      throw new InvalidOperationException("Native Save click was not delivered");
    ProbeForeground(window, expectedProcessId, "after_input");
    ProbeActivation(expectedProcessId, "after_input");
    ProbePointer(window, control, expectedProcessId, "after_input");
    ProbeInputTarget(window, control, expectedProcessId, "after_input");
  }
  private static void ProbeInputTarget(IntPtr dialog, IntPtr control, uint expectedProcessId, string phase) {
    bool known = control != IntPtr.Zero && IsWindow(control);
    bool child = known && IsChild(dialog, control) && GetAncestor(control, 2) == dialog;
    var kind = new StringBuilder(64);
    if (known) GetClassName(control, kind, kind.Capacity);
    string controlClass = !known ? "none" : kind.ToString() == "Button" ? "button" :
      kind.ToString() == "Edit" ? "edit" : "other";
    int id = known ? GetDlgCtrlID(control) : -1;
    string controlId = !known ? "none" : id == 2 ? "cancel" : id == 1 ? "primary" :
      id == ExpectedFilenameId ? "filename" : "other";
    uint processId;
    uint thread = IsWindow(dialog) ? GetWindowThreadProcessId(dialog, out processId) : 0;
    var info = new GuiInfo { size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
    bool threadKnown = thread != 0 && GetGUIThreadInfo(thread, ref info);
    Console.Error.WriteLine("Native Save input target probe: phase=" + phase + " class=" + controlClass +
      " id=" + controlId + " child=" + child.ToString().ToLowerInvariant() +
      " owned=" + (known && OwnedByApplication(control, expectedProcessId)).ToString().ToLowerInvariant() +
      " thread_known=" + threadKnown.ToString().ToLowerInvariant() +
      " active_dialog=" + (threadKnown ? (info.active == dialog).ToString().ToLowerInvariant() : "unknown") +
      " focus_control=" + (threadKnown && known ? (info.focus == control).ToString().ToLowerInvariant() : "unknown") +
      " capture_control=" + (threadKnown && known ? (info.capture == control).ToString().ToLowerInvariant() : "unknown"));
  }
  private static Point LastClickPoint;
  private static void ProbePointer(IntPtr dialog, IntPtr control, uint expectedProcessId, string phase) {
    Point cursor;
    bool cursorKnown = GetCursorPos(out cursor);
    IntPtr hit = cursorKnown ? WindowFromPoint(cursor) : IntPtr.Zero;
    IntPtr root = GetAncestor(hit, 2);
    string category = root == IntPtr.Zero ? "none" : root == dialog ? "dialog" :
      OwnedByApplication(root, expectedProcessId) ? "owned_other" : "foreign";
    int modifiers = ((GetAsyncKeyState(0x10) & 0x8000) != 0 ? 1 : 0) |
      ((GetAsyncKeyState(0x11) & 0x8000) != 0 ? 2 : 0) |
      ((GetAsyncKeyState(0x12) & 0x8000) != 0 ? 4 : 0) |
      (((GetAsyncKeyState(0x5B) | GetAsyncKeyState(0x5C)) & 0x8000) != 0 ? 8 : 0);
    Console.Error.WriteLine("Native Save pointer probe: phase=" + phase +
      " cursor_match=" + (cursorKnown && cursor.x == LastClickPoint.x && cursor.y == LastClickPoint.y).ToString().ToLowerInvariant() +
      " point_root=" + category + " hit_control=" + (control != IntPtr.Zero && hit == control).ToString().ToLowerInvariant() +
      " foreground_at_point=" + (root != IntPtr.Zero && root == GetForegroundWindow()).ToString().ToLowerInvariant() +
      " left_down=" + ((GetAsyncKeyState(1) & 0x8000) != 0).ToString().ToLowerInvariant() +
      " modifier_mask=" + modifiers);
  }
  private static System.Diagnostics.Stopwatch LastClick;
  private static void ProbeActivation(uint expectedProcessId, string phase) {
    uint processId;
    IntPtr foreground = GetForegroundWindow();
    GetWindowThreadProcessId(foreground, out processId);
    string category = foreground == IntPtr.Zero ? "none" : processId == expectedProcessId ? "application" :
      processId == (uint)System.Diagnostics.Process.GetCurrentProcess().Id ? "driver" : "unavailable";
    if (category == "unavailable") {
      try {
        using (var process = System.Diagnostics.Process.GetProcessById((int)processId)) {
          switch (process.ProcessName.ToLowerInvariant()) {
            case "conhost": case "openconsole": category = "console"; break;
            case "windowsterminal": category = "terminal"; break;
            case "explorer": case "shellexperiencehost": case "startmenuexperiencehost": category = "shell"; break;
            case "runner.worker": case "runner.listener": category = "runner"; break;
            default: category = "other"; break;
          }
        }
      } catch { category = "unavailable"; }
    }
    Console.Error.WriteLine("Native Save activation probe: phase=" + phase + " process=" + category +
      " elapsed_ms=" + (LastClick == null ? 0 : Math.Min(LastClick.ElapsedMilliseconds, 999999999)));
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, IntPtr data, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
  private static void ProbeForeground(IntPtr dialog, uint expectedProcessId, string phase) {
    IntPtr foreground = GetForegroundWindow();
    uint processId;
    GetWindowThreadProcessId(foreground, out processId);
    string kind = foreground == IntPtr.Zero ? "none" : foreground == dialog ? "dialog" :
      processId == expectedProcessId ? "application" : OwnedByApplication(foreground, expectedProcessId) ? "owned_other" :
      processId == (uint)System.Diagnostics.Process.GetCurrentProcess().Id ? "driver" : "foreign";
    var windowClass = new StringBuilder(64);
    GetClassName(foreground, windowClass, windowClass.Capacity);
    string category = foreground == IntPtr.Zero ? "none" : windowClass.ToString() == "#32770" ? "dialog" : "other";
    Console.Error.WriteLine("Native Save foreground probe: phase=" + phase + " kind=" + kind + " class=" + category +
      " visible=" + IsWindowVisible(foreground).ToString().ToLowerInvariant() +
      " enabled=" + IsWindowEnabled(foreground).ToString().ToLowerInvariant());
  }
  private static string Responsive(IntPtr window) {
    UIntPtr result;
    return (SendMessageTimeout(window, 0, UIntPtr.Zero, IntPtr.Zero, 2, 50, out result) != IntPtr.Zero).ToString().ToLowerInvariant();
  }
  private static void ProbeDismissalResponse(IntPtr window, IntPtr control, uint expectedProcessId) {
    bool owned = IsWindow(window) && OwnedByApplication(window, expectedProcessId);
    bool knownControl = owned && control != IntPtr.Zero && IsWindow(control) && IsChild(window, control) && GetAncestor(control, 2) == window;
    uint processId;
    uint thread = owned ? GetWindowThreadProcessId(window, out processId) : 0;
    var info = new GuiInfo { size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
    bool threadKnown = thread != 0 && GetGUIThreadInfo(thread, ref info);
    Console.Error.WriteLine("Native Save response probe: dialog_responsive=" + (owned ? Responsive(window) : "unknown") +
      " control_responsive=" + (knownControl ? Responsive(control) : "unknown") +
      " focus_control=" + (knownControl && threadKnown ? (info.focus == control).ToString().ToLowerInvariant() : "unknown") +
      " capture_control=" + (knownControl && threadKnown ? (info.capture == control).ToString().ToLowerInvariant() : "unknown") +
      " left_down=" + ((GetAsyncKeyState(1) & 0x8000) != 0).ToString().ToLowerInvariant() +
      " foreground_dialog=" + (GetForegroundWindow() == window).ToString().ToLowerInvariant());
  }
  public static void WaitForDismissal(IntPtr window, IntPtr control, uint expectedProcessId) {
    var elapsed = System.Diagnostics.Stopwatch.StartNew();
    long firstHiddenMs = -1;
    int visibilityChanges = 0;
    bool? previousVisible = null;
    while (IsWindow(window) && elapsed.ElapsedMilliseconds < 2000) {
      bool visible = IsWindowVisible(window);
      if (!visible && firstHiddenMs < 0) firstHiddenMs = elapsed.ElapsedMilliseconds;
      if (previousVisible.HasValue && previousVisible.Value != visible) visibilityChanges = Math.Min(256, visibilityChanges + 1);
      previousVisible = visible;
      System.Threading.Thread.Sleep(20);
    }
    if (IsWindow(window)) {
      Console.Error.WriteLine("Native Save dismissal visibility probe: first_hidden_ms=" +
        (firstHiddenMs < 0 ? "unknown" : Math.Min(999999, firstHiddenMs).ToString()) +
        " changes=" + visibilityChanges);
      uint dialogPid, controlPid, foregroundPid;
      GetWindowThreadProcessId(window, out dialogPid);
      GetWindowThreadProcessId(control, out controlPid);
      GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      var dialogClass = new StringBuilder(64);
      GetClassName(window, dialogClass, dialogClass.Capacity);
      Console.Error.WriteLine("Native Save dismissal identity probe: dialog_pid_match=" + (dialogPid == expectedProcessId).ToString().ToLowerInvariant() +
        " class_dialog=" + (dialogClass.ToString() == "#32770").ToString().ToLowerInvariant() +
        " control_pid_match=" + (controlPid == expectedProcessId).ToString().ToLowerInvariant() +
        " foreground_application=" + (foregroundPid == expectedProcessId).ToString().ToLowerInvariant());
      Console.Error.WriteLine("Native Save dismissal probe: exists=true visible=" + IsWindowVisible(window).ToString().ToLowerInvariant() +
        " enabled=" + IsWindowEnabled(window).ToString().ToLowerInvariant() + " owned=" + OwnedByApplication(window, expectedProcessId).ToString().ToLowerInvariant());
      ProbeDismissalResponse(window, control, expectedProcessId);
      ProbeForeground(window, expectedProcessId, "dismissal");
      ProbeActivation(expectedProcessId, "dismissal");
      ProbePointer(window, control, expectedProcessId, "dismissal");
      ProbeInputTarget(window, control, expectedProcessId, "dismissal");
      throw new InvalidOperationException("Native Save dialog not dismissed");
    }
  }
}
