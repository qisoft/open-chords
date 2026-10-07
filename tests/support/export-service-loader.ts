import { resolve } from "node:path";

import { createServer } from "vite";

// Fixture preparation uses the same asset transformation as the desktop build.
// Playwright's TypeScript loader cannot load the inline binary font imports.
export async function loadExportFixtureService(): Promise<
  typeof import("../../apps/desktop/src/main/project-exports.ts")
> {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    // Vite loses the static type of this fixed, repository-owned module path.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return (await server.ssrLoadModule(
      resolve("apps/desktop/src/main/project-exports.ts"),
    )) as typeof import("../../apps/desktop/src/main/project-exports.ts");
  } finally {
    await server.close();
  }
}
