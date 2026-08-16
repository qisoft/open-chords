/* Three workspace variants for one state, switchable via ?variant=. */

const VARIANTS = {
  A: "A — Редактор",
  B: "B — Режимы",
  C: "C — Список",
};

const PROJECTS = [
  ["Плачь и танцуй", "0:00–0:48", "selected"],
  ["Перемены", "0:42–4:18", ""],
  ["Кукушка", "1:10–5:02", ""],
];

const BARS = [
  { number: 1, meter: "4/4", chords: ["C", "G"], section: "Вступление", confidence: "ok" },
  { number: 2, meter: "4/4", chords: ["Am", "F"], section: "Куплет 1", confidence: "low" },
  { number: 3, meter: "4/4", chords: ["C", "G7"], section: "Куплет 1", confidence: "ok" },
  { number: 4, meter: "4/4", chords: ["Am", "F"], section: "Припев", confidence: "ok" },
  { number: 5, meter: "3/4", chords: ["Dm", "G"], section: "Припев", confidence: "low" },
  { number: 6, meter: "3/4", chords: ["Cmaj7"], section: "Проигрыш", confidence: "ok" },
];

let state = {
  statusIndex: 0,
  playing: false,
  reducedMotion: false,
  loop: true,
  activeBar: 3,
  activeChordIndex: 0,
  mode: "Редактор",
  zoom: 1,
  modal: false,
  returnFocusAction: null,
};

const EVENT_TIMES = {
  1: [["0:12.000", "0:14.400"], ["0:14.400", "0:16.800"]],
  2: [["0:16.800", "0:18.400"], ["0:18.400", "0:21.120"]],
  3: [["0:21.120", "0:23.520"], ["0:23.520", "0:26.000"]],
  4: [["0:26.000", "0:28.400"], ["0:28.400", "0:31.000"]],
  5: [["0:31.000", "0:33.000"], ["0:33.000", "0:35.200"]],
  6: [["0:35.200", "0:39.800"]],
};

function activeBar() { return BARS[state.activeBar - 1]; }
function activeChord() { return activeBar().chords[state.activeChordIndex] || activeBar().chords[0]; }
function eventBeatLabel(bar, index) {
  if (bar.chords.length === 1) return `доли 1–${bar.meter[0]}`;
  const beats = Number(bar.meter[0]);
  const start = Math.floor(index * beats / bar.chords.length) + 1;
  const end = Math.max(start, Math.floor((index + 1) * beats / bar.chords.length));
  return start === end ? `доля ${start}` : `доли ${start}–${end}`;
}
function eventTimes(barNumber, index) {
  return EVENT_TIMES[barNumber]?.[index] || ["—", "—"];
}

const STATES = [
  { key: "ready", label: "Готово", title: "Проект готов", detail: "Все данные доступны. Правок: 3.", tone: "good" },
  { key: "loading", label: "Анализ", title: "Анализируем гармонию", detail: "Этап 3 из 5 · можно продолжать слушать предыдущую ревизию.", tone: "busy" },
  { key: "low", label: "Низкая уверенность", title: "Нужно проверить 2 места", detail: "Такты 2 и 5 отмечены текстом и узором, не только цветом.", tone: "warn" },
  { key: "error", label: "Ошибка", title: "Новая ревизия не создана", detail: "Исходный анализ и твои правки сохранены. Можно повторить этап.", tone: "danger" },
];

function selectedVariant() {
  const key = new URLSearchParams(location.search).get("variant") || "A";
  return VARIANTS[key] ? key : "A";
}

function setVariant(key) {
  const params = new URLSearchParams(location.search);
  params.set("variant", key);
  window.history.replaceState({}, "", `${location.pathname}?${params}`);
  render();
  announce(`Вариант ${VARIANTS[key]}`);
}

function cycleVariant(delta) {
  const keys = Object.keys(VARIANTS);
  const index = keys.indexOf(selectedVariant());
  setVariant(keys[(index + delta + keys.length) % keys.length]);
}

