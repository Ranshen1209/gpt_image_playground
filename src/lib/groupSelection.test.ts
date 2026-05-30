import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the stored OAuth token. groupSelection reads it via getStoredToken.
vi.mock('./sakrylleAuth', () => {
  const state: { token: any } = { token: null }
  return {
    __esModule: true,
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
})

describe('getGroupAccessToken', () => {
  it('returns each group its OWN access token (no rotation)', () => {
    expect(getGroupAccessToken(5)).toBe('sk_oauth_primary_group5')
    expect(getGroupAccessToken(7)).toBe('sk_oauth_group7')
  })

  it('falls back to the primary token for unknown groups', () => {
    expect(getGroupAccessToken(999)).toBe('sk_oauth_primary_group5')
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
})
