/**
 * Token-bucket rate limiter. Time is injected so refill behavior is exact.
 * Config (tests/setup.ts leaves defaults): perMinute=120, burst=240.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { _reset, take } from '../src/ratelimit.ts'

describe('rate limiter', () => {
  beforeEach(() => _reset())

  test('allows up to the burst capacity, then 429s', () => {
    const t = 1_000_000
    for (let i = 0; i < 240; i++) {
      expect(take('alice', t).ok).toBe(true)
    }
    const blocked = take('alice', t)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  test('refills over time (2 tokens/sec at 120/min)', () => {
    const t = 2_000_000
    for (let i = 0; i < 240; i++) take('bob', t)
    expect(take('bob', t).ok).toBe(false)
    // One second later → ~2 tokens refilled.
    expect(take('bob', t + 1000).ok).toBe(true)
    expect(take('bob', t + 1000).ok).toBe(true)
    expect(take('bob', t + 1000).ok).toBe(false)
  })

  test('buckets are independent per owner', () => {
    const t = 3_000_000
    for (let i = 0; i < 240; i++) take('carol', t)
    expect(take('carol', t).ok).toBe(false)
    expect(take('dave', t).ok).toBe(true)
  })
})
