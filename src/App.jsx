import { useEffect, useRef, useState, useCallback } from 'react'

const EPUB_URL = '/book.epub'
const MANIFEST_URL = '/chapters.json'
const AUDIO_BASE = '/audio'
const PROGRESS_KEY = 'woodsman-progress-v1'
const SAVE_INTERVAL_MS = 3000 // throttle audio-position saves

function fmt(sec) {
  if (!sec || !isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// normalize a word for fuzzy matching across EPUB text ↔ stable-ts output
function normWord(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9']/g, '')
}

function isWordChar(c) {
  // a-z, A-Z, 0-9, apostrophe
  return (c >= 97 && c <= 122) ||
         (c >= 65 && c <= 90) ||
         (c >= 48 && c <= 57) ||
         c === 39
}

function findWordInText(haystack, needle, fromIdx) {
  // Linear scan forward from fromIdx for the next word token that normalizes equal to needle.
  // Returns the char index of the start of that token, or -1.
  const n = normWord(needle)
  if (!n) return -1
  let i = fromIdx
  while (i < haystack.length) {
    while (i < haystack.length && !isWordChar(haystack.charCodeAt(i))) i++
    if (i >= haystack.length) return -1
    const start = i
    while (i < haystack.length && isWordChar(haystack.charCodeAt(i))) i++
    if (normWord(haystack.slice(start, i)) === n) return start
    if (start - fromIdx > 5000) return -1 // bail if we've scanned too far
  }
  return -1
}

function buildTextMap(doc) {
  // Walk every text node in the section body, concatenating into one string while
  // preserving word boundaries (a space is injected between two text nodes whose
  // junction would otherwise merge two words, e.g. "Door"+"The" → "DoorThe").
  // posMap[i] points to the {node, offset} that fullText[i] came from.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false)
  const segments = []
  let n
  while ((n = walker.nextNode())) {
    const t = n.textContent
    if (t && t.trim()) segments.push({ node: n, text: t })
  }
  const posMap = []
  let full = ''
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si]
    if (si > 0) {
      const prev = segments[si - 1]
      const needSpace = !/\s$/.test(prev.text) && !/^\s/.test(s.text)
      if (needSpace) {
        posMap.push({ node: prev.node, offset: prev.text.length })
        full += ' '
      }
    }
    for (let i = 0; i < s.text.length; i++) {
      posMap.push({ node: s.node, offset: i })
    }
    full += s.text
  }
  return { fullText: full, posMap }
}

