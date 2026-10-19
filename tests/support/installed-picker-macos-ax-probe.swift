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

func exactTargetAttribute(_ value: CFTypeRef?, target: URL, path: String) -> Bool {
    guard let value = value else { return false }
    if let text = value as? String, text == path { return true }
    guard let url = nativeURL(value), url.isFileURL, url.query == nil, url.fragment == nil else { return false }
    return url.absoluteString == target.absoluteString
}

func binaryDisclosureValue(_ value: CFTypeRef?) -> Int? {
    guard let value = value,
          CFGetTypeID(value) == CFBooleanGetTypeID() || CFGetTypeID(value) == CFNumberGetTypeID(),
          let number = value as? NSNumber else { return nil }
    if number.doubleValue == 0 { return 0 }
    if number.doubleValue == 1 { return 1 }
    return nil
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
    let attributes: [(CFTypeRef?, Bool)] = [
        (target as CFURL, true), (target.absoluteString as CFString, true), (target.path as CFString, true),
        (nil, false), (sibling as CFURL, false), (wrongCase as CFURL, false),
        (prefixTrap.path as CFString, false), (hostTrap as CFURL, false),
        ((target.absoluteString + "?private=1") as CFString, false),
        ((target.absoluteString + "#private") as CFString, false)
    ]
    if !attributes.allSatisfy({ exactTargetAttribute($0.0, target: target, path: target.path) == $0.1 }) {
        print("Native macOS exact attribute checks failed")
        exit(1)
    }
    let disclosureValues: [(CFTypeRef?, Int?)] = [
        (kCFBooleanFalse, 0), (kCFBooleanTrue, 1),
        (NSNumber(value: 0), 0), (NSNumber(value: 1), 1),
        (NSNumber(value: 2), nil), ("0" as CFString, nil), (nil, nil)
    ]
    if !disclosureValues.allSatisfy({ binaryDisclosureValue($0.0) == $0.1 }) {
        print("Native macOS disclosure value checks failed")
        exit(1)
    }
    print("Native macOS disclosure value checks passed: 7")
    print("Native macOS selected-file checks passed: 9")
    print("Native macOS exact attribute checks passed: 10")
    exit(0)
}
let requested = arguments.count == 4 ? arguments[3] : "none"
var counts: [String: Int] = [
    "windows": 0, "sheets": 0, "visited": 0, "selectedRoots": 0,
    "selectedRows": 0, "selectedCells": 0, "selectedColumns": 0,
    "urlStrings": 0, "urlObjects": 0, "exactUrls": 0, "exactFilenames": 0,
    "basenameMatches": 0, "unsupported": 0, "cannotComplete": 0,
    "apiDisabled": 0, "otherErrors": 0, "lastError": 0,
    "selectedUrls": 0, "selectedExactUrls": 0, "selectedLeaves": 0, "leafMatches": 0, "buttons": 0,
    "valuePathMatches": 0, "filenamePathMatches": 0, "documentPathMatches": 0,
    "pathControls": 0, "popupControls": 0, "disclosures": 0,
    "expandedDisclosures": 0, "collapsedDisclosures": 0, "pathControlMatches": 0, "popupPathMatches": 0,
    "enabledDisclosures": 0, "zeroValueDisclosures": 0, "oneValueDisclosures": 0,
    "unknownValueDisclosures": 0, "disclosureActions": 0, "pressableDisclosures": 0
]
var complete = true
var verified = false
var pressed = false
var dismissed = false
var dismissalLastError = 0
var pressDurationMs = 0
var pressSheetState = "not_checked"
var pressFollowupError = 0
var foreground = false
var guardMask = 0
var stage = "arguments"
var firstOtherError = 0
var firstOtherAttribute = "none"
var firstOtherStage = "none"
var firstOtherVisited = 0
var firstOtherOrigin = "none"
var firstOtherParentRole = "none"
var firstExactURL: [String: Any] = ["role": "none", "parentRole": "none", "origin": "none", "selected": "unknown", "directory": false, "kind": "none"]
var firstOtherSelectedReference = false
var firstOtherSelectedBranch = false
var readSelectedReference = false
var readSelectedBranch = false
var readParentRole = "none"
var readOrigin = "discovery"
var firstCannotCompleteAttribute = "none"
var firstCannotCompleteStage = "none"
var firstCannotCompleteDurationMs = 0
let trusted = AXIsProcessTrusted()
let deadline = ProcessInfo.processInfo.systemUptime + 3