function status() { return STATES[state.statusIndex]; }
function announce(text) { document.querySelector("#announcer").textContent = text; }

function projectHeader(extra = "") {
  return `<header class="app-header">
    <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">◒</span><strong>Open Chords</strong></div>
    <div class="project-title"><strong>Плачь и танцуй</strong><span>Project Range 0:00–0:48</span></div>
    <div class="header-actions">
      <button class="quiet-button" data-action="cycle-status">Состояние: ${status().label}</button>
      <button class="quiet-button" data-action="motion" aria-pressed="${state.reducedMotion}">${state.reducedMotion ? "Обычное движение" : "Меньше движения"}</button>
      <button class="quiet-button" data-action="shortcuts" aria-haspopup="dialog">Клавиши</button>
      ${extra}
    </div>
  </header>`;
}

function statusBanner(compact = false) {
  const item = status();
  return `<section class="status-banner ${item.tone} ${compact ? "compact" : ""}" aria-label="Состояние проекта" ${item.key === "loading" ? 'aria-busy="true"' : ""}>
    <span class="status-symbol" aria-hidden="true">${item.key === "ready" ? "✓" : item.key === "loading" ? "◌" : item.key === "low" ? "!" : "×"}</span>
    <div><strong>${item.title}</strong><span>${item.detail}</span></div>
    ${item.key === "error" ? '<button class="text-button" data-action="retry">Повторить этап</button>' : ""}
  </section>`;
}

function transport(compact = false) {
  return `<section class="transport ${compact ? "compact" : ""}" aria-label="Проигрывание">
    <button class="transport-key" data-action="prev" aria-label="Предыдущий такт">‹</button>
    <button class="play-button" data-action="play" aria-label="${state.playing ? "Пауза" : "Воспроизвести"}" aria-pressed="${state.playing}">${state.playing ? "Ⅱ" : "▶"}</button>
    <button class="transport-key" data-action="next" aria-label="Следующий такт">›</button>
    <div class="time-readout"><strong>0:18.4</strong><span>/ 0:48</span></div>
    <button class="chip-button" data-action="loop" aria-pressed="${state.loop}">Луп: ${state.loop ? "2–4" : "выкл."}</button>
    <button class="chip-button">Скорость 0.85×</button>
    <button class="chip-button">Метроном</button>
  </section>`;
}

function timeline(options = {}) {
  const simple = options.simple || false;
  return `<section class="timeline-shell ${simple ? "simple" : ""}" aria-label="Музыкальный таймлайн">
    <div class="timeline-heading"><div><span class="eyebrow">Таймлайн</span><h2>Куплет 1 → Припев</h2></div><div class="legend"><span class="legend-low">Низкая уверенность</span><span>Playhead 0:18.4</span></div></div>
    <div class="timeline-scroll" tabindex="0" aria-label="Такты. Используй квадратные скобки для перехода">
      <div class="center-line" aria-hidden="true"></div>
      <div class="bars-track">
        ${BARS.map((bar) => `<article class="bar ${bar.number === state.activeBar ? "active" : ""} ${bar.confidence === "low" ? "low" : ""}" aria-label="Такт ${bar.number}, размер ${bar.meter}">
          <button class="bar-select" data-bar="${bar.number}" aria-current="${bar.number === state.activeBar ? "true" : "false"}"><span><b>Такт ${bar.number}</b><small>${bar.section}</small></span><small>${bar.meter}</small></button>
          <span class="beat-row" aria-hidden="true">${Array.from({ length: Number(bar.meter[0]) }, (_, i) => `<i class="${i === 0 ? "downbeat" : ""}"></i>`).join("")}</span>
          <span class="chord-row">${bar.chords.map((chord, index) => `<button class="chord-event ${bar.number === state.activeBar && index === state.activeChordIndex ? "selected" : ""}" data-chord-bar="${bar.number}" data-chord-index="${index}" aria-pressed="${bar.number === state.activeBar && index === state.activeChordIndex}"><b>${chord}</b><small>${eventBeatLabel(bar, index)}</small></button>`).join("")}</span>
          ${bar.confidence === "low" ? '<span class="confidence-label">! проверить</span>' : ""}
        </article>`).join("")}
      </div>
    </div>
  </section>`;
}

