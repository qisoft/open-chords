import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import {
  installedCspFrameNavigationDiagnostic,
  installedCspPriorMediaDiagnostic,
} from "./support/installed-csp-transition-diagnostics.ts";

const playback = {
  offline: true,
  played: true,
  workspacePlayed: true,
  timelineMoved: true,
  seeked: true,
  pathKeyExposed: false,
  error: null,
  type: "media.playback_ready",
  body: "private bytes",
  urlProtocol: "private protocol",
};
it("distinguishes empty frame URL from nonempty invalid URLs", () => {
  expect(installedCspFrameNavigationDiagnostic({ frame: { url: "" } })).toBe(
    "Installed CSP navigation: root_url=empty origin=absent unreachable=absent",
  );
  expect(installedCspFrameNavigationDiagnostic({ frame: { url: "/private/path" } })).toBe(
    "Installed CSP navigation: root_url=nonempty origin=absent unreachable=absent",
  );
});
it("classifies only existing frame origin and unreachable URL fields", () => {
  expect(
    installedCspFrameNavigationDiagnostic({
      frame: {
        url: "",
        securityOrigin: "null",
        unreachableUrl: "open-chords://app/index.html?private",
      },
    }),
  ).toBe("Installed CSP navigation: root_url=empty origin=opaque unreachable=app_index");
});
it.each([
  [undefined, "absent"],
  ["", "empty"],
  ["null", "opaque"],
  ["open-chords://app", "app"],
  ["https://private.example", "other"],
  ["file:///private/path", "other"],
  ["private", "other"],
])("classifies origin without exposing it", (origin, category) => {
  const line = installedCspFrameNavigationDiagnostic({
    frame: { url: "about:blank", securityOrigin: origin },
  });
  expect(line).toContain(`origin=${category} `);
  expect(line).not.toContain("private");
});
it.each([
  [undefined, "absent"],
  ["", "empty"],
  ["about:blank", "about_blank"],
  ["open-chords://app/index.html?private", "app_index"],
  ["open-chords://app/private", "app_other"],
  ["https://private.example", "other"],
])("classifies unreachable URL without exposing it", (url, category) => {
  expect(installedCspFrameNavigationDiagnostic({ frame: { url: "", unreachableUrl: url } })).toBe(
    `Installed CSP navigation: root_url=empty origin=absent unreachable=${category}`,
  );
});
it.each([
  null,
  undefined,
  {},
  { frame: { url: 1 } },
  { frame: { url: "", securityOrigin: 1 } },
  { frame: { url: "", unreachableUrl: null } },
])("refuses malformed frame evidence", (value) => {
  expect(installedCspFrameNavigationDiagnostic(value)).toBe(
    "Installed CSP navigation: invalid_evidence",
  );
});
it("retains prior media success and selected target category without content", () => {
  expect(installedCspPriorMediaDiagnostic("open-chords://app/index.html?private", playback)).toBe(
    "Installed CSP prior media: target=app_index type=playback_ready offline=true played=true workspace_played=true timeline_moved=true seeked=true path_key_exposed=false error_present=false entry=unavailable entry_preload=unknown exit=unavailable exit_preload=unknown",
  );
});
it("retains prior probe failure without the raw error or body", () => {
  const line = installedCspPriorMediaDiagnostic("about:blank", {
    ...playback,
    type: "media.probe_failed",
    offline: false,
    error: "private exception /private/path",
    body: "private",
  });
  expect(line).toContain("target=about_blank type=probe_failed offline=false");
  expect(line).toContain("error_present=true");
  expect(line).not.toContain("private");
});
it.each(["desktop.error", "private type"])("categorizes media result type", (type) => {
  const line = installedCspPriorMediaDiagnostic("https://private.example", { ...playback, type });
  expect(line).toContain(`type=${type === "desktop.error" ? "desktop_error" : "other"} `);
  expect(line).not.toContain("private");
});
it.each([undefined, null, {}, { ...playback, played: "private" }, { ...playback, error: 5 }])(
  "refuses malformed prior media evidence",
  (value) => {
    expect(installedCspPriorMediaDiagnostic("private", value)).toBe(
      "Installed CSP prior media: invalid_evidence",
    );
  },
);

it("distinguishes successful app media followed by a different CSP context", () => {
  const line = installedCspPriorMediaDiagnostic("open-chords://app/index.html", {
    ...playback,
    entryContext: { document: "app_index", preloadPresent: true },
    exitContext: { document: "app_index", preloadPresent: true },
  });
  expect(line).toContain("entry=app_index entry_preload=true exit=app_index exit_preload=true");
});
it("distinguishes a probe that was already in a blank document", () => {
  const line = installedCspPriorMediaDiagnostic("open-chords://app/index.html", {
    ...playback,
    offline: false,
    error: "private",
    type: "media.probe_failed",
    entryContext: { document: "about_blank", preloadPresent: false },
    exitContext: { document: "about_blank", preloadPresent: false },
  });
  expect(line).toContain(
    "entry=about_blank entry_preload=false exit=about_blank exit_preload=false",
  );
  expect(line).not.toContain("private");
});
it.each([
  { document: "file:///private/path", preloadPresent: true },
  { document: "app_index", preloadPresent: true, url: "private" },
  { document: "app_index", preloadPresent: "private" },
])("rejects raw or malformed document context", (context) => {
  expect(
    installedCspPriorMediaDiagnostic("about:blank", { ...playback, entryContext: context }),
  ).toBe("Installed CSP prior media: invalid_evidence");
});

const source = readFileSync("tests/packaged/security.spec.ts", "utf8");
const rendererContextFunction = source.match(
  /const readDocumentContext = ([\s\S]*?);\n    const entryContext/,
)?.[1];
it.each([
  ["open-chords://app/index.html?private", true, "app_index"],
  ["open-chords://app/private", false, "app_other"],
  ["about:blank", false, "about_blank"],
  ["file:///private/path", true, "other"],
  ["https://private.example", false, "other"],
])("classifies the actual renderer diagnostic function in a pure VM", (href, preload, document) => {
  const value = runInNewContext(`(${rendererContextFunction})()`, {
    URL,
    location: { href },
    window: { openChords: preload ? {} : undefined },
  });
  expect(value).toEqual({ document, preloadPresent: preload });
  expect(JSON.stringify(value)).not.toContain("private");
});
it("a diagnostic read failure cannot throw into the original media probe", () => {
  const value = runInNewContext(`(${rendererContextFunction})()`, {
    URL,
    location: {
      get href() {
        throw new Error("private");
      },
    },
    window: {},
  });
  expect(value).toEqual({ document: "unavailable", preloadPresent: false });
});
