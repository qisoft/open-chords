import { expect, it } from "vitest";

import { windowsLocalVolumeMeasurementCommand } from "../apps/desktop/src/main/windows-local-volume-command.ts";
import { parseWindowsVolumeMeasurement } from "./support/windows-volume-measurement.ts";

it("accepts bounded phase measurements with surrounding process whitespace", () => {
  expect(parseWindowsVolumeMeasurement("3|5|123|20000|20129\r\n")).toEqual({
    driveType: "3",
    dependencyMs: 5,
    importMs: 123,
    queryMs: 20000,
    scriptMs: 20129,
  });
});

it.each([
  "3",
  "7|0|1|2|3",
  "3|1|1|2|3",
  "3|0|0|0|100001",
  "3|0|-1|2|3",
  "3|0|1.5|2|4",
  "3|0|1|2|3|4",
  "3|0|1|2|3\nprivate path",
  "x".repeat(129),
])("refuses invalid or private subprocess output without echoing it", (output) => {
  expect(() => parseWindowsVolumeMeasurement(output)).toThrow(
    /^Windows volume measurement evidence invalid$/,
  );
});

it.each(["automatic", "explicit", "dependencies"] as const)(
  "validates measurement roots in %s mode",
  (mode) => {
    expect(() => windowsLocalVolumeMeasurementCommand("C:'; exit 0; #", mode)).toThrow(
      "Windows volume root unavailable",
    );
  },
);
