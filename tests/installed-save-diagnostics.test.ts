import { describe, expect, it } from "vitest";

import {
  installedSaveDriverDiagnostic,
  installedSaveDriverTiming,
} from "./support/installed-save-diagnostics.ts";

describe("native Save driver failure redaction", () => {
  it("retains only bounded click-hit booleans without private UI content", () => {
    const probe =
      "Native Save click probe: control_known=true hit_control=false hit_child=false cursor_match=true";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      [
        probe,
        probe,
        probe,
        probe,
        `${probe} /private/title`,
        probe.replace("hit_control=false", "hit_control=secret"),
      ].join("\n"),
      2000,
    );
    expect(diagnostic.split(probe)).toHaveLength(4);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("secret");
  });
  it("retains bounded dismissal booleans and rejects private or malformed fields", () => {
    const probe = "Native Save dismissal probe: exists=true visible=false enabled=true owned=true";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      [
        probe,
        probe,
        probe,
        probe,
        `${probe} /private/secret`,
        probe.replace("owned=true", "owned=/private/token"),
      ].join("\n"),
      2000,
    );
    expect(diagnostic.split(probe)).toHaveLength(4);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("token");
  });
  it("retains only bounded point-root and DPI categories", () => {
    const probe = "Native Save point probe: inside_dialog=false hit=foreign awareness=0";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${probe}\n${probe} /private/path\n${probe.replace("awareness=0", "awareness=999")}`,
      100,
    );
    expect(diagnostic).toContain(probe);
    expect(diagnostic.split("Native Save point probe:")).toHaveLength(2);
    expect(diagnostic).not.toContain("private");
  });
  it.each(["expected", "basename", "double_dot", "double_extension", "empty", "other"])(
    "retains only the fixed default filename classification %s",
    (kind) => {
      const probe = `Native Save default probe: value=${kind}`;
      const privatePath = "C:\\Users\\private\\score.json";
      const diagnostic = installedSaveDriverDiagnostic(
        {},
        `${probe}\n${probe} ${privatePath}\nNative Save default probe: value=${privatePath}`,
        100,
      );
      expect(diagnostic).toContain(probe);
      expect(diagnostic.split("Native Save default probe:")).toHaveLength(2);
      expect(diagnostic).not.toContain(privatePath);
    },
  );
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
      "native_save_failed code=filename_pattern_unavailable stage=discovery windows=2 elements=14 filenames=0 actions=0 fallback_misses=4";
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
      "native_save_failed code=filename_pattern_unavailable stage=discovery windows=2000000000 elements=1 filenames=1 actions=1\nnative_save_failed code=filename_pattern_unavailable stage=private/path windows=1 elements=1 filenames=1 actions=1",
      100,
    );
    expect(diagnostic).not.toContain("native_save_failed");
    expect(diagnostic).not.toContain("private");
  });

  it("retains bounded operation probes and rejects raw or injected UI data", () => {
    const probe =
      "Native Save driver probe: elements_query duration_ms=501 windows=2 elements=0 filenames=0 actions=0";
    const diagnostic = installedSaveDriverDiagnostic(
      { killed: true, signal: "SIGTERM" },
      `${Array.from({ length: 20 }, () => probe).join("\r\n")}\r\nNative Save driver probe: private/path duration_ms=1 windows=1 elements=1 filenames=1 actions=1\r\n${probe} /private/name`,
      100000,
    );
    expect(diagnostic.split(probe)).toHaveLength(17);
    expect(diagnostic).not.toContain("private");
  });

  it.each(["true", "false"])(
    "retains bounded native window observations with truncated=%s",
    (truncated) => {
      const probe = `Native Save window probe: owned=2 expected_titles=1 save_as_titles=0 dialogs=1 truncated=${truncated}`;
      const diagnostic = installedSaveDriverDiagnostic(
        {},
        `${Array.from({ length: 6 }, () => probe).join("\r\n")}\r\n${probe} C:\\private\\file\r\nNative Save window probe: owned=private expected_titles=0 save_as_titles=0 dialogs=0`,
        100,
      );
      expect(diagnostic.split(probe)).toHaveLength(4);
      expect(diagnostic).not.toContain("private");
    },
  );
  it("retains bounded control observations without raw UI text", () => {
    const probe =
      "Native Save control probe: edits=2 buttons=4 file_labels=1 action_labels=1 visible_enabled=20 eligible_file_labels=0 value_pattern_file_labels=1 readonly_file_labels=1 writable_file_descendants=1 writable_labeled_files=0 eligible_action_labels=0";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${Array.from({ length: 6 }, () => probe).join("\r\n")}\r\n${probe} /private/name\r\n${probe.replace("edits=2", "edits=1000")}`,
      100,
    );
    expect(diagnostic.split(probe)).toHaveLength(4);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("edits=1000");
  });
  it("retains final validated observations after a long discovery transcript", () => {
    const probe =
      "Native Save driver probe: controls_read duration_ms=90000 windows=1 elements=81 filenames=0 actions=300";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${"private UI text\n".repeat(2000)}${probe}`,
      90000,
    );
    expect(diagnostic).toContain(probe);
    expect(diagnostic).not.toContain("private UI text");
  });
  it("retains only bounded numeric candidate properties and fixed value classes", () => {
    const probe =
      "Native Save candidate probe: type=50004 id=FileNameControlHost name=default value=empty readonly=false eligible=true";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${(probe + "\n").repeat(70)}${probe} /private/name\n${probe.replace("id=FileNameControlHost", "id=private")}`,
      100,
    );
    expect(diagnostic.split(probe)).toHaveLength(65);
    expect(diagnostic).not.toContain("private");
  });
  it("validates bounded native child categories without exporting text", () => {
    const probe = "Native Save child probe: id=1001 class=edit text=default eligible=true";
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${probe}\nNative Save child scan: visited=40 truncated=false\n${probe} /private/file`,
      100,
    );
    expect(diagnostic).toContain(probe);
    expect(diagnostic).toContain("visited=40 truncated=false");
    expect(diagnostic).not.toContain("private");
  });
  it.each([
    "filename_target_changed",
    "filename_read_unavailable",
    "input_architecture_unsupported",
    "filename_input_bound",
    "filename_bounds_unavailable",
    "filename_focus_refused",
    "filename_input_not_delivered",
    "input_target_unavailable",
    "input_foreground_refused",
    "input_point_refused",
    "input_cursor_refused",
    "dialog_not_dismissed",
  ])("preserves fixed native refusal %s without raw exception text", (code) => {
    const probe = `native_save_failed code=${code} stage=filename_set windows=1 elements=81 filenames=1 actions=1 fallback_misses=0`;
    const diagnostic = installedSaveDriverDiagnostic({}, `${probe}\n${probe} /private/file`, 100);
    expect(diagnostic).toContain(probe);
    expect(diagnostic).not.toContain("private");
  });
  it.each(["true", "false", "unknown"])(
    "retains bounded dismissal response observations: %s",
    (value) => {
      const probe = `Native Save response probe: dialog_responsive=${value} control_responsive=${value} focus_control=${value} capture_control=${value} left_down=false foreground_dialog=true`;
      const diagnostic = installedSaveDriverDiagnostic(
        {},
        `${(probe + "\n").repeat(5)}${probe} /private/file\n${probe.replace("left_down=false", "left_down=private")}`,
        100,
      );
      expect(diagnostic.split(probe)).toHaveLength(4);
      expect(diagnostic).not.toContain("private");
    },
  );
  it.each([
    "none",
    "application",
    "driver",
    "console",
    "terminal",
    "shell",
    "runner",
    "other",
    "unavailable",
  ])("retains only fixed post-input process categories: %s", (process) => {
    const probe = `Native Save activation probe: phase=after_input process=${process} elapsed_ms=2`;
    const diagnostic = installedSaveDriverDiagnostic(
      {},
      `${(probe + "\n").repeat(5)}${probe} /private/file\n${probe.replace(`process=${process}`, "process=private.exe")}\n${probe.replace("elapsed_ms=2", "elapsed_ms=1234567890")}`,
      100,
    );
    expect(diagnostic.split(probe)).toHaveLength(4);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("1234567890");
  });
  it.each(["before_input", "after_input", "dismissal"])(
    "retains bounded pointer state at %s",
    (phase) => {
      const probe = `Native Save pointer probe: phase=${phase} cursor_match=true point_root=foreign hit_control=false foreground_at_point=true left_down=false modifier_mask=15`;
      const diagnostic = installedSaveDriverDiagnostic(
        {},
        [
          ...Array(5).fill(probe),
          `${probe} /private/path`,
          probe.replace("modifier_mask=15", "modifier_mask=16"),
          probe.replace("point_root=foreign", "point_root=private"),
          probe.replace(`phase=${phase}`, "phase=private"),
          probe.replace("cursor_match=true", "cursor_match=private"),
        ].join("\n"),
        100,
      );
      expect(diagnostic.split(probe)).toHaveLength(4);
      expect(diagnostic).not.toContain("private");
      expect(diagnostic).not.toContain("modifier_mask=16");
    },
  );
  it.each(["none", "dialog", "application", "owned_other", "driver", "foreign"])(
    "retains bounded foreground categories: %s",
    (kind) => {
      const probe = `Native Save foreground probe: phase=dismissal kind=${kind} class=dialog visible=true enabled=true`;
      const diagnostic = installedSaveDriverDiagnostic(
        {},
        `${(probe + "\n").repeat(5)}${probe} /private/file\n${probe.replace("class=dialog", "class=private")}`,
        100,
      );
      expect(diagnostic.split(probe)).toHaveLength(4);
      expect(diagnostic).not.toContain("private");
    },
  );
});

it("keeps bounded filename read outcomes and prioritizes the fixed failure code", () => {
  const probe =
    "Native Save filename read probe: completed=false length_bound=unknown duration_ms=251 dialog_exists=true field_exists=true field_child=true";
  const counter =
    "native_save_failed code=filename_read_unavailable stage=filename_set windows=1 elements=81 filenames=1 actions=1 fallback_misses=0";
  const output = installedSaveDriverDiagnostic(
    {},
    [
      probe,
      probe,
      probe,
      probe,
      `${probe} /private/path`,
      probe.replace("duration_ms=251", "duration_ms=1234567"),
      probe.replace("field_child=true", "field_child=private"),
      counter,
    ].join("\n"),
    1,
  );
  expect(output.split(probe)).toHaveLength(4);
  expect(output.indexOf(counter)).toBeLessThan(output.indexOf(probe));
  expect(output).not.toContain("private");
  expect(output).not.toContain("1234567");
});

it.each(["after_input", "dismissal"])("retains bounded native target identity at %s", (phase) => {
  const probe = `Native Save input target probe: phase=${phase} class=button id=cancel child=true owned=true thread_known=true active_dialog=false focus_control=false capture_control=unknown`;
  const diagnostic = installedSaveDriverDiagnostic(
    {},
    [
      ...Array(5).fill(probe),
      `${probe} /private/title`,
      probe.replace("id=cancel", "id=12345"),
      probe.replace("class=button", "class=private"),
      probe.replace("active_dialog=false", "active_dialog=private"),
      probe.replace(`phase=${phase}`, "phase=before_input"),
    ].join("\n"),
    100,
  );
  expect(diagnostic.split(probe)).toHaveLength(4);
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("12345");
  expect(diagnostic).not.toContain("before_input");
});

it("reports preparation and total timings without UI content", () => {
  expect(
    installedSaveDriverTiming(
      "private-path\nNative Save driver probe: root duration_ms=214 windows=0 elements=0 filenames=0 actions=0\nprivate-title",
      1400.6,
    ),
  ).toBe("Native Windows picker timing: initialization_ms=214 total_ms=1401");
});
it.each([
  "Native Save driver probe: root duration_ms=214 windows=0 elements=0 filenames=0 actions=0 /private",
  "Native Save driver probe: root duration_ms=1234567 windows=0 elements=0 filenames=0 actions=0",
  "Native Save driver probe: root duration_ms=private windows=0 elements=0 filenames=0 actions=0",
])("refuses malformed preparation timing: %s", (stderr) => {
  expect(installedSaveDriverTiming(stderr, NaN)).toBe(
    "Native Windows picker timing: initialization_ms=unknown total_ms=unknown",
  );
});
it("bounds total timing", () => {
  expect(installedSaveDriverTiming("", 10000000)).toContain("total_ms=999999");
});

it("preserves the missing prebuilt assembly code without private setup details", () => {
  const code =
    "native_save_failed code=input_assembly_unavailable stage=setup windows=0 elements=0 filenames=0 actions=0 fallback_misses=0";
  const diagnostic = installedSaveDriverDiagnostic(
    {},
    `${code}\n${code} C:\\private\\driver.dll`,
    20,
  );
  expect(diagnostic).toContain(code);
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("driver.dll");
});

it("preserves the fixed explicit-module initialization failure without paths", () => {
  const code =
    "native_save_failed code=input_modules_unavailable stage=setup windows=0 elements=0 filenames=0 actions=0 fallback_misses=0";
  const diagnostic = installedSaveDriverDiagnostic(
    {},
    `${code}\n${code} C:\\private\\module.psd1`,
    100,
  );
  expect(diagnostic).toContain(code);
  expect(diagnostic).not.toContain("private");
});
it.each(["module_import", "modules_loaded"])("preserves bounded %s checkpoints", (stage) => {
  const line = `Native Save driver probe: ${stage} duration_ms=500 windows=0 elements=0 filenames=0 actions=0`;
  expect(installedSaveDriverDiagnostic({}, `${line}\n${line} private`, 500)).toContain(line);
  expect(installedSaveDriverDiagnostic({}, `${line} private`, 500)).not.toContain(line);
});

it.each([0, 5, 1460, 999999])("retains only bounded filename Win32 error evidence %s", (code) => {
  const probe = `Native Save filename error probe: error_code=${code} dialog_pid_match=true field_pid_match=true field_id_match=true foreground_dialog=false`;
  const diagnostic = installedSaveDriverDiagnostic(
    {},
    [
      probe,
      probe,
      probe,
      probe,
      `${probe} /private/file`,
      probe.replace(`error_code=${code}`, "error_code=-1"),
      probe.replace(`error_code=${code}`, "error_code=1000000"),
      probe.replace("field_pid_match=true", "field_pid_match=private"),
    ].join("\n"),
    100,
  );
  expect(diagnostic.split(probe)).toHaveLength(4);
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("error_code=-1");
  expect(diagnostic).not.toContain("error_code=1000000");
});
