// Shared reader-preferences data: fonts, load/validate helpers.
//
// CQ-20: extracted from App.jsx so SettingsPanel can live in its own file
// without a circular import. App.jsx imports FONTS for readerCss();
// SettingsPanel.jsx imports FONTS for the font picker.

export const FONTS = {
  iowan: {
    label: 'Iowan Old Style',
    css: '"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Constantia, Georgia, serif',
    note: 'Classic book serif',
  },
  lexend: {
    label: 'Lexend',
    css: '"Lexend", "Iowan Old Style", Georgia, serif',
    note: 'Optimized for reading speed',
  },
  atkinson: {
    label: 'Atkinson Hyperlegible',
    css: '"Atkinson Hyperlegible", Verdana, sans-serif',
    note: 'High-legibility (Braille Institute)',
  },
  opendyslexic: {
    label: 'OpenDyslexic',
    css: '"OpenDyslexic", "Iowan Old Style", serif',
    note: 'Dyslexia-friendly',
  },
  georgia: {
    label: 'Georgia',
    css: 'Georgia, "Times New Roman", serif',
    note: 'Friendly system serif',
  },
  serif: {
    label: 'System serif',
    css: '"Times New Roman", Times, serif',
    note: 'Native only',
  },
}

export const FLOW_OPTS = [
  { id: 'scrolled', label: 'Scroll', note: 'Continuous, smooth' },
  { id: 'paginated', label: 'Page', note: 'One page at a time' },
  { id: 'manual', label: 'Manual', note: 'No auto-scroll' },
]

// CQ-6: validate prefs from localStorage. Defaults are tuned for a comfortable
// book-reading experience on both light and dark themes.
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('woodsman-prefs-v1') || '{}')
    return {
      font: FONTS[p.font] ? p.font : 'iowan',
      size: typeof p.size === 'number' && p.size >= 12 && p.size <= 40 ? p.size : 19,
      flow: p.flow === 'paginated' ? 'paginated' : 'scrolled',
      lineHeight: typeof p.lineHeight === 'number' && p.lineHeight >= 1.3 && p.lineHeight <= 2.2 ? p.lineHeight : 1.7,
      clickToSeek: p.clickToSeek === true,
    }
  } catch {
    return { font: 'iowan', size: 19, flow: 'scrolled', lineHeight: 1.7, clickToSeek: false }
  }
}
