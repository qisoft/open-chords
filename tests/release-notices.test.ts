import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  collectJavaScriptPackages,
  renderJavaScriptPackageNotices,
} from "../tools/release/javascript-package-notices.ts";

function writePackage(directory: string, manifest: object, files: Record<string, string>) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
}

function shippedTree(): string {
  const nodeModules = join(mkdtempSync(join(tmpdir(), "open-chords-notices-")), "node_modules");
  writePackage(
    join(nodeModules, "alpha"),
    { name: "alpha", version: "1.0.0", license: "MIT", homepage: "https://alpha.example" },
    { LICENSE: "MIT text\n", "index.js": "" },
  );
  writePackage(
    join(nodeModules, "@scope", "beta"),
    { name: "@scope/beta", version: "2.0.0", license: { type: "Apache-2.0" } },
    { "LICENCE.md": "Apache text\n", NOTICE: "Beta notice\n" },
  );
  writePackage(
    join(nodeModules, "alpha", "node_modules", "gamma"),
    { name: "gamma", version: "0.1.0" },
    { COPYING: "Gamma copying\n" },
  );
  mkdirSync(join(nodeModules, ".bin"));
  writeFileSync(join(nodeModules, ".package-lock.json"), "{}");
  return nodeModules;
}

it("collects scoped and nested shipped packages with their license files", () => {
  expect(collectJavaScriptPackages(shippedTree())).toEqual([
    {
      location: "node_modules/@scope/beta",
      name: "@scope/beta",
      version: "2.0.0",
      license: "Apache-2.0",
      homepage: null,
      licenseFiles: [
        { fileName: "LICENCE.md", text: "Apache text\n" },
        { fileName: "NOTICE", text: "Beta notice\n" },
      ],
    },
    {
      location: "node_modules/alpha",
      name: "alpha",
      version: "1.0.0",
      license: "MIT",
      homepage: "https://alpha.example",
      licenseFiles: [{ fileName: "LICENSE", text: "MIT text\n" }],
    },
    {
      location: "node_modules/alpha/node_modules/gamma",
      name: "gamma",
      version: "0.1.0",
      license: null,
      homepage: null,
      licenseFiles: [{ fileName: "COPYING", text: "Gamma copying\n" }],
    },
  ]);
});

it("fails closed when a shipped package has no license file", () => {
  const nodeModules = shippedTree();
  writePackage(join(nodeModules, "delta"), { name: "delta", version: "3.0.0" }, {});

  expect(() => collectJavaScriptPackages(nodeModules)).toThrow(
    "Shipped package delta@3.0.0 has no license file",
  );
});

it("renders every package with its full license text", () => {
  expect(
    renderJavaScriptPackageNotices([
      {
        location: "node_modules/alpha",
        name: "alpha",
        version: "1.0.0",
        license: "MIT",
        homepage: null,
        licenseFiles: [{ fileName: "LICENSE", text: "MIT text\n" }],
      },
    ]),
  ).toBe(
    [
      "Open Chords third-party JavaScript packages",
      "",
      "This build ships 1 JavaScript packages inside app.asar. Each entry reproduces the license files from the package root.",
      "",
      "=".repeat(80),
      "alpha@1.0.0",
      "License: MIT",
      "Homepage: not declared",
      "Location: app.asar/node_modules/alpha",
      "",
      "--- LICENSE ---",
      "MIT text",
      "",
    ].join("\n"),
  );
});
