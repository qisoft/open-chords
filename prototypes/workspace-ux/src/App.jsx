import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

const VARIANTS = {
  A: 'A — Редактор',
  B: 'B — Режимы',
  C: 'C — Список',
}

const INITIAL_BARS = [
  { id: 'bar-1', number: 1, meter: '4/4', section: 'Вступление', confidence: 'ok', events: [
    { id: '1-c', chord: 'C', start: '0:12.000', end: '0:14.400' },
    { id: '1-g', chord: 'G', start: '0:14.400', end: '0:16.800' },
  ] },
  { id: 'bar-2', number: 2, meter: '4/4', section: 'Куплет 1', confidence: 'low', events: [
    { id: '2-am', chord: 'Am', start: '0:16.800', end: '0:18.400' },
    { id: '2-f', chord: 'F', start: '0:18.400', end: '0:21.120' },
  ] },
  { id: 'bar-3', number: 3, meter: '4/4', section: 'Куплет 1', confidence: 'ok', events: [
    { id: '3-c', chord: 'C', start: '0:21.120', end: '0:23.520' },
    { id: '3-g7', chord: 'G7', start: '0:23.520', end: '0:26.000' },
  ] },
  { id: 'bar-4', number: 4, meter: '4/4', section: 'Припев', confidence: 'ok', events: [
    { id: '4-am', chord: 'Am', start: '0:26.000', end: '0:28.400' },
    { id: '4-f', chord: 'F', start: '0:28.400', end: '0:31.000' },
  ] },
  { id: 'bar-5', number: 5, meter: '3/4', section: 'Припев', confidence: 'low', events: [
    { id: '5-dm', chord: 'Dm', start: '0:31.000', end: '0:33.000' },
    { id: '5-g', chord: 'G', start: '0:33.000', end: '0:35.200' },
  ] },
  { id: 'bar-6', number: 6, meter: '3/4', section: 'Проигрыш', confidence: 'ok', events: [
    { id: '6-cmaj7', chord: 'Cmaj7', start: '0:35.200', end: '0:39.800' },
  ] },
]

const STATES = [
  { label: 'Готово', title: 'Проект готов', detail: 'Все данные доступны. Правок: 3.', tone: 'good', symbol: '✓' },
  { label: 'Анализ', title: 'Анализируем гармонию', detail: 'Этап 3 из 5. Предыдущая ревизия доступна.', tone: 'busy', symbol: '◌' },
  { label: 'Низкая уверенность', title: 'Нужно проверить 2 места', detail: 'Такты 2 и 5 отмечены текстом и узором.', tone: 'warn', symbol: '!' },
  { label: 'Ошибка', title: 'Новая ревизия не создана', detail: 'Исходный анализ и правки сохранены.', tone: 'danger', symbol: '×' },
]

const initialState = {
  bars: INITIAL_BARS,
  activeBarId: 'bar-3',
  activeEventId: '3-c',
  statusIndex: 0,
  playing: false,
  reducedMotion: false,
  loop: true,
  mode: 'Редактор',
  modal: false,
}

