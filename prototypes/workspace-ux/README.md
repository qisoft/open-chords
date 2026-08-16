# PROTOTYPE — workspace UX and accessibility

> Three structurally different Open Chords desktop workspaces, switchable with `?variant=`, built only to decide information hierarchy, navigation, state presentation, keyboard behavior, and accessibility boundaries.

This is a throwaway React + Vite UI prototype. It does not analyze audio, persist edits, or define the final visual style.

## Run

From this directory:

```bash
npm install
npm run dev
```

The Vite dev server opens variant A. Use the floating arrows at the bottom or keyboard `←` / `→` to compare:

- **A — Редактор:** focused chord-event timeline and inspector; every chord inside a bar is selected and edited independently;
- **B — Режимы:** Edit and Practice are explicit modes with one primary surface;
- **C — Список:** vertically ordered landmarks and a non-spatial event list for keyboard and screen-reader use.

In the editor, select `C` or `G7` separately inside bar 3. The inspector must identify the exact event and let you choose a supported chord, choose its rhythmic duration, add another event, or delete it without silently changing the other chord in the bar.

Timeline interaction in the current checkpoint:

- drag across bar headers to select a contiguous range; holding at either edge auto-scrolls and extends selection;
- selection is transient; enabling loop snapshots that range until the user explicitly disables or moves the loop;
- the active loop keeps a green frame while the current selection remains blue;
- drag the fixed center playhead to scrub; only the bars move beneath it, and one gesture from centre to either viewport edge reaches the corresponding track boundary;
- press Space to play or pause; playback moves the bars under the fixed playhead;
- playback, loop, speed, and metronome controls live directly below the timeline instead of in a detached bottom footer;
- when loop is enabled, every transition from pause to playback starts at the first bar in the latched loop range;
- the same timeline control bar exposes a single signed chord shift plus Original/Проще; negative shifts show the matching capo fret (for example `Тон −1 · капо 1`), timeline and lyric chords update immediately, and the editor/saved Original stay unchanged;
- the symmetric previous/play/next group is centred so Play sits directly below the fixed playhead; time/loop and speed/metronome occupy the side columns;
- chord widths use 20 px sixteenth-note units (40 px per eighth) and align to four beat intervals in 4/4;
- edit duration with fixed note values plus a meter-derived `весь такт` choice (`3/4 · весь такт`, `4/4 · весь такт`, etc.); manual time inputs are intentionally absent;
- meter capacity uses both numerator and denominator, so 6/8 spans twelve sixteenth-note units rather than twenty-four;
- beat divisions are unlabeled vertical guides behind translucent chord events; the selected-range border stays above header hover;
- all chord events keep the same lane height regardless of duration; short 1/16 and 1/8 events use a compact in-segment label and show the complete symbol in an anchored badge when selected, hovered, or keyboard-focused;
- chord names are never free-form: a collapsed chord row opens a linear button picker — root or `N`, then large major/minor choices with rare qualities separated below, then optional bass or `Готово без баса`; the entire root → quality → bass result is completed in one opening and every later step has an explicit Back action;
- `Добавить аккорд` is the final control inside `Аккорды в этом такте` and appends a selected `N` event; event tiles can be pointer-dragged into insertion slots before, between, or after events (including visible, unclipped gutters beyond the first and last tile; the marker crosses an event at its horizontal midpoint and the result is mirrored immediately on the timeline) or moved with `Alt + ←/→` from the keyboard;
- gaps and overlaps disable saving until the bar is exactly filled.
- a low-confidence bar exposes an explicit `Подтвердить такт` action; confirmation becomes a visible manual-review state and can be reverted;
- lyrics highlight only the currently timed word; the header legend says `Начало аккорда` and `Слово сейчас`, with full-sentence tooltips explaining both visual cues.
- each timed Chord Event is projected above the lyric word it overlaps, so the chord track remains visible while reading and playing from lyrics.
- the lyrics sample spans four explicit lines; a chord already sounding at a line boundary is repeated above that line's first overlapping word so the player never loses harmonic context;
- variant A uses a flat Linear-inspired hierarchy rather than card containers: open timeline and lyrics sections, tab-like event selection, inline metadata, compact typography, and Lucide icon actions with accessible labels/tooltips; violet is reserved for selection and semantic colour for status meaning.
- the readability checkpoint gives every primary icon control at least a 40 px hit target, raises important metadata to 14 px and lyric chord labels to 16 px, and replaces stacked divider lines with a few borderless background groups; the bar context and event choices share one compact block, while the active event is indicated once by its filled tile without a redundant heading or checkmark.

Try these checks in every variant:

1. cycle **Готово → Анализ → Низкая уверенность → Ошибка**;
2. toggle **Меньше движения**;
3. open **Клавиши**, then close it with `Esc` and verify focus returns;
4. use `Space`, `[` / `]`, and `L` away from text fields;
5. resize the window or zoom the page to 200%.

The prototype answers a design question. It must not be merged as application code.
