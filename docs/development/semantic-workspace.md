# Semantic workspace

The workspace renders the committed Active View through `buildWorkspaceTimeline` and `buildWorkspaceContent`. It does not create an editable copy of the musical data. Selected regions, chord focus, zoom, and lyrics-follow preference are renderer presentation state.

## Geometry and input

`createTimelineGeometry` owns the sample/pixel conversion used by track placement, click seeking, and pointer scrubbing. The center of the viewport is the fixed playhead. Start and end positions have half a viewport of empty space. Zoom changes pixels per sample; it does not change time or minimum event width. Borders and labels paint inside sample-derived widths, including subpixel intervals.

The named Project position control supplies the same bounded seek operation as the pointer surface. Arrow keys seek 100 ms, Shift+Arrow seeks five seconds, Page Up/Down seeks ten seconds, and Home/End seek the range boundaries. Arrow navigation inside the bar or chord row selects the adjacent entity. Paused seeking can leave a saved loop; loop enforcement applies to advancing playback and its terminal media boundary. Complete chord labels remain available through accessible names, native hover titles, and the selected-chord readout even when the interval cannot display the text.

Bars, beat marks, and Chord Events retain their own identities. Playback current state, selection, and persistent loop have distinct marks. Abstained chord values appear as Unknown chord, including region accessible names; `N` remains an asserted no-chord observation. Replacing the committed view reconciles selection and restores disappearing chord/region focus only when that surface owned it.

## Clock and lyrics

The existing requestAnimationFrame clock publishes Project Time relative to the verified Source range. Frame motion and current markers update DOM properties; React subscribes to playing state, whole seconds, or the current lyric/section identity. The primary workspace does not subscribe to frame positions. Reduced Motion changes continuous timeline panning to region steps and disables smooth lyric following while retaining exact position controls.

Local audio uses `preload="auto"`. An Electron integration test reproduced metadata-only loading leaving a real WAV in `seeking=true`, `readyState=1` after rapid paused seeks. Preloading the media allowed the same sequence to seek and then play. The main-owned capability and existing bounded range reader remain the source of media access. When Source media is unavailable, a paused clock still allows inspection and seeking of the committed view; Play stays disabled.

Lyrics use the selected effective Alignment, including committed timing corrections. Untimed or unmatched text receives no invented interval or chord association. Chords appear above words only when matched token intervals support the association. Selected intro/interlude/outro/solo regions without overlapping matched lines render as timed chord-section blocks; this does not assert that absent Reference Lyrics prove absent vocals.

The lyrics viewport scrolls independently. Wheel, pointer, and keyboard scrolling suspend follow; Follow lyrics resumes it without moving focus. Scrolling uses that viewport's own coordinates rather than `scrollIntoView`, which could also move the document. Current line/section identity changes drive highlighting and follow; frame positions do not rerender every lyric line.

## Profiling before virtualization

Run the opt-in production-renderer profile:

```sh
pnpm build:test
OPEN_CHORDS_PROFILE_WORKSPACE=1 pnpm exec playwright test tests/renderer/workspace.spec.ts --grep 'profile committed'
```

Measured on 2026-09-05, macOS 26.6.2 arm64, Electron 43.4.0, a 1080-pixel test window, production Vite renderer build. Synthetic committed fixtures contain one chord and beat per quarter second, four beats per bar, and no Reference Lyrics. Each profile performs 20 seeks through the renderer's position input, waiting two animation frames per measurement. Startup includes Electron launch and obtaining the committed view. These are local observations, not Windows or release performance claims.

| Chords | Bars | DOM elements | Startup to ready | Seek to two frames, median | P95 |
| --- | --- | --- | --- | --- | --- |
| 120 | 30 | 401 | 507 ms | 16.7 ms | 16.8 ms |
| 1,200 | 300 | 3,371 | 607 ms | 16.6 ms | 17.7 ms |
| 4,800 | 1,200 | 13,271 | 926 ms | 24.9 ms | 25.1 ms |

Decision: retain semantic DOM rendering in this change. No measured case crossed a 50 ms investigation trigger for seek-to-paint latency, so there is no evidence-backed virtualization cutover yet. Repeat the profile on declared release hardware and larger/dense lyric fixtures before introducing a threshold. Any subsequent virtualization must preserve the focused and selected identities and keyboard access to offscreen entities. This measurement is not the separate workspace accessibility/performance release gate.

The dense fixture also checks actual DOM widths against sample geometry. It caught the existing region padding imposing a 25-pixel minimum where 3.46 pixels were required; absolute interval placement and inset decoration removed that distortion.

## Validation scope

Public projection tests cover canonical geometry, abstention, matched/unmatched lyrics, committed timing corrections, and timed chord sections. Electron journeys cover real local-media seeking and playback, keyboard/pointer equivalence, narrow layouts, chord labels, selection/loop independence, focus after committed-view replacement, Reduced Motion, forced colors, position values, independent lyrics scrolling, follow resumption, and 200% desktop zoom. The renderer screenshot was visually inspected.

Full native screen-reader validation and cross-platform performance claims remain the separate phase gate. React external-store subscriptions follow the [official cached-snapshot contract](https://react.dev/reference/react/useSyncExternalStore).
