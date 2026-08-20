# Toolchain foundation

Issue [#31](https://github.com/qisoft/open-chords/issues/31) owns this repository foundation. It intentionally contains no Project, media, analysis, editor, YouTube, persistence, or export behavior.

## Runtime boundaries

- `apps/desktop/src/renderer` is the React 19 renderer boundary. Base UI, Tailwind CSS 4, Lucide, and scoped Zustand stores belong here.
- `apps/desktop/src/preload` is an empty sandboxed capability boundary until the typed IPC issue owns its public API. Zod may later validate wire data here; UI packages and Effect are lint-blocked.
- `apps/desktop/src/main` is the Electron authority boundary. Stable Effect v3 is reserved for later orchestration slices; React, Base UI, Lucide, and Zustand are lint-blocked.
- Zod is the shared runtime wire-schema dependency. This issue does not define a wire contract.

## Build and package

Vite builds renderer, main, and preload directly into separate static outputs. Electron Forge invokes the same build through its stable `generateAssets` hook, packages the application into ASAR, applies restrictive Electron fuses, and does not use the experimental Forge Vite plugin.

The renderer ships a restrictive CSP and external JavaScript/CSS only. The initial Playwright seam launches Electron, checks the visible static renderer, and proves that Node globals are absent.

## Dependency installation

Use the exact pnpm version declared in `package.json`. The workspace has one lockfile. Dependency lifecycle scripts are denied by default; only Electron and esbuild are explicitly reviewed in `pnpm-workspace.yaml`. Security overrides keep Forge's archive/temp build dependencies on patched implementations while Forge 7.11 remains pinned; the published Electron node-gyp fork avoids a rate-limited git tarball during frozen installs. Electron 43 downloads its checksum-verified binary through the explicit `pnpm electron:install` command.

## Gates

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:renderer`
- `pnpm package -- --arch=<native architecture>`

Domain/contract changes additionally run `pnpm contracts:schema:check`, `pnpm test:fixtures`, and `pnpm test:python`; see [Canonical domain contracts](./domain-contracts.md).

CI runs the complete sequence on macOS 15 arm64 and Windows Server 2025 x64 with a frozen pnpm install.
