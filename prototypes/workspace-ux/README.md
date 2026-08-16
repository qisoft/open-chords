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

In the editor, select `C` or `G7` separately inside bar 3. The inspector must identify the exact event and let you rename it, choose its rhythmic duration, add another event, or delete it without silently changing the other chord in the bar.

Timeline interaction in the current checkpoint:

- drag across bar headers to select a contiguous range; holding at either edge auto-scrolls and extends selection;
- drag the fixed center playhead to scrub; only the bars move beneath it;
- press Space to play or pause; playback moves the bars under the fixed playhead;
- chord widths use 20 px sixteenth-note units (40 px per eighth) and align to four beat intervals in 4/4;
- edit duration with 1/16, 1/8, 1/4, 1/2, or whole-note controls; manual time inputs are intentionally absent;
- gaps and overlaps disable saving until the bar is exactly filled.

Try these checks in every variant:

1. cycle **Готово → Анализ → Низкая уверенность → Ошибка**;
2. toggle **Меньше движения**;
3. open **Клавиши**, then close it with `Esc` and verify focus returns;
4. use `Space`, `[` / `]`, and `L` away from text fields;
5. resize the window or zoom the page to 200%.

The prototype answers a design question. It must not be merged as application code.
