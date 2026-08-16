import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, AudioLines, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleX, Clock3, FolderOpen, Gauge, GripVertical, Keyboard, ListMusic, LoaderCircle, LocateFixed,
  Music2, Pause, PencilLine, Play, Plus, Repeat2, RotateCcw, Save, SkipBack, SkipForward, Timer,
  Trash2, Waves, X,
} from 'lucide-react'

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

const LYRIC_LINES = [
  [
    { id: 'l1-1', text: 'Я', start: 18, end: 20 }, { id: 'l1-2', text: 'хотел', start: 20, end: 23 },
    { id: 'l1-3', text: 'бы', start: 23, end: 25 }, { id: 'l1-4', text: 'остаться', start: 25, end: 28 },
    { id: 'l1-5', text: 'с', start: 28, end: 29 }, { id: 'l1-6', text: 'тобой,', start: 29, end: 32 },
  ],
  [
    { id: 'l2-1', text: 'этот', start: 32, end: 35 }, { id: 'l2-2', text: 'ритм', start: 35, end: 38 },
    { id: 'l2-3', text: 'ведёт', start: 38, end: 41 }, { id: 'l2-4', text: 'нас', start: 41, end: 43 },
    { id: 'l2-5', text: 'дальше.', start: 43, end: 48 },
  ],
  [
    { id: 'l3-1', text: 'Город', start: 48, end: 51 }, { id: 'l3-2', text: 'тихо', start: 51, end: 54 },
    { id: 'l3-3', text: 'светится', start: 54, end: 58 }, { id: 'l3-4', text: 'в', start: 58, end: 59 },
    { id: 'l3-5', text: 'окне,', start: 59, end: 64 },
  ],
  [
    { id: 'l4-1', text: 'и', start: 64, end: 66 }, { id: 'l4-2', text: 'новая', start: 66, end: 70 },
    { id: 'l4-3', text: 'песня', start: 70, end: 74 }, { id: 'l4-4', text: 'начинается', start: 74, end: 80 },
    { id: 'l4-5', text: 'сейчас.', start: 80, end: 84 },
  ],
]
const LYRIC_WORDS = LYRIC_LINES.flat()

