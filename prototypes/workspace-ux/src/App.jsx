import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

const VARIANTS = { A: 'A — Редактор', B: 'B — Режимы', C: 'C — Список' }
const PX_PER_UNIT = 20
const UNITS_PER_WHOLE = 16
const UNITS_PER_SECOND = 88 / 48
const SOURCE_START_SECONDS = 0

const INITIAL_BARS = [
  { id: 'bar-1', number: 1, meter: '4/4', section: 'Вступление', confidence: 'ok', events: [
    { id: '1-c', chord: 'C', duration: 8 }, { id: '1-g', chord: 'G', duration: 8 },
  ] },
  { id: 'bar-2', number: 2, meter: '4/4', section: 'Куплет 1', confidence: 'low', events: [
    { id: '2-am', chord: 'Am', duration: 8 }, { id: '2-f', chord: 'F', duration: 8 },
  ] },
  { id: 'bar-3', number: 3, meter: '4/4', section: 'Куплет 1', confidence: 'ok', events: [
    { id: '3-c', chord: 'C', duration: 8 }, { id: '3-g7', chord: 'G7', duration: 8 },
  ] },
  { id: 'bar-4', number: 4, meter: '4/4', section: 'Припев', confidence: 'ok', events: [
    { id: '4-am', chord: 'Am', duration: 8 }, { id: '4-f', chord: 'F', duration: 8 },
  ] },
  { id: 'bar-5', number: 5, meter: '3/4', section: 'Припев', confidence: 'low', events: [
    { id: '5-dm', chord: 'Dm', duration: 8 }, { id: '5-g', chord: 'G', duration: 4 },
  ] },
  { id: 'bar-6', number: 6, meter: '3/4', section: 'Проигрыш', confidence: 'ok', events: [
    { id: '6-cmaj7', chord: 'Cmaj7', duration: 12 },
  ] },
]

const DURATION_OPTIONS = [
  { units: 1, label: '1/16' }, { units: 2, label: '1/8' }, { units: 4, label: '1/4' },
  { units: 8, label: '1/2' }, { units: 16, label: '1/1' },
]

const CHORD_ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const CHORD_TYPES = [
  { id: 'major', suffix: '', label: 'мажор' },
  { id: 'minor', suffix: 'm', label: 'минор' },
  { id: 'dim', suffix: 'dim', label: 'уменьш.' },
  { id: 'aug', suffix: 'aug', label: 'увелич.' },
  { id: 'sus2', suffix: 'sus2', label: 'sus 2' },
  { id: 'sus4', suffix: 'sus4', label: 'sus 4' },
  { id: 'six', suffix: '6', label: 'с секстой' },
  { id: 'seven', suffix: '7', label: 'доминант' },
  { id: 'major-seven', suffix: 'maj7', label: 'большая 7' },
  { id: 'minor-seven', suffix: 'm7', label: 'минорная 7' },
  { id: 'dim-seven', suffix: 'dim7', label: 'уменьш. 7' },
  { id: 'half-dim', suffix: 'm7♭5', label: 'полууменьш.' },
  { id: 'add-nine', suffix: 'add9', label: 'добавл. 9' },
  { id: 'nine', suffix: '9', label: 'с ноною' },
]

const LYRIC_WORDS = [
  { text: 'Я', start: 18, end: 20 }, { text: 'хотел', start: 20, end: 23 },
  { text: 'бы', start: 23, end: 25 }, { text: 'остаться', start: 25, end: 28 },
  { text: 'с', start: 28, end: 29 }, { text: 'тобой,', start: 29, end: 32 },
  { text: 'просто', start: 32, end: 36 }, { text: 'остаться', start: 36, end: 40 },
  { text: 'с', start: 40, end: 42 }, { text: 'тобой', start: 42, end: 46 },
]

const STATES = [
  { label: 'Готово', title: 'Проект готов', detail: 'Все данные доступны. Правок: 3.', tone: 'good', symbol: '✓' },
  { label: 'Анализ', title: 'Анализируем гармонию', detail: 'Этап 3 из 5. Предыдущая ревизия доступна.', tone: 'busy', symbol: '◌' },
  { label: 'Низкая уверенность', title: 'Нужно проверить 2 места', detail: 'Такты 2 и 5 отмечены текстом и узором.', tone: 'warn', symbol: '!' },
  { label: 'Ошибка', title: 'Новая ревизия не создана', detail: 'Исходный анализ и правки сохранены.', tone: 'danger', symbol: '×' },
]

const initialState = {
  bars: INITIAL_BARS,
  activeBarId: 'bar-3', activeEventId: '3-c',
  selectedRange: null, loopRange: null, loopEnabled: false, positionUnits: 32,
  statusIndex: 0, playing: false, reducedMotion: false, mode: 'Редактор', modal: false,
  dirtyBarIds: [],
}

