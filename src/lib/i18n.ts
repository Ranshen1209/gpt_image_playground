import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '../locales/zh.json'
import en from '../locales/en.json'
import { applyLanguage, persistLanguage, readStoredLanguage, type Language } from './language'

const initialLanguage = readStoredLanguage()

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    lng: initialLanguage,
    fallbackLng: 'zh',
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  })

applyLanguage(initialLanguage)

i18n.on('languageChanged', (lng) => {
  const next: Language = lng === 'en' ? 'en' : 'zh'
  applyLanguage(next)
  persistLanguage(next)
})

export default i18n
