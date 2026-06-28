import type { ApiProfile, TaskParams } from '../types'
import { DEFAULT_IMAGES_MODEL } from './apiProfiles'
import { getAvailableGroups, getSelectedGroups, getGroupsForApiMode, type SelectedGroups } from './groupSelection'
import { calculateImageSizeByBudget, IMAGE_SIZE_TIER_PIXEL_BUDGET, normalizeImageSize } from './size'

const SIZE_PATTERN = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/
const SAKRYLLE_GPT_IMAGE_GROUP_ID = 5

function isSakrylleApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.sakrylle.com'
  } catch {
    return baseUrl.toLowerCase().includes('api.sakrylle.com')
  }
}

function parseSize(size: string): { width: number; height: number } | null {
  const match = size.match(SIZE_PATTERN)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function getSelectedGroup(apiMode: keyof SelectedGroups) {
  const groups = getAvailableGroups()
  if (!groups.length) return undefined

  const selected = getSelectedGroups()[apiMode]
  const modeGroups = getGroupsForApiMode(apiMode, groups)
  if (selected) {
    return modeGroups.find((group) => group.id === selected) ?? groups.find((group) => group.id === selected)
  }
  return modeGroups[0] ?? groups[0]
}

function isOneKGptImageGroup(group: { id: number; name: string } | undefined): boolean {
  if (!group) return true
  if (group.id === SAKRYLLE_GPT_IMAGE_GROUP_ID) return true

  const normalizedName = group.name.trim().toLowerCase()
  if (!normalizedName.includes('gpt-image')) return false
  return !normalizedName.includes('2k') && !normalizedName.includes('4k')
}

function shouldCapToOneK(profile: ApiProfile): boolean {
  if (!isSakrylleApiBaseUrl(profile.baseUrl)) return false
  if (profile.model.trim() !== DEFAULT_IMAGES_MODEL) return false
  return isOneKGptImageGroup(getSelectedGroup(profile.apiMode))
}

export function capImageSizeToOneK(size: string): string {
  const normalized = normalizeImageSize(size)
  const dimensions = parseSize(normalized)
  if (!dimensions) return size

  if (dimensions.width * dimensions.height <= IMAGE_SIZE_TIER_PIXEL_BUDGET['1K']) {
    return normalized
  }

  return calculateImageSizeByBudget('1K', `${dimensions.width}:${dimensions.height}`) ?? normalized
}

export function getSakrylleImageRequestParams(params: TaskParams, profile: ApiProfile): TaskParams {
  if (!shouldCapToOneK(profile)) return params

  const cappedSize = capImageSizeToOneK(params.size)
  if (cappedSize === params.size) return params
  return { ...params, size: cappedSize }
}
