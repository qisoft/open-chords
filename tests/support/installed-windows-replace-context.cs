using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class WindowsReplacementContext {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);

  public static void VerifyFixture(string target) {
    try { VerifyFixtureCore(target); }
    catch (IOException) { Console.Error.WriteLine("Native Windows replacement fixture exception: kind=io"); throw; }
    catch (UnauthorizedAccessException) { Console.Error.WriteLine("Native Windows replacement fixture exception: kind=access"); throw; }
    catch (ArgumentException) { Console.Error.WriteLine("Native Windows replacement fixture exception: kind=argument"); throw; }
  }
  private static InvalidOperationException RefuseFixture(string check) {
    Console.Error.WriteLine("Native Windows replacement fixture refusal: check=" + check);
    return new InvalidOperationException("Replacement fixture unavailable");
  }
  private static void VerifyFixtureCore(string target) {
    byte[] expected = Encoding.UTF8.GetBytes("private existing Windows replacement target fixture");
    string root = Path.GetPathRoot(target);
    if (!Path.IsPathRooted(target) || root.Length != 3 || !Char.IsLetter(root[0]) || root[1] != ':' || root[2] != '\\')
      throw RefuseFixture("local_path");
    if (!String.Equals(Path.GetFullPath(target), target, StringComparison.OrdinalIgnoreCase))
      throw RefuseFixture("full_path");
    if (Path.GetFileName(target) != "Open Chords.json") throw RefuseFixture("filename");
    for (var directory = new DirectoryInfo(Path.GetDirectoryName(target)); directory != null; directory = directory.Parent) {
      if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
        throw RefuseFixture("parent_reparse");
    }
    // OPEN_REPARSE_POINT prevents following a substituted final symlink; inspect the actual opened handle.
    using (var handle = CreateFile(target, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      FileInformation information;
      if (handle.IsInvalid) throw RefuseFixture("handle_open");
      if (!GetFileInformationByHandle(handle, out information)) throw RefuseFixture("handle_info");
      if ((information.attributes & (0x400U | 0x10U)) != 0) throw RefuseFixture("file_type");
      if (information.links != 1) throw RefuseFixture("link_count");
      if (information.sizeHigh != 0 || information.sizeLow != expected.Length) throw RefuseFixture("size");
      using (var stream = new FileStream(handle, FileAccess.Read)) {
        for (int index = 0; index < expected.Length; index++) {
          if (stream.ReadByte() != expected[index]) throw RefuseFixture("content");
        }
        if (stream.ReadByte() != -1) throw RefuseFixture("eof");
      }
    }
  }

  private static bool Owned(IntPtr window, uint expectedPid) {
    uint pid;
    return IsWindow(window) && GetWindowThreadProcessId(window, out pid) != 0 && pid == expectedPid;
  }
  private static string Boolean(bool value) { return value ? "true" : "false"; }

  public static string Observe(IntPtr capturedSave, uint expectedPid, int budgetMs) {
    if (budgetMs <= 0 || budgetMs > 2000 || !Owned(capturedSave, expectedPid))
      throw new InvalidOperationException("Replacement context unavailable");
    var deadline = DateTime.UtcNow.AddMilliseconds(budgetMs);
    string status = "complete";
    int windows = 0, dialogs = 0, ownedBySave = 0, buttons = 0, yes = 0, no = 0, cancel = 0, replace = 0, other = 0;
    for (int observation = 0; observation < 32; observation++) {
      if (DateTime.UtcNow >= deadline) break;
      status = "complete";
      windows = dialogs = ownedBySave = buttons = yes = no = cancel = replace = other = 0;
      int scanned = 0, children = 0;
      WindowCallback top = (window, parameter) => {
        if (DateTime.UtcNow >= deadline) { status = "deadline"; return false; }
        if (++scanned > 256) { status = "bound"; return false; }
        if (!Owned(window, expectedPid) || !IsWindowVisible(window)) return true;
        if (++windows > 16) { status = "bound"; return false; }
        if (window == capturedSave) return true;
        var kind = new StringBuilder(64);
        if (GetClassName(window, kind, kind.Capacity) == 0) { status = "read_error"; return false; }
        if (kind.ToString() != "#32770") return true;
        dialogs++;
        if (GetWindow(window, 4) == capturedSave) ownedBySave++;
        WindowCallback child = (control, unused) => {
          if (DateTime.UtcNow >= deadline) { status = "deadline"; return false; }
          if (++children > 256) { status = "bound"; return false; }
          if (!Owned(control, expectedPid)) { status = "read_error"; return false; }
          if (!IsWindowVisible(control)) return true;
          var controlClass = new StringBuilder(64);
          if (GetClassName(control, controlClass, controlClass.Capacity) == 0) { status = "read_error"; return false; }
          if (controlClass.ToString() != "Button") return true;
          buttons++;
          var text = new StringBuilder(128);
          UIntPtr textResult;
          int remaining = Math.Min(50, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
          if (remaining <= 0) { status = "deadline"; return false; }
          if (SendMessageTimeout(control, 0x000D, (UIntPtr)(uint)text.Capacity, text, 2, (uint)remaining, out textResult) == IntPtr.Zero) {
            status = "read_error"; return false;
          }
          string title = text.ToString();
          if (IsWindowEnabled(control) && (title == "Yes" || title == "&Yes")) yes++;
          else if (IsWindowEnabled(control) && (title == "No" || title == "&No")) no++;
          else if (IsWindowEnabled(control) && (title == "Cancel" || title == "&Cancel")) cancel++;
          else if (IsWindowEnabled(control) && (title == "Replace" || title == "&Replace")) replace++;
          else other++;
          return true;
        };
        bool enumerated = EnumChildWindows(window, child, IntPtr.Zero);
        if (!enumerated && status == "complete") status = "read_error";
        return status == "complete";
      };
      bool completed = EnumWindows(top, IntPtr.Zero);
      if (!completed && status == "complete") status = "read_error";
      if (status != "complete" || dialogs != 0 || !Owned(GetForegroundWindow(), expectedPid)) break;
      int delay = Math.Min(50, Math.Max(0, (int)(deadline - DateTime.UtcNow).TotalMilliseconds));
      if (delay > 0) System.Threading.Thread.Sleep(delay);
    }
    return "{\"status\":\"" + status + "\",\"capturedExists\":" + Boolean(Owned(capturedSave, expectedPid)) +
      ",\"capturedVisible\":" + Boolean(IsWindowVisible(capturedSave)) + ",\"capturedEnabled\":" + Boolean(IsWindowEnabled(capturedSave)) +
      ",\"foregroundOwned\":" + Boolean(Owned(GetForegroundWindow(), expectedPid)) + ",\"foregroundSave\":" + Boolean(GetForegroundWindow() == capturedSave) +
      ",\"windows\":" + windows + ",\"otherDialogs\":" + dialogs + ",\"ownedBySave\":" + ownedBySave +
      ",\"buttons\":" + buttons + ",\"yes\":" + yes + ",\"no\":" + no + ",\"cancel\":" + cancel + ",\"replace\":" + replace + ",\"other\":" + other + "}";
  }
}
