/* Three workspace variants for one state, switchable via ?variant=. */

const VARIANTS = {
  A: "A — Студия",
  B: "B — Одна задача",
  C: "C — Линейно",
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
  mode: "Редактор",
  zoom: 1,
  modal: false,
  returnFocusAction: null,
};

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
        ${BARS.map((bar) => `<button class="bar ${bar.number === state.activeBar ? "active" : ""} ${bar.confidence === "low" ? "low" : ""}" data-bar="${bar.number}" aria-current="${bar.number === state.activeBar ? "true" : "false"}" aria-label="Такт ${bar.number}, размер ${bar.meter}, ${bar.chords.join(" затем ")}${bar.confidence === "low" ? ", низкая уверенность" : ""}">
          <span class="bar-top"><b>Такт ${bar.number}</b><small>${bar.meter}</small></span>
          <span class="beat-row" aria-hidden="true">${Array.from({ length: Number(bar.meter[0]) }, (_, i) => `<i class="${i === 0 ? "downbeat" : ""}"></i>`).join("")}</span>
          <span class="chord-row">${bar.chords.map((chord) => `<b>${chord}</b>`).join("")}</span>
          ${bar.confidence === "low" ? '<span class="confidence-label">! проверить</span>' : ""}
        </button>`).join("")}
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
  return `<aside class="inspector panel" aria-label="Инспектор выбранного аккорда">
    <div class="panel-heading"><span>Выбрано</span><button class="icon-button" aria-label="Закрыть инспектор">×</button></div>
    <div class="selected-chord"><span>Такт ${state.activeBar}</span><strong>${BARS[state.activeBar - 1].chords[0]}</strong><small>${BARS[state.activeBar - 1].confidence === "low" ? "Низкая уверенность · проверь на слух" : "Пользовательская правка"}</small></div>
    <div class="field-group"><label>Аккорд<input value="${BARS[state.activeBar - 1].chords[0]}"></label><label>Начало<input value="0:18.400"></label><label>Конец<input value="0:21.120"></label></div>
    <div class="button-pair"><button class="primary-button">Применить</button><button class="quiet-button">Вернуть Original</button></div>
    <hr><h3>Диаграмма · гитара</h3><div class="diagram" role="img" aria-label="Диаграмма аккорда ${BARS[state.activeBar - 1].chords[0]}"><span>●</span><span>○</span><span>●</span><span>○</span><span>●</span><span>○</span></div>
  </aside>`;
}

function variantA() {
  return `<div class="shell variant-a">${projectHeader()}<div class="studio-grid">
    ${libraryNav()}
    <main id="workspace-main" class="studio-main" tabindex="-1">${statusBanner(true)}${timeline()}<section class="lyrics-strip" aria-label="Текст"><span class="eyebrow">Текст · выровнен частично</span><p>Я хотел бы остаться с тобой, <mark>просто остаться с тобой</mark></p></section></main>
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
    ${practice ? `<section class="practice-stage" aria-label="Практика"><span class="eyebrow">Сейчас · такт ${state.activeBar}</span><div class="hero-chord">${BARS[state.activeBar - 1].chords[0]}</div><p>Дальше <strong>${BARS[state.activeBar - 1].chords[1] || BARS[state.activeBar].chords[0]}</strong></p>${transport(true)}</section>` : timeline({ simple: true })}
    <section class="task-drawer" aria-label="Контекстные действия"><div><span class="eyebrow">${practice ? "Сохранённый луп" : "Быстрая правка"}</span><h2>${practice ? "Такты 2–4 · 0:12–0:31" : `Такт ${state.activeBar} · ${BARS[state.activeBar - 1].chords[0]}`}</h2></div><div class="drawer-actions">${practice ? '<button class="primary-button">Начать с count-in</button><button class="quiet-button">Изменить луп</button>' : '<button class="primary-button">Изменить аккорд</button><button class="quiet-button">Сдвинуть границу</button><button class="quiet-button">Отменить</button>'}</div></section>
  </main></div>`;
}

function linearBars() {
  return `<ol class="linear-bars">${BARS.map((bar) => `<li class="${bar.number === state.activeBar ? "active" : ""}"><button data-bar="${bar.number}" aria-current="${bar.number === state.activeBar ? "true" : "false"}"><span class="linear-number">${bar.number}</span><span><strong>Такт ${bar.number} · ${bar.meter}</strong><small>${bar.section}</small></span><span class="linear-chords">${bar.chords.join(" → ")}</span><span class="linear-status">${bar.confidence === "low" ? "! Низкая уверенность" : "Проверено"}</span></button></li>`).join("")}</ol>`;
}

function variantC() {
  return `<div class="shell variant-c">${projectHeader()}<main id="workspace-main" class="linear-main" tabindex="-1">
    <nav class="jump-nav" aria-label="Разделы рабочей области"><a href="#linear-status">Состояние</a><a href="#linear-playback">Проигрывание</a><a href="#linear-timeline">Таймлайн</a><a href="#linear-edit">Редактор</a><a href="#linear-lyrics">Текст</a></nav>
    <section id="linear-status" class="linear-section"><h1>Плачь и танцуй</h1>${statusBanner()}</section>
    <section id="linear-playback" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Проигрывание</span><h2>Сейчас такт ${state.activeBar}</h2></div><span class="big-chord">${BARS[state.activeBar - 1].chords[0]}</span></div>${transport()}</section>
    <section id="linear-timeline" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Таймлайн</span><h2>6 тактов</h2></div><p>Выбери строку; пробел запускает playback.</p></div>${linearBars()}</section>
    <section id="linear-edit" class="linear-section"><div class="section-heading"><div><span class="eyebrow">Редактор</span><h2>Выбран такт ${state.activeBar}</h2></div><button class="primary-button">Изменить аккорд</button></div><dl class="facts"><div><dt>Original</dt><dd>${BARS[state.activeBar - 1].chords[0]}</dd></div><div><dt>Состояние</dt><dd>${BARS[state.activeBar - 1].confidence === "low" ? "Низкая уверенность" : "Проверено"}</dd></div><div><dt>Граница</dt><dd>0:18.400–0:21.120</dd></div></dl></section>
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
  if (type === "prev") state.activeBar = Math.max(1, state.activeBar - 1);
  if (type === "next") state.activeBar = Math.min(BARS.length, state.activeBar + 1);
  if (type === "retry") state.statusIndex = 1;
  if (type === "shortcuts") { state.modal = true; state.returnFocusAction = source.dataset.action; }
  if (type === "close-modal") { state.modal = false; }
  const returnAction = type === "close-modal" ? state.returnFocusAction : null;
  announce(type === "cycle-status" ? `${status().title}. ${status().detail}` : "Рабочая область обновлена");
  render();
  if (returnAction) { document.querySelector(`[data-action="${returnAction}"]`)?.focus(); state.returnFocusAction = null; }
  else if (restoreAction) document.querySelector(`[data-action="${restoreAction}"]`)?.focus();
}

function wireActions() {
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => act(button.dataset.action, button)));
  document.querySelectorAll("[data-variant-delta]").forEach((button) => button.addEventListener("click", () => cycleVariant(Number(button.dataset.variantDelta))));
  document.querySelectorAll("[data-bar]").forEach((button) => button.addEventListener("click", () => { state.activeBar = Number(button.dataset.bar); announce(`Выбран такт ${state.activeBar}`); render(); document.querySelector(`[data-bar="${state.activeBar}"]`)?.focus(); }));
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
