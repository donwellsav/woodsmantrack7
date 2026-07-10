import { useEffect, useRef, useState, useCallback } from 'react'
import ErrorBoundary from './ErrorBoundary.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import { FONTS, loadPrefs } from './prefs.js'
import { PROGRESS_KEY, bookPercentage, parseProgress, updateProgress } from './progress.js'

// In production, audio is served from Cloudflare R2 via a custom domain
// (audio.donewellbooks.com) bound to the woodsman-audio bucket. R2 gives us
// zero egress fees, global CDN, and native Range/206 support for seeking.
// In dev, the Vite middleware streams from the sibling ElevenLabs folder.
const EPUB_URL = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? '/book.epub' : './book.epub'
const MANIFEST_URL = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? '/chapters.json' : './chapters.json'
const AUDIO_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? '/audio' : 'https://audio.donewellbooks.com'
const THEME_KEY = 'woodsman-theme-v1'
const SAVE_INTERVAL_MS = 3000 // throttle audio-position saves
const FOLIATE_UPGRADE_TIMEOUT_MS = 5000

async function fetchEpubBlob() {
  const response = await fetch(EPUB_URL)
  if (!response.ok) throw new Error(`EPUB HTTP ${response.status}`)
  return response.blob()
}

async function waitForFoliateView() {
  if (customElements.get('foliate-view')) return
  let timeout
  try {
    await Promise.race([
      customElements.whenDefined('foliate-view'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('foliate-view upgrade timed out')), FOLIATE_UPGRADE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

// Readable book typography + colors for each theme, injected into the EPUB iframe.
const READER_FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Constantia, Georgia, serif'
const THEMES = {
  dark: {
    // Deeper background (#181820 vs old #21212C) so the highlight glow
    // stands out more. Highlight is now a solid translucent fill + a
    // glowing box-shadow border in the accent color.
    readerBg: '#181820', readerFg: '#EDEDF1', accent: '#A1A1B8', hl: 'rgba(161,161,184,0.35)',
    glow: 'rgba(180,180,210,0.6)',
    link: '#B3B3C5',
  },
  light: {
    readerBg: '#BFC0CE', readerFg: '#2C2C3A', accent: '#53536D', hl: 'rgba(83,83,109,0.30)',
    glow: 'rgba(83,83,109,0.5)',
    link: '#424257',
  },
}

// @font-face rules embedded in the reader CSS so each EPUB iframe can load
// the fonts from /fonts/* (same origin). These cover the three non-system
// fonts exposed in settings; the others fall through to native stacks.
// Use absolute URLs so @font-face resolves inside foliate's blob iframe.
const FONT_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''
const FONT_FACES = `
@font-face { font-family: 'Lexend'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('${FONT_ORIGIN}/fonts/lexend-400.woff2') format('woff2'); }
@font-face { font-family: 'Atkinson Hyperlegible'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('${FONT_ORIGIN}/fonts/atkinson-400.woff2') format('woff2'); }
@font-face { font-family: 'OpenDyslexic'; font-style: normal; font-weight: 400; font-display: swap;
  src: url('${FONT_ORIGIN}/fonts/opendyslexic-400.woff2') format('woff2'); }
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
    body { max-width: none !important; width: 100% !important; box-sizing: border-box !important; margin: 0 !important; padding: 1em 1.2em !important; }
    section, section.level1, .level1, section > * { max-width: none !important; margin-left: 0 !important; margin-right: 0 !important; }
    p { margin: 0 0 1em !important; orphans: 2; widows: 2; }
    h1, h2, h3 { line-height: 1.3 !important; color: ${t.readerFg} !important; }
    a, a:link { color: ${t.link} !important; }
    mark.word-hl {
      background: ${t.hl} !important;
      color: inherit !important;
      box-shadow: 0 0 6px 1px ${t.glow}, 0 0 2px 0 ${t.glow} inset !important;
      border-radius: 2px !important;
    }
    ::highlight(sentence-hl) {
      background-color: ${t.hl};
      color: inherit;
    }
  `
}

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {}
  return 'dark'
}

// Reader preferences persisted to localStorage. Defaults are tuned for a
// comfortable book-reading experience on both light and dark themes.
const PREFS_KEY = 'woodsman-prefs-v1'

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

const IconMenu = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" /></svg>
)
const IconSettings = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)
const IconPrev = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M17 6l-8 6 8 6V6zM5 6v12" /></svg>
)
const IconPlay = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M7 5l14 7-14 7V5z" /></svg>
)
const IconPause = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="5" height="14" rx="1" /><rect x="13" y="5" width="5" height="14" rx="1" /></svg>
)
const IconNext = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 6l8 6-8 6V6zM17 6v12" /></svg>
)
const IconChevron = ({ direction = 'up' }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: direction === 'down' ? 'rotate(180deg)' : 'none' }}>
    <polyline points="18 15 12 9 6 15" />
  </svg>
)