const meterParts = (bar) => bar.meter.split('/').map(Number)
const barCapacity = (bar) => { const [beats, denominator] = meterParts(bar); return beats * (UNITS_PER_WHOLE / denominator) }
const barUsed = (bar) => bar.events.reduce((sum, event) => sum + event.duration, 0)
const barOffsets = (bars) => bars.map((_, index) => bars.slice(0, index).reduce((sum, bar) => sum + barCapacity(bar), 0))
const totalUnits = (bars) => bars.reduce((sum, bar) => sum + barCapacity(bar), 0)
const markDirty = (state, barId) => state.dirtyBarIds.includes(barId) ? state.dirtyBarIds : [...state.dirtyBarIds, barId]

function reducer(state, action) {
  switch (action.type) {
    case 'selectBar': {
      const bar = state.bars.find((item) => item.id === action.barId)
      return { ...state, activeBarId: bar.id, activeEventId: bar.events[0].id }
    }
    case 'selectEvent':
      return { ...state, activeBarId: action.barId, activeEventId: action.eventId }
    case 'setRange':
      return { ...state, selectedRange: { start: Math.min(action.anchor, action.focus), end: Math.max(action.anchor, action.focus) } }
    case 'clearRange':
      return { ...state, selectedRange: null }
    case 'setLoopFromSelection':
      return state.selectedRange ? { ...state, loopEnabled: true, loopRange: { ...state.selectedRange } } : state
    case 'disableLoop':
      return { ...state, loopEnabled: false, loopRange: null }
    case 'deleteRange': {
      if (!state.selectedRange) return state
      const { start, end } = state.selectedRange
      if (end - start + 1 >= state.bars.length) return state
      const bars = state.bars.filter((_, index) => index < start || index > end).map((bar, index) => ({ ...bar, number: index + 1 }))
      const target = bars[Math.min(start, bars.length - 1)]
      return { ...state, bars, activeBarId: target.id, activeEventId: target.events[0].id, selectedRange: null, loopRange: null, loopEnabled: false, positionUnits: 0 }
    }
    case 'updateEvent':
      return {
        ...state,
        dirtyBarIds: markDirty(state, state.activeBarId),
        bars: state.bars.map((bar) => bar.id !== state.activeBarId ? bar : {
          ...bar, events: bar.events.map((event) => event.id === state.activeEventId ? { ...event, ...action.patch } : event),
        }),
      }
    case 'addEvent':
      return {
        ...state,
        activeEventId: action.event.id,
        dirtyBarIds: markDirty(state, state.activeBarId),
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
      const events = bar.events.filter((event) => event.id !== state.activeEventId)
      return {
        ...state,
        activeEventId: events[Math.min(index, events.length - 1)].id,
        dirtyBarIds: markDirty(state, bar.id),
        bars: state.bars.map((item) => item.id === bar.id ? { ...item, events } : item),
      }
    }
    case 'confirmBar':
      return { ...state, bars: state.bars.map((bar) => bar.id === action.barId ? { ...bar, confidence: 'reviewed' } : bar) }
    case 'flagBarForReview':
      return { ...state, bars: state.bars.map((bar) => bar.id === action.barId ? { ...bar, confidence: 'low' } : bar) }
    case 'saveBar':
      return { ...state, dirtyBarIds: state.dirtyBarIds.filter((id) => id !== state.activeBarId) }
    case 'moveBar': {
      const index = state.bars.findIndex((bar) => bar.id === state.activeBarId)
      const targetIndex = Math.max(0, Math.min(state.bars.length - 1, index + action.delta))
      const target = state.bars[targetIndex]
      return { ...state, activeBarId: target.id, activeEventId: target.events[0].id, positionUnits: barOffsets(state.bars)[targetIndex] }
    }
    case 'setPosition': return { ...state, positionUnits: Math.max(0, Math.min(totalUnits(state.bars), action.value)) }
    case 'setPlaying': return { ...state, playing: action.value }
    case 'togglePlayback': {
      if (state.playing) return { ...state, playing: false }
      if (!state.loopEnabled || !state.loopRange) return { ...state, playing: true }
      const loopStart = barOffsets(state.bars)[state.loopRange.start]
      return { ...state, playing: true, positionUnits: loopStart }
    }
    case 'cycleStatus': return { ...state, statusIndex: (state.statusIndex + 1) % STATES.length }
    case 'toggleMotion': return { ...state, reducedMotion: !state.reducedMotion }
    case 'setMode': return { ...state, mode: action.mode }
    case 'setModal': return { ...state, modal: action.open }
    default: return state
  }
}