function reducer(state, action) {
  switch (action.type) {
    case 'selectBar': {
      const bar = state.bars.find((item) => item.id === action.barId)
      return { ...state, activeBarId: bar.id, activeEventId: bar.events[0].id }
    }
    case 'selectEvent':
      return { ...state, activeBarId: action.barId, activeEventId: action.eventId }
    case 'updateEvent':
      return {
        ...state,
        bars: state.bars.map((bar) => bar.id !== state.activeBarId ? bar : {
          ...bar,
          events: bar.events.map((event) => event.id === state.activeEventId ? { ...event, ...action.patch } : event),
        }),
      }
    case 'addEvent':
      return {
        ...state,
        activeEventId: action.event.id,
        bars: state.bars.map((bar) => {
          if (bar.id !== state.activeBarId) return bar
          const index = bar.events.findIndex((event) => event.id === state.activeEventId)
          const events = [...bar.events]
          events.splice(index + 1, 0, action.event)
          return { ...bar, events }
        }),
      }
    case 'deleteEvent': {
      const bar = state.bars.find((item) => item.id === state.activeBarId)
      if (bar.events.length === 1) return state
      const index = bar.events.findIndex((event) => event.id === state.activeEventId)
      const nextEvents = bar.events.filter((event) => event.id !== state.activeEventId)
      return {
        ...state,
        activeEventId: nextEvents[Math.min(index, nextEvents.length - 1)].id,
        bars: state.bars.map((item) => item.id === bar.id ? { ...item, events: nextEvents } : item),
      }
    }
    case 'moveBar': {
      const index = state.bars.findIndex((bar) => bar.id === state.activeBarId)
      const target = state.bars[Math.max(0, Math.min(state.bars.length - 1, index + action.delta))]
      return { ...state, activeBarId: target.id, activeEventId: target.events[0].id }
    }
    case 'cycleStatus':
      return { ...state, statusIndex: (state.statusIndex + 1) % STATES.length }
    case 'togglePlaying': return { ...state, playing: !state.playing }
    case 'toggleLoop': return { ...state, loop: !state.loop }
    case 'toggleMotion': return { ...state, reducedMotion: !state.reducedMotion }
    case 'setMode': return { ...state, mode: action.mode }
    case 'setModal': return { ...state, modal: action.open }
    default: return state
  }
}

function beatLabel(bar, eventIndex) {
  if (bar.events.length === 1) return `доли 1–${bar.meter[0]}`
  const beats = Number(bar.meter[0])
  const start = Math.floor(eventIndex * beats / bar.events.length) + 1
  const end = Math.max(start, Math.floor((eventIndex + 1) * beats / bar.events.length))
  return start === end ? `доля ${start}` : `доли ${start}–${end}`
}

