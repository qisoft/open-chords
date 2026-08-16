# PROTOTYPE — workspace UX and accessibility

> Three structurally different Open Chords desktop workspaces, switchable with `?variant=`, built only to decide information hierarchy, navigation, state presentation, keyboard behavior, and accessibility boundaries.

This is a throwaway UI prototype. It does not analyze audio, persist edits, or define the final visual style.

## Run

From the repository root:

```bash
python3 prototypes/workspace-ux/run_ui.py
```

The browser opens variant A. Use the floating arrows at the bottom or keyboard `←` / `→` to compare:

- **A — Студия:** library, timeline, inspector, and transport visible together;
- **B — Одна задача:** Edit and Practice are explicit modes with one primary surface;
- **C — Линейно:** vertically ordered landmarks and a non-spatial timeline for keyboard and screen-reader use.

Try these checks in every variant:

1. cycle **Готово → Анализ → Низкая уверенность → Ошибка**;
2. toggle **Меньше движения**;
3. open **Клавиши**, then close it with `Esc` and verify focus returns;
4. use `Space`, `[` / `]`, and `L` away from text fields;
5. resize the window or zoom the page to 200%.

The prototype answers a design question. It must not be merged as application code.
