// CQ-20: extracted from App.jsx so App.jsx can shrink below 800 lines and
// SettingsPanel can be reviewed independently. Renders inline in the sidebar
// (replaces the chapter list when the gear is active) — no modal/overlay.
import { FONTS, FLOW_OPTS } from './prefs.js'

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

export default function SettingsPanel({ theme, setTheme, prefs, setPrefs }) {
  const fontEntries = Object.entries(FONTS)
  const flowEntries = FLOW_OPTS
  return (
    // A11Y-04: id matches the gear's aria-controls; role=region + aria-labelledby
    // give the panel a landmark AT can find.
    <div className="settings-panel" id="settings-panel" role="region" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="visually-hidden">Reading settings</h2>
      <div className="settings-group">
        <label className="settings-label">Theme</label>
        <div className="option-row">
          <button
            className={`option-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => setTheme('dark')}
            aria-pressed={theme === 'dark'}
          >Dark</button>
          <button
            className={`option-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => setTheme('light')}
            aria-pressed={theme === 'light'}
          >Light</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Font</label>
        <div className="font-list">
          {fontEntries.map(([id, f]) => (
            <button
              key={id}
              className={`font-item ${prefs.font === id ? 'active' : ''}`}
              onClick={() => setPrefs(p => ({ ...p, font: id }))}
              aria-pressed={prefs.font === id}
              title={f.note}
            >
              <span className="font-sample" style={{ fontFamily: f.css }}>Aa</span>
              <span className="font-name" style={{ fontFamily: f.css }}>{f.label}</span>
              <span className="font-note">{f.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Size</label>
        <div className="size-row">
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, size: Math.max(12, p.size - 1) }))} aria-label="Decrease text size">−</button>
          <div className="size-value">{prefs.size} px</div>
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, size: Math.min(40, p.size + 1) }))} aria-label="Increase text size">+</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Spacing</label>
        <div className="size-row">
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.max(1.3, Math.round((p.lineHeight - 0.1) * 10) / 10) }))} aria-label="Decrease line spacing">−</button>
          <div className="size-value">{prefs.lineHeight.toFixed(1)}</div>
          <button className="size-btn" onClick={() => setPrefs(p => ({ ...p, lineHeight: Math.min(2.2, Math.round((p.lineHeight + 0.1) * 10) / 10) }))} aria-label="Increase line spacing">+</button>
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Layout</label>
        <div className="option-row">
          {flowEntries.map((f) => (
            <button
              key={f.id}
              className={`option-btn ${prefs.flow === f.id ? 'active' : ''}`}
              onClick={() => setPrefs(p => ({ ...p, flow: f.id }))}
              aria-pressed={prefs.flow === f.id}
            >{f.label}</button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <span className="settings-label">Playback speed</span>
        <div className="option-row playback-speed" role="group" aria-label="Playback speed">
          {PLAYBACK_RATES.map(rate => (
            <button
              key={rate}
              className={`option-btn ${prefs.playbackRate === rate ? 'active' : ''}`}
              onClick={() => setPrefs(p => ({ ...p, playbackRate: rate }))}
              aria-pressed={prefs.playbackRate === rate}
            >{rate}×</button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <label className="settings-label">Click to seek</label>
        <div className="option-row">
          <button
            className={`option-btn ${!prefs.clickToSeek ? 'active' : ''}`}
            onClick={() => setPrefs(p => ({ ...p, clickToSeek: false }))}
            aria-pressed={!prefs.clickToSeek}
          >Off</button>
          <button
            className={`option-btn ${prefs.clickToSeek ? 'active' : ''}`}
            onClick={() => setPrefs(p => ({ ...p, clickToSeek: true }))}
            aria-pressed={prefs.clickToSeek}
          >On</button>
        </div>
      </div>
    </div>
  )
}