function durationOptionsForBar(bar) {
  const capacity = barCapacity(bar)
  return [...DURATION_OPTIONS.filter((item) => item.units < capacity), { units: capacity, label: `${bar.meter} · весь такт` }]
}
function durationLabel(units, bar) {
  if (bar && units === barCapacity(bar)) return `${bar.meter} · весь такт`
  return DURATION_OPTIONS.find((item) => item.units === units)?.label || `${units}/16`
}
function chordSymbol(draft) {
  if (draft.noChord) return 'N'
  const type = CHORD_TYPES.find((item) => item.id === draft.type) || CHORD_TYPES[0]
  return `${draft.root}${type.suffix}${draft.bass ? `/${draft.bass}` : ''}`
}
function parseChord(symbol) {
  if (symbol === 'N') return { noChord: true, root: 'C', type: 'major', bass: '' }
  const [body, bass = ''] = symbol.split('/')
  const root = [...CHORD_ROOTS].sort((left, right) => right.length - left.length).find((item) => body.startsWith(item)) || 'C'
  const suffix = body.slice(root.length)
  const type = CHORD_TYPES.find((item) => item.suffix === suffix)?.id || 'major'
  return { noChord: false, root, type, bass: CHORD_ROOTS.includes(bass) ? bass : '' }
}
function timedChordEvents(bars) {
  const result = []
  let barStart = 0
  bars.forEach((bar) => {
    let eventStart = barStart
    bar.events.forEach((event) => {
      result.push({ chord: event.chord, start: eventStart, end: eventStart + event.duration })
      eventStart += event.duration
    })
    barStart += barCapacity(bar)
  })
  return result
}
function chordLabelsForLyrics(bars, words) {
  const labels = Array(words.length).fill('')
  timedChordEvents(bars).forEach((event) => {
    const wordIndex = words.findIndex((word) => event.start < word.end && event.end > word.start)
    if (wordIndex >= 0 && !labels[wordIndex]) labels[wordIndex] = event.chord
  })
  return labels
}
function rangesEqual(left, right) { return Boolean(left && right && left.start === right.start && left.end === right.end) }
function formatTime(positionUnits) {
  const seconds = SOURCE_START_SECONDS + positionUnits / UNITS_PER_SECOND
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}

function useVariant() {
  const read = () => { const value = new URLSearchParams(location.search).get('variant') || 'A'; return VARIANTS[value] ? value : 'A' }
  const [variant, setVariantState] = useState(read)
  const setVariant = (next) => { const params = new URLSearchParams(location.search); params.set('variant', next); history.replaceState({}, '', `${location.pathname}?${params}`); setVariantState(next) }
  const cycle = (delta) => { const keys = Object.keys(VARIANTS); setVariant(keys[(keys.indexOf(variant) + delta + keys.length) % keys.length]) }
  return [variant, cycle]
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
    <span className="status-symbol" aria-hidden="true">{status.symbol}</span><div><strong>{status.title}</strong><span>{status.detail}</span></div>
  </section>
}

function SelectionToolbar({ state, dispatch }) {
  if (!state.selectedRange) return null
  const count = state.selectedRange.end - state.selectedRange.start + 1
  const first = state.bars[state.selectedRange.start]?.number
  const last = state.bars[state.selectedRange.end]?.number
  const selectionIsLoop = state.loopEnabled && rangesEqual(state.selectedRange, state.loopRange)
  const loopActionLabel = selectionIsLoop ? 'Выключить loop' : state.loopEnabled ? 'Перенести loop на выбранное' : 'Зациклить выбранное'
  return <section className="selection-toolbar" aria-label="Действия с выбранными тактами">
    <div><strong>{count === 1 ? `Такт ${first}` : `Такты ${first}–${last}`}</strong><span>Выбрано мышью</span></div>
    <button className="primary-button" aria-pressed={selectionIsLoop} onClick={() => dispatch({ type: selectionIsLoop ? 'disableLoop' : 'setLoopFromSelection' })}>{loopActionLabel}</button>
    <button className="danger-button" disabled={count === state.bars.length} onClick={() => dispatch({ type: 'deleteRange' })}>Удалить такты</button>
    <button className="quiet-button" onClick={() => dispatch({ type: 'clearRange' })}>Снять выделение</button>
  </section>
}

