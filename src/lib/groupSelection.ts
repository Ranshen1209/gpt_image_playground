import { fetchMe, type SakrylleGroup } from './sakrylleAccount'
import { getStoredToken } from './sakrylleAuth'

const STORAGE_KEY = 'sakrylle-image-playground.selected-groups'
const GROUP_NAMES_STORAGE_KEY = 'sakrylle-image-playground.group-names'

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

function readCachedGroupNames(): Record<string, string> {
  try {
    const stored = localStorage.getItem(GROUP_NAMES_STORAGE_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const names: Record<string, string> = {}
    for (const [id, name] of Object.entries(parsed)) {
      if (typeof name === 'string' && name.trim()) names[id] = name.trim()
    }
    return names
  } catch {
    return {}
  }
}

function isFallbackGroupName(id: number, name: string): boolean {
  return name.trim() === `Group ${id}`
}

function cacheGroupNames(groups: SakrylleGroup[]): void {
  try {
    const current = readCachedGroupNames()
    let changed = false
    for (const group of groups) {
      const name = group.name.trim()
      if (!name || isFallbackGroupName(group.id, name)) continue
      if (current[String(group.id)] === name) continue
      current[String(group.id)] = name
      changed = true
    }
    if (changed) localStorage.setItem(GROUP_NAMES_STORAGE_KEY, JSON.stringify(current))
  } catch {
    // ignore storage errors
  }
}

function normalizeGroup(raw: any): SakrylleGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id || raw.group_id
  if (!id) return null
  const normalizedId = Number(id)
  if (!Number.isFinite(normalizedId)) return null
  const cachedName = readCachedGroupNames()[String(normalizedId)]
  const rawName = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : typeof raw.group_name === 'string' && raw.group_name.trim()
      ? raw.group_name.trim()
      : typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : ''
  return { id: normalizedId, name: rawName || cachedName || `Group ${normalizedId}` }
}

function mergeGroups(primary: SakrylleGroup[], secondary: SakrylleGroup[]): SakrylleGroup[] {
  const merged = new Map<number, SakrylleGroup>()
  for (const group of [...primary, ...secondary]) {
    const existing = merged.get(group.id)
    if (!existing) {
      merged.set(group.id, group)
      continue
    }
    if (isFallbackGroupName(group.id, existing.name) && !isFallbackGroupName(group.id, group.name)) {
      merged.set(group.id, group)
    }
  }
  return Array.from(merged.values())
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
  cacheGroupNames(groups)
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
export async function fetchResponsesApiGroups(): Promise<SakrylleGroup[]> {
  const tokenGroups = getAvailableGroups()
  try {
    const me = await fetchMe()
    const accountGroups = Array.isArray(me?.allowed_groups)
      ? me.allowed_groups.map((group) => normalizeGroup(group)).filter((group): group is SakrylleGroup => Boolean(group))
      : []
    const groups = accountGroups.length ? mergeGroups(accountGroups, tokenGroups) : tokenGroups
    cacheGroupNames(groups)
    return groups
  } catch {
    return tokenGroups
  }
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
