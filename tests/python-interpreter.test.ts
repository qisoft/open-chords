import { describe, expect, it } from "vitest";

import { pythonCandidates } from "../tools/python-interpreter.ts";

describe("Python interpreter selection", () => {
  it("prefers the setup-python PATH interpreter over the Windows launcher", () => {
    expect(pythonCandidates(undefined, "win32")).toEqual([
      { arguments: [], command: "python" },
      { arguments: ["-3"], command: "py" },
    ]);
  });

  it("uses an explicit project override exclusively", () => {
    expect(pythonCandidates("./sidecar-python", "darwin")).toEqual([
      { arguments: [], command: "./sidecar-python" },
    ]);
  });
});