function Timeline({ state, dispatch, simple = false }) {
  const scrollRef = useRef(null)
  const trackRef = useRef(null)
  const rangeDrag = useRef(null)
  const scrubDrag = useRef(null)
  const autoScrollFrame = useRef(null)

  useEffect(() => {
    if (!scrollRef.current || scrubDrag.current) return
    scrollRef.current.scrollLeft = state.positionUnits * PX_PER_UNIT
  }, [state.positionUnits])

  useEffect(() => () => {
    if (autoScrollFrame.current) cancelAnimationFrame(autoScrollFrame.current)
  }, [])

  const rangeIndexAt = (clientX) => {
    const nodes = [...trackRef.current.querySelectorAll('[data-bar-index]')]
    let best = 0; let distance = Infinity
    nodes.forEach((node) => { const rect = node.getBoundingClientRect(); const next = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0; if (next < distance) { distance = next; best = Number(node.dataset.barIndex) } })
    return best
  }
  const startRange = (event, index) => {
    if (event.button !== 0) return
    event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic QA events do not own a native pointer */ }
    rangeDrag.current = { pointerId: event.pointerId, anchor: index, lastX: event.clientX }
    dispatch({ type: 'setRange', anchor: index, focus: index })
  }
  const runEdgeAutoScroll = () => {
    if (autoScrollFrame.current || !rangeDrag.current) return
    const tick = () => {
      const drag = rangeDrag.current; const scroller = scrollRef.current
      if (!drag || !scroller) { autoScrollFrame.current = null; return }
      const rect = scroller.getBoundingClientRect(); const edge = Math.min(80, rect.width * .16)
      let delta = 0
      if (drag.lastX > rect.right - edge) delta = 4 + 20 * Math.min(1, (drag.lastX - (rect.right - edge)) / edge)
      if (drag.lastX < rect.left + edge) delta = -(4 + 20 * Math.min(1, ((rect.left + edge) - drag.lastX) / edge))
      if (delta) {
        const previous = scroller.scrollLeft
        scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, previous + delta))
        if (scroller.scrollLeft !== previous) {
          dispatch({ type: 'setPosition', value: scroller.scrollLeft / PX_PER_UNIT })
          dispatch({ type: 'setRange', anchor: drag.anchor, focus: rangeIndexAt(drag.lastX) })
        }
      }
      autoScrollFrame.current = requestAnimationFrame(tick)
    }
    autoScrollFrame.current = requestAnimationFrame(tick)
  }
  const moveRange = (event) => {
    if (!rangeDrag.current) return
    rangeDrag.current.lastX = event.clientX
    dispatch({ type: 'setRange', anchor: rangeDrag.current.anchor, focus: rangeIndexAt(event.clientX) })
    runEdgeAutoScroll()
  }
  const endRange = (event) => {
    if (!rangeDrag.current) return
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* see startRange */ }
    rangeDrag.current = null
    if (autoScrollFrame.current) cancelAnimationFrame(autoScrollFrame.current)
    autoScrollFrame.current = null
  }
  const startScrub = (event) => {
    if (event.button !== 0) return
    event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic QA events do not own a native pointer */ }
    const viewport = event.currentTarget.closest('.timeline-viewport').getBoundingClientRect()
    scrubDrag.current = { pointerId: event.pointerId, x: event.clientX, minX: viewport.left, maxX: viewport.right, scrollLeft: scrollRef.current.scrollLeft }
    event.currentTarget.closest('.timeline-viewport')?.classList.add('scrubbing')
  }
  const moveScrub = (event) => {
    if (!scrubDrag.current) return
    const drag = scrubDrag.current; const scroller = scrollRef.current
    if (drag.pointerId != null && event.pointerId !== drag.pointerId) return
    event.preventDefault()
    const maxScroll = scroller.scrollWidth - scroller.clientWidth
    const delta = event.clientX - drag.x
    const availablePointerTravel = delta >= 0 ? drag.maxX - drag.x : drag.x - drag.minX
    const progress = Math.max(-1, Math.min(1, delta / Math.max(1, availablePointerTravel)))
    const remainingScroll = progress >= 0 ? maxScroll - drag.scrollLeft : drag.scrollLeft
    scroller.scrollLeft = drag.scrollLeft + progress * remainingScroll
    dispatch({ type: 'setPosition', value: scroller.scrollLeft / PX_PER_UNIT })
  }
  const endScrub = (event) => {
    if (!scrubDrag.current) return
    if (scrubDrag.current.pointerId != null && event.pointerId !== scrubDrag.current.pointerId) return
    try { event.target.releasePointerCapture(event.pointerId) } catch { /* pointer may finish outside the handle */ }
    scrollRef.current?.closest('.timeline-viewport')?.classList.remove('scrubbing')
    scrubDrag.current = null
  }

  useEffect(() => {
    window.addEventListener('pointermove', moveScrub, { passive: false })
    window.addEventListener('pointerup', endScrub)
    window.addEventListener('pointercancel', endScrub)
    return () => {
      window.removeEventListener('pointermove', moveScrub)
      window.removeEventListener('pointerup', endScrub)
      window.removeEventListener('pointercancel', endScrub)
    }
  }, [])

  return <section className={`timeline-shell ${simple ? 'simple' : ''}`} aria-label="Музыкальный таймлайн">
    <div className="timeline-heading"><div><span className="eyebrow">Таймлайн</span><h2>Тяни playhead для перемотки</h2></div><div className="legend"><span className="legend-low">Низкая уверенность</span><span>Playhead {formatTime(state.positionUnits)}</span></div></div>
    <SelectionToolbar state={state} dispatch={dispatch} />
    <div className="timeline-viewport">
      <div className="center-line"><button className="playhead-handle" aria-label="Перемотка за playhead" onPointerDown={startScrub} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); dispatch({ type: 'setPosition', value: state.positionUnits + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 4 : 1) }) } }}><span aria-hidden="true">↔</span></button></div>
      <div ref={scrollRef} className="timeline-scroll" tabIndex="0" aria-label="Такты и отдельные события аккордов">
        <div ref={trackRef} className="bars-track">
        {state.bars.map((bar, barIndex) => {
          const capacity = barCapacity(bar); const used = barUsed(bar); let eventStart = 0
          const selected = state.selectedRange && barIndex >= state.selectedRange.start && barIndex <= state.selectedRange.end
          const looped = state.loopEnabled && state.loopRange && barIndex >= state.loopRange.start && barIndex <= state.loopRange.end
          const loopEdge = looped ? `${barIndex === state.loopRange.start ? ' loop-start' : ''}${barIndex === state.loopRange.end ? ' loop-end' : ''}` : ''
          return <article key={bar.id} data-bar-index={barIndex} className={`bar ${bar.id === state.activeBarId ? 'active' : ''} ${selected ? 'range-selected' : ''} ${looped ? `looped${loopEdge}` : ''} ${bar.confidence === 'low' ? 'low' : ''} ${used > capacity ? 'invalid' : ''}`} style={{ width: capacity * PX_PER_UNIT }} aria-label={`Такт ${bar.number}, размер ${bar.meter}${looped ? ', в активном loop' : ''}`}>
            {looped && barIndex === state.loopRange.start && <span className="loop-badge">LOOP</span>}
            <button className="bar-select" onPointerDown={(event) => startRange(event, barIndex)} onPointerMove={moveRange} onPointerUp={endRange} onPointerCancel={endRange} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dispatch({ type: 'setRange', anchor: barIndex, focus: barIndex }) } }}>
              <span><b>Такт {bar.number}</b><small>{bar.section}</small></span><small>{bar.meter}</small>
            </button>
            <div className="event-lane"><div className="beat-grid" aria-label={`${meterParts(bar)[0]} интервала долей`}>
              {Array.from({ length: meterParts(bar)[0] }, (_, beat) => <span key={beat} />)}
            </div>{bar.events.map((chordEvent) => {
              const start = eventStart; eventStart += chordEvent.duration
              const compact = chordEvent.duration <= 2
              return <button key={chordEvent.id} data-chord={chordEvent.chord} title={`${chordEvent.chord} · ${durationLabel(chordEvent.duration, bar)}`} aria-label={`${chordEvent.chord}, длительность ${durationLabel(chordEvent.duration, bar)}`} className={`chord-event ${chordEvent.id === state.activeEventId ? 'selected' : ''} ${compact ? 'compact-event' : ''}`} style={{ left: start * PX_PER_UNIT, width: chordEvent.duration * PX_PER_UNIT }} onClick={() => dispatch({ type: 'selectEvent', barId: bar.id, eventId: chordEvent.id })}><b>{chordEvent.chord}</b></button>
            })}</div>
            {bar.confidence === 'low' && <span className="confidence-label">! проверить</span>}
            {bar.confidence === 'reviewed' && <span className="confidence-label reviewed">✓ проверено вручную</span>}
          </article>
        })}
        </div>
      </div>
    </div>
  </section>
}

