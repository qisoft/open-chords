import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  collectJavaScriptPackages,
  renderJavaScriptPackageNotices,
} from "../tools/release/javascript-package-notices.ts";

it("ships complete MIT and original Apache notices for the PDF runtime packages", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-pdf-notices-"));
  try {
    for (const name of ["brotli", "dfa", "fontkit"]) {
      const target = join(root, name);
      mkdirSync(target);
      for (const file of ["package.json", "LICENSE"])
        cpSync(join("node_modules", name, file), join(target, file));
    }
    const packages = collectJavaScriptPackages(root);
    expect(packages.map(({ name, version }) => `${name}@${version}`)).toEqual([
      "brotli@1.3.3",
      "dfa@1.2.0",
      "fontkit@2.0.4",
    ]);
    const text = renderJavaScriptPackageNotices(packages);
    expect(text.match(/Permission is hereby granted/g)).toHaveLength(3);
    expect(text).toContain("Copyright 2013 Google Inc. All Rights Reserved.");
    expect(text).toContain("Apache License");
    expect(text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(text).not.toContain("<copyright holders>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
