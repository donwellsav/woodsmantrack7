import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROGRESS_KEY,
  bookPercentage,
  parseProgress,
  updateProgress,
} from '../src/progress.js'

test('parseProgress accepts the legacy current chapter and time shape', () => {
  const progress = parseProgress(JSON.stringify({ currentIndex: 2, currentTime: 125 }))

  assert.equal(PROGRESS_KEY, 'woodsman-progress-v1')
  assert.deepEqual(progress, { currentIndex: 2, currentTime: 125, chapters: {} })
})

test('updateProgress marks a finished chapter complete', () => {
  const progress = updateProgress(null, {
    currentIndex: 1,
    currentTime: 90,
    duration: 90,
    completed: true,
  })

  assert.equal(progress.currentIndex, 1)
  assert.equal(progress.currentTime, 90)
  assert.deepEqual(progress.chapters[1], {
    seconds: 90,
    duration: 90,
    completed: true,
  })
})

test('bookPercentage weights progress by chapter duration', () => {
  let progress = updateProgress(null, {
    currentIndex: 0,
    currentTime: 100,
    duration: 100,
    completed: true,
  })
  progress = updateProgress(progress, {
    currentIndex: 1,
    currentTime: 100,
    duration: 300,
  })

  assert.equal(bookPercentage(progress, [{ duration: 100 }, { duration: 300 }]), 50)
})
