# PROTOTYPE — editor and practice state

This throwaway logic prototype asks one question:

> Can Open Chords keep immutable machine output, branching nondestructive edits, transport/practice state, and presentation transforms independent while still resolving playback, navigation, metronome, and saved bar loops against one coherent Effective Timeline?

It deliberately tests the awkward cases:

- undo/reset must not undo speed, count-in, metronome, loop, transpose, capo, or Beginner View;
- editing after undo creates another history branch instead of deleting redo history;
- a downbeat move is a shared Bar-boundary transaction, never a standalone flag edit;
- a saved bar loop follows ordinary boundary moves, but a split/merge touching its anchor becomes `needs_review` rather than silently changing meaning;
- Original chord events remain intact while transpose/capo/Beginner View change only presentation;
- word timing edits never rewrite Reference Lyrics or raw machine alignment.

The sample timeline uses small integer Project Time values so state changes are easy to inspect. Nothing is persisted.

## Run the visual prototype

From the repository root:

```bash
python3 prototypes/editor-practice-state/run_ui.py
```

It opens a local browser page. Start with variant C (the default), then use the floating arrows or keyboard `←` / `→` to compare:

- **A — Таймлайн:** editing around a centered playhead;
- **B — Практика:** current/next chords and loop controls first;
- **C — До / сейчас:** machine output and the effective result shown together.

In any variant, use the large labelled actions. A useful first path is:

1. **Save bars 2–3 as a loop**;
2. **Move the start of bar 2** and observe the loop follow;
3. **Split bar 2** and observe the visible review warning;
4. **Undo** and observe the loop become valid again;
5. change speed/transpose/Beginner, then **Reset edits** and verify those view/practice choices remain.

## Internal reducer view

The earlier terminal display remains available only for inspecting the reducer's full state:

```bash
python3 prototypes/editor-practice-state/prototype.py
```

It is not the user-facing review artifact.

This branch is primary-source evidence for a product decision. It is not application code and must not be merged as an implementation.
