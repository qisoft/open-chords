# Workspace accessibility and performance gate

Implementation issue: [Pass the workspace accessibility and performance gate](https://github.com/qisoft/open-chords/issues/48).

Base: merged Alignment Jobs implementation, `731ecfb1b17a28722df962e083586955e7c1db99`.

## Scope and authority

Validate the complete committed workspace as one accessible desktop workflow before export and packaging depend on it. The renderer keeps one semantic DOM surface for visual, keyboard and assistive-technology use. The timeline may retain horizontal spatial presentation, but every operation and state remains available through ordered semantic controls. Accessibility fixes must preserve Electron main authority, immutable machine evidence, isolated Editor Drafts and durable Edit Transactions.

The target is the applicable WCAG 2.2 Level A and AA requirements recorded in `docs/research/workspace-accessibility.md`. Automated audits support this gate but do not replace keyboard or native assistive-technology evidence. Performance observations are tied to declared hardware, OS, Electron/Chromium versions, fixture density and run conditions; they do not authorize unrelated product or analysis-quality claims.

## Confirmed public test seams

The user confirmed all three seams on 2026-09-08.

1. **Critical renderer journeys and accessibility tree.** Drive the real renderer/preload/main path for project open, timeline selection and seek, chord edit/validation/save/reset/Undo/Redo, practice loop/count-in, lyrics selection/alignment correction and error recovery. Run an automated WCAG audit in every representative state. Verify keyboard equivalents, logical focus order and restoration, stable names/roles/values, field-associated errors, bounded live announcements with no playback-tick spam, language metadata and equivalent text for diagrams and uncertainty states. The tests use public DOM/accessibility behavior and committed Project snapshots rather than component internals.
2. **Visual resilience and representative performance.** Exercise 200% text scaling, the 320 CSS-pixel reflow equivalent, prescribed text-spacing overrides, Reduced Motion, forced colors and supported narrow/zoomed desktop sizes. Assert that non-timeline controls remain reachable, focused controls are not obscured, required targets meet 24×24 CSS pixels or a documented WCAG exception, and no state depends on color alone. Profile production renderer builds with long-song, many-event and dense-lyrics fixtures on declared macOS arm64 and Windows x64 environments. Record startup, DOM/AX size and seek-to-two-frames median/P95. Keep semantic DOM unless a measured case crosses the existing 50 ms investigation trigger; any virtualization decision must preserve current, focused, selected, loop-edge and adjacent identities.
3. **Installed native assistive technology.** Run the same no-pointer journey in installed artifacts with VoiceOver plus Accessibility Inspector on macOS and Narrator plus Accessibility Insights/UI Automation on Windows. Record OS, Electron, Chromium, screen-reader and inspection-tool versions; attach a checklist, platform-tree evidence and concise observed announcements/actions. Verify named regions and controls, group navigation, value/state exposure, focus restoration, reorder feedback, error recovery, High Contrast/Reduce Motion and the absence of continuous spoken playhead updates. A DOM snapshot or axe result cannot pass this seam alone.

## Evidence boundaries

- English is the product UI language. English and Russian Reference Lyrics remain content and receive language metadata where known; this gate does not introduce a translated UI.
- The timeline's spatial view may use the WCAG two-dimensional-layout exception. Transport, editing, errors, selected-event details and the sequential keyboard surface do not inherit that exception.
- Hosted-runner timing is CI smoke evidence. Release performance evidence names the physical reference machine and run conditions.
- Manual native AT evidence must report observed pass/fail results. A prepared script without an executed run does not satisfy the gate.
- Existing analysis, alignment and synthetic media fixtures prove interface behavior, not musical or acoustic quality.

## Implementation order

After the seams are confirmed, first make the automated audit red on the current critical workspace and fix semantic/keyboard/focus failures. Then add reflow, text-spacing, forced-color, target-size and dense-content checks. Run and document the production performance profiles before choosing whether rendering changes are justified. Finally package the exact head and execute the native VoiceOver/Accessibility Inspector and Narrator/Accessibility Insights scripts, fixing failures and repeating the affected public journey before the PR is marked ready.
