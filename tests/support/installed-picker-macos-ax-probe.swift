import ApplicationServices
import Foundation

// Read-only, CI-only comparison with the System Events accessibility bridge.
let arguments = CommandLine.arguments
var counts: [String: Int] = [
    "windows": 0, "sheets": 0, "visited": 0, "selectedRoots": 0,
    "selectedRows": 0, "selectedCells": 0, "selectedColumns": 0,
    "urlStrings": 0, "urlObjects": 0, "exactUrls": 0, "exactFilenames": 0,
    "basenameMatches": 0, "unsupported": 0, "cannotComplete": 0,
    "apiDisabled": 0, "otherErrors": 0, "lastError": 0
]
var complete = true
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
        default: counts["otherErrors", default: 0] += 1
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

func string(_ element: AXUIElement, _ name: String) -> String? {
    read(element, name) as? String
}

func same(_ left: AXUIElement, _ right: AXUIElement) -> Bool {
    CFEqual(left, right)
}

if arguments.count == 3, let pid = Int32(arguments[1]), pid > 0, arguments[2].hasPrefix("/") {
    let target = URL(fileURLWithPath: arguments[2])
    let expected = target.absoluteString
    let app = AXUIElementCreateApplication(pid)
    let windows = elements(app, "AXWindows")
    counts["windows"] = min(windows.count, 17)
    if windows.count > 16 { complete = false }
    var queue = windows.count <= 16 ? windows : []
    var seen: [AXUIElement] = []
    var sheets: [AXUIElement] = []
    // Locate native sheets without descending into the renderer accessibility tree.
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let element = queue.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        let role = string(element, "AXRole") ?? ""
        if role == "AXSheet" { sheets.append(element); continue }
        if role == "AXWebArea" { continue }
        let children = elements(element, "AXChildren")
        if queue.count + children.count > 256 { complete = false; break }
        queue.append(contentsOf: children)
    }
    counts["sheets"] = min(sheets.count, 17)
    if sheets.count != 1 { complete = false }
    var selected: [AXUIElement] = []
    queue = sheets.count == 1 ? sheets : []
    seen = []
    while !queue.isEmpty && complete {
        if seen.count >= 256 || ProcessInfo.processInfo.systemUptime >= deadline { complete = false; break }
        let element = queue.removeFirst()
        if seen.contains(where: { same($0, element) }) { continue }
        seen.append(element)
        counts["visited"] = seen.count
        let role = string(element, "AXRole") ?? ""
        if (read(element, "AXSelected") as? Bool) == true && !selected.contains(where: { same($0, element) }) {
            selected.append(element)
        }
        if string(element, "AXTitle") == target.lastPathComponent || string(element, "AXValue") == target.lastPathComponent {
            counts["basenameMatches", default: 0] += 1
        }
        if let value = read(element, "AXURL") {
            if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
                counts["urlObjects", default: 0] += 1
                if url.absoluteString == expected { counts["exactUrls", default: 0] += 1 }
            } else if let url = value as? String {
                counts["urlStrings", default: 0] += 1
                if url == expected { counts["exactUrls", default: 0] += 1 }
            }
        }
        if string(element, "AXFilename") == arguments[2] { counts["exactFilenames", default: 0] += 1 }
        var next: [AXUIElement] = []
        for name in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells", "AXSelectedColumns"] {
            for child in elements(element, name) {
                if !selected.contains(where: { same($0, child) }) { selected.append(child) }
                next.append(child)
            }
        }
        if ["AXList", "AXOutline", "AXTable", "AXColumn"].contains(role) {
            next.append(contentsOf: elements(element, "AXColumns"))
        } else {
            next.append(contentsOf: elements(element, "AXChildren"))
        }
        if queue.count + next.count > 256 { complete = false; break }
        queue.append(contentsOf: next)
    }
    counts["selectedRoots"] = selected.count
    for element in selected.prefix(256) {
        switch string(element, "AXRole") ?? "" {
        case "AXRow": counts["selectedRows", default: 0] += 1
        case "AXCell": counts["selectedCells", default: 0] += 1
        case "AXColumn": counts["selectedColumns", default: 0] += 1
        default: break
        }
    }
} else {
    complete = false
}
if counts["cannotComplete", default: 0] > 0 || counts["apiDisabled", default: 0] > 0 || counts["otherErrors", default: 0] > 0 {
    complete = false
}
for key in Array(counts.keys) where key != "lastError" { counts[key] = min(counts[key] ?? 0, 999) }
let lastError = counts.removeValue(forKey: "lastError") ?? 0
let result: [String: Any] = ["counts": counts, "lastError": lastError, "trusted": trusted, "complete": complete]
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
   let output = String(data: data, encoding: .utf8) {
    print(output)
}
