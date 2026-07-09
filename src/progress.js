export const PROGRESS_KEY = 'woodsman-progress-v1'

export function parseProgress(value) {
  try {
    const saved = typeof value === 'string' ? JSON.parse(value) : value
    if (!saved || typeof saved !== 'object') throw new TypeError('invalid progress')
    const progress = {
      currentIndex: Number.isInteger(saved.currentIndex) && saved.currentIndex >= 0 ? saved.currentIndex : 0,
      currentTime: Number.isFinite(saved.currentTime) && saved.currentTime >= 0 ? saved.currentTime : 0,
      chapters: saved.chapters && typeof saved.chapters === 'object' && !Array.isArray(saved.chapters) ? saved.chapters : {},
    }
    return progress
  } catch {
    return { currentIndex: 0, currentTime: 0, chapters: {} }
  }
}

export function updateProgress(value, update) {
  const progress = parseProgress(value)
  const currentIndex = Number.isInteger(update?.currentIndex) && update.currentIndex >= 0
    ? update.currentIndex
    : progress.currentIndex
  const previous = progress.chapters[currentIndex] || {}
  const duration = Number.isFinite(update?.duration) && update.duration > 0
    ? update.duration
    : Number.isFinite(previous.duration) && previous.duration > 0 ? previous.duration : 0
  const requestedTime = Number.isFinite(update?.currentTime) && update.currentTime >= 0 ? update.currentTime : 0
  const seconds = duration ? Math.min(requestedTime, duration) : requestedTime
  const completed = previous.completed === true || update?.completed === true || (duration > 0 && seconds >= duration)

  return {
    ...progress,
    currentIndex,
    currentTime: seconds,
    chapters: {
      ...progress.chapters,
      [currentIndex]: { seconds, duration, completed },
    },
  }
}

export function bookPercentage(value, chapters) {
  const progress = parseProgress(value)
  let total = 0
  let listened = 0

  for (let index = 0; index < chapters.length; index++) {
    const duration = chapters[index]?.duration
    if (!Number.isFinite(duration) || duration <= 0) continue
    const chapter = progress.chapters[index]
    const seconds = chapter?.completed === true
      ? duration
      : chapter?.seconds ?? (index === progress.currentIndex ? progress.currentTime : 0)
    total += duration
    listened += Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), duration) : 0
  }

  return total ? Math.round((listened / total) * 100) : 0
}
