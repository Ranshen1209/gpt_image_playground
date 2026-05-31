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

let activeThemeSnapshot: HTMLIFrameElement | null = null

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getSnapshotStyles(): string {
  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        css += `${rule.cssText}\n`
      }
    } catch {
      // Cross-origin stylesheets are ignored; the main app CSS is same-origin.
    }
  }
  return css
}

function getSnapshotBodyHtml(): string {
  const clone = document.body.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.theme-switch-snapshot, script').forEach((node) => node.remove())
  return clone.innerHTML
}

function createThemeSnapshotFrame() {
  const iframe = document.createElement('iframe')
  iframe.className = 'theme-switch-snapshot'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.style.colorScheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'

  const htmlClass = escapeHtmlAttribute(document.documentElement.className)
  const lang = escapeHtmlAttribute(document.documentElement.lang)
  const bodyClass = escapeHtmlAttribute(document.body.className)
  const styles = getSnapshotStyles()
  const bodyHtml = getSnapshotBodyHtml()

  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) return iframe
  doc.open()
  doc.write(`<!doctype html>
<html class="${htmlClass}" lang="${lang}">
<head>
<base href="${escapeHtmlAttribute(document.baseURI)}">
<style>${styles}</style>
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden !important; pointer-events: none !important; }
  body { min-height: 100%; }
  *, *::before, *::after { caret-color: transparent !important; }
</style>
</head>
<body class="${bodyClass}">${bodyHtml}</body>
</html>`)
  doc.close()
  return iframe
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

  activeThemeSnapshot?.remove()
  const snapshot = createThemeSnapshotFrame()
  apply()
  activeThemeSnapshot = snapshot

  const cleanup = () => {
    if (activeThemeSnapshot === snapshot) {
      activeThemeSnapshot = null
    }
    snapshot.remove()
  }
  snapshot.addEventListener('animationend', cleanup, { once: true })
  window.setTimeout(cleanup, 1100)
}
