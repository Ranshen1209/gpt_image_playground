import { describe, expect, it } from 'vitest'
import zh from './zh.json'
import en from './en.json'

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[]

function flattenKeys(obj: JsonValue, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : []
  }
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k
    keys.push(...flattenKeys(v, next))
  }
  return keys.sort()
}

describe('locale parity', () => {
  it('zh and en share identical key set', () => {
    const zhKeys = flattenKeys(zh as JsonValue)
    const enKeys = flattenKeys(en as JsonValue)

    const onlyInZh = zhKeys.filter((k) => !enKeys.includes(k))
    const onlyInEn = enKeys.filter((k) => !zhKeys.includes(k))

    expect({ onlyInZh, onlyInEn }).toEqual({ onlyInZh: [], onlyInEn: [] })
  })

  it('no empty string values in either locale', () => {
    // Split-sentence keys (ending in Before/After/Prefix/Suffix) intentionally
    // allow empty fragments, e.g. when one language doesn't need a trailing word
    // after an inline <code> snippet. See SettingsModal apiKeyHintBefore/After.
    const splitSentenceSuffix = /(Before|After|Prefix|Suffix)$/
    const findEmpties = (obj: JsonValue, prefix = ''): string[] => {
      if (typeof obj === 'string') {
        if (obj.length !== 0) return []
        const lastSegment = prefix.split('.').pop() ?? ''
        if (splitSentenceSuffix.test(lastSegment)) return []
        return [prefix]
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
      const out: string[] = []
      for (const [k, v] of Object.entries(obj)) {
        const next = prefix ? `${prefix}.${k}` : k
        out.push(...findEmpties(v, next))
      }
      return out
    }
    expect(findEmpties(zh as JsonValue)).toEqual([])
    expect(findEmpties(en as JsonValue)).toEqual([])
  })

  it('interpolation placeholders match between zh and en', () => {
    const placeholderRe = /\{\{(\w+)\}\}/g
    const collect = (obj: JsonValue, prefix = ''): Array<[string, string[]]> => {
      if (typeof obj === 'string') {
        const found = Array.from(obj.matchAll(placeholderRe), (m) => m[1]).sort()
        return found.length ? [[prefix, found]] : []
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
      const out: Array<[string, string[]]> = []
      for (const [k, v] of Object.entries(obj)) {
        const next = prefix ? `${prefix}.${k}` : k
        out.push(...collect(v, next))
      }
      return out
    }
    const zhPh = new Map(collect(zh as JsonValue))
    const enPh = new Map(collect(en as JsonValue))

    const mismatches: Array<{ key: string; zh: string[]; en: string[] }> = []
    for (const [key, zhSet] of zhPh) {
      const enSet = enPh.get(key) ?? []
      if (zhSet.join(',') !== enSet.join(',')) mismatches.push({ key, zh: zhSet, en: enSet })
    }
    for (const [key, enSet] of enPh) {
      if (!zhPh.has(key) && enSet.length) mismatches.push({ key, zh: [], en: enSet })
    }

    expect(mismatches).toEqual([])
  })
})
