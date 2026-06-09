import { describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { buildPartialFailure, callWithRetry, isRetryableError, runImageRequestsWithRefill, runWithConcurrency, shouldUseChatImagePath } from './openaiCompatibleImageApi'

const makeResult = (img: string) => ({ images: [img] })
const retryable = (status: number) => Object.assign(new Error(`http ${status}`), { httpStatus: status })

describe('runWithConcurrency', () => {
  it('保持结果顺序', async () => {
    const factories = [10, 5, 1, 8].map((ms, i) => () =>
      new Promise<number>((resolve) => setTimeout(() => resolve(i), ms)),
    )
    const results = await runWithConcurrency(factories, 2)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([0, 1, 2, 3])
  })

  it('同时在飞数不超过 limit', async () => {
    let inFlight = 0
    let peak = 0
    const factories = Array.from({ length: 6 }).map(() => () =>
      new Promise<void>((resolve) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight--
          resolve()
        }, 5)
      }),
    )
    await runWithConcurrency(factories, 3)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('单个失败不影响其余，返回 rejected 占位', async () => {
    const factories = [
      () => Promise.resolve('a'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('c'),
    ]
    const results = await runWithConcurrency(factories, 3)
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'a' })
    expect(results[1].status).toBe('rejected')
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 'c' })
  })
})

describe('isRetryableError', () => {
  it('用户取消 AbortError 不可重试', () => {
    expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(false)
  })
  it('网络错误 TypeError 可重试', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
  })
  it('429 / 5xx 可重试', () => {
    const e429 = Object.assign(new Error('rate limit'), { httpStatus: 429 })
    const e500 = Object.assign(new Error('server'), { httpStatus: 500 })
    const e503 = Object.assign(new Error('unavailable'), { httpStatus: 503 })
    expect(isRetryableError(e429)).toBe(true)
    expect(isRetryableError(e500)).toBe(true)
    expect(isRetryableError(e503)).toBe(true)
  })
  it('4xx（除 429）不可重试', () => {
    const e400 = Object.assign(new Error('bad request'), { httpStatus: 400 })
    const e403 = Object.assign(new Error('moderation'), { httpStatus: 403 })
    expect(isRetryableError(e400)).toBe(false)
    expect(isRetryableError(e403)).toBe(false)
  })
  it('无 status 的普通错误不可重试', () => {
    expect(isRetryableError(new Error('whatever'))).toBe(false)
  })
})

describe('isRetryableError abort 三拆分', () => {
  it('idle timeout is retryable', () => {
    const err = new Error('idle')
    err.name = 'IdleTimeout'
    expect(isRetryableError(err)).toBe(true)
  })
  it('overall timeout is NOT retryable', () => {
    const err = new Error('overall')
    err.name = 'OverallTimeout'
    expect(isRetryableError(err)).toBe(false)
  })
  it('user abort (AbortError) is NOT retryable', () => {
    const err = new DOMException('stopped', 'AbortError')
    expect(isRetryableError(err)).toBe(false)
  })
  it('network TypeError stays retryable', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true)
  })
  it('429 / 5xx stay retryable', () => {
    const e429 = Object.assign(new Error('rate'), { httpStatus: 429 })
    const e503 = Object.assign(new Error('busy'), { httpStatus: 503 })
    expect(isRetryableError(e429)).toBe(true)
    expect(isRetryableError(e503)).toBe(true)
  })
})

describe('callWithRetry', () => {
  it('可重试错误重试 1 次后成功', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const fn = vi.fn(async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('rate limit'), { httpStatus: 429 })
        return 'ok'
      })
      const promise = callWithRetry(fn)
      await vi.runAllTimersAsync()
      await expect(promise).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('不可重试错误立即抛，不重试', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('moderation'), { httpStatus: 403 })
    })
    await expect(callWithRetry(fn)).rejects.toThrow('moderation')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重试后仍失败则抛最后的错误', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn(async () => {
        throw Object.assign(new Error('still down'), { httpStatus: 500 })
      })
      const promise = callWithRetry(fn)
      const assertion = expect(promise).rejects.toThrow('still down')
      await vi.runAllTimersAsync()
      await assertion
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildPartialFailure', () => {
  it('无缺口返回 undefined', () => {
    expect(buildPartialFailure(0, undefined)).toBeUndefined()
  })
  it('有缺口返回失败数 + 首个错误信息', () => {
    expect(buildPartialFailure(2, new Error('上游限速'))).toEqual({ failedCount: 2, firstErrorMessage: '上游限速' })
  })
  it('firstError 非 Error 时字符串化', () => {
    expect(buildPartialFailure(1, '429')).toEqual({ failedCount: 1, firstErrorMessage: '429' })
  })
})

