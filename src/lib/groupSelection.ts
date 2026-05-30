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
  const rawCapabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
    : Array.isArray(raw.effective_capabilities)
      ? raw.effective_capabilities
      : []
  const capabilities = rawCapabilities
    .filter((capability: unknown): capability is string => typeof capability === 'string' && Boolean(capability.trim()))
    .map((capability: string) => capability.trim())
  if ((raw.allow_image_generation === true || raw.allowImageGeneration === true) && !capabilities.includes('images:create')) {
    capabilities.push('images:create')
  }
  return {
    id: normalizedId,
    name: rawName || cachedName || `Group ${normalizedId}`,
    ...(capabilities.length ? { capabilities } : {}),
  }
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

function groupSupportsModeByCapability(group: SakrylleGroup, apiMode: 'images' | 'responses'): boolean {
  const capabilities = group.capabilities ?? []
  if (!capabilities.length) return false
  if (apiMode === 'images') {
    return capabilities.some((capability) =>
      capability === 'images:create' ||
      capability === 'image_generation' ||
      capability.includes('image'),
    )
  }
  return capabilities.some((capability) =>
    capability === 'responses:create' ||
    capability === 'chat.completions:create' ||
    capability.includes('responses') ||
    capability.includes('chat'),
  )
}

function normalizedGroupName(group: SakrylleGroup): string {
  return group.name.trim().toLowerCase()
}

function groupNameLooksImage(group: SakrylleGroup): boolean {
  const name = normalizedGroupName(group)
  return name.includes('image') || name.includes('图像') || name.includes('绘图') || name.includes('画图')
}

function groupNameLooksResponses(group: SakrylleGroup): boolean {
  const name = normalizedGroupName(group)
  return name.includes('responses') ||
    name.includes('response') ||
    name.includes('plus') ||
    name.includes('pro') ||
    name.includes('chat') ||
    name.includes('codex')
}

export function getGroupsForApiMode(apiMode: 'images' | 'responses', groups: SakrylleGroup[]): SakrylleGroup[] {
  if (!groups.length) return []

  if (apiMode === 'images') {
    const namedImageGroups = groups.filter(groupNameLooksImage)
    if (namedImageGroups.length) return namedImageGroups

    const capabilityGroups = groups.filter((group) => groupSupportsModeByCapability(group, apiMode))
    return capabilityGroups.length ? capabilityGroups : groups
  }

  const namedResponsesGroups = groups.filter(groupNameLooksResponses)
  if (namedResponsesGroups.length) return namedResponsesGroups

  const capabilityGroups = groups.filter((group) => groupSupportsModeByCapability(group, apiMode))
  const nonImageCapabilityGroups = capabilityGroups.filter((group) => !groupNameLooksImage(group))
  if (nonImageCapabilityGroups.length) return nonImageCapabilityGroups
  if (capabilityGroups.length) return capabilityGroups

  const nonImageGroups = groups.filter((group) => !groupNameLooksImage(group))
  return nonImageGroups.length ? nonImageGroups : groups
}

export function resolveSelectedGroupId(apiMode: 'images' | 'responses', groups: SakrylleGroup[]): number | undefined {
  const selected = getSelectedGroups()[apiMode]
  const candidates = getGroupsForApiMode(apiMode, groups)
  if (selected && candidates.some((group) => group.id === selected)) return selected
  return candidates[0]?.id ?? groups[0]?.id
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

  const fallback = resolveSelectedGroupId(apiMode, groups)
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

export async function ensureSelectedGroupId(apiMode: 'images' | 'responses'): Promise<number | undefined> {
  const tokenGroups = getAvailableGroups()
  const selected = getSelectedGroups()[apiMode]
  const tokenCandidates = getGroupsForApiMode(apiMode, tokenGroups)
  if (selected && tokenCandidates.some((group) => group.id === selected)) return selected

  const groups = await fetchResponsesApiGroups()
  const resolvedGroupId = resolveSelectedGroupId(apiMode, groups.length ? groups : tokenGroups)
  if (resolvedGroupId) setSelectedGroup(apiMode, resolvedGroupId)
  return resolvedGroupId
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
