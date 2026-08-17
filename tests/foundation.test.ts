import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(relativePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));

  if (!isRecord(value)) {
    throw new Error(`${relativePath} must contain a JSON object`);
  }

  return value;
}

function findFiles(directory: string, names: ReadonlySet<string>): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "out"].includes(entry.name)) {
      return [];
    }

    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path, names) : names.has(entry.name) ? [path] : [];
  });
}

describe("repository foundation contract", () => {
  it("pins pnpm and keeps one pnpm lockfile", () => {
    const packageJson = readJson("package.json");

    expect(packageJson.packageManager).toBe("pnpm@10.30.1");
    expect(existsSync(join(repositoryRoot, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "pnpm-lock.yaml"))).toBe(true);
    expect(
      findFiles(
        repositoryRoot,
        new Set(["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]),
      ),
    ).toEqual([]);
  });

  it("keeps formatter inputs on LF across native checkouts", () => {
    const attributes = readFileSync(join(repositoryRoot, ".gitattributes"), "utf8");

    expect(attributes).toContain("* text=auto eol=lf");
  });

  it("denies dependency build scripts unless explicitly reviewed", () => {
    const workspace = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");

    expect(workspace).toContain("strictDepBuilds: true");
    expect(workspace).toContain("nodeLinker: hoisted");
    expect(workspace).toContain("allowBuilds:");
    expect(workspace).toContain("electron: true");
    expect(workspace).toContain("esbuild: true");
    expect(workspace).not.toContain("dangerouslyAllowAllBuilds: true");
    expect([...workspace.matchAll(/^\s{2}([^:\n]+): true$/gm)].map((match) => match[1])).toEqual([
      "electron",
      "esbuild",
    ]);
    expect(workspace).toContain("extract-zip: npm:@electron-internal/extract-zip@1.0.1");
    expect(workspace).toContain("tar: 7.5.22");
    expect(workspace).toContain("tmp: 0.2.7");
  });

  it("uses exact dependency versions and excludes superseded tooling", () => {
    const packageJson = readJson("package.json");
    const dependencyGroups = ["dependencies", "devDependencies"] as const;
    const dependencies: Record<string, string> = {};

    for (const group of dependencyGroups) {
      const entries = packageJson[group];
      if (!isRecord(entries)) {
        continue;
      }

      for (const [name, version] of Object.entries(entries)) {
        if (typeof version === "string") {
          dependencies[name] = version;
        }
      }
    }

    for (const version of Object.values(dependencies)) {
      expect(version).not.toMatch(/^[~^*]|\b(?:latest|next)\b/);
    }

    expect(dependencies).toMatchObject({
      "@base-ui/react": "1.7.0",
      effect: "3.22.1",
      electron: "43.4.0",
      "lucide-react": "1.31.0",
      react: "19.2.8",
      vite: "8.2.1",
      zod: "4.4.3",
      zustand: "5.0.15",
    });
    expect(dependencies.eslint).toBeUndefined();
    expect(dependencies.prettier).toBeUndefined();
    expect(dependencies["@electron-forge/plugin-vite"]).toBeUndefined();
  });
});

describe("production build contract", () => {
  it("emits separate main, preload, and static renderer artifacts", () => {
    const rendererDirectory = join(repositoryRoot, "dist/renderer");
    const html = readFileSync(join(rendererDirectory, "index.html"), "utf8");

    expect(existsSync(join(repositoryRoot, "dist/main/main.cjs"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "dist/preload/preload.cjs"))).toBe(true);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("style-src 'self'");
    expect(html).not.toContain("'unsafe-inline'");
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).not.toMatch(/<script(?![^>]+src=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(readdirSync(join(rendererDirectory, "assets"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.css$/), expect.stringMatching(/\.js$/)]),
    );
  });
});
