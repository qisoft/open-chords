# Open Chords v1 implementation plan

Status: **ready for execution**  
Date: 2026-08-17  
Normative product/technical input: [Open Chords v1 specification](../specification/open-chords-v1.md)  
GitHub tracker: [Implement Open Chords v1](https://github.com/qisoft/open-chords/issues/25)  
Milestone: [Open Chords v1](https://github.com/qisoft/open-chords/milestone/1)

## 1. Purpose and authority

This plan turns the validated v1 specification into executable work. It does not reopen product decisions and it does not claim that implementation, packaging, benchmarking, or release evidence already exists.

GitHub native relationships are authoritative:

- sub-issues define ownership under the root tracker and five phase exit gates;
- blockers define readiness and permit safe parallel work across phases;
- issue acceptance gates define completion of one work item;
- a phase closes only after every child and its phase exit gate are evidenced;
- the release candidate closes only after the sealed benchmark and installed-artifact gates pass.

Phase numbering groups coherent vertical slices. It is not a calendar estimate or a rule that every issue in one phase must finish before any work in another phase starts.

## 2. Implementation principles

### 2.1 Vertical slices before breadth

The first slice is deliberately local-file-only:

`local file → verified Source → durable Project → local playback → committed fixture timeline`

The second slice replaces the fixture through the real analysis path:

`Project → Analysis Job → contained sidecar → canonical decode/DSP → main validation → Analysis Revision → Effective Timeline`

Editing, lyrics, YouTube, exports, packaging, and release evidence extend those proven seams. No phase creates a parallel authority or bypasses an earlier security/persistence seam.

### 2.2 Deep modules and seams

Each module must hide substantial policy behind a small interface. Tests exercise the same interface as production callers. Internal seams stay private unless a real production and test adapter both exist.

| Module | Interface responsibility | Complexity hidden behind it | Primary test adapter |
|---|---|---|---|
| Domain kernel | Validate and materialize canonical Project/Timeline operations | sample-frame time, ordering, invariants, revisions, edit projection, confidence, lyrics mapping, export semantics | pure fixture/property tests |
| Contract codec | Parse named IPC/sidecar messages and bounded results | Zod schemas, protocol versions, limits, JSON Schema generation, redacted errors | valid/hostile fixture corpus shared with Python |
| Project Library | Read snapshots, transact one durable mutation, subscribe to committed changes | staging, fsync, Head replacement, Trash, migration, recovery, content addressing | fault-injected temporary local Library |
| Desktop command gateway | Execute named renderer intents and publish sequenced snapshots/events | sender authority, generation, stale revision, queue/backpressure, capability lookup | sandboxed renderer/preload integration harness |
| Media module | Select/import/relink/play one verified Source or Project Range | opaque capabilities, full fingerprinting, TOCTOU checks, byte ranges, cache fallback | hostile filesystem/media fixtures |
| Job orchestrator | Submit, cancel, observe, retry, and recover typed jobs | Effect runtime, durable queue, deadlines, attempts, checkpoints, process cleanup | fake clock/process/sidecar/network adapters |
| Sidecar client | Run one manifest-verified analysis session | framed protocol, handshake, heartbeat, file descriptors, cancellation escalation | deterministic fake sidecar plus packaged real adapter |
| Analysis sidecar | Produce a candidate analysis bundle from staged inputs | FFmpeg, features, DSP decoders, evidence, deterministic manifests | corpus fixtures through the same private protocol |
| Playback module | Normalize local and YouTube transport semantics | source-specific player state, timing, errors, rate/seek behavior | local fixture and fake YouTube adapter |
| Workspace renderer | Render committed snapshots and hold one isolated draft | external playback clock, timeline geometry, lyrics follow, focus, Base UI, Zustand draft | Vitest Browser and Playwright |
| Export module | Export one immutable Active View under one profile | canonical JSON, projections, loss reports, atomic targets, receipts, archive validation | golden outputs and hostile archive corpus |
| Benchmark harness | Evaluate exact artifacts under a frozen policy | corpus rights/roles, metrics, calibration, uncertainty, native resource runs, sealed verdict | calibration corpus and synthetic canaries |

Do not create a package for every row by default. A seam can be a deep internal module. Promote it to a workspace package only when it has more than one legitimate caller/runtime or needs an independently enforced dependency graph.

### 2.3 Initial repository shape

```text
apps/
  desktop/
    src/main/       Electron authority and deep main-owned modules
    src/preload/    narrow generated capability facade
    src/renderer/   React workspace and scoped Editor Draft
packages/
  domain/           pure canonical model, invariants, projections
  contracts/        Zod wire contracts and generated JSON Schema
  testkit/          cross-runtime fixtures and hostile inputs
sidecar/
  open_chords_analysis/  frozen Python analysis implementation
tools/
  benchmark/        corpus, metrics, calibration and release verdict tooling
docs/
  specification/
  planning/
  research/
```

This is a starting dependency shape, not permission to expose internal modules through public package interfaces.

### 2.4 State ownership

| State | Owner | Renderer representation |
|---|---|---|
| Project, revisions, Edit Layer, lyrics/alignment, receipts | Electron main / Project Library | immutable committed snapshot |
| Durable jobs, attempts, checkpoints, downloads and exports | Electron main / Job orchestrator | sequenced snapshot/events |
| Effective Timeline | deterministic domain projection | read-only committed projection |
| Current unsaved editor work | one scoped Zustand vanilla store | Editor Draft only |
| Frame-level playback position | playback adapter/external clock | imperative requestAnimationFrame position |
| Selection, focus, open popover/accordion | renderer | local ephemeral UI state |

No client cache, Effect value, sidecar result, remote player event, or invalid draft becomes canonical state without main-owned validation and atomic publication.

## 3. Phase and task graph

### Phase 1 — Foundation and local-project walking skeleton

Tracking: [Phase 1 — Foundation and local-project walking skeleton](https://github.com/qisoft/open-chords/issues/26)

| Task | Native blockers |
|---|---|
| [Bootstrap the pnpm, Electron, Vite, and CI foundation](https://github.com/qisoft/open-chords/issues/31) | none — initial frontier |
| [Implement the canonical domain kernel and contract fixtures](https://github.com/qisoft/open-chords/issues/35) | Bootstrap foundation |
| [Build the hardened Electron shell and typed IPC seam](https://github.com/qisoft/open-chords/issues/52) | Bootstrap foundation; domain/contracts |
| [Implement the Project Library, revisions, and migration core](https://github.com/qisoft/open-chords/issues/39) | domain/contracts |
| [Implement local media capabilities, ingestion, and playback](https://github.com/qisoft/open-chords/issues/32) | Electron shell/IPC; Project Library |
| [Deliver the read-only local-project workspace slice](https://github.com/qisoft/open-chords/issues/33) | domain/contracts; Electron shell/IPC; local media |

Exit evidence: an installed-capable application creates and reopens a durable Project from a verified local file, plays it, and renders a deterministic semantic timeline fixture through production seams.

### Phase 2 — Analysis execution and containment

Tracking: [Phase 2 — Analysis execution and containment](https://github.com/qisoft/open-chords/issues/27)

| Task | Native blockers |
|---|---|
| [Prove the main-sidecar protocol and Effect lifecycle vertical slice](https://github.com/qisoft/open-chords/issues/50) | domain/contracts; Electron shell/IPC |
| [Build the frozen analysis sidecar and canonical FFmpeg decode](https://github.com/qisoft/open-chords/issues/34) | lifecycle proof; local media |
| [Implement Analysis Jobs, attempts, checkpoints, and publication](https://github.com/qisoft/open-chords/issues/38) | Project Library; lifecycle proof |
| [Implement native sidecar containment and adversarial harnesses](https://github.com/qisoft/open-chords/issues/49) | lifecycle proof; frozen sidecar |
| [Implement CPU-first rhythm, key, chord, and section analysis](https://github.com/qisoft/open-chords/issues/53) | frozen sidecar; Analysis Jobs |
| [Publish the first benchmarkable local-file Analysis Revision](https://github.com/qisoft/open-chords/issues/54) | Analysis Jobs; containment; DSP; read-only workspace |

Exit evidence: a verified local file produces one immutable benchmarkable Analysis Revision on macOS arm64 and Windows x64, while cancel, timeout, crash, invalid output, and containment failure publish nothing and leave no surviving process domain.

### Phase 3 — Editor, practice, and lyrics

Tracking: [Phase 3 — Editor, practice, and lyrics](https://github.com/qisoft/open-chords/issues/28)

| Task | Native blockers |
|---|---|
| [Implement the semantic timeline, lyrics viewport, and playback clock](https://github.com/qisoft/open-chords/issues/55) | read-only workspace |
| [Implement scoped Zustand Editor Drafts and atomic Edit Transactions](https://github.com/qisoft/open-chords/issues/44) | Project Library; semantic timeline |
| [Implement practice transport, loops, transpose, and diagrams](https://github.com/qisoft/open-chords/issues/43) | semantic timeline; Editor Draft |
| [Implement lyrics discovery and immutable Lyrics Documents](https://github.com/qisoft/open-chords/issues/56) | Electron shell/IPC; Project Library |
| [Implement the Model Store and MFA language-pack lifecycle](https://github.com/qisoft/open-chords/issues/57) | Project Library; lifecycle proof |
| [Implement Alignment Jobs and lyric timing correction](https://github.com/qisoft/open-chords/issues/58) | benchmarkable Revision; Editor Draft; Lyrics Documents; Model Store |
| [Pass the workspace accessibility and performance gate](https://github.com/qisoft/open-chords/issues/48) | timeline; editor; practice; alignment |

Exit evidence: the accepted nondestructive workspace, practice behavior, optional lyrics flow, and EN/RU alignment/correction path pass browser accessibility and performance gates without leaking invalid drafts into committed views.

### Phase 4 — YouTube and export portability

Tracking: [Phase 4 — YouTube and export portability](https://github.com/qisoft/open-chords/issues/29)

| Task | Native blockers |
|---|---|
| [Implement YouTube metadata and the isolated player surface](https://github.com/qisoft/open-chords/issues/59) | Electron shell/IPC; read-only workspace |
| [Prove brokered credential-free YouTube acquisition](https://github.com/qisoft/open-chords/issues/60) | containment; YouTube player; local media |
| [Implement Open Chords JSON and Export Receipts](https://github.com/qisoft/open-chords/issues/41) | Project Library; Editor Draft; Lyrics Documents |
| [Implement ChordPro, LRC, and accessible PDF/print exports](https://github.com/qisoft/open-chords/issues/36) | canonical JSON/receipts; alignment; workspace accessibility |
| [Implement Portable Project Archive import and export](https://github.com/qisoft/open-chords/issues/61) | Project Library; JSON/receipts; benchmarkable Revision; alignment |
| [Pass packaged YouTube and export journeys](https://github.com/qisoft/open-chords/issues/40) | player; acquisition; compatibility exports; archive |

Exit evidence: YouTube metadata/playback is independent from best-effort acquisition; local-file fallback remains guaranteed; every required export is deterministic and loss-aware; hostile archives cannot mutate the Library before complete validation.

### Phase 5 — Packaging, benchmark, and release

Tracking: [Phase 5 — Packaging, benchmark, and release](https://github.com/qisoft/open-chords/issues/30)

| Task | Native blockers |
|---|---|
| [Assemble unsigned self-contained macOS and Windows packages](https://github.com/qisoft/open-chords/issues/46) | containment; benchmarkable Revision; workspace gate; packaged YouTube/export journeys |
| [Implement model, update, uninstall, and recovery release flows](https://github.com/qisoft/open-chords/issues/51) | Model Store; packages; Project Library |
| [Build the Benchmark Corpus ledger and Gold Reference workflow](https://github.com/qisoft/open-chords/issues/47) | domain/contracts — may start before later phases finish |
| [Implement benchmark metrics, calibration, and sealed release gates](https://github.com/qisoft/open-chords/issues/42) | benchmarkable Revision; alignment; corpus workflow |
| [Pass the packaged security, accessibility, and native release matrix](https://github.com/qisoft/open-chords/issues/45) | packages; release flows; benchmark gates; packaged journeys |
| [Produce the Open Chords v1 release-candidate evidence](https://github.com/qisoft/open-chords/issues/37) | packaged native release matrix |

Exit evidence: reproducible unsigned community artifacts pass installed security/accessibility/determinism/resource/recovery gates, and the sealed benchmark publishes only the automatic Support Claims justified by evidence.

## 4. Critical path and parallel lanes

The initial executable frontier contains only [Bootstrap the pnpm, Electron, Vite, and CI foundation](https://github.com/qisoft/open-chords/issues/31). After it closes:

1. domain/contracts becomes the central dependency;
2. Project Library and Electron shell can advance partly in parallel;
3. the local-project walking skeleton unlocks both the timeline and analysis paths;
4. corpus rights/annotation work starts as soon as domain fixtures exist and then runs in parallel with product implementation;
5. lyrics discovery and Model Store work can begin before automatic analysis is complete;
6. export JSON can begin before YouTube acquisition and compatibility export work;
7. packaging assembly waits for the real containment, analysis, workspace, and I/O surfaces;
8. release claims wait for the sealed native matrix, never merely for feature completion.

The longest technical path is expected to be:

`foundation → domain/contracts → Electron/local media → sidecar lifecycle/decode → containment + jobs + DSP → benchmarkable Revision → alignment/workspace gate → packaged I/O → native packages → sealed benchmark/native matrix → release evidence`

This is a dependency hypothesis, not a time estimate. Issue lead time and benchmark evidence should update the critical-path view without changing the specification silently.

## 5. Test and CI strategy

### Pull requests

Every implementation PR must:

- reference exactly one primary implementation issue;
- start with a failing test or fixture at the relevant module interface;
- preserve or add hostile/error-path coverage where the seam handles untrusted input;
- run frozen pnpm install, Oxfmt check, Oxlint type-aware lint, strict TypeScript build, unit/contract tests, and applicable browser/native smoke tests;
- attach before/after evidence for accessibility, packaged, performance, containment, or deterministic-output gates;
- avoid weakening a gate to make the PR green.

### Test layers

| Layer | Purpose |
|---|---|
| Pure domain/property tests | timeline, revision, edit, lyrics, export and benchmark invariants |
| Contract corpus | identical valid/invalid IPC and sidecar behavior across TypeScript and Python |
| Fault-injected local integration | atomic Library, filesystem identity, cancellation, migration and recovery |
| Vitest Browser | Base UI, Zustand draft isolation, focus, keyboard and real layout/scroll behavior |
| Playwright renderer | complete workspace, timeline, lyrics, export and deterministic visual journeys |
| Packaged Electron | actual custom schemes, CSP, sidecar, native helpers, YouTube identity and OS behavior |
| Native adversarial | sandbox escapes, process trees, hostile archives/media, resource limits and cleanup |
| Native assistive technology | VoiceOver/Accessibility Inspector and Narrator/Accessibility Insights |
| Benchmark canary/sealed runs | PR regression signal versus release-authorizing evidence |

PR CI may use canaries and fixture media. It cannot authorize automatic Support Claims or replace sealed native runs.

## 6. Branching and tracker workflow

- Use one short-lived branch per executable issue, named `feature/<issue-number>-<slug>` unless a narrower repository convention is adopted in the foundation task.
- Assign an issue before work. Native blockers must be closed before implementation begins unless the issue explicitly produces a compatible parallel artifact.
- Child issues remain open until every acceptance checkbox has evidence in the PR, run, or artifact.
- Phase issues are exit gates and should not carry implementation commits directly.
- If implementation evidence contradicts the specification, stop the affected path and create an explicit decision issue. Do not bury a product/architecture change inside a code PR.
- Exact versions, hashes, generated schemas, fixtures, native manifests, benchmark policies, and release evidence are committed or linked from the owning issue.

## 7. Definition of v1 implementation complete

Open Chords v1 is implementation-complete only when:

- every child of [Implement Open Chords v1](https://github.com/qisoft/open-chords/issues/25) is closed with its evidence;
- official macOS 15+ Apple Silicon and Windows 11 x64 installed artifacts pass all required gates;
- local-file analysis, playback, editing, practice, optional lyrics, required exports, and recovery work offline after installation except for explicitly requested network functions;
- YouTube behavior remains within the credential-free best-effort contract and never weakens local-file guarantees;
- the sealed benchmark freezes numeric thresholds and produces the exact supported automatic capability/profile/platform matrix;
- checksums, SBOM, build provenance, attestations, notices, unsigned-install guidance, known limitations, and Support Claims are published together;
- no critical data-loss, security, containment, accessibility, determinism, migration, or privacy gate remains open.

Completion does not imply publisher signing/notarization, ownership of user content, a public catalog, or support for any platform/capability not named by the sealed evidence.