export default function App() {
  const [manifest, setManifest] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [syncAvailable, setSyncAvailable] = useState(false)
  const [timings, setTimings] = useState(null)

  const viewRef = useRef(null)
  const audioRef = useRef(null)
  const foliateReady = useRef(false)
  const pendingNav = useRef(null)
  const timingsCache = useRef({})
  const timingsRef = useRef(null)         // mirror of timings state for event handlers
  const cfiMapRef = useRef({})            // chapter id -> CFI for goTo
  const textMapRef = useRef(null)         // { fullText, posMap } for current section
  const wordSpansRef = useRef([])         // [{node, offset, length}] per timing word
  const currentMarkRef = useRef(null)     // currently inserted <mark>
  const lastWordIdxRef = useRef(-1)
  const pendingSeekRef = useRef(0)         // audio seek target to restore on chapter load
  const lastSaveRef = useRef(0)            // throttle timestamp for progress saves

  useEffect(() => { timingsRef.current = timings }, [timings])

  // ---- reading-progress persistence ----
  function saveProgress(idx, time) {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({
        currentIndex: idx,
        currentTime: Math.max(0, time || 0),
        updatedAt: Date.now(),
      }))
    } catch {}
  }
  // persist the active chapter whenever it changes (fresh start; accurate
  // position is persisted by the throttled save in onTimeUpdate)
  useEffect(() => {
    if (manifest && chapter) saveProgress(currentIndex, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex])

  // persist on hide/unload so the last few seconds aren't lost
  useEffect(() => {
    const flush = () => {
      const a = audioRef.current
      saveProgress(currentIndex, a?.currentTime || 0)
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
    return () => {
      window.removeEventListener('pagehide', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex])

  // ---- load manifest ----
  useEffect(() => {
    fetch(MANIFEST_URL).then(r => r.json()).then(m => {
      setManifest(m)
      setLoading(false)
      // restore last position
      try {
        const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null')
        if (saved && typeof saved.currentIndex === 'number' && saved.currentIndex < m.chapters.length) {
          setCurrentIndex(saved.currentIndex)
          pendingSeekRef.current = saved.currentTime || 0
        }
      } catch {}
    })
  }, [])

  const chapter = manifest?.chapters[currentIndex]

  // ---- load timings for current chapter ----
  useEffect(() => {
    setTimings(null)
    setSyncAvailable(false)
    wordSpansRef.current = []
    lastWordIdxRef.current = -1
    if (!manifest) return
    const ch = manifest.chapters[currentIndex]
    if (!ch || ch.type === 'front-matter') return
    if (timingsCache.current[ch.id]) {
      setTimings(timingsCache.current[ch.id])
      return
    }
    fetch(`/timings/${ch.id}.json`).then(r => {
      if (!r.ok) throw new Error(`no timings for ${ch.id}`)
      return r.json()
    }).then(d => {
      timingsCache.current[ch.id] = d
      setTimings(d)
    }).catch(() => { /* no timings = chapter-sync only */ })
  }, [manifest, currentIndex])

  // re-map words to DOM whenever timings arrive
  useEffect(() => {
    if (timings && textMapRef.current) mapWordsToDOM()
  }, [timings])

  // ---- map timings.words -> DOM positions ----
  function mapWordsToDOM() {
    const tm = textMapRef.current
    const t = timingsRef.current || timings
    if (!tm || !t || !t.words || !t.words.length) {
      wordSpansRef.current = []
      return
    }
    const fullText = tm.fullText
    const spans = []
    let scanFrom = 0
    for (let i = 0; i < t.words.length; i++) {
      const w = t.words[i].word
      const idx = findWordInText(fullText, w, scanFrom)
      if (idx === -1) {
        spans.push(null)
        continue
      }
      const m = fullText.substr(idx).match(/^[a-zA-Z0-9']+/)
      const len = m ? m[0].length : w.length
      spans.push({
        node: tm.posMap[idx].node,
        offset: tm.posMap[idx].offset,
        length: len,
      })
      scanFrom = idx + len
    }
    wordSpansRef.current = spans
    setSyncAvailable(spans.some(s => s !== null))
  }

  // ---- build a flat text map for the current foliate-view section ----
  function buildSectionTextMap() {
    const view = viewRef.current
    if (!view || !view.renderer) return
    let docs
    try { docs = view.renderer.getContents() } catch { return }
    if (!docs || !docs.length) return
    // sum text across all content docs (paginator may split a section into pages)
    let combined = ''
    let combinedMap = []
    for (const d of docs) {
      const doc = d.doc
      if (!doc || !doc.body) continue
      const tm = buildTextMap(doc)
      combined += tm.fullText + '\n'
      combinedMap.push(...tm.posMap)
    }
    // foliate may fire 'relocate' before the section's body is fully populated;
    // if the captured text is too short, retry shortly.
    if (combined.length < 200) {
      setTimeout(buildSectionTextMap, 200)
      return
    }
    textMapRef.current = { fullText: combined, posMap: combinedMap }
    mapWordsToDOM()
  }

  // ---- open foliate-view (callback ref so it runs after the element is attached) ----
  async function openFoliateView(view) {
    try {
      const res = await fetch(EPUB_URL)
      const blob = await res.blob()
      const file = new File([blob], 'book.epub', { type: blob.type || 'application/epub+zip' })
      await view.open(file)
      // foliate renders nothing until you navigate — trigger the first section
      await view.renderer.firstSection().catch(() => {})
      // build cfi -> chapter id map. EPUB section hrefs are null here, so map by index:
      // 0=titlepage, 1=nav, 2=ch001 (empty placeholder), 3=ch002 (The Door)...
      if (view.book?.sections) {
        const sections = view.book.sections
        for (let i = 3; i < sections.length; i++) {
          const chNum = i - 1
          const cfi = sections[i]?.cfi
          if (cfi) cfiMapRef.current[`ch${String(chNum).padStart(3, '0')}`] = cfi
        }
      }
      foliateReady.current = true
      view.addEventListener('relocate', () => buildSectionTextMap())
      view.addEventListener('create-overlayer', () => buildSectionTextMap())
      view.addEventListener('load', () => buildSectionTextMap())
      buildSectionTextMap()
      if (pendingNav.current) {
        const cfi = cfiMapRef.current[pendingNav.current]
        if (cfi) view.goTo(cfi).catch(() => {})
        pendingNav.current = null
      }
    } catch (e) {
      console.error('foliate open failed', e)
    }
  }

  const viewCallbackRef = useCallback((el) => {
    viewRef.current = el
    if (el && !el.__openStarted) {
      el.__openStarted = true
      openFoliateView(el)
    }
  }, [])

  // ---- navigate reader when chapter changes ----
  useEffect(() => {
    const view = viewRef.current
    if (!chapter || !view) return
    if (chapter.type === 'front-matter') return
    if (!foliateReady.current) {
      pendingNav.current = chapter.id
      return
    }
    const cfi = cfiMapRef.current[chapter.id]
    if (cfi) view.goTo(cfi).catch(() => {})
  }, [chapter])

  // ---- load audio when chapter changes ----
  useEffect(() => {
    const audio = audioRef.current
    if (!chapter || !audio) return
    audio.src = `${AUDIO_BASE}/${chapter.audio}`
    audio.load()
    setCurrentTime(0)
    setDuration(chapter.duration || 0)
    // restore saved position for this chapter (set by mount restore or a manual resume)
    const seekTarget = pendingSeekRef.current
    pendingSeekRef.current = 0
    if (seekTarget > 0 && isFinite(seekTarget)) {
      const applySeek = () => {
        audio.currentTime = seekTarget
        setCurrentTime(seekTarget)
        saveProgress(currentIndex, seekTarget) // re-persist the restored position
        audio.removeEventListener('loadedmetadata', applySeek)
      }
      audio.addEventListener('loadedmetadata', applySeek)
    }
    if (isPlaying) audio.play().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter])

  // ---- audio event handlers ----
  const onTimeUpdate = () => {
    const a = audioRef.current
    if (!a) return
    setCurrentTime(a.currentTime)
    // throttled progress persistence
    const tNow = Date.now()
    if (tNow - lastSaveRef.current > SAVE_INTERVAL_MS) {
      lastSaveRef.current = tNow
      saveProgress(currentIndex, a.currentTime)
    }
    const t = timingsRef.current
    if (!t || !t.words || !t.words.length) return
    const ws = wordSpansRef.current
    if (!ws.length) return
    const now = a.currentTime
    // binary search for the last word with start <= now
    let lo = 0, hi = t.words.length - 1, idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (t.words[mid].start <= now) { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    if (idx === lastWordIdxRef.current) return
    lastWordIdxRef.current = idx
    highlightWord(idx)
  }
  const onLoadedMeta = () => setDuration(audioRef.current?.duration || 0)
  const onEnded = () => {
    if (manifest && currentIndex < manifest.chapters.length - 1) {
      setCurrentIndex(i => i + 1)
    } else {
      setIsPlaying(false)
    }
  }

  function highlightWord(idx) {
    // remove previous mark
    if (currentMarkRef.current) {
      try {
        const m = currentMarkRef.current
        const parent = m.parentNode
        while (m.firstChild) parent.insertBefore(m.firstChild, m)
        parent.removeChild(m)
        parent.normalize()
      } catch {}
      currentMarkRef.current = null
    }
    const ws = wordSpansRef.current
    if (idx < 0 || idx >= ws.length) return
    const span = ws[idx]
    if (!span) return
    try {
      const textNode = span.node
      if (!textNode || !textNode.parentNode) return
      const range = document.createRange()
      range.setStart(textNode, span.offset)
      range.setEnd(textNode, Math.min(span.offset + span.length, textNode.textContent.length))
      const mark = document.createElement('mark')
      mark.className = 'word-hl'
      range.surroundContents(mark)
      currentMarkRef.current = mark
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {}
  }

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) { audio.play(); setIsPlaying(true) }
    else { audio.pause(); setIsPlaying(false) }
  }
  const selectChapter = useCallback((idx) => setCurrentIndex(idx), [])
  const next = () => setCurrentIndex(i => Math.min(i + 1, (manifest?.chapters.length || 1) - 1))
  const prev = () => setCurrentIndex(i => Math.max(i - 1, 0))

  // ---- Media Session API (lock screen metadata + controls) ----
  useEffect(() => {
    if (!chapter || !('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: manifest?.title || 'Audiobook',
      album: 'Woodsman: Track Seven',
    })
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', prev)
    navigator.mediaSession.setActionHandler('nexttrack', next)
  }, [chapter])

  if (loading) return <div className="loading">Loading…</div>

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle chapters">☰</button>
        <h1 className="book-title">{manifest.title}</h1>
        {syncAvailable && <span className="sync-badge" title="Word-level sync enabled">sync</span>}
        <span className="spacer" />
      </header>

      <div className="main">
        <aside className={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
          <div className="sidebar-header">Chapters</div>
          <ol className="chapter-list">
            {manifest.chapters.map((c, i) => (
              <li key={c.id}>
                <button className={`chapter-item ${i === currentIndex ? 'active' : ''}`} onClick={() => selectChapter(i)}>
                  <span className="chapter-title">{c.title}</span>
                  <span className="chapter-meta">
                    {c.type === 'title-only' && <span className="badge">title</span>}
                    {c.type === 'front-matter' && <span className="badge alt">intro</span>}
                    {fmt(c.duration)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <main className="reader">
          <foliate-view ref={viewCallbackRef} class="foliate-view" />
        </main>
      </div>

      <footer className="player">
        <div className="player-chapter">
          <div className="player-chapter-title">{chapter?.title}</div>
          <div className="player-time">{fmt(currentTime)} / {fmt(duration)}</div>
        </div>
        <div className="player-controls">
          <button className="icon-btn" onClick={prev} aria-label="Previous chapter">⏮</button>
          <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button className="icon-btn" onClick={next} aria-label="Next chapter">⏭</button>
        </div>
        <input
          className="seek"
          type="range" min={0} max={duration || 0} value={currentTime}
          onChange={(e) => {
            const t = parseFloat(e.target.value)
            if (audioRef.current) audioRef.current.currentTime = t
            setCurrentTime(t)
            lastWordIdxRef.current = -1
            onTimeUpdate()
          }}
        />
      </footer>

      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={onEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
    </div>
  )
}
