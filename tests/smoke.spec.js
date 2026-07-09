import { expect, test } from '@playwright/test'

const FIRST_CHAPTER_TEXT = 'The Landmark always looked the most honest after midnight.'

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
