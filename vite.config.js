import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import fs from 'node:fs'

// The audio + the upstream DOCX live one level up; in dev we serve them at /audio
// so the app can stream chapter MP3s without copying 1GB into the project.
const AUDIO_DIR = path.resolve(__dirname, '..', 'ElevenLabs_woodsman_track_seven_6x9_kdp_v2_with_toc_docx')

function serveAudio() {
  return {
    name: 'serve-audio',
    configureServer(server) {
      server.middlewares.use('/audio', (req, res, next) => {
        // decode + sanitize the requested path
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const filePath = path.join(AUDIO_DIR, rel)
        if (!filePath.startsWith(AUDIO_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          return next()
        }
        const stat = fs.statSync(filePath)
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Length', stat.size)
        fs.createReadStream(filePath).pipe(res)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use('/audio', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const filePath = path.join(AUDIO_DIR, rel)
        if (!filePath.startsWith(AUDIO_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          return next()
        }
        const stat = fs.statSync(filePath)
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Length', stat.size)
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    serveAudio(),
    VitePWA({
      registerType: 'autoUpdate',
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
      // Audio is large and lives outside the project; cache it lazily at runtime.
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/audio/'),
            handler: 'CacheFirst',
            options: { cacheName: 'audio-cache', expiration: { maxEntries: 100 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.epub'),
            handler: 'CacheFirst',
            options: { cacheName: 'book-cache' },
          },
        ],
      },
    }),
  ],
})
