# Workspace accessibility and performance evidence

Tracking: [Pass the workspace accessibility and performance gate](https://github.com/qisoft/open-chords/issues/48).
The [confirmed seams](../planning/workspace-accessibility-performance-surface.md) define acceptance. **Gate status: pending native AT evidence on both platforms.**

## Reproduce automation

```sh
pnpm install --frozen-lockfile
pnpm electron:install
pnpm build:test
pnpm exec playwright test tests/renderer/accessibility.spec.ts --retries=0
OPEN_CHORDS_PROFILE_WORKSPACE=1 pnpm exec playwright test tests/renderer/workspace.spec.ts --grep 'profile committed' --retries=0
```

PowerShell: set `$env:OPEN_CHORDS_PROFILE_WORKSPACE = '1'` before the profile command. CI runs both commands on macOS arm64 and Windows x64 and preserves JSON/screenshot attachments in `workspace-evidence-<profile>`; build artifacts are retained as `native-artifact-<profile>` for seven days. Hosted Windows Server measurements are not Windows 11 interactive Narrator evidence.

The automated matrix covers the main workspace, Chord Editor, invalid/reordered/changed drafts, saved edits, practice settings, lyrics selection, timing corrections and Alignment packs dialog. It uses Tab/Enter and native-select typeahead to reach and activate controls, checks editor/picker/dialog focus restoration, completes Save/Undo/Redo/reset and timing corrections, verifies reorder feedback and review state, and submits Russian lyrics through the keyboard. Profiles cover 1080 and 320 CSS-pixel widths, 200% desktop zoom, narrow text spacing, and forced colors with Reduced Motion. Focused controls must be fully visible and not covered at their center; non-timeline button and lyric-group content must not overflow their own bounds. Screenshots are retained for every audited state and profile, with zoom-aware capture coordinates. axe runs WCAG 2.2 A/AA rules plus the target-size rule. The complete results retain `incomplete` entries for human review; zero violations is not a conformance verdict. Existing renderer journeys additionally exercise actual playback, seek, persistent practice and timing corrections.

In forced colors only, axe's `color-contrast` rule is disabled because its original text-fill/forced-background calculation reproduces [upstream issue 3978](https://github.com/dequelabs/axe-core/issues/3978). [CSS forced colors changes used colors](https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties). The ordinary four profiles keep contrast enabled. Forced-color screenshots are retained for visual inspection; native Windows contrast themes still require the manual run below. No page styles are changed to mask the engine limitation.

Observed fixes: the pickup label contrast was 4.4:1; the subtle-text token now meets 4.5:1 on that selected background. Opening timing controls at 320 CSS pixels stretched the document to 375 pixels; grid minimum sizing and timing-label bounds now preserve reflow. Original lyric groups expose their document language while the UI stays English. Aggregate duration errors now describe both the Draft events group and its Duration controls, which expose `aria-invalid`; reset clears both. Focus scrolls the complete lyrics textarea and the focused editor control into view, including the horizontal event rail; controls reserve space around their focus outlines.

## Local performance observation, 2026-09-08

Mac M4 Pro, 14 logical CPUs, 48 GiB RAM, Darwin 25.6.0 arm64; Electron 43.4.0, Chromium 150.0.7871.224. Vite production renderer in the development Electron shell, synthetic unavailable Source, no playback or native screen reader. Accessibility was enabled after startup and before 20 evenly spaced DOM-input seeks; each measurement ends after two animation frames. Other desktop applications remained open. These are investigation measurements, not release support claims or physical-input latency measurements.

| Fixture | Duration | Chords | Lyric lines / tokens | DOM | Exposed AX | Startup ms | Seek median / P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Short | 30 s | 120 | 0 / 0 | 521 | 961 | 492 | 12.1 / 13.6 |
| Many events | 5 min | 1,200 | 0 / 0 | 3,761 | 7,441 | 645 | 12.1 / 12.2 |
| Dense events | 20 min | 4,800 | 0 / 0 | 14,561 | 29,041 | 941 | 23.8 / 24.3 |
| Long song | 45 min | 1,200 | 0 / 0 | 3,761 | 7,441 | 671 | 12.1 / 12.5 |
| Dense lyrics | 20 min | 4,800 | 600 / 4,800 | 31,359 | 60,846 | 1,406 | 30.3 / 32.9 |

Raw samples and versions: [local performance JSON](evidence/workspace-performance-macos-2026-09-08.json). No case crossed the existing 50 ms investigation trigger, so this change retains the semantic DOM. The large AX tree still requires native navigation observations. Windows and installed/native-AT performance remain separate evidence.

## Installed native AT runbook

Use the archive from the exact reviewed commit; record its SHA-256, commit, OS/build, CPU/RAM/display refresh rate, Electron/Chromium versions, screen-reader version and inspector version. Extract into a fresh directory. Do not replace a personal installation or use a personal Library.

From a checkout of that commit, run `node tools/prepare-workspace-accessibility.ts`. It prints a fresh `stateRoot` and a `mediaPath` for a synthetic 30-second project containing rich, unknown and low-confidence chords plus repeated/untimed lyrics. It creates no analysis or alignment quality evidence. Launch the extracted executable with `--user-data-dir=<stateRoot>` (macOS executable: `Open Chords.app/Contents/MacOS/Open Chords`; Windows: `Open Chords.exe`). Close the app before reusing its Library. Prepare a fresh fixture for each platform/run.

On macOS, use VoiceOver with Accessibility Inspector from Xcode. On Windows 11 x64, use Narrator with Accessibility Insights for Windows. Enable the screen reader, then perform the following without the pointer; inspection and evidence capture may use the inspector UI. Record actual spoken phrases/actions, focused name/role/value, and pass/fail for each row. Mark unexecuted rows **not run**, never pass by inference from DOM or axe.

| Journey | Required observation | macOS | Windows |
| --- | --- | --- | --- |
| Open and navigate | Named landmarks/regions and logical order; no inaccessible controls or keyboard trap; focused controls visible | Not run | Not run |
| Position and selection | Slider exposes Project Time and duration; arrows/Home/End seek; current and selected states are distinct; unknown/low-confidence chords retain text | Not run | Not run |
| Play and pause | Verified audio plays; current position can be queried; at least 10 seconds of playback does not continuously announce clock ticks | Not run | Not run |
| Loop and practice | Select a region and loop endpoint, set/clear loop, change speed/count-in/metronome; state changes and disabled reasons are understandable | Not run | Not run |
| Editor/picker | Open focuses editor; Choose chord focuses Root; Escape returns to Choose chord; outer Escape returns to Edit chords | Not run | Not run |
| Invalid duration | Choose a duration that leaves the saved span unfilled; error is discoverable from Draft events; Save unavailable; Reset clears error and keeps focus | Not run | Not run |
| Reorder | Move target plus Move before/after provides drag equivalent, exposes result and preserves the moved event's focus; repeat a move in both directions | Not run | Not run |
| Save/history | Change chord, Save; reopen confirms edit; Undo and selected Redo branch restore the expected value; Reset saved edits preserves machine evidence | Not run | Not run |
| Lyrics language | Save EN and RU text; lyric groups use the selected language; original words/repetitions survive timing changes | Not run | Not run |
| Timing and recovery | Untimed/mismatch/coverage states are readable; correct a line/word, undo/redo; missing pack explains recovery; packs dialog closes to its opener | Not run | Not run |
| Diagrams and uncertainty | Instrument changes preserve the full symbol and equivalent diagram text, or explicitly report an unavailable diagram | Not run | Not run |
| Visual settings | Repeat critical controls at 200% and narrow width, OS Reduce Motion and Windows contrast themes; focus/current/loop remain distinguishable | Not run | Not run |

Attach platform AX/UIA captures and screen-reader observations for the same commit. Review all axe `incomplete` entries and forced-color screenshots. Keep issue acceptance boxes unchecked until each native row has observations or an explicitly resolved defect; a prepared runbook alone does not pass this gate. On 2026-09-08 the user confirmed that no interactive Windows machine/VM is currently available. The Narrator gate therefore remains pending even if hosted CI passes.
