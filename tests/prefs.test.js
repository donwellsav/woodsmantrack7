import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPrefs } from '../src/prefs.js'

function store(prefs) {
  globalThis.localStorage = {
    getItem(key) {
      assert.equal(key, 'woodsman-prefs-v1')
      return JSON.stringify(prefs)
    },
  }
}

test.afterEach(() => { delete globalThis.localStorage })

test('loadPrefs preserves persisted Manual flow', () => {
  store({ flow: 'manual' })

  assert.equal(loadPrefs().flow, 'manual')
})

test('loadPrefs retires persisted Page flow to Scroll', () => {
  store({ flow: 'paginated' })

  assert.equal(loadPrefs().flow, 'scrolled')
})

test('loadPrefs accepts playback rates from 0.75x through 2x', () => {
  for (const playbackRate of [0.75, 1, 1.5, 2]) {
    store({ playbackRate })
    assert.equal(loadPrefs().playbackRate, playbackRate)
  }
})

test('loadPrefs defaults invalid playback rates to 1x', () => {
  for (const playbackRate of [0.5, 2.01, '1.5', null]) {
    store({ playbackRate })
    assert.equal(loadPrefs().playbackRate, 1)
  }
})
