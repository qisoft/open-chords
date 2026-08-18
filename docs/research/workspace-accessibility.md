# Open Chords v1: testable desktop workspace accessibility requirements

> Research for the Wayfinder ticket `Fix workspace UX and accessibility behavior`. Sources were verified on 2026-08-16. Only W3C specifications and official W3C WAI, Apple, Microsoft, Chromium, and Electron materials were used. This document establishes constraints and testable acceptance criteria; it does not choose the product's layout or visual style.

## Summary

1. **WCAG 2.2 Level AA is a practical baseline target for the renderer.** WCAG is a W3C Recommendation with technology-neutral, testable success criteria. It applies to an Electron HTML workspace as web content, but claiming conformance for the complete desktop application requires an explicit scope and complete-process coverage, not only an automated audit ([WCAG 2.2: status and conformance](https://www.w3.org/TR/WCAG22/#conformance)).
2. **WAI-ARIA APG is not a second conformance standard.** APG describes its patterns as informative guidance and warns that example code is not production-ready without adaptation. WCAG and WAI-ARIA semantics are normative; APG is useful as a starting keyboard/focus model for composite widgets ([APG Introduction: APG is Not a Normative Standard](https://www.w3.org/WAI/ARIA/apg/about/introduction/), [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)).
3. **The musical timeline cannot exist only as a painted canvas operated by drag gestures.** Its information, current values, and actions must be exposed through the accessibility tree. Every operation needs a keyboard path, and every drag action needs a single-pointer alternative. Color cannot be the sole carrier of confidence, selection, error, or playback state ([WCAG 1.3.1, 1.4.1, 2.1.1, 2.5.7, 4.1.2](https://www.w3.org/TR/WCAG22/)).
4. **A moving playhead must not become a continuous stream of speech.** Current time may be represented by a named slider or timer, but live regions should announce only meaningful results, errors, and mode changes. `status` has polite live semantics and `alert` is assertive; ordinary status updates do not require moving focus ([WAI-ARIA `status`](https://www.w3.org/TR/wai-aria-1.2/#status), [`alert`](https://www.w3.org/TR/wai-aria-1.2/#alert), [WCAG 4.1.3](https://www.w3.org/TR/WCAG22/#status-messages)).
5. **Validation must be native on both operating systems.** Electron exposes the HTML accessibility tree to platform assistive technologies. Release validation must include VoiceOver plus Accessibility Inspector on macOS and Narrator plus Accessibility Insights/UI Automation inspection on Windows. A DOM audit alone does not prove this ([Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility), [Apple Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector), [Microsoft accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing)).

## 1. Normative boundary

### 1.1 What is mandatory

Below, **requirement** means that a criterion becomes a release requirement if Open Chords adopts **WCAG 2.2 AA for the entire Electron renderer and complete user journeys** as its target profile. WCAG requires every applicable Level A and AA criterion within the chosen scope and separately requires complete-process coverage ([conformance levels and complete processes](https://www.w3.org/TR/WCAG22/#conformance-reqs)).

WCAG is written for web content. It does not automatically certify the native shell, system file dialogs, an embedded YouTube player, or user-imported content outside Open Chords' control. A future conformance statement must enumerate these boundaries. Third-party content has a separate partial-conformance model and does not exempt first-party controls from non-interference requirements ([WCAG conformance](https://www.w3.org/TR/WCAG22/#conformance), [partial conformance for third-party content](https://www.w3.org/TR/WCAG22/#cc3)).

### 1.2 What is guidance

- APG patterns and their key bindings are **design recommendations**, not normative success criteria. APG notes that established keyboard conventions can reasonably become engineering requirements once a pattern is chosen ([APG Introduction](https://www.w3.org/WAI/ARIA/apg/about/introduction/)).
- Apple Human Interface Guidelines, VoiceOver workflows, and Microsoft application guidance provide platform guidance and test scenarios; they do not replace WCAG conformance.
- The WCAG AAA criteria identified below are stronger recommendations for a long-running desktop workspace, not part of the AA gate.

## 2. WCAG 2.2 AA requirements applicable to the workspace

The official source for every row is [WCAG 2.2](https://www.w3.org/TR/WCAG22/). This table maps the criteria to testable Open Chords conditions without changing their normative meaning.

| WCAG | Normative condition | Open Chords verification |
|---|---|---|
| 1.1.1 Non-text Content (A) | Meaningful non-text content has an equivalent text alternative; an input/control has a name describing its purpose. | Chord/instrument diagrams, waveform-only markers, and icon-only controls have accessible names or equivalent structured text. Decoration is hidden from the accessibility tree. |
| 1.3.1 Info and Relationships (A) | Visual structure and relationships are available programmatically or in text. | Bars, beats, chord events, sections, selection, Current/Original, and edit state have semantic structure; canvas coordinates are not the sole source of relationships. |
| 1.3.2 Meaningful Sequence (A) | When order affects meaning, it is programmatically determinable. | Accessibility/DOM order follows the musical and task sequence, not an incidental canvas/CSS layer order. |
| 1.3.3 Sensory Characteristics (A) | Instructions do not depend only on shape, color, size, position, orientation, or sound. | No instruction relies on “the red block on the left” without programmatic/text identity; a metronome/count-in is not conveyed only through sound when it represents task state. |
| 1.4.1 Use of Color (A) | Color is not the only way to communicate information, an action, or a distinguishable state. | Low-confidence, abstained, error, selected/current chord, and edited-boundary states also differ through text, symbols, patterns/shapes, or programmatic state. |
| 1.4.2 Audio Control (A) | Audio that starts automatically and lasts more than three seconds has pause/stop or independent volume control. | Source audio does not start by itself; if autoplay is ever added, these controls are required. |
| 1.4.3 Contrast (Minimum) (AA) | Normal text is at least 4.5:1 and large text at least 3:1, subject to listed exceptions. | Verify default, hover, selected, readable-disabled, warning, and error presentations in every supported theme. |
| 1.4.4 Resize Text (AA) | Text scales to 200% without loss of content or functionality. | At 200%, chord names, labels, dialogs, status/error text, and controls remain visible and operable. |
| 1.4.10 Reflow (AA) | At the equivalent of 320 CSS px width or 256 CSS px height, there is no loss of information/functionality or two-dimensional scrolling except where a 2D layout is essential to use or meaning. | The timeline may justify the 2D exception, but transport, editor commands, errors, and the inspector do not receive it automatically. They remain reachable at 400% zoom, and the timeline provides an accessible sequential path. |
| 1.4.11 Non-text Contrast (AA) | Visual information required for UI components/states and meaningful graphics has at least 3:1 contrast against adjacent colors, subject to exceptions. | Bar/beat boundaries, focus/selection, playhead, loop handles, and error indicators pass contrast checks wherever they are necessary for understanding or operation. |
| 1.4.12 Text Spacing (AA) | Prescribed text-spacing overrides do not cause loss of content or functionality. | Labels and chord text do not clip under the criterion's settings; line and container heights are not hard-coded against text. |
| 1.4.13 Content on Hover or Focus (AA) | Additional hover/focus content is dismissible, hoverable, and persistent where applicable. | Chord/confidence/shortcut tooltips can be dismissed without moving the pointer, remain visible while hovered, and persist until dismissal or focus change. |
| 2.1.1 Keyboard (A) | All functionality is available through a keyboard interface; a pointer path cannot be the only method. | Creating or changing chords, boundaries, beats/downbeats, bars/meters, lyric timing, loops, and seeking works without a mouse. A global shortcut alone is insufficient if its target cannot be selected. |
| 2.1.2 No Keyboard Trap (A) | Keyboard focus can leave every component by a standard method, or the user is informed of a non-standard method. | The timeline, embedded player, diagram picker, toolbar, and modal do not capture Tab/arrows/Escape without an exit. |
| 2.1.4 Character Key Shortcuts (A) | A single-character shortcut can be disabled/remapped or works only while the relevant component has focus. | Single-key playback/practice commands are contextual or configurable and do not fire while editing lyrics/text. |
| 2.2.2 Pause, Stop, Hide (A) | Automatically started moving/blinking/scrolling content lasting more than five seconds, or auto-updating content beside other content, has pause/stop/hide/frequency controls unless essential. | Playback can be paused; moving-bars view does not start without user action; no secondary auto-scroll or animation continues without accessible control. |
| 2.3.1 Three Flashes or Below Threshold (A) | Content does not flash more than three times per second except within safe thresholds. | Metronome, count-in, playhead, and error animations avoid hazardous flashing. |
| 2.4.1 Bypass Blocks (A) | A mechanism bypasses repeated blocks. | Landmarks/regions and fast keyboard routes move among library, timeline, inspector/lyrics, and transport without tabbing through every event. |
| 2.4.2 Page Titled (A) | The document has a descriptive topic or purpose. | The window/document title identifies the project and active workspace context without exposing unnecessary private data. |
| 2.4.3 Focus Order (A) | Sequential focus order preserves meaning and operability. | Tab order is stable and logical rather than following visually rearranged CSS layers; opening/closing panels and dialogs has a predictable focus destination. |
| 2.4.6 Headings and Labels (AA) | Headings and labels describe their topic or purpose. | Repeated `Edit`, `Reset`, time values, and icon actions have contextual accessible labels; workspace sections are programmatically named. |
| 2.4.7 Focus Visible (AA) | Keyboard-operable UI has a visible focus indicator. | Focus remains visible on the canvas, dark theme, selected rows, and custom controls. |
| 2.4.11 Focus Not Obscured (Minimum) (AA) | Author-created content does not completely hide the focused component. | Sticky transport, popovers, toasts, and bottom bars do not cover the focused timeline item/control; it scrolls into view. |
| 2.5.1 Pointer Gestures (A) | Multipoint or path-based gestures have a single-pointer alternative unless essential. | Neither pinch nor a drawn gesture is the only zoom/edit route. |
| 2.5.2 Pointer Cancellation (A) | Single-pointer actions support cancel/abort/undo, or complete on the up-event with an opportunity to cancel. | Boundary/chord/loop edits do not commit irreversibly on pointer-down; nondestructive undo remains available. |
| 2.5.3 Label in Name (A) | The accessible name contains the visible label. | Voice Control/Narrator can activate `Play`, `Undo`, `Low confidence`, and instrument labels using the words visible to the user. |
| 2.5.7 Dragging Movements (AA) | Every drag action has a single-pointer non-drag alternative unless essential or system-controlled. | Boundaries, beats, loop handles, and reordering offer click/select plus numeric, nudge, or action alternatives. |
| 2.5.8 Target Size (Minimum) (AA) | Pointer targets are at least 24×24 CSS px or meet a normative exception/spacing condition. | Icon buttons and dense timeline handles are tested by target box and spacing, not only visible glyph size. |
| 3.1.1 Language of Page (A), 3.1.2 Language of Parts (AA) | Default language and language changes are programmatically determinable. | The UI locale is declared; user lyrics/metadata in another known language are marked where possible. |
| 3.2.1 On Focus (A), 3.2.2 On Input (A) | Focus or a value change alone does not cause an unexpected context change without warning. | Focusing a chord/event does not seek or start playback; selecting a value does not unexpectedly close or replace the workspace. |
| 3.2.3 Consistent Navigation (AA), 3.2.4 Consistent Identification (AA) | Repeated navigation and actions preserve order and identification. | Transport, Undo/Redo, Original/Beginner, and confidence states are named and behave consistently across editor/practice contexts. |
| 3.3.1 Error Identification (A) | A detected input error is identified and described in text. | Invalid meter, overlapping boundary, unsupported chord, and failed edit states have specific text/programmatic descriptions, not only a red outline. |
| 3.3.2 Labels or Instructions (A), 3.3.3 Error Suggestion (AA) | Inputs have labels/instructions; a known correction is suggested unless that compromises purpose or security. | Time/chord/meter editors state format, units/range, and corrections; the error is associated with its field/event. |
| 4.1.2 Name, Role, Value (A) | A UI component has programmatically determinable name/role; settable states/values are exposed to assistive technology and changes are announced. | Custom timeline controls expose role, label, value, selected/expanded/invalid/disabled state, and actions. A canvas bitmap without a parallel semantic model fails. |
| 4.1.3 Status Messages (AA) | Status messages are available to assistive technology without receiving focus. | Save, export, analysis progress/result, undo/reset, invalid-loop, and nonblocking errors use appropriate live/status mechanisms without stealing focus. |

### 2.1 Stronger recommendations outside the AA gate

- **2.4.13 Focus Appearance (AAA):** use a measurable indicator with at least the area of a 2 CSS px perimeter and a contrast change of at least 3:1. This makes custom timeline focus testable even though AA requires only visibility ([WCAG 2.4.13](https://www.w3.org/TR/WCAG22/#focus-appearance)).
- **2.5.5 Target Size (Enhanced) (AAA):** aim for 44×44 CSS px for primary transport and frequent practice controls. A dense timeline may use smaller targets only alongside equivalent controls ([WCAG 2.5.5](https://www.w3.org/TR/WCAG22/#target-size-enhanced)).
- **2.3.3 Animation from Interactions (AAA):** interaction motion can be disabled unless essential. CSS Media Queries additionally defines `prefers-reduced-motion: reduce` as a system request to remove or replace non-essential motion ([WCAG 2.3.3](https://www.w3.org/TR/WCAG22/#animation-from-interactions), [Media Queries Level 5 §12.1](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)).

## 3. WAI-ARIA APG recommended interaction models

APG keyboard conventions reduce the number of Tab stops: Tab enters a composite widget, arrow keys move focus within it, and Tab exits. The composite's author must manage focus; disabled items sometimes remain arrow-focusable for discoverability. This is guidance, and every selected pattern must still pass WCAG and native assistive-technology testing ([APG Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

### Toolbar

The [`toolbar` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) applies to a group of transport/edit actions:

- one Tab stop for the toolbar; Left/Right move focus, with optional Home/End;
- a vertical toolbar uses Up/Down and reports orientation through `aria-orientation`;
- the toolbar has an accessible label, unique when multiple toolbars exist;
- controls with their own Left/Right interactions, such as text fields or horizontal sliders, need deliberate placement/handling so toolbar navigation does not block the control.

### Tabs

The [`tabs` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) applies to switchable workspace views:

- `tablist`, `tab`, and `tabpanel` are connected by accessible names/relationships; the selected tab reports `aria-selected=true`;
- Left/Right, or Up/Down for vertical orientation, move focus among tabs; Home/End are optional;
- automatic activation is recommended only when the panel appears without noticeable latency; otherwise Space/Enter performs manual activation;
- after deleting a tab, focus moves to a logical neighboring tab or another logical control.

### List, listbox, and grid

- A semantic list of projects/events without selection or internal actions remains a native list, not an ARIA composite.
- A one-dimensional selectable set can follow the [`listbox` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/): arrows change option focus/selection, with Home/End and type-ahead recommended for long sets. APG warns that option content must not contain independent interactive elements; rows with actions require another pattern.
- An interactive event table can follow the [`grid` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/): one Tab stop enters the grid; arrows move cell focus; Home/End and Ctrl+Home/End move to boundaries; Page Up/Down are optional. The author must make cell content focusable without turning Tab into traversal of every cell. Cells containing editors/controls need an explicit navigation/edit mode transition; APG gives Enter/F2 to enter and Escape to return as a common model.
- A visual CSS grid does not imply `role=grid`. The entire chord timeline must not automatically become one grid: arrows may conflict among playhead movement, selection, boundary movement, and embedded sliders. Define the keyboard mode model first, then choose native structure, a grid, or several smaller composites.

### Timeline, playhead, speed, and loop range

- A one-dimensional numeric value can follow the [`slider` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/): Right/Up increase, Left/Down decrease, Home/End set minimum/maximum, and Page Up/Down optionally make a larger step. Provide `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and meaningful `aria-valuetext` when the number alone does not explain musical position.
- Loop start/end can follow the [`multi-thumb slider` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/) when each thumb has a separate label, tab order remains stable, and allowable ranges update programmatically. Separate fields or nudge commands are still required as drag alternatives.
- APG warns that touch assistive technologies may not synthesize the required arrow events for sliders. Desktop v1 must test VoiceOver/Narrator with actual assistive technology rather than treating ARIA as sufficient.
- The timeline must provide domain-meaningful `aria-valuetext`, for example section/bar/beat plus elapsed time. Frequent playback ticks must not become assertive live announcements. The exact format is a separate product decision.

### Dialogs

The [`Modal dialog` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) recommends:

- on open, focus moves inside the dialog; Tab/Shift+Tab remain within it, and Escape closes it;
- the dialog has a visible title connected through `aria-labelledby` and a visible close/cancel button in Tab order;
- on close, focus normally returns to the opener or to the next logical target if the opener no longer exists;
- initial focus follows content and risk: use the least destructive action for irreversible operations and a static heading with `tabindex=-1` for long structured content;
- set `aria-modal=true` only when outside content is genuinely inert and visually obscured. Incorrect modal semantics can make the interface inaccessible to assistive technology.

### Shortcuts

The normative [`aria-keyshortcuts`](https://www.w3.org/TR/wai-aria-1.2/#aria-keyshortcuts) property only **declares** an implemented shortcut; it does not create behavior. Its value uses DOM key names, and platform conventions may require different modifiers. Therefore:

- the shortcut must actually work in the stated context and must not conflict with text input, assistive technology, or system shortcuts;
- frequent commands are also available through menus/controls and a visible, searchable help surface;
- single-character shortcuts satisfy WCAG 2.1.4 through disable/remap support or focused-context-only behavior;
- expected system shortcuts must not be reassigned on macOS; Apple recommends Full Keyboard Access and preserving standard shortcuts ([Apple Keyboards HIG](https://developer.apple.com/design/human-interface-guidelines/keyboards)).

### Live regions, progress, and errors

- `role=status` has implicit `aria-live=polite` and `aria-atomic=true`; it suits save/edit/export results and noncritical state ([WAI-ARIA `status`](https://www.w3.org/TR/wai-aria-1.2/#status)).
- `role=alert` has assertive, atomic semantics for important time-sensitive messages. APG emphasizes that an alert need not receive focus and must not disappear too quickly ([APG Alert Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)).
- `role=log` suits a sequence of meaningful additions, `role=timer` has implicit `aria-live=off`, and `progressbar` reports bounded progress. WAI-ARIA defines their semantics; updates must not flood speech output ([WAI-ARIA roles](https://www.w3.org/TR/wai-aria-1.2/#role_definitions)).
- A form error must also be associated with the invalid field through `aria-invalid` and an accessible description. A live announcement does not replace a persistent visible error and correction path.

## 4. Platform/Electron constraints

### 4.1 Electron and Chromium

Electron states that its accessibility concerns are similar to those of websites because the renderer is HTML. Electron automatically enables accessibility features when it detects assistive technology. `app.setAccessibilitySupportEnabled` can force exposure of the Chrome accessibility tree, but system assistive utilities take precedence ([Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)). The API reference warns about the performance cost of permanently forcing the tree and does not recommend enabling it by default ([Electron `app.accessibilitySupportEnabled`](https://www.electronjs.org/docs/latest/api/app#appaccessibilitysupportenabled-macos-windows)).

Testable implications:

- do not disable accessibility support or create a separate, reduced accessibility mode;
- automated/manual test harnesses may explicitly enable the tree, but production defaults should rely on assistive-technology detection or an intentional preference;
- record Electron and bundled Chromium versions in evidence because the platform bridge changes independently of the DOM;
- test the resulting platform tree and events, not only DOM/ARIA. Chromium provides `chrome://accessibility` and AX inspection tools for trees/events ([Chromium accessibility technical documentation](https://www.chromium.org/developers/design-documents/accessibility/), [AX inspect tools](https://www.chromium.org/developers/accessibility/testing/automated-testing/ax-inspect/)).

Starting with Chrome 138, Chromium-based browsers on Windows enable the native UI Automation provider by default; Narrator, Magnifier, and Voice Access use UIA. This confirms the correct target surface for modern bundled Chromium, but it does not prove that a particular Electron build is correct; that build still requires testing ([Chrome: Native UI Automation for Windows in Chromium](https://developer.chrome.com/blog/windows-uia-support-update)).

### 4.2 macOS: VoiceOver and keyboard

Apple describes VoiceOver navigation as a hierarchy of areas and groups: users enter a group, interact with it, then leave it; the rotor provides fast access to categories such as controls, headings, and links. Excessive unnamed nesting and thousands of flat timeline nodes are therefore equally harmful. Platform testing must verify meaningful named regions and reachability of nested actions ([Apple: Get started with VoiceOver](https://support.apple.com/guide/voiceover/get-started-with-voiceover-vo4be8816d70/mac), [advanced navigation](https://support.apple.com/guide/voiceover/intro-to-advanced-navigation-vo27974/mac)).

Apple recommends:

- keyboard-only navigation and interaction through Full Keyboard Access;
- preserving standard keyboard shortcuts;
- platform-consistent focus appearance;
- testing with VoiceOver and Accessibility Inspector. Inspector exposes hierarchy, attributes/actions, and common issues, but supplements rather than replaces real assistive-technology testing ([Apple Accessibility HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Keyboards HIG](https://developer.apple.com/design/human-interface-guidelines/keyboards), [Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/), [Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector)).

Minimum macOS evidence run:

1. Enable VoiceOver (`Command-F5`) and complete project open → playback/seek → chord/boundary edit → undo → loop → error recovery → export using only the keyboard.
2. Verify names, roles, states/values, group entry/exit, focus restoration, and the absence of a continuous spoken stream from the playhead.
3. Use Accessibility Inspector to audit unlabeled, clipped, and contrast issues and manually inspect hierarchy/actions.
4. Enable Reduce Motion and confirm that the workspace loses no information or functionality. Apple separately requires testing the application with this setting ([Apple: Testing system accessibility features](https://developer.apple.com/documentation/accessibility/testing-system-accessibility-features-in-your-app)).

### 4.3 Windows: UI Automation and Narrator

Microsoft identifies UI Automation as the primary accessibility integration for Windows applications: accessibility-relevant content in the top-level window must be available to UIA clients, and every element needs the correct accessible name, role, and state. Keyboard and screen-reader support must be tested with real tools because readers do not all use automation properties in the same way ([Microsoft Accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)).

Minimum Windows evidence run:

1. Complete the same end-to-end journey using only keyboard and Narrator. Narrator must read visible names, roles, and states/values and invoke every action.
2. Verify logical Tab order, arrows within composites, and Enter/Space activation.
3. Test Windows high-contrast themes and DPI/display scaling.
4. Use Accessibility Insights for Windows FastPass/Live Inspect to inspect the UIA tree, patterns, and events. Microsoft recommends automated checks in CI plus manual screen-reader/keyboard validation for critical journeys ([Microsoft accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing), [Accessibility Insights](https://accessibilityinsights.io/docs/windows/overview/)).

## 5. Testable accessibility contract for the prototype and future implementation

These are constraints, not layout decisions.

### 5.1 Semantic model

- Every visible interactive object has one clear accessible name, role, current value/state, and action.
- Bars, beats, chord events, sections, lyric tokens, and confidence/error states have stable semantic representations independent of the visual renderer.
- A chord diagram has a text equivalent: a structured chord name and playing instructions/notes when conveyed by the diagram.
- `asserted`, `low confidence`, `abstained`, `N`, user-edited, and technical-error states do not collapse into one color or the single word `warning`.

### 5.2 Keyboard and focus

- The complete open project → choose target → edit → undo/reset → practice loop → export journey works without a pointer.
- Tab moves among regions/composites, while arrows move within the selected APG composite; fast routes reach the timeline and transport.
- Boundary, beat, and loop dragging has nudge, numeric, or action alternatives with the same result.
- Focus survives timeline rerenders and playhead updates; modals/popovers restore it according to a declared rule; sticky content does not hide it.
- Shortcut help shows actual platform bindings; single-key actions are contextual or remappable.

### 5.3 Playback and timeline

- Play/pause, seek, previous/next chord/bar, speed, transpose, metronome, count-in, and loop have named, keyboard-operable controls.
- Position reports elapsed time and musical position in textual/programmatic form; scrub values include units and range.
- Playback ticks and moving bars are not published as assertive live updates. Meaningful changes—invalid loop, applied edit, analysis/export completion, and errors—are announced once at an appropriate priority.
- Pause stops media and associated nonessential movement; Reduce Motion removes smooth/animated transitions while preserving position/state.

### 5.4 Visual resilience

- 200% text zoom causes no clipping or loss; 400% browser zoom/320 CSS px equivalent preserves controls and avoids two-dimensional scrolling outside a justified timeline fragment.
- Text meets 4.5:1/3:1 contrast, meaningful UI/graphic boundaries meet 3:1, and target size is 24×24 CSS px or satisfies a normative exception/spacing condition.
- Confidence, current/selected, invalid, and edit states remain recognizable without color or motion.
- High contrast/forced colors preserve focus, selection, playhead, loop, and error distinctions.

### 5.5 Release evidence

- Automated DOM accessibility checks cover every critical renderer view, but are not the only gate.
- Keyboard scenarios are automated where possible and supplemented by a manual no-pointer pass.
- macOS: VoiceOver + Accessibility Inspector; Windows: Narrator + Accessibility Insights/UIA inspection.
- The matrix records OS, Electron, Chromium, screen-reader, and tool versions; one DOM snapshot cannot close blockers.
- Test English and Russian UI strings, long project/chord labels, low-confidence/abstention, invalid-edit, empty/no-lyrics, and analysis-progress states.

## 6. Concise implications for the next prototype

1. The prototype must prove **two equivalent surfaces over one state model**: a visual timeline and a sequential semantic/keyboard model. A separate “accessible mode” is unnecessary.
2. Before choosing a layout, validate four seams: region navigation, timeline target selection/editing without drag, focus preservation during playback/rerender, and restrained announcements of dynamic state changes.
3. The confidence/error prototype must show a visible word, icon, or pattern plus corresponding programmatic state; changing only color is not an alternative.
4. The reflow prototype may keep the timeline itself two-dimensional, but must prove access to transport, editor actions, and the selected event at 200% text and 400% zoom.
5. Prototype acceptance requires short VoiceOver and Narrator walkthroughs. An AX/DOM screenshot without a real screen reader is only intermediate evidence.

## 7. Open product decisions not resolved by the sources

- Which information architecture and grouping best serve library, editor, and practice workflows.
- Whether to represent the event timeline as a grid, listbox, treegrid, or custom composition of native elements. Choose the role after a task prototype, not by appearance.
- The exact shortcut map, nudge increments, and `aria-valuetext` format for bar/beat/seconds under variable meter/tempo.
- Which playback changes deserve live announcements and what verbosity the user can configure.
- Whether a formal WCAG conformance claim is required or WCAG 2.2 AA remains an internal release gate.

None of these questions changes the required properties: keyboard equivalence, stable focus, programmatic semantics, non-color state, zoom/reflow resilience, and validation with native assistive technologies.