const STATES = [
  { label: 'Готово', title: 'Проект готов', detail: '3 правки', tone: 'good', icon: CheckCircle2 },
  { label: 'Анализ', title: 'Анализируем гармонию', detail: 'Этап 3 из 5', tone: 'busy', icon: LoaderCircle },
  { label: 'Проверить', title: 'Низкая уверенность', detail: 'Такты 2 и 5', tone: 'warn', icon: AlertTriangle },
  { label: 'Ошибка', title: 'Ревизия не создана', detail: 'Исходные данные сохранены', tone: 'danger', icon: CircleX },
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
          return { ...bar, events: [...bar.events, action.event] }
        }),
      }
    case 'reorderEvent':
      return {
        ...state,
        activeBarId: action.barId,
        activeEventId: action.eventId,
        dirtyBarIds: markDirty(state, action.barId),
        bars: state.bars.map((bar) => {
          if (bar.id !== action.barId) return bar
          const fromIndex = bar.events.findIndex((item) => item.id === action.eventId)
          const toIndex = Math.max(0, Math.min(bar.events.length - 1, action.toIndex))
          if (fromIndex < 0 || fromIndex === toIndex) return bar
          const events = [...bar.events]
          const [moved] = events.splice(fromIndex, 1)
          events.splice(toIndex, 0, moved)
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
function chordLabelsForLyricLines(bars, lines) {
  const labels = Array(lines.flat().length).fill('')
  const chordEvents = timedChordEvents(bars)
  let lineOffset = 0
  lines.forEach((line) => {
    chordEvents.forEach((event) => {
      const wordIndex = line.findIndex((word) => event.start < word.end && event.end > word.start)
      if (wordIndex >= 0 && !labels[lineOffset + wordIndex]) labels[lineOffset + wordIndex] = event.chord
    })
    lineOffset += line.length
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
  const StatusIcon = STATES[state.statusIndex].icon
  return <header className="app-header">
    <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><AudioLines size={15} strokeWidth={1.8} /></span><strong>Open Chords</strong></div>
    <div className="project-title"><strong>Плачь и танцуй</strong><span>Диапазон 0:00–0:48</span></div>
    <div className="header-actions">
      <button className="icon-action" aria-label={`Сменить демонстрационное состояние. Сейчас: ${STATES[state.statusIndex].label}`} title={`Состояние: ${STATES[state.statusIndex].label}`} onClick={() => dispatch({ type: 'cycleStatus' })}><StatusIcon size={15} aria-hidden="true" /></button>
      <button className="icon-action" aria-label={state.reducedMotion ? 'Включить обычное движение' : 'Уменьшить движение'} title={state.reducedMotion ? 'Обычное движение' : 'Меньше движения'} aria-pressed={state.reducedMotion} onClick={() => dispatch({ type: 'toggleMotion' })}><Waves size={15} aria-hidden="true" /></button>
      <button className="icon-action" aria-label="Показать клавиатурные сокращения" title="Клавиши" onClick={() => dispatch({ type: 'setModal', open: true })}><Keyboard size={15} aria-hidden="true" /></button>
      <button className="icon-action" aria-label="Открыть все проекты" title="Все проекты"><FolderOpen size={15} aria-hidden="true" /></button>
    </div>
  </header>
}

function StatusBanner({ state }) {
  const status = STATES[state.statusIndex]
  const StatusIcon = status.icon
  return <section className={`status-line ${status.tone}`} aria-label="Состояние проекта" aria-busy={status.tone === 'busy'}>
    <StatusIcon className="status-line-icon" size={14} aria-hidden="true" /><strong>{status.title}</strong><span>{status.detail}</span>
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
    <div><strong>{count === 1 ? `Такт ${first}` : `Такты ${first}–${last}`}</strong><span>{count} выбрано</span></div>
    <button className="toolbar-action" aria-label={loopActionLabel} title={loopActionLabel} aria-pressed={selectionIsLoop} onClick={() => dispatch({ type: selectionIsLoop ? 'disableLoop' : 'setLoopFromSelection' })}><Repeat2 size={15} aria-hidden="true" /></button>
    <button className="toolbar-action danger" aria-label="Удалить выбранные такты" title="Удалить такты" disabled={count === state.bars.length} onClick={() => dispatch({ type: 'deleteRange' })}><Trash2 size={15} aria-hidden="true" /></button>
    <button className="toolbar-action" aria-label="Снять выделение" title="Снять выделение" onClick={() => dispatch({ type: 'clearRange' })}><X size={15} aria-hidden="true" /></button>
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
    <div className="timeline-heading"><h2><AudioLines size={15} aria-hidden="true" />Таймлайн</h2><div className="legend"><span className="legend-low"><AlertTriangle size={12} aria-hidden="true" />Проверить</span><span><Clock3 size={12} aria-hidden="true" />{formatTime(state.positionUnits)}</span></div></div>
    <SelectionToolbar state={state} dispatch={dispatch} />
    <div className="timeline-viewport">
      <div className="center-line"><button className="playhead-handle" aria-label="Перемотка за playhead" title="Перемотка" onPointerDown={startScrub} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); dispatch({ type: 'setPosition', value: state.positionUnits + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 4 : 1) }) } }}><GripVertical size={13} aria-hidden="true" /></button></div>
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
            {bar.confidence === 'low' && <span className="confidence-label"><AlertTriangle size={10} aria-hidden="true" />Проверить</span>}
            {bar.confidence === 'reviewed' && <span className="confidence-label reviewed"><Check size={10} aria-hidden="true" />Проверено</span>}
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
  const [draggedEventId, setDraggedEventId] = useState(null)
  const [dropIndicator, setDropIndicator] = useState(null)
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  const chordPickerRef = useRef(null)
  const eventDragRef = useRef(null)
  const suppressEventClickRef = useRef(false)
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
  const reorderEvent = (eventId, toIndex) => {
    const fromIndex = bar.events.findIndex((item) => item.id === eventId)
    if (fromIndex < 0 || fromIndex === toIndex) return
    const moved = bar.events[fromIndex]
    dispatch({ type: 'reorderEvent', barId: bar.id, eventId, toIndex })
    setReorderAnnouncement(`${moved.chord}: позиция ${toIndex + 1} из ${bar.events.length}`)
  }
  const clearDragState = () => { setDraggedEventId(null); setDropIndicator(null) }
  const startEventDrag = (pointerEvent, eventId) => {
    if (pointerEvent.button !== 0) return
    try { pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId) } catch { /* synthetic pointers may not own capture */ }
    const sourceIndex = bar.events.findIndex((item) => item.id === eventId)
    eventDragRef.current = { eventId, sourceIndex, toIndex: sourceIndex, pointerId: pointerEvent.pointerId, startX: pointerEvent.clientX, startY: pointerEvent.clientY, dragging: false }
  }
  const moveEventDrag = (pointerEvent) => {
    const drag = eventDragRef.current
    if (!drag || (drag.pointerId != null && pointerEvent.pointerId !== drag.pointerId)) return
    if (!drag.dragging && Math.hypot(pointerEvent.clientX - drag.startX, pointerEvent.clientY - drag.startY) < 5) return
    pointerEvent.preventDefault()
    drag.dragging = true
    suppressEventClickRef.current = true
    setDraggedEventId(drag.eventId)
    const picker = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.event-picker')
    if (!picker) { drag.toIndex = drag.sourceIndex; setDropIndicator(null); return }
    const options = [...picker.querySelectorAll('[data-event-option-id]')]
    let slotIndex = options.findIndex((option) => { const rect = option.getBoundingClientRect(); return pointerEvent.clientX < rect.left + rect.width / 2 })
    if (slotIndex < 0) slotIndex = options.length
    drag.toIndex = slotIndex > drag.sourceIndex ? slotIndex - 1 : slotIndex
    const indicatorOption = slotIndex === options.length ? options.at(-1) : options[slotIndex]
    setDropIndicator(indicatorOption ? { eventId: indicatorOption.dataset.eventOptionId, edge: slotIndex === options.length ? 'after' : 'before' } : null)
  }
  const endEventDrag = (pointerEvent) => {
    const drag = eventDragRef.current
    if (!drag || (drag.pointerId != null && pointerEvent.pointerId !== drag.pointerId)) return
    try { pointerEvent.currentTarget.releasePointerCapture(pointerEvent.pointerId) } catch { /* pointer may finish outside its source */ }
    if (drag.dragging) {
      reorderEvent(drag.eventId, drag.toIndex)
      setTimeout(() => { suppressEventClickRef.current = false }, 0)
    }
    eventDragRef.current = null
    clearDragState()
  }
  return <aside className="inspector panel" aria-label="Редактор выбранного события аккорда">
    <div className="panel-heading"><div className="inspector-current"><span><PencilLine size={16} aria-hidden="true" />Выбранный аккорд · такт {bar.number}</span><strong data-selected-chord-label>{event.chord}</strong></div><span className="event-counter">{activeIndex + 1} из {bar.events.length}</span></div>
    <div className="event-picker-shell"><span className="event-picker-label">Аккорды в этом такте</span><span className="sr-only" aria-live="polite">{reorderAnnouncement}</span><div className="event-picker" role="group" aria-label={`Аккорды в такте ${bar.number}`}>{bar.events.map((item, itemIndex) => { const isSelected = item.id === event.id; const indicatorClass = dropIndicator?.eventId === item.id ? `drop-${dropIndicator.edge}` : ''; return <button key={item.id} data-event-option-id={item.id} className={`event-option ${isSelected ? 'selected' : ''} ${draggedEventId === item.id ? 'dragging' : ''} ${indicatorClass}`} aria-pressed={isSelected} aria-label={`${item.chord}, ${durationLabel(item.duration, bar)}, позиция ${itemIndex + 1} из ${bar.events.length}. Перетащи для перестановки`} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title="Перетащи для перестановки · Alt + ←/→" onClick={() => { if (suppressEventClickRef.current) { suppressEventClickRef.current = false; return } dispatch({ type: 'selectEvent', barId: bar.id, eventId: item.id }) }} onPointerDown={(pointerEvent) => startEventDrag(pointerEvent, item.id)} onPointerMove={moveEventDrag} onPointerUp={endEventDrag} onPointerCancel={endEventDrag} onKeyDown={(keyEvent) => { if (!keyEvent.altKey || !['ArrowLeft', 'ArrowRight'].includes(keyEvent.key)) return; keyEvent.preventDefault(); const toIndex = itemIndex + (keyEvent.key === 'ArrowLeft' ? -1 : 1); if (toIndex >= 0 && toIndex < bar.events.length) reorderEvent(item.id, toIndex) }}><GripVertical className="event-drag-handle" size={16} aria-hidden="true" /><strong>{item.chord}</strong><span>{durationLabel(item.duration, bar)}</span>{isSelected && <Check className="event-selected-check" size={15} aria-hidden="true" />}</button> })}<button className="event-add-option" type="button" aria-label="Добавить аккорд в конец такта" onClick={() => dispatch({ type: 'addEvent', event: { id: crypto.randomUUID(), chord: 'N', duration: 4 } })}><Plus size={18} aria-hidden="true" /><span>Добавить аккорд</span></button></div></div>
    {bar.confidence === 'low' && <section className="review-status warn" aria-label="Такт требует проверки"><AlertTriangle size={14} aria-hidden="true" /><span>Автоанализ не уверен</span><button className="inline-icon-action" type="button" aria-label="Подтвердить такт" title="Подтвердить" onClick={() => dispatch({ type: 'confirmBar', barId: bar.id })}><Check size={14} aria-hidden="true" /></button></section>}
    {bar.confidence === 'reviewed' && <section className="review-status good" aria-label="Такт проверен вручную"><CheckCircle2 size={14} aria-hidden="true" /><span>Проверено вручную</span><button className="inline-icon-action" type="button" aria-label="Вернуть такт на проверку" title="Вернуть на проверку" onClick={() => dispatch({ type: 'flagBarForReview', barId: bar.id })}><RotateCcw size={14} aria-hidden="true" /></button></section>}
    <form onSubmit={save}>
      <div className="field-group"><details ref={chordPickerRef} className="chord-picker-dropdown" onToggle={(toggleEvent) => { if (toggleEvent.currentTarget.open) setChordPickerStep('root') }}>
        <summary><Music2 size={14} aria-hidden="true" /><strong aria-live="polite">{name}</strong><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="chord-picker-menu">
          {chordPickerStep === 'root' && <section className="chord-step" aria-label="Выбор корня аккорда"><div className="chord-step-heading"><span>Шаг 1</span><strong>Выбери корень</strong></div><div className="root-button-grid">{CHORD_ROOTS.map((root) => <button key={root} type="button" className={!chordDraft.noChord && chordDraft.root === root ? 'selected' : ''} aria-pressed={!chordDraft.noChord && chordDraft.root === root} onClick={() => chooseRoot(root)}>{root}</button>)}<button className={`no-chord-root ${chordDraft.noChord ? 'selected' : ''}`} type="button" aria-pressed={chordDraft.noChord} onClick={() => { setChordDraft((current) => ({ ...current, noChord: true, bass: '' })); closeChordPicker() }}><strong>N</strong><span>нет аккорда</span></button></div></section>}
          {chordPickerStep === 'quality' && <section className="chord-step" aria-label={`Выбор варианта аккорда ${chordDraft.root}`}><div className="chord-step-nav"><button type="button" onClick={() => setChordPickerStep('root')}><ArrowLeft size={13} aria-hidden="true" />Корень</button></div><div className="chord-step-heading"><span>Шаг 2 · корень {chordDraft.root}</span><strong>Какой это аккорд?</strong></div><div className="primary-quality-grid">{CHORD_TYPES.slice(0, 2).map((type) => <button key={type.id} type="button" className={chordDraft.type === type.id ? 'selected' : ''} onClick={() => chooseQuality(type.id)}><strong>{chordDraft.root}{type.suffix}</strong><span>{type.label}</span></button>)}</div><span className="other-quality-label">Другие варианты</span><div className="other-quality-grid">{CHORD_TYPES.slice(2).map((type) => <button key={type.id} type="button" className={chordDraft.type === type.id ? 'selected' : ''} onClick={() => chooseQuality(type.id)}>{chordDraft.root}{type.suffix}</button>)}</div></section>}
          {chordPickerStep === 'bass' && <section className="chord-step" aria-label="Выбор баса для slash-аккорда"><div className="chord-step-nav"><button type="button" onClick={() => setChordPickerStep('quality')}><ArrowLeft size={13} aria-hidden="true" />Вариант</button></div><div className="chord-step-heading"><span>Шаг 3 · {chordSymbol({ ...chordDraft, bass: '' })}</span><strong>Добавить отдельный бас?</strong></div><button type="button" className="finish-without-bass" onClick={() => { setChordDraft((current) => ({ ...current, bass: '' })); closeChordPicker() }}><Check size={15} aria-hidden="true" /><strong>Без баса</strong><span>{chordSymbol({ ...chordDraft, bass: '' })}</span></button><span className="other-quality-label">Или выбери бас для slash-аккорда</span><div className="bass-button-grid">{CHORD_ROOTS.map((root) => <button key={root} type="button" className={chordDraft.bass === root ? 'selected' : ''} onClick={() => { setChordDraft((current) => ({ ...current, bass: root })); closeChordPicker() }}>{root}</button>)}</div></section>}
        </div>
      </details>
        <fieldset className="duration-control"><legend><Clock3 size={12} aria-hidden="true" />Длительность</legend><div>{durationOptionsForBar(bar).map((option) => <button key={option.units} type="button" className={event.duration === option.units ? 'selected' : ''} aria-pressed={event.duration === option.units} onClick={() => dispatch({ type: 'updateEvent', patch: { duration: option.units } })}>{option.label}</button>)}</div></fieldset>
        <div className="editor-meta" role="status"><span><LocateFixed size={12} aria-hidden="true" />{start + 1}/16</span><span className={valid ? 'valid' : 'invalid'}>{valid ? <><CheckCircle2 size={12} aria-hidden="true" />{used}/{capacity}</> : delta > 0 ? <><AlertTriangle size={12} aria-hidden="true" />−{delta}/16</> : <><AlertTriangle size={12} aria-hidden="true" />+{-delta}/16</>}</span></div>
      </div>
      <div className="button-pair"><button className="primary-button" type="submit" disabled={!valid}><Save size={14} aria-hidden="true" />Сохранить</button><button className="icon-action danger" type="button" aria-label="Удалить выбранный аккорд" title="Удалить аккорд" disabled={bar.events.length === 1} onClick={() => dispatch({ type: 'deleteEvent' })}><Trash2 size={15} aria-hidden="true" /></button></div>
    </form>
    <p className="original-note">{state.dirtyBarIds.includes(bar.id) ? 'Есть несохранённые изменения.' : 'Раскладка сохранена. Original остаётся отдельно.'}</p>
  </aside>
}

