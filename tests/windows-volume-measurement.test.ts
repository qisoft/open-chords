import { expect, it } from "vitest";

import { windowsLocalVolumeMeasurementCommand } from "../apps/desktop/src/main/windows-local-volume-command.ts";
import { parseWindowsVolumeMeasurement } from "./support/windows-volume-measurement.ts";

it("accepts bounded phase measurements with surrounding process whitespace", () => {
  expect(parseWindowsVolumeMeasurement("3|123|20000|20124\r\n")).toEqual({
    driveType: "3",
    importMs: 123,
    queryMs: 20000,
    scriptMs: 20124,
  });
});

it.each([
  "3",
  "7|1|2|3",
  "3|1|2|2",
  "3|0|0|100001",
  "3|-1|2|3",
  "3|1.5|2|4",
  "3|1|2|3|4",
  "3|1|2|3\nprivate path",
  "x".repeat(129),
])("refuses invalid or private subprocess output without echoing it", (output) => {
  expect(() => parseWindowsVolumeMeasurement(output)).toThrow(
    /^Windows volume measurement evidence invalid$/,
  );
});

it("validates measurement roots before producing executable commands", () => {
  expect(() => windowsLocalVolumeMeasurementCommand("C:'; exit 0; #", "explicit")).toThrow(
    "Windows volume root unavailable",
  );
});
