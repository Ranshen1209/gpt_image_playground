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

import { getAvailableGroups, getGroupAccessToken } from './groupSelection'
import * as sakrylleAuth from './sakrylleAuth'

const authMock = sakrylleAuth as typeof sakrylleAuth & { __setToken: (t: any) => void }

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

beforeEach(() => seedMultiGroupToken())
afterEach(() => { authMock.__setToken(null); vi.clearAllMocks() })

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
