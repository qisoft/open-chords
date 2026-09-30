import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

export type JavaScriptPackageNotice = {
  readonly location: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly homepage: string | null;
  readonly licenseFiles: ReadonlyArray<{ readonly fileName: string; readonly text: string }>;
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

const PackageManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.union([z.string(), z.object({ type: z.string() })]).optional(),
  licenses: z.array(z.object({ type: z.string() })).optional(),
  homepage: z.string().optional(),
});

function declaredLicense(manifest: z.infer<typeof PackageManifestSchema>): string | null {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license !== undefined) return manifest.license.type;
  const legacy = manifest.licenses?.map((license) => license.type).join(" OR ");
  return legacy === undefined || legacy === "" ? null : legacy;
}

function isDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}

function readPackage(directory: string, location: string): JavaScriptPackageNotice {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`Shipped package ${location} has no package.json`);
  const manifest = PackageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const licenseFiles = readdirSync(directory)
    .filter((fileName) => LICENSE_FILE.test(fileName) && !isDirectory(join(directory, fileName)))
    .toSorted()
    .map((fileName) => ({ fileName, text: readFileSync(join(directory, fileName), "utf8") }));
  if (licenseFiles.length === 0) {
    throw new Error(`Shipped package ${manifest.name}@${manifest.version} has no license file`);
  }
  return {
    location,
    name: manifest.name,
    version: manifest.version,
    license: declaredLicense(manifest),
    homepage: manifest.homepage ?? null,
    licenseFiles,
  };
}

export function collectJavaScriptPackages(
  nodeModules: string,
  location = "node_modules",
): JavaScriptPackageNotice[] {
  if (!existsSync(nodeModules)) return [];
  return readdirSync(nodeModules)
    .filter((name) => !name.startsWith(".") && isDirectory(join(nodeModules, name)))
    .flatMap((name) =>
      name.startsWith("@")
        ? readdirSync(join(nodeModules, name))
            .filter((scoped) => isDirectory(join(nodeModules, name, scoped)))
            .map((scoped) => `${name}/${scoped}`)
        : [name],
    )
    .flatMap((name) => {
      const directory = join(nodeModules, ...name.split("/"));
      const packageLocation = `${location}/${name}`;
      return [
        readPackage(directory, packageLocation),
        ...collectJavaScriptPackages(
          join(directory, "node_modules"),
          `${packageLocation}/node_modules`,
        ),
      ];
    })
    .toSorted((left, right) =>
      left.location < right.location ? -1 : left.location > right.location ? 1 : 0,
    );
}

const RULE = "=".repeat(80);

export function renderJavaScriptPackageNotices(
  packages: readonly JavaScriptPackageNotice[],
): string {
  const sections = packages.map((notice) =>
    [
      RULE,
      `${notice.name}@${notice.version}`,
      `License: ${notice.license ?? "not declared"}`,
      `Homepage: ${notice.homepage ?? "not declared"}`,
      `Location: app.asar/${notice.location}`,
      ...notice.licenseFiles.flatMap((file) => [
        "",
        `--- ${file.fileName} ---`,
        file.text.trimEnd(),
      ]),
      "",
    ].join("\n"),
  );
  return [
    "Open Chords third-party JavaScript packages",
    "",
    `This build ships ${packages.length} JavaScript packages inside app.asar. Each entry reproduces the license files from the package root.`,
    "",
    ...sections,
  ].join("\n");
}
