using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// Observe is read-only. CancelNo independently rebuilds the same proof before one No click.
public static class WindowsReplacementBinding {
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct GuiInfo {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public Rect caretRect;
  }
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
    public int dx, dy;
    public uint mouseData, flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Explicit, Size = 40)] private struct Input {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MouseInput mouse;
  }
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
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

  private sealed class ChildBudget { public int Children = 0; }
  private sealed class ButtonSnapshot {
    public string Status = "complete", YesBinding = "none", NoBinding = "none";
    public int Buttons = 0, Yes = 0, No = 0, YesMask = 0, NoMask = 0;
    public IntPtr YesButton = IntPtr.Zero, NoButton = IntPtr.Zero;
    public ButtonFailure YesFailure = new ButtonFailure(), NoFailure = new ButtonFailure();
  }
  private static ButtonSnapshot ReadButtons(IntPtr modal, uint pid, DateTime deadline, ChildBudget budget) {
    var snapshot = new ButtonSnapshot();
    // EnumChildWindows' return value is unused by Win32; callback snapshot.Status records every refusal.
    EnumChildWindows(modal, (control, parameter) => {
      if (DateTime.UtcNow >= deadline) { snapshot.Status = "deadline"; return false; }
      if (++budget.Children > 256) { snapshot.Status = "bound"; return false; }
      if (!Owned(control, pid)) { snapshot.Status = "read_error"; return false; }
      if (!IsWindowVisible(control)) return true;
      var kind = new StringBuilder(64);
      if (GetClassName(control, kind, kind.Capacity) == 0) { snapshot.Status = "read_error"; return false; }
      if (kind.ToString() != "Button") return true;
      snapshot.Buttons++;
      var title = new StringBuilder(128);
      UIntPtr result;
      int remaining = Math.Min(50, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
      if (remaining <= 0) { snapshot.Status = "deadline"; return false; }
      if (SendMessageTimeout(control, 0x000D, (UIntPtr)(uint)title.Capacity, title, 2, (uint)remaining, out result) == IntPtr.Zero) {
        snapshot.Status = "read_error"; return false;
      }
      string name = title.ToString();
      if (name == "Yes" || name == "&Yes") {
        snapshot.YesBinding = ButtonBinding(control, modal, pid, 6, deadline);
        if (snapshot.YesBinding != "none") { snapshot.Yes++; snapshot.YesButton = control; }
        else if (DateTime.UtcNow < deadline) {
          snapshot.YesMask = ButtonDiagnostic(control, modal, pid, 6);
          snapshot.YesFailure = ObserveButtonFailure(control, modal, pid, deadline);
        }
      }
      if (name == "No" || name == "&No") {
        snapshot.NoBinding = ButtonBinding(control, modal, pid, 7, deadline);
        if (snapshot.NoBinding != "none") { snapshot.No++; snapshot.NoButton = control; }
        else if (DateTime.UtcNow < deadline) {
          snapshot.NoMask = ButtonDiagnostic(control, modal, pid, 7);
          snapshot.NoFailure = ObserveButtonFailure(control, modal, pid, deadline);
        }
      }
      return true;
    }, IntPtr.Zero);
    return snapshot;
  }

  private static string ObserveButtonInputGuard(IntPtr save, IntPtr modal, IntPtr button, uint pid, int controlId, string binding, DateTime deadline, out Point guardedPoint, out Rect guardedRect) {
    guardedPoint = new Point(); guardedRect = new Rect();
    int mask = 0;
    string status = "refused";
    if (DateTime.UtcNow >= deadline) status = "deadline";
    else if (SaveValid(save, pid) && ModalValid(modal, save, pid)) {
      mask |= 1;
      if (binding != "none" && ButtonBinding(button, modal, pid, controlId, deadline) == binding) {
        mask |= 2;
        Rect buttonRect, modalRect;
        if (!GetWindowRect(button, out buttonRect) || !GetWindowRect(modal, out modalRect)) status = "read_error";
        else {
          Point center = new Point();
          long width = (long)buttonRect.right - buttonRect.left, height = (long)buttonRect.bottom - buttonRect.top;
          if (width > 0 && width <= 4096 && height > 0 && height <= 4096) {
            mask |= 4;
            if (modalRect.left <= buttonRect.left && modalRect.top <= buttonRect.top &&
                modalRect.right >= buttonRect.right && modalRect.bottom >= buttonRect.bottom) {
              mask |= 8;
              center = new Point { x = (int)((long)buttonRect.left + width / 2), y = (int)((long)buttonRect.top + height / 2) };
              IntPtr hit = WindowFromPoint(center);
              if (Owned(hit, pid) && GetAncestor(hit, 2) == modal && (hit == button || IsChild(button, hit))) mask |= 16;
            }
          }
          uint owner;
          uint thread = GetWindowThreadProcessId(modal, out owner);
          var gui = new GuiInfo { size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
          if (owner != pid || thread == 0 || !GetGUIThreadInfo(thread, ref gui)) status = "read_error";
          else {
            if (gui.active == modal && Owned(gui.focus, pid) && GetAncestor(gui.focus, 2) == modal) mask |= 32;
            if (gui.capture == IntPtr.Zero && gui.menuOwner == IntPtr.Zero && gui.moveSize == IntPtr.Zero) mask |= 64;
          }
          if (DateTime.UtcNow >= deadline) status = "deadline";
          else if (mask == 127 && status != "read_error" && SaveValid(save, pid) && ModalValid(modal, save, pid) &&
                   ButtonBinding(button, modal, pid, controlId, deadline) == binding) {
            Rect fresh;
            if (!GetWindowRect(button, out fresh)) status = "read_error";
            else if (fresh.left == buttonRect.left && fresh.top == buttonRect.top && fresh.right == buttonRect.right && fresh.bottom == buttonRect.bottom) {
              IntPtr hit = WindowFromPoint(center);
              if (Owned(hit, pid) && GetAncestor(hit, 2) == modal && (hit == button || IsChild(button, hit))) mask |= 128;
            }
          }
          if (DateTime.UtcNow >= deadline && status != "read_error") status = "deadline";
          if (mask == 255 && status != "read_error" && DateTime.UtcNow < deadline) {
            status = "complete"; guardedPoint = center; guardedRect = buttonRect;
          }
        }
      }
    }
    return "{\"status\":\"" + status + "\",\"guardMask\":" + mask + "}";
  }

  private static bool SameRect(Rect left, Rect right) {
    return left.left == right.left && left.top == right.top && left.right == right.right && left.bottom == right.bottom;
  }
  private static string CancelBoundNo(IntPtr save, IntPtr modal, IntPtr yesButton, IntPtr noButton,
      uint pid, string yesBinding, string noBinding, DateTime deadline, ChildBudget childBudget,
      string fixturePath, Point point, Rect bounds) {
    string status = "refused";
    bool moved = false, attempted = false, sent = false, dismissed = false, retained = false;
    bool censusMatches = false, pointUnchanged = false, cursorMatches = false;
    string freshGuard = "{\"status\":\"not_checked\",\"guardMask\":0}";
    int guardMask = 0;
    // Verify the exact controlled fixture again before any pointer movement or input.
    WindowsReplacementContext.VerifyFixture(fixturePath);
    if (DateTime.UtcNow < deadline && IntPtr.Size == 8 && SetCursorPos(point.x, point.y)) {
      moved = true;
      var fresh = ReadButtons(modal, pid, deadline, childBudget);
      censusMatches = fresh.Status == "complete" && fresh.Buttons == 2 && fresh.Yes == 1 && fresh.No == 1 &&
        fresh.YesButton == yesButton && fresh.NoButton == noButton && fresh.YesBinding == yesBinding && fresh.NoBinding == noBinding;
      if (censusMatches) {
        Point cursor, guardedPoint; Rect guardedRect;
        freshGuard = ObserveButtonInputGuard(save, modal, noButton, pid, 7, noBinding, deadline, out guardedPoint, out guardedRect);
        pointUnchanged = SameRect(bounds, guardedRect) && guardedPoint.x == point.x && guardedPoint.y == point.y;
        cursorMatches = GetCursorPos(out cursor) && cursor.x == point.x && cursor.y == point.y;
        if (freshGuard == "{\"status\":\"complete\",\"guardMask\":255}" && pointUnchanged && cursorMatches && DateTime.UtcNow < deadline) {
          guardMask = 255;
          var inputs = new[] {
            new Input { type = 0, mouse = new MouseInput { flags = 0x0002 } },
            new Input { type = 0, mouse = new MouseInput { flags = 0x0004 } }
          };
          attempted = true;
          sent = SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) == 2;
          // A partial/failed dispatch is fatal and is never retried.
          if (sent) {
            while (DateTime.UtcNow < deadline && IsWindow(modal)) {
              if (!Owned(save, pid)) break;
              System.Threading.Thread.Sleep(Math.Min(20, Math.Max(1, (int)(deadline - DateTime.UtcNow).TotalMilliseconds)));
            }
            dismissed = !IsWindow(modal);
            retained = Owned(save, pid) && IsWindowVisible(save) && IsWindowEnabled(save) &&
              ClassIs(save, "#32770") && GetForegroundWindow() == save && GetAncestor(save, 2) == save;
            if (dismissed && retained && DateTime.UtcNow < deadline) {
              WindowsReplacementContext.VerifyFixture(fixturePath);
              if (DateTime.UtcNow < deadline) status = "complete";
            }
          }
        }
      }
    }
    if (status != "complete" && DateTime.UtcNow >= deadline) status = "deadline";
    return "{\"status\":\"" + status + "\",\"guardMask\":" + guardMask + ",\"freshNoInputGuard\":" + freshGuard +
      ",\"censusMatches\":" + censusMatches.ToString().ToLowerInvariant() +
      ",\"pointUnchanged\":" + pointUnchanged.ToString().ToLowerInvariant() +
      ",\"cursorMatches\":" + cursorMatches.ToString().ToLowerInvariant() +
      ",\"cursorMoved\":" + moved.ToString().ToLowerInvariant() + ",\"attempted\":" + attempted.ToString().ToLowerInvariant() +
      ",\"sent\":" + sent.ToString().ToLowerInvariant() + ",\"modalDismissed\":" + dismissed.ToString().ToLowerInvariant() +
      ",\"saveRetained\":" + retained.ToString().ToLowerInvariant() + "}";
  }
  public static string Observe(IntPtr save, uint pid, int budgetMs) {
    return ObserveCore(save, pid, budgetMs, null);
  }
  public static string CancelNo(IntPtr save, uint pid, int budgetMs, string fixturePath) {
    if (String.IsNullOrEmpty(fixturePath)) throw new InvalidOperationException("Replacement fixture unavailable");
    return ObserveCore(save, pid, budgetMs, fixturePath);
  }
  private static string ObserveCore(IntPtr save, uint pid, int budgetMs, string fixturePath) {
    string status = "refused";
    int mask = 0, candidates = 0, buttons = 0, yes = 0, no = 0, scanned = 0, yesMask = 0, noMask = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, Math.Min(2000, budgetMs)));
    IntPtr modal = IntPtr.Zero, yesButton = IntPtr.Zero, noButton = IntPtr.Zero;
    var yesFailure = new ButtonFailure();
    var noFailure = new ButtonFailure();
    string yesBinding = "none", noBinding = "none", recheckStatus = "not_checked";
    int recheckButtons = 0, recheckYes = 0, recheckNo = 0;
    bool recheckMatches = false;
    var childBudget = new ChildBudget();
    string noInputGuard = "{\"status\":\"not_checked\",\"guardMask\":0}";
    string yesInputGuard = "{\"status\":\"not_checked\",\"guardMask\":0}";
    string cancellation = "{\"status\":\"not_checked\",\"guardMask\":0,\"freshNoInputGuard\":{\"status\":\"not_checked\",\"guardMask\":0},\"censusMatches\":false,\"pointUnchanged\":false,\"cursorMatches\":false,\"cursorMoved\":false,\"attempted\":false,\"sent\":false,\"modalDismissed\":false,\"saveRetained\":false}";
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
          var first = ReadButtons(modal, pid, deadline, childBudget);
          status = first.Status;
          buttons = first.Buttons; yes = first.Yes; no = first.No;
          yesButton = first.YesButton; noButton = first.NoButton;
          yesBinding = first.YesBinding; noBinding = first.NoBinding;
          yesMask = first.YesMask; noMask = first.NoMask;
          yesFailure = first.YesFailure; noFailure = first.NoFailure;
          if (status == "complete") {
            if (yes == 1) mask |= 8;
            if (no == 1) mask |= 16;
            if (buttons == 2 && yes == 1 && no == 1 && yesButton != noButton) mask |= 32;
            if (buttons == 2 && yes == 1 && no == 1 && yesButton != noButton) {
              var fresh = ReadButtons(modal, pid, deadline, childBudget);
              recheckStatus = fresh.Status;
              recheckButtons = fresh.Buttons; recheckYes = fresh.Yes; recheckNo = fresh.No;
              recheckMatches = fresh.Status == "complete" && fresh.Buttons == 2 && fresh.Yes == 1 && fresh.No == 1 &&
                fresh.YesButton == yesButton && fresh.NoButton == noButton &&
                fresh.YesBinding == yesBinding && fresh.NoBinding == noBinding;
              if (recheckStatus == "complete" && !recheckMatches) recheckStatus = "refused";
              if (fresh.Status != "complete") status = fresh.Status;
            }
            if (recheckMatches && SaveValid(save, pid) && ModalValid(modal, save, pid) &&
                yesBinding != "none" && noBinding != "none" &&
                ButtonBinding(yesButton, modal, pid, 6, deadline) == yesBinding &&
                ButtonBinding(noButton, modal, pid, 7, deadline) == noBinding) mask |= 64;
            if (DateTime.UtcNow < deadline) mask |= 128;
            else status = "deadline";
          }
        }
      }
      if (status == "complete" && mask != 255) status = "refused";
      if (status == "complete" && mask == 255) {
        Point point; Rect bounds;
        noInputGuard = ObserveButtonInputGuard(save, modal, noButton, pid, 7, noBinding, deadline, out point, out bounds);
        // The observer additionally checks Yes, without moving the cursor or issuing input.
        // Cancellation retains exactly its existing No-only action path and budget.
        if (fixturePath == null && noInputGuard == "{\"status\":\"complete\",\"guardMask\":255}") {
          Point yesPoint; Rect yesBounds;
          yesInputGuard = ObserveButtonInputGuard(save, modal, yesButton, pid, 6, yesBinding, deadline, out yesPoint, out yesBounds);
        }
        if (fixturePath != null && noInputGuard == "{\"status\":\"complete\",\"guardMask\":255}")
          cancellation = CancelBoundNo(save, modal, yesButton, noButton, pid, yesBinding, noBinding, deadline, childBudget, fixturePath, point, bounds);
      }
    }
    return "{\"status\":\"" + status + "\",\"guardMask\":" + mask + ",\"candidates\":" + candidates +
      ",\"buttons\":" + buttons + ",\"yes\":" + yes + ",\"no\":" + no +
      ",\"yesRefusalMask\":" + yesMask + ",\"noRefusalMask\":" + noMask +
      ",\"yesBinding\":\"" + yesBinding + "\",\"noBinding\":\"" + noBinding + "\"" +
      ",\"yesFailure\":" + yesFailure.Json() + ",\"noFailure\":" + noFailure.Json() +
      ",\"recheckStatus\":\"" + recheckStatus + "\",\"recheckButtons\":" + recheckButtons +
      ",\"recheckYes\":" + recheckYes + ",\"recheckNo\":" + recheckNo +
      ",\"recheckMatches\":" + (recheckMatches ? "true" : "false") + ",\"noInputGuard\":" + noInputGuard + (fixturePath == null ? ",\"yesInputGuard\":" + yesInputGuard : ",\"cancellation\":" + cancellation) + "}";
  }
}
