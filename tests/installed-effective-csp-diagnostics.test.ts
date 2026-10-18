import { expect, it } from "vitest";

import { installedEffectiveCspDiagnostic } from "./support/installed-effective-csp-diagnostics.ts";

const observation = {
  evalBlocked: false,
  inlineScriptBlocked: false,
  documentUrl: "app_index",
  readyState: "complete",
  preloadPresent: true,
  metaCount: 1,
  metaMatches: true,
};

it("retains fixed effective policy and document observations", () => {
  expect(installedEffectiveCspDiagnostic(observation)).toBe(
    "Installed effective CSP: eval_blocked=false inline_blocked=false document_url=app_index ready_state=complete preload_present=true meta_count=1 meta_matches=true",
  );
});

it.each([
  { ...observation, documentUrl: "file:///private/path" },
  { ...observation, readyState: "/private/state" },
  { ...observation, metaCount: 18 },
  { ...observation, metaMatches: "private" },
  { ...observation, evalBlocked: "false" },
  { ...observation, rawPolicy: "/private/content" },
  null,
])("rejects malformed or private observations", (value) => {
  expect(installedEffectiveCspDiagnostic(value)).toBe("Installed effective CSP: invalid_evidence");
});
