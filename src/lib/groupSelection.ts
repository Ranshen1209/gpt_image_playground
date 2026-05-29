import type { SakrylleGroup } from './sakrylleAccount'

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

/** Fetch allowed groups from /v1/me that support Responses API */
export async function fetchResponsesApiGroups(): Promise<SakrylleGroup[]> {
  const { fetchMe } = await import('./sakrylleAccount')
  const me = await fetchMe()
  if (!me?.allowed_groups?.length) return []
  return me.allowed_groups.filter((g) =>
    g.capabilities?.includes('responses:create') ?? true
  )
}