function Transport({ state, dispatch }) {
  const selected = state.selectedRange
  const loop = state.loopRange
  const loopLabel = state.loopEnabled && loop ? `Луп: ${state.bars[loop.start].number}${loop.start === loop.end ? '' : `–${state.bars[loop.end].number}`}` : !selected ? 'Луп: выбери такты' : `Зациклить: ${state.bars[selected.start].number}${selected.start === selected.end ? '' : `–${state.bars[selected.end].number}`}`
  return <section className="transport" aria-label="Проигрывание">
    <button className="transport-key" aria-label="Предыдущий такт" title="Предыдущий такт" onClick={() => dispatch({ type: 'moveBar', delta: -1 })}><SkipBack size={16} aria-hidden="true" /></button>
    <button className="play-button" aria-label={state.playing ? 'Пауза' : 'Воспроизвести'} title={state.playing ? 'Пауза' : 'Воспроизвести'} aria-pressed={state.playing} onClick={() => dispatch({ type: 'togglePlayback' })}>{state.playing ? <Pause size={17} fill="currentColor" aria-hidden="true" /> : <Play size={17} fill="currentColor" aria-hidden="true" />}</button>
    <button className="transport-key" aria-label="Следующий такт" title="Следующий такт" onClick={() => dispatch({ type: 'moveBar', delta: 1 })}><SkipForward size={16} aria-hidden="true" /></button>
    <div className="time-readout"><strong>{formatTime(state.positionUnits)}</strong><span>/ {formatTime(totalUnits(state.bars))}</span></div>
    <button className="transport-option" disabled={!state.loopEnabled && !selected} aria-label={loopLabel} title={loopLabel} aria-pressed={state.loopEnabled} onClick={() => dispatch({ type: state.loopEnabled ? 'disableLoop' : 'setLoopFromSelection' })}><Repeat2 size={14} aria-hidden="true" />{state.loopEnabled && loop ? `${state.bars[loop.start].number}${loop.start === loop.end ? '' : `–${state.bars[loop.end].number}`}` : ''}</button>
    <button className="transport-option" aria-label="Скорость воспроизведения 1×" title="Скорость 1×"><Gauge size={14} aria-hidden="true" /><span>1×</span></button><button className="transport-option icon-only" aria-label="Метроном" title="Метроном"><Timer size={14} aria-hidden="true" /></button>
  </section>
}

