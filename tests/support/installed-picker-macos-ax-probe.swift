import AppKit
import ApplicationServices
import Foundation
import Darwin

// CI-only native AX verification; an action is allowed only after exact selected-file proof.
func selectedFileEvidence(_ input: [URL], expected: URL) -> (leaves: [URL], matches: Int, verified: Bool) {
    var urls: [URL] = []
    for url in input where !urls.contains(where: { $0.absoluteString == url.absoluteString }) { urls.append(url) }
    let leaves = urls.filter { candidate in
        !urls.contains { other in
            other.scheme == candidate.scheme && other.host == candidate.host &&
                other.pathComponents.count > candidate.pathComponents.count && other.pathComponents.starts(with: candidate.pathComponents)
        }
    }
    let matches = leaves.filter { $0.absoluteString == expected.absoluteString }.count
    let validURLs = urls.allSatisfy { $0.isFileURL && $0.query == nil && $0.fragment == nil }
    return (leaves, matches, validURLs && leaves.count == 1 && matches == 1)
}

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "--self-test" {
    let target = URL(fileURLWithPath: "/fixture/input.wav")
    let directory = URL(fileURLWithPath: "/fixture", isDirectory: true)
    let sibling = URL(fileURLWithPath: "/fixture/other.wav")
    let wrongCase = URL(fileURLWithPath: "/fixture/Input.wav")
    let prefixTrap = URL(fileURLWithPath: "/fixture/input")
    let hostTrap = URL(string: "file://other-host/fixture/")!
    let cases: [([URL], Bool)] = [
        ([target], true), ([directory, target], true), ([target, target], true),
        ([], false), ([directory], false), ([directory, target, sibling], false),
        ([wrongCase], false), ([prefixTrap, target], false), ([hostTrap, target], false)
    ]
    if !cases.allSatisfy({ selectedFileEvidence($0.0, expected: target).verified == $0.1 }) {
        print("Native macOS selected-file checks failed")
        exit(1)
    }
    print("Native macOS selected-file checks passed: 9")
    exit(0)
}
let requested = arguments.count == 4 ? arguments[3] : "none"
var counts: [String: Int] = [
    "windows": 0, "sheets": 0, "visited": 0, "selectedRoots": 0,
    "selectedRows": 0, "selectedCells": 0, "selectedColumns": 0,
    "urlStrings": 0, "urlObjects": 0, "exactUrls": 0, "exactFilenames": 0,
    "basenameMatches": 0, "unsupported": 0, "cannotComplete": 0,
    "apiDisabled": 0, "otherErrors": 0, "lastError": 0,
    "selectedUrls": 0, "selectedExactUrls": 0, "selectedLeaves": 0, "leafMatches": 0, "buttons": 0
]
var complete = true
var verified = false
var pressed = false
var dismissed = false
var foreground = false
var guardMask = 0
var stage = "arguments"
var firstOtherError = 0
var firstOtherAttribute = "none"
let trusted = AXIsProcessTrusted()
let deadline = ProcessInfo.processInfo.systemUptime + 3

func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.15)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status != .success {
        counts["lastError"] = Int(status.rawValue)
        switch status {
        case .attributeUnsupported, .noValue: counts["unsupported", default: 0] += 1
        case .cannotComplete: counts["cannotComplete", default: 0] += 1
        case .apiDisabled: counts["apiDisabled", default: 0] += 1
        default:
            counts["otherErrors", default: 0] += 1
            if firstOtherError == 0 { firstOtherError = Int(status.rawValue); firstOtherAttribute = name }
        }
        return nil
    }
    return value
}

func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let value = read(element, name), let array = value as? [AXUIElement] else { return [] }
    if array.count > 256 { complete = false; return [] }
    return array
}
func string(_ element: AXUIElement, _ name: String) -> String? { read(element, name) as? String }
func same(_ left: AXUIElement, _ right: AXUIElement) -> Bool { CFEqual(left, right) }
func nativeURL(_ value: CFTypeRef) -> URL? {
    if CFGetTypeID(value) == CFURLGetTypeID() { return value as? URL }
    if let text = value as? String { return URL(string: text) }
    return nil
}
func noReadFailures() -> Bool {
    counts["cannotComplete", default: 0] == 0 && counts["apiDisabled", default: 0] == 0 && counts["otherErrors", default: 0] == 0
}

