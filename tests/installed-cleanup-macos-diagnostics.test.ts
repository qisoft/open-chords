import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const script = readFileSync("tests/support/installed-cleanup-macos.jxa", "utf8");

describe("macOS native cleanup discovery diagnostics", () => {
  for (const stage of ["processes", "windows", "elements"] as const) {
    it(`reports fixed ${stage} evidence without private exception content`, () => {
      const failure = Object.assign(new Error("/private/fixture secret window title"), {
        errorNumber: -25211,
      });
      const process = {
        windows: () => {
          if (stage === "windows") throw failure;
          return [
            {
              entireContents: () => {
                throw failure;
              },
            },
          ];
        },
      };
      const run = runInNewContext(`${script}; run`, {
        Application: () => ({
          processes: {
            whose: () => () => {
              if (stage === "processes") throw failure;
              return [process];
            },
          },
        }),
      });
      let message = "";
      try {
        run(["123", "cancel-final"]);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(`stage=${stage}`);
      expect(message).toContain("completed=0 last_category=none os_error=-25211");
      expect(message).toContain(`process_matches=${stage === "processes" ? -1 : 1}`);
      expect(message).not.toContain("private");
      expect(message).not.toContain("secret");
    });
  }
  it("suppresses nonnumeric exception codes", () => {
    const run = runInNewContext(`${script}; run`, {
      Application: () => ({
        processes: {
          whose: () => () => [
            {
              windows: () => {
                throw { errorNumber: "/private/token" };
              },
            },
          ],
        },
      }),
    });
    expect(() => run(["123", "cancel-final"])).toThrow("os_error=unknown");
  });
});
