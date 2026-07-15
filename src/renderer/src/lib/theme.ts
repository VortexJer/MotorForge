/**
 * Temas de la aplicación: modo oscuro/claro + color de acento configurable.
 * El acento por defecto es rojo competición; el usuario puede elegir un
 * preset o cualquier color con el selector nativo. Persistido en
 * localStorage y aplicado como variables CSS sobre :root.
 */

export type ThemeMode = 'dark' | 'light'

export interface ThemeSettings {
  mode: ThemeMode
  accent: string // hex
}

export const DEFAULT_THEME: ThemeSettings = { mode: 'dark', accent: '#e10600' }

export const ACCENT_PRESETS: Array<{ id: string; color: string; name: string }> = [
  { id: 'rojo', color: '#e10600', name: 'Rojo competición' },
  { id: 'naranja', color: '#ff6b1a', name: 'Naranja' },
  { id: 'ambar', color: '#f5b942', name: 'Ámbar' },
  { id: 'verde', color: '#2fbf71', name: 'Verde' },
  { id: 'cian', color: '#1fb6cf', name: 'Cian' },
  { id: 'azul', color: '#3987e5', name: 'Azul' },
  { id: 'violeta', color: '#8b5cf6', name: 'Violeta' },
  { id: 'magenta', color: '#e6399b', name: 'Magenta' }
]

const STORAGE_KEY = 'motorforge-theme'

export function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>
    return {
      mode: parsed.mode === 'light' ? 'light' : 'dark',
      accent: typeof parsed.accent === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.accent)
        ? parsed.accent
        : DEFAULT_THEME.accent
    }
  } catch {
    return DEFAULT_THEME
  }
}

export function saveTheme(t: ThemeSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
}

/** Aplica el tema al documento: atributo data-theme + variable --accent. */
export function applyTheme(t: ThemeSettings): void {
  const root = document.documentElement
  root.dataset['theme'] = t.mode
  root.style.setProperty('--accent', t.accent)
}
