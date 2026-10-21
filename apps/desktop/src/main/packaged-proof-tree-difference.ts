// Fixed categories only: filenames and hashes never leave this diagnostic summary.
export function proofTreeDifference(before: Record<string, string>, after: Record<string, string>) {
  const counts = {
    added: 0,
    removed: 0,
    changed: 0,
    library: 0,
    location: 0,
    network: 0,
    export_pending: 0,
    chromium_preferences: 0,
    chromium_storage: 0,
    chromium_cache: 0,
    other: 0,
  };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldPresent = Object.hasOwn(before, key),
      newPresent = Object.hasOwn(after, key);
    if (oldPresent && newPresent && before[key] === after[key]) continue;
    counts[!oldPresent ? "added" : !newPresent ? "removed" : "changed"]++;
    const root = key.split("/")[0]!.toLowerCase();
    const category =
      root === "project-library"
        ? "library"
        : root === "project-library-location.json"
          ? "location"
          : root === "network-mode.json"
            ? "network"
            : root === "export-pending"
              ? "export_pending"
              : ["preferences", "local state"].includes(root)
                ? "chromium_preferences"
                : [
                      "network",
                      "session storage",
                      "local storage",
                      "shared_proto_db",
                      "blob_storage",
                      "quotamanager",
                      "quotamanager-journal",
                    ].includes(root)
                  ? "chromium_storage"
                  : [
                        "cache",
                        "code cache",
                        "gpucache",
                        "dawncache",
                        "dawngraphitecache",
                        "dawnwebgpucache",
                      ].includes(root)
                    ? "chromium_cache"
                    : "other";
    counts[category]++;
  }
  return `Export disk proof source delta: ${Object.entries(counts)
    .map(([key, value]) => `${key}=${Math.min(9999, value)}`)
    .join(" ")}`;
}

// Electron owns these exact root files and may create them asynchronously after ready.
// Keep the complete Library, its configuration and every other profile entry in the invariant.
export function withoutChromiumPreferences(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).filter(([path]) => path !== "Preferences" && path !== "Local State"),
  );
}
