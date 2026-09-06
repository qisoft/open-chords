# Editor Drafts and atomic Edit Transactions

Task: [Implement scoped Zustand Editor Drafts and atomic Edit Transactions](https://github.com/qisoft/open-chords/issues/44).

Authority: specification sections 9, 11.2, and 12; the implementation plan's Domain kernel, Desktop command gateway, Project Library, and Workspace renderer boundaries.

## Observed baseline

The workspace renders committed snapshots and contains no editor-session store. Zustand is already pinned. Chord Event reordering will require the specified Pragmatic Drag and Drop integration; it is restricted to the draft event list.

The desktop contract already exposes `project.commitEditTransaction` with an expected Project Revision. Main serializes mutations and rejects stale bases. The Project Library appends an Edit Transaction, advances the Active View history position, validates the complete Project, and publishes a new durable Project Head.

Domain transactions retain parent identities, and Effective Timeline materialization follows the selected history branch. The current renderer/preload contract has no commands for selecting durable undo/redo history, resetting the Edit Layer, or reviewing mappings to another Analysis Revision. The typed edit-operation schema has no stable-ID event reorder operation. These must be addressed through explicit validated operations, preserving original machine observations.

## Proposed test boundaries

1. Editor Draft public API: a vanilla Zustand session is keyed by Project, base Project Revision, Analysis Revision, and target identities. Public actions and snapshots expose chord edits, meter-relative durations, reorder, validation, Cancel, and draft Reset without altering committed data.
2. Main/Project Library mutation API: Save, history selection, durable Edit Layer reset, and explicit review mappings validate expected revision and identities, publish atomically, retain history branches, and recover through the ordinary Library snapshot interface. Invalid or stale requests leave the committed Head unchanged.
3. Existing Electron workspace boundary: real renderer/preload/main journeys exercise the picker, pointer/keyboard reorder, first/last positions, overflow, Escape, Save/Cancel/Reset, focus restoration, and project/revision changes. Committed timeline, lyrics, and playback continue to use the saved Active View while a draft is invalid or unsaved. Installed-artifact verification covers the final named command surface.

The renderer boundary was confirmed during the semantic-workspace task. The Draft API and durable editing operations were explicitly confirmed before their tests were written.

## Implementation sequence

1. Introduce the isolated Draft session and establish one red-to-green trace showing that changing or invalidating it leaves the committed Project untouched.
2. Build the constrained root/quality/optional-bass picker, including N, and meter-relative duration controls. Preserve exact sample-frame event identity and surface conflicts before Save.
3. Add stable-ID reorder semantics and the draft event rail with Pragmatic Drag and Drop, visible insertion targets, and Move before/after keyboard alternatives.
4. Complete atomic main-owned Save and durable history commands. Editing after undo retains the old branch. Draft Reset restores its committed base; the distinct durable reset selects an empty Edit Layer on the same Analysis Revision.
5. Implement explicit review mappings with unresolved conflicts retained. Project/base-revision changes invalidate the session rather than silently carrying unsaved state forward.
6. Verify complete renderer journeys, inspect the UI, run appropriate repository gates, and obtain macOS/Windows installed evidence before review readiness.

Each slice gets its own red-to-green test through an agreed public boundary. The original machine Analysis Revision remains recoverable throughout. Keep the issue open until its implementation PR merges.

## Implemented behavior

The workspace opens an isolated chord-event rail. Root, quality and optional bass choices, including N, stay in the picker until Done and in the Draft until Save. Duration choices use the current beat and actual bar capacity, including pickup and 3/4 bars. New boundaries must lie on quarter-beat subdivisions or existing committed event boundaries; invalid totals remain editable conflicts. Pointer insertion indicators and explicit Move before/after controls preserve stable IDs and restore keyboard focus. Event widths represent relative duration. Low-confidence chords have an explicit, reversible review action; choosing an abstained candidate records a user assertion even when its value is unchanged.

Main validates Save against both the expected Project Revision and the selected parent transaction. The named `project.changeEditHistory` capability shares the bounded mutation queue with Save. Undo/Redo select retained branches; durable Reset creates a new empty layer without deleting prior edits. Review mappings require explicit one-to-one entity choices and are revalidated by main. Unsupported structural/lyrics transfers and invalid target timing remain conflicts. Applying a reviewed mapping selects a separate target layer without carrying a lyrics alignment across analyses.

Committed revision changes invalidate the open Draft and mapping review. Resetting an invalidated Draft does not make its old base writable. The canonical committed Project, lyrics and playback remain outside Zustand.

## Verification boundaries

- Draft API: isolation, Reset, stale revisions, actual meter capacity, stable-ID reorder and off-grid timing conflicts.
- Project Library: atomic publication, selected-parent enforcement, branching Undo/Redo, durable Reset and explicit mapping conflicts through reopened snapshots.
- Electron renderer: Save/Cancel/Reset, external revision invalidation, mapping review, first/last keyboard and pointer reorder, visible insertion indicator, Escape, focus restoration and narrow-window rail overflow.
- Installed artifact: real renderer/preload/main Save and Undo followed by a reopened durable snapshot, in addition to the existing containment, playback and security gates.
- Cross-language contract corpus: valid reorder and hostile duplicate-identity, changed-span and noncontiguous-target envelopes agree in TypeScript and Python.
