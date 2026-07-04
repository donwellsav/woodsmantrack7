import { useEffect, useRef, useState, useCallback } from 'react'

const EPUB_URL = '/book.epub'
const MANIFEST_URL = '/chapters.json'
const AUDIO_BASE = '/audio'
const PROGRESS_KEY = 'woodsman-progress-v1'
const THEME_KEY = 'woodsman-theme-v1'
const SAVE_INTERVAL_MS = 3000 // throttle audio-position saves

// Readable book typography + colors for each theme, injected into the EPUB iframe.
const READER_FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Constantia, Georgia, serif'
const THEMES = {
  dark: {
    readerBg: '#21212C', readerFg: '#EDEDF1', accent: '#A1A1B8', hl: 'rgba(161,161,184,0.30)',
    link: '#B3B3C5',
  },
  light: {
    readerBg: '#C9C9D6', readerFg: '#2C2C3A', accent: '#53536D', hl: 'rgba(83,83,109,0.22)',
    link: '#424257',
  },
}

function readerCss(theme, prefs) {
  const t = THEMES[theme] || THEMES.dark
  const font = FONTS[prefs?.font] || FONTS.iowan
  const size = prefs?.size ?? 19
  const lh = prefs?.lineHeight ?? 1.7
  return `
    html, body {
      background: ${t.readerBg} !important;
      color: ${t.readerFg} !important;
      font-family: ${font.css} !important;
      font-size: ${size}px !important;
      line-height: ${lh} !important;
      -webkit-font-smoothing: antialiased;
    }
    body { max-width: 38em !important; margin: 0 auto !important; padding: 1em 1.2em !important; }
    p { margin: 0 0 1em !important; orphans: 2; widows: 2; }
    h1, h2, h3 { line-height: 1.3 !important; color: ${t.readerFg} !important; }
    a, a:link { color: ${t.link} !important; }
    mark.word-hl {
      background: linear-gradient(transparent 58%, ${t.hl} 58%) !important;
      color: inherit !important;
      border-radius: 2px;
    }
  `
}

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// Reader preferences persisted to localStorage. Defaults are tuned for a
// comfortable book-reading experience on both light and dark themes.
const PREFS_KEY = 'woodsman-prefs-v1'

const FONTS = {
  iowan: {
    label: 'Iowan Old Style',
    css: '"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Constantia, Georgia, serif',
    note: 'Classic book serif',
  },
  lexend: {
    label: 'Lexend',
    css: '"Lexend", "Iowan Old Style", Georgia, serif',
    note: 'Optimized for reading speed',
  },
  atkinson: {
    label: 'Atkinson Hyperlegible',
    css: '"Atkinson Hyperlegible", Verdana, sans-serif',
    note: 'High-legibility (Braille Institute)',
  },
  opendyslexic: {
    label: 'OpenDyslexic',
    css: '"OpenDyslexic", "Iowan Old Style", serif',
    note: 'Dyslexia-friendly',
  },
  georgia: {
    label: 'Georgia',
    css: 'Georgia, "Times New Roman", serif',
    note: 'Friendly system serif',
  },
  serif: {
    label: 'System serif',
    css: 'Georgia, "Times New Roman", serif',
    note: 'Native only',
  },
}