export default function App() {
  const [manifest, setManifest] = useState(null)
  const [progress, setProgress] = useState(() => {
    try { return parseProgress(localStorage.getItem(PROGRESS_KEY)) } catch { return parseProgress(null) }
  })
  const progressRef = useRef(progress)
  const [currentIndex, setCurrentIndex] = useState(progress.currentIndex)
  // CQ-16: mirror so applySeek (which fires async on loadedmetadata) reads the
  // current chapter index, not the one captured at the render that scheduled
  // the listener.
  const currentIndexRef = useRef(progress.currentIndex)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [readerState, setReaderState] = useState({ status: 'loading', error: null })
  const [readerKey, setReaderKey] = useState(0)
  // PERF-7: SW update prompt state. The new SW waits to activate until the
  // user accepts this toast — preserves in-memory refs (timingsCache,
  // textMapRef, sectionIndexMapRef) across deploys during a long listening session.
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const swUpdateRef = useRef(null)
  const [manifestLoadError, setManifestLoadError] = useState(null)  // CQ-11
  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile())
  // UX-03: on mobile, the seek slider lives in a collapsible accordion so the
  // player bar can stay compact and the slider only takes full width when open.
  const [seekExpanded, setSeekExpanded] = useState(false)
  // UX-01: when the user resizes to mobile, collapse the sidebar so it doesn't
  // cover the reader content. Re-open when resizing back to desktop only if the
  // user didn't explicitly close it themselves.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)')
    const onChange = (e) => { if (e.matches) setSidebarOpen(false) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  // (syncAvailable removed — sync badge is no longer shown)
  const [timings, setTimings] = useState(null)
  const [theme, setTheme] = useState(initialTheme)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [showSettings, setShowSettings] = useState(false)
  const themeRef = useRef(theme)
  const prefsRef = useRef(prefs)

  const viewRef = useRef(null)
  const audioRef = useRef(null)
  const foliateReady = useRef(false)
  // CQ-5: state mirror of foliateReady so the chapter-nav effect re-runs when
  // foliate finishes opening, instead of relying on a pendingNav ref that
  // captures the first clicked chapter and may be stale by the time open
  // resolves.
  const [foliateReadyFlag, setFoliateReadyFlag] = useState(false)
  const pendingNav = useRef(null)
  const timingsCache = useRef({})
  const timingsRef = useRef(null)         // mirror of timings state for event handlers
  const sectionIndexMapRef = useRef({})   // chapter id -> section index for renderer.goTo
  const readerHandlersRef = useRef(new WeakMap()) // view -> named listeners removed during remount cleanup
  const applySeekRef = useRef(null)       // CQ-3: pending applySeek listener so chapter change can remove it
  const textMapRetriesRef = useRef(0)     // CQ-4: section-text-map retry counter, reset on chapter change
  const textMapRef = useRef(null)         // { fullText, posMap } for current section
  const wordSpansRef = useRef([])         // [{node, offset, length}] per timing word
  const currentMarkRef = useRef(null)     // currently inserted <mark>
  const lastWordIdxRef = useRef(-1)
  const sentenceMapRef = useRef([])       // [{ start, end }] word-index range per sentence
  const wordToSentenceRef = useRef([])    // wordIdx -> sentenceIdx reverse lookup
  const pendingSeekRef = useRef(null)      // audio seek target to restore on chapter load
  const lastSaveRef = useRef(0)            // throttle timestamp for progress saves
  const rafIdxRef = useRef(-1)            // PERF-5: pending rAF word index (-1 = no scheduled frame)
  const rafHandleRef = useRef(0)          // PERF-5: handle of the in-flight rAF so we can cancel on unmount
  const chapterGenRef = useRef(0)         // CQ-8: increments on chapter change; mapWordsToDOM / highlightWord bail if the gen they were called with is stale
  const lastScrollRef = useRef(0)         // PERF-5: throttle timestamp for scrollIntoView
  const cssDebounceRef = useRef(0)        // PERF-6: debounce timer handle for applyReaderCss
  const isScrubbingRef = useRef(false)    // PERF-9: true while the user is dragging the seek slider
  const epubPromiseRef = useRef(null)     // PERF-10: preloaded EPUB Blob promise (parallel with manifest fetch)
  const readerAttemptRef = useRef(0)      // ignores completion from reader instances replaced by Retry

  useEffect(() => {
    timingsRef.current = timings
    // Build sentence boundaries so highlightWord can resolve word→sentence.
    buildSentenceMap(timings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timings])
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
    if (audioRef.current) audioRef.current.playbackRate = prefs.playbackRate
    // switch the renderer's flow mode live; foliate re-renders the section
    const view = viewRef.current
    if (view?.renderer?.setAttribute) {
      try { view.renderer.setAttribute('flow', 'scrolled') } catch {}
    }
    applyReaderCss()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  function applyReaderCss() {
    // PERF-6: debounce so rapid +/- clicks (size, lineHeight) coalesce into a
    // single iframe repaint. Without this, holding "+" produces a stream of
    // setStyles calls that visibly stutter on mobile.
    if (cssDebounceRef.current) clearTimeout(cssDebounceRef.current)
    cssDebounceRef.current = setTimeout(() => {
      cssDebounceRef.current = 0
      const view = viewRef.current
      if (view?.renderer?.setStyles) {
        try { view.renderer.setStyles(readerCss(themeRef.current, prefsRef.current)) } catch {}
      }
    }, 100)
  }

  // ---- reading-progress persistence ----
  function saveProgress(idx, time, duration, completed) {
    const next = updateProgress(progressRef.current, {
      currentIndex: idx,
      currentTime: time,
      duration,
      completed,
    })
    progressRef.current = next
    setProgress(next)
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(next)) } catch {}
  }

  // ---- reading-progress persistence (continued below after `chapter` decl) ----

  // persist on hide/unload so the last few seconds aren't lost
  useEffect(() => {
    const flush = () => {
      const a = audioRef.current
      const idx = currentIndexRef.current
      const saved = progressRef.current
      const time = a?.readyState >= 1
        ? a.currentTime
        : saved.chapters[idx]?.seconds ?? (saved.currentIndex === idx ? saved.currentTime : 0)
      saveProgress(idx, time, manifest?.chapters[idx]?.duration || a?.duration)
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
  }, [currentIndex, manifest])

  // ---- load manifest ----
  useEffect(() => {
    // PERF-10: kick off the EPUB fetch in parallel with the manifest. The
    // previous code only fetched /book.epub inside openFoliateView (after
    // React commits + foliate finishes loading), serializing ~260KB behind
    // the chapter list paint. Preloading here lets both round-trips overlap.
    epubPromiseRef.current = fetchEpubBlob()
    // The reader consumes this same promise after the manifest loads. Attach a
    // handler now so an early HTTP failure is not reported as unhandled.
    epubPromiseRef.current.catch(() => {})
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
      const saved = progressRef.current
      const idx = saved.currentIndex < m.chapters.length ? saved.currentIndex : 0
      currentIndexRef.current = idx
      setCurrentIndex(idx)
      pendingSeekRef.current = saved.chapters[idx]?.seconds
        ?? (saved.currentIndex === idx ? saved.currentTime : 0)
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.error('manifest load failed:', err)
      setManifestLoadError(err?.message || String(err))
      setLoading(false)
    })
  }, [])

  const chapter = manifest?.chapters[currentIndex]

  // A11Y-12: Esc closes the settings panel; the old SettingsModal had this
  // and the inline-panel refactor lost it. Restores keyboard parity.
  useEffect(() => {
    if (!showSettings) return
    const onKey = (e) => { if (e.key === 'Escape') setShowSettings(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showSettings])

  // ---- load timings for current chapter ----
  useEffect(() => {
    setTimings(null)
    wordSpansRef.current = []
    lastWordIdxRef.current = -1
    // CQ-4: reset the retry counter so chapter A's pending retries can't
    // fire after chapter B's section loads.
    textMapRetriesRef.current = 0
    // CQ-8: bump the chapter-generation token so any in-flight mapWordsToDOM
    // from the previous chapter bails before mutating wordSpansRef.
    chapterGenRef.current++
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
    // CQ-17: check `!== undefined` so a cached null (404 negative cache) is
    // treated as a hit. The previous truthy check re-fetched on every visit
    // to a title-only / front-matter / unaligned chapter.
    if (timingsCache.current[ch.id] !== undefined) {
      const cached = timingsCache.current[ch.id]
      if (cached) setTimings(cached)
      return
    }
    // CQ-12 + CQ-17: distinguish a benign missing-timings response (no timings
    // shipped for this chapter = audio-only mode) from a parse error (real
    // bug). Cache the negative result so we don't refetch on every visit.
    //
    // Note: in dev, Vite serves the SPA index.html (200, text/html) for any
    // missing file under public/, so we can't rely on r.ok alone. We also
    // check Content-Type to detect the SPA-fallback case and treat it the
    // same as a 404.
    fetch(`/timings/${ch.id}.json`).then(r => {
      const ct = r.headers.get('content-type') || ''
      const isJson = ct.includes('application/json') || ct.includes('text/json')
      if (!r.ok || !isJson) {
        // 404, 410, or dev-server SPA fallback (200 with text/html) — all
        // mean "no timings for this chapter." Cache the negative result.
        if (r.status === 404 || r.status === 410 || !isJson) {
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
  // CQ-8: capture the chapter-generation token at entry; bail if it changed
  // mid-build (chapter navigation while async textMap is resolving).
  function mapWordsToDOM() {
    const gen = chapterGenRef.current
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
    // CQ-8: bail if a chapter navigation happened during the build.
    if (gen !== chapterGenRef.current) return
    wordSpansRef.current = spans
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
    mapWordsToDOM()
    if (prefsRef.current.clickToSeek) {
      attachClickToSeek(docs)
    } else {
      // Off: remove any previously-attached handler so clicks do nothing.
      for (const d of docs) {
        const doc = d.doc
        if (doc?.__ctsClick) {
          doc.removeEventListener('click', doc.__ctsClick, true)
          doc.__ctsClick = null
        }
      }
    }
  }

  function isCurrentReaderAttempt(view, attempt) {
    return readerAttemptRef.current === attempt && viewRef.current === view
  }

  function cleanupFoliateView(view) {
    if (!view) return
    const handlers = readerHandlersRef.current.get(view)
    if (handlers?.load) {
      try { view.removeEventListener('load', handlers.load) } catch {}
    }
    readerHandlersRef.current.delete(view)
    try { view.close?.() } catch {}
  }

  // ---- open foliate-view (callback ref so it runs after the element is attached) ----
  async function openFoliateView(view, attempt) {
    try {
      await waitForFoliateView()
      if (!isCurrentReaderAttempt(view, attempt)) return
      // CQ-23: clear any stale section-index map from a previous open attempt
      // so a re-init (StrictMode double-invoke, ErrorBoundary retry) doesn't
      // carry forward mappings from a different EPUB instance.
      sectionIndexMapRef.current = {}
      // PERF-10: consume the preloaded EPUB blob (kicked off alongside the
      // manifest fetch). Retry intentionally clears it and fetches a new copy.
      const blob = epubPromiseRef.current
        ? await epubPromiseRef.current
        : await fetchEpubBlob()
      if (!isCurrentReaderAttempt(view, attempt)) return
      const file = new File([blob], 'book.epub', { type: blob.type || 'application/epub+zip' })
      await view.open(file)
      if (!isCurrentReaderAttempt(view, attempt)) {
        cleanupFoliateView(view)
        return
      }
      // continuous scroll: one smooth native-scroll document per chapter
      // — no transition to jank, and getContents()
      // returns the whole chapter so the text map builds once per chapter.
      try { view.renderer.setAttribute('flow', 'scrolled') } catch {}
      // theme the reader's scroll container (it lives in the paginator's shadow
      // root, so inject a stylesheet there to style its scrollbar per theme).
      try {
        const sr = view.renderer.shadowRoot
        if (sr && !sr.getElementById('scrollbar-style')) {
          const s = document.createElement('style')
          s.id = 'scrollbar-style'
          s.textContent = `
            #top {
              --_gap: 2% !important;
              /* Foliate requires a pixel cap; keep it above any real viewport. */
              --_max-inline-size: 100000px !important;
              --_max-column-count: 1 !important;
              --_max-column-count-portrait: 1 !important;
            }
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
      await view.renderer.firstSection()
      if (!isCurrentReaderAttempt(view, attempt)) {
        cleanupFoliateView(view)
        return
      }
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
      // Rebuild the text map only when a section (chapter) loads — NOT on every
      // relocate/page-change, which would block the animation frame and stutter.
      const onLoad = () => buildSectionTextMap()
      view.addEventListener('load', onLoad)
      readerHandlersRef.current.set(view, { load: onLoad })
      buildSectionTextMap()
      if (pendingNav.current) {
        const idx = sectionIndexMapRef.current[pendingNav.current]
        if (typeof idx === 'number') view.renderer.goTo({ index: idx }).catch(() => {})
        pendingNav.current = null
      }
      if (!isCurrentReaderAttempt(view, attempt)) {
        cleanupFoliateView(view)
        return
      }
      foliateReady.current = true
      // CQ-5: bump the state flag so the chapter-nav effect re-runs and any
      // chapter the user clicked during foliate's open resolves against the
      // LATEST chapter.id (not whatever was captured in pendingNav when they
      // first clicked).
      setFoliateReadyFlag(true)
      setReaderState({ status: 'ready', error: null })
    } catch (e) {
      if (!isCurrentReaderAttempt(view, attempt)) {
        cleanupFoliateView(view)
        return
      }
      console.error('foliate open failed', e)
      cleanupFoliateView(view)
      setReaderState({ status: 'error', error: e?.message || String(e) })
    }
  }

  // CQ-7: unmount cleanup. Invalidate the attempt, remove listeners, close the
  // renderer, and cancel scheduled work so a detached view cannot update App.
  useEffect(() => {
    return () => {
      const view = viewRef.current
      readerAttemptRef.current += 1
      viewRef.current = null
      cleanupFoliateView(view)
      if (rafHandleRef.current) cancelAnimationFrame(rafHandleRef.current)
      if (cssDebounceRef.current) clearTimeout(cssDebounceRef.current)
    }
  }, [])

  const viewCallbackRef = useCallback((el) => {
    if (!el) {
      const view = viewRef.current
      if (view) {
        readerAttemptRef.current += 1
        viewRef.current = null
        cleanupFoliateView(view)
      }
      return
    }
    const previousView = viewRef.current
    if (previousView && previousView !== el) cleanupFoliateView(previousView)
    viewRef.current = el
    const attempt = ++readerAttemptRef.current
    setReaderState({ status: 'loading', error: null })
    openFoliateView(el, attempt)
  }, [])

  function retryReader() {
    readerAttemptRef.current += 1
    const view = viewRef.current
    viewRef.current = null
    cleanupFoliateView(view)
    epubPromiseRef.current = null
    foliateReady.current = false
    setFoliateReadyFlag(false)
    setReaderState({ status: 'loading', error: null })
    setReaderKey(key => key + 1)
  }

  // ---- navigate reader when chapter changes ----
  // CQ-5: depend on foliateReadyFlag (state) so the effect re-runs once foliate
  // finishes opening. The previous code only depended on [chapter] + read the
  // ref, so when foliate became ready mid-mount the effect never re-ran and the
  // chapter the user clicked before open resolved was lost.
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
  }, [chapter, foliateReadyFlag])

  // ---- load audio when chapter changes ----
  useEffect(() => {
    const audio = audioRef.current
    if (!chapter || !audio) return
    // restore saved position for this chapter (set by mount restore or a manual resume)
    const saved = progressRef.current
    const seekTarget = pendingSeekRef.current
      ?? saved.chapters[currentIndex]?.seconds
      ?? (saved.currentIndex === currentIndex ? saved.currentTime : 0)
    pendingSeekRef.current = null
    saveProgress(currentIndex, seekTarget, chapter.duration)
    setCurrentTime(seekTarget)
    setDuration(chapter.duration || 0)
    // Ignore the native zero-position timeupdate emitted while load() swaps
    // sources; seekTarget above is authoritative until metadata arrives.
    lastSaveRef.current = Date.now()
    currentIndexRef.current = currentIndex
    audio.src = `${AUDIO_BASE}/${chapter.audio}`
    audio.load()
    if (seekTarget > 0 && isFinite(seekTarget)) {
      // CQ-3: stash the listener in a ref so the chapter-change effect can
      // remove it if the user navigates away before metadata loads. Without
      // this, a slow load from chapter A can fire applySeek after the user
      // has moved to chapter B and reset B's audio.currentTime to A's value.
      const applySeek = () => {
        audio.currentTime = seekTarget
        setCurrentTime(seekTarget)
        // CQ-16: read from ref so a slow loadedmetadata can't save the wrong
        // chapter's progress.
        saveProgress(currentIndexRef.current, seekTarget, chapter.duration || audio.duration)
        // CQ-21: bump the throttle so the next onTimeUpdate doesn't immediately
        // duplicate the restored-position save above.
        lastSaveRef.current = Date.now()
        audio.removeEventListener('loadedmetadata', applySeek)
        applySeekRef.current = null
      }
      applySeekRef.current = applySeek
      audio.addEventListener('loadedmetadata', applySeek)
    }
    // If we were playing and the new chapter is loading, start playback
    // once the metadata is ready. Deferring to loadedmetadata avoids races
    // where play() is called before load() has fully wired the new src
    // (browsers can pause the element during the swap).
    if (isPlaying) {
      const onReady = () => {
        audio.removeEventListener('loadedmetadata', onReady)
        audio.play().catch(() => {})
      }
      audio.addEventListener('loadedmetadata', onReady)
      // Failsafe: also try immediately in case loadedmetadata already fired.
      audio.play().catch(() => {})
    }
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
      const idx = currentIndexRef.current
      saveProgress(idx, a.currentTime, manifest?.chapters[idx]?.duration || a.duration)
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
    // PERF-5: coalesce into a single rAF. Skip when the SENTENCE hasn't
    // changed — the whole sentence highlights at once, so re-highlighting
    // the same sentence is wasted work.
    const sentIdx = wordToSentenceRef.current[idx] ?? idx
    if (sentIdx === lastWordIdxRef.current) return
    rafIdxRef.current = idx
    if (rafHandleRef.current) return
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = 0
      const target = rafIdxRef.current
      rafIdxRef.current = -1
      const targetSent = wordToSentenceRef.current[target] ?? target
      if (targetSent !== lastWordIdxRef.current) {
        lastWordIdxRef.current = targetSent
        highlightWord(target)
      }
    })
  }
  const onLoadedMeta = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = prefsRef.current.playbackRate
    setDuration(audio.duration || 0)
  }
  const advancingRef = useRef(false)
  const activateChapter = useCallback((idx) => {
    const oldIndex = currentIndexRef.current
    if (!manifest || idx === oldIndex || idx < 0 || idx >= manifest.chapters.length) return

    const audio = audioRef.current
    const saved = progressRef.current
    const oldSeconds = audio?.readyState >= 1
      ? audio.currentTime
      : saved.chapters[oldIndex]?.seconds ?? (saved.currentIndex === oldIndex ? saved.currentTime : 0)
    const targetSeconds = saved.chapters[idx]?.seconds
      ?? (saved.currentIndex === idx ? saved.currentTime : 0)

    saveProgress(oldIndex, oldSeconds, manifest.chapters[oldIndex]?.duration || audio?.duration)
    pendingSeekRef.current = targetSeconds
    setCurrentIndex(idx)
  }, [manifest])
  const onEnded = () => {
    const idx = currentIndexRef.current
    const end = manifest?.chapters[idx]?.duration || audioRef.current?.duration || 0
    saveProgress(idx, end, end, true)
    if (manifest && idx < manifest.chapters.length - 1) {
      activateChapter(idx + 1)
    } else {
      // End of book: turn off continuous-playback mode so the next pause
      // is treated as a real user pause.
      advancingRef.current = false
      setIsPlaying(false)
    }
  }

  // Split the timings words into sentence ranges by walking the array and
  // cutting on sentence-ending punctuation (., !, ?, .", ?, etc.).
  function buildSentenceMap(t) {
    if (!t || !t.words || !t.words.length) {
      sentenceMapRef.current = []
      wordToSentenceRef.current = []
      return
    }
    const sentences = []
    const wordToSentence = new Array(t.words.length)
    let sentStart = 0
    for (let i = 0; i < t.words.length; i++) {
      wordToSentence[i] = sentences.length
      if (/[.!?]["')\]]?$/.test(t.words[i].word)) {
        sentences.push({ start: sentStart, end: i })
        sentStart = i + 1
      }
    }
    if (sentStart < t.words.length) {
      sentences.push({ start: sentStart, end: t.words.length - 1 })
    }
    sentenceMapRef.current = sentences
    wordToSentenceRef.current = wordToSentence
  }

  // Attach a click-to-seek handler to each iframe content document. On click,
  // find which word was clicked using document.caretRangeFromPoint, map it to
  // its sentence via wordToSentenceRef, then seek audio + start playing.
  function attachClickToSeek(docs) {
    for (const d of docs) {
      const doc = d.doc
      if (!doc) continue
      if (doc.__ctsClick) continue // already attached
      const handler = (e) => {
        // Ignore clicks on interactive elements inside the sentence text (e.g.
        // footnote links). The highlight covers plain text only.
        let target = e.target
        // Walk up looking for a block element; stop at the body.
        while (target && target !== doc.body && !/^(P|DIV|LI|H[1-6]|SECTION|BLOCKQUOTE|ARTICLE|MAIN)$/i.test(target.tagName)) {
          target = target.parentElement
        }
        if (!target || target === doc.body) {
          // No block context — fall back to the actual target
          target = e.target
        }
        // Use caretRangeFromPoint to find the text node + character offset.
        let range
        try { range = doc.caretRangeFromPoint(e.clientX, e.clientY) } catch { return }
        if (!range) return
        const textNode = range.startContainer
        if (textNode.nodeType !== 3) return // not a text node
        const offset = range.startOffset
        // Find which word contains this (textNode, offset). Walk wordSpans.
        const ws = wordSpansRef.current
        const t = timingsRef.current
        if (!t?.words) return
        for (let i = 0; i < ws.length; i++) {
          const s = ws[i]
          if (!s) continue
          if (s.node !== textNode) continue
          if (offset >= s.offset && offset <= s.offset + s.length) {
            // Found the clicked word. Map to its sentence.
            const sentIdx = wordToSentenceRef.current[i]
            const sentences = sentenceMapRef.current
            if (sentIdx == null || !sentences[sentIdx]) return
            const sent = sentences[sentIdx]
            const startTime = t.words?.[sent.start]?.start
            if (!isFinite(startTime)) return
            const audio = audioRef.current
            if (!audio) return
            // Set pendingSeekRef so any subsequent loadedmetadata doesn't
            // reset to 0 (same pattern as auto-advance).
            pendingSeekRef.current = startTime
            audio.currentTime = startTime
            setCurrentTime(startTime)
            // Continuous-playback flag so the natural pause during seek
            // doesn't kill isPlaying.
            advancingRef.current = true
            audio.play().catch(() => {})
            return
          }
        }
      }
      doc.addEventListener('click', handler, true)
      doc.__ctsClick = handler
    }
  }

  // When prefs.clickToSeek toggles, attach or detach the click handler on
  // the current docs. The handler is only ever attached once per doc
  // (guarded by doc.__ctsClick) so this is safe to run on every toggle.
  useEffect(() => {
    const view = viewRef.current
    if (!view?.renderer?.shadowRoot) return
    let docs
    try { docs = view.renderer.getContents() } catch { return }
    if (!docs?.length) return
    if (prefs.clickToSeek) {
      attachClickToSeek(docs)
    } else {
      for (const d of docs) {
        const doc = d.doc
        if (doc?.__ctsClick) {
          doc.removeEventListener('click', doc.__ctsClick, true)
          doc.__ctsClick = null
        }
      }
    }
  }, [prefs.clickToSeek, chapter, foliateReadyFlag])

  // Highlight the entire sentence containing word index `idx`.
  // One range: first word's text node + offset → last word's text node + offset.
  // Everything in between (commas, spaces, punctuation) is covered.
  // CSS Custom Highlight API = zero DOM mutation.
  function highlightWord(idx) {
    const ws = wordSpansRef.current
    if (idx < 0 || idx >= ws.length) return

    const sentences = sentenceMapRef.current
    const sentIdx = wordToSentenceRef.current[idx]
    let startIdx = idx, endIdx = idx
    if (sentences.length && sentIdx != null && sentences[sentIdx]) {
      startIdx = sentences[sentIdx].start
      endIdx = sentences[sentIdx].end
    }

    // Find first and last non-null word spans in the sentence.
    let firstSpan = null, lastSpan = null
    for (let i = startIdx; i <= endIdx; i++) {
      if (ws[i]?.node) {
        if (!firstSpan) firstSpan = ws[i]
        lastSpan = ws[i]
      }
    }
    if (!firstSpan || !lastSpan) return

    const win = firstSpan.node.ownerDocument.defaultView
    if (!win?.Highlight || !win?.CSS?.highlights) return

    // One range from the first word's start to the last word's end.
    const range = new win.StaticRange({
      startContainer: firstSpan.node,
      startOffset: firstSpan.offset,
      endContainer: lastSpan.node,
      endOffset: lastSpan.offset + lastSpan.length,
    })
    win.CSS.highlights.set('sentence-hl', new win.Highlight(range))

    // Scroll the sentence into view (throttled). Skip entirely in Manual flow
    // so the user controls the page position themselves.
    const now = performance.now()
    if (now - lastScrollRef.current > 600 && prefs.flow !== 'manual') {
      lastScrollRef.current = now
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      try {
        firstSpan.node.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
      } catch {}
    }
  }

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    // SMOKE-2 / CQ-28: don't setIsPlaying here — let the <audio> element's
    // onPlay/onPause handlers do it. The previous optimistic setState caused
    // a one-frame label flicker because the audio event fires asynchronously
    // after the React state update.
    if (audio.paused) {
      // Continuous playback: from this point on, treat any pause event
      // (including the brief pause at chapter end) as "not a user pause".
      // The flag is cleared either when the user manually pauses OR
      // when onPause fires during auto-advance.
      advancingRef.current = true
      audio.play().catch(() => {})
    } else {
      // User-initiated pause: clear the flag so the next pause is real.
      advancingRef.current = false
      audio.pause()
    }
  }
  const selectChapter = useCallback((idx) => {
    activateChapter(idx)
    // UX-01: on mobile, selecting a chapter should close the drawer so the user
    // can see the reader immediately instead of manually dismissing the panel.
    if (isMobile()) setSidebarOpen(false)
  }, [activateChapter])
  // CQ-15: memoize next/prev with useCallback so they don't re-allocate every
  // render. The Media Session effect (and any other consumer) gets stable
  // references.
  const next = useCallback(() => {
    activateChapter(Math.min(currentIndexRef.current + 1, (manifest?.chapters.length || 1) - 1))
  }, [activateChapter, manifest])
  const prev = useCallback(() => {
    activateChapter(Math.max(currentIndexRef.current - 1, 0))
  }, [activateChapter])
  // A11Y-15: seek by a fixed offset from the lock-screen/notification controls.
  const seekBy = useCallback((delta) => {
    const audio = audioRef.current
    if (!audio) return
    const duration = audio.duration || chapter?.duration || 0
    const t = Math.min(Math.max(audio.currentTime + delta, 0), duration)
    audio.currentTime = t
    setCurrentTime(t)
  }, [chapter])

  // ---- Media Session API (lock screen metadata + controls) ----
  useEffect(() => {
    if (!chapter || !('mediaSession' in navigator)) return
    // A11Y-15: use absolute URLs for artwork so mobile OS lock screens can
    // fetch the cover regardless of how the page was loaded (PWA, iframe, etc.).
    const artworkUrl = `${window.location.origin}/cover.jpeg`
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: manifest?.title || 'Audiobook',
      album: 'Woodsman: Track Seven',
      artwork: [
        { src: artworkUrl, sizes: '992x1586', type: 'image/jpeg' },
      ],
    })
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', prev)
    navigator.mediaSession.setActionHandler('nexttrack', next)
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-15))
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(15))
    // A11Y-15: lock-screen scrub bar + chapter-position context. Update once
    // per chapter change; the throttled onTimeUpdate handles finer-grained
    // position updates below.
    try {
      navigator.mediaSession.setPositionState({
        duration: chapter.duration || audioRef.current?.duration || 0,
        playbackRate: audioRef.current?.playbackRate || 1,
        position: Math.min(currentTime, chapter.duration || audioRef.current?.duration || 0),
      })
    } catch { /* setPositionState throws if position > duration; ignore */ }
  }, [chapter])

  // A11Y-15: throttled position update (~1Hz) so the lock-screen progress bar
  // advances without spamming the OS media framework.
  useEffect(() => {
    if (!chapter || !('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return
    const id = setInterval(() => {
      const audio = audioRef.current
      if (!audio || audio.paused) return
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration || 0,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.currentTime, audio.duration || 0),
        })
      } catch {}
    }, 1000)
    return () => clearInterval(id)
  }, [chapter])

  // ---- PERF-7: PWA update prompt ----
  useEffect(() => {
    // vite-plugin-pwa's virtual module exposes the SW registration. We import
    // it dynamically so the dev server (where the module returns a stub) does
    // not blow up if vite-plugin-pwa is disabled.
    let off
    import('virtual:pwa-register').then(({ registerSW }) => {
      off = registerSW({
        onNeedRefresh() { setUpdateAvailable(true) },
        onRegisteredSW(url, reg) {
          // Stash the update function so the toast's "Reload" button can
          // trigger it. registerSW returns this via the second arg only in
          // newer versions; the safest path is to capture from the SW reg.
          swUpdateRef.current = () => {
            if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
            window.location.reload()
          }
        },
      })
    }).catch(() => { /* virtual module not available in this build; no-op */ })
    return () => { try { off && off() } catch {} }
  }, [])

  // A11Y-03: role=status + aria-live=polite so screen readers announce
  // when the app finishes loading (was silent).
  if (loading) return <div className="loading" role="status" aria-live="polite">Loading…</div>
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

  const continueIndex = progress.currentIndex < manifest.chapters.length ? progress.currentIndex : 0
  const continueChapter = manifest.chapters[continueIndex]
  const continueSeconds = progress.chapters[continueIndex]?.seconds
    ?? (progress.currentIndex === continueIndex ? progress.currentTime : 0)
  const percentage = bookPercentage(progress, manifest.chapters)

  const seekSlider = (
    <input
      className="seek"
      type="range" min={0} max={duration || 0} value={currentTime}
      aria-label="Seek audio position"
      onPointerDown={() => { isScrubbingRef.current = true }}
      onPointerUp={() => {
        // PERF-9: only commit the actual audio.currentTime at pointer-up so
        // dragging the slider doesn't queue dozens of redundant seeks.
        isScrubbingRef.current = false
        if (audioRef.current) audioRef.current.currentTime = currentTime
        lastWordIdxRef.current = -1
        onTimeUpdate()
      }}
      onChange={(e) => {
        const t = parseFloat(e.target.value)
        // While dragging, just update state for the slider thumb; the audio
        // seek happens on pointer-up above. Outside a drag (keyboard),
        // commit immediately.
        setCurrentTime(t)
        if (!isScrubbingRef.current && audioRef.current) {
          audioRef.current.currentTime = t
          lastWordIdxRef.current = -1
          onTimeUpdate()
        }
      }}
    />
  )

  return (
    <div className="app">
      {/* A11Y-23: visually-hidden aria-live region so screen readers announce
          chapter changes. The visible player-time div updates ~4x/sec and
          would spam AT if it were the live region. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {chapter ? `Now playing: ${chapter.title}` : ''}
      </div>
      {/* A11Y-13: skip link so keyboard users can bypass the sidebar + topbar
          and land in the reader. Visually hidden until focused. */}
      <a href="#main-reader" className="skip-link">Skip to reader</a>
      <header className="topbar">
        <button className="icon-btn topbar-chapters" onClick={() => { setSidebarOpen(!sidebarOpen || showSettings); setShowSettings(false) }} aria-label={sidebarOpen && !showSettings ? 'Hide chapters' : 'Show chapters'} aria-pressed={sidebarOpen && !showSettings} title="Chapters">
          <IconMenu />
        </button>
        <h1 className="book-title">
          <span className="book-name">Woodsman: Track Seven</span>
          <span className="book-byline">by Don Wells</span>
        </h1>
        <span className="spacer" />
      </header>

      <div className="main">
        <aside
          className={`sidebar ${sidebarOpen ? '' : 'closed'}`}
          inert={sidebarOpen ? undefined : ''}
          aria-hidden={sidebarOpen ? undefined : 'true'}
        >
          <div className="sidebar-header">
            <h2 id="chapters-heading" className="sidebar-heading">{showSettings ? 'Settings' : 'Chapters'}</h2>
          </div>
          {showSettings ? (
            <SettingsPanel
              theme={theme} setTheme={setTheme}
              prefs={prefs} setPrefs={setPrefs}
            />
          ) : (
            <>
              <div className="progress-summary">
                {continueSeconds > 0 && (
                  <div className="continue-cue">
                    Continue from {continueChapter.title} · {fmt(continueSeconds)}
                  </div>
                )}
                <span className="book-progress" aria-label={`Book progress: ${percentage}%`}>
                  {percentage}% of book
                </span>
              </div>
              {/* A11Y-07: wrap the chapter list in a <nav> with aria-labelledby
                  so screen-reader landmark navigation finds it. */}
              <nav aria-labelledby="chapters-heading">
                <ol className="chapter-list">
                  {manifest.chapters.map((c, i) => {
                    const saved = progress.chapters[i]
                    const seconds = saved?.seconds ?? (progress.currentIndex === i ? progress.currentTime : 0)
                    const completed = saved?.completed === true || (c.duration > 0 && seconds >= c.duration)
                    const chapterPercentage = c.duration > 0
                      ? Math.min(100, Math.round((seconds / c.duration) * 100))
                      : 0
                    return (
                      <li key={c.id}>
                        {/* A11Y-08: aria-current tells screen-reader users which
                            chapter is active. Critical for an audiobook: the
                            user must know where they are. */}
                        <button
                          className={`chapter-item ${i === currentIndex ? 'active' : ''}`}
                          onClick={() => selectChapter(i)}
                          aria-current={i === currentIndex ? 'true' : undefined}
                        >
                          <span className="chapter-title">{c.title}</span>
                          <span className="chapter-meta">
                            {c.type === 'title-only' && (
                              <span className="badge" aria-label="Part title only chapter (no audio)">
                                {c.id === 'ch003' ? 'Part I'
                                  : c.id === 'ch009' ? 'Part II'
                                  : c.id === 'ch016' ? 'Part III'
                                  : c.id === 'ch024' ? 'Part IV'
                                  : c.id === 'ch028' ? 'Part V'
                                  : 'title'}
                              </span>
                            )}
                            {c.type === 'front-matter' && <span className="badge alt" aria-label="Front matter">intro</span>}
                            {fmt(c.duration)}
                            {completed ? (
                              <span className="chapter-progress complete" aria-label="Completed">✓</span>
                            ) : chapterPercentage > 0 ? (
                              <span className="chapter-progress" aria-label={`${chapterPercentage}% complete`}>
                                {chapterPercentage}%
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </nav>
            </>
          )}
        </aside>
        {/* UX-01: mobile backdrop. Tapping outside the sidebar closes the drawer. */}
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
        <main className="reader" id="main-reader">
          {/* The boundary replaces this whole fragment on synchronous errors.
              App renders async failures here too; both use the same retry. */}
          <ErrorBoundary key={readerKey} onRetry={retryReader}>
            <>
              <foliate-view ref={viewCallbackRef} class="foliate-view" />
              {readerState.status === 'loading' && (
                <div className="reader-state" role="status" aria-live="polite">
                  Loading reader…
                </div>
              )}
              {readerState.status === 'error' && (
                <div className="reader-state" role="alert">
                  <div className="reader-state-message">Couldn't load the reader.</div>
                  <div className="reader-state-detail">{readerState.error}</div>
                  <button className="reader-state-retry" onClick={retryReader}>Retry</button>
                </div>
              )}
            </>
          </ErrorBoundary>
        </main>
      </div>

      {/* UX-03: mobile accordion seek panel. Opens above the player and spans the full width for easy scrubbing. */}
      <div className={`seek-accordion ${seekExpanded ? 'open' : ''}`} id="seek-panel">
        <div className="seek-accordion-inner">
          <div className="seek-accordion-header">
            <span className="seek-accordion-time">{fmt(currentTime)}</span>
            <button
              className="icon-btn seek-collapse"
              onClick={() => setSeekExpanded(false)}
              aria-label="Collapse seek slider"
              aria-expanded={seekExpanded}
              aria-controls="seek-panel"
            >
              <IconChevron direction="down" />
            </button>
            <span className="seek-accordion-time">{fmt(duration)}</span>
          </div>
          {seekSlider}
        </div>
      </div>

      <footer className="player">
        <div className="player-top">
          <div className="player-chapter">
            <button className="icon-btn" onClick={() => { setSidebarOpen(!sidebarOpen || !showSettings); setShowSettings(true) }} aria-label="Settings" aria-expanded={showSettings && sidebarOpen} aria-controls="settings-panel" title="Settings"><IconSettings /></button>
            <div className="player-chapter-title">{chapter?.title}</div>
            <div className="player-time">{fmt(currentTime)} / {fmt(duration)}</div>
          </div>
          <div className="player-controls">
            <button className="icon-btn" onClick={prev} aria-label="Previous chapter"><IconPrev /></button>
            <button className="icon-btn seek-step" onClick={() => seekBy(-15)} aria-label="Back 15 seconds"><span aria-hidden="true">−15</span></button>
            <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'} aria-pressed={isPlaying}>
              {isPlaying ? <IconPause /> : <IconPlay />}
            </button>
            <button className="icon-btn seek-step" onClick={() => seekBy(15)} aria-label="Forward 15 seconds"><span aria-hidden="true">+15</span></button>
            <button className="icon-btn" onClick={next} aria-label="Next chapter"><IconNext /></button>
          </div>
        </div>
        <div className="seek-desktop">{seekSlider}</div>
        <button
          className="seek-toggle mobile-only"
          onClick={() => setSeekExpanded(true)}
          aria-expanded={seekExpanded}
          aria-controls="seek-panel"
          aria-label="Open seek slider"
        >
          <IconChevron direction="up" />
          <span className="seek-toggle-time">{fmt(currentTime)} / {fmt(duration)}</span>
        </button>
      </footer>

      <audio
        ref={audioRef}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMeta}
        onEnded={onEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          // Skip: the audio briefly fires pause at the end of a chapter
          // (before the ended event). We're about to auto-advance.
          if (advancingRef.current) { advancingRef.current = false; return }
          setIsPlaying(false)
        }}
        aria-hidden="true"
      />

      {updateAvailable && (
        <div className="sw-update-toast" role="alert" aria-live="polite">
          <span>A new version is available.</span>
          <button
            className="sw-update-btn"
            onClick={() => { if (swUpdateRef.current) swUpdateRef.current() }}
          >Reload</button>
          <button
            className="sw-update-dismiss"
            onClick={() => setUpdateAvailable(false)}
            aria-label="Dismiss update notice"
          >Later</button>
        </div>
      )}

      </div>
  )
}
