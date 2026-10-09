import { describe, expect, it } from "vitest";

import { installedSaveDriverDiagnostic } from "./support/installed-save-diagnostics.ts";

describe("native Save driver failure redaction", () => {
  it.each(["PSSecurityException", "ParserError"])(
    "classifies %s without exposing command or stderr",
    (code) => {
      const privatePath = "C:\\Users\\private\\score.json";
      const error = { code: 1, killed: false, message: privatePath, stderr: privatePath };
      const diagnostic = installedSaveDriverDiagnostic(error, `${privatePath}\n${code}`, 43);
      expect(diagnostic).toContain(
        `category=powershell_${code === "ParserError" ? "parser" : "policy"}`,
      );
      expect(diagnostic).toContain("started=false");
      expect(diagnostic).toContain("exit_code=1");
      expect(diagnostic).not.toContain(privatePath);
    },
  );

  it("distinguishes a host kill and retains only fixed driver counters", () => {
    const counters =
      "native_save_failed stage=discovery windows=2 elements=14 filenames=0 actions=0";
    const diagnostic = installedSaveDriverDiagnostic(
      { killed: true, signal: "SIGTERM", code: null, path: "/private/application" },
      `Native Save driver stage: started\r\n${counters}\r\n/private/filename`,
      100083,
    );
    expect(diagnostic).toContain(
      "duration_ms=100083 killed=true exit_code=none exit_signal=SIGTERM",
    );
    expect(diagnostic).toContain("started=true category=unknown");
    expect(diagnostic).toContain(counters);
    expect(diagnostic).not.toContain("/private");
  });

  it("reports an allowlisted spawn refusal without exposing its path", () => {
    const diagnostic = installedSaveDriverDiagnostic(
      { code: "EACCES", path: "/private/driver" },
      "",
      2,
    );
    expect(diagnostic).toContain("started=false category=unknown spawn_code=EACCES");
    expect(diagnostic).not.toContain("/private");
  });

  it("rejects unbounded counters and injected private diagnostic text", () => {
    const diagnostic = installedSaveDriverDiagnostic(
      { signal: "private-signal", code: "private-code" },
      "native_save_failed stage=discovery windows=2000000000 elements=1 filenames=1 actions=1\nnative_save_failed stage=private/path windows=1 elements=1 filenames=1 actions=1",
      100,
    );
    expect(diagnostic).not.toContain("native_save_failed");
    expect(diagnostic).not.toContain("private");
  });
});