function libraryNav() {
  return `<nav class="library-panel" aria-label="Библиотека проектов">
    <div class="panel-heading"><span>Проекты</span><button class="icon-button" aria-label="Добавить проект">＋</button></div>
    <label class="search-label"><span class="sr-only">Поиск проектов</span><input type="search" placeholder="Найти проект"></label>
    <div class="project-list">${PROJECTS.map(([title, range, selected]) => `<button class="project-item ${selected}" ${selected ? 'aria-current="page"' : ""}><span>${title}</span><small>${range}</small></button>`).join("")}</div>
    <div class="nav-group"><span class="nav-caption">Коллекции</span><button>Недавние <small>8</small></button><button>Нужно проверить <small>3</small></button><button>Без медиа <small>1</small></button></div>
  </nav>`;
}

function inspector() {
  const bar = activeBar();
  const chord = activeChord();
  const [start, end] = eventTimes(bar.number, state.activeChordIndex);
  return `<aside class="inspector panel" aria-label="Редактор выбранного события аккорда">
    <div class="panel-heading"><div><span class="eyebrow">Редактор события</span><strong>Такт ${bar.number}</strong></div><span class="event-counter">${state.activeChordIndex + 1} из ${bar.chords.length}</span></div>
    <p class="inspector-help">В этом такте ${bar.chords.length === 1 ? "один аккорд" : `${bar.chords.length} аккорда`}. Выбери нужный:</p>
    <div class="event-picker" role="group" aria-label="Аккорды в такте ${bar.number}">${bar.chords.map((item, index) => `<button class="event-option ${index === state.activeChordIndex ? "selected" : ""}" data-chord-bar="${bar.number}" data-chord-index="${index}" aria-pressed="${index === state.activeChordIndex ? "true" : "false"}"><strong>${item}</strong><span>${eventBeatLabel(bar, index)}</span></button>`).join("")}</div>
    <button class="add-event-button" data-action="add-chord">＋ Добавить смену аккорда</button>
    <div class="selected-chord"><span>Позиция: ${eventBeatLabel(bar, state.activeChordIndex)}</span><strong>${chord}</strong><small>${bar.confidence === "low" ? "Низкая уверенность · проверь на слух" : "Событие можно изменить без удаления остальных"}</small></div>
    <div class="field-group"><label>Название аккорда<input id="chord-name" value="${chord}" autocomplete="off"></label><div class="timing-summary"><span>Начало<strong>${start}</strong></span><span>Конец<strong>${end}</strong></span></div></div>
    <div class="button-pair"><button class="primary-button" data-action="apply-chord">Сохранить аккорд</button><button class="danger-button" data-action="delete-chord" ${bar.chords.length === 1 ? "disabled" : ""}>Удалить этот аккорд</button></div>
    <p class="original-note">Original сохранён отдельно; удалить последний аккорд в такте нельзя.</p>
    <hr><h3>Диаграмма · гитара</h3><div class="diagram" role="img" aria-label="Диаграмма аккорда ${chord}"><span>●</span><span>○</span><span>●</span><span>○</span><span>●</span><span>○</span></div>
  </aside>`;
}

function variantA() {
  return `<div class="shell variant-a">${projectHeader('<button class="quiet-button">Все проекты</button>')}<div class="studio-grid">
    <main id="workspace-main" class="studio-main" tabindex="-1"><div class="editor-intro"><div><span class="eyebrow">Редактор</span><h1>Выбери конкретный аккорд на таймлайне</h1><p>Жёлтая рамка показывает событие, которое изменится справа. Такт и аккорд — разные уровни выбора.</p></div>${statusBanner(true)}</div>${timeline()}<section class="lyrics-strip" aria-label="Текст"><span class="eyebrow">Текст · выровнен частично</span><p>Я хотел бы остаться с тобой, <mark>просто остаться с тобой</mark></p></section></main>
    ${inspector()}
  </div><footer class="studio-footer">${transport()}</footer></div>`;
}

