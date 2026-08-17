# Open Chords v1 production frontend stack

> Research for Wayfinder issue [#23, “Validate the production frontend stack”](https://github.com/qisoft/open-chords/issues/23). Checked 2026-08-17 against Context7 and the linked first-party documentation, repositories, specifications, and package metadata. This document selects production dependencies and boundaries; it does not implement the frontend.

## Decision summary

Use a **React 19 + strict TypeScript renderer built directly with Vite 8**, packaged by Electron Forge but **not coupled to Forge's experimental Vite plugin**.

The production renderer stack is:

- React and React DOM 19.2.x;
- TypeScript 7.0.x with separate renderer, preload, main, contracts, and domain project references;
- Vite 8.2.x plus the official React plugin, invoked by project-owned build scripts and a Forge `generateAssets`/validation hook;
- Zod 4 schemas as the runtime source of truth at renderer/preload/main boundaries;
- Radix Primitives for ordinary accessible overlays and composite controls;
- CSS Modules, CSS custom-property design tokens, native cascade layers, and system fonts;
- Lucide React icons, always subordinate to a text or accessible control name;
- i18next + react-i18next with bundled typed English and Russian resources;
- TanStack Virtual only behind a measured long-project threshold, never as the semantic model;
- Atlassian Pragmatic Drag and Drop only for the small sortable chord-event list, with explicit keyboard commands as an equal path;
- Vitest for pure and contract tests, real-browser component tests for interaction/layout seams, and Playwright for renderer plus packaged-Electron journeys, screenshots, and automated accessibility checks.

Do **not** add Next.js, Remix, SSR, a local web server, Redux, Zustand, TanStack Query, a canvas-only timeline, runtime CSS-in-JS, Tailwind, or a generic IPC client to the v1 baseline. They do not solve a demonstrated v1 problem and several would blur an already-set authority or accessibility boundary.

The accepted prototype at commit [`ebb82bb`](https://github.com/qisoft/open-chords/tree/ebb82bbc242c6a10be07bedcadae3357d3d5046f/prototypes/workspace-ux) is behavioral evidence, not a dependency template. Preserve its accepted interaction contracts—centered fixed playhead, independently persisted loop, committed/draft isolation, meter-relative event geometry, constrained chord picker, scrollable event list, independently scrolling lyrics, instrumental sections, and collapsible editor—but replace its single-file fixture/reducer, simulated clock, hand-built dialog, and hand-built drag machinery with the production boundaries below.

## 1. Framework and version baseline

### 1.1 Selected baseline

| Concern | Initial v1 line | Pinning rule | License |
|---|---:|---|---|
| Electron | 43.4.x | Exact patch in lockfile and build manifest; advance one supported major at a time after packaged smoke tests | MIT |
| Electron Forge CLI | 7.11.x | Exact patch; Forge packages/makes but does not own renderer compilation | MIT |
| React / React DOM | 19.2.x | Exact patch; update together | MIT |
| TypeScript | 7.0.x | Exact compiler patch; generated JS is not a runtime dependency | Apache-2.0 |
| Vite / `@vitejs/plugin-react` | 8.2.x / 6.0.x | Exact patch; update as one build-tool change | MIT |
| Zod | 4.4.x | Exact patch; schemas and inferred types change together | MIT |
| `radix-ui` | 1.6.x | Exact patch; import only selected primitives | MIT |
| `@tanstack/react-virtual` | 3.14.x | Exact patch; enabled only after the performance/accessibility threshold is proved | MIT |
| Pragmatic Drag and Drop | core 3.x plus matching hitbox/accessibility packages | Exact versions across its package family | Apache-2.0 |
| i18next / react-i18next | 26.3.x / 17.0.x | Exact patches; locale resources version with the app | MIT |
| lucide-react | 1.31.x | Exact patch; named ESM imports only | ISC |
| Vitest / browser provider / React helper | 4.1.x / 4.1.x / 2.2.x | Exact compatible set; browser packages are development-only | MIT |
| Playwright | 1.62.x | Exact patch; browser binaries/cache are CI inputs, not shipped app content | Apache-2.0 |
| axe-core integration | 4.13.x | Dev-only exact patch; automated results never replace manual AT testing | MPL-2.0 |

These are the current stable package lines observed in first-party npm metadata on the check date, not floating ranges ([npm registry: React](https://registry.npmjs.org/react/latest), [TypeScript](https://registry.npmjs.org/typescript/latest), [Vite](https://registry.npmjs.org/vite/latest), [Electron](https://registry.npmjs.org/electron/latest), [Forge](https://registry.npmjs.org/@electron-forge/cli/latest), [Zod](https://registry.npmjs.org/zod/latest), [Radix](https://registry.npmjs.org/radix-ui/latest), [TanStack Virtual](https://registry.npmjs.org/@tanstack/react-virtual/latest), [Pragmatic DnD](https://registry.npmjs.org/@atlaskit/pragmatic-drag-and-drop/latest), [i18next](https://registry.npmjs.org/i18next/latest), [Vitest](https://registry.npmjs.org/vitest/latest), [Playwright](https://registry.npmjs.org/playwright/latest), [Lucide React](https://registry.npmjs.org/lucide-react/latest)). The exact implementation lockfile may take a later patch in the same line. Any major-line change is an explicit dependency PR with contract, packaged, accessibility, and visual gates.

Electron supports only its latest three stable major releases, and only the newest minor on each supported line. Staying current is therefore a recurring security obligation rather than a one-time v1 choice ([Electron release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)).

### 1.2 Why React and TypeScript

React fits the accepted prototype, the project's accessibility component choices, and the available test/tooling ecosystem. More importantly, its built-in `useSyncExternalStore` gives the renderer a defined way to subscribe to an external main-backed snapshot without copying it through effects. React explicitly recommends `useSyncExternalStore` over manual effect subscriptions, requires stable immutable snapshots, and warns that external-store mutations are not transition updates ([React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore), [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)).

TypeScript catches contract misuse but is erased at runtime, so it cannot validate IPC by itself. Use strict TypeScript project references to typecheck the renderer, preload, main, contracts, and pure domain projection against their different runtime libraries. Enable at least `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and `isolatedModules`; never use TypeScript `enum` or namespaces in wire contracts. Project references are the official mechanism for splitting typed projects with a shared dependency ([TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html), [`strict`](https://www.typescriptlang.org/tsconfig/strict.html)).

Vue, Svelte, and Solid are credible client UI frameworks, but none removes the hard Open Chords problems: main-owned authority, external playback clocks, DOM accessibility, packaged Electron testing, and exact timeline hit testing. Rewriting the accepted React prototype would add migration and hiring/tooling cost without measured renderer benefit. Reconsider only if a representative workspace benchmark shows React itself—not state ownership or DOM volume—is the limiting factor.

Full-stack frameworks are rejected. Open Chords has one packaged client route, no server rendering, no SEO, no server components, and no web deployment contract. Next.js/Remix would introduce server/build conventions and a larger supply surface without a product capability. Use a small client router only if v1 eventually gains multiple independently navigable views; the accepted single workspace does not require one.

React Compiler is not a v1 dependency or correctness mechanism. First isolate the clock and use stable selectors; compiler adoption can be a later measured build change.

## 2. Build and Electron integration

### 2.1 Keep Vite and Forge on a stable seam

Electron Forge's Vite plugin remains explicitly **experimental**: Forge says future minor releases may contain breaking changes. It also creates separate Vite builds for renderer, main, and preload ([Forge Vite plugin](https://www.electronforge.io/config/plugins/vite)). That is convenient for prototypes but should not be a release-critical abstraction for v1.

Use this boundary instead:

1. A project-owned Node build entry invokes Vite's documented JavaScript API for the renderer and main/preload configs. Vite officially supports programmatic `build()` and produces static output from an HTML entry ([Vite JavaScript API](https://vite.dev/guide/api-javascript), [Vite production build](https://vite.dev/guide/build)).
2. The renderer build uses `base: './'`, hashed assets, no SSR, no remotely loaded code, and a generated asset manifest. Relative base makes generated asset references relative to the importing file and remains valid under a custom packaged scheme.
3. Main and preload compile as separate targets, externalizing `electron` and Node built-ins. Preload stays small and has no renderer framework dependency.
4. Development uses a project-owned launcher: start the loopback-only Vite dev server, build/watch main and preload, then launch Electron with the explicit dev URL. This behavior is development-only and cannot be enabled in a packaged artifact.
5. `electron-forge package` / `make` own Packager, ASAR, makers, platform artifacts, fuses, and extra resources. A documented Forge `generateAssets` or `prePackage` hook runs or verifies the production build before packaging; those lifecycle hooks are stable Forge configuration points ([Forge hooks](https://www.electronforge.io/config/hooks)).
6. CI invokes only repository scripts, never raw `electron-forge make`, and fails if the packaged asset manifest does not correspond to the current sources/lockfile.

Do not adopt `electron-vite` or another all-in-one wrapper in v1. It may be capable, but it would replace one experimental integration dependency with a third-party build abstraction when the direct Vite API and Forge hooks are sufficient.

### 2.2 Packaged origin and CSP

The primary UI loads from a registered standard, secure `open-chords://app/` scheme. Electron explicitly recommends a custom protocol instead of `file://` because `file://` pages have unusual and broad local-file privileges. The scheme handler must map only manifest-declared renderer assets, reject traversal and normalization aliases, emit correct MIME types and a restrictive CSP, and never set `bypassCSP` ([Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [Electron `protocol`](https://www.electronjs.org/docs/latest/api/protocol/)).

The primary renderer CSP starts from:

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'none';
media-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none'
```

Opaque thumbnail/media capabilities use separately allowlisted custom schemes only where required. YouTube runs in the already-specified dedicated sandboxed Player Surface, not by broadening the primary renderer CSP. No production bundle may require `unsafe-eval`, inline script, remote JavaScript, a general `connect-src`, or Node integration.

`contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false` are invariant. Preload exposes named methods, not `ipcRenderer`, and main validates every sender frame and payload. Electron's own IPC guidance warns against exposing the raw invoke/listener APIs ([Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)).

## 3. State ownership

### 3.1 One owner for each kind of state

| State | Authority | Renderer representation | Mutation path |
|---|---|---|---|
| Project, Source, revisions, Edit Layer, selected lyrics/alignment | Electron main / Project Library | Immutable versioned snapshot in a project store | Named domain command with `expectedProjectRevisionId`; main validates and publishes atomically |
| Analysis/acquisition/model/export jobs | Electron main | Immutable job snapshots plus sequenced events | Named job commands; event gap causes snapshot refresh |
| Effective Timeline | Pure domain projection from explicit Active View inputs; main publication is authoritative | Read-only projection cache keyed by revision/view identities | Change inputs through named commands; never mutate the projection |
| Current editor draft | Renderer for the open editing session only | `useReducer` state keyed by stable entity IDs and based on one committed revision | Local draft actions; Save submits one validated transaction; Cancel discards draft |
| Durable undo/redo and reset | Electron main / Edit Layer | Command availability in snapshot | Named undo/redo/reset command, never array rollback in the renderer |
| Selection, focus target, expanded accordion, open menu/dialog | Renderer | Local React state colocated with the owning component | UI events only; not persisted as Project history |
| Loop, speed, transpose, Beginner View, metronome, count-in | Main-owned practice/presentation session when persistence or playback depends on it | Small subscribed selectors; optimistic visual feedback only where command is reversible | Named practice command; fixed loop identity stays independent of transient selection |
| Playback media state and clock | Main-owned playback adapter / isolated Player Surface | External `PlaybackClockStore`; coarse semantic selectors | Typed playback commands and a dedicated sequenced clock channel |

The project store exposes stable `subscribe()` and `getSnapshot()` functions and uses React's `useSyncExternalStore`. Each committed update replaces the immutable snapshot; unchanged slices retain referential identity. Components subscribe through narrow selectors rather than consuming one giant context.

Do not introduce Redux/Zustand as another owner of canonical project data. A small custom external store is justified because the source is already external IPC, not because the app needs a client database. Do not introduce TanStack Query: IPC snapshots have monotonic sequences, revision conflicts, subscriptions, and explicit refresh semantics rather than HTTP cache freshness. A query cache would duplicate policy and invite “latest response wins” behavior that the domain model forbids.

### 3.2 Draft isolation

The accepted prototype proved the key rule: an invalid or unsaved chord draft does not alter the timeline or lyrics, Cancel restores the last valid committed state, and Save publishes atomically. Production keeps that rule but scopes a draft to:

```text
projectId + baseProjectRevisionId + analysisRevisionId + target entity IDs
```

Changing project/revision or closing a dirty editor triggers the explicit discard/save flow selected in product behavior. Draft validation may derive duration conflicts and preview values locally, but downstream workspace views always read the committed snapshot. Main repeats schema and domain validation before accepting the transaction.

## 4. Runtime contracts and IPC

Put wire contracts in a dependency-light `@open-chords/contracts` package. Each request, response, event, snapshot envelope, and error is a discriminated Zod 4 schema with:

- protocol/schema version;
- request or subscription ID;
- project/session identity where applicable;
- monotonic event sequence;
- expected Project revision for mutation;
- bounded strings/arrays and finite integer sample positions;
- strict unknown-key rejection for core messages;
- stable redacted error codes, not arbitrary stack traces.

Zod parses untrusted input and infers the corresponding TypeScript output type; `z.strictObject()` rejects unknown properties ([Zod basics](https://zod.dev/basics), [Zod objects](https://zod.dev/api#objects)). Generate JSON Schema and fixture corpora for protocol documentation and cross-language tests, but keep domain invariants—coverage, stable IDs, half-open intervals, bar/meter rules—in explicit domain validators rather than pretending structural schemas prove them.

Validation occurs:

1. locally in the renderer for immediate draft/form feedback, without treating that result as authorization;
2. in preload before a renderer method call is sent over IPC;
3. in main on every renderer command, regardless of earlier validation;
4. in preload on main responses/events before notifying renderer subscribers;
5. in main at persistence/import/sidecar boundaries under their own schemas.

The renderer imports contract types with `import type`; it does not need the full validator in its normal production chunk. Preload wraps event callbacks so Electron event objects never cross the bridge. Main accepts only the exact top-level `open-chords://app` sender, as Electron's security guidance requires ([Electron sender validation](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)).

## 5. UI primitives, styling, icons, and localization

### 5.1 Accessible primitives

Use Radix Primitives for Dialog/AlertDialog, DropdownMenu, ContextMenu where justified, Popover, Tooltip, Tabs, Select, and ToggleGroup. Radix implements keyboard navigation and common focus management according to WAI-ARIA patterns, but the application still owns labels, descriptions, focus destination after domain mutations, reduced-motion styling, target size, error association, and platform AT verification ([Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility), [composition](https://www.radix-ui.com/primitives/docs/guides/composition)). Custom trigger components must forward refs and spread all Radix props.

Do not use Radix to force the Musical Timeline into a menu, listbox, or slider role. Its domain-specific keyboard model is designed and tested against the separate workspace accessibility contract.

React Aria Components is the strongest alternative: it supplies accessible, internationalized components and collection/DnD behavior ([React Aria Components](https://react-aria.adobe.com/), [drag and drop](https://react-aria.adobe.com/dnd)). It is not selected because Open Chords needs only a modest set of ordinary primitives while its timeline and chord editor have custom domain semantics; adopting both React Aria and Radix would duplicate focus/collection abstractions. Reopen the choice only if an accessibility prototype demonstrates a concrete Radix gap.

### 5.2 Styling and tokens

Use:

- one global reset/base stylesheet;
- CSS cascade layers for reset, tokens, primitives, components, utilities, and accessibility overrides;
- CSS custom properties for semantic color, typography, space, radius, elevation, motion, timeline geometry, focus, confidence, selection, loop, error, and high-contrast fallbacks;
- CSS Modules for component styles;
- system UI fonts in v1 unless a redistributable bundled font is explicitly selected and added to release notices;
- `prefers-reduced-motion` and `forced-colors` as first-class token modes.

This keeps style output static, CSP-friendly, inspectable, and independent from React execution. Tailwind and runtime CSS-in-JS are rejected for the baseline: neither is required to express the accepted restrained visual system, and runtime injection complicates CSP. Tailwind can be reconsidered only with a concrete design-system build benefit; it is not a shortcut to the desired Linear-like hierarchy.

Lucide React remains the icon set. Its ESM named imports are tree-shakable ([Lucide React](https://lucide.dev/guide/packages/lucide-react)). Decorative icons receive `aria-hidden="true"`; icon-only buttons get a visible tooltip and an independent accessible name on the button. Do not dynamically import icons by string or make the SVG the control name.

### 5.3 Localization

Use i18next + react-i18next with bundled `en` and `ru` resources, typed selector keys, namespaces by product area, `fallbackLng: 'en'`, and no runtime network backend. i18next supports resource namespaces, plurals, `Intl` formatting, and typed selectors ([i18next configuration](https://www.i18next.com/overview/configuration-options), [TypeScript](https://www.i18next.com/overview/typescript), [react-i18next](https://react.i18next.com/)).

UI text, labels, shortcuts, validation, and announcements are translation keys. Musical symbols, user lyrics, provider metadata, and filenames are domain/user content and are not translated. Set the document `lang` to the UI locale and mark lyric language when known. Tests cover EN/RU expansion, plural categories, long labels, and mixed-language lyrics.

## 6. Timeline and lyrics rendering

### 6.1 Visual geometry

Keep the timeline as semantic DOM, not canvas/WebGL:

- one native horizontal scroll container owns `scrollLeft`;
- the playhead is a fixed overlay at 50% of the viewport;
- leading and trailing half-viewport spacers allow the start and end to align under it;
- bar/event positions are deterministic functions of canonical Project Time and zoom;
- beat lines are decoration behind equal-height chord events;
- event width represents duration; label layout never changes geometry;
- a short event exposes its full chord on hover, focus, selection, and in the inspector without widening the event;
- selection and the persisted loop render as separate states and remain separate in the model.

During playback, `requestAnimationFrame` reads the external clock and writes `scrollLeft` or a compositor-safe track transform/CSS variable imperatively. React is notified only when a semantic selector changes—current chord, bar, lyric line/word, transport state, or an accessibility-relevant value at a deliberately bounded rate. This preserves a centered playhead without a workspace-wide React render every frame.

Dragging the fixed playhead maps pointer movement directly to scroll range and uses Pointer Events with pointer capture. Range selection uses the same event family plus edge autoscroll. Both have keyboard commands and explicit controls; neither is implemented with a sortable-list library.

Reduced Motion disables smooth scrolling and animated interpolation but not position changes. Playback ticks do not enter an assertive live region. Current musical position is available on demand as elapsed time plus section/bar/beat text.

### 6.2 Virtualization

Typical songs should render without virtualization until profiling demonstrates a long-project threshold. Premature virtualization complicates browser find, focus retention, measurement, screenshots, and screen-reader traversal.

When the profiled DOM/layout budget is exceeded, use TanStack Virtual for horizontal bar windows and vertical lyric-line windows. It supports horizontal mode, dynamic measurement, overscan, and `scrollToIndex` ([TanStack Virtual React docs](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual), [Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)). Required constraints:

- stable entity IDs, not indexes, remain identity;
- the current, focused, selected, loop-edge, and drag-adjacent items remain mounted with sufficient overscan;
- focus is moved intentionally before an item can unmount;
- total geometry comes from the timeline model, not measured label width;
- the accessible sequential event/review surface and inspector remain usable when visual items outside the viewport are absent;
- autoscroll and `scrollToIndex` use `behavior: 'auto'` under Reduced Motion.

Lyrics scroll independently in the remaining workspace height. Autoscroll occurs at line changes and centers the current line unless the user has manually scrolled; manual scroll suspends autoscroll until an explicit “follow playback” action or a defined resume rule. Word highlighting can update at word boundaries without re-rendering unrelated lines. Instrumental sections render section identity plus timed chords and no fake lyric text.

## 7. Pointer, keyboard, and drag-and-drop

Use Atlassian Pragmatic Drag and Drop for reordering chord events **inside the editor's event list only**. It is current, framework-independent, supports before/after placement and drop indicators, and ships separate accessibility/live-region helpers ([Pragmatic DnD repository](https://github.com/atlassian/pragmatic-drag-and-drop), [accessibility guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines), [drag-and-drop design guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines/)).

The library is justified there because the accepted prototype exposed real insertion-slot, pointer-capture, edge, cancellation, and visual-indicator bugs. It is not allowed to own the domain reorder: drop resolves a proposed stable-ID command, the draft reducer validates the resulting order/durations, and Save still publishes atomically.

Every reorder also has:

- focusable Move before / Move after commands (visible in the focused item's action menu or inspector);
- documented keyboard bindings scoped to the list;
- localized screen-reader instructions and outcome announcements;
- visible insertion indicator above all cards;
- Escape cancellation and focus restoration;
- tests for first-to-last, last-to-first, cancellation, scroll, zoom, and more events than fit.

Do not use the legacy stable `@dnd-kit/core`/`sortable` line: its stable packages were last published in 2024 while the active replacement package family is pre-1.0, creating an avoidable migration seam. Do not use HTML Drag and Drop directly: the application would have to rebuild keyboard, announcements, drop targets, and cross-input behavior. Do not use a DnD library for timeline scrub, range selection, boundary nudge, or resize; those are constrained musical editing operations with direct Pointer Events plus explicit keyboard alternatives.

## 8. Playback adapters and high-frequency updates

Retain the accepted main-owned playback boundary:

```text
local media adapter or isolated YouTube Player Surface
              │ typed commands + sequenced events
              ▼
        Electron main playback session
              │ snapshots + dedicated clock port
              ▼
      preload PlaybackClockStore
         ├─ rAF imperative visual position
         └─ coarse React semantic selectors
```

Commands are play, pause, seek, rate, loop, volume/mute if exposed, and adapter capability query. Events distinguish buffering, ready, playing, paused, ended, blocked autoplay, unavailable/non-embeddable, network failure, and adapter loss. The renderer never assumes YouTube supports an arbitrary playback rate; it renders adapter-reported capabilities.

Ordinary commands and snapshots use named IPC. If measurement shows request/event IPC cannot carry the clock cleanly, establish one validated `MessagePort` during preload setup. Electron documents transferable MessagePorts between renderer and main; main receives a `MessagePortMain` and must explicitly start it ([Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports)). The port carries only bounded clock frames with session ID, sequence, media time, monotonic observation time, playback rate, and state—no generic RPC.

Clock reconciliation uses the latest observation plus a monotonic local clock while playing, then snaps on seek/discontinuity according to a tested tolerance. The adapter remains truth; the renderer's extrapolation is presentation only. Loop restart begins at the persisted loop start regardless of the prior playhead, matching the accepted interaction.

## 9. Test and release-proof stack

| Layer | Tool | Required evidence |
|---|---|---|
| Pure domain/projection | Vitest in Node | Time conversion, interval/coverage invariants, derived Effective Timeline, transpose/Beginner transforms, selectors, commands |
| Contract | Vitest | Every Zod request/response/event; invalid, oversized, unknown-key, stale-revision, sequence-gap, and compatibility fixtures |
| Reducer/component | Vitest Browser Mode with Playwright provider and React renderer helpers | Draft isolation, save/cancel, focus, dialog/menu, chord picker, keyboard reorder, range commands; real layout for pointer/scroll tests |
| Renderer integration | Playwright against the built renderer harness | Centered playhead, zoom, edge autoscroll, long lyrics, instrumental sections, Reduced Motion, forced colors, EN/RU, error/progress states |
| Accessibility automation | axe-core in browser and packaged journeys | Named controls, roles/states, landmark structure, obvious contrast/ARIA failures; violations are blockers unless explicitly inapplicable |
| Packaged Electron | Playwright `_electron` using the built executable on native runners | `app.isPackaged`, custom protocol/CSP, no dev server, preload API, project fixture, local/YouTube adapter states, persistence, restart, screenshots |
| Native accessibility | Manual release matrix | VoiceOver + Accessibility Inspector on macOS; Narrator + Accessibility Insights/UIA on Windows; keyboard-only complete process |
| Visual | Playwright screenshots | Fixed viewport/DPI/font/locale/time, animations disabled, per-OS baselines for critical workspace/error/empty/long-content states |

Vitest Browser Mode runs tests in a real browser through the matching official Playwright provider. Use the React helper linked by Vitest's official component-testing guide, but keep its use behind project test utilities because it is published under the `vitest-community` organization rather than the core package. Use Node-mode tests for pure logic and browser mode only where browser behavior matters ([Vitest Browser Mode](https://vitest.dev/guide/browser/), [Vitest component testing](https://main.vitest.dev/guide/browser/component-testing), [React helper API](https://main.vitest.dev/api/browser/react)).

Electron does not maintain its own E2E solution. Its official guide documents both WebdriverIO and Playwright and labels Playwright's Electron support experimental ([Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing)). Playwright is selected to avoid two E2E/visual stacks, and its `electron.launch({ executablePath })` API can launch a specified executable and expose renderer windows ([Playwright Electron API](https://playwright.dev/docs/api/class-electron)). This remains a release risk: before implementation planning treats it as final, prove one packaged macOS arm64 and Windows x64 smoke in CI. If packaged launch/main-process control is unreliable, replace only the packaged harness with the Electron-documented WebdriverIO Electron service; keep Playwright for renderer and visual tests.

Screenshot tests disable animations and use deterministic project fixtures. They do not snapshot every component. Native screen-reader and platform-tree tests remain mandatory because DOM/axe output does not prove Electron's macOS/Windows accessibility bridges.

## 10. Bundle, native, license, and maintenance risk

- The selected renderer libraries are JavaScript/CSS only; they add no native Node module or rebuild step. Electron and the separately specified sidecar remain the native/runtime risks.
- Registry `dist.unpackedSize` is not a renderer-bundle measurement. Named ESM imports and route-free static output permit tree shaking, but the real minified/gzip/brotli chunks and startup parse/execute time must be measured from the representative workspace.
- Keep Zod runtime primarily in main/preload and use type-only renderer imports. Load only used Radix primitives and named Lucide icons. Do not ship Playwright, Vitest, axe, source maps, test fixtures, or dev servers.
- React, Vite, Electron/Forge, Zod, Radix, TanStack Virtual, i18next, and Vitest show current first-party releases on the check date. Pragmatic DnD was also published in August 2026. The selected dependency set avoids the older dnd-kit stable-line/active-rewrite split.
- Runtime licenses are MIT, Apache-2.0, or ISC; axe-core is MPL-2.0 and development-only. Generate an SBOM and third-party notices from the exact lockfile and preserve all required notices. This inventory is engineering evidence, not a substitute for release license review.
- Use exact dependency versions in a committed lockfile. Automated PRs may propose patches, but no production dependency auto-updates itself. Electron security updates get priority and always run packaged protocol, IPC, playback, accessibility, and screenshot smoke tests.

Initial budgets to establish during the representative implementation spike, before feature growth:

1. renderer JS/CSS compressed size and chunk count;
2. cold app-to-interactive and project-to-interactive time;
3. idle memory, long-project memory, and DOM node count;
4. 60 Hz playback scroll frame time and dropped-frame percentile;
5. React commit count/time during 60 seconds of playback;
6. seek, zoom, selection-edge autoscroll, lyrics follow, and reorder latency;
7. accessibility-tree node count and VoiceOver/Narrator responsiveness.

The release gate should compare these to a frozen representative baseline, not adopt arbitrary numbers in this research ticket.

## 11. Rejected alternatives

| Alternative | Why not v1 |
|---|---|
| Forge Vite plugin | Officially experimental; minor releases may break the integration. Direct Vite builds plus stable Forge hooks are sufficient. |
| `electron-vite` | Adds a third-party release-critical build abstraction without a capability missing from Vite's API and Forge packaging. |
| Next.js / Remix / SSR / local HTTP UI server | No SEO/server rendering/server route requirement; adds origin, lifecycle, and dependency surface. |
| Vue / Svelte / Solid migration | No evidence that React is the bottleneck; discards accepted React prototype knowledge. |
| Redux / Zustand canonical store | Duplicates main authority and makes stale-revision/event-order behavior easier to violate. |
| TanStack Query for IPC | HTTP freshness/cache semantics do not match sequenced revision snapshots and explicit refresh. |
| Canvas/WebGL-only timeline | Hides bars/events/actions from normal DOM and accessibility semantics; labels/focus/hit testing become parallel reimplementations. |
| Always-on virtualization | Typical songs do not justify the focus/find/AT complexity; activate only after measured threshold. |
| Radix plus React Aria together | Two overlapping focus/composite abstractions; choose one baseline and spike the alternative only for a demonstrated gap. |
| Tailwind or runtime CSS-in-JS | No required capability; CSS Modules/tokens are static, CSP-friendly, and sufficient for the accepted visual direction. |
| Stable dnd-kit packages | Stable packages are old while active replacement APIs are pre-1.0; avoid a known migration seam. |
| Hand-built DnD or native HTML DnD | Repeats the prototype's insertion/cancellation/accessibility bugs and requires custom cross-input behavior. |
| DnD library for timeline scrub/range/resize | Wrong interaction abstraction; musical constraints require Pointer Events plus equivalent keyboard commands. |
| React state update on every clock frame | Forces broad reconciliation and couples media frequency to workspace rendering. |
| Remote fonts, remote scripts, runtime translation fetch | Violates self-contained/offline/CSP expectations and adds mutable dependencies. |

## 12. Implementation constraints and residual proofs

Issue #24 may turn this result into an implementation plan only after assigning explicit work for these proofs:

1. **Build spike:** direct Vite dev/build plus Forge package/make on macOS arm64 and Windows x64; prove ASAR paths, custom protocol, CSP, sourcemap exclusion, and no Forge Vite plugin.
2. **Contract spike:** one request, mutation conflict, subscription gap/refresh, and MessagePort clock fixture through real preload/main with Zod rejection tests.
3. **Playback spike:** local media and YouTube adapters through the same session contract; prove start/seek/rate/loop/discontinuity and the user-accepted centered-playhead behavior.
4. **Performance spike:** representative long project, not the six-bar prototype; measure bundle, startup, DOM, React commits, frame time, memory, and determine the virtualization threshold.
5. **Accessibility spike:** Radix dialog/menu/tooltip plus custom timeline/event list; keyboard-only, 200% text, 400% zoom, forced colors, Reduced Motion, VoiceOver, and Narrator.
6. **DnD spike:** Pragmatic DnD first↔last reorder with scroll, cancellation, visible insertion indicator, focus retention, keyboard commands, and localized announcements.
7. **Packaged test spike:** prove Playwright can launch and drive the actual unsigned packaged artifacts on both official OS targets; otherwise substitute WebdriverIO only for this layer.
8. **Dependency proof:** exact lockfile, production bundle report, SBOM/notices, vulnerability policy, and Electron upgrade rehearsal.

The plan should keep these as red-to-green architecture seams rather than a final hardening phase.

## Source index

### Context7-checked central libraries

- [React](https://react.dev/) — external stores and effects.
- [Electron](https://www.electronjs.org/docs/latest/) — security, protocols, IPC, MessagePorts, testing, releases.
- [Electron Forge](https://www.electronforge.io/) — Vite plugin status and lifecycle hooks.
- [Vite 8](https://vite.dev/) — programmatic/static production builds and relative base.
- [TypeScript](https://www.typescriptlang.org/docs/) — strictness and project references.
- [Zod 4](https://zod.dev/) — runtime parsing, strict objects, inferred types, JSON Schema.
- [Radix Primitives](https://www.radix-ui.com/primitives) — accessible headless components and composition.
- [TanStack Virtual](https://tanstack.com/virtual/latest) — horizontal/vertical virtualization.
- [Pragmatic Drag and Drop](https://atlassian.design/components/pragmatic-drag-and-drop/) — list hitboxes, indicators, and accessibility.
- [dnd-kit](https://github.com/clauderic/dnd-kit) — compared but rejected due stable/rewrite split.
- [React Aria](https://react-aria.adobe.com/) — compared accessible primitive/collection alternative.
- [i18next](https://www.i18next.com/) and [react-i18next](https://react.i18next.com/) — typed bundled localization.
- [Vitest](https://vitest.dev/) — Node and browser-mode testing.
- [Playwright](https://playwright.dev/docs/api/class-electron) — Electron launch and screenshots.
- [Lucide](https://lucide.dev/) — React ESM icons and accessibility behavior.

### Existing Open Chords evidence consumed

- [v1 specification](../specification/open-chords-v1.md)
- [desktop and sidecar stack](desktop-sidecar-stack.md)
- [workspace accessibility](workspace-accessibility.md)
- [accepted workspace prototype at `ebb82bb`](https://github.com/qisoft/open-chords/tree/ebb82bbc242c6a10be07bedcadae3357d3d5046f/prototypes/workspace-ux)
- [`CONTEXT.md`](../../CONTEXT.md)

## Fact versus recommendation

Version/license metadata, Forge's experimental plugin status, Electron's security/testing/support policy, and the documented library APIs are sourced facts. The ownership table, direct-build seam, selected primitives/DnD library, conditional virtualization, clock isolation, test layering, and rejection of additional state/full-stack frameworks are Open Chords recommendations derived from the accepted product and trust model. They remain unproved until the residual packaged, performance, accessibility, and playback spikes above pass.
