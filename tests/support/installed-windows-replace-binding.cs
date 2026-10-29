using System;
using System.Runtime.InteropServices;
using System.Text;

// Read-only, fresh identity checks. No input API or confirmation action is exposed.
public static class WindowsReplacementBinding {
  private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);

  private static bool Owned(IntPtr window, uint expectedPid) {
    uint pid;
    return IsWindow(window) && GetWindowThreadProcessId(window, out pid) != 0 && pid == expectedPid;
  }
  private static bool ClassIs(IntPtr window, string expected) {
    var text = new StringBuilder(64);
    return GetClassName(window, text, text.Capacity) > 0 && text.ToString() == expected;
  }
  private static bool SaveValid(IntPtr save, uint pid) {
    return Owned(save, pid) && IsWindowVisible(save) && !IsWindowEnabled(save) && ClassIs(save, "#32770");
  }
  private static bool ModalValid(IntPtr modal, IntPtr save, uint pid) {
    return modal != save && Owned(modal, pid) && IsWindowVisible(modal) && IsWindowEnabled(modal) &&
      ClassIs(modal, "#32770") && GetWindow(modal, 4) == save && GetAncestor(modal, 2) == modal &&
      GetForegroundWindow() == modal;
  }
  private static bool ButtonValid(IntPtr button, IntPtr modal, uint pid, int id) {
    return Owned(button, pid) && IsWindowVisible(button) && IsWindowEnabled(button) &&
      ClassIs(button, "Button") && GetParent(button) == modal && GetAncestor(button, 2) == modal && GetDlgCtrlID(button) == id;
  }

  public static string Observe(IntPtr save, uint pid, int budgetMs) {
    string status = "refused";
    int mask = 0, candidates = 0, buttons = 0, yes = 0, no = 0, scanned = 0, children = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, Math.Min(2000, budgetMs)));
    IntPtr modal = IntPtr.Zero, yesButton = IntPtr.Zero, noButton = IntPtr.Zero;
    if (budgetMs > 0 && budgetMs <= 2000 && SaveValid(save, pid)) {
      mask |= 1;
      status = "complete";
      bool enumerated = EnumWindows((window, parameter) => {
        if (DateTime.UtcNow >= deadline) { status = "deadline"; return false; }
        if (++scanned > 256) { status = "bound"; return false; }
        if (window == save || !Owned(window, pid) || !IsWindowVisible(window)) return true;
        var kind = new StringBuilder(64);
        if (GetClassName(window, kind, kind.Capacity) == 0) { status = "read_error"; return false; }
        if (kind.ToString() != "#32770") return true;
        if (++candidates > 16) { status = "bound"; return false; }
        modal = window;
        return true;
      }, IntPtr.Zero);
      if (!enumerated && status == "complete") status = "read_error";
      if (status == "complete" && candidates == 1) {
        mask |= 2;
        if (ModalValid(modal, save, pid)) {
          mask |= 4;
          // EnumChildWindows' return value is unused by Win32; callback status records every refusal.
          EnumChildWindows(modal, (control, parameter) => {
            if (DateTime.UtcNow >= deadline) { status = "deadline"; return false; }
            if (++children > 256) { status = "bound"; return false; }
            if (!Owned(control, pid)) { status = "read_error"; return false; }
            if (!IsWindowVisible(control)) return true;
            var kind = new StringBuilder(64);
            if (GetClassName(control, kind, kind.Capacity) == 0) { status = "read_error"; return false; }
            if (kind.ToString() != "Button") return true;
            buttons++;
            var title = new StringBuilder(128);
            UIntPtr result;
            int remaining = Math.Min(50, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
            if (remaining <= 0) { status = "deadline"; return false; }
            if (SendMessageTimeout(control, 0x000D, (UIntPtr)(uint)title.Capacity, title, 2, (uint)remaining, out result) == IntPtr.Zero) {
              status = "read_error"; return false;
            }
            string name = title.ToString();
            if ((name == "Yes" || name == "&Yes") && ButtonValid(control, modal, pid, 6)) { yes++; yesButton = control; }
            if ((name == "No" || name == "&No") && ButtonValid(control, modal, pid, 7)) { no++; noButton = control; }
            return true;
          }, IntPtr.Zero);
          if (status == "complete") {
            if (yes == 1) mask |= 8;
            if (no == 1) mask |= 16;
            if (buttons == 2 && yes == 1 && no == 1 && yesButton != noButton) mask |= 32;
            if (SaveValid(save, pid) && ModalValid(modal, save, pid) &&
                ButtonValid(yesButton, modal, pid, 6) && ButtonValid(noButton, modal, pid, 7)) mask |= 64;
            if (DateTime.UtcNow < deadline) mask |= 128;
            else status = "deadline";
          }
        }
      }
      if (status == "complete" && mask != 255) status = "refused";
    }
    return "{\"status\":\"" + status + "\",\"guardMask\":" + mask + ",\"candidates\":" + candidates +
      ",\"buttons\":" + buttons + ",\"yes\":" + yes + ",\"no\":" + no + "}";
  }
}
