import { describe, expect, it, vi } from 'vitest'
import { buildPartialFailure, callWithRetry, isRetryableError, runWithConcurrency } from './openaiCompatibleImageApi'

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
  it('超时 AbortError 可重试', () => {
    expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(true)
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
  const settled = (statuses: Array<'fulfilled' | 'rejected'>, errMsg = 'failed') =>
    statuses.map((status) =>
      status === 'fulfilled'
        ? ({ status: 'fulfilled', value: null } as PromiseFulfilledResult<unknown>)
        : ({ status: 'rejected', reason: new Error(errMsg) } as PromiseRejectedResult),
    )

  it('全成功返回 undefined', () => {
    expect(buildPartialFailure(settled(['fulfilled', 'fulfilled']), 2)).toBeUndefined()
  })
  it('全失败返回 undefined（交给 caller throw）', () => {
    expect(buildPartialFailure(settled(['rejected', 'rejected']), 0)).toBeUndefined()
  })
  it('部分失败返回失败数 + 首个错误信息', () => {
    const result = buildPartialFailure(
      settled(['fulfilled', 'rejected', 'fulfilled', 'rejected'], '上游限速'),
      2,
    )
    expect(result).toEqual({ failedCount: 2, firstErrorMessage: '上游限速' })
  })
})