function EventEditor({ state, bar, event, dispatch }) {
  const [chordDraft, setChordDraft] = useState(() => parseChord(event.chord))
  const [chordPickerStep, setChordPickerStep] = useState('root')
  const chordPickerRef = useRef(null)
  useEffect(() => { setChordDraft(parseChord(event.chord)); setChordPickerStep('root') }, [event.id, event.chord])
  const activeIndex = bar.events.findIndex((item) => item.id === event.id)
  const start = bar.events.slice(0, activeIndex).reduce((sum, item) => sum + item.duration, 0)
  const capacity = barCapacity(bar); const used = barUsed(bar); const delta = used - capacity
  const valid = delta === 0
  const name = chordSymbol(chordDraft)
  const save = (submitEvent) => { submitEvent.preventDefault(); if (!valid) return; dispatch({ type: 'updateEvent', patch: { chord: name } }); dispatch({ type: 'saveBar' }) }
  const closeChordPicker = () => chordPickerRef.current?.removeAttribute('open')
  const chooseRoot = (root) => {
    setChordDraft((current) => ({ ...current, noChord: false, root, bass: current.root === root ? current.bass : '' }))
    setChordPickerStep('quality')
  }
  const chooseQuality = (type) => {
    setChordDraft((current) => ({ ...current, noChord: false, type }))
    setChordPickerStep('bass')
  }
  return <aside className="inspector panel" aria-label="Редактор выбранного события аккорда">
    <div className="panel-heading"><div><span className="eyebrow">Редактор события</span><strong>Такт {bar.number}</strong></div><span className="event-counter">{activeIndex + 1} из {bar.events.length}</span></div>
    <div className="event-picker" role="group" aria-label={`Аккорды в такте ${bar.number}`}>{bar.events.map((item) => <button key={item.id} className={`event-option ${item.id === event.id ? 'selected' : ''}`} aria-pressed={item.id === event.id} onClick={() => dispatch({ type: 'selectEvent', barId: bar.id, eventId: item.id })}><strong>{item.chord}</strong><span>{durationLabel(item.duration, bar)}</span></button>)}</div>
    {bar.confidence === 'low' && <section className="review-status warn" aria-label="Такт требует проверки"><div><strong>Автоанализ не уверен</strong><span>Проверь все аккорды в такте. Если всё правильно — подтверди его.</span></div><button className="primary-button" type="button" onClick={() => dispatch({ type: 'confirmBar', barId: bar.id })}>✓ Подтвердить такт</button></section>}
    {bar.confidence === 'reviewed' && <section className="review-status good" aria-label="Такт проверен вручную"><div><strong>✓ Проверено вручную</strong><span>Предупреждение снято после твоего подтверждения.</span></div><button className="quiet-button" type="button" onClick={() => dispatch({ type: 'flagBarForReview', barId: bar.id })}>Вернуть на проверку</button></section>}
    <form onSubmit={save}>
      <div className="field-group"><details ref={chordPickerRef} className="chord-picker-dropdown" onToggle={(toggleEvent) => { if (toggleEvent.currentTarget.open) setChordPickerStep('root') }}>
        <summary><span>Аккорд</span><strong aria-live="polite">{name}</strong><span>Изменить⌄</span></summary>
        <div className="chord-picker-menu">
          {chordPickerStep === 'root' && <section className="chord-step" aria-label="Выбор корня аккорда"><div className="chord-step-heading"><span>Шаг 1</span><strong>Выбери корень</strong></div><div className="root-button-grid">{CHORD_ROOTS.map((root) => <button key={root} type="button" className={!chordDraft.noChord && chordDraft.root === root ? 'selected' : ''} aria-pressed={!chordDraft.noChord && chordDraft.root === root} onClick={() => chooseRoot(root)}>{root}</button>)}<button className={`no-chord-root ${chordDraft.noChord ? 'selected' : ''}`} type="button" aria-pressed={chordDraft.noChord} onClick={() => { setChordDraft((current) => ({ ...current, noChord: true, bass: '' })); closeChordPicker() }}><strong>N</strong><span>нет аккорда</span></button></div></section>}
          {chordPickerStep === 'quality' && <section className="chord-step" aria-label={`Выбор варианта аккорда ${chordDraft.root}`}><div className="chord-step-nav"><button type="button" onClick={() => setChordPickerStep('root')}>← Назад к корню</button></div><div className="chord-step-heading"><span>Шаг 2 · корень {chordDraft.root}</span><strong>Какой это аккорд?</strong></div><div className="primary-quality-grid">{CHORD_TYPES.slice(0, 2).map((type) => <button key={type.id} type="button" className={chordDraft.type === type.id ? 'selected' : ''} onClick={() => chooseQuality(type.id)}><strong>{chordDraft.root}{type.suffix}</strong><span>{type.label}</span></button>)}</div><span className="other-quality-label">Другие варианты</span><div className="other-quality-grid">{CHORD_TYPES.slice(2).map((type) => <button key={type.id} type="button" className={chordDraft.type === type.id ? 'selected' : ''} onClick={() => chooseQuality(type.id)}>{chordDraft.root}{type.suffix}</button>)}</div></section>}
          {chordPickerStep === 'bass' && <section className="chord-step" aria-label="Выбор баса для slash-аккорда"><div className="chord-step-nav"><button type="button" onClick={() => setChordPickerStep('quality')}>← Назад к варианту</button></div><div className="chord-step-heading"><span>Шаг 3 · {chordSymbol({ ...chordDraft, bass: '' })}</span><strong>Добавить отдельный бас?</strong></div><button type="button" className="finish-without-bass" onClick={() => { setChordDraft((current) => ({ ...current, bass: '' })); closeChordPicker() }}><strong>Готово без баса</strong><span>{chordSymbol({ ...chordDraft, bass: '' })}</span></button><span className="other-quality-label">Или выбери бас для slash-аккорда</span><div className="bass-button-grid">{CHORD_ROOTS.map((root) => <button key={root} type="button" className={chordDraft.bass === root ? 'selected' : ''} onClick={() => { setChordDraft((current) => ({ ...current, bass: root })); closeChordPicker() }}>{root}</button>)}</div></section>}
        </div>
      </details>
        <fieldset className="duration-control"><legend>Длительность аккорда</legend><div>{durationOptionsForBar(bar).map((option) => <button key={option.units} type="button" className={event.duration === option.units ? 'selected' : ''} aria-pressed={event.duration === option.units} onClick={() => dispatch({ type: 'updateEvent', patch: { duration: option.units } })}>{option.label}</button>)}</div></fieldset>
        <div className="event-position"><span>Начало вычислено автоматически</span><strong>{start + 1}-я шестнадцатая такта</strong></div>
        <div className={`validation-banner ${valid ? 'valid' : 'invalid'}`} role="status">
          {valid ? <><strong>Такт заполнен точно</strong><span>{used} из {capacity} шестнадцатых</span></> : delta > 0 ? <><strong>Конфликт: аккорды выходят за такт</strong><span>Уменьши длительности на {delta}/16</span></> : <><strong>В такте остался разрыв</strong><span>Добавь или растяни аккорды ещё на {-delta}/16</span></>}
        </div>
      </div>
      <div className="button-pair"><button className="primary-button" type="submit" disabled={!valid}>Сохранить раскладку</button><button className="quiet-button" type="button" onClick={() => dispatch({ type: 'addEvent', event: { id: crypto.randomUUID(), chord: 'N', duration: 4 } })}>＋ Аккорд после этого</button><button className="danger-button" type="button" disabled={bar.events.length === 1} onClick={() => dispatch({ type: 'deleteEvent' })}>Удалить аккорд</button></div>
    </form>
    <p className="original-note">{state.dirtyBarIds.includes(bar.id) ? 'Есть несохранённые изменения.' : 'Раскладка сохранена. Original остаётся отдельно.'}</p>
  </aside>
}

