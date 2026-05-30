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
  const id = raw.id || raw.group_id
  const name = raw.name || raw.group_name || raw.title || `Group ${id}`
  if (!id) return null
  return { id: Number(id), name: String(name) }
}

/** Get available groups from the stored OAuth token (synchronous). */
export function getAvailableGroups(): SakrylleGroup[] {
  const token = getStoredToken()
  if (!token) return []
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
  return groups
}

export function getSelectedGroupId(apiMode: 'images' | 'responses'): number | undefined {
  const groups = getAvailableGroups()
  if (!groups.length) return undefined

  const selected = getSelectedGroups()[apiMode]
  if (selected && groups.some((group) => group.id === selected)) return selected

  const fallback = groups[0]?.id
  if (fallback) setSelectedGroup(apiMode, fallback)
  return fallback
}

/** Get available groups from the stored OAuth token */
export function fetchResponsesApiGroups(): Promise<SakrylleGroup[]> {
  return Promise.resolve(getAvailableGroups())
}

// Resolve the access token bound to a specific group, WITHOUT rotating the
// shared/primary token. The OAuth grant mints one access_token per authorized
// group: the primary (token.accessToken, for token.group) plus one per entry
// in additionalTokens[]. Used to list a group's models via /v1/models without
// triggering refreshWithGroupId — so the two model selectors never race.
// Falls back to the primary token when no specific group is requested or the
// requested group has no dedicated token.
export function getGroupAccessToken(groupId?: number): string | undefined {
  const token = getStoredToken()
  if (!token) return undefined
  if (groupId == null) return token.accessToken
  const primaryId = normalizeGroup(token.group)?.id
  if (primaryId === groupId) return token.accessToken
  const match = token.additionalTokens?.find((t) => normalizeGroup(t.group)?.id === groupId)
  return match?.accessToken ?? token.accessToken
}
