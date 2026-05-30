import type { SakrylleGroup } from './sakrylleAccount'
import { getStoredToken } from './sakrylleAuth'

const STORAGE_KEY = 'sakrylle-image-playground.selected-groups'

export interface SelectedGroups {
  responses?: number
  images?: number
}

export function getSelectedGroups(): SelectedGroups {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return {}
    return JSON.parse(stored) as SelectedGroups
  } catch {
    return {}
  }
}

export function setSelectedGroup(apiMode: 'images' | 'responses', groupId: number): void {
  const current = getSelectedGroups()
  if (apiMode === 'responses') current.responses = groupId
  if (apiMode === 'images') current.images = groupId
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // ignore storage errors
  }
}

export function clearSelectedGroups(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

function normalizeGroup(raw: any): SakrylleGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id ?? raw.group_id
  const name = raw.name ?? raw.group_name ?? raw.title ?? `Group ${id}`
  if (!id) return null
  return { id: Number(id), name: String(name) }
}

/** Get available groups from the stored OAuth token */
export function fetchResponsesApiGroups(): Promise<SakrylleGroup[]> {
  const token = getStoredToken()
  if (!token) return Promise.resolve([])
  const groups: SakrylleGroup[] = []
  const primary = normalizeGroup(token.group)
  if (primary) groups.push(primary)
  if (token.additionalTokens) {
    for (const t of token.additionalTokens) {
      const g = normalizeGroup(t.group)
      if (g && !groups.some(existing => existing.id === g.id)) {
        groups.push(g)
      }
    }
  }
  return Promise.resolve(groups)
}
