import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { removeMultipleTasks, useStore } from '../store'
import type { AgentConversation } from '../types'
import { useTooltip } from '../hooks/useTooltip'
import { CloseIcon, EditIcon, TrashIcon } from './icons'
import ViewportTooltip from './ViewportTooltip'

function HistoryActionButton({
  tooltip,
  className,
  disabled = false,
  onClick,
  onMouseDown,
  children,
}: {
  tooltip: string
  className: string
  disabled?: boolean
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  const tooltipState = useTooltip()

  return (
    <span className="relative inline-flex" {...tooltipState.handlers}>
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={tooltip}
        onClick={(e) => {
          tooltipState.dismiss()
          onClick?.(e)
        }}
        onMouseDown={onMouseDown}
      >
        {children}
      </button>
      <ViewportTooltip visible={tooltipState.visible} className="whitespace-nowrap">
        {tooltip}
      </ViewportTooltip>
    </span>
  )
}

function getTimeKey(value: number): 'today' | 'yesterday' | 'thisWeek' | 'earlier' {
  const date = new Date(value)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
  const dayOfWeek = now.getDay() || 7
  const startOfWeek = startOfToday - (dayOfWeek - 1) * 24 * 60 * 60 * 1000
  const time = date.getTime()
  if (time >= startOfToday) return 'today'
  if (time >= startOfYesterday) return 'yesterday'
  if (time >= startOfWeek) return 'thisWeek'
  return 'earlier'
}

function formatDetailTime(value: number) {
  const date = new Date(value)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const formatter = new Intl.DateTimeFormat(undefined, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return formatter.format(date).replace(/\//g, '-')
}

function getConversationSearchText(conversation: AgentConversation) {
  return [
    conversation.title,
    ...conversation.messages.map((message) => message.content),
    ...conversation.rounds.map((round) => round.prompt),
  ].join('\n').toLocaleLowerCase()
}

type HistoryModalProps = {
  onClose: () => void
  ignoreOutsideClickRef?: RefObject<HTMLElement | null>
}

export default function HistoryModal({ onClose, ignoreOutsideClickRef }: HistoryModalProps) {
  const { t } = useTranslation()
  const conversations = useStore((s) => s.agentConversations)
  const activeConversationId = useStore((s) => s.activeAgentConversationId)
  const setActiveConversationId = useStore((s) => s.setActiveAgentConversationId)
  const renameConversation = useStore((s) => s.renameAgentConversation)
  const deleteConversation = useStore((s) => s.deleteAgentConversation)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const confirmDialogOpen = useStore((s) => Boolean(s.confirmDialog))
  const setAppMode = useStore((s) => s.setAppMode)
  const tasks = useStore((s) => s.tasks)
  const agentGeneratingTitleIds = useStore((s) => s.agentGeneratingTitleIds)
  const editingId = useStore((s) => s.agentEditingConversationId)
  const setEditingId = useStore((s) => s.setAgentEditingConversationId)

  const [editingTitle, setEditingTitle] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (editingId) {
      const convo = conversations.find((c) => c.id === editingId)
      if (convo) setEditingTitle(convo.title)
    }
  }, [editingId, conversations])

  useEffect(() => {
    return () => {
      setEditingId(null)
    }
  }, [setEditingId])

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return sortedConversations
    return sortedConversations.filter((conversation) => getConversationSearchText(conversation).includes(query))
  }, [searchQuery, sortedConversations])

  const handleSelect = (id: string) => {
    if (editingId) return
    setAppMode('agent')
    setActiveConversationId(id)
    onClose()
  }

  const startRename = (e: React.MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation()
    if (agentGeneratingTitleIds[id]) return
    setEditingId(id)
    setEditingTitle(currentTitle)
  }

  const confirmRename = () => {
    if (editingId && editingTitle.trim() && !agentGeneratingTitleIds[editingId]) {
      renameConversation(editingId, editingTitle.trim())
    }
    setEditingId(null)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingId(null)
    }
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const targetConversation = conversations.find((item) => item.id === id) ?? null
    const roundIds = new Set(targetConversation?.rounds.map((round) => round.id) ?? [])
    const roundTaskIds = targetConversation?.rounds.flatMap((round) => round.outputTaskIds) ?? []
    const relatedTasks = tasks.filter((task) =>
      task.agentConversationId === id || Boolean(task.agentRoundId && roundIds.has(task.agentRoundId)),
    )
    const existingTaskIds = new Set(tasks.map((task) => task.id))
    const relatedTaskIds = Array.from(new Set([...roundTaskIds, ...relatedTasks.map((task) => task.id)]))
      .filter((taskId) => existingTaskIds.has(taskId))
    const relatedTaskIdSet = new Set(relatedTaskIds)
    const generatedImageCount = new Set(
      tasks
        .filter((task) => relatedTaskIdSet.has(task.id))
        .flatMap((task) => task.outputImages || []),
    ).size

    setConfirmDialog({
      title: t('history.deleteConversationTitle'),
      message: t('history.deleteConversationMessage'),
      checkbox: generatedImageCount > 0
        ? {
            label: t('history.deleteConversationCheckbox', { count: generatedImageCount }),
            tone: 'danger',
          }
        : undefined,
      action: async (deleteGeneratedImages = false) => {
        deleteConversation(id)
        if (deleteGeneratedImages && relatedTaskIds.length > 0) await removeMultipleTasks(relatedTaskIds)
        if (conversations.length <= 1) {
          onClose()
        }
      },
    })
  }

  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleInteract = (e: MouseEvent | TouchEvent) => {
      if (confirmDialogOpen) return
      if (ignoreOutsideClickRef?.current?.contains(e.target as Node)) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleInteract, { capture: true })
    document.addEventListener('touchstart', handleInteract, { capture: true })
    return () => {
      document.removeEventListener('mousedown', handleInteract, { capture: true })
      document.removeEventListener('touchstart', handleInteract, { capture: true })
    }
  }, [confirmDialogOpen, ignoreOutsideClickRef, onClose])

  // Group by time
  const groups: Record<string, AgentConversation[]> = {}
  for (const c of filteredConversations) {
    const timeKey = getTimeKey(c.updatedAt)
    if (!groups[timeKey]) groups[timeKey] = []
    groups[timeKey].push(c)
  }

  return (
    <div 
      ref={modalRef}
      className="absolute top-12 left-0 w-80 sm:w-96 max-w-[calc(100vw-2rem)] max-h-[70vh] bg-white dark:bg-[#1c1c1e] rounded-xl shadow-2xl overflow-hidden flex flex-col border border-gray-200 dark:border-white/10 z-50 text-gray-900 dark:text-gray-200 animate-dropdown-down"
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-white/10 shrink-0">
        <input 
          type="text" 
          placeholder={t('history.searchPlaceholder')} 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent border-none outline-none text-sm px-2 text-gray-900 dark:text-white placeholder-gray-400"
        />
        <HistoryActionButton tooltip={t('history.close')} onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-500 dark:text-gray-400 transition-colors">
          <CloseIcon className="w-4 h-4" />
        </HistoryActionButton>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1 overscroll-contain">
        {filteredConversations.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-gray-500">{t('history.noResults')}</div>
        )}

        {Object.entries(groups).map(([label, items]) => (
          <div key={label}>
            <div className="mt-4 mb-1 px-3 text-xs font-medium text-gray-500">{t(`history.${label}` as 'history.today' | 'history.yesterday' | 'history.thisWeek' | 'history.earlier')}</div>
            {items.map(c => (
              <div 
                key={c.id} 
                className="group flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
                onClick={() => handleSelect(c.id)}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <svg className="w-4 h-4 shrink-0 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  {editingId === c.id ? (
                    <input
                      type="text"
                      className="flex-1 bg-white dark:bg-black/20 border border-[#9181bd]/50 dark:border-white/20 rounded px-1.5 py-0.5 text-sm outline-none text-gray-900 dark:text-white focus:border-[#9181bd] dark:focus:border-white/40 shadow-sm min-w-0"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      onBlur={confirmRename}
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm truncate ${c.id === activeConversationId ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-600 dark:text-gray-300'}`}>
                        {c.title}
                      </div>
                      <div className="hidden sm:block mt-0.5 text-[11px] leading-none text-gray-500">
                        {formatDetailTime(c.updatedAt)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">
                  {editingId === c.id ? (
                    <HistoryActionButton
                      tooltip={t('history.confirm')}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); confirmRename() }}
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-green-500 dark:text-green-400 hover:text-green-600 dark:hover:text-green-300 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </HistoryActionButton>
                  ) : (
                    <>
                      <HistoryActionButton
                        tooltip={t('history.rename')}
                        onClick={(e) => startRename(e, c.id, c.title)}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-white disabled:text-gray-300 disabled:hover:text-gray-300 dark:disabled:text-gray-600 dark:disabled:hover:text-gray-600 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
                        disabled={Boolean(agentGeneratingTitleIds[c.id])}
                      >
                        <EditIcon className="w-3.5 h-3.5" />
                      </HistoryActionButton>
                      <HistoryActionButton
                        tooltip={t('history.delete')}
                        onClick={(e) => handleDelete(e, c.id)}
                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </HistoryActionButton>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