function modeTabs() {
  return `<nav class="mode-tabs" role="tablist" aria-label="Режим работы">${["Обзор", "Редактор", "Практика"].map((mode) => `<button role="tab" aria-selected="${state.mode === mode}" class="${state.mode === mode ? "selected" : ""}" data-mode="${mode}">${mode}</button>`).join("")}</nav>`;
}

function variantB() {
  const practice = state.mode === "Практика";
  return `<div class="shell variant-b">${projectHeader()}${modeTabs()}<main id="workspace-main" class="focus-main" tabindex="-1">
    ${statusBanner(true)}
    <section class="focus-context"><span class="breadcrumb">Проект / ${state.mode}</span><div class="focus-tools"><button class="quiet-button">Original</button><button class="quiet-button">Transpose +0</button><button class="quiet-button">Упрощение выкл.</button></div></section>
    ${practice ? `<section class="practice-stage" aria-label="Практика"><span class="eyebrow">Сейчас · такт ${state.activeBar}, ${eventBeatLabel(activeBar(), state.activeChordIndex)}</span><div class="hero-chord">${activeChord()}</div><p>Дальше <strong>${activeBar().chords[state.activeChordIndex + 1] || BARS[state.activeBar]?.chords[0] || "—"}</strong></p>${transport(true)}</section>` : timeline({ simple: true })}
    <section class="task-drawer" aria-label="Контекстные действия"><div><span class="eyebrow">${practice ? "Сохранённый луп" : "Выбранное событие"}</span><h2>${practice ? "Такты 2–4 · 0:12–0:31" : `Такт ${state.activeBar} · ${eventBeatLabel(activeBar(), state.activeChordIndex)} · ${activeChord()}`}</h2></div><div class="drawer-actions">${practice ? '<button class="primary-button">Начать с count-in</button><button class="quiet-button">Изменить луп</button>' : '<button class="primary-button">Открыть редактор события</button><button class="quiet-button">Сдвинуть границу</button><button class="quiet-button">Отменить</button>'}</div></section>
  </main></div>`;
}

function linearBars() {
  return `<ol class="linear-bars">${BARS.map((bar) => `<li class="${bar.number === state.activeBar ? "active" : ""}"><div class="linear-bar-row"><button class="linear-bar-name" data-bar="${bar.number}" aria-current="${bar.number === state.activeBar ? "true" : "false"}"><span class="linear-number">${bar.number}</span><span><strong>Такт ${bar.number} · ${bar.meter}</strong><small>${bar.section}</small></span></button><div class="linear-event-list" aria-label="События такта ${bar.number}">${bar.chords.map((chord, index) => `<button class="linear-event ${bar.number === state.activeBar && index === state.activeChordIndex ? "selected" : ""}" data-chord-bar="${bar.number}" data-chord-index="${index}"><strong>${chord}</strong><small>${eventBeatLabel(bar, index)}</small></button>`).join("")}</div><span class="linear-status">${bar.confidence === "low" ? "! Низкая уверенность" : "Проверено"}</span></div></li>`).join("")}</ol>`;
}