function Transport({ state, dispatch }) {
  const selected = state.selectedRange
  const loop = state.loopRange
  const loopLabel = state.loopEnabled && loop ? `Луп: ${state.bars[loop.start].number}${loop.start === loop.end ? '' : `–${state.bars[loop.end].number}`}` : !selected ? 'Луп: выбери такты' : `Зациклить: ${state.bars[selected.start].number}${selected.start === selected.end ? '' : `–${state.bars[selected.end].number}`}`
  return <section className="transport" aria-label="Проигрывание">
    <button className="transport-key" aria-label="Предыдущий такт" onClick={() => dispatch({ type: 'moveBar', delta: -1 })}>‹</button>
    <button className="play-button" aria-label={state.playing ? 'Пауза' : 'Воспроизвести'} aria-pressed={state.playing} onClick={() => dispatch({ type: 'togglePlayback' })}>{state.playing ? 'Ⅱ' : '▶'}</button>
    <button className="transport-key" aria-label="Следующий такт" onClick={() => dispatch({ type: 'moveBar', delta: 1 })}>›</button>
    <div className="time-readout"><strong>{formatTime(state.positionUnits)}</strong><span>/ {formatTime(totalUnits(state.bars))}</span></div>
    <button className="chip-button" disabled={!state.loopEnabled && !selected} aria-pressed={state.loopEnabled} onClick={() => dispatch({ type: state.loopEnabled ? 'disableLoop' : 'setLoopFromSelection' })}>{loopLabel}</button>
    <button className="chip-button">Скорость 1×</button><button className="chip-button">Метроном</button>
  </section>
}

