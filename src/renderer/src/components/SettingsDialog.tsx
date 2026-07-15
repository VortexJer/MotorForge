import { ACCENT_PRESETS } from '../lib/theme'
import type { ThemeSettings } from '../lib/theme'

/**
 * Ajustes de aplicación: tema oscuro/claro y color de acento (presets o
 * cualquier color con el selector nativo). Los cambios se aplican en vivo.
 */

interface Props {
  theme: ThemeSettings
  onChange: (t: ThemeSettings) => void
  onClose: () => void
}

export default function SettingsDialog({ theme, onChange, onClose }: Props): React.JSX.Element {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Ajustes">
      <div className="modal settings-modal">
        <header className="modal-head">
          <h2>Ajustes</h2>
          <span className="modal-file">apariencia de la aplicación</span>
        </header>

        <div className="modal-body settings-body">
          <h3 className="section-title">Tema</h3>
          <div className="segmented" role="group" aria-label="Tema">
            <button
              type="button"
              className={theme.mode === 'dark' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => onChange({ ...theme, mode: 'dark' })}
            >
              Oscuro
            </button>
            <button
              type="button"
              className={theme.mode === 'light' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => onChange({ ...theme, mode: 'light' })}
            >
              Claro
            </button>
          </div>

          <h3 className="section-title settings-gap">Color de acento</h3>
          <div className="swatch-grid" role="group" aria-label="Color de acento">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.name}
                className={`swatch-btn ${theme.accent.toLowerCase() === p.color ? 'active' : ''}`}
                style={{ background: p.color }}
                onClick={() => onChange({ ...theme, accent: p.color })}
                aria-label={p.name}
              />
            ))}
            <label className="swatch-custom" title="Color personalizado">
              <input
                type="color"
                value={theme.accent}
                onChange={(e) => onChange({ ...theme, accent: e.target.value })}
                aria-label="Color personalizado"
              />
              <span>+</span>
            </label>
          </div>
          <p className="settings-hint">
            El acento colorea controles, curvas de potencia, mapas ECU y la aguja del tacómetro.
            El laboratorio físico mantiene la celda oscura en ambos temas.
          </p>
        </div>

        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Hecho
          </button>
        </footer>
      </div>
    </div>
  )
}
