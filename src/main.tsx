import 'core-js/actual/array/at'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'streamdown/styles.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { handleCallback } from './lib/sakrylleAuth'

installMobileViewportGuards()

if (typeof window !== 'undefined' && window.location.pathname === '/oauth/callback') {
  const search = new URLSearchParams(window.location.search)
  handleCallback(search)
    .catch((err) => {
      console.error('OAuth callback failed', err)
    })
    .finally(() => {
      window.history.replaceState({}, '', '/')
    })
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
