import AppKit
import ApplicationServices
import Foundation
import Darwin

func binaryValue(_ value: CFTypeRef?) -> Int? {
    guard let value = value,
          CFGetTypeID(value) == CFBooleanGetTypeID() || CFGetTypeID(value) == CFNumberGetTypeID(),
          let number = value as? NSNumber else { return nil }
    return number.doubleValue == 0 ? 0 : number.doubleValue == 1 ? 1 : nil
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "--self-test" {
    let cases: [(CFTypeRef?, Int?)] = [(kCFBooleanFalse, 0), (kCFBooleanTrue, 1),
        (NSNumber(value: 0), 0), (NSNumber(value: 1), 1), (NSNumber(value: 2), nil), ("0" as CFString, nil), (nil, nil)]
    guard cases.allSatisfy({ binaryValue($0.0) == $0.1 }) else { exit(1) }
    print("Native macOS Save expansion value checks passed: 7")
    exit(0)
}
let trusted = AXIsProcessTrusted()
let deadline = ProcessInfo.processInfo.systemUptime + 3
var complete = true, foreground = false, pressed = false, expanded = false
var guardMask = 0, lastError = 0, unsupported = 0, visited = 0, windowsCount = 0, sheetsCount = 0
var initialValue = -1, finalValue = -1
var firstErrorAttribute = "none", stage = "arguments"
var disclosures: [AXUIElement] = [], saves: [AXUIElement] = [], cancels: [AXUIElement] = []
func failure(_ status: AXError, _ attribute: String) {
    complete = false
    lastError = Int(status.rawValue)
    if firstErrorAttribute == "none" { firstErrorAttribute = attribute }
}
func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status == .success { return value }
    if status == .attributeUnsupported || status == .noValue {
        unsupported += 1
        if name == "AXRole" { complete = false }
    } else { failure(status, name) }
    return nil
}
func children(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let value = read(element, name) else { return [] }
    guard let array = value as? [AXUIElement], array.count <= 256 else { complete = false; return [] }
    return array
}
func same(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }
func attached(_ parent: AXUIElement, _ sheet: AXUIElement) -> Bool {
    children(parent, "AXChildren").contains { same($0, sheet) }
}
func pressAvailable(_ element: AXUIElement) -> Bool {
    AXUIElementSetMessagingTimeout(element, 0.15)
    var names: CFArray?
    let status = AXUIElementCopyActionNames(element, &names)
    guard status == .success else { failure(status, "AXActions"); return false }
    guard let actions = names as? [String], actions.count <= 16 else { complete = false; return false }
    return actions.contains("AXPress")
}
if args.count == 2, let pid = Int32(args[1]), pid > 0, trusted {
    let app = AXUIElementCreateApplication(pid)
    stage = "discovery"
    let windows = children(app, "AXWindows")
    windowsCount = min(windows.count, 17)
    if windows.count != 1 { complete = false }
    var queue: [(AXUIElement, AXUIElement?)] = complete ? windows.map { ($0, nil) } : []
    var seen: [AXUIElement] = [], sheets: [AXUIElement] = [], parents: [AXUIElement] = []
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let (element, parent) = queue.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        let role = read(element, "AXRole") as? String
        if role == "AXSheet" {
            sheets.append(element)
            if let parent = parent { parents.append(parent) }
            continue
        }
        if role == "AXWebArea" { continue }
        let next = children(element, "AXChildren")
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next.map { ($0, element) })
    }
    sheetsCount = min(sheets.count, 17)
    if sheets.count != 1 || parents.count != 1 { complete = false }
    queue = complete ? [(sheets[0], parents[0])] : []
    seen = []
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let (element, _) = queue.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        visited = seen.count
        let role = read(element, "AXRole") as? String
        if role == "AXSheet" && !same(element, sheets[0]) { sheetsCount += 1; complete = false; break }
        if role == "AXDisclosureTriangle" { disclosures.append(element) }
        if role == "AXButton" {
            let title = read(element, "AXTitle") as? String
            if title == "Save" { saves.append(element) }
            if title == "Cancel" { cancels.append(element) }
        }
        if role == "AXWebArea" { continue }
        let next = children(element, "AXChildren")
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next.map { ($0, element) })
    }
    if complete && disclosures.count == 1 && saves.count == 1 && cancels.count == 1 {
        stage = "guard"
        let disclosure = disclosures[0], sheet = sheets[0], parent = parents[0]
        var owner: pid_t = 0
        if AXUIElementGetPid(disclosure, &owner) == .success && owner == pid { guardMask |= 1 }
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        if foreground { guardMask |= 2 }
        if attached(parent, sheet) { guardMask |= 4 }
        if read(sheet, "AXRole") as? String == "AXSheet" { guardMask |= 8 }
        initialValue = binaryValue(read(disclosure, "AXValue")) ?? -1
        if read(disclosure, "AXRole") as? String == "AXDisclosureTriangle" && initialValue == 0 &&
           read(saves[0], "AXRole") as? String == "AXButton" && read(saves[0], "AXTitle") as? String == "Save" &&
           read(cancels[0], "AXRole") as? String == "AXButton" && read(cancels[0], "AXTitle") as? String == "Cancel" { guardMask |= 16 }
        if (read(disclosure, "AXEnabled") as? Bool) == true &&
           (read(saves[0], "AXEnabled") as? Bool) == true && (read(cancels[0], "AXEnabled") as? Bool) == true { guardMask |= 32 }
        if pressAvailable(disclosure) && complete && lastError == 0 { guardMask |= 64 }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && ProcessInfo.processInfo.systemUptime < deadline { guardMask |= 128 }
        if complete && guardMask == 255 {
            stage = "press"
            let timeout = AXUIElementSetMessagingTimeout(disclosure, 1)
            let status = timeout == .success ? AXUIElementPerformAction(disclosure, "AXPress" as CFString) : timeout
            if status != .success { failure(status, "AXPress") }
            pressed = status == .success
            if pressed {
                stage = "expansion"
                let expansionDeadline = ProcessInfo.processInfo.systemUptime + 2
                while complete && ProcessInfo.processInfo.systemUptime < expansionDeadline {
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid || !attached(parent, sheet) ||
                       read(sheet, "AXRole") as? String != "AXSheet" { complete = false; break }
                    finalValue = binaryValue(read(disclosure, "AXValue")) ?? -1
                    if complete && finalValue == 1 { expanded = true; stage = "complete"; break }
                    Thread.sleep(forTimeInterval: 0.02)
                }
            }
        }
    }
} else { complete = false }
let result: [String: Any] = ["trusted": trusted, "complete": complete, "foreground": foreground,
    "guardMask": guardMask, "lastError": lastError, "firstErrorAttribute": firstErrorAttribute, "stage": stage,
    "pressed": pressed, "expanded": expanded, "initialValue": initialValue, "finalValue": finalValue,
    "windows": windowsCount, "sheets": sheetsCount, "visited": visited, "unsupported": min(unsupported, 999),
    "disclosures": min(disclosures.count, 999), "saveButtons": min(saves.count, 999), "cancelButtons": min(cancels.count, 999)]
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output) }
