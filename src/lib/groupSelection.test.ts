import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the stored OAuth token. groupSelection reads it via getStoredToken.
vi.mock('./sakrylleAuth', () => {
  const state: { token: any } = { token: null }
  return {
    __esModule: true,
    OIDC_ENABLED: false,
    __setToken(value: any) { state.token = value },
    getStoredToken: () => state.token,
  }
})

vi.mock('./sakrylleAccount', () => {
  const state: { me: any } = { me: null }
  return {
    __esModule: true,
    __setMe(value: any) { state.me = value },
    fetchMe: vi.fn(async () => state.me),
  }
})

import { ensureSelectedGroupId, fetchResponsesApiGroups, getAvailableGroups, getGroupAccessToken, getGroupsForApiMode, getSelectedGroupId, getSelectedGroups, resolveSelectedGroupId, setSelectedGroup } from './groupSelection'
import * as sakrylleAuth from './sakrylleAuth'
import * as sakrylleAccount from './sakrylleAccount'

const authMock = sakrylleAuth as typeof sakrylleAuth & { __setToken: (t: any) => void }
const accountMock = sakrylleAccount as typeof sakrylleAccount & { __setMe: (me: any) => void }

function createMockStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
  }
}

// Primary token bound to group 5 (GPT-Image), plus a per-group token for
// group 7 (Responses) — mirrors the multi-group OAuth grant shape.
function seedMultiGroupToken(): void {
  authMock.__setToken({
    accessToken: 'sk_oauth_primary_group5',
    refreshToken: 'rt_test',
    expiresAt: Date.now() + 3_600_000,
    group: { id: 5, name: 'GPT-Image' },
    additionalTokens: [
      { accessToken: 'sk_oauth_group7', expiresAt: Date.now() + 3_600_000, group: { id: 7, name: 'Responses' } },
    ],
  })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMockStorage())
  seedMultiGroupToken()
})
afterEach(() => {
  authMock.__setToken(null)
  accountMock.__setMe(null)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('getAvailableGroups', () => {
  it('lists primary group plus additional-token groups', () => {
    expect(getAvailableGroups()).toEqual([
      { id: 5, name: 'GPT-Image' },
      { id: 7, name: 'Responses' },
    ])
  })

  it('returns empty when no token is stored', () => {
    authMock.__setToken(null)
    expect(getAvailableGroups()).toEqual([])
  })

  it('uses cached names when a later token only has ids or empty names', async () => {
    accountMock.__setMe({
      allowed_groups: [
        { id: 5, name: 'GPT-Image' },
        { id: 11, name: 'GPT-Image-4K' },
      ],
    })
    await fetchResponsesApiGroups()
    authMock.__setToken({
      accessToken: 'sk_oauth_group11',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 11, name: '' },
    })

    expect(getAvailableGroups()).toEqual([
      { id: 11, name: 'GPT-Image-4K' },
    ])
  })
})

describe('fetchResponsesApiGroups', () => {
  it('prefers /v1/me allowed_groups names over generic token group names', async () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_group11',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 11, name: '' },
    })
    accountMock.__setMe({
      allowed_groups: [
        { id: 5, name: 'GPT-Image' },
        { id: 11, name: 'GPT-Image-4K' },
      ],
    })

    await expect(fetchResponsesApiGroups()).resolves.toEqual([
      { id: 5, name: 'GPT-Image' },
      { id: 11, name: 'GPT-Image-4K' },
    ])
  })

  it('keeps capability metadata from /v1/me allowed_groups', async () => {
    accountMock.__setMe({
      allowed_groups: [
        { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
        { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
      ],
    })

    await expect(fetchResponsesApiGroups()).resolves.toEqual([
      { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
      { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
      { id: 7, name: 'Responses' },
    ])
  })
})

describe('getGroupsForApiMode', () => {
  it('infers Sakrylle Images and Responses groups from names when capabilities are absent', () => {
    const groups = [
      { id: 5, name: 'GPT-Image' },
      { id: 9, name: 'GPT-Plus' },
    ]

    expect(getGroupsForApiMode('images', groups)).toEqual([{ id: 5, name: 'GPT-Image' }])
    expect(getGroupsForApiMode('responses', groups)).toEqual([{ id: 9, name: 'GPT-Plus' }])
  })

  it('shows only GPT chat groups for Responses, hiding non-GPT groups', () => {
    const groups = [
      { id: 5, name: 'GPT-Image' },
      { id: 9, name: 'GPT-Pro' },
      { id: 12, name: 'Claude-Max' },
    ]

    expect(getGroupsForApiMode('responses', groups)).toEqual([
      { id: 9, name: 'GPT-Pro' },
    ])
  })

  it('hides non-GPT groups from Responses even when they declare responses capability', () => {
    const groups = [
      { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
      { id: 12, name: 'Claude-Max', capabilities: ['messages:create', 'responses:create'] },
    ]

    expect(getGroupsForApiMode('responses', groups)).toEqual([
      { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
    ])
  })

  it('keeps a GPT chat group in Responses even when gateway flags it image-capable', () => {
    // Regression: /v1/me marks GPT-Pro with allow_image_generation:true, which
    // normalizeGroup turns into an images:create capability. That must NOT
    // reclassify the GPT chat group as image-only and hide it from Responses.
    const groups = [
      { id: 14, name: 'GPT-Pro', capabilities: ['images:create'] },
      { id: 3, name: 'GPT-Pro-Special', capabilities: ['images:create'] },
    ]

    expect(getGroupsForApiMode('responses', groups)).toEqual([
      { id: 14, name: 'GPT-Pro', capabilities: ['images:create'] },
      { id: 3, name: 'GPT-Pro-Special', capabilities: ['images:create'] },
    ])
  })

  it('excludes image-named GPT groups from Responses despite the GPT prefix', () => {
    const groups = [
      { id: 11, name: 'GPT-Image-2-4K' },
      { id: 21, name: 'GPT-Image-2-Async' },
      { id: 14, name: 'GPT-Pro' },
    ]

    expect(getGroupsForApiMode('responses', groups)).toEqual([
      { id: 14, name: 'GPT-Pro' },
    ])
  })

  it('migrates stale stored selections to a mode-appropriate group', () => {
    const groups = [
      { id: 5, name: 'GPT-Image' },
      { id: 9, name: 'GPT-Plus' },
    ]

    setSelectedGroup('images', 9)
    setSelectedGroup('responses', 5)

    expect(resolveSelectedGroupId('images', groups)).toBe(5)
    expect(resolveSelectedGroupId('responses', groups)).toBe(9)
  })

  it('does not use image-only groups as a Responses fallback', () => {
    const groups = [
      { id: 11, name: 'GPT-Image-2-4K', capabilities: ['images:create', 'responses:create'] },
    ]

    expect(getGroupsForApiMode('responses', groups)).toEqual([])
    expect(resolveSelectedGroupId('responses', groups)).toBeUndefined()
  })

  it('does not use responses-only groups as an Images fallback', () => {
    const groups = [
      { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
    ]

    expect(getGroupsForApiMode('images', groups)).toEqual([])
    expect(resolveSelectedGroupId('images', groups)).toBeUndefined()
  })

  it('does not use generic fallback group names as Images candidates', () => {
    const groups = [
      { id: 11, name: 'Group 11' },
    ]

    expect(getGroupsForApiMode('images', groups)).toEqual([])
    expect(resolveSelectedGroupId('images', groups)).toBeUndefined()
  })

  it('shows only GPT image-named groups for Images, ignoring non-GPT image-capable groups', () => {
    const groups = [
      { id: 5, name: 'GPT-Image', capabilities: ['responses:create'] },
      { id: 11, name: 'Flux-Pro', capabilities: ['images:create'] },
    ]

    expect(getGroupsForApiMode('images', groups)).toEqual([
      { id: 5, name: 'GPT-Image', capabilities: ['responses:create'] },
    ])
    expect(resolveSelectedGroupId('images', groups)).toBe(5)
  })

  it('excludes GPT chat groups from Images even when gateway flags them image-capable', () => {
    // GPT-Pro / Grok have allow_image_generation:true (→ images:create cap) but
    // are chat groups, not image-gen groups. They must stay out of the Images
    // selector — only image-NAMED GPT groups belong there.
    const groups = [
      { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
      { id: 11, name: 'GPT-Image-2-4K', capabilities: ['images:create'] },
      { id: 21, name: 'GPT-Image-2-Async', capabilities: ['images:create'] },
      { id: 14, name: 'GPT-Pro', capabilities: ['images:create'] },
      { id: 3, name: 'GPT-Pro-Special', capabilities: ['images:create'] },
      { id: 22, name: 'Grok-API', capabilities: ['images:create'] },
      { id: 23, name: 'Agnes-API', capabilities: ['images:create'] },
    ]

    expect(getGroupsForApiMode('images', groups)).toEqual([
      { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
      { id: 11, name: 'GPT-Image-2-4K', capabilities: ['images:create'] },
      { id: 21, name: 'GPT-Image-2-Async', capabilities: ['images:create'] },
    ])
  })
})

describe('getGroupAccessToken', () => {
  it('returns each group its OWN access token (no rotation)', () => {
    expect(getGroupAccessToken(5)).toBe('sk_oauth_primary_group5')
    expect(getGroupAccessToken(7)).toBe('sk_oauth_group7')
  })

  it('falls back to the primary token for unknown groups', () => {
    expect(getGroupAccessToken(999)).toBe('sk_oauth_primary_group5')
  })

  it('can require an exact group token', () => {
    expect(getGroupAccessToken(999, { allowFallback: false })).toBeUndefined()
  })

  it('returns the primary token when no group is requested', () => {
    expect(getGroupAccessToken()).toBe('sk_oauth_primary_group5')
  })

  it('returns undefined when no token is stored', () => {
    authMock.__setToken(null)
    expect(getGroupAccessToken(5)).toBeUndefined()
  })
})

describe('getSelectedGroupId', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps the stored group when it is still available', () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_primary_group5',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 5, name: 'GPT-Image' },
      additionalTokens: [
        { accessToken: 'sk_oauth_group9', expiresAt: Date.now() + 3_600_000, group: { id: 9, name: 'GPT-Image-4K' } },
      ],
    })
    setSelectedGroup('images', 9)
    expect(getSelectedGroupId('images')).toBe(9)
  })

  it('falls back to the primary group when the stored group is stale', () => {
    setSelectedGroup('images', 999)
    expect(getSelectedGroupId('images')).toBe(5)
  })
})

describe('ensureSelectedGroupId', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('chooses a mode-capable default from /v1/me before model fetching', async () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_primary_group5',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 5, name: 'GPT-Image' },
      additionalTokens: [
        { accessToken: 'sk_oauth_group9', expiresAt: Date.now() + 3_600_000, group: { id: 9, name: 'GPT-Pro' } },
      ],
    })
    accountMock.__setMe({
      allowed_groups: [
        { id: 5, name: 'GPT-Image', capabilities: ['images:create'] },
        { id: 9, name: 'GPT-Pro', capabilities: ['responses:create'] },
      ],
    })

    await expect(ensureSelectedGroupId('responses')).resolves.toBe(9)
    expect(getSelectedGroups().responses).toBe(9)
  })

  it('repairs a stale generic Responses selection using /v1/me groups', async () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_group11',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
      group: { id: 11, name: '' },
    })
    setSelectedGroup('responses', 11)
    accountMock.__setMe({
      allowed_groups: [
        { id: 11, name: 'GPT-Image-2-4K', capabilities: ['images:create'] },
        { id: 4, name: 'GPT-Plus', capabilities: ['responses:create'] },
      ],
    })

    await expect(ensureSelectedGroupId('responses')).resolves.toBe(4)
    expect(getSelectedGroups().responses).toBe(4)
  })

  it('uses /v1/me current_group when allowed_groups is not returned', async () => {
    authMock.__setToken({
      accessToken: 'sk_oauth_group4',
      refreshToken: 'rt_test',
      expiresAt: Date.now() + 3_600_000,
    })
    accountMock.__setMe({
      current_group_id: 4,
      current_group: 'GPT-Plus',
      effective_capabilities: ['responses:create'],
    })

    await expect(ensureSelectedGroupId('responses')).resolves.toBe(4)
    expect(getSelectedGroups().responses).toBe(4)
  })
})