function useVariant() {
  const read = () => {
    const value = new URLSearchParams(window.location.search).get('variant') || 'A'
    return VARIANTS[value] ? value : 'A'
  }
  const [variant, setVariantState] = useState(read)
  const setVariant = (next) => {
    const params = new URLSearchParams(window.location.search)
    params.set('variant', next)
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`)
    setVariantState(next)
  }
  const cycle = (delta) => {
    const keys = Object.keys(VARIANTS)
    setVariant(keys[(keys.indexOf(variant) + delta + keys.length) % keys.length])
  }
  return [variant, setVariant, cycle]
}

function Header({ state, dispatch }) {
  return <header className="app-header">
    <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">◒</span><strong>Open Chords</strong></div>
    <div className="project-title"><strong>Плачь и танцуй</strong><span>Диапазон 0:00–0:48</span></div>
    <div className="header-actions">
      <button className="quiet-button" onClick={() => dispatch({ type: 'cycleStatus' })}>Состояние: {STATES[state.statusIndex].label}</button>
      <button className="quiet-button" aria-pressed={state.reducedMotion} onClick={() => dispatch({ type: 'toggleMotion' })}>{state.reducedMotion ? 'Обычное движение' : 'Меньше движения'}</button>
      <button className="quiet-button" onClick={() => dispatch({ type: 'setModal', open: true })}>Клавиши</button>
      <button className="quiet-button">Все проекты</button>
    </div>
  </header>
}

function StatusBanner({ state }) {
  const status = STATES[state.statusIndex]
  return <section className={`status-banner compact ${status.tone}`} aria-label="Состояние проекта" aria-busy={status.tone === 'busy'}>
    <span className="status-symbol" aria-hidden="true">{status.symbol}</span>
    <div><strong>{status.title}</strong><span>{status.detail}</span></div>
  </section>
}

function Timeline({ state, dispatch, simple = false }) {
  return <section className={`timeline-shell ${simple ? 'simple' : ''}`} aria-label="Музыкальный таймлайн">
    <div className="timeline-heading">
      <div><span className="eyebrow">Таймлайн</span><h2>Куплет 1 → Припев</h2></div>
      <div className="legend"><span className="legend-low">Низкая уверенность</span><span>Playhead 0:18.4</span></div>
    </div>
    <div className="timeline-scroll" tabIndex="0" aria-label="Такты и отдельные события аккордов">
      <div className="center-line" aria-hidden="true" />
      <div className="bars-track">
        {state.bars.map((bar) => <article key={bar.id} className={`bar ${bar.id === state.activeBarId ? 'active' : ''} ${bar.confidence === 'low' ? 'low' : ''}`} aria-label={`Такт ${bar.number}, размер ${bar.meter}`}>
          <button className="bar-select" onClick={() => dispatch({ type: 'selectBar', barId: bar.id })}>
            <span><b>Такт {bar.number}</b><small>{bar.section}</small></span><small>{bar.meter}</small>
          </button>
          <span className="beat-row" aria-hidden="true">{Array.from({ length: Number(bar.meter[0]) }, (_, index) => <i key={index} className={index === 0 ? 'downbeat' : ''} />)}</span>
          <span className="chord-row">{bar.events.map((event, index) => <button key={event.id} className={`chord-event ${event.id === state.activeEventId ? 'selected' : ''}`} aria-pressed={event.id === state.activeEventId} onClick={() => dispatch({ type: 'selectEvent', barId: bar.id, eventId: event.id })}>
            <b>{event.chord}</b><small>{beatLabel(bar, index)}</small>
          </button>)}</span>
          {bar.confidence === 'low' && <span className="confidence-label">! проверить</span>}
        </article>)}
      </div>
    </div>
  </section>
}

function EventEditor({ bar, event, dispatch }) {
  const [draft, setDraft] = useState(event)
  useEffect(() => setDraft(event), [event])
  const activeIndex = bar.events.findIndex((item) => item.id === event.id)
  const save = (submitEvent) => {
    submitEvent.preventDefault()
    if (!draft.chord.trim() || !draft.start.trim() || !draft.end.trim()) return
    dispatch({ type: 'updateEvent', patch: { chord: draft.chord.trim(), start: draft.start.trim(), end: draft.end.trim() } })
  }
  return <aside className="inspector panel" aria-label="Редактор выбранного события аккорда">
    <div className="panel-heading"><div><span className="eyebrow">Редактор события</span><strong>Такт {bar.number}</strong></div><span className="event-counter">{activeIndex + 1} из {bar.events.length}</span></div>
    <p className="inspector-help">В этом такте {bar.events.length === 1 ? 'один аккорд' : `${bar.events.length} аккорда`}. Выбери нужный:</p>
    <div className="event-picker" role="group" aria-label={`Аккорды в такте ${bar.number}`}>
      {bar.events.map((item, index) => <button key={item.id} className={`event-option ${item.id === event.id ? 'selected' : ''}`} aria-pressed={item.id === event.id} onClick={() => dispatch({ type: 'selectEvent', barId: bar.id, eventId: item.id })}>
        <strong>{item.chord}</strong><span>{beatLabel(bar, index)}</span>
      </button>)}
    </div>
    <button className="add-event-button" onClick={() => dispatch({ type: 'addEvent', event: { id: crypto.randomUUID(), chord: 'N', start: 'Задать', end: 'Задать' } })}>＋ Добавить смену аккорда</button>
    <div className="selected-chord"><span>Позиция: {beatLabel(bar, activeIndex)}</span><strong>{event.chord}</strong><small>Изменяется только выбранное событие</small></div>
    <form onSubmit={save}>
      <div className="field-group">
        <label>Название аккорда<input value={draft.chord} onChange={(e) => setDraft({ ...draft, chord: e.target.value })} /></label>
        <div className="timing-summary">
          <label>Начало<input value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></label>
          <label>Конец<input value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
        </div>
      </div>
      <div className="button-pair"><button className="primary-button" type="submit">Сохранить событие</button><button className="danger-button" type="button" disabled={bar.events.length === 1} onClick={() => dispatch({ type: 'deleteEvent' })}>Удалить этот аккорд</button></div>
    </form>
    <p className="original-note">Original сохранён отдельно; последний аккорд в такте удалить нельзя.</p>
  </aside>
}

function Transport({ state, dispatch }) {
  return <section className="transport" aria-label="Проигрывание">
    <button className="transport-key" aria-label="Предыдущий такт" onClick={() => dispatch({ type: 'moveBar', delta: -1 })}>‹</button>
    <button className="play-button" aria-label={state.playing ? 'Пауза' : 'Воспроизвести'} aria-pressed={state.playing} onClick={() => dispatch({ type: 'togglePlaying' })}>{state.playing ? 'Ⅱ' : '▶'}</button>
    <button className="transport-key" aria-label="Следующий такт" onClick={() => dispatch({ type: 'moveBar', delta: 1 })}>›</button>
    <div className="time-readout"><strong>0:18.4</strong><span>/ 0:48</span></div>
    <button className="chip-button" aria-pressed={state.loop} onClick={() => dispatch({ type: 'toggleLoop' })}>Луп: {state.loop ? '2–4' : 'выкл.'}</button>
    <button className="chip-button">Скорость 0.85×</button><button className="chip-button">Метроном</button>
  </section>
}

function VariantA({ state, dispatch, bar, event }) {
  return <div className="shell variant-a"><Header state={state} dispatch={dispatch} /><div className="studio-grid">
    <main id="workspace-main" className="studio-main" tabIndex="-1">
      <div className="editor-intro"><div><span className="eyebrow">Редактор</span><h1>Выбери конкретный аккорд</h1><p>Жёлтая рамка показывает событие, которое изменится справа. Такт и аккорд — разные уровни выбора.</p></div><StatusBanner state={state} /></div>
      <Timeline state={state} dispatch={dispatch} />
      <section className="lyrics-strip" aria-label="Текст"><span className="eyebrow">Текст · выровнен частично</span><p>Я хотел бы остаться с тобой, <mark>просто остаться с тобой</mark></p></section>
    </main>
    <EventEditor bar={bar} event={event} dispatch={dispatch} />
  </div><footer className="studio-footer"><Transport state={state} dispatch={dispatch} /></footer>
  </div>
}

function VariantB({ state, dispatch, bar, event }) {
  const practice = state.mode === 'Практика'
  return <div className="shell variant-b"><Header state={state} dispatch={dispatch} />
    <nav className="mode-tabs" aria-label="Режим работы">{['Обзор', 'Редактор', 'Практика'].map((mode) => <button key={mode} className={state.mode === mode ? 'selected' : ''} aria-current={state.mode === mode ? 'page' : undefined} onClick={() => dispatch({ type: 'setMode', mode })}>{mode}</button>)}</nav>
    <main id="workspace-main" className="focus-main" tabIndex="-1"><StatusBanner state={state} />
      {practice ? <section className="practice-stage"><span className="eyebrow">Сейчас · такт {bar.number}, {beatLabel(bar, bar.events.indexOf(event))}</span><div className="hero-chord">{event.chord}</div><Transport state={state} dispatch={dispatch} /></section> : <Timeline state={state} dispatch={dispatch} simple />}
      <section className="task-drawer"><div><span className="eyebrow">Выбранное событие</span><h2>Такт {bar.number} · {event.chord} · {event.start}–{event.end}</h2></div><button className="primary-button">Открыть редактор события</button></section>
    </main>
  </div>
}

function VariantC({ state, dispatch, bar, event }) {
  return <div className="shell variant-c"><Header state={state} dispatch={dispatch} /><main id="workspace-main" className="linear-main" tabIndex="-1">
    <section className="linear-section"><span className="eyebrow">Текущее событие</span><div className="section-heading"><h1>Такт {bar.number} · {event.chord}</h1><span className="big-chord">{event.chord}</span></div><Transport state={state} dispatch={dispatch} /></section>
    <section className="linear-section"><span className="eyebrow">Список событий</span><h2>Каждый аккорд выбирается отдельно</h2><ol className="linear-bars">{state.bars.map((item) => <li key={item.id} className={item.id === bar.id ? 'active' : ''}><div className="linear-bar-row">
      <button className="linear-bar-name" onClick={() => dispatch({ type: 'selectBar', barId: item.id })}><span className="linear-number">{item.number}</span><span><strong>Такт {item.number} · {item.meter}</strong><small>{item.section}</small></span></button>
      <div className="linear-event-list">{item.events.map((chordEvent, index) => <button key={chordEvent.id} className={`linear-event ${chordEvent.id === event.id ? 'selected' : ''}`} onClick={() => dispatch({ type: 'selectEvent', barId: item.id, eventId: chordEvent.id })}><strong>{chordEvent.chord}</strong><small>{beatLabel(item, index)}</small></button>)}</div>
      <span className="linear-status">{item.confidence === 'low' ? '! Низкая уверенность' : 'Проверено'}</span>
    </div></li>)}</ol></section>
    <section className="linear-section"><span className="eyebrow">Редактор события</span><h2>{event.chord} · {event.start}–{event.end}</h2><p>Для полной формы открой вариант A.</p></section>
  </main></div>
}

function PrototypeSwitcher({ variant, cycle }) {
  if (!import.meta.env.DEV) return null
  return <nav className="prototype-switcher" aria-label="Варианты прототипа"><button onClick={() => cycle(-1)} aria-label="Предыдущий вариант">←</button><strong>{VARIANTS[variant]}</strong><button onClick={() => cycle(1)} aria-label="Следующий вариант">→</button></nav>
}

function Shortcuts({ onClose }) {
  const closeRef = useRef(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
    <div className="panel-heading"><h2 id="shortcut-title">Клавиши</h2><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
    <dl className="shortcut-list"><div><dt>Space</dt><dd>Play / pause</dd></div><div><dt>[ / ]</dt><dd>Предыдущий / следующий такт</dd></div><div><dt>L</dt><dd>Включить или выключить луп</dd></div><div><dt>← / →</dt><dd>Сменить вариант</dd></div><div><dt>Esc</dt><dd>Закрыть окно</dd></div></dl>
  </section></div>
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [variant, , cycleVariant] = useVariant()
  const selectedBar = useMemo(() => state.bars.find((bar) => bar.id === state.activeBarId), [state.bars, state.activeBarId])
  const selectedEvent = useMemo(() => selectedBar.events.find((event) => event.id === state.activeEventId), [selectedBar, state.activeEventId])

  useEffect(() => {
    document.documentElement.classList.toggle('reduced-motion', state.reducedMotion)
    return () => document.documentElement.classList.remove('reduced-motion')
  }, [state.reducedMotion])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && state.modal) { dispatch({ type: 'setModal', open: false }); return }
      if (state.modal || event.target.matches('input, textarea, select, button, a, [contenteditable]')) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); cycleVariant(-1) }
      if (event.key === 'ArrowRight') { event.preventDefault(); cycleVariant(1) }
      if (event.key === ' ') { event.preventDefault(); dispatch({ type: 'togglePlaying' }) }
      if (event.key === '[') dispatch({ type: 'moveBar', delta: -1 })
      if (event.key === ']') dispatch({ type: 'moveBar', delta: 1 })
      if (event.key.toLowerCase() === 'l') dispatch({ type: 'toggleLoop' })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [cycleVariant, state.modal])

  return <>
    <a className="skip-link" href="#workspace-main">Перейти к рабочей области</a>
    {variant === 'A' && <VariantA state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}
    {variant === 'B' && <VariantB state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}
    {variant === 'C' && <VariantC state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}
    <PrototypeSwitcher variant={variant} cycle={cycleVariant} />
    {state.modal && <Shortcuts onClose={() => dispatch({ type: 'setModal', open: false })} />}
  </>
}
