/* Three visual variants of the editor/practice behavior, switchable via ?variant=. */

const VARIANTS = {
  A: "A — Таймлайн",
  B: "B — Практика",
  C: "C — До / сейчас",
};

const BASE = {
  bars: [
    { id: "bar-1", start: 0, end: 25, meter: "4/4" },
    { id: "bar-2", start: 25, end: 50, meter: "4/4" },
    { id: "bar-3", start: 50, end: 75, meter: "4/4" },
    { id: "bar-4", start: 75, end: 100, meter: "4/4" },
  ],
  chords: [
    { id: "chord-1", start: 0, end: 12.5, value: "C" },
    { id: "chord-2", start: 12.5, end: 25, value: "G" },
    { id: "chord-3", start: 25, end: 37.5, value: "Am" },
    { id: "chord-4", start: 37.5, end: 50, value: "F" },
    { id: "chord-5", start: 50, end: 62.5, value: "C" },
    { id: "chord-6", start: 62.5, end: 75, value: "G7" },
    { id: "chord-7", start: 75, end: 87.5, value: "Am" },
    { id: "chord-8", start: 87.5, end: 100, value: "F" },
  ],
};

let editor = freshEditor();
let practice = { speed: 1, transpose: 0, beginner: false, loop: null };
let message = {
  title: "Сначала просто посмотри",
  text: "Сверху — исходный анализ. Снизу — то, что получится после твоих правок. Машинный результат никогда не переписывается.",
  tone: "normal",
};