func recordReadError(_ status: AXError, name: String, duration: TimeInterval) {
    if status == .success { return }
    counts["lastError"] = Int(status.rawValue)
    switch status {
    case .attributeUnsupported, .noValue: counts["unsupported", default: 0] += 1
    case .cannotComplete:
        counts["cannotComplete", default: 0] += 1
        if firstCannotCompleteAttribute == "none" {
            firstCannotCompleteAttribute = name
            firstCannotCompleteStage = stage
            firstCannotCompleteDurationMs = min(999999, max(0, Int(duration * 1000)))
        }
    case .apiDisabled: counts["apiDisabled", default: 0] += 1
    default:
        counts["otherErrors", default: 0] += 1
        if firstOtherError == 0 {
            firstOtherError = Int(status.rawValue); firstOtherAttribute = name
            firstOtherStage = stage; firstOtherVisited = counts["visited"] ?? 0
            firstOtherOrigin = readOrigin
            firstOtherParentRole = readParentRole
            firstOtherSelectedReference = readSelectedReference
            firstOtherSelectedBranch = readSelectedBranch
        }
    }
}

func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    // Native CI observed AXRole timing out at 164 ms with the 150 ms read cap.
    // Give this identity read a separate cap; any failed read still prevents action.
    AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
    var value: CFTypeRef?
    let readStarted = ProcessInfo.processInfo.systemUptime
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status != .success {
        recordReadError(status, name: name, duration: ProcessInfo.processInfo.systemUptime - readStarted)
        return nil
    }
    return value
}

