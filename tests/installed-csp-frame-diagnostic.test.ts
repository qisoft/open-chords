import { expect, it } from "vitest";

import { installedCspFrameTreeDiagnostic } from "./support/installed-csp-frame-diagnostic.ts";

const node = (url: string, childFrames: unknown[] = []) => ({ frame: { url }, childFrames });
it("distinguishes the app root and blank child without leaking URLs", () => {
  expect(
    installedCspFrameTreeDiagnostic(
      node("open-chords://app/index.html?private", [
        node("about:blank"),
        node("file:///private/frame"),
      ]),
    ),
  ).toBe("Installed CSP frame tree: root=app_index frames=3 app=1 blank=1 other=1 truncated=false");
});
it("distinguishes a blank top-level document", () => {
  expect(installedCspFrameTreeDiagnostic(node("about:blank"))).toBe(
    "Installed CSP frame tree: root=about_blank frames=1 app=0 blank=1 other=0 truncated=false",
  );
});
it.each([undefined, null, {}, node("about:blank", [null]), { frame: { url: 42 } }])(
  "refuses malformed tree %j",
  (value) => {
    expect(installedCspFrameTreeDiagnostic(value)).toBe(
      "Installed CSP frame tree: invalid_evidence",
    );
  },
);
it("bounds wide and deep trees", () => {
  const wide = node(
    "open-chords://app/index.html",
    Array.from({ length: 1000 }, () => node("about:blank")),
  );
  expect(installedCspFrameTreeDiagnostic(wide)).toBe(
    "Installed CSP frame tree: root=app_index frames=64 app=1 blank=63 other=0 truncated=true",
  );
  const deep = node("about:blank");
  let current = deep;
  for (let i = 0; i < 1000; i++) {
    const child = node("about:blank");
    current.childFrames.push(child);
    current = child;
  }
  expect(installedCspFrameTreeDiagnostic(deep)).toContain(
    "frames=64 app=0 blank=64 other=0 truncated=true",
  );
});
it.each(["open-chords://app/other?secret", "https://private.example/frame", "/private/local"])(
  "emits only fixed URL categories for %s",
  (url) => {
    const result = installedCspFrameTreeDiagnostic(node(url));
    expect(result).not.toContain("secret");
    expect(result).not.toContain("private");
    expect(result).not.toContain(url);
  },
);
