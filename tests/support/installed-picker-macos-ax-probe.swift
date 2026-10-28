import AppKit
import ApplicationServices
import Foundation
import Darwin

// CI-only native AX verification; actions require exact file or directory/filename proof.
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

// Observation only: selected-parent URL fields do not authorize a Save action.
func selectedDirectoryObservation(_ input: [URL], expected: URL) -> [String: Any] {
    let selection = selectedFileEvidence(input, expected: expected)
    var unique: [URL] = []
    for url in input where !unique.contains(where: { $0.absoluteString == url.absoluteString }) { unique.append(url) }
    return ["fields": input.count, "uniqueUrls": unique.count, "terminalUrls": selection.leaves.count,
        "terminalMatches": selection.matches,
        "validShape": !input.isEmpty && expected.isFileURL && expected.hasDirectoryPath && expected.query == nil && expected.fragment == nil &&
            input.allSatisfy { $0.isFileURL && $0.hasDirectoryPath && $0.host == expected.host && $0.query == nil && $0.fragment == nil }]
}

func vanishedChildParent(_ observation: [String: Any]) -> Bool {
    guard let children = observation["children"] as? Int, (0...256).contains(children) else { return false }
    return (observation["status"] as? String) == "complete" && (observation["role"] as? String) == "AXScrollArea" &&
        (observation["pidMatches"] as? Bool) == true && (observation["selectedReference"] as? Bool) == false &&
        (observation["containsFailedReference"] as? String) == "false" && (observation["attribute"] as? String) == "none" &&
        (observation["error"] as? Int) == 0
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

// Categories only: no private title/value or hierarchy identifiers leave the probe.
func fieldTextCategory(_ value: CFTypeRef?, target: URL, path: String) -> String {
    guard let value = value else { return "unavailable" }
    if exactTargetAttribute(value, target: target, path: path) { return "target_path" }
    guard let text = value as? String else { return "other" }
    if text == target.lastPathComponent { return "target_basename" }
    if text == "Save As:" || text == "Save As" { return "save_as" }
    if text == "Where:" || text == "Where" { return "where" }
    if text == "Search" || text == "Search:" { return "search" }
    return text.isEmpty ? "empty" : "other"
}
func traversalRoleBit(_ role: String) -> Int {
    switch role {
    case "AXBrowser": return 1
    case "AXScrollArea": return 2
    case "AXSplitGroup": return 4
    case "AXGroup": return 8
    case "AXPathControl": return 16
    case "AXPopUpButton": return 32
    default: return 0
    }
}

func absentParentStatus(_ status: AXError) -> String {
    return status == .noValue ? "missing_parent" : "unreadable_parent"
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
    let categories: [(CFTypeRef?, String)] = [
        (nil, "unavailable"), ("Save As:" as CFString, "save_as"), ("Where" as CFString, "where"),
        ("Search:" as CFString, "search"), ("" as CFString, "empty"), ("fixture" as CFString, "other"),
        (target.absoluteString as CFString, "target_path"), (target.path as CFString, "target_path"),
        (target as CFURL, "target_path"), (target.lastPathComponent as CFString, "target_basename")
    ]
    if !categories.allSatisfy({ fieldTextCategory($0.0, target: target, path: target.path) == $0.1 }) { exit(1) }
    if (traversalRoleBit("AXBrowser") | traversalRoleBit("AXGroup")) != 9 || traversalRoleBit("private") != 0 { exit(1) }
    let descendant = URL(fileURLWithPath: "/fixture/subfolder", isDirectory: true)
    let otherDirectory = URL(fileURLWithPath: "/other", isDirectory: true)
    let directoryCases: [([URL], Int, Int, Bool)] = [
        ([directory], 1, 1, true), ([directory, directory], 1, 1, true),
        ([directory, descendant], 1, 0, true), ([directory, otherDirectory], 2, 1, true),
        ([], 0, 0, false), ([target], 1, 0, false), ([directory, target], 1, 0, false),
        ([hostTrap], 1, 0, false), ([URL(string: "https://example.invalid/fixture/")!], 1, 0, false)
    ]
    for item in directoryCases {
        let observed = selectedDirectoryObservation(item.0, expected: directory)
        if observed["terminalUrls"] as? Int != item.1 || observed["terminalMatches"] as? Int != item.2 || observed["validShape"] as? Bool != item.3 { exit(1) }
    }
    print("Native macOS selected directory observation checks passed: 9")
    let vanishedParent: [String: Any] = ["status": "complete", "role": "AXScrollArea", "pidMatches": true, "selectedReference": false,
        "children": 14, "containsFailedReference": "false", "attribute": "none", "error": 0]
    if !vanishedChildParent(vanishedParent) { exit(1) }
    let refusedParents: [[String: Any]] = [["status": "error"], ["role": "AXGroup"], ["pidMatches": false], ["selectedReference": true],
        ["children": 257], ["containsFailedReference": "true"], ["containsFailedReference": "unknown"], ["attribute": "AXChildren"], ["error": -25202]]
    for change in refusedParents {
        var observation = vanishedParent
        for (key, value) in change { observation[key] = value }
        if vanishedChildParent(observation) { exit(1) }
    }
    print("Native macOS vanished-child parent checks passed: 10")
    let parentCases: [(AXError, String)] = [(.noValue, "missing_parent"), (.cannotComplete, "unreadable_parent"),
        (.invalidUIElement, "unreadable_parent"), (.attributeUnsupported, "unreadable_parent"), (.success, "unreadable_parent")]
    if !parentCases.allSatisfy({ absentParentStatus($0.0) == $0.1 }) { exit(1) }
    print("Native macOS absent parent checks passed: 5")
    print("Native macOS field context checks passed: 10")
    print("Native macOS disclosure value checks passed: 7")
    print("Native macOS selected-file checks passed: 9")
    print("Native macOS exact attribute checks passed: 10")
    do {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = root.appendingPathComponent("fixture.json")
        try Data("private existing native export target fixture".utf8).write(to: fixture)
        if !isExistingReplacementFixture(fixture.path) { exit(1) }
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture)
        if isExistingReplacementFixture(link.path) || isExistingReplacementFixture(root.path) ||
            isExistingReplacementFixture(root.appendingPathComponent("absent.json").path) { exit(1) }
        try Data(repeating: 0, count: Data("private existing native export target fixture".utf8).count).write(to: fixture)
        if isExistingReplacementFixture(fixture.path) { exit(1) }
        print("Native macOS existing replacement fixture checks passed: 5")
    } catch { exit(1) }
    exit(0)
}
let requested = arguments.count >= 4 ? arguments[3] : "none"
let saveNames = ["json": "Open Chords.json", "lrc": "Open Chords.lrc", "chordpro": "Open Chords.cho", "pdf": "Open Chords.pdf", "archive": "Open Chords.ocarchive"]
let expectedSaveName = arguments.count >= 5 && requested == "directory_snapshot" ? saveNames[arguments[4]] : nil
var counts: [String: Int] = [
    "windows": 0, "sheets": 0, "visited": 0, "selectedRoots": 0,
    "selectedRows": 0, "selectedCells": 0, "selectedColumns": 0,
    "urlStrings": 0, "urlObjects": 0, "exactUrls": 0, "exactFilenames": 0,
    "basenameMatches": 0, "unsupported": 0, "cannotComplete": 0,
    "apiDisabled": 0, "otherErrors": 0, "lastError": 0,
    "saveButtons": 0, "selectedUrls": 0, "selectedExactUrls": 0, "selectedLeaves": 0, "leafMatches": 0, "buttons": 0,
    "valuePathMatches": 0, "filenamePathMatches": 0, "documentPathMatches": 0,
    "pathControls": 0, "popupControls": 0, "disclosures": 0,
    "expandedDisclosures": 0, "collapsedDisclosures": 0, "pathControlMatches": 0, "popupPathMatches": 0,
    "enabledDisclosures": 0, "zeroValueDisclosures": 0, "oneValueDisclosures": 0,
    "unknownValueDisclosures": 0, "disclosureActions": 0, "pressableDisclosures": 0
]
var complete = true
var onlyInvalidChildErrors = true
var vanishedChildCandidates = 0
var allInvalidChildrenVanished = true
var staleChildContext = false
var invalidRoleElement: AXUIElement? = nil
var snapshotRefreshEligible = false
var snapshotTraversalComplete = false
let savesNewJson = arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "json" && arguments[5] == "--save-new-json"
let savesNewText = arguments.count == 6 && arguments[3] == "directory_snapshot" && ["lrc", "chordpro"].contains(arguments[4]) && arguments[5] == "--save-new-text"
let savesNewPdf = arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "pdf" && arguments[5] == "--save-new-pdf"
let savesNewArchive = arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "archive" && arguments[5] == "--save-new-archive"
let savesNewExport = savesNewJson || savesNewText || savesNewPdf || savesNewArchive
let cancelsReplaceJson = arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "json" && arguments[5] == "--cancel-replace-json"
let replacesJson = arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "json" && arguments[5] == "--replace-json"
let replacesText = arguments.count == 6 && arguments[3] == "directory_snapshot" && ["lrc", "chordpro"].contains(arguments[4]) && arguments[5] == "--replace-text"
let replacesExport = replacesJson || replacesText
let observesReplacement = replacesExport || cancelsReplaceJson || (arguments.count == 6 && arguments[3] == "directory_snapshot" && arguments[4] == "json" && arguments[5] == "--observe-replace-json")
let verifiesFilename = (arguments.count == 6 && arguments[5] == "--verify-filename") || savesNewExport || observesReplacement
var saveTargetExistingFixture = false
var replaceContext: [String: Any] = ["status": "not_checked", "visited": 0, "windows": 0, "sheets": 0, "dialogs": 0, "buttons": 0, "cancel": 0, "replace": 0, "save": 0, "other": 0, "foreground": false, "error": 0]
var saveTargetAbsent = false
var saveFilename: [String: Any] = ["status": "not_checked", "fields": 0, "matches": 0, "absentValues": 0, "enabled": false, "labelMatched": false, "fieldAttached": false, "labelAttached": false, "visited": 0, "verified": false, "error": 0, "attribute": "none"]
var saveTargetContext: [String: Any] = ["status": "not_checked", "fields": 0, "valueMatches": 0, "enabledMatches": 0, "labelMatches": 0, "descriptionMatches": 0, "linkedLabelMatches": 0, "linkedLabelRole": "none", "error": 0, "attribute": "none"]
var directoryVerified = false
var verified = false
var pressed = false
var dismissed = false
var dismissalLastError = 0
var pressDurationMs = 0
var pressTimeoutError = 0
var pressActionCalled = false
var pressSheetState = "not_checked"
var pressFollowupError = 0
var foreground = false
var guardEnabledState = "not_checked"
var guardMask = 0
var stage = "arguments"
var firstOtherError = 0
var firstOtherAttribute = "none"
var firstOtherStage = "none"
var firstOtherVisited = 0
var firstOtherOrigin = "none"
var firstOtherParentRole = "none"
var selectedDirectory: [String: Any] = ["fields": 0, "uniqueUrls": 0, "terminalUrls": 0, "terminalMatches": 0, "validShape": false]
var invalidChildParent: [String: Any] = ["status": "not_checked", "role": "none", "pidMatches": false, "selectedReference": false, "children": 0, "containsFailedReference": "unknown", "attribute": "none", "error": 0]
var firstFailureParent = invalidChildParent
var currentDirectParent: (AXUIElement, pid_t, Bool)? = nil
var firstExactElement: AXUIElement? = nil
var parentChain: [String: Any] = ["status": "not_checked", "visited": 0, "selected": 0, "unknownSelected": 0, "roleMask": 0, "nodes": [[String: Any]]()]
var firstExactURL: [String: Any] = ["role": "none", "parentRole": "none", "origin": "none", "selected": "unknown", "directory": false, "kind": "none", "titleCategory": "unavailable", "valueCategory": "unavailable", "traversalRoleMask": 0, "traversalDepth": 0]
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

