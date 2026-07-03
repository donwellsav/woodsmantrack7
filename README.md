# Woodsman: Track Seven — Synced Audiobook + Ebook PWA

A Progressive Web App that plays an audiobook in sync with the ebook text,
highlighting each word in the reader as the narration reaches it.

## What it does

- **EPUB reader** (foliate-js) renders the book text, paginated per chapter.
- **Audio player** streams the per-chapter MP3s with play/pause, seek, prev/next.
- **Chapter sync** — selecting a chapter jumps both the reader and the audio.
- **Word-level sync** — as the narration plays, the currently-spoken word is
  highlighted and scrolled into view in the reader (~99.7% word match rate).
- **Media Session API** — lock-screen / media-key controls + chapter metadata.
- **PWA** — installable, offline-capable (book, timings, and visited audio cached).

## Source assets

The project consumes two sibling assets produced outside the app:

- `../woodsman_track_seven_6x9_kdp_v2_with_toc.docx` — the source manuscript
  (converted to `epub/book.epub` via pandoc; see `scripts/`).
- `../ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx/` — 33 chapter
  MP3s (~10 hours of TTS narration).

In **dev** the audio is streamed from that folder via a Vite middleware at
`/audio/*` (no 1GB copy). In **production** host the MP3s at the same `/audio/`
path (CDN/static host) — they are deliberately excluded from the build.

## Pipeline (how the sync data was produced)

1. **`scripts/extract_text.py`** — pulls per-chapter plain text out of the EPUB
   into `data/text/<id>.txt`.
2. **`scripts/align.py`** — force-aligns each chapter's text against its MP3 with
   [stable-ts](https://github.com/jianfch/stable-ts) (Whisper), writing word +
   segment timestamps to `data/timings/<id>.json`. Output is copied to
   `public/timings/` for the browser to fetch on demand.
3. **`scripts/build_manifest.py`** — maps EPUB chapters → MP3 files + durations
   into `data/chapters.json` (copied to `public/chapters.json`).

Regenerate with a Python venv:

```bash
source .venv/bin/activate
pip install stable-ts
python3 scripts/extract_text.py
python3 scripts/align.py        # ~4 min for the whole book on Apple Silicon
cp data/timings/*.json public/timings/
```

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
npm run preview  # serve the production build
```

## Architecture notes (non-obvious decisions)

- **foliate-js is vendored** into `public/foliate-js/` (incl. `vendor/`) and
  loaded as a native `<script type=module>` so its dynamic imports resolve.
  Loading it via a Vite `import()` from `public/` is blocked by Vite.
- **`<foliate-view>` uses a callback ref**, not `useRef`, because React attaches
  the ref before the custom element is upgraded, and the open flow must run
  after the element exists. A `__openStarted` guard prevents double-open under
  StrictMode.
- **Chapter navigation uses EPUB CFIs, not hrefs.** Pandoc EPUB section hrefs
  resolve to `null` inside foliate, so a `chapter id → CFI` map is built from
  `book.sections` (by index: 0=title, 1=nav, 2=ch001, 3=ch002=The Door…).
- **`buildTextMap` inserts a space between adjacent text nodes** whose junction
  would otherwise merge two words (e.g. `"Door"+"The"` → `"DoorThe"`). Without
  this, the word matcher fails on every word that crosses a DOM boundary.
- **`findWordInText` is a manual char scan**, not a `g`-flag regex, because
  repeated `exec` on a hoisted regex literal shares `lastIndex` across calls and
  corrupts the scan position.
- **`timingsRef` mirrors the `timings` state** so event handlers attached once
  (relocate, timeupdate) always read the latest timings instead of the closure
  captured at first render.
- **5 "title-only" chapters** (audio ≈2.5s = just the spoken title, no body
  narration) and the front-matter intro are flagged in the manifest and skipped
  by the aligner; the UI badges them.

## Known limitations

- Word highlight uses `Range.surroundContents`, which silently no-ops on words
  that span an element boundary (rare). The reader still tracks position via the
  chapter; only the per-word mark is skipped in those cases.
- iOS background playback is not supported (WebKit suspends PWA audio). This is a
  pure PWA by design; wrap with Capacitor if iOS background audio is required.