function variantC() {
  return `<div class="shell variant-c">${projectHeader()}<main id="workspace-main" class="linear-main" tabindex="-1">
    <nav class="jump-nav" aria-label="Разделы рабочей области"><a href="#linear-status">Состояние</a><a href="#linear-playback">Проигрывание</a><a href="#linear-timeline">Таймлайн</a><a href="#linear-edit">Редактор</a><a href="#linear-lyrics">Текст</a></nav>
    <section id="linear-status" class="linear-section"><h1>Плачь и танцуй</h1>${statusBanner()}</section>
    <section id="linear-playback" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Проигрывание</span><h2>Такт ${state.activeBar} · ${eventBeatLabel(activeBar(), state.activeChordIndex)}</h2></div><span class="big-chord">${activeChord()}</span></div>${transport()}</section>
    <section id="linear-timeline" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Таймлайн</span><h2>6 тактов</h2></div><p>Выбери строку; пробел запускает playback.</p></div>${linearBars()}</section>
    <section id="linear-edit" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Редактор события</span><h2>Такт ${state.activeBar} · ${eventBeatLabel(activeBar(), state.activeChordIndex)} · ${activeChord()}</h2></div><button class="primary-button">Изменить выбранное событие</button></div><dl class="facts"><div><dt>Событий в такте</dt><dd>${activeBar().chords.length}</dd></div><div><dt>Состояние</dt><dd>${activeBar().confidence === "low" ? "Низкая уверенность" : "Проверено"}</dd></div><div><dt>Граница</dt><dd>${eventTimes(state.activeBar, state.activeChordIndex).join("–")}</dd></div></dl></section>
    <section id="linear-lyrics" class="linear-section"><span class="eyebrow">Текст</span><h2>Строка в текущем такте</h2><p class="large-lyrics">Я хотел бы остаться с тобой, просто остаться с тобой</p><p class="supporting">2 слова требуют проверки времени.</p></section>
  </main></div>`;
}

function switcher() {
  const key = selectedVariant();
  return `<nav class="prototype-switcher" aria-label="Варианты прототипа"><button data-variant-delta="-1" aria-label="Предыдущий вариант">←</button><strong>${VARIANTS[key]}</strong><button data-variant-delta="1" aria-label="Следующий вариант">→</button></nav>`;
}

