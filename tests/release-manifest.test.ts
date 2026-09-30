import { expect, it } from "vitest";

import { ReleaseManifestSchema } from "../tools/release/release-manifest.ts";
import {
  darwinManifestFixture,
  windowsManifestFixture,
} from "./support/release-manifest-fixture.ts";

const archive = {
  fileName: "open-chords-0.0.0-macos-arm64.zip",
  bytes: 10,
  sha256: "b".repeat(64),
};

it("accepts unsigned community manifests for both official targets", () => {
  expect(ReleaseManifestSchema.safeParse(darwinManifestFixture(archive)).success).toBe(true);
  expect(
    ReleaseManifestSchema.safeParse(
      windowsManifestFixture({ ...archive, fileName: "open-chords-0.0.0-windows-x64.zip" }),
    ).success,
  ).toBe(true);
});

it("cannot represent notarization, publisher signing, or a certificate-signed executable", () => {
  const valid = darwinManifestFixture(archive);
  const [executable] = valid.installed.executables;
  const variants = [
    { ...valid, distribution: { ...valid.distribution, notarization: "stapled" } },
    { ...valid, distribution: { ...valid.distribution, publisherSigning: "developer-id" } },
    {
      ...valid,
      installed: {
        ...valid.installed,
        executables: [{ ...executable, signature: "developer-id" }],
      },
    },
    {
      ...valid,
      installed: {
        ...valid.installed,
        executables: [{ ...executable, teamIdentifier: "ABCDE12345" }],
      },
    },
  ];

  expect(variants.map((variant) => ReleaseManifestSchema.safeParse(variant).success)).toEqual([
    false,
    false,
    false,
    false,
  ]);
});

it("rejects a target whose installed observation belongs to the other platform", () => {
  const darwin = darwinManifestFixture(archive);
  const windows = windowsManifestFixture(archive);

  expect(ReleaseManifestSchema.safeParse({ ...darwin, installed: windows.installed }).success).toBe(
    false,
  );
});