function freshEditor() {
  return { snapshots: [clone(BASE)], labels: ["Исходный анализ"], cursor: 0, branchesKept: 0 };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function current() { return editor.snapshots[editor.cursor]; }

function commit(label, mutate) {
  const next = clone(current());
  mutate(next);
  if (editor.cursor < editor.snapshots.length - 1) {
    editor.branchesKept += editor.snapshots.length - editor.cursor - 1;
  }
  editor.snapshots = editor.snapshots.slice(0, editor.cursor + 1);
  editor.labels = editor.labels.slice(0, editor.cursor + 1);
  editor.snapshots.push(next);
  editor.labels.push(label);
  editor.cursor += 1;
}

function loopStatus(data = current()) {
  if (!practice.loop) return { status: "none", text: "Луп ещё не сохранён" };
  const start = data.bars.find((bar) => bar.id === practice.loop.start);
  const end = data.bars.find((bar) => bar.id === practice.loop.end);
  if (!start || !end || data.reviewLoop) {
    return { status: "review", text: "Нужно подтвердить границы лупа после изменения структуры тактов" };
  }
  return { status: "valid", text: `Луп: такты 2–3 · ${formatTime(start.start)}–${formatTime(end.end)}` };
}

function formatTime(percent) {
  const seconds = Math.round(percent * 0.48);
  return `0:${String(seconds).padStart(2, "0")}`;
}

function action(type) {
  if (type === "save-loop") {
    practice.loop = { start: "bar-2", end: "bar-3" };
    message = { title: "Луп сохранён", text: "Он привязан к тактам 2–3, а не к случайным секундам.", tone: "good" };
  }
  if (type === "move-boundary") {
    commit("Сдвинута граница перед тактом 2", (data) => {
      const left = data.bars.find((bar) => bar.id === "bar-1");
      const right = data.bars.find((bar) => bar.id === "bar-2");
      left.end = 28; right.start = 28;
    });
    message = { title: "Луп последовал за тактом", text: "Обычный сдвиг границы не меняет смысл лупа: он всё ещё охватывает такты 2–3.", tone: "good" };
  }
  if (type === "split-bar") {
    commit("Такт 2 разделён", (data) => {
      const index = data.bars.findIndex((bar) => bar.id === "bar-2");
      const bar = data.bars[index];
      const middle = (bar.start + bar.end) / 2;
      const right = { id: `bar-user-${editor.cursor + 1}`, start: middle, end: bar.end, meter: "2/4", changed: true };
      bar.end = middle; bar.meter = "2/4"; bar.changed = true;
      data.bars.splice(index + 1, 0, right);
      data.reviewLoop = true;
    });
    message = { title: "Луп требует подтверждения", text: "Такт 2 теперь означает другое. Open Chords не выбирает новые границы молча.", tone: "review" };
  }
  if (type === "change-chord") {
    commit("Am заменён на Cmaj7", (data) => {
      data.chords.find((chord) => chord.id === "chord-3").value = "Cmaj7";
    });
    message = { title: "Аккорд изменён", text: "Верхний ряд остаётся Am. Текущий результат показывает Cmaj7 как пользовательскую правку.", tone: "good" };
  }
  if (type === "undo" && editor.cursor > 0) {
    editor.cursor -= 1;
    message = { title: "Правка отменена", text: "Скорость, транспонирование и сохранённый луп не откатились — они принадлежат другим слоям состояния.", tone: "normal" };
  }
  if (type === "redo" && editor.cursor < editor.snapshots.length - 1) {
    editor.cursor += 1;
    message = { title: "Правка возвращена", text: editor.labels[editor.cursor], tone: "normal" };
  }
  if (type === "reset") {
    editor.cursor = 0;
    message = { title: "Правки сброшены", text: "Таймлайн снова совпадает с машинным анализом. Настройки практики и отображения сохранены.", tone: "normal" };
  }
  if (type === "speed") {
    const speeds = [0.5, 0.75, 1, 1.25];
    practice.speed = speeds[(speeds.indexOf(practice.speed) + 1) % speeds.length];
    message = { title: `Скорость ${practice.speed}×`, text: "Это настройка практики; она не создаёт правку музыкального таймлайна.", tone: "normal" };
  }
  if (type === "transpose") {
    practice.transpose = (practice.transpose + 1) % 12;
    message = { title: `Транспонирование +${practice.transpose}`, text: "Меняется только отображение. Исходные аккорды остаются прежними.", tone: "normal" };
  }
  if (type === "beginner") {
    practice.beginner = !practice.beginner;
    message = { title: `Упрощение аккордов ${practice.beginner ? "включено" : "выключено"}`, text: "Упрощение применяется только при показе и не переписывает аккорды.", tone: "normal" };
  }
  render();
}

function displayedChord(value) {
  let result = value;
  if (practice.beginner) result = value.startsWith("Am") ? "Am" : value.replace(/maj7|7|sus4/g, "");
  if (practice.transpose) result += ` ↑${practice.transpose}`;
  return result;
}

function header() {
  return `<header class="app-header">
    <div class="brand">Open Chords</div><div class="project-name">Плачь и танцуй · проект 0:00–0:48</div>
    <div class="header-spacer"></div><div class="status-pill">Все изменения сохраняют оригинал</div>
  </header>`;
}

function timeline(data, options = {}) {
  const loop = loopStatus(data);
  const playhead = 34;
  const bars = data.bars.map((bar, index) => {
    const looped = practice.loop && ["bar-2", "bar-3"].includes(bar.id);
    const cls = ["bar-block", looped ? "looped" : "", loop.status === "review" && looped ? "review" : ""].join(" ");
    const beatCount = Number(bar.meter.split("/")[0]) || 4;
    return `<div class="${cls}" style="width:${bar.end - bar.start}%">
      <div class="bar-number">Такт ${index + 1}</div><div class="meter">${bar.meter}</div>
      <div class="beat-dots">${Array.from({length: beatCount}, () => "<i></i>").join("")}</div>
    </div>`;
  }).join("");
  const chords = data.chords.map((chord) => `<div class="chord-block ${chord.start <= playhead && chord.end > playhead ? "current" : ""}" style="width:${chord.end - chord.start}%">
    <div class="chord-name">${displayedChord(chord.value)}</div>${options.original ? "" : `<div class="original-name">Исходно: ${BASE.chords.find((item) => item.id === chord.id)?.value || chord.value}</div>`}
  </div>`).join("");
  return `<div class="timeline">
    <div class="timeline-label">${options.label || "Текущий таймлайн"}</div>
    <div class="bar-row">${bars}</div><div class="chord-row">${chords}</div>
    ${options.playhead === false ? "" : "<div class=\"playhead\"></div>"}
  </div>`;
}

function loopBanner() {
  const loop = loopStatus();
  return `<div class="loop-banner ${loop.status === "review" ? "review" : ""}"><i class="loop-dot"></i><strong>${loop.text}</strong></div>`;
}

function editActions() {
  return `<div class="tool-stack">
    <button class="action primary" data-action="save-loop">Сохранить такты 2–3 как луп</button>
    <button class="action" data-action="move-boundary">Сдвинуть начало такта 2</button>
    <button class="action" data-action="split-bar">Разделить такт 2</button>
    <button class="action" data-action="change-chord">Заменить Am на Cmaj7</button>
    <button class="action" data-action="undo" ${editor.cursor === 0 ? "disabled" : ""}>Отменить правку</button>
    <button class="action" data-action="redo" ${editor.cursor >= editor.snapshots.length - 1 ? "disabled" : ""}>Вернуть правку</button>
    <button class="action danger" data-action="reset">Сбросить все правки</button>
  </div>`;
}

function practiceControls() {
  return `<div class="action-row">
    <button class="action" data-action="speed">Скорость ${practice.speed}×</button>
    <button class="action" data-action="transpose">Транспонирование +${practice.transpose}</button>
    <button class="action" data-action="beginner">Упрощение ${practice.beginner ? "вкл." : "выкл."}</button>
  </div>`;
}

function explanation() {
  return `<div class="explanation">
    <div class="eyebrow">Что произошло</div><h2>${message.title}</h2><p>${message.text}</p>
    <div class="layer-list">
      <div class="layer"><strong>1. Машинный анализ</strong><span>Всегда хранится без изменений</span></div>
      <div class="layer"><strong>2. Твои правки · ${editor.cursor}</strong><span>Можно отменить, вернуть или сбросить</span></div>
      <div class="layer"><strong>3. Практика и вид</strong><span>Луп, скорость, транспонирование и упрощение не входят в отмену правок</span></div>
    </div>
  </div>`;
}

function historyPanel() {
  return `<div class="history-list">
    <div class="history-item machine">Исходный анализ</div>
    ${editor.labels.slice(1, editor.cursor + 1).map((label) => `<div class="history-item">${label}</div>`).join("") || `<div class="muted">Правок пока нет</div>`}
    ${editor.branchesKept ? `<div class="muted">Сохранено альтернативных веток: ${editor.branchesKept}</div>` : ""}
  </div>`;
}

function variantA() {
  return `<div class="shell variant-a">${header()}<main class="workspace">
    <aside class="panel tool-rail"><h2 class="panel-title">Действия</h2>${editActions()}</aside>
    <section class="center">${loopBanner()}${timeline(current())}<div class="panel practice-strip"><strong>Практика</strong><div class="spacer"></div>${practiceControls()}</div></section>
    <aside class="panel inspector">${explanation()}<hr style="border:0;border-top:1px solid var(--line)"><div style="padding:18px"><h2 class="panel-title">История правок</h2>${historyPanel()}</div></aside>
  </main></div>`;
}

function variantB() {
  const chord = current().chords.find((item) => item.start <= 34 && item.end > 34);
  const next = current().chords[current().chords.indexOf(chord) + 1];
  return `<div class="shell variant-b">${header()}<main class="stage">
    <aside class="panel stage-side"><h2 class="panel-title">Луп и практика</h2>${loopBanner()}<div style="height:12px"></div>${practiceControls()}</aside>
    <section class="hero-chord">
      <div class="current-label">Сейчас</div><div class="hero-name">${displayedChord(chord.value)}</div>
      <div class="next-line">Дальше <strong>${displayedChord(next.value)}</strong></div>
      <div class="action-row practice-actions"><button class="transport-button">▶</button><button class="action primary" data-action="save-loop">Луп: такты 2–3</button></div>
      <div class="mini-timeline">${timeline(current(), {label: "Такты движутся под красной линией"})}</div>
    </section>
    <aside class="panel stage-side"><h2 class="panel-title">Быстрая правка</h2>${editActions()}<div style="height:14px"></div>${explanation()}</aside>
  </main></div>`;
}

function simpleCompare(data, machine = false) {
  return `<div class="simple-bars">${data.bars.map((bar, index) => {
    const changed = !machine && (bar.changed || bar.start !== BASE.bars.find((item) => item.id === bar.id)?.start || bar.end !== BASE.bars.find((item) => item.id === bar.id)?.end);
    const review = !machine && loopStatus(data).status === "review" && ["bar-2", "bar-3"].includes(bar.id);
    const chords = data.chords.filter((chord) => chord.start >= bar.start && chord.start < bar.end).map((chord) => displayedChord(chord.value)).join(" · ");
    return `<div class="simple-bar ${changed ? "changed" : ""} ${review ? "review" : ""}" style="width:${bar.end - bar.start}%"><span class="muted">Такт ${index + 1} · ${bar.meter}</span><div class="simple-chords">${chords}</div></div>`;
  }).join("")}</div>`;
}

function variantC() {
  return `<div class="shell variant-c">${header()}<main class="compare-layout">
    <section class="compare-stack">
      <div class="panel compare-card machine-view"><div class="compare-heading"><h2>Исходный анализ</h2><span class="muted">только чтение · всегда сохранён</span></div>${simpleCompare(BASE, true)}</div>
      <div style="text-align:center;color:var(--accent);font-size:22px">↓ <span style="font-size:13px">применяем твои правки, не меняя оригинал</span></div>
      <div class="panel compare-card"><div class="compare-heading"><h2>Текущий результат</h2><span class="muted">используется для проигрывания, практики и экспорта</span></div>${simpleCompare(current())}</div>
      ${loopBanner()}
      <div class="panel practice-strip"><strong>Не входит в отмену правок</strong><div class="spacer"></div>${practiceControls()}</div>
      <div class="panel" style="padding:16px"><h2 class="panel-title">История правок</h2>${historyPanel()}</div>
    </section>
    <aside class="panel decision-panel"><div class="eyebrow">Проверяем поведение</div><h1>${message.title}</h1><p class="muted" style="line-height:1.55">${message.text}</p>
      <div class="big-actions">${editActions()}</div>
      <div class="state-separation"><div class="state-chip">Оригинал<br><strong>не меняется</strong></div><div class="state-chip changed">Правок<br><strong>${editor.cursor}</strong></div><div class="state-chip">Практика<br><strong>отдельно</strong></div></div>
    </aside>
  </main></div>`;
}

function selectedVariant() {
  const value = new URLSearchParams(location.search).get("variant") || "C";
  return VARIANTS[value] ? value : "C";
}

function setVariant(value) {
  const url = new URL(location.href);
  url.searchParams.set("variant", value);
  window.history.replaceState({}, "", url);
  render();
}

function cycleVariant(direction) {
  const keys = Object.keys(VARIANTS);
  const index = keys.indexOf(selectedVariant());
  setVariant(keys[(index + direction + keys.length) % keys.length]);
}

function render() {
  const variant = selectedVariant();
  document.getElementById("app").innerHTML = variant === "A" ? variantA() : variant === "B" ? variantB() : variantC();
  document.getElementById("variant-label").textContent = VARIANTS[variant];
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => action(button.dataset.action)));
}

document.getElementById("variant-prev").addEventListener("click", () => cycleVariant(-1));
document.getElementById("variant-next").addEventListener("click", () => cycleVariant(1));
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (event.key === "ArrowLeft") cycleVariant(-1);
  if (event.key === "ArrowRight") cycleVariant(1);
});
window.addEventListener("popstate", render);
render();
