# Semantic workspace implementation

Task: [Implement the semantic timeline, lyrics viewport, and playback clock](https://github.com/qisoft/open-chords/issues/55).

Authority: specification sections 11.1, 11.3, and 11.4; the implementation plan's Workspace renderer and Playback module boundaries.

## Observed baseline

The committed snapshot already supplies the Effective Timeline. The renderer projects bars and unmetered regions, and a requestAnimationFrame clock moves the track imperatively. React subscriptions select playing state or whole elapsed seconds. Region identity reconciliation preserves selection and restores focus after a committed revision changes.

The existing track is viewport-sized and has no zoom or pointer scrub interface. Chord labels are aggregated into regions rather than positioned by their own sample intervals. Reference Lyrics are plain paragraphs without alignment-based highlighting or an independent follow mode. The transport follows the lyrics section rather than sitting directly below the timeline.

## Proposed test boundaries

1. Workspace projection and geometry: committed Project input produces identified bars, beats, chord intervals, timed lyrics, and instrumental sections; sample positions map to pixels and back through one bounded seek operation.
2. Playback clock: the existing public clock interface with an injected media source and frame scheduler verifies frame motion, seek limits, and bounded semantic notifications.
3. Electron workspace: Playwright drives pointer and keyboard controls against committed Library fixtures through the real renderer/preload/main path, asserting position, geometry, focus, lyrics following, accessibility-tree values, Reduced Motion, forced colors, and resizing.

These boundaries extend the existing workspace timeline, playback clock, and renderer tests. No private React state or internal DOM implementation mocks are proposed. Native sidecar behavior is outside this change.

## Vertical slices

1. Implement sample-to-pixel geometry and its inverse, fixed center playhead, half-viewport edge space, zoom, click seeking, and pointer drag seeking with equivalent keyboard controls. Preserve exact interval width even for short events; expose complete labels through accessible names and a readable selected-event surface.
2. Render committed bars, lightweight beats, and individually positioned Chord Events. Keep playback, selection, and loop indicators distinct; preserve stable entity identity and focus across snapshot changes.
3. Project selected Lyrics Documents and Alignments without invented timing. Add independently scrolling lyrics, explicit follow/resume behavior, associated chords where supported, and timed instrumental blocks.
4. Verify Reduced Motion and forced colors, position announcements without continuous speech, and desktop zoom. Place transport immediately below the timeline with Play centered.
5. Profile representative long and dense fixtures before choosing virtualization. Record fixture sizes, environment, render/interaction measurements, and the resulting decision. If virtualization is justified, retain focused/selected identities and verify navigation across its boundaries.

## Evidence and completion

Run red-to-green checks one slice at a time, then repository format, lint, typecheck, relevant domain tests, and renderer journeys. Record profiling results and limitations alongside the final implementation. Keep the issue open until its PR merges. Broad workspace accessibility/performance release acceptance remains the separate phase gate.

Status: the user confirmed all three test boundaries on 2026-09-05. Implementation and local validation are complete; native CI evidence is pending.
