import { useEffect, useRef, useState, useCallback } from 'react'
import ErrorBoundary from './ErrorBoundary.jsx'

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

// @font-face rules embedded in the reader CSS so each EPUB iframe can load
// the fonts from /fonts/* (same origin). These cover the three non-system
// fonts exposed in settings; the others fall through to native stacks.
const FONT_FACES = `
@font-face { font-family: 'Lexend'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/fonts/lexend-400.woff2') format('woff2'); }
@font-face { font-family: 'Atkinson Hyperlegible'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/fonts/atkinson-400.woff2') format('woff2'); }
@font-face { font-family: 'OpenDyslexic'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('/fonts/opendyslexic-400.woff2') format('woff2'); }
`

function readerCss(theme, prefs) {
  const t = THEMES[theme] || THEMES.dark
  const font = FONTS[prefs?.font] || FONTS.iowan
  const size = prefs?.size ?? 19
  const lh = prefs?.lineHeight ?? 1.7
  return FONT_FACES + `
    html, body {
      background: ${t.readerBg} !important;
      color: ${t.readerFg} !important;
      font-family: ${font.css} !important;
      font-size: ${size}px !important;
      line-height: ${lh} !important;
      -webkit-font-smoothing: antialiased;
    }
    body { max-width: 38em !important; margin: 0 auto !important; padding: 1em 1.2em !important; }
    section, section.level1, .level1, section > * { max-width: 38em !important; margin-left: auto !important; margin-right: auto !important; }
    p { margin: 0 0 1em !important; orphans: 2; widows: 2; }
    h1, h2, h3 { line-height: 1.3 !important; color: ${t.readerFg} !important; }
    a, a:link { color: ${t.link} !important; }
    mark.word-hl {
      background: linear-gradient(transparent 58%, ${t.hl} 58%) !important;
      color: inherit !important;
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
  const [manifestLoadError, setManifestLoadError] = useState(null)  // CQ-11
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
  const sectionIndexMapRef = useRef({})   // chapter id -> section index for renderer.goTo
  const loadHandlerRef = useRef(null)     // CQ-7: named foliate 'load' handler so we can removeEventListener
  const applySeekRef = useRef(null)       // CQ-3: pending applySeek listener so chapter change can remove it
  const textMapRetriesRef = useRef(0)     // CQ-4: section-text-map retry counter, reset on chapter change
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
    // re-pin single-column on the next frame (setStyles re-applies the epub CSS)
    requestAnimationFrame(() => { try { enforceSingleColumn() } catch {} })
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
    // CQ-2: hoist the visibilitychange handler to a named function so the
    // cleanup can remove it. The previous anonymous handler leaked across
    // every chapter change (a new one was registered each time).
    const onVis = () => { if (document.hidden) flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex])

  // ---- load manifest ----
  useEffect(() => {
    // CQ-11: handle network / parse failures so the app doesn't hang on
    // "Loading..." forever. Surface the error in the UI so the user can
    // tell the difference between "still loading" and "the manifest is gone".
    fetch(MANIFEST_URL).then(r => {
      if (!r.ok) throw new Error(`manifest HTTP ${r.status}`)
      return r.json()
    }).then(m => {
      if (!m || !Array.isArray(m.chapters)) throw new Error('manifest shape: missing chapters')
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
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.error('manifest load failed:', err)
      setManifestLoadError(err?.message || String(err))
      setLoading(false)
    })
  }, [])

  const chapter = manifest?.chapters[currentIndex]

  // ---- load timings for current chapter ----
  useEffect(() => {
    setTimings(null)
    setSyncAvailable(false)
    wordSpansRef.current = []
    lastWordIdxRef.current = -1
    // CQ-4: reset the retry counter so chapter A's pending retries can't
    // fire after chapter B's section loads.
    textMapRetriesRef.current = 0
    // CQ-3: clear any pending applySeek listener from the previous chapter
    // so a slow loadedmetadata can't reset this chapter's audio.currentTime.
    if (applySeekRef.current) {
      const audio = audioRef.current
      if (audio) audio.removeEventListener('loadedmetadata', applySeekRef.current)
      applySeekRef.current = null
    }
    if (!manifest) return
    const ch = manifest.chapters[currentIndex]
    if (!ch || ch.type === 'front-matter') return
    if (timingsCache.current[ch.id]) {
      setTimings(timingsCache.current[ch.id])
      return
    }
    // CQ-12: distinguish a benign 404 (no timings shipped for this chapter =
    // audio-only mode) from a parse error (corrupted JSON = real bug). The
    // previous code swallowed both with the same handler.
    fetch(`/timings/${ch.id}.json`).then(r => {
      if (!r.ok) {
        // 404 / 410 are expected for title-only / front-matter / unaligned
        // chapters; cache the negative result so we don't refetch on every
        // visit (also closes CQ-17).
        if (r.status === 404 || r.status === 410) {
          timingsCache.current[ch.id] = null
          return null
        }
        throw new Error(`timings ${ch.id}: HTTP ${r.status}`)
      }
      return r.json()
    }).then(d => {
      if (!d) return  // negative cache hit
      if (!d.words || !Array.isArray(d.words)) throw new Error(`timings ${ch.id}: bad shape`)
      timingsCache.current[ch.id] = d
      setTimings(d)
    }).catch(err => {
      // Real errors (parse failure, network) get logged; the app falls back
      // to chapter-sync-only mode for this chapter.
      // eslint-disable-next-line no-console
      console.warn(`timings ${ch.id} failed:`, err?.message || err)
    })
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
    // CQ-4: counter lives in a ref (reset on chapter change) instead of a
    // function-property, so stale retries from chapter A can't fire after
    // the user has navigated to chapter B and overwrite textMapRef with
    // the wrong chapter's text.
    if (combined.length < 200) {
      const n = textMapRetriesRef.current + 1
      textMapRetriesRef.current = n
      if (n <= 10) setTimeout(buildSectionTextMap, 200)
      return
    }
    textMapRetriesRef.current = 0
    textMapRef.current = { fullText: combined, posMap: combinedMap }
    enforceSingleColumn()
    mapWordsToDOM()
  }

  // Force single-column layout on the EPUB body. The pandoc epub stylesheet
  // sets inline !important max-width: none on the body so it spans the full
  // viewport (which is correct for paginated reading). For our narrow reader
  // we explicitly cap it and the wrapping <section>.
  function enforceSingleColumn() {
    const view = viewRef.current
    if (!view?.renderer) return
    let docs
    try { docs = view.renderer.getContents() } catch { return }
    for (const d of docs || []) {
      const doc = d.doc
      if (!doc?.body) continue
      const max = '38em'
      doc.body.style.setProperty('max-width', max, 'important')
      doc.body.style.setProperty('max-height', 'none', 'important')
      doc.body.style.setProperty('margin', '0 auto', 'important')
      // also pin the level-1 section wrappers (foliate / pandoc put content there)
      for (const sec of doc.querySelectorAll('section, .level1, section > *')) {
        sec.style.setProperty('max-width', max, 'important')
        sec.style.setProperty('margin-left', 'auto', 'important')
        sec.style.setProperty('margin-right', 'auto', 'important')
      }
    }
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
      // SMOKE-1: build chapter-id -> section-index map. The previous approach
      // used CFIs (epubcfi(/6/8) etc.) but foliate's CFI parser fails inside
      // partsToNode for this EPUB — view.goTo(cfi) throws and the reader never
      // navigates. Section indices are integers and don't have that problem.
      // Each section's `id` looks like "EPUB/text/ch002.xhtml"; we extract
      // the chXXX token so the map survives re-ordering of front-matter.
      if (view.book?.sections) {
        view.book.sections.forEach((s, i) => {
          const m = typeof s.id === 'string' ? /ch(\d{3})\.xhtml/i.exec(s.id) : null
          if (m) sectionIndexMapRef.current[`ch${m[1]}`] = i
        })
      }
      foliateReady.current = true
      // Rebuild the text map only when a section (chapter) loads — NOT on every
      // relocate/page-change, which would block the animation frame and stutter.
      // CQ-7: store the handler in a ref so a future unmount or re-init could
      // remove it. The previous anonymous handler was registered once and
      // never removed — fine for a singleton app but fragile if openFoliateView
      // is ever called twice.
      loadHandlerRef.current = () => { buildSectionTextMap(); enforceSingleColumn() }
      view.addEventListener('load', loadHandlerRef.current)
      buildSectionTextMap()
      if (pendingNav.current) {
        const idx = sectionIndexMapRef.current[pendingNav.current]
        if (typeof idx === 'number') view.renderer.goTo({ index: idx }).catch(() => {})
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
    // SMOKE-1: use renderer.goTo({index}) instead of view.goTo(cfi). The CFI
    // form throws inside foliate's partsToNode for this EPUB; section indices
    // are robust. See the map builder in openFoliateView for how the index is
    // derived from each section's id.
    const idx = sectionIndexMapRef.current[chapter.id]
    if (typeof idx === 'number') view.renderer.goTo({ index: idx }).catch(() => {})
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
      // CQ-3: stash the listener in a ref so the chapter-change effect can
      // remove it if the user navigates away before metadata loads. Without
      // this, a slow load from chapter A can fire applySeek after the user
      // has moved to chapter B and reset B's audio.currentTime to A's value.
      const applySeek = () => {
        audio.currentTime = seekTarget
        setCurrentTime(seekTarget)
        saveProgress(currentIndex, seekTarget) // re-persist the restored position
        audio.removeEventListener('loadedmetadata', applySeek)
        applySeekRef.current = null
      }
      applySeekRef.current = applySeek
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
  // CQ-11: surface manifest fetch / parse failures with a retry affordance
  // instead of silently hanging on the loading screen.
  if (manifestLoadError) {
    return (
      <div className="loading" role="alert">
        <div>Couldn't load the book.</div>
        <div className="loading-detail">{manifestLoadError}</div>
        <button className="loading-retry" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    )
  }

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
          <div className="sidebar-header sidebar-header-row">
            <span>Chapters</span>
            <button className="icon-btn sidebar-gear" onClick={() => setShowSettings(s => !s)} aria-label="Settings" aria-expanded={showSettings} title="Settings">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          {showSettings ? (
            <SettingsPanel
              theme={theme} setTheme={setTheme}
              prefs={prefs} setPrefs={setPrefs}
            />
          ) : (
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
          )}
        </aside>

        <main className="reader">
          {/* CQ-1: catch throws from openFoliateView / buildTextMap /
              highlightWord so a single malformed chapter doesn't white-
              screen the whole app. */}
          <ErrorBoundary>
            <foliate-view ref={viewCallbackRef} class="foliate-view" />
          </ErrorBoundary>
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

// Inline settings panel — replaces the chapter list when the gear is active.
// Sits in the same sidebar so no modal/overlay disrupts the layout.
function SettingsPanel({ theme, setTheme, prefs, setPrefs }) {
  const fontEntries = Object.entries(FONTS)
  const flowEntries = FLOW_OPTS
  return (
    <div className="settings-panel">
      <div className="settings-group">
        <label className="settings-label">Theme</label>
        <div className="option-row">
          <button
            className={`option-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => setTheme('dark')}
            aria-pressed={theme === 'dark'}
          >Dark</button>
          <button
            className={`option-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => setTheme('light')}
            aria-pressed={theme === 'light'}
          >Light</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Font</label>
        <div className="font-list">
          {fontEntries.map(([id, f]) => (
            <button
              key={id}
              className={`font-item ${prefs.font === id ? 'active' : ''}`}
              onClick={() => setPrefs(p => ({ ...p, font: id }))}
              aria-pressed={prefs.font === id}
              title={f.note}
            >
              <span className="font-sample" style={{ fontFamily: f.css }}>Aa</span>
              <span className="font-name" style={{ fontFamily: f.css }}>{f.label}</span>
              <span className="font-note">{f.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Size</label>
        <div className="size-row">
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, size: Math.max(16, p.size - 1) }))} aria-label="Smaller">−</button>
          <div className="size-value">{prefs.size} px</div>
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, size: Math.min(32, p.size + 1) }))} aria-label="Larger">+</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Spacing</label>
        <div className="size-row">
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.max(1.3, Math.round((p.lineHeight - 0.1) * 10) / 10) }))} aria-label="Tighter">−</button>
          <div className="size-value">{prefs.lineHeight.toFixed(1)}</div>
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.min(2.2, Math.round((p.lineHeight + 0.1) * 10) / 10) }))} aria-label="Looser">+</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Page</label>
        <div className="option-row">
          {flowEntries.map((f) => (
            <button
              key={f.id}
              className={`option-btn ${prefs.flow === f.id ? 'active' : ''}`}
              onClick={() => setPrefs(p => ({ ...p, flow: f.id }))}
              aria-pressed={prefs.flow === f.id}
            >{f.label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