func recordReadError(_ status: AXError, name: String, duration: TimeInterval, invalidChildRead: Bool = false) {
    if status == .success { return }
    counts["lastError"] = Int(status.rawValue)
    switch status {
    case .attributeUnsupported, .noValue: counts["unsupported", default: 0] += 1
    case .cannotComplete:
        onlyInvalidChildErrors = false
        counts["cannotComplete", default: 0] += 1
        if firstCannotCompleteAttribute == "none" {
            firstCannotCompleteAttribute = name
            firstCannotCompleteStage = stage
            firstCannotCompleteDurationMs = min(999999, max(0, Int(duration * 1000)))
        }
    case .apiDisabled: onlyInvalidChildErrors = false; counts["apiDisabled", default: 0] += 1
    default:
        onlyInvalidChildErrors = onlyInvalidChildErrors && status == .invalidUIElement && invalidChildRead
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

func readResult(_ element: AXUIElement, _ name: String) -> (status: AXError, value: CFTypeRef?) {
    // Native CI observed AXRole timing out at 164 ms with the 150 ms read cap.
    // Give this identity read a separate cap; any failed read still prevents action.
    AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
    var value: CFTypeRef?
    let readStarted = ProcessInfo.processInfo.systemUptime
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status != .success {
        let invalidChildRead = staleChildContext && !readSelectedReference && !readSelectedBranch &&
            (name == "AXRole" || invalidRoleElement.map { same($0, element) } == true)
        let firstFailure = firstOtherError == 0
        recordReadError(status, name: name, duration: ProcessInfo.processInfo.systemUptime - readStarted, invalidChildRead: invalidChildRead)
        if firstFailure && status == .invalidUIElement && staleChildContext && !readSelectedReference && !readSelectedBranch,
           let (parent, pid, parentSelected) = currentDirectParent {
            firstFailureParent = invalidChildParentObservation(parent, child: element, pid: pid, selectedReference: parentSelected)
        }
        return (status, nil)
    }
    return (status, value)
}
func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    return readResult(element, name).value
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

// Failure-only diagnostic. It neither retries the failed child nor changes read-error accounting.
func invalidChildParentObservation(_ parent: AXUIElement, child: AXUIElement, pid: pid_t, selectedReference: Bool) -> [String: Any] {
    var result: [String: Any] = ["status": "complete", "role": "none", "pidMatches": false, "selectedReference": selectedReference,
        "children": 0, "containsFailedReference": "unknown", "attribute": "pid", "error": 0]
    if ProcessInfo.processInfo.systemUptime >= deadline { result["status"] = "deadline"; return result }
    var actualPid: pid_t = 0
    let pidStatus = AXUIElementGetPid(parent, &actualPid)
    if pidStatus != .success { result["status"] = "error"; result["error"] = Int(pidStatus.rawValue); return result }
    result["pidMatches"] = actualPid == pid
    result["attribute"] = "AXRole"
    var status = AXUIElementSetMessagingTimeout(parent, 0.5)
    if status != .success { result["status"] = "error"; result["error"] = Int(status.rawValue); return result }
    var value: CFTypeRef?
    status = AXUIElementCopyAttributeValue(parent, "AXRole" as CFString, &value)
    if status != .success { result["status"] = "error"; result["error"] = Int(status.rawValue); return result }
    guard let role = value as? String else { result["status"] = "invalid_value"; return result }
    result["role"] = diagnosticRole(role)
    if ProcessInfo.processInfo.systemUptime >= deadline { result["status"] = "deadline"; return result }
    result["attribute"] = "AXChildren"
    status = AXUIElementSetMessagingTimeout(parent, 0.15)
    if status != .success { result["status"] = "error"; result["error"] = Int(status.rawValue); return result }
    value = nil
    status = AXUIElementCopyAttributeValue(parent, "AXChildren" as CFString, &value)
    if status != .success { result["status"] = "error"; result["error"] = Int(status.rawValue); return result }
    guard let children = value as? [AXUIElement] else { result["status"] = "invalid_value"; return result }
    result["children"] = min(children.count, 257)
    if children.count > 256 { result["status"] = "bound"; return result }
    result["containsFailedReference"] = children.contains(where: { same($0, child) }) ? "true" : "false"
    result["attribute"] = "none"
    if ProcessInfo.processInfo.systemUptime >= deadline { result["status"] = "deadline" }
    return result
}

func noReadFailures() -> Bool {
    counts["cannotComplete", default: 0] == 0 && counts["apiDisabled", default: 0] == 0 && counts["otherErrors", default: 0] == 0
}

// Read-only candidate context, independent of directory proof and never action authorization.
func observeSaveTarget(_ fields: [AXUIElement], expected: String, pid: pid_t) -> [String: Any] {
    var result: [String: Any] = ["status": "complete", "fields": fields.count, "valueMatches": 0, "enabledMatches": 0, "labelMatches": 0, "descriptionMatches": 0, "linkedLabelMatches": 0, "linkedLabelRole": "none", "error": 0, "attribute": "none"]
    func observe(_ field: AXUIElement, _ name: String) -> CFTypeRef? {
        if ProcessInfo.processInfo.systemUptime >= deadline {
            if (result["status"] as? String) == "complete" { result["status"] = "deadline" }
            return nil
        }
        AXUIElementSetMessagingTimeout(field, 0.15)
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(field, name as CFString, &value)
        if status != .success {
            if (result["status"] as? String) == "complete" { result["status"] = "error" }
            if (result["error"] as? Int) == 0 { result["error"] = Int(status.rawValue); result["attribute"] = name }
            return nil
        }
        return value
    }
    for field in fields {
        if ProcessInfo.processInfo.systemUptime >= deadline {
            if (result["status"] as? String) == "complete" { result["status"] = "deadline" }
            break
        }
        if (observe(field, "AXValue") as? String) == expected {
            result["valueMatches"] = (result["valueMatches"] as? Int ?? 0) + 1
            if (observe(field, "AXEnabled") as? Bool) == true { result["enabledMatches"] = (result["enabledMatches"] as? Int ?? 0) + 1 }
            if let title = observe(field, "AXTitle") as? String, ["Save As:", "Save As"].contains(title) {
                result["labelMatches"] = (result["labelMatches"] as? Int ?? 0) + 1
            }
            if let description = observe(field, "AXDescription") as? String, ["Save As:", "Save As"].contains(description) {
                result["descriptionMatches"] = (result["descriptionMatches"] as? Int ?? 0) + 1
            }
            if let labelValue = observe(field, "AXTitleUIElement"), CFGetTypeID(labelValue) == AXUIElementGetTypeID() {
                let label = unsafeBitCast(labelValue, to: AXUIElement.self)
                var labelPid: pid_t = 0
                if ProcessInfo.processInfo.systemUptime >= deadline {
                    if (result["status"] as? String) == "complete" { result["status"] = "deadline" }
                    continue
                }
                let pidStatus = AXUIElementGetPid(label, &labelPid)
                if pidStatus != .success {
                    if (result["status"] as? String) == "complete" { result["status"] = "error" }
                    if (result["error"] as? Int) == 0 { result["error"] = Int(pidStatus.rawValue); result["attribute"] = "pid" }
                    continue
                }
                if ProcessInfo.processInfo.systemUptime >= deadline {
                    if (result["status"] as? String) == "complete" { result["status"] = "deadline" }
                    continue
                }
                if labelPid == pid {
                    let role = observe(label, "AXRole") as? String
                    result["linkedLabelRole"] = role == "AXStaticText" ? "static_text" : "other"
                    if role == "AXStaticText", let value = observe(label, "AXValue") as? String, ["Save As:", "Save As"].contains(value) {
                        result["linkedLabelMatches"] = (result["linkedLabelMatches"] as? Int ?? 0) + 1
                    }
                }
            }
        }
    }
    return result
}

// Independent required-attribute proof. It never presses Save or changes directory guards.
func verifySaveFilename(_ fields: [AXUIElement], expected: String, pid: pid_t, sheet: AXUIElement) -> [String: Any] {
    var result: [String: Any] = ["status": "complete", "fields": fields.count, "matches": 0, "absentValues": 0, "enabled": false, "labelMatched": false, "fieldAttached": false, "labelAttached": false, "visited": 0, "verified": false, "error": 0, "attribute": "none"]
    func refuse(_ status: String, _ attribute: String = "none", _ error: Int = 0) {
        if (result["status"] as? String) == "complete" { result["status"] = status; result["attribute"] = attribute; result["error"] = error }
    }
    func withinBudget() -> Bool {
        if ProcessInfo.processInfo.systemUptime >= deadline { refuse("deadline"); return false }
        return true
    }
    func required(_ element: AXUIElement, _ name: String, inventoryValue: Bool = false) -> CFTypeRef? {
        guard withinBudget() else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.15)
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        // noValue positively establishes absence only during candidate inventory.
        if inventoryValue && name == "AXValue" && status == .noValue {
            guard withinBudget() else { return nil }
            result["absentValues"] = (result["absentValues"] as? Int ?? 0) + 1
            return nil
        }
        if status != .success { refuse("error", name, Int(status.rawValue)); return nil }
        guard withinBudget(), let value = value else { refuse("invalid_candidate", name); return nil }
        return value
    }
    func samePid(_ element: AXUIElement) -> Bool {
        guard withinBudget() else { return false }
        var actual: pid_t = 0
        let status = AXUIElementGetPid(element, &actual)
        if status != .success { refuse("error", "pid", Int(status.rawValue)); return false }
        guard withinBudget(), actual == pid else { refuse("invalid_candidate", "pid"); return false }
        return true
    }
    func attached(_ element: AXUIElement) -> Bool {
        var current = element
        var seen: [AXUIElement] = []
        for _ in 0..<16 {
            guard withinBudget(), samePid(current) else { return false }
            if same(current, sheet) { return true }
            if seen.contains(where: { same($0, current) }) { refuse("invalid_candidate", "AXParent"); return false }
            seen.append(current)
            result["visited"] = (result["visited"] as? Int ?? 0) + 1
            guard let parent = required(current, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { refuse("invalid_candidate", "AXParent"); return false }
            current = unsafeBitCast(parent, to: AXUIElement.self)
        }
        refuse("bound", "AXParent"); return false
    }
    var matches: [AXUIElement] = []
    for field in fields {
        guard let value = required(field, "AXValue", inventoryValue: true) else { continue }
        if (value as? String) == expected { matches.append(field) }
    }
    result["matches"] = matches.count
    guard (result["status"] as? String) == "complete" else { return result }
    guard matches.count == 1 else { refuse("invalid_candidate", "AXValue"); return result }
    let field = matches[0]
    guard samePid(field), (required(field, "AXRole") as? String) == "AXTextField" else { refuse("invalid_candidate", "AXRole"); return result }
    guard (required(field, "AXEnabled") as? Bool) == true else { refuse("invalid_candidate", "AXEnabled"); return result }
    result["enabled"] = true
    guard let labelValue = required(field, "AXTitleUIElement"), CFGetTypeID(labelValue) == AXUIElementGetTypeID() else { refuse("invalid_candidate", "AXTitleUIElement"); return result }
    let label = unsafeBitCast(labelValue, to: AXUIElement.self)
    guard samePid(label), (required(label, "AXRole") as? String) == "AXStaticText",
          let labelText = required(label, "AXValue") as? String, ["Save As:", "Save As"].contains(labelText) else { refuse("invalid_candidate", "AXTitleUIElement"); return result }
    result["labelMatched"] = true
    guard attached(field) else { return result }
    result["fieldAttached"] = true
    guard attached(label) else { return result }
    result["labelAttached"] = true
    guard withinBudget(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { refuse("invalid_candidate", "pid"); return result }
    result["verified"] = (result["status"] as? String) == "complete"
    return result
}

// The observation action is restricted to a fixed regular fixture, never arbitrary existing data.
func isExistingReplacementFixture(_ path: String) -> Bool {
    let expected = Data("private existing native export target fixture".utf8)
    var original = stat()
    guard lstat(path, &original) == 0, (original.st_mode & S_IFMT) == S_IFREG,
          original.st_size == expected.count else { return false }
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { return false }
    defer { close(descriptor) }
    var current = stat()
    guard fstat(descriptor, &current) == 0, current.st_dev == original.st_dev,
          current.st_ino == original.st_ino, current.st_size == expected.count,
          (current.st_mode & S_IFMT) == S_IFREG else { return false }
    let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    return (try? file.read(upToCount: expected.count + 1)) == expected
}

// Fresh context after one guarded Save. Confirmation actions are opt-in and separately guarded.
func observeReplacementContext(_ app: AXUIElement, pid: pid_t, save: AXUIElement, sheet: AXUIElement, parent: AXUIElement, cancelConfirmation: Bool = false, replaceConfirmation: Bool = false) -> [String: Any] {
    var result: [String: Any] = ["status": "complete", "visited": 0, "windows": 0, "sheets": 0, "dialogs": 0, "buttons": 0, "cancel": 0, "replace": 0, "save": 0, "other": 0, "foreground": false, "error": 0]
    var currentAttribute = "none", currentRole = "unknown", currentParentRole = "none", currentPidState = "not_checked"
    var currentSheetBranch = false
    result["sheetBranch"] = false
    result["attribute"] = "none"; result["role"] = "unknown"; result["parentRole"] = "none"; result["pidState"] = "not_checked"
    result["foreignRole"] = "not_checked"; result["foreignRoleError"] = 0
    func roleCategory(_ role: String) -> String {
        switch role {
        case "AXWindow": return "window"
        case "AXSheet": return "sheet"
        case "AXDialog": return "dialog"
        case "AXButton": return "button"
        case "AXWebArea": return "web_area"
        case "AXGroup": return "group"
        case "AXStaticText": return "static_text"
        case "AXTextField": return "text_field"
        case "AXTextArea": return "text_area"
        case "AXScrollArea": return "scroll_area"
        case "AXScrollBar": return "scroll_bar"
        case "AXSplitGroup": return "split_group"
        case "AXSplitter": return "splitter"
        case "AXBrowser": return "browser"
        case "AXList": return "list"
        case "AXOutline": return "outline"
        case "AXTable": return "table"
        case "AXRow": return "row"
        case "AXColumn": return "column"
        case "AXCell": return "cell"
        case "AXImage": return "image"
        case "AXPopUpButton": return "popup_button"
        case "AXMenuButton": return "menu_button"
        case "AXMenu": return "menu"
        case "AXMenuItem": return "menu_item"
        case "AXMenuBar": return "menu_bar"
        case "AXMenuBarItem": return "menu_bar_item"
        case "AXCheckBox": return "check_box"
        case "AXRadioButton": return "radio_button"
        case "AXTabGroup": return "tab_group"
        case "AXToolbar": return "toolbar"
        case "AXComboBox": return "combo_box"
        case "AXDisclosureTriangle": return "disclosure_triangle"
        case "AXLink": return "link"
        case "AXHeading": return "heading"
        case "AXUnknown": return "ax_unknown"
        default: return "other"
        }
    }
    // Bounded observation on a unique nested sheet; optional Cancel has separate fresh guards.
    func modalObservation(_ root: AXUIElement) -> [String: Any] {
        var modal: [String: Any] = ["modalStatus": "complete", "modalVisited": 0, "modalButtons": 0, "modalCancel": 0, "modalReplace": 0, "modalEnabledCancel": 0, "modalEnabledReplace": 0, "modalError": 0, "modalAttribute": "none", "modalRole": "unknown"]
        var roleCategoryNow = "unknown"
        func fail(_ status: String, _ attribute: String, _ error: AXError = .success) {
            if (modal["modalStatus"] as? String) == "complete" {
                modal["modalStatus"] = status; modal["modalAttribute"] = attribute
                modal["modalRole"] = roleCategoryNow; modal["modalError"] = Int(error.rawValue)
            }
        }
        func value(_ element: AXUIElement, _ name: String, optional: Bool = false) -> CFTypeRef? {
            guard ProcessInfo.processInfo.systemUptime < deadline else { fail("deadline", name); return nil }
            let timeout = AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
            var output: CFTypeRef?
            let status = timeout == .success ? AXUIElementCopyAttributeValue(element, name as CFString, &output) : timeout
            if optional && (status == .noValue || status == .attributeUnsupported) { return nil }
            guard status == .success, let output = output else { fail("error", name, status); return nil }
            if ProcessInfo.processInfo.systemUptime >= deadline { fail("deadline", name); return nil }
            return output
        }
        var cancelButtons: [AXUIElement] = [], replaceButtons: [AXUIElement] = []
        var queue = [root], visited: [AXUIElement] = []
        while !queue.isEmpty && (modal["modalStatus"] as? String) == "complete" {
            if visited.count >= 64 { fail("bound", "AXChildren"); break }
            let element = queue.removeFirst()
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element); modal["modalVisited"] = visited.count; roleCategoryNow = "unknown"
            if ProcessInfo.processInfo.systemUptime >= deadline { fail("deadline", "pid"); break }
            var actualPid: pid_t = 0
            let pidStatus = AXUIElementGetPid(element, &actualPid)
            guard pidStatus == .success, actualPid == pid else { fail("error", "pid", pidStatus == .success ? .illegalArgument : pidStatus); break }
            guard let role = value(element, "AXRole") as? String else { fail("invalid_value", "AXRole"); break }
            roleCategoryNow = roleCategory(role)
            if role == "AXButton" {
                modal["modalButtons"] = (modal["modalButtons"] as? Int ?? 0) + 1
                let title = value(element, "AXTitle", optional: true) as? String
                if title == "Cancel" || title == "Replace" {
                    if title == "Cancel" { cancelButtons.append(element) }
                    if title == "Replace" { replaceButtons.append(element) }
                    let key = title == "Cancel" ? "modalCancel" : "modalReplace"
                    modal[key] = (modal[key] as? Int ?? 0) + 1
                    guard let enabled = value(element, "AXEnabled") as? Bool else { fail("invalid_value", "AXEnabled"); break }
                    if enabled {
                        let enabledKey = title == "Cancel" ? "modalEnabledCancel" : "modalEnabledReplace"
                        modal[enabledKey] = (modal[enabledKey] as? Int ?? 0) + 1
                    }
                }
            }
            if let raw = value(element, "AXChildren", optional: true) {
                guard let children = raw as? [AXUIElement] else { fail("invalid_value", "AXChildren"); break }
                if queue.count + children.count + visited.count > 64 { fail("bound", "AXChildren"); break }
                queue.append(contentsOf: children)
            }
        }
        // Fresh reciprocal attachment evidence, separate from the preserved broad-context refusal.
        // This is read-only and does not authorize a confirmation action.
        if (modal["modalStatus"] as? String) == "complete" {
            modal["modalBindingStatus"] = "complete"; modal["modalBindingParent"] = "unknown"
            modal["modalBindingMatches"] = 0; modal["modalBindingSheetAttached"] = false
            modal["modalBindingForeground"] = false; modal["modalBindingError"] = 0; modal["modalBindingAttribute"] = "none"
            func bindingFail(_ status: String, _ attribute: String, _ error: AXError = .success) {
                if (modal["modalBindingStatus"] as? String) == "complete" {
                    modal["modalBindingStatus"] = status; modal["modalBindingAttribute"] = attribute
                    modal["modalBindingError"] = Int(error.rawValue)
                }
            }
            func bindingPid(_ element: AXUIElement) -> Bool {
                guard ProcessInfo.processInfo.systemUptime < deadline else { bindingFail("deadline", "pid"); return false }
                var actualPid: pid_t = 0
                let status = AXUIElementGetPid(element, &actualPid)
                guard status == .success, actualPid == pid else { bindingFail("invalid_candidate", "pid", status); return false }
                return true
            }
            func bindingRead(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
                guard ProcessInfo.processInfo.systemUptime < deadline else { bindingFail("deadline", name); return nil }
                let timeout = AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
                var output: CFTypeRef?
                let status = timeout == .success ? AXUIElementCopyAttributeValue(element, name as CFString, &output) : timeout
                guard status == .success, let output = output else { bindingFail("error", name, status); return nil }
                guard ProcessInfo.processInfo.systemUptime < deadline else { bindingFail("deadline", name); return nil }
                return output
            }
            func bind() {
                guard bindingPid(root), bindingPid(sheet), bindingPid(parent) else { return }
                guard (bindingRead(root, "AXRole") as? String) == "AXSheet" else { bindingFail("invalid_value", "AXRole"); return }
                guard let rawParent = bindingRead(root, "AXParent") else { return }
                guard CFGetTypeID(rawParent) == AXUIElementGetTypeID() else { bindingFail("invalid_value", "AXParent"); return }
                let actualParent = unsafeBitCast(rawParent, to: AXUIElement.self)
                guard bindingPid(actualParent) else { return }
                let parentKind = CFEqual(actualParent, sheet) ? "sheet" : CFEqual(actualParent, parent) ? "parent" : "other"
                modal["modalBindingParent"] = parentKind
                guard parentKind != "other" else { bindingFail("invalid_candidate", "AXParent"); return }
                guard let rawChildren = bindingRead(actualParent, "AXChildren") else { return }
                guard let children = rawChildren as? [AXUIElement] else { bindingFail("invalid_value", "AXChildren"); return }
                guard children.count <= 64 else { bindingFail("bound", "AXChildren"); return }
                let matches = children.filter { CFEqual($0, root) }.count
                modal["modalBindingMatches"] = matches
                guard matches == 1 else { bindingFail("invalid_candidate", "AXChildren"); return }
                guard let rawParentChildren = bindingRead(parent, "AXChildren") else { return }
                guard let parentChildren = rawParentChildren as? [AXUIElement] else { bindingFail("invalid_value", "AXChildren"); return }
                guard parentChildren.count <= 64 else { bindingFail("bound", "AXChildren"); return }
                let attached = parentChildren.filter { CFEqual($0, sheet) }.count == 1
                modal["modalBindingSheetAttached"] = attached
                guard attached else { bindingFail("invalid_candidate", "AXChildren"); return }
                let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
                modal["modalBindingForeground"] = foreground
                if !foreground { bindingFail("invalid_candidate", "foreground") }
            }
            bind()
            if cancelConfirmation {
                modal["cancelStatus"] = "refused"; modal["cancelGuardMask"] = 0
                modal["cancelPressed"] = false; modal["cancelDismissed"] = false
                modal["cancelSheetRetained"] = false; modal["cancelTargetUnchanged"] = false; modal["cancelError"] = 0; modal["cancelChainVisited"] = 0
                let broadComplete = (result["status"] as? String) == "complete"
                let knownSplitterRefusal = (result["status"] as? String) == "error" &&
                    (result["error"] as? Int) == -25201 && (result["attribute"] as? String) == "pid" &&
                    (result["pidState"] as? String) == "foreign" && (result["parentRole"] as? String) == "split_group" &&
                    (result["sheetBranch"] as? Bool) == true && (result["foreignRole"] as? String) == "splitter" &&
                    (result["foreignRoleError"] as? Int) == 0 && (result["foreignChildrenStatus"] as? String) == "absent" &&
                    (result["foreignChildrenError"] as? Int) == -25212
                func cancel() {
                    guard broadComplete || knownSplitterRefusal,
                          (modal["modalBindingStatus"] as? String) == "complete",
                          (modal["modalBindingParent"] as? String) == "sheet",
                          (modal["modalButtons"] as? Int) == 2,
                          (modal["modalCancel"] as? Int) == 1, (modal["modalReplace"] as? Int) == 1,
                          (modal["modalEnabledCancel"] as? Int) == 1, (modal["modalEnabledReplace"] as? Int) == 1,
                          cancelButtons.count == 1 else { return }
                    var mask = 1
                    modal["cancelGuardMask"] = mask
                    let button = cancelButtons[0]
                    guard bindingPid(root), bindingPid(button), bindingPid(sheet), bindingPid(parent),
                          (bindingRead(root, "AXRole") as? String) == "AXSheet" else { return }
                    mask |= 2; modal["cancelGuardMask"] = mask
                    guard let rawParent = bindingRead(root, "AXParent"), CFGetTypeID(rawParent) == AXUIElementGetTypeID(),
                          CFEqual(unsafeBitCast(rawParent, to: AXUIElement.self), sheet) else { return }
                    mask |= 4; modal["cancelGuardMask"] = mask
                    guard let children = bindingRead(sheet, "AXChildren") as? [AXUIElement], children.count <= 64,
                          children.filter({ CFEqual($0, root) }).count == 1,
                          let parentChildren = bindingRead(parent, "AXChildren") as? [AXUIElement], parentChildren.count <= 64,
                          parentChildren.filter({ CFEqual($0, sheet) }).count == 1 else { return }
                    mask |= 8; modal["cancelGuardMask"] = mask
                    guard (bindingRead(button, "AXRole") as? String) == "AXButton",
                          (bindingRead(button, "AXTitle") as? String) == "Cancel",
                          (bindingRead(button, "AXEnabled") as? Bool) == true else { return }
                    mask |= 16; modal["cancelGuardMask"] = mask
                    var node = button, seen: [AXUIElement] = []
                    var attached = false
                    for _ in 0..<16 {
                        guard !seen.contains(where: { CFEqual($0, node) }), bindingPid(node) else { return }
                        seen.append(node); modal["cancelChainVisited"] = seen.count
                        if CFEqual(node, root) { attached = true; break }
                        guard let raw = bindingRead(node, "AXParent"), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return }
                        node = unsafeBitCast(raw, to: AXUIElement.self)
                    }
                    guard attached else { return }
                    mask |= 32; modal["cancelGuardMask"] = mask
                    guard ProcessInfo.processInfo.systemUptime < deadline,
                          AXUIElementSetMessagingTimeout(button, 0.15) == .success else { return }
                    var actions: CFArray?
                    guard AXUIElementCopyActionNames(button, &actions) == .success,
                          let names = actions as? [String], names.count <= 16, names.contains("AXPress"),
                          isExistingReplacementFixture(URL(fileURLWithPath: arguments[2]).appendingPathComponent("Open Chords.json").path) else { return }
                    mask |= 64; modal["cancelGuardMask"] = mask
                    guard (modal["modalBindingStatus"] as? String) == "complete",
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                          ProcessInfo.processInfo.systemUptime < deadline else { return }
                    mask |= 128; modal["cancelGuardMask"] = mask
                    let timeout = AXUIElementSetMessagingTimeout(button, 1)
                    let status = timeout == .success ? AXUIElementPerformAction(button, "AXPress" as CFString) : timeout
                    modal["cancelError"] = Int(status.rawValue)
                    guard status == .success else { modal["cancelStatus"] = "press_error"; return }
                    modal["cancelPressed"] = true; modal["cancelStatus"] = "not_dismissed"
                    let dismissDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
                    while ProcessInfo.processInfo.systemUptime < dismissDeadline {
                        guard let current = bindingRead(sheet, "AXChildren") as? [AXUIElement], current.count <= 64 else { return }
                        if !current.contains(where: { CFEqual($0, root) }) {
                            guard bindingPid(sheet), bindingPid(parent),
                                  (bindingRead(sheet, "AXRole") as? String) == "AXSheet",
                                  let fresh = bindingRead(parent, "AXChildren") as? [AXUIElement], fresh.count <= 64,
                                  fresh.filter({ CFEqual($0, sheet) }).count == 1,
                                  NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                                  ProcessInfo.processInfo.systemUptime < deadline else { return }
                            let unchanged = isExistingReplacementFixture(URL(fileURLWithPath: arguments[2]).appendingPathComponent("Open Chords.json").path)
                            modal["cancelTargetUnchanged"] = unchanged
                            guard unchanged else { modal["cancelStatus"] = "target_changed"; return }
                            modal["cancelDismissed"] = true; modal["cancelSheetRetained"] = true
                            modal["cancelStatus"] = "complete"; return
                        }
                        Thread.sleep(forTimeInterval: min(0.02, max(0, dismissDeadline - ProcessInfo.processInfo.systemUptime)))
                    }
                }
                cancel()
            }
            if replaceConfirmation {
                modal["replaceStatus"] = "refused"; modal["replaceGuardMask"] = 0
                modal["replacePressed"] = false; modal["replaceDismissed"] = false
                modal["replaceSaveDismissed"] = false; modal["replaceTargetFixtureVerified"] = false; modal["replaceError"] = 0; modal["replaceChainVisited"] = 0
                let broadComplete = (result["status"] as? String) == "complete"
                let knownSplitterRefusal = (result["status"] as? String) == "error" &&
                    (result["error"] as? Int) == -25201 && (result["attribute"] as? String) == "pid" &&
                    (result["pidState"] as? String) == "foreign" && (result["parentRole"] as? String) == "split_group" &&
                    (result["sheetBranch"] as? Bool) == true && (result["foreignRole"] as? String) == "splitter" &&
                    (result["foreignRoleError"] as? Int) == 0 && (result["foreignChildrenStatus"] as? String) == "absent" &&
                    (result["foreignChildrenError"] as? Int) == -25212
                func replace() {
                    guard broadComplete || knownSplitterRefusal,
                          (result["windows"] as? Int) == 1,
                          (modal["modalBindingStatus"] as? String) == "complete",
                          (modal["modalBindingParent"] as? String) == "sheet",
                          (modal["modalButtons"] as? Int) == 2,
                          (modal["modalCancel"] as? Int) == 1, (modal["modalReplace"] as? Int) == 1,
                          (modal["modalEnabledCancel"] as? Int) == 1, (modal["modalEnabledReplace"] as? Int) == 1,
                          replaceButtons.count == 1 else { return }
                    var mask = 1
                    modal["replaceGuardMask"] = mask
                    let button = replaceButtons[0]
                    guard bindingPid(root), bindingPid(button), bindingPid(sheet), bindingPid(parent),
                          (bindingRead(root, "AXRole") as? String) == "AXSheet" else { return }
                    mask |= 2; modal["replaceGuardMask"] = mask
                    guard let rawParent = bindingRead(root, "AXParent"), CFGetTypeID(rawParent) == AXUIElementGetTypeID(),
                          CFEqual(unsafeBitCast(rawParent, to: AXUIElement.self), sheet) else { return }
                    mask |= 4; modal["replaceGuardMask"] = mask
                    guard let children = bindingRead(sheet, "AXChildren") as? [AXUIElement], children.count <= 64,
                          children.filter({ CFEqual($0, root) }).count == 1,
                          let parentChildren = bindingRead(parent, "AXChildren") as? [AXUIElement], parentChildren.count <= 64,
                          parentChildren.filter({ CFEqual($0, sheet) }).count == 1 else { return }
                    mask |= 8; modal["replaceGuardMask"] = mask
                    guard (bindingRead(button, "AXRole") as? String) == "AXButton",
                          (bindingRead(button, "AXTitle") as? String) == "Replace",
                          (bindingRead(button, "AXEnabled") as? Bool) == true else { return }
                    mask |= 16; modal["replaceGuardMask"] = mask
                    var node = button, seen: [AXUIElement] = []
                    var attached = false
                    for _ in 0..<16 {
                        guard !seen.contains(where: { CFEqual($0, node) }), bindingPid(node) else { return }
                        seen.append(node); modal["replaceChainVisited"] = seen.count
                        if CFEqual(node, root) { attached = true; break }
                        guard let raw = bindingRead(node, "AXParent"), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return }
                        node = unsafeBitCast(raw, to: AXUIElement.self)
                    }
                    guard attached else { return }
                    mask |= 32; modal["replaceGuardMask"] = mask
                    guard let targetName = expectedSaveName,
                          ProcessInfo.processInfo.systemUptime < deadline,
                          AXUIElementSetMessagingTimeout(button, 0.15) == .success else { return }
                    var actions: CFArray?
                    guard AXUIElementCopyActionNames(button, &actions) == .success,
                          let names = actions as? [String], names.count <= 16, names.contains("AXPress"),
                          isExistingReplacementFixture(URL(fileURLWithPath: arguments[2]).appendingPathComponent(targetName).path) else { return }
                    modal["replaceTargetFixtureVerified"] = true
                    mask |= 64; modal["replaceGuardMask"] = mask
                    guard (modal["modalBindingStatus"] as? String) == "complete",
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                          ProcessInfo.processInfo.systemUptime < deadline else { return }
                    mask |= 128; modal["replaceGuardMask"] = mask
                    let timeout = AXUIElementSetMessagingTimeout(button, 1)
                    let status = timeout == .success ? AXUIElementPerformAction(button, "AXPress" as CFString) : timeout
                    modal["replaceError"] = Int(status.rawValue)
                    guard status == .success else { modal["replaceStatus"] = "press_error"; return }
                    modal["replacePressed"] = true; modal["replaceStatus"] = "not_dismissed"
                    let dismissDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
                    var modalGone = false
                    while ProcessInfo.processInfo.systemUptime < dismissDeadline {
                        guard ProcessInfo.processInfo.systemUptime < deadline else { return }
                        if !modalGone {
                            let timeout = AXUIElementSetMessagingTimeout(root, 0.5)
                            var role: CFTypeRef?
                            let roleStatus = timeout == .success ? AXUIElementCopyAttributeValue(root, "AXRole" as CFString, &role) : timeout
                            guard roleStatus == .success || roleStatus == .invalidUIElement else {
                                modal["replaceError"] = Int(roleStatus.rawValue); return
                            }
                            // This is positive dismissal evidence for the captured modal, not a read retry.
                            modalGone = roleStatus == .invalidUIElement
                        }
                        guard let current = bindingRead(parent, "AXChildren") as? [AXUIElement], current.count <= 64 else { return }
                        if modalGone && !current.contains(where: { CFEqual($0, sheet) }) {
                            guard bindingPid(parent), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                                  ProcessInfo.processInfo.systemUptime < deadline else { return }
                            modal["replaceDismissed"] = true; modal["replaceSaveDismissed"] = true
                            modal["replaceStatus"] = "complete"; return
                        }
                        Thread.sleep(forTimeInterval: min(0.02, max(0, dismissDeadline - ProcessInfo.processInfo.systemUptime)))
                    }
                }
                replace()
            }
        }
        return modal
    }
    func refuse(_ status: String, _ error: AXError = .success) {
        if (result["status"] as? String) == "complete" {
            result["status"] = status; result["error"] = Int(error.rawValue)
            result["attribute"] = currentAttribute; result["role"] = currentRole
            result["parentRole"] = currentParentRole; result["pidState"] = currentPidState; result["sheetBranch"] = currentSheetBranch
        }
    }
    func attribute(_ element: AXUIElement, _ name: String, optional: Bool = false) -> CFTypeRef? {
        currentAttribute = name
        guard ProcessInfo.processInfo.systemUptime < deadline else { refuse("deadline"); return nil }
        let timeout = AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
        guard timeout == .success else { refuse("error", timeout); return nil }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if optional && (status == .noValue || status == .attributeUnsupported) { return nil }
        guard status == .success else { refuse("error", status); return nil }
        return value
    }
    guard let windows = attribute(app, "AXWindows") as? [AXUIElement] else {
        if (result["status"] as? String) == "complete" { refuse("invalid_value") }; return result
    }
    result["windows"] = min(17, windows.count)
    guard !windows.isEmpty, windows.count <= 16 else { refuse(windows.isEmpty ? "invalid_value" : "bound"); return result }
    var modalCandidates: [AXUIElement] = []
    var queue = windows.map { ($0, "none", false) }
    var seen: [AXUIElement] = []
    while !queue.isEmpty && (result["status"] as? String) == "complete" {
        if seen.count >= 256 { refuse("bound"); break }
        let (element, parentRole, inheritedSheetBranch) = queue.removeFirst()
        currentSheetBranch = inheritedSheetBranch || CFEqual(element, sheet)
        currentRole = "unknown"; currentParentRole = parentRole; currentPidState = "not_checked"
        if seen.contains(where: { CFEqual($0, element) }) { continue }
        seen.append(element); result["visited"] = seen.count
        var actualPid: pid_t = 0
        currentAttribute = "pid"
        let pidStatus = AXUIElementGetPid(element, &actualPid)
        currentPidState = pidStatus != .success ? "unknown" : actualPid == pid ? "same" : "foreign"
        guard pidStatus == .success, actualPid == pid else {
            refuse("error", pidStatus == .success ? .illegalArgument : pidStatus)
            // Diagnostic read only: the foreign-PID refusal remains first and fatal. Never skip or act on this node.
            if pidStatus == .success && actualPid != pid && ProcessInfo.processInfo.systemUptime < deadline {
                let timeout = AXUIElementSetMessagingTimeout(element, 0.5)
                var foreignRole: CFTypeRef?
                let status = timeout == .success ? AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &foreignRole) : timeout
                result["foreignRoleError"] = Int(status.rawValue)
                if status == .success, let role = foreignRole as? String { result["foreignRole"] = roleCategory(role) }
                else { result["foreignRole"] = "unavailable" }
                if (result["foreignRole"] as? String) == "splitter" && ProcessInfo.processInfo.systemUptime < deadline {
                    let timeout = AXUIElementSetMessagingTimeout(element, 0.15)
                    var children: CFTypeRef?
                    let status = timeout == .success ? AXUIElementCopyAttributeValue(element, "AXChildren" as CFString, &children) : timeout
                    result["foreignChildrenError"] = Int(status.rawValue)
                    result["foreignChildren"] = 0
                    if status == .success, let values = children as? [AXUIElement] {
                        result["foreignChildren"] = min(257, values.count)
                        result["foreignChildrenStatus"] = values.count <= 256 ? "complete" : "bound"
                    } else if status == .noValue { result["foreignChildrenStatus"] = "absent" }
                    else if status == .attributeUnsupported { result["foreignChildrenStatus"] = "unsupported" }
                    else { result["foreignChildrenStatus"] = status == .success ? "invalid_value" : "error" }
                }
            }
            break
        }
        guard let role = attribute(element, "AXRole") as? String else {
            if (result["status"] as? String) == "complete" { refuse("invalid_value") }; break
        }
        currentRole = roleCategory(role)
        if role == "AXSheet" && currentSheetBranch && !CFEqual(element, sheet) { modalCandidates.append(element) }
        let key = role == "AXSheet" ? "sheets" : role == "AXDialog" ? "dialogs" : role == "AXButton" ? "buttons" : "other"
        result[key] = (result[key] as? Int ?? 0) + 1
        if role == "AXButton" {
            let title = attribute(element, "AXTitle", optional: true) as? String
            if let title = title, ["Cancel", "Replace", "Save"].contains(title) {
                let key = title.lowercased(); result[key] = (result[key] as? Int ?? 0) + 1
            }
        }
        if role == "AXWebArea" { continue }
        let raw = attribute(element, "AXChildren", optional: true)
        if let raw = raw {
            guard let children = raw as? [AXUIElement] else { refuse("invalid_value"); break }
            if queue.count + children.count + seen.count > 256 { refuse("bound"); break }
            queue.append(contentsOf: children.map { ($0, currentRole, currentSheetBranch) })
        }
    }
    result["modalCandidates"] = min(257, modalCandidates.count)
    if modalCandidates.count == 1 {
        for (key, value) in modalObservation(modalCandidates[0]) { result[key] = value }
    } else { result["modalStatus"] = modalCandidates.isEmpty ? "not_checked" : "ambiguous" }
    // Read-only attachment polling starts only after the preserved, positively identified splitter refusal.
    if modalCandidates.isEmpty && (result["pidState"] as? String) == "foreign" &&
       (result["foreignRole"] as? String) == "splitter" && (result["sheetBranch"] as? Bool) == true {
        result["attachmentStatus"] = "absent"; result["attachmentAttempts"] = 0; result["attachmentVisited"] = 0
        result["attachmentCandidates"] = 0; result["attachmentError"] = 0; result["attachmentAttribute"] = "none"
        result["attachmentSource"] = "none"; result["capturedSheetAttached"] = false
        let attachmentDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 1)
        var attachmentSource = "none"
        func attachmentFail(_ status: String, _ attribute: String, _ error: AXError = .success) {
            if (result["attachmentStatus"] as? String) == "absent" {
                result["attachmentStatus"] = status; result["attachmentAttribute"] = attribute
                result["attachmentSource"] = attachmentSource; result["attachmentError"] = Int(error.rawValue)
            }
        }
        func attachmentRead(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            guard ProcessInfo.processInfo.systemUptime < deadline else { attachmentFail("deadline", name); return nil }
            let timeout = AXUIElementSetMessagingTimeout(element, name == "AXRole" ? 0.5 : 0.15)
            var output: CFTypeRef?
            let status = timeout == .success ? AXUIElementCopyAttributeValue(element, name as CFString, &output) : timeout
            guard status == .success, let output = output else { attachmentFail("error", name, status); return nil }
            if ProcessInfo.processInfo.systemUptime >= deadline { attachmentFail("deadline", name); return nil }
            return output
        }
        func attachmentPid(_ element: AXUIElement) -> Bool {
            guard ProcessInfo.processInfo.systemUptime < deadline else { attachmentFail("deadline", "pid"); return false }
            var actualPid: pid_t = 0
            let status = AXUIElementGetPid(element, &actualPid)
            guard status == .success, actualPid == pid else { attachmentFail("invalid_candidate", "pid", status); return false }
            return true
        }
        for attempt in 1...32 {
            if ProcessInfo.processInfo.systemUptime >= attachmentDeadline || (result["attachmentStatus"] as? String) != "absent" { break }
            result["attachmentAttempts"] = attempt
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { attachmentFail("invalid_candidate", "foreground"); break }
            var candidates: [AXUIElement] = []
            for (root, source) in [(parent, "parent"), (sheet, "sheet")] {
                attachmentSource = source
                guard attachmentPid(root) else { break }
                guard let children = attachmentRead(root, "AXChildren") as? [AXUIElement], children.count <= 64 else {
                    attachmentFail("bound", "AXChildren"); break
                }
                if source == "parent" {
                    let attached = children.contains(where: { CFEqual($0, sheet) })
                    result["capturedSheetAttached"] = attached
                    if !attached { attachmentFail("invalid_candidate", "AXChildren"); break }
                }
                for child in children {
                    let visited = (result["attachmentVisited"] as? Int ?? 0)
                    if visited >= 256 { attachmentFail("bound", "AXChildren"); break }
                    result["attachmentVisited"] = visited + 1
                    guard attachmentPid(child) else { break }
                    guard let role = attachmentRead(child, "AXRole") as? String else { attachmentFail("invalid_value", "AXRole"); break }
                    if role == "AXSheet" && !CFEqual(child, sheet) && !candidates.contains(where: { CFEqual($0, child) }) { candidates.append(child) }
                }
                if (result["attachmentStatus"] as? String) != "absent" { break }
            }
            result["attachmentCandidates"] = candidates.count
            if (result["attachmentStatus"] as? String) != "absent" { break }
            if candidates.count == 1 {
                result["attachmentStatus"] = "complete"
                for (key, value) in modalObservation(candidates[0]) { result[key] = value }
                break
            }
            if candidates.count > 1 { attachmentFail("ambiguous", "AXChildren"); break }
            Thread.sleep(forTimeInterval: min(0.02, max(0, attachmentDeadline - ProcessInfo.processInfo.systemUptime)))
        }
    }
    currentAttribute = "AXActions"; currentRole = "button"; currentParentRole = "none"; currentPidState = "not_checked"; currentSheetBranch = true
    result["saveActionStatus"] = replaceConfirmation ? "not_checked" : "deadline"; result["savePressAction"] = "unknown"; result["saveActionError"] = 0
    if !replaceConfirmation && ProcessInfo.processInfo.systemUptime < deadline {
        let timeout = AXUIElementSetMessagingTimeout(save, 0.15)
        var actions: CFArray?
        let status = timeout == .success ? AXUIElementCopyActionNames(save, &actions) : timeout
        result["saveActionError"] = Int(status.rawValue)
        if status == .success, let names = actions as? [String], names.count <= 16 {
            result["saveActionStatus"] = "success"
            result["savePressAction"] = names.contains("AXPress") ? "present" : "absent"
        } else { result["saveActionStatus"] = status == .success ? "invalid_value" : "error" }
    }
    result["foreground"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    if ProcessInfo.processInfo.systemUptime >= deadline { refuse("deadline") }
    return result
}

