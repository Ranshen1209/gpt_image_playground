import type { SakrylleAuthToken } from './sakrylleAuth'

const STORAGE_KEY = 'sakrylle-image-playground.selected-groups'

export interface SelectedGroups {
  /** Selected group ID for Images API */
  images?: number
  /** Selected group ID for Responses API */
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
  current[apiMode] = groupId
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

/** Get all available groups for a given apiMode from the OAuth token */
export function getAvailableGroups(
  token: SakrylleAuthToken | null,
  apiMode: 'images' | 'responses'
): Array<{ groupId: number; groupName: string; accessToken: string; scope: string }> {
  if (!token) return []

  const allTokens = [
    {
      accessToken: token.accessToken,
      scope: token.scope ?? '',
      group: token.group,
    },
    ...(token.additionalTokens ?? []),
  ]

  const scopeFilter =
    apiMode === 'images'
      ? (scope: string) => scope.includes('images:create') || scope.includes('image_generation')
      : (scope: string) => scope.includes('responses:create')

  return allTokens
    .filter((t) => t.group && scopeFilter(t.scope ?? ''))
    .map((t) => ({
      groupId: t.group!.id,
      groupName: t.group!.name,
      accessToken: t.accessToken,
      scope: t.scope ?? '',
    }))
}