function VariantA({ state, dispatch, bar, event }) {
  const currentLyricIndex = LYRIC_WORDS.findIndex((word) => state.positionUnits >= word.start && state.positionUnits < word.end)
  const lyricChordLabels = useMemo(() => chordLabelsForLyrics(state.bars, LYRIC_WORDS), [state.bars])
  return <div className="shell variant-a"><Header state={state} dispatch={dispatch} /><div className="studio-grid">
    <main id="workspace-main" className="studio-main" tabIndex="-1"><div className="editor-intro"><div><span className="eyebrow">Редактор</span><h1>Такты, доли и аккорды</h1><p>Тяни заголовки тактов для диапазона. У края выделение продолжится с автоскроллом. Тяни playhead для перемотки.</p></div><StatusBanner state={state} /></div><Timeline state={state} dispatch={dispatch} /><section className="lyrics-strip" aria-label="Текст песни с аккордами и таймингом"><div className="lyrics-heading"><span className="eyebrow">Текст и аккорды</span><span className="lyrics-key"><b>Am</b> аккорд по таймингу <i aria-hidden="true" /> текущее слово</span></div><p>{LYRIC_WORDS.map((word, index) => <span className="lyric-token" key={`${word.text}-${index}`}><strong className="lyric-chord" aria-hidden={lyricChordLabels[index] ? undefined : true}>{lyricChordLabels[index] || '\u00a0'}</strong><span>{index === currentLyricIndex ? <mark title="Сейчас звучит это слово">{word.text}</mark> : word.text}</span></span>)}</p></section></main>
    <EventEditor state={state} bar={bar} event={event} dispatch={dispatch} />
  </div><footer className="studio-footer"><Transport state={state} dispatch={dispatch} /></footer></div>
}

function VariantB({ state, dispatch, bar, event }) {
  const practice = state.mode === 'Практика'
  return <div className="shell variant-b"><Header state={state} dispatch={dispatch} /><nav className="mode-tabs" aria-label="Режим работы">{['Обзор', 'Редактор', 'Практика'].map((mode) => <button key={mode} className={state.mode === mode ? 'selected' : ''} onClick={() => dispatch({ type: 'setMode', mode })}>{mode}</button>)}</nav><main id="workspace-main" className="focus-main"><StatusBanner state={state} />{practice ? <section className="practice-stage"><span className="eyebrow">Сейчас · такт {bar.number}</span><div className="hero-chord">{event.chord}</div><Transport state={state} dispatch={dispatch} /></section> : <Timeline state={state} dispatch={dispatch} simple />}</main></div>
}