const FLOW_OPTS = [
  { id: 'scrolled', label: 'Scroll', note: 'Continuous, smooth' },
  { id: 'paginated', label: 'Page', note: 'One page at a time' },
]

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return {
      font: FONTS[p.font] ? p.font : 'iowan',
      size: typeof p.size === 'number' && p.size >= 16 && p.size <= 32 ? p.size : 19,
      flow: p.flow === 'paginated' ? 'paginated' : 'scrolled',
      lineHeight: typeof p.lineHeight === 'number' && p.lineHeight >= 1.3 && p.lineHeight <= 2.2 ? p.lineHeight : 1.7,
    }
  } catch {
    return { font: 'iowan', size: 19, flow: 'scrolled', lineHeight: 1.7 }
  }
}

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
  const [theme, setTheme] = useState(initialTheme)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [showSettings, setShowSettings] = useState(false)
  const themeRef = useRef(theme)
  const prefsRef = useRef(prefs)

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
  useEffect(() => {
    themeRef.current = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
    document.documentElement.setAttribute('data-theme', theme)
    applyReaderCss()
  }, [theme])

  // Persist reader prefs + apply them to the EPUB iframe
  useEffect(() => {
    prefsRef.current = prefs
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch {}
    // switch the renderer's flow mode live; foliate re-renders the section
    const view = viewRef.current
    if (view?.renderer?.setAttribute) {
      try { view.renderer.setAttribute('flow', prefs.flow) } catch {}
    }
    applyReaderCss()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  function applyReaderCss() {
    const view = viewRef.current
    if (view?.renderer?.setStyles) {
      try { view.renderer.setStyles(readerCss(themeRef.current, prefsRef.current)) } catch {}
    }
  }

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
    // foliate may fire 'load' before the section's body is fully populated;
    // if the captured text is too short, retry shortly (but cap retries so
    // genuinely short chapters — e.g. title-only — don't loop forever).
    if (combined.length < 200) {
      const n = (buildSectionTextMap._retries || 0) + 1
      buildSectionTextMap._retries = n
      if (n <= 10) setTimeout(buildSectionTextMap, 200)
      return
    }
    buildSectionTextMap._retries = 0
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
      // continuous (scrolled) flow: one smooth native-scroll document per chapter
      // instead of paginated page-turns — no transition to jank, and getContents()
      // returns the whole chapter so the text map builds once per chapter.
      try { view.renderer.setAttribute('flow', prefsRef.current.flow) } catch {}
      // theme the reader's scroll container (it lives in the paginator's shadow
      // root, so inject a stylesheet there to style its scrollbar per theme)
      try {
        const sr = view.renderer.shadowRoot
        if (sr && !sr.getElementById('scrollbar-style')) {
          const s = document.createElement('style')
          s.id = 'scrollbar-style'
          s.textContent = `
            #container { scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) var(--scroll-track); }
            #container::-webkit-scrollbar { width: 12px; }
            #container::-webkit-scrollbar-track { background: var(--scroll-track); }
            #container::-webkit-scrollbar-thumb {
              background: var(--scroll-thumb); border-radius: 6px;
              border: 3px solid var(--scroll-track);
            }
          `
          sr.appendChild(s)
        }
      } catch {}
      // foliate renders nothing until you navigate — trigger the first section
      await view.renderer.firstSection().catch(() => {})
      // theme the EPUB content (foliate stores + reapplies these on every chapter)
      try { view.renderer.setStyles(readerCss(themeRef.current, prefsRef.current)) } catch {}
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
      // Rebuild the text map only when a section (chapter) loads — NOT on every
      // relocate/page-change, which would block the animation frame and stutter.
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
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
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

      {showSettings && (
        <SettingsModal
          theme={theme}
          setTheme={setTheme}
          prefs={prefs}
          setPrefs={setPrefs}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

function SettingsModal({ theme, setTheme, prefs, setPrefs, onClose }) {
  // close on Esc; close on backdrop click
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const sizeStep = 1
  const fontEntries = Object.entries(FONTS)
  const flowEntries = FLOW_OPTS

  return (
    <div className="settings-backdrop" onClick={onClose} role="presentation">
      <div className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-title">Settings</div>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="settings-group">
          <label className="settings-label">Theme</label>
          <div className="option-row">
            <button
              className={`option-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => setTheme('dark')}
              aria-pressed={theme === 'dark'}
            >
              <span className="swatch" style={{ background: '#1E1E28' }} />
              Dark
            </button>
            <button
              className={`option-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => setTheme('light')}
              aria-pressed={theme === 'light'}
            >
              <span className="swatch" style={{ background: '#C9C9D6', border: '1px solid #A1A1B8' }} />
              Light
            </button>
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Reading font</label>
          <div className="option-row">
            {fontEntries.map(([id, f]) => (
              <button
                key={id}
                className={`option-btn ${prefs.font === id ? 'active' : ''}`}
                onClick={() => setPrefs(p => ({ ...p, font: id }))}
                aria-pressed={prefs.font === id}
                title={f.note}
                style={id !== 'serif' && id !== 'iowan' ? { fontFamily: f.css } : undefined}
              >
                <span className="font-sample" style={id !== 'serif' ? { fontFamily: f.css } : undefined}>Aa</span>
                <span style={{ fontSize: '0.72rem' }}>{f.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Text size</label>
          <div className="size-row">
            <button
              className="size-btn"
              onClick={() => setPrefs(p => ({ ...p, size: Math.max(16, p.size - sizeStep) }))}
              aria-label="Smaller text"
            >−</button>
            <div className="size-value">{prefs.size} px</div>
            <button
              className="size-btn"
              onClick={() => setPrefs(p => ({ ...p, size: Math.min(32, p.size + sizeStep) }))}
              aria-label="Larger text"
            >+</button>
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Page turn style</label>
          <div className="option-row">
            {flowEntries.map((f) => (
              <button
                key={f.id}
                className={`option-btn ${prefs.flow === f.id ? 'active' : ''}`}
                onClick={() => setPrefs(p => ({ ...p, flow: f.id }))}
                aria-pressed={prefs.flow === f.id}
              >
                <span style={{ fontWeight: 700 }}>{f.label}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{f.note}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Line spacing</label>
          <div className="size-row">
            <button
              className="size-btn"
              onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.max(1.3, Math.round((p.lineHeight - 0.1) * 10) / 10) }))}
              aria-label="Tighter spacing"
            >−</button>
            <div className="size-value">{prefs.lineHeight.toFixed(1)}</div>
            <button
              className="size-btn"
              onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.min(2.2, Math.round((p.lineHeight + 0.1) * 10) / 10) }))}
              aria-label="Looser spacing"
            >+</button>
          </div>
        </div>

        <div className="footnote">
          Reading position and preferences are saved locally on this device.
        </div>
      </div>
    </div>
  )
}
