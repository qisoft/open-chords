import { expect, it } from "vitest";

import {
  installedSaveDriverDiagnostic,
  installedWindowsFixtureDiagnostic,
} from "./support/installed-save-diagnostics.ts";

it.each([
  "local_path",
  "full_path",
  "filename",
  "parent_reparse",
  "handle_open",
  "handle_info",
  "file_type",
  "link_count",
  "size",
  "content",
  "eof",
])("retains only the fixed fixture refusal %s", (check) => {
  const line = `Native Windows replacement fixture refusal: check=${check}`;
  expect(installedWindowsFixtureDiagnostic(`/private\n${line}`)).toEqual([line]);
  expect(installedSaveDriverDiagnostic({ code: 1 }, line, 5)).toContain(line);
});
it.each(["io", "access", "argument"])("retains only the fixed exception kind %s", (kind) => {
  const line = `Native Windows replacement fixture exception: kind=${kind}`;
  expect(installedWindowsFixtureDiagnostic(`/private\n${line}`)).toEqual([line]);
});
it.each([
  "Native Windows replacement fixture refusal: check=/private",
  "Native Windows replacement fixture refusal: check=full_path /private",
  "Native Windows replacement fixture exception: kind=/private",
])("does not fall back from malformed last fixture evidence", (bad) => {
  const good = bad.includes("refusal")
    ? "Native Windows replacement fixture refusal: check=full_path"
    : "Native Windows replacement fixture exception: kind=io";
  expect(installedWindowsFixtureDiagnostic(`${good}\n${bad}`)).toEqual([]);
});
