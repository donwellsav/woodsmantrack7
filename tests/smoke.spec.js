import { expect, test } from '@playwright/test'

const FIRST_CHAPTER_TEXT = 'The Landmark always looked the most honest after midnight.'

function makeSilentWav(seconds = 60) {
  const sampleRate = 8000
  const dataSize = sampleRate * seconds
  const wav = Buffer.alloc(44 + dataSize, 128)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate, 28)
  wav.writeUInt16LE(1, 32)
  wav.writeUInt16LE(8, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  return wav
}

async function routeGeneratedAudio(page, seconds = 60) {
  const wav = makeSilentWav(seconds)
  await page.route('http://localhost:4173/audio/**', route => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '')
    const start = range ? Number(range[1]) : 0
    const end = Math.min(range?.[2] ? Number(range[2]) : wav.length - 1, wav.length - 1)
    const body = wav.subarray(start, end + 1)
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(body.length),
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${wav.length}` }),
      },
      body,
    })
  })
}

async function renderedReaderText(page) {
  return page.locator('foliate-view').evaluate(view =>
    (view.renderer?.getContents?.() ?? [])
      .map(({ doc }) => doc?.body?.innerText ?? '')
      .join('\n'))
}

async function readerIsReady(page) {
  return page.locator('foliate-view').evaluate(view => {
    try {
      return Boolean(view.book && view.renderer?.getContents?.().length)
    } catch {
      return false
    }
  })
}

async function rendererFlow(page) {
  return page.locator('foliate-view').evaluate(view =>
    view.renderer?.getAttribute?.('flow') ?? null)
}

async function openSettings(page) {
  const button = page.getByRole('button', { name: 'Settings' })
  await button.click()
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
  await expect(page.getByRole('region', { name: 'Reading settings' })).toBeVisible()
}

test.describe('reader lifecycle', () => {
  test('selecting The Door keeps its real text and player controls visible', async ({ page }) => {
    let releaseEpub
    const epubGate = new Promise(resolve => { releaseEpub = resolve })
    await page.route('**/book.epub', async route => {
      await epubGate
      await route.continue()
    })
    await page.goto('/')

    const reader = page.locator('#main-reader')
    await expect(reader.getByRole('status')).toHaveText('Loading reader…')
    releaseEpub()
    await expect.poll(() => readerIsReady(page)).toBe(true)
    await expect(reader.getByRole('status')).toHaveCount(0)
    await page.getByRole('button', { name: /^The Door/ }).click()

    await expect.poll(() => renderedReaderText(page)).toContain(FIRST_CHAPTER_TEXT)
    await expect(page.getByRole('button', { name: 'Previous chapter' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next chapter' })).toBeVisible()
  })

  test('a failed EPUB request retries with a fresh reader and reaches ready', async ({ page }) => {
    let epubRequests = 0
    await page.route('**/book.epub', async route => {
      epubRequests += 1
      if (epubRequests === 1) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' })
      } else {
        await route.continue()
      }
    })

    await page.goto('/')

    const reader = page.locator('#main-reader')
    const error = reader.getByRole('alert')
    await expect(error).toBeVisible()
    await expect(error).toContainText('503')
    const failedView = await reader.locator('foliate-view').elementHandle()

    await reader.getByRole('button', { name: 'Retry' }).click()

    await expect.poll(() => readerIsReady(page)).toBe(true)
    await expect(error).toHaveCount(0)
    const readyView = await reader.locator('foliate-view').elementHandle()
    expect(await readyView.evaluate((view, previousView) => view !== previousView, failedView)).toBe(true)
    expect(epubRequests).toBe(2)
  })
})

test.describe('preferences', () => {
  test('Manual persists while Foliate stays in scrolled flow', async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => readerIsReady(page)).toBe(true)
    await openSettings(page)

    const manual = page.getByRole('button', { name: 'Manual' })
    await manual.click()
    await expect(manual).toHaveAttribute('aria-pressed', 'true')

    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem('woodsman-prefs-v1')).flow)).toBe('manual')
    await expect.poll(() => rendererFlow(page)).toBe('scrolled')

    await page.reload()
    await expect.poll(() => readerIsReady(page)).toBe(true)
    await expect.poll(() => rendererFlow(page)).toBe('scrolled')
    await openSettings(page)
    await expect(manual).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('woodsman-prefs-v1')).flow)).toBe('manual')
  })

  test('settings omit the false offline audio control', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)

    const settings = page.getByRole('region', { name: 'Reading settings' })
    await expect(settings.getByText(/offline/i)).toHaveCount(0)
    await expect(settings.getByRole('button', { name: /download.*audio/i })).toHaveCount(0)
  })
})

test.describe('navigation accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('mobile closed drawer is hidden and excluded from focus', async ({ page }) => {
    await page.goto('/')

    const drawer = page.locator('aside.sidebar')
    await expect(drawer).toHaveClass(/\bclosed\b/)
    await expect(drawer).toHaveAttribute('inert', '')
    await expect(drawer).toHaveAttribute('aria-hidden', 'true')

    const door = drawer.locator('button.chapter-item').filter({ hasText: 'The Door' })
    await door.evaluate(button => button.focus())
    expect(await drawer.evaluate(aside => aside.contains(document.activeElement))).toBe(false)
  })
})

test.describe('paginated reading', () => {
  test('Page mode advances when audio crosses the current page boundary', async ({ page }) => {
    await routeGeneratedAudio(page, 1200)
    await page.goto('/')
    await expect.poll(() => readerIsReady(page)).toBe(true)
    await page.getByRole('button', { name: /^The Door/ }).click()
    await expect.poll(() => renderedReaderText(page)).toContain(FIRST_CHAPTER_TEXT)

    await openSettings(page)
    await page.getByRole('button', { name: 'Page' }).click()
    await expect.poll(() => rendererFlow(page)).toBe('paginated')

    const pastChapterBoundary = await page.evaluate(async () => {
      const { words } = await fetch('/timings/ch002.json').then(response => response.json())
      return words.at(-1).end + 0.01
    })
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.duration))
      .toBeGreaterThan(pastChapterBoundary)

    await page.locator('foliate-view').evaluate(view => {
      const renderer = view.renderer
      const next = renderer.next
      window.__pageTurnCalls = 0
      renderer.next = function (...args) {
        window.__pageTurnCalls += 1
        return next.apply(this, args)
      }
    })

    await expect.poll(async () => {
      return page.locator('audio').evaluate((audio, target) => {
        audio.currentTime = target
        audio.dispatchEvent(new Event('timeupdate'))
        return window.__pageTurnCalls
      }, pastChapterBoundary)
    }).toBeGreaterThan(0)
  })
})

test.describe('reading progress', () => {
  test('reading progress stays legible when switching chapters before metadata', async ({ page }) => {
    await routeGeneratedAudio(page)
    let releaseDoorAudio
    const doorAudioGate = new Promise(resolve => { releaseDoorAudio = resolve })
    await page.route(url => decodeURIComponent(url.pathname).endsWith('02_The Door.mp3'), async route => {
      await doorAudioGate
      await route.fallback()
    })

    await page.goto('/')
    await page.addInitScript(progress => {
      if (window.top === window) {
        localStorage.setItem('woodsman-progress-v1', JSON.stringify(progress))
      }
    }, {
      currentIndex: 1,
      currentTime: 754,
      chapters: {
        0: { seconds: 2.69, duration: 2.69, completed: true },
        1: { seconds: 754, duration: 950.69, completed: false },
      },
    })
    await page.reload()

    await expect(page.getByText('Continue from The Door · 12:34', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Introduction/ }).getByLabel('Completed')).toBeVisible()
    await expect(page.getByRole('button', { name: /^The Door/ }).getByLabel('79% complete')).toBeVisible()
    await expect(page.getByText('2% of book', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /^The Park/ }).click()
    releaseDoorAudio()
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('woodsman-progress-v1'))
      return { currentIndex: saved.currentIndex, doorSeconds: saved.chapters[1].seconds }
    })).toEqual({ currentIndex: 2, doorSeconds: 754 })
  })
})

test.describe('playback controls', () => {
  test.beforeEach(async ({ page }) => {
    await routeGeneratedAudio(page)
  })

  test('selecting The Door loads and plays its generated chapter audio', async ({ page }) => {
    await page.goto('/')

    const doorRequest = page.waitForRequest(request =>
      decodeURIComponent(new URL(request.url()).pathname) === '/audio/02_The Door.mp3')
    await page.getByRole('button', { name: /^The Door/ }).click()
    expect(decodeURIComponent(new URL((await doorRequest).url()).pathname))
      .toBe('/audio/02_The Door.mp3')

    await expect.poll(() => page.locator('audio').evaluate(audio => audio.readyState))
      .toBeGreaterThanOrEqual(1)
    await page.getByRole('button', { name: 'Play' }).click()
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime))
      .toBeGreaterThan(0.1)
  })

  test('playback controls persist speed and apply it immediately and on metadata', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)

    const speed = page.getByRole('group', { name: 'Playback speed' })
    await expect(speed.getByRole('button')).toHaveText([
      '0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×',
    ])

    const selectedRate = speed.getByRole('button', { name: '1.5×', exact: true })
    await selectedRate.click()
    await expect(selectedRate).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem('woodsman-prefs-v1')).playbackRate)).toBe(1.5)
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.playbackRate)).toBe(1.5)

    await page.locator('audio').evaluate(audio => {
      audio.playbackRate = 1
      audio.dispatchEvent(new Event('loadedmetadata'))
    })
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.playbackRate)).toBe(1.5)

    await page.reload()
    await openSettings(page)
    await expect(page.getByRole('group', { name: 'Playback speed' })
      .getByRole('button', { name: '1.5×', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.playbackRate)).toBe(1.5)
  })

  test('playback controls seek by 15 seconds without overflowing mobile', async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(1)

    const back = page.getByRole('button', { name: 'Back 15 seconds' })
    const forward = page.getByRole('button', { name: 'Forward 15 seconds' })
    const previous = page.getByRole('button', { name: 'Previous chapter' })
    const play = page.getByRole('button', { name: 'Play' })
    const next = page.getByRole('button', { name: 'Next chapter' })
    const controls = [previous, back, play, forward, next]
    await expect(back).toBeVisible()
    await expect(forward).toBeVisible()
    await expect(previous).toBeVisible()
    await expect(play).toBeVisible()
    await expect(next).toBeVisible()

    await page.locator('audio').evaluate(audio => { audio.currentTime = 30 })
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(30)
    await back.click()
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(15)
    await forward.click()
    await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(30)

    await page.setViewportSize({ width: 320, height: 640 })
    for (const control of controls) await expect(control).toBeVisible()
    const boxes = await Promise.all(controls.map(control => control.boundingBox()))
    const viewport = page.viewportSize()
    for (const box of boxes) {
      expect(box).not.toBeNull()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    }
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i - 1].x + boxes[i - 1].width).toBeLessThanOrEqual(boxes[i].x)
    }
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
