import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import fs from 'node:fs'

// The audio + the upstream DOCX live one level up; in dev we serve them at /audio
// so the app can stream chapter MP3s without copying 1GB into the project.
// Override with `WOODS_AUDIO_DIR=/path/to/mp3s npm run dev` to point at a
// different folder without editing this file.
const AUDIO_DIR = process.env.WOODS_AUDIO_DIR
  ? path.resolve(process.env.WOODS_AUDIO_DIR)
  : path.resolve(__dirname, '..', 'ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx')

// Parse a Range: bytes=START-END header. Returns { start, end } inclusive, or
// null if the header is absent or malformed.
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  let start = m[1] === '' ? null : Number(m[1])
  let end = m[2] === '' ? null : Number(m[2])
  if (start === null && end === null) return null
  if (start === null) { start = size - end; end = size - 1 }
  if (end === null) { end = size - 1 }
  if (isNaN(start) || isNaN(end) || start < 0 || end >= size || start > end) return null
  return { start, end }
}

// Resolves `rel` inside AUDIO_DIR, refusing path-traversal AND symlink escape.
// Returns the absolute path + stat, or null if the request should fall through.
function resolveAudioPath(rel) {
  const filePath = path.join(AUDIO_DIR, rel)
  // Path-traversal: reject anything that escapes AUDIO_DIR by string match.
  if (!filePath.startsWith(AUDIO_DIR + path.sep) && filePath !== AUDIO_DIR) return null
  let stat
  try { stat = fs.statSync(filePath) } catch { return null }
  if (stat.isDirectory()) return null
  // Symlink-prefix: resolve realpath and re-check the resolved path lives in AUDIO_DIR.
  // (The string-match check above can be fooled by a symlink that points outside.)
  const real = fs.realpathSync(filePath)
  if (!real.startsWith(AUDIO_DIR + path.sep) && real !== AUDIO_DIR) return null
  return { filePath, stat }
}

// Streams an MP3 (or 206-partial) with optional Range support.
function serveAudioFile(req, res, next) {
  const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
  const resolved = resolveAudioPath(rel)
  if (!resolved) return next()
  const { filePath, stat } = resolved
  const range = parseRange(req.headers.range, stat.size)
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Accept-Ranges', 'bytes')
  if (range) {
    const len = range.end - range.start + 1
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
    res.setHeader('Content-Length', len)
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
  } else {
    res.setHeader('Content-Length', stat.size)
    fs.createReadStream(filePath).pipe(res)
  }
}

function serveAudio() {
  return {
    name: 'serve-audio',
    configureServer(server) {
      server.middlewares.use('/audio', serveAudioFile)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/audio', serveAudioFile)
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    serveAudio(),
    VitePWA({
      // PERF-7: prompt instead of autoUpdate. Audiobook users leave the tab
      // open for hours; autoUpdate + skipWaiting + clientsClaim would silently
      // take over mid-session and break in-memory refs (timingsCache,
      // textMapRef, cfiMapRef). With `prompt`, the new SW waits for the user
      // to acknowledge a "new version available" toast before activating —
      // they can pick a natural break (chapter end) to reload.
      registerType: 'prompt',
      includeAssets: ['book.epub', 'chapters.json'],
      manifest: {
        name: 'Woodsman: Track Seven',
        short_name: 'Track Seven',
        description: 'Synced audiobook + ebook reader',
        display: 'standalone',
        background_color: '#1a1625',
        theme_color: '#1a1625',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Audio + EPUB caching.
      //
      // PERF-3: Workbox's CacheFirst handler does NOT slice Range requests out
      // of a cached 200 OK response — it returns the whole body. For audio
      // (where browsers issue Range to seek), that means seeking near the end
      // of an unplayed chapter forces a full ~30 MB download before the seek
      // resolves. To keep HTTP Range + byte serving working in production, we
      // EXCLUDE /audio/* from service-worker caching and rely on the browser's
      // native HTTP cache + the CDN's Range support. Audio still works
      // offline IF the chapter has been played end-to-end (HTTP cache), but
      // seeking beyond the cached range will hit the network.
      //
      // PERF-16: the previous runtimeCaching rule for *.epub was dead code —
      // book.epub is already in `includeAssets` above and therefore precached.
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // No runtimeCaching — audio is served via native HTTP cache + Range,
        // EPUB is precached. Adjust here if you want a more aggressive audio
        // cache (e.g. workbox-range-requests plugin) at the cost of seek bugs.
      },
    }),
  ],
})