describe('runImageRequestsWithRefill', () => {
  it('全成功一轮凑满，无补发', async () => {
    let calls = 0
    const { resultsBySlot, failedCount } = await runImageRequestsWithRefill(4, (slot) => {
      calls++
      return Promise.resolve(makeResult(`img-${slot}`))
    })
    expect(calls).toBe(4)
    expect(failedCount).toBe(0)
    expect(resultsBySlot.map((r) => r?.images[0])).toEqual(['img-0', 'img-1', 'img-2', 'img-3'])
  })

  it('可重试失败补发直到凑满，复用失败 slot', async () => {
    // slot 1、3 第一次 429，补发时成功
    const failedOnce = new Set<number>()
    let calls = 0
    const { resultsBySlot, failedCount } = await runImageRequestsWithRefill(4, (slot) => {
      calls++
      if ((slot === 1 || slot === 3) && !failedOnce.has(slot)) {
        failedOnce.add(slot)
        return Promise.reject(retryable(429))
      }
      return Promise.resolve(makeResult(`img-${slot}`))
    })
    expect(failedCount).toBe(0)
    expect(calls).toBe(6) // 4 首轮 + 2 补发
    expect(resultsBySlot.every((r) => r)).toBe(true)
  })

  it('补发预算耗尽仍不足则返回部分（failedCount>0）', async () => {
    let calls = 0
    const { resultsBySlot, failedCount, firstError } = await runImageRequestsWithRefill(4, (slot) => {
      calls++
      if (slot === 2) return Promise.reject(retryable(429)) // slot 2 永远失败
      return Promise.resolve(makeResult(`img-${slot}`))
    })
    // budget factor=1 → 总尝试上限 2N=8：首轮4 + 补发slot2 共 4 次（每轮只补 slot2）直到耗尽
    expect(calls).toBe(8)
    expect(failedCount).toBe(1)
    expect(resultsBySlot[2]).toBeUndefined()
    expect((firstError as { httpStatus?: number }).httpStatus).toBe(429)
  })

  it('本轮零成功且全不可重试 → 立即停止不补发', async () => {
    let calls = 0
    const { failedCount } = await runImageRequestsWithRefill(3, () => {
      calls++
      return Promise.reject(Object.assign(new Error('moderation'), { httpStatus: 403 }))
    })
    expect(calls).toBe(3) // 只首轮，不补发
    expect(failedCount).toBe(3)
  })
})

describe('shouldUseChatImagePath', () => {
  it('true for Sakrylle baseUrl with flag on', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.sakrylle.com/v1', streamChatCompletionsImage: true })
    expect(shouldUseChatImagePath(profile)).toBe(true)
  })
  it('false when flag off', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.sakrylle.com/v1', streamChatCompletionsImage: false })
    expect(shouldUseChatImagePath(profile)).toBe(false)
  })
  it('false for non-Sakrylle baseUrl even with flag on', () => {
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.openai.com/v1', streamChatCompletionsImage: true })
    expect(shouldUseChatImagePath(profile)).toBe(false)
  })
})

describe('runImageRequestsWithRefill 503 账号池早停', () => {
  it('does NOT burn refill budget when all fail with "No available compatible accounts"', async () => {
    let calls = 0
    const runSingle = async () => {
      calls++
      const err = Object.assign(new Error('No available compatible accounts'), { httpStatus: 503 })
      throw err
    }
    const result = await runImageRequestsWithRefill(3, runSingle)
    expect(calls).toBe(3)
    expect(result.failedCount).toBe(3)
  })
})

