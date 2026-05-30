import type { SakrylleGroup } from './sakrylleAccount'
import { getStoredToken } from './sakrylleAuth'

const STORAGE_KEY = 'sakrylle-image-playground.selected-groups'

export interface SelectedGroups {
  responses?: number
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

/** Get available groups from the stored OAuth token */
export async function fetchResponsesApiGroups(): Promise<SakrylleGroup[]> {
  const token = getStoredToken()
  if (!token) return []
  const groups: SakrylleGroup[] = []
  if (token.group) groups.push(token.group)
  if (token.additionalTokens) {
    for (const t of token.additionalTokens) {
      if (t.group && !groups.some(g => g.id === t.group!.id)) {
        groups.push(t.group)
      }
    }
  }
  return groups
}