function modal() {
  if (!state.modal) return "";
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div class="panel-heading"><h2 id="shortcut-title">Клавиши</h2><button class="icon-button" data-action="close-modal" aria-label="Закрыть">×</button></div><dl class="shortcut-list"><div><dt>Space</dt><dd>Play / pause</dd></div><div><dt>[ / ]</dt><dd>Предыдущий / следующий такт</dd></div><div><dt>L</dt><dd>Включить или выключить луп</dd></div><div><dt>← / →</dt><dd>Сменить вариант прототипа</dd></div><div><dt>Esc</dt><dd>Закрыть окно</dd></div></dl></section></div>`;
}

function render() {
  const key = selectedVariant();
  document.documentElement.classList.toggle("reduced-motion", state.reducedMotion);
  document.documentElement.style.setProperty("--workspace-scale", state.zoom);
  const page = key === "A" ? variantA() : key === "B" ? variantB() : variantC();
  document.querySelector("#app").innerHTML = `${page}${switcher()}${modal()}`;
  wireActions();
  if (state.modal) document.querySelector('[data-action="close-modal"]').focus();
}

function act(type, source) {
  const restoreAction = source?.dataset.action && !["shortcuts", "close-modal"].includes(type) ? source.dataset.action : null;
  if (type === "cycle-status") state.statusIndex = (state.statusIndex + 1) % STATES.length;
  if (type === "motion") state.reducedMotion = !state.reducedMotion;
  if (type === "play") state.playing = !state.playing;
  if (type === "loop") state.loop = !state.loop;
  if (type === "prev") { state.activeBar = Math.max(1, state.activeBar - 1); state.activeChordIndex = 0; }
  if (type === "next") { state.activeBar = Math.min(BARS.length, state.activeBar + 1); state.activeChordIndex = 0; }
  if (type === "apply-chord") {
    const value = document.querySelector("#chord-name")?.value.trim();
    if (value) activeBar().chords[state.activeChordIndex] = value;
  }
  if (type === "add-chord") {
    activeBar().chords.splice(state.activeChordIndex + 1, 0, "N");
    EVENT_TIMES[activeBar().number].splice(state.activeChordIndex + 1, 0, ["Задать", "Задать"]);
    state.activeChordIndex += 1;
  }
  if (type === "delete-chord" && activeBar().chords.length > 1) {
    activeBar().chords.splice(state.activeChordIndex, 1);
    EVENT_TIMES[activeBar().number].splice(state.activeChordIndex, 1);
    state.activeChordIndex = Math.min(state.activeChordIndex, activeBar().chords.length - 1);
  }
  if (type === "retry") state.statusIndex = 1;
  if (type === "shortcuts") { state.modal = true; state.returnFocusAction = source.dataset.action; }
  if (type === "close-modal") { state.modal = false; }
  const returnAction = type === "close-modal" ? state.returnFocusAction : null;
  const actionAnnouncement = type === "apply-chord" ? `Аккорд сохранён: ${activeChord()}` : type === "add-chord" ? "Добавлено новое событие аккорда" : type === "delete-chord" ? "Событие аккорда удалено" : "Рабочая область обновлена";
  announce(type === "cycle-status" ? `${status().title}. ${status().detail}` : actionAnnouncement);
  render();
  if (returnAction) { document.querySelector(`[data-action="${returnAction}"]`)?.focus(); state.returnFocusAction = null; }
  else if (restoreAction) document.querySelector(`[data-action="${restoreAction}"]`)?.focus();
}

function wireActions() {
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => act(button.dataset.action, button)));
  document.querySelectorAll("[data-variant-delta]").forEach((button) => button.addEventListener("click", () => cycleVariant(Number(button.dataset.variantDelta))));
  document.querySelectorAll("[data-bar]").forEach((button) => button.addEventListener("click", () => { state.activeBar = Number(button.dataset.bar); state.activeChordIndex = 0; announce(`Выбран такт ${state.activeBar}, первый аккорд ${activeChord()}`); render(); document.querySelector(`[data-bar="${state.activeBar}"]`)?.focus(); }));
  document.querySelectorAll("[data-chord-bar]").forEach((button) => button.addEventListener("click", () => {
    state.activeBar = Number(button.dataset.chordBar);
    state.activeChordIndex = Number(button.dataset.chordIndex);
    announce(`Выбран аккорд ${activeChord()}, такт ${state.activeBar}, ${eventBeatLabel(activeBar(), state.activeChordIndex)}`);
    render();
    document.querySelector(`[data-chord-bar="${state.activeBar}"][data-chord-index="${state.activeChordIndex}"]`)?.focus();
  }));
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => { state.mode = button.dataset.mode; announce(`Режим ${state.mode}`); render(); document.querySelector(`[data-mode="${state.mode}"]`)?.focus(); });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const modes = ["Обзор", "Редактор", "Практика"];
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      state.mode = modes[(modes.indexOf(button.dataset.mode) + delta + modes.length) % modes.length];
      announce(`Режим ${state.mode}`);
      render();
      document.querySelector(`[data-mode="${state.mode}"]`)?.focus();
    });
  });
}

document.addEventListener("keydown", (event) => {
  const interactive = event.target.matches("input, textarea, select, button, a, [contenteditable], [role=button], [role=tab]");
  if (event.key === "Escape" && state.modal) { event.preventDefault(); act("close-modal"); return; }
  if (state.modal && event.key === "Tab") {
    const focusable = [...document.querySelectorAll(".modal button, .modal a, .modal input")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
  if (interactive || state.modal) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); cycleVariant(-1); }
  if (event.key === "ArrowRight") { event.preventDefault(); cycleVariant(1); }
  if (event.key === " ") { event.preventDefault(); act("play"); }
  if (event.key === "[") { event.preventDefault(); act("prev"); }
  if (event.key === "]") { event.preventDefault(); act("next"); }
  if (event.key.toLowerCase() === "l") { event.preventDefault(); act("loop"); }
});

render();