if (arguments.count == 3 || arguments.count == 4 || (arguments.count == 5 && expectedSaveName != nil) || (verifiesFilename && expectedSaveName != nil)), ["none", "open", "cancel_open_existing", "directory_snapshot"].contains(requested),
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
    var saveButtons: [AXUIElement] = []
    var directoryFields: [(URL, AXUIElement)] = []
    var saveTextFields: [AXUIElement] = []
    var queue: [(AXUIElement, String, String, Bool, Int, Int, AXUIElement?)] = sheets.count == 1 ? sheets.map { ($0, "sheet", "none", false, 0, 0, nil) } : []
    seen = []
    stage = "selection"
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let (element, origin, parentRole, selectedBranch, traversalMask, traversalDepth, directParent) = queue.removeFirst()
        readOrigin = origin
        readParentRole = parentRole
        readSelectedReference = selected.contains(where: { same($0, element) })
        readSelectedBranch = selectedBranch
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        counts["visited"] = seen.count
        staleChildContext = ["open", "cancel_open_existing"].contains(requested) && origin == "AXChildren" &&
            parentRole == "AXScrollArea" && !readSelectedReference && !selectedBranch
        currentDirectParent = directParent.map { parent in (parent, pid, selected.contains(where: { same($0, parent) })) }
        invalidRoleElement = nil
        let roleRead = readResult(element, "AXRole")
        let role = roleRead.value as? String ?? ""
        if expectedSaveName != nil && role == "AXTextField" { saveTextFields.append(element) }
        if staleChildContext && roleRead.status == .invalidUIElement {
            invalidRoleElement = element
            vanishedChildCandidates += 1
            if let parent = directParent {
                let observation = invalidChildParentObservation(parent, child: element, pid: pid,
                    selectedReference: selected.contains(where: { same($0, parent) }))
                if (invalidChildParent["status"] as? String) == "not_checked" { invalidChildParent = observation }
                allInvalidChildrenVanished = allInvalidChildrenVanished && vanishedChildParent(observation)
            } else { allInvalidChildrenVanished = false }
        }
        let selectedFlag = read(element, "AXSelected") as? Bool
        if selectedFlag == true && !selected.contains(where: { same($0, element) }) { selected.append(element) }
        readSelectedReference = readSelectedReference || selectedFlag == true
        var titleCategory = "unavailable", valueCategory = "unavailable"
        if requested == "none" {
            let title = string(element, "AXTitle")
            let value = read(element, "AXValue")
            let filename = read(element, "AXFilename")
            let document = read(element, "AXDocument")
            titleCategory = fieldTextCategory(title.map { $0 as CFString }, target: target, path: arguments[2])
            valueCategory = fieldTextCategory(value, target: target, path: arguments[2])
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
        if requested == "directory_snapshot", role == "AXButton" {
            let title = string(element, "AXTitle")
            if title == "Save" { saveButtons.append(element) }
            if title == "Cancel" { buttons.append(element) }
        } else if role == "AXButton" && string(element, "AXTitle") == (requested == "open" ? "Open" : "Cancel") { buttons.append(element) }
        if let value = read(element, "AXURL"), let url = nativeURL(value) {
            if ["none", "directory_snapshot"].contains(requested), role == "AXTextField", origin == "AXChildren", parentRole == "AXGroup", let parent = directParent {
                directoryFields.append((url, parent))
            }
            if CFGetTypeID(value) == CFURLGetTypeID() { counts["urlObjects", default: 0] += 1 }
            else { counts["urlStrings", default: 0] += 1 }
            if url.absoluteString == expected {
                counts["exactUrls", default: 0] += 1
                if ["none", "directory_snapshot"].contains(requested) && (firstExactURL["origin"] as? String) == "none" {
                    firstExactElement = element
                    firstExactURL = ["role": diagnosticRole(role), "parentRole": parentRole, "origin": origin,
                        "selected": selectedFlag == true ? "true" : selectedFlag == false ? "false" : "unknown",
                        "directory": url.hasDirectoryPath, "kind": CFGetTypeID(value) == CFURLGetTypeID() ? "native" : "string",
                        "titleCategory": titleCategory, "valueCategory": valueCategory,
                        "traversalRoleMask": traversalMask, "traversalDepth": traversalDepth]
                }
            }
        }
        let childMask = traversalMask | traversalRoleBit(role)
        var next: [(AXUIElement, String, String, Bool, Int, Int, AXUIElement?)] = []
        for name in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells", "AXSelectedColumns"] {
            for child in elements(element, name) {
                if !selected.contains(where: { same($0, child) }) { selected.append(child) }
                next.append((child, name, diagnosticRole(role), true, childMask, traversalDepth + 1, nil))
            }
        }
        if ["AXList", "AXOutline", "AXTable", "AXColumn"].contains(role) { next.append(contentsOf: elements(element, "AXColumns").map { ($0, "AXColumns", diagnosticRole(role), selectedBranch || readSelectedReference, childMask, traversalDepth + 1, nil) }) }
        else { next.append(contentsOf: elements(element, "AXChildren").map { ($0, "AXChildren", diagnosticRole(role), selectedBranch || readSelectedReference, childMask, traversalDepth + 1, element) }) }
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next)
    }
    staleChildContext = false
    currentDirectParent = nil
    invalidRoleElement = nil
    if ["none", "directory_snapshot"].contains(requested) {
        let selectedFields = directoryFields.filter { item in selected.contains(where: { same($0, item.1) }) }.map { $0.0 }
        selectedDirectory = selectedDirectoryObservation(selectedFields, expected: target)
    }
    // Read-only actual-parent observations, independent of traversal provenance.
    if ["none", "directory_snapshot"].contains(requested), let exactElement = firstExactElement, sheets.count == 1 {
        stage = "parent_chain"
        readOrigin = "exact_url_parent_chain"
        readParentRole = "none"
        readSelectedReference = false
        readSelectedBranch = false
        var current = exactElement
        var chainSeen: [AXUIElement] = [exactElement]
        var chainVisited = 0, chainSelected = 0, chainUnknown = 0, chainMask = 0
        var chainNodes: [[String: Any]] = []
        var chainStatus = "bound"
        for _ in 0..<16 {
            if ProcessInfo.processInfo.systemUptime >= deadline { chainStatus = "deadline"; break }
            let parentRead = readResult(current, "AXParent")
            guard let value = parentRead.value else { chainStatus = absentParentStatus(parentRead.status); break }
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else { chainStatus = "invalid_parent"; break }
            let parent = unsafeBitCast(value, to: AXUIElement.self)
            readSelectedReference = selected.contains(where: { same($0, parent) })
            if chainSeen.contains(where: { same($0, parent) }) { chainStatus = "cycle"; break }
            chainSeen.append(parent)
            chainVisited += 1
            let selectedReference = readSelectedReference
            guard let role = string(parent, "AXRole") else {
                chainNodes.append(["role": "other", "selectedReference": selectedReference, "selectedState": "not_read"])
                chainStatus = "unreadable_role"; break
            }
            chainMask |= traversalRoleBit(role)
            var selectedState = "unknown"
            if let selected = read(parent, "AXSelected") as? Bool {
                selectedState = selected ? "true" : "false"
                if selected { chainSelected += 1; readSelectedReference = true }
            } else { chainUnknown += 1 }
            chainNodes.append(["role": diagnosticRole(role), "selectedReference": selectedReference, "selectedState": selectedState])
            if same(parent, sheets[0]) { chainStatus = "captured_sheet"; break }
            current = parent
            readParentRole = "none"
        }
        parentChain = ["status": chainStatus, "visited": chainVisited, "selected": chainSelected,
            "unknownSelected": chainUnknown, "roleMask": chainMask, "nodes": chainNodes]
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
    snapshotTraversalComplete = complete
    if !noReadFailures() { complete = false }
    snapshotRefreshEligible = ["open", "cancel_open_existing"].contains(requested) && trusted && selection.verified && snapshotTraversalComplete &&
        onlyInvalidChildErrors && vanishedChildCandidates > 0 && allInvalidChildrenVanished &&
        counts["otherErrors", default: 0] > 0 && counts["cannotComplete", default: 0] == 0 && counts["apiDisabled", default: 0] == 0 &&
        counts["windows"] == 1 && sheets.count == 1 && parents.count == 1 && buttons.count == 1 && ProcessInfo.processInfo.systemUptime < deadline
    verified = trusted && complete && selection.verified
    // Independent read-only verification: no AXValue/title inventory on browser content, no action.
    if requested == "directory_snapshot" {
        verified = false
        counts["saveButtons"] = saveButtons.count
        let selectedFields = directoryFields.filter { item in selected.contains(where: { same($0, item.1) }) }
        let covered = !selected.isEmpty && selected.allSatisfy { root in selectedFields.filter { same($0.1, root) }.count == 1 }
        let firstParent = (parentChain["nodes"] as? [[String: Any]])?.first
        let directoryShape = (selectedDirectory["validShape"] as? Bool) == true &&
            (selectedDirectory["uniqueUrls"] as? Int) == selected.count &&
            (selectedDirectory["terminalUrls"] as? Int) == 1 && (selectedDirectory["terminalMatches"] as? Int) == 1
        let exactField = (firstExactURL["role"] as? String) == "AXTextField" &&
            (firstExactURL["origin"] as? String) == "AXChildren" && (firstExactURL["parentRole"] as? String) == "AXGroup" &&
            (firstExactURL["kind"] as? String) == "native" && (firstExactURL["directory"] as? Bool) == true
        let capturedSelection = (parentChain["status"] as? String) == "captured_sheet" &&
            (firstParent?["role"] as? String) == "AXGroup" && (firstParent?["selectedReference"] as? Bool) == true
        let candidate = trusted && complete && noReadFailures() && covered && directoryShape && exactField && capturedSelection &&
            counts["windows"] == 1 && counts["exactUrls"] == 1 && counts["urlStrings"] == 0 && counts["urlObjects"] == selectedFields.count
        if candidate && buttons.count == 1 && saveButtons.count == 1 && sheets.count == 1 && parents.count == 1 && ProcessInfo.processInfo.systemUptime < deadline {
            stage = "guard"
            readOrigin = "guard"
            readSelectedReference = false
            readSelectedBranch = false
            readParentRole = "none"
            let sheet = sheets[0], parent = parents[0], cancel = buttons[0], save = saveButtons[0]
            var actualPid: pid_t = 0
            foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
            if AXUIElementGetPid(app, &actualPid) == .success && actualPid == pid { guardMask |= 1 }
            if foreground { guardMask |= 2 }
            if elements(parent, "AXChildren").contains(where: { same($0, sheet) }) { guardMask |= 4 }
            if string(sheet, "AXRole") == "AXSheet" { guardMask |= 8 }
            if string(cancel, "AXRole") == "AXButton" && string(cancel, "AXTitle") == "Cancel" &&
                string(save, "AXRole") == "AXButton" && string(save, "AXTitle") == "Save" { guardMask |= 16 }
            if (read(cancel, "AXEnabled") as? Bool) == true && (read(save, "AXEnabled") as? Bool) == true { guardMask |= 32 }
            if noReadFailures() { guardMask |= 64 }
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { guardMask |= 128 }
            directoryVerified = guardMask == 255 && ProcessInfo.processInfo.systemUptime < deadline
            if directoryVerified {
                stage = "directory_complete"
                if let name = expectedSaveName {
                    if verifiesFilename { saveFilename = verifySaveFilename(saveTextFields, expected: name, pid: pid, sheet: sheet) }
                    else { saveTargetContext = observeSaveTarget(saveTextFields, expected: name, pid: pid) }
                }
            }
        }
    }
    let saveReady = (savesNewExport || observesReplacement) && directoryVerified && (saveFilename["verified"] as? Bool) == true && saveButtons.count == 1
    if ((["open", "cancel_open_existing"].contains(requested) && verified) || saveReady) && buttons.count == 1 && sheets.count == 1 && parents.count == 1 {
        guardMask = 0
        stage = "guard"
        readOrigin = "guard"
        readSelectedReference = false
        readSelectedBranch = false
        readParentRole = "none"
        let sheet = sheets[0]
        let parent = parents[0]
        let button = saveReady ? saveButtons[0] : buttons[0]
        var actualPid: pid_t = 0
        foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        if AXUIElementGetPid(app, &actualPid) == .success && actualPid == pid { guardMask |= 1 }
        if foreground { guardMask |= 2 }
        if elements(parent, "AXChildren").contains(where: { same($0, sheet) }) { guardMask |= 4 }
        if string(sheet, "AXRole") == "AXSheet" { guardMask |= 8 }
        if string(button, "AXRole") == "AXButton" && string(button, "AXTitle") == (saveReady ? "Save" : (requested == "open" ? "Open" : "Cancel")) { guardMask |= 16 }
        let enabled = read(button, "AXEnabled") as? Bool
        guardEnabledState = enabled.map { $0 ? "true" : "false" } ?? "unavailable"
        if enabled == true { guardMask |= 32 }
        if noReadFailures() { guardMask |= 64 }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { guardMask |= 128 }
        if saveReady, let saveName = expectedSaveName {
            var existing = stat()
            let destination = target.appendingPathComponent(saveName).path
            saveTargetAbsent = lstat(destination, &existing) != 0 && errno == ENOENT
            if observesReplacement { saveTargetExistingFixture = isExistingReplacementFixture(destination) }
        }
        if guardMask == 255 && (!saveReady || ((observesReplacement ? saveTargetExistingFixture : saveTargetAbsent) && ProcessInfo.processInfo.systemUptime < deadline)) {
            stage = "press"
            let pressStarted = ProcessInfo.processInfo.systemUptime
            // Action callbacks can outlast the 150 ms attribute-read timeout.
            // Keep the single action bounded inside the unchanged seven-second host budget.
            let timeoutStatus = AXUIElementSetMessagingTimeout(button, 1)
            pressTimeoutError = Int(timeoutStatus.rawValue)
            pressActionCalled = timeoutStatus == .success
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
            if observesReplacement {
                // Capture the actual context even when AXPress refuses; retain the original action result.
                replaceContext = observeReplacementContext(app, pid: pid, save: button, sheet: sheet, parent: parent, cancelConfirmation: cancelsReplaceJson && pressActionCalled && (status == .success || status == .attributeUnsupported), replaceConfirmation: replacesExport && pressActionCalled && (status == .success || status == .attributeUnsupported))
                if pressed { stage = "replace_observed" }
            }
            if pressed && !observesReplacement {
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
if !noReadFailures() { complete = false; directoryVerified = false }
for key in Array(counts.keys) where key != "lastError" { counts[key] = min(counts[key] ?? 0, 999) }
let lastError = counts.removeValue(forKey: "lastError") ?? 0
var result: [String: Any] = [
    "staleSnapshot": ["eligible": snapshotRefreshEligible, "traversalComplete": snapshotTraversalComplete, "candidates": vanishedChildCandidates,
        "allVanished": vanishedChildCandidates > 0 && allInvalidChildrenVanished,
        "onlyInvalidChildErrors": counts["otherErrors", default: 0] > 0 && onlyInvalidChildErrors],
    "counts": counts, "invalidChildParent": invalidChildParent, "firstFailureParent": firstFailureParent, "selectedDirectory": selectedDirectory, "firstExactURL": firstExactURL, "parentChain": parentChain, "lastError": lastError, "dismissalLastError": dismissalLastError,
    "pressDurationMs": pressDurationMs, "pressSheetState": pressSheetState,
    "pressFollowupError": pressFollowupError,
    "trusted": trusted, "complete": complete,
    "firstOtherSelectedReference": firstOtherSelectedReference, "firstOtherSelectedBranch": firstOtherSelectedBranch,
    "firstOtherError": firstOtherError, "firstOtherAttribute": firstOtherAttribute,
    "firstOtherStage": firstOtherStage, "firstOtherVisited": firstOtherVisited, "firstOtherOrigin": firstOtherOrigin, "firstOtherParentRole": firstOtherParentRole,
    "firstCannotCompleteAttribute": firstCannotCompleteAttribute,
    "firstCannotCompleteStage": firstCannotCompleteStage,
    "firstCannotCompleteDurationMs": firstCannotCompleteDurationMs,
    "saveTargetExistingFixture": saveTargetExistingFixture, "replaceContext": replaceContext, "saveTargetAbsent": saveTargetAbsent, "saveFilename": saveFilename, "saveTargetContext": saveTargetContext, "directoryVerified": directoryVerified, "verified": verified, "foreground": foreground, "stage": stage, "guardMask": guardMask, "guardEnabledState": guardEnabledState,
    "action": ["requested": replacesExport ? "replace_" + arguments[4] : cancelsReplaceJson ? "cancel_replace_json" : observesReplacement ? "observe_replace_json" : savesNewExport ? "save_new_" + arguments[4] : requested, "pressed": pressed, "dismissed": dismissed]
]
if observesReplacement { result["pressTimeoutError"] = pressTimeoutError; result["pressActionCalled"] = pressActionCalled }
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
   let output = String(data: data, encoding: .utf8) { print(output) }
