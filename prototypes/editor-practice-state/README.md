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

## Run

From the repository root:

```bash
python3 prototypes/editor-practice-state/prototype.py
```

Use the shortcuts printed at the bottom of the screen. A useful first path is:

1. `l` — save a two-bar loop;
2. `d` — move its starting downbeat and observe the loop follow;
3. `z` — split the current bar and observe `needs_review`;
4. `u` — undo and observe the loop become valid again;
5. `u`, then `c` — create an alternate edit branch; use `f` and `r` to select/redo branches;
6. change `s`, `o`, `t`, `a`, or `g`, then `x` — reset edits and verify practice/presentation state remains.

This branch is primary-source evidence for a product decision. It is not application code and must not be merged as an implementation.
