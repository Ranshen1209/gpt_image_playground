export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'sakrylle-image-playground.theme'

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark') return raw
  } catch {
    // ignore
  }
  return getSystemTheme()
}

export function persistTheme(theme: Theme) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}

export function applyThemeClass(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

interface SwitchOptions {
  origin?: { x: number, y: number }
}

let activeThemeOverlay: HTMLElement | null = null

function getThemeOverlayStyle() {
  const body = document.body
  const bodyStyle = window.getComputedStyle(body)
  const ambientStyle = window.getComputedStyle(body, '::before')

  return {
    backgroundColor: bodyStyle.backgroundColor || 'transparent',
    backgroundImage: ambientStyle.backgroundImage === 'none' ? '' : ambientStyle.backgroundImage,
  }
}

export function switchTheme(next: Theme, options: SwitchOptions = {}) {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  const { x, y } = options.origin ?? {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }
  root.style.setProperty('--theme-switch-x', `${x}px`)
  root.style.setProperty('--theme-switch-y', `${y}px`)

  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const apply = () => {
    applyThemeClass(next)
    persistTheme(next)
  }

  if (reduceMotion) {
    apply()
    return
  }

  activeThemeOverlay?.remove()
  const overlayStyle = getThemeOverlayStyle()
  apply()

  const overlay = document.createElement('div')
  overlay.className = 'theme-switch-overlay'
  overlay.style.backgroundColor = overlayStyle.backgroundColor
  if (overlayStyle.backgroundImage) {
    overlay.style.backgroundImage = overlayStyle.backgroundImage
  }
  document.body.appendChild(overlay)
  activeThemeOverlay = overlay

  const cleanup = () => {
    if (activeThemeOverlay === overlay) {
      activeThemeOverlay = null
    }
    overlay.remove()
  }
  overlay.addEventListener('animationend', cleanup, { once: true })
  window.setTimeout(cleanup, 2600)
}
