import { expect, it } from "vitest";

import {
  installedEffectiveCspDiagnostic,
  installedCspInterruptionDiagnostic,
} from "./support/installed-effective-csp-diagnostics.ts";

const observation = {
  evalBlocked: false,
  inlineScriptBlocked: false,
  documentUrl: "app_index",
  isTopFrame: true,
  topDocumentUrl: "app_index",
  readyState: "complete",
  preloadPresent: true,
  metaCount: 1,
  metaMatches: true,
};

it("retains fixed effective policy and document observations", () => {
  expect(installedEffectiveCspDiagnostic(observation)).toBe(
    "Installed effective CSP: eval_blocked=false inline_blocked=false document_url=app_index top_frame=true top_document_url=app_index ready_state=complete preload_present=true meta_count=1 meta_matches=true",
  );
});

it.each([
  { ...observation, documentUrl: "file:///private/path" },
  { ...observation, readyState: "/private/state" },
  { ...observation, metaCount: 18 },
  { ...observation, isTopFrame: "private" },
  { ...observation, topDocumentUrl: "file:///private/path" },
  { ...observation, metaMatches: "private" },
  { ...observation, evalBlocked: "false" },
  { ...observation, rawPolicy: "/private/content" },
  null,
])("rejects malformed or private observations", (value) => {
  expect(installedEffectiveCspDiagnostic(value)).toBe("Installed effective CSP: invalid_evidence");
});

it("distinguishes blank top-level and child contexts without raw URLs", () => {
  expect(
    installedEffectiveCspDiagnostic({
      ...observation,
      documentUrl: "about_blank",
      isTopFrame: false,
    }),
  ).toContain("document_url=about_blank top_frame=false top_document_url=app_index");
  expect(
    installedEffectiveCspDiagnostic({
      ...observation,
      documentUrl: "about_blank",
      topDocumentUrl: "about_blank",
    }),
  ).toContain("document_url=about_blank top_frame=true top_document_url=about_blank");
});

it.each(["timeout", "error", "close"] as const)(
  "preserves the original CSP refusal on %s while the frame query is pending",
  (reason) => {
    expect(installedCspInterruptionDiagnostic(reason, { observation })).toBe(
      `${installedEffectiveCspDiagnostic(observation)}\nInstalled CSP frame tree: unavailable`,
    );
    const invalid = { ...observation, documentUrl: "/private/document" };
    expect(installedCspInterruptionDiagnostic(reason, { observation: invalid })).toBe(
      "Installed effective CSP: invalid_evidence\nInstalled CSP frame tree: unavailable",
    );
  },
);
it.each([
  ["timeout", "Renderer CDP evaluation timed out"],
  ["error", "Renderer CDP connection failed"],
  ["close", "Renderer CDP connection closed before evaluation completed"],
] as const)("retains the ordinary %s failure before a CSP refusal", (reason, message) => {
  expect(installedCspInterruptionDiagnostic(reason)).toBe(message);
});