// Read-only action availability; this never performs an action or grants authorization.
// https://developer.apple.com/documentation/applicationservices/1462053-axuielementcopyactionnames
func disclosureActionNames(_ element: AXUIElement) -> [String] {
    AXUIElementSetMessagingTimeout(element, 0.15)
    var names: CFArray?
    let started = ProcessInfo.processInfo.systemUptime
    let status = AXUIElementCopyActionNames(element, &names)
    if status != .success {
        recordReadError(status, name: "AXActions", duration: ProcessInfo.processInfo.systemUptime - started)
        return []
    }
    guard let names = names as? [String], names.count <= 16 else { complete = false; return [] }
    return names
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
func diagnosticRole(_ role: String) -> String {
    return ["AXSheet", "AXBrowser", "AXScrollArea", "AXSplitGroup", "AXGroup", "AXList", "AXOutline", "AXTable", "AXColumn", "AXRow", "AXCell", "AXImage", "AXStaticText", "AXTextField", "AXButton", "AXPopUpButton", "AXDisclosureTriangle"].contains(role) ? role : "other"
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
    var queue: [(AXUIElement, String, String, Bool)] = sheets.count == 1 ? sheets.map { ($0, "sheet", "none", false) } : []
    seen = []
    stage = "selection"
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let (element, origin, parentRole, selectedBranch) = queue.removeFirst()
        readOrigin = origin
        readParentRole = parentRole
        readSelectedReference = selected.contains(where: { same($0, element) })
        readSelectedBranch = selectedBranch
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        counts["visited"] = seen.count
        let role = string(element, "AXRole") ?? ""
        let selectedFlag = read(element, "AXSelected") as? Bool
        if selectedFlag == true && !selected.contains(where: { same($0, element) }) { selected.append(element) }
        readSelectedReference = readSelectedReference || selectedFlag == true
        if requested == "none" {
            let title = string(element, "AXTitle")
            let value = read(element, "AXValue")
            let filename = read(element, "AXFilename")
            let document = read(element, "AXDocument")
            if title == target.lastPathComponent || (value as? String) == target.lastPathComponent { counts["basenameMatches", default: 0] += 1 }
            if (filename as? String) == arguments[2] { counts["exactFilenames", default: 0] += 1 }
            let valueMatches = exactTargetAttribute(value, target: target, path: arguments[2])
            if valueMatches { counts["valuePathMatches", default: 0] += 1 }
            if exactTargetAttribute(filename, target: target, path: arguments[2]) { counts["filenamePathMatches", default: 0] += 1 }
            if exactTargetAttribute(document, target: target, path: arguments[2]) { counts["documentPathMatches", default: 0] += 1 }
            if role == "AXPathControl" {
                counts["pathControls", default: 0] += 1
                if valueMatches { counts["pathControlMatches", default: 0] += 1 }
            }
            if role == "AXPopUpButton" {
                counts["popupControls", default: 0] += 1
                if valueMatches { counts["popupPathMatches", default: 0] += 1 }
            }
            if role == "AXDisclosureTriangle" {
                counts["disclosures", default: 0] += 1
                if (read(element, "AXEnabled") as? Bool) == true { counts["enabledDisclosures", default: 0] += 1 }
                switch binaryDisclosureValue(value) {
                case 0: counts["zeroValueDisclosures", default: 0] += 1
                case 1: counts["oneValueDisclosures", default: 0] += 1
                default: counts["unknownValueDisclosures", default: 0] += 1
                }
                let actions = disclosureActionNames(element)
                counts["disclosureActions", default: 0] += actions.count
                if actions.contains("AXPress") { counts["pressableDisclosures", default: 0] += 1 }
                if let expanded = read(element, "AXExpanded") as? Bool {
                    counts[expanded ? "expandedDisclosures" : "collapsedDisclosures", default: 0] += 1
                }
            }
        }
        if role == "AXButton" && string(element, "AXTitle") == (requested == "open" ? "Open" : "Cancel") { buttons.append(element) }
        if let value = read(element, "AXURL"), let url = nativeURL(value) {
            if CFGetTypeID(value) == CFURLGetTypeID() { counts["urlObjects", default: 0] += 1 }
            else { counts["urlStrings", default: 0] += 1 }
            if url.absoluteString == expected {
                counts["exactUrls", default: 0] += 1
                if requested == "none" && (firstExactURL["origin"] as? String) == "none" {
                    firstExactURL = ["role": diagnosticRole(role), "parentRole": parentRole, "origin": origin,
                        "selected": selectedFlag == true ? "true" : selectedFlag == false ? "false" : "unknown",
                        "directory": url.hasDirectoryPath, "kind": CFGetTypeID(value) == CFURLGetTypeID() ? "native" : "string"]
                }
            }
        }
        var next: [(AXUIElement, String, String, Bool)] = []
        for name in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells", "AXSelectedColumns"] {
            for child in elements(element, name) {
                if !selected.contains(where: { same($0, child) }) { selected.append(child) }
                next.append((child, name, diagnosticRole(role), true))
            }
        }
        if ["AXList", "AXOutline", "AXTable", "AXColumn"].contains(role) { next.append(contentsOf: elements(element, "AXColumns").map { ($0, "AXColumns", diagnosticRole(role), selectedBranch || readSelectedReference) }) }
        else { next.append(contentsOf: elements(element, "AXChildren").map { ($0, "AXChildren", diagnosticRole(role), selectedBranch || readSelectedReference) }) }
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next)
    }
    stage = "verification"
    readOrigin = "selected_verification"
    readSelectedReference = true
    readSelectedBranch = true
    readParentRole = "none"
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
        readOrigin = "guard"
        readSelectedReference = false
        readSelectedBranch = false
        readParentRole = "none"
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
            let pressStarted = ProcessInfo.processInfo.systemUptime
            // Action callbacks can outlast the 150 ms attribute-read timeout.
            // Keep the single action bounded inside the unchanged seven-second host budget.
            let timeoutStatus = AXUIElementSetMessagingTimeout(button, 1)
            let status = timeoutStatus == .success
                ? AXUIElementPerformAction(button, "AXPress" as CFString) : timeoutStatus
            pressDurationMs = min(999999, max(0, Int((ProcessInfo.processInfo.systemUptime - pressStarted) * 1000)))
            counts["lastError"] = Int(status.rawValue)
            pressed = status == .success
            if !pressed {
                var role: CFTypeRef?
                let sheetStatus = AXUIElementCopyAttributeValue(sheet, "AXRole" as CFString, &role)
                if sheetStatus == .invalidUIElement { pressSheetState = "invalid_sheet" }
                else {
                    var children: CFTypeRef?
                    let parentStatus = AXUIElementCopyAttributeValue(parent, "AXChildren" as CFString, &children)
                    if parentStatus == .success, let current = children as? [AXUIElement], current.count <= 256 {
                        pressSheetState = current.contains(where: { same($0, sheet) }) ? "attached_sheet" : "detached_sheet"
                    } else {
                        pressSheetState = "unknown"
                        pressFollowupError = Int((parentStatus != .success ? parentStatus : sheetStatus).rawValue)
                    }
                }
            }
            if pressed {
                stage = "dismissal"
                let dismissDeadline = ProcessInfo.processInfo.systemUptime + 2
                while ProcessInfo.processInfo.systemUptime < dismissDeadline {
                    var value: CFTypeRef?
                    let sheetStatus = AXUIElementCopyAttributeValue(sheet, "AXRole" as CFString, &value)
                    if sheetStatus == .invalidUIElement { dismissed = true; break }
                    if sheetStatus != .success { dismissalLastError = Int(sheetStatus.rawValue) }
                    var children: CFTypeRef?
                    let parentStatus = AXUIElementCopyAttributeValue(parent, "AXChildren" as CFString, &children)
                    if parentStatus != .success { dismissalLastError = Int(parentStatus.rawValue) }
                    if parentStatus == .success,
                       let current = children as? [AXUIElement], current.count <= 256,
                       !current.contains(where: { same($0, sheet) }) { dismissed = true; break }
                    Thread.sleep(forTimeInterval: 0.02)
                }
                if dismissed { stage = "complete" }
                else { counts["lastError"] = dismissalLastError }
            }
        }
    }
} else { complete = false }
if !noReadFailures() { complete = false }
for key in Array(counts.keys) where key != "lastError" { counts[key] = min(counts[key] ?? 0, 999) }
let lastError = counts.removeValue(forKey: "lastError") ?? 0
let result: [String: Any] = [
    "counts": counts, "firstExactURL": firstExactURL, "lastError": lastError, "dismissalLastError": dismissalLastError,
    "pressDurationMs": pressDurationMs, "pressSheetState": pressSheetState,
    "pressFollowupError": pressFollowupError,
    "trusted": trusted, "complete": complete,
    "firstOtherSelectedReference": firstOtherSelectedReference, "firstOtherSelectedBranch": firstOtherSelectedBranch,
    "firstOtherError": firstOtherError, "firstOtherAttribute": firstOtherAttribute,
    "firstOtherStage": firstOtherStage, "firstOtherVisited": firstOtherVisited, "firstOtherOrigin": firstOtherOrigin, "firstOtherParentRole": firstOtherParentRole,
    "firstCannotCompleteAttribute": firstCannotCompleteAttribute,
    "firstCannotCompleteStage": firstCannotCompleteStage,
    "firstCannotCompleteDurationMs": firstCannotCompleteDurationMs,
    "verified": verified, "foreground": foreground, "stage": stage, "guardMask": guardMask,
    "action": ["requested": requested, "pressed": pressed, "dismissed": dismissed]
]
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
   let output = String(data: data, encoding: .utf8) { print(output) }