function VariantC({ state, dispatch, bar, event }) {
  return <div className="shell variant-c"><Header state={state} dispatch={dispatch} /><main id="workspace-main" className="linear-main"><section className="linear-section"><span className="eyebrow">Текущее событие</span><div className="section-heading"><h1>Такт {bar.number}</h1><span className="big-chord">{event.chord}</span></div><Transport state={state} dispatch={dispatch} /></section><section className="linear-section"><span className="eyebrow">Список событий</span><ol className="linear-bars">{state.bars.map((item) => <li key={item.id} className={item.id === bar.id ? 'active' : ''}><div className="linear-bar-row"><button className="linear-bar-name" onClick={() => dispatch({ type: 'selectBar', barId: item.id })}><span className="linear-number">{item.number}</span><span><strong>Такт {item.number} · {item.meter}</strong><small>{item.section}</small></span></button><div className="linear-event-list">{item.events.map((chordEvent) => <button key={chordEvent.id} className={`linear-event ${chordEvent.id === event.id ? 'selected' : ''}`} onClick={() => dispatch({ type: 'selectEvent', barId: item.id, eventId: chordEvent.id })}><strong>{chordEvent.chord}</strong><small>{durationLabel(chordEvent.duration, item)}</small></button>)}</div><span className="linear-status">{item.confidence === 'low' ? '! Проверить' : item.confidence === 'reviewed' ? '✓ Вручную' : 'Проверено'}</span></div></li>)}</ol></section></main></div>
}

function PrototypeSwitcher({ variant, cycle }) { if (!import.meta.env.DEV) return null; return <nav className="prototype-switcher"><button onClick={() => cycle(-1)} aria-label="Предыдущий вариант">←</button><strong>{VARIANTS[variant]}</strong><button onClick={() => cycle(1)} aria-label="Следующий вариант">→</button></nav> }
function Shortcuts({ onClose }) { const closeRef = useRef(null); useEffect(() => closeRef.current?.focus(), []); return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="panel-heading"><h2 id="shortcut-title">Клавиши</h2><button ref={closeRef} className="icon-button" onClick={onClose}>×</button></div><dl className="shortcut-list"><div><dt>Space</dt><dd>Play / pause</dd></div><div><dt>[ / ]</dt><dd>Предыдущий / следующий такт</dd></div><div><dt>Drag тактов</dt><dd>Выбрать диапазон; у края включается автоскролл</dd></div><div><dt>Drag playhead</dt><dd>Перемотка при неподвижной центральной линии</dd></div><div><dt>Esc</dt><dd>Закрыть окно</dd></div></dl></section></div> }

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [variant, cycleVariant] = useVariant()
  const selectedBar = useMemo(() => state.bars.find((bar) => bar.id === state.activeBarId), [state.bars, state.activeBarId])
  const selectedEvent = useMemo(() => selectedBar.events.find((event) => event.id === state.activeEventId), [selectedBar, state.activeEventId])
  const positionRef = useRef(state.positionUnits)
  useEffect(() => { positionRef.current = state.positionUnits }, [state.positionUnits])
  const loopBounds = useMemo(() => {
    if (!state.loopRange) return null
    const offsets = barOffsets(state.bars); const start = offsets[state.loopRange.start]; const endBar = state.bars[state.loopRange.end]
    return { start, end: offsets[state.loopRange.end] + barCapacity(endBar) }
  }, [state.bars, state.loopRange])

  useEffect(() => {
    if (!state.playing) return
    let frame; let last
    const tick = (time) => {
      if (last == null) last = time
      let next = positionRef.current + ((time - last) / 1000) * UNITS_PER_SECOND; last = time
      if (state.loopEnabled && loopBounds) {
        if (next < loopBounds.start || next >= loopBounds.end) next = loopBounds.start
      } else if (next >= totalUnits(state.bars)) { next = totalUnits(state.bars); dispatch({ type: 'setPlaying', value: false }) }
      positionRef.current = next; dispatch({ type: 'setPosition', value: next })
      if (next < totalUnits(state.bars) || (state.loopEnabled && loopBounds)) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state.playing, state.loopEnabled, loopBounds, state.bars])

  useEffect(() => { document.documentElement.classList.toggle('reduced-motion', state.reducedMotion); return () => document.documentElement.classList.remove('reduced-motion') }, [state.reducedMotion])
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && state.modal) { dispatch({ type: 'setModal', open: false }); return }
      if (state.modal || event.target.matches('input, textarea, select, button, a, [contenteditable]')) return
      if (event.key === ' ') { event.preventDefault(); dispatch({ type: 'togglePlayback' }) }
      if (event.key === '[') dispatch({ type: 'moveBar', delta: -1 })
      if (event.key === ']') dispatch({ type: 'moveBar', delta: 1 })
      if (event.key === 'ArrowLeft') { event.preventDefault(); cycleVariant(-1) }
      if (event.key === 'ArrowRight') { event.preventDefault(); cycleVariant(1) }
    }
    document.addEventListener('keydown', onKeyDown); return () => document.removeEventListener('keydown', onKeyDown)
  }, [cycleVariant, state.modal])

  return <><a className="skip-link" href="#workspace-main">Перейти к рабочей области</a>{variant === 'A' && <VariantA state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}{variant === 'B' && <VariantB state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}{variant === 'C' && <VariantC state={state} dispatch={dispatch} bar={selectedBar} event={selectedEvent} />}<PrototypeSwitcher variant={variant} cycle={cycleVariant} />{state.modal && <Shortcuts onClose={() => dispatch({ type: 'setModal', open: false })} />}</>
}
