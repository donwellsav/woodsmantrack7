// Shared reader-preferences data: fonts, load/validate helpers.
//
// CQ-20: extracted from App.jsx so SettingsPanel can live in its own file
// without a circular import. App.jsx imports FONTS for readerCss();
// SettingsPanel.jsx imports FONTS for the font picker.

export const FONTS = {
  literata: {
    label: 'Literata',
    css: '"Literata", serif',
    note: 'Long-form screen serif',
  },
  lexend: {
    label: 'Lexend',
    css: '"Lexend", sans-serif',
    note: 'Optimized for reading speed',
  },
  atkinson: {
    label: 'Atkinson Hyperlegible',
    css: '"Atkinson Hyperlegible", sans-serif',
    note: 'High-legibility (Braille Institute)',
  },
  opendyslexic: {
    label: 'OpenDyslexic',
    css: '"OpenDyslexic", serif',
    note: 'Dyslexia-friendly',
  },
  merriweather: {
    label: 'Merriweather',
    css: '"Merriweather", serif',
    note: 'Friendly screen serif',
  },
  noto: {
    label: 'Noto Serif',
    css: '"Noto Serif", serif',
    note: 'Neutral multilingual serif',
  },
}

const LEGACY_FONTS = { iowan: 'literata', georgia: 'merriweather', serif: 'noto' }

export const FLOW_OPTS = [
  { id: 'scrolled', label: 'Scroll', note: 'Continuous, smooth' },
  { id: 'manual', label: 'Manual', note: 'No auto-scroll' },
]

// CQ-6: validate prefs from localStorage. Defaults are tuned for a comfortable
// book-reading experience on both light and dark themes.
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('woodsman-prefs-v1') || '{}')
    const font = LEGACY_FONTS[p.font] || p.font
    return {
      font: FONTS[font] ? font : 'noto',
      size: typeof p.size === 'number' && p.size >= 12 && p.size <= 40 ? p.size : 19,
      flow: FLOW_OPTS.some(({ id }) => id === p.flow) ? p.flow : 'scrolled',
      lineHeight: typeof p.lineHeight === 'number' && p.lineHeight >= 1.3 && p.lineHeight <= 2.2 ? p.lineHeight : 1.7,
      clickToSeek: p.clickToSeek === true,
      playbackRate: typeof p.playbackRate === 'number' && p.playbackRate >= 0.75 && p.playbackRate <= 2 ? p.playbackRate : 1,
    }
  } catch {
    return { font: 'noto', size: 19, flow: 'scrolled', lineHeight: 1.7, clickToSeek: false, playbackRate: 1 }
  }
}
