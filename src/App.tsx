import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { beginLogin as sakrylleBeginLogin, getStoredToken as sakrylleGetStoredToken } from './lib/sakrylleAuth'
import { applyThemeClass, readStoredTheme } from './lib/theme'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

const SAKRYLLE_FIRST_VISIT_KEY = 'sakrylle-image-playground.first-visit-prompted'

export default function App() {
  const { t } = useTranslation()
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const appMode = useStore((s) => s.appMode)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const err = (window as any).__oauthCallbackError
    if (err) {
      delete (window as any).__oauthCallbackError
      useStore.getState().showToast(String(err), 'error')
    }
  }, [])

  useEffect(() => {
    applyThemeClass(readStoredTheme())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.pathname.startsWith('/oauth/callback')) return
    if (sakrylleGetStoredToken()) return

    let prompted = false
    try {
      prompted = window.localStorage.getItem(SAKRYLLE_FIRST_VISIT_KEY) === '1'
    } catch {
      prompted = false
    }
    if (prompted) return

    try {
      window.localStorage.setItem(SAKRYLLE_FIRST_VISIT_KEY, '1')
    } catch {
      // ignore
    }

    setConfirmDialog({
      title: t('welcome.title'),
      message: t('welcome.message'),
      icon: 'info',
      buttons: [
        {
          label: t('welcome.skip'),
          tone: 'secondary',
          action: () => {},
        },
        {
          label: t('welcome.login'),
          tone: 'primary',
          action: () => {
            void sakrylleBeginLogin()
          },
        },
      ],
    })
  }, [setConfirmDialog, t])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
