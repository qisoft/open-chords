# Practice transport and presentation

[Practice transport, loops, transpose, and diagrams](https://github.com/qisoft/open-chords/issues/43) uses three confirmed public boundaries: domain projection, Project Library/typed desktop IPC, and renderer/installed journeys.

## Saved state

`project.changePractice` is a named preload capability. Main shares the bounded, serialized Project mutation queue with editor commands, checks the expected Project Revision, validates the action and complete result, and acknowledges only after durable Head publication. Practice publishes a Project Revision without appending an Edit Layer transaction or changing machine Analysis Revisions. The Library's existing mutation-reason vocabulary remains compatible; the versioned Project payload owns the practice distinction.

Selection stays temporary. Set loop from selection explicitly saves first/last Bar identities; Through selects a contiguous range. Ordinary boundary moves follow identity. Split/merge affecting an anchor, lost anchors, or an Analysis Revision change requires review. Undo does not silently reactivate a flagged loop: set it again or clear it. Main reconciles both edits and history changes before publication.

Contract 1.2 adds practice state with speed (0.5–1.5), count-in (0–2 bars), metronome, timeline autoscroll, instrument, and loop. Missing state in older snapshots uses safe defaults. Default migration preserves prior revisions.

## Playback

Play and Space start a valid enabled loop at its first Bar. Space leaves text inputs, selects, editable content, and native button activation alone. Previous/next chord and Bar navigation uses committed Project Time. Structural grid changes pause playback; compatible timing/value edits retain position. Scrubbing and navigation cancel pending count-in.

Speed explicitly enables [HTMLMediaElement pitch preservation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch). A renderer journey analyzes the actual native output of a synthetic 440 Hz WAV at 0.75× and requires a 432–448 Hz spectral peak; this is a bounded regression check, not a perceptual quality claim for every recording.

Count-in derives a complete bar from the active meter and local beat duration, scaled by playback speed. Unmetered starts require count-in to be turned off rather than guessing tempo. Count-in and metronome use [scheduled Web Audio sources](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/start); their cancellation sets are separate. Metronome follows committed beat locations and excludes beats outside a saved loop. Pausing, seeking, changing Project state, and teardown clear scheduled sounds. Timeline autoscroll is independent from playback; the existing lyrics-follow control remains separate.

## Chord presentation

Transpose shifts root and slash bass using explicit enharmonic spelling. Beginner View removes extensions/additions only for major/minor families without alterations or omissions; unsupported rich symbols remain intact. Presentation transforms feed timeline and lyric labels, never Original chord storage. Negative transpose on guitar/ukulele provides capo guidance for matching the Original recording; it does not pitch-shift source audio.

The original data-only v1 packs cover movable guitar and re-entrant GCEA ukulele major/minor/major7/minor7/dominant7 voicings, and piano triads, sevenths, suspended, diminished and augmented chords. String diagrams refuse unsupported slash bass or rich symbols rather than showing a different chord. Piano preserves slash bass as a separately named bass note. No chord and abstained observations do not acquire a fabricated diagram. Native SVG diagrams include named text equivalents.

## Evidence

Renderer journeys cover durable loop/settings reopening, independent selection, transpose/Beginner/instrument controls, keyboard loop starts, completed and cancelled count-in, separate native audio scheduling, autoscroll, and the synthetic pitch probe. The installed editor journey additionally saves practice through UI/IPC and verifies it through the ordinary Project Library snapshot after abrupt process termination. Native accessibility and perceptual quality claims still belong to their release gates.