function VariantA({ state, dispatch, bar, event }) {
  const currentLyricIndex = LYRIC_WORDS.findIndex((word) => state.positionUnits >= word.start && state.positionUnits < word.end)
  const lyricChordLabels = useMemo(() => chordLabelsForLyricLines(state.bars, LYRIC_LINES), [state.bars])
  return <div className="shell variant-a"><Header state={state} dispatch={dispatch} /><div className="studio-grid">
    <main id="workspace-main" className="studio-main" tabIndex="-1"><div className="editor-intro"><div><h1>Плачь и танцуй</h1><div className="track-facts"><span><Gauge size={12} aria-hidden="true" />88 BPM</span><span><Music2 size={12} aria-hidden="true" />C major</span><span><AudioLines size={12} aria-hidden="true" />4/4</span></div></div><StatusBanner state={state} /></div><Timeline state={state} dispatch={dispatch} /><section className="lyrics-strip" aria-label="Многострочный текст песни с аккордами и таймингом"><div className="lyrics-heading"><h2><ListMusic size={15} aria-hidden="true" />Текст</h2><span className="lyrics-key"><span title="Аккорд по таймингу"><Music2 size={12} aria-hidden="true" /></span><span title="Текущее слово"><LocateFixed size={12} aria-hidden="true" /></span></span></div><div className="lyrics-lines">{LYRIC_LINES.map((line, lineIndex) => { const lineOffset = LYRIC_LINES.slice(0, lineIndex).reduce((sum, item) => sum + item.length, 0); return <p className="lyric-line" key={`line-${lineIndex}`}>{line.map((word, wordIndex) => { const index = lineOffset + wordIndex; return <span className="lyric-token" key={word.id}><strong className="lyric-chord" aria-hidden={lyricChordLabels[index] ? undefined : true}>{lyricChordLabels[index] || '\u00a0'}</strong><span>{index === currentLyricIndex ? <mark title="Сейчас звучит это слово">{word.text}</mark> : word.text}</span></span> })}</p> })}</div></section></main>
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

function PrototypeSwitcher({ variant, cycle }) { if (!import.meta.env.DEV) return null; return <nav className="prototype-switcher"><button onClick={() => cycle(-1)} aria-label="Предыдущий вариант"><ChevronLeft size={18} aria-hidden="true" /></button><strong>{VARIANTS[variant]}</strong><button onClick={() => cycle(1)} aria-label="Следующий вариант"><ChevronRight size={18} aria-hidden="true" /></button></nav> }
function Shortcuts({ onClose }) { const closeRef = useRef(null); useEffect(() => closeRef.current?.focus(), []); return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="panel-heading"><h2 id="shortcut-title">Клавиши</h2><button ref={closeRef} className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={16} aria-hidden="true" /></button></div><dl className="shortcut-list"><div><dt>Space</dt><dd>Play / pause</dd></div><div><dt>[ / ]</dt><dd>Предыдущий / следующий такт</dd></div><div><dt>Drag тактов</dt><dd>Выбрать диапазон; у края включается автоскролл</dd></div><div><dt>Drag playhead</dt><dd>Перемотка при неподвижной центральной линии</dd></div><div><dt>Esc</dt><dd>Закрыть окно</dd></div></dl></section></div> }

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
