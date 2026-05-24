export type Language = 'zh' | 'en'

const LANGUAGE_STORAGE_KEY = 'sakrylle-image-playground.language'

function detectBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'zh'
  const candidates: string[] = []
  if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
  if (typeof navigator.language === 'string') candidates.push(navigator.language)
  for (const tag of candidates) {
    if (typeof tag !== 'string') continue
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
    if (lower.startsWith('en')) return 'en'
  }
  // Sakrylle is positioned as a Chinese-first product (see CLAUDE.md).
  // Match i18n.ts fallbackLng so detector and i18next agree on locale.
  return 'zh'
}

export function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return 'zh'
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (raw === 'zh' || raw === 'en') return raw
  } catch {
    // ignore
  }
  return detectBrowserLanguage()
}

export function persistLanguage(language: Language) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // ignore
  }
}

export function applyLanguage(language: Language) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('lang', language === 'zh' ? 'zh-CN' : 'en')
}