if (arguments.count == 3 || arguments.count == 4), ["none", "open", "cancel_open_existing"].contains(requested),
   let pid = Int32(arguments[1]), pid > 0, arguments[2].hasPrefix("/") {
    let target = URL(fileURLWithPath: arguments[2])
    let expected = target.absoluteString
    let app = AXUIElementCreateApplication(pid)
    stage = "discovery"
    let windows = elements(app, "AXWindows")
    counts["windows"] = min(windows.count, 17)
    if windows.count > 16 { complete = false }
    var discovery = windows.count <= 16 ? windows.map { ($0, Optional<AXUIElement>.none) } : []
    var seen: [AXUIElement] = []
    var sheets: [AXUIElement] = []
    var parents: [AXUIElement] = []
    while !discovery.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let (element, parent) = discovery.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        let role = string(element, "AXRole") ?? ""
        if role == "AXSheet" {
            sheets.append(element)
            if let parent = parent { parents.append(parent) }
            continue
        }
        if role == "AXWebArea" { continue }
        let children = elements(element, "AXChildren")
        if discovery.count + children.count > 256 { complete = false; break }
        discovery.append(contentsOf: children.map { ($0, Optional(element)) })
    }
    counts["sheets"] = min(sheets.count, 17)
    if sheets.count != 1 || parents.count != 1 { complete = false }
    var selected: [AXUIElement] = []
    var buttons: [AXUIElement] = []
    var queue = sheets.count == 1 ? sheets : []
    seen = []
    stage = "selection"
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let element = queue.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        counts["visited"] = seen.count
        let role = string(element, "AXRole") ?? ""
        if (read(element, "AXSelected") as? Bool) == true && !selected.contains(where: { same($0, element) }) { selected.append(element) }
        if requested == "none" {
            if string(element, "AXTitle") == target.lastPathComponent || string(element, "AXValue") == target.lastPathComponent { counts["basenameMatches", default: 0] += 1 }
            if string(element, "AXFilename") == arguments[2] { counts["exactFilenames", default: 0] += 1 }
        }
        if role == "AXButton" && string(element, "AXTitle") == (requested == "open" ? "Open" : "Cancel") { buttons.append(element) }
        if let value = read(element, "AXURL"), let url = nativeURL(value) {
            if CFGetTypeID(value) == CFURLGetTypeID() { counts["urlObjects", default: 0] += 1 }
            else { counts["urlStrings", default: 0] += 1 }
            if url.absoluteString == expected { counts["exactUrls", default: 0] += 1 }
        }
        var next: [AXUIElement] = []
        for name in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells", "AXSelectedColumns"] {
            for child in elements(element, name) {
                if !selected.contains(where: { same($0, child) }) { selected.append(child) }
                next.append(child)
            }
        }
        if ["AXList", "AXOutline", "AXTable", "AXColumn"].contains(role) { next.append(contentsOf: elements(element, "AXColumns")) }
        else { next.append(contentsOf: elements(element, "AXChildren")) }
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next)
    }
    stage = "verification"
    counts["selectedRoots"] = selected.count
    counts["buttons"] = buttons.count
    var selectedURLs: [URL] = []
    if selected.count > 256 { complete = false }
    for element in selected.prefix(256) {
        if ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        switch string(element, "AXRole") ?? "" {
        case "AXRow": counts["selectedRows", default: 0] += 1
        case "AXCell": counts["selectedCells", default: 0] += 1
        case "AXColumn": counts["selectedColumns", default: 0] += 1
        default: break
        }
        if let value = read(element, "AXURL"), let url = nativeURL(value) {
            if !url.isFileURL { complete = false }
            if !selectedURLs.contains(where: { $0.absoluteString == url.absoluteString }) { selectedURLs.append(url) }
        }
    }
    counts["selectedUrls"] = selectedURLs.count
    counts["selectedExactUrls"] = selectedURLs.filter { $0.absoluteString == expected }.count
    // Browser navigation may select directory ancestors. Only a unique terminal file is accepted.
    let selection = selectedFileEvidence(selectedURLs, expected: target)
    counts["selectedLeaves"] = selection.leaves.count
    counts["leafMatches"] = selection.matches
    if !noReadFailures() { complete = false }
    verified = trusted && complete && selection.verified
    if requested != "none" && verified && buttons.count == 1 && sheets.count == 1 && parents.count == 1 {
        stage = "guard"
        let sheet = sheets[0]
        let parent = parents[0]
        let button = buttons[0]
        var actualPid: pid_t = 0
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        if AXUIElementGetPid(app, &actualPid) == .success && actualPid == pid { guardMask |= 1 }
        if foreground { guardMask |= 2 }
        if elements(parent, "AXChildren").contains(where: { same($0, sheet) }) { guardMask |= 4 }
        if string(sheet, "AXRole") == "AXSheet" { guardMask |= 8 }
        if string(button, "AXRole") == "AXButton" && string(button, "AXTitle") == (requested == "open" ? "Open" : "Cancel") { guardMask |= 16 }
        if (read(button, "AXEnabled") as? Bool) == true { guardMask |= 32 }
        if noReadFailures() { guardMask |= 64 }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { guardMask |= 128 }
        if guardMask == 255 {
            stage = "press"
            let status = AXUIElementPerformAction(button, "AXPress" as CFString)
            counts["lastError"] = Int(status.rawValue)
            pressed = status == .success
            if pressed {
                stage = "dismissal"
                let dismissDeadline = ProcessInfo.processInfo.systemUptime + 2
                while ProcessInfo.processInfo.systemUptime < dismissDeadline {
                    var value: CFTypeRef?
                    let sheetStatus = AXUIElementCopyAttributeValue(sheet, "AXRole" as CFString, &value)
                    if sheetStatus == .invalidUIElement { dismissed = true; break }
                    if sheetStatus != .success { counts["lastError"] = Int(sheetStatus.rawValue) }
                    var children: CFTypeRef?
                    let parentStatus = AXUIElementCopyAttributeValue(parent, "AXChildren" as CFString, &children)
                    if parentStatus != .success { counts["lastError"] = Int(parentStatus.rawValue) }
                    if parentStatus == .success,
                       let current = children as? [AXUIElement], current.count <= 256,
                       !current.contains(where: { same($0, sheet) }) { dismissed = true; break }
                    Thread.sleep(forTimeInterval: 0.02)
                }
                if dismissed { stage = "complete" }
            }
        }
    }
} else { complete = false }
if !noReadFailures() { complete = false }
for key in Array(counts.keys) where key != "lastError" { counts[key] = min(counts[key] ?? 0, 999) }
let lastError = counts.removeValue(forKey: "lastError") ?? 0
let result: [String: Any] = [
    "counts": counts, "lastError": lastError, "trusted": trusted, "complete": complete,
    "firstOtherError": firstOtherError, "firstOtherAttribute": firstOtherAttribute,
    "verified": verified, "foreground": foreground, "stage": stage, "guardMask": guardMask,
    "action": ["requested": requested, "pressed": pressed, "dismissed": dismissed]
]
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
   let output = String(data: data, encoding: .utf8) { print(output) }
