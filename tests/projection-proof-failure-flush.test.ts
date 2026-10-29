import { expect, it, vi } from "vitest";

import { rethrowProjectionProofFailure } from "../apps/desktop/src/main/packaged-projection-proof-diagnostic.ts";

it.each(["archive", "export"] as const)(
  "waits for the %s failure write callback before rejecting the original error",
  async (proof) => {
    let flushed: (() => void) | undefined;
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk, encodingOrCallback: unknown) => {
        lines.push(String(chunk));
        if (typeof encodingOrCallback === "function") flushed = () => encodingOrCallback();
        return false;
      });
    try {
      const original = new Error("/private/original");
      let settled = false;
      const rejected = rethrowProjectionProofFailure(proof, original).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(flushed).toBeTypeOf("function");
      flushed!();
      expect(await rejected).toBe(original);
      expect(lines).toEqual([`Packaged ${proof} proof failure: code=unknown\n`]);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  },
);

it("retains the original error when the diagnostic write throws", async () => {
  const original = new Error("archive_proof_import_failed");
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("private transport failure");
  });
  try {
    await expect(rethrowProjectionProofFailure("archive", original)).rejects.toBe(original);
  } finally {
    write.mockRestore();
  }
});
