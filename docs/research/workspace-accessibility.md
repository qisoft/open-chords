# Open Chords v1: проверяемые требования к доступности desktop workspace

> Исследование для Wayfinder ticket `Fix workspace UX and accessibility behavior`. Источники проверены 2026-08-16. Использованы только спецификации W3C и официальные материалы W3C WAI, Apple, Microsoft, Chromium и Electron. Документ задаёт ограничения и проверяемые acceptance criteria, но не выбирает layout или визуальный стиль продукта.

## Краткий итог

1. **Практичная базовая цель для renderer — WCAG 2.2 Level AA.** WCAG — W3C Recommendation с technology-neutral проверяемыми success criteria. Для Electron это применимо к HTML workspace как к web content, но утверждение о соответствии всего desktop-приложения потребует явно заданного scope и прохождения complete processes, а не только автоматического аудита ([WCAG 2.2: status and conformance](https://www.w3.org/TR/WCAG22/#conformance)).
2. **WAI-ARIA APG не является вторым стандартом соответствия.** APG сам называет свои patterns информативной guidance и предупреждает, что примерный код не предназначен для production без адаптации. Нормативны WCAG и WAI-ARIA semantics; APG полезен как исходная keyboard/focus модель для composite widgets ([APG Introduction: APG is Not a Normative Standard](https://www.w3.org/WAI/ARIA/apg/about/introduction/), [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)).
3. **Музыкальный timeline нельзя оставлять только нарисованным canvas и drag-жестами.** Его информация, текущие значения и действия должны быть доступны через accessibility tree; все операции должны иметь keyboard path, а drag — single-pointer alternative. Цвет не может быть единственным носителем confidence, selection, error или playback state ([WCAG 1.3.1, 1.4.1, 2.1.1, 2.5.7, 4.1.2](https://www.w3.org/TR/WCAG22/)).
4. **Динамический playhead не должен превращаться в речевой поток.** Текущее время можно представить как именованный slider/timer, но live region должен сообщать только значимые результаты, ошибки и изменения режима. `status` имеет polite live semantics, `alert` — assertive; перенос фокуса для обычного статуса не требуется ([WAI-ARIA `status`](https://www.w3.org/TR/wai-aria-1.2/#status), [`alert`](https://www.w3.org/TR/wai-aria-1.2/#alert), [WCAG 4.1.3](https://www.w3.org/TR/WCAG22/#status-messages)).
5. **Проверка должна быть нативной на обеих ОС.** Electron передаёт HTML accessibility tree платформенным assistive technologies; релизная проверка должна включать VoiceOver + Accessibility Inspector на macOS и Narrator + Accessibility Insights/UI Automation tree на Windows. DOM-аудит сам по себе этого не доказывает ([Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility), [Apple Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector), [Microsoft accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing)).

## 1. Нормативная граница

### 1.1 Что считать обязательным

Ниже слово **требование** означает: критерий становится release requirement, если Open Chords принимает **WCAG 2.2 AA для всего Electron renderer и завершённых пользовательских сценариев** как целевой профиль. WCAG требует удовлетворить все критерии A и AA, применимые к выбранному scope, и отдельно требует охватить complete processes ([conformance levels and complete processes](https://www.w3.org/TR/WCAG22/#conformance-reqs)).

WCAG создан для web content. Он не сертифицирует автоматически native shell, системные file dialogs, embedded YouTube player или содержимое, которое пользователь импортировал и которым Open Chords не управляет. Такие границы надо перечислить в будущем conformance statement; third-party content имеет отдельную модель partial conformance и не освобождает собственные controls от non-interference ([WCAG conformance](https://www.w3.org/TR/WCAG22/#conformance), [partial conformance for third-party content](https://www.w3.org/TR/WCAG22/#cc3)).

### 1.2 Что является рекомендацией

- APG patterns и их key bindings — **design recommendations**, а не нормативные success criteria. APG отмечает, что устоявшиеся keyboard conventions всё же разумно рассматривать как engineering requirements, если pattern выбран ([APG Introduction](https://www.w3.org/WAI/ARIA/apg/about/introduction/)).
- Apple Human Interface Guidelines, VoiceOver workflows и Microsoft app guidance — platform guidance и проверочные сценарии; они не заменяют WCAG conformance.
- AAA-критерии WCAG, отмеченные ниже, — усиленная рекомендация для длительного desktop workspace, но не часть AA gate.

## 2. WCAG 2.2 AA: требования, применимые к workspace

Официальный источник для всех строк — [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Таблица переводит критерии в проверяемые условия Open Chords, не меняя их нормативный смысл.

| WCAG | Нормативное условие | Проверка в Open Chords |
|---|---|---|
| 1.1.1 Non-text Content (A) | Значимое non-text content имеет equivalent text alternative; input/control имеет name, описывающий purpose. | Chord/instrument diagrams, waveform-only markers и icon-only controls имеют доступные имена или эквивалентную структурированную текстовую информацию. Декор скрыт от accessibility tree. |
| 1.3.1 Info and Relationships (A) | Визуальные structure/relationships доступны программно или в тексте. | Bars, beats, chord events, sections, selection, Current/Original и edit state имеют semantic structure; координаты canvas не являются единственным источником связи. |
| 1.3.2 Meaningful Sequence (A) | Если порядок влияет на смысл, он programmatically determinable. | Accessibility/DOM order воспроизводит музыкальную и рабочую последовательность, а не случайный порядок слоёв canvas/CSS. |
| 1.3.3 Sensory Characteristics (A) | Инструкция не зависит только от формы, цвета, размера, позиции, ориентации или звука. | Нет команд вида «красный блок слева» без programmatic/text identity; metronome/count-in имеет не только звуковой способ восприятия, если он передаёт рабочее состояние. |
| 1.4.1 Use of Color (A) | Цвет не единственное средство передать информацию, action или distinguishable state. | Low-confidence, abstained, error, selected/current chord и edited boundary дополнительно различаются текстом, символом, pattern/shape или programmatic state. |
| 1.4.2 Audio Control (A) | Для автоматически проигрываемого более 3 секунд аудио есть pause/stop либо независимая громкость. | Источник не начинает звучать сам; если autoplay когда-либо появится, нужны эти controls. |
| 1.4.3 Contrast (Minimum) (AA) | Обычный текст ≥ 4.5:1, large text ≥ 3:1, кроме перечисленных исключений. | Проверяется для default, hover, selected, disabled-readable и warning/error presentations во всех поддержанных темах. |
| 1.4.4 Resize Text (AA) | Текст увеличивается до 200% без потери content/functionality. | При 200% нет обрезанных chord names, labels, dialogs, status/error text; все controls остаются доступны. |
| 1.4.10 Reflow (AA) | При эквиваленте 320 CSS px width или 256 CSS px height нет потери информации/functionality и двухмерного scroll, кроме частей, которым 2D layout нужен для usage/meaning. | Сам timeline может обосновать 2D exception, но transport, editor commands, errors и inspector не получают исключение автоматически. Они остаются достижимыми при 400% zoom; timeline предоставляет доступный последовательный путь. |
| 1.4.11 Non-text Contrast (AA) | Visual information, необходимая для UI components/states и meaningful graphics, имеет ≥ 3:1 к соседним цветам, с исключениями. | Границы bars/beats, focus/selection, playhead, loop handles и error indicators проходят contrast check там, где они нужны для понимания/управления. |
| 1.4.12 Text Spacing (AA) | Заданные text spacing overrides не вызывают потери content/functionality. | Labels/chord text не обрезаются при параметрах из критерия; высота строк и контейнеров не захардкожена против текста. |
| 1.4.13 Content on Hover or Focus (AA) | Дополнительный hover/focus content dismissible, hoverable и persistent, если применимо. | Tooltips для chord/confidence/shortcut закрываются без перемещения указателя, доступны наведением на сам tooltip и не исчезают до dismiss/focus change. |
| 2.1.1 Keyboard (A) | Вся functionality доступна с keyboard interface; путь движения pointer не должен быть единственным способом. | Создание/изменение chord, boundary, beat/downbeat, bar/meter, lyrics timing, loop и seek выполняется без мыши. Простого наличия глобального shortcut недостаточно, если нельзя выбрать target. |
| 2.1.2 No Keyboard Trap (A) | Keyboard focus можно вывести из любого component стандартным способом либо пользователь уведомлён о нестандартном. | Timeline, embedded player, diagram picker, toolbar и modal не захватывают Tab/arrows/Escape без выхода. |
| 2.1.4 Character Key Shortcuts (A) | Single-character shortcut можно отключить/remap либо он работает только при focus соответствующего component. | Одноклавишные play/practice команды контекстны или настраиваемы; shortcut не срабатывает при вводе lyrics/text. |
| 2.2.2 Pause, Stop, Hide (A) | Для автоматически начавшегося moving/blinking/scrolling >5s или auto-updating content рядом с другим content есть pause/stop/hide/frequency control, если движение не essential. | Playback можно паузить; moving-bars view не запускается без действия пользователя. Никакое вторичное auto-scroll/animation не продолжает движение без доступного управления. |
| 2.3.1 Three Flashes or Below Threshold (A) | Нет content, flashing >3 раза в секунду, кроме безопасных порогов. | Metronome/count-in/playhead/error animations не используют опасное мигание. |
| 2.4.1 Bypass Blocks (A) | Есть механизм обходить повторяющиеся blocks. | Landmarks/regions и быстрый keyboard route позволяют перейти между library, timeline, inspector/lyrics и transport без Tab через каждый event. |
| 2.4.2 Page Titled (A) | Документ имеет descriptive topic/purpose. | Window/document title сообщает проект и активный workspace context без раскрытия лишних приватных данных. |
| 2.4.3 Focus Order (A) | Последовательный focus order сохраняет meaning/operability. | Tab order стабилен, логичен и не следует визуально перемещённым CSS-слоям; opening/closing panel/dialog имеет предсказуемое focus destination. |
| 2.4.6 Headings and Labels (AA) | Headings/labels описывают topic/purpose. | Повторяющиеся `Edit`, `Reset`, time values и icon actions имеют контекстные accessible labels; секции workspace программно названы. |
| 2.4.7 Focus Visible (AA) | Keyboard-operable UI показывает mode of operation, где focus indicator видим. | Focus не скрыт на canvas, dark theme, selected row или custom control. |
| 2.4.11 Focus Not Obscured (Minimum) (AA) | Focused component не полностью скрыт author-created content. | Sticky transport, popover, toast и bottom bar не закрывают focused timeline item/control; component прокручивается в видимую область. |
| 2.5.1 Pointer Gestures (A) | Multipoint/path-based gestures имеют single-pointer alternative, если gesture не essential. | Ни pinch, ни нарисованный жест не являются единственным zoom/edit route. |
| 2.5.2 Pointer Cancellation (A) | Для single-pointer есть cancel/abort/undo либо action завершается на up-event с возможностью отменить. | Boundary/chord/loop edit не коммитится необратимо на pointer-down; сохраняется nondestructive undo. |
| 2.5.3 Label in Name (A) | Accessible name содержит видимый label. | Voice Control/Narrator может активировать `Play`, `Undo`, `Low confidence` и instrument labels теми словами, которые видит пользователь. |
| 2.5.7 Dragging Movements (AA) | Любая drag functionality имеет single-pointer non-drag alternative, кроме essential/system-controlled случаев. | Boundary, beat, loop handle и reorder получают click/select + numeric/nudge/action alternative. |
| 2.5.8 Target Size (Minimum) (AA) | Pointer target ≥ 24×24 CSS px или выполняет одно из нормативных исключений/spacing conditions. | Icon buttons и плотные timeline handles проверяются по target box и spacing, а не только по видимой glyph. |
| 3.1.1 Language of Page (A), 3.1.2 Language of Parts (AA) | Default language и смены языка programmatically determinable. | UI locale задан; user lyrics/metadata с известным другим языком маркируются, когда это возможно. |
| 3.2.1 On Focus (A), 3.2.2 On Input (A) | Focus или изменение value само по себе не вызывает неожиданную смену context без уведомления. | Focus на chord/event не seek'ает и не запускает playback; выбор значения не закрывает/заменяет workspace неожиданно. |
| 3.2.3 Consistent Navigation (AA), 3.2.4 Consistent Identification (AA) | Повторяющиеся navigation/actions сохраняют порядок и идентификацию. | Transport, Undo/Redo, Original/Beginner и confidence states названы и ведут себя одинаково между editor/practice contexts. |
| 3.3.1 Error Identification (A) | Обнаруженная input error идентифицируется и описывается текстом. | Invalid meter, overlapping boundary, unsupported chord и failed edit имеют конкретное text/programmatic описание, не только красную рамку. |
| 3.3.2 Labels or Instructions (A), 3.3.3 Error Suggestion (AA) | Input имеет labels/instructions; известное исправление ошибки предлагается, если это не ставит под угрозу purpose/security. | Time/chord/meter editors сообщают формат, unit/range и исправление; ошибка связана с соответствующим field/event. |
| 4.1.2 Name, Role, Value (A) | UI component имеет programmatically determinable name/role; settable states/values доступны AT; изменения уведомляются. | Custom timeline controls экспортируют role, label, value, selected/expanded/invalid/disabled и действия. Canvas bitmap без параллельной semantic model не проходит. |
| 4.1.3 Status Messages (AA) | Status message доступен AT без получения focus. | Save, export, analysis progress/result, undo/reset, loop-invalid и nonblocking errors публикуются через подходящий live/status mechanism без focus theft. |

### 2.1 Усиленные рекомендации, не AA gate

- **2.4.13 Focus Appearance (AAA):** использовать измеримый indicator не меньше площади 2 CSS px perimeter и с изменением contrast ≥ 3:1. Это делает custom timeline focus проверяемым, хотя AA требует только видимости ([WCAG 2.4.13](https://www.w3.org/TR/WCAG22/#focus-appearance)).
- **2.5.5 Target Size (Enhanced) (AAA):** стремиться к 44×44 CSS px для primary transport и частых practice controls; плотная timeline может использовать меньшие targets только вместе с эквивалентным управлением ([WCAG 2.5.5](https://www.w3.org/TR/WCAG22/#target-size-enhanced)).
- **2.3.3 Animation from Interactions (AAA):** interaction motion можно отключить, если она не essential. Дополнительно CSS Media Queries определяет `prefers-reduced-motion: reduce` как системный запрос на удаление/замену несущественного motion ([WCAG 2.3.3](https://www.w3.org/TR/WCAG22/#animation-from-interactions), [Media Queries Level 5 §12.1](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)).

## 3. WAI-ARIA APG: рекомендуемые модели взаимодействия

APG keyboard conventions уменьшают число Tab stops: Tab входит в composite widget, стрелки двигают focus внутри, а Tab выходит. Автор composite обязан управлять focus; disabled items внутри composite иногда остаются arrow-focusable для discoverability. Это guidance, и каждый выбранный pattern всё равно должен пройти WCAG и native AT testing ([APG Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)).

### Toolbar

Для группы transport/edit actions применим [`toolbar` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/):

- один Tab stop на toolbar; Left/Right перемещают focus, Home/End опциональны;
- при вертикальном toolbar используются Up/Down, а `aria-orientation` сообщает ориентацию;
- toolbar имеет accessible label; если toolbar несколько, каждый получает уникальный label;
- controls с собственными Left/Right interactions (например, text field или horizontal slider) требуют согласованного размещения/обработки, чтобы toolbar navigation не блокировала control.

### Tabs

Для переключаемых workspace views применим [`tabs` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/):

- `tablist`, `tab`, `tabpanel` связаны через accessible names/relationships; выбранный tab сообщает `aria-selected=true`;
- Left/Right (или Up/Down при vertical orientation) перемещают focus между tabs; Home/End опциональны;
- automatic activation рекомендуется только если panel появляется без заметной latency; иначе Space/Enter выполняют manual activation;
- после удаления tab focus переходит на логичный соседний tab либо другой логичный control.

### List, listbox и grid

- Семантический список проектов/events без выбора/внутренних actions остаётся native list, а не ARIA composite.
- Одномерный selectable set может следовать [`listbox` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/): arrows меняют option focus/selection, Home/End и type-ahead рекомендуются для длинных наборов. APG предупреждает, что option content не должен содержать самостоятельные interactive elements; для строк с actions нужен другой pattern.
- Интерактивная таблица событий может следовать [`grid` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/): один Tab stop входит в grid; arrows перемещают cell focus, Home/End и Ctrl+Home/End двигают к границам, Page Up/Down опциональны. Автор должен обеспечить focusability содержимого cell и не превращать Tab в обход каждой ячейки. Для cell с editor/control нужен явный переход между navigation и edit mode (APG приводит Enter/F2 для входа и Escape для возврата как распространённую модель).
- Визуальная CSS grid не означает `role=grid`. Весь chord timeline нельзя автоматически объявлять одним grid: стрелки могут конфликтовать между playhead, selection, boundary movement и embedded sliders. Сначала определяется keyboard mode model, затем выбирается native structure, grid или несколько меньших composites.

### Timeline, playhead, speed и loop range

- Одномерное числовое значение может следовать [`slider` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/): Right/Up увеличивают, Left/Down уменьшают, Home/End ставят minimum/maximum, Page Up/Down — optional larger step. Нужны `aria-valuemin`, `aria-valuemax`, `aria-valuenow` и понятный `aria-valuetext`, если число само по себе не объясняет musical position.
- Loop start/end может следовать [`multi-thumb slider` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/), если каждый thumb имеет отдельный label, tab order остаётся постоянным, а допустимые ranges обновляются программно. Это не отменяет отдельные поля/nudge-команды как альтернативу drag.
- APG отдельно предупреждает, что touch assistive technologies могут не синтезировать нужные arrow events для sliders; desktop v1 всё равно должен проверить VoiceOver/Narrator фактическим AT, а не считать ARIA достаточным.
- Timeline должен давать `aria-valuetext`, понятный в домене, например section/bar/beat + elapsed time; частые playback ticks не должны быть assertive live announcements. Точный формат — отдельное product decision.

### Dialogs

[`Modal dialog` pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) рекомендует:

- при открытии focus переходит внутрь dialog; Tab/Shift+Tab остаются внутри, Escape закрывает;
- dialog имеет visible title, связанный через `aria-labelledby`, и visible close/cancel button в Tab order;
- при закрытии focus обычно возвращается на opener, либо на следующий логичный target, если opener исчез;
- initial focus выбирается по содержимому и риску: для необратимого действия — на least destructive action, для длинного structured content — на статический heading с `tabindex=-1`;
- `aria-modal=true` ставится только когда внешний content действительно inert и visually obscured. Неправильная modal semantics может сделать interface недоступным для AT.

### Shortcuts

Нормативный [`aria-keyshortcuts`](https://www.w3.org/TR/wai-aria-1.2/#aria-keyshortcuts) только **объявляет** реализованный shortcut; он не создаёт поведение. Значение использует DOM key names, а platform conventions могут требовать разные modifiers. Поэтому:

- shortcut должен реально работать с указанного context и не конфликтовать с text input, AT или системными сочетаниями;
- частые команды дополнительно доступны через menu/control и видимую searchable help surface;
- single-character shortcuts выполняют WCAG 2.1.4: disable/remap либо только focused-context;
- на macOS нельзя переназначать ожидаемые system shortcuts; Apple рекомендует Full Keyboard Access и сохранение standard shortcuts ([Apple Keyboards HIG](https://developer.apple.com/design/human-interface-guidelines/keyboards)).

### Live regions, progress и errors

- `role=status` имеет implicit `aria-live=polite` и `aria-atomic=true`; подходит для результата save/edit/export и noncritical state ([WAI-ARIA `status`](https://www.w3.org/TR/wai-aria-1.2/#status)).
- `role=alert` имеет assertive/atomic semantics и предназначен для важного time-sensitive message; APG подчёркивает, что alert не обязан получать focus и не должен исчезать слишком быстро ([APG Alert Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alert/)).
- `role=log` подходит для последовательности meaningful additions, `role=timer` имеет implicit `aria-live=off`, а `progressbar` сообщает bounded progress. Их semantics определены WAI-ARIA; обновления не должны затоплять speech ([WAI-ARIA roles](https://www.w3.org/TR/wai-aria-1.2/#role_definitions)).
- Ошибка формы дополнительно должна быть связана с invalid field (`aria-invalid` и accessible description); live announcement не заменяет persistent visible error и correction path.

## 4. Platform/Electron constraints

### 4.1 Electron и Chromium

Electron говорит, что его accessibility concerns аналогичны websites, потому что renderer — HTML. При обнаружении assistive technology Electron автоматически включает accessibility features; `app.setAccessibilitySupportEnabled` может принудительно раскрыть Chrome accessibility tree, но system assistive utilities имеют приоритет ([Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)). API reference предупреждает о performance cost постоянного принудительного tree и не рекомендует включать его по умолчанию ([Electron `app.accessibilitySupportEnabled`](https://www.electronjs.org/docs/latest/api/app#appaccessibilitysupportenabled-macos-windows)).

Проверяемые следствия:

- не отключать accessibility support и не делать отдельный урезанный accessibility mode;
- в automated/manual test harness можно явно включать tree, но production default должен полагаться на AT detection либо осознанную preference;
- record Electron и bundled Chromium versions в evidence, потому что platform bridge меняется независимо от DOM;
- проверять получившееся platform tree/events, а не только DOM/ARIA. Chromium предоставляет `chrome://accessibility` и AX inspection tools для tree/events ([Chromium accessibility technical documentation](https://www.chromium.org/developers/design-documents/accessibility/), [AX inspect tools](https://www.chromium.org/developers/accessibility/testing/automated-testing/ax-inspect/)).

С Chrome 138 Chromium-based browsers на Windows включают native UI Automation provider по умолчанию; UIA используется Narrator, Magnifier и Voice Access. Это подтверждает правильную target surface для современного bundled Chromium, но не доказывает корректность конкретного Electron build — её всё равно надо тестировать ([Chrome: Native UI Automation for Windows in Chromium](https://developer.chrome.com/blog/windows-uia-support-update)).

### 4.2 macOS: VoiceOver и keyboard

Apple описывает VoiceOver navigation как иерархию areas/groups: пользователь может взаимодействовать с group, затем выйти из него; rotor позволяет быстро перейти к категориям controls/headings/links. Поэтому избыточная вложенность без названий и тысячи плоских timeline nodes одинаково вредны; platform test должен проверить осмысленные named regions и достижимость вложенных действий ([Apple: Get started with VoiceOver](https://support.apple.com/guide/voiceover/get-started-with-voiceover-vo4be8816d70/mac), [advanced navigation](https://support.apple.com/guide/voiceover/intro-to-advanced-navigation-vo27974/mac)).

Apple рекомендует:

- keyboard-only navigation и взаимодействие через Full Keyboard Access;
- не переопределять standard keyboard shortcuts;
- показывать platform-consistent focus appearance;
- тестировать VoiceOver и Accessibility Inspector; Inspector раскрывает hierarchy, attributes/actions и common issues, но дополняет, а не заменяет реальное AT testing ([Apple Accessibility HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Keyboards HIG](https://developer.apple.com/design/human-interface-guidelines/keyboards), [Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/), [Accessibility Inspector](https://developer.apple.com/documentation/accessibility/accessibility-inspector)).

Минимальный macOS evidence run:

1. Включить VoiceOver (`Command-F5`), пройти project open → playback/seek → chord/boundary edit → undo → loop → error recovery → export только клавиатурой.
2. Проверить имена, roles, states/values, group entry/exit, focus restoration и отсутствие речевого потока от playhead.
3. Accessibility Inspector: audit на unlabeled/clipped/contrast issues и ручная проверка hierarchy/actions.
4. Включить Reduce Motion и убедиться, что workspace не теряет информацию/functionality; Apple отдельно требует проверять приложение с этой setting ([Apple: Testing system accessibility features](https://developer.apple.com/documentation/accessibility/testing-system-accessibility-features-in-your-app)).

### 4.3 Windows: UI Automation и Narrator

Microsoft называет UI Automation основной accessibility integration для Windows apps: accessibility-relevant content top-level window должно быть доступно UIA clients, а каждому element нужен корректный accessible name/role/state. Keyboard и screen-reader support должны проверяться фактическими tools, потому что не все readers одинаково используют automation properties ([Microsoft Accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)).

Минимальный Windows evidence run:

1. Пройти тот же end-to-end путь только keyboard + Narrator; Narrator должен читать visible name, role и state/value и вызывать каждое действие.
2. Проверить logical Tab sequence, arrows внутри composites и Enter/Space activation.
3. Проверить Windows high-contrast theme и DPI/display scaling.
4. Accessibility Insights for Windows: FastPass/Live Inspect; проверить UIA tree, patterns и events. Microsoft рекомендует автоматические checks в CI и manual screen-reader/keyboard validation для critical journeys ([Microsoft accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing), [Accessibility Insights](https://accessibilityinsights.io/docs/windows/overview/)).

## 5. Проверяемый accessibility contract для prototype и будущей реализации

Это ограничения, а не layout decisions.

### 5.1 Semantic model

- Каждый visible interactive object имеет один понятный accessible name, role, current value/state и action.
- Bars, beats, chord events, sections, lyrics tokens и confidence/error states имеют stable semantic representation независимо от визуального renderer.
- Chord diagram имеет text equivalent: structured chord name и play instructions/notes, если diagram передаёт их.
- `asserted`, `low confidence`, `abstained`, `N`, user-edited и technical error не схлопываются в один цвет или одно слово `warning`.

### 5.2 Keyboard and focus

- Полный путь open project → choose target → edit → undo/reset → practice loop → export выполняется без pointer.
- Tab двигается между regions/composites, arrows — внутри выбранного APG composite; есть быстрый route к timeline и transport.
- Boundary/beat/loop drag имеет nudge/numeric/action alternative с тем же результатом.
- Focus сохраняется после timeline rerender/playhead update; modal/popover возвращает его по объявленному правилу; sticky content его не скрывает.
- Shortcut help показывает фактические platform bindings; single-key actions контекстны/remappable.

### 5.3 Playback and timeline

- Play/pause, seek, previous/next chord/bar, speed, transpose, metronome, count-in и loop имеют keyboard-operable named controls.
- Position сообщает elapsed time и музыкальную позицию в текстовом/programmatic виде; scrub value имеет unit и range.
- Playback tick и moving bars не публикуются как assertive live updates. Meaningful changes — loop invalid, edit applied, analysis/export completion, error — публикуются один раз подходящей priority.
- Pause останавливает media и связанное необязательное движение; Reduce Motion убирает smooth/animated transitions, сохраняя position/state.

### 5.4 Visual resilience

- 200% text zoom без clipping/loss; 400% browser zoom/320 CSS px equivalent без потери controls и двухмерного scroll вне обоснованного timeline fragment.
- Текст соответствует 4.5:1/3:1, meaningful UI/graphic boundaries — 3:1; target size — 24×24 CSS px или нормативное исключение/spacing.
- Confidence, current/selected, invalid и edit state распознаются без цвета и без motion.
- High contrast/forced colors сохраняют focus, selection, playhead, loop и error distinctions.

### 5.5 Release evidence

- Automated DOM accessibility checks — на каждый critical renderer view, но не как единственный gate.
- Keyboard сценарии — автоматизированные там, где возможно, плюс manual no-pointer pass.
- macOS: VoiceOver + Accessibility Inspector; Windows: Narrator + Accessibility Insights/UIA inspection.
- Matrix содержит OS, Electron, Chromium, screen reader и tool versions; blockers не закрываются одним DOM snapshot.
- Проверяются EN и RU UI strings, длинные project/chord labels, low-confidence/abstention, invalid edit, empty/no-lyrics и analysis-progress states.

## 6. Concise implications for следующего prototype

1. Prototype должен доказывать **две эквивалентные поверхности одного state model**: визуальную timeline и последовательную semantic/keyboard модель. Отдельный «accessible mode» не нужен.
2. До выбора layout достаточно проверить четыре seams: region navigation, timeline target selection/edit without drag, focus preservation при playback/rerender и restrained announcements динамических state changes.
3. Confidence/error prototype обязан показывать visible word/icon/pattern и соответствующий programmatic state; изменение одного цвета не считается вариантом.
4. Reflow prototype может оставить сам timeline двухмерным, но должен доказать доступ к transport, editor actions и выбранному event при 200% text и 400% zoom.
5. Prototype acceptance требует короткого VoiceOver и Narrator walkthrough. AX/DOM screenshot без реального screen reader — только промежуточное evidence.

## 7. Открытые продуктовые решения, которые источники не выбирают

- Какая конкретно information architecture и grouping лучше для library/editor/practice.
- Представлять ли event timeline как grid, listbox, treegrid или собственную комбинацию native elements; роль выбирается после task prototype, не по внешнему виду.
- Exact shortcut map, nudge increments и формат `aria-valuetext` для bar/beat/seconds при variable meter/tempo.
- Какие playback changes достойны live announcement и какая verbosity настраивается пользователем.
- Требуется ли formal WCAG conformance claim или WCAG 2.2 AA остаётся внутренним release gate.

Ни один из этих вопросов не меняет обязательные свойства: keyboard equivalence, stable focus, programmatic semantics, non-color state, zoom/reflow resilience и проверка native assistive technologies.
