using System;
using System.Collections.Generic;
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
  private static bool ModernParentChain(IntPtr button, IntPtr modal, uint pid, DateTime deadline) {
    var seen = new HashSet<IntPtr>();
    int wrappers = 0;
    IntPtr parent = GetParent(button);
    for (int depth = 0; depth < 3; depth++) {
      if (DateTime.UtcNow >= deadline || !Owned(parent, pid) || !seen.Add(parent) || GetAncestor(parent, 2) != modal) return false;
      var kind = new StringBuilder(64);
      if (GetClassName(parent, kind, kind.Capacity) == 0) return false;
      if (depth == 2) return parent == modal && kind.ToString() == "#32770" && wrappers == 6;
      if (parent == modal) return false;
      int bit = kind.ToString() == "DirectUIHWND" ? 2 : kind.ToString() == "CtrlNotifySink" ? 4 : 0;
      if (bit == 0 || (wrappers & bit) != 0) return false;
      wrappers |= bit;
      parent = GetParent(parent);
    }
    return false;
  }
  private static string ButtonBinding(IntPtr button, IntPtr modal, uint pid, int id, DateTime deadline) {
    if (DateTime.UtcNow >= deadline || !Owned(button, pid) || !IsWindowVisible(button) || !IsWindowEnabled(button) ||
        !ClassIs(button, "Button") || GetAncestor(button, 2) != modal) return "none";
    if (GetParent(button) == modal && GetDlgCtrlID(button) == id) return "classic_direct";
    // DirectUI buttons do not expose the classic IDs. Identity comes from the unique fixed
    // label and a fresh exact same-PID/root chain, never from a zero GetDlgCtrlID return.
    return ModernParentChain(button, modal, pid, deadline) ? "modern_chain" : "none";
  }
  private static int ButtonDiagnostic(IntPtr button, IntPtr modal, uint pid, int id) {
    // Failure-only classification; never substitutes for the original strict predicate.
    int mask = 128; // Exact fixed label was already read successfully.
    if (Owned(button, pid)) mask |= 1;
    if (IsWindowVisible(button)) mask |= 2;
    if (IsWindowEnabled(button)) mask |= 4;
    if (ClassIs(button, "Button")) mask |= 8;
    if (GetParent(button) == modal) mask |= 16;
    if (GetAncestor(button, 2) == modal) mask |= 32;
    if (GetDlgCtrlID(button) == id) mask |= 64;
    return mask;
  }
  private sealed class ButtonFailure {
    public int ControlId = -1, ParentDepth = 0, ParentClassMask = 0;
    public string ParentStatus = "not_checked";
    public string Json() {
      return "{\"controlId\":" + ControlId + ",\"parentStatus\":\"" + ParentStatus +
        "\",\"parentDepth\":" + ParentDepth + ",\"parentClassMask\":" + ParentClassMask + "}";
    }
  }
  private static ButtonFailure ObserveButtonFailure(IntPtr button, IntPtr modal, uint pid, DateTime deadline) {
    var result = new ButtonFailure();
    if (DateTime.UtcNow >= deadline) { result.ParentStatus = "deadline"; return result; }
    if (!IsWindow(button)) { result.ParentStatus = "unavailable"; return result; }
    if (!Owned(button, pid)) { result.ParentStatus = "foreign"; return result; }
    // A bounded dialog control ID is not a process ID or window handle. No raw UI name leaves this helper.
    int id = GetDlgCtrlID(button);
    if (id >= 0 && id <= 65535) result.ControlId = id;
    var seen = new HashSet<IntPtr>();
    IntPtr parent = GetParent(button);
    for (int index = 0; index < 16; index++) {
      if (DateTime.UtcNow >= deadline) { result.ParentStatus = "deadline"; return result; }
      if (!IsWindow(parent)) { result.ParentStatus = "unavailable"; return result; }
      if (!Owned(parent, pid)) { result.ParentStatus = "foreign"; return result; }
      if (!seen.Add(parent)) { result.ParentStatus = "cycle"; return result; }
      if (GetAncestor(parent, 2) != modal) { result.ParentStatus = "root_changed"; return result; }
      var kind = new StringBuilder(64);
      if (GetClassName(parent, kind, kind.Capacity) == 0) { result.ParentStatus = "read_error"; return result; }
      switch (kind.ToString()) {
        case "#32770": result.ParentClassMask |= 1; break;
        case "DirectUIHWND": result.ParentClassMask |= 2; break;
        case "CtrlNotifySink": result.ParentClassMask |= 4; break;
        case "DUIViewWndClassName": result.ParentClassMask |= 8; break;
        case "Button": result.ParentClassMask |= 16; break;
        default: result.ParentClassMask |= 32; break;
      }
      result.ParentDepth++;
      if (parent == modal) { result.ParentStatus = "complete"; return result; }
      parent = GetParent(parent);
    }
    result.ParentStatus = "bound";
    return result;
  }

  public static string Observe(IntPtr save, uint pid, int budgetMs) {
    string status = "refused";
    int mask = 0, candidates = 0, buttons = 0, yes = 0, no = 0, scanned = 0, children = 0, yesMask = 0, noMask = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, Math.Min(2000, budgetMs)));
    IntPtr modal = IntPtr.Zero, yesButton = IntPtr.Zero, noButton = IntPtr.Zero;
    var yesFailure = new ButtonFailure();
    var noFailure = new ButtonFailure();
    string yesBinding = "none", noBinding = "none";
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
            if (name == "Yes" || name == "&Yes") {
              yesBinding = ButtonBinding(control, modal, pid, 6, deadline);
              if (yesBinding != "none") { yes++; yesButton = control; }
              else if (DateTime.UtcNow < deadline) {
                yesMask = ButtonDiagnostic(control, modal, pid, 6);
                yesFailure = ObserveButtonFailure(control, modal, pid, deadline);
              }
            }
            if (name == "No" || name == "&No") {
              noBinding = ButtonBinding(control, modal, pid, 7, deadline);
              if (noBinding != "none") { no++; noButton = control; }
              else if (DateTime.UtcNow < deadline) {
                noMask = ButtonDiagnostic(control, modal, pid, 7);
                noFailure = ObserveButtonFailure(control, modal, pid, deadline);
              }
            }
            return true;
          }, IntPtr.Zero);
          if (status == "complete") {
            if (yes == 1) mask |= 8;
            if (no == 1) mask |= 16;
            if (buttons == 2 && yes == 1 && no == 1 && yesButton != noButton) mask |= 32;
            if (SaveValid(save, pid) && ModalValid(modal, save, pid) &&
                yesBinding != "none" && noBinding != "none" &&
                ButtonBinding(yesButton, modal, pid, 6, deadline) == yesBinding &&
                ButtonBinding(noButton, modal, pid, 7, deadline) == noBinding) mask |= 64;
            if (DateTime.UtcNow < deadline) mask |= 128;
            else status = "deadline";
          }
        }
      }
      if (status == "complete" && mask != 255) status = "refused";
    }
    return "{\"status\":\"" + status + "\",\"guardMask\":" + mask + ",\"candidates\":" + candidates +
      ",\"buttons\":" + buttons + ",\"yes\":" + yes + ",\"no\":" + no +
      ",\"yesRefusalMask\":" + yesMask + ",\"noRefusalMask\":" + noMask +
      ",\"yesBinding\":\"" + yesBinding + "\",\"noBinding\":\"" + noBinding + "\"" +
      ",\"yesFailure\":" + yesFailure.Json() + ",\"noFailure\":" + noFailure.Json() + "}";
  }
}
